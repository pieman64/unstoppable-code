import type { ProviderEventIngestOutcome } from '../services/chat-state-service';
import type {
  ApprovalMode,
  ChatModel,
  ChatHookAction,
  ChatTabsFile,
  ChatTabPluginSelections,
  HookChatTabStartedEvent,
  ClaudeTerminalLaunchRequest,
  ClaudeTerminalLaunchResponse,
  CodexSpeed,
  PersistedChatTab,
  PreferencesData,
  SidebarItem,
  ThinkingLevel,
  initAgentModels as InitAgentModelsFn,
  initClaudeModels as InitClaudeModelsFn,
  initCodexModels as InitCodexModelsFn,
  initModelAliases as InitModelAliasesFn,
  IPC_CHANNELS as IpcChannelsValue,
} from '@canopy/desktop-shared/types';
import { DEFAULT_HIDE_ANTHROPIC_NAV } from '@canopy/desktop-shared/types';
import type { readPreferencesFile as ReadPreferencesFileFn } from '../lib/preferences-store';
import type { readAllSidebarItems as ReadAllSidebarItemsFn } from '../lib/sidebar-items';
import type { readChatTabsFile as ReadChatTabsFileFn } from '../lib/chat-tabs-reader';
import type { writeChatTabsFile as WriteChatTabsFileFn } from '../lib/chat-tabs';
import type { completePersistedTabTurnTimers as CompletePersistedTabTurnTimersFn } from '../lib/chat-tabs';
import type { sendToWindow as SendToWindowFn } from '../lib/window-send';
import type { dispatchWorktreeChatTurn as DispatchWorktreeChatTurnFn } from '../lib/worktree-chat-turn';
import type { launchHookChat as LaunchHookChatFn } from '../lib/hook-chat';
import type * as InheritedPluginDefaultsNormalization from '../lib/inherited-plugin-defaults-normalization';
import type { resolveConfiguredPrompt as ResolveConfiguredPromptFn } from '../lib/configured-prompt-resolution';
import type { ClaudeTerminalLaunchRuntimeOptions } from '../integration/claude-terminal-session-service';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';

interface HookChatModule {
  launchHookChat: typeof LaunchHookChatFn;
  cancelQueuedHookChat(queueId: string): Promise<{ cancelled: boolean }>;
  forceQueuedHookChat(queueId: string): Promise<{ forced: boolean }>;
  hasQueuedHookChat(args: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }): boolean;
  updateQueuedHookChatPlanMode(args: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    enabled: boolean;
  }): void;
  updateQueuedHookChatApprovalMode(args: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    mode: ApprovalMode;
  }): void;
  updateQueuedHookChatThinkingLevel(args: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    level: ThinkingLevel;
  }): void;
  updateQueuedHookChatInterfaceMode(args: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    interfaceMode: 'canopy' | 'claude-code' | 'auto';
  }): boolean;
  updateQueuedHookChatModel(args: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    model: ChatModel;
  }): Promise<void>;
  updateQueuedHookChatCodexFastMode(args: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    enabled: boolean;
    speed?: CodexSpeed;
  }): void;
  updateQueuedHookChatPluginSelections(args: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    pluginSelections?: ChatTabPluginSelections;
    deferredToolsAllowed?: boolean;
  }): void;
}

interface ChatTabsModule {
  completePersistedTabTurnTimers: typeof CompletePersistedTabTurnTimersFn;
}

interface SharedTypesRuntime {
  IPC_CHANNELS: typeof IpcChannelsValue;
  initAgentModels: typeof InitAgentModelsFn;
  initClaudeModels: typeof InitClaudeModelsFn;
  initCodexModels: typeof InitCodexModelsFn;
  initModelAliases: typeof InitModelAliasesFn;
}

interface ObservabilityServiceMock {
  completeChatTurn(
    projectId: string,
    worktreeId: string,
    chatId: string,
    status: string,
    error: string | undefined,
  ): void;
}

type PreferencesFile = Awaited<ReturnType<typeof ReadPreferencesFileFn>>;
type SidebarItemsResult = Awaited<ReturnType<typeof ReadAllSidebarItemsFn>>;
type ReadChatTabsArgs = Parameters<typeof ReadChatTabsFileFn>;
type WriteChatTabsArgs = Parameters<typeof WriteChatTabsFileFn>;
type SendToWindowArgs = Parameters<typeof SendToWindowFn>;
type SendToWindowResult = ReturnType<typeof SendToWindowFn>;
type DispatchWorktreeChatTurnArgs = Parameters<
  typeof DispatchWorktreeChatTurnFn
>;
type DispatchWorktreeChatTurnResult = ReturnType<
  typeof DispatchWorktreeChatTurnFn
>;

const readPreferencesFileMock = jest.fn<Promise<PreferencesFile>, []>();
const readWorkspaceApprovalsMock = jest.fn();
const readWorkspaceApprovalsManifestMock = jest.fn();
const readAllSidebarItemsMock = jest.fn<Promise<SidebarItemsResult>, []>();
const readChatTabsFileMock = jest.fn<Promise<ChatTabsFile>, ReadChatTabsArgs>();
const writeChatTabsFileMock = jest.fn<Promise<void>, WriteChatTabsArgs>();
const sendToWindowMock = jest.fn<SendToWindowResult, SendToWindowArgs>();
const dispatchWorktreeChatTurnMock = jest.fn<
  DispatchWorktreeChatTurnResult,
  DispatchWorktreeChatTurnArgs
>();
const resolveConfiguredPromptMock = jest.fn<
  ReturnType<typeof ResolveConfiguredPromptFn>,
  Parameters<typeof ResolveConfiguredPromptFn>
>();

jest.mock('../lib/configured-prompt-resolution', () => ({
  resolveConfiguredPrompt: (
    args: Parameters<typeof resolveConfiguredPromptMock>[0],
  ): ReturnType<typeof resolveConfiguredPromptMock> =>
    resolveConfiguredPromptMock(args),
}));
const launchClaudeTerminalMock = jest.fn<
  Promise<ClaudeTerminalLaunchResponse>,
  [ClaudeTerminalLaunchRequest, ClaudeTerminalLaunchRuntimeOptions?]
>();
const completeChatTurnMock = jest.fn<
  void,
  [string, string, string, string, string | undefined]
>();
const mockFeatureFlagValues = new Map<string, boolean>();
let mockHasActiveChatTurnsValue = false;
let mockActiveChatTargetKeys: Set<string> | null = null;
const mockChatSessionActivityListeners = new Set<() => void>();
const ingestProviderEventMock = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
const runWithScopeActivityMock = jest.fn(
  async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
    operation(),
);

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: jest.fn(() => ({
    ingestProviderEvent: ingestProviderEventMock,
    // Mirrors the void commit mock: provider events report no commit.
    ingestProviderEventWithOutcome: async (
      input: unknown,
    ): Promise<ProviderEventIngestOutcome> => {
      await ingestProviderEventMock(input);
      return 'not-applied';
    },
    runWithScopeActivity: runWithScopeActivityMock,
  })),
}));

jest.mock('../lib/preferences-store', () => ({
  // Not degraded: approval resolution fails closed when this is non-null.
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: (): Promise<PreferencesFile> =>
    readPreferencesFileMock(),
}));
let mockLaneDefaultUnavailable = false;
jest.mock('../lib/default-model-lane-resolver', () => ({
  resolveOptionalLaneAwareDefaultSelection: (
    preferences: PreferencesFile,
  ): Promise<unknown> => {
    if (mockLaneDefaultUnavailable) {
      return Promise.resolve({
        selection: undefined,
        requireModel: (): never => {
          throw new Error('No dispatchable model is available (billing-lane).');
        },
      });
    }
    const selection =
      preferences.defaultWorktreeModelByProvider[
        preferences.defaultWorktreeProvider
      ] ?? preferences.defaultWorktreeModelByProvider.claude;
    return Promise.resolve({ selection, requireModel: () => selection });
  },
}));

jest.mock('../lib/approvals-persistence', () => ({
  readWorkspaceApprovals: (...args: unknown[]): unknown =>
    readWorkspaceApprovalsMock(...args),
}));

jest.mock('../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (...args: unknown[]): unknown =>
    readWorkspaceApprovalsManifestMock(...args),
}));

jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<SidebarItemsResult> =>
    readAllSidebarItemsMock(),
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (...args: ReadChatTabsArgs): Promise<ChatTabsFile> =>
    readChatTabsFileMock(...args),
}));

jest.mock('../lib/chat-tabs', () => {
  const actual = jest.requireActual<ChatTabsModule>('../lib/chat-tabs');

  return {
    ...actual,
    writeChatTabsFile: (...args: WriteChatTabsArgs): Promise<void> =>
      writeChatTabsFileMock(...args),
  };
});

jest.mock('../lib/window-send', () => ({
  sendToWindow: (...args: SendToWindowArgs): SendToWindowResult =>
    sendToWindowMock(...args),
}));

