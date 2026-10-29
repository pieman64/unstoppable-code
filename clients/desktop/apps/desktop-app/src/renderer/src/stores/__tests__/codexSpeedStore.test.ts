const mockReportRendererConsoleError = jest.fn<
  void,
  [string, Record<string, unknown>?]
>();

jest.mock('../../lib/renderer-error-logging', () => ({
  reportRendererConsoleError: mockReportRendererConsoleError,
}));

import { CODEX_SPEED_CATALOG_TTL_MS } from '@canopy/desktop-shared/lib/codex-speed-availability';
import type {
  CodexSpeedApi,
  CodexSpeedCatalog,
  CodexSpeedCatalogModel,
  CodexSpeedReadCapabilitiesOptions,
  CodexSpeedSetActiveRequest,
} from '@canopy/desktop-shared/types/codex-speed-capabilities';
import {
  isCodexSpeedCatalogStale,
  resetCodexSpeedStoreForTests,
  retainCodexSpeedSubscription,
  useCodexSpeedStore,
  type CodexSpeedStoreState,
} from '../codexSpeedStore';

const READ_FAILURE = "Couldn't check Codex speed availability. Try again.";
const FETCHED_AT = Date.parse('2026-09-30T12:00:00.000Z');

const PRIORITY_ONLY: CodexSpeedCatalogModel = {
  id: 'gpt-5.5',
  model: 'gpt-5.5',
  tiers: ['priority'],
  source: 'serviceTiers',
};

function catalog(
  overrides: Partial<CodexSpeedCatalog> = {},
): CodexSpeedCatalog {
  return {
    generation: 1,
    status: 'ready',
    fetchedAt: FETCHED_AT,
    expiresAt: FETCHED_AT + CODEX_SPEED_CATALOG_TTL_MS,
    truncated: false,
    models: [PRIORITY_ONLY],
    denials: [],
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
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

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
  });
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
  setWindow({ api: { codexSpeed } });
  return bridge;
}

function state(): CodexSpeedStoreState {
  return useCodexSpeedStore.getState();
}

function apply(next: CodexSpeedCatalog): void {
  state().applyCatalog(next);
}

beforeEach(() => {
  resetCodexSpeedStoreForTests();
  mockReportRendererConsoleError.mockClear();
});

afterEach(() => {
  resetCodexSpeedStoreForTests();
  setWindow(undefined);
});

describe('isCodexSpeedCatalogStale', () => {
  const now = FETCHED_AT + 1_000;

  it('treats a missing catalog as stale', () => {
    expect(isCodexSpeedCatalogStale(null, now)).toBe(true);
  });

  it('treats a catalog without an expiry as stale', () => {
    expect(isCodexSpeedCatalogStale(catalog({ expiresAt: null }), now)).toBe(
      true,
    );
  });

  it('treats a catalog at or past its expiry as stale', () => {
    expect(isCodexSpeedCatalogStale(catalog({ expiresAt: now }), now)).toBe(
      true,
    );
    expect(isCodexSpeedCatalogStale(catalog({ expiresAt: now - 1 }), now)).toBe(
      true,
    );
  });

  it('treats a catalog before its expiry as fresh', () => {
    expect(isCodexSpeedCatalogStale(catalog({ expiresAt: now + 1 }), now)).toBe(
      false,
    );
  });

  it('treats a missing or expired route list as stale for that route only', () => {
    const fresh = catalog({ expiresAt: now + 1 });
    expect(isCodexSpeedCatalogStale(fresh, now, 'account-proxy')).toBe(true);
    const proxyList = {
      revision: 1,
      status: 'ready' as const,
      fetchedAt: FETCHED_AT,
      truncated: false,
      models: [PRIORITY_ONLY],
    };
    expect(
      isCodexSpeedCatalogStale(
        {
          ...fresh,
          routes: { 'account-proxy': { ...proxyList, expiresAt: now } },
        },
        now,
        'account-proxy',
      ),
    ).toBe(true);
    const withList = {
      ...fresh,
      routes: { 'account-proxy': { ...proxyList, expiresAt: now + 1 } },
    };
    expect(isCodexSpeedCatalogStale(withList, now, 'account-proxy')).toBe(
      false,
    );
    expect(isCodexSpeedCatalogStale(withList, now)).toBe(false);
  });
});

