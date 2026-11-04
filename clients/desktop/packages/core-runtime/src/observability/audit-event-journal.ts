import type {
  AgentAuditEntry,
  AgentObservabilityUpdateEvent,
} from '@canopy/protocol/observability';

/** Audit changes since a cursor, or why the caller must start again. */
export type AuditJournalReplay =
  | { kind: 'changes'; items: AuditJournalItem[] }
  | { kind: 'overview'; sequence: number }
  | { kind: 'foreign' };

export type AuditJournalItem =
  | { sequence: number; kind: 'entries'; entries: AgentAuditEntry[] }
  | { sequence: number; kind: 'retention'; retentionDays: number }
  | { sequence: number; kind: 'overview' };

export interface AuditEventFeed {
  readonly retentionDays: () => number;
  subscribe(
    listener: (event: AgentObservabilityUpdateEvent) => void,
  ): () => void;
}

const DEFAULT_CAPACITY = 1_000;

/**
 * Numbers every audit change one ingest host publishes, so a client that
 * reconnects with its last cursor receives each entry that changed since, in
 * its latest state, including terminal states it missed. Usage-overview
 * events are provider account state and are not journaled.
 *
 * The epoch names this journal; a cursor from another epoch cannot resume.
 * An overview (a purge, a retention change or a restart of the ingest) or an
 * evicted entry raises the floor, and a cursor below it resumes from a fresh
 * overview instead of a partial replay.
 */
export class AuditEventJournal {
  readonly epoch: string;
  private sequence = 0;
  private floor = 0;
  private retention: { days: number; sequence: number };
  private readonly changed = new Map<
    string,
    { entry: AgentAuditEntry; sequence: number }
  >();
  private readonly listeners = new Set<(item: AuditJournalItem) => void>();
  private readonly capacity: number;
  private readonly unsubscribe: () => void;

  constructor(
    feed: AuditEventFeed,
    options: { epoch: string; capacity?: number },
  ) {
    this.epoch = options.epoch;
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.retention = { days: feed.retentionDays(), sequence: 0 };
    this.unsubscribe = feed.subscribe((event) => this.apply(event));
  }

  get currentSequence(): number {
    return this.sequence;
  }

  /** Listens for each journaled change, in sequence order. */
  listen(listener: (item: AuditJournalItem) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  replaySince(cursor: { epoch: string; sequence: number }): AuditJournalReplay {
    if (cursor.epoch !== this.epoch || cursor.sequence > this.sequence) {
      return { kind: 'foreign' };
    }
    if (cursor.sequence < this.floor) {
      return { kind: 'overview', sequence: this.sequence };
    }
    const bySequence = new Map<number, AuditJournalItem>();
    for (const { entry, sequence } of this.changed.values()) {
      if (sequence <= cursor.sequence) continue;
      const item = bySequence.get(sequence);
      if (item?.kind === 'entries') item.entries.push(entry);
      else
        bySequence.set(sequence, {
          sequence,
          kind: 'entries',
          entries: [entry],
        });
    }
    if (this.retention.sequence > cursor.sequence) {
      bySequence.set(this.retention.sequence, {
        sequence: this.retention.sequence,
        kind: 'retention',
        retentionDays: this.retention.days,
      });
    }
    return {
      kind: 'changes',
      items: Array.from(bySequence.values()).sort(
        (left, right) => left.sequence - right.sequence,
      ),
    };
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  private apply(event: AgentObservabilityUpdateEvent): void {
    switch (event.type) {
      case 'entries': {
        if (event.entries.length === 0) return;
        const sequence = this.next();
        for (const entry of event.entries) {
          this.changed.delete(entry.id);
          this.changed.set(entry.id, { entry, sequence });
        }
        this.evict();
        this.publish({ sequence, kind: 'entries', entries: event.entries });
        return;
      }
      case 'retention': {
        const sequence = this.next();
        this.retention = { days: event.retentionDays, sequence };
        this.publish({
          sequence,
          kind: 'retention',
          retentionDays: event.retentionDays,
        });
        return;
      }
      case 'snapshot': {
        const sequence = this.next();
        this.changed.clear();
        this.floor = sequence;
        this.retention = { days: event.snapshot.retentionDays, sequence };
        this.publish({ sequence, kind: 'overview' });
        return;
      }
      case 'usage':
        return;
    }
  }

  private next(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private evict(): void {
    while (this.changed.size > this.capacity) {
      const oldest = this.changed.entries().next().value;
      if (oldest === undefined) return;
      const [id, { sequence }] = oldest;
      this.changed.delete(id);
      this.floor = Math.max(this.floor, sequence);
    }
  }

  private publish(item: AuditJournalItem): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(item);
      } catch {
        // One failing stream must not stop the ingest's other listeners.
      }
    }
  }
}