jest.mock('../lib/worktree-chat-turn', () => ({
  dispatchWorktreeChatTurn: (
    ...args: DispatchWorktreeChatTurnArgs
  ): DispatchWorktreeChatTurnResult => dispatchWorktreeChatTurnMock(...args),
}));

jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: jest.fn(() => ({
    launch: launchClaudeTerminalMock,
  })),
}));

jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({
    isEnabled: jest.fn((key: string) => mockFeatureFlagValues.get(key) ?? true),
  })),
}));

jest.mock('../observability', () => ({
  getObservabilityService: (): ObservabilityServiceMock => ({
    completeChatTurn: (
      projectId: string,
      worktreeId: string,
      chatId: string,
      status: string,
      error: string | undefined,
    ): void =>
      completeChatTurnMock(projectId, worktreeId, chatId, status, error),
  }),
}));

jest.mock('../agents/session-manager', () => ({
  hasActiveChatTurnsForWorktree: (
    projectId: string,
    worktreeId: string,
  ): boolean => {
    if (mockActiveChatTargetKeys) {
      return mockActiveChatTargetKeys.has(`${projectId}/${worktreeId}`);
    }
    return mockHasActiveChatTurnsValue;
  },
  subscribeChatSessionActivity: (listener: () => void): (() => void) => {
    mockChatSessionActivityListeners.add(listener);
    return (): void => {
      mockChatSessionActivityListeners.delete(listener);
    };
  },
}));

function buildTab(id: string, prompt: string): PersistedChatTab {
  return {
    id,
    title: prompt,
    createdAt: '2026-04-11T00:00:00.000Z',
    thinkingLevel: 'medium',
    model: 'gpt-5.5',
    providerType: 'codex',
    messages: [
      {
        id: 'msg-user',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: prompt }],
      },
      {
        id: 'msg-timer',
        role: 'system',
        timestamp: 1,
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: null }],
      },
    ],
  };
}

function buildTabsFile(tab?: PersistedChatTab): ChatTabsFile {
  return {
    version: 1,
    tabs: tab ? [tab] : [],
    activeTabId: tab?.id ?? '',
  };
}

function buildPreferences(): PreferencesData {
  return {
    worktreePanelPercent: 32,
    activityPanelExpanded: false,
    activityPanelWidthPercent: 25,
    kanbanWorktreePanelPercent: 32,
    kanbanActivityPanelExpanded: false,
    kanbanActivityPanelWidthPercent: 25,
    kanbanChatPanelVisible: false,
    sidebarCollapsed: false,
    branchNamePrefixMode: 'github',
    branchNameCustomPrefix: '',
    deleteBranchOnArchive: true,
    archiveOnMerge: true,
    defaultChatProvider: 'claude',
    defaultChatModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'high' },
      ollama: null,
    },
    defaultWorktreeProvider: 'codex',
    defaultWorktreeModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
      codex: { model: 'gpt-5.5', thinkingLevel: 'medium' },
      ollama: null,
    },
    approvalDefaults: {
      worktree: 'ask',
      cowork: 'ask',
      appAdvisor: 'ask',
    },
    globalApprovalRules: [],
    approvalsUpgradeNoticeDismissed: false,
    summaryModel: 'claude-haiku-4-5-20251001',
    summaryThinkingLevel: 'off',
    worktreeSummaryEnabled: true,
    worktreeSummaryModel: 'claude-haiku-4-5-20251001',
    worktreeSummaryThinkingLevel: 'off',
    prGenerationModel: 'claude-sonnet-4-6',
    prGenerationThinkingLevel: 'high',
    prInstructions: '',
    prInstructionMode: 'append',
    commitGenerationModel: 'claude-sonnet-4-6',
    commitGenerationThinkingLevel: 'high',
    commitInstructions: '',
    commitInstructionMode: 'append',
    branchNamingModel: 'claude-haiku-4-5-20251001',
    branchNamingThinkingLevel: 'off',
    branchNamingInstructions: '',
    branchDisplayMappings: [],
    reviewCommitMessage: false,
    agentRebaseResolutionEnabled: false,
    agentRebaseResolutionModel: null,
    agentRebaseResolutionThinkingLevel: null,
    mergeQueueAgentHandling: 'when_hook_absent',
    rtkEnabled: true,
    scriptTimeoutMinutes: 5,
    codexAppServerIdleTimeoutMinutes: 10,
    defaultChatInterfaceMode: 'canopy',
    maxActiveChatTurns: 10,
    maxActivePipelineExecutions: 5,
    memoryPressureGuardEnabled: false,
    memoryPressureWarningThresholdBytes: 2 * 1024 * 1024 * 1024,
    memoryPressureCriticalThresholdBytes: 4 * 1024 * 1024 * 1024,
    keepSystemAwakeWhileAgentsActive: true,
    codexMultiAgentWorktreeChatsEnabled: false,
    codexMultiAgentStandaloneChatsEnabled: false,
    codexMultiAgentPipelinesEnabled: false,
    lastOpenApp: '',
    disabledOpenApps: [],
    lastSelectedWorktreeProjectId: '',
    lastSelectedWorktreeId: '',
    executionDetailViewMode: 'list',
    worktreeViewMode: 'list',
    worktreeFilterHiddenWorkspaceIds: [],
    auditRetentionDays: 7,
    theme: 'default',
    colorMode: 'dark',
    uiScale: 100,
    windowBounds: null,
    windowMaximized: false,
    windowFullScreen: false,
    ollamaServerPort: 11434,
    mcpProxyPort: 37645,
    hideAnthropicNav: DEFAULT_HIDE_ANTHROPIC_NAV,
    lastActiveContext: null,
    fileAutoSave: false,
    inAppNotifications: {
      enabled: true,
      placement: 'bottom-right',
      categories: {
        chat: true,
        script: true,
        hook: true,
        gitCommit: true,
        gitPush: true,
        prCreate: true,
        pipeline: true,
        terminal: true,
      },
    },
    terminalDrawerCollapsed: true,
    terminalDrawerHeight: 300,
    terminalDrawerActiveTabId: 'terminal',
    osNotifications: {
      enabled: false,
      skipWhenFocused: true,
      defaultSound: 'System',
      categories: {
        chat: true,
        script: true,
        hook: true,
        gitCommit: true,
        gitPush: true,
        prCreate: true,
        pipeline: true,
        terminal: true,
      },
      categorySounds: {
        chat: 'Default',
        script: 'Default',
        hook: 'Default',
        gitCommit: 'Default',
        gitPush: 'Default',
        prCreate: 'Default',
        pipeline: 'Default',
        terminal: 'Default',
      },
    },
    branchNamingPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    commitGenerationPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    prGenerationPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    worktreeSummaryPluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    voiceDictationEnabled: true,
    mcpHttpAuthDefaultHandler: 'canopy',
    fileIndexing: {
      disabledBuiltinGlobIds: [],
      customGlobs: [],
    },
    autoDownloadUpdates: true,
    showDiagnosticsPill: true,
  };
}

function buildSidebarProject(): SidebarItemsResult {
  const items: SidebarItem[] = [
    {
      id: 'project',
      name: 'Project',
      repoPath: '/tmp/project',
      color: '#000000',
      worktrees: [],
      collapsed: false,
      order: 0,
      type: 'single-repo',
    },
  ];

  return {
    version: 1,
    items,
  };
}

function loadHookChatModule(): HookChatModule {
  return jest.requireActual<HookChatModule>('../lib/hook-chat');
}

function loadSharedTypesModule(): SharedTypesRuntime {
  return jest.requireActual<SharedTypesRuntime>('@canopy/desktop-shared/types');
}

function setMockHasActiveChatTurns(value: boolean): void {
  mockHasActiveChatTurnsValue = value;
  mockActiveChatTargetKeys = null;
}

function setMockActiveChatTargets(targetKeys: string[]): void {
  mockActiveChatTargetKeys = new Set(targetKeys);
}

function emitMockChatSessionActivity(): void {
  for (const listener of Array.from(mockChatSessionActivityListeners)) {
    listener();
  }
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function isHookChatTabStartedEvent(
  value: unknown,
): value is HookChatTabStartedEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'chatId' in value &&
    typeof value.chatId === 'string' &&
    'activateTab' in value &&
    typeof value.activateTab === 'boolean' &&
    'tab' in value &&
    typeof value.tab === 'object' &&
    value.tab !== null
  );
}

function getHookChatStartedEvents(): HookChatTabStartedEvent[] {
  const { IPC_CHANNELS } = loadSharedTypesModule();
  return sendToWindowMock.mock.calls
    .filter((call) => call[1] === IPC_CHANNELS.chatHookTabStarted)
    .map((call) => call[2])
    .filter(isHookChatTabStartedEvent);
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: (): void => {
      resolvePromise?.();
    },
  };
}

