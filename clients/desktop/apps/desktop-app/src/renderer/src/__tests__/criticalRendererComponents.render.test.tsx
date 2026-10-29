import type * as ComposerPlusMenuModule from '@/components/shared/ComposerPlusMenu';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX, ReactNode } from 'react';
import { CanopyClientProvider } from '@canopy/app-state';
import { createFakeClient } from '@canopy/app-state/__tests__/fake-org-projects-client';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  AgentProviderAuthStatus,
  ChatProjectData,
  DiffStats,
  GitHubCliStatus,
  GitHubPermissionsStatus,
  LinearStatus,
  MultiRepoSidebarItem,
  OllamaModelEntry,
  RepoBranchInfo,
  SingleRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import type { ActiveComposerView } from '@/components/chat/types';
import type * as CancelRunningChatShortcutModule from '@/components/chat/useCancelRunningChatShortcut';
import { ChatInput } from '@/components/chat/ChatInput';
import { PrStatusBar } from '@/components/github/PrStatusBar';
import { AccountTab } from '@/components/settings/AccountTab';
import { OllamaModelCard } from '@/components/settings/OllamaTab';
import { ChatProjectSettingsModal } from '@/components/standalone-chat/ChatProjectSettingsModal';
import { ProjectSettingsModal } from '@/components/worktree/ProjectSettingsModal';
import { WorkspaceSettingsModal } from '@/components/worktree/WorkspaceSettingsModal';
import { WorktreeItem } from '@/components/worktree/WorktreeItem';
import { WorktreeManager } from '@/components/worktree/WorktreeManager';
import { withStartPageSuppressed } from '@/lib/panels/start-page-suppression';
import { useUpdateState } from '@/hooks/useUpdateState';
import { useComposerShortcutRequests } from '@/hooks/useComposerShortcutRequests';
import { useInvocableInventory } from '@/hooks/useInvocableInventory';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useScriptsStore } from '@/stores/scriptsStore';
import { useTerminalActivityStore } from '@/stores/terminalActivityStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { AddRepoToWorktreeModal } from '@/components/worktree/AddRepoToWorktreeModal';
import {
  AddRepoMenuItem,
  SplitWorkspaceMenuItem,
} from '@/components/worktree/WorktreeItem';

const mockUseStuckAgentTimer = jest.fn<
  number | null,
  [boolean, number | undefined, string | undefined]
>(() => null);
const mockUseCancelRunningChatShortcut = jest.fn();

jest.mock('@/components/chat/useCancelRunningChatShortcut', () => {
  const actual = jest.requireActual<typeof CancelRunningChatShortcutModule>(
    '@/components/chat/useCancelRunningChatShortcut',
  );
  return {
    ...actual,
    useCancelRunningChatShortcut: (options: unknown): void => {
      mockUseCancelRunningChatShortcut(options);
    },
  };
});

jest.mock('@dnd-kit/sortable', () => ({
  arrayMove: <T,>(items: T[]): T[] => items,
  SortableContext: ({ children }: { children: ReactNode }): JSX.Element => (
    <>{children}</>
  ),
  sortableKeyboardCoordinates: (): undefined => undefined,
  useSortable: (): {
    attributes: Record<string, never>;
    listeners: Record<string, never>;
    setNodeRef: (node: HTMLElement | null) => void;
    transform: null;
    transition: undefined;
    isDragging: boolean;
  } => ({
    attributes: {},
    listeners: {},
    setNodeRef: (): void => undefined,
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: {},
}));

jest.mock('@dnd-kit/core', () => ({
  closestCenter: (): null => null,
  DndContext: ({ children }: { children: ReactNode }): JSX.Element => (
    <>{children}</>
  ),
  DragOverlay: ({ children }: { children: ReactNode }): JSX.Element => (
    <>{children}</>
  ),
  KeyboardSensor: function KeyboardSensor(): void {
    return undefined;
  },
  PointerSensor: function PointerSensor(): void {
    return undefined;
  },
  useSensor: (): { id: string } => ({ id: 'sensor' }),
  useSensors: (...sensors: unknown[]): unknown[] => sensors,
}));

jest.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: (): undefined => undefined,
    },
  },
}));

jest.mock('@canopy/ui-rich/editor', () => ({
  COMPOSER_DENSITY_CLASS_NAMES: {
    comfortable: {
      container: 'mock-composer-container',
      editable: 'mock-composer-editable',
    },
  },
  SlateEditor: ({ placeholder }: { placeholder: string }): JSX.Element => (
    <div data-chat-textarea>{placeholder}</div>
  ),
  // The desktop composer renders the shared ComposerEditor (slice 3, PR 2);
  // it wraps SlateEditor, so the stub is the same placeholder box.
  ComposerEditor: ({ placeholder }: { placeholder?: string }): JSX.Element => (
    <div data-chat-textarea>{placeholder}</div>
  ),
  FileTypeaheadMenu: (): JSX.Element => <div>File typeahead</div>,
  SlashCommandMenu: (): JSX.Element => <div>Slash menu</div>,
  buildEditorValueFromMessage: (): unknown[] => [],
  createChatEditor: (): { children: unknown[]; selection: null } => ({
    children: [],
    selection: null,
  }),
  createEmptyValue: (): unknown[] => [],
  focusEditor: (): void => {},
  resetEditor: (): void => {},
  restoreEditorContent: (): void => {},
  serializeEditorValue: (): { text: string; fileReferences: unknown[] } => ({
    text: '',
    fileReferences: [],
  }),
}));

jest.mock('@/components/chat/ModelPicker', () => ({
  ModelPicker: ({ currentModel }: { currentModel?: string }): JSX.Element => (
    <span>Model picker {currentModel}</span>
  ),
}));

jest.mock('@/components/chat/DirectoryPicker', () => ({
  DirectoryPicker: (): JSX.Element => <span>Directory picker</span>,
}));

jest.mock('@/components/chat/UsageIndicator', () => ({
  UsageIndicator: (): JSX.Element => <span>Usage indicator</span>,
}));

jest.mock('@/components/chat/ChatPluginsModal', () => ({
  ChatPluginsModal: (): JSX.Element => <div>Chat plugins modal</div>,
}));

jest.mock('@/components/chat/AttachmentPillCarousel', () => ({
  AttachmentPillCarousel: (): JSX.Element => <div>Attachment pills</div>,
}));

jest.mock('@/components/shared', () => ({
  CopyButton: (): JSX.Element => <button type="button">Copy</button>,
  DialogModal: ({
    children,
    title,
  }: {
    children: ReactNode;
    title: ReactNode;
  }): JSX.Element => (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ),
  LoadingSpinner: (): JSX.Element => <span>Loading</span>,
}));

jest.mock('@/components/shared/PluginSelector', () => ({
  PluginSelector: (): JSX.Element => <div>Plugin selector</div>,
}));

jest.mock('@/components/worktree/AddRepoModal', () => ({
  AddRepoModal: (): JSX.Element => <div>Add repo modal</div>,
}));

jest.mock('@/components/home/HomeSurface', () => ({
  HomeSurface: (): JSX.Element => <div>Home surface</div>,
}));

jest.mock('@/components/worktree/TaskReadyPipelineModal', () => ({
  TaskReadyPipelineModal: (): JSX.Element => <div>Task pipeline modal</div>,
}));

