export const HEADER_STATES_PAGE_STORAGE_KEY = 'canopy.dev.headerStatesPage';

/**
 * Gate for the Header States gallery entry in the sidebar More menu.
 *
 * E2E builds always show it (the Electron capture spec drives the page). Dev
 * builds require a per-machine localStorage opt-in so the page stays personal
 * to whoever enabled it rather than appearing for every developer:
 *
 *   localStorage.setItem('canopy.dev.headerStatesPage', '1')
 *
 * Packaged builds never show it. Mirrors `desktop-sidebar-shadow-flag.ts`.
 */
export function isHeaderStatesPageEnabled(): boolean {
  if (__CANOPY_E2E__) return true;
  if (window.devInfo?.isDev !== true) return false;
  try {
    return window.localStorage.getItem(HEADER_STATES_PAGE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
