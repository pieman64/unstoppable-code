import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
// Same real worker/filesystem harness as part 4, with production command callers.
import { W5CommitLog } from '@canopy/desktop-shared/node/w5-commit-log';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as RepoShadow from '../repo-shadow';
// The real baseline read starts an unawaited shadow refresh that reads
// CANOPY_DATA_DIR per write, so it can land in the next test's snapshot.
// Keep its no-shadow result: the source repo (fixture paths are canonical).
// A plain function, so mock resets cannot clear it.
jest.mock('../repo-shadow', () => ({
  ...jest.requireActual<typeof RepoShadow>('../repo-shadow'),
  getBaselineReadPath: (sourceRepoPath: string): Promise<string> =>
    Promise.resolve(sourceRepoPath),
}));
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';

import {
  createWorkspace,
  type WorkspaceCreationRequest,
} from '../workspace-creation';

import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  renameWorkspaceIndexEntry,
} from '../sidebar-items';
import { workspaceCreationDiagnosticsSchema } from '../w5-workspace-creation-diagnostics';
import * as git from '../git';
import { CloneJobRegistry } from '../../services/clone-jobs';
import { serializeWorkspaceMutation } from '../chat-project-operation-queue';

import { setBeforeProjectPluginDefaultsChangeHandler } from '../workspace-persistence';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture());
  execFileSync('git', ['clone', '-q', '--bare', repo, join(dir, 'remote.git')]);
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  mkdirSync(join(dir, 'notes'));
  writeFileSync(join(dir, 'notes', 'sentinel.txt'), 'user-owned');
  jest.clearAllMocks();
});
afterEach(async () => {
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function restartHost(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}
function snapshot(path = join(dir, 'data')): unknown {
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [
      entry.name,
      entry.isDirectory()
        ? snapshot(join(path, entry.name))
        : readFileSync(join(path, entry.name), 'utf8'),
    ]);
}
function remoteRequest(key?: string): WorkspaceCreationRequest {
  return {
    source: 'remote',
    variant: {
      kind: 'remote-clone',
      remoteUrl: join(dir, 'remote.git'),
      destinationDir: join(dir, 'clones'),
    },
    ...(key ? { idempotencyKey: key } : {}),
  };
}
async function identities(): Promise<unknown[]> {
  return ((await host.recoveryReport()).reservations ?? []).flatMap((entry) => {
    const parsed = workspaceCreationDiagnosticsSchema.safeParse(
      entry.diagnostics,
    );
    return parsed.success ? [parsed.data] : [];
  });
}
it('reserves remote identity before cloning and retains partial effects through restart', async () => {
  jest
    .spyOn(git, 'cloneRepo')
    .mockImplementationOnce(async (_url, destination) => {
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'partial'), 'owned partial clone');
      await host.shutdown();
      throw new Error('quit during clone');
    });
  await expect(createWorkspace(remoteRequest('quit'))).rejects.toThrow(
    'quit during clone',
  );
  restartHost();
  expect(await identities()).toHaveLength(1);
  expect(readFileSync(join(dir, 'clones', 'remote', 'partial'), 'utf8')).toBe(
    'owned partial clone',
  );
  await expect(createWorkspace(remoteRequest('quit'))).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual([
    'a',
  ]);
  await host.shutdown();
  restartHost();
  expect(await identities()).toHaveLength(1);
});

