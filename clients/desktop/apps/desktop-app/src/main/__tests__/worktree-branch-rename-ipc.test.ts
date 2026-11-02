import '../../__tests__/worktree-replica-compatibility';
// CAN-5516 goldens: `worktree:rename-branch` responses, refusals, Git effects
// and the recorded row, captured against the unchanged desktop handler before
// its Git effect became a `worker.git.branch.rename` dispatch. Real data root,
// workspace records, checkouts and W5 worktree list; only IPC registration
// and the portal and observability sinks are mocked. No hooks run: the
// fixture's Git config is empty (the daemon's reference-transaction cases are
// core-daemon git-write-environment.test.ts). Row comparisons leave out the
// replica record, which the replica suite covers.
import { execFileSync } from 'node:child_process';
import {
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

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { registerWorktreeHandlers } from '../ipc/worktrees';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';

jest.setTimeout(120_000);

const SINGLE = 'rename-ws';
const MULTI = 'rename-multi';
const WORKTREE = 'task-01';
const MEMBER = 'api';
const CREATED_AT = '2026-10-31T00:00:00.000Z';
const PR_STATUS = {
  lastCheckedAt: '2026-10-31T00:00:00.000Z',
  repos: [{ repoId: 'repo', repoName: 'repo', status: null }],
};

let dir: string;
let dataDir: string;
let repo: string;
let memberRepo: string;
let originalDataDir: string | undefined;
let originalGitEnv: [string, string | undefined][] = [];
let runtime: DesktopCanopyDispatcher | undefined;

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

function seedRepository(path: string): void {
  mkdirSync(path);
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'rename@example.com']);
  git(path, ['config', 'user.name', 'Rename']);
  writeFileSync(join(path, 'README.md'), 'readme\n');
  git(path, ['add', '.']);
  git(path, ['commit', '-q', '-m', 'init']);
}

function worktreeDir(workspaceId: string): string {
  return join(dataDir, 'workspaces', workspaceId, 'worktrees', WORKTREE);
}

function memberDir(): string {
  return join(worktreeDir(MULTI), 'repos', MEMBER);
}

function head(path: string): string {
  return git(path, ['symbolic-ref', 'HEAD']);
}

function hasBranch(path: string, branch: string): boolean {
  try {
    git(path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function listPath(workspaceId: string): string {
  return join(dataDir, 'workspaces', workspaceId, 'worktrees.json');
}

function row(workspaceId: string): unknown {
  return {
    id: WORKTREE,
    branchName: `${workspaceId}-branch`,
    createdAt: CREATED_AT,
    lastKnownPrStatus: PR_STATUS,
  };
}

function writeRows(workspaceId: string, rows: unknown[]): void {
  writeJson(listPath(workspaceId), { version: 1, worktrees: rows });
}

function readRows(workspaceId: string): unknown {
  const parsed: unknown = JSON.parse(
    readFileSync(listPath(workspaceId), 'utf8'),
  );
  return parsed;
}

const desktopCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-branch-rename-')));
  dataDir = join(dir, 'data');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  // User config (hooks, commit.gpgsign) and hook-inherited GIT_DIR would
  // change the fixture; the handler's Git inherits process.env.
  originalGitEnv = Object.entries(process.env).filter(([key]) =>
    key.startsWith('GIT_'),
  );
  for (const [key] of originalGitEnv) delete process.env[key];
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(globalConfig, '');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = globalConfig;

  repo = join(dir, 'repo');
  seedRepository(repo);
  git(repo, ['branch', 'local-only']);
  git(repo, ['branch', 'nest/leaf']);
  memberRepo = join(dir, 'member');
  seedRepository(memberRepo);

  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: SINGLE,
        name: SINGLE,
        type: 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order: 0,
      },
      {
        id: MULTI,
        name: MULTI,
        type: 'multi-repo',
        color: '#7C3AED',
        collapsed: false,
        order: 1,
      },
    ],
  });
  writeJson(join(dataDir, 'workspaces', SINGLE, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repo,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', MULTI, 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    repos: [{ id: MEMBER, name: MEMBER, repoPath: memberRepo }],
  });

  runtime = createDesktopRuntime();
  registerWorktreeHandlers(() => null, {
    dispatcher: runtime,
    resolveCaller: (): CanopyCallerDescriptor => desktopCaller,
  });
});

