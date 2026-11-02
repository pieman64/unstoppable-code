const mockInitialize = jest.fn<
  unknown,
  [string, unknown, { localStoragePath?: unknown }]
>();
const mockBuildContext = jest.fn();
const mockElectronApp = {
  isPackaged: false,
  getPath: jest.fn(() => '/tmp/canopy-feature-flags-test'),
};

jest.mock('electron', () => ({
  get app(): typeof mockElectronApp {
    return mockElectronApp;
  },
}));
jest.mock('launchdarkly-node-client-sdk', () => ({
  get initialize(): typeof mockInitialize {
    return mockInitialize;
  },
}));
jest.mock('../context', () => ({
  get buildDesktopFeatureFlagContext(): typeof mockBuildContext {
    return mockBuildContext;
  },
}));

import {
  CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
  CLIENT_FEATURE_FLAGS,
} from '@canopy/protocol/feature-flags';
import {
  FeatureFlagService,
  LAUNCHDARKLY_RETRY_DELAYS_MS,
  LAUNCHDARKLY_RETRY_TRIGGER_MIN_INTERVAL_MS,
} from '../service';
import {
  labsContextIdentity,
  type LabsAvailabilityState,
} from '../labs-availability';
import { LabsExperimentsService } from '../../services/labs-experiments-service';

const E2E_FEATURE_FLAGS_ENV = 'CANOPY_E2E_CLIENT_FEATURE_FLAGS';

function createMockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    waitForInitialization: jest.fn().mockResolvedValue(undefined),
    variation: jest.fn((_key: string, defaultValue: boolean) => defaultValue),
    identify: jest.fn().mockResolvedValue({}),
    on: jest.fn(),
    off: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

interface MockClient {
  waitForInitialization: jest.Mock;
  variation: jest.Mock;
  identify: jest.Mock;
  on: jest.Mock;
  off: jest.Mock;
  close: jest.Mock;
}

