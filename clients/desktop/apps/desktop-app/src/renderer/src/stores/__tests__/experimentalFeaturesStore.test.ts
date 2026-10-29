/**
 * @jest-environment jsdom
 */
import {
  createTestExperimentsBridge,
  makeTestLabsSnapshot,
  type TestExperimentsBridge,
} from '@/test-utils/labsExperiments';
import { makeTestPreferences } from '@/test-utils/preferences';
import {
  ensureExperimentalFeaturesSubscription,
  resetExperimentalFeaturesStoreForTest,
  useExperimentalFeaturesStore,
  whenExperimentalFeaturesHydrated,
} from '../experimentalFeaturesStore';
import { resetLabsExperimentsStoreForTest } from '../labsExperimentsStore';

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

function installApi(bridge: TestExperimentsBridge): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      experiments: bridge.api,
      // The retired local switch must have no effect.
      loadPreferences: () =>
        Promise.resolve(
          Object.assign(makeTestPreferences(), {
            experimentalFeaturesEnabled: true,
          }),
        ),
    },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

afterEach(() => {
  resetExperimentalFeaturesStoreForTest();
  resetLabsExperimentsStoreForTest();
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

describe('experimentalFeaturesStore', () => {
  it('stays off until the Labs snapshot loads, then follows Early access', async () => {
    installApi(
      createTestExperimentsBridge(makeTestLabsSnapshot({ earlyAccess: true })),
    );
    ensureExperimentalFeaturesSubscription();
    expect(useExperimentalFeaturesStore.getState()).toMatchObject({
      enabled: false,
      hydrated: false,
    });

    await whenExperimentalFeaturesHydrated();

    expect(useExperimentalFeaturesStore.getState()).toMatchObject({
      enabled: true,
      hydrated: true,
    });
  });

  it('ignores the retired local preference', async () => {
    installApi(createTestExperimentsBridge(makeTestLabsSnapshot()));
    await whenExperimentalFeaturesHydrated();
    expect(useExperimentalFeaturesStore.getState().enabled).toBe(false);
  });

  it('follows pushes, including an Early access kill switch', async () => {
    const bridge = createTestExperimentsBridge(
      makeTestLabsSnapshot({ earlyAccess: true }),
    );
    installApi(bridge);
    await whenExperimentalFeaturesHydrated();
    expect(useExperimentalFeaturesStore.getState().enabled).toBe(true);

    bridge.push(
      makeTestLabsSnapshot({
        earlyAccess: true,
        earlyAccessAvailability: 'hidden',
        revision: 2,
      }),
    );
    expect(useExperimentalFeaturesStore.getState().enabled).toBe(false);
  });

  it('stays off while main reports the snapshot not ready', async () => {
    installApi(
      createTestExperimentsBridge(
        makeTestLabsSnapshot({ earlyAccess: true, ready: false }),
      ),
    );
    await whenExperimentalFeaturesHydrated();
    expect(useExperimentalFeaturesStore.getState()).toMatchObject({
      enabled: false,
      hydrated: true,
    });
  });

  it('subscribes once however many consumers ask', async () => {
    const bridge = createTestExperimentsBridge();
    installApi(bridge);
    ensureExperimentalFeaturesSubscription();
    ensureExperimentalFeaturesSubscription();
    await flush();
    expect(bridge.subscriberCount()).toBe(1);
  });

  it('treats a host without the experiments bridge as off', () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} });
    ensureExperimentalFeaturesSubscription();
    expect(useExperimentalFeaturesStore.getState()).toMatchObject({
      enabled: false,
      hydrated: true,
    });
  });
});
