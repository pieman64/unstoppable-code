// CAN-4107: `worker.git.branch.list` keeps today's names when a tag or a
// local `origin/<name>` branch shadows a branch (Git's qualified short name,
// listed as a local entry), and each listed name still starts a branch or
// worktree at the shadowed branch. Runs unchanged against the base handlers
// (ts-jest transpiles without type checks, so the base's one-argument
// registerWorktreeHandlers ignores the runtime argument). Real data root,
// workspace records, Git checkout and bare origin; only IPC registration and
// the portal/observability sinks are mocked.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type BranchEntry,
  type ListBranchesResponse,
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
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { registerWorktreeHandlers } from '../ipc/worktrees';
import { createSingleRepoWorktree } from '../lib/worktree-service';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';

jest.setTimeout(120_000);

const WORKSPACE = 'collision-ws';
const WORKTREE = 'feature-01';

let dir: string;
let dataDir: string;
let repo: string;
let originalDataDir: string | undefined;
let originalGitEnv: [string, string | undefined][] = [];
let runtime: DesktopCanopyDispatcher | undefined;
const tips: Record<string, string> = {};

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

function commit(path: string, file: string): void {
  writeFileSync(join(path, file), `${file}\n`);
  git(path, ['add', '.']);
  git(path, ['commit', '-q', '-m', file]);
}

function identify(path: string): void {
  git(path, ['config', 'user.email', 'collision@example.com']);
  git(path, ['config', 'user.name', 'Collision']);
}

function worktreeDir(): string {
  return join(dataDir, 'workspaces', WORKSPACE, 'worktrees', WORKTREE);
}

const desktopCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-branch-collision-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  // User config (core.warnAmbiguousRefs, commit.gpgsign) and hook-inherited
  // GIT_DIR would change short names or break the fixture; the handlers'
  // Git inherits process.env.
  originalGitEnv = Object.entries(process.env).filter(([key]) =>
    key.startsWith('GIT_'),
  );
  for (const [key] of originalGitEnv) delete process.env[key];
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(globalConfig, '');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = globalConfig;

  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  identify(seed);
  commit(seed, 'README.md');
  git(seed, ['branch', 'release']);
  git(seed, ['branch', 'both']);
  const origin = join(dir, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], {
    stdio: 'pipe',
  });
  repo = join(dir, 'repo');
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'pipe' });
  identify(repo);
  commit(repo, 'tagged.md');
  commit(repo, 'local.md');
  git(repo, ['worktree', 'add', '-q', '-b', WORKTREE, worktreeDir()]);
  // Each shadowing ref points at a different commit from the branch it
  // shadows: tag `main` the local main, tag `origin/release` the remote
  // release, and the local `origin/both` the remote both (and back).
  git(repo, ['tag', 'main', 'HEAD~1']);
  git(repo, ['tag', 'origin/release', 'HEAD~1']);
  git(repo, ['branch', 'origin/both', 'HEAD']);
  for (const ref of [
    'refs/heads/main',
    'refs/heads/origin/both',
    'refs/remotes/origin/main',
    'refs/remotes/origin/release',
    'refs/remotes/origin/both',
    'refs/tags/main',
    'refs/tags/origin/release',
  ])
    tips[ref] = git(repo, ['rev-parse', ref]);

  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE,
        name: WORKSPACE,
        type: 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order: 0,
      },
    ],
  });
  writeJson(join(dataDir, 'workspaces', WORKSPACE, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repo,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', WORKSPACE, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: WORKTREE,
        branchName: WORKTREE,
        createdAt: '2026-10-26T00:00:00.000Z',
      },
    ],
  });

  runtime = createDesktopRuntime();
  registerWorktreeHandlers(() => null, {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
  });
});

afterAll(async () => {
  await runtime?.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  delete process.env.GIT_CONFIG_GLOBAL;
  for (const [key, value] of originalGitEnv) process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});

async function ipc(channel: string, request: unknown): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  const event: Partial<IpcMainInvokeEvent> = {};
  return handler(event, request);
}

function isBranchList(value: unknown): value is ListBranchesResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray(Reflect.get(value, 'branches'))
  );
}

