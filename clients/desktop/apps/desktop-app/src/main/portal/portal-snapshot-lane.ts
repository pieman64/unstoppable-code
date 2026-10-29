import { randomUUID } from 'node:crypto';
import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
  PortalStateRequestPayload,
} from '@canopy/desktop-shared/types';

/**
 * Async snapshot lane for `portal.state.request` commands (CAN-2360).
 *
 * A large-workspace snapshot build takes 6-28s; running it inline in the
 * serial command loop blocks every command queued behind it (chat.send,
 * terminal writes, ...) for the whole build. The lane moves the build — and
 * the flush-until-posted drain that used to live in `applyPollResponse` —
 * off the loop. Keyed mode admits two independent routing keys, at most one
 * background build, and reserves the other slot for the selected worktree.
 * Worktree chat tabs share a lane because each replaces the same tab list.
 * Untargeted requests are barriers; a selected read may start ahead of a
 * barrier that is still queued, a bounded number of times, but never ahead of
 * a running one. A background lane stays held through
 * persistence and upload. A selected lane is released once its completed
 * command record is durable: the single-flight outbox already preserves
 * per-key snapshot -> follow-ups -> completed ordering, and an unrelated
 * upload must not delay the next selected read. Serial mode retains the
 * original global FIFO fallback, held through upload.
 *
 * KNOWN RELAXATION: a mutation processed by the serial loop while a build is
 * in flight can enqueue its events before the (older) snapshot's — a widening
 * of the pre-existing push-path snapshot race class, not a new invariant.
 * It is bounded the same way: snapshot follow-up events plus the browser's
 * gap repair reconverge the projection.
 *
 * Every dependency is injected so the queue/epoch mechanics are unit-testable
 * without the session manager's Electron-bound module graph.
 */

export interface PortalSnapshotLaneEntry {
  command: PortalCommandEnvelope;
  request: PortalStateRequestPayload;
  /** `performance.now()` mark taken when the command arrived off the wire. */
  receivedAtPerf: number;
}

export interface PortalSnapshotLaneExecuteContext {
  isCurrent: () => boolean;
  enqueueEvent: (event: PortalEventEnvelope) => void;
  /** Lets an overview join only a shared build that started after arrival. */
  receivedAtPerf: number;
}

/** Which per-entry step failed; `onError` receives it for routing. */
export type PortalSnapshotLaneErrorPhase = 'execute' | 'persist' | 'flush';

export interface PortalSnapshotSchedulingTiming {
  commandId: string;
  stage:
    | 'snapshot_queued'
    | 'snapshot_dequeued'
    | 'snapshot_coalesced'
    | 'snapshot_drained';
  scope: PortalStateRequestPayload['scope'];
  requestClass: 'foreground' | 'background';
  queueDepth: number;
  activeCount: number;
  elapsedMs: number;
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  chatLocalId?: string;
}

export interface PortalCommandGroupDrop {
  reason: 'count' | 'bytes';
  eventTypes: Record<string, number>;
  chunkCount: number;
}

export interface PortalSnapshotLaneDeps {
  /** Host-local rollback; changing modes waits for existing flights. */
  mode?: () => 'keyed' | 'serial';
  recordScheduling?: (input: PortalSnapshotSchedulingTiming) => void;
  onForegroundBusy?: (busy: boolean) => void;
  execute: (
    command: PortalCommandEnvelope,
    context: PortalSnapshotLaneExecuteContext,
    request: PortalStateRequestPayload,
  ) => Promise<void>;
  /** Manager enqueue; returns the envelope standing for it, or null if none. */
  enqueueEvent: (event: PortalEventEnvelope) => PortalEventEnvelope | null;
  flushOutbox: () => Promise<void>;
  persistCompletedCommand: (input: {
    commandId: string;
    sequence: number;
    events: PortalEventEnvelope[];
  }) => Promise<void>;
  /** Whether any non-control event of the command is still queued. */
  isCommandGroupQueued: (commandId: string) => boolean;
  /** Set when an outbox trim dropped the command's delivery group. */
  droppedCommandGroup: (
    commandId: string,
  ) => PortalCommandGroupDrop | undefined;
  outboxDepth: () => number;
  recordTiming: (input: {
    commandId: string;
    stage: 'snapshot_event_posted' | 'snapshot_event_dropped';
    elapsedMs: number;
    drop?: PortalCommandGroupDrop;
  }) => void;
  now: () => number;
  /** Builds the terminal `portal.command.failed` envelope for a command. */
  buildFailureEvent: (command: PortalCommandEnvelope) => PortalEventEnvelope;
  /**
   * Failure routing. Flush-phase errors need the manager's transport
   * handling (inactive-session/404/network); execute- and persist-phase
   * errors are already surfaced to the browser via the synthesized
   * `portal.command.failed`, so the manager may treat them as advisory.
   */
  onError: (error: unknown, phase: PortalSnapshotLaneErrorPhase) => void;
}

