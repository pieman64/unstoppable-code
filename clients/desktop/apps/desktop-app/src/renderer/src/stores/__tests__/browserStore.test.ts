import type {
  BrowserDownloadTransfer,
  BrowserListTransfersRequest,
  BrowserListTransfersResult,
  BrowserSessionSnapshot,
  BrowserSetActiveRequest,
  BrowserTransferCommand,
  BrowserTransferCommandResult,
  PersistedWorktreeBrowserStateFile,
} from '@canopy/desktop-shared/types';
import {
  ensureBrowserWorktreeHydrated,
  pendingBrowserNavigationUrl,
  selectActiveTransferCount,
  selectUnreadConsoleErrorCount,
  selectUnreadDiagnosticCount,
  selectUnreadFailedRequestCount,
  setBrowserHydrationRecoveryHandler,
  useBrowserStore,
} from '../browserStore';

interface MockBrowserApi {
  loadWorktreeState: jest.Mock;
  saveWorktreeState: jest.Mock;
  create: jest.Mock;
  navigate: jest.Mock;
  destroy: jest.Mock;
  disposeLiveView: jest.Mock;
  setActive: jest.Mock<Promise<void>, [BrowserSetActiveRequest]>;
  setBounds: jest.Mock;
  setVisible: jest.Mock;
}

let browserApi: MockBrowserApi;

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const BROWSER_ID = 'browser-abc';
const OTHER_BROWSER_ID = 'browser-def';

function liveSnapshot(
  overrides: Partial<BrowserSessionSnapshot> = {},
): BrowserSessionSnapshot {
  return {
    id: BROWSER_ID,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    createdAt: 1,
    updatedAt: 2,
    url: 'http://localhost:3000/',
    title: 'Local App',
    status: 'ready',
    canGoBack: true,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
    ...overrides,
  };
}

function persistedState(
  overrides: Partial<PersistedWorktreeBrowserStateFile> = {},
): PersistedWorktreeBrowserStateFile {
  return {
    version: 1,
    browserOrder: [BROWSER_ID],
    activeBrowserId: BROWSER_ID,
    browsers: [liveSnapshot()],
    ...overrides,
  };
}

beforeEach(() => {
  browserApi = {
    loadWorktreeState: jest.fn(),
    saveWorktreeState: jest.fn().mockResolvedValue(undefined),
    create: jest.fn(),
    navigate: jest.fn(),
    destroy: jest.fn().mockResolvedValue(undefined),
    disposeLiveView: jest.fn().mockResolvedValue(undefined),
    setActive: jest
      .fn<Promise<void>, [BrowserSetActiveRequest]>()
      .mockResolvedValue(undefined),
    setBounds: jest.fn().mockResolvedValue(undefined),
    setVisible: jest.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { browser: browserApi } },
  });
  setBrowserHydrationRecoveryHandler(null);
  useBrowserStore.setState({
    worktrees: {},
    consoleEntries: {},
    networkEntries: {},
    recordings: {},
    screenshots: {},
    inspectorOpen: {},
    inspectorTab: {},
    diagnosticsSeenAt: {},
    openingBrowserIds: {},
  });
});

/** A promise whose resolution the test controls. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Seeds one hydrated session (live or inert) for exact-ID store tests. */
function seedLive(snapshot: BrowserSessionSnapshot, live: boolean): void {
  useBrowserStore.setState({
    worktrees: {
      [KEY]: {
        browserOrder: [snapshot.id],
        activeBrowserId: snapshot.id,
        browsers: { [snapshot.id]: snapshot },
        live: new Set(live ? [snapshot.id] : []),
        hydrated: true,
      },
    },
  });
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('browserStore hydration', () => {
  it('hydrates the flat order + explicit active id as inert entries', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });

    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket).toBeDefined();
    expect(bucket.hydrated).toBe(true);
    expect(bucket.browserOrder).toEqual([BROWSER_ID]);
    expect(bucket.activeBrowserId).toBe(BROWSER_ID);

    const snapshot = bucket.browsers[BROWSER_ID];
    // Restored inert: status reset to idle, not loading, no live view.
    expect(snapshot.status).toBe('idle');
    expect(snapshot.loading).toBe(false);
    // The persisted URL is preserved so the pane can re-navigate on mount.
    expect(snapshot.url).toBe('http://localhost:3000/');
    expect(bucket.live.has(BROWSER_ID)).toBe(false);
    // Hydration copies state only — no live views are created.
    expect(browserApi.create).not.toHaveBeenCalled();
  });

  it('forgets a worktree so its next hydration reads persisted state again', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    useBrowserStore.getState().forgetWorktree(PROJECT_ID, WORKTREE_ID);
    expect(useBrowserStore.getState().worktrees[KEY]).toBeUndefined();

    // Main replaced the persisted state while the worktree was unmounted.
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'missing',
      state: null,
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    expect(useBrowserStore.getState().worktrees[KEY].browserOrder).toEqual([]);
  });

  it('treats an empty persisted state as a fresh hydrated bucket', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'missing',
      state: null,
    });

    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.hydrated).toBe(true);
    expect(bucket.browserOrder).toEqual([]);
    expect(bucket.activeBrowserId).toBeNull();
  });

  it('records a hydration error without rewriting persisted state', async () => {
    browserApi.loadWorktreeState.mockRejectedValue(
      new Error('corrupt browser-state.json'),
    );

    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.hydrated).toBe(false);
    expect(bucket.hydrationError).toBe('corrupt browser-state.json');
    expect(browserApi.saveWorktreeState).not.toHaveBeenCalled();
  });

  it('hydrates fallback defaults while retaining the diagnostic', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'fallback',
      state: {
        version: 1,
        browserOrder: [],
        activeBrowserId: null,
        browsers: [],
      },
      error: 'Browser state contains invalid JSON.',
    });

    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.hydrated).toBe(true);
    expect(bucket.browserOrder).toEqual([]);
    expect(bucket.hydrationError).toBe('Browser state contains invalid JSON.');
    expect(browserApi.saveWorktreeState).not.toHaveBeenCalled();
  });

  it('retryHydration clears the error only after success and resumes recovery', async () => {
    browserApi.loadWorktreeState.mockRejectedValueOnce(new Error('corrupt'));
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    expect(
      useBrowserStore.getState().worktrees[KEY].hydrationError,
    ).toBeDefined();

    // Failed retry keeps the error state.
    browserApi.loadWorktreeState.mockRejectedValueOnce(new Error('still bad'));
    await useBrowserStore.getState().retryHydration(PROJECT_ID, WORKTREE_ID);
    expect(useBrowserStore.getState().worktrees[KEY].hydrated).toBe(false);
    expect(useBrowserStore.getState().worktrees[KEY].hydrationError).toBe(
      'still bad',
    );

    // Successful retry hydrates, clears the error, and completes pending
    // migration recovery through the installed handler.
    const recoveryHandler = jest.fn().mockResolvedValue(undefined);
    setBrowserHydrationRecoveryHandler(recoveryHandler);
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    await useBrowserStore.getState().retryHydration(PROJECT_ID, WORKTREE_ID);

    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.hydrated).toBe(true);
    expect(bucket.hydrationError).toBeUndefined();
    expect(recoveryHandler).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
  });

  it('keeps sessions created before hydration finished', async () => {
    let resolveLoad:
      | ((value: {
          status: 'loaded';
          state: PersistedWorktreeBrowserStateFile;
        }) => void)
      | undefined;
    browserApi.loadWorktreeState.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    browserApi.create.mockResolvedValue(
      liveSnapshot({ id: OTHER_BROWSER_ID, url: 'http://localhost:3001/' }),
    );

    const hydratePromise = ensureBrowserWorktreeHydrated(
      PROJECT_ID,
      WORKTREE_ID,
    );
    const created = await useBrowserStore
      .getState()
      .createBrowser(PROJECT_ID, WORKTREE_ID, {
        url: 'http://localhost:3001/',
      });
    resolveLoad?.({ status: 'loaded', state: persistedState() });
    await hydratePromise;

    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.hydrated).toBe(true);
    expect(bucket.browserOrder).toEqual([BROWSER_ID, created.id]);
    expect(bucket.browsers[created.id]).toMatchObject({
      id: OTHER_BROWSER_ID,
      url: 'http://localhost:3001/',
    });
  });
});

