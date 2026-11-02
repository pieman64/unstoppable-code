/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
import type { CodexAgentCallBlock } from '@canopy/agent-transcript';
import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import {
  computeIncrementalTurnGroups,
  createEmptyTurnGroupCache,
  findLastForkableTurnGroupIndex,
  hasForkableAssistantContent,
} from '../incremental-turn-groups';

// ---------------------------------------------------------------------------
// Helpers — same lightweight fixtures as message-transforms.test.ts
// ---------------------------------------------------------------------------

type Block =
  | {
      type: string;
      text?: string;
      toolUseId?: string;
      toolName?: string;
      input?: string;
      output?: string;
      isError?: boolean;
      startedAt?: number;
      completedAt?: number | null;
      activityName?: string;
      timestamp?: number;
      authFailure?: AuthDependencyFailure;
      turnId?: string;
      userMessageId?: string;
      spawnedBy?: { taskId?: string; toolUseId?: string };
      subagentType?: string;
      description?: string;
      prompt?: string;
      runInBackground?: boolean;
      parentToolUseId?: string;
    }
  | CodexAgentCallBlock;

type Msg = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: Block[];
  timestamp: number;
  parentToolUseId?: string;
};

function msg(
  id: string,
  role: 'user' | 'assistant' | 'system',
  blocks: Block[],
  extra?: { parentToolUseId?: string },
): Msg {
  return { id, role, blocks, timestamp: Date.now(), ...extra };
}

function textBlock(text: string): Block {
  return { type: 'text', text };
}

function timerBlock(
  startedAt: number,
  completedAt: number | null = null,
): Block {
  return { type: 'turn_timer', startedAt, completedAt };
}

const asChat = (msgs: Msg[]): any[] => msgs;

function onlyTurnGroup(messages: Msg[]): any {
  const result = computeIncrementalTurnGroups(
    'chat-1',
    asChat(messages),
    undefined,
    createEmptyTurnGroupCache(),
  );
  expect(result).toHaveLength(1);
  expect(result[0].kind).toBe('turn-group');
  return result[0];
}

// ---------------------------------------------------------------------------
// NOTE: In the actual runtime the chatStore inserts messages as:
//   [user, turn_timer, assistant1, assistant2, ...]
// The turn_timer is placed right after the user message at send-time, and
// assistant messages arrive afterwards during streaming.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// computeIncrementalTurnGroups
// ---------------------------------------------------------------------------

describe('async answer cache updates', () => {
  it('refreshes an answered result when structured answers change without fallback text changing', () => {
    const cache = createEmptyTurnGroupCache();
    const makeMessages = (selection: string): Msg[] => [
      msg('prompt', 'user', [textBlock('Work')]),
      msg('timer', 'system', [timerBlock(1, 5)]),
      msg('answer', 'user', [
        {
          ...textBlock('Answer submitted'),
          ...{
            asyncQuestionAnswer: {
              requestId: 'request',
              startsTurn: false,
              answers: [{ question: 'Scope?', selectedOptions: [selection] }],
            },
          },
        },
      ]),
      msg('final', 'assistant', [textBlock('Done')]),
    ];
    const first = computeIncrementalTurnGroups(
      'chat',
      asChat(makeMessages('Full')),
      undefined,
      cache,
    );
    const updated = computeIncrementalTurnGroups(
      'chat',
      asChat(makeMessages('Focused')),
      undefined,
      cache,
    );
    expect(updated[0]).not.toBe(first[0]);
    expect(JSON.stringify(updated)).toContain('Focused');
  });
});

