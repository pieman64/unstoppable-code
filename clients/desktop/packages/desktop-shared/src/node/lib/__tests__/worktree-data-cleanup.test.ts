jest.mock('node:fs/promises');
jest.mock('../../../canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => '/tmp/canopy-data'),
}));

import { rm } from 'node:fs/promises';
import {
  removePersistedWorktreeDataDirectory,
  WORKTREE_DATA_REMOVE_MAX_RETRIES,
  WORKTREE_DATA_REMOVE_RETRY_DELAY_MS,
} from '../worktree-data-cleanup';

const mockedRm = jest.mocked(rm);

describe('removePersistedWorktreeDataDirectory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRm.mockResolvedValue(undefined);
  });

  it('removes the worktree data directory recursively with retries', async () => {
    await removePersistedWorktreeDataDirectory('workspace-1', 'worktree-1');

    expect(mockedRm).toHaveBeenCalledWith(
      '/tmp/canopy-data/workspaces/workspace-1/worktree-data/worktree-1',
      {
        recursive: true,
        force: true,
        maxRetries: WORKTREE_DATA_REMOVE_MAX_RETRIES,
        retryDelay: WORKTREE_DATA_REMOVE_RETRY_DELAY_MS,
      },
    );
  });

  it('honors an app-managed worktree-data root override', async () => {
    mockedRm.mockResolvedValue(undefined);
    await removePersistedWorktreeDataDirectory('app-advisor', 'entry-1', {
      worktreeDataRootDir:
        '/tmp/canopy-data/app-workspaces/app-advisor/worktree-data',
    });
    expect(mockedRm).toHaveBeenCalledWith(
      '/tmp/canopy-data/app-workspaces/app-advisor/worktree-data/entry-1',
      {
        recursive: true,
        force: true,
        maxRetries: WORKTREE_DATA_REMOVE_MAX_RETRIES,
        retryDelay: WORKTREE_DATA_REMOVE_RETRY_DELAY_MS,
      },
    );
  });

  it('treats an absent directory as success', async () => {
    mockedRm.mockResolvedValue(undefined);
    await expect(
      removePersistedWorktreeDataDirectory('workspace-1', 'worktree-1'),
    ).resolves.toBeUndefined();
  });

  it('uses the host removal adapter with the validated path and retry policy', async () => {
    const removeTree = jest.fn((): Promise<void> => Promise.resolve());
    const options = {
      worktreeDataRootDir: '/tmp/host-worktree-data',
      removeTree,
    };
    await removePersistedWorktreeDataDirectory(
      'workspace-1',
      'worktree-1',
      options,
    );

    expect(removeTree).toHaveBeenCalledWith(
      '/tmp/host-worktree-data/worktree-1',
      {
        recursive: true,
        force: true,
        maxRetries: WORKTREE_DATA_REMOVE_MAX_RETRIES,
        retryDelay: WORKTREE_DATA_REMOVE_RETRY_DELAY_MS,
      },
    );
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('validates ids before invoking a host removal adapter', async () => {
    const removeTree = jest.fn((): Promise<void> => Promise.resolve());
    const options = {
      worktreeDataRootDir: '/tmp/host-worktree-data',
      removeTree,
    };
    await expect(
      removePersistedWorktreeDataDirectory(
        'workspace-1',
        '../worktree',
        options,
      ),
    ).rejects.toThrow('Invalid');
    expect(removeTree).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it.each([
    ['../workspace', 'worktree-1'],
    ['workspace-1', '../worktree'],
    ['', 'worktree-1'],
  ])('rejects unsafe ids before removal', async (workspaceId, worktreeId) => {
    await expect(
      removePersistedWorktreeDataDirectory(workspaceId, worktreeId),
    ).rejects.toThrow('Invalid');
    expect(mockedRm).not.toHaveBeenCalled();
  });
});
