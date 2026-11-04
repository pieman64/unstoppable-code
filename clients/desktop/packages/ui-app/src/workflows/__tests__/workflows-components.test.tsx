/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import {
  WorkflowStepChain,
  WorkflowsLibraryEmptyState,
  WorkflowsLibraryPagination,
  WorkflowsLibraryTable,
  WorkflowsLibraryTableSkeleton,
  WorkflowsLibraryToolbar,
} from '../WorkflowsLibrary';
import { NewWorkflowMenu } from '../WorkflowsNotices';
import { PipelineTriggers } from '../PipelineTriggers';
import {
  WorkflowsRunsEmptyState,
  WorkflowsRunsTable,
  WorkflowsRunsToolbar,
} from '../WorkflowsRuns';
import { EMPTY_WORKFLOW_RUN_FILTERS } from '../run-search';
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
  type UnsavedChangesGuard,
  type UnsavedChangesSaveResult,
} from '../unsaved-changes';
import {
  EMPTY_WORKFLOW_LIBRARY_FILTERS,
  countLibraryFacets,
  pageLibraryRows,
  type WorkflowLibraryRow,
} from '../workflow-library-model';
import type { WorkflowRunRow } from '../workflow-run-model';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime();

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

function render(element: JSX.Element): void {
  act(() => root.render(element));
}

