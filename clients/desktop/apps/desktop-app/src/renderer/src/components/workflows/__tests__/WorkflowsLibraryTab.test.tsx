/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import {
  EMPTY_WORKFLOW_LIBRARY_FILTERS,
  EMPTY_WORKFLOW_RUN_FILTERS,
  type WorkflowLibraryRow,
} from '@canopy/ui-app/workflows';
import type { AutomationScope } from '@/hooks/useAutomationScope';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkflowsViewStore } from '@/stores/workflowsViewStore';
import type { AutomationsPageBodyApi } from '../../pages/AutomationsPage';
import type { PipelinesPageListApi } from '../../pages/PipelinesPage';
import type {
  WorkflowLibraryData,
  WorkflowLibraryTarget,
} from '../library/useWorkflowLibraryRows';
import { revealedPipelineRowKey } from '../library/revealedPipelineRowKey';
import { WorkflowsLibraryTab } from '../library/WorkflowsLibraryTab';

jest.mock('@canopy/app-state', () => ({
  // Desktop: automations and watchers are available.
  useCapabilities: (): { automations: boolean; watchers: boolean } => ({
    automations: true,
    watchers: true,
  }),
}));

jest.mock('@/lib/share-links', () => ({
  resolveSharedPipelineUrl: (sharePath: string): Promise<string> =>
    Promise.resolve(`https://cloud.test${sharePath}`),
}));

const NOW = Date.parse('2026-10-12T12:00:00.000Z');

function activity(id: string, name: string): ScheduledActivity {
  return {
    version: 1,
    id,
    name,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    failureCount: 0,
  };
}

function pipeline(id: string, name: string): PipelineInfo {
  return {
    id,
    name,
    filename: `${id}.yaml`,
    description: '',
    icon: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    source: 'user',
    readonly: false,
    triggerTypes: ['dispatch'],
  };
}

function automationRow(entry: ScheduledActivity): WorkflowLibraryRow {
  return {
    key: `automation:${entry.id}`,
    kind: 'automation',
    name: entry.name,
    triggers: ['schedule'],
    triggerText: 'Every day at 09:00',
    steps: ['advisor'],
    summary: 'Ask Advisor',
    source: 'mine',
    enabled: true,
    actions: ['toggle', 'run', 'edit', 'view-runs', 'share', 'delete'],
  };
}

