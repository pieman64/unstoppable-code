import type { TurnMessage, TurnGroupOrMessage } from '../types';
import {
  estimateTranscriptSectionHeight,
  progressiveTranscriptRange,
  shouldPreloadTranscriptFileIndex,
  shouldVirtualizeTranscript,
} from '../chat-message-list-state';

describe('shouldPreloadTranscriptFileIndex', () => {
  it('returns true when a transcript exists and no load has been attempted', () => {
    expect(
      shouldPreloadTranscriptFileIndex(true, undefined, false, undefined),
    ).toBe(true);
  });

  it('returns false for an empty transcript', () => {
    expect(
      shouldPreloadTranscriptFileIndex(false, undefined, false, undefined),
    ).toBe(false);
  });

  it('returns false when index data is already cached', () => {
    expect(
      shouldPreloadTranscriptFileIndex(
        true,
        {
          data: { repos: [] },
          fetchedAt: Date.now(),
        },
        false,
        undefined,
      ),
    ).toBe(false);
  });

  it('returns false when an index load is in progress', () => {
    expect(
      shouldPreloadTranscriptFileIndex(true, undefined, true, undefined),
    ).toBe(false);
  });

  it('returns false when a previous index load failed', () => {
    expect(
      shouldPreloadTranscriptFileIndex(
        true,
        undefined,
        false,
        'Unable to load',
      ),
    ).toBe(false);
  });
});

// The fixture has fewer than 80 turns but hundreds of KB of visible Markdown.
// Counting turn groups alone leaves the full document mounted.
describe('transcript rendering budget', () => {
  it('does not count collapsed tool output as rendered Markdown', () => {
    const group = {
      kind: 'standalone' as const,
      message: {
        id: 'tool',
        role: 'assistant' as const,
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use' as const,
            toolUseId: 'read',
            toolName: 'Read',
            input: '{}',
            result: { output: 'x'.repeat(1_000_000), isError: false },
          },
        ],
      },
    };
    expect(shouldVirtualizeTranscript([group, group])).toBe(false);
  });

  it('windows a few oversized final reports while keeping ordinary chats simple', () => {
    const message = (size: number): TurnMessage => ({
      id: 'message',
      role: 'assistant' as const,
      timestamp: 1,
      blocks: [{ type: 'text' as const, text: 'x'.repeat(size) }],
    });
    const standalone = (size: number): TurnGroupOrMessage => ({
      kind: 'standalone' as const,
      message: message(size),
    });
    expect(
      shouldVirtualizeTranscript(
        Array.from({ length: 25 }, () => standalone(26_000)),
      ),
    ).toBe(true);
    expect(
      shouldVirtualizeTranscript(
        Array.from({ length: 25 }, () => standalone(100)),
      ),
    ).toBe(false);
    expect(
      shouldVirtualizeTranscript(
        Array.from({ length: 80 }, () => standalone(10)),
      ),
    ).toBe(true);
  });
});

describe('progressiveTranscriptRange', () => {
  const range = { startIndex: 10, endIndex: 11, overscan: 2, count: 20 };

  it('mounts only the visible sections while any of them is new', () => {
    expect(progressiveTranscriptRange(range, new Set([12]))).toEqual([
      10, 11, 12,
    ]);
  });

  it('adds one overscan section per pass, nearest first', () => {
    expect(progressiveTranscriptRange(range, new Set([10, 11]))).toEqual([
      10, 11, 12,
    ]);
    expect(progressiveTranscriptRange(range, new Set([10, 11, 12]))).toEqual([
      9, 10, 11, 12,
    ]);
    expect(
      progressiveTranscriptRange(range, new Set([9, 10, 11, 12, 13])),
    ).toEqual([8, 9, 10, 11, 12, 13]);
  });

  it('admits overscan sections whose size is already known', () => {
    // A restored position places measured sections from their saved sizes.
    // Mounting them later would re-measure them after the restore settled.
    expect(
      progressiveTranscriptRange(
        range,
        new Set(),
        (index) => index === 9 || index === 13,
      ),
    ).toEqual([9, 10, 11, 13]);
  });

  it('stays within the transcript bounds', () => {
    expect(
      progressiveTranscriptRange(
        { startIndex: 0, endIndex: 0, overscan: 2, count: 2 },
        new Set([0]),
      ),
    ).toEqual([0, 1]);
  });
});

describe('estimateTranscriptSectionHeight', () => {
  const text = (
    id: string,
    role: TurnMessage['role'],
    value: string,
  ): TurnMessage => ({
    id,
    role,
    timestamp: 1,
    blocks: [{ type: 'text' as const, text: value }],
  });
  const turn = (reply: string): TurnGroupOrMessage => ({
    kind: 'turn-group',
    userMessage: text('user', 'user', 'Ask'),
    assistantMessages: [
      text('progress', 'assistant', 'Working'),
      text('final', 'assistant', reply),
    ],
    timerMessage: {
      id: 'timer',
      role: 'system',
      timestamp: 1,
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
    },
    isComplete: true,
  });

  it('keeps the flat estimate for ordinary turns', () => {
    expect(estimateTranscriptSectionHeight([turn('Done.')])).toBe(168);
  });

  it('grows with a long final report', () => {
    expect(
      estimateTranscriptSectionHeight([turn('x'.repeat(26_000))]),
    ).toBeGreaterThan(3_000);
  });
});
