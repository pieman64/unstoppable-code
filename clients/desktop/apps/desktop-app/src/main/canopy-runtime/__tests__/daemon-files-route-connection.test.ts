import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
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
  type CanopyCallerDescriptor,
  type CanopyJsonRpcMessage,
  type CanopyRuntimeDescriptor,
} from '@canopy/protocol/canopy-core';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import { CanopyOperationError } from '@canopy/core-runtime';
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
  worktreeHome,
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
import {
  createDaemonFilesRoute,
  type DaemonFilesOperation,
} from '../daemon-files-route';
import {
  importAttachmentsForIpc,
  listAttachmentsForIpc,
} from '../workspace-item-attachments-dispatch';
import {
  checkWorktreeHealth,
  createLegacyDiffStatsReader,
  createWorktreeBranch,
  getGitExecutableStatus,
  listCommittedChangedFiles,
  listHomeBranchTargets,
  listUncommittedChangedFiles,
  listWorktreeBranches,
  readRepositoryRemoteUrl,
  switchWorktreeBranch,
  worktreeBranchRenameGit,
} from '../worker-git-dispatch';
import { SINGLE_REPO_USAGE_REPO_ID } from '@canopy/desktop-shared/types';
import {
  fetchWorktreeRepository,
  pullWorktreeRepository,
} from '../worker-git-sync-dispatch';
import { inspectReferenceRepo } from '../../lib/workspace-reference-repo-health';
import { getGitHubCliStatus } from '../github-integration-dispatch';
import {
  mintPullRequestId,
  mintRepositoryId,
} from '@canopy/core-runtime/node/github';
import {
  getChangedFilesList,
  getCommittedFilesList,
  getDiffStats,
} from '../../lib/git';
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

// GitHub connection reads stay off the machine's gh and secure store.
jest.mock('../../lib/github-auth', () => ({
  ...jest.requireActual<object>('../../lib/github-auth'),
  observeGitHubCli: (): Promise<{ kind: 'not-installed' }> =>
    Promise.resolve({ kind: 'not-installed' }),
  describeGitHubCredential: (): Promise<{
    tokenSource: 'none';
    storedCredential: 'absent';
  }> => Promise.resolve({ tokenSource: 'none', storedCredential: 'absent' }),
}));

// The repository listing answers without GitHub.
jest.mock('../../lib/github-repo-listing', () => ({
  ...jest.requireActual<object>('../../lib/github-repo-listing'),
  listUserRepoSnapshot: (): Promise<{
    id: string;
    repos: [];
    access: [];
  }> => Promise.resolve({ id: '0.1', repos: [], access: [] }),
}));

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

