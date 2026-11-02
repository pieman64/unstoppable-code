import type { SharedContainerInboxChangedEvent } from '@canopy/desktop-shared/types';
import type { CanopyCloudAccountEntry } from '../lib/canopy-cloud-account-store';
import type {
  CreateSharedContainerInboxSubscriptionOptions,
  SharedContainerRealtimeSubscription,
} from '../shared-containers/realtime-subscription';

const appOnMock = jest.fn<void, [string, () => void]>();
const appOffMock = jest.fn<void, [string, () => void]>();

jest.mock('electron', () => ({
  app: {
    on: (...args: [string, () => void]): void => appOnMock(...args),
    removeListener: (...args: [string, () => void]): void =>
      appOffMock(...args),
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
}));

import { createSharedContainerInboxWatcherForTest } from '../services/shared-container-inbox-watcher';

function account(id = 'account-1', apiKey = 'key-1'): CanopyCloudAccountEntry {
  return {
    apiKey,
    capabilities: ['shared-containers-v1'],
    account: {
      id,
      name: 'Recipient',
      email: 'recipient@example.com',
      role: 'DEVELOPER',
    },
    organizations: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

interface Harness {
  watcher: ReturnType<typeof createSharedContainerInboxWatcherForTest>;
  subscribe: jest.Mock<
    SharedContainerRealtimeSubscription,
    [CreateSharedContainerInboxSubscriptionOptions]
  >;
  emit: jest.Mock<void, [SharedContainerInboxChangedEvent]>;
  publishAccount: (entry: CanopyCloudAccountEntry | null) => void;
  publishEnabled: (enabled: boolean) => void;
  signal: () => void;
  signalAt: (index: number) => void;
  deny: () => void;
  order: string[];
}

function harness(
  initial: CanopyCloudAccountEntry | null = account(),
  initialEnabled = true,
): Harness {
  let accountListener: (entry: CanopyCloudAccountEntry | null) => void = () =>
    undefined;
  let enabledListener = (): void => undefined;
  let enabled = initialEnabled;
  let signal = (): void => undefined;
  const signals: Array<() => void> = [];
  let deny = (): void => undefined;
  const order: string[] = [];
  const subscribe = jest.fn<
    SharedContainerRealtimeSubscription,
    [CreateSharedContainerInboxSubscriptionOptions]
  >((options) => {
    order.push('start');
    signal = options.onSignal;
    signals.push(options.onSignal);
    deny = options.onAccessDenied ?? ((): void => undefined);
    return {
      stop: (): void => {
        order.push('stop');
      },
    };
  });
  const emit = jest.fn<void, [SharedContainerInboxChangedEvent]>();
  const watcher = createSharedContainerInboxWatcherForTest({
    subscribe,
    emit,
    loadAccount: () => Promise.resolve(initial),
    subscribeAccountChanges: (listener) => {
      accountListener = listener;
      return (): void => undefined;
    },
    subscribeEnabledChanges: (listener) => {
      enabledListener = listener;
      return (): void => undefined;
    },
    isEnabled: () => enabled,
    now: () => Date.now(),
  });
  return {
    watcher,
    subscribe,
    emit,
    publishAccount: (entry) => accountListener(entry),
    publishEnabled: (nextEnabled): void => {
      enabled = nextEnabled;
      enabledListener();
    },
    signal: () => signal(),
    signalAt: (index) => signals[index]?.(),
    deny: () => deny(),
    order,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('shared-container inbox watcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    jest.clearAllMocks();
    process.env.CANOPY_E2E_SHARED_CONTAINER_INBOX_INTERVAL_MS = '1000';
    process.env.CANOPY_E2E_SHARED_CONTAINER_INBOX_FOCUS_THROTTLE_MS = '500';
    process.env.CANOPY_E2E_SHARED_CONTAINER_INBOX_SIGNAL_DEBOUNCE_MS = '250';
    process.env.CANOPY_E2E_SHARED_CONTAINER_INBOX_SIGNAL_MIN_EMIT_INTERVAL_MS =
      '1000';
  });

  afterEach(() => {
    delete process.env.CANOPY_E2E_SHARED_CONTAINER_INBOX_INTERVAL_MS;
    delete process.env.CANOPY_E2E_SHARED_CONTAINER_INBOX_FOCUS_THROTTLE_MS;
    delete process.env.CANOPY_E2E_SHARED_CONTAINER_INBOX_SIGNAL_DEBOUNCE_MS;
    delete process.env
      .CANOPY_E2E_SHARED_CONTAINER_INBOX_SIGNAL_MIN_EMIT_INTERVAL_MS;
    jest.useRealTimers();
  });

  it('starts and shuts down idempotently without leaving timers', async () => {
    const { watcher, subscribe } = harness();
    watcher.start();
    watcher.start();
    await flush();

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(appOnMock).toHaveBeenCalledTimes(1);
    watcher.shutdown();
    watcher.shutdown();
    expect(jest.getTimerCount()).toBe(0);
    expect(appOffMock).toHaveBeenCalledTimes(1);
  });

  it('debounces transaction-paired signals and emits one trailing storm refresh', async () => {
    process.env.CANOPY_E2E_SHARED_CONTAINER_INBOX_INTERVAL_MS = '10000';
    const { watcher, emit, signal } = harness();
    watcher.start();
    await flush();

    signal();
    signal();
    expect(emit).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(300);
    signal();
    expect(emit).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(700);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map(([event]) => event.reason)).toEqual([
      'realtime',
      'realtime',
    ]);
    watcher.shutdown();
  });

  it('emits heartbeat and throttled focus refreshes only while signed in', async () => {
    const { watcher, emit, publishAccount } = harness();
    watcher.start();
    await flush();

    await jest.advanceTimersByTimeAsync(1000);
    expect(emit).toHaveBeenCalledWith({ reason: 'poll' });
    const focus = appOnMock.mock.calls[0]?.[1];
    focus?.();
    focus?.();
    expect(
      emit.mock.calls.filter(([event]) => event.reason === 'focus'),
    ).toHaveLength(1);

    publishAccount(null);
    await jest.advanceTimersByTimeAsync(1000);
    focus?.();
    expect(emit).toHaveBeenCalledTimes(2);
    watcher.shutdown();
  });

  it('emits a local change at once, outside the realtime debounce', async () => {
    const { watcher, emit, signal, publishAccount } = harness();
    watcher.signalLocalChange();
    expect(emit).not.toHaveBeenCalled();

    watcher.start();
    await flush();
    signal();
    expect(emit.mock.calls.map(([event]) => event.reason)).toEqual([
      'realtime',
    ]);

    // Inside both the 250ms debounce and the 1s minimum realtime interval.
    watcher.signalLocalChange();
    watcher.signalLocalChange();
    expect(emit.mock.calls.map(([event]) => event.reason)).toEqual([
      'realtime',
      'local',
      'local',
    ]);
    // A local emit does not consume the realtime budget either.
    await jest.advanceTimersByTimeAsync(1000);
    signal();
    expect(emit.mock.calls.at(-1)?.[0]).toEqual({ reason: 'realtime' });

    publishAccount(null);
    emit.mockClear();
    watcher.signalLocalChange();
    expect(emit).not.toHaveBeenCalled();
    watcher.shutdown();
  });

  it('stops the old identity before starting the new one and reconnects a rotated key', async () => {
    const { watcher, emit, publishAccount, signalAt, order } = harness();
    watcher.start();
    await flush();
    order.length = 0;

    publishAccount(account('account-2', 'key-2'));
    expect(order).toEqual(['stop', 'start']);
    signalAt(0);
    expect(emit).not.toHaveBeenCalled();
    order.length = 0;
    publishAccount(account('account-2', 'key-3'));
    expect(order).toEqual(['stop', 'start']);
    watcher.shutdown();
  });

  it('re-arms a terminally denied stream on the next account write', async () => {
    const { watcher, subscribe, deny, publishAccount } = harness();
    watcher.start();
    await flush();
    deny();
    publishAccount(account());
    expect(subscribe).toHaveBeenCalledTimes(2);
    watcher.shutdown();
  });

  it('reconciles the subscription when feature-flag enablement changes', async () => {
    const { watcher, subscribe, publishEnabled, order } = harness(
      account(),
      false,
    );
    watcher.start();
    await flush();

    expect(subscribe).not.toHaveBeenCalled();
    publishEnabled(true);
    expect(subscribe).toHaveBeenCalledTimes(1);

    order.length = 0;
    publishEnabled(false);
    expect(order).toEqual(['stop']);
    watcher.shutdown();
  });
});
