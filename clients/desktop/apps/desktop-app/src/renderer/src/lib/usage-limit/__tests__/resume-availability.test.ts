import type { ProviderRateLimitSnapshot } from '@canopy/desktop-shared/types';
import {
  hasBlockingRateLimit,
  selectBlockingResetAtMs,
} from '../resume-availability';

const NOW_MS = Date.parse('2026-07-23T12:00:00.000Z');
const FUTURE_ISO = '2026-07-23T14:00:00.000Z';
const PAST_ISO = '2026-07-23T10:00:00.000Z';

describe('hasBlockingRateLimit', () => {
  it('returns false for undefined or empty rate limits', () => {
    expect(hasBlockingRateLimit(undefined, NOW_MS)).toBe(false);
    expect(hasBlockingRateLimit([], NOW_MS)).toBe(false);
  });

  it('returns false when every window is below 100%', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'five_hour',
        primary: { usedPercent: 92, resetsAt: FUTURE_ISO },
        secondary: { usedPercent: 78, resetsAt: FUTURE_ISO },
      },
    ];
    expect(hasBlockingRateLimit(limits, NOW_MS)).toBe(false);
  });

  it('blocks when a primary window is at 100% with a future reset', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'five_hour',
        primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
      },
    ];
    expect(hasBlockingRateLimit(limits, NOW_MS)).toBe(true);
  });

  it('blocks when only a secondary window is at the limit', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'codex',
        primary: { usedPercent: 40, resetsAt: FUTURE_ISO },
        secondary: { usedPercent: 100, resetsAt: FUTURE_ISO },
      },
    ];
    expect(hasBlockingRateLimit(limits, NOW_MS)).toBe(true);
  });

  it('treats a 100% window whose reset has passed as stale, not blocking', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'five_hour',
        primary: { usedPercent: 100, resetsAt: PAST_ISO },
      },
    ];
    expect(hasBlockingRateLimit(limits, NOW_MS)).toBe(false);
  });

  it('supports epoch-millisecond reset timestamps', () => {
    const pastLimits: ProviderRateLimitSnapshot[] = [
      { primary: { usedPercent: 100, resetsAt: NOW_MS - 1 } },
    ];
    const futureLimits: ProviderRateLimitSnapshot[] = [
      { primary: { usedPercent: 100, resetsAt: NOW_MS + 60_000 } },
    ];
    expect(hasBlockingRateLimit(pastLimits, NOW_MS)).toBe(false);
    expect(hasBlockingRateLimit(futureLimits, NOW_MS)).toBe(true);
  });

  it('blocks a 100% window with a missing or unparsable reset time', () => {
    expect(
      hasBlockingRateLimit([{ primary: { usedPercent: 100 } }], NOW_MS),
    ).toBe(true);
    expect(
      hasBlockingRateLimit(
        [{ primary: { usedPercent: 100, resetsAt: 'not-a-date' } }],
        NOW_MS,
      ),
    ).toBe(true);
  });

  it('ignores windows without a usedPercent', () => {
    expect(
      hasBlockingRateLimit([{ primary: { resetsAt: FUTURE_ISO } }], NOW_MS),
    ).toBe(false);
  });
});

describe('selectBlockingResetAtMs', () => {
  const LATER_ISO = '2026-07-23T18:13:00.000Z';

  it.each([NaN, Infinity, -Infinity, Number.MAX_VALUE])(
    'keeps an exhausted window blocking with unknown reset for %s',
    (resetsAt) => {
      const limits: ProviderRateLimitSnapshot[] = [
        {
          limitId: 'codex',
          primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
          secondary: { usedPercent: 100, resetsAt },
        },
      ];
      expect(
        hasBlockingRateLimit(
          [
            {
              limitId: 'unknown',
              primary: { usedPercent: 100, resetsAt },
            },
          ],
          NOW_MS,
        ),
      ).toBe(true);
      expect(selectBlockingResetAtMs(limits, NOW_MS)).toBeNull();
    },
  );

  function expectConsistent(limits: ProviderRateLimitSnapshot[]): void {
    // A known reset implies a blocker; no blocker implies no reset.
    if (selectBlockingResetAtMs(limits, NOW_MS) !== null) {
      expect(hasBlockingRateLimit(limits, NOW_MS)).toBe(true);
    }
    if (!hasBlockingRateLimit(limits, NOW_MS)) {
      expect(selectBlockingResetAtMs(limits, NOW_MS)).toBeNull();
    }
  }

  it('returns null when there are no windows', () => {
    expect(selectBlockingResetAtMs(undefined, NOW_MS)).toBeNull();
    expect(selectBlockingResetAtMs([], NOW_MS)).toBeNull();
  });

  it('returns the latest reset among multiple future blockers', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'codex',
        primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        secondary: { usedPercent: 100, resetsAt: LATER_ISO },
      },
    ];
    expect(selectBlockingResetAtMs(limits, NOW_MS)).toBe(Date.parse(LATER_ISO));
    expectConsistent(limits);
  });

  it('ignores below-threshold and elapsed windows', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'codex',
        primary: { usedPercent: 99.9, resetsAt: LATER_ISO },
        secondary: { usedPercent: 100, resetsAt: FUTURE_ISO },
      },
      {
        limitId: 'other',
        primary: { usedPercent: 100, resetsAt: PAST_ISO },
      },
    ];
    expect(selectBlockingResetAtMs(limits, NOW_MS)).toBe(
      Date.parse(FUTURE_ISO),
    );
    expectConsistent(limits);
  });

  it('treats a reset exactly at now as not blocking', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      { limitId: 'codex', secondary: { usedPercent: 100, resetsAt: NOW_MS } },
    ];
    expect(selectBlockingResetAtMs(limits, NOW_MS)).toBeNull();
    expect(hasBlockingRateLimit(limits, NOW_MS)).toBe(false);
  });

  it('returns null for an exhausted window with a missing or invalid reset', () => {
    for (const resetsAt of [undefined, 'not-a-date']) {
      const limits: ProviderRateLimitSnapshot[] = [
        { limitId: 'codex', secondary: { usedPercent: 100, resetsAt } },
      ];
      expect(selectBlockingResetAtMs(limits, NOW_MS)).toBeNull();
      expect(hasBlockingRateLimit(limits, NOW_MS)).toBe(true);
    }
  });

  it('returns null when a known blocker is mixed with an unknown one', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'codex',
        primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        secondary: { usedPercent: 100 },
      },
    ];
    expect(selectBlockingResetAtMs(limits, NOW_MS)).toBeNull();
    expect(hasBlockingRateLimit(limits, NOW_MS)).toBe(true);
  });

  it('accepts ISO strings and numeric millisecond timestamps', () => {
    const futureMs = Date.parse(LATER_ISO);
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'codex',
        primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        secondary: { usedPercent: 100, resetsAt: futureMs },
      },
    ];
    expect(selectBlockingResetAtMs(limits, NOW_MS)).toBe(futureMs);
    expectConsistent(limits);
  });
});
