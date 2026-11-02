jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  setDesktopPostHogOperationCaptureEnabled: jest.fn(),
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

import { setDesktopPostHogOperationCaptureEnabled } from '@canopy/desktop-instrumentation/electron/main';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import {
  getPostHogOperationCaptureState,
  installPostHogOperationCaptureGate,
  subscribePostHogOperationCaptureChanges,
} from '../lib/posthog-operation-capture-gate';

import type * as CaptureGate from '../lib/posthog-operation-capture-gate';
import type * as GrantTelemetry from '../lib/daily-credit-grant-telemetry';
import type * as Instrumentation from '@canopy/desktop-instrumentation/electron/main';

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

it('publishes capture lifetimes after applying the bridge gate, retaining identity on repeated snapshots', () => {
  const source = createFlagSource(snapshotWithCapture(true));
  const listener = jest.fn(() => {
    expect(setCaptureEnabled).toHaveBeenLastCalledWith(
      getPostHogOperationCaptureState()?.enabled,
    );
  });
  const unsubscribe = subscribePostHogOperationCaptureChanges(listener);
  const dispose = installPostHogOperationCaptureGate(source);
  const initial = getPostHogOperationCaptureState();
  source.push(snapshotWithCapture(true));
  expect(getPostHogOperationCaptureState()).toBe(initial);
  listener.mockClear();
  source.push(snapshotWithCapture(false));
  source.push(snapshotWithCapture(true));
  expect(listener).toHaveBeenCalledTimes(2);
  expect(getPostHogOperationCaptureState()).not.toBe(initial);
  unsubscribe();
  dispose();
  expect(listener).toHaveBeenCalledTimes(2);
});

it('keeps delivering flags when a telemetry observer throws', () => {
  const source = createFlagSource(snapshotWithCapture(true));
  const unsubscribe = subscribePostHogOperationCaptureChanges(() => {
    throw new Error('Telemetry unavailable');
  });
  const dispose = installPostHogOperationCaptureGate(source);
  expect(() => source.push(snapshotWithCapture(false))).not.toThrow();
  expect(getPostHogOperationCaptureState()?.enabled).toBe(false);
  unsubscribe();
  dispose();
});

it('releases a startup grant through the real gate and recorder only after the first enabled snapshot', async () => {
  await jest.isolateModulesAsync(async () => {
    jest.doMock('../lib/canopy-cloud-account-store', () => ({
      peekCanopyCloudAccount: (): { account: { id: string } } => ({
        account: { id: 'startup-account' },
      }),
      subscribeCanopyCloudAccountChanges: (): (() => void) => (): void =>
        undefined,
    }));
    const gate = jest.requireActual<typeof CaptureGate>(
      '../lib/posthog-operation-capture-gate',
    );
    const recorder = jest.requireActual<typeof GrantTelemetry>(
      '../lib/daily-credit-grant-telemetry',
    );
    const instrumentation = jest.requireMock<typeof Instrumentation>(
      '@canopy/desktop-instrumentation/electron/main',
    );
    const forwarded: Array<Record<string, unknown>> = [];
    let enabled = false;
    jest
      .mocked(instrumentation.setDesktopPostHogOperationCaptureEnabled)
      .mockImplementation((next) => {
        enabled = next;
      });
    jest
      .mocked(instrumentation.succeedDesktopOperation)
      .mockImplementation((_name, options) => {
        if (enabled) forwarded.push({ ...options?.context });
      });
    expect(gate.getPostHogOperationCaptureState()).toBeUndefined();
    const now = new Date('2026-07-09T19:00:00.000Z');
    recorder.recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'granted', dailyDripGrantedCredits: 10 },
      now,
    );
    recorder.recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'already_granted' },
      now,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(forwarded).toEqual([]);
    const source = createFlagSource(snapshotWithCapture(true));
    const dispose = gate.installPostHogOperationCaptureGate(source);
    source.push(snapshotWithCapture(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(forwarded).toEqual([
      {
        grant_status: 'granted',
        grant_amount: 10,
        grant_source: 'balance_read',
      },
    ]);
    expect(recorder.getLastDailyCreditGrantStatus()).toBe('already_granted');
    dispose();
    jest.mocked(instrumentation.succeedDesktopOperation).mockReset();
    jest
      .mocked(instrumentation.setDesktopPostHogOperationCaptureEnabled)
      .mockReset();
  });
});
