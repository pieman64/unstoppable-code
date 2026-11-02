// CAN-5517: `github:pull`'s fetch and pull project `worker.git.fetch` and
// `worker.git.pull` on the desktop dispatcher. Real Git outcomes are pinned
// by github-pull-ipc-golden.test.ts; this pins who may call, which scope is
// dispatched, which entries keep the direct path, and that a conflict
// outcome hands the legacy path the Git error it read before.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  SINGLE_REPO_USAGE_REPO_ID,
  STANDALONE_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import type {
  CanopyCallerDescriptor,
  WorkerGitCheckoutScope,
} from '@canopy/protocol/canopy-core';
import type {
  GitSyncWritePort,
  WorkerGitSyncWriteHost,
} from '@canopy/core-runtime/node/git';
import * as git from '../../lib/git';

jest.mock('../../lib/git', () => {
  const actual = jest.requireActual<typeof git>('../../lib/git');
  return {
    ...actual,
    fetchOrigin: jest.fn(() => Promise.resolve()),
    getCurrentBranch: jest.fn(() => Promise.resolve('feature')),
    pullBranchFastForward: jest.fn(() => Promise.resolve()),
    pullBranchRebase: jest.fn(() => Promise.resolve()),
    isRebaseInProgress: jest.fn(() => Promise.resolve(false)),
    hasAutostashEntry: jest.fn(() => Promise.resolve(false)),
    hasUnmergedPaths: jest.fn(() => Promise.resolve(false)),
  };
});

import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  fetchWorktreeRepository,
  pullWorktreeRepository,
} from '../worker-git-sync-dispatch';
import { registerCodeReviewTarget } from '../../lib/code-review-registry';
import { resolveWorktreeCwd } from '../../lib/resolve-worktree';
import { registerWorkspaceTypes } from '../../lib/workspace-registry';
import {
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
} from '../../lib/paths';

const ANY_SIGNAL: unknown = expect.any(AbortSignal);

const desktopUser: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};

interface Recorded {
  scopes: WorkerGitCheckoutScope[];
  calls: string[];
  /** What the next pull returns from the port. */
  rebaseFails: boolean;
}

function fakePort(recorded: Recorded): GitSyncWritePort {
  const call = (entry: string): Promise<void> => {
    recorded.calls.push(entry);
    return Promise.resolve();
  };
  return {
    fetchOrigin: ({ prune }) => call(prune ? 'fetch --prune' : 'fetch'),
    currentBranch: () => Promise.resolve('feature'),
    pullFastForward: (branch) => call(`pull --ff-only ${branch}`),
    pullRebase: (branch) =>
      recorded.rebaseFails
        ? Promise.reject(new Error('rebase failed'))
        : call(`pull --rebase ${branch}`),
    isRebaseInProgress: () => Promise.resolve(recorded.rebaseFails),
    hasAutostashEntry: () => Promise.resolve(false),
    hasUnmergedPaths: () => Promise.resolve(false),
  };
}

let dataDir: string;
let originalDataDir: string | undefined;
let recordingRuntime: DesktopCanopyDispatcher;
let desktopRuntime: DesktopCanopyDispatcher;
const recorded: Recorded = { scopes: [], calls: [], rebaseFails: false };

beforeAll(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'git-sync-write-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  const host: WorkerGitSyncWriteHost<string> = {
    authorityId: 'local-desktop',
    resolveCheckout: (scope) => {
      recorded.scopes.push(scope);
      return Promise.resolve('/checkout');
    },
    port: () => fakePort(recorded),
  };
  recordingRuntime = createDesktopRuntime({ workerGitSyncWriteHost: host });
  desktopRuntime = createDesktopRuntime();
});

afterAll(async () => {
  await recordingRuntime.shutdown();
  await desktopRuntime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  recorded.scopes = [];
  recorded.calls = [];
  recorded.rebaseFails = false;
  jest.clearAllMocks();
});

const request = { projectId: 'ws-1', worktreeId: 'wt-1' };
const rootEntry = (): { repoPath: string; repoId: string } => ({
  repoPath: getWorkspaceWorktreeDir('ws-1', 'wt-1'),
  repoId: SINGLE_REPO_USAGE_REPO_ID,
});

