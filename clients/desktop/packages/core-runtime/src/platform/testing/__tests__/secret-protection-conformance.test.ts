import type {
  PlatformKeySlotCallOptions,
  PlatformKeySlotDeleteResult,
  PlatformKeySlotReadResult,
  PlatformKeySlotWriteResult,
  PlatformSecretProtectionServices,
  PlatformSecretProtectionState,
} from '../../secret-protection';
import {
  createFakeSecretProtection,
  KEY_SLOT_MAX_BYTES,
  KEY_SLOT_NAME_PATTERN,
  runSecretProtectionConformance,
  SecretProtectionConformanceFailure,
  type FakeSecretProtection,
  type SecretProtectionConformanceSubject,
} from '../index';

function fakeSubject(
  wrap: (
    port: PlatformSecretProtectionServices,
    fake: FakeSecretProtection,
  ) => PlatformSecretProtectionServices = (port) => port,
): () => SecretProtectionConformanceSubject {
  return () => {
    const fake = createFakeSecretProtection({ backend: 'macos_keychain' });
    return {
      port: wrap(fake.port, fake),
      prompts: (): number => fake.prompts,
      faults: fake,
    };
  };
}

/** One validated call of a store-backed port. */
interface BackendCall<T> {
  readonly signal: AbortSignal;
  /** The backend step; its result is the true outcome. */
  readonly run: () => T;
  /** Mutations only: the result when the port cannot know the outcome. */
  readonly uncertain?: T;
}

/** How a store-backed port times each call and answers its abort. */
type Delivery = <T>(call: BackendCall<T>) => Promise<T>;

/** A black-box adapter over an in-memory store; `deliver` decides abort behavior. */
function storePort(deliver: Delivery): PlatformSecretProtectionServices {
  const slots = new Map<string, Uint8Array>();
  function enter<T>(
    signal: AbortSignal,
    validate: () => void,
    call: Omit<BackendCall<T>, 'signal'>,
  ): Promise<T> {
    try {
      validate();
      signal.throwIfAborted();
    } catch (error) {
      // A TypeError, or the signal's own reason, which the contract requires.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(error);
    }
    return deliver({ ...call, signal });
  }
  const checkSlot =
    (slot: { readonly name: string }, options: PlatformKeySlotCallOptions) =>
    (): void => {
      if (!KEY_SLOT_NAME_PATTERN.test(slot.name))
        throw new TypeError('Invalid key slot name.');
      if (options.interaction !== 'never' && options.interaction !== 'allowed')
        throw new TypeError('Invalid key slot interaction.');
    };
  return {
    backend: 'windows_dpapi',
    status: ({ signal }): Promise<PlatformSecretProtectionState> =>
      enter<PlatformSecretProtectionState>(signal, () => undefined, {
        run: () => ({ state: 'available' }),
      }),
    readKeySlot: (slot, options): Promise<PlatformKeySlotReadResult> =>
      enter<PlatformKeySlotReadResult>(
        options.signal,
        checkSlot(slot, options),
        {
          run: () => {
            const stored = slots.get(slot.name);
            return stored
              ? { kind: 'present', material: Uint8Array.from(stored) }
              : { kind: 'absent' };
          },
        },
      ),
    writeKeySlot: (
      slot,
      material,
      options,
    ): Promise<PlatformKeySlotWriteResult> =>
      enter<PlatformKeySlotWriteResult>(
        options.signal,
        () => {
          checkSlot(slot, options)();
          if (
            material.byteLength < 1 ||
            material.byteLength > KEY_SLOT_MAX_BYTES
          )
            throw new TypeError('Invalid key slot material.');
          if (options.mode !== 'create' && options.mode !== 'replace')
            throw new TypeError('Invalid key slot write mode.');
        },
        {
          uncertain: { kind: 'uncertain' },
          run: () => {
            if (slots.has(slot.name) !== (options.mode === 'replace'))
              return { kind: 'conflict' };
            slots.set(slot.name, Uint8Array.from(material));
            return { kind: 'written' };
          },
        },
      ),
    deleteKeySlot: (slot, options): Promise<PlatformKeySlotDeleteResult> =>
      enter<PlatformKeySlotDeleteResult>(
        options.signal,
        checkSlot(slot, options),
        {
          uncertain: { kind: 'uncertain' },
          run: () =>
            slots.delete(slot.name) ? { kind: 'deleted' } : { kind: 'absent' },
        },
      ),
  };
}

