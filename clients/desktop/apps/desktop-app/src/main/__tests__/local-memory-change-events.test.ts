import type * as NodeFs from 'node:fs';
import type { LocalMemoryScopeRequest } from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { EventEmitter } from 'node:events';

interface MockWatcher {
  directory: string;
  listener: () => void;
  emitter: EventEmitter;
  close: jest.Mock;
}

const watchers: MockWatcher[] = [];
const missingDirectories = new Set<string>();
const existsMock = jest.fn(
  (directory: string): boolean => !missingDirectories.has(directory),
);
const watchMock = jest.fn(
  (directory: string, _options: unknown, listener: () => void): unknown => {
    if (missingDirectories.has(directory)) {
      throw Object.assign(new Error(`ENOENT: ${directory}`), {
        code: 'ENOENT',
      });
    }
    if (directory.endsWith('forbidden')) {
      throw Object.assign(new Error(`EPERM: ${directory}`), { code: 'EPERM' });
    }
    const emitter = new EventEmitter();
    const watcher: MockWatcher = {
      directory,
      listener,
      emitter,
      close: jest.fn(),
    };
    watchers.push(watcher);
    return {
      on: (event: string, handler: (error: unknown) => void): unknown =>
        emitter.on(event, handler),
      close: watcher.close,
    };
  },
);
const sendMock = jest.fn();
const warnMock = jest.fn();

jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof NodeFs>('node:fs'),
  existsSync: (directory: string): boolean => existsMock(directory),
  watch: (...args: [string, unknown, () => void]): unknown =>
    watchMock(...args),
}));
jest.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: (): unknown[] => [
      {
        isDestroyed: (): boolean => false,
        webContents: {
          isDestroyed: (): boolean => false,
          send: (...args: unknown[]): unknown => sendMock(...args),
        },
      },
      {
        isDestroyed: (): boolean => true,
        webContents: {
          isDestroyed: (): boolean => true,
          send: (...args: unknown[]): unknown => sendMock(...args),
        },
      },
    ],
  },
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: (...args: unknown[]): unknown => warnMock(...args),
}));

import {
  LOCAL_MEMORY_CHANGE_DEBOUNCE_MS,
  LOCAL_MEMORY_WATCH_RETRY_MAX_MS,
  LOCAL_MEMORY_WATCH_RETRY_MIN_MS,
  broadcastLocalMemoryChanged,
  dropLocalMemoryWatchers,
  localMemoryChangeEventsTestExports,
  unwatchLocalMemoryScope,
  watchLocalMemoryScope,
} from '../memory/local/change-events';

const USER: LocalMemoryScopeRequest = { scope: 'user' };
const WORKSPACE: LocalMemoryScopeRequest = {
  scope: 'workspace',
  workspaceId: 'project-1',
};

function sender(id: number): {
  id: number;
  once: jest.Mock;
  destroy: () => void;
} {
  const emitter = new EventEmitter();
  return {
    id,
    once: jest.fn((event: string, handler: () => void) =>
      emitter.once(event, handler),
    ),
    destroy: (): void => {
      emitter.emit('destroyed');
    },
  };
}

function watchedDirectories(): string[] {
  return watchers.map((watcher) => watcher.directory).sort();
}

