/**
 * CAN-5509: file, search and link reads selected for the daemon (injected
 * selection, macOS) give the direct reader's legacy responses from daemon
 * answers, fail typed without ever calling the direct reader, keep host-base
 * links and every walk's cursors on one backend, and never share a daemon
 * index with a direct caller.
 */
import { join } from 'node:path';
import { CanopyClientError } from '@canopy/core-client';
import type {
  CanopyCallerDescriptor,
  WorkerFilesystemFileReadResult,
  WorkerFilesystemLinkResolveResult,
  WorkerFilesystemSearchResult,
} from '@canopy/protocol/canopy-core';
import {
  resetWorkCounters,
  snapshotFilesWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import type { FileIndexRequest } from '@canopy/desktop-shared/types';
import { registerWorkspaceTypes } from '../../lib/workspace-registry';
import type {
  DaemonFilesOperation,
  DaemonFilesRoute,
} from '../daemon-files-route';
import { markUnreachable } from '../electron-daemon-connection';
import {
  bridgeCaller,
  createRouteHarness,
  deferred,
  FakeSender,
  FIXTURE_TYPES,
  holdReplies,
  localCaller,
  rejection,
  untilReached,
  type RouteHarness,
  type RouteHarnessOptions,
} from './daemon-files-route-harness';

const SINGLE = { workspaceId: 'single', worktreeId: 'task' };
const INDEX = { projectId: 'single', worktreeId: 'task' };
const EVERY = new Set<DaemonFilesOperation>([
  'roots',
  'directory',
  'file',
  'search',
  'link',
]);
type Read = 'file' | 'search' | 'link';

let h: RouteHarness | undefined;
let senderIds = 1_400;
const sender = (): FakeSender => new FakeSender((senderIds += 1));

afterEach(async () => {
  await h?.close();
  h = undefined;
});

function harness(): RouteHarness {
  if (!h) throw new Error('No route harness.');
  return h;
}

/** Each read's direct reader, as the route calls it. */
interface DirectSpies {
  file: jest.Mock;
  search: jest.Mock;
  link: jest.Mock;
}

/** macOS with every read selected, and a spy on each direct reader. */
async function selectedHarness(
  options: RouteHarnessOptions = {},
): Promise<DirectSpies> {
  const direct: DirectSpies = {
    file: jest.fn(),
    search: jest.fn(),
    link: jest.fn(),
  };
  const outer = options.wrapRoute;
  h = await createRouteHarness({
    platform: 'darwin',
    selectable: EVERY,
    ...options,
    wrapRoute: (route) => {
      const inner = outer?.(route) ?? route;
      const spied: DaemonFilesRoute = {
        ...inner,
        file: (params, context, request, run) =>
          inner.file(params, context, request, {
            ...run,
            direct: () => {
              direct.file();
              return run.direct();
            },
          }),
        search: (params, context, request, run) =>
          inner.search(params, context, request, {
            ...run,
            direct: () => {
              direct.search();
              return run.direct();
            },
          }),
        link: (params, context, request, run) =>
          inner.link(params, context, request, {
            ...run,
            direct: () => {
              direct.link();
              return run.direct();
            },
          }),
      };
      return spied;
    },
  });
  return direct;
}

function worktreePath(...segments: string[]): string {
  return join(
    harness().displayRoot,
    'workspaces',
    'single',
    'worktrees',
    'task',
    ...segments,
  );
}

function attachmentPath(name: string): string {
  return join(
    harness().displayRoot,
    'workspaces',
    'single',
    'attachments',
    'task',
    name,
  );
}

function expectNoDaemonContact(): void {
  expect(harness().connectionsFactory).not.toHaveBeenCalled();
  expect(harness().hostContext).not.toHaveBeenCalled();
  expect(harness().connections.gets).toHaveLength(0);
  expect(harness().daemon.queries).toHaveLength(0);
}

function searchCursorsSent(): number {
  return harness().daemon.queries.filter(
    (query) =>
      query.name === 'worker.filesystem.search' &&
      'cursor' in query.params &&
      query.params.cursor !== undefined,
  ).length;
}

/** One legacy IPC read of `operation`, routed for `who`. */
function read(
  operation: Read,
  who: FakeSender,
  caller: CanopyCallerDescriptor = localCaller(who),
): Promise<unknown> {
  const { runtime } = harness();
  if (operation === 'file')
    return runtime.queryFileContentForLegacyIpc(
      { scope: SINGLE, absolutePath: worktreePath('README.md') },
      { caller },
      { sender: who },
    );
  if (operation === 'search')
    return runtime.queryFileIndexForLegacyIpc(
      INDEX,
      { caller },
      { sender: who },
    );
  return runtime.queryLinkResolveForLegacyIpc(
    { scope: SINGLE, mode: 'transcript', href: 'README.md' },
    { caller },
    { sender: who },
  );
}

describe('daemon answers projected to the legacy responses', () => {
  it('reads files through the daemon as the direct reader does, at millisecond mtime', async () => {
    const direct = await selectedHarness();
    resetWorkCounters();
    const local = sender();
    const caller = localCaller(local);
    for (const absolutePath of [
      worktreePath('README.md'),
      attachmentPath('image.png'),
    ]) {
      const request = { scope: SINGLE, absolutePath };
      // No IPC sender: the unrouted direct read.
      const expected = await harness().runtime.queryFileContentForLegacyIpc(
        request,
        { caller },
      );
      const routed = await harness().runtime.queryFileContentForLegacyIpc(
        request,
        { caller },
        { sender: local },
      );
      expect(routed.legacyResult).toEqual({
        ...expected.legacyResult,
        // The contract's ISO `modifiedAt` keeps whole milliseconds.
        modifiedAtMs: Math.trunc(expected.legacyResult.modifiedAtMs),
      });
      expect(routed.canonicalResult).toEqual({
        ...expected.canonicalResult,
        catalogRevision: routed.canonicalResult?.catalogRevision,
      });
      expect(typeof routed.canonicalResult?.catalogRevision).toBe('string');
    }
    expect(harness().daemon.names()).toEqual([
      'worker.filesystem.file.read',
      'worker.filesystem.file.read',
    ]);
    expect(direct.file).not.toHaveBeenCalled();
    const counters = snapshotFilesWorkCounters().route;
    expect(counters['files.file.daemon']).toBe(2);
    expect(counters['files.file.daemon.served']).toBe(2);
    expect(counters['files.file.direct']).toBe(0);
  });

  it("keeps a daemon notFound's code, so a missing file still reads as missing", async () => {
    const direct = await selectedHarness();
    const local = sender();
    // An explicit identity skips the host's existence check.
    await expect(
      harness().runtime.queryFileContentForLegacyIpc(
        {
          scope: SINGLE,
          absolutePath: worktreePath('gone.md'),
          file: { fileRootId: 'single', relativePath: 'gone.md' },
        },
        { caller: localCaller(local) },
        { sender: local },
      ),
    ).resolves.toMatchObject({
      canonicalResult: null,
      legacyResult: { kind: 'missing', filename: 'gone.md' },
    });
    expect(harness().daemon.names()).toEqual(['worker.filesystem.file.read']);
    expect(direct.file).not.toHaveBeenCalled();
  });

  it('resolves links with a root base and with no base as the direct reader does', async () => {
    const direct = await selectedHarness();
    resetWorkCounters();
    const local = sender();
    const caller = localCaller(local);
    for (const request of [
      {
        scope: SINGLE,
        mode: 'markdown' as const,
        href: './src/index.ts#L1',
        baseFilePath: worktreePath('NOTES.md'),
      },
      { scope: SINGLE, mode: 'transcript' as const, href: 'README.md' },
      {
        scope: SINGLE,
        mode: 'markdown' as const,
        href: './src',
        baseFilePath: worktreePath('NOTES.md'),
      },
    ]) {
      const expected = await harness().runtime.queryLinkResolveForLegacyIpc(
        request,
        { caller },
      );
      expect(expected.legacyResult).not.toBeNull();
      const routed = await harness().runtime.queryLinkResolveForLegacyIpc(
        request,
        { caller },
        { sender: local },
      );
      expect(routed.legacyResult).toEqual(expected.legacyResult);
      expect(routed.canonicalResult).toEqual({
        ...expected.canonicalResult,
        catalogRevision: routed.canonicalResult?.catalogRevision,
      });
      expect(typeof routed.canonicalResult?.catalogRevision).toBe('string');
    }
    // A typed link failure keeps its code and still answers null.
    await expect(
      harness().runtime.queryLinkResolveForLegacyIpc(
        { scope: SINGLE, mode: 'transcript', href: '../README.md' },
        { caller },
        { sender: local },
      ),
    ).resolves.toEqual({ canonicalResult: null, legacyResult: null });
    expect(harness().daemon.names()).toHaveLength(4);
    expect(direct.link).not.toHaveBeenCalled();
    const counters = snapshotFilesWorkCounters().route;
    expect(counters['files.link.daemon']).toBe(4);
    expect(counters['files.link.daemon.served']).toBe(3);
    expect(counters['files.link.direct']).toBe(0);
  });

  it.each<FileIndexRequest['purpose']>(['mentions', 'file-explorer'])(
    'builds the same %s index from a daemon walk of many pages',
    async (purpose) => {
      const direct = await selectedHarness();
      const request: FileIndexRequest = { ...INDEX, purpose };
      const local = sender();
      const expected = await harness().runtime.queryFileIndexForLegacyIpc(
        request,
        { caller: localCaller(local) },
      );
      expect(expected.repos[0]?.files.length).toBeGreaterThanOrEqual(3);
      harness().daemon.searchPageLimit = 1;
      resetWorkCounters();
      await expect(
        harness().runtime.queryFileIndexForLegacyIpc(
          request,
          { caller: localCaller(local) },
          { sender: local },
        ),
      ).resolves.toEqual(expected);
      // The worktree root takes one page per file, its cursors all daemon's.
      const pages = harness().daemon.names().length;
      expect(searchCursorsSent()).toBeGreaterThanOrEqual(2);
      expect(direct.search).not.toHaveBeenCalled();
      const counters = snapshotFilesWorkCounters().route;
      expect(counters['files.search.daemon']).toBe(pages);
      expect(counters['files.search.daemon.served']).toBe(pages);
      expect(counters['files.search.direct']).toBe(0);
    },
  );
});

describe('typed failures with no direct fallback', () => {
  const READS: readonly Read[] = ['file', 'search', 'link'];

  it.each(READS)(
    'fails %s typed when the connection is refused',
    async (op) => {
      const direct = await selectedHarness();
      harness().connections.fail = (): Error =>
        new CanopyClientError({
          kind: 'unavailable',
          message: 'Desktop daemon is not running.',
          retry: { kind: 'never' },
        });
      resetWorkCounters();
      expect(await rejection(read(op, sender()))).toMatchObject({
        kind: 'unavailable',
      });
      expect(harness().daemon.queries).toHaveLength(0);
      expect(direct[op]).not.toHaveBeenCalled();
      expect(
        snapshotFilesWorkCounters().route[
          `files.${op}.daemon.failed.unavailable`
        ],
      ).toBe(1);
    },
  );

  it.each(READS)(
    "keeps a daemon %s error's own code and drops a foreign one",
    async (op) => {
      const direct = await selectedHarness();
      const fail = (code: `worker.filesystem.${string}`): void => {
        harness().daemon.fail = (): Error =>
          new CanopyClientError({
            kind: 'failed_precondition',
            code,
            message: 'The daemon refused the read.',
            retry: { kind: 'never' },
          });
      };
      fail(`worker.filesystem.${op}.invalidState`);
      if (op === 'link')
        // Every typed link failure is a legacy `null`.
        await expect(read(op, sender())).resolves.toEqual({
          canonicalResult: null,
          legacyResult: null,
        });
      else
        expect(await rejection(read(op, sender()))).toMatchObject({
          kind: 'failed_precondition',
          code: `worker.filesystem.${op}.invalidState`,
        });
      fail('worker.filesystem.directory.notFound');
      const foreign = await rejection(read(op, sender()));
      expect(foreign).toMatchObject({ kind: 'failed_precondition' });
      expect(foreign.code).toBeUndefined();
      expect(direct[op]).not.toHaveBeenCalled();
    },
  );

  it('refuses a malformed file result', async () => {
    const direct = await selectedHarness();
    harness().daemon.rewriteFile = (
      result,
    ): WorkerFilesystemFileReadResult => ({
      ...result,
      relativePath: 'b.txt',
    });
    expect(await rejection(read('file', sender()))).toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.file.invalidState',
    });
    expect(direct.file).not.toHaveBeenCalled();
  });

  it.each<
    [
      string,
      (
        result: WorkerFilesystemLinkResolveResult,
      ) => WorkerFilesystemLinkResolveResult,
    ]
  >([
    [
      'in an unknown root',
      (result): WorkerFilesystemLinkResolveResult => ({
        ...result,
        fileRootId: 'elsewhere',
      }),
    ],
    [
      'with another name',
      (result): WorkerFilesystemLinkResolveResult => ({
        ...result,
        name: 'OTHER.md',
      }),
    ],
  ])(
    'refuses a link result %s, which reads as unresolved',
    async (_label, rewrite) => {
      const direct = await selectedHarness();
      resetWorkCounters();
      harness().daemon.rewriteLink = rewrite;
      await expect(read('link', sender())).resolves.toEqual({
        canonicalResult: null,
        legacyResult: null,
      });
      expect(direct.link).not.toHaveBeenCalled();
      expect(
        snapshotFilesWorkCounters().route[
          'files.link.daemon.failed.failed_precondition'
        ],
      ).toBe(1);
    },
  );

  it.each<[string, (path: string, name: string) => object]>([
    ['an escaping path', (): object => ({ path: '../secret', name: 'secret' })],
    ['a .git path', (): object => ({ path: '.git/HEAD', name: 'HEAD' })],
    ['a mismatched name', (path): object => ({ path, name: 'other.md' })],
    ['another root', (): object => ({ fileRootId: 'attachments' })],
    ['a directory match', (): object => ({ kind: 'directory' })],
  ])('refuses a search page with %s', async (_label, change) => {
    const direct = await selectedHarness();
    harness().daemon.rewriteSearch = (
      result,
    ): WorkerFilesystemSearchResult => ({
      ...result,
      matches: result.matches.map((match, index) =>
        index === 0 && match.fileRootId === 'single'
          ? { ...match, ...change(match.path, match.name) }
          : match,
      ),
    });
    expect(await rejection(read('search', sender()))).toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.filesystem.search.invalidState',
    });
    expect(direct.search).not.toHaveBeenCalled();
  });

  it.each(READS)(
    'ends %s typed when its window reloads mid-read',
    async (op) => {
      const direct = await selectedHarness();
      const local = sender();
      const hold = holdReplies(harness().daemon);
      const pending = rejection(read(op, local));
      await hold.reached(1, pending);
      local.emit('did-navigate', {}, 'app://index.html', 200, 'OK');
      hold.release();
      expect(await pending).toEqual({
        kind: 'cancelled',
        message: 'The requesting window closed or reloaded.',
        retry: { kind: 'never' },
      });
      expect(direct[op]).not.toHaveBeenCalled();
    },
  );
});