function query(testId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function get(testId: string): HTMLElement {
  const element = query(testId);
  if (!element) throw new Error(`Missing ${testId}`);
  return element;
}

function all(testId: string): HTMLElement[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
  );
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function pressEnter(element: Element): void {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
}

const failedRun: WorkflowRunRow = {
  kind: 'automation',
  key: 'run-failed',
  runId: 'run-failed',
  activityId: 'a1',
  name: 'Nightly dependency check',
  status: 'failure',
  starter: 'schedule',
  where: 'storefront · new worktree',
  startedAt: NOW - 3_600_000,
  endedAt: NOW - 3_600_000 + 843_000,
  detail: 'Pipeline Dependency check failed: npm test failed',
  actions: ['retry', 'open-library'],
  cancellable: false,
  linkedExecutionId: 'exec-9',
  result: { available: true },
};

const skippedRun: WorkflowRunRow = {
  kind: 'automation',
  key: 'run-skipped',
  runId: 'run-skipped',
  activityId: 'a2',
  name: 'Draft release notes',
  status: 'skipped',
  starter: 'schedule',
  startedAt: NOW - 7_200_000,
  detail: 'If command exited 1, so nothing ran',
  output: 'no commits since last release',
  actions: [],
  cancellable: false,
  result: { available: false },
};

const goneRun: WorkflowRunRow = {
  kind: 'watcher',
  key: 'watcher-gone',
  watcherId: 'w2',
  state: 'fired',
  name: 'CI run finished',
  status: 'fired',
  starter: 'chat',
  actions: [],
  result: { available: false, reason: 'The chat was deleted.' },
};

describe('WorkflowsRunsTable', () => {
  it('opens a row on click and on Enter, but never from its actions', () => {
    const onOpen = jest.fn();
    const onAction = jest.fn();
    render(
      <WorkflowsRunsTable
        rows={[failedRun]}
        now={NOW}
        locale="en-US"
        onOpen={onOpen}
        onAction={onAction}
      />,
    );
    const row = get('workflows-run-row');
    expect(row.tabIndex).toBe(0);
    click(get('workflows-run-name'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    pressEnter(row);
    expect(onOpen).toHaveBeenCalledTimes(2);

    click(get('workflows-run-action-retry'));
    expect(onAction).toHaveBeenCalledWith(failedRun, 'retry');
    click(get('workflows-run-menu'));
    click(get('workflows-run-menu-item-open-library'));
    expect(onAction).toHaveBeenLastCalledWith(failedRun, 'open-library');
    // Enter on a control inside the row belongs to the control.
    pressEnter(get('workflows-run-action-retry'));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('expands a skipped run to its recorded output instead of opening it', () => {
    const onOpen = jest.fn();
    render(
      <WorkflowsRunsTable
        rows={[skippedRun]}
        now={NOW}
        onOpen={onOpen}
        onAction={jest.fn()}
      />,
    );
    const row = get('workflows-run-row');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(query('workflows-run-output')).toBeNull();
    click(get('workflows-run-name'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(get('workflows-run-output').textContent).toBe(
      'no commits since last release',
    );
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows why a result is gone and does not make that row a link', () => {
    const onOpen = jest.fn();
    render(
      <WorkflowsRunsTable
        rows={[goneRun]}
        now={NOW}
        onOpen={onOpen}
        onAction={jest.fn()}
      />,
    );
    const row = get('workflows-run-row');
    expect(row.hasAttribute('tabindex')).toBe(false);
    expect(get('workflows-run-detail').textContent).toBe(
      'The chat was deleted.',
    );
    click(get('workflows-run-name'));
    expect(onOpen).not.toHaveBeenCalled();
    // A row with no applicable actions draws no empty menu.
    expect(query('workflows-run-menu')).toBeNull();
  });

  it('masks user-authored names and blocks run output from session replay', () => {
    render(
      <WorkflowsRunsTable
        rows={[failedRun]}
        now={NOW}
        onOpen={jest.fn()}
        onAction={jest.fn()}
      />,
    );
    expect(get('workflows-run-name').className).toContain(REPLAY_MASK_CLASS);
    expect(get('workflows-run-detail').className).toContain(REPLAY_BLOCK_CLASS);
    expect(get('workflows-run-action-retry').className).not.toContain(
      REPLAY_MASK_CLASS,
    );
  });

  it('disables a busy row, uses the host action slot, and asks for more', () => {
    const onLoadMore = jest.fn();
    render(
      <WorkflowsRunsTable
        rows={[failedRun]}
        now={NOW}
        onOpen={jest.fn()}
        onAction={jest.fn()}
        busyKeys={new Set(['run-failed'])}
        hasMore
        onLoadMore={onLoadMore}
      />,
    );
    expect(get('workflows-run-action-retry').hasAttribute('disabled')).toBe(
      true,
    );
    // The status is named beside its colored dot, not by color alone.
    expect(get('workflows-run-status').textContent).toBe('Failed');
    click(get('workflows-runs-load-more'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    render(
      <WorkflowsRunsTable
        rows={[failedRun]}
        now={NOW}
        onOpen={jest.fn()}
        onAction={jest.fn()}
        renderActions={(row): JSX.Element => (
          <button type="button" data-testid="host-action">
            {row.key}
          </button>
        )}
      />,
    );
    expect(get('host-action').textContent).toBe('run-failed');
    expect(query('workflows-run-action-retry')).toBeNull();
    expect(query('workflows-runs-load-more')).toBeNull();
  });
});

describe('WorkflowsRunsToolbar and empty state', () => {
  it('offers only the kinds the host lists and reports filter changes', () => {
    const onFiltersChange = jest.fn();
    render(
      <WorkflowsRunsToolbar
        query="status:fialed"
        onQueryChange={jest.fn()}
        filters={EMPTY_WORKFLOW_RUN_FILTERS}
        onFiltersChange={onFiltersChange}
        statuses={['running', 'failure']}
        kinds={['pipeline']}
        starters={['manual']}
      />,
    );
    // One kind is no choice, so the Kind filter is left out.
    expect(query('workflows-runs-filter-kind')).toBeNull();
    expect(get('workflows-runs-hint').textContent).toContain('status:fialed');
    click(get('workflows-runs-filter-status'));
    click(get('workflows-runs-filter-status-option-failure'));
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...EMPTY_WORKFLOW_RUN_FILTERS,
      status: 'failure',
    });
  });

  it('shows no message under the search field unless a token is unknown', () => {
    for (const value of ['', 'status:failed']) {
      render(
        <WorkflowsRunsToolbar
          query={value}
          onQueryChange={jest.fn()}
          filters={EMPTY_WORKFLOW_RUN_FILTERS}
          onFiltersChange={jest.fn()}
          statuses={['running', 'failure']}
          kinds={['pipeline']}
          starters={['manual']}
        />,
      );
      expect(query('workflows-runs-hint')).toBeNull();
    }
  });

  it('offers Run a workflow, with Browse Customize behind it, when there is a workflow to run', () => {
    const onRunWorkflow = jest.fn();
    const onBrowseMarketplace = jest.fn();
    render(
      <WorkflowsRunsEmptyState
        query=""
        filters={EMPTY_WORKFLOW_RUN_FILTERS}
        onClearFilters={jest.fn()}
        onRunWorkflow={onRunWorkflow}
        onNewWorkflow={jest.fn()}
        onBrowseMarketplace={onBrowseMarketplace}
      />,
    );
    expect(get('workflows-runs-empty').textContent).toContain('No runs yet');
    const run = get('workflows-runs-empty-run');
    expect(run.textContent).toBe('Run a workflow');
    expect(run.classList.contains('bg-accent')).toBe(true);
    click(run);
    expect(onRunWorkflow).toHaveBeenCalledTimes(1);
    expect(query('workflows-runs-empty-new')).toBeNull();
    // Customize stays reachable while the Library has something to run.
    const customize = get('workflows-runs-empty-marketplace');
    expect(customize.textContent).toBe('Browse Customize');
    expect(customize.classList.contains('bg-accent')).toBe(false);
    click(customize);
    expect(onBrowseMarketplace).toHaveBeenCalledTimes(1);
  });

  it('leaves Browse Customize out when the host does not offer it', () => {
    render(
      <WorkflowsRunsEmptyState
        query=""
        filters={EMPTY_WORKFLOW_RUN_FILTERS}
        onClearFilters={jest.fn()}
        onRunWorkflow={jest.fn()}
      />,
    );
    expect(query('workflows-runs-empty-marketplace')).toBeNull();
  });

  it('offers New workflow and Browse Customize when there is nothing to run', () => {
    const onNewWorkflow = jest.fn();
    const onBrowseMarketplace = jest.fn();
    render(
      <WorkflowsRunsEmptyState
        query=""
        filters={EMPTY_WORKFLOW_RUN_FILTERS}
        onClearFilters={jest.fn()}
        onNewWorkflow={onNewWorkflow}
        onBrowseMarketplace={onBrowseMarketplace}
      />,
    );
    expect(query('workflows-runs-empty-run')).toBeNull();
    click(get('workflows-runs-empty-new'));
    expect(get('workflows-runs-empty-marketplace').textContent).toBe(
      'Browse Customize',
    );
    click(get('workflows-runs-empty-marketplace'));
    expect(onNewWorkflow).toHaveBeenCalledTimes(1);
    expect(onBrowseMarketplace).toHaveBeenCalledTimes(1);
  });

  it('previews Library workflows and leads with See your library', () => {
    const onRunWorkflow = jest.fn();
    const onOpenRow = jest.fn();
    const onSeeLibrary = jest.fn();
    render(
      <WorkflowsRunsEmptyState
        query=""
        filters={EMPTY_WORKFLOW_RUN_FILTERS}
        onClearFilters={jest.fn()}
        onRunWorkflow={onRunWorkflow}
        onNewWorkflow={jest.fn()}
        onBrowseMarketplace={jest.fn()}
        libraryPreview={{
          rows: [automationRow, eventPipelineRow],
          onOpenRow,
          onSeeLibrary,
        }}
      />,
    );
    const empty = get('workflows-runs-empty');
    expect(empty.textContent).toContain('No runs yet');
    const previewRows = all('workflows-runs-library-preview-row');
    expect(previewRows.map((row) => row.dataset.rowKey)).toEqual([
      automationRow.key,
      eventPipelineRow.key,
    ]);
    expect(previewRows.map((row) => row.tagName)).toEqual(['BUTTON', 'BUTTON']);
    expect(previewRows[0]?.textContent).toContain('Morning PR triage');
    expect(previewRows[1]?.textContent).toContain('Built-in');
    // A workflow name is the user's content, so replay masks it.
    expect(
      previewRows[0]
        ?.querySelector('[data-testid="workflows-runs-library-preview-name"]')
        ?.classList.contains(REPLAY_MASK_CLASS),
    ).toBe(true);
    const [, pipelinePreview] = previewRows;
    if (!pipelinePreview) throw new Error('Expected a second preview row');
    click(pipelinePreview);
    expect(onOpenRow).toHaveBeenCalledWith(eventPipelineRow);

    const seeLibrary = get('workflows-runs-empty-library');
    expect(seeLibrary.textContent).toBe('See your library');
    // The Library leads: it is the one primary action.
    expect(seeLibrary.classList.contains('bg-accent')).toBe(true);
    click(seeLibrary);
    expect(onSeeLibrary).toHaveBeenCalledTimes(1);
    // Run a workflow stays, behind the Library.
    const run = get('workflows-runs-empty-run');
    expect(run.classList.contains('bg-accent')).toBe(false);
    click(run);
    expect(onRunWorkflow).toHaveBeenCalledTimes(1);
    // So does Customize, last.
    const actions = Array.from(
      get('workflows-runs-empty').querySelectorAll<HTMLElement>(
        '[data-testid^="workflows-runs-empty-"]',
      ),
    ).map((element) => element.dataset.testid);
    expect(actions).toEqual([
      'workflows-runs-empty-library',
      'workflows-runs-empty-run',
      'workflows-runs-empty-marketplace',
    ]);
  });

  it('blocks a person named in a preview source from session replay', () => {
    const sharedByPerson: WorkflowLibraryRow = {
      ...automationRow,
      key: 'shared-automation:s1',
      source: 'shared',
      sourceLabel: 'Shared by Dana Lee',
      sourceIsPerson: true,
    };
    render(
      <WorkflowsRunsEmptyState
        query=""
        filters={EMPTY_WORKFLOW_RUN_FILTERS}
        onClearFilters={jest.fn()}
        libraryPreview={{
          rows: [sharedByPerson, eventPipelineRow],
          onOpenRow: jest.fn(),
          onSeeLibrary: jest.fn(),
        }}
      />,
    );
    const [personSource, builtInSource] = all(
      'workflows-runs-library-preview-source',
    );
    expect(personSource?.textContent).toBe('Shared by Dana Lee');
    expect(personSource?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    // A source that names no one stays recorded.
    expect(builtInSource?.textContent).toBe('Built-in');
    expect(builtInSource?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(false);
    expect(builtInSource?.classList.contains(REPLAY_MASK_CLASS)).toBe(false);
  });

  it('keeps the plain actions when the preview has no rows', () => {
    render(
      <WorkflowsRunsEmptyState
        query=""
        filters={EMPTY_WORKFLOW_RUN_FILTERS}
        onClearFilters={jest.fn()}
        onRunWorkflow={jest.fn()}
        libraryPreview={{
          rows: [],
          onOpenRow: jest.fn(),
          onSeeLibrary: jest.fn(),
        }}
      />,
    );
    expect(query('workflows-runs-library-preview')).toBeNull();
    expect(query('workflows-runs-empty-library')).toBeNull();
    expect(
      get('workflows-runs-empty-run').classList.contains('bg-accent'),
    ).toBe(true);
  });

  it('shows the no-matches state with Clear filters when a search hides all', () => {
    const onClearFilters = jest.fn();
    render(
      <WorkflowsRunsEmptyState
        query="deploy"
        filters={EMPTY_WORKFLOW_RUN_FILTERS}
        onClearFilters={onClearFilters}
        libraryPreview={{
          rows: [automationRow],
          onOpenRow: jest.fn(),
          onSeeLibrary: jest.fn(),
        }}
      />,
    );
    expect(query('workflows-runs-empty')).toBeNull();
    expect(query('workflows-runs-library-preview')).toBeNull();
    expect(get('workflows-runs-no-matches').textContent).toContain(
      'No runs match "deploy"',
    );
    click(get('workflows-runs-clear-filters'));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});

const automationRow: WorkflowLibraryRow = {
  key: 'automation:a1',
  kind: 'automation',
  name: 'Morning PR triage',
  triggers: ['schedule'],
  triggerText: 'Weekdays at 9:00 AM',
  steps: ['chat'],
  summary: 'Start chat in storefront',
  source: 'mine',
  enabled: true,
  projectId: 'storefront',
  projectName: 'storefront',
  lastRun: { state: 'success', at: NOW - 7_200_000 },
  nextRunAt: new Date(2026, 9, 13, 9, 0).getTime(),
  actions: [
    'toggle',
    'run',
    'edit',
    'view-runs',
    'duplicate',
    'share',
    'delete',
  ],
};

const eventPipelineRow: WorkflowLibraryRow = {
  key: 'pipeline:builtin:implementation',
  kind: 'pipeline',
  name: 'Implementation (autopilot)',
  triggers: ['plan-approved', 'task-ready'],
  triggerText: 'When a plan is approved or a task is ready',
  steps: ['agent', 'agent', 'script', 'agent', 'agent'],
  summary: '9 steps',
  source: 'built-in',
  sourceLabel: 'Built-in',
  actions: ['edit', 'view-runs', 'duplicate'],
  runUnavailableLabel: 'Starts from an approved plan or a new task',
};

const sharedRow: WorkflowLibraryRow = {
  key: 'shared-pipeline:r1',
  kind: 'pipeline',
  name: 'Release checklist',
  triggers: ['manual'],
  triggerText: 'Manual',
  steps: ['agent'],
  summary: '4 steps',
  source: 'shared',
  sourceLabel: 'Shared by Dana Lee',
  sourceIsPerson: true,
  installable: true,
  actions: ['add'],
};

describe('WorkflowsLibraryTable', () => {
  it('opens a row on click and Enter, never from the switch, Run or menu', () => {
    const onOpen = jest.fn();
    const onAction = jest.fn();
    render(
      <WorkflowsLibraryTable
        rows={[automationRow]}
        now={NOW}
        locale="en-US"
        onOpen={onOpen}
        onAction={onAction}
      />,
    );
    click(get('workflows-library-toggle'));
    expect(onAction).toHaveBeenLastCalledWith(automationRow, 'toggle');
    click(get('workflows-library-run'));
    expect(onAction).toHaveBeenLastCalledWith(automationRow, 'run');
    click(get('workflows-library-menu'));
    const items = all('workflows-library-menu-item-edit').concat(
      all('workflows-library-menu-item-delete'),
    );
    expect(items).toHaveLength(2);
    // Every row leads with an icon, groups split by hairlines, and Delete
    // sits alone in the last group.
    const menu = get('workflows-library-menu-menu');
    const rows = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      'workflows-library-menu-item-edit',
      'workflows-library-menu-item-view-runs',
      'workflows-library-menu-item-duplicate',
      'workflows-library-menu-item-share',
      'workflows-library-menu-item-delete',
    ]);
    for (const row of rows) {
      expect(row.querySelector('[aria-hidden="true"]')).not.toBeNull();
    }
    expect(rows[0]?.querySelector('svg')).toBeInstanceOf(Element);
    const separators = menu.querySelectorAll('[role="separator"]');
    expect(
      Array.from(separators).map(
        (separator) =>
          separator.nextElementSibling instanceof HTMLElement &&
          separator.nextElementSibling.dataset.testid,
      ),
    ).toEqual([
      'workflows-library-menu-item-share',
      'workflows-library-menu-item-delete',
    ]);
    expect(rows[4]?.className).toContain('fg-destructive');
    click(get('workflows-library-menu-item-delete'));
    expect(onAction).toHaveBeenLastCalledWith(automationRow, 'delete');
    expect(onOpen).not.toHaveBeenCalled();

    click(get('workflows-library-name'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    pressEnter(get('workflows-library-row'));
    expect(onOpen).toHaveBeenCalledTimes(2);
    pressEnter(get('workflows-library-run'));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('draws the trigger, last run and next run of a scheduled row', () => {
    render(
      <WorkflowsLibraryTable
        rows={[automationRow]}
        now={NOW}
        locale="en-US"
        onOpen={jest.fn()}
        onAction={jest.fn()}
      />,
    );
    expect(get('workflows-library-trigger').textContent).toBe(
      'Weekdays at 9:00 AM',
    );
    expect(get('workflows-library-last-run').textContent).toContain(
      'Succeeded',
    );
    expect(get('workflows-library-next-run').textContent).toBe(
      'Tomorrow, 9:00 AM',
    );
    expect(get('workflows-library-name').className).toContain(
      REPLAY_MASK_CLASS,
    );
  });

  it('shows no switch for a pipeline and disables Run with where it starts', () => {
    render(
      <WorkflowsLibraryTable
        rows={[eventPipelineRow]}
        now={NOW}
        onOpen={jest.fn()}
        onAction={jest.fn()}
      />,
    );
    expect(query('workflows-library-toggle')).toBeNull();
    const run = get('workflows-library-run');
    expect(run.hasAttribute('disabled')).toBe(true);
    expect(run.getAttribute('aria-label')).toBe(
      'Starts from an approved plan or a new task',
    );
    expect(get('workflows-library-next-run').textContent).toBe('—');
    expect(get('workflows-library-last-run').textContent).toBe('Not run yet');
    expect(get('workflows-library-source').textContent).toBe('Built-in');
    expect(get('workflows-step-chain-more').textContent).toBe('+2');
  });

  it('offers Add in place of the switch and Run for a shared item not yet added', () => {
    const onAction = jest.fn();
    const onOpen = jest.fn();
    render(
      <WorkflowsLibraryTable
        rows={[sharedRow, { ...sharedRow, key: 'busy', installing: true }]}
        now={NOW}
        onOpen={onOpen}
        onAction={onAction}
      />,
    );
    const [add, busyAdd] = all('workflows-library-add');
    if (!add || !busyAdd) throw new Error('Missing Add buttons');
    expect(query('workflows-library-toggle')).toBeNull();
    expect(query('workflows-library-run')).toBeNull();
    click(add);
    expect(onAction).toHaveBeenCalledWith(sharedRow, 'add');
    expect(onOpen).not.toHaveBeenCalled();
    expect(busyAdd.hasAttribute('disabled')).toBe(true);
    // The sharer is a person, so replay masks the suffix.
    const [source] = all('workflows-library-source');
    expect(source?.className).toContain(REPLAY_MASK_CLASS);
  });

  it('dims a row that is off, folds Next run when compact, and marks a reveal', () => {
    render(
      <WorkflowsLibraryTable
        rows={[
          { ...automationRow, attention: 'Failed the last 3 runs' },
          { ...automationRow, key: 'off', enabled: false },
        ]}
        now={NOW}
        locale="en-US"
        compact
        highlightKey="off"
        onOpen={jest.fn()}
        onAction={jest.fn()}
      />,
    );
    expect(query('workflows-library-next-run')).toBeNull();
    const [onRow, offRow] = all('workflows-library-row');
    expect(onRow?.textContent).toContain('Next: Tomorrow, 9:00 AM');
    // Switched off: no next run, even though the schedule has one.
    expect(offRow?.textContent).not.toContain('Next:');
    expect(offRow?.getAttribute('data-highlighted')).toBe('true');
    expect(get('workflows-library-attention').textContent).toBe(
      'Failed the last 3 runs',
    );
  });
});

describe('WorkflowsLibraryTableSkeleton', () => {
  function headings(root: HTMLElement): string[] {
    return Array.from(root.querySelectorAll('th')).map(
      (th) => th.textContent ?? '',
    );
  }

  it('keeps the real column heads and pulses only the values', () => {
    render(<WorkflowsLibraryTableSkeleton />);
    const skeleton = get('workflows-library-skeleton');
    expect(skeleton.getAttribute('role')).toBe('status');
    expect(headings(skeleton)).toEqual([
      'Workflow',
      'Trigger',
      'Last run',
      'Next run',
      'On or off, and actions',
    ]);
    const rows = Array.from(skeleton.querySelectorAll<HTMLElement>('tbody tr'));
    expect(rows).toHaveLength(5);
    // Every cell holds pulsing blocks only, no text.
    for (const row of rows) {
      expect(row.textContent).toBe('');
      expect(row.querySelectorAll('[skullet-bar]').length).toBeGreaterThan(0);
    }
  });

  it('lines up with the table: same heads, cell padding and compact fold', () => {
    render(
      <>
        <WorkflowsLibraryTableSkeleton compact rows={2} />
        <WorkflowsLibraryTable
          rows={[automationRow]}
          now={NOW}
          onOpen={jest.fn()}
          onAction={jest.fn()}
          compact
        />
      </>,
    );
    const skeleton = get('workflows-library-skeleton');
    const table = get('workflows-library-table');
    expect(skeleton.querySelector('thead')?.outerHTML).toBe(
      table.querySelector('thead')?.outerHTML,
    );
    expect(headings(skeleton)).not.toContain('Next run');
    expect(skeleton.querySelectorAll('tbody tr')).toHaveLength(2);
    // The placeholder cells take the loaded cells' padding, so the rows the
    // skeleton holds are as tall and as inset as the ones that replace it.
    const cellPadding = (cell: Element | null): string[] =>
      Array.from(cell?.classList ?? []).filter((name) => /^p[xy]-/.test(name));
    expect(cellPadding(skeleton.querySelector('tbody td'))).toEqual(
      cellPadding(table.querySelector('tbody td')),
    );
  });
});

describe('WorkflowStepChain', () => {
  it('shows the trigger alone when there are no steps', () => {
    render(<WorkflowStepChain trigger="manual" steps={[]} />);
    expect(
      get('workflows-step-chain').querySelectorAll('[data-step]'),
    ).toHaveLength(0);
    expect(query('workflows-step-chain-more')).toBeNull();
  });
});

describe('WorkflowsLibraryToolbar, pagination and empty state', () => {
  const rows = [automationRow, eventPipelineRow, sharedRow];

  it('counts matches in the page field and filters from the Filter dropdown after it', () => {
    const onFiltersChange = jest.fn();
    render(
      <WorkflowsLibraryToolbar
        filters={{ ...EMPTY_WORKFLOW_LIBRARY_FILTERS, query: 'triage' }}
        onFiltersChange={onFiltersChange}
        sort="recently-run"
        onSortChange={jest.fn()}
        counts={countLibraryFacets(rows)}
        triggers={['schedule', 'once', 'manual', 'plan-approved', 'task-ready']}
        projects={[{ id: 'storefront', name: 'storefront' }]}
        sharedCountUnknown
        total={3}
        matched={1}
      />,
    );
    const field = get('workflows-library-search-field');
    expect(field.getAttribute('data-search-field')).toBe('md');
    expect(field.querySelector('[data-search-field-count]')?.textContent).toBe(
      '1 of 3',
    );
    // Four filters are more than fit inline: one Filter dropdown follows
    // the field, outside it, grouped with the sort that comes last.
    const filter = get('workflows-library-filter');
    expect(field.contains(filter)).toBe(false);
    const row = get('workflows-library-toolbar');
    expect(Array.from(row.children).map((child) => child.textContent)).toEqual([
      '1 of 3',
      'FilterSort: Recently run',
    ]);
    // Only the query is set: the Filter dropdown names no count.
    expect(filter.getAttribute('data-active')).toBe('false');
    expect(filter.getAttribute('aria-label')).toBe('Filter');
    expect(filter.textContent).toBe('Filter');
    click(filter);
    expect(filter.getAttribute('aria-expanded')).toBe('true');
    // One row per filter; each opens its own submenu.
    expect(get('workflows-library-filter-trigger').textContent).toBe('Trigger');
    click(get('workflows-library-filter-trigger'));
    expect(
      get('workflows-library-filter-trigger-option-schedule').textContent,
    ).toContain('1');
    click(get('workflows-library-filter-trigger-option-schedule'));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
      query: 'triage',
      triggers: ['schedule'],
    });
    // The share list failed to load: Shared carries no count, not a 0.
    click(get('workflows-library-filter-source'));
    expect(
      get('workflows-library-filter-source-option-shared').textContent,
    ).toBe('Shared');
    expect(get('workflows-library-filter-source-option-mine').textContent).toBe(
      'Yours1',
    );
    // Nothing to clear yet.
    expect(query('workflows-library-filter-clear')).toBeNull();
    // Clear search empties the query and leaves the filters.
    click(get('workflows-library-search-clear'));
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      EMPTY_WORKFLOW_LIBRARY_FILTERS,
    );
  });

  it('counts the filters on in the Filter dropdown and clears every one', () => {
    const onFiltersChange = jest.fn();
    render(
      <WorkflowsLibraryToolbar
        filters={{
          ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
          query: 'triage',
          triggers: ['schedule'],
          source: 'mine',
        }}
        onFiltersChange={onFiltersChange}
        sort="recently-run"
        onSortChange={jest.fn()}
        counts={countLibraryFacets(rows)}
        triggers={['schedule', 'manual']}
        projects={[]}
        total={3}
        matched={1}
      />,
    );
    const filter = get('workflows-library-filter');
    expect(filter.getAttribute('data-active')).toBe('true');
    expect(filter.getAttribute('aria-label')).toBe('Filters: 2 on');
    expect(filter.textContent).toBe('Filter · 2');
    click(filter);
    click(get('workflows-library-filter-clear'));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
      query: 'triage',
    });
    // Closing the menu from its own row hands focus back to the button.
    expect(document.activeElement).toBe(filter);
  });

  it('shows no count without a query and reports a sort change', () => {
    const onSortChange = jest.fn();
    render(
      <WorkflowsLibraryToolbar
        filters={EMPTY_WORKFLOW_LIBRARY_FILTERS}
        onFiltersChange={jest.fn()}
        sort="recently-run"
        onSortChange={onSortChange}
        counts={countLibraryFacets(rows)}
        triggers={['manual']}
        projects={[]}
        total={3}
        matched={3}
      />,
    );
    expect(
      get('workflows-library-search-field').querySelector(
        '[data-search-field-count]',
      ),
    ).toBeNull();
    expect(get('workflows-library-sort').getAttribute('aria-label')).toBe(
      'Sort: Recently run',
    );
    click(get('workflows-library-sort'));
    click(get('workflows-library-sort-option-name'));
    expect(onSortChange).toHaveBeenCalledWith('name');
  });

  it('pages and states the range', () => {
    const many = Array.from({ length: 38 }, (_, index) => ({
      ...automationRow,
      key: `row-${String(index)}`,
    }));
    const onPageChange = jest.fn();
    render(
      <WorkflowsLibraryPagination
        page={pageLibraryRows(many, 1)}
        onPageChange={onPageChange}
      />,
    );
    expect(get('workflows-library-range').textContent).toBe(
      '1–25 of 38 workflows',
    );
    expect(
      get('workflows-library-page-previous').hasAttribute('disabled'),
    ).toBe(true);
    click(get('workflows-library-page-next'));
    expect(onPageChange).toHaveBeenCalledWith(2);
    click(get('workflows-library-page-2'));
    expect(onPageChange).toHaveBeenCalledTimes(2);
  });

  it('distinguishes no matches from an empty library', () => {
    const onClearFilters = jest.fn();
    render(
      <WorkflowsLibraryEmptyState
        filters={{
          ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
          query: 'deploy',
          triggers: ['once'],
        }}
        onClearFilters={onClearFilters}
        newWorkflow={<button data-testid="new-workflow-slot" />}
      />,
    );
    expect(get('workflows-library-no-matches').textContent).toContain(
      'No workflows match "deploy" with a one-time trigger',
    );
    // The one action names what it clears.
    expect(get('workflows-library-empty-clear').textContent).toBe(
      'Clear search and filters',
    );
    click(get('workflows-library-empty-clear'));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
    // The page header already has New workflow; no matches offers Clear only.
    expect(query('new-workflow-slot')).toBeNull();

    render(
      <WorkflowsLibraryEmptyState
        filters={EMPTY_WORKFLOW_LIBRARY_FILTERS}
        onClearFilters={onClearFilters}
        newWorkflow={<button data-testid="new-workflow-slot" />}
      />,
    );
    expect(get('workflows-library-empty').textContent).toContain(
      'No workflows yet',
    );
    expect(query('workflows-library-empty-clear')).toBeNull();
    expect(query('new-workflow-slot')).not.toBeNull();
  });
});

describe('New workflow menu', () => {
  it('lists only the creation paths the host has, and none hides the button', () => {
    const onSchedule = jest.fn();
    render(<NewWorkflowMenu onSchedule={onSchedule} />);
    click(get('workflows-new'));
    expect(query('workflows-new-describe')).toBeNull();
    click(get('workflows-new-schedule'));
    expect(onSchedule).toHaveBeenCalledTimes(1);

    render(<NewWorkflowMenu />);
    expect(query('workflows-new')).toBeNull();
  });

  it('leads each row with an icon; the two pipeline rows share one', () => {
    render(
      <NewWorkflowMenu
        onSchedule={jest.fn()}
        onDescribePipeline={jest.fn()}
        onBuildPipeline={jest.fn()}
      />,
    );
    click(get('workflows-new'));
    const iconOf = (testId: string): Element | null =>
      get(testId).querySelector('[aria-hidden="true"]');
    expect(
      iconOf('workflows-new-schedule')?.querySelector('svg'),
    ).not.toBeNull();
    expect(
      iconOf('workflows-new-describe')?.querySelector('svg'),
    ).not.toBeNull();
    // The slot stays, so the labels line up, but the repeated icon is hidden.
    expect(iconOf('workflows-new-build')).not.toBeNull();
    expect(iconOf('workflows-new-build')?.querySelector('svg')).toBeNull();
    // A description stays beneath each label.
    expect(get('workflows-new-schedule').textContent).toContain(
      'Runs at set times, or once at a time you pick',
    );
  });
});

describe('useUnsavedChangesGuard', () => {
  let guard: UnsavedChangesGuard;

  function Harness({
    isDirty,
    save,
    discard,
    targetKey = 'a',
  }: {
    readonly isDirty: boolean;
    readonly save: () => Promise<UnsavedChangesSaveResult>;
    readonly discard?: () => void;
    readonly targetKey?: string;
  }): JSX.Element | null {
    guard = useUnsavedChangesGuard({ isDirty, save, discard, targetKey });
    return guard.prompting ? (
      <UnsavedChangesDialog
        name="Nightly dependency check"
        saving={guard.saving}
        onSave={guard.onSave}
        onDiscard={guard.onDiscard}
        onKeepEditing={guard.onKeepEditing}
      />
    ) : null;
  }

  // Wrapped in an object: an async function returning the promise itself
  // would have `await` unwrap it and wait for the prompt to be answered.
  async function ask(): Promise<{ readonly pending: Promise<boolean> }> {
    let pending: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      pending = guard.confirmLeave();
      await Promise.resolve();
    });
    return { pending };
  }

  it('lets a clean draft leave without a prompt', async () => {
    const save = jest.fn();
    render(<Harness isDirty={false} save={save} />);
    expect(guard.canLeaveNow()).toBe(true);
    await expect(guard.confirmLeave()).resolves.toBe(true);
    expect(query('workflows-unsaved-dialog')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('resolves true after Save succeeds', async () => {
    const save = jest.fn(
      (): Promise<UnsavedChangesSaveResult> => Promise.resolve({ ok: true }),
    );
    render(<Harness isDirty save={save} />);
    expect(guard.canLeaveNow()).toBe(false);
    const { pending } = await ask();
    expect(get('workflows-unsaved-dialog').textContent).toContain(
      'Save changes to “Nightly dependency check”?',
    );
    await act(async () => {
      get('workflows-unsaved-save').click();
      await pending;
    });
    await expect(pending).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(query('workflows-unsaved-dialog')).toBeNull();
  });

  it('resolves false and keeps the draft when validation fails', async () => {
    const save = jest.fn(
      (): Promise<UnsavedChangesSaveResult> =>
        Promise.resolve({ ok: false, message: 'Name is required' }),
    );
    const discard = jest.fn();
    render(<Harness isDirty save={save} discard={discard} />);
    const { pending } = await ask();
    await act(async () => {
      get('workflows-unsaved-save').click();
      await pending;
    });
    await expect(pending).resolves.toBe(false);
    expect(guard.error).toBe('Name is required');
    expect(discard).not.toHaveBeenCalled();
    expect(query('workflows-unsaved-dialog')).toBeNull();
  });

  it('resolves false when the save request rejects', async () => {
    const save = jest.fn(
      (): Promise<UnsavedChangesSaveResult> =>
        Promise.reject(new Error('Network down')),
    );
    render(<Harness isDirty save={save} />);
    const { pending } = await ask();
    await act(async () => {
      get('workflows-unsaved-save').click();
      await pending;
    });
    await expect(pending).resolves.toBe(false);
    expect(guard.error).toBe('Network down');
  });

  it('treats a save that throws like one that fails', async () => {
    const save = jest.fn((): Promise<UnsavedChangesSaveResult> => {
      throw new Error('Not ready');
    });
    render(<Harness isDirty save={save} />);
    const { pending } = await ask();
    await act(async () => {
      get('workflows-unsaved-save').click();
      await pending;
    });
    await expect(pending).resolves.toBe(false);
    expect(guard.error).toBe('Not ready');
    // The guard is not left saving, so a later prompt can save again.
    await ask();
    await act(async () => {
      get('workflows-unsaved-save').click();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('resolves true on Discard after dropping the draft', async () => {
    const discard = jest.fn();
    const save = jest.fn();
    render(<Harness isDirty save={save} discard={discard} />);
    const { pending } = await ask();
    await act(async () => {
      get('workflows-unsaved-discard').click();
      await pending;
    });
    await expect(pending).resolves.toBe(true);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('resolves false when Cancel keeps editing', async () => {
    render(<Harness isDirty save={jest.fn()} />);
    const { pending } = await ask();
    // A two-way choice: Cancel on its own at the left, then Discard and the
    // default Save changes.
    const labels = Array.from(
      get('workflows-unsaved-dialog').querySelectorAll('button'),
    ).map((button) => button.firstChild?.textContent);
    expect(labels).toEqual(['Cancel', 'Discard', 'Save changes']);
    // The default carries its Enter key chip after the label.
    expect(document.activeElement?.firstChild?.textContent).toBe(
      'Save changes',
    );
    await act(async () => {
      get('workflows-unsaved-cancel').click();
      await pending;
    });
    await expect(pending).resolves.toBe(false);
    expect(query('workflows-unsaved-dialog')).toBeNull();
  });

  it('answers a prompt that replaced another mid-save with that save', async () => {
    let finishSave: (result: UnsavedChangesSaveResult) => void = () =>
      undefined;
    const save = jest.fn(
      (): Promise<UnsavedChangesSaveResult> =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    render(<Harness isDirty save={save} />);
    const { pending: first } = await ask();
    await act(async () => {
      get('workflows-unsaved-save').click();
      await Promise.resolve();
    });
    expect(guard.saving).toBe(true);

    const { pending: second } = await ask();
    await expect(first).resolves.toBe(false);
    // The new prompt shows the save still running, and cannot start another.
    expect(guard.saving).toBe(true);
    await act(async () => {
      guard.onSave();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishSave({ ok: true });
      await second;
    });
    // The draft is saved, so the navigation that asked second goes ahead.
    await expect(second).resolves.toBe(true);
    expect(guard.prompting).toBe(false);
    expect(guard.saving).toBe(false);
  });

  it('keeps editing when the save a replacement prompt waited on fails', async () => {
    let finishSave: (result: UnsavedChangesSaveResult) => void = () =>
      undefined;
    const save = jest.fn(
      (): Promise<UnsavedChangesSaveResult> =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    render(<Harness isDirty save={save} />);
    await ask();
    await act(async () => {
      get('workflows-unsaved-save').click();
      await Promise.resolve();
    });
    const { pending: second } = await ask();
    await act(async () => {
      finishSave({ ok: false, message: 'Network down' });
      await second;
    });
    await expect(second).resolves.toBe(false);
    expect(guard.saving).toBe(false);
    expect(guard.error).toBe('Network down');
  });

  it('drops an open prompt when the target changes, and replaces a second ask', async () => {
    const save = jest.fn();
    render(<Harness isDirty save={save} />);
    const { pending: first } = await ask();
    const { pending: second } = await ask();
    await expect(first).resolves.toBe(false);
    render(<Harness isDirty save={save} targetKey="b" />);
    await expect(second).resolves.toBe(false);
    expect(query('workflows-unsaved-dialog')).toBeNull();
  });
});

describe('PipelineTriggers', () => {
  function q(testId: string): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
    );
  }

  it('lists every declared trigger as On or Off, then hooks and automations', () => {
    const onOpenHook = jest.fn();
    const onOpenAutomation = jest.fn();
    render(
      <PipelineTriggers
        starts={['manual', 'plan-approved']}
        hooks={[
          {
            key: 'storefront:project:pr:create',
            eventLabel: 'PR Created',
            where: 'storefront',
          },
        ]}
        automations={[
          {
            key: 'nightly',
            name: 'Nightly',
            scheduleText: 'Every day at 2:00 AM',
            enabled: false,
          },
        ]}
        onOpenHook={onOpenHook}
        onOpenAutomation={onOpenAutomation}
      />,
    );

    expect(
      q('pipeline-trigger-start').map((row) => [
        row.dataset.trigger,
        row.dataset.on,
        row.textContent,
      ]),
    ).toEqual([
      ['manual', 'true', 'ManualRun, Orchestrator or Remote ControlOn'],
      ['plan-approved', 'true', 'Plan approvedFrom an approved planOn'],
      ['task-ready', 'false', 'Task readyFrom a new task in workflow modeOff'],
    ]);
    // Read-only: nothing to edit.
    expect(q('pipeline-trigger-edit-starts')).toHaveLength(0);

    act(() => q('pipeline-trigger-hook')[0]?.click());
    expect(onOpenHook).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'storefront:project:pr:create' }),
    );
    const automation = q('pipeline-trigger-automation')[0];
    expect(automation?.dataset.activityId).toBe('nightly');
    expect(automation?.textContent).toContain('Off');
    act(() => automation?.click());
    expect(onOpenAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'nightly' }),
    );
  });

  it('says hooks and automations need Manual when it is off', () => {
    render(
      <PipelineTriggers
        starts={['plan-approved']}
        hooks={[]}
        automations={[]}
        onOpenHook={jest.fn()}
        onOpenAutomation={jest.fn()}
      />,
    );
    expect(q('pipeline-trigger-hooks-empty')[0]?.textContent).toBe(
      'Hooks only run workflows with a Manual trigger.',
    );
    expect(q('pipeline-trigger-automations-empty')[0]?.textContent).toBe(
      'Automations only run workflows with a Manual trigger.',
    );
  });

  it('says nothing runs it yet, and offers Edit when editable', () => {
    const onEditStarts = jest.fn();
    render(
      <PipelineTriggers
        starts={['manual']}
        hooks={[]}
        automations={[]}
        onOpenHook={jest.fn()}
        onOpenAutomation={jest.fn()}
        onEditStarts={onEditStarts}
      />,
    );
    expect(q('pipeline-trigger-hooks-empty')[0]?.textContent).toBe(
      'No hooks run this workflow.',
    );
    expect(q('pipeline-trigger-automations-empty')[0]?.textContent).toBe(
      'No automations run this workflow.',
    );
    act(() => q('pipeline-trigger-edit-starts')[0]?.click());
    expect(onEditStarts).toHaveBeenCalledTimes(1);
  });

  it('masks user-authored names from session replay', () => {
    render(
      <PipelineTriggers
        starts={['manual']}
        hooks={[{ key: 'h', eventLabel: 'PR Merged', where: 'storefront' }]}
        automations={[
          { key: 'a', name: 'Nightly', scheduleText: 'Daily', enabled: true },
        ]}
        onOpenHook={jest.fn()}
        onOpenAutomation={jest.fn()}
      />,
    );
    const masked = Array.from(
      container.querySelectorAll(`.${REPLAY_MASK_CLASS}`),
    ).map((element) => element.textContent);
    expect(masked).toEqual(['storefront', 'Nightly']);
  });
});

it('continues Load more after revealing an older selected run', () => {
  const rows: WorkflowRunRow[] = Array.from({ length: 350 }, (_, index) => ({
    ...failedRun,
    key: `selected-run-${index}`,
    runId: `selected-run-${index}`,
  }));
  render(
    <WorkflowsRunsTable
      rows={rows}
      now={NOW}
      onOpen={jest.fn()}
      onAction={jest.fn()}
      highlightKey="selected-run-250"
    />,
  );
  expect(all('workflows-run-row')).toHaveLength(251);
  click(get('workflows-runs-load-more'));
  expect(all('workflows-run-row')).toHaveLength(350);
});
