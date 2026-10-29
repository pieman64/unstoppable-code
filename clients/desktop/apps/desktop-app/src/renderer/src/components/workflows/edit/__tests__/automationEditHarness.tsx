/**
 * Shared setup for the automation edit-shell suites (CAN-4072). It mounts the
 * real `AutomationsPage` host, as `WorkflowsPage` does, and draws the edit
 * shell from the navigation store's `workflowEdit` target through
 * `renderBody`, so the shell gets the page's own body API (Run now with the
 * shared-pipeline review, Share) and every open goes through navigation.
 *
 * The suites mock `ConfigurationChatComposer` and `AuthLoginModal`
 * themselves: `jest.mock` only hoists inside a test file.
 *
 * react-refresh/only-export-components is off: this test-only module exports
 * fixtures beside its harness components and is never hot-reloaded.
 */
/* eslint-disable react-refresh/only-export-components */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient } from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { createFakeClient } from '@canopy/app-state/__tests__/fake-org-projects-client';
import type {
  CoworkSidebarItem,
  SingleRepoSidebarItem,
  WorkspaceOwnerBinding,
  AutomationMutationResponse,
  AutomationRunHistoryRequest,
  AutomationRunHistoryResponse,
  AutomationUpdateRequest,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { workflowEditBackLabel } from '@/lib/workflows/edit-back';
import { useExecutionFeedStore } from '@/lib/workflows/execution-feed';
import {
  workflowEditKey,
  type WorkflowEditTarget,
} from '@/lib/workflows/edit-target';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSidebarItemGroupsStore } from '@/stores/sidebarItemGroupsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import {
  AutomationsPage,
  type AutomationsPageBodyApi,
} from '../../../pages/AutomationsPage';
import { WorkflowsTabContext } from '../../workflowsTabContext';
import { AutomationEditAdapter } from '../AutomationEditAdapter';
import { SharedAutomationEditAdapter } from '../SharedAutomationEditAdapter';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});

export function activity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-1',
    name: 'Morning review',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize the plan.' },
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

export function run(
  overrides: Partial<ScheduledActivityRun> = {},
): ScheduledActivityRun {
  return {
    id: 'run-1',
    activityId: 'activity-1',
    activityName: 'Morning review',
    scheduledFor: '2026-05-27T00:00:00.000Z',
    manual: false,
    trigger: 'scheduled',
    status: 'success',
    startedAt: '2026-05-27T00:00:00.000Z',
    completedAt: '2026-05-27T00:00:05.000Z',
    ...overrides,
  };
}

/** A code project with one `main` worktree, `base-worktree` by default. */
export function codeProject(
  id: string,
  name: string,
  options: {
    readonly worktreeId?: string;
    readonly owner?: WorkspaceOwnerBinding;
  } = {},
): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id,
    name,
    repoPath: `/repos/${id}`,
    color: 'blue',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: options.worktreeId ?? 'base-worktree',
        branchName: 'main',
        createdAt: '2026-05-27',
      },
    ],
    ...(options.owner ? { owner: options.owner } : {}),
  };
}

export function coworkProject(id: string, name: string): CoworkSidebarItem {
  return {
    type: 'cowork',
    id,
    name,
    color: 'green',
    collapsed: false,
    order: 0,
  };
}

export function setFieldValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

const fake = createFakeClient().client;
/** Desktop's capabilities for the shell: automations and pipelines run. */
const client: CanopyClient = {
  ...fake,
  capabilities: {
    ...fake.capabilities,
    localExecution: true,
    pipelines: 'execute',
    automations: true,
  },
};

function ShellTarget({
  target,
  automations,
}: {
  readonly target: WorkflowEditTarget;
  readonly automations: AutomationsPageBodyApi;
}): ReactElement | null {
  const targetKey = workflowEditKey(target);
  const section = target.section ?? 'definition';
  const backLabel = workflowEditBackLabel(target);
  switch (target.kind) {
    case 'automation':
      return (
        <AutomationEditAdapter
          key={targetKey}
          kind="automation"
          activityId={target.activityId}
          targetKey={targetKey}
          section={section}
          backLabel={backLabel}
          automations={automations}
        />
      );
    case 'automation-draft':
      return (
        <AutomationEditAdapter
          key={targetKey}
          kind="automation-draft"
          {...(target.seed !== undefined ? { seed: target.seed } : {})}
          targetKey={targetKey}
          section={section}
          backLabel={backLabel}
          automations={automations}
        />
      );
    case 'shared-automation':
      return (
        <SharedAutomationEditAdapter
          key={targetKey}
          targetKey={targetKey}
          remoteId={target.remoteId}
          fallbackName="Shared digest"
          section={section}
          backLabel={backLabel}
        />
      );
    case 'pipeline':
      return null;
  }
}