describe('an unreachable daemon (CAN-5541)', () => {
  const launchFailed = (): Error => {
    const failure = markUnreachable(
      new CanopyClientError({
        kind: 'failed_precondition',
        message: 'Core launch failed.',
        retry: { kind: 'never' },
      }),
      'start_failed',
    );
    if (!(failure instanceof Error)) throw new Error('Expected an Error.');
    return failure;
  };

  it.each(['file', 'link'] as const)(
    'answers %s in-process, then skips the daemon while latched',
    async (op) => {
      const direct = await selectedHarness();
      harness().connections.fail = launchFailed;
      resetWorkCounters();
      const local = sender();
      const first = await read(op, local);
      expect(await read(op, local)).toEqual(first);
      expect(direct[op]).toHaveBeenCalledTimes(2);
      expect(harness().connections.gets).toHaveLength(1);
      const counters = snapshotFilesWorkCounters().route;
      expect(counters[`files.${op}.daemon`]).toBe(2);
      expect(counters[`files.${op}.daemon.fallback.start_failed`]).toBe(1);
      expect(counters[`files.${op}.daemon.bypassed`]).toBe(1);
      expect(counters[`files.${op}.direct`]).toBe(0);
    },
  );

  it('keeps a daemon search walk typed', async () => {
    const direct = await selectedHarness();
    harness().connections.fail = launchFailed;
    resetWorkCounters();
    await expect(rejection(read('search', sender()))).resolves.toMatchObject({
      kind: 'failed_precondition',
    });
    expect(direct.search).not.toHaveBeenCalled();
    expect(
      snapshotFilesWorkCounters().route[
        'files.search.daemon.fallback.start_failed'
      ],
    ).toBe(0);
  });
});

