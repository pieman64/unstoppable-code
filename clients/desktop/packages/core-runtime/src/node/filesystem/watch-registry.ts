import { randomUUID } from 'node:crypto';
import { basename, join, resolve, sep } from 'node:path';

// Host-private native watch handles for `worker.filesystem.watch`. Absolute
// paths stay inside this module and its host adapters.

export type FilesystemNativeWatchListener = (
  eventType: string,
  filename: string | Buffer | null | undefined,
) => void;

export interface FilesystemNativeWatchHandle {
  close(): void;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

export interface FilesystemNativeWatchOptions {
  recursive: boolean;
  persistent?: false;
}

/** Injected `fs.watch`; the registry never selects a platform backend. */
export type FilesystemNativeWatch = (
  path: string,
  options: FilesystemNativeWatchOptions,
  listener: FilesystemNativeWatchListener,
) => FilesystemNativeWatchHandle;

export interface FilesystemWatchAnchor {
  path: string;
  recursive: boolean;
  /** `false` lets the process exit while the handle is attached. */
  persistent?: boolean;
  /**
   * `close` closes the native handle with its last subscriber. `retain` keeps
   * it dormant for reuse, because `FSWatcher.close()` can block the host's
   * main thread on macOS.
   */
  release: 'close' | 'retain';
  /**
   * While an unavailable error keeps the handle detached, deliver one
   * `overflow` this often, so subscribers of a small anchor reread it as a
   * bounded poll. Absent: only the re-attach `overflow`s.
   */
  rescanWhileUnavailableMs?: number;
}

export type FilesystemWatchChangeKind =
  | 'created'
  | 'modified'
  | 'deleted'
  | 'overflow';

export interface FilesystemWatchChange {
  kind: FilesystemWatchChangeKind;
  /** Anchor-relative and `/`-separated; `''` names the anchor or an overflow. */
  path: string;
  eventCount: number;
  sequence: number;
}

export interface FilesystemWatchBatch {
  epoch: string;
  changes: readonly FilesystemWatchChange[];
}

export interface FilesystemWatchPosition {
  epoch: string;
  sequence: number;
}

export interface FilesystemWatchSubscription {
  /** The handle's live position when this subscription attached. */
  readonly position: FilesystemWatchPosition;
  release(): void;
}

export type FilesystemWatchDiagnostic =
  | {
      kind: 'error';
      path: string;
      recursive: boolean;
      error: unknown;
      unavailable: boolean;
    }
  | {
      kind: 'retry-failed';
      path: string;
      recursive: boolean;
      error: unknown;
      unavailable: boolean;
      nextDelayMs: number;
    }
  | { kind: 'reattached'; path: string; recursive: boolean };

/**
 * Host policy for native errors that a retry cannot fix quickly, such as
 * watch or open-file limits and denied access. The registry never names
 * error codes itself; each host supplies its own classification.
 */
export interface FilesystemWatchUnavailablePolicy {
  matches(error: unknown): boolean;
  /**
   * Called for a matching initial attach failure, and once per detachment
   * for a matching native error or re-attach failure, with the anchor it hit.
   */
  report(
    error: unknown,
    anchor: Pick<FilesystemWatchAnchor, 'path' | 'recursive'>,
  ): void;
}

export interface FilesystemWatchRegistryOptions {
  watch: FilesystemNativeWatch;
  /** Classifies `rename` notifications; a rejection means the path is gone. */
  lstat: (path: string) => Promise<unknown>;
  /** Defers a burst until the next check phase; defaults to `setImmediate`. */
  scheduleBurst?: (flush: () => void) => void;
  createEpoch?: () => string;
  /** Distinct paths in one burst above which it becomes one `overflow`. */
  overflowPathLimit?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  /** The single hook for native errors, re-attach, and platform limits. */
  onDiagnostic?: (diagnostic: FilesystemWatchDiagnostic) => void;
  /** A matching error retries every `retryMaxMs` after the first attempt. */
  unavailable?: FilesystemWatchUnavailablePolicy;
}

export interface FilesystemWatchRegistrySnapshot {
  attached: number;
  dormant: number;
  retrying: number;
  subscribers: number;
}

export interface FilesystemWatchRegistry {
  /** Attaches synchronously; throws when the native handle cannot attach. */
  acquire(
    anchor: FilesystemWatchAnchor,
    listener: (batch: FilesystemWatchBatch) => void,
  ): FilesystemWatchSubscription;
  /** The live position of a subscribed handle, or null when none serves it. */
  position(
    anchor: Pick<FilesystemWatchAnchor, 'path' | 'recursive'>,
  ): FilesystemWatchPosition | null;
  snapshot(): FilesystemWatchRegistrySnapshot;
}

export const FILESYSTEM_WATCH_OVERFLOW_PATH_LIMIT = 256;
export const FILESYSTEM_WATCH_RETRY_MIN_MS = 1_000;
export const FILESYSTEM_WATCH_RETRY_MAX_MS = 30_000;

interface Burst {
  paths: Map<string, { rename: boolean; count: number }>;
  overflow: boolean;
  count: number;
}

interface Subscriber {
  listener: (batch: FilesystemWatchBatch) => void;
}

interface HandleEntry {
  key: string;
  path: string;
  recursive: boolean;
  persistent: boolean;
  retain: boolean;
  native: FilesystemNativeWatchHandle | null;
  subscribers: Set<Subscriber>;
  epoch: string;
  sequence: number;
  burst: Burst | null;
  tail: Promise<void>;
  retry: { timer: ReturnType<typeof setTimeout>; delayMs: number } | null;
  /** A failed re-attach already sent this detachment's `overflow`. */
  lossReported: boolean;
  /** This detachment was already reported to the unavailable policy. */
  unavailableReported: boolean;
  rescanWhileUnavailableMs: number | null;
  rescanTimer: ReturnType<typeof setInterval> | null;
}

function anchorKey(path: string, recursive: boolean): string {
  return `${recursive ? 'recursive' : 'shallow'}:${path}`;
}

function relativeNativePath(filename: string | Buffer): string {
  return filename.toString().split(sep).join('/');
}

export function createFilesystemWatchRegistry(
  options: FilesystemWatchRegistryOptions,
): FilesystemWatchRegistry {
  const scheduleBurst =
    options.scheduleBurst ??
    ((flush: () => void): void => {
      setImmediate(flush);
    });
  const createEpoch = options.createEpoch ?? randomUUID;
  const overflowPathLimit =
    options.overflowPathLimit ?? FILESYSTEM_WATCH_OVERFLOW_PATH_LIMIT;
  const retryMinMs = options.retryMinMs ?? FILESYSTEM_WATCH_RETRY_MIN_MS;
  const retryMaxMs = options.retryMaxMs ?? FILESYSTEM_WATCH_RETRY_MAX_MS;
  const handles = new Map<string, HandleEntry>();

  const diagnose = (diagnostic: FilesystemWatchDiagnostic): void => {
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics must never disturb native delivery.
    }
  };

