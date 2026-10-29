import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import {
  isRemoteControlEnabled,
  onRemoteControlEnabledChanged,
} from '../lib/remote-control-preference';

/**
 * Remote control needs its feature flag and its own switch in Settings →
 * Labs. While either is off this computer stays off the relay, so
 * nothing can pair with or control it.
 */
export function isRemoteControlAvailable(): boolean {
  return (
    isRemoteControlEnabled() &&
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyDeviceRemoteControl.key,
    )
  );
}

/** Calls `listener` when the flag or the switch may have changed. */
export function onRemoteControlAvailabilityChanged(
  listener: () => void,
): () => void {
  const unsubscribeFlags = getFeatureFlagService().onSnapshotChanged(listener);
  const unsubscribeSwitch = onRemoteControlEnabledChanged(listener);
  return () => {
    unsubscribeFlags();
    unsubscribeSwitch();
  };
}