describe('browserStore session lifecycle', () => {
  it('createBrowser mirrors the session only after backend success', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'missing',
      state: null,
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    browserApi.create.mockRejectedValueOnce(new Error('boom'));

    await expect(
      useBrowserStore.getState().createBrowser(PROJECT_ID, WORKTREE_ID),
    ).rejects.toThrow('boom');
    expect(useBrowserStore.getState().worktrees[KEY].browserOrder).toEqual([]);

    browserApi.create.mockResolvedValue(liveSnapshot({ id: BROWSER_ID }));
    const created = await useBrowserStore
      .getState()
      .createBrowser(PROJECT_ID, WORKTREE_ID);
    expect(created.id).toBe(BROWSER_ID);
    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.browserOrder).toEqual([BROWSER_ID]);
    expect(bucket.live.has(BROWSER_ID)).toBe(true);
  });

  it('createBrowser never duplicates order entries', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    // Backend echoes the SAME id (e.g. rebinding a persisted session).
    browserApi.create.mockResolvedValue(liveSnapshot({ id: BROWSER_ID }));

    await useBrowserStore.getState().createBrowser(PROJECT_ID, WORKTREE_ID);

    expect(useBrowserStore.getState().worktrees[KEY].browserOrder).toEqual([
      BROWSER_ID,
    ]);
  });

  it('destroyBrowser is exact-ID and cleans only that session state', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState({
        browserOrder: [BROWSER_ID, OTHER_BROWSER_ID],
        browsers: [liveSnapshot(), liveSnapshot({ id: OTHER_BROWSER_ID })],
      }),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    useBrowserStore.getState().appendConsoleEntry(BROWSER_ID, {
      id: 'c1',
      browserId: BROWSER_ID,
      timestamp: 10,
      level: 'error',
      text: 'boom',
    });
    useBrowserStore.getState().appendConsoleEntry(OTHER_BROWSER_ID, {
      id: 'c2',
      browserId: OTHER_BROWSER_ID,
      timestamp: 11,
      level: 'error',
      text: 'other',
    });

    await useBrowserStore
      .getState()
      .destroyBrowser(PROJECT_ID, WORKTREE_ID, BROWSER_ID);

    // Presentation hidden first, then permanent destruction.
    expect(browserApi.setVisible).toHaveBeenCalledWith({
      browserId: BROWSER_ID,
      visible: false,
    });
    expect(browserApi.destroy).toHaveBeenCalledWith({ browserId: BROWSER_ID });

    const state = useBrowserStore.getState();
    expect(state.worktrees[KEY].browserOrder).toEqual([OTHER_BROWSER_ID]);
    expect(state.worktrees[KEY].browsers[BROWSER_ID]).toBeUndefined();
    expect(state.consoleEntries[BROWSER_ID]).toBeUndefined();
    // The other session's keyed UI state is untouched.
    expect(state.worktrees[KEY].browsers[OTHER_BROWSER_ID]).toBeDefined();
    expect(state.consoleEntries[OTHER_BROWSER_ID]).toHaveLength(1);
  });

  it('keeps a browser retryable when backend destruction fails', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    browserApi.destroy.mockRejectedValue(new Error('not found'));

    await expect(
      useBrowserStore
        .getState()
        .destroyBrowser(PROJECT_ID, WORKTREE_ID, BROWSER_ID),
    ).rejects.toThrow('not found');

    expect(
      useBrowserStore.getState().worktrees[KEY].browsers[BROWSER_ID],
    ).toBeDefined();
  });

  it('destroying the active browser selects the next ordered survivor', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState({
        browserOrder: [BROWSER_ID, OTHER_BROWSER_ID],
        browsers: [
          liveSnapshot(),
          liveSnapshot({ id: OTHER_BROWSER_ID, createdAt: 3, updatedAt: 4 }),
        ],
      }),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    expect(useBrowserStore.getState().worktrees[KEY].activeBrowserId).toBe(
      BROWSER_ID,
    );

    await useBrowserStore
      .getState()
      .destroyBrowser(PROJECT_ID, WORKTREE_ID, BROWSER_ID);

    expect(useBrowserStore.getState().worktrees[KEY].activeBrowserId).toBe(
      OTHER_BROWSER_ID,
    );
  });
});

