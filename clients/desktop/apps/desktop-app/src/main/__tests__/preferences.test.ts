import type * as EnablementCommit from '../pipelines/pipeline-enablement-commit';
import type * as DataSharingOptInAuthorityModule from '../lib/data-sharing-opt-in-authority';
import type * as AtomicFileModule from '../lib/atomic-file';
import {
  createDirectoryDurably,
  renameWithRetry,
  writeFileAtomically,
} from '../lib/atomic-file';
import { DataSharingOptInError } from '../lib/data-sharing-opt-in-authority';
import { personalCatalogPreferenceChanged } from '../services/personal-catalog-sync-host';
import { notifyManagedDelegationLifetimePreferencesChanged } from '../agents/delegation/lifetime-status';
// Core records enablement through the desktop's preference port; the
// pipeline goldens cover the real dispatch.
jest.mock('../canopy-runtime/pipeline-definition-dispatch', () => ({
  setPipelineDefinitionEnabled: (
    id: string,
    enabled: boolean,
  ): Promise<unknown> => {
    const commit = jest.requireActual<typeof EnablementCommit>(
      '../pipelines/pipeline-enablement-commit',
    );
    return commit.withPipelineEnablementCommit(() =>
      commit.recordPipelineEnabled(id, enabled),
    );
  },
}));
jest.mock('../agents/delegation/lifetime-status', () => ({
  notifyManagedDelegationLifetimePreferencesChanged: jest.fn(),
}));
jest.mock('../services/personal-catalog-sync-host', () => ({
  personalCatalogPreferenceChanged: jest.fn(),
}));
import type {
  AppAdvisorProjectAgentAccess,
  BranchDisplayMapping,
  CodeGraphPreferences,
  PreferencesData,
  PreferencesFile,
  PreferencesLoadResult,
  ThinkingLevel,
} from '@canopy/desktop-shared/types';
import type { ResolvedCanopyDataDir } from '@canopy/protocol/brand';
import type { Stats } from 'node:fs';
import { statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { RemoteHostSession } from '../remote-control/host/host-session';
import { RemoteUploadStore } from '../remote-control/host/uploads';
import {
  REMOTE_METHODS,
  type HelloResult,
} from '../remote-control/remote-protocol';
import { RpcPeer } from '../remote-control/transport/rpc-peer';
import {
  FakeBridge,
  FakeMainWindow,
  TEST_VERSION,
} from '../remote-control/__tests__/host-fakes';
import { InMemoryRelayHub } from '../remote-control/__tests__/in-memory-relay';
import {
  createTestDevice,
  openControlSession,
} from '../remote-control/__tests__/session-pair';
import {
  DEFAULT_SIDEBAR_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '@canopy/desktop-shared/constants/preferences';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_HIDE_ANTHROPIC_NAV,
  getExecutionHarnessForModel,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initCursorModels,
  getCursorModelEntries,
  initModelAliases,
  initOllamaModels,
} from '@canopy/desktop-shared/types';

const mockRevokeOpenCodeRuntimes = jest.fn(async () => {});
jest.mock('../opencode/connection', () => ({
  get revokeOpenCodeRuntimes(): typeof mockRevokeOpenCodeRuntimes {
    return mockRevokeOpenCodeRuntimes;
  },
}));
const mockInvalidateCursorModels = jest.fn(() => Promise.resolve());
const mockRefreshCursorRuntimeAvailability = jest.fn(() =>
  Promise.resolve(false),
);
const mockBroadcastModelRegistryUpdated = jest.fn();
// `broadcastModelRegistryUpdated` above only reaches desktop renderer
// windows. An already-open Portal session needs the separate
// `notifyPortalStructureChanged` push (matching the Connect/Disconnect
// fix) or it keeps advertising Cursor as available after the preference
// disables it. See `ipc/__tests__/cursor-connection.test.ts` for the
// Connect/Disconnect coverage of the same contract.
const mockNotifyPortalStructureChanged = jest.fn();
jest.mock('../cursor/models', () => ({
  get invalidateCursorModels(): typeof mockInvalidateCursorModels {
    return mockInvalidateCursorModels;
  },
}));
jest.mock('../cursor/runtime-availability', () => ({
  get refreshCursorRuntimeAvailability(): typeof mockRefreshCursorRuntimeAvailability {
    return mockRefreshCursorRuntimeAvailability;
  },
}));
jest.mock('../models/model-registry', () => ({
  get broadcastModelRegistryUpdated(): typeof mockBroadcastModelRegistryUpdated {
    return mockBroadcastModelRegistryUpdated;
  },
}));
jest.mock('../portal/portal-event-bus', () => ({
  get notifyPortalStructureChanged(): typeof mockNotifyPortalStructureChanged {
    return mockNotifyPortalStructureChanged;
  },
}));

function initializeTestModelRegistries(): void {
  // Populate the dynamic model registries so ALL_MODELS validation passes.
  initClaudeModels([
    { id: 'opus[1m]', label: 'Opus 4.8 1M' },
    { id: 'sonnet', label: 'Sonnet 5' },
    { id: 'haiku', label: 'Haiku 5.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ]);
  initCodexModels([
    { id: DEFAULT_CODEX_MODEL, label: 'Native Codex default' },
    { id: 'gpt-6-luna', label: 'GPT 6 Luna' },
    { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' },
    { id: 'gpt-5.3-codex-spark', label: 'GPT 5.3-Codex-Spark' },
  ]);
  initAiGatewayModels(
    [
      {
        id: 'deepseek-v4-pro',
        family: 'deepseek',
        label: 'DeepSeek V4 Pro',
        recommendedHarness: 'codex',
        contextWindow: 1_000_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      },
    ],
    [
      {
        modelId: 'deepseek-v4-pro',
        gatewayId: 'deepseek/deepseek-v4-pro',
        family: 'deepseek',
        recommendedHarness: 'codex',
        gatewayOnly: true,
        contextWindow: 1_000_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      },
    ],
  );
  initOllamaModels([
    {
      id: 'ollama-qwen3-coder',
      rawModelId: 'qwen3-coder',
      label: 'qwen3-coder',
      show: {
        capabilities: ['completion', 'tools'],
      },
    },
  ]);
  initModelAliases({
    'claude-opus-4-7': 'opus[1m]',
    'claude-opus-4-8': 'opus[1m]',
    'claude-sonnet-4-5-20250929': 'sonnet',
    'claude-sonnet-4-6': 'sonnet',
    'gpt-6-sol': DEFAULT_CODEX_MODEL,
    'gpt-5.5': DEFAULT_CODEX_MODEL,
    'gpt-5.4-mini': 'gpt-5.6-luna',
  });
}

initializeTestModelRegistries();

jest.mock('node:fs/promises');
// Folder durability runs on real folders in atomic-file-durability.test.ts.
jest.mock('../lib/atomic-file', () => ({
  ...jest.requireActual<typeof AtomicFileModule>('../lib/atomic-file'),
  createDirectoryDurably: jest.fn(),
  writeFileAtomically: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getPreferencesFilePath: jest.fn(() => '/mock/userData/preferences.json'),
  getWorkspaceMemoryDir: (workspaceId: string): string =>
    `/mock/workspaces/${workspaceId}/memory`,
}));
const mockPrimaryDataDir = '/mock/home/.testbrand';
const mockFallbackDataDir = '/mock/home/.canopy';
const mockGetPrimaryBrandDataDir = jest.fn(() => mockPrimaryDataDir);
const mockGetResolvedCanopyDataDir = jest.fn<ResolvedCanopyDataDir, []>(() => ({
  path: mockFallbackDataDir,
  source: 'fallback',
  allCandidates: [mockPrimaryDataDir, mockFallbackDataDir],
}));
const mockResetResolvedCanopyDataDirCache = jest.fn();
jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  DATA_DIR_ADOPTION_MARKER_FILENAME: 'data-dir-adopted.json',
  get getPrimaryBrandDataDir(): typeof mockGetPrimaryBrandDataDir {
    return mockGetPrimaryBrandDataDir;
  },
  get getResolvedCanopyDataDir(): typeof mockGetResolvedCanopyDataDir {
    return mockGetResolvedCanopyDataDir;
  },
  get resetResolvedCanopyDataDirCache(): typeof mockResetResolvedCanopyDataDirCache {
    return mockResetResolvedCanopyDataDirCache;
  },
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));
jest.mock('../lib/desktop-telemetry', () => ({
  recordOnboardingProfileTelemetry: jest.fn(),
}));
const enqueueManualLocalMemoryImportBatchMock = jest.fn();
jest.mock('../memory/local/import/import-job', () => ({
  get enqueueManualLocalMemoryImportBatch(): typeof enqueueManualLocalMemoryImportBatchMock {
    return enqueueManualLocalMemoryImportBatchMock;
  },
}));
const mockSharingRefresh = jest.fn(() => Promise.resolve());
const mockOptInAuthority = jest.fn();
const mockPersonalOptInAuthority = jest.fn();
jest.mock('../lib/data-sharing-opt-in-authority', () => ({
  ...jest.requireActual<typeof DataSharingOptInAuthorityModule>(
    '../lib/data-sharing-opt-in-authority',
  ),
  requireDataSharingOptInAuthority: (...args: unknown[]): unknown =>
    mockOptInAuthority(...args),
  requireDataSharingPersonalOptInAuthority: (...args: unknown[]): unknown =>
    mockPersonalOptInAuthority(...args),
}));
jest.mock('../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: jest.fn(() => ({
    refreshScopeFromPreferences: mockSharingRefresh,
  })),
}));
const syncGlobalFocusShortcutFromPreferencesMock = jest.fn<
  Promise<void>,
  [PreferencesData]
>();
jest.mock('../ipc/global-focus-shortcut', () => ({
  syncGlobalFocusShortcutFromPreferences: (
    preferences: PreferencesData,
  ): Promise<void> => syncGlobalFocusShortcutFromPreferencesMock(preferences),
}));
const applyDefaultBrowserRegistrationMock = jest.fn();
jest.mock('../browser/default-browser-registration', () => ({
  getDefaultBrowserRegistrationService: (): {
    apply: typeof applyDefaultBrowserRegistrationMock;
  } => ({
    apply: applyDefaultBrowserRegistrationMock,
  }),
}));
const syncOnboardingProfilePreferencesMock = jest.fn(() => Promise.resolve());
jest.mock('../services/onboarding-profile-sync-service', () => ({
  get syncOnboardingProfilePreferences(): typeof syncOnboardingProfilePreferencesMock {
    return syncOnboardingProfilePreferencesMock;
  },
}));
const setRetentionDaysMock = jest.fn();
const updateCodexSessionIdleTimeoutMinutesMock = jest.fn();
const updateClaudeSessionIdleTimeoutMinutesMock = jest.fn();
const updateCodexRuntimeIdleTimeoutMinutesMock = jest.fn();
const markCodexSessionsForNextTurnRecreationMock = jest.fn();
const mockMarkManagedDelegation = jest.fn();
const mockUpdateManagedDelegationMaxConcurrent = jest.fn();
const mockUpdateManagedDelegationLifetimeLimit = jest.fn<void, [number]>();
const mockUpdateManagedDelegationPolicy = jest.fn(() => Promise.resolve());
jest.mock('../agents/delegation/service', () => ({
  get updateManagedDelegationPolicy(): typeof mockUpdateManagedDelegationPolicy {
    return mockUpdateManagedDelegationPolicy;
  },
  updateManagedDelegationMaxDepth: jest.fn(),
  get updateManagedDelegationMaxConcurrent(): typeof mockUpdateManagedDelegationMaxConcurrent {
    return mockUpdateManagedDelegationMaxConcurrent;
  },
  get updateManagedDelegationLifetimeLimit(): typeof mockUpdateManagedDelegationLifetimeLimit {
    return mockUpdateManagedDelegationLifetimeLimit;
  },
}));
const wakeLockSetEnabledMock = jest.fn();
const globalWithOllamaFlag = globalThis as typeof globalThis & {
  __CANOPY_OLLAMA_ENABLED__: boolean;
};
const originalOllamaEnabled = globalWithOllamaFlag.__CANOPY_OLLAMA_ENABLED__;
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    setRetentionDays: setRetentionDaysMock,
  })),
}));
jest.mock('../agents/session-manager', () => ({
  get markManagedDelegationSessionsForNextTurnRecreation(): typeof mockMarkManagedDelegation {
    return mockMarkManagedDelegation;
  },
  get markCodexSessionsForNextTurnRecreation(): typeof markCodexSessionsForNextTurnRecreationMock {
    return markCodexSessionsForNextTurnRecreationMock;
  },
  get updateCodexSessionIdleTimeoutMinutes(): typeof updateCodexSessionIdleTimeoutMinutesMock {
    return updateCodexSessionIdleTimeoutMinutesMock;
  },
  get updateClaudeSessionIdleTimeoutMinutes(): typeof updateClaudeSessionIdleTimeoutMinutesMock {
    return updateClaudeSessionIdleTimeoutMinutesMock;
  },
}));
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    admin: jest.fn(() => ({
      updateIdleTimeoutMinutes: updateCodexRuntimeIdleTimeoutMinutesMock,
    })),
  })),
}));
const proxyIsRunningMock = jest.fn(() => false);
const proxyUpdatePortMock = jest.fn<Promise<void>, [number]>(() =>
  Promise.resolve(),
);
const proxyAssertPortAvailableMock = jest.fn<Promise<void>, [number]>(() =>
  Promise.resolve(),
);
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    get isRunning(): typeof proxyIsRunningMock {
      return proxyIsRunningMock;
    },
    get updatePort(): typeof proxyUpdatePortMock {
      return proxyUpdatePortMock;
    },
    get assertPortAvailable(): typeof proxyAssertPortAvailableMock {
      return proxyAssertPortAvailableMock;
    },
  })),
}));
const mockRefreshCatalogAgentDefaults = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
jest.mock('../agents/agent-default-model', () => ({
  refreshCatalogAgentDefaults: (changed: unknown): Promise<void> =>
    mockRefreshCatalogAgentDefaults(changed),
}));
jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: jest.fn(() => ({
    get setEnabled(): typeof wakeLockSetEnabledMock {
      return wakeLockSetEnabledMock;
    },
  })),
}));
const memoryDiagnosticsSetEnabledMock = jest.fn();
jest.mock('../memory-diagnostics', () => ({
  getMemoryDiagnosticsService: jest.fn(() => ({
    get setEnabled(): typeof memoryDiagnosticsSetEnabledMock {
      return memoryDiagnosticsSetEnabledMock;
    },
  })),
}));
let cachedCodeGraphPreferences: CodeGraphPreferences = {
  mode: 'enabled',
  selectedWorkspaceIds: [],
  generationTimeoutMinutes: 30,
};
const reconcileCodeGraphAvailabilityMock = jest.fn(() => Promise.resolve());
jest.mock('../lib/code-graph-availability', () => ({
  getCodeGraphPreferencesSnapshot: (): CodeGraphPreferences => ({
    ...cachedCodeGraphPreferences,
    selectedWorkspaceIds: [...cachedCodeGraphPreferences.selectedWorkspaceIds],
  }),
  setCodeGraphPreferences: (preferences: CodeGraphPreferences): void => {
    cachedCodeGraphPreferences = {
      ...preferences,
      selectedWorkspaceIds: [...preferences.selectedWorkspaceIds],
    };
  },
  reconcileCodeGraphAvailability: (): Promise<void> =>
    reconcileCodeGraphAvailabilityMock(),
}));

/** Default values for the newer preference fields so tests stay concise. */
const NEW_DEFAULTS: Partial<PreferencesData> = {
  workspaceDefaultLayoutMode: 'advanced',
  navigationMode: 'code',
  ledgerAgentRecordingEnabled: true,
  repeatTaskAutomationSuggestionsEnabled: true,
  skillSuggestionsEnabled: true,
  rendererCodeCacheSchemeEnabled: false,
  chatDetail: 'recent',
  remoteControlEnabled: true,
  codeGraph: {
    mode: 'enabled',
    selectedWorkspaceIds: [],
    generationTimeoutMinutes: 30,
  },
  appAdvisorProjectAgentAccess: {
    mode: 'enabled',
    selectedOwners: [],
  },
  activityPanelExpanded: false,
  activityPanelWidthPercent: 25,
  kanbanWorktreePanelPercent: 32,
  kanbanActivityPanelExpanded: false,
  kanbanActivityPanelWidthPercent: 25,
  kanbanChatPanelVisible: false,
  pipelineChatPanelVisible: true,
  pipelineChatPanelWidthPercent: 30,
  sidebarProjectSortMode: 'manual',
  sidebarWidth: 280,
  sidebarCodeSectionCollapsed: false,
  sidebarCoworkSectionCollapsed: false,
  sidebarNavLayout: {
    order: [
      'app-advisor',
      'workflows',
      'plugins',
      'feed',
      'remote-control',
      'overview',
      'kanban',
      'statistics',
      'audit',
      'workers',
    ],
    moreStartIndex: 10,
  },
  branchNamePrefixMode: 'github' as const,
  branchNameCustomPrefix: '',
  deleteBranchOnArchive: true,
  archiveOnMerge: true,
  groupChildBranchesWithBase: true,
  defaultChatProvider: 'claude' as const,
  defaultChatModelByProvider: {
    claude: { model: 'opus[1m]', thinkingLevel: 'high' as const },
    codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' as const },
    ollama: null,
    aiCredits: null,
  },
  defaultWorktreeProvider: 'claude' as const,
  defaultWorktreeModelByProvider: {
    claude: { model: 'opus[1m]', thinkingLevel: 'high' as const },
    codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' as const },
    ollama: null,
    aiCredits: null,
  },
  approvalDefaults: {
    worktree: 'full-access' as const,
    cowork: 'full-access' as const,
    appAdvisor: 'full-access' as const,
  },
  globalApprovalRules: [],
  approvalsUpgradeNoticeDismissed: false,
  onboardingTipsDismissed: {},
  summaryModel: 'gpt-6-luna' as const,
  summaryModelSetByUser: false,
  summaryThinkingLevel: 'off' as const,
  handoffSummaryModel: 'haiku' as const,
  handoffSummaryThinkingLevel: 'off' as const,
  worktreeSummaryEnabled: true,
  worktreeSummaryModel: 'haiku' as const,
  worktreeSummaryThinkingLevel: 'off' as const,
  planDiagramModel: 'haiku' as const,
  planDiagramThinkingLevel: 'off' as const,
  codeReviewModel: 'haiku' as const,
  codeReviewThinkingLevel: 'off' as const,
  prGenerationModel: 'sonnet' as const,
  prGenerationThinkingLevel: 'high' as const,
  prInstructions: '',
  prInstructionMode: 'append' as const,
  commitGenerationModel: 'sonnet' as const,
  commitGenerationThinkingLevel: 'high' as const,
  commitInstructions: '',
  commitInstructionMode: 'append' as const,
  branchNamingModel: 'haiku' as const,
  branchNamingThinkingLevel: 'off' as const,
  branchNamingInstructions: '',
  globalInstructions: {
    chats: { overall: '', scoped: [] },
    pipelines: { overall: '', scoped: [] },
  },
  pipelineAdvisorEnabled: true,
  orgMemoryInjectionEnabled: true,
  orgProjectCloneProtocol: 'https',
  localMemoryEnabled: true,
  localMemoryEnabledSetByUser: false,
  localMemoryModel: 'gpt-6.1-sol' as const,
  localMemoryModelSetByUser: false,
  localMemoryThinkingLevel: 'high' as const,
  pipelineAdvisorModel: DEFAULT_CODEX_MODEL,
  pipelineAdvisorThinkingLevel: 'high' as const,
  pipelineEditorPluginSelections: {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  },
  disabledPipelineIds: [],
  appAdvisorModel: DEFAULT_CODEX_MODEL,
  appAdvisorThinkingLevel: 'high' as const,
  cronGenerationModel: DEFAULT_CODEX_MODEL,
  cronGenerationThinkingLevel: 'medium' as const,
  ifCommandGenerationModel: DEFAULT_CODEX_MODEL,
  ifCommandGenerationThinkingLevel: 'medium' as const,
  splitPrThresholdLines: 500,
  splitPrEnabled: true,
  splitPrPlannerModel: DEFAULT_CODEX_MODEL,
  splitPrPlannerThinkingLevel: 'high' as const,
  globalPluginSelections: {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  },
  appAdvisorPluginSelections: {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  },
  appAdvisorDialogBounds: null,
  codexMultiAgentAppAdvisorEnabled: true,
  providerModelConfigDefaults: {
    codex: { fastMode: false },
  },
  codexFastModeDefaultEnabled: false,
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
  codexCompatDisabledPlugins: [] as string[],
  branchDisplayMappings: [] as BranchDisplayMapping[],
  reviewCommitMessage: false,
  agentRebaseResolutionEnabled: false,
  agentRebaseResolutionModel: null,
  agentRebaseResolutionThinkingLevel: null,
  mergeQueueAgentHandling: 'when_hook_absent',
  rtkEnabled: true,
  autoRetryTransientErrorsChats: true,
  autoRetryTransientErrorsPipelines: true,
  scriptTimeoutMinutes: 5,
  codexAppServerIdleTimeoutMinutes: 10,
  claudeSessionIdleTimeoutMinutes: 10,
  defaultChatInterfaceMode: 'canopy' as const,
  defaultStandaloneChatInterfaceMode: 'canopy' as const,
  defaultAppAdvisorInterfaceMode: 'canopy' as const,
  preventClaudeNativeCaffeinate: true,
  claudeMaxTurns: 500,
  maxActiveChatTurns: 10,
  maxActivePipelineExecutions: 5,
  canopyBackgroundProcessesMode: 'canopy' as const,
  pipelinesMode: 'canopy' as const,
  workerConcurrencyLimit: 5,
  memoryPressureGuardEnabled: false,
  bypassCodexAppServerIdleTimeoutUnderCriticalPressure: true,
  memoryPressureWarningThresholdBytes: 2 * 1024 * 1024 * 1024,
  memoryPressureCriticalThresholdBytes: 4 * 1024 * 1024 * 1024,
  memoryDiagnosticsEnabled: false,
  keepSystemAwakeWhileAgentsActive: true,
  managedDelegationMaxDepth: 1,
  managedDelegationLifetimeLimit: 512,
  managedDelegationMaxConcurrent: 5,
  codexMultiAgentWorktreeChatsEnabled: false,
  codexMultiAgentStandaloneChatsEnabled: false,
  codexMaxConcurrentSubagents: null,
  codexMultiAgentPipelinesEnabled: false,
  deferredToolsWorktreeChatsEnabled: true,
  deferredToolsStandaloneChatsEnabled: true,
  deferredToolsAppAdvisorEnabled: true,
  deferredToolsPipelineAssistantEnabled: true,
  auditRetentionDays: 7,
  automationRunRetentionDays: 90,
  aiCreditsRoutingMode: 'off' as const,
  lastOpenApp: '',
  disabledOpenApps: [] as string[],
  lastSelectedWorktreeProjectId: '',
  lastSelectedWorktreeId: '',
  executionDetailViewMode: 'list' as const,
  worktreeViewMode: 'list' as const,
  worktreeFilterHiddenWorkspaceIds: [] as string[],
  theme: 'default' as const,
  colorMode: 'system' as const,
  sidebarAppearance: 'translucent' as const,
  worktreeDiffStatsStyle: 'short' as const,
  scrollbarBehavior: 'system' as const,
  singleDollarMath: true,
  linearChatEnrichmentMode: 'replace' as const,
  githubChatEnrichmentMode: 'hover' as const,
  uiScale: 100,
  windowBounds: null,
  windowMaximized: false,
  windowFullScreen: false,
  ollamaServerPort: 11534,
  ollamaConnectionMode: 'managed',
  ollamaExecutablePath: '',
  mcpProxyPort: 37645,
  hideAnthropicNav: DEFAULT_HIDE_ANTHROPIC_NAV,
  lastActiveContext: null,
  fileAutoSave: false,
  inAppBrowserLocalServersOnly: false,
  openAppLinksInBuiltInBrowser: true,
  useAsSystemDefaultBrowser: false,
  inAppNotifications: {
    enabled: true,
    categories: {
      chat: true,
      script: true,
      hook: true,
      gitCommit: true,
      gitPush: true,
      prCreate: true,
      pipeline: true,
      terminal: true,
      runComment: true,
      activation: true,
    },
  },
  terminalDrawerCollapsed: true,
  terminalDrawerHeight: 300,
  terminalDrawerActiveTabId: 'terminal',
  disabledTerminalShellProfileIds: [],
  terminalPresets: [],
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
      runComment: true,
      activation: true,
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
      runComment: 'Default',
      activation: 'Default',
    },
  },
  voiceDictationEnabled: true,
  closeToTray: true,
  globalFocusShortcutEnabled: false,
  globalFocusShortcut: 'CommandOrControl+Shift+O',
  activationQuietHours: { enabled: true, startHour: 22, endHour: 8 },
  promotionalNotifications: {
    enabled: true,
    arbitrary: true,
  },
  mcpHttpAuthDefaultHandler: 'canopy' as const,
  fileIndexing: {
    disabledBuiltinGlobIds: [],
    customGlobs: [],
  },
  planDetection: {
    disabledBuiltinRuleIds: [],
    customRules: [],
  },
  fileLabels: [],
  changedFilesHiddenLabelIds: [],
  autoDownloadUpdates: true,
  showDiagnosticsPill: true,
  onboardingCompleted: [] as string[],
  planModeHint: { version: 1, generation: 0 },
  releaseHighlightsLastSeenVersion: null,
  guestSessionCount: 0,
  guestUpgradeNudgeLastShownSessionCount: 0,
  telemetrySharing: {
    transcripts: 'off' as const,
    plans: 'off' as const,
    metadata: 'off' as const,
    summaries: 'off' as const,
  },
  personalWorkspaceCatalogSync: 'off',
  personalCatalogOfferSeen: false,
  personalCatalogNotice: null,
  telemetrySharingPromptSeen: false,
  gitExecutablePath: '',
};

function getDefaultOsNotifications(): NonNullable<
  PreferencesData['osNotifications']
> {
  const defaults = NEW_DEFAULTS.osNotifications;
  if (!defaults) throw new Error('Expected OS notification defaults');
  return defaults;
}

import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { BrowserWindow, nativeTheme, shell } from 'electron';
import { registerIpcHandler } from '../ipc/register';
import {
  registerPreferenceHandlers,
  resetCodeGraphReconciliationRetryForTests,
} from '../ipc/preferences';
import {
  getAppAdvisorProjectAgentAccessSnapshot,
  resetAppAdvisorProjectAgentAccessForTests,
} from '../lib/app-advisor-project-agent-access';
import { sendToWindow } from '../lib/window-send';
import {
  isRemoteControlEnabled,
  setRemoteControlEnabled,
} from '../lib/remote-control-preference';
import { setRendererCodeCacheSchemeStatusSource } from '../renderer-origin/renderer-code-cache-scheme-status';
import { recordOnboardingProfileTelemetry } from '../lib/desktop-telemetry';
import {
  DEFAULT_PREFERENCES,
  flushPreferencesWrites,
  getOpenCodeEnabledRevision,
  invalidateRendererPreferencesCache,
  invalidateRendererRuntimePreferencesCache,
  normalizePreferences,
  readLatestPreferencesFile,
  readLocalMemoryEnabledPreference,
  readPreferencesFile,
  readPreferencesFileDetailed,
  resetPreferencesLoadErrorForTests,
  updatePreferencesFile,
} from '../lib/preferences-store';
import {
  beginApprovalDefaultIntent,
  isApprovalDefaultIntentCurrent,
  waitForPendingApprovalDefaultWrites,
} from '../lib/approval-mode-resolution';

const mockedReadFile = jest.mocked(readFile);
const mockedWriteFile = jest.mocked(writeFile);
const mockedWriteFileAtomically = jest.mocked(writeFileAtomically);
const mockedRename = jest.mocked(rename);
const mockedMkdir = jest.mocked(mkdir);
const mockedStat = jest.mocked(stat);
const mockedUnlink = jest.mocked(unlink);
const mockedOpenPath = jest.spyOn(shell, 'openPath');
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedRecordOnboardingProfileTelemetry = jest.mocked(
  recordOnboardingProfileTelemetry,
);

// The shared writer's own install and flush are covered in desktop-shared;
// this suite observes what preferences writes through the mocked fs. The
// generation record (CAN-5154) is covered by the real-file recovery suites,
// so it stays out of these write counts.
let installCount = 0;
async function installThroughMockedFs(
  path: string,
  data: string | Uint8Array,
  options?: AtomicFileModule.AtomicFileWriteOptions,
): Promise<void> {
  if (basename(path) === 'preferences.generation.json') return;
  installCount += 1;
  const temp = join(dirname(path), `.${basename(path)}.${installCount}.tmp`);
  await writeFile(temp, data, {
    encoding: options?.encoding,
    mode: options?.mode,
  });
  await renameWithRetry(temp, path);
}
// Derived files are joined onto the mocked primary's folder.
const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PREFERENCES_WRITE = {
  encoding: 'utf8',
  durable: true,
  admittedWriter: {
    namespace: 'preferences',
    writer: 'electron_main',
    module: 'main/lib/preferences-store',
  },
};

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
let loadHandler: HandlerFn;
let acknowledgeLoadErrorHandler: HandlerFn;
let createPrimaryDataDirHandler: HandlerFn;
let openMemoryDirHandler: HandlerFn;
let importClaudeMemoryHandler: HandlerFn;
let saveHandler: HandlerFn;
let setPipelineDisabledHandler: HandlerFn;
let setApprovalDefaultHandler: HandlerFn;

// Last-good refreshes outlive a save; keep them out of the next test's mocks.
afterEach(() => flushPreferencesWrites());

beforeEach(() => {
  globalWithOllamaFlag.__CANOPY_OLLAMA_ENABLED__ = true;
  initializeTestModelRegistries();
  jest.clearAllMocks();
  mockedWriteFileAtomically.mockImplementation(installThroughMockedFs);
  setRetentionDaysMock.mockReset();
  updateCodexSessionIdleTimeoutMinutesMock.mockReset();
  updateClaudeSessionIdleTimeoutMinutesMock.mockReset();
  updateCodexRuntimeIdleTimeoutMinutesMock.mockReset();
  markCodexSessionsForNextTurnRecreationMock.mockReset();
  syncOnboardingProfilePreferencesMock.mockReset().mockResolvedValue();
  syncGlobalFocusShortcutFromPreferencesMock
    .mockReset()
    .mockResolvedValue(undefined);
  applyDefaultBrowserRegistrationMock.mockReset().mockResolvedValue({
    enabled: false,
    registered: false,
    platform: 'darwin',
  });
  wakeLockSetEnabledMock.mockReset();
  proxyIsRunningMock.mockReset();
  proxyIsRunningMock.mockReturnValue(false);
  proxyUpdatePortMock.mockReset();
  proxyUpdatePortMock.mockResolvedValue(undefined);
  proxyAssertPortAvailableMock.mockReset();
  proxyAssertPortAvailableMock.mockResolvedValue(undefined);
  cachedCodeGraphPreferences = {
    mode: 'enabled',
    selectedWorkspaceIds: [],
    generationTimeoutMinutes: 30,
  };
  reconcileCodeGraphAvailabilityMock.mockReset();
  reconcileCodeGraphAvailabilityMock.mockResolvedValue(undefined);
  mockGetPrimaryBrandDataDir.mockReset();
  mockGetPrimaryBrandDataDir.mockReturnValue(mockPrimaryDataDir);
  mockGetResolvedCanopyDataDir.mockReset();
  mockGetResolvedCanopyDataDir.mockReturnValue({
    path: mockFallbackDataDir,
    source: 'fallback',
    allCandidates: [mockPrimaryDataDir, mockFallbackDataDir],
  });
  mockResetResolvedCanopyDataDirCache.mockReset();
  resetPreferencesLoadErrorForTests();
  resetCodeGraphReconciliationRetryForTests();
  resetAppAdvisorProjectAgentAccessForTests();
  nativeTheme.themeSource = 'system';
  const statError = new Error('ENOENT');
  Object.defineProperty(statError, 'code', { value: 'ENOENT' });
  mockedStat.mockRejectedValue(statError);
  mockedUnlink.mockResolvedValue(undefined);
  mockedOpenPath.mockResolvedValue('');
  enqueueManualLocalMemoryImportBatchMock.mockResolvedValue({
    disabled: false,
    staged: 1,
    skipped: 0,
    deferred: 0,
    errors: [],
  });

  registerPreferenceHandlers();

  loadHandler = findRegisteredHandler('preferences:load');
  acknowledgeLoadErrorHandler = findRegisteredHandler(
    'preferences:acknowledge-load-error',
  );
  createPrimaryDataDirHandler = findRegisteredHandler(
    'preferences:create-primary-data-dir',
  );
  openMemoryDirHandler = findRegisteredHandler('preferences:open-memory-dir');
  importClaudeMemoryHandler = findRegisteredHandler(
    'preferences:import-claude-memory',
  );
  saveHandler = findRegisteredHandler('preferences:save');
  setPipelineDisabledHandler = findRegisteredHandler(
    'preferences:set-pipeline-disabled',
  );
  setApprovalDefaultHandler = findRegisteredHandler(
    'preferences:set-approval-default',
  );
});

afterAll(() => {
  globalWithOllamaFlag.__CANOPY_OLLAMA_ENABLED__ = originalOllamaEnabled;
});

function findRegisteredHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  const handler = call?.[1];
  if (typeof handler !== 'function') {
    throw new Error(`Expected registered handler for ${channel}`);
  }
  return (...args: unknown[]): Promise<unknown> => {
    const result: unknown = Reflect.apply(handler, undefined, args);
    return Promise.resolve(result);
  };
}

function createMockStats(mode: number): Stats {
  const stats = statSync(__filename);
  stats.mode = mode;
  return stats;
}

function makePrefsFile(
  preferences: Partial<PreferencesData>,
  version: number = 1,
): string {
  return JSON.stringify({ version, preferences });
}

function makeRawPrefsFile(
  preferences: Record<string, unknown>,
  version: number = 1,
): string {
  return JSON.stringify({ version, preferences });
}

function isPreferencesData(value: unknown): value is PreferencesData {
  return (
    value !== null &&
    typeof value === 'object' &&
    'codexMultiAgentWorktreeChatsEnabled' in value &&
    'codexMultiAgentStandaloneChatsEnabled' in value &&
    'codexMultiAgentPipelinesEnabled' in value
  );
}

function expectPreferencesData(value: unknown): PreferencesData {
  if (isPreferencesData(value)) {
    return value;
  }

  throw new Error('Expected preferences data');
}

function findAtomicWriteContentByFinalPath(pattern: RegExp): string | null {
  const renameCall = mockedRename.mock.calls.find(([, finalPath]) => {
    return typeof finalPath === 'string' && pattern.test(finalPath);
  });
  const tempPath = renameCall?.[0];
  if (typeof tempPath !== 'string') {
    return null;
  }

  const writeCall = mockedWriteFile.mock.calls.find(([writePath]) => {
    return writePath === tempPath;
  });
  const content = writeCall?.[1];
  return typeof content === 'string' ? content : null;
}

function findPreferencesWriteContent(): string | null {
  return findAtomicWriteContentByFinalPath(
    /^\/mock\/userData\/preferences\.json$/,
  );
}

function findBackupWriteContent(): string | null {
  return findAtomicWriteContentByFinalPath(
    /^\/mock\/userData\/preferences\.backup-.+\.json$/,
  );
}

function findLastGoodWriteContent(): string | null {
  return findAtomicWriteContentByFinalPath(
    /^\/mock\/userData\/preferences\.last-good\.json$/,
  );
}

function createEnoentError(): Error {
  const error = new Error('ENOENT');
  Object.defineProperty(error, 'code', { value: 'ENOENT' });
  return error;
}

function readFileMockPath(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof URL) {
    return value.pathname;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return '';
}

