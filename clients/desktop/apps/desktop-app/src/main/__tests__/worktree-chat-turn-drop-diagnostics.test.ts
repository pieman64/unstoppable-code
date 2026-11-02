import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { dispatchWorktreeChatTurn } from '../lib/worktree-chat-turn';
import {
  getChatDispatchAuthorization,
  type AuthorizedChatDispatch,
} from '../services/chat-dispatch-authorization';
import { recordChatEventDropped } from '../lib/chat-event-drop-diagnostics';
import { scheduleSummaryGeneration } from '../lib/worktree-summary-scheduler';
import {
  attachProviderRunEvent,
  createProviderRunGeneration,
  observeProviderRunItem,
  registerProviderRun,
  settleProviderRun,
} from '../lib/provider-run-reconciliation';

type ProviderCallback = (
  data: unknown,
  markPersistenceSettled?: () => void,
) => void | Promise<void>;

const mockSession = {
  sendMessage: jest.fn(),
  cancel: jest.fn(() => Promise.resolve()),
  destroy: jest.fn(() => Promise.resolve()),
  setPlanMode: jest.fn(() => Promise.resolve()),
  setApprovalMode: jest.fn(() => Promise.resolve()),
  setThinkingLevel: jest.fn(() => Promise.resolve()),
  setModel: jest.fn(() => Promise.resolve()),
};
let mockProviderCallback: ProviderCallback | undefined;
const mockGetOrCreateSession = jest.fn<
  Promise<typeof mockSession>,
  [unknown, ProviderCallback, (() => unknown)?, unknown?]
>();
const mockQueue = {
  onTurnRevived: jest.fn(() => false),
  onTurnTerminal: jest.fn(),
  acceptTurnRevival: jest.fn(),
  confirmTurnRevival: jest.fn(),
  rollbackTurnRevival: jest.fn(),
};
jest.mock('../lib/chat-event-drop-diagnostics', () => ({
  recordChatEventDropped: jest.fn(),
}));

jest.mock('../agents/session-manager', () => ({
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => `${projectId}/${worktreeId}/${chatId}`,
  getOrCreateSession: (
    options: unknown,
    callback: ProviderCallback,
    getWindow?: () => unknown,
    lifecycle?: unknown,
  ): Promise<typeof mockSession> =>
    mockGetOrCreateSession(options, callback, getWindow, lifecycle),
  beginSessionTurnPreparation: (): (() => void) => jest.fn(),
  releaseSessionTurnPreparationOnActivation: (): void => undefined,
  getSessionCodeGraphToolsAdvertised: (): undefined => undefined,
  getSessionGlobalInstructionsSnapshot: (): undefined => undefined,
  setSessionTurnSettings: jest.fn(),
  canReuseSession: (): Promise<boolean> => Promise.resolve(true),
  canPreserveSessionCapabilitySnapshot: (): Promise<boolean> =>
    Promise.resolve(true),
  shouldRecreateSessionOnNextTurn: (): boolean => false,
  destroySession: (): Promise<void> => Promise.resolve(),
  getActiveSessionInfos: (): unknown[] => [],
  isSessionAiCreditsRouted: (): boolean => false,
  isSessionAccountProxyRouted: (): boolean => false,
  getSessionProviderType: (): undefined => undefined,
  restrictSessionApprovalRules: (): void => undefined,
}));

jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: (): typeof mockQueue => mockQueue,
}));

jest.mock('../deferred-tools/reload-coordinator', () => ({
  deferredToolsReloadCoordinator: {
    hasActiveReload: jest.fn((): boolean => false),
    shouldSuppressProviderTerminal: jest.fn((): boolean => false),
    registerResumeHandler: jest.fn((): void => undefined),
    whenActiveReloadSettles: jest.fn((): void => undefined),
  },
}));

jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: (): {
    reserveChatTurnStart: () => Promise<{ release: () => void }>;
  } => ({
    reserveChatTurnStart: (): Promise<{ release: () => void }> =>
      Promise.resolve({ release: jest.fn() }),
  }),
}));

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    runWithScopeActivity: <T>(
      scope: unknown,
      operation: () => Promise<T>,
    ) => Promise<T>;
    updateChatDescription: () => Promise<void>;
    inputDelivery: { stop: () => Promise<void> };
    holdRuntimeHost: () => () => void;
  } => ({
    runWithScopeActivity: async <T>(
      _scope: unknown,
      operation: () => Promise<T>,
    ): Promise<T> => operation(),
    updateChatDescription: (): Promise<void> => Promise.resolve(),
    inputDelivery: { stop: (): Promise<void> => Promise.resolve() },
    // A direct dispatch holds the runtime host for the turn.
    holdRuntimeHost: (): (() => void) => (): void => undefined,
  }),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<Record<string, unknown>> =>
    Promise.resolve({}),
}));

jest.mock('../agents/agent-model-runtime', () => ({
  resolveAgentModelRuntime: (): Promise<{
    providerType: 'claude';
    runtimeModel: string;
    systemPromptAppend: string;
  }> =>
    Promise.resolve({
      providerType: 'claude',
      runtimeModel: 'claude-sonnet-4-6',
      systemPromptAppend: '',
    }),
}));

jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: (): boolean => false,
  isWorkEntryWorkspace: (): boolean => false,
}));

jest.mock('../agents/work-owner', () => ({
  captureSessionWorkOwner: jest.fn(),
  resolveSessionWorkOwner: (): Record<string, never> => ({}),
}));

jest.mock('../lib/chat-turn-cancel', () => ({
  beginChatTurnPreparation: (): {
    cancelled: boolean;
    finish: () => void;
  } => ({ cancelled: false, finish: jest.fn() }),
}));

jest.mock('../services/stopped-turn-resume-service', () => ({
  getStoppedTurnResumeService: (): {
    invalidateForNewTurn: () => void;
    recordTurnContext: () => void;
    ownsTerminalSettlement: () => boolean;
    settleTerminalOwnership: () => void;
  } => ({
    invalidateForNewTurn: jest.fn(),
    recordTurnContext: jest.fn(),
    ownsTerminalSettlement: (): boolean => false,
    settleTerminalOwnership: jest.fn(),
  }),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (): string => '/tmp/worktree',
  resolveWorktreeTargetIds: (
    projectId: string,
    worktreeId: string,
  ): { projectId: string; worktreeId: string } => ({ projectId, worktreeId }),
  readPersistedWorktreeBranch: (): Promise<null> => Promise.resolve(null),
  isBranchPromptSent: (): Promise<boolean> => Promise.resolve(true),
  markBranchPromptSent: (): Promise<void> => Promise.resolve(),
  clearBranchPromptSent: (): Promise<void> => Promise.resolve(),
  doesBranchMatchWorktreeId: (): Promise<{ matches: boolean }> =>
    Promise.resolve({ matches: false }),
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  readPersistedChatDispatchMetadata: (): Promise<Record<string, never>> =>
    Promise.resolve({}),
  readPersistedChatExecutionContext: (): Promise<undefined> =>
    Promise.resolve(undefined),
}));

jest.mock('../lib/plan-file-sync', () => ({
  resolvePlanTurnScope: (): null => null,
  getPlanFileSyncService: (): { beginTurn: () => { end: () => void } } => ({
    beginTurn: (): { end: () => void } => ({ end: jest.fn() }),
  }),
  planChatTurnKey: (): string => 'plan-turn',
}));

jest.mock('../lib/active-plan-instruction', () => ({
  resolveActivePlanSystemInstruction: (): Promise<null> =>
    Promise.resolve(null),
  withActivePlanInstruction: (text: string): string => text,
}));

jest.mock('../memory/local/policy', () => ({
  resolveLocalMemoryPolicy: (): Promise<{ kind: 'disabled' }> =>
    Promise.resolve({ kind: 'disabled' }),
}));

jest.mock('../lib/worktree-summary-scheduler', () => ({
  scheduleSummaryGeneration: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToWindowDetailed: (): { delivered: true } => ({ delivered: true }),
}));

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: (): Promise<null> => Promise.resolve(null),
}));

jest.mock('../canopy-tools/prompting', () => ({
  buildWorktreeInjectedToolPrompt: (): string => '',
}));

jest.mock('../lib/code-graph-availability', () => ({
  isCodeGraphAvailableForWorkspace: (): boolean => false,
}));

jest.mock('../lib/cowork-chat-system-prompt', () => ({
  buildCoworkDispatchSystemPromptAppend: (): string => '',
  buildLocalMemoryPromptNudge: (): string => '',
}));