/** `WorkflowsPage`'s automations host: the shell in place of the tabs. */
function ShellHarness(): ReactElement {
  const target = useNavigationStore((state) => state.workflowEdit);
  return (
    <CanopyClientProvider client={client}>
      <WorkflowsTabContext.Provider
        value={{ tab: 'workflows-library', keyboardTarget: { current: null } }}
      >
        <AutomationsPage
          renderBody={(automations) =>
            target ? (
              <ShellTarget target={target} automations={automations} />
            ) : (
              <div data-testid="workflows-tabs-stub" />
            )
          }
        />
      </WorkflowsTabContext.Provider>
    </CanopyClientProvider>
  );
}

export interface AutomationEditEnvironment {
  readonly createMock: jest.Mock<
    Promise<AutomationMutationResponse>,
    [unknown]
  >;
  readonly updateMock: jest.Mock<
    Promise<AutomationMutationResponse>,
    [AutomationUpdateRequest]
  >;
  readonly deleteMock: jest.Mock<
    Promise<AutomationMutationResponse>,
    [unknown]
  >;
  readonly runNowMock: jest.Mock<
    Promise<AutomationMutationResponse>,
    [unknown]
  >;
  readonly cancelRunMock: jest.Mock<
    Promise<AutomationMutationResponse>,
    [unknown]
  >;
  readonly listRunsMock: jest.Mock<
    Promise<AutomationRunHistoryResponse>,
    [AutomationRunHistoryRequest]
  >;
  readonly generateCronMock: jest.Mock<
    Promise<{ ok: true; expression: string } | { ok: false; error: string }>,
    [unknown]
  >;
  readonly generateIfCommandMock: jest.Mock<
    Promise<{ ok: true; command: string } | { ok: false; error: string }>,
    [unknown]
  >;
  readonly getSharedMock: jest.Mock<Promise<unknown>, [string]>;
  readonly container: () => HTMLDivElement;
  /** Mounts the host with no item open. */
  readonly render: () => void;
  readonly settle: () => Promise<void>;
  readonly openDraft: (
    seed?: Parameters<
      ReturnType<typeof useNavigationStore.getState>['openAutomationDraft']
    >[0],
  ) => Promise<void>;
  readonly openEdit: (
    activityId: string,
    section?: 'definition' | 'trigger' | 'runs',
  ) => Promise<void>;
  readonly showSection: (
    id: 'definition' | 'trigger' | 'runs',
  ) => Promise<void>;
  readonly click: (testId: string) => Promise<void>;
  readonly byTestId: (testId: string) => HTMLElement | null;
  readonly input: (testId: string) => HTMLInputElement | HTMLTextAreaElement;
  readonly type: (testId: string, value: string) => Promise<void>;
  readonly shell: () => HTMLElement | null;
  readonly section: (
    id: 'definition' | 'trigger' | 'runs',
  ) => HTMLElement | null;
}

/**
 * Registers the suite's `beforeEach`/`afterEach` and returns its helpers.
 * Every store starts hydrated and empty, with two projects to pick from.
 */
