import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

export function isCursorHarnessEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key,
  );
}

export function assertCursorHarnessEnabled(): void {
  if (!isCursorHarnessEnabled()) {
    throw new Error(
      'This Cursor model is unavailable. Choose another Cursor model and try again.',
    );
  }
}
