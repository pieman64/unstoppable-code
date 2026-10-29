import type { BackgroundProcess } from '@canopy/desktop-shared/types';
import type {
  TurnGroup,
  TurnMessage,
} from '@canopy/desktop-shared/lib/turn-utils';

jest.mock('@/stores/activityStore', () => ({
  useActivityStore: jest.fn(),
}));

import {
  createTurnToolUseIdCache,
  groupBackgroundProcessesByTurn,
  turnToolUseIds,
} from '../turn-background-processes';

function assistantMessage(
  id: string,
  blocks: TurnMessage['blocks'],
): TurnMessage {
  return { id, role: 'assistant', blocks, timestamp: 0 };
}

function turnGroup(
  userMessageId: string,
  assistantMessages: TurnMessage[],
): TurnGroup {
  return {
    kind: 'turn-group',
    userMessage: {
      id: userMessageId,
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }],
      timestamp: 0,
    },
    assistantMessages,
    timerMessage: {
      id: `${userMessageId}-timer`,
      role: 'system',
      blocks: [{ type: 'turn_timer', completedAt: 1 }],
      timestamp: 1,
    },
    isComplete: true,
  };
}

function backgroundProcess(
  overrides: Partial<BackgroundProcess> & { toolUseId: string },
): BackgroundProcess {
  return {
    id: overrides.toolUseId,
    chatId: 'chat-1',
    toolUseId: overrides.toolUseId,
    toolName: 'Bash',
    kind: 'bash',
    description: 'npm run dev',
    status: 'running',
    startedAt: 0,
    updatedAt: 0,
    outputLines: [],
    canStop: true,
    ...overrides,
  };
}

describe('turnToolUseIds', () => {
  it('collects plain, agent, workflow, and nested subagent tool uses', () => {
    const ids = turnToolUseIds([
      assistantMessage('m1', [
        {
          type: 'tool_use',
          toolUseId: 'bash-1',
          toolName: 'Bash',
          input: '{}',
        },
      ]),
      assistantMessage('m2', [
        {
          type: 'agent',
          toolUseId: 'agent-1',
          subagentType: 'Explore',
          description: 'Search',
          prompt: 'Search the repo',
          runInBackground: true,
          subBlocks: [
            {
              type: 'tool_use',
              toolUseId: 'nested-bash-1',
              toolName: 'Bash',
              input: '{}',
            },
          ],
        },
      ]),
      assistantMessage('m3', [
        {
          type: 'workflow',
          toolUseId: 'workflow-1',
          workflowName: 'review-changes',
          summary: 'Review',
        },
      ]),
    ]);

    expect([...ids].sort()).toEqual([
      'agent-1',
      'bash-1',
      'nested-bash-1',
      'workflow-1',
    ]);
  });

  it('ignores blocks without a tool-use identity', () => {
    const ids = turnToolUseIds([
      assistantMessage('m1', [
        { type: 'text', text: 'hello' },
        { type: 'turn_timer', completedAt: 1 },
      ]),
    ]);
    expect(ids.size).toBe(0);
  });
});