export interface PortalSnapshotLane {
  enqueue: (entry: PortalSnapshotLaneEntry) => void;
  /**
   * Bump the epoch and drop everything queued. Builds already in flight keep
   * running (they cannot be cancelled mid-await) but their event enqueues,
   * completion persistence, and timing records are all suppressed: after a
   * session teardown those events would otherwise leak into the next
   * session's outbox with fresh routing stamps.
   */
  reset: () => void;
  /** Resolves once no entry is in flight or draining. Test/shutdown aid. */
  idle: () => Promise<void>;
}

interface QueuedSnapshotEntry extends PortalSnapshotLaneEntry {
  epoch: number;
  key: string | null;
  fingerprint: string;
  duplicates: QueuedSnapshotEntry[];
  emitted: PortalEventEnvelope[];
  overtakenCount: number;
}

/** How many selected reads may start ahead of one queued barrier. */
export const PORTAL_SNAPSHOT_BARRIER_MAX_OVERTAKES = 3;

/** Null means this request runs in the globally ordered snapshot lane. */
export function portalSnapshotRoutingKey(
  request: PortalStateRequestPayload,
): string | null {
  const target = request.target;
  // Even a supplied target cannot narrow these authoritative fleet scopes.
  if (
    [
      'overview',
      'workspace',
      'worktree_actions',
      'worktree_chat_summaries',
    ].includes(request.scope)
  )
    return null;
  if (request.scope === 'app_advisor') return 'app-advisor';
  if (target?.workspaceLocalId && target.worktreeLocalId) {
    return JSON.stringify([
      'worktree',
      target.workspaceLocalId,
      target.worktreeLocalId,
    ]);
  }
  if (target?.standaloneChatLocalId) {
    return JSON.stringify([
      'standalone',
      target.projectLocalId ?? '',
      target.standaloneChatLocalId,
    ]);
  }
  return null;
}

