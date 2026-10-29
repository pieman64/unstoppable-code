import type { SidebarItem } from '../types';

/**
 * Whether a workspace that is not configured to always show still has live
 * content that keeps it visible.
 */
export function hasVisibleWorkspaceContent(workspace: SidebarItem): boolean {
  if (workspace.type === 'cowork') {
    return (workspace.workEntryCount ?? 0) > 0;
  }
  return workspace.worktrees.some((worktree) => worktree.hidden !== true);
}

/**
 * Whether a temporary multi-repo workspace has nothing left to show: no
 * worktree, no retained archived container, and no explicit Always show.
 * Only `alwaysShow: true` keeps an empty combination; false or absent permits
 * retirement. Ownership is independent of retirement. Projects IPC, the
 * projects store, and the desktop session snapshot use this policy before
 * serialization can omit explicit true.
 */
export function isRetiredTemporaryWorkspace(workspace: SidebarItem): boolean {
  return (
    workspace.type === 'multi-repo' &&
    workspace.temporary === true &&
    workspace.alwaysShow !== true &&
    workspace.worktrees.length === 0 &&
    (workspace.archivedContainerCount ?? 0) === 0
  );
}
