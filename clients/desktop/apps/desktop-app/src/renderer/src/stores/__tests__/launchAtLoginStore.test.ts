import type {
  LaunchAtLoginApi,
  LaunchAtLoginSetResult,
  LaunchAtLoginStatus,
} from '@canopy/desktop-shared/types';
import { useLaunchAtLoginStore } from '../launchAtLoginStore';

function status(
  overrides: Partial<LaunchAtLoginStatus> = {},
): LaunchAtLoginStatus {
  return {
    platform: 'darwin',
    supported: true,
    enabled: false,
    pendingApproval: false,
    ...overrides,
  };
}

interface BridgeStub extends LaunchAtLoginApi {
  getStatus: jest.Mock<Promise<LaunchAtLoginStatus>, []>;
  setEnabled: jest.Mock<Promise<LaunchAtLoginSetResult>, [boolean]>;
  openSystemSettings: jest.Mock<Promise<void>, []>;
  emit: (next: LaunchAtLoginStatus) => void;
  listenerCount: () => number;
}

let windowTarget: EventTarget;

function installBridge(initial: LaunchAtLoginStatus): BridgeStub {
  const listeners = new Set<(next: LaunchAtLoginStatus) => void>();
  const bridge: BridgeStub = {
    getStatus: jest.fn(() => Promise.resolve(initial)),
    setEnabled: jest.fn<Promise<LaunchAtLoginSetResult>, [boolean]>(),
    openSystemSettings: jest.fn(() => Promise.resolve()),
    onStatusChanged: (cb): (() => void) => {
      listeners.add(cb);
      return (): void => {
        listeners.delete(cb);
      };
    },
    emit: (next): void => {
      listeners.forEach((listener) => listener(next));
    },
    listenerCount: (): number => listeners.size,
  };
  windowTarget = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(windowTarget, { api: { launchAtLogin: bridge } }),
  });
  return bridge;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  useLaunchAtLoginStore.setState({
    status: null,
    hydrated: false,
    busy: false,
    error: null,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: undefined,
  });
});

describe('useLaunchAtLoginStore', () => {
  it('reads the OS status', async () => {
    installBridge(status({ enabled: true }));
    await useLaunchAtLoginStore.getState().refresh();
    expect(useLaunchAtLoginStore.getState()).toMatchObject({
      hydrated: true,
      status: { enabled: true },
    });
  });

  it('stops waiting without a bridge', async () => {
    await useLaunchAtLoginStore.getState().refresh();
    expect(useLaunchAtLoginStore.getState()).toMatchObject({
      hydrated: true,
      status: null,
    });
  });

  it('stays usable when the status read fails', async () => {
    const bridge = installBridge(status());
    bridge.getStatus.mockRejectedValue(new Error('ipc down'));
    await useLaunchAtLoginStore.getState().refresh();
    expect(useLaunchAtLoginStore.getState()).toMatchObject({
      hydrated: true,
      status: null,
    });
  });

  it('keeps a push that lands while a read is in flight', async () => {
    const bridge = installBridge(status());
    const read = deferred<LaunchAtLoginStatus>();
    bridge.getStatus.mockReturnValue(read.promise);
    const detach = useLaunchAtLoginStore.getState().subscribeBridge();
    const refreshing = useLaunchAtLoginStore.getState().refresh();
    bridge.emit(status({ enabled: true }));
    read.resolve(status({ enabled: false }));
    await refreshing;
    expect(useLaunchAtLoginStore.getState().status?.enabled).toBe(true);
    detach();
  });

  it('applies the read-back after a successful change', async () => {
    const bridge = installBridge(status());
    bridge.setEnabled.mockResolvedValue({
      ok: true,
      status: status({ enabled: true }),
    });
    const result = await useLaunchAtLoginStore.getState().setEnabled(true);
    expect(bridge.setEnabled).toHaveBeenCalledWith(true);
    expect(result?.ok).toBe(true);
    expect(useLaunchAtLoginStore.getState()).toMatchObject({
      busy: false,
      error: null,
      status: { enabled: true },
    });
  });

  it('is busy for the length of the round trip', async () => {
    const bridge = installBridge(status());
    const answer = deferred<LaunchAtLoginSetResult>();
    bridge.setEnabled.mockReturnValue(answer.promise);
    const pending = useLaunchAtLoginStore.getState().setEnabled(true);
    expect(useLaunchAtLoginStore.getState().busy).toBe(true);
    answer.resolve({ ok: true, status: status({ enabled: true }) });
    await pending;
    expect(useLaunchAtLoginStore.getState().busy).toBe(false);
  });

  it('keeps the OS read-back and records a refusal', async () => {
    const bridge = installBridge(status());
    bridge.setEnabled.mockResolvedValue({
      ok: false,
      reason: 'refused',
      status: status({ enabled: false }),
    });
    await useLaunchAtLoginStore.getState().setEnabled(true);
    expect(useLaunchAtLoginStore.getState()).toMatchObject({
      status: { enabled: false },
      error: { reason: 'refused', requested: true },
    });
  });

  it('records a failed round trip and rethrows it', async () => {
    const bridge = installBridge(status());
    bridge.setEnabled.mockRejectedValue(new Error('ipc down'));
    await expect(
      useLaunchAtLoginStore.getState().setEnabled(false),
    ).rejects.toThrow('ipc down');
    expect(useLaunchAtLoginStore.getState()).toMatchObject({
      busy: false,
      error: { reason: 'failed', requested: false },
    });
  });

  it('does not report an unsupported build as an error', async () => {
    const bridge = installBridge(status());
    bridge.setEnabled.mockResolvedValue({
      ok: false,
      reason: 'unsupported',
      status: status({
        supported: false,
        unsupportedReason: 'development-build',
      }),
    });
    await useLaunchAtLoginStore.getState().setEnabled(true);
    expect(useLaunchAtLoginStore.getState()).toMatchObject({
      error: null,
      status: { supported: false },
    });
  });

  it('clears a refusal once the OS catches up with the request', async () => {
    const bridge = installBridge(status());
    bridge.setEnabled.mockResolvedValue({
      ok: false,
      reason: 'refused',
      status: status({ enabled: false }),
    });
    const detach = useLaunchAtLoginStore.getState().subscribeBridge();
    await useLaunchAtLoginStore.getState().setEnabled(true);
    expect(useLaunchAtLoginStore.getState().error).not.toBeNull();
    // The user fixed it in System Settings and came back.
    bridge.emit(status({ enabled: true }));
    expect(useLaunchAtLoginStore.getState().error).toBeNull();
    detach();
  });

  it('keeps a newer push over the set response snapshot', async () => {
    const bridge = installBridge(status());
    const answer = deferred<LaunchAtLoginSetResult>();
    bridge.setEnabled.mockReturnValue(answer.promise);
    const detach = useLaunchAtLoginStore.getState().subscribeBridge();
    const pending = useLaunchAtLoginStore.getState().setEnabled(true);
    bridge.emit(status({ enabled: false, pendingApproval: true }));
    answer.resolve({ ok: true, status: status({ enabled: true }) });
    await pending;
    expect(useLaunchAtLoginStore.getState().status).toMatchObject({
      pendingApproval: true,
    });
    detach();
  });

  it('opens the system pane through the bridge', async () => {
    const bridge = installBridge(status());
    await useLaunchAtLoginStore.getState().openSystemSettings();
    expect(bridge.openSystemSettings).toHaveBeenCalledTimes(1);
  });
});