describe('browserStore explicit activation', () => {
  it('sets the active browser through BrowserApi.setActive', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState({ activeBrowserId: null }),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    await useBrowserStore
      .getState()
      .setActiveBrowser(PROJECT_ID, WORKTREE_ID, BROWSER_ID);

    expect(useBrowserStore.getState().worktrees[KEY].activeBrowserId).toBe(
      BROWSER_ID,
    );
    expect(browserApi.setActive).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      browserId: BROWSER_ID,
    });
  });

  it('serializes rapid active-browser changes so the backend settles on the latest tab', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState({
        activeBrowserId: null,
        browserOrder: [BROWSER_ID, OTHER_BROWSER_ID],
        browsers: [
          liveSnapshot(),
          liveSnapshot({ id: OTHER_BROWSER_ID, createdAt: 3, updatedAt: 4 }),
        ],
      }),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    let resolveFirst: (() => void) | undefined;
    browserApi.setActive
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const first = useBrowserStore
      .getState()
      .setActiveBrowser(PROJECT_ID, WORKTREE_ID, BROWSER_ID);
    const second = useBrowserStore
      .getState()
      .setActiveBrowser(PROJECT_ID, WORKTREE_ID, OTHER_BROWSER_ID);
    await Promise.resolve();

    // The renderer is optimistic, but only one persistence request may be in
    // flight. Otherwise a slower first request can overwrite the later tab.
    expect(useBrowserStore.getState().worktrees[KEY].activeBrowserId).toBe(
      OTHER_BROWSER_ID,
    );
    expect(browserApi.setActive).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await first;
    await second;

    expect(
      browserApi.setActive.mock.calls.map(([request]) => request.browserId),
    ).toEqual([BROWSER_ID, OTHER_BROWSER_ID]);
    expect(useBrowserStore.getState().worktrees[KEY].activeBrowserId).toBe(
      OTHER_BROWSER_ID,
    );
  });

  it('deduplicates repeated successful selections', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState({ activeBrowserId: null }),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    await useBrowserStore
      .getState()
      .setActiveBrowser(PROJECT_ID, WORKTREE_ID, BROWSER_ID);
    await useBrowserStore
      .getState()
      .setActiveBrowser(PROJECT_ID, WORKTREE_ID, BROWSER_ID);

    expect(browserApi.setActive).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed setActive call on the next focus event', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState({ activeBrowserId: null }),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    browserApi.setActive.mockRejectedValueOnce(new Error('ipc down'));

    await useBrowserStore
      .getState()
      .setActiveBrowser(PROJECT_ID, WORKTREE_ID, BROWSER_ID);
    expect(
      useBrowserStore.getState().worktrees[KEY].activeBrowserId,
    ).toBeNull();
    // Failed call does not claim durable success → next focus retries.
    await useBrowserStore
      .getState()
      .setActiveBrowser(PROJECT_ID, WORKTREE_ID, BROWSER_ID);

    expect(browserApi.setActive).toHaveBeenCalledTimes(2);
    expect(useBrowserStore.getState().worktrees[KEY].activeBrowserId).toBe(
      BROWSER_ID,
    );
  });

  it('ignores selections of unknown browser ids', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    browserApi.setActive.mockClear();

    await useBrowserStore
      .getState()
      .setActiveBrowser(PROJECT_ID, WORKTREE_ID, 'browser-unknown');

    expect(useBrowserStore.getState().worktrees[KEY].activeBrowserId).toBe(
      BROWSER_ID,
    );
    expect(browserApi.setActive).not.toHaveBeenCalled();
  });
});

describe('browserStore live views', () => {
  it('recreates a live view lazily via browser.create reusing the persisted id', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    browserApi.create.mockResolvedValue(liveSnapshot({ status: 'ready' }));

    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    await useBrowserStore
      .getState()
      .ensureLiveView(PROJECT_ID, WORKTREE_ID, BROWSER_ID);

    expect(browserApi.create).toHaveBeenCalledTimes(1);
    expect(browserApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        browserId: BROWSER_ID,
        url: 'http://localhost:3000/',
      }),
    );

    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.live.has(BROWSER_ID)).toBe(true);
    expect(bucket.browsers[BROWSER_ID].status).toBe('ready');
  });

  it('is exact-ID: an unknown id never creates a view', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    await useBrowserStore
      .getState()
      .ensureLiveView(PROJECT_ID, WORKTREE_ID, 'browser-unknown');

    expect(browserApi.create).not.toHaveBeenCalled();
  });

  it('keeps the session and marks it failed when a live view cannot be recreated', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    browserApi.create.mockRejectedValue(new Error('connection refused'));

    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    await useBrowserStore
      .getState()
      .ensureLiveView(PROJECT_ID, WORKTREE_ID, BROWSER_ID);

    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.browsers[BROWSER_ID]).toMatchObject({
      id: BROWSER_ID,
      status: 'failed',
      loading: false,
      lastError: 'connection refused',
    });
    expect(bucket.live.has(BROWSER_ID)).toBe(false);
  });
});

