import { createHash } from 'node:crypto';
import type {
  W5CommitRequest,
  W5ReceiptLookup,
  W5ReservationFailureDiagnostics,
} from '../commit-log/commit-log';
import { W5CommitRefusedError } from '../commit-log/errors';
import type { W5ReservationInput } from '../commit-log-file-store';
import {
  admitLifecycleJournals,
  createW5KeyedOperationRunner,
  type W5KeyedAttempt,
  type W5KeyedOperationInput,
  type W5ReceiptStore,
} from '../keyed-operation';
import type { W5CommitOptions } from '../commit-scope';

interface Outcome {
  id: string;
}

function decode(outcome: unknown): Outcome {
  if (
    typeof outcome === 'object' &&
    outcome !== null &&
    'id' in outcome &&
    typeof outcome.id === 'string'
  )
    return { id: outcome.id };
  throw new Error('Unexpected outcome');
}

type Receipt = NonNullable<W5CommitRequest['receipt']>;

interface FakeStore extends W5ReceiptStore {
  calls: string[];
  lookupReceipt: jest.Mock<Promise<W5ReceiptLookup>, [Receipt]>;
  reserve: jest.Mock<Promise<void>, [W5ReservationInput]>;
  releaseReservation: jest.Mock<Promise<void>, [string]>;
  markReservationRecoveryRequired: jest.Mock<
    Promise<void>,
    [string, W5ReservationFailureDiagnostics]
  >;
}

/** Answers lookups in order, repeating the last; records every call. */
function fakeStore(...lookups: W5ReceiptLookup[]): FakeStore {
  const calls: string[] = [];
  const queue: W5ReceiptLookup[] = lookups.length
    ? lookups
    : [{ status: 'none' }];
  let next = 0;
  return {
    calls,
    lookupReceipt: jest.fn<Promise<W5ReceiptLookup>, [Receipt]>(() => {
      calls.push('lookup');
      const lookup = queue[Math.min(next, queue.length - 1)];
      next += 1;
      if (!lookup) throw new Error('Missing lookup');
      return Promise.resolve(lookup);
    }),
    reserve: jest.fn<Promise<void>, [W5ReservationInput]>(() => {
      calls.push('reserve');
      return Promise.resolve();
    }),
    releaseReservation: jest.fn<Promise<void>, [string]>(() => {
      calls.push('release');
      return Promise.resolve();
    }),
    markReservationRecoveryRequired: jest.fn<
      Promise<void>,
      [string, W5ReservationFailureDiagnostics]
    >(() => {
      calls.push('recovery');
      return Promise.resolve();
    }),
  };
}

/** Fails the next reservation, still recording the call. */
function failReserve(store: FakeStore, error: Error): void {
  store.reserve.mockImplementationOnce(() => {
    store.calls.push('reserve');
    return Promise.reject(error);
  });
}

const INPUT: W5KeyedOperationInput = {
  caller: 'desktop-host:test',
  operation: 'core.test.update',
  idempotencyKey: 'key-1',
  parameters: { name: 'value' },
  isPreEffectRefusal: () => false,
};

function run(
  store: W5ReceiptStore,
  input: Partial<W5KeyedOperationInput> = {},
  work: (
    binding: W5CommitOptions,
    attempt: W5KeyedAttempt,
  ) => Promise<Outcome> = () => Promise.resolve({ id: 'fresh' }),
): Promise<Outcome> {
  const runKeyed = createW5KeyedOperationRunner({
    getReceiptStore: () => store,
  });
  return runKeyed({ ...INPUT, ...input }, decode, work);
}

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

