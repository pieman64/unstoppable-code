import type { ChatMessage } from '@/stores/chatStore';
import { computeRevertedUserMessageIds } from '../revert-region';

function user(id: string): ChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: 0,
  };
}

function asst(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 0,
  };
}

function timer(id: string): ChatMessage {
  return {
    id,
    role: 'system',
    blocks: [{ type: 'turn_timer', startedAt: 0, completedAt: 1 }],
    timestamp: 0,
  };
}

function revertMarker(id: string, revertedFromMessageId: string): ChatMessage {
  return {
    id,
    role: 'system',
    blocks: [
      {
        type: 'revert_info',
        timestamp: 0,
        revertedFromMessageId,
        revertedFromTimestamp: 0,
        files: [],
        totalInsertions: 0,
        totalDeletions: 0,
      },
    ],
    timestamp: 0,
  };
}

describe('computeRevertedUserMessageIds', () => {
  it('returns an empty set when there are no revert markers', () => {
    const messages = [user('u1'), asst('a1'), timer('t1')];
    expect(computeRevertedUserMessageIds(messages)).toEqual(new Set());
  });

  it('marks a single reverted turn', () => {
    const messages = [
      user('u1'),
      asst('a1'),
      timer('t1'),
      revertMarker('r1', 'u1'),
    ];
    expect(computeRevertedUserMessageIds(messages)).toEqual(new Set(['u1']));
  });

  it('marks all later turns as reverted when a mid-transcript turn was rolled back', () => {
    // User reverted turn u1; turns u2 and u3 built on top, so their changes
    // are also gone. Marker is appended at the end.
    const messages = [
      user('u1'),
      asst('a1'),
      timer('t1'),
      user('u2'),
      asst('a2'),
      timer('t2'),
      user('u3'),
      asst('a3'),
      timer('t3'),
      revertMarker('r1', 'u1'),
    ];
    expect(computeRevertedUserMessageIds(messages)).toEqual(
      new Set(['u1', 'u2', 'u3']),
    );
  });

  it('handles multiple revert markers', () => {
    // Revert u3 first, then later revert u1. Both regions overlap.
    const messages = [
      user('u1'),
      asst('a1'),
      timer('t1'),
      user('u2'),
      asst('a2'),
      timer('t2'),
      user('u3'),
      asst('a3'),
      timer('t3'),
      revertMarker('r1', 'u3'),
      user('u4'),
      asst('a4'),
      timer('t4'),
      revertMarker('r2', 'u1'),
    ];
    expect(computeRevertedUserMessageIds(messages)).toEqual(
      new Set(['u1', 'u2', 'u3', 'u4']),
    );
  });

  it('ignores markers whose revertedFromMessageId is not in the transcript', () => {
    const messages = [
      user('u1'),
      asst('a1'),
      timer('t1'),
      revertMarker('r1', 'unknown-id'),
    ];
    expect(computeRevertedUserMessageIds(messages)).toEqual(new Set());
  });
});