describe('hasForkableAssistantContent', () => {
  it('returns false for timer-only assistant content', () => {
    const group = onlyTurnGroup([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
    ]);

    expect(hasForkableAssistantContent(group)).toBe(false);
  });

  it('returns false for task-management-only assistant content', () => {
    const group = onlyTurnGroup([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [
        { type: 'tool_use', toolName: 'TodoWrite', toolUseId: 'todo-1' },
      ]),
    ]);

    expect(hasForkableAssistantContent(group)).toBe(false);
  });

  it('returns true for normal assistant output', () => {
    const group = onlyTurnGroup([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [textBlock('hi')]),
    ]);

    expect(hasForkableAssistantContent(group)).toBe(true);
  });
});

describe('findLastForkableTurnGroupIndex', () => {
  it('returns the latest complete turn with substantive assistant content', () => {
    const result = computeIncrementalTurnGroups(
      'chat-1',
      asChat([
        msg('u1', 'user', [textBlock('first')]),
        msg('t1', 'system', [timerBlock(100, 200)]),
        msg('a1', 'assistant', [textBlock('first answer')]),
        msg('u2', 'user', [textBlock('task mgmt only')]),
        msg('t2', 'system', [timerBlock(300, 400)]),
        msg('a2', 'assistant', [
          { type: 'tool_use', toolName: 'TodoWrite', toolUseId: 'todo-1' },
        ]),
        msg('u3', 'user', [textBlock('streaming')]),
        msg('t3', 'system', [timerBlock(500, null)]),
        msg('a3', 'assistant', [textBlock('streaming answer')]),
      ]),
      undefined,
      createEmptyTurnGroupCache(),
    );

    expect(findLastForkableTurnGroupIndex(result)).toBe(0);
  });

  it("never picks a wake's turn: forking cuts at a prompt", () => {
    const result = computeIncrementalTurnGroups(
      'chat-1',
      asChat([
        msg('u1', 'user', [textBlock('first')]),
        msg('t1', 'system', [
          { ...timerBlock(100, 200), turnId: 'turn-1', userMessageId: 'u1' },
        ]),
        msg('a1', 'assistant', [textBlock('first answer')]),
        msg('tw', 'system', [
          { ...timerBlock(300, 400), turnId: 'wake', spawnedBy: {} },
        ]),
        msg('a-wake', 'assistant', [textBlock('wake answer')]),
      ]),
      undefined,
      createEmptyTurnGroupCache(),
    );

    expect(result.map((item) => item.kind)).toEqual([
      'turn-group',
      'turn-group',
    ]);
    expect(findLastForkableTurnGroupIndex(result)).toBe(0);
  });
});