describe('browserStore renderer-first open', () => {
  beforeEach(() => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'missing',
      state: null,
    });
  });

  it('publishes the tab with its URL before the backend session exists', async () => {
    const created = deferred<BrowserSessionSnapshot>();
    browserApi.create.mockReturnValue(created.promise);

    const opened = useBrowserStore
      .getState()
      .openBrowser(PROJECT_ID, WORKTREE_ID, {
        url: 'http://localhost:5173/app',
      });

    // Synchronously: a placeholder the pane can render right away.
    const placeholder =
      useBrowserStore.getState().worktrees[KEY].browsers[opened.browserId];
    expect(placeholder).toMatchObject({
      id: opened.browserId,
      url: 'http://localhost:5173/app',
      status: 'loading',
      loading: true,
    });
    expect(useBrowserStore.getState().worktrees[KEY].browserOrder).toEqual([
      opened.browserId,
    ]);
    expect(useBrowserStore.getState().openingBrowserIds[opened.browserId]).toBe(
      true,
    );
    expect(
      useBrowserStore.getState().worktrees[KEY].live.has(opened.browserId),
    ).toBe(false);

    // The backend creates exactly that id with the URL.
    await flushAsync();
    expect(browserApi.create).toHaveBeenCalledTimes(1);
    expect(browserApi.create).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      browserId: opened.browserId,
      url: 'http://localhost:5173/app',
    });

    const snapshot = liveSnapshot({
      id: opened.browserId,
      url: 'http://localhost:5173/app',
      status: 'ready',
    });
    created.resolve(snapshot);
    await expect(opened.ready).resolves.toEqual(snapshot);

    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.browsers[opened.browserId].status).toBe('ready');
    expect(bucket.live.has(opened.browserId)).toBe(true);
    expect(useBrowserStore.getState().openingBrowserIds).toEqual({});
    // `create` loads the URL itself; no second navigation.
    expect(browserApi.navigate).not.toHaveBeenCalled();
  });

  it('keeps a failed open in its tab with the error, and resolves null', async () => {
    browserApi.create.mockRejectedValue(new Error('Profile unavailable'));

    const opened = useBrowserStore
      .getState()
      .openBrowser(PROJECT_ID, WORKTREE_ID, {
        url: 'http://localhost:5173/app',
      });

    await expect(opened.ready).resolves.toBeNull();
    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.browsers[opened.browserId]).toMatchObject({
      status: 'failed',
      loading: false,
      lastError: 'Profile unavailable',
    });
    expect(bucket.live.has(opened.browserId)).toBe(false);
    expect(useBrowserStore.getState().openingBrowserIds).toEqual({});
  });

  it('never sends the create for a tab closed before it was sent', async () => {
    const hydration = deferred<unknown>();
    browserApi.loadWorktreeState.mockReturnValue(hydration.promise);

    const opened = useBrowserStore
      .getState()
      .openBrowser(PROJECT_ID, WORKTREE_ID);
    await useBrowserStore
      .getState()
      .destroyBrowser(PROJECT_ID, WORKTREE_ID, opened.browserId);
    hydration.resolve({ status: 'missing', state: null });

    await expect(opened.ready).resolves.toBeNull();
    expect(browserApi.create).not.toHaveBeenCalled();
    expect(
      useBrowserStore.getState().worktrees[KEY].browsers[opened.browserId],
    ).toBeUndefined();
    expect(useBrowserStore.getState().openingBrowserIds).toEqual({});
  });

  it('selects an opening tab locally and persists it once the session exists', async () => {
    const created = deferred<BrowserSessionSnapshot>();
    browserApi.create.mockReturnValue(created.promise);

    const opened = useBrowserStore
      .getState()
      .openBrowser(PROJECT_ID, WORKTREE_ID);
    const selecting = useBrowserStore
      .getState()
      .setActiveBrowser(PROJECT_ID, WORKTREE_ID, opened.browserId);
    await flushAsync();

    expect(useBrowserStore.getState().worktrees[KEY].activeBrowserId).toBe(
      opened.browserId,
    );
    // Main does not know the id yet.
    expect(browserApi.setActive).not.toHaveBeenCalled();

    created.resolve(liveSnapshot({ id: opened.browserId, url: '' }));
    await selecting;
    expect(browserApi.setActive).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      browserId: opened.browserId,
    });
  });

  it('joins the in-flight open instead of creating the view twice', async () => {
    const created = deferred<BrowserSessionSnapshot>();
    browserApi.create.mockReturnValue(created.promise);

    const opened = useBrowserStore
      .getState()
      .openBrowser(PROJECT_ID, WORKTREE_ID, { url: 'http://localhost:3000/' });
    const ensuring = useBrowserStore
      .getState()
      .ensureLiveView(PROJECT_ID, WORKTREE_ID, opened.browserId);
    await flushAsync();
    created.resolve(liveSnapshot({ id: opened.browserId }));
    await ensuring;

    expect(browserApi.create).toHaveBeenCalledTimes(1);
    expect(
      useBrowserStore.getState().worktrees[KEY].live.has(opened.browserId),
    ).toBe(true);
  });

  it('opens dev-server URLs in a new tab instead of reusing another account on the exact URL', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    useBrowserStore.getState().applySnapshot(liveSnapshot({ status: 'ready' }));
    browserApi.create.mockImplementation((request: { browserId: string }) =>
      Promise.resolve(liveSnapshot({ id: request.browserId })),
    );

    const opened = useBrowserStore
      .getState()
      .openUrlFromDevServer(PROJECT_ID, WORKTREE_ID, {
        url: 'http://localhost:3000/',
      });

    expect(opened.createdNewSession).toBe(true);
    expect(opened.browserId).not.toBe(BROWSER_ID);
    // URL equality does not authorize choosing an existing account.
    expect(useBrowserStore.getState().worktrees[KEY].browserOrder).toEqual([
      BROWSER_ID,
      opened.browserId,
    ]);
    await expect(opened.ready).resolves.toMatchObject({
      id: opened.browserId,
    });
  });

  it('keeps a URL submitted while opening loading over the blank created session', async () => {
    const created = deferred<BrowserSessionSnapshot>();
    browserApi.create.mockReturnValue(created.promise);
    const opened = useBrowserStore
      .getState()
      .openBrowser(PROJECT_ID, WORKTREE_ID);
    const placeholder = (): BrowserSessionSnapshot =>
      useBrowserStore.getState().worktrees[KEY].browsers[opened.browserId];

    // Blank while opening: no loading state.
    expect(placeholder()).toMatchObject({ url: '', loading: false });

    useBrowserStore
      .getState()
      .startPendingNavigation(opened.browserId, 'http://localhost:5173/');
    expect(placeholder()).toMatchObject({
      url: 'http://localhost:5173/',
      status: 'loading',
      loading: true,
    });

    // The session is created blank; the submitted URL stays loading.
    created.resolve(
      liveSnapshot({ id: opened.browserId, url: '', status: 'idle' }),
    );
    await opened.ready;
    expect(placeholder()).toMatchObject({
      url: 'http://localhost:5173/',
      status: 'loading',
    });

    // The navigation reports the real URL and takes over.
    useBrowserStore.getState().applySnapshot(
      liveSnapshot({
        id: opened.browserId,
        url: 'http://localhost:5173/',
        status: 'ready',
      }),
    );
    useBrowserStore
      .getState()
      .applySnapshot(
        liveSnapshot({ id: opened.browserId, url: '', status: 'idle' }),
      );
    expect(placeholder()).toMatchObject({ url: '', status: 'idle' });
  });

  it('keeps a tab opened and selected during hydration active, and persists it', async () => {
    const hydration = deferred<unknown>();
    browserApi.loadWorktreeState.mockReturnValue(hydration.promise);
    const created = deferred<BrowserSessionSnapshot>();
    browserApi.create.mockReturnValue(created.promise);

    const opened = useBrowserStore
      .getState()
      .openBrowser(PROJECT_ID, WORKTREE_ID);
    const selecting = useBrowserStore
      .getState()
      .setActiveBrowser(PROJECT_ID, WORKTREE_ID, opened.browserId);
    // Hydration finishes with another saved active browser.
    hydration.resolve({ status: 'loaded', state: persistedState() });
    await flushAsync();
    expect(useBrowserStore.getState().worktrees[KEY].activeBrowserId).toBe(
      opened.browserId,
    );

    created.resolve(liveSnapshot({ id: opened.browserId, url: '' }));
    await selecting;
    expect(useBrowserStore.getState().worktrees[KEY].activeBrowserId).toBe(
      opened.browserId,
    );
    expect(browserApi.setActive).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      browserId: opened.browserId,
    });
  });

  it('keeps a submitted URL pending when another URL fails to load', () => {
    seedLive(
      liveSnapshot({ url: 'http://localhost:3000/', status: 'loading' }),
      false,
    );
    useBrowserStore
      .getState()
      .startPendingNavigation(BROWSER_ID, 'http://localhost:4000/');
    useBrowserStore.getState().applySnapshot(
      liveSnapshot({
        url: 'http://localhost:3000/',
        status: 'failed',
        loading: false,
      }),
    );
    expect(pendingBrowserNavigationUrl(BROWSER_ID)).toBe(
      'http://localhost:4000/',
    );
    useBrowserStore.getState().clearPendingNavigation(BROWSER_ID);
  });

  it('tracks a main-driven open until main settles it, without creating it', async () => {
    const newId = 'browser-agent';
    useBrowserStore.getState().trackExternalBrowserOpen({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      browserId: newId,
      url: 'http://localhost:4000/',
    });
    expect(
      useBrowserStore.getState().worktrees[KEY].browsers[newId],
    ).toMatchObject({ url: 'http://localhost:4000/', loading: true });

    let ensured = false;
    const ensuring = useBrowserStore
      .getState()
      .ensureLiveView(PROJECT_ID, WORKTREE_ID, newId)
      .then(() => {
        ensured = true;
      });
    await flushAsync();
    expect(ensured).toBe(false);

    useBrowserStore
      .getState()
      .registerBrowserSnapshot(liveSnapshot({ id: newId }));
    useBrowserStore.getState().settleExternalBrowserOpen(newId);
    await ensuring;

    expect(browserApi.create).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().openingBrowserIds).toEqual({});
  });
});

