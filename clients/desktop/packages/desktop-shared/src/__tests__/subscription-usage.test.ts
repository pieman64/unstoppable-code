import { classifySubscriptionUsage } from '../lib/subscription-usage';
import type { ProviderRateLimitSnapshot } from '../types/observability';
const nowMs = Date.parse('2026-10-28T02:00:00Z');
const future = '2026-10-28T04:00:00Z';
const healthy: ProviderRateLimitSnapshot[] = [
  { limitId: 'five_hour', primary: { usedPercent: 0 } },
  { limitId: 'seven_day', primary: { usedPercent: 30 } },
  { limitId: 'extra_usage', primary: { usedPercent: 122 } },
];
describe('classifySubscriptionUsage', () => {
  it('ignores exhausted overage when included windows have headroom', () => {
    expect(
      classifySubscriptionUsage({
        provider: 'claude',
        rateLimits: healthy,
        nowMs,
      }),
    ).toEqual({ status: 'available' });
  });
  it('does not mistake the critical warning threshold for exhaustion', () => {
    expect(
      classifySubscriptionUsage({
        provider: 'claude',
        rateLimits: [{ primary: { usedPercent: 98 } }],
        nowMs,
      }).status,
    ).toBe('available');
  });
  it('requires every applicable window to have headroom', () => {
    expect(
      classifySubscriptionUsage({
        provider: 'claude',
        rateLimits: [
          ...healthy,
          {
            limitId: 'seven_day_opus',
            primary: { usedPercent: 100, resetsAt: future },
          },
        ],
        nowMs,
      }),
    ).toEqual({ status: 'limited', resetsAt: Date.parse(future) });
  });
  it('does not infer allowance from missing or invalid percentages or extra usage alone', () => {
    for (const rateLimits of [
      [],
      [{ limitId: 'extra_usage', primary: { usedPercent: 0 } }],
      [{ primary: { usedPercent: Number.NaN } }],
      [...healthy, { primary: {} }],
    ]) {
      expect(
        classifySubscriptionUsage({ provider: 'claude', rateLimits, nowMs })
          .status,
      ).toBe('unknown');
    }
  });
  it('does not affirm headroom from an exhausted window with a past reset', () => {
    expect(
      classifySubscriptionUsage({
        provider: 'claude',
        rateLimits: [{ primary: { usedPercent: 100, resetsAt: nowMs - 1 } }],
        nowMs,
      }).status,
    ).toBe('unknown');
  });
  it('never uses another model or surface allowance to erase a matching limit', () => {
    const rateLimits: ProviderRateLimitSnapshot[] = [
      ...healthy,
      {
        limitId: 'seven_day_opus',
        scope: { model: { id: 'opus', displayName: null } },
        primary: { usedPercent: 100, resetsAt: future },
      },
      {
        limitId: 'seven_day_cowork',
        scope: { surface: 'cowork' },
        primary: { usedPercent: 100, resetsAt: future },
      },
    ];
    expect(
      classifySubscriptionUsage({
        provider: 'claude',
        rateLimits,
        model: 'claude-sonnet-4-6',
        surface: 'claude-code',
        nowMs,
      }).status,
    ).toBe('available');
    expect(
      classifySubscriptionUsage({
        provider: 'claude',
        rateLimits,
        model: 'claude-opus-4-7',
        surface: 'claude-code',
        nowMs,
      }).status,
    ).toBe('limited');
    expect(
      classifySubscriptionUsage({ provider: 'claude', rateLimits, nowMs })
        .status,
    ).toBe('limited');
  });
});
