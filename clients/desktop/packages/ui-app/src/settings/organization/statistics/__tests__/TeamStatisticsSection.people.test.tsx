/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  TeamUsageResponse,
  TelemetryImpactBucket,
  TelemetryUserLeaderboardRow,
} from '@canopy/protocol/telemetry';

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

// View state (including the active tab) lives in the URL. The host's
// `router.replace` writes the search params `useSearchParams` reads back;
// tests re-render after an interaction to reflect the new URL.
let statsHost: StatisticsTestHost;

function setMockParams(queryString: string): void {
  statsHost.setParams(queryString);
}

function withHost(element: JSX.Element): JSX.Element {
  return <TestSettingsHost host={statsHost.host}>{element}</TestSettingsHost>;
}

beforeEach(() => {
  statsHost = createStatisticsTestHost({
    usage: (input) => readUsage(input),
  });
});

function makeRow(
  overrides: Partial<TelemetryUserLeaderboardRow>,
): TelemetryUserLeaderboardRow {
  return {
    userId: null,
    userName: null,
    impactScore: 0,
    prImpactRaw: 0,
    deliveryImpactRaw: 0,
    executionBonus: 0,
    agentWorkBonus: 0,
    agentTurns: 0,
    agentWorkUnits: 0,
    deliveryEntries: 0,
    deliveryArtifacts: 0,
    deliveryExternalActions: 0,
    deliveryEntriesWithTicket: 0,
    deliveryEntriesDone: 0,
    deliverySharedRuns: 0,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    turnCount: 0,
    toolUseCount: 0,
    worktreesCreated: 0,
    plansCreated: 0,
    plansImplemented: 0,
    prsCreated: 0,
    prsMerged: 0,
    prsOpen: 0,
    linesChanged: 0,
    changedFiles: 0,
    avgCycleTimeMs: 0,
    checksPassing: 0,
    checksDecided: 0,
    avgPrSize: 0,
    prsWithTicket: 0,
    pipelineAgentSteps: 0,
    pipelineRuns: 0,
    pipelineRunsSucceeded: 0,
    pipelineRunsFailed: 0,
    pipelineRunsCancelled: 0,
    pipelineDistinctPipelines: 0,
    pipelineRetries: 0,
    pipelineAvgRunMs: 0,
    ...overrides,
  };
}

function makeUsage(
  byUser: TelemetryUserLeaderboardRow[],
  impactByUser: TelemetryImpactBucket[] = [],
): TeamUsageResponse {
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
    costByProvider: [],
    costByModel: [],
    toolCategoryTotals: [],
    eventTypeStatusCounts: [],
    byUser,
    impactByUser,
    pipelines: [],
    mostExpensiveRuns: [],
  };
}

