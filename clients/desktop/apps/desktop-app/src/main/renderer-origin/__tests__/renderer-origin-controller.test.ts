import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createRendererOriginController,
  type RendererOriginControllerOptions,
  type RendererOriginDiagnostic,
} from '../renderer-origin-controller';
import type {
  OriginStorageBridge,
  OriginStorageChanges,
  OriginStorageSnapshot,
  RendererOrigin,
  RendererOriginRecord,
  RendererOriginRecordStore,
} from '../renderer-origin-migration';

/**
 * Window loading and the fail-safe for the renderer scheme. Windows are
 * fakes: their webContents emit the Electron events the controller listens
 * to, and `executeJavaScript` answers the readiness probe.
 */

const RENDERER_DIR = join('/app', 'out', 'renderer');

class FakeWebContents extends EventEmitter {
  url = '';
  destroyed = false;
  rootChildren = 0;
  readonly executed: string[] = [];
  getURL(): string {
    return this.url;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  executeJavaScript(code: string): Promise<unknown> {
    this.executed.push(code);
    return Promise.resolve(this.rootChildren);
  }
  crashes = 0;
  forcefullyCrashRenderer(): void {
    this.crashes += 1;
  }
}

class FakeWindow {
  readonly webContents = new FakeWebContents();
  readonly loads: string[] = [];
  failNextLoad: { code: number } | null = null;
  isDestroyed(): boolean {
    return false;
  }
  loadFile(): Promise<void> {
    return Promise.reject(new Error('The controller loads file:// pages.'));
  }
  hangBlankLoad = false;
  rejectBlankLoad = false;
  loadURL(url: string): Promise<void> {
    this.loads.push(url);
    if (url === 'about:blank' && this.hangBlankLoad) {
      return new Promise<void>(() => undefined);
    }
    if (url === 'about:blank' && this.rejectBlankLoad) {
      // The navigation failed, so the scheme page is still committed.
      return Promise.reject(new Error('ERR_FAILED (-2)'));
    }
    this.webContents.url = url;
    if (this.failNextLoad) {
      const { code } = this.failNextLoad;
      this.failNextLoad = null;
      return Promise.reject(
        Object.assign(new Error(`ERR (${String(code)})`), { errno: code }),
      );
    }
    return Promise.resolve();
  }
}

class Bridge implements OriginStorageBridge {
  storage: Record<RendererOrigin, Map<string, string>> = {
    file: new Map([['a', '1']]),
    scheme: new Map(),
  };
  read(origin: RendererOrigin): Promise<OriginStorageSnapshot> {
    return Promise.resolve({
      localStorage: [...this.storage[origin].entries()],
      indexedDbNames: [],
    });
  }
  replace(
    origin: RendererOrigin,
    entries: ReadonlyArray<readonly [string, string]>,
  ): Promise<void> {
    this.storage[origin] = new Map(entries);
    return Promise.resolve();
  }
  update(origin: RendererOrigin, changes: OriginStorageChanges): Promise<void> {
    for (const key of changes.remove) this.storage[origin].delete(key);
    for (const [key, value] of changes.set)
      this.storage[origin].set(key, value);
    return Promise.resolve();
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  abort(): void {
    // Nothing in flight to stop.
  }
}

class Store implements RendererOriginRecordStore {
  record: RendererOriginRecord | null = null;
  read(): Promise<RendererOriginRecord | null> {
    return Promise.resolve(this.record);
  }
  write(record: RendererOriginRecord): Promise<void> {
    this.record = record;
    return Promise.resolve();
  }
}

interface Harness {
  controller: ReturnType<typeof createRendererOriginController>;
  main: FakeWindow;
  advisor: FakeWindow;
  bridge: Bridge;
  store: Store;
  fileLoads: string[];
  disableSetting: jest.Mock<Promise<void>, []>;
  diagnostics: RendererOriginDiagnostic[];
  registeredHandlers: number;
  handlerError: (error: unknown) => void;
}

function setup(
  overrides: Partial<RendererOriginControllerOptions> = {},
): Harness {
  const main = new FakeWindow();
  const advisor = new FakeWindow();
  const bridge = new Bridge();
  const store = new Store();
  const fileLoads: string[] = [];
  const diagnostics: RendererOriginDiagnostic[] = [];
  const disableSetting = jest.fn<Promise<void>, []>(() => Promise.resolve());
  const harness: Partial<Harness> = {
    registeredHandlers: 0,
    handlerError: () => undefined,
  };
  const controller = createRendererOriginController({
    rendererDir: RENDERER_DIR,
    store,
    createBridge: () => bridge,
    registerSchemeHandler: (options) => {
      harness.registeredHandlers = (harness.registeredHandlers ?? 0) + 1;
      harness.handlerError = options.onError;
    },
    loadFile: (target) => {
      fileLoads.push(target.surface);
      return Promise.resolve();
    },
    disableSetting,
    reenableSetting: () => Promise.resolve(),
    recordDiagnostic: (event) => diagnostics.push(event),
    readyTimeoutMs: 1_000,
    readyPollIntervalMs: 100,
    blankTimeoutMs: 50,
    now: () => new Date('2026-10-02T12:00:00.000Z'),
    ...overrides,
  });
  return Object.assign(harness, {
    controller,
    main,
    advisor,
    bridge,
    store,
    fileLoads,
    disableSetting,
    diagnostics,
  }) as Harness;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function onScheme(): Promise<Harness> {
  const harness = setup();
  harness.controller.startRecordProbe();
  await harness.controller.prepare(true);
  await harness.controller.loadWindow({
    surface: 'main',
    window: harness.main,
  });
  return harness;
}

describe('renderer origin controller', () => {
  it('trusts exactly the two file:// pages by default, as today', () => {
    const { controller } = setup();
    expect(controller.current()).toBe('file');
    expect(controller.trustedRendererPageUrls()).toEqual([
      pathToFileURL(join(RENDERER_DIR, 'index.html')).href,
      pathToFileURL(join(RENDERER_DIR, 'app-advisor.html')).href,
    ]);
    expect(controller.status()).toEqual({
      active: false,
      fellBack: false,
      switchBackFailed: false,
    });
  });

  it('stays on file:// without registering a handler when the setting is off', async () => {
    const harness = setup();
    harness.controller.startRecordProbe();
    await expect(harness.controller.prepare(false)).resolves.toBe('file');
    expect(harness.registeredHandlers).toBe(0);
    expect(harness.controller.current()).toBe('file');
  });

  it('loads both windows from the scheme and trusts only those two pages', async () => {
    const harness = setup();
    harness.controller.startRecordProbe();
    await expect(harness.controller.prepare(true)).resolves.toBe('scheme');
    expect(harness.registeredHandlers).toBe(1);
    expect(harness.bridge.storage.scheme.get('a')).toBe('1');

    await harness.controller.loadWindow({
      surface: 'main',
      window: harness.main,
    });
    await harness.controller.loadWindow({
      surface: 'app-advisor',
      window: harness.advisor,
    });

    expect(harness.main.loads).toEqual(['app-renderer://bundle/index.html']);
    expect(harness.advisor.loads).toEqual([
      'app-renderer://bundle/app-advisor.html?surface=app-advisor',
    ]);
    expect(harness.controller.trustedRendererPageUrls()).toEqual([
      'app-renderer://bundle/index.html',
      'app-renderer://bundle/app-advisor.html',
    ]);
    expect(harness.controller.status()).toEqual({
      active: true,
      fellBack: false,
      switchBackFailed: false,
    });
  });

  it('falls back to file:// when the main frame fails to load', async () => {
    const harness = await onScheme();
    harness.bridge.storage.scheme.set('a', 'written on the scheme');

    harness.main.webContents.emit(
      'did-fail-load',
      {},
      -6,
      'ERR_FILE_NOT_FOUND',
      'app-renderer://bundle/index.html',
      true,
    );
    await harness.controller.whenSettled();

    expect(harness.main.loads.at(-1)).toBe('about:blank');
    expect(harness.fileLoads).toEqual(['main']);
    expect(harness.bridge.storage.file.get('a')).toBe('written on the scheme');
    expect(harness.disableSetting).toHaveBeenCalledTimes(1);
    expect(harness.controller.current()).toBe('file');
    expect(harness.controller.status()).toEqual({
      active: false,
      fellBack: true,
      switchBackFailed: false,
    });
    expect(harness.controller.trustedRendererPageUrls()[0]).toBe(
      pathToFileURL(join(RENDERER_DIR, 'index.html')).href,
    );
    expect(harness.store.record?.lastUsedOrigin).toBe('file');
    expect(harness.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'fallback', reason: 'did-fail-load' }),
      ]),
    );
  });

