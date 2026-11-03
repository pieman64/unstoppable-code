/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import {
  EMPTY_WORKFLOW_LIBRARY_FILTERS,
  EMPTY_WORKFLOW_RUN_FILTERS,
  type WorkflowLibraryRow,
  type WorkflowRunRow,
} from '@canopy/ui-app/workflows';
import { useExecutionFeedStore } from '@/lib/workflows/execution-feed';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import type { WorkflowLibraryTarget } from '../library/useWorkflowLibraryRows';
import type { WorkflowRunFeed } from '../runs/useWorkflowRunFeed';
import { WorkflowsRunsTab } from '../runs/WorkflowsRunsTab';

const mockExecutionActions = {
  cancel: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
  retry: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
  rerun: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
  dialogs: null,
  dialogAnchorRef: { current: null },
};
const mockOpenExecution = jest.fn<Promise<void>, [{ executionId: string }]>(
  () => Promise.resolve(),
);

jest.mock('@canopy/app-state', () => ({
  useCapabilities: (): { automations: boolean; watchers: boolean } => ({
    automations: true,
    watchers: true,
  }),
}));
jest.mock('../../activity/usePipelineExecutionActions', () => ({
  usePipelineExecutionActions: (): typeof mockExecutionActions =>
    mockExecutionActions,
}));
jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (request: {
    executionId: string;
  }): Promise<void> => mockOpenExecution(request),
}));
jest.mock('../../watchers/WatcherManagementModal', () => ({
  WatcherManagementModal: (): null => null,
}));

const STARTED = Date.parse('2026-10-12T10:00:00.000Z');

function execution(
  id: string,
  status: ExecutionSummary['status'],
): ExecutionSummary {
  return {
    id,
    pipeline_id: 'release',
    pipeline_name: 'Release',
    status,
    status_reasons: [],
    started_at: '2026-10-12T10:00:00.000Z',
    cwd: '/tmp',
  };
}

const failed = execution('exec-failed', 'failure');
const running = execution('exec-running', 'running');

const ROWS: readonly WorkflowRunRow[] = [
  {
    kind: 'pipeline',
    key: 'pipeline-run:exec-running',
    name: 'Release',
    status: 'running',
    startedAt: STARTED,
    actions: ['cancel'],
    result: { available: true },
    summary: running,
  },
  {
    kind: 'pipeline',
    key: 'pipeline-run:exec-failed',
    name: 'Release',
    status: 'failure',
    startedAt: STARTED,
    endedAt: STARTED + 60_000,
    actions: ['retry', 'rerun', 'hide'],
    result: { available: true },
    summary: failed,
  },
  {
    kind: 'watcher',
    key: 'watcher:w-1',
    watcherId: 'w-1',
    name: 'PR merged',
    status: 'watching',
    state: 'watching',
    startedAt: STARTED,
    actions: ['inspect', 'cancel'],
    result: { available: true },
  },
];

