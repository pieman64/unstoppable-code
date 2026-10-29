import {
  CLIENT_FEATURE_FLAGS,
  type ClientFeatureFlagValues,
} from '@canopy/protocol/feature-flags';

interface FeatureFlagGatedService {
  setFeatureFlagEnabled(enabled: boolean): void;
}

/**
 * Applies the rollout gates of the background cloud sync services from one
 * feature-flag snapshot. Main calls it at startup and on every snapshot
 * broadcast, so a LaunchDarkly start that recovers mid-session (CAN-3511)
 * resumes inventory sync without a restart.
 */
export function applySyncServiceFeatureFlags(
  values: ClientFeatureFlagValues,
  services: {
    /** Inventory sync (CAN-2830) is the Remote Control data plane. */
    inventory: FeatureFlagGatedService;
  },
): void {
  services.inventory.setFeatureFlagEnabled(
    values[CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key] === true,
  );
}