  it('stops a renderer too hung to leave the scheme, then still copies storage back', async () => {
    const harness = await onScheme();
    harness.bridge.storage.scheme.set('a', 'written on the scheme');
    harness.main.hangBlankLoad = true;

    harness.main.webContents.emit(
      'did-fail-load',
      {},
      -6,
      'ERR_FILE_NOT_FOUND',
      'app-renderer://bundle/index.html',
      true,
    );
    await harness.controller.whenSettled();

    expect(harness.main.loads.at(-1)).toBe('about:blank');
    expect(harness.main.webContents.crashes).toBe(1);
    expect(harness.bridge.storage.file.get('a')).toBe('written on the scheme');
    expect(harness.fileLoads).toEqual(['main']);
    expect(harness.controller.fallbackInProgress()).toBe(false);
  });

  it('stops a renderer whose blank navigation fails, then still copies storage back', async () => {
    const harness = await onScheme();
    harness.bridge.storage.scheme.set('a', 'written on the scheme');
    harness.main.rejectBlankLoad = true;

    harness.main.webContents.emit(
      'did-fail-load',
      {},
      -6,
      'ERR_FILE_NOT_FOUND',
      'app-renderer://bundle/index.html',
      true,
    );
    await harness.controller.whenSettled();

    expect(harness.main.webContents.crashes).toBe(1);
    expect(harness.bridge.storage.file.get('a')).toBe('written on the scheme');
    expect(harness.fileLoads).toEqual(['main']);
  });