function requestFingerprint(request: PortalStateRequestPayload): string {
  return JSON.stringify([
    request.scope,
    request.selectedChatOnly ?? false,
    request.includeChatSummaries ?? false,
    request.refresh ?? false,
    Object.entries(request.target ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

function overlaps(
  left: QueuedSnapshotEntry,
  right: QueuedSnapshotEntry,
): boolean {
  return left.key === null || right.key === null || left.key === right.key;
}

function replayForCommand(
  event: PortalEventEnvelope,
  command: PortalCommandEnvelope,
): PortalEventEnvelope {
  const terminal =
    event.type === 'portal.command.completed' ||
    event.type === 'portal.command.failed';
  return {
    ...event,
    eventId: randomUUID(),
    clientEventId: undefined,
    commandId: command.id,
    payload:
      terminal && typeof event.payload === 'object' && event.payload !== null
        ? {
            ...event.payload,
            commandId: command.id,
            sequenceNumber: command.sequence,
          }
        : event.payload,
  };
}

export function createPortalSnapshotLane(
  deps: PortalSnapshotLaneDeps,
): PortalSnapshotLane {
  const queue: QueuedSnapshotEntry[] = [];
  let epoch = 0;
  const running = new Map<QueuedSnapshotEntry, Promise<void>>();
  const draining = new Set<Promise<void>>();
  // Every waiter on the manager's single-flight flush receives the same
  // rejection, so released drains report each failed upload once.
  let lastFlushError: unknown;
  let selectedKey: string | null = null;
  const keyed = (): boolean => deps.mode?.() !== 'serial';
  const foreground = (entry: QueuedSnapshotEntry): boolean =>
    entry.key !== null && entry.key === selectedKey;
  const updateForeground = (): void => {
    deps.onForegroundBusy?.(
      [...queue, ...Array.from(running.keys())].some(
        (entry) => entry.epoch === epoch && foreground(entry),
      ),
    );
  };
  const record = (
    entry: QueuedSnapshotEntry,
    stage: PortalSnapshotSchedulingTiming['stage'],
  ): void => {
    try {
      deps.recordScheduling?.({
        commandId: entry.command.id,
        stage,
        scope: entry.request.scope,
        requestClass: foreground(entry) ? 'foreground' : 'background',
        queueDepth: queue.length,
        activeCount: running.size,
        elapsedMs: Math.max(0, deps.now() - entry.receivedAtPerf),
        workspaceLocalId: entry.request.target?.workspaceLocalId,
        worktreeLocalId: entry.request.target?.worktreeLocalId,
        chatLocalId:
          entry.request.target?.chatLocalId ??
          entry.request.target?.standaloneChatLocalId,
      });
    } catch {
      /* Diagnostics cannot strand the queue. */
    }
  };

  /** Builds and persists; resolves to the stamped events, or null if stale. */
  const processEntry = async (
    entry: QueuedSnapshotEntry,
    replay?: PortalEventEnvelope[],
  ): Promise<PortalEventEnvelope[] | null> => {
    const events: PortalEventEnvelope[] = [];
    const context: PortalSnapshotLaneExecuteContext = {
      isCurrent: () => entry.epoch === epoch,
      receivedAtPerf: entry.receivedAtPerf,
      enqueueEvent: (event): void => {
        if (entry.epoch !== epoch) {
          return;
        }
        entry.emitted.push(event);
        const queued = deps.enqueueEvent(event);
        if (queued) events.push(queued);
      },
    };
    try {
      if (replay) {
        for (const event of replay)
          context.enqueueEvent(replayForCommand(event, entry.command));
      } else {
        await deps.execute(entry.command, context, entry.request);
      }
    } catch (error) {
      // executePortalStateRequest converts its own failures into
      // portal.command.failed before resolving; this guards anything that
      // still escapes so the browser is never left without a terminal
      // signal for the command.
      deps.onError(error, 'execute');
      context.enqueueEvent(deps.buildFailureEvent(entry.command));
    }
    if (entry.epoch !== epoch) {
      return null;
    }
    try {
      // Persist before the lane's own explicit flush in drainEntry. This does
      // NOT mean nothing has been uploaded yet: every enqueue during the build
      // schedules an async outbox flush, so some events may already be on
      // the wire. The guarantee is narrower — the durable replay record
      // exists before the lane forces the REMAINING events out.
      await deps.persistCompletedCommand({
        commandId: entry.command.id,
        sequence: entry.command.sequence,
        events,
      });
    } catch (error) {
      // Same surface as the serial path's persist .catch(() => undefined):
      // the durable replay record is lost. The synthesized failure below
      // still gives the browser a terminal signal even if the command's own
      // completion never made it out before a redelivery.
      deps.onError(error, 'persist');
      // Only synthesize a failure when the build produced no terminal event
      // of its own: after a successful build the completed event is already
      // enqueued and redelivery is unreachable (the cursor was persisted past
      // the command at hand-off), so a trailing failed would only hand the
      // browser a contradictory completed-then-failed sequence.
      const alreadyTerminal = events.some(
        (event) =>
          event.type === 'portal.command.completed' ||
          event.type === 'portal.command.failed',
      );
      if (!alreadyTerminal) {
        context.enqueueEvent(deps.buildFailureEvent(entry.command));
      }
    }
    return entry.epoch === epoch ? events : null;
  };

  const drainEntry = async (
    entry: QueuedSnapshotEntry,
    events: PortalEventEnvelope[],
  ): Promise<void> => {
    try {
      await deps.flushOutbox();
      // A snapshot trimmed during its own enqueue never reaches `events`,
      // but its group is still recorded as dropped.
      if (
        !events.some((event) => event.type === 'portal.state.snapshot') &&
        !deps.droppedCommandGroup(entry.command.id)
      ) {
        return;
      }
      // One flush posts only the head batch, so this command's parts can
      // still be queued behind earlier events. Keep flushing while forward
      // progress is being made. The group counts as posted only once every
      // part left the outbox through an upload, and as dropped when a trim
      // removed it; on a stalled outbox, record neither.
      let previousDepth = deps.outboxDepth();
      while (deps.isCommandGroupQueued(entry.command.id)) {
        if (entry.epoch !== epoch) {
          return;
        }
        await deps.flushOutbox();
        if (deps.outboxDepth() >= previousDepth) {
          break;
        }
        previousDepth = deps.outboxDepth();
      }
      if (entry.epoch !== epoch) return;
      const elapsedMs = Math.max(
        0,
        Math.round((deps.now() - entry.receivedAtPerf) * 100) / 100,
      );
      const drop = deps.droppedCommandGroup(entry.command.id);
      if (drop) {
        deps.recordTiming({
          commandId: entry.command.id,
          stage: 'snapshot_event_dropped',
          elapsedMs,
          drop,
        });
      } else if (!deps.isCommandGroupQueued(entry.command.id)) {
        deps.recordTiming({
          commandId: entry.command.id,
          stage: 'snapshot_event_posted',
          elapsedMs,
        });
      }
    } catch (error) {
      // Queued events survive in the outbox; the manager's flush scheduling
      // owns the retry. The lane just reports and keeps serving later
      // snapshot requests.
      if (error === lastFlushError) return;
      lastFlushError = error;
      deps.onError(error, 'flush');
    }
  };

  const kick = (): void => {
    updateForeground();
    const capacity = keyed() ? 2 : 1;
    while (running.size < capacity) {
      const activeEntries = Array.from(running.keys());
      const backgroundActive = activeEntries.some(
        (active) => !foreground(active),
      );
      const earlierKeys = new Set<string>();
      let earlierBarrier = false;
      let earlierBarrierExhausted = false;
      // Scan once: a large reconnect backlog must not create quadratic main-
      // process work while checking FIFO overlap for each pending request.
      const candidates = queue.filter((entry) => {
        // A selected read may start ahead of a barrier that has not started:
        // the barrier then reads newer state and enqueues after it. Each
        // barrier yields a bounded number of times so it cannot starve.
        const jumpsBarrier =
          keyed() && foreground(entry) && !earlierBarrierExhausted;
        const olderOverlap =
          (earlierBarrier && !jumpsBarrier) ||
          (entry.key === null
            ? earlierKeys.size > 0
            : earlierKeys.has(entry.key));
        if (entry.key === null) {
          earlierBarrier = true;
          if (entry.overtakenCount >= PORTAL_SNAPSHOT_BARRIER_MAX_OVERTAKES)
            earlierBarrierExhausted = true;
        } else earlierKeys.add(entry.key);
        return (
          !olderOverlap &&
          !activeEntries.some((active) => overlaps(entry, active)) &&
          (!keyed() || foreground(entry) || !backgroundActive)
        );
      });
      const entry = keyed()
        ? (candidates.find(foreground) ?? candidates[0])
        : running.size === 0
          ? queue[0]
          : undefined;
      if (!entry) break;
      const entryIndex = queue.indexOf(entry);
      for (const earlier of queue.slice(0, entryIndex)) {
        if (earlier.key === null) earlier.overtakenCount += 1;
      }
      queue.splice(entryIndex, 1);
      // Reserve the slot before executing: injected operations may enqueue
      // synchronously, and must see this lane as occupied.
      const task = Promise.resolve()
        .then(async (): Promise<void> => {
          if (entry.epoch !== epoch) return;
          record(entry, 'snapshot_dequeued');
          const settle = async (
            target: QueuedSnapshotEntry,
            replay?: PortalEventEnvelope[],
          ): Promise<void> => {
            const events = await processEntry(target, replay);
            if (!events) return;
            // The single-flight outbox keeps each routing key's events in
            // FIFO order, so a selected read releases its key once its
            // receipt is durable. Waiting here would let an unrelated upload
            // block the next selected read. Background reads stay held for
            // backpressure. Selection is read after the build on purpose: a
            // read whose key lost selection keeps the conservative hold.
            // onForegroundBusy ignores released drains because it only defers
            // snapshot build work, not uploads.
            if (keyed() && foreground(target)) {
              // drainEntry reports its own failures through onError.
              const drain = drainEntry(target, events)
                .catch(() => undefined)
                .finally(() => {
                  draining.delete(drain);
                });
              draining.add(drain);
            } else {
              await drainEntry(target, events);
            }
          };
          await settle(entry);
          for (const duplicate of entry.duplicates) {
            if (entry.epoch !== epoch) break;
            await settle(duplicate, entry.emitted);
          }
        })
        .finally(() => {
          running.delete(entry);
          // Marks slot release. A selected read releases after persistence,
          // so snapshot_event_posted, not this stage, measures its delivery.
          if (entry.epoch === epoch) record(entry, 'snapshot_drained');
          kick();
        });
      running.set(entry, task);
    }
    updateForeground();
  };

  return {
    enqueue: (input): void => {
      const entry: QueuedSnapshotEntry = {
        ...input,
        epoch,
        key: portalSnapshotRoutingKey(input.request),
        fingerprint: requestFingerprint(input.request),
        duplicates: [],
        emitted: [],
        overtakenCount: 0,
      };
      if (
        entry.key !== null &&
        ['chat', 'worktree', 'standalone_chat', 'app_advisor'].includes(
          entry.request.scope,
        )
      ) {
        selectedKey = entry.key;
      }
      // Only queued, adjacent-in-lane, identical background reads can share
      // a build. Never reuse an in-flight result or merge across a different
      // scope/refresh, which could restore state older than an intervening read.
      const previous = queue
        .slice()
        .reverse()
        .find((queued) => overlaps(queued, entry));
      if (
        keyed() &&
        !foreground(entry) &&
        previous?.fingerprint === entry.fingerprint
      ) {
        previous.duplicates.push(entry);
        record(entry, 'snapshot_coalesced');
      } else {
        queue.push(entry);
        record(entry, 'snapshot_queued');
      }
      kick();
    },
    reset: (): void => {
      epoch += 1;
      queue.length = 0;
      selectedKey = null;
      updateForeground();
    },
    idle: async (): Promise<void> => {
      while (running.size > 0 || draining.size > 0) {
        await Promise.all([
          ...Array.from(running.values()),
          ...Array.from(draining),
        ]);
      }
    },
  };
}
