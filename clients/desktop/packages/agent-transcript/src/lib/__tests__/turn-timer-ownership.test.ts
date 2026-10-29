import type { PersistedChatMessage } from '../../types';
import {
  applyClaudeTranscriptEvent,
  type TranscriptReducerState,
  pauseOpenTurnTimer,
  resumePausedTurnTimer,
} from '../transcript-parser';

it('pauses and releases the visible turn timer across a hidden continuation prompt', () => {
  const messages: PersistedChatMessage[] = [
    {
      id: 'visible-user',
      role: 'user',
      timestamp: 1_000,
      blocks: [{ type: 'text', text: 'Review the change' }],
    },
    {
      id: 'visible-timer',
      role: 'system',
      timestamp: 1_000,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: 1_000,
          completedAt: null,
        },
      ],
    },
    {
      id: 'hidden-continuation',
      role: 'user',
      hidden: true,
      timestamp: 2_000,
      blocks: [{ type: 'text', text: 'Delegated work completed' }],
    },
  ];

  const paused = pauseOpenTurnTimer(messages, 3_000, 'approval:pending');
  const resumed = resumePausedTurnTimer(paused, 4_000, 'approval:pending');

  expect(resumed[1]?.blocks[0]).toEqual({
    type: 'turn_timer',
    startedAt: 1_000,
    completedAt: null,
    pausedAt: 3_000,
    resumedAt: 4_000,
    accumulatedPausedDurationMs: 1_000,
  });
});

function completedState(status: 'idle' | 'streaming'): TranscriptReducerState {
  return {
    status,
    error: null,
    planMode: false,
    messages: [
      {
        id: 'user',
        role: 'user',
        timestamp: 1000,
        blocks: [{ type: 'text', text: 'Investigate' }],
      },
      {
        id: 'timer',
        role: 'system',
        timestamp: 1000,
        blocks: [{ type: 'turn_timer', startedAt: 1000, completedAt: 2000 }],
      },
      {
        id: 'prior',
        role: 'assistant',
        claudeUuid: 'seen',
        timestamp: 2000,
        blocks: [{ type: 'text', text: 'Done' }],
      },
    ],
  };
}

it('repairs a completed timer when fresh foreground work arrives while runtime already says streaming', () => {
  const state = completedState('streaming');
  const next = applyClaudeTranscriptEvent(
    state,
    {
      type: 'assistant',
      uuid: 'new',
      canopy_turn_user_message_id: 'user',
      message: {
        id: 'work',
        content: [{ type: 'thinking', thinking: 'Following up' }],
      },
    },
    { now: 4000, createMessageId: () => 'new' },
  );
  expect(next.messages[1].blocks[0]).toMatchObject({
    completedAt: null,
    startedAt: 1000,
  });
});

it('keeps one timer when foreground work arrives while the turn timer is paused for approval', () => {
  const state: TranscriptReducerState = {
    ...completedState('streaming'),
    messages: pauseOpenTurnTimer(
      [
        {
          id: 'user',
          role: 'user',
          timestamp: 1000,
          blocks: [{ type: 'text', text: 'Investigate' }],
        },
        {
          id: 'timer',
          role: 'system',
          timestamp: 1000,
          blocks: [{ type: 'turn_timer', startedAt: 1000, completedAt: null }],
        },
      ],
      3000,
      'approval:pending',
    ),
  };
  const next = applyClaudeTranscriptEvent(
    state,
    {
      type: 'assistant',
      uuid: 'new',
      canopy_turn_user_message_id: 'user',
      message: {
        id: 'work',
        content: [{ type: 'tool_use', id: 'watch', name: 'WatchDelegates' }],
      },
    },
    { now: 4000, createMessageId: () => 'new-timer' },
  );
  const timers = next.messages.flatMap((message) =>
    message.blocks.filter((block) => block.type === 'turn_timer'),
  );
  expect(timers).toHaveLength(1);
  expect(timers[0]).toMatchObject({ startedAt: 1000, pausedAt: 3000 });
});

it('still repairs the current turn timer when an earlier turn left a timer paused', () => {
  const earlierTurn = pauseOpenTurnTimer(
    [
      {
        id: 'earlier-user',
        role: 'user',
        timestamp: 100,
        blocks: [{ type: 'text', text: 'Earlier request' }],
      },
      {
        id: 'earlier-timer',
        role: 'system',
        timestamp: 100,
        blocks: [{ type: 'turn_timer', startedAt: 100, completedAt: null }],
      },
    ],
    200,
    'approval:abandoned',
  );
  const state: TranscriptReducerState = {
    ...completedState('streaming'),
    messages: [...earlierTurn, ...completedState('streaming').messages],
  };
  const next = applyClaudeTranscriptEvent(
    state,
    {
      type: 'assistant',
      uuid: 'new',
      canopy_turn_user_message_id: 'user',
      message: {
        id: 'work',
        content: [{ type: 'thinking', thinking: 'Following up' }],
      },
    },
    { now: 4000, createMessageId: () => 'new-timer' },
  );
  expect(next.messages[3].blocks[0]).toMatchObject({
    startedAt: 1000,
    completedAt: null,
  });
});

it.each([
  {
    type: 'assistant',
    parent_tool_use_id: 'child',
    message: { content: [{ type: 'text', text: 'Child update' }] },
  },
  {
    type: 'assistant',
    uuid: 'seen',
    message: { id: 'prior', content: [{ type: 'text', text: 'Done' }] },
  },
  {
    type: 'assistant',
    canopy_turn_user_message_id: 'older-user',
    message: { content: [{ type: 'text', text: 'Stale update' }] },
  },
  {
    type: 'assistant',
    error: 'authentication_failed',
    message: { content: [{ type: 'text', text: 'Connection expired' }] },
  },
  { type: 'system', subtype: 'task_progress' },
  { type: 'system', subtype: 'status' },
  {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'late-tool',
          content: 'Late result',
        },
      ],
    },
  },
  {
    type: 'assistant',
    error: 'rate_limit',
    message: { content: [{ type: 'text', text: 'Rate limited' }] },
  },
])(
  'does not reopen a completed timer for late non-foreground work: %j',
  (event) => {
    const next = applyClaudeTranscriptEvent(completedState('idle'), event, {
      now: 4000,
      createMessageId: () => 'late',
    });
    expect(next.messages[1].blocks[0]).toMatchObject({ completedAt: 2000 });
  },
);
