// CAN-4070 rule: captured on the unchanged `worktree:list-branches` and
// `home:list-branch-targets` IPC handlers before CAN-4107 routed them through
// `worker.git.branch.list`. Real data root, workspace records, registries,
// Git checkouts, bare origins and default-branch freshness file; only IPC
// registration is mocked.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  decodeCanopyError,
  encodeCanopyError,
  WorkerGitBranchListParamsSchema,
  type CanopyCallerDescriptor,
  type WorkerGitBranchListParams,
  type WorkerGitBranchListResult,
} from '@canopy/protocol/canopy-core';
import {
  CanopyClientError,
  type CanopyClientQueryOptions,
} from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import { createGitReadHost } from '@canopy/core-platform';
import {
  createRecordedWorkerGitHosts,
  createWorkerGitBranchListHandlers,
  type GitRepositoryRead,
} from '@canopy/core-runtime/node/git';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

import { registerWorktreeHandlers } from '../ipc/worktrees';
import { registerHomeSurfaceHandlers } from '../ipc/home-surface';
import { recordGitDefaultBranch } from '../lib/git-default-branch-freshness';
import { DEFAULT_BRANCH_FRESHNESS_TTL_MS } from '../lib/git-default-branch';
import { registerCodeReviewTarget } from '../lib/code-review-registry';
import { registerPlanExploreTarget } from '../lib/plan-explore-registry';
import { getSharedContainerRunRootDir } from '../lib/paths';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import {
  createDaemonGitRoute,
  type DaemonGitRoute,
  type DaemonGitRouteOptions,
} from '../canopy-runtime/daemon-git-route';
import { createElectronDaemonCallerLifetime } from '../canopy-runtime/electron-daemon-caller-lifetime';
import { FakeSender } from '../canopy-runtime/__tests__/daemon-files-route-harness';
import * as gitHelpers from '../lib/git';
import * as defaultBranchHelpers from '../lib/git-default-branch';
import * as freshnessStore from '../lib/git-default-branch-freshness';
import { READ_ROUTE_TABLE } from '../canopy-runtime/daemon-read-route-guard';

jest.setTimeout(120_000);

let dir: string;
let dataDir: string;
let originalDataDir: string | undefined;

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

function workspaceDir(id: string): string {
  return join(dataDir, 'workspaces', id);
}

function worktreeDir(workspaceId: string, worktreeId: string): string {
  return join(workspaceDir(workspaceId), 'worktrees', worktreeId);
}

function commit(path: string, file: string): void {
  writeFileSync(join(path, file), `${file}\n`);
  git(path, ['add', '.']);
  git(path, ['commit', '-q', '-m', file]);
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'golden@example.com']);
  git(path, ['config', 'user.name', 'Golden']);
  commit(path, 'README.md');
}

/** A bare origin with main, develop and release; its HEAD names main. */
function createOrigin(name: string): string {
  const seed = join(dir, 'seeds', name);
  initRepo(seed);
  git(seed, ['branch', 'develop']);
  git(seed, ['branch', 'release']);
  const origin = join(dir, 'origins', `${name}.git`);
  mkdirSync(join(origin, '..'), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], {
    stdio: 'pipe',
  });
  return origin;
}

function cloneOrigin(origin: string, name: string): string {
  const path = join(dir, 'clones', name);
  mkdirSync(join(path, '..'), { recursive: true });
  execFileSync('git', ['clone', '-q', origin, path], { stdio: 'pipe' });
  git(path, ['config', 'user.email', 'golden@example.com']);
  git(path, ['config', 'user.name', 'Golden']);
  return path;
}

function originHead(repo: string): string {
  try {
    return git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  } catch {
    return '(unset)';
  }
}

async function seedFreshness(
  repo: string,
  defaultBranch: string,
  resolvedAt: number,
): Promise<void> {
  await recordGitDefaultBranch({
    identity: {
      commonDir: realpathSync(join(repo, '.git')),
      originUrl: git(repo, ['remote', 'get-url', 'origin']),
    },
    defaultBranch,
    resolvedAt,
  });
}

function workspaceEntry(id: string, type: string, order: number): object {
  return { id, name: id, type, color: '#38BDF8', collapsed: false, order };
}

function writeWorktrees(workspaceId: string, ids: string[]): void {
  writeJson(join(workspaceDir(workspaceId), 'worktrees.json'), {
    version: 1,
    worktrees: ids.map((id) => ({
      id,
      branchName: id,
      createdAt: '2026-10-26T00:00:00.000Z',
    })),
  });
}

function addSingleRepoWorkspace(id: string, repo: string): void {
  writeJson(join(workspaceDir(id), 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repo,
    repos: [],
  });
}

const FRESH_WS = 'fresh-ws';
const STALE_WS = 'stale-ws';
const REPAIR_WS = 'repair-ws';
const OFFLINE_WS = 'offline-ws';
const OFFLINE_STALE_WS = 'offline-stale-ws';
const OFFLINE_CONVENTIONAL_WS = 'offline-conventional-ws';
const NO_ORIGIN_WS = 'no-origin-ws';
const MULTI_WS = 'multi-ws';
const MULTI_NO_SOURCE_WS = 'multi-no-source-ws';
const COWORK_WS = 'cowork-ws';
const WORKTREE = 'feature-01';
const OTHER_WORKTREE = 'feature-02';
const CONTAINER = 'container-01';

