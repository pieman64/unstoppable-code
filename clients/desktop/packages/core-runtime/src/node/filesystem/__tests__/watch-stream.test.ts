import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  WORKER_STREAM_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { CanopyOperationError } from '../../../runtime/errors';
import type {
  CanopyDispatcher,
  CanopyHandlerContext,
  CanopyStreamFrame,
} from '../../../runtime/types';
import {
  createFilesystemWatchRegistry,
  type FilesystemNativeWatchListener,
  type FilesystemWatchAnchor,
} from '../watch-registry';
import {
  createWorkerFilesystemWatchHandler,
  filesystemWatchError,
  GIT_HEAD_UNAVAILABLE_RESCAN_MS,
  type FilesystemWatchResolutionPort,
  type FilesystemWatchTarget,
} from '../watch-stream';

interface FakeNative {
  path: string;
  options: unknown;
  emit: FilesystemNativeWatchListener;
  close: jest.Mock;
}

const caller: CanopyCallerDescriptor = {
  principalId: 'local',
  clientInstanceId: 'test',
  authorityId: 'local',
  interfaceKind: 'test',
  grants: ['worker.filesystem.read'],
};

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'watch-stream-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function setup(
  resolveTarget: (
    request: Parameters<FilesystemWatchResolutionPort['resolveWatchTarget']>[0],
  ) => Promise<FilesystemWatchTarget>,
  options: {
    watchFailure?: Error;
    lstat?: (path: string) => Promise<unknown>;
  } = {},
): {
  dispatcher: WatchDispatcher;
  natives: FakeNative[];
  port: jest.Mock;
  attached: CanopyHandlerContext[];
  failures: unknown[];
  flush: () => Promise<void>;
} {
  const natives: FakeNative[] = [];
  const bursts: Array<() => void> = [];
  const registry = createFilesystemWatchRegistry({
    watch: (path, watchOptions, listener) => {
      if (options.watchFailure) throw options.watchFailure;
      const native: FakeNative = {
        path,
        options: watchOptions,
        emit: listener,
        close: jest.fn(),
      };
      natives.push(native);
      return { close: native.close, on: (): undefined => undefined };
    },
    lstat: options.lstat ?? ((): Promise<void> => Promise.resolve()),
    scheduleBurst: (flush) => {
      bursts.push(flush);
    },
    createEpoch: () => 'epoch-a',
  });
  const port = jest.fn(resolveTarget);
  const attached: CanopyHandlerContext[] = [];
  const failures: unknown[] = [];
  const handler = createWorkerFilesystemWatchHandler({
    registry,
    port: { resolveWatchTarget: (request) => port(request) },
    now: () => new Date('2026-10-23T00:00:00.000Z'),
    onAttached: (context) => attached.push(context),
    onAttachFailed: (_context, error) => failures.push(error),
  });
  const dispatcher = createDispatcher(handler);
  return {
    dispatcher,
    natives,
    port,
    attached,
    failures,
    flush: async (): Promise<void> => {
      for (const burst of bursts.splice(0)) burst();
      for (let index = 0; index < 25; index += 1) await Promise.resolve();
    },
  };
}

const WATCH_STREAM_DEFINITIONS = {
  'worker.filesystem.watch':
    WORKER_STREAM_DEFINITIONS['worker.filesystem.watch'],
};

type WatchDispatcher = CanopyDispatcher<
  Record<never, never>,
  Record<never, never>,
  typeof WATCH_STREAM_DEFINITIONS
>;

function createDispatcher(
  handler: ReturnType<typeof createWorkerFilesystemWatchHandler>,
): WatchDispatcher {
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: {
      queries: {},
      instructions: {},
      streams: WATCH_STREAM_DEFINITIONS,
    },
    handlers: {
      queries: {},
      instructions: {},
      streams: { 'worker.filesystem.watch': handler },
    },
    shutdownTimeoutMs: 100,
  });
}

type Frame = CanopyStreamFrame<unknown, unknown>;