describe('computeIncrementalTurnGroups', () => {
  it('refreshes a cached wake turn once its spawning call loads', () => {
    const wake = [
      msg('tw', 'system', [
        {
          ...timerBlock(300, 400),
          turnId: 'wake',
          spawnedBy: { toolUseId: 'tool-1' },
        },
      ]),
      msg('a-wake', 'assistant', [textBlock('wake answer')]),
    ];
    const cache = createEmptyTurnGroupCache();
    // The wake's spawning call is in older history, not yet loaded.
    const before = computeIncrementalTurnGroups(
      'chat-1',
      asChat(wake),
      undefined,
      cache,
    );
    const history = [
      msg('u1', 'user', [textBlock('first')]),
      msg('a1', 'assistant', [
        {
          type: 'tool_use',
          toolName: 'Bash',
          toolUseId: 'tool-1',
          input: JSON.stringify({ description: 'Run the tests' }),
        },
      ]),
      msg('t1', 'system', [
        { ...timerBlock(100, 200), turnId: 'turn-1', userMessageId: 'u1' },
      ]),
    ];
    const after = computeIncrementalTurnGroups(
      'chat-1',
      asChat([...history, ...wake]),
      undefined,
      cache,
    );

    expect(
      before[0]?.kind === 'turn-group' && before[0].userMessage.blocks,
    ).toEqual([{ type: 'wake_boundary', turnId: 'wake' }]);
    expect(
      after[1]?.kind === 'turn-group' && after[1].userMessage.blocks,
    ).toEqual([
      {
        type: 'wake_boundary',
        turnId: 'wake',
        taskLabel: 'Run the tests',
        spawningUserMessageId: 'u1',
        spawningToolUseId: 'tool-1',
      },
    ]);
  });

  it('produces correct groups for a complete conversation', () => {
    // Runtime order: user, timer, assistant
    const messages = asChat([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [textBlock('hi')]),
    ]);
    const cache = createEmptyTurnGroupCache();
    const result = computeIncrementalTurnGroups(
      'chat-1',
      messages,
      undefined,
      cache,
    );
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('turn-group');
  });

  it('preserves referential identity for completed groups across calls', () => {
    const messages = asChat([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [textBlock('hi')]),
      msg('u2', 'user', [textBlock('streaming')]),
      msg('t2', 'system', [timerBlock(300, null)]),
      msg('a2', 'assistant', [textBlock('resp')]),
    ]);
    const cache = createEmptyTurnGroupCache();

    // First call: full computation, populates cache
    const result1 = computeIncrementalTurnGroups(
      'chat-1',
      messages,
      undefined,
      cache,
    );
    expect(cache.completedGroups.size).toBe(1);

    // Second call: same messages — completed group should be same reference
    const result2 = computeIncrementalTurnGroups(
      'chat-1',
      messages,
      undefined,
      cache,
    );
    expect(result2[0]).toBe(result1[0]); // Same object reference

    // Third call with updated tail — completed prefix still reused
    const updatedMessages = asChat([
      ...messages,
      msg('a3', 'assistant', [textBlock('more')]),
    ]);
    const result3 = computeIncrementalTurnGroups(
      'chat-1',
      updatedMessages,
      undefined,
      cache,
    );
    expect(result3[0]).toBe(result1[0]); // Same reference across updates
  });

  it('invalidates cache when chatId changes', () => {
    const chatAMessages = asChat([
      msg('a-u1', 'user', [textBlock('chat A')]),
      msg('a-t1', 'system', [timerBlock(100, 200)]),
      msg('a-a1', 'assistant', [textBlock('response A')]),
    ]);

    const chatBMessages = asChat([
      msg('b-u1', 'user', [textBlock('chat B')]),
      msg('b-t1', 'system', [timerBlock(300, 400)]),
      msg('b-a1', 'assistant', [textBlock('response B')]),
    ]);

    const cache = createEmptyTurnGroupCache();

    // Populate cache with chat A
    const resultA = computeIncrementalTurnGroups(
      'chat-a',
      chatAMessages,
      undefined,
      cache,
    );
    expect(resultA).toHaveLength(1);
    expect(resultA[0].kind).toBe('turn-group');
    if (resultA[0].kind === 'turn-group') {
      expect(resultA[0].userMessage.id).toBe('a-u1');
    }

    // Switch to chat B — cache must invalidate, not reuse chat A's groups
    const resultB = computeIncrementalTurnGroups(
      'chat-b',
      chatBMessages,
      undefined,
      cache,
    );
    expect(resultB).toHaveLength(1);
    expect(resultB[0].kind).toBe('turn-group');
    if (resultB[0].kind === 'turn-group') {
      expect(resultB[0].userMessage.id).toBe('b-u1');
    }
    expect(cache.chatId).toBe('chat-b');
  });

  it('does not mix chats when switching tabs', () => {
    // Both chats have the same structure — this catches keying bugs
    const chatAMessages = asChat([
      msg('a-u1', 'user', [textBlock('chat A turn 1')]),
      msg('a-t1', 'system', [timerBlock(100, 200)]),
      msg('a-a1', 'assistant', [textBlock('A response 1')]),
      msg('a-u2', 'user', [textBlock('chat A streaming')]),
    ]);

    const chatBMessages = asChat([
      msg('b-u1', 'user', [textBlock('chat B turn 1')]),
      msg('b-t1', 'system', [timerBlock(300, 400)]),
      msg('b-a1', 'assistant', [textBlock('B response 1')]),
      msg('b-u2', 'user', [textBlock('chat B streaming')]),
    ]);

    const cache = createEmptyTurnGroupCache();

    // Populate with chat A
    computeIncrementalTurnGroups('chat-a', chatAMessages, undefined, cache);

    // Switch to chat B
    const resultB = computeIncrementalTurnGroups(
      'chat-b',
      chatBMessages,
      undefined,
      cache,
    );

    // The completed turn should be from chat B, not chat A
    const completedGroup = resultB.find((g) => g.kind === 'turn-group');
    expect(completedGroup).toBeDefined();
    if (completedGroup?.kind === 'turn-group') {
      expect(completedGroup.userMessage.id).toBe('b-u1');
    }

    // The active tail should also be from chat B
    const standaloneItems = resultB.filter((g) => g.kind === 'standalone');
    expect(standaloneItems.length).toBeGreaterThan(0);
    if (standaloneItems[0]?.kind === 'standalone') {
      expect(standaloneItems[0].message.id).toBe('b-u2');
    }
  });

  it('preserves referential identity of stable groups during streaming', () => {
    const baseMessages = asChat([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [textBlock('hi')]),
      msg('u2', 'user', [textBlock('question')]),
      msg('t2', 'system', [timerBlock(300, null)]),
      msg('a2', 'assistant', [textBlock('partial')]),
    ]);

    const cache = createEmptyTurnGroupCache();

    // First render
    const result1 = computeIncrementalTurnGroups(
      'chat-1',
      baseMessages,
      undefined,
      cache,
    );

    // Simulate streaming update: new content appended
    const updatedMessages = asChat([
      ...baseMessages,
      msg('a3', 'assistant', [textBlock('more content')]),
    ]);

    const result2 = computeIncrementalTurnGroups(
      'chat-1',
      updatedMessages,
      undefined,
      cache,
    );

    // The completed turn group (first element) should be the same object
    expect(result2[0]).toBe(result1[0]);
    // But the arrays should be different (new tail groups appended)
    expect(result2).not.toBe(result1);
    expect(result2.length).toBeGreaterThanOrEqual(result1.length);
  });

  it('handles switching back to a previous chat correctly', () => {
    const chatAMessages = asChat([
      msg('a-u1', 'user', [textBlock('hello A')]),
      msg('a-t1', 'system', [timerBlock(100, 200)]),
      msg('a-a1', 'assistant', [textBlock('hi A')]),
    ]);

    const chatBMessages = asChat([
      msg('b-u1', 'user', [textBlock('hello B')]),
      msg('b-t1', 'system', [timerBlock(300, 400)]),
      msg('b-a1', 'assistant', [textBlock('hi B')]),
    ]);

    const cache = createEmptyTurnGroupCache();

    // Chat A — first visit, populates cache
    computeIncrementalTurnGroups('chat-a', chatAMessages, undefined, cache);

    // Switch to chat B
    const resultB = computeIncrementalTurnGroups(
      'chat-b',
      chatBMessages,
      undefined,
      cache,
    );

    // Switch back to chat A
    const resultA2 = computeIncrementalTurnGroups(
      'chat-a',
      chatAMessages,
      undefined,
      cache,
    );

    // Chat A results should be correct (not contaminated by chat B)
    if (resultA2[0]?.kind === 'turn-group') {
      expect(resultA2[0].userMessage.id).toBe('a-u1');
    }
    if (resultB[0]?.kind === 'turn-group') {
      expect(resultB[0].userMessage.id).toBe('b-u1');
    }
  });

  it('produces correct output with no completed turns (first turn streaming)', () => {
    const messages = asChat([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, null)]),
      msg('a1', 'assistant', [textBlock('streaming...')]),
    ]);
    const cache = createEmptyTurnGroupCache();
    const result = computeIncrementalTurnGroups(
      'chat-1',
      messages,
      undefined,
      cache,
    );
    // With no completed turns, should still produce groups
    expect(result.length).toBeGreaterThan(0);
    expect(cache.completedGroups.size).toBe(0);
  });

  it('retains assistant messages in cached stable groups (regression)', () => {
    // Runtime message order: user, timer, assistants...
    const turn1Messages = asChat([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]), // completed
      msg('a1', 'assistant', [textBlock('response 1')]),
      msg('a2', 'assistant', [textBlock('response 2')]),
    ]);

    const cache = createEmptyTurnGroupCache();

    // First call: populates cache
    const result1 = computeIncrementalTurnGroups(
      'chat-1',
      turn1Messages,
      undefined,
      cache,
    );
    expect(result1).toHaveLength(1);
    expect(result1[0].kind).toBe('turn-group');
    if (result1[0].kind === 'turn-group') {
      expect(result1[0].assistantMessages).toHaveLength(2);
      expect(result1[0].isComplete).toBe(true);
    }

    // User sends a new message — turn 2 starts
    const withTurn2 = asChat([
      ...turn1Messages,
      msg('u2', 'user', [textBlock('follow up')]),
      msg('t2', 'system', [timerBlock(300, null)]),
    ]);

    const result2 = computeIncrementalTurnGroups(
      'chat-1',
      withTurn2,
      undefined,
      cache,
    );

    // Turn 1 group must still have its assistant messages
    expect(result2[0].kind).toBe('turn-group');
    if (result2[0].kind === 'turn-group') {
      expect(result2[0].assistantMessages).toHaveLength(2);
      expect(result2[0].assistantMessages[0].id).toBe('a1');
      expect(result2[0].assistantMessages[1].id).toBe('a2');
      expect(result2[0].isComplete).toBe(true);
    }

    // Turn 2 should be in the tail
    expect(result2.length).toBeGreaterThanOrEqual(2);

    // Simulate streaming: assistant messages arrive for turn 2
    const streaming = asChat([
      ...withTurn2,
      msg('a3', 'assistant', [textBlock('streaming...')]),
    ]);

    const result3 = computeIncrementalTurnGroups(
      'chat-1',
      streaming,
      undefined,
      cache,
    );

    // Turn 1 should STILL have its assistant messages, reused by reference
    expect(result3[0]).toBe(result1[0]);
    if (result3[0].kind === 'turn-group') {
      expect(result3[0].assistantMessages).toHaveLength(2);
      expect(result3[0].isComplete).toBe(true);
    }
  });

  it('returns fresh group when a late subagent message changes subBlocks', () => {
    const agentBlock: Block = {
      type: 'tool_use',
      toolUseId: 'agent-1',
      toolName: 'Agent',
      input: '{"prompt":"do stuff"}',
    };

    const messages = asChat([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [agentBlock]),
    ]);

    const cache = createEmptyTurnGroupCache();

    const result1 = computeIncrementalTurnGroups(
      'chat-1',
      messages,
      undefined,
      cache,
    );
    expect(result1).toHaveLength(1);

    // Late sub-agent message arrives — mergeToolResults folds it into subBlocks
    const withSubResult = asChat([
      ...messages,
      msg('sub-a1', 'assistant', [textBlock('sub-agent result')], {
        parentToolUseId: 'agent-1',
      }),
    ]);

    const result2 = computeIncrementalTurnGroups(
      'chat-1',
      withSubResult,
      undefined,
      cache,
    );

    expect(result2).toHaveLength(1);
    expect(result2[0].kind).toBe('turn-group');
    // The subBlocks changed, so the cached group must NOT be reused
    expect(result2[0]).not.toBe(result1[0]);
  });

  it('returns fresh group when a late codex subagent message changes codex_agent.subBlocks', () => {
    // Simulate a `codex_agent_call` block sitting in the transcript. A late
    // subagent message (parentBlockId pointing at the call) arrives in the
    // second pass — `mergeToolResults` folds it into the codex_agent's
    // subBlocks, so the cached group must invalidate.
    const codexAgentBlock: Block = {
      type: 'codex_agent_call',
      agentBlockId: 'codex-agent-1',
      callId: '1',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'root',
      receiverThreadIds: ['sub-1'],
      prompt: 'work',
      agentsStates: { 'sub-1': { status: 'running', message: null } },
    } as unknown as Block;

    const messages = asChat([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [codexAgentBlock]),
    ]);

    const cache = createEmptyTurnGroupCache();

    const result1 = computeIncrementalTurnGroups(
      'chat-codex',
      messages,
      undefined,
      cache,
    );
    expect(result1).toHaveLength(1);

    // Late subagent message arrives — message-transforms folds it into the
    // codex_agent block's subBlocks via parentBlockId.
    const lateMsg = msg('sub-late', 'assistant', [textBlock('I found it')]);
    (lateMsg as { parentBlockId?: string }).parentBlockId = 'codex-agent-1';
    (lateMsg as { codexThreadId?: string }).codexThreadId = 'sub-1';

    const withLateSub = asChat([...messages, lateMsg]);

    const result2 = computeIncrementalTurnGroups(
      'chat-codex',
      withLateSub,
      undefined,
      cache,
    );
    expect(result2).toHaveLength(1);
    expect(result2[0].kind).toBe('turn-group');
    // codex_agent.subBlocks changed → cache MUST invalidate.
    expect(result2[0]).not.toBe(result1[0]);
  });

  it.each([
    ['description', { agentPath: 'root/review_cache' }],
    ['model', { model: 'gpt-5.6-sol' }],
    ['reasoningEffort', { reasoningEffort: 'high' }],
  ])(
    'returns fresh group when late codex agent %s metadata changes',
    (_field, receiverUpdate) => {
      const makeAgentBlock = (
        receiver: Record<string, string>,
      ): CodexAgentCallBlock => ({
        type: 'codex_agent_call',
        agentBlockId: 'codex-agent-metadata',
        callId: 'metadata-1',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 'root',
        receiverThreadIds: ['sub-1'],
        prompt: 'Inspect the cache behavior',
        agentsStates: {
          'sub-1': { status: 'completed', message: null },
        },
        receiverAgents: {
          'sub-1': {
            nickname: 'Tesla',
            role: 'explorer',
            agentPath: 'root/inspect_cache',
            model: 'gpt-5.6-luna',
            reasoningEffort: 'medium',
            ...receiver,
          },
        },
      });

      const cache = createEmptyTurnGroupCache();
      const initialMessages = asChat([
        msg('u1', 'user', [textBlock('inspect the cache')]),
        msg('t1', 'system', [timerBlock(100, 200)]),
        msg('a1', 'assistant', [makeAgentBlock({})]),
      ]);
      const initial = computeIncrementalTurnGroups(
        'chat-codex-metadata',
        initialMessages,
        undefined,
        cache,
      );

      const updatedMessages = asChat([
        msg('u1', 'user', [textBlock('inspect the cache')]),
        msg('t1', 'system', [timerBlock(100, 200)]),
        msg('a1', 'assistant', [makeAgentBlock(receiverUpdate)]),
      ]);
      const updated = computeIncrementalTurnGroups(
        'chat-codex-metadata',
        updatedMessages,
        undefined,
        cache,
      );

      expect(updated).toHaveLength(1);
      expect(updated[0].kind).toBe('turn-group');
      expect(updated[0]).not.toBe(initial[0]);
    },
  );

  it('returns fresh group when agentUsage changes', () => {
    const agentBlock: Block = {
      type: 'tool_use',
      toolUseId: 'agent-1',
      toolName: 'Agent',
      input: '{"prompt":"do stuff"}',
    };

    const messages = asChat([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [agentBlock]),
    ]);

    const usage1: Record<string, any> = {
      'agent-1': {
        contextTokens: 100,
        contextWindow: 200000,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        apiCalls: 1,
        toolUses: 2,
        durationMs: 500,
        model: 'claude-opus-4-7',
      },
    };

    const cache = createEmptyTurnGroupCache();

    const result1 = computeIncrementalTurnGroups(
      'chat-1',
      messages,
      usage1,
      cache,
    );
    expect(result1).toHaveLength(1);

    // Same messages but agentUsage changed (more apiCalls)
    const usage2: Record<string, any> = {
      'agent-1': {
        ...usage1['agent-1'],
        apiCalls: 3,
        outputTokens: 150,
      },
    };

    const result2 = computeIncrementalTurnGroups(
      'chat-1',
      messages,
      usage2,
      cache,
    );

    expect(result2).toHaveLength(1);
    expect(result2[0].kind).toBe('turn-group');
    // Usage changed, so the cached group must NOT be reused
    expect(result2[0]).not.toBe(result1[0]);
  });

  it('returns fresh group when a late workflow result arrives on a completed turn', () => {
    const workflowBlock: Block = {
      type: 'tool_use',
      toolUseId: 'wf-1',
      toolName: 'Workflow',
      input: '{"script":"export const meta = { name: \'review\' }"}',
    };

    const messages = asChat([
      msg('u1', 'user', [textBlock('run the review workflow')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [workflowBlock]),
    ]);

    const cache = createEmptyTurnGroupCache();

    const result1 = computeIncrementalTurnGroups(
      'chat-1',
      messages,
      undefined,
      cache,
    );
    expect(result1).toHaveLength(1);
    expect(result1[0].kind).toBe('turn-group');

    // The Workflow launch receipt arrives in a later tool_result-only
    // message. mergeToolResults folds it into the earlier workflow block
    // without changing the group's message structure.
    const receipt =
      'Workflow launched in background.\n' +
      'Run ID: wf_abc123\n' +
      'Transcript dir: /tmp/wf-abc123\n' +
      'Summary: 3 phases queued';
    const withResult = asChat([
      ...messages,
      msg('r1', 'assistant', [
        {
          type: 'tool_result',
          toolUseId: 'wf-1',
          toolName: 'Workflow',
          output: receipt,
          isError: false,
        },
      ]),
    ]);

    const result2 = computeIncrementalTurnGroups(
      'chat-1',
      withResult,
      undefined,
      cache,
    );
    expect(result2).toHaveLength(1);
    expect(result2[0].kind).toBe('turn-group');
    // The workflow block gained a result — the cached group must NOT be
    // reused, otherwise the receipt renders stale forever.
    expect(result2[0]).not.toBe(result1[0]);
    if (result2[0].kind === 'turn-group') {
      const block = result2[0].assistantMessages[0].blocks[0] as {
        type: string;
        summary?: string;
        runId?: string;
        result?: { output: string; isError: boolean };
      };
      expect(block.type).toBe('workflow');
      expect(block.runId).toBe('wf_abc123');
      expect(block.summary).toBe('3 phases queued');
      expect(block.result?.output).toBe(receipt);
    }
  });

  it('reuses the cached group when a workflow block is unchanged', () => {
    const receipt =
      'Workflow launched in background.\n' +
      'Run ID: wf_abc123\n' +
      'Summary: 3 phases queued';
    const messages = asChat([
      msg('u1', 'user', [textBlock('run it')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [
        {
          type: 'tool_use',
          toolUseId: 'wf-1',
          toolName: 'Workflow',
          input: '{}',
        },
        {
          type: 'tool_result',
          toolUseId: 'wf-1',
          toolName: 'Workflow',
          output: receipt,
          isError: false,
        },
      ]),
      msg('u2', 'user', [textBlock('next turn')]),
    ]);

    const cache = createEmptyTurnGroupCache();
    const result1 = computeIncrementalTurnGroups(
      'chat-1',
      messages,
      undefined,
      cache,
    );
    const result2 = computeIncrementalTurnGroups(
      'chat-1',
      messages,
      undefined,
      cache,
    );
    expect(result2[0].kind).toBe('turn-group');
    expect(result2[0]).toBe(result1[0]);
  });

  it('returns fresh group when an unhandled block type changes content', () => {
    // Block types without dedicated comparison branches (markers like
    // automation_info) must still bust the cache when their content changes.
    const before = asChat([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [
        { type: 'automation_info', activityName: 'Nightly sync', timestamp: 1 },
      ] as Block[]),
    ]);
    const after = asChat([
      msg('u1', 'user', [textBlock('hello')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [
        { type: 'automation_info', activityName: 'Weekly sync', timestamp: 1 },
      ] as Block[]),
    ]);

    const cache = createEmptyTurnGroupCache();
    const result1 = computeIncrementalTurnGroups(
      'chat-1',
      before,
      undefined,
      cache,
    );
    expect(result1).toHaveLength(1);
    const result2 = computeIncrementalTurnGroups(
      'chat-1',
      after,
      undefined,
      cache,
    );
    expect(result2).toHaveLength(1);
    expect(result2[0]).not.toBe(result1[0]);
  });

  it('returns fresh group when a provider authFailure attaches to a completed text block (CAN-1814)', () => {
    // Provider-level auth failures (no toolUseId) attach to the last `text`
    // block via `attachAuthFailureToBlocks`/`attachAuthFailureToMessages`
    // (event-transforms.ts) without changing that block's `text`. The
    // text-block branch of `blocksMatch` must treat this as a real content
    // change, or a completed turn group cached before the follow-up
    // `canopy_auth_failure` event arrives will reuse the stale (no
    // authFailure) object forever and the reconnect CTA never renders.
    const authFailure: AuthDependencyFailure = {
      dependencyClass: 'provider',
      dependencyId: 'claude',
      displayName: 'Claude',
      failureClass: 'unauthenticated',
      recovery: { kind: 'provider_terminal', provider: 'claude' },
    };

    const messages = asChat([
      msg('u1', 'user', [textBlock('do the thing')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [
        { type: 'text', text: "You're not signed in to Claude." },
      ]),
    ]);

    const cache = createEmptyTurnGroupCache();
    const result1 = computeIncrementalTurnGroups(
      'chat-1',
      messages,
      undefined,
      cache,
    );
    expect(result1).toHaveLength(1);
    expect(result1[0].kind).toBe('turn-group');
    if (result1[0].kind === 'turn-group') {
      const block = result1[0].assistantMessages[0].blocks[0];
      expect(block.type === 'text' && block.authFailure).toBeFalsy();
    }

    // Same text, but the follow-up canopy_auth_failure event has now
    // attached the structured failure — exactly what
    // attachAuthFailureToMessages produces.
    const withAuthFailure = asChat([
      msg('u1', 'user', [textBlock('do the thing')]),
      msg('t1', 'system', [timerBlock(100, 200)]),
      msg('a1', 'assistant', [
        {
          type: 'text',
          text: "You're not signed in to Claude.",
          authFailure,
        },
      ]),
    ]);

    const result2 = computeIncrementalTurnGroups(
      'chat-1',
      withAuthFailure,
      undefined,
      cache,
    );
    expect(result2).toHaveLength(1);
    expect(result2[0].kind).toBe('turn-group');
    // The text block gained an authFailure — the cached group must NOT be
    // reused, otherwise the reconnect CTA never renders.
    expect(result2[0]).not.toBe(result1[0]);
    if (result2[0].kind === 'turn-group') {
      const block = result2[0].assistantMessages[0].blocks[0];
      expect(block.type === 'text' && block.authFailure).toEqual(authFailure);
    }
  });
});