  it('does not stop a renderer that blanked', async () => {
    const harness = await onScheme();

    harness.main.webContents.emit(
      'did-fail-load',
      {},
      -6,
      'ERR_FILE_NOT_FOUND',
      'app-renderer://bundle/index.html',
      true,
    );
    await harness.controller.whenSettled();

    expect(harness.main.webContents.url).toBe('about:blank');
    expect(harness.main.webContents.crashes).toBe(0);
  });

  it('keeps the scheme authoritative when its storage cannot be written back', async () => {
    const harness = await onScheme();
    harness.bridge.storage.scheme.set('a', 'written on the scheme');
    harness.bridge.replace = (): Promise<void> =>
      Promise.reject(new Error('disk full'));

    harness.main.webContents.emit(
      'did-fail-load',
      {},
      -6,
      'ERR_FILE_NOT_FOUND',
      'app-renderer://bundle/index.html',
      true,
    );
    await harness.controller.whenSettled();

    // This launch continues on file://, but the next one copies first.
    expect(harness.fileLoads).toEqual(['main']);
    expect(harness.store.record).toMatchObject({
      lastUsedOrigin: 'scheme',
      pendingMigration: { from: 'scheme', to: 'file' },
    });
    expect(harness.bridge.storage.scheme.get('a')).toBe(
      'written on the scheme',
    );
  });

