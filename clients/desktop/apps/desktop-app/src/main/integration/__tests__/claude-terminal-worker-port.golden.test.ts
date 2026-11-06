/**
 * CAN-5097 migration golden: Claude Code terminal mode over the real routed
 * worker.terminal port and terminal service, with a recording engine in
 * place of node-pty. The CLI is created (worker.terminal.create), written to
 * (worker.terminal.write) and killed (worker.terminal.kill) through the port.
 */
import type {
  CanonicalChatAddress,
  ChatWatcherEvidence,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  IPC_CHANNELS,
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  type AgentProviderAuthStatus,
} from '@canopy/desktop-shared/types';
import { DESKTOP_INTEGRATION_TOKEN_ENV_VAR } from '@canopy/desktop-shared/lib/desktop-integration-transport';
import type { CanopyWorktreeSessionRoute } from '../../mcp/http-proxy-service';
import type * as RoutedWorkerTerminalModule from '../../terminal/routed-worker-terminal';
import type * as RecordingTerminalEngineModule from './helpers/recording-terminal-engine';
import type { RecordingTerminalEngine } from './helpers/recording-terminal-engine';

type MockTabsFile = {
  tabs: Array<Record<string, unknown>>;
  activeTabId?: string;
  version?: number;
};
type MockTranscriptSyncResult = {
  projectId: string;
  worktreeId: string;
  chatId: string;
  importedEventCount: number;
  importedMessages: Array<Record<string, unknown>>;
  importedEvents?: unknown[];
  transcriptPath: string;
  compactionAppended: boolean;
  errors?: string[];
  transcriptReadComplete?: boolean;
  replayedFromStart?: boolean;
};
type MockLaunchConfig = {
  executable: string;
  args: string[];
  env: Record<string, string>;
};
type RmOptions = { recursive?: boolean; force?: boolean };
type ShutdownService = { shutdown(): Promise<void> };

async function shutdownServices(
  services: Iterable<ShutdownService>,
): Promise<void> {
  const results = await Promise.allSettled(
    Array.from(services, (service) => service.shutdown()),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) {
    throw failure.reason;
  }
}

const mockSyncClaudeTerminalTranscript = jest.fn<
  Promise<MockTranscriptSyncResult>,
  [unknown]
>();
const mockRecordSessionDiagnostic = jest.fn<void, [Record<string, unknown>]>();
const mockStartChatTurn = jest.fn<void, [Record<string, unknown>]>();
const mockObserveChatEvent = jest.fn<void, [string, string, string, unknown]>();
const mockCompleteChatTurn = jest.fn<
  void,
  [string, string, string, string, string?]
>();
const mockRecordInjectedPromptForOpenChatTurn = jest.fn<
  void,
  [string, string, string, Record<string, unknown>]
>();
const mockCaptureTurnStart = jest.fn<Promise<void>, [string, string, string]>(
  () => Promise.resolve(),
);
const mockCaptureTurnEndAndDiff = jest.fn<Promise<unknown>, [string]>(() =>
  Promise.resolve(undefined),
);
const mockRm = jest.fn<Promise<void>, [string, RmOptions?]>(() =>
  Promise.resolve(),
);
const mockAccess = jest.fn<Promise<void>, [string]>(() =>
  Promise.reject(new Error('missing')),
);
const mockReaddir = jest.fn<
  Promise<never[]>,
  [string, { withFileTypes: true }]
>(() => Promise.resolve([]));
const mockWriteChatTabsFile = jest.fn<
  Promise<void>,
  [string, string, MockTabsFile]
>(() => Promise.resolve());
const mockReadChatTabsFile = jest.fn<Promise<MockTabsFile>, [string, string]>(
  () => Promise.resolve({ tabs: [{ id: 'chat' }] }),
);
const mockGetInitialChatTitlePrompt = jest.fn(
  async (): Promise<string | null> => {
    const { tabs } = await mockReadChatTabsFile('p', 'w');
    const tab = tabs.find((candidate) => candidate.id === 'chat');
    return !tab ||
      tab.description ||
      tab.customTitle ||
      tab.automaticTitleState === 'closed'
      ? null
      : 'summarize me';
  },
);
const mockEnsureStarted = jest.fn<Promise<void>, [number?]>(() =>
  Promise.resolve(),
);
const mockRegisterCanopyWorktreeSessionRoute = jest.fn<
  Promise<void>,
  [CanopyWorktreeSessionRoute]
