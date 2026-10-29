import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Returns whether desktop shared-container (invite a teammate) entry points
 * should be visible, including the LaunchDarkly-not-configured fallback used in
 * local/dev builds and the E2E harness.
 */
export function useCanopyDesktopSharedContainersEnabled(): boolean {
  return useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key),
  );
}
