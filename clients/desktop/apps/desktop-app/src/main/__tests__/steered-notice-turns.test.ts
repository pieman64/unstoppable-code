/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
/**
 * Exercises ledger-claimed Claude notice pickups through the real router,
 * ChatQueueService and canonical ChatStateService ingestion path.
 *
 * Cases cover the passing two-notice rat shape; 2b prior-terminal queue drain;
 * 2c router-accepted/canonical-rejected pickup; 3a Stop during canonical
 * pickup observation; and 3b unknown/different-root and same-id pickups while
 * a newer typed turn owns the gate.
 * Case 2a is omitted: Claude reports starting pickups only through its callback
 * (claude-input-delivery.ts:145-149); claude-session.ts:941-948 starts a turn
 * only without an activeTurn; the SDK loop (~3053-3057) awaits the prior
 * terminal before clearing it.
 * The Stop race mirrors the production epoch, suspension, queue invalidation,
 * cancellation and untagged-terminal seams, but does not invoke the real Stop
 * IPC/session-manager recreation path.
 */
import type * as ChatQueueServiceModule from '../services/chat-queue-service';
import type * as ChatDispatchAuthorizationModule from '../services/chat-dispatch-authorization';
import type * as ChatTurnAuditModule from '../lib/chat-turn-audit';
import type * as MemoryClientModule from '../memory/memory-client';
import type * as PlanFileSyncModule from '../lib/plan-file-sync';
import type * as ChatTabsReaderModule from '../lib/chat-tabs-reader';
import type * as BackgroundHelperQueueModule from '../lib/background-helper-queue';
import type { AgentSession } from '../agents/types';
import { getChatQueueService } from '../services/chat-queue-service';
import {
  createSteeredNoticeHarness,
  FakeClaudeSession,
  type SteeredNoticeHarness,
} from './helpers/steered-notice-harness';
import { resetChatStateServiceForTests } from '../services/chat-state-service';
import { worktreeChatTurnTestExports } from '../lib/worktree-chat-turn';

const mockSession = new FakeClaudeSession();
const mockModelBlockedByPolicy = jest.fn<Promise<boolean>, unknown[]>(() =>
  Promise.resolve(false),
);
const mockGetOrCreateSession = jest.fn(
  (
    _options: unknown,
    onEvent: (data: unknown) => void | Promise<void>,
  ): AgentSession => {
    mockSession.attach(onEvent);
    return mockSession;
  },
);
const mockGetQueueService = jest.mocked(getChatQueueService);
const mockRecordDiagnostic = jest.fn();
const mockFetchOrgMemoryAttempt = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve({ result: null, factCount: 0, responseReceived: true }),
);
const mockAckOrgMemoryDelivered = jest.fn<Promise<void>, unknown[]>(() =>
  Promise.resolve(),
);
const mockPersistOrgMemoryUsed = jest.fn<Promise<boolean>, unknown[]>(() =>
  Promise.resolve(true),
);
const mockCaptureTurnStart = jest.fn<Promise<void>, unknown[]>(() =>
  Promise.resolve(),
);
const mockCaptureTurnEnd = jest.fn<Promise<unknown>, unknown[]>(() =>
  Promise.resolve(null),
);
const mockSessionObservability = {
  startChatTurn: jest.fn(),
  observeChatEvent: jest.fn(),
  completeChatTurn: jest.fn(),
  recordInjectedPromptForOpenChatTurn: jest.fn(),
  recordSessionDiagnostic: mockRecordDiagnostic,
  recordSessionDiagnosticOnce: jest.fn(),
  startObservedTask: jest.fn(),
  finalizeObservedTask: jest.fn(),
  observeSteeringInput: jest.fn(),
};

jest.setTimeout(30_000);

// The harness queue has no canonical ownership, so it issues no dispatch
// capability; its dispatches stand in for queue-admitted ones.
jest.mock('../services/chat-dispatch-authorization', () => ({
  ...jest.requireActual<typeof ChatDispatchAuthorizationModule>(
    '../services/chat-dispatch-authorization',
  ),
  consumeDispatchAuthorization: (): void => undefined,
}));

jest.mock('../services/chat-queue-service', () => {
  const actual = jest.requireActual<typeof ChatQueueServiceModule>(
    '../services/chat-queue-service',
  );
  return { ...actual, getChatQueueService: jest.fn() };
});

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (...args: unknown[]): Promise<boolean> =>
    mockModelBlockedByPolicy(...args),
}));

