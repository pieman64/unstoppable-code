import type {
  ProviderRateLimitSnapshot,
  RetainedAccountUsageSnapshot,
} from '@canopy/desktop-shared/types';
import {
  computeAccountKey,
  normalizeRetainedAccountSnapshot,
  pruneRetainedAccountSnapshots,
  snapshotHasFutureReset,
} from '../account-usage-snapshots';

const NOW = Date.UTC(2026, 6, 8, 12, 0, 0);

function futureLimit(): ProviderRateLimitSnapshot {
  return {
    limitId: 'five_hour',
    primary: {
      usedPercent: 10,
      resetsAt: new Date(NOW + 60_000).toISOString(),
    },
  };
}

function pastLimit(): ProviderRateLimitSnapshot {
  return {
    limitId: 'five_hour',
    primary: {
      usedPercent: 10,
      resetsAt: new Date(NOW - 60_000).toISOString(),
    },
  };
}

function snapshot(
  overrides: Partial<RetainedAccountUsageSnapshot>,
): RetainedAccountUsageSnapshot {
  return {
    provider: 'claude',
    accountKey: 'claude:a@x.com:max',
    accountEmail: 'a@x.com',
    subscriptionLabel: 'max',
    rateLimits: [futureLimit()],
    capturedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('computeAccountKey', () => {
  it('lowercases and trims email + subscription', () => {
    expect(computeAccountKey('claude', ' A@X.com ', 'Max')).toBe(
      'claude:a@x.com:max',
    );
  });

  it('returns null when email is missing', () => {
    expect(computeAccountKey('codex', undefined, 'pro')).toBeNull();
    expect(computeAccountKey('codex', '   ', 'pro')).toBeNull();
  });

  it('uses empty subscription segment when subscription missing', () => {
    expect(computeAccountKey('codex', 'b@x.com', undefined)).toBe(
      'codex:b@x.com:',
    );
  });
});

describe('snapshotHasFutureReset', () => {
  it('is true when any window resets in the future', () => {
    expect(snapshotHasFutureReset([pastLimit(), futureLimit()], NOW)).toBe(
      true,
    );
  });

  it('is false when all windows are in the past or absent', () => {
    expect(snapshotHasFutureReset([pastLimit()], NOW)).toBe(false);
    expect(snapshotHasFutureReset(undefined, NOW)).toBe(false);
    expect(snapshotHasFutureReset([{ limitId: 'x' }], NOW)).toBe(false);
  });

  it('checks secondary windows too', () => {
    const limit: ProviderRateLimitSnapshot = {
      limitId: 'weekly',
      primary: { resetsAt: new Date(NOW - 1000).toISOString() },
      secondary: { resetsAt: new Date(NOW + 1000).toISOString() },
    };
    expect(snapshotHasFutureReset([limit], NOW)).toBe(true);
  });
});

describe('pruneRetainedAccountSnapshots', () => {
  it('drops accounts with no future reset window', () => {
    const kept = snapshot({ accountKey: 'claude:keep@x.com:max' });
    const dropped = snapshot({
      accountKey: 'claude:old@x.com:max',
      rateLimits: [pastLimit()],
    });
    const result = pruneRetainedAccountSnapshots([kept, dropped], NOW);
    expect(result.map((s) => s.accountKey)).toEqual(['claude:keep@x.com:max']);
  });

  it('caps at 10 most-recent accounts per provider', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      snapshot({
        accountKey: `claude:u${i}@x.com:max`,
        capturedAt: new Date(NOW - i * 1000).toISOString(),
      }),
    );
    const result = pruneRetainedAccountSnapshots(many, NOW);
    expect(result).toHaveLength(10);
    // Most-recent kept (u0..u9), oldest three (u10..u12) dropped.
    expect(result.some((s) => s.accountKey === 'claude:u12@x.com:max')).toBe(
      false,
    );
    expect(result.some((s) => s.accountKey === 'claude:u0@x.com:max')).toBe(
      true,
    );
  });

  it('sorts invalid capture times last before applying the provider cap', () => {
    const valid = Array.from({ length: 10 }, (_, i) =>
      snapshot({
        accountKey: `claude:valid${i}@x.com:max`,
        capturedAt: new Date(NOW - i * 1000).toISOString(),
      }),
    );
    const invalid = snapshot({
      accountKey: 'claude:invalid@x.com:max',
      capturedAt: 'not-a-date',
    });

    const result = pruneRetainedAccountSnapshots([invalid, ...valid], NOW);

    expect(result).toHaveLength(10);
    expect(result.some((s) => s.accountKey === invalid.accountKey)).toBe(false);
    expect(result.map((s) => s.accountKey)).toEqual(
      valid.map((s) => s.accountKey),
    );
  });

  it('applies the cap independently per provider', () => {
    const claude = Array.from({ length: 11 }, (_, i) =>
      snapshot({ accountKey: `claude:c${i}@x.com:max` }),
    );
    const codex = Array.from({ length: 11 }, (_, i) =>
      snapshot({ provider: 'codex', accountKey: `codex:x${i}@x.com:pro` }),
    );
    const result = pruneRetainedAccountSnapshots([...claude, ...codex], NOW);
    expect(result.filter((s) => s.provider === 'claude')).toHaveLength(10);
    expect(result.filter((s) => s.provider === 'codex')).toHaveLength(10);
  });
});