/** Settles before the call returns, like a synchronous native API (DPAPI). */
const synchronous: Delivery = (call) =>
  new Promise((resolve) => resolve(call.run()));

/**
 * A plain promise settled by a microtask or, synchronously, by the abort
 * listener. Only the kit's `(at once)` abort, which runs before any microtask,
 * reaches the listener; `(after a macrotask)` always finds the call settled.
 * `runAtCall`: the backend step runs when the call starts, not on delivery.
 */
function listener(options: {
  readonly runAtCall: boolean;
  /** `uncertain` and `outcome` apply to mutations; queries then reject. */
  readonly onAbort: 'reject' | 'uncertain' | 'outcome';
}): Delivery {
  return <T>(call: BackendCall<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const early = options.runAtCall ? { value: call.run() } : null;
      let settled = false;
      const onAbort = (): void => {
        settled = true;
        if (call.uncertain !== undefined && options.onAbort === 'uncertain')
          resolve(call.uncertain);
        else if (
          call.uncertain !== undefined &&
          early &&
          options.onAbort === 'outcome'
        )
          resolve(early.value);
        // The contract requires the signal's own reason.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        else reject(call.signal.reason);
      };
      call.signal.addEventListener('abort', onAbort, { once: true });
      queueMicrotask(() => {
        call.signal.removeEventListener('abort', onAbort);
        if (!settled) resolve(early ? early.value : call.run());
      });
    });
}

const AVAILABLE_CASE = 'secret protection: available backend > ';
const abortedWhilePending = (when: 'at once' | 'after a macrotask'): string =>
  `${AVAILABLE_CASE}a call aborted while pending settles consistently with the slot (${when})`;

interface Recorded {
  readonly name: string;
  readonly body: () => Promise<void>;
}

/**
 * Runs the kit outside Jest and returns the names of the failing cases;
 * `only` runs just the cases whose names contain it.
 */
async function failingCases(
  make: () => SecretProtectionConformanceSubject,
  options?: Parameters<typeof runSecretProtectionConformance>[2],
  only?: string,
): Promise<{
  readonly all: readonly string[];
  readonly failed: readonly string[];
  readonly messages: readonly string[];
}> {
  const cases: Recorded[] = [];
  const scope: string[] = [];
  runSecretProtectionConformance(
    {
      describe: (name, body) => {
        scope.push(name);
        body();
        scope.pop();
      },
      it: (name, body) =>
        void cases.push({ name: [...scope, name].join(' > '), body }),
    },
    make,
    options,
  );
  const failed: string[] = [];
  const messages: string[] = [];
  for (const entry of cases.filter(({ name }) => name.includes(only ?? '')))
    try {
      await entry.body();
    } catch (error) {
      if (!(error instanceof SecretProtectionConformanceFailure)) throw error;
      failed.push(entry.name);
      messages.push(error.message);
    }
  return { all: cases.map((entry) => entry.name), failed, messages };
}

describe('the fake meets the secret protection contract', () => {
  runSecretProtectionConformance({ describe, it }, fakeSubject());
});