describe('normalizePreferences', () => {
  describe('release highlights history', () => {
    it('defaults missing history to null', () => {
      expect(normalizePreferences({})).toHaveProperty(
        'releaseHighlightsLastSeenVersion',
        null,
      );
    });

    it.each(['  v1.9.0-rc.2  ', 'internal-123', 'corrupt'])(
      'trims but preserves semantic values %p',
      (value) => {
        expect(
          normalizePreferences(
            Object.assign(normalizePreferences({}), {
              releaseHighlightsLastSeenVersion: value,
            }),
          ),
        ).toHaveProperty('releaseHighlightsLastSeenVersion', value.trim());
      },
    );

    it.each([null, undefined, '', '  ', 123, false, {}, []])(
      'normalizes invalid storage values %p to null',
      (value) => {
        expect(
          normalizePreferences(
            Object.assign(normalizePreferences({}), {
              releaseHighlightsLastSeenVersion: value,
            }),
          ),
        ).toHaveProperty('releaseHighlightsLastSeenVersion', null);
      },
    );
  });

  it('defaults handoffs independently of saved title and activity models', () => {
    expect(
      normalizePreferences({
        summaryModel: 'sonnet',
        summaryModelSetByUser: true,
        worktreeSummaryModel: 'sonnet',
      }),
    ).toMatchObject({
      handoffSummaryModel: 'haiku',
      handoffSummaryThinkingLevel: 'off',
      summaryModel: 'sonnet',
      worktreeSummaryModel: 'sonnet',
    });
  });

  it('opens app links in the built-in browser unless a choice says otherwise', () => {
    expect(normalizePreferences({}).openAppLinksInBuiltInBrowser).toBe(true);
    expect(
      normalizePreferences({ openAppLinksInBuiltInBrowser: false })
        .openAppLinksInBuiltInBrowser,
    ).toBe(false);
  });

  it('clamps handoff thinking to the selected model without changing other helpers', () => {
    const result = normalizePreferences({
      handoffSummaryModel: DEFAULT_CODEX_MODEL,
      handoffSummaryThinkingLevel: 'ultra',
      summaryThinkingLevel: 'high',
    });
    expect(result.handoffSummaryThinkingLevel).toBe('xhigh');
    expect(result.summaryThinkingLevel).toBe('high');
  });

  it('retains an unavailable handoff choice instead of replacing its provider', () => {
    expect(
      normalizePreferences({
        handoffSummaryModel: 'ollama-offline-model',
        handoffSummaryThinkingLevel: 'high',
      }),
    ).toMatchObject({
      handoffSummaryModel: 'ollama-offline-model',
      handoffSummaryThinkingLevel: 'high',
    });
  });

  describe('mergeQueueAgentHandling', () => {
    it('defaults to starting a chat when the project hook is absent', () => {
      expect(normalizePreferences({}).mergeQueueAgentHandling).toBe(
        'when_hook_absent',
      );
    });

    it.each(['always', 'when_hook_absent', 'never'] as const)(
      'keeps a saved %s choice',
      (mergeQueueAgentHandling) => {
        expect(
          normalizePreferences({ mergeQueueAgentHandling })
            .mergeQueueAgentHandling,
        ).toBe(mergeQueueAgentHandling);
      },
    );

    it('replaces an unknown value with the default', () => {
      expect(
        normalizePreferences({
          mergeQueueAgentHandling: 'sometimes',
        }).mergeQueueAgentHandling,
      ).toBe('when_hook_absent');
    });
  });

  describe('provider-aware model defaults', () => {
    function withoutCodexDefaults(run: () => void): void {
      initCodexModels([
        { id: 'codex-unrelated-test-model', label: 'Unrelated Codex model' },
      ]);
      try {
        run();
      } finally {
        initializeTestModelRegistries();
      }
    }

    it('defaults to the Codex models when Codex offers them', () => {
      const result = normalizePreferences({});
      expect(result.localMemoryModel).toBe('gpt-6.1-sol');
      expect(result.localMemoryModelSetByUser).toBe(false);
      expect(result.localMemoryThinkingLevel).toBe('high');
      expect(result.summaryModel).toBe('gpt-6-luna');
      expect(result.summaryThinkingLevel).toBe('off');
      expect(DEFAULT_PREFERENCES.localMemoryThinkingLevel).toBe('high');
    });

    it('defaults to Claude models when the Codex models are not available', () => {
      withoutCodexDefaults(() => {
        const result = normalizePreferences({});
        expect(result.localMemoryModel).toBe('opus[1m]');
        expect(result.summaryModel).toBe('sonnet');
      });
    });

    it('moves profiles that never chose a chat description model to the new default', () => {
      expect(
        normalizePreferences({
          summaryModel: 'claude-haiku-4-5-20251001',
          summaryModelSetByUser: false,
        }),
      ).toMatchObject({
        summaryModel: 'gpt-6-luna',
        summaryModelSetByUser: false,
      });
      withoutCodexDefaults(() => {
        expect(
          normalizePreferences({
            summaryModel: 'claude-haiku-4-5-20251001',
            summaryModelSetByUser: false,
          }).summaryModel,
        ).toBe('sonnet');
      });
    });

    it('keeps a model the user chose', () => {
      expect(
        normalizePreferences({
          summaryModel: 'claude-haiku-4-5-20251001',
          summaryModelSetByUser: true,
          localMemoryModel: 'sonnet',
          localMemoryModelSetByUser: true,
          localMemoryThinkingLevel: 'low',
        }),
      ).toMatchObject({
        summaryModel: 'claude-haiku-4-5-20251001',
        summaryModelSetByUser: true,
        localMemoryModel: 'sonnet',
        localMemoryModelSetByUser: true,
        localMemoryThinkingLevel: 'low',
      });
    });

    it('does not inherit the chat description model for local memory', () => {
      expect(
        normalizePreferences({
          summaryModel: 'sonnet',
          summaryModelSetByUser: true,
        }).localMemoryModel,
      ).toBe('gpt-6.1-sol');
    });

    it('keeps a chosen local memory model that is unavailable instead of switching providers', () => {
      // Memory runs refuse this model rather than send memory elsewhere, so
      // the choice must survive until the model is back or the user picks
      // another one.
      for (const localMemoryModel of [
        'ollama-offline-model',
        'retired-model',
      ]) {
        expect(
          normalizePreferences({
            localMemoryModel,
            localMemoryModelSetByUser: true,
            localMemoryThinkingLevel: 'extreme',
          }),
        ).toMatchObject({
          localMemoryModel,
          localMemoryModelSetByUser: true,
          localMemoryThinkingLevel: 'high',
        });
      }
      withoutCodexDefaults(() => {
        expect(
          normalizePreferences({
            localMemoryModel: 'ollama-offline-model',
            localMemoryModelSetByUser: true,
          }),
        ).toMatchObject({
          localMemoryModel: 'ollama-offline-model',
          localMemoryModelSetByUser: true,
        });
      });
    });

    it('still gives a local memory model nobody chose the provider-aware default', () => {
      expect(
        normalizePreferences({
          localMemoryModel: 'ollama-offline-model',
          localMemoryModelSetByUser: false,
        }),
      ).toMatchObject({
        localMemoryModel: 'gpt-6.1-sol',
        localMemoryModelSetByUser: false,
      });
      withoutCodexDefaults(() => {
        expect(
          normalizePreferences({ localMemoryModel: 'ollama-offline-model' }),
        ).toMatchObject({
          localMemoryModel: 'opus[1m]',
          localMemoryModelSetByUser: false,
        });
      });
    });

    it('falls back to the default for a chosen chat description model that is unavailable', () => {
      expect(
        normalizePreferences({
          summaryModel: 'ollama-offline-model',
          summaryModelSetByUser: true,
        }),
      ).toMatchObject({
        summaryModel: 'gpt-6-luna',
        summaryModelSetByUser: false,
      });
    });

    it('keeps a syntactically valid chosen model when validating persisted data', () => {
      expect(
        normalizePreferences(
          { localMemoryModel: 'future-model', localMemoryModelSetByUser: true },
          'persisted',
        ).localMemoryModel,
      ).toBe('future-model');
    });
  });

  describe('Claude turn limit', () => {
    it('defaults missing and invalid values to 500', () => {
      for (const value of [
        undefined,
        0,
        -1,
        10000,
        1.5,
        '200',
        NaN,
        Infinity,
      ]) {
        expect(
          normalizePreferences({ claudeMaxTurns: value }).claudeMaxTurns,
        ).toBe(500);
      }
    });

    it('preserves every supported boundary and an explicit disabled limit', () => {
      for (const value of [null, 1, 200, 500, 9999]) {
        expect(
          normalizePreferences({ claudeMaxTurns: value }).claudeMaxTurns,
        ).toBe(value);
      }
    });
  });

  it('marks fresh preferences as eligible for curated defaults', () => {
    expect(DEFAULT_PREFERENCES.initializedCuratedPluginDefaults).toEqual([]);
  });

  it('round-trips curated default initialization without inventing a migration marker', () => {
    expect(
      normalizePreferences({}).initializedCuratedPluginDefaults,
    ).toBeUndefined();
    expect(
      normalizePreferences({
        initializedCuratedPluginDefaults: [
          'web-research',
          'web-research',
          'short-answers',
        ],
      }).initializedCuratedPluginDefaults,
    ).toEqual(['web-research', 'short-answers']);
  });

  describe('promotionalNotifications', () => {
    it('defaults every toggle on for a fresh install', () => {
      expect(normalizePreferences({}).promotionalNotifications).toEqual({
        enabled: true,
        arbitrary: true,
      });
    });

    it('carries a pre-CAN-3013 activation opt-out into both children', () => {
      // A preferences file written before the hierarchy existed: the user
      // had switched the flat "Getting Started" category off. Upgrading must
      // not re-enroll them.
      const legacy: Record<string, unknown> = {
        osNotifications: { categories: { activation: false } },
      };
      expect(normalizePreferences(legacy).promotionalNotifications).toEqual({
        enabled: true,
        arbitrary: false,
      });
    });

    it('prefers a saved hierarchy over the legacy category', () => {
      const saved: Record<string, unknown> = {
        osNotifications: { categories: { activation: false } },
        promotionalNotifications: {
          enabled: false,
          arbitrary: true,
        },
      };
      expect(normalizePreferences(saved).promotionalNotifications).toEqual({
        enabled: false,
        arbitrary: true,
      });
    });
  });

  describe('chatWidth', () => {
    it('preserves full width and defaults missing or invalid values', () => {
      expect(normalizePreferences({ chatWidth: 'full' }).chatWidth).toBe(
        'full',
      );
      expect(
        normalizePreferences({ chatWidth: 'default' }).chatWidth,
      ).toBeUndefined();
      expect(
        normalizePreferences({ chatWidth: 'invalid' }).chatWidth,
      ).toBeUndefined();
      expect(normalizePreferences({}).chatWidth).toBeUndefined();
    });
  });

  describe('workspaceDefaultLayoutMode', () => {
    it('defaults missing and invalid values to advanced', () => {
      expect(normalizePreferences({}).workspaceDefaultLayoutMode).toBe(
        'advanced',
      );
      const invalid: Record<string, unknown> = {
        workspaceDefaultLayoutMode: 'unsupported',
      };
      expect(normalizePreferences(invalid).workspaceDefaultLayoutMode).toBe(
        'advanced',
      );
    });

    it.each(['minimal', 'advanced'] as const)(
      'preserves the valid %s value',
      (workspaceDefaultLayoutMode) => {
        expect(
          normalizePreferences({ workspaceDefaultLayoutMode })
            .workspaceDefaultLayoutMode,
        ).toBe(workspaceDefaultLayoutMode);
      },
    );
  });

  describe('uiScale', () => {
    it('defaults to 100 and drops non-numeric values', () => {
      expect(normalizePreferences({}).uiScale).toBe(100);
      const invalid: Record<string, unknown> = { uiScale: 'medium' };
      expect(normalizePreferences(invalid).uiScale).toBe(100);
      expect(normalizePreferences({ uiScale: Number.NaN }).uiScale).toBe(100);
    });

    it('clamps to the 50–200 zoom range and snaps to 5% steps', () => {
      expect(normalizePreferences({ uiScale: 10 }).uiScale).toBe(50);
      expect(normalizePreferences({ uiScale: 1000 }).uiScale).toBe(200);
      expect(normalizePreferences({ uiScale: 112 }).uiScale).toBe(110);
      expect(normalizePreferences({ uiScale: 150 }).uiScale).toBe(150);
      expect(normalizePreferences({ uiScale: 200 }).uiScale).toBe(200);
      expect(normalizePreferences({ uiScale: 300 }).uiScale).toBe(200);
      expect(normalizePreferences({ uiScale: 50 }).uiScale).toBe(50);
    });
  });

  describe('retired interface-scale shortcut preference', () => {
    it('is absent from fresh-profile defaults and normalization', () => {
      expect(DEFAULT_PREFERENCES).not.toHaveProperty(
        'interfaceScaleShortcutsEnabled',
      );
      expect(normalizePreferences({})).not.toHaveProperty(
        'interfaceScaleShortcutsEnabled',
      );
    });

    it.each([true, false])(
      'drops the legacy %s value while preserving interface scale',
      (enabled) => {
        const legacy: Record<string, unknown> = {
          interfaceScaleShortcutsEnabled: enabled,
          uiScale: 150,
        };
        const normalized = normalizePreferences(legacy);

        expect(normalized).not.toHaveProperty('interfaceScaleShortcutsEnabled');
        expect(normalized.uiScale).toBe(150);
      },
    );
  });

  describe('remoteControlEnabled', () => {
    it('defaults to on', () => {
      expect(normalizePreferences({}).remoteControlEnabled).toBe(true);
    });

    it('is off only after an explicit false', () => {
      expect(
        normalizePreferences({ remoteControlEnabled: false })
          .remoteControlEnabled,
      ).toBe(false);
      const invalid: Record<string, unknown> = { remoteControlEnabled: 'no' };
      expect(normalizePreferences(invalid).remoteControlEnabled).toBe(true);
    });
  });

  describe('ledgerAgentRecordingEnabled', () => {
    // "Agents add to the Feed" (LD09) ships on, so preferences written before
    // the setting existed must keep agents recording.
    it('defaults to on', () => {
      expect(normalizePreferences({}).ledgerAgentRecordingEnabled).toBe(true);
      expect(normalizePreferences(undefined).ledgerAgentRecordingEnabled).toBe(
        true,
      );
    });

    it('keeps an explicit boolean and treats anything else as on', () => {
      expect(
        normalizePreferences({ ledgerAgentRecordingEnabled: false })
          .ledgerAgentRecordingEnabled,
      ).toBe(false);
      expect(
        normalizePreferences({ ledgerAgentRecordingEnabled: true })
          .ledgerAgentRecordingEnabled,
      ).toBe(true);
      for (const value of ['false', 0, null, {}]) {
        const invalid: Record<string, unknown> = {
          ledgerAgentRecordingEnabled: value,
        };
        expect(normalizePreferences(invalid).ledgerAgentRecordingEnabled).toBe(
          true,
        );
      }
    });

    it('is part of the default preferences', () => {
      expect(DEFAULT_PREFERENCES.ledgerAgentRecordingEnabled).toBe(true);
    });
  });

  describe('repeatTaskAutomationSuggestionsEnabled', () => {
    it('defaults to on', () => {
      expect(DEFAULT_PREFERENCES.repeatTaskAutomationSuggestionsEnabled).toBe(
        true,
      );
      expect(
        normalizePreferences({}).repeatTaskAutomationSuggestionsEnabled,
      ).toBe(true);
    });

    it('keeps an explicit boolean and treats anything else as on', () => {
      expect(
        normalizePreferences({ repeatTaskAutomationSuggestionsEnabled: false })
          .repeatTaskAutomationSuggestionsEnabled,
      ).toBe(false);
      for (const value of ['false', 0, null, {}]) {
        const invalid: Record<string, unknown> = {
          repeatTaskAutomationSuggestionsEnabled: value,
        };
        expect(
          normalizePreferences(invalid).repeatTaskAutomationSuggestionsEnabled,
        ).toBe(true);
      }
    });
  });

  describe('skillSuggestionsEnabled', () => {
    it('defaults to on and keeps only an explicit boolean', () => {
      expect(DEFAULT_PREFERENCES.skillSuggestionsEnabled).toBe(true);
      expect(normalizePreferences({}).skillSuggestionsEnabled).toBe(true);
      expect(
        normalizePreferences({ skillSuggestionsEnabled: false })
          .skillSuggestionsEnabled,
      ).toBe(false);
      for (const value of ['false', 0, null, {}]) {
        const invalid: Record<string, unknown> = {
          skillSuggestionsEnabled: value,
        };
        expect(normalizePreferences(invalid).skillSuggestionsEnabled).toBe(
          true,
        );
      }
    });
  });

  it.each([true, false, 'true', null])(
    'drops the retired chat storage preference %p',
    (value) => {
      const legacy: Record<string, unknown> = {
        chatDeltaJournalEnabled: value,
      };
      expect(normalizePreferences(legacy)).not.toHaveProperty(
        'chatDeltaJournalEnabled',
      );
    },
  );

  describe('rendererCodeCacheSchemeEnabled', () => {
    it('defaults to off', () => {
      expect(normalizePreferences({}).rendererCodeCacheSchemeEnabled).toBe(
        false,
      );
    });

    it('is on only for an explicit true', () => {
      expect(
        normalizePreferences({ rendererCodeCacheSchemeEnabled: true })
          .rendererCodeCacheSchemeEnabled,
      ).toBe(true);
      for (const value of [false, 'true', 1, null, {}]) {
        const invalid: Record<string, unknown> = {
          rendererCodeCacheSchemeEnabled: value,
        };
        expect(
          normalizePreferences(invalid).rendererCodeCacheSchemeEnabled,
        ).toBe(false);
      }
    });
  });

  describe('chatDetail', () => {
    it('defaults to recent', () => {
      expect(normalizePreferences({}).chatDetail).toBe('recent');
      expect(normalizePreferences(undefined).chatDetail).toBe('recent');
      expect(DEFAULT_PREFERENCES.chatDetail).toBe('recent');
    });

    it('keeps a saved level and reads anything else as the default', () => {
      for (const level of ['detailed', 'recent', 'compact'] as const) {
        expect(normalizePreferences({ chatDetail: level }).chatDetail).toBe(
          level,
        );
      }
      for (const value of ['verbose', '', 1, null, {}]) {
        const invalid: Record<string, unknown> = { chatDetail: value };
        expect(normalizePreferences(invalid).chatDetail).toBe('recent');
      }
    });

    it('moves the retired switches over once', () => {
      const migrated = (legacy: Record<string, unknown>): unknown =>
        normalizePreferences(legacy).chatDetail;
      // "Show only recent steps" already folded every run.
      expect(migrated({ chatLiveStepWindowEnabled: true })).toBe('recent');
      expect(
        migrated({
          chatLiveStepWindowEnabled: true,
          chatGroupToolCallsEnabled: true,
        }),
      ).toBe('recent');
      expect(migrated({ chatGroupToolCallsEnabled: true })).toBe('compact');
      expect(
        migrated({
          chatLiveStepWindowEnabled: false,
          chatGroupToolCallsEnabled: false,
        }),
      ).toBe('recent');
      // A saved level wins over the old switches.
      expect(
        migrated({ chatDetail: 'detailed', chatGroupToolCallsEnabled: true }),
      ).toBe('detailed');
      // The old keys are not carried forward.
      const normalized: Record<string, unknown> = {
        ...normalizePreferences({ chatGroupToolCallsEnabled: true }),
      };
      expect(normalized).not.toHaveProperty('chatGroupToolCallsEnabled');
      expect(normalized).not.toHaveProperty('chatLiveStepWindowEnabled');
    });
  });

  describe('retired foreground-first delivery preference', () => {
    it.each([true, false, 'true', undefined])(
      'ignores stored legacy choice %p',
      (chatForegroundFirstDeliveryEnabled) => {
        expect(DEFAULT_PREFERENCES).not.toHaveProperty(
          'chatForegroundFirstDeliveryEnabled',
        );
        expect(
          normalizePreferences({ chatForegroundFirstDeliveryEnabled }),
        ).not.toHaveProperty('chatForegroundFirstDeliveryEnabled');
      },
    );
  });

  describe('retired experimentalFeaturesEnabled', () => {
    it.each([true, false, 'yes', undefined])(
      'ignores stored legacy choice %p',
      (experimentalFeaturesEnabled) => {
        expect(
          normalizePreferences({ experimentalFeaturesEnabled }),
        ).not.toHaveProperty('experimentalFeaturesEnabled');
      },
    );
  });

  describe('retired early-access layout picks', () => {
    it('drops the stored shared layout so no worktree is forced into one', () => {
      const normalized = normalizePreferences({
        experimentalFeaturesEnabled: true,
        sharedLayoutMode: 'minimal',
        earlyAccessLayoutMode: 'minimal',
      });
      expect('sharedLayoutMode' in normalized).toBe(false);
      expect('earlyAccessLayoutMode' in normalized).toBe(false);
    });
  });

  describe('globalInstructions', () => {
    it('defaults missing config to empty chats/pipelines sections', () => {
      expect(normalizePreferences({}).globalInstructions).toEqual({
        chats: { overall: '', scoped: [] },
        pipelines: { overall: '', scoped: [] },
      });
    });

    it('preserves valid scoped instructions and drops malformed entries', () => {
      const input: Record<string, unknown> = {
        globalInstructions: {
          chats: {
            overall: 'be terse',
            scoped: [
              {
                id: 'one',
                text: 'claude only',
                mode: 'replace',
                harnesses: ['claude', 'bogus'],
                models: ['claude-opus-5'],
                workspaceTypes: ['cowork', 'nope'],
              },
              { text: 'no id' },
            ],
          },
          pipelines: 'corrupt',
        },
      };
      expect(normalizePreferences(input).globalInstructions).toEqual({
        chats: {
          overall: 'be terse',
          scoped: [
            {
              id: 'one',
              text: 'claude only',
              mode: 'replace',
              harnesses: ['claude'],
              models: ['claude-opus-5'],
              workspaceTypes: ['cowork'],
            },
          ],
        },
        pipelines: { overall: '', scoped: [] },
      });
    });
  });

  it('passes through a non-empty mobile install cue snooze timestamp only', () => {
    expect(
      normalizePreferences({
        mobileInstallCueSnoozedUntil: '2026-08-19T12:00:00.000Z',
      }).mobileInstallCueSnoozedUntil,
    ).toBe('2026-08-19T12:00:00.000Z');
    expect(
      normalizePreferences({ mobileInstallCueSnoozedUntil: '   ' })
        .mobileInstallCueSnoozedUntil,
    ).toBeUndefined();
    expect(
      normalizePreferences({
        mobileInstallCueSnoozedUntil: 123 as unknown as string,
      }).mobileInstallCueSnoozedUntil,
    ).toBeUndefined();
  });

  it('drops the retired Home dismissal', () => {
    expect(
      normalizePreferences({
        homeOnboardingDismissedAt: '2026-08-24T12:00:00.000Z',
      }),
    ).not.toHaveProperty('homeOnboardingDismissedAt');
  });

  it('normalizes the multi-select profileRoles list', () => {
    expect(
      normalizePreferences({
        profileRoles: [
          'designer',
          'software-engineer',
          'designer',
          'not-a-role',
          42,
        ] as unknown as PreferencesData['profileRoles'],
      }).profileRoles,
    ).toEqual(['designer', 'software-engineer']);
    expect(normalizePreferences({}).profileRoles).toBeUndefined();
    expect(
      normalizePreferences({
        profileRoles: ['nope'] as unknown as PreferencesData['profileRoles'],
      }).profileRoles,
    ).toBeUndefined();
  });

  describe('legacy Home state retirement', () => {
    it.each([undefined, null, [], 'bad', { entries: null }, { entries: [] }])(
      'ignores malformed state: %p',
      (value) => {
        const preferences = normalizePreferences({
          homeOnboardingSuggestions: value,
          mobileInstallCueSnoozedUntil: '2026-10-28T00:00:00.000Z',
          profileRoles: ['designer'],
        });
        expect(preferences.homeOnboardingSuggestions).toBeUndefined();
        expect(preferences.profileRoles).toEqual(['designer']);
        expect(preferences.mobileInstallCueSnoozedUntil).toBe(
          '2026-10-28T00:00:00.000Z',
        );
      },
    );
    it('converts the earliest valid notification answer without a checklist cohort', () => {
      const preferences = normalizePreferences({
        homeOnboardingSuggestions: {
          entries: {
            notifications: {
              completedAt: '2026-10-20T00:00:00.000Z',
              dismissedAt: '2026-10-19T00:00:00.000Z',
            },
          },
        },
      });
      expect(preferences.osNotificationOfferAnsweredAt).toBe(
        '2026-10-19T00:00:00.000Z',
      );
      expect(preferences.homeOnboardingSuggestions).toBeUndefined();
    });
    it('keeps only #5222 migration inputs, even without startedAt', () => {
      const at = '2026-10-20T00:00:00.000Z';
      const preferences = normalizePreferences({
        homeOnboardingSuggestions: {
          entries: {
            'plan-mode': { completedAt: at },
            github: { completedAt: at },
            'plugin:x': { completedAt: at },
          },
        },
      });
      expect(preferences.homeOnboardingSuggestions?.entries).toEqual({
        'plan-mode': { completedAt: at },
      });
    });
  });

  describe('Code Graph preferences', () => {
    it('defaults missing fields to enabled with a 30-minute timeout', () => {
      expect(normalizePreferences({}).codeGraph).toEqual({
        mode: 'enabled',
        selectedWorkspaceIds: [],
        generationTimeoutMinutes: 30,
      });
    });

    it('normalizes modes and trims/deduplicates selected project IDs', () => {
      const selectedWorkspacesInput: Record<string, unknown> = {
        codeGraph: {
          mode: 'selected-workspaces',
          selectedWorkspaceIds: [' one ', '', 'two', 'one', 4],
          generationTimeoutMinutes: 45,
        },
      };
      expect(normalizePreferences(selectedWorkspacesInput).codeGraph).toEqual({
        mode: 'selected-workspaces',
        selectedWorkspaceIds: ['one', 'two'],
        generationTimeoutMinutes: 45,
      });
      const unknownModeInput: Record<string, unknown> = {
        codeGraph: {
          mode: 'unknown',
          selectedWorkspaceIds: [],
          generationTimeoutMinutes: 30,
        },
      };
      expect(normalizePreferences(unknownModeInput).codeGraph?.mode).toBe(
        'enabled',
      );
    });

    it.each([1, 1_440])('accepts timeout boundary %s', (value) => {
      expect(
        normalizePreferences({
          codeGraph: {
            mode: 'enabled',
            selectedWorkspaceIds: [],
            generationTimeoutMinutes: value,
          },
        }).codeGraph?.generationTimeoutMinutes,
      ).toBe(value);
    });

    it.each([
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      0,
      -1,
      1_441,
    ])('falls back to 30 for invalid timeout %s', (value) => {
      const input: Record<string, unknown> = {
        codeGraph: {
          mode: 'enabled',
          selectedWorkspaceIds: [],
          generationTimeoutMinutes: value,
        },
      };
      expect(
        normalizePreferences(input).codeGraph?.generationTimeoutMinutes,
      ).toBe(30);
    });
  });

  describe('App Advisor project agent access preferences', () => {
    it('defaults missing access preferences to enabled', () => {
      expect(normalizePreferences({}).appAdvisorProjectAgentAccess).toEqual({
        mode: 'enabled',
        selectedOwners: [],
      });
    });

    it('normalizes old preference files without writing an upgrade', async () => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          preferences: { sidebarCollapsed: true },
        }),
      );

      const preferences = await readPreferencesFile();

      expect(preferences.appAdvisorProjectAgentAccess).toEqual({
        mode: 'enabled',
        selectedOwners: [],
      });
      expect(mockedWriteFile).not.toHaveBeenCalled();
      expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    });

    it('preserves restrictive access preferences when recovering last-good data', async () => {
      mockedReadFile.mockImplementation((filePath) => {
        const path = readFileMockPath(filePath);
        if (path.endsWith('preferences.generation.json'))
          return Promise.reject(createEnoentError());
        if (path.endsWith('preferences.last-good.json')) {
          return Promise.resolve(
            makePrefsFile({
              appAdvisorProjectAgentAccess: {
                mode: 'disabled',
                selectedOwners: [],
              },
            }),
          );
        }
        return Promise.resolve('not valid json {{{');
      });
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const result = await loadHandler();

      expect(result).toMatchObject({
        __error: {
          restoredFromPath: '/mock/userData/preferences.last-good.json',
        },
        appAdvisorProjectAgentAccess: {
          mode: 'disabled',
          selectedOwners: [],
        },
      });
      const writtenPreferences = findPreferencesWriteContent();
      if (writtenPreferences === null) {
        throw new Error('Expected recovered preference write content.');
      }
      expect(JSON.parse(writtenPreferences)).toMatchObject({
        preferences: {
          appAdvisorProjectAgentAccess: {
            mode: 'disabled',
            selectedOwners: [],
          },
        },
      });
    });

    it('round-trips a saved value and updates the main-process policy cache', async () => {
      const access: AppAdvisorProjectAgentAccess = {
        mode: 'selected-owners',
        selectedOwners: [{ kind: 'organization', organizationId: 'org-7' }],
      };
      mockedReadFile.mockResolvedValue(makePrefsFile({}));
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const result = expectPreferencesData(
        await saveHandler({}, { appAdvisorProjectAgentAccess: access }),
      );

      expect(result.appAdvisorProjectAgentAccess).toEqual(access);
      expect(getAppAdvisorProjectAgentAccessSnapshot()).toEqual(access);
      const writtenPreferences = findPreferencesWriteContent();
      if (writtenPreferences === null) {
        throw new Error('Expected saved preference write content.');
      }
      expect(JSON.parse(writtenPreferences)).toMatchObject({
        preferences: { appAdvisorProjectAgentAccess: access },
      });
    });

    it('keeps the newest committed access when an older save finishes last', async () => {
      const enabled: AppAdvisorProjectAgentAccess = {
        mode: 'enabled',
        selectedOwners: [],
      };
      const disabled: AppAdvisorProjectAgentAccess = {
        mode: 'disabled',
        selectedOwners: [],
      };
      let persisted = makePrefsFile({});
      mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockImplementation((_filePath, data) => {
        if (typeof data === 'string') persisted = data;
        return Promise.resolve();
      });
      let releaseOlderProfileSync: (() => void) | undefined;
      let markOlderProfileSyncStarted: (() => void) | undefined;
      const olderProfileSyncStarted = new Promise<void>((resolve) => {
        markOlderProfileSyncStarted = resolve;
      });
      syncOnboardingProfilePreferencesMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseOlderProfileSync = resolve;
            markOlderProfileSyncStarted?.();
          }),
      );

      const olderSave = saveHandler(
        {},
        { appAdvisorProjectAgentAccess: enabled },
      );
      await olderProfileSyncStarted;
      await saveHandler({}, { appAdvisorProjectAgentAccess: disabled });
      expect(getAppAdvisorProjectAgentAccessSnapshot()).toEqual(disabled);

      releaseOlderProfileSync?.();
      await olderSave;

      expect(getAppAdvisorProjectAgentAccessSnapshot()).toEqual(disabled);
    });
  });

  it('defaults org memory injection on and accepts an explicit opt-out', () => {
    expect(normalizePreferences({}).orgMemoryInjectionEnabled).toBe(true);
    expect(
      normalizePreferences({
        orgMemoryInjectionEnabled: false,
      }),
    ).toMatchObject({ orgMemoryInjectionEnabled: false });
  });

  it('defaults local memory on and preserves explicit boolean preferences', () => {
    expect(normalizePreferences({}).localMemoryEnabled).toBe(true);
    expect(normalizePreferences({ localMemoryEnabled: true })).toMatchObject({
      localMemoryEnabled: true,
    });
    expect(normalizePreferences({ localMemoryEnabled: false })).toMatchObject({
      localMemoryEnabled: false,
    });
    expect(normalizePreferences({ localMemoryEnabled: 'true' })).toMatchObject({
      localMemoryEnabled: true,
    });
  });

  it.each([
    ['missing', {}, true],
    ['explicit false', { localMemoryEnabled: false }, false],
    ['explicit true', { localMemoryEnabled: true }, true],
  ] as const)(
    'resolves the %s local memory preference consistently across reads',
    async (_label, preferences, expected) => {
      mockedReadFile.mockResolvedValue(makePrefsFile(preferences));

      await expect(readLocalMemoryEnabledPreference()).resolves.toBe(expected);
      await expect(readLocalMemoryEnabledPreference()).resolves.toBe(expected);
    },
  );

  it('enables injection for existing installs with only legacy memory keys', () => {
    expect(
      normalizePreferences({
        orgMemoryEnabled: false,
        orgMemoryDevMode: false,
      }),
    ).toMatchObject({ orgMemoryInjectionEnabled: true });
  });

  it('defaults missing pipeline advisor preferences', () => {
    const preferences = normalizePreferences({});

    expect(preferences.pipelineAdvisorEnabled).toBe(true);
    expect(preferences.pipelineAdvisorModel).toBe(DEFAULT_CODEX_MODEL);
    expect(preferences.pipelineAdvisorThinkingLevel).toBe('high');
  });

  it('defaults defaultChatInterfaceMode to canopy', () => {
    expect(normalizePreferences({}).defaultChatInterfaceMode).toBe('canopy');
  });

  describe('lastActiveContext', () => {
    it('defaults to null when missing', () => {
      expect(normalizePreferences({}).lastActiveContext).toBeNull();
    });

    it('round-trips a valid worktree context', () => {
      const input: Record<string, unknown> = {
        lastActiveContext: {
          kind: 'worktree',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
        },
      };
      expect(normalizePreferences(input).lastActiveContext).toEqual({
        kind: 'worktree',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
      });
    });

    it('round-trips a valid cowork context', () => {
      const input: Record<string, unknown> = {
        lastActiveContext: { kind: 'cowork', workspaceId: 'cowork-1' },
      };
      expect(normalizePreferences(input).lastActiveContext).toEqual({
        kind: 'cowork',
        workspaceId: 'cowork-1',
      });
    });

    it('coerces an unknown kind to null', () => {
      const input: Record<string, unknown> = {
        lastActiveContext: { kind: 'bogus', workspaceId: 'workspace-1' },
      };
      expect(normalizePreferences(input).lastActiveContext).toBeNull();
    });

    it('coerces a worktree context missing worktreeId to null', () => {
      const input: Record<string, unknown> = {
        lastActiveContext: { kind: 'worktree', workspaceId: 'workspace-1' },
      };
      expect(normalizePreferences(input).lastActiveContext).toBeNull();
    });

    it('coerces non-string ids to null', () => {
      const input: Record<string, unknown> = {
        lastActiveContext: {
          kind: 'worktree',
          workspaceId: 1,
          worktreeId: 'worktree-1',
        },
      };
      expect(normalizePreferences(input).lastActiveContext).toBeNull();
    });

    it('coerces a non-object value to null', () => {
      const input: Record<string, unknown> = {
        lastActiveContext: 'worktree-1',
      };
      expect(normalizePreferences(input).lastActiveContext).toBeNull();
    });

    it('ignores a stale persisted defaultStartupPage field', () => {
      const input: Record<string, unknown> = {
        defaultStartupPage: 'worktrees',
      };
      const preferences = normalizePreferences(input);
      expect(Reflect.get(preferences, 'defaultStartupPage')).toBeUndefined();
      expect(preferences.lastActiveContext).toBeNull();
    });
  });

  it('defaults all Claude execution mode preferences to canopy', () => {
    expect(normalizePreferences({})).toMatchObject({
      defaultChatInterfaceMode: 'canopy',
      defaultStandaloneChatInterfaceMode: 'canopy',
      defaultAppAdvisorInterfaceMode: 'canopy',
      canopyBackgroundProcessesMode: 'canopy',
      pipelinesMode: 'canopy',
    });
  });

  it('defaults aiCreditsRoutingMode to off and validates the three-state set', () => {
    expect(normalizePreferences({}).aiCreditsRoutingMode).toBe('off');
    expect(
      normalizePreferences({ aiCreditsRoutingMode: 'on-quota' })
        .aiCreditsRoutingMode,
    ).toBe('on-quota');
    expect(
      normalizePreferences({ aiCreditsRoutingMode: 'on' }).aiCreditsRoutingMode,
    ).toBe('on');
    expect(
      normalizePreferences({ aiCreditsRoutingMode: 'always' })
        .aiCreditsRoutingMode,
    ).toBe('off');
    const bogusInput: Record<string, unknown> = {
      aiCreditsRoutingMode: 'bogus',
    };
    expect(normalizePreferences(bogusInput).aiCreditsRoutingMode).toBe('off');
  });

  it('leaves lastChatBillingFramework unset when absent or invalid, and passes valid values through', () => {
    // Absent must stay unset (never chosen), NOT defaulted.
    expect(normalizePreferences({}).lastChatBillingFramework).toBeUndefined();
    // Valid values pass through.
    expect(
      normalizePreferences({ lastChatBillingFramework: 'subscription' })
        .lastChatBillingFramework,
    ).toBe('subscription');
    expect(
      normalizePreferences({ lastChatBillingFramework: 'ai-credits' })
        .lastChatBillingFramework,
    ).toBe('ai-credits');
    // Invalid values normalize back to unset.
    const bogusFramework: Record<string, unknown> = {
      lastChatBillingFramework: 'bogus',
    };
    expect(
      normalizePreferences(bogusFramework).lastChatBillingFramework,
    ).toBeUndefined();
    const nonString: Record<string, unknown> = {
      lastChatBillingFramework: 42,
    };
    expect(
      normalizePreferences(nonString).lastChatBillingFramework,
    ).toBeUndefined();
  });

  it('normalizes Claude worker preferences', () => {
    expect(normalizePreferences({}).canopyBackgroundProcessesMode).toBe(
      'canopy',
    );
    expect(normalizePreferences({}).pipelinesMode).toBe('canopy');
    expect(normalizePreferences({}).workerConcurrencyLimit).toBe(5);

    const valid = normalizePreferences({
      canopyBackgroundProcessesMode: 'canopy',
      pipelinesMode: 'canopy',
      workerConcurrencyLimit: 99,
    });
    expect(valid.canopyBackgroundProcessesMode).toBe('canopy');
    expect(valid.pipelinesMode).toBe('canopy');
    expect(valid.workerConcurrencyLimit).toBe(16);

    const invalid = normalizePreferences({
      canopyBackgroundProcessesMode: 'bad' as unknown as 'terminal',
      pipelinesMode: 'bad' as unknown as 'terminal',
      workerConcurrencyLimit: 0,
    });
    expect(invalid.canopyBackgroundProcessesMode).toBe('canopy');
    expect(invalid.pipelinesMode).toBe('canopy');
    expect(invalid.workerConcurrencyLimit).toBe(1);
  });

  it('defaults defaultStandaloneChatInterfaceMode to canopy', () => {
    expect(normalizePreferences({}).defaultStandaloneChatInterfaceMode).toBe(
      'canopy',
    );
  });

  it('defaults defaultAppAdvisorInterfaceMode to canopy', () => {
    expect(normalizePreferences({}).defaultAppAdvisorInterfaceMode).toBe(
      'canopy',
    );
  });

  it('defaults preventClaudeNativeCaffeinate to true', () => {
    expect(normalizePreferences({}).preventClaudeNativeCaffeinate).toBe(true);
  });

  it('persists valid defaultChatInterfaceMode values', () => {
    expect(
      normalizePreferences({ defaultChatInterfaceMode: 'claude-code' })
        .defaultChatInterfaceMode,
    ).toBe('claude-code');
    expect(
      normalizePreferences({ defaultChatInterfaceMode: 'canopy' })
        .defaultChatInterfaceMode,
    ).toBe('canopy');
  });

  it('persists valid defaultStandaloneChatInterfaceMode values', () => {
    expect(
      normalizePreferences({
        defaultStandaloneChatInterfaceMode: 'claude-code',
      }).defaultStandaloneChatInterfaceMode,
    ).toBe('claude-code');
    expect(
      normalizePreferences({ defaultStandaloneChatInterfaceMode: 'canopy' })
        .defaultStandaloneChatInterfaceMode,
    ).toBe('canopy');
  });

  it('persists valid defaultAppAdvisorInterfaceMode values', () => {
    expect(
      normalizePreferences({
        defaultAppAdvisorInterfaceMode: 'claude-code',
      }).defaultAppAdvisorInterfaceMode,
    ).toBe('claude-code');
    expect(
      normalizePreferences({ defaultAppAdvisorInterfaceMode: 'canopy' })
        .defaultAppAdvisorInterfaceMode,
    ).toBe('canopy');
  });

  it('persists valid preventClaudeNativeCaffeinate values', () => {
    expect(
      normalizePreferences({
        preventClaudeNativeCaffeinate: false,
      }).preventClaudeNativeCaffeinate,
    ).toBe(false);
    expect(
      normalizePreferences({
        preventClaudeNativeCaffeinate: true,
      }).preventClaudeNativeCaffeinate,
    ).toBe(true);
  });

  it('defaults sidebarWidth to 280, clear of the 220 minimum', () => {
    // The default used to be pinned to the minimum, so every new install
    // opened at the narrowest width the app allows.
    expect(normalizePreferences({}).sidebarWidth).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(DEFAULT_SIDEBAR_WIDTH).toBe(280);
    expect(DEFAULT_SIDEBAR_WIDTH).toBeGreaterThan(SIDEBAR_MIN_WIDTH);
  });

  it('leaves an existing install on its persisted width, including the old 220 default', () => {
    // Raising the default must not resize anyone who already has a width.
    // 220 is still a legal value, so it has to survive normalization rather
    // than be mistaken for "unset" and replaced by the new default.
    expect(normalizePreferences({ sidebarWidth: 220 }).sidebarWidth).toBe(220);
    expect(normalizePreferences({ sidebarWidth: 300 }).sidebarWidth).toBe(300);
  });

  it('preserves an existing valid sidebarWidth of 280', () => {
    expect(normalizePreferences({ sidebarWidth: 280 }).sidebarWidth).toBe(280);
  });

  it('clamps sidebarWidth below the minimum up to 220', () => {
    expect(normalizePreferences({ sidebarWidth: 100 }).sidebarWidth).toBe(
      SIDEBAR_MIN_WIDTH,
    );
  });

  it('clamps sidebarWidth above the maximum down to 480', () => {
    expect(normalizePreferences({ sidebarWidth: 900 }).sidebarWidth).toBe(
      SIDEBAR_MAX_WIDTH,
    );
  });

  it('defaults sidebarWidth to 280 for non-numeric values', () => {
    const input: Record<string, unknown> = { sidebarWidth: 'wide' };

    expect(normalizePreferences(input).sidebarWidth).toBe(
      DEFAULT_SIDEBAR_WIDTH,
    );
  });

  it('defaults sidebarCodeSectionCollapsed to false and coerces non-boolean values', () => {
    expect(normalizePreferences({}).sidebarCodeSectionCollapsed).toBe(false);
    expect(
      normalizePreferences({ sidebarCodeSectionCollapsed: true })
        .sidebarCodeSectionCollapsed,
    ).toBe(true);
    const input: Record<string, unknown> = {
      sidebarCodeSectionCollapsed: 'yes',
    };

    expect(normalizePreferences(input).sidebarCodeSectionCollapsed).toBe(false);
  });

  it('defaults sidebarCoworkSectionCollapsed to false and coerces non-boolean values', () => {
    expect(normalizePreferences({}).sidebarCoworkSectionCollapsed).toBe(false);
    expect(
      normalizePreferences({ sidebarCoworkSectionCollapsed: true })
        .sidebarCoworkSectionCollapsed,
    ).toBe(true);
    expect(
      normalizePreferences({ sidebarCoworkSectionCollapsed: 'yes' })
        .sidebarCoworkSectionCollapsed,
    ).toBe(false);
  });

  it('rejects unknown defaultChatInterfaceMode values', () => {
    expect(
      normalizePreferences({
        defaultChatInterfaceMode: 'not-a-mode' as unknown as 'canopy',
      }).defaultChatInterfaceMode,
    ).toBe('canopy');
  });

  it('rejects unknown defaultStandaloneChatInterfaceMode values', () => {
    expect(
      normalizePreferences({
        defaultStandaloneChatInterfaceMode: 'not-a-mode' as unknown as 'canopy',
      }).defaultStandaloneChatInterfaceMode,
    ).toBe('canopy');
  });

  it('rejects unknown defaultAppAdvisorInterfaceMode values', () => {
    expect(
      normalizePreferences({
        defaultAppAdvisorInterfaceMode: 'not-a-mode' as unknown as 'canopy',
      }).defaultAppAdvisorInterfaceMode,
    ).toBe('canopy');
  });

  it('rejects non-boolean preventClaudeNativeCaffeinate values', () => {
    expect(
      normalizePreferences({
        preventClaudeNativeCaffeinate: 'no' as unknown as boolean,
      }).preventClaudeNativeCaffeinate,
    ).toBe(true);
  });

  it('accepts an executable Ollama pipeline advisor model and rejects invalid thinking', () => {
    const preferences = normalizePreferences({
      pipelineAdvisorModel: 'ollama-qwen3-coder',
      pipelineAdvisorThinkingLevel: 'not-valid',
    });

    expect(preferences.pipelineAdvisorModel).toBe('ollama-qwen3-coder');
    expect(preferences.pipelineAdvisorThinkingLevel).toBe('high');
  });

  it('persists valid Claude and Codex pipeline advisor preferences', () => {
    expect(
      normalizePreferences({
        pipelineAdvisorEnabled: false,
      }).pipelineAdvisorEnabled,
    ).toBe(false);
    expect(
      normalizePreferences({
        pipelineAdvisorModel: 'opus[1m]',
        pipelineAdvisorThinkingLevel: 'max',
      }).pipelineAdvisorModel,
    ).toBe('opus[1m]');
    expect(
      normalizePreferences({
        pipelineAdvisorModel: 'gpt-6-sol',
        pipelineAdvisorThinkingLevel: 'xhigh',
      }),
    ).toMatchObject({
      pipelineAdvisorModel: DEFAULT_CODEX_MODEL,
      pipelineAdvisorThinkingLevel: 'xhigh',
    });
  });

  it('keeps a Cursor App Advisor default and still rejects Cursor for the other advisor runtimes', () => {
    initCursorModels([
      {
        id: 'cursor-default',
        rawModelId: 'default[]',
        label: 'Cursor default',
      },
    ]);
    try {
      const preferences = normalizePreferences({
        appAdvisorModel: 'cursor-default',
        pipelineAdvisorModel: 'cursor-default',
        cronGenerationModel: 'cursor-default',
      });
      expect(preferences.appAdvisorModel).toBe('cursor-default');
      expect(preferences.pipelineAdvisorModel).not.toBe('cursor-default');
      expect(preferences.cronGenerationModel).not.toBe('cursor-default');
    } finally {
      initCursorModels([]);
    }
  });

  it('defaults missing App Advisor preferences', () => {
    const preferences = normalizePreferences({});

    expect(preferences.appAdvisorModel).toBe(DEFAULT_CODEX_MODEL);
    expect(preferences.appAdvisorThinkingLevel).toBe('high');
    expect(preferences.appAdvisorPluginSelections).toEqual({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    });
    expect(preferences.appAdvisorDialogBounds).toBeNull();
    expect(preferences.codexMultiAgentAppAdvisorEnabled).toBe(true);
  });

  it('normalizes invalid App Advisor model and thinking preferences', () => {
    const preferences = normalizePreferences({
      appAdvisorModel: 'unknown-model',
      appAdvisorThinkingLevel: 'not-valid',
    });

    expect(preferences.appAdvisorModel).toBe(DEFAULT_CODEX_MODEL);
    expect(preferences.appAdvisorThinkingLevel).toBe('high');
  });

  it('normalizes App Advisor plugin selections', () => {
    const preferences = normalizePreferences({
      appAdvisorPluginSelections: {
        collectionIds: ['bundle-a', 42, 'bundle-b'],
        skillRefs: [
          { sourceId: 'builtin', skillName: 'skill-a' },
          { sourceId: 'missing-name' },
        ],
        pluginRefs: [
          { marketplaceId: 'market', pluginName: 'plugin-a' },
          { marketplaceId: 42, pluginName: 'bad' },
        ],
        mcpServerRefs: [
          { serverId: 'server', configId: 'config-a' },
          { serverId: 'missing-config' },
        ],
      },
    });

    expect(preferences.appAdvisorPluginSelections).toEqual({
      collectionIds: ['bundle-a', 'bundle-b'],
      skillRefs: [{ sourceId: 'builtin', skillName: 'skill-a' }],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin-a' }],
      mcpServerRefs: [{ serverId: 'server', configId: 'config-a' }],
    });
  });

  it('normalizes App Advisor dialog bounds and multi-agent preference', () => {
    expect(
      normalizePreferences({
        appAdvisorDialogBounds: { x: 10, y: 20, width: 460, height: 620 },
        codexMultiAgentAppAdvisorEnabled: true,
      }),
    ).toMatchObject({
      appAdvisorDialogBounds: { x: 10, y: 20, width: 460, height: 620 },
      codexMultiAgentAppAdvisorEnabled: true,
    });

    expect(
      normalizePreferences({
        appAdvisorDialogBounds: { x: 10, y: 20, width: 359, height: 620 },
        codexMultiAgentAppAdvisorEnabled: 'yes',
      }).appAdvisorDialogBounds,
    ).toBeNull();
    expect(
      normalizePreferences({
        appAdvisorDialogBounds: {
          x: Number.NaN,
          y: 20,
          width: 460,
          height: 620,
        },
      }).appAdvisorDialogBounds,
    ).toBeNull();
    expect(
      normalizePreferences({
        codexMultiAgentAppAdvisorEnabled: 'yes',
      }).codexMultiAgentAppAdvisorEnabled,
    ).toBe(true);
  });

  it('normalizes Codex fast mode default preference', () => {
    expect(normalizePreferences({}).codexFastModeDefaultEnabled).toBe(false);
    expect(
      normalizePreferences({ codexFastModeDefaultEnabled: true })
        .codexFastModeDefaultEnabled,
    ).toBe(true);
    expect(
      normalizePreferences({ codexFastModeDefaultEnabled: 'yes' })
        .codexFastModeDefaultEnabled,
    ).toBe(false);
  });

  it('normalizes legacy Opus preference IDs to the 1M model', () => {
    expect(
      normalizePreferences({
        defaultChatModelByProvider: {
          claude: {
            model: 'claude-opus-4-7',
            thinkingLevel: 'high',
          },
        },
        summaryModel: 'claude-opus-4-7',
        pipelineAdvisorModel: 'claude-opus-4-7',
      }).defaultChatModelByProvider.claude.model,
    ).toBe('opus[1m]');
    expect(
      normalizePreferences({
        summaryModel: 'claude-opus-4-7',
        summaryModelSetByUser: true,
      }).summaryModel,
    ).toBe('opus[1m]');
    expect(
      normalizePreferences({
        pipelineAdvisorModel: 'claude-opus-4-7',
      }).pipelineAdvisorModel,
    ).toBe('opus[1m]');
  });

  it('normalizes legacy Sonnet preference IDs to the current model', () => {
    expect(
      normalizePreferences({
        defaultChatModelByProvider: {
          claude: {
            model: 'claude-sonnet-4-6',
            thinkingLevel: 'high',
          },
        },
        prGenerationModel: 'claude-sonnet-4-6',
        commitGenerationModel: 'claude-sonnet-4-5-20250929',
      }).defaultChatModelByProvider.claude.model,
    ).toBe('sonnet');
    expect(
      normalizePreferences({
        prGenerationModel: 'claude-sonnet-4-6',
      }).prGenerationModel,
    ).toBe('sonnet');
    expect(
      normalizePreferences({
        commitGenerationModel: 'claude-sonnet-4-5-20250929',
      }).commitGenerationModel,
    ).toBe('sonnet');
  });

  describe('codexCompatDisabledPlugins', () => {
    it('defaults to an empty array when absent', () => {
      const result = normalizePreferences({});
      expect(result.codexCompatDisabledPlugins).toEqual([]);
    });

    it('keeps string entries, lowercases plugin names, and drops non-string entries', () => {
      const result = normalizePreferences({
        codexCompatDisabledPlugins: [
          'mkt-1/my-plugin',
          'mkt-2/Other',
          'mkt-2/other',
          'mkt-3/Nested/Plugin',
          42,
          null,
          undefined,
          { not: 'a string' },
        ] as unknown as string[],
      });
      expect(result.codexCompatDisabledPlugins).toEqual([
        'mkt-1/my-plugin',
        'mkt-2/other',
        'mkt-3/nested/plugin',
      ]);
    });
  });

  describe('telemetrySharing', () => {
    it('defaults every data type to off when absent', () => {
      const result = normalizePreferences({});
      expect(result.telemetrySharing).toEqual({
        transcripts: 'off',
        plans: 'off',
        metadata: 'off',
        summaries: 'off',
      });
    });

    it('preserves valid per-type visibility values', () => {
      const result = normalizePreferences({
        telemetrySharing: {
          transcripts: 'private',
          plans: 'team',
          metadata: 'organization',
          summaries: 'private',
        },
      });
      expect(result.telemetrySharing).toEqual({
        transcripts: 'private',
        plans: 'team',
        metadata: 'organization',
        summaries: 'private',
      });
    });

    it('coerces invalid or missing per-type values to off', () => {
      const result = normalizePreferences({
        telemetrySharing: {
          transcripts: 'public',
          plans: 42,
          // metadata intentionally omitted
        },
      });
      expect(result.telemetrySharing).toEqual({
        transcripts: 'off',
        plans: 'off',
        metadata: 'off',
        // Inherits the (coerced-to-off) metadata value.
        summaries: 'off',
      });
    });

    it('coerces a non-object telemetrySharing value to all off', () => {
      const result = normalizePreferences({
        telemetrySharing: 'nope',
      });
      expect(result.telemetrySharing).toEqual({
        transcripts: 'off',
        plans: 'off',
        metadata: 'off',
        summaries: 'off',
      });
    });

    // -----------------------------------------------------------------------
    // `summaries` shape migration. Summaries used to ride on `metadata`, so a
    // preferences file written before the split has no `summaries` key. Reading
    // it back as `'off'` would silently stop summaries for every existing user;
    // it must inherit the stored `metadata` value instead.
    // -----------------------------------------------------------------------
    it('inherits the stored metadata value when the legacy file has no summaries key', () => {
      const result = normalizePreferences({
        telemetrySharing: {
          transcripts: 'off',
          plans: 'private',
          metadata: 'organization',
        },
      });
      expect(result.telemetrySharing.summaries).toBe('organization');
      expect(result.telemetrySharing).toEqual({
        transcripts: 'off',
        plans: 'private',
        metadata: 'organization',
        summaries: 'organization',
      });
    });

    it('inherits a stored team-scoped metadata value for summaries', () => {
      const result = normalizePreferences({
        telemetrySharing: {
          transcripts: 'team',
          plans: 'off',
          metadata: 'team',
        },
      });
      expect(result.telemetrySharing.summaries).toBe('team');
    });

    it('does not inherit metadata once summaries is explicitly stored', () => {
      const result = normalizePreferences({
        telemetrySharing: {
          transcripts: 'off',
          plans: 'off',
          metadata: 'organization',
          summaries: 'off',
        },
      });
      expect(result.telemetrySharing.summaries).toBe('off');
    });

    it('falls back to off when summaries is absent and metadata is invalid', () => {
      const result = normalizePreferences({
        telemetrySharing: {
          transcripts: 'private',
          plans: 'private',
          metadata: 'public',
        },
      });
      expect(result.telemetrySharing.summaries).toBe('off');
    });

    it('defaults telemetrySharingPromptSeen to false when absent', () => {
      const result = normalizePreferences({});
      expect(result.telemetrySharingPromptSeen).toBe(false);
    });

    it('preserves a boolean telemetrySharingPromptSeen value', () => {
      const result = normalizePreferences({ telemetrySharingPromptSeen: true });
      expect(result.telemetrySharingPromptSeen).toBe(true);
    });

    it('coerces a non-boolean telemetrySharingPromptSeen to the default', () => {
      const result = normalizePreferences({
        telemetrySharingPromptSeen: 'yes',
      });
      expect(result.telemetrySharingPromptSeen).toBe(false);
    });

    it.each(['free', 'paid'] as const)(
      'preserves the %s telemetry sharing tier marker',
      (telemetrySharingTier) => {
        expect(normalizePreferences({ telemetrySharingTier })).toMatchObject({
          telemetrySharingTier,
        });
      },
    );

    it('leaves the telemetry sharing tier marker absent for missing or invalid values', () => {
      expect(normalizePreferences({}).telemetrySharingTier).toBeUndefined();
      expect(
        normalizePreferences({
          telemetrySharingTier: 'trial',
        }).telemetrySharingTier,
      ).toBeUndefined();
    });
  });

  it('normalizes file indexing preferences', () => {
    const preferences = normalizePreferences({
      fileIndexing: {
        disabledBuiltinGlobIds: ['node-modules', 'unknown', 'node-modules'],
        customGlobs: [
          { id: 'keep', pattern: ' generated/** ', enabled: false },
          { id: 'duplicate', pattern: 'generated/**', enabled: true },
          { pattern: 'logs/**', enabled: 'yes' },
          { id: 'blank', pattern: '   ', enabled: true },
        ],
      },
    });

    expect(preferences.fileIndexing.disabledBuiltinGlobIds).toEqual([
      'node-modules',
    ]);
    expect(preferences.fileIndexing.customGlobs[0]).toEqual({
      id: 'keep',
      pattern: 'generated/**',
      enabled: false,
    });
    expect(preferences.fileIndexing.customGlobs[1]?.id).toMatch(
      /^custom-[0-9a-f]{12}$/,
    );
    expect(preferences.fileIndexing.customGlobs[1]).toMatchObject({
      pattern: 'logs/**',
      enabled: true,
    });
  });

  it.each([
    undefined,
    null,
    false,
    0,
    '',
    [],
    'invalid',
    { disabledBuiltinGlobIds: 'node-modules', customGlobs: {} },
  ])('defaults malformed file indexing input %p', (fileIndexing) => {
    expect(normalizePreferences({ fileIndexing }).fileIndexing).toEqual({
      disabledBuiltinGlobIds: [],
      customGlobs: [],
    });
  });

  it('preserves exact disabled membership and custom normalization edge cases', () => {
    expect(
      normalizePreferences({
        fileIndexing: {
          disabledBuiltinGlobIds: [
            'gradle',
            ' node-modules',
            'NODE-MODULES',
            'node-modules ',
            'unknown',
            1,
            null,
            'node-modules',
            'gradle',
          ],
          customGlobs: [
            null,
            [],
            false,
            'x',
            {},
            { pattern: 4 },
            { pattern: '  ' },
            { id: ' same ', pattern: ' café/** ', enabled: false },
            { id: 'ignored', pattern: 'café/**', enabled: true },
            { id: 'same', pattern: 'other/**', enabled: 0 },
            { pattern: 'CAFÉ/**', enabled: null },
            { id: ' ', pattern: 'logs/**' },
            { pattern: 'cafe\u0301/**', enabled: 'no' },
            { id: 42, pattern: '[' },
            { id: ' odd ', pattern: ' ! ' },
          ],
        },
      }).fileIndexing,
    ).toEqual({
      disabledBuiltinGlobIds: ['gradle', 'node-modules'],
      customGlobs: [
        { id: 'same', pattern: 'café/**', enabled: false },
        { id: 'same', pattern: 'other/**', enabled: true },
        { id: 'custom-ea4cc135ba0e', pattern: 'CAFÉ/**', enabled: true },
        { id: 'custom-b616456d7375', pattern: 'logs/**', enabled: true },
        { id: 'custom-2207e03a1c83', pattern: 'cafe\u0301/**', enabled: true },
        { id: 'custom-245843abef9e', pattern: '[', enabled: true },
        { id: 'odd', pattern: '!', enabled: true },
      ],
    });
  });

  it('hashes trimmed Unicode patterns without folding case or normalization', () => {
    expect(
      normalizePreferences({
        fileIndexing: {
          customGlobs: [{ pattern: ' café/** ' }, { pattern: 'CAFÉ/**' }],
        },
      }).fileIndexing.customGlobs,
    ).toEqual([
      { id: 'custom-cadf99727580', pattern: 'café/**', enabled: true },
      { id: 'custom-ea4cc135ba0e', pattern: 'CAFÉ/**', enabled: true },
    ]);
  });

  it('creates fresh file indexing defaults on each normalization', () => {
    const first = normalizePreferences({}).fileIndexing;
    const second = normalizePreferences({}).fileIndexing;
    first.disabledBuiltinGlobIds.push('gradle');
    first.customGlobs.push({ id: 'x', pattern: 'x', enabled: true });
    expect(second).toEqual({ disabledBuiltinGlobIds: [], customGlobs: [] });
  });

  it('normalizes fileLabels: drops malformed buckets/matchers and dedupes ids', () => {
    const preferences = normalizePreferences({
      fileLabels: [
        {
          id: ' tests ',
          name: ' Tests ',
          enabled: false,
          stopFurtherLabels: true,
          builtin: true,
          matchers: [
            {
              id: 'tests-dirs',
              pattern: ' **/tests/** ',
              enabled: false,
              stopMatching: true,
              builtin: true,
            },
            { id: 'tests-dirs', pattern: '**/dupe/**' },
            { id: '', pattern: '**/no-id/**' },
            { id: 'blank-pattern', pattern: '   ' },
            { id: 'loose', pattern: '**/loose/**' },
          ],
        },
        { id: 'tests', name: 'Duplicate bucket' },
        { id: '', name: 'No id' },
        { id: 'nameless', name: '   ' },
        'not-a-bucket',
      ],
    });

    expect(preferences.fileLabels).toHaveLength(1);
    expect(preferences.fileLabels[0]).toEqual({
      id: 'tests',
      name: 'Tests',
      enabled: false,
      stopFurtherLabels: true,
      builtin: true,
      matchers: [
        {
          id: 'tests-dirs',
          pattern: '**/tests/**',
          enabled: false,
          stopMatching: true,
          builtin: true,
        },
        {
          id: 'loose',
          pattern: '**/loose/**',
          enabled: true,
          stopMatching: false,
          builtin: false,
        },
      ],
    });
  });

  it('defaults fileLabels and changedFilesHiddenLabelIds when missing or invalid', () => {
    const result = normalizePreferences({});
    expect(result.fileLabels).toEqual([]);
    expect(result.changedFilesHiddenLabelIds).toEqual([]);
    const invalid = normalizePreferences({
      fileLabels: 'nope',
      changedFilesHiddenLabelIds: 'nope',
    });
    expect(invalid.fileLabels).toEqual([]);
    expect(invalid.changedFilesHiddenLabelIds).toEqual([]);
  });

  it('dedupes and string-filters changedFilesHiddenLabelIds', () => {
    const result = normalizePreferences({
      changedFilesHiddenLabelIds: ['tests', 'tests', 7, 'other'],
    });
    expect(result.changedFilesHiddenLabelIds).toEqual(['tests', 'other']);
  });

  it('normalizes planDetection: drops unknown built-in ids and invalid rules', () => {
    const result = normalizePreferences({
      planDetection: {
        disabledBuiltinRuleIds: ['superpowers-specs', 'nope'],
        customRules: [
          {
            id: 'r1',
            label: 'L',
            kind: 'include',
            pattern: 'a/*.md',
            enabled: true,
          },
          {
            id: 'bad',
            label: 'X',
            kind: 'sideways',
            pattern: '',
            enabled: true,
          },
        ],
      },
    });
    expect(result.planDetection.disabledBuiltinRuleIds).toEqual([
      'superpowers-specs',
    ]);
    expect(result.planDetection.customRules).toHaveLength(1);
    expect(result.planDetection.customRules[0].id).toBe('r1');
  });

  it('defaults planDetection to empty sets when missing', () => {
    const result = normalizePreferences({});
    expect(result.planDetection).toEqual({
      disabledBuiltinRuleIds: [],
      customRules: [],
    });
  });

  it('normalizes planDetection: drops custom rules with .. path traversal segments', () => {
    const result = normalizePreferences({
      planDetection: {
        disabledBuiltinRuleIds: [],
        customRules: [
          {
            id: 'x',
            label: 'x',
            kind: 'include',
            pattern: '../escape/*.md',
            enabled: true,
          },
          {
            id: 'y',
            label: 'y',
            kind: 'include',
            pattern: 'docs/../../etc/passwd.md',
            enabled: true,
          },
          {
            id: 'safe',
            label: 'safe',
            kind: 'include',
            pattern: 'docs/plans/*.md',
            enabled: true,
          },
        ],
      },
    });
    // Traversal rules must be dropped; only the safe rule survives
    expect(result.planDetection.customRules).toHaveLength(1);
    expect(result.planDetection.customRules[0].id).toBe('safe');
  });

  it('normalizes planDetection: drops absolute custom rule patterns and normalizes slashes', () => {
    const result = normalizePreferences({
      planDetection: {
        disabledBuiltinRuleIds: [],
        customRules: [
          {
            id: 'posix',
            label: 'posix',
            kind: 'include',
            pattern: '/etc/**/*.md',
            enabled: true,
          },
          {
            id: 'windows',
            label: 'windows',
            kind: 'include',
            pattern: 'C:\\Windows\\**\\*.md',
            enabled: true,
          },
          {
            id: 'safe',
            label: 'safe',
            kind: 'include',
            pattern: 'docs\\plans\\*.md',
            enabled: true,
          },
        ],
      },
    });
    expect(result.planDetection.customRules).toEqual([
      expect.objectContaining({
        id: 'safe',
        pattern: 'docs/plans/*.md',
      }),
    ]);
  });
});

