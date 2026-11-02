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

export interface PostHogOperationCaptureState {
  readonly enabled: boolean;
}

// Undefined distinguishes startup before the first snapshot from an explicit
// kill-switch decision. Identity changes delimit capture lifetimes.
let captureState: PostHogOperationCaptureState | undefined;
const captureListeners = new Set<() => void>();

export function getPostHogOperationCaptureState():
  | PostHogOperationCaptureState
  | undefined {
  return captureState;
}

export function subscribePostHogOperationCaptureChanges(
  listener: () => void,
): () => void {
  captureListeners.add(listener);
  return (): void => {
    captureListeners.delete(listener);
  };
}

function setCaptureEnabled(enabled: boolean): void {
  setDesktopPostHogOperationCaptureEnabled(enabled);
  if (captureState?.enabled === enabled) return;
  captureState = { enabled };
  for (const listener of Array.from(captureListeners)) {
    try {
      listener();
    } catch {
      // Telemetry observers cannot interrupt feature-flag delivery.
    }
  }
}

function applyCaptureFlag(snapshot: FeatureFlagSnapshot): void {
  setCaptureEnabled(
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
    setCaptureEnabled(false);
  };
}
