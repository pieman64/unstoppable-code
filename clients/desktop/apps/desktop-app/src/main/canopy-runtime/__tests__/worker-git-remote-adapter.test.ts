// `worker.git.remote.get` on the desktop dispatcher over real checkouts and
// workspace records: the query is pure and withholds local remote URLs, and
// only the projections resolve the requested path or rebuild legacy host-path
// fields.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerGitRemoteGetParams,
} from '@canopy/protocol/canopy-core';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  desktopWorkerGitRemoteHost,
  queryGitRemoteAtLocation,
  type GitRemoteLocation,
  type WorkerGitDispatcher,
} from '../worker-git-adapter';
import { readRepositoryRemoteUrl } from '../worker-git-dispatch';
import { inspectReferenceRepo } from '../../lib/workspace-reference-repo-health';

jest.setTimeout(120_000);

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};
const gitCaller: CanopyCallerDescriptor = {
  ...caller,
  grants: [WORKER_GIT_GRANTS.read],
};

let dir: string;
let dataDir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;
const repos: Record<string, string> = {};
const origins: Record<string, string> = {};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function clone(name: string): string {
  const seed = join(dir, 'seeds', name);
  mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.email', 'git@example.com']);
  git(seed, ['config', 'user.name', 'Git']);
  writeFileSync(join(seed, 'README.md'), 'readme\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'initial']);
  origins[name] = join(dir, 'origins', `${name}.git`);
  mkdirSync(join(origins[name], '..'), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, origins[name]], {
    stdio: 'pipe',
  });
  const path = join(dir, 'clones', name);
  mkdirSync(join(path, '..'), { recursive: true });
  execFileSync('git', ['clone', '-q', origins[name], path], { stdio: 'pipe' });
  return path;
}

/** Every file under `root` with its bytes, for a write-free comparison. */
function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (statSync(child).isDirectory()) walk(child);
      else files[child] = readFileSync(child, 'utf8');
    }
  };
  walk(root);
  return files;
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-git-remote-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  repos.single = clone('single');
  repos.member = clone('member');
  repos.main = clone('main');
  repos.linked = join(dir, 'linked', 'feature');
  git(repos.main, ['worktree', 'add', '-q', '-b', 'feature', repos.linked]);
  repos.other = clone('other');
  repos.untracked = clone('untracked');
  repos.fileUrl = clone('file-url');
  origins.fileUrl = `file://${origins['file-url']}`;
  git(repos.fileUrl, ['remote', 'set-url', 'origin', origins.fileUrl]);
  repos.network = clone('network');
  origins.network = 'https://x-access-token:secret@example.com/org/network.git';
  git(repos.network, ['remote', 'set-url', 'origin', origins.network]);
  repos.plain = join(dir, 'plain');
  mkdirSync(repos.plain);
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      ['single-ws', 'single-repo'],
      ['network-ws', 'single-repo'],
      ['multi-ws', 'multi-repo'],
      ['file-url-ws', 'multi-repo'],
      ['plain-ws', 'multi-repo'],
      ['no-source-ws', 'multi-repo'],
      ['cowork-ws', 'cowork'],
    ].map(([id, type], order) => ({
      id,
      name: id,
      type,
      color: '#38BDF8',
      collapsed: false,
      order,
    })),
  });
  writeJson(join(dataDir, 'workspaces', 'single-ws', 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repos.single,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', 'network-ws', 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repos.network,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', 'file-url-ws', 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: repos.fileUrl,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', 'multi-ws', 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: repos.linked,
    repos: [{ id: 'member', name: 'member', repoPath: repos.member }],
  });
  writeJson(join(dataDir, 'workspaces', 'plain-ws', 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: repos.plain,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', 'no-source-ws', 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [{ id: 'member', name: 'member', repoPath: repos.member }],
  });
  writeJson(join(dataDir, 'workspaces', 'cowork-ws', 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
  });
  runtime = createDesktopRuntime();
});

