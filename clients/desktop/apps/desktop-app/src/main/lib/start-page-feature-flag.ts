import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

/** Main-process enforcement for every start-page read and write path. */
export function isStartPageFeatureEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopStartPage.key,
  );
}

/** Reject user-initiated start-page mutations while the capability is gated. */
export function assertStartPageFeatureEnabled(): void {
  if (!isStartPageFeatureEnabled()) {
    throw new Error('Start page is unavailable');
  }
}
