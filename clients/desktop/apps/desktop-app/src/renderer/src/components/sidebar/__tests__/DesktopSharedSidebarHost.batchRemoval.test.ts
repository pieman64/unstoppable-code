/** @jest-environment jsdom */
import { TeardownFailedError, useProjectsStore } from '@/stores/projectsStore';
import { finishWorktreeArchive } from '@/components/worktree/finishWorktreeArchive';
import {
  desktopWorkEntryBatchRemovalFacts,
  desktopWorkEntryBulkState,
  removeDesktopWorkEntryInBatch,
  removeDesktopWorktreeInBatch,
} from '../DesktopSharedSidebarHost';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useDelegationActivityStore } from '@/stores/delegationActivityStore';
import { useLiveBackgroundTaskStore } from '@/stores/liveBackgroundTaskStore';
import {
  BACKGROUND_BLOCKS_REMOVAL_TOOLTIP,
  DELEGATES_BLOCK_REMOVAL_TOOLTIP,
} from '@/stores/chat/close-guard';
import type { CoworkWorkEntryMeta } from '@canopy/desktop-shared/types';

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
    ).rejects.toThrow('Teardown script failed. Try again from the row menu.');
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

describe('removeDesktopWorkEntryInBatch', () => {
  it('archives a Work Entry through the store with lockAfterArchive', async () => {
    const deleteWorkEntry = jest.fn((): Promise<void> => Promise.resolve());
    useStandaloneChatStore.setState({ deleteWorkEntry });
    await removeDesktopWorkEntryInBatch('cowork-default', 'entry-1', {
      mode: 'archive',
    });
    expect(deleteWorkEntry).toHaveBeenCalledWith('entry-1', 'cowork-default', {
      lockAfterArchive: true,
    });
  });

  it('deletes without the lock and surfaces the store rejection', async () => {
    const deleteWorkEntry = jest.fn(
      (): Promise<void> => Promise.reject(new Error('flush failed')),
    );
    useStandaloneChatStore.setState({ deleteWorkEntry });
    await expect(
      removeDesktopWorkEntryInBatch('cowork-default', 'entry-1', {
        mode: 'delete',
      }),
    ).rejects.toThrow('flush failed');
    expect(deleteWorkEntry).toHaveBeenCalledWith('entry-1', 'cowork-default', {
      lockAfterArchive: false,
    });
  });
});

describe('desktopWorkEntryBatchRemovalFacts', () => {
  const entry: CoworkWorkEntryMeta = {
    id: 'entry-1',
    title: 'Plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    chatCount: 1,
  };

  beforeEach(() => {
    useStandaloneChatStore.setState({
      activeChatProjectId: 'other',
      workEntries: [],
      sidebarEntriesByProject: { 'cowork-default': [entry] },
    });
    useDelegationActivityStore.setState({ byChat: {} });
    useLiveBackgroundTaskStore.setState({ byChat: {} });
  });

  it('reports a missing entry as undefined, live delegates as blocked, and otherwise empty facts', () => {
    expect(
      desktopWorkEntryBatchRemovalFacts('cowork-default', 'gone'),
    ).toBeUndefined();
    expect(
      desktopWorkEntryBatchRemovalFacts('cowork-default', 'entry-1'),
    ).toEqual({});
    useDelegationActivityStore.setState({
      byChat: {
        chat: {
          projectId: 'cowork-default',
          worktreeId: 'entry-1',
          chatId: 'chat',
          live: 1,
          queued: 0,
        },
      },
    });
    expect(
      desktopWorkEntryBatchRemovalFacts('cowork-default', 'entry-1'),
    ).toEqual({ blockedReason: DELEGATES_BLOCK_REMOVAL_TOOLTIP });
  });

  it('blocks an entry with close-blocking provider work, as the single row does', () => {
    useLiveBackgroundTaskStore.setState({
      byChat: {
        chat: {
          projectId: 'cowork-default',
          worktreeId: 'entry-1',
          chatId: 'chat',
          sessionActive: true,
          liveTasks: [{ taskId: 'task', taskType: 'local_agent' }],
        },
      },
    });
    expect(
      desktopWorkEntryBatchRemovalFacts('cowork-default', 'entry-1'),
    ).toEqual({ blockedReason: BACKGROUND_BLOCKS_REMOVAL_TOOLTIP });
  });

  it("reads a Work Entry's pin and done state from the store", () => {
    useStandaloneChatStore.setState({
      sidebarEntriesByProject: {
        'cowork-default': [{ ...entry, pinned: true, status: 'done' }],
      },
    });
    expect(desktopWorkEntryBulkState('cowork-default', 'entry-1')).toEqual({
      pinned: true,
      done: true,
    });
    expect(
      desktopWorkEntryBulkState('cowork-default', 'missing'),
    ).toBeUndefined();
  });

  it('an entry with neither flag is unpinned and active', () => {
    expect(desktopWorkEntryBulkState('cowork-default', 'entry-1')).toEqual({
      pinned: false,
      done: false,
    });
  });
});
