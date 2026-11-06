import { existsSync, watch, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BrowserWindow, type WebContents } from 'electron';
import {
  IPC_CHANNELS,
  type LocalMemoryScopeRequest,
} from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { sendToWebContents } from '../../lib/web-contents-send';

/**
 * Change notifications for the local memory explorer.
 *
 * Every internal writer (explorer edits, `save_memory`, consolidation,
 * imports) calls {@link broadcastLocalMemoryChanged}; renderers that show a
 * scope additionally hold a refcounted `fs.watch` on the scope directory so
 * external edits surface too. Both paths funnel through one trailing debounce
 * per scope, so an internal write and the filesystem events it produces
 * collapse into a single `local-memory:changed` broadcast.
 */
export const LOCAL_MEMORY_CHANGE_DEBOUNCE_MS = 300;
/** Backoff for re-establishing a watcher that errored: 1 s doubling to 30 s. */
export const LOCAL_MEMORY_WATCH_RETRY_MIN_MS = 1_000;
export const LOCAL_MEMORY_WATCH_RETRY_MAX_MS = 30_000;

interface ScopeWatch {
  scope: LocalMemoryScopeRequest;
  /** The folder the scope resolved to when last watched; it can move. */
  scopeDir: string;
  watchers: Map<string, FSWatcher>;
  /**
   * Handles of folders the scope moved away from, kept open rather than
   * closed (see `watchDirectory`) and reused if it moves back.
   */
  dormant: Map<string, { watcher: FSWatcher; recursive: boolean }>;
  /** Open explorer count per renderer, keyed by `webContents.id`. */
  subscribers: Map<number, number>;
  /** Pending re-attach after a watcher error, with its current backoff. */
  retry: { timer: ReturnType<typeof setTimeout>; delayMs: number } | null;
}

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const watches = new Map<string, ScopeWatch>();
const destroyHooks = new Set<number>();
const retiredWatchers = new Set<FSWatcher>();

export function localMemoryScopeKey(scope: LocalMemoryScopeRequest): string {
  return scope.scope === 'user' ? 'user' : `workspace:${scope.workspaceId}`;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendToAllWindows(scope: LocalMemoryScopeRequest): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed())
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.localMemoryChanged,
        scope,
      );
  }
}

export function broadcastLocalMemoryChanged(
  scope: LocalMemoryScopeRequest,
): void {
  const key = localMemoryScopeKey(scope);
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    // A write may have created the scope directory or one of its
    // subdirectories; attach the watchers that were missing before it.
    const entry = watches.get(key);
    if (entry) reconcileWatchers(entry);
    sendToAllWindows(scope);
  }, LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
  timer.unref?.();
  debounceTimers.set(key, timer);
}

function closeWatcher(entry: ScopeWatch, directory: string): void {
  const watcher = entry.watchers.get(directory);
  if (!watcher) return;
  entry.watchers.delete(directory);
  try {
    watcher.close();
  } catch {
    // Already closed by the runtime after an error; nothing to release.
  }
}

function retireWatcher(entry: ScopeWatch, directory: string): void {
  const watcher = entry.watchers.get(directory);
  if (!watcher) return;
  entry.watchers.delete(directory);
  retiredWatchers.add(watcher);
}