jest.mock('@/components/worktree/ProjectSection', () => ({
  ProjectSection: ({
    project,
  }: {
    project: MultiRepoSidebarItem | SingleRepoSidebarItem;
  }): JSX.Element => (
    <section>
      <h2>{project.name}</h2>
      {project.worktrees.map((worktree) => (
        <div key={worktree.id}>{worktree.branchName}</div>
      ))}
    </section>
  ),
}));

jest.mock('@/components/worktree/TeardownFailureDialog', () => ({
  TeardownFailureDialog: (): JSX.Element => <div>Teardown failure</div>,
}));

jest.mock('@/components/worktree/WorktreeKanbanBoard', () => ({
  WorktreeKanbanBoard: (): JSX.Element => <div>Kanban board</div>,
}));

jest.mock('@/components/panels/WorktreePart', () => ({
  WorktreePart: (): JSX.Element => <section>Worktree panels</section>,
}));

jest.mock('@/components/worktree/OpenDropdown', () => ({
  OpenDropdown: (): JSX.Element => <button type="button">Open dropdown</button>,
}));

jest.mock('@/components/github/CommitMessageReviewModal', () => ({
  CommitMessageReviewModal: (): JSX.Element => <div>Commit review modal</div>,
}));

jest.mock('@/components/github/LocalOnlyMergeConfirmationModal', () => ({
  LocalOnlyMergeConfirmationModal: (): JSX.Element => (
    <div>Local merge modal</div>
  ),
}));

jest.mock('@/hooks/useScriptEventSubscriptions', () => ({
  useScriptEventSubscriptions: (): void => undefined,
}));

jest.mock('@/hooks/useHookEventSubscriptions', () => ({
  useHookEventSubscriptions: (): void => undefined,
}));

jest.mock('@/hooks/useUpdateState', () => ({
  useUpdateState: jest.fn(),
}));

jest.mock('@/hooks/useComposerShortcutRequests', () => ({
  useComposerShortcutRequests: jest.fn(() => 0),
}));

jest.mock('@/hooks/useGitHubCliStatus', () => ({
  useGitHubCliStatus: (): GitHubCliStatus => ({
    authenticated: true,
    username: 'octocat',
    error: null,
    tokenSource: 'keyring',
    envOverride: false,
    envOverrideName: null,
    hasCredentialStoreLogin: true,
  }),
}));

jest.mock('@/hooks/useClaudeAuthStatus', () => ({
  useClaudeAuthStatus: (): AgentProviderAuthStatus => ({
    authenticated: true,
    accountLabel: 'Claude User',
    detail: 'claude.ai (max)',
    error: null,
  }),
}));

jest.mock('@/hooks/useCodexAuthStatus', () => ({
  useCodexAuthStatus: (): AgentProviderAuthStatus => ({
    authenticated: true,
    accountLabel: 'codex@example.com',
    detail: 'pro',
    error: null,
  }),
}));

jest.mock('@/hooks/useGitHubPermissions', () => ({
  invalidateGitHubPermissionsCache: (): void => undefined,
  useGitHubPermissions: (): GitHubPermissionsStatus => ({
    tokenAvailable: true,
    tokenType: 'classic',
    scopes: ['repo'],
    canListRepos: true,
    error: null,
    permissions: [
      {
        scope: 'contents',
        label: 'Contents',
        description: 'Read and write repository contents.',
        state: 'granted',
        required: true,
      },
    ],
  }),
}));

jest.mock('@/hooks/useLinearStatus', () => ({
  invalidateLinearStatusCache: (): void => undefined,
  useLinearStatus: (): LinearStatus => ({
    authenticated: true,
    displayName: 'Linear User',
    error: null,
  }),
  useLinearAvailability: (): {
    status: LinearStatus;
    available: boolean;
  } => ({
    status: { authenticated: true, displayName: 'Linear User', error: null },
    available: true,
  }),
}));

const mockComposerCommandCounts: number[] = [];
jest.mock('@/components/shared/ComposerPlusMenu', () => {
  const actual = jest.requireActual<typeof ComposerPlusMenuModule>(
    '@/components/shared/ComposerPlusMenu',
  );
  return {
    ...actual,
    ComposerPlusMenu: (
      props: React.ComponentProps<typeof actual.ComposerPlusMenu>,
    ): JSX.Element => {
      mockComposerCommandCounts.push(props.commands?.length ?? 0);
      return <actual.ComposerPlusMenu {...props} />;
    },
  };
});
jest.mock('@/hooks/useInvocableInventory', () => ({
  useInvocableInventory: jest.fn(() => ({
    entries: [],
    loading: false,
    stale: false,
    refresh: jest.fn(),
  })),
}));

jest.mock('@/hooks/useSlashCommands', () => ({
  getSlashCommandInsertText: (cmd: {
    insertText?: string;
    name: string;
  }): string => cmd.insertText ?? `/${cmd.name} `,
}));

jest.mock('@/hooks/useFileTypeahead', () => ({
  useFileTypeahead: (): {
    isOpen: boolean;
    query: string;
    filteredFiles: [];
    selectedIndex: number;
    onKeyDown: () => boolean;
    selectFile: () => void;
    close: () => void;
  } => ({
    isOpen: false,
    query: '',
    filteredFiles: [],
    selectedIndex: 0,
    onKeyDown: (): boolean => false,
    selectFile: (): void => undefined,
    close: (): void => undefined,
  }),
}));

jest.mock('@/hooks/useVoiceTranscription', () => ({
  useVoiceTranscription: (): {
    state: 'idle';
    error: null;
    errorGuidance: null;
    dismissError: () => void;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    cancel: () => Promise<void>;
  } => ({
    state: 'idle',
    error: null,
    errorGuidance: null,
    dismissError: (): void => undefined,
    start: (): Promise<void> => Promise.resolve(),
    stop: (): Promise<void> => Promise.resolve(),
    cancel: (): Promise<void> => Promise.resolve(),
  }),
}));

jest.mock('@/hooks/useStuckAgentTimer', () => ({
  useStuckAgentTimer: (
    isStreaming: boolean,
    lastEventAt: number | undefined,
    tabId: string | undefined,
  ): number | null => mockUseStuckAgentTimer(isStreaming, lastEventAt, tabId),
}));

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';

function makeWorktree(overrides: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id: WORKTREE_ID,
    branchName: 'feature/crap-coverage',
    createdAt: '2026-05-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeWorkspace(): MultiRepoSidebarItem {
  return {
    id: PROJECT_ID,
    type: 'multi-repo',
    name: 'Renderer Health Workspace',
    color: '#2563eb',
    repos: [
      {
        id: 'repo-1',
        name: 'app',
        repoPath: '/workspace/app',
        source: 'manifest',
      },
      {
        id: 'repo-2',
        name: 'docs',
        repoPath: '/workspace/docs',
        source: 'local',
      },
    ],
    worktrees: [makeWorktree()],
    collapsed: false,
    order: 0,
    sourceRepoPath: '/workspace/root',
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
    defaultPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
  };
}

function makeSingleRepoProject(): SingleRepoSidebarItem {
  return {
    id: PROJECT_ID,
    type: 'single-repo',
    name: 'Renderer Health Project',
    repoPath: '/workspace/single',
    color: '#16a34a',
    worktrees: [makeWorktree()],
    collapsed: false,
    order: 0,
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
    defaultPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
  };
}

