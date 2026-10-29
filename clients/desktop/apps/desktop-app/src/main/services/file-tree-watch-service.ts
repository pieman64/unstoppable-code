import { watch, type FSWatcher } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type {
  FileTreeChangeEvent,
  FileTreeRootsRequest,
} from '@canopy/desktop-shared/types';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  getFileBrowserRoots,
  getFileBrowserSupplementalWatchPaths,
} from '../lib/file-browser-roots';
import { validateId } from '../lib/validation';

const CHANGE_DEBOUNCE_MS = 120;

type FileTreeWatcher = Pick<FSWatcher, 'close' | 'on'>;

type WatchDirectory = (
  path: string,
  options: { recursive: true },
  listener: () => void,
) => FileTreeWatcher;

interface FileTreeWatchDependencies {
  watchDirectory?: WatchDirectory;
  debounceMs?: number;
}

interface WatchSubscription {
  watchers: FileTreeWatcher[];
  timer: ReturnType<typeof setTimeout> | null;
  changeCount: number;
}

const subscriptions = new Map<string, WatchSubscription>();

function closeSubscription(subscription: WatchSubscription): void {
  for (const watcher of subscription.watchers) watcher.close();
  subscription.watchers.length = 0;
  if (subscription.timer !== null) {
    clearTimeout(subscription.timer);
    subscription.timer = null;
  }
}

function scopeKey(ownerId: number, request: FileTreeRootsRequest): string {
  return `${ownerId}:${request.projectId}/${request.worktreeId}`;
}

function removeNestedRoots(paths: readonly string[]): string[] {
  const normalized = Array.from(
    new Set(paths.map((value) => resolve(value))),
  ).sort((left, right) => left.length - right.length);
  return normalized.filter(
    (candidate, index) =>
      !normalized
        .slice(0, index)
        .some((parent) => candidate.startsWith(`${parent}${sep}`)),
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

async function nearestExistingWatchPath(
  pathValue: string,
  stopAt: string,
): Promise<string | null> {
  let candidate = resolve(pathValue);
  const boundary = resolve(stopAt);
  for (;;) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      if (candidate === boundary) return null;
      const parent = dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

async function supplementalWatchPaths(
  paths: readonly string[],
): Promise<string[]> {
  const checked = await Promise.all(
    paths.map((pathValue) =>
      nearestExistingWatchPath(pathValue, dirname(resolve(pathValue))),
    ),
  );
  return checked.filter((pathValue): pathValue is string => pathValue !== null);
}

export async function startFileTreeWatch(
  ownerId: number,
  request: FileTreeRootsRequest,
  onChange: (event: FileTreeChangeEvent) => void,
  dependencies: FileTreeWatchDependencies = {},
): Promise<void> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const key = scopeKey(ownerId, request);
  stopFileTreeWatch(ownerId, request);
  const subscription: WatchSubscription = {
    watchers: [],
    timer: null,
    changeCount: 0,
  };
  subscriptions.set(key, subscription);

  // Replica promotion already emits shared-containers:replica-changed. Native
  // watchers would pin an obsolete sealed revision while it is being pruned.
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) return;

  const emit = (): void => {
    if (subscriptions.get(key) !== subscription) return;
    subscription.changeCount += 1;
    if (subscription.timer !== null) return;
    subscription.timer = setTimeout(() => {
      subscription.timer = null;
      const changeCount = subscription.changeCount;
      subscription.changeCount = 0;
      onChange({ ...request, changeCount });
    }, dependencies.debounceMs ?? CHANGE_DEBOUNCE_MS);
  };

  try {
    const { roots } = await getFileBrowserRoots(
      request.projectId,
      request.worktreeId,
    );
    const supplementalPaths = await supplementalWatchPaths(
      getFileBrowserSupplementalWatchPaths(
        request.projectId,
        request.worktreeId,
      ),
    );
    if (subscriptions.get(key) !== subscription) return;
    for (const rootPath of removeNestedRoots(
      roots.map((root) => root.absolutePath).concat(supplementalPaths),
    )) {
      if (subscriptions.get(key) !== subscription) return;
      const watcher = (dependencies.watchDirectory ?? watch)(
        rootPath,
        { recursive: true },
        emit,
      );
      if (subscriptions.get(key) !== subscription) {
        watcher.close();
        return;
      }
      watcher.on('error', () => {
        // Native watch streams may become invalid when their root is removed.
        // The renderer's manual refresh remains available; avoid throwing from
        // an event emitter on the main process.
      });
      subscription.watchers.push(watcher);
    }
  } catch (error) {
    if (subscriptions.get(key) === subscription) {
      subscriptions.delete(key);
    }
    closeSubscription(subscription);
    throw error;
  }
}

export function stopFileTreeWatch(
  ownerId: number,
  request: FileTreeRootsRequest,
): void {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const key = scopeKey(ownerId, request);
  const subscription = subscriptions.get(key);
  if (!subscription) return;
  subscriptions.delete(key);
  closeSubscription(subscription);
}

export function stopAllFileTreeWatches(ownerId: number): void {
  const prefix = `${ownerId}:`;
  for (const [key, subscription] of Array.from(subscriptions.entries())) {
    if (!key.startsWith(prefix)) continue;
    subscriptions.delete(key);
    closeSubscription(subscription);
  }
}

export function getFileTreeWatchCount(): number {
  return subscriptions.size;
}