describe('hook-chat', () => {
  let currentTabsFile: ChatTabsFile;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    mockFeatureFlagValues.clear();
    mockLaneDefaultUnavailable = false;
    setMockHasActiveChatTurns(false);
    mockChatSessionActivityListeners.clear();
    currentTabsFile = buildTabsFile();

    loadHookChatModule();
    loadSharedTypesModule().initClaudeModels([
      { id: 'opus[1m]', label: 'Opus 4.8 1M' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ]);
    loadSharedTypesModule().initCodexModels([
      { id: 'gpt-5.5', label: 'GPT 5.5' },
      { id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
      { id: 'gpt-6-sol', label: 'GPT 6 Sol' },
      { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol' },
    ]);
    loadSharedTypesModule().initModelAliases({
      'claude-opus-4-7': 'opus[1m]',
    });

    readPreferencesFileMock.mockResolvedValue(buildPreferences());
    readWorkspaceApprovalsMock.mockResolvedValue({ version: 1, rules: [] });
    readWorkspaceApprovalsManifestMock.mockResolvedValue({ rules: [] });
    readAllSidebarItemsMock.mockResolvedValue(buildSidebarProject());
    readChatTabsFileMock.mockImplementation(
      (...args: ReadChatTabsArgs): Promise<ChatTabsFile> => {
        void args;
        return Promise.resolve(currentTabsFile);
      },
    );
    writeChatTabsFileMock.mockImplementation(
      (...args: WriteChatTabsArgs): Promise<void> => {
        const [, , data] = args;
        currentTabsFile = data;
        return Promise.resolve();
      },
    );
    sendToWindowMock.mockReturnValue(true);
    dispatchWorktreeChatTurnMock.mockResolvedValue(undefined);
    resolveConfiguredPromptMock.mockImplementation(
      (args): ReturnType<typeof resolveConfiguredPromptMock> =>
        Promise.resolve({ prompt: args.prompt }),
    );
    launchClaudeTerminalMock.mockResolvedValue({
      terminalId: 'terminal-1',
      sessionKey: 'session-key',
      sdkSessionId: 'sdk-session',
      state: {
        terminalId: 'terminal-1',
        sessionKey: 'session-key',
        sdkSessionId: 'sdk-session',
        turnState: 'idle',
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists the hook tab, notifies the renderer, and dispatches the turn', async () => {
    const { launchHookChat } = loadHookChatModule();
    const { IPC_CHANNELS } = loadSharedTypesModule();

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        model: 'gpt-5.5',
        thinking: 'medium',
        autoArchive: true,
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    expect(runWithScopeActivityMock).toHaveBeenCalledWith(
      { projectId: 'project', worktreeId: 'worktree' },
      expect.any(Function),
    );

    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(1);
    const writeArgs = writeChatTabsFileMock.mock.calls[0];
    if (!writeArgs) {
      throw new Error('Expected hook tab persistence call');
    }
    const [projectId, worktreeId, writtenFile] = writeArgs;
    expect(projectId).toBe('project');
    expect(worktreeId).toBe('worktree');
    expect(writtenFile.tabs).toHaveLength(1);
    expect(writtenFile.activeTabId).toBe('chat-hook-1000-1');
    expect(writtenFile.tabs[0]?.autoArchive).toBe(true);
    expect(writtenFile.tabs[0]?.executionContext).toBe('personal');
    expect(
      writtenFile.tabs[0]?.messages.find((message) => message.role === 'user'),
    ).toMatchObject({ userMessageSource: 'hook' });

    expect(sendToWindowMock).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatHookTabStarted,
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        activateTab: false,
      }),
    );
    expect(getHookChatStartedEvents()[0]?.tab.autoArchive).toBe(true);
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-hook-1000-1',
        text: 'Review failures',
        initiationSource: 'hook',
        executionContext: 'personal',
        skipBranchNaming: true,
      }),
    );
  });

  it('opens the hook chat in the background, keeping the tab the user left', async () => {
    const { launchHookChat } = loadHookChatModule();
    const { IPC_CHANNELS } = loadSharedTypesModule();
    currentTabsFile = buildTabsFile(buildTab('user-chat', 'My chat'));

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: { type: 'chat', prompt: 'Resolve the merge conflicts' },
      prompt: 'Resolve the merge conflicts',
      triggerName: 'pr:merge-conflicts',
      getWindow: () => null,
    });

    expect(currentTabsFile.tabs.map((tab) => tab.id)).toEqual([
      'user-chat',
      'chat-hook-1000-1',
    ]);
    expect(currentTabsFile.activeTabId).toBe('user-chat');
    expect(sendToWindowMock).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatHookTabStarted,
      expect.objectContaining({
        chatId: 'chat-hook-1000-1',
        activateTab: false,
      }),
    );
  });

  it('persists and dispatches the chat hook execution context', async () => {
    const { launchHookChat } = loadHookChatModule();
    const action = {
      type: 'chat',
      prompt: 'Review failures',
      model: 'gpt-5.5',
      executionContext: 'org:123e4567-e89b-12d3-a456-426614174000',
    } satisfies ChatHookAction & { executionContext: string };

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action,
      prompt: action.prompt,
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    expect(writeChatTabsFileMock.mock.calls[0]?.[2].tabs[0]).toMatchObject({
      executionContext: action.executionContext,
    });
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionContext: action.executionContext }),
    );
  });

  it('carries resolved file references, plugin enablement, and plan mode into the native hook turn', async (): Promise<void> => {
    const { launchHookChat } = loadHookChatModule();
    const fileReference = {
      displayPath: 'src/a.ts',
      absolutePath: '/live/src/a.ts',
      textStart: 7,
    };
    resolveConfiguredPromptMock.mockResolvedValueOnce({
      prompt: 'Review src/a.ts',
      fileReferences: [fileReference],
      referencedPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
        mcpServerRefs: [],
      },
    });
    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review src/a.ts',
        model: 'gpt-5.5',
        planMode: true,
        promptReferences: [
          {
            kind: 'file',
            root: { kind: 'workspace' },
            relativePath: 'src/a.ts',
            displayText: 'src/a.ts',
            textStart: 7,
          },
        ],
      },
      prompt: 'Review src/a.ts',
      triggerName: 'pr:checks:fail',
      getWindow: (): null => null,
    });
    const tab = writeChatTabsFileMock.mock.calls[0]?.[2].tabs[0];
    expect(tab?.planMode).toBe(true);
    expect(
      tab?.messages.find((message) => message.role === 'user')?.blocks,
    ).toContainEqual({ type: 'file_references', references: [fileReference] });
    const dispatched = dispatchWorktreeChatTurnMock.mock.calls[0]?.[0];
    expect(dispatched?.text).toBe('Review src/a.ts');
    expect(dispatched?.fileReferences).toEqual([fileReference]);
    expect(dispatched?.planMode).toBe(true);
    expect(dispatched?.pluginSelections?.pluginRefs).toEqual([
      { marketplaceId: 'market', pluginName: 'plugin' },
    ]);
  });

  it('includes resolved references in a managed terminal hook transcript', async (): Promise<void> => {
    const { launchHookChat } = loadHookChatModule();
    readPreferencesFileMock.mockResolvedValue({
      ...buildPreferences(),
      defaultChatInterfaceMode: 'claude-code',
    });
    const fileReference = {
      displayPath: 'src/a.ts',
      absolutePath: '/live/src/a.ts',
      textStart: 7,
    };
    resolveConfiguredPromptMock.mockResolvedValueOnce({
      prompt: 'Review src/a.ts',
      fileReferences: [fileReference],
    });
    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review src/a.ts',
        model: 'claude-sonnet-4-6',
        promptReferences: [
          {
            kind: 'file',
            root: { kind: 'workspace' },
            relativePath: 'src/a.ts',
            displayText: 'src/a.ts',
            textStart: 7,
          },
        ],
      },
      prompt: 'Review src/a.ts',
      triggerName: 'pr:checks:fail',
      getWindow: (): null => null,
    });
    expect(launchClaudeTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPrompt:
          'Referenced files:\n- /live/src/a.ts\n\nReview /live/src/a.ts',
      }),
      expect.any(Object),
    );
    const tab = writeChatTabsFileMock.mock.calls[0]?.[2].tabs[0];
    expect(
      tab?.messages.find((message) => message.role === 'user')?.blocks,
    ).toContainEqual({ type: 'file_references', references: [fileReference] });
  });

  it('applies full hook selections including custom skills and MCP servers', async () => {
    const { launchHookChat } = loadHookChatModule();
    const pluginSelections: ChatTabPluginSelections = {
      collectionIds: ['hook-collection'],
      skillRefs: [{ sourceId: 'custom:local', skillName: 'hook-custom-skill' }],
      pluginRefs: [
        { marketplaceId: 'local-marketplace', pluginName: 'hook-plugin' },
      ],
      mcpServerRefs: [{ serverId: 'linear', configId: 'work' }],
    };
    const action: ChatHookAction = {
      type: 'chat',
      prompt: 'Review failures',
      model: 'gpt-5.5',
      pluginSelections,
    };

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action,
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const writtenTab = writeChatTabsFileMock.mock.calls[0]?.[2].tabs[0];
    const expectedSelections = {
      ...pluginSelections,
      mcpHttpAuthPreferences: [],
    };
    expect(writtenTab?.pluginSelections).toEqual(expectedSelections);
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginSelections: expectedSelections }),
    );
  });

  it('leaves project default plugins inherited instead of copying them', async () => {
    const { launchHookChat } = loadHookChatModule();
    const sidebar = buildSidebarProject();
    readAllSidebarItemsMock.mockResolvedValue({
      ...sidebar,
      items: sidebar.items.map((item) => ({
        ...item,
        defaultPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
        },
      })),
    });

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: { type: 'chat', prompt: 'Review failures', model: 'gpt-5.5' },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const writtenTab = writeChatTabsFileMock.mock.calls[0]?.[2].tabs[0];
    expect(writtenTab?.pluginSelections).toBeUndefined();
  });

  it('stamps the hook chat so a pick it shares with the project defaults survives them changing', async () => {
    const { launchHookChat } = loadHookChatModule();
    const linear = { serverId: 'linear', configId: 'default' };
    const projectDefaults: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [linear],
    };
    const sidebar = buildSidebarProject();
    readAllSidebarItemsMock.mockResolvedValue({
      ...sidebar,
      items: sidebar.items.map((item) => ({
        ...item,
        defaultPluginSelections: projectDefaults,
      })),
    });

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        model: 'gpt-5.5',
        pluginSelections: projectDefaults,
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const writtenTab = writeChatTabsFileMock.mock.calls[0]?.[2].tabs[0];
    expect(writtenTab?.inheritedPluginDefaultsVersion).toBe(1);
    // The project then drops linear from its defaults.
    const { normalizeTabForInheritedPluginDefaults } = jest.requireActual<
      typeof InheritedPluginDefaultsNormalization
    >('../lib/inherited-plugin-defaults-normalization');
    expect(
      writtenTab &&
        normalizeTabForInheritedPluginDefaults(writtenTab, projectDefaults),
    ).toBeNull();
    expect(writtenTab?.pluginSelections?.mcpServerRefs).toEqual([linear]);
  });

  it('applies defaultChatInterfaceMode to Claude-backed hook tabs', async () => {
    const { launchHookChat } = loadHookChatModule();
    const getWindow = jest.fn(() => null);
    loadSharedTypesModule().initClaudeModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    ]);
    readPreferencesFileMock.mockResolvedValue({
      ...buildPreferences(),
      defaultChatInterfaceMode: 'claude-code',
    });

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        model: 'claude-sonnet-4-6',
        thinking: 'medium',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow,
    });

    const writeArgs = writeChatTabsFileMock.mock.calls[0];
    if (!writeArgs) {
      throw new Error('Expected hook tab persistence call');
    }
    const [, , writtenFile] = writeArgs;
    const writtenTab = writtenFile.tabs[0];
    if (!writtenTab) {
      throw new Error('Expected hook tab in persisted file');
    }
    expect(writtenTab.interfaceMode).toBe('claude-code');
    expect(writtenTab.providerType).toBe('claude');
    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();
    expect(launchClaudeTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-hook-1000-1',
        initialPrompt: 'Review failures',
        cols: 80,
        rows: 24,
      }),
      { getWindow, executionContext: 'personal' },
    );
  });

  it('forces Claude-backed hook tabs to native chat mode when Claude TUI chats are disabled', async () => {
    mockFeatureFlagValues.set(
      CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key,
      false,
    );
    const { launchHookChat } = loadHookChatModule();
    loadSharedTypesModule().initClaudeModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    ]);
    readPreferencesFileMock.mockResolvedValue({
      ...buildPreferences(),
      defaultChatInterfaceMode: 'claude-code',
    });

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        model: 'claude-sonnet-4-6',
        thinking: 'medium',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const writeArgs = writeChatTabsFileMock.mock.calls[0];
    if (!writeArgs) {
      throw new Error('Expected hook tab persistence call');
    }
    const [, , writtenFile] = writeArgs;
    const writtenTab = writtenFile.tabs[0];
    if (!writtenTab) {
      throw new Error('Expected hook tab in persisted file');
    }
    expect(writtenTab.interfaceMode).toBeUndefined();
    expect(writtenTab.providerType).toBe('claude');
    expect(launchClaudeTerminalMock).not.toHaveBeenCalled();
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-hook-1000-1',
        text: 'Review failures',
        initiationSource: 'hook',
      }),
    );
  });

  it('resolves legacy explicit hook model IDs before dispatching the turn', async () => {
    const { launchHookChat } = loadHookChatModule();

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        model: 'claude-opus-4-7',
        thinking: 'high',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const writeArgs = writeChatTabsFileMock.mock.calls[0];
    if (!writeArgs) {
      throw new Error('Expected hook tab persistence call');
    }
    const [, , writtenFile] = writeArgs;
    expect(writtenFile.tabs[0]?.model).toBe('opus[1m]');
    expect(writtenFile.tabs[0]?.providerType).toBe('claude');

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'opus[1m]',
        providerType: 'claude',
      }),
    );
  });

  it('resolves pipeline model aliases like $default-codex before dispatching the turn', async () => {
    // canopy.json hook actions share the pipeline model alias vocabulary
    // ($default-codex, $fast, $cheap) so model upgrades roll in one place. A
    // hook naming an alias must launch on the alias target, not die with
    // "Unsupported hook chat model".
    const { launchHookChat } = loadHookChatModule();

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        model: '$default-codex',
        thinking: 'medium',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const writeArgs = writeChatTabsFileMock.mock.calls[0];
    if (!writeArgs) {
      throw new Error('Expected hook tab persistence call');
    }
    const [, , writtenFile] = writeArgs;
    expect(writtenFile.tabs[0]?.model).toBe('gpt-6.1-sol');
    expect(writtenFile.tabs[0]?.providerType).toBe('codex');

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-6.1-sol',
        providerType: 'codex',
      }),
    );
  });

  it('launches with an explicit model even when no billing lane is dispatchable', async () => {
    // The lane default used to be awaited unconditionally, so a hook that named
    // its own model still died with "No dispatchable model is available" for a
    // signed-out / no-credits user — a flow that never needed a default at all.
    mockLaneDefaultUnavailable = true;
    const { launchHookChat } = loadHookChatModule();

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        model: 'claude-sonnet-4-6',
        thinking: 'high',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
      }),
    );
  });

  it('pins a hook Agent that inherits the default model to the worktree default', async () => {
    loadSharedTypesModule().initAgentModels([
      {
        id: 'agent_model_inherit',
        name: 'Inherit',
        baseModel: 'default',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-10-12T00:00:00.000Z',
        updatedAt: '2026-10-12T00:00:00.000Z',
        available: true,
      },
    ]);
    const { launchHookChat } = loadHookChatModule();
    try {
      await launchHookChat({
        projectId: 'project',
        worktreeId: 'worktree',
        action: {
          type: 'chat',
          prompt: 'Review failures',
          model: 'agent_model_inherit',
        },
        prompt: 'Review failures',
        triggerName: 'pr:checks:fail',
        getWindow: () => null,
      });
    } finally {
      loadSharedTypesModule().initAgentModels([]);
    }

    const writeArgs = writeChatTabsFileMock.mock.calls[0];
    if (!writeArgs) {
      throw new Error('Expected hook tab persistence call');
    }
    const [, , writtenFile] = writeArgs;
    expect(writtenFile.tabs[0]?.model).toBe('agent_model_inherit@gpt-5.5');
    expect(writtenFile.tabs[0]?.providerType).toBe('codex');
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'agent_model_inherit@gpt-5.5',
        providerType: 'codex',
      }),
    );
  });

  it('refuses a route that would run a pinned Agent on another model', async () => {
    loadSharedTypesModule().initAgentModels([
      {
        id: 'agent_model_pinned',
        name: 'Pinned',
        baseModel: 'claude-sonnet-4-6',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-10-13T00:00:00.000Z',
        updatedAt: '2026-10-13T00:00:00.000Z',
        available: true,
      },
    ]);
    const { launchHookChat } = loadHookChatModule();
    try {
      await expect(
        launchHookChat({
          projectId: 'project',
          worktreeId: 'worktree',
          action: {
            type: 'chat',
            prompt: 'Review failures',
            model: 'agent_model_pinned@gpt-5.5',
          },
          prompt: 'Review failures',
          triggerName: 'pr:checks:fail',
          getWindow: () => null,
        }),
      ).rejects.toThrow('Agent "agent_model_pinned" has its own base model.');
    } finally {
      loadSharedTypesModule().initAgentModels([]);
    }
    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();
  });

  it('clamps a repository hook Auto mode to the local Ask policy', async () => {
    const { launchHookChat } = loadHookChatModule();

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        model: 'gpt-5.5',
        thinking: 'medium',
        approvalMode: 'auto',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const writeArgs = writeChatTabsFileMock.mock.calls[0];
    if (!writeArgs) {
      throw new Error('Expected hook tab persistence call');
    }
    const [, , writtenFile] = writeArgs;
    expect(writtenFile.tabs[0]?.approvalMode).toBe('ask');

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'ask' }),
    );
  });

  it('uses a repository hook Auto mode when the local policy permits Auto', async () => {
    const { launchHookChat } = loadHookChatModule();
    readWorkspaceApprovalsMock.mockResolvedValue({
      version: 1,
      rules: [],
      defaultMode: 'auto',
    });

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        model: 'gpt-5.5',
        approvalMode: 'auto',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const [, , writtenFile] = writeChatTabsFileMock.mock.calls[0] ?? [];
    expect(writtenFile?.tabs[0]?.approvalMode).toBe('auto');
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'auto' }),
    );
  });

  it('resolves an inherited project approval mode when the hook omits one', async () => {
    const { launchHookChat } = loadHookChatModule();
    readWorkspaceApprovalsMock.mockResolvedValue({
      version: 1,
      rules: [],
      defaultMode: 'auto',
    });

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        model: 'gpt-5.5',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const [, , writtenFile] = writeChatTabsFileMock.mock.calls[0] ?? [];
    expect(writtenFile?.tabs[0]?.approvalMode).toBe('auto');
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'auto' }),
    );
  });

  it('omits interfaceMode for Codex hook tabs', async () => {
    const { launchHookChat } = loadHookChatModule();
    readPreferencesFileMock.mockResolvedValue({
      ...buildPreferences(),
      // Even when the user picks the managed terminal experience as their
      // default, Codex hooks must not inherit it — the experience is
      // Claude-specific.
      defaultChatInterfaceMode: 'claude-code',
    });

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        model: 'gpt-5.5',
        thinking: 'medium',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const writeArgs = writeChatTabsFileMock.mock.calls[0];
    if (!writeArgs) {
      throw new Error('Expected hook tab persistence call');
    }
    const [, , writtenFile] = writeArgs;
    const writtenTab = writtenFile.tabs[0];
    if (!writtenTab) {
      throw new Error('Expected hook tab in persisted file');
    }
    expect(writtenTab.interfaceMode).toBeUndefined();
    expect(writtenTab.providerType).toBe('codex');
  });

  it('scopes the chat to a child repo when the hook fires on workspace-repo', async () => {
    const { launchHookChat } = loadHookChatModule();

    await launchHookChat({
      projectId: 'workspace',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review frontend failures',
        model: 'gpt-5.5',
        thinking: 'medium',
      },
      prompt: 'Review frontend failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
      selectedRepoId: 'frontend',
    });

    const writeArgs = writeChatTabsFileMock.mock.calls[0];
    if (!writeArgs) {
      throw new Error('Expected hook tab persistence call');
    }
    const [, , writtenFile] = writeArgs;
    const persistedTab = writtenFile.tabs.find(
      (tab) => tab.id === 'chat-hook-1000-1',
    );
    expect(persistedTab?.selectedRepoId).toBe('frontend');

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'workspace',
        worktreeId: 'worktree',
        selectedRepoId: 'frontend',
      }),
    );
  });

  it('leaves selectedRepoId unset for workspace-root and single-repo hooks', async () => {
    const { launchHookChat } = loadHookChatModule();

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const writeArgs = writeChatTabsFileMock.mock.calls[0];
    if (!writeArgs) {
      throw new Error('Expected hook tab persistence call');
    }
    const [, , writtenFile] = writeArgs;
    const persistedTab = writtenFile.tabs.find(
      (tab) => tab.id === 'chat-hook-1000-1',
    );
    expect(persistedTab?.selectedRepoId).toBeUndefined();

    const dispatchArgs = dispatchWorktreeChatTurnMock.mock.calls[0]?.[0];
    expect(dispatchArgs?.selectedRepoId).toBeUndefined();
  });

  it('rolls back the persisted tab when no renderer can receive the start event', async () => {
    const { launchHookChat } = loadHookChatModule();
    const existingTab = buildTab('existing', 'Existing');
    currentTabsFile = buildTabsFile(existingTab);
    sendToWindowMock.mockReturnValue(false);

    await expect(
      launchHookChat({
        projectId: 'project',
        worktreeId: 'worktree',
        action: {
          type: 'chat',
          prompt: 'Review failures',
        },
        prompt: 'Review failures',
        triggerName: 'pr:checks:fail',
        getWindow: () => null,
      }),
    ).rejects.toThrow(
      'Hook chat requires an active renderer window before it can start.',
    );

    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();
    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(2);
    const rollbackArgs = writeChatTabsFileMock.mock.calls[1];
    if (!rollbackArgs) {
      throw new Error('Expected rollback persistence call');
    }
    expect(rollbackArgs[2]).toEqual({
      version: 1,
      tabs: [existingTab],
      activeTabId: 'existing',
    });
  });

  it('marks timers complete and emits an error event when dispatch fails', async () => {
    const { launchHookChat } = loadHookChatModule();
    const { IPC_CHANNELS } = loadSharedTypesModule();
    dispatchWorktreeChatTurnMock.mockRejectedValue(
      new Error('Dispatch failed'),
    );

    await expect(
      launchHookChat({
        projectId: 'project',
        worktreeId: 'worktree',
        action: {
          type: 'chat',
          prompt: 'Review failures',
        },
        prompt: 'Review failures',
        triggerName: 'pr:checks:fail',
        getWindow: () => null,
      }),
    ).rejects.toThrow('Dispatch failed');

    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(2);
    const failureWriteArgs = writeChatTabsFileMock.mock.calls[1];
    if (!failureWriteArgs) {
      throw new Error('Expected failure persistence call');
    }
    const failedTab = failureWriteArgs[2].tabs[0];
    if (!failedTab) {
      throw new Error('Expected failed tab');
    }
    const failedTimerBlock = failedTab.messages[2]?.blocks[0];
    if (!failedTimerBlock || failedTimerBlock.type !== 'turn_timer') {
      throw new Error('Expected completed turn timer');
    }
    expect(typeof failedTimerBlock.completedAt).toBe('number');
    expect(completeChatTurnMock).toHaveBeenCalledWith(
      'project',
      'worktree',
      'chat-hook-1000-1',
      'failure',
      'Dispatch failed',
    );
    expect(sendToWindowMock).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.chatEvent,
      expect.objectContaining({
        chatId: 'chat-hook-1000-1',
        data: { type: 'error', error: 'Dispatch failed' },
      }),
    );
  });

  it('replaces an existing tab with the same chat id instead of duplicating it', async () => {
    const { launchHookChat } = loadHookChatModule();
    currentTabsFile = {
      version: 1,
      tabs: [buildTab('chat-hook-1000-1', 'Old prompt')],
      activeTabId: 'chat-hook-1000-1',
    };

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const writeArgs = writeChatTabsFileMock.mock.calls[0];
    if (!writeArgs) {
      throw new Error('Expected replacement persistence call');
    }
    expect(writeArgs[2].tabs).toHaveLength(1);
    expect(writeArgs[2].tabs[0]?.title).toBe('Review failures');
  });

  it('queues hook chats behind active sessions without persisting the placeholder tab', async () => {
    const { launchHookChat } = loadHookChatModule();
    setMockHasActiveChatTurns(true);

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();
    expect(writeChatTabsFileMock).not.toHaveBeenCalled();

    const startedEvents = getHookChatStartedEvents();
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toEqual(
      expect.objectContaining({
        chatId: 'chat-hook-1000-1',
        activateTab: false,
        queuedMessage: {
          queueId: 'queued-hook-1000-3',
          text: 'Review failures',
          reason: 'Waiting for active chat sessions to finish.',
          hookInfo: { triggerName: 'pr:checks:fail', timestamp: 1000 },
        },
      }),
    );
    expect(startedEvents[0]?.tab.messages).toEqual([]);
    expect(startedEvents[0]?.tab.inheritedPluginDefaultsVersion).toBe(1);
  });

  it('keeps the queued hook banner time when the queued chat starts later', async () => {
    const { launchHookChat } = loadHookChatModule();
    setMockHasActiveChatTurns(true);

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    jest.spyOn(Date, 'now').mockReturnValue(5000);
    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();

    const startedEvents = getHookChatStartedEvents();
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[0]?.queuedMessage?.hookInfo?.timestamp).toBe(1000);
    const messages = startedEvents[1]?.tab.messages ?? [];
    expect(messages[0]?.blocks).toEqual([
      { type: 'hook_info', triggerName: 'pr:checks:fail', timestamp: 1000 },
    ]);
    expect(messages.at(-1)?.blocks).toEqual([
      { type: 'turn_timer', startedAt: 5000, completedAt: null },
    ]);
  });

  it('starts hook chats when only another worktree has active sessions', async () => {
    const { launchHookChat } = loadHookChatModule();
    setMockActiveChatTargets(['project/other-worktree']);

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(1);
    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(1);

    const startedEvents = getHookChatStartedEvents();
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]?.queuedMessage).toBeUndefined();
  });

  it('does not queue an idle worktree behind another worktree hook start', async () => {
    const { launchHookChat } = loadHookChatModule();
    const firstDispatch = createDeferred();
    dispatchWorktreeChatTurnMock.mockImplementationOnce(
      () => firstDispatch.promise,
    );

    const firstLaunch = launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree-a',
      action: {
        type: 'chat',
        prompt: 'First review',
      },
      prompt: 'First review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    await flushPromises();
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(1);

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree-b',
      action: {
        type: 'chat',
        prompt: 'Second review',
      },
      prompt: 'Second review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(2);
    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(2);
    const startedEvents = getHookChatStartedEvents();
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents.map((event) => event.worktreeId)).toEqual([
      'worktree-a',
      'worktree-b',
    ]);
    expect(startedEvents.every((event) => !event.queuedMessage)).toBe(true);

    firstDispatch.resolve();
    await firstLaunch;
  });

  it('does not let a queued hook for one worktree block another worktree', async () => {
    const { launchHookChat } = loadHookChatModule();
    setMockActiveChatTargets(['project/worktree-a']);

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree-a',
      action: {
        type: 'chat',
        prompt: 'First queued review',
      },
      prompt: 'First queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree-b',
      action: {
        type: 'chat',
        prompt: 'Second review',
      },
      prompt: 'Second review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(1);
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'worktree-b',
        text: 'Second review',
      }),
    );

    const startedEvents = getHookChatStartedEvents();
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[0]?.queuedMessage).toBeDefined();
    expect(startedEvents[1]?.worktreeId).toBe('worktree-b');
    expect(startedEvents[1]?.queuedMessage).toBeUndefined();
  });

  it('drains an unblocked worktree while an earlier queued worktree remains active', async () => {
    const { launchHookChat } = loadHookChatModule();
    setMockActiveChatTargets(['project/worktree-a', 'project/worktree-b']);

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree-a',
      action: {
        type: 'chat',
        prompt: 'First queued review',
      },
      prompt: 'First queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree-b',
      action: {
        type: 'chat',
        prompt: 'Second queued review',
      },
      prompt: 'Second queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();

    setMockActiveChatTargets(['project/worktree-a']);
    emitMockChatSessionActivity();
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(1);
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'worktree-b',
        text: 'Second queued review',
      }),
    );

    const startedEvents = getHookChatStartedEvents();
    expect(startedEvents).toHaveLength(3);
    expect(startedEvents[2]?.worktreeId).toBe('worktree-b');
    expect(startedEvents[2]?.queuedMessage).toBeUndefined();
  });

  it('uses a much larger full-prompt preview for queued placeholder text', async () => {
    const { launchHookChat } = loadHookChatModule();
    setMockHasActiveChatTurns(true);
    const longFirstLine =
      '1234567890'.repeat(30) +
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const fullPrompt = `${longFirstLine}\nSecond line should still appear`;

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: fullPrompt,
      },
      prompt: fullPrompt,
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const startedEvents = getHookChatStartedEvents();
    expect(startedEvents[0]?.queuedMessage?.text).toBe(fullPrompt);
  });

  it('starts queued hook chats one at a time as chat activity clears', async () => {
    const { launchHookChat } = loadHookChatModule();
    setMockHasActiveChatTurns(true);
    dispatchWorktreeChatTurnMock.mockImplementation(() => {
      setMockHasActiveChatTurns(true);
      return Promise.resolve();
    });

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'First queued review',
      },
      prompt: 'First queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Second queued review',
      },
      prompt: 'Second queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(1);
    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(1);

    let startedEvents = getHookChatStartedEvents();
    expect(startedEvents).toHaveLength(3);
    expect(startedEvents[2]).toEqual(
      expect.objectContaining({
        chatId: 'chat-hook-1000-1',
        activateTab: false,
      }),
    );
    expect(startedEvents[2]?.queuedMessage).toBeUndefined();

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(2);
    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(2);
    startedEvents = getHookChatStartedEvents();
    expect(startedEvents).toHaveLength(4);
    expect(startedEvents[3]).toEqual(
      expect.objectContaining({
        chatId: 'chat-hook-1000-4',
        activateTab: false,
      }),
    );
  });

  it('starts queued hook chats with placeholder setting edits applied before drain', async () => {
    const hookChatModule = loadHookChatModule();
    setMockHasActiveChatTurns(true);

    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Queued review',
      },
      prompt: 'Queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const queuedEvent = getHookChatStartedEvents()[0];
    const chatId = queuedEvent?.chatId;
    if (!chatId) {
      throw new Error('Expected queued hook chat id');
    }

    const pluginSelections: ChatTabPluginSelections = {
      collectionIds: ['bundle-a'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };

    hookChatModule.updateQueuedHookChatPlanMode({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId,
      enabled: true,
    });
    hookChatModule.updateQueuedHookChatApprovalMode({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId,
      mode: 'ask',
    });
    let resolvePreferences:
      | ((value: PreferencesData | PromiseLike<PreferencesData>) => void)
      | undefined;
    const pendingPreferences = new Promise<PreferencesData>((resolve) => {
      resolvePreferences = resolve;
    });
    readPreferencesFileMock.mockImplementationOnce(() => pendingPreferences);

    const modelUpdatePromise = hookChatModule.updateQueuedHookChatModel({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId,
      model: 'claude-sonnet-4-6',
    });
    hookChatModule.updateQueuedHookChatPluginSelections({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId,
      pluginSelections,
      deferredToolsAllowed: false,
    });

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();
    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();

    resolvePreferences?.(buildPreferences());
    await modelUpdatePromise;
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId,
        planMode: true,
        approvalMode: 'ask',
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        thinkingLevel: 'high',
        pluginSelections,
        deferredToolsAllowed: false,
      }),
    );

    const startedEvents = getHookChatStartedEvents();
    const startedEvent = startedEvents[1];
    expect(startedEvent).toEqual(
      expect.objectContaining({
        chatId,
        activateTab: false,
      }),
    );
    expect(startedEvent?.tab.planMode).toBe(true);
    expect(startedEvent?.tab.approvalMode).toBe('ask');
    expect(startedEvent?.tab.model).toBe('claude-sonnet-4-6');
    expect(startedEvent?.tab.providerType).toBe('claude');
    expect(startedEvent?.tab.thinkingLevel).toBe('high');
    expect(startedEvent?.tab.pluginSelections).toEqual(pluginSelections);
    expect(startedEvent?.tab.deferredToolsAllowed).toBe(false);
  });

  it('keeps the exact Codex speed for queued hook chats through speed and provider changes', async () => {
    const hookChatModule = loadHookChatModule();
    setMockHasActiveChatTurns(true);
    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Queued ultra review',
        model: 'gpt-5.5',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      },
      prompt: 'Queued ultra review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    const chatId = getHookChatStartedEvents()[0]?.chatId;
    if (!chatId) throw new Error('Expected queued hook chat id');
    const target = { projectId: 'project', worktreeId: 'worktree', chatId };

    // A legacy boolean command replaces Ultra, including `false`.
    hookChatModule.updateQueuedHookChatCodexFastMode({
      ...target,
      enabled: false,
    });
    // An exact speed command is authoritative.
    hookChatModule.updateQueuedHookChatCodexFastMode({
      ...target,
      enabled: false,
      speed: 'ultrafast',
    });
    // Codex → Claude → Codex keeps the requested Codex speed.
    await hookChatModule.updateQueuedHookChatModel({
      ...target,
      model: 'claude-sonnet-4-6',
    });
    await hookChatModule.updateQueuedHookChatModel({
      ...target,
      model: 'gpt-5.5',
    });

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock.mock.calls[0]?.[0]).toMatchObject({
      chatId,
      model: 'gpt-5.5',
      modelConfig: { speed: 'ultrafast', fastMode: false },
    });
  });

  it('applies a legacy boolean command to a queued Ultra hook chat as Regular', async () => {
    const hookChatModule = loadHookChatModule();
    setMockHasActiveChatTurns(true);
    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Queued ultra review',
        model: 'gpt-5.5',
        modelConfig: { speed: 'ultrafast' },
      },
      prompt: 'Queued ultra review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    const chatId = getHookChatStartedEvents()[0]?.chatId;
    if (!chatId) throw new Error('Expected queued hook chat id');
    hookChatModule.updateQueuedHookChatCodexFastMode({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId,
      enabled: false,
    });

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock.mock.calls[0]?.[0]).toMatchObject({
      chatId,
      modelConfig: { speed: 'standard', fastMode: false },
    });
  });

  it('starts a queued Claude hook on the interface mode chosen while it waited', async () => {
    const hookChatModule = loadHookChatModule();
    setMockHasActiveChatTurns(true);
    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Queued review',
        model: 'claude-sonnet-4-6',
      },
      prompt: 'Queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    const chatId = getHookChatStartedEvents()[0]?.chatId;
    if (!chatId) throw new Error('Expected queued hook chat id');

    expect(
      hookChatModule.updateQueuedHookChatInterfaceMode({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId,
        interfaceMode: 'claude-code',
      }),
    ).toBe(true);

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();
    expect(launchClaudeTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId, initialPrompt: 'Queued review' }),
      expect.any(Object),
    );
    expect(getHookChatStartedEvents()[1]?.tab.interfaceMode).toBe(
      'claude-code',
    );
  });

  it('starts a queued Claude hook as a Canopy turn after switching back from Claude Code', async () => {
    const hookChatModule = loadHookChatModule();
    readPreferencesFileMock.mockResolvedValue({
      ...buildPreferences(),
      defaultChatInterfaceMode: 'claude-code',
    });
    setMockHasActiveChatTurns(true);
    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Queued review',
        model: 'claude-sonnet-4-6',
      },
      prompt: 'Queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    const chatId = getHookChatStartedEvents()[0]?.chatId;
    if (!chatId) throw new Error('Expected queued hook chat id');

    hookChatModule.updateQueuedHookChatInterfaceMode({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId,
      interfaceMode: 'canopy',
    });

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();

    expect(launchClaudeTerminalMock).not.toHaveBeenCalled();
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId }),
    );
    expect(getHookChatStartedEvents()[1]?.tab.interfaceMode).toBeUndefined();
  });

  it('reports no queued hook to update once the hook has started', () => {
    const hookChatModule = loadHookChatModule();
    expect(
      hookChatModule.updateQueuedHookChatInterfaceMode({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'not-queued',
        interfaceMode: 'claude-code',
      }),
    ).toBe(false);
  });

  it('keeps the latest queued model change when async model updates resolve out of order', async () => {
    const hookChatModule = loadHookChatModule();
    setMockHasActiveChatTurns(true);

    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Queued review',
      },
      prompt: 'Queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const queuedEvent = getHookChatStartedEvents()[0];
    const chatId = queuedEvent?.chatId;
    if (!chatId) {
      throw new Error('Expected queued hook chat id');
    }

    let resolveFirstPreferences:
      | ((value: PreferencesData | PromiseLike<PreferencesData>) => void)
      | undefined;
    let resolveSecondPreferences:
      | ((value: PreferencesData | PromiseLike<PreferencesData>) => void)
      | undefined;
    const firstPreferences = new Promise<PreferencesData>((resolve) => {
      resolveFirstPreferences = resolve;
    });
    const secondPreferences = new Promise<PreferencesData>((resolve) => {
      resolveSecondPreferences = resolve;
    });
    readPreferencesFileMock
      .mockImplementationOnce(() => firstPreferences)
      .mockImplementationOnce(() => secondPreferences);

    const firstUpdatePromise = hookChatModule.updateQueuedHookChatModel({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId,
      model: 'claude-sonnet-4-6',
    });
    const secondUpdatePromise = hookChatModule.updateQueuedHookChatModel({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId,
      model: 'gpt-5.5',
    });

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();
    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();

    resolveSecondPreferences?.(buildPreferences());
    await flushPromises();
    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();

    resolveFirstPreferences?.(buildPreferences());
    await Promise.all([firstUpdatePromise, secondUpdatePromise]);
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId,
        model: 'gpt-5.5',
        providerType: 'codex',
        thinkingLevel: 'medium',
      }),
    );
  });

  it('does not let a later queued model update block draining the head entry', async () => {
    const hookChatModule = loadHookChatModule();
    setMockHasActiveChatTurns(true);

    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'First queued review',
      },
      prompt: 'First queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Second queued review',
      },
      prompt: 'Second queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const startedEvents = getHookChatStartedEvents();
    const secondChatId = startedEvents[1]?.chatId;
    if (!secondChatId) {
      throw new Error('Expected second queued hook chat id');
    }

    let resolvePreferences:
      | ((value: PreferencesData | PromiseLike<PreferencesData>) => void)
      | undefined;
    const pendingPreferences = new Promise<PreferencesData>((resolve) => {
      resolvePreferences = resolve;
    });
    readPreferencesFileMock.mockImplementationOnce(() => pendingPreferences);

    const modelUpdatePromise = hookChatModule.updateQueuedHookChatModel({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: secondChatId,
      model: 'claude-sonnet-4-6',
    });

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(1);
    expect(dispatchWorktreeChatTurnMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chatId: startedEvents[0]?.chatId,
        text: 'First queued review',
      }),
    );

    resolvePreferences?.(buildPreferences());
    await modelUpdatePromise;
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(2);
    expect(dispatchWorktreeChatTurnMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatId: secondChatId,
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        thinkingLevel: 'high',
      }),
    );
  });

  it('bypasses the queue when allowChatConcurrency is true', async () => {
    const { launchHookChat } = loadHookChatModule();
    setMockHasActiveChatTurns(true);

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
        allowChatConcurrency: true,
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(1);
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(1);
    const startedEvents = getHookChatStartedEvents();
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]?.queuedMessage).toBeUndefined();
    expect(startedEvents[0]?.activateTab).toBe(false);
  });

  it('serializes concurrent allowChatConcurrency starts so persisted tabs are not lost', async () => {
    const { launchHookChat } = loadHookChatModule();
    const firstWrite = createDeferred();
    let writeCount = 0;
    writeChatTabsFileMock.mockImplementation(
      (...args: WriteChatTabsArgs): Promise<void> => {
        const [, , data] = args;
        writeCount += 1;
        if (writeCount === 1) {
          return firstWrite.promise.then(() => {
            currentTabsFile = data;
          });
        }
        currentTabsFile = data;
        return Promise.resolve();
      },
    );

    const firstLaunch = launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'First concurrent review',
        allowChatConcurrency: true,
      },
      prompt: 'First concurrent review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    const secondLaunch = launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Second concurrent review',
        allowChatConcurrency: true,
      },
      prompt: 'Second concurrent review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    await flushPromises();
    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await Promise.all([firstLaunch, secondLaunch]);

    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(2);
    expect(currentTabsFile.tabs.map((tab) => tab.title)).toEqual([
      'First concurrent review',
      'Second concurrent review',
    ]);
  });

  it('cancels a queued hook chat before it starts', async () => {
    const hookChatModule = loadHookChatModule();
    setMockHasActiveChatTurns(true);

    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const startedEvents = getHookChatStartedEvents();
    const queueId = startedEvents[0]?.queuedMessage?.queueId;
    if (!queueId) {
      throw new Error('Expected a queued hook chat queueId');
    }

    expect(await hookChatModule.cancelQueuedHookChat(queueId)).toEqual({
      cancelled: true,
    });
    expect(await hookChatModule.cancelQueuedHookChat(queueId)).toEqual({
      cancelled: false,
    });

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();
    expect(writeChatTabsFileMock).not.toHaveBeenCalled();
  });

  it('cancels a queued hook chat while its persisted start is in flight', async () => {
    const hookChatModule = loadHookChatModule();
    const firstWrite = createDeferred();
    let writeCount = 0;
    setMockHasActiveChatTurns(true);

    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const queueId = getHookChatStartedEvents()[0]?.queuedMessage?.queueId;
    if (!queueId) {
      throw new Error('Expected a queued hook chat queueId');
    }

    writeChatTabsFileMock.mockImplementation((...args: WriteChatTabsArgs) => {
      const [, , data] = args;
      writeCount += 1;
      if (writeCount === 1) {
        return firstWrite.promise.then(() => {
          currentTabsFile = data;
        });
      }
      currentTabsFile = data;
      return Promise.resolve();
    });

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();
    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(1);

    let cancellationSettled = false;
    const cancellation = Promise.resolve(
      hookChatModule.cancelQueuedHookChat(queueId),
    ).then((result) => {
      cancellationSettled = true;
      return result;
    });
    await flushPromises();
    expect(cancellationSettled).toBe(false);

    firstWrite.resolve();
    expect(await cancellation).toEqual({ cancelled: true });
    await flushPromises();
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();
    expect(
      getHookChatStartedEvents().filter(
        (event) => event.queuedMessage === undefined,
      ),
    ).toHaveLength(0);
    expect(currentTabsFile.tabs).toEqual([]);
  });

  it.each(['persist', 'rollback'])(
    'closes a queued hook placeholder when the in-flight %s write fails',
    async (failedWrite) => {
      const hookChatModule = loadHookChatModule();
      const firstWrite = createDeferred();
      let writeCount = 0;
      setMockHasActiveChatTurns(true);

      await hookChatModule.launchHookChat({
        projectId: 'project',
        worktreeId: 'worktree',
        action: { type: 'chat', prompt: 'Review failures' },
        prompt: 'Review failures',
        triggerName: 'pr:checks:fail',
        getWindow: () => null,
      });
      const queueId = getHookChatStartedEvents()[0]?.queuedMessage?.queueId;
      if (!queueId) throw new Error('Expected a queued hook chat queueId');

      writeChatTabsFileMock.mockImplementation((...args: WriteChatTabsArgs) => {
        const [, , data] = args;
        writeCount += 1;
        if (writeCount === 1) {
          return firstWrite.promise.then(() => {
            if (failedWrite === 'persist') throw new Error('persist failed');
            currentTabsFile = data;
          });
        }
        if (failedWrite === 'rollback' && writeCount === 2) {
          return Promise.reject(new Error('rollback failed'));
        }
        currentTabsFile = data;
        return Promise.resolve();
      });

      setMockHasActiveChatTurns(false);
      emitMockChatSessionActivity();
      await flushPromises();
      expect(writeChatTabsFileMock).toHaveBeenCalledTimes(1);

      const cancellation = hookChatModule.cancelQueuedHookChat(queueId);
      firstWrite.resolve();
      expect(await cancellation).toEqual({ cancelled: true });
      await flushPromises();

      expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();
      expect(currentTabsFile.tabs).toEqual([]);
    },
  );

  it('keeps a failed cancellation cleanup retryable', async () => {
    const hookChatModule = loadHookChatModule();
    const firstWrite = createDeferred();
    let writeCount = 0;
    setMockHasActiveChatTurns(true);
    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: { type: 'chat', prompt: 'Review failures' },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    const queueId = getHookChatStartedEvents()[0]?.queuedMessage?.queueId;
    if (!queueId) throw new Error('Expected a queued hook chat queueId');

    writeChatTabsFileMock.mockImplementation((...args: WriteChatTabsArgs) => {
      const [, , data] = args;
      writeCount += 1;
      if (writeCount === 1) {
        return firstWrite.promise.then(() => {
          currentTabsFile = data;
        });
      }
      if (writeCount <= 3) {
        return Promise.reject(new Error('temporary rollback failure'));
      }
      currentTabsFile = data;
      return Promise.resolve();
    });

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();
    const cancellation = hookChatModule.cancelQueuedHookChat(queueId);
    firstWrite.resolve();
    await expect(cancellation).rejects.toThrow('temporary rollback failure');
    expect(currentTabsFile.tabs).toHaveLength(1);

    expect(await hookChatModule.cancelQueuedHookChat(queueId)).toEqual({
      cancelled: true,
    });
    expect(currentTabsFile.tabs).toEqual([]);
    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();
  });

  it('keeps a failed forced-start cancellation cleanup retryable', async () => {
    const hookChatModule = loadHookChatModule();
    const firstWrite = createDeferred();
    let writeCount = 0;
    setMockHasActiveChatTurns(true);
    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: { type: 'chat', prompt: 'Review failures' },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    const queueId = getHookChatStartedEvents()[0]?.queuedMessage?.queueId;
    if (!queueId) throw new Error('Expected a queued hook chat queueId');

    writeChatTabsFileMock.mockImplementation((...args: WriteChatTabsArgs) => {
      const [, , data] = args;
      writeCount += 1;
      if (writeCount === 1) {
        return firstWrite.promise.then(() => {
          currentTabsFile = data;
        });
      }
      if (writeCount <= 3) {
        return Promise.reject(new Error('temporary rollback failure'));
      }
      currentTabsFile = data;
      return Promise.resolve();
    });

    const forcedStart = hookChatModule.forceQueuedHookChat(queueId);
    const forcedStartFailure = expect(forcedStart).rejects.toThrow(
      'temporary rollback failure',
    );
    await flushPromises();
    const cancellation = hookChatModule.cancelQueuedHookChat(queueId);
    firstWrite.resolve();
    await expect(cancellation).rejects.toThrow('temporary rollback failure');
    await forcedStartFailure;
    expect(currentTabsFile.tabs).toHaveLength(1);

    expect(await hookChatModule.cancelQueuedHookChat(queueId)).toEqual({
      cancelled: true,
    });
    expect(currentTabsFile.tabs).toEqual([]);
    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();
  });

  it('forces a queued hook chat to start immediately', async () => {
    const hookChatModule = loadHookChatModule();
    setMockHasActiveChatTurns(true);

    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const queueId = getHookChatStartedEvents()[0]?.queuedMessage?.queueId;
    if (!queueId) {
      throw new Error('Expected queued hook chat queueId');
    }

    expect(dispatchWorktreeChatTurnMock).not.toHaveBeenCalled();

    await expect(hookChatModule.forceQueuedHookChat(queueId)).resolves.toEqual({
      forced: true,
    });

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(1);
    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        text: 'Review failures',
      }),
    );

    const startedEvents = getHookChatStartedEvents();
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[1]).toEqual(
      expect.objectContaining({
        chatId: 'chat-hook-1000-1',
        activateTab: false,
      }),
    );
    expect(startedEvents[1]?.queuedMessage).toBeUndefined();
  });

  it('serializes a forced queued start with the scheduled drain for the same target', async () => {
    const hookChatModule = loadHookChatModule();
    const firstWrite = createDeferred();
    let writeCount = 0;
    setMockHasActiveChatTurns(true);

    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Forced review',
      },
      prompt: 'Forced review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Scheduled review',
      },
      prompt: 'Scheduled review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const startedEvents = getHookChatStartedEvents();
    const forcedQueueId = startedEvents[0]?.queuedMessage?.queueId;
    const scheduledChatId = startedEvents[1]?.chatId;
    if (!forcedQueueId || !scheduledChatId) {
      throw new Error('Expected both queued hook chat identifiers');
    }

    writeChatTabsFileMock.mockImplementation((...args: WriteChatTabsArgs) => {
      const [, , data] = args;
      writeCount += 1;
      if (writeCount === 1) {
        return firstWrite.promise.then(() => {
          currentTabsFile = data;
        });
      }
      currentTabsFile = data;
      return Promise.resolve();
    });

    const forcedStart = hookChatModule.forceQueuedHookChat(forcedQueueId);
    await flushPromises();
    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(1);

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();

    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(1);
    expect(
      hookChatModule.hasQueuedHookChat({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: scheduledChatId,
      }),
    ).toBe(true);

    firstWrite.resolve();
    await forcedStart;
    await flushPromises();
    await flushPromises();

    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(2);
    expect(currentTabsFile.tabs.map((tab) => tab.title)).toEqual([
      'Forced review',
      'Scheduled review',
    ]);
  });

  it('does not drain a forced queued hook a second time after activity clears', async () => {
    const hookChatModule = loadHookChatModule();
    setMockHasActiveChatTurns(true);

    await hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Review failures',
      },
      prompt: 'Review failures',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    const queueId = getHookChatStartedEvents()[0]?.queuedMessage?.queueId;
    if (!queueId) {
      throw new Error('Expected queued hook chat queueId');
    }

    await hookChatModule.forceQueuedHookChat(queueId);
    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(1);
  });

  it('continues draining queued hook chats after a queued start fails', async () => {
    const { launchHookChat } = loadHookChatModule();
    setMockHasActiveChatTurns(true);
    dispatchWorktreeChatTurnMock
      .mockRejectedValueOnce(new Error('dispatch failed'))
      .mockResolvedValueOnce(undefined);

    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'First queued review',
      },
      prompt: 'First queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    await launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Second queued review',
      },
      prompt: 'Second queued review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    setMockHasActiveChatTurns(false);
    emitMockChatSessionActivity();
    await flushPromises();
    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(2);
    expect(currentTabsFile.tabs.map((tab) => tab.title)).toContain(
      'Second queued review',
    );
  });

  it('holds the start guard so a second synchronous launch queues instead of starting immediately', async () => {
    const hookChatModule = loadHookChatModule();
    const deferred = createDeferred();
    dispatchWorktreeChatTurnMock.mockImplementation(() => deferred.promise);

    const firstLaunch = hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'First review',
      },
      prompt: 'First review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });
    const secondLaunch = hookChatModule.launchHookChat({
      projectId: 'project',
      worktreeId: 'worktree',
      action: {
        type: 'chat',
        prompt: 'Second review',
      },
      prompt: 'Second review',
      triggerName: 'pr:checks:fail',
      getWindow: () => null,
    });

    await flushPromises();

    expect(dispatchWorktreeChatTurnMock).toHaveBeenCalledTimes(1);
    expect(writeChatTabsFileMock).toHaveBeenCalledTimes(1);

    const startedEvents = getHookChatStartedEvents();
    expect(startedEvents).toHaveLength(2);
    const queuedEvent = startedEvents.find(
      (event) => event.queuedMessage !== undefined,
    );
    const startedEvent = startedEvents.find(
      (event) => event.queuedMessage === undefined,
    );
    expect(startedEvent).toBeDefined();
    expect(queuedEvent?.queuedMessage?.reason).toBe(
      'Waiting for active chat sessions to finish.',
    );

    const queuedQueueId = queuedEvent?.queuedMessage?.queueId;
    if (!queuedQueueId) {
      throw new Error('Expected queued hook chat queueId');
    }
    expect(await hookChatModule.cancelQueuedHookChat(queuedQueueId)).toEqual({
      cancelled: true,
    });

    deferred.resolve();
    await firstLaunch;
    await secondLaunch;
  });
});
