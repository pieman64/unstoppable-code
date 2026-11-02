import type {
  PlatformKeySlotReadResult,
  PlatformSecretProtectionServices,
  PlatformSecretProtectionState,
} from '../../../../platform/secret-protection';
import { createFakeSecretProtection } from '../../../../platform/testing/fake-secret-protection';
import { createVaultKeyHolder, type VaultKeyHolder } from '../key-holder';
import { vaultKeySlot } from '../key-slot-outcome';
import {
  generateVaultKey,
  isVaultSubkeysHeld,
  wrapDataKey,
} from '../vault-keys';
import {
  FIXTURE_BACKEND,
  FIXTURE_VAULT_ID,
  KEY_SLOT_FIXTURES,
  type KeySlotFixtureEnv,
} from './key-slot-fixtures';

const SLOT = vaultKeySlot(FIXTURE_VAULT_ID).name;
const CREATED_AT = '2026-10-29T12:00:00.000Z';

let now = Date.parse(CREATED_AT);
const clock = (): Date => new Date(now);
const holders: VaultKeyHolder[] = [];

afterEach(() => {
  for (const holder of holders.splice(0)) holder.dispose();
  now = Date.parse(CREATED_AT);
});

function holderFor(
  slots: PlatformSecretProtectionServices,
  wrapped: KeySlotFixtureEnv['wrapped'],
  probeTimeoutMs = 50,
): VaultKeyHolder {
  const holder = createVaultKeyHolder({
    slots,
    header: {
      vaultId: FIXTURE_VAULT_ID,
      wrappedDataKey: wrapped,
      createdAt: CREATED_AT,
    },
    clock,
    probeTimeoutMs,
    minProbeIntervalMs: 1_000,
  });
  holders.push(holder);
  return holder;
}

function counted(port: PlatformSecretProtectionServices): {
  readonly slots: PlatformSecretProtectionServices;
  readonly calls: { reads: number; statuses: number };
} {
  const calls = { reads: 0, statuses: 0 };
  const slots: PlatformSecretProtectionServices = {
    ...port,
    readKeySlot: (slot, options) => {
      calls.reads += 1;
      return port.readKeySlot(slot, options);
    },
    status: (options) => {
      calls.statuses += 1;
      return port.status(options);
    },
  };
  return { calls, slots };
}

function vault(): {
  fake: ReturnType<typeof createFakeSecretProtection>;
  wrapped: KeySlotFixtureEnv['wrapped'];
} {
  const kek = generateVaultKey();
  const wrapped = wrapDataKey(kek, generateVaultKey(), FIXTURE_VAULT_ID);
  return {
    fake: createFakeSecretProtection({
      backend: FIXTURE_BACKEND,
      slots: { [SLOT]: kek },
    }),
    wrapped,
  };
}

