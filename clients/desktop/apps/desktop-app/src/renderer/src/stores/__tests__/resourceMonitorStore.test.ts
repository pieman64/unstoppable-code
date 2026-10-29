import type { ResourceMonitorSnapshot } from '@canopy/desktop-shared/types';
import {
  __resetResourceMonitorStoreForTests,
  useResourceMonitorStore,
} from '../resourceMonitorStore';

interface MockApi {
  getResourceMonitorSnapshot: jest.Mock<Promise<ResourceMonitorSnapshot>, []>;
  onResourceMonitorSnapshot: jest.Mock<
    () => void,
    [(snapshot: ResourceMonitorSnapshot) => void]
  >;
}

function makeSnapshot(
  overrides: Partial<ResourceMonitorSnapshot> = {},
): ResourceMonitorSnapshot {
  return {
    version: 1,
    sampledAt: '2026-05-07T00:00:00.000Z',
    appPid: 1234,
    cpuPercent: 12,
    memoryRssBytes: 1024 * 1024 * 256,
    processCount: 4,
    pressure: {
      level: 'ok',
      reasons: [],
      warningMemoryBytes: 1024 * 1024 * 1024,
      criticalMemoryBytes: 1024 * 1024 * 1024 * 4,
    },
    groups: [],
    guards: {
      chatTurns: {
        activeTurns: 0,
        pendingMessages: 0,
        maxConcurrentTurns: 4,
        blocked: false,
      },
      pipelines: {
        activeExecutions: 0,
        maxConcurrentExecutions: 5,
        blocked: false,
      },
      codexPools: {
        activeConnections: 0,
        liveProcesses: 0,
        activeTurns: 0,
      },
    },
    ...overrides,
  };
}

function installApi(): MockApi {
  const onResourceMonitorSnapshot = jest
    .fn<() => void, [(snapshot: ResourceMonitorSnapshot) => void]>()
    .mockReturnValue((): void => undefined);
  const getResourceMonitorSnapshot = jest.fn<
    Promise<ResourceMonitorSnapshot>,
    []
  >();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        getResourceMonitorSnapshot,
        onResourceMonitorSnapshot,
      },
    },
  });
  return {
    getResourceMonitorSnapshot,
    onResourceMonitorSnapshot,
  };
}

function createSnapshotDeferred(): {
  promise: Promise<ResourceMonitorSnapshot>;
  resolve: (snapshot: ResourceMonitorSnapshot) => void;
} {
  let resolveSnapshot: (
    snapshot: ResourceMonitorSnapshot,
  ) => void = (): void => {
    throw new Error('Deferred snapshot resolver was not initialized');
  };
  const promise = new Promise<ResourceMonitorSnapshot>((resolve) => {
    resolveSnapshot = resolve;
  });
  return {
    promise,
    resolve: resolveSnapshot,
  };
}

describe('resourceMonitorStore', () => {
  let originalWindow: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    __resetResourceMonitorStoreForTests();
  });

  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    __resetResourceMonitorStoreForTests();
  });

  it('starts in a loading state with no snapshot or error', () => {
    const state = useResourceMonitorStore.getState();
    expect(state.initialized).toBe(false);
    expect(state.loading).toBe(true);
    expect(state.snapshot).toBeNull();
    expect(state.error).toBeNull();
  });

  it('subscribes to push snapshots and applies the initial fetch result', async () => {
    const api = installApi();
    const snapshot = makeSnapshot({ cpuPercent: 25 });
    api.getResourceMonitorSnapshot.mockResolvedValue(snapshot);

    await useResourceMonitorStore.getState().initialize();

    expect(api.onResourceMonitorSnapshot).toHaveBeenCalledTimes(1);
    expect(api.getResourceMonitorSnapshot).toHaveBeenCalledTimes(1);

    const state = useResourceMonitorStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.snapshot).toEqual(snapshot);
    expect(state.error).toBeNull();
  });

  it('applies a pushed snapshot without polling', async () => {
    const api = installApi();
    api.getResourceMonitorSnapshot.mockResolvedValue(makeSnapshot());

    await useResourceMonitorStore.getState().initialize();

    const listener = api.onResourceMonitorSnapshot.mock.calls[0]?.[0];
    expect(typeof listener).toBe('function');

    if (!listener) {
      throw new Error('Expected resource monitor listener');
    }
    listener(makeSnapshot({ cpuPercent: 99 }));

    expect(useResourceMonitorStore.getState().snapshot?.cpuPercent).toBe(99);
  });

  it('keeps the prior snapshot and surfaces an error message on fetch failure', async () => {
    const api = installApi();
    api.getResourceMonitorSnapshot.mockRejectedValue(
      new Error('IPC bridge offline'),
    );

    // Seed a prior snapshot through the listener path before initialize fails.
    const seed = makeSnapshot({ cpuPercent: 5 });
    api.onResourceMonitorSnapshot.mockImplementation(
      (listener): (() => void) => {
        // Push the seed asynchronously so initialize subscribes first.
        queueMicrotask(() => listener(seed));
        return (): void => undefined;
      },
    );

    await useResourceMonitorStore.getState().initialize();

    const state = useResourceMonitorStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.snapshot).toEqual(seed);
    expect(state.error).toBe('IPC bridge offline');
  });

  it('initialize is idempotent — repeated calls do not resubscribe', async () => {
    const api = installApi();
    api.getResourceMonitorSnapshot.mockResolvedValue(makeSnapshot());

    await useResourceMonitorStore.getState().initialize();
    await useResourceMonitorStore.getState().initialize();
    await useResourceMonitorStore.getState().initialize();

    expect(api.onResourceMonitorSnapshot).toHaveBeenCalledTimes(1);
    expect(api.getResourceMonitorSnapshot).toHaveBeenCalledTimes(1);
  });

  it('dispose releases the live snapshot subscription', async () => {
    const unsubscribe = jest.fn();
    const api = installApi();
    api.onResourceMonitorSnapshot.mockReturnValue(unsubscribe);
    api.getResourceMonitorSnapshot.mockResolvedValue(makeSnapshot());

    await useResourceMonitorStore.getState().initialize();
    useResourceMonitorStore.getState().dispose();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(useResourceMonitorStore.getState()).toMatchObject({
      initialized: false,
      loading: true,
      snapshot: null,
      error: null,
    });
  });

  it('ignores stale initialization results after dispose', async () => {
    const api = installApi();
    const deferred = createSnapshotDeferred();
    api.getResourceMonitorSnapshot.mockReturnValue(deferred.promise);

    const initializePromise = useResourceMonitorStore.getState().initialize();
    useResourceMonitorStore.getState().dispose();

    deferred.resolve(makeSnapshot({ cpuPercent: 77 }));
    await initializePromise;

    expect(useResourceMonitorStore.getState()).toMatchObject({
      initialized: false,
      loading: true,
      snapshot: null,
      error: null,
    });
  });

  it('a snapshot whose error field is populated still updates UI rows but flags the error tone', async () => {
    const api = installApi();
    const errorSnapshot = makeSnapshot({
      error: 'Sampling fallback unavailable on this platform',
    });
    api.getResourceMonitorSnapshot.mockResolvedValue(errorSnapshot);

    await useResourceMonitorStore.getState().initialize();

    const state = useResourceMonitorStore.getState();
    expect(state.snapshot).toEqual(errorSnapshot);
    expect(state.error).toBe('Sampling fallback unavailable on this platform');
  });
});
