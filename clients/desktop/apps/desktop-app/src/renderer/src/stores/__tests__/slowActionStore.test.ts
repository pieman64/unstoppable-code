import type {
  SlowActionEvent,
  SlowActionRecord,
  SlowActionSnapshot,
} from '@canopy/desktop-shared/types';
import {
  __resetSlowActionStoreForTests,
  useSlowActionStore,
} from '../slowActionStore';

interface MockSlowActionApi {
  loadSnapshot: jest.Mock<Promise<SlowActionSnapshot>, []>;
  clear: jest.Mock<Promise<void>, []>;
  onEvent: jest.Mock<() => void, [(event: SlowActionEvent) => void]>;
}

function makeRecord(overrides: Partial<SlowActionRecord>): SlowActionRecord {
  return {
    id: 'slow-action',
    kind: 'ipc',
    label: 'Slow action',
    startedAt: '2026-05-27T12:00:00.000Z',
    startedAtMs: 1_000,
    thresholdMs: 15_000,
    ...overrides,
  };
}

function createSnapshotDeferred(): {
  promise: Promise<SlowActionSnapshot>;
  resolve: (snapshot: SlowActionSnapshot) => void;
} {
  let resolveSnapshot: (snapshot: SlowActionSnapshot) => void = (): void => {
    throw new Error('Deferred snapshot resolver was not initialized');
  };
  const promise = new Promise<SlowActionSnapshot>((resolve) => {
    resolveSnapshot = resolve;
  });
  return {
    promise,
    resolve: resolveSnapshot,
  };
}

function installApi(): MockSlowActionApi {
  const api: MockSlowActionApi = {
    loadSnapshot: jest.fn<Promise<SlowActionSnapshot>, []>(),
    clear: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
    onEvent: jest
      .fn<() => void, [(event: SlowActionEvent) => void]>()
      .mockReturnValue((): void => undefined),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        slowActions: api,
      },
    },
  });
  return api;
}

describe('slowActionStore', () => {
  let originalWindow: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    __resetSlowActionStoreForTests();
  });

  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
    __resetSlowActionStoreForTests();
  });

  it('replays events received while the initial snapshot is loading', async () => {
    const api = installApi();
    const deferred = createSnapshotDeferred();
    const staleRecord = makeRecord({ id: 'slow-stale' });
    api.loadSnapshot.mockReturnValue(deferred.promise);

    const initializePromise = useSlowActionStore.getState().initialize();
    const listener = api.onEvent.mock.calls[0]?.[0];
    expect(typeof listener).toBe('function');
    if (!listener) {
      throw new Error('Expected slow action listener');
    }

    listener({ type: 'resolved', id: staleRecord.id });
    deferred.resolve({ records: [staleRecord] });
    await initializePromise;

    expect(useSlowActionStore.getState()).toMatchObject({
      initialized: true,
      loading: false,
      records: [],
      error: null,
    });
  });

  it('does not resubscribe when initialize is called repeatedly', async () => {
    const api = installApi();
    api.loadSnapshot.mockResolvedValue({ records: [] });

    await useSlowActionStore.getState().initialize();
    await useSlowActionStore.getState().initialize();
    await useSlowActionStore.getState().initialize();

    expect(api.onEvent).toHaveBeenCalledTimes(1);
    expect(api.loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it('treats evicted events as removals', async () => {
    const api = installApi();
    const record = makeRecord({ id: 'slow-evicted' });
    api.loadSnapshot.mockResolvedValue({ records: [record] });

    await useSlowActionStore.getState().initialize();
    const listener = api.onEvent.mock.calls[0]?.[0];
    if (!listener) {
      throw new Error('Expected slow action listener');
    }
    listener({ type: 'evicted', id: record.id });

    expect(useSlowActionStore.getState().records).toEqual([]);
  });

  it('restores records and surfaces the IPC error when clear fails', async () => {
    const api = installApi();
    const record = makeRecord({ id: 'slow-clear-failure' });
    api.clear.mockRejectedValue(new Error('IPC clear failed'));
    useSlowActionStore.setState({
      initialized: true,
      loading: false,
      records: [record],
      error: null,
    });

    await expect(useSlowActionStore.getState().clear()).rejects.toThrow(
      'IPC clear failed',
    );

    expect(useSlowActionStore.getState()).toMatchObject({
      records: [record],
      error: 'IPC clear failed',
    });
  });

  it('keeps initialization retryable after snapshot loading fails', async () => {
    const api = installApi();
    const record = makeRecord({ id: 'slow-buffered' });
    api.loadSnapshot
      .mockRejectedValueOnce(new Error('IPC snapshot failed'))
      .mockResolvedValueOnce({ records: [] });

    const firstInitialize = useSlowActionStore.getState().initialize();
    const firstListener = api.onEvent.mock.calls[0]?.[0];
    if (!firstListener) {
      throw new Error('Expected slow action listener');
    }
    firstListener({ type: 'added', record });

    await firstInitialize;

    expect(useSlowActionStore.getState()).toMatchObject({
      initialized: false,
      loading: false,
      records: [record],
      error: 'IPC snapshot failed',
    });

    await useSlowActionStore.getState().initialize();

    expect(api.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(useSlowActionStore.getState()).toMatchObject({
      initialized: true,
      loading: false,
      records: [],
      error: null,
    });
  });
});
