import type {
  GlobalFocusShortcutApi,
  GlobalFocusShortcutStatus,
  GlobalFocusShortcutUpdateResponse,
} from '@canopy/desktop-shared/types';
import { formatShortcut } from '@/lib/keyboardShortcuts';
import {
  formatGlobalFocusShortcutForDisplay,
  useGlobalFocusShortcutStore,
} from '../globalFocusShortcutStore';

function status(
  overrides: Partial<GlobalFocusShortcutStatus> = {},
): GlobalFocusShortcutStatus {
  return {
    enabled: false,
    accelerator: 'CommandOrControl+Shift+O',
    registered: false,
    platform: 'darwin',
    ...overrides,
  };
}

interface BridgeStub extends GlobalFocusShortcutApi {
  emit: (next: GlobalFocusShortcutStatus) => void;
}

function installBridge(initial: GlobalFocusShortcutStatus): BridgeStub {
  let listener: ((next: GlobalFocusShortcutStatus) => void) | null = null;
  const bridge: BridgeStub = {
    getStatus: jest.fn().mockResolvedValue(initial),
    update: jest.fn(),
    onStatusChanged: jest.fn(
      (cb: (next: GlobalFocusShortcutStatus) => void) => {
        listener = cb;
        return (): void => {
          listener = null;
        };
      },
    ),
    emit: (next): void => {
      listener?.(next);
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { globalFocusShortcut: bridge } },
  });
  return bridge;
}

beforeEach(() => {
  useGlobalFocusShortcutStore.setState({
    status: null,
    hydrated: false,
    busy: false,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: undefined,
  });
});

describe('useGlobalFocusShortcutStore', () => {
  it('hydrates from the bridge', async () => {
    installBridge(status({ enabled: true, registered: true }));

    await useGlobalFocusShortcutStore.getState().hydrate();

    expect(useGlobalFocusShortcutStore.getState()).toMatchObject({
      hydrated: true,
      status: { enabled: true, registered: true },
    });
  });

  it('marks itself hydrated without a bridge so consumers stop waiting', async () => {
    await useGlobalFocusShortcutStore.getState().hydrate();

    expect(useGlobalFocusShortcutStore.getState()).toMatchObject({
      hydrated: true,
      status: null,
    });
  });

  it('follows status pushes after subscribing', () => {
    const bridge = installBridge(status());
    const unsubscribe = useGlobalFocusShortcutStore
      .getState()
      .subscribeBridge();

    bridge.emit(status({ enabled: true, registered: true }));
    expect(useGlobalFocusShortcutStore.getState().status).toMatchObject({
      enabled: true,
      registered: true,
    });

    unsubscribe();
    bridge.emit(status({ enabled: false }));
    expect(useGlobalFocusShortcutStore.getState().status).toMatchObject({
      enabled: true,
    });
  });

  it('keeps a status push that lands while hydrate is still in flight', async () => {
    const bridge = installBridge(status());
    let resolveGetStatus: (value: GlobalFocusShortcutStatus) => void = () =>
      undefined;
    bridge.getStatus = jest.fn(
      () =>
        new Promise<GlobalFocusShortcutStatus>((resolve) => {
          resolveGetStatus = resolve;
        }),
    );
    const store = useGlobalFocusShortcutStore.getState();
    const unsubscribe = store.subscribeBridge();

    const pending = store.hydrate();
    const pushed = status({ enabled: true, registered: true });
    bridge.emit(pushed);
    // The snapshot the invoke captured is older than the push.
    resolveGetStatus(status());
    await pending;

    expect(useGlobalFocusShortcutStore.getState()).toMatchObject({
      status: pushed,
      hydrated: true,
    });
    unsubscribe();
  });

  it('keeps a proof push that lands while update is still in flight', async () => {
    // The update round trip includes a disk write in main; a chord pressed in
    // that window pushes `lastTriggeredAt`, which the response snapshot
    // (captured at registration) must not overwrite.
    const bridge = installBridge(status());
    let resolveUpdate: (
      value: GlobalFocusShortcutUpdateResponse,
    ) => void = () => undefined;
    bridge.update = jest.fn(
      () =>
        new Promise<GlobalFocusShortcutUpdateResponse>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const store = useGlobalFocusShortcutStore.getState();
    const unsubscribe = store.subscribeBridge();

    const pending = store.update({ enabled: true });
    const proven = status({
      enabled: true,
      registered: true,
      lastTriggeredAt: '2026-09-10T12:00:00.000Z',
    });
    bridge.emit(proven);
    const registered = status({ enabled: true, registered: true });
    resolveUpdate({ ok: true, status: registered });
    await expect(pending).resolves.toEqual({ ok: true, status: registered });

    expect(useGlobalFocusShortcutStore.getState()).toMatchObject({
      status: proven,
      hydrated: true,
      busy: false,
    });
    unsubscribe();
  });

  it('forwards updates and keeps the returned status on both outcomes', async () => {
    const bridge = installBridge(status());
    const accepted = status({ enabled: true, registered: true });
    jest.mocked(bridge.update).mockResolvedValueOnce({
      ok: true,
      status: accepted,
    });

    const ok = await useGlobalFocusShortcutStore
      .getState()
      .update({ enabled: true });

    expect(bridge.update).toHaveBeenCalledWith({ enabled: true });
    expect(ok).toEqual({ ok: true, status: accepted });
    expect(useGlobalFocusShortcutStore.getState().status).toEqual(accepted);

    jest.mocked(bridge.update).mockResolvedValueOnce({
      ok: false,
      reason: 'in-use',
      accelerator: 'CommandOrControl+Shift+P',
      status: accepted,
    });
    const refused = await useGlobalFocusShortcutStore
      .getState()
      .update({ accelerator: 'CommandOrControl+Shift+P' });

    expect(refused).toMatchObject({ ok: false, reason: 'in-use' });
    // The refused chord never replaces the saved, still-registered one.
    expect(useGlobalFocusShortcutStore.getState().status).toEqual(accepted);
    expect(useGlobalFocusShortcutStore.getState().busy).toBe(false);
  });

  it('returns null from update when there is no bridge', async () => {
    const result = await useGlobalFocusShortcutStore
      .getState()
      .update({ enabled: true });
    expect(result).toBeNull();
  });
});

describe('formatGlobalFocusShortcutForDisplay', () => {
  it('renders the saved chord for the status platform', () => {
    expect(formatGlobalFocusShortcutForDisplay(status())).toBe('⌘⇧O');
    expect(
      formatGlobalFocusShortcutForDisplay(status({ platform: 'win32' })),
    ).toBe('Ctrl Shift O');
  });

  it('falls back to the default chord for the renderer platform before the status has loaded', () => {
    // Same platform oracle the in-app shortcut table uses.
    expect(formatGlobalFocusShortcutForDisplay(null)).toBe(
      formatShortcut('⌘⇧O', 'Ctrl Shift O'),
    );
  });
});