describe('the conformance kit', () => {
  it('registers the available-backend cases only when faults are disabled', async () => {
    const adapter = await failingCases(
      () => {
        const fake = createFakeSecretProtection({ backend: 'windows_dpapi' });
        return { port: fake.port, prompts: (): number => fake.prompts };
      },
      { withFaults: false },
    );
    expect(adapter.failed).toEqual([]);
    expect(
      adapter.all.every((name) => name.includes('available backend')),
    ).toBe(true);
    const withFaults = await failingCases(fakeSubject());
    expect(withFaults.failed).toEqual([]);
    expect(withFaults.all.length).toBeGreaterThan(adapter.all.length);
  });

  it('fails fault cases for a subject without fault control', async () => {
    const { failed } = await failingCases(() => {
      const fake = createFakeSecretProtection({
        backend: 'linux_secret_service',
      });
      return { port: fake.port, prompts: (): number => fake.prompts };
    });
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((name) => name.includes('faults'))).toBe(true);
  });

  it('catches a status prompt without fault control', async () => {
    let prompts = 0;
    const { failed } = await failingCases(
      () => {
        const { port } = createFakeSecretProtection({
          backend: 'macos_keychain',
        });
        return {
          port: {
            ...port,
            status: (options): Promise<PlatformSecretProtectionState> => {
              prompts += 1;
              return port.status(options);
            },
          },
          prompts: (): number => prompts,
        };
      },
      { withFaults: false },
    );
    expect(failed).toEqual([
      `${AVAILABLE_CASE}status resolves a closed state without prompting`,
      `${AVAILABLE_CASE}a pre-aborted call rejects with the signal reason and changes nothing`,
      abortedWhilePending('at once'),
      abortedWhilePending('after a macrotask'),
    ]);
  });

  it("catches an interaction 'never' prompt without fault control", async () => {
    let prompts = 0;
    const { all, failed } = await failingCases(
      () => {
        const { port } = createFakeSecretProtection({
          backend: 'macos_keychain',
        });
        return {
          port: {
            ...port,
            readKeySlot: (
              slot,
              options,
            ): Promise<PlatformKeySlotReadResult> => {
              if (options.interaction === 'never') prompts += 1;
              return port.readKeySlot(slot, options);
            },
          },
          prompts: (): number => prompts,
        };
      },
      { withFaults: false },
    );
    expect(failed).toContain(
      'secret protection: available backend > reads an unwritten slot as absent',
    );
    expect(failed.length).toBeGreaterThan(all.length / 2);
  });

  it('catches a port that keeps a slice() of a Buffer-like write input', async () => {
    // `slice()` copies a plain Uint8Array but returns a view of a Buffer.
    const { failed, messages } = await failingCases(
      fakeSubject((port) => {
        const kept = new Map<string, Uint8Array>();
        return {
          ...port,
          writeKeySlot: async (
            slot,
            material,
            options,
          ): Promise<PlatformKeySlotWriteResult> => {
            const result = await port.writeKeySlot(slot, material, options);
            if (result.kind === 'written')
              kept.set(slot.name, material.slice());
            return result;
          },
          readKeySlot: async (
            slot,
            options,
          ): Promise<PlatformKeySlotReadResult> => {
            const result = await port.readKeySlot(slot, options);
            const bytes = kept.get(slot.name);
            return result.kind === 'present' && bytes
              ? { kind: 'present', material: Uint8Array.from(bytes) }
              : result;
          },
        };
      }),
      { withFaults: false },
    );
    expect(failed).toEqual([
      'secret protection: available backend > creates a slot and never shares material buffers',
    ]);
    expect(messages).toEqual([
      'read after zeroing a Buffer-like input: material differs',
    ]);
  });

  const blackBox = (deliver: Delivery): ReturnType<typeof failingCases> =>
    failingCases(
      () => ({ port: storePort(deliver), prompts: (): number => 0 }),
      { withFaults: false },
    );

  it.each<{ readonly subject: string; readonly deliver: Delivery }>([
    { subject: 'settles before the call returns', deliver: synchronous },
    {
      subject: 'rechecks its signal after one tick',
      deliver: async <T>(call: BackendCall<T>): Promise<T> => {
        await Promise.resolve();
        call.signal.throwIfAborted();
        return call.run();
      },
    },
    {
      subject: 'resolves a synchronous result after the abort',
      deliver: async <T>(call: BackendCall<T>): Promise<T> => synchronous(call),
    },
    {
      subject: 'rejects from its abort listener before the backend step',
      deliver: listener({ runAtCall: false, onAbort: 'reject' }),
    },
    {
      subject:
        'reports an in-flight mutation uncertain from its abort listener',
      deliver: listener({ runAtCall: true, onAbort: 'uncertain' }),
    },
    {
      subject: 'reports a known mutation outcome from its abort listener',
      deliver: listener({ runAtCall: true, onAbort: 'outcome' }),
    },
  ])('passes a port that $subject', async ({ deliver }) => {
    const { failed, messages } = await blackBox(deliver);
    expect({ failed, messages }).toEqual({ failed: [], messages: [] });
  });

  it('fails a port that rejects a mutation that already reached the backend', async () => {
    const { failed, messages } = await blackBox(
      listener({ runAtCall: true, onAbort: 'reject' }),
    );
    expect({ failed, messages }).toEqual({
      failed: [abortedWhilePending('at once')],
      messages: ['replace: rejected, but the slot changed'],
    });
  });

  it.each<{ readonly leaves: string; readonly message: string }>([
    {
      leaves: 'a corrupt slot',
      message: 'delete: read corrupt, expected present or absent',
    },
    {
      leaves: 'an unreadable slot',
      message: 'delete: read blocked (unavailable), expected present or absent',
    },
  ])(
    'fails a port that reports an aborted in-flight delete deleted but leaves $leaves',
    async ({ leaves, message }) => {
      const { failed, messages } = await failingCases(
        fakeSubject((port, fake) => {
          const unreadable = new Set<string>();
          return {
            ...port,
            readKeySlot: (slot, options): Promise<PlatformKeySlotReadResult> =>
              unreadable.has(slot.name)
                ? Promise.resolve({ kind: 'blocked', reason: 'unavailable' })
                : port.readKeySlot(slot, options),
            deleteKeySlot: (
              slot,
              options,
            ): Promise<PlatformKeySlotDeleteResult> =>
              new Promise((resolve, reject) => {
                const onAbort = (): void => {
                  if (leaves === 'a corrupt slot')
                    fake.inject({ kind: 'corrupt', slot: slot.name });
                  else unreadable.add(slot.name);
                  resolve({ kind: 'deleted' });
                };
                options.signal.addEventListener('abort', onAbort, {
                  once: true,
                });
                void port
                  .deleteKeySlot(slot, options)
                  .then(resolve, reject)
                  .finally(() =>
                    options.signal.removeEventListener('abort', onAbort),
                  );
              }),
          };
        }),
        { withFaults: false },
      );
      expect({ failed, messages }).toEqual({
        failed: [abortedWhilePending('at once')],
        messages: [message],
      });
    },
  );

  it('fails a port that reports an aborted pending delete deleted but hides the slot it kept', async () => {
    const { failed, messages } = await failingCases(
      fakeSubject((port) => {
        const hidden = new Set<string>();
        let held = false;
        return {
          ...port,
          readKeySlot: (slot, options): Promise<PlatformKeySlotReadResult> =>
            hidden.has(slot.name)
              ? Promise.resolve({ kind: 'absent' })
              : port.readKeySlot(slot, options),
          // The first delete waits for its abort and never reaches the store.
          deleteKeySlot: (
            slot,
            options,
          ): Promise<PlatformKeySlotDeleteResult> => {
            if (held) return port.deleteKeySlot(slot, options);
            held = true;
            return new Promise((resolve) =>
              options.signal.addEventListener(
                'abort',
                () => {
                  hidden.add(slot.name);
                  resolve({ kind: 'deleted' });
                },
                { once: true },
              ),
            );
          },
        };
      }),
      { withFaults: false },
      'a call aborted while pending',
    );
    expect({ failed, messages }).toEqual({
      failed: [
        abortedWhilePending('at once'),
        abortedWhilePending('after a macrotask'),
      ],
      messages: [
        'delete: read absent, but create returned conflict',
        'delete: read absent, but create returned conflict',
      ],
    });
  });

  it('fails the abort fault cases when the harness does not hold the call', async () => {
    const { failed, messages } = await failingCases(() => {
      const fake = createFakeSecretProtection({ backend: 'macos_keychain' });
      return {
        port: fake.port,
        prompts: (): number => fake.prompts,
        faults: {
          inject: (fault): void => {
            if (fault.kind !== 'abort') fake.inject(fault);
          },
          clearFaults: (): void => fake.clearFaults(),
        },
      };
    });
    expect(failed).toEqual([
      'secret protection: faults > abort during status or a read rejects with the signal reason',
      'secret protection: faults > abort during a mutation (lost) settles consistently with the slot',
      'secret protection: faults > abort during a mutation (landed) settles consistently with the slot',
    ]);
    expect(messages).toEqual([
      'status: the abort fault did not hold the call in flight',
      'replace: the abort fault did not hold the call in flight',
      'replace: the abort fault did not hold the call in flight',
    ]);
  });

  it('fails every case when the prompt observer returns no count', async () => {
    const { all, failed } = await failingCases(
      () => ({
        port: createFakeSecretProtection({ backend: 'macos_keychain' }).port,
        prompts: (): number => Number.NaN,
      }),
      { withFaults: false },
    );
    expect(failed).toEqual(all);
  });

  type Port = PlatformSecretProtectionServices;
  /** Reports each delete truthfully, then puts the slot back and reads it as absent. */
  const restoresDeletedSlots = (
    port: Port,
    fake: FakeSecretProtection,
  ): Port => {
    const hidden = new Set<string>();
    const quiet = {
      signal: new AbortController().signal,
      interaction: 'never',
    } as const;
    return {
      ...port,
      readKeySlot: (slot, options): Promise<PlatformKeySlotReadResult> =>
        hidden.has(slot.name)
          ? Promise.resolve({ kind: 'absent' })
          : port.readKeySlot(slot, options),
      deleteKeySlot: async (
        slot,
        options,
      ): Promise<PlatformKeySlotDeleteResult> => {
        if (hidden.has(slot.name)) return { kind: 'absent' };
        const kept = fake.peek(slot.name);
        const result = await port.deleteKeySlot(slot, options);
        if (kept instanceof Uint8Array && fake.peek(slot.name) === null) {
          await port.writeKeySlot(slot, kept, { ...quiet, mode: 'create' });
          hidden.add(slot.name);
        }
        return result;
      },
    };
  };
  const mutants: readonly {
    readonly mutant: string;
    readonly wrap: (port: Port) => Port;
    readonly catches: string;
  }[] = [
    {
      mutant: 'shares the stored buffer with readers',
      wrap: (port: Port): Port => {
        const cache = new Map<string, PlatformKeySlotReadResult>();
        return {
          ...port,
          readKeySlot: async (
            slot,
            options,
          ): Promise<PlatformKeySlotReadResult> => {
            const cached = cache.get(slot.name);
            if (cached) return cached;
            const result = await port.readKeySlot(slot, options);
            if (result.kind === 'present') cache.set(slot.name, result);
            return result;
          },
        };
      },
      catches: 'never shares material buffers',
    },
    {
      mutant: 'prompts from status',
      wrap: (port: Port): Port => ({
        ...port,
        status: async (options): Promise<PlatformSecretProtectionState> => {
          await port.readKeySlot(
            { name: 'probe' },
            { ...options, interaction: 'allowed' },
          );
          return port.status(options);
        },
      }),
      catches: 'locked: status reports it without prompting',
    },
    {
      mutant: "ignores interaction: 'never'",
      wrap: (port: Port): Port => ({
        ...port,
        readKeySlot: (slot, options): Promise<PlatformKeySlotReadResult> =>
          port.readKeySlot(slot, { ...options, interaction: 'allowed' }),
      }),
      catches:
        "locked: interaction 'never' blocks every call without prompting",
    },
    {
      mutant: 'ignores its abort signal',
      wrap: (port: Port): Port => ({
        ...port,
        status: (): Promise<PlatformSecretProtectionState> =>
          port.status({ signal: new AbortController().signal }),
      }),
      catches: 'a pre-aborted call rejects with the signal reason',
    },
    {
      mutant: 'masks an uncertain write as written',
      wrap: (port: Port): Port => ({
        ...port,
        writeKeySlot: async (
          slot,
          material,
          options,
        ): Promise<PlatformKeySlotWriteResult> => {
          const result = await port.writeKeySlot(slot, material, options);
          return result.kind === 'uncertain' ? { kind: 'written' } : result;
        },
      }),
      catches: 'uncertain write (lost) is reported, not masked',
    },
    {
      mutant: 'leaks an extra field on present reads',
      wrap: (port: Port): Port => ({
        ...port,
        readKeySlot: async (
          slot,
          options,
        ): Promise<PlatformKeySlotReadResult> => {
          const result = await port.readKeySlot(slot, options);
          return result.kind === 'present'
            ? Object.assign(result, { path: '/tmp/slot' })
            : result;
        },
      }),
      catches: 'creates a slot and never shares material buffers',
    },
    {
      mutant: 'accepts path-like slot names',
      wrap: (port: Port): Port => ({
        ...port,
        readKeySlot: async (
          slot,
          options,
        ): Promise<PlatformKeySlotReadResult> =>
          slot.name.includes('/')
            ? { kind: 'absent' }
            : port.readKeySlot(slot, options),
      }),
      catches: 'rejects invalid slot names and material before the backend',
    },
    {
      mutant: 'treats an unknown interaction as allowed',
      wrap: (port: Port): Port => ({
        ...port,
        readKeySlot: (slot, options): Promise<PlatformKeySlotReadResult> =>
          port.readKeySlot(slot, {
            ...options,
            interaction: options.interaction === 'never' ? 'never' : 'allowed',
          }),
      }),
      catches: 'rejects invalid slot names and material before the backend',
    },
    {
      mutant: 'reports a failed write as uncertain',
      wrap: (port: Port): Port => ({
        ...port,
        writeKeySlot: async (
          slot,
          material,
          options,
        ): Promise<PlatformKeySlotWriteResult> => {
          const result = await port.writeKeySlot(slot, material, options);
          return result.kind === 'failed' ? { kind: 'uncertain' } : result;
        },
      }),
      catches: 'a failed write changes nothing',
    },
    {
      mutant: 'rejects valid 64-character slot names',
      wrap: (port: Port): Port => ({
        ...port,
        writeKeySlot: (
          slot,
          material,
          options,
        ): Promise<PlatformKeySlotWriteResult> =>
          slot.name.length > 32
            ? Promise.reject(new TypeError('name too long'))
            : port.writeKeySlot(slot, material, options),
      }),
      catches: 'accepts every valid slot name shape',
    },
    {
      mutant: 'rejects a delete aborted after reaching the backend',
      wrap: (port: Port): Port => ({
        ...port,
        deleteKeySlot: async (
          slot,
          options,
        ): Promise<PlatformKeySlotDeleteResult> => {
          const result = await port.deleteKeySlot(slot, options);
          options.signal.throwIfAborted();
          return result;
        },
      }),
      catches: 'abort during a mutation (landed)',
    },
    {
      mutant: 'rejects a replace aborted after it landed',
      wrap: (port: Port): Port => ({
        ...port,
        writeKeySlot: async (
          slot,
          material,
          options,
        ): Promise<PlatformKeySlotWriteResult> => {
          const result = await port.writeKeySlot(slot, material, options);
          options.signal.throwIfAborted();
          return result;
        },
      }),
      catches: 'abort during a mutation (landed)',
    },
    {
      mutant: 'reports a state the backend did not return when aborted',
      wrap: (port: Port): Port => ({
        ...port,
        status: (options): Promise<PlatformSecretProtectionState> =>
          new Promise((resolve, reject) => {
            port.status(options).then(resolve, reject);
            options.signal.addEventListener(
              'abort',
              () => resolve({ state: 'unavailable', reason: 'backend_failed' }),
              { once: true },
            );
          }),
      }),
      catches:
        'a call aborted while pending settles consistently with the slot',
    },
    {
      mutant: 'rolls back a write on a later abort',
      wrap: (port: Port): Port => ({
        ...port,
        writeKeySlot: async (
          slot,
          material,
          options,
        ): Promise<PlatformKeySlotWriteResult> => {
          const quiet = {
            signal: new AbortController().signal,
            interaction: 'never',
          } as const;
          const before = await port.readKeySlot(slot, quiet);
          const result = await port.writeKeySlot(slot, material, options);
          if (result.kind === 'written')
            options.signal.addEventListener(
              'abort',
              () =>
                void (before.kind === 'present'
                  ? port.writeKeySlot(slot, before.material, {
                      ...quiet,
                      mode: 'replace',
                    })
                  : port.deleteKeySlot(slot, quiet)),
              { once: true },
            );
          return result;
        },
      }),
      catches: 'an abort after a call settles changes nothing',
    },
  ];

  // Only the catching case: a mutant may hang an unrelated one, such as a
  // fault case holding a call whose signal it replaced.
  it.each(mutants)('catches a port that $mutant', async ({ wrap, catches }) => {
    const { failed } = await failingCases(fakeSubject(wrap), {}, catches);
    expect(failed.length).toBeGreaterThan(0);
  });

  it.each([
    'deletes a present slot, then reports absent',
    'an abort after a call settles changes nothing',
    'uncertain delete (landed)',
    'abort during a mutation (landed)',
  ])(
    'catches a port that keeps a deleted slot and reads it as absent: %s',
    async (only) => {
      const { failed, messages } = await failingCases(
        fakeSubject(restoresDeletedSlots),
        {},
        only,
      );
      expect(failed).toHaveLength(1);
      expect(messages).toEqual([
        'delete: read absent, but create returned conflict',
      ]);
    },
  );

  /** Reports `deleted` for matching slots without deleting them. */
  const keepsDeletedSlots =
    (keeps: (name: string, fake: FakeSecretProtection) => boolean) =>
    (hide: boolean) =>
    (port: Port, fake: FakeSecretProtection): Port => {
      const hidden = new Set<string>();
      return {
        ...port,
        readKeySlot: (slot, options): Promise<PlatformKeySlotReadResult> =>
          hidden.has(slot.name)
            ? Promise.resolve({ kind: 'absent' })
            : port.readKeySlot(slot, options),
        deleteKeySlot: (
          slot,
          options,
        ): Promise<PlatformKeySlotDeleteResult> => {
          if (!keeps(slot.name, fake)) return port.deleteKeySlot(slot, options);
          if (hide) hidden.add(slot.name);
          return Promise.resolve({ kind: 'deleted' });
        },
      };
    };
  it.each([
    {
      keeps: 'a corrupt slot',
      wrap: keepsDeletedSlots((name, fake) => fake.peek(name) === 'corrupt'),
      only: 'corrupt: reads corrupt',
      visible: 'corrupt',
    },
    {
      keeps: 'a 64-character slot',
      wrap: keepsDeletedSlots((name) => name.length === 64),
      only: 'accepts every valid slot name shape',
      visible: 'present',
    },
  ])(
    'catches a port that reports deleting $keeps but keeps it',
    async ({ wrap, only, visible }) => {
      for (const hide of [false, true]) {
        const { failed, messages } = await failingCases(
          fakeSubject(wrap(hide)),
          {},
          only,
        );
        expect(failed).toHaveLength(1);
        expect(messages).toEqual([
          expect.stringMatching(
            hide
              ? /: read absent, but create returned conflict$/
              : new RegExp(`: expected "absent", got "${visible}"$`),
          ),
        ]);
      }
    },
  );
});
