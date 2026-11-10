import {
  CLIENT_FEATURE_FLAGS,
  type ClientFeatureFlagValues,
} from '@canopy/protocol/feature-flags';

interface FeatureFlagGatedService {
  setFeatureFlagEnabled(enabled: boolean): void;
}

/**
 * Applies the rollout gates of the background cloud sync services from one
 * feature-flag snapshot. Main calls it at startup, on every snapshot
 * broadcast, and whenever the Labs Remote Control switch changes, so a
 * LaunchDarkly start that recovers mid-session (CAN-3511) or a switch flip
 * resumes inventory sync without a restart.
 *
 * Inventory sync runs while Remote Control is available: Portal is on, or
 * direct Remote Control is (the Labs switch, `canopy-device-remote-control`
 * and `canopy-web-direct-remote-control`). The server gates the push on the
 * same rule, so both sides agree whenever they see the same flags (CAN-6037).
 */
export function applySyncServiceFeatureFlags(
  values: ClientFeatureFlagValues,
  services: {
    /** Inventory sync (CAN-2830) is the Remote Control data plane. */
    inventory: FeatureFlagGatedService;
  },
  { remoteAccessEnabled }: { remoteAccessEnabled: boolean },
): void {
  const portal = values[CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key] === true;
  const direct =
    remoteAccessEnabled &&
    values[CLIENT_FEATURE_FLAGS.canopyDeviceRemoteControl.key] === true &&
    values[CLIENT_FEATURE_FLAGS.canopyWebDirectRemoteControl.key] === true;
  services.inventory.setFeatureFlagEnabled(portal || direct);
}
