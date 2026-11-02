// `worker.git.branch.list` on the desktop dispatcher over real checkouts: the
// query is pure, and only the IPC projection records the default branch and
// repairs origin/HEAD.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerGitBranchListParams,
} from '@canopy/protocol/canopy-core';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  listHomeBranchTargets,
  listWorktreeBranches,
} from '../worker-git-dispatch';
import { desktopWorkerGitBranchListHost } from '../worker-git-adapter';
import { recordGitDefaultBranch } from '../../lib/git-default-branch-freshness';
import { registerCodeReviewTarget } from '../../lib/code-review-registry';

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

function originHead(repo: string): string {
  return git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
}

/** A clone whose origin HEAD is main while its origin/HEAD says develop. */
function divergentClone(name: string): string {
  const seed = join(dir, 'seeds', name);
  mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.email', 'git@example.com']);
  git(seed, ['config', 'user.name', 'Git']);
  writeFileSync(join(seed, 'README.md'), 'readme\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'initial']);
  git(seed, ['branch', 'develop']);
  const origin = join(dir, 'origins', `${name}.git`);
  mkdirSync(join(origin, '..'), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], {
    stdio: 'pipe',
  });
  const clone = join(dir, 'clones', name);
  mkdirSync(join(clone, '..'), { recursive: true });
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'pipe' });
  git(clone, ['remote', 'set-head', 'origin', 'develop']);
  return clone;
}

function freshnessPath(): string {
  return join(dataDir, 'git-default-branch-freshness.json');
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-git-adapter-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  for (const name of ['pure-ws', 'hint-ws', 'home-ws']) {
    repos[name] = divergentClone(name);
    writeJson(join(dataDir, 'workspaces', name, 'workspace.json'), {
      version: 1,
      type: 'single-repo',
      repoPath: repos[name],
      repos: [],
    });
    git(repos[name], [
      'worktree',
      'add',
      '-q',
      '-b',
      'wt-01',
      join(dataDir, 'workspaces', name, 'worktrees', 'wt-01'),
    ]);
  }
  writeJson(join(dataDir, 'workspaces', 'no-source-ws', 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: ['pure-ws', 'hint-ws', 'home-ws', 'no-source-ws'].map(
      (id, order) => ({
        id,
        name: id,
        type: id === 'no-source-ws' ? 'multi-repo' : 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order,
      }),
    ),
  });
  await recordGitDefaultBranch({
    identity: {
      commonDir: realpathSync(join(repos['hint-ws'] ?? '', '.git')),
      originUrl: git(repos['hint-ws'] ?? '', ['remote', 'get-url', 'origin']),
    },
    defaultBranch: 'develop',
    resolvedAt: Date.now(),
  });
  runtime = createDesktopRuntime();
});

