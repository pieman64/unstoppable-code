// `worker.git.worktree.health.get` on the desktop dispatcher over real
// checkouts: the query is pure and path-free, and only the IPC projection
// records the result and returns the legacy response.
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
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import type { WorkerGitWorktreeHealthHost } from '@canopy/core-runtime/node/git';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  desktopWorkerGitWorktreeHealthHost,
  type DesktopHealthWorktree,
} from '../worker-git-adapter';
import { checkWorktreeHealth } from '../worker-git-dispatch';
import { registerCodeReviewTarget } from '../../lib/code-review-registry';
import { getSharedContainerRunRootDir } from '../../lib/paths';
import { registerPlanExploreTarget } from '../../lib/plan-explore-registry';

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

const ANY_STRING: unknown = expect.any(String);
const SINGLE_WS = 'single-ws';
const MULTI_WS = 'multi-ws';

let dir: string;
let dataDir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;

/** What the counting host saw, in order. */
const seen: Array<{ method: string; grants?: readonly string[] }> = [];
const countingHost: WorkerGitWorktreeHealthHost<DesktopHealthWorktree> = {
  ...desktopWorkerGitWorktreeHealthHost,
  resolveWorktree: (params, context: CanopyHandlerContext) => {
    seen.push({ method: 'resolveWorktree', grants: context.caller.grants });
    return desktopWorkerGitWorktreeHealthHost.resolveWorktree(params, context);
  },
};

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

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'git@example.com']);
  git(path, ['config', 'user.name', 'Git']);
  writeFileSync(join(path, 'README.md'), 'readme\n');
  git(path, ['add', '.']);
  git(path, ['commit', '-q', '-m', 'initial']);
}

function worktreeDir(workspaceId: string, worktreeId: string): string {
  return join(dataDir, 'workspaces', workspaceId, 'worktrees', worktreeId);
}

function worktreesFile(workspaceId: string): string {
  return join(dataDir, 'workspaces', workspaceId, 'worktrees.json');
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-git-health-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;

  const repo = join(dir, 'clones', 'single');
  initRepo(repo);
  git(repo, [
    'worktree',
    'add',
    '-q',
    '--detach',
    worktreeDir(SINGLE_WS, 'ok'),
  ]);
  const member = join(dir, 'clones', 'member');
  initRepo(member);
  mkdirSync(worktreeDir(MULTI_WS, 'partial'), { recursive: true });
  git(member, [
    'worktree',
    'add',
    '-q',
    '--detach',
    join(worktreeDir(MULTI_WS, 'partial'), 'repos', 'member'),
  ]);
  mkdirSync(join(worktreeDir(MULTI_WS, 'partial'), 'repos', 'notes'));

  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      { id: SINGLE_WS, type: 'single-repo' },
      { id: MULTI_WS, type: 'multi-repo' },
    ].map((entry, order) => ({
      ...entry,
      name: entry.id,
      color: '#38BDF8',
      collapsed: false,
      order,
    })),
  });
  writeJson(join(dataDir, 'workspaces', SINGLE_WS, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repo,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', MULTI_WS, 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [
      { id: 'member', name: 'Member', repoPath: member },
      { id: 'absent', name: 'Absent', repoPath: member },
    ],
  });
  runtime = createDesktopRuntime({ workerGitWorktreeHealthHost: countingHost });
});

beforeEach(async () => {
  seen.length = 0;
  for (const [workspaceId, ids] of [
    [SINGLE_WS, ['ok', 'gone']],
    [MULTI_WS, ['partial']],
  ] as const)
    writeJson(worktreesFile(workspaceId), {
      version: 1,
      worktrees: ids.map((id) => ({
        id,
        branchName: id,
        createdAt: '2026-10-26T00:00:00.000Z',
      })),
    });
  await registerCodeReviewTarget(`${SINGLE_WS}--gone`, {
    projectId: SINGLE_WS,
    worktreeId: 'gone',
  });
});

afterAll(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

function storedJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to fail');
}

function operationError(error: unknown): {
  kind: string;
  code: string | undefined;
} {
  if (!(error instanceof CanopyOperationError)) throw error;
  return { kind: error.payload.kind, code: error.payload.code };
}