function manifestRequest(key?: string): WorkspaceCreationRequest {
  return {
    source: 'import_from_repo',
    variant: { kind: 'repository-manifest', repoPath: join(dir, 'source') },
    ...(key ? { idempotencyKey: key } : {}),
  };
}
function makeManifest(): void {
  execFileSync('git', ['clone', '-q', repo, join(dir, 'source')]);
  const repos = ['first', 'middle', 'last'].map((id) => {
    const remote = join(dir, `${id}.git`);
    execFileSync('git', ['clone', '-q', '--bare', repo, remote]);
    return { id, name: id, url: pathToFileURL(remote).href };
  });
  writeFileSync(
    join(dir, 'source', 'canopy.json'),
    JSON.stringify({ version: 1, repos }),
  );
  writeFileSync(join(dir, 'source', 'sentinel'), 'external source');
}
it.each([0, 1, 2])(
  'retains completed member steps and external source at member %s interruption',
  async (failureIndex) => {
    makeManifest();
    const before = snapshot(join(dir, 'source'));
    const clone = git.cloneRepo;
    let index = 0;
    jest.spyOn(git, 'cloneRepo').mockImplementation(async (...args) => {
      await clone(...args);
      if (index++ === failureIndex) {
        await host.shutdown();
        throw new Error('quit after member clone');
      }
    });
    await expect(createWorkspace(manifestRequest('members'))).rejects.toThrow(
      'quit after member clone',
    );
    restartHost();
    const records = await identities();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceId: 'source',
      repositories: [
        { role: 'source', owned: false, status: 'completed' },
        ...['first', 'middle', 'last']
          .slice(0, failureIndex)
          .map((id) => ({ id, status: 'completed', owned: true })),
        {
          id: ['first', 'middle', 'last'][failureIndex],
          status: 'started',
          owned: true,
        },
      ],
    });
    expect(JSON.stringify(records)).not.toContain(join(dir, 'source'));
    expect(snapshot(join(dir, 'source'))).toEqual(before);
    expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual([
      'a',
    ]);
    await expect(
      createWorkspace(manifestRequest('members')),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(snapshot(join(dir, 'source'))).toEqual(before);
  },
);

