import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RENDERER_ORIGIN_RECORD_FILE,
  createFileRendererOriginRecordStore,
  fallBackToFileOrigin,
  migrateOriginStorage,
  normalizeRendererOriginRecord,
  prepareRendererLaunchOrigin,
  type OriginStorageBridge,
  type OriginStorageChanges,
  type OriginStorageSnapshot,
  type RendererOrigin,
  type RendererOriginRecord,
  type RendererOriginRecordStore,
} from '../renderer-origin-migration';

/**
 * Origin-keyed storage migration between `file://` and the renderer scheme.
 * The fake bridge models each origin's localStorage the way Chromium keeps
 * it: one string map per origin that only that origin's documents can read.
 */

interface FakeBridgeOptions {
  failRead?: RendererOrigin;
  /** Throw after this many keys were written to the target, by a replace or an update. */
  failWriteAfter?: number;
  failFlush?: boolean;
  /** The target reads back different contents than were written. */
  corruptReadBack?: boolean;
  /** Only the first read after a replace differs: the write did not stick. */
  corruptReadBackOnce?: boolean;
}

class FakeBridge implements OriginStorageBridge {
  readonly storage: Record<RendererOrigin, Map<string, string>> = {
    file: new Map(),
    scheme: new Map(),
  };
  indexedDbNames: Record<RendererOrigin, string[]> = { file: [], scheme: [] };
  readonly calls: string[] = [];
  options: FakeBridgeOptions = {};
  aborted = false;
  private replaced = false;

  read(origin: RendererOrigin): Promise<OriginStorageSnapshot> {
    this.calls.push(`read:${origin}`);
    if (this.options.failRead === origin) {
      return Promise.reject(new Error(`cannot read ${origin}`));
    }
    const entries = [...this.storage[origin].entries()];
    const corrupt =
      this.options.corruptReadBack === true ||
      (this.options.corruptReadBackOnce === true && this.replaced);
    this.replaced = false;
    return Promise.resolve({
      localStorage: corrupt
        ? entries.map(([key, value]) => [key, `${value}!`])
        : entries,
      indexedDbNames: [...this.indexedDbNames[origin]],
    });
  }

  replace(
    origin: RendererOrigin,
    entries: ReadonlyArray<readonly [string, string]>,
  ): Promise<void> {
    this.calls.push(`replace:${origin}`);
    this.replaced = true;
    const target = this.storage[origin];
    target.clear();
    let written = 0;
    for (const [key, value] of entries) {
      if (
        this.options.failWriteAfter !== undefined &&
        written >= this.options.failWriteAfter
      ) {
        return Promise.reject(new Error('interrupted copy'));
      }
      target.set(key, value);
      written += 1;
    }
    return Promise.resolve();
  }

  /** Stops partway without putting anything back, like a renderer that died. */
  update(origin: RendererOrigin, changes: OriginStorageChanges): Promise<void> {
    this.calls.push(`update:${origin}`);
    this.replaced = true;
    const target = this.storage[origin];
    const writes: Array<() => void> = [
      ...changes.remove.map((key) => (): void => {
        target.delete(key);
      }),
      ...changes.set.map(([key, value]) => (): void => {
        target.set(key, value);
      }),
    ];
    let written = 0;
    for (const write of writes) {
      if (
        this.options.failWriteAfter !== undefined &&
        written >= this.options.failWriteAfter
      ) {
        return Promise.reject(new Error('interrupted copy'));
      }
      write();
      written += 1;
    }
    return Promise.resolve();
  }

  flush(): Promise<void> {
    this.calls.push('flush');
    return this.options.failFlush
      ? Promise.reject(new Error('flush failed'))
      : Promise.resolve();
  }

  abort(): void {
    this.aborted = true;
  }

  set(origin: RendererOrigin, values: Record<string, string>): void {
    this.storage[origin] = new Map(Object.entries(values));
  }

  values(origin: RendererOrigin): Record<string, string> {
    return Object.fromEntries(this.storage[origin]);
  }
}

class MemoryStore implements RendererOriginRecordStore {
  record: RendererOriginRecord | null = null;
  reads = 0;
  writes: RendererOriginRecord[] = [];
  failWrite = false;

  read(): Promise<RendererOriginRecord | null> {
    this.reads += 1;
    return Promise.resolve(this.record);
  }