  it('still reloads file:// and records it authoritative when the bridge cannot open', async () => {
    const harness = await onScheme();
    let bridgeCalls = 0;
    harness.bridge.read = (): Promise<OriginStorageSnapshot> => {
      bridgeCalls += 1;
      return Promise.reject(new Error('no web contents'));
    };

    harness.main.webContents.emit(
      'did-fail-load',
      {},
      -6,
      'x',
      'app-renderer://bundle/index.html',
      true,
    );
    await harness.controller.whenSettled();

    expect(bridgeCalls).toBe(1);
    expect(harness.fileLoads).toEqual(['main']);
    expect(harness.store.record?.lastUsedOrigin).toBe('file');
    expect(harness.store.record?.migrations.at(-1)?.outcome).toBe('abandoned');
    expect(harness.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'fallback', storageMigrated: false }),
      ]),
    );
  });

  it('falls back even when the bridge cannot be created at all', async () => {
    const bridge = new Bridge();
    let created = 0;
    const harness = setup({
      createBridge: () => {
        created += 1;
        if (created > 1) throw new Error('cannot create web contents');
        return bridge;
      },
    });
    harness.controller.startRecordProbe();
    await harness.controller.prepare(true);
    await harness.controller.loadWindow({
      surface: 'main',
      window: harness.main,
    });

    harness.handlerError(new Error('EIO'));
    await harness.controller.whenSettled();

    expect(harness.fileLoads).toEqual(['main']);
    expect(harness.store.record?.lastUsedOrigin).toBe('file');
  });

  it('ignores aborted navigations, subframes and non-scheme pages', async () => {
    const harness = await onScheme();
    const contents = harness.main.webContents;
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', contents.url, true);
    contents.emit('did-fail-load', {}, -6, 'x', contents.url, false);
    contents.emit('did-fail-load', {}, -6, 'x', 'https://example.test/', true);
    await flush();
    expect(harness.fileLoads).toEqual([]);
    expect(harness.controller.current()).toBe('scheme');
  });

  it('falls back when the window load itself rejects', async () => {
    const harness = setup();
    harness.controller.startRecordProbe();
    await harness.controller.prepare(true);
    harness.advisor.failNextLoad = { code: -2 };

    await harness.controller.loadWindow({
      surface: 'app-advisor',
      window: harness.advisor,
    });
    await harness.controller.whenSettled();

    expect(harness.fileLoads).toContain('app-advisor');
    expect(harness.controller.current()).toBe('file');
  });

  it('falls back when the scheme handler reports an error', async () => {
    const harness = await onScheme();
    harness.handlerError(new Error('EIO'));
    await harness.controller.whenSettled();
    expect(harness.fileLoads).toEqual(['main']);
    expect(harness.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'fallback', reason: 'handler-error' }),
      ]),
    );
  });

  it('falls back when the renderer never becomes ready', async () => {
    jest.useFakeTimers();
    try {
      const harness = await onScheme();
      harness.main.webContents.rootChildren = 0;
      harness.main.webContents.emit('did-finish-load');
      for (let step = 0; step < 15; step += 1) {
        await jest.advanceTimersByTimeAsync(100);
      }
      await harness.controller.whenSettled();
      expect(harness.fileLoads).toEqual(['main']);
      expect(harness.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'fallback',
            reason: 'renderer-not-ready',
          }),
        ]),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the scheme once the renderer mounts', async () => {
    jest.useFakeTimers();
    try {
      const harness = await onScheme();
      harness.main.webContents.rootChildren = 1;
      harness.main.webContents.emit('did-finish-load');
      for (let step = 0; step < 15; step += 1) {
        await jest.advanceTimersByTimeAsync(100);
      }
      expect(harness.fileLoads).toEqual([]);
      expect(harness.controller.current()).toBe('scheme');
      expect(harness.main.webContents.executed[0]).toContain(
        "getElementById('root')",
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back once even when several signals arrive', async () => {
    const harness = await onScheme();
    await harness.controller.loadWindow({
      surface: 'app-advisor',
      window: harness.advisor,
    });
    harness.handlerError(new Error('one'));
    harness.handlerError(new Error('two'));
    harness.main.webContents.emit(
      'did-fail-load',
      {},
      -6,
      'x',
      'app-renderer://bundle/index.html',
      true,
    );
    await harness.controller.whenSettled();
    expect(harness.disableSetting).toHaveBeenCalledTimes(1);
    expect(harness.fileLoads.sort()).toEqual(['app-advisor', 'main']);
  });

  it('never rejects: a failure to register the handler keeps file://', async () => {
    const harness = setup({
      registerSchemeHandler: () => {
        throw new Error('scheme already handled');
      },
    });
    harness.controller.startRecordProbe();

    await expect(harness.controller.prepare(true)).resolves.toBe('file');

    expect(harness.controller.current()).toBe('file');
    expect(harness.disableSetting).toHaveBeenCalledTimes(1);
    expect(harness.diagnostics).toEqual([
      expect.objectContaining({
        kind: 'migration-failed',
        error: 'scheme already handled',
      }),
    ]);
  });

  it('turns the setting off and stays on file:// when the copy into the scheme fails', async () => {
    const harness = setup();
    harness.bridge.read = (): Promise<OriginStorageSnapshot> =>
      Promise.reject(new Error('bridge unavailable'));
    harness.controller.startRecordProbe();

    await expect(harness.controller.prepare(true)).resolves.toBe('file');

    expect(harness.disableSetting).toHaveBeenCalledTimes(1);
    expect(harness.controller.status()).toEqual({
      active: false,
      fellBack: true,
      switchBackFailed: false,
    });
    expect(harness.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'migration-failed' }),
      ]),
    );
  });
});

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Holds the bridge's next `replace` until the returned gate opens. */
function holdNextReplace(bridge: Bridge): Deferred {
  const gate = deferred();
  const replace = bridge.replace.bind(bridge);
  bridge.replace = async (origin, entries): Promise<void> => {
    await gate.promise;
    bridge.replace = replace;
    return replace(origin, entries);
  };
  return gate;
}

