/* eslint-disable @typescript-eslint/explicit-function-return-type */

const mockGetSession = jest.fn<unknown, [string, string, string]>();
const mockGetSessionProviderType = jest.fn<string, [string, string, string]>(
  () => 'claude',
);
const mockMarkSessionForNextTurnRecreation = jest.fn<
  void,
  [string, string, string, string?]
>();
const mockMarkSessionTeardownCause = jest.fn<void, [string, string]>();
const mockDrainChatSessionEvents = jest.fn<
  Promise<void>,
  [string, string, string]
>(() => Promise.resolve());
const mockInvalidatePendingInputOperations = jest.fn<void, [unknown]>();
const mockOnTurnTerminal = jest.fn<void, [unknown, string, string?]>();
const mockInputDeliveryStop = jest.fn<
  Promise<void>,
  [unknown, () => Promise<void>]
>(async (_req, operation) => operation());
const nativeStopFence = {
  processOwner: Symbol('native-session-owner'),
  turnId: 'native-turn-1',
  userMessageId: 'native-user-1',
  turnEpoch: 1,
} as const;
const mockCaptureClaudeStopFence = jest.fn<unknown, [unknown]>(
  () => nativeStopFence,
);
const mockIsClaudeStopFenceCurrent = jest.fn<boolean, [unknown, unknown]>(
  () => true,
);
const mockInterruptClaudeSessionForStop = jest.fn<
  Promise<unknown>,
  [unknown, unknown?]
>(() => Promise.resolve({ outcome: 'interrupted', fence: nativeStopFence }));

const mockGetAllActiveSessionInfos = jest.fn<
  Array<{ projectId: string; worktreeId: string; chatId: string }>,
  []
>(() => []);

jest.mock('../agents/session-manager', () => ({
  suppressCodexAuthenticationRecovery: jest.fn(),
  getAllActiveSessionInfos: (): Array<{
    projectId: string;
    worktreeId: string;
    chatId: string;
  }> => mockGetAllActiveSessionInfos(),
  getSession: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): unknown => mockGetSession(projectId, worktreeId, chatId),
  getSessionProviderType: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => mockGetSessionProviderType(projectId, worktreeId, chatId),
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => [projectId, worktreeId, chatId].join('/'),
  markSessionForNextTurnRecreation: (
    projectId: string,
    worktreeId: string,
    chatId: string,
    reason?: string,
  ): void =>
    mockMarkSessionForNextTurnRecreation(projectId, worktreeId, chatId, reason),
  markSessionTeardownCause: (key: string, cause: string): void =>
    mockMarkSessionTeardownCause(key, cause),
  drainChatSessionEvents: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): Promise<void> => mockDrainChatSessionEvents(projectId, worktreeId, chatId),
}));

jest.mock('../agents/claude-session', () => ({
  captureClaudeStopFence: (session: unknown): unknown =>
    mockCaptureClaudeStopFence(session),
  isClaudeStopFenceCurrent: (session: unknown, fence: unknown): boolean =>
    mockIsClaudeStopFenceCurrent(session, fence),
  interruptClaudeSessionForStop: (
    session: unknown,
    fence?: unknown,
  ): Promise<unknown> => mockInterruptClaudeSessionForStop(session, fence),
}));

jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: () => ({
    invalidatePendingInputOperations: (request: unknown): void =>
      mockInvalidatePendingInputOperations(request),
    onTurnTerminal: (...args: [unknown, string, string?]): void =>
      mockOnTurnTerminal(...args),
  }),
}));

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    inputDelivery: {
      stop: (request: unknown, operation: () => Promise<void>): Promise<void> =>
        mockInputDeliveryStop(request, operation),
    },
  }),
}));

import {
  adoptPreparingSendSession,
  beginChatTurnPreparation,
  cancelChatTurn,
  captureChatTurnStop,
  captureChatTurnStopsForChat,
  interruptChatTurnForQueuedMessage,
} from '../lib/chat-turn-cancel';

function hasIntentAwareCancel(
  candidate: unknown,
): candidate is (
  request: typeof target,
  intent: 'stop' | 'teardown',
) => Promise<unknown> {
  return typeof candidate === 'function';
}