function makeChatProject(): ChatProjectData {
  return {
    id: 'chat-project-1',
    name: 'Renderer Chat Project',
    createdAt: '2026-05-05T00:00:00.000Z',
    color: '#2563eb',
    description: 'Standalone chat project for render coverage',
    archiveRetentionDays: 14,
    defaultPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
  };
}

function makeTab(
  overrides: Partial<ActiveComposerView> = {},
): ActiveComposerView {
  return {
    id: 'chat-1',
    title: 'New Chat',
    status: 'idle',
    planMode: false,
    thinkingLevel: 'high',
    providerType: 'claude',
    hasStartedSession: false,
    ...overrides,
  };
}

function render(element: JSX.Element): string {
  // The renderer root mounts every surface inside `CanopyClientProvider`; the
  // composer's `!` typeahead reads the client's capabilities from it.
  return renderToStaticMarkup(
    <CanopyClientProvider client={createFakeClient().client}>
      {element}
    </CanopyClientProvider>,
  );
}

/** The class list of the first opening tag carrying `attribute`. React
 * escapes `>` inside attribute values, so a tag never contains a raw one. */
function classesOfTagWith(markup: string, attribute: string): string[] {
  const tag = new RegExp(`<[a-z]+\\b[^>]*\\s${attribute}[^>]*>`).exec(
    markup,
  )?.[0];
  return /\sclass="([^"]*)"/.exec(tag ?? '')?.[1]?.split(' ') ?? [];
}

function installRendererWindow(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        chatProject: {
          loadClaudeMd: (): Promise<string> => Promise.resolve(''),
          saveClaudeMd: (): Promise<void> => Promise.resolve(),
        },
        loadPreferences: (): Promise<{ sidebarCollapsed: boolean }> =>
          Promise.resolve({ sidebarCollapsed: false }),
        savePreferences: (): Promise<void> => Promise.resolve(),
      },
      devInfo: {
        isDev: true,
        branch: 'feature/crap-health',
      },
    },
  });
}

interface ServerRenderStore<T> {
  getState: () => T;
  getInitialState: () => T;
}

function syncCurrentStateForServerRender<T extends object>(
  store: ServerRenderStore<T>,
): void {
  Object.assign(store.getInitialState(), store.getState());
}

function resetRendererStores(
  workspace: MultiRepoSidebarItem | SingleRepoSidebarItem,
): void {
  installRendererWindow();
  useProjectsStore.setState({
    projects: [workspace],
    discoveryLoading: new Set(),
    diffStats: {},
    commitsAhead: {},
    baseBranches: {},
    repoBranches: {},
    uncommittedChanges: {},
    hasRemoteTracking: {},
    hasOriginRemote: {},
    hasUnpushedCommits: {},
    hasUnpulledCommits: {},
    hasBranchBeenPushed: {},
    baseBranchExistsLocally: {},
    baseBranchExistsInRemote: {},
    workspaceDrift: {},
    tearingDownWorktrees: new Set(),
    pendingWorkspaceRepair: null,
    workspaceRepairPending: false,
    pendingHookChatPluginInstallPrompt: null,
    pendingScrollToWorktree: null,
  });
  useChatStore.setState({
    selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    worktreeChats: {},
    unreadWorktreeKeys: new Set(),
    pendingPlanExits: {},
    pendingModelChanges: {},
    tabDiscoveryLoading: new Set(),
  });
  useGitHubStore.setState({
    prStatuses: {},
    creatingPr: new Set(),
    committingAndPushing: new Set(),
    mergingLocalBranches: new Set(),
    activeBranchSyncAction: {},
    commitPushProgress: {},
    commitReviewPending: {},
    splitLockedWorktrees: new Set<string>(),
    splitWorkflowSessions: new Set<string>(),
  });
  usePipelineRunsStore.setState({
    runningExecutionsByWorktree: {},
    pausedExecutionsByWorktree: {},
    unseenPipelineWorktreeKeys: new Set(),
    unseenFailedPipelineWorktreeKeys: new Set(),
    pipelineSummariesByWorktree: {},
  });
  useScriptsStore.setState({
    runs: {},
  });
  useActivityStore.setState({
    panelExpanded: false,
  });
  useNavigationStore.setState({
    activePage: 'main',
  });
  useTerminalActivityStore.setState({
    entriesByWorktree: {},
  });
  useTerminalStore.setState({
    worktrees: {},
    terminalCustomNames: {},
    groupCustomNames: {},
  });
  syncCurrentStateForServerRender(useProjectsStore);
  syncCurrentStateForServerRender(useChatStore);
  syncCurrentStateForServerRender(useGitHubStore);
  syncCurrentStateForServerRender(usePipelineRunsStore);
  syncCurrentStateForServerRender(useScriptsStore);
  syncCurrentStateForServerRender(useActivityStore);
  syncCurrentStateForServerRender(useNavigationStore);
  syncCurrentStateForServerRender(useTerminalActivityStore);
  syncCurrentStateForServerRender(useTerminalStore);
  jest.mocked(useUpdateState).mockReturnValue({
    appVersion: '0.21.18',
    dependencyVersions: null,
    state: { phase: 'idle' },
    refresh: (): Promise<void> => Promise.resolve(),
  });
}

function makeRepoBranch(
  overrides: Partial<RepoBranchInfo> = {},
): RepoBranchInfo {
  return {
    repoId: 'repo-1',
    repoName: 'app',
    branch: 'feature/crap-coverage',
    baseBranch: 'main',
    hasUncommittedChanges: false,
    hasRemoteTrackingBranch: true,
    hasUnpushedCommits: false,
    hasUnpulledCommits: false,
    hasBranchBeenPushed: true,
    baseBranchExistsLocally: true,
    baseBranchExistsInRemote: true,
    hasOriginRemote: true,
    ...overrides,
  };
}

function makePrStatus(): WorktreePrStatus {
  return {
    lastCheckedAt: '2026-05-05T12:00:00.000Z',
    repos: [
      {
        repoId: 'repo-1',
        repoName: 'app',
        status: {
          prNumber: 42,
          prUrl: 'https://github.com/example/app/pull/42',
          state: 'open',
          title: 'Improve renderer health',
          checkStatus: 'passing',
          checkDetails: [
            {
              name: 'unit',
              status: 'passing',
              detailsUrl: 'https://github.com/example/app/actions/1',
            },
          ],
          reviewStatus: 'approved',
          reviewers: [{ login: 'reviewer', state: 'approved' }],
          hasConflicts: false,
          commentCount: 3,
          updatedAt: '2026-05-05T12:00:00.000Z',
        },
      },
      {
        repoId: 'repo-2',
        repoName: 'docs',
        status: null,
      },
    ],
  };
}

function makeMergedPrStatus(): WorktreePrStatus {
  const prStatus = makePrStatus();
  return {
    ...prStatus,
    repos: prStatus.repos.map((repo, index) =>
      index === 0 && repo.status
        ? { ...repo, status: { ...repo.status, state: 'merged' } }
        : repo,
    ),
  };
}

