import { useCallback, type JSX } from 'react';
import type { ProjectDeletionItemDiscarded } from '@canopy/app-state/worktree-discard';
import { ProjectDeletionDiscardHost } from '@canopy/ui-app/worktree-discard';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { finishWorktreeArchive } from './finishWorktreeArchive';

/**
 * CAN-5337: the desktop mount of the shared project deletion discard. After
 * each discard the store drops the worktree, as a finished archive does,
 * before the next discard and before Settings runs the deletion again: that
 * retry reads the worktrees it archives from the store.
 */
export function DesktopProjectDeletionDiscardHost(): JSX.Element {
  const onItemDiscarded = useCallback(
    ({
      workspaceId,
      worktreeId,
      warnings,
      removedTemporaryWorkspaceId,
    }: ProjectDeletionItemDiscarded): void => {
      for (const warning of warnings) {
        useGitHubStore.getState().addToast(warning, 'warning', undefined, {
          category: 'Worktree',
          projectId: workspaceId,
          worktreeId,
        });
      }
      void useProjectsStore
        .getState()
        .reconcileArchivedWorktree(
          workspaceId,
          worktreeId,
          removedTemporaryWorkspaceId ? { removedTemporaryWorkspaceId } : {},
        );
      finishWorktreeArchive({
        projectId: workspaceId,
        worktreeId,
        refreshReferenceRepos: false,
      });
    },
    [],
  );
  return (
    <ProjectDeletionDiscardHost
      client={ipcCanopyClient}
      onItemDiscarded={onItemDiscarded}
    />
  );
}