  write(record: RendererOriginRecord): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error('disk full'));
    this.writes.push(record);
    this.record = record;
    return Promise.resolve();
  }
}

const now = (): Date => new Date('2026-10-02T12:00:00.000Z');

/** Every store the renderer keeps in origin-keyed storage, by key shape. */
const RENDERER_STORAGE_FIXTURE: Record<string, string> = {
  'canopy-calendar-preferences': '{"view":"week"}',
  'code-review-layout': '{"split":0.4}',
  'plan-explore-layout': '{"panel":320}',
  'shared-pipeline-cache:v1': '[]',
  'diff-stats-runtime': '{"enabled":true}',
  'sidebar:collapsed-sections': '["chats"]',
  'model-picker:recent': '["gpt"]',
  ph_phc_test_posthog: '{"distinct_id":"anon"}',
  'canopy-file-comments': '{"state":{}}',
  'terminal-settings': '{"fontSize":13}',
};

async function prepare(
  schemeEnabled: boolean,
  bridge: FakeBridge,
  store: MemoryStore,
): ReturnType<typeof prepareRendererLaunchOrigin> {
  return prepareRendererLaunchOrigin({
    schemeEnabled,
    record: await store.read(),
    store,
    createBridge: () => bridge,
    registerHandler: jest.fn(),
    now,
  });
}

/** The record after a fallback's copy back failed: file:// runs degraded. */
function degradedRecord(
  mergeBase: Array<[string, string]>,
): RendererOriginRecord {
  return {
    version: 1,
    lastUsedOrigin: 'scheme',
    pendingMigration: {
      from: 'scheme',
      to: 'file',
      startedAt: '2026-10-02T00:00:00.000Z',
      mergeBase,
    },
    migrations: [],
  };
}