async function listBranches(): Promise<ListBranchesResponse> {
  const response = await ipc(IPC_CHANNELS.worktreeListBranches, {
    projectId: WORKSPACE,
    worktreeId: WORKTREE,
  });
  if (!isBranchList(response)) throw new Error('Unexpected branch list');
  return response;
}

async function listedBranch(name: string): Promise<BranchEntry> {
  const branch = (await listBranches()).branches.find(
    (entry) => entry.name === name,
  );
  if (!branch) throw new Error(`${name} was not listed`);
  return branch;
}

function entry(
  name: string,
  kind: 'local' | 'remote',
  overrides: Partial<BranchEntry> = {},
): BranchEntry {
  return {
    name,
    isRemote: kind === 'remote',
    isCurrent: false,
    isUsedByWorktree: false,
    hasLocalRef: kind === 'local',
    hasRemoteRef: kind === 'remote',
    ...overrides,
  };
}

describe('branches shadowed by a tag or a local origin/<name> branch', () => {
  it("lists today's names, without refs/remotes/origin/HEAD", async () => {
    // Git's short names, identical on Git 2.37 and 2.55: a shadowed ref is
    // qualified and listed as local. refs/remotes/origin/HEAD is skipped; Git
    // 2.55 shortens it to `origin`, which the base listed as a local branch.
    expect(tips['refs/tags/main']).not.toBe(tips['refs/heads/main']);
    expect(tips['refs/tags/origin/release']).not.toBe(
      tips['refs/remotes/origin/release'],
    );
    expect(tips['refs/heads/origin/both']).not.toBe(
      tips['refs/remotes/origin/both'],
    );
    expect((await listBranches()).branches).toEqual([
      entry(WORKTREE, 'local', { isCurrent: true }),
      // The main checkout holds local main; occupancy matches by name.
      entry('main', 'remote', { isUsedByWorktree: true }),
      entry('heads/main', 'local'),
      entry('heads/origin/both', 'local'),
      entry('remotes/origin/both', 'local'),
      entry('remotes/origin/release', 'local'),
    ]);
  });

  it.each([
    { base: 'heads/main', ref: 'refs/heads/main' },
    { base: 'main', ref: 'refs/remotes/origin/main' },
    { base: 'remotes/origin/release', ref: 'refs/remotes/origin/release' },
    { base: 'heads/origin/both', ref: 'refs/heads/origin/both' },
    { base: 'remotes/origin/both', ref: 'refs/remotes/origin/both' },
  ])(
    'worktree:create-branch from listed $base starts at $ref',
    async ({ base, ref }) => {
      const listed = await listedBranch(base);
      const newBranchName = `from-${base.replaceAll('/', '-')}`;
      // As BranchPicker sends a listed base and its provenance.
      const response = await ipc(IPC_CHANNELS.worktreeCreateBranch, {
        projectId: WORKSPACE,
        worktreeId: WORKTREE,
        newBranchName,
        baseBranch: listed.name,
        baseBranchIsRemote: listed.isRemote,
      });

      expect(response).toEqual({ success: true, branchName: newBranchName });
      expect(git(worktreeDir(), ['rev-parse', 'HEAD'])).toBe(tips[ref]);
      expect(git(worktreeDir(), ['symbolic-ref', 'HEAD'])).toBe(
        `refs/heads/${newBranchName}`,
      );
    },
  );

  it.each([
    { base: 'heads/main', ref: 'refs/heads/main' },
    { base: 'remotes/origin/release', ref: 'refs/remotes/origin/release' },
  ])(
    'creates a worktree from listed $base at $ref, not the tag',
    async ({ base, ref }) => {
      const branchName = `wt-${base.replaceAll('/', '-')}`;
      const created = await createSingleRepoWorktree({
        workspaceId: WORKSPACE,
        branchName,
        baseBranch: (await listedBranch(base)).name,
        allowBaseBranchNetwork: false,
      });

      expect(created.trackedBaseBranch).toBe(base);
      expect(git(repo, ['rev-parse', `refs/heads/${branchName}`])).toBe(
        tips[ref],
      );
    },
  );
});
