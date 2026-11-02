import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../runtime/errors';

// Observes each worktree checkout's Git HEAD through one `worker.filesystem.watch`
// `gitHead` stream and records branch changes through the host's writer. Paths
// stay inside the host's ports; this module sees ids only.

export interface BranchObserverWorktree {
  workspaceId: string;
  worktreeId: string;
}

export interface BranchCheckout extends BranchObserverWorktree {
  /** The repository of a multi-repo worktree; absent for single-repo. */
  repoId?: string;
  /** The `worker.filesystem.watch` root that serves this checkout. */
  fileRootId: string;
  /** The branch last recorded for it; null when it keeps none of its own. */
  persistedBranchName: string | null;
}

export interface BranchCheckoutListing<Checkout extends BranchCheckout> {
  checkouts: readonly Checkout[];
  /** Worktrees still being created: git-ready starts their watches. */
  pendingWorktrees: readonly BranchObserverWorktree[];
  /** Workspaces that failed to load keep the watches they have. */
  preservedWorkspaceIds: ReadonlySet<string>;
}

/** A worktree whose checkout just became ready. */
export interface BranchReadyWorktree extends BranchObserverWorktree {
  workspaceKind: 'single-repo' | 'multi-repo';
  branchName: string;
}

export interface BranchObservation extends BranchObserverWorktree {
  branchName: string;
  repoId?: string;
}

export interface GitHeadWatchHandle {
  close(): void;
}

export interface GitHeadWatchListener {
  /** A HEAD notification or an `overflow`: reread the branch. */
  onChange(): void;
  /** The stream ended without `close()`; `null` for a clean end. */
  onEnd(error: CanopyErrorPayload | null): void;
}

