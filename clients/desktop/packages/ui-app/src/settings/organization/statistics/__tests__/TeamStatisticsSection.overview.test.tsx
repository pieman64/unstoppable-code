/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TeamUsageResponse } from '@canopy/protocol/telemetry';

import type { JSX } from 'react';
import { TestSettingsHost } from '../../../__tests__/helpers/test-settings-host';
import { TeamStatisticsSection } from '../TeamStatisticsSection';
import {
  createStatisticsTestHost,
  flushStatistics,
  type StatisticsTestHost,
} from './helpers/statistics-host';

// Answers `organization.statistics.usage` through the fake settings client.
const readUsage = jest.fn<Promise<TeamUsageResponse>, [unknown]>();

// Overview is the default tab, so these tests leave the URL query empty.
let statsHost: StatisticsTestHost;

function withHost(element: JSX.Element): JSX.Element {
  return <TestSettingsHost host={statsHost.host}>{element}</TestSettingsHost>;
}

beforeEach(() => {
  statsHost = createStatisticsTestHost({
    usage: (input) => readUsage(input),
  });
});

jest.mock('../RoutingBacktestCard', () => ({
  RoutingBacktestCard: ({
    variant = 'card',
  }: {
    variant?: 'card' | 'inset';
  }): JSX.Element => (
    <div data-testid="routing-backtest-card" data-variant={variant} />
  ),
}));

function baseUsage(): TeamUsageResponse {
  return {
    scope: 'organization',
    teamId: null,
    range: {
      startIso: '2026-06-01T00:00:00.000Z',
      endIso: '2026-06-08T00:00:00.000Z',
      granularity: 'day',
    },
    filterUserId: null,
    headline: [],
    tokensByProvider: [],
    tokensByModel: [],
    costByProvider: [
      {
        bucketStartIso: '2026-06-01T00:00:00.000Z',
        key: 'CLAUDE',
        totalCostUsd: 40,
      },
      {
        bucketStartIso: '2026-06-01T00:00:00.000Z',
        key: 'CODEX',
        totalCostUsd: 10,
      },
    ],
    costByModel: [],
    toolCategoryTotals: [],
    eventTypeStatusCounts: [],
    byUser: [],
    impactByUser: [],
    pipelines: [],
    mostExpensiveRuns: [],
  };
}

function withBilledCost(): TeamUsageResponse {
  return {
    ...baseUsage(),
    billedCost: {
      byBucket: [
        {
          bucketStartIso: '2026-06-01T00:00:00.000Z',
          key: 'claude',
          totalCostUsd: 5,
        },
      ],
      totalUsd: 5,
      previousTotalUsd: null,
      savingsUsd: 45,
      plans: [
        {
          provider: 'claude',
          planKey: 'claude:pro',
          label: 'Claude Pro',
          accountCount: 2,
          effectiveMonthlyUsd: 20,
          monthsActive: 2,
          billedUsd: 5,
        },
        {
          provider: 'codex',
          planKey: 'codex:enterprise',
          label: 'Codex Enterprise',
          accountCount: 1,
          effectiveMonthlyUsd: null,
          monthsActive: 1,
          billedUsd: 0,
        },
      ],
      unpricedAccountCount: 1,
    },
  };
}

function withAutoRoutingSavings(
  overrides: Partial<NonNullable<TeamUsageResponse['autoRoutingSavings']>> = {},
): TeamUsageResponse {
  return {
    ...baseUsage(),
    autoRoutingSavings: {
      autoTurnCount: 12,
      comparableTurnCount: 9,
      benchmarkEstimatedExecutionCostUsd: 30,
      selectedExecutionCostUsd: 11,
      routingCostUsd: 1,
      actualWithAutoCostUsd: 12,
      netEstimatedSavingsUsd: 18,
      previousNetEstimatedSavingsUsd: 10,
      ...overrides,
    },
  };
}

