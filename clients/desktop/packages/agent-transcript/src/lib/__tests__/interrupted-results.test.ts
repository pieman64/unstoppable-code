import { mergeToolResults } from '../message-transforms';
import { isClaudeAgentRunning } from '../agent-block-state';
import { blockFingerprint } from '../transcript-fingerprint';
import type { PersistedChatMessage } from '../../types';

const call: PersistedChatMessage = {
  id: 'call',
  role: 'assistant',
  timestamp: 150,
  blocks: [
    { type: 'tool_use', toolUseId: 'edit', toolName: 'Edit', input: '{}' },
  ],
};
const result: PersistedChatMessage = {
  id: 'archive-cancel-180-0',
  role: 'system',
  timestamp: 180,
  blocks: [
    {
      type: 'tool_result',
      toolUseId: 'edit',
      toolName: 'Edit',
      output: 'Interrupted by app restart',
      isError: true,
    },
  ],
};

it('keeps interruption metadata in the content fingerprint', () => {
  const block = result.blocks[0];
  if (block.type !== 'tool_result') throw new Error('Invalid result fixture');
  expect(
    blockFingerprint({
      ...block,
      interruption: { reason: 'app_restart', at: 180 },
    }),
  ).not.toBe(blockFingerprint(block));
});

it('projects only known synthetic legacy carriers as interrupted on desktop', () => {
  expect(mergeToolResults([call, result])[0]?.blocks[0]).toMatchObject({
    result: { interruption: { reason: 'app_restart', at: 180 } },
  });
  expect(
    mergeToolResults([call, { ...result, id: 'real' }])[0]?.blocks[0],
  ).not.toHaveProperty('result.interruption');
});

it('matches later results only to calls in their owning user turn', () => {
  const messages: PersistedChatMessage[] = [
    {
      id: 'user-1',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: 'Old work' }],
    },
    call,
    result,
    {
      id: 'user-2',
      role: 'user',
      timestamp: 500,
      blocks: [{ type: 'text', text: 'New work' }],
    },
    { ...call, id: 'new-call', timestamp: 510 },
    {
      ...result,
      id: 'real',
      timestamp: 520,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'edit',
          toolName: 'Edit',
          output: 'saved',
          isError: false,
        },
      ],
    },
  ];
  const display = mergeToolResults(messages);
  expect(
    display.find((message) => message.id === 'call')?.blocks[0],
  ).toMatchObject({
    result: { isError: true, interruption: { reason: 'app_restart' } },
  });
  expect(
    display.find((message) => message.id === 'new-call')?.blocks[0],
  ).toMatchObject({ result: { output: 'saved', isError: false } });
});

it('keeps a genuine outcome even when a synthetic carrier is later in the transcript', () => {
  const real: PersistedChatMessage = {
    ...result,
    id: 'real',
    blocks: [
      {
        type: 'tool_result',
        toolUseId: 'edit',
        toolName: 'Edit',
        output: 'saved',
        isError: false,
      },
    ],
  };
  expect(mergeToolResults([call, real, result])[0]?.blocks[0]).toMatchObject({
    result: { output: 'saved', isError: false },
  });
});

it('keeps a resultless child pending when another thread reused its tool id', () => {
  const messages: PersistedChatMessage[] = [
    {
      id: 'parent',
      role: 'assistant',
      timestamp: 100,
      blocks: [
        {
          type: 'codex_agent_call',
          agentBlockId: 'pair',
          callId: 'pair',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'root',
          receiverThreadIds: ['a', 'b'],
          prompt: '',
          agentsStates: {},
        },
      ],
    },
    { ...call, id: 'child-call', parentBlockId: 'pair', codexThreadId: 'b' },
    {
      ...result,
      id: 'real',
      parentBlockId: 'pair',
      codexThreadId: 'a',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'edit',
          toolName: 'Edit',
          output: 'saved',
          isError: false,
        },
      ],
    },
  ];
  const parent = mergeToolResults(messages)[0]?.blocks[0];
  if (parent?.type !== 'codex_agent') throw new Error('Missing parent card');
  expect(parent.subBlocks[0]).not.toHaveProperty('result.output');
});

