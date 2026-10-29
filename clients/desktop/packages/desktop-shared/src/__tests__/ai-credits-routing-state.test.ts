import {
  isAiCreditsRoutingInEffect,
  normalizeEpochMs,
  providerAccountKey,
} from '../ai-credits-routing-state';
import type { AiCreditsRoutingState } from '../types';

const NOW = 1_800_000_000_000;

function session(
  overrides: Partial<AiCreditsRoutingState> = {},
): AiCreditsRoutingState {
  return {
    active: true,
    scope: 'session',
    activatedAt: NOW - 1000,
    ...overrides,
  };
}

describe('providerAccountKey', () => {
  it('prefers the lowercased trimmed email', () => {
    expect(
      providerAccountKey({
        accountEmail: '  Someone@Example.COM ',
        accountLabel: 'Max plan',
      }),
    ).toBe('someone@example.com');
  });

  it('falls back to the trimmed label', () => {
    expect(
      providerAccountKey({ accountEmail: '   ', accountLabel: ' Team A ' }),
    ).toBe('Team A');
    expect(
      providerAccountKey({ accountEmail: null, accountLabel: 'Team A' }),
    ).toBe('Team A');
  });

  it('returns null without an email or label', () => {
    expect(providerAccountKey({ accountLabel: null })).toBeNull();
    expect(
      providerAccountKey({ accountEmail: ' ', accountLabel: '  ' }),
    ).toBeNull();
  });
});

describe('normalizeEpochMs', () => {
  it('converts seconds to milliseconds', () => {
    expect(normalizeEpochMs(1_800_000_000)).toBe(1_800_000_000_000);
  });

  it('passes milliseconds through', () => {
    expect(normalizeEpochMs(1_800_000_000_000)).toBe(1_800_000_000_000);
  });

  it('treats zero, negative and non-finite values as missing', () => {
    expect(normalizeEpochMs(0)).toBeUndefined();
    expect(normalizeEpochMs(-5)).toBeUndefined();
    expect(normalizeEpochMs(Number.NaN)).toBeUndefined();
    expect(normalizeEpochMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('isAiCreditsRoutingInEffect', () => {
  it('is false for missing or inactive routing', () => {
    expect(isAiCreditsRoutingInEffect(undefined, { now: NOW })).toBe(false);
    expect(
      isAiCreditsRoutingInEffect(session({ active: false }), { now: NOW }),
    ).toBe(false);
  });

  it('keeps persistent routing in effect regardless of reset or account change', () => {
    expect(
      isAiCreditsRoutingInEffect(
        session({ scope: 'persistent', resetsAt: NOW - 1 }),
        { now: NOW, accountChangedAt: NOW },
      ),
    ).toBe(true);
  });

  it('ignores session routing once its reset time passes', () => {
    expect(
      isAiCreditsRoutingInEffect(session({ resetsAt: NOW - 1 }), { now: NOW }),
    ).toBe(false);
  });

  it('treats a reset time equal to now as passed', () => {
    expect(
      isAiCreditsRoutingInEffect(session({ resetsAt: NOW }), { now: NOW }),
    ).toBe(false);
  });

  it('keeps session routing before its reset time', () => {
    expect(
      isAiCreditsRoutingInEffect(session({ resetsAt: NOW + 1 }), { now: NOW }),
    ).toBe(true);
  });

  it('reads a reset time in epoch seconds as milliseconds', () => {
    // The Codex transcript banner still carries the app-server's seconds.
    expect(
      isAiCreditsRoutingInEffect(session({ resetsAt: (NOW + 60_000) / 1000 }), {
        now: NOW,
      }),
    ).toBe(true);
    expect(
      isAiCreditsRoutingInEffect(session({ resetsAt: (NOW - 60_000) / 1000 }), {
        now: NOW,
      }),
    ).toBe(false);
  });

  it('ignores session routing activated before an account change', () => {
    expect(
      isAiCreditsRoutingInEffect(session({ activatedAt: NOW - 10 }), {
        now: NOW,
        accountChangedAt: NOW - 5,
      }),
    ).toBe(false);
  });

  it('keeps session routing activated after an account change', () => {
    expect(
      isAiCreditsRoutingInEffect(session({ activatedAt: NOW - 1 }), {
        now: NOW,
        accountChangedAt: NOW - 5,
      }),
    ).toBe(true);
  });

  it('treats session routing with no activation time as older than any account change', () => {
    expect(
      isAiCreditsRoutingInEffect(
        { active: true, scope: 'session' },
        { now: NOW, accountChangedAt: 1 },
      ),
    ).toBe(false);
  });

  it('keeps legacy session routing with no reset and no account change', () => {
    expect(isAiCreditsRoutingInEffect(session(), { now: NOW })).toBe(true);
  });
});
