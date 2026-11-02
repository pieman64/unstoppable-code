/**
 * CAN-4102 golden: file-tree watch IPC behavior pinned at the IPC boundary.
 * Captured on the pre-migration watch service and kept unmodified across the
 * move to `worker.filesystem.watch`, so module-level tests can move with the
 * code without losing the legacy contract.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  COWORK_WORKSPACE_FILE_ROOT_ID,
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import type { FileBrowserRoot } from '../../lib/file-browser-roots';

interface FakeWatcher {
  path: string;
  options: unknown;
  listener: (...args: unknown[]) => void;
  close: jest.Mock;
  errorListeners: Array<(error: unknown) => void>;
  closed: boolean;
}

interface FakeHandle {
  close: jest.Mock;
  on: (event: string, callback: (error: unknown) => void) => FakeHandle;
}

const watchers: FakeWatcher[] = [];
let watchFailure: ((path: string) => Error | null) | null = null;

jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    watch: jest.fn(
      (
        path: string,
        options: unknown,
        listener: (...args: unknown[]) => void,
      ) => {
        const failure = watchFailure?.(path);
        if (failure) throw failure;
        const watcher: FakeWatcher = {
          path,
          options,
          listener,
          errorListeners: [],
          closed: false,
          close: jest.fn(() => {
            watcher.closed = true;
          }),
        };
        watchers.push(watcher);
        const handle: FakeHandle = {
          close: watcher.close,
          on: (event, callback) => {
            if (event === 'error') watcher.errorListeners.push(callback);
            return handle;
          },
        };
        return handle;
      },
    ),
  };
});

type Handler = (event: unknown, request: unknown) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

const sends: Array<{ sender: unknown; channel: string; payload: unknown }> = [];
jest.mock('../../lib/web-contents-send', () => ({
  sendToWebContents: (
    sender: unknown,
    channel: string,
    payload: unknown,
  ): void => {
    sends.push({ sender, channel, payload });
  },
}));

// No requireActual: loading the real module re-enters this factory through
// its own imports and hands some importers a second, unconfigured mock.
jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
  getFileBrowserSupplementalWatchPaths: jest.fn(),
}));

import {
  getFileBrowserRoots,
  getFileBrowserSupplementalWatchPaths,
} from '../../lib/file-browser-roots';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { registerFileTreeHandlers } from '../file-tree';

const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);
const mockedSupplementalPaths = jest.mocked(
  getFileBrowserSupplementalWatchPaths,
);

interface FakeSender {
  id: number;
  once: jest.Mock;
  isDestroyed: jest.Mock;
  destroy(): void;
}

// Main keeps per-sender teardown state for the process lifetime, so every
// test uses fresh sender ids.
let nextSenderId = 1;

function createSender(): FakeSender {
  const id = nextSenderId++;
  const destroyedListeners: Array<() => void> = [];
  let destroyed = false;
  return {
    id,
    once: jest.fn((event: string, listener: () => void) => {
      if (event === 'destroyed') destroyedListeners.push(listener);
    }),
    isDestroyed: jest.fn(() => destroyed),
    destroy(): void {
      destroyed = true;
      for (const listener of destroyedListeners.splice(0)) listener();
    },
  };
}

function caller(sender: FakeSender): CanopyCallerDescriptor {
  return {
    principalId: 'local',
    clientInstanceId: `electron-web-contents:${sender.id}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read'],
  };
}

function root(
  repoId: string,
  absolutePath: string,
  rootKind: FileBrowserRoot['rootKind'],
): FileBrowserRoot {
  return {
    repoId,
    repoName: repoId,
    absolutePath,
    rootKind,
    gitAware: rootKind === 'git-repo',
    excludedDescendantRoots: [],
  };
}

function setRoots(roots: FileBrowserRoot[], supplemental: string[] = []): void {
  mockedGetFileBrowserRoots.mockImplementation(() =>
    Promise.resolve({
      roots,
      rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
    }),
  );
  mockedSupplementalPaths.mockImplementation(() => supplemental);
}

function openWatchers(): FakeWatcher[] {
  return watchers.filter((watcher) => !watcher.closed);
}

function openWatchPaths(): string[] {
  return openWatchers()
    .map((watcher) => watcher.path)
    .sort();
}

function fire(path: string): void {
  const live = openWatchers().filter((watcher) => watcher.path === path);
  if (live.length === 0) throw new Error(`No live watcher for ${path}`);
  for (const watcher of live) watcher.listener();
}

function changedSends(): Array<{ sender: unknown; payload: unknown }> {
  return sends
    .filter((entry) => entry.channel === IPC_CHANNELS.fileTreeChanged)
    .map(({ sender, payload }) => ({ sender, payload }));
}

function useFakeTimers(): void {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask'],
  });
}

/** Lets any batching scheduled on the real event loop run. */
async function settleNativeBatch(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

let tempRoot = '';
let runtime: DesktopCanopyDispatcher | undefined;
let start: (sender: FakeSender, request: unknown) => Promise<unknown>;
let stop: (sender: FakeSender, request: unknown) => unknown;

const request = { projectId: 'project-1', worktreeId: 'wt-1' };

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'file-tree-watch-golden-'));
  watchers.length = 0;
  sends.length = 0;
  watchFailure = null;
  handlers.clear();
  mockedGetFileBrowserRoots.mockReset();
  mockedSupplementalPaths.mockReset();
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
  const callers = new WeakMap<object, CanopyCallerDescriptor>();
  registerFileTreeHandlers(runtime, (event) => {
    const resolved = callers.get(event.sender);
    if (!resolved) throw new Error('Unknown sender.');
    return resolved;
  });
  const startHandler = handlers.get(IPC_CHANNELS.fileTreeWatchStart);
  const stopHandler = handlers.get(IPC_CHANNELS.fileTreeWatchStop);
  if (!startHandler || !stopHandler)
    throw new Error('Missing file-tree watch handlers.');
  // Async bodies run synchronously up to the first await, as Electron
  // invokes handlers, so a stop sent next arrives mid-start.
  start = async (sender, payload): Promise<unknown> => {
    callers.set(sender, caller(sender));
    return await startHandler({ sender }, payload);
  };
  stop = (sender, payload): unknown => {
    callers.set(sender, caller(sender));
    return stopHandler({ sender }, payload);
  };
});

