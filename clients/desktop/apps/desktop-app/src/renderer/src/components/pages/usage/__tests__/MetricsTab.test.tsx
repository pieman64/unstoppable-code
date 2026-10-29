/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  UsageMetricsViewResponse,
  UsageTabSummaryResponse,
  UsageTimeseriesResponse,
} from '@canopy/desktop-shared/types';
import { MetricsTab } from '../MetricsTab';
import { COST_TAB_SPEC, WORKTREES_TAB_SPEC } from '../tab-specs';

jest.mock('@/components/shared/loading', () => ({
  RefreshSpinner: (): JSX.Element => <span data-testid="spinner" />,
}));

jest.mock('@/components/shared/StatusBlocks', () => ({
  LoadingPlaceholder: (): JSX.Element => <div data-testid="placeholder" />,
}));

// Mock the chart subcomponents so the test doesn't need recharts to render
jest.mock('../MetricsChart', () => ({
  MetricsChart: (): JSX.Element => <div data-testid="metrics-chart" />,
}));

jest.mock('../MetricsBreakdownPanel', () => ({
  MetricsBreakdownPanel: (): JSX.Element => (
    <div data-testid="metrics-breakdown" />
  ),
}));

const loadTabSummary = jest.fn<Promise<UsageTabSummaryResponse>, []>();
const loadMetricsView = jest.fn<Promise<UsageMetricsViewResponse>, []>();
const loadTimeseries = jest.fn<Promise<UsageTimeseriesResponse>, []>();

jest.mock('@/stores/observabilityStore', () => ({
  useObservabilityStore: (selector: (state: unknown) => unknown): unknown =>
    selector({
      loadUsageTabSummary: loadTabSummary,
      loadUsageMetricsView: loadMetricsView,
      loadUsageTimeseries: loadTimeseries,
    }),
}));

function render(node: ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

beforeEach(() => {
  loadTabSummary.mockReset();
  loadMetricsView.mockReset();
  loadTimeseries.mockReset();
});

describe('MetricsTab', () => {
  test('renders headline cards after summary loads', async () => {
    loadTabSummary.mockResolvedValue({
      tab: 'worktrees',
      cards: [
        { key: 'created', last7d: 5, prior7d: 3, allTime: 50 },
        { key: 'merged', last7d: 2, prior7d: 0, allTime: 10 },
        {
          key: 'deleted_with_changes',
          last7d: 1,
          prior7d: 0,
          allTime: 4,
        },
        {
          key: 'deleted_without_changes',
          last7d: 0,
          prior7d: 0,
          allTime: 2,
        },
      ],
      earliestEventAt: '2026-03-04T00:00:00.000Z',
      resolvedWindows: {
        last7d: { start: '', end: '' },
        prior7d: { start: '', end: '' },
        allTime: { start: '', end: '' },
      },
    });

    const { container } = render(
      <MetricsTab spec={WORKTREES_TAB_SPEC} retentionDays={7} />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Created');
    expect(container.textContent).toContain('5');
    expect(loadTabSummary).toHaveBeenCalledWith({ tab: 'worktrees' });
  });

  test('shows error state when summary load fails', async () => {
    loadTabSummary.mockRejectedValue(new Error('network down'));

    const { container } = render(
      <MetricsTab spec={WORKTREES_TAB_SPEC} retentionDays={7} />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('network down');
  });

  test('renders the Codex cost estimate notice on the cost tab', async () => {
    loadTabSummary.mockResolvedValue({
      tab: 'cost',
      cards: [],
      earliestEventAt: '2026-03-04T00:00:00.000Z',
      resolvedWindows: {
        last7d: { start: '', end: '' },
        prior7d: { start: '', end: '' },
        allTime: { start: '', end: '' },
      },
    });

    const { container } = render(
      <MetricsTab spec={COST_TAB_SPEC} retentionDays={7} />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const notice = container.querySelector('[role="note"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Codex cost is an estimate');
    const toggle = notice?.querySelector('button');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.querySelector('svg')).not.toBeNull();
    expect(notice?.textContent).not.toContain(
      'approximated from token usage and billable tool calls',
    );

    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(notice?.textContent).toContain(
      'approximated from token usage and billable tool calls',
    );
    expect(notice?.textContent).toContain(
      'Models without published API pricing are excluded from cost totals',
    );

    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(notice?.textContent).toContain('Codex cost is an estimate');
    expect(notice?.textContent).not.toContain(
      'approximated from token usage and billable tool calls',
    );
  });

  test('does not render the Codex pricing notice on non-cost tabs', async () => {
    loadTabSummary.mockResolvedValue({
      tab: 'worktrees',
      cards: [],
      earliestEventAt: '2026-03-04T00:00:00.000Z',
      resolvedWindows: {
        last7d: { start: '', end: '' },
        prior7d: { start: '', end: '' },
        allTime: { start: '', end: '' },
      },
    });

    const { container } = render(
      <MetricsTab spec={WORKTREES_TAB_SPEC} retentionDays={7} />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[role="note"]')).toBeNull();
    expect(container.textContent).not.toContain('Codex cost is an estimate');
  });
});