jest.mock('../agents/session-manager', () => ({
  subscribeGlobalPluginDefaultsRevision: jest.fn(() => jest.fn()),
  getGlobalPluginDefaultsRevision: jest.fn(() => 0),
  getSessionGlobalPluginDefaultsRevision: jest.fn(() => 0),
  subscribeChatSessionActivity: jest.fn(() => jest.fn()),
  subscribeLiveBackgroundTasks: jest.fn(() => jest.fn()),
  setSessionTurnSettings: jest.fn(),
  getChatSessionLiveness: (): { foreground: boolean; background: boolean } => ({
    foreground: mockSession.isForeground,
    background: false,
  }),
  getSessionPluginSelections: jest.fn(() => ({})),
  getSession: jest.fn(() => mockSession),
  getSessionProviderType: jest.fn(() => 'claude'),
  getOrCreateSession: (
    ...args: [unknown, (data: unknown) => void | Promise<void>]
  ) => mockGetOrCreateSession(...args),
  buildSessionKey: (projectId: string, worktreeId: string, chatId: string) =>
    `${projectId}/${worktreeId}/${chatId}`,
  beginSessionTurnPreparation: jest.fn(() => jest.fn()),
  releaseSessionTurnPreparationOnActivation: jest.fn(),
  getActiveSessionInfos: jest.fn(() => []),
  canReuseSession: jest.fn(() => Promise.resolve(true)),
  canPreserveSessionCapabilitySnapshot: jest.fn(() => Promise.resolve(true)),
  getSessionCodeGraphToolsAdvertised: jest.fn(() => false),
  getSessionGlobalInstructionsSnapshot: jest.fn(() => undefined),
  hasPendingCodexContinuation: jest.fn(() => false),
  drainChatSessionEvents: jest.fn(() => Promise.resolve()),
  destroySession: jest.fn(() => Promise.resolve()),
  shouldRecreateSessionOnNextTurn: jest.fn(() => false),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  restrictSessionApprovalRules: jest.fn(),
  isAgentContinuationEvent: (data: unknown): boolean =>
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data.type === 'assistant' || data.type === 'user'),
}));

jest.mock('../agents/delegation/gate', () => ({
  resolveManagedDelegationMode: (
    mode: 'off' | 'explicit-only' | 'proactive' | undefined,
  ): 'off' | 'explicit-only' | 'proactive' => mode ?? 'explicit-only',
}));

jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: () => ({
    reserveChatTurnStart: () => Promise.resolve({ release: jest.fn() }),
  }),
}));

jest.mock('../lib/preferences-store', () => {
  const preferences = {
    defaultChatProvider: 'claude',
    defaultChatModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
    },
    defaultWorktreeProvider: 'claude',
    defaultWorktreeModelByProvider: {
      claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
    },
    orgMemoryInjectionEnabled: false,
    localMemoryEnabled: false,
  };
  return {
    readPreferencesFile: async () => preferences,
    readPreferencesFileDetailed: async () => ({
      preferences,
      authority: 'ok' as const,
    }),
    updatePreferencesFile: async () => undefined,
    // Approval reads fail closed while preferences could not be loaded.
    peekPreferencesLoadError: () => null,
  };
});

jest.mock('../lib/default-model-lane-resolver', () => ({
  requireLaneAwareDefaultSelection: async () => ({
    model: 'claude-sonnet-4-6',
    thinkingLevel: 'high',
  }),
}));

jest.mock('../agents/agent-model-runtime', () => ({
  resolveAgentModelRuntime: async (options: {
    model: string;
    providerType?: 'claude' | 'codex' | 'ollama';
    systemPromptAppend?: string;
    pluginSelections?: unknown;
  }) => ({
    selectedModel: options.model,
    runtimeModel: options.model,
    providerType: options.providerType ?? 'claude',
    executionHarness: options.providerType ?? 'claude',
    systemPromptAppend: options.systemPromptAppend,
    pluginSelections: options.pluginSelections,
  }),
}));

jest.mock('../lib/org-billing-state', () => ({
  isOrganizationTeamsLapsed: async () => false,
}));

jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: async () => null,
  subscribeCanopyCloudAccountChanges: jest.fn(() => jest.fn()),
}));

jest.mock('../memory/memory-client', () => {
  const actual = jest.requireActual<typeof MemoryClientModule>(
    '../memory/memory-client',
  );
  return {
    CLIENT_FETCH_TIMEOUT_MS: actual.CLIENT_FETCH_TIMEOUT_MS,
    fetchOrgMemoryAttempt: (...args: unknown[]) =>
      mockFetchOrgMemoryAttempt(...args),
    ackOrgMemoryDelivered: (...args: unknown[]) =>
      mockAckOrgMemoryDelivered(...args),
  };
});

jest.mock('../lib/chat-tab-dispatch-utils', () => ({
  persistOrgMemoryUsedForChat: (...args: unknown[]) =>
    mockPersistOrgMemoryUsed(...args),
}));

jest.mock('../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: async () => ({ kind: 'personal' }),
  captureSessionWorkOwner: jest.fn(),
  resolveSessionWorkOwner: async () => ({ kind: 'personal' }),
}));

jest.mock('../lib/branch-namer', () => ({
  generateAndRenameBranch: async () => ({}),
}));

jest.mock('../lib/auth-failure-event', () => ({
  pairPendingAuthFailuresWithTool: () => [],
}));

jest.mock('../lib/auth-failure-turn-stop', () => ({
  stopTurnForAuthFailure: async () => ({
    stopped: false,
    autoResumeSafe: false,
    notified: false,
  }),
}));

jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: () => false,
  isWorkEntryWorkspace: () => false,
  getWorkspaceType: () => null,
}));