describe('local memory change events', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    watchers.splice(0, watchers.length);
    missingDirectories.clear();
    localMemoryChangeEventsTestExports.reset();
  });

  afterEach(() => {
    localMemoryChangeEventsTestExports.reset();
    jest.useRealTimers();
  });

  it('coalesces bursts into one broadcast per scope after the debounce', () => {
    broadcastLocalMemoryChanged(USER);
    broadcastLocalMemoryChanged(USER);
    broadcastLocalMemoryChanged(WORKSPACE);
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS - 1);
    expect(sendMock).not.toHaveBeenCalled();
    broadcastLocalMemoryChanged(USER);
    jest.advanceTimersByTime(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      IPC_CHANNELS.localMemoryChanged,
      WORKSPACE,
    );
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenLastCalledWith(
      IPC_CHANNELS.localMemoryChanged,
      USER,
    );
  });

  it('watches the complete scope recursively with one native handle', () => {
    watchLocalMemoryScope(USER, '/memory/user', sender(1));
    expect(watchedDirectories()).toEqual(['/memory/user']);
    expect(watchMock).toHaveBeenLastCalledWith(
      expect.any(String),
      { persistent: false, recursive: true },
      expect.any(Function),
    );
    watchers[0]?.listener();
    expect(sendMock).not.toHaveBeenCalled();
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      IPC_CHANNELS.localMemoryChanged,
      USER,
    );
  });

  it('keeps one recursive watcher dormant across explorer navigation', () => {
    const first = sender(1);
    watchLocalMemoryScope(USER, '/memory/user', first);

    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(watchMock).toHaveBeenCalledWith(
      '/memory/user',
      { persistent: false, recursive: true },
      expect.any(Function),
    );

    unwatchLocalMemoryScope(USER, first.id);
    expect(watchers[0]?.close).not.toHaveBeenCalled();
    watchers[0]?.listener();
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(sendMock).not.toHaveBeenCalled();

    watchLocalMemoryScope(USER, '/memory/user', sender(2));
    expect(watchMock).toHaveBeenCalledTimes(1);
    watchers[0]?.listener();
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(sendMock).toHaveBeenCalledWith(
      IPC_CHANNELS.localMemoryChanged,
      USER,
    );
  });

  it('folds an explicit broadcast into the same debounce as the fs events', () => {
    watchLocalMemoryScope(USER, '/memory/user', sender(1));
    broadcastLocalMemoryChanged(USER);
    watchers[0]?.listener();
    watchers[1]?.listener();
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('observes subdirectories created after the recursive watcher starts', () => {
    missingDirectories.add('/memory/user/topics');
    missingDirectories.add('/memory/user/inbox');
    watchLocalMemoryScope(USER, '/memory/user', sender(1));
    expect(watchedDirectories()).toEqual(['/memory/user']);
    expect(warnMock).not.toHaveBeenCalled();
    missingDirectories.delete('/memory/user/inbox');
    // The recursive scope watcher reports a note written into the new folder.
    watchers[0]?.listener();
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(watchedDirectories()).toEqual(['/memory/user']);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('watches the parent until an absent scope directory appears, then hands over', () => {
    for (const directory of [
      '/memory/user',
      '/memory/user/topics',
      '/memory/user/inbox',
    ])
      missingDirectories.add(directory);
    const renderer = sender(1);
    watchLocalMemoryScope(USER, '/memory/user', renderer);
    expect(watchedDirectories()).toEqual(['/memory']);
    const parent = watchers[0];
    // The first note creates memory/ and memory/inbox/ under the parent.
    missingDirectories.delete('/memory/user');
    missingDirectories.delete('/memory/user/inbox');
    parent?.listener();
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(parent?.close).not.toHaveBeenCalled();
    expect(
      localMemoryChangeEventsTestExports.watchedDirectories(USER).sort(),
    ).toEqual(['/memory', '/memory/user']);
    expect(sendMock).toHaveBeenCalledTimes(1);
    // Releasing the last subscriber leaves both native handles dormant.
    unwatchLocalMemoryScope(USER, 1);
    expect(
      watchers.every((watcher) => watcher.close.mock.calls.length === 0),
    ).toBe(true);
  });

  it('leaves a parent watcher dormant after its renderer is destroyed', () => {
    missingDirectories.add('/memory/workspaces/project-1');
    missingDirectories.add('/memory/workspaces/project-1/topics');
    missingDirectories.add('/memory/workspaces/project-1/inbox');
    const renderer = sender(2);
    watchLocalMemoryScope(WORKSPACE, '/memory/workspaces/project-1', renderer);
    expect(watchedDirectories()).toEqual(['/memory/workspaces']);
    renderer.destroy();
    expect(watchers[0]?.close).not.toHaveBeenCalled();
    expect(
      localMemoryChangeEventsTestExports.watchedDirectories(WORKSPACE),
    ).toEqual(['/memory/workspaces']);
    watchers[0]?.listener();
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('logs non-ENOENT watch failures and keeps the remaining watchers', () => {
    watchLocalMemoryScope(
      { scope: 'workspace', workspaceId: 'forbidden' },
      '/memory/forbidden',
      sender(1),
    );
    expect(warnMock).toHaveBeenCalledWith(
      'Local memory watcher could not start',
      expect.objectContaining({ directory: '/memory/forbidden' }),
    );
    expect(watchedDirectories()).toEqual([]);
  });

  it('forgets a stopped watcher without closing it and re-attaches on change', () => {
    watchLocalMemoryScope(USER, '/memory/user', sender(1));
    const scopeWatcher = watchers.find(
      (watcher) => watcher.directory === '/memory/user',
    );
    scopeWatcher?.emitter.emit(
      'error',
      Object.assign(new Error('EPERM'), { code: 'EPERM' }),
    );
    expect(scopeWatcher?.close).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      'Local memory watcher stopped',
      expect.objectContaining({ directory: '/memory/user' }),
    );
    expect(localMemoryChangeEventsTestExports.watchedDirectories(USER)).toEqual(
      [],
    );
    broadcastLocalMemoryChanged(USER);
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(localMemoryChangeEventsTestExports.watchedDirectories(USER)).toEqual(
      ['/memory/user'],
    );
  });

  it('re-establishes an errored watcher with backoff while subscribers remain', () => {
    missingDirectories.add('/memory/user');
    watchLocalMemoryScope(USER, '/memory/user', sender(1));
    const parent = watchers[0];
    // While the retry is pending, watch() keeps failing for the parent.
    missingDirectories.add('/memory');
    parent?.emitter.emit(
      'error',
      Object.assign(new Error('EPERM'), { code: 'EPERM' }),
    );
    expect(localMemoryChangeEventsTestExports.hasPendingRetry(USER)).toBe(true);
    const attemptsBefore = watchMock.mock.calls.length;
    jest.advanceTimersByTime(LOCAL_MEMORY_WATCH_RETRY_MIN_MS);
    expect(watchMock.mock.calls.length).toBeGreaterThan(attemptsBefore);
    expect(
      localMemoryChangeEventsTestExports.watchedDirectories(USER).sort(),
    ).toEqual([]);
    expect(localMemoryChangeEventsTestExports.hasPendingRetry(USER)).toBe(true);
    // Second attempt runs after twice the delay and succeeds once the
    // directory is watchable again.
    missingDirectories.delete('/memory');
    jest.advanceTimersByTime(LOCAL_MEMORY_WATCH_RETRY_MIN_MS * 2 - 1);
    expect(
      localMemoryChangeEventsTestExports.watchedDirectories(USER),
    ).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(
      localMemoryChangeEventsTestExports.watchedDirectories(USER).sort(),
    ).toEqual(['/memory']);
    expect(watchMock).toHaveBeenLastCalledWith(
      '/memory',
      { persistent: false, recursive: false },
      expect.any(Function),
    );
    expect(localMemoryChangeEventsTestExports.hasPendingRetry(USER)).toBe(
      false,
    );
    // The re-established watcher reports changes again.
    watchers[watchers.length - 1]?.listener();
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('caps the watcher retry backoff and stops retrying once unwatched', () => {
    missingDirectories.add('/memory/user');
    watchLocalMemoryScope(USER, '/memory/user', sender(1));
    missingDirectories.add('/memory');
    watchers[0]?.emitter.emit('error', new Error('EIO'));
    let delay = LOCAL_MEMORY_WATCH_RETRY_MIN_MS;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = watchMock.mock.calls.length;
      jest.advanceTimersByTime(delay);
      expect(watchMock.mock.calls.length).toBe(before + 1);
      delay = Math.min(delay * 2, LOCAL_MEMORY_WATCH_RETRY_MAX_MS);
    }
    expect(delay).toBe(LOCAL_MEMORY_WATCH_RETRY_MAX_MS);
    expect(localMemoryChangeEventsTestExports.hasPendingRetry(USER)).toBe(true);
    unwatchLocalMemoryScope(USER, 1);
    expect(localMemoryChangeEventsTestExports.hasPendingRetry(USER)).toBe(
      false,
    );
    const afterRelease = watchMock.mock.calls.length;
    jest.advanceTimersByTime(LOCAL_MEMORY_WATCH_RETRY_MAX_MS * 2);
    expect(watchMock.mock.calls.length).toBe(afterRelease);
  });

  it('retires a vanished scope watcher without blocking reuse', () => {
    watchLocalMemoryScope(USER, '/memory/user', sender(1));
    const scopeWatcher = watchers[0];
    missingDirectories.add('/memory/user');
    broadcastLocalMemoryChanged(USER);
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(scopeWatcher?.close).not.toHaveBeenCalled();
    expect(
      localMemoryChangeEventsTestExports.watchedDirectories(USER).sort(),
    ).toEqual(['/memory']);

    missingDirectories.delete('/memory/user');
    watchers.at(-1)?.listener();
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(
      localMemoryChangeEventsTestExports.watchedDirectories(USER).sort(),
    ).toEqual(['/memory', '/memory/user']);

    sendMock.mockClear();
    scopeWatcher?.listener();
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('refcounts subscriptions per renderer and per explorer', () => {
    const first = sender(1);
    const second = sender(2);
    watchLocalMemoryScope(USER, '/memory/user', first);
    watchLocalMemoryScope(USER, '/memory/user', first);
    watchLocalMemoryScope(USER, '/memory/user', second);
    expect(watchMock).toHaveBeenCalledTimes(1);
    unwatchLocalMemoryScope(USER, 1);
    unwatchLocalMemoryScope(USER, 2);
    expect(watchers.every((watcher) => !watcher.close.mock.calls.length)).toBe(
      true,
    );
    unwatchLocalMemoryScope(USER, 1);
    expect(watchers[0]?.close).not.toHaveBeenCalled();
    expect(localMemoryChangeEventsTestExports.watchedDirectories(USER)).toEqual(
      ['/memory/user'],
    );
    unwatchLocalMemoryScope(USER, 1);
    watchers[0]?.listener();
    jest.advanceTimersByTime(LOCAL_MEMORY_CHANGE_DEBOUNCE_MS);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('releases every scope held by a destroyed renderer', () => {
    const renderer = sender(3);
    watchLocalMemoryScope(USER, '/memory/user', renderer);
    watchLocalMemoryScope(WORKSPACE, '/memory/workspaces/project-1', renderer);
    watchLocalMemoryScope(WORKSPACE, '/memory/workspaces/project-1', sender(4));
    expect(renderer.once).toHaveBeenCalledWith(
      'destroyed',
      expect.any(Function),
    );
    renderer.destroy();
    expect(localMemoryChangeEventsTestExports.watchedDirectories(USER)).toEqual(
      ['/memory/user'],
    );
    expect(
      localMemoryChangeEventsTestExports.watchedDirectories(WORKSPACE),
    ).toHaveLength(1);
    dropLocalMemoryWatchers(4);
    expect(
      localMemoryChangeEventsTestExports.watchedDirectories(WORKSPACE),
    ).toEqual(['/memory/workspaces/project-1']);
  });
});