>(() => Promise.resolve());
const mockUnregisterCanopyWorktreeSessionRoute = jest.fn<void, [string]>();
const mockUnregisterMcpProxyRoutesForSession = jest.fn<void, [string]>();
const mockRecordInterruptedChats = jest.fn(() => Promise.resolve());
jest.mock('../../lib/usage-limited-chats-registry', () => ({
  get recordInterruptedChats(): typeof mockRecordInterruptedChats {
    return mockRecordInterruptedChats;
  },
}));
const mockReadPreferencesFile = jest.fn<Promise<Record<string, unknown>>, []>(
  () => Promise.resolve({ approvalDefaults: DEFAULT_APPROVAL_DEFAULTS }),
);
const mockReadWorkspaceApprovals = jest.fn<
  Promise<{
    version: 1;
    rules: unknown[];
    defaultMode?: 'ask' | 'auto' | 'full-access';
  }>,
  []
>(() => Promise.resolve({ version: 1, rules: [] }));
const mockReadWorkspaceApprovalsManifest = jest.fn(() =>
  Promise.resolve({ rules: [] }),
);
const mockHandleChatTerminalEvent = jest.fn();
const mockCanonicalStarted = jest.fn();
const mockCanonicalTerminal = jest.fn();
let mockWatcherObservations: unknown[] = [];
const mockWriteWatcherObservations = jest.fn(
  (_runtimeDir: string, observations: unknown[]): Promise<void> => {
    mockWatcherObservations = structuredClone(observations);
    return Promise.resolve();
  },
);
const mockWatcherIngress = jest.fn(
  (
    request: unknown,
  ): Promise<
    | { allowed: true }
    | { allowed: false; outcome: 'held'; reason: 'owner_boundary' }
  > => {
    void request;
    return Promise.resolve({ allowed: true });
  },
);
const mockReadWatcherObservations = jest.fn(
  (): Promise<unknown[]> =>
    Promise.resolve(structuredClone(mockWatcherObservations)),
);
const mockReleaseWatcherAuthority = jest.fn(
  (deliveryId: string): Promise<void> => {
    void deliveryId;
    return Promise.resolve();
  },
);
const mockAuthorizeRetainedPaste = jest.fn(() => Promise.resolve(undefined));
const mockHandleNewChatStartedEvent = jest.fn();
const mockResolveWorktreeCwd = jest.fn<string, [string, string, string?]>(
  () => '/worktree',
);
const mockResolveWorktreeTargetIds = jest.fn(
  (
    projectId: string,
    worktreeId: string,
  ): { projectId: string; worktreeId: string } | null => ({
    projectId,
    worktreeId,
  }),
);
const mockBuildClaudeTerminalLaunchConfig = jest.fn<
  Promise<MockLaunchConfig>,
  [Record<string, unknown>]
>(() =>
  Promise.resolve({
    executable: '/bin/claude',
    args: [],
    env: {},
  }),
);
const mockEnsureClaudeWorkspaceTrust = jest.fn<
  Promise<{ trustedPath: string; updated: boolean }>,
  [string]
>((cwd) => Promise.resolve({ trustedPath: cwd, updated: false }));
const mockGetCachedClaudeAuthStatusObserved = jest.fn<
  Promise<AgentProviderAuthStatus>,
  [
    string,
    {
      forceAuthenticatedInvalidation?: boolean;
      forceRefresh?: boolean;
      maxAgeMs?: number;
    }?,
  ]
>(() =>
  Promise.resolve({
    authenticated: true,
    accountLabel: 'dev@example.com',
    detail: null,
    error: null,
  }),
);
const mockIsClaudeTuiChatsEnabled = jest.fn(() => true);
const mockIngestProviderEvent = jest.fn<
  Promise<void>,
  [Record<string, unknown>]
>(() => Promise.resolve());
const mockCreateApprovalSession = jest.fn(
  (context: Record<string, unknown>) => {
    void context;
    return {
      check: jest.fn(() => Promise.resolve({ decision: 'deny' as const })),
      setMode: jest.fn(),
      invalidatePending: jest.fn(),
      dispose: jest.fn(),
    };
  },
);
const mockHasCodeGraph = jest.fn(() => false);
type MockLedgerTools = {
  systemPrompt: jest.Mock<string, []>;
  assignmentHint: jest.Mock<Promise<string | undefined>, []>;
  execute: jest.Mock;
  dispose: jest.Mock<void, []>;
};
type MockOpenLedgerChatToolsOptions = {
  target: Record<string, unknown>;
  harness: string;
  readSettings: () => Record<string, unknown>;
  selectedRepoId?: string;
};
const mockMayExposeLedgerTools = jest.fn<boolean, [Record<string, unknown>]>(
  () => false,
);
const mockOpenLedgerChatTools = jest.fn<
  Promise<MockLedgerTools | null>,
  [MockOpenLedgerChatToolsOptions]
