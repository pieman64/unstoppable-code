jest.mock('node:fs/promises');
jest.mock('../services/plans-service');
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
  resolveTrackedPlansFilePath: jest.fn(),
}));
jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
  validateOptionalRepoId: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(),
}));

import { readFile, realpath } from 'node:fs/promises';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { createTrackedPlanData } from '../services/plans-service';
import {
  resolveWorktreeCwd,
  resolveTrackedPlansFilePath,
} from '../lib/resolve-worktree';
import { importTrackedPlanFromPath } from '../lib/plan-import';
import { getWorkspaceType } from '../lib/workspace-registry';

const mockedReadFile = jest.mocked(readFile);
const mockedRealpath = jest.mocked(realpath);
const mockedCreate = jest.mocked(createTrackedPlanData);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedResolveTrackedPlansFilePath = jest.mocked(
  resolveTrackedPlansFilePath,
);
const mockedGetWorkspaceType = jest.mocked(getWorkspaceType);

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const CHILD_REPO_ID = 'child-repo-1';

describe('importTrackedPlanFromPath — repoId cwd resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCreate.mockResolvedValue({ id: 'new-plan' });
    mockedRealpath.mockImplementation((path) => Promise.resolve(String(path)));
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/canopy/workspaces/proj-1/plans/wt-1.json',
    );
    mockedGetWorkspaceType.mockReturnValue(null);
  });

  it('rejects a relative path when repoId is undefined', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root');
    mockedReadFile.mockResolvedValue('# Plan content');

    await expect(
      importTrackedPlanFromPath({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        filePath: 'docs/plan.md',
        repoId: undefined,
      }),
    ).rejects.toThrow('Plan import requires repoId');

    expect(mockedResolveWorktreeCwd).not.toHaveBeenCalled();
    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it('resolves a relative path against the worktree root for WORKSPACE_ROOT_REPO_ID', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root');
    mockedReadFile.mockResolvedValue('# Plan content');

    await importTrackedPlanFromPath({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      filePath: 'docs/plan.md',
      repoId: WORKSPACE_ROOT_REPO_ID,
    });

    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
    );
    expect(mockedReadFile).toHaveBeenCalledWith(
      '/wt/root/docs/plan.md',
      'utf8',
    );
  });

  it('resolves a relative path against the worktree root for the __worktree__ sentinel', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root');
    mockedReadFile.mockResolvedValue('# Plan content');

    await importTrackedPlanFromPath({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      filePath: 'docs/plan.md',
      repoId: '__worktree__',
    });

    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
    );
    expect(mockedReadFile).toHaveBeenCalledWith(
      '/wt/root/docs/plan.md',
      'utf8',
    );
  });

  it('resolves a relative path against the child-repo dir for a real repoId', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root/repos/child-repo-1');
    mockedReadFile.mockResolvedValue('# Plan content');

    await importTrackedPlanFromPath({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      filePath: 'docs/plan.md',
      repoId: CHILD_REPO_ID,
    });

    // resolveWorktreeCwd called with the child repoId
    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      CHILD_REPO_ID,
    );
    expect(mockedReadFile).toHaveBeenCalledWith(
      '/wt/root/repos/child-repo-1/docs/plan.md',
      'utf8',
    );
  });

  it('treats the single-repo project primary root repoId as the worktree root', async () => {
    mockedGetWorkspaceType.mockReturnValue('single-repo');
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root');
    mockedReadFile.mockResolvedValue('# Plan content');

    await importTrackedPlanFromPath({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      filePath: 'docs/plan.md',
      repoId: PROJECT_ID,
    });

    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
    );
    expect(mockedResolveWorktreeCwd).not.toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      PROJECT_ID,
    );
    expect(mockedReadFile).toHaveBeenCalledWith(
      '/wt/root/docs/plan.md',
      'utf8',
    );
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFilePath: 'docs/plan.md',
        sourceRepoId: WORKSPACE_ROOT_REPO_ID,
      }),
    );
  });

  it('rejects absolute paths from path-based imports', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root');
    mockedReadFile.mockResolvedValue('# Plan content');

    await expect(
      importTrackedPlanFromPath({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        filePath: '/absolute/path/plan.md',
        repoId: CHILD_REPO_ID,
      }),
    ).rejects.toThrow('Plan import paths must be relative');

    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it('rejects relative paths that escape the resolved cwd', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root');
    mockedReadFile.mockResolvedValue('# Plan content');

    await expect(
      importTrackedPlanFromPath({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        filePath: '../outside/plan.md',
        repoId: WORKSPACE_ROOT_REPO_ID,
      }),
    ).rejects.toThrow('Plan import path must stay inside');

    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it('allows absolute paths only when explicitly requested by the native dialog path', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root');
    mockedReadFile.mockResolvedValue('# Plan content');

    await importTrackedPlanFromPath({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      filePath: '/absolute/path/plan.md',
      repoId: CHILD_REPO_ID,
      allowAbsolutePath: true,
    });

    expect(mockedReadFile).toHaveBeenCalledWith(
      '/absolute/path/plan.md',
      'utf8',
    );
  });

  it('creates the tracked plan with repo-relative provenance for repo-scoped imports', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root/repos/child-repo-1');
    mockedReadFile.mockResolvedValue('# Plan\ncontent');

    await importTrackedPlanFromPath({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      filePath: 'docs/plan.md',
      repoId: CHILD_REPO_ID,
    });

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        source: 'imported',
        content: '# Plan\ncontent',
        sourceFilePath: 'docs/plan.md',
        sourceRepoId: CHILD_REPO_ID,
      }),
    );
  });

  it('rejects disallowed file types before reading', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root');

    await expect(
      importTrackedPlanFromPath({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        filePath: '.env',
        repoId: WORKSPACE_ROOT_REPO_ID,
      }),
    ).rejects.toThrow('Only Markdown (.md) and plain text (.txt)');

    expect(mockedReadFile).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('stores explicit workspace-root repo provenance when requested', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root');
    mockedReadFile.mockResolvedValue('# Plan\ncontent');

    await importTrackedPlanFromPath({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      filePath: 'docs/plan.md',
      repoId: WORKSPACE_ROOT_REPO_ID,
    });

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFilePath: 'docs/plan.md',
        sourceRepoId: WORKSPACE_ROOT_REPO_ID,
      }),
    );
  });

  it('rejects symlink targets that escape the resolved cwd', async () => {
    mockedResolveWorktreeCwd.mockReturnValue('/wt/root');
    mockedRealpath.mockImplementation((path) => {
      if (String(path) === '/wt/root/docs/plan.md') {
        return Promise.resolve('/private/secret-plan.md');
      }
      return Promise.resolve(String(path));
    });

    await expect(
      importTrackedPlanFromPath({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        filePath: 'docs/plan.md',
        repoId: WORKSPACE_ROOT_REPO_ID,
      }),
    ).rejects.toThrow('Plan import path must stay inside');

    expect(mockedReadFile).not.toHaveBeenCalled();
  });
});
