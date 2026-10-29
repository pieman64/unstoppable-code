import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

export function isOpenCodeHarnessEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key,
  );
}

export function assertOpenCodeHarnessEnabled(): void {
  if (!isOpenCodeHarnessEnabled())
    throw new Error('OpenCode is unavailable. Choose another provider.');
}
