import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  READ_ORIGIN_STORAGE_SCRIPT,
  buildReplaceOriginStorageScript,
  buildUpdateOriginStorageScript,
  createOriginStorageBridge,
  parseOriginStorageSnapshot,
  storageBridgePageUrl,
  type BridgeContents,
} from '../origin-storage-bridge';

/**
 * The trusted host adapter that reads and replaces one origin's
 * localStorage from main. Its scripts run inside a sandboxed, preload-free
 * page of that origin; here they run in a VM against a Storage-like fake.
 */

class FakeStorage {
  private readonly map = new Map<string, string>();
  /** The most characters of keys and values it holds, like a quota. */
  quota: number | undefined;
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    const previous = this.map.get(key);
    const size =
      this.size() -
      (previous === undefined ? 0 : key.length + previous.length) +
      key.length +
      value.length;
    if (this.quota !== undefined && size > this.quota) {
      throw new Error('QuotaExceededError');
    }
    this.map.set(String(key), String(value));
  }
  private size(): number {
    let size = 0;
    for (const [key, value] of Array.from(this.map)) {
      size += key.length + value.length;
    }
    return size;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  entries(): Array<[string, string]> {
    return Array.from(this.map.entries());
  }
}

function runInPage(code: string, storage: FakeStorage): Promise<unknown> {
  const result: unknown = runInNewContext(code, {
    localStorage: storage,
    indexedDB: {
      databases: (): Promise<Array<{ name?: string }>> =>
        Promise.resolve([{ name: 'db-one' }, {}]),
    },
    JSON,
  });
  return Promise.resolve(result);
}

const AWKWARD_VALUES: Array<[string, string]> = [
  ['plain', 'value'],
  ['quotes', `"double" and 'single' and \`back\``],
  ['script-close', '</script><script>alert(1)</script>'],
  ['unicode', 'Ünïcödé ✓ 日本語 \u2028\u2029'],
  ['backslashes', 'C:\\Users\\x\\n'],
  ['json', '{"nested":{"a":[1,2,3]}}'],
  ['', 'empty key'],
  ['empty value', ''],
  ['${template}', '${not.evaluated}'],
];

describe('origin storage bridge scripts', () => {
  it('reads every localStorage entry and the IndexedDB database names', async () => {
    const storage = new FakeStorage();
    for (const [key, value] of AWKWARD_VALUES) storage.setItem(key, value);
    const raw = await runInPage(READ_ORIGIN_STORAGE_SCRIPT, storage);
    expect(parseOriginStorageSnapshot(raw)).toEqual({
      localStorage: AWKWARD_VALUES,
      indexedDbNames: ['db-one'],
    });
  });

  it('replaces the whole origin with exactly the given entries', async () => {
    const storage = new FakeStorage();
    storage.setItem('stale', 'should disappear');
    await runInPage(buildReplaceOriginStorageScript(AWKWARD_VALUES), storage);
    expect(storage.entries()).toEqual(AWKWARD_VALUES);
  });

  it('sets and removes only the given keys and leaves every other key', async () => {
    const storage = new FakeStorage();
    storage.setItem('kept', 'as it was');
    storage.setItem('removed', 'should disappear');
    storage.setItem('changed', 'before');
    await runInPage(
      buildUpdateOriginStorageScript({
        set: [['changed', 'after'], ...AWKWARD_VALUES],
        remove: ['removed', 'never there'],
      }),
      storage,
    );
    expect(storage.entries()).toEqual([
      ['kept', 'as it was'],
      ['changed', 'after'],
      ...AWKWARD_VALUES,
    ]);
  });

  it('puts back every key it changed when a write throws partway', async () => {
    const storage = new FakeStorage();
    storage.setItem('kept', 'as it was');
    storage.setItem('removed', 'before');
    storage.setItem('changed', 'before');
    // Room for the first two sets after the removal, not the third.
    storage.quota = 40;
    const update = Promise.resolve().then(() =>
      runInPage(
        buildUpdateOriginStorageScript({
          set: [
            ['changed', 'after'],
            ['added', 'new'],
            ['overflow', 'does not fit'],
          ],
          remove: ['removed'],
        }),
        storage,
      ),
    );
    await expect(update).rejects.toThrow('QuotaExceededError');
    expect(new Map(storage.entries())).toEqual(
      new Map([
        ['kept', 'as it was'],
        ['removed', 'before'],
        ['changed', 'before'],
      ]),
    );
  });

  it('rejects a snapshot that is not the expected shape', () => {
    for (const raw of [
      undefined,
      42,
      '{',
      '{"localStorage":[["a",1]],"indexedDbNames":[]}',
      '{"localStorage":[["a"]],"indexedDbNames":[]}',
      '{"localStorage":{},"indexedDbNames":[]}',
    ]) {
      expect(() => parseOriginStorageSnapshot(raw)).toThrow();
    }
  });
});