describe('TeamStatisticsSection People tab', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    setMockParams('');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    readUsage.mockReset();
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
    // Flush the resolved usage read and the lazy chart chunk.
    await flushStatistics();
  }

  // Re-render after an interaction so the tree reflects the URL that `replace`
  // just wrote (a fresh element forces reconciliation).
  function reflectUrl(): void {
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
  }

  function selectPeopleTab(): void {
    const tab = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-metric-tab-people"]',
    );
    act(() => {
      tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    reflectUrl();
  }

  it('leads with the Impact column and sorts by impact score descending', async () => {
    await renderResolved(
      makeUsage([
        makeRow({ userId: 'u-low', userName: 'Low', impactScore: 2 }),
        makeRow({ userId: 'u-high', userName: 'High', impactScore: 42 }),
      ]),
    );
    selectPeopleTab();

    const headers = Array.from(
      container.querySelectorAll('[data-testid="people-table"] thead tr'),
    );
    // Two header rows: groups then columns.
    expect(headers).toHaveLength(2);
    const groupLabels = Array.from(headers[0].querySelectorAll('th')).map(
      (th) => th.textContent,
    );
    expect(groupLabels).toEqual([
      'Person',
      'Impact',
      'Activity',
      'Tickets',
      'Usage',
    ]);

    const firstRowName = container.querySelector(
      '[data-testid="people-table"] tbody tr td:first-child',
    )?.textContent;
    expect(firstRowName).toBe('High');
  });

  it('labels the tab "People" and renders the impact chart above the table', async () => {
    await renderResolved(
      makeUsage(
        [makeRow({ userId: 'u-1', userName: 'Ada', impactScore: 6 })],
        [
          {
            bucketStartIso: '2026-06-02T00:00:00.000Z',
            key: 'Ada',
            impactScore: 6,
          },
        ],
      ),
    );

    const tab = container.querySelector(
      '[data-testid="usage-metric-tab-people"]',
    );
    expect(tab?.textContent).toBe('People');

    selectPeopleTab();

    // The stacked impact chart renders for the People tab.
    expect(
      container.querySelector('[data-testid="stacked-time-series"]'),
    ).not.toBeNull();
    // And the leaderboard table is still present.
    expect(
      container.querySelector('[data-testid="people-table"]'),
    ).not.toBeNull();
  });

  it('defaults to the compact columns and expands to all columns on toggle', async () => {
    await renderResolved(
      makeUsage([makeRow({ userId: 'u-1', userName: 'Ada', impactScore: 6 })]),
    );
    selectPeopleTab();

    // Compact view: a kept column is present, a pruned one is not.
    expect(
      container.querySelector('[data-testid="people-table-sort-prsMerged"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="people-table-sort-tokens"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="people-table-sort-worktrees"]'),
    ).toBeNull();

    // Expand to all columns.
    const expand = container.querySelector<HTMLButtonElement>(
      '[data-testid="people-columns-detailed"]',
    );
    act(() => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Detailed view: the pruned columns now render.
    expect(
      container.querySelector('[data-testid="people-table-sort-tokens"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="people-table-sort-worktrees"]'),
    ).not.toBeNull();
  });

  it('shows the Agent turns column in both Summary and Detailed views', async () => {
    await renderResolved(
      makeUsage([
        makeRow({
          userId: 'u-1',
          userName: 'Ada',
          impactScore: 6,
          agentTurns: 1234,
          pipelineRuns: 2,
          pipelineAgentSteps: 900,
        }),
      ]),
    );
    selectPeopleTab();

    // Summary (compact) view keeps the Agent turns column.
    expect(
      container.querySelector('[data-testid="people-table-sort-agentTurns"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="people-table"] tbody')
        ?.textContent,
    ).toContain('1,234');

    // Still present after expanding to the detailed column set.
    const expand = container.querySelector<HTMLButtonElement>(
      '[data-testid="people-columns-detailed"]',
    );
    act(() => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container.querySelector('[data-testid="people-table-sort-agentTurns"]'),
    ).not.toBeNull();

    // Declared agent steps survive only as a pipeline-shape stat in the
    // Detailed-only Pipelines breakdown — never on the People leaderboard.
    expect(
      container.querySelector('[data-testid="people-table-sort-agentSteps"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="people-table"] thead')
        ?.textContent,
    ).not.toContain('Agent steps');
    expect(
      container.querySelector(
        '[data-testid="people-pipelines-table-sort-agentSteps"]',
      ),
    ).not.toBeNull();
  });

  it('renders Turns / unit and Billed turns only in the Detailed view', async () => {
    await renderResolved(
      makeUsage([
        makeRow({
          userId: 'u-1',
          userName: 'Ada',
          impactScore: 6,
          agentTurns: 90,
          prsMerged: 4,
          deliveryEntries: 2,
          turnCount: 321,
        }),
      ]),
    );
    selectPeopleTab();

    // Both are detailed-only.
    expect(
      container.querySelector('[data-testid="people-table-sort-turnsPerUnit"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="people-table-sort-billedTurns"]'),
    ).toBeNull();

    const expand = container.querySelector<HTMLButtonElement>(
      '[data-testid="people-columns-detailed"]',
    );
    act(() => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(
      container.querySelector('[data-testid="people-table-sort-turnsPerUnit"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="people-table-sort-billedTurns"]'),
    ).not.toBeNull();

    const bodyText =
      container.querySelector('[data-testid="people-table"] tbody')
        ?.textContent ?? '';
    // 90 turns / (4 merged PRs + 2 work items) = 15.
    expect(bodyText).toContain('15');
    // Billed turns keeps the unfiltered `turnCount` from the usage query.
    expect(bodyText).toContain('321');
  });

  it('renders an em dash for Turns / unit when nothing was delivered', async () => {
    await renderResolved(
      makeUsage([
        makeRow({
          userId: 'u-1',
          userName: 'Ada',
          impactScore: 6,
          agentTurns: 40,
          prsMerged: 0,
          deliveryEntries: 0,
        }),
      ]),
    );
    selectPeopleTab();

    const expand = container.querySelector<HTMLButtonElement>(
      '[data-testid="people-columns-detailed"]',
    );
    act(() => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const cells = Array.from(
      container.querySelectorAll('[data-testid="people-table"] tbody td'),
    );
    const headers = Array.from(
      container.querySelectorAll('[data-testid="people-table"] thead tr'),
    )[1];
    const index = Array.from(headers.querySelectorAll('th')).findIndex(
      (th) =>
        th.querySelector('[data-testid="people-table-sort-turnsPerUnit"]') !==
        null,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(cells[index]?.textContent).toBe('—');
  });

  it('keeps only Work items from the delivery block in the compact view', async () => {
    await renderResolved(
      makeUsage([
        makeRow({
          userId: 'u-1',
          userName: 'Dana',
          impactScore: 25.7,
          deliveryEntries: 25,
          deliveryArtifacts: 412,
          deliverySharedRuns: 3,
        }),
      ]),
    );
    selectPeopleTab();

    const compactHeaderRows = Array.from(
      container.querySelectorAll('[data-testid="people-table"] thead tr'),
    );
    // Merge rate is detailed-only, so the compact body is 8 columns and the
    // group spans must still sum to it (1 + 1 + 4 + 1 + 1 = 8).
    expect(compactHeaderRows[1].querySelectorAll('th')).toHaveLength(8);
    expect(
      Array.from(compactHeaderRows[0].querySelectorAll('th')).map((th) =>
        Number(th.getAttribute('colspan') ?? '1'),
      ),
    ).toEqual([1, 1, 4, 1, 1]);
    expect(
      container.querySelector('[data-testid="people-table-sort-mergeRate"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="people-table-sort-deliveryEntries"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="people-table-sort-deliveryArtifacts"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="people-table-sort-deliverySharedRuns"]',
      ),
    ).toBeNull();

    // Expand → all three delivery columns render, and the group spans stay in
    // lockstep with the column count (1 + 1 + 13 + 2 + 1 + 4 = 22). Activity
    // holds at 13: `turnsPerUnit` joined it as `turns` moved to Usage (as
    // `billedTurns`), which is why Usage went 3 → 4.
    const expand = container.querySelector<HTMLButtonElement>(
      '[data-testid="people-columns-detailed"]',
    );
    act(() => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const headerRows = Array.from(
      container.querySelectorAll('[data-testid="people-table"] thead tr'),
    );
    expect(headerRows[1].querySelectorAll('th')).toHaveLength(22);
    expect(
      Array.from(headerRows[0].querySelectorAll('th')).map((th) =>
        Number(th.getAttribute('colspan') ?? '1'),
      ),
    ).toEqual([1, 1, 13, 2, 1, 4]);
    expect(
      container.querySelector(
        '[data-testid="people-table-sort-deliveryArtifacts"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="people-table-sort-deliverySharedRuns"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="people-table-sort-mergeRate"]'),
    ).not.toBeNull();
  });

  it('sorts by Work items', async () => {
    await renderResolved(
      makeUsage([
        makeRow({
          userId: 'u-few',
          userName: 'Few',
          impactScore: 40,
          deliveryEntries: 2,
        }),
        makeRow({
          userId: 'u-many',
          userName: 'Many',
          impactScore: 1,
          deliveryEntries: 25,
        }),
      ]),
    );
    selectPeopleTab();

    // Default sort is Impact desc, so the low-delivery user leads.
    expect(
      container.querySelector(
        '[data-testid="people-table"] tbody tr td:first-child',
      )?.textContent,
    ).toBe('Few');

    const sortByEntries = container.querySelector<HTMLButtonElement>(
      '[data-testid="people-table-sort-deliveryEntries"]',
    );
    act(() => {
      sortByEntries?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(
      container.querySelector(
        '[data-testid="people-table"] tbody tr td:first-child',
      )?.textContent,
    ).toBe('Many');
  });

  it('renders the per-user Pipelines section only in the Detailed view', async () => {
    await renderResolved(
      makeUsage([
        makeRow({
          userId: 'u-1',
          userName: 'Ada',
          impactScore: 6,
          pipelineRuns: 4,
          pipelineRunsSucceeded: 3,
          pipelineRunsFailed: 1,
          pipelineAgentSteps: 900,
        }),
        makeRow({
          userId: 'u-2',
          userName: 'Grace',
          impactScore: 2,
          pipelineRuns: 0,
        }),
      ]),
    );
    selectPeopleTab();

    // Summary view: no Pipelines breakdown table.
    expect(
      container.querySelector('[data-testid="people-pipelines-table"]'),
    ).toBeNull();

    // Expand to Detailed → the Pipelines section renders.
    const expand = container.querySelector<HTMLButtonElement>(
      '[data-testid="people-columns-detailed"]',
    );
    act(() => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const pipelinesTable = container.querySelector(
      '[data-testid="people-pipelines-table"]',
    );
    expect(pipelinesTable).not.toBeNull();

    // Only users with completed runs appear; the zero-run user is filtered out.
    const bodyText =
      container.querySelector('[data-testid="people-pipelines-table"] tbody')
        ?.textContent ?? '';
    expect(bodyText).toContain('Ada');
    expect(bodyText).not.toContain('Grace');
  });

  it('renders an em dash for rate cells with no denominator and links members', async () => {
    await renderResolved(
      makeUsage([
        makeRow({
          userId: 'u-1',
          userName: 'Solo',
          impactScore: 5,
          prsCreated: 0,
        }),
      ]),
    );
    selectPeopleTab();

    const link = container.querySelector<HTMLAnchorElement>(
      '[data-testid="member-profile-link"]',
    );
    expect(link?.textContent).toBe('Solo');
    expect(link?.getAttribute('href')).toContain('org-1');

    // Merge-rate (prsMerged/prsCreated) has a zero denominator → em dash.
    const bodyText =
      container.querySelector('[data-testid="people-table"] tbody')
        ?.textContent ?? '';
    expect(bodyText).toContain('—');
  });

  it('keeps member names out of session replay when the host blocks them', async () => {
    statsHost = createStatisticsTestHost({
      usage: (input) => readUsage(input),
      privacy: { blockClassName: 'replay-block', maskClassName: 'replay-mask' },
    });
    readUsage.mockResolvedValue(
      makeUsage(
        [
          makeRow({ userId: 'u-1', userName: 'Ada', impactScore: 3 }),
          makeRow({ userId: null, userName: 'Former member', impactScore: 1 }),
        ],
        [
          {
            bucketStartIso: '2026-06-02T00:00:00.000Z',
            key: 'Ada',
            impactScore: 3,
          },
        ],
      ),
    );
    setMockParams('tab=people');
    act(() => {
      root.render(
        withHost(
          <TeamStatisticsSection
            orgId="org-1"
            organizationName="Acme"
            mobileBrowser={false}
            subTeams={[]}
            members={[
              {
                id: 'u-1',
                name: 'Ada',
                email: 'ada@example.com',
                image: null,
                role: 'MEMBER',
                subTeamIds: [],
              },
            ]}
          />,
        ),
      );
    });
    await flushStatistics();

    const link = container.querySelector<HTMLAnchorElement>(
      '[data-testid="member-profile-link"]',
    );
    expect(link?.className).toBe(
      'font-medium fg-accent hover:underline replay-block',
    );
    const unlinked = Array.from(
      container.querySelectorAll('[data-testid="people-table"] tbody span'),
    ).find((element) => element.textContent === 'Former member');
    expect(unlinked?.className).toBe('replay-block');
    // The impact chart's legend names each member.
    expect(
      container.querySelector('[data-testid="stacked-time-series"]')?.classList,
    ).toContain('replay-block');

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-filters-trigger"]',
    );
    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container.querySelector(
        '[data-testid="usage-user-select"] .replay-block',
      ),
    ).toBeInstanceOf(HTMLElement);
  });

  it('adds no stray class token to member links without replay privacy', async () => {
    await renderResolved(
      makeUsage([makeRow({ userId: 'u-1', userName: 'Ada', impactScore: 3 })]),
    );
    selectPeopleTab();
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-testid="member-profile-link"]',
    );
    expect(link?.className).toBe('font-medium fg-accent hover:underline');
  });
});

describe('TeamStatisticsSection Overview tab', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    setMockParams('');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    readUsage.mockReset();
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

  it('folds the observed-cost surface onto the default Overview tab', async () => {
    const usage: TeamUsageResponse = {
      ...makeUsage([]),
      costByProvider: [
        {
          bucketStartIso: '2026-06-02T00:00:00.000Z',
          key: 'anthropic',
          totalCostUsd: 12.34,
        },
      ],
    };
    await renderResolved(usage);

    // Overview is the default tab and now renders the observed-cost controls
    // (moved off the removed dedicated tab).
    expect(
      container
        .querySelector('[data-testid="usage-metric-tab-overview"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      container.querySelector('[data-testid="cost-dim-toggle"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="cost-breakdown-table"]'),
    ).not.toBeNull();

    // "Most expensive runs" no longer renders on Overview.
    expect(
      container.querySelector('[data-testid="team-statistics-section"]')
        ?.textContent,
    ).not.toContain('Most expensive runs');
  });
});