describe('browserStore push-event mirrors', () => {
  it('registerBrowserSnapshot appends new sessions without duplicating', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    useBrowserStore
      .getState()
      .registerBrowserSnapshot(liveSnapshot({ id: OTHER_BROWSER_ID }));
    useBrowserStore
      .getState()
      .registerBrowserSnapshot(liveSnapshot({ id: OTHER_BROWSER_ID }));

    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.browserOrder).toEqual([BROWSER_ID, OTHER_BROWSER_ID]);
    expect(bucket.live.has(OTHER_BROWSER_ID)).toBe(true);
  });

  it('applySnapshot updates only tracked sessions', async () => {
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

    useBrowserStore
      .getState()
      .applySnapshot(liveSnapshot({ title: 'Updated app' }));
    useBrowserStore
      .getState()
      .applySnapshot(liveSnapshot({ id: 'browser-untracked' }));

    const bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.browsers[BROWSER_ID].title).toBe('Updated app');
    expect(bucket.browsers['browser-untracked']).toBeUndefined();
  });
});

describe('browserStore native-view release', () => {
  it('recreates a released view after a final snapshot arrives during disposal', async () => {
    browserApi.create.mockResolvedValue(liveSnapshot());
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    useBrowserStore.getState().applySnapshot(liveSnapshot());
    browserApi.disposeLiveView.mockImplementationOnce(() => {
      // Chromium can publish a final title/load event while main persists
      // the live snapshot, before closing its WebContentsView.
      useBrowserStore
        .getState()
        .applySnapshot(liveSnapshot({ title: 'Final title' }));
      return Promise.resolve();
    });

    useBrowserStore.getState().releaseWorktreeViews(PROJECT_ID, WORKTREE_ID);
    await useBrowserStore
      .getState()
      .ensureLiveView(PROJECT_ID, WORKTREE_ID, BROWSER_ID);

    expect(browserApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ browserId: BROWSER_ID }),
    );
    expect(useBrowserStore.getState().worktrees[KEY].live.has(BROWSER_ID)).toBe(
      true,
    );
    expect(browserApi.destroy).not.toHaveBeenCalled();
  });

  it('does not let an older release clear a rematerialized view', async () => {
    browserApi.create.mockResolvedValue(liveSnapshot());
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'loaded',
      state: persistedState(),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    useBrowserStore.getState().applySnapshot(liveSnapshot());
    const olderRelease = deferred<void>();
    const olderReleaseStarted = deferred<void>();
    browserApi.disposeLiveView.mockImplementationOnce(() => {
      olderReleaseStarted.resolve(undefined);
      return olderRelease.promise;
    });
    useBrowserStore.getState().releaseWorktreeViews(PROJECT_ID, WORKTREE_ID);
    // Start the older IPC before the next leave/return episode.
    await olderReleaseStarted.promise;
    useBrowserStore.getState().releaseWorktreeViews(PROJECT_ID, WORKTREE_ID);
    await useBrowserStore
      .getState()
      .ensureLiveView(PROJECT_ID, WORKTREE_ID, BROWSER_ID);
    olderRelease.resolve(undefined);
    await flushAsync();

    expect(useBrowserStore.getState().worktrees[KEY].live.has(BROWSER_ID)).toBe(
      true,
    );
    expect(browserApi.create).toHaveBeenCalledTimes(1);
  });

  it('releases live worktree views without discarding persisted browser tabs', async () => {
    jest.useFakeTimers();
    try {
      browserApi.loadWorktreeState.mockResolvedValue({
        status: 'loaded',
        state: persistedState(),
      });
      await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
      useBrowserStore.getState().applySnapshot(liveSnapshot());
      browserApi.saveWorktreeState.mockClear();

      useBrowserStore.getState().releaseWorktreeViews(PROJECT_ID, WORKTREE_ID);

      const bucket =
        useBrowserStore.getState().worktrees[`${PROJECT_ID}/${WORKTREE_ID}`];
      expect(bucket.browsers[BROWSER_ID]).toEqual(liveSnapshot());
      expect(bucket.browserOrder).toEqual([BROWSER_ID]);
      expect(bucket.live.has(BROWSER_ID)).toBe(false);
      expect(browserApi.setVisible).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
        visible: false,
      });
      expect(browserApi.disposeLiveView).not.toHaveBeenCalled();
      expect(browserApi.saveWorktreeState).not.toHaveBeenCalled();

      jest.runOnlyPendingTimers();
      await Promise.resolve();
      expect(browserApi.disposeLiveView).toHaveBeenCalledWith({
        browserId: BROWSER_ID,
      });
      expect(browserApi.destroy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not revive a view whose creation finishes after panel teardown', async () => {
    jest.useFakeTimers();
    try {
      let resolveCreate:
        | ((snapshot: BrowserSessionSnapshot) => void)
        | undefined;
      browserApi.loadWorktreeState.mockResolvedValue({
        status: 'loaded',
        state: persistedState(),
      });
      browserApi.create.mockImplementationOnce(
        () =>
          new Promise<BrowserSessionSnapshot>((resolve) => {
            resolveCreate = resolve;
          }),
      );
      browserApi.create.mockResolvedValueOnce(liveSnapshot());
      await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);

      const ensure = useBrowserStore
        .getState()
        .ensureLiveView(PROJECT_ID, WORKTREE_ID, BROWSER_ID);
      useBrowserStore.getState().releaseWorktreeViews(PROJECT_ID, WORKTREE_ID);
      jest.runOnlyPendingTimers();
      await Promise.resolve();

      resolveCreate?.(liveSnapshot());
      const replacement = useBrowserStore
        .getState()
        .ensureLiveView(PROJECT_ID, WORKTREE_ID, BROWSER_ID);
      await Promise.resolve();

      expect(browserApi.create).toHaveBeenCalledTimes(1);
      jest.runOnlyPendingTimers();
      await ensure;
      await replacement;

      const bucket =
        useBrowserStore.getState().worktrees[`${PROJECT_ID}/${WORKTREE_ID}`];
      expect(browserApi.create).toHaveBeenCalledTimes(2);
      expect(bucket.live.has(BROWSER_ID)).toBe(true);
      expect(bucket.browsers[BROWSER_ID].status).toBe('ready');
      expect(browserApi.disposeLiveView).toHaveBeenCalledTimes(2);
      expect(browserApi.destroy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('browserStore diagnostics', () => {
  it('upserts network entries by requestId rather than appending duplicates', () => {
    useBrowserStore.getState().upsertNetworkEntry(BROWSER_ID, {
      id: 'n1',
      browserId: BROWSER_ID,
      requestId: 'req-1',
      timestamp: 1,
      method: 'GET',
      url: 'http://localhost:3000/api',
    });
    useBrowserStore.getState().upsertNetworkEntry(BROWSER_ID, {
      id: 'n1',
      browserId: BROWSER_ID,
      requestId: 'req-1',
      timestamp: 2,
      method: 'GET',
      url: 'http://localhost:3000/api',
      status: 200,
      durationMs: 42,
    });

    const entries = useBrowserStore.getState().networkEntries[BROWSER_ID];
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe(200);
    expect(entries[0].durationMs).toBe(42);
  });

  it('tracks unread browser diagnostics until viewed', () => {
    useBrowserStore.getState().appendConsoleEntry(BROWSER_ID, {
      id: 'c1',
      browserId: BROWSER_ID,
      timestamp: 10,
      level: 'error',
      text: 'boom',
    });
    useBrowserStore.getState().upsertNetworkEntry(BROWSER_ID, {
      id: 'n1',
      browserId: BROWSER_ID,
      requestId: 'req-1',
      timestamp: 20,
      method: 'GET',
      url: 'http://localhost:3000/api',
      failed: true,
      errorText: 'net::ERR_FAILED',
    });

    expect(
      selectUnreadConsoleErrorCount(useBrowserStore.getState(), BROWSER_ID),
    ).toBe(1);
    expect(
      selectUnreadFailedRequestCount(useBrowserStore.getState(), BROWSER_ID),
    ).toBe(1);
    expect(
      selectUnreadDiagnosticCount(useBrowserStore.getState(), BROWSER_ID),
    ).toBe(2);

    useBrowserStore.getState().acknowledgeConsoleErrors(BROWSER_ID);
    expect(
      selectUnreadDiagnosticCount(useBrowserStore.getState(), BROWSER_ID),
    ).toBe(1);

    useBrowserStore.getState().acknowledgeNetworkFailures(BROWSER_ID);
    expect(
      selectUnreadDiagnosticCount(useBrowserStore.getState(), BROWSER_ID),
    ).toBe(0);
  });

  it('auto-acknowledges diagnostics already visible in the inspector', () => {
    useBrowserStore.setState({
      inspectorOpen: { [BROWSER_ID]: true },
      inspectorTab: { [BROWSER_ID]: 'console' },
      diagnosticsSeenAt: {},
    });
    useBrowserStore.getState().appendConsoleEntry(BROWSER_ID, {
      id: 'c1',
      browserId: BROWSER_ID,
      timestamp: 10,
      level: 'error',
      text: 'visible',
    });

    expect(
      selectUnreadConsoleErrorCount(useBrowserStore.getState(), BROWSER_ID),
    ).toBe(0);
  });
});

describe('browserStore transfers', () => {
  function download(
    overrides: Partial<BrowserDownloadTransfer> = {},
  ): BrowserDownloadTransfer {
    return {
      kind: 'download',
      id: 'download-1',
      browserId: BROWSER_ID,
      source: 'user',
      origin: 'http://localhost:3000/files/report.csv',
      fileName: 'report.csv',
      receivedBytes: 10,
      totalBytes: 100,
      status: 'in_progress',
      startedAt: 100,
      ...overrides,
    };
  }

  let listTransfers: jest.Mock<
    Promise<BrowserListTransfersResult>,
    [BrowserListTransfersRequest]
  >;
  let transferCommand: jest.Mock<
    Promise<BrowserTransferCommandResult>,
    [BrowserTransferCommand]
  >;

  beforeEach(() => {
    listTransfers = jest.fn<
      Promise<BrowserListTransfersResult>,
      [BrowserListTransfersRequest]
    >();
    transferCommand = jest.fn<
      Promise<BrowserTransferCommandResult>,
      [BrowserTransferCommand]
    >();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: { browser: { ...browserApi, listTransfers, transferCommand } },
      },
    });
    useBrowserStore.setState({
      transfers: {},
      blockedDownloads: {},
      downloadToasts: {},
    });
  });

  it('hydrates the list through the preload, newest first', async () => {
    listTransfers.mockResolvedValue({
      transfers: [
        download({ id: 'older', startedAt: 50 }),
        download({ id: 'newer', startedAt: 200 }),
      ],
      total: 2,
      offset: 0,
      limit: 100,
    });

    await useBrowserStore.getState().hydrateTransfers(BROWSER_ID);

    expect(listTransfers).toHaveBeenCalledWith({
      browserId: BROWSER_ID,
      limit: 100,
    });
    expect(
      useBrowserStore.getState().transfers[BROWSER_ID]?.map((t) => t.id),
    ).toEqual(['newer', 'older']);
  });

  it('keeps a running download listed however many newer downloads finish after it', () => {
    const store = useBrowserStore.getState();
    store.upsertTransfer(BROWSER_ID, download({ id: 'running', startedAt: 1 }));
    for (let index = 0; index < 120; index += 1)
      store.upsertTransfer(
        BROWSER_ID,
        download({
          id: `done-${index}`,
          status: 'complete',
          receivedBytes: 100,
          startedAt: 10 + index,
        }),
      );
    const listed = useBrowserStore.getState().transfers[BROWSER_ID] ?? [];
    expect(listed).toHaveLength(100);
    expect(listed[0]?.id).toBe('done-119');
    expect(listed.map((transfer) => transfer.id)).toContain('running');
    expect(
      selectActiveTransferCount(useBrowserStore.getState(), BROWSER_ID),
    ).toBe(1);
  });

  it('hydrates running downloads older than the newest page', async () => {
    const finished = Array.from({ length: 100 }, (_, index) =>
      download({
        id: `done-${index}`,
        status: 'complete',
        receivedBytes: 100,
        startedAt: 100 + index,
      }),
    );
    listTransfers.mockImplementation((request) =>
      Promise.resolve({
        transfers:
          request.status === 'in_progress'
            ? [download({ id: 'running', startedAt: 1 })]
            : request.status === 'interrupted'
              ? [
                  download({
                    id: 'resumable',
                    status: 'interrupted',
                    canResume: true,
                    startedAt: 2,
                  }),
                ]
              : finished,
        total: 102,
        offset: 0,
        limit: 100,
      }),
    );

    await useBrowserStore.getState().hydrateTransfers(BROWSER_ID);

    const ids = (useBrowserStore.getState().transfers[BROWSER_ID] ?? []).map(
      (transfer) => transfer.id,
    );
    expect(ids).toHaveLength(100);
    expect(ids).toEqual(expect.arrayContaining(['running', 'resumable']));
    expect(
      selectActiveTransferCount(useBrowserStore.getState(), BROWSER_ID),
    ).toBe(2);
  });

  it('hydrates a resumable download behind more than a page of finished interruptions', async () => {
    const stopped = Array.from({ length: 100 }, (_, index) =>
      download({
        id: `stopped-${index}`,
        status: 'interrupted',
        canResume: false,
        startedAt: 1000 - index,
      }),
    );
    listTransfers.mockImplementation((request) => {
      const interrupted = [
        ...stopped,
        download({
          id: 'resumable',
          status: 'interrupted',
          canResume: true,
          startedAt: 1,
        }),
      ];
      const offset = request.offset ?? 0;
      const transfers =
        request.status === 'interrupted'
          ? interrupted.slice(offset, offset + (request.limit ?? 25))
          : request.status === undefined
            ? interrupted.slice(0, request.limit ?? 25)
            : [];
      return Promise.resolve({
        transfers,
        total: request.status === 'in_progress' ? 0 : interrupted.length,
        offset,
        limit: request.limit ?? 25,
      });
    });

    await useBrowserStore.getState().hydrateTransfers(BROWSER_ID);

    const ids = (useBrowserStore.getState().transfers[BROWSER_ID] ?? []).map(
      (transfer) => transfer.id,
    );
    expect(ids).toContain('resumable');
    expect(
      selectActiveTransferCount(useBrowserStore.getState(), BROWSER_ID),
    ).toBe(1);
  });

  it('keeps an update that arrived while the list was loading', async () => {
    let resolveList: (value: BrowserListTransfersResult) => void = () =>
      undefined;
    listTransfers.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const hydrating = useBrowserStore.getState().hydrateTransfers(BROWSER_ID);
    useBrowserStore
      .getState()
      .upsertTransfer(
        BROWSER_ID,
        download({ status: 'interrupted', canResume: true, receivedBytes: 10 }),
      );
    resolveList({
      transfers: [download({ status: 'in_progress', receivedBytes: 10 })],
      total: 1,
      offset: 0,
      limit: 100,
    });
    await hydrating;

    expect(useBrowserStore.getState().transfers[BROWSER_ID]).toEqual([
      download({ status: 'interrupted', canResume: true, receivedBytes: 10 }),
    ]);
  });

  it('never moves a finished download back to in progress', () => {
    const store = useBrowserStore.getState();
    store.upsertTransfer(
      BROWSER_ID,
      download({ status: 'complete', receivedBytes: 100 }),
    );
    store.upsertTransfer(BROWSER_ID, download({ receivedBytes: 90 }));

    expect(useBrowserStore.getState().transfers[BROWSER_ID]?.[0]).toMatchObject(
      { status: 'complete', receivedBytes: 100 },
    );
  });

  it('announces a download once when it completes', async () => {
    const store = useBrowserStore.getState();
    store.upsertTransfer(BROWSER_ID, download());
    expect(useBrowserStore.getState().downloadToasts[BROWSER_ID]).toBe(
      undefined,
    );

    store.upsertTransfer(
      BROWSER_ID,
      download({ status: 'complete', receivedBytes: 100 }),
    );
    expect(useBrowserStore.getState().downloadToasts[BROWSER_ID]).toMatchObject(
      { id: 'download-1', fileName: 'report.csv' },
    );

    store.dismissDownloadToast(BROWSER_ID, 'download-1');
    store.upsertTransfer(
      BROWSER_ID,
      download({ status: 'complete', receivedBytes: 100 }),
    );
    expect(useBrowserStore.getState().downloadToasts[BROWSER_ID]).toBe(
      undefined,
    );

    // A download that was already complete when the list loaded is old news.
    listTransfers.mockResolvedValue({
      transfers: [download({ id: 'old', status: 'complete' })],
      total: 1,
      offset: 0,
      limit: 100,
    });
    await store.hydrateTransfers(BROWSER_ID);
    expect(useBrowserStore.getState().downloadToasts[BROWSER_ID]).toBe(
      undefined,
    );
  });

  it('counts running, paused, and resumable downloads as active', () => {
    const store = useBrowserStore.getState();
    store.upsertTransfer(BROWSER_ID, download({ id: 'running' }));
    store.upsertTransfer(
      BROWSER_ID,
      download({ id: 'paused', status: 'paused' }),
    );
    store.upsertTransfer(
      BROWSER_ID,
      download({ id: 'resumable', status: 'interrupted', canResume: true }),
    );
    store.upsertTransfer(
      BROWSER_ID,
      download({ id: 'stuck', status: 'interrupted', canResume: false }),
    );
    store.upsertTransfer(
      BROWSER_ID,
      download({ id: 'done', status: 'complete' }),
    );
    store.upsertTransfer(
      BROWSER_ID,
      download({ id: 'failed', status: 'failed' }),
    );

    expect(
      selectActiveTransferCount(useBrowserStore.getState(), BROWSER_ID),
    ).toBe(3);
    expect(
      selectActiveTransferCount(useBrowserStore.getState(), OTHER_BROWSER_ID),
    ).toBe(0);
  });

  it('runs a command and applies the transfer it returns', async () => {
    transferCommand.mockResolvedValue({
      ok: true,
      transfer: download({ status: 'cancelled' }),
    });
    useBrowserStore.getState().upsertTransfer(BROWSER_ID, download());

    const result = await useBrowserStore.getState().runTransferCommand({
      kind: 'cancel',
      browserId: BROWSER_ID,
      transferId: 'download-1',
    });

    expect(transferCommand).toHaveBeenCalledWith({
      kind: 'cancel',
      browserId: BROWSER_ID,
      transferId: 'download-1',
    });
    expect(result.ok).toBe(true);
    expect(useBrowserStore.getState().transfers[BROWSER_ID]?.[0]?.status).toBe(
      'cancelled',
    );
  });

  it('allows more downloads and clears the blocked notice', async () => {
    transferCommand.mockResolvedValue({ ok: true });
    useBrowserStore.getState().noteDownloadsBlocked(BROWSER_ID, 1);
    expect(useBrowserStore.getState().blockedDownloads[BROWSER_ID]).toBe(1);

    await useBrowserStore.getState().allowMoreDownloads(BROWSER_ID);

    expect(transferCommand).toHaveBeenCalledWith({
      kind: 'allow_more',
      browserId: BROWSER_ID,
    });
    expect(useBrowserStore.getState().blockedDownloads[BROWSER_ID]).toBe(
      undefined,
    );
  });

  it('opens the inspector on the Files tab', () => {
    useBrowserStore.getState().openFilesPanel(BROWSER_ID);

    expect(useBrowserStore.getState().inspectorOpen[BROWSER_ID]).toBe(true);
    expect(useBrowserStore.getState().inspectorTab[BROWSER_ID]).toBe('files');
  });

  it('keeps transfers across a profile switch and drops them with the tab', async () => {
    const profile = {
      selection: { kind: 'task' as const },
      resolvedProfileId: 'task-profile',
      storageGeneration: 1,
      runtimeGeneration: 1,
      taskIncarnationId: 'incarnation',
    };
    browserApi.loadWorktreeState.mockResolvedValue({
      status: 'ok',
      state: persistedState(),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, WORKTREE_ID);
    useBrowserStore
      .getState()
      .registerBrowserSnapshot(liveSnapshot({ profile }));
    useBrowserStore.getState().upsertTransfer(BROWSER_ID, download());
    useBrowserStore.getState().noteDownloadsBlocked(BROWSER_ID, 1);

    useBrowserStore
      .getState()
      .applySnapshot(
        liveSnapshot({ profile: { ...profile, runtimeGeneration: 2 } }),
      );
    expect(useBrowserStore.getState().transfers[BROWSER_ID]).toHaveLength(1);

    useBrowserStore
      .getState()
      .dropBrowserSession(PROJECT_ID, WORKTREE_ID, BROWSER_ID);
    expect(useBrowserStore.getState().transfers[BROWSER_ID]).toBe(undefined);
    expect(useBrowserStore.getState().blockedDownloads[BROWSER_ID]).toBe(
      undefined,
    );
  });
});

describe('browserStore in a window that shows another computer', () => {
  beforeEach(() => {
    browserApi.create.mockReturnValue(new Promise(() => undefined));
    // The in-app browser is blocked while controlling another computer.
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          browser: browserApi,
          remoteControl: {
            getContext: (): unknown => ({
              mode: 'remote',
              deviceId: 'device-b',
              name: 'Studio',
              platform: 'darwin',
            }),
          },
        },
      },
    });
  });

  it('opens no placeholder session for a new tab', async () => {
    const opened = useBrowserStore
      .getState()
      .openBrowser(PROJECT_ID, WORKTREE_ID, { url: 'http://localhost:3000/' });
    await flushAsync();

    expect(opened).toBeNull();
    expect(useBrowserStore.getState().worktrees[KEY]).toBeUndefined();
    expect(useBrowserStore.getState().openingBrowserIds).toEqual({});
    expect(browserApi.create).not.toHaveBeenCalled();
  });

  it('opens no placeholder session for a dev-server URL', async () => {
    const opened = useBrowserStore
      .getState()
      .openUrlFromDevServer(PROJECT_ID, WORKTREE_ID, {
        url: 'http://localhost:3000/',
      });
    await flushAsync();

    expect(opened).toBeNull();
    expect(useBrowserStore.getState().worktrees[KEY]).toBeUndefined();
    expect(browserApi.create).not.toHaveBeenCalled();
  });
});
