import type { NavigationPage } from '@/stores/navigationStore';

export interface WorktreeSurfaceVisibilityInput {
  readonly activePage: NavigationPage;
  readonly settingsOpen: boolean;
  readonly splitLocked: boolean;
  /** The archived-worktree viewer overlay is open. */
  readonly archivedViewerOpen: boolean;
  /** The "Archived and deleted" overview overlay is open. */
  readonly archivedOverviewOpen: boolean;
  /** The recipient's Past shares overlay is open. */
  readonly sharedContainerPastSharesOpen: boolean;
  /** The shared-container viewer overlay is open. */
  readonly sharedContainerViewerOpen: boolean;
}

/**
 * Whether the main window's worktree panel grid is actually on screen.
 * Native Browser views draw above all renderer content and follow this flag,
 * so it must be false whenever another page or a full-surface overlay covers
 * the grid; otherwise the Browser stays painted over that page.
 */
export function isWorktreeSurfaceVisible(
  input: WorktreeSurfaceVisibilityInput,
): boolean {
  return (
    (input.activePage === 'main' || input.activePage === 'kanban') &&
    !input.settingsOpen &&
    !input.splitLocked &&
    !input.archivedViewerOpen &&
    !input.archivedOverviewOpen &&
    !input.sharedContainerPastSharesOpen &&
    !input.sharedContainerViewerOpen
  );
}
