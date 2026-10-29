import type {
  TelemetrySyncPausedReason,
  TelemetrySyncStatus,
} from '@canopy/desktop-shared/types';
import type { AppDiagnosticRecord } from '../observability/service';

/**
 * Telemetry sync pause detection (CAN-3512).
 *
 * Uploads once stopped with no attempts, errors, or diagnostics, and the stall
 * was visible only in `telemetry-sync/queue.jsonl`. This module turns "sync
 * should run but does not" into a `Sync paused` status and one app-events
 * diagnostic per pause.
 *
 * It reads the sync service through a narrow read-only snapshot and owns no
 * sync state, so the service's upload paths are unchanged.
 */

/**
 * The oldest queued item must be at least this old, with no successful upload
 * in the same window, before the queue counts as stalled.
 *
 * A healthy queue drains within minutes: uploads run 60 seconds after the last
 * change, and the server-rejection backoff caps at 15 minutes. Six hours is
 * well past that and past an ordinary offline stretch (a commute, a long
 * meeting, a lid closed over lunch), so a laptop that was simply away does not
 * read as paused. It is still short enough that a stall surfaces within one
 * working day, before an organization's Statistics are a day behind.
 */
export const TELEMETRY_SYNC_STALL_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * A pause condition must hold this long before the status and diagnostic
 * change. It covers the first upload after starting or waking with an old
 * queue, so that does not flash `Sync paused`.
 */
export const TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS = 15 * 60 * 1000;

/** Re-check cadence, so a queue that only ages is still noticed. */
export const TELEMETRY_SYNC_PAUSE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Read-only view of the sync service the pause detection needs. */
export interface TelemetrySyncHealthSnapshot {
  /**
   * The member's effective sharing, or an organization requirement, would
   * upload something. False when every scope is off and nothing is required.
   */
  sharingWanted: boolean;
  /** Queued items waiting to upload; the same count the status publishes. */
  pendingCount: number;
  /** Event time of the oldest dated queued item, or null. */
  oldestPendingAt: string | null;
  /** Last successful upload, or null if this device never uploaded. */
  lastSyncedAt: string | null;
}

type DatedPendingItems<T> = ReadonlyMap<string, { value: T }>;

/**
 * The queued collections whose payloads carry the time the item was produced.
 * Turns and pipeline runs are enqueued when they finish and summary snapshots
 * when they are generated, so those times stand in for "queued at". Pull
 * requests (mutable GitHub state refreshed by polling), plans, the latest
 * summary, and envelope metadata carry no enqueue time and are skipped.
 */
export interface QueuedTelemetryWorktree {
  turns: DatedPendingItems<{ startedAt: string; completedAt?: string }>;
  pipelineRuns: DatedPendingItems<{ startedAt: string; completedAt?: string }>;
  summarySnapshots: DatedPendingItems<{ generatedAt: string }>;
}

function earliest(current: number | null, candidate: string): number | null {
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return current;
  return current === null || ms < current ? ms : current;
}

/** Oldest dated item across every queued worktree, as an ISO string. */
export function oldestQueuedTelemetryItemAt(
  worktrees: readonly QueuedTelemetryWorktree[],
): string | null {
  let oldest: number | null = null;
  for (const worktree of worktrees) {
    for (const { value } of Array.from(worktree.turns.values())) {
      oldest = earliest(oldest, value.completedAt ?? value.startedAt);
    }
    for (const { value } of Array.from(worktree.pipelineRuns.values())) {
      oldest = earliest(oldest, value.completedAt ?? value.startedAt);
    }
    for (const { value } of Array.from(worktree.summarySnapshots.values())) {
      oldest = earliest(oldest, value.generatedAt);
    }
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}

function ageMs(iso: string | null, nowMs: number): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? nowMs - ms : null;
}

/**
 * Whether sync is paused right now, before the confirmation window.
 *
 * A member who turned every scope off chose privacy and is never paused.
 */
export function evaluateTelemetrySyncPause(
  snapshot: TelemetrySyncHealthSnapshot,
  nowMs: number,
): TelemetrySyncPausedReason | null {
  if (!snapshot.sharingWanted) return null;
  const oldestAge = ageMs(snapshot.oldestPendingAt, nowMs);
  if (oldestAge === null || oldestAge < TELEMETRY_SYNC_STALL_THRESHOLD_MS) {
    return null;
  }
  const syncedAge = ageMs(snapshot.lastSyncedAt, nowMs);
  if (syncedAge !== null && syncedAge < TELEMETRY_SYNC_STALL_THRESHOLD_MS) {
    return null;
  }
  return 'queue-stalled';
}

export type TelemetrySyncPauseDiagnostic = AppDiagnosticRecord & {
  kind: 'telemetry_sync_paused' | 'telemetry_sync_resumed';
};

export interface TelemetrySyncPauseMonitorDeps {
  service: {
    getHealthSnapshot(): TelemetrySyncHealthSnapshot;
    getStatus(): TelemetrySyncStatus;
    subscribeStatus(
      listener: (status: TelemetrySyncStatus) => void,
    ): () => void;
  };
  recordDiagnostic(record: TelemetrySyncPauseDiagnostic): void;
  now?: () => number;
  confirmationMs?: number;
  checkIntervalMs?: number;
}