describe('worker.git fetch and pull projections', () => {
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
  ])(
    'fetches and pulls for %s through the dispatcher',
    async (_name, caller) => {
      await fetchWorktreeRepository(
        recordingRuntime,
        caller,
        request,
        rootEntry(),
        { prune: true },
      );
      await pullWorktreeRepository(
        recordingRuntime,
        caller,
        request,
        rootEntry(),
        {
          branch: 'feature',
          strategy: 'rebase',
        },
      );
      expect(recorded.scopes).toEqual([
        { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        { workspaceId: 'ws-1', worktreeId: 'wt-1' },
      ]);
      expect(recorded.calls).toEqual([
        'fetch --prune',
        'pull --rebase feature',
      ]);
      expect(git.fetchOrigin).not.toHaveBeenCalled();
      expect(git.pullBranchRebase).not.toHaveBeenCalled();
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
      fetchWorktreeRepository(recordingRuntime, caller, request, rootEntry(), {
        prune: true,
      }),
    ).rejects.toThrow(
      new Error(
        'Git fetch and pull are available only from the desktop app on this machine.',
      ),
    );
    await expect(
      pullWorktreeRepository(recordingRuntime, caller, request, rootEntry(), {
        branch: 'feature',
        strategy: 'fast-forward',
      }),
    ).rejects.toThrow('Git fetch and pull are available only');
    expect(recorded.scopes).toEqual([]);
    expect(recorded.calls).toEqual([]);
  });

  it('dispatches a member repository and a source-backed root by their ids', async () => {
    await fetchWorktreeRepository(
      recordingRuntime,
      desktopUser,
      request,
      { repoPath: getWorkspaceWorktreeRepoDir('ws-1', 'wt-1', 'api'), repoId: 'api' }, // prettier-ignore
      { prune: false },
    );
    await fetchWorktreeRepository(
      recordingRuntime,
      desktopUser,
      request,
      { repoPath: getWorkspaceWorktreeDir('ws-1', 'wt-1'), repoId: WORKSPACE_ROOT_REPO_ID }, // prettier-ignore
      { prune: false },
    );
    expect(recorded.scopes).toEqual([
      { workspaceId: 'ws-1', worktreeId: 'wt-1', repoId: 'api' },
      { workspaceId: 'ws-1', worktreeId: 'wt-1' },
    ]);
  });

  it('dispatches a code-review chat scope as the real worktree it borrows', async () => {
    await registerCodeReviewTarget('ws-1--wt-1', {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
    await fetchWorktreeRepository(
      recordingRuntime,
      desktopUser,
      { projectId: CODE_REVIEW_CHAT_PROJECT_ID, worktreeId: 'ws-1--wt-1' },
      rootEntry(),
      { prune: true },
    );
    expect(recorded.scopes).toEqual([
      { workspaceId: 'ws-1', worktreeId: 'wt-1' },
    ]);
  });

  it("keeps the direct call for entries that are not the scope's workspace checkout", async () => {
    const overlong = `w${'x'.repeat(600)}`;
    for (const [entryRequest, entry] of [
      // A path that is not the workspace worktree.
      [request, { repoPath: '/elsewhere', repoId: SINGLE_REPO_USAGE_REPO_ID }],
      // A member directory name the validators refuse.
      [
        request,
        {
          repoPath: getWorkspaceWorktreeRepoDir('ws-1', 'wt-1', 'API'),
          repoId: 'API',
        },
      ],
      // Identifiers longer than the scope carries (CAN-5136).
      [
        { projectId: 'ws-1', worktreeId: overlong },
        {
          repoPath: getWorkspaceWorktreeDir('ws-1', overlong),
          repoId: SINGLE_REPO_USAGE_REPO_ID,
        },
      ],
    ] as const) {
      await fetchWorktreeRepository(
        recordingRuntime,
        desktopUser,
        entryRequest,
        entry,
        { prune: true },
      );
      await pullWorktreeRepository(
        recordingRuntime,
        desktopUser,
        entryRequest,
        entry,
        { branch: 'feature', strategy: 'fast-forward' },
      );
      expect(git.fetchOrigin).toHaveBeenLastCalledWith(entry.repoPath, {
        prune: true,
        signal: ANY_SIGNAL,
      });
      expect(git.pullBranchFastForward).toHaveBeenLastCalledWith(
        entry.repoPath,
        'feature',
      );
    }
    expect(recorded.scopes).toEqual([]);
  });

  it('keeps the direct call for the App Advisor, standalone and cowork homes', async () => {
    registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
    try {
      for (const homeRequest of [
        { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'home' },
        { projectId: STANDALONE_CHAT_PROJECT_ID, worktreeId: 'chat-1' },
        { projectId: 'cowork-1', worktreeId: 'entry-1' },
      ]) {
        // github:pull's entry for these scopes: the resolved home itself.
        const entry = {
          repoPath: resolveWorktreeCwd(
            homeRequest.projectId,
            homeRequest.worktreeId,
          ),
          repoId: SINGLE_REPO_USAGE_REPO_ID,
        };
        await fetchWorktreeRepository(
          recordingRuntime,
          desktopUser,
          homeRequest,
          entry,
          { prune: true },
        );
        await pullWorktreeRepository(
          recordingRuntime,
          desktopUser,
          homeRequest,
          entry,
          { branch: 'feature', strategy: 'rebase' },
        );
        expect(git.fetchOrigin).toHaveBeenLastCalledWith(entry.repoPath, {
          prune: true,
          signal: ANY_SIGNAL,
        });
        expect(git.pullBranchRebase).toHaveBeenLastCalledWith(
          entry.repoPath,
          'feature',
        );
      }
      expect(recorded.scopes).toEqual([]);
    } finally {
      registerWorkspaceTypes(new Map());
    }
  });

  it('keeps the direct call when a borrowed chat scope is unregistered mid-pull', async () => {
    await expect(
      fetchWorktreeRepository(
        recordingRuntime,
        desktopUser,
        { projectId: CODE_REVIEW_CHAT_PROJECT_ID, worktreeId: 'ws-1--gone' },
        rootEntry(),
        { prune: true },
      ),
    ).resolves.toBeUndefined();
    expect(git.fetchOrigin).toHaveBeenCalledWith(rootEntry().repoPath, {
      prune: true,
      signal: ANY_SIGNAL,
    });
    expect(recorded.scopes).toEqual([]);
  });

  it('fails a conflict outcome no desktop host captured instead of reporting success', async () => {
    recorded.rebaseFails = true;
    await expect(
      pullWorktreeRepository(
        recordingRuntime,
        desktopUser,
        request,
        rootEntry(),
        { branch: 'feature', strategy: 'rebase' },
      ),
    ).rejects.toThrow('The pull conflict was not captured in this context.');
  });
});