describe('registerPreferenceHandlers', () => {
  it('registers preference handlers', () => {
    expect(mockedRegisterIpcHandler).toHaveBeenCalledTimes(11);
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'preferences:load',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'preferences:acknowledge-load-error',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'preferences:create-primary-data-dir',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'preferences:open-memory-dir',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'preferences:import-claude-memory',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'preferences:save',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'preferences:set-pipeline-disabled',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'preferences:update-onboarding-tips',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'preferences:set-approval-default',
      expect.any(Function),
    );
  });
});

describe('create primary data-dir handler', () => {
  const mockPrimaryAdoptionMarkerPath = join(
    mockPrimaryDataDir,
    'data-dir-adopted.json',
  );

  it('creates the primary data directory, writes only the adoption marker, and returns the post-restart primary status', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await createPrimaryDataDirHandler();

    expect(mockedMkdir).toHaveBeenCalledWith(mockPrimaryDataDir, {
      recursive: true,
    });
    const markerCall = mockedWriteFile.mock.calls.findIndex(
      ([filePath]) => filePath === mockPrimaryAdoptionMarkerPath,
    );
    expect(markerCall).toBeGreaterThanOrEqual(0);
    expect(mockedMkdir.mock.invocationCallOrder[0]).toBeLessThan(
      mockedWriteFile.mock.invocationCallOrder[markerCall],
    );
    const markerBody = mockedWriteFile.mock.calls[markerCall]?.[1];
    if (typeof markerBody !== 'string') {
      throw new Error('Expected the adoption marker write body to be JSON');
    }
    const parsedMarker: unknown = JSON.parse(markerBody);
    const adoptedAtMatcher: unknown = expect.any(String);
    expect(parsedMarker).toEqual({
      version: 1,
      adoptedAt: adoptedAtMatcher,
    });
    // No workspace index seed: the first W5 commit on the root creates it.
    expect(mockedWriteFileAtomically).not.toHaveBeenCalled();
    expect(mockedWriteFile.mock.calls.map(([filePath]) => filePath)).toEqual([
      mockPrimaryAdoptionMarkerPath,
    ]);
    expect(mockedMkdir.mock.calls.map(([dirPath]) => dirPath)).toEqual([
      mockPrimaryDataDir,
    ]);
    expect(mockResetResolvedCanopyDataDirCache).not.toHaveBeenCalled();
    expect(result).toEqual({
      path: mockPrimaryDataDir,
      source: 'primary',
      allCandidates: [mockPrimaryDataDir, mockFallbackDataDir],
    });
  });

  it('keeps override-backed launches pinned to the override data directory', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockGetResolvedCanopyDataDir.mockReturnValue({
      path: '/mock/override',
      source: 'override',
      allCandidates: [mockPrimaryDataDir, mockFallbackDataDir],
    });

    const result = await createPrimaryDataDirHandler();

    expect(mockedMkdir).toHaveBeenCalledWith(mockPrimaryDataDir, {
      recursive: true,
    });
    expect(mockResetResolvedCanopyDataDirCache).not.toHaveBeenCalled();
    expect(result).toEqual({
      path: '/mock/override',
      source: 'override',
      allCandidates: [mockPrimaryDataDir, mockFallbackDataDir],
    });
  });

  it('propagates directory creation failures without writing the marker', async () => {
    const error = new Error('mkdir failed');
    mockedMkdir.mockRejectedValue(error);

    await expect(createPrimaryDataDirHandler()).rejects.toThrow('mkdir failed');

    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockGetResolvedCanopyDataDir).not.toHaveBeenCalled();
    expect(mockResetResolvedCanopyDataDirCache).not.toHaveBeenCalled();
  });

  it('propagates adoption marker write failures', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    const error: NodeJS.ErrnoException = new Error('disk full');
    error.code = 'ENOSPC';
    mockedWriteFile.mockRejectedValueOnce(error);

    await expect(createPrimaryDataDirHandler()).rejects.toThrow('disk full');

    expect(mockGetResolvedCanopyDataDir).not.toHaveBeenCalled();
    expect(mockResetResolvedCanopyDataDirCache).not.toHaveBeenCalled();
  });
});

describe('open memory directory handler', () => {
  it('creates and opens the user memory directory', async () => {
    mockedMkdir.mockResolvedValue(undefined);

    await openMemoryDirHandler();

    const memoryDir = join(mockFallbackDataDir, 'memory');
    expect(mockedMkdir).toHaveBeenCalledWith(memoryDir, { recursive: true });
    expect(mockedOpenPath).toHaveBeenCalledWith(memoryDir);
  });

  it('validates and opens the selected project memory directory', async () => {
    mockedMkdir.mockResolvedValue(undefined);

    await openMemoryDirHandler(undefined, 'workspace-1');

    const memoryDir = '/mock/workspaces/workspace-1/memory';
    expect(mockedMkdir).toHaveBeenCalledWith(memoryDir, { recursive: true });
    expect(mockedOpenPath).toHaveBeenCalledWith(memoryDir);
  });

  it('rejects an invalid project id before opening a directory', async () => {
    await expect(
      openMemoryDirHandler(undefined, '../outside'),
    ).rejects.toThrow();

    expect(mockedMkdir).not.toHaveBeenCalled();
    expect(mockedOpenPath).not.toHaveBeenCalled();
  });
});

describe('Claude memory import handler', () => {
  it('validates and imports for the current project', async () => {
    await expect(
      importClaudeMemoryHandler(undefined, { workspaceId: 'workspace-1' }),
    ).resolves.toEqual({
      disabled: false,
      staged: 1,
      skipped: 0,
      deferred: 0,
      errors: [],
    });
    expect(enqueueManualLocalMemoryImportBatchMock).toHaveBeenCalledWith(
      'workspace-1',
    );
  });
});

