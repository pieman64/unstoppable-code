// CAN-4108: `worktree:switch-branch` and `worktree:create-branch` project
// `worker.git.checkout` and `worker.git.branch.create` on the desktop
// dispatcher; CAN-5516 adds the rename's Git effect over
// `worker.git.branch.rename` and the desktop host of `worker.git.branch.delete`.
// Real Git outcomes are pinned by worktree-branch-checkout-ipc.test.ts and
// worktree-branch-rename-ipc.test.ts; this pins who may call, which scope
// is dispatched, and which requests keep the direct path.
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
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  type SwitchBranchRequest,
} from '@canopy/desktop-shared/types';
import type {
  CanopyCallerDescriptor,
  WorkerGitCheckoutScope,
  WorkerGitRecordedRepositoryScope,
} from '@canopy/protocol/canopy-core';
import type {
  GitBranchWritePort,
  WorkerGitBranchWriteHost,
} from '@canopy/core-runtime/node/git';
import * as git from '../../lib/git';

jest.mock('../../lib/git', () => {
  const actual = jest.requireActual<typeof git>('../../lib/git');
  return {
    ...actual,
    checkoutBranch: jest.fn(() => Promise.resolve()),
    createBranchAndCheckout: jest.fn(() => Promise.resolve('direct-branch')),
    renameBranch: jest.fn(() => Promise.resolve()),
  };
});

import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  createWorktreeBranch,
  switchWorktreeBranch,
  worktreeBranchRenameGit,
} from '../worker-git-dispatch';
import { registerCodeReviewTarget } from '../../lib/code-review-registry';

const desktopUser: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};

interface Recorded {
  scopes: (WorkerGitCheckoutScope | WorkerGitRecordedRepositoryScope)[];
  effects: string[];
}

function fakePort(recorded: Recorded): GitBranchWritePort {
  return {
    hasUncommittedChanges: () => Promise.resolve(false),
    readWorktreeList: () =>
      Promise.resolve({ output: '', checkoutPath: '/checkout' }),
    localBranchExists: (branch) =>
      Promise.resolve(['release', 'feature'].includes(branch)),
    remoteBranchExists: () => Promise.resolve(false),
    fetchRemoteBranch: () => Promise.reject(new Error('offline')),
    isValidBranchName: () => Promise.resolve(true),
    listLocalBranchesUnder: () => Promise.resolve(''),
    currentBranch: () => Promise.resolve('task'),
    checkout: (branch) => {
      recorded.effects.push(`checkout ${branch}`);
      return Promise.resolve();
    },
    checkoutNewBranch: (name, startPoint) => {
      recorded.effects.push(`checkout -b ${name} ${startPoint}`);
      return Promise.resolve();
    },
    renameCurrentBranch: (name) => {
      recorded.effects.push(`branch -m ${name}`);
      return Promise.resolve();
    },
  };
}

let dataDir: string;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;
const recorded: Recorded = { scopes: [], effects: [] };

beforeAll(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'git-branch-write-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  const host: WorkerGitBranchWriteHost<string> = {
    authorityId: 'local-desktop',
    resolveCheckout: (scope) => {
      recorded.scopes.push(scope);
      return Promise.resolve('/checkout');
    },
    port: () => fakePort(recorded),
    resolveRepository: (scope) => {
      recorded.scopes.push(scope);
      return Promise.resolve('/repo');
    },
    deletePort: () => ({
      listCheckedOutBranches: () => Promise.resolve(new Map()),
      deleteBranch: (branch, force) => {
        recorded.effects.push(`branch ${force ? '-D' : '-d'} ${branch}`);
        return Promise.resolve();
      },
      deleteBranchRef: (branch, tip) => {
        recorded.effects.push(`update-ref -d refs/heads/${branch} ${tip}`);
        return Promise.resolve();
      },
    }),
  };
  runtime = createDesktopRuntime({ workerGitBranchWriteHost: host });
});

afterAll(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  recorded.scopes = [];
  recorded.effects = [];
  jest.mocked(git.checkoutBranch).mockClear();
  jest.mocked(git.createBranchAndCheckout).mockClear();
  jest.mocked(git.renameBranch).mockClear();
});