async function start(options: {
  flag: boolean;
  /** Injected selection, read on macOS's table; omitted, production's. */
  selectable?: ReadonlySet<DaemonFilesOperation>;
}): Promise<Fixture> {
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
    ...(options.selectable && {
      selectable: options.selectable,
      platform: 'darwin' as const,
    }),
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
    paths: { join, resolve, isAbsolute, sep, basename },
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

  it('makes zero daemon contact for workspace instructions with the Files route enabled', async () => {
    // CAN-4106 adds no daemon route or enablement for this family.
    const f = await start({ flag: true });
    resetWorkCounters();
    const local = sender();
    const caller = localCaller(local);
    await f.runtime.instruction(
      'core.workspace.instructions.update',
      { workspaceId: 'instructions-only', content: '# Local' },
      { caller: { ...caller, grants: ['core.workspace.write'] } },
    );
    await expect(
      f.runtime.query(
        'core.workspace.instructions.get',
        { workspaceId: 'instructions-only' },
        { caller: { ...caller, grants: ['core.workspace.read'] } },
      ),
    ).resolves.toEqual({ content: '# Local' });
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for workspace attachment items with the Files route enabled', async () => {
    // CAN-4105 adds no daemon route, grant or enablement for core.workspace.item.*.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller = localCaller(sender());
    const file = join(f.dataRoot, 'attachment-source.txt');
    await writeFile(file, 'body');
    await expect(
      importAttachmentsForIpc(f.runtime, caller, {
        scope: SINGLE,
        filePaths: [file],
        clipboardItems: [{ filename: 'paste.png', data: Buffer.from('png') }],
      }),
    ).resolves.toHaveLength(2);
    const listed = await listAttachmentsForIpc(
      f.runtime,
      caller,
      SINGLE.workspaceId,
      SINGLE.worktreeId,
    );
    const names = listed.map((attachment) => attachment.filename);
    expect(names).toContain('paste.png');
    expect(names).toContain('attachment-source.txt');
    await expect(
      f.runtime.query(
        'core.workspace.item.get',
        { itemId: 'attachment:single@task:paste.png' },
        { caller: { ...caller, grants: ['core.workspace.read'] } },
      ),
    ).resolves.toMatchObject({ title: 'paste.png', sizeBytes: 3 });
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for repository rules with the Files route enabled', async () => {
    // CAN-4905 adds no daemon route, grant or enablement for this family.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller = localCaller(sender());
    await expect(
      f.runtime.instruction(
        'core.workspace.repoRules.apply',
        { workspaceId: 'rules-only', enabled: false },
        { caller: { ...caller, grants: ['core.workspace.write'] } },
      ),
    ).resolves.toMatchObject({ enabled: false, revision: 1 });
    await expect(
      f.runtime.query(
        'core.workspace.repoRules.status',
        { workspaceId: 'rules-only' },
        { caller: { ...caller, grants: ['core.workspace.read'] } },
      ),
    ).resolves.toMatchObject({ enabled: false, revision: 1 });
    await expect(
      f.runtime.query(
        'core.workspace.repoRules.preview',
        {
          workspaceId: 'rules-only',
          scanId: '12345678-1234-4234-8234-123456789abc',
          ruleId: 'r',
        },
        { caller: { ...caller, grants: ['core.workspace.read'] } },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.workspace.repoRules.reviewExpired' },
    });
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for hook sources with the Files route enabled', async () => {
    // CAN-5074 adds no daemon route or enablement for core.initiatedWork.source.*.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller: CanopyCallerDescriptor = {
      ...localCaller(sender()),
      grants: ['core.initiatedWork.read'],
    };
    const target = { kind: 'project' as const, ...SINGLE };
    await expect(
      f.runtime.query(
        'core.initiatedWork.source.list',
        { sourceKind: 'hook', target },
        { caller },
      ),
    ).resolves.toEqual({ sources: [] });
    await expect(
      f.runtime.query(
        'core.initiatedWork.source.get',
        { sourceKind: 'hook', target, triggerName: 'pr:merged' },
        { caller },
      ),
    ).resolves.toEqual({
      sourceKind: 'hook',
      triggerName: 'pr:merged',
      effectiveActions: null,
      layers: [],
    });
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for execution status with the Files route enabled', async () => {
    // CAN-5080 adds no daemon route or enablement for core.execution.*.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller: CanopyCallerDescriptor = {
      ...localCaller(sender()),
      grants: ['core.execution.read'],
    };
    const { status } = await f.runtime.query(
      'core.execution.status.get',
      {},
      { caller },
    );
    expect(status.families.pipeline.blocked).toBe(false);
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for branch lists with the Files route enabled', async () => {
    // CAN-4107 adds no daemon route or enablement for worker.git.*.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller = localCaller(sender());
    await expect(
      listWorktreeBranches(f.runtime, caller, {
        projectId: 'single',
        worktreeId: 'task',
      }),
    ).resolves.toEqual({ branches: [], defaultBranch: null });
    await expect(
      listHomeBranchTargets(f.runtime, caller, { workspaceId: 'cowork' }),
    ).resolves.toEqual({ supported: false, branches: [], defaultBranch: null });
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for worktree health with the Files route enabled', async () => {
    // CAN-5136 adds no daemon route or enablement for worker.git.worktree.health.get.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller = localCaller(sender());
    await expect(
      checkWorktreeHealth(f.runtime, () => caller, {
        projectId: 'single',
        worktreeId: 'task',
      }),
    ).resolves.toHaveProperty('healthy');
    await expect(
      f.runtime.query(
        'worker.git.worktree.health.get',
        { scope: { workspaceId: 'single', worktreeId: 'task' } },
        { caller: { ...caller, grants: ['worker.git.read'] } },
      ),
    ).resolves.toHaveProperty('healthy');
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for changed files with the Files route enabled', async () => {
    // CAN-4103 serves worker.git.diff.get in process: the daemon registers
    // it, but no route, daemon-principal grant or enablement reaches it
    // before its E ticket.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller = localCaller(sender());
    const target = {
      projectId: 'single',
      worktreeId: 'task',
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoPath: join(f.dataRoot, 'workspaces', 'single', 'worktrees', 'task'),
    };
    // The projections answer as the direct listings do, in process.
    expect(
      await listUncommittedChangedFiles(f.runtime, caller, target),
    ).toEqual(await getChangedFilesList(target.repoPath));
    expect(
      await listCommittedChangedFiles(f.runtime, caller, target, 'main'),
    ).toEqual(await getCommittedFilesList(target.repoPath, 'main'));
    const direct = await f.runtime
      .query(
        'worker.git.diff.get',
        {
          scope: SINGLE,
          repoId: WORKSPACE_ROOT_REPO_ID,
          base: 'HEAD',
          head: 'WORKTREE',
        },
        { caller: { ...caller, grants: ['worker.git.read'] } },
      )
      .then(
        (result) => result.files.length >= 0,
        (error: unknown) => error instanceof CanopyOperationError,
      );
    expect(direct).toBe(true);
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for diff stats with the Files route enabled', async () => {
    // CAN-4103's diff-stats projection reads worker.git.diff.get in process.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller = localCaller(sender());
    const repository = {
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoPath: join(f.dataRoot, 'workspaces', 'single', 'worktrees', 'task'),
    };
    const read = createLegacyDiffStatsReader(f.runtime, () => caller, {
      projectId: 'single',
      worktreeId: 'task',
    });
    for (const base of [undefined, 'main'])
      expect(
        await read(repository, base).then(
          (stats) => ({ stats }),
          (error: unknown) => ({ error: String(error) }),
        ),
      ).toEqual(
        await getDiffStats(repository.repoPath, base).then(
          (stats) => ({ stats }),
          (error: unknown) => ({ error: String(error) }),
        ),
      );
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for Git executable detection with the Files route enabled', async () => {
    // CAN-5137 adds no daemon route or enablement for worker.git.executable.get.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller = localCaller(sender());
    const published = process.env.CANOPY_GIT_EXECUTABLE;
    try {
      await expect(
        getGitExecutableStatus(f.runtime, caller, { recheck: true }),
      ).resolves.toHaveProperty('checkedAt');
      await expect(
        f.runtime.query(
          'worker.git.executable.get',
          { scope: {}, recheck: false },
          { caller: { ...caller, grants: ['worker.git.read'] } },
        ),
      ).resolves.toHaveProperty('issue');
    } finally {
      if (published === undefined) delete process.env.CANOPY_GIT_EXECUTABLE;
      else process.env.CANOPY_GIT_EXECUTABLE = published;
    }
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for remote reads with the Files route enabled', async () => {
    // CAN-5135 adds no daemon route or enablement for worker.git.remote.get.
    const f = await start({ flag: true });
    resetWorkCounters();
    // `/source` is the multi-repo source record; it does not exist.
    await expect(
      readRepositoryRemoteUrl(f.runtime, localCaller(sender()), '/source'),
    ).resolves.toEqual({ remoteUrl: null });
    await expect(inspectReferenceRepo(f.runtime, 'multi')).resolves.toEqual(
      expect.objectContaining({ referenceRepoPath: '/source', healthy: false }),
    );
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for GitHub connection status with the Files route enabled', async () => {
    // CAN-4109 serves core.integration.* in process only: no daemon module,
    // client definition, route or enablement.
    const f = await start({ flag: true });
    const github = (name: string): boolean =>
      name.startsWith('core.integration.') ||
      name.startsWith('core.pullRequest.');
    expect(
      f.daemon.runtime.operations.map(({ name }) => name).filter(github),
    ).toEqual([]);
    expect(
      [
        ...Object.keys(ELECTRON_DAEMON_DEFINITIONS.queries),
        ...Object.keys(ELECTRON_DAEMON_DEFINITIONS.instructions),
        ...Object.keys(ELECTRON_DAEMON_DEFINITIONS.streams),
      ].filter(github),
    ).toEqual([]);
    resetWorkCounters();
    const caller = localCaller(sender());
    await expect(getGitHubCliStatus(f.runtime, caller)).resolves.toEqual(
      expect.objectContaining({ error: 'GitHub CLI (gh) is not installed.' }),
    );
    await expect(
      f.runtime.query(
        'core.integration.list',
        {},
        { caller: { ...caller, grants: ['core.integration.read'] } },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ integrationId: 'github' }),
          expect.objectContaining({ integrationId: 'github-cli' }),
        ],
      }),
    );
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for pull request and repository reads with the Files route enabled', async () => {
    // CAN-4109 serves core.pullRequest.get, list and
    // core.integration.resource.list in process only.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller = localCaller(sender());
    const reader: CanopyCallerDescriptor = {
      ...caller,
      grants: ['core.pullRequest.read'],
    };
    const gone = { workspaceId: 'no-such-workspace' };
    await expect(
      f.runtime.query(
        'core.pullRequest.get',
        {
          pullRequestId:
            mintPullRequestId({
              repository: gone,
              github: { owner: 'acme', repo: 'api' },
              number: 1,
            }) ?? '',
          refresh: false,
        },
        { caller: reader },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.pullRequest.repositoryUnavailable' },
    });
    await expect(
      f.runtime.query(
        'core.pullRequest.list',
        {
          integrationId: 'github',
          repositoryId: mintRepositoryId(gone),
          states: ['open'],
          cursor: null,
          limit: 50,
        },
        { caller: reader },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.pullRequest.repositoryUnavailable' },
    });
    await expect(
      f.runtime.query(
        'core.integration.resource.list',
        {
          integrationId: 'github',
          kinds: ['repository'],
          query: null,
          cursor: null,
          limit: 200,
        },
        {
          caller: {
            ...caller,
            grants: ['core.integration.read'],
          } satisfies CanopyCallerDescriptor,
        },
      ),
    ).resolves.toEqual({ resources: [], nextCursor: null });
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for pull request writes with the Files route enabled', async () => {
    // CAN-4109 serves core.pullRequest.create and update in process only.
    const f = await start({ flag: true });
    resetWorkCounters();
    const writer: CanopyCallerDescriptor = {
      ...localCaller(sender()),
      grants: ['core.pullRequest.write'],
    };
    const gone = { workspaceId: 'no-such-workspace' };
    const unavailable = {
      payload: { code: 'core.pullRequest.repositoryUnavailable' },
    };
    await expect(
      f.runtime.instruction(
        'core.pullRequest.create',
        {
          integrationId: 'github',
          repositoryId: mintRepositoryId(gone) ?? '',
          title: 'Title',
          body: '',
          baseBranch: 'main',
          headBranch: 'feature',
          expectedHeadSha: 'a'.repeat(40),
          draft: false,
        },
        { caller: writer, metadata: { idempotencyKey: 'key-1' } },
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(
      f.runtime.instruction(
        'core.pullRequest.update',
        {
          pullRequestId:
            mintPullRequestId({
              repository: gone,
              github: { owner: 'acme', repo: 'api' },
              number: 1,
            }) ?? '',
          expectedRevision: 0,
          patch: { title: null, body: null, baseBranch: 'main', draft: null },
        },
        { caller: writer, metadata: { idempotencyKey: 'key-2' } },
      ),
    ).rejects.toMatchObject(unavailable);
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for every worker.git query the daemon now registers', async () => {
    // CAN-5138 and CAN-4103 register worker.git.* in the daemon without a
    // route, a daemon-principal grant or enablement (CAN-4729): Electron
    // keeps them in process, with the Files route enabled, and its daemon
    // client cannot express them.
    const f = await start({ flag: true });
    const registered = [
      'worker.git.branch.list',
      'worker.git.diff.get',
      'worker.git.executable.get',
      'worker.git.remote.get',
      'worker.git.worktree.health.get',
    ];
    expect(
      f.daemon.runtime.operations
        .map(({ name }) => name)
        .filter((name) => name.startsWith('worker.git.'))
        .sort(),
    ).toEqual(
      [
        ...registered,
        'worker.git.branch.create',
        'worker.git.branch.delete',
        'worker.git.branch.rename',
        'worker.git.checkout',
        'worker.git.fetch',
        'worker.git.pull',
      ].sort(),
    );
    for (const name of registered)
      expect(Object.keys(ELECTRON_DAEMON_DEFINITIONS.queries)).not.toContain(
        name,
      );
    resetWorkCounters();
    const grants: ReturnType<typeof localCaller>['grants'] = [
      'worker.git.read',
    ];
    const caller = { ...localCaller(sender()), grants };
    const published = process.env.CANOPY_GIT_EXECUTABLE;
    try {
      const settled = await Promise.allSettled([
        f.runtime.query(
          'worker.git.branch.list',
          {
            scope: { workspaceId: 'single', worktreeId: 'task' },
            repository: { kind: 'checkout' },
          },
          { caller },
        ),
        f.runtime.query(
          'worker.git.remote.get',
          { scope: { workspaceId: 'multi' }, repository: { kind: 'source' } },
          { caller },
        ),
        f.runtime.query(
          'worker.git.worktree.health.get',
          { scope: { workspaceId: 'single', worktreeId: 'task' } },
          { caller },
        ),
        f.runtime.query(
          'worker.git.executable.get',
          { scope: {}, recheck: false },
          { caller },
        ),
        f.runtime.query(
          'worker.git.diff.get',
          {
            scope: { workspaceId: 'single', worktreeId: 'task' },
            repoId: WORKSPACE_ROOT_REPO_ID,
            base: 'HEAD',
            head: 'WORKTREE',
          },
          { caller },
        ),
      ]);
      // Each answered by the in-process hosts: their results and refusal.
      const notRepository: unknown = expect.objectContaining({
        code: 'worker.git.remote.notRepository',
      });
      const health: unknown = expect.objectContaining({
        healthy: expect.any(Boolean) as unknown,
      });
      const status: unknown = expect.objectContaining({
        checkedAt: expect.any(String) as unknown,
      });
      // The in-process diff host answers for its checkout, a result or a
      // typed error, whichever the fixture's Git gives.
      const changes: unknown = expect.objectContaining(
        settled[4]?.status === 'fulfilled'
          ? { files: expect.any(Array) as unknown }
          : { kind: expect.any(String) as unknown },
      );
      expect(
        settled.map((outcome): unknown =>
          outcome.status === 'fulfilled'
            ? (outcome.value as unknown)
            : Reflect.get(Object(outcome.reason), 'payload'),
        ),
      ).toEqual([
        { branches: [], defaultBranch: null, defaultBranchSource: null },
        notRepository,
        health,
        status,
        changes,
      ]);
    } finally {
      if (published === undefined) delete process.env.CANOPY_GIT_EXECUTABLE;
      else process.env.CANOPY_GIT_EXECUTABLE = published;
    }
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for explorer deletes with the Files route enabled', async () => {
    // CAN-4101 adds no daemon route, grant or enablement for
    // worker.filesystem.entry.*; deletes run on the desktop dispatcher.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller: CanopyCallerDescriptor = {
      ...localCaller(sender()),
      grants: ['worker.filesystem.write'],
    };
    const home = join(f.dataRoot, 'workspaces', 'single', 'worktrees', 'task');
    await expect(
      f.runtime.deleteFileTreeEntryForLegacyIpc(
        {
          projectId: 'single',
          worktreeId: 'task',
          operation: 'delete',
          target: { repoId: 'single', relativePath: 'b.txt' },
        },
        { caller },
      ),
    ).resolves.toEqual({
      operation: 'delete',
      target: { repoId: 'single', relativePath: 'b.txt' },
    });
    await expect(
      f.runtime.instruction(
        'worker.filesystem.entry.delete',
        {
          scope: SINGLE,
          fileRootId: 'single',
          relativePath: 'dist',
          expectedVersion: null,
          recursive: true,
          disposition: 'permanent',
          _meta: { idempotencyKey: 'zero-contact' },
        },
        { caller, metadata: { idempotencyKey: 'zero-contact' } },
      ),
    ).resolves.toMatchObject({ deleted: true });
    await expect(readFile(join(home, 'b.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(home, 'dist', 'out.js'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for branch checkout and creation the daemon registers', async () => {
    // CAN-4108 registers worker.git.checkout and worker.git.branch.create in
    // the daemon, ungranted and unrouted (W7): Electron runs them in process
    // until CAN-4731, with the Files route enabled. The fixture checkout has
    // untracked files, so the in-process host refuses both before any effect.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller = localCaller(sender());
    await expect(
      switchWorktreeBranch(f.runtime, () => caller, {
        projectId: 'single',
        worktreeId: 'task',
        branchName: 'main',
        isRemote: false,
      }),
    ).rejects.toThrow('Cannot switch branches with uncommitted changes');
    await expect(
      createWorktreeBranch(f.runtime, () => caller, {
        projectId: 'single',
        worktreeId: 'task',
        newBranchName: 'feature',
        baseBranch: 'main',
        baseBranchIsRemote: false,
      }),
    ).rejects.toThrow('Cannot create a branch with uncommitted changes');
    await expect(
      f.runtime.instruction(
        'worker.git.checkout',
        { scope: SINGLE, branch: 'main' },
        { caller: { ...caller, grants: ['worker.git.write'] } },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.checkout.uncommittedChanges' },
    });
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for the fetch and pull the daemon registers', async () => {
    // CAN-5517 registers worker.git.fetch and worker.git.pull in the daemon,
    // ungranted and unrouted (W7): Electron runs github:pull's fetch and pull
    // in process until CAN-4731, with the Files route enabled. The fixture
    // checkout has no origin, so each fails in process.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller = localCaller(sender());
    const request = { projectId: 'single', worktreeId: 'task' };
    const entry = {
      repoPath: join(f.dataRoot, 'workspaces', 'single', 'worktrees', 'task'),
      repoId: SINGLE_REPO_USAGE_REPO_ID,
    };
    await expect(
      fetchWorktreeRepository(f.runtime, caller, request, entry, {
        prune: true,
      }),
    ).rejects.toThrow(/origin/);
    await expect(
      pullWorktreeRepository(f.runtime, caller, request, entry, {
        branch: 'main',
        strategy: 'fast-forward',
      }),
    ).rejects.toThrow(/origin/);
    await expect(
      f.runtime.instruction(
        'worker.git.pull',
        { scope: SINGLE, branch: 'main', strategy: 'rebase' },
        { caller: { ...caller, grants: ['worker.git.write'] } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for the branch rename and delete the daemon registers', async () => {
    // CAN-5516 registers worker.git.branch.rename and worker.git.branch.delete
    // in the daemon, ungranted and unrouted (W7): Electron runs them in
    // process until CAN-4731, with the Files route enabled: refusals and an
    // admitted rename alike.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller = localCaller(sender());
    await expect(
      worktreeBranchRenameGit(f.runtime, () => caller).renameCheckoutBranch(
        SINGLE,
        'bad..name',
      ),
    ).rejects.toThrow('Invalid branch name: "bad..name"');
    const writer: CanopyCallerDescriptor = {
      ...caller,
      grants: ['worker.git.write'],
    };
    await expect(
      f.runtime.instruction(
        'worker.git.branch.rename',
        { scope: SINGLE, name: 'bad..name' },
        { caller: writer },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.branch.invalidName' },
    });
    // The fixture's single-repo record names no repository.
    await expect(
      f.runtime.instruction(
        'worker.git.branch.delete',
        {
          scope: { workspaceId: 'single' },
          branch: 'absent',
          deletion: { kind: 'force' },
        },
        { caller: writer },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.branch.scopeUnsupported' },
    });
    // An admitted rename runs its effect in process too. Main's Git inherits
    // process.env, so a hook-inherited GIT_DIR must not redirect it.
    const inherited = Object.entries(process.env).filter(([key]) =>
      key.startsWith('GIT_'),
    );
    for (const [key] of inherited) delete process.env[key];
    try {
      await worktreeBranchRenameGit(
        f.runtime,
        () => caller,
      ).renameCheckoutBranch(SINGLE, 'renamed-in-process');
    } finally {
      for (const [key, value] of inherited) process.env[key] = value;
    }
    await expect(
      readFile(
        join(worktreeHome(f.dataRoot, 'single'), '.git', 'HEAD'),
        'utf8',
      ),
    ).resolves.toBe('ref: refs/heads/renamed-in-process\n');
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for explorer copies, moves and renames with the Files route enabled', async () => {
    // Like delete, entry.copy and entry.move have no daemon route, grant or
    // enablement (CAN-4730 owns registration); they run on the desktop dispatcher.
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller: CanopyCallerDescriptor = {
      ...localCaller(sender()),
      grants: ['worker.filesystem.write'],
    };
    const home = join(f.dataRoot, 'workspaces', 'single', 'worktrees', 'task');
    const ref = (
      relativePath: string,
    ): { repoId: string; relativePath: string } => ({
      repoId: 'single',
      relativePath,
    });
    await expect(
      f.runtime.transferFileTreeEntryForLegacyIpc(
        {
          projectId: 'single',
          worktreeId: 'task',
          operation: 'copy',
          source: ref('b.txt'),
          target: ref('b.txt'),
          conflict: 'increment',
        },
        { caller },
      ),
    ).resolves.toEqual({
      operation: 'copy',
      source: ref('b.txt'),
      target: ref('b copy.txt'),
    });
    await expect(
      f.runtime.transferFileTreeEntryForLegacyIpc(
        {
          projectId: 'single',
          worktreeId: 'task',
          operation: 'move',
          source: ref('b copy.txt'),
          target: ref('src/renamed.txt'),
        },
        { caller },
      ),
    ).resolves.toEqual({
      operation: 'move',
      source: ref('b copy.txt'),
      target: ref('src/renamed.txt'),
    });
    const endpoints = {
      scope: SINGLE,
      sourceFileRootId: 'single',
      destinationFileRootId: 'single',
      expectedSourceVersion: null,
      conflictPolicy: 'error' as const,
    };
    await expect(
      f.runtime.instruction(
        'worker.filesystem.entry.copy',
        {
          ...endpoints,
          sourceRelativePath: 'b.txt',
          destinationRelativePath: 'copied.txt',
          _meta: { idempotencyKey: 'copy-key' },
        },
        { caller, metadata: { idempotencyKey: 'copy-key' } },
      ),
    ).resolves.toMatchObject({ destinationRelativePath: 'copied.txt' });
    await expect(
      f.runtime.instruction(
        'worker.filesystem.entry.move',
        {
          ...endpoints,
          fromRelativePath: 'copied.txt',
          toRelativePath: 'moved.txt',
          expectedDestinationAbsent: true,
          _meta: { idempotencyKey: 'move-key' },
        },
        { caller, metadata: { idempotencyKey: 'move-key' } },
      ),
    ).resolves.toMatchObject({ toRelativePath: 'moved.txt' });
    const original = await readFile(join(home, 'b.txt'));
    expect(await readFile(join(home, 'src', 'renamed.txt'))).toEqual(original);
    expect(await readFile(join(home, 'moved.txt'))).toEqual(original);
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
  });

  it('makes zero daemon contact for explorer creates and text saves with the Files route enabled', async () => {
    // file.write and directory.create have no daemon route, grant or
    // enablement yet (registration is CAN-4100's L1b, then CAN-4730).
    const f = await start({ flag: true });
    resetWorkCounters();
    const caller: CanopyCallerDescriptor = {
      ...localCaller(sender()),
      grants: ['worker.filesystem.write'],
    };
    const home = join(f.dataRoot, 'workspaces', 'single', 'worktrees', 'task');
    const ref = (
      relativePath: string,
    ): { repoId: string; relativePath: string } => ({
      repoId: 'single',
      relativePath,
    });
    await expect(
      f.runtime.createFileTreeEntryForLegacyIpc(
        {
          projectId: 'single',
          worktreeId: 'task',
          operation: 'create-directory',
          target: ref('made/deeper'),
        },
        { caller },
      ),
    ).resolves.toEqual({
      operation: 'create-directory',
      target: ref('made/deeper'),
    });
    await expect(
      f.runtime.createFileTreeEntryForLegacyIpc(
        {
          projectId: 'single',
          worktreeId: 'task',
          operation: 'create-file',
          target: ref('fresh/new.txt'),
        },
        { caller },
      ),
    ).resolves.toEqual({
      operation: 'create-file',
      target: ref('fresh/new.txt'),
    });
    const saved = join(home, 'fresh', 'new.txt');
    const before = await stat(saved);
    await expect(
      f.runtime.saveTextFileForLegacyIpc(
        {
          projectId: 'single',
          worktreeId: 'task',
          realPath: await realpath(saved),
          content: 'saved\n',
          expectedVersion: `${before.size}:${Math.round(before.mtimeMs)}`,
        },
        { caller },
      ),
    ).resolves.toBe('written');
    expect(await readFile(saved, 'utf8')).toBe('saved\n');
    expect((await stat(join(home, 'made', 'deeper'))).isDirectory()).toBe(true);
    expect(f.connectionGets).toBe(0);
    expect(f.served).toEqual([]);
    expect(snapshotWorkCounters().route).toEqual({});
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

  describe('file, search and link under an injected selection (CAN-5509)', () => {
    const EVERY = new Set<DaemonFilesOperation>([
      'roots',
      'directory',
      'file',
      'search',
      'link',
    ]);

    it('serves a file read over the connection, and its notFound keeps its code across the codec', async () => {
      const f = await start({ flag: true, selectable: EVERY });
      resetWorkCounters();
      const local = sender();
      const caller = localCaller(local);
      const home = join(
        f.dataRoot,
        'workspaces',
        'single',
        'worktrees',
        'task',
      );
      const request = { scope: SINGLE, absolutePath: join(home, 'README.md') };
      const expected = await f.runtime.queryFileContentForLegacyIpc(request, {
        caller,
      });
      const routed = await f.runtime.queryFileContentForLegacyIpc(
        request,
        { caller },
        { sender: local },
      );
      expect(routed.legacyResult).toEqual({
        ...expected.legacyResult,
        modifiedAtMs: Math.trunc(expected.legacyResult.modifiedAtMs),
      });
      expect(routed.canonicalResult?.catalogRevision).toBe(
        await mainSideRevision(f, SINGLE),
      );
      // `worker.filesystem.file.notFound` survives the wire: the legacy
      // projection still answers a missing file.
      await expect(
        f.runtime.queryFileContentForLegacyIpc(
          {
            scope: SINGLE,
            absolutePath: join(home, 'gone.md'),
            file: { fileRootId: 'single', relativePath: 'gone.md' },
          },
          { caller },
          { sender: local },
        ),
      ).resolves.toMatchObject({
        canonicalResult: null,
        legacyResult: { kind: 'missing' },
      });
      expect(
        f.served.filter((method) => method === 'worker.filesystem.file.read'),
      ).toHaveLength(2);
      expect(snapshotWorkCounters().route).toMatchObject({
        'files.file.daemon': 2,
        'files.file.daemon.served': 1,
        'files.file.daemon.failed.not_found': 1,
      });
    });

    it('resolves links over the connection, with a typed failure answering null', async () => {
      const f = await start({ flag: true, selectable: EVERY });
      const local = sender();
      const caller = localCaller(local);
      const request = {
        scope: SINGLE,
        mode: 'markdown' as const,
        href: './src/index.ts',
        baseFilePath: join(
          f.dataRoot,
          'workspaces',
          'single',
          'worktrees',
          'task',
          'NOTES.md',
        ),
      };
      const expected = await f.runtime.queryLinkResolveForLegacyIpc(request, {
        caller,
      });
      expect(expected.legacyResult).not.toBeNull();
      await expect(
        f.runtime.queryLinkResolveForLegacyIpc(
          request,
          { caller },
          { sender: local },
        ),
      ).resolves.toMatchObject({ legacyResult: expected.legacyResult });
      resetWorkCounters();
      // `outsideRoots` is `not_found`: only its `worker.filesystem.link.*`
      // code, kept across the codec, makes the legacy answer `null`.
      await expect(
        f.runtime.queryLinkResolveForLegacyIpc(
          { scope: SINGLE, mode: 'transcript', href: '../README.md' },
          { caller },
          { sender: local },
        ),
      ).resolves.toEqual({ canonicalResult: null, legacyResult: null });
      expect(snapshotWorkCounters().route).toMatchObject({
        'files.link.daemon': 1,
        'files.link.daemon.failed.not_found': 1,
      });
      expect(
        f.served.filter(
          (method) => method === 'worker.filesystem.link.resolve',
        ),
      ).toHaveLength(2);
    });

    it('builds the index from daemon walks with real Git ignores, matching the direct index', async () => {
      const f = await start({ flag: true, selectable: EVERY });
      const local = sender();
      const caller = localCaller(local);
      const expected = await f.runtime.queryFileIndexForLegacyIpc(
        { projectId: 'single', worktreeId: 'task' },
        { caller },
      );
      expect(
        expected.repos[0]?.files.find((file) => file.filename === 'debug.log'),
      ).toMatchObject({ isIgnored: true });
      await expect(
        f.runtime.queryFileIndexForLegacyIpc(
          { projectId: 'single', worktreeId: 'task' },
          { caller },
          { sender: local },
        ),
      ).resolves.toEqual(expected);
      expect(
        f.served.filter((method) => method === 'worker.filesystem.search'),
      ).toHaveLength(expected.repos.length);
    });
  });
});