describe('useLaunchAtLoginStore.watch', () => {
  it('shares one subscription, one focus listener, and one read between watchers', async () => {
    const bridge = installBridge(status());
    const detachSettings = useLaunchAtLoginStore.getState().watch();
    const detachChecklist = useLaunchAtLoginStore.getState().watch();
    await flush();
    expect(bridge.listenerCount()).toBe(1);
    expect(bridge.getStatus).toHaveBeenCalledTimes(1);

    windowTarget.dispatchEvent(new Event('focus'));
    await flush();
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);

    detachSettings();
    expect(bridge.listenerCount()).toBe(1);
    windowTarget.dispatchEvent(new Event('focus'));
    await flush();
    expect(bridge.getStatus).toHaveBeenCalledTimes(3);

    detachChecklist();
    expect(bridge.listenerCount()).toBe(0);
    windowTarget.dispatchEvent(new Event('focus'));
    await flush();
    expect(bridge.getStatus).toHaveBeenCalledTimes(3);
  });

  it('does not let a read that never answered block the next watcher', async () => {
    const bridge = installBridge(status());
    bridge.getStatus.mockReturnValueOnce(new Promise(() => undefined));
    const detach = useLaunchAtLoginStore.getState().watch();
    await flush();
    detach();

    bridge.getStatus.mockResolvedValue(status({ enabled: true }));
    const detachNext = useLaunchAtLoginStore.getState().watch();
    await flush();
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);
    expect(useLaunchAtLoginStore.getState().status?.enabled).toBe(true);
    detachNext();
  });

  it('keeps a newer read over an older one that answers late', async () => {
    const bridge = installBridge(status());
    const older = deferred<LaunchAtLoginStatus>();
    const newer = deferred<LaunchAtLoginStatus>();
    bridge.getStatus
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const detach = useLaunchAtLoginStore.getState().watch();
    await flush();
    detach();

    const detachNext = useLaunchAtLoginStore.getState().watch();
    await flush();
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);
    newer.resolve(status({ enabled: true }));
    await flush();
    older.resolve(status({ enabled: false }));
    await flush();
    expect(useLaunchAtLoginStore.getState().status?.enabled).toBe(true);
    detachNext();
  });

  it('keeps the same status object when the OS answer did not change', async () => {
    const bridge = installBridge(status({ enabled: true }));
    // A fresh but equal answer each time, as IPC delivers.
    bridge.getStatus.mockImplementation(() =>
      Promise.resolve(status({ enabled: true })),
    );
    await useLaunchAtLoginStore.getState().refresh();
    const first = useLaunchAtLoginStore.getState().status;
    await useLaunchAtLoginStore.getState().refresh();
    // Consumers re-render only when the OS state actually changed.
    expect(useLaunchAtLoginStore.getState().status).toBe(first);
  });

  it('reads on attach, follows pushes, and re-reads on window focus', async () => {
    const bridge = installBridge(status());
    const detach = useLaunchAtLoginStore.getState().watch();
    await flush();
    expect(bridge.getStatus).toHaveBeenCalledTimes(1);
    expect(useLaunchAtLoginStore.getState().hydrated).toBe(true);

    bridge.emit(status({ enabled: true }));
    expect(useLaunchAtLoginStore.getState().status?.enabled).toBe(true);

    // Changed in System Settings while the app was in the background.
    bridge.getStatus.mockResolvedValue(status({ enabled: false }));
    windowTarget.dispatchEvent(new Event('focus'));
    await flush();
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);
    expect(useLaunchAtLoginStore.getState().status?.enabled).toBe(false);

    detach();
    expect(bridge.listenerCount()).toBe(0);
    windowTarget.dispatchEvent(new Event('focus'));
    await flush();
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);
  });
});