const switchRequest: SwitchBranchRequest = {
  projectId: 'ws-1',
  worktreeId: 'wt-1',
  branchName: 'release',
  isRemote: false,
};

describe('worker.git branch write projections', () => {
  it.each<[string, CanopyCallerDescriptor]>([
    ['the local desktop user', desktopUser],
    [
      'a paired controller through the desktop IPC bridge',
      {
        ...desktopUser,
        principalId: 'remote-device:device-1',
        clientInstanceId: 'remote-bridge:7',
      },
    ],
  ])('switches for %s', async (_name, caller) => {
    await expect(
      switchWorktreeBranch(runtime, () => caller, switchRequest),
    ).resolves.toEqual({ success: true, branchName: 'release' });
    expect(recorded.scopes).toEqual([
      { workspaceId: 'ws-1', worktreeId: 'wt-1' },
    ]);
    expect(recorded.effects).toEqual(['checkout release']);
  });

  it.each<[string, CanopyCallerDescriptor]>([
    [
      'a renderer relay surface',
      { ...desktopUser, principalId: 'local-desktop-renderer:main' },
    ],
    ['a Portal session', { ...desktopUser, interfaceKind: 'portal' }],
  ])('refuses %s before the checkout resolves', async (_name, caller) => {
    await expect(
      switchWorktreeBranch(runtime, () => caller, switchRequest),
    ).rejects.toThrow(
      new Error(
        'Git branch changes are available only from the desktop app on this machine.',
      ),
    );
    await expect(
      createWorktreeBranch(runtime, () => caller, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        newBranchName: 'new',
        baseBranch: 'main',
        baseBranchIsRemote: false,
      }),
    ).rejects.toThrow('Git branch changes are available only');
    expect(recorded.scopes).toEqual([]);
    expect(recorded.effects).toEqual([]);
  });

  it('dispatches a code-review chat scope as the real worktree it borrows', async () => {
    await registerCodeReviewTarget('ws-1--wt-1', {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
    await switchWorktreeBranch(runtime, () => desktopUser, {
      ...switchRequest,
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'ws-1--wt-1',
      repoId: 'api',
    });
    expect(recorded.scopes).toEqual([
      { workspaceId: 'ws-1', worktreeId: 'wt-1', repoId: 'api' },
    ]);
  });

  it('keeps the direct call for identifiers longer than the scope carries', async () => {
    const worktreeId = `w${'x'.repeat(600)}`;
    await expect(
      switchWorktreeBranch(runtime, () => desktopUser, {
        ...switchRequest,
        worktreeId,
      }),
    ).resolves.toEqual({ success: true, branchName: 'release' });
    expect(git.checkoutBranch).toHaveBeenCalledWith(
      expect.stringContaining(worktreeId),
      'release',
    );
    await expect(
      createWorktreeBranch(runtime, () => desktopUser, {
        projectId: 'ws-1',
        worktreeId,
        newBranchName: ' new ',
        baseBranch: 'main',
        baseBranchIsRemote: true,
      }),
    ).resolves.toEqual({ success: true, branchName: 'direct-branch' });
    expect(git.createBranchAndCheckout).toHaveBeenCalledWith(
      expect.stringContaining(worktreeId),
      'new',
      'origin/main',
    );
    expect(recorded.scopes).toEqual([]);
  });

  it('keeps the direct call for a branch name that is not a string', async () => {
    const request: SwitchBranchRequest = { ...switchRequest };
    Reflect.set(request, 'branchName', 7);
    await expect(
      switchWorktreeBranch(runtime, () => desktopUser, request),
    ).resolves.toEqual({ success: true, branchName: 7 });
    expect(git.checkoutBranch).toHaveBeenCalledWith(
      expect.stringContaining('wt-1'),
      7,
    );
    expect(recorded.scopes).toEqual([]);
  });

  it('creates through worker.git.branch.create and answers the suffixed name', async () => {
    await expect(
      createWorktreeBranch(runtime, () => desktopUser, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        newBranchName: '  feature ',
        baseBranch: ' main ',
        baseBranchIsRemote: true,
      }),
    ).resolves.toEqual({ success: true, branchName: 'feature-2' });
    expect(recorded.effects).toEqual(['checkout -b feature-2 origin/main']);
    expect(git.createBranchAndCheckout).not.toHaveBeenCalled();
  });

  it('never resolves the caller for a request the legacy checks refuse', async () => {
    const resolveCaller = jest.fn(() => desktopUser);
    await expect(
      createWorktreeBranch(runtime, resolveCaller, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        newBranchName: '-x',
        baseBranch: 'main',
        baseBranchIsRemote: false,
      }),
    ).rejects.toThrow(new Error('Invalid new branch name'));
    expect(resolveCaller).not.toHaveBeenCalled();
  });
});

