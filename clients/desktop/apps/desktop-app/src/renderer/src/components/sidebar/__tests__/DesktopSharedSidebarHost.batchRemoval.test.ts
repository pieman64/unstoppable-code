/** @jest-environment jsdom */
import { TeardownFailedError, useProjectsStore } from '@/stores/projectsStore';
import { finishWorktreeArchive } from '@/components/worktree/finishWorktreeArchive';
import { removeDesktopWorktreeInBatch } from '../DesktopSharedSidebarHost';

jest.mock('@/components/worktree/finishWorktreeArchive', () => ({
  finishWorktreeArchive: jest.fn(),
}));

const finish = jest.mocked(finishWorktreeArchive);

describe('removeDesktopWorktreeInBatch (CAN-3975)', () => {
  const archiveWorktree = jest.fn((): Promise<void> => Promise.resolve());

  beforeEach(() => {
    archiveWorktree.mockClear();
    finish.mockClear();
    useProjectsStore.setState({
      archiveWorktree,
      projects: [
        {
          type: 'multi-repo',
          id: 'project-a',
          name: 'Project A',
          color: '#111111',
          repos: [],
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature/one',
              createdAt: '2026-01-01T00:00:00.000Z',
              status: 'done',
            },
            {
              id: 'wt-2',
              branchName: 'feature/two',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });
  });

  it('archives with the single confirm options and cleans up after', async () => {
    await removeDesktopWorktreeInBatch('project-a', 'wt-1', {
      mode: 'archive',
      deleteBranch: true,
    });
    expect(archiveWorktree).toHaveBeenCalledWith('project-a', 'wt-1', {
      deleteBranch: true,
      expectedBranchName: 'feature/one',
      lockAfterArchive: true,
    });
    // A merged multi-repo worktree refreshes its reference repositories.
    expect(finish).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      refreshReferenceRepos: true,
    });
  });

  it('deletes without retention for a missing checkout and keeps the branch unless asked', async () => {
    await removeDesktopWorktreeInBatch('project-a', 'wt-2', {
      mode: 'delete',
    });
    expect(archiveWorktree).toHaveBeenCalledWith('project-a', 'wt-2', {
      deleteBranch: false,
      expectedBranchName: 'feature/two',
      deleteWithoutRetentionIfMissing: true,
    });
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ refreshReferenceRepos: false }),
    );
  });

  it('guards the branch the confirm showed, not the one stored when the item runs', async () => {
    await removeDesktopWorktreeInBatch('project-a', 'wt-2', {
      mode: 'delete',
      deleteBranch: true,
      expectedBranchName: 'feature/confirmed',
    });
    expect(archiveWorktree).toHaveBeenCalledWith('project-a', 'wt-2', {
      deleteBranch: true,
      expectedBranchName: 'feature/confirmed',
      deleteWithoutRetentionIfMissing: true,
    });
  });

  it('fails a worktree the store cannot find instead of resolving silently', async () => {
    await expect(
      removeDesktopWorktreeInBatch('project-a', 'missing', { mode: 'archive' }),
    ).rejects.toThrow('Worktree was not found');
    expect(archiveWorktree).not.toHaveBeenCalled();
  });

  it('maps a teardown failure to a retry reason and skips cleanup', async () => {
    archiveWorktree.mockRejectedValueOnce(
      new TeardownFailedError({
        projectId: 'project-a',
        worktreeId: 'wt-2',
        output: 'exit 1',
        timedOut: false,
      }),
    );
    await expect(
      removeDesktopWorktreeInBatch('project-a', 'wt-2', { mode: 'archive' }),
    ).rejects.toThrow('Teardown script failed. Retry from the row menu.');
    expect(finish).not.toHaveBeenCalled();
  });

  it('passes other failures through', async () => {
    archiveWorktree.mockRejectedValueOnce(new Error('archive failed'));
    await expect(
      removeDesktopWorktreeInBatch('project-a', 'wt-2', { mode: 'archive' }),
    ).rejects.toThrow('archive failed');
    expect(finish).not.toHaveBeenCalled();
  });
});
