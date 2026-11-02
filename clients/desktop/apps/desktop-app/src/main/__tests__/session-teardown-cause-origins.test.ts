import type { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type * as AgentTranscriptModule from '@canopy/agent-transcript';

const mockMarkSessionTeardownCause = jest.fn();
const mockBuildSessionKey = jest.fn(
  (projectId: string, worktreeId: string, chatId: string) =>
    `${projectId}/${worktreeId}/${chatId}`,
);
const mockGetSession = jest.fn();
const mockGetSessionProviderType = jest.fn();
const mockGetActiveChatIds = jest.fn(() => ['chat-1']);
const mockGetActiveSessionInfos = jest.fn(() => [
  { projectId: 'project-1', worktreeId: 'entry-1', chatId: 'chat-1' },
  { projectId: 'project-1', worktreeId: 'entry-1', chatId: 'chat-2' },
]);
const mockCancelSession = jest.fn(() => Promise.resolve());
const mockCancelChatTurn = jest.fn(
  (
    target: Parameters<typeof ChatTurnCancel.cancelChatTurn>[0],
  ): ReturnType<typeof ChatTurnCancel.cancelChatTurn> =>
    Promise.resolve({
      context: { target, session: undefined, fence: undefined },
      outcome: 'cancelled',
    }),
);
const mockDestroySession = jest.fn(() => Promise.resolve());
const mockDestroyWorktreeSessions = jest.fn(() => Promise.resolve());
type MockQuery = (params: Parameters<typeof claudeQuery>[0]) => unknown;
const mockQuery: jest.MockedFunction<MockQuery> = jest.fn();
const mockSpawnClaudeCodeProcessOffMain = jest.fn();
const mockGetSessionKeyOwnership = jest.fn((): string => 'registered');

jest.mock('../agents/session-manager', () => ({
  // The session under test is its key's registered instance (CAN-4833).
  get getSessionKeyOwnership(): typeof mockGetSessionKeyOwnership {
    return mockGetSessionKeyOwnership;
  },
  getSessionInstanceId: (): string => 'session-instance-1',
  get buildSessionKey(): typeof mockBuildSessionKey {
    return mockBuildSessionKey;
  },
  get destroySession(): typeof mockDestroySession {
    return mockDestroySession;
  },
  get destroyWorktreeSessions(): typeof mockDestroyWorktreeSessions {
    return mockDestroyWorktreeSessions;
  },
  get getActiveChatIds(): typeof mockGetActiveChatIds {
    return mockGetActiveChatIds;
  },
  get getActiveSessionInfos(): typeof mockGetActiveSessionInfos {
    return mockGetActiveSessionInfos;
  },
  get getSession(): typeof mockGetSession {
    return mockGetSession;
  },
  get getSessionProviderType(): typeof mockGetSessionProviderType {
    return mockGetSessionProviderType;
  },
  getChildToolLiveness: jest.fn(() => ({ kind: 'no-live-session' })),
  markChatSessionIdle: jest.fn(),
  markSessionForNextTurnRecreation: jest.fn(),
  get markSessionTeardownCause(): typeof mockMarkSessionTeardownCause {
    return mockMarkSessionTeardownCause;
  },
  drainChatSessionEvents: jest.fn(() => Promise.resolve()),
  suppressCodexAuthenticationRecovery: jest.fn(),
  registerSession: jest.fn(),
  unregisterSession: jest.fn(),
  markTurnActive: jest.fn(),
  markTurnIdle: jest.fn(),
  noteSessionMessageQueued: jest.fn(),
  recordSessionEvent: jest.fn(),
  createSessionPhaseTimer: jest.fn(() => jest.fn()),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  recordSessionAccountProxyRoute: jest.fn(),
  resetSessionLiveBackgroundTasks: jest.fn(),
  SessionUnavailableForTaskStopError: class SessionUnavailableForTaskStopError extends Error {},
}));

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): unknown => mockChatStateService,
}));

jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: (): unknown => mockChatQueueService,
}));

jest.mock('../agents/background-work', () => ({
  assertChatCanClose: jest.fn(),
  assertWorktreeCanBeRemoved: jest.fn(),
}));