function sameStatus(a: TelemetrySyncStatus, b: TelemetrySyncStatus): boolean {
  return (
    a.isSyncing === b.isSyncing &&
    a.pendingCount === b.pendingCount &&
    a.sharingActive === b.sharingActive &&
    a.lastSyncedAt === b.lastSyncedAt &&
    a.lastErrorAt === b.lastErrorAt &&
    a.lastError === b.lastError &&
    (a.pausedReason ?? null) === (b.pausedReason ?? null)
  );
}

/**
 * Watches the sync service, confirms pauses, records their diagnostics, and
 * republishes the service status with `pausedReason` attached. The IPC status
 * surface reads this instead of the service so the renderer sees both.
 */
export class TelemetrySyncPauseMonitor {
  private readonly deps: TelemetrySyncPauseMonitorDeps;
  private readonly now: () => number;
  private readonly confirmationMs: number;
  private readonly checkIntervalMs: number;
  private started = false;
  private disposed = false;
  private candidate: TelemetrySyncPausedReason | null = null;
  private candidateSinceMs = 0;
  private paused: TelemetrySyncPausedReason | null = null;
  private pausedSinceMs = 0;
  private serviceStatus: TelemetrySyncStatus;
  private lastEmitted: TelemetrySyncStatus | null = null;
  private readonly listeners = new Set<(status: TelemetrySyncStatus) => void>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribes: Array<() => void> = [];

  constructor(deps: TelemetrySyncPauseMonitorDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.confirmationMs =
      deps.confirmationMs ?? TELEMETRY_SYNC_PAUSE_CONFIRMATION_MS;
    this.checkIntervalMs =
      deps.checkIntervalMs ?? TELEMETRY_SYNC_PAUSE_CHECK_INTERVAL_MS;
    this.serviceStatus = deps.service.getStatus();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribes.push(
      this.deps.service.subscribeStatus((status) => {
        this.serviceStatus = status;
        this.evaluate();
      }),
    );
    this.interval = setInterval(() => {
      this.evaluate();
    }, this.checkIntervalMs);
    this.interval.unref?.();
    this.evaluate();
  }

  getStatus(): TelemetrySyncStatus {
    return { ...this.serviceStatus, pausedReason: this.paused };
  }

  subscribeStatus(listener: (status: TelemetrySyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
    this.clearConfirmTimer();
    this.listeners.clear();
  }

  private clearConfirmTimer(): void {
    if (this.confirmTimer !== null) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
  }

  private evaluate(): void {
    if (this.disposed) return;
    const nowMs = this.now();
    const snapshot = this.deps.service.getHealthSnapshot();
    const next = evaluateTelemetrySyncPause(snapshot, nowMs);
    if (next === null) {
      this.candidate = null;
      this.clearConfirmTimer();
      this.setPaused(null, snapshot, nowMs);
    } else if (this.paused !== null) {
      // Already paused: a changed cause is still a pause, reported at once.
      this.candidate = next;
      this.setPaused(next, snapshot, nowMs);
    } else {
      if (next !== this.candidate) {
        this.candidate = next;
        this.candidateSinceMs = nowMs;
      }
      const remainingMs = this.candidateSinceMs + this.confirmationMs - nowMs;
      if (remainingMs <= 0) {
        this.clearConfirmTimer();
        this.setPaused(next, snapshot, nowMs);
      } else if (this.confirmTimer === null) {
        this.confirmTimer = setTimeout(() => {
          this.confirmTimer = null;
          this.evaluate();
        }, remainingMs);
        this.confirmTimer.unref?.();
      }
    }
    this.emit();
  }

  private setPaused(
    next: TelemetrySyncPausedReason | null,
    snapshot: TelemetrySyncHealthSnapshot,
    nowMs: number,
  ): void {
    const previous = this.paused;
    if (next === previous) return;
    this.paused = next;
    const timestamp = new Date(nowMs).toISOString();
    if (next === null) {
      if (previous !== null) {
        this.deps.recordDiagnostic({
          version: 1,
          timestamp,
          kind: 'telemetry_sync_resumed',
          reason: 'queue_stalled',
          telemetrySyncPausedMs: nowMs - this.pausedSinceMs,
        });
      }
      return;
    }
    if (previous === null) this.pausedSinceMs = nowMs;
    this.deps.recordDiagnostic({
      version: 1,
      timestamp,
      kind: 'telemetry_sync_paused',
      reason: 'queue_stalled',
      telemetrySyncPendingCount: snapshot.pendingCount,
      telemetrySyncOldestPendingAgeMs: ageMs(snapshot.oldestPendingAt, nowMs),
      telemetrySyncLastSyncedAt: snapshot.lastSyncedAt,
    });
  }

  private emit(): void {
    const status = this.getStatus();
    if (this.lastEmitted !== null && sameStatus(this.lastEmitted, status)) {
      return;
    }
    this.lastEmitted = status;
    for (const listener of Array.from(this.listeners)) listener(status);
  }
}
