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
