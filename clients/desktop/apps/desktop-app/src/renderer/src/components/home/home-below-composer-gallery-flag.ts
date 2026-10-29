export const HOME_BELOW_COMPOSER_GALLERY_STORAGE_KEY =
  'canopy.dev.homeBelowComposerGallery';

/**
 * Gate for the Home below-composer sections preview stack.
 *
 * When enabled, page-variant Home replaces the live sections with a fixture
 * stack so every below-composer look can be reviewed at once. Opt-in only:
 * an ordinary `npm run dev` must exercise the real Continue/readiness/prompt
 * paths, or local regressions in them go unnoticed. Packaged builds never
 * show it; E2E stays on the live gated paths.
 *
 *   localStorage.setItem('canopy.dev.homeBelowComposerGallery', '1') // show
 *   localStorage.removeItem('canopy.dev.homeBelowComposerGallery')  // hide
 */
export function isHomeBelowComposerGalleryEnabled(): boolean {
  if (__CANOPY_E2E__) return false;
  if (window.devInfo?.isDev !== true) return false;
  try {
    return (
      window.localStorage.getItem(HOME_BELOW_COMPOSER_GALLERY_STORAGE_KEY) ===
      '1'
    );
  } catch {
    return false;
  }
}