export interface BranchObserverLog {
  debug(message: string, fields: Record<string, unknown>): void;
  info(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
}

export interface BranchObserverPorts<Checkout extends BranchCheckout> {
  /** Persisted membership, read through the worktree list projection. */
  listCheckouts(): Promise<BranchCheckoutListing<Checkout>>;
  listReadyWorktreeCheckouts(target: BranchReadyWorktree): Promise<Checkout[]>;
  /** HEAD's branch when a watch starts; Git reports a detached HEAD as `HEAD`. */
  readStartBranch(checkout: Checkout): Promise<string | null>;
  readBranch(checkout: Checkout): Promise<string | null>;
  /** The host's writer (`internal.worktree.git.observe`) and push. */
  record(observation: BranchObservation): Promise<void>;
  /**
   * Opens one `gitHead` stream. Resolves once its native handle is attached;
   * rejects with a `CanopyOperationError` when the stream ends first.
   */
  watchHead(
    checkout: Checkout,
    listener: GitHeadWatchListener,
  ): Promise<GitHeadWatchHandle>;
  log?: BranchObserverLog;
}

export interface BranchObserverOptions {
  /** Coalesces a HEAD rewrite's notifications before rereading. */
  refreshDelayMs?: number;
  /** Coalesces lifecycle signals before rereading membership. */
  syncDebounceMs?: number;
  /** Rereads a checkout whose watch cannot attach. */
  pollIntervalMs?: number;
  /** Retries the watch of a polled checkout. */
  watchRetryMs?: number;
  /** First reopen delay after a stream ends; doubles while reopens fail. */
  reopenDelayMs?: number;
}

export interface BranchObserverSnapshot {
  watching: number;
  polling: number;
}

export interface BranchObserver {
  /** Rereads persisted membership, starting and retiring watches. */
  sync(): Promise<void>;
  /** A debounced `sync()` for lifecycle signals. */
  requestSync(): void;
  /** Starts a ready worktree's watches without retiring others. */
  ensureWorktree(target: BranchReadyWorktree): Promise<void>;
  /** Another writer recorded this branch; its HEAD event is then a no-op. */
  noteRecorded(observation: BranchObservation): void;
  /** Closes every stream; later calls may start again. */
  stop(): void;
  snapshot(): BranchObserverSnapshot;
}

export const BRANCH_OBSERVER_REFRESH_DELAY_MS = 100;
export const BRANCH_OBSERVER_SYNC_DEBOUNCE_MS = 250;
// CAN-3190's bounded poll and native retry for worktree observers.
export const BRANCH_OBSERVER_POLL_INTERVAL_MS = 2_000;
export const BRANCH_OBSERVER_WATCH_RETRY_MS = 30_000;
export const BRANCH_OBSERVER_REOPEN_DELAY_MS = 100;

type Timer = ReturnType<typeof setTimeout>;

interface Entry<Checkout extends BranchCheckout> {
  key: string;
  checkout: Checkout;
  state: 'starting' | 'active' | 'disposed';
  branchName: string | null;
  watch: GitHeadWatchHandle | null;
  /** Bumped per open and on dispose, so a replaced stream's end is ignored. */
  watchToken: number;
  /** The stream ended before the start registered this entry. */
  endedWhileStarting: boolean;
  refreshTimer: Timer | null;
  refreshInFlight: Promise<void> | null;
  refreshQueued: boolean;
  reopenTimer: Timer | null;
  reopenDelayMs: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  retryTimer: Timer | null;
}

const NOOP_LOG: BranchObserverLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

function checkoutKey(
  ref: BranchObserverWorktree & { repoId?: string },
): string {
  return `${ref.workspaceId}/${ref.worktreeId}/${ref.repoId ?? 'root'}`;
}

function worktreeKey(ref: BranchObserverWorktree): string {
  return `${ref.workspaceId}/${ref.worktreeId}`;
}

/** Git reports a detached HEAD as the literal `HEAD`, which names no branch. */
function isBranchName(branchName: string | null): branchName is string {
  return branchName !== null && branchName !== '' && branchName !== 'HEAD';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A watch that cannot attach because of the native watcher (an `internal`
 * attach failure, such as a watch or open-file limit) is polled. A missing or
 * non-Git root, or a runtime that stopped accepting, waits for the next sync.
 */
function pollsAfterFailure(error: unknown): boolean {
  if (!(error instanceof CanopyOperationError)) return false;
  return (
    error.payload.kind === 'internal' ||
    error.payload.kind === 'resource_exhausted'
  );
}

export function createBranchObserver<Checkout extends BranchCheckout>(
  ports: BranchObserverPorts<Checkout>,
  options: BranchObserverOptions = {},
): BranchObserver {
  const log = ports.log ?? NOOP_LOG;
  const refreshDelayMs =
    options.refreshDelayMs ?? BRANCH_OBSERVER_REFRESH_DELAY_MS;
  const syncDebounceMs =
    options.syncDebounceMs ?? BRANCH_OBSERVER_SYNC_DEBOUNCE_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? BRANCH_OBSERVER_POLL_INTERVAL_MS;
  const watchRetryMs = options.watchRetryMs ?? BRANCH_OBSERVER_WATCH_RETRY_MS;
  const reopenDelayMs =
    options.reopenDelayMs ?? BRANCH_OBSERVER_REOPEN_DELAY_MS;

  const entries = new Map<string, Entry<Checkout>>();
  const pendingStarts = new Map<string, Promise<boolean>>();
  let syncGeneration = 0;
  let stopEpoch = 0;
  let syncTimer: Timer | null = null;

  const current = (entry: Entry<Checkout>): boolean =>
    entry.state === 'active' && entries.get(entry.key) === entry;

  const clearTimers = (entry: Entry<Checkout>): void => {
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
    if (entry.reopenTimer) clearTimeout(entry.reopenTimer);
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.refreshTimer = null;
    entry.reopenTimer = null;
    entry.pollTimer = null;
    entry.retryTimer = null;
  };

  /** Closes the stream; its HEAD handle stays dormant in the registry. */
  const dispose = (entry: Entry<Checkout>): void => {
    entry.state = 'disposed';
    entry.watchToken += 1;
    clearTimers(entry);
    const watch = entry.watch;
    entry.watch = null;
    try {
      watch?.close();
    } catch {
      // The stream may already have ended.
    }
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  };

  const readAndRecord = async (entry: Entry<Checkout>): Promise<void> => {
    const branchName = await ports.readBranch(entry.checkout).catch(() => null);
    if (!current(entry)) return;
    if (!isBranchName(branchName) || branchName === entry.branchName) {
      log.debug('Worktree branch unchanged', { key: entry.key });
      return;
    }
    entry.branchName = branchName;
    const { workspaceId, worktreeId, repoId } = entry.checkout;
    await ports.record({
      workspaceId,
      worktreeId,
      branchName,
      ...(repoId ? { repoId } : {}),
    });
  };

  const refresh = (entry: Entry<Checkout>): Promise<void> => {
    if (entry.state === 'starting') {
      // The start rereads once it registers the entry.
      entry.refreshQueued = true;
      return Promise.resolve();
    }
    if (entry.refreshInFlight) {
      entry.refreshQueued = true;
      return entry.refreshInFlight;
    }
    entry.refreshInFlight = (async (): Promise<void> => {
      do {
        entry.refreshQueued = false;
        await readAndRecord(entry);
      } while (entry.refreshQueued && current(entry));
    })().finally(() => {
      entry.refreshInFlight = null;
    });
    return entry.refreshInFlight;
  };

  const refreshDetached = (entry: Entry<Checkout>): void => {
    refresh(entry).catch((error: unknown) => {
      log.warn('Worktree branch refresh failed', {
        key: entry.key,
        error: describeError(error),
      });
    });
  };

  const scheduleRefresh = (entry: Entry<Checkout>): void => {
    if (entry.state === 'disposed') return;
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = null;
      refreshDetached(entry);
    }, refreshDelayMs);
  };