it.each(['remote', 'manifest', 'empty'] as const)(
  '%s: launch applies a committed create without provisioning again',
  async (kind) => {
    if (kind === 'manifest') makeManifest();
    const request: WorkspaceCreationRequest =
      kind === 'remote'
        ? remoteRequest()
        : kind === 'manifest'
          ? manifestRequest()
          : {
              source: 'new_multi_repo',
              variant: { kind: 'new-multi-repo', name: 'Empty' },
            };
    jest.spyOn(host, 'commit').mockImplementationOnce(async (input) => {
      await host.shutdown();
      const log = W5CommitLog.open(join(dir, 'w5', 'commit-log.sqlite'));
      try {
        log.commit(input);
      } finally {
        log.close();
      }
      throw new Error('lost canonical decision');
    });
    await expect(createWorkspace(request)).rejects.toThrow(
      'lost canonical decision',
    );
    restartHost();
    expect((await host.recoveryReport()).applied).toHaveLength(1);
    expect(await identities()).toEqual([]);
    const items = (await readAllSidebarItems()).items;
    expect(items).toHaveLength(kind === 'manifest' ? 5 : 2);
    if (kind === 'empty') {
      const empty = items.find((item) => item.id === 'empty');
      if (empty?.type !== 'multi-repo') throw new Error('Expected multi-repo');
      expect(empty.repos).toEqual([]);
      expect(
        execFileSync(
          'git',
          ['-C', empty.sourceRepoPath ?? '', 'rev-parse', 'HEAD'],
          { encoding: 'utf8' },
        ).trim(),
      ).toMatch(/^[a-f0-9]{40}$/);
    }
  },
);
it.each(['remote', 'manifest'] as const)(
  '%s: replays a lost final response without cloning or initializing twice',
  async (kind) => {
    if (kind === 'manifest') makeManifest();
    const request =
      kind === 'remote'
        ? remoteRequest('response')
        : manifestRequest('response');
    const commit = host.commit.bind(host);
    let saved: unknown;
    jest.spyOn(host, 'commit').mockImplementation(async (input) => {
      const result = await commit(input);
      if (input.receipt) {
        saved = input.outcome;
        await host.shutdown();
        throw new Error('lost response');
      }
      return result;
    });
    await expect(createWorkspace(request)).rejects.toThrow('lost response');
    restartHost();
    const before = snapshot();
    const clone = jest.spyOn(git, 'cloneRepo');
    const commits = jest.spyOn(host, 'commit');
    expect(await createWorkspace(request)).toEqual(saved);
    expect(clone).not.toHaveBeenCalled();
    expect(commits).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  },
);
it('releases an aborted-before-destination key and allows the same key to create once', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = remoteRequest('before-clone');
  if (request.variant.kind !== 'remote-clone')
    throw new Error('Expected remote clone');
  const clone = jest.spyOn(git, 'cloneRepoWithLiveProgress');
  await expect(
    createWorkspace({
      ...request,
      variant: {
        ...request.variant,
        progress: {
          signal: controller.signal,
          onDestination: jest.fn(),
          onCloned: jest.fn(),
          onProgress: jest.fn(),
        },
      },
    }),
  ).rejects.toThrow('Clone cancelled');
  expect(clone).not.toHaveBeenCalled();
  expect(await identities()).toEqual([]);
  expect(existsSync(join(dir, 'clones', 'remote'))).toBe(false);
  await createWorkspace(request);
  expect((await readAllSidebarItems()).items).toHaveLength(2);
});
it('retains a tracked interactive partial clone and its identity on quit', async () => {
  const removeDirectory = jest.fn((path: string): Promise<void> => {
    rmSync(path, { recursive: true, force: true });
    return Promise.resolve();
  });
  const registry = new CloneJobRegistry({
    changed: jest.fn(),
    now: Date.now,
    removeDirectory,
  });
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  jest
    .spyOn(git, 'cloneRepoWithLiveProgress')
    .mockImplementationOnce(async (_url, destination, options) => {
      writeFileSync(join(destination, 'partial'), 'retained');
      started();
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      throw new Error('Clone cancelled');
    });
  const run = registry.run(
    {
      id: 'quit',
      remoteUrl: join(dir, 'remote.git'),
      preserveDestinationOnFailure: true,
    },
    async (job) => {
      const request = remoteRequest('interactive');
      if (request.variant.kind !== 'remote-clone')
        throw new Error('Expected remote clone');
      return (
        await createWorkspace({
          ...request,
          variant: {
            ...request.variant,
            progress: {
              signal: job.signal,
              onDestination: job.setDestination,
              onProgress: job.progress,
              onCloned: job.finishing,
            },
          },
        })
      ).workspace;
    },
  );
  const settled = expect(run).rejects.toThrow('Clone cancelled');
  await ready;
  await registry.shutdown();
  await settled;
  expect(removeDirectory).not.toHaveBeenCalled();
  expect(readFileSync(join(dir, 'clones', 'remote', 'partial'), 'utf8')).toBe(
    'retained',
  );
  await host.shutdown();
  restartHost();
  expect(await identities()).toHaveLength(1);
  await expect(
    createWorkspace(remoteRequest('interactive')),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
});
/** Start an unkeyed tracked clone, as Add project does, held inside Git. */
async function startCancellableClone(
  removeDirectory: (path: string) => Promise<void>,
): Promise<{
  registry: CloneJobRegistry;
  settled: Promise<unknown>;
  request: WorkspaceCreationRequest;
}> {
  const registry = new CloneJobRegistry({
    changed: jest.fn(),
    now: Date.now,
    removeDirectory,
  });
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  jest
    .spyOn(git, 'cloneRepoWithLiveProgress')
    .mockImplementationOnce(async (_url, destination, options) => {
      writeFileSync(join(destination, 'partial'), 'cancelled');
      started();
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      throw new Error('Clone cancelled');
    });
  const request = remoteRequest();
  if (request.variant.kind !== 'remote-clone')
    throw new Error('Expected remote clone');
  const variant = request.variant;
  const settled = registry
    .run(
      {
        id: 'cancel',
        remoteUrl: variant.remoteUrl,
        preserveDestinationOnFailure: true,
      },
      async (job) =>
        (
          await createWorkspace({
            ...request,
            variant: {
              ...variant,
              progress: {
                signal: job.signal,
                onDestination: job.setDestination,
                onProgress: job.progress,
                onCloned: job.finishing,
              },
            },
          })
        ).workspace,
    )
    .then(
      () => 'unexpected success',
      (error: unknown) => error,
    );
  await ready;
  expect(await identities()).toHaveLength(1);
  return { registry, settled, request };
}
it('removes a cancelled tracked partial clone, then releases its identity for a fresh creation', async () => {
  const events: string[] = [];
  const removeDirectory = jest.fn(async (path: string): Promise<void> => {
    // The identity is still held while its checkout is removed.
    events.push(`remove with ${(await identities()).length} identity`);
    rmSync(path, { recursive: true, force: true });
  });
  const { registry, settled, request } =
    await startCancellableClone(removeDirectory);
  await registry.cancel('cancel');
  expect(await settled).toEqual(
    expect.objectContaining({ message: 'Clone cancelled' }),
  );
  expect(events).toEqual(['remove with 1 identity']);
  expect(removeDirectory).toHaveBeenCalledWith(join(dir, 'clones', 'remote'));
  expect(existsSync(join(dir, 'clones', 'remote'))).toBe(false);
  expect(await identities()).toEqual([]);
  await host.shutdown();
  restartHost();
  expect(await identities()).toEqual([]);
  const created = await createWorkspace(request);
  expect(created.workspace).toMatchObject({
    id: 'remote',
    repoPath: join(dir, 'clones', 'remote'),
  });
  expect(existsSync(join(dir, 'clones', 'remote', '.git'))).toBe(true);
  expect(await identities()).toEqual([]);
});
it('keeps a cancelled clone and its identity for recovery when removal fails', async () => {
  const { registry, settled } = await startCancellableClone(() =>
    Promise.reject(new Error('permission denied')),
  );
  await expect(registry.cancel('cancel')).resolves.toBeUndefined();
  expect(await settled).toEqual(new Error('permission denied'));
  expect(registry.list()[0].error).toContain('Remove it manually.');
  expect(readFileSync(join(dir, 'clones', 'remote', 'partial'), 'utf8')).toBe(
    'cancelled',
  );
  await host.shutdown();
  restartHost();
  const retained = (await identities()).map((entry) =>
    workspaceCreationDiagnosticsSchema.parse(entry),
  );
  expect(retained.map((entry) => entry.workspaceId)).toEqual(['remote']);
  expect(retained[0]?.ownedPaths).toContain(join(dir, 'clones', 'remote'));
  const created = await createWorkspace(remoteRequest());
  expect(created.workspace).toMatchObject({
    id: 'remote-2',
    repoPath: join(dir, 'clones', 'remote-2'),
  });
});
it('resolves collisions before clone and retains concurrent creations and unrelated index entries', async () => {
  makeManifest();
  mkdirSync(join(dir, 'clones', 'remote'), { recursive: true });
  writeFileSync(join(dir, 'clones', 'remote', 'sentinel'), 'unrelated');
  const clone = git.cloneRepo;
  const destinations: string[] = [];
  jest.spyOn(git, 'cloneRepo').mockImplementation(async (...args) => {
    destinations.push(args[1]);
    expect(existsSync(args[1])).toBe(true);
    await clone(...args);
  });
  await Promise.all([
    createWorkspace(remoteRequest('one')),
    createWorkspace(remoteRequest('two')),
    createWorkspace(manifestRequest('many')),
  ]);
  expect(destinations).toContain(join(dir, 'clones', 'remote-2'));
  expect(destinations).toContain(join(dir, 'clones', 'remote-3'));
  expect(new Set(destinations).size).toBe(destinations.length);
  expect(readFileSync(join(dir, 'clones', 'remote', 'sentinel'), 'utf8')).toBe(
    'unrelated',
  );
  const ids = (await readAllSidebarItems()).items.map((item) => item.id);
  expect(ids).toHaveLength(7);
  expect(new Set(ids).size).toBe(ids.length);
  await host.shutdown();
  restartHost();
  expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual(
    ids,
  );
});

it.each(['remote', 'manifest'] as const)(
  '%s: failures before and after identity reservation preserve the correct outcome',
  async (kind) => {
    if (kind === 'manifest') makeManifest();
    const request = kind === 'remote' ? remoteRequest() : manifestRequest();
    const before = snapshot();
    const reserve = host.reserve.bind(host);
    const spy = jest
      .spyOn(host, 'reserve')
      .mockRejectedValueOnce(new Error('before reservation'));
    await expect(createWorkspace(request)).rejects.toThrow(
      'before reservation',
    );
    expect(await identities()).toEqual([]);
    expect(snapshot()).toEqual(before);
    spy.mockImplementationOnce(async (input) => {
      await reserve(input);
      await host.shutdown();
      throw new Error('after reservation');
    });
    await expect(createWorkspace(request)).rejects.toThrow('after reservation');
    restartHost();
    const pending = await identities();
    expect(pending).toHaveLength(1);
    expect(snapshot()).toEqual(before);
    await createWorkspace(request);
    expect(await identities()).toEqual(pending);
    const created = (await readAllSidebarItems()).items.filter(
      (item) => item.id !== 'a',
    );
    expect(
      created.some(
        (item) => item.id === (kind === 'remote' ? 'remote' : 'source'),
      ),
    ).toBe(false);
  },
);
it.each(['before', 'after'] as const)(
  'retains a truthful source initialization step %s Git starts',
  async (point) => {
    const init = git.initGitRepo;
    jest.spyOn(git, 'initGitRepo').mockImplementationOnce(async (...args) => {
      if (point === 'after') await init(...args);
      await host.shutdown();
      throw new Error('quit initializing source');
    });
    const request: WorkspaceCreationRequest = {
      source: 'new_multi_repo',
      idempotencyKey: 'source-init',
      variant: { kind: 'new-multi-repo', name: 'New Source' },
    };
    await expect(createWorkspace(request)).rejects.toThrow(
      'quit initializing source',
    );
    restartHost();
    expect(await identities()).toEqual([
      expect.objectContaining({
        workspaceId: 'new-source',
        repositories: [
          expect.objectContaining({
            role: 'source',
            owned: true,
            status: 'started',
          }),
        ],
      }),
    ]);
    expect(existsSync(join(dir, 'data', 'repos', 'new-source'))).toBe(true);
    expect(existsSync(join(dir, 'data', 'repos', 'new-source', '.git'))).toBe(
      point === 'after',
    );
    expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual([
      'a',
    ]);
    await expect(createWorkspace(request)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  },
);
it('retains a replaced remote destination without cloning into it or deleting it', async () => {
  const reserve = host.reserve.bind(host);
  const target = join(dir, 'clones', 'remote');
  jest.spyOn(host, 'reserve').mockImplementationOnce(async (input) => {
    await reserve(input);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'sentinel'), 'replacement');
  });
  const clone = jest.spyOn(git, 'cloneRepo');
  await expect(createWorkspace(remoteRequest())).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(clone).not.toHaveBeenCalled();
  expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('replacement');
  expect(await identities()).toEqual([]);
});