describe('prepareRendererLaunchOrigin', () => {
  it('does no work at all on the off path of an install that never opted in', async () => {
    const store = new MemoryStore();
    const createBridge = jest.fn<OriginStorageBridge, []>();
    const registerHandler = jest.fn();

    const decision = await prepareRendererLaunchOrigin({
      schemeEnabled: false,
      record: null,
      store,
      createBridge,
      registerHandler,
      now,
    });

    expect(decision.origin).toBe('file');
    expect(decision.disableSetting).toBe(false);
    expect(createBridge).not.toHaveBeenCalled();
    expect(registerHandler).not.toHaveBeenCalled();
    expect(store.writes).toHaveLength(0);
  });

  it('moves every store file → scheme → file with values changed in between', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', RENDERER_STORAGE_FIXTURE);

    const enabled = await prepare(true, bridge, store);
    expect(enabled.origin).toBe('scheme');
    expect(bridge.values('scheme')).toEqual(RENDERER_STORAGE_FIXTURE);
    expect(store.record).toMatchObject({
      lastUsedOrigin: 'scheme',
      migrations: [
        {
          from: 'file',
          to: 'scheme',
          outcome: 'copied',
          keyCount: Object.keys(RENDERER_STORAGE_FIXTURE).length,
        },
      ],
    });
    expect(store.record?.pendingMigration).toBeUndefined();

    // The app runs on the scheme origin and changes, adds and deletes values.
    bridge.storage.scheme.set('code-review-layout', '{"split":0.7}');
    bridge.storage.scheme.set('new-after-enable', 'yes');
    bridge.storage.scheme.delete('terminal-settings');
    const changedOnScheme = bridge.values('scheme');

    const disabled = await prepare(false, bridge, store);
    expect(disabled.origin).toBe('file');
    expect(bridge.values('file')).toEqual(changedOnScheme);
    expect(bridge.values('file')['terminal-settings']).toBeUndefined();
    expect(store.record?.lastUsedOrigin).toBe('file');

    // Back on file:// the app changes values again; enabling mirrors them.
    bridge.storage.file.set('plan-explore-layout', '{"panel":480}');
    const changedOnFile = bridge.values('file');
    const reenabled = await prepare(true, bridge, store);
    expect(reenabled.origin).toBe('scheme');
    expect(bridge.values('scheme')).toEqual(changedOnFile);
    expect(store.record?.migrations.map((entry) => entry.to)).toEqual([
      'scheme',
      'file',
      'scheme',
    ]);
  });

  it('registers the scheme handler before it migrates into the scheme', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    const order: string[] = [];
    bridge.set('file', { a: '1' });
    const originalReplace = bridge.replace.bind(bridge);
    bridge.replace = (origin, entries): Promise<void> => {
      order.push(`replace:${origin}`);
      return originalReplace(origin, entries);
    };

    await prepareRendererLaunchOrigin({
      schemeEnabled: true,
      record: null,
      store,
      createBridge: () => bridge,
      registerHandler: () => order.push('handler'),
      now,
    });

    expect(order).toEqual(['handler', 'replace:scheme']);
  });

  it('is a no-op when the setting has not changed since the last launch', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: '1' });
    await prepare(true, bridge, store);
    bridge.calls.length = 0;
    const writes = store.writes.length;

    const again = await prepare(true, bridge, store);

    expect(again.origin).toBe('scheme');
    expect(again.needsHandler).toBe(true);
    expect(bridge.calls).toEqual([]);
    expect(store.writes).toHaveLength(writes);
  });

  it('finishes an interrupted copy on the next launch and leaves no partial keys', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', RENDERER_STORAGE_FIXTURE);
    bridge.set('scheme', { stale: 'from an earlier stint' });
    bridge.options.failWriteAfter = 3;

    const interrupted = await prepare(true, bridge, store);

    // The launch stays on the origin whose storage is still authoritative.
    expect(interrupted.origin).toBe('file');
    expect(interrupted.disableSetting).toBe(true);
    expect(interrupted.migrationError).toBeInstanceOf(Error);
    expect(store.record).toMatchObject({
      lastUsedOrigin: 'file',
      pendingMigration: { from: 'file', to: 'scheme' },
    });
    expect(bridge.values('file')).toEqual(RENDERER_STORAGE_FIXTURE);

    bridge.options = {};
    const resumed = await prepare(true, bridge, store);
    expect(resumed.origin).toBe('scheme');
    expect(bridge.values('scheme')).toEqual(RENDERER_STORAGE_FIXTURE);
    expect(store.record?.pendingMigration).toBeUndefined();
  });

  it('drops a stale pending copy when the setting went back off before it finished', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: '1' });
    bridge.options.failWriteAfter = 0;
    await prepare(true, bridge, store);
    bridge.options = {};
    bridge.calls.length = 0;

    const off = await prepare(false, bridge, store);

    expect(off.origin).toBe('file');
    expect(bridge.calls).toEqual([]);
    expect(store.record?.pendingMigration).toBeUndefined();
    expect(store.record?.lastUsedOrigin).toBe('file');
    expect(bridge.values('file')).toEqual({ a: '1' });
  });

  it('never clears the target when the source origin is empty', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('scheme', { kept: 'value' });

    const decision = await prepare(true, bridge, store);

    expect(decision.origin).toBe('scheme');
    expect(bridge.values('scheme')).toEqual({ kept: 'value' });
    expect(bridge.calls).not.toContain('replace:scheme');
    expect(store.record?.migrations.at(-1)).toMatchObject({
      outcome: 'empty-source',
      keyCount: 0,
    });
    expect(store.record?.lastUsedOrigin).toBe('scheme');
  });

  it('refuses to record a copy whose target does not read back identically', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: '1' });
    bridge.options.corruptReadBack = true;

    const decision = await prepare(true, bridge, store);

    expect(decision.origin).toBe('file');
    expect(store.record?.lastUsedOrigin).toBe('file');
  });

  it('does not record completion until storage was flushed to disk', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: '1' });
    bridge.options.failFlush = true;

    const decision = await prepare(true, bridge, store);

    expect(decision.origin).toBe('file');
    expect(store.record?.lastUsedOrigin).toBe('file');
    expect(store.record?.pendingMigration).toEqual(
      expect.objectContaining({ from: 'file', to: 'scheme' }),
    );
  });

  it('keeps the scheme when the copy back fails and asks for the setting back on', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: '1' });
    await prepare(true, bridge, store);
    bridge.storage.scheme.set('a', '2');
    bridge.options.failRead = 'scheme';

    const failed = await prepare(false, bridge, store);
    expect(failed.origin).toBe('scheme');
    expect(failed.needsHandler).toBe(true);
    expect(failed.disableSetting).toBe(false);
    expect(failed.reenableSetting).toBe(true);
    expect(store.record?.lastUsedOrigin).toBe('scheme');
    expect(bridge.values('file')).toEqual({ a: '1' });

    // The setting is back on: no copy, and the abandoned copy is dropped.
    bridge.calls.length = 0;
    const held = await prepare(true, bridge, store);
    expect(held.origin).toBe('scheme');
    expect(held.disableSetting).toBe(false);
    expect(held.reenableSetting).toBe(false);
    expect(bridge.calls).toEqual([]);
    expect(store.record?.pendingMigration).toBeUndefined();

    // The user turns it off again: the copy back is retried.
    bridge.options = {};
    const retried = await prepare(false, bridge, store);
    expect(retried.origin).toBe('file');
    expect(bridge.values('file')).toEqual({ a: '2' });
  });

  it("keeps the scheme's other keys and runs on file:// again when a fold stops partway", async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    const mergeBase: Array<[string, string]> = [
      ['changed', 'before the degraded launch'],
      ['deleted', 'before the degraded launch'],
    ];
    store.record = degradedRecord(mergeBase);
    bridge.set('scheme', {
      changed: 'on the scheme',
      schemeOnly: 'on the scheme',
      deleted: 'on the scheme',
    });
    // The degraded launch changed one key, added one and deleted one.
    bridge.set('file', {
      changed: 'written by the degraded launch',
      fileOnly: 'written by the degraded launch',
    });
    // The user turned the setting back on; the fold stops after one write.
    bridge.options.failWriteAfter = 1;

    const failed = await prepare(true, bridge, store);

    expect(failed.origin).toBe('file');
    expect(failed.disableSetting).toBe(true);
    expect(failed.migrationError).toBeInstanceOf(Error);
    expect(bridge.values('scheme')).toEqual(
      expect.objectContaining({
        changed: 'on the scheme',
        schemeOnly: 'on the scheme',
      }),
    );
    expect(bridge.values('file')).toEqual({
      changed: 'written by the degraded launch',
      fileOnly: 'written by the degraded launch',
    });
    expect(store.record).toMatchObject({
      lastUsedOrigin: 'scheme',
      pendingMigration: { from: 'scheme', to: 'file', mergeBase },
    });

    // The setting is now off, so the next launch copies the scheme's storage
    // back and keeps what the degraded launch wrote.
    bridge.options = {};
    const next = await prepare(false, bridge, store);

    expect(next.origin).toBe('file');
    expect(bridge.values('file')).toEqual({
      changed: 'written by the degraded launch',
      schemeOnly: 'on the scheme',
      fileOnly: 'written by the degraded launch',
    });
    expect(store.record?.lastUsedOrigin).toBe('file');
    expect(store.record?.pendingMigration).toBeUndefined();
  });

  it("runs on file:// again instead of the scheme when a degraded launch's copy back fails", async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    const mergeBase: Array<[string, string]> = [['a', 'old']];
    store.record = degradedRecord(mergeBase);
    bridge.set('scheme', {
      a: 'newer on the scheme',
      b: 'on the scheme',
      c: 'on the scheme',
    });
    bridge.set('file', { a: 'old', d: 'written by the degraded launch' });
    // The copy back stops after one of its three writes.
    bridge.options.failWriteAfter = 1;

    const failed = await prepare(false, bridge, store);

    expect(failed.origin).toBe('file');
    expect(failed.reenableSetting).toBe(false);
    expect(failed.disableSetting).toBe(true);
    expect(bridge.values('file')).toEqual(
      expect.objectContaining({ d: 'written by the degraded launch' }),
    );
    expect(store.record).toMatchObject({
      lastUsedOrigin: 'scheme',
      pendingMigration: { from: 'scheme', to: 'file', mergeBase },
    });

    // Another degraded launch writes to file://; the next launch completes
    // the copy with both launches' writes.
    bridge.options = {};
    bridge.storage.file.set('e', 'written by the second degraded launch');
    const next = await prepare(false, bridge, store);

    expect(next.origin).toBe('file');
    expect(bridge.values('file')).toEqual({
      a: 'newer on the scheme',
      b: 'on the scheme',
      c: 'on the scheme',
      d: 'written by the degraded launch',
      e: 'written by the second degraded launch',
    });
    expect(store.record?.lastUsedOrigin).toBe('file');
  });

  it("makes file:// authoritative when a degraded launch's copy back cannot read the scheme", async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    store.record = degradedRecord([['a', 'old']]);
    bridge.set('scheme', { a: 'newer on the scheme' });
    bridge.set('file', { a: 'old', d: 'written by the degraded launch' });
    bridge.options.failRead = 'scheme';

    const decision = await prepare(false, bridge, store);

    expect(decision.origin).toBe('file');
    expect(decision.reenableSetting).toBe(false);
    expect(bridge.values('file')).toEqual({
      a: 'old',
      d: 'written by the degraded launch',
    });
    expect(store.record?.lastUsedOrigin).toBe('file');
    expect(store.record?.pendingMigration).toBeUndefined();
    expect(store.record?.migrations.at(-1)).toMatchObject({
      from: 'scheme',
      to: 'file',
      outcome: 'abandoned',
    });
  });

  it('bounds a copy that never finishes and stops the bridge', async () => {
    jest.useFakeTimers();
    try {
      const bridge = new FakeBridge();
      const store = new MemoryStore();
      store.record = { version: 1, lastUsedOrigin: 'scheme', migrations: [] };
      bridge.read = (): Promise<OriginStorageSnapshot> =>
        new Promise<OriginStorageSnapshot>(() => undefined);
      let decision: Awaited<ReturnType<typeof prepare>> | null = null;
      void prepare(false, bridge, store).then((value) => {
        decision = value;
      });

      await jest.advanceTimersByTimeAsync(10_000);

      expect(decision).toMatchObject({
        origin: 'scheme',
        reenableSetting: true,
      });
      expect(bridge.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('makes file:// authoritative when the handler cannot be registered while the scheme holds the data', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    store.record = { version: 1, lastUsedOrigin: 'scheme', migrations: [] };
    bridge.set('scheme', { a: 'scheme value' });
    bridge.set('file', { a: 'old file value' });

    const decision = await prepareRendererLaunchOrigin({
      schemeEnabled: true,
      record: await store.read(),
      store,
      createBridge: () => bridge,
      registerHandler: () => {
        throw new Error('scheme already handled');
      },
      now,
    });

    expect(decision.origin).toBe('file');
    expect(decision.disableSetting).toBe(true);
    expect(decision.migrationError).toBeInstanceOf(Error);
    expect(store.record).toMatchObject({
      lastUsedOrigin: 'file',
      lastFallback: { reason: 'handler-error' },
    });
    expect(store.record?.migrations.at(-1)).toMatchObject({
      from: 'scheme',
      to: 'file',
      outcome: 'abandoned',
    });
    expect(bridge.values('scheme')).toEqual({ a: 'scheme value' });

    // Writes made on file:// during that launch survive the next one.
    bridge.set('file', { a: 'written on file:// this launch' });
    bridge.calls.length = 0;
    const next = await prepare(false, bridge, store);
    expect(next.origin).toBe('file');
    expect(bridge.calls).toEqual([]);
    expect(bridge.values('file')).toEqual({
      a: 'written on file:// this launch',
    });
  });

  it('reports IndexedDB databases it found but cannot move', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: '1' });
    bridge.indexedDbNames.file = ['unexpected-db'];

    const decision = await prepare(true, bridge, store);

    expect(decision.migration?.indexedDbNames).toEqual(['unexpected-db']);
  });

  it('migrates even when the record cannot be written, but never loads the target', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: '1' });
    store.failWrite = true;

    const decision = await prepare(true, bridge, store);

    expect(decision.origin).toBe('file');
    expect(decision.disableSetting).toBe(true);
  });
});

