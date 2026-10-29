import type {
  AgentDelegationTranscript,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import type {
  DelegationRun,
  DelegationRunItems,
} from '../../lib/chat-delegation-log';
import {
  DELEGATION_SETTLED_STATUSES,
  sameDelegationItem,
} from './item-changes';

/**
 * Progress items reach the delegate log at most this often per chat: one
 * write and one sync per window instead of one per snapshot.
 */
export const DELEGATION_LOG_FLUSH_INTERVAL_MS = 250;

/**
 * Settled runs whose written items are kept, most recent last. A settled run
 * still reports (for example when its result reaches the parent), and those
 * reports must not write its items again; the oldest are forgotten first.
 * The kept items share their strings with the broker's retained record.
 */
const SETTLED_RUN_MEMORY = 64;

function runKey(run: DelegationRun): string {
  return `${run.delegationId}:${String(run.runGeneration)}`;
}

interface PendingRun {
  readonly run: DelegationRun;
  readonly items: Map<string, AgentDelegationTranscriptItem>;
}

export interface DelegationLogWriterOptions {
  /** Appends runs' items to the parent chat's delegate logs in one call. */
  append: (runs: DelegationRunItems[]) => Promise<unknown>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Writes one chat's delegate runs to its delegate log: only items that are
 * new or changed since they were last written, batched per window, and at
 * once when a run settles so its card never outruns its transcript.
 */
export class DelegationLogWriter {
  /** The last version of each item a run already has in the log, by id. */
  private readonly written = new Map<
    string,
    Map<string, AgentDelegationTranscriptItem>
  >();
  private readonly pending = new Map<string, PendingRun>();
  private readonly settled: string[] = [];
  private readonly intervalMs: number;
  private readonly setTimer: NonNullable<
    DelegationLogWriterOptions['setTimer']
  >;
  private readonly clearTimer: NonNullable<
    DelegationLogWriterOptions['clearTimer']
  >;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: DelegationLogWriterOptions) {
    this.intervalMs = options.intervalMs ?? DELEGATION_LOG_FLUSH_INTERVAL_MS;
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

  /**
   * Takes one snapshot's new and changed items. A settled run is written at
   * once and the returned promise resolves when it is in the log; progress
   * waits for the current window.
   */
  offer(transcript: AgentDelegationTranscript): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const run = {
      delegationId: transcript.delegationId,
      runGeneration: transcript.runGeneration,
    };
    const key = runKey(run);
    const written =
      this.written.get(key) ?? new Map<string, AgentDelegationTranscriptItem>();
    this.written.set(key, written);
    for (const item of transcript.transcript) {
      if (sameDelegationItem(written.get(item.id), item)) continue;
      written.set(item.id, item);
      let pending = this.pending.get(key);
      if (!pending) {
        pending = { run, items: new Map() };
        this.pending.set(key, pending);
      }
      pending.items.set(item.id, item);
    }
    if (DELEGATION_SETTLED_STATUSES.has(transcript.snapshot.status)) {
      this.rememberSettled(key);
      return this.flush();
    }
    if (this.pending.size > 0 && this.timer === undefined)
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        void this.flush();
      }, this.intervalMs);
    return Promise.resolve();
  }

  private rememberSettled(key: string): void {
    const index = this.settled.indexOf(key);
    if (index >= 0) this.settled.splice(index, 1);
    this.settled.push(key);
    while (this.settled.length > SETTLED_RUN_MEMORY) {
      const forgotten = this.settled.shift();
      if (forgotten !== undefined && !this.pending.has(forgotten))
        this.written.delete(forgotten);
    }
  }

  /** Writes every pending item now. */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    const batch = Array.from(this.pending.values());
    this.pending.clear();
    if (batch.length === 0) return this.tail;
    // One append per window for every pending run: the chat's scope lease
    // and index check are taken once, not once per run.
    this.tail = this.tail.then(async () => {
      try {
        await this.options.append(
          batch.map(({ run, items }) => ({
            run,
            items: Array.from(items.values()).sort(
              (left, right) => left.sequence - right.sequence,
            ),
          })),
        );
      } catch (error) {
        // The log is display evidence: a failed write is reported, and each
        // run's next snapshot rewrites what changed after it.
        for (const { run, items } of batch) {
          const written = this.written.get(runKey(run));
          for (const id of Array.from(items.keys())) written?.delete(id);
        }
        this.options.onError?.(error);
      }
    });
    return this.tail;
  }

  /** Flushes what is pending and stops accepting snapshots. */
  async dispose(): Promise<void> {
    await this.flush();
    this.disposed = true;
    this.written.clear();
    this.settled.length = 0;
  }
}
