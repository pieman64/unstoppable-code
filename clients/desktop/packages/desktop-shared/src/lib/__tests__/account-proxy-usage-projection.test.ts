import { subscriptionLabelForPlanType } from '@canopy/protocol/telemetry';
import type { AccountProxyAccount } from '../../types/account-proxy';
import { projectAccountProxyUsageAccount } from '../account-proxy-usage-projection';
import { parseCodexWhamUsage } from '../provider-usage-parsers';
import { parseAccountProxyPassiveUsage } from '../account-proxy';

const RESET = Date.UTC(2026, 9, 20, 18, 0, 0);

function account(overrides: Partial<AccountProxyAccount>): AccountProxyAccount {
  return {
    authIndex: 'a1b2',
    provider: 'claude',
    label: 'dev@example.com',
    source: 'sign-in',
    fileName: 'claude-dev@example.com.json',
    planType: 'max',
    status: 'active',
    statusMessage: 'raw proxy message',
    availableAt: null,
    limits: [],
    ...overrides,
  };
}

describe('projectAccountProxyUsageAccount', () => {
  it.each([
    { minutes: [300, 10080], labels: ['5-hour window', '7-day window'] },
    { minutes: [1440, 300], labels: ['1-day window', '5-hour window'] },
    {
      minutes: [undefined, undefined],
      labels: ['Primary window', 'Secondary window'],
    },
  ])(
    'projects passive Codex window labels exactly once: $labels',
    ({ minutes, labels }) => {
      const usage = parseAccountProxyPassiveUsage('codex', {
        signals: {
          'X-Codex-Primary-Used-Percent': '20',
          'X-Codex-Secondary-Used-Percent': '40',
          ...(minutes[0] === undefined
            ? {}
            : { 'X-Codex-Primary-Window-Minutes': String(minutes[0]) }),
          ...(minutes[1] === undefined
            ? {}
            : { 'X-Codex-Secondary-Window-Minutes': String(minutes[1]) }),
        },
      });
      const projected = projectAccountProxyUsageAccount(
        account({ provider: 'codex', usage }),
      );
      expect(projected.windows.map((window) => window.label)).toEqual(labels);
      expect(projected.windows.map((window) => window.usedPercent)).toEqual([
        20, 40,
      ]);
    },
  );

  it('projects named Claude windows, true durations and freshness from a usage snapshot', () => {
    const projected = projectAccountProxyUsageAccount(
      account({
        limits: [{ id: 'weekly', usedPercent: 90, resetsAt: RESET }],
        usage: {
          source: 'live',
          lastUpdatedAt: '2026-10-20T14:00:00.000Z',
          rateLimits: [
            {
              limitId: 'five_hour',
              limitName: '5-hour window',
              primary: { usedPercent: 42, resetsAt: RESET },
            },
            {
              limitId: 'seven_day_opus',
              limitName: '7-day Opus',
              primary: { usedPercent: 12 },
            },
          ],
        },
      }),
    );
    expect(projected).toEqual({
      id: 'a1b2',
      label: 'dev@example.com',
      planLabel: subscriptionLabelForPlanType('claude', 'max'),
      status: 'active',
      usageSource: 'live',
      lastUpdatedAt: '2026-10-20T14:00:00.000Z',
      windows: [
        {
          id: 'five_hour-primary',
          label: '5-hour window',
          usedPercent: 42,
          resetsAt: new Date(RESET).toISOString(),
          windowDurationMs: 5 * 60 * 60 * 1000,
        },
        {
          id: 'seven_day_opus-primary',
          label: '7-day Opus',
          usedPercent: 12,
          windowDurationMs: 7 * 24 * 60 * 60 * 1000,
        },
      ],
    });
  });

  it('carries a Codex credit balance under the bucket first window only', () => {
    const projected = projectAccountProxyUsageAccount(
      account({
        provider: 'codex',
        planType: 'pro',
        usage: {
          source: 'passive',
          rateLimits: [
            {
              limitId: 'codex',
              primary: { usedPercent: 22, windowDurationMins: 300 },
              secondary: { usedPercent: 54, windowDurationMins: 10080 },
              credits: { remainingUsd: 12500 },
            },
          ],
        },
      }),
    );
    expect(projected.usageSource).toBe('passive');
    expect(projected.windows.map((window) => window.label)).toEqual([
      '5-hour window',
      '7-day window',
    ]);
    expect(projected.windows[0]?.credits).toEqual({
      unit: 'credits',
      remaining: 12500,
    });
    expect(projected.windows[1]?.credits).toBeUndefined();
  });

  it.each([123, 0])(
    'projects a credits-only Codex WHAM balance of %d without quota metadata',
    (balance) => {
      const projected = projectAccountProxyUsageAccount(
        account({
          provider: 'codex',
          planType: 'pro',
          usage: {
            source: 'live',
            rateLimits: parseCodexWhamUsage({ credits: { balance } }),
          },
        }),
      );

      expect(projected.usageSource).toBe('live');
      expect(projected.windows).toHaveLength(1);
      const [window] = projected.windows;
      expect(window).toMatchObject({
        label: 'Credits',
        credits: { unit: 'credits', remaining: balance },
      });
      expect(window).not.toHaveProperty('usedPercent');
      expect(window).not.toHaveProperty('resetsAt');
      expect(window).not.toHaveProperty('windowDurationMs');
    },
  );

  it('keeps Codex usage unavailable when the WHAM response omits a balance', () => {
    const projected = projectAccountProxyUsageAccount(
      account({
        provider: 'codex',
        usage: {
          source: 'live',
          rateLimits: parseCodexWhamUsage({ credits: {} }),
        },
      }),
    );

    expect(projected.windows).toEqual([]);
    expect(projected.windows).not.toContainEqual(
      expect.objectContaining({ credits: { unit: 'credits', remaining: 0 } }),
    );
  });

  it('does not show Codex usage as zero when there is no usage snapshot', () => {
    const projected = projectAccountProxyUsageAccount(
      account({ provider: 'codex' }),
    );

    expect(projected.windows).toEqual([]);
    expect(projected).not.toHaveProperty('usageSource');
  });

  it('treats a present snapshot as authoritative even with no windows', () => {
    const projected = projectAccountProxyUsageAccount(
      account({
        limits: [{ id: 'weekly', usedPercent: 40, resetsAt: null }],
        usage: { source: 'live', rateLimits: [] },
      }),
    );
    expect(projected.windows).toEqual([]);
    expect(projected.usageSource).toBe('live');
  });

  it('falls back to the proxy reported limits only without a snapshot', () => {
    const projected = projectAccountProxyUsageAccount(
      account({
        limits: [
          { id: 'five-hour', usedPercent: 64, resetsAt: RESET },
          { id: 'weekly', usedPercent: 40, resetsAt: null },
        ],
      }),
    );
    expect(projected.usageSource).toBe('passive');
    expect(projected.windows).toEqual([
      {
        id: 'five-hour',
        label: '5-hour limit',
        usedPercent: 64,
        resetsAt: new Date(RESET).toISOString(),
        windowDurationMs: 5 * 60 * 60 * 1000,
      },
      {
        id: 'weekly',
        label: 'Weekly limit',
        usedPercent: 40,
        windowDurationMs: 7 * 24 * 60 * 60 * 1000,
      },
    ]);
  });

  it('reports usage as unavailable, never 0%, with neither snapshot nor limits', () => {
    const projected = projectAccountProxyUsageAccount(account({}));
    expect(projected.windows).toEqual([]);
    expect(projected).not.toHaveProperty('usageSource');
  });

  it('keeps cached windows beside a curated error and the retry time', () => {
    const retryAt = RESET + 60_000;
    const projected = projectAccountProxyUsageAccount(
      account({
        usage: {
          source: 'live',
          lastUpdatedAt: '2026-10-20T13:00:00.000Z',
          rateLimits: [{ limitId: 'five_hour', primary: { usedPercent: 70 } }],
          errorInfo: {
            kind: 'rate_limited',
            message: 'raw 429 body',
            detail: 'secret detail',
          },
          retryAt,
        },
      }),
    );
    expect(projected.windows).toHaveLength(1);
    expect(projected.error?.kind).toBe('service');
    expect(projected.error?.message).not.toContain('raw 429');
    expect(projected.error?.message).not.toContain('secret');
    expect(projected.retryAt).toBe(new Date(retryAt).toISOString());
  });

  it('labels API key accounts and never projects credential or proxy details', () => {
    const projected = projectAccountProxyUsageAccount(
      account({
        source: 'api-key',
        fileName: null,
        label: '',
        status: 'cooling',
        availableAt: RESET,
      }),
    );
    expect(projected.planLabel).toBe('API key');
    expect(projected).not.toHaveProperty('label');
    expect(projected.availableAt).toBe(new Date(RESET).toISOString());
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('claude-dev@example.com.json');
    expect(serialized).not.toContain('raw proxy message');
    expect(serialized).not.toContain('authIndex');
  });
});
