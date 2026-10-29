import {
  CanopyStreamCursorSchema,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';

export interface JournalEntry<E> {
  cursor: CanopyStreamCursor;
  event: E;
}

export type JournalSnapshotReason = 'foreign_epoch' | 'expired' | 'ahead';

export interface EventJournal<E> {
  readonly epoch: string;
  readonly size: number;
  append(event: E): JournalEntry<E>;
  head(): CanopyStreamCursor | null;
  resume(
    cursor?: CanopyStreamCursor | null,
  ):
    | { kind: 'replay'; entries: readonly JournalEntry<E>[] }
    | { kind: 'snapshot_required'; reason: JournalSnapshotReason };
  subscribe(
    cursor: CanopyStreamCursor | null | undefined,
    listener: (entry: JournalEntry<E>) => void,
  ):
    | { kind: 'subscribed'; unsubscribe(): void }
    | { kind: 'snapshot_required'; reason: JournalSnapshotReason };
}

interface Subscriber<E> {
  listener: (entry: JournalEntry<E>) => void;
  queue: JournalEntry<E>[];
  active: boolean;
  delivering: boolean;
}

const DEFAULT_MAX_ENTRIES = 1024;

export function createEventJournal<E>(options: {
  epoch: string;
  maxEntries?: number;
}): EventJournal<E> {
  const { epoch, maxEntries = DEFAULT_MAX_ENTRIES } = options;
  if (!CanopyStreamCursorSchema.shape.daemonEpoch.safeParse(epoch).success)
    throw new RangeError(
      'Event journal epoch must be a valid stream cursor daemonEpoch.',
    );
  if (!Number.isInteger(maxEntries) || maxEntries < 1)
    throw new RangeError(
      'Event journal maxEntries must be a positive integer.',
    );

  const history: JournalEntry<E>[] = [];
  const subscribers = new Set<Subscriber<E>>();
  let lastSequence = 0;

  // Fresh cursor per read so callers can never mutate retained history.
  const copy = (entry: JournalEntry<E>): JournalEntry<E> => ({
    cursor: { ...entry.cursor },
    event: entry.event,
  });

  const latest = (): JournalEntry<E> | undefined => history[history.length - 1];

  const resume: EventJournal<E>['resume'] = (cursor) => {
    if (cursor == null) {
      const last = latest();
      return { kind: 'replay', entries: last ? [copy(last)] : [] };
    }
    if (cursor.daemonEpoch !== epoch)
      return { kind: 'snapshot_required', reason: 'foreign_epoch' };
    const { sequence } = cursor;
    if (sequence > lastSequence)
      return { kind: 'snapshot_required', reason: 'ahead' };
    const oldest = history[0]?.cursor.sequence ?? lastSequence + 1;
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence < oldest - 1
    )
      return { kind: 'snapshot_required', reason: 'expired' };
    return {
      kind: 'replay',
      entries: history.filter((e) => e.cursor.sequence > sequence).map(copy),
    };
  };

  // Per-subscriber queue keeps reentrant appends ordered and gap-free.
  const drain = (subscriber: Subscriber<E>): void => {
    if (subscriber.delivering) return;
    subscriber.delivering = true;
    try {
      while (subscriber.active) {
        const next = subscriber.queue.shift();
        if (!next) break;
        try {
          subscriber.listener(next);
        } catch {
          subscriber.active = false;
          subscribers.delete(subscriber);
        }
      }
    } finally {
      subscriber.delivering = false;
      if (!subscriber.active) subscriber.queue.length = 0;
    }
  };

  return {
    epoch,
    get size(): number {
      return history.length;
    },
    append(event: E): JournalEntry<E> {
      const entry: JournalEntry<E> = {
        cursor: { daemonEpoch: epoch, sequence: ++lastSequence },
        event,
      };
      history.push(entry);
      if (history.length > maxEntries) history.shift();
      // Enqueue for all subscribers before draining any, so a reentrant
      // append from one listener cannot overtake this entry for another.
      const targets = Array.from(subscribers);
      for (const subscriber of targets) subscriber.queue.push(copy(entry));
      for (const subscriber of targets) drain(subscriber);
      return copy(entry);
    },
    head(): CanopyStreamCursor | null {
      const last = latest();
      return last ? { ...last.cursor } : null;
    },
    resume,
    subscribe(cursor, listener): ReturnType<EventJournal<E>['subscribe']> {
      const replay = resume(cursor);
      if (replay.kind === 'snapshot_required') return replay;
      const subscriber: Subscriber<E> = {
        listener,
        queue: [...replay.entries],
        active: true,
        delivering: false,
      };
      subscribers.add(subscriber);
      drain(subscriber);
      return {
        kind: 'subscribed',
        unsubscribe(): void {
          subscriber.active = false;
          subscribers.delete(subscriber);
          if (!subscriber.delivering) subscriber.queue.length = 0;
        },
      };
    },
  };
}
