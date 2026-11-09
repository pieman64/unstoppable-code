import type { ToastOrigin } from '@canopy/ui-shared/lib';
import { openInWorkspaceContext } from '@/lib/contextScope';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';

/** Whether a toast's worktree still exists and can be opened. */
export function canNavigateToToastWorktree(
  projectId: string,
  worktreeId: string,
): boolean {
  const { projects, hasHydratedProjects } = useProjectsStore.getState();
  return canNavigateToWorktreeFromSidebarItems(
    projects,
    projectId,
    worktreeId,
    hasHydratedProjects,
  );
}

export function navigateToToastWorktree(
  projectId: string,
  worktreeId: string,
  openChat?: () => void,
): boolean {
  if (!canNavigateToToastWorktree(projectId, worktreeId)) return false;

  // Chat actions already route Work Entries and synthetic chat scopes.
  // Use that same destination for both the header and the toast body.
  if (openChat) {
    openChat();
    return true;
  }

  // An archive or shared-container viewer would stay on top of the worktree.
  dismissPageLikeViewers();
  useNavigationStore.getState().navigate('main');
  useChatStore.getState().selectWorktree(projectId, worktreeId);
  return true;
}

/** A background failure's link to the worktree it happened in. */
export function worktreeToastOrigin(
  projectId: string,
  worktreeId: string,
): ToastOrigin {
  return {
    label: 'Open worktree',
    open: (): void => {
      // A worktree in another organization opens once its context does.
      openInWorkspaceContext(projectId, (): void => {
        navigateToToastWorktree(projectId, worktreeId);
      });
    },
  };
}
