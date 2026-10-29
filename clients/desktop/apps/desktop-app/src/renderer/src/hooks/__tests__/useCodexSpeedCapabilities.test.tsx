/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CODEX_SPEED_CATALOG_TTL_MS,
  type CodexSpeedRouteFacts,
} from '@canopy/desktop-shared/lib/codex-speed-availability';
import type {
  CodexSpeedApi,
  CodexSpeedCatalog,
  CodexSpeedCatalogModel,
  CodexSpeedReadCapabilitiesOptions,
  CodexSpeedSetActiveRequest,
} from '@canopy/desktop-shared/types/codex-speed-capabilities';
import {
  resetCodexSpeedStoreForTests,
  useCodexSpeedStore,
} from '../../stores/codexSpeedStore';
import {
  useCodexSpeedCapabilities,
  type CodexSpeedCapabilities,
  type UseCodexSpeedCapabilitiesOptions,
} from '../useCodexSpeedCapabilities';

jest.mock('../../lib/renderer-error-logging', () => ({
  reportRendererConsoleError: jest.fn(),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const TTL = CODEX_SPEED_CATALOG_TTL_MS;
const READ_FAILURE = "Couldn't check Codex speed availability. Try again.";
const CONSUMER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

const PRIORITY_ONLY: CodexSpeedCatalogModel = {
  id: 'gpt-5.5',
  model: 'gpt-5.5',
  tiers: ['priority'],
  source: 'serviceTiers',
};

const WITH_ULTRAFAST: CodexSpeedCatalogModel = {
  ...PRIORITY_ONLY,
  tiers: ['priority', 'ultrafast'],
};

const NATIVE_ROUTE: CodexSpeedRouteFacts = {
  modelSelection: 'explicit',
  runtimeModel: 'gpt-5.5',
  modelSource: 'codex-managed',
  harness: 'codex',
  routeProfile: 'codex-native',
};

function catalog(
  overrides: Partial<CodexSpeedCatalog> = {},
): CodexSpeedCatalog {
  return {
    generation: 1,
    status: 'ready',
    fetchedAt: NOW,
    expiresAt: NOW + TTL,
    truncated: false,
    models: [PRIORITY_ONLY],
    denials: [],
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface BridgeStub {
  readCapabilities: jest.Mock<
    Promise<CodexSpeedCatalog>,
    [CodexSpeedReadCapabilitiesOptions?]
  >;
  setActive: jest.Mock<Promise<void>, [CodexSpeedSetActiveRequest]>;
  onChanged: jest.Mock<() => void, [(catalog: CodexSpeedCatalog) => void]>;
  /** Called each time a disposer returned by `onChanged` runs. */
  dispose: jest.Mock<void, []>;
  emit: (next: CodexSpeedCatalog) => void;
  listenerCount: () => number;
}

function installBridge(): BridgeStub {
  const listeners = new Set<(next: CodexSpeedCatalog) => void>();
  const dispose = jest.fn<void, []>();
  const bridge: BridgeStub = {
    readCapabilities: jest.fn<
      Promise<CodexSpeedCatalog>,
      [CodexSpeedReadCapabilitiesOptions?]
    >(() => Promise.resolve(catalog())),
    setActive: jest.fn<Promise<void>, [CodexSpeedSetActiveRequest]>(() =>
      Promise.resolve(),
    ),
    onChanged: jest.fn<() => void, [(next: CodexSpeedCatalog) => void]>(
      (callback) => {
        listeners.add(callback);
        return (): void => {
          listeners.delete(callback);
          dispose();
        };
      },
    ),
    dispose,
    emit: (next): void => {
      listeners.forEach((listener) => listener(next));
    },
    listenerCount: (): number => listeners.size,
  };
  const codexSpeed: CodexSpeedApi = {
    readCapabilities: bridge.readCapabilities,
    setActive: bridge.setActive,
    onChanged: bridge.onChanged,
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { codexSpeed },
  });
  return bridge;
}

interface Probe {
  current: CodexSpeedCapabilities | null;
}

function createProbe(): Probe {
  return { current: null };
}

function Harness({
  probe,
  options,
}: {
  probe: Probe;
  options?: UseCodexSpeedCapabilitiesOptions;
}): null {
  probe.current = useCodexSpeedCapabilities(options);
  return null;
}

function Pair({
  first,
  second,
  showSecond = true,
}: {
  first: Probe;
  second: Probe;
  showSecond?: boolean;
}): JSX.Element {
  return (
    <>
      <Harness probe={first} />
      {showSecond ? <Harness probe={second} /> : null}
    </>
  );
}

let visibility: DocumentVisibilityState = 'visible';
let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function render(element: JSX.Element): Promise<void> {
  await act(async () => {
    root.render(element);
    await flush();
  });
}

async function settle(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await flush();
  });
}

function changeVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

function focusWindow(): void {
  window.dispatchEvent(new Event('focus'));
}

beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: (): DocumentVisibilityState => visibility,
  });
});

