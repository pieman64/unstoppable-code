/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import type * as ChangedFilesHeaderModule from '@canopy/ui-app/code/activity/changed-files-header';
import { act } from 'react';
import type * as ReactNamespace from 'react';
import type * as UiAppCostNamespace from '@canopy/ui-app/cost';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import {
  ActivityPanel as SharedActivityPanel,
  type ChangedFilesSectionHostModel,
  type BackgroundTasksSectionHostModel,
  type HooksSectionHostModel,
} from '@canopy/ui-app';
import { useCostScopeStore } from '@canopy/ui-app/cost';
import { SharedActivityPanelAdapter } from '../SharedActivityPanelAdapter';
import { resetMcpSectionContentMemoryForTests } from '../mcpSectionContentMemory';
import { useChatStore } from '@/stores/chatStore';
import {
  resetRendererBillingLaneForTests,
  setRendererBillingLaneAvailability,
} from '@/stores/billingLaneRuntime';
import { useHooksStore } from '@/stores/hooksStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useScriptsStore } from '@/stores/scriptsStore';
import { useActivityStore } from '@/stores/activityStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useActivitySectionRevealStore } from '@/stores/activitySectionRevealStore';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';

let mockPullRequestChrome = {
  subtitle: 'pull-request chrome',
  collapsedIconColor: 'muted' as const,
  hasContent: false,
};
let mockPipelineRunsChrome: {
  subtitle: string;
  collapsedIconColor: 'amber' | 'muted';
  hasContent: boolean;
} = {
  subtitle: 'pipeline-runs chrome',
  collapsedIconColor: 'amber',
  hasContent: true,
};
let mockMcpLoading = false;
let mockMcpInitializing = false;
const mockMcpRefresh = jest.fn(() => Promise.resolve());
interface MockCostScopeRead {
  readonly value: {
    readonly totals: { readonly usd: number };
    readonly chats: readonly unknown[];
    readonly pipelineRuns: readonly unknown[];
  } | null;
  readonly problem: unknown;
}
let mockCostScopeRead: MockCostScopeRead = { value: null, problem: null };
const mockCostStore = <Value,>(
  selector: (state: MockCostScopeRead) => Value,
): Value => selector(mockCostScopeRead);

jest.mock('@canopy/ui-app', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  // The real shared header helpers (REG-3024): desktop words its Changed
  // files header through them, so the stand-in keeps them.
  const header = jest.requireActual<typeof ChangedFilesHeaderModule>(
    '@canopy/ui-app/code/activity/changed-files-header',
  );
  return {
    changedFilesHeaderSubtitle: header.changedFilesHeaderSubtitle,
    changedFilesHeaderHasContent: header.changedFilesHeaderHasContent,
    ActivityPanel: jest.fn(
      (props: {
        sectionOverrides?: Readonly<
          Record<
            string,
            {
              body?: ReactNamespace.ReactNode;
              icon?: ReactNamespace.ReactNode;
              subtitle?: ReactNamespace.ReactNode;
              headerAction?: ReactNamespace.ReactNode;
              hasContent?: boolean;
              hasAction?: boolean;
              actionCard?: boolean;
            }
          >
        >;
        extraSections?: readonly {
          key: string;
          body: ReactNamespace.ReactNode;
          icon?: ReactNamespace.ReactNode;
          subtitle?: ReactNamespace.ReactNode;
          actionCard?: boolean;
        }[];
        backgroundTasksSection?: BackgroundTasksSectionHostModel;
        hooksSection?: HooksSectionHostModel;
        changedFilesSection?: ChangedFilesSectionHostModel;
      }): unknown =>
        react.createElement(
          'div',
          { 'data-testid': 'shared-activity-panel' },
          props.sectionOverrides?.hooks?.headerAction,
          props.sectionOverrides?.['changed-files']?.headerAction,
          props.sectionOverrides?.['mcp-servers']?.headerAction,
          props.hooksSection?.renderWatcherButton?.('project:pr:create'),
          props.changedFilesSection?.supplementaryContent,
          props.sectionOverrides?.summary?.body,
          props.sectionOverrides?.['changed-files']?.body,
          props.sectionOverrides?.['mcp-servers']?.body,
          props.extraSections?.map((section) =>
            react.createElement(
              react.Fragment,
              { key: section.key },
              section.body,
            ),
          ),
        ),
    ),
  };
});
let mockMemoryEmptyChange: ((empty: boolean) => void) | undefined;
jest.mock('../MemorySection', () => ({
  MemorySection: ({
    projectId,
    worktreeId,
    onEmptyChange,
  }: {
    projectId: string;
    worktreeId: string;
    onEmptyChange: (empty: boolean) => void;
  }): ReactNamespace.ReactNode => {
    mockMemoryEmptyChange = onEmptyChange;
    return jest
      .requireActual<typeof ReactNamespace>('react')
      .createElement('div', {
        'data-testid': 'stub-section-memory',
        'data-project-id': projectId,
        'data-worktree-id': worktreeId,
      });
  },
}));

