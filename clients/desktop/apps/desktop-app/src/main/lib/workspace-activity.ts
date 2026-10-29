import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  isArchivedWorkspaceOperationLockHeld,
  withArchivedWorkspaceOperationLock,
} from './archived-containers';
import { touchAllWorkEntries, touchWorkEntry } from './cowork-work-entries';
import { isWorkEntryWorkspace } from './workspace-registry';
import { validateId } from './validation';
import { sendToAllWindows } from './window-send';
import { recordWorktreeActivity } from './worktree-observer-records';
import { readWorkspaceWorktreesDetailed } from './workspace-persistence';
import { WorktreeRegistryUnreadableError } from './worktree-list-repository';
import {
  detachedWorkCallback,
  settleEach,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

const TOUCH_WRITE_INTERVAL_MS = 60_000;

interface PendingWorkspaceTargetTouch {
  projectId: string;
  worktreeId: string;
  iso: string;
  milliseconds: number;
}

interface WorkspaceTargetTouchLane {
  lastReservedTouches: Map<string, number>;
  touchQueues: Map<string, Promise<void>>;
  pendingTouches: Map<string, PendingWorkspaceTargetTouch>;
  pendingTouchTimers: Map<string, ReturnType<typeof setTimeout>>;
  acquireArchiveLock: boolean;
}

function createTouchLane(
  acquireArchiveLock: boolean,
): WorkspaceTargetTouchLane {
  return {
    lastReservedTouches: new Map(),
    touchQueues: new Map(),
    pendingTouches: new Map(),
    pendingTouchTimers: new Map(),
    acquireArchiveLock,
  };
}

const ordinaryTouchLane = createTouchLane(true);
const postCommitTouchLane = createTouchLane(false);
const lastCompletedTouches = new Map<string, number>();
interface ActivityDeletionFence {
  users: number;
  ready: Promise<void>;
}
const activityDeletionFences = new Map<string, ActivityDeletionFence>();

function targetKey(projectId: string, worktreeId: string): string {
  return `${projectId}\0${worktreeId}`;
}

function normalizeTouchedAt(value: number | string | Date): {
  iso: string;
  milliseconds: number;
} {
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error('Invalid workspace activity timestamp');
  }
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

/**
 * Enter before acquiring the project archive lock. Drain previously queued
 * watermarks first, including delayed coalesced writes. During deletion, new
 * touches use the existing per-file mutation serializer without waiting for
 * the project lock: archive capture may be awaiting their chat commit.
 * These are still awaited durable writes, and the metadata updaters never
 * recreate a removed target. Reference counts cover overlapping deletions.
 */
export async function runWithWorkspaceTargetActivityDeletion<T>(
  projectId: string,
  worktreeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  const key = targetKey(projectId, worktreeId);
  let fence = activityDeletionFences.get(key);
  if (!fence) {
    fence = { users: 0, ready: Promise.resolve() };
    activityDeletionFences.set(key, fence);
    fence.ready = (async (): Promise<void> => {
      await drainTouchLaneBeforeDeletion(ordinaryTouchLane, key);
      await drainTouchLaneBeforeDeletion(postCommitTouchLane, key);
    })();
  }
  fence.users += 1;
  try {
    await fence.ready;
    return await operation();
  } finally {
    fence.users -= 1;
    if (fence.users === 0) activityDeletionFences.delete(key);
  }
}

async function drainTouchLaneBeforeDeletion(
  lane: WorkspaceTargetTouchLane,
  key: string,
): Promise<void> {
  const queued = lane.touchQueues.get(key);
  const pending = lane.pendingTouches.get(key);
  const timer = lane.pendingTouchTimers.get(key);
  if (timer) clearTimeout(timer);
  lane.pendingTouchTimers.delete(key);
  lane.pendingTouches.delete(key);
  await queued;
  if (!pending) return;
  try {
    await enqueueWorkspaceTargetTouch(lane, key, pending, true);
  } catch (error) {
    const replacement = lane.pendingTouches.get(key);
    if (
      replacement === undefined ||
      pending.milliseconds > replacement.milliseconds
    ) {
      lane.pendingTouches.set(key, pending);
    }
    throw error;
  }
}

async function persistNormalizedWorkspaceTargetTouch(
  projectId: string,
  worktreeId: string,
  iso: string,
): Promise<void> {
  if (isWorkEntryWorkspace(projectId)) {
    await touchWorkEntry(projectId, worktreeId, iso);
    return;
  }
  const { worktrees } = await recordWorktreeActivity({
    source: 'activity_watermark',
    workspaceId: projectId,
    worktreeId,
    touchedAt: iso,
  });
  const [touchedWorktree] = worktrees;
  if (touchedWorktree) {
    // The worktrees file watcher deliberately suppresses our own writes. Fold
    // the committed watermark into every renderer explicitly so CAN-1074's
    // recency ordering moves an active task (and its project) immediately.
    sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, {
      workspaceId: projectId,
      worktree: touchedWorktree,
    });
  }
}