const repos: Record<string, string> = {};
const origins: Record<string, string> = {};
let freshnessPath: string;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-branch-list-golden-')));
  dataDir = join(dir, 'data');
  freshnessPath = join(dataDir, 'git-default-branch-freshness.json');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;

  for (const id of [
    FRESH_WS,
    STALE_WS,
    REPAIR_WS,
    OFFLINE_WS,
    OFFLINE_STALE_WS,
    OFFLINE_CONVENTIONAL_WS,
    MULTI_WS,
  ]) {
    origins[id] = createOrigin(id);
    repos[id] = cloneOrigin(origins[id], id);
  }
  // A fetched branch that exists only on the remote, plus a local-only one.
  git(join(dir, 'seeds', FRESH_WS), ['branch', 'remote-only']);
  git(join(dir, 'seeds', FRESH_WS), [
    'push',
    '-q',
    origins[FRESH_WS],
    'remote-only',
  ]);
  git(repos[FRESH_WS], ['fetch', '-q', 'origin']);
  git(repos[FRESH_WS], ['branch', 'local-only']);
  git(repos[FRESH_WS], [
    'worktree',
    'add',
    '-q',
    '-b',
    WORKTREE,
    worktreeDir(FRESH_WS, WORKTREE),
  ]);
  git(repos[FRESH_WS], [
    'worktree',
    'add',
    '-q',
    '-b',
    OTHER_WORKTREE,
    worktreeDir(FRESH_WS, OTHER_WORKTREE),
  ]);
  for (const id of [
    STALE_WS,
    REPAIR_WS,
    OFFLINE_WS,
    OFFLINE_STALE_WS,
    OFFLINE_CONVENTIONAL_WS,
  ])
    git(repos[id], [
      'worktree',
      'add',
      '-q',
      '-b',
      WORKTREE,
      worktreeDir(id, WORKTREE),
    ]);

  // Stale and divergent local origin/HEAD knowledge.
  git(repos[STALE_WS], ['remote', 'set-head', 'origin', 'develop']);
  git(repos[REPAIR_WS], ['remote', 'set-head', 'origin', 'develop']);
  // Offline: origin points at a missing repository.
  for (const id of [OFFLINE_WS, OFFLINE_STALE_WS, OFFLINE_CONVENTIONAL_WS])
    git(repos[id], [
      'remote',
      'set-url',
      'origin',
      join(dir, 'origins', 'missing.git'),
    ]);
  git(repos[OFFLINE_STALE_WS], ['remote', 'set-head', 'origin', '-d']);
  git(repos[OFFLINE_CONVENTIONAL_WS], ['remote', 'set-head', 'origin', '-d']);

  repos[NO_ORIGIN_WS] = join(dir, 'clones', NO_ORIGIN_WS);
  initRepo(repos[NO_ORIGIN_WS]);
  git(repos[NO_ORIGIN_WS], ['branch', 'topic']);
  git(repos[NO_ORIGIN_WS], [
    'worktree',
    'add',
    '-q',
    '-b',
    WORKTREE,
    worktreeDir(NO_ORIGIN_WS, WORKTREE),
  ]);

  // Multi-repo: a source-backed root checkout and one member checkout.
  const memberOrigin = createOrigin('member');
  repos.member = cloneOrigin(memberOrigin, 'member');
  git(repos[MULTI_WS], [
    'worktree',
    'add',
    '-q',
    '-b',
    WORKTREE,
    worktreeDir(MULTI_WS, WORKTREE),
  ]);
  git(repos.member, [
    'worktree',
    'add',
    '-q',
    '-b',
    WORKTREE,
    join(worktreeDir(MULTI_WS, WORKTREE), 'repos', 'member'),
  ]);

  // A shared-container viewer run directory holding its own checkout.
  initRepo(getSharedContainerRunRootDir(CONTAINER));
  git(getSharedContainerRunRootDir(CONTAINER), ['branch', 'shared-topic']);

  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      ...[
        FRESH_WS,
        STALE_WS,
        REPAIR_WS,
        OFFLINE_WS,
        OFFLINE_STALE_WS,
        OFFLINE_CONVENTIONAL_WS,
        NO_ORIGIN_WS,
      ].map((id, order) => workspaceEntry(id, 'single-repo', order)),
      workspaceEntry(MULTI_WS, 'multi-repo', 20),
      workspaceEntry(MULTI_NO_SOURCE_WS, 'multi-repo', 21),
      workspaceEntry(COWORK_WS, 'cowork', 22),
    ],
  });
  for (const id of [
    FRESH_WS,
    STALE_WS,
    REPAIR_WS,
    OFFLINE_WS,
    OFFLINE_STALE_WS,
    OFFLINE_CONVENTIONAL_WS,
    NO_ORIGIN_WS,
  ]) {
    addSingleRepoWorkspace(id, repos[id]);
    writeWorktrees(
      id,
      id === FRESH_WS ? [WORKTREE, OTHER_WORKTREE] : [WORKTREE],
    );
  }
  writeJson(join(workspaceDir(MULTI_WS), 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: repos[MULTI_WS],
    repos: [{ id: 'member', name: 'member', repoPath: repos.member }],
  });
  writeWorktrees(MULTI_WS, [WORKTREE]);
  writeJson(join(workspaceDir(MULTI_NO_SOURCE_WS), 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [{ id: 'member', name: 'member', repoPath: repos.member }],
  });
  writeJson(join(workspaceDir(COWORK_WS), 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
  });

  const now = Date.now();
  await seedFreshness(repos[FRESH_WS], 'develop', now - 1_000);
  const stale = now - DEFAULT_BRANCH_FRESHNESS_TTL_MS - 60_000;
  await seedFreshness(repos[STALE_WS], 'release', stale);
  await seedFreshness(repos[OFFLINE_STALE_WS], 'release', stale);

  await registerCodeReviewTarget(`${FRESH_WS}--${WORKTREE}`, {
    projectId: FRESH_WS,
    worktreeId: WORKTREE,
  });
  await registerPlanExploreTarget('plan-01', {
    projectId: MULTI_WS,
    worktreeId: WORKTREE,
  });

  registerHandlers();
});