>(() => Promise.resolve(null));
jest.mock('../../canopy-tools/ledger-tools-runtime', () => ({
  mayExposeLedgerTools: (target: Record<string, unknown>): boolean =>
    mockMayExposeLedgerTools(target),
  openLedgerChatTools: (
    options: MockOpenLedgerChatToolsOptions,
  ): Promise<MockLedgerTools | null> => mockOpenLedgerChatTools(options),
}));

const mockCaptureSessionWorkOwner = jest.fn();
const mockResolveSessionWorkOwner = jest.fn();

jest.mock('../../agents/work-owner', () => ({
  captureSessionWorkOwner: (...args: unknown[]): unknown =>
    mockCaptureSessionWorkOwner(...args),
  resolveSessionWorkOwner: (...args: unknown[]): unknown =>
    mockResolveSessionWorkOwner(...args),
}));

// Lazy wrappers: `config-paths` now imports this module while the test file's
// own imports are still loading, before the `const mock*` bindings initialize.
jest.mock('node:fs/promises', () => ({
  access: (
    ...args: Parameters<typeof mockAccess>
  ): ReturnType<typeof mockAccess> => mockAccess(...args),
  mkdir: jest.fn(() => Promise.resolve(undefined)),
  readdir: (
    ...args: Parameters<typeof mockReaddir>
  ): ReturnType<typeof mockReaddir> => mockReaddir(...args),
  rm: (...args: Parameters<typeof mockRm>): ReturnType<typeof mockRm> =>
    mockRm(...args),
}));

jest.mock('../../lib/app-advisor-workspace', () => ({
  ensureAppAdvisorHomeScaffold: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    get recordSessionDiagnostic(): typeof mockRecordSessionDiagnostic {
      return mockRecordSessionDiagnostic;
    },
    get startChatTurn(): typeof mockStartChatTurn {
      return mockStartChatTurn;
    },
    get observeChatEvent(): typeof mockObserveChatEvent {
      return mockObserveChatEvent;
    },
    get completeChatTurn(): typeof mockCompleteChatTurn {
      return mockCompleteChatTurn;
    },
    get recordInjectedPromptForOpenChatTurn(): typeof mockRecordInjectedPromptForOpenChatTurn {
      return mockRecordInjectedPromptForOpenChatTurn;
    },
  })),
}));

jest.mock('../../auth/provider-auth-state', () => ({
  get getCachedClaudeAuthStatusObserved(): typeof mockGetCachedClaudeAuthStatusObserved {
    return mockGetCachedClaudeAuthStatusObserved;
  },
}));

jest.mock('../../lib/claude-tui-chats', () => ({
  get isClaudeTuiChatsEnabled(): typeof mockIsClaudeTuiChatsEnabled {
    return mockIsClaudeTuiChatsEnabled;
  },
}));

jest.mock('../../lib/turn-diff-capture', () => ({
  get captureTurnStart(): typeof mockCaptureTurnStart {
    return mockCaptureTurnStart;
  },
  get captureTurnEndAndDiff(): typeof mockCaptureTurnEndAndDiff {
    return mockCaptureTurnEndAndDiff;
  },
}));

const mockScheduleCodeGraphBuild = jest.fn();
jest.mock('../../lib/code-graph-scheduler', () => ({
  get scheduleCodeGraphBuild(): typeof mockScheduleCodeGraphBuild {
    return mockScheduleCodeGraphBuild;
  },
}));

jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: (): { hasGraph: jest.Mock } => ({
    get hasGraph(): typeof mockHasCodeGraph {
      return mockHasCodeGraph;
    },
  }),
}));