async function cancelWithIntent(intent: 'stop' | 'teardown'): Promise<unknown> {
  const cancellation: unknown = cancelChatTurn;
  if (!hasIntentAwareCancel(cancellation)) {
    throw new Error('Expected intent-aware chat turn cancellation');
  }
  return cancellation(target, intent);
}

function hasStopContextCapture(
  candidate: unknown,
): candidate is (request: typeof target) => unknown {
  return typeof candidate === 'function';
}

function hasStopContextCurrentCheck(
  candidate: unknown,
): candidate is (context: unknown) => boolean {
  return typeof candidate === 'function';
}

const target = {
  projectId: 'proj',
  worktreeId: 'worktree',
  chatId: 'chat',
};

describe('chat turn cancellation recreation markers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSessionProviderType.mockReturnValue('claude');
    mockCaptureClaudeStopFence.mockReturnValue(nativeStopFence);
    mockIsClaudeStopFenceCurrent.mockReturnValue(true);
    mockInterruptClaudeSessionForStop.mockResolvedValue({
      outcome: 'interrupted',
      fence: nativeStopFence,
    });
    mockInputDeliveryStop.mockImplementation(async (_req, operation) =>
      operation(),
    );
  });

  it('marks Stop recreation with the stop reason when native interruption falls back', async () => {
    const session = { cancel: jest.fn().mockResolvedValue(undefined) };
    mockGetSession.mockReturnValue(session);
    mockInterruptClaudeSessionForStop.mockResolvedValue({
      outcome: 'fallback-aborted',
      fence: nativeStopFence,
    });

    await cancelWithIntent('stop');

    expect(mockInterruptClaudeSessionForStop).toHaveBeenCalledWith(
      session,
      nativeStopFence,
    );
    expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
      'stop',
    );
  });

  it('uses the native Claude interrupt for Stop and preserves its captured fence', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const session = { cancel };
    mockGetSession.mockReturnValue(session);
    mockInterruptClaudeSessionForStop.mockResolvedValue({
      outcome: 'interrupted',
      fence: nativeStopFence,
    });

    const result = await cancelWithIntent('stop');

    expect(mockCaptureClaudeStopFence).toHaveBeenCalledWith(session);
    expect(mockInterruptClaudeSessionForStop).toHaveBeenCalledWith(
      session,
      nativeStopFence,
    );
    expect(mockCaptureClaudeStopFence.mock.invocationCallOrder[0]).toBeLessThan(
      mockInputDeliveryStop.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(result).toMatchObject({
      outcome: 'interrupted',
      context: {
        target,
        session,
        fence: nativeStopFence,
      },
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(mockMarkSessionForNextTurnRecreation).not.toHaveBeenCalled();
    expect(mockMarkSessionTeardownCause).not.toHaveBeenCalled();
    expect(mockDrainChatSessionEvents).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
    );
  });

  it('does not invoke an old native interrupt if a newer turn enters while input Stop is acquiring its ledger', async () => {
    const session = { cancel: jest.fn().mockResolvedValue(undefined) };
    mockGetSession.mockReturnValue(session);
    let signalStopStarted: () => void = () => {
      throw new Error('Input Stop did not start');
    };
    const stopStarted = new Promise<void>((resolve) => {
      signalStopStarted = resolve;
    });
    let continueStop: () => void = () => {
      throw new Error('Input Stop did not resume');
    };
    const stopBarrier = new Promise<void>((resolve) => {
      continueStop = resolve;
    });
    mockInputDeliveryStop.mockImplementationOnce(async (_req, operation) => {
      signalStopStarted();
      await stopBarrier;
      await operation();
    });

    const stopping = cancelWithIntent('stop');
    await stopStarted;
    mockIsClaudeStopFenceCurrent.mockReturnValue(false);
    continueStop();
    const result = await stopping;

    expect(result).toMatchObject({ outcome: 'not-found' });
    expect(mockInterruptClaudeSessionForStop).not.toHaveBeenCalled();
    expect(session.cancel).not.toHaveBeenCalled();
    expect(mockDrainChatSessionEvents).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
    );
  });

  it('captures a stop context synchronously and fences a replacement session', () => {
    const firstSession = { cancel: jest.fn() };
    const replacementSession = { cancel: jest.fn() };
    mockGetSession.mockReturnValue(firstSession);
    const cancellationApi = jest.requireActual<Record<string, unknown>>(
      '../lib/chat-turn-cancel',
    );
    const captureCandidate = cancellationApi['captureChatTurnStop'];
    if (!hasStopContextCapture(captureCandidate)) {
      throw new Error('Expected the synchronous chat-stop capture seam');
    }

    const context = captureCandidate(target);
    mockGetSession.mockReturnValue(replacementSession);
    const currentCandidate = cancellationApi['isChatTurnStopCurrent'];
    if (!hasStopContextCurrentCheck(currentCandidate)) {
      throw new Error('Expected the chat-stop current-context predicate');
    }

    expect(context).toMatchObject({
      target,
      session: firstSession,
      fence: nativeStopFence,
    });
    expect(currentCandidate(context)).toBe(false);
  });

  it('stops a send still preparing when the retained Claude session has no foreground turn', async () => {
    const session = { cancel: jest.fn().mockResolvedValue(undefined) };
    mockGetSession.mockReturnValue(session);
    mockCaptureClaudeStopFence.mockReturnValue({
      ...nativeStopFence,
      turnId: undefined,
      userMessageId: undefined,
    });
    const preparing = beginChatTurnPreparation({
      ...target,
      userMessageId: 'preparing-user',
    });
    const stopContext = captureChatTurnStop(target);
    // The captured send's dispatch begins its own preparation after capture;
    // a different send that starts then is not the one Stop saw.
    const dispatching = beginChatTurnPreparation({
      ...target,
      userMessageId: 'preparing-user',
    });
    const newer = beginChatTurnPreparation({
      ...target,
      userMessageId: 'newer-user',
    });
    try {
      await cancelChatTurn(target, 'stop', stopContext);
      expect(preparing.cancelled).toBe(true);
      expect(dispatching.cancelled).toBe(true);
      expect(newer.cancelled).toBe(false);
      // Untagged, the terminal the queue's Stop reservation waits for.
      expect(mockOnTurnTerminal).toHaveBeenCalledTimes(1);
      expect(mockOnTurnTerminal).toHaveBeenCalledWith(target, 'cancelled');
    } finally {
      preparing.finish();
      dispatching.finish();
      newer.finish();
    }
  });

  it('reports a fenceless Stop that cancelled a preparing send only while it is current', async () => {
    mockGetSession.mockReturnValue(undefined);
    mockCaptureClaudeStopFence.mockReturnValue(undefined);
    const preparing = beginChatTurnPreparation({
      ...target,
      userMessageId: 'first-send',
    });
    try {
      // No session yet: the send's preparation is still Stop's to cancel.
      await expect(cancelChatTurn(target, 'stop')).resolves.toMatchObject({
        outcome: 'not-found',
        preparationsCancelled: true,
      });
      expect(preparing.cancelled).toBe(true);
    } finally {
      preparing.finish();
    }

    const second = beginChatTurnPreparation({
      ...target,
      userMessageId: 'second-send',
    });
    try {
      const stopping = cancelChatTurn(target, 'stop');
      // A replacement session registers while Stop resolves its services.
      mockGetSession.mockReturnValue({ cancel: jest.fn() });
      const result = await stopping;
      expect(result.outcome).toBe('not-found');
      expect(result).not.toHaveProperty('preparationsCancelled');
    } finally {
      second.finish();
    }

    // Or later, while input delivery suspends its ledger.
    mockGetSession.mockReturnValue(undefined);
    const third = beginChatTurnPreparation({
      ...target,
      userMessageId: 'third-send',
    });
    mockInputDeliveryStop.mockImplementationOnce(async (_req, operation) => {
      mockGetSession.mockReturnValue({ cancel: jest.fn() });
      return operation();
    });
    try {
      const result = await cancelChatTurn(target, 'stop');
      expect(third.cancelled).toBe(true);
      expect(result).not.toHaveProperty('preparationsCancelled');
    } finally {
      third.finish();
    }
  });

  it('sends no queue terminal for an idle Stop that cancelled no send, or for a fenced Stop', async () => {
    const session = { cancel: jest.fn().mockResolvedValue(undefined) };
    mockGetSession.mockReturnValue(session);
    mockCaptureClaudeStopFence.mockReturnValueOnce({
      ...nativeStopFence,
      turnId: undefined,
      userMessageId: undefined,
    });
    await cancelChatTurn(target, 'stop', captureChatTurnStop(target));
    const fenced = beginChatTurnPreparation({
      ...target,
      userMessageId: 'native-user-1',
    });
    try {
      await cancelChatTurn(target, 'stop');
      expect(fenced.cancelled).toBe(true);
    } finally {
      fenced.finish();
    }
    // A fenced Stop's caller settles its own turn with a tagged terminal.
    expect(mockOnTurnTerminal).not.toHaveBeenCalled();
  });

  it('does not sweep queue or input state when a newer same-process turn wins during service imports', async () => {
    const session = { cancel: jest.fn().mockResolvedValue(undefined) };
    mockGetSession.mockReturnValue(session);

    const stopping = cancelChatTurn(target, 'stop');
    mockIsClaudeStopFenceCurrent.mockReturnValue(false);
    const result = await stopping;

    expect(result).toMatchObject({ outcome: 'not-found' });
    expect(mockInvalidatePendingInputOperations).not.toHaveBeenCalled();
    expect(mockInputDeliveryStop).not.toHaveBeenCalled();
    expect(mockInterruptClaudeSessionForStop).not.toHaveBeenCalled();
    expect(session.cancel).not.toHaveBeenCalled();
  });

  it('marks a native Claude stop for recreation when its live query has already ended', async () => {
    const session = { cancel: jest.fn().mockResolvedValue(undefined) };
    mockGetSession.mockReturnValue(session);
    mockInterruptClaudeSessionForStop.mockResolvedValue({
      outcome: 'fallback-aborted',
      fence: nativeStopFence,
    });

    await cancelWithIntent('stop');

    expect(mockInterruptClaudeSessionForStop).toHaveBeenCalledWith(
      session,
      nativeStopFence,
    );
    expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
      'stop',
    );
  });

  it('keeps Ollama Stop on the destructive cancel and recreation path', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    mockGetSession.mockReturnValue({ cancel });
    mockGetSessionProviderType.mockReturnValue('ollama');

    await cancelWithIntent('stop');

    expect(mockInterruptClaudeSessionForStop).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
      'stop',
    );
  });

  it.each([
    ['the default teardown intent', undefined],
    ['an explicit teardown intent', 'teardown' as const],
  ])('%s remains a destructive session cancel', async (_label, intent) => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    mockGetSession.mockReturnValue({ cancel });

    if (intent === undefined) {
      await cancelChatTurn(target);
    } else {
      await cancelWithIntent(intent);
    }

    expect(mockInterruptClaudeSessionForStop).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalled();
  });

  it('uses the native Claude interrupt for queued Interrupt without recreating the session', async () => {
    const cancel = jest.fn().mockResolvedValue(undefined);
    const session = {
      cancel,
      hasPendingSteeringInput: jest.fn(() => false),
    };
    mockGetSession.mockReturnValue(session);
    mockInterruptClaudeSessionForStop.mockResolvedValue({
      outcome: 'interrupted',
      fence: nativeStopFence,
    });

    await interruptChatTurnForQueuedMessage(target);

    expect(mockCaptureClaudeStopFence).toHaveBeenCalledWith(session);
    expect(mockInterruptClaudeSessionForStop).toHaveBeenCalledWith(
      session,
      nativeStopFence,
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(mockMarkSessionForNextTurnRecreation).not.toHaveBeenCalled();
    expect(mockDrainChatSessionEvents).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
    );
  });

  it('marks a queued Claude interruption for recreation when its live query has already ended', async () => {
    const session = {
      cancel: jest.fn().mockResolvedValue(undefined),
      hasPendingSteeringInput: jest.fn(() => false),
    };
    mockGetSession.mockReturnValue(session);
    mockInterruptClaudeSessionForStop.mockResolvedValue({
      outcome: 'fallback-aborted',
      fence: nativeStopFence,
    });

    await interruptChatTurnForQueuedMessage(target);

    expect(mockInterruptClaudeSessionForStop).toHaveBeenCalledWith(
      session,
      nativeStopFence,
    );
    expect(mockMarkSessionForNextTurnRecreation).toHaveBeenCalledWith(
      'proj',
      'worktree',
      'chat',
      'stop',
    );
  });
});