beforeEach(() => {
  // Only the clock and timer queues are faked: React's act() needs real
  // microtasks, and a zero timer count proves the renderer never polls.
  jest.useFakeTimers({ now: NOW, doNotFake: ['queueMicrotask', 'nextTick'] });
  resetCodexSpeedStoreForTests();
  visibility = 'visible';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetCodexSpeedStoreForTests();
  Reflect.deleteProperty(window, 'api');
  jest.useRealTimers();
});

describe('useCodexSpeedCapabilities', () => {
  it('activates each mounted surface under its own id and shares one subscription', async () => {
    const bridge = installBridge();
    const first = createProbe();
    const second = createProbe();

    await render(<Pair first={first} second={second} />);

    const requests = bridge.setActive.mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.active)).toBe(true);
    const ids = requests.map((request) => request.consumerId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(CONSUMER_ID_PATTERN);
      expect(id.length).toBeLessThanOrEqual(128);
    }
    expect(bridge.onChanged).toHaveBeenCalledTimes(1);
    // The empty mirror is stale, and both surfaces share one read.
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);
    expect(bridge.readCapabilities.mock.calls[0]?.[0]).toBeUndefined();
    expect(first.current?.status).toBe('ready');
    expect(second.current?.catalog).toBe(first.current?.catalog);
    // Main owns the one expiry timer: the renderer schedules none.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('deactivates an unmounted surface and releases the subscription after the last one', async () => {
    const bridge = installBridge();
    const first = createProbe();
    const second = createProbe();
    await render(<Pair first={first} second={second} />);
    const ids = bridge.setActive.mock.calls.map(
      ([request]) => request.consumerId,
    );

    await render(<Pair first={first} second={second} showSecond={false} />);
    expect(bridge.setActive).toHaveBeenCalledTimes(3);
    const removed = bridge.setActive.mock.calls[2]?.[0];
    expect(removed?.active).toBe(false);
    expect(ids).toContain(removed?.consumerId);
    expect(bridge.dispose).not.toHaveBeenCalled();

    await render(<></>);
    expect(bridge.setActive).toHaveBeenCalledTimes(4);
    const last = bridge.setActive.mock.calls[3]?.[0];
    expect(last?.active).toBe(false);
    expect(last?.consumerId).not.toBe(removed?.consumerId);
    expect(ids).toContain(last?.consumerId);
    expect(bridge.dispose).toHaveBeenCalledTimes(1);
    expect(bridge.listenerCount()).toBe(0);
  });

  it('goes inactive while hidden and returns active with a stale-only read', async () => {
    const bridge = installBridge();
    await render(<Harness probe={createProbe()} />);
    const consumerId = bridge.setActive.mock.calls[0]?.[0].consumerId;
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    await settle(() => changeVisibility('hidden'));
    expect(bridge.setActive).toHaveBeenCalledTimes(2);
    expect(bridge.setActive).toHaveBeenLastCalledWith({
      consumerId,
      active: false,
    });
    // No duplicate call for a state main already has.
    await settle(() => changeVisibility('hidden'));
    expect(bridge.setActive).toHaveBeenCalledTimes(2);

    // Back while the mirror is fresh: active again, no read.
    await settle(() => changeVisibility('visible'));
    expect(bridge.setActive).toHaveBeenCalledTimes(3);
    expect(bridge.setActive).toHaveBeenLastCalledWith({
      consumerId,
      active: true,
    });
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    // Hidden past expiry: returning reads once, without forcing.
    await settle(() => changeVisibility('hidden'));
    jest.setSystemTime(NOW + TTL);
    bridge.readCapabilities.mockResolvedValueOnce(
      catalog({ fetchedAt: NOW + TTL, expiresAt: NOW + 2 * TTL }),
    );
    await settle(() => changeVisibility('visible'));
    expect(bridge.setActive).toHaveBeenCalledTimes(5);
    expect(bridge.setActive).toHaveBeenLastCalledWith({
      consumerId,
      active: true,
    });
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(2);
    expect(bridge.readCapabilities.mock.calls[1]?.[0]).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits for the window to become visible before activating or reading', async () => {
    visibility = 'hidden';
    const bridge = installBridge();
    const surface = createProbe();
    await render(<Harness probe={surface} />);
    expect(bridge.setActive).not.toHaveBeenCalled();
    expect(bridge.readCapabilities).not.toHaveBeenCalled();

    // Pushes still reach the mirror while hidden.
    const pushed = catalog();
    await settle(() => bridge.emit(pushed));
    expect(surface.current?.catalog).toBe(pushed);

    jest.setSystemTime(NOW + TTL);
    await settle(() => changeVisibility('visible'));
    expect(bridge.setActive).toHaveBeenCalledTimes(1);
    expect(bridge.setActive.mock.calls[0]?.[0].active).toBe(true);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);
  });

  it('never reports a surface inactive that was never active', async () => {
    visibility = 'hidden';
    const bridge = installBridge();
    await render(<Harness probe={createProbe()} />);
    await render(<></>);
    expect(bridge.setActive).not.toHaveBeenCalled();
    expect(bridge.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not read on mount when the mirror already holds a fresh catalog', async () => {
    const bridge = installBridge();
    act(() => useCodexSpeedStore.getState().applyCatalog(catalog()));

    await render(<Harness probe={createProbe()} />);

    expect(bridge.setActive).toHaveBeenCalledTimes(1);
    expect(bridge.readCapabilities).not.toHaveBeenCalled();
  });

  it('re-reads on window focus only when the mirror is stale', async () => {
    const bridge = installBridge();
    await render(<Harness probe={createProbe()} />);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    await settle(focusWindow);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    jest.setSystemTime(NOW + TTL);
    await settle(focusWindow);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(2);
    expect(bridge.readCapabilities.mock.calls[1]?.[0]).toBeUndefined();
  });

  it('reads the account proxy list for a proxy route and re-reads it once expired', async () => {
    const bridge = installBridge();
    act(() => useCodexSpeedStore.getState().applyCatalog(catalog()));
    const withList: CodexSpeedCatalog = {
      ...catalog(),
      routes: {
        'account-proxy': {
          revision: 1,
          status: 'ready',
          fetchedAt: NOW,
          expiresAt: NOW + TTL,
          truncated: false,
          models: [],
        },
      },
    };
    bridge.readCapabilities.mockResolvedValue(withList);

    await render(
      <Harness
        probe={createProbe()}
        options={{ routeProfile: 'account-proxy' }}
      />,
    );
    // The runtime catalog is fresh, but the proxy list was never read.
    expect(bridge.readCapabilities.mock.calls).toEqual([
      [{ route: 'account-proxy' }],
    ]);

    await settle(focusWindow);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    jest.setSystemTime(NOW + TTL);
    await settle(focusWindow);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(2);
    expect(bridge.readCapabilities.mock.calls[1]?.[0]).toEqual({
      route: 'account-proxy',
    });
  });

  it('never reads the proxy list for a native route', async () => {
    const bridge = installBridge();
    await render(
      <Harness
        probe={createProbe()}
        options={{ routeProfile: 'codex-native' }}
      />,
    );
    expect(bridge.readCapabilities.mock.calls).toEqual([[undefined]]);
  });

  it('re-reads on a model change only when the mirror is stale', async () => {
    const bridge = installBridge();
    const surface = createProbe();
    await render(<Harness probe={surface} options={{ model: 'gpt-5.5' }} />);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    await render(<Harness probe={surface} options={{ model: 'gpt-5.4' }} />);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    jest.setSystemTime(NOW + TTL);
    // A re-render with the same model is not a change.
    await render(<Harness probe={surface} options={{ model: 'gpt-5.4' }} />);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    await render(<Harness probe={surface} options={{ model: 'gpt-5.5' }} />);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(2);
    expect(bridge.readCapabilities.mock.calls[1]?.[0]).toBeUndefined();
  });

  it('refresh forces a read and reports it while in flight', async () => {
    const bridge = installBridge();
    const surface = createProbe();
    await render(<Harness probe={surface} />);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    const answer = deferred<CodexSpeedCatalog>();
    bridge.readCapabilities.mockReturnValueOnce(answer.promise);
    let refreshing: Promise<void> | undefined;
    await act(async () => {
      refreshing = surface.current?.refresh();
      await flush();
    });
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(2);
    expect(bridge.readCapabilities).toHaveBeenLastCalledWith({ force: true });
    expect(surface.current?.refreshing).toBe(true);

    const refreshed = catalog({ fetchedAt: NOW + 1 });
    await act(async () => {
      answer.resolve(refreshed);
      await refreshing;
      await flush();
    });
    expect(surface.current).toMatchObject({
      catalog: refreshed,
      refreshing: false,
    });
  });

  it('stays idle while disabled and keeps its id when enabled again', async () => {
    const bridge = installBridge();
    const surface = createProbe();
    await render(<Harness probe={surface} options={{ enabled: false }} />);
    await settle(focusWindow);
    await settle(() => changeVisibility('hidden'));
    await settle(() => changeVisibility('visible'));
    expect(bridge.setActive).not.toHaveBeenCalled();
    expect(bridge.readCapabilities).not.toHaveBeenCalled();
    expect(bridge.onChanged).not.toHaveBeenCalled();
    expect(surface.current?.status).toBe('loading');

    await render(<Harness probe={surface} options={{ enabled: true }} />);
    expect(bridge.setActive).toHaveBeenCalledTimes(1);
    const consumerId = bridge.setActive.mock.calls[0]?.[0].consumerId;
    expect(bridge.setActive).toHaveBeenLastCalledWith({
      consumerId,
      active: true,
    });
    expect(bridge.onChanged).toHaveBeenCalledTimes(1);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    await render(<Harness probe={surface} options={{ enabled: false }} />);
    expect(bridge.setActive).toHaveBeenLastCalledWith({
      consumerId,
      active: false,
    });
    expect(bridge.dispose).toHaveBeenCalledTimes(1);

    await render(<Harness probe={surface} options={{ enabled: true }} />);
    expect(bridge.setActive).toHaveBeenLastCalledWith({
      consumerId,
      active: true,
    });
  });

  it('reports loading until the first catalog, then its status and error', async () => {
    const bridge = installBridge();
    const answer = deferred<CodexSpeedCatalog>();
    bridge.readCapabilities.mockReturnValueOnce(answer.promise);
    const surface = createProbe();

    await render(<Harness probe={surface} />);
    expect(surface.current).toMatchObject({
      catalog: null,
      status: 'loading',
      refreshing: true,
      error: null,
      options: null,
    });

    const catalogError = "Couldn't check Codex speed availability. Try again.";
    await settle(() =>
      answer.resolve(
        catalog({ status: 'unknown', models: [], error: catalogError }),
      ),
    );
    expect(surface.current).toMatchObject({
      status: 'unknown',
      refreshing: false,
      error: catalogError,
    });
  });

  it('reports the renderer read error ahead of the catalog error', async () => {
    const bridge = installBridge();
    act(() =>
      useCodexSpeedStore
        .getState()
        .applyCatalog(
          catalog({ expiresAt: null, status: 'unknown', error: 'Catalog' }),
        ),
    );
    bridge.readCapabilities.mockRejectedValueOnce(new Error('ipc down'));
    const surface = createProbe();

    await render(<Harness probe={surface} />);

    expect(surface.current).toMatchObject({
      status: 'unknown',
      refreshing: false,
      error: READ_FAILURE,
    });
  });

  it('derives per-speed availability only from route facts, compared by value', async () => {
    installBridge();
    const surface = createProbe();
    await render(<Harness probe={surface} />);
    expect(surface.current?.options).toBeNull();

    await render(
      <Harness probe={surface} options={{ route: { ...NATIVE_ROUTE } }} />,
    );
    expect(surface.current?.options?.standard).toMatchObject({
      status: 'available',
      reason: 'not-gated',
    });
    expect(surface.current?.options?.fast).toMatchObject({
      status: 'available',
      reason: 'not-gated',
    });
    expect(surface.current?.options?.ultrafast).toMatchObject({
      status: 'unavailable',
      reason: 'not-advertised',
    });
    const derived = surface.current?.options;

    // An equal route passed as a new object keeps the derived options.
    await render(
      <Harness probe={surface} options={{ route: { ...NATIVE_ROUTE } }} />,
    );
    expect(surface.current?.options).toBe(derived);

    await render(
      <Harness
        probe={surface}
        options={{ route: { ...NATIVE_ROUTE, routeProfile: 'ai-credits' } }}
      />,
    );
    expect(surface.current?.options?.ultrafast).toMatchObject({
      status: 'unavailable',
      reason: 'route-not-native',
    });
  });

  it('shows Ultra fast once a same-account push advertises it, changing nothing else', async () => {
    const bridge = installBridge();
    const surface = createProbe();
    await render(
      <Harness
        probe={surface}
        options={{ model: 'gpt-5.5', route: NATIVE_ROUTE }}
      />,
    );
    const before = surface.current;
    expect(before?.options?.ultrafast).toEqual({
      speed: 'ultrafast',
      status: 'unavailable',
      reason: 'not-advertised',
      generation: 1,
    });
    const reads = bridge.readCapabilities.mock.calls.length;
    const activations = bridge.setActive.mock.calls.length;

    const positive = catalog({
      fetchedAt: NOW + 60_000,
      expiresAt: NOW + 60_000 + TTL,
      models: [WITH_ULTRAFAST],
    });
    await settle(() => bridge.emit(positive));

    const after = surface.current;
    expect(after?.catalog).toBe(positive);
    expect(after?.options?.ultrafast).toEqual({
      speed: 'ultrafast',
      status: 'available',
      reason: 'advertised',
      generation: 1,
    });
    expect(after?.options?.standard).toEqual(before?.options?.standard);
    expect(after?.options?.fast).toEqual(before?.options?.fast);
    expect(after).toMatchObject({
      status: 'ready',
      refreshing: false,
      error: null,
    });
    expect(after?.refresh).toBe(before?.refresh);
    // A capability change only updates availability: the hook offers no
    // selection to change and does not call main.
    expect(Object.keys(after ?? {}).sort()).toEqual([
      'catalog',
      'error',
      'options',
      'refresh',
      'refreshing',
      'status',
    ]);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(reads);
    expect(bridge.setActive).toHaveBeenCalledTimes(activations);
  });

  it('ignores a push from an older account generation after a newer one', async () => {
    const bridge = installBridge();
    const surface = createProbe();
    await render(<Harness probe={surface} options={{ route: NATIVE_ROUTE }} />);

    const nextAccount = catalog({
      generation: 2,
      fetchedAt: NOW + 1_000,
      expiresAt: NOW + 1_000 + TTL,
      models: [WITH_ULTRAFAST],
    });
    await settle(() => bridge.emit(nextAccount));
    expect(surface.current?.options?.ultrafast).toMatchObject({
      status: 'available',
      generation: 2,
    });

    await settle(() =>
      bridge.emit(
        catalog({
          generation: 1,
          fetchedAt: NOW + 2_000,
          models: [PRIORITY_ONLY],
        }),
      ),
    );
    expect(surface.current?.catalog).toBe(nextAccount);
    expect(surface.current?.options?.ultrafast).toMatchObject({
      status: 'available',
      generation: 2,
    });
  });

  it('renders without the preload bridge', async () => {
    const surface = createProbe();
    await render(<Harness probe={surface} options={{ route: NATIVE_ROUTE }} />);
    expect(surface.current).toMatchObject({
      catalog: null,
      status: 'loading',
      refreshing: false,
      error: null,
    });
    expect(surface.current?.options?.ultrafast).toMatchObject({
      status: 'unknown',
      reason: 'catalog-unknown',
    });
    await act(async () => {
      await surface.current?.refresh();
    });
    expect(surface.current?.status).toBe('loading');
  });
});
