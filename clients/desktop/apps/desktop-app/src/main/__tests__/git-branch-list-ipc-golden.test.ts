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
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
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

function registerHandlers(): void {
  runtime = createDesktopRuntime();
  const accessors = {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
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
    const event: Partial<IpcMainInvokeEvent> = {};
    return { result: await handler(event, request) };
  } catch (error) {
    return { error: describeError(error) };
  }
}

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