describe('links with a host markdown base', () => {
  it('stay direct before any contact, beside a routed root-base link', async () => {
    const direct = await selectedHarness();
    resetWorkCounters();
    const local = sender();
    const caller = localCaller(local);
    // A base no root spells; its relative link lands back in the worktree.
    const hostBase = {
      scope: SINGLE,
      mode: 'markdown' as const,
      href: '../display/workspaces/single/worktrees/task/README.md',
      baseFilePath: join(harness().base, 'notes', 'NOTE.md'),
    };
    const expected = await harness().runtime.queryLinkResolveForLegacyIpc(
      hostBase,
      { caller },
    );
    expect(expected.legacyResult).toMatchObject({ filename: 'README.md' });
    await expect(
      harness().runtime.queryLinkResolveForLegacyIpc(
        hostBase,
        { caller },
        { sender: local },
      ),
    ).resolves.toEqual(expected);
    expectNoDaemonContact();
    expect(direct.link).toHaveBeenCalledTimes(1);
    // The same document's root-base link is the daemon's.
    await harness().runtime.queryLinkResolveForLegacyIpc(
      { ...hostBase, href: './README.md', baseFilePath: worktreePath('N.md') },
      { caller },
      { sender: local },
    );
    expect(harness().daemon.names()).toEqual([
      'worker.filesystem.link.resolve',
    ]);
    expect(direct.link).toHaveBeenCalledTimes(1);
    const counters = snapshotFilesWorkCounters().route;
    expect(counters['files.link.direct']).toBe(1);
    expect(counters['files.link.daemon']).toBe(1);
  });
});

