import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';

/**
 * Whether the hosted Account and Organizations settings panels are rolled
 * out (`canopy-desktop-hosted-settings`, CAN-4386). While off, main refuses
 * the settings bridge and `settings.open`, and the renderer keeps the web
 * hand-off.
 */
export function isHostedSettingsEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopHostedSettings.key,
  );
}
