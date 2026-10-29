import { projectAccountProxyUsageAccount } from '@canopy/desktop-shared/lib/account-proxy-usage-projection';

import type {
  AccountProxyUsageInventoryEntry,
  AccountProxyUsageReadResult,
} from '../../account-proxy/usage';
import { AccountProxyQuotaUsage } from '../account-proxy-quota-usage';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface Harness {
  helper: AccountProxyQuotaUsage;
  changed: jest.Mock<void, []>;
  getReads: () => number;
  setEntries: (entries: readonly AccountProxyUsageInventoryEntry[]) => void;
  setNow: (value: number) => void;
  setRead: (
    read: (
      target: AccountProxyUsageInventoryEntry,
      signal: AbortSignal,
    ) => Promise<AccountProxyUsageReadResult>,
  ) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {
    throw new Error('Deferred resolver was not initialized');
  };
  const promise = new Promise<T>((resolve): void => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function entry(
  connectionId: string,
  authIndex: string,
  options: {
    provider?: 'claude' | 'codex';
    identity?: string;
    passiveUsage?: AccountProxyUsageInventoryEntry['passiveUsage'];
  } = {},
): AccountProxyUsageInventoryEntry {
  const provider = options.provider ?? 'claude';
  return {
    connectionId,
    authIndex,
    provider,
    identity: options.identity ?? `${provider}:${connectionId}:${authIndex}`,
    ...(options.passiveUsage === undefined
      ? {}
      : { passiveUsage: options.passiveUsage }),
  };
}

function success(usedPercent: number): AccountProxyUsageReadResult {
  return {
    status: 'success',
    rateLimits: [{ limitId: 'five-hour', primary: { usedPercent } }],
  };
}

function failure(
  kind:
    | 'auth'
    | 'network'
    | 'service'
    | 'rate_limited'
    | 'unsupported'
    | 'unknown',
  retryAfter?: string | null,
): AccountProxyUsageReadResult {
  return {
    status: 'failure',
    errorInfo: { kind },
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

function createHarness(
  options: {
    entries?: readonly AccountProxyUsageInventoryEntry[];
    now?: number;
    read?: (
      target: AccountProxyUsageInventoryEntry,
      signal: AbortSignal,
    ) => Promise<AccountProxyUsageReadResult>;
  } = {},
): Harness {
  let entries = options.entries ?? [];
  let now = options.now ?? Date.UTC(2026, 0, 1);
  let read =
    options.read ??
    ((): Promise<AccountProxyUsageReadResult> => Promise.resolve(success(20)));
  let reads = 0;
  const changed = jest.fn<void, []>();
  const helper = new AccountProxyQuotaUsage({
    inventory: (): readonly AccountProxyUsageInventoryEntry[] => entries,
    read: (target, signal): Promise<AccountProxyUsageReadResult> => {
      reads += 1;
      return read(target, signal);
    },
    changed,
    now: (): number => now,
  });
  return {
    helper,
    changed,
    getReads: (): number => reads,
    setEntries: (nextEntries): void => {
      entries = nextEntries;
    },
    setNow: (value): void => {
      now = value;
    },
    setRead: (nextRead): void => {
      read = nextRead;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('AccountProxyQuotaUsage', () => {
  it('retains a known profile plan on same-account failures but not identity replacement', async () => {
    const target = entry('proxy-a', 'claude-a', { identity: 'credential-a' });
    const harness = createHarness({
      entries: [target],
      read: () =>
        Promise.resolve({
          status: 'success',
          rateLimits: [{ limitId: 'five_hour', primary: { usedPercent: 20 } }],
          planType: 'default_claude_max_20x',
        }),
    });
    await harness.helper.refresh({ interactive: true });
    expect(harness.helper.get('proxy-a', 'claude-a')?.planType).toBe(
      'default_claude_max_20x',
    );

    harness.setNow(Date.UTC(2026, 0, 1) + 31_000);
    harness.setRead(() => Promise.resolve(success(30)));
    await harness.helper.refresh({ interactive: true });
    expect(harness.helper.get('proxy-a', 'claude-a')).toMatchObject({
      planType: 'default_claude_max_20x',
      rateLimits: [{ primary: { usedPercent: 30 } }],
    });

    harness.setNow(Date.UTC(2026, 0, 1) + 62_000);
    harness.setRead(() => Promise.resolve(failure('network')));
    await harness.helper.refresh({ interactive: true });
    expect(harness.helper.get('proxy-a', 'claude-a')?.planType).toBe(
      'default_claude_max_20x',
    );

    harness.setEntries([
      entry('proxy-a', 'claude-a', { identity: 'credential-b' }),
    ]);
    harness.helper.reconcile();
    expect(harness.helper.get('proxy-a', 'claude-a')).toBeUndefined();
  });

  it('single-flights overlapping refreshes and applies freshness windows', async () => {
    const target = entry('proxy-a', 'claude-a');
    const readResult = deferred<AccountProxyUsageReadResult>();
    const harness = createHarness({
      entries: [target],
      read: (): Promise<AccountProxyUsageReadResult> => readResult.promise,
    });
    harness.helper.reconcile();

    const first = harness.helper.refresh({ interactive: true });
    const joined = harness.helper.refresh({ interactive: true });
    await flushMicrotasks();
    expect(harness.getReads()).toBe(1);

    readResult.resolve(success(20));
    await Promise.all([first, joined]);
    expect(harness.helper.get('proxy-a', 'claude-a')).toMatchObject({
      source: 'live',
      lastUpdatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    });

    await harness.helper.refresh({ interactive: true });
    expect(harness.getReads()).toBe(1);

    harness.setNow(Date.UTC(2026, 0, 1) + 30_000);
    await harness.helper.refresh({ interactive: true });
    expect(harness.getReads()).toBe(2);

    harness.setNow(Date.UTC(2026, 0, 1) + 60_000);
    await harness.helper.refresh({ interactive: false });
    expect(harness.getReads()).toBe(2);
  });

  it('filters provider inventory before scheduling reads', async () => {
    const harness = createHarness({
      entries: [
        entry('proxy-a', 'claude-a', { provider: 'claude' }),
        entry('proxy-b', 'codex-b', { provider: 'codex' }),
      ],
    });
    harness.helper.reconcile();

    await harness.helper.refresh({ provider: 'codex' });

    expect(harness.getReads()).toBe(1);
    expect(harness.helper.get('proxy-a', 'claude-a')).toBeUndefined();
    expect(harness.helper.get('proxy-b', 'codex-b')).toMatchObject({
      source: 'live',
    });
  });

  it('adopts fresh same-identity inventory references before refresh', async () => {
    const original = entry('proxy-a', 'claude-a', { identity: 'credential-a' });
    let lastTarget: AccountProxyUsageInventoryEntry | undefined;
    const harness = createHarness({
      entries: [original],
      read: (target): Promise<AccountProxyUsageReadResult> => {
        lastTarget = target;
        return Promise.resolve(success(20));
      },
    });
    await harness.helper.refresh({ interactive: true });
    expect(lastTarget).toBe(original);

    const refreshed = entry('proxy-a', 'claude-a', {
      identity: 'credential-a',
    });
    harness.setEntries([refreshed]);
    harness.setNow(Date.UTC(2026, 0, 1) + 30_000);
    await harness.helper.refresh({ interactive: true });

    expect(lastTarget).toBe(refreshed);
    expect(harness.helper.get('proxy-a', 'claude-a')).toMatchObject({
      source: 'live',
      rateLimits: [{ primary: { usedPercent: 20 } }],
    });
  });

  it('retains prior data and timestamp without cooling down non-429 failures', async () => {
    const harness = createHarness({ entries: [entry('proxy-a', 'claude-a')] });
    harness.helper.reconcile();
    await harness.helper.refresh({ interactive: true });
    const successSnapshot = harness.helper.get('proxy-a', 'claude-a');
    expect(successSnapshot?.rateLimits[0]?.primary?.usedPercent).toBe(20);

    harness.setNow(Date.UTC(2026, 0, 1) + 30_000);
    harness.setRead(() => Promise.resolve(failure('network')));
    await harness.helper.refresh({ interactive: true });
    const failedSnapshot = harness.helper.get('proxy-a', 'claude-a');
    expect(failedSnapshot).toMatchObject({
      rateLimits: successSnapshot?.rateLimits,
      source: 'live',
      lastUpdatedAt: successSnapshot?.lastUpdatedAt,
      errorInfo: { kind: 'network' },
    });

    await harness.helper.refresh({ interactive: true });
    expect(harness.getReads()).toBe(3);
    expect(harness.helper.get('proxy-a', 'claude-a')?.lastUpdatedAt).toBe(
      successSnapshot?.lastUpdatedAt,
    );
  });

  it('retains passive observations without a timestamp when a live read fails', async () => {
    const harness = createHarness({
      entries: [
        entry('proxy-a', 'claude-a', {
          passiveUsage: {
            rateLimits: [
              { limitId: 'five-hour', primary: { usedPercent: 35 } },
            ],
            source: 'passive',
          },
        }),
      ],
      read: () => Promise.resolve(failure('network')),
    });

    await harness.helper.refresh({ interactive: true });

    expect(harness.helper.get('proxy-a', 'claude-a')).toMatchObject({
      rateLimits: [{ primary: { usedPercent: 35 } }],
      source: 'passive',
      errorInfo: { kind: 'network' },
    });
    expect(
      harness.helper.get('proxy-a', 'claude-a')?.lastUpdatedAt,
    ).toBeUndefined();
  });

  it.each(['network', 'rate_limited', 'auth'] as const)(
    'updates untimestamped passive usage after a %s failure without repeated notifications',
    async (kind) => {
      const passiveEntry = (
        usedPercent: number,
      ): AccountProxyUsageInventoryEntry =>
        entry('proxy-a', 'claude-a', {
          passiveUsage: {
            source: 'passive',
            rateLimits: [{ limitId: 'five-hour', primary: { usedPercent } }],
          },
        });
      const harness = createHarness({
        entries: [passiveEntry(20)],
        read: () => Promise.resolve(failure(kind, '120')),
      });
      await harness.helper.refresh({ interactive: true });
      const failed = harness.helper.get('proxy-a', 'claude-a');
      harness.changed.mockClear();

      harness.setEntries([passiveEntry(80)]);
      harness.helper.reconcile();
      const updated = harness.helper.get('proxy-a', 'claude-a');
      expect(updated).toEqual({
        ...failed,
        rateLimits: [{ limitId: 'five-hour', primary: { usedPercent: 80 } }],
      });
      expect(harness.changed).toHaveBeenCalledTimes(1);
      const projected = projectAccountProxyUsageAccount({
        authIndex: 'claude-a',
        provider: 'claude',
        source: 'sign-in',
        status: 'active',
        limits: [],
        usage: updated,
      });
      expect(projected.windows).toEqual([
        expect.objectContaining({ usedPercent: 80 }),
      ]);
      expect(projected.error).toBeDefined();

      harness.setEntries([passiveEntry(80)]);
      harness.helper.reconcile();
      expect(harness.changed).toHaveBeenCalledTimes(1);
      expect(harness.getReads()).toBe(1);
    },
  );

  it('seeds passive observations, but prefers live data at the same observed time', async () => {
    const observedAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
    const target = entry('proxy-a', 'claude-a', {
      passiveUsage: {
        rateLimits: [{ limitId: 'five-hour', primary: { usedPercent: 35 } }],
        source: 'passive',
        lastUpdatedAt: observedAt,
      },
    });
    const harness = createHarness({ entries: [target] });
    harness.helper.reconcile();
    expect(harness.helper.get('proxy-a', 'claude-a')).toMatchObject({
      source: 'passive',
      lastUpdatedAt: observedAt,
    });

    await harness.helper.refresh({ interactive: true });
    expect(harness.helper.get('proxy-a', 'claude-a')).toMatchObject({
      source: 'live',
      lastUpdatedAt: observedAt,
      rateLimits: [{ primary: { usedPercent: 20 } }],
    });

    harness.helper.reconcile();
    expect(harness.helper.get('proxy-a', 'claude-a')).toMatchObject({
      source: 'live',
      rateLimits: [{ primary: { usedPercent: 20 } }],
    });

    const newerPassiveAt = new Date(Date.UTC(2026, 0, 1) + 1_000).toISOString();
    harness.setEntries([
      entry('proxy-a', 'claude-a', {
        passiveUsage: {
          rateLimits: [{ limitId: 'five-hour', primary: { usedPercent: 45 } }],
          source: 'passive',
          lastUpdatedAt: newerPassiveAt,
        },
      }),
    ]);
    harness.setNow(Date.UTC(2026, 0, 1) + 1_000);
    harness.helper.reconcile();
    expect(harness.helper.get('proxy-a', 'claude-a')).toMatchObject({
      source: 'live',
      lastUpdatedAt: observedAt,
      rateLimits: [{ primary: { usedPercent: 20 } }],
    });
  });

  it.each([true, false])(
    'preserves richer live usage against passive observations (timestamp: %s) and failures',
    async (withTimestamp) => {
      const base = Date.UTC(2026, 0, 1);
      const liveLimits = [
        {
          limitId: 'weekly_scoped:claude-opus-4',
          limitName: 'Claude Opus weekly usage',
          planType: 'pro',
          primary: { usedPercent: 22, windowDurationMins: 10_080 },
          credits: { usedUsd: 3, totalUsd: 20, remainingUsd: 17 },
        },
      ];
      const harness = createHarness({
        now: base,
        entries: [entry('proxy-a', 'claude-a')],
        read: (): Promise<AccountProxyUsageReadResult> =>
          Promise.resolve({ status: 'success', rateLimits: liveLimits }),
      });
      await harness.helper.refresh({ interactive: true });
      const liveSnapshot = harness.helper.get('proxy-a', 'claude-a');

      harness.setEntries([
        entry('proxy-a', 'claude-a', {
          passiveUsage: {
            rateLimits: [
              { limitId: 'five-hour', primary: { usedPercent: 99 } },
            ],
            source: 'passive',
            ...(withTimestamp
              ? { lastUpdatedAt: new Date(base + 1_000).toISOString() }
              : {}),
          },
        }),
      ]);
      harness.setNow(base + 1_000);
      harness.helper.reconcile();
      expect(harness.helper.get('proxy-a', 'claude-a')).toMatchObject({
        source: 'live',
        rateLimits: liveLimits,
      });

      harness.setRead(() => Promise.resolve(failure('network')));
      harness.setNow(base + 30_000);
      await harness.helper.refresh({ interactive: true });

      expect(harness.helper.get('proxy-a', 'claude-a')).toMatchObject({
        source: 'live',
        rateLimits: liveLimits,
        lastUpdatedAt: liveSnapshot?.lastUpdatedAt,
        errorInfo: { kind: 'network' },
      });
    },
  );

  it('withdraws snapshots when an identity changes or disappears', async () => {
    const original = entry('proxy-a', 'claude-a', { identity: 'credential-a' });
    const harness = createHarness({ entries: [original] });
    harness.helper.reconcile();
    await harness.helper.refresh({ interactive: true });
    expect(harness.helper.get('proxy-a', 'claude-a')).toBeDefined();

    harness.setEntries([
      entry('proxy-a', 'claude-a', { identity: 'credential-b' }),
    ]);
    harness.helper.reconcile();
    expect(harness.helper.get('proxy-a', 'claude-a')).toBeUndefined();

    harness.setEntries([]);
    harness.helper.reconcile();
    expect(harness.helper.get('proxy-a', 'claude-a')).toBeUndefined();
  });

  it('fences late reads after an identity change even when abort is ignored', async () => {
    const target = entry('proxy-a', 'claude-a', { identity: 'credential-a' });
    const readResult = deferred<AccountProxyUsageReadResult>();
    let readSignal: AbortSignal | undefined;
    const harness = createHarness({
      entries: [target],
      read: (_target, signal): Promise<AccountProxyUsageReadResult> => {
        readSignal = signal;
        return readResult.promise;
      },
    });
    harness.helper.reconcile();
    const pending = harness.helper.refresh({ interactive: true });
    await flushMicrotasks();

    harness.setEntries([
      entry('proxy-a', 'claude-a', { identity: 'credential-b' }),
    ]);
    harness.helper.reconcile();
    expect(readSignal?.aborted).toBe(true);

    readResult.resolve(success(99));
    await pending;
    expect(harness.helper.get('proxy-a', 'claude-a')).toBeUndefined();
    expect(harness.changed).not.toHaveBeenCalled();
  });

  it('bounds concurrent reads across refresh calls to two accounts', async () => {
    const results = [
      deferred<AccountProxyUsageReadResult>(),
      deferred<AccountProxyUsageReadResult>(),
      deferred<AccountProxyUsageReadResult>(),
    ];
    let startedReads = 0;
    const harness = createHarness({
      entries: [
        entry('proxy-a', 'a'),
        entry('proxy-b', 'b'),
        entry('proxy-c', 'c'),
      ],
      read: (): Promise<AccountProxyUsageReadResult> => {
        const result = results[startedReads];
        startedReads += 1;
        if (result === undefined) {
          throw new Error('Unexpected read beyond inventory');
        }
        return result.promise;
      },
    });
    harness.helper.reconcile();

    const refresh = harness.helper.refresh({ interactive: true });
    await flushMicrotasks();
    expect(startedReads).toBe(2);

    results[0]?.resolve(success(10));
    await flushMicrotasks();
    expect(startedReads).toBe(3);

    results[1]?.resolve(success(20));
    results[2]?.resolve(success(30));
    await refresh;
    expect(harness.getReads()).toBe(3);
  });

  it('keeps 429 cooldowns account-scoped and honors Retry-After', async () => {
    const now = Date.UTC(2026, 0, 1);
    const harness = createHarness({
      now,
      entries: [entry('proxy-a', 'a'), entry('proxy-a', 'b')],
      read: (target): Promise<AccountProxyUsageReadResult> =>
        Promise.resolve(
          target.authIndex === 'a'
            ? failure('rate_limited', '120')
            : success(25),
        ),
    });
    harness.helper.reconcile();

    await harness.helper.refresh({ interactive: true });
    expect(harness.helper.get('proxy-a', 'a')).toMatchObject({
      source: 'live',
      rateLimits: [],
      errorInfo: {
        kind: 'rate_limited',
        retryAt: new Date(now + 120_000).toISOString(),
      },
      retryAt: now + 120_000,
    });

    await harness.helper.refresh({ interactive: true });
    expect(harness.getReads()).toBe(2);

    harness.setNow(now + 120_000);
    await harness.helper.refresh({ interactive: false });
    expect(harness.getReads()).toBe(3);
  });
});