const query = (
  scope: Record<string, string | undefined>,
  queryCaller: CanopyCallerDescriptor = gitCaller,
): Promise<unknown> =>
  runtime.query(
    'worker.git.worktree.health.get',
    // Malformed scopes are part of what these cases check.
    { scope: { workspaceId: '', worktreeId: '', ...scope } },
    { caller: queryCaller },
  );

describe('worker.git.worktree.health.get on the desktop dispatcher', () => {
  it('answers with ids and codes only and records nothing', async () => {
    const before = [SINGLE_WS, MULTI_WS].map((id) =>
      readFileSync(worktreesFile(id), 'utf8'),
    );
    await expect(
      query({ workspaceId: SINGLE_WS, worktreeId: 'ok' }),
    ).resolves.toEqual({ healthy: true });
    const gone = await query({ workspaceId: SINGLE_WS, worktreeId: 'gone' });
    expect(gone).toEqual({
      healthy: false,
      issue: {
        code: 'missing-worktree-path',
        checkedAt: ANY_STRING,
        repoIssues: null,
      },
    });
    const partial = await query({
      workspaceId: MULTI_WS,
      worktreeId: 'partial',
    });
    // Untracked: no includedRepoIds, so repos/notes is checked too.
    expect(partial).toEqual({
      healthy: false,
      issue: {
        code: 'missing-repository',
        checkedAt: ANY_STRING,
        repoIssues: [
          { repoId: 'absent', code: 'missing-repository' },
          { repoId: 'notes', code: 'missing-git-metadata' },
        ],
      },
    });
    for (const result of [gone, partial])
      expect(JSON.stringify(result)).not.toContain(dir);
    expect(
      [SINGLE_WS, MULTI_WS].map((id) =>
        readFileSync(worktreesFile(id), 'utf8'),
      ),
    ).toEqual(before);
  });

  it('skips untracked payload directories for a tracked worktree', async () => {
    writeJson(worktreesFile(MULTI_WS), {
      version: 1,
      worktrees: [
        {
          id: 'partial',
          branchName: 'partial',
          createdAt: '2026-10-26T00:00:00.000Z',
          includedRepoIds: ['member'],
        },
      ],
    });
    await expect(
      query({ workspaceId: MULTI_WS, worktreeId: 'partial' }),
    ).resolves.toEqual({ healthy: true });
  });

  it('refuses another authority or any target before resolving the worktree', async () => {
    for (const selection of [
      { authorityId: 'remote-desktop' },
      { targetId: 'in_process_worker' },
    ])
      expect(
        operationError(
          await failure(
            query({ workspaceId: SINGLE_WS, worktreeId: 'ok', ...selection }),
          ),
        ),
      ).toEqual({ kind: 'capability_unavailable', code: undefined });
    expect(seen).toEqual([]);
  });

  it('denies a caller without worker.git.read before the handler runs', async () => {
    expect(
      operationError(
        await failure(
          query({ workspaceId: SINGLE_WS, worktreeId: 'ok' }, caller),
        ),
      ).kind,
    ).toBe('permission_denied');
    expect(seen).toEqual([]);
  });

  it('types invalid and app-managed scopes', async () => {
    for (const scope of [
      { workspaceId: 'Bad', worktreeId: 'ok' },
      { workspaceId: SINGLE_WS, worktreeId: '../escape' },
    ])
      expect(operationError(await failure(query(scope)))).toEqual({
        kind: 'invalid_argument',
        code: 'worker.git.worktree.invalidScope',
      });
    for (const workspaceId of [
      CODE_REVIEW_CHAT_PROJECT_ID,
      PLAN_EXPLORE_CHAT_PROJECT_ID,
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
    ])
      expect(
        operationError(
          await failure(query({ workspaceId, worktreeId: 'scope' })),
        ),
      ).toEqual({
        kind: 'failed_precondition',
        code: 'worker.git.worktree.scopeUnsupported',
      });
    // Malformed params never reach the host.
    for (const scope of [{ workspaceId: SINGLE_WS }, { repoId: 'member' }])
      expect(
        operationError(
          await failure(
            runtime.query(
              'worker.git.worktree.health.get',
              // @ts-expect-error -- malformed on purpose
              { scope },
              { caller: gitCaller },
            ),
          ),
        ).kind,
      ).toBe('invalid_argument');
  });
});