jest.mock('../lib/chat-turn-audit', () => {
  const actual = jest.requireActual<typeof ChatTurnAuditModule>(
    '../lib/chat-turn-audit',
  );
  return {
    ...actual,
    getDiagnosticEventMetadata: () => ({}),
  };
});

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: () => '/tmp/steered-notice-worktree',
  resolveWorktreeTargetIds: (projectId: string, worktreeId: string) => ({
    projectId,
    worktreeId,
  }),
  readPersistedWorktreeBranch: async () => null,
  isBranchPromptSent: async () => true,
  markBranchPromptSent: async () => undefined,
  clearBranchPromptSent: async () => undefined,
  doesBranchMatchWorktreeId: async () => ({ matches: false }),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: () => undefined,
  sendToWindowDetailed: () => ({ delivered: true }),
}));

jest.mock('../lib/worktree-summary-scheduler', () => ({
  scheduleSummaryGeneration: () => undefined,
}));

jest.mock('../lib/background-helper-queue', () => {
  const actual = jest.requireActual<typeof BackgroundHelperQueueModule>(
    '../lib/background-helper-queue',
  );
  return {
    ...actual,
    enqueueBackgroundHelperTask: jest.fn(() => Promise.resolve(undefined)),
  };
});

jest.mock('../lib/code-review-scheduler', () => ({
  noteCodeReviewTurnEnd: () => undefined,
  noteCodeReviewTurnStart: () => undefined,
  noteWorktreeActivityForCodeReview: () => undefined,
}));

jest.mock('../lib/turn-diff-capture', () => ({
  captureTurnStart: (...args: unknown[]) => mockCaptureTurnStart(...args),
  captureTurnEndAndDiff: (...args: unknown[]) => mockCaptureTurnEnd(...args),
  // The chat turn's end capture since turn-state phase 40f.
  captureTurnEndAndDiffs: (...args: unknown[]) => mockCaptureTurnEnd(...args),
}));

jest.mock('../lib/code-graph-scheduler', () => ({
  scheduleCodeGraphBuild: () => undefined,
}));

jest.mock('../lib/chat-submitted-message', () => ({
  buildSubmittedMessageText: (options: { text: string }) => options.text,
  prependPendingSystemInstructions: (text: string) => text,
}));

jest.mock('../lib/active-plan-instruction', () => ({
  resolveActivePlanSystemInstruction: async () => null,
  withActivePlanInstruction: (instructions: unknown) => instructions,
}));

jest.mock('../lib/chat-tabs-reader', () => {
  const actual = jest.requireActual<typeof ChatTabsReaderModule>(
    '../lib/chat-tabs-reader',
  );
  return {
    ...actual,
    readPersistedChatDispatchMetadata: async () => ({}),
    readPersistedChatExecutionContext: async () => undefined,
  };
});

jest.mock('../canopy-tools/prompting', () => ({
  buildWorktreeInjectedToolPrompt: () => 'fixture tools',
  buildCoworkInjectedToolPrompt: () => 'fixture cowork tools',
}));

jest.mock('../feature-flags', () => ({
  getFeatureFlagService: () => ({ isEnabled: () => false }),
}));

jest.mock('@canopy/desktop-shared/node/code-graph/service', () => ({
  getCodeGraphWorktreeService: () => ({ hasGraph: () => false }),
}));

jest.mock('../lib/chat-event-description', () => ({
  describeChatEventData: () => 'chat event',
}));

jest.mock('../lib/plan-mode-workspace-scope', () => ({
  buildPlanModeWorkspaceScopePrompt: async () => null,
}));

jest.mock('../lib/plan-explore-registry', () => ({
  getPlanExploreTarget: async () => null,
  getPlanExploreTargetSync: () => null,
}));

jest.mock('../lib/plan-persistence', () => ({
  getTrackedPlan: async () => null,
}));

jest.mock('../lib/plan-file-sync', () => {
  const actual = jest.requireActual<typeof PlanFileSyncModule>(
    '../lib/plan-file-sync',
  );
  return {
    ...actual,
    getPlanFileSyncService: () => ({
      materializePlanFile: async () => null,
      beginTurn: () => ({ end: () => undefined }),
    }),
  };
});

jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: () => ({
    handleChatTerminalEvent: async () => undefined,
    handleNewChatStartedEvent: async () => undefined,
  }),
}));

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: async () => null,
  readWorkspaceConfigDetailed: async () => ({
    config: {},
    authority: 'absent',
    ownerMalformed: false,
  }),
}));

jest.mock('../ipc/standalone-chat', () => ({
  generateChatSummaryForProject: async () => ({ text: '', usage: {} }),
  updateChatMeta: async () => undefined,
}));

jest.mock('../lib/chat-turn-cancel', () => ({
  beginChatTurnPreparation: () => ({
    cancelled: false,
    finish: () => undefined,
  }),
  cancelChatTurn: async () => undefined,
}));

jest.mock('../copilot/connection', () => ({
  assertCopilotModelAvailable: async () => undefined,
}));

jest.mock('../observability', () => ({
  getObservabilityService: () => mockSessionObservability,
}));

jest.mock('../memory/local/policy', () => ({
  resolveLocalMemoryPolicy: async () => ({
    kind: 'none',
    privateMemory: false,
  }),
}));

jest.mock('../memory/local/prepare', () => ({
  prepareLocalMemoryContext: async () => null,
}));

