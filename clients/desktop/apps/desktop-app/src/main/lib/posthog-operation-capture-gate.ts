import { setDesktopPostHogOperationCaptureEnabled } from '@canopy/desktop-instrumentation/electron/main';
import {
  CLIENT_FEATURE_FLAGS,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';

export interface PostHogCaptureFlagSource {
  getSnapshot: () => FeatureFlagSnapshot;
  onSnapshotChanged: (
    listener: (snapshot: FeatureFlagSnapshot) => void,
  ) => () => void;
}

function applyCaptureFlag(snapshot: FeatureFlagSnapshot): void {
  setDesktopPostHogOperationCaptureEnabled(
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key] ===
      true,
  );
}

/**
 * Holds operations forwarded from the background process to the same
 * LaunchDarkly capture flag the app windows honor, so the kill switch stops
 * them without a restart. `desktop:app_start` is deliberately not gated here.
 */
export function installPostHogOperationCaptureGate(
  source: PostHogCaptureFlagSource,
): () => void {
  const unsubscribe = source.onSnapshotChanged(applyCaptureFlag);
  applyCaptureFlag(source.getSnapshot());
  return (): void => {
    unsubscribe();
    setDesktopPostHogOperationCaptureEnabled(false);
  };
}