describe('TeamStatisticsSection overview billed cost', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    readUsage.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderResolved(usage: TeamUsageResponse): Promise<void> {
    readUsage.mockResolvedValue(usage);
    act(() => {
      root.render(
        withHost(
          <TeamStatisticsSection
            orgId="org-1"
            organizationName="Acme"
            mobileBrowser={false}
            subTeams={[]}
            members={[]}
          />,
        ),
      );
    });
    // Flush the usage read, state updates and the lazy chart chunk.
    await flushStatistics();
  }

  it('renders the Subscriptions panel with plan rows and the unpriced note', async () => {
    await renderResolved(withBilledCost());

    const table = container.querySelector(
      '[data-testid="subscriptions-table"]',
    );
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain('Claude Pro');
    expect(table?.textContent).toContain('Codex Enterprise');
    // Unpriced plan shows the em dash for its monthly price.
    expect(table?.textContent).toContain('—');

    const note = container.querySelector(
      '[data-testid="subscriptions-unpriced-note"]',
    );
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('1 subscription account');
  });

  it('adds Billed and Savings columns to the provider cost table', async () => {
    await renderResolved(withBilledCost());

    const table = container.querySelector(
      '[data-testid="cost-breakdown-table"]',
    );
    expect(table).not.toBeNull();
    const headers = Array.from(table?.querySelectorAll('th') ?? []).map(
      (th) => th.textContent,
    );
    expect(headers).toContain('Subscription cost (est.)');
    expect(headers).toContain('Savings (est.)');
  });

  it('omits the Subscriptions panel and billed columns when billedCost is absent', async () => {
    await renderResolved(baseUsage());

    expect(
      container.querySelector('[data-testid="subscriptions-table"]'),
    ).toBeNull();

    const table = container.querySelector(
      '[data-testid="cost-breakdown-table"]',
    );
    const headers = Array.from(table?.querySelectorAll('th') ?? []).map(
      (th) => th.textContent,
    );
    expect(headers).not.toContain('Subscription cost (est.)');
  });
});

describe('TeamStatisticsSection Auto model routing panel', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    readUsage.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderResolved(usage: TeamUsageResponse): Promise<void> {
    readUsage.mockResolvedValue(usage);
    act(() => {
      root.render(
        withHost(
          <TeamStatisticsSection
            orgId="org-1"
            organizationName="Acme"
            mobileBrowser={false}
            subTeams={[]}
            members={[]}
          />,
        ),
      );
    });
    await flushStatistics();
  }

  it('omits the panel entirely when the flag left autoRoutingSavings off the payload', async () => {
    await renderResolved(baseUsage());
    expect(
      container.querySelector('[data-testid="auto-routing-savings"]'),
    ).toBeNull();
  });

  it('shows the four labelled estimates for the selected scope and range', async () => {
    await renderResolved(withAutoRoutingSavings());
    const panel = container.querySelector(
      '[data-testid="auto-routing-savings"]',
    );
    expect(panel).not.toBeNull();
    expect(
      container.querySelector('[data-testid="auto-routing-savings-benchmark"]')
        ?.textContent,
    ).toContain('Your usual model (est.)');
    expect(
      container.querySelector('[data-testid="auto-routing-savings-selected"]')
        ?.textContent,
    ).toContain('With model routing (est.)');
    expect(
      container.querySelector('[data-testid="auto-routing-savings-routing"]')
        ?.textContent,
    ).toContain('Cost of picking');
    expect(
      container.querySelector('[data-testid="auto-routing-savings-net"]')
        ?.textContent,
    ).toContain('Model routing savings (est.)');
  });

  it('states how many Auto turns were actually comparable', async () => {
    await renderResolved(withAutoRoutingSavings());
    const basis = container.querySelector(
      '[data-testid="auto-routing-savings-basis"]',
    );
    expect(basis?.textContent).toContain('9 of 12 routed turns');
  });

  it('renders an em dash rather than a fabricated zero for an unresolved figure', async () => {
    await renderResolved(
      withAutoRoutingSavings({
        netEstimatedSavingsUsd: null,
        routingCostUsd: null,
      }),
    );
    expect(
      container.querySelector('[data-testid="auto-routing-savings-net"]')
        ?.textContent,
    ).toContain('—');
    expect(
      container.querySelector('[data-testid="auto-routing-savings-routing"]')
        ?.textContent,
    ).toContain('—');
  });

  it('nests the backtest estimate inside the panel as an inset subpanel', async () => {
    await renderResolved(withAutoRoutingSavings());
    const panel = container.querySelector('[data-testid="auto-routing-panel"]');
    const backtest = panel?.querySelector(
      '[data-testid="routing-backtest-card"]',
    );
    expect(backtest).toBeInstanceOf(HTMLElement);
    expect(backtest?.getAttribute('data-variant')).toBe('inset');
    expect(
      container.querySelectorAll('[data-testid="routing-backtest-card"]'),
    ).toHaveLength(1);
  });

  it('keeps the backtest as its own card when there is no Auto usage to report', async () => {
    await renderResolved(baseUsage());
    expect(
      container.querySelector('[data-testid="auto-routing-panel"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="routing-backtest-card"]')
        ?.getAttribute('data-variant'),
    ).toBe('card');
  });
});