jest.mock('../agents/delegation/lifecycle', () => ({
  hasDelegationLifecycle: jest.fn(() => false),
  closeDelegationScope: jest.fn(() => Promise.resolve()),
}));

const mockRegisteredHandlers = new Map<string, unknown>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: unknown): void => {
    mockRegisteredHandlers.set(channel, handler);
  },
}));

const mockArchivedTab = {
  id: 'chat-1',
  title: 'Chat',
  messages: [],
};
const mockArchiveCompatibilityTab = jest.fn(() =>
  Promise.resolve({ archived: [{ tab: mockArchivedTab }] }),
);
const mockChatStateService = {
  inputDelivery: {
    stop: jest.fn(async (_request: unknown, cancel: () => Promise<void>) =>
      cancel(),
    ),
  },
  getCompatibilityTabs: jest.fn(() =>
    Promise.resolve({ tabs: [mockArchivedTab] }),
  ),
  archiveCompatibilityTab: mockArchiveCompatibilityTab,
  runWithScopeDeletionLifecycle: jest.fn(
    async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
      operation(),
  ),
  runWithScopeDeletion: jest.fn(
    async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
      operation(),
  ),
};
const mockChatQueueService = {
  invalidatePendingInputOperations: jest.fn(),
  beginWorktreeDeletion: jest.fn(() => ({
    commit: jest.fn(),
    rollback: jest.fn(),
  })),
};

const mockCancelActiveReload = jest.fn();
jest.mock('../deferred-tools/reload-coordinator', () => ({
  deferredToolsReloadCoordinator: {
    get cancelActiveReload(): typeof mockCancelActiveReload {
      return mockCancelActiveReload;
    },
    unregisterResumeHandler: jest.fn(),
  },
}));

jest.mock('../lib/chat-archives', () => ({
  toArchivedChatSummary: jest.fn(() => ({ id: 'archive-1' })),
}));

jest.mock('../lib/persisted-chat-settle', () => ({
  settlePersistedInterruptedMessages: jest.fn((messages: unknown) => messages),
}));

jest.mock('../lib/workspace-persistence', () => ({
  setBeforeProjectPluginDefaultsChangeHandler: jest.fn(),
}));

jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: jest.fn(() => false),
  getWorkspaceType: jest.fn(() => 'single-repo'),
}));

jest.mock('../lib/read-only-scope', () => ({
  assertWritableScope: jest.fn(),
}));

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
  validateMessageAnchorId: jest.fn(),
  validateWorktreeChatScope: jest.fn(),
}));

jest.mock('../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({ worktreeChatArchived: jest.fn() })),
}));

jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    removeDelegateWatchersForChat: jest.fn(() => Promise.resolve()),
    commitLocalScopeCancellation: jest.fn(),
    releaseLocalScopeFence: jest.fn(() => Promise.resolve()),
  })),
}));

jest.mock('../lib/cowork-work-entries', () => ({
  listWorkEntries: jest.fn(() =>
    Promise.resolve([
      { id: 'entry-1', title: 'Entry', createdAt: '2026-10-01T00:00:00.000Z' },
    ]),
  ),
  listWorkEntryChatSummaries: jest.fn(() =>
    Promise.resolve([{ entryId: 'entry-1', chats: [{ id: 'chat-1' }] }]),
  ),
  removeWorkEntryRow: jest.fn(() => Promise.resolve()),
}));

