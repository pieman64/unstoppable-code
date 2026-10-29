// Browser-safe: no Node or host dependencies.
import type {
  CanopyErrorKind,
  CanopyEvent,
  CanopyRetryDirective,
  CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import { CanopyClientError } from '../errors';
import { encodedSize } from '../stream-budget';
import type { CanopyEventDelivery, CanopyEventPriority } from './types';

export interface CanopyEventLedgerOptions {
  /** Output events held queued or in flight. */
  maxBufferedOutput: number;
  /** UTF-8 JSON bytes of output events held queued or in flight. */
  maxBufferedOutputBytes: number;
  /** Received sequences above the cursor, including settled and gapped ones. */
  maxPendingEvents: number;
}

/** Hand `delivery` to the consumer, then `settle` it once durably handled. */
export interface CanopyEventLedgerEntry {
  readonly delivery: CanopyEventDelivery;
}

interface Slot {
  cursor: CanopyStreamCursor;
  settled: boolean;
}
interface QueuedEvent {
  kind: 'event';
  event: CanopyEvent;
  priority: CanopyEventPriority;
  bytes: number;
  slot: Slot;
}
/** `from`/`to` are the first and last dropped cursors; sequences may be sparse. */
interface QueuedGap {
  kind: 'gap';
  from: CanopyStreamCursor;
  to: CanopyStreamCursor;
  slots: Slot[];
}
type Queued = QueuedEvent | QueuedGap;

function ledgerError(
  kind: CanopyErrorKind,
  message: string,
  retry: CanopyRetryDirective = { kind: 'never' },
): CanopyClientError {
  return new CanopyClientError({ kind, message, retry });
}

function copyCursor(cursor: CanopyStreamCursor): CanopyStreamCursor {
  return { daemonEpoch: cursor.daemonEpoch, sequence: cursor.sequence };
}

function copyNullableCursor(
  cursor: CanopyStreamCursor | null,
): CanopyStreamCursor | null {
  return cursor && copyCursor(cursor);
}

/** Fresh cursors: consumer mutation must not reach ledger state. */
function deliveryOf(queued: Queued): CanopyEventDelivery {
  if (queued.kind === 'event') {
    const event = { ...queued.event, cursor: copyCursor(queued.event.cursor) };
    return { kind: 'event', event, priority: queued.priority };
  }
  const { from, to, slots } = queued;
  return {
    kind: 'gap',
    from: copyCursor(from),
    to: copyCursor(to),
    dropped: slots.length,
  };
}

/**
 * Bounded ledger for one stream. Lifecycle events and output gaps are taken
 * before queued output, each lane in receive order. The cursor advances only
 * across the settled prefix of received sequences.
 */
export class CanopyEventLedger {
  private epoch: string | null;
  private lastReceived: number;
  private current: CanopyStreamCursor | null;
  private readonly slots: Slot[] = [];
  private readonly bySequence = new Map<number, Slot>();
  private readonly priorityLane: Queued[] = [];
  private readonly outputLane: QueuedEvent[] = [];
  private openGap: QueuedGap | null = null;
  private readonly inFlight = new Map<CanopyEventLedgerEntry, Queued>();
  private outputCount = 0;
  private outputBytes = 0;

  public constructor(
    private readonly options: CanopyEventLedgerOptions,
    cursor: CanopyStreamCursor | null,
  ) {
    const limits = Object.values(options);
    if (
      !limits.every((limit) => Number.isSafeInteger(limit) && limit >= 0) ||
      options.maxPendingEvents < 1
    )
      throw ledgerError('invalid_argument', 'Invalid event ledger limits.');
    this.current = copyNullableCursor(cursor);
    this.epoch = cursor?.daemonEpoch ?? null;
    this.lastReceived = this.committed;
  }

  /** Highest cursor at or below which every received event is settled. */
  public get cursor(): CanopyStreamCursor | null {
    return copyNullableCursor(this.current);
  }

  public get pendingEvents(): number {
    return this.slots.length;
  }

  public get bufferedOutput(): number {
    return this.outputCount;
  }

  public get bufferedOutputBytes(): number {
    return this.outputBytes;
  }

  private get committed(): number {
    return this.current?.sequence ?? -1;
  }

  /** Ignores redeliveries; throws before accepting anything it cannot hold. */
  public enqueue(received: CanopyEvent, priority: CanopyEventPriority): void {
    const cursor = copyCursor(received.cursor);
    if (this.epoch !== null && cursor.daemonEpoch !== this.epoch)
      throw ledgerError('failed_precondition', 'Event epoch changed.');
    if (cursor.sequence <= this.lastReceived) {
      if (cursor.sequence <= this.committed) return;
      if (this.bySequence.has(cursor.sequence)) return;
      throw ledgerError('failed_precondition', 'Event arrived out of order.');
    }
    if (this.slots.length >= this.options.maxPendingEvents)
      throw ledgerError('resource_exhausted', 'Event ledger is full.', {
        kind: 'after_refresh',
        resource: 'core.events',
      });
    this.epoch = cursor.daemonEpoch;
    this.lastReceived = cursor.sequence;
    const slot: Slot = { cursor, settled: false };
    const event = { ...received, cursor: copyCursor(cursor) };
    this.slots.push(slot);
    this.bySequence.set(cursor.sequence, slot);
    const bytes = priority === 'output' ? encodedSize(event) : 0;
    const queued: QueuedEvent = { kind: 'event', event, priority, bytes, slot };
    if (priority === 'lifecycle') {
      this.priorityLane.push(queued);
      return;
    }
    this.outputLane.push(queued);
    this.outputCount += 1;
    this.outputBytes += bytes;
    this.evictOverflow();
  }

  /** Never preempts in-flight entries; they stay charged until settled. */
  public take(): CanopyEventLedgerEntry | null {
    const next = this.priorityLane.shift() ?? this.outputLane.shift();
    if (!next) return null;
    if (next === this.openGap) this.openGap = null;
    const entry: CanopyEventLedgerEntry = { delivery: deliveryOf(next) };
    this.inFlight.set(entry, next);
    return entry;
  }

  /** Returns the advanced cursor, or null when the settled prefix did not grow. */
  public settle(entry: CanopyEventLedgerEntry): CanopyStreamCursor | null {
    const settled = this.inFlight.get(entry);
    if (!settled) throw ledgerError('internal', 'Entry is not in flight.');
    this.inFlight.delete(entry);
    const slots = settled.kind === 'gap' ? settled.slots : [settled.slot];
    for (const slot of slots) slot.settled = true;
    if (settled.kind === 'event' && settled.priority === 'output') {
      this.outputCount -= 1;
      this.outputBytes -= settled.bytes;
    }
    const before = this.current;
    for (let head = this.slots[0]; head?.settled; head = this.slots[0]) {
      this.slots.shift();
      this.bySequence.delete(head.cursor.sequence);
      this.current = head.cursor;
    }
    return this.current === before ? null : copyNullableCursor(this.current);
  }

  private evictOverflow(): void {
    const { maxBufferedOutput, maxBufferedOutputBytes } = this.options;
    while (
      this.outputCount > maxBufferedOutput ||
      this.outputBytes > maxBufferedOutputBytes
    ) {
      const oldest = this.outputLane.shift();
      if (!oldest) return;
      this.outputCount -= 1;
      this.outputBytes -= oldest.bytes;
      const { cursor } = oldest.slot;
      if (this.openGap) {
        this.openGap.to = cursor;
        this.openGap.slots.push(oldest.slot);
        continue;
      }
      const slots = [oldest.slot];
      this.openGap = { kind: 'gap', from: cursor, to: cursor, slots };
      this.priorityLane.push(this.openGap);
    }
  }
}
