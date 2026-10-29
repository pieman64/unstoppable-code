export const CHANGE_REVIEW_PAGE_STORAGE_KEY = 'canopy.dev.changeReviewPage';

/**
 * Gate for the Change review page entry in the sidebar More menu.
 *
 * E2E builds always show it (the Electron spec drives the page). Dev builds
 * require a per-machine localStorage opt-in so the page stays personal to
 * whoever enabled it rather than appearing for every developer:
 *
 *   localStorage.setItem('canopy.dev.changeReviewPage', '1')
 *
 * Packaged builds never show it. Mirrors `header-states-page-flag.ts`.
 */
export function isChangeReviewPageEnabled(): boolean {
  if (__CANOPY_E2E__) return true;
  if (window.devInfo?.isDev !== true) return false;
  try {
    return window.localStorage.getItem(CHANGE_REVIEW_PAGE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
