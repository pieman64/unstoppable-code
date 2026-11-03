import type { ApprovalMode, ChatTabsFile } from '@canopy/desktop-shared/types';
import type {
  HookInput,
  HookJSONOutput,
  query as claudeQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type { Options as ClaudeQueryOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ChildToolLiveness } from '@canopy/agent-transcript';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import { BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseModelPackageConfig } from '@canopy/desktop-shared/model-config';
import { createAppAdvisorRuntimeFixture } from './fixtures/app-advisor-runtime';
import type * as WorkOwnerModule from '../agents/work-owner';
import type * as ManagedDelegationModule from '../agents/delegation/service';
import type * as CodexGatewayProxyServiceModule from '../agents/codex-gateway-proxy-service';
import type * as ModelGatewayStateModule from '../lib/model-gateway-state';
import type * as UsageLimitedChatsRegistryModule from '../lib/usage-limited-chats-registry';
import type { AccountProxySessionRoute } from '../account-proxy/routing';

// The provider always streams its prompt, so the doubles drive it as a generator.
type MockQuery = (params: {
  prompt: AsyncGenerator<unknown>;
  options?: Parameters<typeof claudeQuery>[0]['options'];
}) => unknown;
type ManagedDelegationSessionOptions = Parameters<
  typeof ManagedDelegationModule.createManagedDelegationSession
>[0];
type ManagedDelegationParentStub = Pick<
  ManagedDelegationModule.ManagedDelegationSession['parent'],
  'acknowledgeTool' | 'bindClaude' | 'invokeClaude' | 'nativeMessageUuid'
>;
type ManagedDelegationSessionStub = Omit<
  Pick<
    ManagedDelegationModule.ManagedDelegationSession,
    | 'bareClaudeName'
    | 'applyPolicyGuidance'
    | 'detach'
    | 'mcpTools'
    | 'observe'
    | 'ownsTool'
    | 'parent'
    | 'retireTurn'
    | 'systemPromptGuidance'
  >,
  'parent'
> & { parent: ManagedDelegationParentStub };

const mockQuery: jest.MockedFunction<MockQuery> = jest.fn();
const mockSpawn = jest.fn();
const mockSpawnClaudeCodeProcessOffMain = jest.fn();
const mockWithholdClaudeProcessStdoutCreditUntil = jest.fn();
const mockKillChildProcessGroup = jest.fn();
const createTrackedPlanMock = jest.fn();
const updateTrackedPlanMock = jest.fn();
const sendToWindowMock = jest.fn();
const sendToWindowDetailedMock = jest.fn((window: unknown) =>
  window ? { delivered: true } : { delivered: false, reason: 'no_window' },
);
const mockRecordUsageLimitedChat = jest.fn<
  ReturnType<typeof UsageLimitedChatsRegistryModule.recordUsageLimitedChat>,
  Parameters<typeof UsageLimitedChatsRegistryModule.recordUsageLimitedChat>
>(() => Promise.resolve());
const originalHarnessNativeMemory = process.env.CANOPY_HARNESS_NATIVE_MEMORY;
const mockResolveClaudeCompatibleInvocation = jest.fn();
const mockLoadCachedInventory = jest.fn();
const mockResolveAccountProxySessionRoute = jest.fn(
  (options: unknown): Promise<AccountProxySessionRoute | null> => {
    void options;
    return Promise.resolve(null);
  },
);
const mockCommitPlanExit = jest.fn(() => Promise.resolve());
const mockPlanTrackingTabs = jest.fn<Promise<ChatTabsFile>, []>(() =>
  Promise.resolve({ version: 1, tabs: [], activeTabId: '' }),
);
const mockResolveOrgGatewayCredential = jest.fn();
const mockMarkOrgGatewayCredentialRejected = jest.fn(() => Promise.resolve());
type CodexGatewayRouteRegistrationOptions = Parameters<
  ReturnType<
    typeof CodexGatewayProxyServiceModule.getCodexGatewayProxyService
  >['registerRoute']
>[0];
const mockRegisterCodexGatewayRoute = jest.fn<
  Promise<unknown>,
  [CodexGatewayRouteRegistrationOptions]
>(() =>
  Promise.resolve({
    routeId: 'route-id',
    baseUrl: 'http://127.0.0.1:43123/codex-gateway/route-id',
  }),
);
const mockUnregisterCodexGatewayRoutesForSession = jest.fn();
const mockHasCodeGraph = jest.fn(() => false);
const mockManagedDelegationEnabled = jest.fn(() => false);
const mockCreateManagedDelegationSession: jest.Mock<
  Promise<ManagedDelegationSessionStub>,
  [ManagedDelegationSessionOptions]
> = jest.fn<
  Promise<ManagedDelegationSessionStub>,
  [ManagedDelegationSessionOptions]
>();
const mockAttentionMark = jest.fn();
const mockAttentionClear = jest.fn();
const mockResolveSessionAiCreditsAttribution = jest.fn<
  ReturnType<typeof AiCreditsRoutingModule.resolveSessionAiCreditsAttribution>,
  Parameters<typeof AiCreditsRoutingModule.resolveSessionAiCreditsAttribution>
>(() => Promise.resolve({}));
const mockResolveSessionWorkOwner = jest.fn<
  ReturnType<typeof WorkOwnerModule.resolveSessionWorkOwner>,
  Parameters<typeof WorkOwnerModule.resolveSessionWorkOwner>
>(() => Promise.resolve({ kind: 'personal' as const }));
const mockCheckModelGatewayRoute = jest.fn<
  ReturnType<typeof ModelGatewayStateModule.checkModelGatewayRoute>,
  Parameters<typeof ModelGatewayStateModule.checkModelGatewayRoute>
>(() => Promise.resolve({ ok: true as const, orgRoute: false }));
const mockGetChildToolLiveness = jest.fn<
  ChildToolLiveness,
  [string, string, string]
>(() => ({ kind: 'no-live-session' }));

jest.mock('electron', () => ({
  BrowserWindow: class MockBrowserWindow {
    public isDestroyed(): boolean {
      return false;
    }
  },
}));

jest.mock('node:child_process', () => {
  const actual: Record<string, unknown> =
    jest.requireActual('node:child_process');
  return {
    ...actual,
    get spawn(): typeof mockSpawn {
      return mockSpawn;
    },
  };
});
jest.mock('../agents/claude-process-host-runner', () => ({
  get spawnClaudeCodeProcessOffMain(): typeof mockSpawnClaudeCodeProcessOffMain {
    return mockSpawnClaudeCodeProcessOffMain;
  },
  get withholdClaudeProcessStdoutCreditUntil(): typeof mockWithholdClaudeProcessStdoutCreditUntil {
    return mockWithholdClaudeProcessStdoutCreditUntil;
  },
}));
jest.mock('../agents/delegation/gate', () => ({
  get managedDelegationEnabled(): typeof mockManagedDelegationEnabled {
    return mockManagedDelegationEnabled;
  },
}));
jest.mock('../agents/delegation/service', () => ({
  get createManagedDelegationSession(): typeof mockCreateManagedDelegationSession {
    return mockCreateManagedDelegationSession;
  },
}));
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  get query(): typeof mockQuery {
    return mockQuery;
  },
  createSdkMcpServer: jest.fn((configuration: unknown) => configuration),
  tool: jest.fn((name: string) => ({ name })),
}));
jest.mock('../lib/process-kill', () => ({
  get killChildProcessGroup(): typeof mockKillChildProcessGroup {
    return mockKillChildProcessGroup;
  },
}));
// Local memory is opt-in (CAN-1969); resolve synchronously (no fs I/O) so the
// single-setImmediate flush() still observes the query call. Default off.
const mockStopAccountProxySwitches = jest.fn();
const mockWatchAccountProxySwitches = jest.fn<
  () => void,
  [string, (event: unknown) => unknown]
>(() => mockStopAccountProxySwitches);
jest.mock('../account-proxy/switch-events', () => ({
  watchAccountProxySwitches: (
    sessionId: string,
    emit: (event: unknown) => unknown,
  ): (() => void) => mockWatchAccountProxySwitches(sessionId, emit),
}));
// No account proxy is set up in these tests; resolve without file I/O so the
// tests' microtask flushes still observe the SDK query.
jest.mock('../account-proxy/routing', () => ({
  resolveAccountProxySessionRoute: (
    options: unknown,
  ): Promise<AccountProxySessionRoute | null> =>
    mockResolveAccountProxySessionRoute(options),
}));
jest.mock('../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  ),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
  readLatestPreferencesFile: jest.fn(() =>
    Promise.resolve(
      jest.requireActual<typeof PreferencesStoreModule>(
        '../lib/preferences-store',
      ).DEFAULT_PREFERENCES,
    ),
  ),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/claude'),
  getBundledRtkBinaryPath: jest.fn(() => '/mock/rtk'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/rg'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
  getRtkManagedEnv: jest.fn(() => ({
    RTK_TELEMETRY_DISABLED: '1',
    RTK_DB_PATH: '/mock/canopy/rtk/history.db',
    RTK_TEE_DIR: '/mock/canopy/rtk/tee',
  })),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  cleanupWorktreeChatPluginDirs: jest.fn(),
  resolvePlugins: jest.fn().mockResolvedValue({
    sdkPlugins: [],
    skillPluginDir: null,
    selectedCapabilityRoots: [],
    codexProcessEnv: {},
    codexMcpServers: {},
    mcpServers: {},
    warnings: [],
  }),
}));
jest.mock('../plugins/invocable-inventory-service', () => ({
  get loadCachedInventory(): typeof mockLoadCachedInventory {
    return mockLoadCachedInventory;
  },
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(
    (selections?: {
      collectionIds?: string[];
      skillRefs?: unknown[];
      pluginRefs?: unknown[];
      mcpServerRefs?: unknown[];
    }) =>
      Promise.resolve({
        selections: selections ?? {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
      }),
  ),
}));
const mockRegisterCanopyWorktreeSessionRoute = jest.fn<
  Promise<string>,
  [CanopyWorktreeSessionRoute]
>(() => Promise.resolve('session-route'));
const mockUnregisterCanopyWorktreeSessionRoute = jest.fn();
const mockUnregisterRoutesForSession = jest.fn();
const mockGetCanopyWorktreeMcpUrl = jest.fn(
  (sessionKey: string) =>
    `http://127.0.0.1:4567/mcp/${encodeURIComponent(sessionKey)}`,
);
const mockGetCanopyWorktreeUiMcpUrl = jest.fn(
  (sessionKey: string) =>
    `http://127.0.0.1:4567/mcp/${encodeURIComponent(sessionKey)}/ui`,
);
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    get registerCanopyWorktreeSessionRoute(): typeof mockRegisterCanopyWorktreeSessionRoute {
      return mockRegisterCanopyWorktreeSessionRoute;
    },
    get unregisterCanopyWorktreeSessionRoute(): typeof mockUnregisterCanopyWorktreeSessionRoute {
      return mockUnregisterCanopyWorktreeSessionRoute;
    },
    get unregisterRoutesForSession(): typeof mockUnregisterRoutesForSession {
      return mockUnregisterRoutesForSession;
    },
    get getCanopyWorktreeMcpUrl(): typeof mockGetCanopyWorktreeMcpUrl {
      return mockGetCanopyWorktreeMcpUrl;
    },
    get getCanopyWorktreeUiMcpUrl(): typeof mockGetCanopyWorktreeUiMcpUrl {
      return mockGetCanopyWorktreeUiMcpUrl;
    },
  })),
}));
jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(() => ({
    get registerRoute(): typeof mockRegisterCodexGatewayRoute {
      return mockRegisterCodexGatewayRoute;
    },
    get unregisterRoutesForSession(): typeof mockUnregisterCodexGatewayRoutesForSession {
      return mockUnregisterCodexGatewayRoutesForSession;
    },
  })),
}));
jest.mock('../mcp/script-output', () => ({
  loadScriptOutputSnapshot: jest.fn(),
}));
jest.mock('../mcp/pending-requests', () => ({
  rejectAllForSession: jest.fn(),
  createPendingRequest: jest.fn(() => new Promise(() => {})),
  resolveRequest: jest.fn(),
  rejectRequest: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: (): { hasGraph: jest.Mock } => ({
    get hasGraph(): typeof mockHasCodeGraph {
      return mockHasCodeGraph;
    },
  }),
}));
jest.mock('../mcp/plan-pending-requests', () => ({
  createPendingPlanExit: jest.fn(),
  rejectAllPlanExitsForSession: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  registerSession: jest.fn(),
  unregisterSession: jest.fn(),
  getSessionKeyOwnership: jest.fn(() => 'registered'),
  getSessionInstanceId: jest.fn(() => 'session-instance-1'),
  buildSessionKey: jest.fn(
    (p: string, w: string, c: string) => `${p}/${w}/${c}`,
  ),
  markTurnActive: jest.fn(),
  markTurnAwaitingUser: jest.fn(),
  markTurnIdle: jest.fn(),
  noteSessionMessageQueued: jest.fn(),
  recordSessionEvent: jest.fn(),
  markSessionTeardownCause: jest.fn(),
  get getChildToolLiveness(): typeof mockGetChildToolLiveness {
    return mockGetChildToolLiveness;
  },
  recordClaudeSessionCronHookInput: jest.fn(),
  createSessionPhaseTimer: jest.fn(() => jest.fn()),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  recordSessionAccountProxyRoute: jest.fn(),
  resetSessionLiveBackgroundTasks: jest.fn(),
  subscribeLiveBackgroundTasks: jest.fn(() => (): void => undefined),
  SessionUnavailableForTaskStopError: class SessionUnavailableForTaskStopError extends Error {},
}));
jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: jest.Mock; clear: jest.Mock } => ({
    get mark(): typeof mockAttentionMark {
      return mockAttentionMark;
    },
    get clear(): typeof mockAttentionClear {
      return mockAttentionClear;
    },
  }),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  get recordUsageLimitedChat(): typeof mockRecordUsageLimitedChat {
    return mockRecordUsageLimitedChat;
  },
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    commitPlanExit: typeof mockCommitPlanExit;
    getCompatibilityTabs: typeof mockPlanTrackingTabs;
  } => ({
    get commitPlanExit(): typeof mockCommitPlanExit {
      return mockCommitPlanExit;
    },
    get getCompatibilityTabs(): typeof mockPlanTrackingTabs {
      return mockPlanTrackingTabs;
    },
  }),
}));
jest.mock('../ollama/claude-compatible', () => ({
  get resolveClaudeCompatibleInvocation(): typeof mockResolveClaudeCompatibleInvocation {
    return mockResolveClaudeCompatibleInvocation;
  },
}));
jest.mock('../lib/resolve-workspace-display-name', () => ({
  resolveWorkspaceRecordingSnapshot: jest.fn().mockResolvedValue({
    name: 'Workspace',
    type: 'single-repo',
  }),
}));
// Default to a natively-authenticated user so the common spawn path stays
// native (the AI Credits resolver returns null). Individual tests override
// this to exercise the on-quota missing-native-auth routing / backstop behavior.
jest.mock('../auth/provider-auth-state', () => {
  const isProviderNativelyAuthenticated = jest.fn().mockResolvedValue(true);
  return {
    isProviderNativelyAuthenticated,
    // ECW-9091: routing decisions now call the stale-cache fast-path variant.
    // Share one mock so a test flipping native auth affects both call sites.
    isProviderNativelyAuthenticatedForRouting: isProviderNativelyAuthenticated,
  };
});
// Keep the real routing decision logic but stub the blocking cloud read so
// on-quota routing tests can control credit eligibility deterministically. The
// workspace-attribution read hits real disk (workspace index + worktree list),
// which would not settle within the tests' microtask flush and delay the
// routing-status emit — stub it to a synchronously-resolved empty attribution.
jest.mock('../agents/ai-credits-routing', () => {
  const actual = jest.requireActual<typeof AiCreditsRoutingModule>(
    '../agents/ai-credits-routing',
  );
  return {
    ...actual,
    getAiCreditsRoutingContext: jest.fn(),
    resolveAiCreditsAttribution: jest.fn().mockResolvedValue({}),
    resolveSessionAiCreditsAttribution: (
      session: Parameters<
        typeof AiCreditsRoutingModule.resolveSessionAiCreditsAttribution
      >[0],
    ): ReturnType<
      typeof AiCreditsRoutingModule.resolveSessionAiCreditsAttribution
    > => mockResolveSessionAiCreditsAttribution(session),
    get resolveOrgGatewayCredential(): typeof mockResolveOrgGatewayCredential {
      return mockResolveOrgGatewayCredential;
    },
    get markOrgGatewayCredentialRejected(): typeof mockMarkOrgGatewayCredentialRejected {
      return mockMarkOrgGatewayCredentialRejected;
    },
  };
});
jest.mock('../lib/plan-persistence', () => ({
  get createTrackedPlan(): typeof createTrackedPlanMock {
    return createTrackedPlanMock;
  },
  get updateTrackedPlan(): typeof updateTrackedPlanMock {
    return updateTrackedPlanMock;
  },
}));
jest.mock('../lib/window-send', () => ({
  get sendToWindow(): typeof sendToWindowMock {
    return sendToWindowMock;
  },
  get sendToWindowDetailed(): typeof sendToWindowDetailedMock {
    return sendToWindowDetailedMock;
  },
}));
const mockApprovalCheck = jest.fn();
const mockApprovalSetMode = jest.fn();
const mockApprovalInvalidatePending = jest.fn();
const mockApprovalDispose = jest.fn();
const mockCreateApprovalSession = jest.fn(() => ({
  check: mockApprovalCheck,
  setMode: mockApprovalSetMode,
  invalidatePending: mockApprovalInvalidatePending,
  dispose: mockApprovalDispose,
}));
jest.mock('../approvals/approval-service', () => ({
  get createApprovalSession(): typeof mockCreateApprovalSession {
    return mockCreateApprovalSession;
  },
}));
// The Ledger exposure gate reads live flags, preferences and persistence;
// tests decide it explicitly. Sessions get no Ledger tools by default.
interface MockLedgerOpenOptions {
  target: { projectId: string; worktreeId: string; chatId: string };
  harness: string;
  readSettings: () => {
    model: string | null;
    thinkingEffort: string | null;
    planMode: boolean;
  };
  selectedRepoId?: string;
  toolNames?: { add: string; search: string; update: string };
}
const mockMayExposeLedgerTools = jest.fn<boolean, [unknown]>(() => false);
const mockOpenLedgerChatTools = jest.fn<
  Promise<unknown>,
  [MockLedgerOpenOptions]
>(() => Promise.resolve(null));
jest.mock('../canopy-tools/ledger-tools-runtime', () => ({
  ...jest.requireActual<typeof LedgerToolsRuntimeModule>(
    '../canopy-tools/ledger-tools-runtime',
  ),
  mayExposeLedgerTools: (target: unknown): boolean =>
    mockMayExposeLedgerTools(target),
  openLedgerChatTools: (options: MockLedgerOpenOptions): Promise<unknown> =>
    mockOpenLedgerChatTools(options),
}));

import { getObservabilityService } from '../observability';
import {
  applyClaudeTranscriptEvent,
  CHILD_TOOL_LIVENESS_STAMP,
  createEmptyTranscriptReducerState,
  readChildToolLivenessStamp,
} from '@canopy/agent-transcript';
import {
  AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
  parseCanopyProxyError,
} from '@canopy/protocol';
import { skillShareNudgeState } from '../agents/skill-share-nudge-state';
import { SkillUsageTracker } from '../agents/skill-usage-tracker';
import { createClaudeDelegationRunner } from '../agents/delegation/claude-runner';
import * as MainProcessLogging from '../lib/main-process-logging';
import {
  ClaudeCodeProvider,
  captureClaudeStopFence,
  interruptClaudeSessionForStop,
  isClaudeStopFenceCurrent,
  getContextUsageForClaudeSession,
  stopNativeSubagentForClaudeSession,
  stopTaskForClaudeSession,
} from '../agents/claude-session';
import {
  ClaudeTurnBindingTracker,
  releaseClaudeTurnLifecycleProducer,
  setClaudeTurnLifecycleClockForTests,
  setClaudeTurnLifecycleSink,
} from '../agents/claude-turn-lifecycle';
import * as SessionEventRouter from '../agents/session-event-router';
import { OllamaProvider } from '../agents/ollama-provider';
import {
  getSessionKeyOwnership,
  isSessionAccountProxyRouted,
  markTurnAwaitingUser,
  markTurnIdle,
  recordClaudeSessionCronHookInput,
  recordSessionAccountProxyRoute,
  recordSessionEvent,
  registerSession,
  resetSessionLiveBackgroundTasks,
  unregisterSession,
} from '../agents/session-manager';
import { rejectAllForSession } from '../mcp/pending-requests';
import {
  AI_CREDITS_USAGE_LIMIT_EVENT_TYPE,
  initAiGatewayModels,
  initClaudeModels,
  isCanopyAuthFailureEventData,
  initCodexModels,
  getAiGatewayModelEntries,
  getGatewayModelEntries,
  initModelAliases,
  initOllamaModels,
  omitModelFeatureFlags,
  OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ApprovalCheck,
  type ApprovalRule,
} from '@canopy/desktop-shared/types';
import { DelegationNativePolicy } from '../agents/delegation/native-policy';
import type { CanopyWorktreeSessionRoute } from '../mcp/http-proxy-service';
import { BRAND } from '@canopy/brand/current';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  getAppAdvisorLedgerToolNames,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import { isProviderNativelyAuthenticated } from '../auth/provider-auth-state';
import {
  clearAiCreditsRoutingModeCache,
  getAiCreditsRoutingContext,
  setAiCreditsRoutingModeCache,
} from '../agents/ai-credits-routing';
import type * as AiCreditsRoutingModule from '../agents/ai-credits-routing';
import * as quotaState from '../agents/ai-credits-quota-state';
import { clearAllProviderQuotaReached } from '../agents/ai-credits-quota-state';
import type { AgentSessionOptions } from '../agents/types';
import type { HostedClaudeProcessOwner } from '../agents/claude-process-host-runner';
import type { ApprovalCheckDisplay } from '../approvals/approval-service';
import * as PreferencesStoreModule from '../lib/preferences-store';
import * as GlobalPluginOverlayModule from '../plugins/global-plugin-overlay';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';
import { CLAUDE_CODE_GRAPH_STEERING_CONTEXT } from '../lib/claude-code-graph-steering';
import {
  resetClaudeCodeGraphOrientationForTests,
  setClaudeCodeGraphOrientationReadersForTests,
} from '../lib/claude-code-graph-orientation';
import type * as LedgerToolsRuntimeModule from '../canopy-tools/ledger-tools-runtime';
import { CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT } from '../agents/claude-approval-adapter';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { ClaudeInputDelivery } from '../agents/claude-input-delivery';
import { subscribeSteeringEligibility } from '../agents/steering-eligibility-events';
import { setExperimentalFeaturesEnabled } from '../lib/experimental-features';
import { ChatTurnFailureEvidence } from '../observability/chat-turn-failure';
import {
  DERIVED_FAILURE_NOTICE_TYPES,
  readFailureSourceScope,
} from '../agents/failure-source-scope';

const CHAIN_UUID = '11111111-2222-4333-8444-555555555555';

/**
 * Producer-to-consumer check (CAN-4629): every derived failure notice the real
 * session emits for a sub-agent failure names that sub-agent, and the chat
 * turn telemetry collector reports the cause only as a sub-agent failure.
 */
function expectOnlySubAgentFailure(
  events: readonly unknown[],
  category: string,
): void {
  const records = events.filter(
    (event): event is Record<string, unknown> =>
      typeof event === 'object' && event !== null && !Array.isArray(event),
  );
  const derived = records.filter(
    (event) =>
      typeof event.type === 'string' &&
      DERIVED_FAILURE_NOTICE_TYPES.includes(event.type),
  );
  expect(derived.length).toBeGreaterThan(0);
  for (const notice of derived) {
    expect(readFailureSourceScope(notice)).toEqual({
      parent_tool_use_id: 'toolu_child',
    });
  }
  const evidence = new ChatTurnFailureEvidence();
  for (const event of records) evidence.observe(event, undefined);
  const result = evidence.classify({ provider: 'claude' });
  expect(result.failure).toBeNull();
  expect(result.subAgentFailure).toMatchObject({ category });
}

const mockedUnregisterSession = jest.mocked(unregisterSession);
const mockedReadLocalMemoryEnabledPreference = jest.mocked(
  readLocalMemoryEnabledPreference,
);
const mockedMarkTurnIdle = jest.mocked(markTurnIdle);
const mockedMarkTurnAwaitingUser = jest.mocked(markTurnAwaitingUser);
const mockedIsNativelyAuthed = jest.mocked(isProviderNativelyAuthenticated);
const mockedGetRoutingContext = jest.mocked(getAiCreditsRoutingContext);

import { DelegationParent } from '@canopy/desktop-shared/node/delegation/parent';

function makeAiCreditsRoutingContext(
  overrides: Partial<AiCreditsRoutingModule.AiCreditsRoutingContext> = {},
): AiCreditsRoutingModule.AiCreditsRoutingContext {
  return {
    cskToken: 'csk_test',
    accountIdentity: 'account-a',
    email: 'user@example.com',
    creditsEligible: true,
    creditsEligibilityKnown: true,
    guestPrincipal: false,
    cloudBaseUrl: 'https://cloud.example.com',
    ...overrides,
  };
}

function withLegacyResumeSessionId(
  options: AgentSessionOptions,
  resumeSessionId: string,
): AgentSessionOptions {
  // These tests intentionally retain the legacy resumeSessionId input even
  // though it is not part of the current AgentSessionOptions contract.
  if (!Reflect.set(options, 'resumeSessionId', resumeSessionId))
    throw new Error('Could not set the legacy resumeSessionId test input');
  return options;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A hosted CLI that exits once its input closes, as the Claude CLI does, so a
 * session that reaps it on loop exit leaves no SIGKILL timer running.
 */
class ExitOnInputEndHostedCli extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = jest.fn((): boolean => true);
  readonly exited: Promise<void>;

  constructor() {
    super();
    this.exited = new Promise((resolve) => {
      this.once('exit', () => resolve());
    });
    this.stdin.resume();
    this.stdin.once('finish', () => {
      this.exitCode = 0;
      this.emit('exit', 0, null);
    });
  }
}

function createGate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function createManagedDelegationStub(
  overrides: Partial<Omit<ManagedDelegationSessionStub, 'parent'>> & {
    parent?: Partial<ManagedDelegationParentStub>;
  } = {},
): ManagedDelegationSessionStub {
  const { parent: parentOverrides, ...sessionOverrides } = overrides;
  const parent: ManagedDelegationParentStub = {
    acknowledgeTool: jest.fn(),
    bindClaude: (_name, _input, callId) => ({
      ok: true,
      value: { _hostCorrelation: callId },
    }),
    invokeClaude: () => Promise.resolve({ ok: true, value: undefined }),
    nativeMessageUuid: () => undefined,
    ...parentOverrides,
  };
  return {
    applyPolicyGuidance: (text) => text,
    bareClaudeName: (name) => name,
    detach: jest.fn(),
    mcpTools: [],
    observe: jest.fn(),
    ownsTool: () => false,
    parent,
    retireTurn: jest.fn(),
    systemPromptGuidance: undefined,
    ...sessionOverrides,
  };
}

function trackedSkillTurnId(tracker: unknown): string | undefined {
  return tracker instanceof SkillUsageTracker
    ? tracker.currentTurn()?.id
    : undefined;
}

function managedDelegationOptions(
  options: ManagedDelegationSessionOptions | undefined,
): ManagedDelegationSessionOptions {
  if (!options) throw new Error('Expected managed delegation options');
  return options;
}

interface ManagedDelegationBindingContext {
  turnId: string | undefined;
  messageId: string | undefined;
}

function createBindingManagedDelegationStub(
  readOptions: () => ManagedDelegationSessionOptions | undefined,
  contexts: ManagedDelegationBindingContext[],
): ManagedDelegationSessionStub {
  const bindClaude: ManagedDelegationParentStub['bindClaude'] = (
    _name,
    _input,
    callId,
  ) => {
    const options = readOptions();
    contexts.push({
      turnId: options?.currentTurn(),
      messageId: options?.currentMessage?.(),
    });
    if (!options?.currentTurn()) {
      return {
        ok: false,
        error: {
          code: 'parent_unavailable',
          message: 'The owning parent turn is unavailable.',
          retryable: false,
        },
      };
    }
    return { ok: true, value: { _hostCorrelation: callId } };
  };
  return createManagedDelegationStub({
    ownsTool: () => true,
    parent: { bindClaude },
  });
}

async function invokeClaudePreToolUse(
  params: Parameters<MockQuery>[0],
  toolName: string,
  toolInput: Record<string, unknown>,
  callId: string,
  agentId?: string,
): Promise<void> {
  for (const entry of params.options?.hooks?.PreToolUse ?? []) {
    if (entry.matcher !== '*') continue;
    for (const hook of entry.hooks) {
      const result = await hook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'native-session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: callId,
          ...(agentId ? { agent_id: agentId } : {}),
        },
        callId,
        { signal: new AbortController().signal },
      );
      if (
        'hookSpecificOutput' in result &&
        result.hookSpecificOutput &&
        'permissionDecisionReason' in result.hookSpecificOutput &&
        result.hookSpecificOutput.permissionDecisionReason ===
          'The owning parent turn is unavailable.'
      ) {
        throw new Error('The owning parent turn is unavailable.');
      }
    }
  }
}

function claudeQueryParams(index = 0): Parameters<MockQuery>[0] {
  const params = mockQuery.mock.calls[index]?.[0];
  if (!params) throw new Error('Expected a Claude SDK query');
  return params;
}

/**
 * Read a chat event's `type` without leaning on `any`, so emission ORDER can be
 * asserted (CAN-1814: the auth-failure event must follow the failing event).
 */
function readEventType(event: unknown): string {
  if (typeof event !== 'object' || event === null) return '';
  const type: unknown = Reflect.get(event, 'type');
  return typeof type === 'string' ? type : '';
}

function readEventBoolean(event: unknown, field: string): boolean | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const value: unknown = Reflect.get(event, field);
  return typeof value === 'boolean' ? value : undefined;
}

function readEventString(event: unknown, field: string): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const value: unknown = Reflect.get(event, field);
  return typeof value === 'string' ? value : undefined;
}

function readEventStringArray(event: unknown, field: string): string[] {
  if (typeof event !== 'object' || event === null) return [];
  const value: unknown = Reflect.get(event, field);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Turn stamp `withTurnMetadata` adds to every emitted event. */
function readTurnUserMessageId(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const id: unknown = Reflect.get(event, 'canopy_turn_user_message_id');
  return typeof id === 'string' ? id : undefined;
}

function getNoWindow(): null {
  return null;
}

function expectHttpMcpServer(server: unknown, url: string): void {
  expect(server).toMatchObject({
    type: 'http',
    url,
    alwaysLoad: true,
  });
  const headers = (server as { headers?: Record<string, unknown> }).headers;
  expect(headers?.Authorization).toEqual(expect.stringMatching(/^Bearer /));
}

async function* makeMessages(
  messages: unknown[],
): AsyncGenerator<unknown, void> {
  for (const message of messages) {
    await Promise.resolve();
    yield message;
  }
}

function makeQueryResult(messages: unknown[]): AsyncGenerator<unknown, void> & {
  applyFlagSettings: jest.Mock;
  setPermissionMode: jest.Mock;
  setModel: jest.Mock;
} {
  return Object.assign(makeMessages(messages), {
    applyFlagSettings: jest.fn().mockResolvedValue(undefined),
    setPermissionMode: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
  });
}

describe('claude-session Claude integration', () => {
  it('omits a context snapshot when the live query is unavailable', async () => {
    expect(
      await getContextUsageForClaudeSession(
        'absent-project',
        'absent-worktree',
        'absent-chat',
      ),
    ).toBeNull();
  });

  it.each([false, true])(
    'captures the local summary and its categories at turn end with Early access=%s',
    async (earlyAccess) => {
      setExperimentalFeaturesEnabled(earlyAccess);
      const summary = jest.fn().mockResolvedValue({
        categories: [
          {
            name: 'Messages',
            tokens: 33,
            kind: 'used',
            privateDetail: 'discard',
          },
          ...Array.from({ length: 30 }, (_, index) => ({
            name: `Category ${index}`,
            tokens: 1,
            kind: 'free',
          })),
        ],
        totalTokens: 33,
        rawMaxTokens: 200000,
        percentage: 0.02,
      });
      const query = Object.assign(
        makeQueryResult([
          {
            type: 'assistant',
            message: {
              id: 'audit-root',
              content: [],
              usage: {
                input_tokens: 10,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 3,
              },
            },
          },
          { type: 'result', is_error: false, result: 'done' },
        ]),
        { getContextUsage: summary },
      );
      mockQuery.mockReturnValue(query);
      const capture = jest
        .spyOn(getObservabilityService(), 'observeChatEvent')
        .mockImplementation(() => undefined);
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'context-audit',
          model: 'opus',
        },
        jest.fn(),
        getNoWindow,
      );
      try {
        session.sendMessage('context test', { userMessageId: 'context-user' });
        await flush();
        await flush();
        expect(summary).toHaveBeenCalledTimes(1);
        // SDK summary is locally estimated; detail='full' would do token-count API work.
        expect(summary).toHaveBeenCalledWith({ detail: 'summary' });
        const snapshot = capture.mock.calls.find(
          (call) => readEventType(call[3]) === 'canopy_context_snapshot',
        )?.[3];
        expect(snapshot).toMatchObject({
          userMessageId: 'context-user',
          context: { endTokens: 33, windowTokens: 200000 },
        });
        const context: unknown =
          typeof snapshot === 'object' && snapshot !== null
            ? Reflect.get(snapshot, 'context')
            : undefined;
        const categories: unknown =
          typeof context === 'object' && context !== null
            ? Reflect.get(context, 'categories')
            : undefined;
        expect(categories).toHaveLength(24);
        expect(Array.isArray(categories) ? categories[0] : undefined).toEqual({
          name: 'Messages',
          tokens: 33,
          kind: 'used',
        });
      } finally {
        await session.destroy();
        capture.mockRestore();
        setExperimentalFeaturesEnabled(false);
      }
    },
  );

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

  afterEach(() => {
    resetClaudeCodeGraphOrientationForTests();
    jest.clearAllMocks();
    mockGetChildToolLiveness.mockReturnValue({ kind: 'no-live-session' });
    mockQuery.mockReset();
    mockSpawn.mockReset();
    mockSpawnClaudeCodeProcessOffMain.mockReset();
    mockKillChildProcessGroup.mockReset();
    mockRegisterCanopyWorktreeSessionRoute.mockClear();
    mockUnregisterCanopyWorktreeSessionRoute.mockClear();
    mockUnregisterRoutesForSession.mockClear();
    mockGetCanopyWorktreeMcpUrl.mockClear();
    mockGetCanopyWorktreeUiMcpUrl.mockClear();
    mockPlanTrackingTabs.mockReset();
    mockPlanTrackingTabs.mockResolvedValue({
      version: 1,
      tabs: [],
      activeTabId: '',
    });
    createTrackedPlanMock.mockReset();
    updateTrackedPlanMock.mockReset();
    sendToWindowMock.mockReset();
    sendToWindowDetailedMock.mockReset();
    sendToWindowDetailedMock.mockImplementation((window: unknown) =>
      window ? { delivered: true } : { delivered: false, reason: 'no_window' },
    );
    mockApprovalCheck.mockReset();
    mockApprovalSetMode.mockReset();
    mockApprovalInvalidatePending.mockReset();
    mockApprovalDispose.mockReset();
    mockCreateApprovalSession.mockClear();
    mockHasCodeGraph.mockReset();
    mockHasCodeGraph.mockReturnValue(false);
    mockManagedDelegationEnabled.mockReturnValue(false);
    mockCreateManagedDelegationSession.mockReset();
    if (originalHarnessNativeMemory === undefined) {
      delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    } else {
      process.env.CANOPY_HARNESS_NATIVE_MEMORY = originalHarnessNativeMemory;
    }
    mockResolveClaudeCompatibleInvocation.mockReset();
    mockLoadCachedInventory.mockReset();
    mockLoadCachedInventory.mockResolvedValue(null);
    mockResolveOrgGatewayCredential.mockReset();
    mockMarkOrgGatewayCredentialRejected.mockReset();
    mockMarkOrgGatewayCredentialRejected.mockResolvedValue(undefined);
    initOllamaModels([]);
  });

  it('opts native Claude into provider lifecycle events and per-task Stop only', async () => {
    const originalLifecycleEnv =
      process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS;
    process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '0';
    const nativeQueryCalled = createGate();
    mockQuery.mockImplementation(() => {
      nativeQueryCalled.release();
      return makeMessages([]);
    });

    const nativeSession = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'native-lifecycle-env',
      },
      jest.fn(),
      getNoWindow,
    );

    try {
      await nativeQueryCalled.promise;
      expect({
        lifecycleEnv:
          claudeQueryParams(0).options?.env
            ?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS,
        perTaskStopAffordance:
          claudeQueryParams(0).options?.perTaskStopAffordance,
      }).toEqual({
        lifecycleEnv: '1',
        perTaskStopAffordance: true,
      });
    } finally {
      await nativeSession.destroy();
      if (originalLifecycleEnv === undefined) {
        delete process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS;
      } else {
        process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS =
          originalLifecycleEnv;
      }
    }
  });

  it('does not enable native Claude lifecycle settings for an Ollama session', async () => {
    const originalLifecycleEnv =
      process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS;
    process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '0';
    const queryCalled = createGate();
    mockQuery.mockImplementation(() => {
      queryCalled.release();
      return makeMessages([]);
    });

    const session = new ClaudeCodeProvider({
      providerType: 'ollama',
    }).createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ollama-lifecycle-env',
      },
      jest.fn(),
      getNoWindow,
    );

    try {
      await queryCalled.promise;
      expect(
        claudeQueryParams().options?.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS,
      ).not.toBe('1');
      expect(claudeQueryParams().options?.perTaskStopAffordance).not.toBe(true);
      expect(captureClaudeStopFence(session)).toBeUndefined();
      await expect(interruptClaudeSessionForStop(session)).resolves.toEqual({
        outcome: 'not-native-claude',
      });
    } finally {
      await session.destroy();
      if (originalLifecycleEnv === undefined) {
        delete process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS;
      } else {
        process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS =
          originalLifecycleEnv;
      }
    }
  });

  it('publishes a queue-order turn lifecycle for an Ollama session', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'ollama-turn-lifecycle',
    };
    const lifecycleEvents: unknown[] = [];
    releaseClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleSink((event) => {
      lifecycleEvents.push(event);
    });
    const rootResultAdmitted = createGate();
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const firstPrompt = await input.next();
        if (firstPrompt.done) return;
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'ollama-root',
        };
        yield { type: 'result', is_error: false, result: 'Ollama root done' };
      })();
    });
    const session = new ClaudeCodeProvider({
      providerType: 'ollama',
    }).createSession(
      { cwd: '/tmp/repo', ...scope },
      (event: unknown) => {
        if (readEventString(event, 'result') === 'Ollama root done')
          rootResultAdmitted.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Ollama turn', {
        userMessageId: 'ollama-user-message',
      });
      await rootResultAdmitted.promise;
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'TurnStarted',
          provider: 'claude',
          turnId: 'ollama-user-message',
          phase: 'start',
          origin: 'user',
          binding: 'bound',
          userMessageIds: ['ollama-user-message'],
        }),
      );
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'TurnEnded',
          turnId: 'ollama-user-message',
          binding: 'bound',
          userMessageIds: ['ollama-user-message'],
          outcome: 'completed',
          source: 'result',
        }),
      );
    } finally {
      await flush();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('ends an Ollama turn whose query ends before its result', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'ollama-lost-turn',
    };
    const lifecycleEvents: unknown[] = [];
    const turnEnded = createGate();
    releaseClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleSink((event) => {
      lifecycleEvents.push(event);
      if (readEventType(event) === 'TurnEnded') turnEnded.release();
    });
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const firstPrompt = await input.next();
        if (firstPrompt.done) return;
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'ollama-lost-root',
        };
      })();
    });
    const session = new ClaudeCodeProvider({
      providerType: 'ollama',
    }).createSession({ cwd: '/tmp/repo', ...scope }, jest.fn(), getNoWindow);

    try {
      session.sendMessage('Ollama turn', {
        userMessageId: 'ollama-lost-message',
      });
      await turnEnded.promise;
      // The session's own terminal for the ended query closes the turn.
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'TurnEnded',
          turnId: 'ollama-lost-message',
          userMessageIds: ['ollama-lost-message'],
          outcome: 'cancelled',
          terminalReason: 'Session ended',
        }),
      );
    } finally {
      await flush();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('keeps restricted managed Claude child launches outside native Stop setup', async () => {
    const childRunnerSource = readFileSync(
      resolve(__dirname, '../agents/delegation/claude-runner.ts'),
      'utf8',
    );

    // The child runner is intentionally outside this session worker's edit
    // scope. Pin its actual launch boundary so parent-only opt-ins do not leak
    // into restricted managed child processes.
    expect(childRunnerSource).toContain('env: prepared.environment');
    expect(childRunnerSource).toContain('env: { ...prepared.environment }');
    expect(childRunnerSource).not.toContain(
      'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS',
    );
    expect(childRunnerSource).not.toContain('perTaskStopAffordance');
    expect(childRunnerSource).not.toContain('interruptClaudeSessionForStop');

    const originalLifecycleEnv =
      process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS;
    process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
    const restrictedEnvironment = { PATH: '/restricted-child-path' };
    const queryOptionsHolder: { options: ClaudeQueryOptions | undefined } = {
      options: undefined,
    };
    const terminal = createGate();
    mockQuery.mockImplementation((params) => {
      queryOptionsHolder.options = params.options;
      return Object.assign(
        makeQueryResult([
          {
            type: 'system',
            subtype: 'init',
            session_id: 'restricted-child-session',
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'restricted child done',
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        ]),
        {
          close: jest.fn(),
          cancelAsyncMessage: jest.fn(),
          interrupt: jest.fn(),
        },
      );
    });
    const childRunner = createClaudeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          model: 'claude-test',
          environment: restrictedEnvironment,
          tools: new DelegationNativePolicy({
            cwd: '/tmp/repo',
            writePaths: [],
            approval: {
              check: jest.fn(() => Promise.resolve({ decision: 'allow' })),
              setMode: jest.fn(),
              reevaluatePendingApprovals: jest.fn(() => Promise.resolve()),
              dispose: jest.fn(),
            },
            mode: (): ApprovalMode => 'auto',
            allowed: (): Promise<boolean> => Promise.resolve(true),
            signal: new AbortController().signal,
            delegationId: 'restricted-child-no-stop-setup',
            instructions: (): string => '',
            emit: (): Promise<void> => Promise.resolve(),
          }),
        }),
      reportError: jest.fn(),
    });
    const request = {
      delegationId: 'restricted-child-no-stop-setup',
      runGeneration: 1,
      launchKey: 'restricted-child-launch',
      parent: {
        harnessId: 'codex',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'root-chat',
        sessionKey: 'project/worktree/root-chat',
        turnId: 'root-turn',
        toolCallId: 'delegate-call',
        runtimeGeneration: 1,
        depth: 0,
      },
      task: {
        modelId: 'claude-test',
        description: 'Check restricted launch options',
        prompt: 'Inspect the launch environment.',
        executionMode: 'foreground',
        contextPolicy: 'task_only',
        isolation: 'shared_worktree',
      },
      route: {
        selectedModelId: 'claude-test',
        runtimeModelId: 'claude-test',
        harnessId: 'claude',
        runtimeKind: 'claude-sdk',
        runnerRegistrationId: 'claude-local',
        runtimeVersion: '1',
        adapterVersion: '1',
        modelSource: 'test',
        providerType: 'subscription',
        assignmentRevision: 'assignment-1',
        billingAuthority: 'subscription',
        aiCreditsRouted: false,
        capabilities: ['read'],
        supportedThinkingLevels: [],
        capabilitySnapshotHash: 'hash',
        capabilityGeneration: 1,
        policyRevision: 'read-only-1',
      },
      cwd: '/tmp/repo',
      effectivePermission: 'read-only',
      signal: new AbortController().signal,
    } satisfies AgentRunRequest;
    let handle: Awaited<ReturnType<typeof childRunner.start>> | undefined;
    try {
      handle = await childRunner.start(request, (event) => {
        if (event.event.type === 'terminal') terminal.release();
        return Promise.resolve();
      });
      await terminal.promise;
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(queryOptionsHolder.options?.env).toEqual(restrictedEnvironment);
      expect(
        queryOptionsHolder.options?.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS,
      ).toBeUndefined();
      expect(queryOptionsHolder.options?.perTaskStopAffordance).toBeUndefined();
    } finally {
      if (handle) await childRunner.close(handle);
      if (originalLifecycleEnv === undefined) {
        delete process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS;
      } else {
        process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS =
          originalLifecycleEnv;
      }
    }
  });

  it('binds a wake-racing queued send by its provider UUID, not FIFO position', () => {
    const tracker = new ClaudeTurnBindingTracker();
    tracker.registerYielded('earlier-send-uuid', {
      submissionId: 'earlier-send',
      userMessageId: 'earlier-user-message',
      kind: 'ordinary',
    });
    tracker.registerYielded('wake-racing-send-uuid', {
      submissionId: 'wake-racing-send',
      userMessageId: 'wake-racing-user-message',
      kind: 'ordinary',
    });

    tracker.openTurn('wake-turn');
    const binding = tracker.observeUserMessageUuids(['wake-racing-send-uuid']);

    expect(binding).toMatchObject({
      turnId: 'wake-turn',
      origin: 'user',
      binding: 'bound',
      submissionIds: ['wake-racing-send'],
      userMessageIds: ['wake-racing-user-message'],
      providerUserMessageUuids: ['wake-racing-send-uuid'],
    });
    expect(binding?.submissionIds).not.toContain('earlier-send');
    expect(tracker.sealAtResult({ resultIndex: 3 })).toMatchObject({
      turnId: 'wake-turn',
      resultIndex: 3,
      binding: 'bound',
    });
  });

  it('binds a wake-racing root send to its UUID instead of an earlier unmatched send', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'claude-wake-uuid-binding',
    };
    const lifecycleEvents: unknown[] = [];
    releaseClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleClockForTests(() => 1234);
    setClaudeTurnLifecycleSink((event) => {
      lifecycleEvents.push(event);
    });

    const wakeInitAdmitted = createGate();
    const wakePromptPulled = createGate();
    const wakeResultAdmitted = createGate();
    const allowStreamExit = createGate();
    let wakeUuid: string | undefined;
    const admittedEvents: unknown[] = [];
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const earlierPrompt = await input.next();
        if (earlierPrompt.done) return;
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'earlier-session',
        };
        // The provider omitted UUID evidence for this earlier send. A FIFO
        // guess must not steal the next turn's later, explicitly correlated ID.
        yield { type: 'result', is_error: false, result: 'Earlier turn done' };
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'wake-session',
        };
        const wakePrompt = await input.next();
        if (wakePrompt.done) return;
        wakeUuid = readEventString(wakePrompt.value, 'uuid');
        wakePromptPulled.release();
        yield {
          type: 'command_lifecycle',
          parent_tool_use_id: null,
          command_uuid: wakeUuid,
          state: 'started',
        };
        yield {
          type: 'result',
          is_error: false,
          result: 'Wake send done',
          ...(wakeUuid
            ? {
                user_message_uuid: wakeUuid,
                user_message_uuids: [wakeUuid],
              }
            : {}),
        };
        await allowStreamExit.promise;
      })();
    });

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
      (event: unknown) => {
        admittedEvents.push(event);
        if (
          readEventType(event) === 'system' &&
          readEventString(event, 'session_id') === 'wake-session'
        )
          wakeInitAdmitted.release();
        if (readEventString(event, 'result') === 'Wake send done')
          wakeResultAdmitted.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Earlier send without provider UUID evidence', {
        userMessageId: 'earlier-user-message',
      });
      await wakeInitAdmitted.promise;
      session.sendMessage('Wake-racing send', {
        userMessageId: 'wake-racing-user-message',
      });
      await wakePromptPulled.promise;
      await wakeResultAdmitted.promise;

      if (!wakeUuid) throw new Error('Expected a wake-racing provider UUID');
      const racingWakeUuid = wakeUuid;
      const wakeTurnStarted = lifecycleEvents.find(
        (event) =>
          readEventType(event) === 'TurnStarted' &&
          readEventString(event, 'origin') === 'user' &&
          readEventString(event, 'binding') === 'bound' &&
          readEventStringArray(event, 'userMessageIds').includes(
            'wake-racing-user-message',
          ),
      );
      expect(wakeTurnStarted).toBeDefined();
      expect(readEventString(wakeTurnStarted, 'turnId')).toEqual(
        expect.stringMatching(/^[0-9a-f-]{36}$/i),
      );
      expect(
        readEventStringArray(wakeTurnStarted, 'providerUserMessageUuids'),
      ).toEqual([wakeUuid]);
      expect(lifecycleEvents).not.toContainEqual(
        expect.objectContaining({
          type: 'TurnStarted',
          origin: 'user',
          binding: 'bound',
          userMessageIds: ['earlier-user-message'],
          providerUserMessageUuids: [wakeUuid],
        }),
      );
      const boundTurn = lifecycleEvents.find(
        (event) =>
          readEventType(event) === 'TurnStarted' &&
          readEventString(event, 'origin') === 'user' &&
          readEventString(event, 'binding') === 'bound' &&
          readEventStringArray(event, 'providerUserMessageUuids').includes(
            racingWakeUuid,
          ),
      );
      const pendingTurns = lifecycleEvents.filter(
        (event) =>
          readEventType(event) === 'TurnStarted' &&
          readEventString(event, 'origin') === 'autonomous' &&
          readEventString(event, 'binding') === 'pending',
      );
      const pendingTurn = pendingTurns[pendingTurns.length - 1];
      expect(boundTurn).toBeDefined();
      expect(pendingTurn).toBeDefined();
      expect(readEventString(boundTurn, 'turnId')).toBe(
        readEventString(pendingTurn, 'turnId'),
      );
      expect(
        admittedEvents.find(
          (event) => readEventString(event, 'result') === 'Wake send done',
        ),
      ).toMatchObject({
        canopy_turn_user_message_id: 'wake-racing-user-message',
      });
    } finally {
      allowStreamExit.release();
      await flush();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      setClaudeTurnLifecycleClockForTests(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('does not let a yielded queued send lend its identity to a later uncorrelated wake', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'claude-wake-without-uuid',
    };
    const lifecycleEvents: unknown[] = [];
    const admittedEvents: unknown[] = [];
    releaseClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleSink((event) => {
      lifecycleEvents.push(event);
    });

    const firstInitAdmitted = createGate();
    const firstResultAdmitted = createGate();
    const queuedPromptYielded = createGate();
    const wakeInitAdmitted = createGate();
    const wakeResultAdmitted = createGate();
    const allowStreamExit = createGate();
    let queuedPromptUuid: string | undefined;
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const firstPrompt = await input.next();
        if (firstPrompt.done) return;
        const firstUuid = readEventString(firstPrompt.value, 'uuid');
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'initial-root',
        };
        yield {
          type: 'result',
          is_error: false,
          result: 'Initial root done',
          duration_ms: Number.POSITIVE_INFINITY,
          ...(firstUuid ? { user_message_uuid: firstUuid } : {}),
        };

        const queuedPrompt = await input.next();
        if (queuedPrompt.done) return;
        queuedPromptUuid = readEventString(queuedPrompt.value, 'uuid');
        queuedPromptYielded.release();
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'uncorrelated-wake',
        };
        await allowStreamExit.promise;
        yield {
          type: 'result',
          is_error: false,
          result: 'Uncorrelated wake done',
          duration_ms: 1250.5,
        };
      })();
    });

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
      (event: unknown) => {
        admittedEvents.push(event);
        if (readEventString(event, 'session_id') === 'initial-root')
          firstInitAdmitted.release();
        if (readEventString(event, 'result') === 'Initial root done')
          firstResultAdmitted.release();
        if (readEventString(event, 'session_id') === 'uncorrelated-wake')
          wakeInitAdmitted.release();
        if (readEventString(event, 'result') === 'Uncorrelated wake done')
          wakeResultAdmitted.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Initial root prompt', {
        userMessageId: 'initial-user-message',
      });
      await firstInitAdmitted.promise;
      await firstResultAdmitted.promise;
      session.sendMessage('Yielded before wake init', {
        userMessageId: 'queued-user-message',
      });
      await queuedPromptYielded.promise;
      await wakeInitAdmitted.promise;

      const fence = captureClaudeStopFence(session);
      expect(fence).toBeDefined();
      if (!fence) throw new Error('Expected a native Claude Stop fence');
      expect(fence.userMessageId).toBe(fence.turnId);
      expect(fence.userMessageId).not.toBe('queued-user-message');

      allowStreamExit.release();
      await wakeResultAdmitted.promise;
      expect(queuedPromptUuid).toEqual(expect.any(String));
      const uncorrelatedTerminal = admittedEvents.find(
        (event) =>
          readEventString(event, 'result') === 'Uncorrelated wake done',
      );
      expect(uncorrelatedTerminal).toBeDefined();
      expect(uncorrelatedTerminal).not.toHaveProperty(
        'canopy_turn_user_message_id',
      );
      const initialTerminal = lifecycleEvents.find(
        (event) =>
          readEventType(event) === 'TurnEnded' &&
          readEventString(event, 'origin') === 'user',
      );
      expect(initialTerminal).toBeDefined();
      expect(initialTerminal).not.toHaveProperty('durationMs');
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'TurnEnded',
          turnId: fence.turnId,
          origin: 'autonomous',
          binding: 'unbound',
          userMessageIds: [],
          durationMs: 1250.5,
          source: 'result',
        }),
      );
      expect(lifecycleEvents).not.toContainEqual(
        expect.objectContaining({
          type: 'TurnEnded',
          userMessageIds: ['queued-user-message'],
        }),
      );
    } finally {
      allowStreamExit.release();
      await flush();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('starts a wake turn with the cause its task notification names', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'claude-wake-cause',
    };
    const lifecycleEvents: unknown[] = [];
    releaseClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleSink((event) => {
      lifecycleEvents.push(event);
    });
    const wakeResultAdmitted = createGate();
    const admittedEvents: unknown[] = [];
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const firstPrompt = await input.next();
        if (firstPrompt.done) return;
        const uuid = readEventString(firstPrompt.value, 'uuid');
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'prompt-turn',
        };
        yield {
          type: 'result',
          is_error: false,
          result: 'Prompt turn done',
          ...(uuid ? { user_message_uuid: uuid } : {}),
        };
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task-1',
          tool_use_id: 'tool-1',
          status: 'completed',
          output_file: '/tmp/task-1.out',
          summary: 'Ran the tests',
        };
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'wake-turn',
        };
        yield { type: 'result', is_error: false, result: 'Wake done' };
      })();
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
      (event: unknown) => {
        admittedEvents.push(event);
        if (readEventString(event, 'result') === 'Wake done')
          wakeResultAdmitted.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Start a background task', {
        userMessageId: 'prompt-user-message',
      });
      await wakeResultAdmitted.promise;
      const starts = lifecycleEvents.filter(
        (event) =>
          readEventType(event) === 'TurnStarted' &&
          readEventString(event, 'phase') === 'start',
      );
      expect(starts).toHaveLength(2);
      expect(starts[0]).not.toHaveProperty('spawnedBy');
      expect(starts[1]).toMatchObject({
        origin: 'autonomous',
        spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
      });
      // The wake's result carries its turn id for its own turn diff (40f).
      const results = admittedEvents.filter(
        (event) => readEventType(event) === 'result',
      );
      expect(results[0]).not.toHaveProperty('canopy_wake_turn_id');
      expect(results[0]).toMatchObject({
        canopy_execution_turn_id: readEventString(starts[0], 'turnId'),
      });
      expect(results[1]).toMatchObject({
        result: 'Wake done',
        canopy_wake_turn_id: readEventString(starts[1], 'turnId'),
        canopy_execution_turn_id: readEventString(starts[1], 'turnId'),
      });
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'TurnEnded',
          turnId: readEventString(starts[1], 'turnId'),
          origin: 'autonomous',
          spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
        }),
      );
    } finally {
      await flush();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('never starts a prompt turn with a wake cause its task notification left behind', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'claude-stale-wake-cause',
    };
    const lifecycleEvents: unknown[] = [];
    releaseClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleSink((event) => {
      lifecycleEvents.push(event);
    });
    const firstResultAdmitted = createGate();
    const secondResultAdmitted = createGate();
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const firstPrompt = await input.next();
        if (firstPrompt.done) return;
        const firstUuid = readEventString(firstPrompt.value, 'uuid');
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'first-prompt',
        };
        // The task ends mid-turn; the CLI folds its notification into this
        // turn instead of starting a wake.
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task-1',
          tool_use_id: 'tool-1',
          status: 'completed',
          output_file: '/tmp/task-1.out',
          summary: 'Ran the tests',
        };
        yield {
          type: 'result',
          is_error: false,
          result: 'First prompt done',
          ...(firstUuid ? { user_message_uuid: firstUuid } : {}),
        };
        const secondPrompt = await input.next();
        if (secondPrompt.done) return;
        const secondUuid = readEventString(secondPrompt.value, 'uuid');
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'second-prompt',
        };
        yield {
          type: 'result',
          is_error: false,
          result: 'Second prompt done',
          ...(secondUuid ? { user_message_uuid: secondUuid } : {}),
        };
      })();
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
      (event: unknown) => {
        if (readEventString(event, 'result') === 'First prompt done')
          firstResultAdmitted.release();
        if (readEventString(event, 'result') === 'Second prompt done')
          secondResultAdmitted.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Start a background task', {
        userMessageId: 'first-user-message',
      });
      await firstResultAdmitted.promise;
      session.sendMessage('Follow up while idle', {
        userMessageId: 'second-user-message',
      });
      await secondResultAdmitted.promise;
      const starts = lifecycleEvents.filter(
        (event) => readEventType(event) === 'TurnStarted',
      );
      expect(starts.length).toBeGreaterThan(0);
      // A published cause draws a wake boundary until the prompt binds.
      for (const start of starts) expect(start).not.toHaveProperty('spawnedBy');
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'TurnEnded',
          origin: 'user',
          userMessageIds: ['second-user-message'],
        }),
      );
    } finally {
      await flush();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it.each([
    {
      name: 'names the one live Monitor task',
      monitors: ['monitor-1'],
      origin: { kind: 'task-notification', producer: 'session-task' },
      cron: false,
      fireCommand: false,
      finishedTask: false,
      spawnedBy: {
        taskId: 'task-monitor-1',
        toolUseId: 'tool-monitor-1',
        event: true,
      },
    },
    {
      name: 'names no task when two Monitor tasks are live',
      monitors: ['monitor-1', 'monitor-2'],
      origin: { kind: 'task-notification', producer: 'session-task' },
      cron: false,
      fireCommand: false,
      finishedTask: false,
      spawnedBy: { event: true },
    },
    {
      name: 'leaves a scheduled run uncaused',
      monitors: ['monitor-1'],
      origin: { kind: 'task-notification', subkind: 'scheduled-trigger' },
      cron: false,
      fireCommand: false,
      finishedTask: false,
      spawnedBy: undefined,
    },
    {
      name: "keeps a finished task's cause",
      monitors: ['monitor-1'],
      origin: { kind: 'task-notification', producer: 'session-task' },
      cron: false,
      fireCommand: false,
      finishedTask: true,
      spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
    },
    {
      // A cron job's fire starts a turn with a command no send queued, and
      // reports no origin.
      name: 'names the cron job whose fire started it',
      monitors: [],
      origin: undefined,
      cron: true,
      fireCommand: true,
      finishedTask: false,
      spawnedBy: { toolUseId: 'tool-cron', scheduled: true },
    },
    {
      name: 'leaves a turn uncaused when a cron job is live but no command fired',
      monitors: [],
      origin: undefined,
      cron: true,
      fireCommand: false,
      finishedTask: false,
      spawnedBy: undefined,
    },
    {
      name: "leaves a CLI's command uncaused with no cron job",
      monitors: [],
      origin: undefined,
      cron: false,
      fireCommand: true,
      finishedTask: false,
      spawnedBy: undefined,
    },
  ])(
    "records a Monitor event as its wake turn's cause: $name",
    async ({
      monitors,
      origin,
      cron,
      fireCommand,
      finishedTask,
      spawnedBy,
    }) => {
      mockLoadCachedInventory.mockResolvedValue(null);
      const scope = {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'claude-event-wake',
      };
      const lifecycleEvents: unknown[] = [];
      releaseClaudeTurnLifecycleProducer(scope);
      setClaudeTurnLifecycleSink((event) => {
        lifecycleEvents.push(event);
      });
      const wakeResultAdmitted = createGate();
      const admittedEvents: unknown[] = [];
      mockQuery.mockImplementation(({ prompt }) => {
        if (typeof prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const input = prompt[Symbol.asyncIterator]();
        return (async function* (): AsyncGenerator<unknown, void> {
          const firstPrompt = await input.next();
          if (firstPrompt.done) return;
          const uuid = readEventString(firstPrompt.value, 'uuid');
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'prompt-turn',
          };
          yield {
            type: 'assistant',
            parent_tool_use_id: null,
            message: {
              id: 'prompt-assistant',
              content: [
                ...monitors.map((monitor) => ({
                  type: 'tool_use',
                  id: `tool-${monitor}`,
                  name: 'Monitor',
                  input: { description: 'Watch the logs' },
                })),
                ...(cron
                  ? [
                      {
                        type: 'tool_use',
                        id: 'tool-cron',
                        name: 'CronCreate',
                        input: {
                          cron: '0 9 * * *',
                          prompt: 'Check the deploy',
                        },
                      },
                    ]
                  : []),
              ],
            },
          };
          if (cron)
            yield {
              type: 'user',
              parent_tool_use_id: null,
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'tool-cron',
                    content: 'Scheduled one-shot task job-1',
                  },
                ],
              },
              tool_use_result: {
                id: 'job-1',
                humanSchedule: 'Every day at 9:00',
                recurring: false,
              },
            };
          for (const monitor of monitors)
            yield {
              type: 'system',
              subtype: 'task_started',
              task_id: `task-${monitor}`,
              tool_use_id: `tool-${monitor}`,
              description: 'Watch the logs',
              task_type: 'local_bash',
            };
          yield {
            type: 'result',
            is_error: false,
            result: 'Prompt turn done',
            ...(uuid ? { user_message_uuid: uuid } : {}),
          };
          if (finishedTask)
            yield {
              type: 'system',
              subtype: 'task_notification',
              task_id: 'task-1',
              tool_use_id: 'tool-1',
              status: 'completed',
              output_file: '/tmp/task-1.out',
              summary: 'Ran the tests',
            };
          if (fireCommand)
            yield {
              type: 'command_lifecycle',
              command_uuid: 'cli-fire-command',
              state: 'started',
              session_id: 'wake-turn',
            };
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'wake-turn',
          };
          yield {
            type: 'result',
            is_error: false,
            result: 'Wake done',
            ...(origin === undefined ? {} : { origin }),
          };
        })();
      });
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          chatId: scope.chatId,
        },
        (event: unknown) => {
          admittedEvents.push(event);
          if (readEventString(event, 'result') === 'Wake done')
            wakeResultAdmitted.release();
        },
        getNoWindow,
      );

      try {
        session.sendMessage('Watch the logs', {
          userMessageId: 'prompt-user-message',
        });
        await wakeResultAdmitted.promise;
        const starts = lifecycleEvents.filter(
          (event) =>
            readEventType(event) === 'TurnStarted' &&
            readEventString(event, 'phase') === 'start',
        );
        expect(starts).toHaveLength(2);
        const wakeTurnId = readEventString(starts[1], 'turnId');
        // A finished task's or a fired job's cause precedes its turn.
        if (spawnedBy !== undefined && !('event' in spawnedBy))
          expect(starts[1]).toMatchObject({ spawnedBy });
        const wakeEnd = lifecycleEvents.findIndex(
          (event) =>
            readEventType(event) === 'TurnEnded' &&
            readEventString(event, 'turnId') === wakeTurnId,
        );
        const ended = lifecycleEvents[wakeEnd];
        expect(ended).toMatchObject({ origin: 'autonomous' });
        expect(
          typeof ended === 'object' && ended !== null && 'spawnedBy' in ended
            ? ended.spawnedBy
            : undefined,
        ).toEqual(spawnedBy);
        const wakeResult = admittedEvents.find(
          (event) => readEventString(event, 'result') === 'Wake done',
        );
        if (spawnedBy === undefined) {
          expect(wakeResult).not.toHaveProperty('canopy_wake_turn_id');
        } else {
          expect(wakeResult).toMatchObject({ canopy_wake_turn_id: wakeTurnId });
        }
        if (spawnedBy !== undefined && 'event' in spawnedBy) {
          // The reducer takes a cause from a binding update, not from the end.
          expect(lifecycleEvents[wakeEnd - 1]).toMatchObject({
            type: 'TurnStarted',
            phase: 'binding-update',
            turnId: wakeTurnId,
            origin: 'autonomous',
            spawnedBy,
          });
        } else {
          expect(lifecycleEvents).not.toContainEqual(
            expect.objectContaining({
              type: 'TurnStarted',
              phase: 'binding-update',
              turnId: wakeTurnId,
            }),
          );
        }
      } finally {
        await flush();
        await session.destroy();
        setClaudeTurnLifecycleSink(null);
        releaseClaudeTurnLifecycleProducer(scope);
      }
    },
  );

  it("stamps each wake's terminal with its own turn id, an error terminal too", async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'claude-wake-terminals',
    };
    const lifecycleEvents: unknown[] = [];
    releaseClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleSink((event) => {
      lifecycleEvents.push(event);
    });
    const secondWakeAdmitted = createGate();
    const admittedEvents: unknown[] = [];
    const notification = (taskId: string): Record<string, unknown> => ({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: `tool-${taskId}`,
      status: 'completed',
      output_file: `/tmp/${taskId}.out`,
      summary: 'Done',
    });
    const init = (sessionId: string): Record<string, unknown> => ({
      type: 'system',
      subtype: 'init',
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const firstPrompt = await input.next();
        if (firstPrompt.done) return;
        const uuid = readEventString(firstPrompt.value, 'uuid');
        yield init('prompt-turn');
        yield {
          type: 'result',
          is_error: false,
          result: 'Prompt turn done',
          ...(uuid ? { user_message_uuid: uuid } : {}),
        };
        yield notification('task-1');
        yield init('wake-1');
        // The first wake ends in an error; the next wake opens right away.
        yield { type: 'error', error: 'Wake failed' };
        yield notification('task-2');
        yield init('wake-2');
        yield { type: 'result', is_error: false, result: 'Second wake done' };
      })();
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
      (event: unknown) => {
        admittedEvents.push(event);
        if (readEventString(event, 'result') === 'Second wake done')
          secondWakeAdmitted.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Start two background tasks', {
        userMessageId: 'prompt-user-message',
      });
      await secondWakeAdmitted.promise;
      const wakeStarts = lifecycleEvents.filter(
        (event) =>
          readEventType(event) === 'TurnStarted' &&
          readEventString(event, 'phase') === 'start' &&
          typeof event === 'object' &&
          event !== null &&
          'spawnedBy' in event,
      );
      expect(wakeStarts).toHaveLength(2);
      expect(
        admittedEvents.find((event) => readEventType(event) === 'error'),
      ).toMatchObject({
        canopy_wake_turn_id: readEventString(wakeStarts[0], 'turnId'),
      });
      expect(
        admittedEvents.find(
          (event) => readEventString(event, 'result') === 'Second wake done',
        ),
      ).toMatchObject({
        canopy_wake_turn_id: readEventString(wakeStarts[1], 'turnId'),
      });
    } finally {
      await flush();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('uses result-fallback for lifecycle state when only system status was received', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'claude-status-is-not-native-state',
    };
    const lifecycleEvents: unknown[] = [];
    releaseClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleSink((event) => {
      lifecycleEvents.push(event);
    });
    const rootResultAdmitted = createGate();
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const firstPrompt = await input.next();
        if (firstPrompt.done) return;
        const uuid = readEventString(firstPrompt.value, 'uuid');
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'status-root',
        };
        yield { type: 'system', subtype: 'status', status: 'idle' };
        yield {
          type: 'result',
          is_error: false,
          result: 'Status-only root done',
          ...(uuid ? { user_message_uuid: uuid } : {}),
        };
      })();
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
      (event: unknown) => {
        if (readEventString(event, 'result') === 'Status-only root done')
          rootResultAdmitted.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Status-only turn', {
        userMessageId: 'status-user-message',
      });
      await rootResultAdmitted.promise;
      const statusTurn = lifecycleEvents.find(
        (event) =>
          readEventType(event) === 'TurnStarted' &&
          readEventString(event, 'binding') === 'bound' &&
          readEventStringArray(event, 'userMessageIds').includes(
            'status-user-message',
          ),
      );
      expect(statusTurn).toBeDefined();
      const statusTerminal = lifecycleEvents.find(
        (event) =>
          readEventType(event) === 'TurnEnded' &&
          readEventString(event, 'turnId') ===
            readEventString(statusTurn, 'turnId'),
      );
      expect(statusTerminal).toBeDefined();
      expect(statusTerminal).not.toHaveProperty('durationMs');
      expect(
        lifecycleEvents.filter(
          (event) => readEventType(event) === 'SessionState',
        ),
      ).toEqual([
        expect.objectContaining({
          state: 'idle',
          source: 'result-fallback',
          observedDuringTurnId: readEventString(statusTurn, 'turnId'),
        }),
      ]);
    } finally {
      await flush();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('reports unclassified SDK frames, the harness version and a missing session-state gate (turn-state phase 43a)', async () => {
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'claude-contract-guard',
    };
    releaseClaudeTurnLifecycleProducer(scope);
    mockLoadCachedInventory.mockResolvedValue(null);
    setClaudeTurnLifecycleSink(jest.fn());
    const diagnostics = jest
      .spyOn(getObservabilityService(), 'recordSessionDiagnostic')
      .mockImplementation(() => undefined);
    const resultAdmitted = createGate();
    const allowStreamExit = createGate();
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const firstPrompt = await input.next();
        if (firstPrompt.done) return;
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'contract-session',
          claude_code_version: '9.9.9',
        };
        // No session_state_changed: the gate the session asked for is missing.
        yield {
          type: 'system',
          subtype: 'brand_new_subtype',
          parent_tool_use_id: null,
        };
        yield { type: 'result', is_error: false, result: 'Done' };
        await allowStreamExit.promise;
      })();
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
      (event: unknown) => {
        if (readEventString(event, 'result') === 'Done')
          resultAdmitted.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Check the contract', {
        userMessageId: 'contract-user-turn',
      });
      await resultAdmitted.promise;
      const guardRecords = diagnostics.mock.calls
        .map(([record]) => record)
        .filter((record) => record.kind.startsWith('provider_'));
      expect(guardRecords).toEqual([
        expect.objectContaining({
          kind: 'provider_harness_version',
          chatId: scope.chatId,
          providerHarnessVersion: '9.9.9',
        }),
        expect.objectContaining({
          kind: 'provider_contract_unknown_event',
          providerContractEvent: 'system/brand_new_subtype',
        }),
        expect.objectContaining({
          kind: 'provider_contract_gate_missing',
          providerContractEvent: 'system/session_state_changed',
        }),
      ]);
    } finally {
      allowStreamExit.release();
      await flush();
      await session.destroy();
      diagnostics.mockRestore();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('checks the session-state gate only on provider results, not on host-synthesized terminals (turn-state phase 43a)', async () => {
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'claude-contract-host-terminal',
    };
    releaseClaudeTurnLifecycleProducer(scope);
    mockLoadCachedInventory.mockResolvedValue(null);
    setClaudeTurnLifecycleSink(jest.fn());
    const diagnostics = jest
      .spyOn(getObservabilityService(), 'recordSessionDiagnostic')
      .mockImplementation(() => undefined);
    const initReceived = createGate();
    const allowStreamExit = createGate();
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const firstPrompt = await input.next();
        if (firstPrompt.done) return;
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'contract-host-session',
          claude_code_version: '9.9.9',
        };
        initReceived.release();
        // The provider never answers; the destroy below ends the turn.
        await allowStreamExit.promise;
      })();
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
      jest.fn(),
      getNoWindow,
    );

    try {
      session.sendMessage('Stop before any result', {
        userMessageId: 'contract-host-turn',
      });
      await initReceived.promise;
      await flush();
      allowStreamExit.release();
      await session.destroy();
      await flush();
      expect(
        diagnostics.mock.calls
          .map(([record]) => record.kind)
          .filter((kind) => kind === 'provider_contract_gate_missing'),
      ).toEqual([]);
    } finally {
      allowStreamExit.release();
      diagnostics.mockRestore();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('normalizes root user and wake lifecycle at receipt while ignoring child events', async () => {
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'claude-lifecycle-receipt',
    };
    const lifecycleEvents: unknown[] = [];
    releaseClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleClockForTests(() => 1234);
    setClaudeTurnLifecycleSink((event) => {
      lifecycleEvents.push(event);
    });

    const rootInitAdmission = createGate();
    const allowRootInitAdmission = createGate();
    const runningStatusAdmission = createGate();
    const allowRunningStatusAdmission = createGate();
    const childStatusAdmission = createGate();
    const userResultAdmission = createGate();
    const wakeInitAdmission = createGate();
    const allowWakeInitAdmission = createGate();
    const allowStreamExit = createGate();

    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const firstPrompt = await input.next();
        if (firstPrompt.done) return;
        const userMessageUuid = readEventString(firstPrompt.value, 'uuid');
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'user-session',
          ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
        };
        yield {
          type: 'system',
          subtype: 'session_state_changed',
          parent_tool_use_id: null,
          state: 'running',
        };
        yield {
          type: 'system',
          subtype: 'session_state_changed',
          parent_tool_use_id: 'child-tool-use',
          state: 'requires_action',
        };
        yield {
          type: 'result',
          is_error: false,
          result: 'User turn done',
          ...(userMessageUuid ? { user_message_uuids: [userMessageUuid] } : {}),
        };
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'wake-session',
        };
        yield {
          type: 'system',
          subtype: 'session_state_changed',
          parent_tool_use_id: null,
          state: 'running',
        };
        yield { type: 'result', is_error: false, result: 'Wake done' };
        await allowStreamExit.promise;
      })();
    });

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
      (event: unknown) => {
        if (
          readEventType(event) === 'system' &&
          readEventString(event, 'subtype') === 'init' &&
          readEventString(event, 'session_id') === 'user-session'
        ) {
          rootInitAdmission.release();
          return allowRootInitAdmission.promise;
        }
        if (
          readEventType(event) === 'system' &&
          readEventString(event, 'subtype') === 'session_state_changed' &&
          readEventString(event, 'state') === 'running'
        ) {
          runningStatusAdmission.release();
          return allowRunningStatusAdmission.promise;
        }
        if (
          readEventType(event) === 'system' &&
          readEventString(event, 'subtype') === 'session_state_changed' &&
          readEventString(event, 'state') === 'requires_action'
        )
          childStatusAdmission.release();
        if (
          readEventType(event) === 'system' &&
          readEventString(event, 'subtype') === 'init' &&
          readEventString(event, 'session_id') === 'wake-session'
        ) {
          wakeInitAdmission.release();
          return allowWakeInitAdmission.promise;
        }
        if (readEventString(event, 'result') === 'User turn done')
          userResultAdmission.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Start a user turn', {
        userMessageId: 'lifecycle-user-turn',
      });
      await rootInitAdmission.promise;
      const userTurnId = readEventString(
        lifecycleEvents.find(
          (event) =>
            readEventType(event) === 'TurnStarted' &&
            readEventString(event, 'phase') === 'start',
        ),
        'turnId',
      );
      expect(userTurnId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
      expect(userTurnId).not.toBe('lifecycle-user-turn');
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'TurnStarted',
          turnId: userTurnId,
        }),
      );
      allowRootInitAdmission.release();

      await runningStatusAdmission.promise;
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'SessionState',
          state: 'running',
          source: 'provider',
        }),
      );
      allowRunningStatusAdmission.release();
      await childStatusAdmission.promise;
      expect(lifecycleEvents).not.toContainEqual(
        expect.objectContaining({
          type: 'SessionState',
          state: 'requires_action',
        }),
      );

      await wakeInitAdmission.promise;
      const startedTurns = lifecycleEvents.filter(
        (event) =>
          readEventType(event) === 'TurnStarted' &&
          readEventString(event, 'phase') === 'start',
      );
      expect(startedTurns).toHaveLength(2);
      expect(startedTurns).toContainEqual(
        expect.objectContaining({ turnId: userTurnId }),
      );
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'TurnStarted',
          phase: 'binding-update',
          turnId: userTurnId,
          origin: 'user',
          userMessageIds: ['lifecycle-user-turn'],
        }),
      );
      allowRunningStatusAdmission.release();
      allowWakeInitAdmission.release();
      await userResultAdmission.promise;
      expect(
        lifecycleEvents.filter(
          (event) =>
            readEventType(event) === 'SessionState' &&
            readEventString(event, 'source') === 'result-fallback',
        ),
      ).toHaveLength(0);
      const wakeStartTurns = lifecycleEvents.filter(
        (event) =>
          readEventType(event) === 'TurnStarted' &&
          readEventString(event, 'phase') === 'start',
      );
      expect(wakeStartTurns).toHaveLength(2);
      expect(wakeStartTurns).toContainEqual(
        expect.objectContaining({ origin: 'autonomous' }),
      );
    } finally {
      allowRootInitAdmission.release();
      allowRunningStatusAdmission.release();
      allowWakeInitAdmission.release();
      allowStreamExit.release();
      await flush();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      setClaudeTurnLifecycleClockForTests(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('honors Claude lifecycleExecutionId while retaining A for output and routed binding', async () => {
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'claude-explicit-execution-id',
    };
    const lifecycleEvents: unknown[] = [];
    const terminal = createGate();
    const promptPulled = createGate();
    releaseClaudeTurnLifecycleProducer(scope);
    mockLoadCachedInventory.mockResolvedValue(null);
    setClaudeTurnLifecycleSink((event) => lifecycleEvents.push(event));
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        const sent = await input.next();
        if (sent.done) return;
        promptPulled.release();
        const uuid = readEventString(sent.value, 'uuid');
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'explicit-execution-session',
          ...(uuid ? { user_message_uuid: uuid } : {}),
        };
        yield {
          type: 'result',
          parent_tool_use_id: null,
          is_error: false,
          result: 'resumed output',
          ...(uuid ? { user_message_uuid: uuid } : {}),
        };
      })();
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        ...scope,
      },
      (event: unknown) => {
        if (readEventString(event, 'result') === 'resumed output')
          terminal.release();
      },
      getNoWindow,
    );
    const routedBinding = jest.spyOn(
      SessionEventRouter,
      'observeRoutedTurnBinding',
    );

    try {
      session.sendMessage('resume', {
        userMessageId: 'claude-resume-anchor',
        lifecycleExecutionId: 'claude-resume-execution',
      });
      await promptPulled.promise;
      await terminal.promise;

      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'TurnStarted',
          phase: 'start',
          turnId: 'claude-resume-execution',
        }),
      );
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'TurnStarted',
          phase: 'binding-update',
          turnId: 'claude-resume-execution',
          userMessageIds: ['claude-resume-anchor'],
        }),
      );
      expect(routedBinding).toHaveBeenCalledWith(
        scope,
        session,
        ['claude-resume-anchor'],
        expect.any(String),
        'claude-resume-execution',
      );
    } finally {
      routedBinding.mockRestore();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('keeps provider delivery alive when recording the bounded binding-limit diagnostic throws', async () => {
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'claude-binding-diagnostic-failure',
    };
    const terminal = createGate();
    const deliveredEvents: unknown[] = [];
    const providerUuids: string[] = [];
    releaseClaudeTurnLifecycleProducer(scope);
    mockLoadCachedInventory.mockResolvedValue(null);
    setClaudeTurnLifecycleSink(jest.fn());
    const diagnostics = jest
      .spyOn(getObservabilityService(), 'recordSessionDiagnostic')
      .mockImplementation(() => {
        throw new Error('diagnostics unavailable');
      });
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        for (let index = 0; index < 65; index += 1) {
          const sent = await input.next();
          if (sent.done) return;
          const uuid = readEventString(sent.value, 'uuid');
          if (uuid) providerUuids.push(uuid);
        }
        yield {
          type: 'system',
          subtype: 'init',
          parent_tool_use_id: null,
          session_id: 'binding-diagnostic-failure-session',
        };
        yield {
          type: 'result',
          parent_tool_use_id: null,
          is_error: false,
          result: 'cap result delivered',
          user_message_uuids: providerUuids,
        };
      })();
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        ...scope,
      },
      (event: unknown) => {
        deliveredEvents.push(event);
        if (
          readEventString(event, 'result') === 'cap result delivered' ||
          readEventString(event, 'type') === 'error'
        )
          terminal.release();
      },
      getNoWindow,
    );

    try {
      for (let index = 0; index < 65; index += 1) {
        session.sendMessage('message body stays out of diagnostics', {
          userMessageId: `cap-message-${index}`,
        });
      }
      await terminal.promise;

      expect(deliveredEvents).toContainEqual(
        expect.objectContaining({
          type: 'result',
          result: 'cap result delivered',
        }),
      );
      expect(diagnostics).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'chat_event_dropped',
          eventType: 'claude_binding_limit',
          chatEventDropReason: 'claude_binding_input_limit_exceeded',
        }),
      );
      const diagnostic: unknown = diagnostics.mock.calls.find(
        ([event]) =>
          event.chatEventDropReason === 'claude_binding_input_limit_exceeded',
      )?.[0];
      const serializedDiagnostic = readEventString(diagnostic, 'error');
      expect(serializedDiagnostic).toBeDefined();
      if (typeof serializedDiagnostic !== 'string')
        throw new Error('Missing bounded diagnostic');
      expect(serializedDiagnostic).toContain('"rejectedInputCount":65');
      expect(serializedDiagnostic).toContain(
        JSON.stringify(providerUuids.slice(0, 8)),
      );
      expect(serializedDiagnostic).toContain(
        JSON.stringify(
          Array.from({ length: 8 }, (_unused, index) => `cap-message-${index}`),
        ),
      );
      expect(serializedDiagnostic).toContain('"truncated":true');
      expect(providerUuids).toHaveLength(65);
    } finally {
      diagnostics.mockRestore();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('exposes a native-only Claude Stop fence helper', () => {
    expect(captureClaudeStopFence(undefined)).toBeUndefined();
  });

  it.each(['reject', 'no-ack', 'ack-without-root'])(
    'uses one Stop fallback budget after native interrupt %s',
    async (interruptReply) => {
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });
      const lifecycleScope = {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: `stop-fallback-${interruptReply}`,
      };
      const lifecycleEvents: unknown[] = [];
      releaseClaudeTurnLifecycleProducer(lifecycleScope);
      setClaudeTurnLifecycleSink((event) => {
        lifecycleEvents.push(event);
      });
      const initAdmission = createGate();
      const interruptCalled = createGate();
      const allowStreamExit = createGate();
      const interrupt = jest.fn((): Promise<unknown> => {
        interruptCalled.release();
        if (interruptReply === 'reject')
          return Promise.reject(new Error('interrupt failed'));
        if (interruptReply === 'no-ack') return new Promise(() => undefined);
        return Promise.resolve({
          cancelled: ['provider-message'],
          still_queued: [],
        });
      });
      const query = {
        cancelAsyncMessage: jest.fn(),
        interrupt,
      };
      mockQuery.mockImplementation(({ prompt }) => {
        if (typeof prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const input = prompt[Symbol.asyncIterator]();
        return Object.assign(
          (async function* (): AsyncGenerator<unknown, void> {
            const firstPrompt = await input.next();
            if (firstPrompt.done) return;
            const userMessageUuid = readEventString(firstPrompt.value, 'uuid');
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: `stop-fallback-${interruptReply}`,
              ...(userMessageUuid
                ? { user_message_uuid: userMessageUuid }
                : {}),
              capabilities: [
                'msg_lifecycle_v1',
                'interrupt_receipt_v1',
                'interrupt_cancel_queued_v1',
              ],
            };
            await allowStreamExit.promise;
          })(),
          query,
        );
      });
      const chatId = `stop-fallback-${interruptReply}`;
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId,
        },
        (event: unknown) => {
          if (readEventString(event, 'session_id') === chatId)
            initAdmission.release();
        },
        getNoWindow,
      );

      try {
        session.sendMessage('Start fallback target', {
          userMessageId: `user-${interruptReply}`,
        });
        await initAdmission.promise;
        const fence = captureClaudeStopFence(session);
        expect(fence).toBeDefined();
        if (!fence) throw new Error('Expected a native Claude Stop fence');
        const stopPromise = interruptClaudeSessionForStop(session, fence);
        await interruptCalled.promise;
        const abortController = claudeQueryParams().options?.abortController;
        if (interruptReply === 'reject') {
          await expect(stopPromise).resolves.toMatchObject({
            outcome: 'fallback-aborted',
            fence,
          });
        } else {
          await jest.advanceTimersByTimeAsync(9999);
          expect(abortController?.signal.aborted).toBe(false);
          await jest.advanceTimersByTimeAsync(1);
        }
        await expect(stopPromise).resolves.toMatchObject({
          outcome: 'fallback-aborted',
          fence,
        });
        expect(abortController?.signal.aborted).toBe(true);
        expect(interrupt).toHaveBeenCalledTimes(1);
        const fallbackTerminals = lifecycleEvents.filter(
          (event) =>
            readEventType(event) === 'TurnEnded' &&
            readEventString(event, 'source') === 'abort-fallback',
        );
        expect(fallbackTerminals).toHaveLength(1);
        expect(fallbackTerminals[0]).toMatchObject({
          turnId: fence.turnId,
          userMessageIds: [`user-${interruptReply}`],
          outcome: 'cancelled',
          source: 'abort-fallback',
        });
      } finally {
        allowStreamExit.release();
        await flush();
        await session.destroy();
        setClaudeTurnLifecycleSink(null);
        setClaudeTurnLifecycleClockForTests(null);
        releaseClaudeTurnLifecycleProducer(lifecycleScope);
        jest.useRealTimers();
      }
    },
  );

  // Without msg_lifecycle_v1 the session does not hold frames for send
  // receipts, which these scripts never emit.
  const NATIVE_STOP_CAPABILITIES = [
    'interrupt_receipt_v1',
    'interrupt_cancel_queued_v1',
  ];

  it('resolves an idle native Stop without interrupting or aborting the live query', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const chatId = 'idle-native-stop';
    const resultAdmitted = createGate();
    const allowStreamExit = createGate();
    const interrupt = jest.fn(
      (): Promise<unknown> =>
        Promise.resolve({ cancelled: [], still_queued: [] }),
    );
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return Object.assign(
        (async function* (): AsyncGenerator<unknown, void> {
          const firstPrompt = await input.next();
          if (firstPrompt.done) return;
          const uuid = readEventString(firstPrompt.value, 'uuid');
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: chatId,
            capabilities: NATIVE_STOP_CAPABILITIES,
          };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'Idle Stop turn done',
            parent_tool_use_id: null,
            session_id: chatId,
            ...(uuid ? { user_message_uuid: uuid } : {}),
          };
          await allowStreamExit.promise;
        })(),
        { cancelAsyncMessage: jest.fn(), interrupt },
      );
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId,
      },
      (event: unknown) => {
        if (readEventString(event, 'result') === 'Idle Stop turn done')
          resultAdmitted.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Finish before Stop', {
        userMessageId: 'idle-stop-user',
      });
      await resultAdmitted.promise;
      await flush();
      const fence = captureClaudeStopFence(session);
      if (!fence) throw new Error('Expected a native Claude Stop fence');
      expect(fence).toMatchObject({
        turnId: undefined,
        userMessageId: undefined,
      });

      let settled: unknown;
      void interruptClaudeSessionForStop(session, fence).then((outcome) => {
        settled = outcome;
      });
      await flush();

      expect(settled).toEqual({ outcome: 'interrupted', fence });
      expect(interrupt).not.toHaveBeenCalled();
      expect(claudeQueryParams().options?.abortController?.signal.aborted).toBe(
        false,
      );
    } finally {
      allowStreamExit.release();
      await flush();
      await session.destroy();
    }
  });

  async function startBindingStopSession(chatId: string): Promise<{
    session: ReturnType<ClaudeCodeProvider['createSession']>;
    interrupt: jest.Mock<Promise<unknown>, []>;
    bind: () => Promise<void>;
    finish: () => Promise<void>;
  }> {
    mockLoadCachedInventory.mockResolvedValue(null);
    const initAdmitted = createGate();
    const bindingAdmitted = createGate();
    const allowBinding = createGate();
    const interruptCalled = createGate();
    const allowStreamExit = createGate();
    const interrupt = jest.fn((): Promise<unknown> => {
      interruptCalled.release();
      return Promise.resolve({ cancelled: [], still_queued: [] });
    });
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return Object.assign(
        (async function* (): AsyncGenerator<unknown, void> {
          const firstPrompt = await input.next();
          if (firstPrompt.done) return;
          const uuid = readEventString(firstPrompt.value, 'uuid');
          // No uuid on init: the root turn opens unbound until evidence.
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: chatId,
            capabilities: NATIVE_STOP_CAPABILITIES,
          };
          await allowBinding.promise;
          yield {
            type: 'assistant',
            parent_tool_use_id: null,
            session_id: chatId,
            ...(uuid ? { user_message_uuid: uuid } : {}),
            message: {
              id: `${chatId}-assistant`,
              role: 'assistant',
              content: [{ type: 'text', text: 'Bound to the send' }],
            },
          };
          await interruptCalled.promise;
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            terminal_reason: 'aborted_streaming',
            parent_tool_use_id: null,
            session_id: chatId,
            ...(uuid ? { user_message_uuid: uuid } : {}),
          };
          await allowStreamExit.promise;
        })(),
        { cancelAsyncMessage: jest.fn(), interrupt },
      );
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId,
      },
      (event: unknown) => {
        if (readEventString(event, 'subtype') === 'init')
          initAdmitted.release();
        if (readEventType(event) === 'assistant') bindingAdmitted.release();
      },
      getNoWindow,
    );
    session.sendMessage('Stop this turn', { userMessageId: `${chatId}-user` });
    await initAdmitted.promise;
    return {
      session,
      interrupt,
      bind: async (): Promise<void> => {
        allowBinding.release();
        await bindingAdmitted.promise;
        await flush();
      },
      finish: async (): Promise<void> => {
        allowBinding.release();
        interruptCalled.release();
        allowStreamExit.release();
        await flush();
        await session.destroy();
      },
    };
  }

  it('interrupts a turn whose Stop fence was captured before uuid evidence bound it', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const run = await startBindingStopSession('stop-across-binding');
    try {
      const fence = captureClaudeStopFence(run.session);
      if (!fence) throw new Error('Expected a native Claude Stop fence');
      expect(fence.userMessageId).toBe(fence.turnId);
      await run.bind();

      await expect(
        interruptClaudeSessionForStop(run.session, fence),
      ).resolves.toEqual({ outcome: 'interrupted', fence });
      expect(run.interrupt).toHaveBeenCalledTimes(1);
      expect(claudeQueryParams().options?.abortController?.signal.aborted).toBe(
        false,
      );
    } finally {
      await run.finish();
      jest.useRealTimers();
    }
  });

  it('maps Claude Stop over an error result to canonical cancelled with the provider terminal reason', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'interrupted-turn-ended',
    };
    const lifecycleEvents: unknown[] = [];
    releaseClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleSink((event) => {
      lifecycleEvents.push(event);
    });
    const run = await startBindingStopSession(scope.chatId);
    try {
      await run.bind();
      const fence = captureClaudeStopFence(run.session);
      if (!fence) throw new Error('Expected a native Claude Stop fence');

      await expect(
        interruptClaudeSessionForStop(run.session, fence),
      ).resolves.toEqual({ outcome: 'interrupted', fence });
      expect(
        lifecycleEvents.filter((event) => readEventType(event) === 'TurnEnded'),
      ).toEqual([
        expect.objectContaining({
          turnId: fence.turnId,
          outcome: 'cancelled',
          terminalReason: 'aborted_streaming',
          source: 'result',
        }),
      ]);
    } finally {
      await run.finish();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
      jest.useRealTimers();
    }
  });

  it('does not fallback-abort a newer turn when an older captured Stop fence expires', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const initAdmission = createGate();
    const interruptCalled = createGate();
    const allowStreamExit = createGate();
    const interrupt = jest.fn(() => {
      interruptCalled.release();
      return new Promise<unknown>(() => undefined);
    });
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return Object.assign(
        (async function* (): AsyncGenerator<unknown, void> {
          await input.next();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'stop-newer-fence',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          await allowStreamExit.promise;
        })(),
        { cancelAsyncMessage: jest.fn(), interrupt },
      );
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'stop-newer-fence',
      },
      (event: unknown) => {
        if (readEventString(event, 'session_id') === 'stop-newer-fence')
          initAdmission.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Older target', { userMessageId: 'older-user' });
      await initAdmission.promise;
      const oldFence = captureClaudeStopFence(session);
      expect(oldFence).toBeDefined();
      if (!oldFence) throw new Error('Expected a native Claude Stop fence');
      const stopPromise = interruptClaudeSessionForStop(session, oldFence);
      await interruptCalled.promise;
      session.sendMessage('Replacement target', {
        userMessageId: 'replacement-user',
      });
      const newFence = captureClaudeStopFence(session);
      expect(newFence).toBeDefined();
      if (!newFence) throw new Error('Expected a replacement Claude fence');
      expect(isClaudeStopFenceCurrent(session, oldFence)).toBe(false);
      expect(isClaudeStopFenceCurrent(session, newFence)).toBe(true);

      await jest.advanceTimersByTimeAsync(10_000);
      const outcome: unknown = await stopPromise;
      expect(outcome).not.toMatchObject({ outcome: 'fallback-aborted' });
      expect(claudeQueryParams().options?.abortController?.signal.aborted).toBe(
        false,
      );
    } finally {
      allowStreamExit.release();
      await flush();
      await session.destroy();
      jest.useRealTimers();
    }
  });

  it('fallback-aborts immediately when the native query is not ready yet', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const prepareStarted = createGate();
    const allowPrepare = createGate();
    const prepareInvocation = jest.fn(async () => {
      prepareStarted.release();
      await allowPrepare.promise;
      return { providerType: 'claude' as const };
    });
    const session = new ClaudeCodeProvider({
      prepareInvocation,
    }).createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'stop-not-ready',
      },
      jest.fn(),
      getNoWindow,
    );

    try {
      session.sendMessage('Waiting for the native query', {
        userMessageId: 'not-ready-user',
      });
      await prepareStarted.promise;
      const fence = captureClaudeStopFence(session);
      expect(fence).toBeDefined();
      if (!fence) throw new Error('Expected a native Claude Stop fence');
      expect(session.isDisposed?.()).toBe(false);
      const stopPromise = interruptClaudeSessionForStop(session, fence);
      await expect(stopPromise).resolves.toMatchObject({
        outcome: 'fallback-aborted',
        fence,
      });
      expect(session.isDisposed?.()).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      allowPrepare.release();
      await flush();
      await session.destroy();
      jest.useRealTimers();
    }
  });

  it('reports fallback-aborted when Stop is requested for a captured turn whose query already exited', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const scope = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'stop-dead-query',
    };
    const lifecycleEvents: unknown[] = [];
    releaseClaudeTurnLifecycleProducer(scope);
    setClaudeTurnLifecycleSink((event) => {
      lifecycleEvents.push(event);
    });
    const firstInitAdmitted = createGate();
    const firstResultAdmitted = createGate();
    const wakeInitAdmitted = createGate();
    const streamEnded = createGate();
    const interrupt = jest.fn(() =>
      Promise.resolve({ cancelled: [], still_queued: [] }),
    );
    const query = { cancelAsyncMessage: jest.fn(), interrupt };
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return Object.assign(
        (async function* (): AsyncGenerator<unknown, void> {
          try {
            const firstPrompt = await input.next();
            if (firstPrompt.done) return;
            const uuid = readEventString(firstPrompt.value, 'uuid');
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: 'dead-query-first-root',
            };
            yield {
              type: 'result',
              is_error: false,
              result: 'First root done',
              ...(uuid ? { user_message_uuid: uuid } : {}),
            };
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: 'dead-query-wake',
            };
          } finally {
            streamEnded.release();
          }
        })(),
        query,
      );
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
      (event: unknown) => {
        if (readEventString(event, 'session_id') === 'dead-query-first-root')
          firstInitAdmitted.release();
        if (readEventString(event, 'result') === 'First root done')
          firstResultAdmitted.release();
        if (readEventString(event, 'session_id') === 'dead-query-wake')
          wakeInitAdmitted.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Start the retained query', {
        userMessageId: 'first-user-message',
      });
      await firstInitAdmitted.promise;
      await firstResultAdmitted.promise;
      await wakeInitAdmitted.promise;
      const fence = captureClaudeStopFence(session);
      expect(fence).toBeDefined();
      if (!fence) throw new Error('Expected a native Claude Stop fence');
      await streamEnded.promise;
      for (let attempt = 0; attempt < 10 && !session.isDisposed?.(); attempt++)
        await flush();
      expect(session.isDisposed?.()).toBe(true);

      await expect(
        interruptClaudeSessionForStop(session, fence),
      ).resolves.toMatchObject({
        outcome: 'fallback-aborted',
        fence,
      });
      expect(interrupt).not.toHaveBeenCalled();
      expect(
        lifecycleEvents.filter(
          (event) =>
            readEventType(event) === 'TurnEnded' &&
            readEventString(event, 'source') === 'abort-fallback',
        ),
      ).toHaveLength(1);
    } finally {
      await flush();
      await session.destroy();
      setClaudeTurnLifecycleSink(null);
      releaseClaudeTurnLifecycleProducer(scope);
    }
  });

  it('withdraws pre-Stop ordinary staging without dropping a newer send', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const firstPromptPulled = createGate();
    const firstInitAdmitted = createGate();
    const interruptCalled = createGate();
    const allowRootResult = createGate();
    const firstResultAdmitted = createGate();
    const newerPromptPulled = createGate();
    const allowStreamExit = createGate();
    let yieldedNewerPrompt: unknown;
    const query = {
      cancelAsyncMessage: jest.fn(),
      interrupt: jest.fn(() => {
        interruptCalled.release();
        return Promise.resolve({ cancelled: [], still_queued: [] });
      }),
    };
    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return Object.assign(
        (async function* (): AsyncGenerator<unknown, void> {
          const firstPrompt = await input.next();
          if (firstPrompt.done) return;
          const uuid = readEventString(firstPrompt.value, 'uuid');
          firstPromptPulled.release();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'ordinary-staging-root',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          await allowRootResult.promise;
          yield {
            type: 'result',
            is_error: false,
            result: 'Ordinary staging root done',
            ...(uuid ? { user_message_uuid: uuid } : {}),
          };
          const nextPrompt = await input.next();
          if (nextPrompt.done) return;
          yieldedNewerPrompt = nextPrompt.value;
          newerPromptPulled.release();
          await allowStreamExit.promise;
        })(),
        query,
      );
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'stop-ordinary-staging',
      },
      (event: unknown) => {
        if (readEventString(event, 'session_id') === 'ordinary-staging-root')
          firstInitAdmitted.release();
        if (readEventString(event, 'result') === 'Ordinary staging root done')
          firstResultAdmitted.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Active root turn', {
        userMessageId: 'active-root-user',
      });
      await firstPromptPulled.promise;
      await firstInitAdmitted.promise;
      session.sendMessage('Must not yield after Stop', {
        userMessageId: 'pre-stop-user',
      });
      const fence = captureClaudeStopFence(session);
      expect(fence).toBeDefined();
      if (!fence) throw new Error('Expected a native Claude Stop fence');

      const stopPromise = interruptClaudeSessionForStop(session, fence);
      await interruptCalled.promise;
      expect(query.interrupt).toHaveBeenCalledTimes(1);
      session.sendMessage('Must remain for the newer turn', {
        userMessageId: 'post-stop-user',
      });
      allowRootResult.release();
      await firstResultAdmitted.promise;
      await expect(stopPromise).resolves.toMatchObject({
        outcome: 'interrupted',
        fence,
      });
      await newerPromptPulled.promise;
      expect(JSON.stringify(yieldedNewerPrompt)).toContain(
        'Must remain for the newer turn',
      );
      expect(JSON.stringify(yieldedNewerPrompt)).not.toContain(
        'Must not yield after Stop',
      );
    } finally {
      allowRootResult.release();
      allowStreamExit.release();
      await flush();
      await session.destroy();
    }
  });

  it('interrupts the active turn first, retires only turn delegation state, and preserves the live Claude session', async () => {
    const firstPromptPulled = createGate();
    const firstInitAdmission = createGate();
    const interruptCalled = createGate();
    const allowFirstResult = createGate();
    const childTerminalAdmitted = createGate();
    const allowRootTerminal = createGate();
    const firstResultAdmitted = createGate();
    const secondPromptPulled = createGate();
    const secondInitAdmission = createGate();
    const allowStreamExit = createGate();
    const query = {
      cancelAsyncMessage: jest.fn(),
      interrupt: jest.fn(() => {
        interruptCalled.release();
        return Promise.resolve({ cancelled: [], still_queued: [] });
      }),
      stopTask: jest.fn().mockResolvedValue(undefined),
    };
    const hostedProcess = new ExitOnInputEndHostedCli();
    mockSpawnClaudeCodeProcessOffMain.mockReturnValue(hostedProcess);
    mockManagedDelegationEnabled.mockReturnValue(true);
    const delegationOptionsHolder: {
      value: ManagedDelegationSessionOptions | undefined;
    } = { value: undefined };
    const bindClaudeImplementation: ManagedDelegationParentStub['bindClaude'] =
      (_name, _input, callId) => ({
        ok: true,
        value: { _hostCorrelation: callId },
      });
    const bindClaude = jest.fn(bindClaudeImplementation);
    const managed = createManagedDelegationStub({
      detach: jest.fn(),
      ownsTool: () => true,
      parent: { bindClaude },
      retireTurn: jest.fn(),
    });
    mockCreateManagedDelegationSession.mockImplementation((options) => {
      delegationOptionsHolder.value = options;
      return Promise.resolve(managed);
    });

    mockQuery.mockImplementation(({ prompt }) => {
      if (typeof prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const input = prompt[Symbol.asyncIterator]();
      return Object.assign(
        (async function* (): AsyncGenerator<unknown, void> {
          const firstPrompt = await input.next();
          if (firstPrompt.done) return;
          const firstUserMessageUuid = readEventString(
            firstPrompt.value,
            'uuid',
          );
          firstPromptPulled.release();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'stop-preserves-session',
            ...(firstUserMessageUuid
              ? { user_message_uuid: firstUserMessageUuid }
              : {}),
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          await allowFirstResult.promise;
          yield {
            type: 'result',
            parent_tool_use_id: 'child-tool-use',
            is_error: false,
            result: 'Child finished independently',
          };
          await allowRootTerminal.promise;
          yield {
            type: 'result',
            is_error: false,
            result: 'Stopped current turn',
            ...(firstUserMessageUuid
              ? { user_message_uuid: firstUserMessageUuid }
              : {}),
          };
          const secondPrompt = await input.next();
          if (secondPrompt.done) return;
          const secondUserMessageUuid = readEventString(
            secondPrompt.value,
            'uuid',
          );
          secondPromptPulled.release();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'stop-preserves-session-next',
            ...(secondUserMessageUuid
              ? { user_message_uuid: secondUserMessageUuid }
              : {}),
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          await allowStreamExit.promise;
        })(),
        query,
      );
    });
    const disposeSkillUsage = jest.spyOn(
      SkillUsageTracker.prototype,
      'dispose',
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'stop-preserves-session',
      },
      (event: unknown) => {
        if (
          readEventType(event) === 'system' &&
          readEventString(event, 'session_id') === 'stop-preserves-session'
        )
          firstInitAdmission.release();
        if (readEventString(event, 'result') === 'Child finished independently')
          childTerminalAdmitted.release();
        if (readEventString(event, 'result') === 'Stopped current turn')
          firstResultAdmitted.release();
        if (
          readEventType(event) === 'system' &&
          readEventString(event, 'session_id') === 'stop-preserves-session-next'
        )
          secondInitAdmission.release();
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Initial turn', { userMessageId: 'first-user' });
      await firstPromptPulled.promise;
      await firstInitAdmission.promise;
      const fence = captureClaudeStopFence(session);
      expect(fence).toBeDefined();
      if (!fence) throw new Error('Expected a native Claude Stop fence');
      const stopPromise = interruptClaudeSessionForStop(session, fence);
      let stopSettled = false;
      void stopPromise.then(() => {
        stopSettled = true;
      });
      await interruptCalled.promise;
      expect(query.interrupt).toHaveBeenCalledTimes(1);
      allowFirstResult.release();
      await childTerminalAdmitted.promise;
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      allowRootTerminal.release();
      await firstResultAdmitted.promise;
      await expect(stopPromise).resolves.toMatchObject({
        outcome: 'interrupted',
        fence,
      });

      expect(session.isDisposed?.()).toBe(false);
      expect(query.cancelAsyncMessage).not.toHaveBeenCalled();
      expect(mockKillChildProcessGroup).not.toHaveBeenCalled();
      expect(hostedProcess.kill).not.toHaveBeenCalled();
      expect(managed.retireTurn).toHaveBeenCalledTimes(1);
      expect(managed.detach).not.toHaveBeenCalled();
      expect(disposeSkillUsage).not.toHaveBeenCalled();

      const spawnClaudeCodeProcess =
        claudeQueryParams().options?.spawnClaudeCodeProcess;
      if (!spawnClaudeCodeProcess)
        throw new Error('Expected spawnClaudeCodeProcess option');
      expect(
        spawnClaudeCodeProcess({
          command: '/mock/claude',
          args: [],
          env: {},
          signal: new AbortController().signal,
        }),
      ).toBe(hostedProcess);
      await expect(
        stopTaskForClaudeSession(
          'project',
          'worktree',
          'stop-preserves-session',
          'task-after-stop',
        ),
      ).resolves.toBe('stopped');
      expect(query.stopTask).toHaveBeenCalledWith('task-after-stop');

      session.sendMessage('Follow-up turn', { userMessageId: 'second-user' });
      await secondPromptPulled.promise;
      await secondInitAdmission.promise;
      const secondTurnId = delegationOptionsHolder.value?.currentTurn();
      expect(secondTurnId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
      expect(secondTurnId).not.toBe(fence.turnId);
      expect(delegationOptionsHolder.value?.currentMessage?.()).toBe(
        'second-user',
      );
      await invokeClaudePreToolUse(
        claudeQueryParams(),
        'mcp__canopy__DelegateTask',
        { prompt: 'Delegate after Stop' },
        'delegate-after-stop',
      );
      expect(bindClaude).toHaveBeenCalledWith(
        'mcp__canopy__DelegateTask',
        expect.objectContaining({ prompt: 'Delegate after Stop' }),
        'delegate-after-stop',
        undefined,
      );
      expect(delegationOptionsHolder.value?.currentTurn()).toBe(secondTurnId);
    } finally {
      allowFirstResult.release();
      allowRootTerminal.release();
      allowStreamExit.release();
      await flush();
      await session.destroy();
      disposeSkillUsage.mockRestore();
    }
    expect(hostedProcess.stdin.writableEnded).toBe(true);
    await hostedProcess.exited;
    expect(hostedProcess.kill).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'normalizes a known invocation immediately before the Claude SDK handoff (eligible: %s)',
    async (eligible) => {
      const recordUse = jest
        .spyOn(skillShareNudgeState, 'recordUse')
        .mockResolvedValue(undefined);
      mockLoadCachedInventory.mockResolvedValue({
        version: 2,
        builtAt: '2026-08-31T00:00:00.000Z',
        entries: [
          {
            id: 'claude-skill-review',
            provider: 'claude',
            kind: 'skill',
            name: 'review',
            displayName: '/review',
            description: 'Review the change',
            insertText: '/review ',
            invocationKey: '/review',
            enableRef: {
              kind: 'skill',
              sourceId: 'test-source',
              skillName: 'review',
            },
          },
        ],
      });
      let resolvePromptMessage: (value: unknown) => void = () => undefined;
      const promptMessage = new Promise<unknown>((resolvePrompt) => {
        resolvePromptMessage = resolvePrompt;
      });
      mockQuery.mockImplementation((params) => {
        async function* consumePrompt(): AsyncGenerator<unknown, void> {
          if (typeof params.prompt === 'string') {
            throw new Error('Expected streaming Claude prompt input');
          }
          const next = await params.prompt[Symbol.asyncIterator]().next();
          resolvePromptMessage(next.value);
          const userMessageUuid = readEventString(next.value, 'uuid');
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
          };
          yield { type: 'result', is_error: false, result: 'done' };
        }
        return consumePrompt();
      });

      const provider = new ClaudeCodeProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'invocation-normalization',
        },
        jest.fn(),
        getNoWindow,
      );

      session.sendMessage('$review this change', {
        userMessageId: 'eligible-user',
        countsTowardSkillUsage: eligible,
      });

      await expect(promptMessage).resolves.toMatchObject({
        message: { role: 'user', content: '/review this change' },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recordUse).toHaveBeenCalledTimes(eligible ? 1 : 0);
      if (eligible) {
        expect(recordUse).toHaveBeenCalledWith(
          expect.objectContaining({ chatId: 'invocation-normalization' }),
          { kind: 'skill', sourceId: 'test-source', name: 'review' },
          expect.any(Function),
        );
      }
      await session.destroy();
      recordUse.mockRestore();
    },
  );

  it('counts top-level model Skill calls once per plugin and resets for uncounted turns', async () => {
    const recordUse = jest
      .spyOn(skillShareNudgeState, 'recordUse')
      .mockResolvedValue(undefined);
    mockLoadCachedInventory.mockResolvedValue({
      entries: ['one', 'two'].map((name) => ({
        id: name,
        provider: 'claude',
        kind: 'plugin_skill',
        name,
        displayName: name,
        description: '',
        invocationKey: `/plugin:${name}`,
        insertText: `/plugin:${name}`,
        enableRef: {
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'plugin',
        },
      })),
    });
    let finish: () => void = (): void => undefined;
    const observed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockQuery.mockImplementation((params) => {
      async function* consume(): AsyncGenerator<unknown, void> {
        if (typeof params.prompt === 'string')
          throw new Error('Expected streaming prompt');
        const iterator = params.prompt[Symbol.asyncIterator]();
        for (let turn = 0; turn < 2; turn++) {
          const promptMessage = await iterator.next();
          if (promptMessage.done) return;
          const userMessageUuid = readEventString(promptMessage.value, 'uuid');
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
          };
          const calls = [
            { id: `subagent-${turn}`, skill: 'plugin:one', agentId: 'child' },
            { id: `first-${turn}`, skill: 'plugin:one' },
            { id: `first-${turn}`, skill: 'plugin:one' },
            { id: `second-${turn}`, skill: 'plugin:two' },
          ];
          for (const call of calls) {
            for (const spec of params.options?.hooks?.PreToolUse ?? []) {
              if (spec.matcher !== '*') continue;
              for (const hook of spec.hooks) {
                await hook(
                  {
                    hook_event_name: 'PreToolUse',
                    session_id: 'native',
                    transcript_path: '/tmp/transcript.jsonl',
                    cwd: '/tmp/repo',
                    tool_name: 'Skill',
                    tool_input: { skill: call.skill },
                    tool_use_id: call.id,
                    ...(call.agentId ? { agent_id: call.agentId } : {}),
                  },
                  call.id,
                  { signal: new AbortController().signal },
                );
              }
            }
          }
          yield { type: 'result', is_error: false, result: 'done' };
        }
        finish();
      }
      return consume();
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'model-usage',
      },
      jest.fn(),
      getNoWindow,
    );
    try {
      session.sendMessage('Use the available skills', {
        countsTowardSkillUsage: true,
        userMessageId: 'user',
      });
      session.sendMessage('Hidden continuation', {
        userMessageId: 'automation',
      });
      await observed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recordUse).toHaveBeenCalledTimes(1);
      expect(recordUse).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'model-usage' }),
        { kind: 'plugin', marketplaceId: 'market', pluginName: 'plugin' },
        expect.any(Function),
      );
    } finally {
      await session.destroy();
      recordUse.mockRestore();
    }
  });

  it.each([500, 1, 9999, null])(
    'passes the saved Claude turn limit %s to the SDK',
    async (limit) => {
      const preferences = PreferencesStoreModule.normalizePreferences({
        claudeMaxTurns: limit,
      });
      const preferenceRead = jest.mocked(
        PreferencesStoreModule.readLatestPreferencesFile,
      );
      preferenceRead.mockResolvedValue({
        ...preferences,
        claudeMaxTurns: limit,
      });
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'turn-limit',
        },
        jest.fn(),
        getNoWindow,
      );
      try {
        await flush();
        const options = mockQuery.mock.calls[0]?.[0]?.options;
        expect(options).toBeDefined();
        if (limit === null) expect(options).not.toHaveProperty('maxTurns');
        else expect(options?.maxTurns).toBe(limit);
      } finally {
        await session.destroy();
        preferenceRead.mockResolvedValue(
          PreferencesStoreModule.DEFAULT_PREFERENCES,
        );
      }
    },
  );

  it.each([250, null])(
    'uses the plugin overlay turn limit %s without a fallback read',
    async (limit) => {
      const overlay = jest.mocked(
        GlobalPluginOverlayModule.resolveEffectiveChatPluginContext,
      );
      const preferenceRead = jest.mocked(
        PreferencesStoreModule.readLatestPreferencesFile,
      );
      overlay.mockResolvedValueOnce({
        selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        preferences: PreferencesStoreModule.normalizePreferences({
          claudeMaxTurns: limit,
        }),
      });
      preferenceRead.mockClear();
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'overlay-turn-limit',
          applyGlobalPluginDefaults: true,
        },
        jest.fn(),
        getNoWindow,
      );
      try {
        await flush();
        expect(overlay).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ applyGlobalPluginDefaults: true }),
          true,
        );
        const options = mockQuery.mock.calls[0]?.[0]?.options;
        expect(options).toBeDefined();
        if (limit === null) expect(options).not.toHaveProperty('maxTurns');
        else expect(options?.maxTurns).toBe(limit);
        expect(preferenceRead).not.toHaveBeenCalled();
      } finally {
        await session.destroy();
      }
    },
  );

  it('resets the live background task set when the CLI process starts', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'bg-reset',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    expect(jest.mocked(resetSessionLiveBackgroundTasks)).toHaveBeenCalledWith(
      'project/worktree/bg-reset',
    );
    await session.destroy();
  });

  it.each([
    'Unknown task task-1',
    'No such task: task-1',
    'Task task-1 is not running',
    'not running',
    'No active session for task task-1',
    'Error invoking remote method: status: killed',
    'status: stopped',
    'status: cancelled',
    'status: canceled',
    'status: failed',
    'status: completed',
  ])(
    'reports an already-finished task when Claude says %s',
    async (message) => {
      let releaseQuery = (): void => undefined;
      const queryGate = new Promise<void>((resolve) => {
        releaseQuery = resolve;
      });
      const stopTask = jest.fn().mockRejectedValue(new Error(message));
      mockQuery.mockReturnValue(
        Object.assign(
          (async function* (): AsyncGenerator<unknown, void> {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 'dead-task-session',
            };
            await queryGate;
            yield { type: 'result', is_error: false, result: 'done' };
          })(),
          { stopTask },
        ),
      );

      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'dead-task',
        },
        jest.fn(),
        getNoWindow,
      );
      try {
        session.sendMessage('run');
        await flush();
        await flush();

        await expect(
          stopTaskForClaudeSession(
            'project',
            'worktree',
            'dead-task',
            'task-1',
          ),
        ).resolves.toBe('already-finished');
      } finally {
        releaseQuery();
        await flush();
        await session.destroy();
      }
    },
  );

  it('passes the exact task id to the Claude query', async () => {
    let releaseQuery = (): void => undefined;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const stopTask = jest.fn().mockResolvedValue(undefined);
    mockQuery.mockReturnValue(
      Object.assign(
        (async function* (): AsyncGenerator<unknown, void> {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'exact-task-session',
          };
          await queryGate;
          yield { type: 'result', is_error: false, result: 'done' };
        })(),
        { stopTask },
      ),
    );

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'exact-task',
      },
      jest.fn(),
      getNoWindow,
    );
    try {
      session.sendMessage('run');
      await flush();
      await flush();

      await expect(
        stopTaskForClaudeSession(
          'project',
          'worktree',
          'exact-task',
          'provider-task-id:exact',
        ),
      ).resolves.toBe('stopped');
      expect(stopTask).toHaveBeenCalledWith('provider-task-id:exact');
    } finally {
      releaseQuery();
      await flush();
      await session.destroy();
    }
  });

  it('still throws for a genuine Claude stop failure', async () => {
    let releaseQuery = (): void => undefined;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const failure = new Error('Permission denied while stopping task');
    const stopTask = jest.fn().mockRejectedValue(failure);
    mockQuery.mockReturnValue(
      Object.assign(
        (async function* (): AsyncGenerator<unknown, void> {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'failed-task-session',
          };
          await queryGate;
          yield { type: 'result', is_error: false, result: 'done' };
        })(),
        { stopTask },
      ),
    );

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'failed-task',
      },
      jest.fn(),
      getNoWindow,
    );
    try {
      session.sendMessage('run');
      await flush();
      await flush();

      await expect(
        stopTaskForClaudeSession(
          'project',
          'worktree',
          'failed-task',
          'task-1',
        ),
      ).rejects.toBe(failure);
    } finally {
      releaseQuery();
      await flush();
      await session.destroy();
    }
  });

  describe('stopNativeSubagentForClaudeSession', () => {
    it('targets one Task tool id and provider task id without interrupting root or sibling state', async () => {
      const pendingApprovals = new Set(['root-approval', 'sibling-approval']);
      const pendingQuestions = new Set(['root-question', 'sibling-question']);
      const makeQuery = (
        chatId: string,
      ): {
        query: AsyncGenerator<unknown, void> & {
          backgroundTasks: jest.Mock;
          stopTask: jest.Mock;
          interrupt: jest.Mock;
        };
        backgroundTasks: jest.Mock;
        stopTask: jest.Mock;
        interrupt: jest.Mock;
        release: () => void;
      } => {
        let release = (): void => undefined;
        const queryGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const backgroundTasks = jest.fn().mockResolvedValue(true);
        const stopTask = jest.fn().mockResolvedValue(undefined);
        // Model the root-turn interrupt as the destructive operation: it would
        // invalidate this chat's outstanding approvals/questions. The child
        // stop helper must only use the task-scoped Query methods.
        const interrupt = jest.fn().mockImplementation((): Promise<void> => {
          pendingApprovals.delete(`${chatId}-approval`);
          pendingQuestions.delete(`${chatId}-question`);
          return Promise.resolve();
        });
        const query = Object.assign(
          (async function* (): AsyncGenerator<unknown, void> {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: `${chatId}-root-session`,
            };
            await queryGate;
            yield { type: 'result', is_error: false, result: 'done' };
          })(),
          { backgroundTasks, stopTask, interrupt },
        );
        return {
          query,
          backgroundTasks,
          stopTask,
          interrupt,
          release,
        };
      };

      const rootQuery = makeQuery('root');
      const siblingQuery = makeQuery('sibling');
      mockQuery
        .mockReturnValueOnce(rootQuery.query)
        .mockReturnValueOnce(siblingQuery.query);

      const provider = new ClaudeCodeProvider();
      const rootSession = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'root',
        },
        jest.fn(),
        getNoWindow,
      );
      const siblingSession = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'sibling',
        },
        jest.fn(),
        getNoWindow,
      );
      const rootCancel = jest.spyOn(rootSession, 'cancel');
      const siblingCancel = jest.spyOn(siblingSession, 'cancel');

      try {
        rootSession.sendMessage('run root');
        await flush();
        siblingSession.sendMessage('run sibling');
        await flush();
        await flush();

        expect(
          await stopNativeSubagentForClaudeSession(
            'project',
            'worktree',
            'root',
            'toolu_root_child',
            'task-root-child',
            false,
          ),
        ).toBe('stopped');

        expect(rootQuery.backgroundTasks.mock.calls).toEqual([
          ['toolu_root_child'],
        ]);
        expect(rootQuery.stopTask).toHaveBeenCalledTimes(1);
        expect(rootQuery.stopTask).toHaveBeenCalledWith('task-root-child');
        expect(rootQuery.interrupt).not.toHaveBeenCalled();
        expect(siblingQuery.backgroundTasks).not.toHaveBeenCalled();
        expect(siblingQuery.stopTask).not.toHaveBeenCalled();
        expect(siblingQuery.interrupt).not.toHaveBeenCalled();
        expect(rootCancel).not.toHaveBeenCalled();
        expect(siblingCancel).not.toHaveBeenCalled();
        expect(mockApprovalInvalidatePending).not.toHaveBeenCalled();
        expect(pendingApprovals).toEqual(
          new Set(['root-approval', 'sibling-approval']),
        );
        expect(pendingQuestions).toEqual(
          new Set(['root-question', 'sibling-question']),
        );
      } finally {
        rootQuery.release();
        siblingQuery.release();
        await flush();
        await flush();
        await rootSession.destroy();
        await siblingSession.destroy();
      }
    });

    it('returns unsupported without stopping when the exact foreground Task is not backgrounded', async () => {
      let releaseQuery = (): void => undefined;
      const queryGate = new Promise<void>((resolve) => {
        releaseQuery = resolve;
      });
      const backgroundTasks = jest.fn().mockResolvedValue(false);
      const stopTask = jest.fn().mockResolvedValue(undefined);
      const interrupt = jest.fn();
      mockQuery.mockReturnValue(
        Object.assign(
          (async function* (): AsyncGenerator<unknown, void> {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 'native-foreground-root',
            };
            await queryGate;
          })(),
          { backgroundTasks, stopTask, interrupt },
        ),
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'native-foreground',
        },
        jest.fn(),
        getNoWindow,
      );

      try {
        session.sendMessage('run');
        await flush();

        await expect(
          stopNativeSubagentForClaudeSession(
            'project',
            'worktree',
            'native-foreground',
            'toolu_foreground_child',
            'task-foreground-child',
            false,
          ),
        ).resolves.toBe('unsupported');
        expect(backgroundTasks.mock.calls).toEqual([
          ['toolu_foreground_child'],
        ]);
        expect(stopTask).not.toHaveBeenCalled();
        expect(interrupt).not.toHaveBeenCalled();
      } finally {
        releaseQuery();
        await flush();
        await session.destroy();
      }
    });

    it('stops an already-backgrounded Task even when singleton lookup returns false', async () => {
      let releaseQuery = (): void => undefined;
      const queryGate = new Promise<void>((resolve) => {
        releaseQuery = resolve;
      });
      const backgroundTasks = jest.fn().mockResolvedValue(false);
      const stopTask = jest.fn().mockResolvedValue(undefined);
      mockQuery.mockReturnValue(
        Object.assign(
          (async function* (): AsyncGenerator<unknown, void> {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 'native-backgrounded-root',
            };
            await queryGate;
          })(),
          { backgroundTasks, stopTask },
        ),
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'native-backgrounded',
        },
        jest.fn(),
        getNoWindow,
      );

      try {
        session.sendMessage('run');
        await flush();

        await expect(
          stopNativeSubagentForClaudeSession(
            'project',
            'worktree',
            'native-backgrounded',
            'toolu_backgrounded_child',
            'task-backgrounded-child',
            true,
          ),
        ).resolves.toBe('stopped');
        expect(backgroundTasks.mock.calls).toEqual([
          ['toolu_backgrounded_child'],
        ]);
        expect(stopTask).toHaveBeenCalledWith('task-backgrounded-child');
      } finally {
        releaseQuery();
        await flush();
        await session.destroy();
      }
    });

    it('fails closed when targeting or stopping the provider task throws', async () => {
      let releaseQuery = (): void => undefined;
      const queryGate = new Promise<void>((resolve) => {
        releaseQuery = resolve;
      });
      const backgroundTasks = jest
        .fn()
        .mockRejectedValueOnce(new Error('query unavailable'))
        .mockResolvedValueOnce(true);
      const stopTask = jest
        .fn()
        .mockRejectedValueOnce(new Error('provider unavailable'));
      mockQuery.mockReturnValue(
        Object.assign(
          (async function* (): AsyncGenerator<unknown, void> {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 'native-errors-root',
            };
            await queryGate;
          })(),
          { backgroundTasks, stopTask },
        ),
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'native-errors',
        },
        jest.fn(),
        getNoWindow,
      );

      try {
        session.sendMessage('run');
        await flush();

        await expect(
          stopNativeSubagentForClaudeSession(
            'project',
            'worktree',
            'native-errors',
            'toolu_error_child',
            'task-error-child',
            false,
          ),
        ).resolves.toBe('failed');
        expect(stopTask).not.toHaveBeenCalled();

        await expect(
          stopNativeSubagentForClaudeSession(
            'project',
            'worktree',
            'native-errors',
            'toolu_error_child',
            'task-error-child',
            false,
          ),
        ).resolves.toBe('failed');
        expect(stopTask).toHaveBeenCalledWith('task-error-child');
        expect(backgroundTasks.mock.calls).toEqual([
          ['toolu_error_child'],
          ['toolu_error_child'],
        ]);
      } finally {
        releaseQuery();
        await flush();
        await session.destroy();
      }
    });

    it('reports not_running when the target query no longer exists', async () => {
      await expect(
        stopNativeSubagentForClaudeSession(
          'project',
          'worktree',
          'missing-query',
          'toolu_stale_child',
          'task-stale-child',
          true,
        ),
      ).resolves.toBe('not_running');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  it('uses the bundled Claude binary for main chat sessions', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    const calls = mockQuery.mock.calls as Array<
      [
        {
          options?: {
            cwd?: string;
            env?: Record<string, string | undefined>;
            hooks?: Record<string, unknown[]>;
            managedSettings?: {
              permissions?: { ask?: string[] };
            };
            settings?: {
              permissions?: { ask?: string[] };
              autoMemoryEnabled?: boolean;
              useAutoModeDuringPlan?: boolean;
            };
            mcpServers?: Record<string, unknown>;
            pathToClaudeCodeExecutable?: string;
            sandbox?: { ripgrep?: { command?: string } };
            settingSources?: string[];
            spawnClaudeCodeProcess?: unknown;
          };
        },
      ]
    >;
    const firstCall = calls[0]?.[0];

    expect(firstCall?.options?.cwd).toBe('/tmp/repo');
    expect(firstCall?.options?.pathToClaudeCodeExecutable).toBe('/mock/claude');
    expect(firstCall?.options?.spawnClaudeCodeProcess).toEqual(
      expect.any(Function),
    );
    expect(firstCall?.options?.sandbox?.ripgrep?.command).toBe('/mock/rg');
    expect(firstCall?.options?.settingSources).toEqual([
      'user',
      'project',
      'local',
    ]);
    expect(firstCall?.options?.managedSettings).toEqual({
      permissions: { ask: ['*'] },
    });
    expect(firstCall?.options?.settings).toEqual({
      permissions: { ask: ['*'] },
      // Plan mode keeps Canopy's approval hooks authoritative.
      useAutoModeDuringPlan: false,
    });
    expect(firstCall?.options?.env?.CANOPY_RTK_BINARY_PATH).toBe('/mock/rtk');
    expect(firstCall?.options?.env?.RTK_TELEMETRY_DISABLED).toBe('1');
    expect(firstCall?.options?.env?.RTK_DB_PATH).toBe(
      '/mock/canopy/rtk/history.db',
    );
    expect(firstCall?.options?.env?.RTK_TEE_DIR).toBe('/mock/canopy/rtk/tee');
    // Local memory is opt-in and off by default, so the approval fallback is
    // retained without adding native-memory suppression (CAN-1969).
    expect(firstCall?.options?.hooks?.PreToolUse).toEqual(
      expect.arrayContaining([expect.any(Object)]),
    );
    expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'project/worktree/chat',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        assistantMode: 'default',
        toolSurface: 'native-sdk',
        cwd: '/tmp/repo',
      }),
    );
    expectHttpMcpServer(
      firstCall?.options?.mcpServers?.canopy,
      'http://127.0.0.1:4567/mcp/project%2Fworktree%2Fchat',
    );
    expect(firstCall?.options?.mcpServers?.canopy).toMatchObject({
      timeout: 660_000,
    });
    expectHttpMcpServer(
      firstCall?.options?.mcpServers?.canopy_ui,
      'http://127.0.0.1:4567/mcp/project%2Fworktree%2Fchat/ui',
    );
    expect(firstCall?.options?.mcpServers?.canopy_ui).toMatchObject({
      timeout: 3_600_000,
    });

    await session.destroy();
  });

  it('exposes the provider session id observed from the Claude init event', async () => {
    mockQuery.mockReturnValue(
      makeMessages([
        {
          type: 'system',
          subtype: 'init',
          session_id: 'claude-provider-session',
        },
      ]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'provider-session-id',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    expect(session.getProviderSessionId?.()).toBe('claude-provider-session');
    await session.destroy();
  });

  it('reports disposal after cancel or destroy, when queued sends can no longer reach the provider', async () => {
    // Hold the SDK response stream open behind a gate so the query loop is
    // genuinely still running for the pre-cancel baseline assertion — a
    // finite mock stream would end the loop immediately, which itself
    // reports disposed (covered by the query-loop-exit test below).
    let releaseStream: () => void = () => undefined;
    const streamGate = new Promise<void>((resolveGate) => {
      releaseStream = resolveGate;
    });
    async function* openStream(): AsyncGenerator<unknown, void> {
      await Promise.resolve();
      yield { type: 'result', is_error: false, result: 'done' };
      await streamGate;
    }
    mockQuery.mockReturnValue(openStream());

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-liveness',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();
    expect(session.isDisposed?.()).toBe(false);

    // cancel() aborts the controller, which permanently ends the SDK query
    // loop — a Claude session cannot process queued messages after cancel.
    await expect(session.cancel()).resolves.toBeUndefined();
    expect(session.isDisposed?.()).toBe(true);
    expect(claudeQueryParams().options?.abortController?.signal.aborted).toBe(
      true,
    );

    releaseStream();
    await session.destroy();
    expect(session.isDisposed?.()).toBe(true);
  });

  it('reports disposal after the query loop exits without destroy or cancel', async () => {
    // A caught startup error ends _runQuery and unregisters the session
    // without setting destroyRequested or aborting the controller — the
    // queue is undrainable, so the session must report disposed.
    mockQuery.mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-loop-exit',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();
    expect(session.isDisposed?.()).toBe(true);

    await session.destroy();
  });

  it('suppresses Claude native memory when local memory is enabled', async () => {
    mockedReadLocalMemoryEnabledPreference.mockResolvedValueOnce(true);
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'local-memory-on',
      },
      jest.fn(),
      getNoWindow,
    );
    await flush();

    expect(mockQuery.mock.calls[0]?.[0]?.options?.disallowedTools).toEqual(
      expect.arrayContaining(['AskUserQuestion', 'ScheduleWakeup']),
    );
    const settingsValue = mockQuery.mock.calls[0]?.[0]?.options?.settings;
    const settings =
      typeof settingsValue === 'string' ? undefined : settingsValue;
    expect(settings?.autoMemoryEnabled).toBe(false);
    await session.destroy();
  });

  it('leaves Claude native memory settings untouched when explicitly allowed', async () => {
    mockedReadLocalMemoryEnabledPreference.mockResolvedValueOnce(true);
    process.env.CANOPY_HARNESS_NATIVE_MEMORY = 'true';
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'native-memory',
      },
      jest.fn(),
      getNoWindow,
    );
    await flush();

    expect(mockQuery.mock.calls[0]?.[0]?.options?.settings).toEqual({
      permissions: { ask: ['*'] },
      useAutoModeDuringPlan: false,
    });
    await session.destroy();
  });

  it('keeps the native-memory suppression when Ultra thinking settings apply', async () => {
    mockedReadLocalMemoryEnabledPreference.mockResolvedValueOnce(true);
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ultra-native-memory',
        model: 'fable[1m]',
        thinkingLevel: 'ultra',
      },
      jest.fn(),
      getNoWindow,
    );
    await flush();

    const settingsValue = mockQuery.mock.calls[0]?.[0]?.options?.settings;
    const settings =
      typeof settingsValue === 'string' ? undefined : settingsValue;
    // Ultra's `settings: { ultracode: true }` must merge with — not replace —
    // the native-memory suppression applied while local memory is enabled
    // (CAN-1969 review finding).
    expect(settings?.autoMemoryEnabled).toBe(false);
    expect(settings?.ultracode).toBe(true);

    await session.destroy();
  });

  it('carries the session-created Code Graph capability into the Claude MCP route', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-without-graph-tools',
        codeGraphToolsAdvertised: false,
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();
    expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'project/worktree/chat-without-graph-tools',
        codeGraphToolsAdvertised: false,
      }),
    );

    await session.destroy();
  });

  it('forks a resumed Claude provider session for a forked chat', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/destination-worktree',
        projectId: 'project',
        worktreeId: 'destination',
        chatId: 'forked-chat',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    const firstCall = mockQuery.mock.calls[0]?.[0];
    expect(firstCall?.options).toEqual(
      expect.objectContaining({
        resume: 'source-session',
        forkSession: true,
      }),
    );
    expect(firstCall?.options).not.toHaveProperty('resumeSessionAt');

    await session.destroy();
  });

  it('forks a resumed Claude session at the kept turn chain entry', async () => {
    // A truncated fork must resume only the messages it kept, otherwise the
    // model sees turns the forked transcript deliberately discarded.
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/destination-worktree',
        projectId: 'project',
        worktreeId: 'destination',
        chatId: 'forked-chat',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
        claudeForkResumeAt: CHAIN_UUID,
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    const firstCall = mockQuery.mock.calls[0]?.[0];
    expect(firstCall?.options).toEqual(
      expect.objectContaining({
        resume: 'source-session',
        forkSession: true,
        resumeSessionAt: CHAIN_UUID,
      }),
    );

    await session.destroy();
  });

  it('tags a deliberately fresh fork init for persisted disclosure', async () => {
    const emit = jest.fn();
    mockQuery.mockReturnValue(
      makeMessages([
        { type: 'system', subtype: 'init', session_id: 'fresh-session' },
        { type: 'result', is_error: false, result: 'done' },
      ]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/destination-worktree',
        projectId: 'project',
        worktreeId: 'destination',
        chatId: 'fresh-fork-chat',
        claudeForkStartsFresh: true,
      },
      emit,
      getNoWindow,
    );

    await flush();

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        subtype: 'init',
        canopy_fork_model_context: 'fresh',
      }),
    );

    await session.destroy();
  });

  it.each([
    {
      label: 'the SDK iterator throws the CLI refusal',
      makeFailure: (): AsyncGenerator<unknown, void> =>
        (async function* (): AsyncGenerator<unknown, void> {
          await Promise.resolve();
          if (Date.now() > 0) {
            throw new Error(
              'Claude Code returned an error result: No message found with message.uuid of: chain-a1',
            );
          }
          yield undefined;
        })(),
    },
    {
      label: 'the CLI emits an error_during_execution result',
      makeFailure: (): AsyncGenerator<unknown, void> =>
        makeMessages([
          {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['No message found with message.uuid of: chain-a1'],
          },
        ]),
    },
  ])(
    'retries a rejected fork anchor once with fresh model context when %s',
    async ({ makeFailure }) => {
      const emit = jest.fn();
      mockQuery.mockReturnValueOnce(makeFailure()).mockReturnValueOnce(
        makeMessages([
          {
            type: 'system',
            subtype: 'init',
            session_id: 'fresh-session',
          },
          { type: 'result', is_error: false, result: 'done' },
        ]),
      );

      const provider = new ClaudeCodeProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/destination-worktree',
          projectId: 'project',
          worktreeId: 'destination',
          chatId: 'rejected-anchor-chat',
          sdkSessionId: 'source-session',
          claudeForkSession: true,
          claudeForkResumeAt: CHAIN_UUID,
        },
        emit,
        getNoWindow,
      );

      await flush();
      await flush();

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(
        jest.mocked(resetSessionLiveBackgroundTasks),
      ).toHaveBeenCalledTimes(2);
      expect(resetSessionLiveBackgroundTasks).toHaveBeenNthCalledWith(
        1,
        'project/destination/rejected-anchor-chat',
      );
      expect(resetSessionLiveBackgroundTasks).toHaveBeenNthCalledWith(
        2,
        'project/destination/rejected-anchor-chat',
      );
      expect(mockQuery.mock.calls[0]?.[0]?.options).toEqual(
        expect.objectContaining({ resumeSessionAt: CHAIN_UUID }),
      );
      const retryOptions = mockQuery.mock.calls[1]?.[0]?.options;
      expect(retryOptions).not.toHaveProperty('resume');
      expect(retryOptions).not.toHaveProperty('forkSession');
      expect(retryOptions).not.toHaveProperty('resumeSessionAt');
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'system',
          subtype: 'init',
          canopy_fork_model_context: 'fresh',
        }),
      );
      // The refusal must never reach the transcript as a failed turn.
      expect(
        emit.mock.calls.filter(([event]) => readEventType(event) === 'error'),
      ).toHaveLength(0);

      await session.destroy();
    },
  );

  it('answers the calls a fork anchor left open in its first prompt', async () => {
    let resolveFirstPrompt: ((value: unknown) => void) | undefined;
    const firstPrompt = new Promise<unknown>((resolve) => {
      resolveFirstPrompt = resolve;
    });
    mockQuery.mockImplementationOnce(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          resolveFirstPrompt?.((await prompt.next()).value);
          yield { type: 'result', is_error: false, result: 'done' };
        })(),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/destination-worktree',
        projectId: 'project',
        worktreeId: 'destination',
        chatId: 'split-fork-chat',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
        claudeForkResumeAt: CHAIN_UUID,
        claudeForkToolResults: [
          { toolUseId: 'split-call', content: 'You are the fork.' },
        ],
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Continue');
    await expect(firstPrompt).resolves.toEqual(
      expect.objectContaining({
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'split-call',
              content: 'You are the fork.',
            },
            { type: 'text', text: 'Continue' },
          ],
        },
      }),
    );

    await session.destroy();
  });

  it('does not send a redundant permission control before the initial fork prompt', async () => {
    let receiveRetryPrompt: (value: unknown) => void = () => undefined;
    const retryPrompt = new Promise<unknown>((resolve) => {
      receiveRetryPrompt = resolve;
    });
    let releaseQuery = (): void => undefined;
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const setPermissionMode = jest.fn(() =>
      Promise.reject(
        new Error(
          'Claude Code returned an error result: No message found with message.uuid of: chain-a1',
        ),
      ),
    );
    mockQuery.mockImplementationOnce(() => {
      const iterator = (async function* (): AsyncGenerator<unknown, void> {
        await queryGate;
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['No message found with message.uuid of: chain-a1'],
        };
      })();
      return Object.assign(iterator, { setPermissionMode });
    });
    mockQuery.mockImplementationOnce(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          receiveRetryPrompt((await prompt.next()).value);
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'fresh-session',
          };
          yield { type: 'result', is_error: false, result: 'done' };
        })(),
    );
    const emit = jest.fn();
    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/destination-worktree',
        projectId: 'project',
        worktreeId: 'destination',
        chatId: 'fork-control-chat',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
        claudeForkResumeAt: CHAIN_UUID,
        approvalMode: 'full-access',
      },
      emit,
      getNoWindow,
    );
    await flush();
    try {
      await expect(
        session.setApprovalMode('full-access'),
      ).resolves.toBeUndefined();
      expect(setPermissionMode).not.toHaveBeenCalled();
      // Match normal dispatch: apply the inherited mode before sending. The
      // failed original query must not strand its replacement without input.
      session.sendMessage('Continue');
      releaseQuery();
      await expect(retryPrompt).resolves.toEqual(
        expect.objectContaining({
          message: { role: 'user', content: 'Continue' },
        }),
      );
      await flush();
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[1]?.[0]?.options).not.toHaveProperty(
        'resume',
      );
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'system',
          subtype: 'init',
          canopy_fork_model_context: 'fresh',
        }),
      );
    } finally {
      releaseQuery();
      await session.destroy();
    }
  });

  it('replays a fork prompt without tool results when its anchor is rejected', async () => {
    let resolveReplayed: ((value: unknown) => void) | undefined;
    const replayed = new Promise<unknown>((resolve) => {
      resolveReplayed = resolve;
    });
    mockQuery
      .mockImplementationOnce(
        ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
          (async function* (): AsyncGenerator<unknown, void> {
            await prompt.next();
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['No message found with message.uuid of: chain-a1'],
            };
          })(),
      )
      .mockImplementationOnce(
        ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
          (async function* (): AsyncGenerator<unknown, void> {
            resolveReplayed?.((await prompt.next()).value);
            yield { type: 'result', is_error: false, result: 'done' };
          })(),
      );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/destination-worktree',
        projectId: 'project',
        worktreeId: 'destination',
        chatId: 'split-fork-rejected-chat',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
        claudeForkResumeAt: CHAIN_UUID,
        claudeForkToolResults: [
          { toolUseId: 'split-call', content: 'You are the fork.' },
        ],
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Continue');
    await expect(replayed).resolves.toEqual(
      expect.objectContaining({
        message: { role: 'user', content: 'Continue' },
      }),
    );

    await session.destroy();
  });

  it('reuses an abandoned prompt pull when a rejected fork anchor restarts fresh', async () => {
    let resolveSecondInput: ((value: unknown) => void) | undefined;
    const secondInput = new Promise<unknown>((resolve) => {
      resolveSecondInput = resolve;
    });
    mockQuery
      .mockImplementationOnce(
        ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
          (async function* (): AsyncGenerator<unknown, void> {
            await prompt.next();
            // The SDK may eagerly pull again before surfacing the refusal. That
            // wrapper is abandoned when the iterator is replaced by the retry.
            void prompt.next();
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['No message found with message.uuid of: chain-a1'],
            };
          })(),
      )
      .mockImplementationOnce(
        ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
          (async function* (): AsyncGenerator<unknown, void> {
            await prompt.next(); // replayed initial prompt
            resolveSecondInput?.((await prompt.next()).value);
            yield { type: 'result', is_error: false, result: 'done' };
          })(),
      );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/destination-worktree',
        projectId: 'project',
        worktreeId: 'destination',
        chatId: 'rejected-anchor-prompt-chat',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
        claudeForkResumeAt: CHAIN_UUID,
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Initial prompt');
    await flush();
    await flush();
    expect(mockQuery).toHaveBeenCalledTimes(2);

    session.sendMessage('Follow-up prompt');
    await expect(secondInput).resolves.toEqual(
      expect.objectContaining({
        message: { role: 'user', content: 'Follow-up prompt' },
      }),
    );

    await session.destroy();
  });

  it('replays every prompt consumed before a rejected fork anchor', async () => {
    let releaseRejection: (() => void) | undefined;
    const rejectionGate = new Promise<void>((resolve) => {
      releaseRejection = resolve;
    });
    let resolveConsumedPrompts: (() => void) | undefined;
    const consumedPrompts = new Promise<void>((resolve) => {
      resolveConsumedPrompts = resolve;
    });
    let resolveReplayedPrompts: ((value: unknown[]) => void) | undefined;
    const replayedPrompts = new Promise<unknown[]>((resolve) => {
      resolveReplayedPrompts = resolve;
    });
    mockQuery
      .mockImplementationOnce(
        ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
          (async function* (): AsyncGenerator<unknown, void> {
            await prompt.next();
            // Model an eager iterator that consumes the already queued
            // follow-up before it reports the invalid resume point.
            await prompt.next();
            resolveConsumedPrompts?.();
            await rejectionGate;
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['No message found with message.uuid of: chain-a1'],
            };
          })(),
      )
      .mockImplementationOnce(
        ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
          (async function* (): AsyncGenerator<unknown, void> {
            const firstResult: IteratorResult<unknown> = await prompt.next();
            const first: unknown = firstResult.done
              ? undefined
              : firstResult.value;
            const firstMessage =
              typeof first === 'object' &&
              first !== null &&
              'message' in first &&
              typeof first.message === 'object' &&
              first.message !== null
                ? first.message
                : undefined;
            const firstText =
              firstMessage &&
              'content' in firstMessage &&
              typeof firstMessage.content === 'string'
                ? firstMessage.content
                : undefined;
            if (firstText !== 'Initial prompt') {
              resolveReplayedPrompts?.([first]);
              yield { type: 'result', is_error: false, result: 'done' };
              return;
            }
            const secondResult: IteratorResult<unknown> = await prompt.next();
            const second: unknown = secondResult.done
              ? undefined
              : secondResult.value;
            resolveReplayedPrompts?.([first, second]);
            yield { type: 'result', is_error: false, result: 'done' };
          })(),
      );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/destination-worktree',
        projectId: 'project',
        worktreeId: 'destination',
        chatId: 'rejected-anchor-queued-prompts-chat',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
        claudeForkResumeAt: CHAIN_UUID,
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Initial prompt');
    await flush();
    session.sendMessage('Follow-up prompt');
    await consumedPrompts;
    releaseRejection?.();

    await expect(replayedPrompts).resolves.toEqual([
      expect.objectContaining({
        message: { role: 'user', content: 'Initial prompt' },
      }),
      expect.objectContaining({
        message: { role: 'user', content: 'Follow-up prompt' },
      }),
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    await session.destroy();
  });

  it('starts fresh when a supplied fork anchor is not a chain uuid', async () => {
    // A malformed point-in-time anchor must fail closed. Falling back to a
    // plain resume would expose source-session turns the fork discarded.
    const emit = jest.fn();
    mockQuery.mockReturnValue(
      makeMessages([
        { type: 'system', subtype: 'init', session_id: 'fresh-session' },
        { type: 'result', is_error: false, result: 'done' },
      ]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/destination-worktree',
        projectId: 'project',
        worktreeId: 'destination',
        chatId: 'forked-chat',
        sdkSessionId: 'source-session',
        claudeForkSession: true,
        claudeForkResumeAt: 'not-a-uuid; --rm -rf',
      },
      emit,
      getNoWindow,
    );

    await flush();

    const firstCall = mockQuery.mock.calls[0]?.[0];
    expect(firstCall?.options).not.toHaveProperty('resume');
    expect(firstCall?.options).not.toHaveProperty('forkSession');
    expect(firstCall?.options).not.toHaveProperty('resumeSessionAt');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        subtype: 'init',
        canopy_fork_model_context: 'fresh',
      }),
    );
    expect(mockQuery).toHaveBeenCalledTimes(1);

    await session.destroy();
  });

  it('ignores a fork anchor without a resumed fork session', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/destination-worktree',
        projectId: 'project',
        worktreeId: 'destination',
        chatId: 'plain-chat',
        sdkSessionId: 'source-session',
        claudeForkResumeAt: CHAIN_UUID,
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    const firstCall = mockQuery.mock.calls[0]?.[0];
    expect(firstCall?.options).not.toHaveProperty('resumeSessionAt');

    await session.destroy();
  });

  it('reapplies Claude thinking flags against the current live model', async () => {
    const queryResult = makeQueryResult([
      { type: 'result', is_error: false, result: 'done' },
    ]);
    mockQuery.mockReturnValue(queryResult);

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'fable[1m]',
        thinkingLevel: 'ultra',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();
    await session.setModel('claude-haiku-4-5-20251001');

    expect(queryResult.setModel).toHaveBeenCalledWith(
      'claude-haiku-4-5-20251001',
    );
    expect(queryResult.applyFlagSettings).toHaveBeenLastCalledWith({
      alwaysThinkingEnabled: true,
      effortLevel: 'xhigh',
      ultracode: false,
    });

    await session.destroy();
  });

  it('exposes the live selected model to managed delegation after a model change', async () => {
    let readCurrentOptions:
      | ManagedDelegationSessionOptions['currentOptions']
      | undefined;
    mockManagedDelegationEnabled.mockReturnValue(true);
    mockCreateManagedDelegationSession.mockImplementationOnce((options) => {
      readCurrentOptions = options.currentOptions;
      return Promise.resolve(createManagedDelegationStub());
    });
    mockQuery.mockReturnValue(
      makeQueryResult([{ type: 'result', is_error: false, result: 'done' }]),
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'managed-live-selected-model',
        model: 'fable[1m]',
        selectedModel: 'fable[1m]',
      },
      jest.fn(),
      getNoWindow,
    );
    await flush();

    await session.setModel('claude-haiku-4-5-20251001');

    expect(readCurrentOptions?.().selectedModel).toBe(
      'claude-haiku-4-5-20251001',
    );
    await session.destroy();
  });

  it('skips redundant plan-mode controls while applying real transitions', async () => {
    const queryResult = makeQueryResult([
      { type: 'result', is_error: false, result: 'done' },
    ]);
    mockQuery.mockReturnValue(queryResult);

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        planMode: false,
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    await session.setPlanMode(false);
    expect(queryResult.setPermissionMode).not.toHaveBeenCalled();

    await session.setPlanMode(true);
    expect(queryResult.setPermissionMode).toHaveBeenCalledTimes(1);
    expect(queryResult.setPermissionMode).toHaveBeenLastCalledWith('plan');

    await session.setPlanMode(true);
    expect(queryResult.setPermissionMode).toHaveBeenCalledTimes(1);

    await session.setPlanMode(false);
    expect(queryResult.setPermissionMode).toHaveBeenCalledTimes(2);
    expect(queryResult.setPermissionMode).toHaveBeenLastCalledWith('default');

    await session.destroy();
  });

  it('delegates foreground SDK process creation to the utility host', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    const calls = mockQuery.mock.calls as Array<
      [
        {
          options?: {
            spawnClaudeCodeProcess?: (options: {
              command: string;
              args: string[];
              cwd?: string;
              env?: Record<string, string | undefined>;
            }) => {
              kill(signal: NodeJS.Signals): boolean;
            };
          };
        },
      ]
    >;
    const spawnClaudeCodeProcess =
      calls[0]?.[0].options?.spawnClaudeCodeProcess;
    if (!spawnClaudeCodeProcess) {
      throw new Error('Expected spawnClaudeCodeProcess option');
    }

    const exitCode: number | null = null;
    const signalCode: NodeJS.Signals | null = null;
    const hostedProcess = {
      stdin: {},
      stdout: {},
      killed: false,
      exitCode,
      signalCode,
      kill: jest.fn(() => true),
      on: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
    };
    mockSpawnClaudeCodeProcessOffMain.mockReturnValue(hostedProcess);

    const options = {
      command: '/mock/claude',
      args: ['--version'],
      cwd: '/tmp/repo',
      env: {},
    };
    const spawned = spawnClaudeCodeProcess(options);

    expect(mockSpawnClaudeCodeProcessOffMain).toHaveBeenCalledWith(
      options,
      expect.objectContaining({
        sessionKey: 'project/worktree/chat',
        sessionInstanceId: 'session-instance-1',
        providerType: 'claude',
      }),
    );
    expect(spawned).toBe(hostedProcess);
    expect(mockSpawn).not.toHaveBeenCalled();

    await session.destroy();
  });

  it('withholds one megabyte of stdout credit while a foreground event admission is pending', async () => {
    const heldAdmission = createGate();
    const assistantAdmissionStarted = createGate();
    const allowStreamExit = createGate();
    const hostedProcess = new ExitOnInputEndHostedCli();
    mockSpawnClaudeCodeProcessOffMain.mockReturnValue(hostedProcess);
    mockWithholdClaudeProcessStdoutCreditUntil.mockClear();
    mockQuery.mockImplementation((params) => {
      const spawnClaudeCodeProcess = params.options?.spawnClaudeCodeProcess;
      if (!spawnClaudeCodeProcess)
        throw new Error('Expected spawnClaudeCodeProcess option');
      expect(
        spawnClaudeCodeProcess({
          command: '/mock/claude',
          args: [],
          env: {},
          signal: new AbortController().signal,
        }),
      ).toBe(hostedProcess);
      return (async function* (): AsyncGenerator<unknown, void> {
        yield {
          type: 'assistant',
          message: {
            id: 'held-stdout-credit-event',
            role: 'assistant',
            content: [{ type: 'text', text: 'wait for durable admission' }],
          },
        };
        await allowStreamExit.promise;
      })();
    });

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'held-stdout-credit',
      },
      (event: unknown) => {
        if (
          readEventType(event) === 'assistant' &&
          JSON.stringify(event).includes('held-stdout-credit-event')
        ) {
          assistantAdmissionStarted.release();
          return heldAdmission.promise;
        }
      },
      getNoWindow,
    );

    try {
      await assistantAdmissionStarted.promise;
      expect(mockWithholdClaudeProcessStdoutCreditUntil).toHaveBeenCalledWith(
        hostedProcess,
        heldAdmission.promise,
        1024 * 1024,
      );
    } finally {
      heldAdmission.release();
      allowStreamExit.release();
      await flush();
      await session.destroy();
    }
    expect(hostedProcess.stdin.writableEnded).toBe(true);
    await hostedProcess.exited;
    expect(hostedProcess.kill).not.toHaveBeenCalled();
  });

  it('delivers a burst from the SDK iterator after a held chat-event sink drains', async () => {
    const eventCount = 128;
    const payload = 'x'.repeat(2 * 1024);
    let pulled = 0;
    async function* burst(): AsyncGenerator<unknown, void> {
      await Promise.resolve();
      for (let index = 0; index < eventCount; index += 1) {
        pulled += 1;
        yield {
          type: 'assistant',
          message: {
            id: `pressure-${index}`,
            role: 'assistant',
            content: [{ type: 'text', text: `${index}:${payload}` }],
          },
        };
      }
      yield { type: 'result', is_error: false, result: 'complete' };
    }
    mockQuery.mockReturnValue(burst());

    let releaseSink = (): void => undefined;
    const heldSink = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    let signalFirst = (): void => undefined;
    const firstObserved = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const observedIds: string[] = [];
    let observedBytes = 0;
    let largestFrameBytes = 0;
    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'pressure-chat',
      },
      (data: unknown) => {
        const frameBytes = Buffer.byteLength(JSON.stringify(data));
        observedBytes += frameBytes;
        largestFrameBytes = Math.max(largestFrameBytes, frameBytes);
        if (readEventType(data) !== 'assistant') return;
        const message: unknown =
          typeof data === 'object' && data !== null
            ? Reflect.get(data, 'message')
            : undefined;
        const id: unknown =
          typeof message === 'object' && message !== null
            ? Reflect.get(message, 'id')
            : undefined;
        if (typeof id !== 'string') return;
        observedIds.push(id);
        if (observedIds.length === 1) {
          signalFirst();
          return heldSink;
        }
      },
      getNoWindow,
    );

    try {
      await firstObserved;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(observedBytes).toBeLessThanOrEqual(64 * 1024 + largestFrameBytes);
      releaseSink();
      for (
        let attempts = 0;
        attempts < 100 && observedIds.length < eventCount;
        attempts += 1
      ) {
        await flush();
      }
      expect(observedIds).toEqual(
        Array.from({ length: eventCount }, (_, index) => `pressure-${index}`),
      );
      expect(pulled).toBe(eventCount);
    } finally {
      releaseSink();
      await session.destroy();
    }
  });

  it.each([false, true])(
    'receives a steer behind held admission after pending=%s without publishing pickup early',
    async (afterPending) => {
      const held = createGate();
      const heldStarted = createGate();
      const steerPulled = createGate();
      const allowReceipt = createGate();
      const receiptRead = createGate();
      const admitted = createGate();
      const exit = createGate();
      const events: unknown[] = [];
      mockQuery.mockImplementation(({ prompt }) => {
        if (typeof prompt === 'string')
          throw new Error('Expected streaming prompt');
        const input = prompt[Symbol.asyncIterator]();
        const stream = (async function* (): AsyncGenerator<unknown, void> {
          await input.next();
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'receipt-steer',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'held-steer-prefix' }] },
          };
          await input.next();
          steerPulled.release();
          await allowReceipt.promise;
          yield {
            type: 'command_lifecycle',
            command_uuid: 'receipt-attempt',
            state: 'queued',
          };
          yield {
            type: 'command_lifecycle',
            command_uuid: 'receipt-attempt',
            state: 'started',
          };
          receiptRead.release();
          await exit.promise;
        })();
        return Object.assign(stream, {
          cancelAsyncMessage: jest.fn(),
          interrupt: jest.fn(),
        });
      });
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: `receipt-steer-${afterPending}`,
        },
        (event: unknown) => {
          events.push(event);
          if (readEventType(event) === 'assistant') {
            heldStarted.release();
            return held.promise;
          }
          if (
            readEventType(event) === 'command_lifecycle' &&
            readEventString(event, 'state') === 'started'
          )
            admitted.release();
        },
        getNoWindow,
      );
      const phases = (): Array<string | undefined> =>
        events
          .filter((event) => readEventType(event) === 'canopy_input_delivery')
          .map((event) => readEventString(event, 'phase'));
      try {
        session.sendMessage('root', { userMessageId: 'root' });
        await heldStarted.promise;
        if (afterPending)
          jest.useFakeTimers({
            doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
          });
        const submission = session.submitSteeringInput?.(
          'steer',
          'receipt-attempt',
          'steer-user',
        );
        if (!submission) throw new Error('Expected steering');
        await steerPulled.promise;
        if (afterPending) {
          await jest.advanceTimersByTimeAsync(5001);
          await expect(submission).resolves.toEqual({
            kind: 'pending',
            attemptId: 'receipt-attempt',
          });
          jest.useRealTimers();
        }
        allowReceipt.release();
        await receiptRead.promise;
        if (!afterPending)
          await expect(submission).resolves.toEqual({
            kind: 'accepted',
            attemptId: 'receipt-attempt',
          });
        expect(phases()).toEqual(['accepted']);
        expect(
          events.filter(
            (event) => readEventType(event) === 'command_lifecycle',
          ),
        ).toEqual([]);
        held.release();
        await admitted.promise;
        expect(phases()).toEqual(['accepted', 'picked-up']);
        expect(session.hasPendingSteeringInput?.()).toBe(false);
      } finally {
        jest.useRealTimers();
        held.release();
        allowReceipt.release();
        exit.release();
        await session.destroy();
      }
      expect(phases()).not.toContain('unknown');
    },
  );

  it('admits the SDK throw only after the already-received held prefix', async () => {
    const held = createGate();
    const started = createGate();
    const thrown = createGate();
    const observed: unknown[] = [];
    mockQuery.mockImplementation(({ prompt }) =>
      (async function* (): AsyncGenerator<unknown, void> {
        if (typeof prompt === 'string')
          throw new Error('Expected streaming prompt');
        const firstPrompt = await prompt[Symbol.asyncIterator]().next();
        const userMessageUuid = readEventString(firstPrompt.value, 'uuid');
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'throw-prefix',
          ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
        };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'held' }] },
        };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'next' }] },
        };
        thrown.release();
        throw new Error('SDK receipt failure');
      })(),
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'throw-prefix',
      },
      (event) => {
        observed.push(event);
        if (
          readEventType(event) === 'assistant' &&
          observed.filter((value) => readEventType(value) === 'assistant')
            .length === 1
        ) {
          started.release();
          return held.promise;
        }
      },
      getNoWindow,
    );
    try {
      session.sendMessage('root', { userMessageId: 'throw-owner' });
      await started.promise;
      await thrown.promise;
      await flush();
      expect(
        observed
          .map(readEventType)
          .filter((type) => type === 'assistant' || type === 'error'),
      ).toEqual(['assistant']);
      held.release();
      await flush();
      await flush();
      const prefix = observed.filter(
        (event) =>
          readEventType(event) === 'assistant' ||
          readEventType(event) === 'error',
      );
      expect(prefix.map(readEventType)).toEqual([
        'assistant',
        'assistant',
        'error',
      ]);
      expect(prefix.map(readTurnUserMessageId)).toEqual([
        'throw-owner',
        'throw-owner',
        'throw-owner',
      ]);
      expect(prefix.at(-1)).toMatchObject({ error: 'SDK receipt failure' });
    } finally {
      held.release();
      await session.destroy();
    }
  });

  it('stamps a terminal after queued task admission and records settlement after that terminal', async () => {
    const held = createGate();
    const started = createGate();
    const read = createGate();
    const exit = createGate();
    const events: unknown[] = [];
    const recorded: string[] = [];
    let live: string[] = [];
    mockGetChildToolLiveness.mockImplementation(() => ({
      kind: 'known',
      liveParentToolUseIds: [...live],
      hasUncorrelatedLiveTask: false,
    }));
    const record = jest.mocked(recordSessionEvent);
    record.mockImplementation((_key, event) => {
      const subtype = readEventString(event, 'subtype');
      if (subtype === 'task_started') {
        live = ['child-tool'];
        recorded.push('started');
      }
      if (readEventType(event) === 'result') recorded.push('result');
      if (subtype === 'task_notification') {
        live = [];
        recorded.push('settled');
      }
    });
    mockQuery.mockImplementation(({ prompt }) =>
      (async function* (): AsyncGenerator<unknown, void> {
        if (typeof prompt === 'string')
          throw new Error('Expected streaming prompt');
        await prompt[Symbol.asyncIterator]().next();
        yield { type: 'system', subtype: 'init', session_id: 'tasks-prefix' };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'held' }] },
        };
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 'child-task',
          tool_use_id: 'child-tool',
          task_type: 'local_agent',
          description: 'child',
        };
        yield { type: 'result', is_error: false, result: 'root complete' };
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'child-task',
          tool_use_id: 'child-tool',
          status: 'completed',
          output_file: '',
          summary: 'complete',
        };
        read.release();
        await exit.promise;
      })(),
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'tasks-prefix',
      },
      (event) => {
        events.push(event);
        if (readEventType(event) === 'assistant') {
          started.release();
          return held.promise;
        }
      },
      getNoWindow,
    );
    try {
      session.sendMessage('root', { userMessageId: 'tasks-owner' });
      await started.promise;
      await read.promise;
      expect(recorded).toEqual([]);
      held.release();
      await flush();
      await flush();
      expect(recorded).toEqual(['started', 'result', 'settled']);
      const terminal = events.find(
        (event) => readEventType(event) === 'result',
      );
      expect(readChildToolLivenessStamp(terminal)).toEqual({
        kind: 'known',
        liveParentToolUseIds: ['child-tool'],
        hasUncorrelatedLiveTask: false,
      });
      expect(live).toEqual([]);
    } finally {
      held.release();
      exit.release();
      await session.destroy();
      record.mockReset();
    }
  });

  it('bounds a full receipt queue and reports one payload-free saturation diagnostic before a sink rejection', async () => {
    const diagnostics = jest.spyOn(
      getObservabilityService(),
      'recordSessionDiagnostic',
    );
    const fullQueueRead = createGate();
    const refilledQueueRead = createGate();
    const firstAdmissionStarted = createGate();
    const allowFirstAdmission = createGate();
    const secondAdmissionStarted = createGate();
    let resolveSecondAdmission = (): void => undefined;
    let rejectSecondAdmission = (): void => undefined;
    let secondAdmissionSettled = false;
    const secondAdmission = new Promise<void>((resolve, reject) => {
      resolveSecondAdmission = (): void => {
        if (secondAdmissionSettled) return;
        secondAdmissionSettled = true;
        resolve();
      };
      rejectSecondAdmission = (): void => {
        if (secondAdmissionSettled) return;
        secondAdmissionSettled = true;
        reject(new Error('receipt sink rejected'));
      };
    });
    let pulled = 0;
    mockQuery.mockImplementation((params) => {
      if (typeof params.prompt === 'string')
        throw new Error('Expected a streaming Claude prompt');
      const prompt = params.prompt[Symbol.asyncIterator]();
      return (async function* (): AsyncGenerator<unknown, void> {
        await prompt.next();
        for (let index = 0; index < 600; index += 1) {
          pulled += 1;
          if (pulled === 257) fullQueueRead.release();
          if (pulled === 258) refilledQueueRead.release();
          yield {
            type: 'assistant',
            message: {
              id: `receipt-pressure-${index}`,
              role: 'assistant',
              content: [{ type: 'text', text: `${index}:held` }],
            },
          };
        }
      })();
    });

    let assistantAdmissions = 0;
    const onEvent = jest.fn((event: unknown) => {
      if (readEventType(event) === 'error') return;
      if (readEventType(event) !== 'assistant') return;
      assistantAdmissions += 1;
      if (assistantAdmissions === 1) {
        firstAdmissionStarted.release();
        return allowFirstAdmission.promise;
      }
      if (assistantAdmissions === 2) {
        secondAdmissionStarted.release();
        return secondAdmission;
      }
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'receipt-queue-capacity',
      },
      onEvent,
      getNoWindow,
    );

    const backlogDiagnostics = (): unknown[][] =>
      diagnostics.mock.calls.filter(
        ([entry]) => entry.kind === 'claude_event_receipt_backlog',
      );
    const oldestWaitMs = (diagnostic: unknown): number | undefined => {
      if (
        typeof diagnostic !== 'object' ||
        diagnostic === null ||
        !('claudeReceiptOldestWaitMs' in diagnostic) ||
        typeof diagnostic.claudeReceiptOldestWaitMs !== 'number'
      )
        return undefined;
      return diagnostic.claudeReceiptOldestWaitMs;
    };
    try {
      session.sendMessage('Fill the receipt queue', {
        userMessageId: 'receipt-queue-user',
      });
      await firstAdmissionStarted.promise;
      await fullQueueRead.promise;
      for (let attempts = 0; attempts < 10; attempts += 1) await flush();
      expect(pulled).toBe(257);
      expect(backlogDiagnostics()).toHaveLength(1);
      expect(backlogDiagnostics()[0]?.[0]).toEqual(
        expect.objectContaining({
          kind: 'claude_event_receipt_backlog',
          claudeReceiptQueueDepth: 256,
        }),
      );
      expect(oldestWaitMs(backlogDiagnostics()[0]?.[0])).toBeGreaterThanOrEqual(
        0,
      );
      expect(backlogDiagnostics()[0]?.[0]).not.toHaveProperty('payload');
      expect(backlogDiagnostics()[0]?.[0]).not.toHaveProperty('text');

      allowFirstAdmission.release();
      await secondAdmissionStarted.promise;
      await refilledQueueRead.promise;
      for (let attempts = 0; attempts < 10; attempts += 1) await flush();
      expect(pulled).toBe(258);
      // One slot opening inside the same saturated episode does not retrigger
      // the diagnostic while the remaining FIFO backlog is still full.
      expect(backlogDiagnostics()).toHaveLength(1);

      rejectSecondAdmission();
      for (
        let attempts = 0;
        attempts < 20 &&
        !onEvent.mock.calls.some(([event]) => readEventType(event) === 'error');
        attempts += 1
      ) {
        await flush();
      }
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          error: 'receipt sink rejected',
        }),
      );
      expect(backlogDiagnostics()).toHaveLength(1);
    } finally {
      allowFirstAdmission.release();
      resolveSecondAdmission();
      await session.destroy();
      diagnostics.mockRestore();
    }
  });

  it('registers worktree-scoped Canopy tools over the HTTP route namespace', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'claude-sonnet-4-5',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    const calls = mockQuery.mock.calls as Array<
      [
        {
          options?: {
            mcpServers?: Record<string, unknown>;
          };
        },
      ]
    >;
    const queryOptions = calls[0]?.[0].options;
    const registeredRoute =
      mockRegisterCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
    expect(registeredRoute).toMatchObject({
      sessionKey: 'project/worktree/chat',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      assistantMode: 'default',
      toolSurface: 'native-sdk',
      cwd: '/tmp/repo',
      model: 'claude-sonnet-4-5',
    });
    const onAwaitingUser = (
      registeredRoute as { onAwaitingUser?: () => void } | undefined
    )?.onAwaitingUser;
    expect(onAwaitingUser).toEqual(expect.any(Function));
    // A question pause keeps the turn's message identity so an exact-turn
    // stop still applies to it.
    mockedMarkTurnIdle.mockClear();
    onAwaitingUser?.();
    expect(mockedMarkTurnAwaitingUser).toHaveBeenCalledWith(
      'project/worktree/chat',
    );
    expect(mockedMarkTurnIdle).not.toHaveBeenCalled();
    expectHttpMcpServer(
      queryOptions?.mcpServers?.canopy,
      'http://127.0.0.1:4567/mcp/project%2Fworktree%2Fchat',
    );
    expect(queryOptions?.mcpServers?.canopy).toMatchObject({
      timeout: 660_000,
    });
    expectHttpMcpServer(
      queryOptions?.mcpServers?.canopy_ui,
      'http://127.0.0.1:4567/mcp/project%2Fworktree%2Fchat/ui',
    );
    expect(queryOptions?.mcpServers?.canopy_ui).toMatchObject({
      timeout: 3_600_000,
    });
    expect(queryOptions?.mcpServers).not.toHaveProperty('canopy_app_advisor');

    await session.destroy();
  });

  it('registers App Advisor Claude MCP over the HTTP route namespace', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    const appAdvisorRuntime = {} as never;

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'app-advisor',
        worktreeId: 'global',
        chatId: 'advisor-chat',
        assistantMode: 'app-advisor',
        appAdvisorRuntime,
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    const calls = mockQuery.mock.calls as Array<
      [
        {
          options?: {
            mcpServers?: Record<string, unknown>;
          };
        },
      ]
    >;
    const queryOptions = calls[0]?.[0].options;
    expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'app-advisor/global/advisor-chat',
        projectId: 'app-advisor',
        worktreeId: 'global',
        chatId: 'advisor-chat',
        assistantMode: 'app-advisor',
        cwd: '/tmp/repo',
        appAdvisorRuntime,
      }),
    );
    expectHttpMcpServer(
      queryOptions?.mcpServers?.canopy_app_advisor,
      'http://127.0.0.1:4567/mcp/app-advisor%2Fglobal%2Fadvisor-chat',
    );
    expect(queryOptions?.mcpServers?.canopy_app_advisor).toMatchObject({
      timeout: 660_000,
    });
    expectHttpMcpServer(
      queryOptions?.mcpServers?.canopy_ui,
      'http://127.0.0.1:4567/mcp/app-advisor%2Fglobal%2Fadvisor-chat/ui',
    );
    expect(queryOptions?.mcpServers?.canopy_ui).toMatchObject({
      timeout: 3_600_000,
    });
    expect(queryOptions?.mcpServers).not.toHaveProperty('canopy');

    await session.destroy();
    expect(mockUnregisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      'app-advisor/global/advisor-chat',
    );
  });

  it('delegates App Advisor WatchCommand approval to its scoped runtime', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'app-advisor',
        worktreeId: 'global',
        chatId: 'advisor-chat',
        assistantMode: 'app-advisor',
        appAdvisorRuntime: createAppAdvisorRuntimeFixture(),
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();
    const canUseTool = mockQuery.mock.calls[0]?.[0]?.options?.canUseTool;
    if (!canUseTool) throw new Error('Expected Claude canUseTool callback.');
    const result = await canUseTool(
      APP_ADVISOR_TOOL_REGISTRY.watch_command.claudeToolName,
      { command: 'printf ready', intervalSeconds: 5, maxAttempts: 2 },
      {
        toolUseID: 'watch-command-1',
        requestId: 'watch-command-request-1',
        signal: new AbortController().signal,
      },
    );

    expect(result).toEqual({ behavior: 'allow' });
    expect(mockApprovalCheck).not.toHaveBeenCalled();

    await session.destroy();
  });

  it('routes standalone chat over HTTP with native-sdk-standalone surface and two MCP servers', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'standalone-chat',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `${STANDALONE_CHAT_PROJECT_ID}/standalone-chat/chat`,
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'standalone-chat',
        chatId: 'chat',
        assistantMode: 'default',
        toolSurface: 'native-sdk-standalone',
        cwd: '/tmp/repo',
      }),
    );

    const calls = mockQuery.mock.calls as Array<
      [{ options?: { mcpServers?: Record<string, unknown> } }]
    >;
    const mcpServers = calls[0]?.[0].options?.mcpServers;

    const sessionKey = encodeURIComponent(
      `${STANDALONE_CHAT_PROJECT_ID}/standalone-chat/chat`,
    );
    expectHttpMcpServer(
      mcpServers?.canopy,
      `http://127.0.0.1:4567/mcp/${sessionKey}`,
    );
    expect(mcpServers?.canopy).toMatchObject({ timeout: 660_000 });
    expectHttpMcpServer(
      mcpServers?.canopy_ui,
      `http://127.0.0.1:4567/mcp/${sessionKey}/ui`,
    );
    expect(mcpServers?.canopy_ui).toMatchObject({ timeout: 3_600_000 });

    await session.destroy();
  });

  it('registers no plan comment tools on the Canopy MCP route for a legacy plan-chat scope', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    const registeredRoute =
      mockRegisterCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
    expect(registeredRoute).toBeDefined();
    expect(registeredRoute).toEqual(
      expect.not.objectContaining({ isPlanExplore: true }),
    );
    expect(registeredRoute).not.toHaveProperty('respondToComment');
    expect(registeredRoute).not.toHaveProperty('getCommentThread');

    await session.destroy();
  });

  it('does not persist a tracked plan for standalone plan exit requests', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    sendToWindowMock.mockResolvedValue(undefined);

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'standalone-chat',
        chatId: 'chat',
        planMode: true,
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Plan this change');
    await flush();

    const canUseTool = mockQuery.mock.calls[0]?.[0]?.options?.canUseTool;
    if (!canUseTool) {
      throw new Error('Expected Claude query to expose canUseTool');
    }

    await canUseTool(
      'ExitPlanMode',
      { plan: 'Standalone plan' },
      {
        signal: new AbortController().signal,
        toolUseID: 'standalone-plan-exit',
        requestId: 'standalone-plan-exit-request',
      },
    );

    expect(createTrackedPlanMock).not.toHaveBeenCalled();
    expect(updateTrackedPlanMock).not.toHaveBeenCalled();
    expect(sendToWindowMock).not.toHaveBeenCalled();

    await session.destroy();
  });

  it.each([
    ['pending', 'claude', true, true],
    ['approved', 'claude', true, false],
    ['dismissed', 'claude', true, false],
    ['pending', 'opencode', true, false],
    ['pending', 'claude', false, false],
  ] as const)(
    'restored %s %s review (plan mode %s) reuses identity: %s (CAN-5431)',
    async (reviewStatus, source, planMode, reuse) => {
      mockPlanTrackingTabs.mockResolvedValueOnce({
        version: 1,
        activeTabId: 'restored-review',
        tabs: [
          {
            id: 'restored-review',
            title: 'Restored review',
            messages: [],
            createdAt: '2026-10-30T00:00:00.000Z',
            planMode,
            trackedPlanId: 'restored-plan',
            trackedPlanSource: source,
            trackedPlanReviewStatus: reviewStatus,
            latestRevisionNumber: 1,
          },
        ],
      });
      updateTrackedPlanMock.mockResolvedValueOnce({
        id: 'restored-plan',
        latestRevisionNumber: 2,
      });
      createTrackedPlanMock.mockResolvedValueOnce({
        id: 'different-plan',
        latestRevisionNumber: 1,
      });
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'restored-review',
          planMode: true,
        },
        jest.fn(),
        getNoWindow,
      );
      try {
        session.sendMessage('Revise the restored plan');
        await flush();
        const canUseTool = mockQuery.mock.calls[0]?.[0]?.options?.canUseTool;
        if (!canUseTool) throw new Error('Expected canUseTool');
        await canUseTool(
          'ExitPlanMode',
          { plan: 'Revised content' },
          {
            signal: new AbortController().signal,
            toolUseID: 'restored-plan-exit',
            requestId: 'restored-plan-exit-request',
          },
        );
        expect(mockCommitPlanExit).toHaveBeenCalledWith(
          expect.objectContaining({
            planId: reuse ? 'restored-plan' : 'different-plan',
            revisionNumber: reuse ? 2 : 1,
          }),
        );
        if (reuse) {
          expect(updateTrackedPlanMock).toHaveBeenCalledWith(
            expect.objectContaining({
              planId: 'restored-plan',
              content: 'Revised content',
              reviewStatus: 'pending',
            }),
          );
          expect(createTrackedPlanMock).not.toHaveBeenCalled();
        } else expect(updateTrackedPlanMock).not.toHaveBeenCalled();
      } finally {
        await session.destroy();
      }
    },
  );

  it('commits a plan exit before notifying the renderer', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    sendToWindowMock.mockResolvedValue(undefined);
    const win = new BrowserWindow();
    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        planMode: true,
      },
      jest.fn(),
      () => win,
    );

    session.sendMessage('Plan this change');
    await flush();
    const canUseTool = mockQuery.mock.calls[0]?.[0]?.options?.canUseTool;
    if (!canUseTool) {
      throw new Error('Expected Claude query to expose canUseTool');
    }

    await canUseTool(
      'ExitPlanMode',
      { plan: 'Persist this plan' },
      {
        signal: new AbortController().signal,
        toolUseID: 'persist-plan-exit',
        requestId: 'persist-plan-exit-request',
      },
    );

    expect(mockCommitPlanExit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        reviewMode: 'manual',
        toolInput: { plan: 'Persist this plan' },
      }),
    );
    expect(sendToWindowMock).toHaveBeenCalledWith(
      win,
      expect.any(String),
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        toolInput: { plan: 'Persist this plan' },
      }),
    );
    expect(mockCommitPlanExit.mock.invocationCallOrder[0]).toBeLessThan(
      sendToWindowMock.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(mockAttentionMark).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      state: 'needs_input',
      reason: 'plan_review',
      sourceId: 'plan-review',
    });

    await session.destroy();
  });

  it('marks the result that ends a turn whose plan went to review', async () => {
    let releaseResult: () => void = () => undefined;
    const resultReleased = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    async function* planTurn(): AsyncGenerator<unknown, void> {
      await resultReleased;
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_tools',
      };
    }
    mockQuery.mockReturnValue(planTurn());
    const onEvent = jest.fn();
    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        planMode: true,
      },
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Plan this change');
    await flush();
    const canUseTool = mockQuery.mock.calls[0]?.[0]?.options?.canUseTool;
    if (!canUseTool) {
      throw new Error('Expected Claude query to expose canUseTool');
    }
    await canUseTool(
      'ExitPlanMode',
      { plan: 'Review this plan' },
      {
        signal: new AbortController().signal,
        toolUseID: 'review-plan-exit',
        requestId: 'review-plan-exit-request',
      },
    );
    releaseResult();
    await flush();
    await flush();

    expect(onEvent.mock.calls.flat()).toContainEqual(
      expect.objectContaining({
        type: 'result',
        terminal_reason: 'aborted_tools',
        canopy_plan_handoff: true,
      }),
    );

    await session.destroy();
  });

  it.each([
    ['a plan handed to review', 'completed', true],
    ['a denied tool that stops the turn', 'cancelled', false],
  ] as const)(
    'ends a turn interrupted by %s as %s in its lifecycle',
    async (_label, outcome, handsOffPlan) => {
      mockLoadCachedInventory.mockResolvedValue(null);
      const scope = {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: `aborted-tools-${outcome}`,
      };
      const lifecycleEvents: unknown[] = [];
      releaseClaudeTurnLifecycleProducer(scope);
      setClaudeTurnLifecycleSink((event) => {
        lifecycleEvents.push(event);
      });
      const initAdmitted = createGate();
      const releaseResult = createGate();
      const resultAdmitted = createGate();
      mockQuery.mockImplementation(({ prompt }) => {
        if (typeof prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const input = prompt[Symbol.asyncIterator]();
        return (async function* (): AsyncGenerator<unknown, void> {
          const firstPrompt = await input.next();
          if (firstPrompt.done) return;
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: scope.chatId,
          };
          await releaseResult.promise;
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            terminal_reason: 'aborted_tools',
          };
        })();
      });
      const session = new ClaudeCodeProvider().createSession(
        { cwd: '/tmp/repo', ...scope, planMode: true },
        (event: unknown) => {
          if (readEventString(event, 'subtype') === 'init')
            initAdmitted.release();
          if (readEventType(event) === 'result') resultAdmitted.release();
        },
        getNoWindow,
      );

      try {
        session.sendMessage('Plan this change', {
          userMessageId: `${scope.chatId}-user`,
        });
        await initAdmitted.promise;
        if (handsOffPlan) {
          const canUseTool = mockQuery.mock.calls[0]?.[0]?.options?.canUseTool;
          if (!canUseTool)
            throw new Error('Expected Claude query to expose canUseTool');
          await canUseTool(
            'ExitPlanMode',
            { plan: 'Review this plan' },
            {
              signal: new AbortController().signal,
              toolUseID: `${scope.chatId}-plan-exit`,
              requestId: `${scope.chatId}-plan-exit-request`,
            },
          );
        }
        releaseResult.release();
        await resultAdmitted.promise;

        expect(
          lifecycleEvents.filter(
            (event) => readEventType(event) === 'TurnEnded',
          ),
        ).toEqual([
          expect.objectContaining({
            outcome,
            terminalReason: 'aborted_tools',
            source: 'result',
          }),
        ]);
      } finally {
        releaseResult.release();
        await flush();
        await session.destroy();
        setClaudeTurnLifecycleSink(null);
        releaseClaudeTurnLifecycleProducer(scope);
      }
    },
  );

  it('commits a plan exit when no renderer window exists', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        planMode: true,
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Plan this change');
    await flush();
    const canUseTool = mockQuery.mock.calls[0]?.[0]?.options?.canUseTool;
    if (!canUseTool) {
      throw new Error('Expected Claude query to expose canUseTool');
    }
    await canUseTool(
      'ExitPlanMode',
      { plan: 'Persist without a window' },
      {
        signal: new AbortController().signal,
        toolUseID: 'no-window-plan-exit',
        requestId: 'no-window-plan-exit-request',
      },
    );

    expect(mockCommitPlanExit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        toolInput: { plan: 'Persist without a window' },
      }),
    );
    expect(sendToWindowMock).not.toHaveBeenCalled();

    await session.destroy();
  });

  it('fails closed with a deny result when the approval check rejects', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    mockApprovalCheck.mockRejectedValue(
      new Error('global-rule persistence write failed'),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Run a command');
    await flush();

    const canUseTool = mockQuery.mock.calls[0]?.[0]?.options?.canUseTool;
    if (!canUseTool) {
      throw new Error('Expected Claude query to expose canUseTool');
    }

    const result = await canUseTool(
      'Bash',
      { command: 'ls' },
      {
        toolUseID: 'tool-use-1',
        requestId: 'bash-tool-request-1',
        signal: new AbortController().signal,
      },
    );

    expect(result).toEqual({
      behavior: 'deny',
      message: 'Approval check failed; denied by default.',
    });
    expect(mockApprovalCheck).toHaveBeenCalledWith(
      { kind: 'command', command: 'ls', cwd: '/tmp/repo' },
      expect.objectContaining({ toolUseId: 'tool-use-1' }),
    );

    await session.destroy();
  });

  it('invalidates pending approvals before cancelling an active turn', async () => {
    let finishQuery: () => void = () => {
      throw new Error('Query did not start');
    };
    async function* pendingQuery(): AsyncGenerator<unknown, void> {
      await new Promise<void>((resolve) => {
        finishQuery = resolve;
      });
      yield { type: 'result', is_error: false, result: 'done' };
    }
    mockQuery.mockReturnValue(pendingQuery());

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Run a command');
    await flush();
    await session.cancel();

    expect(mockApprovalInvalidatePending).toHaveBeenCalledTimes(1);

    finishQuery();
    await flush();
    await flush();
    await session.destroy();
  });

  it('invalidates pending approvals when SDK approval callbacks abort', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    const pendingResolvers: Array<() => void> = [];
    mockApprovalCheck.mockImplementation(
      () =>
        new Promise((resolve) => {
          pendingResolvers.push(() => resolve({ decision: 'allow' }));
        }),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Run commands');
    await flush();
    const options = mockQuery.mock.calls[0]?.[0]?.options;
    const canUseTool = options?.canUseTool;
    const preToolUse = options?.hooks?.PreToolUse;
    const matcher = preToolUse?.find((entry) => entry.matcher === '*');
    const hook = matcher?.hooks[0];
    if (!canUseTool || !hook) {
      throw new Error('Expected both Claude approval callback seams');
    }

    const permissionAbort = new AbortController();
    const permissionResult = canUseTool(
      'Bash',
      { command: 'npm publish' },
      {
        signal: permissionAbort.signal,
        toolUseID: 'permission-tool',
        requestId: 'permission-request',
      },
    );
    permissionAbort.abort();
    expect(mockApprovalInvalidatePending).toHaveBeenCalledTimes(1);
    pendingResolvers.shift()?.();
    await expect(permissionResult).resolves.toEqual({
      behavior: 'deny',
      message: 'Approval request cancelled; denied by default.',
    });

    const hookAbort = new AbortController();
    const hookResult = hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        tool_name: 'Bash',
        tool_input: { command: 'npm publish' },
        tool_use_id: 'hook-tool',
      },
      'hook-tool',
      { signal: hookAbort.signal },
    );
    hookAbort.abort();
    expect(mockApprovalInvalidatePending).toHaveBeenCalledTimes(2);
    pendingResolvers.shift()?.();
    await expect(hookResult).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Approval request cancelled; denied by default.',
      },
    });

    await session.destroy();
  });

  it('requires every bounded WebSearch domain to pass network approval', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    mockApprovalCheck
      .mockResolvedValueOnce({ decision: 'allow' })
      .mockResolvedValueOnce({
        decision: 'deny',
        message: 'Blocked network domain.',
      });

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Search two domains');
    await flush();
    const canUseTool = (
      mockQuery.mock.calls as Array<
        [
          {
            options?: {
              canUseTool?: (
                toolName: string,
                input: Record<string, unknown>,
                options: { toolUseID?: string },
              ) => Promise<unknown>;
            };
          },
        ]
      >
    )[0]?.[0]?.options?.canUseTool;
    if (!canUseTool) {
      throw new Error('Expected Claude query to expose canUseTool');
    }

    await expect(
      canUseTool(
        'WebSearch',
        {
          query: 'release notes',
          allowed_domains: ['docs.example.com', 'support.example.com'],
        },
        { toolUseID: 'tool-use-search' },
      ),
    ).resolves.toEqual({
      behavior: 'deny',
      message: 'Blocked network domain.',
    });
    expect(mockApprovalCheck).toHaveBeenNthCalledWith(
      1,
      { kind: 'network', host: 'docs.example.com' },
      expect.objectContaining({ toolUseId: 'tool-use-search' }),
    );
    expect(mockApprovalCheck).toHaveBeenNthCalledWith(
      2,
      { kind: 'network', host: 'support.example.com' },
      expect.objectContaining({ toolUseId: 'tool-use-search' }),
    );

    await session.destroy();
  });

  it('passes the SDK subagent id through to the approval check as subagentId', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    mockApprovalCheck.mockResolvedValue({ decision: 'allow' });

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Run a command');
    await flush();

    const calls = mockQuery.mock.calls as Array<
      [
        {
          options?: {
            canUseTool?: (
              toolName: string,
              input: Record<string, unknown>,
              options: { toolUseID?: string; agentID?: string },
            ) => Promise<unknown>;
          };
        },
      ]
    >;
    const canUseTool = calls[0]?.[0]?.options?.canUseTool;
    if (!canUseTool) {
      throw new Error('Expected Claude query to expose canUseTool');
    }

    // Mirrors the SDK's `CanUseTool` third-arg shape when a tool call is
    // routed through a subagent's context (`options.agentID`).
    await canUseTool(
      'Bash',
      { command: 'ls' },
      { toolUseID: 'tool-use-subagent', agentID: 'agent-42' },
    );

    expect(mockApprovalCheck).toHaveBeenCalledWith(
      { kind: 'command', command: 'ls', cwd: '/tmp/repo' },
      expect.objectContaining({
        toolUseId: 'tool-use-subagent',
        subagentId: 'agent-42',
      }),
    );

    await session.destroy();
  });

  it('omits subagentId from the approval check when the SDK call has no agentID', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    mockApprovalCheck.mockResolvedValue({ decision: 'allow' });

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Run a command');
    await flush();

    const calls = mockQuery.mock.calls as Array<
      [
        {
          options?: {
            canUseTool?: (
              toolName: string,
              input: Record<string, unknown>,
              options: { toolUseID?: string },
            ) => Promise<unknown>;
          };
        },
      ]
    >;
    const canUseTool = calls[0]?.[0]?.options?.canUseTool;
    if (!canUseTool) {
      throw new Error('Expected Claude query to expose canUseTool');
    }

    await canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tool-use-root' });

    const approvalCheckCalls = mockApprovalCheck.mock.calls as Array<
      [ApprovalCheck, ApprovalCheckDisplay]
    >;
    expect(approvalCheckCalls).toHaveLength(1);
    expect(approvalCheckCalls[0]?.[1].subagentId).toBeUndefined();

    await session.destroy();
  });

  it('prefers the adapter Skill title over the SDK permission title', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    mockApprovalCheck.mockResolvedValue({ decision: 'allow' });

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Use a skill');
    await flush();

    const canUseTool = mockQuery.mock.calls[0]?.[0]?.options?.canUseTool;
    if (!canUseTool) {
      throw new Error('Expected Claude query to expose canUseTool');
    }

    await canUseTool(
      'Skill',
      { skill: 'dataviz' },
      {
        toolUseID: 'tool-use-skill',
        requestId: 'tool-use-skill-request',
        signal: new AbortController().signal,
        title: 'SDK wants to use Skill',
      },
    );

    expect(mockApprovalCheck).toHaveBeenCalledWith(
      { kind: 'tool', toolName: 'Skill' },
      expect.objectContaining({
        title: 'Claude wants to use skill dataviz',
        details: { kind: 'tool', toolName: 'dataviz' },
        suggestedTarget: { kind: 'tool', toolName: 'Skill' },
        toolUseId: 'tool-use-skill',
      }),
    );

    await session.destroy();
  });

  it('deduplicates approval checks for the same tool use across SDK permission seams', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    mockApprovalCheck.mockResolvedValue({ decision: 'allow' });

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Run a command');
    await flush();

    const options = mockQuery.mock.calls[0]?.[0]?.options;
    const canUseTool = options?.canUseTool;
    const preToolUse = options?.hooks?.PreToolUse;
    const hook = preToolUse?.find((entry) => entry.matcher === '*')?.hooks[0];
    if (!canUseTool || !hook) {
      throw new Error('Expected both Claude approval callback seams');
    }

    const permissionResult = await canUseTool(
      'Bash',
      { command: 'touch duplicate-check' },
      {
        toolUseID: 'shared-tool-use',
        requestId: 'shared-tool-use-request',
        signal: new AbortController().signal,
      },
    );
    const hookResult = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        tool_name: 'Bash',
        tool_input: { command: 'touch duplicate-check' },
        tool_use_id: 'shared-tool-use',
      },
      'shared-tool-use',
      { signal: new AbortController().signal },
    );

    expect(permissionResult).toEqual({ behavior: 'allow' });
    expect(hookResult).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          'Approved by the application approval policy.',
      },
    });
    expect(mockApprovalCheck).toHaveBeenCalledTimes(1);

    await session.destroy();
  });

  it('disables RTK rewrites for later turns when the session flag is turned off', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();
    await session.setRtkEnabled?.(false);

    const calls = mockQuery.mock.calls as Array<
      [
        {
          options?: {
            hooks?: {
              PreToolUse?: Array<{
                hooks: Array<
                  (
                    input: {
                      hook_event_name: string;
                      tool_name: string;
                      tool_input: Record<string, unknown>;
                    },
                    toolUseId: string | undefined,
                    hookOptions: { signal: AbortSignal },
                  ) => Promise<unknown>
                >;
              }>;
            };
          };
        },
      ]
    >;
    const hook = calls[0]?.[0]?.options?.hooks?.PreToolUse?.[0]?.hooks?.[0];
    if (!hook) {
      throw new Error('Expected PreToolUse hook');
    }

    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
      },
      undefined,
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({ continue: true });

    await session.destroy();
  });

  it('reports session cron hooks to the session manager', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();
    const hooks = mockQuery.mock.calls[0]?.[0]?.options?.hooks;
    const preToolUse = hooks?.PreToolUse?.find(
      (entry) => entry.matcher === 'CronCreate|ScheduleWakeup',
    )?.hooks[0];
    const postToolUse = hooks?.PostToolUse?.find(
      (entry) => entry.matcher === 'CronCreate|CronDelete',
    )?.hooks[0];
    const stop = hooks?.Stop?.[0]?.hooks[0];
    if (!preToolUse || !postToolUse || !stop) {
      throw new Error('Expected Claude session cron hooks');
    }
    const signal = { signal: new AbortController().signal };
    const base = {
      session_id: 'session',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp/repo',
    };
    const created = {
      ...base,
      hook_event_name: 'PreToolUse' as const,
      tool_name: 'CronCreate',
      tool_input: { cron: '*/5 * * * *', prompt: 'check CI' },
      tool_use_id: 'cron-1',
    };
    const stopped = {
      ...base,
      hook_event_name: 'Stop' as const,
      stop_hook_active: false,
      session_crons: [
        { id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'p' },
      ],
    };
    await expect(preToolUse(created, 'cron-1', signal)).resolves.toEqual({
      continue: true,
    });
    await expect(stop(stopped, undefined, signal)).resolves.toEqual({
      continue: true,
    });

    expect(
      jest.mocked(recordClaudeSessionCronHookInput),
    ).toHaveBeenNthCalledWith(1, 'project/worktree/chat', created);
    expect(
      jest.mocked(recordClaudeSessionCronHookInput),
    ).toHaveBeenNthCalledWith(2, 'project/worktree/chat', stopped);

    await session.destroy();
  });

  it('enforces approval policy in PreToolUse before SDK permission classification', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    mockApprovalCheck.mockResolvedValue({
      decision: 'deny',
      message: 'Blocked by a configured deny rule.',
    });

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();
    const preToolUse = mockQuery.mock.calls[0]?.[0]?.options?.hooks?.PreToolUse;
    const matcher = preToolUse?.find((entry) => entry.matcher === '*');
    const hook = matcher?.hooks[0];
    if (!hook) {
      throw new Error('Expected authoritative PreToolUse approval hook');
    }

    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        tool_name: 'Bash',
        tool_input: { command: 'echo safe-looking' },
        tool_use_id: 'tool-use-id',
      },
      'tool-use-id',
      { signal: new AbortController().signal },
    );

    expect(mockApprovalCheck).toHaveBeenCalledWith(
      { kind: 'command', command: 'echo safe-looking', cwd: '/tmp/repo' },
      expect.objectContaining({ toolUseId: 'tool-use-id' }),
    );
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Blocked by a configured deny rule.',
      },
    });

    await session.destroy();
  });

  it('steers broad Claude exploration through an available graph and seeds subagents', async () => {
    mockHasCodeGraph.mockReturnValue(true);
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        approvalMode: 'full-access',
        codeGraphToolsAdvertised: true,
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Trace the session architecture');
    await flush();
    const hooks = mockQuery.mock.calls[0]?.[0]?.options?.hooks;
    const preToolUse = hooks?.PreToolUse?.find((entry) => entry.matcher === '*')
      ?.hooks[0];
    const postToolUse = hooks?.PostToolUse?.find(
      (entry) => entry.matcher === '*',
    )?.hooks[0];
    const subagentStart = hooks?.SubagentStart?.[0]?.hooks[0];
    if (!preToolUse || !postToolUse || !subagentStart) {
      throw new Error('Expected Claude graph-steering hooks');
    }

    await expect(
      preToolUse(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'Grep',
          tool_input: { pattern: 'createSession', path: '/tmp/repo/src' },
          tool_use_id: 'grep-1',
        },
        'grep-1',
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
        additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      },
    });

    await expect(
      preToolUse(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'mcp__canopy__GetCodeGraphContext',
          tool_input: null,
          tool_use_id: 'malformed-graph-1',
        },
        'malformed-graph-1',
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await expect(
      preToolUse(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'Glob',
          tool_input: { pattern: '**/*.ts', path: '/tmp/repo' },
          tool_use_id: 'glob-after-malformed',
        },
        'glob-after-malformed',
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      },
    });

    await expect(
      subagentStart(
        {
          hook_event_name: 'SubagentStart',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          agent_id: 'agent-1',
          agent_type: 'Explore',
        },
        undefined,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      },
    });

    await preToolUse(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        tool_name: 'mcp__canopy__GetCodeGraphContext',
        tool_input: {},
        tool_use_id: 'graph-1',
      },
      'graph-1',
      { signal: new AbortController().signal },
    );
    await expect(
      preToolUse(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'Glob',
          tool_input: { pattern: '**/*.ts', path: '/tmp/repo' },
          tool_use_id: 'glob-before-post',
        },
        'glob-before-post',
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      },
    });
    await postToolUse(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        tool_name: 'mcp__canopy__GetCodeGraphContext',
        tool_input: {},
        tool_response: {},
        tool_use_id: 'graph-1',
      },
      'graph-1',
      { signal: new AbortController().signal },
    );
    await expect(
      preToolUse(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'Glob',
          tool_input: { pattern: '**/*.ts', path: '/tmp/repo' },
          tool_use_id: 'glob-1',
        },
        'glob-1',
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ continue: true });

    expect(mockHasCodeGraph).toHaveBeenCalledWith('project', 'worktree');
    await session.destroy();
  });

  it('steers shell-expanded Bash scopes before graph orientation', async () => {
    mockHasCodeGraph.mockReturnValue(true);
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        approvalMode: 'full-access',
        codeGraphToolsAdvertised: true,
      },
      jest.fn(),
      getNoWindow,
    );
    session.sendMessage('Find the log line');
    await flush();
    const preToolUse =
      mockQuery.mock.calls[0]?.[0]?.options?.hooks?.PreToolUse?.find(
        (entry) => entry.matcher === '*',
      )?.hooks[0];
    if (!preToolUse) {
      throw new Error('Expected the Claude graph-steering hook');
    }
    const runBash = (command: string, id: string): Promise<unknown> =>
      preToolUse(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'Bash',
          tool_input: { command },
          tool_use_id: id,
        },
        id,
        { signal: new AbortController().signal },
      );

    for (const command of [
      "rg foo -g '*.log' $(git ls-files)",
      "rg foo -g '*.log' src/*",
      'rg foo *.log',
      // The subshell, failed or skipped `cd` leaves `rg foo src` in the
      // worktree.
      '(cd /opt && rg x .); rg foo src',
      'cd /missing; rg foo src',
      'true || cd /opt && rg foo src',
    ]) {
      await expect(runBash(command, command)).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
          additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
        },
      });
    }
    await expect(
      runBash('grep foo .playwright/run-1/*.log', 'bash-artifact'),
    ).resolves.toEqual({ continue: true });
    await expect(
      runBash('cd /opt && rg foo .', 'bash-outside'),
    ).resolves.toEqual({ continue: true });

    await session.destroy();
  });

  it('keeps successful graph orientation for a chat across later turns', async () => {
    mockHasCodeGraph.mockReturnValue(true);
    mockLoadCachedInventory.mockResolvedValue(null);
    const graphIdentity = 'graph-v1';
    const headIdentity = 'head-v1';
    setClaudeCodeGraphOrientationReadersForTests({
      resolveRepositoryRoots: () => Promise.resolve(['/tmp/repo']),
      readGraphIdentity: () =>
        Promise.resolve({ instance: 'graph-db', content: graphIdentity }),
      readHeadIdentity: () => Promise.resolve(headIdentity),
      readBuildStamp: () => Promise.resolve('1001'),
    });

    let finishTurns = (): void => undefined;
    const turnsFinished = new Promise<void>((resolve) => {
      finishTurns = resolve;
    });
    let firstSearchResult: unknown;
    let secondSearchResult: unknown;
    mockQuery.mockImplementation((params) => {
      async function* respondToTwoTurns(): AsyncGenerator<unknown, void> {
        if (typeof params.prompt === 'string') {
          throw new Error('Expected the streaming Claude prompt');
        }
        const prompts = params.prompt[Symbol.asyncIterator]();
        const preToolUse = params.options?.hooks?.PreToolUse?.find(
          (entry) => entry.matcher === '*',
        )?.hooks[0];
        const postToolUse = params.options?.hooks?.PostToolUse?.find(
          (entry) => entry.matcher === '*',
        )?.hooks[0];
        if (!preToolUse || !postToolUse) {
          throw new Error('Expected Claude graph orientation hooks');
        }
        await prompts.next();
        firstSearchResult = await preToolUse(
          {
            hook_event_name: 'PreToolUse',
            session_id: 'session',
            transcript_path: '/tmp/transcript.jsonl',
            cwd: '/tmp/repo',
            tool_name: 'Grep',
            tool_input: { pattern: 'createSession', path: '/tmp/repo/src' },
            tool_use_id: 'first-turn-search',
          },
          'first-turn-search',
          { signal: new AbortController().signal },
        );
        await preToolUse(
          {
            hook_event_name: 'PreToolUse',
            session_id: 'session',
            transcript_path: '/tmp/transcript.jsonl',
            cwd: '/tmp/repo',
            tool_name: 'mcp__canopy__GetCodeGraphContext',
            tool_input: {},
            tool_use_id: 'graph-success',
          },
          'graph-success',
          { signal: new AbortController().signal },
        );
        await postToolUse(
          {
            hook_event_name: 'PostToolUse',
            session_id: 'session',
            transcript_path: '/tmp/transcript.jsonl',
            cwd: '/tmp/repo',
            tool_name: 'mcp__canopy__GetCodeGraphContext',
            tool_input: {},
            tool_response: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ status: 'ok', lastBuildAt: 1001 }),
                },
              ],
            },
            tool_use_id: 'graph-success',
          },
          'graph-success',
          { signal: new AbortController().signal },
        );
        await prompts.next();
        secondSearchResult = await preToolUse(
          {
            hook_event_name: 'PreToolUse',
            session_id: 'session',
            transcript_path: '/tmp/transcript.jsonl',
            cwd: '/tmp/repo',
            tool_name: 'Grep',
            tool_input: { pattern: 'createSession', path: '/tmp/repo/src' },
            tool_use_id: 'second-turn-search',
          },
          'second-turn-search',
          { signal: new AbortController().signal },
        );
        yield { type: 'result', is_error: false, result: 'second turn' };
        finishTurns();
      }
      return respondToTwoTurns();
    });

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'persistent-orientation',
        approvalMode: 'full-access',
        codeGraphToolsAdvertised: true,
      },
      jest.fn(),
      getNoWindow,
    );

    try {
      session.sendMessage('First turn');
      session.sendMessage('Second turn');
      await flush();
      await turnsFinished;
      expect(firstSearchResult).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(secondSearchResult).toEqual({ continue: true });
    } finally {
      await session.destroy();
    }
  });

  it('revalidates native graph orientation against chat and graph identities', async () => {
    mockHasCodeGraph.mockReturnValue(true);
    let graphIdentity = 'graph-v1';
    let headIdentity = 'head-v1';
    let repositoryRoots: readonly string[] = ['/tmp/repo'];
    // A graph rebuild stamps a new build.
    const buildStamp = (): number =>
      graphIdentity === 'graph-v1' ? 1001 : 1002;
    setClaudeCodeGraphOrientationReadersForTests({
      resolveRepositoryRoots: () => Promise.resolve(repositoryRoots),
      readGraphIdentity: () =>
        Promise.resolve({ instance: 'graph-db', content: graphIdentity }),
      readHeadIdentity: () => Promise.resolve(headIdentity),
      readBuildStamp: () => Promise.resolve(String(buildStamp())),
    });
    const provider = new ClaudeCodeProvider();

    type CapturedHook = (
      input: HookInput,
      toolUseId: string | undefined,
      hookOptions: { signal: AbortSignal },
    ) => Promise<HookJSONOutput>;
    const openSession = async (
      chatId: string,
    ): Promise<{
      session: ReturnType<ClaudeCodeProvider['createSession']>;
      preToolUse: CapturedHook;
      postToolUse: CapturedHook;
    }> => {
      mockQuery.mockImplementation(() =>
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId,
          approvalMode: 'full-access',
          codeGraphToolsAdvertised: true,
        },
        jest.fn(),
        getNoWindow,
      );
      session.sendMessage('Inspect the repository');
      await flush();
      const hooks = mockQuery.mock.calls.at(-1)?.[0]?.options?.hooks;
      const preToolUse = hooks?.PreToolUse?.find(
        (entry) => entry.matcher === '*',
      )?.hooks[0];
      const postToolUse = hooks?.PostToolUse?.find(
        (entry) => entry.matcher === '*',
      )?.hooks[0];
      if (!preToolUse || !postToolUse) {
        throw new Error('Expected Claude graph orientation hooks');
      }
      return { session, preToolUse, postToolUse };
    };
    const search = (
      preToolUse: CapturedHook,
      toolUseId: string,
    ): Promise<HookJSONOutput> =>
      preToolUse(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'Grep',
          tool_input: { pattern: 'createSession', path: '/tmp/repo/src' },
          tool_use_id: toolUseId,
        },
        toolUseId,
        { signal: new AbortController().signal },
      );
    const orient = async (
      hooks: { preToolUse: CapturedHook; postToolUse: CapturedHook },
      toolUseId: string,
      toolResponse: Record<string, unknown> = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ status: 'ok', lastBuildAt: buildStamp() }),
          },
        ],
      },
    ): Promise<HookJSONOutput> => {
      await hooks.preToolUse(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'mcp__canopy__GetCodeGraphContext',
          tool_input: {},
          tool_use_id: toolUseId,
        },
        toolUseId,
        { signal: new AbortController().signal },
      );
      return hooks.postToolUse(
        {
          hook_event_name: 'PostToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'mcp__canopy__GetCodeGraphContext',
          tool_input: {},
          tool_response: toolResponse,
          tool_use_id: toolUseId,
        },
        toolUseId,
        { signal: new AbortController().signal },
      );
    };

    const first = await openSession('identity-chat');
    await expect(
      search(first.preToolUse, 'first-search'),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await orient(first, 'orient-first');
    await first.session.destroy();

    const sameIdentity = await openSession('identity-chat');
    await expect(
      search(sameIdentity.preToolUse, 'same-identity-search'),
    ).resolves.toEqual({ continue: true });
    await sameIdentity.session.destroy();

    const otherChat = await openSession('other-chat');
    await expect(
      search(otherChat.preToolUse, 'other-chat-search'),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await otherChat.session.destroy();

    headIdentity = 'head-v2';
    const changedHead = await openSession('identity-chat');
    await expect(
      search(changedHead.preToolUse, 'changed-head-search'),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await orient(changedHead, 'orient-new-head');
    await changedHead.session.destroy();

    const reoriented = await openSession('identity-chat');
    await expect(
      search(reoriented.preToolUse, 'reoriented-search'),
    ).resolves.toEqual({ continue: true });
    await reoriented.session.destroy();

    repositoryRoots = ['/tmp/repo', '/tmp/repo/repos/added'];
    const addedRepository = await openSession('identity-chat');
    await expect(
      search(addedRepository.preToolUse, 'added-repository-search'),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await orient(addedRepository, 'orient-added-repository');
    await addedRepository.session.destroy();

    repositoryRoots = ['/tmp/repo/repos/added', '/tmp/repo'];
    const reorderedRepositories = await openSession('identity-chat');
    await expect(
      search(reorderedRepositories.preToolUse, 'reordered-repositories-search'),
    ).resolves.toEqual({ continue: true });
    await reorderedRepositories.session.destroy();

    graphIdentity = 'graph-v2';
    const changedGraph = await openSession('identity-chat');
    await expect(
      search(changedGraph.preToolUse, 'changed-graph-search'),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await changedGraph.session.destroy();

    const erroredChat = await openSession('error-chat');
    await orient(erroredChat, 'error-graph-call', {
      isError: true,
    });
    await erroredChat.session.destroy();
    const afterError = await openSession('error-chat');
    await expect(
      search(afterError.preToolUse, 'search-after-error'),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await afterError.session.destroy();
  });

  it('binds native build orientation to the stamp its answer reported', async () => {
    mockHasCodeGraph.mockReturnValue(true);
    let graph = 'graph-v1';
    let stamp = '1001';
    setClaudeCodeGraphOrientationReadersForTests({
      resolveRepositoryRoots: () => Promise.resolve(['/tmp/repo']),
      readGraphIdentity: () =>
        Promise.resolve({ instance: 'graph-db', content: graph }),
      readHeadIdentity: () => Promise.resolve('head-v1'),
      readBuildStamp: () => Promise.resolve(stamp),
    });
    const provider = new ClaudeCodeProvider();
    type CapturedHook = (
      input: HookInput,
      toolUseId: string | undefined,
      hookOptions: { signal: AbortSignal },
    ) => Promise<HookJSONOutput>;
    const openSession = async (): Promise<{
      session: ReturnType<ClaudeCodeProvider['createSession']>;
      preToolUse: CapturedHook;
      postToolUse: CapturedHook;
    }> => {
      mockQuery.mockImplementation(() =>
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'stamp-chat',
          approvalMode: 'full-access',
          codeGraphToolsAdvertised: true,
        },
        jest.fn(),
        getNoWindow,
      );
      session.sendMessage('Inspect the repository');
      await flush();
      const hooks = mockQuery.mock.calls.at(-1)?.[0]?.options?.hooks;
      const preToolUse = hooks?.PreToolUse?.find(
        (entry) => entry.matcher === '*',
      )?.hooks[0];
      const postToolUse = hooks?.PostToolUse?.find(
        (entry) => entry.matcher === '*',
      )?.hooks[0];
      if (!preToolUse || !postToolUse) {
        throw new Error('Expected Claude graph orientation hooks');
      }
      return { session, preToolUse, postToolUse };
    };
    const hookInput = (
      eventName: 'PreToolUse' | 'PostToolUse',
      toolName: string,
      toolUseId: string,
      extra: Record<string, unknown>,
    ): HookInput =>
      ({
        hook_event_name: eventName,
        session_id: 'session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        tool_name: toolName,
        tool_use_id: toolUseId,
        ...extra,
      }) as HookInput;
    const signal = { signal: new AbortController().signal };
    const search = (
      preToolUse: CapturedHook,
      toolUseId: string,
    ): Promise<HookJSONOutput> =>
      preToolUse(
        hookInput('PreToolUse', 'Grep', toolUseId, {
          tool_input: { pattern: 'createSession', path: '/tmp/repo/src' },
        }),
        toolUseId,
        signal,
      );
    const build = async (
      hooks: { preToolUse: CapturedHook; postToolUse: CapturedHook },
      toolUseId: string,
      publish: () => void,
      lastBuildAt: number,
    ): Promise<void> => {
      const toolName = 'mcp__canopy__BuildOrUpdateCodeGraph';
      await hooks.preToolUse(
        hookInput('PreToolUse', toolName, toolUseId, { tool_input: {} }),
        toolUseId,
        signal,
      );
      publish();
      await hooks.postToolUse(
        hookInput('PostToolUse', toolName, toolUseId, {
          tool_input: {},
          tool_response: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ status: 'ok', lastBuildAt }),
              },
            ],
          },
        }),
        toolUseId,
        signal,
      );
    };

    const raced = await openSession();
    await build(
      raced,
      'build-raced',
      () => {
        // Own build answers 1002; a foreign build publishes 1003 before
        // PostToolUse records.
        graph = 'graph-v3';
        stamp = '1003';
      },
      1002,
    );
    await expect(search(raced.preToolUse, 'after-race')).resolves.toMatchObject(
      { hookSpecificOutput: { permissionDecision: 'deny' } },
    );

    await build(
      raced,
      'build-own',
      () => {
        graph = 'graph-v4';
        stamp = '1004';
      },
      1004,
    );
    await raced.session.destroy();
    const nextInvocation = await openSession();
    await expect(
      search(nextInvocation.preToolUse, 'after-own-build'),
    ).resolves.toEqual({ continue: true });
    await nextInvocation.session.destroy();
  });

  it('orients later native turns on a first build that created the graph', async () => {
    let graphExists = false;
    setClaudeCodeGraphOrientationReadersForTests({
      resolveRepositoryRoots: () => Promise.resolve(['/tmp/repo']),
      readGraphIdentity: () =>
        Promise.resolve(
          graphExists
            ? { instance: 'graph-db', content: 'graph-v1' }
            : 'absent',
        ),
      readHeadIdentity: () => Promise.resolve('head-v1'),
      readBuildStamp: () => Promise.resolve(graphExists ? '1001' : null),
    });
    const provider = new ClaudeCodeProvider();
    type CapturedHook = (
      input: HookInput,
      toolUseId: string | undefined,
      hookOptions: { signal: AbortSignal },
    ) => Promise<HookJSONOutput>;
    const openSession = async (
      chatId: string,
    ): Promise<{
      session: ReturnType<ClaudeCodeProvider['createSession']>;
      preToolUse: CapturedHook;
      postToolUse: CapturedHook;
    }> => {
      mockQuery.mockImplementation(() =>
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId,
          approvalMode: 'full-access',
          codeGraphToolsAdvertised: true,
        },
        jest.fn(),
        getNoWindow,
      );
      session.sendMessage('Build the graph');
      await flush();
      const hooks = mockQuery.mock.calls.at(-1)?.[0]?.options?.hooks;
      const preToolUse = hooks?.PreToolUse?.find(
        (entry) => entry.matcher === '*',
      )?.hooks[0];
      const postToolUse = hooks?.PostToolUse?.find(
        (entry) => entry.matcher === '*',
      )?.hooks[0];
      if (!preToolUse || !postToolUse) {
        throw new Error('Expected Claude graph orientation hooks');
      }
      return { session, preToolUse, postToolUse };
    };
    const hookInput = (
      eventName: 'PreToolUse' | 'PostToolUse',
      toolName: string,
      toolUseId: string,
      extra: Record<string, unknown>,
    ): HookInput =>
      ({
        hook_event_name: eventName,
        session_id: 'session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        tool_name: toolName,
        tool_use_id: toolUseId,
        ...extra,
      }) as HookInput;
    const signal = { signal: new AbortController().signal };
    const firstBuild = async (
      chatId: string,
      toolResponse: unknown,
    ): Promise<void> => {
      graphExists = false;
      mockHasCodeGraph.mockReturnValue(false);
      const { session, preToolUse, postToolUse } = await openSession(chatId);
      const toolName = 'mcp__canopy__BuildOrUpdateCodeGraph';
      await preToolUse(
        hookInput('PreToolUse', toolName, 'first-build', { tool_input: {} }),
        'first-build',
        signal,
      );
      graphExists = true;
      await postToolUse(
        hookInput('PostToolUse', toolName, 'first-build', {
          tool_input: {},
          tool_response: toolResponse,
        }),
        'first-build',
        signal,
      );
      await session.destroy();
    };
    const searchNextTurn = async (chatId: string): Promise<HookJSONOutput> => {
      mockHasCodeGraph.mockReturnValue(true);
      const { session, preToolUse } = await openSession(chatId);
      try {
        return await preToolUse(
          hookInput('PreToolUse', 'Grep', 'next-turn-search', {
            tool_input: { pattern: 'createSession', path: '/tmp/repo/src' },
          }),
          'next-turn-search',
          signal,
        );
      } finally {
        await session.destroy();
      }
    };

    await firstBuild('first-build-chat', {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ status: 'ok', lastBuildAt: 1001 }),
        },
      ],
    });
    await expect(searchNextTurn('first-build-chat')).resolves.toEqual({
      continue: true,
    });

    await firstBuild('failed-build-chat', { content: [], isError: true });
    await expect(searchNextTurn('failed-build-chat')).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('allows plan-mode graph exploration under Full Access', async () => {
    mockHasCodeGraph.mockReturnValue(true);
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'plan-graph-chat',
        approvalMode: 'full-access',
        planMode: true,
        codeGraphToolsAdvertised: true,
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Trace the session architecture');
    await flush();
    const hooks = mockQuery.mock.calls[0]?.[0]?.options?.hooks;
    const preToolUse = hooks?.PreToolUse;
    const hook = preToolUse?.find((entry) => entry.matcher === '*')?.hooks[0];
    const postToolUse = hooks?.PostToolUse?.find(
      (entry) => entry.matcher === '*',
    )?.hooks[0];
    if (!hook || !postToolUse) {
      throw new Error('Expected graph lifecycle hooks');
    }

    await expect(
      hook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'mcp__canopy__GetCodeGraphContext',
          tool_input: {},
          tool_use_id: 'graph-plan',
        },
        'graph-plan',
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });

    await postToolUse(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        tool_name: 'mcp__canopy__GetCodeGraphContext',
        tool_input: {},
        tool_response: {},
        tool_use_id: 'graph-plan',
      },
      'graph-plan',
      { signal: new AbortController().signal },
    );

    await expect(
      hook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'Grep',
          tool_input: { pattern: 'createSession', path: '/tmp/repo/src' },
          tool_use_id: 'grep-plan',
        },
        'grep-plan',
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });

    await session.destroy();
  });

  it('does not count a denied native graph call as orientation', async () => {
    mockHasCodeGraph.mockReturnValue(true);
    mockApprovalCheck
      .mockResolvedValueOnce({
        decision: 'deny',
        message: 'Graph access denied.',
      })
      .mockResolvedValueOnce({ decision: 'allow' });
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'denied-graph-chat',
        approvalMode: 'ask',
        codeGraphToolsAdvertised: true,
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Trace the session architecture');
    await flush();
    const hook = mockQuery.mock.calls[0]?.[0]?.options?.hooks?.PreToolUse?.find(
      (entry) => entry.matcher === '*',
    )?.hooks[0];
    if (!hook) {
      throw new Error('Expected authoritative PreToolUse hook');
    }

    await expect(
      hook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'mcp__canopy__GetCodeGraphContext',
          tool_input: {},
          tool_use_id: 'graph-denied',
        },
        'graph-denied',
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'Graph access denied.',
      },
    });
    await expect(
      hook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
          tool_name: 'Grep',
          tool_input: { pattern: 'createSession', path: '/tmp/repo/src' },
          tool_use_id: 'grep-after-denied-graph',
        },
        'grep-after-denied-graph',
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'allow',
        permissionDecisionReason:
          'Approved by the application approval policy.',
        additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      },
    });
    expect(mockApprovalCheck).toHaveBeenCalledTimes(2);

    await session.destroy();
  });

  it('stops the turn when PreToolUse approval requests an interrupt', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    mockApprovalCheck.mockResolvedValue({
      decision: 'deny',
      message: 'Denied by the user.',
      stopTurn: true,
    });

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();
    const preToolUse = mockQuery.mock.calls[0]?.[0]?.options?.hooks?.PreToolUse;
    const matcher = preToolUse?.find((entry) => entry.matcher === '*');
    const hook = matcher?.hooks[0];
    if (!hook) {
      throw new Error('Expected authoritative PreToolUse approval hook');
    }

    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        tool_name: 'Bash',
        tool_input: { command: 'echo safe-looking' },
        tool_use_id: 'tool-use-id',
      },
      'tool-use-id',
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({
      continue: false,
      stopReason: 'Denied by the user.',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Denied by the user.',
      },
    });

    await session.destroy();
  });

  it('enforces approval policy for read-only tools in plan mode', async () => {
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    mockApprovalCheck.mockResolvedValue({
      decision: 'deny',
      message: 'Network access denied by a configured rule.',
    });

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'plan-mode-chat',
        planMode: true,
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();
    const preToolUse = mockQuery.mock.calls[0]?.[0]?.options?.hooks?.PreToolUse;
    const matcher = preToolUse?.find((entry) => entry.matcher === '*');
    const hook = matcher?.hooks[0];
    if (!hook) {
      throw new Error('Expected authoritative PreToolUse approval hook');
    }

    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        tool_name: 'WebFetch',
        tool_input: { url: 'https://denied.example/path' },
        tool_use_id: 'plan-tool-use-id',
      },
      'plan-tool-use-id',
      { signal: new AbortController().signal },
    );

    expect(mockApprovalCheck).toHaveBeenCalledWith(
      { kind: 'network', host: 'denied.example' },
      expect.objectContaining({ toolUseId: 'plan-tool-use-id' }),
    );
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Network access denied by a configured rule.',
      },
    });

    await session.destroy();
  });

  it('emits an error and unregisters the session when startup preparation fails', async () => {
    const onEvent = jest.fn();
    const provider = new ClaudeCodeProvider({
      providerType: 'ollama',
      prepareInvocation: jest
        .fn()
        .mockRejectedValue(new Error('Ollama unavailable')),
    });

    provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );

    await flush();

    expect(mockQuery).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        error: 'Ollama unavailable',
        [CHILD_TOOL_LIVENESS_STAMP]: { kind: 'no-live-session' },
      }),
    );
    expect(mockedUnregisterSession).toHaveBeenCalledWith(
      'project/worktree/chat',
    );
  });

  it('uses the latest approval mode when it changes during startup', async () => {
    mockQuery.mockReturnValue(
      makeQueryResult([{ type: 'result', is_error: false, result: 'done' }]),
    );
    let resolvePreparation:
      | ((value: { providerType: 'claude' }) => void)
      | undefined;
    const provider = new ClaudeCodeProvider({
      prepareInvocation: jest.fn(
        () =>
          new Promise<{ providerType: 'claude' }>((resolve) => {
            resolvePreparation = resolve;
          }),
      ),
    });
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'startup-mode-change',
        approvalMode: 'full-access',
      },
      jest.fn(),
      getNoWindow,
    );

    await session.setApprovalMode('ask');
    resolvePreparation?.({ providerType: 'claude' });
    await flush();

    const options = (
      mockQuery.mock.calls[0]?.[0] as {
        options?: {
          permissionMode?: string;
          allowDangerouslySkipPermissions?: boolean;
        };
      }
    )?.options;
    expect(options?.permissionMode).toBe('default');
    expect(options?.allowDangerouslySkipPermissions).toBeUndefined();
    expect(mockCreateApprovalSession).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'ask' }),
    );

    await session.destroy();
  });

  it('checks approvals against the rule list it was created with, so narrowing that list applies to the live session (CAN-4821)', async () => {
    mockQuery.mockReturnValue(
      makeQueryResult([{ type: 'result', is_error: false, result: 'done' }]),
    );
    const sessionApprovalRules: ApprovalRule[] = [
      {
        id: 'grant',
        behavior: 'allow',
        target: { kind: 'command', pattern: 'npm test' },
        createdAt: '2026-10-23T00:00:00.000Z',
        origin: 'prompt',
      },
    ];
    const provider = new ClaudeCodeProvider({
      prepareInvocation: jest.fn(() =>
        Promise.resolve({ providerType: 'claude' as const }),
      ),
    });
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'live-session-rules',
        approvalMode: 'ask',
        sessionApprovalRules,
      },
      jest.fn(),
      getNoWindow,
    );
    await flush();

    // The same array, not a copy of it.
    const theCreatedRuleList = {
      asymmetricMatch: (actual: unknown): boolean =>
        actual === sessionApprovalRules,
      toString: (): string => 'the rule list the session was created with',
    };
    expect(mockCreateApprovalSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionRules: theCreatedRuleList }),
    );

    await session.destroy();
  });

  it('uses an early plan-mode toggle without overriding full-access approvals', async () => {
    mockQuery.mockReturnValue(
      makeQueryResult([{ type: 'result', is_error: false, result: 'done' }]),
    );
    let resolvePreparation:
      | ((value: { providerType: 'claude' }) => void)
      | undefined;
    const provider = new ClaudeCodeProvider({
      prepareInvocation: jest.fn(
        () =>
          new Promise<{ providerType: 'claude' }>((resolve) => {
            resolvePreparation = resolve;
          }),
      ),
    });
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'startup-plan-mode-change',
        approvalMode: 'full-access',
        planMode: false,
      },
      jest.fn(),
      getNoWindow,
    );

    await session.setPlanMode(true);
    resolvePreparation?.({ providerType: 'claude' });
    await flush();

    const options = mockQuery.mock.calls[0]?.[0]?.options;
    expect(options?.permissionMode).toBe('plan');
    const hook = options?.hooks?.PreToolUse?.find(
      (entry) => entry.matcher === '*',
    )?.hooks[0];
    if (!hook) throw new Error('Expected authoritative PreToolUse hook');
    const hookResult = await hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'session',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/repo',
        tool_name: 'Bash',
        tool_input: { command: 'touch changed.txt' },
        tool_use_id: 'plan-write',
      },
      'plan-write',
      { signal: new AbortController().signal },
    );
    expect(hookResult).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });

    await session.destroy();
  });

  it.each(['ask', 'auto', 'full-access'] as const)(
    'uses the %s session policy for shell, skill, subagent, and MCP tools in plan mode',
    async (approvalMode) => {
      mockQuery.mockReturnValue(
        makeQueryResult([{ type: 'result', is_error: false, result: 'done' }]),
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'plan-approval-tools',
          planMode: true,
          approvalMode,
        },
        jest.fn(),
        getNoWindow,
      );
      await flush();
      const options = mockQuery.mock.calls[0]?.[0]?.options;
      expect(options?.permissionMode).toBe('plan');
      expect(mockCreateApprovalSession).toHaveBeenCalledWith(
        expect.objectContaining({ mode: approvalMode }),
      );
      const hook = options?.hooks?.PreToolUse?.find(
        (entry) => entry.matcher === '*',
      )?.hooks[0];
      if (!hook) throw new Error('Expected approval hook');
      const tools = [
        ['Bash', { command: 'git log -1' }],
        ['Skill', { skill: 'research' }],
        ['Agent', { prompt: 'Inspect the implementation' }],
        ['mcp__canopy__ReadMemory', { file: 'MEMORY.md', scope: 'workspace' }],
        ['mcp__canopy__AskUserQuestion', { questions: [] }],
      ] as const;
      for (const [toolName, toolInput] of tools) {
        for (const decision of ['allow', 'deny'] as const) {
          mockApprovalCheck.mockClear();
          mockApprovalCheck.mockResolvedValue({ decision });
          const toolUseId = `${toolName}-${decision}`;
          const result = await hook(
            {
              hook_event_name: 'PreToolUse',
              session_id: 'session',
              transcript_path: '/tmp/transcript.jsonl',
              cwd: '/tmp/repo',
              tool_name: toolName,
              tool_input: toolInput,
              tool_use_id: toolUseId,
            },
            toolUseId,
            { signal: new AbortController().signal },
          );
          expect(result).toMatchObject({
            hookSpecificOutput: {
              permissionDecision:
                approvalMode === 'full-access' ? 'allow' : decision,
            },
          });
          if (approvalMode === 'full-access') {
            expect(mockApprovalCheck).not.toHaveBeenCalled();
          } else {
            expect(mockApprovalCheck).toHaveBeenCalledTimes(1);
          }
        }
      }
      await session.destroy();
    },
  );

  it('honors Full Access in the native plan permission fallback', async () => {
    mockQuery.mockReturnValue(
      makeQueryResult([{ type: 'result', is_error: false, result: 'done' }]),
    );
    mockApprovalCheck.mockResolvedValue({ decision: 'deny' });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'plan-full-access-fallback',
        planMode: true,
        approvalMode: 'full-access',
      },
      jest.fn(),
      getNoWindow,
    );
    await flush();
    const canUseTool = mockQuery.mock.calls[0]?.[0]?.options?.canUseTool;
    if (!canUseTool) throw new Error('Expected native permission callback');
    const result = await canUseTool(
      'WebSearch',
      { query: 'release notes' },
      {
        signal: new AbortController().signal,
        toolUseID: 'plan-web-search',
        requestId: 'plan-web-search-request',
      },
    );
    expect(result).toEqual({ behavior: 'allow' });
    expect(mockApprovalCheck).not.toHaveBeenCalled();
    await session.destroy();
  });

  it('restores session approval state when the SDK mode update fails', async () => {
    const queryResult = makeQueryResult([
      { type: 'result', is_error: false, result: 'done' },
    ]);
    mockQuery.mockReturnValue(queryResult);
    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'approval-mode-rollback',
        approvalMode: 'ask',
      },
      jest.fn(),
      getNoWindow,
    );
    await flush();

    const updateError = new Error('permission update failed');
    queryResult.setPermissionMode.mockRejectedValueOnce(updateError);

    await expect(session.setApprovalMode('auto')).rejects.toBe(updateError);
    expect(mockApprovalSetMode).toHaveBeenNthCalledWith(1, 'auto');
    expect(mockApprovalSetMode).toHaveBeenNthCalledWith(2, 'ask');

    queryResult.setPermissionMode.mockResolvedValueOnce(undefined);
    await expect(session.setApprovalMode('auto')).resolves.toBeUndefined();
    expect(mockApprovalSetMode).toHaveBeenLastCalledWith('auto');

    await session.destroy();
  });

  it('labels Ollama approval sessions with the active provider', async () => {
    mockQuery.mockReturnValue(
      makeQueryResult([{ type: 'result', is_error: false, result: 'done' }]),
    );
    const provider = new ClaudeCodeProvider({ providerType: 'ollama' });
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ollama-approval-provider',
      },
      jest.fn(),
      getNoWindow,
    );

    await flush();

    expect(mockCreateApprovalSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'ollama' }),
    );

    await session.destroy();
  });

  it('does not request bypass permission when leaving plan mode on an ask-launched query', async () => {
    const queryResult = makeQueryResult([
      { type: 'result', is_error: false, result: 'done' },
    ]);
    mockQuery.mockReturnValue(queryResult);
    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'plan-to-full-access',
        approvalMode: 'ask',
        planMode: true,
      },
      jest.fn(),
      getNoWindow,
    );
    await flush();

    await session.setApprovalMode('full-access');
    await session.setPlanMode(false);

    expect(queryResult.setPermissionMode).not.toHaveBeenCalledWith(
      'bypassPermissions',
    );
    await session.destroy();
  });

  it('preserves the typed Ollama-unavailable code on startup errors', async () => {
    const onEvent = jest.fn();
    const startupError = Object.assign(new Error('Ollama unavailable'), {
      code: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
    });
    const provider = new ClaudeCodeProvider({
      providerType: 'ollama',
      prepareInvocation: jest.fn().mockRejectedValue(startupError),
    });

    provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );

    await flush();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        error: 'Ollama unavailable',
        error_code: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
        provider: 'ollama',
        [CHILD_TOOL_LIVENESS_STAMP]: { kind: 'no-live-session' },
      }),
    );
  });

  it('runs Ollama sessions without applying the Claude unavailable-model backstop', async () => {
    initOllamaModels([
      {
        id: 'ollama-llama3:8b',
        rawModelId: 'llama3:8b',
        label: 'Llama 3 8B',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    mockResolveClaudeCompatibleInvocation.mockResolvedValue({
      providerType: 'ollama',
      sdkModel: 'llama3:8b',
      envOverride: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
      },
    });
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const onEvent = jest.fn();
    const provider = new OllamaProvider();
    provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'ollama-llama3:8b',
      },
      onEvent,
      getNoWindow,
    );

    await flush();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        error:
          'This model is no longer available. Pick another model to continue.',
      }),
    );
  });

  it('holds an Ollama delegate stream at its routed sink and drains ordered events after release', async () => {
    initOllamaModels([
      {
        id: 'ollama-llama3:8b',
        rawModelId: 'llama3:8b',
        label: 'Llama 3 8B',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    mockResolveClaudeCompatibleInvocation.mockResolvedValue({
      providerType: 'ollama',
      sdkModel: 'llama3:8b',
      envOverride: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' },
    });
    const count = 512;
    let pulled = 0;
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          for (let index = 0; index < count; index += 1) {
            pulled += 1;
            yield {
              type: 'assistant',
              message: {
                id: `ollama-pressure-${index}`,
                role: 'assistant',
                content: [
                  { type: 'text', text: `${index}:${'x'.repeat(2048)}` },
                ],
              },
            };
          }
          yield { type: 'result', is_error: false, result: 'complete' };
        })(),
    );
    let releaseSink = (): void => undefined;
    const heldSink = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    let signalFirst = (): void => undefined;
    const first = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const ids: string[] = [];
    const session = new OllamaProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ollama-pressure',
        model: 'ollama-llama3:8b',
      },
      (event) => {
        if (readEventType(event) !== 'assistant') return;
        const message: unknown =
          typeof event === 'object' && event !== null
            ? Reflect.get(event, 'message')
            : undefined;
        const id: unknown =
          typeof message === 'object' && message !== null
            ? Reflect.get(message, 'id')
            : undefined;
        if (typeof id !== 'string') return;
        ids.push(id);
        if (ids.length === 1) {
          signalFirst();
          return heldSink;
        }
      },
      getNoWindow,
    );
    try {
      session.sendMessage('Run Ollama', { userMessageId: 'ollama-user' });
      await first;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(ids).toHaveLength(1);
      // Receipt read-ahead is bounded independently of event admission. The
      // current item may await the sink while at most 256 more events remain
      // queued for ordered admission.
      expect(pulled).toBeGreaterThan(1);
      expect(pulled).toBeLessThanOrEqual(257);
      releaseSink();
      for (
        let attempts = 0;
        attempts < 1000 && ids.length < count;
        attempts += 1
      ) {
        await flush();
      }
      expect(ids).toEqual(
        Array.from({ length: count }, (_, index) => `ollama-pressure-${index}`),
      );
    } finally {
      releaseSink();
      await session.destroy();
    }
  });

  it('can cancel an Ollama delegate while its full receipt queue awaits persistence', async () => {
    initOllamaModels([
      {
        id: 'ollama-llama3:8b',
        rawModelId: 'llama3:8b',
        label: 'Llama 3 8B',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    mockResolveClaudeCompatibleInvocation.mockResolvedValue({
      providerType: 'ollama',
      sdkModel: 'llama3:8b',
      envOverride: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' },
    });
    const receiptQueueFull = createGate();
    let pulled = 0;
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          for (let index = 0; index < 512; index += 1) {
            pulled += 1;
            if (pulled === 257) receiptQueueFull.release();
            yield {
              type: 'assistant',
              message: {
                id: `ollama-held-event-${index}`,
                role: 'assistant',
                content: [{ type: 'text', text: 'held' }],
              },
            };
          }
        })(),
    );
    let releaseSink = (): void => undefined;
    const heldSink = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    let signalFirst = (): void => undefined;
    const first = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const events: unknown[] = [];
    const session = new OllamaProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ollama-cancel',
        model: 'ollama-llama3:8b',
      },
      (event: unknown) => {
        events.push(event);
        if (readEventType(event) !== 'assistant') return;
        signalFirst();
        return heldSink;
      },
      getNoWindow,
    );
    try {
      session.sendMessage('Cancel Ollama', { userMessageId: 'ollama-user' });
      await first;
      await receiptQueueFull.promise;
      for (let attempts = 0; attempts < 10; attempts += 1) await flush();
      expect(pulled).toBe(257);
      await expect(session.cancel()).resolves.toBeUndefined();
      const isDisposed = session.isDisposed?.bind(session);
      if (!isDisposed) throw new Error('Expected session disposal status');
      expect(isDisposed()).toBe(true);
    } finally {
      releaseSink();
      await session.destroy();
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'result',
        result: 'Session aborted',
      }),
    );
  });

  it('destroys an Ollama delegate blocked at full receipt capacity with an aborted terminal', async () => {
    initOllamaModels([
      {
        id: 'ollama-llama3:8b',
        rawModelId: 'llama3:8b',
        label: 'Llama 3 8B',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    mockResolveClaudeCompatibleInvocation.mockResolvedValue({
      providerType: 'ollama',
      sdkModel: 'llama3:8b',
      envOverride: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' },
    });
    const receiptQueueFull = createGate();
    let pulled = 0;
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          for (let index = 0; index < 512; index += 1) {
            pulled += 1;
            if (pulled === 257) receiptQueueFull.release();
            yield {
              type: 'assistant',
              message: {
                id: `ollama-destroy-held-event-${index}`,
                role: 'assistant',
                content: [{ type: 'text', text: 'held' }],
              },
            };
          }
        })(),
    );
    let releaseSink = (): void => undefined;
    const heldSink = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    let signalFirst = (): void => undefined;
    const first = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const events: unknown[] = [];
    const session = new OllamaProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ollama-destroy-at-capacity',
        model: 'ollama-llama3:8b',
      },
      (event: unknown) => {
        events.push(event);
        if (readEventType(event) !== 'assistant') return;
        signalFirst();
        return heldSink;
      },
      getNoWindow,
    );

    try {
      session.sendMessage('Destroy Ollama', {
        userMessageId: 'ollama-destroy-user',
      });
      await first;
      await receiptQueueFull.promise;
      for (let attempts = 0; attempts < 10; attempts += 1) await flush();
      expect(pulled).toBe(257);
      const destroyPromise = session.destroy();
      releaseSink();
      await destroyPromise;
    } finally {
      releaseSink();
      await session.destroy();
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'result',
        result: 'Session aborted',
      }),
    );
  });

  it('does not advertise Claude steering for the Ollama delegate', async () => {
    let release = (): void => {
      throw new Error('Provider barrier release was not initialized');
    };
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        Object.assign(
          (async function* (): AsyncGenerator<unknown, void> {
            await prompt.next();
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 'ollama-session',
              capabilities: [
                'msg_lifecycle_v1',
                'interrupt_receipt_v1',
                'interrupt_cancel_queued_v1',
              ],
            };
            await barrier;
            yield { type: 'result', is_error: false, result: 'done' };
          })(),
          { cancelAsyncMessage: jest.fn(), interrupt: jest.fn() },
        ),
    );
    const session = new ClaudeCodeProvider({
      providerType: 'ollama',
    }).createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ollama-steering',
      },
      jest.fn(),
      getNoWindow,
    );
    try {
      session.sendMessage('Root', { userMessageId: 'root' });
      await flush();
      await flush();
      expect(typeof session.getSteeringCapabilities).toBe('undefined');
      expect(typeof session.submitSteeringInput).toBe('undefined');
      expect(typeof session.interruptWithPendingSweep).toBe('undefined');
    } finally {
      release();
      await flush();
      await session.destroy();
    }
  });

  it('correlates a steered delegate message by its attempt when it starts its own turn', async () => {
    // A delegate's claimed host message has a native UUID of its own. Claude
    // reports a steer's lifecycle under the UUID it was sent with, so a
    // steer must carry its attempt id, not the delivery id.
    const deliveryId = '0f3c2b8e-5d71-4a3e-9c8b-2f1d6e7a9b40';
    const attemptId = '6a9e1c42-8b3d-4f5e-a1c7-d2e8f0b4c936';
    mockLoadCachedInventory.mockResolvedValue(null);
    mockManagedDelegationEnabled.mockReturnValue(true);
    mockCreateManagedDelegationSession.mockResolvedValue(
      createManagedDelegationStub({
        parent: {
          nativeMessageUuid: (id) =>
            id === deliveryId ? deliveryId : undefined,
        },
      }),
    );
    const onEvent = jest.fn();
    const steered = createGate();
    let steeringInput: unknown;
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
        const stream = (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'provider-session',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          await steered.promise;
          steeringInput = (await prompt.next()).value;
          const commandUuid = readEventString(steeringInput, 'uuid');
          // As CLI 2.1.293 does: the root ends, then the queued message
          // starts its own turn on the same query.
          yield { type: 'result', is_error: false, result: 'root finished' };
          yield {
            type: 'command_lifecycle',
            command_uuid: commandUuid,
            state: 'queued',
          };
          yield {
            type: 'command_lifecycle',
            command_uuid: commandUuid,
            state: 'started',
          };
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'provider-session',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          yield { type: 'result', is_error: false, result: 'steer answered' };
        })();
        return Object.assign(stream, {
          applyFlagSettings: jest.fn().mockResolvedValue(undefined),
          cancelAsyncMessage: jest.fn(),
          interrupt: jest.fn(),
        });
      },
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'delegate-steer',
      },
      onEvent,
      getNoWindow,
    );
    try {
      session.sendMessage('Root', { userMessageId: 'root' });
      // Managed delegation setup runs before the query starts.
      for (let i = 0; i < 10 && !session.getSteeringCapabilities?.().steer; i++)
        await flush();
      expect(session.getSteeringCapabilities?.().steer).toBe(true);
      const submission = session.submitSteeringInput?.(
        'Delegate request',
        attemptId,
        deliveryId,
      );
      steered.release();
      await flush();
      await flush();
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'canopy_input_delivery',
          attemptId,
          phase: 'picked-up',
          startsTurn: true,
          userMessageId: deliveryId,
        }),
      );
      expect(steeringInput).toEqual(
        expect.objectContaining({ uuid: attemptId }),
      );
      expect(await submission).toEqual(
        expect.objectContaining({ kind: 'accepted', attemptId }),
      );
    } finally {
      await session.destroy();
    }
  });

  it('keeps the root attribution while correlated steering waits for pickup', async () => {
    const onEvent = jest.fn();
    let release = (): void => {
      throw new Error('Provider barrier release was not initialized');
    };
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let secondInput: unknown;
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
        const stream = (async function* (): AsyncGenerator<unknown, void> {
          const firstPrompt = await prompt.next();
          const userMessageUuid = readEventString(firstPrompt.value, 'uuid');
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'provider-session',
            ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          await barrier;
          secondInput = (await prompt.next()).value;
          yield {
            type: 'command_lifecycle',
            command_uuid: 'attempt-2',
            state: 'queued',
          };
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Still first turn' }] },
          };
          yield {
            type: 'command_lifecycle',
            command_uuid: 'attempt-2',
            state: 'started',
          };
          yield { type: 'result', is_error: false, result: 'root finished' };
        })();
        return Object.assign(stream, {
          cancelAsyncMessage: jest.fn(),
          interrupt: jest.fn(),
        });
      },
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );
    session.sendMessage('Root', { userMessageId: 'root' });
    await flush();
    await flush();
    expect(session.getSteeringCapabilities?.().steer).toBe(true);
    const submission = session.submitSteeringInput?.(
      'Correction',
      'attempt-2',
      'row-2',
    );
    release();
    await flush();
    await flush();
    expect(await submission).toEqual(
      expect.objectContaining({ kind: 'accepted', attemptId: 'attempt-2' }),
    );
    expect(secondInput).toEqual(expect.objectContaining({ uuid: 'attempt-2' }));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        canopy_turn_user_message_id: 'root',
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        canopy_turn_user_message_id: 'root',
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'canopy_input_delivery',
        attemptId: 'attempt-2',
        phase: 'picked-up',
      }),
    );
    await session.destroy();
  });

  it('reads root steering unconfirmed past the deadline as pending, then follows a late lifecycle', async () => {
    const onEvent = jest.fn();
    const barrier = createGate();
    const acknowledge = createGate();
    let steeringInput: unknown;
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
        const stream = (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'provider-session',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          await barrier.promise;
          steeringInput = (await prompt.next()).value;
          await acknowledge.promise;
          yield {
            type: 'command_lifecycle',
            command_uuid: 'attempt-late',
            state: 'queued',
          };
          yield {
            type: 'command_lifecycle',
            command_uuid: 'attempt-late',
            state: 'started',
          };
          yield { type: 'result', is_error: false, result: 'root finished' };
        })();
        return Object.assign(stream, {
          cancelAsyncMessage: jest.fn(),
          interrupt: jest.fn(),
        });
      },
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );
    const deliveryEvents = (): unknown[] =>
      onEvent.mock.calls
        .map(([event]: unknown[]) => event)
        .filter(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'canopy_input_delivery',
        );
    try {
      session.sendMessage('Root', { userMessageId: 'root' });
      await flush();
      await flush();
      expect(session.getSteeringCapabilities?.().steer).toBe(true);
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });
      const submission = session.submitSteeringInput?.(
        'Correction',
        'attempt-late',
        'row-late',
      );
      barrier.release();
      await flush();
      await flush();
      expect(steeringInput).toEqual(
        expect.objectContaining({ uuid: 'attempt-late' }),
      );
      await jest.advanceTimersByTimeAsync(5001);
      await expect(submission).resolves.toEqual({
        kind: 'pending',
        attemptId: 'attempt-late',
      });
      expect(deliveryEvents()).toEqual([]);
      jest.useRealTimers();
      acknowledge.release();
      await flush();
      await flush();
      expect(deliveryEvents()).toEqual([
        expect.objectContaining({
          attemptId: 'attempt-late',
          phase: 'accepted',
        }),
        expect.objectContaining({
          attemptId: 'attempt-late',
          phase: 'picked-up',
        }),
      ]);
    } finally {
      jest.useRealTimers();
      barrier.release();
      acknowledge.release();
      await session.destroy();
    }
    expect(deliveryEvents()).not.toContainEqual(
      expect.objectContaining({ phase: 'unknown' }),
    );
  });

  it.each(['result', 'error'])(
    'refuses steering while root %s delivery is blocked',
    async (type) => {
      mockLoadCachedInventory.mockResolvedValue(null);
      const allowTerminal = createGate();
      const terminalReceived = createGate();
      const allowDelivery = createGate();
      const allowNextInit = createGate();
      const keepQueryOpen = createGate();
      const initReceived = createGate();
      const nextInitReceived = createGate();
      mockQuery.mockImplementation(
        ({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
          const stream = (async function* (): AsyncGenerator<unknown, void> {
            await prompt.next();
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 'provider-session',
              capabilities: [
                'msg_lifecycle_v1',
                'interrupt_receipt_v1',
                'interrupt_cancel_queued_v1',
              ],
            };
            initReceived.release();
            await allowTerminal.promise;
            yield type === 'result'
              ? { type: 'result', is_error: false, result: 'done' }
              : { type: 'error', error: 'failed' };
            if (type === 'result') {
              // Hold only the root terminal receipt; otherwise a read-ahead
              // init would legitimately establish the next running turn.
              await allowNextInit.promise;
              yield {
                type: 'system',
                subtype: 'init',
                session_id: 'provider-session',
                capabilities: [
                  'msg_lifecycle_v1',
                  'interrupt_receipt_v1',
                  'interrupt_cancel_queued_v1',
                ],
              };
              nextInitReceived.release();
            }
            await keepQueryOpen.promise;
          })();
          return Object.assign(stream, {
            cancelAsyncMessage: jest.fn(),
            interrupt: jest.fn(),
          });
        },
      );
      const onEvent = jest.fn((event: unknown) => {
        if (
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === type
        ) {
          terminalReceived.release();
          return allowDelivery.promise;
        }
      });
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'blocked-terminal',
        },
        onEvent,
        getNoWindow,
      );
      const states: boolean[] = [];
      const unsubscribe = subscribeSteeringEligibility((key) => {
        if (key === 'project/worktree/blocked-terminal')
          states.push(session.getSteeringCapabilities?.().steer === true);
      });
      // Isolate admission from SDK receipts: the blocked read loop cannot read a
      // queued receipt until the terminal is delivered.
      const submit = jest
        .spyOn(ClaudeInputDelivery.prototype, 'submit')
        .mockResolvedValue({ kind: 'accepted', attemptId: 'after-terminal' });
      try {
        session.sendMessage('Root', { userMessageId: 'root' });
        await initReceived.promise;
        expect(session.getSteeringCapabilities?.().steer).toBe(true);
        states.length = 0;
        allowTerminal.release();
        await terminalReceived.promise;
        await expect(
          session.submitSteeringInput?.('Later', 'after-terminal', 'later'),
        ).resolves.toMatchObject({ kind: 'rejected', fallback: 'ordinary' });
        expect(session.getSteeringCapabilities?.().steer).toBe(false);
        expect(submit).not.toHaveBeenCalled();
        // Receipt-time fencing disables steering immediately; consumer-side
        // active-turn retirement later re-advertises that ineligible state.
        expect(states).toEqual([false, false]);
        if (type === 'result') {
          allowDelivery.release();
          allowNextInit.release();
          await nextInitReceived.promise;
          expect(session.getSteeringCapabilities?.().steer).toBe(true);
          // Receipt, durable settlement, turn start, advertised capabilities.
          expect(states).toEqual([false, false, true, true]);
        }
      } finally {
        unsubscribe();
        submit.mockRestore();
        allowTerminal.release();
        allowDelivery.release();
        allowNextInit.release();
        keepQueryOpen.release();
        await flush();
        await session.destroy();
      }
    },
    30000,
  );

  it('keeps steering open across subagent terminals and task-notification preludes', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const eventsReceived = createGate();
    const keepQueryOpen = createGate();
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
        const stream = (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'provider-session',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          yield {
            type: 'result',
            parent_tool_use_id: 'child',
            result: 'child done',
          };
          yield {
            type: 'error',
            parent_tool_use_id: 'child',
            error: 'child failed',
          };
          yield {
            type: 'result',
            is_error: false,
            num_turns: 0,
            result: '',
            origin: { kind: 'task-notification' },
          };
          eventsReceived.release();
          await keepQueryOpen.promise;
        })();
        return Object.assign(stream, {
          cancelAsyncMessage: jest.fn(),
          interrupt: jest.fn(),
        });
      },
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'non-root-terminals',
      },
      jest.fn(),
      getNoWindow,
    );
    try {
      session.sendMessage('Root', { userMessageId: 'root' });
      await eventsReceived.promise;
      expect(session.getSteeringCapabilities?.().steer).toBe(true);
    } finally {
      keepQueryOpen.release();
      await flush();
      await session.destroy();
    }
  });

  it('notifies steering eligibility when the running turn is set', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    const queryBound = createGate();
    const allowInit = createGate();
    const initReceived = createGate();
    const keepQueryOpen = createGate();
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          queryBound.release();
          await allowInit.promise;
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'provider-session',
          };
          initReceived.release();
          await keepQueryOpen.promise;
        })(),
    );
    const listener = jest.fn();
    const unsubscribe = subscribeSteeringEligibility(listener);
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'turn-notification',
      },
      jest.fn(),
      getNoWindow,
    );
    try {
      session.sendMessage('Root', { userMessageId: 'root' });
      await queryBound.promise;
      listener.mockClear();
      allowInit.release();
      await initReceived.promise;
      expect(listener).toHaveBeenCalledWith(
        'project/worktree/turn-notification',
      );
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      allowInit.release();
      keepQueryOpen.release();
      await flush();
      await session.destroy();
    }
  });

  it('refuses steering as ordinary after the root ends while a subagent remains active', async () => {
    const promptPulled = createGate();
    const rootResultEmitted = createGate();
    const allowSubagentStart = createGate();
    const subagentStarted = createGate();
    const allowSubagentFinish = createGate();
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
        const source = prompt[Symbol.asyncIterator]();
        return (async function* (): AsyncGenerator<unknown, void> {
          await source.next();
          promptPulled.release();
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'provider-session',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          yield { type: 'result', is_error: false, result: 'Root finished' };
          rootResultEmitted.release();
          await allowSubagentStart.promise;
          yield {
            type: 'assistant',
            parent_tool_use_id: 'subagent-1',
            message: {
              id: 'subagent-still-running',
              role: 'assistant',
              content: [{ type: 'text', text: 'Subagent continues' }],
            },
          };
          subagentStarted.release();
          await allowSubagentFinish.promise;
        })();
      },
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'idle-parent-active-subagent',
      },
      jest.fn(),
      getNoWindow,
    );
    session.sendMessage('Finish the root', { userMessageId: 'root' });

    try {
      await promptPulled.promise;
      await rootResultEmitted.promise;
      allowSubagentStart.release();
      await subagentStarted.promise;
      expect(session.getSteeringCapabilities?.().steer).toBe(false);
      await expect(
        session.submitSteeringInput?.(
          'Continue as an ordinary turn',
          'idle-steer-attempt',
          'idle-steer-user',
        ),
      ).resolves.toMatchObject({
        kind: 'rejected',
        attemptId: 'idle-steer-attempt',
        fallback: 'ordinary',
      });
    } finally {
      allowSubagentStart.release();
      allowSubagentFinish.release();
      await flush();
      await session.destroy();
    }
  });

  it('tags Claude events with the active user message id', async () => {
    const onEvent = jest.fn();
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          for (const message of [
            {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'Working' }] },
            },
            { type: 'result', is_error: false, result: 'done' },
          ]) {
            yield message;
          }
        })(),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Do work', { userMessageId: 'user-message-1' });
    await flush();
    await flush();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        result: 'done',
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );

    await session.destroy();
  });

  it('records an expired native OAuth failure for account-change resume', async () => {
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'system',
            subtype: 'retry',
            error: 'authentication_failed',
            error_status: 429,
          };
          yield {
            type: 'assistant',
            error: 'authentication_failed',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
                },
              ],
            },
          };
          yield {
            type: 'result',
            is_error: true,
            result:
              'Failed to authenticate: OAuth session expired and could not be refreshed',
          };
        })(),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Continue');
    await flush();
    await flush();

    expect(mockRecordUsageLimitedChat).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        provider: 'claude',
        resumeReason: 'authentication',
      }),
    );
    expect(mockRecordUsageLimitedChat).toHaveBeenCalledTimes(2);

    await session.destroy();
  });

  it('ends the turn with the proxy error when no Claude account can serve it', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    mockQuery.mockClear();
    const message =
      'The account proxy has no Claude accounts. Add one in Settings > Multi-account proxy, or turn off Use for Claude there.';
    mockResolveAccountProxySessionRoute.mockRejectedValueOnce(
      new Error(message),
    );
    const onEvent = jest.fn();
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );
    try {
      session.sendMessage('Hello', { userMessageId: 'user-msg-1' });
      for (
        let i = 0;
        i < 100 &&
        !onEvent.mock.calls.some(
          ([event]: [{ type?: string } | undefined]) => event?.type === 'error',
        );
        i++
      ) {
        await flush();
      }
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', error: message }),
      );
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await session.destroy();
    }
  });

  it('records the account proxy route a session actually applied', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    mockResolveAccountProxySessionRoute.mockResolvedValueOnce({
      accountKey: 'account-proxy:test-proxy',
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/route-1',
      },
    });
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield { type: 'result', is_error: false, result: 'done' };
        })(),
    );
    const onEvent = jest.fn();
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        requiredAccountProxyConnectionId: 'test-proxy',
      },
      onEvent,
      getNoWindow,
    );
    try {
      session.sendMessage('Continue', { userMessageId: 'user-msg-1' });
      for (let i = 0; i < 100 && mockQuery.mock.calls.length === 0; i++) {
        await flush();
      }
      expect(mockResolveAccountProxySessionRoute).toHaveBeenCalledWith(
        expect.objectContaining({ requiredConnectionId: 'test-proxy' }),
      );
      expect(jest.mocked(recordSessionAccountProxyRoute)).toHaveBeenCalledWith(
        expect.stringContaining('chat'),
        true,
      );
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'canopy_ai_credits_routing',
          active: false,
          accountProxyRouted: true,
        }),
      );
      expect(mockQuery.mock.calls[0]?.[0]?.options?.env).toEqual(
        expect.objectContaining({
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/route-1',
        }),
      );
    } finally {
      await session.destroy();
    }
  });

  it('shows the proxy moving a chat between accounts while it serves the query', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    mockWatchAccountProxySwitches.mockClear();
    mockStopAccountProxySwitches.mockClear();
    mockResolveAccountProxySessionRoute.mockResolvedValueOnce({
      accountKey: 'account-proxy:test-proxy',
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/route-1',
      },
    });
    let finishQuery: () => void = () => undefined;
    const queryDone = new Promise<void>((resolve) => {
      finishQuery = resolve;
    });
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          await queryDone;
          yield { type: 'result', is_error: false, result: 'done' };
        })(),
    );
    const events: unknown[] = [];
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => {
        events.push(event);
      },
      getNoWindow,
    );
    try {
      session.sendMessage('Continue', { userMessageId: 'user-msg-1' });
      for (
        let i = 0;
        i < 100 && mockWatchAccountProxySwitches.mock.calls.length === 0;
        i++
      ) {
        await flush();
      }
      const [sessionId, emit] =
        mockWatchAccountProxySwitches.mock.calls[0] ?? [];
      expect(sessionId).toBe('project/worktree/chat');
      if (!emit) throw new Error('No switch watcher');
      await emit({
        type: 'canopy_account_proxy_switch',
        sourceEventId: 'switch-1',
        timestamp: 1,
        account: 'sam@example.com',
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'canopy_account_proxy_switch',
          account: 'sam@example.com',
        }),
      );
      expect(mockStopAccountProxySwitches).not.toHaveBeenCalled();
    } finally {
      finishQuery();
      await session.destroy();
    }
    for (
      let i = 0;
      i < 100 && !mockStopAccountProxySwitches.mock.calls.length;
      i++
    ) {
      await flush();
    }
    // The query ended: no more lines from it.
    expect(mockStopAccountProxySwitches).toHaveBeenCalled();
  });

  it.each(['child assistant', 'child result', 'root notice'])(
    'does not record proxy interruption after %s and root success',
    async (source) => {
      mockLoadCachedInventory.mockResolvedValue(null);
      mockResolveAccountProxySessionRoute.mockResolvedValueOnce({
        accountKey: 'account-proxy:test-proxy',
        env: {},
      });
      jest.mocked(isSessionAccountProxyRouted).mockReturnValue(true);
      mockQuery.mockImplementation(
        ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
          (async function* (): AsyncGenerator<unknown, void> {
            await prompt.next();
            yield source === 'child result'
              ? {
                  type: 'result',
                  is_error: true,
                  api_error_status: 429,
                  result: 'Quota reached',
                  parent_tool_use_id: 'child-tool',
                }
              : {
                  type: 'assistant',
                  error: 'rate_limit',
                  parent_tool_use_id:
                    source === 'child assistant' ? 'child-tool' : null,
                };
            yield {
              type: 'result',
              is_error: false,
              result: 'Root succeeded',
              parent_tool_use_id: null,
            };
          })(),
      );
      let finish: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        (event) => {
          if (
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'result' &&
            'is_error' in event &&
            event.is_error === false
          )
            finish();
        },
        getNoWindow,
      );
      try {
        session.sendMessage('Complete the root task');
        await finished;
        expect(mockRecordUsageLimitedChat).not.toHaveBeenCalled();
      } finally {
        jest.mocked(isSessionAccountProxyRouted).mockReturnValue(false);
        await session.destroy();
      }
    },
  );

  it('records proxy quota when the root SDK iterator terminates with a quota error', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    mockResolveAccountProxySessionRoute.mockResolvedValueOnce({
      accountKey: 'account-proxy:test-proxy',
      env: {},
    });
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        // eslint-disable-next-line require-yield -- models a terminal SDK API rejection before any event
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          throw Object.assign(new Error('HTTP 429: usage limit reached'), {
            status: 429,
          });
        })(),
    );
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => {
        if (
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'error'
        )
          finish();
      },
      getNoWindow,
    );
    try {
      session.sendMessage('Continue');
      await finished;
      expect(mockRecordUsageLimitedChat).toHaveBeenCalledWith(
        expect.objectContaining({
          accountProxyConnectionId: 'test-proxy',
          resumeReason: 'usage_limit',
        }),
      );
    } finally {
      await session.destroy();
    }
  });

  it('records exhausted proxy quota against the connection that actually served the query', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    mockResolveAccountProxySessionRoute.mockResolvedValueOnce({
      accountKey: 'account-proxy:test-proxy',
      env: { ANTHROPIC_BASE_URL: 'http://localhost/proxy' },
    });
    jest.mocked(isSessionAccountProxyRouted).mockReturnValue(true);
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'result',
            is_error: true,
            api_error_status: 429,
            result: 'Rate limited',
          };
        })(),
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      () => undefined,
      getNoWindow,
    );
    try {
      session.sendMessage('Continue');
      for (
        let i = 0;
        i < 100 && mockRecordUsageLimitedChat.mock.calls.length === 0;
        i++
      )
        await flush();
      expect(mockRecordUsageLimitedChat).toHaveBeenCalledWith(
        expect.objectContaining({
          accountProxyConnectionId: 'test-proxy',
          provider: 'claude',
          resumeReason: 'usage_limit',
        }),
      );
    } finally {
      jest.mocked(isSessionAccountProxyRouted).mockReturnValue(false);
      await session.destroy();
    }
  });

  describe('Claude usage-limit reset time (CAN-4200)', () => {
    const RESETS_AT_SECONDS = 1_900_000_000;

    function usageLimitEvents(events: readonly unknown[]): unknown[] {
      return events.filter(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === AI_CREDITS_USAGE_LIMIT_EVENT_TYPE,
      );
    }

    async function runTurns(
      turns: readonly (readonly unknown[])[],
    ): Promise<unknown[]> {
      mockLoadCachedInventory.mockResolvedValue(null);
      mockQuery.mockImplementation(
        ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
          (async function* (): AsyncGenerator<unknown, void> {
            for (const turn of turns) {
              await prompt.next();
              for (const event of turn) yield event;
            }
          })(),
      );
      const events: unknown[] = [];
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        (event) => {
          events.push(event);
        },
        getNoWindow,
      );
      try {
        for (let turn = 0; turn < turns.length; turn++) {
          session.sendMessage('Continue');
          await flush();
        }
        for (
          let i = 0;
          i < 100 && mockRecordUsageLimitedChat.mock.calls.length === 0;
          i++
        )
          await flush();
      } finally {
        await session.destroy();
      }
      return events;
    }

    const quotaResult = {
      type: 'result',
      is_error: true,
      api_error_status: 429,
      result: 'Rate limited',
    };

    afterEach(() => {
      clearAllProviderQuotaReached();
    });

    it('keeps child identity on derived Claude quota notices', async () => {
      const events = await runTurns([
        [
          {
            type: 'assistant',
            parent_tool_use_id: 'toolu_child',
            error: 'rate_limit',
            message: { role: 'assistant', content: [] },
          },
          { type: 'result', is_error: false, result: 'Done' },
        ],
      ]);
      expect(usageLimitEvents(events)).toContainEqual(
        expect.objectContaining({
          provider: 'claude',
          parent_tool_use_id: 'toolu_child',
        }),
      );
    });

    it('keeps child identity on auth notices derived from Claude assistant frames', async () => {
      const events = await runTurns([
        [
          {
            type: 'assistant',
            parent_tool_use_id: 'toolu_child',
            error: 'authentication_failed',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
                },
              ],
            },
          },
          { type: 'result', is_error: false, result: 'Done' },
        ],
      ]);
      expect(events.filter(isCanopyAuthFailureEventData)).toContainEqual(
        expect.objectContaining({ parent_tool_use_id: 'toolu_child' }),
      );
    });

    it.each([
      {
        name: 'quota',
        error: 'rate_limit',
        text: 'Rate limited',
        category: 'provider_quota',
      },
      {
        name: 'authentication',
        error: 'authentication_failed',
        text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        category: 'provider_auth',
      },
    ])(
      'reports a Claude sub-agent $name failure only as a sub-agent failure',
      async ({ error, text, category }) => {
        const events = await runTurns([
          [
            {
              type: 'assistant',
              parent_tool_use_id: 'toolu_child',
              error,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text }],
              },
            },
            { type: 'result', is_error: false, result: 'Done' },
          ],
        ]);
        expectOnlySubAgentFailure(events, category);
      },
    );

    it('carries the rejected rate_limit_event reset time onto the usage limit', async () => {
      const markSpy = jest.spyOn(quotaState, 'markProviderQuotaReached');
      try {
        const events = await runTurns([
          [
            {
              type: 'rate_limit_event',
              rate_limit_info: {
                status: 'rejected',
                resetsAt: RESETS_AT_SECONDS,
              },
            },
            quotaResult,
          ],
        ]);
        expect(markSpy).toHaveBeenCalledWith(
          'claude',
          RESETS_AT_SECONDS * 1000,
        );
        expect(usageLimitEvents(events)).toEqual([
          expect.objectContaining({
            provider: 'claude',
            resetsAt: RESETS_AT_SECONDS * 1000,
          }),
        ]);
        expect(mockRecordUsageLimitedChat).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: 'claude',
            resumeReason: 'usage_limit',
            resetsAt: RESETS_AT_SECONDS * 1000,
          }),
        );
      } finally {
        markSpy.mockRestore();
      }
    });

    it('does not carry a rejected reset time from an earlier turn', async () => {
      const markSpy = jest.spyOn(quotaState, 'markProviderQuotaReached');
      try {
        const events = await runTurns([
          [
            {
              type: 'rate_limit_event',
              rate_limit_info: {
                status: 'rejected',
                resetsAt: RESETS_AT_SECONDS,
              },
            },
            { type: 'result', is_error: false, result: 'Done' },
          ],
          [quotaResult],
        ]);
        expect(markSpy).toHaveBeenCalledWith('claude', undefined);
        const limits = usageLimitEvents(events);
        expect(limits).toHaveLength(1);
        expect(limits[0]).not.toHaveProperty('resetsAt');
        expect(mockRecordUsageLimitedChat).toHaveBeenCalledTimes(1);
        expect(
          mockRecordUsageLimitedChat.mock.calls[0]?.[0],
        ).not.toHaveProperty('resetsAt');
      } finally {
        markSpy.mockRestore();
      }
    });
  });

  it('leaves the account proxy out when AI Credits always route', async () => {
    mockLoadCachedInventory.mockResolvedValue(null);
    setAiCreditsRoutingModeCache('on');
    mockedIsNativelyAuthed.mockResolvedValue(true);
    // No credits to route with, so the session falls through to native.
    mockedGetRoutingContext.mockResolvedValue(null);
    mockResolveAccountProxySessionRoute.mockClear();
    mockResolveAccountProxySessionRoute.mockResolvedValue({
      accountKey: 'account-proxy:connection-1',
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/route-1',
      },
    });
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'opus',
      },
      () => undefined,
      getNoWindow,
    );
    try {
      session.sendMessage('Continue', { userMessageId: 'user-msg-1' });
      for (let i = 0; i < 100 && mockQuery.mock.calls.length === 0; i++) {
        await flush();
      }
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockResolveAccountProxySessionRoute).not.toHaveBeenCalled();
      expect(mockQuery.mock.calls[0]?.[0]?.options?.env).not.toEqual(
        expect.objectContaining({
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/route-1',
        }),
      );
    } finally {
      await session.destroy();
      setAiCreditsRoutingModeCache('off');
      mockResolveAccountProxySessionRoute.mockResolvedValue(null);
    }
  });

  it('keeps an account proxy session out of native sign-in recovery', async () => {
    jest.mocked(isSessionAccountProxyRouted).mockReturnValue(true);
    mockLoadCachedInventory.mockResolvedValue(null);
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'result',
            is_error: true,
            result:
              'Failed to authenticate: OAuth session expired and could not be refreshed',
          };
        })(),
    );
    const events: unknown[] = [];
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => {
        events.push(event);
      },
      getNoWindow,
    );
    try {
      session.sendMessage('Continue', { userMessageId: 'user-msg-1' });
      for (
        let i = 0;
        i < 100 && !events.some((event) => readEventType(event) === 'result');
        i++
      ) {
        await flush();
      }
      await flush();
      expect(events.some((event) => readEventType(event) === 'result')).toBe(
        true,
      );
      // The proxy refused the request; the user's own Claude login is fine.
      expect(events.filter(isCanopyAuthFailureEventData)).toHaveLength(0);
      expect(mockRecordUsageLimitedChat).not.toHaveBeenCalled();
    } finally {
      jest.mocked(isSessionAccountProxyRouted).mockReturnValue(false);
      await session.destroy();
    }
  });

  it.each([null, 'toolu_child'])(
    'delivers a structured provider auth-failure event with parent %s after the failing event',
    async (parentToolUseId) => {
      mockLoadCachedInventory.mockResolvedValue(null);
      // Regression guard (CAN-1814 whole-branch review): this used to call
      // `recordSessionEvent`, which is session bookkeeping and never reaches the
      // renderer, so the entire provider half of the feature was unreachable.
      // Ordering is asserted too: the reducer writes the `system` notice this
      // failure attaches to while reducing the `result` event, so an auth event
      // emitted BEFORE it would find no anchor at all.
      mockQuery.mockImplementation(
        ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
          (async function* (): AsyncGenerator<unknown, void> {
            await prompt.next();
            yield {
              type: 'result',
              is_error: true,
              parent_tool_use_id: parentToolUseId,
              result:
                'Failed to authenticate: OAuth session expired and could not be refreshed',
            };
          })(),
      );

      const events: unknown[] = [];
      const provider = new ClaudeCodeProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        (event) => {
          events.push(event);
        },
        getNoWindow,
      );

      session.sendMessage('Continue', { userMessageId: 'user-msg-1' });
      for (
        let i = 0;
        i < 100 && !events.some(isCanopyAuthFailureEventData);
        i++
      ) {
        await flush();
      }

      const authEvent = events.find(isCanopyAuthFailureEventData);
      expect(authEvent).toBeDefined();
      if (parentToolUseId) {
        expect(authEvent).toMatchObject({
          parent_tool_use_id: parentToolUseId,
        });
      } else {
        expect(authEvent).not.toHaveProperty('parent_tool_use_id');
      }
      // Stamped like every other emitted event, so anything that groups by turn
      // can place it (CAN-1814 review).
      expect(readTurnUserMessageId(authEvent)).toBe('user-msg-1');
      expect(authEvent?.failure.dependencyClass).toBe('provider');
      expect(authEvent?.failure.dependencyId).toBe('claude');
      expect(authEvent?.failure.displayName).toBe('Claude');
      expect(authEvent?.failure.failureClass).toBe('unauthenticated');
      expect(authEvent?.failure.recovery).toEqual({
        kind: 'provider_terminal',
        provider: 'claude',
      });

      const emittedTypes = events.map(readEventType);
      const resultIndex = emittedTypes.indexOf('result');
      const authIndex = emittedTypes.indexOf('canopy_auth_failure');
      expect(resultIndex).toBeGreaterThanOrEqual(0);
      expect(authIndex).toBeGreaterThan(resultIndex);

      await session.destroy();
    },
  );

  it('keeps a delayed auth notice correlated with its original turn after a later message is queued', async () => {
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'result',
            is_error: true,
            result:
              'Failed to authenticate: OAuth session expired and could not be refreshed',
          };
          await prompt.next();
          yield { type: 'result', is_error: false, result: 'Next turn' };
        })(),
    );

    let releaseFirstResult = (): void => undefined;
    const firstResultHeld = new Promise<void>((resolve) => {
      releaseFirstResult = resolve;
    });
    let notifyFirstResult = (): void => undefined;
    const firstResultObserved = new Promise<void>((resolve) => {
      notifyFirstResult = resolve;
    });
    const events: unknown[] = [];
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => {
        events.push(event);
        if (
          readEventType(event) === 'result' &&
          readEventString(event, 'result')?.startsWith('Failed to authenticate')
        ) {
          notifyFirstResult();
          return firstResultHeld;
        }
      },
      getNoWindow,
    );

    try {
      session.sendMessage('First', { userMessageId: 'first-turn' });
      await firstResultObserved;
      session.sendMessage('Second', { userMessageId: 'second-turn' });
      await flush();
      expect(events.filter(isCanopyAuthFailureEventData)).toHaveLength(0);

      releaseFirstResult();
      for (
        let attempts = 0;
        attempts < 20 &&
        events.filter(isCanopyAuthFailureEventData).length === 0;
        attempts += 1
      ) {
        await flush();
      }
      const authEvents = events.filter(isCanopyAuthFailureEventData);
      expect(authEvents).toHaveLength(1);
      expect(readTurnUserMessageId(authEvents[0])).toBe('first-turn');
      expect(
        readTurnUserMessageId(
          events.find(
            (event) =>
              readEventType(event) === 'result' &&
              readEventString(event, 'result')?.startsWith(
                'Failed to authenticate',
              ),
          ),
        ),
      ).toBe('first-turn');
    } finally {
      releaseFirstResult();
      await session.destroy();
    }
  });

  it('does not record successful Claude results that contain auth-failure text', async () => {
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'result',
            is_error: false,
            result:
              'Failed to authenticate: this is quoted documentation, not a provider failure',
          };
        })(),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );

    session.sendMessage('Explain an authentication error');
    await flush();
    await flush();

    expect(mockRecordUsageLimitedChat).not.toHaveBeenCalled();

    await session.destroy();
  });

  it('emits terminal Claude results while marking the foreground turn idle once', async () => {
    const onEvent = jest.fn();
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield { type: 'result', is_error: false, result: 'done' };
        })(),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Do work', { userMessageId: 'user-message-1' });
    await flush();
    await flush();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        result: 'done',
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        canopy_session_continues: true,
      }),
    );
    expect(mockedMarkTurnIdle).toHaveBeenCalledTimes(1);
    expect(mockedMarkTurnIdle).toHaveBeenCalledWith('project/worktree/chat');

    await session.destroy();
  });

  it.each([
    {
      event: { type: 'result', is_error: false, result: 'done' },
      eventType: 'result',
    },
    { event: { type: 'error', error: 'provider failed' }, eventType: 'error' },
  ])(
    'stamps provider $eventType events with child liveness at receipt',
    async ({ event, eventType }) => {
      const liveness: ChildToolLiveness = {
        kind: 'known',
        liveParentToolUseIds: ['toolu_live'],
        hasUncorrelatedLiveTask: false,
      };
      mockGetChildToolLiveness.mockReturnValue(liveness);
      mockQuery.mockReturnValue(makeMessages([event]));
      const onEvent = jest.fn();
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        onEvent,
        getNoWindow,
      );

      session.sendMessage('Do work', { userMessageId: 'user-message-1' });
      await flush();
      await flush();

      const terminal = onEvent.mock.calls
        .map(([data]): unknown => data)
        .find((data) => readEventType(data) === eventType);
      expect(readChildToolLivenessStamp(terminal)).toEqual(liveness);
      expect(mockGetChildToolLiveness).toHaveBeenCalledWith(
        'project',
        'worktree',
        'chat',
      );
      expect(recordSessionEvent).toHaveBeenCalledWith(
        'project/worktree/chat',
        expect.objectContaining({
          type: eventType,
          [CHILD_TOOL_LIVENESS_STAMP]: liveness,
        }),
      );

      await session.destroy();
    },
  );

  it('captures terminal liveness before delayed event admission settles', async () => {
    const receivedLiveness: ChildToolLiveness = {
      kind: 'known',
      liveParentToolUseIds: ['toolu_at_receipt'],
      hasUncorrelatedLiveTask: false,
    };
    const laterLiveness: ChildToolLiveness = {
      kind: 'known',
      liveParentToolUseIds: ['toolu_after_receipt'],
      hasUncorrelatedLiveTask: false,
    };
    const admission = createGate();
    mockGetChildToolLiveness.mockReturnValue(receivedLiveness);
    mockQuery.mockReturnValue(
      makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
    );
    const onEvent = jest.fn((data: unknown) =>
      readEventType(data) === 'result' ? admission.promise : undefined,
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Do work', { userMessageId: 'user-message-1' });
    await flush();
    mockGetChildToolLiveness.mockReturnValue(laterLiveness);
    admission.release();
    await flush();
    await flush();

    const terminal = onEvent.mock.calls
      .map(([data]): unknown => data)
      .find((data) => readEventType(data) === 'result');
    expect(readChildToolLivenessStamp(terminal)).toEqual(receivedLiveness);
    expect(recordSessionEvent).toHaveBeenCalledWith(
      'project/worktree/chat',
      expect.objectContaining({
        type: 'result',
        [CHILD_TOOL_LIVENESS_STAMP]: receivedLiveness,
      }),
    );

    await session.destroy();
  });

  it('preserves valid liveness stamps when a terminal event is redelivered', async () => {
    const liveness: ChildToolLiveness = {
      kind: 'known',
      liveParentToolUseIds: ['toolu_stable'],
      hasUncorrelatedLiveTask: true,
    };
    const result = {
      type: 'result',
      is_error: false,
      result: 'done',
      [CHILD_TOOL_LIVENESS_STAMP]: liveness,
    };
    mockQuery.mockReturnValue(makeMessages([result, result]));
    const onEvent = jest.fn();
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Do work');
    await flush();
    await flush();

    expect(
      onEvent.mock.calls.filter(([data]) => readEventType(data) === 'result'),
    ).toHaveLength(2);
    const serializedTerminals = onEvent.mock.calls
      .filter(([data]) => readEventType(data) === 'result')
      .map(([data]) => JSON.stringify(data));
    // Canonical fallback dedupe hashes the event JSON, including its stamp.
    expect(serializedTerminals[1]).toBe(serializedTerminals[0]);
    for (const [data] of onEvent.mock.calls) {
      if (readEventType(data) === 'result') {
        expect(readChildToolLivenessStamp(data)).toEqual(liveness);
      }
    }
    expect(mockGetChildToolLiveness).not.toHaveBeenCalled();

    await session.destroy();
  });

  it('keeps the foreground turn active across resumed task-notification results', async () => {
    const onEvent = jest.fn();
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'system',
            subtype: 'task_notification',
            status: 'stopped',
          };
          yield {
            type: 'result',
            is_error: false,
            num_turns: 0,
            result: '',
            origin: { kind: 'task-notification' },
          };
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Foreground reply' }] },
          };
          yield {
            type: 'result',
            is_error: false,
            num_turns: 1,
            result: 'Foreground reply',
          };
        })(),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      withLegacyResumeSessionId(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        'resumed-session',
      ),
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Continue the foreground turn', {
      userMessageId: 'user-message-1',
    });
    await flush();
    await flush();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        num_turns: 0,
        origin: { kind: 'task-notification' },
        canopy_session_continues: true,
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        num_turns: 1,
        result: 'Foreground reply',
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
    const continuedResult = onEvent.mock.calls
      .map(([data]): unknown => data)
      .find(
        (data) =>
          readEventType(data) === 'result' &&
          readEventBoolean(data, 'canopy_session_continues') === true,
      );
    expect(readChildToolLivenessStamp(continuedResult)).toBeUndefined();
    expect(mockedMarkTurnIdle).toHaveBeenCalledTimes(1);
    expect(mockedMarkTurnIdle).toHaveBeenCalledWith('project/worktree/chat');

    await session.destroy();
  });

  it('keeps a queued foreground turn pending when a resumed task notification arrives before prompt consumption', async () => {
    const onEvent = jest.fn();
    let consumedPrompt: unknown;
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          yield {
            type: 'result',
            is_error: false,
            num_turns: 0,
            result: '',
            duration_ms: 38,
            origin: { kind: 'task-notification' },
          };
          consumedPrompt = (await prompt.next()).value;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Foreground reply' }] },
          };
          yield {
            type: 'result',
            is_error: false,
            num_turns: 1,
            result: 'Foreground reply',
          };
        })(),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      withLegacyResumeSessionId(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        'resumed-session',
      ),
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Continue the foreground turn', {
      userMessageId: 'user-message-1',
    });
    await flush();
    await flush();

    expect(consumedPrompt).toEqual(
      expect.objectContaining({
        message: {
          role: 'user',
          content: 'Continue the foreground turn',
        },
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        num_turns: 0,
        origin: { kind: 'task-notification' },
        canopy_session_continues: true,
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        num_turns: 1,
        result: 'Foreground reply',
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
    expect(mockedMarkTurnIdle).toHaveBeenCalledTimes(1);

    await session.destroy();
  });

  it('drops ownerless preludes and preserves repeated preludes across two foreground turns on one query', async () => {
    const onEvent = jest.fn();
    const prelude = {
      type: 'result',
      is_error: false,
      num_turns: 0,
      result: '',
      origin: { kind: 'task_notification' },
    };
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          // No foreground owner yet: this side channel must be consumed.
          yield prelude;
          await prompt.next();
          yield prelude;
          yield prelude;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'First reply' }] },
          };
          yield { type: 'result', is_error: false, result: 'First reply' };
          await prompt.next();
          yield prelude;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Second reply' }] },
          };
          yield { type: 'result', is_error: false, result: 'Second reply' };
        })(),
    );

    const session = new ClaudeCodeProvider().createSession(
      withLegacyResumeSessionId(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        'resumed-session',
      ),
      onEvent,
      getNoWindow,
    );
    await flush();
    await flush();
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ origin: { kind: 'task_notification' } }),
    );

    session.sendMessage('First', { userMessageId: 'user-message-1' });
    await flush();
    await flush();
    session.sendMessage('Second', { userMessageId: 'user-message-2' });
    await flush();
    await flush();

    const emitted: unknown[] = onEvent.mock.calls.map(
      ([event]): unknown => event,
    );
    expect(
      emitted.filter(
        (event) =>
          readEventType(event) === 'result' &&
          readEventBoolean(event, 'canopy_session_continues') === true,
      ),
    ).toHaveLength(3);
    expect(
      emitted.filter(
        (event) =>
          readEventType(event) === 'result' &&
          readEventString(event, 'result') === 'First reply',
      ),
    ).toEqual([
      expect.objectContaining({
        canopy_turn_user_message_id: 'user-message-1',
      }),
    ]);
    expect(
      emitted.filter(
        (event) =>
          readEventType(event) === 'result' &&
          readEventString(event, 'result') === 'Second reply',
      ),
    ).toEqual([
      expect.objectContaining({
        canopy_turn_user_message_id: 'user-message-2',
      }),
    ]);
    expect(mockedMarkTurnIdle).toHaveBeenCalledTimes(2);

    await session.destroy();
  });

  it('drops a task-notification prelude received behind a held foreground terminal', async () => {
    const resultAdmissionStarted = createGate();
    const allowResultAdmission = createGate();
    const preludeRead = createGate();
    const allowStreamExit = createGate();
    const events: unknown[] = [];
    const prelude = {
      type: 'result',
      is_error: false,
      num_turns: 0,
      result: '',
      origin: { kind: 'task_notification' },
    };
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'assistant',
            message: {
              id: 'foreground-before-prelude',
              content: [{ type: 'text', text: 'foreground response' }],
            },
          };
          yield {
            type: 'result',
            is_error: false,
            result: 'Foreground complete',
          };
          yield prelude;
          preludeRead.release();
          await allowStreamExit.promise;
        })(),
    );

    const session = new ClaudeCodeProvider().createSession(
      withLegacyResumeSessionId(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'prelude-after-held-terminal',
        },
        'resumed-session',
      ),
      (event: unknown) => {
        events.push(event);
        if (
          readEventType(event) === 'result' &&
          readEventString(event, 'result') === 'Foreground complete'
        ) {
          resultAdmissionStarted.release();
          return allowResultAdmission.promise;
        }
      },
      getNoWindow,
    );

    session.sendMessage('Foreground prompt', {
      userMessageId: 'foreground-message',
    });
    try {
      await resultAdmissionStarted.promise;
      await preludeRead.promise;
      for (let attempts = 0; attempts < 10; attempts += 1) await flush();
      allowResultAdmission.release();
      allowStreamExit.release();
      await session.destroy();

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'result',
          result: 'Foreground complete',
          canopy_turn_user_message_id: 'foreground-message',
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ origin: { kind: 'task_notification' } }),
      );
    } finally {
      allowResultAdmission.release();
      allowStreamExit.release();
      await session.destroy();
    }
  });

  it('emits safety-net cleanup for a later unfinished foreground turn on an already-used query', async () => {
    const onEvent = jest.fn();
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield { type: 'result', is_error: false, result: 'First done' };
          await prompt.next();
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Second partial' }] },
          };
        })(),
    );

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );
    session.sendMessage('First', { userMessageId: 'user-message-1' });
    await flush();
    await flush();
    session.sendMessage('Second', { userMessageId: 'user-message-2' });
    await flush();
    await flush();
    await flush();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        result: 'Session ended',
        canopy_turn_user_message_id: 'user-message-2',
      }),
    );
    expect(mockedMarkTurnIdle).toHaveBeenCalledTimes(2);

    await session.destroy();
  });

  it('emits safety-net cleanup when a later foreground turn is still pending as an already-used query ends', async () => {
    const onEvent = jest.fn();
    let releaseQuery = (): void => undefined;
    const queryExitGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield { type: 'result', is_error: false, result: 'First done' };
          await queryExitGate;
        })(),
    );

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );
    session.sendMessage('First', { userMessageId: 'user-message-1' });
    await flush();
    await flush();
    session.sendMessage('Second pending', {
      userMessageId: 'user-message-2',
    });
    releaseQuery();
    await flush();
    await flush();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        result: 'Session ended',
        canopy_turn_user_message_id: 'user-message-2',
      }),
    );

    await session.destroy();
  });

  it('does not add a safety-net result after a pending foreground startup error', async () => {
    const onEvent = jest.fn();
    mockQuery.mockImplementation(() =>
      // eslint-disable-next-line require-yield -- models SDK startup failure before any stream event
      (async function* (): AsyncGenerator<unknown, void> {
        await Promise.resolve();
        throw new Error('SDK startup failed');
      })(),
    );

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );
    session.sendMessage('Pending at startup', {
      userMessageId: 'user-message-1',
    });
    await flush();
    await flush();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        error: 'SDK startup failed',
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        result: 'Session ended',
      }),
    );

    await session.destroy();
  });

  it('keeps completed task-notification turns terminal', async () => {
    const onEvent = jest.fn();
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'result',
            is_error: false,
            num_turns: 1,
            result: 'Background task completed',
            origin: { kind: 'task-notification' },
          };
        })(),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      withLegacyResumeSessionId(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        'resumed-session',
      ),
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Continue', { userMessageId: 'user-message-1' });
    await flush();
    await flush();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        num_turns: 1,
        result: 'Background task completed',
        origin: { kind: 'task-notification' },
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        canopy_session_continues: true,
      }),
    );
    expect(mockedMarkTurnIdle).toHaveBeenCalledTimes(1);

    await session.destroy();
  });

  it('tags the safety-net Session ended terminal with the active user message id', async () => {
    mockGetChildToolLiveness.mockReturnValue({
      kind: 'known',
      liveParentToolUseIds: ['still-reported-child'],
      hasUncorrelatedLiveTask: false,
    });
    const onEvent = jest.fn();
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
        // eslint-disable-next-line require-yield -- models SDK stream ending without a terminal result
        async function* noResultQuery(): AsyncGenerator<unknown, void> {
          await prompt.next();
        }
        return noResultQuery();
      },
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Do work', { userMessageId: 'user-message-1' });
    await flush();
    await flush();
    await flush();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        result: 'Session ended',
        canopy_turn_user_message_id: 'user-message-1',
        [CHILD_TOOL_LIVENESS_STAMP]: { kind: 'no-live-session' },
      }),
    );

    await session.destroy();
  });

  it('retains approval identity when the host binds a managed Claude tool, and rejects changed arguments', async () => {
    mockManagedDelegationEnabled.mockReturnValue(true);
    mockApprovalCheck.mockResolvedValue({ decision: 'allow' });
    const original = {
      model: 'gpt-6-sol',
      description: 'Review',
      prompt: 'Inspect source',
    };
    const bound = { ...original, _hostCorrelation: 'host-issued-token' };
    mockCreateManagedDelegationSession.mockResolvedValue(
      createManagedDelegationStub({
        ownsTool: (name) => name === 'mcp__canopy__DelegateTask',
        bareClaudeName: () => 'DelegateTask',
        parent: { bindClaude: () => ({ ok: true, value: bound }) },
      }),
    );
    mockQuery.mockReturnValue(makeMessages([]));
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'bound-approval',
        approvalMode: 'ask',
      },
      jest.fn(),
      getNoWindow,
    );
    session.sendMessage('Delegate a review');
    await flush();
    const options = mockQuery.mock.calls[0]?.[0]?.options;
    const signal = new AbortController().signal;
    for (const entry of options?.hooks?.PreToolUse ?? []) {
      if (entry.matcher !== '*') continue;
      for (const hook of entry.hooks)
        await hook(
          {
            hook_event_name: 'PreToolUse',
            session_id: 'session',
            transcript_path: '/tmp/transcript',
            cwd: '/tmp/repo',
            tool_name: 'mcp__canopy__DelegateTask',
            tool_input: original,
            tool_use_id: 'managed-call',
          },
          'managed-call',
          { signal },
        );
    }
    const canUseTool = options?.canUseTool;
    if (!canUseTool) throw new Error('Missing approval callback');
    expect(
      await canUseTool('mcp__canopy__DelegateTask', bound, {
        requestId: 'managed-call',
        toolUseID: 'managed-call',
        signal,
      }),
    ).toMatchObject({ behavior: 'allow' });
    expect(
      await canUseTool(
        'mcp__canopy__DelegateTask',
        { ...bound, prompt: 'Different task' },
        { requestId: 'managed-call', toolUseID: 'managed-call', signal },
      ),
    ).toMatchObject({ behavior: 'deny' });
    await session.destroy();
  });

  it('binds an unlisted WatchDelegates call in PreToolUse', async () => {
    mockManagedDelegationEnabled.mockReturnValue(true);
    let options: ManagedDelegationSessionOptions | undefined;
    const broker = {
      spawn: jest.fn(),
      getOutput: jest.fn(),
      inspect: jest.fn(),
      list: jest.fn(),
      stop: jest.fn(),
      closeOwner: jest.fn(),
    };
    const parent = new DelegationParent({
      harness: 'claude',
      namespace: 'canopy',
      names: {
        spawn: 'DelegateTask',
        output: 'GetDelegateOutput',
        inspect: 'InspectDelegate',
        list: 'ListDelegates',
        stop: 'StopDelegate',
      },
      owner: {
        harnessId: 'claude',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'project/worktree/chat',
        runtimeGeneration: 1,
        depth: 0,
      },
      broker,
      currentTurn: (): string | undefined => options?.currentTurn(),
      removeQueued: (): Promise<void> => Promise.resolve(),
      reportError: (): void => undefined,
    });

    const bind = jest.spyOn(parent, 'bindClaude');
    mockCreateManagedDelegationSession.mockImplementation((value) => {
      options = value;
      return Promise.resolve(
        createManagedDelegationStub({
          parent: {
            bindClaude: (...args) => parent.bindClaude(...args),
            invokeClaude: (...args) => parent.invokeClaude(...args),
          },
          ownsTool: (name) => parent.ownsTool(name),
          bareClaudeName: (name) => name.replace('mcp__canopy__', ''),
        }),
      );
    });
    const end = createGate();
    mockQuery.mockImplementation(() =>
      (async function* (): AsyncGenerator<unknown, void> {
        await end.promise;
        yield { type: 'result', is_error: false, result: 'Done' };
      })(),
    );
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      getNoWindow,
    );
    try {
      session.sendMessage('Resume');
      await flush();
      expect(parent.projection.tools.map((tool) => tool.name)).not.toContain(
        'WatchDelegates',
      );
      const input = { mode: 'all' };
      await invokeClaudePreToolUse(
        claudeQueryParams(),
        'mcp__canopy__WatchDelegates',
        input,
        'old-call',
      );
      expect(bind).toHaveBeenCalledWith(
        'WatchDelegates',
        input,
        'old-call',
        undefined,
      );
      const bound: unknown = bind.mock.results[0]?.value;
      if (
        !bound ||
        typeof bound !== 'object' ||
        !('ok' in bound) ||
        bound.ok !== true ||
        !('value' in bound)
      )
        throw new Error('Expected a host binding');
      expect(await parent.invokeClaude('WatchDelegates', bound.value)).toEqual({
        ok: true,
        value: {
          watcherId: 'delegation-notices-automatic',
          mode: 'all',
          deadlineAt: 0,
          targets: [],
          message:
            'Delegate completion notices now arrive automatically; no watch is needed.',
        },
      });
      await expect(
        invokeClaudePreToolUse(
          claudeQueryParams(),
          'mcp__canopy__WatchDelegates',
          input,
          'agent-call',
          'foreign-agent',
        ),
      ).rejects.toThrow('The owning parent turn is unavailable.');
      expect(bind.mock.results.at(-1)?.value).toMatchObject({
        ok: false,
        error: { code: 'parent_unavailable' },
      });
      end.release();
      await flush();
      expect(
        await parent.invokeClaude('WatchDelegates', bound.value),
      ).toMatchObject({ ok: false });
      Object.values(broker).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    } finally {
      end.release();
      await session.destroy();
    }
  });

  it('appends managed delegation steering to the Claude system prompt', async () => {
    mockManagedDelegationEnabled.mockReturnValue(true);
    mockCreateManagedDelegationSession.mockResolvedValue(
      createManagedDelegationStub({
        systemPromptGuidance: 'Managed delegation: watch completions.',
      }),
    );
    mockQuery.mockReturnValue(makeMessages([]));
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'delegation-steering',
        systemPromptAppend: 'Base appendix',
      },
      jest.fn(),
      getNoWindow,
    );
    session.sendMessage('Delegate a review');
    await flush();
    expect(mockQuery.mock.calls[0]?.[0]?.options?.systemPrompt).toMatchObject({
      append: 'Base appendix\n\nManaged delegation: watch completions.',
    });
    await session.destroy();
  });

  it('keeps AgentSession.cancel destructive for teardown and detaches delegations', async () => {
    mockManagedDelegationEnabled.mockReturnValue(true);
    const managed = {
      ...createManagedDelegationStub(),
      close: jest.fn(),
      cancel: jest.fn(),
    };
    mockCreateManagedDelegationSession.mockResolvedValue(managed);
    mockQuery.mockReturnValue(makeMessages([]));
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'delegation-stop',
      },
      jest.fn(),
      getNoWindow,
    );
    session.sendMessage('Delegate a review');
    await flush();
    const abortController = claudeQueryParams().options?.abortController;

    await session.cancel();
    await flush();

    // The Claude query ends; the chat's delegates keep running under the
    // chat-scoped owner until a separate teardown closes them.
    expect(abortController?.signal.aborted).toBe(true);
    expect(session.isDisposed?.()).toBe(true);
    expect(managed.detach).toHaveBeenCalled();
    expect(managed.close).not.toHaveBeenCalled();
    expect(managed.cancel).not.toHaveBeenCalled();
    await session.destroy();
  });

  it('finishes session cleanup when cancelled during delegation initialization', async () => {
    const onEvent = jest.fn();
    let finishInitialization = (): void => undefined;
    const detachDelegation = jest.fn();
    mockManagedDelegationEnabled.mockReturnValue(true);
    mockCreateManagedDelegationSession.mockReturnValue(
      new Promise<ManagedDelegationSessionStub>((resolveInitialization) => {
        finishInitialization = (): void =>
          resolveInitialization(
            createManagedDelegationStub({ detach: detachDelegation }),
          );
      }),
    );
    mockQuery.mockReturnValue(makeMessages([]));
    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'delegation-initialization-cancel',
      },
      onEvent,
      getNoWindow,
    );
    session.sendMessage('Do work', { userMessageId: 'user-message-1' });
    await flush();
    await session.cancel();
    finishInitialization();
    await flush();
    await flush();

    expect(mockQuery).toHaveBeenCalled();
    expect(mockedUnregisterSession).toHaveBeenCalledWith(
      'project/worktree/delegation-initialization-cancel',
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        result: 'Session ended',
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
    expect(detachDelegation).toHaveBeenCalledTimes(1);
    await session.destroy();
  });

  describe('autonomous Claude turn ownership', () => {
    beforeEach(() => {
      mockLoadCachedInventory.mockResolvedValue(null);
    });
    it('anchors a resumed wake with no dispatched user message to itself and warns once', async () => {
      const warning = jest.spyOn(MainProcessLogging, 'logMainProcessWarn');
      mockManagedDelegationEnabled.mockReturnValue(true);
      let options: ManagedDelegationSessionOptions | undefined;
      mockCreateManagedDelegationSession.mockImplementation((value) => {
        options = value;
        return Promise.resolve(createManagedDelegationStub());
      });
      const firstInit = createGate();
      const secondWake = createGate();
      const secondInit = createGate();
      const done = createGate();
      mockQuery.mockImplementation(() =>
        (async function* (): AsyncGenerator<unknown, void> {
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'resumed',
          };
          firstInit.release();
          await secondWake.promise;
          yield { type: 'result', is_error: false, result: 'first wake done' };
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'resumed',
          };
          secondInit.release();
          await done.promise;
        })(),
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'resumed-wake',
          sdkSessionId: 'resumed',
        },
        jest.fn(),
        getNoWindow,
      );
      try {
        await firstInit.promise;
        const wired = managedDelegationOptions(options);
        const first = wired.currentTurn();
        expect(first).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
        expect(wired.currentMessage?.()).toBe(first);
        expect(wired.currentMessage?.()).toBe(first);
        secondWake.release();
        await secondInit.promise;
        expect(wired.currentMessage?.()).toBe(wired.currentTurn());
        expect(wired.currentTurn()).not.toBe(first);
        expect(warning).toHaveBeenCalledTimes(1);
      } finally {
        secondWake.release();
        done.release();
        await session.destroy();
        warning.mockRestore();
      }
    });
    it('binds a Blackbird background Bash wake to its own turn and the dispatched user card', async () => {
      mockManagedDelegationEnabled.mockReturnValue(true);
      let delegationOptions: ManagedDelegationSessionOptions | undefined;
      const bindingContexts: ManagedDelegationBindingContext[] = [];
      const managed = createBindingManagedDelegationStub(
        () => delegationOptions,
        bindingContexts,
      );
      mockCreateManagedDelegationSession.mockImplementation((options) => {
        delegationOptions = options;
        return Promise.resolve(managed);
      });

      const promptPulled = createGate();
      const allowUserInit = createGate();
      const userInitEmitted = createGate();
      const allowUserBinding = createGate();
      const userResultEmitted = createGate();
      const allowWakeInit = createGate();
      const wakeInitEmitted = createGate();
      const allowStreamExit = createGate();
      const beforeUserInitTurn: Array<string | undefined> = [];
      mockQuery.mockImplementation((params) => {
        if (typeof params.prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const prompt = params.prompt[Symbol.asyncIterator]();
        return (async function* (): AsyncGenerator<unknown, void> {
          const userPrompt = await prompt.next();
          if (userPrompt.done) return;
          const userMessageUuid = readEventString(userPrompt.value, 'uuid');
          promptPulled.release();
          await allowUserInit.promise;
          beforeUserInitTurn.push(
            managedDelegationOptions(delegationOptions).currentTurn(),
          );
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'blackbird-session',
            ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
          };
          userInitEmitted.release();
          await allowUserBinding.promise;
          yield {
            type: 'system',
            subtype: 'task_started',
            task_id: 'blackbird-bash',
            task_type: 'local_bash',
            tool_use_id: 'background-bash-tool',
            is_backgrounded: true,
            description: 'Run a background Bash check',
            uuid: 'background-started',
            session_id: 'blackbird-session',
          };
          yield {
            type: 'result',
            is_error: false,
            result: 'Background Bash started',
          };
          userResultEmitted.release();
          yield {
            type: 'system',
            subtype: 'background_tasks_changed',
            tasks: [],
            uuid: 'background-empty',
            session_id: 'blackbird-session',
          };
          yield {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'blackbird-bash',
            tool_use_id: 'background-bash-tool',
            status: 'completed',
            output_file: '/tmp/blackbird-output',
            summary: 'Background Bash completed',
            uuid: 'background-completed',
            session_id: 'blackbird-session',
          };
          await allowWakeInit.promise;
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'blackbird-wake-session',
          };
          wakeInitEmitted.release();
          await allowStreamExit.promise;
        })();
      });

      const onEvent = jest.fn();
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'blackbird-wake-delegation',
          approvalMode: 'full-access',
        },
        onEvent,
        getNoWindow,
      );
      session.sendMessage('Start the background Bash check', {
        userMessageId: 'dispatched-user-message',
      });

      try {
        await flush();
        if (session.isDisposed?.())
          throw new Error(JSON.stringify(onEvent.mock.calls));
        await promptPulled.promise;
        allowUserInit.release();
        await userInitEmitted.promise;
        await invokeClaudePreToolUse(
          claudeQueryParams(),
          'mcp__canopy__DelegateTask',
          { prompt: 'Review the completed Bash check' },
          'user-turn-delegation',
        );
        allowUserBinding.release();
        await userResultEmitted.promise;
        allowWakeInit.release();
        await wakeInitEmitted.promise;
        await invokeClaudePreToolUse(
          claudeQueryParams(),
          'mcp__canopy__DelegateTask',
          { prompt: 'Summarize the completed Bash check' },
          'wake-turn-delegation',
        );

        const autonomousTurnId = bindingContexts[1]?.turnId;
        expect(beforeUserInitTurn).toEqual([undefined]);
        const userTurnId = bindingContexts[0]?.turnId;
        expect(userTurnId).toEqual(
          expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
        );
        expect(bindingContexts[0]).toEqual({
          turnId: userTurnId,
          messageId: 'dispatched-user-message',
        });
        expect(autonomousTurnId).toEqual(
          expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
        );
        expect(autonomousTurnId).not.toBe(userTurnId);
        expect(bindingContexts[1]).toEqual({
          turnId: autonomousTurnId,
          messageId: 'dispatched-user-message',
        });
      } finally {
        allowUserInit.release();
        allowUserBinding.release();
        allowWakeInit.release();
        allowStreamExit.release();
        await flush();
        await session.destroy();
      }
    });

    it('lazily creates the wake authority at a managed pre-init hook and reuses it through the root result', async () => {
      const startTurn = jest.spyOn(SkillUsageTracker.prototype, 'startTurn');
      mockManagedDelegationEnabled.mockReturnValue(true);
      let delegationOptions: ManagedDelegationSessionOptions | undefined;
      const bindingContexts: ManagedDelegationBindingContext[] = [];
      const managed = createBindingManagedDelegationStub(
        () => delegationOptions,
        bindingContexts,
      );
      mockCreateManagedDelegationSession.mockImplementation((options) => {
        delegationOptions = options;
        return Promise.resolve(managed);
      });

      const promptPulled = createGate();
      const beforeWakeHook = createGate();
      const allowPreInitHook = createGate();
      const wakeInitEmitted = createGate();
      const allowNestedEvents = createGate();
      const nestedEventsEmitted = createGate();
      const allowRootResult = createGate();
      const rootResultEmitted = createGate();
      const allowStreamExit = createGate();
      mockQuery.mockImplementation((params) => {
        if (typeof params.prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const prompt = params.prompt[Symbol.asyncIterator]();
        return (async function* (): AsyncGenerator<unknown, void> {
          const userPrompt = await prompt.next();
          if (userPrompt.done) return;
          const userMessageUuid = readEventString(userPrompt.value, 'uuid');
          promptPulled.release();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'user-session',
            ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
          };
          yield { type: 'result', is_error: false, result: 'User turn done' };
          beforeWakeHook.release();
          await allowPreInitHook.promise;
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'wake-session',
          };
          wakeInitEmitted.release();
          await allowNestedEvents.promise;
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: 'parent-tool-use',
            session_id: 'nested-session',
          };
          yield {
            type: 'result',
            is_error: false,
            result: 'Nested result only',
            parent_tool_use_id: 'parent-tool-use',
          };
          yield {
            type: 'error',
            error: 'Recoverable provider diagnostic',
            parent_tool_use_id: 'parent-tool-use',
          };
          nestedEventsEmitted.release();
          await allowRootResult.promise;
          yield { type: 'result', is_error: false, result: 'Wake done' };
          rootResultEmitted.release();
          await allowStreamExit.promise;
        })();
      });

      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'lazy-wake-authority',
          approvalMode: 'full-access',
        },
        jest.fn(),
        getNoWindow,
      );
      session.sendMessage('Finish the first turn', {
        userMessageId: 'first-user-turn',
      });

      try {
        await promptPulled.promise;
        await beforeWakeHook.promise;
        await invokeClaudePreToolUse(
          claudeQueryParams(),
          'mcp__canopy__DelegateTask',
          { prompt: 'Bind before init' },
          'pre-init-delegation',
        );
        const authorityBeforeInit = bindingContexts[0]?.turnId;
        allowPreInitHook.release();
        await wakeInitEmitted.promise;
        await invokeClaudePreToolUse(
          claudeQueryParams(),
          'mcp__canopy__DelegateTask',
          { prompt: 'Bind after init' },
          'post-init-delegation',
        );
        allowNestedEvents.release();
        await nestedEventsEmitted.promise;
        expect(delegationOptions?.currentTurn()).toBe(authorityBeforeInit);
        expect(
          trackedSkillTurnId(
            startTurn.mock.instances[startTurn.mock.instances.length - 1],
          ),
        ).toBe(authorityBeforeInit);
        await invokeClaudePreToolUse(
          claudeQueryParams(),
          'mcp__canopy__DelegateTask',
          { prompt: 'Bind after child result' },
          'post-child-result-delegation',
        );
        const authorityAfterChildResult = delegationOptions?.currentTurn();
        allowRootResult.release();
        await rootResultEmitted.promise;

        expect(authorityBeforeInit).toEqual(
          expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
        );
        expect(bindingContexts.map((context) => context.turnId)).toEqual([
          authorityBeforeInit,
          authorityBeforeInit,
          authorityBeforeInit,
        ]);
        expect(authorityAfterChildResult).toBe(authorityBeforeInit);
        expect(managed.observe).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'system',
            subtype: 'init',
            session_id: 'wake-session',
          }),
          authorityBeforeInit,
        );
        expect(delegationOptions?.currentTurn()).toBeUndefined();
      } finally {
        allowPreInitHook.release();
        allowNestedEvents.release();
        allowRootResult.release();
        allowStreamExit.release();
        await flush();
        await session.destroy();
        startTurn.mockRestore();
      }
    });

    it.each([false, true])(
      'opens one canonical lifecycle for a tool-started wake with late init=%s',
      async (emitWakeInit) => {
        const scope = {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: `tool-wake-${emitWakeInit}`,
        };
        const lifecycleEvents: unknown[] = [];
        const admittedEvents: unknown[] = [];
        releaseClaudeTurnLifecycleProducer(scope);
        setClaudeTurnLifecycleSink((event) => {
          lifecycleEvents.push(event);
        });
        mockHasCodeGraph.mockReturnValue(true);

        const promptPulled = createGate();
        const firstResultEmitted = createGate();
        const childHistoryEmitted = createGate();
        const allowWakeEvents = createGate();
        const wakeResultEmitted = createGate();
        const allowStreamExit = createGate();
        mockQuery.mockImplementation(({ prompt }) => {
          if (typeof prompt === 'string')
            throw new Error('Expected a streaming Claude prompt');
          const input = prompt[Symbol.asyncIterator]();
          return (async function* (): AsyncGenerator<unknown, void> {
            const first = await input.next();
            if (first.done) return;
            const userUuid = readEventString(first.value, 'uuid');
            promptPulled.release();
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: 'user-session',
              user_message_uuid: userUuid,
            };
            yield {
              type: 'assistant',
              uuid: 'first-answer',
              message: { content: [{ type: 'text', text: 'First answer' }] },
            };
            yield {
              type: 'result',
              is_error: false,
              result: 'First turn done',
              user_message_uuids: [userUuid],
            };
            firstResultEmitted.release();
            yield {
              type: 'system',
              subtype: 'task_notification',
              task_id: 'finished-task',
              tool_use_id: 'background-tool',
              status: 'completed',
            };
            // Child events and duplicate history are not proof of a new root.
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: 'child-tool',
              session_id: 'child-session',
            };
            yield {
              type: 'assistant',
              uuid: 'first-answer',
              parent_tool_use_id: 'child-tool',
              message: { content: [{ type: 'text', text: 'Child history' }] },
            };
            childHistoryEmitted.release();
            await allowWakeEvents.promise;
            if (emitWakeInit) {
              for (let index = 0; index < 2; index++)
                yield {
                  type: 'system',
                  subtype: 'init',
                  parent_tool_use_id: null,
                  session_id: 'wake-session',
                };
            }
            yield {
              type: 'assistant',
              uuid: 'wake-answer',
              message: { content: [{ type: 'text', text: 'Wake answer' }] },
            };
            yield { type: 'result', is_error: false, result: 'Wake done' };
            wakeResultEmitted.release();
            await allowStreamExit.promise;
          })();
        });

        const session = new ClaudeCodeProvider().createSession(
          {
            cwd: '/tmp/repo',
            ...scope,
            approvalMode: 'full-access',
            codeGraphToolsAdvertised: true,
          },
          (event) => {
            admittedEvents.push(event);
          },
          getNoWindow,
        );
        session.sendMessage('Inspect the change', {
          userMessageId: 'first-user-message',
        });

        const grepHook = async (
          toolUseId: string,
          agentId?: string,
        ): Promise<void> => {
          const hook = claudeQueryParams().options?.hooks?.PreToolUse?.find(
            (entry) => entry.matcher === '*',
          )?.hooks[0];
          if (!hook) throw new Error('Expected the root PreToolUse hook');
          await hook(
            {
              hook_event_name: 'PreToolUse',
              session_id: 'native-session',
              transcript_path: '/tmp/transcript.jsonl',
              cwd: '/tmp/repo',
              tool_name: 'Grep',
              tool_input: { pattern: 'needle', path: '/tmp/repo/src' },
              tool_use_id: toolUseId,
              ...(agentId ? { agent_id: agentId } : {}),
            },
            toolUseId,
            { signal: new AbortController().signal },
          );
        };
        const starts = (): unknown[] =>
          lifecycleEvents.filter(
            (event) =>
              readEventType(event) === 'TurnStarted' &&
              readEventString(event, 'phase') === 'start',
          );
        const ends = (): unknown[] =>
          lifecycleEvents.filter(
            (event) => readEventType(event) === 'TurnEnded',
          );

        try {
          await promptPulled.promise;
          await firstResultEmitted.promise;
          await childHistoryEmitted.promise;
          await flush();
          expect(starts()).toHaveLength(1);
          expect(ends()).toHaveLength(1);
          await grepHook('child-hook', 'child-agent');
          expect(starts()).toHaveLength(1);
          await grepHook('wake-root-hook');
          await grepHook('wake-root-hook-again');
          expect(starts()).toHaveLength(2);

          allowWakeEvents.release();
          await wakeResultEmitted.promise;
          await flush();
          expect(starts()).toHaveLength(2);
          expect(ends()).toHaveLength(2);
          const wakeTurnId = readEventString(starts()[1], 'turnId');
          expect(wakeTurnId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
          expect(wakeTurnId).not.toBe(readEventString(starts()[0], 'turnId'));
          expect(ends()[1]).toMatchObject({
            turnId: wakeTurnId,
            origin: 'autonomous',
            spawnedBy: {
              taskId: 'finished-task',
              toolUseId: 'background-tool',
            },
          });
          expect(
            admittedEvents.find(
              (event) => readEventString(event, 'uuid') === 'wake-answer',
            ),
          ).toBeDefined();
        } finally {
          allowWakeEvents.release();
          allowStreamExit.release();
          await flush();
          await session.destroy();
          setClaudeTurnLifecycleSink(null);
          releaseClaudeTurnLifecycleProducer(scope);
        }
        expect(starts()).toHaveLength(2);
        expect(ends()).toHaveLength(2);
      },
    );

    it.each(['cancel', 'destroy', 'provider-exit'])(
      'ignores a managed child hook and closes a no-init wake on %s',
      async (finish) => {
        const scope = {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'managed-child-no-init-wake',
        };
        const lifecycleEvents: unknown[] = [];
        const wakeEnded = createGate();
        releaseClaudeTurnLifecycleProducer(scope);
        setClaudeTurnLifecycleSink((event) => {
          lifecycleEvents.push(event);
          if (
            readEventType(event) === 'TurnEnded' &&
            readEventString(event, 'origin') === 'autonomous'
          )
            wakeEnded.release();
        });
        mockManagedDelegationEnabled.mockReturnValue(true);
        mockCreateManagedDelegationSession.mockResolvedValue(
          createManagedDelegationStub({ ownsTool: () => true }),
        );
        const firstResultEmitted = createGate();
        const allowStreamExit = createGate();
        mockQuery.mockImplementation(({ prompt }) => {
          if (typeof prompt === 'string')
            throw new Error('Expected a streaming Claude prompt');
          const input = prompt[Symbol.asyncIterator]();
          return (async function* (): AsyncGenerator<unknown, void> {
            const first = await input.next();
            if (first.done) return;
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: 'first-session',
              user_message_uuid: readEventString(first.value, 'uuid'),
            };
            yield { type: 'result', is_error: false, result: 'First done' };
            firstResultEmitted.release();
            await allowStreamExit.promise;
          })();
        });
        const session = new ClaudeCodeProvider().createSession(
          { cwd: '/tmp/repo', ...scope, approvalMode: 'full-access' },
          jest.fn(),
          getNoWindow,
        );
        session.sendMessage('First turn', {
          userMessageId: 'first-user-message',
        });
        const starts = (): unknown[] =>
          lifecycleEvents.filter(
            (event) =>
              readEventType(event) === 'TurnStarted' &&
              readEventString(event, 'phase') === 'start',
          );
        const ends = (): unknown[] =>
          lifecycleEvents.filter(
            (event) => readEventType(event) === 'TurnEnded',
          );

        try {
          await firstResultEmitted.promise;
          await flush();
          expect(starts()).toHaveLength(1);
          expect(ends()).toHaveLength(1);
          expect(
            claudeQueryParams().options?.hooks?.PreToolUse?.filter(
              (entry) => entry.matcher === '*',
            ),
          ).toHaveLength(2);
          await invokeClaudePreToolUse(
            claudeQueryParams(),
            'mcp__canopy__GetCodeGraphContext',
            {},
            'child-call',
            'child-agent',
          );
          expect(starts()).toHaveLength(1);
          await invokeClaudePreToolUse(
            claudeQueryParams(),
            'mcp__canopy__GetCodeGraphContext',
            {},
            'root-call',
          );
          expect(starts()).toHaveLength(2);
          if (finish === 'cancel') await session.cancel();
          const disposal = finish === 'destroy' ? session.destroy() : undefined;
          allowStreamExit.release();
          await wakeEnded.promise;
          expect(ends()).toHaveLength(2);
          await disposal;
          await session.destroy();
          expect(ends()).toHaveLength(2);
          expect(ends()[1]).toMatchObject({
            turnId: readEventString(starts()[1], 'turnId'),
            outcome: 'cancelled',
          });
        } finally {
          allowStreamExit.release();
          await session.destroy();
          setClaudeTurnLifecycleSink(null);
          releaseClaudeTurnLifecycleProducer(scope);
        }
        expect(starts()).toHaveLength(2);
        expect(ends()).toHaveLength(2);
      },
    );

    it.each([false, true])(
      'accepts steering during a tool-started wake without replacing its identity (init=%s)',
      async (emitWakeInit) => {
        mockManagedDelegationEnabled.mockReturnValue(true);
        let delegationOptions: ManagedDelegationSessionOptions | undefined;
        const bindingContexts: ManagedDelegationBindingContext[] = [];
        const managed = createBindingManagedDelegationStub(
          () => delegationOptions,
          bindingContexts,
        );
        mockCreateManagedDelegationSession.mockImplementation((options) => {
          delegationOptions = options;
          return Promise.resolve(managed);
        });

        const promptPulled = createGate();
        const beforeWakeInit = createGate();
        const allowWakeInit = createGate();
        const wakeInitEmitted = createGate();
        const allowSteeringPull = createGate();
        const steeringPromptPulled = createGate();
        const allowSteeringLifecycle = createGate();
        const steeringStarted = createGate();
        const allowWakeResult = createGate();
        const wakeResultEmitted = createGate();
        const allowStreamExit = createGate();
        let steeringPrompt: unknown;
        mockQuery.mockImplementation((params) => {
          if (typeof params.prompt === 'string')
            throw new Error('Expected a streaming Claude prompt');
          const prompt = params.prompt[Symbol.asyncIterator]();
          const stream = (async function* (): AsyncGenerator<unknown, void> {
            await prompt.next();
            promptPulled.release();
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: 'user-session',
              capabilities: [
                'msg_lifecycle_v1',
                'interrupt_receipt_v1',
                'interrupt_cancel_queued_v1',
              ],
            };
            yield { type: 'result', is_error: false, result: 'User turn done' };
            beforeWakeInit.release();
            await allowWakeInit.promise;
            if (emitWakeInit)
              yield {
                type: 'system',
                subtype: 'init',
                parent_tool_use_id: null,
                session_id: 'wake-session',
                capabilities: [
                  'msg_lifecycle_v1',
                  'interrupt_receipt_v1',
                  'interrupt_cancel_queued_v1',
                ],
              };
            wakeInitEmitted.release();
            await allowSteeringPull.promise;
            const next = await prompt.next();
            if (next.done) return;
            steeringPrompt = next.value;
            steeringPromptPulled.release();
            await allowSteeringLifecycle.promise;
            yield {
              type: 'command_lifecycle',
              command_uuid: 'wake-steering-attempt',
              state: 'queued',
            };
            yield {
              type: 'command_lifecycle',
              command_uuid: 'wake-steering-attempt',
              state: 'started',
            };
            steeringStarted.release();
            await allowWakeResult.promise;
            yield { type: 'result', is_error: false, result: 'Wake finished' };
            wakeResultEmitted.release();
            await allowStreamExit.promise;
          })();
          return Object.assign(stream, {
            cancelAsyncMessage: jest.fn(() => Promise.resolve(true)),
            interrupt: jest.fn(() =>
              Promise.resolve({ cancelled: [], still_queued: [] }),
            ),
          });
        });

        const session = new ClaudeCodeProvider().createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'steer-autonomous-wake',
          },
          jest.fn(),
          getNoWindow,
        );
        session.sendMessage('Start work', { userMessageId: 'first-user-turn' });
        let admission: unknown;
        let authorityBeforePickup: string | undefined;
        let authorityAfterPickup: string | undefined;

        try {
          await promptPulled.promise;
          await beforeWakeInit.promise;
          await invokeClaudePreToolUse(
            claudeQueryParams(),
            'mcp__canopy__DelegateTask',
            { prompt: 'Review the completed work' },
            'wake-tool-before-init',
          );
          allowWakeInit.release();
          await wakeInitEmitted.promise;
          const steeringSupported = session.getSteeringCapabilities?.().steer;
          const submission = session.submitSteeringInput?.(
            'Keep the wake focused',
            'wake-steering-attempt',
            'steering-user-message',
          );
          authorityBeforePickup = delegationOptions?.currentTurn();
          allowSteeringPull.release();
          if (steeringSupported) {
            await steeringPromptPulled.promise;
            authorityAfterPickup = delegationOptions?.currentTurn();
            allowSteeringLifecycle.release();
            await steeringStarted.promise;
            admission = await submission;
            allowWakeResult.release();
            await wakeResultEmitted.promise;
          }

          expect(steeringSupported).toBe(true);
          expect(admission).toEqual(
            expect.objectContaining({
              kind: 'accepted',
              attemptId: 'wake-steering-attempt',
            }),
          );
          expect(steeringPrompt).toMatchObject({
            uuid: 'wake-steering-attempt',
            message: {
              role: 'user',
              content: 'Keep the wake focused',
            },
          });
          expect(authorityBeforePickup).toEqual(
            expect.stringMatching(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            ),
          );
          expect(authorityAfterPickup).toBe(authorityBeforePickup);
        } finally {
          allowWakeInit.release();
          allowSteeringPull.release();
          allowSteeringLifecycle.release();
          allowWakeResult.release();
          allowStreamExit.release();
          await flush();
          await session.destroy();
        }
      },
    );

    it('keeps Interrupt pending until the autonomous root result is durably admitted', async () => {
      const promptPulled = createGate();
      const wakeInitEmitted = createGate();
      const allowWakeResult = createGate();
      const wakeResultEmitted = createGate();
      const terminalAdmissionStarted = createGate();
      const allowTerminalAdmission = createGate();
      const allowStreamExit = createGate();
      mockQuery.mockImplementation((params) => {
        if (typeof params.prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const prompt = params.prompt[Symbol.asyncIterator]();
        const stream = (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          promptPulled.release();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'user-session',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          yield { type: 'result', is_error: false, result: 'User turn done' };
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'wake-session',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          wakeInitEmitted.release();
          await allowWakeResult.promise;
          yield { type: 'result', is_error: false, result: 'Wake interrupted' };
          wakeResultEmitted.release();
          await allowStreamExit.promise;
        })();
        return Object.assign(stream, {
          cancelAsyncMessage: jest.fn(() => Promise.resolve(true)),
          interrupt: jest.fn(() =>
            Promise.resolve({ cancelled: [], still_queued: [] }),
          ),
        });
      });

      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'interrupt-autonomous-wake',
        },
        (event: unknown) => {
          if (readEventString(event, 'result') === 'Wake interrupted') {
            terminalAdmissionStarted.release();
            return allowTerminalAdmission.promise;
          }
        },
        getNoWindow,
      );
      session.sendMessage('Start work', { userMessageId: 'first-user-turn' });
      let interruptSettled = false;
      let interruption: Promise<void> | undefined;

      try {
        await promptPulled.promise;
        await wakeInitEmitted.promise;
        interruption = session.interruptWithPendingSweep?.();
        void interruption?.then(() => {
          interruptSettled = true;
        });
        await flush();
        const settledBeforeRootResult = interruptSettled;
        allowWakeResult.release();
        await wakeResultEmitted.promise;
        await terminalAdmissionStarted.promise;
        let lateInterruptSettled = false;
        const lateInterruption = session.interruptWithPendingSweep?.();
        void lateInterruption?.then(() => {
          lateInterruptSettled = true;
        });
        await flush();
        expect(settledBeforeRootResult).toBe(false);
        expect(interruptSettled).toBe(false);
        expect(lateInterruptSettled).toBe(false);
        allowTerminalAdmission.release();
        await interruption;
        await lateInterruption;

        expect(lateInterruptSettled).toBe(true);
        expect(interruptSettled).toBe(true);
      } finally {
        allowTerminalAdmission.release();
        allowWakeResult.release();
        allowStreamExit.release();
        await flush();
        await session.destroy();
      }
    });

    const pickedPromptFifoFlows: Array<
      'eager-wake' | 'before-init' | 'cancelled-wake'
    > = ['eager-wake', 'before-init', 'cancelled-wake'];
    it.each(pickedPromptFifoFlows)(
      'binds picked prompts only from provider UUID evidence: %s',
      async (flow) => {
        mockManagedDelegationEnabled.mockReturnValue(true);
        let delegationOptions: ManagedDelegationSessionOptions | undefined;
        const bindingContexts: ManagedDelegationBindingContext[] = [];
        const managed = createBindingManagedDelegationStub(
          () => delegationOptions,
          bindingContexts,
        );
        mockCreateManagedDelegationSession.mockImplementation((options) => {
          delegationOptions = options;
          return Promise.resolve(managed);
        });
        const secondPromptPulled = createGate();
        const wakeInitEmitted = createGate();
        const allowSecondPrompt = createGate();
        const cancelledLifecycleObserved = createGate();
        const allowRootInit = createGate();
        const rootInitEmitted = createGate();
        const allowRootResult = createGate();
        const rootResultEmitted = createGate();
        const rootResultAdmitted = createGate();
        const allowRootResultAdmission = createGate();
        const thirdInitEmitted = createGate();
        const allowStreamExit = createGate();
        const uuidPattern =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let firstUuid: string | undefined;
        let secondUuid: string | undefined;
        let thirdPromptSent = false;
        mockQuery.mockImplementation((params) => {
          if (typeof params.prompt === 'string')
            throw new Error('Expected a streaming Claude prompt');
          const prompt = params.prompt[Symbol.asyncIterator]();
          const uuidOf = (value: unknown): string => {
            const uuid = readEventString(value, 'uuid');
            if (!uuid) throw new Error('Expected a picked prompt UUID');
            return uuid;
          };
          const init = (sessionId: string): Record<string, unknown> => ({
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: sessionId,
          });
          return (async function* (): AsyncGenerator<unknown, void> {
            const first = await prompt.next();
            if (first.done) return;
            const aUuid = uuidOf(first.value);
            firstUuid = aUuid;
            let resultUuid = aUuid;
            let resultUuids = [aUuid];

            const pickSecond = async (): Promise<string> => {
              const second = await prompt.next();
              if (second.done) throw new Error('Expected the second prompt');
              const bUuid = uuidOf(second.value);
              secondUuid = bUuid;
              secondPromptPulled.release();
              return bUuid;
            };
            if (flow === 'before-init') {
              const bUuid = await pickSecond();
              await allowRootInit.promise;
              yield init('pre-init-root');
              rootInitEmitted.release();
              resultUuid = bUuid;
              resultUuids = [aUuid, bUuid];
            } else {
              yield init('first-user-session');
              yield {
                type: 'result',
                is_error: false,
                result: 'First turn done',
              };
              yield init('wake-session');
              wakeInitEmitted.release();
              await allowSecondPrompt.promise;
              const bUuid = await pickSecond();
              if (flow === 'cancelled-wake') {
                yield {
                  type: 'command_lifecycle',
                  parent_tool_use_id: null,
                  command_uuid: bUuid,
                  state: 'cancelled',
                };
                cancelledLifecycleObserved.release();
              } else {
                resultUuid = bUuid;
                resultUuids = [bUuid];
              }
            }

            await allowRootResult.promise;
            yield {
              type: 'result',
              is_error: false,
              result: 'Root turn done',
              user_message_uuid: resultUuid,
              user_message_uuids: resultUuids,
            };
            rootResultEmitted.release();
            const third = await prompt.next();
            if (third.done) return;
            const thirdUuid = uuidOf(third.value);
            yield {
              ...init('third-user-session'),
              user_message_uuid: thirdUuid,
            };
            thirdInitEmitted.release();
            await allowStreamExit.promise;
          })();
        });
        const session = new ClaudeCodeProvider().createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: `picked-prompt-fifo-${flow}`,
          },
          (event: unknown) => {
            if (readEventString(event, 'result') === 'Root turn done') {
              rootResultAdmitted.release();
              return allowRootResultAdmission.promise;
            }
          },
          getNoWindow,
        );
        session.sendMessage('Prompt A', { userMessageId: 'message-A' });
        if (flow === 'before-init')
          session.sendMessage('Prompt B', { userMessageId: 'message-B' });
        try {
          if (flow === 'before-init') {
            await secondPromptPulled.promise;
            allowRootInit.release();
            await rootInitEmitted.promise;
          } else {
            await wakeInitEmitted.promise;
            const options = managedDelegationOptions(delegationOptions);
            const wakeAuthority = options.currentTurn();
            expect(wakeAuthority).toEqual(expect.stringMatching(uuidPattern));
            session.sendMessage('Prompt B', { userMessageId: 'message-B' });
            allowSecondPrompt.release();
            await secondPromptPulled.promise;
            expect(options.currentTurn()).toBe(wakeAuthority);
            if (flow === 'cancelled-wake') {
              await cancelledLifecycleObserved.promise;
              expect(managed.observe).toHaveBeenCalledWith(
                expect.objectContaining({
                  type: 'command_lifecycle',
                  parent_tool_use_id: null,
                  command_uuid: secondUuid,
                  state: 'cancelled',
                }),
                expect.anything(),
              );
              expect(options.currentTurn()).toBe(wakeAuthority);
            }
          }
          expect(secondUuid).toEqual(expect.stringMatching(uuidPattern));
          allowRootResult.release();
          await rootResultEmitted.promise;
          await rootResultAdmitted.promise;
          const aUuid = firstUuid;
          const bUuid = secondUuid;
          if (!aUuid || !bUuid) throw new Error('Expected picked prompt UUIDs');
          const resultUuids =
            flow === 'before-init'
              ? [aUuid, bUuid]
              : flow === 'eager-wake'
                ? [bUuid]
                : [aUuid];
          expect(managed.observe).toHaveBeenCalledWith(
            expect.objectContaining({
              type: 'result',
              user_message_uuid: flow === 'cancelled-wake' ? aUuid : bUuid,
              user_message_uuids: resultUuids,
            }),
            expect.anything(),
          );
          session.sendMessage('Prompt C', { userMessageId: 'message-C' });
          thirdPromptSent = true;
          await thirdInitEmitted.promise;
          const options = managedDelegationOptions(delegationOptions);
          const thirdTurnId = options.currentTurn();
          expect(thirdTurnId).toEqual(expect.stringMatching(uuidPattern));
          expect(thirdTurnId).not.toBe('message-C');
          expect(options.currentMessage?.()).toBe('message-C');
          await invokeClaudePreToolUse(
            claudeQueryParams(),
            'mcp__canopy__DelegateTask',
            { prompt: 'Bind the third prompt' },
            'picked-fifo-third-turn',
          );
          expect(bindingContexts[bindingContexts.length - 1]).toEqual({
            turnId: thirdTurnId,
            messageId: 'message-C',
          });
        } finally {
          allowRootResultAdmission.release();
          allowSecondPrompt.release();
          allowRootInit.release();
          allowRootResult.release();
          if (!thirdPromptSent)
            session.sendMessage('Prompt C', { userMessageId: 'message-C' });
          allowStreamExit.release();
          await flush();
          await session.destroy();
        }
      },
    );

    it('keeps an eagerly picked ordinary prompt from replacing wake authority and starts it at the next init', async () => {
      mockManagedDelegationEnabled.mockReturnValue(true);
      let delegationOptions: ManagedDelegationSessionOptions | undefined;
      const managed = createManagedDelegationStub();
      mockCreateManagedDelegationSession.mockImplementation((options) => {
        delegationOptions = options;
        return Promise.resolve(managed);
      });

      const initialPromptPulled = createGate();
      const wakeInitEmitted = createGate();
      const allowEagerPull = createGate();
      const queuedPromptPulled = createGate();
      const allowWakeResult = createGate();
      const wakeResultEmitted = createGate();
      const nextUserInitEmitted = createGate();
      const allowStreamExit = createGate();
      let queuedPrompt: unknown;
      let queuedPromptUuid: string | undefined;
      let authorityWithPendingPrompt: string | undefined;
      let anchorWithPendingPrompt: string | undefined;
      let authorityAfterEagerPickup: string | undefined;
      let anchorAfterEagerPickup: string | undefined;
      mockQuery.mockImplementation((params) => {
        if (typeof params.prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const prompt = params.prompt[Symbol.asyncIterator]();
        return (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          initialPromptPulled.release();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'user-session',
          };
          yield { type: 'result', is_error: false, result: 'User turn done' };
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'wake-session',
          };
          wakeInitEmitted.release();
          await allowEagerPull.promise;
          const next = await prompt.next();
          if (next.done) return;
          queuedPrompt = next.value;
          queuedPromptUuid = readEventString(next.value, 'uuid');
          authorityAfterEagerPickup = delegationOptions?.currentTurn();
          anchorAfterEagerPickup = delegationOptions?.currentMessage?.();
          queuedPromptPulled.release();
          await allowWakeResult.promise;
          yield { type: 'result', is_error: false, result: 'Wake finished' };
          wakeResultEmitted.release();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'queued-user-session',
            ...(queuedPromptUuid
              ? { user_message_uuid: queuedPromptUuid }
              : {}),
          };
          nextUserInitEmitted.release();
          await allowStreamExit.promise;
        })();
      });

      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'queued-prompt-during-wake',
        },
        jest.fn(),
        getNoWindow,
      );
      session.sendMessage('First user prompt', {
        userMessageId: 'first-dispatched-user',
      });

      try {
        await initialPromptPulled.promise;
        await wakeInitEmitted.promise;
        const options = managedDelegationOptions(delegationOptions);
        const wakeAuthority = options.currentTurn();
        session.sendMessage('Prompt queued during wake', {
          userMessageId: 'queued-user-message',
        });
        authorityWithPendingPrompt = options.currentTurn();
        anchorWithPendingPrompt = options.currentMessage?.();
        allowEagerPull.release();
        await queuedPromptPulled.promise;
        const dispatchedPromptAuthority = options.currentTurn();
        allowWakeResult.release();
        await wakeResultEmitted.promise;
        const authorityAfterWakeResult = options.currentTurn();
        await nextUserInitEmitted.promise;

        expect(wakeAuthority).toEqual(
          expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
        );
        expect(authorityWithPendingPrompt).toBe(wakeAuthority);
        expect(anchorWithPendingPrompt).toBe('first-dispatched-user');
        expect(authorityAfterEagerPickup).toBe(wakeAuthority);
        expect(anchorAfterEagerPickup).toBe('queued-user-message');
        expect(dispatchedPromptAuthority).toBe(wakeAuthority);
        expect(authorityAfterWakeResult).toBeUndefined();
        const queuedUserTurnId = options.currentTurn();
        expect(queuedUserTurnId).toEqual(
          expect.stringMatching(/^[0-9a-f-]{36}$/i),
        );
        expect(queuedUserTurnId).not.toBe(wakeAuthority);
        expect(options.currentMessage?.()).toBe('queued-user-message');
        expect(queuedPrompt).toMatchObject({
          message: {
            role: 'user',
            content: 'Prompt queued during wake',
          },
        });
      } finally {
        allowEagerPull.release();
        allowWakeResult.release();
        allowStreamExit.release();
        await flush();
        await session.destroy();
      }
    });

    it('starts a steering prompt picked up after a wake result as a user-origin turn', async () => {
      mockManagedDelegationEnabled.mockReturnValue(true);
      let delegationOptions: ManagedDelegationSessionOptions | undefined;
      const bindingContexts: ManagedDelegationBindingContext[] = [];
      const managed = createBindingManagedDelegationStub(
        () => delegationOptions,
        bindingContexts,
      );
      mockCreateManagedDelegationSession.mockImplementation((options) => {
        delegationOptions = options;
        return Promise.resolve(managed);
      });

      const initialPromptPulled = createGate();
      const wakeInitEmitted = createGate();
      const allowWakeResult = createGate();
      const prefixAdmissionStarted = createGate();
      const allowPrefixAdmission = createGate();
      const prefixAdmissionCompleted = createGate();
      const steeringPromptPulled = createGate();
      const allowNextUserInit = createGate();
      const nextUserInitEmitted = createGate();
      const allowSteeringLifecycle = createGate();
      const steeringPickedUpBeforeInit = createGate();
      const allowStreamExit = createGate();
      const pickups: unknown[] = [];
      let steeringPrompt: unknown;
      let authorityBeforeUserInit: string | undefined;
      let authorityAfterPickupBeforeInit: string | undefined;
      let steeringPromptPulledBeforeAdmission = false;
      mockQuery.mockImplementation((params) => {
        if (typeof params.prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const prompt = params.prompt[Symbol.asyncIterator]();
        const stream = (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          initialPromptPulled.release();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'user-session',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          yield { type: 'result', is_error: false, result: 'User turn done' };
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'wake-session',
            capabilities: [
              'msg_lifecycle_v1',
              'interrupt_receipt_v1',
              'interrupt_cancel_queued_v1',
            ],
          };
          wakeInitEmitted.release();
          await allowWakeResult.promise;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'held-wake-prefix' }] },
          };
          yield { type: 'result', is_error: false, result: 'Wake finished' };
          const next = await prompt.next();
          if (next.done) return;
          steeringPrompt = next.value;
          steeringPromptPulledBeforeAdmission = true;
          authorityBeforeUserInit = delegationOptions?.currentTurn();
          steeringPromptPulled.release();
          await allowSteeringLifecycle.promise;
          yield {
            type: 'command_lifecycle',
            command_uuid: 'late-steering-attempt',
            state: 'queued',
          };
          yield {
            type: 'command_lifecycle',
            command_uuid: 'late-steering-attempt',
            state: 'started',
          };
          authorityAfterPickupBeforeInit = delegationOptions?.currentTurn();
          steeringPickedUpBeforeInit.release();
          await allowNextUserInit.promise;
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'steering-user-session',
          };
          nextUserInitEmitted.release();
          await allowStreamExit.promise;
          yield {
            type: 'result',
            is_error: false,
            result: 'Steering turn done',
          };
          await allowStreamExit.promise;
        })();
        return Object.assign(stream, {
          cancelAsyncMessage: jest.fn(() => Promise.resolve(true)),
          interrupt: jest.fn(() =>
            Promise.resolve({ cancelled: [], still_queued: [] }),
          ),
        });
      });

      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'late-steering-pickup',
        },
        (event: unknown) => {
          if (
            readEventType(event) === 'canopy_input_delivery' &&
            readEventString(event, 'phase') === 'picked-up'
          )
            pickups.push(event);
          if (
            readEventType(event) === 'assistant' &&
            JSON.stringify(event).includes('held-wake-prefix')
          ) {
            prefixAdmissionStarted.release();
            return allowPrefixAdmission.promise.then(() => {
              prefixAdmissionCompleted.release();
            });
          }
        },
        getNoWindow,
      );
      session.sendMessage('Start work', { userMessageId: 'first-user-turn' });
      let steeringSupported = false;
      let admission: unknown;

      try {
        await initialPromptPulled.promise;
        await wakeInitEmitted.promise;
        steeringSupported = session.getSteeringCapabilities?.().steer === true;
        const submission = session.submitSteeringInput?.(
          'Continue after the wake',
          'late-steering-attempt',
          'late-steering-user-message',
        );
        allowWakeResult.release();
        await prefixAdmissionStarted.promise;
        await flush();
        expect(steeringPromptPulledBeforeAdmission).toBe(true);
        if (steeringSupported) {
          await steeringPromptPulled.promise;
          allowSteeringLifecycle.release();
          await steeringPickedUpBeforeInit.promise;
          const idleCallsBeforePriorResultAdmission =
            mockedMarkTurnIdle.mock.calls.length;
          expect(pickups).toEqual([]);
          allowPrefixAdmission.release();
          await prefixAdmissionCompleted.promise;
          await flush();
          expect(mockedMarkTurnIdle).toHaveBeenCalledTimes(
            idleCallsBeforePriorResultAdmission,
          );
          expect(pickups).toEqual([
            expect.objectContaining({
              phase: 'picked-up',
              startsTurn: true,
              userMessageId: 'late-steering-user-message',
            }),
          ]);
          expect(authorityAfterPickupBeforeInit).toBe(
            'late-steering-user-message',
          );
          await invokeClaudePreToolUse(
            claudeQueryParams(),
            'mcp__canopy__DelegateTask',
            { prompt: 'Bind the steering turn before init' },
            'late-steering-pre-init-hook',
          );
          expect(bindingContexts.at(-1)).toMatchObject({
            turnId: 'late-steering-user-message',
            messageId: 'late-steering-user-message',
          });
          allowNextUserInit.release();
          await nextUserInitEmitted.promise;
          expect(authorityBeforeUserInit).toBeUndefined();
          expect(delegationOptions?.currentTurn()).toBe(
            'late-steering-user-message',
          );
          expect(delegationOptions?.currentMessage?.()).toBe(
            'late-steering-user-message',
          );
          allowSteeringLifecycle.release();
          admission = await submission;
        }

        expect(steeringSupported).toBe(true);
        expect(admission).toEqual(
          expect.objectContaining({
            kind: 'accepted',
            attemptId: 'late-steering-attempt',
          }),
        );
        expect(steeringPrompt).toMatchObject({
          uuid: 'late-steering-attempt',
          message: {
            role: 'user',
            content: 'Continue after the wake',
          },
        });
      } finally {
        allowWakeResult.release();
        allowPrefixAdmission.release();
        allowNextUserInit.release();
        allowSteeringLifecycle.release();
        allowStreamExit.release();
        await flush();
        await session.destroy();
      }
    });

    it('keeps receipt-time turn stamps and managed binding when the next root initializes before prior admission settles', async () => {
      mockManagedDelegationEnabled.mockReturnValue(true);
      let delegationOptions: ManagedDelegationSessionOptions | undefined;
      const bindingContexts: ManagedDelegationBindingContext[] = [];
      const managed = createBindingManagedDelegationStub(
        () => delegationOptions,
        bindingContexts,
      );
      mockCreateManagedDelegationSession.mockImplementation((options) => {
        delegationOptions = options;
        return Promise.resolve(managed);
      });

      const firstPromptPulled = createGate();
      const secondPromptPulled = createGate();
      const firstResultAdmissionStarted = createGate();
      const allowFirstResultAdmission = createGate();
      const secondInitReadAhead = createGate();
      const secondAssistantAdmitted = createGate();
      const allowSecondResult = createGate();
      const allowStreamExit = createGate();
      let secondInitReadWhileFirstResultHeld = false;
      let dispatchedPromptB: unknown;
      const emitted: unknown[] = [];

      mockQuery.mockImplementation((params) => {
        if (typeof params.prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const prompt = params.prompt[Symbol.asyncIterator]();
        return (async function* (): AsyncGenerator<unknown, void> {
          const firstPrompt = await prompt.next();
          if (firstPrompt.done) return;
          const firstUserMessageUuid = readEventString(
            firstPrompt.value,
            'uuid',
          );
          firstPromptPulled.release();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'turn-a-session',
            ...(firstUserMessageUuid
              ? { user_message_uuid: firstUserMessageUuid }
              : {}),
          };
          const next = await prompt.next();
          if (next.done) return;
          const secondUserMessageUuid = readEventString(next.value, 'uuid');
          dispatchedPromptB = next.value;
          secondPromptPulled.release();
          // Root B is dispatched before A's terminal is even read. A's event
          // must still retain A's receipt-time turn while B becomes active.
          yield { type: 'result', is_error: false, result: 'Turn A done' };
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'turn-b-session',
            ...(secondUserMessageUuid
              ? { user_message_uuid: secondUserMessageUuid }
              : {}),
          };
          // The event reader resumes this generator after processing init B.
          secondInitReadWhileFirstResultHeld = true;
          secondInitReadAhead.release();
          yield {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: 'Turn B is active' }],
            },
          };
          await allowSecondResult.promise;
          yield { type: 'result', is_error: false, result: 'Turn B done' };
          await allowStreamExit.promise;
        })();
      });

      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'receipt-time-root-turns',
          approvalMode: 'full-access',
        },
        (event: unknown) => {
          emitted.push(event);
          if (
            readEventType(event) === 'result' &&
            readEventString(event, 'result') === 'Turn A done'
          ) {
            firstResultAdmissionStarted.release();
            return allowFirstResultAdmission.promise;
          }
          if (
            readEventType(event) === 'assistant' &&
            JSON.stringify(event).includes('Turn B is active')
          ) {
            secondAssistantAdmitted.release();
          }
        },
        getNoWindow,
      );
      session.sendMessage('Turn A', { userMessageId: 'turn-a-message' });
      session.sendMessage('Turn B', { userMessageId: 'turn-b-message' });

      try {
        await firstPromptPulled.promise;
        await secondPromptPulled.promise;
        expect(dispatchedPromptB).toMatchObject({
          message: { role: 'user', content: 'Turn B' },
        });
        await firstResultAdmissionStarted.promise;
        for (let attempts = 0; attempts < 10; attempts += 1) {
          await flush();
        }
        expect(secondInitReadWhileFirstResultHeld).toBe(true);
        const turnBId = delegationOptions?.currentTurn();
        expect(turnBId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
        expect(delegationOptions?.currentMessage?.()).toBe('turn-b-message');
        await invokeClaudePreToolUse(
          claudeQueryParams(),
          'mcp__canopy__DelegateTask',
          { prompt: 'Bind the newly initialized root' },
          'turn-b-managed-call',
        );
        expect(bindingContexts.at(-1)).toEqual({
          turnId: turnBId,
          messageId: 'turn-b-message',
        });

        allowFirstResultAdmission.release();
        await secondAssistantAdmitted.promise;
        const turnAResult = emitted.find(
          (event) =>
            readEventType(event) === 'result' &&
            readEventString(event, 'result') === 'Turn A done',
        );
        const turnBAssistant = emitted.find(
          (event) =>
            readEventType(event) === 'assistant' &&
            JSON.stringify(event).includes('Turn B is active'),
        );
        expect(turnAResult).toEqual(
          expect.objectContaining({
            canopy_turn_user_message_id: 'turn-a-message',
          }),
        );
        expect(turnBAssistant).toEqual(
          expect.objectContaining({
            canopy_turn_user_message_id: 'turn-b-message',
          }),
        );
        expect(delegationOptions?.currentTurn()).toBe(turnBId);
      } finally {
        allowFirstResultAdmission.release();
        allowSecondResult.release();
        allowStreamExit.release();
        await flush();
        await session.destroy();
      }
    });

    it('replays fork-buffered prompts without counting the rejected attempt as an autonomous turn', async () => {
      const startTurn = jest.spyOn(SkillUsageTracker.prototype, 'startTurn');
      mockManagedDelegationEnabled.mockReturnValue(true);
      let delegationOptions: ManagedDelegationSessionOptions | undefined;
      const bindingContexts: ManagedDelegationBindingContext[] = [];
      const managed = createBindingManagedDelegationStub(
        () => delegationOptions,
        bindingContexts,
      );
      mockCreateManagedDelegationSession.mockImplementation((options) => {
        delegationOptions = options;
        return Promise.resolve(managed);
      });

      const firstAttemptPromptsPulled = createGate();
      const rejectForkAnchor = createGate();
      const firstRetryPromptPulled = createGate();
      const allowFirstRootInit = createGate();
      const firstRootInitEmitted = createGate();
      const allowFirstRootResult = createGate();
      const secondRetryPromptPulled = createGate();
      const allowSecondRootInit = createGate();
      const secondRootInitEmitted = createGate();
      const allowSecondRootResult = createGate();
      const allowStreamExit = createGate();
      let firstRetriedPrompt: unknown;
      let secondRetriedPrompt: unknown;
      mockQuery
        .mockImplementationOnce((params) => {
          if (typeof params.prompt === 'string')
            throw new Error('Expected a streaming Claude prompt');
          const prompt = params.prompt[Symbol.asyncIterator]();
          return (async function* (): AsyncGenerator<unknown, void> {
            await prompt.next();
            await prompt.next();
            firstAttemptPromptsPulled.release();
            await rejectForkAnchor.promise;
            yield {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: ['No message found with message.uuid of: chain-a1'],
            };
          })();
        })
        .mockImplementationOnce((params) => {
          if (typeof params.prompt === 'string')
            throw new Error('Expected a streaming Claude prompt');
          const prompt = params.prompt[Symbol.asyncIterator]();
          return (async function* (): AsyncGenerator<unknown, void> {
            const first = await prompt.next();
            if (first.done) return;
            firstRetriedPrompt = first.value;
            const firstUserMessageUuid = readEventString(first.value, 'uuid');
            firstRetryPromptPulled.release();
            await allowFirstRootInit.promise;
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: 'fresh-fork-session',
              ...(firstUserMessageUuid
                ? { user_message_uuid: firstUserMessageUuid }
                : {}),
            };
            firstRootInitEmitted.release();
            await allowFirstRootResult.promise;
            yield {
              type: 'result',
              is_error: false,
              result: 'First replay done',
            };
            const second = await prompt.next();
            if (second.done) return;
            secondRetriedPrompt = second.value;
            const secondUserMessageUuid = readEventString(second.value, 'uuid');
            secondRetryPromptPulled.release();
            await allowSecondRootInit.promise;
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: 'fresh-fork-session',
              ...(secondUserMessageUuid
                ? { user_message_uuid: secondUserMessageUuid }
                : {}),
            };
            secondRootInitEmitted.release();
            await allowSecondRootResult.promise;
            yield {
              type: 'result',
              is_error: false,
              result: 'Second replay done',
            };
            await allowStreamExit.promise;
          })();
        });

      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/destination-worktree',
          projectId: 'project',
          worktreeId: 'destination',
          chatId: 'fork-retry-turn-accounting',
          sdkSessionId: 'source-session',
          claudeForkSession: true,
          claudeForkResumeAt: CHAIN_UUID,
          approvalMode: 'full-access',
        },
        jest.fn(),
        getNoWindow,
      );
      session.sendMessage('First fork prompt', {
        userMessageId: 'fork-first-message',
      });
      session.sendMessage('Second fork prompt', {
        userMessageId: 'fork-second-message',
      });
      let turnBeforeRetryInit: string | undefined;

      try {
        await firstAttemptPromptsPulled.promise;
        expect(startTurn).not.toHaveBeenCalled();
        turnBeforeRetryInit = delegationOptions?.currentTurn();
        rejectForkAnchor.release();
        await firstRetryPromptPulled.promise;
        allowFirstRootInit.release();
        await firstRootInitEmitted.promise;
        expect(
          trackedSkillTurnId(
            startTurn.mock.instances[startTurn.mock.instances.length - 1],
          ),
        ).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
        await invokeClaudePreToolUse(
          claudeQueryParams(1),
          'mcp__canopy__DelegateTask',
          { prompt: 'Bind the first replay' },
          'first-replay-call',
        );
        allowFirstRootResult.release();
        await secondRetryPromptPulled.promise;
        allowSecondRootInit.release();
        await secondRootInitEmitted.promise;
        expect(
          trackedSkillTurnId(
            startTurn.mock.instances[startTurn.mock.instances.length - 1],
          ),
        ).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
        await invokeClaudePreToolUse(
          claudeQueryParams(1),
          'mcp__canopy__DelegateTask',
          { prompt: 'Bind the second replay' },
          'second-replay-call',
        );
        allowSecondRootResult.release();

        expect(turnBeforeRetryInit).toBeUndefined();
        expect(
          bindingContexts.map((context) =>
            /^[0-9a-f-]{36}$/i.test(context.turnId ?? ''),
          ),
        ).toEqual([true, true]);
        expect(bindingContexts.map((context) => context.messageId)).toEqual([
          'fork-first-message',
          'fork-second-message',
        ]);
        expect(firstRetriedPrompt).toMatchObject({
          message: { role: 'user', content: 'First fork prompt' },
        });
        expect(secondRetriedPrompt).toMatchObject({
          message: { role: 'user', content: 'Second fork prompt' },
        });
      } finally {
        rejectForkAnchor.release();
        allowFirstRootInit.release();
        allowFirstRootResult.release();
        allowSecondRootInit.release();
        allowSecondRootResult.release();
        allowStreamExit.release();
        await flush();
        await session.destroy();
        startTurn.mockRestore();
      }
    });

    it('resets Code Graph orientation for autonomous skills without counting them as user skill usage', async () => {
      const startTurn = jest.spyOn(SkillUsageTracker.prototype, 'startTurn');
      mockHasCodeGraph.mockReturnValue(true);
      mockLoadCachedInventory.mockResolvedValue({
        entries: [
          {
            id: 'claude-skill-review',
            provider: 'claude',
            kind: 'skill',
            name: 'review',
            displayName: '/review',
            description: 'Review the change',
            insertText: '/review ',
            invocationKey: '/review',
            enableRef: {
              kind: 'skill',
              sourceId: 'test-source',
              skillName: 'review',
            },
          },
        ],
      });
      const recordUse = jest
        .spyOn(skillShareNudgeState, 'recordUse')
        .mockResolvedValue(undefined);
      const promptPulled = createGate();
      const firstRootInitEmitted = createGate();
      const allowFirstRootResult = createGate();
      const wakeInitEmitted = createGate();
      const allowWakeResult = createGate();
      const allowStreamExit = createGate();
      mockQuery.mockImplementation((params) => {
        if (typeof params.prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const prompt = params.prompt[Symbol.asyncIterator]();
        return (async function* (): AsyncGenerator<unknown, void> {
          const userPrompt = await prompt.next();
          if (userPrompt.done) return;
          const userMessageUuid = readEventString(userPrompt.value, 'uuid');
          promptPulled.release();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'user-session',
            ...(userMessageUuid ? { user_message_uuid: userMessageUuid } : {}),
          };
          firstRootInitEmitted.release();
          await allowFirstRootResult.promise;
          yield { type: 'result', is_error: false, result: 'User review done' };
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'wake-session',
          };
          wakeInitEmitted.release();
          await allowWakeResult.promise;
          yield { type: 'result', is_error: false, result: 'Wake review done' };
          await allowStreamExit.promise;
        })();
      });

      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'graph-skill-wake-reset',
          approvalMode: 'full-access',
          codeGraphToolsAdvertised: true,
        },
        jest.fn(),
        getNoWindow,
      );
      session.sendMessage('$review inspect this change', {
        userMessageId: 'review-user-message',
        countsTowardSkillUsage: true,
      });

      try {
        await promptPulled.promise;
        await firstRootInitEmitted.promise;
        await flush();
        const options = claudeQueryParams().options;
        const postToolUse = options?.hooks?.PostToolUse?.find(
          (entry) => entry.matcher === '*',
        )?.hooks[0];
        if (!postToolUse) throw new Error('Expected the Code Graph post-hook');
        await postToolUse(
          {
            hook_event_name: 'PostToolUse',
            session_id: 'native-session',
            transcript_path: '/tmp/transcript.jsonl',
            cwd: '/tmp/repo',
            tool_name: 'mcp__canopy__GetCodeGraphContext',
            tool_input: {},
            tool_response: {},
            tool_use_id: 'graph-context-user',
          },
          'graph-context-user',
          { signal: new AbortController().signal },
        );
        await expect(
          invokeClaudePreToolUse(
            claudeQueryParams(),
            'Grep',
            { pattern: 'needle', path: '/tmp/repo/src' },
            'grep-after-graph',
          ),
        ).resolves.toBeUndefined();
        const grepAfterUserGraph = options?.hooks?.PreToolUse?.find(
          (entry) => entry.matcher === '*',
        )?.hooks[0];
        if (!grepAfterUserGraph)
          throw new Error('Expected the Code Graph PreToolUse hook');
        await expect(
          grepAfterUserGraph(
            {
              hook_event_name: 'PreToolUse',
              session_id: 'native-session',
              transcript_path: '/tmp/transcript.jsonl',
              cwd: '/tmp/repo',
              tool_name: 'Grep',
              tool_input: { pattern: 'needle', path: '/tmp/repo/src' },
              tool_use_id: 'grep-after-graph',
            },
            'grep-after-graph',
            { signal: new AbortController().signal },
          ),
        ).resolves.toEqual({ continue: true });

        allowFirstRootResult.release();
        await wakeInitEmitted.promise;
        expect(startTurn.mock.calls).toHaveLength(3);
        expect(startTurn.mock.calls[0]?.[1]).toBe(false);
        expect(startTurn.mock.calls[1]?.[0]).toBe(startTurn.mock.calls[0]?.[0]);
        expect(startTurn.mock.calls[1]?.[1]).toBe(true);
        expect(startTurn.mock.calls[2]).toEqual([
          expect.stringMatching(/^[0-9a-f-]{36}$/i),
          false,
        ]);
        const wakeGrep = await options?.hooks?.PreToolUse?.find(
          (entry) => entry.matcher === '*',
        )?.hooks[0]?.(
          {
            hook_event_name: 'PreToolUse',
            session_id: 'native-session',
            transcript_path: '/tmp/transcript.jsonl',
            cwd: '/tmp/repo',
            tool_name: 'Grep',
            tool_input: { pattern: 'needle', path: '/tmp/repo/src' },
            tool_use_id: 'grep-after-wake',
          },
          'grep-after-wake',
          { signal: new AbortController().signal },
        );
        expect(wakeGrep).toMatchObject({
          hookSpecificOutput: {
            permissionDecision: 'deny',
            additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
          },
        });
        await invokeClaudePreToolUse(
          claudeQueryParams(),
          'Skill',
          { skill: 'review' },
          'autonomous-review-skill',
        );
        expect(recordUse).toHaveBeenCalledTimes(1);
        allowWakeResult.release();
        await flush();
      } finally {
        allowFirstRootResult.release();
        allowWakeResult.release();
        allowStreamExit.release();
        await flush();
        await session.destroy();
        recordUse.mockRestore();
        startTurn.mockRestore();
      }
    });

    it('starts a wake at its first top-level tool call when init has not been read yet', async () => {
      const startTurn = jest.spyOn(SkillUsageTracker.prototype, 'startTurn');
      mockHasCodeGraph.mockReturnValue(true);
      const promptPulled = createGate();
      const firstRootInitEmitted = createGate();
      const allowFirstRootResult = createGate();
      const firstRootResultEmitted = createGate();
      const allowWakeInit = createGate();
      const wakeInitEmitted = createGate();
      const allowStreamExit = createGate();
      mockQuery.mockImplementation((params) => {
        if (typeof params.prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const prompt = params.prompt[Symbol.asyncIterator]();
        return (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          promptPulled.release();
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'user-session',
          };
          firstRootInitEmitted.release();
          await allowFirstRootResult.promise;
          yield { type: 'result', is_error: false, result: 'User turn done' };
          firstRootResultEmitted.release();
          // The wake's first tool hook arrives before this loop reads its init.
          await allowWakeInit.promise;
          yield {
            type: 'system',
            subtype: 'init',
            parent_tool_use_id: null,
            session_id: 'wake-session',
          };
          wakeInitEmitted.release();
          await allowStreamExit.promise;
        })();
      });

      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'pre-init-wake-tool',
          approvalMode: 'full-access',
          codeGraphToolsAdvertised: true,
        },
        jest.fn(),
        getNoWindow,
      );
      session.sendMessage('Inspect the change', {
        userMessageId: 'pre-init-user-message',
      });

      const grepHook = async (toolUseId: string): Promise<unknown> => {
        const hook = claudeQueryParams().options?.hooks?.PreToolUse?.find(
          (entry) => entry.matcher === '*',
        )?.hooks[0];
        if (!hook) throw new Error('Expected the Code Graph PreToolUse hook');
        return hook(
          {
            hook_event_name: 'PreToolUse',
            session_id: 'native-session',
            transcript_path: '/tmp/transcript.jsonl',
            cwd: '/tmp/repo',
            tool_name: 'Grep',
            tool_input: { pattern: 'needle', path: '/tmp/repo/src' },
            tool_use_id: toolUseId,
          },
          toolUseId,
          { signal: new AbortController().signal },
        );
      };

      try {
        await promptPulled.promise;
        await firstRootInitEmitted.promise;
        await flush();
        const postToolUse =
          claudeQueryParams().options?.hooks?.PostToolUse?.find(
            (entry) => entry.matcher === '*',
          )?.hooks[0];
        if (!postToolUse) throw new Error('Expected the Code Graph post-hook');
        await postToolUse(
          {
            hook_event_name: 'PostToolUse',
            session_id: 'native-session',
            transcript_path: '/tmp/transcript.jsonl',
            cwd: '/tmp/repo',
            tool_name: 'mcp__canopy__GetCodeGraphContext',
            tool_input: {},
            tool_response: {},
            tool_use_id: 'graph-context-user',
          },
          'graph-context-user',
          { signal: new AbortController().signal },
        );
        await expect(grepHook('grep-in-user-turn')).resolves.toEqual({
          continue: true,
        });
        expect(startTurn.mock.calls).toHaveLength(1);

        allowFirstRootResult.release();
        await firstRootResultEmitted.promise;
        await flush();

        // A top-level tool call proves the wake is running: it gets its own
        // skill turn and a fresh Code Graph orientation before init is read.
        await expect(grepHook('grep-before-wake-init')).resolves.toMatchObject({
          hookSpecificOutput: {
            permissionDecision: 'deny',
            additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
          },
        });
        expect(startTurn.mock.calls).toHaveLength(2);
        expect(startTurn.mock.calls[1]).toEqual([
          expect.stringMatching(/^[0-9a-f-]{36}$/i),
          false,
        ]);

        allowWakeInit.release();
        await wakeInitEmitted.promise;
        await flush();
        expect(startTurn.mock.calls).toHaveLength(2);
      } finally {
        allowFirstRootResult.release();
        allowWakeInit.release();
        allowStreamExit.release();
        await flush();
        await session.destroy();
        startTurn.mockRestore();
      }
    });

    it.each([false, true])(
      'deduplicates AI Credits recovery separately for successive autonomous wakes with a queued prompt (eager: %s)',
      async (eager) => {
        setAiCreditsRoutingModeCache('off');
        mockedIsNativelyAuthed.mockResolvedValue(false);
        mockedGetRoutingContext.mockResolvedValue(
          makeAiCreditsRoutingContext({ accountIdentity: 'test-account' }),
        );
        const diagnostics = jest.spyOn(
          getObservabilityService(),
          'recordSessionDiagnostic',
        );
        const promptPulled = createGate();
        const firstUserResultEmitted = createGate();
        const allowFirstWake = createGate();
        const firstWakeResultEmitted = createGate();
        const allowSecondWake = createGate();
        const secondWakeResultEmitted = createGate();
        const allowStreamExit = createGate();
        const failure = {
          type: 'result',
          is_error: true,
          api_error_status: 402,
          result: `API Error: 402 ${AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}`,
        };
        mockQuery.mockImplementation((params) => {
          if (typeof params.prompt === 'string')
            throw new Error('Expected a streaming Claude prompt');
          const prompt = params.prompt[Symbol.asyncIterator]();
          return (async function* (): AsyncGenerator<unknown, void> {
            await prompt.next();
            promptPulled.release();
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: 'user-session',
            };
            yield { type: 'result', is_error: false, result: 'User turn done' };
            firstUserResultEmitted.release();
            await allowFirstWake.promise;
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: 'first-wake-session',
            };
            if (eager) await prompt.next();
            yield {
              type: 'assistant',
              error: 'billing_error',
              api_error_status: 402,
              message: { content: [{ type: 'text', text: failure.result }] },
            };
            yield failure;
            yield failure;
            firstWakeResultEmitted.release();
            await allowSecondWake.promise;
            if (eager) {
              yield {
                type: 'system',
                subtype: 'init',
                parent_tool_use_id: null,
                session_id: 'queued-user-session',
              };
              yield {
                type: 'result',
                is_error: false,
                result: 'queued user done',
              };
            }
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: 'second-wake-session',
            };
            yield failure;
            yield failure;
            secondWakeResultEmitted.release();
            await allowStreamExit.promise;
          })();
        });

        const onEvent = jest.fn();
        const session = new ClaudeCodeProvider().createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'credits-autonomous-wakes',
            model: 'opus',
          },
          onEvent,
          getNoWindow,
        );
        session.sendMessage('Start the first user turn', {
          userMessageId: 'credits-user-turn',
        });

        try {
          await flush();
          if (session.isDisposed?.())
            throw new Error(JSON.stringify(onEvent.mock.calls));
          await promptPulled.promise;
          await firstUserResultEmitted.promise;
          session.sendMessage('Do not take ownership of the wake', {
            userMessageId: 'queued-during-wakes',
          });
          allowFirstWake.release();
          await firstWakeResultEmitted.promise;
          allowSecondWake.release();
          await secondWakeResultEmitted.promise;

          expect(
            onEvent.mock.calls.filter(
              ([event]) =>
                readEventType(event) === 'canopy_ai_credits_no_billing_source',
            ),
          ).toHaveLength(2);
          expect(
            diagnostics.mock.calls.filter(
              ([entry]) => entry.kind === 'claude_ai_credits_402',
            ),
          ).toHaveLength(2);
          const diagnosticOwners = diagnostics.mock.calls
            .filter(([entry]) => entry.kind === 'claude_ai_credits_402')
            .map(([entry]) => entry.turnUserMessageId);
          expect(diagnosticOwners[0]).toEqual(
            expect.stringMatching(/^[0-9a-f-]{36}$/i),
          );
          expect(diagnosticOwners[1]).toEqual(
            expect.stringMatching(/^[0-9a-f-]{36}$/i),
          );
          expect(diagnosticOwners[0]).not.toBe(diagnosticOwners[1]);
          expect(diagnosticOwners).not.toContain('queued-during-wakes');
        } finally {
          allowFirstWake.release();
          allowSecondWake.release();
          allowStreamExit.release();
          await flush();
          await session.destroy();
          diagnostics.mockRestore();
        }
      },
    );
  });

  it('waits for the query loop to finish when destroying a session', async () => {
    const onEvent = jest.fn();
    let releaseQuery: () => void = () => {
      throw new Error('releaseQuery was called before initialization');
    };
    const queryGate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
        // eslint-disable-next-line require-yield -- models a slow SDK stream shutdown after abort
        async function* slowShutdownQuery(): AsyncGenerator<unknown, void> {
          await prompt.next();
          await queryGate;
        }
        return slowShutdownQuery();
      },
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Do work', { userMessageId: 'user-message-1' });
    await flush();

    let destroyed = false;
    const destroyPromise = session.destroy().then(() => {
      destroyed = true;
    });
    await flush();

    expect(destroyed).toBe(false);

    releaseQuery();
    await destroyPromise;

    expect(destroyed).toBe(true);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        result: 'Session ended',
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );
  });

  it('emits a correlated terminal when destroying a queued startup turn', async () => {
    mockGetChildToolLiveness.mockReturnValue({
      kind: 'known',
      liveParentToolUseIds: ['still-reported-child'],
      hasUncorrelatedLiveTask: false,
    });
    const onEvent = jest.fn();
    // eslint-disable-next-line require-yield -- models abort before the SDK consumes the prompt
    async function* startupAbortQuery(): AsyncGenerator<unknown, void> {
      await Promise.resolve();
      throw new Error('Operation aborted');
    }
    mockQuery.mockReturnValue(startupAbortQuery());

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Do work', { userMessageId: 'user-message-1' });
    await session.destroy();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        is_error: false,
        result: 'Session aborted',
        canopy_turn_user_message_id: 'user-message-1',
        [CHILD_TOOL_LIVENESS_STAMP]: { kind: 'no-live-session' },
      }),
    );
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('does not emit an uncorrelated terminal when destroying an idle session', async () => {
    const onEvent = jest.fn();
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield { type: 'result', is_error: false, result: 'done' };
          await prompt.next();
          throw new Error('Operation aborted');
        })(),
    );

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );

    session.sendMessage('Do work', { userMessageId: 'user-message-1' });
    await flush();
    await flush();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        result: 'done',
        canopy_turn_user_message_id: 'user-message-1',
      }),
    );

    onEvent.mockClear();
    await session.destroy();

    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'result' }),
    );
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('treats a transport "Operation aborted" throw after cancel as a clean cancellation result', async () => {
    const onEvent = jest.fn();
    // eslint-disable-next-line require-yield -- models a query that aborts before yielding
    async function* abortingQuery(): AsyncGenerator<unknown, void> {
      await Promise.resolve();
      // The SDK transport throws this when a write lands after abort(). Its
      // error class extends Error without overriding `name`, so `name` stays
      // 'Error' rather than 'AbortError'.
      throw new Error('Operation aborted');
    }
    mockQuery.mockReturnValue(abortingQuery());

    const provider = new ClaudeCodeProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      onEvent,
      getNoWindow,
    );

    await session.cancel();
    await flush();
    await flush();
    await flush();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'result',
        is_error: false,
        result: 'Session aborted',
        [CHILD_TOOL_LIVENESS_STAMP]: { kind: 'no-live-session' },
      }),
    );
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
  });

  describe('AI Credits routing when not natively authenticated', () => {
    afterEach(() => {
      clearAiCreditsRoutingModeCache();
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockedGetRoutingContext.mockReset();
    });

    it.each([
      'API Error: 400 messages.4.content: Invalid input',
      'API Error: 400 messages[4].content: Invalid input',
    ])(
      'explains a signed-out Claude fallback rejection without changing audit evidence: %s',
      async (error) => {
        mockLoadCachedInventory.mockResolvedValue(null);
        setAiCreditsRoutingModeCache('off');
        mockedIsNativelyAuthed.mockResolvedValue(false);
        mockedGetRoutingContext.mockResolvedValue(
          makeAiCreditsRoutingContext(),
        );
        const assistant = {
          type: 'assistant',
          error: 'unknown',
          message: {
            model: '<synthetic>',
            role: 'assistant',
            content: [{ type: 'text', text: error }],
          },
        };
        const result = {
          type: 'result',
          is_error: true,
          api_error_status: 400,
          result: error,
        };
        const original = structuredClone({ assistant, result });
        mockQuery.mockImplementation(({ prompt }) =>
          (async function* (): AsyncGenerator<unknown, void> {
            if (typeof prompt !== 'string')
              await prompt[Symbol.asyncIterator]().next();
            yield assistant;
            yield result;
          })(),
        );
        const onEvent = jest.fn();
        const session = new ClaudeCodeProvider().createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            model: 'opus',
          },
          onEvent,
          getNoWindow,
        );
        try {
          session.sendMessage('Continue', { userMessageId: 'fallback-turn' });
          await flush();
          for (const rawEvent of [assistant, result]) {
            const expected: unknown = expect.objectContaining({
              ...rawEvent,
              canopy_turn_user_message_id: 'fallback-turn',
              canopy_display_error_code: 'claude_ai_credits_fallback_rejected',
            });
            expect(onEvent).toHaveBeenCalledWith(expected);
            expect(jest.mocked(recordSessionEvent)).toHaveBeenCalledWith(
              'project/worktree/chat',
              expected,
            );
          }
          expect({ assistant, result }).toEqual(original);
          expect(mockQuery).toHaveBeenCalledTimes(1);
        } finally {
          await session.destroy();
        }
      },
    );

    it.each([
      {
        name: 'native Claude',
        authenticated: true,
        forced: false,
        status: 400,
      },
      {
        name: 'explicit AI Credits',
        authenticated: false,
        forced: true,
        status: 400,
      },
      {
        name: 'authentication refusal',
        authenticated: false,
        forced: false,
        status: 401,
      },
      {
        name: 'invalid structured status',
        authenticated: false,
        forced: false,
        status: null,
      },
      {
        name: 'successful result',
        authenticated: false,
        forced: false,
        status: 400,
        success: true,
      },
      {
        name: 'subagent result',
        authenticated: false,
        forced: false,
        status: 400,
        child: true,
      },
      {
        name: 'different content rejection',
        authenticated: false,
        forced: false,
        status: 400,
        error: 'API Error: 400 messages.4.content: Invalid input length',
      },
      {
        name: 'unrelated validation',
        authenticated: false,
        forced: false,
        status: 400,
        error: 'API Error: 400 messages.4.reasoning.effort: Invalid input',
      },
    ])(
      'keeps $name outside the signed-out fallback notice',
      async (scenario) => {
        mockLoadCachedInventory.mockResolvedValue(null);
        setAiCreditsRoutingModeCache(scenario.forced ? 'on' : 'off');
        mockedIsNativelyAuthed.mockResolvedValue(scenario.authenticated);
        mockedGetRoutingContext.mockResolvedValue(
          makeAiCreditsRoutingContext(),
        );
        const event = {
          type: 'result',
          is_error: !scenario.success,
          api_error_status: scenario.status,
          result:
            scenario.error ??
            'API Error: 400 messages.4.content: Invalid input',
          ...(scenario.child ? { parent_tool_use_id: 'child-tool' } : {}),
        };
        mockQuery.mockReturnValue(makeMessages([event]));
        const onEvent = jest.fn();
        const session = new ClaudeCodeProvider().createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            model: 'opus',
          },
          onEvent,
          getNoWindow,
        );
        try {
          await flush();
          expect(onEvent).toHaveBeenCalledWith(expect.objectContaining(event));
          expect(onEvent).not.toHaveBeenCalledWith(
            expect.objectContaining({
              canopy_display_error_code: 'claude_ai_credits_fallback_rejected',
            }),
          );
        } finally {
          await session.destroy();
        }
      },
    );

    // Synthetic fixtures: exact reported wording, not extracted bundle events.
    it.each([true, false])(
      'normalizes a routed Claude 402 (structured status: %s)',
      async (structuredStatus) => {
        setAiCreditsRoutingModeCache('off');
        mockedIsNativelyAuthed.mockResolvedValue(false);
        mockedGetRoutingContext.mockResolvedValue(
          makeAiCreditsRoutingContext(),
        );
        const failure = {
          type: 'result',
          subtype: 'success',
          is_error: true,
          ...(structuredStatus ? { api_error_status: 402 } : {}),
          result: 'API Error: 402 AI Credits are unavailable for this request.',
          usage: { input_tokens: 7 },
          session_id: 'failed-session',
        };
        const original = structuredClone(failure);
        mockQuery.mockImplementation(({ prompt }) =>
          (async function* (): AsyncGenerator<unknown, void> {
            if (typeof prompt !== 'string')
              await prompt[Symbol.asyncIterator]().next();
            yield failure;
          })(),
        );
        const onEvent = jest.fn();
        const session = new ClaudeCodeProvider().createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            model: 'opus',
          },
          onEvent,
          getNoWindow,
        );
        session.sendMessage('hello', { userMessageId: 'failed-turn' });
        await flush();
        const restoredResultMatcher: unknown = expect.stringContaining(
          'CANOPY_AI_CREDITS_PROXY',
        );
        expect(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'result',
            canopy_turn_user_message_id: 'failed-turn',
            canopy_ai_credits_no_billing_source: true,
            result: restoredResultMatcher,
            usage: { input_tokens: 7 },
            session_id: 'failed-session',
          }),
        );
        expect(onEvent).toHaveBeenCalledWith({
          type: 'canopy_ai_credits_no_billing_source',
          provider: 'claude',
          canopy_turn_user_message_id: 'failed-turn',
        });
        const delivered = onEvent.mock.calls
          .map(([event]): unknown => event)
          .find(
            (event): event is Record<string, unknown> =>
              event !== null &&
              typeof event === 'object' &&
              !Array.isArray(event) &&
              readEventType(event) === 'result',
          );
        if (!delivered) throw new Error('Expected a delivered result event');
        expect(jest.mocked(recordSessionEvent)).toHaveBeenCalledWith(
          'project/worktree/chat',
          delivered,
        );
        const deliveredResult = readEventString(delivered, 'result');
        if (deliveredResult === undefined)
          throw new Error(
            'Expected the delivered result event to include text',
          );
        expect(
          parseCanopyProxyError(deliveredResult)?.correlationId,
        ).toBeNull();
        expect(failure).toEqual(original);
        await session.destroy();
      },
    );

    it('reports a routed Claude sub-agent 402 only as a sub-agent failure', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        email: 'user@example.com',
        creditsEligible: true,
        creditsEligibilityKnown: true,
        accountIdentity: 'account-1',
        guestPrincipal: false,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      mockQuery.mockImplementation(({ prompt }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          if (typeof prompt !== 'string')
            await prompt[Symbol.asyncIterator]().next();
          yield {
            type: 'result',
            subtype: 'success',
            is_error: true,
            api_error_status: 402,
            parent_tool_use_id: 'toolu_child',
            result:
              'API Error: 402 AI Credits are unavailable for this request.',
          };
          yield { type: 'result', is_error: false, result: 'Done' };
        })(),
      );
      const events: unknown[] = [];
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'opus',
        },
        (event) => {
          events.push(event);
        },
        getNoWindow,
      );
      try {
        session.sendMessage('hello', { userMessageId: 'child-402-turn' });
        await flush();
        await flush();
        expectOnlySubAgentFailure(events, 'no_credits');
      } finally {
        await session.destroy();
      }
    });

    it.each([
      {
        routed: false,
        event: {
          type: 'result',
          is_error: true,
          api_error_status: 402,
          result: 'API Error: 402 AI Credits are unavailable for this request.',
        },
      },
      {
        routed: true,
        event: {
          type: 'result',
          is_error: true,
          api_error_status: 402,
          result: 'Different refusal',
        },
      },
      {
        routed: true,
        event: {
          type: 'result',
          is_error: true,
          api_error_status: 401,
          result: 'Invalid authentication credentials',
        },
      },
      {
        routed: true,
        event: {
          type: 'result',
          is_error: true,
          api_error_status: 429,
          result: 'Rate limited',
        },
      },
      {
        routed: true,
        event: { type: 'error', code: 'ECONNRESET', error: 'Connection reset' },
      },
      {
        routed: true,
        event: {
          type: 'result',
          is_error: false,
          api_error_status: 402,
          result: 'API Error: 402 AI Credits are unavailable for this request.',
        },
      },
    ])(
      'preserves unrelated Claude event $event under routed=$routed',
      async ({ routed, event }) => {
        setAiCreditsRoutingModeCache('off');
        mockedIsNativelyAuthed.mockResolvedValue(!routed);
        mockedGetRoutingContext.mockResolvedValue(
          makeAiCreditsRoutingContext(),
        );
        mockQuery.mockReturnValue(makeMessages([event]));
        const diagnostics = jest.spyOn(
          getObservabilityService(),
          'recordSessionDiagnostic',
        );
        const onEvent = jest.fn();
        const session = new ClaudeCodeProvider().createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            model: 'opus',
          },
          onEvent,
          getNoWindow,
        );
        await flush();
        expect(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            ...event,
            [CHILD_TOOL_LIVENESS_STAMP]: { kind: 'no-live-session' },
          }),
        );
        expect(
          onEvent.mock.calls.some(
            ([data]) =>
              readEventType(data) === 'canopy_ai_credits_no_billing_source',
          ),
        ).toBe(false);
        const creditDiagnostics = diagnostics.mock.calls.filter(
          ([entry]) => entry.kind === 'claude_ai_credits_402',
        );
        expect(creditDiagnostics).toHaveLength(
          readEventString(event, 'result') === 'Different refusal' ? 1 : 0,
        );
        if (creditDiagnostics.length)
          expect(creditDiagnostics[0]?.[0].claudeAiCredits402Outcome).toBe(
            'unmatched',
          );
        await session.destroy();
        diagnostics.mockRestore();
      },
    );

    it('keeps recovery per turn across a successful turn in the same session', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue(makeAiCreditsRoutingContext());
      mockQuery.mockImplementation(({ prompt }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          if (typeof prompt === 'string') return;
          const iterator = prompt[Symbol.asyncIterator]();
          for (let turn = 0; turn < 3; turn += 1) {
            await iterator.next();
            yield turn === 1
              ? { type: 'result', is_error: false, result: 'done' }
              : {
                  type: 'result',
                  is_error: true,
                  result: `API Error: 402 ${AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}`,
                };
          }
        })(),
      );
      const onEvent = jest.fn();
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'opus',
        },
        onEvent,
        getNoWindow,
      );
      for (const id of ['first-turn', 'success-turn', 'next-failure-turn']) {
        session.sendMessage('hello', { userMessageId: id });
        await flush();
      }
      expect(
        onEvent.mock.calls.filter(
          ([event]) =>
            readEventType(event) === 'canopy_ai_credits_no_billing_source',
        ),
      ).toHaveLength(2);
      const results: unknown[] = onEvent.mock.calls
        .map(([event]): unknown => event)
        .filter((event) => readEventType(event) === 'result');
      expect(results.map(readTurnUserMessageId)).toEqual([
        'first-turn',
        'success-turn',
        'next-failure-turn',
      ]);
      expect(
        readEventBoolean(results[1], 'canopy_ai_credits_no_billing_source'),
      ).toBeUndefined();
      await session.destroy();
    });

    it('keeps the launch route across a settings change and deduplicates recovery/diagnostics per turn', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue(makeAiCreditsRoutingContext());
      const diagnostics = jest.spyOn(
        getObservabilityService(),
        'recordSessionDiagnostic',
      );
      const result = {
        type: 'result',
        is_error: true,
        api_error_status: 402,
        result: `API Error: 402 ${AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}`,
      };
      mockQuery.mockImplementation(({ prompt }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          if (typeof prompt !== 'string')
            await prompt[Symbol.asyncIterator]().next();
          // Account preferences change after dispatch, before the delayed refusal.
          mockedIsNativelyAuthed.mockResolvedValue(true);
          clearAiCreditsRoutingModeCache();
          yield {
            type: 'assistant',
            error: 'billing_error',
            api_error_status: 402,
            message: { content: [{ type: 'text', text: result.result }] },
          };
          yield result;
          yield result;
        })(),
      );
      const onEvent = jest.fn();
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'opus',
        },
        onEvent,
        getNoWindow,
      );
      session.sendMessage('hello', { userMessageId: 'late-turn' });
      await flush();
      expect(
        onEvent.mock.calls.filter(
          ([event]) =>
            readEventType(event) === 'canopy_ai_credits_no_billing_source',
        ),
      ).toHaveLength(1);
      const creditDiagnostics = diagnostics.mock.calls.filter(
        ([record]) => record.kind === 'claude_ai_credits_402',
      );
      expect(creditDiagnostics).toHaveLength(1);
      expect(creditDiagnostics[0]?.[0]).toEqual(
        expect.objectContaining({
          claudeAiCredits402Outcome: 'inferred_no_billing_source',
          turnUserMessageId: 'late-turn',
        }),
      );
      expect(JSON.stringify(creditDiagnostics)).not.toContain(
        AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
      );
      await session.destroy();
      diagnostics.mockRestore();
    });

    it('keeps a duplicate refusal on its completed turn while another prompt is queued', async () => {
      mockLoadCachedInventory.mockResolvedValue(null);
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue(makeAiCreditsRoutingContext());
      let releaseFailure = (): void => undefined;
      const failureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      const allowStreamExit = createGate();
      let noteFirstConsumed = (): void => undefined;
      const firstConsumed = new Promise<void>((resolve) => {
        noteFirstConsumed = resolve;
      });
      mockQuery.mockImplementation(({ prompt }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          if (typeof prompt === 'string') return;
          const iterator = prompt[Symbol.asyncIterator]();
          await iterator.next();
          noteFirstConsumed();
          await failureGate;
          const result = {
            type: 'result',
            is_error: true,
            result: `API Error: 402 ${AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}`,
          };
          yield result;
          yield result;
          await allowStreamExit.promise;
        })(),
      );
      const diagnostics = jest.spyOn(
        getObservabilityService(),
        'recordSessionDiagnostic',
      );
      const onEvent = jest.fn();
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'opus',
        },
        onEvent,
        getNoWindow,
      );
      try {
        session.sendMessage('first', { userMessageId: 'failed-turn' });
        await firstConsumed;
        session.sendMessage('next', { userMessageId: 'queued-turn' });
        releaseFailure();
        await flush();
        await flush();
        const results: unknown[] = onEvent.mock.calls
          .map(([event]): unknown => event)
          .filter((event) => readEventType(event) === 'result');
        expect(results.map(readTurnUserMessageId)).toEqual([
          'failed-turn',
          'failed-turn',
        ]);
        expect(
          onEvent.mock.calls.filter(
            ([event]) =>
              readEventType(event) === 'canopy_ai_credits_no_billing_source',
          ),
        ).toHaveLength(1);
        const creditDiagnostics = diagnostics.mock.calls.filter(
          ([entry]) => entry.kind === 'claude_ai_credits_402',
        );
        expect(creditDiagnostics).toHaveLength(1);
        expect(creditDiagnostics[0]?.[0].turnUserMessageId).toBe('failed-turn');
      } finally {
        releaseFailure();
        allowStreamExit.release();
        await session.destroy();
        diagnostics.mockRestore();
      }
    });

    it('keeps credits recovery and diagnostics independent between sessions', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue(makeAiCreditsRoutingContext());
      mockQuery.mockImplementation(() =>
        makeMessages([
          {
            type: 'result',
            is_error: true,
            result: `API Error: 402 ${AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}`,
          },
        ]),
      );
      const diagnostics = jest.spyOn(
        getObservabilityService(),
        'recordSessionDiagnostic',
      );
      const callbacks = [jest.fn(), jest.fn()];
      const sessions = callbacks.map((onEvent, index) =>
        new ClaudeCodeProvider().createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: `independent-${index}`,
            model: 'opus',
          },
          onEvent,
          getNoWindow,
        ),
      );
      try {
        await flush();
        for (const onEvent of callbacks) {
          expect(
            onEvent.mock.calls.filter(
              ([event]) =>
                readEventType(event) === 'canopy_ai_credits_no_billing_source',
            ),
          ).toHaveLength(1);
        }
        const keys = diagnostics.mock.calls
          .filter(([entry]) => entry.kind === 'claude_ai_credits_402')
          .map(([entry]) => entry.sessionKey);
        expect(keys.sort()).toEqual([
          'project/worktree/independent-0',
          'project/worktree/independent-1',
        ]);
      } finally {
        await Promise.all(sessions.map((session) => session.destroy()));
        diagnostics.mockRestore();
      }
    });

    it('records an inferred assistant refusal even without a terminal result', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue(makeAiCreditsRoutingContext());
      mockQuery.mockReturnValue(
        makeMessages([
          {
            type: 'assistant',
            error: 'billing_error',
            message: {
              content: [
                {
                  type: 'text',
                  text: `API Error: 402 ${AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}`,
                },
              ],
            },
          },
        ]),
      );
      const diagnostics = jest.spyOn(
        getObservabilityService(),
        'recordSessionDiagnostic',
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'opus',
        },
        jest.fn(),
        getNoWindow,
      );
      try {
        await flush();
        const creditDiagnostics = diagnostics.mock.calls.filter(
          ([entry]) => entry.kind === 'claude_ai_credits_402',
        );
        expect(creditDiagnostics).toHaveLength(1);
        expect(creditDiagnostics[0]?.[0].claudeAiCredits402Outcome).toBe(
          'inferred_no_billing_source',
        );
        expect(JSON.stringify(creditDiagnostics)).not.toContain(
          AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
        );
      } finally {
        await session.destroy();
        diagnostics.mockRestore();
      }
    });

    it('normalizes the SDK assistant error frame so the transcript shows one notice and no raw text', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue(makeAiCreditsRoutingContext());
      const raw = `API Error: 402 ${AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}`;
      mockQuery.mockImplementation(({ prompt }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          if (typeof prompt !== 'string')
            await prompt[Symbol.asyncIterator]().next();
          // Shapes the bundled harness emits: its synthetic assistant error
          // frame carries no `api_error_status`; only the result does.
          yield {
            type: 'assistant',
            error: 'billing_error',
            message: {
              id: 'synthetic-error-frame',
              role: 'assistant',
              model: '<synthetic>',
              content: [{ type: 'text', text: raw }],
            },
          };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: true,
            api_error_status: 402,
            result: raw,
          };
        })(),
      );
      const onEvent = jest.fn();
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'opus',
        },
        onEvent,
        getNoWindow,
      );
      session.sendMessage('hello', { userMessageId: 'sdk-turn' });
      await flush();
      const delivered: Record<string, unknown>[] = onEvent.mock.calls
        .map(([event]): unknown => event)
        .filter(
          (event): event is Record<string, unknown> =>
            event !== null &&
            typeof event === 'object' &&
            !Array.isArray(event) &&
            ['assistant', 'result'].includes(readEventType(event)),
        );
      expect(delivered.map(readEventType)).toEqual(['assistant', 'result']);
      for (const event of delivered) {
        expect(
          readEventBoolean(event, 'canopy_ai_credits_no_billing_source'),
        ).toBe(true);
      }
      let state: ReturnType<typeof createEmptyTranscriptReducerState> = {
        ...createEmptyTranscriptReducerState(),
        providerType: 'claude' as const,
      };
      let id = 0;
      for (const event of delivered) {
        state = applyClaudeTranscriptEvent(state, event, {
          now: 1,
          createMessageId: () => `row-${++id}`,
          childToolLiveness: { kind: 'unknown' },
        });
      }
      const rendered = JSON.stringify(state.messages);
      expect(rendered).not.toContain('API Error: 402');
      const systemTexts = state.messages
        .filter((message) => message.role === 'system')
        .flatMap((message) => message.blocks)
        .map((block) => (block.type === 'text' ? block.text : ''));
      expect(systemTexts).toHaveLength(1);
      expect(parseCanopyProxyError(systemTexts[0] ?? '')?.code).toBe(
        'no_billing_source',
      );
      expect(state.aiCreditsNoBillingSource?.provider).toBe('claude');
      await session.destroy();
    });

    it.each(['no_billing_source', 'session_budget_exhausted', 'unknown_code'])(
      'preserves marked %s bodies without adding a stamp',
      async (code) => {
        setAiCreditsRoutingModeCache('off');
        mockedIsNativelyAuthed.mockResolvedValue(false);
        mockedGetRoutingContext.mockResolvedValue(
          makeAiCreditsRoutingContext(),
        );
        const body = JSON.stringify({
          error: {
            canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
            code,
            correlation_id: 'original-id',
            message: 'Original message',
          },
        });
        const event = {
          type: 'result',
          is_error: true,
          api_error_status: 402,
          result: body,
        };
        mockQuery.mockReturnValue(makeMessages([event]));
        const onEvent = jest.fn();
        const session = new ClaudeCodeProvider().createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            model: 'opus',
          },
          onEvent,
          getNoWindow,
        );
        await flush();
        expect(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            ...event,
            [CHILD_TOOL_LIVENESS_STAMP]: { kind: 'no-live-session' },
          }),
        );
        expect(parseCanopyProxyError(body)?.correlationId).toBe('original-id');
        expect(
          onEvent.mock.calls.filter(
            ([entry]) =>
              readEventType(entry) === 'canopy_ai_credits_no_billing_source',
          ),
        ).toHaveLength(code === 'no_billing_source' ? 1 : 0);
        await session.destroy();
      },
    );

    it.each([
      { status: 401, text: 'Unauthorized' },
      {
        status: 402,
        text: `API Error: 402 ${AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}`,
      },
    ])(
      'preserves organization gateway HTTP $status handling without hosted inference',
      async ({ status, text }) => {
        const organizationOwner = {
          kind: 'organization' as const,
          organizationId: 'org-1',
        };
        mockResolveSessionWorkOwner.mockResolvedValueOnce(organizationOwner);
        mockResolveSessionAiCreditsAttribution.mockResolvedValueOnce({
          workOwner: organizationOwner,
        });
        mockCheckModelGatewayRoute.mockResolvedValueOnce({
          ok: true,
          orgRoute: true,
        });
        const previousModels = getAiGatewayModelEntries();
        const previousRoutes = getGatewayModelEntries();
        initAiGatewayModels(
          [
            ...previousModels,
            {
              id: 'acme-claude',
              label: 'Acme Claude',
              recommendedHarness: 'claude',
              contextWindow: 200_000,
              supportsPromptCaching: true,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
          [
            ...previousRoutes,
            {
              modelId: 'acme-claude',
              gatewayId: 'vertex/claude',
              family: 'custom',
              recommendedHarness: 'claude',
              gatewayOnly: true,
              contextWindow: 200_000,
              supportsPromptCaching: true,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
              origin: 'org-gateway',
              baseUrl: 'https://gateway.acme.test',
              organizationId: 'org-1',
              promptCachePassthrough: true,
            },
          ],
        );
        mockResolveOrgGatewayCredential.mockResolvedValue({
          baseUrl: 'https://gateway.acme.test',
          apiKey: 'sk-org',
          credentialVersion: 'credential-v1',
        });
        mockQuery.mockReturnValue(
          makeMessages([
            {
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              api_error_status: status,
              result: text,
            },
          ]),
        );

        const onEvent = jest.fn();
        const provider = new ClaudeCodeProvider();
        const session = provider.createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            model: 'acme-claude',
          },
          onEvent,
          getNoWindow,
        );

        try {
          await flush();
          await flush();
          expect(mockCheckModelGatewayRoute).toHaveBeenCalledWith(
            'acme-claude',
            organizationOwner,
          );
          const registration = mockRegisterCodexGatewayRoute.mock.calls[0]?.[0];
          expect(registration).toMatchObject({
            sessionId: 'project/worktree/chat',
            upstreamUrl: 'https://gateway.acme.test',
          });
          const options = mockQuery.mock.calls[0]?.[0].options;
          expect(options?.env).toMatchObject({
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123/codex-gateway/route-id',
            ANTHROPIC_AUTH_TOKEN: 'canopy-loopback-broker',
          });
          expect(Object.values(options?.env ?? {})).not.toContain('sk-org');
          if (status === 401) {
            expect(mockMarkOrgGatewayCredentialRejected).toHaveBeenCalledWith(
              'org-1',
              401,
              'credential-v1',
            );
          } else {
            expect(mockMarkOrgGatewayCredentialRejected).not.toHaveBeenCalled();
          }
          expect(onEvent).toHaveBeenCalledWith(
            expect.objectContaining({
              type: 'result',
              api_error_status: status,
              result: text,
            }),
          );
          expect(
            onEvent.mock.calls.some(
              ([event]) =>
                readEventBoolean(
                  event,
                  'canopy_ai_credits_no_billing_source',
                ) === true,
            ),
          ).toBe(false);
          expect(
            mockUnregisterCodexGatewayRoutesForSession,
          ).toHaveBeenCalledWith('project/worktree/chat');
        } finally {
          await session.destroy();
          initAiGatewayModels(previousModels, previousRoutes);
        }
      },
    );

    it('routes a gateway model through AI Credits with on-quota mode and no native auth', async () => {
      setAiCreditsRoutingModeCache('on-quota');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue(makeAiCreditsRoutingContext());
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );

      const onEvent = jest.fn();
      const provider = new ClaudeCodeProvider();
      provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'opus',
        },
        onEvent,
        getNoWindow,
      );

      await flush();

      // The shared routing status banner lights up (active === true).
      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: true,
        provider: 'claude',
      });
      const routedCalls = mockQuery.mock.calls as Array<
        [{ options?: { env?: Record<string, string>; model?: string } }]
      >;
      const options = routedCalls[0]?.[0]?.options;
      expect(options?.env?.ANTHROPIC_AUTH_TOKEN).toBe('csk_test');
      expect(options?.env?.ANTHROPIC_BASE_URL).toBe(
        'https://cloud.example.com/api/v1/llm-proxy/anthropic',
      );
      expect(options?.model).toBe('anthropic/claude-opus-5.5');
    });

    it('emits an unavailable error for an unresolved model with automatic routing', async () => {
      const liveChild: ChildToolLiveness = {
        kind: 'known',
        liveParentToolUseIds: ['toolu_live'],
        hasUncorrelatedLiveTask: false,
      };
      mockGetChildToolLiveness.mockReturnValue(liveChild);
      setAiCreditsRoutingModeCache('on-quota');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );

      const onEvent = jest.fn();
      const provider = new ClaudeCodeProvider();
      provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'not-a-gateway-model',
        },
        onEvent,
        getNoWindow,
      );

      await flush();

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          error:
            'This model is no longer available. Pick another model to continue.',
          [CHILD_TOOL_LIVENESS_STAMP]: liveChild,
        }),
      );
      // Routing is not applied and the cloud context is never read.
      expect(mockedGetRoutingContext).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: false,
        provider: 'claude',
      });
      // The session must abort rather than spawn natively — otherwise the user
      // gets a second raw provider auth failure on top of the backstop message.
      expect(mockQuery).not.toHaveBeenCalled();
      // A terminating result still fires so the tab status resets.
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          is_error: false,
          result: 'Session ended',
          [CHILD_TOOL_LIVENESS_STAMP]: { kind: 'no-live-session' },
        }),
      );
    });

    const unresolvedRestoredSelectionCases: Array<{
      name: string;
      routingMode: 'off' | 'on';
      aiCreditsRouting: AgentSessionOptions['aiCreditsRouting'];
      mockSuccessfulQuery: boolean;
      expectNoRoutingContext: boolean;
    }> = [
      {
        name: 'rejects an unresolved restored selection instead of launching natively after restart',
        routingMode: 'off',
        aiCreditsRouting: undefined,
        mockSuccessfulQuery: true,
        expectNoRoutingContext: false,
      },
      {
        name: 'rejects an unresolved restored selection when global routing mode is on',
        routingMode: 'on',
        aiCreditsRouting: undefined,
        mockSuccessfulQuery: false,
        expectNoRoutingContext: true,
      },
      {
        name: 'rejects an unresolved restored selection with active per-session routing',
        routingMode: 'off',
        aiCreditsRouting: {
          active: true,
          scope: 'session',
          activatedAt: 0,
        },
        mockSuccessfulQuery: false,
        expectNoRoutingContext: true,
      },
    ];

    it.each(unresolvedRestoredSelectionCases)(
      '$name',
      async ({
        routingMode,
        aiCreditsRouting,
        mockSuccessfulQuery,
        expectNoRoutingContext,
      }): Promise<void> => {
        setAiCreditsRoutingModeCache(routingMode);
        mockedIsNativelyAuthed.mockResolvedValue(true);
        if (mockSuccessfulQuery) {
          mockQuery.mockReturnValue(
            makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
          );
        }

        const onEvent = jest.fn();
        const provider = new ClaudeCodeProvider();
        provider.createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            model: 'removed-api-only-model',
            ...(aiCreditsRouting === undefined ? {} : { aiCreditsRouting }),
          },
          onEvent,
          getNoWindow,
        );

        await flush();

        expect(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'error',
            error:
              'This model is no longer available. Pick another model to continue.',
            [CHILD_TOOL_LIVENESS_STAMP]: { kind: 'no-live-session' },
          }),
        );
        if (expectNoRoutingContext) {
          expect(mockedGetRoutingContext).not.toHaveBeenCalled();
        }
        expect(mockQuery).not.toHaveBeenCalled();
      },
    );

    it('stays native when authenticated even with routing mode off (regression guard)', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );

      const onEvent = jest.fn();
      const provider = new ClaudeCodeProvider();
      provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'opus',
        },
        onEvent,
        getNoWindow,
      );

      await flush();

      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: false,
        provider: 'claude',
      });
      expect(mockedGetRoutingContext).not.toHaveBeenCalled();
      const nativeCalls = mockQuery.mock.calls as Array<
        [{ options?: { env?: Record<string, string> } }]
      >;
      const options = nativeCalls[0]?.[0]?.options;
      expect(options?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });

    // ECW-9091: `off` is the shipped default and unreachable from Settings, so
    // this is the path every credits-only account actually takes on its first
    // message. It used to spawn natively and surface `Please run /login`.
    it('routes through AI Credits with routing mode off and no native auth', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue(makeAiCreditsRoutingContext());
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );

      const onEvent = jest.fn();
      const provider = new ClaudeCodeProvider();
      provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'opus',
        },
        onEvent,
        getNoWindow,
      );

      await flush();

      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: true,
        provider: 'claude',
      });
      const options = mockQuery.mock.calls[0]?.[0]?.options;
      expect(options?.env?.ANTHROPIC_AUTH_TOKEN).toBe('csk_test');
      expect(options?.env?.ANTHROPIC_BASE_URL).toBe(
        'https://cloud.example.com/api/v1/llm-proxy/anthropic',
      );
    });

    // `AgentSessionOptions.model` is optional. Without the `no-native-auth`
    // default the gateway lookup misses and the backstop aborts a session that
    // should just work.
    it('routes the default model when the caller omitted one', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue(makeAiCreditsRoutingContext());
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );

      const onEvent = jest.fn();
      const provider = new ClaudeCodeProvider();
      provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        onEvent,
        getNoWindow,
      );

      await flush();

      const options = mockQuery.mock.calls[0]?.[0]?.options;
      expect(options?.env?.ANTHROPIC_AUTH_TOKEN).toBe('csk_test');
      expect(options?.model).toBe('anthropic/claude-opus-5.5');
      expect(onEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      );
    });

    describe('guest principal model pinning', () => {
      // Claude Code resolves its aliases, background model and subagent model
      // from these variables. A guest's proxy refuses any model off the
      // allowlist, so a guest session pins them all to its own model.
      const pinnedModelEnvNames = [
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_SMALL_FAST_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL',
      ] as const;
      const inheritedSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

      afterEach(() => {
        if (inheritedSonnetModel === undefined) {
          delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        } else {
          process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = inheritedSonnetModel;
        }
      });

      async function spawnHaikuSession(
        guestPrincipal: boolean,
      ): Promise<Record<string, string | undefined> | undefined> {
        setAiCreditsRoutingModeCache('off');
        mockedIsNativelyAuthed.mockResolvedValue(false);
        mockedGetRoutingContext.mockResolvedValue({
          cskToken: 'csk_test',
          accountIdentity: 'account-a',
          email: null,
          creditsEligible: true,
          creditsEligibilityKnown: true,
          cloudBaseUrl: 'https://cloud.example.com',
          guestPrincipal,
        });
        mockQuery.mockReturnValue(
          makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
        );

        const provider = new ClaudeCodeProvider();
        provider.createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            model: 'haiku',
          },
          jest.fn(),
          getNoWindow,
        );

        await flush();

        const options = mockQuery.mock.calls[0]?.[0]?.options;
        expect(options?.model).toBe('anthropic/claude-haiku-5.5');
        return options?.env;
      }

      it('pins every alias and background model to the session model for a guest', async () => {
        // An inherited override must not reach a guest session: the spawn env
        // layers the routing env last.
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-native';

        const env = await spawnHaikuSession(true);

        for (const name of pinnedModelEnvNames) {
          expect(env?.[name]).toBe('anthropic/claude-haiku-5.5');
        }
      });

      it('leaves alias and background models alone for a signed-in session', async () => {
        const env = await spawnHaikuSession(false);

        for (const name of pinnedModelEnvNames) {
          expect(env?.[name]).toBe(process.env[name]);
        }
      });
    });

    // No native login AND no credits: nothing can pay for the turn, so abort
    // with a message that names both remedies instead of a raw provider 401.
    it('aborts with the no-billing-source error when there is no native login and no credits', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue(null);
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );

      const onEvent = jest.fn();
      const provider = new ClaudeCodeProvider();
      provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'opus',
        },
        onEvent,
        getNoWindow,
      );

      await flush();

      const noBillingSourceError = `You're not signed in to Claude and have no ${BRAND.displayName} AI Credits available. Get AI Credits or sign in to Claude to start chatting.`;
      // The whole point of ECW-9091: a clear message naming both remedies,
      // never the raw provider `Please run /login`.
      expect(noBillingSourceError).not.toContain('/login');
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          // Machine-identifiable abort (same precedent as the Ollama code), so a
          // future desktop transcript surface and the E2E specs can key on it.
          error_code: 'no_billing_source',
          error: noBillingSourceError,
          [CHILD_TOOL_LIVENESS_STAMP]: { kind: 'no-live-session' },
        }),
      );
      // Abort, not a native spawn — a native spawn would append the raw 401.
      expect(mockQuery).not.toHaveBeenCalled();
    });

    // Bounds the blast radius: a `mode` attempt says nothing about native auth,
    // so an ineligible account still falls through to its native subscription.
    it('falls through to a native spawn when credits are ineligible under a mode attempt', async () => {
      setAiCreditsRoutingModeCache('on');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockedGetRoutingContext.mockResolvedValue(null);
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );

      const onEvent = jest.fn();
      const provider = new ClaudeCodeProvider();
      provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'opus',
        },
        onEvent,
        getNoWindow,
      );

      await flush();

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const options = mockQuery.mock.calls[0]?.[0]?.options;
      expect(options?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });
  });

  describe('hosted CLI ownership (CAN-4833)', () => {
    function isHostedCliOwner(
      value: unknown,
    ): value is HostedClaudeProcessOwner {
      return (
        typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'sessionKey') === 'string' &&
        typeof Reflect.get(value, 'recordDiagnostic') === 'function'
      );
    }

    function hostedCliOwner(call: unknown): HostedClaudeProcessOwner {
      const owner: unknown = Array.isArray(call) ? call[1] : undefined;
      if (!isHostedCliOwner(owner))
        throw new Error('Expected a hosted CLI owner.');
      return owner;
    }

    it('names its session instance as the owner of each hosted CLI (CAN-4835)', async () => {
      const registry = modelRegistry();
      const cli = new FakeHostedCli();
      const loopEnd = gate();
      mockQuery.mockImplementation((params) => {
        spawnThroughSdk(params, cli);
        return Object.assign(
          (async function* (): AsyncGenerator<unknown, void> {
            await loopEnd.wait;
            yield* [];
          })(),
          { getContextUsage: jest.fn().mockResolvedValue(null) },
        );
      });
      const diagnostics = jest
        .spyOn(getObservabilityService(), 'recordSessionDiagnostic')
        .mockImplementation(() => undefined);
      try {
        const session = new ClaudeCodeProvider().createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'owned-cli',
          },
          jest.fn(),
          getNoWindow,
        );
        await flushUntil(
          () => mockSpawnClaudeCodeProcessOffMain.mock.calls.length > 0,
        );
        const owner = hostedCliOwner(
          mockSpawnClaudeCodeProcessOffMain.mock.calls[0],
        );
        expect(owner).toMatchObject({
          sessionKey: 'project/worktree/owned-cli',
          sessionInstanceId: 'session-instance-1',
        });
        const isRegistered = owner.isRegistered;
        if (!isRegistered) throw new Error('Expected an owner check.');
        expect(isRegistered()).toBe(true);

        owner.recordDiagnostic({ kind: 'claude_process_started', pid: 4242 });
        expect(diagnostics).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'claude_process_started',
            sessionKey: 'project/worktree/owned-cli',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'owned-cli',
            sessionInstanceId: 'session-instance-1',
            providerType: 'claude',
            pid: 4242,
          }),
        );

        // A replacement under the same key takes ownership of the key.
        registry.set('project/worktree/owned-cli', {});
        expect(isRegistered()).toBe(false);
        registry.set('project/worktree/owned-cli', session);
        expect(isRegistered()).toBe(true);
        registry.delete('project/worktree/owned-cli');
        expect(isRegistered()).toBe(false);
      } finally {
        diagnostics.mockRestore();
        loopEnd.open();
        cli.exit(0, null);
      }
    });

    class FakeHostedCli extends EventEmitter {
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      killed = false;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly kill = jest.fn((signal: NodeJS.Signals): boolean => {
        void signal;
        this.killed = true;
        return true;
      });

      exit(code: number | null, signal: NodeJS.Signals | null): void {
        this.exitCode = code;
        this.signalCode = signal;
        this.emit('exit', code, signal);
      }
    }

    const mockedRegisterSession = jest.mocked(registerSession);
    const mockedGetSessionKeyOwnership = jest.mocked(getSessionKeyOwnership);

    /** Models the registry the session manager keeps, keyed like it. */
    function modelRegistry(): Map<string, unknown> {
      const registry = new Map<string, unknown>();
      mockedRegisterSession.mockImplementation((key, session) => {
        registry.set(key, session);
      });
      mockedUnregisterSession.mockImplementation((key) => {
        registry.delete(key);
      });
      mockedGetSessionKeyOwnership.mockImplementation((key, session) => {
        const registered = registry.get(key);
        if (registered === undefined) return 'released';
        return registered === session ? 'registered' : 'replaced';
      });
      return registry;
    }

    function spawnThroughSdk(
      params: Parameters<MockQuery>[0],
      cli: FakeHostedCli,
    ): void {
      mockSpawnClaudeCodeProcessOffMain.mockReturnValueOnce(cli);
      const spawn = params.options?.spawnClaudeCodeProcess;
      if (!spawn) throw new Error('Expected spawnClaudeCodeProcess option');
      spawn({
        command: '/mock/claude',
        args: [],
        cwd: '/tmp/repo',
        env: {},
        signal: new AbortController().signal,
      });
    }

    async function flushUntil(done: () => boolean): Promise<void> {
      for (let tick = 0; tick < 20 && !done(); tick += 1) await flush();
    }

    function gate(): { wait: Promise<void>; open: () => void } {
      let open = (): void => undefined;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { wait, open };
    }

    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
    });

    afterEach(() => {
      jest.useRealTimers();
      mockedRegisterSession.mockImplementation(() => undefined);
      mockedUnregisterSession.mockImplementation(() => undefined);
      mockedGetSessionKeyOwnership.mockImplementation(() => 'registered');
    });

    it('SIGKILLs a CLI that outlives a query loop which exited without closing it', async () => {
      const cli = new FakeHostedCli();
      // The SDK iterator ends while its CLI keeps running and holds stdin.
      mockQuery.mockImplementation((params) => {
        spawnThroughSdk(params, cli);
        return makeQueryResult([
          { type: 'system', subtype: 'init', session_id: 'resumed' },
        ]);
      });
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'loop-exit-without-close',
        },
        jest.fn(),
        getNoWindow,
      );
      await flushUntil(() => session.isDisposed?.() === true);
      expect(session.isDisposed?.()).toBe(true);

      // Its input closes at once, as the SDK's close() would.
      expect(cli.stdin.writableEnded).toBe(true);
      expect(cli.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(5_000);
      expect(cli.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('SIGKILLs the CLI a Stop fallback abandons while its query loop is still running', async () => {
      const cli = new FakeHostedCli();
      const chatId = 'stop-fallback-reap';
      const loopStuck = gate();
      const interrupt = jest.fn(
        (): Promise<unknown> => Promise.reject(new Error('interrupt failed')),
      );
      mockQuery.mockImplementation((params) => {
        spawnThroughSdk(params, cli);
        const { prompt } = params;
        if (typeof prompt === 'string')
          throw new Error('Expected a streaming Claude prompt');
        const input = prompt[Symbol.asyncIterator]();
        return Object.assign(
          (async function* (): AsyncGenerator<unknown, void> {
            const firstPrompt = await input.next();
            if (firstPrompt.done) return;
            const userMessageUuid = readEventString(firstPrompt.value, 'uuid');
            yield {
              type: 'system',
              subtype: 'init',
              parent_tool_use_id: null,
              session_id: chatId,
              ...(userMessageUuid
                ? { user_message_uuid: userMessageUuid }
                : {}),
              capabilities: [
                'msg_lifecycle_v1',
                'interrupt_receipt_v1',
                'interrupt_cancel_queued_v1',
              ],
            };
            // The loop never ends on its own: only the reap frees the CLI.
            await loopStuck.wait;
          })(),
          { cancelAsyncMessage: jest.fn(), interrupt },
        );
      });
      const initAdmitted = gate();
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId,
        },
        (event: unknown) => {
          if (readEventString(event, 'session_id') === chatId)
            initAdmitted.open();
        },
        getNoWindow,
      );
      session.sendMessage('Start the turn', { userMessageId: 'user-turn' });
      await initAdmitted.wait;
      const fence = captureClaudeStopFence(session);
      if (!fence) throw new Error('Expected a native Claude Stop fence');

      await expect(
        interruptClaudeSessionForStop(session, fence),
      ).resolves.toMatchObject({ outcome: 'fallback-aborted' });
      expect(cli.stdin.writableEnded).toBe(true);
      expect(cli.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(5_000);
      expect(cli.kill).toHaveBeenCalledWith('SIGKILL');

      loopStuck.open();
      await flush();
      void session.destroy();
    });

    it('does not kill a CLI that exits within the grace after its loop', async () => {
      const cli = new FakeHostedCli();
      mockQuery.mockImplementation((params) => {
        spawnThroughSdk(params, cli);
        return makeQueryResult([
          { type: 'system', subtype: 'init', session_id: 'resumed' },
        ]);
      });
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'loop-exit-clean',
        },
        jest.fn(),
        getNoWindow,
      );
      await flushUntil(() => session.isDisposed?.() === true);
      cli.exit(0, null);
      jest.advanceTimersByTime(5_000);
      expect(cli.kill).not.toHaveBeenCalled();
    });

    it('leaves a same-key replacement registered and streaming when a stale loop ends late', async () => {
      const registry = modelRegistry();
      const key = 'project/worktree/stale-cleanup';
      const scope = {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'stale-cleanup',
      };
      const staleCli = new FakeHostedCli();
      const replacementCli = new FakeHostedCli();
      const staleExit = gate();
      const replacementNext = gate();
      const replacementUsage = jest.fn().mockResolvedValue({
        categories: [],
        totalTokens: 1,
        rawMaxTokens: 10,
        percentage: 10,
      });
      mockQuery
        .mockImplementationOnce((params) => {
          spawnThroughSdk(params, staleCli);
          async function* stale(): AsyncGenerator<unknown, void> {
            if (typeof params.prompt === 'string')
              throw new Error('Expected streaming prompt');
            await params.prompt[Symbol.asyncIterator]().next();
            yield { type: 'system', subtype: 'init', session_id: 'original' };
            // After the abort the SDK ends its loop only once the CLI exits,
            // past its close grace: here, after the replacement registered.
            await staleExit.wait;
            const aborted = new Error('Operation aborted');
            aborted.name = 'AbortError';
            throw aborted;
          }
          return Object.assign(stale(), {
            getContextUsage: jest.fn().mockResolvedValue(null),
          });
        })
        .mockImplementationOnce((params) => {
          spawnThroughSdk(params, replacementCli);
          async function* replacement(): AsyncGenerator<unknown, void> {
            if (typeof params.prompt === 'string')
              throw new Error('Expected streaming prompt');
            await params.prompt[Symbol.asyncIterator]().next();
            yield { type: 'system', subtype: 'init', session_id: 'original' };
            await replacementNext.wait;
            yield {
              type: 'assistant',
              message: {
                id: 'continuation',
                role: 'assistant',
                content: [{ type: 'text', text: 'Continuing the turn.' }],
              },
            };
            await new Promise<void>(() => undefined);
          }
          return Object.assign(replacement(), {
            getContextUsage: replacementUsage,
          });
        });

      const staleEvents = jest.fn();
      const stale = new ClaudeCodeProvider().createSession(
        scope,
        staleEvents,
        getNoWindow,
      );
      stale.sendMessage('Load the deferred tool', { userMessageId: 'turn' });
      await flushUntil(() => staleEvents.mock.calls.length > 0);

      // Session teardown detaches the entry, then destroys without waiting.
      registry.delete(key);
      const staleDestroyed = stale.destroy();
      const replacementEvents = jest.fn();
      const replacement = new ClaudeCodeProvider().createSession(
        { ...scope, sdkSessionId: 'original' },
        replacementEvents,
        getNoWindow,
      );
      replacement.sendMessage('continue', { userMessageId: 'turn' });
      await flushUntil(() => replacementEvents.mock.calls.length > 0);
      expect(registry.get(key)).toBe(replacement);

      jest.mocked(rejectAllForSession).mockClear();
      mockedMarkTurnIdle.mockClear();
      mockUnregisterRoutesForSession.mockClear();
      mockUnregisterCanopyWorktreeSessionRoute.mockClear();
      mockUnregisterCodexGatewayRoutesForSession.mockClear();
      jest.mocked(recordSessionEvent).mockClear();
      staleExit.open();
      await staleDestroyed;
      await flush();

      expect(registry.get(key)).toBe(replacement);
      expect(mockedMarkTurnIdle).not.toHaveBeenCalled();
      expect(jest.mocked(recordSessionEvent)).not.toHaveBeenCalled();
      expect(jest.mocked(rejectAllForSession)).not.toHaveBeenCalled();
      expect(mockUnregisterRoutesForSession).not.toHaveBeenCalled();
      expect(mockUnregisterCanopyWorktreeSessionRoute).not.toHaveBeenCalled();
      expect(mockUnregisterCodexGatewayRoutesForSession).not.toHaveBeenCalled();
      await expect(
        getContextUsageForClaudeSession('project', 'worktree', 'stale-cleanup'),
      ).resolves.toMatchObject({ totalTokens: 1 });

      // Only the stale CLI is reaped.
      jest.advanceTimersByTime(5_000);
      expect(staleCli.kill).toHaveBeenCalledWith('SIGKILL');
      expect(replacementCli.kill).not.toHaveBeenCalled();
      expect(replacementCli.stdin.writableEnded).toBe(false);

      replacementNext.open();
      await flushUntil(() =>
        replacementEvents.mock.calls.some(
          ([event]) => readEventType(event) === 'assistant',
        ),
      );
      expect(replacementEvents).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'assistant' }),
      );
      expect(registry.get(key)).toBe(replacement);
      expect(replacement.isDisposed?.()).toBe(false);
      void replacement.destroy();
    });

    it("ignores a displaced session's late question pause, which would idle its successor", async () => {
      const registry = modelRegistry();
      const key = 'project/worktree/displaced-pause';
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'displaced-pause',
        },
        jest.fn(),
        getNoWindow,
      );
      await flush();
      const route = mockRegisterCanopyWorktreeSessionRoute.mock.calls
        .map(([registered]): unknown => registered)
        .find(
          (registered) =>
            typeof registered === 'object' &&
            registered !== null &&
            Reflect.get(registered, 'sessionKey') === key,
        );
      const callback: unknown =
        typeof route === 'object' && route !== null
          ? Reflect.get(route, 'onAwaitingUser')
          : undefined;
      const isPauseCallback = (value: unknown): value is () => void =>
        typeof value === 'function';
      if (!isPauseCallback(callback))
        throw new Error('Expected the route to report question pauses');
      const onAwaitingUser = callback;

      registry.set(key, { successor: true });
      mockedMarkTurnAwaitingUser.mockClear();
      onAwaitingUser();
      expect(mockedMarkTurnAwaitingUser).not.toHaveBeenCalled();

      registry.set(key, session);
      onAwaitingUser();
      expect(mockedMarkTurnAwaitingUser).toHaveBeenCalledWith(key);
      await session.destroy();
    });

    it("leaves a successor's live background tasks when a displaced session starts its query", async () => {
      const registry = modelRegistry();
      const key = 'project/worktree/displaced-query-start';
      mockQuery.mockReturnValue(
        makeMessages([{ type: 'result', is_error: false, result: 'done' }]),
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'displaced-query-start',
        },
        jest.fn(),
        getNoWindow,
      );
      // A successor registers before this session's query loop starts.
      registry.set(key, { successor: true });
      jest.mocked(resetSessionLiveBackgroundTasks).mockClear();
      await flushUntil(() => mockQuery.mock.calls.length > 0);

      expect(mockQuery).toHaveBeenCalled();
      expect(resetSessionLiveBackgroundTasks).not.toHaveBeenCalled();
      await session.destroy();
    });
  });
});
jest.mock('../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: (
    ...args: Parameters<typeof ModelGatewayStateModule.checkModelGatewayRoute>
  ): ReturnType<typeof ModelGatewayStateModule.checkModelGatewayRoute> =>
    mockCheckModelGatewayRoute(...args),
}));
jest.mock('../agents/work-owner', () => ({
  ...jest.requireActual<typeof WorkOwnerModule>('../agents/work-owner'),
  resolveSessionWorkOwner: (
    ...args: Parameters<typeof WorkOwnerModule.resolveSessionWorkOwner>
  ): ReturnType<typeof WorkOwnerModule.resolveSessionWorkOwner> =>
    mockResolveSessionWorkOwner(...args),
}));

describe('Claude input delivery receipts', () => {
  function fixture(cancelAsyncMessage = jest.fn(() => Promise.resolve(true))): {
    delivery: ClaudeInputDelivery;
    events: jest.Mock;
    pickup: jest.Mock;
    interrupt: jest.Mock<
      Promise<{ cancelled: string[]; still_queued: string[] }>
    >;
    lifecycle: (state: string, id?: string) => void;
    submit: () => ReturnType<ClaudeInputDelivery['submit']>;
  } {
    const events = jest.fn();
    const pickup = jest.fn(() => false);
    const delivery = new ClaudeInputDelivery('generation', events, pickup);
    const interrupt = jest.fn(
      (): Promise<{ cancelled: string[]; still_queued: string[] }> =>
        Promise.resolve({
          cancelled: [],
          still_queued: [],
        }),
    );
    delivery.setQuery({ cancelAsyncMessage, interrupt });
    delivery.observe({
      type: 'system',
      subtype: 'init',
      capabilities: [
        'msg_lifecycle_v1',
        'interrupt_receipt_v1',
        'interrupt_cancel_queued_v1',
      ],
    });
    const lifecycle = (state: string, id = 'attempt'): void =>
      delivery.observe({ type: 'command_lifecycle', command_uuid: id, state });
    const submit = (): ReturnType<ClaudeInputDelivery['submit']> =>
      delivery.submit('text', 'attempt', 'row', () => {
        delivery.claimYield('attempt');
        lifecycle('queued');
      });
    return { delivery, events, pickup, interrupt, lifecycle, submit };
  }

  it('bounds outstanding input correlation without forgetting an unresolved owner', async () => {
    const f = fixture();
    for (let i = 0; i < 1024; i++) {
      const id = `pending-${i}`;
      await f.delivery.submit('text', id, id, () => {
        f.delivery.claimYield(id);
        f.lifecycle('queued', id);
      });
    }
    const enqueue = jest.fn(() => {
      f.lifecycle('queued', 'overflow');
    });
    await expect(
      f.delivery.submit('text', 'overflow', 'overflow', enqueue),
    ).resolves.toMatchObject({ kind: 'rejected' });
    expect(enqueue).not.toHaveBeenCalled();
    await expect(f.delivery.withdraw('pending-0')).resolves.toMatchObject({
      kind: 'withdrawn',
    });
    await expect(
      f.delivery.submit('text', 'replacement', 'replacement', () =>
        f.lifecycle('queued', 'replacement'),
      ),
    ).resolves.toMatchObject({ kind: 'accepted' });
    await expect(f.delivery.withdraw('pending-1')).resolves.toMatchObject({
      kind: 'withdrawn',
    });
  });

  it('settles a withdrawal from correlated lifecycle while the control response is delayed', async () => {
    let response: (value: boolean) => void = (): void => {
      throw new Error('Control response was not initialized');
    };
    const f = fixture(
      jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            response = resolve;
          }),
      ),
    );
    await f.submit();
    let settled = false;
    const withdrawal = f.delivery.withdraw('attempt').then((result) => {
      settled = result.kind === 'withdrawn';
      return result;
    });
    f.lifecycle('cancelled');
    await flush();
    const observedBeforeResponse = settled;
    response(true);
    await withdrawal;
    expect(observedBeforeResponse).toBe(true);
  });

  it('retains ownership after a false receipt and releases only the disposed query reservation', async () => {
    const f = fixture(jest.fn(() => Promise.resolve(false)));
    await f.submit();
    await expect(f.delivery.withdraw('attempt')).resolves.toMatchObject({
      kind: 'unconfirmed',
    });
    expect(f.delivery.hasPending()).toBe(true);
    f.delivery.dispose();
    expect(f.delivery.hasPending()).toBe(false);
    expect(f.events).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'withdrawn' }),
    );
  });

  it('withdraws a staging input before sweep so delayed normalization cannot yield afterward', async () => {
    const f = fixture();
    const submit = f.delivery.submit('text', 'attempt', 'row', () => undefined);
    await f.delivery.sweep();
    expect(f.delivery.claimYield('attempt')).toBe(false);
    await expect(submit).resolves.toMatchObject({ kind: 'rejected' });
    expect(f.interrupt).toHaveBeenCalledWith({ cancelQueued: true });
  });

  it('does not let child lifecycle or a late completed input change root pickup', async () => {
    const f = fixture();
    await f.submit();
    f.delivery.observe({
      type: 'command_lifecycle',
      command_uuid: 'attempt',
      state: 'started',
      parent_tool_use_id: 'child',
    });
    expect(f.pickup).not.toHaveBeenCalled();
    f.lifecycle('started');
    f.lifecycle('completed');
    f.lifecycle('started');
    expect(f.pickup).toHaveBeenCalledTimes(1);
  });

  describe('a root submission past the delivery deadline', () => {
    const SENTINEL = 'payload-sentinel-41d7';

    afterEach(() => {
      jest.useRealTimers();
    });

    function unknownEvents(events: jest.Mock): unknown[] {
      return events.mock.calls
        .map(([event]: unknown[]) => event)
        .filter(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'phase' in event &&
            event.phase === 'unknown',
        );
    }

    async function pendingSubmission(
      f: ReturnType<typeof fixture>,
    ): Promise<void> {
      jest.useFakeTimers();
      const submission = f.delivery.submit(
        `text ${SENTINEL}`,
        'attempt',
        'row',
        () => f.delivery.claimYield('attempt'),
        { pendingOnDeadline: true },
      );
      await jest.advanceTimersByTimeAsync(5001);
      await expect(submission).resolves.toEqual({
        kind: 'pending',
        attemptId: 'attempt',
      });
    }

    it('reads as pending, then accepted and picked up from a late lifecycle', async () => {
      const f = fixture();
      await pendingSubmission(f);
      expect(f.events).not.toHaveBeenCalled();
      f.lifecycle('queued');
      f.lifecycle('started');
      expect(f.events.mock.calls.map(([event]: unknown[]) => event)).toEqual([
        expect.objectContaining({ attemptId: 'attempt', phase: 'accepted' }),
        expect.objectContaining({ attemptId: 'attempt', phase: 'picked-up' }),
      ]);
      expect(f.pickup).toHaveBeenCalledWith('row');
      f.delivery.dispose();
      expect(unknownEvents(f.events)).toEqual([]);
    });

    it('becomes unknown with the session-ended failure when the session ends unacknowledged', async () => {
      const f = fixture();
      await pendingSubmission(f);
      f.delivery.dispose();
      expect(unknownEvents(f.events)).toEqual([
        expect.objectContaining({
          attemptId: 'attempt',
          failure: {
            class: 'restart',
            code: 'session-ended',
            summary:
              'The provider session ended before the message was confirmed.',
          },
        }),
      ]);
      expect(JSON.stringify(f.events.mock.calls)).not.toContain(SENTINEL);
    });

    it('can still be withdrawn with a confirmed receipt', async () => {
      const f = fixture();
      await pendingSubmission(f);
      await expect(f.delivery.withdraw('attempt')).resolves.toEqual({
        kind: 'withdrawn',
        attemptId: 'attempt',
        evidenceId: 'attempt',
      });
      expect(f.events).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: 'attempt', phase: 'withdrawn' }),
      );
      f.delivery.dispose();
      expect(unknownEvents(f.events)).toEqual([]);
    });

    it('stays unknown with the enqueue-failed failure on both the event and the admission', async () => {
      const f = fixture();
      const result = await f.delivery.submit(
        `text ${SENTINEL}`,
        'attempt',
        'row',
        () => {
          throw new Error(`stdin closed while writing ${SENTINEL}`);
        },
        { pendingOnDeadline: true },
      );
      const failure = {
        class: 'transport',
        code: 'enqueue-failed',
        summary: 'The message could not be handed to the provider.',
      };
      expect(result).toEqual({
        kind: 'unknown',
        attemptId: 'attempt',
        reason:
          'Delivery was not confirmed. This message will not be resent automatically.',
        failure,
      });
      expect(unknownEvents(f.events)).toEqual([
        expect.objectContaining({ attemptId: 'attempt', failure }),
      ]);
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
      expect(JSON.stringify(f.events.mock.calls)).not.toContain(SENTINEL);
    });
  });
});

describe('claude-session Ledger tools', () => {
  const LEDGER_BLOCK = 'Ledger block for this session.';
  const HINT = '<feed_assignments>changed</feed_assignments>';

  function fakeLedgerSession(): {
    systemPrompt: jest.Mock<string, []>;
    assignmentHint: jest.Mock<Promise<string | undefined>, []>;
    dispose: jest.Mock<void, []>;
    execute: jest.Mock;
  } {
    return {
      systemPrompt: jest.fn(() => LEDGER_BLOCK),
      assignmentHint: jest.fn(() => Promise.resolve(HINT)),
      dispose: jest.fn<void, []>(),
      execute: jest.fn(),
    };
  }

  function capturePromptMessages(): unknown[] {
    const messages: unknown[] = [];
    mockQuery.mockImplementation((params) => {
      async function* consumePrompt(): AsyncGenerator<unknown, void> {
        if (typeof params.prompt === 'string') {
          throw new Error('Expected streaming Claude prompt input');
        }
        const next = await params.prompt[Symbol.asyncIterator]().next();
        messages.push(next.value);
        yield { type: 'result', is_error: false, result: 'done' };
      }
      return consumePrompt();
    });
    return messages;
  }

  function readSystemPromptAppend(): unknown {
    const systemPrompt = mockQuery.mock.calls[0]?.[0]?.options?.systemPrompt;
    return typeof systemPrompt === 'object' && systemPrompt !== null
      ? Reflect.get(systemPrompt, 'append')
      : undefined;
  }

  afterEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockMayExposeLedgerTools.mockReset();
    mockMayExposeLedgerTools.mockReturnValue(false);
    mockOpenLedgerChatTools.mockReset();
    mockOpenLedgerChatTools.mockResolvedValue(null);
  });

  it('advertises, prompts, hints and disposes the Ledger tools of an exposed session', async () => {
    const ledger = fakeLedgerSession();
    mockMayExposeLedgerTools.mockReturnValue(true);
    mockOpenLedgerChatTools.mockResolvedValue(ledger);
    const messages = capturePromptMessages();

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ledger-chat',
        selectedRepoId: 'api',
        systemPromptAppend: 'Base prompt.',
      },
      jest.fn(),
      getNoWindow,
    );
    session.sendMessage('Do the work');
    await flush();
    await flush();

    expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        toolSurface: 'native-sdk',
        ledgerTools: ledger,
      }),
    );
    expect(readSystemPromptAppend()).toBe(`Base prompt.\n\n${LEDGER_BLOCK}`);
    expect(messages[0]).toMatchObject({
      message: { role: 'user', content: `${HINT}\n\nDo the work` },
    });
    const [options] = mockOpenLedgerChatTools.mock.calls[0] ?? [];
    expect(options?.target).toMatchObject({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'ledger-chat',
    });
    expect(options?.harness).toBe('claude');
    expect(options?.selectedRepoId).toBe('api');

    await session.destroy();
    expect(ledger.dispose).toHaveBeenCalled();
  });

  it('records the live session settings as author details', async () => {
    const ledger = fakeLedgerSession();
    mockMayExposeLedgerTools.mockReturnValue(true);
    mockOpenLedgerChatTools.mockResolvedValue(ledger);
    mockQuery.mockReturnValue(
      makeQueryResult([{ type: 'result', is_error: false, result: 'done' }]),
    );

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ledger-settings',
        model: 'claude-opus-4-8',
        thinkingLevel: 'high',
      },
      jest.fn(),
      getNoWindow,
    );
    await flush();
    const [options] = mockOpenLedgerChatTools.mock.calls[0] ?? [];
    const before = options?.readSettings();
    await session.setPlanMode(true);
    const during = options?.readSettings();

    expect(before).toMatchObject({
      model: 'claude-opus-4-8',
      planMode: false,
    });
    expect(typeof before?.thinkingEffort).toBe('string');
    expect(during?.planMode).toBe(true);
    await session.destroy();
  });

  it.each([
    ['the synchronous gate fails', false, null],
    ['the setting or scope check fails', true, null],
  ])(
    'leaves the route and prompt without Ledger tools when %s',
    async (_label, mayExpose, opened) => {
      mockMayExposeLedgerTools.mockReturnValue(mayExpose);
      mockOpenLedgerChatTools.mockResolvedValue(opened);
      mockQuery.mockReturnValue(
        makeQueryResult([{ type: 'result', is_error: false, result: 'done' }]),
      );

      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'ledger-off',
          systemPromptAppend: 'Base prompt.',
        },
        jest.fn(),
        getNoWindow,
      );
      await flush();

      const registeredRoute: unknown =
        mockRegisterCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
      expect(registeredRoute).toMatchObject({ toolSurface: 'native-sdk' });
      expect(registeredRoute).not.toHaveProperty('ledgerTools');
      expect(readSystemPromptAppend()).toBe('Base prompt.');
      expect(mockOpenLedgerChatTools).toHaveBeenCalledTimes(mayExpose ? 1 : 0);
      await session.destroy();
    },
  );

  it('opens the Ledger tools of an exposed App Advisor session for its Work Entry under the Advisor names', async () => {
    const ledger = fakeLedgerSession();
    mockMayExposeLedgerTools.mockReturnValue(true);
    mockOpenLedgerChatTools.mockResolvedValue(ledger);
    const messages = capturePromptMessages();
    const appAdvisorRuntime = createAppAdvisorRuntimeFixture();

    const session = new ClaudeCodeProvider().createSession(
      {
        cwd: '/tmp/advisor',
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
        chatId: 'advisor-chat',
        assistantMode: 'app-advisor',
        appAdvisorRuntime,
        systemPromptAppend: 'Advisor prompt.',
      },
      jest.fn(),
      getNoWindow,
    );
    session.sendMessage('Inspect the app');
    await flush();
    await flush();

    const target = {
      projectId: 'app-advisor',
      worktreeId: 'entry-1',
      chatId: 'advisor-chat',
      assistantMode: 'app-advisor',
    };
    expect(mockMayExposeLedgerTools).toHaveBeenCalledWith(target);
    const [options] = mockOpenLedgerChatTools.mock.calls[0] ?? [];
    expect(options?.target).toEqual(target);
    expect(options?.harness).toBe('claude');
    expect(options?.toolNames).toEqual(getAppAdvisorLedgerToolNames('claude'));
    expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMode: 'app-advisor',
        worktreeId: 'entry-1',
        appAdvisorRuntime,
        ledgerTools: ledger,
      }),
    );
    expect(readSystemPromptAppend()).toBe(`Advisor prompt.\n\n${LEDGER_BLOCK}`);
    expect(messages[0]).toMatchObject({
      message: { role: 'user', content: `${HINT}\n\nInspect the app` },
    });

    await session.destroy();
    expect(ledger.dispose).toHaveBeenCalled();
  });

  it.each([
    ['the synchronous gate fails', false],
    ['the setting or scope check fails', true],
  ])(
    'leaves an App Advisor session without Ledger tools when %s',
    async (_label, mayExpose) => {
      mockMayExposeLedgerTools.mockReturnValue(mayExpose);
      mockOpenLedgerChatTools.mockResolvedValue(null);
      mockQuery.mockReturnValue(
        makeQueryResult([{ type: 'result', is_error: false, result: 'done' }]),
      );

      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/advisor',
          projectId: 'app-advisor',
          worktreeId: 'entry-1',
          chatId: 'advisor-chat',
          assistantMode: 'app-advisor',
          appAdvisorRuntime: createAppAdvisorRuntimeFixture(),
          systemPromptAppend: 'Advisor prompt.',
        },
        jest.fn(),
        getNoWindow,
      );
      await flush();

      const registeredRoute: unknown =
        mockRegisterCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
      expect(registeredRoute).toMatchObject({ assistantMode: 'app-advisor' });
      expect(registeredRoute).not.toHaveProperty('ledgerTools');
      expect(readSystemPromptAppend()).toBe('Advisor prompt.');
      expect(mockOpenLedgerChatTools).toHaveBeenCalledTimes(mayExpose ? 1 : 0);
      await session.destroy();
    },
  );

  describe('Plan mode', () => {
    const addLedgerEntry =
      CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry.claudeToolName;

    async function planModeHook(
      approvalMode: 'ask' | 'full-access',
      planMode: boolean,
    ): Promise<
      (toolName: string, toolInput: Record<string, unknown>) => Promise<unknown>
    > {
      mockQuery.mockReturnValue(
        makeQueryResult([{ type: 'result', is_error: false, result: 'done' }]),
      );
      const session = new ClaudeCodeProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: `plan-${approvalMode}-${String(planMode)}`,
          approvalMode,
          planMode,
        },
        jest.fn(),
        getNoWindow,
      );
      await flush();
      sessionsToDestroy.push(session);
      const hook =
        mockQuery.mock.calls[0]?.[0]?.options?.hooks?.PreToolUse?.find(
          (entry) => entry.matcher === '*',
        )?.hooks[0];
      if (!hook) throw new Error('Expected the approval PreToolUse hook');
      return (toolName, toolInput) =>
        hook(
          {
            hook_event_name: 'PreToolUse',
            session_id: 'session',
            transcript_path: '/tmp/transcript.jsonl',
            cwd: '/tmp/repo',
            tool_name: toolName,
            tool_input: toolInput,
            tool_use_id: `${toolName}-use`,
          },
          `${toolName}-use`,
          { signal: new AbortController().signal },
        );
    }

    const sessionsToDestroy: { destroy(): Promise<void> }[] = [];

    afterEach(async () => {
      for (const session of sessionsToDestroy.splice(0)) {
        await session.destroy();
      }
    });

    it('lets Ledger bookkeeping through the ordinary approval policy while other tools keep theirs', async () => {
      mockApprovalCheck.mockResolvedValue({ decision: 'allow' });
      const runHook = await planModeHook('ask', true);

      const ledger = await runHook(addLedgerEntry, {
        type: 'TASK',
        title: 'Planned step',
        content: 'Recorded while planning.',
      });
      const edit = await runHook('Edit', {
        file_path: '/tmp/repo/src/index.ts',
        old_string: 'a',
        new_string: 'b',
      });

      expect(mockQuery.mock.calls[0]?.[0]?.options?.permissionMode).toBe(
        'plan',
      );
      expect(mockApprovalCheck).toHaveBeenCalledWith(
        { kind: 'mcp', server: 'canopy', tool: 'AddFeedEntry' },
        expect.anything(),
      );
      expect(ledger).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason:
            'Approved by the application approval policy.',
          additionalContext: CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT,
        },
      });
      expect(edit).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason:
            'Approved by the application approval policy.',
        },
      });
    });

    it.each([undefined, '', ' \n\t '])(
      'uses policy attribution for missing or blank denial message %p',
      async (message) => {
        mockApprovalCheck.mockResolvedValue({ decision: 'deny', message });
        const runHook = await planModeHook('ask', false);
        await expect(
          runHook('Bash', { command: 'git status' }),
        ).resolves.toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Denied by the approval policy.',
          },
        });
      },
    );

    it.each([false, true])(
      'preserves attributed user reasons and stopTurn %p',
      async (stopTurn) => {
        const message =
          'The user denied this tool call: Not on this branch.\nKeep this detail.';
        mockApprovalCheck.mockResolvedValue({
          decision: 'deny',
          message,
          stopTurn,
        });
        const runHook = await planModeHook('ask', false);
        await expect(
          runHook('Bash', { command: 'git status' }),
        ).resolves.toEqual({
          ...(stopTurn ? { continue: false, stopReason: message } : {}),
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: message,
          },
        });
      },
    );

    it('forwards the specific safety denial through the Claude PreToolUse hook', async () => {
      const message =
        'Blocked by a safety rule (force-push). This call cannot be approved from a prompt. Do not retry or repackage the blocked operation. Choose a safe alternative or explain the block to the user.';
      mockApprovalCheck.mockResolvedValue({ decision: 'deny', message });
      const runHook = await planModeHook('ask', false);
      await expect(
        runHook('Bash', { command: 'git push --force origin HEAD' }),
      ).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: message,
        },
      });
    });

    it('still denies Ledger bookkeeping when the approval policy denies it', async () => {
      mockApprovalCheck.mockResolvedValue({
        decision: 'deny',
        message: 'Denied by a rule.',
      });
      const runHook = await planModeHook('ask', true);

      await expect(
        runHook(addLedgerEntry, { type: 'TASK', title: 'T', content: 'C' }),
      ).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Denied by a rule.',
        },
      });
    });

    it('marks Ledger calls as bookkeeping under Full Access planning but not outside Plan mode', async () => {
      const planning = await planModeHook('full-access', true);
      await expect(
        planning(addLedgerEntry, { type: 'TASK', title: 'T', content: 'C' }),
      ).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT,
        },
      });

      mockQuery.mockReset();
      mockApprovalCheck.mockResolvedValue({ decision: 'allow' });
      const working = await planModeHook('ask', false);
      await expect(
        working(addLedgerEntry, { type: 'TASK', title: 'T', content: 'C' }),
      ).resolves.toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason:
            'Approved by the application approval policy.',
        },
      });
    });
  });
});
