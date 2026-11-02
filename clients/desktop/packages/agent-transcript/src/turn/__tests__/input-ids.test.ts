import type { TurnStarted } from '@canopy/protocol/canopy-core';
import {
  hydrateChatTurnState,
  initialChatTurnState,
  reduceChatTurn,
  serializeChatTurnState,
  settleChatTurnForRestart,
  type ChatTurnState,
} from '../index';

function turnStarted(
  turnId: string,
  sequence: number,
  userMessageIds: string[],
  phase: TurnStarted['phase'] = 'start',
): TurnStarted {
  return {
    version: 1,
    provider: 'claude',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    processEpoch: 'epoch-1',
    sequence,
    eventId: `event-${sequence}`,
    observedAtMs: sequence * 100,
    turnId,
    origin: 'user',
    binding: 'bound',
    submissionIds: [],
    userMessageIds,
    providerUserMessageUuids: [],
    type: 'TurnStarted',
    phase,
    startedAtMs: sequence * 100,
  };
}

function currentTurnState(
  turnId: string,
  userMessageIds: string[],
): ChatTurnState {
  return reduceChatTurn(
    initialChatTurnState(),
    turnStarted(turnId, 1, userMessageIds),
  ).state;
}

describe('chat turn input ids', () => {
  it('records the ordered, deduplicated message ids from the start binding', () => {
    const startIds = ['message-1', 'message-2', 'message-1', 'message-3'];
    const result = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('turn-1', 1, startIds),
    );

    expect(result.state.current?.userMessageId).toBe('message-1');
    expect(result.state.current?.inputIds).toEqual([
      'message-1',
      'message-2',
      'message-3',
    ]);
  });

  it('appends current-turn binding updates in order without replacing the original user message', () => {
    const started = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('turn-1', 1, ['message-1', 'message-2']),
    );
    const updated = reduceChatTurn(
      started.state,
      turnStarted(
        'turn-1',
        2,
        ['message-2', 'message-3', 'message-4', 'message-3'],
        'binding-update',
      ),
    );

    expect(updated.state.current?.userMessageId).toBe('message-1');
    expect(updated.state.current?.inputIds).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);
    expect(updated.effects).toEqual([]);
  });

  it('caps the ordered unique ids at 64 across starts and binding updates', () => {
    const firstIds = Array.from(
      { length: 63 },
      (_, index) => `message-${index}`,
    );
    const started = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('turn-1', 1, firstIds),
    );
    const updated = reduceChatTurn(
      started.state,
      turnStarted(
        'turn-1',
        2,
        ['message-62', 'message-63', 'message-64'],
        'binding-update',
      ),
    );
    const capped = reduceChatTurn(
      updated.state,
      turnStarted('turn-1', 3, ['message-65'], 'binding-update'),
    );

    expect(updated.state.current?.inputIds).toHaveLength(64);
    expect(updated.state.current?.inputIds?.at(-1)).toBe('message-63');
    expect(capped.state.current?.inputIds).toEqual(
      updated.state.current?.inputIds,
    );
  });

  it('caps an oversized start binding at the first 64 unique ids', () => {
    const ids = Array.from({ length: 70 }, (_, index) => `message-${index}`);
    const result = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('turn-1', 1, ids),
    );

    expect(result.state.current?.inputIds).toEqual(ids.slice(0, 64));
  });

  it('ignores binding updates for an unknown turn without effects', () => {
    const result = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('unknown-turn', 1, ['message-1'], 'binding-update'),
    );

    expect(result.state.current).toBeUndefined();
    expect(result.effects).toEqual([]);
  });

  it('hydrates legacy records that do not include input ids', () => {
    const serialized = serializeChatTurnState(
      currentTurnState('turn-1', ['message-1']),
    );
    if (serialized.current === undefined) {
      throw new Error('Expected a serialized current turn');
    }
    delete serialized.current.inputIds;

    expect(hydrateChatTurnState(serialized)?.current?.inputIds).toBeUndefined();
  });

  it('seeds a legacy current turn from userMessageId before appending its first binding update', () => {
    const serialized = serializeChatTurnState(
      currentTurnState('turn-1', ['legacy-message']),
    );
    if (serialized.current === undefined) {
      throw new Error('Expected a serialized current turn');
    }
    delete serialized.current.inputIds;
    const legacyState = hydrateChatTurnState(serialized);
    if (legacyState === undefined) {
      throw new Error('Expected legacy turn state to hydrate');
    }

    const updated = reduceChatTurn(
      legacyState,
      turnStarted(
        'turn-1',
        2,
        ['new-message-1', 'new-message-2'],
        'binding-update',
      ),
    );

    expect(updated.state.current?.userMessageId).toBe('legacy-message');
    expect(updated.state.current?.inputIds).toEqual([
      'legacy-message',
      'new-message-1',
      'new-message-2',
    ]);
  });

  it('rejects malformed and oversized input-id arrays while deduplicating valid persisted arrays', () => {
    const serialized = serializeChatTurnState(
      currentTurnState('turn-1', ['message-1']),
    );
    const current = serialized.current;
    if (current === undefined) {
      throw new Error('Expected a serialized current turn');
    }

    expect(
      hydrateChatTurnState({
        ...serialized,
        current: { ...current, inputIds: 'not-an-array' },
      }),
    ).toBeUndefined();
    expect(
      hydrateChatTurnState({
        ...serialized,
        current: { ...current, inputIds: ['message-1', 42] },
      }),
    ).toBeUndefined();
    expect(
      hydrateChatTurnState({
        ...serialized,
        current: {
          ...current,
          inputIds: Array.from(
            { length: 65 },
            (_, index) => `message-${index}`,
          ),
        },
      }),
    ).toBeUndefined();

    const hydrated = hydrateChatTurnState({
      ...serialized,
      current: {
        ...current,
        inputIds: ['message-1', 'message-2', 'message-1'],
      },
    });
    expect(hydrated?.current?.inputIds).toEqual(['message-1', 'message-2']);
  });

  it('round-trips current and last-ended ids with detached serialization arrays', () => {
    const firstTurn = reduceChatTurn(
      initialChatTurnState(),
      turnStarted('turn-1', 1, ['ended-1', 'ended-2']),
    );
    const ended = settleChatTurnForRestart(firstTurn.state, 200);
    const nextTurn = reduceChatTurn(
      ended.state,
      turnStarted('turn-2', 2, ['current-1']),
    );
    const updated = reduceChatTurn(
      nextTurn.state,
      turnStarted('turn-2', 3, ['current-1', 'current-2'], 'binding-update'),
    );

    const serialized = serializeChatTurnState(updated.state);
    expect(serialized.current?.inputIds).toEqual(['current-1', 'current-2']);
    expect(serialized.lastEnded?.inputIds).toEqual(['ended-1', 'ended-2']);

    serialized.current?.inputIds?.push('serialized-current');
    serialized.lastEnded?.inputIds?.push('serialized-ended');
    expect(updated.state.current?.inputIds).toEqual(['current-1', 'current-2']);
    expect(updated.state.lastEnded?.inputIds).toEqual(['ended-1', 'ended-2']);

    const roundTripped = hydrateChatTurnState(
      serializeChatTurnState(updated.state),
    );
    expect(roundTripped?.current?.inputIds).toEqual(['current-1', 'current-2']);
    expect(roundTripped?.lastEnded?.inputIds).toEqual(['ended-1', 'ended-2']);
  });
});
