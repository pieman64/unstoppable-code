export const WORKTREE_STATES_PAGE_STORAGE_KEY = 'canopy.dev.worktreeStatesPage';

/**
 * Gate for the Worktree States gallery entry in the sidebar More menu.
 *
 * E2E builds always show it (the Electron spec drives the page). Dev builds
 * require a per-machine localStorage opt-in so the page stays personal to
 * whoever enabled it rather than appearing for every developer:
 *
 *   localStorage.setItem('canopy.dev.worktreeStatesPage', '1')
 *
 * Packaged builds never show it. Mirrors `desktop-sidebar-shadow-flag.ts`.
 */
export function isWorktreeStatesPageEnabled(): boolean {
  if (__CANOPY_E2E__) return true;
  if (window.devInfo?.isDev !== true) return false;
  try {
    return (
      window.localStorage.getItem(WORKTREE_STATES_PAGE_STORAGE_KEY) === '1'
    );
  } catch {
    return false;
  }
}
