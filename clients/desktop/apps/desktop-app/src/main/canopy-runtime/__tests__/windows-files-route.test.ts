import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanopyClientError } from '@canopy/core-client';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
import { DAEMON_FILES_PRODUCTION_SELECTION } from '../daemon-files-route';
import { READ_ROUTE_TABLE } from '../daemon-read-route-guard';
import { markUnreachable } from '../electron-daemon-connection';
import {
  createRouteHarness,
  deferred,
  FakeSender,
  localCaller,
  type RouteHarness,
} from './daemon-files-route-harness';

const scope = { workspaceId: 'single', worktreeId: 'task' };
const file = {
  scope,
  fileRootId: 'single',
  relativePath: 'README.md',
  maxBytes: 1024,
};
const search = {
  scope,
  fileRootId: 'single',
  query: '',
  mode: 'name' as const,
  limit: 1,
};
const sender = new FakeSender(5914);
const caller = localCaller(sender);
function context(signal = new AbortController().signal): CanopyHandlerContext {
  return { requestId: '5914', caller, metadata: {}, signal };
}
function refusal(
  kind: CanopyClientError['payload']['kind'],
): CanopyClientError {
  return new CanopyClientError({
    kind,
    message: 'Qualification refusal',
    retry: { kind: 'never' },
  });
}
let h: RouteHarness;

// Leg A's injection seams: an already-qualified table row plus explicit
// test selection. Native filesystem entry rules still come from Windows.
async function qualified(): Promise<RouteHarness> {
  h = await createRouteHarness({
    platform: 'linux',
    entryNamePlatform: 'win32',
    selectable: new Set(['roots', 'directory', 'file', 'search', 'link']),
  });
  return h;
}

afterEach(async () => {
  await h?.close();
  jest.restoreAllMocks();
});