jest.mock('../../integration/desktop-integration-server', () => ({
  getDesktopIntegrationServer: jest.fn(() => ({
    get ensureStarted(): typeof mockEnsureStarted {
      return mockEnsureStarted;
    },
    get registerCanopyWorktreeSessionRoute(): typeof mockRegisterCanopyWorktreeSessionRoute {
      return mockRegisterCanopyWorktreeSessionRoute;
    },
    get unregisterCanopyWorktreeSessionRoute(): typeof mockUnregisterCanopyWorktreeSessionRoute {
      return mockUnregisterCanopyWorktreeSessionRoute;
    },
    get unregisterMcpProxyRoutesForSession(): typeof mockUnregisterMcpProxyRoutesForSession {
      return mockUnregisterMcpProxyRoutesForSession;
    },
  })),
}));

jest.mock('../../integration/claude-terminal-transcript-sync', () => ({
  isAllowedClaudeTerminalTranscriptPath: (
    transcriptPath: string,
    runtimeDir: string,
  ): boolean =>
    transcriptPath === runtimeDir ||
    transcriptPath.startsWith(`${runtimeDir}/`),
  get syncClaudeTerminalTranscript(): typeof mockSyncClaudeTerminalTranscript {
    return mockSyncClaudeTerminalTranscript;
  },
  readTerminalWatcherObservations: (): Promise<unknown[]> =>
    mockReadWatcherObservations(),
  get writeTerminalWatcherObservations(): typeof mockWriteWatcherObservations {
    return mockWriteWatcherObservations;
  },
  terminalWatcherObservationsPath: (runtimeDir: string): string =>
    `${runtimeDir}.watcher-observations.json`,
}));

jest.mock('../../lib/chat-tabs-reader', () => ({
  get readChatTabsFile(): typeof mockReadChatTabsFile {
    return mockReadChatTabsFile;
  },
}));

jest.mock('../../lib/chat-tabs', () => ({
  get writeChatTabsFile(): typeof mockWriteChatTabsFile {
    return mockWriteChatTabsFile;
  },
}));

// Set to the store's product-default projection to simulate unreadable authority.
const mockUnreadableAuthorityPreferences: Record<string, unknown> | null = null;
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFileDetailed: async (options?: {
    includeServed?: boolean;
  }): Promise<{
    preferences: Awaited<ReturnType<typeof mockReadPreferencesFile>>;
    authority: 'ok' | 'unreadable';
    served?: Awaited<ReturnType<typeof mockReadPreferencesFile>>;
  }> => {
    const served = await mockReadPreferencesFile();
    if (!mockUnreadableAuthorityPreferences)
      return { preferences: served, authority: 'ok' };
    return {
      preferences: mockUnreadableAuthorityPreferences,
      authority: 'unreadable',
      ...(options?.includeServed === true ? { served } : {}),
    };
  },
  // Not degraded: approval resolution fails closed when this is non-null.
  peekPreferencesLoadError: (): null => null,
  get readPreferencesFile(): typeof mockReadPreferencesFile {
    return mockReadPreferencesFile;
  },
}));

jest.mock('../../lib/approvals-persistence', () => ({
  get readWorkspaceApprovals(): typeof mockReadWorkspaceApprovals {
    return mockReadWorkspaceApprovals;
  },
}));

jest.mock('../../lib/workspace-approvals-manifest', () => ({
  get readWorkspaceApprovalsManifest(): typeof mockReadWorkspaceApprovalsManifest {
    return mockReadWorkspaceApprovalsManifest;
  },
}));

jest.mock('../../lib/resolve-worktree', () => ({
  get resolveWorktreeCwd(): typeof mockResolveWorktreeCwd {
    return mockResolveWorktreeCwd;
  },
  get resolveWorktreeTargetIds(): typeof mockResolveWorktreeTargetIds {
    return mockResolveWorktreeTargetIds;
  },
}));

jest.mock('../../approvals/approval-service', () => ({
  createApprovalSession: (context: Record<string, unknown>): unknown =>
    mockCreateApprovalSession(context),
}));

jest.mock('../../integration/claude-terminal-settings', () => ({
  get buildClaudeTerminalLaunchConfig(): typeof mockBuildClaudeTerminalLaunchConfig {
    return mockBuildClaudeTerminalLaunchConfig;
  },
}));

jest.mock('../../integration/claude-workspace-trust', () => ({
  get ensureClaudeWorkspaceTrust(): typeof mockEnsureClaudeWorkspaceTrust {
    return mockEnsureClaudeWorkspaceTrust;
  },
}));

const mockRecordTerminalPlanImplementation = jest.fn<
  Promise<boolean>,
  [unknown, string]
>(() => Promise.resolve(false));

jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: jest.fn(() => ({
    recordTerminalPlanImplementation: mockRecordTerminalPlanImplementation,
    get ingestProviderEvent(): typeof mockIngestProviderEvent {
      return mockIngestProviderEvent;
    },
    get authorizeRetainedTerminalAgentInputWrite(): typeof mockAuthorizeRetainedPaste {
      return mockAuthorizeRetainedPaste;
    },
    get getInitialChatTitlePrompt(): typeof mockGetInitialChatTitlePrompt {
      return mockGetInitialChatTitlePrompt;
    },
  })),
}));

type MockPlanFileScope = { projectId: string; worktreeId: string };
type MockPlanTurnLease = { end: jest.Mock<void, []> };
const mockPlanTurnLeases: MockPlanTurnLease[] = [];
const mockBeginPlanTurn = jest.fn<
  MockPlanTurnLease,
  [string, MockPlanFileScope]
>(() => {
  const lease: MockPlanTurnLease = { end: jest.fn<void, []>() };
  mockPlanTurnLeases.push(lease);
  return lease;
});
const mockResolvePlanTurnScope = jest.fn<
  MockPlanFileScope | null,
  [string, string]
>();
jest.mock('../../lib/plan-file-sync', () => ({
  getPlanFileSyncService: (): { beginTurn: typeof mockBeginPlanTurn } => ({
    get beginTurn(): typeof mockBeginPlanTurn {
      return mockBeginPlanTurn;
    },
  }),
  planChatTurnKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => JSON.stringify([projectId, worktreeId, chatId]),
  resolvePlanTurnScope: (
    projectId: string,
    worktreeId: string,
  ): MockPlanFileScope | null =>
    mockResolvePlanTurnScope(projectId, worktreeId),
}));

jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    get handleChatTerminalEvent(): typeof mockHandleChatTerminalEvent {
      return mockHandleChatTerminalEvent;
    },
    get handleCanonicalChatStartedEvent(): typeof mockCanonicalStarted {
      return mockCanonicalStarted;
    },
    get handleCanonicalChatTerminalEvent(): typeof mockCanonicalTerminal {
      return mockCanonicalTerminal;
    },
    get handleNewChatStartedEvent(): typeof mockHandleNewChatStartedEvent {
      return mockHandleNewChatStartedEvent;
    },
    get releaseChatDeliveryAuthority(): typeof mockReleaseWatcherAuthority {
      return mockReleaseWatcherAuthority;
    },
  })),
}));

const mockResolveCanonicalChatAddress = jest.fn<
  Promise<CanonicalChatAddress | null>,
  [{ projectId: string; worktreeId: string; chatId: string }]
>();
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

jest.mock('../../services/active-chat-input', () => ({
  get resolveCanonicalChatAddress(): typeof mockResolveCanonicalChatAddress {
    return mockResolveCanonicalChatAddress;
  },
  captureChatWatcherEvidence: (): Promise<ChatWatcherEvidence> =>
    Promise.resolve({
      sourceOwner: { kind: 'personal' },
      accountEpoch: 4,
    }),
  get checkWatcherDeliveryIngress(): typeof mockWatcherIngress {
    return mockWatcherIngress;
  },
  WatcherDeliveryHeldError: class extends Error {
    public readonly outcome = 'held';
    public constructor(public readonly reason: string) {
      super('held');
    }
  },
}));

jest.mock('../../terminal/worker-terminal', () => {
  const { RoutedWorkerTerminal } = jest.requireActual<
    typeof RoutedWorkerTerminalModule
  >('../../terminal/routed-worker-terminal');
  const { createRecordingTerminalEngine } = jest.requireActual<
    typeof RecordingTerminalEngineModule
  >('./helpers/recording-terminal-engine');
  const engine = createRecordingTerminalEngine();
  return {
    workerTerminal: new RoutedWorkerTerminal(engine),
    mockEngine: engine,
  };
});
jest.mock('../../services/split-lock-service', () => ({
  assertNotSplitLocked: (): void => undefined,
}));
jest.mock('../../lib/workspace-target-exclusion', () => ({
  withWorkspaceTargetRuntimeStartReservation: (
    _project: string,
    _worktree: string,
    start: () => Promise<unknown>,
  ): Promise<unknown> => start(),
}));
jest.mock('../../terminal/persistence', () => ({
  terminalPersistenceStore: {
    getPersistedTerminalEntry: (): null => null,
    registerLiveSession: (): void => undefined,
    appendTerminalOutput: (): void => undefined,
    markTerminalExited: (): void => undefined,
  },
}));