  const isUnavailable = (error: unknown): boolean => {
    try {
      return options.unavailable?.matches(error) ?? false;
    } catch {
      return false;
    }
  };

  const reportUnavailable = (
    error: unknown,
    anchor: Pick<FilesystemWatchAnchor, 'path' | 'recursive'>,
  ): void => {
    try {
      options.unavailable?.report(error, anchor);
    } catch {
      // Like diagnostics, the host's report must not disturb recovery.
    }
  };

  // Once per detachment, so a long outage does not repeat the host's report.
  const noteUnavailable = (entry: HandleEntry, error: unknown): boolean => {
    if (!isUnavailable(error)) return false;
    if (!entry.unavailableReported) {
      entry.unavailableReported = true;
      reportUnavailable(error, {
        path: entry.path,
        recursive: entry.recursive,
      });
    }
    startRescan(entry);
    return true;
  };

  const current = (entry: HandleEntry): boolean =>
    handles.get(entry.key) === entry;

  const deliver = (
    entry: HandleEntry,
    changes: ReadonlyArray<Omit<FilesystemWatchChange, 'sequence'>>,
  ): void => {
    if (!current(entry) || entry.subscribers.size === 0) return;
    const batch: FilesystemWatchBatch = {
      epoch: entry.epoch,
      changes: changes.map((change) => ({
        ...change,
        sequence: ++entry.sequence,
      })),
    };
    for (const subscriber of Array.from(entry.subscribers)) {
      try {
        subscriber.listener(batch);
      } catch {
        // One failing subscriber must not starve the others.
      }
    }
  };

  const exists = (path: string): Promise<boolean> =>
    options.lstat(path).then(
      () => true,
      () => false,
    );

  const classify = async (
    entry: HandleEntry,
    burst: Burst,
  ): Promise<Array<Omit<FilesystemWatchChange, 'sequence'>>> => {
    if (burst.overflow || burst.paths.size > overflowPathLimit)
      return [{ kind: 'overflow', path: '', eventCount: burst.count }];
    // A deleted anchor can surface as a `rename` of its own basename (macOS),
    // which would otherwise read as a missing child.
    if (
      Array.from(burst.paths.values()).some((record) => record.rename) &&
      !(await exists(entry.path))
    )
      return [{ kind: 'deleted', path: '', eventCount: burst.count }];
    const anchorName = basename(entry.path);
    return Promise.all(
      Array.from(burst.paths, async ([path, record]) => {
        // macOS also names a re-created anchor by its basename; without a
        // child of that name, the notification is for the anchor itself.
        if (path === anchorName && !(await exists(join(entry.path, path))))
          return {
            kind: record.rename ? ('created' as const) : ('modified' as const),
            path: '',
            eventCount: record.count,
          };
        if (!record.rename)
          return { kind: 'modified' as const, path, eventCount: record.count };
        const present = await exists(join(entry.path, path));
        return {
          kind: present ? ('created' as const) : ('deleted' as const),
          path,
          eventCount: record.count,
        };
      }),
    );
  };