it.each(['parentToolUseId', 'parentBlockId'] as const)(
  'retains background child output across root turns through %s',
  (parentField) => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        timestamp: 100,
        blocks: [{ type: 'text', text: 'Start background work' }],
      },
      {
        id: 'parent',
        role: 'assistant',
        timestamp: 110,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'background-agent',
            toolName: 'Agent',
            input: '{"run_in_background":true}',
          },
        ],
      },
      { ...call, id: 'early-child', [parentField]: 'background-agent' },
      {
        id: 'user-2',
        role: 'user',
        timestamp: 200,
        blocks: [{ type: 'text', text: 'Meanwhile do something else' }],
      },
      { ...call, id: 'new-root-call', timestamp: 210 },
      {
        id: 'late-child',
        role: 'assistant',
        timestamp: 220,
        [parentField]: 'background-agent',
        blocks: [
          { type: 'text', text: 'Background work completed' },
          {
            type: 'tool_result',
            toolUseId: 'edit',
            toolName: 'Edit',
            output: 'background edit saved',
            isError: false,
          },
        ],
      },
    ];
    const display = mergeToolResults(messages);
    const parent = display.find((message) => message.id === 'parent')
      ?.blocks[0];
    if (parent?.type !== 'agent') throw new Error('Missing parent card');
    expect(parent.subBlocks).toContainEqual({
      type: 'text',
      text: 'Background work completed',
    });
    expect(
      parent.subBlocks.find((block) => block.type === 'tool_use'),
    ).toMatchObject({
      toolUseId: 'edit',
      result: { output: 'background edit saved' },
    });
    expect(
      display.find((message) => message.id === 'new-root-call')?.blocks[0],
    ).not.toHaveProperty('result.output');
  },
);

it.each([
  ['abc123', false],
  ['abc123', true],
  ['launch', false],
  ['launch', true],
] as const)(
  'attaches a later-turn TaskOutput for %s (error=%s)',
  (taskId, isError) => {
    const outcome = {
      output: isError ? 'Background task failed' : 'Background task completed',
      isError,
    };
    const display = mergeToolResults([
      {
        id: 'first-user',
        role: 'user',
        timestamp: 100,
        blocks: [{ type: 'text', text: 'Start background work' }],
      },
      {
        id: 'launch-message',
        role: 'assistant',
        timestamp: 110,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'launch',
            toolName: 'Agent',
            input: '{"run_in_background":true}',
          },
          {
            type: 'tool_result',
            toolUseId: 'launch',
            toolName: 'Agent',
            output: 'Async agent launched successfully. agentId: abc123',
            isError: false,
          },
        ],
      },
      {
        id: 'second-user',
        role: 'user',
        timestamp: 200,
        blocks: [{ type: 'text', text: 'Retrieve background output' }],
      },
      {
        id: 'retrieve',
        role: 'assistant',
        timestamp: 210,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'retrieve',
            toolName: 'TaskOutput',
            input: JSON.stringify({ task_id: taskId }),
          },
        ],
      },
      {
        id: 'retrieved',
        role: 'system',
        timestamp: 220,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'retrieve',
            toolName: 'TaskOutput',
            ...outcome,
          },
        ],
      },
    ]);
    const agent = display.find((row) => row.id === 'launch-message')?.blocks[0];
    if (agent?.type !== 'agent') throw new Error('Missing launched agent');
    expect(agent.taskOutputResult).toMatchObject(outcome);
    expect(
      isClaudeAgentRunning(
        agent.runInBackground,
        agent.result,
        agent.taskOutputResult,
      ),
    ).toBe(false);
    expect(
      display
        .flatMap((row) => row.blocks)
        .some(
          (block) =>
            block.type === 'tool_use' && block.toolName === 'TaskOutput',
        ),
    ).toBe(false);
  },
);