import { getBundledClaudeBinaryPath } from '../../pipelines/config-paths';
import { DefaultClaudeTerminalSessionService } from '../../integration/claude-terminal-session-service';

const mockEngine = jest.requireMock<{ mockEngine: RecordingTerminalEngine }>(
  '../../terminal/worker-terminal',
).mockEngine;

const TARGET = { projectId: 'p', worktreeId: 'w', chatId: 'chat-1' };
const LAUNCH = { ...TARGET, cols: 80, rows: 24 };

async function flushTerminalEventTasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('Claude Code terminal mode on the worker.terminal port (CAN-5097)', () => {
  const services = new Set<DefaultClaudeTerminalSessionService>();

  function createService(): DefaultClaudeTerminalSessionService {
    const service = new DefaultClaudeTerminalSessionService();
    services.add(service);
    return service;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockEngine.reset();
    mockResolveSessionWorkOwner.mockResolvedValue({ kind: 'personal' });
    mockResolveCanonicalChatAddress.mockImplementation((target) =>
      Promise.resolve({
        projectId: target.projectId,
        taskId: target.worktreeId,
        chatId: target.chatId,
      }),
    );
    mockReadChatTabsFile.mockResolvedValue({ tabs: [{ id: 'chat-1' }] });
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      ...TARGET,
      importedEventCount: 0,
      importedMessages: [],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    mockBuildClaudeTerminalLaunchConfig.mockImplementation((input) =>
      Promise.resolve({
        executable: getBundledClaudeBinaryPath(),
        args: [],
        env: { [DESKTOP_INTEGRATION_TOKEN_ENV_VAR]: String(input.authToken) },
      }),
    );
  });

  afterEach(async () => {
    try {
      await shutdownServices(services);
    } finally {
      services.clear();
    }
  });

  it('a terminal-mode launch creates its managed terminal through the routed worker.terminal port', async () => {
    const response = await createService().launch(LAUNCH);

    expect(mockEngine.creates).toHaveLength(1);
    const managedCommand = mockEngine.creates[0]?.managedCommand;
    expect(managedCommand).toMatchObject({
      kind: 'claude-code',
      title: 'Claude Code',
      chatId: 'chat-1',
      sessionKey: response.sessionKey,
    });
    const token = managedCommand?.env?.[DESKTOP_INTEGRATION_TOKEN_ENV_VAR];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.terminalId).toBe('terminal-1');
    expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledTimes(1);
    expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: response.sessionKey,
        authToken: token,
      }),
    );
  });

  it('interrupt writes Escape and cleanup kills through the port', async () => {
    const service = createService();
    const response = await service.launch(LAUNCH);
    await service.markHookState({
      sessionKey: response.sessionKey,
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'long running task' },
    });

    // Main writes Escape itself only when it interrupts a running turn at shutdown.
    const stopping = service.shutdown({ recordInterrupted: true });
    await flushTerminalEventTasks();
    expect(mockEngine.writes).toContainEqual(['terminal-1', '\u001b']);

    await service.markHookState({
      sessionKey: response.sessionKey,
      hookEventName: 'Stop',
      hookPayload: {},
    });
    await stopping;
    expect(mockEngine.kills).toContainEqual([
      'terminal-1',
      { signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL },
    ]);
  });

  it('an exit from the port ends the runtime and unregisters its routes', async () => {
    const service = createService();
    const eventSender = jest.fn<void, [string, unknown]>();
    service.setEventSender(eventSender);
    const response = await service.launch(LAUNCH);

    mockEngine.emitEvent({
      type: 'exit',
      payload: {
        projectId: 'p',
        worktreeId: 'w',
        terminalId: 'terminal-1',
        kind: 'claude-code',
        exitCode: 0,
        signal: null,
      },
    });
    await flushTerminalEventTasks();

    // An exited runtime is announced, then forgotten; the next send relaunches.
    const states = eventSender.mock.calls.filter(
      ([channel]) => channel === IPC_CHANNELS.claudeTerminalStateChanged,
    );
    expect(states.at(-1)?.[1]).toMatchObject({
      ...TARGET,
      turnState: 'exited',
    });
    expect(service.getState('p', 'w', 'chat-1')).toBeUndefined();
    expect(mockUnregisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      response.sessionKey,
    );
  });
});
