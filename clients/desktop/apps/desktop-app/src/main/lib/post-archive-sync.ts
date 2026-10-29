import { readAllSidebarItems } from './sidebar-items';
import { getSidebarItemsPreserveWorkspaceIds } from './sidebar-items-preservation';
import { syncTrackedWorktrees as syncTrackedGitHubWorktrees } from './github-poller';

export function queueTrackedGitHubWorktreeSync(): void {
  void readAllSidebarItems()
    .then((result) =>
      syncTrackedGitHubWorktrees(
        result.items,
        new Set(getSidebarItemsPreserveWorkspaceIds(result)),
      ),
    )
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[github-sync] post-archive tracked worktree sync failed', {
        error,
      });
    });
}
