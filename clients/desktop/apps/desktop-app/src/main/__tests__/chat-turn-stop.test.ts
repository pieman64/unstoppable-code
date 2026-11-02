/* eslint-disable @typescript-eslint/explicit-function-return-type */

const target = {
  projectId: 'workspace-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};
const stopContext = {
  target,
  session: { owner: 'session-owner' },
  fence: {
    processOwner: Symbol('session-owner'),
    turnId: 'running-turn',
    userMessageId: 'stopped-user-message',
    turnEpoch: 12,
  },
};
const mockCaptureChatTurnStop = jest.fn<unknown, [unknown]>(() => stopContext);
const mockIsChatTurnStopCurrent = jest.fn<boolean, [unknown]>(() => true);
const mockCancelChatTurn = jest.fn<
  Promise<unknown>,
  [unknown, unknown?, unknown?]
>(() => Promise.resolve({ context: stopContext, outcome: 'interrupted' }));
const mockOnTurnTerminal = jest.fn();
const mockIngestProviderEvent = jest.fn<Promise<void>, unknown[]>(() =>
  Promise.resolve(),
);
const mockCaptureTurnEndAndDiff = jest.fn<Promise<unknown>, [string, unknown]>(
  () => Promise.resolve(null),
);
const mockCancelTransientRetryForChat = jest.fn();
const mockCancelActiveReload = jest.fn();

jest.mock('../lib/chat-turn-cancel', () => ({
  captureChatTurnStop: (...args: [unknown]): unknown =>
    mockCaptureChatTurnStop(...args),
  isChatTurnStopCurrent: (...args: [unknown]): boolean =>
    mockIsChatTurnStopCurrent(...args),
  cancelChatTurn: (...args: [unknown, unknown?, unknown?]): Promise<unknown> =>
    mockCancelChatTurn(...args),
}));
jest.mock('../lib/turn-diff-capture', () => ({
  captureTurnEndAndDiff: (
    sessionKey: string,
    endedTurn: unknown,
  ): Promise<unknown> => mockCaptureTurnEndAndDiff(sessionKey, endedTurn),
}));
jest.mock('../lib/transient-error-retry-service', () => ({
  cancelTransientRetryForChat: (...args: unknown[]): void => {
    mockCancelTransientRetryForChat(...args);
  },
}));
jest.mock('../deferred-tools/reload-coordinator', () => ({
  deferredToolsReloadCoordinator: {
    cancelActiveReload: (...args: unknown[]): void => {
      mockCancelActiveReload(...args);
    },
  },
}));
jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: () => ({
    onTurnTerminal: (...args: unknown[]): void => {
      mockOnTurnTerminal(...args);
    },
  }),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    ingestProviderEvent: (...args: unknown[]): Promise<void> =>
      mockIngestProviderEvent(...args),
  }),
}));

import { stopChatTurn } from '../lib/chat-turn-stop';
import { getChatTurnOwnership } from '../services/chat-turn-ownership';
import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred value was not initialized');
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('stopChatTurn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCaptureChatTurnStop.mockReturnValue(stopContext);
    mockIsChatTurnStopCurrent.mockReturnValue(true);
    mockCancelChatTurn.mockResolvedValue({
      context: stopContext,
      outcome: 'interrupted',
    });
  });

  it('captures the stopped turn before awaiting, uses Stop intent, and fences its synthetic terminal', async () => {
    const result = await stopChatTurn(target);

    expect(mockCaptureChatTurnStop).toHaveBeenCalledWith(target);
    expect(mockCancelChatTurn).toHaveBeenCalledWith(
      target,
      'stop',
      stopContext,
    );
    expect(mockCaptureChatTurnStop.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelChatTurn.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(mockOnTurnTerminal).toHaveBeenCalledWith(
      target,
      'cancelled',
      'stopped-user-message',
    );
    expect(mockIngestProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ...target,
        // Jest's asymmetric matcher is untyped; this is fixture data only.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          type: 'result',
          is_error: false,
          result: 'Cancelled',
          canopy_turn_user_message_id: 'stopped-user-message',
        }),
        turnUserMessageId: 'stopped-user-message',
      }),
    );
    expect(result).toMatchObject({
      result: 'Cancelled',
      canopy_turn_user_message_id: 'stopped-user-message',
    });
  });

  it("captures the turn diff of a turn Stop's abort fallback ended (turn-state phase 43e)", async () => {
    mockCancelChatTurn.mockResolvedValueOnce({
      context: stopContext,
      outcome: 'fallback-aborted',
    });
    const diff = {
      files: [{ path: 'src/a.ts', status: 'modified' }],
      treeRefs: [],
    };
    mockCaptureTurnEndAndDiff.mockResolvedValueOnce(diff);

    await stopChatTurn(target);

    expect(mockCaptureTurnEndAndDiff).toHaveBeenCalledWith(
      'workspace-1/worktree-1/chat-1',
      { userMessageId: 'stopped-user-message' },
    );
    expect(mockIngestProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ...target,
        data: {
          type: 'turn_diff',
          userMessageId: 'stopped-user-message',
          ...diff,
        },
        turnUserMessageId: 'stopped-user-message',
      }),
    );
  });

  it("leaves an interrupted turn's diff to the provider terminal it delivers", async () => {
    await stopChatTurn(target);

    expect(mockCaptureTurnEndAndDiff).not.toHaveBeenCalled();
  });

  it('keeps a newer send or wake active while the older Stop is still awaiting native interruption', async () => {
    const currentTurn = { userMessageId: 'stopped-user-message' };
    const cancellation = deferred<unknown>();
    mockCancelChatTurn.mockReturnValueOnce(cancellation.promise);
    mockOnTurnTerminal.mockImplementation(
      (_target: unknown, _status: unknown, userMessageId?: string): void => {
        if (userMessageId === currentTurn.userMessageId) {
          currentTurn.userMessageId = '';
        }
      },
    );

    const stopping = stopChatTurn(target);
    const capturedSynchronously = mockCaptureChatTurnStop.mock.calls.some(
      ([request]) => request === target,
    );
    currentTurn.userMessageId = 'newer-send-or-wake';
    cancellation.resolve({ context: stopContext, outcome: 'interrupted' });
    await stopping;

    expect(capturedSynchronously).toBe(true);
    expect(mockOnTurnTerminal).toHaveBeenCalledWith(
      target,
      'cancelled',
      'stopped-user-message',
    );
    expect(currentTurn.userMessageId).toBe('newer-send-or-wake');
  });

  it('does not release an idle native turn after a newer send wins the Stop race', async () => {
    const idleContext = {
      ...stopContext,
      fence: {
        ...stopContext.fence,
        turnId: undefined,
        userMessageId: undefined,
      },
      preparations: new Set([
        { cancelled: false, userMessageId: 'preparing', finish: jest.fn() },
      ]),
    };
    mockCaptureChatTurnStop.mockReturnValueOnce(idleContext);
    const cancellationStarted = deferred<void>();
    const cancellation = deferred<unknown>();
    mockCancelChatTurn.mockImplementationOnce(() => {
      cancellationStarted.resolve();
      return cancellation.promise;
    });

    const stopping = stopChatTurn(target);
    await cancellationStarted.promise;
    mockIsChatTurnStopCurrent.mockReturnValue(false);
    cancellation.resolve({ context: idleContext, outcome: 'not-found' });

    const result = await stopping;

    expect(mockOnTurnTerminal).not.toHaveBeenCalled();
    expect(mockIngestProviderEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: 'result',
      is_error: false,
      result: 'Cancelled',
    });
    expect(result.canopy_turn_user_message_id).toEqual(expect.any(String));
    expect(result.canopy_turn_user_message_id).not.toBe('newer-send-or-wake');
  });
});