  // Bursts are delivered in arrival order even when `lstat` latency differs.
  const enqueue = (
    entry: HandleEntry,
    produce: () => Promise<Array<Omit<FilesystemWatchChange, 'sequence'>>>,
  ): void => {
    entry.tail = entry.tail
      .then(produce)
      .then((changes) => deliver(entry, changes))
      .catch(() => undefined);
  };

  const flushBurst = (entry: HandleEntry): void => {
    const burst = entry.burst;
    entry.burst = null;
    if (!burst || !current(entry) || entry.subscribers.size === 0) return;
    enqueue(entry, () => classify(entry, burst));
  };

  const record = (
    entry: HandleEntry,
    eventType: string,
    filename: string | Buffer | null | undefined,
  ): void => {
    if (entry.subscribers.size === 0) return;
    let burst = entry.burst;
    if (!burst) {
      burst = { paths: new Map(), overflow: false, count: 0 };
      entry.burst = burst;
      scheduleBurst(() => flushBurst(entry));
    }
    burst.count += 1;
    if (burst.overflow) return;
    if (filename === null || filename === undefined || filename === '') {
      burst.overflow = true;
      burst.paths.clear();
      return;
    }
    const path = relativeNativePath(filename);
    const existing = burst.paths.get(path);
    if (existing) {
      existing.count += 1;
      existing.rename ||= eventType === 'rename';
      return;
    }
    if (burst.paths.size >= overflowPathLimit) {
      burst.overflow = true;
      burst.paths.clear();
      return;
    }
    burst.paths.set(path, { rename: eventType === 'rename', count: 1 });
  };

  // Notifications were lost while detached: subscribers must rescan.
  const reportLoss = (entry: HandleEntry): void => {
    enqueue(entry, () =>
      Promise.resolve([{ kind: 'overflow' as const, path: '', eventCount: 1 }]),
    );
  };

  function startRescan(entry: HandleEntry): void {
    const intervalMs = entry.rescanWhileUnavailableMs;
    if (intervalMs === null || entry.rescanTimer) return;
    const timer = setInterval(() => {
      if (!current(entry) || entry.subscribers.size === 0 || entry.native) {
        stopRescan(entry);
        return;
      }
      reportLoss(entry);
    }, intervalMs);
    timer.unref?.();
    entry.rescanTimer = timer;
  }

  function stopRescan(entry: HandleEntry): void {
    if (!entry.rescanTimer) return;
    clearInterval(entry.rescanTimer);
    entry.rescanTimer = null;
  }

  const clearRetry = (entry: HandleEntry): void => {
    if (!entry.retry) return;
    clearTimeout(entry.retry.timer);
    entry.retry = null;
  };

  const closeNative = (native: FilesystemNativeWatchHandle | null): void => {
    try {
      native?.close();
    } catch {
      // Already stopped by the runtime; nothing left to release.
    }
  };

  const attach = (entry: HandleEntry): void => {
    const native: FilesystemNativeWatchHandle = options.watch(
      entry.path,
      entry.persistent
        ? { recursive: entry.recursive }
        : { recursive: entry.recursive, persistent: false },
      (eventType, filename) => {
        if (entry.native !== native || !current(entry)) return;
        record(entry, eventType, filename);
      },
    );
    const onError = (error: unknown): void => {
      if (entry.native !== native) return;
      // Closed under either release policy: Node's recursive Linux watcher
      // can keep its watches after an error, while a native `FSWatcher` has
      // already released its handle, so this `close()` cannot block.
      entry.native = null;
      closeNative(native);
      entry.burst = null;
      const live = current(entry) && entry.subscribers.size > 0;
      const unavailable = live
        ? noteUnavailable(entry, error)
        : isUnavailable(error);
      diagnose({
        kind: 'error',
        path: entry.path,
        recursive: entry.recursive,
        error,
        unavailable,
      });
      if (!current(entry)) return;
      if (entry.subscribers.size === 0) {
        stopRescan(entry);
        handles.delete(entry.key);
        return;
      }
      scheduleRetry(entry, null);
    };
    try {
      native.on('error', onError);
    } catch (error) {
      closeNative(native);
      throw error;
    }
    entry.native = native;
  };

