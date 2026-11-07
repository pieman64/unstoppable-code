import { randomUUID } from 'node:crypto';
import type { CanopyStreamCursor } from '@canopy/protocol/canopy-core';
import type {
  ChatStateChangedEvent,
  ChatStateCommandPort,
} from '@canopy/desktop-shared/types';

export interface ChatEventReplayScope {
  projectId: string;
  worktreeId: string;
}

/** Retention bounds (CAN-4111 D5). */
export interface ChatEventReplayLimits {
  /** Batches retained per scope; default 128. */
  perScope: number;
  /** Batches retained across every scope; default 256. */
  total: number;
  /** Scope records kept; default 1,024. */
  scopes: number;
  /** Event ids remembered per scope to drop repeats; default 256. */
  eventIds: number;
}

export type ChatEventReplayResume =
  | { kind: 'replay'; epoch: string; events: readonly ChatStateChangedEvent[] }
  | {
      kind: 'snapshot_required';
      reason: 'foreign_epoch' | 'expired' | 'ahead';
    };

export interface ChatEventReplayListener {
  /** A batch appended to the listener's scope, in revision order, with the scope's epoch. */
  event(event: ChatStateChangedEvent, epoch: string): void;
  /** The scope's epoch changed; the listener is removed and its cursors no longer resume. */
  reset(): void;
}

/**
 * Committed chat batches retained per scope for `core.chat.events` resume
 * (CAN-4111 D3). Cursors are `{ daemonEpoch: <scope epoch>, sequence: <revision> }`.
 */
export interface ChatEventReplayLog {
  /** Subscribes to the current port once. False when there is no port. */
  attach(): boolean;
  /**
   * Call after `attach()` and before reading the scope's snapshot; call the
   * result with the snapshot's revision to get the cursor that resumes after it.
   */
  beginSnapshot(
    scope: ChatEventReplayScope,
  ): (revision: number) => CanopyStreamCursor;
  resume(
    scope: ChatEventReplayScope,
    cursor: CanopyStreamCursor | null,
  ): ChatEventReplayResume;
  follow(
    scope: ChatEventReplayScope,
    listener: ChatEventReplayListener,
  ): () => void;
  /** Unsubscribes from the port and forgets every scope. */
  dispose(): void;
}

interface ScopeRecord {
  epoch: string;
  floor: number | null;
  lastSeen: number | null;
  handedOut: number | null;
  entries: ChatStateChangedEvent[];
  eventIds: Set<string>;
  listeners: Set<ChatEventReplayListener>;
}

const DEFAULT_LIMITS: ChatEventReplayLimits = {
  perScope: 128,
  total: 256,
  scopes: 1024,
  eventIds: 256,
};

function scopeKey(scope: ChatEventReplayScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId]);
}