describe('load handler', () => {
  it('retries an enabled-profile answer migration with the same timestamp after a failed commit', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout'],
    });
    try {
      jest.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
      mockedReadFile.mockResolvedValue(
        makePrefsFile({
          osNotifications: {
            ...DEFAULT_PREFERENCES.osNotifications,
            enabled: true,
          },
          colorMode: 'dark',
        }),
      );
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);
      mockedRename.mockRejectedValueOnce(new Error('commit failed'));
      await expect(loadHandler()).rejects.toThrow('commit failed');
      jest.setSystemTime(new Date('2026-09-02T12:00:00.000Z'));
      const loaded = expectPreferencesData(await loadHandler());
      expect(loaded.osNotificationOfferAnsweredAt).toBe(
        '2026-09-01T12:00:00.000Z',
      );
      expect(loaded.colorMode).toBe('dark');
    } finally {
      jest.useRealTimers();
    }
  });

  it('projects unavailable defaults for execution without replacing saved choices', async () => {
    const saved = {
      defaultChatModelByProvider: {
        codex: { model: 'gpt-future-default', thinkingLevel: 'ultra' },
      },
      defaultWorktreeModelByProvider: {
        codex: { model: 'gpt-future-default', thinkingLevel: 'ultra' },
      },
      appAdvisorModel: 'gpt-future-advisor',
    };
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, preferences: saved }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const execution = expectPreferencesData(await loadHandler());
    expect(execution.defaultChatModelByProvider.codex.model).toBe(
      DEFAULT_CODEX_MODEL,
    );
    expect(execution.defaultWorktreeModelByProvider.codex.model).toBe(
      DEFAULT_CODEX_MODEL,
    );
    expect(
      getExecutionHarnessForModel(
        execution.defaultWorktreeModelByProvider.codex.model,
      ),
    ).toBe('codex');
    expect(
      getExecutionHarnessForModel(execution.appAdvisorModel),
    ).toBeDefined();

    const updated = await updatePreferencesFile(() => ({
      sidebarCollapsed: true,
    }));
    expect(updated).toMatchObject(saved);
    await flushPreferencesWrites();
    expect(findPreferencesWriteContent()).toContain('gpt-future-default');
    expect(findLastGoodWriteContent()).toContain('gpt-future-default');
  });

  it.each(['runtime', 'persisted'] as const)(
    'isolates concurrent preference views when %s loads first',
    async (firstView) => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          preferences: {
            defaultChatModelByProvider: {
              codex: { model: 'gpt-6-astra', thinkingLevel: 'ultra' },
            },
          },
        }),
      );
      const otherView = firstView === 'runtime' ? 'persisted' : 'runtime';
      const [first, other] = await Promise.all([
        loadHandler(undefined, { view: firstView }),
        loadHandler(undefined, { view: otherView }),
      ]);
      const runtime = expectPreferencesData(
        firstView === 'runtime' ? first : other,
      );
      const persisted = expectPreferencesData(
        firstView === 'persisted' ? first : other,
      );
      expect(runtime.defaultChatModelByProvider.codex.model).toBe(
        DEFAULT_CODEX_MODEL,
      );
      expect(persisted.defaultChatModelByProvider.codex).toEqual({
        model: 'gpt-6-astra',
        thinkingLevel: 'ultra',
      });
      expect(mockedReadFile).toHaveBeenCalledTimes(1);
      expect(mockedWriteFile).not.toHaveBeenCalled();
    },
  );

  it('restores saved runtime defaults when the model catalog becomes available', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          defaultChatModelByProvider: {
            codex: { model: 'gpt-6-astra', thinkingLevel: 'ultra' },
          },
        },
      }),
    );
    expect(
      expectPreferencesData(await loadHandler()).defaultChatModelByProvider
        .codex.model,
    ).toBe(DEFAULT_CODEX_MODEL);
    initCodexModels([
      { id: DEFAULT_CODEX_MODEL, label: 'GPT 5.5' },
      { id: 'gpt-6-astra', label: 'GPT 6 Astra' },
    ]);
    invalidateRendererRuntimePreferencesCache();
    expect(
      expectPreferencesData(await loadHandler()).defaultChatModelByProvider
        .codex,
    ).toEqual({ model: 'gpt-6-astra', thinkingLevel: 'ultra' });
    expect(mockedReadFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('returns saved choices to Settings while broadcasting runnable defaults', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          defaultChatModelByProvider: {
            codex: { model: 'gpt-6-astra', thinkingLevel: 'ultra' },
          },
        },
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    const fakeWindow = new BrowserWindow();
    const getAllWindowsSpy = jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([fakeWindow]);
    try {
      const saved = expectPreferencesData(
        await saveHandler(
          {},
          { sidebarCollapsed: true },
          { view: 'persisted' },
        ),
      );
      expect(saved.defaultChatModelByProvider.codex.model).toBe('gpt-6-astra');
      const codex: unknown = expect.objectContaining({
        model: DEFAULT_CODEX_MODEL,
      });
      const defaultChatModelByProvider: unknown = expect.objectContaining({
        codex,
      });
      expect(mockedSendToWindow).toHaveBeenCalledWith(
        fakeWindow,
        'preferences:synced',
        expect.objectContaining({ defaultChatModelByProvider }),
      );
      expect(findPreferencesWriteContent()).toContain('gpt-6-astra');
      expect(findLastGoodWriteContent()).toContain('gpt-6-astra');
    } finally {
      getAllWindowsSpy.mockRestore();
    }
  });

  it.each([
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
  ])(
    'preserves a prototype-looking saved model ID as a string: %s',
    async (model) => {
      const saved = {
        defaultChatModelByProvider: {
          codex: { model, thinkingLevel: 'ultra' },
        },
        summaryModel: model,
        summaryModelSetByUser: true,
      };
      mockedReadFile.mockResolvedValue(
        JSON.stringify({ version: 1, preferences: saved }),
      );
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      expect(await loadHandler(undefined, { view: 'persisted' })).toMatchObject(
        saved,
      );
      await updatePreferencesFile(() => ({ sidebarCollapsed: true }));
      await flushPreferencesWrites();
      for (const [, contents] of mockedWriteFile.mock.calls) {
        if (typeof contents !== 'string') {
          throw new Error('Expected serialized preferences');
        }
        const written: unknown = JSON.parse(contents);
        expect(written).toMatchObject({ preferences: saved });
      }
      expect(mockedWriteFile).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['', 'invalid model', 'model\n', 'x'.repeat(513)])(
    'rejects malformed persisted model IDs: %p',
    async (model) => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          preferences: {
            defaultChatModelByProvider: { codex: { model } },
            summaryModel: model,
            summaryModelSetByUser: true,
          },
        }),
      );

      const result = expectPreferencesData(await loadHandler());
      expect(result.defaultChatModelByProvider.codex.model).toBe(
        DEFAULT_CODEX_MODEL,
      );
      expect(result.summaryModel).toBe(DEFAULT_PREFERENCES.summaryModel);
      expect(result.summaryModelSetByUser).toBe(false);
    },
  );

  it.each(['cold', 'missing'] as const)(
    'preserves saved model choices and effort through unrelated saves when the catalog is %s',
    async (catalog) => {
      if (catalog === 'cold') {
        initClaudeModels([]);
        initCodexModels([]);
        initAiGatewayModels([], []);
        initOllamaModels([]);
      }
      const saved = {
        defaultChatModelByProvider: {
          claude: { model: 'sonnet', thinkingLevel: 'max' },
          codex: { model: 'gpt-6-astra', thinkingLevel: 'ultra' },
          ollama: { model: 'ollama-offline-model', thinkingLevel: 'high' },
          aiCredits: {
            model: 'org-gateway/offline-model',
            thinkingLevel: 'high',
          },
        },
        defaultWorktreeModelByProvider: {
          claude: { model: 'sonnet', thinkingLevel: 'max' },
          codex: { model: 'gpt-6-astra', thinkingLevel: 'ultra' },
          ollama: null,
          aiCredits: null,
        },
        summaryModel: 'gpt-6-astra',
        summaryModelSetByUser: true,
        summaryThinkingLevel: 'ultra',
        worktreeSummaryModel: 'gpt-6-astra',
        planDiagramModel: 'gpt-6-astra',
        codeReviewModel: 'gpt-6-astra',
        prGenerationModel: 'gpt-6-astra',
        commitGenerationModel: 'gpt-6-astra',
        branchNamingModel: 'gpt-6-astra',
        pipelineAdvisorModel: 'gpt-6-astra',
        appAdvisorModel: 'gpt-6-astra',
        cronGenerationModel: 'gpt-6-astra',
        ifCommandGenerationModel: 'gpt-6-astra',
        splitPrPlannerModel: 'gpt-6-astra',
        agentRebaseResolutionModel: 'gpt-6-astra',
        providerModelConfigDefaults: { codex: { fastMode: true } },
      };
      mockedReadFile.mockResolvedValue(
        JSON.stringify({ version: 1, preferences: saved }),
      );
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      expect(await loadHandler(undefined, { view: 'persisted' })).toMatchObject(
        saved,
      );
      const result = await updatePreferencesFile(() => ({
        sidebarCollapsed: true,
      }));
      expect(result).toMatchObject({ ...saved, sidebarCollapsed: true });
      await flushPreferencesWrites();
      const writes = mockedWriteFile.mock.calls.map(([, contents]) => {
        if (typeof contents !== 'string') {
          throw new Error('Expected serialized preferences');
        }
        const written: unknown = JSON.parse(contents);
        return written;
      });
      expect(writes).toHaveLength(2);
      for (const written of writes) {
        expect(written).toMatchObject({ preferences: saved });
      }
    },
  );

  it('validates an explicit replacement without erasing an unavailable sibling selection', async () => {
    const saved = {
      claude: { model: 'sonnet', thinkingLevel: 'max' as const },
      codex: { model: 'gpt-6-astra', thinkingLevel: 'ultra' as const },
      ollama: null,
      aiCredits: null,
    };
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ defaultChatModelByProvider: saved }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await updatePreferencesFile(() => ({
      defaultChatModelByProvider: {
        ...saved,
        claude: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'medium' },
      },
    }));

    expect(result.defaultChatModelByProvider.codex).toEqual(saved.codex);
    expect(result.defaultChatModelByProvider.claude.model).toBe('opus[1m]');
  });

  it('resolves unavailable models for execution without changing the saved choice', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        defaultChatModelByProvider: {
          claude: { model: 'sonnet', thinkingLevel: 'max' },
          codex: { model: 'gpt-6-astra', thinkingLevel: 'ultra' },
          ollama: null,
          aiCredits: null,
        },
        summaryModel: 'gpt-6-astra',
        summaryModelSetByUser: true,
      }),
    );

    expect(
      (await readPreferencesFile()).defaultChatModelByProvider.codex.model,
    ).toBe(DEFAULT_CODEX_MODEL);
    expect((await readPreferencesFile()).summaryModel).toBe(
      DEFAULT_PREFERENCES.summaryModel,
    );
    initCodexModels([
      { id: DEFAULT_CODEX_MODEL, label: 'GPT 5.5' },
      { id: 'gpt-6-astra', label: 'GPT 6 Astra' },
    ]);
    const available = await readPreferencesFile();
    expect(available.defaultChatModelByProvider.codex).toEqual({
      model: 'gpt-6-astra',
      thinkingLevel: 'ultra',
    });
    expect(available.summaryModel).toBe('gpt-6-astra');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('preserves an unavailable model when only its effort is changed', async () => {
    const saved = {
      claude: { model: 'sonnet', thinkingLevel: 'max' as const },
      codex: { model: 'gpt-6-astra', thinkingLevel: 'high' as const },
      ollama: null,
      aiCredits: null,
    };
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ defaultChatModelByProvider: saved }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await updatePreferencesFile(() => ({
      defaultChatModelByProvider: {
        ...saved,
        codex: { ...saved.codex, thinkingLevel: 'ultra' },
      },
    }));

    expect(result.defaultChatModelByProvider.codex).toEqual({
      model: 'gpt-6-astra',
      thinkingLevel: 'ultra',
    });
  });

  it('repairs the selected provider after rejecting an explicit unavailable Ollama model', async () => {
    const saved = {
      claude: { model: 'sonnet', thinkingLevel: 'high' as const },
      codex: { model: 'gpt-6-astra', thinkingLevel: 'ultra' as const },
      ollama: { model: 'ollama-qwen3-coder', thinkingLevel: 'high' as const },
      aiCredits: null,
    };
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        defaultChatProvider: 'ollama',
        defaultChatModelByProvider: saved,
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await updatePreferencesFile(() => ({
      defaultChatModelByProvider: {
        ...saved,
        ollama: { model: 'ollama-unavailable', thinkingLevel: 'high' },
      },
    }));

    expect(result.defaultChatModelByProvider.ollama).toBeNull();
    expect(result.defaultChatProvider).toBe('claude');
    expect(result.defaultChatModelByProvider.codex).toEqual(saved.codex);
  });

  it('returns defaults when file does not exist', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = expectPreferencesData(await loadHandler());

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 32,
      sidebarCollapsed: false,
    });
  });

  it('preserves preferences without backup or default writes when an existing file cannot be read', async () => {
    const error = new Error('EACCES');
    Object.defineProperty(error, 'code', { value: 'EACCES' });
    mockedReadFile.mockRejectedValue(error);
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await loadHandler()) as PreferencesLoadResult;

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 32,
      sidebarCollapsed: false,
    });
    expect(result.__error?.reason).toBe('read');
    expect(result.__error?.code).toBe('EACCES');
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(findPreferencesWriteContent()).toBeNull();
    expect(findLastGoodWriteContent()).toBeNull();
  });

  it('returns normalized preferences for valid v1 file', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: 45, sidebarCollapsed: true }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 45,
      sidebarCollapsed: true,
    });
  });

  it('drops the removed environments nav key from a stored layout without resetting it (CAN-4269)', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        sidebarCollapsed: true,
        sidebarNavLayout: {
          order: [
            'plugins',
            'environments',
            'app-advisor',
            'workflows',
            'feed',
            'remote-control',
            'workers',
            'overview',
            'kanban',
            'agents',
            'statistics',
            'audit',
          ],
          moreStartIndex: 6,
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.sidebarCollapsed).toBe(true);
    expect(result.sidebarNavLayout).toEqual({
      order: [
        'plugins',
        'app-advisor',
        'workflows',
        'feed',
        'remote-control',
        'workers',
        'overview',
        'kanban',
        'statistics',
        'audit',
      ],
      moreStartIndex: 5,
    });
  });

  it('reuses the renderer snapshot instead of rereading an unchanged file', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: 45, sidebarCollapsed: true }),
    );

    const first = await loadHandler();
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: 60, sidebarCollapsed: false }),
    );
    const second = await loadHandler();

    expect(first).toMatchObject({
      worktreePanelPercent: 45,
      sidebarCollapsed: true,
    });
    expect(second).toMatchObject({
      worktreePanelPercent: 45,
      sidebarCollapsed: true,
    });
    expect(mockedReadFile).toHaveBeenCalledTimes(1);
  });

  it('reloads renderer preferences after the snapshot is invalidated', async () => {
    mockedReadFile.mockResolvedValueOnce(
      makePrefsFile({ worktreePanelPercent: 45, sidebarCollapsed: true }),
    );
    await loadHandler();

    invalidateRendererPreferencesCache();
    mockedReadFile.mockResolvedValueOnce(
      makePrefsFile({ worktreePanelPercent: 60, sidebarCollapsed: false }),
    );
    const result = await loadHandler();

    expect(result).toMatchObject({
      worktreePanelPercent: 60,
      sidebarCollapsed: false,
    });
    expect(mockedReadFile).toHaveBeenCalledTimes(2);
  });

  it('defaults HTTP MCP auth handling to Canopy proxy', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.mcpHttpAuthDefaultHandler).toBe('canopy');
  });

  it('normalizes invalid HTTP MCP auth handling to Canopy proxy', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          mcpHttpAuthDefaultHandler: 'invalid',
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.mcpHttpAuthDefaultHandler).toBe('canopy');
  });

  it.each(['provider', 'account'] as const)(
    'preserves %s HTTP MCP auth handling',
    async (handler): Promise<void> => {
      mockedReadFile.mockResolvedValue(
        makePrefsFile({ mcpHttpAuthDefaultHandler: handler }),
      );

      const result: unknown = await loadHandler();

      expect(result).toMatchObject({ mcpHttpAuthDefaultHandler: handler });
    },
  );

  it('defaults rtkEnabled to true when missing', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.rtkEnabled).toBe(true);
  });

  it('defaults transient provider retries to true when missing', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = expectPreferencesData(await loadHandler());

    expect(result.autoRetryTransientErrorsChats).toBe(true);
    expect(result.autoRetryTransientErrorsPipelines).toBe(true);
  });

  it('backfills empty helper plugin selections when missing', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.branchNamingPluginSelections).toEqual(
      NEW_DEFAULTS.branchNamingPluginSelections,
    );
    expect(result.commitGenerationPluginSelections).toEqual(
      NEW_DEFAULTS.commitGenerationPluginSelections,
    );
    expect(result.prGenerationPluginSelections).toEqual(
      NEW_DEFAULTS.prGenerationPluginSelections,
    );
    expect(result.worktreeSummaryPluginSelections).toEqual(
      NEW_DEFAULTS.worktreeSummaryPluginSelections,
    );
  });

  it('preserves valid helper plugin selections', async () => {
    const selections = {
      collectionIds: ['bundle-a'],
      skillRefs: [{ sourceId: 'source-a', skillName: 'skill-a' }],
      pluginRefs: [{ marketplaceId: 'market-a', pluginName: 'plugin-a' }],
      mcpServerRefs: [{ serverId: 'server-a', configId: 'config-a' }],
    };
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        branchNamingPluginSelections: selections,
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.branchNamingPluginSelections).toEqual(selections);
  });

  it('drops malformed helper plugin refs and dedupes selections', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          commitGenerationPluginSelections: {
            collectionIds: [' bundle-a ', 'bundle-a', '', 42],
            skillRefs: [
              { sourceId: ' source-a ', skillName: ' skill-a ' },
              { sourceId: 'source-a', skillName: 'skill-a' },
              { sourceId: '', skillName: 'skill-b' },
              { sourceId: 'source-c' },
            ],
            pluginRefs: [
              { marketplaceId: ' market-a ', pluginName: ' plugin-a ' },
              { marketplaceId: 'market-a', pluginName: 'plugin-a' },
              { marketplaceId: 'market-b', pluginName: '' },
            ],
            mcpServerRefs: [
              { serverId: ' server-a ', configId: ' config-a ' },
              { serverId: 'server-a', configId: 'config-a' },
              { serverId: 'server-b' },
            ],
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.commitGenerationPluginSelections).toEqual({
      collectionIds: ['bundle-a'],
      skillRefs: [{ sourceId: 'source-a', skillName: 'skill-a' }],
      pluginRefs: [{ marketplaceId: 'market-a', pluginName: 'plugin-a' }],
      mcpServerRefs: [{ serverId: 'server-a', configId: 'config-a' }],
    });
  });

  it('preserves persisted rtkEnabled false', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ rtkEnabled: false }));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.rtkEnabled).toBe(false);
  });

  it('preserves explicitly disabled transient provider retries', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        autoRetryTransientErrorsChats: false,
        autoRetryTransientErrorsPipelines: false,
      }),
    );

    const result = expectPreferencesData(await loadHandler());

    expect(result.autoRetryTransientErrorsChats).toBe(false);
    expect(result.autoRetryTransientErrorsPipelines).toBe(false);
  });

  it('keeps missing legacy Codex multi-agent preferences disabled while preserving saved opt-outs', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ codexMultiAgentStandaloneChatsEnabled: false }),
    );
    const result = expectPreferencesData(await loadHandler());
    expect(result.codexMultiAgentWorktreeChatsEnabled).toBe(false);
    expect(result.codexMultiAgentStandaloneChatsEnabled).toBe(false);
    expect(result.codexMultiAgentAppAdvisorEnabled).toBe(true);
    expect(result.codexMultiAgentPipelinesEnabled).toBe(false);
    expect(result.codexMaxConcurrentSubagents).toBeNull();
  });

  it.each([null, 1, 12])(
    'preserves the Codex concurrency preference %s',
    async (value) => {
      mockedReadFile.mockResolvedValue(
        makePrefsFile({ codexMaxConcurrentSubagents: value }),
      );
      expect(
        expectPreferencesData(await loadHandler()).codexMaxConcurrentSubagents,
      ).toBe(value);
    },
  );

  it.each([0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid Codex concurrency preference %s',
    async (value) => {
      mockedReadFile.mockResolvedValue(
        makeRawPrefsFile({ codexMaxConcurrentSubagents: value }),
      );
      expect(
        expectPreferencesData(await loadHandler()).codexMaxConcurrentSubagents,
      ).toBeNull();
    },
  );

  it('backfills deferred-tools defaults to enabled when missing', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = expectPreferencesData(await loadHandler());

    expect(result.deferredToolsWorktreeChatsEnabled).toBe(true);
    expect(result.deferredToolsStandaloneChatsEnabled).toBe(true);
    expect(result.deferredToolsAppAdvisorEnabled).toBe(true);
    expect(result.deferredToolsPipelineAssistantEnabled).toBe(true);
  });

  it('preserves explicitly disabled deferred-tools defaults', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        deferredToolsWorktreeChatsEnabled: false,
        deferredToolsStandaloneChatsEnabled: false,
        deferredToolsAppAdvisorEnabled: false,
        deferredToolsPipelineAssistantEnabled: false,
      }),
    );

    const result = expectPreferencesData(await loadHandler());

    expect(result.deferredToolsWorktreeChatsEnabled).toBe(false);
    expect(result.deferredToolsStandaloneChatsEnabled).toBe(false);
    expect(result.deferredToolsAppAdvisorEnabled).toBe(false);
    expect(result.deferredToolsPipelineAssistantEnabled).toBe(false);
  });

  it('falls back to true for malformed rtkEnabled values', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          rtkEnabled: 'nope',
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.rtkEnabled).toBe(true);
  });

  it('falls back to true for malformed transient provider retry values', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          autoRetryTransientErrorsChats: 'yes',
          autoRetryTransientErrorsPipelines: 1,
        },
      }),
    );

    const result = expectPreferencesData(await loadHandler());

    expect(result.autoRetryTransientErrorsChats).toBe(true);
    expect(result.autoRetryTransientErrorsPipelines).toBe(true);
  });

  it('preserves a valid fileAutoSave=true preference', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ fileAutoSave: true }));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.fileAutoSave).toBe(true);
  });

  it('falls back to fileAutoSave=false for malformed values', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { fileAutoSave: 'yes' },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.fileAutoSave).toBe(false);
  });

  it('defaults local-only in-app browsing to false and preserves true', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    expect(
      ((await loadHandler()) as PreferencesData).inAppBrowserLocalServersOnly,
    ).toBe(false);

    mockedReadFile.mockResolvedValue(
      makePrefsFile({ inAppBrowserLocalServersOnly: true }),
    );
    resetPreferencesLoadErrorForTests();
    expect(
      ((await loadHandler()) as PreferencesData).inAppBrowserLocalServersOnly,
    ).toBe(true);
  });

  it('defaults app-link routing to true and preserves false', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    expect(
      ((await loadHandler()) as PreferencesData).openAppLinksInBuiltInBrowser,
    ).toBe(true);

    mockedReadFile.mockResolvedValue(
      makePrefsFile({ openAppLinksInBuiltInBrowser: false }),
    );
    resetPreferencesLoadErrorForTests();
    expect(
      ((await loadHandler()) as PreferencesData).openAppLinksInBuiltInBrowser,
    ).toBe(false);
  });

  it('defaults the system default-browser setting to false and preserves true', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    expect(
      ((await loadHandler()) as PreferencesData).useAsSystemDefaultBrowser,
    ).toBe(false);

    mockedReadFile.mockResolvedValue(
      makePrefsFile({ useAsSystemDefaultBrowser: true }),
    );
    resetPreferencesLoadErrorForTests();
    expect(
      ((await loadHandler()) as PreferencesData).useAsSystemDefaultBrowser,
    ).toBe(true);
  });

  it('defaults worktreeViewMode to "list" when missing', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.worktreeViewMode).toBe('list');
  });

  it('preserves a persisted worktreeViewMode of "list"', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreeViewMode: 'list' }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.worktreeViewMode).toBe('list');
  });

  it('preserves a persisted worktreeViewMode of "kanban"', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreeViewMode: 'kanban' }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.worktreeViewMode).toBe('kanban');
  });

  it('falls back to "list" for unknown worktreeViewMode values', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { worktreeViewMode: 'flow' },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.worktreeViewMode).toBe('list');
  });

  it('falls back to "list" for non-string worktreeViewMode values', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { worktreeViewMode: 42 },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.worktreeViewMode).toBe('list');
  });

  it('defaults worktreeFilterHiddenWorkspaceIds to an empty array when missing', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.worktreeFilterHiddenWorkspaceIds).toEqual([]);
  });

  it('defaults sidebar project sorting to manual order', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.sidebarProjectSortMode).toBe('manual');
  });

  it('preserves last-updated sidebar project sorting', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ sidebarProjectSortMode: 'last-updated' }),
    );
    expect(
      ((await loadHandler()) as PreferencesData).sidebarProjectSortMode,
    ).toBe('last-updated');
  });

  it('rejects unknown sidebar project sorting modes', async () => {
    mockedReadFile.mockResolvedValue(
      makeRawPrefsFile({ sidebarProjectSortMode: 'alphabetical' }),
    );
    expect(
      ((await loadHandler()) as PreferencesData).sidebarProjectSortMode,
    ).toBe('manual');
  });

  it('preserves persisted worktreeFilterHiddenWorkspaceIds string entries', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        worktreeFilterHiddenWorkspaceIds: ['workspace-a', 'workspace-b'],
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.worktreeFilterHiddenWorkspaceIds).toEqual([
      'workspace-a',
      'workspace-b',
    ]);
  });

  it('filters non-string entries from persisted worktreeFilterHiddenWorkspaceIds', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreeFilterHiddenWorkspaceIds: ['workspace-a', 42, null, 'b'],
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.worktreeFilterHiddenWorkspaceIds).toEqual([
      'workspace-a',
      'b',
    ]);
  });

  it('falls back to empty array for non-array worktreeFilterHiddenWorkspaceIds values', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { worktreeFilterHiddenWorkspaceIds: 'not-an-array' },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.worktreeFilterHiddenWorkspaceIds).toEqual([]);
  });

  it('backfills default OS notification preferences when missing', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.osNotifications).toEqual(NEW_DEFAULTS.osNotifications);
  });

  it('normalizes partial OS notification preferences', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          osNotifications: {
            enabled: true,
            categories: {
              script: false,
              gitPush: 'yes',
            },
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.osNotifications).toEqual({
      enabled: true,
      skipWhenFocused: true,
      defaultSound: 'System',
      categories: {
        chat: true,
        script: false,
        hook: true,
        gitCommit: true,
        gitPush: true,
        prCreate: true,
        pipeline: true,
        terminal: true,
        runComment: true,
        activation: true,
      },
      categorySounds: getDefaultOsNotifications().categorySounds,
    });
  });

  it('defaults the activation notification category to enabled', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    // The activation journey (CAN-1967) carries its own opt-in category: the
    // fail-closed rule in `osNotifications.ts` forbids firing lifecycle
    // campaigns through an unrelated category's consent.
    expect(result.osNotifications.categories.activation).toBe(true);
    expect(result.osNotifications.categorySounds.activation).toBe('Default');
  });

  it('preserves an explicit activation category opt-out', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          osNotifications: {
            enabled: true,
            categories: { activation: false },
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.osNotifications.categories.activation).toBe(false);
    expect(result.osNotifications.categories.chat).toBe(true);
  });

  it('preserves explicit in-app chat banner opt-out during normalization', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          osNotifications: {
            enabled: true,
            showInAppChatActivityToasts: false,
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.osNotifications).toEqual({
      ...NEW_DEFAULTS.osNotifications,
      enabled: true,
    });
    expect(result.inAppNotifications).toEqual({
      ...NEW_DEFAULTS.inAppNotifications,
      enabled: false,
    });
  });

  it('drops the old auto-saved bottom-right corner so the default applies', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          inAppNotifications: { enabled: true, placement: 'bottom-right' },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.inAppNotifications.placement).toBeUndefined();
    expect(result.inAppNotifications.placementChosen).toBeUndefined();
  });

  it('keeps a bottom-right corner the user picked', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          inAppNotifications: {
            enabled: true,
            placement: 'bottom-right',
            placementChosen: true,
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.inAppNotifications.placement).toBe('bottom-right');
    expect(result.inAppNotifications.placementChosen).toBe(true);
  });

  it('keeps any other saved corner, which only the user could have picked', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          inAppNotifications: { enabled: true, placement: 'top-left' },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.inAppNotifications.placement).toBe('top-left');
  });

  it('defaults malformed OS notification preferences', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          osNotifications: 'yes',
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.osNotifications).toEqual(NEW_DEFAULTS.osNotifications);
  });

  it('defaults malformed OS notification categories', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          osNotifications: {
            enabled: true,
            skipWhenFocused: false,
            categories: 42,
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.osNotifications).toEqual({
      enabled: true,
      skipWhenFocused: false,
      defaultSound: 'System',
      categories: getDefaultOsNotifications().categories,
      categorySounds: getDefaultOsNotifications().categorySounds,
    });
  });

  it('returns defaults when version is not 1', async () => {
    const rawPreferences = makePrefsFile(
      { worktreePanelPercent: 50, sidebarCollapsed: true },
      2,
    );
    mockedReadFile.mockResolvedValue(rawPreferences);
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await loadHandler()) as PreferencesLoadResult;

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 32,
      sidebarCollapsed: false,
    });
    expect(result.__error?.reason).toBe('version');
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(findPreferencesWriteContent()).toBeNull();
    expect(findLastGoodWriteContent()).toBeNull();
  });

  it('clamps worktreePanelPercent below 20 to 20', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: 5, sidebarCollapsed: false }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 20,
      sidebarCollapsed: false,
    });
  });

  it('clamps worktreePanelPercent above 65 to 65', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: 90, sidebarCollapsed: false }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 65,
      sidebarCollapsed: false,
    });
  });

  it('uses default 32 when worktreePanelPercent is a string', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { worktreePanelPercent: 'forty', sidebarCollapsed: false },
      }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 32,
      sidebarCollapsed: false,
    });
  });

  it('uses default 32 when worktreePanelPercent is NaN', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { worktreePanelPercent: NaN, sidebarCollapsed: false },
      }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 32,
      sidebarCollapsed: false,
    });
  });

  it('uses default 32 when worktreePanelPercent is Infinity', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: Infinity,
          sidebarCollapsed: false,
        },
      }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 32,
      sidebarCollapsed: false,
    });
  });

  it('uses sidebarCollapsed as-is when it is true', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: 40, sidebarCollapsed: true }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 40,
      sidebarCollapsed: true,
    });
  });

  it('uses sidebarCollapsed as-is when it is false', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: 40, sidebarCollapsed: false }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 40,
      sidebarCollapsed: false,
    });
  });

  it('uses default false when sidebarCollapsed is a non-boolean', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { worktreePanelPercent: 40, sidebarCollapsed: 'yes' },
      }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 40,
      sidebarCollapsed: false,
    });
  });

  it('uses default false when sidebarCollapsed is undefined', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { worktreePanelPercent: 40 },
      }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 40,
      sidebarCollapsed: false,
    });
  });

  it('uses default when worktreePanelPercent is undefined', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { sidebarCollapsed: true },
      }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 32,
      sidebarCollapsed: true,
    });
  });

  it('returns defaults when JSON is invalid', async () => {
    mockedReadFile.mockResolvedValue('not valid json {{{');
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await loadHandler()) as PreferencesLoadResult;

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 32,
      sidebarCollapsed: false,
    });
    expect(result.__error?.reason).toBe('parse');
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(findPreferencesWriteContent()).toBeNull();
    expect(findLastGoodWriteContent()).toBeNull();
  });

  it('recovers a malformed top-level preferences container from last-good', async () => {
    mockedReadFile.mockImplementation((filePath) => {
      const path = readFileMockPath(filePath);
      if (path.endsWith('preferences.last-good.json')) {
        return Promise.resolve(
          makePrefsFile({
            approvalDefaults: {
              worktree: 'ask',
              cowork: 'ask',
              appAdvisor: 'ask',
            },
          }),
        );
      }
      return Promise.resolve(JSON.stringify({ version: 1, preferences: null }));
    });
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await loadHandler()) as PreferencesLoadResult;

    expect(result.__error?.reason).toBe('parse');
    expect(result.__error?.restoredFromPath).toBe(
      '/mock/userData/preferences.last-good.json',
    );
    expect(result.approvalDefaults).toEqual({
      worktree: 'ask',
      cowork: 'ask',
      appAdvisor: 'ask',
    });
  });

  it('restores from last-good preferences when the current file is invalid', async () => {
    mockedReadFile.mockImplementation((filePath) => {
      const path = readFileMockPath(filePath);
      if (path.endsWith('preferences.generation.json'))
        return Promise.reject(createEnoentError());
      if (path.endsWith('preferences.last-good.json')) {
        return Promise.resolve(
          makePrefsFile({ worktreePanelPercent: 44, sidebarCollapsed: true }),
        );
      }
      return Promise.resolve('not valid json {{{');
    });
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await loadHandler()) as PreferencesLoadResult;

    expect(result.__error?.reason).toBe('parse');
    expect(result.__error?.restoredFromPath).toBe(
      '/mock/userData/preferences.last-good.json',
    );
    expect(result.worktreePanelPercent).toBe(44);
    expect(result.sidebarCollapsed).toBe(true);
    expect(findPreferencesWriteContent()).toEqual(
      expect.stringContaining('"worktreePanelPercent": 44'),
    );
    expect(findLastGoodWriteContent()).toBeNull();
    // The evidence backup is durable before the primary is replaced.
    expect(mockedWriteFileAtomically.mock.calls).toEqual([
      [
        expect.stringMatching(
          new RegExp(
            `^${escapeRegExp(join('/mock/userData', 'preferences.backup-'))}.+\\.json$`,
          ),
        ),
        expect.any(String),
        { ...PREFERENCES_WRITE, mode: undefined },
      ],
      [
        '/mock/userData/preferences.json',
        expect.any(String),
        { ...PREFERENCES_WRITE, mode: undefined },
      ],
    ]);
  });

  it('restores missing preferences from the last-good file', async () => {
    mockedReadFile.mockImplementation((filePath) => {
      const path = readFileMockPath(filePath);
      if (path.endsWith('preferences.last-good.json')) {
        return Promise.resolve(
          makePrefsFile({ worktreePanelPercent: 48, sidebarCollapsed: true }),
        );
      }
      return Promise.reject(createEnoentError());
    });
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await loadHandler()) as PreferencesLoadResult;

    expect(result.__error?.reason).toBe('read');
    expect(result.__error?.code).toBe('ENOENT');
    expect(result.__error?.restoredFromPath).toBe(
      '/mock/userData/preferences.last-good.json',
    );
    expect(result.worktreePanelPercent).toBe(48);
    expect(result.sidebarCollapsed).toBe(true);
  });

  it('restores missing preferences from last-good without reporting failed backup creation', async () => {
    mockedReadFile.mockImplementation((filePath) => {
      const path = readFileMockPath(filePath);
      if (path.endsWith('preferences.last-good.json')) {
        return Promise.resolve(
          makePrefsFile({ worktreePanelPercent: 52, sidebarCollapsed: true }),
        );
      }
      return Promise.reject(createEnoentError());
    });
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockRejectedValue(new Error('write failed'));

    const result = (await loadHandler()) as PreferencesLoadResult;

    expect(result.__error?.reason).toBe('read');
    expect(result.__error?.code).toBe('ENOENT');
    expect(result.__error?.backupPath).toBeUndefined();
    expect(result.__error?.restoredFromPath).toBe(
      '/mock/userData/preferences.last-good.json',
    );
    expect(result.worktreePanelPercent).toBe(52);
    expect(result.sidebarCollapsed).toBe(true);
    expect(findBackupWriteContent()).toBeNull();
  });

  it('preserves empty primary evidence without a usable recovery source', async () => {
    mockedReadFile.mockResolvedValue('');
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await loadHandler()) as PreferencesLoadResult;

    expect(result.__error?.reason).toBe('parse');
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(findBackupWriteContent()).toBeNull();
  });

  it('reports recovery errors until the renderer acknowledges them', async () => {
    let currentReadCount = 0;
    mockedReadFile.mockImplementation((filePath) => {
      const path = readFileMockPath(filePath);
      if (path.endsWith('preferences.last-good.json')) {
        return Promise.reject(createEnoentError());
      }
      currentReadCount += 1;
      return Promise.resolve(
        currentReadCount === 1
          ? 'not valid json {{{'
          : makePrefsFile({ sidebarCollapsed: true }),
      );
    });
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const firstResult: PreferencesLoadResult = expectPreferencesData(
      await loadHandler(),
    );
    const secondResult: PreferencesLoadResult = expectPreferencesData(
      await loadHandler(),
    );

    expect(firstResult.__error?.reason).toBe('parse');
    expect(secondResult.__error?.reason).toBe('parse');
    expect(secondResult.sidebarCollapsed).toBe(firstResult.sidebarCollapsed);
    expect(currentReadCount).toBe(1);

    await acknowledgeLoadErrorHandler();
    const acknowledgedResult: PreferencesLoadResult = expectPreferencesData(
      await loadHandler(),
    );
    expect(acknowledgedResult.__error).toBeUndefined();
  });

  it('clamps worktreePanelPercent at exact boundary 20', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: 20, sidebarCollapsed: false }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 20,
      sidebarCollapsed: false,
    });
  });

  it('clamps worktreePanelPercent at exact boundary 65', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: 65, sidebarCollapsed: false }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 65,
      sidebarCollapsed: false,
    });
  });

  it('uses default 32 when worktreePanelPercent is negative Infinity', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: -Infinity,
          sidebarCollapsed: false,
        },
      }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 32,
      sidebarCollapsed: false,
    });
  });

  it('handles preferences being undefined in parsed file', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ version: 1 }));

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 32,
      sidebarCollapsed: false,
    });
  });

  it('handles negative worktreePanelPercent clamped to 20', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: -10, sidebarCollapsed: true }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 20,
      sidebarCollapsed: true,
    });
  });

  it('uses default when sidebarCollapsed is a number', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { worktreePanelPercent: 40, sidebarCollapsed: 1 },
      }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 40,
      sidebarCollapsed: false,
    });
  });

  it('uses default when sidebarCollapsed is null', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { worktreePanelPercent: 40, sidebarCollapsed: null },
      }),
    );

    const result = await loadHandler();

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 40,
      sidebarCollapsed: false,
    });
  });

  it('resolves a runtime fallback when the saved Claude model is unavailable', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          defaultChatModelByProvider: {
            claude: { model: 'gpt-4-turbo', thinkingLevel: 'high' },
          },
        },
      }),
    );

    const result = await readPreferencesFile();

    expect(result.defaultChatModelByProvider.claude.model).toBe('opus[1m]');
  });

  it('resolves a runtime fallback when the saved worktree model is unavailable', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          defaultWorktreeModelByProvider: {
            claude: { model: 'not-a-model', thinkingLevel: 'high' },
          },
        },
      }),
    );

    const result = await readPreferencesFile();

    expect(result.defaultWorktreeModelByProvider.claude.model).toBe('opus[1m]');
  });

  it('falls back to default when per-provider model is a number', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          defaultChatModelByProvider: {
            claude: { model: 42, thinkingLevel: 'high' },
          },
          defaultWorktreeModelByProvider: {
            claude: { model: 99, thinkingLevel: 'high' },
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.defaultChatModelByProvider.claude.model).toBe('opus[1m]');
    expect(result.defaultWorktreeModelByProvider.claude.model).toBe('opus[1m]');
  });

  it('accepts max for per-provider claude thinking level', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          defaultChatModelByProvider: {
            claude: { model: 'opus[1m]', thinkingLevel: 'max' },
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.defaultChatModelByProvider.claude.thinkingLevel).toBe('max');
  });

  it('falls back to high when per-provider thinking level is invalid', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          defaultWorktreeModelByProvider: {
            claude: { model: 'opus[1m]', thinkingLevel: 'hyper' },
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.defaultWorktreeModelByProvider.claude.thinkingLevel).toBe(
      'high',
    );
  });

  it('falls back to high when per-provider thinking level is a non-string type', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          defaultChatModelByProvider: {
            claude: { model: 'opus[1m]', thinkingLevel: true },
          },
          defaultWorktreeModelByProvider: {
            claude: { model: 'opus[1m]', thinkingLevel: 5 },
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.defaultChatModelByProvider.claude.thinkingLevel).toBe('high');
    expect(result.defaultWorktreeModelByProvider.claude.thinkingLevel).toBe(
      'high',
    );
  });

  it('accepts valid non-default per-provider model values', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          defaultChatModelByProvider: {
            claude: {
              model: 'claude-sonnet-4-6',
              thinkingLevel: 'high',
            },
          },
          defaultWorktreeModelByProvider: {
            claude: {
              model: 'claude-haiku-4-5-20251001',
              thinkingLevel: 'high',
            },
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.defaultChatModelByProvider.claude.model).toBe('sonnet');
    expect(result.defaultWorktreeModelByProvider.claude.model).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('accepts valid non-default per-provider thinking level values', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          defaultChatModelByProvider: {
            claude: { model: 'opus[1m]', thinkingLevel: 'high' },
          },
          defaultWorktreeModelByProvider: {
            claude: { model: 'opus[1m]', thinkingLevel: 'off' },
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.defaultChatModelByProvider.claude.thinkingLevel).toBe('high');
    expect(result.defaultWorktreeModelByProvider.claude.thinkingLevel).toBe(
      'off',
    );
  });

  it('accepts Codex model in per-provider codex slot', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          defaultChatModelByProvider: {
            codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.defaultChatModelByProvider.codex.model).toBe(
      DEFAULT_CODEX_MODEL,
    );
  });

  it('keeps gateway-only models out of the native Codex default slot', () => {
    expect(getExecutionHarnessForModel('deepseek-v4-pro')).toBe('codex');
    const result = normalizePreferences({
      defaultChatModelByProvider: {
        codex: { model: 'deepseek-v4-pro', thinkingLevel: 'medium' },
      },
    });

    expect(result.defaultChatModelByProvider.codex).toEqual({
      model: DEFAULT_CODEX_MODEL,
      thinkingLevel: 'medium',
    });
  });

  it('normalizes an AI Credits default by gateway routability', () => {
    const result = normalizePreferences({
      defaultChatModelByProvider: {
        aiCredits: { model: 'deepseek-v4-pro', thinkingLevel: 'medium' },
      },
    });
    expect(result.defaultChatModelByProvider.aiCredits).toEqual({
      model: 'deepseek-v4-pro',
      thinkingLevel: 'medium',
    });
  });

  it('preserves only valid last-resolved billing lanes', () => {
    expect(
      normalizePreferences({ lastResolvedDefaultLane: 'ai-credits' })
        .lastResolvedDefaultLane,
    ).toBe('ai-credits');
    expect(
      normalizePreferences({ lastResolvedDefaultLane: 'not-a-lane' })
        .lastResolvedDefaultLane,
    ).toBeUndefined();
  });

  it('seeds both per-scope lanes from a legacy scope-agnostic lane', () => {
    expect(
      normalizePreferences({ lastResolvedDefaultLane: 'ai-credits' })
        .lastResolvedDefaultLaneByScope,
    ).toEqual({ chat: 'ai-credits', worktree: 'ai-credits' });
  });

  it('keeps per-scope lanes independent and drops invalid ones', () => {
    expect(
      normalizePreferences({
        lastResolvedDefaultLane: 'ai-credits',
        lastResolvedDefaultLaneByScope: {
          chat: 'codex-native',
          worktree: 'not-a-lane',
        },
      }).lastResolvedDefaultLaneByScope,
    ).toEqual({ chat: 'codex-native', worktree: 'ai-credits' });
    expect(
      normalizePreferences({
        lastResolvedDefaultLaneByScope: { chat: 'claude-native' },
      }).lastResolvedDefaultLaneByScope,
    ).toEqual({ chat: 'claude-native' });
    expect(
      normalizePreferences({}).lastResolvedDefaultLaneByScope,
    ).toBeUndefined();
  });

  it('does not re-seed a scope the resolver deliberately erased (round-3 finding 13)', () => {
    // The resolver erases a lane it CONFIRMED unavailable from every scope at
    // once, while the scalar can survive holding a different lane. Re-seeding
    // an absent slot from that scalar undid half the erase on the very next
    // normalize, resurrecting a lane the user no longer has.
    expect(
      normalizePreferences({
        lastResolvedDefaultLane: 'claude-native',
        lastResolvedDefaultLaneByScope: { chat: 'claude-native' },
      }).lastResolvedDefaultLaneByScope,
    ).toEqual({ chat: 'claude-native' });
    // A FULLY erased map must survive as an empty-but-present marker. Dropping
    // the key made the erasure indistinguishable from "never had one", so the
    // next normalize took the migration path and re-seeded BOTH scopes from the
    // surviving scalar — resurrecting the very lane that was just erased.
    expect(
      normalizePreferences({
        lastResolvedDefaultLane: 'claude-native',
        lastResolvedDefaultLaneByScope: {},
      }).lastResolvedDefaultLaneByScope,
    ).toEqual({});
    // An ABSENT map is still a genuine migration source, not an erasure.
    expect(
      normalizePreferences({ lastResolvedDefaultLane: 'claude-native' })
        .lastResolvedDefaultLaneByScope,
    ).toEqual({ chat: 'claude-native', worktree: 'claude-native' });
  });

  it('does not resurrect a full erasure across a normalize round trip (round-5)', () => {
    // The concrete regression: the map holds one scope, the scalar holds a
    // DIFFERENT lane, and the resolver erases the one scope it confirmed dead.
    // Normalization runs on the write path too, so the empty map had to survive
    // that write or the next read re-seeded both scopes from the scalar.
    const erased = normalizePreferences({
      lastResolvedDefaultLane: 'ai-credits',
      lastResolvedDefaultLaneByScope: {},
    });
    expect(erased.lastResolvedDefaultLaneByScope).toEqual({});

    const reread = normalizePreferences({
      lastResolvedDefaultLane: erased.lastResolvedDefaultLane,
      lastResolvedDefaultLaneByScope: erased.lastResolvedDefaultLaneByScope,
    });
    expect(reread.lastResolvedDefaultLaneByScope).toEqual({});
    expect(reread.lastResolvedDefaultLaneByScope?.worktree).toBeUndefined();
    expect(reread.lastResolvedDefaultLaneByScope?.chat).toBeUndefined();
  });

  it('preserves the AI Credits automatic sentinel when the catalog is cold', () => {
    initAiGatewayModels([], []);
    const result = normalizePreferences({
      defaultChatModelByProvider: {
        aiCredits: { model: 'deepseek-v4-pro', thinkingLevel: 'medium' },
      },
    });
    expect(result.defaultChatModelByProvider.aiCredits).toBeNull();
    initializeTestModelRegistries();
  });

  it('resolves runtime fallbacks when persisted Ollama selections are unavailable', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        defaultChatModelByProvider: {
          claude: { model: 'opus[1m]', thinkingLevel: 'high' },
          codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
          ollama: {
            model: 'ollama-missing-local-model',
            thinkingLevel: 'high',
          },
        },
        defaultWorktreeModelByProvider: {
          claude: { model: 'opus[1m]', thinkingLevel: 'high' },
          codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
          ollama: {
            model: 'ollama-missing-local-model',
            thinkingLevel: 'high',
          },
        },
        summaryModel: 'ollama-missing-local-model',
        localMemoryModel: 'ollama-missing-local-model',
        worktreeSummaryModel: 'ollama-missing-local-model',
        prGenerationModel: 'ollama-missing-local-model',
        commitGenerationModel: 'ollama-missing-local-model',
        branchNamingModel: 'ollama-missing-local-model',
      }),
    );

    const result = await readPreferencesFile();

    expect(result.defaultChatModelByProvider.ollama).toBeNull();
    expect(result.defaultWorktreeModelByProvider.ollama).toBeNull();
    expect(result.summaryModel).toBe('gpt-6-luna');
    expect(result.localMemoryModel).toBe('gpt-6.1-sol');
    expect(result.worktreeSummaryModel).toBe('haiku');
    expect(result.prGenerationModel).toBe('sonnet');
    expect(result.commitGenerationModel).toBe('sonnet');
    expect(result.branchNamingModel).toBe('haiku');
  });

  it('keeps a chosen Ollama memory model while Ollama is unavailable', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        summaryModel: 'ollama-missing-local-model',
        summaryModelSetByUser: true,
        localMemoryModel: 'ollama-missing-local-model',
        localMemoryModelSetByUser: true,
      }),
    );

    const result = await readPreferencesFile();

    expect(result.localMemoryModel).toBe('ollama-missing-local-model');
    expect(result.localMemoryModelSetByUser).toBe(true);
    // Other model preferences keep their fallback.
    expect(result.summaryModel).toBe('gpt-6-luna');
    expect(result.summaryModelSetByUser).toBe(false);
  });

  it('normalizes aliased persisted ollama model defaults', () => {
    initModelAliases({ 'local-qwen': 'ollama-qwen3-coder' });
    try {
      const result = normalizePreferences({
        defaultChatModelByProvider: {
          ollama: {
            model: 'local-qwen',
            thinkingLevel: 'high',
          },
        },
      });

      expect(result.defaultChatModelByProvider.ollama?.model).toBe(
        'ollama-qwen3-coder',
      );
    } finally {
      initModelAliases({});
    }
  });

  it('falls back from persisted ollama defaults when ollama is build-disabled', () => {
    globalWithOllamaFlag.__CANOPY_OLLAMA_ENABLED__ = false;

    const result = normalizePreferences({
      defaultChatProvider: 'ollama',
      defaultChatModelByProvider: {
        claude: { model: 'opus[1m]', thinkingLevel: 'high' },
        codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
        ollama: { model: 'ollama-qwen3-coder', thinkingLevel: 'high' },
      },
      defaultWorktreeProvider: 'ollama',
      defaultWorktreeModelByProvider: {
        claude: { model: 'opus[1m]', thinkingLevel: 'high' },
        codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
        ollama: { model: 'ollama-qwen3-coder', thinkingLevel: 'high' },
      },
      summaryModel: 'ollama-qwen3-coder',
      worktreeSummaryModel: 'ollama-qwen3-coder',
      planDiagramModel: 'ollama-qwen3-coder',
      prGenerationModel: 'ollama-qwen3-coder',
      commitGenerationModel: 'ollama-qwen3-coder',
      branchNamingModel: 'ollama-qwen3-coder',
      appAdvisorModel: 'ollama-qwen3-coder',
      localMemoryModel: 'ollama-qwen3-coder',
    });

    expect(result.localMemoryModel).toBe('gpt-6.1-sol');
    expect(result.defaultChatProvider).toBe('claude');
    expect(result.defaultWorktreeProvider).toBe('claude');
    expect(result.defaultChatModelByProvider.ollama).toBeNull();
    expect(result.defaultWorktreeModelByProvider.ollama).toBeNull();
    expect(result.summaryModel).toBe('gpt-6-luna');
    expect(result.worktreeSummaryModel).toBe('haiku');
    expect(result.planDiagramModel).toBe('haiku');
    expect(result.prGenerationModel).toBe('sonnet');
    expect(result.commitGenerationModel).toBe('sonnet');
    expect(result.branchNamingModel).toBe('haiku');
    expect(result.appAdvisorModel).toBe(DEFAULT_CODEX_MODEL);
  });

  it('accepts Codex model for worktree codex slot', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          defaultWorktreeModelByProvider: {
            codex: { model: 'gpt-5.3-codex-spark', thinkingLevel: 'high' },
          },
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.defaultWorktreeModelByProvider.codex.model).toBe(
      'gpt-5.3-codex-spark',
    );
  });

  it('accepts Codex model for prGenerationModel', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          prGenerationModel: 'gpt-5.3-codex-spark',
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.prGenerationModel).toBe('gpt-5.3-codex-spark');
  });

  it('accepts Codex model for branchNamingModel', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          branchNamingModel: 'gpt-6-sol',
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.branchNamingModel).toBe(DEFAULT_CODEX_MODEL);
  });

  it('falls back to off when branchNamingThinkingLevel is invalid', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          branchNamingThinkingLevel: 'hyper',
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.branchNamingThinkingLevel).toBe('off');
  });

  it('migrates legacy auto thinking levels to high on load', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          worktreePanelPercent: 40,
          sidebarCollapsed: false,
          defaultChatModelByProvider: {
            claude: { model: 'opus[1m]', thinkingLevel: 'auto' },
          },
          defaultWorktreeModelByProvider: {
            claude: { model: 'opus[1m]', thinkingLevel: 'auto' },
          },
          summaryThinkingLevel: 'auto',
          worktreeSummaryThinkingLevel: 'auto',
          prGenerationThinkingLevel: 'auto',
          commitGenerationThinkingLevel: 'auto',
          branchNamingThinkingLevel: 'auto',
        },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.defaultChatModelByProvider.claude.thinkingLevel).toBe('high');
    expect(result.defaultWorktreeModelByProvider.claude.thinkingLevel).toBe(
      'high',
    );
    expect(result.summaryThinkingLevel).toBe('high');
    expect(result.worktreeSummaryThinkingLevel).toBe('high');
    expect(result.prGenerationThinkingLevel).toBe('high');
    expect(result.commitGenerationThinkingLevel).toBe('high');
    expect(result.branchNamingThinkingLevel).toBe('high');
  });

  it('clamps auditRetentionDays into the supported range', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ auditRetentionDays: 999 }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.auditRetentionDays).toBe(90);
  });

  it('clamps automation run retention into the supported range', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ automationRunRetentionDays: 999 }),
    );
    await expect(loadHandler()).resolves.toMatchObject({
      automationRunRetentionDays: 365,
    });
  });

  it('defaults missing codexAppServerIdleTimeoutMinutes to 10', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.codexAppServerIdleTimeoutMinutes).toBe(10);
  });

  it('rounds fractional codexAppServerIdleTimeoutMinutes values', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ codexAppServerIdleTimeoutMinutes: 12.6 }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.codexAppServerIdleTimeoutMinutes).toBe(13);
  });

  it('clamps codexAppServerIdleTimeoutMinutes below 1', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ codexAppServerIdleTimeoutMinutes: 0 }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.codexAppServerIdleTimeoutMinutes).toBe(1);
  });

  it('clamps codexAppServerIdleTimeoutMinutes above 120', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ codexAppServerIdleTimeoutMinutes: 999 }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.codexAppServerIdleTimeoutMinutes).toBe(120);
  });

  it.each([
    [undefined, 10],
    [12.6, 13],
    [0, 1],
    [999, 120],
  ])(
    'normalizes claudeSessionIdleTimeoutMinutes %p to %p',
    async (stored, expected) => {
      mockedReadFile.mockResolvedValue(
        makePrefsFile({ claudeSessionIdleTimeoutMinutes: stored }),
      );

      const result = (await loadHandler()) as PreferencesData;

      expect(result.claudeSessionIdleTimeoutMinutes).toBe(expected);
    },
  );

  it('defaults a non-numeric claudeSessionIdleTimeoutMinutes to 10', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { claudeSessionIdleTimeoutMinutes: '15' },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.claudeSessionIdleTimeoutMinutes).toBe(10);
  });

  it('defaults missing or invalid sidebar appearance to translucent', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const missingResult = expectPreferencesData(await loadHandler());

    expect(missingResult.sidebarAppearance).toBe('translucent');

    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { sidebarAppearance: 'unsupported' },
      }),
    );

    const invalidResult = expectPreferencesData(await loadHandler());

    expect(invalidResult.sidebarAppearance).toBe('translucent');
  });

  it('preserves a translucent sidebar appearance', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ sidebarAppearance: 'translucent' }),
    );

    const result = expectPreferencesData(await loadHandler());

    expect(result.sidebarAppearance).toBe('translucent');
  });

  it('preserves an explicitly selected opaque sidebar appearance', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ sidebarAppearance: 'opaque' }),
    );

    const result = expectPreferencesData(await loadHandler());

    expect(result.sidebarAppearance).toBe('opaque');
  });

  it('defaults missing or invalid worktree diff stats style to Short', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    expect(
      expectPreferencesData(await loadHandler()).worktreeDiffStatsStyle,
    ).toBe('short');

    mockedReadFile.mockResolvedValue(
      makeRawPrefsFile({ worktreeDiffStatsStyle: 'unsupported' }),
    );
    expect(
      expectPreferencesData(await loadHandler()).worktreeDiffStatsStyle,
    ).toBe('short');
  });

  it('preserves an explicitly selected Complete worktree diff stats style', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreeDiffStatsStyle: 'complete' }),
    );

    expect(
      expectPreferencesData(await loadHandler()).worktreeDiffStatsStyle,
    ).toBe('complete');
  });

  it('defaults missing or invalid scrollbar behavior to System', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    expect(expectPreferencesData(await loadHandler()).scrollbarBehavior).toBe(
      'system',
    );

    mockedReadFile.mockResolvedValue(
      makeRawPrefsFile({ scrollbarBehavior: 'unsupported' }),
    );
    expect(expectPreferencesData(await loadHandler()).scrollbarBehavior).toBe(
      'system',
    );
  });

  it.each(['always', 'scroll', 'hover', 'never'] as const)(
    'preserves the explicit %s scrollbar behavior',
    async (scrollbarBehavior) => {
      mockedReadFile.mockResolvedValue(makePrefsFile({ scrollbarBehavior }));
      expect(expectPreferencesData(await loadHandler()).scrollbarBehavior).toBe(
        scrollbarBehavior,
      );
    },
  );

  it('defaults missing or invalid dollar-sign math to on (CAN-5124)', async () => {
    mockedReadFile.mockResolvedValue(
      makeRawPrefsFile({ singleDollarMath: 'no' }),
    );
    expect(expectPreferencesData(await loadHandler()).singleDollarMath).toBe(
      true,
    );
  });

  it('keeps an explicit dollar-sign math choice (CAN-5124)', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ singleDollarMath: false }),
    );
    expect(expectPreferencesData(await loadHandler()).singleDollarMath).toBe(
      false,
    );
  });

  it('defaults chat enrichment to Linear Replace and GitHub Hover', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = expectPreferencesData(await loadHandler());

    expect(result.linearChatEnrichmentMode).toBe('replace');
    expect(result.githubChatEnrichmentMode).toBe('hover');
  });

  it.each([
    ['unsupported', 'off', 'replace', 'off'],
    ['hover', 7, 'hover', 'hover'],
    [null, 'replace', 'replace', 'replace'],
    ['off', undefined, 'off', 'hover'],
  ] as const)(
    'resolves saved chat enrichment modes independently (Linear %p, GitHub %p)',
    async (linearSaved, githubSaved, linearExpected, githubExpected) => {
      mockedReadFile.mockResolvedValue(
        makeRawPrefsFile({
          linearChatEnrichmentMode: linearSaved,
          githubChatEnrichmentMode: githubSaved,
        }),
      );

      const result = expectPreferencesData(await loadHandler());

      expect(result.linearChatEnrichmentMode).toBe(linearExpected);
      expect(result.githubChatEnrichmentMode).toBe(githubExpected);
    },
  );

  it('saves one chat enrichment mode without resetting the other or unrelated preferences', async () => {
    mockedReadFile.mockResolvedValue(
      makeRawPrefsFile({
        linearChatEnrichmentMode: 'hover',
        githubChatEnrichmentMode: 'off',
        scrollbarBehavior: 'never',
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = expectPreferencesData(
      await saveHandler({}, { githubChatEnrichmentMode: 'replace' }),
    );

    expect(result.linearChatEnrichmentMode).toBe('hover');
    expect(result.githubChatEnrichmentMode).toBe('replace');
    expect(result.scrollbarBehavior).toBe('never');
    const written = findPreferencesWriteContent();
    expect(written).toContain('"linearChatEnrichmentMode": "hover"');
    expect(written).toContain('"githubChatEnrichmentMode": "replace"');
  });

  it('drops the removed sidebar project layout preference on load', async () => {
    // The compact layout was removed; persisted files that still carry the
    // key are normalized without it instead of failing.
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { sidebarWorkspaceLayout: 'compact' },
      }),
    );

    const result = expectPreferencesData(await loadHandler());

    expect('sidebarWorkspaceLayout' in result).toBe(false);
  });

  it('defaults missing performance concurrency limits', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.maxActiveChatTurns).toBe(10);
    expect(result.maxActivePipelineExecutions).toBe(5);
  });

  it('preserves disabled performance concurrency limits', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        maxActiveChatTurns: null,
        maxActivePipelineExecutions: null,
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.maxActiveChatTurns).toBeNull();
    expect(result.maxActivePipelineExecutions).toBeNull();
  });

  it('normalizes performance concurrency limits into the supported range', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        maxActiveChatTurns: 0,
        maxActivePipelineExecutions: 101.4,
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.maxActiveChatTurns).toBe(1);
    expect(result.maxActivePipelineExecutions).toBe(100);
  });

  it('defaults missing memory pressure guard settings', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.memoryPressureGuardEnabled).toBe(false);
    expect(result.bypassCodexAppServerIdleTimeoutUnderCriticalPressure).toBe(
      true,
    );
    expect(result.memoryPressureWarningThresholdBytes).toBe(
      2 * 1024 * 1024 * 1024,
    );
    expect(result.memoryPressureCriticalThresholdBytes).toBe(
      4 * 1024 * 1024 * 1024,
    );
  });

  it('normalizes the critical-pressure idle-timeout bypass preference', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        bypassCodexAppServerIdleTimeoutUnderCriticalPressure: false,
      }),
    );

    const result = expectPreferencesData(await loadHandler());

    expect(result.bypassCodexAppServerIdleTimeoutUnderCriticalPressure).toBe(
      false,
    );
  });

  it('defaults missing keep-awake preference to true', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.keepSystemAwakeWhileAgentsActive).toBe(true);
  });

  it('normalizes invalid keep-awake preference to true', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ keepSystemAwakeWhileAgentsActive: 'yes' } as never),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.keepSystemAwakeWhileAgentsActive).toBe(true);
  });

  it('normalizes memory pressure guard thresholds', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        memoryPressureGuardEnabled: false,
        memoryPressureWarningThresholdBytes: 1.6,
        memoryPressureCriticalThresholdBytes: 5.4,
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.memoryPressureGuardEnabled).toBe(false);
    expect(result.memoryPressureWarningThresholdBytes).toBe(2);
    expect(result.memoryPressureCriticalThresholdBytes).toBe(5);
  });

  it('falls back to default memory pressure thresholds when critical is not above warning', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        memoryPressureWarningThresholdBytes: 4 * 1024 * 1024 * 1024,
        memoryPressureCriticalThresholdBytes: 2 * 1024 * 1024 * 1024,
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.memoryPressureWarningThresholdBytes).toBe(
      2 * 1024 * 1024 * 1024,
    );
    expect(result.memoryPressureCriticalThresholdBytes).toBe(
      4 * 1024 * 1024 * 1024,
    );
  });

  it('falls back to the default terminal drawer tab when the saved tab id is unknown', async () => {
    mockedReadFile.mockResolvedValue(
      makeRawPrefsFile({ terminalDrawerActiveTabId: 'logs' }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.terminalDrawerActiveTabId).toBe('terminal');
  });

  it('normalizes Terminal shell visibility and command presets', async () => {
    mockedReadFile.mockResolvedValue(
      makeRawPrefsFile({
        disabledTerminalShellProfileIds: ['bash', 'bash', 'unknown-shell'],
        terminalPresets: [
          {
            id: 'status',
            name: '  Project status  ',
            terminalProfileId: 'zsh',
            command: '  git status --short  ',
            enabled: true,
            icon: { kind: 'character', value: '★' },
          },
          {
            id: 'themed-tui',
            name: 'Custom TUI',
            terminalProfileId: 'zsh',
            command: 'lazygit',
            enabled: true,
            icon: {
              kind: 'image',
              lightDataUrl: 'data:image/png;base64,bGlnaHQ=',
              darkDataUrl: 'data:image/svg+xml;base64,ZGFyaw==',
            },
          },
          {
            id: 'legacy-image',
            name: 'Legacy image',
            terminalProfileId: 'bash',
            command: 'htop',
            enabled: true,
            icon: {
              kind: 'image',
              dataUrl: 'data:image/png;base64,bGVnYWN5',
            },
          },
          {
            id: 'broken',
            name: '',
            terminalProfileId: 'nope',
            command: '',
            enabled: true,
          },
        ],
      }),
    );

    const result = expectPreferencesData(await loadHandler());

    expect(result.disabledTerminalShellProfileIds).toEqual(['bash']);
    expect(result.terminalPresets).toEqual([
      {
        id: 'status',
        name: 'Project status',
        terminalProfileId: 'zsh',
        command: 'git status --short',
        enabled: true,
        icon: { kind: 'character', value: '★' },
      },
      {
        id: 'themed-tui',
        name: 'Custom TUI',
        terminalProfileId: 'zsh',
        command: 'lazygit',
        enabled: true,
        icon: {
          kind: 'image',
          lightDataUrl: 'data:image/png;base64,bGlnaHQ=',
          darkDataUrl: 'data:image/svg+xml;base64,ZGFyaw==',
        },
      },
      {
        id: 'legacy-image',
        name: 'Legacy image',
        terminalProfileId: 'bash',
        command: 'htop',
        enabled: true,
        icon: {
          kind: 'image',
          lightDataUrl: 'data:image/png;base64,bGVnYWN5',
        },
      },
    ]);
  });

  it('returns null windowBounds when not present', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowBounds).toBeNull();
    expect(result.windowMaximized).toBe(false);
    expect(result.windowFullScreen).toBe(false);
  });

  it('preserves valid windowBounds', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        windowBounds: { x: 100, y: 200, width: 1400, height: 900 },
        windowMaximized: false,
        windowFullScreen: false,
      }),
    );
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowBounds).toEqual({
      x: 100,
      y: 200,
      width: 1400,
      height: 900,
    });
  });

  it('returns null windowBounds when width is below minimum', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        windowBounds: { x: 0, y: 0, width: 400, height: 600 },
      }),
    );
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowBounds).toBeNull();
  });

  it('returns null windowBounds when height is below minimum', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        windowBounds: { x: 0, y: 0, width: 1000, height: 300 },
      }),
    );
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowBounds).toBeNull();
  });

  it('returns null windowBounds when fields are non-numeric', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: {
          windowBounds: { x: 'foo', y: 0, width: 1000, height: 600 },
        },
      }),
    );
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowBounds).toBeNull();
  });

  it('returns null windowBounds when fields contain Infinity', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        windowBounds: { x: 0, y: 0, width: Infinity, height: 600 },
      }),
    );
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowBounds).toBeNull();
  });

  it('returns null windowBounds when value is a string', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { windowBounds: 'not-an-object' },
      }),
    );
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowBounds).toBeNull();
  });

  it('preserves windowMaximized true', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ windowMaximized: true }));
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowMaximized).toBe(true);
  });

  it('preserves windowFullScreen true', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ windowFullScreen: true }));
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowFullScreen).toBe(true);
  });

  it('defaults windowMaximized to false for non-boolean value', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, preferences: { windowMaximized: 'yes' } }),
    );
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowMaximized).toBe(false);
  });

  it('defaults windowFullScreen to false for non-boolean value', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, preferences: { windowFullScreen: 42 } }),
    );
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowFullScreen).toBe(false);
  });

  it('accepts negative coordinates for multi-monitor setups', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        windowBounds: { x: -500, y: -200, width: 1200, height: 800 },
      }),
    );
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowBounds).toEqual({
      x: -500,
      y: -200,
      width: 1200,
      height: 800,
    });
  });

  it('accepts minimum valid dimensions', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        windowBounds: { x: 0, y: 0, width: 800, height: 500 },
      }),
    );
    const result = (await loadHandler()) as PreferencesData;
    expect(result.windowBounds).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 500,
    });
  });

  it('defaults missing split PR preferences', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.splitPrThresholdLines).toBe(500);
    expect(result.splitPrEnabled).toBe(true);
    expect(result.splitPrPlannerModel).toBe(DEFAULT_CODEX_MODEL);
    expect(result.splitPrPlannerThinkingLevel).toBe('high');
  });

  it('clamps splitPrThresholdLines below 50 to 50', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ splitPrThresholdLines: 49 }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.splitPrThresholdLines).toBe(50);
  });

  it('clamps splitPrThresholdLines above 100_000 to 100_000', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ splitPrThresholdLines: 200_000 }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.splitPrThresholdLines).toBe(100_000);
  });

  it('defaults splitPrThresholdLines to 500 when NaN', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { splitPrThresholdLines: Number.NaN },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.splitPrThresholdLines).toBe(500);
  });

  it('defaults splitPrThresholdLines to 500 when a string', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { splitPrThresholdLines: 'lots' },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.splitPrThresholdLines).toBe(500);
  });

  it('coerces splitPrEnabled to a boolean, defaulting to true', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ splitPrEnabled: false }));

    const result = (await loadHandler()) as PreferencesData;

    expect(result.splitPrEnabled).toBe(false);

    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { splitPrEnabled: 'not-a-boolean' },
      }),
    );
    resetPreferencesLoadErrorForTests();

    const result2 = (await loadHandler()) as PreferencesData;

    expect(result2.splitPrEnabled).toBe(true);
  });

  it('accepts Codex model for splitPrPlannerModel', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ splitPrPlannerModel: 'gpt-5.3-codex-spark' }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.splitPrPlannerModel).toBe('gpt-5.3-codex-spark');
  });

  it('resolves a runtime fallback when splitPrPlannerModel is unavailable', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ splitPrPlannerModel: 'ollama-missing-local-model' }),
    );

    const result = await readPreferencesFile();

    expect(result.splitPrPlannerModel).toBe(DEFAULT_CODEX_MODEL);
  });

  it('falls back to high when splitPrPlannerThinkingLevel is invalid', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { splitPrPlannerThinkingLevel: 'hyper' },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.splitPrPlannerThinkingLevel).toBe('high');
  });

  it('migrates legacy auto splitPrPlannerThinkingLevel to high on load', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        preferences: { splitPrPlannerThinkingLevel: 'auto' },
      }),
    );

    const result = (await loadHandler()) as PreferencesData;

    expect(result.splitPrPlannerThinkingLevel).toBe('high');
  });
});

