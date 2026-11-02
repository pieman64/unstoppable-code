/**
 * Test-only driver for real main-process chat pipelines. Keep provider/session,
 * routing, queue, and durable chat state real; only external leaves are
 * sandboxed by `installPipelineBootstrap` before they are dynamically loaded.
 * `createPipelineHarness({ now?, tap?, prepareStorage? })`
 * creates isolated V2 storage and a logical clock. Use
 * `harness.host(kind, provider, target)`
 * for the real host adapter, and `holdCommits` / `holdDrainBarrier` to control
 * async boundaries; advance timers with `advanceLogicalClock` instead of
 * waiting on wall time.
 */
import { createHash, randomUUID } from 'node:crypto';
import type * as ApprovalPersistenceModule from '../../lib/approvals-persistence';
import type * as BackgroundHelperQueueModule from '../../lib/background-helper-queue';
import type * as PreferencesStoreModule from '../../lib/preferences-store';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type * as FsPromisesModule from 'node:fs/promises';
import type {
  ChatQueueTarget,
  ChatSendMessageRequest,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import type {
  PipelineChatRegistration,
  PipelineChatTarget,
  PipelineEffect,
  PipelineHarness,
  PipelineHost,
  PipelineHostAdapter,
  PipelineHostOptions,
  PipelineProvider,
  RevisionChatView,
  PipelineTraceEvent,
  PipelineTraceInput,
  PipelineTraceRecorder,
} from './contracts';
import { createPipelineStorage } from './storage';
import type { ChatStateCommit } from '../../services/chat-state-contracts';
import type {
  ChatQueueService,
  ChatQueueServiceDependencies,
} from '../../services/chat-queue-service';
import type { PipelineStorage } from './storage';
import type { SessionDiagnosticRecord } from '../../observability/service';
import type { ChatEventDrop } from '../../lib/chat-event-drop-diagnostics';
import type { EndedTurn } from '../../lib/turn-diff-capture';

// Bootstrap modules are cached across sequential scenarios. Resolve the active
// sink at call time rather than retaining the first scenario's recorder.
let activeDiagnosticSink:
  | ((record: SessionDiagnosticRecord) => void)
  | undefined;
let activeTerminalEffectSink:
  | ((
      effect: 'turn-diff' | 'code-review',
      identity: string,
      turn?: EndedTurn,
    ) => void)
  | undefined;
let activeBaselineSink: ((identity: string) => void) | undefined;
// Sessions with a turn-diff baseline. Production's end capture returns null
// without one (Cowork and App Advisor chats), so it captures nothing.
const turnDiffBaselines = new Set<string>();

export interface CreatePipelineHarnessOptions {
  /** Initial logical time used by the real chat service and queue. */
  now?: number;
  /** Optional observer. Errors are contained until dispose, after teardown. */
  tap?: (event: PipelineTraceEvent) => void;
  /** Seed storage before any service or repository loads a target scope. */
  prepareStorage?: (storage: PipelineStorage) => Promise<void>;
  readCreditFunding?: ChatQueueServiceDependencies['readCreditFunding'];
}

interface Registration {
  target: PipelineChatTarget;
  options: PipelineChatRegistration;
}

interface TimerEntry {
  handle: ReturnType<typeof setTimeout>;
  dueAt: number;
  callback: () => void;
  cancelled: boolean;
}

interface TranscriptCapture {
  bytes: Buffer;
  sha256: string;
}

interface WatcherSinkContext {
  target: PipelineChatTarget;
  callId: string;
  renamed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function targetKey(target: PipelineChatTarget): string {
  return `${target.projectId}\u0000${target.worktreeId}\u0000${target.chatId}`;
}

function scopeKey(target: { projectId: string; worktreeId: string }): string {
  return `${target.projectId}\u0000${target.worktreeId}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value))
    return value;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => {
      deepFreeze(item, seen);
    });
  } else if (value instanceof Map) {
    Array.from(value.entries()).forEach(([key, item]) => {
      deepFreeze(key, seen);
      deepFreeze(item, seen);
    });
  } else if (value instanceof Set) {
    Array.from(value.values()).forEach((item) => {
      deepFreeze(item, seen);
    });
  } else {
    Object.values(value).forEach((item) => {
      deepFreeze(item, seen);
    });
  }
  return Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
  // Clone before freezing: trace consumers must never freeze queue/provider
  // objects that production may continue mutating after publication.
  return deepFreeze(structuredClone(value));
}

class PipelineRecorder implements PipelineTraceRecorder {
  private readonly recorded: PipelineTraceEvent[] = [];
  private readonly tapErrors: unknown[] = [];
  private sequence = 0;

  public constructor(
    private readonly logicalNow: () => number,
    private readonly tap?: (event: PipelineTraceEvent) => void,
  ) {}

  public get events(): readonly PipelineTraceEvent[] {
    return this.recorded;
  }

  public record(input: PipelineTraceInput): void {
    try {
      const cloned = structuredClone(input);
      const event: PipelineTraceEvent = deepFreeze({
        ...cloned,
        seq: ++this.sequence,
        at: performance.now(),
        logicalAt: this.logicalNow(),
      });
      this.recorded.push(event);
      this.tap?.(event);
    } catch (error) {
      this.tapErrors.push(error);
    }
  }

  public firstTapError(): unknown {
    return this.tapErrors[0];
  }

  public hasTapFailures(): boolean {
    return this.tapErrors.length > 0;
  }

  public captureFailed(error: unknown): void {
    this.tapErrors.push(error);
  }
}

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/explicit-function-return-type, @typescript-eslint/consistent-type-imports */
function installPipelineBootstrap(): void {
  // The SDK is deliberately not installed here. Scenario authors install the
  // scripted SDK mock before factory invocation, and this bootstrap preserves
  // that caller-owned mock while replacing only credential-dependent leaves.
  jest.doMock('../../auth/provider-auth-state', () => {
    const authenticated = async (): Promise<boolean> => true;
    const availability = (): {
      claude: boolean;
      codex: boolean;
      ollama: boolean;
    } => ({ claude: true, codex: true, ollama: true });
    const authStatus = async () => ({
      authenticated: true,
      accountLabel: null,
      detail: null,
      error: null,
      accountKind: 'api_key',
      authFingerprint: null,
    });
    return {
      ensureProviderAuthBaselineForSession: jest.fn(authenticated),
      isProviderNativelyAuthenticated: jest.fn(authenticated),
      isProviderNativelyAuthenticatedForRouting: jest.fn(authenticated),
      peekProviderNativeAuthAvailability: jest.fn(availability),
      peekFreshProviderNativeAuthAvailability: jest.fn(async () =>
        availability(),
      ),
      peekPortalProviderAvailability: jest.fn(availability),
      peekProviderAccountIdentity: jest.fn(() => null),
      getCachedClaudeAuthStatusObserved: jest.fn(authStatus),
    };
  });

  // Provider routing is disabled in the harness. In particular, do not load
  // the real account, credential, preferences, workspace-owner, or gateway
  // stores: their purpose is outside these pipeline tests and may touch user
  // data or secret-bearing configuration.
  jest.doMock('../../agents/ai-credits-routing', () => ({
    resolveAiCreditsRoutingActivation: (): null => null,
    isAiCreditsChosenOverAccountProxy: (): boolean => false,
    resolveAiCreditsRoutingAttempt: async (): Promise<null> => null,
    resolveSessionAiCreditsAttribution: async (): Promise<
      Record<string, never>
    > => ({}),
    resolveAiCreditsAttribution: async (): Promise<
      Record<string, never>
    > => ({}),
    emitAiCreditsRoutingStatus: (): void => undefined,
    emitAiCreditsUsageLimitReached: (): void => undefined,
    emitAiCreditsNoBillingSource: (): void => undefined,
    getAiCreditsRoutingContext: async (): Promise<null> => null,
    getAiCreditsRoutingContextWithStatus: async (): Promise<{
      context: null;
      status: 'unavailable';
    }> => ({ context: null, status: 'unavailable' }),
    hasUserSuppliedProviderCredential: (): boolean => false,
    resolveGatewayModelEntry: (): null => null,
    resolveOrgGatewayCredential: async (): Promise<null> => null,
    markOrgGatewayCredentialRejected: async (): Promise<void> => undefined,
    buildClaudeProxyEnv: (): Record<string, never> => ({}),
    buildClaudeProxyEnvForBaseUrl: (): Record<string, never> => ({}),
    buildBrokeredOrgGatewayClaudeEnv: async (): Promise<
      Record<string, never>
    > => ({}),
    buildCodexProxyConfig: (): Record<string, never> => ({}),
    buildCodexProxyConfigObject: (): Record<string, never> => ({}),
    buildProxyBaseUrl: (): string => 'http://127.0.0.1:0',
    buildOrgGatewayCodexBaseUrl: (): string => 'http://127.0.0.1:0',
  }));

  jest.doMock('../../agents/work-owner', () => ({
    captureSessionWorkOwner: (): void => undefined,
    peekSessionWorkOwner: (): { kind: 'personal' } => ({ kind: 'personal' }),
    resolveBackgroundWorkOwner: async (): Promise<{ kind: 'personal' }> => ({
      kind: 'personal',
    }),
    resolveEnforcementOwner: (owner: unknown): unknown => owner,
    resolveInvocationWorkOwner: async (): Promise<{ kind: 'personal' }> => ({
      kind: 'personal',
    }),
    resolveNavigationWorkOwner: async (): Promise<{ kind: 'personal' }> => ({
      kind: 'personal',
    }),
    resolveSessionWorkOwner: async (): Promise<{ kind: 'personal' }> => ({
      kind: 'personal',
    }),
    resolveAiCreditsScopeOwner: async (): Promise<{ kind: 'personal' }> => ({
      kind: 'personal',
    }),
    shouldRecordUnknownEnforcementOwner: (): boolean => false,
    __resetSessionWorkOwnersForTests: (): void => undefined,
  }));

  // Keep helper summaries deterministic and offline. This is a leaf override:
  // other utility exports remain the real production implementations.
  jest.doMock('../../agents/utils', () => {
    const actual =
      jest.requireActual<typeof import('../../agents/utils')>(
        '../../agents/utils',
      );
    return {
      ...actual,
      generateChatSummary: (
        userMessage: string,
      ): ReturnType<typeof actual.generateChatSummary> =>
        Promise.resolve({
          text: userMessage.slice(0, 100),
          usage: {},
          fallback: { reason: 'pipeline harness disables helper generation' },
        }),
    };
  });

  jest.doMock('../../pipelines/config-paths', () => ({
    getBundledClaudeBinaryPath: (): string => '/pipeline-harness/claude',
    getBundledCodexBinaryPath: (): string => '/pipeline-harness/codex',
    getBundledRtkBinaryPath: (): string => '/pipeline-harness/rtk',
    getBundledRgBinaryPath: (): string => '/pipeline-harness/rg',
    getBundledBinDir: (): string => '/pipeline-harness/bin',
    getEnhancedEnv: (): Record<string, never> => ({}),
    getRtkManagedEnv: (): Record<string, never> => ({}),
    getLoginShellPath: (): string => '/usr/bin:/bin',
    getRtkDataDir: (): string => '/pipeline-harness/rtk-data',
    getRtkDbPath: (): string => '/pipeline-harness/rtk-data/index.db',
  }));

  jest.doMock('@canopy/desktop-shared/pipelines/config-paths', () => ({
    getBundledClaudeBinaryPath: (): string => '/pipeline-harness/claude',
    getBundledCodexBinaryPath: (): string => '/pipeline-harness/codex',
    getBundledRtkBinaryPath: (): string => '/pipeline-harness/rtk',
    getBundledRgBinaryPath: (): string => '/pipeline-harness/rg',
    getBundledBinDir: (): string => '/pipeline-harness/bin',
    getEnhancedEnv: (): Record<string, never> => ({}),
    getRtkManagedEnv: (): Record<string, never> => ({}),
    getLoginShellPath: (): string => '/usr/bin:/bin',
    listMissingBundledBinaries: (): Array<never> => [],
  }));

  jest.doMock('../../ollama/claude-compatible', () => ({
    resolveClaudeCompatibleInvocation: async (
      model: string | undefined,
    ): Promise<{ providerType: 'claude'; sdkModel?: string }> => ({
      providerType: 'claude',
      ...(model ? { sdkModel: model } : {}),
    }),
  }));

  jest.doMock('../../ollama/codex-compatible', () => ({
    resolveCodexCompatibleOllamaInvocation: async (
      model: string | undefined,
    ): Promise<{
      runtimeModel: string | undefined;
      envOverride: Record<string, never>;
      codexConfig: Record<string, never>;
    }> => ({
      runtimeModel: model,
      envOverride: {},
      codexConfig: {},
    }),
  }));

  jest.doMock('../../lib/e2e-mock-control-plane', () => ({
    getMockLlmOrigin: (): undefined => undefined,
  }));

  jest.doMock('../../power/wake-lock-service', () => {
    const actual = jest.requireActual<
      typeof import('../../power/wake-lock-service')
    >('../../power/wake-lock-service');
    const wakeLock = new actual.WakeLockService({
      platform: 'linux',
      powerSaveBlocker: null,
      recordDiagnostic: (): void => undefined,
    });
    return { ...actual, getWakeLockService: (): typeof wakeLock => wakeLock };
  });

  // Observability is an external leaf; keep provider/session and chat services
  // real while preventing writes to the application event store.
  jest.doMock('../../observability', () => ({
    getObservabilityService: (): Record<string, () => void> =>
      new Proxy(
        {},
        {
          get: (_target, property) =>
            property === 'then'
              ? undefined
              : property === 'recordSessionDiagnostic'
                ? (record: SessionDiagnosticRecord): void =>
                    activeDiagnosticSink?.(record)
                : (): void => undefined,
        },
      ),
  }));

  jest.doMock('../../lib/main-process-logging', () => ({
    logMainProcessError: (): void => undefined,
    logMainProcessWarn: (): void => undefined,
    logMainProcessInfo: (): void => undefined,
    logMainProcessDebug: (): void => undefined,
  }));

  jest.doMock('../../lib/canopy-cloud-account-store', () => ({
    getCanopyCloudCredentials: () => Promise.resolve(null),
    peekCanopyCloudAccount: () => null,
    subscribeCanopyCloudAccountChanges: () => () => undefined,
  }));
  jest.doMock('../../lib/model-policy-state', () => ({
    isModelBlockedByStoredPolicy: () => Promise.resolve(false),
  }));
  jest.doMock('../../lib/model-gateway-state', () => ({
    checkModelGatewayRoute: () =>
      Promise.resolve({ ok: true, orgRoute: false }),
  }));
  jest.doMock('../../agents/agent-model-runtime', () => ({
    resolveAgentModelRuntime: (options: {
      model: string;
      providerType?: string;
      systemPromptAppend?: string;
      pluginSelections?: unknown;
    }) =>
      Promise.resolve({
        selectedModel: options.model,
        runtimeModel: options.model,
        providerType: options.providerType ?? 'claude',
        executionHarness: options.providerType ?? 'claude',
        systemPromptAppend: options.systemPromptAppend,
        pluginSelections: options.pluginSelections,
      }),
  }));
  jest.doMock('../../resource-monitor', () => ({
    getResourceMonitorService: () => ({
      reserveChatTurnStart: () => Promise.resolve({ release: () => undefined }),
      // The Codex runtime host registers its app-server process here.
      registerProcess: () => ({
        update: () => undefined,
        unregister: () => undefined,
      }),
    }),
    disposeResourceMonitorService: () => undefined,
  }));

  jest.doMock('../../lib/preferences-store', () => {
    const actual = jest.requireActual<typeof PreferencesStoreModule>(
      '../../lib/preferences-store',
    );
    return {
      ...actual,
      readPreferencesFile: () => Promise.resolve(actual.DEFAULT_PREFERENCES),
      peekPreferencesLoadError: () => null,
      readLatestPreferencesFile: () =>
        Promise.resolve(actual.DEFAULT_PREFERENCES),
      readLocalMemoryEnabledPreference: () => Promise.resolve(false),
    };
  });
  jest.doMock('../../lib/approvals-persistence', () => {
    const actual = jest.requireActual<typeof ApprovalPersistenceModule>(
      '../../lib/approvals-persistence',
    );
    return {
      ...actual,
      readWorkspaceApprovalsResult:
        (): Promise<ApprovalPersistenceModule.WorkspaceApprovalsReadResult> =>
          Promise.resolve({
            status: 'missing',
            file: { version: 1, rules: [] },
          }),
    };
  });
  jest.doMock('../../lib/workspace-approvals-manifest', () => ({
    readWorkspaceApprovalsManifest: (): Promise<{ rules: [] }> =>
      Promise.resolve({ rules: [] }),
  }));
  jest.doMock('../../plugins/plugin-resolver', () => ({
    resolvePlugins: () =>
      Promise.resolve({
        sdkPlugins: [],
        skillPluginDir: null,
        selectedCapabilityRoots: [],
        mcpServerBindings: {},
        cursorNotices: [],
        codexMcpServers: {},
        mcpServers: {},
        warnings: [],
      }),
    cleanupWorktreeChatPluginDirs: () => Promise.resolve(),
    resolveEffectivePluginSelectionRefs: () =>
      Promise.resolve({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      }),
    codexAggregateSkillInvocationNamesForRefs: () => [],
  }));
  jest.doMock('../../plugins/global-plugin-overlay', () => ({
    resolveBackgroundChatPluginSelections: (
      local: ChatTabPluginSelections | undefined,
    ) => Promise.resolve(local),
    resolveEffectiveChatPluginContext: (selections: unknown) =>
      Promise.resolve({
        selections: selections ?? {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      }),
  }));
  jest.doMock('../../plugins/invocable-inventory-service', () => ({
    loadCachedInventory: () => Promise.resolve(null),
  }));
  jest.doMock('../../mcp/http-proxy-service', () => ({
    getMcpHttpProxyService: () => ({
      registerCanopyWorktreeSessionRoute: () =>
        Promise.resolve('scripted-token'),
      unregisterCanopyWorktreeSessionRoute: () => undefined,
      unregisterRoutesForSession: () => undefined,
      getCodexCapabilityAuthorityIds: () => [],
      getCanopyWorktreeMcpUrl: () => 'http://scripted.invalid/mcp',
      getCanopyWorktreeUiMcpUrl: () => 'http://scripted.invalid/ui',
    }),
  }));
  jest.doMock('../../memory/local/policy', () => ({
    resolveLocalMemoryPolicy: () =>
      Promise.resolve({ kind: 'none', privateMemory: false }),
  }));
  jest.doMock('../../memory/local/prepare', () => ({
    prepareLocalMemoryContext: () => Promise.resolve(null),
  }));
  jest.doMock('../../lib/code-graph-availability', () => ({
    isCodeGraphAvailableForWorkspace: () => false,
  }));
  jest.doMock('../../lib/worktree-summary-scheduler', () => ({
    scheduleSummaryGeneration: () => undefined,
  }));
  // Title and branch-name helpers are outside the pipeline, and the real
  // queue's delayed drain would run them after Jest tears the file down.
  jest.doMock('../../lib/background-helper-queue', () => ({
    ...jest.requireActual<typeof BackgroundHelperQueueModule>(
      '../../lib/background-helper-queue',
    ),
    enqueueBackgroundHelperTask: () => new Promise<never>(() => undefined),
  }));
  jest.doMock('../../lib/code-graph-scheduler', () => ({
    scheduleCodeGraphBuild: () => undefined,
  }));
  jest.doMock('../../lib/code-review-scheduler', () => ({
    noteCodeReviewTurnEnd: (identity: string): void =>
      activeTerminalEffectSink?.('code-review', identity),
    noteCodeReviewTurnStart: () => undefined,
    noteWorktreeActivityForCodeReview: () => undefined,
  }));
  jest.doMock('../../lib/turn-diff-capture', () => ({
    captureTurnStart: (identity: string): Promise<void> => {
      turnDiffBaselines.add(identity);
      activeBaselineSink?.(identity);
      return Promise.resolve();
    },
    discardTurnStart: (identity: string): void => {
      turnDiffBaselines.delete(identity);
    },
    captureTurnEndAndDiff: (
      identity: string,
      turn?: EndedTurn,
    ): Promise<null> => {
      if (turnDiffBaselines.has(identity))
        activeTerminalEffectSink?.('turn-diff', identity, turn);
      return Promise.resolve(null);
    },
    // The chat turn's end capture since turn-state phase 40f.
    captureTurnEndAndDiffs: (
      identity: string,
      turn?: EndedTurn,
    ): Promise<null> => {
      if (turnDiffBaselines.has(identity))
        activeTerminalEffectSink?.('turn-diff', identity, turn);
      return Promise.resolve(null);
    },
  }));
  jest.doMock('../../services/telemetry-sync-service', () => ({
    getTelemetrySyncService: () => ({
      flushWorktreeNow: () => Promise.resolve(),
    }),
  }));
  jest.doMock('../../agents/delegation/gate', () => ({
    managedDelegationEnabled: () => false,
    resolveManagedDelegationMode: (mode: string | undefined) => mode ?? 'off',
  }));
}
/* eslint-enable @typescript-eslint/require-await, @typescript-eslint/explicit-function-return-type, @typescript-eslint/consistent-type-imports */

export async function createPipelineHarness(
  options: CreatePipelineHarnessOptions = {},
): Promise<PipelineHarness> {
  installPipelineBootstrap();
  // These fixtures are personal/offline scopes, not organization-policy tests.
  // Preserve every other bundled feature decision and the real watcher service.
  const [{ getFeatureFlagService }, { CLIENT_FEATURE_FLAGS }] =
    await Promise.all([
      import('../../feature-flags'),
      import('@canopy/protocol/feature-flags'),
    ]);
  const featureFlags = getFeatureFlagService();
  const isFeatureEnabled = featureFlags.isEnabled.bind(featureFlags);
  jest
    .spyOn(featureFlags, 'isEnabled')
    .mockImplementation((key) =>
      key === CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key
        ? false
        : isFeatureEnabled(key),
    );

  let logicalNow = options.now ?? Date.now();
  const recorder = new PipelineRecorder(() => logicalNow, options.tap);
  const recordTerminalEffect = (
    effect: 'turn-diff' | 'code-review',
    identity: string,
    turn?: EndedTurn,
  ): void => {
    recorder.record({
      kind: 'effect',
      effect: {
        name: 'terminal-effect',
        effect,
        identity,
        ...(turn === undefined ? {} : { turn: { ...turn } }),
      },
    });
  };
  activeTerminalEffectSink = recordTerminalEffect;
  activeBaselineSink = (identity): void => {
    recorder.record({
      kind: 'effect',
      effect: { name: 'turn-diff-baseline', identity },
    });
  };
  turnDiffBaselines.clear();
  const dropDiagnostics: SessionDiagnosticRecord[] = [];
  const dropDiagnosticCalls: ChatEventDrop[] = [];
  const recordDiagnostic = (record: SessionDiagnosticRecord): void => {
    if (record.kind === 'chat_event_dropped')
      dropDiagnostics.push(cloneAndFreeze(record));
  };
  activeDiagnosticSink = recordDiagnostic;
  const dropModule = await import('../../lib/chat-event-drop-diagnostics');
  const recordDrop = dropModule.recordChatEventDropped;
  jest
    .spyOn(dropModule, 'recordChatEventDropped')
    .mockImplementation((drop, sink) => {
      dropDiagnosticCalls.push(cloneAndFreeze(drop));
      recordDrop(drop, sink);
    });
  const registrations = new Map<string, Registration>();
  const transcriptCaptures = new Map<string, TranscriptCapture>();
  const pendingTimers: TimerEntry[] = [];
  let pendingWork = 0;
  let idleWaiters: Array<() => void> = [];
  const drainGates = new Map<
    string,
    { promise: Promise<void>; release: () => void }
  >();
  const subscriptions: Array<() => void> = [];
  const nativeTaskIdsBySession = new Map<
    string,
    Map<string, string | undefined>
  >();
  let commitGate: { promise: Promise<void>; release: () => void } | undefined;
  let disposed = false;
  const queueRef: { current?: ChatQueueService } = {};
  let hostFixtureCleanup: (() => Promise<void>) | undefined;
  const wrappedSteeringSessions = new WeakSet<object>();
  const pendingSteerRequests = new Map<
    string,
    { text: string; target: PipelineChatTarget }
  >();
  const repositoryTransactionScope = new AsyncLocalStorage<{
    projectId: string;
    worktreeId: string;
  }>();
  const watcherSinkContext = new AsyncLocalStorage<WatcherSinkContext>();

  const recordEffect = (
    effect: PipelineEffect,
    target?: PipelineChatTarget,
  ): void => {
    try {
      recorder.record({
        kind: 'effect',
        ...(target ? { target: cloneAndFreeze(target) } : {}),
        effect: cloneAndFreeze(effect),
      });
    } catch (error) {
      recorder.captureFailed(error);
    }
  };
  const recordedDestroyedSessions = new WeakSet<object>();
  const recordSessionDestroyed = (
    session: object,
    target: PipelineChatTarget,
  ): void => {
    if (recordedDestroyedSessions.has(session)) return;
    recordedDestroyedSessions.add(session);
    recordEffect(
      { name: 'session-destroyed', sessionKey: exactSessionKey(target) },
      target,
    );
  };

  const logicalSchedule = (
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> => {
    const handle = setTimeout(() => undefined, 2_147_483_647);
    pendingTimers.push({
      handle,
      dueAt: logicalNow + Math.max(0, delayMs),
      callback,
      cancelled: false,
    });
    return handle;
  };

  const trackWork = <T>(work: Promise<T>): Promise<T> => {
    pendingWork += 1;
    return work.finally(() => {
      pendingWork -= 1;
      if (pendingWork === 0) {
        const waiters = idleWaiters;
        idleWaiters = [];
        waiters.forEach((resolve) => resolve());
      }
    });
  };

  const waitForTrackedWork = async (): Promise<void> => {
    let stableTurns = 0;
    while (stableTurns < 8) {
      if (pendingWork > 0) {
        await new Promise<void>((resolve) => idleWaiters.push(resolve));
        stableTurns = 0;
      } else {
        await Promise.resolve();
        stableTurns += 1;
      }
    }
  };

  const clearTimeoutOriginal = globalThis.clearTimeout;
  const clearTimeoutTap = (
    handle: NodeJS.Timeout | string | number | undefined,
  ): void => {
    pendingTimers.forEach((timer) => {
      if (timer.handle === handle) timer.cancelled = true;
    });
    clearTimeoutOriginal(handle);
  };
  globalThis.clearTimeout = clearTimeoutTap;
  const restoreClearTimeout = (): void => {
    if (globalThis.clearTimeout === clearTimeoutTap)
      globalThis.clearTimeout = clearTimeoutOriginal;
  };

  const pipelineStorage = await createPipelineStorage({
    storageCheckpoint: async (point): Promise<void> => {
      if (point === 'prepared' && commitGate) await commitGate.promise;
    },
  });
  await options.prepareStorage?.(pipelineStorage);

  const [
    { ChatStateService, resetChatStateServiceForTests },
    queueModule,
    sessionManager,
    sessionRouter,
    worktreeTurn,
    turnCancel,
    sessionKeyModule,
    { getChatTurnOwnership },
    { evaluateTurnAdmission },
    { installTurnStateInvariantGuard },
  ] = await Promise.all([
    import('../../services/chat-state-service'),
    import('../../services/chat-queue-service'),
    import('../../agents/session-manager'),
    import('../../agents/session-event-router'),
    import('../../lib/worktree-chat-turn'),
    import('../../lib/chat-turn-cancel'),
    import('../../agents/session-key'),
    import('../../services/chat-turn-ownership'),
    import('../../services/chat-turn-phase'),
    import('../../observability/turn-state-invariant-guard'),
  ]);
  // The canonical queue gate: whether an ordinary send would be held now.
  const admissionBlocked = (
    target: Pick<PipelineChatTarget, 'projectId' | 'worktreeId' | 'chatId'>,
  ): boolean =>
    evaluateTurnAdmission(getChatTurnOwnership().getSnapshot(target)).kind !==
    'allow';
  getChatTurnOwnership().resetScopesForTests();
  const exactSessionKey = (
    target: Pick<PipelineChatTarget, 'projectId' | 'worktreeId' | 'chatId'>,
  ): string =>
    sessionKeyModule.buildChatSessionKey(
      target.projectId,
      target.worktreeId,
      target.chatId,
    );

  const setCommitListener = pipelineStorage.repository.setCommitListener.bind(
    pipelineStorage.repository,
  );
  jest
    .spyOn(pipelineStorage.repository, 'setCommitListener')
    .mockImplementation((listener, startWait) => {
      setCommitListener(async (commit, wait): Promise<void> => {
        try {
          captureRevision(commit);
        } catch (error) {
          recorder.captureFailed(error);
        }
        await listener(commit, wait);
      }, startWait);
    });
  const originalRepositoryTransactWith =
    pipelineStorage.repository.transactWith.bind(pipelineStorage.repository);
  const storageTransactions: PipelineHarness['storageTransactions'][number][] =
    [];
  let storageTransactionCount = 0;
  jest
    .spyOn(pipelineStorage.repository, 'transactWith')
    .mockImplementation((scope, build, transactionOptions) => {
      storageTransactionCount += 1;
      return repositoryTransactionScope.run(
        { projectId: scope.projectId, worktreeId: scope.worktreeId },
        async (): Promise<ChatStateCommit> => {
          const commit = await originalRepositoryTransactWith(
            scope,
            build,
            transactionOptions,
          );
          if (commit.applied)
            storageTransactions.push(cloneAndFreeze(commit.record));
          return commit;
        },
      );
    });

  const captureTranscript = (target: PipelineChatTarget): void => {
    const bytes = pipelineStorage.readCommittedTranscript(target);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = targetKey(target);
    const previousCapture = transcriptCaptures.get(key);
    const previous = previousCapture
      ? {
          committedBytes: previousCapture.bytes.byteLength,
          sha256: previousCapture.sha256,
          prefixSha256: createHash('sha256')
            .update(bytes.subarray(0, previousCapture.bytes.byteLength))
            .digest('hex'),
        }
      : undefined;
    transcriptCaptures.set(key, { bytes: Buffer.from(bytes), sha256 });
    recorder.record({
      kind: 'transcript',
      target: cloneAndFreeze(target),
      committedBytes: bytes.byteLength,
      sha256,
      ...(previous ? { previous } : {}),
    });
  };

  const captureRevision = (commit: ChatStateCommit): void => {
    const registered = Array.from(registrations.values()).filter(
      (item) => scopeKey(item.target) === scopeKey(commit),
    );
    const chats: Record<string, RevisionChatView> = {};
    const transcriptTargets: PipelineChatTarget[] = [];
    registered.forEach(({ target, options: registration }) => {
      // The repository marks selected transcripts with a data descriptor;
      // unselected tabs use a getter that must never be evaluated here.
      const tab = commit.state.tabsFile.tabs.find(
        (candidate) => candidate.id === target.chatId,
      );
      let rows: RevisionChatView['rows'];
      if (registration.captureRows && tab) {
        const messagesDescriptor = Object.getOwnPropertyDescriptor(
          tab,
          'messages',
        );
        if (
          messagesDescriptor &&
          'value' in messagesDescriptor &&
          Array.isArray(messagesDescriptor.value)
        ) {
          rows = cloneAndFreeze(messagesDescriptor.value.slice(-200));
        }
      }
      chats[target.chatId] = {
        runtime: cloneAndFreeze(commit.state.runtimeByChatId[target.chatId]),
        rows,
        inputDelivery: cloneAndFreeze(tab?.inputDelivery),
      };
      if (registration.captureTranscript === 'revision')
        transcriptTargets.push(target);
    });
    recorder.record({
      kind: 'revision',
      projectId: commit.projectId,
      worktreeId: commit.worktreeId,
      revision: commit.revision,
      baseRevision: commit.baseRevision,
      source: commit.record.source,
      chats,
    });
    transcriptTargets.forEach(captureTranscript);
  };

  const modelConfig = await import('../../lib/model-config');
  modelConfig.loadModelsFromPackageJson();

  const pipelineService = new ChatStateService({
    repository: pipelineStorage.repository,
    now: (): number => logicalNow,
    createId: randomUUID,
    schedule: logicalSchedule,
    recordDiagnostic,
    authorizeSend: (): Promise<void> => Promise.resolve(),
  });
  const observeTurnLifecycle =
    pipelineService.observeTurnLifecycle.bind(pipelineService);
  jest
    .spyOn(pipelineService, 'observeTurnLifecycle')
    .mockImplementation((event) => {
      try {
        const target = {
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId: event.chatId,
        };
        recorder.record({
          kind: 'turn-lifecycle',
          target: cloneAndFreeze(target),
          event: cloneAndFreeze(event),
        });
      } catch (error) {
        recorder.captureFailed(error);
      }
      observeTurnLifecycle(event);
    });
  resetChatStateServiceForTests(pipelineService);
  // The runtime invariant guard (turn-state phase 43c) stays silent on every
  // scenario: committed turn state and its timer rows always agree.
  installTurnStateInvariantGuard((diagnostic) => {
    recorder.captureFailed(
      new Error(
        `Turn-state invariant ${diagnostic.turnStateInvariant ?? 'unknown'} violated in ${diagnostic.chatId}`,
      ),
    );
  }, pipelineService);

  const [
    pendingApprovals,
    pendingRequests,
    effectivePluginSelections,
    pluginDefaultsRevision,
    turnSessionReuseModule,
    delegationActivity,
  ] = await Promise.all([
    import('../../approvals/pending-approvals'),
    import('../../mcp/pending-requests'),
    import('@canopy/desktop-shared/lib/effective-plugin-selections'),
    import('../../plugins/plugin-defaults-revision'),
    import('../../lib/turn-session-reuse'),
    import('../../agents/delegation/activity'),
  ]);

  const queueDependencies: ChatQueueServiceDependencies = {
    readCreditFunding: options.readCreditFunding,
    // Production's queue reads the ownership aggregate the service binds, in
    // both root turn modes.
    ownership: getChatTurnOwnership(),
    steerGenerated: async (
      request,
      origin,
      queuedIds,
      allowSteering,
      canSteerNow,
      claimed,
    ) => {
      pendingSteerRequests.set(request.userMessageId, {
        text: request.text,
        target: {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: request.chatId,
        },
      });
      try {
        return await pipelineService.inputDelivery.steerGenerated(
          request,
          queuedIds,
          origin,
          allowSteering,
          canSteerNow,
          claimed,
        );
      } finally {
        pendingSteerRequests.delete(request.userMessageId);
      }
    },
    steerQueuedGenerated: async (
      request,
      origin,
      queuedIds,
      canSteerNow,
      claimed,
    ) => {
      pendingSteerRequests.set(request.userMessageId, {
        text: request.text,
        target: {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: request.chatId,
        },
      });
      try {
        return await pipelineService.inputDelivery.steerQueuedGenerated(
          request,
          queuedIds,
          origin,
          canSteerNow,
          claimed,
        );
      } finally {
        pendingSteerRequests.delete(request.userMessageId);
      }
    },
    dispatch: (request, origin, fromQueue, authorization, dispatchOptions) =>
      // Production's dispatch dependency, so its capability is consumed.
      trackWork(
        queueModule.dispatchQueuedChatMessage(
          request,
          origin,
          fromQueue,
          authorization,
          dispatchOptions,
        ),
      ),
    cancel: async (target: ChatQueueTarget): Promise<void> => {
      await turnCancel.interruptChatTurnForQueuedMessage(target);
      worktreeTurn.clearActiveTurnUserMessageId(
        target.projectId,
        target.worktreeId,
        target.chatId,
      );
    },
    settleCancelledTurn: async (
      target: ChatQueueTarget,
      turnUserMessageId?: string,
    ): Promise<void> => {
      const { emitHostQueueForcedCancellation } =
        await import('../../services/chat-service');
      await emitHostQueueForcedCancellation(target, turnUserMessageId);
    },
    hasActiveProviderTurn: (target): boolean =>
      sessionManager.getChatSessionLiveness(
        target.projectId,
        target.worktreeId,
        target.chatId,
      ).foreground,
    hasPendingProviderContinuation: (target): boolean =>
      sessionManager.hasPendingCodexContinuation(
        target.projectId,
        target.worktreeId,
        target.chatId,
      ),
    beginTurnPreparation: turnCancel.beginChatTurnPreparation,
    getActiveProviderPluginSelections: (target) =>
      sessionManager.getSessionPluginSelections(
        target.projectId,
        target.worktreeId,
        target.chatId,
      ),
    getActiveProviderPluginDefaultsRevision: (target) =>
      sessionManager.getSessionGlobalPluginDefaultsRevision(
        target.projectId,
        target.worktreeId,
        target.chatId,
      ),
    getCurrentPluginDefaultsRevision: (target) =>
      effectivePluginSelections.chatSurfaceUsesGlobalPluginDefaults(
        target.projectId,
      )
        ? pluginDefaultsRevision.getInheritedPluginDefaultsRevision(target)
        : undefined,
    drainProviderEvents: async (target): Promise<void> => {
      const gate = drainGates.get(targetKey(target));
      if (gate) await gate.promise;
      await sessionRouter.drainCurrentSessionEvents(target);
    },
    hasBackgroundWork: (target): boolean =>
      sessionManager.getChatSessionLiveness(
        target.projectId,
        target.worktreeId,
        target.chatId,
      ).background ||
      delegationActivity.chatHasLiveDelegations(
        target.projectId,
        target.worktreeId,
        target.chatId,
      ),
    hasNativeBackgroundWork: (target): boolean =>
      sessionManager.chatHasNativeBackgroundWork(
        target.projectId,
        target.worktreeId,
        target.chatId,
      ),
    decideTurnSessionReuse: (request) =>
      turnSessionReuseModule.decideTurnSessionReuse(request),
    holdsForBackgroundWork: (target, decision) =>
      turnSessionReuseModule.holdsForBackgroundWork(target, decision),
    readPersistedTabOptions: async (
      target,
    ): Promise<Partial<ChatSendMessageRequest>> => {
      const [{ buildExistingTabDispatchOptions }, { readChatTabsFile }] =
        await Promise.all([
          import('../../services/chat-service'),
          import('../../lib/chat-tabs-reader'),
        ]);
      const [persistedOptions, tabsFile] = await Promise.all([
        buildExistingTabDispatchOptions(
          target.projectId,
          target.worktreeId,
          target.chatId,
        ),
        readChatTabsFile(target.projectId, target.worktreeId),
      ]);
      const tab = tabsFile.tabs.find(
        (candidate) =>
          candidate.id === target.chatId &&
          (candidate.kind ?? 'chat') === 'chat',
      );
      if (!tab) return persistedOptions;

      const {
        getExecutionHarnessForModel,
        getProviderForChatModel,
        getProviderForModel,
      } = await import('@canopy/desktop-shared/types');
      const model = persistedOptions.model ?? tab.model;
      const persistedHarness =
        persistedOptions.executionHarness ?? tab.executionHarness;
      const persistedProvider =
        persistedOptions.providerType ?? tab.providerType;
      const executionHarness =
        persistedHarness ??
        (model ? getExecutionHarnessForModel(model) : undefined) ??
        (persistedProvider === 'codex' ||
        persistedProvider === 'cursor' ||
        persistedProvider === 'copilot'
          ? persistedProvider
          : 'claude');
      const modelProvider = model
        ? (getProviderForChatModel(model, executionHarness) ??
          getProviderForModel(model))
        : undefined;
      const providerType =
        executionHarness === 'cursor' || executionHarness === 'copilot'
          ? executionHarness
          : (persistedProvider ??
            modelProvider ??
            (executionHarness === 'claude' || executionHarness === 'codex'
              ? executionHarness
              : 'claude'));
      const { clampToLiveApprovalMode } =
        await import('../../approvals/live-approval-modes');
      const { resolvePersistedApprovalMode } =
        await import('../../lib/approval-mode-resolution');
      const approvalMode = await resolvePersistedApprovalMode(
        target.projectId,
        target.worktreeId,
        clampToLiveApprovalMode(
          target.projectId,
          target.worktreeId,
          target.chatId,
          tab.approvalMode,
        ),
      );
      return {
        ...persistedOptions,
        ...(model ? { model } : {}),
        ...(providerType ? { providerType } : {}),
        executionHarness,
        approvalMode,
      };
    },
    hasPendingUserDecision: (target): boolean => {
      const key = exactSessionKey(target);
      return (
        pendingApprovals.hasPendingApprovalForSession(key) ||
        pendingRequests.hasPendingRequestForSession(key)
      );
    },
    persistRuntime: async (
      target,
      queuedMessageIds,
      turnActive,
      mutation,
      queuedMessages,
      activeTurnUserMessageId,
      inFlight,
    ): Promise<void> => {
      await trackWork(
        pipelineService.reconcileHostQueue(
          target,
          queuedMessageIds,
          turnActive,
          mutation,
          queuedMessages,
          activeTurnUserMessageId,
          inFlight,
        ),
      );
    },
    hasCommittedMessage: (target, userMessageId): Promise<boolean> =>
      pipelineService.hasTranscriptMessage(
        target,
        target.chatId,
        userMessageId,
      ),
    isCanonicalTurnOpen: (target, turnUserMessageId): Promise<boolean> =>
      pipelineService.isTurnOpen(target, target.chatId, turnUserMessageId),
    broadcast: (event): void => {
      recorder.record({
        kind: 'queue',
        event,
        turnActive: queueRef.current?.isTurnActive(event),
        admissionBlocked: admissionBlocked(event),
      });
    },
    createId: randomUUID,
    now: () => logicalNow,
    schedule: logicalSchedule,
  };

  const pipelineQueue = new queueModule.ChatQueueService(queueDependencies);
  queueRef.current = pipelineQueue;
  jest.spyOn(queueModule, 'getChatQueueService').mockImplementation(() => {
    const queue = queueRef.current;
    if (!queue) throw new Error('Pipeline queue is not ready');
    return queue;
  });

  const queueInstance = pipelineQueue;
  const targetForSessionKey = (value: string): PipelineChatTarget | undefined =>
    Array.from(registrations.values()).find(
      ({ target }) => exactSessionKey(target) === value,
    )?.target;
  subscriptions.push(
    sessionManager.subscribeChatSessionActivity(() => {
      queueInstance.reconcileSessionActivity();
    }),
    sessionManager.subscribeLiveBackgroundTasks((sessionKeyValue) => {
      queueInstance.onNativeBackgroundWorkChanged(sessionKeyValue);
      const target = targetForSessionKey(sessionKeyValue);
      if (!target) return;
      const tasks =
        sessionManager.getLiveBackgroundTasksForChat(
          target.projectId,
          target.worktreeId,
          target.chatId,
        ) ?? [];
      const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
      const taskIds = new Map<string, string | undefined>();
      tasksById.forEach((task, taskId) => {
        taskIds.set(taskId, task.toolUseId);
      });
      const previous =
        nativeTaskIdsBySession.get(sessionKeyValue) ??
        new Map<string, string | undefined>();
      taskIds.forEach((toolUseId, taskId) => {
        const previousToolUseId = previous.get(taskId);
        if (
          !previous.has(taskId) ||
          (previousToolUseId === undefined && toolUseId !== undefined)
        ) {
          recordEffect(
            {
              name: 'native-task-live',
              taskId,
              ...(toolUseId !== undefined ? { toolUseId } : {}),
            },
            target,
          );
        }
      });
      Array.from(previous.keys()).forEach((taskId) => {
        if (!taskIds.has(taskId))
          recordEffect({ name: 'native-task-ended', taskId }, target);
      });
      nativeTaskIdsBySession.set(sessionKeyValue, taskIds);
    }),
    sessionManager.subscribeGlobalPluginDefaultsRevision(() => {
      queueInstance.refreshGlobalPluginDefaults();
    }),
  );
  const steeringEvents =
    await import('../../agents/steering-eligibility-events');
  subscriptions.push(
    delegationActivity.subscribeDelegationActivity(() => {
      queueInstance.reconcileSessionActivity();
    }),
    steeringEvents.subscribeSteeringEligibility((key) => {
      queueInstance.notifySteeringEligibility(key);
    }),
  );

  const originalGetOrCreateSession =
    sessionManager.getOrCreateSession.bind(sessionManager);
  jest
    .spyOn(sessionManager, 'getOrCreateSession')
    .mockImplementation(
      async (
        ...args
      ): Promise<Awaited<ReturnType<typeof originalGetOrCreateSession>>> => {
        const opts = args[0];
        const existing = sessionManager.getSession(
          opts.projectId,
          opts.worktreeId,
          opts.chatId,
        );
        const result = await originalGetOrCreateSession(...args);
        const target = {
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
        };
        if (existing !== result) {
          if (existing) recordSessionDestroyed(existing, target);
          recordEffect(
            { name: 'session-created', sessionKey: exactSessionKey(target) },
            target,
          );
        }
        if (
          result.submitSteeringInput &&
          !wrappedSteeringSessions.has(result)
        ) {
          const originalSubmit = result.submitSteeringInput.bind(result);
          wrappedSteeringSessions.add(result);
          result.submitSteeringInput = async (
            text,
            attemptId,
            userMessageId,
            steeringTarget,
          ): Promise<Awaited<ReturnType<typeof originalSubmit>>> => {
            const request = pendingSteerRequests.get(userMessageId);
            const effectTarget = request?.target ?? target;
            try {
              const outcome = await originalSubmit(
                text,
                attemptId,
                userMessageId,
                steeringTarget,
              );
              recordEffect(
                {
                  name: 'steer-settled',
                  text: request?.text ?? text,
                  outcome:
                    outcome.kind === 'accepted'
                      ? 'accepted'
                      : outcome.kind === 'rejected'
                        ? 'refused'
                        : 'unknown',
                },
                effectTarget,
              );
              return outcome;
            } catch (error) {
              recordEffect(
                {
                  name: 'steer-settled',
                  text: request?.text ?? text,
                  outcome: 'unknown',
                },
                effectTarget,
              );
              throw error;
            }
          };
        }
        return result;
      },
    );
  const originalDestroySession =
    sessionManager.destroySession.bind(sessionManager);
  jest
    .spyOn(sessionManager, 'destroySession')
    .mockImplementation(async (...args) => {
      const target = {
        projectId: args[0],
        worktreeId: args[1],
        chatId: args[2],
      };
      const existing = sessionManager.getSession(
        target.projectId,
        target.worktreeId,
        target.chatId,
      );
      const result = await originalDestroySession(...args);
      if (existing) recordSessionDestroyed(existing, target);
      return result;
    });

  const wakeLockModule = await import('../../power/wake-lock-service');
  const wakeLockService = wakeLockModule.getWakeLockService();
  const targetForWakeHolder = (key: string): PipelineChatTarget | undefined =>
    Array.from(registrations.values()).find(
      ({ target }) => key === `chat:${exactSessionKey(target)}`,
    )?.target;
  const originalAcquire = wakeLockService.acquire.bind(wakeLockService);
  jest.spyOn(wakeLockService, 'acquire').mockImplementation((key, reason) => {
    originalAcquire(key, reason);
    const target = targetForWakeHolder(key);
    if (target)
      recordEffect({ name: 'wake-lock-acquire', holder: key }, target);
  });
  const originalRelease = wakeLockService.release.bind(wakeLockService);
  jest.spyOn(wakeLockService, 'release').mockImplementation((key) => {
    originalRelease(key);
    const target = targetForWakeHolder(key);
    if (target)
      recordEffect({ name: 'wake-lock-release', holder: key }, target);
  });

  const rewriteDiagnostics =
    await import('../../services/chat-transcript-rewrite-diagnostics');
  rewriteDiagnostics.setChatTranscriptRewriteDiagnosticsForTests({
    now: () => logicalNow,
    sink: (): void => undefined,
  });
  const originalReportRewrite =
    rewriteDiagnostics.reportChatTranscriptFullRewrite;
  jest
    .spyOn(rewriteDiagnostics, 'reportChatTranscriptFullRewrite')
    .mockImplementation((rewrite) => {
      const scope = repositoryTransactionScope.getStore();
      const matches = Array.from(registrations.values()).filter(
        ({ target }) =>
          target.chatId === rewrite.chatId &&
          (scope === undefined || scopeKey(target) === scopeKey(scope)),
      );
      const target = matches.length === 1 ? matches[0]?.target : undefined;
      if (target)
        recordEffect(
          { name: 'transcript-rewrite', reason: rewrite.reason },
          target,
        );
      originalReportRewrite(rewrite);
    });

  const paths = await import('../../lib/paths');
  const watcherPath = join(pipelineStorage.root, 'app-advisor-watchers.json');
  jest
    .spyOn(paths, 'getAppAdvisorWatchersFilePath')
    .mockReturnValue(watcherPath);
  const watchers = await import('../../app-advisor/watchers');
  const watcherService = watchers.getAppAdvisorWatcherService();
  // Invariant 8's chat-level half: each completion the watcher service
  // reports. The instance wrapper shadows the class method until teardown.
  const reportChatCompletion: unknown = Reflect.get(
    watcherService,
    'reportChatCompletion',
  );
  if (typeof reportChatCompletion === 'function')
    Reflect.set(
      watcherService,
      'reportChatCompletion',
      (...args: unknown[]): unknown => {
        const [event] = args;
        const result: unknown = Reflect.apply(
          reportChatCompletion,
          watcherService,
          args,
        );
        if (!isRecord(event) || !isRecord(event.data)) return result;
        const { projectId, worktreeId, chatId, receivedAt } = event;
        const turnStamp = event.data.canopy_turn_user_message_id;
        if (
          typeof projectId !== 'string' ||
          typeof worktreeId !== 'string' ||
          typeof chatId !== 'string'
        )
          return result;
        const stamp = typeof turnStamp === 'string' ? turnStamp : '';
        const target = { projectId, worktreeId, chatId };
        recordEffect({ name: 'chat-completion-reported', stamp }, target);
        // The modal can open during enrichment: the report then holds this
        // completion for the modal's replay instead of sending it.
        void Promise.resolve(result).then(
          () => {
            const held: unknown = Reflect.get(
              watcherService,
              'heldChatTargets',
            );
            const deferred =
              held instanceof Map &&
              Array.from(held.values()).some(
                (value: unknown) =>
                  isRecord(value) &&
                  isRecord(value.data) &&
                  value.chatId === chatId &&
                  value.worktreeId === worktreeId &&
                  value.receivedAt === receivedAt &&
                  value.data.canopy_turn_user_message_id === turnStamp,
              );
            if (deferred)
              recordEffect({ name: 'chat-completion-deferred', stamp }, target);
          },
          () => undefined,
        );
        return result;
      },
    );
  const fsPromises =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  const originalRename = fsPromises.rename.bind(fsPromises);
  jest
    .spyOn(fsPromises, 'rename')
    .mockImplementation(async (oldPath, newPath) => {
      await originalRename(oldPath, newPath);
      const context = watcherSinkContext.getStore();
      // One watcher write renames each store it updates (the legacy and the
      // canonical file); it is one side effect of its call.
      if (!context || context.renamed) return;
      context.renamed = true;
      recordEffect(
        {
          name: 'tool-side-effect',
          callId: context.callId,
          effect: 'watcher-file-rename',
        },
        context.target,
      );
    });
  const originalCreateLocalWatcher =
    watcherService.createLocalWatcher.bind(watcherService);
  jest
    .spyOn(watcherService, 'createLocalWatcher')
    .mockImplementation(async (...args) => {
      const [watchTarget, destination, toolUseId] = args;
      const target = {
        projectId: destination.projectId,
        worktreeId: destination.worktreeId,
        chatId: destination.chatId,
      };
      const naturalKey = JSON.stringify({
        recipient: {
          projectId: destination.projectId,
          worktreeId: destination.worktreeId,
          chatId: destination.chatId,
          delegationId: destination.delegationId ?? null,
        },
        toolUseId,
        targetKind: watchTarget.kind,
      });
      const context: WatcherSinkContext = {
        target,
        callId: toolUseId,
        renamed: false,
      };
      const summary = await watcherSinkContext.run(context, () =>
        originalCreateLocalWatcher(...args),
      );
      recordEffect(
        {
          name: 'watcher-registered',
          callId: toolUseId,
          naturalKey,
          watcherId: summary.id,
          created: context.renamed,
        },
        target,
      );
      return summary;
    });

  const registerChat = (
    target: PipelineChatTarget,
    registration: PipelineChatRegistration,
  ): void => {
    registrations.set(targetKey(target), {
      target: cloneAndFreeze(target),
      options: cloneAndFreeze(registration),
    });
  };

  const drain = async (target: PipelineChatTarget): Promise<void> => {
    await sessionRouter.drainCurrentSessionEvents(target);
    await pipelineStorage.repository.flushScope({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
    });
    queueInstance.reconcileSessionActivity();
    await waitForTrackedWork();
    await sessionRouter.drainCurrentSessionEvents(target);
    await pipelineStorage.repository.flushScope({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
    });
    await waitForTrackedWork();
  };

  const harness: PipelineHarness = {
    recorder,
    storageTransactions,
    getStorageTransactionCount: (): number => storageTransactionCount,
    dropDiagnosticCalls,
    dropDiagnostics,
    registerChat,
    async host(
      kind: PipelineHost,
      provider: PipelineProvider,
      target: PipelineChatTarget,
      hostOptions: PipelineHostOptions = {},
    ): Promise<PipelineHostAdapter> {
      if (disposed) throw new Error('Pipeline harness is disposed');
      registerChat(
        target,
        registrations.get(targetKey(target))?.options ?? {
          captureRows: true,
          captureTranscript: 'off',
        },
      );
      const hostModule = await import('./hosts');
      hostFixtureCleanup = hostModule.resetPipelineHostAdapterFixtures;
      return hostModule.createPipelineHostAdapter({
        kind,
        provider,
        target,
        hostOptions,
        service: pipelineService,
        queue: queueInstance,
        root: pipelineStorage.root,
        drain: () => drain(target),
      });
    },
    checkpoint(label, target, extra): Promise<void> {
      const liveness = target
        ? sessionManager.getChatSessionLiveness(
            target.projectId,
            target.worktreeId,
            target.chatId,
          )
        : undefined;
      const activeInfo = target
        ? sessionManager
            .getActiveSessionInfos(target.projectId, target.worktreeId)
            .find((info) => info.chatId === target.chatId)
        : undefined;
      recorder.record({
        kind: 'checkpoint',
        label,
        ...(target ? { target: cloneAndFreeze(target) } : {}),
        ...(liveness
          ? {
              liveness: {
                foreground: liveness.foreground,
                background: liveness.background,
              },
            }
          : {}),
        ...(activeInfo ? { sessionTurnActive: activeInfo.turnActive } : {}),
        ...(target
          ? {
              queueTurnActive: queueInstance.isTurnActive(target),
              admissionBlocked: admissionBlocked(target),
            }
          : {}),
        ...(extra?.userInitiated !== undefined
          ? { userInitiated: extra.userInitiated }
          : {}),
      });
      if (target) {
        const registration = registrations.get(targetKey(target));
        if (registration?.options.captureTranscript === 'checkpoint')
          captureTranscript(target);
      } else {
        Array.from(registrations.values())
          .filter(({ options }) => options.captureTranscript === 'checkpoint')
          .forEach(({ target: registeredTarget }) =>
            captureTranscript(registeredTarget),
          );
      }
      return Promise.resolve();
    },
    holdCommits(): void {
      if (commitGate) return;
      let release = (): void => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      commitGate = { promise, release };
      recordEffect({ name: 'commits-held' });
    },
    releaseCommits(): void {
      const gate = commitGate;
      if (!gate) return;
      commitGate = undefined;
      gate.release();
      recordEffect({ name: 'commits-released' });
    },
    holdDrainBarrier(target): void {
      if (drainGates.has(targetKey(target))) return;
      let release = (): void => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      drainGates.set(targetKey(target), { promise, release });
    },
    releaseDrainBarrier(target): void {
      const gate = drainGates.get(targetKey(target));
      if (!gate) return;
      drainGates.delete(targetKey(target));
      gate.release();
    },
    async advanceLogicalClock(ms): Promise<void> {
      if (!Number.isFinite(ms) || ms < 0)
        throw new Error(
          'Logical time advance must be a finite non-negative number',
        );
      logicalNow += ms;
      let fired = 0;
      while (fired < 2000) {
        const next = pendingTimers
          .filter((timer) => !timer.cancelled && timer.dueAt <= logicalNow)
          .sort((left, right) => left.dueAt - right.dueAt)[0];
        if (!next) break;
        next.cancelled = true;
        clearTimeoutOriginal(next.handle);
        next.callback();
        fired += 1;
        await Promise.resolve();
      }
      if (fired === 2000)
        throw new Error('Logical scheduler exceeded 2000 due callbacks');
      await Promise.resolve();
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      harness.releaseCommits();
      Array.from(drainGates.values()).forEach((gate) => gate.release());
      drainGates.clear();
      pendingTimers.forEach((timer) => {
        timer.cancelled = true;
        clearTimeoutOriginal(timer.handle);
      });
      subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
      try {
        const registeredTargets = Array.from(registrations.values()).map(
          (registration) => registration.target,
        );
        // Dispatch and durable reconcile callbacks are tracked independently
        // of the queue's synchronous scheduling API. Let in-flight work settle
        // before sessions or their backing repository are torn down.
        await waitForTrackedWork();
        await Promise.all(
          registeredTargets.map((target) =>
            sessionManager.destroySession(
              target.projectId,
              target.worktreeId,
              target.chatId,
            ),
          ),
        );
        await waitForTrackedWork();
      } catch (error) {
        recorder.captureFailed(error);
      }
      queueRef.current?.resetForTests();
      try {
        watcherService.shutdown();
      } catch (error) {
        recorder.captureFailed(error);
      }
      Reflect.deleteProperty(watcherService, 'reportChatCompletion');
      try {
        await hostFixtureCleanup?.();
      } catch (error) {
        recorder.captureFailed(error);
      }
      try {
        const { disposeResourceMonitorService } =
          await import('../../resource-monitor');
        disposeResourceMonitorService();
      } catch (error) {
        recorder.captureFailed(error);
      }
      try {
        const { shutdownCodexRuntimeService } =
          await import('../../codex/runtime-service');
        await shutdownCodexRuntimeService();
      } catch (error) {
        recorder.captureFailed(error);
      }
      restoreClearTimeout();
      try {
        await pipelineStorage.dispose();
      } catch (error) {
        recorder.captureFailed(error);
      } finally {
        if (activeDiagnosticSink === recordDiagnostic)
          activeDiagnosticSink = undefined;
        if (activeTerminalEffectSink === recordTerminalEffect)
          activeTerminalEffectSink = undefined;
        resetChatStateServiceForTests();
        jest.restoreAllMocks();
      }
      const tapError = recorder.firstTapError();
      if (recorder.hasTapFailures()) {
        if (tapError instanceof Error) throw tapError;
        throw new Error(
          typeof tapError === 'string'
            ? tapError
            : 'Pipeline trace tap failed with a non-Error value',
        );
      }
    },
  };

  return harness;
}