describe('groupBackgroundProcessesByTurn', () => {
  const firstTurn = turnGroup('turn-1', [
    assistantMessage('a1', [
      { type: 'tool_use', toolUseId: 'bash-1', toolName: 'Bash', input: '{}' },
    ]),
  ]);
  const secondTurn = turnGroup('turn-2', [
    assistantMessage('a2', [
      { type: 'tool_use', toolUseId: 'bash-2', toolName: 'Bash', input: '{}' },
    ]),
  ]);
  const groups = [firstTurn, secondTurn];

  it('attributes each process to the turn that launched it', () => {
    const byTurn = groupBackgroundProcessesByTurn(
      groups,
      [
        backgroundProcess({ toolUseId: 'bash-1' }),
        backgroundProcess({ toolUseId: 'bash-2' }),
      ],
      'chat-1',
      createTurnToolUseIdCache(),
    );
    expect(byTurn['turn-1']?.map((entry) => entry.toolUseId)).toEqual([
      'bash-1',
    ]);
    expect(byTurn['turn-2']?.map((entry) => entry.toolUseId)).toEqual([
      'bash-2',
    ]);
  });

  it('ignores processes belonging to another chat', () => {
    const byTurn = groupBackgroundProcessesByTurn(
      groups,
      [backgroundProcess({ toolUseId: 'bash-1', chatId: 'other-chat' })],
      'chat-1',
      createTurnToolUseIdCache(),
    );
    expect(byTurn).toEqual({});
  });

  it('leaves background agents to the dedicated subagent UX while keeping other kinds', () => {
    const agentTurn = turnGroup('turn-agent', [
      assistantMessage('a3', [
        {
          type: 'agent',
          toolUseId: 'agent-1',
          subagentType: 'Explore',
          description: 'Search',
          prompt: 'Search the repo',
          runInBackground: true,
          subBlocks: [],
        },
        {
          type: 'agent',
          toolUseId: 'task-1',
          subagentType: 'general-purpose',
          description: 'Legacy Task launch',
          prompt: 'Do the thing',
          runInBackground: true,
          subBlocks: [],
        },
        {
          type: 'tool_use',
          toolUseId: 'bash-3',
          toolName: 'Bash',
          input: '{}',
        },
        {
          type: 'workflow',
          toolUseId: 'workflow-1',
          workflowName: 'review-changes',
          summary: 'Review',
        },
      ]),
    ]);
    const byTurn = groupBackgroundProcessesByTurn(
      [agentTurn],
      [
        backgroundProcess({
          toolUseId: 'agent-1',
          toolName: 'Agent',
          kind: 'agent',
        }),
        backgroundProcess({
          toolUseId: 'task-1',
          toolName: 'Task',
          kind: 'task',
        }),
        backgroundProcess({ toolUseId: 'bash-3' }),
        backgroundProcess({
          toolUseId: 'workflow-1',
          toolName: 'Workflow',
          kind: 'workflow',
        }),
      ],
      'chat-1',
      createTurnToolUseIdCache(),
    );
    expect(byTurn['turn-agent']?.map((entry) => entry.toolUseId)).toEqual([
      'bash-3',
      'workflow-1',
    ]);
  });

  it('returns the shared empty record when a chat only has background agents', () => {
    const empty = groupBackgroundProcessesByTurn(
      groups,
      [],
      'chat-1',
      createTurnToolUseIdCache(),
    );
    const agentsOnly = groupBackgroundProcessesByTurn(
      groups,
      [
        backgroundProcess({
          toolUseId: 'bash-1',
          toolName: 'Agent',
          kind: 'agent',
        }),
      ],
      'chat-1',
      createTurnToolUseIdCache(),
    );
    expect(agentsOnly).toBe(empty);
  });

  it('returns one shared empty record and never walks a turn when there are no processes', () => {
    const cache = createTurnToolUseIdCache();
    const first = groupBackgroundProcessesByTurn(groups, [], 'chat-1', cache);
    const second = groupBackgroundProcessesByTurn(groups, [], 'chat-1', cache);
    expect(first).toBe(second);
    // The hot path must not even look at a turn's blocks.
    expect(cache.get(firstTurn.assistantMessages)).toBeUndefined();
  });

  it('reuses a cached tool-use set for turns whose messages are unchanged', () => {
    const cache = createTurnToolUseIdCache();
    groupBackgroundProcessesByTurn(
      groups,
      [backgroundProcess({ toolUseId: 'bash-1' })],
      'chat-1',
      cache,
    );
    const cached = cache.get(firstTurn.assistantMessages);
    expect(cached).toBeDefined();
    groupBackgroundProcessesByTurn(
      groups,
      [backgroundProcess({ toolUseId: 'bash-1', outputLines: ['tick'] })],
      'chat-1',
      cache,
    );
    expect(cache.get(firstTurn.assistantMessages)).toBe(cached);
  });
});
