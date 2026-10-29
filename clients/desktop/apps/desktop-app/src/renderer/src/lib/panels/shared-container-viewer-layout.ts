import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { worktreeSelectionFromPanelOwnerKey } from '@/lib/panels/panel-worktree-context';

/**
 * Whether `worktreeKey` is a shared-container viewer's layout, which keeps
 * Activity as a panel under early access (it has no Activity card).
 */
export function isSharedContainerViewerLayout(worktreeKey: string): boolean {
  return (
    worktreeSelectionFromPanelOwnerKey(worktreeKey)?.projectId ===
    SHARED_CONTAINER_VIEWER_PROJECT_ID
  );
}