describe('receipt identity', () => {
  it('names the caller, operation and key and hashes canonical parameters', async () => {
    const store = fakeStore();
    let binding: W5CommitOptions | undefined;
    await run(
      store,
      {
        parameters: {
          b: [{ y: 2, x: 1 }, 'z'],
          a: null,
          skipped: undefined,
          c: { flag: true },
        },
      },
      (options) => {
        binding = options;
        return Promise.resolve({ id: 'fresh' });
      },
    );
    const receipt = {
      caller: 'desktop-host:test',
      operation: 'core.test.update',
      idempotencyKey: 'key-1',
      fingerprint: sha256(
        '{"a":null,"b":[{"x":1,"y":2},"z"],"c":{"flag":true}}',
      ),
    };
    expect(store.lookupReceipt).toHaveBeenCalledWith(receipt);
    const reservationId = store.reserve.mock.calls[0]?.[0]?.reservationId;
    expect(reservationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.reserve).toHaveBeenCalledWith({
      reservationId,
      operation: 'core.test.update',
      receipt,
    });
    if (!binding) throw new Error('The work did not run');
    const { beforeDecision, ...staged } = binding;
    expect(staged).toEqual({
      operation: 'core.test.update',
      receipt,
      reservationId,
    });
    expect(beforeDecision).toBeInstanceOf(Function);
  });

  it('hashes equal parameters equally regardless of key order, but not array order', async () => {
    const fingerprint = async (parameters: unknown): Promise<string> => {
      const store = fakeStore();
      await run(store, { parameters });
      return store.lookupReceipt.mock.calls[0]?.[0]?.fingerprint;
    };
    const first = await fingerprint({ a: 1, b: 'two' });
    expect(await fingerprint({ b: 'two', a: 1, c: undefined })).toBe(first);
    expect(await fingerprint([1, 2])).not.toBe(await fingerprint([2, 1]));
  });

  it('refuses non-JSON parameters before resolving the receipt store', async () => {
    const getReceiptStore = jest.fn(() => fakeStore());
    const runKeyed = createW5KeyedOperationRunner({ getReceiptStore });
    for (const parameters of [{ at: (): number => 0, n: 1 }, 1n]) {
      await expect(
        runKeyed({ ...INPUT, parameters }, decode, () =>
          Promise.resolve({ id: 'fresh' }),
        ),
      ).rejects.toThrow('W5 parameters must be JSON values');
    }
    expect(getReceiptStore).not.toHaveBeenCalled();
  });

  it('resolves the receipt store once per attempt', async () => {
    const store = fakeStore();
    const getReceiptStore = jest.fn(() => store);
    const runKeyed = createW5KeyedOperationRunner({ getReceiptStore });
    await runKeyed(INPUT, decode, () => Promise.resolve({ id: 'a' }));
    await runKeyed(INPUT, decode, () => Promise.resolve({ id: 'b' }));
    expect(getReceiptStore).toHaveBeenCalledTimes(2);
  });
});

describe('admission', () => {
  it.each<[W5ReceiptLookup, string, Record<string, unknown>]>([
    [{ status: 'key-reused' }, 'key-reused', {}],
    [
      { status: 'replay-expired', commitId: 3 },
      'outcome-expired',
      { commitId: 3 },
    ],
    [
      { status: 'in-progress', reservationId: 'r-1' },
      'in-progress',
      { reservationId: 'r-1' },
    ],
    [
      {
        status: 'commit-recovery-required',
        commitId: 4,
        diagnostics: undefined,
      },
      'recovery-required',
      { commitId: 4 },
    ],
    [
      {
        status: 'recovery-required',
        reservationId: 'r-2',
        diagnostics: undefined,
      },
      'recovery-required',
      { reservationId: 'r-2' },
    ],
  ])(
    'refuses a %j receipt without admission, reservation or work',
    async (lookup, reason, details) => {
      const store = fakeStore(lookup);
      const admit = jest.fn(() => Promise.resolve());
      const work = jest.fn(() => Promise.resolve({ id: 'fresh' }));
      const error: unknown = await run(store, { admit }, work).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(W5CommitRefusedError);
      expect(error).toMatchObject({ reason, details });
      expect(admit).not.toHaveBeenCalled();
      expect(work).not.toHaveBeenCalled();
      expect(store.calls).toEqual(['lookup']);
    },
  );

  it('replays a saved outcome without admission, reservation or work', async () => {
    const store = fakeStore({
      status: 'replay',
      commitId: 1,
      outcome: { id: 'stored', extra: true },
    });
    const admit = jest.fn(() => Promise.resolve());
    const onReplay = jest.fn();
    const work = jest.fn(() => Promise.resolve({ id: 'fresh' }));
    await expect(run(store, { admit, onReplay }, work)).resolves.toEqual({
      id: 'stored',
    });
    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(admit).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect(store.calls).toEqual(['lookup']);
  });

  it('never runs a saved outcome that fails to decode as a new operation', async () => {
    const store = fakeStore({
      status: 'replay',
      commitId: 1,
      outcome: { unexpected: true },
    });
    const admit = jest.fn(() => Promise.resolve());
    const onReplay = jest.fn();
    const work = jest.fn(() => Promise.resolve({ id: 'fresh' }));
    await expect(run(store, { admit, onReplay }, work)).rejects.toThrow(
      'Unexpected outcome',
    );
    expect(admit).not.toHaveBeenCalled();
    expect(onReplay).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect(store.calls).toEqual(['lookup']);
  });

  it('runs new-key admission before the reservation and reserves nothing when it fails', async () => {
    const store = fakeStore();
    const admit = jest.fn(() => {
      store.calls.push('admit');
      return Promise.resolve();
    });
    await run(store, { admit });
    expect(store.calls).toEqual(['lookup', 'admit', 'reserve']);

    const refused = fakeStore();
    const failure = new Error('stale');
    const work = jest.fn(() => Promise.resolve({ id: 'fresh' }));
    await expect(
      run(refused, { admit: () => Promise.reject(failure) }, work),
    ).rejects.toBe(failure);
    expect(refused.calls).toEqual(['lookup']);
    expect(work).not.toHaveBeenCalled();
  });

  it('swallows a replay observer failure at both replay returns', async () => {
    const onReplay = jest.fn(() => {
      throw new Error('observer failed');
    });
    await expect(
      run(fakeStore({ status: 'replay', commitId: 1, outcome: { id: 's' } }), {
        onReplay,
      }),
    ).resolves.toEqual({ id: 's' });
    const racing = fakeStore(
      { status: 'none' },
      { status: 'replay', commitId: 2, outcome: { id: 'winner' } },
    );
    failReserve(
      racing,
      new W5CommitRefusedError('in-progress', 'Already reserved.'),
    );
    await expect(run(racing, { onReplay })).resolves.toEqual({ id: 'winner' });
    expect(onReplay).toHaveBeenCalledTimes(2);
  });
});

