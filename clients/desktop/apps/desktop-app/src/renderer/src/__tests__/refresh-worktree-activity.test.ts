import type { CanopyApi } from '@canopy/desktop-shared/types';
import { refreshWorktreeActivity } from '../components/worktree/refresh-worktree-activity';
import { useActivityStore } from '../stores/activityStore';
import { useGitHubStore } from '../stores/githubStore';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

describe('refreshWorktreeActivity', () => {
  const getChangedFiles = jest.fn();
  const setChangedFiles = jest.fn();
  const requestFastRefresh = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          activity: {
            getChangedFiles,
          },
        },
      },
    });

    useActivityStore.setState({ setChangedFiles } as never);
    useGitHubStore.setState({ requestFastRefresh } as never);
    requestFastRefresh.mockResolvedValue(undefined);
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('reloads changed files before requesting a fast refresh', async () => {
    getChangedFiles.mockResolvedValue({ repos: [] });

    await refreshWorktreeActivity('project-1', 'worktree-1');

    expect(getChangedFiles).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(setChangedFiles).toHaveBeenCalledWith('project-1', 'worktree-1', {
      repos: [],
    });
    expect(requestFastRefresh).toHaveBeenCalledWith('project-1', 'worktree-1');
  });

  it('still requests a fast refresh when changed files reload fails', async () => {
    getChangedFiles.mockRejectedValue(new Error('offline'));

    await refreshWorktreeActivity('project-1', 'worktree-1');

    expect(setChangedFiles).not.toHaveBeenCalled();
    expect(requestFastRefresh).toHaveBeenCalledWith('project-1', 'worktree-1');
  });
});
