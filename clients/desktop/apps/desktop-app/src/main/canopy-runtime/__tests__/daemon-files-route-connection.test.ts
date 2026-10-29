import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { connectCanopyClient } from '@canopy/core-client/node';
import { deriveLocalAuthorityIdentity } from '@canopy/core-platform';
import type {
  CanopyFramedConnection,
  CanopyFramedPair,
} from '@canopy/core-transport';
import {
  createFilesystemScopeResolver,
  listFilesystemScopeRoots,
  readNativeRootIdentity,
} from '@canopy/core-runtime/node';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  type CanopyJsonRpcMessage,
  type CanopyRuntimeDescriptor,
} from '@canopy/protocol/canopy-core';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { createBundledWorkerPair } from '../../../../../core-daemon/src/bundled-graph';
import {
  startCanopyDaemon,
  type RunningCanopyDaemon,
} from '../../../../../core-daemon/src/daemon';
import {
  gitFreeEnvironment,
  initGitRepository,
  seedFilesystemRecords,
} from '../../../../../core-daemon/src/__tests__/filesystem-fixtures';
import {
  listFileTreeDirectory,
  listFileTreeRoots,
} from '../../services/files-service';
import { resolveWorktreeTargetIds } from '../../lib/resolve-worktree';
import {
  getWorkspaceType,
  registerWorkspaceTypes,
} from '../../lib/workspace-registry';
import { createDaemonFilesRoute } from '../daemon-files-route';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import { createElectronDaemonCallerLifetime } from '../electron-daemon-caller-lifetime';
import {
  createElectronDaemonConnectionService,
  type ElectronDaemonConnectionService,
} from '../electron-daemon-connection';
import {
  ELECTRON_DAEMON_DEFINITIONS,
  type ElectronDaemonClient,
} from '../electron-daemon-host';
import {
  COWORK_DIR,
  controllableFlag,
  FakeSender,
  FIXTURE_TYPES,
  localCaller,
  rejection,
} from './daemon-files-route-harness';

/**
 * Enabled reads cross the production connection: a real daemon on its
 * published socket with its composed Git read host, the Electron connection
 * service with its lease, and the desktop runtime's file-tree projection. The
 * single worktree is a real Git repository. Unix sockets need a short TMPDIR.
 */
const posix = process.platform === 'win32' ? describe.skip : describe;

const BRAND_ID = 'canopy';
const SINGLE = { workspaceId: 'single', worktreeId: 'task' };
const MULTI = { workspaceId: 'multi', worktreeId: 'task' };
const COWORK_HOME = { workspaceId: 'cowork', worktreeId: 'home' };

interface Fixture {
  dataRoot: string;
  daemon: RunningCanopyDaemon;
  /** Worker methods the daemon's bundled worker served, in order. */
  served: string[];
  connections: ElectronDaemonConnectionService<ElectronDaemonClient>;
  connectionGets: number;
  flag: ReturnType<typeof controllableFlag>;
  lifetime: ReturnType<typeof createElectronDaemonCallerLifetime>;
  runtime: DesktopCanopyDispatcher;
  direct: {
    roots: jest.Mock<
      ReturnType<typeof listFileTreeRoots>,
      Parameters<typeof listFileTreeRoots>
    >;
    directory: jest.Mock<
      ReturnType<typeof listFileTreeDirectory>,
      Parameters<typeof listFileTreeDirectory>
    >;
  };
  authorityId: string;
}

let fixture: Fixture | undefined;
let previousDataDir: string | undefined;
let senderIds = 500;
const sender = (): FakeSender => new FakeSender((senderIds += 1));