describe('memoryDiagnosticsEnabled preference', () => {
  it('defaults to disabled', () => {
    expect(DEFAULT_PREFERENCES.memoryDiagnosticsEnabled).toBe(false);
    expect(normalizePreferences({}).memoryDiagnosticsEnabled).toBe(false);
  });

  it('loads a stored true value', async () => {
    mockedReadFile.mockResolvedValue(
      makeRawPrefsFile({ memoryDiagnosticsEnabled: true }),
    );

    const loaded = expectPreferencesData(await loadHandler());

    expect(loaded.memoryDiagnosticsEnabled).toBe(true);
  });

  it('normalizes a non-boolean stored value to false', async () => {
    mockedReadFile.mockResolvedValue(
      makeRawPrefsFile({ memoryDiagnosticsEnabled: 'enabled' }),
    );

    const loaded = expectPreferencesData(await loadHandler());

    expect(loaded.memoryDiagnosticsEnabled).toBe(false);
  });

  it('applies the normalized saved value to the service', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { memoryDiagnosticsEnabled: true });

    expect(memoryDiagnosticsSetEnabledMock).toHaveBeenCalledWith(true);
  });

  it('a stalled save never broadcasts over a later onboarding tip dismissal (CAN-4904)', async () => {
    let persisted = makePrefsFile({});
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_filePath, data) => {
      if (typeof data === 'string') persisted = data;
      return Promise.resolve();
    });
    const windows = jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([new BrowserWindow()]);
    let releaseSave: () => void = () => undefined;
    syncOnboardingProfilePreferencesMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );
    try {
      // A renderer save commits, then stalls in its post-commit profile sync.
      const save = saveHandler({}, { colorMode: 'dark' });
      for (
        let attempt = 0;
        attempt < 100 &&
        syncOnboardingProfilePreferencesMock.mock.calls.length < 1;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await findRegisteredHandler('preferences:update-onboarding-tips')(
        {},
        { action: 'dismiss', tipId: 'workflows' },
      );
      releaseSave();
      await save;
      const synced = mockedSendToWindow.mock.calls.filter(
        ([, channel]) => channel === 'preferences:synced',
      );
      const last = synced.at(-1)?.[2];
      expect(
        expectPreferencesData(last).onboardingTipsDismissed.workflows,
      ).toEqual(expect.any(String));
    } finally {
      windows.mockRestore();
    }
  });

  it('applies overlapping saves in commit order', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    memoryDiagnosticsSetEnabledMock.mockClear();
    let releaseEnableSave: () => void = () => undefined;
    syncOnboardingProfilePreferencesMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseEnableSave = resolve;
        }),
    );

    // The enable save commits, then stalls in its post-commit profile sync.
    const enableSave = saveHandler({}, { memoryDiagnosticsEnabled: true });
    for (
      let attempt = 0;
      attempt < 100 &&
      syncOnboardingProfilePreferencesMock.mock.calls.length < 1;
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(syncOnboardingProfilePreferencesMock).toHaveBeenCalledTimes(1);

    await saveHandler({}, { memoryDiagnosticsEnabled: false });
    releaseEnableSave();
    await enableSave;

    expect(memoryDiagnosticsSetEnabledMock).toHaveBeenLastCalledWith(false);
  });
});

