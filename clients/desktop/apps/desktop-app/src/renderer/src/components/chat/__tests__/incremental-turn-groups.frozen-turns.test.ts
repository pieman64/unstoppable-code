/**
 * Phase 12: completed turns are frozen. Their grouping and merged tool
 * results keep their identity (their revision) across recomputations while
 * their content is unchanged, and are invalidated when that turn changes.
 * `TurnGroupCache` and `turnGroupsMatch` remain the fallback for any changed
 * identity.
 */
import type {
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/agent-transcript/types';
import {
  computeIncrementalTurnGroups,
  createEmptyTurnGroupCache,
} from '../incremental-turn-groups';
import type { TurnGroup, TurnGroupOrMessage } from '../types';

function message(
  id: string,
  role: PersistedChatMessage['role'],
  blocks: PersistedChatBlock[],
  timestamp: number,
): PersistedChatMessage {
  return { id, role, blocks, timestamp };
}

function completedTurn(turn: number): PersistedChatMessage[] {
  const at = turn * 100;
  return [
    message(
      `user-${turn}`,
      'user',
      [{ type: 'text', text: `ask ${turn}` }],
      at,
    ),
    message(
      `call-${turn}`,
      'assistant',
      [
        { type: 'text', text: `working ${turn}` },
        {
          type: 'tool_use',
          toolUseId: `tool-${turn}`,
          toolName: 'Bash',
          input: '{"command":"ls"}',
        },
      ],
      at + 1,
    ),
    message(
      `result-${turn}`,
      'assistant',
      [
        {
          type: 'tool_result',
          toolUseId: `tool-${turn}`,
          toolName: 'Bash',
          output: `files ${turn}`,
          isError: false,
        },
      ],
      at + 2,
    ),
    message(
      `marker-${turn}`,
      'assistant',
      [{ type: 'hook_info', triggerName: `hook-${turn}`, timestamp: at + 3 }],
      at + 3,
    ),
    message(
      `timer-${turn}`,
      'system',
      [{ type: 'turn_timer', startedAt: at, completedAt: at + 50 }],
      at + 4,
    ),
  ];
}

function activeTurn(text: string): PersistedChatMessage[] {
  return [
    message('user-9', 'user', [{ type: 'text', text: 'live ask' }], 900),
    message(
      'timer-9',
      'system',
      [{ type: 'turn_timer', startedAt: 900, completedAt: null }],
      900,
    ),
    message('live-9', 'assistant', [{ type: 'text', text }], 901),
  ];
}

function turnGroup(groups: TurnGroupOrMessage[], userId: string): TurnGroup {
  const group = groups.find(
    (candidate): candidate is TurnGroup =>
      candidate.kind === 'turn-group' && candidate.userMessage.id === userId,
  );
  if (!group) throw new Error(`missing turn ${userId}`);
  return group;
}

describe('computeIncrementalTurnGroups frozen completed turns', () => {
  it('invalidates a completed turn when only its error display code changes', () => {
    const cache = createEmptyTurnGroupCache();
    const history = completedTurn(1);
    const first = computeIncrementalTurnGroups(
      'chat',
      history,
      undefined,
      cache,
    );
    const marked = history.map((row) =>
      row.id === 'call-1'
        ? {
            ...row,
            blocks: row.blocks.map(
              (block): PersistedChatBlock =>
                block.type === 'text'
                  ? {
                      ...block,
                      errorCode: 'claude_ai_credits_fallback_rejected',
                    }
                  : block,
            ),
          }
        : row,
    );
    const second = computeIncrementalTurnGroups(
      'chat',
      marked,
      undefined,
      cache,
    );
    expect(turnGroup(second, 'user-1')).not.toBe(turnGroup(first, 'user-1'));
    const third = computeIncrementalTurnGroups(
      'chat',
      history,
      undefined,
      cache,
    );
    expect(turnGroup(third, 'user-1')).not.toBe(turnGroup(second, 'user-1'));
  });

  it('reuses each completed turn and its merged blocks while the active turn streams', () => {
    const cache = createEmptyTurnGroupCache();
    const history = [...completedTurn(1), ...completedTurn(2)];
    const first = computeIncrementalTurnGroups(
      'chat',
      [...history, ...activeTurn('a')],
      undefined,
      cache,
    );
    const second = computeIncrementalTurnGroups(
      'chat',
      [...history, ...activeTurn('ab')],
      undefined,
      cache,
    );

    expect(turnGroup(second, 'user-1')).toBe(turnGroup(first, 'user-1'));
    expect(turnGroup(second, 'user-2')).toBe(turnGroup(first, 'user-2'));
    // The merged tool block of the active-history turn is the same object.
    expect(cache.displayMessages.find((row) => row.id === 'call-1')).toBe(
      turnGroup(first, 'user-1').assistantMessages[0],
    );
    expect(turnGroup(second, 'user-9')).not.toBe(turnGroup(first, 'user-9'));
  });

  it('reuses a completed turn whose rows were replaced by equal copies', () => {
    const cache = createEmptyTurnGroupCache();
    const turn = completedTurn(1);
    const first = computeIncrementalTurnGroups('chat', turn, undefined, cache);
    // The store may rebuild message objects (a snapshot refresh) without
    // changing their content.
    const copies = turn.map((row) => ({
      ...row,
      blocks: row.blocks.map((block) => ({ ...block })),
    }));
    const second = computeIncrementalTurnGroups(
      'chat',
      copies,
      undefined,
      cache,
    );

    expect(turnGroup(second, 'user-1')).toBe(turnGroup(first, 'user-1'));
  });

  it('invalidates only the completed turn whose content changed', () => {
    const cache = createEmptyTurnGroupCache();
    const turnOne = completedTurn(1);
    const turnTwo = completedTurn(2);
    const first = computeIncrementalTurnGroups(
      'chat',
      [...turnOne, ...turnTwo],
      undefined,
      cache,
    );

    // A late tool_result revision for turn 1's tool.
    const revisedTurnOne = turnOne.map((row) =>
      row.id === 'result-1'
        ? message(
            'result-1',
            'assistant',
            [
              {
                type: 'tool_result',
                toolUseId: 'tool-1',
                toolName: 'Bash',
                output: 'files 1 (revised)',
                isError: false,
              },
            ],
            row.timestamp,
          )
        : row,
    );
    const second = computeIncrementalTurnGroups(
      'chat',
      [...revisedTurnOne, ...turnTwo],
      undefined,
      cache,
    );

    const before = turnGroup(first, 'user-1');
    const after = turnGroup(second, 'user-1');
    expect(after).not.toBe(before);
    const revisedTool = after.assistantMessages[0].blocks[1];
    expect(revisedTool).toMatchObject({
      type: 'tool_use',
      result: { output: 'files 1 (revised)' },
    });
    // Unchanged blocks and messages inside the invalidated turn stay shared.
    expect(after.assistantMessages[0].blocks[0]).toBe(
      before.assistantMessages[0].blocks[0],
    );
    expect(after.assistantMessages[1]).toBe(before.assistantMessages[1]);
    expect(turnGroup(second, 'user-2')).toBe(turnGroup(first, 'user-2'));
  });

  it('invalidates a completed turn when a marker block changes content', () => {
    const cache = createEmptyTurnGroupCache();
    const turn = completedTurn(1);
    const first = computeIncrementalTurnGroups('chat', turn, undefined, cache);
    const changed = turn.map((row) =>
      row.id === 'marker-1'
        ? message(
            'marker-1',
            'assistant',
            [{ type: 'hook_info', triggerName: 'hook-1b', timestamp: 103 }],
            row.timestamp,
          )
        : row,
    );
    const second = computeIncrementalTurnGroups(
      'chat',
      changed,
      undefined,
      cache,
    );

    expect(turnGroup(second, 'user-1')).not.toBe(turnGroup(first, 'user-1'));
    expect(turnGroup(second, 'user-1').assistantMessages[1].blocks[0]).toEqual({
      type: 'hook_info',
      triggerName: 'hook-1b',
      timestamp: 103,
    });
  });

  it('drops the shared display cache on a chat switch', () => {
    const cache = createEmptyTurnGroupCache();
    const turn = completedTurn(1);
    const first = computeIncrementalTurnGroups(
      'chat-a',
      turn,
      undefined,
      cache,
    );
    const second = computeIncrementalTurnGroups(
      'chat-b',
      turn,
      undefined,
      cache,
    );

    expect(turnGroup(second, 'user-1')).not.toBe(turnGroup(first, 'user-1'));
    expect(turnGroup(second, 'user-1')).toEqual(turnGroup(first, 'user-1'));
  });
});