describe('normalizeRetainedAccountSnapshot', () => {
  it('round trips Claude spend and applicability through persisted JSON', () => {
    const limit: ProviderRateLimitSnapshot = {
      limitId: 'extra_usage',
      spend: { currency: 'USD', used: 61, limit: 50, isEnabled: true },
      scope: { model: { id: 'sonnet', displayName: 'Sonnet' }, surface: null },
    };
    const stored: unknown = JSON.parse(
      JSON.stringify(snapshot({ rateLimits: [limit] })),
    );
    const restored = normalizeRetainedAccountSnapshot(stored);
    expect(restored?.rateLimits?.[0]?.spend).toEqual(limit.spend);
    expect(restored?.rateLimits?.[0]?.scope).toEqual(limit.scope);
  });

  it('discards ambiguous legacy Claude extra-usage credits only', () => {
    const rateLimits = [
      { limitId: 'extra_usage', credits: { usedUsd: 6100, totalUsd: 5000 } },
    ];
    expect(
      normalizeRetainedAccountSnapshot(snapshot({ rateLimits }))
        ?.rateLimits?.[0]?.credits,
    ).toBeUndefined();
    expect(
      normalizeRetainedAccountSnapshot(
        snapshot({ provider: 'codex', rateLimits }),
      )?.rateLimits?.[0]?.credits,
    ).toMatchObject({ usedUsd: 6100, totalUsd: 5000 });
  });

  it('keeps explicit zero, uncapped and disabled spend states', () => {
    const spend = { currency: 'JPY', used: 0, limit: null, isEnabled: false };
    expect(
      normalizeRetainedAccountSnapshot(
        snapshot({ rateLimits: [{ limitId: 'extra_usage', spend }] }),
      )?.rateLimits?.[0]?.spend,
    ).toEqual(spend);
  });

  it('rejects malformed saved spend and applicability fields', () => {
    const restored = normalizeRetainedAccountSnapshot({
      ...snapshot({}),
      rateLimits: [
        {
          limitId: 'extra_usage',
          spend: {
            currency: 'invalid',
            used: -1,
            limit: Infinity,
            isEnabled: 'true',
          },
          scope: { model: { id: 7, displayName: false }, surface: 42 },
        },
      ],
    });
    expect(restored?.rateLimits?.[0]?.spend).toEqual({});
    expect(restored?.rateLimits?.[0]?.scope?.surface).toBeUndefined();
    expect(restored?.rateLimits?.[0]?.scope?.model?.id).not.toBe(7);
  });

  it('retains Cursor on-demand spend without inventing an unlimited balance', () => {
    const parsed = normalizeRetainedAccountSnapshot({
      provider: 'cursor',
      accountKey: 'cursor:a@x.com:Pro',
      capturedAt: new Date(NOW).toISOString(),
      rateLimits: [
        {
          limitId: 'cursor-on-demand',
          primary: { resetsAt: new Date(NOW + 60_000).toISOString() },
          credits: { usedUsd: 12.5 },
        },
      ],
    });
    expect(parsed?.rateLimits?.[0]?.credits).toMatchObject({ usedUsd: 12.5 });
    expect(parsed?.rateLimits?.[0]?.credits?.remainingUsd).toBeUndefined();
  });

  it('parses a valid record', () => {
    const parsed = normalizeRetainedAccountSnapshot({
      provider: 'codex',
      accountKey: 'codex:a@x.com:pro',
      accountEmail: 'a@x.com',
      subscriptionLabel: 'pro',
      rateLimits: [futureLimit()],
      capturedAt: new Date(NOW).toISOString(),
    });
    expect(parsed?.provider).toBe('codex');
    expect(parsed?.accountKey).toBe('codex:a@x.com:pro');
    expect(parsed?.rateLimits).toHaveLength(1);
  });

  it('rejects records with unknown provider or missing required fields', () => {
    expect(normalizeRetainedAccountSnapshot(null)).toBeNull();
    expect(
      normalizeRetainedAccountSnapshot({
        provider: 'nope',
        accountKey: 'k',
        capturedAt: 'x',
      }),
    ).toBeNull();
    expect(
      normalizeRetainedAccountSnapshot({ provider: 'claude', capturedAt: 'x' }),
    ).toBeNull();
  });
});
