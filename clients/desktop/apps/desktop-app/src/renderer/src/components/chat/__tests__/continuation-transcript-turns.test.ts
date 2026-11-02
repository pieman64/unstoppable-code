import { computeTurnSummary } from '@canopy/desktop-shared/lib/turn-utils';
import type { TranscriptTurnSummary } from '@canopy/agent-transcript/transcript-storage';
import {
  activeContinuationPromptIds,
  continuationDiffOwners,
  continuationTranscriptTurns,
  promptTurnOwnerId,
} from '../continuation-transcript-turns';
import type { TurnGroup, TurnGroupOrMessage, TurnMessage } from '../types';

const summary = computeTurnSummary([]);

it("gives a tools-loaded continuation its own projection, paged through its prompt's turn", () => {
  const prompt: TranscriptTurnSummary = {
    id: 'u1',
    start: 0,
    end: 40,
    complete: true,
    summary,
    outcomes: { blocked: 0, failed: 0, interrupted: 0 },
    finalMessageIds: ['a-load'],
    files: [],
    deniedToolUseIds: ['push-1'],
    before: 30,
    continuations: {
      'turn-2:timer:wake': {
        complete: true,
        summary: { ...summary, bash: 20 },
        outcomes: { blocked: 0, failed: 1, interrupted: 0 },
        finalMessageIds: ['a-answer'],
        files: [{ path: 'report.md', state: 'ready' }],
      },
    },
  };

  const turns = continuationTranscriptTurns([prompt]);

  expect(turns.get('turn-2:timer:wake')).toEqual({
    // Its prompt's id and gap: history loads through the prompt's turn.
    id: 'u1',
    start: 0,
    end: 40,
    before: 30,
    // Its receipts name the prompt, so the prompt's denials apply.
    deniedToolUseIds: ['push-1'],
    complete: true,
    summary: { ...summary, bash: 20 },
    outcomes: { blocked: 0, failed: 1, interrupted: 0 },
    finalMessageIds: ['a-answer'],
    files: [{ path: 'report.md', state: 'ready' }],
  });
  expect(turns.size).toBe(1);
});

it("gives a prompt's diff to its last tools-loaded continuation", () => {
  const head = (
    id: string,
    block: TurnMessage['blocks'][number],
  ): TurnGroup => ({
    kind: 'turn-group',
    isComplete: true,
    userMessage: { id, role: 'system', timestamp: 1, blocks: [block] },
    assistantMessages: [],
    timerMessage: {
      id: `${id}-timer`,
      role: 'system',
      timestamp: 2,
      blocks: [{ type: 'turn_timer', completedAt: 2 }],
    },
  });
  const continuation = (id: string): TurnGroup =>
    head(id, {
      type: 'wake_boundary',
      turnId: id,
      spawningUserMessageId: 'u1',
      toolsLoaded: true,
    });
  const items: TurnGroupOrMessage[] = [
    {
      ...head('u1', { type: 'text', text: 'Load Slack' }),
      userMessage: {
        id: 'u1',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Load Slack' }],
      },
    },
    continuation('c1'),
    // A background wake isn't a continuation; its prompt keeps its diff.
    head('w1', {
      type: 'wake_boundary',
      turnId: 'w1',
      spawningUserMessageId: 'u1',
    }),
    continuation('c2'),
  ];

  const owners = continuationDiffOwners(items);
  expect(owners).toEqual(new Map([['u1', 'c2']]));
  // The last continuation's diff, Undo and reverted state are the prompt's,
  // so a reset through it reads as reverted there too.
  expect(
    items.map((item) =>
      item.kind === 'turn-group' ? promptTurnOwnerId(item, owners) : null,
    ),
  ).toEqual(['u1', 'c1', 'w1', 'u1']);
  // A prompt whose continuation still runs forks from its active session.
  expect(activeContinuationPromptIds(items)).toEqual(new Set());
  expect(
    activeContinuationPromptIds([
      ...items,
      { ...continuation('c3'), isComplete: false },
    ]),
  ).toEqual(new Set(['u1']));
});