describe('windows requested while the origin changes', () => {
  it('holds a window requested before prepare finishes, then loads it on the final origin', async () => {
    const harness = setup();
    harness.controller.startRecordProbe();
    const copy = holdNextReplace(harness.bridge);
    const prepared = harness.controller.prepare(true);

    const loading = harness.controller.loadWindow({
      surface: 'main',
      window: harness.main,
    });
    await flush();
    expect(harness.main.loads).toEqual([]);
    expect(harness.fileLoads).toEqual([]);

    copy.resolve();
    await prepared;
    await loading;
    expect(harness.fileLoads).toEqual([]);
    expect(harness.main.loads).toEqual(['app-renderer://bundle/index.html']);
  });

  it('holds a file:// window until a copy back from the scheme has finished', async () => {
    const harness = setup();
    harness.store.record = {
      version: 1,
      lastUsedOrigin: 'scheme',
      migrations: [],
    };
    harness.bridge.storage.scheme = new Map([['a', 'from the scheme']]);
    harness.controller.startRecordProbe();
    const copy = holdNextReplace(harness.bridge);
    const prepared = harness.controller.prepare(false);

    const loading = harness.controller.loadWindow({
      surface: 'app-advisor',
      window: harness.advisor,
    });
    await flush();
    expect(harness.fileLoads).toEqual([]);

    copy.resolve();
    await prepared;
    await loading;
    expect(harness.bridge.storage.file.get('a')).toBe('from the scheme');
    expect(harness.fileLoads).toEqual(['app-advisor']);
    expect(harness.advisor.loads).toEqual([]);
  });

  it('holds a window opened during a fallback until storage is copied back', async () => {
    const harness = await onScheme();
    harness.bridge.storage.scheme.set('a', 'written on the scheme');
    const copy = holdNextReplace(harness.bridge);

    harness.handlerError(new Error('EIO'));
    await flush();
    const loading = harness.controller.loadWindow({
      surface: 'app-advisor',
      window: harness.advisor,
    });
    await flush();
    expect(harness.fileLoads).toEqual([]);
    expect(harness.advisor.loads).toEqual([]);

    copy.resolve();
    await harness.controller.whenSettled();
    await loading;
    expect(harness.bridge.storage.file.get('a')).toBe('written on the scheme');
    expect(harness.fileLoads.sort()).toEqual(['app-advisor', 'main']);
    expect(harness.advisor.loads).toEqual([]);
  });

  it('keeps trusting the scheme pages until the scheme windows are blanked', async () => {
    const harness = await onScheme();
    const blank = deferred();
    const loadURL = harness.main.loadURL.bind(harness.main);
    harness.main.loadURL = async (url: string): Promise<void> => {
      if (url === 'about:blank') await blank.promise;
      return loadURL(url);
    };

    harness.handlerError(new Error('EIO'));
    await flush();
    expect(harness.controller.fallbackInProgress()).toBe(true);
    expect(harness.controller.trustedRendererPageUrls()[0]).toBe(
      'app-renderer://bundle/index.html',
    );

    blank.resolve();
    await harness.controller.whenSettled();
    expect(harness.controller.fallbackInProgress()).toBe(false);
    expect(harness.controller.trustedRendererPageUrls()[0]).toBe(
      pathToFileURL(join(RENDERER_DIR, 'index.html')).href,
    );
  });
});