describe('fallBackToFileOrigin', () => {
  it('copies the scheme origin back to file:// and records the fallback', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: '1' });
    await prepare(true, bridge, store);
    bridge.storage.scheme.set('a', 'changed while on the scheme');
    bridge.storage.scheme.set('b', 'new');

    const result = await fallBackToFileOrigin({
      record: store.record,
      store,
      bridge,
      reason: 'did-fail-load',
      now,
    });

    expect(result.migrated).toBe(true);
    expect(bridge.values('file')).toEqual({
      a: 'changed while on the scheme',
      b: 'new',
    });
    expect(store.record).toMatchObject({
      lastUsedOrigin: 'file',
      lastFallback: { reason: 'did-fail-load' },
    });
  });

  it('abandons the scheme copy when it cannot be read, leaving it in place', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: '1' });
    await prepare(true, bridge, store);
    bridge.storage.scheme.set('a', '2');
    bridge.options.failRead = 'scheme';

    const result = await fallBackToFileOrigin({
      record: store.record,
      store,
      bridge,
      reason: 'renderer-not-ready',
      now,
    });

    expect(result.migrated).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(bridge.values('scheme')).toEqual({ a: '2' });
    expect(store.record?.lastUsedOrigin).toBe('file');
    expect(store.record?.migrations.at(-1)).toMatchObject({
      from: 'scheme',
      to: 'file',
      outcome: 'abandoned',
    });
  });

  it('bounds a copy back that never finishes and abandons it', async () => {
    jest.useFakeTimers();
    try {
      const bridge = new FakeBridge();
      const store = new MemoryStore();
      store.record = { version: 1, lastUsedOrigin: 'scheme', migrations: [] };
      bridge.read = (): Promise<OriginStorageSnapshot> =>
        new Promise<OriginStorageSnapshot>(() => undefined);
      let migrated: boolean | null = null;
      void fallBackToFileOrigin({
        record: store.record,
        store,
        bridge,
        reason: 'did-fail-load',
        now,
      }).then((result) => {
        migrated = result.migrated;
      });

      await jest.advanceTimersByTimeAsync(10_000);

      expect(migrated).toBe(false);
      expect(bridge.aborted).toBe(true);
      expect(store.record?.lastUsedOrigin).toBe('file');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['cannot be written to file://', { failWriteAfter: 0 }],
    ['does not read back from file://', { corruptReadBackOnce: true }],
    ['cannot be flushed', { failFlush: true }],
  ] as const)(
    'keeps the scheme authoritative when its storage reads but %s, and the next launch completes the copy',
    async (_label, failure) => {
      const bridge = new FakeBridge();
      const store = new MemoryStore();
      bridge.set('file', { a: '1' });
      await prepare(true, bridge, store);
      bridge.storage.scheme.set('a', 'newer on the scheme');
      Object.assign(bridge.options, failure);

      const result = await fallBackToFileOrigin({
        record: store.record,
        store,
        bridge,
        reason: 'did-fail-load',
        now,
      });

      expect(result.migrated).toBe(false);
      expect(result.schemeRetained).toBe(true);
      expect(bridge.values('scheme')).toEqual({ a: 'newer on the scheme' });
      expect(store.record).toMatchObject({
        lastUsedOrigin: 'scheme',
        pendingMigration: { from: 'scheme', to: 'file' },
        lastFallback: { reason: 'did-fail-load' },
      });
      expect(
        store.record?.migrations.some(
          (migration) => migration.outcome === 'abandoned',
        ),
      ).toBe(false);

      // The next launch runs with the setting off: it retries the copy
      // before loading file://, so nothing written on the scheme is lost.
      bridge.options = {};
      const next = await prepare(false, bridge, store);
      expect(next.origin).toBe('file');
      expect(bridge.values('file')).toEqual({ a: 'newer on the scheme' });
      expect(store.record?.lastUsedOrigin).toBe('file');
    },
  );

  it('keeps what a degraded launch writes to file:// when the next launch completes the copy', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: 'old' });
    await prepare(true, bridge, store);
    bridge.set('scheme', {
      kept: 'newer on the scheme',
      changed: 'newer on the scheme',
    });
    // The copy back clears file:// and then fails, so the degraded launch
    // starts from an empty store.
    bridge.options.failWriteAfter = 0;

    const result = await fallBackToFileOrigin({
      record: store.record,
      store,
      bridge,
      createBridge: () => bridge,
      reason: 'did-fail-load',
      now,
    });
    expect(result.schemeRetained).toBe(true);
    expect(store.record?.pendingMigration?.mergeBase).toEqual([]);

    bridge.options = {};
    bridge.storage.file.set('changed', 'written by the degraded launch');
    bridge.storage.file.set('fileOnly', 'written by the degraded launch');

    await prepare(false, bridge, store);

    expect(bridge.values('file')).toEqual({
      kept: 'newer on the scheme',
      changed: 'written by the degraded launch',
      fileOnly: 'written by the degraded launch',
    });
    expect(store.record?.lastUsedOrigin).toBe('file');
    expect(store.record?.pendingMigration).toBeUndefined();
  });

  it('keeps a key the degraded launch deleted deleted', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: 'old' });
    await prepare(true, bridge, store);
    bridge.set('scheme', { kept: 'on the scheme', deleted: 'on the scheme' });
    // The copy lands but cannot be flushed, so file:// holds the scheme's
    // values when the degraded launch starts.
    bridge.options.failFlush = true;

    await fallBackToFileOrigin({
      record: store.record,
      store,
      bridge,
      createBridge: () => bridge,
      reason: 'did-fail-load',
      now,
    });
    expect(store.record?.pendingMigration?.mergeBase).toEqual([
      ['kept', 'on the scheme'],
      ['deleted', 'on the scheme'],
    ]);

    bridge.options = {};
    bridge.storage.file.delete('deleted');

    await prepare(false, bridge, store);

    expect(bridge.values('file')).toEqual({ kept: 'on the scheme' });
  });

  it('folds what a degraded launch wrote into the scheme when the setting is turned back on', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: 'old' });
    await prepare(true, bridge, store);
    bridge.set('scheme', { kept: 'on the scheme', changed: 'on the scheme' });
    bridge.options.failWriteAfter = 0;
    await fallBackToFileOrigin({
      record: store.record,
      store,
      bridge,
      createBridge: () => bridge,
      reason: 'did-fail-load',
      now,
    });

    // The degraded launch writes to file://, and the user turns the setting
    // back on.
    bridge.options = {};
    bridge.storage.file.set('changed', 'written by the degraded launch');
    bridge.storage.file.set('fileOnly', 'written by the degraded launch');

    const next = await prepare(true, bridge, store);

    expect(next.origin).toBe('scheme');
    expect(bridge.values('scheme')).toEqual({
      kept: 'on the scheme',
      changed: 'written by the degraded launch',
      fileOnly: 'written by the degraded launch',
    });
    expect(store.record?.lastUsedOrigin).toBe('scheme');
    expect(store.record?.pendingMigration).toBeUndefined();
  });

  it("keeps both degraded launches' writes when a second fallback also fails to copy back", async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    bridge.set('file', { a: 'old' });
    await prepare(true, bridge, store);
    bridge.set('scheme', { kept: 'on the scheme' });
    bridge.options.failWriteAfter = 0;
    await fallBackToFileOrigin({
      record: store.record,
      store,
      bridge,
      createBridge: () => bridge,
      reason: 'did-fail-load',
      now,
    });
    // The first degraded launch writes to file://.
    bridge.options = {};
    bridge.storage.file.set('first', 'written by the first degraded launch');

    // The setting goes back on, the scheme fails to load again, and the copy
    // back fails again after reading both origins.
    bridge.options.failWriteAfter = 0;
    await fallBackToFileOrigin({
      record: store.record,
      store,
      bridge,
      createBridge: () => bridge,
      reason: 'did-fail-load',
      now,
    });
    // The failed copy left file:// as the first degraded launch had it.
    expect(bridge.values('file')).toEqual({
      first: 'written by the first degraded launch',
    });
    bridge.options = {};
    bridge.storage.file.set('second', 'written by the second degraded launch');

    await prepare(false, bridge, store);

    expect(bridge.values('file')).toEqual({
      kept: 'on the scheme',
      first: 'written by the first degraded launch',
      second: 'written by the second degraded launch',
    });
  });

  it('keeps the merge base across a retry that fails again', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    store.record = {
      version: 1,
      lastUsedOrigin: 'scheme',
      pendingMigration: {
        from: 'scheme',
        to: 'file',
        startedAt: '2026-10-02T00:00:00.000Z',
        mergeBase: [['a', 'old']],
      },
      migrations: [],
    };
    bridge.set('scheme', { a: 'newer' });
    bridge.set('file', { a: 'old' });
    bridge.options.failWriteAfter = 0;

    await prepare(false, bridge, store);

    expect(store.record?.pendingMigration?.mergeBase).toEqual([['a', 'old']]);
  });

  it('keeps the scheme authoritative when a copy back that read it never finishes writing', async () => {
    jest.useFakeTimers();
    try {
      const bridge = new FakeBridge();
      const store = new MemoryStore();
      store.record = { version: 1, lastUsedOrigin: 'scheme', migrations: [] };
      bridge.storage.scheme.set('a', 'on the scheme');
      bridge.replace = (): Promise<void> => new Promise<void>(() => undefined);
      let retained: boolean | undefined;
      void fallBackToFileOrigin({
        record: store.record,
        store,
        bridge,
        reason: 'did-fail-load',
        now,
      }).then((result) => {
        retained = result.schemeRetained;
      });

      await jest.advanceTimersByTimeAsync(10_000);

      expect(retained).toBe(true);
      expect(bridge.aborted).toBe(true);
      expect(store.record?.lastUsedOrigin).toBe('scheme');
      expect(store.record?.pendingMigration).toMatchObject({
        from: 'scheme',
        to: 'file',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('needs no copy when file:// is already authoritative', async () => {
    const bridge = new FakeBridge();
    const store = new MemoryStore();

    const result = await fallBackToFileOrigin({
      record: null,
      store,
      bridge,
      reason: 'handler-error',
      now,
    });

    expect(result.migrated).toBe(false);
    expect(bridge.calls).toEqual([]);
    expect(store.record?.lastFallback?.reason).toBe('handler-error');
  });
});

describe('migrateOriginStorage', () => {
  it('rejects copying an origin onto itself', async () => {
    await expect(
      migrateOriginStorage({
        from: 'file',
        to: 'file',
        bridge: new FakeBridge(),
        store: new MemoryStore(),
        record: null,
        now,
      }),
    ).rejects.toThrow();
  });
});

describe('the renderer origin record', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'renderer-origin-record-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips through the per-installation file atomically', async () => {
    const filePath = join(dir, 'nested', RENDERER_ORIGIN_RECORD_FILE);
    const store = createFileRendererOriginRecordStore(filePath);
    expect(await store.read()).toBeNull();
    const record: RendererOriginRecord = {
      version: 1,
      lastUsedOrigin: 'scheme',
      migrations: [
        {
          from: 'file',
          to: 'scheme',
          completedAt: now().toISOString(),
          outcome: 'copied',
          keyCount: 2,
        },
      ],
    };
    await store.write(record);
    expect(await store.read()).toEqual(record);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(record);
  });

  it('treats an unreadable or foreign record as absent', async () => {
    const filePath = join(dir, RENDERER_ORIGIN_RECORD_FILE);
    writeFileSync(filePath, '{not json');
    expect(await createFileRendererOriginRecordStore(filePath).read()).toBe(
      null,
    );
    for (const value of [
      null,
      [],
      { version: 2, lastUsedOrigin: 'file', migrations: [] },
      { version: 1, lastUsedOrigin: 'http', migrations: [] },
      { version: 1, lastUsedOrigin: 'file', migrations: 'x' },
    ]) {
      expect(normalizeRendererOriginRecord(value)).toBeNull();
    }
  });

  it('caps the migration history', () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      from: 'file',
      to: 'scheme',
      completedAt: `2026-10-02T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      outcome: 'copied',
      keyCount: index,
    }));
    const record = normalizeRendererOriginRecord({
      version: 1,
      lastUsedOrigin: 'file',
      migrations: entries,
    });
    expect(record?.migrations.length).toBeLessThanOrEqual(20);
    expect(record?.migrations.at(-1)?.keyCount).toBe(49);
  });

  it('keeps a well-formed merge base on a pending copy and drops a malformed one', () => {
    const pending = {
      from: 'scheme',
      to: 'file',
      startedAt: '2026-10-02T00:00:00.000Z',
    };
    expect(
      normalizeRendererOriginRecord({
        version: 1,
        lastUsedOrigin: 'scheme',
        migrations: [],
        pendingMigration: { ...pending, mergeBase: [['a', '1']] },
      })?.pendingMigration?.mergeBase,
    ).toEqual([['a', '1']]);
    for (const mergeBase of [[['a']], [['a', 1]], 'a', [{ a: '1' }]]) {
      const record = normalizeRendererOriginRecord({
        version: 1,
        lastUsedOrigin: 'scheme',
        migrations: [],
        pendingMigration: { ...pending, mergeBase },
      });
      expect(record?.pendingMigration).toEqual(pending);
    }
  });
});