function makeOllamaModel(): OllamaModelEntry {
  return {
    id: 'ollama-llama3:8b',
    rawModelId: 'llama3:8b',
    label: 'llama3:8b',
    sizeBytes: 4_294_967_296,
    sizeVramBytes: 2_147_483_648,
    modifiedAt: '2026-05-05T10:00:00.000Z',
    expiresAt: '2026-06-05T10:00:00.000Z',
    digest: 'sha256:0123456789abcdef0123456789abcdef',
    details: {
      family: 'llama',
      families: ['llama', 'clip'],
      format: 'gguf',
      parameterSize: '8B',
      parentModel: 'llama3',
      quantizationLevel: 'Q4_K_M',
    },
    show: {
      capabilities: ['completion'],
      system: 'You are concise.',
      template: '{{ .Prompt }}',
      parameters: 'temperature 0.2',
      license: 'MIT',
      messages: [
        {
          role: 'system',
          content: 'Answer directly.',
          thinking: 'hidden',
          toolName: 'tool',
        },
      ],
      rawJson: '{"model":"llama3:8b"}',
    },
  };
}

describe('critical renderer component health coverage', () => {
  beforeEach(() => {
    mockComposerCommandCounts.length = 0;
    jest.mocked(useInvocableInventory).mockClear();
    jest.mocked(useComposerShortcutRequests).mockClear();
    mockUseStuckAgentTimer.mockClear();
    mockUseCancelRunningChatShortcut.mockClear();
    resetRendererStores(makeWorkspace());
  });

  it('loads the Cursor inventory for a Cursor composer', () => {
    render(
      <ChatInput
        tab={makeTab({ providerType: 'cursor', model: 'cursor-default' })}
      />,
    );
    expect(useInvocableInventory).toHaveBeenCalledWith('cursor');
  });

  it('keeps slash commands in the unified menu for Cursor', () => {
    render(<ChatInput tab={makeTab({ providerType: 'claude' })} />);
    expect(
      mockComposerCommandCounts[mockComposerCommandCounts.length - 1],
    ).toBeGreaterThan(0);
    render(
      <ChatInput
        tab={makeTab({ providerType: 'cursor', model: 'cursor-default' })}
      />,
    );
    expect(
      mockComposerCommandCounts[mockComposerCommandCounts.length - 1],
    ).toBeGreaterThan(0);
  });

  it('keeps the unified action trigger for Claude and Cursor', () => {
    for (const providerType of ['claude', 'cursor'] as const) {
      const markup = render(
        <ChatInput
          tab={makeTab({
            providerType,
            ...(providerType === 'cursor' ? { model: 'cursor-default' } : {}),
          })}
        />,
      );
      expect(markup).toContain('data-testid="chat-input-plus-button"');
    }
  });

  it('renders the active chat composer shell', () => {
    const markup = render(<ChatInput tab={makeTab()} />);

    expect(markup).toContain('@ to mention, / skills and commands');
    // The centered 768px shell includes 16px side padding around a 736px card.
    expect(markup).toContain(
      'relative z-30 mx-auto w-full max-w-[var(--chat-composer-shell-width)] chat-width-transition shrink-0 px-4 pt-2 pb-2',
    );
    // The main chat now shares the New Task composer's rounder capsule card
    // and restrained elevation rather than the older dense-toolbar shell.
    expect(markup).toContain(
      'rounded-2xl bg-[var(--bg-composer,var(--bg-tertiary))] shadow-lg',
    );
    expect(markup).toContain('More actions');
    expect(markup).toContain('Model picker');
    expect(markup).toContain('Usage indicator');
  });

  it('records the composer box and blocks only the draft paragraphs', () => {
    const markup = render(<ChatInput tab={makeTab()} />);

    // The box and the editable record, so focusing the composer counts as
    // activity for the recorder. SlateEditor blocks each draft paragraph.
    const box = classesOfTagWith(markup, 'data-composer-layout=');
    expect(box).not.toContain(POSTHOG_REPLAY_BLOCK_CLASS);
    expect(box.join(' ')).toContain(
      'rounded-2xl bg-[var(--bg-composer,var(--bg-tertiary))] shadow-lg',
    );
    expect(classesOfTagWith(markup, 'data-chat-textarea')).not.toContain(
      POSTHOG_REPLAY_BLOCK_CLASS,
    );
    // Notices carry no conversation, output, file, or secret content.
    expect(
      classesOfTagWith(markup, 'data-testid="chat-input-notices"'),
    ).toEqual(['mb-2', 'flex', 'flex-col', 'gap-2', 'empty:hidden']);
    // The status row (model, effort, approval mode, usage) stays recorded.
    expect(classesOfTagWith(markup, 'data-chat-composer-root')).not.toContain(
      POSTHOG_REPLAY_BLOCK_CLASS,
    );
  });

  it.each(['idle', 'streaming'] as const)(
    'puts pending model feedback inside the disabled %s action button',
    (status) => {
      const tab = makeTab({ status });
      const label = status === 'streaming' ? 'Stop generation' : 'Send message';
      const actionButton = (): string => {
        const markup = render(<ChatInput tab={tab} />);
        const buttons =
          markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
        const button = buttons.find((entry) =>
          entry.includes(`aria-label="${label}"`),
        );
        expect(button).toBeDefined();
        return button ?? '';
      };
      expect(actionButton()).not.toContain('chat-model-change-pending');
      useChatStore.setState({
        pendingModelChanges: {
          [`${PROJECT_ID}/${WORKTREE_ID}/chat-1`]: {
            requestId: 'pending-model',
            model: 'gpt-5.6-luna',
          },
        },
      });
      syncCurrentStateForServerRender(useChatStore);
      const busyButton = actionButton();
      expect(busyButton).toContain('chat-model-change-pending');
      expect(busyButton).toContain('disabled=""');
      expect(busyButton).toContain('aria-busy="true"');
      expect(busyButton).toContain('h-8 w-8');
      expect(busyButton).not.toContain('<svg');
      expect(render(<ChatInput tab={tab} />)).not.toContain(
        'role="status" aria-label="Updating model"',
      );
      useChatStore.setState({ pendingModelChanges: {} });
      syncCurrentStateForServerRender(useChatStore);
      expect(actionButton()).not.toContain('chat-model-change-pending');
      expect(actionButton()).toContain('<svg');
      if (status === 'streaming')
        expect(actionButton()).not.toContain('disabled=""');
    },
  );

  it('does not run the stuck-agent timer during an active agent step', () => {
    render(
      <ChatInput
        tab={makeTab({
          status: 'streaming',
          lastEventAt: 123,
          hasActiveAgentStep: true,
        })}
      />,
    );

    expect(mockUseStuckAgentTimer).toHaveBeenCalledWith(false, 123, 'chat-1');
  });

  it('does not let an inline queued editor own the global cancel shortcut', () => {
    render(
      <ChatInput
        tab={makeTab({ status: 'streaming' })}
        editingState={{
          initialText: 'Queued prompt',
          initialFileReferences: [],
          attachments: [],
          onAddAttachments: jest.fn(),
          onRemoveAttachment: jest.fn(),
          onCancel: jest.fn(),
          onSave: jest.fn(),
        }}
      />,
    );

    expect(mockUseCancelRunningChatShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, active: false }),
    );
  });

  it('keeps the default composer shell styling in plan mode', () => {
    const markup = render(<ChatInput tab={makeTab({ planMode: true })} />);

    expect(markup).toContain(
      'rounded-2xl bg-[var(--bg-composer,var(--bg-tertiary))] shadow-lg',
    );
    expect(markup).toContain('bg-warning-subtle fg-warning');
    expect(markup).toContain('<span>Plan</span>');
    expect(markup).not.toContain('bg-fg-primary/[0.04]');
    expect(markup).not.toContain('border:0.5px dashed rgba(245, 158, 11, 0.5)');
    expect(markup).not.toContain('background-color:rgba(245, 158, 11, 0.15)');
  });

  it('leaves Plan in the + menu until it is on', () => {
    const markup = render(<ChatInput tab={makeTab({ planMode: false })} />);

    expect(markup).not.toContain('chat-input-plan-mode-inline-button');
    expect(markup).not.toContain('<span>Plan</span>');
  });

  it('uses the selected worktree model default while the composer tab loads', () => {
    useChatStore.setState({
      modelDefaults: {
        chatProvider: 'claude',
        chatModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
          ollama: null,
        },
        worktreeProvider: 'codex',
        worktreeModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
          ollama: null,
        },
      },
    });
    syncCurrentStateForServerRender(useChatStore);

    const markup = render(<ChatInput tab={null} />);

    expect(markup).toContain('Model picker gpt-5.5');
  });

  it('hides the plan mode toggle in standalone chat', () => {
    useChatStore.setState({
      selectedWorktree: {
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'standalone-project',
      },
    });
    syncCurrentStateForServerRender(useChatStore);

    const markup = render(<ChatInput tab={makeTab({ planMode: true })} />);

    expect(markup).not.toContain('Toggle plan mode');
  });

  it('hides App Advisor plan controls including restored approval bars', () => {
    useChatStore.setState({
      pendingPlanExits: {
        'plan-approval-1': {
          requestId: 'plan-approval-1',
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          chatId: 'chat-1',
          source: 'codex',
          toolInput: {
            plan: 'Edit the app.',
            source: 'codex',
          },
        },
      },
    });
    syncCurrentStateForServerRender(useChatStore);

    const markup = render(<ChatInput tab={makeTab()} hidePlanMode />);

    expect(markup).not.toContain('Toggle plan mode');
    expect(markup).not.toContain('Copy plan');
    expect(markup).not.toContain('Approve plan');
  });

  it('hides the working-directory picker when requested', () => {
    const defaultMarkup = render(<ChatInput tab={makeTab()} />);
    const hiddenMarkup = render(
      <ChatInput tab={makeTab()} hideDirectoryPicker />,
    );

    expect(defaultMarkup).toContain('Directory picker');
    expect(hiddenMarkup).not.toContain('Directory picker');
  });

  it('shows the working-directory picker in the settings row, after effort', () => {
    const markup = render(<ChatInput tab={makeTab()} />);

    // The settings row follows the box; the picker sits in it, after effort.
    const row = markup.indexOf('data-testid="chat-composer-status-row"');
    const effort = markup.indexOf(
      'data-testid="chat-input-thinking-level-button"',
    );
    const picker = markup.indexOf('Directory picker');
    expect(markup.indexOf('data-composer-layout')).toBeLessThan(row);
    expect(row).toBeGreaterThan(-1);
    expect(effort).toBeGreaterThan(row);
    expect(picker).toBeGreaterThan(effort);
  });

  it('renders the archived chat composer state', () => {
    const markup = render(<ChatInput tab={makeTab({ readOnly: true })} />);

    expect(markup).toContain('This session has been archived');
    // The shared banner the other notices above the composer use.
    expect(markup).toContain('data-notice-intent="neutral"');
    expect(markup).toContain('Messages are read-only.');
    expect(markup).toContain('Start new session');
    expect(markup).toContain('Hand off session');
    expect(useComposerShortcutRequests).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('renders a worktree row with activity indicators', () => {
    const stats: DiffStats = { insertions: 12, deletions: 4 };
    const markup = render(
      <WorktreeItem
        worktree={makeWorktree()}
        projectId={PROJECT_ID}
        stats={stats}
        isSelected
        isStreaming
        hasActiveSession={false}
        awaitingApproval
        hasUnread
        isDiscovering
        isRunningSetup={false}
        isRunningRun
        isTearingDown={false}
        pipelineStatus="running"
        terminalStatus="unseen"
        isMultiRepo
        repoBranches={[
          {
            repoId: 'repo-1',
            repoName: 'app',
            branch: 'feature/crap-coverage',
            baseBranch: 'main',
          },
          {
            repoId: 'repo-2',
            repoName: 'docs',
            branch: 'feature/docs',
            baseBranch: 'main',
          },
        ]}
        configRepos={makeWorkspace().repos}
        hasBranchBeenPushed={false}
        onSelect={(): void => undefined}
        onArchive={(): void => undefined}
        onCreateBranchWorktree={(): void => undefined}
        onToggleHidden={(): void => undefined}
        baseBranch="main"
        baseBranchExistsLocally
        baseBranchExistsInRemote
      />,
    );

    expect(markup).toContain('Multiple branches');
    // Pipeline state is carried by the leading indicator; in the finalized
    // chain the running-pipeline glyph outranks the approval shield in the
    // slot, and the classic subtitle no longer badges the pipeline.
    expect(markup).toContain('worktree-row-working-pipeline');
    expect(markup).not.toContain('worktree-row-awaiting-approval');
    expect(markup).not.toContain('worktree-row-pipeline-badge');
    expect(markup).toContain('Terminal completed');
  });

  it('uses last-known PR status for a done worktree row before live PR status hydrates', () => {
    const workspace = makeWorkspace();
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    const worktree = makeWorktree({
      status: 'done',
      lastKnownPrStatus: makeMergedPrStatus(),
    });
    resetRendererStores(workspace);
    syncCurrentStateForServerRender(useGitHubStore);

    const markup = render(
      <WorktreeItem
        worktree={worktree}
        projectId={PROJECT_ID}
        hasActiveSession={false}
        awaitingApproval={false}
        hasUnread={false}
        isDiscovering={false}
        isRunningSetup={false}
        isRunningRun={false}
        isTearingDown={false}
        isMultiRepo={false}
        configRepos={makeWorkspace().repos}
        hasBranchBeenPushed={false}
        onSelect={(): void => undefined}
        onArchive={(): void => undefined}
        onCreateBranchWorktree={(): void => undefined}
        onToggleHidden={(): void => undefined}
        baseBranchExistsLocally
        baseBranchExistsInRemote
      />,
    );

    expect(useGitHubStore.getState().prStatuses[key]).toBeUndefined();
    expect(markup).toContain('PR merged');
    expect(markup).toContain('data-testid="worktree-row-leading-slot"');
    expect(markup).not.toContain('data-testid="worktree-drag-handle"');
    expect(markup).not.toContain(`aria-label="Reorder ${worktree.branchName}"`);
    expect(markup).toContain('cursor-default');
    expect(markup).not.toContain('cursor-grab');
    expect(markup).not.toContain('active:cursor-grabbing');
    expect(markup).toContain('data-testid="worktree-archive-button"');
    // The quick-access chip is always the Delete action (retention keeps the
    // removed worktree for the workspace's window).
    expect(markup).toContain(`aria-label="Delete ${worktree.branchName}"`);
  });

  it('does not use stale last-known PR status after live PR status clears', () => {
    const workspace = makeWorkspace();
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    const worktree = makeWorktree({
      status: 'done',
      lastKnownPrStatus: makeMergedPrStatus(),
    });
    resetRendererStores(workspace);
    useGitHubStore.setState({
      prStatuses: {
        [key]: null,
      },
    });
    syncCurrentStateForServerRender(useGitHubStore);

    const markup = render(
      <WorktreeItem
        worktree={worktree}
        projectId={PROJECT_ID}
        hasActiveSession={false}
        awaitingApproval={false}
        hasUnread={false}
        isDiscovering={false}
        isRunningSetup={false}
        isRunningRun={false}
        isTearingDown={false}
        isMultiRepo={false}
        configRepos={makeWorkspace().repos}
        hasBranchBeenPushed={false}
        onSelect={(): void => undefined}
        onArchive={(): void => undefined}
        onCreateBranchWorktree={(): void => undefined}
        onToggleHidden={(): void => undefined}
        baseBranchExistsLocally
        baseBranchExistsInRemote
      />,
    );

    expect(markup).toContain('Done');
    expect(markup).not.toContain('PR merged');
  });

  it('renders a project settings repositories panel', () => {
    const workspace = makeWorkspace();
    const markup = render(
      <WorkspaceSettingsModal
        isOpen
        onClose={(): void => undefined}
        workspace={workspace}
      />,
    );

    expect(markup).toContain('Renderer Health Workspace');
    expect(markup).toContain('Repositories');
    expect(markup).toContain('/workspace/app');
  });

  it('keeps project instructions read-only until their initial load finishes', () => {
    const markup = render(
      <WorkspaceSettingsModal
        isOpen
        initialTab="claude-md"
        onClose={(): void => undefined}
        workspace={makeWorkspace()}
      />,
    );

    expect(markup).toContain('data-testid="workspace-instructions-textarea"');
    expect(markup).toContain('readOnly=""');
    expect(markup).toContain('aria-readonly="true"');
    expect(markup).not.toContain('Initialize');
  });

  it('renders a project settings hooks panel with no configured hooks', () => {
    const workspace = makeWorkspace();
    const markup = render(
      <WorkspaceSettingsModal
        isOpen
        initialTab="hooks"
        onClose={(): void => undefined}
        workspace={workspace}
      />,
    );

    expect(markup).toContain('Hooks');
    expect(markup).toContain('Project root');
    expect(markup).toContain('Add hook action');
  });

  it('defaults temporary project promotion to the derived repo-list name', () => {
    const workspace = {
      ...makeWorkspace(),
      name: 'Stored Temporary Name',
      temporary: true,
      sourceRepoPath: undefined,
    };
    const markup = render(
      <WorkspaceSettingsModal
        isOpen
        initialTab="details"
        onClose={(): void => undefined}
        workspace={workspace}
      />,
    );

    expect(markup).toContain('data-testid="temporary-workspace-promotion"');
    expect(markup).toContain('value="app &amp; docs"');
    expect(markup).not.toContain('value="Stored Temporary Name"');
    expect(markup).not.toContain('Default branch');
    expect(markup).not.toContain('Source repo missing');
  });

  it('hides permanent-workspace danger controls for temporary projects', () => {
    const workspace = {
      ...makeWorkspace(),
      temporary: true,
      sourceRepoPath: undefined,
    };
    const markup = render(
      <WorkspaceSettingsModal
        isOpen
        initialTab="danger"
        onClose={(): void => undefined}
        workspace={workspace}
      />,
    );

    expect(markup).not.toContain('Convert to single-repo project');
    expect(markup).toContain('Delete project');
  });

  it('renders the pull request status bar for a multi-repo worktree', () => {
    const workspace = makeWorkspace();
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    const repoBranches: RepoBranchInfo[] = [
      makeRepoBranch({
        repoId: 'repo-1',
        repoName: 'app',
        hasUnpushedCommits: true,
      }),
      makeRepoBranch({
        repoId: 'repo-2',
        repoName: 'docs',
        branch: 'feature/docs-health',
        hasRemoteTrackingBranch: false,
        hasUncommittedChanges: true,
      }),
    ];
    resetRendererStores(workspace);
    useProjectsStore.setState({
      commitsAhead: { [key]: true },
      baseBranches: { [key]: 'main' },
      repoBranches: { [key]: repoBranches },
      uncommittedChanges: { [key]: true },
      hasRemoteTracking: { [key]: true },
      hasOriginRemote: { [key]: true },
      hasUnpushedCommits: { [key]: true },
      hasUnpulledCommits: { [key]: false },
      hasBranchBeenPushed: { [key]: true },
      baseBranchExistsLocally: { [key]: true },
      baseBranchExistsInRemote: { [key]: true },
    });
    useGitHubStore.setState({
      prStatuses: { [key]: makePrStatus() },
    });
    syncCurrentStateForServerRender(useProjectsStore);
    syncCurrentStateForServerRender(useGitHubStore);

    const markup = render(
      <PrStatusBar
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        viewMode="list"
        viewModeReady
      />,
    );

    expect(markup).toContain('Multiple branches');
    expect(markup).toContain('1 PR');
    expect(markup).toContain('aria-label="CI passing"');
    expect(markup).toContain('Open dropdown');
  });

  it('renders New branch for a default pull request status bar branch label', () => {
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    const project = makeSingleRepoProject();
    project.worktrees = [
      makeWorktree({
        branchName: `${WORKTREE_ID}-1713571200123`,
      }),
    ];
    resetRendererStores(project);
    useProjectsStore.setState({
      baseBranches: { [key]: 'main' },
      hasBranchBeenPushed: { [key]: false },
    });
    syncCurrentStateForServerRender(useProjectsStore);

    const markup = render(
      <PrStatusBar
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        viewMode="list"
        viewModeReady
      />,
    );

    expect(markup).toContain('New branch');
  });

  it('renders a create PR action for a changed repo when another repo already has a PR', () => {
    const workspace = makeWorkspace();
    const key = `${PROJECT_ID}/${WORKTREE_ID}`;
    const repoBranches: RepoBranchInfo[] = [
      makeRepoBranch({ repoId: 'repo-1', repoName: 'app' }),
      makeRepoBranch({
        repoId: 'repo-2',
        repoName: 'docs',
        hasUncommittedChanges: true,
      }),
    ];
    resetRendererStores(workspace);
    useProjectsStore.setState({
      commitsAhead: { [key]: true },
      baseBranches: { [key]: 'main' },
      repoBranches: { [key]: repoBranches },
      uncommittedChanges: { [key]: true },
      hasRemoteTracking: { [key]: true },
      hasOriginRemote: { [key]: true },
      hasUnpushedCommits: { [key]: false },
      hasUnpulledCommits: { [key]: false },
      hasBranchBeenPushed: { [key]: true },
      baseBranchExistsLocally: { [key]: true },
      baseBranchExistsInRemote: { [key]: true },
    });
    useGitHubStore.setState({
      prStatuses: { [key]: makePrStatus() },
    });
    syncCurrentStateForServerRender(useProjectsStore);
    syncCurrentStateForServerRender(useGitHubStore);

    const markup = render(
      <PrStatusBar
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        viewMode="list"
        viewModeReady
      />,
    );

    expect(markup).toContain('1 PR');
    // The button's VISIBLE copy stays short so it fits the header cluster
    // alongside `Open in` / Launch; the full consequence of the click
    // (commit + push, not just PR creation) is carried by the accessible
    // name, and confirmed again by the commit-review modal before anything
    // is committed.
    expect(markup).toContain('>Create PR<');
    expect(markup).not.toContain('>Commit, push &amp; create PR<');
    expect(markup).toContain('aria-label="Commit, push &amp; create PR"');
  });

  it('renders the installed Ollama model card metadata', () => {
    const markup = render(
      <OllamaModelCard
        model={makeOllamaModel()}
        deleting
        onDelete={(): void => undefined}
      />,
    );

    expect(markup).toContain('llama3:8b');
    expect(markup).toContain('Deleting…');
    expect(markup).toContain('required capabilities');
    expect(markup).toContain('Family: llama');
    expect(markup).toContain('Seed messages');
    expect(markup).toContain('Raw show() response');
  });

  it('renders the worktree manager chat/work shell on the main page', () => {
    // The in-page worktree list moved to the sidebar's "Code Workspaces"
    // section; on the main page WorktreeManager now renders only the
    // chat/work panel and the activity panel (no in-page list).
    const markup = render(<WorktreeManager />);

    expect(markup).toContain('Worktree panels');
    expect(markup).toContain('data-testid="worktree-central-panels"');
    expect(markup).toMatch(
      /class="contents"[^>]*data-testid="worktree-central/,
    );
    expect(markup).not.toContain('feature/crap-coverage');
  });

  it('renders the worktree error banner text', () => {
    useProjectsStore.setState({
      worktreeError: 'Failed to create /Users/me/secret-repo',
    });
    syncCurrentStateForServerRender(useProjectsStore);

    const markup = render(<WorktreeManager />);

    expect(markup).toContain('Failed to create /Users/me/secret-repo');
  });

  it('bounds a long worktree error to its first line and cause', () => {
    const lines = [
      'Command failed while creating the binturong worktree from develop.',
      "Preparing worktree (new branch 'binturong-1791357289421')",
    ];
    for (let index = 0; lines.join('\n').length < 7800; index += 1) {
      lines.push(`Updating files:  ${index % 100}% (${index}/400)`);
      lines.push(
        `error: unable to create file src/generated/file-${index}.ts: No space left on device`,
      );
    }
    useProjectsStore.setState({ worktreeError: lines.join('\n') });
    syncCurrentStateForServerRender(useProjectsStore);

    const markup = render(<WorktreeManager />);

    expect(markup).toContain('data-testid="worktree-error-notice"');
    expect(markup).toContain(
      'Command failed while creating the binturong worktree from develop.',
    );
    expect(markup).toContain('No space left on device');
    expect(markup).not.toContain('Updating files:  50%');
    expect(markup).toContain('Show details');
    expect(markup).toMatch(
      new RegExp(
        `class="${POSTHOG_REPLAY_BLOCK_CLASS} block max-h-24[^"]*">Command failed`,
      ),
    );
  });

  it('suppresses the start page for prompt-created pipeline worktrees', () => {
    expect(withStartPageSuppressed({ existingBranch: 'feature/task' })).toEqual(
      {
        existingBranch: 'feature/task',
        suppressStartPage: true,
      },
    );
  });

  it('hides the worktree panels when the selected worktree is split-locked', () => {
    useGitHubStore.setState({
      splitLockedWorktrees: new Set<string>([`${PROJECT_ID}/${WORKTREE_ID}`]),
    });
    syncCurrentStateForServerRender(useGitHubStore);

    const markup = render(<WorktreeManager />);

    expect(markup).toMatch(/class="hidden"[^>]*data-testid="worktree-central/);
    expect(markup).toContain('Worktree panels');
    expect(markup).not.toContain('feature/crap-coverage');
  });

  it('swaps in the split workflow on an open presentation SESSION even after the lock has released (Finalize finished page holds)', () => {
    // Completed settle: the lock has released but the renderer-side workflow
    // session persists. The swap keys on `session OR lock`, so the central
    // panels stay hidden and the workflow view (Finalize page) stays mounted.
    useGitHubStore.setState({
      splitLockedWorktrees: new Set<string>(),
      splitWorkflowSessions: new Set<string>([`${PROJECT_ID}/${WORKTREE_ID}`]),
    });
    syncCurrentStateForServerRender(useGitHubStore);

    const markup = render(<WorktreeManager />);

    expect(markup).toMatch(/class="hidden"[^>]*data-testid="worktree-central/);
    expect(markup).toContain('Worktree panels');
  });

  it('renders a single-repo project settings modal', () => {
    const project = makeSingleRepoProject();
    resetRendererStores(project);

    // The renderer root mounts every surface inside `CanopyClientProvider`;
    // the Cursor rules card reads its capabilities and client from it.
    const fake = createFakeClient();
    const client = {
      ...fake.client,
      capabilities: { ...fake.client.capabilities, repoRulesImport: true },
    };

    const markup = render(
      <CanopyClientProvider client={client}>
        <ProjectSettingsModal
          isOpen
          onClose={(): void => undefined}
          project={project}
        />
      </CanopyClientProvider>,
    );

    expect(markup).toContain('Renderer Health Project');
    expect(markup).toContain('/workspace/single');
    expect(markup).toContain('General');
    expect(markup).toContain('data-testid="project-settings-repo-rules"');
  });

  it('renders standalone chat project settings', () => {
    const markup = render(
      <ChatProjectSettingsModal
        isOpen
        project={makeChatProject()}
        onClose={(): void => undefined}
        onSave={(): Promise<void> => Promise.resolve()}
        onDelete={(): Promise<void> => Promise.resolve()}
      />,
    );

    expect(markup).toContain('Renderer Chat Project');
    expect(markup).toContain('General');
    expect(markup).toContain('Instructions');
    expect(markup).toContain('Plugins');
    expect(markup).toContain('Danger');
  });

  it('renders account provider status sections', () => {
    const markup = render(<AccountTab />);

    expect(markup).toContain('Accounts');
    expect(markup).toContain('LLM provider');
    // Each provider is one settings row whose status line names the account;
    // session replay blocks only the account itself.
    const blocked = (identity: string): string =>
      `<span class="${POSTHOG_REPLAY_BLOCK_CLASS}">${identity}</span>`;
    expect(markup).toContain(`${blocked('codex@example.com')} · pro`);
    expect(markup).toContain(`${blocked('Claude User')} · claude.ai (max)`);
    expect(markup).toContain('Version control');
    expect(markup).toContain('CLI managed');
    expect(markup).toContain('Personal access token');
    expect(markup).toContain('Project management');
    expect(markup).toContain(`Signed in as ${blocked('Linear User')}`);

    const claudeIndex = markup.indexOf('data-testid="auth-panel-claude"');
    const codexIndex = markup.indexOf('data-testid="auth-panel-codex"');
    const githubIndex = markup.indexOf('data-testid="auth-panel-github"');
    const linearIndex = markup.indexOf(
      'data-testid="settings-linear-token-input"',
    );
    expect(claudeIndex).toBeGreaterThan(-1);
    expect(codexIndex).toBeGreaterThan(claudeIndex);
    expect(githubIndex).toBeGreaterThan(codexIndex);
    expect(linearIndex).toBeGreaterThan(githubIndex);
  });

  describe('worktree action menu Add repo entry', () => {
    // The menu items live inside a portalled dropdown whose visibility is
    // gated by component state, so SSR snapshots of `WorktreeItem` cannot
    // reach them. The `AddRepoMenuItem` row is exported precisely so tests
    // can render the affordance directly and assert its disabled / title
    // behavior.
    it('shows the Add repo entry when not blocked by sessions or setup', () => {
      const markup = render(
        <AddRepoMenuItem
          hasActiveSession={false}
          isDone={false}
          isPendingGitSetup={false}
          isRunningSetup={false}
          onAddRepoToWorktreeAdhoc={(): void => undefined}
          onClose={(): void => undefined}
        />,
      );

      expect(markup).toContain('Add project');
      expect(markup).toContain('worktree-actions-menu-add-repo');
      // The "enabled" form must not carry a `disabled` attribute on the
      // testid-bearing button.
      expect(markup).not.toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="worktree-actions-menu-add-repo"/,
      );
    });

    it('disables the Add repo entry with the active-session tooltip', () => {
      const markup = render(
        <AddRepoMenuItem
          hasActiveSession
          isDone={false}
          isPendingGitSetup={false}
          isRunningSetup={false}
          onAddRepoToWorktreeAdhoc={(): void => undefined}
          onClose={(): void => undefined}
        />,
      );

      // The `disabled` attribute lands ahead of `data-testid` in the
      // serialized output; assert on the row that owns the testid by also
      // confirming the data-testid is present in the same button tag.
      expect(markup).toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="worktree-actions-menu-add-repo"/,
      );
      expect(markup).toContain('Stop active sessions before adding a repo');
    });

    it('disables the Add repo entry with the pending-setup tooltip when setup is pending', () => {
      const markup = render(
        <AddRepoMenuItem
          hasActiveSession={false}
          isDone={false}
          isPendingGitSetup
          isRunningSetup={false}
          onAddRepoToWorktreeAdhoc={(): void => undefined}
          onClose={(): void => undefined}
        />,
      );

      // The `disabled` attribute lands ahead of `data-testid` in the
      // serialized output; assert on the row that owns the testid by also
      // confirming the data-testid is present in the same button tag.
      expect(markup).toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="worktree-actions-menu-add-repo"/,
      );
      expect(markup).toContain('Wait for setup to finish before adding a repo');
    });

    it('disables the Add repo entry while setup scripts are running', () => {
      const markup = render(
        <AddRepoMenuItem
          hasActiveSession={false}
          isDone={false}
          isPendingGitSetup={false}
          isRunningSetup
          onAddRepoToWorktreeAdhoc={(): void => undefined}
          onClose={(): void => undefined}
        />,
      );

      // The `disabled` attribute lands ahead of `data-testid` in the
      // serialized output; assert on the row that owns the testid by also
      // confirming the data-testid is present in the same button tag.
      expect(markup).toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="worktree-actions-menu-add-repo"/,
      );
      expect(markup).toContain('Wait for setup to finish before adding a repo');
    });

    it('keeps the Add repo entry visible and disabled for done worktrees', () => {
      const markup = render(
        <AddRepoMenuItem
          hasActiveSession={false}
          isDone
          isPendingGitSetup={false}
          isRunningSetup={false}
          onAddRepoToWorktreeAdhoc={(): void => undefined}
          onClose={(): void => undefined}
        />,
      );

      expect(markup).toContain('Add project');
      expect(markup).toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="worktree-actions-menu-add-repo"/,
      );
      expect(markup).toContain('Done worktrees cannot add repos');
    });
  });

  describe('worktree action menu Split project entry', () => {
    // Same portalled-menu rationale as the Add repo entry above:
    // `SplitWorkspaceMenuItem` is exported so tests can assert its
    // disabled / title behavior directly.
    it('shows the Split project entry when not blocked', () => {
      const markup = render(
        <SplitWorkspaceMenuItem
          hasActiveSession={false}
          hasActivePipelines={false}
          isDone={false}
          isPendingGitSetup={false}
          isRunningSetup={false}
          onSplitWorkspace={(): void => undefined}
          onClose={(): void => undefined}
        />,
      );

      expect(markup).toContain('Split project');
      expect(markup).toContain('worktree-actions-menu-split-workspace');
      expect(markup).not.toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="worktree-actions-menu-split-workspace"/,
      );
    });

    it('disables the Split project entry with the active-chats reason', () => {
      const markup = render(
        <SplitWorkspaceMenuItem
          hasActiveSession
          hasActivePipelines={false}
          isDone={false}
          isPendingGitSetup={false}
          isRunningSetup={false}
          onSplitWorkspace={(): void => undefined}
          onClose={(): void => undefined}
        />,
      );

      expect(markup).toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="worktree-actions-menu-split-workspace"/,
      );
      // Mirrors SPLIT_PR_BLOCKER_COPY.active_chats.
      expect(markup).toContain('Wait for active agent chats to finish');
    });

    it('disables the Split project entry with the active-pipelines reason', () => {
      const markup = render(
        <SplitWorkspaceMenuItem
          hasActiveSession={false}
          hasActivePipelines
          isDone={false}
          isPendingGitSetup={false}
          isRunningSetup={false}
          onSplitWorkspace={(): void => undefined}
          onClose={(): void => undefined}
        />,
      );

      expect(markup).toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="worktree-actions-menu-split-workspace"/,
      );
      // Mirrors SPLIT_PR_BLOCKER_COPY.active_pipelines.
      expect(markup).toContain('Wait for active pipelines to finish');
    });

    it('disables the Split project entry while setup is pending', () => {
      const markup = render(
        <SplitWorkspaceMenuItem
          hasActiveSession={false}
          hasActivePipelines={false}
          isDone={false}
          isPendingGitSetup
          isRunningSetup={false}
          onSplitWorkspace={(): void => undefined}
          onClose={(): void => undefined}
        />,
      );

      expect(markup).toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="worktree-actions-menu-split-workspace"/,
      );
      expect(markup).toContain(
        'Wait for setup to finish before splitting the project',
      );
    });

    it('keeps the Split project entry visible and disabled for done worktrees', () => {
      const markup = render(
        <SplitWorkspaceMenuItem
          hasActiveSession={false}
          hasActivePipelines={false}
          isDone
          isPendingGitSetup={false}
          isRunningSetup={false}
          onSplitWorkspace={(): void => undefined}
          onClose={(): void => undefined}
        />,
      );

      expect(markup).toContain('Split project');
      expect(markup).toMatch(
        /<button[^>]*disabled=""[^>]*data-testid="worktree-actions-menu-split-workspace"/,
      );
      expect(markup).toContain('Done worktrees cannot be split');
    });
  });

  describe('AddRepoToWorktreeModal', () => {
    function makeAdditionalWorkspace(
      overrides: Partial<MultiRepoSidebarItem> = {},
    ): MultiRepoSidebarItem {
      return {
        type: 'multi-repo',
        id: 'workspace-other',
        name: 'Other Workspace',
        color: '#10b981',
        repos: [
          {
            id: 'repo-x',
            name: 'service',
            repoPath: '/workspace/other/service',
          },
        ],
        worktrees: [],
        collapsed: false,
        order: 1,
        ...overrides,
      };
    }

    it('renders the initial workspace-loading state', () => {
      resetRendererStores(makeWorkspace());
      useProjectsStore.setState({
        projects: [makeWorkspace(), makeAdditionalWorkspace()],
      });
      syncCurrentStateForServerRender(useProjectsStore);

      const markup = render(
        <AddRepoToWorktreeModal
          sourceWorkspaceId={PROJECT_ID}
          sourceWorktreeId={WORKTREE_ID}
          onClose={(): void => undefined}
        />,
      );

      expect(markup).toContain('Add project');
      expect(markup).toContain('Loading projects');
      expect(markup).toContain(
        'Checking repo identities for eligible join targets.',
      );
    });
  });
});
