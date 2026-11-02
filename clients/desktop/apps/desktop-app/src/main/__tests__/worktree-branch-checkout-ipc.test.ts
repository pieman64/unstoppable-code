// CAN-4108 goldens: `worktree:switch-branch` and `worktree:create-branch`
// responses, refusals and Git effects, captured against the unchanged desktop
// handlers before they became projections of `worker.git.checkout` and
// `worker.git.branch.create`. Real data root, workspace records, checkout and
// bare `file://`-style origin; only IPC registration and the portal and
// observability sinks are mocked. No hooks run: the fixture's Git config is
// empty (the daemon's hook cases are core-daemon git-write-environment.test.ts).
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
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

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
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';

jest.setTimeout(120_000);

const WORKSPACE = 'checkout-ws';
const WORKTREE = 'task-01';

let dir: string;
let dataDir: string;
let seed: string;
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
  git(path, ['config', 'user.email', 'checkout@example.com']);
  git(path, ['config', 'user.name', 'Checkout']);
}

function worktreeDir(): string {
  return join(dataDir, 'workspaces', WORKSPACE, 'worktrees', WORKTREE);
}

function head(): string {
  return git(worktreeDir(), ['symbolic-ref', 'HEAD']);
}

const desktopCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-branch-checkout-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  // User config (hooks, commit.gpgsign) and hook-inherited GIT_DIR would
  // change the fixture; the handlers' Git inherits process.env.
  originalGitEnv = Object.entries(process.env).filter(([key]) =>
    key.startsWith('GIT_'),
  );
  for (const [key] of originalGitEnv) delete process.env[key];
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(globalConfig, '');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = globalConfig;

  seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  identify(seed);
  commit(seed, 'README.md');
  git(seed, ['branch', 'release']);
  commit(seed, 'release-ahead.md');
  git(seed, ['branch', '-f', 'release', 'HEAD']);
  git(seed, ['reset', '-q', '--hard', 'HEAD~1']);
  git(seed, ['branch', 'remote-only']);
  const origin = join(dir, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], {
    stdio: 'pipe',
  });
  git(seed, ['remote', 'add', 'origin', origin]);
  repo = join(dir, 'repo');
  execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'pipe' });
  identify(repo);
  // Published after the clone: the checkout has no remote-tracking ref.
  git(seed, ['branch', 'late', 'main']);
  git(seed, ['push', '-q', 'origin', 'late']);
  git(repo, ['branch', 'local-only', 'main']);
  git(repo, ['branch', 'nest/leaf', 'main']);
  git(repo, ['worktree', 'add', '-q', '-b', WORKTREE, worktreeDir()]);
  for (const ref of [
    'refs/heads/main',
    'refs/remotes/origin/release',
    'refs/remotes/origin/remote-only',
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
        createdAt: '2026-10-31T00:00:00.000Z',
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

beforeEach(() => {
  git(worktreeDir(), ['checkout', '-q', '-f', WORKTREE]);
  git(worktreeDir(), ['clean', '-fdq']);
});

async function ipc(channel: string, request: unknown): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  const event: Partial<IpcMainInvokeEvent> = {};
  return handler(event, request);
}

const switchBranch = (request: Record<string, unknown>): Promise<unknown> =>
  ipc(IPC_CHANNELS.worktreeSwitchBranch, {
    projectId: WORKSPACE,
    worktreeId: WORKTREE,
    ...request,
  });

const createBranch = (request: Record<string, unknown>): Promise<unknown> =>
  ipc(IPC_CHANNELS.worktreeCreateBranch, {
    projectId: WORKSPACE,
    worktreeId: WORKTREE,
    ...request,
  });

describe('worktree:switch-branch', () => {
  it('checks out a local branch', async () => {
    await expect(switchBranch({ branchName: 'local-only' })).resolves.toEqual({
      success: true,
      branchName: 'local-only',
    });
    expect(head()).toBe('refs/heads/local-only');
  });

  it('creates a tracking branch for a branch only origin has', async () => {
    await expect(switchBranch({ branchName: 'remote-only' })).resolves.toEqual({
      success: true,
      branchName: 'remote-only',
    });
    expect(head()).toBe('refs/heads/remote-only');
    expect(git(worktreeDir(), ['rev-parse', 'HEAD'])).toBe(
      tips['refs/remotes/origin/remote-only'],
    );
    expect(
      git(worktreeDir(), ['rev-parse', '--abbrev-ref', 'remote-only@{u}']),
    ).toBe('origin/remote-only');
  });

  it('fetches an origin branch the checkout has not seen, then tracks it', async () => {
    expect(() =>
      git(repo, ['show-ref', '--verify', 'refs/remotes/origin/late']),
    ).toThrow();
    await expect(switchBranch({ branchName: 'late' })).resolves.toEqual({
      success: true,
      branchName: 'late',
    });
    expect(head()).toBe('refs/heads/late');
    expect(git(worktreeDir(), ['rev-parse', '--abbrev-ref', 'late@{u}'])).toBe(
      'origin/late',
    );
  });

  it('refuses a checkout with uncommitted changes, untracked files included', async () => {
    writeFileSync(join(worktreeDir(), 'scratch.txt'), 'scratch\n');
    await expect(switchBranch({ branchName: 'local-only' })).rejects.toThrow(
      new Error('Cannot switch branches with uncommitted changes'),
    );
    expect(head()).toBe(`refs/heads/${WORKTREE}`);
  });

  it('refuses a branch another worktree has checked out', async () => {
    await expect(switchBranch({ branchName: 'main' })).rejects.toThrow(
      new Error('Branch "main" is already checked out in another worktree'),
    );
    expect(head()).toBe(`refs/heads/${WORKTREE}`);
  });

  it('reports a branch neither the checkout nor origin has', async () => {
    await expect(switchBranch({ branchName: 'missing' })).rejects.toThrow(
      new Error('Branch "missing" was not found'),
    );
    expect(head()).toBe(`refs/heads/${WORKTREE}`);
  });

  it('rejects with what Electron prints for the renderer: the name `Error` and the message', async () => {
    const printed = (pending: Promise<unknown>): Promise<string> =>
      pending.then(
        () => 'resolved',
        (error: unknown) => String(error),
      );
    await expect(printed(switchBranch({ branchName: 'main' }))).resolves.toBe(
      'Error: Branch "main" is already checked out in another worktree',
    );
    await expect(
      printed(switchBranch({ branchName: 'missing' })),
    ).resolves.toBe('Error: Branch "missing" was not found');
    await expect(
      printed(createBranch({ newBranchName: 'bad..name', baseBranch: 'main' })),
    ).resolves.toBe('Error: Invalid branch name: "bad..name"');
    writeFileSync(join(worktreeDir(), 'scratch.txt'), 'scratch\n');
    await expect(
      printed(switchBranch({ branchName: 'local-only' })),
    ).resolves.toBe('Error: Cannot switch branches with uncommitted changes');
  });

  it('refuses the read-only shared-container viewer before anything runs', async () => {
    await expect(
      switchBranch({
        projectId: 'shared-container-viewer',
        branchName: 'local-only',
      }),
    ).rejects.toThrow(
      new Error('Shared-container recipient workspaces are read-only'),
    );
  });

  it('validates identifiers with the desktop messages', async () => {
    await expect(
      switchBranch({ projectId: '../escape', branchName: 'local-only' }),
    ).rejects.toThrow(
      new Error(
        'Invalid projectId: must be lowercase alphanumeric with hyphens',
      ),
    );
    await expect(
      switchBranch({ worktreeId: '../escape', branchName: 'local-only' }),
    ).rejects.toThrow(
      new Error(
        'Invalid worktreeId: must be lowercase alphanumeric with hyphens',
      ),
    );
    await expect(
      switchBranch({ repoId: '../escape', branchName: 'local-only' }),
    ).rejects.toThrow(
      new Error('Invalid repoId: must be lowercase alphanumeric with hyphens'),
    );
    expect(head()).toBe(`refs/heads/${WORKTREE}`);
  });
});

describe('worktree:create-branch', () => {
  it('creates and checks out a branch from a local base', async () => {
    await expect(
      createBranch({
        newBranchName: 'from-main',
        baseBranch: 'main',
        baseBranchIsRemote: false,
      }),
    ).resolves.toEqual({ success: true, branchName: 'from-main' });
    expect(head()).toBe('refs/heads/from-main');
    expect(git(worktreeDir(), ['rev-parse', 'HEAD'])).toBe(
      tips['refs/heads/main'],
    );
  });

  it('starts at origin/<base> for a remote base', async () => {
    await expect(
      createBranch({
        newBranchName: 'from-release',
        baseBranch: 'release',
        baseBranchIsRemote: true,
      }),
    ).resolves.toEqual({ success: true, branchName: 'from-release' });
    expect(git(worktreeDir(), ['rev-parse', 'HEAD'])).toBe(
      tips['refs/remotes/origin/release'],
    );
  });

  it('trims the new and base branch names', async () => {
    await expect(
      createBranch({
        newBranchName: '  trimmed  ',
        baseBranch: '  main ',
      }),
    ).resolves.toEqual({ success: true, branchName: 'trimmed' });
    expect(head()).toBe('refs/heads/trimmed');
  });

  it('suffixes a name a local branch already has', async () => {
    await expect(
      createBranch({ newBranchName: 'local-only', baseBranch: 'main' }),
    ).resolves.toEqual({ success: true, branchName: 'local-only-2' });
    expect(head()).toBe('refs/heads/local-only-2');
  });

  it('suffixes a name a nested branch occupies as a directory', async () => {
    await expect(
      createBranch({ newBranchName: 'nest', baseBranch: 'main' }),
    ).resolves.toEqual({ success: true, branchName: 'nest-2' });
    expect(head()).toBe('refs/heads/nest-2');
  });

  it('refuses a name Git rejects', async () => {
    await expect(
      createBranch({ newBranchName: 'bad..name', baseBranch: 'main' }),
    ).rejects.toThrow(new Error('Invalid branch name: "bad..name"'));
    expect(head()).toBe(`refs/heads/${WORKTREE}`);
  });

  it.each([
    [{ newBranchName: '   ', baseBranch: 'main' }, 'Invalid new branch name'],
    [{ newBranchName: '-x', baseBranch: 'main' }, 'Invalid new branch name'],
    [{ newBranchName: 'ok-name', baseBranch: ' ' }, 'Invalid base branch'],
    [{ newBranchName: 'ok-name' }, 'Invalid base branch'],
    [{ newBranchName: 'ok-name', baseBranch: '-x' }, 'Invalid base branch'],
  ])('refuses %o with "%s"', async (request, message) => {
    await expect(createBranch(request)).rejects.toThrow(new Error(message));
    expect(head()).toBe(`refs/heads/${WORKTREE}`);
  });

  it('refuses a checkout with uncommitted changes', async () => {
    writeFileSync(join(worktreeDir(), 'scratch.txt'), 'scratch\n');
    await expect(
      createBranch({ newBranchName: 'dirty-new', baseBranch: 'main' }),
    ).rejects.toThrow(
      new Error('Cannot create a branch with uncommitted changes'),
    );
    expect(head()).toBe(`refs/heads/${WORKTREE}`);
  });

  it("surfaces Git's error for a base that does not exist", async () => {
    await expect(
      createBranch({ newBranchName: 'no-base', baseBranch: 'nowhere' }),
    ).rejects.toThrow(/fatal: .*nowhere/);
    expect(head()).toBe(`refs/heads/${WORKTREE}`);
    expect(() =>
      git(repo, ['show-ref', '--verify', 'refs/heads/no-base']),
    ).toThrow();
  });

  it('refuses the read-only shared-container viewer before validating names', async () => {
    await expect(
      createBranch({
        projectId: 'shared-container-viewer',
        newBranchName: '-x',
        baseBranch: 'main',
      }),
    ).rejects.toThrow(
      new Error('Shared-container recipient workspaces are read-only'),
    );
  });
});
