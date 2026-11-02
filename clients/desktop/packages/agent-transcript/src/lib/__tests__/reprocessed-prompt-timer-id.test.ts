import type { PersistedChatMessage } from '../../types';
import {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  type TranscriptReducerOptions,
  type TranscriptReducerState,
} from '../transcript-parser';

const CHAT_ID = 'chat-1';
const PROMPT_ID = 'watcher-delivery-1';
const MUTATION_ID = `${CHAT_ID}:${PROMPT_ID}:user-prompt`;
/** Main mints synthetic ids as `${chatId}:${mutationId}:${sequence}`. */
const HISTORICAL_TIMER_ID = `${CHAT_ID}:${MUTATION_ID}:0`;

function mainStyleOptions(now: number): TranscriptReducerOptions {
  let sequence = 0;
  return {
    childToolLiveness: { kind: 'unknown' },
    now,
    createMessageId: () => `${CHAT_ID}:${MUTATION_ID}:${sequence++}`,
  };
}

const prompt: PersistedChatMessage = {
  id: PROMPT_ID,
  role: 'user',
  timestamp: 1_000,
  blocks: [{ type: 'text', text: 'Watcher fired' }],
};

const historicalTimer: PersistedChatMessage = {
  id: HISTORICAL_TIMER_ID,
  role: 'system',
  timestamp: 1_000,
  blocks: [{ type: 'turn_timer', startedAt: 1_000, completedAt: 4_000 }],
};

/**
 * A watcher delivery replayed days later: the prompt row is already in the
 * transcript, and main's `mergePromptMessages` has moved it to the end. Its
 * original turn timer (minted from the same mutation id) is still in place.
 */
function reorderedReplayState(): TranscriptReducerState {
  return {
    status: 'idle',
    error: null,
    planMode: false,
    messages: [
      {
        id: 'earlier-user',
        role: 'user',
        timestamp: 500,
        blocks: [{ type: 'text', text: 'Earlier' }],
      },
      historicalTimer,
      {
        id: 'answer',
        role: 'assistant',
        timestamp: 3_000,
        blocks: [{ type: 'text', text: 'Handled it' }],
      },
      {
        id: 'later-user',
        role: 'user',
        timestamp: 5_000,
        blocks: [{ type: 'text', text: 'Later' }],
      },
      {
        id: 'later-timer',
        role: 'system',
        timestamp: 5_000,
        blocks: [{ type: 'turn_timer', startedAt: 5_000, completedAt: 6_000 }],
      },
      prompt,
    ],
  };
}

const promptEvent = {
  type: 'canopy_user_prompt',
  original_text: 'Watcher fired',
  canopy_turn_user_message_id: PROMPT_ID,
  provider: 'claude',
};

function expectUniqueIds(messages: readonly PersistedChatMessage[]): void {
  const ids = messages.map((message) => message.id);
  expect(new Set(ids).size).toBe(ids.length);
}

describe('re-processed user prompt turn timers', () => {
  it('preserves one open Codex turn when its prompt is replayed', () => {
    const openTimer: PersistedChatMessage = {
      ...historicalTimer,
      blocks: [{ type: 'turn_timer', startedAt: 1_000, completedAt: null }],
    };
    const messages = [
      prompt,
      openTimer,
      {
        id: 'partial-answer',
        role: 'assistant' as const,
        timestamp: 2_000,
        blocks: [{ type: 'text' as const, text: 'Working on it' }],
      },
    ];
    const next = applyCodexTranscriptEvent(
      { ...reorderedReplayState(), status: 'streaming', messages },
      { ...promptEvent, provider: 'codex' },
      mainStyleOptions(3_000),
    );

    expect(
      next.messages
        .flatMap((message) => message.blocks)
        .filter(
          (block) => block.type === 'turn_timer' && block.completedAt === null,
        ),
    ).toHaveLength(1);
    expect(next.messages).toEqual(messages);
    expectUniqueIds(next.messages);
  });

  it('mints the new turn timer past an id that already belongs to a settled timer', () => {
    const state = reorderedReplayState();
    const next = applyClaudeTranscriptEvent(
      state,
      promptEvent,
      mainStyleOptions(9_000),
    );

    expectUniqueIds(next.messages);
    // Settled history is left exactly as it was.
    expect(
      next.messages.find((message) => message.id === HISTORICAL_TIMER_ID),
    ).toEqual(historicalTimer);
    expect(next.messages.slice(0, -1)).toEqual(state.messages);
    const timer = next.messages[next.messages.length - 1];
    expect(timer.id).toBe(`${CHAT_ID}:${MUTATION_ID}:1`);
    expect(timer.blocks).toEqual([
      { type: 'turn_timer', startedAt: 9_000, completedAt: null },
    ]);
  });

  it('keeps the deterministic first id when nothing collides', () => {
    const state = reorderedReplayState();
    const next = applyClaudeTranscriptEvent(
      {
        ...state,
        messages: state.messages.filter(
          (message) => message.id !== HISTORICAL_TIMER_ID,
        ),
      },
      promptEvent,
      mainStyleOptions(9_000),
    );
    expect(next.messages[next.messages.length - 1].id).toBe(
      HISTORICAL_TIMER_ID,
    );
  });

  it('moves an existing prompt row to the dispatch position instead of appending a second copy', () => {
    // No host merge ran (JSONL replay / renderer): the prompt is mid-history.
    const state = reorderedReplayState();
    const withoutPrompt = state.messages.slice(0, -1);
    const messages = [
      ...withoutPrompt.slice(0, 1),
      prompt,
      ...withoutPrompt.slice(1),
    ];
    const next = applyClaudeTranscriptEvent(
      { ...state, messages },
      promptEvent,
      mainStyleOptions(9_000),
    );

    expectUniqueIds(next.messages);
    expect(next.messages.slice(0, -2)).toEqual(withoutPrompt);
    expect(next.messages[next.messages.length - 2]).toEqual(prompt);
    expect(next.messages[next.messages.length - 1].blocks).toEqual([
      { type: 'turn_timer', startedAt: 9_000, completedAt: null },
    ]);
  });

  it('never duplicates the prompt or timer in the Codex replay reducer', () => {
    const state = reorderedReplayState();
    const next = applyCodexTranscriptEvent(
      state,
      { ...promptEvent, provider: 'codex' },
      mainStyleOptions(9_000),
    );

    expectUniqueIds(next.messages);
    expect(
      next.messages.find((message) => message.id === HISTORICAL_TIMER_ID),
    ).toEqual(historicalTimer);
    expect(
      next.messages.filter((message) => message.id === PROMPT_ID),
    ).toHaveLength(1);
  });
});
