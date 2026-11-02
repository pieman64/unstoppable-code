/**
 * CAN-4102: file-tree watch IPC as a projection over `worker.filesystem.watch`.
 * Legacy parity lives in file-tree-watch-golden.test.ts; these cases cover what
 * the dispatcher adds (grants, shutdown, daemon isolation, nested roots).
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type * as NodeFs from 'node:fs';
import type * as NodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  COWORK_WORKSPACE_FILE_ROOT_ID,
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type { FileBrowserRoot } from '../../lib/file-browser-roots';
import type { DaemonFilesRoute } from '../../canopy-runtime/daemon-files-route';

interface FakeWatcher {
  path: string;
  listener: (eventType: string, filename: string | null) => void;
  close: jest.Mock;
  closed: boolean;
}

interface FakeHandle {
  close: jest.Mock;
  on: () => FakeHandle;
}

const watchers: FakeWatcher[] = [];

jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    watch: jest.fn(
      (
        path: string,
        _options: unknown,
        listener: FakeWatcher['listener'],
      ): FakeHandle => {
        const watcher: FakeWatcher = {
          path,
          listener,
          closed: false,
          close: jest.fn(() => {
            watcher.closed = true;
          }),
        };
        watchers.push(watcher);
        const handle: FakeHandle = { close: watcher.close, on: () => handle };
        return handle;
      },
    ),
  };
});

/**
 * With `answer` set, `rename` classification never touches the disk: each
 * lstat is answered from `answer`, and held until released while `holding`.
 */
const mockLstat: {
  answer: ((path: string) => boolean) | null;
  holding: boolean;
  held: Array<() => void>;
} = { answer: null, holding: false, held: [] };

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof NodeFsPromises>('node:fs/promises');
  return {
    ...actual,
    lstat: jest.fn((path: NodeFs.PathLike): Promise<unknown> => {
      const answer = mockLstat.answer;
      if (!answer) return actual.lstat(path);
      return new Promise<void>((resolve, reject) => {
        const settle = (): void => {
          if (answer(path.toString())) resolve();
          else reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        };
        if (mockLstat.holding) mockLstat.held.push(settle);
        else settle();
      });
    }),
  };
});

type Handler = (event: unknown, request: unknown) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

const sends: Array<{ channel: string; payload: unknown }> = [];
jest.mock('../../lib/web-contents-send', () => ({
  sendToWebContents: (
    _sender: unknown,
    channel: string,
    payload: unknown,
  ): void => {
    sends.push({ channel, payload });
  },
}));

jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
  getFileBrowserSupplementalWatchPaths: jest.fn(),
}));

import { filesystemScopeError } from '@canopy/core-runtime/node';
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

let nextSenderId = 1;
function createSender(): {
  id: number;
  once: jest.Mock;
  isDestroyed: () => boolean;
} {
  return { id: nextSenderId++, once: jest.fn(), isDestroyed: () => false };
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

function setRoots(roots: FileBrowserRoot[], supplemental: string[]): void {
  mockedGetFileBrowserRoots.mockImplementation(() =>
    Promise.resolve({
      roots,
      rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
    }),
  );
  mockedSupplementalPaths.mockReturnValue(supplemental);
}

/** Real event-loop turns; `rename` classification waits on a real lstat. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Real event-loop turns until `done`, bounded so a regression fails fast. */
async function settleUntil(done: () => boolean): Promise<void> {
  const deadline = jest.getRealSystemTime() + 2_000;
  while (!done() && jest.getRealSystemTime() < deadline)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Under fake timers, waits until a delivered change arms the 120 ms debounce. */
async function settleUntilDebounceArmed(): Promise<void> {
  await settleUntil(() => jest.getTimerCount() > 0);
  expect(jest.getTimerCount()).toBe(1);
}

function openWatchers(): FakeWatcher[] {
  return watchers.filter((watcher) => !watcher.closed);
}

const request = { projectId: 'project-1', worktreeId: 'wt-1' };
let tempRoot = '';
let runtime: DesktopCanopyDispatcher | undefined;
let routeCalls: string[] = [];
let stopStartedWatches: () => void = () => undefined;

function register(
  grants: CanopyCallerDescriptor['grants'] = ['worker.filesystem.read'],
): {
  start: (sender: object, payload: unknown) => Promise<unknown>;
  stop: (sender: object, payload: unknown) => unknown;
} {
  handlers.clear();
  routeCalls = [];
  const route: DaemonFilesRoute = {
    roots: () => {
      routeCalls.push('roots');
      return Promise.reject(new Error('daemon contacted'));
    },
    directory: () => {
      routeCalls.push('directory');
      return Promise.reject(new Error('daemon contacted'));
    },
    file: (_params, _context, _request, run) => run.direct(),
    searchWalk: () => ({ backend: 'direct', lane: null }),
    search: (_params, _context, _request, run) => run.direct(),
    link: (_params, _context, _request, run) => run.direct(),
    dispose: () => undefined,
  };
  runtime = createDesktopRuntime({
    shutdownTimeoutMs: 5_000,
    daemonFilesRoute: () => route,
  });
  const caller: CanopyCallerDescriptor = {
    principalId: 'local',
    clientInstanceId: 'electron-web-contents:1',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants,
  };
  registerFileTreeHandlers(runtime, () => caller);
  const start = handlers.get(IPC_CHANNELS.fileTreeWatchStart);
  const stop = handlers.get(IPC_CHANNELS.fileTreeWatchStop);
  if (!start || !stop) throw new Error('Missing watch handlers.');
  const started: Array<{ sender: object; payload: unknown }> = [];
  // Runtime shutdown closes the streams but not a renderer's pending 120 ms
  // window, which would otherwise send into a later test.
  stopStartedWatches = (): void => {
    for (const { sender, payload } of started.splice(0))
      stop({ sender }, payload);
  };
  return {
    start: async (sender, payload): Promise<unknown> => {
      started.push({ sender, payload });
      return await start({ sender }, payload);
    },
    stop: (sender, payload) => stop({ sender }, payload),
  };
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'file-tree-watch-projection-'));
  watchers.length = 0;
  sends.length = 0;
  mockedGetFileBrowserRoots.mockReset();
  mockedSupplementalPaths.mockReset();
  mockLstat.answer = null;
  mockLstat.holding = false;
  mockLstat.held.length = 0;
});