describe('reservation races', () => {
  it('replays a racing winner after a reserve refusal without running the work', async () => {
    const store = fakeStore(
      { status: 'none' },
      { status: 'replay', commitId: 2, outcome: { id: 'winner' } },
    );
    failReserve(
      store,
      new W5CommitRefusedError('in-progress', 'Already reserved.'),
    );
    const work = jest.fn(() => Promise.resolve({ id: 'fresh' }));
    await expect(run(store, {}, work)).resolves.toEqual({ id: 'winner' });
    expect(work).not.toHaveBeenCalled();
    expect(store.lookupReceipt).toHaveBeenCalledTimes(2);
    expect(store.releaseReservation).not.toHaveBeenCalled();
  });

  it('reclassifies a racing in-progress attempt as its refusal', async () => {
    const store = fakeStore(
      { status: 'none' },
      { status: 'in-progress', reservationId: 'other' },
    );
    failReserve(
      store,
      new W5CommitRefusedError('in-progress', 'Already reserved.'),
    );
    await expect(run(store)).rejects.toMatchObject({
      reason: 'in-progress',
      details: { reservationId: 'other' },
    });
    expect(store.calls).toEqual(['lookup', 'reserve', 'lookup']);
  });

  it('rethrows the reserve refusal when the latest lookup still finds no receipt', async () => {
    const store = fakeStore({ status: 'none' });
    const refusal = new W5CommitRefusedError(
      'in-progress',
      'Already reserved.',
    );
    failReserve(store, refusal);
    await expect(run(store)).rejects.toBe(refusal);
  });

  it('never runs a racing winner that fails to decode as a new operation', async () => {
    const store = fakeStore(
      { status: 'none' },
      { status: 'replay', commitId: 2, outcome: 'not an outcome' },
    );
    failReserve(
      store,
      new W5CommitRefusedError('in-progress', 'Already reserved.'),
    );
    const work = jest.fn(() => Promise.resolve({ id: 'fresh' }));
    await expect(run(store, {}, work)).rejects.toThrow('Unexpected outcome');
    expect(work).not.toHaveBeenCalled();
    expect(store.calls).toEqual(['lookup', 'reserve', 'lookup']);
  });

  it('rethrows other reserve failures without another lookup', async () => {
    const store = fakeStore();
    const failure = new Error('worker unavailable');
    failReserve(store, failure);
    await expect(run(store)).rejects.toBe(failure);
    expect(store.calls).toEqual(['lookup', 'reserve']);
  });
});