jest.mock('../lib/archived-container-retention', () => ({
  resolveContainerRetentionDays: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('../lib/archived-container-capture', () => ({
  captureWorkEntryArchivedContainer: jest.fn(() => Promise.resolve()),
}));

jest.mock('../lib/archived-containers', () => ({
  broadcastArchivedContainersChanged: jest.fn(),
  withArchivedWorkspaceOperationLock: jest.fn(
    (_projectId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: jest.fn(() => ({
    drainWorktreeForDeletion: jest.fn(() => Promise.resolve()),
  })),
}));

jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));

jest.mock('../lib/workspace-activity', () => ({
  runWithWorkspaceTargetActivityDeletion: jest.fn(
    (
      _workspaceId: string,
      _entryId: string,
      operation: () => Promise<unknown>,
    ) => operation(),
  ),
}));

jest.mock('../services/chat-service', () => ({
  projectAppAdvisorChatSummaries: jest.fn(),
  projectAppAdvisorChatSummariesStrict: jest.fn(),
  projectAppAdvisorChatSummaryRemovals: jest.fn(),
  projectWorktreeChatSummaries: jest.fn(),
  projectWorktreeChatSummariesStrict: jest.fn(),
  projectWorktreeChatSummaryRemovals: jest.fn(),
  projectWorktreeChatTodos: jest.fn(),
  projectWorktreeChatTodosStrict: jest.fn(),
  projectWorktreeChatTodoRemovals: jest.fn(),
}));

jest.mock('../lib/adhoc-migrate-tabs', () => ({
  adhocMigrateWorktreeTabs: jest.fn(),
}));

jest.mock('../lib/worktree-open-tabs-fork', () => ({
  SourceApprovalChangedDuringBranchError: class SourceApprovalChangedDuringBranchError extends Error {},
  forkOpenWorktreeTabs: jest.fn(),
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  isPersistedChatTab: jest.fn(() => true),
}));

jest.mock('../lib/inherited-plugin-defaults-normalization', () => ({
  normalizeWorkspaceChatsForInheritedPluginDefaults: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToWindowDetailed: jest.fn(),
}));

jest.mock('../canopy-runtime/core-chat-command-adapter', () => ({
  createChatCommandDispatchOptions: jest.fn(),
  dispatchTrustedChatCommand: jest.fn(),
}));

jest.mock('../portal/adapters/mcp-adapter', () => ({
  projectWorktreeMcpServersForChat: jest.fn(),
}));

jest.mock('../portal/portal-event-bus', () => ({
  isCanopyPortalActive: jest.fn(() => false),
}));

jest.mock('../services/pipeline-run-chat-links', () => ({
  getPipelineRunChatLinks: jest.fn(() => ({
    refresh: jest.fn(() => Promise.resolve()),
    noteChatsMaterialized: jest.fn(),
  })),
}));

jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveChatArchivesFilePath: jest.fn(),
  resolveChatTabsFilePath: jest.fn(),
}));

jest.mock('../canopy-cloud/mcp-connections', () => ({
  listAccountMcpConnections: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../mcp/account-catalog', () => ({
  ACCOUNT_MCP_REF_LOADER_WAIT: 0,
  normalizeAccountMcpSelections: jest.fn(),
  normalizeAccountMcpTombstones: jest.fn(),
}));

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  get query(): typeof mockQuery {
    return mockQuery;
  },
}));

jest.mock('../agents/claude-process-host-runner', () => ({
  get spawnClaudeCodeProcessOffMain(): typeof mockSpawnClaudeCodeProcessOffMain {
    return mockSpawnClaudeCodeProcessOffMain;
  },
  withholdClaudeProcessStdoutCreditUntil: jest.fn(),
}));

jest.mock('../agents/delegation/gate', () => ({
  managedDelegationEnabled: jest.fn(() => false),
}));

jest.mock('../lib/process-kill', () => ({
  killChildProcessGroup: jest.fn(),
}));

jest.mock('../lib/preferences-store', () => ({
  readLatestPreferencesFile: jest.fn(() => Promise.resolve({})),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/claude'),
  getBundledRtkBinaryPath: jest.fn(() => '/mock/rtk'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/rg'),
  getEnhancedEnv: jest.fn(() => ({})),
  getRtkManagedEnv: jest.fn(() => ({})),
}));

jest.mock('../plugins/plugin-resolver', () => ({
  cleanupWorktreeChatPluginDirs: jest.fn(),
  resolvePlugins: jest.fn(() =>
    Promise.resolve({
      sdkPlugins: [],
      skillPluginDir: null,
      selectedCapabilityRoots: [],
      codexProcessEnv: {},
      codexMcpServers: {},
      mcpServers: {},
      warnings: [],
    }),
  ),
}));

jest.mock('../plugins/invocable-inventory-service', () => ({
  loadCachedInventory: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(() =>
    Promise.resolve({
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    }),
  ),
}));

jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    getCanopyWorktreeMcpUrl: jest.fn(
      (sessionKey: string) => `http://127.0.0.1/mcp/${sessionKey}`,
    ),
    getCanopyWorktreeUiMcpUrl: jest.fn(
      (sessionKey: string) => `http://127.0.0.1/mcp/${sessionKey}/ui`,
    ),
    registerCanopyWorktreeSessionRoute: jest.fn(() => Promise.resolve('route')),
    unregisterRoutesForSession: jest.fn(),
    unregisterCanopyWorktreeSessionRoute: jest.fn(),
  })),
}));

jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(() => ({
    unregisterRoutesForSession: jest.fn(),
    registerRoutesForSession: jest.fn(() => Promise.resolve(undefined)),
  })),
}));

jest.mock('../mcp/pending-requests', () => ({
  rejectAllForSession: jest.fn(),
}));

jest.mock('../mcp/plan-pending-requests', () => ({
  createPendingPlanExit: jest.fn(),
  rejectAllPlanExitsForSession: jest.fn(),
}));

jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: jest.fn(() => ({ mark: jest.fn(), clear: jest.fn() })),
}));

jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordUsageLimitedChat: jest.fn(() => Promise.resolve()),
}));

jest.mock('../ollama/claude-compatible', () => ({
  resolveClaudeCompatibleInvocation: jest.fn(() => Promise.resolve({})),
}));

jest.mock('../lib/resolve-workspace-display-name', () => ({
  resolveWorkspaceRecordingSnapshot: jest.fn(() =>
    Promise.resolve({ name: 'Workspace', type: 'single-repo' }),
  ),
}));

jest.mock('../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticated: jest.fn(() => Promise.resolve(true)),
  isProviderNativelyAuthenticatedForRouting: jest.fn(() =>
    Promise.resolve(true),
  ),
}));

jest.mock('../agents/ai-credits-routing', () => ({
  buildClaudeProxyEnv: jest.fn(() => ({})),
  buildBrokeredOrgGatewayClaudeEnv: jest.fn(() => ({})),
  resolveSessionAiCreditsAttribution: jest.fn(() => Promise.resolve({})),
  emitAiCreditsRoutingStatus: jest.fn(),
  emitAiCreditsUsageLimitReached: jest.fn(),
  emitAiCreditsNoBillingSource: jest.fn(),
  getAiCreditsRoutingContext: jest.fn(() => Promise.resolve(undefined)),
  hasUserSuppliedProviderCredential: jest.fn(() => false),
  isAiCreditsChosenOverAccountProxy: jest.fn(() => false),
  resolveAiCreditsRoutingAttempt: jest.fn(() => Promise.resolve(undefined)),
  resolveGatewayModelEntry: jest.fn(),
  resolveOrgGatewayCredential: jest.fn(),
  markOrgGatewayCredentialRejected: jest.fn(),
}));

jest.mock('../agents/work-owner', () => ({
  captureSessionWorkOwner: jest.fn(),
  resolveSessionWorkOwner: jest.fn(() => Promise.resolve({ kind: 'personal' })),
}));

jest.mock('../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: jest.fn(() =>
    Promise.resolve({ ok: true, orgRoute: false }),
  ),
}));

jest.mock('../lib/e2e-mock-control-plane', () => ({
  getMockLlmOrigin: jest.fn(),
}));

jest.mock('../lib/code-graph-availability', () => ({
  isCodeGraphAvailableForWorkspace: jest.fn(() => false),
}));

jest.mock('../lib/code-graph-availability-prompt', () => ({
  buildCodeGraphAvailabilityPrompt: jest.fn(() => ''),
}));

jest.mock('../lib/claude-code-graph-steering', () => ({
  CLAUDE_CODE_GRAPH_STEERING_CONTEXT: '',
  buildClaudeCodeGraphPreToolUseContext: jest.fn(() => ''),
  isClaudeCodeGraphPostToolUse: jest.fn(() => false),
  isClaudeCodeGraphToolName: jest.fn(() => false),
  loadConfiguredClaudeCodeGraphSourceExtensions: jest.fn(() =>
    Promise.resolve([]),
  ),
}));

jest.mock('../agents/ai-credits-quota-state', () => ({
  detectClaudeQuotaReached: jest.fn(() => false),
  readClaudeQuotaResetsAt: jest.fn(() => undefined),
  detectAiCreditsNoBillingSource: jest.fn(() => false),
  markProviderQuotaReached: jest.fn(),
}));

