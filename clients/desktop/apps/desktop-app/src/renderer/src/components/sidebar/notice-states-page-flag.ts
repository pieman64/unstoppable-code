/**
 * Gate for the Notice States gallery entry in the sidebar More menu.
 *
 * Dev and E2E builds always show it: the page is the single place to see every
 * inline notice the app can raise, with its real copy and actions, so it
 * should be one click away while iterating. Packaged builds never show it.
 * Mirrors `header-states-page-flag.ts` minus the per-machine opt-in.
 */
export function isNoticeStatesPageEnabled(): boolean {
  if (__CANOPY_E2E__) return true;
  return window.devInfo?.isDev === true;
}
