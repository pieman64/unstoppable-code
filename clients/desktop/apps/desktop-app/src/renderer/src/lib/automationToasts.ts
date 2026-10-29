import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';

/**
 * Fire the "Scheduled task automation created" success toast used by the
 * Home composer's scheduled-send flows once the backing automation has been
 * created. Clicking the toast opens the newly created activity in the
 * Workflows edit shell (mirrors `usePipelineCompletionToasts.ts`'s
 * navigation-toast pattern).
 */
export function showAutomationCreatedToast(
  activity: ScheduledActivity,
  workspaceName?: string,
): void {
  useGitHubStore.getState().addToast(
    'Scheduled task automation created',
    'success',
    (): void => {
      useNavigationStore.getState().openAutomationEdit({
        activityId: activity.id,
      });
    },
    { category: 'Automation', workspaceName },
  );
}