describe('save handler', () => {
  it.each([true, false])(
    'A3: ignores global approval rules in a generic save (stored grant: %s)',
    async (storedGrant) => {
      const rule = {
        id: 'R',
        behavior: 'allow' as const,
        origin: 'prompt' as const,
        createdAt: '2026-10-27T00:00:00.000Z',
        target: { kind: 'file-write' as const, path: 'allowed/**' },
      };
      const rules = storedGrant ? [rule] : [];
      mockedReadFile.mockResolvedValue(
        makePrefsFile({ globalApprovalRules: rules }),
      );
      const result = expectPreferencesData(
        await saveHandler(
          {},
          {
            globalApprovalRules: storedGrant ? [] : [rule],
            sidebarCollapsed: true,
          },
        ),
      );
      expect(result.globalApprovalRules).toEqual(rules);
      expect(result.sidebarCollapsed).toBe(true);
      expect(JSON.parse(findPreferencesWriteContent() ?? '{}')).toMatchObject({
        preferences: { globalApprovalRules: rules, sidebarCollapsed: true },
      });
    },
  );

  it('persists a chat detail change and back, keeping other preferences', async () => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    const windows = jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([new BrowserWindow()]);
    try {
      mockedReadFile.mockResolvedValue(
        makePrefsFile({ colorMode: 'dark', worktreePanelPercent: 40 }),
      );
      const enabled = expectPreferencesData(
        await saveHandler({}, { chatDetail: 'compact' }),
      );
      expect(enabled.chatDetail).toBe('compact');
      const enabledWrite = findPreferencesWriteContent();
      if (enabledWrite === null) {
        throw new Error('Expected preferences write content.');
      }
      expect(
        (JSON.parse(enabledWrite) as PreferencesFile).preferences,
      ).toMatchObject({
        chatDetail: 'compact',
        colorMode: 'dark',
        worktreePanelPercent: 40,
      });

      mockedWriteFile.mockClear();
      mockedRename.mockClear();
      mockedSendToWindow.mockClear();
      mockedReadFile.mockResolvedValue(enabledWrite);
      const disabled = expectPreferencesData(
        await saveHandler({}, { chatDetail: 'detailed' }),
      );
      expect(disabled.chatDetail).toBe('detailed');
      expect(disabled.colorMode).toBe('dark');
      const disabledWrite = findPreferencesWriteContent();
      if (disabledWrite === null) {
        throw new Error('Expected preferences write content.');
      }
      expect(
        (JSON.parse(disabledWrite) as PreferencesFile).preferences,
      ).toMatchObject({
        chatDetail: 'detailed',
        colorMode: 'dark',
        worktreePanelPercent: 40,
      });
      expect(mockedSendToWindow).toHaveBeenCalledWith(
        expect.anything(),
        'preferences:synced',
        expect.objectContaining({ chatDetail: 'detailed' }),
      );
    } finally {
      windows.mockRestore();
    }
  });

  it.each(['1.9.0', 'v1.10.0-rc.2', 'internal-123', null])(
    'preserves newer stored release history against a stale %s save',
    async (version) => {
      let persisted = makePrefsFile({
        releaseHighlightsLastSeenVersion: '1.10.0',
      });
      mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockImplementation((_path, data) => {
        if (typeof data === 'string') persisted = data;
        return Promise.resolve();
      });
      expect(
        await saveHandler(
          {},
          { releaseHighlightsLastSeenVersion: version, theme: 'ocean' },
        ),
      ).toMatchObject({
        releaseHighlightsLastSeenVersion: '1.10.0',
        theme: 'ocean',
      });
      expect(await readPreferencesFile()).toMatchObject({
        releaseHighlightsLastSeenVersion: '1.10.0',
        theme: 'ocean',
      });
    },
  );

  it('preserves the greatest release version across competing partial saves', async () => {
    let persisted = makePrefsFile({
      releaseHighlightsLastSeenVersion: '1.8.0',
    });
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_path, data) => {
      if (typeof data === 'string') persisted = data;
      return Promise.resolve();
    });
    await Promise.all([
      saveHandler({}, { releaseHighlightsLastSeenVersion: '1.10.0' }),
      saveHandler({}, { releaseHighlightsLastSeenVersion: '1.9.0' }),
    ]);
    expect(await readPreferencesFile()).toHaveProperty(
      'releaseHighlightsLastSeenVersion',
      '1.10.0',
    );
  });

  it('merges release history and unrelated partial saves durably', async () => {
    let persisted = makePrefsFile({ theme: 'default' });
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_filePath, data) => {
      if (typeof data === 'string') persisted = data;
      return Promise.resolve();
    });
    const [history, appearance] = await Promise.all([
      saveHandler({}, { releaseHighlightsLastSeenVersion: ' 1.9.0 ' }),
      saveHandler({}, { theme: 'ocean' }),
    ]);
    expect(history).toHaveProperty('releaseHighlightsLastSeenVersion', '1.9.0');
    expect(appearance).toHaveProperty(
      'releaseHighlightsLastSeenVersion',
      '1.9.0',
    );
    expect(await readPreferencesFile()).toMatchObject({
      releaseHighlightsLastSeenVersion: '1.9.0',
      theme: 'ocean',
    });
  });

  it('rejects a failed answer commit without enabling notifications and accepts a retry', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ colorMode: 'dark' }));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRename.mockRejectedValueOnce(new Error('answer commit failed'));
    const answer = {
      osNotificationOfferAnsweredAt: '2026-09-01T12:00:00.000Z',
    };
    await expect(saveHandler({}, answer)).rejects.toThrow(
      'answer commit failed',
    );
    const retry = expectPreferencesData(await saveHandler({}, answer));
    expect(retry.osNotificationOfferAnsweredAt).toBe(
      answer.osNotificationOfferAnsweredAt,
    );
    expect(retry.osNotifications.enabled).toBe(false);
    expect(retry.colorMode).toBe('dark');
  });

  it('resolves and broadcasts while the catalog follow-up is blocked', async (): Promise<void> => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ personalWorkspaceCatalogSync: 'off' }),
    );
    let unblock: (() => void) | undefined;
    let completed = false;
    const blocked = new Promise<void>((resolve): void => {
      unblock = resolve;
    });
    jest
      .mocked(personalCatalogPreferenceChanged)
      .mockImplementationOnce(async (): Promise<void> => {
        await blocked;
        completed = true;
      });
    const windows = jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([new BrowserWindow()]);
    let resolved = false;
    const saving = saveHandler(
      {},
      { personalWorkspaceCatalogSync: 'private' },
    ).then((): void => {
      resolved = true;
    });
    try {
      await new Promise<void>((resolve): void => {
        setImmediate(resolve);
      });
      expect(personalCatalogPreferenceChanged).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(true);
      expect(mockedSendToWindow).toHaveBeenCalledWith(
        expect.anything(),
        'preferences:synced',
        expect.objectContaining({ personalWorkspaceCatalogSync: 'private' }),
      );
      expect(completed).toBe(false);
    } finally {
      unblock?.();
      await saving;
      windows.mockRestore();
    }
    expect(completed).toBe(true);
  });

  it('broadcasts a committed enrollment even when catalog follow-up rejects', async (): Promise<void> => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ personalWorkspaceCatalogSync: 'off' }),
    );
    jest
      .mocked(personalCatalogPreferenceChanged)
      .mockRejectedValueOnce(new Error('marker unavailable'));
    const windows = jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([new BrowserWindow()]);
    await expect(
      saveHandler({}, { personalWorkspaceCatalogSync: 'private' }),
    ).resolves.toMatchObject({ personalWorkspaceCatalogSync: 'private' });
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      expect.anything(),
      'preferences:synced',
      expect.objectContaining({ personalWorkspaceCatalogSync: 'private' }),
    );
    windows.mockRestore();
  });

  it('revokes OpenCode runtimes and updates destinations when disabled through preferences', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ opencodeEnabled: true }));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    await saveHandler({}, { opencodeEnabled: false });
    expect(mockRevokeOpenCodeRuntimes).toHaveBeenCalledTimes(1);
    expect(mockBroadcastModelRegistryUpdated).toHaveBeenCalledTimes(1);
    expect(mockNotifyPortalStructureChanged).toHaveBeenCalledTimes(1);
  });

  it('withdraws cached Cursor destinations when the preference is disabled', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ cursorEnabled: true }));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    initCursorModels([
      { id: 'cursor:shared', rawModelId: 'shared', label: 'Shared' },
    ]);
    try {
      await saveHandler({}, { cursorEnabled: false });
      expect(getCursorModelEntries()).toEqual([]);
      expect(mockInvalidateCursorModels).toHaveBeenCalledTimes(1);
      // Portal projects `providerAvailability.cursor` from the cached
      // preflight, so disabling the preference must refresh it before the
      // registry broadcast rather than leave a stale "connected" hint.
      expect(mockRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(1);
      expect(mockBroadcastModelRegistryUpdated).toHaveBeenCalledTimes(1);
      // `broadcastModelRegistryUpdated` only reaches desktop renderer
      // windows; an already-open Portal session needs this separate push or
      // it keeps rendering Cursor as available until an unrelated event
      // re-projects the chat summaries (CAN-3624 multi-model review finding).
      expect(mockNotifyPortalStructureChanged).toHaveBeenCalledTimes(1);
    } finally {
      initCursorModels([]);
    }
  });

  it('refreshes and notifies Portal when the preference is re-enabled through this generic path too, without touching the model catalog', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ cursorEnabled: false }));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { cursorEnabled: true });

    // Re-enabling here (distinct from the Connect flow, which populates the
    // catalog itself) has no discovered models to withdraw or restore, so
    // this path must not touch `invalidateCursorModels`/`initCursorModels`.
    expect(mockInvalidateCursorModels).not.toHaveBeenCalled();
    // A stale cached availability=false must not linger if this generic path
    // — the same one `harnesses-settings.spec.mjs` proves is reachable for
    // disabling — is later used to re-enable outside of Connect.
    expect(mockRefreshCursorRuntimeAvailability).toHaveBeenCalledTimes(1);
    expect(mockBroadcastModelRegistryUpdated).toHaveBeenCalledTimes(1);
    expect(mockNotifyPortalStructureChanged).toHaveBeenCalledTimes(1);
  });

  it('does not refresh or notify when cursorEnabled is unchanged', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ cursorEnabled: true }));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { cursorEnabled: true });

    expect(mockInvalidateCursorModels).not.toHaveBeenCalled();
    expect(mockRefreshCursorRuntimeAvailability).not.toHaveBeenCalled();
    expect(mockBroadcastModelRegistryUpdated).not.toHaveBeenCalled();
    expect(mockNotifyPortalStructureChanged).not.toHaveBeenCalled();
  });

  it('re-syncs the OS focus shortcut registration when a save changes it', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { globalFocusShortcut: 'CommandOrControl+Shift+K' });

    expect(syncGlobalFocusShortcutFromPreferencesMock).toHaveBeenCalledTimes(1);
    expect(syncGlobalFocusShortcutFromPreferencesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        globalFocusShortcut: 'CommandOrControl+Shift+K',
      }),
    );

    syncGlobalFocusShortcutFromPreferencesMock.mockClear();
    await saveHandler({}, { globalFocusShortcutEnabled: true });

    expect(syncGlobalFocusShortcutFromPreferencesMock).toHaveBeenCalledWith(
      expect.objectContaining({ globalFocusShortcutEnabled: true }),
    );
  });

  it('leaves the OS focus shortcut registration alone when a save does not touch it', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { theme: 'ocean' });

    expect(syncGlobalFocusShortcutFromPreferencesMock).not.toHaveBeenCalled();
  });

  it('keeps a persisted save successful when the focus shortcut re-sync fails', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    syncGlobalFocusShortcutFromPreferencesMock.mockRejectedValueOnce(
      new Error('registrar unavailable'),
    );

    await expect(
      saveHandler({}, { globalFocusShortcut: 'CommandOrControl+Shift+K' }),
    ).resolves.toMatchObject({
      globalFocusShortcut: 'CommandOrControl+Shift+K',
    });
    expect(mockedWriteFile).toHaveBeenCalled();
  });

  it('reconciles OS browser registration without failing the saved preference', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { useAsSystemDefaultBrowser: true });

    expect(applyDefaultBrowserRegistrationMock).toHaveBeenCalledWith({
      enabled: true,
      promptForWindowsSettings: true,
    });

    applyDefaultBrowserRegistrationMock.mockRejectedValueOnce(
      new Error('registration refused'),
    );
    await expect(
      saveHandler({}, { useAsSystemDefaultBrowser: true }),
    ).resolves.toMatchObject({ useAsSystemDefaultBrowser: true });
  });

  it('leaves OS browser registration alone when only app-link routing changes', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await expect(
      saveHandler({}, { openAppLinksInBuiltInBrowser: true }),
    ).resolves.toMatchObject({
      openAppLinksInBuiltInBrowser: true,
      useAsSystemDefaultBrowser: false,
    });
    await expect(
      saveHandler({}, { openAppLinksInBuiltInBrowser: false }),
    ).resolves.toMatchObject({ openAppLinksInBuiltInBrowser: false });

    expect(applyDefaultBrowserRegistrationMock).not.toHaveBeenCalled();
  });

  it('serializes opposite browser-registration saves in commit order', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    let releaseEnable: () => void = () => undefined;
    const enableGate = new Promise<void>((resolve) => {
      releaseEnable = resolve;
    });
    applyDefaultBrowserRegistrationMock
      .mockImplementationOnce(() => enableGate)
      .mockResolvedValue({
        enabled: false,
        registered: false,
        platform: 'darwin',
      });

    const enableSave = saveHandler(
      {},
      {
        useAsSystemDefaultBrowser: true,
      },
    );
    for (
      let attempt = 0;
      attempt < 50 && applyDefaultBrowserRegistrationMock.mock.calls.length < 1;
      attempt += 1
    ) {
      await Promise.resolve();
    }
    expect(applyDefaultBrowserRegistrationMock).toHaveBeenCalledTimes(1);

    const disableSave = saveHandler({}, { useAsSystemDefaultBrowser: false });
    for (
      let attempt = 0;
      attempt < 100 && mockedWriteFile.mock.calls.length < 4;
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockedWriteFile.mock.calls.length).toBeGreaterThanOrEqual(4);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(applyDefaultBrowserRegistrationMock).toHaveBeenCalledTimes(1);

    releaseEnable();
    await Promise.all([enableSave, disableSave]);

    expect(applyDefaultBrowserRegistrationMock.mock.calls).toEqual([
      [{ enabled: true, promptForWindowsSettings: true }],
      [{ enabled: false, promptForWindowsSettings: false }],
    ]);
  });

  it('reconciles only when the effective Code Graph project set changes', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler(
      {},
      {
        codeGraph: {
          mode: 'selected-workspaces',
          selectedWorkspaceIds: ['workspace-b', 'workspace-a'],
          generationTimeoutMinutes: 45,
        },
      },
    );

    expect(cachedCodeGraphPreferences).toEqual({
      mode: 'selected-workspaces',
      selectedWorkspaceIds: ['workspace-b', 'workspace-a'],
      generationTimeoutMinutes: 45,
    });
    expect(reconcileCodeGraphAvailabilityMock).toHaveBeenCalledTimes(1);
  });

  it('updates a timeout-only Code Graph save without lifecycle reconciliation', async () => {
    const codeGraph: CodeGraphPreferences = {
      mode: 'selected-workspaces',
      selectedWorkspaceIds: ['workspace-a', 'workspace-b'],
      generationTimeoutMinutes: 30,
    };
    cachedCodeGraphPreferences = codeGraph;
    mockedReadFile.mockResolvedValue(makePrefsFile({ codeGraph }));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler(
      {},
      {
        codeGraph: {
          ...codeGraph,
          selectedWorkspaceIds: ['workspace-b', 'workspace-a'],
          generationTimeoutMinutes: 90,
        },
      },
    );

    expect(cachedCodeGraphPreferences.generationTimeoutMinutes).toBe(90);
    expect(reconcileCodeGraphAvailabilityMock).not.toHaveBeenCalled();
  });

  it('re-projects Default-model Agent rows when a default-model setting is saved', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { defaultChatProvider: 'codex' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockRefreshCatalogAgentDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ defaultChatProvider: 'codex' }),
    );
  });

  it('keeps a persisted save successful when Code Graph reconciliation fails', async () => {
    jest.useFakeTimers();
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    reconcileCodeGraphAvailabilityMock.mockRejectedValueOnce(
      new Error('transient sidebar read failure'),
    );
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      await expect(
        saveHandler(
          {},
          {
            codeGraph: {
              mode: 'disabled',
              selectedWorkspaceIds: [],
              generationTimeoutMinutes: 30,
            },
          },
        ),
      ).resolves.toMatchObject({ codeGraph: { mode: 'disabled' } });
      expect(wakeLockSetEnabledMock).toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to reconcile Code Graph availability:',
        expect.any(Error),
      );
      reconcileCodeGraphAvailabilityMock.mockResolvedValue(undefined);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(reconcileCodeGraphAvailabilityMock).toHaveBeenCalledTimes(2);
    } finally {
      resetCodeGraphReconciliationRetryForTests();
      jest.useRealTimers();
      consoleError.mockRestore();
    }
  });

  it('deduplicates and bounds failed Code Graph reconciliation retries', async () => {
    jest.useFakeTimers();
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    reconcileCodeGraphAvailabilityMock.mockRejectedValue(
      new Error('transient sidebar read failure'),
    );
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      await saveHandler(
        {},
        {
          codeGraph: {
            mode: 'disabled',
            selectedWorkspaceIds: [],
            generationTimeoutMinutes: 30,
          },
        },
      );
      await saveHandler(
        {},
        {
          codeGraph: {
            mode: 'selected-workspaces',
            selectedWorkspaceIds: ['workspace-a'],
            generationTimeoutMinutes: 30,
          },
        },
      );
      await jest.advanceTimersByTimeAsync(1_000 + 5_000 + 30_000);

      expect(reconcileCodeGraphAvailabilityMock).toHaveBeenCalledTimes(5);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      resetCodeGraphReconciliationRetryForTests();
      jest.useRealTimers();
      consoleError.mockRestore();
    }
  });

  it('merges with existing preferences and normalizes', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: 40, sidebarCollapsed: false }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await saveHandler({}, { sidebarCollapsed: true });

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 40,
      sidebarCollapsed: true,
    });

    expect(mockedWriteFile).toHaveBeenCalledTimes(2);
    const rawWrittenContent = findPreferencesWriteContent();
    if (rawWrittenContent === null) {
      throw new Error('Expected preferences write content.');
    }
    const writtenContent = JSON.parse(rawWrittenContent) as PreferencesFile;
    expect(writtenContent.version).toBe(1);
    expect(writtenContent.preferences).toEqual({
      disabledInstalledItems: [],
      parkedCodexPlugins: [],
      pendingInstalledItemUninstalls: [],
      cursorEnabled: false,
      copilotEnabled: false,
      opencodeEnabled: false,
      accountProxyEnabled: false,
      accountProxyConnection: null,
      accountProxyKeepChatOnOneAccount: true,
      accountProxyRouteClaude: true,
      accountProxyRouteCodex: true,
      accountProxyLocalStartWithApp: true,
      orgProjectCloneProtocol: 'https',
      cursorAgentPath: '',
      ...NEW_DEFAULTS,
      worktreePanelPercent: 40,
      sidebarCollapsed: true,
    });
    expect(wakeLockSetEnabledMock).toHaveBeenCalledWith(true);
  });

  it.each([undefined, true, false])(
    'omits the retired shortcut preference through load/save/reload (legacy %s)',
    async (enabled) => {
      const raw: Record<string, unknown> = { uiScale: 150 };
      if (enabled !== undefined) {
        raw.interfaceScaleShortcutsEnabled = enabled;
      }
      mockedReadFile.mockResolvedValue(makeRawPrefsFile(raw));
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const loaded = await readPreferencesFile();
      expect(loaded).not.toHaveProperty('interfaceScaleShortcutsEnabled');
      expect(loaded.uiScale).toBe(150);
      expect(mockedWriteFile).not.toHaveBeenCalled();
      expect(mockedWriteFileAtomically).not.toHaveBeenCalled();

      // An older client can send the retired field; normal saves drop it too.
      const saved = await saveHandler(
        {},
        {
          sidebarCollapsed: true,
          interfaceScaleShortcutsEnabled: enabled,
        },
      );
      expect(saved).not.toHaveProperty('interfaceScaleShortcutsEnabled');
      expect(saved).toMatchObject({ uiScale: 150, sidebarCollapsed: true });

      const written = findPreferencesWriteContent();
      if (written === null) {
        throw new Error('Expected preferences write content.');
      }
      const file: unknown = JSON.parse(written);
      expect(file).toMatchObject({
        version: 1,
        preferences: {
          uiScale: 150,
          sidebarCollapsed: true,
        },
      });
      expect(file).not.toHaveProperty(
        'preferences.interfaceScaleShortcutsEnabled',
      );

      mockedReadFile.mockResolvedValue(written);
      const reloaded = await readPreferencesFile();
      expect(reloaded).not.toHaveProperty('interfaceScaleShortcutsEnabled');
      expect(reloaded).toMatchObject({ uiScale: 150, sidebarCollapsed: true });
    },
  );

  it('updates the remote control switch main reads', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ remoteControlEnabled: false }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    setRemoteControlEnabled(false);

    await saveHandler({}, { remoteControlEnabled: true });
    expect(isRemoteControlEnabled()).toBe(true);

    await saveHandler({}, { remoteControlEnabled: false });
    expect(isRemoteControlEnabled()).toBe(false);
  });

  it('saves Agents add to the Feed when it is switched off', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = expectPreferencesData(
      await saveHandler({}, { ledgerAgentRecordingEnabled: false }),
    );

    expect(result.ledgerAgentRecordingEnabled).toBe(false);
    expect(findPreferencesWriteContent()).toContain(
      '"ledgerAgentRecordingEnabled": false',
    );
  });

  it('keeps a saved Agents add to the Feed choice through unrelated saves', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ ledgerAgentRecordingEnabled: false }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = expectPreferencesData(
      await saveHandler({}, { sidebarCollapsed: true }),
    );

    expect(result.ledgerAgentRecordingEnabled).toBe(false);
    expect(findPreferencesWriteContent()).toContain(
      '"ledgerAgentRecordingEnabled": false',
    );
  });

  it('loads a saved Agents add to the Feed choice', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ ledgerAgentRecordingEnabled: false }),
    );

    const result = expectPreferencesData(await loadHandler());

    expect(result.ledgerAgentRecordingEnabled).toBe(false);
  });

  it('reports whether this launch loads over the renderer scheme', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ rendererCodeCacheSchemeEnabled: true }),
    );
    setRendererCodeCacheSchemeStatusSource(() => ({
      active: true,
      fellBack: false,
      switchBackFailed: false,
    }));
    try {
      const loaded = await loadHandler();
      expect(loaded).toHaveProperty('rendererCodeCacheSchemeEnabled', true);
      expect(loaded).toHaveProperty('__rendererCodeCacheSchemeActive', true);
      expect(loaded).not.toHaveProperty('__rendererCodeCacheSchemeFellBack');

      expect(loaded).not.toHaveProperty(
        '__rendererCodeCacheSchemeSwitchBackFailed',
      );

      setRendererCodeCacheSchemeStatusSource(() => ({
        active: false,
        fellBack: true,
        switchBackFailed: false,
      }));
      const fellBack = await loadHandler();
      expect(fellBack).not.toHaveProperty('__rendererCodeCacheSchemeActive');
      expect(fellBack).toHaveProperty(
        '__rendererCodeCacheSchemeFellBack',
        true,
      );

      setRendererCodeCacheSchemeStatusSource(() => ({
        active: true,
        fellBack: false,
        switchBackFailed: true,
      }));
      expect(await loadHandler()).toHaveProperty(
        '__rendererCodeCacheSchemeSwitchBackFailed',
        true,
      );
    } finally {
      setRendererCodeCacheSchemeStatusSource(null);
    }
  });

  it('applies a changed interface scale as the zoom factor of every open window before broadcasting', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ uiScale: 100 }));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const mainWindow = new BrowserWindow();
    const secondaryWindow = new BrowserWindow();
    const setZoomFactorSpy = jest.spyOn(
      mainWindow.webContents,
      'setZoomFactor',
    );
    const getAllWindowsSpy = jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([mainWindow, secondaryWindow]);

    try {
      await saveHandler({}, { uiScale: 150 });

      expect(mainWindow.webContents.getZoomFactor()).toBe(1.5);
      expect(secondaryWindow.webContents.getZoomFactor()).toBe(1.5);
      expect(setZoomFactorSpy.mock.invocationCallOrder[0]).toBeLessThan(
        mockedSendToWindow.mock.invocationCallOrder[0],
      );

      // An unrelated save leaves the zoom untouched.
      setZoomFactorSpy.mockClear();
      mockedReadFile.mockResolvedValue(makePrefsFile({ uiScale: 150 }));
      await saveHandler({}, { sidebarCollapsed: true });
      expect(setZoomFactorSpy).not.toHaveBeenCalled();
    } finally {
      getAllWindowsSpy.mockRestore();
      setZoomFactorSpy.mockRestore();
    }
  });

  it('broadcasts the normalized preferences to every open window so secondary windows update display settings live', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const fakeWindow = new BrowserWindow();
    const getAllWindowsSpy = jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([fakeWindow]);

    try {
      const result = await saveHandler(
        {},
        { theme: 'ocean', colorMode: 'light', uiScale: 110 },
      );

      expect(mockedSendToWindow).toHaveBeenCalledWith(
        fakeWindow,
        'preferences:synced',
        result,
      );
      expect(mockedSendToWindow.mock.invocationCallOrder[0]).toBeLessThan(
        wakeLockSetEnabledMock.mock.invocationCallOrder[0],
      );
    } finally {
      getAllWindowsSpy.mockRestore();
    }
  });

  it.each(['light', 'dark', 'system'] as const)(
    'persists and reloads %s appearance while keeping native materials aligned',
    async (colorMode) => {
      let persisted = makePrefsFile({
        colorMode: colorMode === 'dark' ? 'light' : 'dark',
      });
      mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockImplementation((_filePath, data) => {
        if (typeof data === 'string') persisted = data;
        return Promise.resolve();
      });
      nativeTheme.themeSource = colorMode === 'light' ? 'dark' : 'light';
      let nativeThemeSourceAtBroadcast: 'dark' | 'light' | 'system' | undefined;
      mockedSendToWindow.mockImplementation(() => {
        nativeThemeSourceAtBroadcast = nativeTheme.themeSource;
        return true;
      });
      const getAllWindowsSpy = jest
        .spyOn(BrowserWindow, 'getAllWindows')
        .mockReturnValue([new BrowserWindow()]);

      try {
        const result = await saveHandler({}, { colorMode });
        invalidateRendererPreferencesCache();
        const reloaded = await loadHandler();

        expect(expectPreferencesData(result).colorMode).toBe(colorMode);
        expect(expectPreferencesData(reloaded).colorMode).toBe(colorMode);
        expect(nativeThemeSourceAtBroadcast).toBe(colorMode);
        expect(nativeTheme.themeSource).toBe(colorMode);
      } finally {
        getAllWindowsSpy.mockRestore();
      }
    },
  );

  it('updates wake-lock enabled state with normalized saved preferences', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        keepSystemAwakeWhileAgentsActive: false,
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { sidebarCollapsed: true });

    expect(wakeLockSetEnabledMock).toHaveBeenCalledWith(false);
  });

  it('rejects occupied MCP proxy ports before writing any preference changes', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ mcpProxyPort: 37645 }));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    proxyAssertPortAvailableMock.mockRejectedValueOnce(new Error('EADDRINUSE'));

    await expect(
      saveHandler({}, { mcpProxyPort: 37646, uiScale: 110 }),
    ).rejects.toThrow('MCP proxy port is already in use. Choose another port.');

    expect(proxyAssertPortAvailableMock).toHaveBeenCalledWith(37646);
    expect(proxyUpdatePortMock).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('does not move a running MCP proxy when saving a new port', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ mcpProxyPort: 37645 }));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    proxyIsRunningMock.mockReturnValue(true);

    await expect(saveHandler({}, { mcpProxyPort: 37646 })).resolves.toEqual(
      expect.objectContaining({ mcpProxyPort: 37646 }),
    );

    expect(proxyAssertPortAvailableMock).toHaveBeenCalledWith(37646);
    expect(proxyUpdatePortMock).not.toHaveBeenCalled();
  });

  it('persists a preference save after transient rename contention', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({ colorMode: 'dark' }));
    mockedRename.mockRejectedValueOnce(
      Object.assign(new Error('locked'), { code: 'EPERM' }),
    );
    await expect(saveHandler({}, { colorMode: 'light' })).resolves.toEqual(
      expect.objectContaining({ colorMode: 'light' }),
    );
    expect(
      mockedRename.mock.calls.filter(
        ([, target]) => target === '/mock/userData/preferences.json',
      ),
    ).toHaveLength(2);
  });

  it('serializes rapid partial saves so theme fields do not overwrite each other', async () => {
    let persisted = makePrefsFile({
      theme: 'default',
      colorMode: 'dark',
    });
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_filePath, data) => {
      if (typeof data === 'string') {
        persisted = data;
      }
      return Promise.resolve();
    });

    const [themeResult, colorModeResult] = await Promise.all([
      saveHandler({}, { theme: 'ocean' }),
      saveHandler({}, { colorMode: 'light' }),
    ]);

    expect((themeResult as PreferencesData).theme).toBe('ocean');
    expect((themeResult as PreferencesData).colorMode).toBe('dark');
    expect((colorModeResult as PreferencesData).theme).toBe('ocean');
    expect((colorModeResult as PreferencesData).colorMode).toBe('light');

    const writtenContent = JSON.parse(persisted) as PreferencesFile;
    expect(writtenContent.preferences.theme).toBe('ocean');
    expect(writtenContent.preferences.colorMode).toBe('light');
  });

  it('compares onboarding telemetry with each immediately preceding queued save', async () => {
    let persisted = makePrefsFile({});
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_filePath, data) => {
      if (typeof data === 'string') {
        persisted = data;
      }
      return Promise.resolve();
    });

    await Promise.all([
      saveHandler({}, { attributionSource: 'search' }),
      saveHandler({}, { profileRole: 'designer' }),
    ]);

    expect(mockedRecordOnboardingProfileTelemetry).toHaveBeenCalledTimes(2);
    const firstTelemetry =
      mockedRecordOnboardingProfileTelemetry.mock.calls[0]?.[0];
    expect(firstTelemetry?.previous.attributionSource).toBeUndefined();
    expect(firstTelemetry?.previous.profileRole).toBeUndefined();
    expect(firstTelemetry?.next.attributionSource).toBe('search');
    expect(firstTelemetry?.next.profileRole).toBeUndefined();

    const secondTelemetry =
      mockedRecordOnboardingProfileTelemetry.mock.calls[1]?.[0];
    expect(secondTelemetry?.previous.attributionSource).toBe('search');
    expect(secondTelemetry?.previous.profileRole).toBeUndefined();
    expect(secondTelemetry?.next.attributionSource).toBe('search');
    expect(secondTelemetry?.next.profileRole).toBe('designer');
  });

  it('syncs a committed onboarding role to the cloud profile service', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await expect(saveHandler({}, { profileRole: 'designer' })).resolves.toEqual(
      expect.objectContaining({ profileRole: 'designer' }),
    );

    expect(syncOnboardingProfilePreferencesMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileRole: 'designer' }),
      { profileRole: 'designer' },
    );
  });

  it('keeps a local onboarding save successful when cloud profile sync fails', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    syncOnboardingProfilePreferencesMock.mockRejectedValueOnce(
      new Error('cloud unavailable'),
    );

    await expect(saveHandler({}, { profileRole: 'student' })).resolves.toEqual(
      expect.objectContaining({ profileRole: 'student' }),
    );
  });

  it('tracks durable OpenCode enablement independently of unrelated queued writes', async () => {
    let persisted = makePrefsFile({ opencodeEnabled: false });
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedWriteFile.mockImplementation((_filePath, data) => {
      if (typeof data === 'string') persisted = data;
      return Promise.resolve();
    });
    const before = getOpenCodeEnabledRevision();
    let committedRevision = -1;
    await updatePreferencesFile(
      () => ({ opencodeEnabled: true }),
      () => {
        committedRevision = getOpenCodeEnabledRevision();
      },
    );
    expect(committedRevision).toBe(before + 1);
    await updatePreferencesFile(() => ({ colorMode: 'dark' }));
    await updatePreferencesFile(() => ({ opencodeEnabled: true }));
    expect(getOpenCodeEnabledRevision()).toBe(committedRevision);
    await updatePreferencesFile(() => ({ opencodeEnabled: false }));
    await updatePreferencesFile(() => ({ opencodeEnabled: true }));
    expect(getOpenCodeEnabledRevision()).toBe(committedRevision + 2);
    await flushPreferencesWrites();
    mockedWriteFile.mockRejectedValueOnce(new Error('write failed'));
    await expect(
      updatePreferencesFile(() => ({ opencodeEnabled: false })),
    ).rejects.toThrow('write failed');
    expect(getOpenCodeEnabledRevision()).toBe(committedRevision + 2);
  });

  it('computes updater writes from the latest queued preferences', async () => {
    let persisted = makePrefsFile({
      codexCompatDisabledPlugins: [],
    });
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_filePath, data) => {
      if (typeof data === 'string') {
        persisted = data;
      }
      return Promise.resolve();
    });

    const [firstResult, secondResult] = await Promise.all([
      updatePreferencesFile((latest) => ({
        codexCompatDisabledPlugins: [
          ...latest.codexCompatDisabledPlugins,
          'mkt-1/plugin-one',
        ],
      })),
      updatePreferencesFile((latest) => ({
        codexCompatDisabledPlugins: [
          ...latest.codexCompatDisabledPlugins,
          'mkt-2/plugin-two',
        ],
      })),
    ]);

    expect(firstResult.codexCompatDisabledPlugins).toEqual([
      'mkt-1/plugin-one',
    ]);
    expect(secondResult.codexCompatDisabledPlugins).toEqual([
      'mkt-1/plugin-one',
      'mkt-2/plugin-two',
    ]);

    const writtenContent = JSON.parse(persisted) as PreferencesFile;
    expect(writtenContent.preferences.codexCompatDisabledPlugins).toEqual([
      'mkt-1/plugin-one',
      'mkt-2/plugin-two',
    ]);
  });

  it('merges concurrent onboarding tip dismissals inside the write queue (CAN-4904)', async () => {
    const updateOnboardingTips = findRegisteredHandler(
      'preferences:update-onboarding-tips',
    );
    let persisted = makePrefsFile({
      onboardingTipsDismissed: { 'worktree-chat': '2026-10-24T08:00:00.000Z' },
    });
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_filePath, data) => {
      if (typeof data === 'string') {
        persisted = data;
      }
      return Promise.resolve();
    });

    await Promise.all([
      updateOnboardingTips({}, { action: 'dismiss', tipId: 'workflows' }),
      updateOnboardingTips(
        {},
        {
          action: 'dismiss',
          tipId: 'workflows-schedule',
        },
      ),
    ]);

    const written = expectPreferencesData(
      (JSON.parse(persisted) as PreferencesFile).preferences,
    );
    expect(Object.keys(written.onboardingTipsDismissed).sort()).toEqual([
      'workflows',
      'workflows-schedule',
      'worktree-chat',
    ]);
    expect(written.onboardingTipsDismissed['worktree-chat']).toBe(
      '2026-10-24T08:00:00.000Z',
    );

    await expect(
      updateOnboardingTips({}, { action: 'reset' }),
    ).resolves.toEqual({ dismissed: {} });
    await expect(
      updateOnboardingTips({}, { action: 'dismiss', tipId: 'nope' }),
    ).rejects.toThrow('Invalid onboarding tip update.');
  });

  it('merges concurrent disabled-pipeline preference updates atomically', async () => {
    let persisted = makePrefsFile({
      disabledPipelineIds: ['existing'],
    });
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_filePath, data) => {
      if (typeof data === 'string') {
        persisted = data;
      }
      return Promise.resolve();
    });

    const [firstResult, secondResult] = await Promise.all([
      setPipelineDisabledHandler({}, { id: 'pipeline-a', disabled: true }),
      setPipelineDisabledHandler({}, { id: 'pipeline-b', disabled: true }),
    ]);

    expect(expectPreferencesData(firstResult).disabledPipelineIds).toEqual([
      'existing',
      'pipeline-a',
    ]);
    expect(expectPreferencesData(secondResult).disabledPipelineIds).toEqual([
      'existing',
      'pipeline-a',
      'pipeline-b',
    ]);

    const writtenContent: unknown = JSON.parse(persisted);
    if (
      typeof writtenContent !== 'object' ||
      writtenContent === null ||
      !('preferences' in writtenContent)
    ) {
      throw new Error('Expected preferences file content.');
    }
    expect(
      expectPreferencesData(writtenContent.preferences).disabledPipelineIds,
    ).toEqual(['existing', 'pipeline-a', 'pipeline-b']);
  });

  // CAN-3055 round 2: Settings must not persist a whole `approvalDefaults`
  // object built from its mount-time snapshot. That clobbers a concurrent
  // in-chat write-back, and when `loadPreferences()` failed and the snapshot
  // came from the (now all Full Access) fallback it silently escalated the two
  // surfaces the user never touched.
  it('rejects approval defaults on the generic preference-save channel', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await expect(
      saveHandler(
        {},
        {
          approvalDefaults: {
            worktree: 'ask',
            cowork: 'ask',
            appAdvisor: 'ask',
          },
        },
      ),
    ).rejects.toThrow(/setApprovalDefaultPreference/);

    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('rejects an own undefined approval-default value on the generic channel', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        approvalDefaults: {
          worktree: 'ask',
          cowork: 'auto',
          appAdvisor: 'ask',
        },
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await expect(
      saveHandler({}, { approvalDefaults: undefined }),
    ).rejects.toThrow(/setApprovalDefaultPreference/);

    expect(mockedReadFile).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  // CAN-4880 (D9): main's Copilot connection owns the flag and the account
  // pin. A renderer or remote save never sets either of them.
  describe('Copilot connection ownership', () => {
    const pinnedAccount = { host: 'https://github.com', login: 'octocat' };

    function persistPreferences(preferences: Partial<PreferencesData>): void {
      let persisted = makePrefsFile(preferences);
      mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockImplementation((_path, data) => {
        if (typeof data === 'string') persisted = data;
        return Promise.resolve();
      });
    }

    it('rejects a Copilot account pin before reading or writing', async () => {
      persistPreferences({ copilotEnabled: true });
      for (const copilotAccount of [pinnedAccount, null, undefined]) {
        await expect(
          saveHandler({}, { copilotAccount, theme: 'ocean' }),
        ).rejects.toThrow(/Copilot account/);
      }
      expect(mockedReadFile).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      'keeps the stored Copilot flag (%s) and saves the rest',
      async (stored) => {
        persistPreferences({
          copilotEnabled: stored,
          copilotAccount: stored ? pinnedAccount : undefined,
          theme: 'default',
        });
        const saved = expectPreferencesData(
          await saveHandler({}, { copilotEnabled: !stored, theme: 'ocean' }),
        );
        expect(saved).toMatchObject({ copilotEnabled: stored, theme: 'ocean' });
        const persisted = await readPreferencesFile();
        expect(persisted).toMatchObject({
          copilotEnabled: stored,
          theme: 'ocean',
        });
        expect(persisted.copilotAccount).toEqual(
          stored ? pinnedAccount : undefined,
        );
      },
    );

    it('applies the same rules to a save a remote controller tunnels here', async () => {
      persistPreferences({ copilotEnabled: false, theme: 'default' });
      const hub = new InMemoryRelayHub();
      const { initiator, responder } = await openControlSession(
        createTestDevice(hub, 'controller'),
        createTestDevice(hub, 'host'),
      );
      const bridges: FakeBridge[] = [];
      new RemoteHostSession({
        session: responder,
        // The hidden bridge window re-invokes each tunneled call on its own
        // IPC; this bridge hands it to the handler registered for it.
        createBridge: (): Promise<FakeBridge> => {
          const bridge = new FakeBridge();
          bridge.handler = (channel, args): Promise<unknown> =>
            findRegisteredHandler(channel)({}, ...args);
          bridges.push(bridge);
          return Promise.resolve(bridge);
        },
        mainWindowPushes: new FakeMainWindow(),
        uploads: new RemoteUploadStore('/mock/remote-uploads'),
        readFile: (): Promise<never> => Promise.reject(new Error('unused')),
        disposition: getRemoteChannelDisposition,
        isAuthorized: (): boolean => true,
        version: TEST_VERSION,
        hello: (): Pick<HelloResult, 'name' | 'platform'> => ({
          name: 'host',
          platform: 'darwin',
        }),
        onClose: (): void => undefined,
      });
      const controller = new RpcPeer(initiator, {
        onRequest: (): Promise<never> => Promise.reject(new Error('unused')),
        onEvent: (): void => undefined,
      });
      await controller.request(REMOTE_METHODS.hello, { version: TEST_VERSION });
      const save = (patch: Partial<PreferencesData>): Promise<unknown> =>
        controller.request(REMOTE_METHODS.invoke, {
          channel: 'preferences:save',
          args: [patch],
        });

      await expect(
        save({ copilotAccount: pinnedAccount, theme: 'ocean' }),
      ).rejects.toThrow(/Copilot account/);
      await save({ copilotEnabled: true, theme: 'ocean' });

      expect(bridges.flatMap((bridge) => bridge.invocations)).toHaveLength(2);
      const persisted = await readPreferencesFile();
      expect(persisted).toMatchObject({
        copilotEnabled: false,
        theme: 'ocean',
      });
      expect(persisted.copilotAccount).toBeUndefined();
    });
  });

  it('writes only the changed approval surface, preserving the others on disk', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        approvalDefaults: {
          worktree: 'full-access',
          cowork: 'ask',
          appAdvisor: 'auto',
        },
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await setApprovalDefaultHandler(
      {},
      { surface: 'worktree', mode: 'ask' },
    );

    expect(expectPreferencesData(result).approvalDefaults).toEqual({
      worktree: 'ask',
      cowork: 'ask',
      appAdvisor: 'auto',
    });
  });

  it('makes a Settings choice supersede an older in-chat surface intent', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        approvalDefaults: {
          worktree: 'full-access',
          cowork: 'full-access',
          appAdvisor: 'full-access',
        },
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    const olderChatIntent = beginApprovalDefaultIntent('worktree');

    const result = await setApprovalDefaultHandler(
      {},
      { surface: 'worktree', mode: 'ask' },
    );

    expect(isApprovalDefaultIntentCurrent('worktree', olderChatIntent)).toBe(
      false,
    );
    expect(expectPreferencesData(result).approvalDefaults.worktree).toBe('ask');
  });

  it('broadcasts a committed approval default when only the last-good refresh fails', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        approvalDefaults: {
          worktree: 'full-access',
          cowork: 'full-access',
          appAdvisor: 'full-access',
        },
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    const lastGoodError = Object.assign(new Error('last-good unavailable'), {
      code: 'ENOSPC',
    });
    mockedRename.mockImplementation((_source, target) => {
      if (target === '/mock/userData/preferences.last-good.json') {
        return Promise.reject(lastGoodError);
      }
      return Promise.resolve();
    });
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const fakeWindow = new BrowserWindow();
    const getAllWindowsSpy = jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([fakeWindow]);

    try {
      const result = await setApprovalDefaultHandler(
        {},
        { surface: 'worktree', mode: 'ask' },
      );

      expect(expectPreferencesData(result).approvalDefaults.worktree).toBe(
        'ask',
      );
      expect(mockedSendToWindow).toHaveBeenCalledWith(
        fakeWindow,
        'preferences:synced',
        result,
      );
      await flushPreferencesWrites();
      expect(
        mockedRename.mock.calls.some(
          ([, target]) => target === '/mock/userData/preferences.json',
        ),
      ).toBe(true);
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to refresh the last-good preferences backup:',
        lastGoodError,
      );
    } finally {
      getAllWindowsSpy.mockRestore();
      consoleError.mockRestore();
      mockedRename.mockReset();
    }
  });

  it('merges each concurrent approval-default write instead of clobbering', async () => {
    let persisted = makePrefsFile({
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    });
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_filePath, data) => {
      if (typeof data === 'string') {
        persisted = data;
      }
      return Promise.resolve();
    });

    const [first, second] = await Promise.all([
      setApprovalDefaultHandler({}, { surface: 'worktree', mode: 'ask' }),
      setApprovalDefaultHandler({}, { surface: 'cowork', mode: 'auto' }),
    ]);

    expect(expectPreferencesData(first).approvalDefaults.worktree).toBe('ask');
    // The second write saw the first one's result rather than a stale snapshot.
    expect(expectPreferencesData(second).approvalDefaults).toEqual({
      worktree: 'ask',
      cowork: 'auto',
      appAdvisor: 'full-access',
    });
  });

  it('registers a Settings default change while an older write holds the queue', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        approvalDefaults: {
          worktree: 'full-access',
          cowork: 'full-access',
          appAdvisor: 'full-access',
        },
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    let releaseOlderWrite: () => void = () => undefined;
    const olderWriteGate = new Promise<void>((resolve) => {
      releaseOlderWrite = resolve;
    });
    mockedWriteFile.mockImplementationOnce(() => olderWriteGate);
    mockedWriteFile.mockResolvedValue(undefined);

    const olderWrite = updatePreferencesFile(() => ({ profileRole: 'other' }));
    await Promise.resolve();
    const settingsWrite = setApprovalDefaultHandler(
      {},
      { surface: 'worktree', mode: 'ask' },
    );
    let barrierResolved = false;
    const barrier = waitForPendingApprovalDefaultWrites('worktree').then(() => {
      barrierResolved = true;
    });
    await Promise.resolve();

    expect(barrierResolved).toBe(false);
    releaseOlderWrite();
    await olderWrite;
    await settingsWrite;
    await barrier;
    expect(barrierResolved).toBe(true);
  });

  // CAN-3055 round 3: the per-key normalizer fails closed on a malformed
  // VALUE, but the container guard returned the product default — now all Full
  // Access — for any non-record. So `approvalDefaults: null` escalated all
  // three surfaces while `approvalDefaults: { worktree: 'nope' }` fell closed.
  // Corrupt state must never resolve upward.
  it.each([null, 'ask', 42, []])(
    'fails closed when the persisted approvalDefaults container is %p',
    async (corrupt) => {
      mockedReadFile.mockResolvedValue(
        makePrefsFile({
          approvalDefaults:
            corrupt as unknown as PreferencesData['approvalDefaults'],
        }),
      );

      const result = await loadHandler({});

      expect(expectPreferencesData(result).approvalDefaults).toEqual({
        worktree: 'ask',
        cowork: 'ask',
        appAdvisor: 'ask',
      });
    },
  );

  it('still uses the product default when approvalDefaults was never persisted', async () => {
    // Absent is not corrupt: a fresh profile made no choice, so it gets Full
    // Access. Guards against over-correcting the fix above.
    mockedReadFile.mockResolvedValue(makePrefsFile({}));

    const result = await loadHandler({});

    expect(expectPreferencesData(result).approvalDefaults).toEqual({
      worktree: 'full-access',
      cowork: 'full-access',
      appAdvisor: 'full-access',
    });
  });

  // CAN-3055 round 3: a degraded read returns synthetic all-Full-Access
  // defaults, so merging the user's one changed key into them would durably
  // persist Full Access for the two surfaces they never touched — and seed the
  // in-memory override with the same escalated object. `loadPreferences()`
  // RESOLVES on a degraded read, so Settings cannot tell it apart and this is
  // reachable from the normal UI, not just a race window.
  it('refuses to write an approval default when the preferences read was degraded', async () => {
    const olderSuccessfulChatIntent = beginApprovalDefaultIntent('cowork');
    expect(
      isApprovalDefaultIntentCurrent('cowork', olderSuccessfulChatIntent),
    ).toBe(true);
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('EIO'), { code: 'EIO' }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await loadHandler({});
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedWriteFile.mockClear();

    await expect(
      setApprovalDefaultHandler({}, { surface: 'cowork', mode: 'ask' }),
    ).rejects.toThrow(/Preferences could not be read/);

    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(
      isApprovalDefaultIntentCurrent('cowork', olderSuccessfulChatIntent),
    ).toBe(true);
  });

  it('keeps an older successful intent current when a newer Settings write fails', async () => {
    const olderSuccessfulChatIntent = beginApprovalDefaultIntent('worktree');
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        approvalDefaults: {
          worktree: 'full-access',
          cowork: 'full-access',
          appAdvisor: 'full-access',
        },
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      setApprovalDefaultHandler({}, { surface: 'worktree', mode: 'ask' }),
    ).rejects.toThrow('disk full');

    expect(
      isApprovalDefaultIntentCurrent('worktree', olderSuccessfulChatIntent),
    ).toBe(true);
  });

  it('rejects an invalid approval surface or mode instead of coercing it', async () => {
    await expect(
      setApprovalDefaultHandler({}, { surface: 'nope', mode: 'ask' }),
    ).rejects.toThrow('Invalid approval default preference request.');
    await expect(
      setApprovalDefaultHandler(
        {},
        { surface: 'worktree', mode: 'full_access' },
      ),
    ).rejects.toThrow('Invalid approval default preference request.');
  });

  it('removes a disabled pipeline id through the atomic preference handler', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ disabledPipelineIds: ['keep', 'remove'] }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await setPipelineDisabledHandler(
      {},
      { id: 'remove', disabled: false },
    );

    expect(expectPreferencesData(result).disabledPipelineIds).toEqual(['keep']);
  });

  it('validates disabled pipeline ids in the atomic preference handler', async () => {
    await expect(
      setPipelineDisabledHandler(
        {},
        { id: 'Invalid Pipeline', disabled: true },
      ),
    ).rejects.toThrow(
      'Invalid pipeline id: must be alphanumeric with underscores or hyphens.',
    );
  });

  it('accepts stored custom pipeline ids in the atomic preference handler', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ disabledPipelineIds: [] }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await setPipelineDisabledHandler(
      {},
      { id: 'Nightly_Build', disabled: true },
    );

    expect(expectPreferencesData(result).disabledPipelineIds).toEqual([
      'Nightly_Build',
    ]);
  });

  it('accepts project pipeline ids in the atomic preference handler', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ disabledPipelineIds: [] }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await setPipelineDisabledHandler(
      {},
      { id: 'project--deploy/staging.yaml', disabled: true },
    );

    expect(expectPreferencesData(result).disabledPipelineIds).toEqual([
      'project--deploy/staging.yaml',
    ]);
  });

  it('persists and removes curated pipeline visibility through the registered handler', async () => {
    let persisted = makePrefsFile({ disabledPipelineIds: ['existing'] });
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_filePath, data) => {
      if (typeof data === 'string') persisted = data;
      return Promise.resolve();
    });

    const id = 'curated:review-workflow';
    const hidden = await setPipelineDisabledHandler({}, { id, disabled: true });
    expect(expectPreferencesData(hidden).disabledPipelineIds).toEqual([
      'existing',
      id,
    ]);
    expect((await readPreferencesFile()).disabledPipelineIds).toEqual([
      'existing',
      id,
    ]);
    // Catalog revisions and hashes do not participate in the persisted identity.
    const visible = await setPipelineDisabledHandler(
      {},
      { id, disabled: false },
    );
    expect(expectPreferencesData(visible).disabledPipelineIds).toEqual([
      'existing',
    ]);
    expect((await readPreferencesFile()).disabledPipelineIds).toEqual([
      'existing',
    ]);
  });

  it.each([
    'curated:',
    'curated:../review',
    'curated:review/child',
    'curated:review\\child',
    'curated:review:revision',
    'curated:UPPER',
    'curated:with_underscore',
    'curated:con',
    `curated:${'a'.repeat(65)}`,
    'unknown:review',
    'user:curated:review',
  ])(
    'rejects malformed or unsupported pipeline preference id %s',
    async (id) => {
      await expect(
        setPipelineDisabledHandler({}, { id, disabled: true }),
      ).rejects.toThrow(/Invalid .*pipeline id/);
      expect(mockedWriteFile).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid project pipeline ids in the atomic preference handler', async () => {
    await expect(
      setPipelineDisabledHandler(
        {},
        { id: 'project--../staging.yaml', disabled: true },
      ),
    ).rejects.toThrow('Invalid project pipeline id.');
  });

  it('accepts validated shared pipeline ids in the atomic preference handler', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ disabledPipelineIds: [] }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await setPipelineDisabledHandler(
      {},
      { id: 'shared:canopy-cloud:remote-1', disabled: true },
    );

    expect(expectPreferencesData(result).disabledPipelineIds).toEqual([
      'shared:canopy-cloud:remote-1',
    ]);
  });

  it('accepts shared remote pipeline ids with uppercase and underscores', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ disabledPipelineIds: [] }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await setPipelineDisabledHandler(
      {},
      { id: 'shared:canopy-cloud:Remote_ID-1', disabled: true },
    );

    expect(expectPreferencesData(result).disabledPipelineIds).toEqual([
      'shared:canopy-cloud:Remote_ID-1',
    ]);
  });

  it('flushes in-flight preference writes', async () => {
    let persisted = makePrefsFile({
      theme: 'default',
      colorMode: 'dark',
    });
    let resolveWrite: () => void = () => {};
    const blockedWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_filePath, data) => {
      if (typeof data === 'string') {
        persisted = data;
      }
      return blockedWrite;
    });

    const savePromise = saveHandler({}, { theme: 'ocean' });
    const flushPromise = flushPreferencesWrites();
    let flushed = false;
    void flushPromise.then(() => {
      flushed = true;
    });
    await Promise.resolve();

    expect(flushed).toBe(false);

    resolveWrite();
    await savePromise;
    await flushPromise;

    expect(flushed).toBe(true);
  });

  describe('last-good refresh', () => {
    const MAIN = '/mock/userData/preferences.json';
    const LAST_GOOD = join('/mock/userData', 'preferences.last-good.json');
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 10; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const panelPercent = (data: string | Uint8Array): unknown =>
      Reflect.get(
        Object(Reflect.get(Object(JSON.parse(String(data))), 'preferences')),
        'worktreePanelPercent',
      );

    let persisted: string;
    let lastGoodWrites: unknown[];
    let lastGoodHolds: Array<() => void>;
    let activeLastGoodWrites: number;
    let maxActiveLastGoodWrites: number;

    beforeEach(() => {
      persisted = makePrefsFile({});
      lastGoodWrites = [];
      lastGoodHolds = [];
      activeLastGoodWrites = 0;
      maxActiveLastGoodWrites = 0;
      mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFileAtomically.mockImplementation(async (path, data) => {
        if (path === MAIN) {
          persisted = String(data);
          return;
        }
        if (path !== LAST_GOOD) return;
        activeLastGoodWrites += 1;
        maxActiveLastGoodWrites = Math.max(
          maxActiveLastGoodWrites,
          activeLastGoodWrites,
        );
        lastGoodWrites.push(panelPercent(data));
        await new Promise<void>((resolve) => lastGoodHolds.push(resolve));
        activeLastGoodWrites -= 1;
      });
    });

    it('acknowledges a save and queued readers once main is durable; only the flush waits for last-good', async () => {
      await updatePreferencesFile(() => ({ worktreePanelPercent: 41 }));
      await expect(readPreferencesFileDetailed()).resolves.toMatchObject({
        authority: 'ok',
        preferences: { worktreePanelPercent: 41 },
      });
      await settle();
      expect(lastGoodWrites).toEqual([41]);

      let flushed = false;
      const flush = flushPreferencesWrites().then(() => {
        flushed = true;
      });
      await settle();
      expect(flushed).toBe(false);
      lastGoodHolds.shift()?.();
      await flush;
      expect(flushed).toBe(true);
    });

    it('refreshes last-good one write at a time, skipping to the latest confirmed state', async () => {
      await updatePreferencesFile(() => ({ worktreePanelPercent: 41 }));
      await settle();
      await updatePreferencesFile(() => ({ worktreePanelPercent: 42 }));
      await updatePreferencesFile(() => ({ worktreePanelPercent: 43 }));
      await settle();
      expect(lastGoodWrites).toEqual([41]);

      lastGoodHolds.shift()?.();
      await settle();
      // 42 was superseded while 41 was being written; 43 never lands first.
      expect(lastGoodWrites).toEqual([41, 43]);
      lastGoodHolds.shift()?.();
      await flushPreferencesWrites();
      expect(lastGoodWrites).toEqual([41, 43]);
      expect(maxActiveLastGoodWrites).toBe(1);
    });

    it('writes last-good from the bytes main confirmed, not the shared in-memory state', async () => {
      await updatePreferencesFile(() => ({ worktreePanelPercent: 41 }));
      await settle();
      await updatePreferencesFile(() => ({ worktreePanelPercent: 42 }));
      const confirmed = persisted;
      // A reader holding the served object changes it before 42's refresh.
      const latest = await readLatestPreferencesFile();
      latest.worktreePanelPercent = 99;

      lastGoodHolds.shift()?.();
      await settle();
      lastGoodHolds.shift()?.();
      await flushPreferencesWrites();
      expect(lastGoodWrites).toEqual([41, 42]);
      expect(
        mockedWriteFileAtomically.mock.calls
          .filter(([path]) => path === LAST_GOOD)
          .at(-1)?.[1],
      ).toBe(confirmed);
    });

    it('also flushes a save acknowledged while the flush waits for last-good', async () => {
      await updatePreferencesFile(() => ({ worktreePanelPercent: 41 }));
      let flushed = false;
      const flush = flushPreferencesWrites().then(() => {
        flushed = true;
      });
      await settle();
      let releaseMain: () => void = () => undefined;
      const writeMain = mockedWriteFileAtomically.getMockImplementation();
      mockedWriteFileAtomically.mockImplementationOnce(async (...args) => {
        await new Promise<void>((resolve) => {
          releaseMain = resolve;
        });
        return writeMain?.(...args);
      });
      const save = updatePreferencesFile(() => ({ worktreePanelPercent: 42 }));
      await settle();
      lastGoodHolds.shift()?.();
      await settle();
      expect(flushed).toBe(false);

      releaseMain();
      await save;
      await settle();
      expect(flushed).toBe(false);
      lastGoodHolds.shift()?.();
      await flush;
      expect(lastGoodWrites).toEqual([41, 42]);
    });

    it('never refreshes last-good from a save whose main write failed', async () => {
      const failure = new Error('disk full');
      mockedWriteFileAtomically.mockImplementation((path) =>
        path === MAIN ? Promise.reject(failure) : Promise.resolve(),
      );

      await expect(
        updatePreferencesFile(() => ({ worktreePanelPercent: 41 })),
      ).rejects.toBe(failure);
      await flushPreferencesWrites();

      expect(
        mockedWriteFileAtomically.mock.calls.map(([path]) => path),
      ).toEqual([join('/mock/userData', 'preferences.generation.json'), MAIN]);
    });
  });

  it('creates directory before writing', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { worktreePanelPercent: 50 });

    // Preferences sit in the data root itself.
    expect(createDirectoryDurably).toHaveBeenCalledWith('/mock/userData', {
      dataRoot: '/mock/userData',
    });
  });

  it('normalizes saved values with clamping', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await saveHandler({}, { worktreePanelPercent: 100 });

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 65,
      sidebarCollapsed: false,
    });
  });

  it('falls back to the default terminal drawer tab when saving an unknown tab id', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      {
        terminalDrawerActiveTabId: 'logs',
      },
    )) as PreferencesData;

    expect(result.terminalDrawerActiveTabId).toBe('terminal');
    expect(findPreferencesWriteContent()).toEqual(
      expect.stringContaining('"terminalDrawerActiveTabId": "terminal"'),
    );
  });

  it('writes pretty-printed JSON with 2-space indent', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { worktreePanelPercent: 32 });

    const rawOutput = findPreferencesWriteContent();
    const expected = JSON.stringify(
      {
        version: 1,
        generation: 1,
        preferences: {
          cursorEnabled: false,
          copilotEnabled: false,
          opencodeEnabled: false,
          accountProxyEnabled: false,
          accountProxyConnection: null,
          accountProxyKeepChatOnOneAccount: true,
          accountProxyRouteClaude: true,
          accountProxyRouteCodex: true,
          accountProxyLocalStartWithApp: true,
          orgProjectCloneProtocol: 'https',
          cursorAgentPath: '',
          workspaceDefaultLayoutMode: 'advanced',
          navigationMode: 'code',
          worktreePanelPercent: 32,
          activityPanelExpanded: false,
          activityPanelWidthPercent: 25,
          kanbanWorktreePanelPercent: 32,
          kanbanActivityPanelExpanded: false,
          kanbanActivityPanelWidthPercent: 25,
          kanbanChatPanelVisible: false,
          pipelineChatPanelVisible: true,
          pipelineChatPanelWidthPercent: 30,
          sidebarCollapsed: false,
          sidebarProjectSortMode: 'manual',
          sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
          sidebarCodeSectionCollapsed: false,
          sidebarCoworkSectionCollapsed: false,
          sidebarNavLayout: {
            order: [
              'app-advisor',
              'workflows',
              'plugins',
              'feed',
              'remote-control',
              'overview',
              'kanban',
              'statistics',
              'audit',
              'workers',
            ],
            moreStartIndex: 10,
          },
          branchNamePrefixMode: 'github',
          branchNameCustomPrefix: '',
          deleteBranchOnArchive: true,
          archiveOnMerge: true,
          groupChildBranchesWithBase: true,
          defaultChatProvider: 'claude',
          defaultChatModelByProvider: {
            claude: {
              model: 'opus[1m]',
              thinkingLevel: 'high',
            },
            codex: {
              model: DEFAULT_CODEX_MODEL,
              thinkingLevel: 'high',
            },
            ollama: null,
            aiCredits: null,
          },
          defaultWorktreeProvider: 'claude',
          defaultWorktreeModelByProvider: {
            claude: {
              model: 'opus[1m]',
              thinkingLevel: 'high',
            },
            codex: {
              model: DEFAULT_CODEX_MODEL,
              thinkingLevel: 'high',
            },
            ollama: null,
            aiCredits: null,
          },
          approvalDefaults: {
            worktree: 'full-access',
            cowork: 'full-access',
            appAdvisor: 'full-access',
          },
          globalApprovalRules: [],
          approvalsUpgradeNoticeDismissed: false,
          onboardingTipsDismissed: {},
          summaryModel: 'gpt-6-luna',
          summaryModelSetByUser: false,
          summaryThinkingLevel: 'off',
          handoffSummaryModel: 'haiku',
          handoffSummaryThinkingLevel: 'off',
          worktreeSummaryEnabled: true,
          worktreeSummaryModel: 'haiku',
          worktreeSummaryThinkingLevel: 'off',
          planDiagramModel: 'haiku',
          planDiagramThinkingLevel: 'off',
          codeReviewModel: 'haiku',
          codeReviewThinkingLevel: 'off',
          prGenerationModel: 'sonnet',
          prGenerationThinkingLevel: 'high',
          prInstructions: '',
          prInstructionMode: 'append',
          commitGenerationModel: 'sonnet',
          commitGenerationThinkingLevel: 'high',
          commitInstructions: '',
          commitInstructionMode: 'append',
          branchNamingModel: 'haiku',
          branchNamingThinkingLevel: 'off',
          branchNamingInstructions: '',
          globalInstructions: {
            chats: {
              overall: '',
              scoped: [],
            },
            pipelines: {
              overall: '',
              scoped: [],
            },
          },
          pipelineAdvisorEnabled: true,
          orgMemoryInjectionEnabled: true,
          localMemoryEnabled: true,
          localMemoryEnabledSetByUser: false,
          localMemoryModel: 'gpt-6.1-sol',
          localMemoryModelSetByUser: false,
          localMemoryThinkingLevel: 'high',
          pipelineAdvisorModel: DEFAULT_CODEX_MODEL,
          pipelineAdvisorThinkingLevel: 'high',
          disabledPipelineIds: [],
          appAdvisorModel: DEFAULT_CODEX_MODEL,
          appAdvisorThinkingLevel: 'high',
          cronGenerationModel: DEFAULT_CODEX_MODEL,
          cronGenerationThinkingLevel: 'medium',
          ifCommandGenerationModel: DEFAULT_CODEX_MODEL,
          ifCommandGenerationThinkingLevel: 'medium',
          splitPrThresholdLines: 500,
          splitPrEnabled: true,
          splitPrPlannerModel: DEFAULT_CODEX_MODEL,
          splitPrPlannerThinkingLevel: 'high',
          disabledInstalledItems: [],
          parkedCodexPlugins: [],
          pendingInstalledItemUninstalls: [],
          globalPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
          initializedCuratedPluginDefaults: [],
          appAdvisorPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
          pipelineEditorPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
          appAdvisorDialogBounds: null,
          codexMultiAgentAppAdvisorEnabled: true,
          providerModelConfigDefaults: {
            codex: {
              fastMode: false,
            },
          },
          codexFastModeDefaultEnabled: false,
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
          codexCompatDisabledPlugins: [],
          branchDisplayMappings: [],
          reviewCommitMessage: false,
          agentRebaseResolutionEnabled: false,
          agentRebaseResolutionModel: null,
          agentRebaseResolutionThinkingLevel: null,
          mergeQueueAgentHandling: 'when_hook_absent',
          rtkEnabled: true,
          autoRetryTransientErrorsChats: true,
          autoRetryTransientErrorsPipelines: true,
          scriptTimeoutMinutes: 5,
          codexAppServerIdleTimeoutMinutes: 10,
          claudeSessionIdleTimeoutMinutes: 10,
          defaultChatInterfaceMode: 'canopy',
          defaultStandaloneChatInterfaceMode: 'canopy',
          defaultAppAdvisorInterfaceMode: 'canopy',
          preventClaudeNativeCaffeinate: true,
          claudeMaxTurns: 500,
          maxActiveChatTurns: 10,
          maxActivePipelineExecutions: 5,
          canopyBackgroundProcessesMode: 'canopy',
          pipelinesMode: 'canopy',
          workerConcurrencyLimit: 5,
          memoryPressureGuardEnabled: false,
          bypassCodexAppServerIdleTimeoutUnderCriticalPressure: true,
          memoryPressureWarningThresholdBytes: 2 * 1024 * 1024 * 1024,
          memoryPressureCriticalThresholdBytes: 4 * 1024 * 1024 * 1024,
          memoryDiagnosticsEnabled: false,
          keepSystemAwakeWhileAgentsActive: true,
          managedDelegationMaxDepth: 1,
          managedDelegationMaxConcurrent: 5,
          managedDelegationLifetimeLimit: 512,
          codexMultiAgentWorktreeChatsEnabled: false,
          codexMultiAgentStandaloneChatsEnabled: false,
          codexMaxConcurrentSubagents: null,
          codexMultiAgentPipelinesEnabled: false,
          deferredToolsWorktreeChatsEnabled: true,
          deferredToolsStandaloneChatsEnabled: true,
          deferredToolsAppAdvisorEnabled: true,
          deferredToolsPipelineAssistantEnabled: true,
          lastOpenApp: '',
          disabledOpenApps: [],
          lastSelectedWorktreeProjectId: '',
          lastSelectedWorktreeId: '',
          lastActiveContext: null,
          executionDetailViewMode: 'list',
          worktreeViewMode: 'list',
          worktreeFilterHiddenWorkspaceIds: [],
          auditRetentionDays: 7,
          automationRunRetentionDays: 90,
          theme: 'default',
          colorMode: 'system',
          sidebarAppearance: 'translucent',
          worktreeDiffStatsStyle: 'short',
          scrollbarBehavior: 'system',
          singleDollarMath: true,
          linearChatEnrichmentMode: 'replace',
          githubChatEnrichmentMode: 'hover',
          uiScale: 100,
          ledgerAgentRecordingEnabled: true,
          repeatTaskAutomationSuggestionsEnabled: true,
          skillSuggestionsEnabled: true,
          rendererCodeCacheSchemeEnabled: false,
          chatDetail: 'recent',
          remoteControlEnabled: true,
          windowBounds: null,
          windowMaximized: false,
          windowFullScreen: false,
          ollamaServerPort: 11534,
          ollamaConnectionMode: 'managed',
          ollamaExecutablePath: '',
          mcpProxyPort: 37645,
          hideAnthropicNav: DEFAULT_HIDE_ANTHROPIC_NAV,
          aiCreditsRoutingMode: 'off',
          fileAutoSave: false,
          inAppBrowserLocalServersOnly: false,
          openAppLinksInBuiltInBrowser: true,
          useAsSystemDefaultBrowser: false,
          inAppNotifications: {
            enabled: true,
            categories: {
              chat: true,
              script: true,
              hook: true,
              gitCommit: true,
              gitPush: true,
              prCreate: true,
              pipeline: true,
              terminal: true,
              runComment: true,
              activation: true,
            },
          },
          terminalDrawerCollapsed: true,
          terminalDrawerHeight: 300,
          terminalDrawerActiveTabId: 'terminal',
          disabledTerminalShellProfileIds: [],
          terminalPresets: [],
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
              runComment: true,
              activation: true,
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
              runComment: 'Default',
              activation: 'Default',
            },
          },
          voiceDictationEnabled: true,
          closeToTray: true,
          globalFocusShortcutEnabled: false,
          globalFocusShortcut: 'CommandOrControl+Shift+O',
          activationQuietHours: { enabled: true, startHour: 22, endHour: 8 },
          promotionalNotifications: {
            enabled: true,
            arbitrary: true,
          },
          mcpHttpAuthDefaultHandler: 'canopy',
          fileIndexing: {
            disabledBuiltinGlobIds: [],
            customGlobs: [],
          },
          planDetection: {
            disabledBuiltinRuleIds: [],
            customRules: [],
          },
          fileLabels: [],
          changedFilesHiddenLabelIds: [],
          autoDownloadUpdates: true,
          showDiagnosticsPill: true,
          onboardingCompleted: [],
          releaseHighlightsLastSeenVersion: null,
          guestSessionCount: 0,
          guestUpgradeNudgeLastShownSessionCount: 0,
          planModeHint: { version: 1, generation: 0 },
          personalWorkspaceCatalogSync: 'off',
          personalCatalogOfferSeen: false,
          personalCatalogNotice: null,
          telemetrySharing: {
            transcripts: 'off',
            plans: 'off',
            metadata: 'off',
            summaries: 'off',
          },
          telemetrySharingPromptSeen: false,
          gitExecutablePath: '',
          appAdvisorProjectAgentAccess: {
            mode: 'enabled',
            selectedOwners: [],
          },
          codeGraph: {
            mode: 'enabled',
            selectedWorkspaceIds: [],
            generationTimeoutMinutes: 30,
          },
        },
      },
      null,
      2,
    );
    expect(rawOutput).toBe(expected);
  });

  it('preserves the existing file mode when replacing preferences atomically', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ worktreePanelPercent: 40, sidebarCollapsed: false }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedStat.mockResolvedValue(createMockStats(0o600));
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { sidebarCollapsed: true });

    expect(mockedWriteFileAtomically).toHaveBeenCalledWith(
      '/mock/userData/preferences.json',
      expect.any(String),
      { ...PREFERENCES_WRITE, mode: 0o600 },
    );
  });

  it('refuses a save without writing defaults when existing file is unreadable', async () => {
    mockedReadFile.mockRejectedValue(new Error('EACCES'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await expect(
      saveHandler({}, { sidebarCollapsed: true }),
    ).rejects.toMatchObject({
      code: 'PREFERENCES_RECOVERY_REQUIRED',
    });
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('merges saves with last-good preferences when the current file is corrupt', async () => {
    mockedReadFile.mockImplementation((filePath) => {
      const path = readFileMockPath(filePath);
      if (path.endsWith('preferences.generation.json'))
        return Promise.reject(createEnoentError());
      if (path.endsWith('preferences.last-good.json')) {
        return Promise.resolve(
          makePrefsFile({ worktreePanelPercent: 52, sidebarCollapsed: false }),
        );
      }
      return Promise.resolve('');
    });
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await saveHandler({}, { sidebarCollapsed: true });

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 52,
      sidebarCollapsed: true,
    });
    expect(findPreferencesWriteContent()).toEqual(
      expect.stringContaining('"worktreePanelPercent": 52'),
    );
    expect(findLastGoodWriteContent()).toEqual(
      expect.stringContaining('"worktreePanelPercent": 52'),
    );
  });

  it('normalizes non-number worktreePanelPercent in save input', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = await saveHandler(
      {},
      { worktreePanelPercent: 'bad' as unknown as number },
    );

    expect(result).toMatchObject({
      ...NEW_DEFAULTS,
      worktreePanelPercent: 32,
      sidebarCollapsed: false,
    });
  });

  it('writes to the correct file path', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { worktreePanelPercent: 40 });

    // The generation record, main, then last-good: durable writes by the
    // admitted module.
    expect(mockedWriteFileAtomically.mock.calls).toEqual([
      [
        join('/mock/userData', 'preferences.generation.json'),
        JSON.stringify({ version: 1, generation: 1 }),
        { ...PREFERENCES_WRITE, mode: undefined },
      ],
      [
        '/mock/userData/preferences.json',
        expect.any(String),
        { ...PREFERENCES_WRITE, mode: undefined },
      ],
      [
        join('/mock/userData', 'preferences.last-good.json'),
        expect.any(String),
        { ...PREFERENCES_WRITE, mode: undefined },
      ],
    ]);
  });

  it('partial save merges per-provider model/thinking fields correctly', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({
        worktreePanelPercent: 40,
        sidebarCollapsed: true,
        defaultChatModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
          ollama: null,
        },
      }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      {
        defaultWorktreeModelByProvider: {
          claude: {
            model: 'claude-haiku-4-5-20251001',
            thinkingLevel: 'high',
          },
          codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
          ollama: null,
        },
      },
    )) as PreferencesData;

    expect(result.defaultChatModelByProvider.claude.model).toBe('sonnet');
    expect(result.defaultChatModelByProvider.claude.thinkingLevel).toBe('high');
    expect(result.defaultWorktreeModelByProvider.claude.model).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(result.defaultWorktreeModelByProvider.claude.thinkingLevel).toBe(
      'high',
    );
    expect(result.worktreePanelPercent).toBe(40);
    expect(result.sidebarCollapsed).toBe(true);
  });

  it('saves provider HTTP MCP auth handling', async () => {
    mockedReadFile.mockResolvedValue(makePrefsFile({}));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      { mcpHttpAuthDefaultHandler: 'provider' },
    )) as PreferencesData;

    expect(result.mcpHttpAuthDefaultHandler).toBe('provider');
    expect(findPreferencesWriteContent()).toEqual(
      expect.stringContaining('"mcpHttpAuthDefaultHandler": "provider"'),
    );
  });

  it('normalizes invalid per-provider model values during save', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      {
        defaultChatModelByProvider: {
          claude: {
            model: 'invalid-model',
            thinkingLevel: 'high',
          },
          codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
          ollama: null,
        },
      },
    )) as PreferencesData;

    expect(result.defaultChatModelByProvider.claude.model).toBe('opus[1m]');
  });

  it('normalizes invalid per-provider thinking level values during save', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      {
        defaultChatModelByProvider: {
          claude: {
            model: 'opus[1m]',
            thinkingLevel: 'extreme' as unknown as ThinkingLevel,
          },
          codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
          ollama: null,
        },
      },
    )) as PreferencesData;

    expect(result.defaultChatModelByProvider.claude.thinkingLevel).toBe('high');
  });

  it('normalizes invalid worktree summary model and thinking level values during save', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      {
        worktreeSummaryModel:
          'invalid-model' as PreferencesData['worktreeSummaryModel'],
        worktreeSummaryThinkingLevel:
          'extreme' as PreferencesData['worktreeSummaryThinkingLevel'],
      },
    )) as PreferencesData;

    expect(result.worktreeSummaryModel).toBe('haiku');
    expect(result.worktreeSummaryThinkingLevel).toBe('off');
  });

  it.each(['ollama-offline-model', 'unknown-handoff-model'])(
    'rejects new unavailable handoff selection %s without substituting Haiku',
    async (model) => {
      mockedReadFile.mockResolvedValue(
        makePrefsFile({ handoffSummaryModel: 'sonnet' }),
      );
      await expect(
        saveHandler({}, { handoffSummaryModel: model }),
      ).rejects.toThrow('Choose an available conversation handoff model');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    },
  );

  it('keeps a saved unavailable local handoff through unrelated and unchanged-model writes', async () => {
    mockedReadFile.mockResolvedValue(
      makePrefsFile({ handoffSummaryModel: 'ollama-offline-model' }),
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    for (const patch of [
      { colorMode: 'dark' } as const,
      { handoffSummaryModel: 'ollama-offline-model' },
    ]) {
      await expect(saveHandler({}, patch)).resolves.toEqual(
        expect.objectContaining({
          handoffSummaryModel: 'ollama-offline-model',
        }),
      );
    }
  });

  it('records a saved local memory model as chosen and validates it', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const rejected = (await saveHandler(
      {},
      {
        localMemoryModel: 'invalid model',
        localMemoryThinkingLevel:
          'extreme' as PreferencesData['localMemoryThinkingLevel'],
      },
    )) as PreferencesData;
    expect(rejected).toMatchObject({
      localMemoryModel: 'gpt-6.1-sol',
      localMemoryModelSetByUser: false,
      localMemoryThinkingLevel: 'high',
    });

    // A well-formed choice that cannot run right now is kept as chosen;
    // memory runs skip until it can, instead of using another provider.
    const unavailable = (await saveHandler(
      {},
      { localMemoryModel: 'ollama-offline-model' },
    )) as PreferencesData;
    expect(unavailable).toMatchObject({
      localMemoryModel: 'ollama-offline-model',
      localMemoryModelSetByUser: true,
    });

    const accepted = (await saveHandler(
      {},
      { localMemoryModel: 'sonnet', localMemoryThinkingLevel: 'low' },
    )) as PreferencesData;
    expect(accepted).toMatchObject({
      localMemoryModel: 'sonnet',
      localMemoryModelSetByUser: true,
      localMemoryThinkingLevel: 'low',
    });
  });

  it('keeps an explicitly unmarked summary model on the default', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      { summaryModel: 'sonnet', summaryModelSetByUser: false },
    )) as PreferencesData;
    expect(result).toMatchObject({
      summaryModel: 'gpt-6-luna',
      summaryModelSetByUser: false,
    });
  });

  it('saves with Codex per-provider models and preserves them correctly', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      {
        defaultChatProvider: 'codex',
        defaultChatModelByProvider: {
          claude: { model: 'opus[1m]', thinkingLevel: 'high' },
          codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
          ollama: null,
        },
        defaultWorktreeProvider: 'codex',
        defaultWorktreeModelByProvider: {
          claude: { model: 'opus[1m]', thinkingLevel: 'high' },
          codex: { model: 'gpt-5.3-codex-spark', thinkingLevel: 'high' },
          ollama: null,
        },
        prGenerationModel:
          'gpt-5.3-codex-spark' as PreferencesData['prGenerationModel'],
        branchNamingModel:
          'gpt-5.4-mini' as PreferencesData['branchNamingModel'],
      },
    )) as PreferencesData;

    expect(result.defaultChatProvider).toBe('codex');
    expect(result.defaultChatModelByProvider.codex.model).toBe(
      DEFAULT_CODEX_MODEL,
    );
    expect(result.defaultWorktreeModelByProvider.codex.model).toBe(
      'gpt-5.3-codex-spark',
    );
    expect(result.prGenerationModel).toBe('gpt-5.3-codex-spark');
    expect(result.branchNamingModel).toBe('gpt-5.6-luna');

    const writtenContent = JSON.parse(
      mockedWriteFile.mock.calls[0][1] as string,
    ) as PreferencesFile;
    expect(
      writtenContent.preferences.defaultChatModelByProvider.codex.model,
    ).toBe(DEFAULT_CODEX_MODEL);
    expect(
      writtenContent.preferences.defaultWorktreeModelByProvider.codex.model,
    ).toBe('gpt-5.3-codex-spark');
    expect(writtenContent.preferences.prGenerationModel).toBe(
      'gpt-5.3-codex-spark',
    );
    expect(writtenContent.preferences.branchNamingModel).toBe('gpt-5.6-luna');
  });

  it('saves supported ollama per-provider selection', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      {
        defaultChatProvider: 'ollama',
        defaultChatModelByProvider: {
          claude: { model: 'opus[1m]', thinkingLevel: 'high' },
          codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
          ollama: { model: 'ollama-qwen3-coder', thinkingLevel: 'high' },
        },
        defaultWorktreeProvider: 'ollama',
        defaultWorktreeModelByProvider: {
          claude: { model: 'opus[1m]', thinkingLevel: 'high' },
          codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
          ollama: { model: 'ollama-qwen3-coder', thinkingLevel: 'high' },
        },
        summaryModel: 'ollama-qwen3-coder' as PreferencesData['summaryModel'],
        worktreeSummaryModel:
          'ollama-qwen3-coder' as PreferencesData['worktreeSummaryModel'],
        prGenerationModel:
          'ollama-qwen3-coder' as PreferencesData['prGenerationModel'],
        commitGenerationModel:
          'ollama-qwen3-coder' as PreferencesData['commitGenerationModel'],
        branchNamingModel:
          'ollama-qwen3-coder' as PreferencesData['branchNamingModel'],
      },
    )) as PreferencesData;

    expect(result.defaultChatProvider).toBe('ollama');
    expect(result.defaultChatModelByProvider.ollama?.model).toBe(
      'ollama-qwen3-coder',
    );
    expect(result.defaultWorktreeModelByProvider.ollama?.model).toBe(
      'ollama-qwen3-coder',
    );
    expect(result.summaryModel).toBe('ollama-qwen3-coder');
    expect(result.worktreeSummaryModel).toBe('ollama-qwen3-coder');
    expect(result.prGenerationModel).toBe('ollama-qwen3-coder');
    expect(result.commitGenerationModel).toBe('ollama-qwen3-coder');
    expect(result.branchNamingModel).toBe('ollama-qwen3-coder');

    const writtenContent = JSON.parse(
      mockedWriteFile.mock.calls[0][1] as string,
    ) as PreferencesFile;
    expect(
      writtenContent.preferences.defaultChatModelByProvider.ollama?.model,
    ).toBe('ollama-qwen3-coder');
    expect(writtenContent.preferences.branchNamingModel).toBe(
      'ollama-qwen3-coder',
    );
  });

  it('normalizes auditRetentionDays and updates observability retention', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      { auditRetentionDays: 0 },
    )) as PreferencesData;

    expect(result.auditRetentionDays).toBe(1);
    expect(setRetentionDaysMock).toHaveBeenCalledWith(1);
  });

  it('normalizes codexAppServerIdleTimeoutMinutes and updates active sessions', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      { codexAppServerIdleTimeoutMinutes: 121.4 },
    )) as PreferencesData;

    expect(result.codexAppServerIdleTimeoutMinutes).toBe(120);
    expect(updateCodexSessionIdleTimeoutMinutesMock).toHaveBeenCalledWith(120);
    expect(updateCodexRuntimeIdleTimeoutMinutesMock).toHaveBeenCalledWith(120);

    const writtenContent = JSON.parse(
      mockedWriteFile.mock.calls[0][1] as string,
    ) as PreferencesFile;
    expect(writtenContent.preferences.codexAppServerIdleTimeoutMinutes).toBe(
      120,
    );
  });

  it('normalizes claudeSessionIdleTimeoutMinutes and updates existing sessions', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const result = (await saveHandler(
      {},
      { claudeSessionIdleTimeoutMinutes: 0.4 },
    )) as PreferencesData;

    expect(result.claudeSessionIdleTimeoutMinutes).toBe(1);
    expect(result.codexAppServerIdleTimeoutMinutes).toBe(10);
    expect(updateClaudeSessionIdleTimeoutMinutesMock).toHaveBeenCalledWith(1);
    expect(updateCodexSessionIdleTimeoutMinutesMock).toHaveBeenCalledWith(10);

    const writtenContent = JSON.parse(
      mockedWriteFile.mock.calls[0][1] as string,
    ) as PreferencesFile;
    expect(writtenContent.preferences.claudeSessionIdleTimeoutMinutes).toBe(1);
  });

  it('defaults claudeSessionIdleTimeoutMinutes to 10 and clamps it to 120', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    const defaults = (await saveHandler({}, {})) as PreferencesData;
    expect(defaults.claudeSessionIdleTimeoutMinutes).toBe(10);

    const clamped = (await saveHandler(
      {},
      { claudeSessionIdleTimeoutMinutes: 500 },
    )) as PreferencesData;
    expect(clamped.claudeSessionIdleTimeoutMinutes).toBe(120);
  });

  it('marks worktree Codex sessions for recreation when worktree multi-agent preference is saved', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { codexMultiAgentWorktreeChatsEnabled: false });

    expect(markCodexSessionsForNextTurnRecreationMock).toHaveBeenCalledWith(
      'worktree',
    );
    expect(markCodexSessionsForNextTurnRecreationMock).not.toHaveBeenCalledWith(
      'standalone',
    );
  });

  it('marks standalone Codex sessions for recreation when standalone multi-agent preference is saved', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { codexMultiAgentStandaloneChatsEnabled: false });

    expect(markCodexSessionsForNextTurnRecreationMock).toHaveBeenCalledWith(
      'standalone',
    );
    expect(markCodexSessionsForNextTurnRecreationMock).not.toHaveBeenCalledWith(
      'worktree',
    );
  });

  it('marks App Advisor Codex sessions for recreation when its multi-agent preference is saved', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    await saveHandler({}, { codexMultiAgentAppAdvisorEnabled: false });
    expect(markCodexSessionsForNextTurnRecreationMock).toHaveBeenCalledWith(
      'app-advisor',
    );
  });

  it('marks all Codex chat scopes when the concurrency limit changes', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    await saveHandler({}, { codexMaxConcurrentSubagents: 2 });
    expect(markCodexSessionsForNextTurnRecreationMock).toHaveBeenCalledWith(
      'all',
    );
  });

  it('does not mark chat sessions for recreation when only pipeline multi-agent preference is saved', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);

    await saveHandler({}, { codexMultiAgentPipelinesEnabled: false });

    expect(markCodexSessionsForNextTurnRecreationMock).not.toHaveBeenCalled();
  });
});