describe('Stop of a turn fenced before its prompt bound', () => {
  const unboundFence = {
    processOwner: Symbol('session-owner'),
    turnId: 'early-turn',
    userMessageId: 'early-turn',
    turnEpoch: 3,
  };
  const endedState = (userMessageId?: string) =>
    serializeChatTurnState({
      ...initialChatTurnState(),
      lastEnded: {
        id: 'early-turn',
        origin: userMessageId ? 'user' : 'autonomous',
        ...(userMessageId ? { userMessageId, inputIds: [userMessageId] } : {}),
        startedAtMs: 1,
        pauses: [],
        endedAtMs: 2,
        outcome: 'cancelled',
        durationMs: 1,
      },
      endedTurnIds: ['early-turn'],
    });
  const bindEnded = (userMessageId?: string): (() => void) =>
    getChatTurnOwnership().bind(
      {
        getTurnState: () => endedState(userMessageId),
        onTurnStateChange: () => () => undefined,
        onTurnStateCommitted: () => () => undefined,
      },
      () => Promise.resolve(endedState(userMessageId)),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    const context = { ...stopContext, fence: unboundFence };
    mockCaptureChatTurnStop.mockReturnValue(context);
    mockCancelChatTurn.mockResolvedValue({ context, outcome: 'interrupted' });
  });

  afterEach(() => {
    getChatTurnOwnership().resetScopesForTests();
    mockCaptureChatTurnStop.mockReturnValue(stopContext);
    mockCancelChatTurn.mockResolvedValue({
      context: stopContext,
      outcome: 'interrupted',
    });
  });

  it('settles the user message canonical state bound to the stopped turn', async () => {
    const unbind = bindEnded('bound-user-message');
    try {
      const result = await stopChatTurn(target);
      // The queue's gate and D owner name the dispatched message, not the turn.
      expect(mockOnTurnTerminal).toHaveBeenCalledWith(
        target,
        'cancelled',
        'bound-user-message',
      );
      expect(mockIngestProviderEvent).toHaveBeenCalledWith(
        expect.objectContaining({ turnUserMessageId: 'bound-user-message' }),
      );
      expect(result.canopy_turn_user_message_id).toBe('bound-user-message');
    } finally {
      unbind();
    }
  });

  it('keeps the turn id for a wake no user message ever bound', async () => {
    const unbind = bindEnded();
    try {
      await stopChatTurn(target);
      expect(mockOnTurnTerminal).toHaveBeenCalledWith(
        target,
        'cancelled',
        'early-turn',
      );
    } finally {
      unbind();
    }
  });
});

describe('Stop ownership', () => {
  it('holds a stop owner from capture until the durable settle', async () => {
    const ownership = getChatTurnOwnership();
    const unbind = ownership.bind(
      {
        getTurnState: () => serializeChatTurnState(initialChatTurnState()),
        onTurnStateChange: () => () => undefined,
        onTurnStateCommitted: () => () => undefined,
      },
      () => Promise.resolve(serializeChatTurnState(initialChatTurnState())),
    );
    const settled = deferred<void>();
    mockIngestProviderEvent.mockImplementationOnce(() => settled.promise);
    try {
      const stopping = stopChatTurn(target);
      expect(ownership.getSnapshot(target).stopOwners).toEqual([
        expect.objectContaining({
          kind: 'stop',
          userMessageId: 'stopped-user-message',
        }),
      ]);
      await Promise.resolve();
      await Promise.resolve();
      expect(ownership.getSnapshot(target).stopOwners).toHaveLength(1);

      settled.resolve();
      await stopping;
      expect(ownership.getSnapshot(target).stopOwners).toEqual([]);
    } finally {
      unbind();
    }
  });
});