describe('fail-safe signals', () => {
  it('falls back when the renderer process dies before the page was ready', async () => {
    const harness = await onScheme();
    harness.main.webContents.emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 11 },
    );
    await harness.controller.whenSettled();
    expect(harness.fileLoads).toEqual(['main']);
    expect(harness.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'fallback', reason: 'renderer-gone' }),
      ]),
    );
  });

  it('leaves a crash after the page was ready to the normal reload, but not a second one before it recovers', async () => {
    jest.useFakeTimers();
    try {
      const harness = await onScheme();
      harness.main.webContents.rootChildren = 1;
      harness.main.webContents.emit('did-finish-load');
      await jest.advanceTimersByTimeAsync(100);

      harness.main.webContents.emit(
        'render-process-gone',
        {},
        { reason: 'oom', exitCode: 0 },
      );
      await jest.advanceTimersByTimeAsync(10);
      expect(harness.controller.current()).toBe('scheme');
      expect(harness.fileLoads).toEqual([]);

      harness.main.webContents.emit(
        'render-process-gone',
        {},
        { reason: 'crashed', exitCode: 11 },
      );
      await jest.advanceTimersByTimeAsync(10);
      await harness.controller.whenSettled();
      expect(harness.fileLoads).toEqual(['main']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a clean exit', async () => {
    const harness = await onScheme();
    harness.main.webContents.emit(
      'render-process-gone',
      {},
      { reason: 'clean-exit', exitCode: 0 },
    );
    await flush();
    expect(harness.controller.current()).toBe('scheme');
  });

  it('falls back when the readiness probe never answers', async () => {
    jest.useFakeTimers();
    try {
      const harness = await onScheme();
      harness.main.webContents.executeJavaScript = (): Promise<unknown> =>
        new Promise<unknown>(() => undefined);
      harness.main.webContents.emit('did-finish-load');
      for (let step = 0; step < 30; step += 1) {
        await jest.advanceTimersByTimeAsync(100);
      }
      await harness.controller.whenSettled();
      expect(harness.fileLoads).toEqual(['main']);
      expect(harness.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'fallback',
            reason: 'renderer-not-ready',
          }),
        ]),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back when the page never finishes loading', async () => {
    jest.useFakeTimers();
    try {
      const harness = await onScheme();
      for (let step = 0; step < 15; step += 1) {
        await jest.advanceTimersByTimeAsync(100);
      }
      await harness.controller.whenSettled();
      expect(harness.fileLoads).toEqual(['main']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('launches where the scheme cannot be served or left', () => {
  it('makes file:// authoritative when the handler cannot be registered while the scheme holds the data', async () => {
    const store = new Store();
    const bridge = new Bridge();
    store.record = { version: 1, lastUsedOrigin: 'scheme', migrations: [] };
    bridge.storage.scheme = new Map([['a', 'scheme value']]);
    bridge.storage.file = new Map([['a', 'old file value']]);
    const failed = setup({
      store,
      createBridge: () => bridge,
      registerSchemeHandler: () => {
        throw new Error('scheme already handled');
      },
    });
    failed.controller.startRecordProbe();
    await expect(failed.controller.prepare(true)).resolves.toBe('file');
    expect(store.record?.lastUsedOrigin).toBe('file');
    expect(store.record?.migrations.at(-1)).toMatchObject({
      from: 'scheme',
      to: 'file',
      outcome: 'abandoned',
    });
    // The user works on file:// this launch.
    bridge.storage.file.set('a', 'written on file:// this launch');

    const next = setup({ store, createBridge: () => bridge });
    next.controller.startRecordProbe();
    await expect(next.controller.prepare(false)).resolves.toBe('file');
    expect(bridge.storage.file.get('a')).toBe('written on file:// this launch');
    expect(bridge.storage.scheme.get('a')).toBe('scheme value');
  });

  it('keeps the scheme on when the copy back fails, then stops retrying until the setting changes', async () => {
    const store = new Store();
    const bridge = new Bridge();
    store.record = { version: 1, lastUsedOrigin: 'scheme', migrations: [] };
    bridge.storage.scheme = new Map([['a', 'scheme value']]);
    const reenableSetting = jest.fn<Promise<void>, []>(() => Promise.resolve());
    let reads = 0;
    const read = bridge.read.bind(bridge);
    bridge.read = (origin): Promise<OriginStorageSnapshot> => {
      reads += 1;
      return origin === 'scheme'
        ? Promise.reject(new Error('bridge unavailable'))
        : read(origin);
    };

    const failed = setup({
      store,
      createBridge: () => bridge,
      reenableSetting,
    });
    failed.controller.startRecordProbe();
    await expect(failed.controller.prepare(false)).resolves.toBe('scheme');
    expect(reenableSetting).toHaveBeenCalledTimes(1);
    expect(failed.controller.status()).toEqual({
      active: true,
      fellBack: false,
      switchBackFailed: true,
    });
    expect(failed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'migration-failed' }),
      ]),
    );

    // The setting is back on, so the next launch makes no copy.
    reads = 0;
    const next = setup({ store, createBridge: () => bridge, reenableSetting });
    next.controller.startRecordProbe();
    await expect(next.controller.prepare(true)).resolves.toBe('scheme');
    expect(reads).toBe(0);
    expect(store.record?.pendingMigration).toBeUndefined();
    expect(next.disableSetting).not.toHaveBeenCalled();
  });

  it('bounds a copy back that never finishes, so the first window is not held', async () => {
    jest.useFakeTimers();
    try {
      const store = new Store();
      const bridge = new Bridge();
      store.record = { version: 1, lastUsedOrigin: 'scheme', migrations: [] };
      let aborted = false;
      bridge.read = (): Promise<OriginStorageSnapshot> =>
        new Promise<OriginStorageSnapshot>(() => undefined);
      bridge.abort = (): void => {
        aborted = true;
      };
      const harness = setup({ store, createBridge: () => bridge });
      harness.controller.startRecordProbe();
      let origin: RendererOrigin | null = null;
      void harness.controller.prepare(false).then((value) => {
        origin = value;
      });

      await jest.advanceTimersByTimeAsync(10_000);
      expect(origin).toBe('scheme');
      expect(aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