describe('search walks keep one backend from start to finish', () => {
  it('fails a daemon walk typed, before its next cursor leaves, when the flag flips between pages', async () => {
    let flipped = false;
    const direct = await selectedHarness({
      wrapRoute: (route) => ({
        ...route,
        search: (
          params,
          context,
          request,
          run,
        ): ReturnType<DaemonFilesRoute['search']> => {
          if (params.cursor !== undefined && !flipped) {
            flipped = true;
            harness().flag.set(false);
            harness().flag.set(true);
          }
          return route.search(params, context, request, run);
        },
      }),
    });
    harness().daemon.searchPageLimit = 1;
    expect(await rejection(read('search', sender()))).toEqual({
      kind: 'cancelled',
      message:
        'The Files read route changed while this read ran. Refresh and retry.',
      retry: { kind: 'after_refresh', resource: 'filesystem-roots' },
    });
    expect(flipped).toBe(true);
    expect(searchCursorsSent()).toBe(0);
    expect(direct.search).not.toHaveBeenCalled();
  });

  it('ends a daemon walk typed, before its next cursor leaves, when its window reloads between pages', async () => {
    const local = sender();
    let reloaded = false;
    const direct = await selectedHarness({
      wrapRoute: (route) => ({
        ...route,
        search: (
          params,
          context,
          request,
          run,
        ): ReturnType<DaemonFilesRoute['search']> => {
          if (params.cursor !== undefined && !reloaded) {
            reloaded = true;
            local.emit('did-navigate', {}, 'app://index.html', 200, 'OK');
          }
          return route.search(params, context, request, run);
        },
      }),
    });
    harness().daemon.searchPageLimit = 1;
    expect(await rejection(read('search', local))).toEqual({
      kind: 'cancelled',
      message: 'The requesting window closed or reloaded.',
      retry: { kind: 'never' },
    });
    expect(reloaded).toBe(true);
    expect(searchCursorsSent()).toBe(0);
    expect(direct.search).not.toHaveBeenCalled();
  });

  it('finishes a daemon walk on the daemon when its workspace stops being routable', async () => {
    let unregistered = false;
    const direct = await selectedHarness({
      wrapRoute: (route) => ({
        ...route,
        search: (
          params,
          context,
          request,
          run,
        ): ReturnType<DaemonFilesRoute['search']> => {
          if (params.cursor !== undefined && !unregistered) {
            unregistered = true;
            registerWorkspaceTypes(new Map());
          }
          return route.search(params, context, request, run);
        },
      }),
    });
    const local = sender();
    const expected = await harness().runtime.queryFileIndexForLegacyIpc(INDEX, {
      caller: localCaller(local),
    });
    harness().daemon.searchPageLimit = 1;
    await expect(read('search', local)).resolves.toEqual(expected);
    expect(unregistered).toBe(true);
    expect(searchCursorsSent()).toBeGreaterThanOrEqual(2);
    expect(direct.search).not.toHaveBeenCalled();
    registerWorkspaceTypes(new Map(FIXTURE_TYPES));
  });

  /** One page of `walk` straight at the route, with a scripted direct page. */
  function page(
    walk: ReturnType<DaemonFilesRoute['searchWalk']>,
    who: FakeSender,
    cursor: string | undefined,
    direct: jest.Mock,
  ): Promise<unknown> {
    const caller = localCaller(who);
    return harness().route.search(
      {
        scope: SINGLE,
        fileRootId: 'single',
        query: '',
        mode: 'name',
        ...(cursor !== undefined && { cursor }),
      },
      {
        requestId: `page-${cursor ?? 'first'}`,
        caller,
        metadata: {},
        signal: new AbortController().signal,
      },
      { sender: who },
      {
        walk,
        capture: () => undefined,
        direct: () => {
          direct();
          return Promise.resolve({
            matches: [],
            nextCursor: 'fs1.direct',
            truncated: true,
          });
        },
      },
    );
  }

  it('discards a direct walk, without contact, when the flag turns on between pages', async () => {
    await selectedHarness({ flag: false });
    resetWorkCounters();
    const local = sender();
    const walk = harness().route.searchWalk(SINGLE, localCaller(local), {
      sender: local,
    });
    expect(walk.backend).toBe('direct');
    const direct = jest.fn();
    await page(walk, local, undefined, direct);
    harness().flag.set(true);
    expect(
      await rejection(page(walk, local, 'fs1.direct', direct)),
    ).toMatchObject({ kind: 'cancelled', retry: { kind: 'after_refresh' } });
    expect(direct).toHaveBeenCalledTimes(1);
    expectNoDaemonContact();
    expect(
      snapshotFilesWorkCounters().route['files.search.direct.discarded'],
    ).toBe(1);
  });

  it('keeps a direct walk direct when its workspace becomes routable between pages', async () => {
    await selectedHarness();
    registerWorkspaceTypes(new Map());
    const local = sender();
    const walk = harness().route.searchWalk(SINGLE, localCaller(local), {
      sender: local,
    });
    expect(walk.backend).toBe('direct');
    const direct = jest.fn();
    await page(walk, local, undefined, direct);
    registerWorkspaceTypes(new Map(FIXTURE_TYPES));
    await expect(page(walk, local, 'fs1.direct', direct)).resolves.toEqual({
      matches: [],
      nextCursor: 'fs1.direct',
      truncated: true,
    });
    expect(direct).toHaveBeenCalledTimes(2);
    expectNoDaemonContact();
  });

  it('serves a walk the route never pinned directly, whatever the flag says', async () => {
    await selectedHarness();
    const local = sender();
    const direct = jest.fn();
    await page(
      { backend: 'daemon', lane: 'daemon:0:1' },
      local,
      'fs1.foreign',
      direct,
    );
    expect(direct).toHaveBeenCalledTimes(1);
    expectNoDaemonContact();
  });
});

