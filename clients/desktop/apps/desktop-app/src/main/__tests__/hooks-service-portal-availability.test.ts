import {
  getProjectRepoStorageKey,
  getWorkspaceRepoStorageKey,
  getWorkspaceRootRepoStorageKey,
} from '../lib/github-pr-hook-state';
import { portalHookRunAvailability } from '../services/hooks-service';

describe('portalHookRunAvailability', () => {
  it.each([
    ['project', undefined, (): string => getProjectRepoStorageKey()],
    [
      'workspace-root',
      undefined,
      (): string => getWorkspaceRootRepoStorageKey(),
    ],
    [
      'workspace-repo',
      'repo-1',
      (): string => getWorkspaceRepoStorageKey('repo-1'),
    ],
  ] as const)(
    'keeps %s hooks runnable when their target PR snapshot exists',
    async (target, repoId, getRepoStorageKey) => {
      const readSnapshot = jest.fn().mockResolvedValue({
        snapshot: {} as never,
        currentSnapshotPath: '/current',
        previousSnapshotPath: '/previous',
      });

      await expect(
        portalHookRunAvailability(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            target,
            repoId,
          },
          readSnapshot,
        ),
      ).resolves.toEqual({});
      expect(readSnapshot).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoStorageKey: getRepoStorageKey(),
      });
    },
  );

  it.each([
    ['project', undefined],
    ['workspace-root', undefined],
    ['workspace-repo', 'repo-1'],
  ] as const)(
    'disables %s hooks when their target PR snapshot is absent',
    async (target, repoId) => {
      const readSnapshot = jest.fn().mockResolvedValue({
        snapshot: null,
        currentSnapshotPath: '/current',
        previousSnapshotPath: '/previous',
      });

      await expect(
        portalHookRunAvailability(
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            target,
            repoId,
          },
          readSnapshot,
        ),
      ).resolves.toEqual({
        runDisabled: true,
        runDisabledReason: 'Manual run requires an active PR',
      });
    },
  );
});