it.each(['explicit-only', 'proactive', 'off'] as const)(
  'persists managed consultation policy %s and refreshes both parents',
  async (mode) => {
    const saved = expectPreferencesData(
      await saveHandler({}, { managedDelegationMode: mode }),
    );
    expect(mockMarkManagedDelegation).toHaveBeenCalled();
    expect(mockUpdateManagedDelegationPolicy).toHaveBeenLastCalledWith(mode);
    expect(saved.managedDelegationMode).toBe(mode);
  },
);

it('revokes managed consultation admission before awaited profile sync completes', async () => {
  let releaseProfileSync: (() => void) | undefined;
  let markProfileSyncStarted: (() => void) | undefined;
  const profileSyncStarted = new Promise<void>((resolve) => {
    markProfileSyncStarted = resolve;
  });
  syncOnboardingProfilePreferencesMock.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseProfileSync = resolve;
        markProfileSyncStarted?.();
      }),
  );

  const save = saveHandler({}, { managedDelegationMode: 'off' });
  await profileSyncStarted;

  expect(mockUpdateManagedDelegationPolicy).toHaveBeenCalledWith('off');
  releaseProfileSync?.();
  await save;
});

it('does not return or broadcast an obsolete policy from an older concurrent save', async () => {
  let persisted = makePrefsFile({ managedDelegationMode: 'explicit-only' });
  let releaseFirstPolicyUpdate: (() => void) | undefined;
  let markFirstPolicyUpdateStarted: (() => void) | undefined;
  const firstPolicyUpdateStarted = new Promise<void>((resolve) => {
    markFirstPolicyUpdateStarted = resolve;
  });
  const firstPolicyUpdate = new Promise<void>((resolve) => {
    releaseFirstPolicyUpdate = resolve;
  });
  mockUpdateManagedDelegationPolicy
    .mockImplementationOnce(() => {
      markFirstPolicyUpdateStarted?.();
      return firstPolicyUpdate;
    })
    .mockResolvedValueOnce(undefined);
  mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
  mockedMkdir.mockResolvedValue(undefined);
  mockedWriteFile.mockImplementation((_filePath, data) => {
    if (typeof data === 'string') persisted = data;
    return Promise.resolve();
  });
  const fakeWindow = new BrowserWindow();
  const getAllWindowsSpy = jest
    .spyOn(BrowserWindow, 'getAllWindows')
    .mockReturnValue([fakeWindow]);

  try {
    const olderSave = saveHandler({}, { managedDelegationMode: 'off' });
    await firstPolicyUpdateStarted;
    const newerResult = expectPreferencesData(
      await saveHandler({}, { managedDelegationMode: 'proactive' }),
    );
    releaseFirstPolicyUpdate?.();
    const olderResult = expectPreferencesData(await olderSave);

    expect(newerResult.managedDelegationMode).toBe('proactive');
    expect(olderResult.managedDelegationMode).toBe('proactive');
    expect(
      mockedSendToWindow.mock.calls.map(
        (call) => expectPreferencesData(call[2]).managedDelegationMode,
      ),
    ).toEqual(['proactive']);
  } finally {
    getAllWindowsSpy.mockRestore();
  }
});