describe('failed attempts', () => {
  it('releases the reservation for a pre-effect refusal', async () => {
    const store = fakeStore();
    const refusal = new Error('boundary refusal');
    await expect(
      run(store, { isPreEffectRefusal: (error) => error === refusal }, () =>
        Promise.reject(refusal),
      ),
    ).rejects.toBe(refusal);
    const reservationId = store.reserve.mock.calls[0]?.[0]?.reservationId;
    expect(store.releaseReservation).toHaveBeenCalledWith(reservationId);
    expect(store.markReservationRecoveryRequired).not.toHaveBeenCalled();
  });

  it('releases the reservation for tagged validation errors', async () => {
    const thrown = new Error('invalid branch');
    const tagged = new Error('invalid base');
    for (const work of [
      (
        _binding: W5CommitOptions,
        attempt: W5KeyedAttempt,
      ): Promise<Outcome> => {
        attempt.validate(() => {
          throw thrown;
        });
        return Promise.resolve({ id: 'unreachable' });
      },
      (_binding: W5CommitOptions, attempt: W5KeyedAttempt): Promise<Outcome> =>
        Promise.reject(attempt.validationError(tagged)),
    ]) {
      const store = fakeStore();
      await expect(run(store, {}, work)).rejects.toBeInstanceOf(Error);
      expect(store.calls).toEqual(['lookup', 'reserve', 'release']);
    }
  });

  it('keeps a refusal after the first effect recovery-required', async () => {
    for (const signal of ['beforeEffects', 'beforeDecision'] as const) {
      const store = fakeStore();
      const refusal = new Error('late refusal');
      await expect(
        run(store, { isPreEffectRefusal: () => true }, (binding, attempt) => {
          if (signal === 'beforeEffects') attempt.beforeEffects();
          else binding.beforeDecision?.();
          return Promise.reject(refusal);
        }),
      ).rejects.toBe(refusal);
      expect(store.calls).toEqual(['lookup', 'reserve', 'recovery']);
    }
  });

  it('keeps an uncertain failure recovery-required with safe diagnostics', async () => {
    const store = fakeStore();
    const failure = Object.assign(new Error('disk failed'), { code: 'EIO' });
    await expect(run(store, {}, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    const reservationId = store.reserve.mock.calls[0]?.[0]?.reservationId;
    expect(store.markReservationRecoveryRequired).toHaveBeenCalledWith(
      reservationId,
      { operation: 'core.test.update', errorName: 'Error', errorCode: 'EIO' },
    );
    expect(store.releaseReservation).not.toHaveBeenCalled();
  });

  it('drops unsafe diagnostic names, codes and throwing accessors', async () => {
    const unsafe = Object.assign(new Error('x'), { code: 'lower case' });
    unsafe.name = 'Not safe!';
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'code', {
      get: () => {
        throw new Error('accessor');
      },
    });
    for (const [failure, diagnostics] of [
      [unsafe, { operation: 'core.test.update', errorName: 'UnknownError' }],
      [
        'not an error',
        { operation: 'core.test.update', errorName: 'UnknownError' },
      ],
      [hostile, { operation: 'core.test.update', errorName: 'Error' }],
    ] as const) {
      const store = fakeStore();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error failure is under test
      await expect(run(store, {}, () => Promise.reject(failure))).rejects.toBe(
        failure,
      );
      expect(store.markReservationRecoveryRequired).toHaveBeenCalledWith(
        expect.any(String),
        diagnostics,
      );
    }
  });

  it('propagates the original error when release or recovery marking fails', async () => {
    const released = fakeStore();
    released.releaseReservation.mockRejectedValueOnce(new Error('consumed'));
    const refusal = new Error('refusal');
    await expect(
      run(released, { isPreEffectRefusal: () => true }, () =>
        Promise.reject(refusal),
      ),
    ).rejects.toBe(refusal);

    const marked = fakeStore();
    marked.markReservationRecoveryRequired.mockRejectedValueOnce(
      new Error('worker unavailable'),
    );
    const failure = new Error('failure');
    await expect(run(marked, {}, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
  });

  it('keeps the original error and leaves the reservation for recovery when the refusal classifier throws', async () => {
    const store = fakeStore();
    const failure = new Error('failure');
    const classifierFailure = new Error('classifier');
    await expect(
      run(
        store,
        {
          isPreEffectRefusal: () => {
            throw classifierFailure;
          },
        },
        () => Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    expect(store.calls).toEqual(['lookup', 'reserve']);
  });
});

describe('admitLifecycleJournals', () => {
  const journalRefusal = (): W5CommitRefusedError =>
    new W5CommitRefusedError('recovery-required', 'Inspect the journal.');

  it.each<[string, Error, boolean, string]>([
    [
      'a recovery-required refusal before effects',
      journalRefusal(),
      false,
      'release',
    ],
    ['the same refusal after effects', journalRefusal(), true, 'recovery'],
    [
      'another refusal',
      new W5CommitRefusedError('in-progress', 'Still running.'),
      false,
      'recovery',
    ],
    ['a read failure', new Error('EIO'), false, 'recovery'],
  ])(
    'settles the reservation for %s',
    async (_label, failure, afterEffects, settled) => {
      const store = fakeStore();
      await expect(
        run(store, {}, (_binding, attempt) => {
          if (afterEffects) attempt.beforeEffects();
          return admitLifecycleJournals(attempt, () => Promise.reject(failure));
        }),
      ).rejects.toBe(failure);
      expect(store.calls).toEqual(['lookup', 'reserve', settled]);
    },
  );

  it('returns the read and passes refusals through outside a keyed attempt', async () => {
    await expect(
      admitLifecycleJournals(undefined, () => Promise.resolve('journals')),
    ).resolves.toBe('journals');
    const refusal = journalRefusal();
    await expect(
      admitLifecycleJournals(undefined, () => Promise.reject(refusal)),
    ).rejects.toBe(refusal);
  });
});

it('loads its entrypoint without node:sqlite', () => {
  jest.isolateModules(() => {
    jest.doMock('node:sqlite', () => {
      throw new Error('node:sqlite was loaded');
    });
    expect((): void => {
      jest.requireActual<object>('../keyed-operation');
    }).not.toThrow();
  });
});