jest.mock('../agents/provider-auth-failure-event', () => ({
  buildProviderAuthFailureEvent: jest.fn(),
}));

jest.mock('../agents/claude-approval-adapter', () => ({
  approvalCheckForClaudeTool: jest.fn(),
  claudePermissionModeFor: jest.fn(() => 'default'),
}));

jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    check: jest.fn(() => Promise.resolve({ behavior: 'allow' })),
    setMode: jest.fn(),
    invalidatePending: jest.fn(),
    dispose: jest.fn(),
  })),
}));

jest.mock('../agents/steering-eligibility-events', () => ({
  notifySteeringEligibilityChanged: jest.fn(),
  subscribeSteeringEligibility: jest.fn(() => jest.fn()),
}));

jest.mock('../canopy-tools/session-runtime', () => ({
  getFileCommentsInSession: jest.fn(),
  loadGitPreferences: jest.fn(),
  loadWorktreePipelineYaml: jest.fn(),
  loadWorktreeScriptOutput: jest.fn(),
  saveLocalMemory: jest.fn(),
  searchLocalMemory: jest.fn(),
  requestAnswersFromRenderer: jest.fn(),
  respondToFileCommentInSession: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/node/lib/native-memory', () => ({
  claudeNativeMemoryOptions: jest.fn(() => ({})),
}));

jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: jest.fn(() => ({
    hasGraph: jest.fn(() => false),
  })),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));

jest.mock('../lib/chat-event-drop-diagnostics', () => ({
  recordChatEventDropped: jest.fn(),
}));

jest.mock('../agents/skill-usage-tracker', () => ({
  SkillUsageTracker: class SkillUsageTracker {
    dispose(): void {}
    endTurn(): void {}
    startTurn(): void {}
    currentTurn(): undefined {
      return undefined;
    }
  },
}));

jest.mock('../agents/ai-credits-proxy-failure-restore', () => ({
  withProxyFailureRestored: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/portal/provider-usage-limit', () => ({
  detectClaudeHostedNoBillingSource: jest.fn(),
  hasClaudeProxyFailureEvidence: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/lib/claude-fork-resume-point', () => ({
  isClaudeChainUuid: jest.fn(() => false),
}));

jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => ({
  isUnavailableModelSelection: jest.fn(() => false),
}));

jest.mock('@canopy/agent-transcript', () => ({
  ...jest.requireActual<typeof AgentTranscriptModule>(
    '@canopy/agent-transcript',
  ),
  isAiCreditsFailureEventShape: jest.fn(() => false),
  readClaudeApiErrorStatus: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/constants/preferences', () => ({
  normalizeClaudeMaxTurns: jest.fn(() => undefined),
}));

jest.mock('../lib/plan-persistence', () => ({
  createTrackedPlan: jest.fn(),
  updateTrackedPlan: jest.fn(),
}));

jest.mock('../mcp/script-output', () => ({
  loadWorktreeScriptOutput: jest.fn(),
}));

jest.mock('../lib/usage-limited-chats-recording', () => ({
  buildUsageLimitedEntry: jest.fn(),
  buildAccountProxyUsageLimitedEntry: jest.fn(),
  classifyAccountChangeResumeReason: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/agent-failures', () => ({
  classifyAgentFailure: jest.fn(),
}));

jest.mock('../lib/plan-system-instructions', () => ({
  buildPlanFileSystemInstruction: jest.fn(() => ''),
}));

jest.mock('../lib/workspace-target-exclusion', () => ({
  assertWorkspaceTargetRuntimeStartAllowed: jest.fn(),
  withWorkspaceTargetRuntimeStartReservation: jest.fn(
    (_target: unknown, operation: () => Promise<unknown>) => operation(),
  ),
  WorkspaceTargetAutoArchiveExcludedError: class WorkspaceTargetAutoArchiveExcludedError extends Error {},
}));

jest.mock('../lib/chat-turn-audit', () => ({
  isAgentContinuationEvent: jest.fn(() => false),
}));

jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: jest.fn(() => false),
}));

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseModelPackageConfig } from '@canopy/desktop-shared/model-config';
import {
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  initOllamaModels,
  omitModelFeatureFlags,
  IPC_CHANNELS,
} from '@canopy/desktop-shared/types';
import * as ChatTurnCancel from '../lib/chat-turn-cancel';
import { registerChatPersistenceHandlers } from '../ipc/chat-persistence';
import { archiveWorkEntry } from '../lib/work-entry-archive';
import { ClaudeCodeProvider } from '../agents/claude-session';
import { markSessionTeardownCause } from '../agents/session-manager';

const mockMark = jest.mocked(markSessionTeardownCause);

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeMessages(): AsyncGenerator<unknown, void> {
  async function* messages(): AsyncGenerator<unknown, void> {
    await Promise.resolve();
    yield { type: 'result', is_error: false, result: 'done' };
  }
  return messages();
}

// The stream stays open until released, as when the CLI process dies mid-turn;
// the reader drains an already-finished stream before the process exits.
function makeHeldMessages(): {
  messages: AsyncGenerator<unknown, void>;
  release: () => void;
} {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* messages(): AsyncGenerator<unknown, void> {
    await held;
    yield { type: 'result', is_error: false, result: 'done' };
  }
  return { messages: messages(), release };
}

function chatArchiveHandler(): (
  event: undefined,
  request: unknown,
) => Promise<unknown> {
  const registered = mockRegisteredHandlers.get(IPC_CHANNELS.chatArchiveTab);
  if (typeof registered !== 'function')
    throw new Error('Missing chat archive handler');
  return (event, request): Promise<unknown> =>
    Promise.resolve(Reflect.apply(registered, undefined, [event, request]));
}

async function createHostedProcessForChat(chatId: string): Promise<{
  session: ReturnType<ClaudeCodeProvider['createSession']>;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}> {
  const session = new ClaudeCodeProvider().createSession(
    {
      cwd: '/tmp/repo',
      projectId: 'project-1',
      worktreeId: 'entry-1',
      chatId,
    },
    jest.fn(),
    () => null,
  );
  session.sendMessage('test');
  for (
    let attempt = 0;
    attempt < 10 && mockQuery.mock.calls.length === 0;
    attempt += 1
  ) {
    await flush();
  }
  const params = mockQuery.mock.calls.at(-1)?.[0];
  const spawn = params?.options?.spawnClaudeCodeProcess;
  if (!spawn) throw new Error('Expected Claude process spawn callback');
  const process = new EventEmitter();
  mockSpawnClaudeCodeProcessOffMain.mockReturnValue(process);
  spawn({
    command: '/mock/claude',
    args: [],
    cwd: '/tmp/repo',
    env: {},
    signal: new AbortController().signal,
  });
  return {
    session,
    exit: (code, signal): void => {
      process.emit('exit', code, signal);
    },
  };
}