function pipelineRow(entry: PipelineInfo): WorkflowLibraryRow {
  return {
    key: `pipeline:user:${entry.id}`,
    kind: 'pipeline',
    name: entry.name,
    triggers: ['manual'],
    triggerText: 'Manual',
    steps: [],
    summary: '',
    source: 'mine',
    enabled: true,
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
}

const SCOPE: AutomationScope = {
  context: undefined,
  inContext: () => true,
  watcherInContext: () => true,
  shareInContext: () => true,
  contextLabel: null,
  runsInLabel: () => null,
  labelForWorkspace: () => 'Personal',
  memberOfWorkspace: () => true,
  projectsInContext: [],
};

describe('WorkflowsLibraryTab', () => {
  let container: HTMLDivElement;
  let root: Root;
  const standup = activity('a-1', 'Standup notes');
  const review = pipeline('code-review', 'Code review');

  function automationsApi(
    overrides: Partial<AutomationsPageBodyApi> = {},
  ): AutomationsPageBodyApi {
    return {
      activities: [standup],
      scopedActivities: [standup],
      recentRuns: [],
      loading: false,
      error: null,
      mutationError: null,
      scope: SCOPE,
      describeAction: () => 'Ask Advisor',
      beginCreate: jest.fn(),
      beginEdit: jest.fn(),
      beginView: jest.fn(),
      runNow: jest.fn(() => Promise.resolve()),
      toggleEnabled: jest.fn(() => Promise.resolve()),
      share: jest.fn(),
      remove: jest.fn(() => Promise.resolve()),
      runningActivityId: null,
      revealedActivityId: null,
      revealNotice: null,
      endReveal: jest.fn(),
      ...overrides,
    };
  }

  function pipelinesApi(
    overrides: Partial<PipelinesPageListApi> = {},
  ): PipelinesPageListApi {
    return {
      pipelines: [review],
      loading: false,
      error: null,
      refresh: jest.fn(() => Promise.resolve()),
      shared: {
        cloudAccount: null,
        cloudLoading: false,
        rows: [],
        loading: false,
        loadingMore: false,
        nextCursor: null,
        error: null,
        loaded: false,
      },
      refreshSharedList: jest.fn(() => Promise.resolve()),
      loadMoreSharedList: jest.fn(() => Promise.resolve()),
      disabledPipelineIds: new Set<string>(),
      setPipelineEnabled: jest.fn(() => Promise.resolve()),
      createNew: jest.fn(),
      startInterview: jest.fn(),
      interviewPending: false,
      edit: jest.fn(),
      remove: jest.fn(() => Promise.resolve()),
      duplicate: jest.fn(() => Promise.resolve()),
      share: jest.fn(),
      sharePendingId: null,
      shareError: null,
      headerAction: null,
      assistant: { open: false, toggle: jest.fn() },
      projectId: undefined,
      projectContext: undefined,
      projectContextPending: false,
      openDuplicate: jest.fn(() => Promise.resolve()),
      ...overrides,
    };
  }

  function data(
    overrides: Partial<WorkflowLibraryData> = {},
  ): WorkflowLibraryData {
    return {
      rows: [automationRow(standup), pipelineRow(review)],
      targets: new Map<string, WorkflowLibraryTarget>([
        ['automation:a-1', { kind: 'automation', activity: standup }],
        ['pipeline:user:code-review', { kind: 'pipeline', pipeline: review }],
      ]),
      sharedLoadFailed: false,
      loading: false,
      refreshSharedAutomations: jest.fn(() => Promise.resolve()),
      ...overrides,
    };
  }

  function render(
    props: {
      data?: WorkflowLibraryData;
      automations?: AutomationsPageBodyApi;
      pipelines?: PipelinesPageListApi;
      onRunPipeline?: (pipelineId: string) => void;
    } = {},
  ): { automations: AutomationsPageBodyApi; pipelines: PipelinesPageListApi } {
    const automations = props.automations ?? automationsApi();
    const pipelines = props.pipelines ?? pipelinesApi();
    act(() => {
      root.render(
        <WorkflowsLibraryTab
          data={props.data ?? data()}
          automations={automations}
          pipelines={pipelines}
          now={NOW}
          onRunPipeline={props.onRunPipeline}
        />,
      );
    });
    return { automations, pipelines };
  }

  function row(key: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(
      `[data-testid="workflows-library-row"][data-row-key="${key}"]`,
    );
    if (!found) throw new Error(`No Library row ${key}`);
    return found;
  }

  function click(element: Element | null | undefined): void {
    if (!element) throw new Error('Nothing to click');
    act(() => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    useNavigationStore.setState({ activePage: 'workflows-library' });
    useWorkflowsViewStore.setState({
      libraryFilters: EMPTY_WORKFLOW_LIBRARY_FILTERS,
      librarySort: 'recently-run',
      libraryPage: 1,
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

  it('lists automations and pipelines as separate rows of one table', () => {
    render();

    const rows = container.querySelectorAll(
      '[data-testid="workflows-library-row"]',
    );
    expect(
      Array.from(rows).map((entry) => entry.getAttribute('data-row-kind')),
    ).toEqual(expect.arrayContaining(['automation', 'pipeline']));
    expect(rows).toHaveLength(2);
  });

  it('opens an automation row in its editor and a pipeline row in the pipeline editor', () => {
    const { automations, pipelines } = render();

    click(row('automation:a-1').querySelector('td'));
    expect(automations.beginEdit).toHaveBeenCalledWith(standup);
    expect(pipelines.edit).not.toHaveBeenCalled();

    click(row('pipeline:user:code-review').querySelector('td'));
    expect(pipelines.edit).toHaveBeenCalledWith(review);
  });

  it("routes the switch to each kind's own toggle, with that row's id", async () => {
    const { automations, pipelines } = render();

    click(
      row('automation:a-1').querySelector(
        '[data-testid="workflows-library-toggle"]',
      ),
    );
    await settle();
    expect(automations.toggleEnabled).toHaveBeenCalledWith(standup);
    expect(automations.beginEdit).not.toHaveBeenCalled();

    click(
      row('pipeline:user:code-review').querySelector(
        '[data-testid="workflows-library-toggle"]',
      ),
    );
    await settle();
    // The row was on, so the existing pipeline toggle is asked to turn it off.
    expect(pipelines.setPipelineEnabled).toHaveBeenCalledWith(
      'code-review',
      false,
    );
    expect(pipelines.edit).not.toHaveBeenCalled();
  });

  it('runs an automation now, and opens the dispatch dialog on that pipeline', async () => {
    const onRunPipeline = jest.fn();
    const { automations } = render({ onRunPipeline });

    click(
      row('automation:a-1').querySelector(
        '[data-testid="workflows-library-run"]',
      ),
    );
    await settle();
    expect(automations.runNow).toHaveBeenCalledWith(standup);

    click(
      row('pipeline:user:code-review').querySelector(
        '[data-testid="workflows-library-run"]',
      ),
    );
    expect(onRunPipeline).toHaveBeenCalledWith('code-review');
    expect(automations.beginEdit).not.toHaveBeenCalled();
  });

  it('keeps the delete dialog open with the reason when the delete fails', async () => {
    const { pipelines } = render({
      pipelines: pipelinesApi({
        remove: jest.fn(() =>
          Promise.reject(new Error('The pipeline could not be deleted.')),
        ),
      }),
    });

    click(
      row('pipeline:user:code-review').querySelector(
        '[data-testid="workflows-library-menu"]',
      ),
    );
    click(
      document.body.querySelector(
        '[data-testid="workflows-library-menu-item-delete"]',
      ),
    );
    click(
      document.body.querySelector('[data-testid="confirm-dialog-confirm"]'),
    );
    await settle();

    expect(pipelines.remove).toHaveBeenCalledWith(review);
    expect(
      document.body.querySelector('[data-testid="confirm-dialog-error"]')
        ?.textContent,
    ).toBe('The pipeline could not be deleted.');
    expect(
      document.body.querySelector('[data-testid="workflows-library-delete"]'),
    ).not.toBeNull();
  });

  it('narrows to the stored filters and offers Clear filters when none match', () => {
    useWorkflowsViewStore.getState().setLibraryFilters({
      ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
      triggers: ['schedule', 'once'],
    });
    render();
    expect(
      container.querySelectorAll('[data-testid="workflows-library-row"]'),
    ).toHaveLength(1);
    expect(row('automation:a-1')).not.toBeNull();

    act(() => {
      useWorkflowsViewStore.getState().setLibraryFilters({
        ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
        query: 'nothing-matches-this',
      });
    });
    expect(
      container.querySelector('[data-testid="workflows-library-no-matches"]'),
    ).not.toBeNull();

    click(
      container.querySelector('[data-testid="workflows-library-empty-clear"]'),
    );
    expect(useWorkflowsViewStore.getState().libraryFilters).toEqual(
      EMPTY_WORKFLOW_LIBRARY_FILTERS,
    );
  });

  it('clears filters that would hide a revealed install and highlights its row', () => {
    useWorkflowsViewStore.getState().setLibraryFilters({
      ...EMPTY_WORKFLOW_LIBRARY_FILTERS,
      triggers: ['manual'],
    });
    render({ automations: automationsApi({ revealedActivityId: 'a-1' }) });

    expect(useWorkflowsViewStore.getState().libraryFilters).toEqual(
      EMPTY_WORKFLOW_LIBRARY_FILTERS,
    );
    expect(row('automation:a-1').getAttribute('data-highlighted')).toBe('true');
  });

  it('marks a pipeline installed from a share and refreshes the list', () => {
    act(() => {
      useNavigationStore.setState({
        pendingPipelineReveal: { pipelineId: 'code-review' },
      });
    });
    const { pipelines } = render();

    expect(useNavigationStore.getState().pendingPipelineReveal).toBeUndefined();
    expect(pipelines.refresh).toHaveBeenCalledTimes(1);
    expect(
      row('pipeline:user:code-review').getAttribute('data-highlighted'),
    ).toBe('true');
    expect(row('automation:a-1').getAttribute('data-highlighted')).toBeNull();
  });

  it('never marks a project file that shares the installed pipeline id', () => {
    const projectCopy: PipelineInfo = {
      ...review,
      source: 'project',
      filePath: '/repo/.canopy/pipelines/code-review.yaml',
    };
    expect(
      revealedPipelineRowKey(
        new Map<string, WorkflowLibraryTarget>([
          ['pipeline:project:x', { kind: 'pipeline', pipeline: projectCopy }],
          ['pipeline:user:code-review', { kind: 'pipeline', pipeline: review }],
        ]),
        'code-review',
      ),
    ).toBe('pipeline:user:code-review');
  });

  it('moves focus to a revealed row once it is listed', async () => {
    render({ automations: automationsApi({ revealedActivityId: 'a-1' }) });
    await act(async () => {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    expect(document.activeElement).toBe(row('automation:a-1'));
  });

  it('copies the share link of a pipeline that has one', async () => {
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const shared = {
      ...review,
      publicShare: {
        externalId: 'ext-1',
        pinnedContentHash: 'hash',
        upToDate: true,
        sharePath: '/share/pipelines/ext-1',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    };
    render({
      data: data({
        rows: [{ ...pipelineRow(review), actions: ['edit', 'copy-link'] }],
        targets: new Map<string, WorkflowLibraryTarget>([
          ['pipeline:user:code-review', { kind: 'pipeline', pipeline: shared }],
        ]),
      }),
    });

    click(
      row('pipeline:user:code-review').querySelector(
        '[data-testid="workflows-library-menu"]',
      ),
    );
    click(
      document.body.querySelector(
        '[data-testid="workflows-library-menu-item-copy-link"]',
      ),
    );
    await settle();
    await settle();

    expect(writeText).toHaveBeenCalledWith(
      'https://cloud.test/share/pipelines/ext-1',
    );
  });

  it('keeps local rows and says so when a share list failed to load', () => {
    render({ data: data({ sharedLoadFailed: true }) });

    expect(
      container.querySelector('[data-testid="workflows-library-shared-error"]')
        ?.textContent,
    ).toContain('Shared workflows could not be loaded');
    expect(
      container.querySelectorAll('[data-testid="workflows-library-row"]'),
    ).toHaveLength(2);
  });

  /** One share listed in the Library that is not added yet. */
  function sharedAutomationData(): WorkflowLibraryData {
    const share = {
      id: 'remote-1',
      name: 'Weekly org digest',
      description: '',
      triggerKind: 'cron' as const,
      actionType: 'app_advisor_prompt' as const,
      contentHash: 'hash',
      shareScope: 'team' as const,
      owner: { type: 'system' as const },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      createdBy: { id: 'u', name: null, email: null },
      canUpdate: false,
      canDelete: false,
    };
    const sharedRow: WorkflowLibraryRow = {
      key: 'shared-automation:remote-1',
      kind: 'automation',
      name: share.name,
      triggers: ['schedule'],
      triggerText: 'On a schedule',
      steps: ['advisor'],
      summary: 'Ask Advisor',
      source: 'shared',
      sourceLabel: 'Shared',
      installable: true,
      actions: ['add'],
    };
    return data({
      rows: [sharedRow],
      targets: new Map<string, WorkflowLibraryTarget>([
        [sharedRow.key, { kind: 'shared-automation', share }],
      ]),
    });
  }

  it('sends a share that is not added yet to its Marketplace entry', () => {
    const { automations } = render({ data: sharedAutomationData() });

    click(container.querySelector('[data-testid="workflows-library-add"]'));

    expect(automations.beginEdit).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().activePage).toBe('plugins');
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'marketplace-browse',
      query: 'Weekly org digest',
      tab: 'workflow',
    });
  });

  it('opens a share that is not added yet, read-only, in the edit shell (CAN-4072)', () => {
    useNavigationStore.setState({ workflowEdit: undefined });
    const { automations } = render({ data: sharedAutomationData() });

    click(row('shared-automation:remote-1').querySelector('td'));

    expect(automations.beginEdit).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'shared-automation',
      remoteId: 'remote-1',
      name: 'Weekly org digest',
    });
    useNavigationStore.setState({ workflowEdit: undefined });
  });
});
