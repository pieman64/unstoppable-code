import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';
import { isSimilarSignature, taskSignature } from './similarity';

function activityCoversWorkspace(
  activity: ScheduledActivity,
  workspaceId: string,
  tokens: readonly string[],
): boolean {
  const action = activity.action;
  switch (action.type) {
    case 'standalone_prompt':
      return (
        action.chatProjectId === workspaceId &&
        isSimilarSignature(taskSignature(action.prompt), tokens)
      );
    case 'worktree_prompt':
      return (
        action.workspaceId === workspaceId &&
        isSimilarSignature(taskSignature(action.prompt), tokens)
      );
    case 'app_advisor_prompt':
      return (
        workspaceId === APP_ADVISOR_PROJECT_ID &&
        isSimilarSignature(taskSignature(action.prompt), tokens)
      );
    default:
      return false;
  }
}

export async function isCoveredByExistingAutomation(
  workspaceId: string,
  tokens: readonly string[],
): Promise<boolean> {
  const state = useAutomationsStore.getState();
  // Joining follows a load that replaces the one in flight, so a stale or
  // superseded snapshot never decides the match.
  if (!state.hydrated || state.loading) {
    try {
      await useAutomationsStore.getState().hydrate({ joinInFlight: true });
    } catch {
      return false;
    }
  }

  // A failed load keeps the earlier list, which may no longer be true.
  const current = useAutomationsStore.getState();
  if (!current.hydrated || current.error !== null) return false;

  // A turned-off automation never runs, so it doesn't cover the task.
  return current.activities.some(
    (activity) =>
      activity.enabled &&
      activityCoversWorkspace(activity, workspaceId, tokens),
  );
}