describe('session teardown cause origins', () => {
  beforeAll(() => {
    const pkg: unknown = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    const config = parseModelPackageConfig(pkg);
    const claudeModels = omitModelFeatureFlags(config.claudeModels);
    initClaudeModels(claudeModels);
    initCodexModels(omitModelFeatureFlags(config.codexModels));
    initAiGatewayModels(
      [],
      claudeModels.flatMap((entry) =>
        entry.gatewayId
          ? [
              {
                modelId: entry.id,
                gatewayId: entry.gatewayId,
                family: 'claude',
                recommendedHarness: 'claude' as const,
                gatewayOnly: false,
                contextWindow: entry.contextWindow ?? 1_000_000,
                supportsPromptCaching: true,
                supportedThinkingLevels: entry.supportedThinkingLevels ?? [],
                toolSchemaProfile: 'standard' as const,
              },
            ]
          : [],
      ),
    );
    initModelAliases(config.modelAliases);
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockRegisteredHandlers.clear();
    mockGetSessionKeyOwnership.mockReturnValue('registered');
    mockGetActiveChatIds.mockReturnValue(['chat-1']);
    mockGetActiveSessionInfos.mockReturnValue([
      { projectId: 'project-1', worktreeId: 'entry-1', chatId: 'chat-1' },
      { projectId: 'project-1', worktreeId: 'entry-1', chatId: 'chat-2' },
    ]);
    mockChatStateService.getCompatibilityTabs.mockResolvedValue({
      tabs: [mockArchivedTab],
    });
    mockArchiveCompatibilityTab.mockResolvedValue({
      archived: [{ tab: mockArchivedTab }],
    });
    initOllamaModels([]);
  });

  it('marks Stop before canceling the session', async () => {
    mockGetSession.mockReturnValue({ cancel: mockCancelSession });
    mockGetSessionProviderType.mockReturnValue('claude');

    await ChatTurnCancel.cancelChatTurn({
      projectId: 'project-1',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
    });

    expect(mockMark).toHaveBeenCalledWith('project-1/entry-1/chat-1', 'stop');
    expect(mockMark.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('does not mark Stop for a Codex session, which stays alive', async () => {
    mockGetSession.mockReturnValue({ cancel: mockCancelSession });
    mockGetSessionProviderType.mockReturnValue('codex');

    await ChatTurnCancel.cancelChatTurn({
      projectId: 'project-1',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
    });

    expect(mockMark).not.toHaveBeenCalled();
  });

  it('marks chat archive before its active-turn cancellation', async () => {
    const cancelChatTurnSpy = jest
      .spyOn(ChatTurnCancel, 'cancelChatTurn')
      .mockImplementation(mockCancelChatTurn);
    registerChatPersistenceHandlers();

    await chatArchiveHandler()(undefined, {
      projectId: 'project-1',
      worktreeId: 'entry-1',
      tabId: 'chat-1',
    });

    expect(mockMark).toHaveBeenCalledWith(
      'project-1/entry-1/chat-1',
      'archive',
    );
    expect(mockMark.mock.invocationCallOrder[0]).toBeLessThan(
      cancelChatTurnSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('marks each Work Entry session before destroying the entry sessions', async () => {
    await archiveWorkEntry({ workspaceId: 'project-1', entryId: 'entry-1' });

    expect(mockMark).toHaveBeenCalledWith(
      'project-1/entry-1/chat-1',
      'archive',
    );
    expect(mockMark).toHaveBeenCalledWith(
      'project-1/entry-1/chat-2',
      'archive',
    );
    expect(Math.max(...mockMark.mock.invocationCallOrder)).toBeLessThan(
      mockDestroyWorktreeSessions.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it('marks unexpected non-zero Claude process exits as crashes', async () => {
    const held = makeHeldMessages();
    mockQuery.mockReturnValue(held.messages);
    const crashed = await createHostedProcessForChat('crashed');
    crashed.exit(1, null);
    expect(mockMark).toHaveBeenCalledWith('project-1/entry-1/crashed', 'crash');
    held.release();
    await crashed.session.destroy();
  });

  it('marks signal-terminated Claude processes as external signals', async () => {
    const held = makeHeldMessages();
    mockQuery.mockReturnValue(held.messages);
    const signaled = await createHostedProcessForChat('signaled');
    signaled.exit(null, 'SIGTERM');
    expect(mockMark).toHaveBeenCalledWith(
      'project-1/entry-1/signaled',
      'external_signal',
    );
    held.release();
    await signaled.session.destroy();
  });

  // The owner check (CAN-4835) SIGKILLs a CLI whose session instance has lost
  // its key. The key's entry, if any, then belongs to a successor, which may be
  // another provider that never took this module's session-owner slot.
  it.each(['replaced', 'released'])(
    'does not mark the exit of a Claude process whose session is %s',
    async (ownership) => {
      const held = makeHeldMessages();
      mockQuery.mockReturnValue(held.messages);
      const orphaned = await createHostedProcessForChat(
        `orphaned-${ownership}`,
      );
      mockGetSessionKeyOwnership.mockReturnValue(ownership);
      orphaned.exit(null, 'SIGKILL');
      expect(mockMark).not.toHaveBeenCalled();
      held.release();
      await orphaned.session.destroy();
    },
  );

  it('does not mark normal Claude process exits', async () => {
    mockQuery.mockReturnValue(makeMessages());
    const normal = await createHostedProcessForChat('normal');
    normal.exit(0, null);
    expect(mockMark).not.toHaveBeenCalled();
    await normal.session.destroy();
  });

  it('does not mark Claude process exits requested by session destruction', async () => {
    mockQuery.mockReturnValue(makeMessages());
    const requested = await createHostedProcessForChat('requested');
    await requested.session.destroy();
    requested.exit(1, null);
    expect(mockMark).not.toHaveBeenCalled();
  });
});
