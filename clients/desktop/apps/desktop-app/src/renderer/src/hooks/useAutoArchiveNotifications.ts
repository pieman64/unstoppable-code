import { useEffect } from 'react';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

export function useAutoArchiveNotifications(): void {
  useEffect(() => {
    return window.api.onAutoArchiveCompleted((notification) => {
      if (notification.status === 'success') {
        if (
          notification.surface === 'cowork' ||
          notification.surface === 'app-advisor'
        ) {
          void useStandaloneChatStore
            .getState()
            .reconcileArchivedWorkEntry(
              notification.workspaceId,
              notification.targetId,
            );
        } else {
          void useProjectsStore
            .getState()
            .reconcileArchivedWorktree(
              notification.workspaceId,
              notification.targetId,
            );
        }
      }
      const subject = `“${notification.targetName}”`;
      const hasWarnings = Boolean(notification.warnings?.length);
      const message =
        notification.status === 'success'
          ? `${subject} was automatically deleted after ${notification.inactivityDays} ${notification.inactivityDays === 1 ? 'day' : 'days'} of inactivity.`
          : `${subject} could not be automatically deleted${notification.error ? `: ${notification.error}` : '.'}`;
      useGitHubStore
        .getState()
        .addToast(
          hasWarnings
            ? `${message} Cleanup incomplete: ${notification.warnings?.join(' ')}`
            : message,
          notification.status === 'failure'
            ? 'error'
            : hasWarnings
              ? 'warning'
              : 'success',
          undefined,
          {
            category: 'Automation',
            title: 'Auto delete',
            workspaceName: notification.workspaceName,
            projectId: notification.workspaceId,
            worktreeId: notification.targetId,
            persistent: notification.status === 'failure' || hasWarnings,
            forceInApp: true,
          },
        );
    });
  }, []);
}
