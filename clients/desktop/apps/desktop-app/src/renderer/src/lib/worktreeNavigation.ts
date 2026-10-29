import { type SidebarItem } from '@canopy/desktop-shared/types';
import { isCoworkChatTarget, isCoworkWorkspaceId } from './cowork';

export function canNavigateToWorktreeFromSidebarItems(
  projects: SidebarItem[],
  projectId: string,
  worktreeId: string,
  hasHydratedProjects: boolean,
): boolean {
  // Cowork Work Entries occupy the worktreeId slot and are not statically
  // known here (they live in the per-workspace work-entries registry), so
  // any worktreeId under a cowork workspace is treated as navigable —
  // matching the legacy-sentinel branch's permissiveness below. Selection
  // safety (only real entries get selected) is enforced by the standalone
  // chat store.
  if (isCoworkWorkspaceId(projectId, projects)) {
    return true;
  }

  if (isCoworkChatTarget(projectId)) {
    return true;
  }

  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    return !hasHydratedProjects;
  }

  return (
    project.type !== 'cowork' &&
    project.worktrees.some((worktree) => worktree.id === worktreeId)
  );
}
