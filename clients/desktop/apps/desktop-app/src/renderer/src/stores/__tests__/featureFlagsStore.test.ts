const mockAddClientFeatureFlagEvaluation = jest.fn<void, [string, unknown]>();

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  get addClientFeatureFlagEvaluation(): typeof mockAddClientFeatureFlagEvaluation {
    return mockAddClientFeatureFlagEvaluation;
  },
}));

import {
  CLIENT_FEATURE_FLAGS,
  CLIENT_FEATURE_FLAG_DEFAULTS,
  getClientFeatureFlagDefaults,
  getClientFeatureFlagDefaultValue,
  getDefaultFeatureFlagSnapshot,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '../featureFlagsStore';

interface FeatureFlagsApiMock {
  getSnapshot: jest.Mock;
  refreshContext: jest.Mock;
  onSnapshotChanged: jest.Mock;
}

function installWindowApi(featureFlags: FeatureFlagsApiMock): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      ...globalThis.window,
      api: { featureFlags },
    },
  });
}

beforeEach(() => {
  // Reset to defaults so tests do not leak state between cases.
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
  mockAddClientFeatureFlagEvaluation.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('featureFlagsStore', () => {
  it('initializes with the protocol-default snapshot', () => {
    const state = useFeatureFlagsStore.getState();
    const expected = getDefaultFeatureFlagSnapshot();

    // The default values mirror CLIENT_FEATURE_FLAG_DEFAULTS so the
    // renderer keeps Portal visible when the evaluator has not yet
    // produced a verdict.
    expect(state.snapshot.values).toEqual(expected.values);
    expect(state.snapshot.values).toEqual(CLIENT_FEATURE_FLAG_DEFAULTS);
    expect(state.snapshot.status).toBe('not_configured');
    expect(state.snapshot.initialized).toBe(false);
  });

  it('setSnapshot replaces the stored values', () => {
    const next: FeatureFlagSnapshot = {
      values: {
        ...getClientFeatureFlagDefaults('launchdarkly_enabled_unavailable'),
        'canopy-portal-enabled': false,
        'canopy-shared-claude-model-fable5': false,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    };

    useFeatureFlagsStore.getState().setSnapshot(next);

    expect(useFeatureFlagsStore.getState().snapshot).toEqual(next);
    expect(mockAddClientFeatureFlagEvaluation).toHaveBeenCalledWith(
      'canopy-portal-enabled',
      false,
    );
    expect(mockAddClientFeatureFlagEvaluation).toHaveBeenCalledWith(
      'canopy-shared-claude-model-fable5',
      false,
    );
  });

  it('isEnabled reads the current snapshot value when present', () => {
    useFeatureFlagsStore.getState().setSnapshot({
      values: {
        ...getClientFeatureFlagDefaults('launchdarkly_enabled_unavailable'),
        'canopy-portal-enabled': false,
        'canopy-shared-claude-model-fable5': false,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    });
    expect(
      useFeatureFlagsStore
        .getState()
        .isEnabled(CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key),
    ).toBe(false);

    useFeatureFlagsStore.getState().setSnapshot({
      values: {
        ...getClientFeatureFlagDefaults('launchdarkly_enabled_unavailable'),
        'canopy-portal-enabled': true,
        'canopy-shared-claude-model-fable5': false,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    });
    expect(
      useFeatureFlagsStore
        .getState()
        .isEnabled(CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key),
    ).toBe(true);
  });

  it('isEnabled falls back by snapshot status when the snapshot lacks the key', () => {
    useFeatureFlagsStore.getState().setSnapshot({
      // Cast through unknown so the test can simulate a malformed/empty
      // snapshot without satisfying the full ClientFeatureFlagValues
      // shape at compile time.
      values: {} as unknown as FeatureFlagSnapshot['values'],
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    });

    expect(
      useFeatureFlagsStore
        .getState()
        .isEnabled(CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key),
    ).toBe(
      getClientFeatureFlagDefaultValue(
        CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
        'launchdarkly_enabled_unavailable',
      ),
    );
  });

  it('hydrate stores the snapshot returned by the bridge', async () => {
    const incoming: FeatureFlagSnapshot = {
      values: {
        ...getClientFeatureFlagDefaults('launchdarkly_enabled_unavailable'),
        'canopy-portal-enabled': false,
        'canopy-shared-claude-model-fable5': false,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    };
    const featureFlags: FeatureFlagsApiMock = {
      getSnapshot: jest.fn(() => Promise.resolve(incoming)),
      refreshContext: jest.fn(),
      onSnapshotChanged: jest.fn(() => (): undefined => undefined),
    };
    installWindowApi(featureFlags);

    await useFeatureFlagsStore.getState().hydrate();

    expect(featureFlags.getSnapshot).toHaveBeenCalledTimes(1);
    expect(useFeatureFlagsStore.getState().snapshot).toEqual(incoming);
    expect(mockAddClientFeatureFlagEvaluation).toHaveBeenCalledWith(
      'canopy-portal-enabled',
      false,
    );
  });

  it('hydrate failure logs and leaves the existing snapshot intact', async () => {
    const before = useFeatureFlagsStore.getState().snapshot;
    const error = new Error('boom');
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const featureFlags: FeatureFlagsApiMock = {
      getSnapshot: jest.fn(() => Promise.reject(error)),
      refreshContext: jest.fn(),
      onSnapshotChanged: jest.fn(() => (): undefined => undefined),
    };
    installWindowApi(featureFlags);

    await useFeatureFlagsStore.getState().hydrate();

    // Single argument by design: Electron's renderer console capture
    // stringifies everything after the first, so a second `details` argument
    // reached `app-events` as the literal text `[object Object]`. The payload
    // is serialized INTO the message instead.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const call: unknown[] = consoleErrorSpy.mock.calls[0] ?? [];
    expect(call).toHaveLength(1);
    expect(String(call[0])).toBe(
      `[renderer] Failed to hydrate feature flags ${JSON.stringify({
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      })}`,
    );
    expect(useFeatureFlagsStore.getState().snapshot).toEqual(before);
  });
});