/**
 * Persist activity without acquiring the archive-operation lock. Normally the
 * caller owns it; a deletion fence also permits external commit observers to
 * use this path. The per-file/registry mutation lock still serializes the write
 * with target removal, and a missing target is never recreated.
 */
async function persistWorkspaceTargetTouchWithoutOperationLock(
  projectId: string,
  worktreeId: string,
  normalized: { iso: string; milliseconds: number },
  bypassWriteInterval: boolean,
): Promise<void> {
  const key = targetKey(projectId, worktreeId);
  const previousCompleted = lastCompletedTouches.get(key);
  if (
    !bypassWriteInterval &&
    previousCompleted !== undefined &&
    normalized.milliseconds <= previousCompleted + TOUCH_WRITE_INTERVAL_MS
  ) {
    return;
  }
  const previousReservation = ordinaryTouchLane.lastReservedTouches.get(key);
  const replacedReservation =
    previousReservation === undefined ||
    normalized.milliseconds > previousReservation;
  if (replacedReservation) {
    ordinaryTouchLane.lastReservedTouches.set(key, normalized.milliseconds);
  }
  try {
    await persistNormalizedWorkspaceTargetTouch(
      projectId,
      worktreeId,
      normalized.iso,
    );
    lastCompletedTouches.set(
      key,
      Math.max(
        lastCompletedTouches.get(key) ?? normalized.milliseconds,
        normalized.milliseconds,
      ),
    );
  } catch (error) {
    if (
      replacedReservation &&
      ordinaryTouchLane.lastReservedTouches.get(key) === normalized.milliseconds
    ) {
      if (previousReservation === undefined) {
        ordinaryTouchLane.lastReservedTouches.delete(key);
      } else {
        ordinaryTouchLane.lastReservedTouches.set(key, previousReservation);
      }
    }
    throw error;
  }
}

export function touchWorkspaceTargetWithoutOperationLock(
  projectId: string,
  worktreeId: string,
  touchedAt: number | string | Date = Date.now(),
): Promise<void> {
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  return persistWorkspaceTargetTouchWithoutOperationLock(
    projectId,
    worktreeId,
    normalizeTouchedAt(touchedAt),
    false,
  );
}

/**
 * Persist the activity associated with an already-durable chat commit. During
 * deletion the archive operation can be waiting for this observer, so only
 * this post-commit path may bypass the project archive lock. Ordinary callers
 * must remain behind the lock so their subsequent mutation cannot race
 * archive capture or target removal.
 */
export function touchWorkspaceTargetAfterCommit(
  projectId: string,
  worktreeId: string,
  touchedAt: number | string | Date = Date.now(),
): Promise<void> {
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  const normalized = normalizeTouchedAt(touchedAt);
  const key = targetKey(projectId, worktreeId);
  return scheduleWorkspaceTargetTouch(
    postCommitTouchLane,
    key,
    { projectId, worktreeId, ...normalized },
    activityDeletionFences.has(key),
  );
}

/**
 * Persist a durable per-worktree/Work-Entry activity watermark. High-volume
 * sources (terminal output, browser state, streaming chat saves) can call this
 * freely: writes are serialized and coalesced to at most one per target each
 * minute while the first touch is always written immediately.
 */
export function touchWorkspaceTarget(
  projectId: string,
  worktreeId: string,
  touchedAt: number | string | Date = Date.now(),
): Promise<void> {
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  const normalized = normalizeTouchedAt(touchedAt);
  if (isArchivedWorkspaceOperationLockHeld(projectId)) {
    // Never join work waiting for the archive lock while its owner may be
    // waiting for this touch's chat serializer or provider teardown callback.
    return touchWorkspaceTargetWithoutOperationLock(
      projectId,
      worktreeId,
      normalized.milliseconds,
    );
  }
  const key = targetKey(projectId, worktreeId);
  return scheduleWorkspaceTargetTouch(ordinaryTouchLane, key, {
    projectId,
    worktreeId,
    ...normalized,
  });
}

function scheduleWorkspaceTargetTouch(
  lane: WorkspaceTargetTouchLane,
  key: string,
  touch: PendingWorkspaceTargetTouch,
  bypassWriteInterval = false,
): Promise<void> {
  const previous = lane.lastReservedTouches.get(key);
  if (
    !bypassWriteInterval &&
    previous !== undefined &&
    touch.milliseconds <= previous + TOUCH_WRITE_INTERVAL_MS
  ) {
    if (touch.milliseconds <= previous) {
      return lane.touchQueues.get(key) ?? Promise.resolve();
    }
    const pending = lane.pendingTouches.get(key);
    if (pending === undefined || touch.milliseconds > pending.milliseconds) {
      lane.pendingTouches.set(key, touch);
    }
    if (!lane.pendingTouchTimers.has(key)) {
      const delay = Math.min(
        TOUCH_WRITE_INTERVAL_MS,
        Math.max(0, previous + TOUCH_WRITE_INTERVAL_MS - touch.milliseconds),
      );
      const timer = setTimeout(
        detachedWorkCallback(() => {
          lane.pendingTouchTimers.delete(key);
          const latest = lane.pendingTouches.get(key);
          if (!latest) return;
          lane.pendingTouches.delete(key);
          return enqueueWorkspaceTargetTouch(lane, key, latest, true).catch(
            () => undefined,
          );
        }),
        delay,
      );
      timer.unref?.();
      lane.pendingTouchTimers.set(key, timer);
    }
    return lane.touchQueues.get(key) ?? Promise.resolve();
  }

  const timer = lane.pendingTouchTimers.get(key);
  if (timer) clearTimeout(timer);
  lane.pendingTouchTimers.delete(key);
  lane.pendingTouches.delete(key);

  return enqueueWorkspaceTargetTouch(lane, key, touch, bypassWriteInterval);
}