describe('useCodexSpeedStore.applyCatalog', () => {
  it('starts empty and adopts the first catalog', () => {
    expect(state()).toMatchObject({
      catalog: null,
      pendingReads: 0,
      error: null,
    });
    const first = catalog();
    apply(first);
    expect(state().catalog).toBe(first);
  });

  it('ignores a catalog from an older account generation', () => {
    const newer = catalog({ generation: 2 });
    apply(newer);
    apply(catalog({ generation: 1, fetchedAt: FETCHED_AT + 60_000 }));
    expect(state().catalog).toBe(newer);
  });

  it('ignores an older fetch from the same generation', () => {
    const newer = catalog({ fetchedAt: FETCHED_AT + 60_000 });
    apply(newer);
    apply(catalog({ fetchedAt: FETCHED_AT }));
    expect(state().catalog).toBe(newer);
  });

  it('accepts an equally ordered catalog, such as a denial in the same fetch', () => {
    apply(catalog());
    const denied = catalog({
      denials: [{ model: 'gpt-5.5', expiresAt: FETCHED_AT + 60_000 }],
    });
    apply(denied);
    expect(state().catalog).toBe(denied);
  });

  it('adopts a cleared account proxy list from a failed revalidation', () => {
    const offered = catalog({
      routes: {
        'account-proxy': {
          revision: 2,
          status: 'ready',
          fetchedAt: FETCHED_AT,
          expiresAt: FETCHED_AT + CODEX_SPEED_CATALOG_TTL_MS,
          truncated: false,
          models: [PRIORITY_ONLY],
        },
      },
    });
    apply(offered);
    const cleared = catalog({
      routes: {
        'account-proxy': {
          revision: 3,
          status: 'unknown',
          fetchedAt: null,
          expiresAt: FETCHED_AT + CODEX_SPEED_CATALOG_TTL_MS + 10_000,
          truncated: false,
          models: [],
          error: "Couldn't check Ultra fast on the account proxy. Try again.",
        },
      },
    });
    apply(cleared);
    expect(state().catalog).toBe(cleared);
    // An earlier snapshot that arrives late never replaces it.
    apply(offered);
    expect(state().catalog).toBe(cleared);
  });

  it('adopts a newer generation even before it has been fetched', () => {
    apply(catalog({ fetchedAt: FETCHED_AT + 60_000 }));
    const accountReset = catalog({
      generation: 2,
      status: 'unknown',
      fetchedAt: null,
      expiresAt: null,
      models: [],
    });
    apply(accountReset);
    expect(state().catalog).toBe(accountReset);
  });

  it('ignores a payload that is not a catalog', () => {
    const current = catalog();
    apply(current);
    // An IPC payload that does not match the DTO: a newer generation that
    // lacks its model list must not replace the mirror.
    const malformed = catalog({ generation: 9 });
    Reflect.deleteProperty(malformed, 'models');
    apply(malformed);
    expect(state().catalog).toBe(current);
  });

  it('clears a renderer read error when it adopts a catalog', async () => {
    const bridge = installBridge();
    bridge.readCapabilities.mockRejectedValueOnce(new Error('ipc down'));
    await state().read();
    expect(state().error).toBe(READ_FAILURE);

    apply(catalog());
    expect(state().error).toBeNull();
  });
});

