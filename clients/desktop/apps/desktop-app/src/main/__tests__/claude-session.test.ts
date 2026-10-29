import type { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseModelPackageConfig } from '@canopy/desktop-shared/model-config';
import { createAppAdvisorRuntimeFixture } from './fixtures/app-advisor-runtime';
import type * as WorkOwnerModule from '../agents/work-owner';
import type { AccountProxySessionRoute } from '../account-proxy/routing';

type MockQuery = (params: Parameters<typeof claudeQuery>[0]) => unknown;

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
const mockRecordUsageLimitedChat = jest.fn(() => Promise.resolve());
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
const mockResolveOrgGatewayCredential = jest.fn();
const mockMarkOrgGatewayCredentialRejected = jest.fn(() => Promise.resolve());
const mockRegisterCodexGatewayRoute = jest.fn(() =>
  Promise.resolve({
    routeId: 'route-id',
    baseUrl: 'http://127.0.0.1:43123/codex-gateway/route-id',
  }),
);
const mockUnregisterCodexGatewayRoutesForSession = jest.fn();
const mockHasCodeGraph = jest.fn(() => false);
const mockManagedDelegationEnabled = jest.fn(() => false);
const mockCreateManagedDelegationSession = jest.fn();
const mockAttentionMark = jest.fn();
const mockAttentionClear = jest.fn();
const mockResolveSessionAiCreditsAttribution = jest.fn(() =>
  Promise.resolve({}),
);
const mockResolveSessionWorkOwner = jest.fn(() =>
  Promise.resolve({ kind: 'personal' as const }),
);
const mockCheckModelGatewayRoute = jest.fn(() =>
  Promise.resolve({ ok: true as const, orgRoute: false }),
);

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
  return { ...actual, spawn: mockSpawn };
});
jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: mockSpawnClaudeCodeProcessOffMain,
  withholdClaudeProcessStdoutCreditUntil:
    mockWithholdClaudeProcessStdoutCreditUntil,
}));
jest.mock('../agents/delegation/gate', () => ({
  managedDelegationEnabled: mockManagedDelegationEnabled,
}));
jest.mock('../agents/delegation/service', () => ({
  createManagedDelegationSession: mockCreateManagedDelegationSession,
}));
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));
jest.mock('../lib/process-kill', () => ({
  killChildProcessGroup: mockKillChildProcessGroup,
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
  loadCachedInventory: mockLoadCachedInventory,
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
const mockRegisterCanopyWorktreeSessionRoute = jest.fn(() =>
  Promise.resolve('session-route'),
);
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
    registerCanopyWorktreeSessionRoute: mockRegisterCanopyWorktreeSessionRoute,
    unregisterCanopyWorktreeSessionRoute:
      mockUnregisterCanopyWorktreeSessionRoute,
    unregisterRoutesForSession: mockUnregisterRoutesForSession,
    getCanopyWorktreeMcpUrl: mockGetCanopyWorktreeMcpUrl,
    getCanopyWorktreeUiMcpUrl: mockGetCanopyWorktreeUiMcpUrl,
  })),
}));
jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(() => ({
    registerRoute: mockRegisterCodexGatewayRoute,
    unregisterRoutesForSession: mockUnregisterCodexGatewayRoutesForSession,
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
    hasGraph: mockHasCodeGraph,
  }),
}));
jest.mock('../mcp/plan-pending-requests', () => ({
  createPendingPlanExit: jest.fn(),
  rejectAllPlanExitsForSession: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  registerSession: jest.fn(),
  unregisterSession: jest.fn(),
  buildSessionKey: jest.fn(
    (p: string, w: string, c: string) => `${p}/${w}/${c}`,
  ),
  markTurnActive: jest.fn(),
  markTurnAwaitingUser: jest.fn(),
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
jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: jest.Mock; clear: jest.Mock } => ({
    mark: mockAttentionMark,
    clear: mockAttentionClear,
  }),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordUsageLimitedChat: mockRecordUsageLimitedChat,
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): { commitPlanExit: typeof mockCommitPlanExit } => ({
    commitPlanExit: mockCommitPlanExit,
  }),
}));
jest.mock('../ollama/claude-compatible', () => ({
  resolveClaudeCompatibleInvocation: mockResolveClaudeCompatibleInvocation,
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
      ...args: unknown[]
    ): Promise<unknown> => mockResolveSessionAiCreditsAttribution(...args),
    resolveOrgGatewayCredential: mockResolveOrgGatewayCredential,
    markOrgGatewayCredentialRejected: mockMarkOrgGatewayCredentialRejected,
  };
});
jest.mock('../lib/plan-persistence', () => ({
  createTrackedPlan: createTrackedPlanMock,
  updateTrackedPlan: updateTrackedPlanMock,
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: sendToWindowMock,
  sendToWindowDetailed: sendToWindowDetailedMock,
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
  createApprovalSession: mockCreateApprovalSession,
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
  createEmptyTranscriptReducerState,
} from '@canopy/agent-transcript';
import {
  AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
  parseCanopyProxyError,
} from '@canopy/protocol';
import { skillShareNudgeState } from '../agents/skill-share-nudge-state';
import {
  ClaudeCodeProvider,
  getContextUsageForClaudeSession,
  stopNativeSubagentForClaudeSession,
  stopTaskForClaudeSession,
} from '../agents/claude-session';
import { OllamaProvider } from '../agents/ollama-provider';
import {
  isSessionAccountProxyRouted,
  markTurnAwaitingUser,
  markTurnIdle,
  recordSessionAccountProxyRoute,
  recordSessionEvent,
  resetSessionLiveBackgroundTasks,
  unregisterSession,
} from '../agents/session-manager';
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
} from '@canopy/desktop-shared/types';
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
import type {
  ApprovalCheck,
  ApprovalCheckDisplay,
} from '../approvals/approval-service';
import * as PreferencesStoreModule from '../lib/preferences-store';
import * as GlobalPluginOverlayModule from '../plugins/global-plugin-overlay';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';
import { CLAUDE_CODE_GRAPH_STEERING_CONTEXT } from '../lib/claude-code-graph-steering';
import type * as LedgerToolsRuntimeModule from '../canopy-tools/ledger-tools-runtime';
import { CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT } from '../agents/claude-approval-adapter';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { ClaudeInputDelivery } from '../agents/claude-input-delivery';
import { setExperimentalFeaturesEnabled } from '../lib/experimental-features';

const CHAIN_UUID = '11111111-2222-4333-8444-555555555555';

const mockedUnregisterSession = jest.mocked(unregisterSession);
const mockedReadLocalMemoryEnabledPreference = jest.mocked(
  readLocalMemoryEnabledPreference,
);
const mockedMarkTurnIdle = jest.mocked(markTurnIdle);
const mockedMarkTurnAwaitingUser = jest.mocked(markTurnAwaitingUser);
const mockedIsNativelyAuthed = jest.mocked(isProviderNativelyAuthenticated);
const mockedGetRoutingContext = jest.mocked(getAiCreditsRoutingContext);

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
  setPermissionMode: jest.Mock;
} {
  return Object.assign(makeMessages(messages), {
    applyFlagSettings: jest.fn().mockResolvedValue(undefined),
    setPermissionMode: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
    setPermissionMode: jest.fn().mockResolvedValue(undefined),
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
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockSpawn.mockReset();
    mockKillChildProcessGroup.mockReset();
    mockRegisterCanopyWorktreeSessionRoute.mockClear();
    mockUnregisterCanopyWorktreeSessionRoute.mockClear();
    mockUnregisterRoutesForSession.mockClear();
    mockGetCanopyWorktreeMcpUrl.mockClear();
    mockGetCanopyWorktreeUiMcpUrl.mockClear();
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
          await iterator.next();
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
        expect.any<() => boolean>(Function),
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

  it.each(['Unknown task task-1', 'No such task: task-1'])(
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
    await session.cancel();
    expect(session.isDisposed?.()).toBe(true);

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
    let readCurrentOptions: (() => { selectedModel?: unknown }) | undefined;
    mockManagedDelegationEnabled.mockReturnValue(true);
    mockCreateManagedDelegationSession.mockImplementationOnce(
      (options: { currentOptions: () => { selectedModel?: unknown } }) => {
        readCurrentOptions = options.currentOptions;
        return Promise.resolve({
          detach: jest.fn(),
          observe: jest.fn(),
          mcpTools: [],
          ownsTool: jest.fn(() => false),
          bareClaudeName: jest.fn((name: string) => name),
          parent: {
            nativeMessageUuid: jest.fn(() => undefined),
            invokeClaude: jest.fn(),
            bindClaude: jest.fn(),
            acknowledgeTool: jest.fn(),
          },
        });
      },
    );
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

    const hostedProcess = {
      stdin: {},
      stdout: {},
      killed: false,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
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

    expect(mockSpawnClaudeCodeProcessOffMain).toHaveBeenCalledWith(options);
    expect(spawned).toBe(hostedProcess);
    expect(mockSpawn).not.toHaveBeenCalled();

    await session.destroy();
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
      { toolUseID: 'watch-command-1', signal: new AbortController().signal },
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

    await canUseTool('ExitPlanMode', { plan: 'Standalone plan' });

    expect(createTrackedPlanMock).not.toHaveBeenCalled();
    expect(updateTrackedPlanMock).not.toHaveBeenCalled();
    expect(sendToWindowMock).not.toHaveBeenCalled();

    await session.destroy();
  });

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

    await canUseTool('ExitPlanMode', { plan: 'Persist this plan' });

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
    await canUseTool('ExitPlanMode', { plan: 'Review this plan' });
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
    await canUseTool('ExitPlanMode', { plan: 'Persist without a window' });

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
      { toolUseID: 'tool-use-1' },
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
      { toolUseID: 'shared-tool-use' },
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
          // @ts-expect-error Exercise defensive handling of malformed SDK input.
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
    expect(onEvent).toHaveBeenCalledWith({
      type: 'error',
      error: 'Ollama unavailable',
    });
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

    expect(onEvent).toHaveBeenCalledWith({
      type: 'error',
      error: 'Ollama unavailable',
      error_code: OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
      provider: 'ollama',
    });
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
    const count = 64;
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
      expect(pulled).toBe(1);
      releaseSink();
      for (
        let attempts = 0;
        attempts < 100 && ids.length < count;
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

  it('can cancel an Ollama delegate while its first stream event awaits persistence', async () => {
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
    mockQuery.mockImplementation(
      ({ prompt }: { prompt: AsyncGenerator<unknown> }) =>
        (async function* (): AsyncGenerator<unknown, void> {
          await prompt.next();
          yield {
            type: 'assistant',
            message: {
              id: 'ollama-held-event',
              role: 'assistant',
              content: [{ type: 'text', text: 'held' }],
            },
          };
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
    const session = new OllamaProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ollama-cancel',
        model: 'ollama-llama3:8b',
      },
      (event) => {
        if (readEventType(event) !== 'assistant') return;
        signalFirst();
        return heldSink;
      },
      getNoWindow,
    );
    try {
      session.sendMessage('Cancel Ollama', { userMessageId: 'ollama-user' });
      await first;
      await expect(session.cancel()).resolves.toBeUndefined();
      expect(session.isDisposed()).toBe(true);
    } finally {
      releaseSink();
      await session.destroy();
    }
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
      (event) => events.push(event),
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

  it('delivers a structured provider auth-failure event to the renderer after the failing event', async () => {
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
      (event) => events.push(event),
      getNoWindow,
    );

    session.sendMessage('Continue', { userMessageId: 'user-msg-1' });
    await flush();
    await flush();

    const authEvent = events.find(isCanopyAuthFailureEventData);
    expect(authEvent).toBeDefined();
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
  });

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
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        resumeSessionId: 'resumed-session',
      },
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
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        resumeSessionId: 'resumed-session',
      },
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
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        resumeSessionId: 'resumed-session',
      },
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
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        resumeSessionId: 'resumed-session',
      },
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
    mockCreateManagedDelegationSession.mockResolvedValue({
      detach: jest.fn(),
      observe: jest.fn(),
      mcpTools: [],
      ownsTool: (name: string): boolean => name === 'mcp__canopy__DelegateTask',
      bareClaudeName: (): string => 'DelegateTask',
      parent: {
        nativeMessageUuid: jest.fn(),
        invokeClaude: jest.fn(),
        acknowledgeTool: jest.fn(),
        bindClaude: jest.fn(() => ({ ok: true, value: bound })),
      },
    });
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
        toolUseID: 'managed-call',
        signal,
      }),
    ).toMatchObject({ behavior: 'allow' });
    expect(
      await canUseTool(
        'mcp__canopy__DelegateTask',
        { ...bound, prompt: 'Different task' },
        { toolUseID: 'managed-call', signal },
      ),
    ).toMatchObject({ behavior: 'deny' });
    await session.destroy();
  });

  it('appends managed delegation steering to the Claude system prompt', async () => {
    mockManagedDelegationEnabled.mockReturnValue(true);
    mockCreateManagedDelegationSession.mockResolvedValue({
      detach: jest.fn(),
      observe: jest.fn(),
      mcpTools: [],
      systemPromptGuidance: 'Managed delegation: watch completions.',
      ownsTool: (): boolean => false,
      parent: { nativeMessageUuid: jest.fn() },
    });
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

  it('detaches the chat delegations on Stop instead of closing them', async () => {
    mockManagedDelegationEnabled.mockReturnValue(true);
    const managed = {
      detach: jest.fn(),
      close: jest.fn(),
      cancel: jest.fn(),
      observe: jest.fn(),
      mcpTools: [],
      ownsTool: (): boolean => false,
      parent: { nativeMessageUuid: jest.fn() },
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

    await session.cancel();
    await flush();

    // The Claude query ends; the chat's delegates keep running under the
    // chat-scoped owner until the user stops them.
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
      new Promise((resolveInitialization) => {
        finishInitialization = (): void =>
          resolveInitialization({
            detach: detachDelegation,
            observe: jest.fn(),
            mcpTools: [],
            ownsTool: jest.fn(() => false),
            bareClaudeName: jest.fn((name: string) => name),
            parent: {
              nativeMessageUuid: jest.fn(() => undefined),
              invokeClaude: jest.fn(),
              bindClaude: jest.fn(),
              acknowledgeTool: jest.fn(),
            },
          });
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

    expect(onEvent).toHaveBeenCalledWith({
      type: 'result',
      is_error: false,
      result: 'Session aborted',
      canopy_turn_user_message_id: 'user-message-1',
    });
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

    expect(onEvent).toHaveBeenCalledWith({
      type: 'result',
      is_error: false,
      result: 'Session aborted',
    });
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
        mockedGetRoutingContext.mockResolvedValue({
          cskToken: 'csk_test',
          email: 'user@example.com',
          creditsEligible: true,
          cloudBaseUrl: 'https://cloud.example.com',
        });
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
        mockedGetRoutingContext.mockResolvedValue({
          cskToken: 'csk_test',
          email: 'user@example.com',
          creditsEligible: true,
          cloudBaseUrl: 'https://cloud.example.com',
        });
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
        mockedGetRoutingContext.mockResolvedValue({
          cskToken: 'csk_test',
          email: 'user@example.com',
          creditsEligible: true,
          cloudBaseUrl: 'https://cloud.example.com',
        });
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
        });
        const delivered: unknown = onEvent.mock.calls
          .map(([event]): unknown => event)
          .find((event) => readEventType(event) === 'result');
        expect(jest.mocked(recordSessionEvent)).toHaveBeenCalledWith(
          'project/worktree/chat',
          delivered,
        );
        expect(
          parseCanopyProxyError(readEventString(delivered, 'result'))
            ?.correlationId,
        ).toBeNull();
        expect(failure).toEqual(original);
        await session.destroy();
      },
    );

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
        mockedGetRoutingContext.mockResolvedValue({
          cskToken: 'csk_test',
          email: 'user@example.com',
          creditsEligible: true,
          cloudBaseUrl: 'https://cloud.example.com',
        });
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
        expect(onEvent).toHaveBeenCalledWith(event);
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
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
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
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
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
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      let releaseFailure = (): void => undefined;
      const failureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
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
        await session.destroy();
        diagnostics.mockRestore();
      }
    });

    it('keeps credits recovery and diagnostics independent between sessions', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
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
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
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
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
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
      const delivered: unknown[] = onEvent.mock.calls
        .map(([event]): unknown => event)
        .filter((event) =>
          ['assistant', 'result'].includes(readEventType(event)),
        );
      expect(delivered.map(readEventType)).toEqual(['assistant', 'result']);
      for (const event of delivered) {
        expect(
          readEventBoolean(event, 'canopy_ai_credits_no_billing_source'),
        ).toBe(true);
      }
      let state = {
        ...createEmptyTranscriptReducerState(),
        providerType: 'claude' as const,
      };
      let id = 0;
      for (const event of delivered) {
        state = applyClaudeTranscriptEvent(state, event, {
          now: 1,
          createMessageId: () => `row-${++id}`,
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
        mockedGetRoutingContext.mockResolvedValue({
          cskToken: 'csk_test',
          email: 'user@example.com',
          creditsEligible: true,
          cloudBaseUrl: 'https://cloud.example.com',
        });
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
        expect(onEvent).toHaveBeenCalledWith(event);
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
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
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

      expect(onEvent).toHaveBeenCalledWith({
        type: 'error',
        error:
          'This model is no longer available. Pick another model to continue.',
      });
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
      expect(onEvent).toHaveBeenCalledWith({
        type: 'result',
        is_error: false,
        result: 'Session ended',
      });
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

        expect(onEvent).toHaveBeenCalledWith({
          type: 'error',
          error:
            'This model is no longer available. Pick another model to continue.',
        });
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
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
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
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
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
      ): Promise<Record<string, string> | undefined> {
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
      expect(onEvent).toHaveBeenCalledWith({
        type: 'error',
        // Machine-identifiable abort (same precedent as the Ollama code), so a
        // future desktop transcript surface and the E2E specs can key on it.
        error_code: 'no_billing_source',
        error: noBillingSourceError,
      });
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
});
jest.mock('../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: (...args: unknown[]): unknown =>
    mockCheckModelGatewayRoute(...args),
}));
jest.mock('../agents/work-owner', () => ({
  ...jest.requireActual<typeof WorkOwnerModule>('../agents/work-owner'),
  resolveSessionWorkOwner: (...args: unknown[]): unknown =>
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