it('uses one identity for a remote manifest source and every completed member before publication', async () => {
  makeManifest();
  execFileSync('git', ['-C', join(dir, 'source'), 'add', 'canopy.json']);
  execFileSync('git', [
    '-C',
    join(dir, 'source'),
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'manifest',
  ]);
  const remote = join(dir, 'bundle.git');
  execFileSync('git', ['clone', '-q', '--bare', join(dir, 'source'), remote]);
  const request: WorkspaceCreationRequest = {
    source: 'remote',
    idempotencyKey: 'bundle',
    variant: {
      kind: 'remote-clone',
      remoteUrl: remote,
      destinationDir: join(dir, 'clones'),
    },
  };
  const clone = jest.spyOn(git, 'cloneRepo');
  jest
    .spyOn(host, 'commit')
    .mockRejectedValueOnce(new Error('before canonical commit'));
  await expect(createWorkspace(request)).rejects.toThrow(
    'before canonical commit',
  );
  await host.shutdown();
  restartHost();
  expect(await identities()).toMatchObject([
    {
      workspaceId: 'bundle',
      phase: 'before-canonical-commit',
      repositories: [
        {
          id: 'source',
          role: 'source',
          action: 'clone',
          owned: true,
          status: 'completed',
        },
        ...['first', 'middle', 'last'].map((id) => ({
          id,
          role: 'member',
          action: 'clone',
          owned: true,
          status: 'completed',
        })),
      ],
    },
  ]);
  const diagnostics = (
    (await host.recoveryReport()).reservations ?? []
  ).flatMap((entry) => {
    const parsed = workspaceCreationDiagnosticsSchema.safeParse(
      entry.diagnostics,
    );
    return parsed.success ? [parsed.data] : [];
  });
  const diagnostic = diagnostics[0];
  expect(diagnostic?.ownedPaths).toEqual(
    expect.arrayContaining([
      join(root, 'bundle'),
      join(dir, 'clones', 'bundle'),
      ...['first', 'middle', 'last'].map((id) =>
        join(dir, 'data', 'repos', id),
      ),
    ]),
  );
  expect(clone).toHaveBeenCalledTimes(4);
  await expect(createWorkspace(request)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(clone).toHaveBeenCalledTimes(4);
  expect((await readAllSidebarItems()).items.map((item) => item.id)).toEqual([
    'a',
  ]);
});
it('records reused members without claiming or modifying their existing repositories', async () => {
  makeManifest();
  const existing = await createWorkspace({
    source: 'remote',
    variant: {
      kind: 'remote-clone',
      remoteUrl: pathToFileURL(join(dir, 'first.git')).href,
      destinationDir: join(dir, 'existing'),
    },
  });
  if (existing.workspace.type !== 'single-repo')
    throw new Error('Expected single repository');
  const before = snapshot(existing.workspace.repoPath);
  const clone = git.cloneRepo;
  jest.spyOn(git, 'cloneRepo').mockImplementationOnce(async (...args) => {
    await clone(...args);
    throw new Error('middle interrupted');
  });
  await expect(createWorkspace(manifestRequest('reuse'))).rejects.toThrow(
    'middle interrupted',
  );
  await host.shutdown();
  restartHost();
  expect(await identities()).toEqual([
    expect.objectContaining({
      repositories: [
        expect.objectContaining({
          role: 'source',
          owned: false,
          status: 'completed',
        }),
        {
          id: 'first',
          role: 'member',
          action: 'import',
          owned: false,
          status: 'completed',
        },
        expect.objectContaining({
          id: 'middle',
          owned: true,
          status: 'started',
        }),
      ],
    }),
  ]);
  expect(JSON.stringify(await identities())).not.toContain(
    existing.workspace.repoPath,
  );
  expect(snapshot(existing.workspace.repoPath)).toEqual(before);
});

function gate(): { ready: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}
async function finishesPromptly(work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
it.each(['remote', 'progress', 'manifest'] as const)(
  '%s: blocked Git leaves the workspace queue free and retains interrupted effects',
  async (kind) => {
    if (kind === 'manifest') makeManifest();
    const request =
      kind === 'manifest'
        ? manifestRequest('unlocked')
        : remoteRequest('unlocked');
    if (kind === 'progress' && request.variant.kind === 'remote-clone')
      request.variant.progress = {
        signal: new AbortController().signal,
        onDestination: jest.fn(),
        onProgress: jest.fn(),
        onCloned: jest.fn(),
      };
    const started = gate();
    const blocked = gate();
    const clone = git.cloneRepo;
    const heldClone = async (url: string, path: string): Promise<void> => {
      await clone(url, path);
      started.release();
      await blocked.ready;
      throw new Error('interrupted outside queue');
    };
    if (kind === 'progress')
      jest
        .spyOn(git, 'cloneRepoWithLiveProgress')
        .mockImplementationOnce(heldClone);
    else jest.spyOn(git, 'cloneRepo').mockImplementationOnce(heldClone);
    const creation = createWorkspace(request).then(
      () => 'unexpected success',
      (error: unknown) => error,
    );
    await started.ready;
    const rename = serializeWorkspaceMutation(() =>
      renameWorkspaceIndexEntry('a', 'Renamed during clone', ['Original']),
    );
    try {
      expect(await finishesPromptly(rename)).toBe(true);
    } finally {
      blocked.release();
      await creation;
      await rename;
    }
    expect(await creation).toEqual(new Error('interrupted outside queue'));
    expect(
      (await readAllSidebarItems()).items.find((item) => item.id === 'a')?.name,
    ).toBe('Renamed during clone');
    await host.shutdown();
    restartHost();
    expect(await identities()).toHaveLength(1);
    const target =
      kind === 'manifest'
        ? join(dir, 'data', 'repos', 'first')
        : join(dir, 'clones', 'remote');
    expect(existsSync(join(target, '.git'))).toBe(true);
    await expect(createWorkspace(request)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  },
);
it('cancels a tracked clone waiting for admission before the workspace queue is released', async () => {
  const entered = gate();
  const blocked = gate();
  const queue = serializeWorkspaceMutation(async () => {
    entered.release();
    await blocked.ready;
  });
  await entered.ready;
  const registry = new CloneJobRegistry({
    changed: jest.fn(),
    now: Date.now,
    removeDirectory: jest.fn(() => Promise.resolve()),
  });
  const request = remoteRequest('waiting');
  if (request.variant.kind !== 'remote-clone')
    throw new Error('Expected clone');
  const variant = request.variant;
  const clone = jest.spyOn(git, 'cloneRepoWithLiveProgress');
  const creation = registry
    .run(
      {
        id: 'waiting',
        remoteUrl: variant.remoteUrl,
        preserveDestinationOnFailure: true,
      },
      async (job) =>
        (
          await createWorkspace({
            ...request,
            variant: {
              ...variant,
              progress: {
                signal: job.signal,
                onDestination: job.setDestination,
                onProgress: job.progress,
                onCloned: job.finishing,
              },
            },
          })
        ).workspace,
    )
    .then(
      () => 'unexpected success',
      (error: unknown) => error,
    );
  // Let creation reach its queue wait while the unrelated mutation stays held.
  await host.recoveryReport();
  const cancellation = registry.cancel('waiting');
  try {
    expect(await finishesPromptly(cancellation)).toBe(true);
    expect(clone).not.toHaveBeenCalled();
    expect(await identities()).toEqual([]);
  } finally {
    blocked.release();
    await queue;
    await cancellation;
    await creation;
  }
  expect(await creation).toEqual(
    expect.objectContaining({ message: 'Clone cancelled' }),
  );
  expect(existsSync(join(dir, 'clones', 'remote'))).toBe(false);
  await createWorkspace(request);
  expect((await readAllSidebarItems()).items).toHaveLength(2);
});
function nestedManifest(): void {
  makeManifest();
  writeFileSync(
    join(dir, 'source', 'canopy.json'),
    JSON.stringify({
      version: 1,
      repos: [
        {
          id: 'api',
          name: 'team/api',
          url: pathToFileURL(join(dir, 'first.git')).href,
        },
      ],
    }),
  );
}
it('imports a nested manifest member when its parent directory does not exist', async () => {
  nestedManifest();
  const result = await createWorkspace(manifestRequest('nested'));
  expect(result.workspace.type).toBe('multi-repo');
  const path = join(dir, 'data', 'repos', 'team', 'api');
  expect(existsSync(join(path, '.git'))).toBe(true);
  expect(await identities()).toEqual([]);
});
it('refuses a nested member destination replaced after reservation and preserves it on restart', async () => {
  nestedManifest();
  const target = join(dir, 'data', 'repos', 'team', 'api');
  const update = host.updateReservationDiagnostics.bind(host);
  jest
    .spyOn(host, 'updateReservationDiagnostics')
    .mockImplementation(async (id, diagnostic) => {
      await update(id, diagnostic);
      if (
        diagnostic.repositories?.some(
          (repo) => repo.role === 'member' && repo.status === 'started',
        )
      ) {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'sentinel'), 'replacement');
      }
    });
  const clone = jest.spyOn(git, 'cloneRepo');
  await expect(
    createWorkspace(manifestRequest('collision')),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(clone).not.toHaveBeenCalled();
  await host.shutdown();
  restartHost();
  expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('replacement');
  await expect(
    createWorkspace(manifestRequest('collision')),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
});