  const stopPolling = (entry: Entry<Checkout>): void => {
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.pollTimer = null;
    entry.retryTimer = null;
  };

  /** Opens this entry's stream; a stream that loses the race is closed. */
  const attach = async (entry: Entry<Checkout>): Promise<void> => {
    const token = ++entry.watchToken;
    // The end frame can arrive before `watchHead` resolves.
    const opened: { attached: boolean; end?: CanopyErrorPayload | null } = {
      attached: false,
    };
    const watch = await ports.watchHead(entry.checkout, {
      onChange: () => {
        if (entry.watchToken !== token) return;
        entry.reopenDelayMs = reopenDelayMs;
        scheduleRefresh(entry);
      },
      onEnd: (error) => {
        if (entry.watchToken !== token) return;
        if (!opened.attached) {
          opened.end = error;
          return;
        }
        entry.watch = null;
        handleEnded(entry, error);
      },
    });
    if (entry.watchToken !== token || entry.state === 'disposed') {
      watch.close();
      return;
    }
    opened.attached = true;
    if (opened.end !== undefined) {
      handleEnded(entry, opened.end);
      return;
    }
    entry.watch = watch;
  };

  /** Polls until a watch retry attaches; idempotent while polling. */
  function startPolling(entry: Entry<Checkout>, error: unknown): void {
    if (!current(entry)) return;
    if (!entry.pollTimer) {
      log.warn('Worktree branch watch using bounded polling', {
        key: entry.key,
        error: describeError(error),
      });
      const timer = setInterval(() => {
        if (current(entry)) refreshDetached(entry);
      }, pollIntervalMs);
      timer.unref?.();
      entry.pollTimer = timer;
    }
    scheduleWatchRetry(entry);
  }

  function scheduleWatchRetry(entry: Entry<Checkout>): void {
    if (entry.retryTimer) return;
    const timer = setTimeout(() => {
      entry.retryTimer = null;
      if (!current(entry)) return;
      reopen(entry);
    }, watchRetryMs);
    timer.unref?.();
    entry.retryTimer = timer;
  }