describe('Stop for a chat whose first send has no session yet', () => {
  const idleFence = {
    ...nativeStopFence,
    turnId: undefined,
    userMessageId: undefined,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockReturnValue(undefined);
    mockGetAllActiveSessionInfos.mockReturnValue([]);
    mockCaptureClaudeStopFence.mockImplementation((session) =>
      session === undefined ? undefined : nativeStopFence,
    );
  });

  function preparingFirstSend(userMessageId = 'native-user-1') {
    const preparation = beginChatTurnPreparation({ ...target, userMessageId });
    const [context] = captureChatTurnStopsForChat(target.chatId);
    if (!context) throw new Error('Expected a captured first send');
    return { preparation, context };
  }

  it('captures each target with a live session or a preparing send, once', () => {
    const other = { ...target, worktreeId: 'other-entry' };
    mockGetAllActiveSessionInfos.mockReturnValue([
      other,
      { ...target, chatId: 'another-chat' },
    ]);
    const preparing = beginChatTurnPreparation({
      ...target,
      userMessageId: 'first-send',
    });
    const alsoOther = beginChatTurnPreparation({ ...other });
    try {
      const contexts = captureChatTurnStopsForChat(target.chatId);
      expect(contexts.map((context) => context.target)).toEqual([
        other,
        target,
      ]);
      expect(contexts[1]?.session).toBeUndefined();
      expect(contexts[1]?.preparations).toEqual(new Set([preparing]));
    } finally {
      preparing.finish();
      alsoOther.finish();
    }
    // A finished preparation no longer names its target.
    mockGetAllActiveSessionInfos.mockReturnValue([]);
    expect(captureChatTurnStopsForChat(target.chatId)).toEqual([]);
  });

  it('adopts the session whose native turn is the captured send', async () => {
    const { preparation, context } = preparingFirstSend();
    try {
      expect(adoptPreparingSendSession(context)).toBe(context);
      const session = { cancel: jest.fn().mockResolvedValue(undefined) };
      mockGetSession.mockReturnValue(session);

      const adopted = adoptPreparingSendSession(context);

      expect(adopted).toMatchObject({ session, fence: nativeStopFence });
      await cancelChatTurn(target, 'stop', adopted);
      expect(preparation.cancelled).toBe(true);
      expect(mockInterruptClaudeSessionForStop).toHaveBeenCalledWith(
        session,
        nativeStopFence,
      );
    } finally {
      preparation.finish();
    }
  });

  it('adopts an idle session while the captured send still prepares, without its newer sends', async () => {
    const { preparation, context } = preparingFirstSend();
    const newer = beginChatTurnPreparation({
      ...target,
      userMessageId: 'newer-user',
    });
    try {
      mockGetSession.mockReturnValue({
        cancel: jest.fn().mockResolvedValue(undefined),
      });
      mockCaptureClaudeStopFence.mockReturnValue(idleFence);

      const adopted = adoptPreparingSendSession(context);

      expect(adopted.preparations).toEqual(new Set([preparation]));
      await cancelChatTurn(target, 'stop', adopted);
      expect(preparation.cancelled).toBe(true);
      expect(newer.cancelled).toBe(false);
    } finally {
      preparation.finish();
      newer.finish();
    }
  });

  it("never adopts a newer send's or a wake's turn", () => {
    const { preparation, context } = preparingFirstSend();
    try {
      mockGetSession.mockReturnValue({ cancel: jest.fn() });
      mockCaptureClaudeStopFence.mockReturnValue({
        ...nativeStopFence,
        userMessageId: 'newer-user',
      });
      expect(adoptPreparingSendSession(context)).toBe(context);
      mockCaptureClaudeStopFence.mockReturnValue({
        ...nativeStopFence,
        userMessageId: undefined,
      });
      expect(adoptPreparingSendSession(context)).toBe(context);
    } finally {
      preparation.finish();
    }
    // Idle, but the captured send already finished preparing elsewhere.
    mockCaptureClaudeStopFence.mockReturnValue(idleFence);
    expect(adoptPreparingSendSession(context)).toBe(context);
  });
});