afterAll(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const checkout = (
  workspaceId: string,
  worktreeId = 'wt-01',
): WorkerGitBranchListParams => ({
  scope: { workspaceId, worktreeId },
  repository: { kind: 'checkout' },
});

describe('worker.git.branch.list on the desktop dispatcher', () => {
  it('selects the remote default without recording it or repairing origin/HEAD', async () => {
    const repo = repos['pure-ws'] ?? '';
    const freshnessBefore = existsSync(freshnessPath());
    await expect(
      runtime.query('worker.git.branch.list', checkout('pure-ws'), {
        caller: gitCaller,
      }),
    ).resolves.toMatchObject({
      defaultBranch: 'main',
      defaultBranchSource: 'remote',
    });
    expect(originHead(repo)).toBe('refs/remotes/origin/develop');
    expect(existsSync(freshnessPath())).toBe(freshnessBefore);

    // The IPC projection applies the effects the legacy listing had.
    await expect(
      listWorktreeBranches(runtime, caller, {
        projectId: 'pure-ws',
        worktreeId: 'wt-01',
      }),
    ).resolves.toMatchObject({ defaultBranch: 'main' });
    expect(originHead(repo)).toBe('refs/remotes/origin/main');
    expect(existsSync(freshnessPath())).toBe(true);
  });

  it('short-circuits on a fresh recorded default only for the projection', async () => {
    // The recorded default is develop while the remote HEAD names main.
    const freshnessBefore = readFileSync(freshnessPath(), 'utf8');
    await expect(
      runtime.query('worker.git.branch.list', checkout('hint-ws'), {
        caller: gitCaller,
      }),
    ).resolves.toMatchObject({
      defaultBranch: 'main',
      defaultBranchSource: 'remote',
    });
    expect(readFileSync(freshnessPath(), 'utf8')).toBe(freshnessBefore);
    const listed = await listWorktreeBranches(runtime, caller, {
      projectId: 'hint-ws',
      worktreeId: 'wt-01',
    });
    expect(listed).toEqual({
      branches: [
        expect.objectContaining({ name: 'wt-01', isCurrent: true }),
        expect.objectContaining({ name: 'develop' }),
        expect.objectContaining({ name: 'main' }),
      ],
      defaultBranch: 'develop',
    });
    // Snapshots sort keys; the base response's key order is pinned here.
    expect(Object.keys(listed)).toEqual(['branches', 'defaultBranch']);
    expect(Object.keys(listed.branches[0] ?? {})).toEqual([
      'name',
      'isRemote',
      'isCurrent',
      'isUsedByWorktree',
      'hasLocalRef',
      'hasRemoteRef',
    ]);
    expect(readFileSync(freshnessPath(), 'utf8')).toBe(freshnessBefore);
    expect(originHead(repos['hint-ws'] ?? '')).toBe(
      'refs/remotes/origin/develop',
    );
  });

  it('keeps each concurrent projection on its own repository', async () => {
    for (const name of ['race-a', 'race-b', 'race-c']) {
      repos[name] = divergentClone(name);
      writeJson(join(dataDir, 'workspaces', name, 'workspace.json'), {
        version: 1,
        type: 'single-repo',
        repoPath: repos[name],
        repos: [],
      });
    }
    // race-b's origin names develop, so each repair must land on its own repo.
    git(join(dir, 'origins', 'race-b.git'), [
      'symbolic-ref',
      'HEAD',
      'refs/heads/develop',
    ]);
    git(repos['race-b'] ?? '', ['remote', 'set-head', 'origin', 'main']);
    const results = await Promise.all(
      ['race-a', 'race-b', 'race-c'].map((workspaceId) =>
        listHomeBranchTargets(runtime, caller, { workspaceId }),
      ),
    );
    expect(results.map((result) => result.defaultBranch)).toEqual([
      'main',
      'develop',
      'main',
    ]);
    expect(originHead(repos['race-a'] ?? '')).toBe('refs/remotes/origin/main');
    expect(originHead(repos['race-b'] ?? '')).toBe(
      'refs/remotes/origin/develop',
    );
    expect(originHead(repos['race-c'] ?? '')).toBe('refs/remotes/origin/main');
    const recorded: unknown = JSON.parse(readFileSync(freshnessPath(), 'utf8'));
    const entries: unknown =
      typeof recorded === 'object' && recorded !== null
        ? Reflect.get(recorded, 'entries')
        : null;
    const byCommonDir = new Map(
      Object.values(
        typeof entries === 'object' && entries !== null ? entries : {},
      )
        .filter(
          (entry: unknown): entry is object =>
            typeof entry === 'object' && entry !== null,
        )
        .map((entry) => [
          String(Reflect.get(entry, 'commonDir')),
          Reflect.get(entry, 'defaultBranch'),
        ]),
    );
    for (const [name, branch] of [
      ['race-a', 'main'],
      ['race-b', 'develop'],
      ['race-c', 'main'],
    ] as const)
      expect(
        byCommonDir.get(realpathSync(join(repos[name] ?? '', '.git'))),
      ).toBe(branch);
  });

  it('requires worker.git.read; the standing desktop grants do not carry it', async () => {
    await expect(
      runtime.query('worker.git.branch.list', checkout('pure-ws'), { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  });

  it('refuses another authority or any target before resolving or running Git', async () => {
    const resolveRepository = jest.fn(
      (
        ...args: Parameters<
          typeof desktopWorkerGitBranchListHost.resolveRepository
        >
      ) => desktopWorkerGitBranchListHost.resolveRepository(...args),
    );
    const reads = jest.fn(
      (...args: Parameters<typeof desktopWorkerGitBranchListHost.reads>) =>
        desktopWorkerGitBranchListHost.reads(...args),
    );
    const spied = createDesktopRuntime({
      workerGitHost: {
        ...desktopWorkerGitBranchListHost,
        resolveRepository,
        reads,
      },
    });
    try {
      for (const params of [
        checkout('pure-ws'),
        {
          scope: { workspaceId: 'home-ws' },
          repository: { kind: 'reference' },
        },
      ] satisfies WorkerGitBranchListParams[]) {
        for (const selection of [
          { authorityId: 'foreign-authority' },
          { targetId: 'remote-worker' },
          { authorityId: 'local-desktop', targetId: 'remote-worker' },
        ])
          await expect(
            spied.query(
              'worker.git.branch.list',
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
            'worker.git.branch.list',
            {
              ...params,
              scope: { ...params.scope, authorityId: 'local-desktop' },
            },
            { caller: gitCaller },
          ),
        ).resolves.toMatchObject({ defaultBranch: 'main' });
        expect(reads).toHaveBeenCalledTimes(1);
        resolveRepository.mockClear();
        reads.mockClear();
      }
    } finally {
      await spied.shutdown();
    }
  });

  it('refuses app-managed and invalid scopes with typed codes', async () => {
    for (const workspaceId of [
      CODE_REVIEW_CHAT_PROJECT_ID,
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
    ])
      await expect(
        runtime.query('worker.git.branch.list', checkout(workspaceId), {
          caller: gitCaller,
        }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'worker.git.branch.scopeUnsupported',
        },
      });
    for (const params of [
      checkout('Bad'),
      checkout('pure-ws', 'Bad'),
      {
        scope: { workspaceId: 'pure-ws', worktreeId: 'wt-01', repoId: 'Bad' },
        repository: { kind: 'checkout' },
      },
    ] satisfies WorkerGitBranchListParams[])
      await expect(
        runtime.query('worker.git.branch.list', params, { caller: gitCaller }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          code: 'worker.git.branch.invalidScope',
        },
      });
  });

  it('serves the workspace reference repository, and none for a multi-repo workspace without a source', async () => {
    await expect(
      runtime.query(
        'worker.git.branch.list',
        {
          scope: { workspaceId: 'home-ws' },
          repository: { kind: 'reference' },
        },
        { caller: gitCaller },
      ),
    ).resolves.toMatchObject({
      branches: [
        expect.objectContaining({ name: 'main', isCurrent: true }),
        expect.objectContaining({ name: 'develop', isRemote: true }),
        expect.objectContaining({ name: 'wt-01', isUsedByWorktree: true }),
      ],
    });
    await expect(
      runtime.query(
        'worker.git.branch.list',
        {
          scope: { workspaceId: 'no-source-ws' },
          repository: { kind: 'reference' },
        },
        { caller: gitCaller },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.branch.repositoryUnavailable',
      },
    });
    await expect(
      listHomeBranchTargets(runtime, caller, { workspaceId: 'no-source-ws' }),
    ).resolves.toEqual({ supported: false, branches: [], defaultBranch: null });
  });

  it('rejects a cyclic code-review registry entry instead of looping', async () => {
    await registerCodeReviewTarget('loop-ws--wt-01', {
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'loop-ws--wt-01',
    });
    await expect(
      listWorktreeBranches(runtime, caller, {
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'loop-ws--wt-01',
      }),
    ).rejects.toThrow('cyclic worktree target');
  });

  it('rethrows the original Git failure through the projection', async () => {
    const failure = await listWorktreeBranches(runtime, caller, {
      projectId: 'pure-ws',
      worktreeId: 'missing-wt',
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'ENOENT' });
  });
});