  /** Reopens the stream and rereads HEAD for what it missed meanwhile. */
  function reopen(entry: Entry<Checkout>): void {
    attach(entry).then(
      () => {
        if (!current(entry) || !entry.watch) return;
        if (entry.pollTimer) {
          stopPolling(entry);
          log.info('Worktree branch watch recovered', { key: entry.key });
        }
        refreshDetached(entry);
      },
      (error: unknown) => {
        if (!current(entry)) return;
        if (pollsAfterFailure(error)) {
          startPolling(entry, error);
          return;
        }
        log.warn('Worktree branch watcher stopped', {
          key: entry.key,
          error: describeError(error),
        });
        dispose(entry);
      },
    );
  }

  function handleEnded(
    entry: Entry<Checkout>,
    error: CanopyErrorPayload | null,
  ): void {
    if (entry.state === 'starting') {
      entry.endedWhileStarting = true;
      return;
    }
    if (!current(entry)) return;
    log.debug('Worktree branch watch ended; reopening', {
      key: entry.key,
      error: error?.kind ?? null,
    });
    const delayMs = entry.reopenDelayMs;
    // An end without a HEAD notification since the last one backs off.
    entry.reopenDelayMs = Math.min(delayMs * 2, watchRetryMs);
    if (entry.reopenTimer) clearTimeout(entry.reopenTimer);
    entry.reopenTimer = setTimeout(() => {
      entry.reopenTimer = null;
      if (current(entry)) reopen(entry);
    }, delayMs);
    entry.reopenTimer.unref?.();
  }

  /**
   * Starts one checkout's watch and catches up on a branch change it missed:
   * a rename made while nothing watched it is recorded now. Returns whether
   * an entry was installed.
   */
  const start = async (
    checkout: Checkout,
    isStale: () => boolean,
  ): Promise<boolean> => {
    const key = checkoutKey(checkout);
    const entry: Entry<Checkout> = {
      key,
      checkout,
      state: 'starting',
      branchName: null,
      watch: null,
      watchToken: 0,
      endedWhileStarting: false,
      refreshTimer: null,
      refreshInFlight: null,
      refreshQueued: false,
      reopenTimer: null,
      reopenDelayMs,
      pollTimer: null,
      retryTimer: null,
    };
    // Attached before HEAD is read, so a rewrite during the read still
    // notifies.
    let attachFailure: { error: unknown } | null = null;
    try {
      await attach(entry);
    } catch (error) {
      if (isStale() || entries.has(key) || !pollsAfterFailure(error)) {
        dispose(entry);
        if (isStale() || entries.has(key)) return false;
        throw error;
      }
      attachFailure = { error };
    }
    if (isStale() || entries.has(key)) {
      dispose(entry);
      return false;
    }
    const branchName = await ports.readStartBranch(checkout).catch(() => null);
    if (isStale() || entries.has(key)) {
      dispose(entry);
      return false;
    }
    // Seed with the recorded branch so a checkout that moved while unwatched
    // is compared with what was recorded, not with what HEAD holds now. A
    // detached HEAD or a failed read has nothing to catch up on.
    entry.branchName = isBranchName(branchName)
      ? (checkout.persistedBranchName ?? branchName)
      : branchName;
    entry.state = 'active';
    entries.set(key, entry);
    if (attachFailure) startPolling(entry, attachFailure.error);
    else if (entry.endedWhileStarting) handleEnded(entry, null);
    if (entry.branchName !== branchName || entry.refreshQueued) {
      await refresh(entry).catch((error: unknown) => {
        log.warn('Worktree branch catch-up failed', {
          key,
          error: describeError(error),
        });
      });
    }
    return true;
  };

  type StartResult = 'started' | 'present' | 'stale';