jest.mock('../BackgroundProcessesSection', () => ({
  useBackgroundProcessesSectionHostModel:
    (): BackgroundTasksSectionHostModel => ({ tasks: [] }),
}));

jest.mock('../activity-sections', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  function StubSection({
    id,
    projectId,
    worktreeId,
  }: {
    id: string;
    projectId: string;
    worktreeId: string;
  }): ReactNamespace.ReactNode {
    return react.createElement('div', {
      'data-testid': `stub-section-${id}`,
      'data-project-id': projectId,
      'data-worktree-id': worktreeId,
    });
  }
  const makeSection = (id: string, title: string): object => ({
    id,
    title,
    icon: react.createElement('svg', { 'data-icon': id }),
    render: jest.fn(
      (props: { projectId: string; worktreeId: string }): unknown =>
        react.createElement(StubSection, { id, ...props }),
    ),
  });
  const sections = [
    makeSection('summary', 'Summary'),
    makeSection('changed-files', 'Changed Files'),
    makeSection('pull-request', 'Pull Request'),
    makeSection('background-processes', 'Agent Background Processes'),
    makeSection('mcp-servers', 'MCP servers'),
    makeSection('plans', 'Plans'),
    makeSection('pipeline-runs', 'Pipeline runs'),
    makeSection('cost', 'Cost'),
    makeSection('scripts', 'Scripts'),
    makeSection('hooks', 'Hooks'),
    makeSection('todo', 'Agent Tasks'),
    makeSection('plugins', 'Plugins'),
    makeSection('memory', 'Memory'),
    makeSection('notes', 'Notes'),
    makeSection('prompts', 'Prompts'),
    makeSection('attachments', 'Attachments'),
  ];
  return {
    getActivitySectionsForSurface: (): readonly object[] => sections,
    useMcpServersActivityModel: (): object => ({
      servers: [],
      warnings: [],
      loading: mockMcpLoading,
      initializing: mockMcpInitializing,
      error: null,
      refresh: mockMcpRefresh,
    }),
    McpServersActivitySectionBody: ({
      model,
    }: {
      model: { refresh: () => Promise<void> };
    }): ReactNamespace.ReactNode =>
      react.createElement('div', {
        'data-testid': 'mcp-body-from-adapter-model',
        'data-refresh-is-adapter-model': String(
          model.refresh === mockMcpRefresh,
        ),
      }),
    useSummaryHeaderChrome: (): object => ({
      subtitle: 'Desktop summary subtitle',
      collapsedIconColor: 'blue',
    }),
    usePullRequestHeaderChrome: (): object => mockPullRequestChrome,
    useBackgroundProcessesHeaderChrome: (): object => ({
      subtitle: 'background-processes chrome',
      collapsedIconColor: 'blue',
    }),
    useMcpServersHeaderChrome: (): object => ({
      subtitle: 'mcp-servers chrome',
      collapsedIconColor: 'blue',
    }),
    usePlansHeaderChrome: (): object => ({
      subtitle: 'plans chrome',
      collapsedIconColor: 'blue',
    }),
    usePipelineRunsHeaderChrome: (): object => mockPipelineRunsChrome,
    useScriptsHeaderChrome: (): object => ({
      subtitle: 'scripts chrome',
      collapsedIconColor: 'blue',
    }),
    useHooksHeaderChrome: (): object => ({
      subtitle: 'hooks chrome',
      collapsedIconColor: 'blue',
    }),
    useTodoHeaderChrome: (): object => ({
      subtitle: 'todo chrome',
      collapsedIconColor: 'amber',
    }),
    useAttachmentsHeaderChrome: (): object => ({
      subtitle: 'attachments chrome',
      collapsedIconColor: 'amber',
    }),
    useNotesHeaderChrome: (): object => ({
      subtitle: 'notes chrome',
      collapsedIconColor: 'amber',
    }),
    usePromptsHeaderChrome: (): object => ({
      subtitle: 'prompts chrome',
      collapsedIconColor: 'amber',
    }),
  };
});
jest.mock('@canopy/ui-app/cost', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  const actual = jest.requireActual<typeof UiAppCostNamespace>(
    '@canopy/ui-app/cost',
  );
  return {
    costScopeHasContent: actual.costScopeHasContent,
    useCostScopeStore: jest.fn(() => mockCostStore),
    CostScopeTotalLabel: (): unknown =>
      react.createElement('span', { 'data-testid': 'cost-section-total' }),
    CostScopeRefreshAction: (): unknown =>
      react.createElement('button', { 'data-testid': 'cost-refresh' }),
    CostActivityPreview: (): unknown =>
      react.createElement('div', { 'data-testid': 'cost-activity-preview' }),
  };
});
jest.mock('@/hooks/useActivityEventSubscriptions', () => ({
  useActivityEventSubscriptions: jest.fn(),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';

function makeProject(): SidebarItem {
  return {
    type: 'single-repo',
    id: PROJECT_ID,
    name: 'Project One',
    repoPath: '/tmp/project-one',
    color: '#112233',
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: 'feature/hooks',
        createdAt: '2026-07-01T00:00:00.000Z',
        pausedHookKeys: ['project:pr:create'],
      },
    ],
    collapsed: false,
    order: 0,
    activitySectionOrder: ['changed-files', 'summary', 'notes'],
  };
}

function makeActivePrStatus(): WorktreePrStatus {
  return {
    repos: [
      {
        repoId: PROJECT_ID,
        repoName: 'Project One',
        status: {
          prNumber: 17,
          prUrl: 'https://github.com/example/project/pull/17',
          state: 'open',
          title: 'Hooks swap',
          checkStatus: 'passing',
          checkDetails: [],
          reviewStatus: 'pending',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: '2026-07-01T00:00:00.000Z',
          additions: 1,
          deletions: 1,
        },
      },
    ],
    lastCheckedAt: '2026-07-01T00:00:00.000Z',
  };
}

describe('SharedActivityPanelAdapter', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCostScopeRead = { value: null, problem: null };
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    mockMcpRefresh.mockClear();
    mockMcpLoading = false;
    mockMcpInitializing = false;
    resetMcpSectionContentMemoryForTests();
    mockPullRequestChrome = {
      subtitle: 'pull-request chrome',
      collapsedIconColor: 'muted',
      hasContent: false,
    };
    mockPipelineRunsChrome = {
      subtitle: 'pipeline-runs chrome',
      collapsedIconColor: 'amber',
      hasContent: true,
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [`${PROJECT_ID}/${WORKTREE_ID}`]: {
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Chat',
              messages: [],
              status: 'idle',
              error: null,
              createdAt: '2026-07-01T00:00:00.000Z',
              queuedMessages: [],
              planMode: false,
              proposalMode: 'optional',
              thinkingLevel: 'high',
              modelConfig: {
                thinkingLevel: 'high',
                speed: 'standard',
                fastMode: false,
              },
              fastModeExplicit: false,
              model: 'claude-sonnet-4-5-20250514',
              providerType: 'claude',
              currentTodos: [
                { id: 'ordinary', content: 'Ordinary todo', status: 'pending' },
              ],
              currentTaskTodos: [
                {
                  id: 'task',
                  content: 'Task todo',
                  status: 'in_progress',
                },
              ],
            },
          ],
        },
      },
    });
    useActivityStore.setState({
      worktreeSummaries: {
        [`${PROJECT_ID}/${WORKTREE_ID}`]: {
          title: 'Projected summary',
          description: 'Projected description',
          highlights: [],
          generatedAt: '2026-07-01T00:00:00.000Z',
          turnCountAtGeneration: 1,
          lastFullRefreshAt: '2026-07-01T00:00:00.000Z',
          lastFullRefreshTurnCount: 1,
        },
      },
      summaryGenerating: {
        [`${PROJECT_ID}/${WORKTREE_ID}`]: true,
      },
      worktreeSummaryEnabled: false,
      refreshWorktreeSummary: jest.fn(() => Promise.resolve()),
    });
    useProjectsStore.setState({
      projects: [makeProject()],
      appliedProjectWorktreeHooks: {
        [`${PROJECT_ID}/${WORKTREE_ID}`]: {
          'pr:create': [
            {
              type: 'chat',
              prompt: 'Review the PR',
              model: 'claude-sonnet-4-5-20250514',
            },
            {
              type: 'command',
              command: 'read name',
              interactive: true,
            },
          ],
        },
      },
      setWorktreePausedHookKeys: jest.fn(() => Promise.resolve()),
    });
    useGitHubStore.setState({ prStatuses: {} });
    useAppAdvisorWatchersStore.setState({
      hydrated: true,
      loading: false,
      watchers: [
        {
          id: 'watcher-1',
          trigger: 'worktree_hook_triggered',
          status: 'active',
          label: 'Hook watcher',
          target: {
            kind: 'worktree_hook',
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            triggerName: 'pr:create',
            hookKey: 'project:pr:create',
          },
          destination: {
            projectId: 'app-advisor',
            worktreeId: 'advisor',
            chatId: 'chat',
          },
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    });
    useScriptsStore.setState({
      loadWorktreeRuns: jest.fn(() => Promise.resolve()),
      unloadWorktreeRuns: jest.fn(),
    });
    useHooksStore.setState({
      loadWorktreeRuns: jest.fn(() => Promise.resolve()),
      unloadWorktreeRuns: jest.fn(),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetRendererBillingLaneForTests();
  });

  it('passes native bodies, desktop extras, hidden tabs, and persisted order to shared chrome', () => {
    act(() => root.render(<SharedActivityPanelAdapter />));

    expect(
      container.querySelector('[data-testid="stub-section-summary"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="stub-section-changed-files"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="stub-section-notes"]'),
    ).not.toBeNull();
    expect(jest.mocked(SharedActivityPanel)).toHaveBeenCalled();
    const calls = jest.mocked(SharedActivityPanel).mock.calls;
    const props = calls[calls.length - 1][0];
    expect(props.hideTabs).toBe(true);
    expect(props.sectionOrder?.slice(0, 3)).toEqual([
      'changed-files',
      'summary',
      'notes',
    ]);
    expect(props.sectionOverrides?.terminals?.hidden).toBe(true);
    expect(props.extraSections?.map((section) => section.key)).toEqual([
      'plugins',
      'memory',
      'notes',
      'prompts',
      'attachments',
    ]);
    const injected = [
      ...Object.values(props.sectionOverrides ?? {}).filter(
        (section): section is NonNullable<typeof section> =>
          section?.body !== undefined,
      ),
      ...(props.extraSections ?? []),
    ];
    // Cost is one of them, with Early access off.
    expect(props.sectionOverrides?.cost?.body).toBeDefined();
    expect(injected).toHaveLength(10);
    expect(
      props.sectionOverrides?.['background-processes']?.body,
    ).toBeUndefined();
    expect(props.backgroundTasksSection).toEqual({ tasks: [] });
    expect(injected.every((section) => section.icon !== undefined)).toBe(true);
    expect(props.sectionOverrides?.summary?.subtitle).toBe(
      'Desktop summary subtitle',
    );
    expect(props.sectionOverrides?.summary?.body).toBeUndefined();
    expect(props.sectionOverrides?.summary?.dataTestId).toBe(
      'activity-summary-section',
    );
    expect(props.sectionOverrides?.todo?.body).toBeUndefined();
    expect(props.sectionOverrides?.scripts?.body).toBeUndefined();
    expect(props.sectionOverrides?.hooks?.body).toBeUndefined();
    expect(props.sectionOverrides?.['changed-files']?.body).toBeUndefined();
    expect(props.sectionOverrides?.['changed-files']?.dataTestId).toBe(
      'changed-files-section',
    );
    expect(props.changedFilesSection?.emptyState).toBeNull();
    expect(props.scriptsSection).toEqual(
      expect.objectContaining({
        identityKey: `${PROJECT_ID}/${WORKTREE_ID}`,
        groupWorkspaceLifecycles: true,
      }),
    );
    expect(props.hooksSection).toEqual(
      expect.objectContaining({
        identityKey: `${PROJECT_ID}/${WORKTREE_ID}`,
        unconfiguredWatchers: [],
      }),
    );
    const hookEntry = props.hooksSection?.entries[0];
    expect(hookEntry?.paused).toBe(true);
    expect(hookEntry?.runDisabled).toBe(true);
    expect(hookEntry?.runDisabledTitle).toBe(
      'Manual run requires an active PR',
    );
    expect(hookEntry?.hook.actions[0]?.label).toContain('Review the PR');
    expect(hookEntry?.hook.actions[1]).toEqual({
      type: 'command',
      label: 'read name',
      interactive: true,
    });

    act(() => {
      useGitHubStore.setState({
        prStatuses: {
          [`${PROJECT_ID}/${WORKTREE_ID}`]: makeActivePrStatus(),
        },
      });
    });
    const activePrCalls = jest.mocked(SharedActivityPanel).mock.calls;
    const activePrProps = activePrCalls[activePrCalls.length - 1][0];
    expect(activePrProps.hooksSection?.entries[0]?.runDisabled).toBe(false);

    act(() => {
      useHooksStore.getState().startRun(PROJECT_ID, WORKTREE_ID, {
        hookKey: 'project:pr:create',
        triggerName: 'pr:create',
        label: 'PR Created',
        actions: [{ type: 'command', command: 'echo running' }],
        target: 'project',
      });
    });
    const runningCalls = jest.mocked(SharedActivityPanel).mock.calls;
    const runningProps = runningCalls[runningCalls.length - 1][0];
    expect(runningProps.hooksSection?.entries[0]?.runDisabled).toBe(true);
    expect(
      container.querySelector(
        '[data-testid="hook-watchers-project:pr:create"]',
      ),
    ).not.toBeNull();
    const resumeAll = container.querySelector<HTMLButtonElement>(
      '[aria-label="Resume all hooks"]',
    );
    act(() => resumeAll?.click());
    expect(
      useProjectsStore.getState().setWorktreePausedHookKeys,
    ).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID, []);
    expect(props.selectedChatId).toBe('chat-1');
    expect(props.todoLists).toEqual([
      {
        localId: 'chat-1',
        workspaceLocalId: PROJECT_ID,
        worktreeLocalId: WORKTREE_ID,
        chatId: 'chat-1',
        items: [
          {
            id: 'todo:ordinary',
            content: 'Ordinary todo',
            status: 'pending',
          },
          { id: 'task', content: 'Task todo', status: 'in_progress' },
        ],
      },
    ]);
    expect(props.worktreeSummaries).toEqual([
      expect.objectContaining({
        localId: WORKTREE_ID,
        workspaceLocalId: PROJECT_ID,
        worktreeLocalId: WORKTREE_ID,
        title: 'Projected summary',
        generating: true,
      }),
    ]);
    expect(props.summaryRefreshEnabled).toBe(false);
    expect(props.summaryGenerating).toBe(true);
    expect(props.hostActions?.onRefreshSummary).toBeDefined();
    expect(props.sectionOverrides?.['changed-files']?.subtitle).toBe(
      'No local changes',
    );
    expect(props.sectionOverrides?.['changed-files']?.collapsedIconColor).toBe(
      'muted',
    );
    expect(props.sectionOverrides?.['changed-files']?.hasContent).toBe(false);
    expect(props.sectionOverrides?.['pull-request']?.hasContent).toBe(false);
    expect(props.sectionOverrides?.['background-processes']?.hasContent).toBe(
      false,
    );
    expect(props.sectionOverrides?.['mcp-servers']?.hasContent).toBe(false);
    expect(props.sectionOverrides?.['mcp-servers']?.hasAction).toBe(true);
    expect(props.sectionOverrides?.['mcp-servers']?.headerAction).toBeNull();
    expect(props.sectionOverrides?.['mcp-servers']?.actionCard).toBe(true);
    expect(
      container.querySelector('[data-testid="activity-mcp-add"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="mcp-servers-card-refresh"]'),
    ).toBeNull();
    for (const id of [
      'pull-request',
      'background-processes',
      'plans',
      'pipeline-runs',
      'scripts',
      'hooks',
      'todo',
    ]) {
      expect(props.sectionOverrides?.[id]?.subtitle).toBe(`${id} chrome`);
      expect(props.sectionOverrides?.[id]?.collapsedIconColor).toBeDefined();
    }
    expect(props.sectionOverrides?.['mcp-servers']?.title).toBe(
      'Add MCP server',
    );
    expect(props.sectionOverrides?.['mcp-servers']?.subtitle).toBeNull();
    const attachments = props.extraSections?.find(
      (section) => section.key === 'attachments',
    );
    expect(attachments?.actionCard).toBe(false);
    expect(attachments?.subtitle).toBe('attachments chrome');
    expect(attachments?.collapsedIconColor).toBe('amber');
    for (const id of ['notes', 'prompts']) {
      const section = props.extraSections?.find((item) => item.key === id);
      expect(section?.subtitle).toBe(`${id} chrome`);
      expect(section?.collapsedIconColor).toBe('amber');
    }
  });

  it.each([
    [false, 'Changed files', 'Agent tasks'],
    [true, 'Changed files', 'Agent tasks'],
  ] as const)(
    'names sections for early access %s',
    (earlyAccess, changedFiles, agentTasks) => {
      setTestEarlyAccessFeatures({ enabled: earlyAccess });
      try {
        act(() => root.render(<SharedActivityPanelAdapter />));
        const calls = jest.mocked(SharedActivityPanel).mock.calls;
        const props = calls[calls.length - 1][0];
        expect(props.sectionOverrides?.['changed-files']?.title).toBe(
          changedFiles,
        );
        expect(props.sectionOverrides?.todo?.title).toBe(agentTasks);
        // The PR section header is plural.
        expect(props.sectionOverrides?.['pull-request']?.title).toBe(
          'Pull requests',
        );
      } finally {
        resetExperimentalFeaturesStoreForTest();
      }
    },
  );

  it('renders an empty activity root without a selected worktree', () => {
    useChatStore.setState({ selectedWorktree: null });
    act(() => root.render(<SharedActivityPanelAdapter />));
    expect(
      container.querySelector('[data-testid="activity-panel"]'),
    ).not.toBeNull();
    expect(jest.mocked(SharedActivityPanel)).not.toHaveBeenCalled();
  });

  it('keeps an unresolved Cost scope empty and puts the rail section after Pipeline runs, with Early access off', async () => {
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    // Resolve the production lazy source before rendering so its async
    // chunk boundary does not make this state assertion timing-dependent.
    await import('../cost/CostActivityScopeSource');

    await act(async () => {
      root.render(<SharedActivityPanelAdapter layout="stack" />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    const calls = jest.mocked(SharedActivityPanel).mock.calls;
    const props = calls[calls.length - 1][0];
    expect(jest.mocked(useCostScopeStore)).toHaveBeenCalled();
    expect(jest.mocked(useCostScopeStore)).toHaveBeenCalledWith(
      expect.any(Object),
      { kind: 'entry', projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    );
    expect(props.sectionOrder?.indexOf('cost')).toBe(
      (props.sectionOrder?.indexOf('pipeline-runs') ?? -2) + 1,
    );
    expect(Object.keys(props.sectionOverrides ?? {})).toContain('cost');
    expect(props.sectionOverrides?.cost?.hidden).toBeUndefined();
    expect(props.sectionOverrides?.cost?.hasContent).toBe(false);
    expect(props.sectionOverrides?.cost?.hasAction).toBe(true);
    expect(props.sectionOverrides?.cost?.headerAction).toBeDefined();
    expect(props.sectionOverrides?.cost?.dataTestId).toBe(
      'activity-section-cost',
    );
    expect(props.sectionOverrides?.cost?.cardValue).toBeUndefined();
  });

  it('drops the Cost section and its scope read for a credits-only account (CAN-5028)', async () => {
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    await import('../cost/CostActivityScopeSource');
    setRendererBillingLaneAvailability({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: true,
    });
    jest.mocked(useCostScopeStore).mockClear();

    await act(async () => {
      root.render(<SharedActivityPanelAdapter layout="card" />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    const calls = jest.mocked(SharedActivityPanel).mock.calls;
    const props = calls[calls.length - 1][0];
    expect(jest.mocked(useCostScopeStore)).not.toHaveBeenCalled();
    // The order is the persisted one; a dropped section is hidden, with no
    // body, header action or card value of its own.
    expect(props.sectionOverrides?.cost).toEqual({ hidden: true });
  });

  it('keeps the Cost section while the account facts are unknown or include a subscription', async () => {
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    await import('../cost/CostActivityScopeSource');

    await act(async () => {
      root.render(<SharedActivityPanelAdapter layout="card" />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    let calls = jest.mocked(SharedActivityPanel).mock.calls;
    expect(
      calls[calls.length - 1][0].sectionOverrides?.cost?.hidden,
    ).toBeUndefined();

    await act(async () => {
      setRendererBillingLaneAvailability({
        claudeNativeAuth: false,
        codexNativeAuth: true,
        creditsEligible: true,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    calls = jest.mocked(SharedActivityPanel).mock.calls;
    const props = calls[calls.length - 1][0];
    expect(props.sectionOverrides?.cost?.hidden).toBeUndefined();
    expect(props.sectionOverrides?.cost?.dataTestId).toBe(
      'activity-section-cost',
    );
  });

  it('shows a successful Cost total in the Activity card and hides it after a failed read', async () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    await import('../cost/CostActivityScopeSource');
    mockCostScopeRead = {
      value: {
        totals: { usd: 21.66 },
        chats: [{}],
        pipelineRuns: [],
      },
      problem: null,
    };

    await act(async () => {
      root.render(<SharedActivityPanelAdapter layout="card" />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    let calls = jest.mocked(SharedActivityPanel).mock.calls;
    let props = calls[calls.length - 1][0];
    expect(props.sectionOverrides?.cost?.hasContent).toBe(true);
    expect(props.sectionOverrides?.cost?.cardValue).toBeDefined();
    expect(props.sectionOverrides?.cost?.headerAction).toBeUndefined();

    mockCostScopeRead = {
      value: {
        totals: { usd: 21.66 },
        chats: [{}],
        pipelineRuns: [],
      },
      problem: { kind: 'error' },
    };
    await act(async () => {
      root.render(<SharedActivityPanelAdapter layout="card" />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    calls = jest.mocked(SharedActivityPanel).mock.calls;
    props = calls[calls.length - 1][0];
    expect(props.sectionOverrides?.cost?.hasContent).toBe(false);
    expect(props.sectionOverrides?.cost?.cardValue).toBeUndefined();
  });

  it('keeps empty summary generation compact and offers adding MCP servers', () => {
    useActivityStore.setState({ worktreeSummaries: {} });
    mockMcpLoading = true;
    act(() => root.render(<SharedActivityPanelAdapter />));
    const calls = jest.mocked(SharedActivityPanel).mock.calls;
    const props = calls[calls.length - 1][0];
    expect(props.sectionOverrides?.summary?.hasContent).toBe(false);
    expect(props.sectionOverrides?.summary?.title).toBe('Generating summary…');
    expect(props.sectionOverrides?.summary?.actionCard).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="activity-summary-generate"]',
      )?.disabled,
    ).toBe(true);
    expect(props.sectionOverrides?.summary?.subtitle).toBeNull();
    expect(props.sectionOverrides?.['mcp-servers']?.hasContent).toBe(false);
    expect(props.sectionOverrides?.['mcp-servers']?.title).toBe(
      'Add MCP server',
    );
    expect(props.sectionOverrides?.['mcp-servers']?.actionCard).toBe(true);
    expect(props.sectionOverrides?.['mcp-servers']?.headerAction).toBeNull();
  });

  it('keeps pipeline-owned Dispatch mounted when the card is collapsed', () => {
    act(() => root.render(<SharedActivityPanelAdapter />));
    const calls = jest.mocked(SharedActivityPanel).mock.calls;
    const pipeline =
      calls[calls.length - 1][0].sectionOverrides?.['pipeline-runs'];
    expect(pipeline?.keepBodyMountedWhenCollapsed).toBe(true);
    const plugins = calls[calls.length - 1][0].extraSections?.find(
      (section) => section.key === 'plugins',
    );
    expect(plugins?.keepBodyMountedWhenCollapsed).toBe(true);
  });

  it("forwards the worktree's section expand requests to shared chrome", () => {
    useActivitySectionRevealStore.setState({ expandRequests: {} });
    act(() => root.render(<SharedActivityPanelAdapter />));
    const latestPipelineOverride = ():
      | { readonly expandRequest?: number }
      | undefined => {
      const calls = jest.mocked(SharedActivityPanel).mock.calls;
      return calls[calls.length - 1][0].sectionOverrides?.['pipeline-runs'];
    };
    expect(latestPipelineOverride()?.expandRequest).toBeUndefined();

    const reveal = useActivitySectionRevealStore.getState();
    act(() => reveal.requestSectionExpand('other/worktree', 'pipeline-runs'));
    expect(latestPipelineOverride()?.expandRequest).toBeUndefined();

    act(() =>
      reveal.requestSectionExpand(
        `${PROJECT_ID}/${WORKTREE_ID}`,
        'pipeline-runs',
      ),
    );
    const first = latestPipelineOverride()?.expandRequest;
    expect(first).toEqual(expect.any(Number));

    act(() =>
      reveal.requestSectionExpand(
        `${PROJECT_ID}/${WORKTREE_ID}`,
        'pipeline-runs',
      ),
    );
    expect(latestPipelineOverride()?.expandRequest).not.toBe(first);
  });

  it('does not advertise an empty MCP selection before initial detection finishes', () => {
    mockMcpInitializing = true;
    mockMcpLoading = true;
    act(() => root.render(<SharedActivityPanelAdapter />));
    const calls = jest.mocked(SharedActivityPanel).mock.calls;
    expect(
      calls[calls.length - 1][0].sectionOverrides?.['mcp-servers']?.hasContent,
    ).toBe(true);
  });

  it('keeps the last known empty MCP answer while a remount re-detects', () => {
    act(() => root.render(<SharedActivityPanelAdapter />));
    act(() => root.unmount());
    root = createRoot(container);
    jest.mocked(SharedActivityPanel).mockClear();
    mockMcpInitializing = true;
    mockMcpLoading = true;
    act(() => root.render(<SharedActivityPanelAdapter />));
    const calls = jest.mocked(SharedActivityPanel).mock.calls;
    expect(
      calls[calls.length - 1][0].sectionOverrides?.['mcp-servers']?.hasContent,
    ).toBe(false);
  });

  it('hides empty Memory while keeping its watcher mounted', () => {
    act(() => root.render(<SharedActivityPanelAdapter />));
    const initialCalls = jest.mocked(SharedActivityPanel).mock.calls;
    expect(
      initialCalls[initialCalls.length - 1][0].extraSections?.find(
        (section) => section.key === 'memory',
      )?.hiddenWhileMounted,
    ).toBe(true);
    act(() => mockMemoryEmptyChange?.(true));
    let calls = jest.mocked(SharedActivityPanel).mock.calls;
    let memory = calls[calls.length - 1][0].extraSections?.find(
      (section) => section.key === 'memory',
    );
    expect(memory?.title).toBe('Memory');
    expect(memory?.hiddenWhileMounted).toBe(true);
    expect(memory?.hasContent).toBe(false);
    expect(memory?.actionCard).toBe(false);
    expect(memory?.keepBodyMountedWhenCollapsed).toBe(true);
    act(() => mockMemoryEmptyChange?.(false));
    calls = jest.mocked(SharedActivityPanel).mock.calls;
    memory = calls[calls.length - 1][0].extraSections?.find(
      (section) => section.key === 'memory',
    );
    expect(memory?.title).toBe('Memory');
    expect(memory?.hasContent).toBe(true);
    expect(memory?.hiddenWhileMounted).toBe(false);
  });

  it('keeps failure-only pipeline and pull request bodies mounted', () => {
    mockPipelineRunsChrome = {
      subtitle: 'No pipeline runs',
      collapsedIconColor: 'muted',
      hasContent: true,
    };
    mockPullRequestChrome = {
      subtitle: 'No pull request',
      collapsedIconColor: 'muted',
      hasContent: true,
    };

    act(() => root.render(<SharedActivityPanelAdapter />));

    const calls = jest.mocked(SharedActivityPanel).mock.calls;
    const props = calls[calls.length - 1][0];
    expect(props.sectionOverrides?.['pipeline-runs']?.hasContent).toBe(true);
    expect(props.sectionOverrides?.['pipeline-runs']?.actionCard).toBe(false);
    expect(props.sectionOverrides?.['pull-request']?.hasContent).toBe(true);
  });
});
