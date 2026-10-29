/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * CAN-3383 People-tab host: the leaderboards hint appears above the Impact
 * leaderboard only for organization scope, only once BOTH the usage payload
 * and the viewer's status have loaded, and only when the loaded leaderboard
 * does not already include the viewer.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  TeamUsageResponse,
  TelemetryUserLeaderboardRow,
} from '@canopy/protocol/telemetry';
import type { ViewerDataSharingLoadState } from '../../use-viewer-data-sharing';
import { TestSettingsHost } from '../../../__tests__/helpers/test-settings-host';
import {
  createStatisticsTestHost,
  type StatisticsTestHost,
} from './helpers/statistics-host';

// Answers `organization.statistics.usage` through the fake settings client.
const readUsage = jest.fn<Promise<TeamUsageResponse>, [unknown]>();

const mockUseViewerDataSharing = jest.fn<
  ViewerDataSharingLoadState,
  [string | null]
>();
jest.mock('../../use-viewer-data-sharing', () => ({
  useViewerDataSharing: (orgId: string | null): ViewerDataSharingLoadState =>
    mockUseViewerDataSharing(orgId),
}));

jest.mock('../RoutingBacktestCard', () => ({
  RoutingBacktestCard: (): null => null,
}));

import { TeamStatisticsSection } from '../TeamStatisticsSection';

let statsHost: StatisticsTestHost;
function setMockParams(queryString: string): void {
  statsHost.setParams(queryString);
}

const ORG_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';
const VIEWER = '0d9e8f7a-6b5c-4d3e-9f1a-2b3c4d5e6f70';
const TEAMMATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HINT = '[data-testid="data-sharing-opt-in-leaderboards"]';

const PRIVATE_PLANS: ViewerDataSharingLoadState = {
  state: 'ready',
  status: {
    viewerUserId: VIEWER,
    scopes: {
      metadata: 'shared',
      plans: 'private',
      summaries: 'unknown',
      transcripts: 'unknown',
    },
  },
};

function row(userId: string): TelemetryUserLeaderboardRow {
  return {
    userId,
    userName: 'Someone',
    impactScore: 1,
    prImpactRaw: 1,
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
    prsMerged: 1,
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
  };
}

function usage(
  byUser: TelemetryUserLeaderboardRow[],
  overrides: Partial<TeamUsageResponse> = {},
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
    impactByUser: [],
    pipelines: [],
    mostExpensiveRuns: [],
    ...overrides,
  };
}

describe('TeamStatisticsSection People-tab data-sharing hint', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    statsHost = createStatisticsTestHost({
      pathname: '/organization/org/statistics',
      usage: (input) => readUsage(input),
    });
    setMockParams('tab=people');
    mockUseViewerDataSharing.mockReturnValue(PRIVATE_PLANS);
    readUsage.mockResolvedValue(usage([row(TEAMMATE)]));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(): Promise<void> {
    act(() => {
      root.render(
        <TestSettingsHost host={statsHost.host}>
          <TeamStatisticsSection
            orgId={ORG_ID}
            organizationName="Acme"
            mobileBrowser={false}
            subTeams={[{ id: 'team-1', name: 'Core', memberCount: 1 }]}
            members={[]}
          />
        </TestSettingsHost>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function hint(): HTMLElement | null {
    return container.querySelector(HINT);
  }

  it('sits directly above the Impact leaderboard when the viewer is absent', async () => {
    await render();
    const element = hint();
    expect(element).not.toBeNull();
    expect(element?.nextElementSibling?.textContent).toContain(
      'Impact leaderboard',
    );
  });

  it('stays hidden when the loaded leaderboard already includes the viewer', async () => {
    readUsage.mockResolvedValue(
      usage([row(TEAMMATE), row(VIEWER.toUpperCase())]),
    );
    await render();
    expect(container.querySelector('[data-testid="people-table"]')).not.toBe(
      null,
    );
    expect(hint()).toBeNull();
  });

  it('waits for usage: loading is not absence', async () => {
    readUsage.mockReturnValue(new Promise<never>(() => undefined));
    await render();
    expect(container.querySelector('[data-testid="usage-loading"]')).not.toBe(
      null,
    );
    expect(hint()).toBeNull();
  });

  it('waits for the viewer status', async () => {
    mockUseViewerDataSharing.mockReturnValue({ state: 'loading' });
    await render();
    expect(container.querySelector('[data-testid="people-table"]')).not.toBe(
      null,
    );
    expect(hint()).toBeNull();
  });

  it('never shows for team scope', async () => {
    setMockParams('tab=people&scope=team&team=team-1');
    readUsage.mockResolvedValue(
      usage([row(TEAMMATE)], { scope: 'team', teamId: 'team-1' }),
    );
    await render();
    expect(container.querySelector('[data-testid="people-table"]')).not.toBe(
      null,
    );
    expect(hint()).toBeNull();
  });

  it('never shows under a person filter', async () => {
    setMockParams(`tab=people&user=${TEAMMATE}`);
    readUsage.mockResolvedValue(
      usage([row(TEAMMATE)], { filterUserId: TEAMMATE }),
    );
    await render();
    expect(hint()).toBeNull();
  });

  it('only appears on the People tab', async () => {
    setMockParams('');
    await render();
    expect(hint()).toBeNull();
  });
});
