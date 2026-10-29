import { useGitHubStore } from '@/stores/githubStore';
import {
  useSharedContainerReplicasStore,
  type SharedContainerRestoreOutcome,
} from '@/stores/sharedContainerReplicasStore';
import { SHARED_WITH_YOU_SECTION_LABEL } from '@canopy/ui-app';

/**
 * Restores a removed share and reports the outcome (CAN-4052).
 *
 * The one restore path for the Past shares page and the remove toast's
 * Restore action. Both land on the store's `restoringIds` guard, so a page
 * click and a toast click on the same share cannot double-send; the second
 * resolves `'in-flight'` and says nothing.
 */
export async function restoreSharedContainerWithFeedback(
  containerId: string,
  title: string,
): Promise<SharedContainerRestoreOutcome> {
  const outcome = await useSharedContainerReplicasStore
    .getState()
    .restoreContainer(containerId);
  const { addToast } = useGitHubStore.getState();
  // Feedback to a click made with the app in the foreground.
  const meta = { forceInApp: true, suppressOsNotification: true };
  if (outcome === 'restored') {
    addToast(
      `Restored ${title}. Accept it under ${SHARED_WITH_YOU_SECTION_LABEL} to open it.`,
      'success',
      undefined,
      meta,
    );
  } else if (outcome === 'not-restorable') {
    addToast(
      `Couldn't restore ${title}. It's no longer shared with you.`,
      'error',
      undefined,
      meta,
    );
  } else if (outcome === 'failed' || outcome === 'unsupported') {
    addToast(`Couldn't restore ${title}. Try again.`, 'error', undefined, meta);
  }
  return outcome;
}
