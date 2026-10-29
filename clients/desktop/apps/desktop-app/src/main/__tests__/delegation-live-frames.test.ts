import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import {
  DELEGATION_LIVE_KEYFRAME_MS,
  DelegationLiveFrames,
} from '../agents/delegation/item-changes';

function text(
  id: string,
  sequence: number,
  value: string,
): AgentDelegationTranscriptItem {
  return { id, sequence, occurredAt: sequence, type: 'text', text: value };
}

function snapshot(
  sequence: number,
  transcript: AgentDelegationTranscriptItem[],
  status: AgentDelegationSnapshot['status'] = 'running',
): AgentDelegationTranscript {
  return {
    delegationId: 'child',
    runGeneration: 1,
    sequence,
    parentHarnessId: 'claude',
    parentTurnId: 'turn',
    parentToolCallId: 'spawn',
    createdAt: 1,
    task: {
      description: 'Review',
      prompt: 'Review',
      executionMode: 'background',
    },
    transcript,
    snapshot: { delegationId: 'child', status, outputTruncated: false },
  };
}

function ids(frame: AgentDelegationTranscript): string[] {
  return frame.transcript.map((item) => item.id);
}

describe('DelegationLiveFrames', () => {
  let now: number;
  let frames: DelegationLiveFrames;

  beforeEach(() => {
    now = 0;
    frames = new DelegationLiveFrames({ now: (): number => now });
  });

  it('sends a run whole first, then only its new and changed items', () => {
    const first = frames.frame(snapshot(1, [text('a', 1, 'x')]));
    expect(first.transcriptMode).toBeUndefined();
    expect(ids(first)).toEqual(['a']);

    const second = frames.frame(
      snapshot(2, [text('a', 1, 'x'), text('b', 2, 'y')]),
    );
    expect(second.transcriptMode).toBe('patch');
    expect(ids(second)).toEqual(['b']);

    const third = frames.frame(
      snapshot(3, [text('a', 1, 'x'), text('b', 2, 'yz')]),
    );
    expect(ids(third)).toEqual(['b']);

    const unchanged = frames.frame(
      snapshot(4, [text('a', 1, 'x'), text('b', 2, 'yz')]),
    );
    expect(unchanged.transcriptMode).toBe('patch');
    expect(ids(unchanged)).toEqual([]);
  });

  it('sends an item changed in place, whatever part of it changed', () => {
    const tail = 'b'.repeat(80);
    frames.frame(snapshot(1, [text('a', 1, 'a'.repeat(200) + tail)]));
    // The same length and ending, corrected earlier in the text.
    const corrected = frames.frame(
      snapshot(2, [text('a', 1, 'c'.repeat(200) + tail)]),
    );
    expect(corrected.transcriptMode).toBe('patch');
    expect(ids(corrected)).toEqual(['a']);
  });

  it('sends the whole transcript again after the keyframe interval', () => {
    frames.frame(snapshot(1, [text('a', 1, 'x')]));
    now = DELEGATION_LIVE_KEYFRAME_MS - 1;
    expect(frames.frame(snapshot(2, [text('a', 1, 'x')])).transcriptMode).toBe(
      'patch',
    );
    now = DELEGATION_LIVE_KEYFRAME_MS;
    const keyframe = frames.frame(snapshot(3, [text('a', 1, 'x')]));
    expect(keyframe.transcriptMode).toBeUndefined();
    expect(ids(keyframe)).toEqual(['a']);
  });

  it('sends a settled run whole and starts over if it reports again', () => {
    frames.frame(snapshot(1, [text('a', 1, 'x')]));
    const settled = frames.frame(
      snapshot(2, [text('a', 1, 'x'), text('b', 2, 'y')], 'completed'),
    );
    expect(settled.transcriptMode).toBeUndefined();
    expect(ids(settled)).toEqual(['a', 'b']);
    const later = frames.frame(
      snapshot(3, [text('a', 1, 'x'), text('b', 2, 'y')], 'completed'),
    );
    expect(later.transcriptMode).toBeUndefined();
  });
});