describe('WorkflowsRunsTab', () => {
  let container: HTMLDivElement;
  let root: Root;
  const deleteWatcher = jest.fn();
  const setExecutionHidden = jest.fn();

  function feed(): WorkflowRunFeed {
    const watcher = { id: 'w-1', label: 'PR merged' };
    return {
      rows: ROWS,
      activeCount: 2,
      executionsById: new Map([
        [failed.id, failed],
        [running.id, running],
      ]),
      runsById: new Map(),
      watchersById: new Map<string, AppAdvisorWatcherSummary>([
        // Only the id and label are read by the cancel dialog.
        ['w-1', Object.assign(Object.create(null), watcher)],
      ]),
      error: null,
      loading: false,
      hasMore: false,
      loadingMore: false,
      loadMoreFailed: false,
      loadMore: jest.fn(),
    };
  }

  function row(key: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(
      `[data-testid="workflows-run-row"][data-run-key="${key}"]`,
    );
    if (!found) throw new Error(`No run row ${key}`);
    return found;
  }

  function click(element: Element | null | undefined): void {
    if (!element) throw new Error('Nothing to click');
    act(() => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  function menuItem(key: string, action: string): Element | null {
    click(row(key).querySelector('[data-testid="workflows-run-menu"]'));
    return document.body.querySelector(
      `[data-testid="workflows-run-menu-item-${action}"]`,
    );
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    useWorkflowsViewStore.setState({
      runsQuery: '',
      runsFilters: EMPTY_WORKFLOW_RUN_FILTERS,
    });
    useExecutionFeedStore.setState({ executions: [failed, running] });
    useAppAdvisorWatchersStore.setState({ deleteWatcher });
    usePipelineRunsStore.setState({ setExecutionHidden });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<WorkflowsRunsTab feed={feed()} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("sends Cancel and Retry to the row's own execution", async () => {
    click(
      row('pipeline-run:exec-running').querySelector(
        '[data-testid="workflows-run-action-cancel"]',
      ),
    );
    await settle();
    expect(mockExecutionActions.cancel).toHaveBeenCalledWith('exec-running');

    click(
      row('pipeline-run:exec-failed').querySelector(
        '[data-testid="workflows-run-action-retry"]',
      ),
    );
    await settle();
    expect(mockExecutionActions.retry).toHaveBeenCalledWith('exec-failed');
    // Neither button opened the run.
    expect(mockOpenExecution).not.toHaveBeenCalled();
  });

  it('finishes a row action that throws, and frees the row', async () => {
    mockExecutionActions.retry.mockRejectedValueOnce(new Error('No runner'));
    const retry = (): Element | null =>
      row('pipeline-run:exec-failed').querySelector(
        '[data-testid="workflows-run-action-retry"]',
      );

    click(retry());
    await settle();
    await settle();

    // The row is no longer busy, so the action can be tried again.
    expect(retry()?.hasAttribute('disabled')).toBe(false);
  });

  it('reruns and hides a finished run from its menu', async () => {
    setExecutionHidden.mockResolvedValue({ success: true });

    click(menuItem('pipeline-run:exec-failed', 'rerun'));
    await settle();
    expect(mockExecutionActions.rerun).toHaveBeenCalledWith('exec-failed');

    click(menuItem('pipeline-run:exec-failed', 'hide'));
    await settle();
    expect(setExecutionHidden).toHaveBeenCalledWith('exec-failed', true);
    expect(
      useExecutionFeedStore
        .getState()
        .executions.find((entry) => entry.id === 'exec-failed')?.hidden,
    ).toBe(true);
  });

  it('opens a pipeline run when its row is clicked', () => {
    click(
      row('pipeline-run:exec-failed').querySelector(
        '[data-testid="workflows-run-name"]',
      ),
    );
    expect(mockOpenExecution).toHaveBeenCalledWith({
      executionId: 'exec-failed',
    });
  });

  it('cancels a watcher only after confirming, and closes the dialog', async () => {
    deleteWatcher.mockResolvedValue({ ok: true });
    click(
      row('watcher:w-1').querySelector(
        '[data-testid="workflows-run-action-cancel"]',
      ),
    );
    expect(deleteWatcher).not.toHaveBeenCalled();

    click(
      document.body.querySelector('[data-testid="confirm-dialog-confirm"]'),
    );
    await settle();
    expect(deleteWatcher).toHaveBeenCalledWith('w-1');
    expect(
      document.body.querySelector(
        '[data-testid="workflows-runs-cancel-watcher"]',
      ),
    ).toBeNull();
  });

  it('keeps the watcher dialog open with the reason when the cancel is rejected', async () => {
    deleteWatcher.mockRejectedValue(new Error('Watchers are unavailable.'));
    click(
      row('watcher:w-1').querySelector(
        '[data-testid="workflows-run-action-cancel"]',
      ),
    );
    click(
      document.body.querySelector('[data-testid="confirm-dialog-confirm"]'),
    );
    await settle();
    await settle();

    expect(
      document.body.querySelector('[data-testid="confirm-dialog-error"]')
        ?.textContent,
    ).toBe('Watchers are unavailable.');
    // No longer busy, so it can be tried again.
    expect(
      document.body
        .querySelector('[data-testid="confirm-dialog-confirm"]')
        ?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it("opens the Library on an automation's current name, not the run's", () => {
    useAutomationsStore.setState({
      // Only the id and name are read.
      activities: [
        Object.assign(Object.create(null), {
          id: 'a-1',
          name: 'Nightly check',
        }),
      ],
    });
    const renamed: WorkflowRunRow = {
      kind: 'automation',
      key: 'automation-run:r-1',
      runId: 'r-1',
      activityId: 'a-1',
      name: 'Dependency check',
      status: 'success',
      startedAt: STARTED,
      actions: ['open-library'],
      cancellable: false,
      result: { available: true },
    };
    act(() => {
      root.render(<WorkflowsRunsTab feed={{ ...feed(), rows: [renamed] }} />);
    });

    click(menuItem('automation-run:r-1', 'open-library'));

    expect(useWorkflowsViewStore.getState().libraryFilters.query).toBe(
      'Nightly check',
    );
  });

  describe('with no runs', () => {
    const builtIn: WorkflowLibraryRow = {
      key: 'pipeline:bundled:bundled-code-review',
      kind: 'pipeline',
      name: 'Code Review (Claude)',
      triggers: ['manual'],
      triggerText: 'Manual',
      steps: ['agent'],
      summary: '4 steps',
      source: 'built-in',
      sourceLabel: 'Built-in',
      actions: ['run', 'edit', 'view-runs', 'duplicate'],
    };
    const mine: WorkflowLibraryRow = {
      key: 'automation:a-1',
      kind: 'automation',
      name: 'Nightly check',
      triggers: ['schedule'],
      triggerText: 'Weekdays at 9:00 AM',
      steps: ['chat'],
      summary: 'Start chat in storefront',
      source: 'mine',
      enabled: true,
      actions: ['toggle', 'run', 'edit'],
    };
    const library = {
      rows: [builtIn, mine],
      targets: new Map<string, WorkflowLibraryTarget>([
        [
          builtIn.key,
          {
            kind: 'pipeline',
            pipeline: {
              id: 'bundled-code-review',
              name: 'Code Review (Claude)',
              filename: 'code-review-claude.yaml',
              description: 'Review the branch',
              icon: '🔎',
              createdAt: '2026-06-18T00:00:00.000Z',
              updatedAt: '2026-06-24T00:00:00.000Z',
              triggerTypes: ['dispatch'],
              source: 'bundled',
              readonly: true,
            },
          },
        ],
      ]),
    };

    function previewRow(key: string): HTMLElement {
      const found = container.querySelector<HTMLElement>(
        `[data-testid="workflows-runs-library-preview-row"][data-row-key="${key}"]`,
      );
      if (!found) throw new Error(`No preview row ${key}`);
      return found;
    }

    beforeEach(() => {
      useNavigationStore.setState({
        activePage: 'workflows',
        pendingPipelineReveal: undefined,
      });
      useWorkflowsViewStore.setState({
        librarySort: 'recently-run',
        libraryFilters: { ...EMPTY_WORKFLOW_LIBRARY_FILTERS, query: 'old' },
      });
      act(() => {
        root.render(
          <WorkflowsRunsTab
            feed={{ ...feed(), rows: [] }}
            library={library}
            onRunWorkflow={jest.fn()}
          />,
        );
      });
    });

    it('previews the Library with your own workflows first', () => {
      expect(
        Array.from(
          container.querySelectorAll<HTMLElement>(
            '[data-testid="workflows-runs-library-preview-row"]',
          ),
        ).map((element) => element.dataset.rowKey),
      ).toEqual([mine.key, builtIn.key]);
    });

    it('reveals a local pipeline in the Library', () => {
      click(previewRow(builtIn.key));
      const navigation = useNavigationStore.getState();
      expect(navigation.activePage).toBe('workflows-library');
      expect(navigation.pendingPipelineReveal).toEqual({
        pipelineId: 'bundled-code-review',
      });
    });

    it('opens the Library on the name of anything it cannot reveal', () => {
      click(previewRow(mine.key));
      expect(useNavigationStore.getState().activePage).toBe(
        'workflows-library',
      );
      expect(useWorkflowsViewStore.getState().libraryFilters).toEqual({
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        query: 'Nightly check',
      });
    });

    it('opens the whole Library from See your library', () => {
      click(
        container.querySelector('[data-testid="workflows-runs-empty-library"]'),
      );
      expect(useNavigationStore.getState().activePage).toBe(
        'workflows-library',
      );
      expect(useWorkflowsViewStore.getState().libraryFilters).toEqual(
        EMPTY_WORKFLOW_LIBRARY_FILTERS,
      );
    });

    it('previews nothing once there are runs', () => {
      act(() => {
        root.render(<WorkflowsRunsTab feed={feed()} library={library} />);
      });
      expect(
        container.querySelector(
          '[data-testid="workflows-runs-library-preview"]',
        ),
      ).toBeNull();
    });
  });

  it('offers Load more when no loaded run matches the search', () => {
    const loadMore = jest.fn();
    act(() => {
      useWorkflowsViewStore.setState({ runsQuery: 'no such run' });
      root.render(
        <WorkflowsRunsTab feed={{ ...feed(), hasMore: true, loadMore }} />,
      );
    });
    expect(
      container.querySelector('[data-testid="workflows-run-row"]'),
    ).toBeNull();

    click(container.querySelector('[data-testid="workflows-runs-load-more"]'));

    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});