function enqueueWorkspaceTargetTouch(
  lane: WorkspaceTargetTouchLane,
  key: string,
  touch: PendingWorkspaceTargetTouch,
  bypassWriteInterval: boolean,
): Promise<void> {
  // Reserve the timestamp before awaiting the current writer so bursts do not
  // enqueue duplicate rewrites. A failed write clears the reservation, making
  // the next activity retry instead of suppressing persistence for a minute.
  lane.lastReservedTouches.set(key, touch.milliseconds);
  const queued = (lane.touchQueues.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const persist = async (): Promise<void> => {
        const lastCompleted = lastCompletedTouches.get(key);
        if (
          (lane.lastReservedTouches.get(key) ?? touch.milliseconds) >
            touch.milliseconds ||
          (!bypassWriteInterval &&
            lastCompleted !== undefined &&
            touch.milliseconds <= lastCompleted + TOUCH_WRITE_INTERVAL_MS)
        ) {
          return;
        }
        await persistNormalizedWorkspaceTargetTouch(
          touch.projectId,
          touch.worktreeId,
          touch.iso,
        );
        lastCompletedTouches.set(
          key,
          Math.max(
            lastCompletedTouches.get(key) ?? touch.milliseconds,
            touch.milliseconds,
          ),
        );
      };
      if (lane.acquireArchiveLock) {
        await withArchivedWorkspaceOperationLock(touch.projectId, persist);
      } else {
        await persist();
      }
    })
    .catch((error: unknown) => {
      if (lane.lastReservedTouches.get(key) === touch.milliseconds) {
        lane.lastReservedTouches.delete(key);
      }
      throw error;
    })
    .finally(() => {
      if (lane.touchQueues.get(key) === queued) {
        lane.touchQueues.delete(key);
      }
    });
  lane.touchQueues.set(key, queued);
  return queued;
}

export async function flushWorkspaceTargetTouches(): Promise<void> {
  for (const lane of [ordinaryTouchLane, postCommitTouchLane]) {
    const pending = Array.from(lane.pendingTouches.entries());
    lane.pendingTouches.clear();
    for (const [key, touch] of pending) {
      const timer = lane.pendingTouchTimers.get(key);
      if (timer) clearTimeout(timer);
      lane.pendingTouchTimers.delete(key);
      // The flush below observes the failure through touchQueues.
      trackDetachedWork(() =>
        enqueueWorkspaceTargetTouch(lane, key, touch, true).catch(
          () => undefined,
        ),
      );
    }
  }
  await settleEach([
    ...Array.from(ordinaryTouchLane.touchQueues.values()),
    ...Array.from(postCommitTouchLane.touchQueues.values()),
  ]);
}

/**
 * Establishes a fresh inactivity baseline for every live target when a
 * workspace first enables Auto Delete, preventing legacy activity that
 * predates last-touch tracking from being archived immediately.
 */
export async function touchAllWorkspaceTargets(
  projectId: string,
  touchedAt: number | string | Date = Date.now(),
): Promise<void> {
  validateId(projectId, 'projectId');
  const normalized = normalizeTouchedAt(touchedAt);
  if (isWorkEntryWorkspace(projectId)) {
    await touchAllWorkEntries(projectId, normalized.iso);
    return;
  }
  // A partial registry cannot establish a baseline for every live target.
  const { authority } = await readWorkspaceWorktreesDetailed(projectId, {
    persistRemovalCleanup: false,
  });
  if (authority === 'unreadable' || authority === 'partial') {
    throw new WorktreeRegistryUnreadableError();
  }
  await recordWorktreeActivity({
    source: 'auto_delete_baseline',
    workspaceId: projectId,
    touchedAt: normalized.iso,
  });
}

export function resetWorkspaceActivityForTests(): void {
  for (const lane of [ordinaryTouchLane, postCommitTouchLane]) {
    for (const timer of Array.from(lane.pendingTouchTimers.values())) {
      clearTimeout(timer);
    }
    lane.lastReservedTouches.clear();
    lane.touchQueues.clear();
    lane.pendingTouches.clear();
    lane.pendingTouchTimers.clear();
  }
  lastCompletedTouches.clear();
  activityDeletionFences.clear();
}