async function start(options: { flag: boolean }): Promise<Fixture> {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'c4305-')));
  await seedFilesystemRecords(dataRoot);
  await initGitRepository(dataRoot);
  previousDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataRoot;
  registerWorkspaceTypes(new Map(FIXTURE_TYPES));
  const served: string[] = [];
  const observedPair = async (): Promise<CanopyFramedPair> => {
    const pair = await createBundledWorkerPair();
    const { server } = pair;
    const observed: CanopyFramedConnection = {
      connectionId: server.connectionId,
      signal: server.signal,
      send: (message) => server.send(message),
      receive: async (receiveOptions) => {
        const message: CanopyJsonRpcMessage =
          await server.receive(receiveOptions);
        if ('method' in message) served.push(message.method);
        return message;
      },
      openChannel: (request) => server.openChannel(request),
      onChannel: (listener) => server.onChannel(listener),
      close: (error) => server.close(error),
    };
    return { ...pair, server: observed };
  };
  const daemon = await startCanopyDaemon({
    dataRoot,
    runtimeMode: 'dev',
    buildVersion: 'test',
    brandId: BRAND_ID,
    coworkManagedDirName: COWORK_DIR,
    // Production composition: the daemon builds its own Git read host.
    environment: gitFreeEnvironment(),
    createWorkerPair: observedPair,
  });
  const { authorityId } = await deriveLocalAuthorityIdentity({
    brandId: BRAND_ID,
    dataRoot,
  });
  const descriptor: CanopyRuntimeDescriptor = daemon.descriptor;
  const secret = await readFile(descriptor.tokenRef, 'utf8');
  const connections =
    createElectronDaemonConnectionService<ElectronDaemonClient>({
      enabled: true,
      authorityId,
      attach: (signal) =>
        connectCanopyClient({
          endpoint: {
            kind: 'socket',
            path: descriptor.endpoint.path,
            auth: {
              secret,
              dataRootHash: createHash('sha256').update(dataRoot).digest('hex'),
            },
          },
          signal,
          clientName: 'desktop',
          clientVersion: 'test',
          definitions: ELECTRON_DAEMON_DEFINITIONS,
        }),
    });
  const flag = controllableFlag(options.flag);
  const lifetime = createElectronDaemonCallerLifetime();
  const direct = {
    roots: jest.fn(listFileTreeRoots),
    directory: jest.fn(listFileTreeDirectory),
  };
  const created: Fixture = {
    dataRoot,
    daemon,
    served,
    connections,
    connectionGets: 0,
    flag,
    lifetime,
    direct,
    authorityId,
    runtime: createDesktopRuntime({
      services: {
        listFileTreeRoots: direct.roots,
        listFileTreeDirectory: direct.directory,
      },
      shutdownTimeoutMs: 1_000,
      daemonFilesRoute: () => route,
    }),
  };
  const route = createDaemonFilesRoute({
    isFlagEnabled: flag.isEnabled,
    onFlagChanged: flag.onChanged,
    lifetime,
    connections: () => ({
      get: (
        caller,
        owner,
      ): ReturnType<
        ElectronDaemonConnectionService<ElectronDaemonClient>['get']
      > => {
        created.connectionGets += 1;
        return connections.get(caller, owner);
      },
    }),
    hostContext: () =>
      Promise.resolve({ authorityId, canonicalDataRoot: dataRoot }),
    coworkManagedDirName: COWORK_DIR,
    displayDataRoot: () => dataRoot,
    workspaceType: getWorkspaceType,
    resolveWorktreeTargetIds,
  });
  fixture = created;
  return created;
}

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  if (!current) return;
  current.lifetime.disposeAll();
  await current.connections.dispose();
  await current.runtime.shutdown();
  await current.daemon.stop('test');
  registerWorkspaceTypes(new Map());
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  await rm(current.dataRoot, { recursive: true, force: true });
});

