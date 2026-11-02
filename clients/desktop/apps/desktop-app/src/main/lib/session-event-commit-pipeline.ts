/**
 * Commit overlap for one session's provider events, used while chat storage
 * group-commits through the delta journal.
 *
 * A session's events are delivered in provider order after durability. For
 * eligible streamed content, overlap allows the next commit to start once the
 * previous one is queued; without an eligible event, commits stay serial.
 *
 * {@link SessionEventCommitPipeline.overlap} relaxes exactly one thing for
 * the streaming events admitted by the captured mode's predicate: the next
 * event's commit may start as soon as this one holds its place in the scope's
 * commit order, instead of when it is durable. Everything else is kept:
 *
 * - **Commit order** is the provider's order: the next commit starts only
 *   after this one was queued (the repository's `onQueued` signal), or after
 *   it settled when no such signal arrives, which is the previous behavior.
 * - **Delivery order** is the provider's order, and delivery follows
 *   durability: each event completes after its own commit settled and after
 *   every earlier overlapped event completed.
 * - **Every other event** (a turn boundary, a revival, input delivery, a
 *   prompt, an error) first waits for every overlapped completion
 *   ({@link SessionEventCommitPipeline.drained}) and then runs alone, so it
 *   reads and changes the turn's state exactly as before.
 */
import { hasErroredToolResult } from './tool-result-entries';
import { isRecord } from './type-guards';

/** Codex item events streamed inside a turn. */
const OVERLAPPABLE_CODEX_EVENTS = new Set([
  'item.started',
  'item.updated',
  'item.completed',
]);

/** Claude SDK messages streamed inside a turn. */
const OVERLAPPABLE_CLAUDE_EVENTS = new Set([
  'assistant',
  'user',
  'stream_event',
]);

/**
 * Whether a provider event is plain streamed turn content whose commit may
 * overlap the commits before it: a Codex item event, or a Claude assistant,
 * tool-result or partial message, with no error attached. Turn starts and
 * ends, results, errors, prompts, input delivery, revivals, questions and
 * every Canopy-authored event are not.
 *
 * Nor is an event that carries an errored tool result: a paired
 * `canopy_auth_failure` is queued when that event is delivered, and must be
 * committed before any later provider event (a terminal event would settle
 * the turn first, and the failure notice would be skipped). Such an event
 * runs alone, and the session's route admits it alone too.
 */
export function isOverlappableProviderEvent(data: unknown): boolean {
  if (!isRecord(data) || typeof data.type !== 'string') return false;
  if (data.error !== undefined || data.is_error === true) return false;
  if (data.canopy_turn_revival === true) return false;
  if (hasErroredToolResult(data)) return false;
  if (data.type === 'codex') {
    const event = data.event;
    return (
      isRecord(event) &&
      typeof event.type === 'string' &&
      OVERLAPPABLE_CODEX_EVENTS.has(event.type)
    );
  }
  return OVERLAPPABLE_CLAUDE_EVENTS.has(data.type);
}

export type SessionEventCommitOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

export class SessionEventCommitPipeline {
  private completions: Promise<void> = Promise.resolve();
  private open = 0;

  /** Whether an overlapped event has not completed yet. */
  public get pending(): boolean {
    return this.open > 0;
  }

  /** Settles once every overlapped event submitted so far has completed. */
  public drained(): Promise<void> {
    return this.completions;
  }

  /**
   * Start `commit` now. `queued` settles when the commit holds its place in
   * commit order (it called `markQueued`) or has settled: the caller may
   * then start the next event. `complete` runs with the commit's outcome
   * once it settled and every earlier overlapped event completed;
   * `completed` settles after it, and rejects with what it threw.
   */
  public overlap<T>(
    commit: (markQueued: () => void) => Promise<T>,
    complete: (outcome: SessionEventCommitOutcome<T>) => void | Promise<void>,
  ): { queued: Promise<void>; completed: Promise<void> } {
    let markQueued = (): void => undefined;
    const queued = new Promise<void>((resolve) => {
      markQueued = resolve;
    });
    let started: Promise<T>;
    try {
      started = commit(markQueued);
    } catch (reason) {
      started = Promise.reject(
        reason instanceof Error ? reason : new Error(String(reason)),
      );
    }
    const outcome = started.then(
      (value): SessionEventCommitOutcome<T> => ({ status: 'fulfilled', value }),
      (reason: unknown): SessionEventCommitOutcome<T> => ({
        status: 'rejected',
        reason,
      }),
    );
    // A commit that settles without taking a place must not hold the caller.
    void outcome.then(markQueued);
    this.open += 1;
    const completed = this.completions.then(async (): Promise<void> => {
      try {
        await complete(await outcome);
      } finally {
        this.open -= 1;
      }
    });
    this.completions = completed.catch(() => undefined);
    return { queued, completed };
  }
}
