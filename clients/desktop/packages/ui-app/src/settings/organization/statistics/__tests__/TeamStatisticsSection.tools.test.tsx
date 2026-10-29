/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TeamUsageResponse } from '@canopy/protocol/telemetry';
import { TestSettingsHost } from '../../../__tests__/helpers/test-settings-host';
import {
  createStatisticsTestHost,
  flushStatistics,
} from './helpers/statistics-host';

const readUsage = jest.fn<Promise<TeamUsageResponse>, [unknown]>();

// The section loads the charts chunk lazily; the stub replaces that chunk and
// records when it is first evaluated.
const mockChartsLoaded = jest.fn();
jest.mock('../charts', () => {
  mockChartsLoaded();
  return {
    CategoryBarChart: ({
      data,
    }: {
      data: ReadonlyArray<{ label: string; value: number }>;
    }): JSX.Element => (
      <div data-testid="category-labels">
        {data.map((row) => (
          <span key={row.label}>{row.label}</span>
        ))}
      </div>
    ),
    StackedTimeSeriesChart: (): null => null,
  };
});

import { TeamStatisticsSection } from '../TeamStatisticsSection';

function usage(): TeamUsageResponse {
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
    toolCategoryTotals: [{ toolCategory: 'CANOPY', total: 7 }],
    eventTypeStatusCounts: [],
    byUser: [],
    impactByUser: [],
    pipelines: [],
    mostExpensiveRuns: [],
  };
}

describe('TeamStatisticsSection Tools tab', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    readUsage.mockResolvedValue(usage());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    readUsage.mockReset();
  });

  it('keeps recharts out of the statistics entry until a chart renders', () => {
    // Importing the section (above) must not evaluate the charts chunk.
    expect(mockChartsLoaded).not.toHaveBeenCalled();
  });

  it('renders the legacy first-party telemetry category as Built-in', async () => {
    const statsHost = createStatisticsTestHost({
      usage: (input) => readUsage(input),
    });
    statsHost.setParams('tab=tools');
    act(() => {
      root.render(
        <TestSettingsHost host={statsHost.host}>
          <TeamStatisticsSection
            orgId="org-1"
            organizationName="Acme"
            mobileBrowser={false}
            subTeams={[]}
            members={[]}
          />
        </TestSettingsHost>,
      );
    });
    await flushStatistics();

    expect(mockChartsLoaded).toHaveBeenCalledTimes(1);
    const labels = container.querySelector('[data-testid="category-labels"]');
    expect(labels?.textContent).toBe('Built-in');
    expect(labels?.textContent).not.toContain('Canopy');
  });
});
