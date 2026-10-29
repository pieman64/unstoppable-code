import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Whether project start pages are available: the Settings control, the
 * "Set as start page" actions, the share-sheet "Opens to" row, and the
 * first-open behavior. Main enforces the same flag on every read and write.
 */
export function useCanopyDesktopStartPageEnabled(): boolean {
  return useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopStartPage.key),
  );
}

/** Non-React read of the start-page flag for store and lib callers. */
export function isCanopyDesktopStartPageEnabled(): boolean {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopStartPage.key);
}