describe('worktree:rename-branch Git effect over worker.git.branch.rename', () => {
  const target = { workspaceId: 'ws-1', worktreeId: 'wt-1' };

  it.each<[string, CanopyCallerDescriptor]>([
    ['the local desktop user', desktopUser],
    [
      'a paired controller through the desktop IPC bridge',
      { ...desktopUser, principalId: 'remote-device:device-1' },
    ],
  ])(
    'renames for %s, re-checking the name in the worker',
    async (_name, caller) => {
      await worktreeBranchRenameGit(runtime, () => caller).renameCheckoutBranch(
        { ...target, repoId: 'api' },
        'renamed',
      );
      expect(recorded.scopes).toEqual([{ ...target, repoId: 'api' }]);
      expect(recorded.effects).toEqual(['branch -m renamed']);
      expect(git.renameBranch).not.toHaveBeenCalled();
    },
  );

  it.each<[string, CanopyCallerDescriptor]>([
    [
      'a renderer relay surface',
      { ...desktopUser, principalId: 'local-desktop-renderer:main' },
    ],
    ['a Portal session', { ...desktopUser, interfaceKind: 'portal' }],
  ])('refuses %s before the checkout resolves', async (_name, caller) => {
    await expect(
      worktreeBranchRenameGit(runtime, () => caller).renameCheckoutBranch(
        target,
        'renamed',
      ),
    ).rejects.toThrow(
      new Error(
        'Git branch changes are available only from the desktop app on this machine.',
      ),
    );
    expect(recorded.scopes).toEqual([]);
    expect(recorded.effects).toEqual([]);
  });

  it('rethrows the worker refusal with the desktop message', async () => {
    await expect(
      worktreeBranchRenameGit(runtime, () => desktopUser).renameCheckoutBranch(
        target,
        'feature',
      ),
    ).rejects.toThrow(new Error('Branch name "feature" is already in use'));
    expect(recorded.effects).toEqual([]);
  });

  it('dispatches a code-review chat scope as the real worktree it borrows', async () => {
    await registerCodeReviewTarget('ws-1--wt-1', {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
    await worktreeBranchRenameGit(
      runtime,
      () => desktopUser,
    ).renameCheckoutBranch(
      { workspaceId: CODE_REVIEW_CHAT_PROJECT_ID, worktreeId: 'ws-1--wt-1' },
      'renamed',
    );
    expect(recorded.scopes).toEqual([target]);
  });

  it('keeps the direct rename for identifiers longer than the scope carries', async () => {
    const worktreeId = `w${'x'.repeat(600)}`;
    await worktreeBranchRenameGit(
      runtime,
      () => desktopUser,
    ).renameCheckoutBranch({ workspaceId: 'ws-1', worktreeId }, 'renamed');
    expect(git.renameBranch).toHaveBeenCalledWith(
      expect.stringContaining(worktreeId),
      'renamed',
    );
    expect(recorded.scopes).toEqual([]);
  });

  it('resolves the caller only when it dispatches', async () => {
    const resolveCaller = jest.fn(() => desktopUser);
    const port = worktreeBranchRenameGit(runtime, resolveCaller);
    expect(resolveCaller).not.toHaveBeenCalled();
    await port.renameCheckoutBranch(target, 'renamed');
    expect(resolveCaller).toHaveBeenCalledTimes(1);
  });
});

describe('worker.git.branch.delete on the desktop dispatcher', () => {
  const core: CanopyCallerDescriptor = {
    principalId: 'core',
    clientInstanceId: 'desktop-core',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['worker.git.write'],
  };

  it('deletes in the recorded repository for the trusted core', async () => {
    await expect(
      runtime.instruction(
        'worker.git.branch.delete',
        {
          scope: { workspaceId: 'ws-1', repoId: 'api' },
          branch: 'old',
          deletion: { kind: 'tip', tip: 'a'.repeat(40) },
        },
        { caller: core },
      ),
    ).resolves.toEqual({ branch: 'old' });
    expect(recorded.scopes).toEqual([{ workspaceId: 'ws-1', repoId: 'api' }]);
    expect(recorded.effects).toEqual([
      `update-ref -d refs/heads/old ${'a'.repeat(40)}`,
    ]);
  });

  it('refuses a relay caller holding the grant before resolving', async () => {
    await expect(
      runtime.instruction(
        'worker.git.branch.delete',
        {
          scope: { workspaceId: 'ws-1' },
          branch: 'old',
          deletion: { kind: 'force' },
        },
        { caller: { ...core, principalId: 'local-desktop-renderer:main' } },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.git.branch.callerRefused' },
    });
    expect(recorded.scopes).toEqual([]);
  });
});

describe('the desktop branch write host over real records (CAN-5516)', () => {
  let defaultRuntime: DesktopCanopyDispatcher;
  let repo: string;
  let member: string;
  const core: CanopyCallerDescriptor = {
    principalId: 'core',
    clientInstanceId: 'desktop-core',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['worker.git.write'],
  };
  const sh = (cwd: string, args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    }).trim();
  const seed = (path: string): void => {
    mkdirSync(path, { recursive: true });
    sh(path, ['init', '-q', '-b', 'main']);
    sh(path, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ]);
    sh(path, ['branch', 'old']);
  };
  const json = (path: string, value: unknown): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  const branches = (path: string): string =>
    sh(path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);

  beforeAll(() => {
    repo = join(dataDir, 'sources', 'single');
    member = join(dataDir, 'sources', 'api');
    seed(repo);
    seed(member);
    json(join(dataDir, 'workspaces', 'single-ws', 'workspace.json'), {
      version: 1,
      type: 'single-repo',
      repoPath: repo,
      repos: [],
    });
    json(join(dataDir, 'workspaces', 'multi-ws', 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'api', name: 'api', repoPath: member }],
    });
    defaultRuntime = createDesktopRuntime();
  });

  afterAll(() => defaultRuntime.shutdown());

  const remove = (
    scope: WorkerGitRecordedRepositoryScope,
    branch = 'old',
  ): Promise<unknown> =>
    defaultRuntime.instruction(
      'worker.git.branch.delete',
      { scope, branch, deletion: { kind: 'force' } },
      { caller: core },
    );

  it('deletes in the single-repo repository and in a multi-repo member', async () => {
    await expect(remove({ workspaceId: 'single-ws' })).resolves.toEqual({
      branch: 'old',
    });
    expect(branches(repo)).toBe('main');
    await expect(
      remove({ workspaceId: 'multi-ws', repoId: 'api' }),
    ).resolves.toEqual({ branch: 'old' });
    expect(branches(member)).toBe('main');
  });

  it.each<[string, WorkerGitRecordedRepositoryScope, string]>([
    [
      'a multi-repo root with no source repository',
      { workspaceId: 'multi-ws' },
      'worker.git.branch.scopeUnsupported',
    ],
    [
      'an unrecorded member',
      { workspaceId: 'multi-ws', repoId: 'web' },
      'worker.git.branch.scopeUnsupported',
    ],
    [
      'an app-managed chat scope',
      { workspaceId: CODE_REVIEW_CHAT_PROJECT_ID },
      'worker.git.branch.scopeUnsupported',
    ],
    [
      'an invalid repository id',
      { workspaceId: 'single-ws', repoId: 'Bad_Id' },
      'worker.git.branch.invalidScope',
    ],
  ])('refuses %s', async (_label, scope, code) => {
    await expect(remove(scope)).rejects.toMatchObject({ payload: { code } });
  });
});
