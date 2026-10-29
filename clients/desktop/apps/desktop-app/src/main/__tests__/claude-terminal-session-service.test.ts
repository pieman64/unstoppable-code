import type {
  CanonicalChatAddress,
  ChatWatcherEvidence,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import { browserHandoffs } from '../browser/browser-handoffs';
import { terminalPresentationPrompt } from '@canopy/desktop-shared/lib/terminal-presentation';
import {
  stageTerminalPresentationTurn,
  capturePresentationTurn,
  forgetPresentationChat,
} from '../canopy-tools/presentation-state';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  DEFAULT_APPROVAL_DEFAULTS,
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { getAppAdvisorHomeDir } from '../lib/paths';

type MockTabsFile = { tabs: Array<Record<string, unknown>> };
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
};
type MockLaunchConfig = {
  executable: string;
  args: string[];
  env: Record<string, string>;
};
type MockTerminalEventListener = (
  channel: string,
  payload: Record<string, unknown>,
) => void;
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

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  [Record<string, unknown>]
>(() => Promise.resolve());
const mockUnregisterCanopyWorktreeSessionRoute = jest.fn<void, [string]>();
const mockUnregisterMcpProxyRoutesForSession = jest.fn<void, [string]>();
const mockPtyKill = jest.fn<
  void,
  [string, { signalOverride?: string | null }?]
>();
const mockPtyWrite = jest.fn<void, [string, string]>();
const mockRecordInterruptedChats = jest.fn(() => Promise.resolve());
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordInterruptedChats: mockRecordInterruptedChats,
}));
let mockTerminalEventListener: MockTerminalEventListener | undefined;
const mockAddTerminalEventListener = jest.fn<void, [MockTerminalEventListener]>(
  (listener) => {
    mockTerminalEventListener = listener;
  },
);
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
const mockTerminalReceipt = jest.fn(() => false);
const mockAuthorizeRetainedPaste = jest.fn(() => Promise.resolve(undefined));
const mockHandleNewChatStartedEvent = jest.fn();
const mockResolveWorktreeCwd = jest.fn<string, [string, string, string?]>(
  () => '/worktree',
);
const mockResolveWorktreeTargetIds = jest.fn(
  (projectId: string, worktreeId: string) => ({ projectId, worktreeId }),
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
const mockSpawnManagedTerminal = jest.fn<{ id: string }, [unknown]>(() => ({
  id: 'terminal',
}));
const mockGetCachedClaudeAuthStatusObserved = jest.fn(() =>
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
jest.mock('../canopy-tools/ledger-tools-runtime', () => ({
  mayExposeLedgerTools: (target: Record<string, unknown>): boolean =>
    mockMayExposeLedgerTools(target),
  openLedgerChatTools: (
    options: MockOpenLedgerChatToolsOptions,
  ): Promise<MockLedgerTools | null> => mockOpenLedgerChatTools(options),
}));

const mockCaptureSessionWorkOwner = jest.fn();
const mockResolveSessionWorkOwner = jest.fn();

jest.mock('../agents/work-owner', () => ({
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

jest.mock('../lib/app-advisor-workspace', () => ({
  ensureAppAdvisorHomeScaffold: jest.fn(() => Promise.resolve()),
}));

jest.mock('../terminal/pty-manager', () => ({
  ptyManager: {
    addEventListener: mockAddTerminalEventListener,
    kill: mockPtyKill,
    write: mockPtyWrite,
  },
}));

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
    startChatTurn: mockStartChatTurn,
    observeChatEvent: mockObserveChatEvent,
    completeChatTurn: mockCompleteChatTurn,
    recordInjectedPromptForOpenChatTurn:
      mockRecordInjectedPromptForOpenChatTurn,
  })),
}));

jest.mock('../auth/provider-auth-state', () => ({
  getCachedClaudeAuthStatusObserved: mockGetCachedClaudeAuthStatusObserved,
}));

jest.mock('../lib/claude-tui-chats', () => ({
  isClaudeTuiChatsEnabled: mockIsClaudeTuiChatsEnabled,
}));

jest.mock('../lib/turn-diff-capture', () => ({
  captureTurnStart: mockCaptureTurnStart,
  captureTurnEndAndDiff: mockCaptureTurnEndAndDiff,
}));

const mockScheduleCodeGraphBuild = jest.fn();
jest.mock('../lib/code-graph-scheduler', () => ({
  scheduleCodeGraphBuild: mockScheduleCodeGraphBuild,
}));

jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: (): { hasGraph: jest.Mock } => ({
    hasGraph: mockHasCodeGraph,
  }),
}));

jest.mock('../integration/desktop-integration-server', () => ({
  getDesktopIntegrationServer: jest.fn(() => ({
    ensureStarted: mockEnsureStarted,
    registerCanopyWorktreeSessionRoute: mockRegisterCanopyWorktreeSessionRoute,
    unregisterCanopyWorktreeSessionRoute:
      mockUnregisterCanopyWorktreeSessionRoute,
    unregisterMcpProxyRoutesForSession: mockUnregisterMcpProxyRoutesForSession,
  })),
}));

jest.mock('../integration/claude-terminal-transcript-sync', () => ({
  isAllowedClaudeTerminalTranscriptPath: (
    transcriptPath: string,
    runtimeDir: string,
  ): boolean =>
    transcriptPath === runtimeDir ||
    transcriptPath.startsWith(`${runtimeDir}/`),
  syncClaudeTerminalTranscript: mockSyncClaudeTerminalTranscript,
  readTerminalWatcherObservations: (): Promise<unknown[]> =>
    mockReadWatcherObservations(),
  writeTerminalWatcherObservations: mockWriteWatcherObservations,
  terminalWatcherObservationsPath: (runtimeDir: string): string =>
    `${runtimeDir}.watcher-observations.json`,
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: mockReadChatTabsFile,
}));

jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: mockWriteChatTabsFile,
}));

jest.mock('../lib/preferences-store', () => ({
  // Not degraded: approval resolution fails closed when this is non-null.
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: mockReadPreferencesFile,
}));

jest.mock('../lib/approvals-persistence', () => ({
  readWorkspaceApprovals: mockReadWorkspaceApprovals,
}));

jest.mock('../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: mockReadWorkspaceApprovalsManifest,
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: mockResolveWorktreeCwd,
  resolveWorktreeTargetIds: mockResolveWorktreeTargetIds,
}));

jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: (context: Record<string, unknown>): unknown =>
    mockCreateApprovalSession(context),
}));

jest.mock('../integration/claude-terminal-settings', () => ({
  buildClaudeTerminalLaunchConfig: mockBuildClaudeTerminalLaunchConfig,
}));

jest.mock('../integration/claude-workspace-trust', () => ({
  ensureClaudeWorkspaceTrust: mockEnsureClaudeWorkspaceTrust,
}));