jest.mock('../observability', () => ({
  getObservabilityService: (): {
    observeChatEvent: () => void;
    recordSessionDiagnostic: () => void;
    completeChatTurn: () => void;
    recordInjectedPromptForOpenChatTurn: () => void;
    startChatTurn: () => void;
  } => ({
    observeChatEvent: jest.fn(),
    recordSessionDiagnostic: jest.fn(),
    completeChatTurn: jest.fn(),
    recordInjectedPromptForOpenChatTurn: jest.fn(),
    startChatTurn: jest.fn(),
  }),
}));

jest.mock('../lib/turn-diff-capture', () => ({
  captureTurnStart: (): Promise<void> => Promise.resolve(),
  captureTurnEndAndDiff: (): Promise<null> => Promise.resolve(null),
}));

const recordDrop = jest.mocked(recordChatEventDropped);
const target = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};
/** Stands in for a queue-issued capability; every dispatch carries one. */
const TEST_DISPATCH_AUTHORIZATION: AuthorizedChatDispatch = {
  authorizationToken: Symbol('test dispatch'),
  scope: target,
  dispatchOwner: Symbol('test dispatch owner'),
  userMessageId: 'test-message',
  operationEpoch: 1,
  kind: 'ordinary',
};

async function flushSessionEventCommits(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .spyOn(getChatDispatchAuthorization(), 'consume')
    .mockImplementation((authorization, dispatchTarget) => ({
      kind: 'authorized',
      ownership: {
        kind: 'dispatch',
        token: authorization.dispatchOwner,
        userMessageId: dispatchTarget.userMessageId,
        operationEpoch: authorization.operationEpoch,
        reason: 'awaiting-start',
      },
    }));
  mockProviderCallback = undefined;
  mockGetOrCreateSession.mockImplementation(
    (_options, callback): Promise<typeof mockSession> => {
      mockProviderCallback = callback;
      return Promise.resolve(mockSession);
    },
  );
});

it('records a provider terminal rejected by the worktree turn eligibility gate', async () => {
  jest
    .mocked(deferredToolsReloadCoordinator)
    .hasActiveReload.mockReturnValue(true);
  const beforeChatEvent = jest.fn(() => Promise.resolve());
  await dispatchWorktreeChatTurn({
    ...target,
    authorization: TEST_DISPATCH_AUTHORIZATION,
    userMessageId: 'active-turn',
    text: 'Continue',
    planMode: false,
    providerType: 'claude',
    model: 'claude-sonnet-4-6',
    hiddenDeferredContinuation: true,
    getWindow: () => null,
    onBeforeChatEvent: beforeChatEvent,
  });
  const dropped = {
    type: 'result',
    result: 'Session ended',
  };
  await mockProviderCallback?.(dropped);
  await flushSessionEventCommits();

  expect(beforeChatEvent).not.toHaveBeenCalled();
  expect(recordDrop).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      providerType: 'claude',
      gate: 'worktree_turn_ineligible',
      reason: 'internal_reload_terminal',
      data: dropped,
      turnUserMessageId: 'active-turn',
    }),
  );
});

it('records a stopped-turn provider output refused by queue revival arbitration', async () => {
  await dispatchWorktreeChatTurn({
    ...target,
    authorization: TEST_DISPATCH_AUTHORIZATION,
    userMessageId: 'stopped-turn',
    text: 'Continue',
    planMode: false,
    providerType: 'claude',
    model: 'claude-sonnet-4-6',
    hiddenDeferredContinuation: true,
    hiddenContinuationKind: 'stopped_turn_resume',
    getWindow: () => null,
    onBeforeChatEvent: jest.fn(() => Promise.resolve()),
  });
  const providerEvent = {
    type: 'assistant',
    canopy_turn_user_message_id: 'stopped-turn',
    message: 'late resumed output',
  };
  await mockProviderCallback?.(providerEvent);
  await flushSessionEventCommits();

  expect(mockQueue.onTurnRevived).toHaveBeenCalledWith(target, 'stopped-turn');
  expect(recordDrop).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      providerType: 'claude',
      gate: 'turn_revival_refused',
      reason: 'queue_turn_revival_not_accepted',
      data: {
        ...providerEvent,
        canopy_turn_revival: true,
      },
      turnUserMessageId: 'stopped-turn',
    }),
  );
});

