/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ProviderAccountUsage,
  ProviderAccountUsageDetails,
  providerAccountUsageStatusText,
  providerAccountUsageSummaryLimits,
} from '@canopy/ui-shared';
import {
  ProviderAccountUsage as ComponentsProviderAccountUsage,
  ProviderAccountUsageDetails as ComponentsProviderAccountUsageDetails,
  providerAccountUsageStatusText as componentsProviderAccountUsageStatusText,
  providerAccountUsageSummaryLimits as componentsProviderAccountUsageSummaryLimits,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

const NOW_MS = Date.parse('2026-10-20T15:00:00.000Z');
const LAST_UPDATED_AT = '2026-10-20T14:30:00.000Z';
const RESETS_AT = '2026-10-20T18:00:00.000Z';

const account = {
  id: 'claude-account-1',
  label: 'alice@example.com',
  planLabel: 'Claude Max 20x',
  status: 'active' as const,
  usageSource: 'live' as const,
  lastUpdatedAt: LAST_UPDATED_AT,
  windows: [
    {
      id: 'seven_day_opus-primary',
      label: '7-day Opus',
      usedPercent: 42,
      resetsAt: RESETS_AT,
      credits: {
        unit: 'usd' as const,
        spent: 1.25,
        remaining: 8.75,
        total: 10,
      },
    },
  ],
};

describe('ProviderAccountUsage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('exports the details component from both shared entry points', () => {
    expect(ComponentsProviderAccountUsage).toBe(ProviderAccountUsage);
    expect(ComponentsProviderAccountUsageDetails).toBe(
      ProviderAccountUsageDetails,
    );
    expect(componentsProviderAccountUsageStatusText).toBe(
      providerAccountUsageStatusText,
    );
    expect(componentsProviderAccountUsageSummaryLimits).toBe(
      providerAccountUsageSummaryLimits,
    );
  });

  it('renders the account row and blocks only the account label from replay', () => {
    act(() => {
      root.render(
        <ProviderAccountUsage
          account={account}
          providerLabel="Claude"
          nowMs={NOW_MS}
        >
          <button type="button">Manage account</button>
        </ProviderAccountUsage>,
      );
    });

    expect(
      container.querySelector('[data-testid="provider-account-usage"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Accountalice@example.com');
    expect(container.textContent).not.toContain('Claude account');
    expect(container.textContent).toContain('Manage account');
    expect(container.textContent).toContain('7-day Opus');
    const replayBlocks = container.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`);
    expect(replayBlocks).toHaveLength(1);
    expect(replayBlocks[0]?.textContent).toBe('alice@example.com');
    expect(
      container.querySelector('button')?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('shows the provider account status label when the account has no label', () => {
    const unlabelledAccount = {
      id: account.id,
      planLabel: account.planLabel,
      status: account.status,
      usageSource: account.usageSource,
      lastUpdatedAt: account.lastUpdatedAt,
      windows: account.windows,
    };
    act(() => {
      root.render(
        <ProviderAccountUsage
          account={unlabelledAccount}
          providerLabel="Claude"
          nowMs={NOW_MS}
        />,
      );
    });

    expect(container.textContent).toContain('AccountClaude account');
    expect(container.textContent).not.toContain('alice@example.com');
    expect(container.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('shows named windows, usage, reset time, credits, and freshness', () => {
    act(() => {
      root.render(
        <ProviderAccountUsageDetails account={account} nowMs={NOW_MS} />,
      );
    });

    expect(container.textContent).toContain('7-day Opus');
    expect(container.textContent).toContain('42%');
    expect(container.textContent).toContain('Resets ');
    expect(container.textContent).toContain('$1.25 spent');
    expect(container.textContent).toContain('$8.75 left');
    const freshness = Array.from(container.querySelectorAll('p')).find(
      (paragraph) => paragraph.textContent?.startsWith('Updated '),
    );
    expect(freshness?.textContent).toMatch(/^Updated /);
    expect(freshness?.getAttribute('title')).toContain(
      new Date(LAST_UPDATED_AT).toLocaleDateString(),
    );
    expect(freshness?.getAttribute('title')).toContain(
      new Date(LAST_UPDATED_AT).toLocaleTimeString(),
    );
  });

  it('can disclose usage while leaving failed-read feedback visible', () => {
    act(() => {
      root.render(
        <ProviderAccountUsageDetails
          account={{
            ...account,
            error: { kind: 'network', message: 'Check your connection.' },
          }}
          nowMs={NOW_MS}
          collapsible
        />,
      );
    });
    const disclosure = container.querySelector(
      '[data-testid="provider-account-usage"]',
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="provider-account-usage-toggle"]',
    );
    expect(toggle?.textContent).toBe('Usage');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('7-day Opus');
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Check your connection.',
    );
    expect(
      disclosure?.contains(container.querySelector('[role="status"]')),
    ).toBe(false);
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const body = container.querySelector(
      '[data-testid="provider-account-usage-body"]',
    );
    expect(body?.textContent).toContain('7-day Opus');
    expect(body?.textContent).toContain('$8.75 left');
    act(() => {
      root.render(
        <ProviderAccountUsageDetails account={account} nowMs={NOW_MS} />,
      );
    });
    expect(
      container.querySelector('[data-testid="provider-account-usage"]'),
    ).toBeNull();
    expect(container.textContent).toContain('7-day Opus');
  });

  it('keeps cached windows visible with an error and a future retry time', () => {
    const retryAt = Date.parse('2026-10-21T16:00:00.000Z');
    const accountWithError = {
      ...account,
      status: 'error' as const,
      error: {
        kind: 'network' as const,
        message: 'Check your connection, then try reaching Claude again.',
      },
      retryAt: new Date(retryAt).toISOString(),
    };

    act(() => {
      root.render(
        <ProviderAccountUsageDetails
          account={accountWithError}
          nowMs={NOW_MS}
        />,
      );
    });

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain(
      'Check your connection, then try reaching Claude again.',
    );
    expect(status?.textContent).toContain('Showing last known usage.');
    expect(status?.textContent).toContain('Try again after ');
    expect(status?.textContent).toContain(
      new Date(retryAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
      }),
    );
    expect(status?.textContent).toContain(
      new Date(retryAt).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
    expect(container.textContent).toContain('7-day Opus');
    expect(container.textContent).toContain('42%');
    expect(providerAccountUsageStatusText(accountWithError, NOW_MS)).toContain(
      'Showing last known usage.',
    );
  });

  it('renders Claude overage as monthly spend and cap rather than wallet credits', () => {
    act(() => {
      root.render(
        <ProviderAccountUsageDetails
          account={{
            ...account,
            windows: [
              {
                id: 'extra_usage-primary',
                label: 'Extra usage',
                spend: {
                  currency: 'USD',
                  used: 61,
                  limit: 50,
                  isEnabled: true,
                },
              },
            ],
          }}
          nowMs={NOW_MS}
        />,
      );
    });
    expect(container.textContent).toContain('Monthly spend: $61.00');
    expect(container.textContent).toContain('Monthly spending cap: $50.00');
    expect(container.textContent).not.toContain('Remaining credits');
    expect(container.textContent).not.toContain('Usage unavailable');
  });

  it('distinguishes disabled and unreported extra usage without a fake zero', () => {
    act(() => {
      root.render(
        <ProviderAccountUsageDetails
          account={{
            ...account,
            windows: [
              {
                id: 'extra_usage-primary',
                label: 'Extra usage',
                spend: { isEnabled: false },
              },
            ],
          }}
          nowMs={NOW_MS}
        />,
      );
    });
    expect(container.textContent).toContain('Extra usage is off');
    expect(container.textContent).not.toContain('$0.00');
    act(() => {
      root.render(
        <ProviderAccountUsageDetails
          account={{
            ...account,
            windows: [
              {
                id: 'extra_usage-primary',
                label: 'Extra usage',
                spend: { isEnabled: true },
              },
            ],
          }}
          nowMs={NOW_MS}
        />,
      );
    });
    expect(container.textContent).toContain('Monthly spend unavailable');
    expect(container.textContent).toContain('Monthly cap unavailable');
    expect(container.textContent).not.toContain('$0.00');
  });

  it('does not show an extra-usage cap on a regular subscription window', () => {
    act(() => {
      root.render(
        <ProviderAccountUsageDetails account={account} nowMs={NOW_MS} />,
      );
    });
    expect(container.textContent).toContain('7-day Opus');
    expect(container.textContent).not.toContain('Monthly spending cap');
    expect(container.textContent).not.toContain('Monthly cap unavailable');
  });

  it('keeps empty usage unknown and maps credit units into indicator limits', () => {
    const emptyAccount = { ...account, windows: [] };
    const countBalanceAccount = {
      ...account,
      windows: [
        {
          id: 'codex-balance',
          label: 'Codex balance',
          credits: { unit: 'credits' as const, remaining: 12_500 },
        },
      ],
    };
    const unlimitedAccount = {
      ...account,
      windows: [
        {
          id: 'unlimited-window',
          label: 'Unlimited requests',
          unlimited: true,
        },
      ],
    };

    act(() => {
      root.render(
        <ProviderAccountUsageDetails account={emptyAccount} nowMs={NOW_MS} />,
      );
    });
    expect(container.textContent).toContain('Usage unavailable');
    expect(container.textContent).not.toMatch(/\b0(?:\.0)?%/);

    const usdLimits = providerAccountUsageSummaryLimits(account);
    expect(usdLimits).toHaveLength(1);
    expect(usdLimits[0]).toMatchObject({
      id: 'seven_day_opus-primary',
      label: '7-day Opus',
      usedPercent: 42,
      resetsAt: RESETS_AT,
      usedUsd: 1.25,
      remainingUsd: 8.75,
      totalUsd: 10,
    });
    const countLimits = providerAccountUsageSummaryLimits(countBalanceAccount);
    expect(countLimits).toHaveLength(1);
    expect(countLimits[0]).toMatchObject({
      id: 'codex-balance',
      label: 'Codex balance',
      remainingCredits: 12_500,
    });
    expect(providerAccountUsageSummaryLimits(unlimitedAccount)).toMatchObject([
      { id: 'unlimited-window', label: 'Unlimited requests', unlimited: true },
    ]);
  });

  it('uses proxy-report freshness when a passive snapshot has no error', () => {
    act(() => {
      root.render(
        <ProviderAccountUsageDetails
          account={{ ...account, usageSource: 'passive' as const }}
          nowMs={NOW_MS}
        />,
      );
    });
    expect(container.textContent).toContain('Reported by the account proxy');
    expect(
      providerAccountUsageStatusText(
        { ...account, usageSource: 'passive' as const },
        NOW_MS,
      ),
    ).toBe('Reported by the account proxy');
    expect(
      providerAccountUsageStatusText(
        { ...account, usageSource: 'live' as const },
        NOW_MS,
      ),
    ).toMatch(/^Updated /);
  });
});
