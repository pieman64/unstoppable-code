/**
 * Group commit for one scope's delta journal (P1 §B): leader/follower
 * batching of the records the writer has admitted but not yet synced.
 *
 * - With nothing in flight, a record is a batch of one and is written at
 *   once, so a lone commit is never delayed.
 * - Records admitted while a batch is being written and synced collect in
 *   the next batch, which is written with one append and one sync when the
 *   current one completes.
 * - A batch holds at most {@link GROUP_COMMIT_MAX_RECORDS} records and
 *   {@link GROUP_COMMIT_MAX_BYTES} bytes, so one batch cannot stall the
 *   acknowledgement of the records in it; a larger frame is a batch of its
 *   own. Batch membership is fixed when a record is admitted, because every
 *   record after a batch's first names that batch's start in its frame.
 * - Records settle in the order they were admitted, each only after its own
 *   batch is durable. A failed batch rejects its records and every queued
 *   record, and the queue accepts nothing more: the journal may hold any
 *   prefix of the failed batch, so the writer must be reopened.
 *
 * Pure ordering and bookkeeping; the writer supplies the append-and-sync.
 */

/** Records one batch may hold. */
export const GROUP_COMMIT_MAX_RECORDS = 256;
/** Frame bytes one batch may hold; a larger frame is written alone. */
export const GROUP_COMMIT_MAX_BYTES = 1024 * 1024;

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingBatch {
  /** Journal offset of the batch's first frame. */
  start: number;
  bytes: number;
  frames: Buffer[];
  waiters: Waiter[];
}

/** What the writer appends and syncs as one unit. */
export interface GroupCommitBatch {
  start: number;
  frames: readonly Buffer[];
  bytes: number;
}

export interface GroupCommitLimits {
  maxRecords: number;
  maxBytes: number;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class GroupCommitQueue {
  /** Admitted batches no append has started for, oldest first. */
  private readonly batches: PendingBatch[] = [];
  private flushing: Promise<void> | undefined;
  private failure: Error | undefined;
  /**
   * The durability of the record admitted last. Batches settle in admission
   * order, so it settles once every record admitted so far has.
   */
  private lastDurable: Promise<void> | undefined;

  public constructor(
    /** Append the batch's frames at its start offset and sync, once. */
    private readonly writeBatch: (batch: GroupCommitBatch) => Promise<void>,
    /** Runs before any record of a failed batch is rejected. */
    private readonly onFailure: (error: Error) => void,
    private readonly limits: GroupCommitLimits = {
      maxRecords: GROUP_COMMIT_MAX_RECORDS,
      maxBytes: GROUP_COMMIT_MAX_BYTES,
    },
  ) {}

  /** Whether an admitted record is not durable yet. */
  public get active(): boolean {
    return this.flushing !== undefined;
  }

  /**
   * Settles when every record admitted so far is durable, and rejects when
   * the batch of one of them failed. Resolved when nothing is pending.
   *
   * A snapshot: records admitted after the call do not affect it, so a
   * retry acknowledged with it waits for, and fails with, only what was
   * admitted before the retry.
   */
  public settled(): Promise<void> {
    return this.flushing
      ? (this.lastDurable ?? Promise.resolve())
      : Promise.resolve();
  }

  /**
   * The start offset of the queued batch a record admitted now may join,
   * when that batch can take another record. Undefined when the record
   * starts a batch.
   */
  public joinableStart(): number | undefined {
    const tail = this.batches[this.batches.length - 1];
    return tail && tail.frames.length < this.limits.maxRecords
      ? tail.start
      : undefined;
  }

  /** Whether a frame of `frameBytes` still fits the batch it would join. */
  public fits(frameBytes: number): boolean {
    const tail = this.batches[this.batches.length - 1];
    return (
      tail !== undefined &&
      tail.frames.length < this.limits.maxRecords &&
      tail.bytes + frameBytes <= this.limits.maxBytes
    );
  }

  /**
   * Queue an admitted record's frame, which belongs at `offset`. With
   * `joinStart` it joins the queued batch that starts there (the caller
   * checked {@link joinableStart} and {@link fits} in the same synchronous
   * step); otherwise it starts a batch. The promise settles when the
   * record's batch is durable.
   */
  public add(
    offset: number,
    frame: Buffer,
    joinStart: number | undefined,
  ): Promise<void> {
    if (this.failure)
      throw Object.assign(new Error('Delta journal batch queue has failed'), {
        cause: this.failure,
      });
    const tail = this.batches[this.batches.length - 1];
    if (tail && tail.start + tail.bytes !== offset)
      throw new Error('Delta journal batches are not contiguous');
    let batch: PendingBatch;
    if (joinStart === undefined) {
      batch = { start: offset, bytes: 0, frames: [], waiters: [] };
      this.batches.push(batch);
    } else {
      if (!tail || tail.start !== joinStart || !this.fits(frame.length))
        throw new Error('Delta journal record cannot join its batch');
      batch = tail;
    }
    batch.frames.push(frame);
    batch.bytes += frame.length;
    const durable = new Promise<void>((resolve, reject) => {
      batch.waiters.push({ resolve, reject });
    });
    // The caller's own chain observes the outcome; a caller that drops the
    // promise must not turn a failed batch into an unhandled rejection.
    durable.catch(() => undefined);
    this.lastDurable = durable;
    if (!this.flushing) {
      const flushing = this.flush();
      this.flushing = flushing;
      flushing.catch(() => undefined);
    }
    return durable;
  }

  private async flush(): Promise<void> {
    try {
      for (;;) {
        // Taken before its append starts: later records open a new batch.
        const batch = this.batches.shift();
        if (!batch) return;
        try {
          await this.writeBatch({
            start: batch.start,
            frames: batch.frames,
            bytes: batch.bytes,
          });
        } catch (error) {
          const failure = toError(error);
          this.failure = failure;
          this.onFailure(failure);
          const rejected = [batch, ...this.batches.splice(0)];
          for (const failed of rejected)
            for (const waiter of failed.waiters) waiter.reject(failure);
          throw failure;
        }
        for (const waiter of batch.waiters) waiter.resolve();
      }
    } finally {
      this.flushing = undefined;
    }
  }
}