it('admits a settled old-root command result after a newer prompt without host lifecycle effects', async () => {
  const oldBeforeChatEvent = jest.fn(() =>
    Promise.resolve({ outcome: 'applied' as const }),
  );
  const onChatEvent = jest.fn();
  await dispatchWorktreeChatTurn({
    ...target,
    authorization: TEST_DISPATCH_AUTHORIZATION,
    userMessageId: 'older-root',
    text: 'Run a command',
    planMode: false,
    providerType: 'codex',
    model: 'gpt-5-codex',
    sdkSessionId: 'thread-1',
    getWindow: () => null,
    onBeforeChatEvent: oldBeforeChatEvent,
    onChatEvent,
  });
  const oldProviderCallback = mockProviderCallback;
  if (!oldProviderCallback) throw new Error('Missing provider callback');

  await oldProviderCallback({
    type: 'codex',
    canopy_turn_user_message_id: 'older-root',
    event: {
      type: 'turn.completed',
      thread_id: 'thread-1',
      turn_id: 'older-turn',
    },
  });
  await flushSessionEventCommits();

  const newerBeforeChatEvent = jest.fn<
    Promise<{ outcome: 'applied' }>,
    [unknown]
  >(() => Promise.resolve({ outcome: 'applied' }));
  await dispatchWorktreeChatTurn({
    ...target,
    authorization: TEST_DISPATCH_AUTHORIZATION,
    userMessageId: 'newer-root',
    text: 'Start another turn',
    planMode: false,
    providerType: 'codex',
    model: 'gpt-5-codex',
    sdkSessionId: 'thread-1',
    getWindow: () => null,
    onBeforeChatEvent: newerBeforeChatEvent,
    onChatEvent,
  });
  await oldProviderCallback({
    type: 'codex',
    canopy_turn_user_message_id: 'newer-root',
    event: {
      type: 'turn.started',
      thread_id: 'thread-1',
      turn_id: 'newer-turn',
    },
  });
  await flushSessionEventCommits();

  const lateGeneration = createProviderRunGeneration(target);
  const lateRun = registerProviderRun(lateGeneration, {
    threadId: 'thread-1',
    turnId: 'older-turn',
    executionUserMessageId: 'older-root',
    origin: 'dispatched',
  });
  observeProviderRunItem(lateRun, 'codex-item-older', 'command_execution');
  settleProviderRun(lateRun);
  const lateEvent = {
    type: 'codex',
    canopy_turn_user_message_id: 'older-root',
    event: {
      type: 'item.completed',
      thread_id: 'thread-1',
      turn_id: 'older-turn',
      item: {
        id: 'codex-item-older',
        type: 'command_execution',
        aggregated_output: 'completed output',
      },
    },
  };
  attachProviderRunEvent(lateEvent, lateRun, 'late');

  const terminalCallCount = mockQueue.onTurnTerminal.mock.calls.length;
  const revivalCallCount = mockQueue.onTurnRevived.mock.calls.length;
  const chatEventCount = onChatEvent.mock.calls.length;
  const summaryCallCount = jest.mocked(scheduleSummaryGeneration).mock.calls
    .length;
  const currentBeforeCount = newerBeforeChatEvent.mock.calls.length;
  recordDrop.mockClear();

  await oldProviderCallback(lateEvent);
  await flushSessionEventCommits();

  expect(newerBeforeChatEvent).toHaveBeenCalledTimes(currentBeforeCount + 1);
  expect(newerBeforeChatEvent).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: lateEvent,
      turnUserMessageId: 'older-root',
    }),
  );
  expect(newerBeforeChatEvent.mock.calls.at(-1)?.[0]).not.toHaveProperty(
    'data.canopy_turn_revival',
  );
  expect(mockQueue.onTurnTerminal).toHaveBeenCalledTimes(terminalCallCount);
  expect(mockQueue.onTurnRevived).toHaveBeenCalledTimes(revivalCallCount);
  expect(onChatEvent).toHaveBeenCalledTimes(chatEventCount);
  expect(jest.mocked(scheduleSummaryGeneration)).toHaveBeenCalledTimes(
    summaryCallCount,
  );
  expect(recordDrop).not.toHaveBeenCalled();
});