async function open(
  dispatcher: WatchDispatcher,
  params: {
    fileRootId?: string;
    subject?: 'tree' | 'gitHead';
    relativePaths?: string[];
    cursor?: CanopyStreamCursor | null;
  } = {},
  grants: CanopyCallerDescriptor['grants'] = caller.grants,
): Promise<{
  frames: Frame[];
  close: () => void;
  acceptedCursor: CanopyStreamCursor | null;
}> {
  const frames: Frame[] = [];
  const handle = await dispatcher.openStream(
    'worker.filesystem.watch',
    {
      scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
      fileRootId: params.fileRootId ?? 'repo',
      ...(params.subject && { subject: params.subject }),
      ...(params.relativePaths && { relativePaths: params.relativePaths }),
      ...(params.cursor !== undefined && { cursor: params.cursor }),
    },
    { caller: { ...caller, grants }, onFrame: (frame) => frames.push(frame) },
  );
  return {
    frames,
    close: () => handle.close(),
    acceptedCursor: handle.openResult.acceptedCursor,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Waits until `count` streams attached or failed. An absent root's ancestor
 * search awaits real `fs.access` on the threadpool, which a fixed number of
 * turns races on a loaded runner.
 */
async function settleOpened(
  outcomes: { attached: unknown[]; failures: unknown[] },
  count: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (
    outcomes.attached.length + outcomes.failures.length < count &&
    Date.now() < deadline
  )
    await new Promise<void>((resolve) => setImmediate(resolve));
  await settle();
}

function items(frames: Frame[]): unknown[] {
  return frames.flatMap((frame) => (frame.kind === 'item' ? [frame.item] : []));
}

function endOf(frames: Frame[]): Frame | undefined {
  return frames.find((frame) => frame.kind === 'end');
}

function treeTarget(
  rootPath: string,
  extra: Partial<Extract<FilesystemWatchTarget, { kind: 'tree' }>> = {},
): FilesystemWatchTarget {
  return {
    kind: 'tree',
    rootPath,
    rootMayBeAbsent: false,
    scopePaths: [{ path: rootPath, mayBeAbsent: false }],
    ...extra,
  };
}

describe('worker.filesystem.watch handler', () => {
  it('refuses a caller without worker.filesystem.read before resolving', async () => {
    const { dispatcher, port, natives } = setup(() =>
      Promise.resolve(treeTarget(tempRoot)),
    );
    await expect(open(dispatcher, {}, [])).rejects.toMatchObject({
      payload: { kind: 'permission_denied' },
    });
    expect(port).not.toHaveBeenCalled();
    expect(natives).toEqual([]);
  });

  it('streams root-relative items from one recursive handle and releases on close', async () => {
    const { dispatcher, natives, attached, flush } = setup(() =>
      Promise.resolve(treeTarget(tempRoot)),
    );
    const stream = await open(dispatcher);
    await settle();
    expect(attached).toHaveLength(1);
    expect(natives.map(({ path, options }) => ({ path, options }))).toEqual([
      { path: tempRoot, options: { recursive: true } },
    ]);
    natives[0]?.emit('change', `src${sep}a.ts`);
    await flush();
    expect(items(stream.frames)).toEqual([
      {
        changeId: 'epoch-a:1',
        kind: 'modified',
        relativePath: 'src/a.ts',
        previousRelativePath: null,
        version: null,
        occurredAt: '2026-10-23T00:00:00.000Z',
        eventCount: 1,
      },
    ]);
    expect(stream.frames[0]).toMatchObject({
      cursor: { daemonEpoch: 'epoch-a', sequence: 1 },
    });
    stream.close();
    await settle();
    expect(natives[0]?.close).toHaveBeenCalledTimes(1);
    expect(endOf(stream.frames)).toMatchObject({ outcome: 'cancelled' });
  });

  it('serves a nested root from the outer root handle, re-based and filtered', async () => {
    const nested = join(tempRoot, 'repos', 'a');
    await mkdir(nested, { recursive: true });
    const scopePaths = [
      { path: tempRoot, mayBeAbsent: false },
      { path: nested, mayBeAbsent: false },
    ];
    const { dispatcher, natives, flush } = setup((request) =>
      Promise.resolve(
        treeTarget(request.fileRootId === 'a' ? nested : tempRoot, {
          scopePaths,
        }),
      ),
    );
    const outer = await open(dispatcher, { fileRootId: 'workspace' });
    const inner = await open(dispatcher, { fileRootId: 'a' });
    await settle();
    expect(natives).toHaveLength(1);
    natives[0]?.emit('change', `repos${sep}a${sep}x.ts`);
    natives[0]?.emit('change', 'README.md');
    await flush();
    expect(items(outer.frames)).toEqual([
      expect.objectContaining({ relativePath: 'repos/a/x.ts' }),
      expect.objectContaining({ relativePath: 'README.md' }),
    ]);
    expect(items(inner.frames)).toEqual([
      expect.objectContaining({ relativePath: 'x.ts' }),
    ]);
    // The same change carries the same cursor on both streams.
    expect(inner.frames[0]?.cursor).toEqual(outer.frames[0]?.cursor);
    outer.close();
    expect(natives[0]?.close).not.toHaveBeenCalled();
    inner.close();
    await settle();
    expect(natives[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('bridges an absent root through its parent and reports its creation', async () => {
    const parent = join(tempRoot, 'attachments');
    await mkdir(parent);
    const root = join(parent, 'wt-1');
    const { dispatcher, natives, flush, attached, failures } = setup(() =>
      Promise.resolve(
        treeTarget(root, {
          rootMayBeAbsent: true,
          scopePaths: [{ path: root, mayBeAbsent: true }],
        }),
      ),
    );
    const stream = await open(dispatcher, { fileRootId: 'attachments' });
    await settleOpened({ attached, failures }, 1);
    expect(failures).toEqual([]);
    expect(natives.map((native) => native.path)).toEqual([parent]);
    natives[0]?.emit('rename', 'wt-1');
    natives[0]?.emit('rename', `wt-1${sep}note.md`);
    natives[0]?.emit('rename', `wt-2${sep}other.md`);
    await flush();
    expect(items(stream.frames)).toEqual([
      expect.objectContaining({ kind: 'created', relativePath: '' }),
      expect.objectContaining({ kind: 'created', relativePath: 'note.md' }),
    ]);
  });

  it('serves an absent nested root from its outer root even beyond its parent', async () => {
    // A cowork home's hidden attachments root before `.canopy` exists.
    const attachments = join(tempRoot, '.canopy', 'attachments');
    const scopePaths = [
      { path: tempRoot, mayBeAbsent: false },
      { path: attachments, mayBeAbsent: true },
    ];
    const { dispatcher, natives, flush, attached, failures } = setup(
      (request) =>
        Promise.resolve(
          request.fileRootId === 'attachments'
            ? treeTarget(attachments, { rootMayBeAbsent: true, scopePaths })
            : treeTarget(tempRoot, { scopePaths }),
        ),
    );
    const home = await open(dispatcher, { fileRootId: 'home' });
    const stream = await open(dispatcher, { fileRootId: 'attachments' });
    await settleOpened({ attached, failures }, 2);
    expect(failures).toEqual([]);
    expect(natives.map((native) => native.path)).toEqual([tempRoot]);
    natives[0]?.emit('rename', '.canopy');
    natives[0]?.emit('rename', join('.canopy', 'attachments'));
    natives[0]?.emit('rename', join('.canopy', 'attachments', 'a.png'));
    natives[0]?.emit('rename', 'notes.md');
    await flush();
    expect(items(stream.frames)).toEqual([
      expect.objectContaining({ kind: 'overflow', relativePath: '' }),
      expect.objectContaining({ kind: 'created', relativePath: '' }),
      expect.objectContaining({ kind: 'created', relativePath: 'a.png' }),
    ]);
    expect(items(home.frames)).toHaveLength(4);
  });

  it('stays open without a native handle when no ancestor exists in bounds', async () => {
    const root = join(tempRoot, 'missing', 'wt-1');
    const { dispatcher, natives, attached, failures } = setup(() =>
      Promise.resolve(
        treeTarget(root, {
          rootMayBeAbsent: true,
          scopePaths: [{ path: root, mayBeAbsent: true }],
        }),
      ),
    );
    const stream = await open(dispatcher);
    await settleOpened({ attached, failures }, 1);
    expect(failures).toEqual([]);
    expect(natives).toEqual([]);
    expect(attached).toHaveLength(1);
    expect(endOf(stream.frames)).toBeUndefined();
    stream.close();
  });

  it('keeps an inert stream open and refuses to resume it', async () => {
    const { dispatcher, natives, attached } = setup(() =>
      Promise.resolve({ kind: 'inert' }),
    );
    const stream = await open(dispatcher);
    await settle();
    expect(natives).toEqual([]);
    expect(attached).toHaveLength(1);
    expect(endOf(stream.frames)).toBeUndefined();
    stream.close();
    const resumed = await open(dispatcher, {
      cursor: { daemonEpoch: 'epoch-a', sequence: 0 },
    });
    await settle();
    expect(endOf(resumed.frames)).toMatchObject({
      outcome: 'error',
      error: { code: 'worker.filesystem.watch.snapshotRequired' },
    });
  });

  it('resumes at the exact live cursor and refuses any other', async () => {
    const { dispatcher, natives, flush } = setup(() =>
      Promise.resolve(treeTarget(tempRoot)),
    );
    const keeper = await open(dispatcher);
    await settle();
    natives[0]?.emit('change', 'a');
    await flush();
    const live = keeper.frames[0]?.cursor;
    expect(live).toEqual({ daemonEpoch: 'epoch-a', sequence: 1 });

    const resumed = await open(dispatcher, { cursor: live });
    expect(resumed.acceptedCursor).toEqual(live);
    await settle();
    natives[0]?.emit('change', 'b');
    await flush();
    expect(resumed.frames[0]).toMatchObject({
      kind: 'item',
      cursor: { daemonEpoch: 'epoch-a', sequence: 2 },
    });

    for (const cursor of [
      { daemonEpoch: 'epoch-a', sequence: 1 },
      { daemonEpoch: 'epoch-a', sequence: 9 },
      { daemonEpoch: 'foreign', sequence: 2 },
    ]) {
      const refused = await open(dispatcher, { cursor });
      await settle();
      expect(endOf(refused.frames)).toMatchObject({
        outcome: 'error',
        error: {
          kind: 'failed_precondition',
          code: 'worker.filesystem.watch.snapshotRequired',
          retry: { kind: 'after_refresh', resource: 'filesystem-watch' },
        },
      });
    }
    expect(natives).toHaveLength(1);
  });

  it('refuses a cursor once the handle that issued it is gone', async () => {
    const { dispatcher, natives } = setup(() =>
      Promise.resolve(treeTarget(tempRoot)),
    );
    const first = await open(dispatcher);
    await settle();
    first.close();
    await settle();
    const resumed = await open(dispatcher, {
      cursor: { daemonEpoch: 'epoch-a', sequence: 0 },
    });
    await settle();
    expect(endOf(resumed.frames)).toMatchObject({
      error: { code: 'worker.filesystem.watch.snapshotRequired' },
    });
    expect(natives).toHaveLength(1);
  });

  it('ends with not_found when the port cannot resolve the root', async () => {
    const { dispatcher, attached, failures } = setup(() =>
      Promise.reject(filesystemWatchError('notFound')),
    );
    const stream = await open(dispatcher, { fileRootId: 'gone' });
    await settle();
    expect(endOf(stream.frames)).toMatchObject({
      outcome: 'error',
      error: {
        kind: 'not_found',
        code: 'worker.filesystem.watch.notFound',
        retry: { kind: 'never' },
      },
    });
    expect(attached).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  it.each([
    {
      foreignCode: 'worker.filesystem.roots.notFound',
      kind: 'not_found',
      code: 'worker.filesystem.watch.notFound',
    },
    {
      foreignCode: 'worker.filesystem.roots.invalidState',
      kind: 'failed_precondition',
      code: 'worker.filesystem.watch.invalidState',
    },
    // Shaped like a watch code but outside the declared enum.
    {
      foreignCode: 'worker.filesystem.watch.gone',
      kind: 'not_found',
      code: 'worker.filesystem.watch.notFound',
    },
  ] as const)(
    'maps a port error coded $foreignCode to $code instead of internal',
    async ({ foreignCode, kind, code }) => {
      const cause = new Error('private roots cause');
      const rootsError = new CanopyOperationError(
        {
          kind,
          code: foreignCode,
          message: 'The selected filesystem scope no longer exists.',
          retry: { kind: 'never' },
        },
        cause,
      );
      const { dispatcher, failures } = setup(() => Promise.reject(rootsError));
      const stream = await open(dispatcher, { fileRootId: 'gone' });
      await settle();
      expect(endOf(stream.frames)).toMatchObject({
        outcome: 'error',
        error: {
          kind,
          code,
          message: 'The selected filesystem scope no longer exists.',
          retry: { kind: 'never' },
        },
      });
      // Host hooks keep the port's original failure.
      expect(failures).toEqual([rootsError]);
    },
  );

  it('drops a foreign code it cannot map and keeps the kind and retry', async () => {
    const { dispatcher } = setup(() =>
      Promise.reject(
        new CanopyOperationError({
          kind: 'conflict',
          code: 'worker.filesystem.roots.revisionConflict',
          message: 'Filesystem roots changed. Refresh the roots and retry.',
          retry: { kind: 'after_refresh', resource: 'filesystem-roots' },
        }),
      ),
    );
    const stream = await open(dispatcher);
    await settle();
    const end = endOf(stream.frames);
    expect(end).toMatchObject({
      outcome: 'error',
      error: {
        kind: 'conflict',
        retry: { kind: 'after_refresh', resource: 'filesystem-roots' },
      },
    });
    expect(end?.kind === 'end' ? end.error : undefined).not.toHaveProperty(
      'code',
    );
  });

  it('maps a missing native path to not_found and keeps the original cause', async () => {
    const cause = Object.assign(new Error('ENOENT: no such directory'), {
      code: 'ENOENT',
    });
    const { dispatcher, failures } = setup(
      () => Promise.resolve(treeTarget(tempRoot)),
      { watchFailure: cause },
    );
    const stream = await open(dispatcher);
    await settle();
    expect(endOf(stream.frames)).toMatchObject({
      error: { kind: 'not_found', code: 'worker.filesystem.watch.notFound' },
    });
    expect(failures).toEqual([
      expect.objectContaining({ runtimeCause: cause }),
    ]);
  });

  it('does not attach when the stream closes while resolving', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { dispatcher, natives, attached } = setup(async () => {
      await gate;
      return treeTarget(tempRoot);
    });
    const stream = await open(dispatcher);
    stream.close();
    release();
    await settle();
    expect(natives).toEqual([]);
    expect(attached).toEqual([]);
  });

  it('watches a gitHead subject without recursion and reports HEAD only', async () => {
    const gitDir = join(tempRoot, '.git');
    const { dispatcher, natives, port, flush } = setup(() =>
      Promise.resolve({ kind: 'gitHead', headPath: join(gitDir, 'HEAD') }),
    );
    const stream = await open(dispatcher, { subject: 'gitHead' });
    await settle();
    expect(port).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'gitHead', fileRootId: 'repo' }),
    );
    expect(natives.map(({ path, options }) => ({ path, options }))).toEqual([
      { path: gitDir, options: { recursive: false, persistent: false } },
    ]);
    natives[0]?.emit('rename', 'HEAD');
    natives[0]?.emit('change', 'index');
    await flush();
    natives[0]?.emit('change', null);
    await flush();
    expect(items(stream.frames)).toEqual([
      expect.objectContaining({ kind: 'modified', relativePath: 'HEAD' }),
      expect.objectContaining({ kind: 'overflow', relativePath: '' }),
    ]);
    stream.close();
    await settle();
    // HEAD handles stay dormant instead of paying for a native close.
    expect(natives[0]?.close).not.toHaveBeenCalled();
  });

  it('asks the registry to rescan only gitHead anchors while unavailable', async () => {
    const anchors: FilesystemWatchAnchor[] = [];
    const registry = createFilesystemWatchRegistry({
      watch: () => ({ close: jest.fn(), on: (): undefined => undefined }),
      lstat: () => Promise.resolve(),
    });
    const target: { current: FilesystemWatchTarget } = {
      current: { kind: 'gitHead', headPath: join(tempRoot, '.git', 'HEAD') },
    };
    const dispatcher = createDispatcher(
      createWorkerFilesystemWatchHandler({
        registry: {
          ...registry,
          acquire: (anchor, listener) => {
            anchors.push(anchor);
            return registry.acquire(anchor, listener);
          },
        },
        port: { resolveWatchTarget: () => Promise.resolve(target.current) },
      }),
    );
    const head = await open(dispatcher, { subject: 'gitHead' });
    target.current = {
      kind: 'tree',
      rootPath: tempRoot,
      rootMayBeAbsent: false,
      scopePaths: [{ path: tempRoot, mayBeAbsent: false }],
    };
    const tree = await open(dispatcher);
    await settle();
    expect(anchors.map((anchor) => anchor.rescanWhileUnavailableMs)).toEqual([
      GIT_HEAD_UNAVAILABLE_RESCAN_MS,
      undefined,
    ]);
    head.close();
    tree.close();
    await dispatcher.shutdown();
  });

  it('reports a deleted watched directory on tree and gitHead streams', async () => {
    const gitDir = join(tempRoot, '.git');
    const gone = new Set<string>();
    const target = { current: treeTarget(tempRoot) };
    const { dispatcher, natives, flush } = setup(
      () => Promise.resolve(target.current),
      {
        lstat: (path) =>
          gone.has(path)
            ? Promise.reject(
                Object.assign(new Error('gone'), { code: 'ENOENT' }),
              )
            : Promise.resolve(),
      },
    );
    const tree = await open(dispatcher);
    target.current = { kind: 'gitHead', headPath: join(gitDir, 'HEAD') };
    const head = await open(dispatcher, { subject: 'gitHead' });
    await settle();
    gone.add(tempRoot);
    gone.add(gitDir);
    for (const native of natives) native.emit('rename', 'basename');
    await flush();
    expect(items(tree.frames)).toEqual([
      expect.objectContaining({ kind: 'deleted', relativePath: '' }),
    ]);
    expect(items(head.frames)).toEqual([
      expect.objectContaining({ kind: 'overflow', relativePath: '' }),
    ]);
    tree.close();
    head.close();
  });

  it('narrows tree items to relativePaths and validates them', async () => {
    const { dispatcher, natives, flush } = setup(() =>
      Promise.resolve(treeTarget(tempRoot)),
    );
    const stream = await open(dispatcher, {
      relativePaths: ['docs/', './src'],
    });
    await settle();
    natives[0]?.emit('change', `docs${sep}a.md`);
    natives[0]?.emit('change', `docsx${sep}b.md`);
    natives[0]?.emit('change', `src${sep}c.ts`);
    await flush();
    expect(items(stream.frames)).toEqual([
      expect.objectContaining({ relativePath: 'docs/a.md' }),
      expect.objectContaining({ relativePath: 'src/c.ts' }),
    ]);
    for (const params of [
      { relativePaths: ['../outside'] },
      { relativePaths: ['/abs'] },
      { relativePaths: ['C:\\abs'] },
      { relativePaths: ['a'], subject: 'gitHead' as const },
    ]) {
      const refused = await open(dispatcher, params);
      await settle();
      expect(endOf(refused.frames)).toMatchObject({
        error: { kind: 'invalid_argument' },
      });
    }
  });

  it('refuses to open once the runtime shuts down', async () => {
    const { dispatcher, port } = setup(() =>
      Promise.resolve(treeTarget(tempRoot)),
    );
    await dispatcher.shutdown();
    await expect(open(dispatcher)).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
    expect(port).not.toHaveBeenCalled();
  });
});