describe('the desktop fetch and pull host', () => {
  it('fetches through fetchOrigin with a signal that never aborts', async () => {
    await fetchWorktreeRepository(
      desktopRuntime,
      desktopUser,
      request,
      rootEntry(),
      { prune: true },
    );
    expect(git.fetchOrigin).toHaveBeenCalledTimes(1);
    expect(git.fetchOrigin).toHaveBeenCalledWith(rootEntry().repoPath, {
      prune: true,
      signal: ANY_SIGNAL,
    });
    const options = jest.mocked(git.fetchOrigin).mock.calls[0]?.[1];
    expect(options?.signal?.aborted).toBe(false);
  });

  it("rethrows a failed fetch's own Git error", async () => {
    const gitError = Object.assign(new Error('remote: Authentication failed'), {
      stderr: 'remote: Authentication failed',
    });
    jest.mocked(git.fetchOrigin).mockRejectedValueOnce(gitError);
    await expect(
      fetchWorktreeRepository(
        desktopRuntime,
        desktopUser,
        request,
        rootEntry(),
        {
          prune: true,
        },
      ),
    ).rejects.toBe(gitError);
  });

  it('hands a rebase conflict the Git error the pull failed with', async () => {
    const gitError = Object.assign(new Error('pull failed'), {
      stderr: 'CONFLICT (content): Merge conflict',
    });
    jest.mocked(git.pullBranchRebase).mockRejectedValueOnce(gitError);
    jest.mocked(git.isRebaseInProgress).mockResolvedValueOnce(true);
    await expect(
      pullWorktreeRepository(
        desktopRuntime,
        desktopUser,
        request,
        rootEntry(),
        {
          branch: 'feature',
          strategy: 'rebase',
        },
      ),
    ).rejects.toBe(gitError);
    expect(git.pullBranchRebase).toHaveBeenCalledWith(
      rootEntry().repoPath,
      'feature',
    );
  });

  it('rethrows an unclassified rebase failure and a refused fast-forward unchanged', async () => {
    const rebaseError = new Error('fatal: rebase failed');
    jest.mocked(git.pullBranchRebase).mockRejectedValueOnce(rebaseError);
    await expect(
      pullWorktreeRepository(
        desktopRuntime,
        desktopUser,
        request,
        rootEntry(),
        {
          branch: 'feature',
          strategy: 'rebase',
        },
      ),
    ).rejects.toBe(rebaseError);
    const forwardError = new Error('fatal: Not possible to fast-forward');
    jest.mocked(git.pullBranchFastForward).mockRejectedValueOnce(forwardError);
    await expect(
      pullWorktreeRepository(
        desktopRuntime,
        desktopUser,
        request,
        rootEntry(),
        {
          branch: 'feature',
          strategy: 'fast-forward',
        },
      ),
    ).rejects.toBe(forwardError);
    expect(git.isRebaseInProgress).toHaveBeenCalledTimes(1);
  });
});