// The handler's diff-stats refresh runs detached; it must not outlive a case.
afterEach(() => settleDetachedWork());

afterAll(async () => {
  await runtime?.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  delete process.env.GIT_CONFIG_GLOBAL;
  for (const [key, value] of originalGitEnv) process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});

// Every case starts from a fresh checkout on `<workspace>-branch` and its row.
beforeEach(() => {
  for (const [source, path] of [
    [repo, worktreeDir(SINGLE)],
    [memberRepo, memberDir()],
  ] as const) {
    rmSync(path, { recursive: true, force: true });
    git(source, ['worktree', 'prune']);
    for (const branch of git(source, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/',
    ]).split('\n'))
      if (!['main', 'local-only', 'nest/leaf'].includes(branch))
        git(source, ['branch', '-D', branch]);
  }
  git(repo, [
    'worktree',
    'add',
    '-q',
    '-b',
    `${SINGLE}-branch`,
    worktreeDir(SINGLE),
  ]);
  git(memberRepo, [
    'worktree',
    'add',
    '-q',
    '-b',
    `${MULTI}-branch`,
    memberDir(),
  ]);
  writeRows(SINGLE, [row(SINGLE)]);
  writeRows(MULTI, [row(MULTI)]);
});

async function ipc(channel: string, request: unknown): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  const event: Partial<IpcMainInvokeEvent> = {};
  return handler(event, request);
}

const rename = (request: Record<string, unknown>): Promise<unknown> =>
  ipc(IPC_CHANNELS.worktreeRenameBranch, {
    projectId: SINGLE,
    worktreeId: WORKTREE,
    ...request,
  });

// What Electron prints for the renderer: the error name and its message.
const printed = (pending: Promise<unknown>): Promise<string> =>
  pending.then(
    () => 'resolved',
    (error: unknown) => String(error),
  );