describe('useCodexSpeedStore.read', () => {
  it('adopts the answer and counts the read while it is in flight', async () => {
    const bridge = installBridge();
    const answer = deferred<CodexSpeedCatalog>();
    bridge.readCapabilities.mockReturnValueOnce(answer.promise);

    const reading = state().read();
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);
    expect(bridge.readCapabilities.mock.calls[0]?.[0]).toBeUndefined();
    expect(state().pendingReads).toBe(1);

    const next = catalog();
    answer.resolve(next);
    await reading;
    expect(state()).toMatchObject({
      catalog: next,
      pendingReads: 0,
      error: null,
    });
  });

  it('shares one in-flight read between concurrent reads', async () => {
    const bridge = installBridge();
    const answer = deferred<CodexSpeedCatalog>();
    bridge.readCapabilities.mockReturnValueOnce(answer.promise);

    const first = state().read();
    const second = state().read();
    expect(second).toBe(first);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);
    expect(state().pendingReads).toBe(1);

    answer.resolve(catalog());
    await Promise.all([first, second]);
    expect(state().pendingReads).toBe(0);

    // Once it settles, the next read asks main again.
    await state().read();
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(2);
  });

  it('starts a forced read while a normal read is in flight', async () => {
    const bridge = installBridge();
    const normal = deferred<CodexSpeedCatalog>();
    const forced = deferred<CodexSpeedCatalog>();
    bridge.readCapabilities
      .mockReturnValueOnce(normal.promise)
      .mockReturnValueOnce(forced.promise);

    const reading = state().read();
    const refreshing = state().read({ force: true });
    expect(refreshing).not.toBe(reading);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(2);
    expect(bridge.readCapabilities).toHaveBeenLastCalledWith({ force: true });
    expect(state().pendingReads).toBe(2);

    normal.resolve(catalog());
    await reading;
    expect(state().pendingReads).toBe(1);
    forced.resolve(catalog({ fetchedAt: FETCHED_AT + 1 }));
    await refreshing;
    expect(state().pendingReads).toBe(0);
  });

  it('lets a normal read join an in-flight forced read', async () => {
    const bridge = installBridge();
    const forced = deferred<CodexSpeedCatalog>();
    bridge.readCapabilities.mockReturnValueOnce(forced.promise);

    const refreshing = state().read({ force: true });
    const reading = state().read();
    expect(reading).toBe(refreshing);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    forced.resolve(catalog());
    await reading;
    expect(state().pendingReads).toBe(0);
  });

  it('includes the route list in every read once a surface asks for it', async () => {
    const bridge = installBridge();
    const plain = deferred<CodexSpeedCatalog>();
    bridge.readCapabilities
      .mockReturnValueOnce(plain.promise)
      .mockResolvedValue(catalog());

    const reading = state().read();
    // A read started without the route list cannot answer one that needs it.
    const routed = state().read({ route: 'account-proxy' });
    expect(routed).not.toBe(reading);
    expect(bridge.readCapabilities.mock.calls).toEqual([
      [undefined],
      [{ route: 'account-proxy' }],
    ]);
    plain.resolve(catalog());
    await Promise.all([reading, routed]);

    await state().read();
    await state().read({ force: true });
    expect(bridge.readCapabilities.mock.calls.slice(2)).toEqual([
      [{ route: 'account-proxy' }],
      [{ force: true, route: 'account-proxy' }],
    ]);
  });

  it('shares one in-flight forced read between concurrent refreshes', async () => {
    const bridge = installBridge();
    const forced = deferred<CodexSpeedCatalog>();
    bridge.readCapabilities.mockReturnValueOnce(forced.promise);

    const first = state().read({ force: true });
    const second = state().read({ force: true });
    expect(second).toBe(first);
    expect(bridge.readCapabilities).toHaveBeenCalledTimes(1);

    forced.resolve(catalog());
    await first;
    expect(state().pendingReads).toBe(0);
  });

  it('never regresses to an older answer that arrives late', async () => {
    const bridge = installBridge();
    const older = deferred<CodexSpeedCatalog>();
    const newer = deferred<CodexSpeedCatalog>();
    bridge.readCapabilities
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const reading = state().read();
    const refreshing = state().read({ force: true });
    const fresh = catalog({ generation: 2, fetchedAt: FETCHED_AT + 1_000 });
    newer.resolve(fresh);
    await refreshing;
    older.resolve(catalog({ generation: 1, fetchedAt: FETCHED_AT }));
    await reading;

    expect(state().catalog).toBe(fresh);
  });

  it('keeps the catalog and records a sanitized error when the bridge rejects', async () => {
    const bridge = installBridge();
    const current = catalog();
    apply(current);
    const failure = new Error('ipc failed reading /Users/someone/.codex');
    bridge.readCapabilities.mockRejectedValueOnce(failure);

    await expect(state().read()).resolves.toBeUndefined();

    expect(state()).toMatchObject({
      catalog: current,
      pendingReads: 0,
      error: READ_FAILURE,
    });
    expect(mockReportRendererConsoleError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: failure }),
    );
  });

  it('records an error when the bridge answers with something other than a catalog', async () => {
    const bridge = installBridge();
    // For example an older preload answering with a different shape.
    const malformed = catalog();
    Reflect.deleteProperty(malformed, 'models');
    bridge.readCapabilities.mockResolvedValueOnce(malformed);

    await state().read();

    expect(state()).toMatchObject({
      catalog: null,
      pendingReads: 0,
      error: READ_FAILURE,
    });
  });

  it('clears the error once a later read succeeds', async () => {
    const bridge = installBridge();
    bridge.readCapabilities.mockRejectedValueOnce(new Error('ipc down'));
    await state().read();
    expect(state().error).toBe(READ_FAILURE);

    const next = catalog();
    bridge.readCapabilities.mockResolvedValueOnce(next);
    await state().read();
    expect(state()).toMatchObject({ catalog: next, error: null });
  });

  it('clears the error after a successful read even when the mirror is already newer', async () => {
    const bridge = installBridge();
    const normal = deferred<CodexSpeedCatalog>();
    const forced = deferred<CodexSpeedCatalog>();
    bridge.readCapabilities
      .mockReturnValueOnce(normal.promise)
      .mockReturnValueOnce(forced.promise);

    const reading = state().read();
    const refreshing = state().read({ force: true });
    const pushed = catalog({ fetchedAt: FETCHED_AT + 60_000 });
    apply(pushed);
    forced.reject(new Error('ipc down'));
    await refreshing;
    expect(state().error).toBe(READ_FAILURE);

    normal.resolve(catalog({ fetchedAt: FETCHED_AT }));
    await reading;
    expect(state()).toMatchObject({ catalog: pushed, error: null });
  });

  it('does nothing without the preload bridge', async () => {
    setWindow(undefined);
    await expect(state().read()).resolves.toBeUndefined();
    await expect(state().read({ force: true })).resolves.toBeUndefined();
    expect(state()).toMatchObject({
      catalog: null,
      pendingReads: 0,
      error: null,
    });

    setWindow({ api: {} });
    await state().read();
    expect(state()).toMatchObject({
      catalog: null,
      pendingReads: 0,
      error: null,
    });
  });
});