describe('storageBridgePageUrl', () => {
  it('uses the bundled page for file:// and the in-memory page for the scheme', () => {
    const rendererDir = join('/app', 'out', 'renderer');
    expect(storageBridgePageUrl('file', rendererDir)).toBe(
      pathToFileURL(join(rendererDir, 'storage-bridge.html')).href,
    );
    expect(storageBridgePageUrl('scheme', rendererDir)).toBe(
      'app-renderer://bundle/storage-bridge.html',
    );
  });
});

describe('createOriginStorageBridge', () => {
  function fakeContents(storage: FakeStorage): BridgeContents & {
    loaded: string[];
    closed: boolean;
    openHandler?: () => { action: 'deny' };
    navigationListener?: (event: { preventDefault: () => void }) => void;
  } {
    const contents = {
      loaded: [] as string[],
      closed: false,
      openHandler: undefined as (() => { action: 'deny' }) | undefined,
      navigationListener: undefined as
        | ((event: { preventDefault: () => void }) => void)
        | undefined,
      loadURL(url: string): Promise<void> {
        contents.loaded.push(url);
        return Promise.resolve();
      },
      executeJavaScript(code: string): Promise<unknown> {
        return runInPage(code, storage);
      },
      setWindowOpenHandler(handler: () => { action: 'deny' }): void {
        contents.openHandler = handler;
      },
      on(
        _event: 'will-navigate',
        listener: (event: { preventDefault: () => void }) => void,
      ): void {
        contents.navigationListener = listener;
      },
      close(): void {
        contents.closed = true;
      },
      isDestroyed(): boolean {
        return contents.closed;
      },
    };
    return contents;
  }

  it('opens one locked-down page per operation and always closes it', async () => {
    const storage = new FakeStorage();
    storage.setItem('k', 'v');
    const created: Array<ReturnType<typeof fakeContents>> = [];
    const flushStorage = jest.fn();
    const bridge = createOriginStorageBridge({
      rendererDir: '/app/out/renderer',
      createContents: () => {
        const contents = fakeContents(storage);
        created.push(contents);
        return contents;
      },
      flushStorage,
    });

    await expect(bridge.read('scheme')).resolves.toEqual({
      localStorage: [['k', 'v']],
      indexedDbNames: ['db-one'],
    });
    await bridge.replace('file', [['n', 'w']]);
    await bridge.flush();

    expect(created).toHaveLength(2);
    expect(created[0]?.loaded).toEqual([
      'app-renderer://bundle/storage-bridge.html',
    ]);
    expect(created[1]?.loaded[0]).toMatch(/^file:\/\/.*storage-bridge\.html$/);
    for (const contents of created) {
      expect(contents.closed).toBe(true);
      expect(contents.openHandler?.()).toEqual({ action: 'deny' });
      const preventDefault = jest.fn();
      contents.navigationListener?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalled();
    }
    expect(storage.entries()).toEqual([['n', 'w']]);
    expect(flushStorage).toHaveBeenCalledTimes(1);
  });

  it('closes the page and rejects when a load times out', async () => {
    jest.useFakeTimers();
    try {
      const storage = new FakeStorage();
      const contents = fakeContents(storage);
      contents.loadURL = (): Promise<void> => new Promise(() => undefined);
      const bridge = createOriginStorageBridge({
        rendererDir: '/app/out/renderer',
        createContents: () => contents,
        flushStorage: jest.fn(),
        timeoutMs: 1_000,
      });
      const read = bridge.read('file');
      const assertion = expect(read).rejects.toThrow(/timed out/i);
      await jest.advanceTimersByTimeAsync(1_001);
      await assertion;
      expect(contents.closed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops for good once aborted: closes the open page, never writes, opens no more', async () => {
    const storage = new FakeStorage();
    storage.setItem('kept', 'value');
    const created: Array<ReturnType<typeof fakeContents>> = [];
    let releaseLoad: () => void = () => undefined;
    const bridge = createOriginStorageBridge({
      rendererDir: '/app/out/renderer',
      createContents: () => {
        const contents = fakeContents(storage);
        contents.loadURL = (url: string): Promise<void> => {
          contents.loaded.push(url);
          return new Promise<void>((resolve) => {
            releaseLoad = resolve;
          });
        };
        created.push(contents);
        return contents;
      },
      flushStorage: jest.fn(),
    });

    const replace = bridge.replace('file', [['n', 'w']]);
    const assertion = expect(replace).rejects.toThrow(/stopped/i);
    await Promise.resolve();
    bridge.abort();
    expect(created[0]?.closed).toBe(true);
    // The page finishes loading after the abort: the script must not run.
    releaseLoad();
    await assertion;
    expect(storage.entries()).toEqual([['kept', 'value']]);

    await expect(bridge.read('file')).rejects.toThrow(/stopped/i);
    expect(created).toHaveLength(1);
  });
});
