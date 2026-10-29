/**
 * @jest-environment jsdom
 *
 * CAN-4072: the runs list is controlled, so a host can keep its own query and
 * filters (no Workflows view store), narrow the filters and replace the
 * empty-state copy.
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import {
  EMPTY_WORKFLOW_RUN_FILTERS,
  type WorkflowRunFilters,
  type WorkflowRunRow,
} from '@canopy/ui-app/workflows';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import { setNativeInputValue } from '@/test-utils/dom';
import { WorkflowRunsList } from '../runs/WorkflowRunsList';

jest.mock('@canopy/app-state', () => ({
  useCapabilities: (): { automations: boolean; watchers: boolean } => ({
    automations: true,
    watchers: true,
  }),
}));

const STARTED = Date.parse('2026-10-12T10:00:00.000Z');

function execution(id: string, name: string): ExecutionSummary {
  return {
    id,
    pipeline_id: id,
    pipeline_name: name,
    status: 'failure',
    status_reasons: [],
    started_at: '2026-10-12T10:00:00.000Z',
    cwd: '/tmp',
  };
}

function pipelineRow(id: string, name: string): WorkflowRunRow {
  return {
    kind: 'pipeline',
    key: `pipeline-run:${id}`,
    name,
    status: 'failure',
    startedAt: STARTED,
    endedAt: STARTED + 60_000,
    actions: ['retry'],
    result: { available: true },
    summary: execution(id, name),
  };
}

const ROWS: readonly WorkflowRunRow[] = [
  pipelineRow('exec-release', 'Release'),
  pipelineRow('exec-review', 'Review'),
];

describe('WorkflowRunsList', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onOpen = jest.fn<void, [WorkflowRunRow]>();

  /** A host that keeps its query and filters in local state. */
  function LocalHost({
    rows,
    emptyState,
  }: {
    rows: readonly WorkflowRunRow[];
    emptyState?: JSX.Element;
  }): JSX.Element {
    const [query, setQuery] = useState('');
    const [filters, setFilters] = useState<WorkflowRunFilters>(
      EMPTY_WORKFLOW_RUN_FILTERS,
    );
    return (
      <WorkflowRunsList
        rows={rows}
        loading={false}
        query={query}
        onQueryChange={setQuery}
        filters={filters}
        onFiltersChange={setFilters}
        kinds={[]}
        onOpen={onOpen}
        onAction={jest.fn()}
        hasMore={false}
        loadingMore={false}
        onLoadMore={jest.fn()}
        emptyState={emptyState}
      />
    );
  }

  function render(element: JSX.Element): void {
    act(() => {
      root.render(element);
    });
  }

  function byTestId(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  function rowKeys(): string[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="workflows-run-row"]',
      ),
    ).map((row) => row.dataset.runKey ?? '');
  }

  function typeQuery(value: string): void {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="workflows-runs-search"] input, input[data-testid="workflows-runs-search"]',
    );
    if (!input) throw new Error('No search field');
    act(() => setNativeInputValue(input, value));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    useWorkflowsViewStore.setState({
      runsQuery: '',
      runsFilters: EMPTY_WORKFLOW_RUN_FILTERS,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('searches with local state and leaves the Workflows view store alone', () => {
    render(<LocalHost rows={ROWS} />);
    expect(rowKeys()).toEqual([
      'pipeline-run:exec-release',
      'pipeline-run:exec-review',
    ]);
    // One kind offered: no Kind menu.
    expect(byTestId('workflows-runs-filter-kind')).toBeNull();

    typeQuery('Review');

    expect(rowKeys()).toEqual(['pipeline-run:exec-review']);
    expect(useWorkflowsViewStore.getState().runsQuery).toBe('');
  });

  it('shows No runs match with Clear filters when the search hides every row', () => {
    render(<LocalHost rows={ROWS} />);
    typeQuery('nothing like this');
    expect(byTestId('workflows-runs-no-matches')).not.toBeNull();

    act(() => {
      byTestId('workflows-runs-clear-filters')?.click();
    });

    expect(rowKeys()).toHaveLength(2);
  });

  it("renders the host's empty state when there are no runs", () => {
    render(
      <LocalHost
        rows={[]}
        emptyState={<p data-testid="custom-empty">No runs of this pipeline.</p>}
      />,
    );
    expect(byTestId('custom-empty')).not.toBeNull();
    expect(byTestId('workflows-runs-empty')).toBeNull();
    // Nothing to search yet.
    expect(byTestId('workflows-runs-toolbar')).toBeNull();
  });

  it('opens a row through the host handler', () => {
    render(<LocalHost rows={ROWS} />);
    const row = container.querySelector<HTMLElement>(
      '[data-testid="workflows-run-row"][data-run-key="pipeline-run:exec-review"]',
    );
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'pipeline-run:exec-review' }),
    );
  });
});