function createLatch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function expectNamed<T>(actual: T, expected: T, label: string): void {
  expect({ label, actual }).toEqual({ label, actual: expected });
}

function observeRevivalDecisions(activeHarness: SteeredNoticeHarness): {
  decisions: Array<{ rootId: string; accepted: boolean }>;
} {
  const decisions: Array<{ rootId: string; accepted: boolean }> = [];
  const originalAccept = activeHarness.queue.acceptTurnRevival.bind(
    activeHarness.queue,
  );
  jest
    .spyOn(activeHarness.queue, 'acceptTurnRevival')
    .mockImplementation((target, rootId) => {
      const acceptance = originalAccept(target, rootId);
      decisions.push({ rootId, accepted: acceptance.accepted });
      return acceptance;
    });
  return { decisions };
}

async function expectNoticeTurnCommitted(
  activeHarness: SteeredNoticeHarness,
  rowId: string,
): Promise<void> {
  const transcript = await activeHarness.readTranscript();
  const blocks = transcript.flatMap((message) => message.blocks);
  expectNamed(
    blocks.some(
      (block) =>
        block.type === 'text' && block.text === `${rowId} assistant output`,
    ),
    true,
    `${rowId}: assistant output must be committed`,
  );
  expectNamed(
    blocks.some(
      (block) =>
        block.type === 'tool_use' && block.toolUseId === `${rowId}-tool`,
    ),
    true,
    `${rowId}: tool_use must be committed`,
  );
  expectNamed(
    blocks.some(
      (block) =>
        block.type === 'tool_result' &&
        block.toolUseId === `${rowId}-tool` &&
        block.output === `result for ${rowId}-tool`,
    ),
    true,
    `${rowId}: tool_result must be committed`,
  );
  const timer = transcript.find((message) => message.id === `${rowId}:timer`);
  expectNamed(
    timer?.blocks.some(
      (block) => block.type === 'turn_timer' && block.completedAt != null,
    ),
    true,
    `${rowId}:timer must be completed`,
  );
}

async function expectTranscriptText(
  activeHarness: SteeredNoticeHarness,
  text: string,
  label: string,
): Promise<void> {
  const transcript = await activeHarness.readTranscript();
  expectNamed(
    transcript
      .flatMap((message) => message.blocks)
      .some((block) => block.type === 'text' && block.text === text),
    true,
    label,
  );
}

async function expectNoticeTerminalReleasedQueue(
  activeHarness: SteeredNoticeHarness,
): Promise<void> {
  await activeHarness.waitForGateRelease();
  expectNamed(
    activeHarness.queue.isTurnActive(activeHarness.target),
    false,
    'the notice terminal must release its host queue gate',
  );
  const runtime = await activeHarness.readRuntime();
  expectNamed(
    runtime?.status === 'streaming',
    false,
    'the notice runtime must be settled',
  );
  expectNamed(
    runtime?.activeTurn,
    undefined,
    'the notice active turn must be settled',
  );
  await activeHarness.waitForQuiescence();
  expectNamed(
    activeHarness.dispatchedIds(),
    ['root-1', 'typed-1'],
    'the queued typed row must dispatch after the notice terminal',
  );
}

