import { buildHandoffSummaryInputFromTranscript } from '@canopy/agent-transcript';
import {
  HANDOFF_CONVERSATION_TEXT_LIMIT,
  buildHandoffSummaryInput,
} from '../messages';
import type { ChatMessage } from '../types';

/**
 * The handoff summarizer input is capped so a long-lived chat cannot overflow
 * the summarizer prompt. Truncation must cut on real TURN boundaries: message
 * text carries its own markdown paragraph breaks, so slicing the joined string
 * on its first `\n\n` lands inside a turn and hands the model a fragment.
 */
function turn(role: 'user' | 'assistant', text: string): ChatMessage {
  return {
    id: `${role}-${text.length}-${Math.abs(text.charCodeAt(0))}`,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
  };
}

describe('buildHandoffSummaryInput', () => {
  it('returns the full conversation when it fits', () => {
    const result = buildHandoffSummaryInput([
      turn('user', 'Fix the archive spec'),
      turn('assistant', 'Done, it passes now.'),
    ]);

    expect(result).toBe(
      'User: Fix the archive spec\n\nAssistant: Done, it passes now.',
    );
    expect(result).not.toContain('Earlier turns omitted');
  });

  it('keeps the tail and never starts mid-message when truncating', () => {
    // Every assistant turn contains internal markdown paragraph breaks. A
    // string-slice implementation realigns on one of THOSE, so its first line
    // is a fragment rather than a labelled turn.
    // These lengths are chosen so the string-slice implementation's tail cut
    // lands INSIDE an assistant message ahead of one of its internal paragraph
    // breaks — its first retained line is then `Para three ccc…`, not a turn.
    const messages: ChatMessage[] = [];
    for (let index = 0; index < 60; index += 1) {
      messages.push(turn('user', `Question ${index} ${'q'.repeat(100)}`));
      messages.push(
        turn(
          'assistant',
          `Para one ${'a'.repeat(300)}\n\nPara two ${'b'.repeat(300)}\n\nPara three ${'c'.repeat(300)}`,
        ),
      );
    }

    const result = buildHandoffSummaryInput(messages);

    expect(result).toContain('Earlier turns omitted');
    const [notice, ...rest] = result.split('\n\n');
    expect(notice).toContain('Earlier turns omitted');
    // The first retained line must be a real turn label, not a mid-message
    // fragment such as 'Para two aaaa...'.
    expect(rest[0]).toMatch(/^(User|Assistant): /);
    // The most recent turn survives.
    expect(result).toContain('Para three');
    // The constant bounds the RETURNED STRING, notice included — not just the
    // turns inside it.
    expect(result.length).toBeLessThanOrEqual(HANDOFF_CONVERSATION_TEXT_LIMIT);
  });

  it('still carries content when a single turn exceeds the whole budget', () => {
    // Otherwise the notice alone would be the entire summarizer input.
    const huge = 'z'.repeat(HANDOFF_CONVERSATION_TEXT_LIMIT * 2);
    const result = buildHandoffSummaryInput([
      turn('user', 'short'),
      turn('assistant', huge),
    ]);

    expect(result).toContain('Earlier turns omitted');
    const body = result.split('\n\n').slice(1).join('\n\n');
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('z');
    // The fallback must respect the same cap as the normal path.
    expect(result.length).toBeLessThanOrEqual(HANDOFF_CONVERSATION_TEXT_LIMIT);
  });

  it('still ships real content when a short turn trails an oversized one', () => {
    // The `kept.length === 0` gate used to be the only top-up trigger, so a
    // short trailing turn after a turn bigger than the whole budget kept just
    // that one line and skipped the fallback entirely. The summarizer would get
    // the notice plus a sentence, return a plausible summary, and the
    // fail-closed guard would never trip.
    const messages: ChatMessage[] = [
      {
        id: 'huge',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'x'.repeat(60_000) }],
        timestamp: 1,
      },
      {
        id: 'policy',
        role: 'system',
        blocks: [
          {
            type: 'text',
            text: 'Your organization blocked Claude Sonnet 4.5, so this chat switched to GPT-5.5.',
          },
        ],
        timestamp: 2,
      },
    ];

    const input = buildHandoffSummaryInput(messages);

    expect(input.length).toBeLessThanOrEqual(HANDOFF_CONVERSATION_TEXT_LIMIT);
    // The trailing system line survives...
    expect(input).toContain('organization blocked');
    // ...and so does a substantial tail of the oversized turn before it.
    expect(input.length).toBeGreaterThan(HANDOFF_CONVERSATION_TEXT_LIMIT - 500);
  });
});

describe('streamed handoff summary input', () => {
  it.each([
    [turn('user', 'small'), turn('assistant', 'answer')],
    [
      turn('assistant', 'x'.repeat(100_000)),
      turn('user', 'short trailing question'),
    ],
    Array.from({ length: 500 }, (_, index) =>
      turn(
        index % 2 ? 'assistant' : 'user',
        `Paragraph ${index}\n\n${'context '.repeat(40)}`,
      ),
    ),
    [
      turn('user', 'x'.repeat(50_000)),
      turn('assistant', 'y'.repeat(20_000)),
      turn('user', 'last'),
    ],
    [turn('assistant', 'unicode 漢字🙂'.repeat(10_000))],
  ])(
    'matches the existing turn-aware truncation for case %#',
    async (...messages) => {
      async function* transcript(): AsyncGenerator<ChatMessage> {
        yield* await Promise.resolve(messages);
      }
      expect(await buildHandoffSummaryInputFromTranscript(transcript())).toBe(
        buildHandoffSummaryInput(messages),
      );
    },
  );
});
