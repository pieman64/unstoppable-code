jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  setDesktopPostHogOperationCaptureEnabled: jest.fn(),
}));

import { setDesktopPostHogOperationCaptureEnabled } from '@canopy/desktop-instrumentation/electron/main';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { installPostHogOperationCaptureGate } from '../lib/posthog-operation-capture-gate';

const setCaptureEnabled = jest.mocked(setDesktopPostHogOperationCaptureEnabled);
const CAPTURE_KEY = CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key;

function snapshotWithCapture(enabled: boolean): FeatureFlagSnapshot {
  const snapshot = getDefaultFeatureFlagSnapshot();
  return {
    ...snapshot,
    values: { ...snapshot.values, [CAPTURE_KEY]: enabled },
  };
}

function createFlagSource(initial: FeatureFlagSnapshot): {
  getSnapshot: () => FeatureFlagSnapshot;
  onSnapshotChanged: jest.Mock<
    () => void,
    [(snapshot: FeatureFlagSnapshot) => void]
  >;
  push: (snapshot: FeatureFlagSnapshot) => void;
  unsubscribe: jest.Mock;
} {
  let listener: ((snapshot: FeatureFlagSnapshot) => void) | undefined;
  const unsubscribe = jest.fn();
  return {
    getSnapshot: () => initial,
    onSnapshotChanged: jest.fn((next) => {
      listener = next;
      return unsubscribe;
    }),
    push: (snapshot) => listener?.(snapshot),
    unsubscribe,
  };
}

describe('installPostHogOperationCaptureGate', () => {
  beforeEach(() => {
    setCaptureEnabled.mockClear();
  });

  it('applies the current capture flag, then every pushed change', () => {
    const source = createFlagSource(snapshotWithCapture(true));

    installPostHogOperationCaptureGate(source);
    source.push(snapshotWithCapture(false));
    source.push(snapshotWithCapture(true));

    expect(setCaptureEnabled.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('stays closed when the flag is not strictly true', () => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    const source = createFlagSource({
      ...snapshot,
      values: { ...snapshot.values, [CAPTURE_KEY]: false },
    });

    installPostHogOperationCaptureGate(source);

    expect(setCaptureEnabled).toHaveBeenCalledWith(false);
  });

  it('closes the gate and unsubscribes when disposed', () => {
    const source = createFlagSource(snapshotWithCapture(true));

    const dispose = installPostHogOperationCaptureGate(source);
    dispose();

    expect(source.unsubscribe).toHaveBeenCalledTimes(1);
    expect(setCaptureEnabled).toHaveBeenLastCalledWith(false);
  });
});