describe('index coalescing', () => {
  it('never lets a bridge index join a routed daemon walk', async () => {
    const direct = await selectedHarness();
    const local = sender();
    const bridge = sender();
    const expected = await harness().runtime.queryFileIndexForLegacyIpc(INDEX, {
      caller: localCaller(local),
    });
    const hold = holdReplies(harness().daemon);
    const routed = harness().runtime.queryFileIndexForLegacyIpc(
      INDEX,
      { caller: localCaller(local) },
      { sender: local },
    );
    try {
      await hold.reached(1, routed);
      // Served by its own direct walk while the daemon walk is held.
      await expect(
        harness().runtime.queryFileIndexForLegacyIpc(
          INDEX,
          { caller: bridgeCaller(bridge, 'controller-1') },
          { sender: bridge },
        ),
      ).resolves.toEqual(expected);
      expect(direct.search).toHaveBeenCalled();
    } finally {
      hold.release();
    }
    await expect(routed).resolves.toEqual(expected);
    expect(
      new Set(
        harness().connections.gets.map((get) => get.caller.clientInstanceId),
      ),
    ).toEqual(new Set([`electron-web-contents:${local.id}`]));
  });

  it("never lets one window's daemon index wait on another window's walk", async () => {
    await selectedHarness();
    const first = sender();
    const second = sender();
    const expected = await harness().runtime.queryFileIndexForLegacyIpc(INDEX, {
      caller: localCaller(first),
    });
    const index = (who: FakeSender): Promise<unknown> =>
      harness().runtime.queryFileIndexForLegacyIpc(
        INDEX,
        { caller: localCaller(who) },
        { sender: who },
      );
    const hold = holdReplies(harness().daemon);
    const running = index(first);
    let queued: Promise<unknown> | undefined;
    let again: Promise<unknown> | undefined;
    try {
      await hold.reached(1, running);
      // Queued behind the first window's walk: the second window's, then
      // the first window's next request.
      queued = rejection(index(second));
      again = index(first);
      second.emit('did-navigate', {}, 'app://index.html', 200, 'OK');
    } finally {
      hold.release();
    }
    await expect(running).resolves.toEqual(expected);
    await expect(again).resolves.toEqual(expected);
    expect(await queued).toMatchObject({ kind: 'cancelled' });
  });

  it('never lets a bridge index join a routed direct walk that a flip discards', async () => {
    const first = sender();
    const held = deferred();
    const reached = deferred();
    let holding = true;
    await selectedHarness({
      flag: false,
      wrapRoute: (route) => ({
        ...route,
        search: (
          params,
          context,
          request,
          run,
        ): ReturnType<DaemonFilesRoute['search']> =>
          route.search(params, context, request, {
            ...run,
            direct: async () => {
              if (holding && request.sender === first) {
                holding = false;
                reached.resolve();
                await held.promise;
              }
              return run.direct();
            },
          }),
      }),
    });
    const bridge = sender();
    const expected = await harness().runtime.queryFileIndexForLegacyIpc(INDEX, {
      caller: localCaller(first),
    });
    const index = (
      who: FakeSender,
      caller: CanopyCallerDescriptor = localCaller(who),
    ): Promise<unknown> =>
      harness().runtime.queryFileIndexForLegacyIpc(
        INDEX,
        { caller },
        { sender: who },
      );
    const running = rejection(index(first));
    await untilReached(reached.promise, running);
    // A second window's index queues behind it, then the bridge's.
    const queued = rejection(index(sender()));
    const bridged = index(bridge, bridgeCaller(bridge, 'controller-1'));
    harness().flag.set(true);
    held.resolve();
    await expect(bridged).resolves.toEqual(expected);
    expect(await running).toMatchObject({ kind: 'cancelled' });
    expect(await queued).toMatchObject({ kind: 'cancelled' });
    expectNoDaemonContact();
  });
});