describe('the worktree:health-check projection', () => {
  it('dispatches with only worker.git.read and records the legacy issue', async () => {
    const response = await checkWorktreeHealth(runtime, () => caller, {
      projectId: SINGLE_WS,
      worktreeId: 'gone',
    });
    expect(seen).toEqual([
      { method: 'resolveWorktree', grants: [WORKER_GIT_GRANTS.read] },
    ]);
    expect(response).toMatchObject({
      healthy: false,
      issue: {
        code: 'missing-worktree-path',
        worktreePath: worktreeDir(SINGLE_WS, 'gone'),
      },
    });
    const stored: unknown = JSON.parse(
      readFileSync(worktreesFile(SINGLE_WS), 'utf8'),
    );
    expect(stored).toMatchObject({
      worktrees: [
        { id: 'ok' },
        // Stored as JSON, which drops the undefined properties.
        { id: 'gone', healthIssue: storedJson(response.issue) },
      ],
    });
  });

  it('keeps each concurrent call to its own capture', async () => {
    const [ok, gone, partial] = await Promise.all([
      checkWorktreeHealth(runtime, () => caller, {
        projectId: SINGLE_WS,
        worktreeId: 'ok',
      }),
      checkWorktreeHealth(runtime, () => caller, {
        projectId: SINGLE_WS,
        worktreeId: 'gone',
      }),
      checkWorktreeHealth(runtime, () => caller, {
        projectId: MULTI_WS,
        worktreeId: 'partial',
      }),
    ]);
    expect(ok).toMatchObject({ healthy: true, worktree: { id: 'ok' } });
    expect(ok.issue).toBeUndefined();
    expect(gone.issue?.worktreePath).toBe(worktreeDir(SINGLE_WS, 'gone'));
    expect(partial.issue?.worktreePath).toBe(worktreeDir(MULTI_WS, 'partial'));
    expect(seen).toHaveLength(3);
  });

  it('dispatches a registry-backed chat scope as the real worktree and records its row', async () => {
    const response = await checkWorktreeHealth(runtime, () => caller, {
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: `${SINGLE_WS}--gone`,
    });
    expect(seen).toEqual([
      { method: 'resolveWorktree', grants: [WORKER_GIT_GRANTS.read] },
    ]);
    expect(response).toMatchObject({
      healthy: false,
      worktree: { id: 'gone' },
      issue: { code: 'missing-worktree-path' },
    });
    const stored: unknown = JSON.parse(
      readFileSync(worktreesFile(SINGLE_WS), 'utf8'),
    );
    expect(stored).toMatchObject({
      worktrees: [
        { id: 'ok' },
        { id: 'gone', healthIssue: storedJson(response.issue) },
      ],
    });
    expect(existsSync(worktreesFile(CODE_REVIEW_CHAT_PROJECT_ID))).toBe(false);
  });

  it("judges a plan-explore scope by the real workspace's includedRepoIds", async () => {
    writeJson(worktreesFile(MULTI_WS), {
      version: 1,
      worktrees: [
        {
          id: 'partial',
          branchName: 'partial',
          createdAt: '2026-10-26T00:00:00.000Z',
          includedRepoIds: ['member'],
        },
      ],
    });
    await registerPlanExploreTarget('plan-partial', {
      projectId: MULTI_WS,
      worktreeId: 'partial',
    });
    // The chat scope has no configuration: today's check judged it with every
    // repos/ directory expected, reporting repos/notes.
    await expect(
      checkWorktreeHealth(runtime, () => caller, {
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-partial',
      }),
    ).resolves.toMatchObject({ healthy: true, worktree: { id: 'partial' } });
    expect(existsSync(worktreesFile(PLAN_EXPLORE_CHAT_PROJECT_ID))).toBe(false);
  });

  it('keeps a borrowed shared-container run directory on the direct check, unrecorded', async () => {
    initRepo(getSharedContainerRunRootDir('run-01'));
    await registerCodeReviewTarget('viewer--run', {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'run-01',
    });
    const staleRow = {
      id: 'viewer--run',
      branchName: 'viewer--run',
      createdAt: '2026-10-26T00:00:00.000Z',
      healthIssue: { status: 'broken', code: 'missing-worktree-path' },
    };
    writeJson(worktreesFile(CODE_REVIEW_CHAT_PROJECT_ID), {
      version: 1,
      worktrees: [staleRow],
    });
    const before = readFileSync(
      worktreesFile(CODE_REVIEW_CHAT_PROJECT_ID),
      'utf8',
    );
    const response = await checkWorktreeHealth(
      runtime,
      () => {
        throw new Error('The direct check resolved the caller');
      },
      { projectId: CODE_REVIEW_CHAT_PROJECT_ID, worktreeId: 'viewer--run' },
    );
    expect(seen).toEqual([]);
    expect(response).toMatchObject({
      healthy: true,
      worktree: { id: 'viewer--run' },
    });
    expect(response.worktree.healthIssue).toBeUndefined();
    expect(
      readFileSync(worktreesFile(CODE_REVIEW_CHAT_PROJECT_ID), 'utf8'),
    ).toBe(before);
    rmSync(join(dataDir, 'workspaces', CODE_REVIEW_CHAT_PROJECT_ID), {
      recursive: true,
      force: true,
    });
  });

  it('keeps ids longer than a canonical scope on the direct check', async () => {
    const response = await checkWorktreeHealth(runtime, () => caller, {
      projectId: SINGLE_WS,
      worktreeId: 'w'.repeat(513),
    });
    expect(seen).toEqual([]);
    expect(response).toMatchObject({
      healthy: false,
      issue: { code: 'missing-worktree-path' },
    });
  });

  it('dispatches the pseudo scopes that have their own homes', async () => {
    await checkWorktreeHealth(runtime, () => caller, {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'home',
    });
    expect(seen).toHaveLength(1);
  });

  it('refuses the read-only viewer and invalid identifiers before dispatch', async () => {
    for (const request of [
      { projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID, worktreeId: 'x' },
      { projectId: 'Bad', worktreeId: 'ok' },
      { projectId: SINGLE_WS, worktreeId: '' },
    ])
      await expect(
        checkWorktreeHealth(runtime, () => caller, request),
      ).rejects.toThrow(Error);
    expect(seen).toEqual([]);
  });

  it('resolves the caller only after the scope checks, and only to dispatch', async () => {
    const resolved: string[] = [];
    const untracked = (): CanopyCallerDescriptor => {
      resolved.push('caller');
      throw new Error('Untrusted desktop IPC sender.');
    };
    await expect(
      checkWorktreeHealth(runtime, untracked, {
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: 'x',
      }),
    ).rejects.toThrow('Shared-container recipient workspaces are read-only');
    await expect(
      checkWorktreeHealth(runtime, untracked, {
        projectId: SINGLE_WS,
        worktreeId: '',
      }),
    ).rejects.toThrow('Invalid worktreeId');
    // An unregistered chat scope fails on the registry before the caller.
    await expect(
      checkWorktreeHealth(runtime, untracked, {
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'unregistered--scope',
      }),
    ).rejects.toThrow(
      'No code-review target registered for scope unregistered--scope',
    );
    expect(resolved).toEqual([]);
    for (const request of [
      { projectId: SINGLE_WS, worktreeId: 'gone' },
      {
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: `${SINGLE_WS}--gone`,
      },
    ])
      await expect(
        checkWorktreeHealth(runtime, untracked, request),
      ).rejects.toThrow('Untrusted desktop IPC sender.');
    expect(resolved).toEqual(['caller', 'caller']);
    expect(seen).toEqual([]);
    expect(readFileSync(worktreesFile(SINGLE_WS), 'utf8')).not.toContain(
      'healthIssue',
    );
  });

  it('rethrows the host error itself', async () => {
    const hostFailure = new Error('records unreadable');
    const failing = createDesktopRuntime({
      workerGitWorktreeHealthHost: {
        ...desktopWorkerGitWorktreeHealthHost,
        sources: (worktree, context) => ({
          ...desktopWorkerGitWorktreeHealthHost.sources(worktree, context),
          readWorkspace: (): Promise<never> => Promise.reject(hostFailure),
        }),
      },
    });
    try {
      await expect(
        checkWorktreeHealth(failing, () => caller, {
          projectId: SINGLE_WS,
          worktreeId: 'ok',
        }),
      ).rejects.toBe(hostFailure);
      expect(
        operationError(
          await failure(
            failing.query(
              'worker.git.worktree.health.get',
              { scope: { workspaceId: SINGLE_WS, worktreeId: 'ok' } },
              { caller: gitCaller },
            ),
          ),
        ).kind,
      ).toBe('internal');
    } finally {
      await failing.shutdown();
    }
  });
});