describe('worktree:rename-branch', () => {
  it("renames the root checkout's branch and records it, clearing the PR status", async () => {
    await expect(rename({ newBranchName: 'feature/renamed' })).resolves.toEqual(
      { success: true, newBranchName: 'feature/renamed' },
    );
    expect(head(worktreeDir(SINGLE))).toBe('refs/heads/feature/renamed');
    expect(hasBranch(repo, `${SINGLE}-branch`)).toBe(false);
    expect(readRows(SINGLE)).toEqual({
      version: 1,
      worktrees: [
        {
          id: WORKTREE,
          branchName: 'feature/renamed',
          createdAt: CREATED_AT,
          lastKnownPrStatus: null,
        },
      ],
    });
  });

  it('renames the root through __workspace_root__ the same way', async () => {
    await expect(
      rename({ repoId: '__workspace_root__', newBranchName: 'root-renamed' }),
    ).resolves.toEqual({ success: true, newBranchName: 'root-renamed' });
    expect(head(worktreeDir(SINGLE))).toBe('refs/heads/root-renamed');
  });

  it("renames a member repository's branch, keeping the sidebar branch", async () => {
    await expect(
      rename({
        projectId: MULTI,
        repoId: MEMBER,
        newBranchName: 'member-renamed',
      }),
    ).resolves.toEqual({ success: true, newBranchName: 'member-renamed' });
    expect(head(memberDir())).toBe('refs/heads/member-renamed');
    expect(hasBranch(memberRepo, `${MULTI}-branch`)).toBe(false);
    expect(readRows(MULTI)).toEqual({
      version: 1,
      worktrees: [
        {
          id: WORKTREE,
          branchName: `${MULTI}-branch`,
          createdAt: CREATED_AT,
          lastKnownPrStatus: null,
        },
      ],
    });
  });

  it('renames a checkout with uncommitted changes', async () => {
    writeFileSync(join(worktreeDir(SINGLE), 'scratch.txt'), 'scratch\n');
    await expect(rename({ newBranchName: 'dirty-renamed' })).resolves.toEqual({
      success: true,
      newBranchName: 'dirty-renamed',
    });
    expect(head(worktreeDir(SINGLE))).toBe('refs/heads/dirty-renamed');
  });

  it.each([
    ['bad..name', 'Invalid branch name: "bad..name"'],
    [' spaced ', 'Invalid branch name: " spaced "'],
    ['-x', 'Invalid branch name: "-x"'],
    ['', 'Invalid branch name: ""'],
    ['local-only', 'Branch name "local-only" is already in use'],
    ['nest', 'Branch name "nest" is already in use'],
    ['local-only/child', 'Branch name "local-only/child" is already in use'],
    [`${SINGLE}-branch`, `Branch name "${SINGLE}-branch" is already in use`],
  ])(
    'refuses %j with "%s" before Git or the list changes',
    async (name, message) => {
      const before = readFileSync(listPath(SINGLE), 'utf8');
      await expect(printed(rename({ newBranchName: name }))).resolves.toBe(
        `Error: ${message}`,
      );
      expect(head(worktreeDir(SINGLE))).toBe(`refs/heads/${SINGLE}-branch`);
      expect(readFileSync(listPath(SINGLE), 'utf8')).toBe(before);
    },
  );

  it('keeps the rename and reports the missing row when the worktree has none', async () => {
    writeRows(SINGLE, []);
    const before = readFileSync(listPath(SINGLE), 'utf8');
    await expect(
      printed(rename({ newBranchName: 'orphan-renamed' })),
    ).resolves.toBe(
      `Error: Worktree metadata not found for ${SINGLE}/${WORKTREE}`,
    );
    expect(head(worktreeDir(SINGLE))).toBe('refs/heads/orphan-renamed');
    expect(readFileSync(listPath(SINGLE), 'utf8')).toBe(before);
  });

  it("surfaces Git's error for a detached HEAD and records nothing", async () => {
    git(worktreeDir(SINGLE), ['checkout', '-q', '--detach']);
    const before = readFileSync(listPath(SINGLE), 'utf8');
    await expect(rename({ newBranchName: 'detached-renamed' })).rejects.toThrow(
      /fatal: .*not on any/,
    );
    expect(hasBranch(repo, 'detached-renamed')).toBe(false);
    expect(readFileSync(listPath(SINGLE), 'utf8')).toBe(before);
  });

  it('refuses the read-only shared-container viewer before anything runs', async () => {
    await expect(
      printed(
        rename({
          projectId: 'shared-container-viewer',
          newBranchName: 'bad..name',
        }),
      ),
    ).resolves.toBe(
      'Error: Shared-container recipient workspaces are read-only',
    );
  });

  // The validator's own error class, which Electron prints by name.
  it('validates identifiers with the desktop messages before Git runs', async () => {
    await expect(
      printed(rename({ projectId: '../escape', newBranchName: 'x' })),
    ).resolves.toBe(
      'IdentifierValidationError: Invalid projectId: must be lowercase alphanumeric with hyphens',
    );
    await expect(
      printed(rename({ worktreeId: '../escape', newBranchName: 'x' })),
    ).resolves.toBe(
      'IdentifierValidationError: Invalid worktreeId: must be lowercase alphanumeric with hyphens',
    );
    await expect(
      printed(rename({ repoId: '../escape', newBranchName: 'x' })),
    ).resolves.toBe(
      'IdentifierValidationError: Invalid repoId: must be lowercase alphanumeric with hyphens',
    );
    expect(head(worktreeDir(SINGLE))).toBe(`refs/heads/${SINGLE}-branch`);
  });
});