describe('Windows Files route qualification contract', () => {
  it('keeps shipped Windows file, search and link unselected and reserved Git cells blocked', async () => {
    h = await createRouteHarness({
      platform: 'win32',
      entryNamePlatform: 'win32',
    });
    expect([...DAEMON_FILES_PRODUCTION_SELECTION.win32]).toEqual([
      'roots',
      'directory',
    ]);
    for (const operation of [
      'git.remote.get',
      'git.executable.get',
      'git.worktree.health.get',
      'git.status.get',
      'git.diff.get',
    ] as const)
      expect(READ_ROUTE_TABLE[operation].win32.kind).toBe('blocked');
    const result = await h.daemon.serve(
      'worker.filesystem.file.read',
      file,
      undefined,
    );
    const direct = jest.fn(() => Promise.resolve(result));
    await expect(
      h.route.file(file, context(), { sender }, { direct, capture: jest.fn() }),
    ).resolves.toEqual(result);
    const walk = h.route.searchWalk(scope, caller, { sender });
    expect(walk.backend).toBe('direct');
    const directPage = { matches: [], nextCursor: null, truncated: false };
    const directSearch = jest.fn(() => Promise.resolve(directPage));
    await expect(
      h.route.search(
        search,
        context(),
        { sender },
        { walk, direct: directSearch, capture: jest.fn() },
      ),
    ).resolves.toEqual(directPage);
    expect(directSearch).toHaveBeenCalledTimes(1);
    const link = await h.daemon.serve(
      'worker.filesystem.link.resolve',
      { scope, mode: 'transcript', href: 'README.md' },
      undefined,
    );
    const directLink = jest.fn(() => Promise.resolve(link));
    await expect(
      h.route.link(
        { scope, mode: 'transcript', href: 'README.md' },
        context(),
        { sender },
        { direct: directLink, capture: jest.fn(), hostBase: false },
      ),
    ).resolves.toEqual(link);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(directLink).toHaveBeenCalledTimes(1);
    expect(h.connectionsFactory).not.toHaveBeenCalled();
  });

  it('preserves tagged unreachable read fallback without sending mutations to the daemon', async () => {
    await qualified();
    const result = await h.daemon.serve(
      'worker.filesystem.file.read',
      file,
      undefined,
    );
    const direct = jest.fn(() => Promise.resolve(result));
    h.connections.fail = (): CanopyClientError => {
      const error = refusal('unavailable');
      markUnreachable(error, 'start_failed');
      return error;
    };
    await expect(
      h.route.file(file, context(), { sender }, { direct, capture: jest.fn() }),
    ).resolves.toEqual(result);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(h.health.isLatched()).toBe(true);
    const calls = h.connections.gets.length;
    await h.route.file(
      file,
      context(),
      { sender },
      { direct, capture: jest.fn() },
    );
    expect(h.connections.gets).toHaveLength(calls);
    await h.runtime.createFileTreeEntryForLegacyIpc(
      {
        operation: 'create-file',
        projectId: 'single',
        worktreeId: 'task',
        target: { repoId: 'single', relativePath: 'mutation-stays-local.txt' },
      },
      {
        caller: {
          ...caller,
          grants: [...caller.grants, 'worker.filesystem.write'],
        },
      },
    );
    expect(
      await readFile(
        join(
          h.dataRoot,
          'workspaces/single/worktrees/task/mutation-stays-local.txt',
        ),
        'utf8',
      ),
    ).toBe('');
    expect(h.connections.gets).toHaveLength(calls);
  }, 30_000);

  it('falls back after the attempted read connection is lost but not on a reached-daemon refusal', async () => {
    await qualified();
    const result = await h.daemon.serve(
      'worker.filesystem.file.read',
      file,
      undefined,
    );
    const direct = jest.fn(() => Promise.resolve(result));
    h.daemon.afterReply = (): Promise<void> => {
      h.connections.drop();
      return Promise.resolve();
    };
    await expect(
      h.route.file(file, context(), { sender }, { direct, capture: jest.fn() }),
    ).resolves.toEqual(result);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(h.health.isLatched()).toBe(false);
    h.daemon.afterReply = null;
    direct.mockClear();
    for (const kind of [
      'permission_denied',
      'not_found',
      'capability_unavailable',
      'invalid_argument',
      'failed_precondition',
      'conflict',
      'resource_exhausted',
      'cancelled',
      'unavailable',
      'deadline_exceeded',
    ] as const) {
      h.daemon.fail = (): CanopyClientError => refusal(kind);
      await expect(
        h.route.file(
          file,
          context(),
          { sender },
          { direct, capture: jest.fn() },
        ),
      ).rejects.toMatchObject({ payload: { kind } });
    }
    expect(direct).not.toHaveBeenCalled();
  }, 30_000);

  it('cancels an in-flight read without falling back or latching unreachable', async () => {
    await qualified();
    const arrived = deferred();
    const release = deferred();
    h.daemon.beforeReply = async (): Promise<void> => {
      arrived.resolve();
      await release.promise;
    };
    const controller = new AbortController();
    const direct = jest.fn(() =>
      Promise.reject(new Error('must not fall back')),
    );
    const pending = h.route.file(
      file,
      context(controller.signal),
      { sender },
      { direct, capture: jest.fn() },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    try {
      await arrived.promise;
      controller.abort();
    } finally {
      release.resolve();
    }
    await rejected;
    expect(direct).not.toHaveBeenCalled();
    expect(h.health.isLatched()).toBe(false);
  }, 30_000);

  it('pins search cursors to their original backend across loss, reattachment and the unreachable latch', async () => {
    await qualified();
    const direct = jest.fn(() =>
      Promise.reject(new Error('search must not change backend')),
    );
    const walk = h.route.searchWalk(scope, caller, { sender });
    expect(walk.backend).toBe('daemon');
    const first = await h.route.search(
      search,
      context(),
      { sender },
      { walk, direct, capture: jest.fn() },
    );
    expect(first.nextCursor).not.toBeNull();
    h.connections.reattach();
    h.health.noteFallback('files_reads', 'start_failed');
    const next = { ...search, cursor: first.nextCursor ?? undefined };
    // Reattachment before a request keeps the old walk on the daemon, never
    // on the direct backend even while new walks bypass the unreachable host.
    const second = await h.route.search(
      next,
      context(),
      { sender },
      { walk, direct, capture: jest.fn() },
    );
    const lostCursor = second.nextCursor;
    expect(lostCursor).not.toBeNull();
    h.daemon.afterReply = (): Promise<void> => {
      h.connections.drop();
      return Promise.resolve();
    };
    await expect(
      h.route.search(
        { ...search, cursor: lostCursor ?? undefined },
        context(),
        { sender },
        { walk, direct, capture: jest.fn() },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    expect(direct).not.toHaveBeenCalled();
    h.daemon.afterReply = null;
    const bypassed = h.route.searchWalk(scope, caller, { sender });
    expect(bypassed.backend).toBe('direct');
    const directPage = { matches: [], nextCursor: null, truncated: false };
    const directRead = jest.fn(() => Promise.resolve(directPage));
    const contacts = h.connections.gets.length;
    // Even recovery cannot move a walk that was born direct onto the daemon.
    h.health.observe({ kind: 'reached' });
    await expect(
      h.route.search(
        search,
        context(),
        { sender },
        { walk: bypassed, direct: directRead, capture: jest.fn() },
      ),
    ).resolves.toEqual(directPage);
    expect(directRead).toHaveBeenCalledTimes(1);
    expect(h.connections.gets).toHaveLength(contacts);
  }, 30_000);
});
