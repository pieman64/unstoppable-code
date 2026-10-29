import type {
  PortalCommandFailedPayload,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import { randomUUID } from 'node:crypto';
import { isPortalEventForeground } from './portal-event-routing';
import {
  getPortalEventCoworkIdentity,
  getPortalEventLane,
  getPortalEventWorktreeIdentity,
  type PortalCoworkIdentity,
} from './portal-event-routing';

export interface PortalOutboxTrimResult {
  kept: PortalEventEnvelope[];
  droppedCount: number;
  droppedChatEventCount: number;
  droppedRangeCount: number;
  /**
   * Superseded snapshots removed because a newer snapshot for the same
   * scope+target was queued behind them. Counted apart from the drop
   * counters: the newer snapshot replaces them wholesale, so this is
   * reclaimed waste, not lost state.
   */
  coalescedSnapshotCount: number;
  /** Which budget forced drops; null when nothing was dropped. */
  trimReason: 'count' | 'bytes' | null;
  /** Dropped events by type, for triage. */
  droppedEventTypes: Record<string, number>;
  /** Dropped `:chunk-N` parts of split snapshots. */
  droppedChunkCount: number;
  /**
   * Delivery groups of `portal.state.request` commands (named by the
   * `stateRequestCommandIds` option) dropped whole by this trim. Other
   * commands keep their real terminal events.
   */
  droppedCommandGroups: PortalDroppedCommandGroup[];
}

export interface PortalDroppedCommandGroup {
  commandId: string;
  eventCount: number;
  chunkCount: number;
  eventTypes: Record<string, number>;
  /**
   * True when the group's terminal event is still queued (a completion is
   * replaced by a retryable failure). False means the caller must fail the
   * completion when it is enqueued later.
   */
  failureQueued: boolean;
  /** The queued terminal that now stands for the command, when there is one. */
  failureEvent?: PortalEventEnvelope;
}

export interface PortalRoutingStamp {
  key: string;
  seq: number;
}

export interface PortalSnapshotSplitResult {
  events: PortalEventEnvelope[];
  droppedEntityCount: number;
  droppedEntityMarker: PortalEventEnvelope | null;
}

interface DroppedRange {
  /** Null when the lane is not backed by a code-worktree identity. */
  identity: { workspaceLocalId: string; worktreeLocalId: string } | null;
  /** Owning cowork Work Entry for standalone-chat lanes. */
  coworkIdentity: PortalCoworkIdentity | null;
  /** Standalone chats observed in this dropped range. */
  standaloneChatLocalIds: string[];
  truncatedStandaloneChatCount: number;
  key: string;
  fromSeq: number;
  toSeq: number;
}

const PORTAL_DROPPED_MARKER_ID_MAX_CHARS = 512;
const PORTAL_AGGREGATE_DROPPED_MARKER_MAX_KEYS = 100;
const PORTAL_DROPPED_MARKER_MAX_STANDALONE_CHATS = 100;
const PORTAL_DROPPED_MARKER_MAX_ENTITY_IDS = 100;

interface CoworkDroppedLaneMarker {
  key: string;
  projectLocalId: string;
  workEntryId: string;
  standaloneChatLocalIds: string[];
  truncatedStandaloneChatCount: number;
}

function mergeCoworkDroppedLaneMarkers(
  left: CoworkDroppedLaneMarker,
  right: CoworkDroppedLaneMarker,
): CoworkDroppedLaneMarker {
  const allChatIds = Array.from(
    new Set([...left.standaloneChatLocalIds, ...right.standaloneChatLocalIds]),
  );
  const standaloneChatLocalIds = allChatIds.slice(
    0,
    PORTAL_DROPPED_MARKER_MAX_STANDALONE_CHATS,
  );
  return {
    ...left,
    standaloneChatLocalIds,
    truncatedStandaloneChatCount:
      left.truncatedStandaloneChatCount +
      right.truncatedStandaloneChatCount +
      (allChatIds.length - standaloneChatLocalIds.length),
  };
}

function truncateDroppedMarkerIdentifier(value: string): string {
  if (value.length <= PORTAL_DROPPED_MARKER_ID_MAX_CHARS) return value;
  return value.slice(0, PORTAL_DROPPED_MARKER_ID_MAX_CHARS);
}

function coworkDroppedLaneMarker(
  range: DroppedRange,
): CoworkDroppedLaneMarker | null {
  if (!range.coworkIdentity) return null;
  const standaloneChatLocalIds = range.standaloneChatLocalIds
    .map(truncateDroppedMarkerIdentifier)
    .slice(0, PORTAL_DROPPED_MARKER_MAX_STANDALONE_CHATS);
  return {
    key: truncateDroppedMarkerIdentifier(range.key),
    projectLocalId: truncateDroppedMarkerIdentifier(
      range.coworkIdentity.coworkWorkspaceLocalId,
    ),
    workEntryId: truncateDroppedMarkerIdentifier(
      range.coworkIdentity.workEntryId,
    ),
    standaloneChatLocalIds,
    truncatedStandaloneChatCount:
      range.truncatedStandaloneChatCount +
      (range.standaloneChatLocalIds.length - standaloneChatLocalIds.length),
  };
}

export function shouldRecordPortalOutboxLatency(
  oldestEventAgeMs: number,
  acknowledgedAt: number,
  lastRecordedAt: number,
): boolean {
  return oldestEventAgeMs > 2_000 || acknowledgedAt - lastRecordedAt >= 30_000;
}

/**
 * Minimum spacing between `portal_outbox_overflow_trimmed` records that report
 * ONLY reclaimed snapshots (no drops).
 */
export const PORTAL_COALESCE_DIAGNOSTIC_INTERVAL_MS = 60_000;

/**
 * Whether a reclaim-only trim should record a diagnostic. The trim runs on
 * every enqueue and coalescing fires on most of them once snapshots start
 * superseding each other, so recording each one would add an app-diagnostic
 * write per event — IO pressure on the very subsystem this reclaim relieves.
 * Overflow drops are rare and unrecoverable, so callers record those every
 * time; only the routine reclaim is throttled. A backwards clock jump records
 * rather than latching the diagnostic off.
 */
export function shouldRecordPortalCoalesceDiagnostic(
  nowMs: number,
  lastRecordedAtMs: number,
): boolean {
  const elapsed = nowMs - lastRecordedAtMs;
  return elapsed >= PORTAL_COALESCE_DIAGNOSTIC_INTERVAL_MS || elapsed < 0;
}

export function preservePortalEventTimestamp(
  original: PortalEventEnvelope,
  replacement: PortalEventEnvelope,
  timestamps: WeakMap<PortalEventEnvelope, number>,
): PortalEventEnvelope {
  if (replacement !== original) {
    const timestamp = timestamps.get(original);
    if (timestamp !== undefined) {
      timestamps.set(replacement, timestamp);
    }
  }
  return replacement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Command completion/failure control events. They carry no entity state and
 * no routing identity — just the ~200-byte correlation signal the browser's
 * wait-for-result path blocks on — so the outbox treats them specially: batch
 * selection promotes them past bulk lanes (CAN-2360 control lane) and the
 * overflow trim only drops them as a last resort.
 *
 * NOTE: this predicate extraction, the trim's last-resort ordering, and the
 * control-only labeling of the upload-latency diagnostic all ship UNFLAGGED —
 * they are independent of canopyPortalAsyncSnapshots and active for every
 * session.
 */
export function isPortalControlEvent(event: PortalEventEnvelope): boolean {
  return (
    event.type === 'portal.command.completed' ||
    event.type === 'portal.command.failed'
  );
}

function isPortalStateEvent(event: PortalEventEnvelope): boolean {
  return (
    event.type === 'portal.state.snapshot' ||
    event.type === 'portal.state.delta'
  );
}

const PORTAL_SPLIT_CHUNK_SUFFIX = /:chunk-\d+$/;

function isPortalSplitChunk(event: PortalEventEnvelope): boolean {
  return PORTAL_SPLIT_CHUNK_SUFFIX.test(event.eventId);
}

/**
 * Events delivered or dropped together: every non-control event of one
 * command (snapshot head, `:chunk-N` parts, follow-ups), or the parts of one
 * uncorrelated split snapshot. Control events stay individual so a dropped
 * group's terminal can be rewritten instead of lost.
 */
function portalDeliveryGroupKey(event: PortalEventEnvelope): string {
  if (isPortalControlEvent(event)) return `control\u0000${event.eventId}`;
  if (event.commandId) return `command\u0000${event.commandId}`;
  return `event\u0000${event.eventId.replace(PORTAL_SPLIT_CHUNK_SUFFIX, '')}`;
}

/**
 * Terminal sent instead of a state request's completion when its snapshot
 * never reached the server: the browser must re-request, not wait on data
 * that will not arrive.
 */
function createPortalUndeliveredStateFailure(
  terminal: PortalEventEnvelope,
): PortalEventEnvelope {
  const payload = isRecord(terminal.payload) ? terminal.payload : {};
  const commandId =
    terminal.commandId ??
    (typeof payload.commandId === 'string' ? payload.commandId : '');
  const failure: PortalCommandFailedPayload = {
    commandId,
    sequenceNumber:
      typeof payload.sequenceNumber === 'number' ? payload.sequenceNumber : 0,
    error: {
      code: 'execution_failed',
      message: 'The requested state could not be delivered. Try again.',
    },
    retryable: true,
    generatedAt: new Date().toISOString(),
  };
  const eventId = `${terminal.eventId}:undelivered`;
  return {
    type: 'portal.command.failed',
    commandId,
    eventId,
    clientEventId: eventId,
    occurredAt: new Date().toISOString(),
    payload: failure,
  };
}

/**
 * Applies an earlier trim to events of a dropped state request that are
 * enqueued afterwards: later parts are discarded (they would be partial) and
 * its completion becomes a retryable failure. Returns null to discard.
 * `droppedStateRequestIds` must hold only `portal.state.request` commands, as
 * reported by `droppedCommandGroups`; any other command passes through.
 */
export function resolvePortalDroppedCommandEvent(
  event: PortalEventEnvelope,
  droppedStateRequestIds: Set<string>,
): PortalEventEnvelope | null {
  if (!event.commandId || !droppedStateRequestIds.has(event.commandId)) {
    return event;
  }
  if (!isPortalControlEvent(event)) return null;
  droppedStateRequestIds.delete(event.commandId);
  return event.type === 'portal.command.completed'
    ? createPortalUndeliveredStateFailure(event)
    : event;
}

export function getPortalRoutingStamp(
  event: PortalEventEnvelope,
): PortalRoutingStamp | null {
  if (!isRecord(event.payload) || !isRecord(event.payload.routing)) {
    return null;
  }
  const key = event.payload.routing.key;
  const seq = event.payload.routing.seq;
  return typeof key === 'string' &&
    typeof seq === 'number' &&
    Number.isSafeInteger(seq)
    ? { key, seq }
    : null;
}

export function stampPortalEventRouting(
  event: PortalEventEnvelope,
  counters: Map<string, number>,
): PortalEventEnvelope {
  const lane = getPortalEventLane(event);
  if (!lane || !isRecord(event.payload)) return event;
  // Replayed events (completed-command replay, restore paths) already carry
  // their original stamp and are deduplicated server-side by eventId — a
  // fresh seq would be allocated but never delivered, leaving a permanent
  // false hole at the receiver. Keep the original stamp and only advance the
  // counter floor.
  const existingStamp = getPortalRoutingStamp(event);
  if (existingStamp !== null) {
    counters.set(
      lane.counterKey,
      Math.max(counters.get(lane.counterKey) ?? 0, existingStamp.seq),
    );
    return event;
  }
  const seq = (counters.get(lane.counterKey) ?? 0) + 1;
  counters.set(lane.counterKey, seq);
  return {
    ...event,
    payload: {
      ...event.payload,
      routing: {
        key: lane.key,
        seq,
      },
    },
  };
}

export function restorePortalRoutingSequenceCounters(
  persisted: Record<string, number> | undefined,
  events: PortalEventEnvelope[],
): Map<string, number> {
  const counters = new Map(Object.entries(persisted ?? {}));
  for (const event of events) {
    const lane = getPortalEventLane(event);
    const stamp = getPortalRoutingStamp(event);
    if (!lane || !stamp) continue;
    counters.set(
      lane.counterKey,
      Math.max(counters.get(lane.counterKey) ?? 0, stamp.seq),
    );
  }
  return counters;
}

function getDroppedRange(event: PortalEventEnvelope): DroppedRange | null {
  if (
    String(event.type) !== 'portal.events.dropped' ||
    !isRecord(event.payload)
  ) {
    return null;
  }
  const routing = isRecord(event.payload.routing)
    ? event.payload.routing
    : null;
  const identity = getPortalEventWorktreeIdentity(event);
  const coworkWorkspaceLocalId =
    typeof event.payload.projectLocalId === 'string'
      ? event.payload.projectLocalId
      : typeof event.payload.projectId === 'string'
        ? event.payload.projectId
        : undefined;
  const coworkIdentity =
    coworkWorkspaceLocalId && typeof event.payload.workEntryId === 'string'
      ? {
          coworkWorkspaceLocalId,
          workEntryId: event.payload.workEntryId,
        }
      : null;
  const standaloneChatLocalIds = Array.isArray(
    event.payload.standaloneChatLocalIds,
  )
    ? event.payload.standaloneChatLocalIds.filter(
        (chatId): chatId is string => typeof chatId === 'string' && !!chatId,
      )
    : [];
  const truncatedStandaloneChatCount =
    typeof event.payload.truncatedStandaloneChatCount === 'number'
      ? Math.max(0, event.payload.truncatedStandaloneChatCount)
      : 0;
  const fromSeq = event.payload.fromSeq;
  const toSeq = event.payload.toSeq;
  if (
    !routing ||
    typeof routing.key !== 'string' ||
    typeof fromSeq !== 'number' ||
    typeof toSeq !== 'number'
  ) {
    return null;
  }
  return {
    identity,
    coworkIdentity,
    standaloneChatLocalIds,
    truncatedStandaloneChatCount,
    key: routing.key,
    fromSeq,
    toSeq,
  };
}

function droppedRangeForStampedEvent(
  event: PortalEventEnvelope,
  stamp: PortalRoutingStamp,
): DroppedRange {
  const coworkIdentity = getPortalEventCoworkIdentity(event);
  const chatId =
    coworkIdentity &&
    isRecord(event.payload) &&
    typeof event.payload.chatId === 'string'
      ? event.payload.chatId
      : undefined;
  return {
    identity: getPortalEventWorktreeIdentity(event),
    coworkIdentity,
    standaloneChatLocalIds: chatId ? [chatId] : [],
    truncatedStandaloneChatCount: 0,
    key: stamp.key,
    fromSeq: stamp.seq,
    toSeq: stamp.seq,
  };
}

function mergeDroppedRanges(
  left: DroppedRange,
  right: DroppedRange,
): DroppedRange {
  return {
    ...left,
    identity: left.identity ?? right.identity,
    coworkIdentity: left.coworkIdentity ?? right.coworkIdentity,
    standaloneChatLocalIds: Array.from(
      new Set([
        ...left.standaloneChatLocalIds,
        ...right.standaloneChatLocalIds,
      ]),
    ),
    truncatedStandaloneChatCount:
      left.truncatedStandaloneChatCount + right.truncatedStandaloneChatCount,
    fromSeq: Math.min(left.fromSeq, right.fromSeq),
    toSeq: Math.max(left.toSeq, right.toSeq),
  };
}

export function createDroppedRangeMarkers(input: {
  kept: PortalEventEnvelope[];
  dropped: PortalEventEnvelope[];
  reason: 'overflow' | 'oversized';
  createEventId: () => string;
  enqueuedAt?: WeakMap<PortalEventEnvelope, number>;
  now?: number;
  maxEvents?: number;
}): { events: PortalEventEnvelope[]; markerCount: number } {
  const ranges = new Map<string, DroppedRange>();
  const oldestDroppedAt = new Map<string, number>();
  const lastDroppedOrder = new Map<string, number>();
  const inheritedAggregateKeys = new Set<string>();
  const inheritedCoworkLanes = new Map<string, CoworkDroppedLaneMarker>();
  let inheritedTruncatedKeyCount = 0;
  let inheritedAggregateStampMs: number | null = null;
  let refreshAll = false;
  for (let dropOrder = 0; dropOrder < input.dropped.length; dropOrder += 1) {
    const event = input.dropped[dropOrder];
    // A dropped AGGREGATE marker has no per-key ranges — its loss coverage
    // must be inherited into the replacement aggregate, or the resync signal
    // for its keys is silently lost across consecutive trims.
    if (
      String(event.type) === 'portal.events.dropped' &&
      isRecord(event.payload) &&
      event.payload.aggregate === true
    ) {
      if (Array.isArray(event.payload.keys)) {
        for (const key of event.payload.keys) {
          if (typeof key === 'string') {
            inheritedAggregateKeys.add(key);
          }
        }
      }
      if (Array.isArray(event.payload.coworkLanes)) {
        for (const value of event.payload.coworkLanes) {
          if (!isRecord(value)) continue;
          const key = value.key;
          const projectLocalId = value.projectLocalId;
          const workEntryId = value.workEntryId;
          if (
            typeof key !== 'string' ||
            typeof projectLocalId !== 'string' ||
            typeof workEntryId !== 'string'
          ) {
            continue;
          }
          const standaloneChatLocalIds = Array.isArray(
            value.standaloneChatLocalIds,
          )
            ? value.standaloneChatLocalIds.filter(
                (chatId): chatId is string =>
                  typeof chatId === 'string' && !!chatId,
              )
            : [];
          const lane: CoworkDroppedLaneMarker = {
            key,
            projectLocalId,
            workEntryId,
            standaloneChatLocalIds,
            truncatedStandaloneChatCount:
              typeof value.truncatedStandaloneChatCount === 'number'
                ? Math.max(0, value.truncatedStandaloneChatCount)
                : 0,
          };
          const existing = inheritedCoworkLanes.get(key);
          inheritedCoworkLanes.set(
            key,
            existing ? mergeCoworkDroppedLaneMarkers(existing, lane) : lane,
          );
        }
      }
      if (typeof event.payload.truncatedKeyCount === 'number') {
        inheritedTruncatedKeyCount += event.payload.truncatedKeyCount;
      }
      const inheritedStamp = input.enqueuedAt?.get(event);
      if (inheritedStamp !== undefined) {
        inheritedAggregateStampMs = Math.min(
          inheritedAggregateStampMs ?? inheritedStamp,
          inheritedStamp,
        );
      }
      continue;
    }
    const stamp = getPortalRoutingStamp(event);
    const marker = getDroppedRange(event);
    const range = stamp ? droppedRangeForStampedEvent(event, stamp) : marker;
    if (!range) {
      // Unrouted state (overview, workspace) has no lane to resync, so its
      // loss can only be repaired by refreshing everything.
      if (isPortalStateEvent(event)) {
        refreshAll = true;
        const droppedAt = input.enqueuedAt?.get(event);
        if (droppedAt !== undefined) {
          inheritedAggregateStampMs = Math.min(
            inheritedAggregateStampMs ?? droppedAt,
            droppedAt,
          );
        }
      }
      continue;
    }
    lastDroppedOrder.set(range.key, dropOrder);
    const droppedAt = input.enqueuedAt?.get(event);
    if (droppedAt !== undefined) {
      oldestDroppedAt.set(
        range.key,
        Math.min(oldestDroppedAt.get(range.key) ?? droppedAt, droppedAt),
      );
    }
    const existing = ranges.get(range.key);
    ranges.set(
      range.key,
      existing ? mergeDroppedRanges(existing, range) : range,
    );
  }
  if (refreshAll) inheritedTruncatedKeyCount += 1;
  if (
    ranges.size === 0 &&
    inheritedAggregateKeys.size === 0 &&
    inheritedTruncatedKeyCount === 0
  ) {
    return { events: input.kept, markerCount: 0 };
  }

  for (const event of input.kept) {
    const marker = getDroppedRange(event);
    if (!marker || !ranges.has(marker.key)) continue;
    const existing = ranges.get(marker.key);
    if (!existing) continue;
    ranges.set(marker.key, mergeDroppedRanges(existing, marker));
  }
  const events = input.kept.filter((event) => {
    const marker = getDroppedRange(event);
    return !marker || !ranges.has(marker.key);
  });
  const markerCapacity = Math.max(
    0,
    (input.maxEvents ?? Number.MAX_SAFE_INTEGER) - events.length,
  );
  const orderedRanges = Array.from(ranges.values()).sort(
    (left, right) =>
      (lastDroppedOrder.get(left.key) ?? -1) -
      (lastDroppedOrder.get(right.key) ?? -1),
  );
  // Inherited aggregate coverage forces an aggregate marker even when every
  // fresh range would otherwise fit as an individual marker.
  const needsAggregate =
    inheritedAggregateKeys.size > 0 ||
    inheritedTruncatedKeyCount > 0 ||
    orderedRanges.length > markerCapacity;
  const aggregateRangeCount = needsAggregate
    ? Math.max(0, orderedRanges.length - Math.max(0, markerCapacity - 1))
    : 0;
  const aggregateRanges = orderedRanges.slice(0, aggregateRangeCount);
  const individualRanges = orderedRanges.slice(aggregateRangeCount);
  if (needsAggregate) {
    const combinedKeys = new Set<string>();
    const coworkLanesByKey = new Map(inheritedCoworkLanes);
    inheritedAggregateKeys.forEach((key) => {
      combinedKeys.add(truncateDroppedMarkerIdentifier(key));
    });
    for (const range of aggregateRanges) {
      const key = truncateDroppedMarkerIdentifier(range.key);
      combinedKeys.add(key);
      const coworkLane = coworkDroppedLaneMarker(range);
      if (coworkLane) {
        const inherited = coworkLanesByKey.get(key);
        coworkLanesByKey.set(
          key,
          inherited
            ? mergeCoworkDroppedLaneMarkers(inherited, coworkLane)
            : coworkLane,
        );
      }
    }
    const keys = Array.from(combinedKeys).slice(
      0,
      PORTAL_AGGREGATE_DROPPED_MARKER_MAX_KEYS,
    );
    const coworkLanes = keys.flatMap((key) => {
      const coworkLane = coworkLanesByKey.get(key);
      return coworkLane ? [coworkLane] : [];
    });
    const marker: PortalEventEnvelope = {
      type: 'portal.heartbeat',
      eventId: input.createEventId(),
      occurredAt: new Date().toISOString(),
      payload: {
        aggregate: true,
        keys,
        ...(coworkLanes.length > 0 ? { coworkLanes } : {}),
        truncatedKeyCount:
          inheritedTruncatedKeyCount + (combinedKeys.size - keys.length),
        reason: input.reason,
      },
    };
    Reflect.set(marker, 'type', 'portal.events.dropped');
    const rangeStamps = aggregateRanges.map(
      (range) => oldestDroppedAt.get(range.key) ?? input.now ?? Date.now(),
    );
    const stampCandidates = [
      ...rangeStamps,
      ...(inheritedAggregateStampMs !== null
        ? [inheritedAggregateStampMs]
        : []),
    ];
    input.enqueuedAt?.set(
      marker,
      stampCandidates.length > 0
        ? Math.min(...stampCandidates)
        : (input.now ?? Date.now()),
    );
    events.push(marker);
  }
  for (const range of individualRanges) {
    const routingKey = truncateDroppedMarkerIdentifier(range.key);
    const coworkLane = coworkDroppedLaneMarker(range);
    const marker: PortalEventEnvelope = {
      type: 'portal.heartbeat',
      eventId: input.createEventId(),
      occurredAt: new Date().toISOString(),
      payload: {
        ...(range.identity
          ? {
              workspaceLocalId: truncateDroppedMarkerIdentifier(
                range.identity.workspaceLocalId,
              ),
              worktreeLocalId: truncateDroppedMarkerIdentifier(
                range.identity.worktreeLocalId,
              ),
            }
          : {}),
        ...(coworkLane
          ? {
              scope: 'standalone',
              projectLocalId: coworkLane.projectLocalId,
              projectId: coworkLane.projectLocalId,
              workEntryId: coworkLane.workEntryId,
              standaloneChatLocalIds: coworkLane.standaloneChatLocalIds,
              truncatedStandaloneChatCount:
                coworkLane.truncatedStandaloneChatCount,
            }
          : {}),
        routing: { key: routingKey },
        fromSeq: range.fromSeq,
        toSeq: range.toSeq,
        reason: input.reason,
      },
    };
    Reflect.set(marker, 'type', 'portal.events.dropped');
    input.enqueuedAt?.set(
      marker,
      oldestDroppedAt.get(range.key) ?? input.now ?? Date.now(),
    );
    const firstLaterSameKey = events.findIndex((event) => {
      const stamp = getPortalRoutingStamp(event);
      return stamp?.key === range.key && stamp.seq > range.toSeq;
    });
    events.splice(
      firstLaterSameKey === -1 ? events.length : firstLaterSameKey,
      0,
      marker,
    );
  }
  return {
    events,
    markerCount: individualRanges.length + (needsAggregate ? 1 : 0),
  };
}

/**
 * Serialized-size budget for the persisted portal event outbox — a per-list
 * budget, not a whole-store bound (completedCommands has its own budget in
 * portal-state-store). The count cap alone permits ~hundreds of MB of
 * full-state snapshots when a stale session stops draining the outbox
 * (CAN-2319). Shared by the live trim (portal-session-manager) and the
 * load-time normalization (portal-state-store) so upgrade-with-bloated-file
 * is covered too.
 */
export const PORTAL_OUTBOX_MAX_BYTES = 20 * 1024 * 1024;

/** Wire size of a single event as the events endpoint would receive it. */
export function portalEventByteLength(event: PortalEventEnvelope): number {
  return Buffer.byteLength(JSON.stringify({ events: [event] }), 'utf8');
}

/**
 * Measure the largest envelope this event can occupy after session routing
 * stamps it. Using the maximum safe sequence keeps the check valid for the
 * full lifetime of a routing lane, not only while its counter is short.
 */
export function portalEventMaxRoutedByteLength(
  event: PortalEventEnvelope,
): number {
  const lane = getPortalEventLane(event);
  if (!lane || !isRecord(event.payload)) {
    return portalEventByteLength(event);
  }
  return portalEventByteLength({
    ...event,
    payload: {
      ...event.payload,
      routing: { key: lane.key, seq: Number.MAX_SAFE_INTEGER },
    },
  });
}

// Envelopes are replaced (never mutated in place) throughout the outbox
// pipeline, so a WeakMap keyed on the envelope stays valid for its lifetime.
// The cache keeps the byte-budget trim from re-stringifying multi-hundred-KB
// snapshot events on every enqueue.
const portalEventByteLengthCache = new WeakMap<PortalEventEnvelope, number>();

export function cachedPortalEventByteLength(
  event: PortalEventEnvelope,
): number {
  let size = portalEventByteLengthCache.get(event);
  if (size === undefined) {
    size = portalEventByteLength(event);
    portalEventByteLengthCache.set(event, size);
  }
  return size;
}

export function portalOutboxByteSize(events: PortalEventEnvelope[]): number {
  return events.reduce(
    (sum, event) => sum + cachedPortalEventByteLength(event),
    0,
  );
}

/**
 * Recover an oversized `portal.state.snapshot` event instead of dropping it.
 *
 * Worktree snapshots bundle every entity for the scope into one event; with
 * large real-world workspaces that single event can exceed the 1MiB events
 * cap, and the old behavior dropped it silently — the browser then showed a
 * permanently empty worktree. This splits the snapshot:
 *
 *  - the HEAD keeps the `portal.state.snapshot` type (scope/target/
 *    generatedAt/viewMode/chatMessages) plus as many entities as fit, so the
 *    server's scope-replace semantics still clear stale rows;
 *  - the remaining entities ship as `portal.state.delta` events with the same
 *    scope/target — upsert-only, so they can never wipe the head's entities.
 *
 * Event ids are derived deterministically (`<id>:chunk-N`) so server-side
 * idempotency continues to dedupe retried batches. An individual entity that
 * cannot fit under the cap even alone is dropped. The result reports the
 * omission count and, for a routed event, carries a dropped-range marker that
 * forces the receiver to repair the affected lane.
 *
 * Returns `null` when the event is not a splittable snapshot (caller falls
 * back to the drop-with-diagnostic path), or a result containing `[event]`
 * unchanged when it already fits.
 */
export function splitOversizedPortalSnapshotEvent(
  event: PortalEventEnvelope,
  maxBytes: number,
): PortalSnapshotSplitResult | null {
  if (portalEventByteLength(event) <= maxBytes) {
    return {
      events: [event],
      droppedEntityCount: 0,
      droppedEntityMarker: null,
    };
  }
  if (event.type !== 'portal.state.snapshot' || !isRecord(event.payload)) {
    return null;
  }
  const payload = event.payload;
  const entities = Array.isArray(payload.entities) ? payload.entities : [];
  if (entities.length === 0) {
    // Nothing splittable (the bulk must be chatMessages or scalar fields).
    return null;
  }

  const basePayload: Record<string, unknown> = { ...payload, entities: [] };
  const headBase: PortalEventEnvelope = {
    ...event,
    payload: basePayload,
  };
  if (portalEventByteLength(headBase) > maxBytes) {
    // Even the entity-less head does not fit; cannot recover here.
    return null;
  }

  const deltaTargetFields: Record<string, unknown> = {
    ...(payload.scope !== undefined ? { scope: payload.scope } : {}),
    ...(payload.target !== undefined ? { target: payload.target } : {}),
    ...(payload.generatedAt !== undefined
      ? { generatedAt: payload.generatedAt }
      : {}),
    ...(payload.routing !== undefined ? { routing: payload.routing } : {}),
  };

  const parts: PortalEventEnvelope[] = [];
  let chunk: unknown[] = [];
  let chunkIndex = 0;
  let droppedEntityCount = 0;
  const droppedEntityIds: string[] = [];

  const recordDroppedEntity = (entity: unknown): void => {
    droppedEntityCount += 1;
    if (
      droppedEntityIds.length >= PORTAL_DROPPED_MARKER_MAX_ENTITY_IDS ||
      !isRecord(entity) ||
      typeof entity.entityType !== 'string' ||
      typeof entity.localId !== 'string'
    ) {
      return;
    }
    // These opaque fingerprints are persisted as JSONB by the portal. Use an
    // escaped tuple: literal NUL separators make PostgreSQL reject the batch.
    droppedEntityIds.push(
      JSON.stringify([
        truncateDroppedMarkerIdentifier(entity.entityType),
        typeof entity.parentLocalId === 'string'
          ? truncateDroppedMarkerIdentifier(entity.parentLocalId)
          : '',
        truncateDroppedMarkerIdentifier(entity.localId),
      ]),
    );
  };

  const buildPart = (chunkEntities: unknown[]): PortalEventEnvelope => {
    const isHead = chunkIndex === 0;
    const part: PortalEventEnvelope = isHead
      ? {
          ...event,
          payload: { ...payload, entities: chunkEntities },
        }
      : {
          ...event,
          type: 'portal.state.delta',
          eventId: `${event.eventId}:chunk-${String(chunkIndex)}`,
          payload: { ...deltaTargetFields, entities: chunkEntities },
        };
    return part;
  };

  const flushChunk = (): void => {
    parts.push(buildPart(chunk));
    chunkIndex += 1;
    chunk = [];
  };

  for (const entity of entities) {
    const candidate = buildPart([...chunk, entity]);
    if (portalEventByteLength(candidate) <= maxBytes) {
      chunk.push(entity);
      continue;
    }
    if (chunk.length === 0) {
      // This single entity cannot fit even alone in a fresh part — drop it.
      recordDroppedEntity(entity);
      continue;
    }
    flushChunk();
    // Retry the entity in the new (possibly delta-framed) chunk.
    const soloCandidate = buildPart([entity]);
    if (portalEventByteLength(soloCandidate) <= maxBytes) {
      chunk.push(entity);
    } else {
      recordDroppedEntity(entity);
    }
  }
  if (chunk.length > 0 || parts.length === 0) {
    flushChunk();
  }

  let droppedEntityMarker: PortalEventEnvelope | null = null;
  if (droppedEntityCount > 0) {
    // A routed snapshot yields a range marker; an unrouted one yields the
    // aggregate refresh-all marker.
    const marked = createDroppedRangeMarkers({
      kept: [],
      dropped: [event],
      reason: 'oversized',
      createEventId: () => `${event.eventId}:dropped-entities`,
    });
    const marker = marked.events[0];
    if (marker && isRecord(marker.payload)) {
      droppedEntityMarker = {
        ...marker,
        payload: {
          ...marker.payload,
          droppedEntityCount,
          ...(droppedEntityIds.length > 0 ? { droppedEntityIds } : {}),
        },
      };
    }
  }

  return { events: parts, droppedEntityCount, droppedEntityMarker };
}

/**
 * Identity of the state a snapshot replaces: its scope plus the target ids it
 * was requested for. Two queued snapshots with the same key differ only in
 * age, and the server applies a snapshot as a wholesale replacement, so the
 * older one is redundant once the newer one is queued behind it.
 */
function portalSnapshotReplacementKey(
  event: PortalEventEnvelope,
): string | null {
  if (event.type !== 'portal.state.snapshot' || !isRecord(event.payload)) {
    return null;
  }
  // A command-correlated snapshot is the response the browser is waiting on:
  // it settles a repair only when the snapshot AND the terminal control event
  // for that exact commandId both arrive. Coalescing one while its completion
  // stays queued strands that repair until it times out and reissues — adding
  // outbox pressure instead of relieving it. Observed pileups are unsolicited
  // pushes (0 of 235 snapshots in a real 20MB outbox carried a commandId), so
  // excluding these costs nothing.
  if (typeof event.commandId === 'string' && event.commandId.length > 0) {
    return null;
  }
  // Removing a routed snapshot leaves a sequence hole that triggers another
  // browser repair snapshot, amplifying outbox pressure.
  if (getPortalRoutingStamp(event)) {
    return null;
  }
  // Entities are replaced wholesale by a newer snapshot for the same
  // scope+target, but `chatMessages` are upsert-only and each snapshot carries
  // only a bounded transcript tail. An older transcript-bearing snapshot can
  // hold rows that have since aged out of the newer one's window, and it is
  // their only delivery — so it is never eligible for the superseded lane. The
  // pileup this lane exists for (`overview` snapshots) carries no transcript.
  if (Array.isArray(event.payload.chatMessages)) {
    return null;
  }
  const scope =
    typeof event.payload.scope === 'string' ? event.payload.scope : 'overview';
  const target = isRecord(event.payload.target) ? event.payload.target : {};
  const targetEntries = Object.keys(target)
    .sort()
    .flatMap((key) => {
      const value = target[key];
      return typeof value === 'string' ? [`${key}=${value}`] : [];
    });
  return `${scope}\u0000${targetEntries.join('\u0000')}`;
}

/**
 * Indexes (in outbox order) of every snapshot that a later same-key snapshot
 * supersedes. Only the newest snapshot per key survives the set; delta and
 * chat events are never candidates.
 */
function findSupersededSnapshotIndexes(
  events: PortalEventEnvelope[],
): Set<number> {
  const newestIndexByKey = new Map<string, number>();
  for (let index = 0; index < events.length; index += 1) {
    const key = portalSnapshotReplacementKey(events[index]);
    if (key !== null) {
      newestIndexByKey.set(key, index);
    }
  }
  const superseded = new Set<number>();
  for (let index = 0; index < events.length; index += 1) {
    const key = portalSnapshotReplacementKey(events[index]);
    if (key !== null && newestIndexByKey.get(key) !== index) {
      superseded.add(index);
    }
  }
  return superseded;
}

function countEventTypes(
  events: PortalEventEnvelope[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Pure outbox trim. Drops whole delivery groups (see
 * {@link portalDeliveryGroupKey}), oldest background first, then oldest
 * foreground, then control events as a last resort, without changing survivor
 * order. A dropped state request's queued completion becomes a retryable
 * failure, and dropped unrouted state leaves a refresh-all marker. Reports how
 * many dropped events were chat events (visibly lost transcript content); the
 * stateful caller records a diagnostic so overflow is never a silent drop
 * (regression D3).
 *
 * Kept dependency-free (no Electron/SDK imports) so it is unit-testable without
 * pulling the session manager's module graph.
 */
export function computePortalOutboxTrim(
  events: PortalEventEnvelope[],
  max: number,
  foregroundWorktreeKey: string | null,
  enqueuedAt?: WeakMap<PortalEventEnvelope, number>,
  now?: number,
  options?: {
    maxBytes?: number;
    /**
     * Commands known to be `portal.state.request`. Only their dropped groups
     * turn a completion into a retryable failure: a mutating command's
     * correlated delta must never make a real success look retryable.
     */
    stateRequestCommandIds?: ReadonlySet<string>;
    /**
     * Events of the batch being uploaded, by identity. They are dropped only
     * when nothing else fits the hard cap, and their loss never fails a
     * command: the server may already hold them. Losing an unsent member of
     * the same command still does.
     */
    inFlightEvents?: ReadonlySet<PortalEventEnvelope>;
  },
): PortalOutboxTrimResult {
  const maxBytes = options?.maxBytes;
  const stateRequestCommandIds = options?.stateRequestCommandIds;
  const inFlightEvents = options?.inFlightEvents;
  const isInFlight = (event: PortalEventEnvelope): boolean =>
    inFlightEvents?.has(event) ?? false;
  const fits = (candidate: PortalEventEnvelope[]): boolean =>
    candidate.length <= max &&
    (maxBytes === undefined || portalOutboxByteSize(candidate) <= maxBytes);
  // Coalescing runs FIRST and unconditionally, before any cap check: a
  // snapshot with a newer same-key snapshot queued behind it is redundant at
  // any queue size. Gating it on overflow left one observed outbox pinned at
  // 20,965,524 bytes — 6KB under the 20MiB budget — holding 240 redundant
  // `overview` snapshots behind a stale session, so nothing ever reclaimed
  // that space and every genuinely new event arrived at an already-full
  // queue. Reported apart from the drop counters: the newer snapshot replaces
  // these wholesale, so this is reclaimed waste, not lost state.
  const supersededIndexes = findSupersededSnapshotIndexes(events);
  const coalescedSnapshotCount = supersededIndexes.size;
  const coalesced =
    coalescedSnapshotCount === 0
      ? events
      : events.filter((_, index) => !supersededIndexes.has(index));
  const noDrops = {
    droppedCount: 0,
    droppedChatEventCount: 0,
    droppedRangeCount: 0,
    coalescedSnapshotCount,
    droppedEventTypes: {},
    droppedChunkCount: 0,
    droppedCommandGroups: [],
  };
  if (fits(coalesced)) {
    return { kept: coalesced, ...noDrops, trimReason: null };
  }
  const trimReason = coalesced.length > max ? 'count' : 'bytes';
  if (max <= 0) {
    return {
      ...noDrops,
      kept: [],
      droppedCount: coalesced.length,
      droppedChatEventCount: coalesced.filter(
        (event) => event.type === 'portal.chat.event',
      ).length,
      droppedEventTypes: countEventTypes(coalesced),
      droppedChunkCount: coalesced.filter(isPortalSplitChunk).length,
      trimReason,
    };
  }
  // Superseded snapshots are already gone, so the drop order here is the
  // ordinary one, applied to whole delivery groups.
  const groups = new Map<string, number[]>();
  coalesced.forEach((event, index) => {
    // In-flight events form their own unit, so the unsent rest of their
    // group can still be dropped, and fail the command, without them.
    const key = isInFlight(event)
      ? `in-flight\u0000${portalDeliveryGroupKey(event)}`
      : portalDeliveryGroupKey(event);
    const group = groups.get(key);
    if (group) group.push(index);
    else groups.set(key, [index]);
  });
  const background: number[][] = [];
  const foreground: number[][] = [];
  const control: number[][] = [];
  const inFlight: number[][] = [];
  for (const group of Array.from(groups.values())) {
    const members = group.map((index) => coalesced[index]);
    if (members.every(isInFlight)) inFlight.push(group);
    else if (members.every(isPortalControlEvent)) control.push(group);
    else if (
      members.some((event) =>
        isPortalEventForeground(event, foregroundWorktreeKey),
      )
    )
      foreground.push(group);
    else background.push(group);
  }
  // Control events go late in the drop order rather than being fully exempt:
  // an all-control overflow must still converge under the cap. In-flight
  // groups go last, for the same reason.
  const orderedGroups = [...background, ...foreground, ...control, ...inFlight];
  const droppedIndexes = new Set<number>();
  let keptCount = coalesced.length;
  let keptBytes = maxBytes === undefined ? 0 : portalOutboxByteSize(coalesced);
  let nextGroup = 0;
  const dropNextGroup = (): void => {
    for (const index of orderedGroups[nextGroup]) {
      droppedIndexes.add(index);
      keptCount -= 1;
      if (maxBytes !== undefined) {
        keptBytes -= cachedPortalEventByteLength(coalesced[index]);
      }
    }
    nextGroup += 1;
  };
  while (
    nextGroup < orderedGroups.length &&
    (keptCount > max || (maxBytes !== undefined && keptBytes > maxBytes))
  ) {
    dropNextGroup();
  }
  const finish = (): {
    kept: PortalEventEnvelope[];
    dropped: PortalEventEnvelope[];
    markerCount: number;
    droppedCommandGroups: PortalDroppedCommandGroup[];
  } => {
    const dropped = coalesced.filter((_, index) => droppedIndexes.has(index));
    const droppedStateGroups = new Map<string, PortalEventEnvelope[]>();
    for (const event of dropped) {
      if (
        !event.commandId ||
        isPortalControlEvent(event) ||
        !stateRequestCommandIds?.has(event.commandId) ||
        isInFlight(event)
      )
        continue;
      const members = droppedStateGroups.get(event.commandId) ?? [];
      members.push(event);
      droppedStateGroups.set(event.commandId, members);
    }
    const failureEvents = new Map<string, PortalEventEnvelope>();
    const kept = coalesced.flatMap((event, index) => {
      if (droppedIndexes.has(index)) return [];
      if (
        !isPortalControlEvent(event) ||
        !event.commandId ||
        !droppedStateGroups.has(event.commandId) ||
        isInFlight(event)
      ) {
        return [event];
      }
      const terminal =
        event.type === 'portal.command.completed'
          ? createPortalUndeliveredStateFailure(event)
          : event;
      if (enqueuedAt) preservePortalEventTimestamp(event, terminal, enqueuedAt);
      failureEvents.set(event.commandId, terminal);
      return [terminal];
    });
    const marked = createDroppedRangeMarkers({
      kept,
      dropped,
      reason: 'overflow',
      createEventId: () => `portal-drop-overflow-${randomUUID()}`,
      enqueuedAt,
      now,
      maxEvents: max,
    });
    return {
      kept: marked.events,
      dropped,
      markerCount: marked.markerCount,
      droppedCommandGroups: Array.from(
        droppedStateGroups,
        ([commandId, members]) => {
          const failureEvent = failureEvents.get(commandId);
          return {
            commandId,
            eventCount: members.length,
            chunkCount: members.filter(isPortalSplitChunk).length,
            eventTypes: countEventTypes(members),
            failureQueued: failureEvent !== undefined,
            ...(failureEvent ? { failureEvent } : {}),
          };
        },
      ),
    };
  };
  // Markers and rewritten terminals can push a just-fitting set back over
  // budget; drop further groups until the final set fits.
  let result = finish();
  while (!fits(result.kept) && nextGroup < orderedGroups.length) {
    dropNextGroup();
    result = finish();
  }
  if (result.kept.length > max) {
    throw new Error('Portal outbox trim exceeded its event cap');
  }
  return {
    kept: result.kept,
    droppedCount: result.dropped.length,
    droppedChatEventCount: result.dropped.filter(
      (event) => event.type === 'portal.chat.event',
    ).length,
    droppedRangeCount: result.markerCount,
    coalescedSnapshotCount,
    trimReason,
    droppedEventTypes: countEventTypes(result.dropped),
    droppedChunkCount: result.dropped.filter(isPortalSplitChunk).length,
    droppedCommandGroups: result.droppedCommandGroups,
  };
}