  const nextRetryDelay = (
    previousDelayMs: number | null,
    unavailable: boolean,
  ): number => {
    // The first retry stays quick so a failed re-attach signals the rescan.
    if (previousDelayMs === null) return retryMinMs;
    return unavailable ? retryMaxMs : Math.min(previousDelayMs * 2, retryMaxMs);
  };

  function scheduleRetry(
    entry: HandleEntry,
    previousDelayMs: number | null,
    unavailable = false,
  ): void {
    if (entry.retry || entry.subscribers.size === 0 || !current(entry)) return;
    const delayMs = nextRetryDelay(previousDelayMs, unavailable);
    const timer = setTimeout(() => {
      entry.retry = null;
      if (!current(entry) || entry.subscribers.size === 0 || entry.native)
        return;
      try {
        attach(entry);
      } catch (error) {
        const stillUnavailable = noteUnavailable(entry, error);
        diagnose({
          kind: 'retry-failed',
          path: entry.path,
          recursive: entry.recursive,
          error,
          unavailable: stillUnavailable,
          nextDelayMs: nextRetryDelay(delayMs, stillUnavailable),
        });
        // The anchor may be gone (a deleted root): report once, keep retrying.
        if (!entry.lossReported) {
          entry.lossReported = true;
          reportLoss(entry);
        }
        scheduleRetry(entry, delayMs, stillUnavailable);
        return;
      }
      diagnose({
        kind: 'reattached',
        path: entry.path,
        recursive: entry.recursive,
      });
      entry.lossReported = false;
      entry.unavailableReported = false;
      stopRescan(entry);
      reportLoss(entry);
    }, delayMs);
    // A pending re-attach never keeps the process alive.
    timer.unref?.();
    entry.retry = { timer, delayMs };
  }

  const idle = (entry: HandleEntry): void => {
    clearRetry(entry);
    stopRescan(entry);
    entry.burst = null;
    if (entry.retain && entry.native) return;
    const native = entry.native;
    entry.native = null;
    if (current(entry)) handles.delete(entry.key);
    closeNative(native);
  };

  const acquire = (
    anchor: FilesystemWatchAnchor,
    listener: (batch: FilesystemWatchBatch) => void,
  ): FilesystemWatchSubscription => {
    const path = resolve(anchor.path);
    const key = anchorKey(path, anchor.recursive);
    let entry = handles.get(key);
    if (entry && entry.subscribers.size === 0) {
      // A dormant handle ignored its notifications: start a new source.
      entry.epoch = createEpoch();
      entry.sequence = 0;
    }
    if (!entry) {
      entry = {
        key,
        path,
        recursive: anchor.recursive,
        persistent: anchor.persistent ?? true,
        retain: anchor.release === 'retain',
        native: null,
        subscribers: new Set(),
        epoch: createEpoch(),
        sequence: 0,
        burst: null,
        tail: Promise.resolve(),
        retry: null,
        lossReported: false,
        unavailableReported: false,
        rescanWhileUnavailableMs: null,
        rescanTimer: null,
      };
      try {
        attach(entry);
      } catch (error) {
        if (isUnavailable(error))
          reportUnavailable(error, {
            path: entry.path,
            recursive: entry.recursive,
          });
        throw error;
      }
      handles.set(key, entry);
    }
    entry.retain ||= anchor.release === 'retain';
    const rescanMs = anchor.rescanWhileUnavailableMs;
    if (
      rescanMs !== undefined &&
      (entry.rescanWhileUnavailableMs === null ||
        rescanMs < entry.rescanWhileUnavailableMs)
    )
      entry.rescanWhileUnavailableMs = rescanMs;
    const owner = entry;
    const subscriber: Subscriber = { listener };
    owner.subscribers.add(subscriber);
    let released = false;
    return {
      position: { epoch: owner.epoch, sequence: owner.sequence },
      release(): void {
        if (released) return;
        released = true;
        owner.subscribers.delete(subscriber);
        if (owner.subscribers.size === 0) idle(owner);
      },
    };
  };

  return {
    acquire,
    position(anchor): FilesystemWatchPosition | null {
      const entry = handles.get(
        anchorKey(resolve(anchor.path), anchor.recursive),
      );
      if (!entry || entry.subscribers.size === 0) return null;
      return { epoch: entry.epoch, sequence: entry.sequence };
    },
    snapshot(): FilesystemWatchRegistrySnapshot {
      let attached = 0;
      let dormant = 0;
      let retrying = 0;
      let subscribers = 0;
      for (const entry of Array.from(handles.values())) {
        subscribers += entry.subscribers.size;
        if (entry.retry) retrying += 1;
        if (!entry.native) continue;
        if (entry.subscribers.size === 0) dormant += 1;
        else attached += 1;
      }
      return { attached, dormant, retrying, subscribers };
    },
  };
}