afterEach(async () => {
  stopStartedWatches();
  stopStartedWatches = (): void => undefined;
  jest.useRealTimers();
  await runtime?.shutdown();
  runtime = undefined;
  await rm(tempRoot, { recursive: true, force: true });
});

describe('file-tree watch projection over worker.filesystem.watch', () => {
  it('never contacts the daemon route, even with the Files route enabled', async () => {
    const repo = join(tempRoot, 'repo');
    await mkdir(repo);
    setRoots([root('project-1', repo, 'git-repo')], []);
    const { start } = register();
    await expect(start(createSender(), request)).resolves.toBeUndefined();
    watchers[0]?.listener('change', 'a.txt');
    await settle();
    expect(routeCalls).toEqual([]);
    expect(openWatchers().map((watcher) => watcher.path)).toEqual([repo]);
  });

  it('refuses a caller without the filesystem read grant', async () => {
    const repo = join(tempRoot, 'repo');
    await mkdir(repo);
    setRoots([root('project-1', repo, 'git-repo')], []);
    const { start } = register([]);
    await expect(start(createSender(), request)).rejects.toThrow();
    expect(watchers).toEqual([]);
  });

  it('tolerates a scope that has no attachments root', async () => {
    const home = join(tempRoot, 'advisor-home');
    await mkdir(home);
    setRoots([root('project-1', home, 'standalone')], []);
    const { start } = register();
    await expect(start(createSender(), request)).resolves.toBeUndefined();
    expect(openWatchers().map((watcher) => watcher.path)).toEqual([home]);
  });

  it('rejects the start when the scope goes away before its streams resolve their root', async () => {
    const repo = join(tempRoot, 'repo');
    await mkdir(repo);
    setRoots([root('project-1', repo, 'git-repo')], []);
    const resolveRoots = mockedGetFileBrowserRoots.getMockImplementation();
    if (!resolveRoots) throw new Error('Missing roots implementation.');
    // The projection's own read passes; the streams' reads find no scope.
    let reads = 0;
    mockedGetFileBrowserRoots.mockImplementation(async (...args) => {
      reads += 1;
      if (reads > 1) throw filesystemScopeError('roots', 'notFound');
      return resolveRoots(...args);
    });
    const { start } = register();
    await expect(start(createSender(), request)).rejects.toThrow(
      'The selected filesystem scope no longer exists.',
    );
    expect(reads).toBeGreaterThan(1);
    await settle();
    expect(watchers).toEqual([]);
  });

  it('counts a change inside a nested hidden attachments root once', async () => {
    const home = join(tempRoot, 'cowork-home');
    const managed = join(home, '.canopy');
    await mkdir(join(managed, 'attachments'), { recursive: true });
    setRoots(
      [root(COWORK_WORKSPACE_FILE_ROOT_ID, home, 'standalone')],
      [join(managed, 'attachments')],
    );
    const { start } = register();
    await start(createSender(), request);
    expect(openWatchers()).toHaveLength(1);
    jest.useFakeTimers({
      doNotFake: [
        'setImmediate',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
      ],
    });
    expect(jest.getTimerCount()).toBe(0);
    watchers[0]?.listener('change', join('.canopy', 'attachments', 'a.png'));
    watchers[0]?.listener('change', 'notes.md');
    await settleUntilDebounceArmed();
    await jest.advanceTimersByTimeAsync(120);
    expect(sends).toEqual([
      {
        channel: IPC_CHANNELS.fileTreeChanged,
        payload: { ...request, changeCount: 2 },
      },
    ]);
  });

  it('closes open watch streams before shutdown drains the runtime', async () => {
    const repo = join(tempRoot, 'repo');
    await mkdir(repo);
    setRoots([root('project-1', repo, 'git-repo')], []);
    const { start } = register();
    await start(createSender(), request);
    const started = Date.now();
    await runtime?.shutdown();
    runtime = undefined;
    expect(Date.now() - started).toBeLessThan(2_000);
    await settle();
    expect(openWatchers()).toEqual([]);
  });

  it('refuses new watch starts once shutdown begins', async () => {
    const repo = join(tempRoot, 'repo');
    await mkdir(repo);
    setRoots([root('project-1', repo, 'git-repo')], []);
    const { start } = register();
    const shutdown = runtime?.shutdown();
    await expect(start(createSender(), request)).rejects.toThrow();
    await shutdown;
    runtime = undefined;
    expect(watchers).toEqual([]);
  });

  it.each(['stop', 'restart'] as const)(
    'closes streams still resolving their roots on a %s',
    async (interruption) => {
      const repo = join(tempRoot, 'repo');
      const attachments = join(tempRoot, 'attachments', 'wt-1');
      await mkdir(repo);
      await mkdir(attachments, { recursive: true });
      setRoots([root('project-1', repo, 'git-repo')], [attachments]);
      const resolveRoots = mockedGetFileBrowserRoots.getMockImplementation();
      if (!resolveRoots) throw new Error('Missing roots implementation.');
      // The projection's own read passes; the streams' reads wait.
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      let gatedReads = 0;
      mockedGetFileBrowserRoots.mockImplementation(async (...args) => {
        reads += 1;
        if (reads > 1) {
          gatedReads += 1;
          await gate;
        }
        return resolveRoots(...args);
      });
      const { start, stop } = register();
      const sender = createSender();
      const first = start(sender, request);
      for (let turn = 0; turn < 50 && gatedReads === 0; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(gatedReads).toBeGreaterThan(0);
      if (interruption === 'stop') {
        await stop(sender, request);
        release();
        await expect(first).resolves.toBeUndefined();
        await settle();
        expect(openWatchers()).toEqual([]);
        return;
      }
      const second = start(sender, request);
      release();
      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBeUndefined();
      await settle();
      expect(
        openWatchers()
          .map((watcher) => watcher.path)
          .sort(),
      ).toEqual([attachments, repo].sort());
      await stop(sender, request);
      await settle();
      expect(openWatchers()).toEqual([]);
    },
  );

  it('starts the shared-container viewer without reading its roots', async () => {
    mockedGetFileBrowserRoots.mockRejectedValue(new Error('replica pruned'));
    mockedSupplementalPaths.mockReturnValue([]);
    const { start, stop } = register();
    const viewerRequest = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
    };
    const sender = createSender();
    await expect(start(sender, viewerRequest)).resolves.toBeUndefined();
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
    expect(watchers).toEqual([]);
    await stop(sender, viewerRequest);
  });

  it('counts every native notification of a burst, renames included', async () => {
    const repo = join(tempRoot, 'repo');
    await mkdir(repo);
    setRoots([root('project-1', repo, 'git-repo')], []);
    const { start } = register();
    await start(createSender(), request);
    jest.useFakeTimers({
      doNotFake: [
        'setImmediate',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
      ],
    });
    expect(jest.getTimerCount()).toBe(0);
    // Only the root exists, so `new.txt` classifies as deleted.
    mockLstat.answer = (path): boolean => path === repo;
    mockLstat.holding = true;
    watchers[0]?.listener('rename', 'new.txt');
    watchers[0]?.listener('change', 'new.txt');
    watchers[0]?.listener('change', 'other.txt');
    await settleUntil(() => mockLstat.held.length > 0);
    expect(mockLstat.held.length).toBeGreaterThan(0);
    // A slow lstat holds the whole burst: `other.txt` needs no lstat, but it
    // must not arm a window of its own.
    await jest.advanceTimersByTimeAsync(120);
    expect(jest.getTimerCount()).toBe(0);
    expect(sends).toEqual([]);
    mockLstat.holding = false;
    for (const release of mockLstat.held.splice(0)) release();
    await settleUntilDebounceArmed();
    await jest.advanceTimersByTimeAsync(120);
    expect(sends).toEqual([
      {
        channel: IPC_CHANNELS.fileTreeChanged,
        payload: { ...request, changeCount: 3 },
      },
    ]);
  });
});