function watchDirectory(
  entry: ScopeWatch,
  directory: string,
  recursive: boolean,
): void {
  if (entry.watchers.has(directory)) return;
  const dormant = entry.dormant.get(directory);
  if (dormant?.recursive === recursive) {
    entry.dormant.delete(directory);
    entry.watchers.set(directory, dormant.watcher);
    clearWatchRetry(entry);
    return;
  }
  let watcher: FSWatcher;
  try {
    watcher = watch(directory, { persistent: false, recursive }, (): void => {
      if (watches.get(localMemoryScopeKey(entry.scope)) !== entry) return;
      if (entry.watchers.get(directory) !== watcher) return;
      if (entry.subscribers.size === 0) return;
      // A parent watcher only bridges an initially absent scope directory.
      // Keep its native handle dormant after the scope appears: closing an
      // fs.watch handle can synchronously block Electron main for hundreds of
      // milliseconds on macOS, while the recursive scope watcher below owns
      // all subsequent notifications.
      if (
        directory !== entry.scopeDir &&
        existsSync(entry.scopeDir) &&
        entry.watchers.has(entry.scopeDir)
      )
        return;
      broadcastLocalMemoryChanged(entry.scope);
    });
  } catch (error) {
    // Absent directories are expected (fresh scopes, no topics yet); they
    // are retried on the next change. Anything else is logged once here.
    if (!isNodeError(error, 'ENOENT'))
      logMainProcessWarn('Local memory watcher could not start', {
        directory,
        error: errorMessage(error),
      });
    return;
  }
  watcher.on('error', (error: unknown): void => {
    if (entry.watchers.get(directory) !== watcher) {
      retiredWatchers.delete(watcher);
      if (entry.dormant.get(directory)?.watcher === watcher)
        entry.dormant.delete(directory);
      return;
    }
    logMainProcessWarn('Local memory watcher stopped', {
      directory,
      error: errorMessage(error),
    });
    // Node stops an FSWatcher when it emits an error. Forget the stopped
    // handle without calling close() again: close is synchronous and can
    // block Electron main for hundreds of milliseconds on macOS.
    entry.watchers.delete(directory);
    scheduleWatchRetry(entry);
  });
  entry.watchers.set(directory, watcher);
  // A successful attach ends the backoff cycle for this scope.
  if (entry.retry) {
    clearTimeout(entry.retry.timer);
    entry.retry = null;
  }
}

function clearWatchRetry(entry: ScopeWatch): void {
  if (!entry.retry) return;
  clearTimeout(entry.retry.timer);
  entry.retry = null;
}

/**
 * Re-establishes errored watchers while the scope still has subscribers,
 * backing off from one second and capping at thirty. The timer is unref'd so
 * a pending retry never keeps the process alive.
 */
function scheduleWatchRetry(entry: ScopeWatch, previousDelayMs = 0): void {
  if (entry.retry || entry.subscribers.size === 0) return;
  if (watches.get(localMemoryScopeKey(entry.scope)) !== entry) return;
  const delayMs =
    previousDelayMs === 0
      ? LOCAL_MEMORY_WATCH_RETRY_MIN_MS
      : Math.min(previousDelayMs * 2, LOCAL_MEMORY_WATCH_RETRY_MAX_MS);
  const timer = setTimeout(() => {
    entry.retry = null;
    if (watches.get(localMemoryScopeKey(entry.scope)) !== entry) return;
    const before = entry.watchers.size;
    reconcileWatchers(entry);
    // Nothing new attached (still failing or the directory is still gone):
    // keep trying, slower. A successful attach cleared the retry already.
    if (entry.watchers.size <= before) scheduleWatchRetry(entry, delayMs);
  }, delayMs);
  timer.unref?.();
  entry.retry = { timer, delayMs };
}

/**
 * Drops watchers whose directory vanished and attaches any that are missing.
 * A scope whose directory does not exist yet is watched through its parent,
 * so the first note written into a fresh scope still reaches the explorer;
 * after that, the parent handle remains dormant so navigation never pays the
 * synchronous FSWatcher.close() cost on Electron main.
 */
function reconcileWatchers(entry: ScopeWatch): void {
  for (const directory of Array.from(entry.watchers.keys())) {
    if (!existsSync(directory)) retireWatcher(entry, directory);
  }
  for (const [directory, { watcher }] of Array.from(entry.dormant)) {
    if (existsSync(directory)) continue;
    entry.dormant.delete(directory);
    retiredWatchers.add(watcher);
  }
  const parent = dirname(entry.scopeDir);
  if (existsSync(entry.scopeDir)) {
    watchDirectory(entry, entry.scopeDir, true);
    return;
  }
  if (parent !== entry.scopeDir) watchDirectory(entry, parent, false);
}

/**
 * Points a scope's watch at the folder it resolves to now (an account
 * replica registered or removed). The old handles stay open but dormant.
 */