describe('vault key acquisition (CAN-5388, plan Q4)', () => {
  it.each(KEY_SLOT_FIXTURES.map((entry) => [entry.name, entry] as const))(
    'maps %s to its Q4 status and entry state, without prompting',
    async (_name, entry) => {
      const kek = generateVaultKey();
      const fake = createFakeSecretProtection({
        backend: FIXTURE_BACKEND,
        slots: { [SLOT]: entry.slotMaterial?.() ?? kek },
      });
      const env: KeySlotFixtureEnv = {
        fake,
        kek,
        wrapped: wrapDataKey(kek, generateVaultKey(), FIXTURE_VAULT_ID),
      };
      const wrapped = entry.arrange(env) ?? env.wrapped;
      // The fixture's own signal joins the holder's, as an abort or timeout would.
      const slots: PlatformSecretProtectionServices = {
        ...fake.port,
        readKeySlot: (slot, options) =>
          fake.port.readKeySlot(slot, {
            ...options,
            signal: AbortSignal.any([options.signal, entry.signal()]),
          }),
      };
      const holder = holderFor(slots, wrapped);
      if (entry.probe) await holder.refresh();

      expect(holder.status()).toEqual({
        protection: entry.expected.protection,
        observedAt: entry.probe ? CREATED_AT : null,
      });
      expect(holder.entryBlock()).toBe(entry.expected.entryBlock);
      expect(holder.keys() !== null).toBe(entry.expected.entryBlock === null);
      expect(fake.prompts).toBe(0);
    },
  );

  it('never overlaps slot reads: reads join a probe, refreshes share one more', async () => {
    const { fake, wrapped } = vault();
    fake.inject({ kind: 'locked', evidence: 'reported' });
    let active = 0;
    let peak = 0;
    const { slots, calls } = counted({
      ...fake.port,
      readKeySlot: async (slot, options) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          return await fake.port.readKeySlot(slot, options);
        } finally {
          active -= 1;
        }
      },
    });
    const holder = holderFor(slots, wrapped);

    await Promise.all([
      holder.refresh(),
      holder.probeIfDue(),
      holder.probeIfDue(),
    ]);
    expect(calls).toEqual({ reads: 1, statuses: 1 });

    now += 1_000;
    await Promise.all([
      holder.refresh(),
      holder.refresh(),
      holder.refresh(),
      holder.probeIfDue(),
    ]);
    expect(calls).toEqual({ reads: 3, statuses: 3 });
    expect(peak).toBe(1);
    expect(holder.entryBlock()).toBe('locked');
  });

  it('throttles probes from reads while the key is not held, then acquires it', async () => {
    const { fake, wrapped } = vault();
    fake.inject({ kind: 'unknown' });
    const { slots, calls } = counted(fake.port);
    const holder = holderFor(slots, wrapped);
    await holder.refresh();
    fake.clearFaults();

    now += 999;
    await holder.probeIfDue();
    expect(calls.reads).toBe(1);
    expect(holder.entryBlock()).toBe('locked');

    now += 1;
    await holder.probeIfDue();
    expect(calls.reads).toBe(2);
    expect(holder.entryBlock()).toBeNull();

    now += 60_000;
    await holder.probeIfDue();
    expect(calls.reads).toBe(2);
  });

  it('drops the key when a refresh observes a lock', async () => {
    const { fake, wrapped } = vault();
    const holder = holderFor(fake.port, wrapped);
    await holder.refresh();
    const keys = holder.keys();
    if (keys === null) throw new Error('Key not held.');

    fake.inject({ kind: 'locked', evidence: 'reported' });
    now += 5;
    await holder.refresh();

    expect(holder.keys()).toBeNull();
    expect(isVaultSubkeysHeld(keys)).toBe(false);
    expect(holder.entryBlock()).toBe('locked');
    expect(holder.status()).toEqual({
      protection: {
        state: 'locked',
        backend: FIXTURE_BACKEND,
        evidence: 'reported',
      },
      observedAt: new Date(now).toISOString(),
    });
  });

  it('drops the key on any refresh that does not unwrap, a timeout included', async () => {
    const { fake, wrapped } = vault();
    const holder = holderFor(fake.port, wrapped, 10);
    await holder.refresh();
    fake.inject({ kind: 'abort' });

    await holder.refresh();

    expect(holder.keys()).toBeNull();
    expect(holder.status().protection).toEqual({
      state: 'unavailable',
      backend: FIXTURE_BACKEND,
      reason: 'backend_failed',
    });
  });

  it('zeroes slot material that arrives after the probe timed out', async () => {
    const { wrapped } = vault();
    const material = generateVaultKey();
    const late: PlatformSecretProtectionServices = {
      ...createFakeSecretProtection({ backend: FIXTURE_BACKEND }).port,
      readKeySlot: (_slot, { signal }) =>
        new Promise<PlatformKeySlotReadResult>((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ kind: 'present', material }),
          );
        }),
    };
    const holder = holderFor(late, wrapped, 10);

    await holder.refresh();

    expect(material.every((byte) => byte === 0)).toBe(true);
    expect(holder.keys()).toBeNull();
    expect(holder.entryBlock()).toBe('unavailable');
  });

  it('records nothing from a probe that settles after dispose', async () => {
    const { fake, wrapped } = vault();
    fake.inject({ kind: 'abort' });
    const holder = holderFor(fake.port, wrapped, 60_000);

    const probe = holder.refresh();
    holder.dispose();
    await probe;
    await holder.refresh();

    expect(holder.keys()).toBeNull();
    expect(holder.status()).toEqual({
      protection: { state: 'unknown', backend: FIXTURE_BACKEND },
      observedAt: null,
    });
  });

  it('observes a lock that lands while an earlier probe is in flight', async () => {
    const { fake, wrapped } = vault();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const slots: PlatformSecretProtectionServices = {
      ...fake.port,
      readKeySlot: async (slot, options) => {
        reads += 1;
        const read = await fake.port.readKeySlot(slot, options);
        if (reads === 1) await gate;
        return read;
      },
    };
    const holder = holderFor(slots, wrapped, 60_000);

    const earlier = holder.refresh();
    await Promise.resolve();
    fake.inject({ kind: 'locked', evidence: 'reported' });
    const afterLock = holder.refresh();
    release();
    await Promise.all([earlier, afterLock]);

    expect(reads).toBe(2);
    expect(holder.keys()).toBeNull();
    expect(holder.entryBlock()).toBe('locked');
  });

  /** A backend call that ignores its abort; `settle` resolves it late. */
  function ignoringAbort<T>(value: T): {
    readonly call: () => Promise<T>;
    readonly settle: () => void;
  } {
    let settle = (): void => undefined;
    return {
      call: () =>
        new Promise<T>((resolve) => {
          settle = (): void => resolve(value);
        }),
      settle: () => settle(),
    };
  }

  it('bounds a probe whose slot read ignores its abort, and zeroes late material', async () => {
    const { fake, wrapped } = vault();
    const material = generateVaultKey();
    const hung = ignoringAbort<PlatformKeySlotReadResult>({
      kind: 'present',
      material,
    });
    const holder = holderFor(
      { ...fake.port, readKeySlot: hung.call },
      wrapped,
      10,
    );

    await holder.refresh();
    hung.settle();
    await new Promise((resolve) => setImmediate(resolve));

    expect(holder.keys()).toBeNull();
    expect(holder.status().protection).toEqual({
      state: 'unavailable',
      backend: FIXTURE_BACKEND,
      reason: 'backend_failed',
    });
    expect(material.every((byte) => byte === 0)).toBe(true);
  });

  it('bounds a probe whose status call ignores its abort', async () => {
    const { fake, wrapped } = vault();
    fake.inject({ kind: 'locked', evidence: 'reported' });
    const hung = ignoringAbort<PlatformSecretProtectionState>({
      state: 'locked',
      evidence: 'reported',
    });
    const holder = holderFor({ ...fake.port, status: hung.call }, wrapped, 10);

    await holder.refresh();
    hung.settle();

    expect(holder.status().protection).toEqual({
      state: 'locked',
      backend: FIXTURE_BACKEND,
      evidence: 'inferred',
    });
  });

  it.each(['readKeySlot', 'status'] as const)(
    'starts no backend call while a timed-out %s call is still outstanding',
    async (hungCall) => {
      const { fake, wrapped } = vault();
      if (hungCall === 'status')
        fake.inject({ kind: 'locked', evidence: 'reported' });
      let outstanding = 0;
      let peak = 0;
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let hung = false;
      // The first call to `hungCall` ignores its abort until `release`.
      async function tracked<R>(
        hangs: boolean,
        call: () => Promise<R>,
      ): Promise<R> {
        outstanding += 1;
        peak = Math.max(peak, outstanding);
        try {
          if (hangs && !hung) {
            hung = true;
            await released;
          }
          return await call();
        } finally {
          outstanding -= 1;
        }
      }
      const { slots, calls } = counted({
        ...fake.port,
        readKeySlot: (slot, options) =>
          tracked(hungCall === 'readKeySlot', () =>
            fake.port.readKeySlot(slot, options),
          ),
        status: (options) =>
          tracked(hungCall === 'status', () => fake.port.status(options)),
      });
      const holder = holderFor(slots, wrapped, 10);

      await holder.refresh();
      await Promise.all([holder.refresh(), holder.probeIfDue()]);
      now += 1_000;
      await holder.probeIfDue();
      await holder.refresh();

      expect(calls).toEqual({
        reads: 1,
        statuses: hungCall === 'status' ? 1 : 0,
      });
      expect(holder.keys()).toBeNull();
      expect(holder.status().protection).toEqual({
        state: 'unavailable',
        backend: FIXTURE_BACKEND,
        reason: 'backend_failed',
      });

      release();
      fake.clearFaults();
      await holder.refresh();

      expect(calls.reads).toBe(2);
      expect(peak).toBe(1);
      expect(holder.entryBlock()).toBeNull();
    },
  );

  it('settles a probe waiting on an abandoned backend call at dispose', async () => {
    const { fake, wrapped } = vault();
    const hung = ignoringAbort<PlatformKeySlotReadResult>({ kind: 'absent' });
    const { slots, calls } = counted({ ...fake.port, readKeySlot: hung.call });
    const holder = holderFor(slots, wrapped, 200);
    await holder.refresh();

    const waiting = holder.refresh();
    holder.dispose();
    const first = await Promise.race([
      waiting.then(() => 'probe'),
      new Promise((resolve) => setTimeout(resolve, 0, 'timer')),
    ]);
    hung.settle();

    expect(first).toBe('probe');
    expect(calls.reads).toBe(1);
    expect(holder.status()).toEqual({
      protection: { state: 'unknown', backend: FIXTURE_BACKEND },
      observedAt: null,
    });
  });

  it('probes from reads again after the clock steps backwards', async () => {
    const { fake, wrapped } = vault();
    fake.inject({ kind: 'locked', evidence: 'reported' });
    const { slots, calls } = counted(fake.port);
    const holder = holderFor(slots, wrapped);
    await holder.refresh();
    fake.clearFaults();

    now -= 3_600_000;
    await holder.probeIfDue();

    expect(calls.reads).toBe(2);
    expect(holder.entryBlock()).toBeNull();
  });

  it('reports no protection once disposed, matching the dropped key', async () => {
    const { fake, wrapped } = vault();
    const holder = holderFor(fake.port, wrapped);
    await holder.refresh();

    holder.dispose();

    expect(holder.entryBlock()).toBe('unavailable');
    expect(holder.status()).toEqual({
      protection: { state: 'unknown', backend: FIXTURE_BACKEND },
      observedAt: null,
    });
  });

  it('holds a data key adopted from init and zeroes the caller copy', () => {
    const { fake, wrapped } = vault();
    const holder = holderFor(fake.port, wrapped);
    const dataKey = generateVaultKey();

    holder.adopt(dataKey);

    expect(holder.keys()).not.toBeNull();
    expect(holder.status().protection.state).toBe('available');
    expect(dataKey.every((byte) => byte === 0)).toBe(true);
  });
});
