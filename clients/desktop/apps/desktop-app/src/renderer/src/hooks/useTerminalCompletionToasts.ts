import { useTerminalCompletionNotices } from '@canopy/ui-app/terminal-core';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { addFailureToast, type ToastMeta } from '@/stores/toastStore';
import { ownWorkToastError } from '@canopy/ui-shared/lib';
import { useProjectsStore } from '@/stores/projectsStore';
import { useClaudeTerminalStore } from '@/stores/claudeTerminalStore';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import type { NavigationPage } from '@/stores/navigationStore';
import '@/stores/terminalActivityStore';

/** Desktop notification metadata and click navigation for shared completion notices. */
export function useTerminalCompletionToasts(
  navigateToPage: (page: NavigationPage) => void,
): void {
  useTerminalCompletionNotices({
    isClaudeCodeTerminal: (event): boolean =>
      event.kind === 'claude-code' ||
      useClaudeTerminalStore.getState().terminalIdIndex[event.terminalId] !==
        undefined,
    onNotice: (notice): void => {
      const onClick = (): void => {
        const { projects, hasHydratedProjects } = useProjectsStore.getState();
        if (
          !canNavigateToWorktreeFromSidebarItems(
            projects,
            notice.projectId,
            notice.worktreeId,
            hasHydratedProjects,
          )
        )
          return;
        navigateToPage('main');
        useChatStore
          .getState()
          .selectWorktree(notice.projectId, notice.worktreeId);
      };
      const workspaceName = useProjectsStore
        .getState()
        .projects.find((project) => project.id === notice.projectId)?.name;
      const meta: ToastMeta = {
        category: 'Terminal',
        workspaceName,
        projectId: notice.projectId,
        worktreeId: notice.worktreeId,
      };
      if (notice.type === 'error') {
        addFailureToast({
          message: notice.message,
          error: ownWorkToastError(notice.message),
          origin: { label: 'Open worktree', open: onClick },
          meta,
        });
        return;
      }
      useGitHubStore
        .getState()
        .addToast(notice.message, 'success', onClick, meta);
    },
  });
}