function moveWatch(entry: ScopeWatch, scopeDir: string): void {
  for (const [directory, watcher] of Array.from(entry.watchers)) {
    const recursive = directory === entry.scopeDir;
    const replaced = entry.dormant.get(directory);
    if (replaced !== undefined) retiredWatchers.add(replaced.watcher);
    entry.dormant.set(directory, { watcher, recursive });
  }
  entry.watchers.clear();
  clearWatchRetry(entry);
  entry.scopeDir = scopeDir;
  reconcileWatchers(entry);
}

/**
 * Moves every scope watch whose scope now resolves to another folder, as
 * `dirFor` answers, and tells renderers those scopes changed.
 */
export function retargetLocalMemoryWatches(
  dirFor: (scope: LocalMemoryScopeRequest) => string,
): void {
  for (const entry of Array.from(watches.values())) {
    const scopeDir = resolve(dirFor(entry.scope));
    if (scopeDir === entry.scopeDir) continue;
    moveWatch(entry, scopeDir);
    broadcastLocalMemoryChanged(entry.scope);
  }
}

function releaseEntry(key: string, entry: ScopeWatch): void {
  clearWatchRetry(entry);
  for (const directory of Array.from(entry.watchers.keys()))
    closeWatcher(entry, directory);
  for (const { watcher } of entry.dormant.values()) {
    try {
      watcher.close();
    } catch {
      // Already stopped by the runtime after an error.
    }
  }
  entry.dormant.clear();
  if (watches.get(key) === entry) watches.delete(key);
}

export function watchLocalMemoryScope(
  scope: LocalMemoryScopeRequest,
  scopeDir: string,
  sender: WebContents,
): void {
  const key = localMemoryScopeKey(scope);
  let entry = watches.get(key);
  if (!entry) {
    entry = {
      scope,
      scopeDir: resolve(scopeDir),
      watchers: new Map(),
      dormant: new Map(),
      subscribers: new Map(),
      retry: null,
    };
    watches.set(key, entry);
  } else if (resolve(scopeDir) !== entry.scopeDir) {
    moveWatch(entry, resolve(scopeDir));
  }
  entry.subscribers.set(sender.id, (entry.subscribers.get(sender.id) ?? 0) + 1);
  if (!destroyHooks.has(sender.id)) {
    destroyHooks.add(sender.id);
    const senderId = sender.id;
    sender.once('destroyed', (): void => {
      destroyHooks.delete(senderId);
      dropLocalMemoryWatchers(senderId);
    });
  }
  reconcileWatchers(entry);
}

export function unwatchLocalMemoryScope(
  scope: LocalMemoryScopeRequest,
  webContentsId: number,
): void {
  const key = localMemoryScopeKey(scope);
  const entry = watches.get(key);
  if (!entry) return;
  const count = entry.subscribers.get(webContentsId) ?? 0;
  if (count <= 1) entry.subscribers.delete(webContentsId);
  else entry.subscribers.set(webContentsId, count - 1);
  if (entry.subscribers.size === 0) clearWatchRetry(entry);
}

export function dropLocalMemoryWatchers(webContentsId: number): void {
  for (const entry of Array.from(watches.values())) {
    if (!entry.subscribers.delete(webContentsId)) continue;
    if (entry.subscribers.size === 0) clearWatchRetry(entry);
  }
}

export const localMemoryChangeEventsTestExports = {
  hasPendingRetry(scope: LocalMemoryScopeRequest): boolean {
    const entry = watches.get(localMemoryScopeKey(scope));
    return entry !== undefined && entry.retry !== null;
  },
  watchedDirectories(scope: LocalMemoryScopeRequest): string[] {
    const entry = watches.get(localMemoryScopeKey(scope));
    return entry ? Array.from(entry.watchers.keys()) : [];
  },
  reset(): void {
    for (const timer of Array.from(debounceTimers.values()))
      clearTimeout(timer);
    debounceTimers.clear();
    for (const [key, entry] of Array.from(watches.entries()))
      releaseEntry(key, entry);
    for (const watcher of Array.from(retiredWatchers)) {
      try {
        watcher.close();
      } catch {
        // Already stopped after its watched directory disappeared.
      }
    }
    retiredWatchers.clear();
    destroyHooks.clear();
  },
};