// The grants every desktop IPC caller carries (desktop-ipc-caller.ts).
const desktopCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [
    'worker.filesystem.read',
    'core.workspace.read',
    'core.chat.read',
    'core.chat.write',
    'core.worktree.read',
  ],
};

let runtime: DesktopCanopyDispatcher | undefined;

function registerHandlers(
  daemonGitRoute?: () => DaemonGitRoute,
  unusedGit = false,
): void {
  const unused = (): never => {
    throw new Error('The direct Git runtime was touched.');
  };
  runtime = createDesktopRuntime(
    unusedGit
      ? {
          workerGitHost: {
            authorityId: desktopCaller.authorityId,
            resolveRepository: unused,
            reads: unused,
            now: unused,
          },
        }
      : {},
  );
  const accessors = {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
    ...(daemonGitRoute && { daemonGitRoute }),
  };
  registerWorktreeHandlers(() => null, accessors);
  registerHomeSurfaceHandlers(accessors);
}

afterAll(async () => {
  await runtime?.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function scrub(value: string): string {
  return value
    .split(dir)
    .join('<root>')
    .replace(ISO, '<time>')
    .replace(/spawn \S+ ENOENT/g, 'spawn <git> ENOENT');
}

// Child-process errors come from another Jest realm, so read their fields
// instead of relying on `instanceof Error`.
function describeError(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null)
    return { thrown: String(error) };
  const code: unknown = Reflect.get(error, 'code');
  return {
    name: String(Reflect.get(error, 'name')),
    message: scrub(String(Reflect.get(error, 'message'))),
    ...(typeof code === 'string' ? { code } : {}),
  };
}

type Outcome = { result: unknown } | { error: Record<string, unknown> };

async function ipc(channel: string, request: unknown): Promise<Outcome> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  try {
    const event = { sender: routeSender };
    return { result: await handler(event, request) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

const routeSender = new FakeSender(1);

function freshnessBytes(): string {
  return existsSync(freshnessPath) ? readFileSync(freshnessPath, 'utf8') : '';
}

/** The freshness file with entry keys checked against their identity. */
function freshnessEntries(): unknown {
  const text = freshnessBytes();
  if (!text) return null;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  const version: unknown = Reflect.get(parsed, 'version');
  const entries: unknown = Reflect.get(parsed, 'entries');
  if (typeof entries !== 'object' || entries === null) return parsed;
  return {
    version,
    entries: Object.entries(entries)
      .map(([key, value]: [string, unknown]) => {
        if (typeof value !== 'object' || value === null) return { key, value };
        const commonDir: unknown = Reflect.get(value, 'commonDir');
        const originHash: unknown = Reflect.get(value, 'originHash');
        const defaultBranch: unknown = Reflect.get(value, 'defaultBranch');
        return {
          keyMatchesCommonDir:
            typeof commonDir === 'string' &&
            key === createHash('sha256').update(commonDir).digest('hex'),
          commonDir: typeof commonDir === 'string' ? scrub(commonDir) : null,
          originHashLength:
            typeof originHash === 'string' ? originHash.length : null,
          defaultBranch,
          resolvedAt: scrub(String(Reflect.get(value, 'resolvedAt'))),
        };
      })
      .sort((left, right) =>
        String(left.commonDir).localeCompare(String(right.commonDir)),
      ),
  };
}

/** One IPC call with the default-branch effects it left behind. */
async function observe(
  channel: string,
  request: unknown,
  repo?: string,
): Promise<Record<string, unknown>> {
  const before = freshnessBytes();
  const beforeHead = repo ? originHead(repo) : undefined;
  const outcome = await ipc(channel, request);
  return {
    outcome,
    freshnessFileChanged: freshnessBytes() !== before,
    ...(repo
      ? { originHeadBefore: beforeHead, originHeadAfter: originHead(repo) }
      : {}),
  };
}

const listBranches = (
  request: unknown,
  repo?: string,
): Promise<Record<string, unknown>> =>
  observe(IPC_CHANNELS.worktreeListBranches, request, repo);
const branchTargets = (
  request: unknown,
  repo?: string,
): Promise<Record<string, unknown>> =>
  observe(IPC_CHANNELS.homeListBranchTargets, request, repo);

describe('worktree:list-branches', () => {
  it('serves a fresh stored default without a remote lookup or write', async () => {
    expect(
      await listBranches(
        { projectId: FRESH_WS, worktreeId: WORKTREE },
        repos[FRESH_WS],
      ),
    ).toMatchSnapshot();
  });

  it('revalidates a stale stored default, records it and repairs origin/HEAD', async () => {
    expect(
      await listBranches(
        { projectId: STALE_WS, worktreeId: WORKTREE },
        repos[STALE_WS],
      ),
    ).toMatchSnapshot();
    expect(freshnessEntries()).toMatchSnapshot('freshness after revalidation');
    // The recorded value is now fresh: a changed remote HEAD is not consulted.
    git(origins[STALE_WS], ['symbolic-ref', 'HEAD', 'refs/heads/develop']);
    expect(
      await listBranches(
        { projectId: STALE_WS, worktreeId: WORKTREE },
        repos[STALE_WS],
      ),
    ).toMatchSnapshot('after the record');
  });

  it('records a remote default without stored knowledge and repairs origin/HEAD', async () => {
    expect(
      await listBranches(
        { projectId: REPAIR_WS, worktreeId: WORKTREE },
        repos[REPAIR_WS],
      ),
    ).toMatchSnapshot();
  });

  it('falls back offline to local origin/HEAD, a stale value, then conventional refs', async () => {
    expect(
      await listBranches(
        { projectId: OFFLINE_WS, worktreeId: WORKTREE },
        repos[OFFLINE_WS],
      ),
    ).toMatchSnapshot('local origin/HEAD');
    expect(
      await listBranches(
        { projectId: OFFLINE_STALE_WS, worktreeId: WORKTREE },
        repos[OFFLINE_STALE_WS],
      ),
    ).toMatchSnapshot('stale stored value');
    expect(
      await listBranches(
        { projectId: OFFLINE_CONVENTIONAL_WS, worktreeId: WORKTREE },
        repos[OFFLINE_CONVENTIONAL_WS],
      ),
    ).toMatchSnapshot('conventional refs');
  });

  it('lists a repository without origin and no default branch', async () => {
    expect(
      await listBranches(
        { projectId: NO_ORIGIN_WS, worktreeId: WORKTREE },
        repos[NO_ORIGIN_WS],
      ),
    ).toMatchSnapshot();
  });

  it('selects multi-repo checkouts by repository id', async () => {
    for (const repoId of [
      undefined,
      WORKSPACE_ROOT_REPO_ID,
      'member',
      'absent',
    ])
      expect(
        await listBranches({
          projectId: MULTI_WS,
          worktreeId: WORKTREE,
          ...(repoId === undefined ? {} : { repoId }),
        }),
      ).toMatchSnapshot(`repoId ${String(repoId)}`);
  });

  it('resolves registry-backed chat scopes to the real worktree', async () => {
    expect(
      await listBranches({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: `${FRESH_WS}--${WORKTREE}`,
      }),
    ).toMatchSnapshot('code review');
    expect(
      await listBranches({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: `${FRESH_WS}--${WORKTREE}`,
        repoId: WORKSPACE_ROOT_REPO_ID,
      }),
    ).toMatchSnapshot('code review workspace root');
    expect(
      await listBranches({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: `${FRESH_WS}--${WORKTREE}`,
        repoId: 'member',
      }),
    ).toMatchSnapshot('code review child repository');
    expect(
      await listBranches({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-01',
      }),
    ).toMatchSnapshot('plan explore');
    expect(
      await listBranches({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'unregistered--scope',
      }),
    ).toMatchSnapshot('unregistered code review');
    expect(
      await listBranches({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'unregistered-plan',
      }),
    ).toMatchSnapshot('unregistered plan explore');
  });

  it('lists a shared-container viewer run directory', async () => {
    expect(
      await listBranches({
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: CONTAINER,
      }),
    ).toMatchSnapshot();
  });

  it('keeps the failures of non-repository and unknown scopes', async () => {
    for (const request of [
      { projectId: COWORK_WS, worktreeId: 'home' },
      { projectId: 'ghost-ws', worktreeId: WORKTREE },
    ])
      expect(await listBranches(request)).toMatchSnapshot(request.projectId);
  });

  it('keeps identifier validation messages', async () => {
    for (const request of [
      { projectId: 'Bad', worktreeId: WORKTREE },
      { projectId: FRESH_WS, worktreeId: '' },
      { projectId: FRESH_WS, worktreeId: WORKTREE, repoId: 'Bad' },
      { projectId: FRESH_WS, worktreeId: WORKTREE, repoId: 42 },
    ])
      expect(await listBranches(request)).toMatchSnapshot(
        JSON.stringify(request),
      );
  });
});

describe('home:list-branch-targets', () => {
  it('reports the source branch state and clears it after an external first commit', async () => {
    const repo = repos[NO_ORIGIN_WS];
    const branch = 'unborn-home';
    git(repo, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    try {
      expect(
        await ipc(IPC_CHANNELS.homeListBranchTargets, {
          workspaceId: NO_ORIGIN_WS,
        }),
      ).toMatchObject({ result: { supported: true, headUnborn: true } });
      git(repo, [
        'commit',
        '--allow-empty',
        '-qm',
        'first commit on source branch',
      ]);
      expect(
        await ipc(IPC_CHANNELS.homeListBranchTargets, {
          workspaceId: NO_ORIGIN_WS,
        }),
      ).toMatchObject({ result: { supported: true, headUnborn: false } });
    } finally {
      git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      git(repo, ['branch', '-D', branch]);
    }
  });

  it('lists the reference repository of a single-repo workspace', async () => {
    expect(
      await branchTargets({ workspaceId: FRESH_WS }, repos[FRESH_WS]),
    ).toMatchSnapshot();
  });

  it('lists the source repository of a multi-repo workspace', async () => {
    expect(
      await branchTargets({ workspaceId: MULTI_WS }, repos[MULTI_WS]),
    ).toMatchSnapshot();
  });

  it('reports unsupported workspaces without a reference repository', async () => {
    for (const workspaceId of [MULTI_NO_SOURCE_WS, COWORK_WS, 'ghost-ws'])
      expect(await branchTargets({ workspaceId })).toMatchSnapshot(workspaceId);
  });

  it('keeps identifier validation messages', async () => {
    for (const workspaceId of ['Bad', '', 7])
      expect(await branchTargets({ workspaceId })).toMatchSnapshot(
        JSON.stringify(workspaceId),
      );
  });
});

// CAN-5501: the production adapter and IPC projections against the daemon's
// recorded Git host and fixed-command runner. Only the connection is in memory.
describe('daemon branch-list route equivalence', () => {
  const authorityId = 'authority-can-5501';
  const lifetime = createElectronDaemonCallerLifetime();
  const connection = new AbortController();
  const reads: GitRepositoryRead[] = [];
  const queryOptions: Array<CanopyClientQueryOptions | undefined> = [];
  const routes: DaemonGitRoute[] = [];
  let gitHost: ReturnType<typeof createGitReadHost>;
  let handlers: ReturnType<typeof createWorkerGitBranchListHandlers>;
  let branchHost: ReturnType<typeof createRecordedWorkerGitHosts>['branchList'];
  const query = jest.fn(
    async (
      _name: 'worker.git.branch.list',
      params: WorkerGitBranchListParams,
      options?: CanopyClientQueryOptions,
    ) => {
      queryOptions.push(options);
      try {
        return await handlers['worker.git.branch.list'](
          WorkerGitBranchListParamsSchema.parse(params),
          {
            requestId: 'route-test',
            caller: {
              ...desktopCaller,
              authorityId,
              grants: ['worker.git.read'],
            },
            signal: options?.signal ?? new AbortController().signal,
            metadata: options?.metadata ?? {},
            ...(options?.execution && { execution: options.execution }),
          },
        );
      } catch (error) {
        if (!(error instanceof CanopyOperationError)) throw error;
        throw new CanopyClientError(
          decodeCanopyError(
            JSON.parse(JSON.stringify(encodeCanopyError(error))),
          ),
        );
      }
    },
  );
  const hostContext = jest.fn(() => Promise.resolve({ authorityId }));
  const connections = jest.fn(() => ({
    get: (): Promise<{
      client: { signal: AbortSignal; query: typeof query };
    }> => Promise.resolve({ client: { signal: connection.signal, query } }),
  }));
  let executionSequence = 0;
  const execution = jest.fn(() => ({
    childEnvironment: {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      REQUEST: String(++executionSequence),
      PATH: process.env.PATH ?? '',
    },
  }));
  const routeFor = (
    overrides: Partial<DaemonGitRouteOptions> = {},
  ): DaemonGitRoute => {
    const route = createDaemonGitRoute({
      lifetime,
      hostContext,
      connections,
      workspaceType: () => 'single-repo',
      resolveWorktreeTargetIds: (projectId, worktreeId) => ({
        projectId,
        worktreeId,
      }),
      platform: 'darwin',
      selectable: new Set(['git.branch.list']),
      execution,
      ...overrides,
    });
    routes.push(route);
    return route;
  };
  const checkout: WorkerGitBranchListParams = {
    scope: { workspaceId: REPAIR_WS, worktreeId: WORKTREE },
    repository: { kind: 'checkout' },
  };
  const neverDirect = jest.fn(
    (): Promise<never> =>
      Promise.reject(new Error('Direct fallback was touched.')),
  );
  const list = (
    route: DaemonGitRoute,
    params = checkout,
    caller = desktopCaller,
  ): Promise<WorkerGitBranchListResult> =>
    route.branchList(params, { caller }, { sender: routeSender }, neverDirect);

  beforeAll(() => {
    // The same fixtures and records as the unchanged IPC golden above.
    gitHost = createGitReadHost({
      os: process.platform === 'linux' ? 'linux' : 'darwin',
      environment: process.env,
      probeDirectory: dir,
    });
    const hosts = createRecordedWorkerGitHosts({
      dataRoot: dataDir,
      authorityId,
      recordsTargetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      os: process.platform,
      arch: process.arch,
      git: {
        read: (read, cwd, invocation) => {
          reads.push(read);
          return gitHost.repository.readRepository({
            read,
            cwd,
            signal: invocation.signal,
            readSavedExecutablePath: () => Promise.resolve(''),
            ...(invocation.environment && {
              environment: invocation.environment,
            }),
          });
        },
        selectExecutable: (request) =>
          gitHost.repository.selectExecutable({
            ...request,
            readSavedExecutablePath: () => Promise.resolve(''),
          }),
      },
    });
    branchHost = hosts.branchList;
    handlers = createWorkerGitBranchListHandlers(branchHost);
  });
  afterAll(async () => {
    routes.forEach((route) => route.dispose());
    lifetime.disposeAll();
    await gitHost.stop(new AbortController().signal);
  });
  beforeEach(() => {
    query.mockClear();
    hostContext.mockClear();
    connections.mockClear();
    execution.mockClear();
    neverDirect.mockClear();
    reads.length = 0;
    queryOptions.length = 0;
  });

  it('keeps the legacy closed result and opts into verified source HEAD state', async () => {
    const route = routeFor();
    const params: WorkerGitBranchListParams = {
      scope: { workspaceId: NO_ORIGIN_WS },
      repository: { kind: 'reference' },
    };
    expect(await list(route, params)).not.toHaveProperty('headUnborn');
    expect(
      await list(route, { ...params, includeHeadState: true }),
    ).toHaveProperty('headUnborn', false);
    const repo = repos[NO_ORIGIN_WS];
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/unborn-daemon']);
    try {
      expect(
        await list(route, { ...params, includeHeadState: true }),
      ).toHaveProperty('headUnborn', true);
    } finally {
      git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
  });

  it('preserves the repositoryUnavailable code through the L0 error codec', () => {
    const error = new CanopyOperationError({
      kind: 'failed_precondition',
      code: 'worker.git.branch.repositoryUnavailable',
      message: 'The workspace has no source repository.',
      retry: { kind: 'never' },
    });
    const wire: unknown = JSON.parse(JSON.stringify(encodeCanopyError(error)));
    expect(decodeCanopyError(wire)).toEqual(error.payload);
    expect(
      new CanopyOperationError(decodeCanopyError(wire)).runtimeCause,
    ).toBeUndefined();
  });

  it('returns byte-identical checkout and reference IPC results without touching the direct runtime', async () => {
    const cases = [
      [
        IPC_CHANNELS.worktreeListBranches,
        { projectId: FRESH_WS, worktreeId: WORKTREE },
      ],
      [
        IPC_CHANNELS.worktreeListBranches,
        { projectId: MULTI_WS, worktreeId: WORKTREE },
      ],
      [
        IPC_CHANNELS.worktreeListBranches,
        {
          projectId: MULTI_WS,
          worktreeId: WORKTREE,
          repoId: WORKSPACE_ROOT_REPO_ID,
        },
      ],
      [
        IPC_CHANNELS.worktreeListBranches,
        { projectId: MULTI_WS, worktreeId: WORKTREE, repoId: 'member' },
      ],
      [IPC_CHANNELS.homeListBranchTargets, { workspaceId: FRESH_WS }],
      [IPC_CHANNELS.homeListBranchTargets, { workspaceId: MULTI_WS }],
    ] as const;
    const direct: Outcome[] = [];
    for (const [channel, request] of cases)
      direct.push(await ipc(channel, request));
    await runtime?.shutdown();
    registerHandlers(() => routeFor(), true);
    for (const [index, [channel, request]] of cases.entries())
      expect(JSON.stringify(await ipc(channel, request))).toBe(
        JSON.stringify(direct[index]),
      );
    expect(query).toHaveBeenCalledTimes(cases.length);
    expect(reads.filter((read) => read.kind === 'remote-head')).toHaveLength(0);
    expect(execution).toHaveBeenCalledTimes(cases.length);
    expect(queryOptions[0]?.execution).not.toEqual(queryOptions[1]?.execution);
    for (const [channel, request] of [
      [IPC_CHANNELS.homeListBranchTargets, { workspaceId: MULTI_NO_SOURCE_WS }],
      [IPC_CHANNELS.homeListBranchTargets, { workspaceId: COWORK_WS }],
    ] as const)
      expect(await ipc(channel, request)).toEqual({
        result: { supported: false, branches: [], defaultBranch: null },
      });
  });

  it('records one remote result and repairs origin/HEAD, then forwards the fresh hint without another write', async () => {
    await seedFreshness(
      repos[REPAIR_WS],
      'release',
      Date.now() - DEFAULT_BRANCH_FRESHNESS_TTL_MS - 60_000,
    );
    git(repos[REPAIR_WS], ['remote', 'set-head', 'origin', 'develop']);
    const record = jest.spyOn(freshnessStore, 'recordGitDefaultBranch');
    const repair = jest.spyOn(gitHelpers, 'setLocalRemoteHeadBranch');
    try {
      const route = routeFor();
      const remote = await list(route);
      expect(remote.defaultBranchSource).toBe('remote');
      expect(remote.defaultBranch).toBe('main');
      expect(record).toHaveBeenCalledTimes(1);
      expect(repair).toHaveBeenCalledTimes(1);
      expect(originHead(repos[REPAIR_WS])).toBe('refs/remotes/origin/main');
      const before = freshnessBytes();
      const hinted = await list(route);
      expect(hinted).toEqual({ ...remote, defaultBranchSource: 'hint' });
      expect(freshnessBytes()).toBe(before);
      expect(record).toHaveBeenCalledTimes(1);
      expect(repair).toHaveBeenCalledTimes(1);
      expect(reads.filter((read) => read.kind === 'remote-head')).toHaveLength(
        1,
      );
      expect(query.mock.calls[1]?.[1].defaultBranchHint?.defaultBranch).toBe(
        'main',
      );
    } finally {
      record.mockRestore();
      repair.mockRestore();
    }
  });

  it('keeps remote freshness attached to the identity observed before dispatch', async () => {
    const repo = repos[REPAIR_WS];
    const originUrl = git(repo, ['remote', 'get-url', 'origin']);
    const identity = {
      commonDir: realpathSync(join(repo, '.git')),
      originUrl,
    };
    query.mockImplementationOnce(() => {
      git(repo, ['remote', 'set-url', 'origin', origins[FRESH_WS]]);
      return Promise.resolve({
        branches: [],
        defaultBranch: 'main',
        defaultBranchSource: 'remote',
      });
    });
    try {
      await list(routeFor());
      expect(
        await freshnessStore.readGitDefaultBranchFreshness({
          ...identity,
          originUrl: origins[FRESH_WS],
        }),
      ).toBeNull();
      expect(
        await freshnessStore.readGitDefaultBranchFreshness(identity),
      ).toMatchObject({
        defaultBranch: 'main',
      });
      expect(neverDirect).not.toHaveBeenCalled();
    } finally {
      git(repo, ['remote', 'set-url', 'origin', originUrl]);
    }
  });

  it.each(['caller', 'deadline'] as const)(
    'drains accepted effects before success even when %s aborts during persistence',
    async (source) => {
      git(repos[REPAIR_WS], ['remote', 'set-head', 'origin', 'develop']);
      query.mockResolvedValueOnce({
        branches: [],
        defaultBranch: 'main',
        defaultBranchSource: 'remote',
      });
      const controller = new AbortController();
      const deadline = new AbortController();
      const timeout = jest
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(deadline.signal);
      const persist = freshnessStore.recordGitDefaultBranch;
      const record = jest
        .spyOn(freshnessStore, 'recordGitDefaultBranch')
        .mockImplementation((input) => {
          (source === 'caller' ? controller : deadline).abort();
          return persist(input);
        });
      try {
        const result = await routeFor().branchList(
          checkout,
          { caller: desktopCaller, signal: controller.signal },
          { sender: routeSender },
          neverDirect,
        );
        expect(result.defaultBranch).toBe('main');
        expect(record).toHaveBeenCalledTimes(1);
        expect(originHead(repos[REPAIR_WS])).toBe('refs/remotes/origin/main');
        expect(neverDirect).not.toHaveBeenCalled();
      } finally {
        record.mockRestore();
        timeout.mockRestore();
      }
    },
  );

  it('forwards only the identity-matched Electron hint, not a supplied hint', async () => {
    const readHint = jest
      .spyOn(defaultBranchHelpers, 'readDefaultBranchHint')
      .mockResolvedValueOnce(null);
    try {
      await list(routeFor(), {
        ...checkout,
        defaultBranchHint: {
          defaultBranch: 'unrelated-repository',
          resolvedAt: new Date().toISOString(),
        },
      });
      expect(query.mock.calls[0]?.[1].defaultBranchHint).toBeUndefined();
    } finally {
      readHint.mockRestore();
    }
  });

  it('normalizes a legacy timestamp without changing hint selection or writing freshness', async () => {
    const resolvedAt = new Date().toUTCString();
    const readHint = jest
      .spyOn(defaultBranchHelpers, 'readDefaultBranchHint')
      .mockResolvedValueOnce({ defaultBranch: 'release', resolvedAt });
    try {
      const before = freshnessBytes();
      const result = await list(routeFor());
      expect(result.defaultBranchSource).toBe('hint');
      expect(result.defaultBranch).toBe('release');
      expect(query.mock.calls[0]?.[1].defaultBranchHint?.resolvedAt).toBe(
        new Date(resolvedAt).toISOString(),
      );
      expect(reads.filter((read) => read.kind === 'remote-head')).toHaveLength(
        0,
      );
      expect(freshnessBytes()).toBe(before);
    } finally {
      readHint.mockRestore();
    }
  });

  it('keeps omitted hints additive, rejects malformed hints, and applies no effects to local or conventional results', async () => {
    for (const [workspaceId, source] of [
      [OFFLINE_WS, 'local-origin-head'],
      [OFFLINE_STALE_WS, 'stale-hint'],
      [OFFLINE_CONVENTIONAL_WS, 'conventional'],
      [NO_ORIGIN_WS, null],
    ] as const) {
      const before = freshnessBytes();
      const head = originHead(repos[workspaceId]);
      const result = await list(routeFor(), {
        scope: { workspaceId, worktreeId: WORKTREE },
        repository: { kind: 'checkout' },
      });
      expect(result.defaultBranchSource).toBe(source);
      expect(freshnessBytes()).toBe(before);
      expect(originHead(repos[workspaceId])).toBe(head);
    }
    expect(WorkerGitBranchListParamsSchema.safeParse(checkout).success).toBe(
      true,
    );
    for (const defaultBranchHint of [
      {},
      { defaultBranch: '', resolvedAt: 'bad' },
      { defaultBranch: 'main', resolvedAt: 'bad' },
    ])
      expect(
        WorkerGitBranchListParamsSchema.safeParse({
          ...checkout,
          defaultBranchHint,
        }).success,
      ).toBe(false);
  });

  it('uses the optional hint up to, but not including, its TTL boundary and rejects future freshness', async () => {
    const now = Date.now();
    const fixed = createWorkerGitBranchListHandlers({
      ...branchHost,
      now: () => now,
    });
    const context = {
      requestId: 'hint-boundary',
      caller: desktopCaller,
      metadata: {},
      signal: new AbortController().signal,
    };
    for (const [age, source] of [
      [0, 'hint'],
      [DEFAULT_BRANCH_FRESHNESS_TTL_MS - 1, 'hint'],
      [DEFAULT_BRANCH_FRESHNESS_TTL_MS, 'remote'],
      [-1, 'remote'],
    ] as const) {
      const result = await fixed['worker.git.branch.list'](
        {
          scope: { workspaceId: FRESH_WS },
          repository: { kind: 'reference' },
          defaultBranchHint: {
            defaultBranch: 'release',
            resolvedAt: new Date(now - age).toISOString(),
          },
        },
        context,
      );
      expect(result.defaultBranchSource).toBe(source);
      expect(result.defaultBranch).toBe(source === 'hint' ? 'release' : 'main');
    }
    const omitted = await fixed['worker.git.branch.list'](
      { scope: { workspaceId: FRESH_WS }, repository: { kind: 'reference' } },
      context,
    );
    expect(omitted.defaultBranchSource).toBe('remote');
    expect(omitted.defaultBranch).toBe('main');
    expect(reads.filter((read) => read.kind === 'remote-head')).toHaveLength(3);
  });

  it('refuses unresolved repositories before daemon contact rather than silently dropping effects', async () => {
    await expect(
      list(routeFor({ repositoryPath: () => Promise.resolve(null) })),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.branch.repositoryUnavailable' },
    });
    expect(hostContext).not.toHaveBeenCalled();
    expect(connections).not.toHaveBeenCalled();
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it.each([
    'unavailable',
    'deadline_exceeded',
    'capability_unavailable',
    'invalid_argument',
  ] as const)('keeps %s typed without fallback', async (kind) => {
    const before = freshnessBytes();
    const head = originHead(repos[REPAIR_WS]);
    query.mockRejectedValueOnce(
      new CanopyClientError({ kind, message: kind, retry: { kind: 'never' } }),
    );
    await expect(list(routeFor())).rejects.toMatchObject({ payload: { kind } });
    expect(freshnessBytes()).toBe(before);
    expect(originHead(repos[REPAIR_WS])).toBe(head);
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it('rejects a schema-skewed result and a host failure without fallback', async () => {
    query.mockResolvedValueOnce(
      Object.assign(
        { branches: [], defaultBranch: null, defaultBranchSource: null },
        { unexpected: true },
      ),
    );
    await expect(list(routeFor())).rejects.toMatchObject({
      payload: { kind: 'internal' },
    });
    await expect(
      list(
        routeFor({
          hostContext: () => Promise.reject(new Error('host failed')),
        }),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it('keeps connection setup failure typed without contacting the query or falling back', async () => {
    await expect(
      list(
        routeFor({
          connections: () => ({
            get: (): Promise<never> =>
              Promise.reject(
                new CanopyClientError({
                  kind: 'unavailable',
                  message: 'connection refused',
                  retry: { kind: 'never' },
                }),
              ),
          }),
        }),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    expect(query).not.toHaveBeenCalled();
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it('accepts an empty listing without writing freshness or origin/HEAD', async () => {
    const empty = {
      branches: [],
      defaultBranch: null,
      defaultBranchSource: null,
    };
    query.mockResolvedValueOnce(empty);
    const before = freshnessBytes();
    const head = originHead(repos[REPAIR_WS]);
    expect(await list(routeFor())).toEqual(empty);
    expect(freshnessBytes()).toBe(before);
    expect(originHead(repos[REPAIR_WS])).toBe(head);
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it('cancels a pre-retired request before host context or connection creation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      routeFor().branchList(
        checkout,
        { caller: desktopCaller, signal: controller.signal },
        { sender: routeSender },
        neverDirect,
      ),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    expect(hostContext).not.toHaveBeenCalled();
    expect(connections).not.toHaveBeenCalled();
    expect(neverDirect).not.toHaveBeenCalled();
  });

  it('bounds a stalled query and never applies late effects or falls back', async () => {
    const deadline = new AbortController();
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(deadline.signal);
    let reply:
      | ((value: {
          branches: [];
          defaultBranch: string;
          defaultBranchSource: 'remote';
        }) => void)
      | undefined;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
          deadline.abort();
        }),
    );
    try {
      await expect(
        list(routeFor({ queryDeadlineMs: 1_000 })),
      ).rejects.toMatchObject({ payload: { kind: 'deadline_exceeded' } });
      expect(timeout).toHaveBeenCalledWith(1_000);
      expect(query).toHaveBeenCalledTimes(1);
      const before = freshnessBytes();
      reply?.({
        branches: [],
        defaultBranch: 'release',
        defaultBranchSource: 'remote',
      });
      await Promise.resolve();
      expect(freshnessBytes()).toBe(before);
      expect(neverDirect).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it('keeps production, Windows, remote bridges, non-window and app-managed requests direct without lazy dependencies', async () => {
    const direct = jest.fn(() =>
      Promise.resolve({
        branches: [],
        defaultBranch: null,
        defaultBranchSource: null,
      }),
    );
    const cases: Array<{
      options?: Partial<DaemonGitRouteOptions>;
      params?: WorkerGitBranchListParams;
      caller?: CanopyCallerDescriptor;
    }> = [
      { options: { selectable: undefined } },
      { options: { platform: 'win32' } },
      { caller: { ...desktopCaller, clientInstanceId: 'remote-bridge:1' } },
      { caller: { ...desktopCaller, interfaceKind: 'portal' } },
      {
        caller: {
          ...desktopCaller,
          clientInstanceId: 'electron-web-contents:2',
        },
      },
      ...[
        APP_ADVISOR_PROJECT_ID,
        CODE_REVIEW_CHAT_PROJECT_ID,
        PLAN_EXPLORE_CHAT_PROJECT_ID,
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
      ].map((workspaceId) => ({
        params: { ...checkout, scope: { ...checkout.scope, workspaceId } },
      })),
      {
        params: {
          ...checkout,
          scope: { ...checkout.scope, authorityId: 'other-authority' },
        },
      },
      {
        params: {
          ...checkout,
          scope: { ...checkout.scope, targetId: 'other-target' },
        },
      },
    ];
    for (const entry of cases)
      await routeFor(entry.options).branchList(
        entry.params ?? checkout,
        { caller: entry.caller ?? desktopCaller },
        { sender: routeSender },
        direct,
      );
    expect(direct).toHaveBeenCalledTimes(cases.length);
    expect(hostContext).not.toHaveBeenCalled();
    expect(connections).not.toHaveBeenCalled();
    expect(execution).not.toHaveBeenCalled();
    // Linux is eligible; a selected query must reach the client.
    await list(routeFor({ platform: 'linux' }));
    expect(query).toHaveBeenCalledTimes(1);
    for (const operation of [
      'git.remote.get',
      'git.worktree.health.get',
      'git.executable.get',
      'git.status.get',
      'git.diff.get',
    ] as const)
      for (const disposition of Object.values(READ_ROUTE_TABLE[operation]))
        expect(disposition.kind).toBe('blocked');
  });

  it('reports connection loss typed, without a direct retry', async () => {
    query.mockImplementationOnce(() => {
      connection.abort();
      return Promise.reject(new Error('closed'));
    });
    await expect(list(routeFor())).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
    await expect(list(routeFor())).rejects.toMatchObject({
      payload: { kind: 'unavailable' },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(neverDirect).not.toHaveBeenCalled();
  });
});