  /** One start per key: a caller that finds a start in flight waits for it. */
  const startOnce = async (
    checkout: Checkout,
    isStale: () => boolean,
  ): Promise<StartResult> => {
    const key = checkoutKey(checkout);
    for (;;) {
      if (entries.has(key)) return 'present';
      const pending = pendingStarts.get(key);
      if (!pending) break;
      // A start from a superseded sync may install nothing, so check again.
      await pending.catch(() => false);
    }
    if (isStale()) return 'stale';
    const started = start(checkout, isStale);
    pendingStarts.set(key, started);
    try {
      return (await started) ? 'started' : 'stale';
    } finally {
      if (pendingStarts.get(key) === started) pendingStarts.delete(key);
    }
  };

  const sync = async (): Promise<void> => {
    const generation = ++syncGeneration;
    const isStale = (): boolean => generation !== syncGeneration;
    let listing: BranchCheckoutListing<Checkout>;
    try {
      listing = await ports.listCheckouts();
    } catch (error) {
      // Without a membership read every watch stays as it is.
      log.warn('Worktree branch watchers not synced', {
        error: describeError(error),
      });
      return;
    }
    const summary = {
      refs: listing.checkouts.length,
      started: 0,
      retired: 0,
      present: 0,
      failed: 0,
      superseded: false,
    };
    if (isStale()) {
      summary.superseded = true;
      log.info('Worktree branch watchers synced', summary);
      return;
    }
    const nextKeys = new Set(listing.checkouts.map(checkoutKey));
    const pendingWorktreeKeys = new Set(
      listing.pendingWorktrees.map(worktreeKey),
    );
    for (const [key, entry] of Array.from(entries)) {
      if (
        !nextKeys.has(key) &&
        !listing.preservedWorkspaceIds.has(entry.checkout.workspaceId) &&
        // A listing read before git-ready keeps the watch git-ready started.
        !pendingWorktreeKeys.has(worktreeKey(entry.checkout))
      ) {
        dispose(entry);
        summary.retired += 1;
      }
    }
    for (const checkout of listing.checkouts) {
      if (isStale()) {
        summary.superseded = true;
        break;
      }
      try {
        const result = await startOnce(checkout, isStale);
        if (result === 'started') summary.started += 1;
        if (result === 'present') summary.present += 1;
      } catch (error) {
        summary.failed += 1;
        log.info('Worktree branch watcher failed to start', {
          key: checkoutKey(checkout),
          error: describeError(error),
        });
      }
    }
    log.info('Worktree branch watchers synced', summary);
  };

  return {
    sync,
    requestSync(): void {
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        syncTimer = null;
        void sync();
      }, syncDebounceMs);
      syncTimer.unref?.();
    },
    async ensureWorktree(target): Promise<void> {
      const epoch = stopEpoch;
      const isStale = (): boolean => epoch !== stopEpoch;
      let checkouts: Checkout[];
      try {
        checkouts = await ports.listReadyWorktreeCheckouts(target);
      } catch (error) {
        log.warn('Worktree branch watcher repos unavailable', {
          key: worktreeKey(target),
          error: describeError(error),
        });
        return;
      }
      for (const checkout of checkouts) {
        if (isStale()) return;
        await startOnce(checkout, isStale).catch((error: unknown) => {
          log.info('Worktree branch watcher failed to start', {
            key: checkoutKey(checkout),
            error: describeError(error),
          });
        });
      }
    },
    noteRecorded(observation): void {
      const entry = entries.get(checkoutKey(observation));
      if (entry) entry.branchName = observation.branchName;
    },
    stop(): void {
      syncGeneration += 1;
      stopEpoch += 1;
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = null;
      for (const entry of Array.from(entries.values())) dispose(entry);
      entries.clear();
    },
    snapshot(): BranchObserverSnapshot {
      let polling = 0;
      for (const entry of Array.from(entries.values()))
        if (entry.pollTimer) polling += 1;
      return { watching: entries.size - polling, polling };
    },
  };
}
