export interface FastDiffStatsQueue {
  /** Move the worktree to the front of the fast queue and kick the drain. */
  enqueue: (
    projectId: string,
    worktreeId: string,
    options?: FastDiffStatsEnqueueOptions,
  ) => void;
}

export interface FastDiffStatsEnqueueOptions {
  /** A confirmed mutation must be observed even inside the freshness window. */
  bypassFreshness?: boolean;
}

export interface FastDiffStatsQueueOptions {
  /** Performs the scoped, skipFetch refresh for one worktree. */
  refresh: (projectId: string, worktreeId: string) => Promise<void>;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** Skip a refresh if the worktree was refreshed within this window (ms). */
  skipIfFreshMs?: number;
}

interface QueueEntry {
  projectId: string;
  worktreeId: string;
  bypassFreshness: boolean;
}

/**
 * A priority "fast" queue for scoped diff-stats refreshes, mirroring the
 * GitHub PR poller's immediate queue: enqueue moves the worktree to the front
 * (deduped), a single drain runs one refresh at a time (never overlapping), and
 * a worktree refreshed within `skipIfFreshMs` is skipped so bursts (rapid
 * saves, multiple turn_diff events) collapse to one refresh.
 */
export function createFastDiffStatsQueue(
  options: FastDiffStatsQueueOptions,
): FastDiffStatsQueue {
  const {
    refresh,
    now = (): number => Date.now(),
    skipIfFreshMs = 1000,
  } = options;

  const queue: QueueEntry[] = [];
  const lastRefreshedAt = new Map<string, number>();
  let draining = false;

  const keyOf = (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`;

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry) break;
        const key = keyOf(entry.projectId, entry.worktreeId);
        const last = lastRefreshedAt.get(key);
        if (
          !entry.bypassFreshness &&
          last !== undefined &&
          now() - last <= skipIfFreshMs
        ) {
          continue;
        }
        try {
          await refresh(entry.projectId, entry.worktreeId);
          lastRefreshedAt.set(key, now());
        } catch {
          // Swallow so one failed refresh cannot stall the queue; a later
          // trigger can re-enqueue the worktree.
        }
      }
    } finally {
      draining = false;
    }
  };

  return {
    enqueue: (projectId, worktreeId, enqueueOptions): void => {
      const key = keyOf(projectId, worktreeId);
      const existingIdx = queue.findIndex(
        (entry) => keyOf(entry.projectId, entry.worktreeId) === key,
      );
      const bypassFreshness =
        enqueueOptions?.bypassFreshness === true ||
        (existingIdx !== -1 && queue[existingIdx]?.bypassFreshness === true);
      if (existingIdx !== -1) {
        queue.splice(existingIdx, 1);
      }
      queue.unshift({ projectId, worktreeId, bypassFreshness });
      void drain();
    },
  };
}
