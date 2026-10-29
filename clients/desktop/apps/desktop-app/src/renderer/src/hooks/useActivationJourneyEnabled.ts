import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * Returns whether the `canopy-activation-journey-enabled` flag is on.
 *
 * Gates the activation-journey settings controls. Without it the quiet-hours
 * and close-to-tray toggles render, save, and survive a relaunch while doing
 * nothing at all — the behavior they describe is gated on the same flag in
 * the main process, so the user gets a control that silently lies.
 */
export function useActivationJourneyEnabled(): boolean {
  return useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled.key),
  );
}