it('broadcasts canonical preferences after an external write during revocation', async () => {
  let persisted = makePrefsFile({
    colorMode: 'system',
    managedDelegationMode: 'explicit-only',
  });
  let releasePolicyUpdate: (() => void) | undefined;
  let markPolicyUpdateStarted: (() => void) | undefined;
  const policyUpdateStarted = new Promise<void>((resolve) => {
    markPolicyUpdateStarted = resolve;
  });
  mockUpdateManagedDelegationPolicy.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releasePolicyUpdate = resolve;
        markPolicyUpdateStarted?.();
      }),
  );
  mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
  mockedMkdir.mockResolvedValue(undefined);
  mockedWriteFile.mockImplementation((_filePath, data) => {
    if (typeof data === 'string') persisted = data;
    return Promise.resolve();
  });
  const fakeWindow = new BrowserWindow();
  const getAllWindowsSpy = jest
    .spyOn(BrowserWindow, 'getAllWindows')
    .mockReturnValue([fakeWindow]);

  try {
    const save = saveHandler({}, { managedDelegationMode: 'off' });
    await policyUpdateStarted;
    await updatePreferencesFile(() => ({ colorMode: 'dark' }));
    releasePolicyUpdate?.();
    const saved = expectPreferencesData(await save);
    const broadcastCalls = mockedSendToWindow.mock.calls;
    const broadcast = expectPreferencesData(
      broadcastCalls[broadcastCalls.length - 1]?.[2],
    );

    expect(saved.colorMode).toBe('dark');
    expect(broadcast.colorMode).toBe('dark');
    expect(broadcast.managedDelegationMode).toBe('off');
    expect(saved).not.toHaveProperty('__dataDir');
    expect(broadcast).not.toHaveProperty('__dataDir');
  } finally {
    getAllWindowsSpy.mockRestore();
  }
});

it('preserves an unset managed delegation preference without changing explicit Off', () => {
  expect(normalizePreferences({}).managedDelegationMode).toBeUndefined();
  expect(
    normalizePreferences({ managedDelegationMode: 'off' })
      .managedDelegationMode,
  ).toBe('off');
});

it('normalizes managed delegation lifetime limits to the shipped default', () => {
  expect(normalizePreferences({}).managedDelegationLifetimeLimit).toBe(512);
  expect(
    normalizePreferences({ managedDelegationLifetimeLimit: 512 })
      .managedDelegationLifetimeLimit,
  ).toBe(512);

  for (const value of [undefined, null, 0, -1, 513, 1024, 1.5, '512']) {
    expect(
      normalizePreferences({ managedDelegationLifetimeLimit: value })
        .managedDelegationLifetimeLimit,
    ).toBe(512);
  }
});

it('loads a saved lifetime limit and normalizes values above the shipped cap', async () => {
  mockedReadFile.mockResolvedValue(
    makePrefsFile({ managedDelegationLifetimeLimit: 512 }),
  );
  expect(
    expectPreferencesData(await loadHandler()).managedDelegationLifetimeLimit,
  ).toBe(512);

  mockedReadFile.mockResolvedValue(
    makeRawPrefsFile({ managedDelegationLifetimeLimit: 1024 }),
  );
  expect(
    expectPreferencesData(await loadHandler()).managedDelegationLifetimeLimit,
  ).toBe(512);
});

it('updates active lifetime policy only after the preference is committed', async () => {
  mockedReadFile.mockRejectedValue(createEnoentError());
  mockedMkdir.mockResolvedValue(undefined);
  mockedWriteFile.mockResolvedValue(undefined);
  mockedRename.mockResolvedValue(undefined);
  mockUpdateManagedDelegationLifetimeLimit.mockImplementation(() => {
    expect(mockedRename).toHaveBeenCalled();
  });
  jest
    .mocked(notifyManagedDelegationLifetimePreferencesChanged)
    .mockImplementation(() => {
      expect(mockedRename).toHaveBeenCalled();
      expect(mockUpdateManagedDelegationLifetimeLimit).toHaveBeenCalledWith(
        512,
      );
    });

  const saved = expectPreferencesData(
    await saveHandler({}, { managedDelegationLifetimeLimit: 512 }),
  );

  expect(saved.managedDelegationLifetimeLimit).toBe(512);
  expect(mockUpdateManagedDelegationLifetimeLimit).toHaveBeenCalledWith(512);
  expect(
    notifyManagedDelegationLifetimePreferencesChanged,
  ).toHaveBeenCalledTimes(1);
});

it('does not update active lifetime policy when saving preferences fails', async () => {
  mockedReadFile.mockRejectedValue(createEnoentError());
  mockedMkdir.mockResolvedValue(undefined);
  mockedWriteFile.mockRejectedValueOnce(new Error('disk full'));

  await expect(
    saveHandler({}, { managedDelegationLifetimeLimit: 512 }),
  ).rejects.toThrow('disk full');
  expect(mockUpdateManagedDelegationLifetimeLimit).not.toHaveBeenCalled();
  expect(
    notifyManagedDelegationLifetimePreferencesChanged,
  ).not.toHaveBeenCalled();
});

it('ignores the retired development variable when reporting the default to the renderer', async () => {
  const key = brandEnvName('DEVELOPMENT_DELEGATION');
  const previous = process.env[key];
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  process.env[key] = '1';
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'darwin',
  });
  mockedReadFile.mockRejectedValue(new Error('ENOENT'));
  try {
    const loaded = expectPreferencesData(await loadHandler());
    expect(loaded.managedDelegationMode).toBe('off');
  } finally {
    if (platformDescriptor)
      Object.defineProperty(process, 'platform', platformDescriptor);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

it('keeps a saved preference successful when managed revocation cleanup fails', async () => {
  mockUpdateManagedDelegationPolicy.mockRejectedValueOnce(
    new Error('revocation incomplete'),
  );

  const saved = expectPreferencesData(
    await saveHandler(
      {},
      {
        managedDelegationMode: 'off',
        codexMultiAgentWorktreeChatsEnabled: true,
      },
    ),
  );

  expect(saved.managedDelegationMode).toBe('off');
  expect(saved).toHaveProperty('__managedDelegationRevocationIncomplete', true);
  expect(markCodexSessionsForNextTurnRecreationMock).toHaveBeenCalledWith(
    'worktree',
  );
});

it.each([undefined, null, 0, -1, 65, 1.5, '2', NaN])(
  'defaults invalid managed concurrency %s to five',
  (value) => {
    expect(
      normalizePreferences({ managedDelegationMaxConcurrent: value })
        .managedDelegationMaxConcurrent,
    ).toBe(5);
  },
);
it.each([1, 2, 5, 16, 17, 64])('normalizes managed concurrency %s', (value) => {
  expect(
    normalizePreferences({ managedDelegationMaxConcurrent: value })
      .managedDelegationMaxConcurrent,
  ).toBe(value);
});

it.each([1, 2, 10])('preserves managed delegation depth %s', (value) => {
  expect(
    normalizePreferences({ managedDelegationMaxDepth: value })
      .managedDelegationMaxDepth,
  ).toBe(value);
});

it.each([undefined, null, 0, 11, -1, 1.5, '2', true])(
  'defaults invalid managed delegation depth %p to one',
  (value) => {
    expect(
      normalizePreferences({ managedDelegationMaxDepth: value })
        .managedDelegationMaxDepth,
    ).toBe(1);
  },
);

it('persists concurrency changes and updates new admissions without recreating parents', async () => {
  mockMarkManagedDelegation.mockClear();
  const saved = expectPreferencesData(
    await saveHandler({}, { managedDelegationMaxConcurrent: 2 }),
  );
  expect(saved.managedDelegationMaxConcurrent).toBe(2);
  expect(mockUpdateManagedDelegationMaxConcurrent).toHaveBeenLastCalledWith(2);
  expect(mockMarkManagedDelegation).not.toHaveBeenCalled();
});

describe('authoritative preference reads for Personal catalog cleanup', (): void => {
  it.each(['private', 'off'])(
    'reports valid enrollment preferences as authoritative: %s',
    async (preference): Promise<void> => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          preferences: { personalWorkspaceCatalogSync: preference },
        }),
      );
      expect(await readPreferencesFileDetailed()).toMatchObject({
        authority: 'ok',
        preferences: { personalWorkspaceCatalogSync: preference },
      });
      expect(mockedWriteFile).not.toHaveBeenCalled();
    },
  );
  it.each(['ENOENT', 'EACCES', 'EIO'])(
    'distinguishes absent preferences from failed reads: %s',
    async (code): Promise<void> => {
      mockedReadFile.mockRejectedValue(
        Object.assign(new Error(code), { code }),
      );
      expect(await readPreferencesFileDetailed()).toMatchObject({
        authority: code === 'ENOENT' ? 'absent' : 'unreadable',
        preferences: { personalWorkspaceCatalogSync: 'off' },
      });
      expect(mockedWriteFile).not.toHaveBeenCalled();
    },
  );
  it.each([
    '{broken',
    '{"version":2,"preferences":{}}',
    '{"version":1,"preferences":null}',
  ])(
    'does not treat corrupt preferences as consent to delete: %s',
    async (raw): Promise<void> => {
      mockedReadFile.mockResolvedValue(raw);
      expect(await readPreferencesFileDetailed()).toMatchObject({
        authority: 'unreadable',
        preferences: { personalWorkspaceCatalogSync: 'off' },
      });
      expect(mockedWriteFile).not.toHaveBeenCalled();
    },
  );
});

describe('feature sharing opt-in (CAN-3383)', () => {
  const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const request = { feature: 'organization-memory', organizationId };
  beforeEach(() => {
    mockOptInAuthority.mockReset();
    mockOptInAuthority.mockResolvedValue({
      required: {
        metadata: false,
        plans: false,
        summaries: false,
        transcripts: false,
      },
      prohibited: {
        metadata: false,
        plans: false,
        summaries: false,
        transcripts: false,
      },
    });
    mockSharingRefresh.mockReset();
    mockSharingRefresh.mockResolvedValue(undefined);
    let stored = JSON.stringify({
      version: 1,
      preferences: {
        telemetrySharing: {
          metadata: 'team',
          plans: 'private',
          summaries: 'off',
          transcripts: 'private',
        },
        telemetrySharingTier: 'paid',
      },
    });
    mockedReadFile.mockImplementation(() => Promise.resolve(stored));
    mockedWriteFile.mockImplementation((_path, data) => {
      if (typeof data === 'string') stored = data;
      return Promise.resolve();
    });
    mockedRename.mockResolvedValue(undefined);
  });
  it('writes exactly feature scopes and counts team broadening', async () => {
    const response = await findRegisteredHandler(
      'telemetry-sharing:enable-for-feature',
    )({}, request);
    expect(response).toEqual({
      status: 'saved',
      changedScopes: ['metadata', 'transcripts'],
      skippedScopes: [],
    });
    const saved = await readPreferencesFile();
    expect(saved.telemetrySharing).toEqual({
      metadata: 'organization',
      plans: 'private',
      summaries: 'off',
      transcripts: 'organization',
    });
    expect(saved.telemetrySharingTier).toBe('paid');
    expect(mockSharingRefresh).toHaveBeenCalled();
  });
  it('skips prohibited content without persisting locks', async () => {
    mockOptInAuthority.mockResolvedValue({
      required: {},
      prohibited: { transcripts: true },
    });
    expect(
      await findRegisteredHandler('telemetry-sharing:enable-for-feature')(
        {},
        request,
      ),
    ).toEqual({
      status: 'saved',
      changedScopes: ['metadata'],
      skippedScopes: ['transcripts'],
    });
    expect((await readPreferencesFile()).telemetrySharing.transcripts).toBe(
      'private',
    );
  });
  it('refuses prohibited metadata without writing', async () => {
    mockOptInAuthority.mockResolvedValue({
      required: {},
      prohibited: { metadata: true },
    });
    expect(
      await findRegisteredHandler('telemetry-sharing:enable-for-feature')(
        {},
        request,
      ),
    ).toEqual({ status: 'refused', reason: 'organization-prohibited' });
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
  it('rejects arbitrary scopes and invalid inputs', async () => {
    expect(
      await findRegisteredHandler('telemetry-sharing:enable-for-feature')(
        {},
        { feature: 'shared-runs', organizationId },
      ),
    ).toEqual({ status: 'refused', reason: 'invalid-request' });
    expect(mockOptInAuthority).not.toHaveBeenCalled();
  });
  it('reports committed settings separately from runtime application failure and retries', async () => {
    mockSharingRefresh.mockRejectedValueOnce(new Error('runtime unavailable'));
    const handler = findRegisteredHandler(
      'telemetry-sharing:enable-for-feature',
    );
    expect(await handler({}, request)).toEqual({
      status: 'saved-application-failed',
      changedScopes: ['metadata', 'transcripts'],
      skippedScopes: [],
    });
    expect((await readPreferencesFile()).telemetrySharing.metadata).toBe(
      'organization',
    );
    expect(await handler({}, request)).toEqual({
      status: 'saved',
      changedScopes: [],
      skippedScopes: [],
    });
  });
  it('revalidates authorization inside queued writes', async () => {
    mockOptInAuthority
      .mockResolvedValueOnce({ prohibited: {} })
      .mockRejectedValueOnce(new Error('lost authority'));
    expect(
      await findRegisteredHandler('telemetry-sharing:enable-for-feature')(
        {},
        request,
      ),
    ).toEqual({ status: 'refused', reason: 'account-unavailable' });
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
  it('persists device-wide dismissals without changing sharing', async () => {
    expect(
      await findRegisteredHandler('telemetry-sharing:dismiss-opt-in-hint')(
        {},
        { feature: 'statistics' },
      ),
    ).toEqual({ status: 'saved' });
    expect(
      (await readPreferencesFile()).dataSharingOptInHints?.statistics
        ?.dismissedAt,
    ).toEqual(expect.any(String));
    expect((await readPreferencesFile()).telemetrySharing.metadata).toBe(
      'team',
    );
  });
  it('refuses durable save failures without broadcasting success', async () => {
    mockedWriteFile.mockRejectedValue(new Error('secret disk error'));
    expect(
      await findRegisteredHandler('telemetry-sharing:enable-for-feature')(
        {},
        request,
      ),
    ).toEqual({ status: 'refused', reason: 'save-failed' });
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(mockSharingRefresh).not.toHaveBeenCalled();
  });
  it('does not acknowledge a failed dismissal', async () => {
    mockedWriteFile.mockRejectedValue(new Error('disk error'));
    expect(
      await findRegisteredHandler('telemetry-sharing:dismiss-opt-in-hint')(
        {},
        { feature: 'statistics' },
      ),
    ).toEqual({ status: 'refused', reason: 'save-failed' });
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });
  it('keeps concurrent dismissals, generic settings, and untouched feature scopes', async () => {
    await Promise.all([
      findRegisteredHandler('telemetry-sharing:enable-for-feature')(
        {},
        request,
      ),
      findRegisteredHandler('telemetry-sharing:dismiss-opt-in-hint')(
        {},
        { feature: 'statistics' },
      ),
      updatePreferencesFile(() => ({ colorMode: 'dark' })),
    ]);
    const latest = await readPreferencesFile();
    expect(latest.colorMode).toBe('dark');
    expect(latest.dataSharingOptInHints?.statistics?.dismissedAt).toEqual(
      expect.any(String),
    );
    expect(latest.telemetrySharing).toEqual({
      metadata: 'organization',
      plans: 'private',
      summaries: 'off',
      transcripts: 'organization',
    });
  });
  it('broadcasts only after the atomic preference commit finishes', async () => {
    const fakeWindow = new BrowserWindow();
    const windows = jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([fakeWindow]);
    let finishCommit: (() => void) | undefined;
    mockedRename.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCommit = resolve;
        }),
    );
    const result = findRegisteredHandler(
      'telemetry-sharing:enable-for-feature',
    )({}, request);
    // A save reads its generation record (CAN-5154) before main's rename.
    for (let attempt = 0; attempt < 20 && !finishCommit; attempt++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finishCommit).toEqual(expect.any(Function));
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    finishCommit?.();
    await result;
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      fakeWindow,
      'preferences:synced',
      expect.any(Object),
    );
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      fakeWindow,
      'preferences:changed',
    );
    windows.mockRestore();
  });
  describe('personal shared-projects opt-in', () => {
    const personalRequest = {
      feature: 'shared-projects',
      organizationId: null,
    };
    let personalStored: string;
    function seed(telemetrySharing: Record<string, string>): void {
      personalStored = JSON.stringify({
        version: 1,
        preferences: { telemetrySharing, telemetrySharingTier: 'free' },
      });
    }
    beforeEach(() => {
      mockPersonalOptInAuthority.mockReset();
      mockPersonalOptInAuthority.mockResolvedValue(undefined);
      seed({
        metadata: 'off',
        plans: 'organization',
        summaries: 'off',
        transcripts: 'team',
      });
      mockedReadFile.mockImplementation(() => Promise.resolve(personalStored));
      mockedWriteFile.mockImplementation((_path, data) => {
        if (typeof data === 'string') personalStored = data;
        return Promise.resolve();
      });
    });
    it('raises Off metadata to Just me and leaves other scopes alone', async () => {
      expect(
        await findRegisteredHandler('telemetry-sharing:enable-for-feature')(
          {},
          personalRequest,
        ),
      ).toEqual({
        status: 'saved',
        changedScopes: ['metadata'],
        skippedScopes: [],
      });
      const saved = await readPreferencesFile();
      expect(saved.telemetrySharing).toEqual({
        metadata: 'private',
        plans: 'organization',
        summaries: 'off',
        transcripts: 'team',
      });
      expect(saved.dataSharingOptInHistory).toHaveLength(1);
      expect(typeof saved.dataSharingOptInHistory?.[0]?.enabledAt).toBe(
        'string',
      );
      expect(saved.dataSharingOptInHistory?.[0]?.sharing).toEqual({
        metadata: 'off',
        plans: 'organization',
        summaries: 'off',
        transcripts: 'team',
      });
      // The legacy tier marker is kept as read, never rewritten.
      expect(saved.telemetrySharingTier).toBe('free');
      expect(mockOptInAuthority).not.toHaveBeenCalled();
      expect(mockPersonalOptInAuthority).toHaveBeenCalled();
      expect(mockSharingRefresh).toHaveBeenCalled();
    });
    it.each(['private', 'team', 'organization'])(
      'never changes metadata already shared as %s',
      async (metadata) => {
        seed({
          metadata,
          plans: 'off',
          summaries: 'off',
          transcripts: 'off',
        });
        expect(
          await findRegisteredHandler('telemetry-sharing:enable-for-feature')(
            {},
            personalRequest,
          ),
        ).toEqual({ status: 'saved', changedScopes: [], skippedScopes: [] });
        const saved = await readPreferencesFile();
        expect(saved.telemetrySharing.metadata).toBe(metadata);
        expect(saved.dataSharingOptInHistory).toBeUndefined();
      },
    );
    it('refuses a personal audience for any other feature', async () => {
      expect(
        await findRegisteredHandler('telemetry-sharing:enable-for-feature')(
          {},
          { feature: 'organization-memory', organizationId: null },
        ),
      ).toEqual({ status: 'refused', reason: 'invalid-request' });
      expect(mockPersonalOptInAuthority).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
    it('refuses without a usable account', async () => {
      mockPersonalOptInAuthority.mockRejectedValue(
        new DataSharingOptInError('account-unavailable'),
      );
      expect(
        await findRegisteredHandler('telemetry-sharing:enable-for-feature')(
          {},
          personalRequest,
        ),
      ).toEqual({ status: 'refused', reason: 'account-unavailable' });
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
    it('classifies an unexpected authority failure as account-unavailable', async () => {
      mockPersonalOptInAuthority
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('lost account'));
      expect(
        await findRegisteredHandler('telemetry-sharing:enable-for-feature')(
          {},
          personalRequest,
        ),
      ).toEqual({ status: 'refused', reason: 'account-unavailable' });
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
  });
  it('normalizes only allowlisted hints and valid timestamps', () => {
    expect(
      normalizePreferences({
        dataSharingOptInHints: {
          statistics: { dismissedAt: '2026-10-05T12:00:00-04:00' },
          leaderboards: { dismissedAt: 'bad' },
          unknown: { dismissedAt: '2026-10-05' },
        },
      }).dataSharingOptInHints,
    ).toEqual({ statistics: { dismissedAt: '2026-10-05T16:00:00.000Z' } });
  });
});

describe('CAN-4010 legacy preference saves', () => {
  const answerAt = '2026-10-19T00:00:00.000Z';
  const planAt = '2026-10-20T00:00:00.000Z';
  const source = {
    colorMode: 'dark',
    homeOnboardingSuggestions: {
      entries: {
        notifications: { dismissedAt: answerAt },
        'plan-mode': { completedAt: planAt },
        github: { completedAt: planAt },
      },
    },
  };
  it('derives answers without a migration write and retries a failed ordinary commit', async () => {
    mockedReadFile.mockResolvedValue(makeRawPrefsFile(source));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRename.mockRejectedValueOnce(new Error('commit failed'));
    const loaded = await readPreferencesFile();
    expect(loaded.osNotificationOfferAnsweredAt).toBe(answerAt);
    expect(mockedWriteFile).not.toHaveBeenCalled();
    await expect(
      updatePreferencesFile(() => ({ sidebarCollapsed: true })),
    ).rejects.toThrow('commit failed');
    const saved = await updatePreferencesFile(() => ({
      sidebarCollapsed: true,
      homeOnboardingSuggestions: undefined,
    }));
    expect(saved.osNotificationOfferAnsweredAt).toBe(answerAt);
    expect(saved.homeOnboardingSuggestions?.entries).toEqual({
      'plan-mode': { completedAt: planAt },
    });
    expect(saved.colorMode).toBe('dark');
  });
  it('serializes unrelated saves without losing notification or sibling history', async () => {
    let persisted = makeRawPrefsFile(source);
    mockedReadFile.mockImplementation(() => Promise.resolve(persisted));
    mockedMkdir.mockResolvedValue(undefined);
    let pending = '';
    mockedWriteFile.mockImplementation((_path, data) => {
      if (typeof data === 'string') pending = data;
      return Promise.resolve();
    });
    mockedRename.mockImplementation(() => {
      persisted = pending;
      return Promise.resolve();
    });
    await Promise.all([
      updatePreferencesFile(() => ({ sidebarCollapsed: true })),
      updatePreferencesFile(() => ({ colorMode: 'light' })),
    ]);
    const file: unknown = JSON.parse(persisted);
    expect(file).toHaveProperty(
      'preferences',
      expect.objectContaining({
        sidebarCollapsed: true,
        colorMode: 'light',
        osNotificationOfferAnsweredAt: answerAt,
      }),
    );
    expect(file).toHaveProperty(
      'preferences.homeOnboardingSuggestions.entries',
      {
        'plan-mode': { completedAt: planAt },
      },
    );
  });
});