/** The catalog revision main's own resolver hashes for the same scope. */
async function mainSideRevision(
  f: Fixture,
  scope: { workspaceId: string; worktreeId: string },
): Promise<string> {
  const mainResolver = await createFilesystemScopeResolver({
    canonicalDataRoot: f.dataRoot,
    authorityId: f.authorityId,
    targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
    coworkManagedDirName: COWORK_DIR,
    paths: { join, resolve, isAbsolute, sep },
    rootIdentity: readNativeRootIdentity,
  });
  const daemonScope = { ...scope, authorityId: f.authorityId };
  const mainSide = await listFilesystemScopeRoots(
    { scope: daemonScope },
    await mainResolver(daemonScope, 'roots'),
  );
  if (mainSide.catalogRevision === undefined)
    throw new Error('Expected a main-side catalog revision.');
  return mainSide.catalogRevision;
}

posix('daemon Files route over the production connection', () => {
  jest.setTimeout(60_000);

  it('serves eligible roots through the daemon with the same revision and paths as the direct reader', async () => {
    const f = await start({ flag: true });
    resetWorkCounters();
    const local = sender();
    for (const scope of [SINGLE, MULTI, COWORK_HOME]) {
      const expected = await listFileTreeRoots({
        projectId: scope.workspaceId,
        worktreeId: scope.worktreeId,
      });
      const routed = await f.runtime.queryFileTreeRootsForLegacyIpc(
        { scope },
        { caller: localCaller(local) },
        { sender: local },
      );
      expect(routed.legacyResult).toEqual(expected);
      // Cross-process parity: main's resolver hashes the same revision.
      expect(routed.canonicalResult.catalogRevision).toBe(
        await mainSideRevision(f, scope),
      );
    }
    expect(
      f.served.filter((method) => method === 'worker.filesystem.roots.list'),
    ).toHaveLength(3);
    expect(f.direct.roots).not.toHaveBeenCalled();
    // One document, one session reused across the three reads.
    expect(f.connectionGets).toBe(3);
    expect(snapshotWorkCounters().route).toEqual({
      'files.roots.daemon': 3,
      'files.roots.daemon.queries': 3,
      'files.roots.daemon.served': 3,
    });
  });

  it("serves directories through the production daemon's composed reader, matching the direct reader", async () => {
    const f = await start({ flag: true });
    resetWorkCounters();
    const local = sender();
    for (const [scope, rootId] of [
      [SINGLE, 'single'],
      [MULTI, WORKSPACE_ROOT_REPO_ID],
      [COWORK_HOME, 'workspace'],
    ] as const) {
      const expected = await listFileTreeDirectory({
        projectId: scope.workspaceId,
        worktreeId: scope.worktreeId,
        repoId: rootId,
        relativeDir: '',
      });
      expect(expected.entries).not.toEqual([]);
      const listed = await f.runtime.queryFileTreeDirectoryForLegacyIpc(
        { scope, fileRootId: rootId, relativePath: '' },
        { caller: localCaller(local) },
        { sender: local },
      );
      expect(listed.legacyResult).toEqual(expected);
      expect(listed.canonicalResult.catalogRevision).toBe(
        await mainSideRevision(f, scope),
      );
    }
    expect(
      f.served.filter(
        (method) => method === 'worker.filesystem.directory.list',
      ),
    ).toHaveLength(3);
    expect(f.direct.directory).not.toHaveBeenCalled();
    expect(snapshotWorkCounters().route).toEqual({
      'files.directory.daemon': 3,
      'files.directory.daemon.queries': 3,
      'files.directory.daemon.served': 3,
    });
  });

  it('reports real Git ignores and index exclusions in the direct order, with display paths', async () => {
    const f = await start({ flag: true });
    const local = sender();
    const expected = await listFileTreeDirectory({
      projectId: SINGLE.workspaceId,
      worktreeId: SINGLE.worktreeId,
      repoId: 'single',
      relativeDir: '',
    });
    const listed = await f.runtime.queryFileTreeDirectoryForLegacyIpc(
      { scope: SINGLE, fileRootId: 'single', relativePath: '' },
      { caller: localCaller(local) },
      { sender: local },
    );
    expect(listed.legacyResult).toEqual(expected);
    const home = join(f.dataRoot, 'workspaces', 'single', 'worktrees', 'task');
    const flags = (
      name: string,
      overrides: Partial<Record<'isIgnored' | 'isIndexExcluded', boolean>> = {},
    ): object => ({
      name,
      relativePath: name,
      absolutePath: join(home, name),
      isIgnored: false,
      isIndexExcluded: false,
      ...overrides,
    });
    // Ignored by `.gitignore`, excluded by the seeded `dist/**` glob and the
    // built-in `node_modules` policy, directories first, as the direct reader sorts.
    expect(
      listed.legacyResult.entries.map(
        ({ name, relativePath, absolutePath, isIgnored, isIndexExcluded }) => ({
          name,
          relativePath,
          absolutePath,
          isIgnored,
          isIndexExcluded,
        }),
      ),
    ).toEqual([
      flags('dist', { isIgnored: true, isIndexExcluded: true }),
      flags('inside'),
      flags('node_modules', { isIndexExcluded: true }),
      flags('src'),
      flags('.gitignore'),
      flags('A.txt'),
      flags('b.txt'),
      flags('debug.log', { isIgnored: true }),
      flags('README.md'),
    ]);
    expect(listed.canonicalResult.catalogRevision).toBe(
      await mainSideRevision(f, SINGLE),
    );
    expect(f.served).toContain('worker.filesystem.directory.list');
    expect(f.direct.directory).not.toHaveBeenCalled();
  });

  it('passes a daemon directory notFound through typed, with no direct listing', async () => {
    const f = await start({ flag: true });
    const local = sender();
    const failure = await rejection(
      f.runtime.queryFileTreeDirectoryForLegacyIpc(
        { scope: SINGLE, fileRootId: 'unregistered', relativePath: '' },
        { caller: localCaller(local) },
        { sender: local },
      ),
    );
    expect(failure).toMatchObject({
      kind: 'not_found',
      code: 'worker.filesystem.directory.notFound',
    });
    expect(
      f.served.filter(
        (method) => method === 'worker.filesystem.directory.list',
      ),
    ).toHaveLength(1);
    expect(f.direct.directory).not.toHaveBeenCalled();
  });

  it('makes zero daemon contact with the flag off while a daemon runs', async () => {
    const f = await start({ flag: false });
    resetWorkCounters();
    const local = sender();
    await f.runtime.queryFileTreeRootsForLegacyIpc(
      { scope: SINGLE },
      { caller: localCaller(local) },
      { sender: local },
    );
    await f.runtime.queryFileTreeDirectoryForLegacyIpc(
      { scope: SINGLE, fileRootId: 'single', relativePath: '' },
      { caller: localCaller(local) },
      { sender: local },
    );
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    // Negative control: a running daemon does not make a direct read look routed.
    expect(snapshotWorkCounters().route).toEqual({
      'files.roots.direct': 1,
      'files.directory.direct': 1,
    });
    expect(f.direct.roots).toHaveBeenCalledTimes(1);
    expect(f.direct.directory).toHaveBeenCalledTimes(1);
  });

  it('retires the session on a committed reload and attaches a fresh one for the next read', async () => {
    const f = await start({ flag: true });
    const local = sender();
    const read = (): ReturnType<
      DesktopCanopyDispatcher['queryFileTreeRootsForLegacyIpc']
    > =>
      f.runtime.queryFileTreeRootsForLegacyIpc(
        { scope: SINGLE },
        { caller: localCaller(local) },
        { sender: local },
      );
    const first = await read();
    const owner = f.lifetime.ownerFor(local);
    local.emit('did-navigate');
    expect(owner.aborted).toBe(true);
    const second = await read();
    expect(second.canonicalResult.catalogRevision).toBe(
      first.canonicalResult.catalogRevision,
    );
    expect(f.lifetime.ownerFor(local)).not.toBe(owner);
    expect(
      f.served.filter((method) => method === 'worker.filesystem.roots.list'),
    ).toHaveLength(2);
  });
});
