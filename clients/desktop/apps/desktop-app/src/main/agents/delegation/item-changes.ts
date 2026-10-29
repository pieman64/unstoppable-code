import type {
  AgentDelegationTranscript,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';

export const DELEGATION_SETTLED_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
  'interrupted',
]);

/**
 * Whether two versions of an item are the same, field by field. Changed
 * items share no state with earlier versions, and unchanged ones share their
 * strings, so comparing is cheap; a digest of part of an item would miss a
 * correction that keeps its length and ending.
 */
export function sameDelegationItem(
  left: AgentDelegationTranscriptItem | undefined,
  right: AgentDelegationTranscriptItem,
): boolean {
  if (
    !left ||
    left.type !== right.type ||
    left.id !== right.id ||
    left.sequence !== right.sequence ||
    left.occurredAt !== right.occurredAt
  )
    return false;
  if (right.type === 'tool')
    return (
      left.type === 'tool' &&
      left.toolName === right.toolName &&
      left.input === right.input &&
      left.output === right.output &&
      left.isError === right.isError
    );
  return left.type !== 'tool' && left.text === right.text;
}

export function delegationRunKey(transcript: {
  delegationId: string;
  runGeneration: number;
}): string {
  return `${transcript.delegationId}:${String(transcript.runGeneration)}`;
}

/** A whole transcript is resent at least this often while a run is live. */
export const DELEGATION_LIVE_KEYFRAME_MS = 5_000;

interface LiveRun {
  /** The last version of each item sent, by item id. */
  readonly sent: Map<string, AgentDelegationTranscriptItem>;
  keyframeAt: number;
}

export interface DelegationLiveFramesOptions {
  now?: () => number;
  keyframeMs?: number;
}

/**
 * Turns a delegate's live snapshots into renderer frames: a patch of the
 * items that are new or changed since the previous frame, so a live card
 * receives each item about once instead of the whole transcript ten times a
 * second. A run's first frame, a frame after {@link DELEGATION_LIVE_KEYFRAME_MS},
 * and its settled frame carry the whole transcript, so a renderer that
 * reloaded or forgot the run catches up without asking.
 */
export class DelegationLiveFrames {
  private readonly runs = new Map<string, LiveRun>();
  private readonly now: () => number;
  private readonly keyframeMs: number;

  constructor(options: DelegationLiveFramesOptions = {}) {
    this.now = options.now ?? Date.now;
    this.keyframeMs = options.keyframeMs ?? DELEGATION_LIVE_KEYFRAME_MS;
  }

  frame(transcript: AgentDelegationTranscript): AgentDelegationTranscript {
    const key = delegationRunKey(transcript);
    const at = this.now();
    if (DELEGATION_SETTLED_STATUSES.has(transcript.snapshot.status)) {
      this.runs.delete(key);
      return transcript;
    }
    const run = this.runs.get(key);
    if (!run || at - run.keyframeAt >= this.keyframeMs) {
      this.runs.set(key, {
        sent: new Map(transcript.transcript.map((item) => [item.id, item])),
        keyframeAt: at,
      });
      return transcript;
    }
    const changed = transcript.transcript.filter((item) => {
      if (sameDelegationItem(run.sent.get(item.id), item)) return false;
      run.sent.set(item.id, item);
      return true;
    });
    return { ...transcript, transcriptMode: 'patch', transcript: changed };
  }

  /** Forgets every run, for example when the chat's root closes. */
  clear(): void {
    this.runs.clear();
  }
}