export function createChatEventReplayLog(
  getPort: () => ChatStateCommandPort | null,
  options: {
    limits?: Partial<ChatEventReplayLimits>;
    /** Log identity in epochs; defaults to `randomUUID`. */
    createId?: () => string;
  } = {},
): ChatEventReplayLog {
  const limits: ChatEventReplayLimits = {
    ...DEFAULT_LIMITS,
    ...options.limits,
  };
  if (
    Object.values(limits).some(
      (value) => !Number.isInteger(value) || value <= 0,
    )
  )
    throw new RangeError('Chat event replay limits must be positive integers.');
  const logId = (options.createId ?? randomUUID)();
  let counter = 0;
  const nextEpoch = (): string => `chat-${logId}-${++counter}`;
  const records = new Map<string, ScopeRecord>();
  // Append order across scopes; slots whose batch left `retained` are stale.
  let fifo: Array<{ key: string; event: ChatStateChangedEvent }> = [];
  const retained = new Set<ChatStateChangedEvent>();
  let attachedPort: ChatStateCommandPort | null = null;
  let unsubscribe: (() => void) | null = null;

  const touch = (key: string, record: ScopeRecord): void => {
    records.delete(key);
    records.set(key, record);
  };
  const dropEntries = (record: ScopeRecord): void => {
    for (const entry of record.entries) retained.delete(entry);
    record.entries = [];
  };
  // Least recently touched first, never a scope with listeners or `keep`.
  const evictScopes = (keep: string | null): void => {
    while (records.size > limits.scopes) {
      let evicted = false;
      for (const [candidateKey, candidate] of records) {
        if (candidateKey === keep || candidate.listeners.size > 0) continue;
        dropEntries(candidate);
        records.delete(candidateKey);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  };
  const recordFor = (key: string): ScopeRecord => {
    const existing = records.get(key);
    if (existing) {
      touch(key, existing);
      return existing;
    }
    const record: ScopeRecord = {
      epoch: nextEpoch(),
      floor: null,
      lastSeen: null,
      handedOut: null,
      entries: [],
      eventIds: new Set<string>(),
      listeners: new Set<ChatEventReplayListener>(),
    };
    records.set(key, record);
    evictScopes(key);
    return record;
  };
  const shiftOldest = (record: ScopeRecord): void => {
    const shifted = record.entries.shift();
    if (!shifted) return;
    retained.delete(shifted);
    record.floor = Math.max(record.floor ?? shifted.revision, shifted.revision);
  };
  const resetListeners = (record: ScopeRecord): void => {
    const listeners = Array.from(record.listeners);
    record.listeners.clear();
    for (const listener of listeners)
      try {
        listener.reset();
      } catch {
        // One listener's failure must not keep the others on the old epoch.
      }
  };
  const rotate = (record: ScopeRecord): void => {
    record.epoch = nextEpoch();
    dropEntries(record);
    record.eventIds.clear();
    record.floor = null;
    record.lastSeen = null;
    record.handedOut = null;
    resetListeners(record);
  };
  const forgetAll = (): void => {
    for (const record of records.values()) resetListeners(record);
    records.clear();
    retained.clear();
    fifo = [];
  };

  const append = (event: ChatStateChangedEvent): void => {
    try {
      if (!(event.revision > event.baseRevision)) return;
      const key = scopeKey(event);
      const record = recordFor(key);
      if (record.eventIds.has(event.eventId)) return;
      const known = record.lastSeen ?? record.floor;
      if (known !== null && event.baseRevision < known) {
        rotate(record);
        record.floor = event.baseRevision;
      } else {
        if (known === null) record.floor = event.baseRevision;
        else if (event.baseRevision > known) {
          dropEntries(record);
          record.floor = event.baseRevision;
        }
      }
      record.entries.push(event);
      record.lastSeen = event.revision;
      record.eventIds.add(event.eventId);
      if (record.eventIds.size > limits.eventIds) {
        const oldest = record.eventIds.values().next();
        if (!oldest.done) record.eventIds.delete(oldest.value);
      }
      retained.add(event);
      fifo.push({ key, event });
      while (record.entries.length > limits.perScope) shiftOldest(record);
      while (retained.size > limits.total) {
        const slot = fifo.shift();
        if (!slot) break;
        if (!retained.has(slot.event)) continue;
        const owner = records.get(slot.key);
        if (owner?.entries[0] === slot.event) shiftOldest(owner);
      }
      // Per-scope and gap drops leave stale slots behind; keep the queue bounded.
      if (fifo.length > limits.total * 2)
        fifo = fifo.filter((slot) => retained.has(slot.event));
      evictScopes(key);
      for (const listener of Array.from(record.listeners))
        try {
          listener.event(event, record.epoch);
        } catch {
          // A failing listener must not reach ChatStateService or other listeners.
        }
    } catch {
      // Never throw into ChatStateService, which would retry the publication.
    }
  };
  // A listener can publish the next batch from inside the fan-out; it waits
  // so every listener sees batches in publication order.
  const queued: ChatStateChangedEvent[] = [];
  let publishing = false;
  const onEvent = (event: ChatStateChangedEvent): void => {
    queued.push(event);
    if (publishing) return;
    publishing = true;
    try {
      for (let next = queued.shift(); next; next = queued.shift()) append(next);
    } finally {
      publishing = false;
    }
  };

  return {
    attach: (): boolean => {
      const port = getPort();
      if (!port) return false;
      if (port === attachedPort) return true;
      if (attachedPort) {
        unsubscribe?.();
        unsubscribe = null;
        forgetAll();
      }
      attachedPort = port;
      unsubscribe = port.subscribe(onEvent);
      return true;
    },
    beginSnapshot: (scope) => {
      const key = scopeKey(scope);
      const sampledRecord = recordFor(key);
      const sampledEpoch = sampledRecord.epoch;
      const known = sampledRecord.lastSeen ?? sampledRecord.floor;
      // A read that starts after a batch or another read completed cannot
      // legitimately return a lower revision.
      const highest = Math.max(
        sampledRecord.lastSeen ?? -1,
        sampledRecord.handedOut ?? -1,
      );
      return (revision): CanopyStreamCursor => {
        const record = recordFor(key);
        // The scope restarted during the read, so the snapshot may belong to
        // either incarnation: hand out an epoch that no longer resumes and let
        // the client read again instead of discarding the new incarnation.
        if (record.epoch !== sampledEpoch)
          return { daemonEpoch: sampledEpoch, sequence: revision };
        // A new incarnation starts again from revision 0, so a batch published
        // during the read rotates the epoch unless the scope's known position
        // was 0 or unknown; then it could be a lagging publication or a new
        // incarnation, and only a second read can tell.
        if ((known ?? 0) === 0 && record.lastSeen !== null)
          return { daemonEpoch: nextEpoch(), sequence: revision };
        if (revision < highest) {
          rotate(record);
          record.floor = revision;
        } else if (record.floor === null) record.floor = revision;
        record.handedOut = Math.max(record.handedOut ?? revision, revision);
        return { daemonEpoch: record.epoch, sequence: revision };
      };
    },
    resume: (scope, cursor): ChatEventReplayResume => {
      const key = scopeKey(scope);
      if (cursor === null) {
        const record = recordFor(key);
        const last = record.entries[record.entries.length - 1];
        return {
          kind: 'replay',
          epoch: record.epoch,
          events: last ? [last] : [],
        };
      }
      const record = records.get(key);
      if (!record || cursor.daemonEpoch !== record.epoch)
        return { kind: 'snapshot_required', reason: 'foreign_epoch' };
      if (
        cursor.sequence >
        Math.max(record.lastSeen ?? -1, record.handedOut ?? -1)
      )
        return { kind: 'snapshot_required', reason: 'ahead' };
      if (record.floor === null || cursor.sequence < record.floor)
        return { kind: 'snapshot_required', reason: 'expired' };
      touch(key, record);
      return {
        kind: 'replay',
        epoch: record.epoch,
        events: record.entries.filter(
          (entry) => entry.revision > cursor.sequence,
        ),
      };
    },
    follow: (scope, listener): (() => void) => {
      const record = recordFor(scopeKey(scope));
      record.listeners.add(listener);
      return (): void => {
        record.listeners.delete(listener);
        evictScopes(null);
      };
    },
    dispose: (): void => {
      unsubscribe?.();
      unsubscribe = null;
      records.clear();
      retained.clear();
      fifo = [];
      queued.length = 0;
      attachedPort = null;
    },
  };
}
