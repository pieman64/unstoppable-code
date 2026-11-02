import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import { recordDelegationSnapshot } from '@canopy/desktop-shared/node/work-counters';

/**
 * Bound for delegate card updates while the parent chat has no active turn:
 * at most one card update per delegate run per window. A live run the chat
 * owns stays in its active sidecar until it settles, so an update no longer
 * rewrites committed history; the interval still bounds how often each run
 * commits chat state and repaints the parent chat.
 */
export const DELEGATION_CARD_SETTLED_INTERVAL_MS = 10_000;

/** Bound for active-parent delegate card progress patches per run per window. */
export const DELEGATION_CARD_ACTIVE_INTERVAL_MS = 2_000;

const TERMINAL_STATUSES: ReadonlySet<AgentDelegationSnapshot['status']> =
  new Set<AgentDelegationSnapshot['status']>([
    'completed',
    'failed',
    'cancelled',
    'deadline_exceeded',
  ]);

interface PublishedCard {
  readonly at: number;
  readonly status: AgentDelegationSnapshot['status'];
  readonly approvalPending: boolean;
  readonly control: string;
  readonly stopRequested: string;
}

interface PendingCard {
  transcript: AgentDelegationTranscript;
  timer: ReturnType<typeof setTimeout>;
  deadlineAt: number;
}

export interface DelegationCardPublisherOptions {
  /** Commits one snapshot to the parent chat (attached route or detached). */
  publish: (transcript: AgentDelegationTranscript) => void;
  /** Whether the parent chat currently runs a turn (active sidecar writes). */
  parentTurnActive: () => boolean;
  intervalMs?: number;
  activeIntervalMs?: number;
  now?: () => number;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

function cardState(
  transcript: AgentDelegationTranscript,
  at: number,
): PublishedCard {
  const { snapshot } = transcript;
  return {
    at,
    status: snapshot.status,
    approvalPending: snapshot.approvalPending === true,
    control: snapshot.control
      ? `${snapshot.control.operationId}:${snapshot.control.status}`
      : '',
    stopRequested: snapshot.stopRequested
      ? `${snapshot.stopRequested.operationId}:${snapshot.stopRequested.status}`
      : '',
  };
}

/** Changes the user must see at once, whatever the parent's state. */
function isPromptChange(previous: PublishedCard, next: PublishedCard): boolean {
  return (
    previous.status !== next.status ||
    previous.approvalPending !== next.approvalPending ||
    previous.control !== next.control ||
    previous.stopRequested !== next.stopRequested
  );
}

function runKey(transcript: AgentDelegationTranscript): string {
  return `${transcript.delegationId}:${String(transcript.runGeneration)}`;
}

/**
 * Coalesces delegate card snapshots for a parent chat with an active or
 * settled turn.
 *
 * Live delegation transcripts are full snapshots of one run (card plus every
 * child row), so the newest pending snapshot supersedes older ones without
 * losing content. A run's snapshot publishes immediately on first appearance,
 * on a status change (including every terminal status), an approval-pending
 * change, or a control/stop operation change. Other progress publishes at
 * most once per run per active interval while the parent turn is active, or
 * settled interval otherwise, carrying the newest snapshot. An active offer
 * can shorten a pending settled deadline, but never extend a deadline already
 * scheduled. A pending snapshot that never flushes (crash, shutdown) is
 * reconciled from the durable run record by delegation restart recovery.
 */
export class DelegationCardPublisher {
  private readonly published = new Map<string, PublishedCard>();
  private readonly pending = new Map<string, PendingCard>();
  private readonly latestAcceptedSequence = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly activeIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<
    DelegationCardPublisherOptions['setTimer']
  >;
  private readonly clearTimer: NonNullable<
    DelegationCardPublisherOptions['clearTimer']
  >;
  private disposed = false;

  constructor(private readonly options: DelegationCardPublisherOptions) {
    this.intervalMs = options.intervalMs ?? DELEGATION_CARD_SETTLED_INTERVAL_MS;
    this.activeIntervalMs =
      options.activeIntervalMs ?? DELEGATION_CARD_ACTIVE_INTERVAL_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.setTimer =
      options.setTimer ??
      ((callback, ms): ReturnType<typeof setTimeout> => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return timer;
      });
    this.clearTimer =
      options.clearTimer ??
      ((timer): void => {
        clearTimeout(timer);
      });
  }

  offer(transcript: AgentDelegationTranscript): void {
    if (this.disposed) return;
    const key = runKey(transcript);
    const latestSequence = this.latestAcceptedSequence.get(key);
    if (latestSequence !== undefined && transcript.sequence <= latestSequence)
      return;
    this.latestAcceptedSequence.set(key, transcript.sequence);
    recordDelegationSnapshot('offered', transcript);
    const waiting = this.pending.get(key);
    const at = this.now();
    const intervalMs = this.options.parentTurnActive()
      ? this.activeIntervalMs
      : this.intervalMs;
    const previous = this.published.get(key);
    if (
      previous === undefined ||
      isPromptChange(previous, cardState(transcript, at)) ||
      at - previous.at >= intervalMs
    ) {
      this.publishNow(key, transcript, at);
      return;
    }
    const deadlineAt = previous.at + intervalMs;
    if (waiting) {
      waiting.transcript = transcript;
      if (deadlineAt < waiting.deadlineAt) {
        this.clearTimer(waiting.timer);
        waiting.deadlineAt = deadlineAt;
        waiting.timer = this.setTimer(
          () => this.flushRun(key),
          Math.max(0, deadlineAt - at),
        );
      }
      return;
    }
    this.pending.set(key, {
      transcript,
      deadlineAt,
      timer: this.setTimer(
        () => this.flushRun(key),
        Math.max(0, deadlineAt - at),
      ),
    });
  }

  /** Publishes every pending snapshot now (for example before detaching). */
  flush(): void {
    for (const key of Array.from(this.pending.keys())) this.flushRun(key);
  }

  /** Drops pending work; restart recovery reconciles unpublished snapshots. */
  dispose(): void {
    this.disposed = true;
    for (const waiting of Array.from(this.pending.values()))
      this.clearTimer(waiting.timer);
    this.pending.clear();
    this.published.clear();
    this.latestAcceptedSequence.clear();
  }

  private flushRun(key: string): void {
    const waiting = this.pending.get(key);
    if (!waiting) return;
    this.publishNow(key, waiting.transcript, this.now());
  }

  private publishNow(
    key: string,
    transcript: AgentDelegationTranscript,
    at: number,
  ): void {
    const waiting = this.pending.get(key);
    if (waiting) {
      this.clearTimer(waiting.timer);
      this.pending.delete(key);
    }
    if (TERMINAL_STATUSES.has(transcript.snapshot.status))
      this.published.delete(key);
    else this.published.set(key, cardState(transcript, at));
    recordDelegationSnapshot('published', transcript);
    this.options.publish(transcript);
  }
}