afterAll(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const recorded = (
  workspaceId: string,
  repoId?: string,
): WorkerGitRemoteGetParams => ({
  scope: { workspaceId, ...(repoId === undefined ? {} : { repoId }) },
  repository: { kind: 'recorded' },
});
const source = (workspaceId: string): WorkerGitRemoteGetParams => ({
  scope: { workspaceId },
  repository: { kind: 'source' },
});

/** The runtime's dispatcher, recording its `worker.git.remote.get` calls. */
function recording(): {
  dispatcher: WorkerGitDispatcher;
  calls: () => unknown[];
} {
  const spy = jest.spyOn(runtime, 'query');
  afterSpies.push(() => spy.mockRestore());
  return {
    dispatcher: runtime,
    calls: () =>
      spy.mock.calls
        .filter(([name]) => name === 'worker.git.remote.get')
        .map(([, params, options]) => ({ params, options })),
  };
}

const afterSpies: (() => void)[] = [];
afterEach(() => {
  for (const restore of afterSpies.splice(0)) restore();
});

describe('worker.git.remote.get on the desktop dispatcher', () => {
  const query = (params: WorkerGitRemoteGetParams): Promise<unknown> =>
    runtime.query('worker.git.remote.get', params, { caller: gitCaller });
  const local = {
    origin: { state: 'configured', endpoint: { kind: 'local' } },
  };

  it('reads recorded repositories and the source at its main checkout', async () => {
    await expect(query(recorded('single-ws'))).resolves.toEqual(local);
    await expect(
      query(recorded('single-ws', '__workspace_root__')),
    ).resolves.toEqual(local);
    await expect(query(recorded('multi-ws', 'member'))).resolves.toEqual(local);
    const location: GitRemoteLocation = {};
    await expect(
      queryGitRemoteAtLocation(
        runtime,
        source('multi-ws'),
        { caller: gitCaller },
        location,
      ),
    ).resolves.toEqual(local);
    expect(location).toEqual({
      repoPath: repos.main,
      originUrl: origins.main,
    });
    const recordedLocation: GitRemoteLocation = {};
    await queryGitRemoteAtLocation(
      runtime,
      recorded('multi-ws'),
      { caller: gitCaller },
      recordedLocation,
    );
    expect(recordedLocation).toEqual({
      repoPath: repos.linked,
      originUrl: origins.main,
    });
  });

  it('carries a network origin URL without userinfo and withholds path and file URL origins', async () => {
    await expect(query(recorded('network-ws'))).resolves.toEqual({
      origin: {
        state: 'configured',
        endpoint: {
          kind: 'network',
          url: 'https://example.com/org/network.git',
        },
      },
    });
    for (const params of [
      recorded('single-ws'),
      recorded('multi-ws', 'member'),
      source('multi-ws'),
      source('file-url-ws'),
      recorded('file-url-ws'),
    ]) {
      const result = await query(params);
      expect(result).toEqual(local);
      // Relay callers (D6) get this result alone: no host path reaches it.
      expect(JSON.stringify(result)).not.toContain(dir);
    }
    const location: GitRemoteLocation = {};
    await queryGitRemoteAtLocation(
      runtime,
      source('file-url-ws'),
      { caller: gitCaller },
      location,
    );
    expect(location).toEqual({
      repoPath: repos.fileUrl,
      originUrl: origins.fileUrl,
    });
  });

  it('reports a source that is not a repository as a typed precondition', async () => {
    await expect(
      runtime.query('worker.git.remote.get', source('plain-ws'), {
        caller: gitCaller,
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.remote.notRepository',
      },
    });
  });

  it('requires worker.git.read; the standing desktop grants do not carry it', async () => {
    await expect(
      runtime.query('worker.git.remote.get', recorded('single-ws'), {
        caller,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  });

  it('refuses another authority or any target before resolving or running Git', async () => {
    const resolveRepository = jest.fn(
      (
        ...args: Parameters<typeof desktopWorkerGitRemoteHost.resolveRepository>
      ) => desktopWorkerGitRemoteHost.resolveRepository(...args),
    );
    const reads = jest.fn(
      (...args: Parameters<typeof desktopWorkerGitRemoteHost.reads>) =>
        desktopWorkerGitRemoteHost.reads(...args),
    );
    const spied = createDesktopRuntime({
      workerGitRemoteHost: {
        ...desktopWorkerGitRemoteHost,
        resolveRepository,
        reads,
      },
    });
    try {
      for (const params of [recorded('single-ws'), source('multi-ws')]) {
        for (const selection of [
          { authorityId: 'foreign-authority' },
          { targetId: 'remote-worker' },
          { authorityId: 'local-desktop', targetId: 'remote-worker' },
        ])
          await expect(
            spied.query(
              'worker.git.remote.get',
              { ...params, scope: { ...params.scope, ...selection } },
              { caller: gitCaller },
            ),
          ).rejects.toMatchObject({
            payload: {
              kind: 'capability_unavailable',
              retry: { kind: 'never' },
            },
          });
        expect(resolveRepository).not.toHaveBeenCalled();
        expect(reads).not.toHaveBeenCalled();
        await expect(
          spied.query(
            'worker.git.remote.get',
            {
              ...params,
              scope: { ...params.scope, authorityId: 'local-desktop' },
            },
            { caller: gitCaller },
          ),
        ).resolves.toMatchObject({ origin: { state: 'configured' } });
        expect(reads).toHaveBeenCalledTimes(1);
        resolveRepository.mockClear();
        reads.mockClear();
      }
    } finally {
      await spied.shutdown();
    }
  });

  it('refuses invalid scopes and missing records with typed codes', async () => {
    for (const params of [
      recorded('Bad'),
      recorded('single-ws', 'Bad'),
      {
        scope: { workspaceId: 'single-ws', worktreeId: 'wt' },
        repository: { kind: 'recorded' },
      },
      {
        scope: { workspaceId: 'multi-ws', repoId: 'member' },
        repository: { kind: 'source' },
      },
    ] satisfies WorkerGitRemoteGetParams[])
      await expect(
        runtime.query('worker.git.remote.get', params, { caller: gitCaller }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          code: 'worker.git.remote.invalidScope',
        },
      });
    for (const params of [
      recorded('cowork-ws'),
      recorded('no-source-ws'),
      recorded('multi-ws', 'absent'),
      recorded('single-ws', 'member'),
      recorded('ghost-ws'),
      source('no-source-ws'),
      source('single-ws'),
    ])
      await expect(
        runtime.query('worker.git.remote.get', params, { caller: gitCaller }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'worker.git.remote.repositoryUnavailable',
        },
      });
  });

  it('writes no Canopy store and no repository file', async () => {
    const before = tree(dir);
    for (const params of [
      recorded('single-ws'),
      recorded('multi-ws', 'member'),
      source('multi-ws'),
      source('plain-ws'),
      recorded('ghost-ws'),
    ])
      await runtime
        .query('worker.git.remote.get', params, { caller: gitCaller })
        .catch(() => undefined);
    await readRepositoryRemoteUrl(runtime, caller, repos.single);
    await readRepositoryRemoteUrl(runtime, caller, repos.untracked);
    expect(tree(dir)).toEqual(before);
  });
});

describe('repo:get-remote-url projection', () => {
  it('reads a recorded path through the query with only worker.git.read', async () => {
    const { dispatcher, calls } = recording();
    const cases = [
      [repos.single, 'single-ws', undefined, origins.single],
      [repos.linked, 'multi-ws', undefined, origins.main],
      [repos.member, 'multi-ws', 'member', origins.member],
      [repos.fileUrl, 'file-url-ws', undefined, origins.fileUrl],
      [repos.network, 'network-ws', undefined, origins.network],
    ] as const;
    for (const [path, , , url] of cases)
      await expect(
        readRepositoryRemoteUrl(dispatcher, caller, path),
      ).resolves.toEqual({ remoteUrl: url });
    expect(calls()).toEqual(
      cases.map(([, workspaceId, repoId]) => ({
        params: recorded(workspaceId, repoId),
        options: { caller: gitCaller },
      })),
    );
  });

  it('answers null for a recorded path that is not a repository', async () => {
    const { dispatcher, calls } = recording();
    await expect(
      readRepositoryRemoteUrl(dispatcher, caller, repos.plain),
    ).resolves.toEqual({ remoteUrl: null });
    expect(calls()).toHaveLength(1);
  });

  it('reads other paths directly without the query', async () => {
    const { dispatcher, calls } = recording();
    for (const [path, remoteUrl] of [
      [repos.untracked, origins.untracked],
      [`${repos.single}/`, origins.single],
      [repos.main, origins.main],
      [join(dir, 'missing'), null],
    ] as const)
      await expect(
        readRepositoryRemoteUrl(dispatcher, caller, path),
      ).resolves.toEqual({ remoteUrl });
    expect(calls()).toEqual([]);
  });

  it('falls back to the direct read when the record resolves elsewhere', async () => {
    // The record moved between the lookup and the query's resolution.
    const moved = createDesktopRuntime({
      workerGitRemoteHost: {
        ...desktopWorkerGitRemoteHost,
        // The single-repo record now names the multi-repo member.
        resolveRepository: (params, context) =>
          desktopWorkerGitRemoteHost.resolveRepository(
            {
              ...params,
              scope: { workspaceId: 'multi-ws', repoId: 'member' },
            },
            context,
          ),
      },
    });
    try {
      await expect(
        readRepositoryRemoteUrl(moved, caller, repos.single),
      ).resolves.toEqual({ remoteUrl: origins.single });
    } finally {
      await moved.shutdown();
    }
  });

  it('falls back to the direct read when the dispatcher refuses the call', async () => {
    const refusing: WorkerGitDispatcher = {
      query: (): Promise<never> => Promise.reject(new Error('runtime closed')),
    };
    await expect(
      readRepositoryRemoteUrl(refusing, caller, repos.single),
    ).resolves.toEqual({ remoteUrl: origins.single });
  });
});

describe('reference repository health projection', () => {
  it('syncs and reports the URL a file URL origin withholds from the query', async () => {
    await expect(
      inspectReferenceRepo(runtime, 'file-url-ws'),
    ).resolves.toMatchObject({
      referenceRepoPath: repos.fileUrl,
      healthy: true,
      remoteUrl: origins.fileUrl,
      defaultBranch: 'main',
    });
  });

  it('reads the source remote as the trusted poller caller', async () => {
    const { dispatcher, calls } = recording();
    await expect(inspectReferenceRepo(dispatcher, 'plain-ws')).resolves.toEqual(
      expect.objectContaining({
        referenceRepoPath: repos.plain,
        healthy: false,
      }),
    );
    expect(calls()).toEqual([
      {
        params: source('plain-ws'),
        options: {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'electron-main-reference-repo-poller',
            authorityId: 'local-desktop',
            interfaceKind: 'desktop',
            grants: [WORKER_GIT_GRANTS.read],
          },
        },
      },
    ]);
  });
});
