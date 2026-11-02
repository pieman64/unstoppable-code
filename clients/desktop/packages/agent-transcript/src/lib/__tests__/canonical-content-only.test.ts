import type { PersistedChatMessage } from '../../types';
import {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  pauseOpenTurnTimer,
  resumePausedTurnTimer,
  type TranscriptReducerOptions,
  type TranscriptReducerState,
} from '../transcript-parser';

const historical: TranscriptReducerOptions = {
  childToolLiveness: { kind: 'unknown' },
  now: 4_000,
  createMessageId: () => 'synthesized',
};
const canonical: TranscriptReducerOptions = {
  ...historical,
  rootTurnMode: 'canonical-content-only',
};

function state(
  status: TranscriptReducerState['status'],
  messages: PersistedChatMessage[],
): TranscriptReducerState {
  return { status, error: null, planMode: false, messages };
}

const prompt: PersistedChatMessage = {
  id: 'user',
  role: 'user',
  timestamp: 1_000,
  blocks: [{ type: 'text', text: 'Investigate' }],
};

function timerRow(completedAt: number | null): PersistedChatMessage {
  return {
    id: 'T:timer',
    role: 'system',
    timestamp: 1_000,
    blocks: [
      { type: 'turn_timer', turnId: 'T', startedAt: 1_000, completedAt },
    ],
  };
}

function timerRows(next: TranscriptReducerState): PersistedChatMessage[] {
  return next.messages.filter((message) =>
    message.blocks.some((block) => block.type === 'turn_timer'),
  );
}

describe('canonical content-only root turn mode', () => {
  it('does not open a root timer or change root status when a Codex turn starts', () => {
    const before = state('idle', [prompt]);
    const event = { type: 'turn.started' };

    expect(applyCodexTranscriptEvent(before, event, historical).status).toBe(
      'streaming',
    );
    const next = applyCodexTranscriptEvent(before, event, canonical);
    expect(timerRows(next)).toEqual([]);
    expect(next.status).toBe('idle');
  });

  it('leaves the canonical timer open and root status unchanged when a Codex turn completes', () => {
    const before = state('streaming', [prompt, timerRow(null)]);
    const event = { type: 'turn.completed' };

    expect(
      timerRows(applyCodexTranscriptEvent(before, event, historical))[0]
        ?.blocks[0],
    ).toMatchObject({ completedAt: 4_000 });
    const next = applyCodexTranscriptEvent(before, event, canonical);
    expect(timerRows(next)).toEqual([timerRow(null)]);
    expect(next.status).toBe('streaming');
  });

  it('still folds Codex content while leaving timers alone', () => {
    const before = state('streaming', [prompt, timerRow(null)]);
    const next = applyCodexTranscriptEvent(
      before,
      {
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'Found it' },
      },
      canonical,
    );
    expect(timerRows(next)).toEqual([timerRow(null)]);
    expect(JSON.stringify(next.messages)).toContain('Found it');
  });

  it('does not reopen a settled timer when Claude work arrives after it', () => {
    const before = state('streaming', [prompt, timerRow(2_000)]);
    const event = {
      type: 'assistant',
      uuid: 'new',
      canopy_turn_user_message_id: 'user',
      message: {
        id: 'work',
        content: [{ type: 'text', text: 'Following up' }],
      },
    };

    expect(
      timerRows(applyClaudeTranscriptEvent(before, event, historical))[0]
        ?.blocks[0],
    ).toMatchObject({ completedAt: null });
    const next = applyClaudeTranscriptEvent(before, event, canonical);
    expect(timerRows(next)).toEqual([timerRow(2_000)]);
    expect(JSON.stringify(next.messages)).toContain('Following up');
  });
});

describe('canonical timers change only through turn effects', () => {
  it('leaves a canonical timer alone when a legacy writer pauses or resumes', () => {
    const open = [prompt, timerRow(null)];
    expect(pauseOpenTurnTimer(open, 2_000, 'approval')).toBe(open);

    const paused: PersistedChatMessage[] = [
      prompt,
      {
        ...timerRow(null),
        blocks: [
          {
            type: 'turn_timer',
            turnId: 'T',
            startedAt: 1_000,
            pausedAt: 2_000,
            resumedAt: null,
            pauseOwnerIds: ['approval'],
            completedAt: null,
          },
        ],
      },
    ];
    expect(resumePausedTurnTimer(paused, 3_000, 'approval')).toBe(paused);
  });
});
