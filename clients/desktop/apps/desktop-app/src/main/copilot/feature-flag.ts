import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

export function isCopilotHarnessEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key,
  );
}

export function assertCopilotHarnessEnabled(): void {
  if (!isCopilotHarnessEnabled())
    throw new Error('GitHub Copilot is unavailable. Choose another provider.');
}
