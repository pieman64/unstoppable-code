import type { DelegationTranscriptChange } from '@canopy/desktop-shared/node/delegation/transcript-port';

/** Changes one append admits at most; a receipt for more is not stored. */
const CHILD_APPEND_BATCH_LIMIT = 64;

/**
 * Admits a delegate's normalized child changes in order, one append at a
 * time. While an append is in flight, later changes wait and go out together
 * in the next append, so slow storage admits several items per lease turn
 * instead of one. A batch holds at most one change per item (the port's
 * rule) and at most 64 changes. Callers wait while a full batch is already
 * waiting, so provider backpressure stays bounded (D6).
 */
export class ChildAppendQueue {
  private pending: DelegationTranscriptChange[] = [];
  private running: Promise<void> | undefined;
  private failure: { readonly error: unknown } | undefined;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly append: (
      changes: readonly DelegationTranscriptChange[],
    ) => Promise<void>,
    private readonly acknowledge: (
      changes: readonly DelegationTranscriptChange[],
    ) => void,
  ) {}

  /** Queues changes; resolves once queued, or once there is room for them. */
  async enqueue(changes: readonly DelegationTranscriptChange[]): Promise<void> {
    this.throwIfFailed();
    if (!changes.length) return;
    this.pending.push(...changes);
    this.pump();
    while (
      this.pending.length >= CHILD_APPEND_BATCH_LIMIT &&
      this.failure === undefined
    )
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.throwIfFailed();
  }

  /** Queues changes and resolves once everything queued is durable. */
  async flush(
    changes: readonly DelegationTranscriptChange[] = [],
  ): Promise<void> {
    await this.enqueue(changes);
    while (this.running) await this.running;
    this.throwIfFailed();
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure.error;
  }

  private pump(): void {
    if (this.running || this.failure || !this.pending.length) return;
    const batch = this.take();
    this.running = (async (): Promise<void> => {
      try {
        await this.append(batch);
        this.acknowledge(batch);
      } catch (error) {
        this.failure ??= { error };
      } finally {
        this.running = undefined;
        this.waiters.splice(0).forEach((wake) => wake());
        this.pump();
      }
    })();
  }

  private take(): DelegationTranscriptChange[] {
    const ids = new Set<string>();
    let count = 0;
    for (const change of this.pending) {
      if (count === CHILD_APPEND_BATCH_LIMIT || ids.has(change.row.id)) break;
      ids.add(change.row.id);
      count++;
    }
    return this.pending.splice(0, count);
  }
}