describe('steered notice turns through the worktree queue', () => {
  let harness: SteeredNoticeHarness | undefined;

  beforeEach(async () => {
    mockSession.reset();
    mockModelBlockedByPolicy.mockReset().mockResolvedValue(false);
    mockGetOrCreateSession.mockClear();
    mockFetchOrgMemoryAttempt.mockClear();
    mockAckOrgMemoryDelivered.mockClear();
    mockPersistOrgMemoryUsed.mockClear();
    mockCaptureTurnStart.mockClear();
    mockCaptureTurnEnd.mockClear();
    mockRecordDiagnostic.mockClear();
    mockGetQueueService.mockReset();
    worktreeChatTurnTestExports.resetCurrentSessionEventHandlers();
    resetChatStateServiceForTests();
    harness = await createSteeredNoticeHarness(mockSession);
    mockGetQueueService.mockReturnValue(harness.queue);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (harness) await harness.dispose();
    harness = undefined;
    mockGetQueueService.mockReset();
    worktreeChatTurnTestExports.resetCurrentSessionEventHandlers();
    resetChatStateServiceForTests();
  });

  // Passes at HEAD: both ledger-claimed notices commit and drain typed-1.
  it('commits both steered notices and drains the typed row after their autonomous turns', async () => {
    const activeHarness = harness;
    if (!activeHarness) throw new Error('Harness was not initialized');

    await activeHarness.startRootTurn('root-1');
    await activeHarness.fakeSession.emitAssistant('root-1', 'root response');

    // Queue the hidden row before the watcher so both notices wait for the
    // same generated-row pass; visible watcher work is prioritized first.
    await activeHarness.submitNotice('delegation', 'delegation-1');
    await activeHarness.submitNotice('watcher', 'watcher-1');
    const attempts = await activeHarness.steerQueued();

    // The typed row arrives after both notices have been claimed. A visible
    // ordinary row would correctly block the hidden delegation from steering.
    await activeHarness.submitOrdinary('typed-1');

    await activeHarness.fakeSession.emitResult('root-1');
    await activeHarness.runNoticeTurn('watcher-1');
    await activeHarness.runNoticeTurn('delegation-1');
    await activeHarness.waitForGateRelease();

    // a) Attempt identity is distinct from each ledger row/root identity.
    expect(attempts.map((attempt) => attempt.rowId).sort()).toEqual([
      'delegation-1',
      'watcher-1',
    ]);
    expect(
      attempts.every((attempt) => attempt.attemptId !== attempt.rowId),
    ).toBe(true);
    const stateAfterNotices = await activeHarness.service.getState(
      activeHarness.scope,
    );
    const deliveryRows =
      stateAfterNotices.tabsFile.tabs.find((tab) => tab.id === 'chat-1')
        ?.inputDelivery?.rows ?? [];
    const watcherAttempt = attempts.find(
      (attempt) => attempt.rowId === 'watcher-1',
    );
    const delegationAttempt = attempts.find(
      (attempt) => attempt.rowId === 'delegation-1',
    );
    expect(watcherAttempt).toBeDefined();
    expect(delegationAttempt).toBeDefined();
    expect(
      deliveryRows
        .find((candidate) => candidate.id === 'watcher-1')
        ?.attempts.some((attempt) => attempt.id === watcherAttempt?.attemptId),
    ).toBe(true);
    expect(
      deliveryRows
        .find((candidate) => candidate.id === 'watcher-1')
        ?.attempts.every((attempt) => attempt.id !== 'watcher-1'),
    ).toBe(true);
    expect(
      deliveryRows
        .find((candidate) => candidate.id === 'delegation-1')
        ?.attempts.some(
          (attempt) => attempt.id === delegationAttempt?.attemptId,
        ),
    ).toBe(true);
    expect(
      deliveryRows
        .find((candidate) => candidate.id === 'delegation-1')
        ?.attempts.every((attempt) => attempt.id !== 'delegation-1'),
    ).toBe(true);

    const transcript = await activeHarness.readTranscript();
    const transcriptBlocks = transcript.flatMap((message) => message.blocks);

    // b) The watcher autonomous turn commits its assistant text and tool use.
    expect(
      transcriptBlocks.some(
        (block) =>
          block.type === 'text' && block.text === 'watcher-1 assistant output',
      ),
    ).toBe(true);
    expect(
      transcriptBlocks.some(
        (block) =>
          block.type === 'tool_use' && block.toolUseId === 'watcher-1-tool',
      ),
    ).toBe(true);
    expect(
      transcriptBlocks.some(
        (block) =>
          block.type === 'tool_result' &&
          block.toolUseId === 'watcher-1-tool' &&
          block.output === 'result for watcher-1-tool',
      ),
    ).toBe(true);
    const watcherTimer = transcript.find(
      (message) => message.id === 'watcher-1:timer',
    );
    expect(
      watcherTimer?.blocks.some(
        (block) => block.type === 'turn_timer' && block.completedAt != null,
      ),
    ).toBe(true);

    // b) The delegation autonomous turn also commits its assistant text and tool use.
    expect(
      transcriptBlocks.some(
        (block) =>
          block.type === 'text' &&
          block.text === 'delegation-1 assistant output',
      ),
    ).toBe(true);
    expect(
      transcriptBlocks.some(
        (block) =>
          block.type === 'tool_use' && block.toolUseId === 'delegation-1-tool',
      ),
    ).toBe(true);
    expect(
      transcriptBlocks.some(
        (block) =>
          block.type === 'tool_result' &&
          block.toolUseId === 'delegation-1-tool' &&
          block.output === 'result for delegation-1-tool',
      ),
    ).toBe(true);
    const delegationTimer = transcript.find(
      (message) => message.id === 'delegation-1:timer',
    );
    expect(
      delegationTimer?.blocks.some(
        (block) => block.type === 'turn_timer' && block.completedAt != null,
      ),
    ).toBe(true);

    // c) Both provider terminals settled canonical runtime before queued dispatch.
    const settledRuntime = await activeHarness.readRuntime();
    expect(settledRuntime?.status).not.toBe('streaming');
    expect(settledRuntime?.activeTurn).toBeUndefined();

    // d) Result two released the host gate while typed-1 remained queued.
    const releasedState = await activeHarness.queueState();
    expect(releasedState.isTurnActive).toBe(false);
    expect(
      releasedState.snapshots.some(
        (snapshot) =>
          snapshot.chatId === 'chat-1' &&
          snapshot.queue.some(
            (queued) => queued.text === 'Typed prompt typed-1',
          ),
      ),
    ).toBe(true);
    expect(activeHarness.dispatchedIds()).toEqual(['root-1']);

    // e) No new arrival was needed to FIFO-dispatch typed-1.
    await activeHarness.waitForQuiescence();
    expect(activeHarness.dispatchedIds()).toEqual(['root-1', 'typed-1']);
    expect(
      activeHarness.fakeSession.sentMessages.map(
        (message) => message.userMessageId,
      ),
    ).toEqual(['root-1', 'typed-1']);
  });

  describe('pickup after the previous terminal', () => {
    // Fixed: terminal release precedes pickup arbitration, and the acquired
    // notice lease settles before the deferred queue drain.
    it('does not dispatch typed work between the prior terminal and notice output', async () => {
      const activeHarness = harness;
      if (!activeHarness) throw new Error('Harness was not initialized');
      const revival = observeRevivalDecisions(activeHarness);
      const confirmations: Array<{ rootId: string; confirmed: boolean }> = [];
      const originalConfirm = activeHarness.queue.confirmTurnRevival.bind(
        activeHarness.queue,
      );

      await activeHarness.startRootTurn('root-1');
      await activeHarness.fakeSession.emitAssistant('root-1', 'root response');
      await activeHarness.submitNotice('watcher', 'watcher-1');
      await activeHarness.steerQueued(['watcher-1']);
      await activeHarness.submitOrdinary('typed-1');

      await activeHarness.fakeSession.emitResult('root-1');
      const ingestResults: Array<{ outcome: string; pickup?: string }> = [];
      const originalIngest =
        activeHarness.service.ingestProviderEventWithResult.bind(
          activeHarness.service,
        );
      jest
        .spyOn(activeHarness.service, 'ingestProviderEventWithResult')
        .mockImplementation(async (input) => {
          const result = await originalIngest(input);
          if (
            typeof input.data === 'object' &&
            input.data !== null &&
            'type' in input.data &&
            input.data.type === 'canopy_input_delivery'
          ) {
            ingestResults.push(result);
          }
          return result;
        });
      jest
        .spyOn(activeHarness.queue, 'confirmTurnRevival')
        .mockImplementation((target, lease) => {
          const confirmed = originalConfirm(target, lease);
          confirmations.push({ rootId: lease.rootId, confirmed });
          return confirmed;
        });
      await activeHarness.pickup('watcher-1');
      await activeHarness.waitForQuiescence();
      expect(confirmations).toContainEqual({
        rootId: 'watcher-1',
        confirmed: true,
      });
      const dispatchedBetweenTerminals = activeHarness.dispatchedIds();
      const gateAfterNoticePickup = activeHarness.queue.isTurnActive(
        activeHarness.target,
      );
      const latestOwnedGate = [...activeHarness.queueRuntimeWrites]
        .reverse()
        .find((write) => write.turnActive);
      await activeHarness.emitNoticeOutput('watcher-1');
      expectNamed(
        ingestResults.find((result) => result.pickup !== undefined),
        { outcome: 'applied', pickup: 'accepted' },
        'canonical ingestion must accept the watcher pickup after root-1 terminal',
      );

      expectNamed(
        revival.decisions.some(
          (decision) =>
            decision.rootId === 'watcher-1' && decision.accepted === true,
        ),
        true,
        `the prior terminal release must let watcher-1 revive; decisions: ${JSON.stringify(revival.decisions)}; canonical results: ${JSON.stringify(ingestResults)}`,
      );
      expectNamed(
        latestOwnedGate?.activeTurnUserMessageId,
        'watcher-1',
        `the prior queue drain must not release watcher-1's gate; router decisions: ${JSON.stringify(revival.decisions)}`,
      );
      expectNamed(
        gateAfterNoticePickup,
        true,
        'the provider gate must stay active until watcher-1 result',
      );
      expectNamed(
        dispatchedBetweenTerminals,
        ['root-1'],
        `the prior terminal's scheduled drain must preserve watcher-1's gate; router decisions: ${JSON.stringify(revival.decisions)}`,
      );
      await activeHarness.waitForGateRelease();
      await expectNoticeTurnCommitted(activeHarness, 'watcher-1');
      await expectTranscriptText(
        activeHarness,
        'root response',
        'previous root-1 assistant output must remain committed',
      );
      await expectNoticeTerminalReleasedQueue(activeHarness);
    });
  });

  describe('canonical pickup rejection after router arbitration', () => {
    // Fixed: when router arbitration accepts a root but canonical evidence
    // rejects its pickup, the lease is rolled back and typed work can proceed.
    it('does not strand the gate when an accepted pickup has an unknown attempt id', async () => {
      const activeHarness = harness;
      if (!activeHarness) throw new Error('Harness was not initialized');
      const revival = observeRevivalDecisions(activeHarness);

      await activeHarness.startRootTurn('root-1');
      await activeHarness.submitNotice('watcher', 'watcher-1');
      await activeHarness.steerQueued(['watcher-1']);
      await activeHarness.fakeSession.emitResult('root-1');
      await activeHarness.waitForGateRelease();
      await activeHarness.waitForQuiescence();

      const ingestResults: Array<{ outcome: string; pickup?: string }> = [];
      const rollbackResults: Array<{
        rootId: string;
        rolledBack: boolean;
      }> = [];
      const originalRollback = activeHarness.queue.rollbackTurnRevival.bind(
        activeHarness.queue,
      );
      jest
        .spyOn(activeHarness.queue, 'rollbackTurnRevival')
        .mockImplementation((target, lease) => {
          const rolledBack = originalRollback(target, lease);
          rollbackResults.push({ rootId: lease.rootId, rolledBack });
          return rolledBack;
        });
      const originalIngest =
        activeHarness.service.ingestProviderEventWithResult.bind(
          activeHarness.service,
        );
      jest
        .spyOn(activeHarness.service, 'ingestProviderEventWithResult')
        .mockImplementation(async (input) => {
          const result = await originalIngest(input);
          if (
            typeof input.data === 'object' &&
            input.data !== null &&
            'type' in input.data &&
            input.data.type === 'canopy_input_delivery'
          ) {
            ingestResults.push(result);
          }
          return result;
        });

      await activeHarness.fakeSession.emitPickup(
        {
          attemptId: 'unknown-attempt',
          rowId: 'watcher-1',
          text: 'fabricated pickup evidence',
        },
        { startsTurn: true },
      );
      // This event is fabricated evidence for an unknown attempt; the fake
      // provider did not actually start foreground work for that row.
      activeHarness.fakeSession.isForeground = false;
      activeHarness.fakeSession.activeRoot = undefined;
      await activeHarness.waitForQuiescence();
      await activeHarness.submitOrdinary('typed-1');
      await activeHarness.waitForQuiescence();

      expect(revival.decisions).toContainEqual({
        rootId: 'watcher-1',
        accepted: true,
      });
      expect(ingestResults.slice(-1)).toEqual([
        { outcome: 'not-applied', pickup: 'rejected' },
      ]);
      expect(rollbackResults).toContainEqual({
        rootId: 'watcher-1',
        rolledBack: true,
      });
      const runtime = await activeHarness.readRuntime();
      expectNamed(
        !activeHarness.queue.isTurnActive(activeHarness.target) ||
          runtime?.activeTurn?.userMessageId === 'typed-1',
        true,
        `a rejected pickup must not strand its root gate ahead of typed-1; dispatched: ${JSON.stringify(activeHarness.dispatchedIds())}`,
      );
      expect(activeHarness.dispatchedIds()).toContain('typed-1');
    });
  });

  describe('Stop and newer-owner pickup races', () => {
    // Fixed: Stop supersedes canonical pickup acceptance, so the route keeps
    // durable pickup evidence but does not confirm its queue lease.
    it('does not confirm a pickup whose canonical observation overlaps Stop', async () => {
      const activeHarness = harness;
      if (!activeHarness) throw new Error('Harness was not initialized');
      const revival = observeRevivalDecisions(activeHarness);
      const confirmedRoots: string[] = [];
      const ingestResults: Array<{ outcome: string; pickup?: string }> = [];
      const observations: Array<{ observed: boolean; pickup?: string }> = [];
      const originalConfirm = activeHarness.queue.confirmTurnRevival.bind(
        activeHarness.queue,
      );
      const observationEntered = createLatch();
      const continueObservation = createLatch();
      const stopCleanupEntered = createLatch();
      const continueStopCleanup = createLatch();

      await activeHarness.startRootTurn('root-1');
      await activeHarness.submitNotice('watcher', 'watcher-1');
      const attempts = await activeHarness.steerQueued(['watcher-1']);
      const capturedAttempt = attempts.find(
        (candidate) => candidate.rowId === 'watcher-1',
      );
      if (!capturedAttempt)
        throw new Error('watcher-1 attempt was not captured');
      const attempt = capturedAttempt;
      await activeHarness.fakeSession.emitResult('root-1');
      await activeHarness.waitForGateRelease();
      await activeHarness.waitForQuiescence();

      const originalObserve =
        activeHarness.service.inputDelivery.observeWithResult.bind(
          activeHarness.service.inputDelivery,
        );
      const originalIngest =
        activeHarness.service.ingestProviderEventWithResult.bind(
          activeHarness.service,
        );
      jest
        .spyOn(activeHarness.service, 'ingestProviderEventWithResult')
        .mockImplementation(async (input) => {
          const result = await originalIngest(input);
          if (
            typeof input.data === 'object' &&
            input.data !== null &&
            'attemptId' in input.data &&
            input.data.attemptId === attempt.attemptId
          ) {
            ingestResults.push(result);
          }
          return result;
        });
      jest
        .spyOn(activeHarness.service.inputDelivery, 'observeWithResult')
        .mockImplementation(async (target, event) => {
          if (event.attemptId === attempt.attemptId) {
            observationEntered.release();
            await continueObservation.promise;
          }
          const result = await originalObserve(target, event);
          if (event.attemptId === attempt.attemptId) {
            observations.push(result);
          }
          return result;
        });
      jest
        .spyOn(activeHarness.queue, 'confirmTurnRevival')
        .mockImplementation((target, lease) => {
          confirmedRoots.push(lease.rootId);
          return originalConfirm(target, lease);
        });

      const pickup = activeHarness.fakeSession.emitPickup(attempt, {
        startsTurn: true,
      });
      await observationEntered.promise;
      const stop = activeHarness.stopTurn(async () => {
        // stopTurn has invalidated queue work and inputDelivery.stop has
        // advanced/suspended the canonical ledger before this hook runs.
        stopCleanupEntered.release();
        await continueStopCleanup.promise;
      });
      await stopCleanupEntered.promise;
      continueObservation.release();
      await pickup;
      await activeHarness.waitForQuiescence();
      continueStopCleanup.release();
      await stop;

      await activeHarness.submitOrdinary('typed-1');
      await activeHarness.waitForQuiescence();
      await activeHarness.emitNoticeOutput('watcher-1');
      await activeHarness.waitForQuiescence();
      expectNamed(
        activeHarness.queue.isTurnActive(activeHarness.target),
        true,
        'late watcher-1 events must not release the post-Stop typed-1 gate',
      );
      expectNamed(
        revival.decisions.some(
          (decision) =>
            decision.rootId === 'watcher-1' && decision.accepted === true,
        ),
        true,
        'the pickup reaches router arbitration before Stop supersedes observation',
      );
      expect(ingestResults).toEqual([
        { outcome: 'applied', pickup: 'rejected' },
      ]);
      expect(observations).toEqual([{ observed: true, pickup: 'rejected' }]);
      expectNamed(
        confirmedRoots.includes('watcher-1'),
        false,
        `Stop-superseded canonical pickup must not confirm watcher-1 as the new root; ingestion results: ${JSON.stringify(ingestResults)}`,
      );

      await activeHarness.fakeSession.emitAssistant(
        'typed-1',
        'typed response',
      );
      await activeHarness.fakeSession.emitToolUse('typed-1', 'typed-1-tool');
      await activeHarness.fakeSession.emitToolResult('typed-1', 'typed-1-tool');
      await activeHarness.fakeSession.emitResult('typed-1');
      await activeHarness.waitForGateRelease();
      const transcript = await activeHarness.readTranscript();
      expectNamed(
        transcript
          .flatMap((message) => message.blocks)
          .some(
            (block) => block.type === 'text' && block.text === 'typed response',
          ),
        true,
        'the post-Stop typed owner must still commit its output',
      );
      expectNamed(
        activeHarness.queue.isTurnActive(activeHarness.target),
        false,
        'typed-1 terminal must release its own gate',
      );
    });

    // Passes at HEAD: a different newer root refuses the pickup, while a
    // same-id unknown pickup is not allowed to terminal-release typed-1.
    it('preserves a newer typed owner for different-root and same-id unknown pickups', async () => {
      const activeHarness = harness;
      if (!activeHarness) throw new Error('Harness was not initialized');
      const revival = observeRevivalDecisions(activeHarness);

      await activeHarness.startRootTurn('root-1');
      await activeHarness.fakeSession.emitResult('root-1');
      await activeHarness.waitForGateRelease();
      await activeHarness.waitForQuiescence();
      await activeHarness.submitOrdinary('typed-1');
      await activeHarness.waitForQuiescence();

      const ingestResults: Array<{ outcome: string; pickup?: string }> = [];
      const originalIngest =
        activeHarness.service.ingestProviderEventWithResult.bind(
          activeHarness.service,
        );
      jest
        .spyOn(activeHarness.service, 'ingestProviderEventWithResult')
        .mockImplementation(async (input) => {
          const result = await originalIngest(input);
          if (
            typeof input.data === 'object' &&
            input.data !== null &&
            'type' in input.data &&
            input.data.type === 'canopy_input_delivery'
          ) {
            ingestResults.push(result);
          }
          return result;
        });

      await activeHarness.fakeSession.emitPickup(
        {
          attemptId: 'unknown-different-root-attempt',
          rowId: 'unknown-root',
          text: 'unknown different-root pickup',
        },
        { startsTurn: true },
      );
      await activeHarness.waitForQuiescence();
      expectNamed(
        activeHarness.queue.isTurnActive(activeHarness.target),
        true,
        'different-root pickup must leave typed-1 active',
      );
      expect(activeHarness.dispatchedIds()).toContain('typed-1');

      await activeHarness.fakeSession.emitPickup(
        {
          attemptId: 'unknown-same-root-attempt',
          rowId: 'typed-1',
          text: 'unknown same-id pickup',
        },
        { startsTurn: true },
      );
      await activeHarness.waitForQuiescence();
      expect(revival.decisions).toContainEqual({
        rootId: 'unknown-root',
        accepted: false,
      });
      expect(revival.decisions).toContainEqual({
        rootId: 'typed-1',
        accepted: true,
      });
      expect(ingestResults.slice(-1)).toEqual([
        { outcome: 'not-applied', pickup: 'rejected' },
      ]);
      expectNamed(
        activeHarness.queue.isTurnActive(activeHarness.target),
        true,
        'same-id rejected pickup must not release typed-1 through rollback',
      );

      await activeHarness.fakeSession.emitAssistant(
        'typed-1',
        'typed response',
      );
      await activeHarness.fakeSession.emitToolUse('typed-1', 'typed-1-tool');
      await activeHarness.fakeSession.emitToolResult('typed-1', 'typed-1-tool');
      await activeHarness.fakeSession.emitResult('typed-1');
      await activeHarness.waitForGateRelease();
      expectNamed(
        (await activeHarness.readTranscript())
          .flatMap((message) => message.blocks)
          .some(
            (block) => block.type === 'text' && block.text === 'typed response',
          ),
        true,
        'typed-1 output must be committed',
      );
      expectNamed(
        activeHarness.queue.isTurnActive(activeHarness.target),
        false,
        'typed-1 terminal must release its own gate',
      );
    });
  });
});
