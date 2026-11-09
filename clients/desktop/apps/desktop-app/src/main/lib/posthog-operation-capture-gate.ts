import { setDesktopPostHogCapturePolicy } from '@canopy/desktop-instrumentation/electron/main';
import {
  CLIENT_FEATURE_FLAGS,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { getUsageDataPolicy } from './usage-data-policy';

export interface PostHogCaptureFlagSource {
  getSnapshot: () => FeatureFlagSnapshot;
  onSnapshotChanged: (
    listener: (snapshot: FeatureFlagSnapshot) => void,
  ) => () => void;
}

export interface PostHogOperationCaptureState {
  /** Product events: LaunchDarkly capture flag ∧ effective Usage analytics. */
  readonly enabled: boolean;
  /** Errors: LaunchDarkly capture flag ∧ effective Error reports. */
  readonly errorsEnabled: boolean;
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

let captureFlagEnabled = false;

function applyCapturePolicy(): void {
  const usage = getUsageDataPolicy().getEffectiveUsageDataPolicy();
  const enabled = captureFlagEnabled && usage.productAnalytics;
  const errorsEnabled = captureFlagEnabled && usage.errorReports;
  setDesktopPostHogCapturePolicy({
    events: enabled,
    errors: errorsEnabled,
    launchEvents: usage.productAnalytics,
  });
  if (
    captureState?.enabled === enabled &&
    captureState.errorsEnabled === errorsEnabled
  )
    return;
  captureState = { enabled, errorsEnabled };
  for (const listener of Array.from(captureListeners)) {
    try {
      listener();
    } catch {
      // Telemetry observers cannot interrupt feature-flag delivery.
    }
  }
}

function applyCaptureFlag(snapshot: FeatureFlagSnapshot): void {
  captureFlagEnabled =
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key] ===
    true;
  applyCapturePolicy();
}

/**
 * Holds operations forwarded from the background process to the same
 * LaunchDarkly capture flag the app windows honor, combined with the member's
 * effective usage-data policy, so either stops them without a restart.
 * `desktop:app_start` follows only the usage-data policy, not the flag.
 */
export function installPostHogOperationCaptureGate(
  source: PostHogCaptureFlagSource,
): () => void {
  const unsubscribeFlags = source.onSnapshotChanged(applyCaptureFlag);
  const unsubscribePolicy = getUsageDataPolicy().subscribe(applyCapturePolicy);
  applyCaptureFlag(source.getSnapshot());
  return (): void => {
    unsubscribeFlags();
    unsubscribePolicy();
    captureFlagEnabled = false;
    applyCapturePolicy();
  };
}
