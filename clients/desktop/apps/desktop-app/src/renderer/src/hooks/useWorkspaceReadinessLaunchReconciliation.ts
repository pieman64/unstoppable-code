import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  isLaunchedReadinessFixObsolete,
  launchedReadinessFixKey,
  type LaunchedReadinessFixes,
  type WorkspaceReadinessLaunchInventory,
} from '@/lib/workspaceReadinessLaunches';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceReadinessLaunchStore } from '@/stores/workspaceReadinessLaunchStore';
import { hydratedKeys } from '@/stores/chat/hydration';
import { useChatStore } from '@/stores/chatStore';

/** Confirmed missing destinations only; unopened chats remain inconclusive. */
export function useWorkspaceReadinessMissingChats(
  records: LaunchedReadinessFixes,
): readonly string[] {
  return useChatStore(
    useShallow((state) =>
      Object.values(records)
        .filter((record) => {
          const chatKey = `${record.workspaceId}/${record.worktreeId}`;
          const chat = state.worktreeChats[chatKey];
          return (
            chat !== undefined &&
            hydratedKeys.has(chatKey) &&
            !chat.tabs.some((tab) => tab.id === record.chatId)
          );
        })
        .map(launchedReadinessFixKey),
    ),
  );
}

function currentInventory(): WorkspaceReadinessLaunchInventory {
  const projects = useProjectsStore.getState();
  return {
    projects: projects.projects,
    completeProjects: projects.projectInventorySnapshot?.projects,
    readStartedAt: projects.projectInventorySnapshot?.startedAt,
    complete:
      projects.hasHydratedProjects &&
      !projects.isLoading &&
      projects.projectInventoryStatus === 'ready' &&
      projects.projectInventorySnapshot !== null,
    failedWorkspaceIds: projects.failedWorkspaceIds,
    prStatuses: useGitHubStore.getState().prStatuses,
  };
}

/**
 * Clears launch records that the worktree inventory retires: a merged fix
 * worktree, or a workspace or fix worktree absent from a complete list. A
 * launch whose first send is still settling is left alone, so a worktree the
 * list has not caught up with yet is not mistaken for a removed one.
 */
export function reconcileWorkspaceReadinessLaunches(): void {
  const launches = useWorkspaceReadinessLaunchStore.getState();
  const records = Object.values(launches.records);
  if (records.length === 0) return;
  const inventory = currentInventory();
  const obsolete = records.filter(
    (record) =>
      !launches.pendingSendKeys[launchedReadinessFixKey(record)] &&
      isLaunchedReadinessFixObsolete(record, inventory),
  );
  if (obsolete.length > 0) launches.removeLaunches(obsolete);
}

/**
 * Keeps launch records reconciled with worktree and PR state while a
 * readiness surface is mounted. Subscribes outside React so inventory churn
 * does not re-render the host.
 */
export function useWorkspaceReadinessLaunchReconciliation(): void {
  useEffect(() => {
    reconcileWorkspaceReadinessLaunches();
    const unsubscribers = [
      useProjectsStore.subscribe(reconcileWorkspaceReadinessLaunches),
      useGitHubStore.subscribe(reconcileWorkspaceReadinessLaunches),
      useWorkspaceReadinessLaunchStore.subscribe(
        reconcileWorkspaceReadinessLaunches,
      ),
    ];
    return (): void => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, []);
}