jest.mock('../services/terminal-service', () => ({
  spawnManagedTerminal: mockSpawnManagedTerminal,
  hasTerminalWriteReceipt: mockTerminalReceipt,
}));

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: jest.fn(() => ({
    ingestProviderEvent: mockIngestProviderEvent,
    authorizeRetainedTerminalAgentInputWrite: mockAuthorizeRetainedPaste,
    getInitialChatTitlePrompt: mockGetInitialChatTitlePrompt,
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
jest.mock('../lib/plan-file-sync', () => ({
  getPlanFileSyncService: (): { beginTurn: typeof mockBeginPlanTurn } => ({
    beginTurn: mockBeginPlanTurn,
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

jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    handleChatTerminalEvent: mockHandleChatTerminalEvent,
    handleCanonicalChatStartedEvent: mockCanonicalStarted,
    handleCanonicalChatTerminalEvent: mockCanonicalTerminal,
    handleNewChatStartedEvent: mockHandleNewChatStartedEvent,
    releaseChatDeliveryAuthority: mockReleaseWatcherAuthority,
  })),
}));

const mockResolveCanonicalChatAddress = jest.fn<
  Promise<CanonicalChatAddress | null>,
  [{ projectId: string; worktreeId: string; chatId: string }]
>();
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

jest.mock('../services/active-chat-input', () => ({
  resolveCanonicalChatAddress: mockResolveCanonicalChatAddress,
  captureChatWatcherEvidence: (): Promise<ChatWatcherEvidence> =>
    Promise.resolve({
      sourceOwner: { kind: 'personal' },
      accountEpoch: 4,
    }),
  checkWatcherDeliveryIngress: mockWatcherIngress,
  WatcherDeliveryHeldError: class extends Error {
    public readonly outcome = 'held';
    public constructor(public readonly reason: string) {
      super('held');
    }
  },
}));

import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { DefaultClaudeTerminalSessionService } from '../integration/claude-terminal-session-service';
import { noteWatcherDeliveryAuthorityChange } from '../services/watcher-delivery-authority';
import { enqueueChatTabMutation } from '../lib/chat-tab-mutation-queue';
import { CLAUDE_CODE_GRAPH_STEERING_CONTEXT } from '../lib/claude-code-graph-steering';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT } from '../agents/claude-approval-adapter';

describe('claude-terminal-session-service', () => {
  const services = new Set<DefaultClaudeTerminalSessionService>();

  it('waits for every service shutdown before surfacing failures', async () => {
    const failure = new Error('shutdown failed');
    let finishSlowShutdown: (() => void) | undefined;
    const slowShutdown = new Promise<void>((resolve) => {
      finishSlowShutdown = resolve;
    });
    const shutdownPromise = shutdownServices([
      { shutdown: (): Promise<void> => Promise.reject(failure) },
      { shutdown: (): Promise<void> => slowShutdown },
    ]);
    const earlyOutcome = await Promise.race([
      shutdownPromise.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'pending'>((resolve) => {
        setImmediate(() => resolve('pending'));
      }),
    ]);
    expect(earlyOutcome).toBe('pending');

    finishSlowShutdown?.();
    await expect(shutdownPromise).rejects.toBe(failure);
  });

  function createService(): DefaultClaudeTerminalSessionService {
    const service = new DefaultClaudeTerminalSessionService();
    services.add(service);
    return service;
  }

  afterEach(async () => {
    // Stop hooks own delayed transcript syncs. Dispose each fixture before the
    // next test resets shared mocks or switches between real and fake timers.
    try {
      await shutdownServices(services);
    } finally {
      services.clear();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockWatcherObservations = [];
    mockResolveCanonicalChatAddress.mockReset();
    mockResolveCanonicalChatAddress.mockImplementation((target) =>
      Promise.resolve(
        target.projectId === APP_ADVISOR_PROJECT_ID
          ? {
              botId: 'app_advisor',
              taskId: target.worktreeId,
              chatId: target.chatId,
            }
          : {
              projectId: target.projectId,
              taskId: target.worktreeId,
              chatId: target.chatId,
            },
      ),
    );
    mockCanonicalTerminal.mockReset();
    mockWatcherIngress.mockResolvedValue({ allowed: true });
    mockTerminalReceipt.mockReturnValue(false);
    mockResolveSessionWorkOwner.mockResolvedValue({ kind: 'personal' });
    mockTerminalEventListener = undefined;
    mockGetCachedClaudeAuthStatusObserved.mockResolvedValue({
      authenticated: true,
      accountLabel: 'dev@example.com',
      detail: null,
      error: null,
    });
    mockIsClaudeTuiChatsEnabled.mockReturnValue(true);
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      importedMessages: [
        {
          id: 'imported-message',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Imported from Claude Code' }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    mockReadChatTabsFile.mockResolvedValue({ tabs: [{ id: 'chat' }] });
    mockWriteChatTabsFile.mockResolvedValue(undefined);
    mockReadPreferencesFile.mockResolvedValue({
      approvalDefaults: DEFAULT_APPROVAL_DEFAULTS,
    });
    mockResolveWorktreeCwd.mockReturnValue('/worktree');
    mockResolveWorktreeTargetIds.mockImplementation(
      (projectId: string, worktreeId: string) => ({ projectId, worktreeId }),
    );
    mockAccess.mockRejectedValue(new Error('missing'));
    mockReaddir.mockResolvedValue([]);
    mockBuildClaudeTerminalLaunchConfig.mockResolvedValue({
      executable: '/bin/claude',
      args: [],
      env: {},
    });
    mockEnsureClaudeWorkspaceTrust.mockImplementation((cwd) =>
      Promise.resolve({ trustedPath: cwd, updated: false }),
    );
    mockSpawnManagedTerminal.mockReturnValue({ id: 'terminal' });
    mockHasCodeGraph.mockReset();
    mockHasCodeGraph.mockReturnValue(false);
    mockPlanTurnLeases.length = 0;
    mockResolvePlanTurnScope.mockReset();
    mockResolvePlanTurnScope.mockImplementation((projectId, worktreeId) => ({
      projectId,
      worktreeId,
    }));
  });

  function seedService(
    projectId = 'p',
    worktreeId = 'w',
    assistantMode: 'default' | 'app-advisor' = 'default',
    recordOverrides: {
      approvalMode?: 'full-access';
      approvalSession?: { check: jest.Mock; dispose: jest.Mock };
      planMode?: boolean;
    } = {},
  ): DefaultClaudeTerminalSessionService {
    const service = createService();
    const record = {
      projectId,
      worktreeId,
      chatId: 'chat',
      runtimeDir: '/runtime',
      cwd: '/worktree',
      authToken: 'secret',
      assistantMode,
      planMode: false,
      auditTurnOpen: false,
      turnUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      turnDiffCaptureActive: false,
      codeGraphToolsAdvertised: true,
      codeGraphAvailableThisTurn: true,
      codeGraphOrientedThisTurn: false,
      codeGraphOrientationBlockedThisTurn: false,
      state: {
        turnState: 'idle',
        sessionKey: 'session',
        sdkSessionId: 'sdk',
        terminalId: 'terminal',
      },
      ...recordOverrides,
    };
    (
      service as unknown as {
        records: Map<string, unknown>;
      }
    ).records.set(`${projectId}\0${worktreeId}\0chat`, record);
    (
      service as unknown as {
        recordsByTerminalId: Map<string, unknown>;
      }
    ).recordsByTerminalId.set('terminal', record);
    return service;
  }

  async function flushTerminalEventTasks(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
  }

  it('marks the runtime ready for input on the first hook callback', async () => {
    const service = seedService();

    // Seeded state mimics a fresh spawn: idle, but no hook callback yet.
    expect(service.getState('p', 'w', 'chat')?.readyForInput).not.toBe(true);

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'SessionStart',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });

    expect(service.getState('p', 'w', 'chat')?.readyForInput).toBe(true);
  });

  it('preserves the renderer window accessor across a deferred-tools relaunch', async () => {
    const registerResumeHandler = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );
    const getWindow = jest.fn(() => null);
    const service = createService();

    await service.launch(
      {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      },
      {
        getWindow,
        executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
    );
    expect(mockCaptureSessionWorkOwner).toHaveBeenCalledWith({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    });
    const registration = registerResumeHandler.mock.calls.find(
      ([scope]) => scope.chatId === 'chat',
    );
    const resume = registration?.[1];
    if (!resume) throw new Error('Expected deferred-tools resume handler');

    await resume({
      scope: { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
      requestId: 'reload-request',
      toolCallId: 'tool-call',
      userMessageId: 'message',
      continuationText: '<system_instruction>Continue</system_instruction>',
      enabledResources: [],
      providerType: 'claude',
      signal: new AbortController().signal,
    });

    expect(mockCreateApprovalSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ getWindow }),
    );
    expect(mockCreateApprovalSession).toHaveBeenCalledTimes(2);
    await service.shutdown();
    registerResumeHandler.mockRestore();
  });

  it('keeps the running turn id across a deferred-tools relaunch', async () => {
    const registerResumeHandler = jest.spyOn(
      deferredToolsReloadCoordinator,
      'registerResumeHandler',
    );
    const service = createService();
    await service.launch(
      { projectId: 'p', worktreeId: 'w', chatId: 'chat', cols: 80, rows: 24 },
      {},
    );
    const sessionKey = (): string =>
      service.getState('p', 'w', 'chat')?.sessionKey ?? '';
    await service.markHookState({
      sessionKey: sessionKey(),
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'Load the tools and continue.' },
    });
    const turn = service.runningTurnUserMessageId('p', 'w', 'chat');
    expect(turn).toMatch(/^msg-terminal-/);

    const resume = registerResumeHandler.mock.calls.find(
      ([scope]) => scope.chatId === 'chat',
    )?.[1];
    if (!resume) throw new Error('Expected deferred-tools resume handler');
    await resume({
      scope: { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
      requestId: 'reload-request',
      toolCallId: 'tool-call',
      userMessageId: 'message',
      continuationText: '<system_instruction>Continue</system_instruction>',
      enabledResources: [],
      providerType: 'claude',
      signal: new AbortController().signal,
    });
    await service.markHookState({
      sessionKey: sessionKey(),
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    expect(service.runningTurnUserMessageId('p', 'w', 'chat')).toBe(turn);
    await service.shutdown();
    registerResumeHandler.mockRestore();
  });

  it('denies PreToolUse when the terminal approval session is unavailable', async () => {
    const service = seedService();
    const result = await service.handleHookCallback('session', {
      hookEventName: 'PreToolUse',
      hookPayload: {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      },
    });

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Approval session is unavailable.',
      },
    });
  });

  it('leaves App Advisor WatchCommand approval to its scoped runtime', async () => {
    const service = seedService(
      APP_ADVISOR_PROJECT_ID,
      APP_ADVISOR_WORKTREE_ID,
      'app-advisor',
    );

    await expect(
      service.handleHookCallback('session', {
        hookEventName: 'PreToolUse',
        hookPayload: {
          tool_name: APP_ADVISOR_TOOL_REGISTRY.watch_command.claudeToolName,
          tool_input: { command: 'printf ready' },
        },
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

  it('denies malformed PreToolUse payloads instead of falling through', async () => {
    const service = seedService();
    const record = Array.from(
      (
        service as unknown as {
          records: Map<string, { approvalSession?: unknown }>;
        }
      ).records.values(),
    )[0];
    record.approvalSession = {
      dispose: jest.fn(),
      check: jest.fn(),
    };
    const handleHookCallback = (
      service as unknown as {
        handleHookCallback: (
          sessionKey: string,
          body: {
            hookEventName: string;
            hookPayload: unknown;
          },
        ) => Promise<unknown>;
      }
    ).handleHookCallback.bind(service);

    await expect(
      handleHookCallback('session', {
        hookEventName: 'PreToolUse',
        hookPayload: 'malformed',
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Malformed approval hook payload.',
      },
    });
    await expect(
      handleHookCallback('session', {
        hookEventName: 'PreToolUse',
        hookPayload: { tool_name: '', tool_input: null },
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Invalid tool name or input.',
      },
    });
  });

  it.each([
    ['ask', 'allow'],
    ['ask', 'deny'],
    ['auto', 'allow'],
    ['auto', 'deny'],
    ['full-access', 'allow'],
  ] as const)(
    'uses %s terminal approvals with %s decisions in plan mode',
    async (approvalMode, decision) => {
      const service = seedService();
      const check = jest.fn().mockResolvedValue({
        decision,
        ...(decision === 'deny' ? { message: 'Session policy decision' } : {}),
      });
      const record = Array.from(
        (
          service as unknown as {
            records: Map<
              string,
              {
                planMode: boolean;
                cwd: string;
                approvalMode?: string;
                approvalSession?: unknown;
              }
            >;
          }
        ).records.values(),
      )[0];
      record.planMode = true;
      record.approvalMode = approvalMode;
      record.approvalSession = { check, dispose: jest.fn() };

      const result = await (
        service as unknown as {
          handleHookCallback: (
            sessionKey: string,
            body: {
              hookEventName: string;
              hookPayload: Record<string, unknown>;
            },
          ) => Promise<unknown>;
        }
      ).handleHookCallback('session', {
        hookEventName: 'PreToolUse',
        hookPayload: {
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
        },
      });

      expect(result).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          ...(decision === 'deny'
            ? { permissionDecisionReason: 'Session policy decision' }
            : {}),
        },
      });
      if (approvalMode === 'full-access') {
        expect(check).not.toHaveBeenCalled();
      } else {
        expect(check).toHaveBeenCalledWith(
          { kind: 'command', command: 'npm test', cwd: record.cwd },
          expect.any(Object),
        );
      }
    },
  );

  it('bypasses fail-closed approval parsing in Full Access', async () => {
    const service = seedService();
    const check = jest.fn();
    const record = Array.from(
      (
        service as unknown as {
          records: Map<
            string,
            {
              approvalMode?: 'ask' | 'auto' | 'full-access';
              approvalSession?: unknown;
            }
          >;
        }
      ).records.values(),
    )[0];
    record.approvalMode = 'full-access';
    record.approvalSession = { check, dispose: jest.fn() };

    const result = await service.handleHookCallback('session', {
      hookEventName: 'PreToolUse',
      hookPayload: {
        tool_name: 'WebSearch',
        tool_input: { query: 'release notes' },
      },
    });

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
    expect(check).not.toHaveBeenCalled();
  });

  it('updates live terminal plan and approval modes', async () => {
    const service = seedService();
    const setMode = jest.fn();
    const record = Array.from(
      (
        service as unknown as {
          records: Map<
            string,
            { planMode: boolean; approvalSession?: unknown }
          >;
        }
      ).records.values(),
    )[0];
    record.approvalSession = { setMode, dispose: jest.fn() };

    await service.setPlanMode('p', 'w', 'chat', false);
    await service.setApprovalMode('p', 'w', 'chat', 'ask');

    expect(record.planMode).toBe(false);
    expect(setMode).toHaveBeenCalledWith('ask');
  });

  it('retains approval-mode changes while the terminal session is starting', async () => {
    const service = seedService();
    const record = Array.from(
      (
        service as unknown as {
          records: Map<
            string,
            {
              approvalSession?: unknown;
              pendingApprovalMode?: 'ask' | 'auto' | 'full-access';
            }
          >;
        }
      ).records.values(),
    )[0];

    await service.setApprovalMode('p', 'w', 'chat', 'auto');

    expect(record.pendingApprovalMode).toBe('auto');
  });

  it('tears down a Full Access terminal before applying a stricter mode', async () => {
    const service = seedService();
    const dispose = jest.fn();
    const record = Array.from(
      (
        service as unknown as {
          records: Map<
            string,
            {
              approvalMode?: 'ask' | 'auto' | 'full-access';
              approvalSession?: unknown;
            }
          >;
        }
      ).records.values(),
    )[0];
    record.approvalMode = 'full-access';
    record.approvalSession = { setMode: jest.fn(), dispose };

    await service.setApprovalMode('p', 'w', 'chat', 'ask');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
  });

  it('retains approval-mode changes before the terminal runtime record exists', async () => {
    const service = createService();

    await service.setApprovalMode('p', 'w', 'chat', 'ask');

    expect(
      (
        service as unknown as {
          pendingApprovalModes: Map<string, 'ask' | 'auto' | 'full-access'>;
        }
      ).pendingApprovalModes.get('p\0w\0chat'),
    ).toBe('ask');
  });

  it('retains a live Auto-to-Ask downgrade for a deferred relaunch', async () => {
    const service = seedService();
    const record = Array.from(
      (
        service as unknown as {
          records: Map<
            string,
            {
              approvalMode?: 'ask' | 'auto' | 'full-access';
              approvalSession?: unknown;
            }
          >;
        }
      ).records.values(),
    )[0];
    record.approvalMode = 'auto';
    record.approvalSession = { setMode: jest.fn(), dispose: jest.fn() };

    await service.setApprovalMode('p', 'w', 'chat', 'ask');

    expect(
      (
        service as unknown as {
          pendingApprovalModes: Map<string, 'ask' | 'auto' | 'full-access'>;
        }
      ).pendingApprovalModes.get('p\0w\0chat'),
    ).toBe('ask');
  });

  it('retains plan-mode changes before the terminal runtime record exists', async () => {
    const service = createService();

    await service.setPlanMode('p', 'w', 'chat', true);

    expect(
      (
        service as unknown as {
          pendingPlanModes: Map<string, boolean>;
        }
      ).pendingPlanModes.get('p\0w\0chat'),
    ).toBe(true);
  });

  it('applies a plan-mode change that arrives during terminal startup', async () => {
    let resolveTabs:
      | ((value: {
          tabs: Array<{
            id: string;
            providerType: 'claude';
            sdkSessionId: string;
            planMode: boolean;
          }>;
        }) => void)
      | undefined;
    mockReadChatTabsFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTabs = resolve;
        }),
    );
    const service = createService();
    const launch = service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    });
    while (mockReadChatTabsFile.mock.calls.length === 0) {
      await Promise.resolve();
    }

    await service.setPlanMode('p', 'w', 'chat', true);
    resolveTabs?.({
      tabs: [
        {
          id: 'chat',
          providerType: 'claude',
          sdkSessionId: 'sdk',
          planMode: false,
        },
      ],
    });
    await launch;

    expect(mockBuildClaudeTerminalLaunchConfig).toHaveBeenCalledWith(
      expect.objectContaining({ planMode: true }),
    );
  });

  it('retains a stricter plan mode while tearing down a live terminal', async () => {
    const service = seedService();

    await service.setPlanMode('p', 'w', 'chat', true);

    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
    expect(
      (
        service as unknown as {
          pendingPlanModes: Map<string, boolean>;
        }
      ).pendingPlanModes.get('p\0w\0chat'),
    ).toBe(true);
  });

  it('retains disabled plan mode while tearing down a live Plan terminal', async () => {
    const service = seedService();
    const record = Array.from(
      (
        service as unknown as {
          records: Map<string, { planMode: boolean }>;
        }
      ).records.values(),
    )[0];
    record.planMode = true;

    await service.setPlanMode('p', 'w', 'chat', false);

    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
    expect(
      (
        service as unknown as {
          pendingPlanModes: Map<string, boolean>;
        }
      ).pendingPlanModes.get('p\0w\0chat'),
    ).toBe(false);
  });

  it('stops the terminal turn when the approval outcome requests it', async () => {
    const service = seedService();
    const record = Array.from(
      (
        service as unknown as {
          records: Map<string, { approvalSession?: unknown }>;
        }
      ).records.values(),
    )[0];
    record.approvalSession = {
      dispose: jest.fn(),
      check: jest.fn().mockResolvedValue({
        decision: 'deny',
        message: 'Denied by the user.',
        stopTurn: true,
      }),
    };

    const result = await (
      service as unknown as {
        handleHookCallback: (
          sessionKey: string,
          body: {
            hookEventName: string;
            hookPayload: Record<string, unknown>;
          },
        ) => Promise<unknown>;
      }
    ).handleHookCallback('session', {
      hookEventName: 'PreToolUse',
      hookPayload: {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_use_id: 'tool-1',
      },
    });

    expect(result).toEqual({
      continue: false,
      stopReason: 'Denied by the user.',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Denied by the user.',
      },
    });
  });

  it('steers broad terminal exploration, resets per user turn, and seeds subagents', async () => {
    mockHasCodeGraph.mockReturnValue(true);
    const service = seedService('p', 'w', 'default', {
      approvalMode: 'full-access',
      approvalSession: { check: jest.fn(), dispose: jest.fn() },
    });

    const handleHookCallback = (
      hookEventName: string,
      hookPayload: Record<string, unknown>,
    ): Promise<unknown> =>
      service.handleHookCallback('session', { hookEventName, hookPayload });

    await expect(
      handleHookCallback('PreToolUse', {
        tool_name: 'Grep',
        tool_input: { pattern: 'launch', path: '/worktree/src' },
        tool_use_id: 'grep-1',
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
        additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      },
    });

    await handleHookCallback('PreToolUse', {
      tool_name: 'mcp__canopy__GetCodeGraphContext',
      tool_input: {},
      tool_use_id: 'graph-1',
    });
    await expect(
      handleHookCallback('PreToolUse', {
        tool_name: 'Glob',
        tool_input: { pattern: '**/*.ts', path: '/worktree' },
        tool_use_id: 'glob-before-post',
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
        additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      },
    });

    await handleHookCallback('PostToolUse', {
      tool_name: 'mcp__canopy__GetCodeGraphContext',
      tool_input: {},
      tool_response: {},
      tool_use_id: 'graph-1',
    });
    await expect(
      handleHookCallback('PreToolUse', {
        tool_name: 'Glob',
        tool_input: { pattern: '**/*.ts', path: '/worktree' },
        tool_use_id: 'glob-1',
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });

    await handleHookCallback('UserPromptSubmit', {});
    await expect(
      handleHookCallback('PreToolUse', {
        tool_name: 'Grep',
        tool_input: { pattern: 'launch', path: '/worktree/src' },
        tool_use_id: 'grep-2',
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
        additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      },
    });
    await expect(
      handleHookCallback('SubagentStart', {
        agent_id: 'agent-1',
        agent_type: 'Explore',
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      },
    });
    expect(mockHasCodeGraph).toHaveBeenCalledWith('p', 'w');
  });

  it('does not steer terminal exploration toward unavailable graph tools in plan mode', async () => {
    const service = seedService('p', 'w', 'default', {
      approvalMode: 'full-access',
      approvalSession: { check: jest.fn(), dispose: jest.fn() },
      planMode: true,
    });

    await expect(
      service.handleHookCallback('session', {
        hookEventName: 'PreToolUse',
        hookPayload: {
          tool_name: 'mcp__canopy__GetCodeGraphContext',
          tool_input: {},
          tool_use_id: 'graph-plan',
        },
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });

    await service.handleHookCallback('session', {
      hookEventName: 'PostToolUse',
      hookPayload: {
        tool_name: 'mcp__canopy__GetCodeGraphContext',
        tool_input: {},
        tool_response: {},
        tool_use_id: 'graph-plan',
      },
    });

    await expect(
      service.handleHookCallback('session', {
        hookEventName: 'PreToolUse',
        hookPayload: {
          tool_name: 'Grep',
          tool_input: { pattern: 'launch', path: '/worktree/src' },
          tool_use_id: 'grep-plan',
        },
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

  it('does not count a denied terminal graph call as orientation', async () => {
    mockHasCodeGraph.mockReturnValue(true);
    const check = jest
      .fn()
      .mockResolvedValueOnce({
        decision: 'deny',
        message: 'Graph access denied.',
      })
      .mockResolvedValueOnce({ decision: 'allow' });
    const service = seedService('p', 'w', 'default', {
      approvalMode: 'ask',
      approvalSession: { check, dispose: jest.fn() },
    });

    await expect(
      service.handleHookCallback('session', {
        hookEventName: 'PreToolUse',
        hookPayload: {
          tool_name: 'mcp__canopy__GetCodeGraphContext',
          tool_input: {},
          tool_use_id: 'graph-denied',
        },
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'Graph access denied.',
      },
    });
    await expect(
      service.handleHookCallback('session', {
        hookEventName: 'PreToolUse',
        hookPayload: {
          tool_name: 'Grep',
          tool_input: { pattern: 'launch', path: '/worktree/src' },
          tool_use_id: 'grep-after-denied-graph',
        },
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'allow',
        additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
      },
    });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('checks every bounded WebSearch domain in terminal hook mode', async () => {
    const service = seedService();
    const check = jest
      .fn()
      .mockResolvedValueOnce({ decision: 'allow' })
      .mockResolvedValueOnce({
        decision: 'deny',
        message: 'Blocked network domain.',
      });
    const record = Array.from(
      (
        service as unknown as {
          records: Map<string, { approvalSession?: unknown }>;
        }
      ).records.values(),
    )[0];
    record.approvalSession = { check, dispose: jest.fn() };

    const result = await (
      service as unknown as {
        handleHookCallback: (
          sessionKey: string,
          body: {
            hookEventName: string;
            hookPayload: Record<string, unknown>;
          },
        ) => Promise<unknown>;
      }
    ).handleHookCallback('session', {
      hookEventName: 'PreToolUse',
      hookPayload: {
        tool_name: 'WebSearch',
        tool_input: {
          query: 'release notes',
          allowed_domains: ['docs.example.com', 'support.example.com'],
        },
        tool_use_id: 'tool-search',
      },
    });

    expect(check).toHaveBeenNthCalledWith(
      1,
      { kind: 'network', host: 'docs.example.com' },
      expect.objectContaining({ toolUseId: 'tool-search' }),
    );
    expect(check).toHaveBeenNthCalledWith(
      2,
      { kind: 'network', host: 'support.example.com' },
      expect.objectContaining({ toolUseId: 'tool-search' }),
    );
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Blocked network domain.',
      },
    });
  });

  it('uses the named Skill title and display in terminal approval hooks', async () => {
    const service = seedService();
    const check = jest.fn().mockResolvedValue({ decision: 'allow' });
    const record = Array.from(
      (
        service as unknown as {
          records: Map<string, { approvalSession?: unknown }>;
        }
      ).records.values(),
    )[0];
    record.approvalSession = { check, dispose: jest.fn() };

    const result = await service.handleHookCallback('session', {
      hookEventName: 'PreToolUse',
      hookPayload: {
        tool_name: 'Skill',
        tool_input: { skill: 'dataviz' },
        tool_use_id: 'tool-skill',
      },
    });

    expect(check).toHaveBeenCalledWith(
      { kind: 'tool', toolName: 'Skill' },
      expect.objectContaining({
        title: 'Claude Code wants to use skill dataviz',
        details: { kind: 'tool', toolName: 'dataviz' },
        suggestedTarget: { kind: 'tool', toolName: 'Skill' },
        toolUseId: 'tool-skill',
      }),
    );
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

  it.each(['p', 'real-cowork-project', APP_ADVISOR_PROJECT_ID])(
    'emits canonical lifecycle after durable import for %s',
    async (projectId) => {
      let tabs: MockTabsFile = {
        tabs: [
          { id: 'chat', messages: [], newChatStartedWatcherPending: true },
        ],
      };
      mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
      mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
        tabs = next;
        return Promise.resolve();
      });
      const service = seedService(projectId);
      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'UserPromptSubmit',
        hookPayload: { prompt: 'hello' },
      });
      expect(mockCanonicalStarted).not.toHaveBeenCalled();
      mockSyncClaudeTerminalTranscript.mockResolvedValue({
        projectId,
        worktreeId: 'w',
        chatId: 'chat',
        importedEventCount: 3,
        importedMessages: [
          {
            id: 'canonical-root',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'hello' }],
          },
          {
            id: 'reply',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'done' }],
          },
          {
            id: 'timer',
            role: 'system',
            timestamp: 3,
            blocks: [{ type: 'turn_timer', completedAt: 3 }],
          },
        ],
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      });
      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'Stop',
        hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
      });
      const address =
        projectId === APP_ADVISOR_PROJECT_ID
          ? { botId: 'app_advisor', taskId: 'w', chatId: 'chat' }
          : { projectId, taskId: 'w', chatId: 'chat' };
      expect(mockCanonicalStarted).toHaveBeenCalledWith(
        expect.objectContaining({
          address,
          sourceInputId: 'canonical-root',
          kind: 'started',
        }),
      );
      expect(mockCanonicalTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          address,
          sourceInputId: 'canonical-root',
          disposition: 'completed',
          kind: 'terminal',
        }),
      );
      expect(mockIngestProviderEvent.mock.invocationCallOrder[0]).toBeLessThan(
        mockCanonicalTerminal.mock.invocationCallOrder[0],
      );
      expect(mockHandleChatTerminalEvent).not.toHaveBeenCalled();
      expect(mockHandleNewChatStartedEvent).not.toHaveBeenCalled();
      expect(
        mockWriteChatTabsFile.mock.calls.every((call) =>
          call[2].tabs.every((tab) => !('terminalWatcherObservations' in tab)),
        ),
      ).toBe(true);
    },
  );

  it('writes at most once per sync and prunes only fully delivered observations', async () => {
    const observations = Array.from({ length: 12 }, (_, index) => ({
      id: `observation-${index}`,
      address: { projectId: 'p', taskId: 'w', chatId: 'chat' },
      evidence: { sourceOwner: { kind: 'personal' } },
      acceptedAt: new Date(1).toISOString(),
      sourceInputId: `root-${index}`,
      previousRootIds: [],
      startsChat: index === 0,
      terminalAt: new Date(10).toISOString(),
      disposition: 'interrupted',
      waitForDuration: false,
      transcriptPath: '/runtime/allowed.jsonl',
    }));
    mockWatcherObservations = observations;
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', sdkSessionId: 'sdk' }],
    });
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 0,
      importedMessages: observations.slice(0, 11).map((item) => ({
        id: item.sourceInputId,
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'work' }],
      })),
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    const service = createService();
    await service.resumePendingObservations({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });
    expect(mockWriteWatcherObservations.mock.calls.length).toBeLessThanOrEqual(
      1,
    );
    expect(mockCanonicalTerminal).toHaveBeenCalledTimes(11);
    expect(mockWatcherObservations).toEqual([observations[11]]);
    mockWriteWatcherObservations.mockClear();
    await service.resumePendingObservations({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });
    expect(mockWriteWatcherObservations).not.toHaveBeenCalled();
  });

  it('interrupts an offline open observation even when persisted state has the same old session key', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [
        {
          id: 'chat',
          sdkSessionId: 'sdk',
          claudeTerminal: { turnState: 'running', sessionKey: 'dead-runtime' },
        },
      ],
    });
    mockWatcherObservations = [
      {
        id: 'offline',
        address: { projectId: 'p', taskId: 'w', chatId: 'chat' },
        evidence: { sourceOwner: { kind: 'personal' } },
        acceptedAt: new Date(1).toISOString(),
        sourceInputId: 'offline-root',
        previousRootIds: [],
        startsChat: false,
        runtimeGeneration: 'dead-runtime',
        transcriptPath: '/runtime/allowed.jsonl',
      },
    ];
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      importedMessages: [
        {
          id: 'offline-root',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'old' }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    await createService().resumePendingObservations({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });
    expect(mockCanonicalTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInputId: 'offline-root',
        disposition: 'interrupted',
      }),
    );
    expect(mockWatcherObservations).toEqual([]);
    expect(mockWriteWatcherObservations).toHaveBeenCalledTimes(1);
  });

  it('publishes an old-runtime Stop observation still waiting for its duration record', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [
        {
          id: 'chat',
          sdkSessionId: 'sdk',
          claudeTerminal: { turnState: 'idle', sessionKey: 'dead-runtime' },
        },
      ],
    });
    // The CLI exited after Stop but before writing the turn duration.
    mockWatcherObservations = [
      {
        id: 'stopped',
        address: { projectId: 'p', taskId: 'w', chatId: 'chat' },
        evidence: { sourceOwner: { kind: 'personal' } },
        acceptedAt: new Date(1).toISOString(),
        sourceInputId: 'stopped-root',
        previousRootIds: [],
        startsChat: false,
        runtimeGeneration: 'dead-runtime',
        transcriptPath: '/runtime/allowed.jsonl',
        terminalAt: new Date(3).toISOString(),
        disposition: 'completed',
        waitForDuration: true,
      },
    ];
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 2,
      importedMessages: [
        {
          id: 'stopped-root',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'work' }],
        },
        {
          id: 'stopped-answer',
          role: 'assistant',
          timestamp: 2,
          blocks: [{ type: 'text', text: 'done' }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    await createService().resumePendingObservations({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });
    expect(mockCanonicalTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInputId: 'stopped-root',
        disposition: 'completed',
      }),
    );
  });

  it('launches with watcher observation disabled when the sidecar cannot be read', async () => {
    mockReadChatTabsFile.mockResolvedValue({ tabs: [{ id: 'chat' }] });
    mockReadWatcherObservations.mockRejectedValueOnce(
      new Error('Malformed watcher observations'),
    );
    const service = createService();
    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      }),
    ).resolves.toBeDefined();
    expect(service.getState('p', 'w', 'chat')?.terminalId).toBeDefined();
    expect(mockWriteWatcherObservations).not.toHaveBeenCalled();
  });

  it('never waits on the receipt release between ingress and the paste', async () => {
    mockReadChatTabsFile.mockResolvedValue({ tabs: [{ id: 'chat' }] });
    mockWatcherIngress.mockResolvedValue({ allowed: true });
    // A release still writing the sidecar must not delay the paste.
    mockReleaseWatcherAuthority.mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    const service = seedService();
    const authorized = service.authorizeAgentInputTerminalWrite(
      'terminal',
      'watcher-delivery-3-paste',
    );
    let settled = false;
    void authorized?.then(() => {
      settled = true;
    });
    await flushTerminalEventTasks();
    expect(mockReleaseWatcherAuthority).toHaveBeenCalledWith('delivery-3');
    expect(settled).toBe(true);
  });
  it('re-checks a paste when chat access changes during authorization', async () => {
    mockReadChatTabsFile.mockResolvedValue({ tabs: [{ id: 'chat' }] });
    mockWatcherIngress.mockResolvedValue({ allowed: true });
    const changeAccess = (): Promise<undefined> => {
      noteWatcherDeliveryAuthorityChange();
      return Promise.resolve(undefined);
    };
    mockAuthorizeRetainedPaste.mockImplementationOnce(changeAccess);
    const service = seedService();
    await service.authorizeAgentInputTerminalWrite(
      'terminal',
      'watcher-delivery-4-paste',
    );
    expect(mockAuthorizeRetainedPaste).toHaveBeenCalledTimes(2);
    expect(mockWatcherIngress).toHaveBeenCalledTimes(2);
    expect(mockReleaseWatcherAuthority).toHaveBeenCalledTimes(1);

    mockReleaseWatcherAuthority.mockClear();
    mockAuthorizeRetainedPaste
      .mockImplementationOnce(changeAccess)
      .mockImplementationOnce(changeAccess)
      .mockImplementationOnce(changeAccess);
    await expect(
      service.authorizeAgentInputTerminalWrite(
        'terminal',
        'watcher-delivery-5-paste',
      ),
    ).rejects.toMatchObject({ reason: 'runtime_unavailable' });
    expect(mockReleaseWatcherAuthority).not.toHaveBeenCalled();
  });
  it('releases delivery authority once a watcher paste is authorized', async () => {
    mockReadChatTabsFile.mockResolvedValue({ tabs: [{ id: 'chat' }] });
    mockWatcherIngress.mockResolvedValue({ allowed: true });
    const service = seedService();
    await service.authorizeAgentInputTerminalWrite(
      'terminal',
      'watcher-delivery-1-paste',
    );
    expect(mockReleaseWatcherAuthority).toHaveBeenCalledWith('delivery-1');
    mockWatcherIngress.mockResolvedValue({
      allowed: false,
      outcome: 'held',
      reason: 'owner_boundary',
    });
    mockReleaseWatcherAuthority.mockClear();
    await expect(
      service.authorizeAgentInputTerminalWrite(
        'terminal',
        'watcher-delivery-2-paste',
      ),
    ).rejects.toMatchObject({ reason: 'owner_boundary' });
    expect(mockReleaseWatcherAuthority).not.toHaveBeenCalled();
  });

  it.each(['dead-runtime', undefined])(
    'settles a crashed open observation (%s) before accepting a new runtime prompt',
    async (runtimeGeneration) => {
      mockWatcherObservations = [
        {
          id: 'abandoned',
          address: { projectId: 'p', taskId: 'w', chatId: 'chat' },
          evidence: { sourceOwner: { kind: 'personal' } },
          acceptedAt: new Date(1).toISOString(),
          sourceInputId: 'old-root',
          previousRootIds: [],
          startsChat: true,
          startedDelivered: true,
          runtimeGeneration,
          transcriptPath: '/runtime/allowed.jsonl',
        },
      ];
      let tabs: MockTabsFile = {
        tabs: [
          {
            id: 'chat',
            sdkSessionId: 'sdk',
            newChatStartedWatcherFiredAt: new Date(1).toISOString(),
            messages: [
              {
                id: 'old-root',
                role: 'user',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'old' }],
              },
            ],
          },
        ],
      };
      mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
      mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
        tabs = next;
        return Promise.resolve();
      });
      const service = createService();
      const launched = await service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      });
      await service.markHookState({
        sessionKey: launched.sessionKey,
        hookEventName: 'UserPromptSubmit',
        hookPayload: { prompt: 'new' },
      });
      expect(mockWatcherObservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.any(String) as unknown,
            runtimeGeneration: expect.any(String) as unknown,
            previousRootId: 'old-root',
            startsChat: false,
          }),
        ]),
      );
      mockSyncClaudeTerminalTranscript.mockResolvedValue({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        importedEventCount: 0,
        importedMessages: [
          {
            id: 'old-root',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'old' }],
          },
          {
            id: 'new-root',
            role: 'user',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'new' }],
          },
          {
            id: 'timer',
            role: 'system',
            timestamp: 3,
            blocks: [{ type: 'turn_timer', completedAt: 3 }],
          },
        ],
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      });
      await service.markHookState({
        sessionKey: launched.sessionKey,
        hookEventName: 'Stop',
        hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
      });
      expect(mockCanonicalTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceInputId: 'old-root',
          disposition: 'interrupted',
        }),
      );
      expect(mockCanonicalTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceInputId: 'new-root',
          disposition: 'no_output',
        }),
      );
      expect(mockWatcherObservations).toEqual([]);
    },
  );

  it.each([CODE_REVIEW_CHAT_PROJECT_ID, PLAN_EXPLORE_CHAT_PROJECT_ID])(
    'launches %s with an initial prompt without resolving watcher discovery',
    async (projectId) => {
      mockResolveCanonicalChatAddress.mockRejectedValue(
        new Error('not in discovery'),
      );
      const service = createService();
      await expect(
        service.launch({
          projectId,
          worktreeId: 'scope-id',
          chatId: 'chat',
          cols: 80,
          rows: 24,
          initialPrompt: 'Review this',
        }),
      ).resolves.toBeDefined();
      expect(mockSpawnManagedTerminal).toHaveBeenCalled();
      expect(mockResolveCanonicalChatAddress).not.toHaveBeenCalled();
      expect(mockWriteWatcherObservations).not.toHaveBeenCalled();
    },
  );

  it.each([CODE_REVIEW_CHAT_PROJECT_ID, PLAN_EXPLORE_CHAT_PROJECT_ID])(
    'updates %s prompt hook turn state without watcher discovery',
    async (projectId) => {
      mockResolveCanonicalChatAddress.mockRejectedValue(
        new Error('not in discovery'),
      );
      const service = seedService(projectId, 'scope-id');
      await expect(
        service.markHookState({
          sessionKey: 'session',
          hookEventName: 'UserPromptSubmit',
          hookPayload: {},
        }),
      ).resolves.toBeUndefined();
      expect(service.getState(projectId, 'scope-id', 'chat')?.turnState).toBe(
        'running',
      );
      expect(mockResolveCanonicalChatAddress).not.toHaveBeenCalled();
      expect(mockWriteWatcherObservations).not.toHaveBeenCalled();
    },
  );

  it.each(['rejected', 'missing'])(
    'keeps ordinary project launch and prompt hooks working when watcher discovery is %s',
    async (outcome) => {
      if (outcome === 'rejected')
        mockResolveCanonicalChatAddress.mockRejectedValue(
          new Error('project disappeared'),
        );
      else mockResolveCanonicalChatAddress.mockResolvedValue(null);
      const service = createService();
      await expect(
        service.launch({
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'chat',
          cols: 80,
          rows: 24,
          initialPrompt: 'Hello',
        }),
      ).resolves.toBeDefined();
      const sessionKey = service.getState('p', 'w', 'chat')?.sessionKey;
      if (!sessionKey) throw new Error('missing session key');
      await expect(
        service.markHookState({
          sessionKey,
          hookEventName: 'UserPromptSubmit',
          hookPayload: {},
        }),
      ).resolves.toBeUndefined();
      expect(service.getState('p', 'w', 'chat')?.turnState).toBe('running');
      expect(mockWriteWatcherObservations).not.toHaveBeenCalled();
    },
  );

  it('still records watcher observations for an ordinary project prompt', async () => {
    const service = seedService();
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    expect(mockResolveCanonicalChatAddress).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p', worktreeId: 'w' }),
    );
    expect(mockWriteWatcherObservations).toHaveBeenCalledWith('/runtime', [
      expect.objectContaining({
        address: { projectId: 'p', taskId: 'w', chatId: 'chat' },
      }),
    ]);
  });

  it('binds repeated launch prompt text only to the next imported root', async () => {
    let tabs: MockTabsFile = { tabs: [{ id: 'chat', messages: [] }] };
    mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
    mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
      tabs = next;
      return Promise.resolve();
    });
    const service = createService();
    const request = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
      initialPrompt: 'continue',
    };
    const roots = [
      {
        id: 'first-root',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'continue' }],
      },
      {
        id: 'first-timer',
        role: 'system',
        timestamp: 2,
        blocks: [{ type: 'turn_timer', completedAt: 2 }],
      },
    ];
    await service.launch(request);
    let sessionKey = service.getState('p', 'w', 'chat')?.sessionKey;
    if (!sessionKey) throw new Error('Missing first session key');
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      ...request,
      importedEventCount: 2,
      importedMessages: roots,
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    await service.markHookState({
      sessionKey,
      hookEventName: 'Stop',
      hookPayload: {},
    });
    expect(mockCanonicalTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ sourceInputId: 'first-root' }),
    );
    tabs.tabs[0].messages = roots;
    await service.cleanup({ ...request, reason: 'manual' });
    mockCanonicalTerminal.mockClear();
    await service.launch(request);
    expect(mockWatcherObservations.at(-1)).toEqual(
      expect.objectContaining({ previousRootId: 'first-root' }),
    );
    expect(mockWatcherObservations.at(-1)).not.toHaveProperty('sourceInputId');
    sessionKey = service.getState('p', 'w', 'chat')?.sessionKey;
    if (!sessionKey) throw new Error('Missing second session key');
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      ...request,
      importedEventCount: 2,
      importedMessages: [
        ...roots,
        {
          id: 'second-root',
          role: 'user',
          timestamp: 3,
          blocks: [{ type: 'text', text: 'continue' }],
        },
        {
          id: 'second-timer',
          role: 'system',
          timestamp: 4,
          blocks: [{ type: 'turn_timer', completedAt: 4 }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    await service.markHookState({
      sessionKey,
      hookEventName: 'Stop',
      hookPayload: {},
    });
    expect(mockCanonicalTerminal).toHaveBeenCalledTimes(1);
    expect(mockCanonicalTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ sourceInputId: 'second-root' }),
    );
  });

  it('uses the retained canonical user id and emits start only once across repeated launches', async () => {
    let tabs: MockTabsFile = {
      tabs: [
        {
          id: 'chat',
          newChatStartedWatcherPending: true,
          messages: [
            {
              id: 'retained-root',
              role: 'user',
              timestamp: 123,
              blocks: [{ type: 'text', text: 'hello' }],
            },
          ],
        },
      ],
    };
    mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
    mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
      tabs = next;
      return Promise.resolve();
    });
    const service = createService();
    const request = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
      initialPrompt: 'hello',
      initialPromptIdempotencyKey: 'retained-root',
    };
    await service.launch(request);
    await service.launch(request);
    expect(mockCanonicalStarted).toHaveBeenCalledTimes(1);
    expect(mockCanonicalStarted).toHaveBeenCalledWith(
      expect.objectContaining({ sourceInputId: 'retained-root' }),
    );
    expect(await service.getActiveChatInput(request)).toEqual({
      state: 'pending',
      inputId: 'retained-root',
    });
  });

  it('records one observation when launch and the first prompt hook accept together', async () => {
    const tabs: MockTabsFile = {
      tabs: [
        {
          id: 'chat',
          messages: [
            {
              id: 'retained-root',
              role: 'user',
              timestamp: 123,
              blocks: [{ type: 'text', text: 'hello' }],
            },
          ],
        },
      ],
    };
    mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
    const service = createService();
    const resolveAddress =
      mockResolveCanonicalChatAddress.getMockImplementation();
    if (!resolveAddress) throw new Error('Missing address resolver');
    let hook: Promise<void> | undefined;
    // The first prompt hook arrives while launch acceptance is still resolving.
    mockResolveCanonicalChatAddress.mockImplementationOnce(async (target) => {
      const sessionKey = service.getState('p', 'w', 'chat')?.sessionKey;
      if (!sessionKey) throw new Error('Missing session key');
      hook = service.markHookState({
        sessionKey,
        hookEventName: 'UserPromptSubmit',
        hookPayload: {},
      });
      await flushTerminalEventTasks();
      return resolveAddress(target);
    });
    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
      initialPrompt: 'hello',
      initialPromptIdempotencyKey: 'retained-root',
    });
    await hook;
    expect(mockWatcherObservations).toEqual([
      expect.objectContaining({ sourceInputId: 'retained-root' }),
    ]);
  });

  it('binds the launch input when the first prompt hook is accepted first', async () => {
    let tabs: MockTabsFile = {
      tabs: [
        {
          id: 'chat',
          messages: [
            {
              id: 'retained-root',
              role: 'user',
              timestamp: 123,
              blocks: [{ type: 'text', text: 'hello' }],
            },
          ],
        },
      ],
    };
    mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
    const service = createService();
    let hook: Promise<void> | undefined;
    // The prompt hook lands while launch still persists post-spawn state.
    mockWriteChatTabsFile.mockImplementation(async (_p, _w, next) => {
      tabs = next;
      const sessionKey = service.getState('p', 'w', 'chat')?.sessionKey;
      if (!hook && sessionKey) {
        hook = service.markHookState({
          sessionKey,
          hookEventName: 'UserPromptSubmit',
          hookPayload: {},
        });
        // Let the hook reach watcher acceptance; awaiting it would deadlock
        // on this same tab write.
        for (let i = 0; i < 5; i += 1) await flushTerminalEventTasks();
      }
    });
    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
      initialPrompt: 'hello',
      initialPromptIdempotencyKey: 'retained-root',
    });
    await hook;
    expect(hook).toBeDefined();
    expect(mockWatcherObservations).toEqual([
      expect.objectContaining({ sourceInputId: 'retained-root' }),
    ]);
  });

  it('keeps launch and hook state tracking when the watcher store fails', async () => {
    mockReadChatTabsFile.mockResolvedValue({ tabs: [{ id: 'chat' }] });
    const write = mockWriteWatcherObservations.getMockImplementation();
    if (!write) throw new Error('Missing watcher store writer');
    mockWriteWatcherObservations.mockImplementation(() =>
      Promise.reject(new Error('Unsupported watcher store version')),
    );
    try {
      const service = createService();
      await expect(
        service.launch({
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'chat',
          cols: 80,
          rows: 24,
          initialPrompt: 'hello',
          initialPromptIdempotencyKey: 'retained-root',
        }),
      ).resolves.toBeDefined();
      const sessionKey = service.getState('p', 'w', 'chat')?.sessionKey;
      if (!sessionKey) throw new Error('Missing session key');
      await service.markHookState({
        sessionKey,
        hookEventName: 'UserPromptSubmit',
        hookPayload: {},
      });
      expect(service.getState('p', 'w', 'chat')?.turnState).toBe('running');
      await service.markHookState({
        sessionKey,
        hookEventName: 'StopFailure',
        hookPayload: {},
      });
      expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
    } finally {
      mockWriteWatcherObservations.mockImplementation(write);
    }
  });

  it('does not notify while the imported root and output commit is blocked', async () => {
    let tabs: MockTabsFile = { tabs: [{ id: 'chat', messages: [] }] };
    mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
    mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
      tabs = next;
      return Promise.resolve();
    });
    const service = seedService();
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    let release: (() => void) | undefined;
    mockIngestProviderEvent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 2,
      importedMessages: [
        {
          id: 'blocked-root',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'work' }],
        },
        {
          id: 'blocked-timer',
          role: 'system',
          timestamp: 2,
          blocks: [{ type: 'turn_timer', completedAt: 2 }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    const stop = service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: {},
    });
    await flushTerminalEventTasks();
    expect(mockCanonicalStarted).not.toHaveBeenCalled();
    expect(mockCanonicalTerminal).not.toHaveBeenCalled();
    release?.();
    await stop;
    expect(mockCanonicalTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ sourceInputId: 'blocked-root' }),
    );
  });

  it('refuses the delayed Enter when the retained input was cancelled after its paste', async () => {
    const service = seedService();
    mockAuthorizeRetainedPaste.mockImplementationOnce(() =>
      Promise.reject(
        new Error(
          'The agent that sent this message can no longer reach this chat.',
        ),
      ),
    );
    await expect(
      service.authorizeAgentInputTerminalWrite('terminal', 'agent-root-submit'),
    ).rejects.toThrow('can no longer reach this chat');
    expect(mockAuthorizeRetainedPaste).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatId: 'chat' }),
      'agent-root',
    );
    // The submit never releases watcher delivery authority; the paste did.
    expect(mockReleaseWatcherAuthority).not.toHaveBeenCalled();
  });

  it('holds an ordinary watcher paste without an input delivery row', async () => {
    mockReadChatTabsFile.mockResolvedValue({ tabs: [{ id: 'chat' }] });
    mockWatcherIngress.mockResolvedValue({
      allowed: false,
      outcome: 'held',
      reason: 'owner_boundary',
    });
    const service = seedService();
    await expect(
      service.authorizeAgentInputTerminalWrite(
        'terminal',
        'watcher-delivery-1-paste',
      ),
    ).rejects.toMatchObject({ outcome: 'held', reason: 'owner_boundary' });
    expect(mockWatcherIngress).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        watcherDeliveryId: 'delivery-1',
      }),
    );
    expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
  });

  it('holds a retained watcher delivery immediately before paste without consuming its payload', async () => {
    const payload = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      userMessageId: 'root',
      text: 'wake',
      watcherDeliveryId: 'delivery',
      watcherFired: { watcherId: 'watcher' },
    };
    const tabs: MockTabsFile = {
      tabs: [
        {
          id: 'chat',
          inputDelivery: {
            version: 1,
            epoch: 0,
            rows: [
              {
                id: 'root',
                revision: 1,
                createdAt: 1,
                state: 'sending',
                text: 'wake',
                settingsKey: '',
                payload,
                attempts: [
                  {
                    id: 'attempt',
                    generation: 'managed-terminal',
                    provider: 'claude',
                    createdAt: 1,
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    mockReadChatTabsFile.mockResolvedValue(tabs);
    mockWatcherIngress.mockResolvedValue({
      allowed: false,
      outcome: 'held',
      reason: 'owner_boundary',
    });
    const service = seedService();
    await expect(
      service.authorizeAgentInputTerminalWrite('terminal', 'root-paste'),
    ).rejects.toMatchObject({ outcome: 'held', reason: 'owner_boundary' });
    expect(mockWatcherIngress).toHaveBeenCalledWith(payload);
    expect(mockAuthorizeRetainedPaste.mock.invocationCallOrder[0]).toBeLessThan(
      mockWatcherIngress.mock.invocationCallOrder[0],
    );
    expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
    mockTerminalReceipt.mockReturnValue(true);
    expect(
      service.authorizeAgentInputTerminalWrite('terminal', 'root-paste'),
    ).toBeUndefined();
    expect(mockWatcherIngress).toHaveBeenCalledTimes(1);
  });

  it('settles a process exit using the canonical root and durable import', async () => {
    let tabs: MockTabsFile = { tabs: [{ id: 'chat', messages: [] }] };
    mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
    mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
      tabs = next;
      return Promise.resolve();
    });
    const service = seedService();
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 2,
      importedMessages: [
        {
          id: 'exit-root',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'work' }],
        },
        {
          id: 'exit-timer',
          role: 'system',
          timestamp: 2,
          blocks: [{ type: 'turn_timer', completedAt: 2 }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    mockTerminalEventListener?.(IPC_CHANNELS.terminalExit, {
      terminalId: 'terminal',
      exitCode: 1,
      signal: null,
    });
    await flushTerminalEventTasks();
    expect(mockCanonicalTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInputId: 'exit-root',
        disposition: 'error',
      }),
    );
  });

  it('retries a late import after process exit without a live runtime record', async () => {
    jest.useFakeTimers();
    try {
      let tabs: MockTabsFile = {
        tabs: [{ id: 'chat', messages: [], sdkSessionId: 'sdk' }],
      };
      mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
      mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
        tabs = next;
        return Promise.resolve();
      });
      const service = seedService();
      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'UserPromptSubmit',
        hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
      });
      mockSyncClaudeTerminalTranscript.mockResolvedValue({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        importedEventCount: 0,
        importedMessages: [],
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      });
      mockTerminalEventListener?.(IPC_CHANNELS.terminalExit, {
        terminalId: 'terminal',
        exitCode: 1,
        signal: null,
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(mockCanonicalTerminal).not.toHaveBeenCalled();
      expect(service.getState('p', 'w', 'chat')).toBeUndefined();
      mockSyncClaudeTerminalTranscript.mockResolvedValue({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        importedEventCount: 1,
        importedMessages: [
          {
            id: 'late-exit-root',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'work' }],
          },
        ],
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      });
      await jest.advanceTimersByTimeAsync(750);
      expect(mockCanonicalTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceInputId: 'late-exit-root',
          disposition: 'error',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('imports first TUI input before Stop and excludes deferred reload intermediate terminals', async () => {
    jest.useFakeTimers();
    try {
      let tabs: MockTabsFile = { tabs: [{ id: 'chat', messages: [] }] };
      mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
      mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
        tabs = next;
        return Promise.resolve();
      });
      const service = seedService(APP_ADVISOR_PROJECT_ID);
      mockSyncClaudeTerminalTranscript.mockResolvedValue({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'w',
        chatId: 'chat',
        importedEventCount: 1,
        importedMessages: [
          {
            id: 'tui-root',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'hi' }],
          },
        ],
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      });
      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'UserPromptSubmit',
        hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
      });
      await jest.advanceTimersByTimeAsync(750);
      expect(mockCanonicalStarted).toHaveBeenCalledWith(
        expect.objectContaining({ sourceInputId: 'tui-root' }),
      );
      expect(mockCanonicalTerminal).not.toHaveBeenCalled();
      const suppress = jest
        .spyOn(deferredToolsReloadCoordinator, 'shouldSuppressProviderTerminal')
        .mockReturnValue(true);
      try {
        await service.markHookState({
          sessionKey: 'session',
          hookEventName: 'Stop',
          hookPayload: {},
        });
        expect(mockCanonicalTerminal).not.toHaveBeenCalled();
        expect(mockWatcherObservations).toEqual([
          expect.not.objectContaining({
            terminalAt: expect.any(String) as unknown,
          }),
        ]);
      } finally {
        suppress.mockRestore();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not treat unavailable transcript enrichment as no output', async () => {
    let tabs: MockTabsFile = { tabs: [{ id: 'chat', messages: [] }] };
    mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
    mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
      tabs = next;
      return Promise.resolve();
    });
    const service = seedService();
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 2,
      importedMessages: [
        {
          id: 'unavailable-root',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'work' }],
        },
        {
          id: 'unavailable-timer',
          role: 'system',
          timestamp: 2,
          blocks: [{ type: 'turn_timer', completedAt: 2 }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
      transcriptReadComplete: false,
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: {},
    });
    expect(mockCanonicalTerminal).not.toHaveBeenCalled();
  });

  it('keeps a late first turn bound to its root while the next input is active', async () => {
    let tabs: MockTabsFile = { tabs: [{ id: 'chat', messages: [] }] };
    mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
    mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
      tabs = next;
      return Promise.resolve();
    });
    const service = seedService();
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 0,
      importedMessages: [],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: {},
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    expect(
      await service.getActiveChatInput({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
      }),
    ).toEqual({ state: 'unknown' });
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 3,
      importedMessages: [
        {
          id: 'first-root',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'first' }],
        },
        {
          id: 'first-timer',
          role: 'system',
          timestamp: 2,
          blocks: [{ type: 'turn_timer', completedAt: 2 }],
        },
        {
          id: 'second-root',
          role: 'user',
          timestamp: 3,
          blocks: [{ type: 'text', text: 'second' }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    await service.syncTranscriptForChat({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });
    expect(mockCanonicalTerminal).toHaveBeenCalledTimes(1);
    expect(mockCanonicalTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInputId: 'first-root',
        sourceInputAcceptedAt: new Date(1).toISOString(),
      }),
    );
    expect(
      await service.getActiveChatInput({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
      }),
    ).toEqual({ state: 'active', inputId: 'second-root' });
    expect(
      await createService().getActiveChatInput({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
      }),
    ).toEqual({ state: 'unknown' });
  });

  it('uses the imported canonical root for output-detected interruption', async () => {
    let tabs: MockTabsFile = { tabs: [{ id: 'chat', messages: [] }] };
    mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
    mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
      tabs = next;
      return Promise.resolve();
    });
    const service = seedService();
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 2,
      importedMessages: [
        {
          id: 'interrupt-root',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'work' }],
        },
        {
          id: 'interrupt-timer',
          role: 'system',
          timestamp: 2,
          blocks: [{ type: 'turn_timer', completedAt: 2 }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    mockTerminalEventListener?.(IPC_CHANNELS.terminalRunningChanged, {
      terminalId: 'terminal',
      running: false,
      interruptedByUser: true,
      processName: 'claude',
    });
    await flushTerminalEventTasks();
    expect(mockCanonicalTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInputId: 'interrupt-root',
        disposition: 'interrupted',
      }),
    );
  });

  it.each(['Stop', 'StopFailure', 'SessionEnd'] as const)(
    'retains failed %s imports and resumes original evidence after restart',
    async (hookEventName) => {
      let tabs: MockTabsFile = {
        tabs: [{ id: 'chat', messages: [], sdkSessionId: 'sdk' }],
      };
      mockReadChatTabsFile.mockImplementation(() => Promise.resolve(tabs));
      mockWriteChatTabsFile.mockImplementation((_p, _w, next) => {
        tabs = next;
        return Promise.resolve();
      });
      const service = seedService();
      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'UserPromptSubmit',
        hookPayload: { prompt: 'hello' },
      });
      mockSyncClaudeTerminalTranscript.mockRejectedValueOnce(
        new Error('late transcript'),
      );
      await service.markHookState({
        sessionKey: 'session',
        hookEventName,
        hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
      });
      expect(mockCanonicalTerminal).not.toHaveBeenCalled();
      const retained = mockWatcherObservations;
      expect(retained).toEqual([
        expect.objectContaining({
          terminalAt: expect.any(String) as unknown,
          evidence: { sourceOwner: { kind: 'personal' }, accountEpoch: 4 },
        }),
      ]);
      mockSyncClaudeTerminalTranscript.mockResolvedValue({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        importedEventCount: 2,
        importedMessages: [
          {
            id: 'late-root',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'hello' }],
          },
          ...(hookEventName === 'Stop'
            ? [
                {
                  id: 'late-timer',
                  role: 'system',
                  timestamp: 2,
                  blocks: [{ type: 'turn_timer', completedAt: 2 }],
                },
              ]
            : []),
        ],
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      });
      const restarted = createService();
      mockCanonicalTerminal.mockImplementationOnce(async () =>
        restarted.resumePendingObservations({
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'chat',
        }),
      );
      await restarted.resumePendingObservations({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
      });
      expect(mockCanonicalTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceInputId: 'late-root',
          disposition: hookEventName === 'StopFailure' ? 'error' : 'no_output',
          evidence: { sourceOwner: { kind: 'personal' }, accountEpoch: 4 },
        }),
      );
      await restarted.resumePendingObservations({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
      });
      expect(mockCanonicalTerminal).toHaveBeenCalledTimes(1);
    },
  );

  it('does not invent a canonical input id when terminal import lacks its root', async () => {
    const service = seedService();

    // Start a turn (idle -> running).
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    mockHandleChatTerminalEvent.mockClear();

    // Without an imported root, neither route may invent a watcher binding.
    // Keep the observation pending until durable import can identify its turn.
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });
    await flushTerminalEventTasks();

    expect(mockHandleChatTerminalEvent).not.toHaveBeenCalled();
    expect(mockCanonicalTerminal).not.toHaveBeenCalled();
  });

  it('names the running terminal turn by a per-turn user message id', async () => {
    const service = seedService();
    expect(service.runningTurnUserMessageId('p', 'w', 'chat')).toBeUndefined();

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'Start the review.' },
    });
    const turn = service.runningTurnUserMessageId('p', 'w', 'chat');
    expect(turn).toMatch(/^msg-terminal-/);
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'PreToolUse',
      hookPayload: {},
    });
    expect(service.runningTurnUserMessageId('p', 'w', 'chat')).toBe(turn);

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });
    await flushTerminalEventTasks();
    expect(service.runningTurnUserMessageId('p', 'w', 'chat')).toBeUndefined();

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'Next.' },
    });
    const next = service.runningTurnUserMessageId('p', 'w', 'chat');
    expect(next).toMatch(/^msg-terminal-/);
    expect(next).not.toBe(turn);
  });

  it('notifies the watcher service once through canonical delivery after durable terminal import', async () => {
    const service = seedService();

    // Start a turn (idle -> running).
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    mockHandleChatTerminalEvent.mockClear();

    // The imported root is the binding authority for both canonical and
    // legacy turn-bound watchers; never emit a parallel raw terminal.
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 3,
      importedMessages: [
        {
          id: 'imported-root',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Do the work.' }],
        },
        {
          id: 'imported-reply',
          role: 'assistant',
          timestamp: 2,
          blocks: [{ type: 'text', text: 'Done.' }],
        },
        {
          id: 'imported-timer',
          role: 'system',
          timestamp: 3,
          blocks: [{ type: 'turn_timer', completedAt: 3 }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });
    await flushTerminalEventTasks();

    expect(mockCanonicalTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        address: { projectId: 'p', taskId: 'w', chatId: 'chat' },
        sourceInputId: 'imported-root',
        disposition: 'completed',
      }),
    );
    expect(mockCanonicalTerminal).toHaveBeenCalledTimes(1);
    expect(mockHandleChatTerminalEvent).not.toHaveBeenCalled();
    expect(mockIngestProviderEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mockCanonicalTerminal.mock.invocationCallOrder[0],
    );
  });

  it('does not notify the watcher service without a turn-end transition', async () => {
    const service = seedService();
    // Seeded state is already idle; a Notification hook does not end a turn.
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Notification',
      hookPayload: {},
    });
    await flushTerminalEventTasks();

    expect(mockHandleChatTerminalEvent).not.toHaveBeenCalled();
  });

  it('only accepts transcript path changes from legitimate hook events', async () => {
    const service = seedService();

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Notification',
      hookPayload: { transcript_path: '/not-allowed.jsonl' },
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });

    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptPath: '/runtime/allowed.jsonl' }),
    );
    expect(mockSyncClaudeTerminalTranscript).not.toHaveBeenCalledWith(
      expect.objectContaining({ transcriptPath: '/not-allowed.jsonl' }),
    );
  });

  it('passes the runtime continuation-suppression flag to transcript sync', async () => {
    const service = seedService();
    service.setDeferredToolsReloadContinuationSuppressedForTests(
      'p',
      'w',
      'chat',
      true,
    );

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });

    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressDeferredToolsReloadContinuation: true,
      }),
    );
    await service.shutdown();
  });

  it('rejects hook transcript paths outside Claude projects and the runtime dir', async () => {
    const service = seedService();

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/not-allowed.jsonl' },
    });

    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptPath: undefined }),
    );
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal_transcript_sync_failure',
        transcriptPath: '/not-allowed.jsonl',
        error:
          'Rejected Claude terminal transcript path outside allowed roots.',
      }),
    );
  });

  it('records terminal turn and transcript sync diagnostics', async () => {
    const service = seedService();

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });

    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'terminal_turn_active' }),
    );
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'terminal_turn_idle' }),
    );
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'terminal_transcript_sync_start' }),
    );
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal_transcript_sync_end',
        importedEventCount: 1,
      }),
    );
  });

  it('captures terminal turn diffs and passes them into transcript sync', async () => {
    const service = seedService();
    const turnDiff = {
      files: [
        {
          path: 'src/app.ts',
          status: 'modified',
          insertions: 4,
          deletions: 1,
        },
      ],
      totalInsertions: 4,
      totalDeletions: 1,
      capturedAt: 123,
      treeRefs: [{ startTree: 'start-tree', endTree: 'end-tree' }],
    };
    mockCaptureTurnEndAndDiff.mockResolvedValueOnce(turnDiff);

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'change the app' },
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });

    expect(mockCaptureTurnStart).toHaveBeenCalledWith('session', 'p', 'w');
    expect(mockCaptureTurnEndAndDiff).toHaveBeenCalledWith('session');
    expect(mockScheduleCodeGraphBuild).toHaveBeenCalledWith({
      projectId: 'p',
      worktreeId: 'w',
      reason: 'refresh',
      source: 'turn-diff',
    });
    expect(mockSyncClaudeTerminalTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        turnDiff,
      }),
    );
  });

  it('schedules terminal turn diffs against the resolved real worktree', async () => {
    const service = seedService(CODE_REVIEW_CHAT_PROJECT_ID, 'scope-id');
    mockResolveWorktreeTargetIds.mockReturnValueOnce({
      projectId: 'real-project',
      worktreeId: 'real-worktree',
    });
    mockCaptureTurnEndAndDiff.mockResolvedValueOnce({
      files: [{ path: 'src/app.ts', status: 'modified' }],
    });

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });

    expect(mockResolveWorktreeTargetIds).toHaveBeenCalledWith(
      CODE_REVIEW_CHAT_PROJECT_ID,
      'scope-id',
    );
    expect(mockScheduleCodeGraphBuild).toHaveBeenCalledWith({
      projectId: 'real-project',
      worktreeId: 'real-worktree',
      reason: 'refresh',
      source: 'turn-diff',
    });
  });

  it('resets terminal turn diff capture state when opening capture fails', async () => {
    const service = seedService();
    mockCaptureTurnStart
      .mockRejectedValueOnce(new Error('capture failed'))
      .mockResolvedValueOnce(undefined);

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'change the app' },
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'try again' },
    });

    expect(mockCaptureTurnStart).toHaveBeenCalledTimes(2);
    expect(mockCaptureTurnEndAndDiff).not.toHaveBeenCalled();
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal_turn_diff_capture_open_failure',
        error: 'capture failed',
      }),
    );
  });

  it('emits state-changed events with routing ids so the IPC router can fan out to the App Advisor window', async () => {
    const service = seedService();
    const eventSender = jest.fn<void, [string, unknown]>();
    service.setEventSender(eventSender);

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });

    const stateCall = eventSender.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.claudeTerminalStateChanged,
    );
    expect(stateCall?.[1]).toMatchObject({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      turnState: 'running',
    });
  });

  it('emits imported Claude Code transcript messages as a chat event', async () => {
    const service = seedService();
    const eventSender = jest.fn<void, [string, unknown]>();
    service.setEventSender(eventSender);
    const importedMessage = {
      id: 'assistant-imported',
      role: 'assistant',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Synced back to Canopy' }],
    };
    mockSyncClaudeTerminalTranscript.mockResolvedValueOnce({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      importedMessages: [importedMessage],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });

    const isTranscriptSyncInput = (input: Record<string, unknown>): boolean => {
      const data = input.data;
      return (
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === 'claude_terminal_transcript_sync'
      );
    };
    const committedTranscript = mockIngestProviderEvent.mock.calls.find(
      ([input]) => isTranscriptSyncInput(input),
    )?.[0];
    expect(committedTranscript).toMatchObject({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      data: {
        type: 'claude_terminal_transcript_sync',
        messages: [importedMessage],
      },
    });
    expect(
      mockIngestProviderEvent.mock.invocationCallOrder.find((_order, index) =>
        isTranscriptSyncInput(
          mockIngestProviderEvent.mock.calls[index]?.[0] ?? {},
        ),
      ),
    ).toBeLessThan(
      eventSender.mock.invocationCallOrder[
        eventSender.mock.calls.findIndex(
          ([channel]) => channel === IPC_CHANNELS.chatEvent,
        )
      ],
    );

    expect(eventSender).toHaveBeenCalledWith(IPC_CHANNELS.chatEvent, {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      data: {
        type: 'claude_terminal_transcript_sync',
        messages: [importedMessage],
        importedEventCount: 1,
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      },
    });
    const syncCompletedCall = eventSender.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.claudeTerminalSyncCompleted,
    );
    expect(syncCompletedCall?.[1]).toEqual({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
  });

  it('keeps Stop running until transcript sync completes, then marks idle', async () => {
    const service = seedService();
    let resolveSync:
      | ((value: {
          projectId: string;
          worktreeId: string;
          chatId: string;
          importedEventCount: number;
          importedMessages: Array<Record<string, unknown>>;
          transcriptPath: string;
          compactionAppended: boolean;
        }) => void)
      | undefined;
    mockSyncClaudeTerminalTranscript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSync = resolve;
        }),
    );

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    mockRecordSessionDiagnostic.mockClear();

    const stopPromise = service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });
    await flushTerminalEventTasks();

    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('running');
    expect(mockRecordSessionDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'terminal_turn_idle' }),
    );

    resolveSync?.({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      importedMessages: [],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });
    await stopPromise;

    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
    const diagnosticKinds = mockRecordSessionDiagnostic.mock.calls.map(
      ([entry]) => (entry as { kind: string }).kind,
    );
    expect(
      diagnosticKinds.indexOf('terminal_transcript_sync_end'),
    ).toBeLessThan(diagnosticKinds.indexOf('terminal_turn_idle'));
  });

  it('marks a running turn idle when Claude reports user interruption in terminal output', async () => {
    const service = seedService();
    const eventSender = jest.fn<void, [string, unknown]>();
    service.setEventSender(eventSender);
    mockSyncClaudeTerminalTranscript.mockResolvedValueOnce({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      importedMessages: [
        {
          id: 'turn-duration',
          role: 'system',
          timestamp: 3,
          blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 3 }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'long running task' },
    });
    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('running');
    mockRecordSessionDiagnostic.mockClear();

    mockTerminalEventListener?.(IPC_CHANNELS.terminalOutput, {
      projectId: 'p',
      worktreeId: 'w',
      terminalId: 'terminal',
      data: Uint8Array.from(Buffer.from('Interrupted by user')),
      seq: 1,
    });
    await flushTerminalEventTasks();

    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
    expect(eventSender).toHaveBeenCalledWith(
      IPC_CHANNELS.claudeTerminalStateChanged,
      expect.objectContaining({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        turnState: 'idle',
      }),
    );
    expect(mockCompleteChatTurn).toHaveBeenCalledWith(
      'p',
      'w',
      'chat',
      'interrupted',
      'Claude Code turn interrupted by user.',
    );
    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        hookEventName: 'SessionEnd',
        hookPayload: { source: 'terminal-output' },
      }),
    );
    const terminalOutputChatEvent = eventSender.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.chatEvent,
    );
    expect(terminalOutputChatEvent?.[1]).toMatchObject({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 1,
      },
    });
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal_turn_idle',
        eventType: 'terminal-output',
      }),
    );
  });

  it('marks a running turn idle when the PTY reports a Ctrl-C interruption', async () => {
    const service = seedService();
    mockSyncClaudeTerminalTranscript.mockResolvedValueOnce({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      importedMessages: [
        {
          id: 'turn-duration',
          role: 'system',
          timestamp: 3,
          blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 3 }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'long running task' },
    });
    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('running');

    mockTerminalEventListener?.(IPC_CHANNELS.terminalRunningChanged, {
      projectId: 'p',
      worktreeId: 'w',
      terminalId: 'terminal',
      kind: 'claude-code',
      running: false,
      processName: null,
      interruptedByUser: true,
    });
    await flushTerminalEventTasks();

    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal_turn_idle',
        eventType: 'terminal-running-changed',
      }),
    );
  });

  it('syncs the Claude Code transcript when the renderer reports an Escape interrupt', async () => {
    const service = seedService();
    const eventSender = jest.fn<void, [string, unknown]>();
    service.setEventSender(eventSender);
    mockAccess.mockResolvedValueOnce(undefined);
    mockSyncClaudeTerminalTranscript.mockResolvedValueOnce({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      importedMessages: [
        {
          id: 'turn-duration',
          role: 'system',
          timestamp: 3,
          blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 3 }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'long running task' },
    });

    await service.interrupt({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });

    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        hookEventName: 'SessionEnd',
        hookPayload: { source: 'renderer-escape' },
      }),
    );
    const syncInput = mockSyncClaudeTerminalTranscript.mock.calls[0]?.[0] as
      | { transcriptPath?: unknown }
      | undefined;
    if (typeof syncInput?.transcriptPath !== 'string') {
      throw new Error(
        'Expected renderer interrupt sync to include transcriptPath',
      );
    }
    expect(syncInput.transcriptPath).toContain('/.claude/projects/');
    const rendererInterruptChatEvent = eventSender.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.chatEvent,
    );
    expect(rendererInterruptChatEvent?.[1]).toMatchObject({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      data: {
        type: 'claude_terminal_transcript_sync',
        importedEventCount: 1,
      },
    });
    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
  });

  it('invalidates interrupted approvals and rejects late hook requests', async () => {
    const service = seedService();
    const check = jest.fn().mockResolvedValue({ decision: 'allow' });
    const invalidatePending = jest.fn();
    const record = Array.from(
      (
        service as unknown as {
          records: Map<string, { approvalSession?: unknown }>;
        }
      ).records.values(),
    )[0];
    record.approvalSession = { check, invalidatePending, dispose: jest.fn() };

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'long running task' },
    });
    await service.interrupt({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });

    expect(invalidatePending).toHaveBeenCalledTimes(1);
    await expect(
      service.handleHookCallback('session', {
        hookEventName: 'PreToolUse',
        hookPayload: {
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
        },
      }),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'The owning turn was cancelled.',
      },
    });
    expect(check).not.toHaveBeenCalled();

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'new task' },
    });
    await service.handleHookCallback('session', {
      hookEventName: 'PreToolUse',
      hookPayload: {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      },
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('retains an interrupted observation until the canonical input imports', async () => {
    const service = seedService();

    // Start a turn (idle -> running).
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    mockHandleChatTerminalEvent.mockClear();

    // Interactive/non-auto turn-end path (renderer Escape interrupt) — this
    // does not go through a Stop hook, so it must still fire the watcher.
    await service.interrupt({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });
    await flushTerminalEventTasks();

    expect(mockHandleChatTerminalEvent).not.toHaveBeenCalled();
    expect(mockCanonicalTerminal).not.toHaveBeenCalled();
  });

  it('passes a fallback turn timer into interrupted-turn transcript sync', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000);
      const service = seedService();
      const interruptedWithFallbackTimer = {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        importedEventCount: 2,
        importedMessages: [
          {
            id: 'partial-assistant',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'I started working on it.' }],
          },
          {
            id: 'claude-terminal-interrupted-turn:session:2500',
            role: 'system',
            timestamp: 2_500,
            blocks: [
              { type: 'turn_timer', startedAt: 1_000, completedAt: 2_500 },
            ],
          },
        ],
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      };
      mockSyncClaudeTerminalTranscript.mockResolvedValueOnce(
        interruptedWithFallbackTimer,
      );

      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'UserPromptSubmit',
        hookPayload: { prompt: 'long running task' },
      });
      jest.setSystemTime(2_500);

      await service.interrupt({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
      });

      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(1);
      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          hookEventName: 'SessionEnd',
          hookPayload: { source: 'renderer-escape' },
          fallbackTurnTimer: {
            id: 'claude-terminal-interrupted-turn:session:1000',
            startedAt: 1_000,
            completedAt: 2_500,
          },
        }),
      );
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('settles interrupted turns once when interrupt sources race', async () => {
    let resolveTurnDiff: (value: unknown) => void = () => undefined;
    mockCaptureTurnEndAndDiff.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTurnDiff = resolve;
        }),
    );
    const service = seedService();

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'long running task' },
    });

    const firstInterrupt = service.interrupt({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });
    const secondInterrupt = service.interrupt({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });
    await Promise.resolve();

    await flushTerminalEventTasks();
    expect(mockCaptureTurnEndAndDiff).toHaveBeenCalledTimes(1);
    expect(mockSyncClaudeTerminalTranscript).not.toHaveBeenCalled();

    resolveTurnDiff(undefined);
    await Promise.all([firstInterrupt, secondInterrupt]);

    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(1);
    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
  });

  it('only settles from terminal output when Claude emits a standalone interrupt line', async () => {
    const service = seedService();
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'long running task' },
    });
    mockSyncClaudeTerminalTranscript.mockClear();

    mockTerminalEventListener?.(IPC_CHANNELS.terminalOutput, {
      terminalId: 'terminal',
      seq: 1,
      data: Buffer.from(
        'The assistant mentioned interrupted by user in a sentence.',
      ),
    });
    await flushTerminalEventTasks();

    expect(mockSyncClaudeTerminalTranscript).not.toHaveBeenCalled();
    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('running');

    mockTerminalEventListener?.(IPC_CHANNELS.terminalOutput, {
      terminalId: 'terminal',
      seq: 2,
      data: Buffer.from('\r\nInterrupted by user\r\n'),
    });
    await flushTerminalEventTasks();

    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(1);
    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
  });

  it('does not re-lock the turn when SubagentStop arrives after Stop', async () => {
    const service = seedService();

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });
    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
    mockRecordSessionDiagnostic.mockClear();

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'SubagentStop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });

    expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
    expect(mockRecordSessionDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'terminal_turn_active',
        eventType: 'SubagentStop',
      }),
    );
  });

  it('records non-fatal transcript sync errors in diagnostics', async () => {
    mockSyncClaudeTerminalTranscript.mockResolvedValueOnce({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 0,
      importedMessages: [],
      transcriptPath: '/runtime/missing.jsonl',
      compactionAppended: false,
      errors: [
        'ENOENT: no such file or directory, open /runtime/missing.jsonl',
      ],
    });
    const service = seedService();

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/missing.jsonl' },
    });

    const failureDiagnostic = mockRecordSessionDiagnostic.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.kind === 'terminal_transcript_sync_failure');
    expect(failureDiagnostic).toMatchObject({
      transcriptPath: '/runtime/missing.jsonl',
    });
    expect(failureDiagnostic?.error).toEqual(expect.stringContaining('ENOENT'));
  });

  it('coalesces renderer pre-fork sync with an in-flight hook sync', async () => {
    const service = seedService();
    const eventSender = jest.fn<void, [string, unknown]>();
    service.setEventSender(eventSender);
    const syncResult = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      importedMessages: [
        {
          id: 'imported-message',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Imported from Claude Code' }],
        },
      ],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    };
    let resolveSync: ((result: typeof syncResult) => void) | undefined;
    mockSyncClaudeTerminalTranscript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSync = resolve;
        }),
    );

    const hookSync = service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });
    await flushTerminalEventTasks();
    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(1);

    const rendererSync = service.syncTranscriptForChat({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });
    await flushTerminalEventTasks();
    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(1);

    resolveSync?.(syncResult);
    await Promise.all([hookSync, rendererSync]);

    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(1);
    expect(
      eventSender.mock.calls.filter(
        ([channel]) => channel === IPC_CHANNELS.claudeTerminalSyncCompleted,
      ),
    ).toHaveLength(1);
    expect(
      eventSender.mock.calls.filter(
        ([channel]) => channel === IPC_CHANNELS.chatEvent,
      ),
    ).toHaveLength(1);
  });

  it('runs a trailing sync after StopFailure to capture late Claude Code transcript writes', async () => {
    jest.useFakeTimers();
    try {
      const service = seedService();
      const eventSender = jest.fn<void, [string, unknown]>();
      service.setEventSender(eventSender);
      const lateMessage = {
        id: 'late-auth-error',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'text',
            text: 'Please run /login - API Error: 401 Invalid authentication credentials',
          },
        ],
      };
      mockSyncClaudeTerminalTranscript
        .mockResolvedValueOnce({
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'chat',
          importedEventCount: 0,
          importedMessages: [],
          transcriptPath: '/runtime/allowed.jsonl',
          compactionAppended: false,
        })
        .mockResolvedValueOnce({
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'chat',
          importedEventCount: 1,
          importedMessages: [lateMessage],
          transcriptPath: '/runtime/allowed.jsonl',
          compactionAppended: false,
        });

      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'StopFailure',
        hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
      });

      expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
      expect(mockRecordSessionDiagnostic).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'claude_terminal_process_error' }),
      );
      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);
      await jest.runOnlyPendingTimersAsync();

      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(2);
      expect(eventSender).toHaveBeenCalledWith(IPC_CHANNELS.chatEvent, {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        data: {
          type: 'claude_terminal_transcript_sync',
          messages: [lateMessage],
          importedEventCount: 1,
          transcriptPath: '/runtime/allowed.jsonl',
          compactionAppended: false,
        },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs a trailing sync after Stop when Claude has only flushed the user prompt', async () => {
    jest.useFakeTimers();
    try {
      const service = seedService();
      const eventSender = jest.fn<void, [string, unknown]>();
      service.setEventSender(eventSender);
      const promptMessage = {
        id: 'prompt',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'what is today?' }],
      };
      const lateAssistantMessage = {
        id: 'late-answer',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Today is 2026-05-22.' }],
      };
      mockSyncClaudeTerminalTranscript
        .mockResolvedValueOnce({
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'chat',
          importedEventCount: 1,
          importedMessages: [promptMessage],
          transcriptPath: '/runtime/allowed.jsonl',
          compactionAppended: false,
        })
        .mockResolvedValueOnce({
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'chat',
          importedEventCount: 1,
          importedMessages: [lateAssistantMessage],
          transcriptPath: '/runtime/allowed.jsonl',
          compactionAppended: false,
        });

      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'Stop',
        hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
      });

      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);
      await jest.runOnlyPendingTimersAsync();

      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(2);
      expect(eventSender).toHaveBeenCalledWith(IPC_CHANNELS.chatEvent, {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        data: {
          type: 'claude_terminal_transcript_sync',
          messages: [lateAssistantMessage],
          importedEventCount: 1,
          transcriptPath: '/runtime/allowed.jsonl',
          compactionAppended: false,
        },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries trailing syncs after Stop until the turn-duration timer is imported', async () => {
    jest.useFakeTimers();
    try {
      const service = seedService();
      const completedConversation = {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        importedEventCount: 2,
        importedMessages: [
          {
            id: 'prompt',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'hi' }],
          },
          {
            id: 'answer',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'Hi! What can I help you with?' }],
          },
        ],
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      };
      const emptyFollowUp = {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        importedEventCount: 0,
        importedMessages: [],
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      };
      const turnTimerArrival = {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        importedEventCount: 1,
        importedMessages: [
          {
            id: 'turn-duration',
            role: 'system',
            timestamp: 3,
            blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 3 }],
          },
        ],
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      };
      mockSyncClaudeTerminalTranscript
        // Stop-time sync: Claude has not flushed `turn_duration` yet because
        // it is written only after the Stop hooks (this sync) return.
        .mockResolvedValueOnce(completedConversation)
        // First trailing sync: a slow user Stop hook still has the line held.
        .mockResolvedValueOnce(emptyFollowUp)
        // Second trailing sync: the turn timer lands, retries stop.
        .mockResolvedValueOnce(turnTimerArrival);

      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'Stop',
        hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
      });

      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);

      await jest.runOnlyPendingTimersAsync();
      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(1);

      await jest.runOnlyPendingTimersAsync();
      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(3);
      // The completed turn timer arrived — no further trailing syncs.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('caps trailing sync retries when the turn timer never arrives', async () => {
    jest.useFakeTimers();
    try {
      const service = seedService();
      mockSyncClaudeTerminalTranscript.mockResolvedValue({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        importedEventCount: 0,
        importedMessages: [],
        transcriptPath: '/runtime/allowed.jsonl',
        compactionAppended: false,
      });

      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'Stop',
        hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
      });
      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(1);

      let drained = 0;
      while (jest.getTimerCount() > 0 && drained < 10) {
        await jest.runOnlyPendingTimersAsync();
        drained += 1;
      }
      // Stop-time sync + 4 capped trailing attempts.
      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledTimes(5);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes the whole runtime directory for chat and worktree deletion cleanup', async () => {
    const service = seedService();
    mockWriteChatTabsFile.mockClear();

    await service.cleanup({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      reason: 'chat-closed',
    });

    expect(mockRm).toHaveBeenCalledWith('/runtime', {
      recursive: true,
      force: true,
    });
    expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
  });

  it('marks cleanup kills as Canopy-managed terminal shutdowns', async () => {
    const service = seedService();

    await service.cleanup({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      reason: 'switch-to-native-send',
    });

    expect(mockPtyKill).toHaveBeenCalledWith('terminal', {
      signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    });
  });

  it('cleans up all live Claude terminal records for a deleted worktree', async () => {
    const service = seedService();
    (
      service as unknown as {
        records: Map<string, unknown>;
      }
    ).records.set('p\0w\0chat-2', {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat-2',
      runtimeDir: '/runtime-2',
      authToken: 'secret-2',
      state: {
        turnState: 'idle',
        sessionKey: 'session-2',
        sdkSessionId: 'sdk-2',
        terminalId: 'terminal-2',
      },
    });

    await service.cleanupWorktree('p', 'w');

    expect(mockPtyKill).toHaveBeenCalledWith('terminal', {
      signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    });
    expect(mockPtyKill).toHaveBeenCalledWith('terminal-2', {
      signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    });
    expect(mockRm).toHaveBeenCalledWith('/runtime', {
      recursive: true,
      force: true,
    });
    expect(mockRm).toHaveBeenCalledWith('/runtime-2', {
      recursive: true,
      force: true,
    });
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('/worktree-data/w/claude-terminal'),
      { recursive: true, force: true },
    );
    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
    expect(service.getState('p', 'w', 'chat-2')).toBeUndefined();
  });

  it('shuts down live Claude terminal records during app shutdown', async () => {
    const service = seedService();

    await service.shutdown();

    expect(mockPtyKill).toHaveBeenCalledWith('terminal', {
      signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    });
    expect(mockRm).toHaveBeenCalledWith('/runtime/canopy-mcp.json', {
      force: true,
    });
    const persistedTabs = mockWriteChatTabsFile.mock.calls[0]?.[2];
    expect(persistedTabs?.tabs[0]).toMatchObject({
      id: 'chat',
      claudeTerminal: { turnState: 'exited' },
    });
    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
  });

  it('interrupts and syncs an active terminal chat before shutdown cleanup', async () => {
    const service = seedService();
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    mockPtyWrite.mockImplementationOnce(() => {
      void service.markHookState({
        sessionKey: 'session',
        hookEventName: 'Stop',
        hookPayload: {},
      });
    });
    await service.shutdown({ recordInterrupted: true });
    expect(mockPtyWrite).toHaveBeenCalledWith('terminal', '\u001b');
    expect(mockRecordInterruptedChats).toHaveBeenCalledWith([
      expect.objectContaining({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        provider: 'claude',
        resumeReason: 'app_shutdown',
      }),
    ]);
    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalled();
    const finalSync =
      mockSyncClaudeTerminalTranscript.mock.invocationCallOrder.slice(-1)[0];
    expect(finalSync).toBeLessThan(mockPtyKill.mock.invocationCallOrder[0]);
    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'new',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow('Application is stopping');
  });

  it('cleans up terminals before reporting an interrupted transcript sync failure', async () => {
    const service = seedService();
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    mockPtyWrite.mockImplementationOnce(() => {
      void service.markHookState({
        sessionKey: 'session',
        hookEventName: 'Stop',
        hookPayload: {},
      });
    });
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 0,
      importedMessages: [],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
      errors: ['sync failed'],
    });

    await expect(service.shutdown({ recordInterrupted: true })).rejects.toThrow(
      'sync failed',
    );
    expect(mockPtyKill).toHaveBeenCalledWith('terminal', {
      signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    });
    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
  });

  it('interrupts and cleans up terminals when recovery registry persistence fails', async () => {
    const service = seedService();
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: {},
    });
    mockPtyWrite.mockImplementationOnce(() => {
      void service.markHookState({
        sessionKey: 'session',
        hookEventName: 'Stop',
        hookPayload: {},
      });
    });
    mockRecordInterruptedChats.mockRejectedValueOnce(
      new Error('registry write failed'),
    );

    await expect(service.shutdown({ recordInterrupted: true })).rejects.toThrow(
      'registry write failed',
    );
    expect(mockPtyWrite).toHaveBeenCalledWith('terminal', '\u001b');
    expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalled();
    expect(mockPtyKill).toHaveBeenCalledWith('terminal', {
      signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    });
    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
  });

  it('does not let an idle transcript sync error abort shutdown', async () => {
    const service = seedService();
    mockSyncClaudeTerminalTranscript.mockResolvedValueOnce({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 0,
      importedMessages: [],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
      errors: ['old sync failure'],
    });

    await expect(
      service.shutdown({ recordInterrupted: true }),
    ).resolves.toBeUndefined();
    expect(mockPtyKill).toHaveBeenCalledWith('terminal', {
      signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    });
  });

  it('cleans up a spawned terminal when final launch persistence fails', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
    });
    mockWriteChatTabsFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('persist failed'));
    const service = createService();

    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow('persist failed');

    expect(mockSpawnManagedTerminal).toHaveBeenCalled();
    expect(mockPtyKill).toHaveBeenCalledWith('terminal', {
      signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    });
    expect(mockUnregisterCanopyWorktreeSessionRoute).toHaveBeenCalled();
    expect(mockUnregisterMcpProxyRoutesForSession).toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('/worktree-data/w/claude-terminal/chat'),
      {
        recursive: true,
        force: true,
      },
    );
    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
  });

  it('removes runtime records after natural terminal exit', async () => {
    const service = seedService();
    if (!mockTerminalEventListener) {
      throw new Error('Expected terminal event listener to be registered.');
    }

    mockTerminalEventListener(IPC_CHANNELS.terminalExit, {
      terminalId: 'terminal',
      exitCode: 0,
      signal: null,
    });
    await flushTerminalEventTasks();

    expect(mockUnregisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      'session',
    );
    expect(mockUnregisterMcpProxyRoutesForSession).toHaveBeenCalledWith(
      'session',
    );
    expect(mockRm).toHaveBeenCalledWith('/runtime/canopy-mcp.json', {
      force: true,
    });
    const writeCalls = mockWriteChatTabsFile.mock.calls;
    const persistedTabs = writeCalls[writeCalls.length - 1]?.[2];
    expect(persistedTabs?.tabs[0]).toMatchObject({
      id: 'chat',
      claudeTerminal: { turnState: 'exited' },
    });
    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
  });

  it('stamps firstOutputAt and records latency on the first PTY output after launch', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
    });
    const service = createService();
    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    });
    if (!mockTerminalEventListener) {
      throw new Error('Expected terminal event listener to be registered.');
    }
    expect(service.getState('p', 'w', 'chat')?.firstOutputAt).toBeUndefined();

    mockTerminalEventListener(IPC_CHANNELS.terminalOutput, {
      projectId: 'p',
      worktreeId: 'w',
      terminalId: 'terminal',
      data: new Uint8Array([104, 105]),
      seq: 2,
    });
    await flushTerminalEventTasks();

    const firstOutputAt = service.getState('p', 'w', 'chat')?.firstOutputAt;
    expect(typeof firstOutputAt).toBe('number');
    const firstOutputDiagnostic = mockRecordSessionDiagnostic.mock.calls.find(
      ([diagnostic]) => diagnostic.kind === 'claude_terminal_first_output',
    )?.[0];
    expect(firstOutputDiagnostic).toMatchObject({
      kind: 'claude_terminal_first_output',
    });
    expect(typeof firstOutputDiagnostic?.elapsedMs).toBe('number');

    // Later output chunks do not restamp or re-record.
    mockRecordSessionDiagnostic.mockClear();
    mockTerminalEventListener(IPC_CHANNELS.terminalOutput, {
      projectId: 'p',
      worktreeId: 'w',
      terminalId: 'terminal',
      data: new Uint8Array([33]),
      seq: 3,
    });
    await flushTerminalEventTasks();
    expect(service.getState('p', 'w', 'chat')?.firstOutputAt).toBe(
      firstOutputAt,
    );
    expect(mockRecordSessionDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'claude_terminal_first_output' }),
    );
  });

  it('resolves inherited approval mode before building terminal launch config', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
    });
    mockReadWorkspaceApprovals.mockResolvedValueOnce({
      version: 1,
      rules: [],
      defaultMode: 'full-access',
    });
    const service = createService();

    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    });

    expect(mockBuildClaudeTerminalLaunchConfig).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'full-access' }),
    );
    await service.shutdown();
  });

  it('appends the graph-available nudge to managed Claude terminal launches', async () => {
    mockHasCodeGraph.mockReturnValue(true);
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
    });
    const service = createService();

    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    });

    const launchConfigInput =
      mockBuildClaudeTerminalLaunchConfig.mock.calls[0]?.[0];
    expect(launchConfigInput?.systemPromptAppend).toContain(
      'A code graph exists for this worktree.',
    );
    expect(launchConfigInput?.systemPromptAppend).toContain(
      'Use GetCodeGraphContext, then QueryCodeGraph or SearchCodeGraph',
    );
    expect(launchConfigInput?.systemPromptAppend).toContain(
      'including in subagents',
    );
    expect(launchConfigInput?.systemPromptAppend).not.toContain(
      'StartForkedAgent',
    );
    expect(launchConfigInput?.systemPromptAppend).not.toContain(
      'StartBranchedAgent',
    );
    expect(mockHasCodeGraph).toHaveBeenCalledWith('p', 'w');
    await service.shutdown();
  });

  it.each([
    ['code review', CODE_REVIEW_CHAT_PROJECT_ID],
    ['plan explore', PLAN_EXPLORE_CHAT_PROJECT_ID],
  ])(
    'resolves %s terminal approval defaults against the owning worktree',
    async (_label, projectId) => {
      mockReadChatTabsFile.mockResolvedValue({
        tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
      });
      mockResolveWorktreeTargetIds.mockReturnValueOnce({
        projectId: 'real-project',
        worktreeId: 'real-worktree',
      });
      mockReadWorkspaceApprovals.mockResolvedValueOnce({
        version: 1,
        rules: [],
        defaultMode: 'full-access',
      });
      const service = createService();

      await service.launch({
        projectId,
        worktreeId: 'scope-id',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      });

      expect(mockResolveWorktreeTargetIds).toHaveBeenCalledWith(
        projectId,
        'scope-id',
      );
      expect(mockReadWorkspaceApprovals).toHaveBeenCalledWith('real-project');
      expect(mockReadWorkspaceApprovalsManifest).toHaveBeenCalledWith(
        'real-project',
      );
      expect(mockCreateApprovalSession).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          worktreeId: 'scope-id',
        }),
      );
      expect(mockBuildClaudeTerminalLaunchConfig).toHaveBeenCalledWith(
        expect.objectContaining({ approvalMode: 'full-access' }),
      );
      await service.shutdown();
    },
  );

  it('resolves legacy standalone approval defaults against its cowork project', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
    });
    mockResolveWorktreeTargetIds.mockReturnValueOnce({
      projectId: 'cowork-workspace',
      worktreeId: 'home',
    });
    mockReadWorkspaceApprovals.mockResolvedValueOnce({
      version: 1,
      rules: [],
      defaultMode: 'ask',
    });
    mockReadPreferencesFile.mockResolvedValueOnce({
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'full-access',
        appAdvisor: 'ask',
      },
    });
    const service = createService();

    await service.launch({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'legacy-workspace-id',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    });

    expect(mockReadWorkspaceApprovals).toHaveBeenCalledWith('cowork-workspace');
    expect(mockReadWorkspaceApprovalsManifest).toHaveBeenCalledWith(
      'cowork-workspace',
    );
    expect(mockBuildClaudeTerminalLaunchConfig).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'ask' }),
    );
    expect(mockCreateApprovalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'legacy-workspace-id',
      }),
    );
    await service.shutdown();
  });

  it('fails closed when a terminal sentinel has no owning worktree', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
    });
    mockResolveWorktreeTargetIds.mockReturnValueOnce(null);
    const service = createService();

    await service.launch({
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'missing-scope',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    });

    expect(mockReadWorkspaceApprovals).not.toHaveBeenCalled();
    expect(mockReadWorkspaceApprovalsManifest).not.toHaveBeenCalled();
    expect(mockBuildClaudeTerminalLaunchConfig).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'ask' }),
    );
    await service.shutdown();
  });

  it('uses a retained live downgrade when building terminal launch config', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
    });
    mockReadWorkspaceApprovals.mockResolvedValueOnce({
      version: 1,
      rules: [],
      defaultMode: 'full-access',
    });
    const service = createService();
    await service.setApprovalMode('p', 'w', 'chat', 'ask');

    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    });

    expect(mockBuildClaudeTerminalLaunchConfig).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'ask' }),
    );
    await service.shutdown();
  });

  it('passes the native caffeinate preference to terminal launch config', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      approvalDefaults: DEFAULT_APPROVAL_DEFAULTS,
      preventClaudeNativeCaffeinate: false,
    });
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
    });
    const service = createService();

    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    });

    expect(
      mockBuildClaudeTerminalLaunchConfig.mock.calls[0]?.[0],
    ).toMatchObject({
      preventClaudeNativeCaffeinate: false,
    });
  });

  it('commits terminal auto-archive requests before broadcasting them', async () => {
    let releaseCommit: (() => void) | undefined;
    mockIngestProviderEvent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCommit = resolve;
        }),
    );
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
    });
    const service = createService();
    const eventSender = jest.fn<void, [string, unknown]>();
    service.setEventSender(eventSender);

    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    });
    const route = mockRegisterCanopyWorktreeSessionRoute.mock.calls[0]?.[0];
    const onSetAutoArchive: ((enabled: boolean) => Promise<void>) | undefined =
      route?.onSetAutoArchive;
    expect(onSetAutoArchive).toBeDefined();

    const request = onSetAutoArchive?.(true);
    await Promise.resolve();

    const committedEvent = mockIngestProviderEvent.mock.calls[0]?.[0];
    expect(committedEvent).toMatchObject({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      data: {
        type: 'canopy_set_auto_archive_requested',
        enabled: true,
      },
      source: 'terminal',
    });
    expect(committedEvent?.mutationId).toMatch(/^terminal:auto-archive:/);
    expect(eventSender).not.toHaveBeenCalledWith(
      IPC_CHANNELS.chatEvent,
      expect.anything(),
    );

    releaseCommit?.();
    await request;

    expect(eventSender).toHaveBeenCalledWith(IPC_CHANNELS.chatEvent, {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      data: {
        type: 'canopy_set_auto_archive_requested',
        enabled: true,
      },
    });
    await service.shutdown();
  });

  it('uses authoritative deferred-reload selections instead of stale persisted selections', async () => {
    const persistedSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    };
    const reloadSelections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'source', skillName: 'new-skill' }],
      pluginRefs: [],
    };
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [
        {
          id: 'chat',
          providerType: 'claude',
          sdkSessionId: 'sdk',
          pluginSelections: persistedSelections,
        },
      ],
    });
    const service = createService();

    await service.launch(
      {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      },
      { pluginSelections: reloadSelections },
    );

    expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({ pluginSelections: reloadSelections }),
    );
    expect(mockBuildClaudeTerminalLaunchConfig).toHaveBeenCalledWith(
      expect.objectContaining({ pluginSelections: reloadSelections }),
    );
    await service.shutdown();
  });

  it('records diagnostics when natural terminal exit artifact cleanup fails', async () => {
    mockRm.mockRejectedValueOnce(new Error('remove failed'));
    seedService();
    if (!mockTerminalEventListener) {
      throw new Error('Expected terminal event listener to be registered.');
    }

    mockTerminalEventListener(IPC_CHANNELS.terminalExit, {
      terminalId: 'terminal',
      exitCode: 0,
      signal: null,
    });
    await flushTerminalEventTasks();

    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'claude_terminal_process_error',
        error: 'remove failed',
      }),
    );
  });

  it('records diagnostics when natural terminal exit state persistence fails', async () => {
    mockWriteChatTabsFile.mockRejectedValueOnce(new Error('persist failed'));
    seedService();
    if (!mockTerminalEventListener) {
      throw new Error('Expected terminal event listener to be registered.');
    }

    mockTerminalEventListener(IPC_CHANNELS.terminalExit, {
      terminalId: 'terminal',
      exitCode: 0,
      signal: null,
    });
    await flushTerminalEventTasks();

    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'claude_terminal_process_error',
        error: 'persist failed',
      }),
    );
  });

  it('keeps the existing terminal session after StopFailure', async () => {
    jest.useFakeTimers();
    try {
      mockReadChatTabsFile.mockResolvedValue({
        tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
      });
      const service = seedService();

      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'StopFailure',
        hookPayload: {},
      });
      expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');

      const response = await service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      });

      expect(response.terminalId).toBe('terminal');
      expect(mockPtyKill).not.toHaveBeenCalled();
      expect(mockUnregisterCanopyWorktreeSessionRoute).not.toHaveBeenCalled();
      expect(mockUnregisterMcpProxyRoutesForSession).not.toHaveBeenCalled();
      expect(mockSpawnManagedTerminal).not.toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('rejects existing terminal session reuse while terminal chats are disabled', async () => {
    const service = seedService();
    mockIsClaudeTuiChatsEnabled.mockReturnValue(false);

    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow('Claude Code terminal chat mode is disabled.');

    expect(service.getState('p', 'w', 'chat')?.terminalId).toBe('terminal');
    expect(mockSpawnManagedTerminal).not.toHaveBeenCalled();
    expect(mockGetCachedClaudeAuthStatusObserved).not.toHaveBeenCalled();
  });

  it('shares an in-flight launch instead of returning an empty terminal id', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude' }],
    });
    let resolveConfig:
      | ((value: {
          executable: string;
          args: string[];
          env: Record<string, string>;
        }) => void)
      | undefined;
    mockBuildClaudeTerminalLaunchConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
    );
    const service = createService();
    const request = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    };

    const firstLaunch = service.launch(request);
    while (mockBuildClaudeTerminalLaunchConfig.mock.calls.length === 0) {
      await Promise.resolve();
    }
    const secondLaunch = service.launch(request);
    await Promise.resolve();
    const startingState = service.getState('p', 'w', 'chat');
    expect(startingState).toMatchObject({ turnState: 'starting' });
    expect(startingState?.terminalId).toBeUndefined();

    resolveConfig?.({ executable: '/bin/claude', args: [], env: {} });
    await expect(Promise.all([firstLaunch, secondLaunch])).resolves.toEqual([
      expect.objectContaining({ terminalId: 'terminal' }),
      expect.objectContaining({ terminalId: 'terminal' }),
    ]);
    expect(mockSpawnManagedTerminal).toHaveBeenCalledTimes(1);
  });

  it('launches App Advisor Claude Code with Advisor tools and the global cwd, ignoring the selected worktree', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [
        {
          id: 'chat',
          providerType: 'claude',
          sdkSessionId: 'sdk',
          deferredToolsAllowed: false,
          pluginSelections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'source', skillName: 'selected-skill' }],
            pluginRefs: [],
            mcpServerRefs: [],
          },
        },
      ],
    });
    mockResolveWorktreeCwd.mockImplementation((projectId, worktreeId, repo) =>
      repo
        ? `/worktrees/${projectId}/${worktreeId}/${repo}`
        : `/worktrees/${projectId}/${worktreeId}`,
    );
    const appAdvisorRuntime = {
      deferredToolsRuntime: {
        scope: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
          chatId: 'chat',
        },
        interfaceMode: 'canopy',
        assistantMode: 'app-advisor',
        allowed: true,
      },
      requestUiState: jest.fn(() =>
        Promise.resolve({
          version: 1,
          revision: 7,
          capturedAt: new Date(0).toISOString(),
          digest: 'ui-digest',
          snapshot: {
            activePage: 'main',
            overlays: {
              commandPaletteOpen: false,
              fileSearchPaletteOpen: false,
              prPickerOpen: false,
              canopyPortalOpen: false,
              appAdvisorOpen: true,
            },
            selectedWorktree: {
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              repoId: 'repo-a',
            },
          },
        }),
      ),
    };
    const service = createService();

    await service.launch(
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'chat',
        assistantMode: 'app-advisor',
        cols: 80,
        rows: 24,
      },
      { appAdvisorRuntime: appAdvisorRuntime as never },
    );

    // App Advisor always runs from its dedicated home directory, never the
    // worktree selected in the main window.
    const globalCwd = getAppAdvisorHomeDir();
    expect(globalCwd.endsWith('/app-workspaces/app-advisor/home')).toBe(true);
    expect(globalCwd).not.toBe('/worktrees/project-1/worktree-1/repo-a');
    expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantMode: 'app-advisor',
        cwd: globalCwd,
        appAdvisorRuntime,
      }),
    );
    expect(appAdvisorRuntime.deferredToolsRuntime).toMatchObject({
      providerType: 'claude',
      allowed: false,
      pluginSelections: {
        skillRefs: [{ sourceId: 'source', skillName: 'selected-skill' }],
      },
    });
    const updatedSelections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
    };
    service.updateDeferredToolsContext(
      APP_ADVISOR_PROJECT_ID,
      APP_ADVISOR_WORKTREE_ID,
      'chat',
      {
        pluginSelections: updatedSelections,
        deferredToolsAllowed: true,
      },
    );
    expect(appAdvisorRuntime.deferredToolsRuntime).toMatchObject({
      allowed: true,
      pluginSelections: updatedSelections,
    });
    const launchConfigRequest =
      mockBuildClaudeTerminalLaunchConfig.mock.calls[0]?.[0];
    expect(launchConfigRequest).toMatchObject({
      cwd: globalCwd,
      canopyMcpServerName: 'canopy_app_advisor',
    });
    // The launch-time UI-state snapshot is no longer baked into the system
    // prompt; the agent fetches current state via GetCurrentUiState instead.
    expect(launchConfigRequest?.systemPromptAppend).not.toContain(
      '<app_advisor_context>',
    );
    expect(launchConfigRequest?.systemPromptAppend).toContain(
      'You are App Advisor',
    );
    expect(mockSpawnManagedTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        cwd: globalCwd,
        selectedRepoId: undefined,
      }),
    );
  });

  it('clears the starting runtime record when pre-spawn state persistence fails', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', sdkSessionId: 'sdk' }],
    });
    mockWriteChatTabsFile.mockRejectedValueOnce(new Error('persist failed'));
    const service = createService();

    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow('persist failed');

    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
    expect(mockSpawnManagedTerminal).not.toHaveBeenCalled();
    expect(mockRegisterCanopyWorktreeSessionRoute).not.toHaveBeenCalled();
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'claude_terminal_process_error',
        error: 'persist failed',
      }),
    );
  });

  it('waits for an in-flight launch before cleaning up the runtime', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude' }],
    });
    let resolveConfig:
      | ((value: {
          executable: string;
          args: string[];
          env: Record<string, string>;
        }) => void)
      | undefined;
    mockBuildClaudeTerminalLaunchConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve;
        }),
    );
    const service = createService();
    const request = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    };

    const launchPromise = service.launch(request);
    while (mockBuildClaudeTerminalLaunchConfig.mock.calls.length === 0) {
      await Promise.resolve();
    }
    const cleanupPromise = service.cleanup({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      reason: 'chat-closed',
    });
    await Promise.resolve();

    expect(mockSpawnManagedTerminal).not.toHaveBeenCalled();
    expect(mockPtyKill).not.toHaveBeenCalled();

    resolveConfig?.({ executable: '/bin/claude', args: [], env: {} });
    await expect(launchPromise).resolves.toMatchObject({
      terminalId: 'terminal',
    });
    await cleanupPromise;

    expect(mockSpawnManagedTerminal).toHaveBeenCalledTimes(1);
    expect(mockPtyKill).toHaveBeenCalledWith('terminal', {
      signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
    });
    expect(mockUnregisterCanopyWorktreeSessionRoute).toHaveBeenCalled();
    expect(mockUnregisterMcpProxyRoutesForSession).toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('/worktree-data/w/claude-terminal/chat'),
      {
        recursive: true,
        force: true,
      },
    );
    expect(service.getState('p', 'w', 'chat')).toBeUndefined();
  });

  it('starts existing Canopy sessions with a handoff prompt when Claude Code has no local transcript', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          providerType: 'claude',
          sdkSessionId: 'missing-sdk-for-unit-test',
          createdAt: '2026-05-22T00:00:00.000Z',
          messages: [
            {
              id: 'user-1',
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Continue this older chat' }],
            },
            {
              id: 'assistant-1',
              role: 'assistant',
              timestamp: 2,
              blocks: [{ type: 'text', text: 'Prior assistant context' }],
            },
          ],
        },
      ],
    });
    const service = createService();

    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    });

    const launchConfigInput = mockBuildClaudeTerminalLaunchConfig.mock.calls[
      mockBuildClaudeTerminalLaunchConfig.mock.calls.length - 1
    ]?.[0] as Record<string, unknown> | undefined;
    expect(launchConfigInput).toMatchObject({
      sdkSessionId: 'missing-sdk-for-unit-test',
      resumeExistingSession: false,
    });
    const systemPromptAppend = launchConfigInput?.systemPromptAppend;
    if (typeof systemPromptAppend !== 'string') {
      throw new Error('Expected systemPromptAppend to be a string.');
    }
    expect(systemPromptAppend).toContain('<canopy_terminal_session_handoff>');
    expect(systemPromptAppend).toContain('Continue this older chat');
  });

  it('starts a truncated point-in-time fork fresh in terminal mode', async () => {
    const sourceTab = {
      id: 'chat',
      title: 'Forked chat',
      providerType: 'claude',
      sdkSessionId: 'source-sdk-session',
      claudeForkSessionOnNextSend: true,
      createdAt: '2026-05-22T00:00:00.000Z',
      forkedFrom: {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'source-chat',
        atMessageId: 'assistant-1',
        resumePointRequired: true,
      },
      messages: [
        {
          id: 'user-1',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Keep only this context' }],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: 2,
          blocks: [{ type: 'text', text: 'Kept answer' }],
        },
      ],
    };
    mockReadChatTabsFile.mockResolvedValue({ tabs: [sourceTab] });
    // The source transcript exists, but terminal mode cannot apply the
    // point-in-time anchor and therefore must not resume it.
    mockAccess.mockResolvedValue(undefined);
    const service = createService();

    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      initialPrompt: 'Continue from the kept context',
      cols: 80,
      rows: 24,
    });

    const launchConfigInput =
      mockBuildClaudeTerminalLaunchConfig.mock.calls[
        mockBuildClaudeTerminalLaunchConfig.mock.calls.length - 1
      ]?.[0];
    expect(launchConfigInput).toMatchObject({
      initialPrompt: 'Continue from the kept context',
      resumeExistingSession: false,
    });
    expect(launchConfigInput?.sdkSessionId).not.toBe('source-sdk-session');
    expect(String(launchConfigInput?.systemPromptAppend)).toContain(
      '<canopy_terminal_session_handoff>',
    );
    expect(String(launchConfigInput?.systemPromptAppend)).toContain(
      'Keep only this context',
    );

    const persistedFreshTab = mockWriteChatTabsFile.mock.calls
      .flatMap(([, , file]) => file.tabs)
      .find(
        (tab) =>
          isUnknownRecord(tab.forkedFrom) &&
          tab.forkedFrom.modelContext === 'fresh',
      );
    expect(persistedFreshTab).toMatchObject({
      id: 'chat',
      forkedFrom: {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'source-chat',
        modelContext: 'fresh',
      },
    });
    expect(persistedFreshTab?.sdkSessionId).not.toBe('source-sdk-session');
    expect(persistedFreshTab?.claudeForkSessionOnNextSend).toBeUndefined();
    const persistedForkSource = persistedFreshTab?.forkedFrom;
    expect(
      isUnknownRecord(persistedForkSource)
        ? persistedForkSource.resumePointRequired
        : undefined,
    ).toBeUndefined();
  });

  it('retains the point-in-time handoff marker when terminal spawning fails', async () => {
    let tabsFile: MockTabsFile = {
      tabs: [
        {
          id: 'chat',
          title: 'Forked chat',
          providerType: 'claude',
          sdkSessionId: 'source-sdk-session',
          claudeForkSessionOnNextSend: true,
          createdAt: '2026-05-22T00:00:00.000Z',
          forkedFrom: {
            projectId: 'p',
            worktreeId: 'w',
            chatId: 'source-chat',
            atMessageId: 'assistant-1',
            resumePointRequired: true,
          },
          messages: [
            {
              id: 'assistant-1',
              role: 'assistant',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Kept answer' }],
            },
          ],
        },
      ],
    };
    mockReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(structuredClone(tabsFile)),
    );
    mockWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, nextTabsFile) => {
        tabsFile = structuredClone(nextTabsFile);
        return Promise.resolve();
      },
    );
    mockSpawnManagedTerminal
      .mockImplementationOnce(() => {
        throw new Error('spawn failed');
      })
      .mockReturnValueOnce({ id: 'terminal-after-retry' });
    const service = createService();
    const request = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      initialPrompt: 'Continue from the kept context',
      cols: 80,
      rows: 24,
    };

    await expect(service.launch(request)).rejects.toThrow('spawn failed');
    expect(tabsFile.tabs[0]?.sdkSessionId).toBe('source-sdk-session');
    expect(tabsFile.tabs[0]?.claudeForkSessionOnNextSend).toBe(true);
    expect(
      isUnknownRecord(tabsFile.tabs[0]?.forkedFrom)
        ? tabsFile.tabs[0]?.forkedFrom.resumePointRequired
        : undefined,
    ).toBe(true);

    await expect(service.launch(request)).resolves.toMatchObject({
      terminalId: 'terminal-after-retry',
    });
    const retryLaunchInput =
      mockBuildClaudeTerminalLaunchConfig.mock.calls.at(-1)?.[0];
    expect(String(retryLaunchInput?.systemPromptAppend)).toContain(
      '<canopy_terminal_session_handoff>',
    );
  });

  it('resumes a completed point-in-time fork in terminal mode', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [
        {
          id: 'chat',
          title: 'Continued fork',
          providerType: 'claude',
          sdkSessionId: 'forked-sdk-session',
          createdAt: '2026-05-22T00:00:00.000Z',
          forkedFrom: {
            projectId: 'p',
            worktreeId: 'w',
            chatId: 'source-chat',
            resumePointRequired: true,
          },
          messages: [],
        },
      ],
    });
    mockAccess.mockResolvedValue(undefined);
    const service = createService();

    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      cols: 80,
      rows: 24,
    });

    const launchConfigInput =
      mockBuildClaudeTerminalLaunchConfig.mock.calls[
        mockBuildClaudeTerminalLaunchConfig.mock.calls.length - 1
      ]?.[0];
    expect(launchConfigInput).toMatchObject({
      sdkSessionId: 'forked-sdk-session',
      resumeExistingSession: true,
    });
  });

  it('passes an initial prompt to Claude Code without duplicating it in handoff context', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [
        {
          id: 'chat',
          providerType: 'claude',
          sdkSessionId: 'fresh-hook-sdk',
          messages: [
            {
              id: 'user-1',
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Review hook failures' }],
            },
          ],
        },
      ],
    });
    const service = createService();

    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      initialPrompt: 'Review hook failures',
      cols: 80,
      rows: 24,
    });

    const launchConfigInput = mockBuildClaudeTerminalLaunchConfig.mock.calls[
      mockBuildClaudeTerminalLaunchConfig.mock.calls.length - 1
    ]?.[0] as Record<string, unknown> | undefined;
    expect(launchConfigInput).toMatchObject({
      initialPrompt: 'Review hook failures',
      sdkSessionId: 'fresh-hook-sdk',
      resumeExistingSession: false,
    });
    expect(String(launchConfigInput?.systemPromptAppend)).not.toContain(
      '<canopy_terminal_session_handoff>',
    );
  });

  it('trusts the Canopy worktree before spawning Claude Code', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', planMode: false }],
    });
    mockResolveWorktreeCwd.mockImplementation(
      (_projectId, _worktreeId, selectedRepoId) =>
        selectedRepoId ? '/worktree/repo-a' : '/worktree',
    );
    const service = createService();

    await service.launch({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      selectedRepoId: 'repo-a',
      cols: 80,
      rows: 24,
    });

    expect(mockEnsureClaudeWorkspaceTrust).toHaveBeenCalledWith('/worktree');
    expect(mockEnsureClaudeWorkspaceTrust).toHaveBeenCalledWith(
      '/worktree/repo-a',
    );
    expect(mockRegisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/worktree/repo-a',
      }),
    );
    const trustOrder =
      mockEnsureClaudeWorkspaceTrust.mock.invocationCallOrder[0] ?? Infinity;
    const spawnOrder =
      mockSpawnManagedTerminal.mock.invocationCallOrder[0] ?? -Infinity;
    expect(trustOrder).toBeLessThan(spawnOrder);
  });

  it('rejects non-Claude launches with a typed error code', async () => {
    mockReadChatTabsFile.mockResolvedValueOnce({
      tabs: [{ id: 'chat', providerType: 'codex' }],
    });
    const service = createService();

    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_provider',
      message: 'Claude Code terminal mode is only available for Claude chats.',
    });
  });

  it('rejects terminal launches when Claude is not authenticated', async () => {
    mockGetCachedClaudeAuthStatusObserved.mockResolvedValueOnce({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Claude is not authenticated.',
    });
    const service = createService();

    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({
      code: 'claude_not_authenticated',
      message:
        'Claude is not authenticated. Sign in from Settings before using terminal mode.',
    });

    expect(mockGetCachedClaudeAuthStatusObserved).toHaveBeenCalledWith(
      'claude-terminal-launch',
      { forceRefresh: true },
    );
    expect(mockSpawnManagedTerminal).not.toHaveBeenCalled();
  });

  it('reports a missing Claude CLI when terminal launch auth cannot run', async () => {
    mockGetCachedClaudeAuthStatusObserved.mockResolvedValueOnce({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Claude CLI is not installed.',
    });
    const service = createService();

    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({
      code: 'claude_not_authenticated',
      message: 'Claude CLI is not installed.',
    });

    expect(mockGetCachedClaudeAuthStatusObserved).toHaveBeenCalledWith(
      'claude-terminal-launch',
      { forceRefresh: true },
    );
    expect(mockSpawnManagedTerminal).not.toHaveBeenCalled();
  });

  it('persists a provided tab snapshot when launching a just-created terminal tab', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [],
      activeTabId: '',
      version: 1,
    });
    const service = createService();

    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'new-chat',
        cols: 80,
        rows: 24,
        initialPrompt: 'hello there',
        tabSnapshot: {
          id: 'new-chat',
          title: 'New Chat',
          createdAt: '2026-05-23T00:00:00.000Z',
          messages: [],
          providerType: 'claude',
          model: 'opus[1m]',
          interfaceMode: 'claude-code',
        },
      }),
    ).resolves.toMatchObject({
      terminalId: 'terminal',
    });

    expect(mockWriteChatTabsFile).toHaveBeenCalledWith(
      'p',
      'w',
      expect.objectContaining({
        activeTabId: 'new-chat',
        tabs: [
          expect.objectContaining({
            id: 'new-chat',
            providerType: 'claude',
            interfaceMode: 'claude-code',
          }),
        ],
      }),
    );
  });

  it('serializes terminal-state persistence with other chat-tab mutations', async () => {
    const projectId = 'serialization-project';
    const worktreeId = 'serialization-worktree';
    const chatId = 'serialization-chat';
    const service = createService();
    let releaseMutation: (() => void) | undefined;
    const mutationBlocked = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let persistedTabs = {
      version: 1,
      activeTabId: chatId,
      tabs: [{ id: chatId, providerType: 'claude' as const, title: 'Chat' }],
    };
    mockReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabs),
    );
    mockWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, data) => {
        persistedTabs = data;
        return Promise.resolve();
      },
    );
    const inFlightMutation = enqueueChatTabMutation(
      projectId,
      worktreeId,
      async () => {
        await mutationBlocked;
        persistedTabs = {
          ...persistedTabs,
          tabs: persistedTabs.tabs.map((tab) => ({
            ...tab,
            title: 'Renderer title',
          })),
        };
      },
    );

    try {
      const launchPromise = service.launch({
        projectId,
        worktreeId,
        chatId,
        cols: 80,
        rows: 24,
      });
      await expect(
        Promise.race([
          launchPromise.then(
            () => 'launch-settled',
            () => 'launch-settled',
          ),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('still-blocked'), 50),
          ),
        ]),
      ).resolves.toBe('still-blocked');

      releaseMutation?.();
      await inFlightMutation;
      await launchPromise;
      expect(mockWriteChatTabsFile).toHaveBeenCalled();
      expect(persistedTabs.tabs[0]?.title).toBe('Renderer title');
      expect('claudeTerminal' in (persistedTabs.tabs[0] ?? {})).toBe(true);
    } finally {
      releaseMutation?.();
      await inFlightMutation;
    }
  });

  it('marks launch setup failures as error so Claude Code can be retried', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [
        {
          id: 'chat',
          providerType: 'claude',
          sdkSessionId: 'sdk',
          planMode: false,
          thinkingLevel: 'high',
        },
      ],
    });
    mockBuildClaudeTerminalLaunchConfig.mockRejectedValueOnce(
      new Error('config failed'),
    );
    const service = createService();

    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow('config failed');

    expect(service.getState('p', 'w', 'chat')).toMatchObject({
      turnState: 'error',
      lastError: 'config failed',
    });
    expect(mockUnregisterCanopyWorktreeSessionRoute).toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalled();

    mockSpawnManagedTerminal.mockReturnValueOnce({
      id: 'terminal-after-retry',
    });
    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
      }),
    ).resolves.toMatchObject({
      terminalId: 'terminal-after-retry',
      sdkSessionId: 'sdk',
      state: { turnState: 'idle' },
    });
  });

  it('opens and finalizes an audit chat turn around a terminal turn', async () => {
    const service = seedService();
    const importedEvent = {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    };
    mockSyncClaudeTerminalTranscript.mockResolvedValueOnce({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      importedMessages: [],
      importedEvents: [importedEvent],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'do the thing' },
    });

    expect(mockStartChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        provider: 'claude',
        chatMode: 'terminal',
        originalUserText: 'do the thing',
        sdkSessionId: 'sdk',
        isStandalone: false,
      }),
    );

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });

    expect(mockObserveChatEvent).toHaveBeenCalledWith(
      'p',
      'w',
      'chat',
      importedEvent,
    );
    // Token totals land via a synthesized turn-final result event.
    expect(mockObserveChatEvent).toHaveBeenCalledWith('p', 'w', 'chat', {
      type: 'result',
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    });
    expect(mockCompleteChatTurn).toHaveBeenCalledWith(
      'p',
      'w',
      'chat',
      'success',
      undefined,
    );
  });

  it('feeds only genuinely-new events to the open audit turn during a replay-from-start sync', async () => {
    const service = seedService();
    const replayedHistoryEvent = {
      type: 'assistant',
      uuid: 'old-answer',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'previous turn' }],
        usage: { input_tokens: 100, output_tokens: 100 },
      },
    };
    const newEvent = {
      type: 'assistant',
      uuid: 'new-answer',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'fresh content' }],
        usage: { input_tokens: 12, output_tokens: 7 },
      },
    };
    mockSyncClaudeTerminalTranscript.mockResolvedValueOnce({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      // The replay-prefix drop already filtered the old message out; only
      // the fresh assistant message survives as an imported message.
      importedMessages: [
        {
          id: 'new-answer',
          role: 'assistant',
          timestamp: 2,
          blocks: [{ type: 'text', text: 'fresh content' }],
        },
      ],
      importedEvents: [replayedHistoryEvent, newEvent],
      transcriptPath: '/runtime/allowed.jsonl',
      replayedFromStart: true,
      compactionAppended: false,
    });

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'UserPromptSubmit',
      hookPayload: { prompt: 'go' },
    });
    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });

    expect(mockObserveChatEvent).toHaveBeenCalledWith(
      'p',
      'w',
      'chat',
      newEvent,
    );
    expect(mockObserveChatEvent).not.toHaveBeenCalledWith(
      'p',
      'w',
      'chat',
      replayedHistoryEvent,
    );
    // Usage comes from the new event only — not zeroed by the replay, not
    // inflated by the replayed history.
    expect(mockObserveChatEvent).toHaveBeenCalledWith('p', 'w', 'chat', {
      type: 'result',
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
  });

  it('reaps idle auto-mode terminals after the idle TTL', async () => {
    jest.useFakeTimers();
    try {
      const service = seedService();
      const record = (
        service as unknown as {
          records: Map<string, Record<string, unknown>>;
        }
      ).records.get('p\0w\0chat');
      if (!record) throw new Error('missing seeded record');
      record.interfaceMode = 'auto';

      // Stop returns the turn to idle, which arms the auto idle TTL.
      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'Stop',
        hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
      });
      expect(mockPtyKill).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(10 * 60_000 + 1);

      expect(mockPtyKill).toHaveBeenCalledWith('terminal', {
        signalOverride: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
      });
      expect(service.getState('p', 'w', 'chat')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not reap idle claude-code-mode terminals', async () => {
    jest.useFakeTimers();
    try {
      const service = seedService();
      const record = (
        service as unknown as {
          records: Map<string, Record<string, unknown>>;
        }
      ).records.get('p\0w\0chat');
      if (!record) throw new Error('missing seeded record');
      record.interfaceMode = 'claude-code';

      await service.markHookState({
        sessionKey: 'session',
        hookEventName: 'Stop',
        hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
      });
      await jest.advanceTimersByTimeAsync(60 * 60_000);

      expect(mockPtyKill).not.toHaveBeenCalled();
      expect(service.getState('p', 'w', 'chat')).toMatchObject({
        turnState: 'idle',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('schedules a chat summary once after importing the first user message', async () => {
    const service = seedService();
    const scheduler = jest.fn(() => {
      mockReadChatTabsFile.mockResolvedValue({
        tabs: [{ id: 'chat', description: 'Saved title' }],
      });
    });
    const workOwner = Promise.resolve({ kind: 'personal' as const });
    mockResolveSessionWorkOwner.mockReturnValue(workOwner);
    service.setChatSummaryScheduler(scheduler);
    const syncResult = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      importedMessages: [
        {
          id: 'user-message',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'summarize me' }],
        },
      ],
      importedEvents: [],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    };
    mockSyncClaudeTerminalTranscript.mockResolvedValue(syncResult);

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });
    await flushTerminalEventTasks();

    expect(
      mockGetInitialChatTitlePrompt.mock.invocationCallOrder[0],
    ).toBeGreaterThan(mockIngestProviderEvent.mock.invocationCallOrder[0]);
    expect(scheduler).toHaveBeenCalledWith({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      workOwner,
    });

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });
    await flushTerminalEventTasks();
    expect(scheduler).toHaveBeenCalledTimes(1);
  });

  it.each([
    { description: 'already summarized' },
    { customTitle: 'My chat' },
    { automaticTitleState: 'closed' },
  ])('does not schedule a summary for settled metadata %s', async (settled) => {
    const service = seedService();
    const scheduler = jest.fn();
    service.setChatSummaryScheduler(scheduler);
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', ...settled }],
    });
    mockSyncClaudeTerminalTranscript.mockResolvedValue({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      importedEventCount: 1,
      importedMessages: [
        {
          id: 'user-message',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'summarize me' }],
        },
      ],
      importedEvents: [],
      transcriptPath: '/runtime/allowed.jsonl',
      compactionAppended: false,
    });

    await service.markHookState({
      sessionKey: 'session',
      hookEventName: 'Stop',
      hookPayload: { transcript_path: '/runtime/allowed.jsonl' },
    });
    await flushTerminalEventTasks();

    expect(scheduler).not.toHaveBeenCalled();
  });

  it('persists the auto interface mode and reports initial prompt submission on launch', async () => {
    const service = createService();
    mockReadChatTabsFile.mockResolvedValue({
      tabs: [{ id: 'chat', providerType: 'claude', messages: [] }],
    });

    await expect(
      service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        interfaceMode: 'auto',
        initialPrompt: 'first prompt',
        cols: 80,
        rows: 24,
      }),
    ).resolves.toMatchObject({
      terminalId: 'terminal',
      initialPromptSubmitted: true,
    });

    expect(mockWriteChatTabsFile).toHaveBeenCalledWith(
      'p',
      'w',
      expect.objectContaining({
        tabs: [expect.objectContaining({ interfaceMode: 'auto' })],
      }),
    );
  });

  describe('Agent Ledger tools', () => {
    const LEDGER_PROMPT = 'LEDGER TOOLS PROMPT BLOCK';
    const HINT =
      '<feed_assignments revision="abc" open="1">You have 1 open Feed entries assigned to you.</feed_assignments>';
    let ledgerTools: MockLedgerTools;

    function launchTerminal(
      service: DefaultClaudeTerminalSessionService,
      overrides: Partial<{
        projectId: string;
        worktreeId: string;
        assistantMode: 'default' | 'app-advisor';
        selectedRepoId: string;
      }> = {},
    ): Promise<{ sessionKey: string }> {
      return service.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        cols: 80,
        rows: 24,
        ...overrides,
      });
    }

    function lastRoute(): Record<string, unknown> | undefined {
      const { calls } = mockRegisterCanopyWorktreeSessionRoute.mock;
      return calls[calls.length - 1]?.[0];
    }

    function lastSystemPromptAppend(): string {
      const { calls } = mockBuildClaudeTerminalLaunchConfig.mock;
      const append = calls[calls.length - 1]?.[0]?.systemPromptAppend;
      return typeof append === 'string' ? append : '';
    }

    beforeEach(() => {
      ledgerTools = {
        systemPrompt: jest.fn(() => LEDGER_PROMPT),
        assignmentHint: jest.fn(() => Promise.resolve(undefined)),
        execute: jest.fn(),
        dispose: jest.fn<void, []>(),
      };
      mockMayExposeLedgerTools.mockReturnValue(true);
      mockOpenLedgerChatTools.mockImplementation(() =>
        Promise.resolve(ledgerTools),
      );
      mockReadChatTabsFile.mockResolvedValue({
        tabs: [
          {
            id: 'chat',
            providerType: 'claude',
            sdkSessionId: 'sdk',
            model: 'opus[1m]',
            thinkingLevel: 'medium',
          },
        ],
      });
    });

    afterEach(() => {
      mockMayExposeLedgerTools.mockReturnValue(false);
      mockOpenLedgerChatTools.mockImplementation(() => Promise.resolve(null));
    });

    it('opens the chat Ledger tools at launch, binds them to the terminal route and appends the Ledger prompt', async () => {
      const service = createService();

      await launchTerminal(service, { selectedRepoId: 'repo-1' });

      const target = { projectId: 'p', worktreeId: 'w', chatId: 'chat' };
      expect(mockMayExposeLedgerTools).toHaveBeenCalledWith(target);
      expect(mockOpenLedgerChatTools).toHaveBeenCalledTimes(1);
      const options = mockOpenLedgerChatTools.mock.calls[0]?.[0];
      expect(options).toMatchObject({
        target,
        harness: 'claude',
        selectedRepoId: 'repo-1',
      });
      expect(options?.readSettings()).toEqual({
        model: 'opus[1m]',
        thinkingEffort: 'medium',
        planMode: false,
      });
      expect(lastRoute()).toMatchObject({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        ledgerTools,
      });
      expect(lastSystemPromptAppend()).toContain(LEDGER_PROMPT);
    });

    it.each([
      ['the flag or scope gate is closed', false],
      ['the setting is off or the scope cannot be resolved', true],
    ])('opens no Ledger tools when %s', async (_label, mayExpose: boolean) => {
      mockMayExposeLedgerTools.mockReturnValue(mayExpose);
      mockOpenLedgerChatTools.mockImplementation(() => Promise.resolve(null));
      const service = createService();

      const { sessionKey } = await launchTerminal(service);
      const hookResult = await service.handleHookCallback(sessionKey, {
        hookEventName: 'UserPromptSubmit',
        hookPayload: { prompt: 'next' },
      });

      expect(mockOpenLedgerChatTools).toHaveBeenCalledTimes(mayExpose ? 1 : 0);
      expect(lastRoute()).not.toHaveProperty('ledgerTools');
      expect(lastSystemPromptAppend()).not.toContain(LEDGER_PROMPT);
      expect(hookResult).toBeUndefined();
    });

    it('leaves App Advisor terminals to the App Advisor tool registry', async () => {
      const service = createService();

      await launchTerminal(service, {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        assistantMode: 'app-advisor',
      });

      expect(mockMayExposeLedgerTools).not.toHaveBeenCalled();
      expect(mockOpenLedgerChatTools).not.toHaveBeenCalled();
      expect(lastRoute()).not.toHaveProperty('ledgerTools');
      expect(lastSystemPromptAppend()).not.toContain(LEDGER_PROMPT);
    });

    it('disposes the Ledger tools when the terminal is cleaned up', async () => {
      const service = createService();
      const { sessionKey } = await launchTerminal(service);

      await service.cleanup({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        reason: 'manual',
      });

      expect(mockUnregisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
        sessionKey,
      );
      expect(ledgerTools.dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes the Ledger tools when the terminal process exits', async () => {
      const service = createService();
      const { sessionKey } = await launchTerminal(service);
      if (!mockTerminalEventListener) {
        throw new Error('Expected terminal event listener to be registered.');
      }

      mockTerminalEventListener(IPC_CHANNELS.terminalExit, {
        terminalId: 'terminal',
        exitCode: 0,
        signal: null,
      });
      await flushTerminalEventTasks();

      expect(mockUnregisterCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
        sessionKey,
      );
      expect(ledgerTools.dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes the Ledger tools when the launch fails after opening them', async () => {
      mockBuildClaudeTerminalLaunchConfig.mockRejectedValueOnce(
        new Error('config failed'),
      );
      const service = createService();

      await expect(launchTerminal(service)).rejects.toThrow('config failed');

      expect(mockOpenLedgerChatTools).toHaveBeenCalledTimes(1);
      expect(ledgerTools.dispose).toHaveBeenCalledTimes(1);
    });

    it('adds the assignment hint to a submitted prompt as hook context', async () => {
      const service = createService();
      const { sessionKey } = await launchTerminal(service);
      ledgerTools.assignmentHint.mockResolvedValueOnce(HINT);

      const withHint = await service.handleHookCallback(sessionKey, {
        hookEventName: 'UserPromptSubmit',
        hookPayload: { prompt: 'first' },
      });
      const withoutHint = await service.handleHookCallback(sessionKey, {
        hookEventName: 'UserPromptSubmit',
        hookPayload: { prompt: 'second' },
      });

      expect(withHint).toEqual({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: HINT,
        },
      });
      expect(withoutHint).toBeUndefined();
      expect(ledgerTools.assignmentHint).toHaveBeenCalledTimes(2);
    });

    it.each([
      // [plan mode, approval mode, policy decision, tool, carries the note]
      [true, 'ask', 'allow', 'add_ledger_entry', true],
      [true, 'auto', 'allow', 'search_ledger_entries', true],
      [true, 'full-access', 'allow', 'update_ledger_entry', true],
      [true, 'ask', 'deny', 'add_ledger_entry', false],
      [false, 'ask', 'allow', 'add_ledger_entry', false],
      [true, 'ask', 'allow', 'save_memory', false],
    ] as const)(
      'treats a Plan mode Ledger call as bookkeeping (plan %s, %s, %s, %s)',
      async (planMode, approvalMode, decision, toolKey, bookkeeping) => {
        const check = jest.fn().mockResolvedValue({
          decision,
          ...(decision === 'deny'
            ? { message: 'Session policy decision' }
            : {}),
        });
        const service = seedService('p', 'w', 'default', {
          planMode,
          approvalSession: { check, dispose: jest.fn() },
          ...(approvalMode === 'full-access'
            ? { approvalMode: 'full-access' as const }
            : {}),
        });
        const toolName = CANOPY_INJECTED_TOOL_REGISTRY[toolKey].claudeToolName;

        const result = await service.handleHookCallback('session', {
          hookEventName: 'PreToolUse',
          hookPayload: {
            tool_name: toolName,
            tool_input: { type: 'TASK', title: 'Plan', content: 'Plan it.' },
          },
        });

        expect(result).toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            ...(decision === 'deny'
              ? { permissionDecisionReason: 'Session policy decision' }
              : {}),
            ...(bookkeeping
              ? { additionalContext: CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT }
              : {}),
          },
        });
        if (approvalMode === 'full-access') {
          expect(check).not.toHaveBeenCalled();
        } else {
          expect(check).toHaveBeenCalledWith(
            {
              kind: 'mcp',
              server: 'canopy',
              tool: CANOPY_INJECTED_TOOL_REGISTRY[toolKey].displayName,
            },
            expect.any(Object),
          );
        }
      },
    );
  });

  describe('plan-file turn ownership', () => {
    const turnKey = JSON.stringify(['p', 'w', 'chat']);
    type ResumeHandler = Parameters<
      typeof deferredToolsReloadCoordinator.registerResumeHandler
    >[1];

    function planTurnLease(index: number): MockPlanTurnLease {
      const lease = mockPlanTurnLeases[index];
      if (!lease) throw new Error(`Expected plan turn lease ${index}`);
      return lease;
    }

    async function markHook(
      service: DefaultClaudeTerminalSessionService,
      hookEventName:
        | 'SessionStart'
        | 'UserPromptSubmit'
        | 'PreToolUse'
        | 'Stop'
        | 'StopFailure'
        | 'SessionEnd',
      sessionKey = 'session',
      prompt = 'Update the plan',
    ): Promise<void> {
      await service.markHookState({
        sessionKey,
        hookEventName,
        hookPayload:
          hookEventName === 'UserPromptSubmit'
            ? { prompt }
            : { transcript_path: '/runtime/allowed.jsonl' },
      });
    }

    async function launchWithResumeHandler(
      service: DefaultClaudeTerminalSessionService,
    ): Promise<ResumeHandler> {
      const registerResumeHandler = jest.spyOn(
        deferredToolsReloadCoordinator,
        'registerResumeHandler',
      );
      try {
        await service.launch({
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'chat',
          cols: 80,
          rows: 24,
        });
        const resume = registerResumeHandler.mock.calls.find(
          ([scope]) => scope.chatId === 'chat',
        )?.[1];
        if (!resume) throw new Error('Expected deferred-tools resume handler');
        return resume;
      } finally {
        registerResumeHandler.mockRestore();
      }
    }

    function sessionKeyOf(
      service: DefaultClaudeTerminalSessionService,
    ): string {
      const sessionKey = service.getState('p', 'w', 'chat')?.sessionKey;
      if (!sessionKey) throw new Error('Expected a live terminal session key');
      return sessionKey;
    }

    function reloadRequest(signal: AbortSignal): Parameters<ResumeHandler>[0] {
      return {
        scope: { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
        requestId: 'reload-request',
        toolCallId: 'tool-call',
        userMessageId: 'message',
        continuationText: '<system_instruction>Continue</system_instruction>',
        enabledResources: [],
        providerType: 'claude',
        signal,
      };
    }

    it('keeps the pin through two scheduled terminal turns and releases on accepted human input', async () => {
      const service = seedService();
      const origin = { projectId: 'p', worktreeId: 'w', chatTabId: 'chat' };
      browserHandoffs.releaseWorktree('p', 'w');
      forgetPresentationChat('p/w/chat');
      let handoff = browserHandoffs.request(
        { projectId: 'p', worktreeId: 'w', browserId: 'browser', origin },
        jest.fn(),
      );
      try {
        stageTerminalPresentationTurn('p/w/chat', 'schedule-1', 'automation');
        stageTerminalPresentationTurn('p/w/chat', 'schedule-2', 'automation');
        await markHook(service, 'UserPromptSubmit');
        expect(capturePresentationTurn(origin)?.source).toBe('user');
        expect(browserHandoffs.snapshot('p', 'w').handoff).toBeNull();
        await markHook(service, 'Stop');
        handoff = browserHandoffs.request(
          { projectId: 'p', worktreeId: 'w', browserId: 'browser', origin },
          jest.fn(),
        );
        for (const turnId of ['schedule-1', 'schedule-2']) {
          await markHook(
            service,
            'UserPromptSubmit',
            'session',
            terminalPresentationPrompt('Scheduled check', turnId),
          );
          expect(capturePresentationTurn(origin)).toMatchObject({
            turnId,
            source: 'automation',
          });
          expect(browserHandoffs.snapshot('p', 'w').handoff?.handoffId).toBe(
            handoff.handoffId,
          );
          await markHook(service, 'Stop');
          expect(capturePresentationTurn(origin)).toBeUndefined();
        }
        await markHook(service, 'UserPromptSubmit');
        expect(capturePresentationTurn(origin)?.source).toBe('user');
        expect(browserHandoffs.snapshot('p', 'w').handoff).toBeNull();
      } finally {
        browserHandoffs.releaseWorktree('p', 'w');
        forgetPresentationChat('p/w/chat');
      }
    });

    it('preserves automation provenance and the pin through a terminal tool reload', async () => {
      const service = createService();
      const resume = await launchWithResumeHandler(service);
      const origin = { projectId: 'p', worktreeId: 'w', chatTabId: 'chat' };
      forgetPresentationChat('p/w/chat');
      try {
        stageTerminalPresentationTurn(
          'p/w/chat',
          'scheduled-reload',
          'automation',
        );
        await markHook(
          service,
          'UserPromptSubmit',
          sessionKeyOf(service),
          terminalPresentationPrompt('Load tools', 'scheduled-reload'),
        );
        const handoff = browserHandoffs.request(
          { projectId: 'p', worktreeId: 'w', browserId: 'browser', origin },
          jest.fn(),
        );
        await resume(reloadRequest(new AbortController().signal));
        const submitted =
          mockBuildClaudeTerminalLaunchConfig.mock.lastCall?.[0].initialPrompt;
        if (!submitted) throw new Error('Expected a continuation prompt');
        await markHook(
          service,
          'UserPromptSubmit',
          sessionKeyOf(service),
          submitted,
        );
        expect(capturePresentationTurn(origin)).toMatchObject({
          turnId: 'scheduled-reload',
          source: 'automation',
        });
        expect(browserHandoffs.snapshot('p', 'w').handoff?.handoffId).toBe(
          handoff.handoffId,
        );
      } finally {
        browserHandoffs.releaseWorktree('p', 'w');
        forgetPresentationChat('p/w/chat');
      }
    });

    it('begins one lease in the chat worktree when a prompt starts a turn', async () => {
      const service = seedService();

      await markHook(service, 'UserPromptSubmit');

      expect(mockResolvePlanTurnScope).toHaveBeenCalledWith('p', 'w');
      expect(mockBeginPlanTurn).toHaveBeenCalledTimes(1);
      expect(mockBeginPlanTurn).toHaveBeenCalledWith(turnKey, {
        projectId: 'p',
        worktreeId: 'w',
      });
      expect(planTurnLease(0).end).not.toHaveBeenCalled();
    });

    it('begins once while the turn keeps running', async () => {
      const service = seedService();

      await markHook(service, 'UserPromptSubmit');
      await markHook(service, 'UserPromptSubmit');
      await markHook(service, 'PreToolUse');

      expect(mockBeginPlanTurn).toHaveBeenCalledTimes(1);
      expect(planTurnLease(0).end).not.toHaveBeenCalled();
    });

    it('ends the lease on Stop only after the transcript sync finishes', async () => {
      const service = seedService();
      await markHook(service, 'UserPromptSubmit');
      let finishSync: (() => void) | undefined;
      mockSyncClaudeTerminalTranscript.mockImplementationOnce(
        () =>
          new Promise<MockTranscriptSyncResult>((resolve) => {
            finishSync = (): void =>
              resolve({
                projectId: 'p',
                worktreeId: 'w',
                chatId: 'chat',
                importedEventCount: 0,
                importedMessages: [],
                transcriptPath: '/runtime/allowed.jsonl',
                compactionAppended: false,
              });
          }),
      );

      const stop = markHook(service, 'Stop');
      await flushTerminalEventTasks();

      expect(mockSyncClaudeTerminalTranscript).toHaveBeenCalledWith(
        expect.objectContaining({ hookEventName: 'Stop' }),
      );
      expect(planTurnLease(0).end).not.toHaveBeenCalled();

      finishSync?.();
      await stop;

      expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
      expect(planTurnLease(0).end).toHaveBeenCalledTimes(1);
    });

    it.each(['StopFailure', 'SessionEnd'] as const)(
      'ends the lease when %s ends the turn',
      async (hookEventName) => {
        const service = seedService();
        await markHook(service, 'UserPromptSubmit');

        await markHook(service, hookEventName);

        expect(service.getState('p', 'w', 'chat')?.turnState).not.toBe(
          'running',
        );
        expect(planTurnLease(0).end).toHaveBeenCalledTimes(1);
      },
    );

    it('ends the lease when the user interrupts the turn', async () => {
      const service = seedService();
      await markHook(service, 'UserPromptSubmit');

      await service.interrupt({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
      });

      expect(service.getState('p', 'w', 'chat')?.turnState).toBe('idle');
      expect(planTurnLease(0).end).toHaveBeenCalledTimes(1);
    });

    it('ends the lease when the terminal process exits mid-turn', async () => {
      const service = seedService();
      await markHook(service, 'UserPromptSubmit');
      if (!mockTerminalEventListener) {
        throw new Error('Expected terminal event listener to be registered.');
      }

      mockTerminalEventListener(IPC_CHANNELS.terminalExit, {
        terminalId: 'terminal',
        exitCode: 1,
        signal: null,
      });
      await flushTerminalEventTasks();

      expect(planTurnLease(0).end).toHaveBeenCalledTimes(1);
    });

    it('ends the lease when the terminal is cleaned up', async () => {
      const service = seedService();
      await markHook(service, 'UserPromptSubmit');

      await service.cleanup({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        reason: 'chat-closed',
      });

      expect(planTurnLease(0).end).toHaveBeenCalledTimes(1);
    });

    it('keeps the lease live across a deferred-tools reload until the relaunched turn supersedes it', async () => {
      const service = createService();
      const resume = await launchWithResumeHandler(service);
      const firstSessionKey = sessionKeyOf(service);
      await markHook(service, 'UserPromptSubmit', firstSessionKey);
      const observation = structuredClone(mockWatcherObservations);

      await resume(reloadRequest(new AbortController().signal));

      expect(mockWatcherObservations).toEqual(observation);
      // The reload cleanup does not end the running turn's lease.
      expect(planTurnLease(0).end).not.toHaveBeenCalled();
      const relaunchedSessionKey = sessionKeyOf(service);
      expect(relaunchedSessionKey).not.toBe(firstSessionKey);
      await markHook(service, 'SessionStart', relaunchedSessionKey);
      expect(planTurnLease(0).end).not.toHaveBeenCalled();

      await markHook(service, 'UserPromptSubmit', relaunchedSessionKey);

      expect(mockBeginPlanTurn).toHaveBeenCalledTimes(2);
      expect(mockBeginPlanTurn).toHaveBeenLastCalledWith(turnKey, {
        projectId: 'p',
        worktreeId: 'w',
      });
      // The carried lease is released only after the same-key turn began, so
      // the scope never goes idle in between.
      const [carriedEndOrder] = planTurnLease(0).end.mock.invocationCallOrder;
      const relaunchBeginOrder = mockBeginPlanTurn.mock.invocationCallOrder[1];
      expect(carriedEndOrder).toBeGreaterThan(relaunchBeginOrder ?? Infinity);
      expect(planTurnLease(1).end).not.toHaveBeenCalled();

      await markHook(service, 'Stop', relaunchedSessionKey);

      expect(planTurnLease(1).end).toHaveBeenCalledTimes(1);
    });

    it('releases the carried lease when the relaunched terminal exits before its first turn', async () => {
      const service = createService();
      const resume = await launchWithResumeHandler(service);
      await markHook(service, 'UserPromptSubmit', sessionKeyOf(service));
      await resume(reloadRequest(new AbortController().signal));
      if (!mockTerminalEventListener) {
        throw new Error('Expected terminal event listener to be registered.');
      }

      mockTerminalEventListener(IPC_CHANNELS.terminalExit, {
        terminalId: 'terminal',
        exitCode: 1,
        signal: null,
      });
      await flushTerminalEventTasks();

      expect(mockBeginPlanTurn).toHaveBeenCalledTimes(1);
      expect(planTurnLease(0).end).toHaveBeenCalledTimes(1);
    });

    it('releases the running turn lease when a deferred-tools reload is aborted', async () => {
      const service = createService();
      const resume = await launchWithResumeHandler(service);
      await markHook(service, 'UserPromptSubmit', sessionKeyOf(service));
      const controller = new AbortController();
      mockSpawnManagedTerminal.mockImplementationOnce(() => {
        controller.abort();
        return { id: 'terminal' };
      });

      await expect(resume(reloadRequest(controller.signal))).rejects.toThrow();

      expect(mockBeginPlanTurn).toHaveBeenCalledTimes(1);
      expect(planTurnLease(0).end).toHaveBeenCalledTimes(1);
    });

    it('begins no lease for an App Advisor terminal', async () => {
      const service = seedService(
        APP_ADVISOR_PROJECT_ID,
        APP_ADVISOR_WORKTREE_ID,
        'app-advisor',
      );
      mockResolvePlanTurnScope.mockReturnValue(null);

      await markHook(service, 'UserPromptSubmit');
      await markHook(service, 'Stop');

      expect(mockResolvePlanTurnScope).toHaveBeenCalledWith(
        APP_ADVISOR_PROJECT_ID,
        APP_ADVISOR_WORKTREE_ID,
      );
      expect(mockBeginPlanTurn).not.toHaveBeenCalled();
    });

    it('begins a plan-explore takeover lease in its registered worktree', async () => {
      const service = seedService(PLAN_EXPLORE_CHAT_PROJECT_ID, 'plan-1');
      mockResolvePlanTurnScope.mockImplementation((projectId, worktreeId) =>
        projectId === PLAN_EXPLORE_CHAT_PROJECT_ID && worktreeId === 'plan-1'
          ? { projectId: 'p', worktreeId: 'real-w' }
          : null,
      );

      await markHook(service, 'UserPromptSubmit');

      expect(mockBeginPlanTurn).toHaveBeenCalledTimes(1);
      expect(mockBeginPlanTurn).toHaveBeenCalledWith(
        JSON.stringify([PLAN_EXPLORE_CHAT_PROJECT_ID, 'plan-1', 'chat']),
        { projectId: 'p', worktreeId: 'real-w' },
      );
    });
  });
});