describe('useCodexSpeedStore.setConsumerActive', () => {
  it('forwards the consumer state to main', async () => {
    const bridge = installBridge();
    await state().setConsumerActive('codex-speed-a', true);
    await state().setConsumerActive('codex-speed-a', false);
    expect(bridge.setActive.mock.calls).toEqual([
      [{ consumerId: 'codex-speed-a', active: true }],
      [{ consumerId: 'codex-speed-a', active: false }],
    ]);
  });

  it('swallows and reports a failed update', async () => {
    const bridge = installBridge();
    bridge.setActive.mockRejectedValueOnce(new Error('ipc down'));

    await expect(
      state().setConsumerActive('codex-speed-a', true),
    ).resolves.toBeUndefined();

    expect(mockReportRendererConsoleError).toHaveBeenCalledTimes(1);
    expect(state().error).toBeNull();
  });

  it('does nothing without the preload bridge', async () => {
    setWindow(undefined);
    await expect(
      state().setConsumerActive('codex-speed-a', true),
    ).resolves.toBeUndefined();
  });
});

describe('retainCodexSpeedSubscription', () => {
  it('shares one bridge subscription and disposes it after the last release', () => {
    const bridge = installBridge();
    const releaseFirst = retainCodexSpeedSubscription();
    const releaseSecond = retainCodexSpeedSubscription();
    expect(bridge.onChanged).toHaveBeenCalledTimes(1);

    releaseFirst();
    // Releasing twice is a no-op; it must not release the other holder.
    releaseFirst();
    expect(bridge.dispose).not.toHaveBeenCalled();
    expect(bridge.listenerCount()).toBe(1);

    releaseSecond();
    expect(bridge.dispose).toHaveBeenCalledTimes(1);
    expect(bridge.listenerCount()).toBe(0);

    releaseSecond();
    expect(bridge.dispose).toHaveBeenCalledTimes(1);
  });

  it('subscribes again after the last release', () => {
    const bridge = installBridge();
    retainCodexSpeedSubscription()();
    const release = retainCodexSpeedSubscription();
    expect(bridge.onChanged).toHaveBeenCalledTimes(2);
    expect(bridge.listenerCount()).toBe(1);
    release();
    expect(bridge.listenerCount()).toBe(0);
  });

  it('applies pushes in catalog order', () => {
    const bridge = installBridge();
    const release = retainCodexSpeedSubscription();

    const first = catalog();
    bridge.emit(first);
    expect(state().catalog).toBe(first);

    const accountReset = catalog({
      generation: 2,
      status: 'unknown',
      fetchedAt: null,
      expiresAt: null,
      models: [],
    });
    bridge.emit(accountReset);
    expect(state().catalog).toBe(accountReset);

    // A late push from the previous account generation is ignored.
    bridge.emit(catalog({ generation: 1, fetchedAt: FETCHED_AT + 60_000 }));
    expect(state().catalog).toBe(accountReset);

    release();
  });

  it('keeps a push that lands while a read is in flight over the older answer', async () => {
    const bridge = installBridge();
    const release = retainCodexSpeedSubscription();
    const answer = deferred<CodexSpeedCatalog>();
    bridge.readCapabilities.mockReturnValueOnce(answer.promise);

    const reading = state().read();
    const pushed = catalog({ fetchedAt: FETCHED_AT + 60_000 });
    bridge.emit(pushed);
    answer.resolve(catalog({ fetchedAt: FETCHED_AT }));
    await reading;

    expect(state().catalog).toBe(pushed);
    release();
  });

  it('does nothing without the preload bridge', () => {
    setWindow(undefined);
    const release = retainCodexSpeedSubscription();
    expect(() => release()).not.toThrow();
  });
});
