import '../../../__tests__/worktree-replica-compatibility';
// CAN-3820: the W5 branch rename command (`core.worktree.branch.rename`).
// Git is mocked; the worktree list is the real persistence module against a
// temporary data dir, so the persisted row is checked through `worktrees.json`.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
// The checkout of a worktree resolves through its workspace type; the
// command only needs where it is.
jest.mock('../resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/checkouts/${projectId}/${worktreeId}`,
  ),
}));
jest.mock('../git', () => ({
  isBranchNameAvailable: jest.fn(),
  renameBranch: jest.fn(),
  validateBranchName: jest.fn(),
}));
let mockFailNextWrite = false;
jest.mock('../atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFile>('../atomic-file');
  return {
    ...actual,
    writeFileAtomically: async (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): Promise<void> => {
      if (mockFailNextWrite) {
        mockFailNextWrite = false;
        throw new Error('disk full');
      }
      return actual.writeFileAtomically(...args);
    },
  };
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import type * as AtomicFile from '../atomic-file';
import {
  isBranchNameAvailable,
  renameBranch,
  validateBranchName,
} from '../git';
import {
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreesFilePath,
} from '../paths';
import {
  clearWorktreesSelfWriteTracking,
  readWorkspaceWorktrees,
} from '../workspace-persistence';
import {
  renameWorktreeBranch,
  WorktreeBranchRenameRefusedError,
} from '../worktree-branch-rename';
import { inProcessBranchRenameGit } from '../../__tests__/helpers/in-process-branch-rename-git';

const mockedValidateBranchName = jest.mocked(validateBranchName);
const mockedIsBranchNameAvailable = jest.mocked(isBranchNameAvailable);
const mockedRenameBranch = jest.mocked(renameBranch);

let WORKSPACE_ID = 'project';
let workspaceCount = 0;
const CREATED_AT = '2026-10-01T00:00:00.000Z';

const PR_STATUS: WorktreePrStatus = {
  lastCheckedAt: '2026-10-02T00:00:00.000Z',
  repos: [{ repoId: 'repo', repoName: 'repo', status: null }],
};

function row(id: string, extra: Partial<WorktreeData> = {}): WorktreeData {
  return { id, branchName: `branch-${id}`, createdAt: CREATED_AT, ...extra };
}

describe('renameWorktreeBranch (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let listPath: string;

  async function writeList(worktrees: unknown[]): Promise<string> {
    await mkdir(path.dirname(listPath), { recursive: true });
    const contents = JSON.stringify({ version: 1, worktrees }, null, 2);
    await writeFile(listPath, contents);
    return contents;
  }

  async function readRow(id: string): Promise<WorktreeData | undefined> {
    const worktrees = await readWorkspaceWorktrees(WORKSPACE_ID);
    return worktrees.find((worktree) => worktree.id === id);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFailNextWrite = false;
    mockedValidateBranchName.mockResolvedValue(true);
    mockedIsBranchNameAvailable.mockResolvedValue(true);
    mockedRenameBranch.mockResolvedValue(undefined);
    workspaceCount += 1;
    WORKSPACE_ID = `project-${workspaceCount}`;
    clearWorktreesSelfWriteTracking(WORKSPACE_ID);
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-branch-rename-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    listPath = getWorkspaceWorktreesFilePath(WORKSPACE_ID);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('renames the checkout branch and records it, clearing the old PR status', async () => {
    await writeList([
      row('wt-1', { lastKnownPrStatus: PR_STATUS, status: 'done' }),
      row('wt-2'),
    ]);

    const outcome = await renameWorktreeBranch(
      {
        source: 'desktop',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        newBranchName: 'feature/renamed',
      },
      inProcessBranchRenameGit,
    );

    const checkout = `/checkouts/${WORKSPACE_ID}/wt-1`;
    expect(mockedValidateBranchName).toHaveBeenCalledWith(
      checkout,
      'feature/renamed',
    );
    expect(mockedRenameBranch).toHaveBeenCalledWith(
      checkout,
      'feature/renamed',
    );
    const renamed = row('wt-1', {
      branchName: 'feature/renamed',
      lastKnownPrStatus: null,
    });
    expect(outcome).toEqual({
      branchName: 'feature/renamed',
      worktree: renamed,
    });
    expect(await readWorkspaceWorktrees(WORKSPACE_ID)).toEqual([
      renamed,
      row('wt-2'),
    ]);
  });

  it('keeps the sidebar branch when a member repository is renamed', async () => {
    await writeList([row('wt-1', { lastKnownPrStatus: PR_STATUS })]);

    await renameWorktreeBranch(
      {
        source: 'desktop',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        repoId: 'repo-b',
        newBranchName: 'feature/member',
      },
      inProcessBranchRenameGit,
    );

    expect(mockedRenameBranch).toHaveBeenCalledWith(
      getWorkspaceWorktreeRepoDir(WORKSPACE_ID, 'wt-1', 'repo-b'),
      'feature/member',
    );
    expect(await readRow('wt-1')).toEqual(
      row('wt-1', { lastKnownPrStatus: null }),
    );
  });

  it('renames the source-backed root through the worktree checkout', async () => {
    await writeList([row('wt-1')]);

    await renameWorktreeBranch(
      {
        source: 'desktop',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        repoId: WORKSPACE_ROOT_REPO_ID,
        newBranchName: 'feature/root',
      },
      inProcessBranchRenameGit,
    );

    expect(mockedRenameBranch).toHaveBeenCalledWith(
      `/checkouts/${WORKSPACE_ID}/wt-1`,
      'feature/root',
    );
    expect(await readRow('wt-1')).toEqual(
      row('wt-1', { branchName: 'feature/root', lastKnownPrStatus: null }),
    );
  });

  it.each([
    [
      'an invalid branch name',
      (): void => {
        mockedValidateBranchName.mockResolvedValue(false);
      },
      'invalid-branch-name',
      'Invalid branch name: "feature/renamed"',
    ],
    [
      'a branch name already in use',
      (): void => {
        mockedIsBranchNameAvailable.mockResolvedValue(false);
      },
      'branch-unavailable',
      'Branch name "feature/renamed" is already in use',
    ],
  ])(
    'refuses %s before renaming or writing',
    async (_label, arrange, reason, message) => {
      const contents = await writeList([row('wt-1')]);
      arrange();

      const renaming = renameWorktreeBranch(
        {
          source: 'desktop',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          newBranchName: 'feature/renamed',
        },
        inProcessBranchRenameGit,
      );

      await expect(renaming).rejects.toBeInstanceOf(
        WorktreeBranchRenameRefusedError,
      );
      await expect(renaming).rejects.toMatchObject({
        name: 'Error',
        reason,
        message,
      });
      expect(mockedRenameBranch).not.toHaveBeenCalled();
      expect(await readFile(listPath, 'utf8')).toBe(contents);
    },
  );

  it('refuses the read-only shared-container scope before any Git work', async () => {
    await expect(
      renameWorktreeBranch(
        {
          source: 'desktop',
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'wt-1',
          newBranchName: 'feature/renamed',
        },
        inProcessBranchRenameGit,
      ),
    ).rejects.toMatchObject({
      reason: 'read-only-scope',
      message: 'Shared-container recipient workspaces are read-only',
    });
    expect(mockedValidateBranchName).not.toHaveBeenCalled();
  });

  it('refuses an invalid repository id before any Git work', async () => {
    await expect(
      renameWorktreeBranch(
        {
          source: 'desktop',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          repoId: '../repo',
          newBranchName: 'feature/renamed',
        },
        inProcessBranchRenameGit,
      ),
    ).rejects.toThrow('Invalid repoId');
    expect(mockedValidateBranchName).not.toHaveBeenCalled();
  });

  it('reports a worktree that disappeared without creating or bringing back its row', async () => {
    const contents = await writeList([row('wt-2')]);

    await expect(
      renameWorktreeBranch(
        {
          source: 'desktop',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          newBranchName: 'feature/renamed',
        },
        inProcessBranchRenameGit,
      ),
    ).rejects.toMatchObject({
      reason: 'not-found',
      message: `Worktree metadata not found for ${WORKSPACE_ID}/wt-1`,
    });
    expect(await readFile(listPath, 'utf8')).toBe(contents);
  });

  it('surfaces a failed write and leaves the list as it was', async () => {
    const contents = await writeList([row('wt-1')]);
    mockFailNextWrite = true;

    await expect(
      renameWorktreeBranch(
        {
          source: 'desktop',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'wt-1',
          newBranchName: 'feature/renamed',
        },
        inProcessBranchRenameGit,
      ),
    ).rejects.toThrow('disk full');
    expect(await readFile(listPath, 'utf8')).toBe(contents);
  });
});
