import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { setExperimentalFeaturesEnabled } from '../../lib/experimental-features';
import { setRemoteControlEnabled } from '../../lib/remote-control-preference';
import {
  isRemoteControlAvailable,
  onRemoteControlAvailabilityChanged,
} from '../availability';

let mockFlagEnabled = true;
const mockSnapshotListeners = new Set<() => void>();

jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({
    isEnabled: jest.fn(
      (key: string): boolean =>
        key === CLIENT_FEATURE_FLAGS.canopyDeviceRemoteControl.key &&
        mockFlagEnabled,
    ),
    onSnapshotChanged: jest.fn((listener: () => void): (() => void) => {
      mockSnapshotListeners.add(listener);
      return () => {
        mockSnapshotListeners.delete(listener);
      };
    }),
  })),
}));

function emitFlagsChanged(): void {
  mockSnapshotListeners.forEach((listener) => {
    listener();
  });
}

describe('remote control availability', () => {
  afterEach(() => {
    mockFlagEnabled = true;
    mockSnapshotListeners.clear();
    setRemoteControlEnabled(false);
    setExperimentalFeaturesEnabled(false);
  });

  it('needs both the feature flag and its Experiments switch', () => {
    setRemoteControlEnabled(false);
    expect(isRemoteControlAvailable()).toBe(false);

    setRemoteControlEnabled(true);
    expect(isRemoteControlAvailable()).toBe(true);

    mockFlagEnabled = false;
    expect(isRemoteControlAvailable()).toBe(false);
  });

  it('does not depend on Early access', () => {
    setExperimentalFeaturesEnabled(true);
    expect(isRemoteControlAvailable()).toBe(false);

    setRemoteControlEnabled(true);
    setExperimentalFeaturesEnabled(false);
    expect(isRemoteControlAvailable()).toBe(true);
  });

  it('reports a change to either the flag or its switch', () => {
    const changed = jest.fn();
    const unsubscribe = onRemoteControlAvailabilityChanged(changed);

    setRemoteControlEnabled(true);
    expect(changed).toHaveBeenCalledTimes(1);

    emitFlagsChanged();
    expect(changed).toHaveBeenCalledTimes(2);

    // Early access no longer moves availability.
    setExperimentalFeaturesEnabled(true);
    expect(changed).toHaveBeenCalledTimes(2);

    unsubscribe();
    setRemoteControlEnabled(false);
    emitFlagsChanged();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
