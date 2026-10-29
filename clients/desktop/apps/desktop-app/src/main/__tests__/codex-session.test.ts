import {
  recordPresentationTurn,
  clearPresentationTurn,
} from '../canopy-tools/presentation-state';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BrowserWindow } from 'electron';
import { parseModelPackageConfig } from '@canopy/desktop-shared/model-config';
import { createAppAdvisorRuntimeFixture } from './fixtures/app-advisor-runtime';
import type * as WorkOwnerModule from '../agents/work-owner';
import type {
  AccountProxySessionRoute,
  ResolveAccountProxySessionRouteOptions,
} from '../account-proxy/routing';
import {
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  omitModelFeatureFlags,
  type ChatModel,
} from '@canopy/desktop-shared/types';

const mockWaitForPendingCodexFork = jest.fn<
  Promise<string | undefined>,
  unknown[]
>(() => Promise.resolve(undefined));
const mockLoadCodexForkContinuation = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve(undefined),
);
jest.mock('../codex/fork-thread', () => ({
  waitForPendingCodexFork: (...args: unknown[]): Promise<string | undefined> =>
    mockWaitForPendingCodexFork(...args),
}));
jest.mock('../codex/transcript-seed', () => ({
  loadCodexForkContinuation: (...args: unknown[]): Promise<unknown> =>
    mockLoadCodexForkContinuation(...args),
  loadPersistedCodexFallbackSeedItems: jest.fn(() => Promise.resolve([])),
}));

const registerSessionMock = jest.fn<void, unknown[]>();
const unregisterSessionMock = jest.fn();
const mockMarkSessionForNextTurnRecreation = jest.fn();
const interruptTurnMock = jest.fn();
const setApprovalModeMock = jest.fn();
const disposeMock = jest.fn();
const startTurnMock = jest.fn();
const DEFAULT_MOCK_THREAD_ID = 'old-thread-without-tools';
/**
 * Thread id reported by the mocked app-server client. Shared by every mock
 * instance so a test can model a session whose thread id changes across
 * rebuilds (the per-thread retry budget depends on it).
 */
const getThreadIdMock = jest.fn<string | undefined, []>(
  () => DEFAULT_MOCK_THREAD_ID,
);
const mockRecordSessionDiagnostic = jest.fn();
const stopSessionPhaseTimerMock = jest.fn();
const mockUnregisterRoutesForSession = jest.fn();
// The MCP proxy and the Codex gateway proxy both expose
// `unregisterRoutesForSession`, and most assertions here only care about the
// combined call count. This wrapper keeps that count identical while letting
// the CAN-1814 teardown test distinguish the MCP registry's own calls, which
// are the ones that evict `pendingByOwner` / `toolNamesByRouteOwner`.
const mockUnregisterMcpRoutesForSession = jest.fn(
  (...args: unknown[]): void => {
    mockUnregisterRoutesForSession(...args);
  },
);
const mockRegisterGatewayRoute = jest.fn<
  Promise<{ routeId: string; baseUrl: string }>,
  [
    request: {
      sessionId: string;
      upstreamUrl: string;
      resolveToken: () => Promise<
        string | { token: string; credentialVersion?: string } | null
      >;
      onCredentialRejected?: (
        status: 401 | 403,
        credentialVersion?: string,
      ) => Promise<void> | void;
    },
  ]
>(() =>
  Promise.resolve({
    routeId: 'gateway-route',
    baseUrl: 'http://127.0.0.1:43123/codex-gateway/gateway-route',
  }),
);
const mockLoadModelGatewayCredential = jest.fn();
const mockMarkModelGatewayCredentialRejected = jest.fn(() =>
  Promise.resolve(true),
);
const mockResolveCodexMockAppServerOverride = jest.fn(() => null);
const mockRegisterStdioMcpRoute = jest.fn();
const mockRevokeStdioMcpRoutes = jest.fn();
const createManagedDelegationSessionMock = jest.fn();
const noteChatSessionEventMock = jest.fn<
  { kind: 'non_retryable_failure'; detail?: string } | null,
  [target: unknown, provider: unknown, eventData: unknown]
>(() => null);
const mockRecordUsageLimitedChat = jest.fn(() => Promise.resolve());
const mockCommitPlanExit = jest.fn(() => Promise.resolve());
const approvalCheckMock = jest.fn();
const approvalSetModeMock = jest.fn();
const approvalInvalidatePendingMock = jest.fn();
const approvalDisposeMock = jest.fn();
const originalHarnessNativeMemory = process.env.CANOPY_HARNESS_NATIVE_MEMORY;
const mockLoadCachedInventory = jest.fn();
const mockResolveEffectivePluginSelectionRefs = jest.fn();
const mockCodexAggregateSkillInvocationNamesForRefs = jest.fn();
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
jest.mock('../agents/session-manager', () => ({
  markSessionForNextTurnRecreation: (...args: unknown[]): void => {
    mockMarkSessionForNextTurnRecreation(...args);
  },
  registerSession: jest.fn((...args: unknown[]): void => {
    registerSessionMock(...args);
  }),
  unregisterSession: jest.fn((...args: unknown[]): void => {
    unregisterSessionMock(...args);
  }),
  buildSessionKey: jest.fn(
    (projectId: string, worktreeId: string, chatId: string) =>
      `${projectId}/${worktreeId}/${chatId}`,
  ),
  markTurnActive: jest.fn(),
  markTurnIdle: jest.fn(),
  noteSessionMessageQueued: jest.fn(),
  recordSessionEvent: jest.fn(),
  createSessionPhaseTimer: jest.fn(() => stopSessionPhaseTimerMock),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  recordSessionAccountProxyRoute: jest.fn(),
}));
jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: jest.Mock; clear: jest.Mock } => ({
    mark: mockAttentionMark,
    clear: mockAttentionClear,
  }),
}));
// Local memory is opt-in (CAN-1969); resolve synchronously (no fs I/O) so the
// tests' microtask flushes still observe the thread launch. Default off.
jest.mock('../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  ),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));
// No account proxy is set up in these tests; resolve without file I/O for the
// same reason as the preferences mock above.
const mockResolveAccountProxySessionRoute = jest.fn<
  Promise<AccountProxySessionRoute | null>,
  [ResolveAccountProxySessionRouteOptions]
>((): Promise<AccountProxySessionRoute | null> => Promise.resolve(null));
jest.mock('../account-proxy/routing', () => ({
  resolveAccountProxySessionRoute: (
    options: ResolveAccountProxySessionRouteOptions,
  ): Promise<AccountProxySessionRoute | null> =>
    mockResolveAccountProxySessionRoute(options),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordUsageLimitedChat: mockRecordUsageLimitedChat,
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): { commitPlanExit: typeof mockCommitPlanExit } => ({
    commitPlanExit: mockCommitPlanExit,
  }),
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    check: approvalCheckMock,
    setMode: approvalSetModeMock,
    invalidatePending: approvalInvalidatePendingMock,
    dispose: approvalDisposeMock,
  })),
}));
jest.mock('../lib/resolve-workspace-display-name', () => ({
  resolveWorkspaceRecordingSnapshot: jest.fn().mockResolvedValue({
    name: 'Workspace',
    type: 'single-repo',
  }),
}));

jest.mock('../codex/app-server-client', () => ({
  CodexAppServerClient: jest.fn().mockImplementation(() => ({
    startTurn: startTurnMock,
    interruptTurn: interruptTurnMock,
    setApprovalMode: setApprovalModeMock,
    dispose: disposeMock,
    getThreadId: getThreadIdMock,
  })),
}));

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    registerStdioMcpRoute: mockRegisterStdioMcpRoute,
    revokeStdioMcpRoutes: mockRevokeStdioMcpRoutes,
  })),
}));

jest.mock('../agents/delegation/service', () => ({
  createManagedDelegationSession: createManagedDelegationSessionMock,
}));

// Default to a natively-authenticated user so the common spawn path stays
// native (the AI Credits resolver returns null and never spawns a second
// app-server for the auth probe). Individual tests override this to exercise
// the on-quota missing-native-auth routing / backstop behavior.
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
  };
});

jest.mock('../plugins/plugin-resolver', () => ({
  MISSING_PLUGIN_PATH_WARNING_PREFIX: 'Plugin path does not exist:',
  resolvePlugins: jest.fn(),
  resolveEffectivePluginSelectionRefs: mockResolveEffectivePluginSelectionRefs,
  codexAggregateSkillInvocationNamesForRefs:
    mockCodexAggregateSkillInvocationNamesForRefs,
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

jest.mock('@canopy/desktop-shared/node/e2e-mock-env', () => ({
  resolveCodexMockAppServerOverride: mockResolveCodexMockAppServerOverride,
}));

jest.mock('../lib/transient-error-retry-service', () => ({
  noteChatSessionEvent: noteChatSessionEventMock,
}));

jest.mock('../pipelines/config-paths', () => ({
  getEnhancedEnv: jest.fn(() => ({
    PATH: '/mock/bin',
    CANOPY_ENV_ENHANCED: '1',
    UNDEFINED_VALUE: undefined,
  })),
}));

jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    unregisterRoutesForSession: mockUnregisterMcpRoutesForSession,
    getCodexCapabilityAuthorityIds: jest.fn(() => []),
    shutdown: jest.fn(() => Promise.resolve()),
  })),
}));

jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(() => ({
    registerRoute: mockRegisterGatewayRoute,
    unregisterRoutesForSession: mockUnregisterRoutesForSession,
    shutdown: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../lib/model-gateway-credential-store', () => ({
  loadModelGatewayCredential: (...args: unknown[]): unknown =>
    mockLoadModelGatewayCredential(...args),
  markModelGatewayCredentialRejected: (...args: unknown[]): unknown =>
    mockMarkModelGatewayCredentialRejected(...args),
}));

jest.mock('../codex/gateway-model-catalog', () => ({
  ensureGatewayCompatibleCodexCatalog: jest
    .fn()
    .mockResolvedValue('/tmp/codex-gateway-models.json'),
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
// Whether a resumed thread has a capability record decides whether it can
// have the Ledger tools. Tests say which threads have one; none by default.
const mockReadCapabilityLease = jest.fn<Promise<unknown>, [string]>(() =>
  Promise.resolve(null),
);
jest.mock('../codex/capability-store', () => ({
  ...jest.requireActual<typeof CapabilityStoreModule>(
    '../codex/capability-store',
  ),
  getDesktopCodexCapabilityStore: (): {
    readLease: (threadId: string) => Promise<unknown>;
  } => ({
    readLease: (threadId: string): Promise<unknown> =>
      mockReadCapabilityLease(threadId),
  }),
}));

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
  })),
}));

// Speed admission is covered against the real catalog in
// codex-speed-policy.test.ts; here it is observed and controlled.
const mockAdmitCodexSpeed = jest.fn<Promise<unknown>, [string, unknown]>(
  (speed) =>
    Promise.resolve({
      speed,
      availability: {
        speed,
        status: 'available',
        reason: speed === 'ultrafast' ? 'advertised' : 'not-gated',
        generation: 1,
      },
      generation: 1,
    }),
);
const mockReportCodexSpeedTurnFailure = jest.fn<boolean, unknown[]>(
  () => false,
);
jest.mock('../codex/speed-policy', () => ({
  ...jest.requireActual<Record<string, unknown>>('../codex/speed-policy'),
  admitCodexSpeed: (...args: [string, unknown]): Promise<unknown> =>
    mockAdmitCodexSpeed(...args),
  reportCodexSpeedTurnFailure: (...args: unknown[]): boolean =>
    mockReportCodexSpeedTurnFailure(...args),
}));

import {
  IPC_CHANNELS,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  getAppAdvisorLedgerToolNames,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import { skillShareNudgeState } from '../agents/skill-share-nudge-state';
import { CodexProvider } from '../agents/codex-session';
import { CodexSpeedUnsupportedError } from '@canopy/desktop-shared/lib/codex-speed';
import { CodexAppServerClient } from '../codex/app-server-client';
import {
  CodexAppServerJsonRpcError,
  CodexAppServerRequestTimeoutError,
  CodexSharedRestartPeerError,
} from '@canopy/desktop-shared/node/codex-runtime/connection';
import { getEnhancedEnv } from '../pipelines/config-paths';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { BRAND } from '@canopy/brand/current';
import { isProviderNativelyAuthenticated } from '../auth/provider-auth-state';
import {
  clearAiCreditsRoutingModeCache,
  getAiCreditsRoutingContext,
  setAiCreditsRoutingModeCache,
} from '../agents/ai-credits-routing';
import type * as AiCreditsRoutingModule from '../agents/ai-credits-routing';
import type { AgentSessionOptions } from '../agents/types';
import {
  clearAllProviderQuotaReached,
  isProviderQuotaReached,
  markProviderQuotaReached,
  clearSessionProxyFailure,
  recordSessionProxyFailure,
} from '../agents/ai-credits-quota-state';
import {
  isSessionAccountProxyRouted,
  isSessionAiCreditsRouted,
  recordSessionAccountProxyRoute,
} from '../agents/session-manager';
import {
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE,
  AI_CREDITS_USAGE_LIMIT_EVENT_TYPE,
  isCanopyAuthFailureEventData,
  NO_BILLING_SOURCE_ERROR_CODE,
} from '@canopy/desktop-shared/types';
import {
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG,
  AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
  AI_CREDITS_WORK_OWNER_REFUSED_MESSAGE,
  parseCanopyProxyError,
} from '@canopy/protocol';
import type * as PreferencesStoreModule from '../lib/preferences-store';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';
import type * as LedgerToolsRuntimeModule from '../canopy-tools/ledger-tools-runtime';
import type * as CapabilityStoreModule from '../codex/capability-store';
import {
  LedgerChatToolsSession,
  type LedgerToolsHost,
} from '../canopy-tools/ledger-tools-runtime';
import { buildLedgerPlanModeInstruction } from '../canopy-tools/prompting';

const mockedReadLocalMemoryEnabledPreference = jest.mocked(
  readLocalMemoryEnabledPreference,
);

const mockedResolvePlugins = jest.mocked(resolvePlugins);
const mockedIsNativelyAuthed = jest.mocked(isProviderNativelyAuthenticated);
const mockedGetRoutingContext = jest.mocked(getAiCreditsRoutingContext);
const mockedGetEnhancedEnv = jest.mocked(getEnhancedEnv);

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  }
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

async function flushMicrotasks(): Promise<void> {
  // Drain enough microtasks for the async spawn path to settle, including the
  // AI Credits routing resolver's awaited native-auth probe before the turn
  // reaches idle-timer scheduling.
  //
  // The count is a budget, not a measurement: it has to exceed the deepest
  // await chain on the spawn path, and every added `await` frame there spends
  // one. A too-small budget fails as "startTurn was never called" rather than
  // as a timeout, so it reads like a behavior regression. Kept comfortably
  // above the current depth so an added frame does not re-stage that
  // misdiagnosis.
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
}

type WindowSendMock = jest.MockedFunction<
  (channel: string, ...args: unknown[]) => void
>;

const windowSendMocks = new WeakMap<BrowserWindow, WindowSendMock>();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow();
  const sendMock: WindowSendMock = jest.fn();
  win.isDestroyed = (): boolean => false;
  win.webContents.isCrashed = (): boolean => false;
  win.webContents.isDestroyed = (): boolean => false;
  win.webContents.send = sendMock;
  Object.defineProperty(win.webContents, 'mainFrame', {
    configurable: true,
    value: {
      detached: false,
      isDestroyed: (): boolean => false,
    },
  });
  windowSendMocks.set(win, sendMock);
  return win;
}

function getWindowSendMock(win: BrowserWindow): WindowSendMock {
  const sendMock = windowSendMocks.get(win);
  if (!sendMock) throw new Error('Missing send mock for BrowserWindow');
  return sendMock;
}

type FakeWindow = ReturnType<typeof createWindow>;

/** Returns the Electron mock's statically typed BrowserWindow instance. */
function fakeWindowGetter(win: FakeWindow = createWindow()): () => FakeWindow {
  return (): FakeWindow => win;
}

function isCodexErrorResultEvent(value: unknown): value is {
  type: 'result';
  is_error: true;
  subtype: 'codex_error';
  result: string;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    Reflect.get(value, 'type') === 'result' &&
    Reflect.get(value, 'is_error') === true &&
    Reflect.get(value, 'subtype') === 'codex_error' &&
    typeof Reflect.get(value, 'result') === 'string'
  );
}

function initializeTestModelCatalog(): void {
  const pkg: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  );
  const config = parseModelPackageConfig(pkg);
  const codexModels = omitModelFeatureFlags(config.codexModels);
  initClaudeModels(omitModelFeatureFlags(config.claudeModels));
  initCodexModels(codexModels);
  initAiGatewayModels(
    [
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        recommendedHarness: 'codex',
        contextWindow: 1_000_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'flat',
      },
    ],
    [
      ...codexModels.flatMap((entry) =>
        entry.gatewayId
          ? [
              {
                modelId: entry.id,
                gatewayId: entry.gatewayId,
                recommendedHarness: 'codex' as const,
                gatewayOnly: false,
                contextWindow: entry.contextWindow ?? 400_000,
                supportsPromptCaching: false,
                supportedThinkingLevels: [],
                toolSchemaProfile: 'standard' as const,
              },
            ]
          : [],
      ),
      {
        modelId: 'deepseek-v4-pro',
        gatewayId: 'deepseek/deepseek-v4-pro',
        recommendedHarness: 'codex',
        gatewayOnly: true,
        contextWindow: 1_000_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'flat',
      },
    ],
  );
  initModelAliases(config.modelAliases);
}