export function installAutomationEditEnvironment(): AutomationEditEnvironment {
  const createMock = jest.fn<Promise<AutomationMutationResponse>, [unknown]>();
  const updateMock = jest.fn<
    Promise<AutomationMutationResponse>,
    [AutomationUpdateRequest]
  >();
  const deleteMock = jest.fn<Promise<AutomationMutationResponse>, [unknown]>();
  const runNowMock = jest.fn<Promise<AutomationMutationResponse>, [unknown]>();
  const cancelRunMock = jest.fn<
    Promise<AutomationMutationResponse>,
    [unknown]
  >();
  const listRunsMock = jest.fn<
    Promise<AutomationRunHistoryResponse>,
    [AutomationRunHistoryRequest]
  >();
  const generateCronMock = jest.fn<
    Promise<{ ok: true; expression: string } | { ok: false; error: string }>,
    [unknown]
  >();
  const generateIfCommandMock = jest.fn<
    Promise<{ ok: true; command: string } | { ok: false; error: string }>,
    [unknown]
  >();
  const getSharedMock = jest.fn<Promise<unknown>, [string]>();
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    createMock.mockResolvedValue({ ok: true, activity: activity() });
    updateMock.mockResolvedValue({ ok: true, activity: activity() });
    deleteMock.mockResolvedValue({ ok: true });
    runNowMock.mockResolvedValue({ ok: true });
    cancelRunMock.mockResolvedValue({ ok: true });
    listRunsMock.mockResolvedValue({
      runs: [],
      nextCursor: null,
      totalCount: 0,
    });
    generateCronMock.mockResolvedValue({ ok: true, expression: '30 14 * * 1' });
    generateIfCommandMock.mockResolvedValue({
      ok: true,
      command: 'test -f ~/ready-to-run.txt',
    });

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        automations: {
          list: jest.fn().mockResolvedValue({ activities: [], recentRuns: [] }),
          listRuns: listRunsMock,
          cancelRun: cancelRunMock,
          create: createMock,
          update: updateMock,
          delete: deleteMock,
          runNow: runNowMock,
          generateCron: generateCronMock,
          generateIfCommand: generateIfCommandMock,
          getShared: getSharedMock,
          onChanged: jest.fn(() => (): void => undefined),
        },
        appAdvisor: {
          listWatchers: jest.fn().mockResolvedValue([]),
          deleteWatcher: jest.fn().mockResolvedValue({ ok: true }),
          onWatchersChanged: jest.fn(() => (): void => undefined),
          openWindow: jest.fn(),
        },
        sidebarItemGroups: {
          list: jest.fn().mockResolvedValue([]),
          onChanged: jest.fn(() => (): void => undefined),
        },
        chat: {
          loadTabs: jest
            .fn()
            .mockResolvedValue({ version: 1, tabs: [], activeTabId: '' }),
          loadArchives: jest.fn().mockResolvedValue([]),
        },
        workEntries: {
          list: jest.fn().mockResolvedValue({ entries: [] }),
          resolveChat: jest
            .fn()
            .mockResolvedValue({ entryId: null, archivedInEntryId: null }),
        },
        getWorktreePath: jest
          .fn()
          .mockResolvedValue('/worktrees/base-worktree'),
        homeGetCoworkRoot: jest.fn().mockResolvedValue('/cowork/notes-root'),
      },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        list: jest.fn().mockResolvedValue({
          success: true,
          data: [{ id: 'stored-pipeline', name: 'Stored pipeline' }],
        }),
        discoverProject: jest.fn().mockResolvedValue({
          success: true,
          data: [{ id: 'pipeline-1', name: 'Release pipeline' }],
        }),
        // The Runs section reads the shared execution feed.
        listExecutions: jest
          .fn()
          .mockResolvedValue({ success: true, data: [] }),
        onExecutionEvent: jest.fn(() => (): void => undefined),
      },
    });
    useExecutionFeedStore.setState({
      executions: [],
      loaded: false,
      loading: false,
      error: null,
    });

    useAutomationsStore.setState({
      activities: [],
      recentRuns: [],
      loading: false,
      hydrated: true,
      error: null,
      mutationError: null,
    });
    useAppAdvisorWatchersStore.setState({
      watchers: [],
      loading: false,
      hydrated: true,
      error: null,
      deleteErrors: {},
    });
    useStandaloneChatStore.setState({
      chatProjects: [
        { id: 'default', name: 'Default', createdAt: '2026-05-27' },
      ],
      chatProjectsLoaded: true,
    });
    useSidebarItemGroupsStore.setState({ byScope: {}, errors: {} });
    useProjectsStore.setState({
      projects: [
        codeProject('workspace-1', 'Canopy'),
        coworkProject('cowork-1', 'Notes'),
      ],
    });
    useCurrentUiStateStore.setState({ slices: {} });
    useNavigationStore.setState({
      activePage: 'workflows-library',
      workflowEdit: undefined,
      pendingAutomationSharedPipelineReview: undefined,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
    jest.useRealTimers();
  });

  function requireContainer(): HTMLDivElement {
    if (!container) throw new Error('environment not set up');
    return container;
  }

  function byTestId(testId: string): HTMLElement | null {
    return document.querySelector(`[data-testid="${testId}"]`);
  }

  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
  }

  async function click(testId: string): Promise<void> {
    const element = byTestId(testId);
    if (!element) throw new Error(`missing ${testId}`);
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await settle();
  }

  function input(testId: string): HTMLInputElement | HTMLTextAreaElement {
    const element = byTestId(testId);
    if (
      !(element instanceof HTMLInputElement) &&
      !(element instanceof HTMLTextAreaElement)
    ) {
      throw new Error(`missing field ${testId}`);
    }
    return element;
  }

  return {
    createMock,
    updateMock,
    deleteMock,
    runNowMock,
    cancelRunMock,
    listRunsMock,
    generateCronMock,
    generateIfCommandMock,
    getSharedMock,
    container: requireContainer,
    render: (): void => {
      act(() => {
        root?.render(<ShellHarness />);
      });
    },
    settle,
    openDraft: async (seed): Promise<void> => {
      await act(async () => {
        useNavigationStore.getState().openAutomationDraft(seed);
        await Promise.resolve();
      });
      await settle();
    },
    openEdit: async (activityId, section): Promise<void> => {
      await act(async () => {
        useNavigationStore.getState().openAutomationEdit({
          activityId,
          ...(section !== undefined ? { section } : {}),
        });
        await Promise.resolve();
      });
      await settle();
    },
    showSection: async (id): Promise<void> => {
      await click(`workflow-edit-tab-${id}`);
    },
    click,
    byTestId,
    input,
    type: async (testId, value): Promise<void> => {
      const field = input(testId);
      await act(async () => {
        setFieldValue(field, value);
        await Promise.resolve();
      });
    },
    shell: (): HTMLElement | null => byTestId('workflow-edit-shell'),
    section: (id): HTMLElement | null =>
      byTestId(`workflow-edit-section-${id}`),
  };
}
