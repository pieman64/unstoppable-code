import type { ChatTab } from '../types';
import { selectMessagesForForkOrBranch } from '../tab-utils';

function tab(messages: ChatTab['messages']): ChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages,
    status: 'idle',
    error: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false, speed: 'standard' },
    fastModeExplicit: false,
  };
}

const timer = (id: string, timestamp: number): ChatTab['messages'][number] => ({
  id,
  role: 'system',
  blocks: [
    { type: 'turn_timer', startedAt: timestamp, completedAt: timestamp + 1 },
  ],
  timestamp,
});

describe('selectMessagesForForkOrBranch', () => {
  it('keeps input folded into the forked turn and cuts at the next turn', () => {
    const source = tab([
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'First' }],
        timestamp: 1,
      },
      timer('timer-1', 2),
      {
        id: 'a1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Working' }],
        timestamp: 3,
      },
      {
        id: 'steer',
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: 'Also check this',
            steering: { startsTurn: false, rootUserMessageId: 'u1' },
          },
        ],
        timestamp: 4,
      },
      {
        id: 'answer',
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: 'Yes',
            asyncQuestionAnswer: {
              requestId: 'question-1',
              startsTurn: false,
              answers: [],
            },
          },
        ],
        timestamp: 5,
      },
      {
        id: 'a2',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Done' }],
        timestamp: 6,
      },
      {
        id: 'u2',
        role: 'user',
        blocks: [{ type: 'text', text: 'Second' }],
        timestamp: 7,
      },
      timer('timer-2', 8),
    ]);

    const selection = selectMessagesForForkOrBranch(source, {
      forkAfterUserMessageId: 'u1',
    });

    expect(selection?.truncated).toBe(true);
    expect(selection?.messagesToClone.map((message) => message.id)).toEqual([
      'u1',
      'timer-1',
      'a1',
      'steer',
      'answer',
      'a2',
    ]);
  });
});

it('cuts each reply before the next background wake and can select a wake reply', () => {
  const source = tab([
    {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Run tests' }],
      timestamp: 1,
    },
    timer('t1', 2),
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Tests running' }],
      timestamp: 3,
    },
    {
      ...timer('wake-timer-1', 4),
      blocks: [
        {
          type: 'turn_timer',
          turnId: 'wake-1',
          spawnedBy: {},
          startedAt: 4,
          completedAt: 5,
        },
      ],
    },
    {
      id: 'a2',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Tests passed' }],
      timestamp: 5,
    },
    {
      ...timer('wake-timer-2', 6),
      blocks: [
        {
          type: 'turn_timer',
          turnId: 'wake-2',
          spawnedBy: {},
          startedAt: 6,
          completedAt: 7,
        },
      ],
    },
    {
      id: 'a3',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Review passed' }],
      timestamp: 7,
    },
  ]);
  expect(
    selectMessagesForForkOrBranch(source, {
      forkAfterUserMessageId: 'u1',
    })?.messagesToClone.map((m) => m.id),
  ).toEqual(['u1', 't1', 'a1']);
  expect(
    selectMessagesForForkOrBranch(source, {
      forkAfterUserMessageId: 'wake-timer-1',
    })?.messagesToClone.map((m) => m.id),
  ).toEqual(['u1', 't1', 'a1', 'wake-timer-1', 'a2']);
});

it('keeps ordinary resumed executions in the prompt but cuts before a tools-loaded continuation', () => {
  const source = tab([
    {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Load tools' }],
      timestamp: 1,
    },
    {
      ...timer('t1', 2),
      blocks: [
        {
          type: 'turn_timer',
          turnId: 'run-1',
          userMessageId: 'u1',
          startedAt: 2,
          completedAt: 3,
        },
      ],
    },
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'First execution' }],
      timestamp: 3,
    },
    {
      ...timer('t2', 4),
      blocks: [
        {
          type: 'turn_timer',
          turnId: 'run-2',
          userMessageId: 'u1',
          spawnedBy: {},
          startedAt: 4,
          completedAt: 5,
        },
      ],
    },
    {
      id: 'a2',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Resumed execution' }],
      timestamp: 5,
    },
    {
      ...timer('t3', 6),
      blocks: [
        {
          type: 'turn_timer',
          turnId: 'run-3',
          userMessageId: 'u1',
          spawnedBy: { toolsLoaded: true },
          startedAt: 6,
          completedAt: null,
        },
      ],
    },
  ]);
  source.status = 'streaming';
  expect(
    selectMessagesForForkOrBranch(source, {
      forkAfterUserMessageId: 'u1',
    })?.messagesToClone.map((m) => m.id),
  ).toEqual(['u1', 't1', 'a1', 't2', 'a2']);
  expect(
    selectMessagesForForkOrBranch(source, { forkAfterUserMessageId: 't3' }),
  ).toBeNull();
});

it('recognizes a wake whose recorded prompt is absent from the loaded transcript', () => {
  const source = tab([
    {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'First' }],
      timestamp: 1,
    },
    timer('t1', 2),
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'First reply' }],
      timestamp: 3,
    },
    {
      ...timer('wake', 4),
      blocks: [
        {
          type: 'turn_timer',
          turnId: 'wake-run',
          userMessageId: 'unavailable-prompt',
          spawnedBy: {},
          startedAt: 4,
          completedAt: 5,
        },
      ],
    },
    {
      id: 'a2',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Background reply' }],
      timestamp: 5,
    },
  ]);
  expect(
    selectMessagesForForkOrBranch(source, {
      forkAfterUserMessageId: 'u1',
    })?.messagesToClone.map((m) => m.id),
  ).toEqual(['u1', 't1', 'a1']);
});
