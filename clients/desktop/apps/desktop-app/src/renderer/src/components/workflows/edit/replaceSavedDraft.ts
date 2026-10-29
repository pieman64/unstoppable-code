import {
  workflowEditKey,
  type WorkflowEditTarget,
} from '@/lib/workflows/edit-target';
import { useNavigationStore } from '@/stores/navigationStore';

/**
 * Swaps a draft that just saved for its saved target, without asking and
 * over the current history entry (CAN-4072). It runs after the save settles,
 * so a save started from the unsaved-changes prompt lets that prompt's
 * navigation through first; when the navigation left the draft, there is
 * nothing to swap.
 */
export function replaceSavedDraft(
  draftKey: string,
  saved: WorkflowEditTarget,
): void {
  setTimeout(() => {
    const navigation = useNavigationStore.getState();
    const shown = navigation.workflowEdit;
    if (shown === undefined || workflowEditKey(shown) !== draftKey) return;
    navigation.replaceWorkflowEdit({
      ...saved,
      ...(shown.section !== undefined ? { section: shown.section } : {}),
      ...(shown.returnTo !== undefined ? { returnTo: shown.returnTo } : {}),
    });
  }, 0);
}