describe('FeatureFlagService', () => {
  it('a previous account startup cannot close the newly identified client', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    let complete: (() => void) | undefined;
    const first = createMockClient({
      waitForInitialization: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      ),
      variation: jest.fn(() => 'on'),
    });
    const second = createMockClient({ variation: jest.fn(() => 'hidden') });
    mockInitialize.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const service = new FeatureFlagService();
    const startup = service.initialize();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(first.waitForInitialization).toHaveBeenCalled();
    mockBuildContext.mockResolvedValue({ kind: 'user', key: 'new-account' });
    await service.refreshContext();
    complete?.();
    await startup;
    expect(second.close).not.toHaveBeenCalled();
    expect(
      service.getLabsAvailabilityState().liveValues[
        'canopy-desktop-labs-early-access'
      ],
    ).toBe('hidden');
    await service.dispose();
  });

  it('invalidates previous-context live values synchronously and rejects its late callback', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    let callback: (() => void) | undefined;
    const client = createMockClient({
      variation: jest.fn(() => 'on'),
      on: jest.fn((_event: string, listener: () => void) => {
        callback = listener;
      }),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();
    await service.initialize();
    expect(
      service.getLabsAvailabilityState().liveValues[
        'canopy-desktop-labs-early-access'
      ],
    ).toBe('on');
    mockBuildContext.mockResolvedValue({
      kind: 'user',
      key: 'user-2',
      canopyOrganizationIds: ['other'],
    });
    client.identify.mockRejectedValue(new Error('new account offline'));
    service.invalidateContext();
    const refresh = service.refreshContext();
    expect(service.getLabsAvailabilityState()).toMatchObject({
      contextIdentity: null,
      liveValues: {},
    });
    callback?.();
    expect(service.getLabsAvailabilityState().liveValues).toEqual({});
    await refresh;
    expect(service.getLabsAvailabilityState().liveValues).toEqual({});
    expect(
      service.getSnapshot().values['canopy-desktop-labs-early-access'],
    ).toBe('offered');
    await service.dispose();
  });
  it.each(['before-identify', 'after-identify'] as const)(
    'keeps a new account cached hidden ahead of injected on fallback when an old callback arrives %s',
    async (completionOrder) => {
      process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
      const key = CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key;
      const nextContext = {
        kind: 'user' as const,
        key: 'user-2',
        canopyOrganizationIds: ['other'],
      };
      const nextIdentity = labsContextIdentity(nextContext);
      let completeIdentify: (() => void) | undefined;
      let identifyStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        identifyStarted = resolve;
      });
      const pendingIdentify = new Promise<void>((resolve) => {
        completeIdentify = resolve;
      });
      let completeChoices: ((value: unknown) => void) | undefined;
      const pendingChoices = new Promise<unknown>((resolve) => {
        completeChoices = resolve;
      });
      const on = jest.fn<void, [string, () => void]>();
      const client = createMockClient({
        on,
        variation: jest.fn((flagKey: string, fallback: unknown) =>
          flagKey === key ? 'on' : fallback,
        ),
        identify: jest.fn(() => {
          identifyStarted?.();
          return pendingIdentify;
        }),
      });
      mockInitialize.mockReturnValue(client);
      const flags = new FeatureFlagService();
      await flags.initialize();
      const previousIdentity = flags.getLabsAvailabilityState().contextIdentity;
      expect(previousIdentity).toEqual(expect.any(String));
      const previousCallback = on.mock.calls.find(
        ([event]) => event === 'change',
      )?.[1];
      expect(previousCallback).toEqual(expect.any(Function));
      if (!previousCallback)
        throw new Error('Missing previous change listener');
      const files = new Map<string, string>();
      const availabilityWrites: string[] = [];
      const labs = new LabsExperimentsService(
        {
          choicesPath: 'choices',
          availabilityPath: 'availability',
          pendingSyncPath: 'pending',
          read: (path): unknown =>
            path === 'choices'
              ? {
                  version: 1,
                  accounts: {
                    'account-a': { 'early-access': false },
                    'account-b': { 'early-access': true },
                  },
                }
              : {
                  version: 1,
                  contexts: { [nextIdentity]: { [key]: 'hidden' } },
                },
          write: (path, data): Promise<void> => {
            files.set(path, data);
            if (path === 'availability') availabilityWrites.push(data);
            return Promise.resolve();
          },
          availability: (): LabsAvailabilityState =>
            flags.getLabsAvailabilityState(),
          availabilityFallback: (entry): 'on' | undefined =>
            entry.id === 'early-access' ? 'on' : undefined,
          fetchChoices: (): Promise<unknown> => pendingChoices,
          putChoice: jest.fn(),
          diagnostic: jest.fn(),
          mirror: jest.fn(),
        },
        { scope: 'account-a', signedIn: true, ready: true },
      );
      const unsubscribe = flags.onSnapshotChanged(() =>
        labs.availabilityChanged(),
      );
      try {
        labs.availabilityChanged();
        await labs.flush();
        const initialAvailability = {
          version: 1,
          contexts: {
            [previousIdentity ?? '']: { [key]: 'on' },
            [nextIdentity]: { [key]: 'hidden' },
          },
        };
        expect(JSON.parse(files.get('availability') ?? '{}')).toEqual(
          initialAvailability,
        );
        files.clear();
        availabilityWrites.length = 0;
        const before = labs.getSnapshot();
        expect(before.experiments[0]).toMatchObject({
          availability: 'on',
          choice: false,
          enabled: false,
        });
        // Keep the runtime's order: invalidate targeting before activating choices.
        flags.invalidateContext();
        const activation = labs.activate({
          scope: 'account-b',
          signedIn: true,
          ready: true,
        });
        expect(labs.getSnapshot()).toMatchObject({
          scope: 'account-b',
          generation: before.generation + 1,
          ready: false,
          // account-b's cached choices are usable before its GET settles.
          choicesReady: true,
          earlyAccessEnabled: false,
        });
        expect(labs.getSnapshot().experiments[0]).toMatchObject({
          availability: 'on',
          choice: true,
          listed: false,
          enabled: false,
        });
        mockBuildContext.mockResolvedValue(nextContext);
        const refresh = flags.refreshContext();
        await started;
        const assertHidden = (): void => {
          expect(flags.getLabsAvailabilityState().contextIdentity).toBe(
            nextIdentity,
          );
          expect(labs.getSnapshot()).toMatchObject({
            scope: 'account-b',
            generation: before.generation + 1,
            ready: true,
            choicesReady: true,
            earlyAccessEnabled: false,
          });
          expect(labs.getSnapshot().experiments[0]).toMatchObject({
            availability: 'hidden',
            choice: true,
            listed: false,
            enabled: false,
          });
        };
        const deliverPreviousCallback = (): void => {
          client.variation.mockImplementation(
            (flagKey: string, fallback: unknown) =>
              flagKey === key ? 'on' : fallback,
          );
          const reads = client.variation.mock.calls.length;
          previousCallback();
          expect(client.variation).toHaveBeenCalledTimes(reads);
          assertHidden();
        };
        assertHidden();
        if (completionOrder === 'before-identify') deliverPreviousCallback();
        client.variation.mockImplementation(
          (flagKey: string, fallback: unknown) =>
            flagKey === key ? undefined : fallback,
        );
        completeIdentify?.();
        await refresh;
        assertHidden();
        expect(
          flags.getLabsAvailabilityState().liveValues[key],
        ).toBeUndefined();
        expect(flags.getSnapshot().values[key]).toBe('offered');
        if (completionOrder === 'after-identify') deliverPreviousCallback();
        // Neither synthesized on nor the stale callback may replace cached hidden.
        expect(files.has('availability')).toBe(false);
        const currentCallback = on.mock.calls.at(-1)?.[1];
        expect(currentCallback).toEqual(expect.any(Function));
        if (!currentCallback)
          throw new Error('Missing current change listener');
        expect(currentCallback).not.toBe(previousCallback);
        client.variation.mockImplementation(
          (flagKey: string, fallback: unknown) =>
            flagKey === key ? 'offered' : fallback,
        );
        currentCallback();
        // Cached choices remain effective before the account GET completes.
        expect(labs.getSnapshot()).toMatchObject({
          ready: true,
          choicesReady: true,
          earlyAccessEnabled: true,
        });
        expect(labs.getSnapshot().experiments[0]).toMatchObject({
          availability: 'offered',
          choice: true,
          listed: true,
          enabled: true,
        });
        completeChoices?.({ choices: { 'early-access': false } });
        await activation;
        expect(labs.getSnapshot()).toMatchObject({
          scope: 'account-b',
          generation: before.generation + 1,
          ready: true,
          choicesReady: true,
          earlyAccessEnabled: false,
        });
        expect(labs.getSnapshot().experiments[0]).toMatchObject({
          availability: 'offered',
          choice: false,
          listed: true,
          enabled: false,
        });
        await labs.flush();
        expect(availabilityWrites).toEqual([files.get('availability')]);
        expect(JSON.parse(files.get('availability') ?? '{}')).toEqual({
          ...initialAvailability,
          contexts: {
            ...initialAvailability.contexts,
            [nextIdentity]: { [key]: 'offered' },
          },
        });
      } finally {
        completeIdentify?.();
        completeChoices?.({ choices: { 'early-access': false } });
        unsubscribe();
        await flags.dispose();
        await labs.flush();
      }
    },
  );
  it('preserves raw malformed Labs values for validated cache fallback without exporting them as typed availability', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    mockInitialize.mockReturnValue(
      createMockClient({ variation: jest.fn(() => 'invalid-availability') }),
    );
    const service = new FeatureFlagService();
    await service.initialize();
    expect(
      service.getSnapshot().values['canopy-desktop-labs-early-access'],
    ).toBe('offered');
    expect(
      service.getLabsAvailabilityState().liveValues[
        'canopy-desktop-labs-early-access'
      ],
    ).toBe('invalid-availability');
    await service.dispose();
  });

  const originalClientSideId = process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
  const originalE2eFeatureFlags = process.env[E2E_FEATURE_FLAGS_ENV];

  beforeEach(() => {
    jest.clearAllMocks();
    mockElectronApp.isPackaged = false;
    // Keep the suite hermetic: the 'off' sentinel disables LaunchDarkly so
    // a client-side ID inherited from the developer's shell cannot route tests
    // through real LD init. Tests that need an ID set the env explicitly.
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'off';
    mockBuildContext.mockResolvedValue({
      kind: 'user',
      key: 'user-1',
    });
  });

  afterEach(() => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = originalClientSideId;
    if (originalE2eFeatureFlags === undefined) {
      delete process.env[E2E_FEATURE_FLAGS_ENV];
    } else {
      process.env[E2E_FEATURE_FLAGS_ENV] = originalE2eFeatureFlags;
    }
    Object.assign(globalThis, { __CANOPY_E2E__: false });
    Reflect.deleteProperty(
      globalThis,
      '__CANOPY_LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID__',
    );
  });

  it('returns not_configured defaults without importing the SDK when LaunchDarkly is explicitly disabled', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'off';
    const service = new FeatureFlagService();
    const listener = jest.fn();
    service.onSnapshotChanged(listener);

    const snapshot = await service.initialize();

    expect(snapshot).toMatchObject({
      status: 'not_configured',
      initialized: false,
      values: {
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
        [CLIENT_FEATURE_FLAGS.canopyDesktopChatVisuals.key]: true,
      },
    });
    expect(Date.parse(snapshot.updatedAt)).toBeGreaterThan(
      Date.parse('2000-01-01T00:00:00.000Z'),
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'not_configured',
        updatedAt: snapshot.updatedAt,
      }),
    );
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('treats an unset client-side ID as not_configured in unpackaged dev', async () => {
    delete process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
    Object.assign(globalThis, { __CANOPY_E2E__: false });
    const service = new FeatureFlagService();

    const snapshot = await service.initialize();

    expect(snapshot).toMatchObject({
      status: 'not_configured',
      initialized: false,
      values: {
        [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key]: true,
        [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key]: true,
      },
    });
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('keeps unconfigured defaults throughout account context invalidation and refresh', async () => {
    const service = new FeatureFlagService();
    await service.initialize();
    const snapshots: ReturnType<FeatureFlagService['getSnapshot']>[] = [];
    service.onSnapshotChanged((snapshot) => snapshots.push(snapshot));
    service.invalidateContext();
    await service.refreshContext();
    expect(service.getSnapshot().status).toBe('not_configured');
    expect(
      snapshots.every((snapshot) => snapshot.status === 'not_configured'),
    ).toBe(true);
    expect(
      snapshots.every(
        (snapshot) =>
          snapshot.values[CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key] ===
          true,
      ),
    ).toBe(true);
    await service.dispose();
  });

  it('keeps static E2E flags and Labs availability throughout sign-in refresh', async () => {
    Object.assign(globalThis, { __CANOPY_E2E__: true });
    process.env[E2E_FEATURE_FLAGS_ENV] = JSON.stringify({
      [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
      [CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key]: 'on',
    });
    const service = new FeatureFlagService();
    await service.initialize();
    const snapshots: ReturnType<FeatureFlagService['getSnapshot']>[] = [];
    service.onSnapshotChanged((snapshot) => snapshots.push(snapshot));
    service.invalidateContext();
    expect(
      service.getLabsAvailabilityState().liveValues[
        CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key
      ],
    ).toBe('on');
    await service.refreshContext();
    expect(
      snapshots.every(
        (snapshot) =>
          snapshot.values[CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key] ===
          true,
      ),
    ).toBe(true);
    expect(
      service.getSnapshot().values[
        CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key
      ],
    ).toBe('on');
    await service.dispose();
  });

  it('validates E2E Labs page flags as availabilities', async () => {
    Object.assign(globalThis, { __CANOPY_E2E__: true });
    process.env[E2E_FEATURE_FLAGS_ENV] = JSON.stringify({
      [CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage.key]: 'on',
      [CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage.key]: 'enabled',
    });
    const service = new FeatureFlagService();
    const snapshot = await service.initialize();
    expect(
      snapshot.values[CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage.key],
    ).toBe('on');
    expect(
      snapshot.values[CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage.key],
    ).toBe('offered');
    await service.dispose();
  });

  it('treats an unset client-side ID as not_configured in E2E builds', async () => {
    delete process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
    Object.assign(globalThis, { __CANOPY_E2E__: true });
    const service = new FeatureFlagService();

    const snapshot = await service.initialize();

    expect(snapshot.status).toBe('not_configured');
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it.each([25, '25', false])(
    'evaluates the numeric PostHog cap with the unavailable fallback (%s)',
    async (value) => {
      process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
      const rateKey =
        CLIENT_FEATURE_FLAGS.canopyPostHogSessionReplaySampleRate.key;
      const client = createMockClient({
        variation: jest.fn((key: string, fallback: unknown): unknown =>
          key === rateKey ? value : fallback,
        ),
      });
      mockInitialize.mockReturnValue(client);
      const service = new FeatureFlagService();
      const snapshot = await service.initialize();
      expect(client.variation).toHaveBeenCalledWith(rateKey, 0);
      expect(snapshot.values[rateKey]).toBe(value === 25 ? 25 : 0);
      expect(
        snapshot.values[CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key],
      ).toBe(false);
      await service.dispose();
    },
  );

  it('returns a ready snapshot when LaunchDarkly initializes', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    const client = createMockClient({
      variation: jest.fn().mockReturnValue(false),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();

    const snapshot = await service.initialize();

    expect(snapshot).toMatchObject({
      status: 'ready',
      initialized: true,
      values: {
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: false,
        [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]: false,
      },
    });
    expect(mockInitialize.mock.calls[0]?.[0]).toBe('client-side-id');
    expect(mockInitialize.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ key: 'user-1' }),
    );
    const options = mockInitialize.mock.calls[0]?.[2];
    expect(typeof options?.localStoragePath).toBe('string');
    expect(client.variation).toHaveBeenCalledWith(
      CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
      false,
    );
    expect(client.variation).toHaveBeenCalledWith(
      CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key,
      false,
    );
    expect(client.variation).toHaveBeenCalledWith(
      CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key,
      false,
    );
    expect(client.variation).toHaveBeenCalledWith(
      CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key,
      false,
    );
  });

  it('uses the bundled client-side ID when no runtime environment override is set', async () => {
    delete process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
    Object.assign(globalThis, {
      __CANOPY_LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID__: 'bundled-client-id',
    });
    const client = createMockClient();
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();

    await service.initialize();

    expect(mockInitialize.mock.calls[0]?.[0]).toBe('bundled-client-id');
  });

  it('uses the runtime client-side ID only for unpackaged development runs', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'runtime-client-id';
    const client = createMockClient();
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();

    await service.initialize();

    expect(mockInitialize.mock.calls[0]?.[0]).toBe('runtime-client-id');
  });

  it('uses the bundled client-side ID instead of runtime environment values when packaged', async () => {
    mockElectronApp.isPackaged = true;
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'runtime-client-id';
    Object.assign(globalThis, {
      __CANOPY_LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID__: 'bundled-client-id',
    });
    const client = createMockClient();
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();

    await service.initialize();

    expect(mockInitialize.mock.calls[0]?.[0]).toBe('bundled-client-id');
  });

  it('ignores runtime client-side ID values when packaged without a bundled value', async () => {
    mockElectronApp.isPackaged = true;
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'runtime-client-id';
    const service = new FeatureFlagService();

    await expect(service.initialize()).resolves.toMatchObject({
      status: 'not_configured',
      initialized: false,
      values: {
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
      },
    });
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('ignores invalid E2E feature flag override JSON', async () => {
    delete process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
    process.env[E2E_FEATURE_FLAGS_ENV] = '{invalid';
    Object.assign(globalThis, { __CANOPY_E2E__: true });
    const writeSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const service = new FeatureFlagService();

    await expect(service.initialize()).resolves.toMatchObject({
      status: 'not_configured',
      initialized: false,
      values: {
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
      },
    });

    expect(mockInitialize).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Ignoring invalid ${E2E_FEATURE_FLAGS_ENV}`),
    );
    writeSpy.mockRestore();
  });

  it('ignores unknown E2E feature flag override keys', async () => {
    process.env[E2E_FEATURE_FLAGS_ENV] = JSON.stringify({
      'unknown-flag': true,
      [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
    });
    Object.assign(globalThis, { __CANOPY_E2E__: true });
    const writeSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const service = new FeatureFlagService();

    const snapshot = await service.initialize();

    expect(snapshot).toMatchObject({
      status: 'ready',
      initialized: true,
      values: {
        ...CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
      },
    });
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(
      '[feature-flags] Ignoring unknown E2E feature flag override "unknown-flag"\n',
    );
    writeSpy.mockRestore();
  });

  it('uses valid E2E feature flag overrides as an initialized ready snapshot', async () => {
    process.env[E2E_FEATURE_FLAGS_ENV] = JSON.stringify({
      [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
      [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
    });
    Object.assign(globalThis, { __CANOPY_E2E__: true });
    const service = new FeatureFlagService();

    const snapshot = await service.initialize();

    expect(snapshot).toMatchObject({
      status: 'ready',
      initialized: true,
      error: null,
      values: {
        ...CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
      },
    });
    expect(Date.parse(snapshot.updatedAt)).toBeGreaterThan(
      Date.parse('2000-01-01T00:00:00.000Z'),
    );
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockBuildContext).not.toHaveBeenCalled();
  });

  it('prefers real LaunchDarkly initialization over the E2E override when a client-side ID is configured', async () => {
    // E2E specs that inject a (bogus) client-side ID expect the real
    // initialize() path to run instead of the static override snapshot, so the
    // documented enabled-but-unavailable fallback is exercised end to end.
    process.env[E2E_FEATURE_FLAGS_ENV] = JSON.stringify({
      [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
    });
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    Object.assign(globalThis, { __CANOPY_E2E__: true });
    const client = createMockClient({
      variation: jest.fn().mockReturnValue(false),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();

    const snapshot = await service.initialize();

    expect(snapshot).toMatchObject({
      status: 'ready',
      initialized: true,
    });
    // Real init ran (the override would have short-circuited it), so the value
    // comes from the live evaluator, not the override JSON.
    expect(mockInitialize.mock.calls[0]?.[0]).toBe('client-side-id');
    expect(snapshot.values[CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]).toBe(
      false,
    );
  });

  it('tears down a live LaunchDarkly client before returning E2E override values', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    process.env[E2E_FEATURE_FLAGS_ENV] = JSON.stringify({
      [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
    });
    Object.assign(globalThis, { __CANOPY_E2E__: true });
    const changeListeners: Array<() => void> = [];
    const client = createMockClient({
      variation: jest.fn().mockReturnValue(false),
      on: jest.fn((_event: string, listener: () => void): void => {
        changeListeners.push(listener);
      }),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();
    await service.initialize();

    delete process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;

    await expect(service.initialize()).resolves.toMatchObject({
      status: 'ready',
      initialized: true,
      values: {
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
      },
    });
    const changeListener = changeListeners[0];
    if (!changeListener) throw new Error('Expected a change listener.');
    expect(client.off).toHaveBeenCalledWith('change', changeListener);
    expect(client.close).toHaveBeenCalledTimes(1);

    changeListener();

    expect(service.getSnapshot().values).toMatchObject({
      [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
    });
  });

  it('does not preserve E2E override values when LaunchDarkly initialization fails before live values', async () => {
    process.env[E2E_FEATURE_FLAGS_ENV] = JSON.stringify({
      [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
    });
    Object.assign(globalThis, { __CANOPY_E2E__: true });
    const client = createMockClient({
      waitForInitialization: jest
        .fn()
        .mockRejectedValue(new Error('bad client-side id')),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();

    await expect(service.initialize()).resolves.toMatchObject({
      status: 'ready',
      initialized: true,
      values: {
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
      },
    });

    // Inject a bad LD ID mid-test so refreshContext() re-enters initialize().
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'bogus-e2e-id';

    await expect(service.refreshContext()).resolves.toMatchObject({
      status: 'error',
      initialized: false,
      error: 'bad client-side id',
      values: {
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: false,
      },
    });
  });

  it('uses LaunchDarkly-enabled unavailable fallbacks when initialization fails before any live values', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    const client = createMockClient({
      waitForInitialization: jest
        .fn()
        .mockRejectedValue(new Error('timed out')),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();

    await expect(service.initialize()).resolves.toMatchObject({
      status: 'error',
      initialized: false,
      error: 'timed out',
      values: {
        [CLIENT_FEATURE_FLAGS.canopyDesktopChatVisuals.key]: false,
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: false,
      },
    });
  });

  it('reuses the last live values when refresh fails after initialization', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    const client = createMockClient({
      variation: jest.fn().mockReturnValue(true),
      identify: jest.fn().mockRejectedValue(new Error('offline')),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();
    await service.initialize();

    await expect(service.refreshContext()).resolves.toMatchObject({
      status: 'error',
      initialized: true,
      error: 'offline',
      values: {
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
      },
    });
  });

  it('retains the live Copilot rollout through a transient refresh failure', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    const client = createMockClient({
      variation: jest.fn().mockReturnValue(true),
      identify: jest.fn().mockRejectedValue(new Error('offline')),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();
    await service.initialize();
    const key = CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key;
    expect(service.isEnabled(key)).toBe(true);
    const changed = jest.fn<
      void,
      [ReturnType<FeatureFlagService['getSnapshot']>]
    >();
    service.onSnapshotChanged(changed);
    await service.refreshContext();
    expect(service.isEnabled(key)).toBe(true);
    expect(changed).toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({ status: 'error' });
    expect(changed.mock.calls.at(-1)?.[0].values[key]).toBe(true);
    expect(service.getSnapshot().values[key]).toBe(true);
  });

  it('retains the live OpenCode rollout through a transient refresh failure', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    const client = createMockClient({
      variation: jest.fn().mockReturnValue(true),
      identify: jest.fn().mockRejectedValue(new Error('offline')),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();
    await service.initialize();
    const key = CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key;
    expect(service.isEnabled(key)).toBe(true);
    const changed = jest.fn<
      void,
      [ReturnType<FeatureFlagService['getSnapshot']>]
    >();
    service.onSnapshotChanged(changed);
    await service.refreshContext();
    expect(service.isEnabled(key)).toBe(true);
    expect(changed).toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({ status: 'error' });
    expect(changed.mock.calls.at(-1)?.[0].values[key]).toBe(true);
    expect(service.getSnapshot().values[key]).toBe(true);
  });

  it('never broadcasts disabled live flags during a same-context refresh', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    const client = createMockClient({
      variation: jest.fn((key: string) =>
        key === CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key
          ? 'on'
          : true,
      ),
      identify: jest.fn().mockRejectedValue(new Error('offline')),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();
    await service.initialize();
    const snapshots: ReturnType<FeatureFlagService['getSnapshot']>[] = [];
    service.onSnapshotChanged((snapshot) => snapshots.push(snapshot));
    try {
      await service.refreshContext();
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) {
        expect(
          snapshot.values[CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key],
        ).toBe(true);
        expect(
          snapshot.values[
            CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key
          ],
        ).toBe(true);
        expect(
          snapshot.values[
            CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key
          ],
        ).toBe('on');
      }
    } finally {
      await service.dispose();
    }
  });

  it('keeps live rollout flags while a changed targeting context identifies', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    const orgProjects = CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key;
    let finishIdentify: (() => void) | undefined;
    const client = createMockClient({
      variation: jest.fn((key: string) => (key === orgProjects ? true : null)),
      identify: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finishIdentify = resolve;
          }),
      ),
    });
    mockInitialize.mockReturnValue(client);
    mockBuildContext.mockResolvedValue({
      kind: 'user',
      key: 'user-1',
      githubEmail: 'dev@example.com',
    });
    const service = new FeatureFlagService();
    await service.initialize();
    const published: unknown[] = [];
    service.onSnapshotChanged((snapshot) =>
      published.push(snapshot.values[orgProjects]),
    );
    try {
      // A timed-out provider probe changes the targeting hash, not the account.
      mockBuildContext.mockResolvedValue({
        kind: 'user',
        key: 'user-1',
        githubEmail: null,
      });
      const refresh = service.refreshContext();
      for (let i = 0; i < 10 && !finishIdentify; i++) await Promise.resolve();
      expect(finishIdentify).toBeDefined();
      expect(service.isEnabled(orgProjects)).toBe(true);
      finishIdentify?.();
      await refresh;
      expect(published).not.toContain(false);
      expect(service.isEnabled(orgProjects)).toBe(true);
    } finally {
      await service.dispose();
    }
  });

  it('accepts a live Labs kill switch after a failed same-context identify', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    let change: (() => void) | undefined;
    const client = createMockClient({
      variation: jest.fn(() => 'on'),
      identify: jest.fn().mockRejectedValue(new Error('offline')),
      on: jest.fn((_event: string, listener: () => void) => {
        change = listener;
      }),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();
    await service.initialize();
    try {
      await service.refreshContext();
      client.variation.mockReturnValue('hidden');
      change?.();
      expect(
        service.getLabsAvailabilityState().liveValues[
          CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key
        ],
      ).toBe('hidden');
      expect(
        service.getSnapshot().values[
          CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key
        ],
      ).toBe('hidden');
    } finally {
      await service.dispose();
    }
  });

  it('deduplicates concurrent refreshContext calls', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    const client = createMockClient();
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();
    await service.initialize();

    await Promise.all([service.refreshContext(), service.refreshContext()]);

    expect(client.identify).toHaveBeenCalledTimes(1);
  });

  it('cleans up snapshot listeners when unsubscribe is called', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    const changeListeners: Array<() => void> = [];
    const client = createMockClient({
      variation: jest.fn().mockReturnValueOnce(true).mockReturnValue(false),
      on: jest.fn((_event: string, listener: () => void): void => {
        changeListeners.push(listener);
      }),
    });
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();
    await service.initialize();
    const listener = jest.fn();
    const unsubscribe = service.onSnapshotChanged(listener);

    unsubscribe();
    const changeListener = changeListeners[0];
    if (!changeListener) throw new Error('Expected a change listener.');
    changeListener();

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not expose targeting context in snapshots', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    mockInitialize.mockReturnValue(createMockClient());
    mockBuildContext.mockResolvedValue({
      kind: 'user',
      key: 'user-1',
      email: 'person@example.com',
      githubEmail: 'gh@example.com',
      canopyUserEmails: ['Person@Example.com'],
    });
    const service = new FeatureFlagService();

    const snapshot = await service.initialize();

    expect(snapshot).not.toHaveProperty('email');
    expect(snapshot).not.toHaveProperty('githubEmail');
    expect(snapshot).not.toHaveProperty('canopyUserEmails');
  });

  it('disposes idempotently', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    const client = createMockClient();
    mockInitialize.mockReturnValue(client);
    const service = new FeatureFlagService();
    await service.initialize();

    await service.dispose();
    await service.dispose();

    expect(client.close).toHaveBeenCalledTimes(1);
  });
});

describe('FeatureFlagService recovery after a failed LaunchDarkly start (CAN-3511)', () => {
  const originalClientSideId = process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
  const portalKey = CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key;
  const orgProjectsKey = CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key;

  function failingClient(message = 'timed out'): MockClient {
    return createMockClient({
      waitForInitialization: jest.fn().mockRejectedValue(new Error(message)),
    });
  }

  function liveClient(values: Record<string, unknown>): MockClient {
    return createMockClient({
      variation: jest.fn(
        (key: string, fallback: unknown): unknown => values[key] ?? fallback,
      ),
    });
  }

  // `random: () => 0.5` removes the jitter so delays are exact.
  function createService(): FeatureFlagService {
    return new FeatureFlagService({ random: (): number => 0.5 });
  }
  const anyTimestamp: unknown = expect.any(String);
  const portalOn: unknown = expect.objectContaining({ [portalKey]: true });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockElectronApp.isPackaged = false;
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'client-side-id';
    mockBuildContext.mockResolvedValue({ kind: 'user', key: 'user-1' });
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = originalClientSideId;
  });

  it('retries after a failed first start and publishes live values without a restart', async () => {
    const first = failingClient();
    const second = liveClient({ [portalKey]: true, [orgProjectsKey]: true });
    mockInitialize.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const service = createService();
    const listener = jest.fn();
    service.onSnapshotChanged(listener);

    const failed = await service.initialize();
    expect(failed).toMatchObject({ status: 'error', initialized: false });
    expect(failed.values[portalKey]).toBe(false);
    expect(first.close).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[0] - 1);
    expect(mockInitialize).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);

    expect(mockInitialize).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot()).toMatchObject({
      status: 'ready',
      initialized: true,
      error: null,
    });
    expect(service.isEnabled(portalKey)).toBe(true);
    expect(service.isEnabled(orgProjectsKey)).toBe(true);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'ready',
        values: portalOn,
      }),
    );
    await service.dispose();
  });

  it('backs off between failed attempts and caps the delay', async () => {
    mockInitialize.mockImplementation(() => failingClient());
    const service = createService();
    await service.initialize();

    const expectedDelays: number[] = [
      ...LAUNCHDARKLY_RETRY_DELAYS_MS,
      LAUNCHDARKLY_RETRY_DELAYS_MS[LAUNCHDARKLY_RETRY_DELAYS_MS.length - 1] ??
        0,
    ];
    let index = 0;
    for (const delay of expectedDelays) {
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(mockInitialize).toHaveBeenCalledTimes(index + 1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockInitialize).toHaveBeenCalledTimes(index + 2);
      index += 1;
    }
    expect(Math.max(...LAUNCHDARKLY_RETRY_DELAYS_MS)).toBe(10 * 60_000);
    await service.dispose();
  });

  it('keeps jittered delays within 20 percent of the schedule', async () => {
    mockInitialize.mockImplementation(() => failingClient());
    const service = new FeatureFlagService({ random: (): number => 0 });
    await service.initialize();

    const earliest = LAUNCHDARKLY_RETRY_DELAYS_MS[0] * 0.8;
    await jest.advanceTimersByTimeAsync(earliest - 1);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockInitialize).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it('does not rebroadcast unchanged fallback snapshots while background retries keep failing', async () => {
    mockInitialize.mockImplementation(() => failingClient());
    const service = createService();
    await service.initialize();
    const listener = jest.fn();
    service.onSnapshotChanged(listener);

    await jest.advanceTimersByTimeAsync(
      LAUNCHDARKLY_RETRY_DELAYS_MS[0] + LAUNCHDARKLY_RETRY_DELAYS_MS[1],
    );

    expect(mockInitialize).toHaveBeenCalledTimes(3);
    expect(listener).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'timed out',
    });
    await service.dispose();
  });

  it('records a diagnostic while fallback values are in use and when live values recover', async () => {
    mockInitialize
      .mockReturnValueOnce(failingClient('network down'))
      .mockReturnValueOnce(failingClient('network down'))
      .mockReturnValueOnce(liveClient({ [portalKey]: true }));
    const service = createService();
    const recordDiagnostic = jest.fn();
    service.setDiagnosticRecorder(recordDiagnostic);

    await service.initialize();

    expect(recordDiagnostic).toHaveBeenCalledTimes(1);
    expect(recordDiagnostic).toHaveBeenLastCalledWith({
      version: 1,
      timestamp: anyTimestamp,
      kind: 'feature_flags_unavailable',
      error: 'network down',
      retryAfterMs: LAUNCHDARKLY_RETRY_DELAYS_MS[0],
      featureFlagFailedAttempts: 1,
      featureFlagValuesSource: 'unavailable_fallback',
    });

    await jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[0]);
    expect(recordDiagnostic).toHaveBeenCalledTimes(2);
    expect(recordDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'feature_flags_unavailable',
        featureFlagFailedAttempts: 2,
        retryAfterMs: LAUNCHDARKLY_RETRY_DELAYS_MS[1],
      }),
    );

    await jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[1]);
    expect(recordDiagnostic).toHaveBeenCalledTimes(3);
    expect(recordDiagnostic).toHaveBeenLastCalledWith({
      version: 1,
      timestamp: anyTimestamp,
      kind: 'feature_flags_recovered',
      featureFlagFailedAttempts: 2,
      featureFlagOutageMs:
        LAUNCHDARKLY_RETRY_DELAYS_MS[0] + LAUNCHDARKLY_RETRY_DELAYS_MS[1],
      featureFlagRecoveryTrigger: 'backoff',
    });
    await service.dispose();
  });

  it('does not record a diagnostic when the first start succeeds', async () => {
    mockInitialize.mockReturnValue(liveClient({ [portalKey]: true }));
    const service = createService();
    const recordDiagnostic = jest.fn();
    service.setDiagnosticRecorder(recordDiagnostic);

    await service.initialize();
    await jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[0]);

    expect(recordDiagnostic).not.toHaveBeenCalled();
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('marks retained last-live values in the diagnostic when a restart fails after live values', async () => {
    mockInitialize
      .mockReturnValueOnce(liveClient({ [portalKey]: true }))
      .mockReturnValueOnce(failingClient('offline'));
    const service = createService();
    const recordDiagnostic = jest.fn();
    service.setDiagnosticRecorder(recordDiagnostic);
    await service.initialize();

    await service.initialize();

    expect(service.isEnabled(portalKey)).toBe(true);
    expect(recordDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'feature_flags_unavailable',
        featureFlagValuesSource: 'last_live',
      }),
    );
    await service.dispose();
  });

  it.each(['foreground', 'background'] as const)(
    'keeps live rollout flags through a %s restart whose targeting context changed',
    async (mode) => {
      let finishStart: (() => void) | undefined;
      const restarted = createMockClient({
        waitForInitialization: jest.fn(
          () =>
            new Promise<void>((resolve) => {
              finishStart = resolve;
            }),
        ),
        variation: jest.fn((key: string, fallback: unknown): unknown =>
          key === orgProjectsKey || key === portalKey ? true : fallback,
        ),
      });
      const first = liveClient({ [portalKey]: true, [orgProjectsKey]: true });
      const service = createService();
      if (mode === 'foreground') {
        // A failed restart drops the client but keeps the last live values,
        // so the next context refresh starts a new client in the foreground.
        mockInitialize
          .mockReturnValueOnce(first)
          .mockReturnValueOnce(failingClient('offline'))
          .mockReturnValueOnce(restarted);
        await service.initialize();
        await service.initialize();
      } else {
        // A network blip fails identify and schedules a background restart.
        first.identify.mockRejectedValue(new Error('offline'));
        mockInitialize
          .mockReturnValueOnce(first)
          .mockReturnValueOnce(restarted);
        await service.initialize();
        await service.refreshContext();
      }
      expect(service.isEnabled(orgProjectsKey)).toBe(true);
      const published: unknown[] = [];
      service.onSnapshotChanged((snapshot) =>
        published.push(snapshot.values[orgProjectsKey]),
      );
      try {
        // A timed-out provider probe changes the targeting hash, not the account.
        mockBuildContext.mockResolvedValue({
          kind: 'user',
          key: 'user-1',
          githubEmail: null,
        });
        const restart =
          mode === 'foreground'
            ? service.refreshContext()
            : jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[0]);
        for (let i = 0; i < 20 && !finishStart; i++) {
          await jest.advanceTimersByTimeAsync(0);
        }
        expect(finishStart).toBeDefined();
        expect(service.isEnabled(orgProjectsKey)).toBe(true);
        // Labs values belong to the previous targeting context.
        expect(service.getLabsAvailabilityState().liveValues).toEqual({});
        finishStart?.();
        await restart;
        await jest.advanceTimersByTimeAsync(0);
        expect(published.length).toBeGreaterThan(0);
        expect(published.every((value) => value === true)).toBe(true);
        expect(service.getSnapshot().status).toBe('ready');
        expect(service.isEnabled(orgProjectsKey)).toBe(true);
      } finally {
        await service.dispose();
      }
    },
  );

  it('retries immediately on a recovery trigger, at most once per throttle window', async () => {
    mockInitialize
      .mockReturnValueOnce(failingClient())
      .mockReturnValueOnce(liveClient({ [portalKey]: true }));
    const service = createService();
    const recordDiagnostic = jest.fn();
    service.setDiagnosticRecorder(recordDiagnostic);
    await service.initialize();

    // Too soon after the failed attempt: a focus storm cannot spin a loop.
    service.requestRetry('window_focus');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockInitialize).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(
      LAUNCHDARKLY_RETRY_TRIGGER_MIN_INTERVAL_MS,
    );
    expect(mockInitialize).toHaveBeenCalledTimes(1);

    service.requestRetry('power_resume');
    await jest.advanceTimersByTimeAsync(0);

    expect(mockInitialize).toHaveBeenCalledTimes(2);
    expect(service.isEnabled(portalKey)).toBe(true);
    expect(recordDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'feature_flags_recovered',
        featureFlagRecoveryTrigger: 'power_resume',
      }),
    );

    // The pending backoff timer was cancelled by the successful retry.
    await jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[0] * 4);
    expect(mockInitialize).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it('continues the backoff schedule when a triggered retry fails', async () => {
    mockInitialize.mockImplementation(() => failingClient());
    const service = createService();
    await service.initialize();
    await jest.advanceTimersByTimeAsync(
      LAUNCHDARKLY_RETRY_TRIGGER_MIN_INTERVAL_MS,
    );

    service.requestRetry('window_focus');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockInitialize).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[1] - 1);
    expect(mockInitialize).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockInitialize).toHaveBeenCalledTimes(3);
    await service.dispose();
  });

  it('labels a recovery driven by a context refresh during an outage', async () => {
    mockInitialize
      .mockReturnValueOnce(failingClient())
      .mockReturnValueOnce(liveClient({ [portalKey]: true }));
    const service = createService();
    const recordDiagnostic = jest.fn();
    service.setDiagnosticRecorder(recordDiagnostic);
    await service.initialize();

    await service.refreshContext();

    expect(mockInitialize).toHaveBeenCalledTimes(2);
    expect(service.isEnabled(portalKey)).toBe(true);
    expect(recordDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'feature_flags_recovered',
        featureFlagRecoveryTrigger: 'context_refresh',
      }),
    );
    await jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[0] * 4);
    expect(mockInitialize).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it('waits for an in-flight background retry before an explicit start', async () => {
    let resolveRetry: () => void = () => undefined;
    const retryClient = createMockClient({
      waitForInitialization: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRetry = resolve;
          }),
      ),
    });
    mockInitialize
      .mockReturnValueOnce(failingClient())
      .mockReturnValueOnce(retryClient)
      .mockReturnValue(liveClient({ [portalKey]: true }));
    const service = createService();
    await service.initialize();
    await jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[0]);
    expect(mockInitialize).toHaveBeenCalledTimes(2);

    const explicitStart = service.initialize();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockInitialize).toHaveBeenCalledTimes(2);

    resolveRetry();
    await explicitStart;

    expect(mockInitialize).toHaveBeenCalledTimes(3);
    expect(retryClient.close).toHaveBeenCalledTimes(1);
    expect(service.isEnabled(portalKey)).toBe(true);
    await service.dispose();
  });

  it('ignores recovery triggers while LaunchDarkly is healthy', async () => {
    mockInitialize.mockReturnValue(liveClient({ [portalKey]: true }));
    const service = createService();
    await service.initialize();
    await jest.advanceTimersByTimeAsync(
      LAUNCHDARKLY_RETRY_TRIGGER_MIN_INTERVAL_MS,
    );

    service.requestRetry('window_focus');
    await jest.advanceTimersByTimeAsync(0);

    expect(mockInitialize).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('never schedules retries when LaunchDarkly is not configured', async () => {
    process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'off';
    const service = createService();
    await service.initialize();

    service.requestRetry('window_focus');
    await jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[0] * 10);

    expect(mockInitialize).not.toHaveBeenCalled();
    expect(service.getSnapshot().status).toBe('not_configured');
    await service.dispose();
  });

  it.each([
    [true, { baseUrl: 'http://127.0.0.1:4010' }],
    [false, {}],
  ])(
    'points LaunchDarkly at the E2E fixture only in E2E builds (e2e=%s)',
    async (isE2e, expected) => {
      Object.assign(globalThis, { __CANOPY_E2E__: isE2e });
      process.env.CANOPY_E2E_LAUNCHDARKLY_BASE_URL = 'http://127.0.0.1:4010';
      mockInitialize.mockReturnValue(liveClient({}));
      const service = createService();
      try {
        await service.initialize();
        const options = mockInitialize.mock.calls[0]?.[2];
        if (isE2e) {
          expect(options).toMatchObject({
            ...expected,
            streamUrl: 'http://127.0.0.1:4010',
            eventsUrl: 'http://127.0.0.1:4010',
          });
        } else {
          expect(options).not.toHaveProperty('baseUrl');
          expect(options).not.toHaveProperty('streamUrl');
          expect(options).not.toHaveProperty('eventsUrl');
        }
      } finally {
        delete process.env.CANOPY_E2E_LAUNCHDARKLY_BASE_URL;
        Object.assign(globalThis, { __CANOPY_E2E__: false });
        await service.dispose();
      }
    },
  );

  it('cancels a pending retry on dispose', async () => {
    mockInitialize.mockImplementation(() => failingClient());
    const service = createService();
    await service.initialize();

    await service.dispose();
    await jest.advanceTimersByTimeAsync(LAUNCHDARKLY_RETRY_DELAYS_MS[0] * 10);

    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });
});