describe('codex-session app-server integration', () => {
  beforeAll(() => {
    initializeTestModelCatalog();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockWaitForPendingCodexFork.mockResolvedValue(undefined);
    mockLoadCodexForkContinuation.mockResolvedValue(undefined);
    getThreadIdMock.mockReturnValue(DEFAULT_MOCK_THREAD_ID);
    interruptTurnMock.mockResolvedValue(undefined);
    setApprovalModeMock.mockResolvedValue(undefined);
    disposeMock.mockResolvedValue(undefined);
    approvalCheckMock.mockResolvedValue({ decision: 'allow' });
    mockedResolvePlugins.mockResolvedValue({
      sdkPlugins: [],
      skillPluginDir: null,
      selectedCapabilityRoots: [],
      codexProcessEnv: {},
      codexMcpServers: {},
      mcpServers: {},
      warnings: [],
    });
    mockResolveCodexMockAppServerOverride.mockReturnValue(null);
    mockLoadCachedInventory.mockResolvedValue(null);
    mockResolveEffectivePluginSelectionRefs.mockImplementation(
      (selections: ChatTabPluginSelections) =>
        Promise.resolve({
          skillRefs: selections.skillRefs,
          pluginRefs: selections.pluginRefs,
          mcpServerRefs: selections.mcpServerRefs ?? [],
          warnings: [],
        }),
    );
    mockCodexAggregateSkillInvocationNamesForRefs.mockReturnValue(new Map());
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalHarnessNativeMemory === undefined) {
      delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    } else {
      process.env.CANOPY_HARNESS_NATIVE_MEMORY = originalHarnessNativeMemory;
    }
  });

  it('waits for fork readiness before sending an immediate Continue', async () => {
    let completeFork: ((threadId: string) => void) | undefined;
    mockWaitForPendingCodexFork.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeFork = resolve;
        }),
    );
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'fork-pending',
      },
      jest.fn(),
      () => null,
    );
    try {
      session.sendMessage('Continue');
      await flush();
      const dispatchedWhileForkPending = startTurnMock.mock.calls.length;
      completeFork?.('native-fork');
      await flush();
      expect(dispatchedWhileForkPending).toBe(0);
      expect(CodexAppServerClient).toHaveBeenCalledWith(
        expect.objectContaining({ initialThreadId: 'native-fork' }),
      );
      expect(startTurnMock).toHaveBeenCalledTimes(1);
    } finally {
      await session.destroy();
    }
  });

  it('does not dispatch cancelled input when a delayed fork completes', async () => {
    let completeFork: ((threadId: string) => void) | undefined;
    mockWaitForPendingCodexFork.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeFork = resolve;
        }),
    );
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'fork-cancelled',
      },
      jest.fn(),
      () => null,
    );
    try {
      session.sendMessage('Cancel this Continue');
      await flush();
      await session.cancel();
      completeFork?.('native-fork');
      await flush();
      expect(startTurnMock).not.toHaveBeenCalled();
    } finally {
      await session.destroy();
    }
  });

  it('seeds a failed native fork before sending its continuation', async () => {
    const seedItems = [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Our review code word is marigold.' },
        ],
      },
    ];
    mockWaitForPendingCodexFork.mockRejectedValueOnce(
      new Error('native fork unavailable'),
    );
    mockLoadCodexForkContinuation.mockResolvedValueOnce({ seedItems });
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'fork-failed',
      },
      jest.fn(),
      () => null,
    );
    try {
      session.sendMessage('Continue');
      await flush();
      expect(CodexAppServerClient).toHaveBeenCalledWith(
        expect.objectContaining({
          fallbackSeedItems: seedItems,
          seedNewThreadFromFallback: true,
        }),
      );
      expect(startTurnMock).toHaveBeenCalledTimes(1);
    } finally {
      await session.destroy();
    }
  });

  it('does not dispatch a new turn when fork history cannot be restored', async () => {
    mockLoadCodexForkContinuation.mockRejectedValueOnce(
      new Error('fork history unavailable'),
    );
    const onEvent = jest.fn();
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'fork-unavailable',
      },
      onEvent,
      () => null,
    );
    try {
      session.sendMessage('Continue');
      await flush();
      expect(startTurnMock).not.toHaveBeenCalled();
      expect(CodexAppServerClient).not.toHaveBeenCalled();
      expect(JSON.stringify(onEvent.mock.calls)).toContain(
        'fork history unavailable',
      );
    } finally {
      await session.destroy();
    }
  });

  it.each([false, true])(
    'normalizes a known invocation immediately before the Codex app-server handoff (eligible: %s)',
    async (eligible) => {
      const recordUse = jest
        .spyOn(skillShareNudgeState, 'recordUse')
        .mockResolvedValue(undefined);
      mockLoadCachedInventory.mockResolvedValue({
        version: 2,
        builtAt: '2026-08-31T00:00:00.000Z',
        entries: [
          {
            id: 'codex-skill-review',
            provider: 'codex',
            kind: 'skill',
            name: 'review',
            displayName: '$builtin-app-plugin:review',
            description: 'Review the change',
            insertText: '$builtin-app-plugin:review ',
            invocationKey: '$builtin-app-plugin:review',
            enableRef: {
              kind: 'skill',
              sourceId: 'test-source',
              skillName: 'review',
            },
          },
        ],
      });
      mockCodexAggregateSkillInvocationNamesForRefs.mockReturnValue(
        new Map([['test-source/review', 'review']]),
      );
      startTurnMock.mockResolvedValue({ status: 'completed' });
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'invocation-normalization',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'test-source', skillName: 'review' }],
            pluginRefs: [],
          },
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('/review this change', {
        userMessageId: 'eligible-user',
        countsTowardSkillUsage: eligible,
      });
      await flush();
      await flushMicrotasks();

      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '$builtin-app-plugin:review this change',
        }),
      );
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

  it('routes an organization Codex model through the configured v1 base', async () => {
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
    initAiGatewayModels(
      [
        {
          id: 'acme-qwen',
          label: 'Acme Qwen',
          recommendedHarness: 'codex',
          contextWindow: 131_072,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'flat',
        },
      ],
      [
        {
          modelId: 'acme-qwen',
          gatewayId: 'fireworks/qwen',
          family: 'custom',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 131_072,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'flat',
          origin: 'org-gateway',
          baseUrl: 'https://gateway.acme.test',
          organizationId: 'org-1',
          promptCachePassthrough: true,
        },
      ],
    );
    mockLoadModelGatewayCredential.mockResolvedValue({
      organizationId: 'org-1',
      apiKey: 'sk-org',
      baseUrlAtSave: 'https://gateway.acme.test',
      updatedAt: 'credential-v1',
    });
    startTurnMock.mockResolvedValue({ status: 'completed' });

    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'acme-qwen',
      },
      jest.fn(),
      () => null,
    );
    try {
      session.sendMessage('Run through Acme');
      await flushMicrotasks();

      expect(mockCheckModelGatewayRoute).toHaveBeenCalledWith(
        'acme-qwen',
        organizationOwner,
      );
      expect(mockRegisterGatewayRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          upstreamUrl: 'https://gateway.acme.test/v1',
        }),
      );
      const registration = mockRegisterGatewayRoute.mock.calls[0]?.[0];
      expect(typeof registration?.onCredentialRejected).toBe('function');
      await registration?.onCredentialRejected?.(401, 'credential-v1');
      expect(mockMarkModelGatewayCredentialRejected).toHaveBeenCalledWith(
        'org-1',
        'Gateway returned HTTP 401.',
        'credential-v1',
      );
    } finally {
      await session.destroy();
      initializeTestModelCatalog();
    }
  });

  it('skips standalone normalization when the session selection cannot be resolved', async () => {
    mockLoadCachedInventory.mockResolvedValue({
      version: 2,
      builtAt: '2026-08-31T00:00:00.000Z',
      entries: [
        {
          id: 'codex-skill-review',
          provider: 'codex',
          kind: 'skill',
          name: 'review',
          displayName: '$builtin-app-plugin:review',
          description: 'Review the change',
          insertText: '$builtin-app-plugin:review ',
          invocationKey: '$builtin-app-plugin:review',
          enableRef: {
            kind: 'skill',
            sourceId: 'test-source',
            skillName: 'review',
          },
        },
      ],
    });
    mockResolveEffectivePluginSelectionRefs.mockRejectedValueOnce(
      new Error('selection unavailable'),
    );
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'unresolved-invocation-selection',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'test-source', skillName: 'review' }],
          pluginRefs: [],
        },
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('/review this change');
    await flush();
    await flushMicrotasks();

    expect(startTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/review this change' }),
    );
    await session.destroy();
  });

  it('uses the session skill selection instead of globally cached generated names', async () => {
    mockLoadCachedInventory.mockResolvedValue({
      version: 2,
      builtAt: '2026-08-31T00:00:00.000Z',
      entries: [
        {
          id: 'codex-skill-review-2',
          provider: 'codex',
          kind: 'skill',
          name: 'review-2',
          displayName: '$builtin-app-plugin:review-2',
          description: 'Review the change',
          insertText: '$builtin-app-plugin:review-2 ',
          invocationKey: '$builtin-app-plugin:review-2',
          enableRef: {
            kind: 'skill',
            sourceId: 'second-source',
            skillName: 'review',
          },
        },
      ],
    });
    mockCodexAggregateSkillInvocationNamesForRefs.mockReturnValue(
      new Map([['second-source/review', 'review']]),
    );
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'session-authoritative-invocation',
        pluginSelections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'second-source', skillName: 'review' }],
          pluginRefs: [],
        },
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('/review this change');
    await flush();
    await flushMicrotasks();

    expect(startTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '$builtin-app-plugin:review this change',
      }),
    );
    await session.destroy();
  });

  it('omits the native-memory suppression from thread config by default (local memory opt-in)', async () => {
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'memory-default-off',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run once');
    await flush();
    await flushMicrotasks();

    const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    expect(clientArgs?.threadConfig ?? {}).not.toHaveProperty(
      'features.memories',
    );
    await session.destroy();
  });

  it('passes the flattened native-memory suppression in thread config while local memory is enabled', async () => {
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    mockedReadLocalMemoryEnabledPreference.mockResolvedValueOnce(true);
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'memory-suppression',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run once');
    await flush();
    await flushMicrotasks();

    const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    expect(clientArgs?.threadConfig).toMatchObject({
      'features.memories': false,
    });
    expect(clientArgs?.threadConfig?.features).toBeUndefined();
    await session.destroy();
  });

  it.each([
    ['a new thread', undefined],
    ['a resumed thread', 'known-thread'],
  ])(
    'gives the client repository instruction delivery for %s',
    async (_label, sdkSessionId) => {
      startTurnMock.mockResolvedValue({ status: 'completed' });
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'project-doc-config',
          ...(sdkSessionId ? { sdkSessionId } : {}),
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('Run once');
      await flush();
      await flushMicrotasks();

      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(clientArgs?.initialThreadId).toBe(sdkSessionId);
      expect(clientArgs?.threadConfig).toMatchObject({
        project_doc_max_bytes: 131_072,
        project_doc_fallback_filenames: ['CLAUDE.md'],
      });
      await session.destroy();
    },
  );

  it('refreshes a prepared Ollama runtime model when the live model changes', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const prepareInvocation = jest.fn(
      (model: string | undefined, reason: 'session-start' | 'model-change') =>
        Promise.resolve({
          source: 'ollama' as const,
          harness: 'codex' as const,
          runtimeModel: `runtime:${String(model)}`,
          aiCreditsRouted: false,
          codexConfig: { model: `runtime:${String(model)}` },
          reason,
        }),
    );
    const provider = new CodexProvider({
      providerType: 'ollama',
      prepareInvocation,
    });
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ollama-model-change',
        model: 'ollama-old',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run once');
    await flush();
    await flushMicrotasks();
    expect(startTurnMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: 'runtime:ollama-old' }),
    );

    await session.setModel?.('ollama-new');
    expect(prepareInvocation).toHaveBeenNthCalledWith(
      2,
      'ollama-new',
      'model-change',
    );
    session.sendMessage('Run again');
    await flush();
    await flushMicrotasks();

    expect(startTurnMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: 'runtime:ollama-new' }),
    );
    await session.destroy();
  });

  it('applies a client release deferred by an active managed delegation', async () => {
    let activeCount = 1;
    let onActivityChange: ((count: number) => void) | undefined;
    const managedSession = {
      get activeCount(): number {
        return activeCount;
      },
      codexTools: [],
      observe: jest.fn(),
      retireTurn: jest.fn(),
      detach: jest.fn(),
    };
    createManagedDelegationSessionMock.mockImplementationOnce(
      (options: { onActivityChange?: (count: number) => void }) => {
        onActivityChange = options.onActivityChange;
        return Promise.resolve(managedSession);
      },
    );
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const prepareInvocation = jest.fn(
      (model: string | undefined, reason: 'session-start' | 'model-change') =>
        Promise.resolve({
          source: 'ollama' as const,
          harness: 'codex' as const,
          runtimeModel: `runtime:${String(model)}`,
          aiCreditsRouted: false,
          codexConfig: { model: `runtime:${String(model)}` },
          reason,
        }),
    );
    const session = onPlatform('darwin', () =>
      new CodexProvider({
        providerType: 'ollama',
        prepareInvocation,
      }).createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'managed-release-after-model-change',
          managedDelegationMode: 'explicit-only',
          model: 'ollama-old',
          managedDelegationSurface: 'worktree-chat',
        },
        jest.fn(),
        () => null,
      ),
    );

    session.sendMessage('Run once');
    await flush();
    await flushMicrotasks();
    await session.setModel?.('ollama-new');
    expect(disposeMock).not.toHaveBeenCalled();

    activeCount = 0;
    onActivityChange?.(0);
    expect(disposeMock).toHaveBeenCalledTimes(1);
    await session.destroy();
  });

  it('appends managed delegation steering to the Codex developer instructions', async () => {
    createManagedDelegationSessionMock.mockResolvedValueOnce({
      activeCount: 0,
      codexTools: [],
      systemPromptGuidance: 'Managed delegation: watch completions.',
      observe: jest.fn(),
      retireTurn: jest.fn(),
      detach: jest.fn(),
    });
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const session = onPlatform('darwin', () =>
      new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'managed-delegation-steering',
          managedDelegationMode: 'explicit-only',
          managedDelegationSurface: 'worktree-chat',
          systemPromptAppend: 'System appendix',
        },
        jest.fn(),
        () => null,
      ),
    );

    session.sendMessage('Delegate a review');
    await flush();
    await flushMicrotasks();

    expect(
      jest.mocked(CodexAppServerClient).mock.calls[0]?.[0]
        ?.developerInstructions,
    ).toBe('System appendix\n\nManaged delegation: watch completions.');
    await session.destroy();
  });

  it('retires only the stopped turn bindings when the root turn stops', async () => {
    const managedSession = {
      activeCount: 0,
      codexTools: [],
      observe: jest.fn(),
      retireTurn: jest.fn(),
      detach: jest.fn(),
      cancel: jest.fn(),
      close: jest.fn(),
    };
    createManagedDelegationSessionMock.mockResolvedValueOnce(managedSession);
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const session = onPlatform('darwin', () =>
      new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'managed-delegation-stop',
          managedDelegationMode: 'explicit-only',
          managedDelegationSurface: 'worktree-chat',
        },
        jest.fn(),
        () => null,
      ),
    );
    session.sendMessage('Delegate a review');
    await flush();
    await flushMicrotasks();

    await session.cancel();

    // Stop ends the parent turn only; the chat's delegates keep running.
    expect(managedSession.retireTurn).toHaveBeenCalledTimes(1);
    expect(managedSession.cancel).not.toHaveBeenCalled();
    expect(managedSession.close).not.toHaveBeenCalled();
    expect(managedSession.detach).not.toHaveBeenCalled();
    await session.destroy();
    expect(managedSession.detach).toHaveBeenCalledTimes(1);
    expect(managedSession.close).not.toHaveBeenCalled();
  });

  it('exposes the live selected model to managed delegation after a model change', async () => {
    let readCurrentOptions: (() => { selectedModel?: unknown }) | undefined;
    const managedSession = {
      activeCount: 0,
      codexTools: [],
      observe: jest.fn(),
      retireTurn: jest.fn(),
      detach: jest.fn(),
    };
    createManagedDelegationSessionMock.mockImplementationOnce(
      (options: { currentOptions: () => { selectedModel?: unknown } }) => {
        readCurrentOptions = options.currentOptions;
        return Promise.resolve(managedSession);
      },
    );
    const session = onPlatform('darwin', () =>
      new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'managed-live-selected-model',
          managedDelegationMode: 'explicit-only',
          model: 'gpt-5.5',
          selectedModel: 'gpt-5.5',
          managedDelegationSurface: 'worktree-chat',
        },
        jest.fn(),
        () => null,
      ),
    );
    await flushMicrotasks();

    await session.setModel?.('gpt-5.6-luna');

    expect(readCurrentOptions?.().selectedModel).toBe('gpt-5.6-luna');
    await session.destroy();
  });

  it('tags an Ollama Codex session with its per-model ollama reasoning route family', async () => {
    // Ollama shares the canonical CODEX_HOME with native OpenAI threads, so if
    // the session forwarded no provider type its rollout would be labelled
    // `native` and a later native session would resume it and replay Ollama's
    // provider-private reasoning. The family is keyed by model so switching
    // between two locally hosted models also sanitizes.
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider({
      providerType: 'ollama',
      prepareInvocation: (
        model: ChatModel | undefined,
      ): Promise<CodexCompatibleInvocation> =>
        Promise.resolve({ runtimeModel: `runtime:${String(model)}` }),
    });
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ollama-route-family',
        model: 'ollama-local',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run once');
    await flush();
    await flushMicrotasks();

    expect(jest.mocked(CodexAppServerClient).mock.calls[0]?.[0]).toMatchObject({
      reasoningRouteFamily: 'ollama:local',
    });
    await session.destroy();
  });

  it('tags a native Codex session with the native reasoning route family', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'native-route-family',
        model: 'gpt-5.6-sol',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run once');
    await flush();
    await flushMicrotasks();

    expect(jest.mocked(CodexAppServerClient).mock.calls[0]?.[0]).toMatchObject({
      reasoningRouteFamily: 'native',
    });
    await session.destroy();
  });

  it('leaves Codex-native memories untouched when the escape hatch is set while local memory is enabled', async () => {
    process.env.CANOPY_HARNESS_NATIVE_MEMORY = '1';
    mockedReadLocalMemoryEnabledPreference.mockResolvedValueOnce(true);
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'memory-escape-hatch',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run once');
    await flush();
    await flushMicrotasks();

    const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    expect(clientArgs?.threadConfig ?? {}).not.toHaveProperty(
      'features.memories',
    );
    await session.destroy();
  });

  it('records bounded Codex exit context and terminal recovery diagnostics', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-recovery-diagnostics',
        model: 'gpt-6-sol',
      },
      jest.fn(),
      () => null,
    );
    session.sendMessage('Inspect recovery diagnostics');
    await flush();
    await flush();

    const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    clientArgs?.onProcessExit?.({
      code: 0,
      signal: null,
      stderrTail: 'latest diagnostic',
      stderrTruncated: true,
      pid: 4242,
      uptimeMs: 123_456,
      clientCount: 15,
      activeTurnCount: 5,
      recoveryScheduled: true,
    });
    clientArgs?.onProcessRecovery?.({
      status: 'succeeded',
      strategy: 'reconciled',
    });

    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'codex_process_exit',
        pid: 4242,
        exitCode: 0,
        stderrTail: 'latest diagnostic',
        stderrTruncated: true,
        uptimeMs: 123_456,
        codexClientCount: 15,
        codexActiveTurnCount: 5,
        recoveryScheduled: true,
      }),
    );
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'codex_process_recovery',
        recoveryStatus: 'succeeded',
        recoveryStrategy: 'reconciled',
      }),
    );
    await session.destroy();
  });

  it('reports disposal only after destroy — a canceled Codex session keeps draining its queue', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-liveness',
        model: 'gpt-6-sol',
      },
      jest.fn(),
      () => null,
    );

    expect(session.isDisposed?.()).toBe(false);

    // cancel() only interrupts the active turn; the message loop keeps
    // draining the queue, so the session is still live for delivery.
    await session.cancel();
    expect(session.isDisposed?.()).toBe(false);

    await session.destroy();
    expect(session.isDisposed?.()).toBe(true);
  });

  it('does not start a queued turn cancelled during managed initialization', async () => {
    let finishInitialization: () => void = () => undefined;
    const managedSession = {
      activeCount: 0,
      codexTools: [],
      observe: jest.fn(),
      retireTurn: jest.fn(),
      detach: jest.fn(),
    };
    createManagedDelegationSessionMock.mockImplementationOnce(
      (): Promise<typeof managedSession> =>
        new Promise((resolve) => {
          finishInitialization = (): void => resolve(managedSession);
        }),
    );
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const session = onPlatform('darwin', () =>
      new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'managed-initialization-cancel',
          managedDelegationMode: 'explicit-only',
          managedDelegationSurface: 'worktree-chat',
        },
        jest.fn(),
        () => null,
      ),
    );

    session.sendMessage('Do not start this turn');
    await flushMicrotasks();
    await session.cancel();
    finishInitialization();
    await flush();
    await flushMicrotasks();

    expect(startTurnMock).not.toHaveBeenCalled();
    await session.destroy();
  });

  it('sends no plan comment dynamic tools to a legacy plan-chat thread', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();

    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'plan-explore-chat',
        worktreeId: 'plan-1',
        chatId: 'legacy-plan-chat',
      },
      jest.fn(),
      () => null,
    );
    session.sendMessage('Discuss the plan');
    await flush();
    await flush();

    const names = (
      jest.mocked(CodexAppServerClient).mock.calls[0]?.[0].dynamicTools ?? []
    ).map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('canopy_get_plan_comments');
    expect(names).not.toContain('canopy_respond_to_comment');
    await session.destroy();
  });

  it('captures Code Graph dynamic-tool advertisement per Codex session', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();

    const withoutGraph = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'without-graph',
        codeGraphToolsAdvertised: false,
      },
      jest.fn(),
      () => null,
    );
    withoutGraph.sendMessage('Inspect without graph tools');
    await flush();
    await flush();
    const withoutGraphArgs =
      jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    expect(
      withoutGraphArgs?.dynamicTools?.some(
        (tool) => tool.name === 'canopy_get_code_graph_context',
      ),
    ).toBe(false);
    const withoutGraphRegistration = registerSessionMock.mock.calls[0];
    expect(
      withoutGraphRegistration?.[withoutGraphRegistration.length - 2],
    ).toBe(false);
    await withoutGraph.destroy();

    const withGraph = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'with-graph',
        codeGraphToolsAdvertised: true,
      },
      jest.fn(),
      () => null,
    );
    withGraph.sendMessage('Inspect with graph tools');
    await flush();
    await flush();
    const withGraphArgs = jest.mocked(CodexAppServerClient).mock.calls[1]?.[0];
    expect(
      withGraphArgs?.dynamicTools?.some(
        (tool) => tool.name === 'canopy_get_code_graph_context',
      ),
    ).toBe(true);
    const withGraphRegistration = registerSessionMock.mock.calls[1];
    expect(withGraphRegistration?.[withGraphRegistration.length - 2]).toBe(
      true,
    );
    await withGraph.destroy();
  });

  it('waits for the live Codex client to apply approval-mode changes', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        approvalMode: 'full-access',
      },
      jest.fn(),
      () => null,
    );
    session.sendMessage('Start');
    await flush();
    await flush();

    await session.setApprovalMode('ask');

    expect(setApprovalModeMock).toHaveBeenCalledWith('ask');
    await session.destroy();
  });

  it('applies a downgrade triggered during Codex client construction before starting the turn', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    let downgrade: Promise<void> | undefined;
    jest.mocked(CodexAppServerClient).mockImplementationOnce(() => {
      downgrade = session.setApprovalMode('ask');
      return {
        startTurn: startTurnMock,
        interruptTurn: interruptTurnMock,
        setApprovalMode: setApprovalModeMock,
        dispose: disposeMock,
        getThreadId: (): string => 'thread-after-downgrade',
      } as InstanceType<typeof CodexAppServerClient>;
    });
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        approvalMode: 'full-access',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Start safely');
    await flush();
    await flush();
    await downgrade;

    expect(
      jest.mocked(CodexAppServerClient).mock.calls[0]?.[0].approvalMode,
    ).toBe('full-access');
    expect(setApprovalModeMock).toHaveBeenCalledWith('ask');
    expect(setApprovalModeMock.mock.invocationCallOrder[0]).toBeLessThan(
      startTurnMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    await session.destroy();
  });

  it('rejects approvals throughout the Codex cancellation window', async () => {
    let resolveTurn: (value: { status: 'completed' }) => void = () => undefined;
    startTurnMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
        }),
    );
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      () => null,
    );
    session.sendMessage('Start');
    await flush();
    await flush();
    const clientOptions = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    if (!clientOptions?.approvalSession) {
      throw new Error('Expected a guarded approval session');
    }

    await session.cancel();
    await expect(
      clientOptions.approvalSession.check(
        { kind: 'command', command: 'npm test' },
        {
          title: 'Run command?',
          details: { kind: 'command', command: 'npm test' },
        },
      ),
    ).resolves.toEqual({
      decision: 'deny',
      message: 'The owning turn was cancelled.',
    });
    expect(approvalCheckMock).not.toHaveBeenCalled();

    resolveTurn({ status: 'completed' });
    await flush();
    await expect(
      clientOptions.approvalSession.check(
        { kind: 'command', command: 'npm test' },
        {
          title: 'Run command?',
          details: { kind: 'command', command: 'npm test' },
        },
      ),
    ).resolves.toEqual({ decision: 'allow' });
    expect(approvalCheckMock).toHaveBeenCalledTimes(1);
    await session.destroy();
  });

  it('sends plan turns in plan mode and emits a codex plan review request', async () => {
    startTurnMock
      .mockResolvedValueOnce({
        status: 'completed',
        proposedPlanText: 'Implement the feature in two steps.',
      })
      .mockResolvedValue({ status: 'completed' });

    const events: unknown[] = [];
    const win = createWindow();

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        planMode: true,
        model: 'gpt-6-sol',
      },
      (event) => events.push(event),
      fakeWindowGetter(win),
    );

    session.sendMessage('Plan this change');
    await flush();
    await flush();

    expect(CodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(startTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Plan this change',
        planMode: true,
        model: 'gpt-6-sol',
      }),
    );
    expect(mockCommitPlanExit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        source: 'codex',
        reviewMode: 'proposal',
        toolInput: {
          plan: 'Implement the feature in two steps.',
          source: 'codex',
        },
      }),
    );
    expect(getWindowSendMock(win)).toHaveBeenCalledWith(
      IPC_CHANNELS.planExitRequest,
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        toolInput: {
          plan: 'Implement the feature in two steps.',
          source: 'codex',
        },
      }),
    );
    expect(mockCommitPlanExit.mock.invocationCallOrder[0]).toBeLessThan(
      getWindowSendMock(win).mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          is_error: false,
          result: 'Turn completed',
        }),
      ]),
    );
    expect(mockAttentionMark).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      state: 'needs_input',
      reason: 'plan_review',
      sourceId: 'plan-review',
    });

    mockAttentionClear.mockClear();
    session.sendMessage('Revise the plan');
    await flush();
    await flush();
    expect(mockAttentionClear).toHaveBeenCalledWith(
      'project',
      'worktree',
      'chat',
    );

    await session.destroy();
  });

  it('raises blocked attention for a non-retryable root chat failure', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Start');
    await flush();
    await flush();
    const clientOptions = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    noteChatSessionEventMock.mockReturnValueOnce({
      kind: 'non_retryable_failure',
      detail: 'Repository access was denied',
    });
    void clientOptions?.onEvent({
      type: 'error',
      error: 'Repository access was denied',
    });

    expect(mockAttentionMark).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      state: 'blocked',
      reason: 'error',
      sourceId: 'terminal-error',
      detail: 'Repository access was denied',
    });

    await session.destroy();
  });

  it('tags Codex turn events with the active user message id', async () => {
    startTurnMock.mockImplementation(() => {
      const clientOptions =
        jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      void clientOptions?.onEvent({
        type: 'codex',
        event: { type: 'turn.completed' },
      });
      return Promise.resolve({ status: 'completed' });
    });

    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => events.push(event),
      () => null,
    );

    session.sendMessage('Run this', { userMessageId: 'msg-1' });
    await flush();
    await flush();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'codex',
          canopy_turn_user_message_id: 'msg-1',
        }),
        expect.objectContaining({
          type: 'result',
          is_error: false,
          result: 'Turn completed',
          canopy_turn_user_message_id: 'msg-1',
        }),
      ]),
    );

    await session.destroy();
  });

  it('records a native unauthorized failure for account-change resume', async () => {
    startTurnMock.mockImplementation(() => {
      const clientOptions =
        jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      void clientOptions?.onEvent({
        type: 'codex',
        event: {
          type: 'turn.failed',
          thread_id: 'thread-1',
          error: {
            message: 'Unauthorized',
            codexErrorInfo: 'unauthorized',
          },
        },
      });
      return Promise.resolve({ status: 'failed' });
    });

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Continue');
    await flush();
    await flush();

    expect(mockRecordUsageLimitedChat).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        provider: 'codex',
        resumeReason: 'authentication',
      }),
    );

    await session.destroy();
  });

  it('records the account proxy route a session actually applied', async () => {
    mockResolveAccountProxySessionRoute.mockResolvedValueOnce({
      accountKey: 'account-proxy:test-proxy',
      env: {},
      codexConfig: { model_provider: 'canopy_account_proxy' },
    });
    const onEvent = jest.fn();
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        requiredAccountProxyConnectionId: 'test-proxy',
      },
      onEvent,
      () => null,
    );
    try {
      session.sendMessage('Continue');
      await flush();
      await flush();
      expect(mockResolveAccountProxySessionRoute).toHaveBeenCalledWith(
        expect.objectContaining({ requiredConnectionId: 'test-proxy' }),
      );
      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(clientArgs?.threadConfig).toMatchObject({
        model_provider: 'canopy_account_proxy',
      });
      expect(jest.mocked(recordSessionAccountProxyRoute)).toHaveBeenCalledWith(
        expect.stringContaining('chat'),
        true,
      );
      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: false,
        accountProxyRouted: true,
        provider: 'codex',
      });
    } finally {
      await session.destroy();
    }
  });

  it('shows the proxy moving a chat between accounts until the session ends', async () => {
    mockWatchAccountProxySwitches.mockClear();
    mockStopAccountProxySwitches.mockClear();
    mockResolveAccountProxySessionRoute.mockResolvedValue({
      accountKey: 'account-proxy:test-proxy',
      env: {},
      codexConfig: { model_provider: 'canopy_account_proxy' },
    });
    const events: unknown[] = [];
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => {
        events.push(event);
      },
      () => null,
    );
    try {
      session.sendMessage('Continue');
      await flush();
      await flush();
      // One watcher for the session, under its key.
      expect(mockWatchAccountProxySwitches).toHaveBeenCalledTimes(1);
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
        expect.objectContaining({ type: 'canopy_account_proxy_switch' }),
      );
    } finally {
      await session.destroy();
      mockResolveAccountProxySessionRoute.mockResolvedValue(null);
    }
    expect(mockStopAccountProxySwitches).toHaveBeenCalled();
  });

  it('ends the turn with the proxy error when no Codex account can serve it', async () => {
    const message =
      'The account proxy has no Codex accounts. Add one in Settings > Multi-account proxy, or turn off Use for Codex there.';
    mockResolveAccountProxySessionRoute.mockRejectedValueOnce(
      new Error(message),
    );
    startTurnMock.mockClear();
    const onEvent = jest.fn();
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'proxy-no-accounts',
      },
      onEvent,
      () => null,
    );
    try {
      session.sendMessage('Hello');
      await flushMicrotasks();
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          is_error: true,
          result: message,
        }),
      );
      expect(startTurnMock).not.toHaveBeenCalled();
    } finally {
      await session.destroy();
    }
  });

  it('aborts proxy capacity preparation immediately when the user presses Stop', async () => {
    let passedSignal: AbortSignal | undefined;
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mockResolveAccountProxySessionRoute.mockImplementationOnce((options) => {
      passedSignal = options.signal;
      entered();
      return new Promise((resolve, reject) => {
        release = (): void => resolve(null);
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('turn_cancelled')),
          { once: true },
        );
      });
    });
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'proxy-capacity-stop',
      },
      () => undefined,
      () => null,
    );
    try {
      session.sendMessage('Continue');
      await waiting;
      await session.cancel();
      expect(passedSignal?.aborted).toBe(true);
    } finally {
      release();
      await session.destroy();
    }
  });

  it.each(['completed', 'unrelated failure'])(
    'does not retain an early proxy quota notice after %s',
    async (outcome) => {
      mockResolveAccountProxySessionRoute.mockResolvedValueOnce({
        accountKey: 'account-proxy:test-proxy',
        env: {},
        codexConfig: { model_provider: 'canopy_account_proxy' },
      });
      jest.mocked(isSessionAccountProxyRouted).mockReturnValue(true);
      startTurnMock.mockImplementation(async () => {
        const options = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
        await options?.onEvent({
          type: 'codex',
          event: { type: 'rate_limit.reached', thread_id: 'thread-1' },
        });
        return outcome === 'completed'
          ? { status: 'completed' }
          : {
              status: 'failed',
              error: 'Connection failed',
              codexErrorInfo: 'responseStreamConnectionFailed',
            };
      });
      let finish: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const session = new CodexProvider().createSession(
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
            event.type === 'result'
          )
            finish();
        },
        () => null,
      );
      try {
        session.sendMessage('Continue');
        await finished;
        expect(mockRecordUsageLimitedChat).not.toHaveBeenCalled();
      } finally {
        jest.mocked(isSessionAccountProxyRouted).mockReturnValue(false);
        await session.destroy();
      }
    },
  );

  it.each(['turn.failed', 'error', 'none'])(
    'records terminal proxy quota after %s reporting',
    async (notice) => {
      mockResolveAccountProxySessionRoute.mockResolvedValueOnce({
        accountKey: 'account-proxy:test-proxy',
        env: {},
        codexConfig: { model_provider: 'canopy_account_proxy' },
      });
      jest.mocked(isSessionAccountProxyRouted).mockReturnValue(true);
      startTurnMock.mockImplementation(() => {
        const options = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
        if (notice !== 'none')
          void options?.onEvent({
            type: 'codex',
            event: {
              type: notice,
              thread_id: 'thread-1',
              error: {
                message: 'Quota exhausted',
                codexErrorInfo: 'usageLimitExceeded',
              },
            },
          });
        return Promise.resolve({
          status: 'failed',
          error: 'Quota exhausted',
          codexErrorInfo: 'usageLimitExceeded',
        });
      });
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        () => undefined,
        () => null,
      );
      try {
        session.sendMessage('Continue');
        await flush();
        await flush();
        expect(mockRecordUsageLimitedChat).toHaveBeenCalledTimes(1);
        expect(mockRecordUsageLimitedChat).toHaveBeenCalledWith(
          expect.objectContaining({
            accountProxyConnectionId: 'test-proxy',
            provider: 'codex',
            resumeReason: 'usage_limit',
          }),
        );
      } finally {
        jest.mocked(isSessionAccountProxyRouted).mockReturnValue(false);
        await session.destroy();
      }
    },
  );

  it('routes a native Codex usage-limit turn.failed with its reset time (CAN-4564)', async () => {
    const resetsAt = Date.now() + 60 * 60 * 1000;
    clearAllProviderQuotaReached();
    startTurnMock.mockImplementation(() => {
      const options = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      void options?.onEvent({
        type: 'codex',
        event: {
          type: 'turn.failed',
          thread_id: 'thread-1',
          error: {
            message: 'Usage limit exceeded.',
            codexErrorInfo: 'usageLimitExceeded',
            resetsAt,
          },
        },
      });
      return Promise.resolve({
        status: 'failed',
        error: 'Usage limit exceeded.',
        codexErrorInfo: 'usageLimitExceeded',
      });
    });
    const events: unknown[] = [];
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => events.push(event),
      () => null,
    );
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      session.sendMessage('Continue');
      await flush();
      await flush();
      expect(events).toContainEqual({
        type: AI_CREDITS_USAGE_LIMIT_EVENT_TYPE,
        provider: 'codex',
        resetsAt,
      });
      expect(mockRecordUsageLimitedChat).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'codex',
          resumeReason: 'usage_limit',
          resetsAt,
        }),
      );
      // The on-quota state expires at the reported reset.
      expect(isProviderQuotaReached('codex')).toBe(true);
      nowSpy.mockReturnValue(resetsAt + 1);
      expect(isProviderQuotaReached('codex')).toBe(false);
    } finally {
      nowSpy.mockRestore();
      clearAllProviderQuotaReached();
      await session.destroy();
    }
  });

  it('leaves the account proxy out when AI Credits always route', async () => {
    setAiCreditsRoutingModeCache('on');
    mockedIsNativelyAuthed.mockResolvedValue(true);
    // No credits to route with, so the session falls through to native.
    mockedGetRoutingContext.mockResolvedValue(null);
    startTurnMock.mockResolvedValue({ status: 'completed' });
    mockResolveAccountProxySessionRoute.mockClear();
    mockResolveAccountProxySessionRoute.mockResolvedValue({
      accountKey: 'account-proxy:connection-1',
      env: {},
      codexConfig: { model_provider: 'canopy_account_proxy' },
    });
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'gpt-5.5',
      },
      () => undefined,
      () => null,
    );
    try {
      session.sendMessage('Run once');
      await flushMicrotasks();
      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.5' }),
      );
      expect(mockResolveAccountProxySessionRoute).not.toHaveBeenCalled();
      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(clientArgs?.threadConfig?.model_provider).not.toBe(
        'canopy_account_proxy',
      );
    } finally {
      await session.destroy();
      setAiCreditsRoutingModeCache('off');
      mockResolveAccountProxySessionRoute.mockResolvedValue(null);
    }
  });

  it('keeps an account proxy session out of native sign-in recovery', async () => {
    jest.mocked(isSessionAccountProxyRouted).mockReturnValue(true);
    startTurnMock.mockImplementation(() => {
      const clientOptions =
        jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      void clientOptions?.onEvent({
        type: 'codex',
        event: {
          type: 'turn.failed',
          thread_id: 'thread-1',
          error: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' },
        },
      });
      return Promise.resolve({ status: 'failed' });
    });
    const events: unknown[] = [];
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => events.push(event),
      () => null,
    );
    try {
      session.sendMessage('Continue');
      await flush();
      await flush();
      // The proxy refused the request; the user's own Codex login is fine.
      expect(events.find(isCanopyAuthFailureEventData)).toBeUndefined();
      expect(mockRecordUsageLimitedChat).not.toHaveBeenCalled();
    } finally {
      jest.mocked(isSessionAccountProxyRouted).mockReturnValue(false);
      await session.destroy();
    }
  });

  it('delivers a structured provider auth-failure event to the renderer after the failing event', async () => {
    // Regression guard (CAN-1814 whole-branch review): this used to call
    // `recordSessionEvent`, which is session bookkeeping and never reaches the
    // renderer, so the provider half of the feature was unreachable. Ordering
    // is asserted too: the transcript reducer creates the text block this
    // failure attaches to while reducing the failing event itself.
    startTurnMock.mockImplementation(() => {
      const clientOptions =
        jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      void clientOptions?.onEvent({
        type: 'codex',
        event: {
          type: 'turn.failed',
          thread_id: 'thread-1',
          error: {
            message: 'Unauthorized',
            codexErrorInfo: 'unauthorized',
          },
        },
      });
      return Promise.resolve({ status: 'failed' });
    });

    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => events.push(event),
      () => null,
    );

    session.sendMessage('Continue');
    await flush();
    await flush();

    const authEvent = events.find(isCanopyAuthFailureEventData);
    expect(authEvent).toBeDefined();
    expect(authEvent?.failure.dependencyClass).toBe('provider');
    expect(authEvent?.failure.dependencyId).toBe('codex');
    expect(authEvent?.failure.displayName).toBe('Codex');
    expect(authEvent?.failure.failureClass).toBe('unauthenticated');
    expect(authEvent?.failure.recovery).toEqual({
      kind: 'provider_terminal',
      provider: 'codex',
    });

    const emittedTypes = events.map(readEventType);
    const authIndex = emittedTypes.indexOf('canopy_auth_failure');
    const failingIndex = emittedTypes.indexOf('codex');
    expect(failingIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeGreaterThan(failingIndex);

    await session.destroy();
  });

  it('clears MCP proxy state under BOTH the plugin route owner and the chat session key on teardown', async () => {
    // CAN-1814 whole-branch review: the proxy publishes auth failures under the
    // route's own sessionId, but worktree-chat-turn.ts pairs them under the
    // CHAT SESSION KEY for every provider. Codex registers routes under a
    // per-client `codex-session:<key>:<uuid>` owner id, so unregistering only
    // that id left `pendingByOwner` / `toolNamesByRouteOwner` entries keyed by
    // `key` with no eviction path.
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      () => null,
    );

    await session.destroy();

    expect(mockUnregisterMcpRoutesForSession).toHaveBeenCalledWith(
      expect.stringMatching(
        /^codex-session:project\/worktree\/chat:[0-9a-f-]{36}$/,
      ),
    );
    expect(mockUnregisterMcpRoutesForSession).toHaveBeenCalledWith(
      'project/worktree/chat',
    );
  });

  // End-to-end for the failure the user actually hits: credits run out
  // mid-chat, the local proxy sees the marked hosted 402, and Codex reports a
  // turn failure whose text carries none of it. Without the proxy latch this
  // turn is indistinguishable from any other failure and no banner renders.
  describe('proxy-observed no-billing-source', () => {
    // What the proxy parses off a marked hosted 402 whose id it did not keep.
    const NO_BILLING_FAILURE = {
      code: 'no_billing_source' as const,
      message: 'AI Credits are unavailable for this request.',
      correlationId: null,
    };
    // Verbatim from the bundled Codex 0.148.0 against a marked hosted body.
    const codexRendered402 =
      'unexpected status 402 Payment Required: AI Credits are unavailable for this request., url: http://127.0.0.1:49877/codex-gateway/280474a8badb19afb75758929f1344aab813952bd1b8965e/responses';

    afterEach(() => {
      clearSessionProxyFailure('project/worktree/chat');
      jest.mocked(isSessionAiCreditsRouted).mockReturnValue(false);
    });

    async function runFailedTurn(
      failureEvent: Record<string, unknown> = {
        type: 'codex',
        event: {
          type: 'turn.failed',
          thread_id: 'thread-1',
          error: { message: codexRendered402 },
        },
      },
    ): Promise<unknown[]> {
      startTurnMock.mockImplementation(() => {
        const clientOptions =
          jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
        void clientOptions?.onEvent(failureEvent);
        return Promise.resolve({ status: 'failed' });
      });
      const events: unknown[] = [];
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        (event) => events.push(event),
        () => null,
      );
      session.sendMessage('Continue');
      await flush();
      await flush();
      await session.destroy();
      return events;
    }

    function isPlainRecord(value: unknown): value is Record<string, unknown> {
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      );
    }

    function findEventOfType(
      events: unknown[],
      type: string,
    ): Record<string, unknown> | undefined {
      return events.filter(isPlainRecord).find((event) => event.type === type);
    }

    it('includes the billing-source notice admission in the failing event receipt', async () => {
      jest.mocked(isSessionAiCreditsRouted).mockReturnValue(true);
      recordSessionProxyFailure('project/worktree/chat', NO_BILLING_FAILURE);
      let releaseNotice = (): void => undefined;
      const heldNotice = new Promise<void>((resolve) => {
        releaseNotice = resolve;
      });
      let receipt: void | Promise<void>;
      const events: unknown[] = [];
      startTurnMock.mockImplementation(() => {
        const clientOptions =
          jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
        receipt = clientOptions?.onEvent({
          type: 'error',
          message: codexRendered402,
        });
        return Promise.resolve({ status: 'failed' });
      });
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        (event) => {
          events.push(event);
          if (
            isPlainRecord(event) &&
            event.type === AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE
          ) {
            return heldNotice;
          }
        },
        () => null,
      );
      try {
        session.sendMessage('Continue');
        await flush();
        await flush();
        expect(
          findEventOfType(events, AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE),
        ).toBeDefined();
        let settled = false;
        void Promise.resolve(receipt).then(() => {
          settled = true;
        });
        await flush();
        expect(settled).toBe(false);
        releaseNotice();
        await receipt;
      } finally {
        releaseNotice();
        await session.destroy();
      }
    });

    it('raises the recovery banner and stamps the turn the renderer persists', async () => {
      jest.mocked(isSessionAiCreditsRouted).mockReturnValue(true);
      recordSessionProxyFailure('project/worktree/chat', NO_BILLING_FAILURE);

      const events = await runFailedTurn();

      expect(
        findEventOfType(events, AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE),
      ).toMatchObject({
        type: AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE,
        provider: 'codex',
      });
      // The stamp must land on the INNER event: that is what the codex reducer
      // gates on, so this is what makes the banner survive a reload rather
      // than existing only for the live session.
      expect(findEventOfType(events, 'codex')).toMatchObject({
        type: 'codex',
        event: {
          type: 'turn.failed',
          [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
        },
      });
    });

    // The banner alone still leaves the raw `unexpected status 402 ..., url:
    // http://127.0.0.1:<port>/codex-gateway/...` line in the transcript, which
    // is the line CAN-2413 exists to remove and the one in the bug report. The
    // reducer builds the persisted system message from `error.message`, and
    // `ChatBlockRenderer` swaps in the notice purely on `parseCanopyProxyError`,
    // so the restored message has to parse.
    it('restores a transcript message the recovery notice can render', async () => {
      jest.mocked(isSessionAiCreditsRouted).mockReturnValue(true);
      recordSessionProxyFailure('project/worktree/chat', NO_BILLING_FAILURE);

      const events = await runFailedTurn();

      const inner = findEventOfType(events, 'codex')?.event;
      const error = isPlainRecord(inner) ? inner.error : undefined;
      const message = isPlainRecord(error) ? error.message : undefined;

      expect(typeof message).toBe('string');
      expect(parseCanopyProxyError(String(message))).toMatchObject({
        code: 'no_billing_source',
        message: AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
      });
      // The loopback plumbing the user should never have been shown is gone.
      expect(String(message)).not.toContain('127.0.0.1');
      expect(String(message)).not.toContain('unexpected status');
    });

    // CAN-3462: a marked 403 is restored the same way, so the transcript names
    // the refusal. It is not a billing failure, so no billing banner or flag.
    it('restores a refused work owner without raising the billing banner', async () => {
      jest.mocked(isSessionAiCreditsRouted).mockReturnValue(true);
      recordSessionProxyFailure('project/worktree/chat', {
        code: 'work_owner_not_member',
        message: null,
        correlationId: 'request-403',
      });

      const events = await runFailedTurn({
        type: 'codex',
        event: {
          type: 'turn.failed',
          thread_id: 'thread-1',
          error: {
            message:
              'unexpected status 403 Forbidden: You\u2019re no longer in this organization., url: http://127.0.0.1:49877/codex-gateway/route/responses',
          },
        },
      });

      const wrapper = findEventOfType(events, 'codex');
      const inner = wrapper?.event;
      const error = isPlainRecord(inner) ? inner.error : undefined;
      const message = isPlainRecord(error) ? error.message : undefined;
      expect(parseCanopyProxyError(String(message))).toEqual({
        code: 'work_owner_not_member',
        message: AI_CREDITS_WORK_OWNER_REFUSED_MESSAGE,
        correlationId: 'request-403',
      });
      expect(String(message)).not.toContain('127.0.0.1');
      expect(isPlainRecord(inner) ? inner : {}).not.toHaveProperty(
        AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG,
      );
      expect(
        findEventOfType(events, AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE),
      ).toBeUndefined();
    });

    // The shape a real app-server actually delivered for a routed GPT 5.6 Sol
    // turn: a BARE `error` carrying `message`, with no `turn.failed` at all.
    // Restoring only `error.message` would stamp this event correctly and still
    // leave the raw loopback URL in the transcript, because this shape's text
    // lives in `message`.
    it('restores the bare error shape the app-server delivers for a routed turn', async () => {
      jest.mocked(isSessionAiCreditsRouted).mockReturnValue(true);
      recordSessionProxyFailure('project/worktree/chat', NO_BILLING_FAILURE);

      const events = await runFailedTurn({
        type: 'error',
        message: codexRendered402,
      });

      const failure = findEventOfType(events, 'error');
      expect(failure).toMatchObject({
        [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
      });
      expect(parseCanopyProxyError(String(failure?.message))).toMatchObject({
        code: 'no_billing_source',
      });
      expect(String(failure?.message)).not.toContain('127.0.0.1');
      expect(
        findEventOfType(events, AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE),
      ).toBeDefined();
    });

    it('leaves an unrelated failure unstamped when the proxy recorded nothing', async () => {
      jest.mocked(isSessionAiCreditsRouted).mockReturnValue(true);

      const events = await runFailedTurn();

      expect(
        findEventOfType(events, AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE),
      ).toBeUndefined();
      expect(
        findEventOfType(events, 'codex')?.[
          AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG
        ],
      ).toBeUndefined();
    });

    // A natively-authenticated turn is not spending AI Credits, so a stale
    // verdict must not convert its failure into a credits problem.
    it('ignores a recorded verdict on a natively routed turn', async () => {
      jest.mocked(isSessionAiCreditsRouted).mockReturnValue(false);
      recordSessionProxyFailure('project/worktree/chat', NO_BILLING_FAILURE);

      const events = await runFailedTurn();

      expect(
        findEventOfType(events, AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE),
      ).toBeUndefined();
    });
  });

  it('does not forward subagent terminal events to the chat retry observer', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run with a subagent');
    await flushMicrotasks();
    const clientOptions = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    void clientOptions?.onEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'root-thread',
    });
    noteChatSessionEventMock.mockClear();

    void clientOptions?.onEvent({
      type: 'codex',
      event: {
        type: 'turn.failed',
        thread_id: 'subagent-thread',
        error: { message: 'temporarily unavailable' },
      },
    });
    void clientOptions?.onEvent({
      type: 'codex',
      event: { type: 'turn.completed', thread_id: 'root-thread' },
    });

    expect(noteChatSessionEventMock).toHaveBeenCalledTimes(1);
    expect(noteChatSessionEventMock).toHaveBeenCalledWith(
      { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' },
      'codex',
      expect.anything(),
    );
    expect(noteChatSessionEventMock.mock.calls[0]?.[2]).toMatchObject({
      type: 'codex',
      event: {
        type: 'turn.completed',
        thread_id: 'root-thread',
      },
    });

    await session.destroy();
  });

  it('tags destroyed in-flight Codex turn fallback results with the active user message id', async () => {
    let rejectTurn: ((error: Error) => void) | undefined;
    startTurnMock.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectTurn = reject;
        }),
    );

    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => events.push(event),
      () => null,
    );

    session.sendMessage('Run this', { userMessageId: 'msg-1' });
    await flush();
    await flush();

    const stopped = session.destroy();
    expect(disposeMock).not.toHaveBeenCalled();
    rejectTurn?.(new Error('app-server disposed'));
    await stopped;
    await flush();
    await flush();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          is_error: false,
          result: 'Session ended',
          canopy_turn_user_message_id: 'msg-1',
        }),
      ]),
    );
  });

  it('resumes App Advisor Codex threads and recreates the client once when dynamic tools are missing', async () => {
    const getCurrentUiStateTool =
      APP_ADVISOR_TOOL_REGISTRY.get_current_ui_state.codexToolName;
    startTurnMock
      .mockResolvedValueOnce({
        status: 'failed',
        error: `unknown dynamic tool ${getCurrentUiStateTool}`,
      })
      .mockResolvedValueOnce({ status: 'completed' });

    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        assistantMode: 'app-advisor',
        sdkSessionId: 'old-thread-without-tools',
      },
      (event) => events.push(event),
      fakeWindowGetter(),
    );

    session.sendMessage('Inspect the app');
    await flush();
    await flush();
    await flush();

    expect(CodexAppServerClient).toHaveBeenCalledTimes(2);
    const clientCalls = jest.mocked(CodexAppServerClient).mock.calls as Array<
      [
        {
          initialThreadId?: string;
          forceMaterializeOnResume?: boolean;
          dynamicTools?: Array<{ name: string }>;
        },
      ]
    >;
    expect(clientCalls[0]?.[0].initialThreadId).toBe(
      'old-thread-without-tools',
    );
    expect(clientCalls[1]?.[0].initialThreadId).toBe(
      'old-thread-without-tools',
    );
    expect(clientCalls[1]?.[0].forceMaterializeOnResume).toBe(true);
    expect(
      clientCalls[0]?.[0].dynamicTools?.some(
        (tool) => tool.name === getCurrentUiStateTool,
      ),
    ).toBe(true);
    expect(
      clientCalls[1]?.[0].dynamicTools?.some(
        (tool) => tool.name === getCurrentUiStateTool,
      ),
    ).toBe(true);
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(startTurnMock).toHaveBeenCalledTimes(2);
    expect(startTurnMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: 'Inspect the app' }),
    );
    expect(startTurnMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: 'Inspect the app' }),
    );
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'app_advisor_dynamic_tool_recreate',
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          is_error: false,
          result: 'Turn completed',
        }),
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtype: 'codex_error',
        }),
      ]),
    );

    await session.destroy();
  });

  describe('stale proxy route recovery', () => {
    const staleError =
      'HTTP 404: AI Credits PROXY ROUTE IS NO LONGER AVAILABLE.';
    const sentTexts = (): unknown[] =>
      startTurnMock.mock.calls.map((args: unknown[]): unknown => {
        const input = args[0];
        return input !== null && typeof input === 'object'
          ? Reflect.get(input, 'text')
          : undefined;
      });
    const makeSession = (
      events: unknown[],
      sdkSessionId?: string,
    ): ReturnType<CodexProvider['createSession']> =>
      new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          ...(sdkSessionId ? { sdkSessionId } : {}),
        },
        (event) => events.push(event),
        () => null,
      );
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 8; i++) await flush();
    };

    it('retries the same message before queued messages and preserves revival identity', async () => {
      startTurnMock
        .mockResolvedValueOnce({ status: 'failed', error: staleError })
        .mockResolvedValue({ status: 'completed' });
      const events: unknown[] = [];
      const session = makeSession(events, 'source');
      try {
        session.sendMessage('First', { userMessageId: 'message-1' });
        session.sendMessage('Second', { userMessageId: 'message-2' });
        await settle();
        expect(sentTexts()).toEqual(['First', 'First', 'Second']);
        expect(
          jest.mocked(CodexAppServerClient).mock.calls[1]?.[0],
        ).toMatchObject({ forceMaterializeOnResume: true });
        expect(events.filter(isCodexErrorResultEvent)).toHaveLength(0);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'result',
            is_error: false,
            canopy_turn_user_message_id: 'message-1',
            canopy_turn_revival: true,
          }),
        );
        expect(mockUnregisterRoutesForSession).not.toHaveBeenCalled();
        expect(mockMarkSessionForNextTurnRecreation).not.toHaveBeenCalled();
      } finally {
        await session.destroy();
      }
    });

    it.each([
      staleError,
      'unknown input[0].encrypted_content',
      'unrelated failure',
    ])(
      'settles a retry failure once even with a new thread id: %s',
      async (retryError) => {
        let currentThread = 'source';
        getThreadIdMock.mockImplementation(() => currentThread);
        startTurnMock
          .mockResolvedValueOnce({ status: 'failed', error: staleError })
          .mockImplementationOnce(() => {
            currentThread = 'replacement';
            return Promise.resolve({ status: 'failed', error: retryError });
          })
          .mockResolvedValue({ status: 'completed' });
        const events: unknown[] = [];
        const session = makeSession(events);
        try {
          session.sendMessage('Continue');
          await settle();
          expect(startTurnMock).toHaveBeenCalledTimes(2);
          expect(events.filter(isCodexErrorResultEvent)).toEqual([
            expect.objectContaining({ result: retryError }),
          ]);
          expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalledWith(
            'project',
            'worktree',
            'chat',
          );
        } finally {
          await session.destroy();
        }
      },
    );

    it.each([
      '404 Not Found',
      'API path /v1/responses is not supported',
      'quota exceeded',
      'invalid input[0].reasoning.effort',
    ])('does not retry other provider errors: %s', async (error) => {
      startTurnMock.mockResolvedValue({ status: 'failed', error });
      const session = makeSession([]);
      try {
        session.sendMessage('Continue');
        await settle();
        expect(startTurnMock).toHaveBeenCalledTimes(1);
        expect(mockMarkSessionForNextTurnRecreation).not.toHaveBeenCalled();
      } finally {
        await session.destroy();
      }
    });

    it('refuses recovery without a source thread', async () => {
      getThreadIdMock.mockReturnValue(undefined);
      startTurnMock.mockResolvedValue({ status: 'failed', error: staleError });
      const session = makeSession([]);
      try {
        session.sendMessage('Continue');
        await settle();
        expect(startTurnMock).toHaveBeenCalledTimes(1);
        expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalledTimes(1);
      } finally {
        await session.destroy();
      }
    });

    it('reserves at most three recoveries for independent messages in a session', async () => {
      let attempt = 0;
      getThreadIdMock.mockImplementation(() => `thread-${attempt}`);
      startTurnMock.mockImplementation(() =>
        Promise.resolve(
          ++attempt % 2
            ? { status: 'failed', error: staleError }
            : { status: 'completed' },
        ),
      );
      const events: unknown[] = [];
      const session = makeSession(events);
      try {
        for (let i = 0; i < 4; i++) {
          session.sendMessage(`Message ${i}`);
          await settle();
        }
        expect(startTurnMock).toHaveBeenCalledTimes(7);
        expect(jest.mocked(CodexAppServerClient).mock.calls).toHaveLength(4);
        expect(events.filter(isCodexErrorResultEvent)).toHaveLength(1);
        expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalledTimes(1);
      } finally {
        await session.destroy();
      }
    });

    it('does not reuse a recovery budget for the same source thread', async () => {
      startTurnMock
        .mockResolvedValueOnce({ status: 'failed', error: staleError })
        .mockResolvedValueOnce({ status: 'completed' })
        .mockResolvedValue({ status: 'failed', error: staleError });
      const session = makeSession([]);
      try {
        session.sendMessage('First');
        await settle();
        session.sendMessage('Second');
        await settle();
        expect(startTurnMock).toHaveBeenCalledTimes(3);
        expect(jest.mocked(CodexAppServerClient).mock.calls).toHaveLength(2);
        expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalledTimes(1);
      } finally {
        await session.destroy();
      }
    });

    it('settles rebuild failure and continues draining queued messages', async () => {
      startTurnMock
        .mockResolvedValueOnce({ status: 'failed', error: staleError })
        .mockRejectedValueOnce(new Error('materialization failed'))
        .mockResolvedValue({ status: 'completed' });
      const events: unknown[] = [];
      const session = makeSession(events);
      try {
        session.sendMessage('First');
        session.sendMessage('Second');
        await settle();
        expect(sentTexts()).toEqual(['First', 'First', 'Second']);
        expect(events.filter(isCodexErrorResultEvent)).toEqual([
          expect.objectContaining({ result: 'materialization failed' }),
        ]);
        expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalledTimes(1);
      } finally {
        await session.destroy();
      }
    });

    it('settles disposal failure once and keeps queued messages', async () => {
      startTurnMock
        .mockResolvedValueOnce({ status: 'failed', error: staleError })
        .mockResolvedValue({ status: 'completed' });
      disposeMock.mockImplementationOnce(() => {
        throw new Error('disposal failed');
      });
      const events: unknown[] = [];
      const session = makeSession(events);
      try {
        session.sendMessage('First');
        session.sendMessage('Second');
        await settle();
        expect(sentTexts()).toEqual(['First', 'Second']);
        expect(events.filter(isCodexErrorResultEvent)).toEqual([
          expect.objectContaining({ result: 'disposal failed' }),
        ]);
        expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalledTimes(1);
      } finally {
        await session.destroy();
      }
    });

    it('settles client setup failure without losing the pending message', async () => {
      startTurnMock.mockResolvedValue({ status: 'failed', error: staleError });
      startTurnMock.mockImplementationOnce(() => {
        jest.mocked(CodexAppServerClient).mockImplementationOnce(() => {
          throw new Error('client setup failed');
        });
        return Promise.resolve({ status: 'failed', error: staleError });
      });
      const events: unknown[] = [];
      const session = makeSession(events);
      try {
        session.sendMessage('First', { userMessageId: 'first-id' });
        await settle();
        expect(startTurnMock).toHaveBeenCalledTimes(1);
        expect(events.filter(isCodexErrorResultEvent)).toEqual([
          expect.objectContaining({
            result: 'client setup failed',
            canopy_turn_user_message_id: 'first-id',
            canopy_turn_revival: true,
          }),
        ]);
        expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalledTimes(1);
      } finally {
        await session.destroy();
      }
    });

    it.each(['cancel', 'destroy'] as const)(
      'stops recovery when %s arrives during disposal',
      async (action) => {
        startTurnMock
          .mockResolvedValueOnce({ status: 'failed', error: staleError })
          .mockResolvedValue({ status: 'completed' });
        const events: unknown[] = [];
        const session = makeSession(events);
        let cancellation: Promise<void> | undefined;
        disposeMock.mockImplementationOnce(() => {
          cancellation = session[action]();
        });
        try {
          session.sendMessage('First');
          await settle();
          await cancellation;
          expect(startTurnMock).toHaveBeenCalledTimes(1);
          if (action === 'cancel') {
            expect(events).toContainEqual(
              expect.objectContaining({
                result: 'Turn cancelled',
                is_error: false,
              }),
            );
          }
        } finally {
          await session.destroy();
        }
      },
    );

    it.each(['cancel', 'destroy'] as const)(
      'prevents the retry turn when %s arrives during retry setup',
      async (action) => {
        const events: unknown[] = [];
        const session = makeSession(events);
        let interruption: Promise<void> | undefined;
        startTurnMock.mockImplementationOnce(() => {
          // Inventory is awaited after the replacement client is prepared and
          // before turn admission. Interrupt that real asynchronous seam.
          mockLoadCachedInventory.mockImplementationOnce(() => {
            interruption = session[action]();
            return Promise.resolve(null);
          });
          return Promise.resolve({ status: 'failed', error: staleError });
        });
        try {
          session.sendMessage('First');
          await settle();
          await interruption;
          expect(interruption).toBeDefined();
          expect(jest.mocked(CodexAppServerClient)).toHaveBeenCalledTimes(2);
          expect(startTurnMock).toHaveBeenCalledTimes(1);
          if (action === 'cancel') {
            expect(events).toContainEqual(
              expect.objectContaining({
                result: 'Turn cancelled',
                is_error: false,
              }),
            );
          }
        } finally {
          await session.destroy();
        }
      },
    );

    it('preserves real usage and canonical thread events from both attempts', async () => {
      let currentThread = 'source';
      getThreadIdMock.mockImplementation(() => currentThread);
      let attempt = 0;
      startTurnMock.mockImplementation(() => {
        attempt += 1;
        currentThread = attempt === 1 ? 'source' : 'rebuilt';
        const clientOptions = jest
          .mocked(CodexAppServerClient)
          .mock.calls.at(-1)?.[0];
        void clientOptions?.onEvent({
          type: 'system',
          subtype: 'init',
          session_id: currentThread,
        });
        void clientOptions?.onEvent({
          type: 'codex',
          event: {
            type: 'thread.token_usage.updated',
            thread_id: currentThread,
            token_usage: { input_tokens: attempt * 10 },
          },
        });
        return Promise.resolve(
          attempt === 1
            ? { status: 'failed', error: staleError }
            : { status: 'completed' },
        );
      });
      const events: unknown[] = [];
      const session = makeSession(events);
      try {
        session.sendMessage('First', { userMessageId: 'first-id' });
        await settle();
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'system', session_id: 'source' }),
            expect.objectContaining({ type: 'system', session_id: 'rebuilt' }),
            expect.objectContaining({
              type: 'codex',
              event: {
                type: 'thread.token_usage.updated',
                thread_id: 'source',
                token_usage: { input_tokens: 10 },
              },
            }),
            expect.objectContaining({
              type: 'codex',
              event: {
                type: 'thread.token_usage.updated',
                thread_id: 'rebuilt',
                token_usage: { input_tokens: 20 },
              },
            }),
          ]),
        );
        const terminals = events.filter(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            Reflect.get(event, 'type') === 'result',
        );
        expect(terminals).toHaveLength(1);
        expect(terminals[0]).toMatchObject({
          is_error: false,
          canopy_turn_user_message_id: 'first-id',
          canopy_turn_revival: true,
        });
      } finally {
        await session.destroy();
      }
    });

    it.each(['cancel', 'destroy'] as const)(
      'does not retry when %s arrives before failure handling',
      async (action) => {
        let fail:
          | ((result: { status: string; error: string }) => void)
          | undefined;
        startTurnMock.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              fail = resolve;
            }),
        );
        const events: unknown[] = [];
        const session = makeSession(events);
        try {
          session.sendMessage('Continue');
          await settle();
          // Destruction awaits the active turn; release it before awaiting the
          // lifecycle operation so this also checks the drain cannot deadlock.
          const interruption = session[action]();
          fail?.({ status: 'failed', error: staleError });
          await interruption;
          await settle();
          expect(startTurnMock).toHaveBeenCalledTimes(1);
          if (action === 'cancel') {
            expect(events).toContainEqual(
              expect.objectContaining({
                type: 'result',
                is_error: false,
                result: 'Turn cancelled',
              }),
            );
          }
        } finally {
          await session.destroy();
        }
      },
    );
  });

  it('rematerializes incompatible reasoning history once and surfaces a repeated failure', async () => {
    const incompatibleReasoningError =
      "[ArrayParam] [input[13].content] [array_above_max_length] Invalid 'input[13].content': array too long";
    startTurnMock
      .mockResolvedValueOnce({
        status: 'failed',
        error: incompatibleReasoningError,
      })
      .mockResolvedValueOnce({
        status: 'failed',
        error: incompatibleReasoningError,
      });

    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sdkSessionId: 'poisoned-thread',
      },
      (event) => events.push(event),
      () => null,
    );

    session.sendMessage('Continue');
    await flush();
    await flush();
    await flush();

    expect(CodexAppServerClient).toHaveBeenCalledTimes(2);
    const clientCalls = jest.mocked(CodexAppServerClient).mock.calls;
    expect(clientCalls[0]?.[0].forceMaterializeOnResume).toBe(false);
    expect(clientCalls[1]?.[0].forceMaterializeOnResume).toBe(true);
    expect(startTurnMock).toHaveBeenCalledTimes(2);
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          is_error: true,
          result: incompatibleReasoningError,
          subtype: 'codex_error',
        }),
      ]),
    );

    await session.destroy();
  });

  it('does not rebuild the thread for an unrelated reasoning parameter error', async () => {
    // Generic `Invalid '...'` parameter errors used to match the reasoning
    // heuristic. Rebuilding is destructive — the live thread is abandoned, a
    // new sdkSessionId is persisted, and the history is re-injected with
    // reasoning stripped — so an unrelated validation error must not trigger it.
    const unrelatedParameterError =
      "400 Invalid 'input[0].reasoning.effort': expected one of low, medium, high";
    startTurnMock.mockResolvedValue({
      status: 'failed',
      error: unrelatedParameterError,
    });

    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sdkSessionId: 'healthy-thread',
      },
      (event) => events.push(event),
      () => null,
    );

    session.sendMessage('Continue');
    await flush();
    await flush();
    await flush();

    expect(CodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(startTurnMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          is_error: true,
          result: unrelatedParameterError,
        }),
      ]),
    );

    await session.destroy();
  });

  it('does not rebuild the thread for a typed reasoning parameter rejection', async () => {
    // The heuristic must anchor on the ITEM-level field. A nested parameter
    // path such as `input[0].reasoning.effort` is an ordinary validation
    // error about the request's reasoning *settings*, not a rejected history
    // item, and rebuilding for it abandons a healthy thread.
    const unrelatedParameterError =
      "invalid_value for 'input[0].reasoning.effort': expected one of low, medium, high";
    startTurnMock.mockResolvedValue({
      status: 'failed',
      error: unrelatedParameterError,
    });

    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sdkSessionId: 'healthy-thread',
      },
      (event) => events.push(event),
      () => null,
    );

    session.sendMessage('Continue');
    await flush();
    await flush();
    await flush();

    expect(CodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(startTurnMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          is_error: true,
          result: unrelatedParameterError,
        }),
      ]),
    );

    await session.destroy();
  });

  it('still rebuilds for an item-level foreign reasoning rejection', async () => {
    // The genuine symptom: the upstream provider rejects a persisted history
    // ITEM whose reasoning payload it cannot decode.
    const foreignReasoningError =
      "invalid_value: unsupported field 'input[7].encrypted_content'";
    startTurnMock
      .mockResolvedValueOnce({
        status: 'failed',
        error: foreignReasoningError,
      })
      .mockResolvedValue({ status: 'completed' });

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sdkSessionId: 'poisoned-thread',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Continue');
    await flush();
    await flush();
    await flush();

    const clientCalls = jest.mocked(CodexAppServerClient).mock.calls;
    expect(clientCalls).toHaveLength(2);
    expect(clientCalls[1]?.[0].forceMaterializeOnResume).toBe(true);

    await session.destroy();
  });

  it('budgets the reasoning-history rebuild per thread, not per session', async () => {
    // A long-lived session can meet a second, independently poisoned thread
    // after an earlier rebuild or a capability transition. A per-session latch
    // would surface the raw Responses API error with no recovery until the
    // session is destroyed, so the budget is one retry per thread id.
    const incompatibleReasoningError =
      "[ArrayParam] [input[13].content] [array_above_max_length] Invalid 'input[13].content': array too long";
    getThreadIdMock.mockImplementation(
      () => `thread-${jest.mocked(CodexAppServerClient).mock.calls.length}`,
    );
    startTurnMock
      .mockResolvedValueOnce({
        status: 'failed',
        error: incompatibleReasoningError,
      })
      .mockResolvedValueOnce({ status: 'completed' })
      .mockResolvedValueOnce({
        status: 'failed',
        error: incompatibleReasoningError,
      })
      .mockResolvedValue({ status: 'completed' });

    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sdkSessionId: 'poisoned-thread',
      },
      (event) => events.push(event),
      () => null,
    );

    session.sendMessage('First');
    await flush();
    await flush();
    await flush();
    session.sendMessage('Second');
    await flush();
    await flush();
    await flush();

    const clientCalls = jest.mocked(CodexAppServerClient).mock.calls;
    expect(clientCalls).toHaveLength(3);
    expect(clientCalls[1]?.[0].forceMaterializeOnResume).toBe(true);
    expect(clientCalls[2]?.[0].forceMaterializeOnResume).toBe(true);
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          is_error: true,
          result: incompatibleReasoningError,
        }),
      ]),
    );

    await session.destroy();
  });

  it('neither rebuilds nor spends the budget when no thread id is known', async () => {
    // A failure that arrives before any thread id exists cannot be attributed
    // to a thread, and there is no source thread to rebuild *from*. Bucketing
    // every such failure under a shared `'unknown-thread'` sentinel attempted a
    // pointless rebuild and then denied the retry to the next, genuinely
    // identified poisoned thread that happened to fail in the same session.
    const incompatibleReasoningError =
      "[ArrayParam] [input[13].content] [array_above_max_length] Invalid 'input[13].content': array too long";
    getThreadIdMock.mockReturnValue(undefined);
    startTurnMock.mockResolvedValueOnce({
      status: 'failed',
      error: incompatibleReasoningError,
    });

    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => events.push(event),
      () => null,
    );

    session.sendMessage('First');
    await flush();
    await flush();
    await flush();

    expect(jest.mocked(CodexAppServerClient).mock.calls).toHaveLength(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          is_error: true,
          result: incompatibleReasoningError,
        }),
      ]),
    );

    // The budget was never consumed, so a later, identified poisoned thread in
    // the same session still self-heals.
    getThreadIdMock.mockReturnValue('poisoned-thread');
    startTurnMock
      .mockResolvedValueOnce({
        status: 'failed',
        error: incompatibleReasoningError,
      })
      .mockResolvedValue({ status: 'completed' });

    session.sendMessage('Second');
    await flush();
    await flush();
    await flush();

    const clientCalls = jest.mocked(CodexAppServerClient).mock.calls;
    expect(clientCalls).toHaveLength(2);
    expect(clientCalls[1]?.[0].forceMaterializeOnResume).toBe(true);

    await session.destroy();
  });

  it('stops forcing rematerialization once the rebuilt turn succeeds', async () => {
    jest.useFakeTimers();
    const incompatibleReasoningError =
      "[ArrayParam] [input[13].content] [array_above_max_length] Invalid 'input[13].content': array too long";
    startTurnMock
      .mockResolvedValueOnce({
        status: 'failed',
        error: incompatibleReasoningError,
      })
      .mockResolvedValue({ status: 'completed' });

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sdkSessionId: 'poisoned-thread',
        codexAppServerIdleTimeoutMinutes: 1,
      },
      jest.fn(),
      fakeWindowGetter(),
    );

    session.sendMessage('Continue');
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const callsAfterRetry = jest.mocked(CodexAppServerClient).mock.calls;
    expect(callsAfterRetry).toHaveLength(2);
    expect(callsAfterRetry[1]?.[0].forceMaterializeOnResume).toBe(true);

    // The idle timer disposes the client between turns. The next client must
    // NOT inherit the force flag: it would abandon the thread and re-inject
    // the whole history on every idle cycle instead of cheaply resuming.
    jest.advanceTimersByTime(60_000);
    expect(disposeMock).toHaveBeenCalled();

    session.sendMessage('Next message after idle release');
    await flushMicrotasks();
    await flushMicrotasks();

    const callsAfterIdle = jest.mocked(CodexAppServerClient).mock.calls;
    expect(callsAfterIdle).toHaveLength(3);
    expect(callsAfterIdle[2]?.[0].forceMaterializeOnResume).toBe(false);

    await session.destroy();
    jest.useRealTimers();
  });

  it.each([false, true])(
    'passes initial and updated Codex fast mode to subsequent turns (%s)',
    async (initialFast) => {
      startTurnMock.mockResolvedValue({ status: 'completed' });

      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          codexFastModeEnabled: initialFast,
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('First');
      await flush();
      await flush();
      await session.setCodexFastMode?.(!initialFast);
      session.sendMessage('Second');
      await flush();
      await flush();

      expect(startTurnMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          modelConfig: {
            fastMode: initialFast,
            speed: initialFast ? 'fast' : 'standard',
            thinkingLevel: 'high',
          },
        }),
      );
      expect(startTurnMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          modelConfig: {
            fastMode: !initialFast,
            speed: initialFast ? 'standard' : 'fast',
            thinkingLevel: 'high',
          },
        }),
      );

      await session.destroy();
    },
  );

  it('applies exact Ultra fast speed and explicit legacy resets on subsequent turns', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        thinkingLevel: 'low',
        modelConfig: { thinkingLevel: 'low', speed: 'fast', fastMode: true },
      },
      jest.fn(),
      () => null,
    );
    try {
      await session.setSpeed?.('ultrafast');
      session.sendMessage('Ultra turn');
      await flush();
      await flush();
      await session.setFastMode?.(false);
      session.sendMessage('Regular turn');
      await flush();
      await flush();
      await session.setCodexFastMode?.(true);
      session.sendMessage('Fast turn');
      await flush();
      await flush();
      for (const { index, speed, fastMode } of [
        { index: 1, speed: 'ultrafast', fastMode: false },
        { index: 2, speed: 'standard', fastMode: false },
        { index: 3, speed: 'fast', fastMode: true },
      ]) {
        expect(startTurnMock).toHaveBeenNthCalledWith(
          index,
          expect.objectContaining({
            thinkingLevel: 'low',
            modelConfig: { thinkingLevel: 'low', speed, fastMode },
          }),
        );
      }
    } finally {
      await session.destroy();
    }
  });

  it('admits Ultra fast against the actual native route before turn/start', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'gpt-6-sol',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      },
      jest.fn(),
      () => null,
    );
    try {
      session.sendMessage('Ultra turn');
      await flush();
      await flush();
      expect(mockAdmitCodexSpeed).toHaveBeenCalledWith(
        'ultrafast',
        expect.objectContaining({
          selectedModel: 'gpt-6-sol',
          runtimeModel: 'gpt-6-sol',
          harness: 'codex',
          providerType: 'codex',
          gateway: null,
          mockProvider: false,
        }),
      );
      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          modelConfig: {
            thinkingLevel: 'high',
            speed: 'ultrafast',
            fastMode: false,
          },
          ultrafastAdmitted: true,
        }),
      );
      expect(mockAdmitCodexSpeed.mock.invocationCallOrder[0]).toBeLessThan(
        startTurnMock.mock.invocationCallOrder[0] ?? 0,
      );
    } finally {
      await session.destroy();
    }
  });

  it('ends a refused Ultra fast turn visibly without any turn request and keeps the session usable', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    mockAdmitCodexSpeed.mockRejectedValueOnce(
      new CodexSpeedUnsupportedError(
        'ultrafast',
        "This Codex connection doesn't offer Ultra fast for this model. Choose Regular or Fast.",
      ),
    );
    const onEvent = jest.fn();
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'gpt-6-sol',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      },
      onEvent,
      () => null,
    );
    try {
      session.sendMessage('Ultra turn');
      await flush();
      await flush();
      expect(startTurnMock).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          is_error: true,
          result:
            "This Codex connection doesn't offer Ultra fast for this model. Choose Regular or Fast.",
        }),
      );

      // No automatic downgrade: the next turn runs only after the user
      // explicitly chooses another speed.
      await session.setSpeed?.('standard');
      session.sendMessage('Regular turn');
      await flush();
      await flush();
      expect(startTurnMock).toHaveBeenCalledTimes(1);
      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          modelConfig: {
            thinkingLevel: 'high',
            speed: 'standard',
            fastMode: false,
          },
          ultrafastAdmitted: false,
        }),
      );
    } finally {
      await session.destroy();
    }
  });

  it('reports a failed Ultra fast turn once and never replays it at another speed', async () => {
    startTurnMock.mockResolvedValueOnce({
      status: 'failed',
      error: 'The requested service tier is not available for this model',
      codexErrorInfo: 'badRequest',
    });
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        model: 'gpt-6-sol',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      },
      jest.fn(),
      () => null,
    );
    try {
      session.sendMessage('Ultra turn');
      await flush();
      await flush();
      expect(startTurnMock).toHaveBeenCalledTimes(1);
      expect(mockReportCodexSpeedTurnFailure).toHaveBeenCalledTimes(1);
      expect(mockReportCodexSpeedTurnFailure).toHaveBeenCalledWith(
        expect.objectContaining({ speed: 'ultrafast', generation: 1 }),
        'gpt-6-sol',
        {
          codexErrorInfo: 'badRequest',
          message: 'The requested service tier is not available for this model',
        },
      );
    } finally {
      await session.destroy();
    }
  });

  it('does not recreate App Advisor client for unrelated tool not found errors', async () => {
    startTurnMock.mockResolvedValueOnce({
      status: 'failed',
      error: 'shell tool not found',
    });

    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        assistantMode: 'app-advisor',
      },
      (event) => events.push(event),
      () => null,
    );

    session.sendMessage('Inspect the app');
    await flush();
    await flush();

    expect(CodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(disposeMock).not.toHaveBeenCalled();
    expect(mockRecordSessionDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'app_advisor_dynamic_tool_recreate',
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'result',
          is_error: true,
          subtype: 'codex_error',
          result: 'shell tool not found',
        }),
      ]),
    );

    await session.destroy();
  });

  it.each([
    [
      'an unanswered thread/resume',
      (): Error =>
        new CodexAppServerRequestTimeoutError('thread/resume', 120_000),
      {
        result: 'Codex app-server did not respond to thread/resume within 120s',
        codex_error_code: 'app_server_request_timeout',
        codex_error_method: 'thread/resume',
      },
    ],
    [
      'a thread that is still closing',
      (): Error =>
        new CodexAppServerJsonRpcError(
          'thread/resume',
          'thread t-1 is closing; retry thread/resume after the thread is closed',
          -32600,
          undefined,
        ),
      { codex_error_code: 'thread_closing' },
    ],
    [
      'a shared restart that failed this chat',
      (): Error => new CodexSharedRestartPeerError(),
      { codex_error_code: 'app_server_shared_restart' },
    ],
  ])(
    'marks %s on the terminal error event',
    async (_label, makeError, marker) => {
      startTurnMock.mockRejectedValueOnce(makeError());

      const events: unknown[] = [];
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        (event) => events.push(event),
        () => null,
      );

      session.sendMessage('Do the work');
      await flush();
      await flush();

      expect(events.filter(isCodexErrorResultEvent)).toEqual([
        expect.objectContaining(marker),
      ]);

      await session.destroy();
    },
  );

  it('leaves an ordinary turn failure unmarked', async () => {
    startTurnMock.mockRejectedValueOnce(new Error('authentication required'));

    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      (event) => events.push(event),
      () => null,
    );

    session.sendMessage('Do the work');
    await flush();
    await flush();

    const failures = events.filter(isCodexErrorResultEvent);
    expect(failures).toHaveLength(1);
    expect(failures[0]).not.toHaveProperty('codex_error_code');
    expect(failures[0]).not.toHaveProperty('codex_error_method');

    await session.destroy();
  });

  it('cancels the active turn through the app-server client after lazy startup', async () => {
    let settleTurn!: (value: { status: string }) => void;
    startTurnMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleTurn = resolve;
        }),
    );
    interruptTurnMock.mockImplementation(() => {
      settleTurn({ status: 'interrupted' });
      return Promise.resolve();
    });

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Start a turn');
    await flush();
    await flush();

    await session.cancel();

    expect(approvalInvalidatePendingMock).toHaveBeenCalledTimes(1);
    expect(interruptTurnMock).toHaveBeenCalledTimes(1);
    await session.destroy();
  });

  it('disposes the codex client when the registered abort controller is aborted', async () => {
    startTurnMock.mockImplementation(() => new Promise<never>(() => {}));

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run');
    await flush();
    await flush();

    const thirdArg: unknown = registerSessionMock.mock.calls[0]?.[2];
    const abortController: AbortController | undefined =
      thirdArg instanceof AbortController ? thirdArg : undefined;

    if (!abortController) {
      throw new Error('Expected Codex session to register an abort controller');
    }

    abortController.abort();
    await flush();

    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it('lazily resolves plugins and passes capability roots into the app-server client', async () => {
    startTurnMock.mockResolvedValue({
      status: 'completed',
    });
    mockedResolvePlugins.mockResolvedValue({
      sdkPlugins: [],
      skillPluginDir: null,
      selectedCapabilityRoots: [
        {
          id: 'plugin-root',
          location: { type: 'local', path: '/tmp/plugin-root' },
          environmentId: 'local',
        },
      ],
      codexProcessEnv: {},
      codexMcpServers: {
        'appplugin-linear-linear--claude-plugins-official-linear-linear': {
          command: 'node',
          args: ['/tmp/plugin/server.js'],
        },
      },
      mcpServers: {},
      warnings: [],
    });

    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'builtin:app', skillName: 'demo-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections: selections,
        systemPromptAppend: 'System appendix',
        codexMultiAgentEnabled: false,
        codexMaxConcurrentSubagents: 2,
      },
      jest.fn(),
      () => null,
    );

    expect(mockedResolvePlugins).not.toHaveBeenCalled();
    expect(CodexAppServerClient).not.toHaveBeenCalled();

    session.sendMessage('Run with plugins');
    await flush();
    await flush();

    expect(mockedResolvePlugins).toHaveBeenCalledWith(
      selections,
      'project',
      'worktree',
      'chat',
      expect.objectContaining({ purpose: 'codex-session' }),
    );

    const firstCall = jest.mocked(CodexAppServerClient).mock.calls[0];
    const clientArgs = firstCall?.[0];
    expect(clientArgs).toBeDefined();
    expect(mockedGetEnhancedEnv).not.toHaveBeenCalled();
    expect(clientArgs?.spawnProfile).toMatchObject({
      logicalWorkspaceEnvironmentId: 'agent:default-agent',
    });
    expect(JSON.stringify(clientArgs?.extraEnv ?? {})).not.toContain(
      'CODEX_HOME',
    );
    expect(clientArgs?.mcpServersConfig).toEqual({
      'appplugin-linear-linear--claude-plugins-official-linear-linear': {
        command: 'node',
        args: ['/tmp/plugin/server.js'],
      },
    });
    expect(clientArgs?.selectedCapabilityRoots).toEqual([
      {
        id: 'plugin-root',
        location: { type: 'local', path: '/tmp/plugin-root' },
        environmentId: 'local',
      },
    ]);
    expect(clientArgs?.multiAgentEnabled).toBe(false);
    expect(clientArgs?.maxConcurrentSubagents).toBe(2);
    expect(clientArgs?.developerInstructions).toContain('System appendix');
    expect(clientArgs?.developerInstructions).toContain(
      'appplugin-linear-linear--claude-plugins-official-linear-linear',
    );
    expect(clientArgs?.developerInstructions).toContain(
      'tool-only plugin MCP servers do not appear',
    );
    expect(clientArgs?.developerInstructions).toContain('ALL_TOOLS');
    expect(clientArgs?.dynamicTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'canopy_ask_user_question' }),
        expect.objectContaining({ name: 'canopy_get_script_output' }),
        expect.objectContaining({ name: 'canopy_read_pipeline_yaml' }),
        expect.objectContaining({ name: 'canopy_search_actions' }),
        expect.objectContaining({ name: 'canopy_dispatch_action' }),
        expect.objectContaining({ name: 'canopy_search_watchers' }),
        expect.objectContaining({ name: 'canopy_setup_watchers' }),
        expect.objectContaining({ name: 'canopy_set_auto_archive' }),
      ]),
    );
    expect(typeof clientArgs?.dynamicToolCallHandler).toBe('function');

    await session.destroy();
  });

  it.each(['automation', 'hook'] as const)(
    'defers ShowFiles through the real Codex dynamic-tool ingress for %s turns',
    async (source) => {
      startTurnMock.mockResolvedValue({ status: 'completed' });
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
        },
        jest.fn(),
        () => null,
      );
      try {
        recordPresentationTurn('project/worktree/chat', 'scheduled', source);
        session.sendMessage('Show scheduled files');
        await flush();
        await flush();
        const handler =
          jest.mocked(CodexAppServerClient).mock.calls[0]?.[0]
            .dynamicToolCallHandler;
        if (!handler) throw new Error('Missing Codex dynamic-tool ingress');
        const result = await handler({
          threadId: 'thread',
          turnId: 'turn',
          callId: 'scheduled-files',
          namespace: null,
          tool: 'canopy_show_files',
          arguments: {
            files: [{ path: 'state.json' }, { path: 'index.html' }],
          },
        });
        expect(result.success).toBe(true);
        const output = result.contentItems.find(
          (item) => item.type === 'inputText',
        );
        if (output?.type !== 'inputText')
          throw new Error('Missing ShowFiles receipt');
        expect(JSON.parse(output.text)).toMatchObject({
          presentation: 'deferred',
          reason: 'automation_turn',
          opened: 0,
          deferred: 2,
          activated: false,
        });
      } finally {
        clearPresentationTurn('project/worktree/chat');
        await session.destroy();
      }
    },
  );

  it('checks Codex dynamic tools through the approval session before dispatch', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    approvalCheckMock.mockResolvedValueOnce({
      decision: 'deny',
      message: 'Not approved',
    });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Try a dynamic tool');
    await flush();
    await flush();
    const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    const response = await clientArgs?.dynamicToolCallHandler?.({
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      namespace: null,
      tool: 'canopy_dispatch_action',
      arguments: { type: 'pipeline.list' },
    });

    expect(approvalCheckMock).toHaveBeenCalledWith(
      { kind: 'tool', toolName: 'canopy_dispatch_action' },
      {
        title: 'Use canopy_dispatch_action?',
        details: {
          kind: 'tool',
          toolName: 'canopy_dispatch_action',
          inputSummary: '{"type":"pipeline.list"}',
        },
        suggestedTarget: {
          kind: 'tool',
          toolName: 'canopy_dispatch_action',
        },
        toolUseId: 'codex-call',
      },
    );
    expect(response).toEqual({
      contentItems: [{ type: 'inputText', text: 'Not approved' }],
      success: false,
    });

    await session.destroy();
  });

  it('delegates App Advisor WatchCommand approval to its scoped runtime', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    const watchCommand = jest.fn().mockResolvedValue({ id: 'watcher-1' });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'app-advisor',
        worktreeId: 'global',
        chatId: 'advisor-chat',
        assistantMode: 'app-advisor',
        appAdvisorRuntime: createAppAdvisorRuntimeFixture({ watchCommand }),
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Watch a command');
    await flush();
    await flush();
    const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    const response = await clientArgs?.dynamicToolCallHandler?.({
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      namespace: null,
      tool: APP_ADVISOR_TOOL_REGISTRY.watch_command.codexToolName,
      arguments: {
        command: 'printf ready',
        intervalSeconds: 5,
        maxAttempts: 2,
      },
    });

    expect(approvalCheckMock).not.toHaveBeenCalled();
    expect(watchCommand).toHaveBeenCalledTimes(1);
    expect(response?.success).toBe(true);

    await session.destroy();
  });

  it.each(['ask', 'auto', 'full-access'] as const)(
    'uses the session policy for Codex dynamic tools in Plan mode with %s approvals',
    async (approvalMode) => {
      startTurnMock.mockResolvedValue({ status: 'completed' });
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          planMode: true,
          approvalMode,
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('Try a dynamic tool');
      await flush();
      await flush();
      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      const response = await clientArgs?.dynamicToolCallHandler?.({
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call',
        namespace: null,
        tool: 'canopy_set_auto_archive',
        arguments: { enabled: true },
      });

      expect(approvalCheckMock).toHaveBeenCalledWith(
        { kind: 'tool', toolName: 'canopy_set_auto_archive' },
        expect.any(Object),
      );
      expect(response?.success).toBe(true);

      await session.destroy();
    },
  );

  it('preserves session deny decisions when Plan mode is disabled during an active Plan turn', async () => {
    let resolveTurn: (value: { status: 'completed' }) => void = () => undefined;
    startTurnMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
        }),
    );
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        planMode: true,
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Try a dynamic tool');
    await flush();
    await flush();
    await session.setPlanMode(false);
    approvalCheckMock.mockResolvedValueOnce({
      decision: 'deny',
      message: 'Blocked by session rule',
    });

    const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    const response = await clientArgs?.dynamicToolCallHandler?.({
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      namespace: null,
      tool: 'canopy_dispatch_action',
      arguments: { type: 'pipeline.list' },
    });

    expect(approvalCheckMock).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      contentItems: [
        {
          type: 'inputText',
          text: 'Blocked by session rule',
        },
      ],
      success: false,
    });

    resolveTurn({ status: 'completed' });
    await flush();
    await session.destroy();
  });

  it('invalidates sibling approvals before interrupting a denied Codex dynamic-tool turn', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    approvalCheckMock.mockResolvedValueOnce({
      decision: 'deny',
      message: 'Denied and stopped',
      stopTurn: true,
    });
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Try a dynamic tool');
    await flush();
    await flush();
    const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    const response = await clientArgs?.dynamicToolCallHandler?.({
      threadId: 'thread',
      turnId: 'turn',
      callId: 'call',
      namespace: null,
      tool: 'canopy_dispatch_action',
      arguments: { type: 'pipeline.list' },
    });

    expect(response).toEqual({
      contentItems: [{ type: 'inputText', text: 'Denied and stopped' }],
      success: false,
    });
    expect(approvalInvalidatePendingMock).toHaveBeenCalledTimes(1);
    expect(interruptTurnMock).not.toHaveBeenCalled();

    const siblingResponse = await clientArgs?.dynamicToolCallHandler?.({
      threadId: 'thread',
      turnId: 'turn',
      callId: 'sibling-call',
      namespace: null,
      tool: 'canopy_dispatch_action',
      arguments: { type: 'pipeline.run' },
    });

    expect(approvalCheckMock).toHaveBeenCalledTimes(1);
    expect(siblingResponse).toEqual({
      contentItems: [
        { type: 'inputText', text: 'The owning turn was cancelled.' },
      ],
      success: false,
    });

    await flush();

    expect(interruptTurnMock).toHaveBeenCalledTimes(1);
    await session.destroy();
  });

  it('retries transient Codex plugin resolution failures before creating the app-server client', async () => {
    jest.useFakeTimers();
    startTurnMock.mockResolvedValue({ status: 'completed' });
    mockedResolvePlugins
      .mockRejectedValueOnce(new Error('marketplace cache busy'))
      .mockResolvedValue({
        sdkPlugins: [],
        skillPluginDir: null,
        selectedCapabilityRoots: [],
        codexProcessEnv: {},
        codexMcpServers: {},
        mcpServers: {},
        warnings: [],
      });

    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'builtin:app', skillName: 'demo-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections: selections,
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run with plugins');
    await flushMicrotasks();
    expect(CodexAppServerClient).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(150);
    await flushMicrotasks();

    expect(mockedResolvePlugins).toHaveBeenCalledTimes(2);
    const pluginRouteOwnerId =
      mockedResolvePlugins.mock.calls[0]?.[4]?.sessionId;
    expect(pluginRouteOwnerId).toEqual(
      expect.stringMatching(
        /^codex-session:project\/worktree\/chat:[0-9a-f-]{36}$/,
      ),
    );
    expect(mockUnregisterRoutesForSession).toHaveBeenCalledWith(
      pluginRouteOwnerId,
    );
    expect(mockUnregisterRoutesForSession).toHaveBeenCalledTimes(1);
    expect(CodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(startTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Run with plugins' }),
    );

    await session.destroy();
    expect(mockRevokeStdioMcpRoutes).toHaveBeenCalledWith(pluginRouteOwnerId);
    jest.useRealTimers();
  });

  it('prunes a missing Codex plugin path without delaying app-server startup', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    mockedResolvePlugins
      .mockResolvedValueOnce({
        sdkPlugins: [],
        skillPluginDir: null,
        selectedCapabilityRoots: [],
        codexProcessEnv: {},
        codexMcpServers: {},
        mcpServers: {},
        warnings: ['Plugin path does not exist: /tmp/plugins/ud-git'],
      })
      .mockResolvedValue({
        sdkPlugins: [],
        skillPluginDir: null,
        selectedCapabilityRoots: [],
        codexProcessEnv: {},
        codexMcpServers: {},
        mcpServers: {},
        warnings: [],
      });

    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'codex-market', pluginName: 'ud-git' }],
      mcpServerRefs: [],
    };

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections: selections,
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run with plugins');
    await flushMicrotasks();

    expect(mockedResolvePlugins).toHaveBeenCalledTimes(1);
    expect(mockedResolvePlugins).toHaveBeenCalledWith(
      selections,
      'project',
      'worktree',
      'chat',
      expect.objectContaining({
        purpose: 'codex-session',
        installExternalPlugins: false,
      }),
    );
    expect(mockUnregisterRoutesForSession).not.toHaveBeenCalled();
    expect(CodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(startTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Run with plugins' }),
    );

    await session.destroy();
  });

  it('starts with canonical state immediately when a stale plugin selection is unavailable', async () => {
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    startTurnMock.mockResolvedValue({ status: 'completed' });
    mockedResolvePlugins.mockResolvedValue({
      sdkPlugins: [],
      skillPluginDir: null,
      selectedCapabilityRoots: [],
      codexProcessEnv: {},
      codexMcpServers: {},
      mcpServers: {},
      warnings: ['Plugin path does not exist: /tmp/plugins/ud-git'],
    });

    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'codex-market', pluginName: 'ud-git' }],
      mcpServerRefs: [],
    };

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections: selections,
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run with plugins');
    await flushMicrotasks();

    expect(mockedResolvePlugins).toHaveBeenCalledTimes(1);
    expect(mockUnregisterRoutesForSession).not.toHaveBeenCalled();
    expect(CodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(startTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Run with plugins' }),
    );
    const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    expect(JSON.stringify(clientArgs?.extraEnv ?? {})).not.toContain(
      'CODEX_HOME',
    );

    await session.destroy();
    consoleWarnSpy.mockRestore();
  });

  it('does not create the app-server client when destroyed during plugin retry backoff', async () => {
    jest.useFakeTimers();
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    startTurnMock.mockResolvedValue({ status: 'completed' });
    mockedResolvePlugins
      .mockRejectedValueOnce(new Error('marketplace cache busy'))
      .mockResolvedValue({
        sdkPlugins: [],
        skillPluginDir: null,
        selectedCapabilityRoots: [],
        codexProcessEnv: {},
        codexMcpServers: {},
        mcpServers: {},
        warnings: [],
      });

    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'builtin:app', skillName: 'demo-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections: selections,
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run with plugins');
    await flushMicrotasks();

    await session.destroy();
    await jest.advanceTimersByTimeAsync(150);
    await flushMicrotasks();

    expect(mockedResolvePlugins).toHaveBeenCalledTimes(1);
    expect(mockUnregisterRoutesForSession).toHaveBeenCalledWith(
      'project/worktree/chat',
    );
    expect(stopSessionPhaseTimerMock).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      '[codex-plugin-resolver] Failed to resolve plugins:',
      expect.any(Error),
    );
    expect(CodexAppServerClient).not.toHaveBeenCalled();
    expect(startTurnMock).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    jest.useRealTimers();
  });

  it('fails closed after exhausting transient Codex plugin resolution retries', async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    startTurnMock.mockResolvedValue({ status: 'completed' });
    mockedResolvePlugins.mockRejectedValue(new Error('persistent failure'));

    const selections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'builtin:app', skillName: 'demo-skill' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const events: unknown[] = [];

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        pluginSelections: selections,
      },
      (event) => events.push(event),
      () => null,
    );

    session.sendMessage('Run with plugins');
    await flushMicrotasks();
    for (const delayMs of [150, 750, 2_000, 5_000]) {
      await jest.advanceTimersByTimeAsync(delayMs);
      await flushMicrotasks();
    }

    expect(mockedResolvePlugins).toHaveBeenCalledTimes(5);
    expect(mockUnregisterRoutesForSession).toHaveBeenCalledTimes(5);
    expect(CodexAppServerClient).not.toHaveBeenCalled();
    expect(startTurnMock).not.toHaveBeenCalled();
    const errorEvent = events.find(isCodexErrorResultEvent);
    expect(errorEvent?.result).toContain(
      'Failed to resolve Codex plugins before session start: persistent failure',
    );

    session.sendMessage('Try again');
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(150);
    await flushMicrotasks();

    expect(mockedResolvePlugins).toHaveBeenCalledTimes(7);
    expect(CodexAppServerClient).not.toHaveBeenCalled();
    expect(startTurnMock).not.toHaveBeenCalled();

    await session.destroy();
    consoleWarnSpy.mockRestore();
  });

  it('releases the idle client after a completed turn using the configured timeout', async () => {
    jest.useFakeTimers();
    startTurnMock.mockResolvedValue({ status: 'completed' });

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        codexAppServerIdleTimeoutMinutes: 2,
      },
      jest.fn(),
      fakeWindowGetter(),
    );

    session.sendMessage('Run once');
    await flushMicrotasks();

    jest.advanceTimersByTime(119_999);
    expect(disposeMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(disposeMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(120_000);
    expect(disposeMock).toHaveBeenCalledTimes(1);

    await session.destroy();
    jest.useRealTimers();
  });

  it('recreates a released idle client and resumes its durable thread', async () => {
    jest.useFakeTimers();
    startTurnMock.mockResolvedValue({ status: 'completed' });

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        codexAppServerIdleTimeoutMinutes: 1,
      },
      jest.fn(),
      fakeWindowGetter(),
    );

    session.sendMessage('Run once');
    await flushMicrotasks();

    jest.advanceTimersByTime(60_000);
    expect(disposeMock).toHaveBeenCalledTimes(1);
    expect(CodexAppServerClient).toHaveBeenCalledTimes(1);

    session.sendMessage('Run after idle release');
    await flushMicrotasks();

    expect(CodexAppServerClient).toHaveBeenCalledTimes(2);
    expect(jest.mocked(CodexAppServerClient).mock.calls[1]?.[0]).toMatchObject({
      initialThreadId: 'old-thread-without-tools',
    });
    expect(startTurnMock).toHaveBeenCalledTimes(2);

    await session.destroy();
    jest.useRealTimers();
  });

  it('starts pipeline editor on a fresh thread and resumes it after idle release', async () => {
    jest.useFakeTimers();
    startTurnMock.mockResolvedValue({ status: 'completed' });

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sdkSessionId: 'persisted-thread-that-must-not-be-used',
        assistantMode: 'pipeline-editor',
        codexAppServerIdleTimeoutMinutes: 1,
      },
      jest.fn(),
      () => null,
    );

    expect(session.getProviderSessionId()).toBeUndefined();

    session.sendMessage('Run once');
    await flushMicrotasks();

    expect(jest.mocked(CodexAppServerClient).mock.calls[0]?.[0]).toMatchObject({
      initialThreadId: undefined,
    });

    jest.advanceTimersByTime(60_000);
    session.sendMessage('Run after idle release');
    await flushMicrotasks();

    expect(jest.mocked(CodexAppServerClient).mock.calls[1]?.[0]).toMatchObject({
      initialThreadId: 'old-thread-without-tools',
    });

    await session.destroy();
    jest.useRealTimers();
  });

  it('uses the default 10 minute idle timeout when no option is passed', async () => {
    jest.useFakeTimers();
    startTurnMock.mockResolvedValue({ status: 'completed' });

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      fakeWindowGetter(),
    );

    session.sendMessage('Run once');
    await flushMicrotasks();

    jest.advanceTimersByTime(599_999);
    expect(disposeMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(disposeMock).toHaveBeenCalledTimes(1);

    await session.destroy();
    jest.useRealTimers();
  });

  it('clears the previous idle timer before starting a new turn', async () => {
    jest.useFakeTimers();
    startTurnMock.mockResolvedValue({ status: 'completed' });

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        codexAppServerIdleTimeoutMinutes: 2,
      },
      jest.fn(),
      fakeWindowGetter(),
    );

    session.sendMessage('First');
    await flushMicrotasks();
    jest.advanceTimersByTime(60_000);

    session.sendMessage('Second');
    await flushMicrotasks();
    jest.advanceTimersByTime(60_000);
    expect(disposeMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60_000);
    expect(disposeMock).toHaveBeenCalledTimes(1);

    await session.destroy();
    jest.useRealTimers();
  });

  it('destroy retires a client that acknowledges interrupt without completing the turn', async () => {
    jest.useFakeTimers();
    let rejectTurn: ((error: Error) => void) | undefined;
    startTurnMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectTurn = reject;
        }),
    );
    disposeMock.mockImplementationOnce(() => {
      if (!rejectTurn) throw new Error('Turn did not start');
      rejectTurn(new Error('session_destroyed'));
    });
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      () => null,
    );
    session.sendMessage('Run');
    await flushMicrotasks();
    expect(startTurnMock).toHaveBeenCalledTimes(1);
    const destroyed = session.destroy();
    await flushMicrotasks();
    expect(interruptTurnMock).toHaveBeenCalledTimes(1);
    expect(disposeMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(disposeMock).toHaveBeenCalled();
    await destroyed;
  });

  it('destroy clears the idle timer', async () => {
    jest.useFakeTimers();
    startTurnMock.mockResolvedValue({ status: 'completed' });

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        codexAppServerIdleTimeoutMinutes: 1,
      },
      jest.fn(),
      fakeWindowGetter(),
    );

    session.sendMessage('Run once');
    await flushMicrotasks();
    await session.destroy();
    expect(disposeMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    expect(disposeMock).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });

  it('reschedules an existing idle timer when the timeout preference changes', async () => {
    jest.useFakeTimers();
    startTurnMock.mockResolvedValue({ status: 'completed' });

    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      },
      jest.fn(),
      fakeWindowGetter(),
    );

    session.sendMessage('Run once');
    await flushMicrotasks();
    await session.setCodexAppServerIdleTimeoutMinutes?.(1);

    jest.advanceTimersByTime(59_999);
    expect(disposeMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(disposeMock).toHaveBeenCalledTimes(1);

    await session.destroy();
    jest.useRealTimers();
  });

  describe('AI Credits routing when not natively authenticated', () => {
    afterEach(() => {
      clearAiCreditsRoutingModeCache();
      // Restore the natively-authed default so later tests keep the native path.
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockedGetRoutingContext.mockReset();
    });

    it('holds the first Codex spawn until routing-status admission settles', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      startTurnMock.mockResolvedValue({ status: 'completed' });
      let releaseStatus = (): void => undefined;
      const heldStatus = new Promise<void>((resolve) => {
        releaseStatus = resolve;
      });
      let statusSeen = (): void => undefined;
      const status = new Promise<void>((resolve) => {
        statusSeen = resolve;
      });
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'gpt-6-luna',
        },
        (event) => {
          if (
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'canopy_ai_credits_routing'
          ) {
            statusSeen();
            return heldStatus;
          }
        },
        () => null,
      );
      try {
        session.sendMessage('Run once');
        await status;
        await flushMicrotasks();
        expect(CodexAppServerClient).not.toHaveBeenCalled();
        releaseStatus();
        await flushMicrotasks();
        expect(CodexAppServerClient).toHaveBeenCalledTimes(1);
      } finally {
        releaseStatus();
        await session.destroy();
      }
    });

    it('routes a gateway model through AI Credits with on-quota mode and no native auth', async () => {
      setAiCreditsRoutingModeCache('on-quota');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account-a',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      startTurnMock.mockResolvedValue({ status: 'completed' });

      const onEvent = jest.fn();
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'gpt-6-luna',
        },
        onEvent,
        () => null,
      );

      session.sendMessage('Run once');
      await flushMicrotasks();

      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: true,
        provider: 'codex',
      });
      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(JSON.stringify(clientArgs?.extraEnv ?? {})).not.toContain(
        'csk_test',
      );
      expect(clientArgs?.configArgs).toEqual([
        '-c',
        'model_catalog_json="/tmp/codex-gateway-models.json"',
      ]);
      expect(clientArgs?.threadConfig).toMatchObject({
        model: 'openai/gpt-6-luna',
        model_provider: 'canopy_ai_credits',
      });
      expect(startTurnMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ model: 'openai/gpt-6-luna' }),
      );

      await session.setModel?.('gpt-5.6-luna');
      session.sendMessage('Run again');
      await flushMicrotasks();

      expect(startTurnMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ model: 'openai/gpt-5.6-luna' }),
      );

      await session.destroy();
    });

    it('refreshes a routed session token only for the account that created it', async () => {
      setAiCreditsRoutingModeCache('on-quota');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_account_a',
        accountIdentity: 'account-a',
        email: 'a@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      startTurnMock.mockResolvedValue({ status: 'completed' });

      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'gpt-6-luna',
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('Run once');
      await flushMicrotasks();

      const registration = mockRegisterGatewayRoute.mock.calls[0]?.[0];
      if (!registration) {
        throw new Error('expected Codex gateway route registration');
      }

      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_account_a_rotated',
        accountIdentity: 'account-a',
        email: 'a@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      await expect(registration.resolveToken()).resolves.toBe(
        'csk_account_a_rotated',
      );

      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_account_b',
        accountIdentity: 'account-b',
        email: 'b@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      await expect(registration.resolveToken()).resolves.toBeNull();

      await session.destroy();
    });

    it('emits an unavailable error for an unresolved model with automatic routing', async () => {
      setAiCreditsRoutingModeCache('on-quota');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      startTurnMock.mockResolvedValue({ status: 'completed' });

      const onEvent = jest.fn();
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'not-a-gateway-model',
        },
        onEvent,
        () => null,
      );

      session.sendMessage('Run once');
      await flushMicrotasks();

      expect(onEvent).toHaveBeenCalledWith({
        type: 'error',
        error:
          'This model is no longer available. Pick another model to continue.',
      });
      expect(mockedGetRoutingContext).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: false,
        provider: 'codex',
      });
      // The session must abort rather than spawn the native app-server —
      // otherwise the user gets a second raw provider auth failure on top of
      // the backstop message.
      expect(CodexAppServerClient).not.toHaveBeenCalled();
      expect(startTurnMock).not.toHaveBeenCalled();
      // A terminating result still fires so the tab status resets.
      expect(onEvent).toHaveBeenCalledWith({
        type: 'result',
        is_error: false,
        result: 'Session ended',
      });

      await session.destroy();
    });

    // The STEADY-STATE out-of-credits case, and the one that reported as "no
    // response, no error, no banner". Once the balance reads zero the turn is
    // aborted pre-flight and never reaches the gateway, so the mid-turn 402 and
    // everything derived from it stop happening. The abort emits a bare `error`
    // event, which the reducer turns into `state.error` with ZERO transcript
    // messages, and the banner's derived condition needs `!nativeAuth` — false
    // here, because a signed-in user can select a gateway-only model. So
    // nothing rendered anywhere unless the abort raises the signal itself.
    it('raises the recovery banner when a signed-in user picks a gateway-only model with no credits', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account-a',
        email: 'user@example.com',
        creditsEligible: false,
        cloudBaseUrl: 'https://cloud.example.com',
      });

      const events: unknown[] = [];
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'deepseek-v4-pro',
        },
        (event) => events.push(event),
        () => null,
      );

      session.sendMessage('explain again');
      await flushMicrotasks();

      function isRecordEvent(value: unknown): value is Record<string, unknown> {
        return (
          typeof value === 'object' && value !== null && !Array.isArray(value)
        );
      }
      const records = events.filter(isRecordEvent);

      // The live signal that makes `NoBillingSourceBanner` visible despite a
      // working native login.
      expect(
        records.find(
          (event) => event.type === AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE,
        ),
      ).toMatchObject({
        type: AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE,
        provider: 'codex',
      });
      // Stamped so the tab persists the flag and the banner survives a reload.
      expect(records.find((event) => event.type === 'error')).toMatchObject({
        type: 'error',
        [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
      });
      // Still aborts rather than spawning a session nothing can pay for.
      expect(startTurnMock).not.toHaveBeenCalled();

      await session.destroy();
    });

    it('forces gateway routing for a gateway-only model even when natively authenticated', async () => {
      // A ChatGPT-logged-in user with routing mode off would normally resolve to
      // the native path, but a gateway-only model can never be
      // billed natively, so routing must be forced through AI Credits.
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account-a',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      startTurnMock.mockResolvedValue({ status: 'completed' });

      const onEvent = jest.fn();
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'deepseek-v4-pro',
        },
        onEvent,
        () => null,
      );

      session.sendMessage('Run once');
      await flushMicrotasks();

      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: true,
        provider: 'codex',
      });
      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(JSON.stringify(clientArgs?.extraEnv ?? {})).not.toContain(
        'csk_test',
      );
      expect(clientArgs?.configArgs).toEqual([
        '-c',
        'model_catalog_json="/tmp/codex-gateway-models.json"',
      ]);
      expect(clientArgs?.threadConfig).toMatchObject({
        model: 'deepseek/deepseek-v4-pro',
        model_provider: 'canopy_ai_credits',
      });
      expect(clientArgs?.toolSchemaProfile).toBe('flat');
      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'deepseek/deepseek-v4-pro' }),
      );

      await session.destroy();
    });

    // Routing is resolved once, behind the `extraEnv === null` gate, and
    // `setModel` does not re-open it. A chat that starts on a natively-billable
    // model therefore kept its ChatGPT-authed app-server after the user picked
    // DeepSeek, and the turn went out as a raw `deepseek-v4-pro` — answered with
    // "The 'deepseek-v4-pro' model is not supported when using Codex with a
    // ChatGPT account." Restarting the app "fixed" it only because that rebuilt
    // the session under the new model.
    it('admits Ultra fast against the gateway route actually applied, not the native catalog', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account-a',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      mockAdmitCodexSpeed.mockRejectedValueOnce(
        new CodexSpeedUnsupportedError(
          'ultrafast',
          'Ultra fast runs only on a Codex sign-in. Choose Regular or Fast for this connection.',
        ),
      );
      const onEvent = jest.fn();
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'deepseek-v4-pro',
          modelConfig: { speed: 'ultrafast', fastMode: false },
        },
        onEvent,
        () => null,
      );

      session.sendMessage('Routed Ultra turn');
      await flushMicrotasks();

      expect(mockAdmitCodexSpeed.mock.calls[0]?.[0]).toBe('ultrafast');
      expect(mockAdmitCodexSpeed.mock.calls[0]?.[1]).toMatchObject({
        selectedModel: 'deepseek-v4-pro',
        runtimeModel: 'deepseek/deepseek-v4-pro',
        gateway: 'ai-credits',
        codexConfig: { model_provider: 'canopy_ai_credits' },
      });
      expect(startTurnMock).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          is_error: true,
          result:
            'Ultra fast runs only on a Codex sign-in. Choose Regular or Fast for this connection.',
        }),
      );
      await session.destroy();
    });

    it('does not record gateway quota against a former proxy connection after a live model switch', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account-a',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      mockResolveAccountProxySessionRoute.mockResolvedValueOnce({
        accountKey: 'account-proxy:test-proxy',
        env: {},
        codexConfig: { model_provider: 'canopy_account_proxy' },
      });
      startTurnMock
        .mockResolvedValueOnce({ status: 'completed' })
        .mockResolvedValueOnce({
          status: 'failed',
          error: 'Gateway quota reached',
          codexErrorInfo: 'usageLimitExceeded',
        });
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'gpt-6-luna',
        },
        () => undefined,
        () => null,
      );
      try {
        session.sendMessage('Proxy turn');
        await flushMicrotasks();
        expect(
          jest.mocked(recordSessionAccountProxyRoute),
        ).toHaveBeenCalledWith(expect.anything(), true);
        mockRecordUsageLimitedChat.mockClear();
        await session.setModel?.('deepseek-v4-pro');
        session.sendMessage('Gateway turn');
        await flushMicrotasks();
        expect(
          jest.mocked(recordSessionAccountProxyRoute),
        ).toHaveBeenLastCalledWith(expect.anything(), false);
        expect(startTurnMock).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ aiCreditsRouted: true }),
        );
        expect(mockRecordUsageLimitedChat).not.toHaveBeenCalledWith(
          expect.objectContaining({ accountProxyConnectionId: 'test-proxy' }),
        );
      } finally {
        await session.destroy();
      }
    });

    it('re-resolves routing when the model switches to a gateway-only one mid-session', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account-a',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      startTurnMock.mockResolvedValue({ status: 'completed' });

      const onEvent = jest.fn();
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'gpt-6-luna',
        },
        onEvent,
        () => null,
      );

      session.sendMessage('Native turn first');
      await flushMicrotasks();

      // Baseline: a natively-billable model with routing off stays native.
      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: false,
        provider: 'codex',
      });
      const nativeArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(nativeArgs?.threadConfig?.model_provider).toBeUndefined();
      expect(nativeArgs?.reasoningRouteFamily).toBe('native');
      expect(startTurnMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          model: 'gpt-6-luna',
          aiCreditsRouted: false,
        }),
      );

      await session.setModel?.('deepseek-v4-pro');
      session.sendMessage('Now on DeepSeek');
      await flushMicrotasks();

      // The turn that produced the reported 400 must never be sent.
      expect(startTurnMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ model: 'deepseek-v4-pro' }),
      );
      expect(startTurnMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          model: 'deepseek/deepseek-v4-pro',
          aiCreditsRouted: true,
        }),
      );

      // The stale native client is replaced by one prepared for the gateway:
      // proxy provider, gateway tool schema, and the new reasoning route family
      // (which is what makes the app-server rebuild the thread rather than
      // replay OpenAI-private reasoning into DeepSeek).
      const routedArgs = jest.mocked(CodexAppServerClient).mock.calls[1]?.[0];
      expect(routedArgs?.threadConfig).toMatchObject({
        model: 'deepseek/deepseek-v4-pro',
        model_provider: 'canopy_ai_credits',
      });
      expect(routedArgs?.toolSchemaProfile).toBe('flat');
      expect(routedArgs?.reasoningRouteFamily).toBe('gateway:deepseek');
      // Re-preparation rebuilds the config args instead of appending to the
      // stale set, so the catalog override is not duplicated.
      expect(routedArgs?.configArgs).toEqual([
        '-c',
        'model_catalog_json="/tmp/codex-gateway-models.json"',
      ]);
      expect(JSON.stringify(routedArgs?.extraEnv ?? {})).not.toContain(
        'csk_test',
      );
      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: true,
        provider: 'codex',
      });

      await session.destroy();
    });

    it('does not interrupt an active gateway-only turn when the catalog deactivates its model', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account-a',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      let completeTurn: ((value: { status: 'completed' }) => void) | undefined;
      startTurnMock.mockReturnValue(
        new Promise((resolveTurn) => {
          completeTurn = resolveTurn;
        }),
      );

      const onEvent = jest.fn();
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'deepseek-v4-pro',
        },
        onEvent,
        () => null,
      );

      session.sendMessage('Keep this active turn running');
      await flushMicrotasks();
      expect(startTurnMock).toHaveBeenCalledTimes(1);

      // A live catalog refresh replaces the global selection registry. It must
      // not reach into or reconfigure the already-running session.
      initAiGatewayModels([], []);
      expect(interruptTurnMock).not.toHaveBeenCalled();
      expect(disposeMock).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      );

      completeTurn?.({ status: 'completed' });
      await flushMicrotasks();
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'result', is_error: false }),
      );

      session.sendMessage('Continue after the catalog refresh');
      await flushMicrotasks();
      expect(startTurnMock).toHaveBeenCalledTimes(2);
      expect(startTurnMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          model: 'deepseek/deepseek-v4-pro',
          supportedThinkingLevels: [],
        }),
      );

      await session.destroy();

      initializeTestModelCatalog();
    });

    it('emits a backstop error for a gateway-only model when the user has no AI Credits', async () => {
      // Gateway-only models have no native fallback, so a missing/ineligible
      // balance must abort with a clear message rather than spawn a native
      // session that cannot be billed.
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account-a',
        email: 'user@example.com',
        creditsEligible: false,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      startTurnMock.mockResolvedValue({ status: 'completed' });

      const onEvent = jest.fn();
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'deepseek-v4-pro',
        },
        onEvent,
        () => null,
      );

      session.sendMessage('Run once');
      await flushMicrotasks();

      // The copy is unchanged; the event additionally carries the
      // no-billing-source marking so the abort raises the recovery banner
      // instead of rendering nothing at all (a bare `error` event produces
      // `state.error` and ZERO transcript messages).
      expect(onEvent).toHaveBeenCalledWith({
        type: 'error',
        [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
        error_code: NO_BILLING_SOURCE_ERROR_CODE,
        error:
          'This model is only available with Canopy credits. Make sure you have available credits or an active plan with spendable balance to use it.',
      });
      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: false,
        provider: 'codex',
      });
      // No native app-server spawn — the gateway-only model can't be billed
      // natively, so falling through would just 401/402.
      expect(CodexAppServerClient).not.toHaveBeenCalled();
      expect(startTurnMock).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledWith({
        type: 'result',
        is_error: false,
        result: 'Session ended',
      });

      await session.destroy();
    });

    const unresolvedRestoredSelectionCases: Array<{
      name: string;
      routingMode: 'off' | 'on';
      aiCreditsRouting: AgentSessionOptions['aiCreditsRouting'];
      mockCompletedTurn: boolean;
      expectNoRoutingContext: boolean;
    }> = [
      {
        name: 'rejects an unresolved restored selection instead of launching natively after restart',
        routingMode: 'off',
        aiCreditsRouting: undefined,
        mockCompletedTurn: true,
        expectNoRoutingContext: false,
      },
      {
        name: 'rejects an unresolved restored selection when global routing mode is on',
        routingMode: 'on',
        aiCreditsRouting: undefined,
        mockCompletedTurn: false,
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
        mockCompletedTurn: false,
        expectNoRoutingContext: true,
      },
    ];

    it.each(unresolvedRestoredSelectionCases)(
      '$name',
      async ({
        routingMode,
        aiCreditsRouting,
        mockCompletedTurn,
        expectNoRoutingContext,
      }): Promise<void> => {
        setAiCreditsRoutingModeCache(routingMode);
        mockedIsNativelyAuthed.mockResolvedValue(true);
        if (mockCompletedTurn) {
          startTurnMock.mockResolvedValue({ status: 'completed' });
        }

        const onEvent = jest.fn();
        const provider = new CodexProvider();
        const session = provider.createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            model: 'removed-api-only-model',
            ...(aiCreditsRouting === undefined ? {} : { aiCreditsRouting }),
          },
          onEvent,
          () => null,
        );

        session.sendMessage('Run once');
        await flushMicrotasks();

        expect(onEvent).toHaveBeenCalledWith({
          type: 'error',
          error:
            'This model is no longer available. Pick another model to continue.',
        });
        if (expectNoRoutingContext) {
          expect(mockedGetRoutingContext).not.toHaveBeenCalled();
        }
        expect(CodexAppServerClient).not.toHaveBeenCalled();
        expect(startTurnMock).not.toHaveBeenCalled();

        await session.destroy();
      },
    );

    it('stays native when authenticated even with routing mode off (regression guard)', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      startTurnMock.mockResolvedValue({ status: 'completed' });

      const onEvent = jest.fn();
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'gpt-6-luna',
        },
        onEvent,
        fakeWindowGetter(),
      );

      session.sendMessage('Run once');
      await flushMicrotasks();

      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: false,
        provider: 'codex',
      });
      expect(mockedGetRoutingContext).not.toHaveBeenCalled();
      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(JSON.stringify(clientArgs?.extraEnv ?? {})).not.toContain(
        'csk_test',
      );
      expect(clientArgs?.configArgs).toBeUndefined();
      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-6-luna' }),
      );

      await session.destroy();
    });

    // ECW-9091: `off` is the shipped default and unreachable from Settings, so
    // this is the path every credits-only account actually takes on its first
    // message. It used to spawn natively and surface a raw login error.
    it('routes through AI Credits with routing mode off and no native auth', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account-a',
        email: 'user@example.com',
        creditsEligible: true,
        cloudBaseUrl: 'https://cloud.example.com',
      });
      startTurnMock.mockResolvedValue({ status: 'completed' });

      const onEvent = jest.fn();
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'gpt-6-luna',
        },
        onEvent,
        () => null,
      );

      session.sendMessage('Run once');
      await flushMicrotasks();

      expect(onEvent).toHaveBeenCalledWith({
        type: 'canopy_ai_credits_routing',
        active: true,
        provider: 'codex',
      });
      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(clientArgs?.threadConfig).toMatchObject({
        model: 'openai/gpt-6-luna',
        model_provider: 'canopy_ai_credits',
      });

      await session.destroy();
    });

    // `AgentSessionOptions.model` is optional. Without the `no-native-auth`
    // default the gateway lookup misses and the backstop aborts a session that
    // should just work.
    it.each(
      [undefined, 'gpt-6.1-sol', 'gpt-5.5'].flatMap((model) =>
        ['off', 'on', 'on-quota', 'session-override'].map((mode) => ({
          model,
          mode,
        })),
      ),
    )(
      'routes the credits default for $model in $mode without native auth',
      async ({ model, mode }) => {
        clearAllProviderQuotaReached();
        setAiCreditsRoutingModeCache(
          mode === 'on' ? 'on' : mode === 'on-quota' ? 'on-quota' : 'off',
        );
        if (mode === 'on-quota') markProviderQuotaReached('codex');
        mockedIsNativelyAuthed.mockResolvedValue(false);
        mockedGetRoutingContext.mockResolvedValue({
          cskToken: 'csk_test',
          accountIdentity: 'account-a',
          email: 'user@example.com',
          creditsEligible: true,
          cloudBaseUrl: 'https://cloud.example.com',
        });
        startTurnMock.mockResolvedValue({ status: 'completed' });

        const onEvent = jest.fn();
        const provider = new CodexProvider();
        const session = provider.createSession(
          {
            cwd: '/tmp/repo',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            model,
            aiCreditsRouting:
              mode === 'session-override'
                ? { active: true, scope: 'session', activatedAt: 0 }
                : undefined,
            planMode: true,
          },
          onEvent,
          () => null,
        );

        session.sendMessage('Run once');
        await flushMicrotasks();

        const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
        expect(clientArgs?.threadConfig).toMatchObject({
          model: 'openai/gpt-6-luna',
          model_provider: 'canopy_ai_credits',
        });
        expect(onEvent).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error' }),
        );

        expect(startTurnMock).toHaveBeenCalledWith(
          expect.objectContaining({
            model: 'openai/gpt-6-luna',
            planMode: true,
          }),
        );
        await session.setPlanMode(false);
        session.sendMessage('Run again');
        await flushMicrotasks();
        expect(startTurnMock).toHaveBeenCalledTimes(2);
        expect(startTurnMock).toHaveBeenLastCalledWith(
          expect.objectContaining({
            model: 'openai/gpt-6-luna',
            planMode: false,
          }),
        );

        await session.destroy();
        clearAllProviderQuotaReached();
      },
    );

    // No native login AND no credits: nothing can pay for the turn, so abort
    // with a message that names both remedies instead of a raw provider 401.
    it('aborts with the no-billing-source error when there is no native login and no credits', async () => {
      setAiCreditsRoutingModeCache('off');
      mockedIsNativelyAuthed.mockResolvedValue(false);
      mockedGetRoutingContext.mockResolvedValue(null);
      startTurnMock.mockResolvedValue({ status: 'completed' });

      const onEvent = jest.fn();
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'gpt-6-luna',
        },
        onEvent,
        () => null,
      );

      session.sendMessage('Run once');
      await flushMicrotasks();

      const noBillingSourceError = `You're not signed in to Codex and have no ${BRAND.displayName} AI Credits available. Get AI Credits or sign in to Codex to start chatting.`;
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
      expect(startTurnMock).not.toHaveBeenCalled();

      await session.destroy();
    });

    // Bounds the blast radius: a `mode` attempt says nothing about native auth,
    // so an ineligible account still falls through to its native subscription.
    it('falls through to a native spawn when credits are ineligible under a mode attempt', async () => {
      setAiCreditsRoutingModeCache('on');
      mockedIsNativelyAuthed.mockResolvedValue(true);
      mockedGetRoutingContext.mockResolvedValue(null);
      startTurnMock.mockResolvedValue({ status: 'completed' });

      const onEvent = jest.fn();
      const provider = new CodexProvider();
      const session = provider.createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'gpt-6-luna',
        },
        onEvent,
        () => null,
      );

      session.sendMessage('Run once');
      await flushMicrotasks();

      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(clientArgs?.configArgs).toBeUndefined();
      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-6-luna' }),
      );

      await session.destroy();
    });
  });

  it('waits for terminal result admission before starting a queued Codex turn', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    let releaseFirstResult = (): void => undefined;
    const heldFirstResult = new Promise<void>((resolve) => {
      releaseFirstResult = resolve;
    });
    let firstResultSeen = (): void => undefined;
    const firstResult = new Promise<void>((resolve) => {
      firstResultSeen = resolve;
    });
    let holdFirst = true;
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sdkSessionId: 'known-thread',
      },
      (event) => {
        if (
          holdFirst &&
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'result'
        ) {
          holdFirst = false;
          firstResultSeen();
          return heldFirstResult;
        }
      },
      () => null,
    );
    try {
      session.sendMessage('First');
      await firstResult;
      session.sendMessage('Second');
      await flushMicrotasks();
      expect(startTurnMock).toHaveBeenCalledTimes(1);
      releaseFirstResult();
      await flushMicrotasks();
      expect(startTurnMock).toHaveBeenCalledTimes(2);
    } finally {
      releaseFirstResult();
      await session.destroy();
    }
  });

  it('does not emit a duplicate terminal when Codex result admission rejects', async () => {
    startTurnMock.mockResolvedValue({ status: 'completed' });
    let rejectResult: (error: Error) => void = () => undefined;
    const resultAdmission = new Promise<void>((_, reject) => {
      rejectResult = reject;
    });
    // The test owns this deferred rejection independently of the session.
    void resultAdmission.catch(() => undefined);
    let resultSeen = (): void => undefined;
    const observed = new Promise<void>((resolve) => {
      resultSeen = resolve;
    });
    const events: unknown[] = [];
    const provider = new CodexProvider();
    const session = provider.createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sdkSessionId: 'known-thread',
      },
      (event) => {
        events.push(event);
        if (
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'result'
        ) {
          resultSeen();
          return resultAdmission;
        }
      },
      () => null,
    );
    try {
      session.sendMessage('First');
      await observed;
      rejectResult(new Error('route admission failed'));
      await expect(session.destroy()).rejects.toThrow('route admission failed');
      expect(
        events.filter(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'result',
        ),
      ).toHaveLength(1);
    } finally {
      rejectResult(new Error('test cleanup'));
      await session.destroy().catch(() => undefined);
    }
  });

  describe('Ledger tools', () => {
    const LEDGER_BLOCK = 'Ledger block for this session.';
    const HINT = '<feed_assignments>changed</feed_assignments>';
    const LEDGER_TOOL_NAMES = [
      'canopy_add_feed_entry',
      'canopy_search_feed_entries',
      'canopy_update_feed_entry',
    ];

    function fakeLedgerSession(): {
      systemPrompt: jest.Mock<string, []>;
      assignmentHint: jest.Mock<Promise<string | undefined>, []>;
      dispose: jest.Mock<void, []>;
      execute: jest.Mock<Promise<{ text: string }>, unknown[]>;
    } {
      return {
        systemPrompt: jest.fn(() => LEDGER_BLOCK),
        assignmentHint: jest.fn(() => Promise.resolve(HINT)),
        dispose: jest.fn<void, []>(),
        execute: jest.fn(() => Promise.resolve({ text: '{"ok":true}' })),
      };
    }

    function clientToolNames(index = 0): string[] {
      const args = jest.mocked(CodexAppServerClient).mock.calls[index]?.[0];
      return (args?.dynamicTools ?? []).map((tool) => tool.name);
    }

    beforeEach(() => {
      mockMayExposeLedgerTools.mockReturnValue(false);
      mockOpenLedgerChatTools.mockResolvedValue(null);
      mockReadCapabilityLease.mockReset();
      mockReadCapabilityLease.mockResolvedValue(null);
      startTurnMock.mockResolvedValue({ status: 'completed' });
    });

    it('starts the thread with the Ledger tools, prompt and Plan mode exception of an exposed session', async () => {
      const ledger = fakeLedgerSession();
      mockMayExposeLedgerTools.mockReturnValue(true);
      mockOpenLedgerChatTools.mockResolvedValue(ledger);
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'ledger-chat',
          systemPromptAppend: 'System appendix',
          model: 'gpt-5.4',
          thinkingLevel: 'high',
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('Do the work');
      await flush();
      await flush();

      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(clientToolNames()).toEqual(
        expect.arrayContaining(LEDGER_TOOL_NAMES),
      );
      expect(clientArgs?.developerInstructions).toContain('System appendix');
      expect(clientArgs?.developerInstructions).toContain(LEDGER_BLOCK);
      expect(clientArgs?.planModeDeveloperInstructionsAddendum).toBe(
        buildLedgerPlanModeInstruction('codex'),
      );
      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: `${HINT}\n\nDo the work` }),
      );
      const [options] = mockOpenLedgerChatTools.mock.calls[0] ?? [];
      expect(options?.harness).toBe('codex');
      expect(options?.target).toMatchObject({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'ledger-chat',
      });
      expect(options?.readSettings()).toEqual({
        model: 'gpt-5.4',
        thinkingEffort: 'high',
        planMode: false,
      });

      // A new thread starts with the tools, so no record is consulted.
      expect(mockReadCapabilityLease).not.toHaveBeenCalled();

      await session.destroy();
      expect(ledger.dispose).toHaveBeenCalled();
    });

    it('omits the Ledger tools, prompt and exception for a session that is not exposed', async () => {
      mockMayExposeLedgerTools.mockReturnValue(true);
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'ledger-off',
          systemPromptAppend: 'System appendix',
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('Do the work');
      await flush();
      await flush();

      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      for (const name of LEDGER_TOOL_NAMES) {
        expect(clientToolNames()).not.toContain(name);
      }
      expect(clientArgs?.developerInstructions).not.toContain(LEDGER_BLOCK);
      expect(clientArgs?.planModeDeveloperInstructionsAddendum).toBeUndefined();
      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Do the work' }),
      );

      await session.destroy();
    });

    it('decides once per session, so a client created after idle release keeps its Ledger tools', async () => {
      jest.useFakeTimers();
      const ledger = fakeLedgerSession();
      mockMayExposeLedgerTools.mockReturnValue(true);
      mockOpenLedgerChatTools.mockResolvedValue(ledger);
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'ledger-idle',
          codexAppServerIdleTimeoutMinutes: 1,
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('First');
      await flushMicrotasks();
      await flushMicrotasks();
      // A later gate change must not add or drop tools on this session.
      mockMayExposeLedgerTools.mockReturnValue(false);
      jest.advanceTimersByTime(60_000);
      session.sendMessage('After idle release');
      await flushMicrotasks();
      await flushMicrotasks();

      expect(jest.mocked(CodexAppServerClient).mock.calls).toHaveLength(2);
      expect(clientToolNames(1)).toEqual(
        expect.arrayContaining(LEDGER_TOOL_NAMES),
      );
      expect(mockOpenLedgerChatTools).toHaveBeenCalledTimes(1);
      await session.destroy();
    });

    it('runs a Ledger call in a Plan mode turn through the approval gate and the session runtime', async () => {
      const ledger = fakeLedgerSession();
      mockMayExposeLedgerTools.mockReturnValue(true);
      mockOpenLedgerChatTools.mockResolvedValue(ledger);
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'ledger-plan',
          planMode: true,
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('Plan the work');
      await flush();
      await flush();
      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      const args = {
        type: 'TASK',
        title: 'Planned',
        content: 'While planning.',
      };
      const response = await clientArgs?.dynamicToolCallHandler?.({
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call',
        namespace: null,
        tool: 'canopy_add_feed_entry',
        arguments: args,
      });

      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ planMode: true }),
      );
      expect(approvalCheckMock).toHaveBeenCalledWith(
        { kind: 'tool', toolName: 'canopy_add_feed_entry' },
        expect.anything(),
      );
      expect(ledger.execute).toHaveBeenCalledWith('add_ledger_entry', args, {
        invocationId: 'codex:thread:turn:call',
      });
      expect(response).toEqual({
        contentItems: [{ type: 'inputText', text: '{"ok":true}' }],
        success: true,
      });
      await session.destroy();
    });

    it('refuses a Ledger tool a resumed thread kept when its session is not exposed', async () => {
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'ledger-resumed',
          sdkSessionId: 'thread-started-with-ledger-tools',
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('Continue');
      await flush();
      await flush();
      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      const response = await clientArgs?.dynamicToolCallHandler?.({
        threadId: 'thread-started-with-ledger-tools',
        turnId: 'turn',
        callId: 'call',
        namespace: null,
        tool: 'canopy_search_feed_entries',
        arguments: {},
      });

      expect(clientArgs?.initialThreadId).toBe(
        'thread-started-with-ledger-tools',
      );
      expect(response?.success).toBe(false);
      expect(JSON.stringify(response?.contentItems)).toContain(
        'FEED_UNAVAILABLE',
      );
      await session.destroy();
    });

    it('treats a resumed thread without a capability record as not exposed', async () => {
      const ledger = fakeLedgerSession();
      mockMayExposeLedgerTools.mockReturnValue(true);
      mockOpenLedgerChatTools.mockResolvedValue(ledger);
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'ledger-legacy-thread',
          sdkSessionId: 'thread-before-capability-records',
          systemPromptAppend: 'System appendix',
          planMode: true,
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('Continue');
      await flush();
      await flush();

      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(mockReadCapabilityLease).toHaveBeenCalledWith(
        'thread-before-capability-records',
      );
      expect(clientArgs?.initialThreadId).toBe(
        'thread-before-capability-records',
      );
      expect(mockOpenLedgerChatTools).not.toHaveBeenCalled();
      for (const name of LEDGER_TOOL_NAMES) {
        expect(clientToolNames()).not.toContain(name);
      }
      expect(clientArgs?.developerInstructions).toContain('System appendix');
      expect(clientArgs?.developerInstructions).not.toContain(LEDGER_BLOCK);
      expect(clientArgs?.planModeDeveloperInstructionsAddendum).toBeUndefined();
      expect(ledger.assignmentHint).not.toHaveBeenCalled();
      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Continue', planMode: true }),
      );
      await session.destroy();
    });

    it('keeps the Ledger tools, prompt and hint for a resumed thread with a capability record', async () => {
      const ledger = fakeLedgerSession();
      mockMayExposeLedgerTools.mockReturnValue(true);
      mockOpenLedgerChatTools.mockResolvedValue(ledger);
      mockReadCapabilityLease.mockResolvedValue({
        threadId: 'thread-with-record',
        snapshotId: 'snapshot',
      });
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'ledger-recorded-thread',
          sdkSessionId: 'thread-with-record',
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('Continue');
      await flush();
      await flush();

      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(mockReadCapabilityLease).toHaveBeenCalledWith(
        'thread-with-record',
      );
      expect(clientArgs?.initialThreadId).toBe('thread-with-record');
      expect(clientToolNames()).toEqual(
        expect.arrayContaining(LEDGER_TOOL_NAMES),
      );
      expect(clientArgs?.developerInstructions).toContain(LEDGER_BLOCK);
      expect(clientArgs?.planModeDeveloperInstructionsAddendum).toBe(
        buildLedgerPlanModeInstruction('codex'),
      );
      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: `${HINT}\n\nContinue` }),
      );
      await session.destroy();
      expect(ledger.dispose).toHaveBeenCalled();
    });

    it('treats an unreadable capability record as absent', async () => {
      mockMayExposeLedgerTools.mockReturnValue(true);
      mockOpenLedgerChatTools.mockResolvedValue(fakeLedgerSession());
      mockReadCapabilityLease.mockRejectedValue(new Error('corrupt record'));
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'ledger-unreadable-record',
          sdkSessionId: 'thread-with-unreadable-record',
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('Continue');
      await flush();
      await flush();

      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      expect(mockOpenLedgerChatTools).not.toHaveBeenCalled();
      for (const name of LEDGER_TOOL_NAMES) {
        expect(clientToolNames()).not.toContain(name);
      }
      expect(clientArgs?.developerInstructions ?? '').not.toContain(
        LEDGER_BLOCK,
      );
      expect(startTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Continue' }),
      );
      await session.destroy();
    });

    it('applies the execution gate when the Ledger turns off during a session', async () => {
      const host: LedgerToolsHost = {
        dispatcher: () => null,
        registry: () => ({
          register: (): string => 'binding',
          resolve: (): undefined => undefined,
          revoke: (): boolean => false,
        }),
        isFlagEnabled: () => false,
        isRecordingEnabled: () => Promise.resolve(true),
        workspaceType: () => 'single-repo',
        containerCreatedAt: () => Promise.resolve('2026-09-01T00:00:00.000Z'),
        chatTitle: () => Promise.resolve(null),
        databaseMayExist: () => Promise.resolve(false),
      };
      mockMayExposeLedgerTools.mockReturnValue(true);
      mockOpenLedgerChatTools.mockImplementation((options) =>
        Promise.resolve(
          new LedgerChatToolsSession({
            ...options,
            harness: 'codex',
            scope: {
              container: {
                kind: 'code_worktree',
                workspaceId: 'project',
                worktreeId: 'worktree',
              },
              containerCreatedAt: '2026-09-01T00:00:00.000Z',
            },
            host,
          }),
        ),
      );
      const session = new CodexProvider().createSession(
        {
          cwd: '/tmp/repo',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'ledger-flag-off',
        },
        jest.fn(),
        () => null,
      );

      session.sendMessage('Record this');
      await flush();
      await flush();
      const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
      const response = await clientArgs?.dynamicToolCallHandler?.({
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call',
        namespace: null,
        tool: 'canopy_add_feed_entry',
        arguments: { type: 'TASK', title: 'T', content: 'C' },
      });

      expect(clientToolNames()).toEqual(
        expect.arrayContaining(LEDGER_TOOL_NAMES),
      );
      expect(response?.success).toBe(false);
      expect(JSON.stringify(response?.contentItems)).toContain(
        'ledger_disabled',
      );
      await session.destroy();
    });

    describe('App Advisor', () => {
      const ADVISOR_NAMES = getAppAdvisorLedgerToolNames('codex');
      const ADVISOR_LEDGER_TOOL_NAMES = [
        ADVISOR_NAMES.add,
        ADVISOR_NAMES.search,
        ADVISOR_NAMES.update,
      ];

      function createAdvisorSession(
        overrides: { chatId?: string; sdkSessionId?: string } = {},
      ): ReturnType<CodexProvider['createSession']> {
        return new CodexProvider().createSession(
          {
            cwd: '/tmp/advisor',
            projectId: 'app-advisor',
            worktreeId: 'entry-1',
            chatId: overrides.chatId ?? 'advisor-chat',
            assistantMode: 'app-advisor',
            appAdvisorRuntime: createAppAdvisorRuntimeFixture(),
            systemPromptAppend: 'Advisor prompt.',
            ...(overrides.sdkSessionId
              ? { sdkSessionId: overrides.sdkSessionId }
              : {}),
          },
          jest.fn(),
          () => null,
        );
      }

      it('starts the thread with the Advisor-named Ledger tools, prompt and hint of an exposed session', async () => {
        const ledger = fakeLedgerSession();
        mockMayExposeLedgerTools.mockReturnValue(true);
        mockOpenLedgerChatTools.mockResolvedValue(ledger);
        const session = createAdvisorSession();

        session.sendMessage('Inspect the app');
        await flush();
        await flush();

        const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
        const names = clientToolNames();
        expect(names).toEqual(
          expect.arrayContaining([
            ...ADVISOR_LEDGER_TOOL_NAMES,
            APP_ADVISOR_TOOL_REGISTRY.dispatch_action.codexToolName,
          ]),
        );
        for (const name of LEDGER_TOOL_NAMES) {
          expect(names).not.toContain(name);
        }
        expect(clientArgs?.developerInstructions).toContain('Advisor prompt.');
        expect(clientArgs?.developerInstructions).toContain(LEDGER_BLOCK);
        expect(clientArgs?.planModeDeveloperInstructionsAddendum).toBe(
          buildLedgerPlanModeInstruction('codex', ADVISOR_NAMES),
        );
        expect(startTurnMock).toHaveBeenCalledWith(
          expect.objectContaining({ text: `${HINT}\n\nInspect the app` }),
        );
        const [options] = mockOpenLedgerChatTools.mock.calls[0] ?? [];
        expect(options?.target).toEqual({
          projectId: 'app-advisor',
          worktreeId: 'entry-1',
          chatId: 'advisor-chat',
          assistantMode: 'app-advisor',
        });
        expect(options?.harness).toBe('codex');
        expect(options?.toolNames).toEqual(ADVISOR_NAMES);

        await session.destroy();
        expect(ledger.dispose).toHaveBeenCalled();
      });

      it('runs an Advisor Ledger call through the approval gate and the session runtime', async () => {
        const ledger = fakeLedgerSession();
        mockMayExposeLedgerTools.mockReturnValue(true);
        mockOpenLedgerChatTools.mockResolvedValue(ledger);
        const session = createAdvisorSession({ chatId: 'advisor-call' });

        session.sendMessage('Record this');
        await flush();
        await flush();
        const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
        const args = { type: 'TASK', title: 'Plan', content: 'Plan it.' };
        const response = await clientArgs?.dynamicToolCallHandler?.({
          threadId: 'thread',
          turnId: 'turn',
          callId: 'call',
          namespace: null,
          tool: ADVISOR_NAMES.add,
          arguments: args,
        });

        expect(approvalCheckMock).toHaveBeenCalledWith(
          { kind: 'tool', toolName: ADVISOR_NAMES.add },
          expect.anything(),
        );
        expect(ledger.execute).toHaveBeenCalledWith('add_ledger_entry', args, {
          invocationId: 'codex:thread:turn:call',
        });
        expect(response).toEqual({
          contentItems: [{ type: 'inputText', text: '{"ok":true}' }],
          success: true,
        });
        await session.destroy();
      });

      it('omits the Advisor Ledger tools and prompt for a session that is not exposed', async () => {
        mockMayExposeLedgerTools.mockReturnValue(true);
        const session = createAdvisorSession({ chatId: 'advisor-off' });

        session.sendMessage('Inspect the app');
        await flush();
        await flush();

        const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
        for (const name of [
          ...ADVISOR_LEDGER_TOOL_NAMES,
          ...LEDGER_TOOL_NAMES,
        ]) {
          expect(clientToolNames()).not.toContain(name);
        }
        expect(clientToolNames()).toContain(
          APP_ADVISOR_TOOL_REGISTRY.dispatch_action.codexToolName,
        );
        expect(clientArgs?.developerInstructions).toContain('Advisor prompt.');
        expect(clientArgs?.developerInstructions).not.toContain(LEDGER_BLOCK);
        expect(
          clientArgs?.planModeDeveloperInstructionsAddendum,
        ).toBeUndefined();
        const response = await clientArgs?.dynamicToolCallHandler?.({
          threadId: 'thread',
          turnId: 'turn',
          callId: 'call',
          namespace: null,
          tool: ADVISOR_NAMES.search,
          arguments: {},
        });
        expect(response?.success).toBe(false);
        expect(JSON.stringify(response?.contentItems)).toContain(
          'no_ledger_scope',
        );
        await session.destroy();
      });

      it('treats a resumed Advisor thread without a capability record as not exposed', async () => {
        const ledger = fakeLedgerSession();
        mockMayExposeLedgerTools.mockReturnValue(true);
        mockOpenLedgerChatTools.mockResolvedValue(ledger);
        const session = createAdvisorSession({
          chatId: 'advisor-legacy-thread',
          sdkSessionId: 'advisor-thread-before-capability-records',
        });

        session.sendMessage('Continue');
        await flush();
        await flush();

        const clientArgs = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
        expect(mockReadCapabilityLease).toHaveBeenCalledWith(
          'advisor-thread-before-capability-records',
        );
        expect(mockOpenLedgerChatTools).not.toHaveBeenCalled();
        for (const name of ADVISOR_LEDGER_TOOL_NAMES) {
          expect(clientToolNames()).not.toContain(name);
        }
        expect(clientArgs?.developerInstructions).not.toContain(LEDGER_BLOCK);
        expect(ledger.assignmentHint).not.toHaveBeenCalled();
        await session.destroy();
      });
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
