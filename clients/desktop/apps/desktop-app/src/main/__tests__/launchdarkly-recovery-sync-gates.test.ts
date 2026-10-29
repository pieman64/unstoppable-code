/**
 * CAN-3511: LaunchDarkly failed to start during a network blip and never
 * retried, so flag-gated background sync sat on its `false` fallback until the
 * next restart. This drives the real feature-flag service through the same
 * snapshot gate main installs and checks that inventory sync, which rides
 * `canopy-portal-enabled`, resumes when the flag recovers without a restart.
 */
const mockInitialize = jest.fn();
const mockElectronApp = {
  isPackaged: false,
  getPath: jest.fn(() => '/tmp/canopy-feature-flags-test'),
};
jest.mock('electron', () => ({ app: mockElectronApp }));
jest.mock('launchdarkly-node-client-sdk', () => ({
  initialize: mockInitialize,
}));
jest.mock('../feature-flags/context', () => ({
  buildDesktopFeatureFlagContext: jest.fn(() =>
    Promise.resolve({ kind: 'user', key: 'user-1' }),
  ),
}));

import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  FeatureFlagService,
  LAUNCHDARKLY_RETRY_DELAYS_MS,
  type FeatureFlagAppDiagnostic,
} from '../feature-flags/service';
import { applySyncServiceFeatureFlags } from '../services/sync-service-feature-flags';

interface MockLaunchDarklyClient {
  waitForInitialization: jest.Mock;
  variation: jest.Mock;
  identify: jest.Mock;
  on: jest.Mock;
  off: jest.Mock;
  close: jest.Mock;
}

function launchDarklyClient(
  waitForInitialization: jest.Mock,
  values: Record<string, unknown> = {},
): MockLaunchDarklyClient {
  return {
    waitForInitialization,
    variation: jest.fn(
      (key: string, fallback: unknown): unknown => values[key] ?? fallback,
    ),
    identify: jest.fn().mockResolvedValue({}),
    on: jest.fn(),
    off: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('LaunchDarkly recovery resumes flag-gated sync (CAN-3511)', () => {
  const originalClientSideId = process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = originalClientSideId;
  });

  it('turns canopy-portal-enabled on after a failed first start and re-enables inventory sync without a restart', async () => {
    const portalKey = CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key;
    mockInitialize
      .mockReturnValueOnce(
        launchDarklyClient(
          jest.fn().mockRejectedValue(new Error('network down')),
        ),
      )
      .mockReturnValueOnce(
        launchDarklyClient(jest.fn().mockResolvedValue(undefined), {
          [portalKey]: true,
        }),
      );
    const flags = new FeatureFlagService({ random: (): number => 0.5 });
    const setInventoryEnabled = jest.fn<void, [boolean]>();
    const inventory = { setFeatureFlagEnabled: setInventoryEnabled };
    const recordDiagnostic = jest.fn<void, [FeatureFlagAppDiagnostic]>();
    flags.setDiagnosticRecorder(recordDiagnostic);

    // Startup order in main: flags first, then the snapshot gate and the
    // initial gate application.
    await flags.initialize();
    flags.onSnapshotChanged((snapshot) => {
      applySyncServiceFeatureFlags(snapshot.values, { inventory });
    });
    applySyncServiceFeatureFlags(flags.getSnapshot().values, { inventory });

    expect(flags.isEnabled(portalKey)).toBe(false);
    await jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[0] - 1);
    expect(setInventoryEnabled.mock.calls.map(([enabled]) => enabled)).toEqual([
      false,
    ]);

    // The backoff retry reaches LaunchDarkly with no restart.
    await jest.advanceTimersByTimeAsync(1);
    expect(flags.isEnabled(portalKey)).toBe(true);
    expect(setInventoryEnabled).toHaveBeenLastCalledWith(true);
    expect(recordDiagnostic.mock.calls.map(([record]) => record.kind)).toEqual([
      'feature_flags_unavailable',
      'feature_flags_recovered',
    ]);

    await flags.dispose();
  });
});
