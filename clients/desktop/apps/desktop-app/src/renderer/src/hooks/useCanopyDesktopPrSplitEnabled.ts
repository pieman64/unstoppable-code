import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Returns whether desktop PR Split entry points should be visible, including
 * the LaunchDarkly-not-configured fallback used in local/dev builds.
 */
export function useCanopyDesktopPrSplitEnabled(): boolean {
  return useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.key),
  );
}