afterEach(async () => {
  jest.useRealTimers();
  for (const watcher of openWatchers()) watcher.close();
  await runtime?.shutdown();
  runtime = undefined;
  await rm(tempRoot, { recursive: true, force: true });
});

async function singleRepoFixture(
  attachments: 'visible' | 'empty' | 'parent-only' | 'missing',
): Promise<{ repo: string; attachments: string }> {
  const repo = join(tempRoot, 'worktrees', 'wt-1');
  const attachmentsDir = join(tempRoot, 'workspace', 'attachments', 'wt-1');
  await mkdir(repo, { recursive: true });
  if (attachments === 'visible' || attachments === 'empty')
    await mkdir(attachmentsDir, { recursive: true });
  if (attachments === 'parent-only')
    await mkdir(dirname(attachmentsDir), { recursive: true });
  setRoots(
    [
      root('project-1', repo, 'git-repo'),
      ...(attachments === 'visible'
        ? [root('attachments', attachmentsDir, 'attachments')]
        : []),
    ],
    [attachmentsDir],
  );
  return { repo, attachments: attachmentsDir };
}

describe('file-tree watch IPC golden (CAN-4102)', () => {
  it('watches the repo and the hidden attachments root of a single-repo worktree', async () => {
    const { repo, attachments } = await singleRepoFixture('empty');
    const sender = createSender();
    await expect(start(sender, request)).resolves.toBeUndefined();
    expect(openWatchPaths()).toEqual([attachments, repo].sort());
    for (const watcher of watchers)
      expect(watcher.options).toEqual(
        expect.objectContaining({ recursive: true }),
      );
  });

  it('watches a visible attachments root once', async () => {
    const { repo, attachments } = await singleRepoFixture('visible');
    await start(createSender(), request);
    expect(openWatchPaths()).toEqual([attachments, repo].sort());
  });

  it('bridges an absent attachments root through its existing parent', async () => {
    const { repo, attachments } = await singleRepoFixture('parent-only');
    const sender = createSender();
    await start(sender, request);
    expect(openWatchPaths()).toEqual([dirname(attachments), repo].sort());

    useFakeTimers();
    fire(dirname(attachments));
    await settleNativeBatch();
    await jest.advanceTimersByTimeAsync(120);
    expect(changedSends()).toEqual([
      { sender, payload: { ...request, changeCount: 1 } },
    ]);
  });

  it('does not climb above a missing attachments hierarchy', async () => {
    const { repo } = await singleRepoFixture('missing');
    await start(createSender(), request);
    expect(openWatchPaths()).toEqual([repo]);
  });

  it('watches only the outermost roots of a multi-repo worktree', async () => {
    const workspaceRoot = join(tempRoot, 'worktrees', 'wt-1');
    const repoA = join(workspaceRoot, 'repos', 'a');
    const repoB = join(workspaceRoot, 'repos', 'b');
    const attachments = join(tempRoot, 'workspace', 'attachments', 'wt-1');
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await mkdir(attachments, { recursive: true });
    setRoots(
      [
        root(WORKSPACE_ROOT_REPO_ID, workspaceRoot, 'workspace-root'),
        root('a', repoA, 'git-repo'),
        root('b', repoB, 'git-repo'),
      ],
      [attachments],
    );
    await start(createSender(), request);
    expect(openWatchPaths()).toEqual([attachments, workspaceRoot].sort());
  });

  it('watches a cowork home once, covering its managed folders', async () => {
    const home = join(tempRoot, 'cowork-home');
    const managed = join(home, '.canopy');
    await mkdir(join(managed, 'notes'), { recursive: true });
    await mkdir(join(managed, 'prompts'), { recursive: true });
    setRoots(
      [
        root(COWORK_WORKSPACE_FILE_ROOT_ID, home, 'standalone'),
        root('notes', join(managed, 'notes'), 'standalone'),
        root('prompts', join(managed, 'prompts'), 'standalone'),
      ],
      [join(managed, 'attachments')],
    );
    const sender = createSender();
    await start(sender, request);
    expect(openWatchPaths()).toEqual([home]);

    useFakeTimers();
    fire(home);
    await settleNativeBatch();
    await jest.advanceTimersByTimeAsync(120);
    expect(changedSends()).toEqual([
      { sender, payload: { ...request, changeCount: 1 } },
    ]);
  });

  it('coalesces native notifications into one change per 120 ms window', async () => {
    const { repo, attachments } = await singleRepoFixture('empty');
    const sender = createSender();
    await start(sender, request);
    useFakeTimers();

    fire(repo);
    fire(repo);
    fire(attachments);
    await settleNativeBatch();
    await jest.advanceTimersByTimeAsync(119);
    expect(changedSends()).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(changedSends()).toEqual([
      { sender, payload: { ...request, changeCount: 3 } },
    ]);

    fire(repo);
    await settleNativeBatch();
    await jest.advanceTimersByTimeAsync(120);
    expect(changedSends()).toEqual([
      { sender, payload: { ...request, changeCount: 3 } },
      { sender, payload: { ...request, changeCount: 1 } },
    ]);
  });

  it('closes every native watcher on stop and sends nothing afterwards', async () => {
    const { repo } = await singleRepoFixture('empty');
    const sender = createSender();
    await start(sender, request);
    expect(openWatchers()).toHaveLength(2);
    useFakeTimers();
    const repoWatcher = watchers.find((watcher) => watcher.path === repo);
    await stop(sender, request);
    expect(openWatchers()).toEqual([]);
    for (const watcher of watchers)
      expect(watcher.close).toHaveBeenCalledTimes(1);
    repoWatcher?.listener();
    await settleNativeBatch();
    await jest.advanceTimersByTimeAsync(500);
    expect(changedSends()).toEqual([]);
  });

  it('tears down a start when the stop arrives before it attaches', async () => {
    await singleRepoFixture('empty');
    let releaseRoots: () => void = () => undefined;
    const rootsGate = new Promise<void>((resolve) => {
      releaseRoots = resolve;
    });
    const implementation = mockedGetFileBrowserRoots.getMockImplementation();
    if (!implementation) throw new Error('Missing roots implementation.');
    mockedGetFileBrowserRoots.mockImplementation(async (...args) => {
      await rootsGate;
      return implementation(...args);
    });
    const sender = createSender();
    const started = start(sender, request);
    await stop(sender, request);
    releaseRoots();
    await expect(started).resolves.toBeUndefined();
    await settleNativeBatch();
    expect(openWatchers()).toEqual([]);
  });

  it('rejects the start when a native watcher cannot attach, releasing the rest', async () => {
    const { repo, attachments } = await singleRepoFixture('empty');
    watchFailure = (path): Error | null =>
      path === attachments ? new Error('native watch failed') : null;
    const sender = createSender();
    await expect(start(sender, request)).rejects.toThrow('native watch failed');
    await settleNativeBatch();
    expect(openWatchers()).toEqual([]);
    expect(watchers.every((watcher) => watcher.path === repo)).toBe(true);
    await expect(
      Promise.resolve(stop(sender, request)),
    ).resolves.toBeUndefined();
  });

  it('rejects the start when the roots cannot be read', async () => {
    mockedGetFileBrowserRoots.mockRejectedValue(new Error('roots failed'));
    mockedSupplementalPaths.mockReturnValue([]);
    await expect(start(createSender(), request)).rejects.toThrow(
      'roots failed',
    );
    expect(watchers).toEqual([]);
  });

  it('replaces an earlier start for the same sender and worktree', async () => {
    const { repo } = await singleRepoFixture('empty');
    const sender = createSender();
    await start(sender, request);
    const first = [...watchers];
    await start(sender, request);
    for (const watcher of first) expect(watcher.closed).toBe(true);
    expect(openWatchers()).toHaveLength(2);
    expect(sender.once).toHaveBeenCalledTimes(1);

    useFakeTimers();
    fire(repo);
    await settleNativeBatch();
    await jest.advanceTimersByTimeAsync(120);
    expect(changedSends()).toEqual([
      { sender, payload: { ...request, changeCount: 1 } },
    ]);
  });

  it('keeps one watch when overlapping starts race for the same worktree', async () => {
    await singleRepoFixture('empty');
    const implementation = mockedGetFileBrowserRoots.getMockImplementation();
    if (!implementation) throw new Error('Missing roots implementation.');
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockedGetFileBrowserRoots.mockImplementationOnce(async (...args) => {
      await firstGate;
      return implementation(...args);
    });
    const sender = createSender();
    const firstStart = start(sender, request);
    const secondStart = start(sender, request);
    await secondStart;
    releaseFirst();
    await firstStart;
    await settleNativeBatch();
    expect(openWatchers()).toHaveLength(2);
    await stop(sender, request);
    expect(openWatchers()).toEqual([]);
  });

  it('stops every watch of a destroyed sender', async () => {
    const { repo } = await singleRepoFixture('missing');
    const sender = createSender();
    await start(sender, request);
    await start(sender, { projectId: 'project-1', worktreeId: 'wt-2' });
    expect(sender.once).toHaveBeenCalledTimes(1);
    expect(openWatchers().length).toBeGreaterThan(0);
    sender.destroy();
    expect(openWatchers()).toEqual([]);
    expect(watchers.some((watcher) => watcher.path === repo)).toBe(true);
  });

  it('opens no native watcher for the shared-container viewer', async () => {
    const replica = join(tempRoot, 'replica');
    await mkdir(replica, { recursive: true });
    setRoots([root('replica', replica, 'standalone')]);
    const viewerRequest = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
    };
    const sender = createSender();
    await expect(start(sender, viewerRequest)).resolves.toBeUndefined();
    expect(watchers).toEqual([]);
    await stop(sender, viewerRequest);
  });

  it('swallows native watcher errors and keeps the other roots live', async () => {
    const { repo, attachments } = await singleRepoFixture('empty');
    const sender = createSender();
    await start(sender, request);
    useFakeTimers();
    const attachmentsWatcher = watchers.find(
      (watcher) => watcher.path === attachments,
    );
    expect(attachmentsWatcher?.errorListeners.length).toBeGreaterThan(0);
    expect(() => {
      for (const listener of attachmentsWatcher?.errorListeners ?? [])
        listener(new Error('EPERM'));
    }).not.toThrow();
    fire(repo);
    await settleNativeBatch();
    await jest.advanceTimersByTimeAsync(120);
    expect(changedSends()).toEqual([
      { sender, payload: { ...request, changeCount: 1 } },
    ]);
  });

  it('keeps senders independent of each other', async () => {
    const { repo } = await singleRepoFixture('empty');
    const first = createSender();
    const second = createSender();
    await start(first, request);
    await start(second, request);

    useFakeTimers();
    fire(repo);
    await settleNativeBatch();
    await jest.advanceTimersByTimeAsync(120);
    expect(changedSends()).toEqual(
      expect.arrayContaining([
        { sender: first, payload: { ...request, changeCount: 1 } },
        { sender: second, payload: { ...request, changeCount: 1 } },
      ]),
    );
    expect(changedSends()).toHaveLength(2);

    await stop(first, request);
    sends.length = 0;
    fire(repo);
    await settleNativeBatch();
    await jest.advanceTimersByTimeAsync(120);
    expect(changedSends()).toEqual([
      { sender: second, payload: { ...request, changeCount: 1 } },
    ]);
  });

  it('does not send changes to a destroyed sender', async () => {
    const { repo } = await singleRepoFixture('missing');
    const sender = createSender();
    await start(sender, request);
    useFakeTimers();
    fire(repo);
    sender.isDestroyed.mockReturnValue(true);
    await settleNativeBatch();
    await jest.advanceTimersByTimeAsync(120);
    expect(changedSends()).toEqual([]);
  });

  it('validates stop identifiers', () => {
    const sender = createSender();
    expect(() =>
      stop(sender, { projectId: 'Bad Id', worktreeId: 'wt-1' }),
    ).toThrow('Invalid projectId');
  });

  it('rejects a start with invalid identifiers without watching', async () => {
    setRoots([]);
    await expect(
      start(createSender(), { projectId: 'project-1', worktreeId: '../x' }),
    ).rejects.toThrow('Invalid worktreeId');
    expect(watchers).toEqual([]);
  });
});
