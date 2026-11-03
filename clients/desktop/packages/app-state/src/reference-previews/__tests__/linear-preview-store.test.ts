/**
 * @jest-environment jsdom
 */
import type {
  LinearIssuePreview,
  LinearIssuePreviewResult,
  LinearTeamKeysResult,
} from '@canopy/protocol/reference-previews';
import { CLIENT_STORE_DISPOSE } from '../../create-client-store';
import {
  createFakeClient,
  deferred,
} from '../../__tests__/fake-org-projects-client';
import type { ClientStore } from '../../create-client-store';
import {
  createLinearPreviewStore,
  type LinearPreviewStoreState,
  invalidateReferencePreviews,
  LINEAR_PREVIEW_CACHE_LIMITS as LIMITS,
  LINEAR_VISIBILITY_QUEUE_LIMITS as QUEUE,
  REFERENCE_PREVIEW_RESET_KEY,
  REFERENCE_PREVIEW_STORAGE_KEY,
  setReferenceEnrichmentModes,
} from '../linear-preview-store';

function disposePreviewStore<State>(store: ClientStore<State>): void {
  const disposer = store[CLIENT_STORE_DISPOSE];
  if (typeof disposer !== 'function') {
    throw new Error('Expected reference preview store to provide a disposer.');
  }
  disposer.call(store);
}

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  failWrites = false;
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.values.set(key, value);
  }
}

function preview(identifier: string, title = 'Title'): LinearIssuePreview {
  return {
    identifier,
    title,
    url: `https://linear.app/acme/issue/${identifier}`,
    description: null,
    status: 'Todo',
    assignee: null,
    project: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

type Respond = (identifier: string) => Promise<LinearIssuePreviewResult>;
type RespondTeams = () => Promise<LinearTeamKeysResult>;
type RespondScope = () => Promise<{ scope: string | null }>;

interface Harness {
  storage: MemoryStorage;
  reads: string[];
  make: () => ClientStore<LinearPreviewStoreState>;
  store: ClientStore<LinearPreviewStoreState>;
  advance: (ms: number) => void;
  setScope: (next: string | null) => void;
  respondWith: (fn: Respond) => void;
  teamReads: () => number;
  scopeReads: () => number;
  respondTeamsWith: (fn: RespondTeams) => void;
  respondScopeWith: (fn: RespondScope) => void;
  now: () => number;
}

function setup(storage = new MemoryStorage()): Harness {
  let now = 1_000_000;
  let scope: string | null = 'scope-a';
  const fake = createFakeClient();
  const reads: string[] = [];
  let teamReads = 0;
  let scopeReads = 0;
  let respondTeams: RespondTeams = () =>
    scope === null
      ? Promise.resolve({ status: 'disconnected' })
      : Promise.resolve({
          status: 'ok',
          scope,
          keys: ['CAN', 'ECW'],
          fetchedAt: now,
        });
  let respond: Respond = (identifier) =>
    Promise.resolve({
      status: 'ok',
      scope: scope ?? '',
      preview: preview(identifier),
    });
  let respondScope: RespondScope = () => Promise.resolve({ scope });
  fake.query.mockImplementation(
    (name: string, args: { identifier: string }) => {
      if (name === 'referencePreview.linearScope') {
        scopeReads += 1;
        return respondScope();
      }
      if (name === 'referencePreview.linearTeams') {
        teamReads += 1;
        return respondTeams();
      }
      reads.push(args.identifier);
      return respond(args.identifier);
    },
  );
  const make = (): ClientStore<LinearPreviewStoreState> =>
    createLinearPreviewStore(fake.client, {
      now: () => now,
      storage: () => storage,
    });
  return {
    storage,
    reads,
    make,
    store: make(),
    advance: (ms: number): void => {
      now += ms;
    },
    setScope: (next: string | null): void => {
      scope = next;
    },
    respondWith: (fn: Respond): void => {
      respond = fn;
    },
    teamReads: () => teamReads,
    scopeReads: () => scopeReads,
    respondTeamsWith: (fn: RespondTeams): void => {
      respondTeams = fn;
    },
    respondScopeWith: (fn: RespondScope): void => {
      respondScope = fn;
    },
    now: () => now,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('reference enrichment modes', () => {
  afterEach(() => {
    setReferenceEnrichmentModes({ linear: 'replace', github: 'replace' });
  });
  it('resumes the catalog cooldown after Off without reading early', async () => {
    const t = setup();
    t.respondTeamsWith(() =>
      Promise.resolve({ status: 'failed', scope: 'scope-a' }),
    );
    t.store.getState().ensureTeamCatalog();
    await flush();
    setReferenceEnrichmentModes({ linear: 'off', github: 'replace' });
    t.advance(100);
    await jest.advanceTimersByTimeAsync(100);
    setReferenceEnrichmentModes({ linear: 'hover', github: 'replace' });
    t.store.getState().ensureTeamCatalog();
    expect(t.teamReads()).toBe(1);
    t.advance(LIMITS.negativeMs - 100);
    await jest.advanceTimersByTimeAsync(LIMITS.negativeMs - 100);
    expect(t.store.getState().teamCatalog.status).toBe('idle');
    t.store.getState().ensureTeamCatalog();
    await flush();
    expect(t.teamReads()).toBe(2);
    disposePreviewStore(t.store);
  });

  it('blocks every Linear read while Off and resumes without evicting a warm cache', async () => {
    const t = setup();
    expect(await t.store.getState().load({ identifier: 'CAN-1' })).toEqual(
      preview('CAN-1'),
    );
    setReferenceEnrichmentModes({ linear: 'off', github: 'replace' });
    t.store.getState().ensureTeamCatalog();
    const release = t.store.getState().watch({ identifier: 'CAN-2' });
    expect(await t.store.getState().load({ identifier: 'CAN-2' })).toBeNull();
    await jest.advanceTimersByTimeAsync(QUEUE.debounceMs + LIMITS.negativeMs);
    expect(t.reads).toEqual(['CAN-1']);
    expect(t.teamReads()).toBe(0);
    expect(t.scopeReads()).toBe(1);
    release();
    setReferenceEnrichmentModes({ linear: 'hover', github: 'replace' });
    expect(await t.store.getState().load({ identifier: 'CAN-1' })).toEqual(
      preview('CAN-1'),
    );
    expect(t.reads).toEqual(['CAN-1']);
    disposePreviewStore(t.store);
  });

  it('drops queued passive reads when leaving Replace, but Hover can demand-load', async () => {
    const t = setup();
    const release = t.store.getState().watch({ identifier: 'CAN-3' });
    setReferenceEnrichmentModes({ linear: 'hover', github: 'replace' });
    await jest.advanceTimersByTimeAsync(QUEUE.debounceMs + 1);
    expect(t.reads).toEqual([]);
    expect(await t.store.getState().load({ identifier: 'CAN-3' })).toEqual(
      preview('CAN-3'),
    );
    expect(t.reads).toEqual(['CAN-3']);
    release();
    disposePreviewStore(t.store);
  });

  it('does not promote a pending passive read after in-flight slots settle in Hover', async () => {
    const t = setup();
    const first = deferred<LinearIssuePreviewResult>();
    const second = deferred<LinearIssuePreviewResult>();
    t.respondWith((identifier) =>
      identifier === 'CAN-1' ? first.promise : second.promise,
    );
    const releases = [1, 2, 3].map((number) =>
      t.store.getState().watch({ identifier: `CAN-${number}` }),
    );
    await jest.advanceTimersByTimeAsync(QUEUE.debounceMs);
    expect(t.reads).toEqual(['CAN-1', 'CAN-2']);
    setReferenceEnrichmentModes({ linear: 'hover', github: 'replace' });
    first.resolve({
      status: 'ok',
      scope: 'scope-a',
      preview: preview('CAN-1'),
    });
    second.resolve({
      status: 'ok',
      scope: 'scope-a',
      preview: preview('CAN-2'),
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(t.reads).toEqual(['CAN-1', 'CAN-2']);
    releases.forEach((release) => release());
    disposePreviewStore(t.store);
  });

  it('holds in-flight passive slots across Off and Replace before admitting resumed work', async () => {
    const t = setup();
    const first = deferred<LinearIssuePreviewResult>();
    const second = deferred<LinearIssuePreviewResult>();
    t.respondWith((identifier) =>
      identifier === 'CAN-1' ? first.promise : second.promise,
    );
    const releaseFirst = t.store.getState().watch({ identifier: 'CAN-1' });
    const releaseSecond = t.store.getState().watch({ identifier: 'CAN-2' });
    await jest.advanceTimersByTimeAsync(QUEUE.debounceMs);
    expect(t.reads).toEqual(['CAN-1', 'CAN-2']);

    setReferenceEnrichmentModes({ linear: 'off', github: 'replace' });
    setReferenceEnrichmentModes({ linear: 'replace', github: 'replace' });
    const releaseThird = t.store.getState().watch({ identifier: 'CAN-3' });
    await jest.advanceTimersByTimeAsync(QUEUE.debounceMs);
    expect(t.reads).toEqual(['CAN-1', 'CAN-2']);

    first.resolve({
      status: 'ok',
      scope: 'scope-a',
      preview: preview('CAN-1'),
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(t.reads).toEqual(['CAN-1', 'CAN-2', 'CAN-3']);
    second.resolve({
      status: 'ok',
      scope: 'scope-a',
      preview: preview('CAN-2'),
    });
    await jest.advanceTimersByTimeAsync(0);
    releaseFirst();
    releaseSecond();
    releaseThird();
    disposePreviewStore(t.store);
  });

  it('fences a late Off result and permits a fresh read after re-enabling', async () => {
    const t = setup();
    const pending = deferred<LinearIssuePreviewResult>();
    t.respondWith(() => pending.promise);
    const read = t.store.getState().load({ identifier: 'CAN-4' });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.reads).toEqual(['CAN-4']);
    setReferenceEnrichmentModes({ linear: 'off', github: 'replace' });
    pending.resolve({
      status: 'ok',
      scope: 'scope-a',
      preview: preview('CAN-4'),
    });
    expect(await read).toBeNull();
    expect(t.store.getState().views['*/CAN-4']?.status).not.toBe('ready');
    setReferenceEnrichmentModes({ linear: 'replace', github: 'replace' });
    expect(await t.store.getState().load({ identifier: 'CAN-4' })).toEqual(
      preview('CAN-4'),
    );
    expect(t.reads).toEqual(['CAN-4', 'CAN-4']);
    disposePreviewStore(t.store);
  });

  it('does not start a provider read when Off interrupts a pending scope check', async () => {
    const t = setup();
    const scope = deferred<{ scope: string | null }>();
    t.respondScopeWith(() => scope.promise);
    const read = t.store.getState().load({ identifier: 'CAN-5' });
    setReferenceEnrichmentModes({ linear: 'off', github: 'replace' });
    scope.resolve({ scope: 'scope-a' });
    expect(await read).toBeNull();
    expect(t.reads).toEqual([]);
    disposePreviewStore(t.store);
  });

  it('fences a pending connection and catalog result without scheduling an Off retry', async () => {
    const t = setup();
    const scope = deferred<{ scope: string | null }>();
    t.respondScopeWith(() => scope.promise);
    t.store.getState().ensureTeamCatalog();
    setReferenceEnrichmentModes({ linear: 'off', github: 'replace' });
    scope.resolve({ scope: 'scope-a' });
    await jest.advanceTimersByTimeAsync(LIMITS.negativeMs * 2);
    expect(t.scopeReads()).toBe(1);
    expect(t.store.getState().teamCatalog.status).not.toBe('ready');
    disposePreviewStore(t.store);
  });
});

describe('createLinearPreviewStore', () => {
  it('serves fresh entries without a read and refreshes stale ones once', async () => {
    const t = setup();
    expect(await t.store.getState().load({ identifier: 'CAN-1' })).toEqual(
      preview('CAN-1'),
    );
    await t.store.getState().load({ identifier: 'CAN-1' });
    expect(t.reads).toEqual(['CAN-1']);

    t.advance(LIMITS.freshMs + 1);
    const pending = deferred<LinearIssuePreviewResult>();
    t.respondWith(() => pending.promise);
    const refresh = t.store.getState().load({ identifier: 'CAN-1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.store.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
      refreshing: true,
    });
    pending.resolve({
      status: 'ok',
      scope: 'scope-a',
      preview: preview('CAN-1', 'Renamed'),
    });
    expect((await refresh)?.title).toBe('Renamed');
    expect(t.reads).toEqual(['CAN-1', 'CAN-1']);
  });

  it('coalesces duplicate requests', async () => {
    const t = setup();
    await Promise.all([
      t.store.getState().load({ identifier: 'CAN-2' }),
      t.store.getState().load({ identifier: 'CAN-2' }),
    ]);
    expect(t.reads).toEqual(['CAN-2']);
  });

  it('reuses persisted entries after restart only within the same scope', async () => {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-3' });
    jest.runOnlyPendingTimers();
    expect(t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY)).toContain('CAN-3');

    const restarted = t.make();
    await restarted.getState().load({ identifier: 'CAN-3' });
    expect(t.reads).toEqual(['CAN-3']);

    t.setScope('scope-b');
    await t.make().getState().load({ identifier: 'CAN-3' });
    expect(t.reads).toEqual(['CAN-3', 'CAN-3']);
    jest.runOnlyPendingTimers();
    expect(t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY)).not.toContain(
      'scope-a',
    );
  });

  it('expires entries after the retention window', async () => {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-4' });
    t.advance(LIMITS.retentionMs + 1);
    t.respondWith(() => new Promise(() => undefined));
    void t.store.getState().load({ identifier: 'CAN-4' });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.store.getState().views['*/CAN-4']).toEqual({ status: 'loading' });
  });

  it('bounds persisted entries and size, and survives corrupt or full storage', async () => {
    const t = setup();
    t.storage.setItem(REFERENCE_PREVIEW_STORAGE_KEY, '{not json');
    t.respondWith((identifier) =>
      Promise.resolve({
        status: 'ok',
        scope: 'scope-a',
        preview: preview(identifier, 'x'.repeat(4_000)),
      }),
    );
    for (let index = 0; index < 210; index += 1) {
      await t.store.getState().load({ identifier: `CAN-${index}` });
    }
    jest.runOnlyPendingTimers();
    const persisted = t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '';
    expect(persisted.length).toBeLessThanOrEqual(
      LIMITS.maxSerializedChars + 20,
    );
    const count = (JSON.parse(persisted) as { entries: unknown[] }).entries
      .length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(LIMITS.maxEntries);

    t.storage.failWrites = true;
    await t.store.getState().load({ identifier: 'CAN-999' });
    expect(() => jest.runOnlyPendingTimers()).not.toThrow();
    await t.store.getState().load({ identifier: 'CAN-999' });
    expect(t.reads.filter((id) => id === 'CAN-999')).toHaveLength(1);
  });

  it('discards a pending read after invalidation', async () => {
    const t = setup();
    const pending = deferred<LinearIssuePreviewResult>();
    t.respondWith(() => pending.promise);
    const load = t.store.getState().load({ identifier: 'CAN-5' });
    await Promise.resolve();
    await Promise.resolve();
    invalidateReferencePreviews(t.storage);
    pending.resolve({
      status: 'ok',
      scope: 'scope-a',
      preview: preview('CAN-5'),
    });
    expect(await load).toBeNull();
    expect(t.store.getState().views).toEqual({});
    jest.runOnlyPendingTimers();
    expect(
      t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '',
    ).not.toContain('CAN-5');
  });

  it('discards a result from a different identity', async () => {
    const t = setup();
    t.respondWith(() =>
      Promise.resolve({
        status: 'ok',
        scope: 'scope-b',
        preview: preview('CAN-6'),
      }),
    );
    expect(await t.store.getState().load({ identifier: 'CAN-6' })).toBeNull();
    expect(t.store.getState().views['*/CAN-6']).toBeUndefined();
  });

  it('removes inaccessible entries and holds a short negative cache', async () => {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-7' });
    t.advance(LIMITS.freshMs + 1);
    t.respondWith(() =>
      Promise.resolve({ status: 'unavailable', scope: 'scope-a' }),
    );
    expect(await t.store.getState().load({ identifier: 'CAN-7' })).toBeNull();
    expect(t.store.getState().views['*/CAN-7']).toEqual({
      status: 'unavailable',
      reason: 'unavailable',
    });
    await t.store.getState().load({ identifier: 'CAN-7' });
    expect(t.reads).toHaveLength(2);
    t.advance(LIMITS.negativeMs + 1);
    await t.store.getState().load({ identifier: 'CAN-7' });
    expect(t.reads).toHaveLength(3);
  });

  it('keeps a labeled stale value while rate limited', async () => {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-8' });
    t.advance(LIMITS.freshMs + 1);
    t.respondWith(() =>
      Promise.resolve({ status: 'rate-limited', retryAfterMs: 120_000 }),
    );
    expect(await t.store.getState().load({ identifier: 'CAN-8' })).toEqual(
      preview('CAN-8'),
    );
    t.advance(LIMITS.negativeMs + 1);
    await t.store.getState().load({ identifier: 'CAN-8' });
    expect(t.reads).toHaveLength(2);
    expect(t.store.getState().views['*/CAN-8']).toMatchObject({
      status: 'ready',
      refreshing: false,
    });
  });

  it('reports a missing connection and clears cached details', async () => {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-9' });
    jest.runOnlyPendingTimers();
    t.setScope(null);
    expect(await t.store.getState().load({ identifier: 'CAN-9' })).toBeNull();
    expect(t.store.getState().views['*/CAN-9']).toEqual({
      status: 'unavailable',
      reason: 'disconnected',
    });
    jest.runOnlyPendingTimers();
    expect(
      t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '',
    ).not.toContain('CAN-9');
  });

  it('resets when another window clears the cache, and stops after dispose', async () => {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-10' });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: REFERENCE_PREVIEW_STORAGE_KEY,
        newValue: null,
      }),
    );
    expect(t.store.getState().views).toEqual({});
    disposePreviewStore(t.store);
    await t.store.getState().load({ identifier: 'CAN-10' });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: REFERENCE_PREVIEW_STORAGE_KEY,
        newValue: null,
      }),
    );
    expect(t.store.getState().views['*/CAN-10']).toBeDefined();
  });

  it('bounds in-memory entries and views, not only persisted ones', async () => {
    const t = setup();
    for (let index = 0; index < LIMITS.maxEntries + 25; index += 1) {
      t.advance(1);
      await t.store.getState().load({ identifier: `CAN-${index}` });
    }
    const keys = Object.keys(t.store.getState().views);
    expect(keys).toHaveLength(LIMITS.maxEntries);
    expect(keys).not.toContain('*/CAN-0');
    t.respondWith(() => new Promise(() => undefined));
    void t.store.getState().load({ identifier: 'CAN-0' });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.store.getState().views['*/CAN-0']).toEqual({ status: 'loading' });
  });

  it('signals other windows even when nothing was persisted yet', async () => {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-11' });
    expect(t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY)).toBeNull();
    invalidateReferencePreviews(t.storage);
    expect(t.storage.getItem(REFERENCE_PREVIEW_RESET_KEY)).toEqual(
      expect.any(String),
    );

    await t.store.getState().load({ identifier: 'CAN-12' });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: REFERENCE_PREVIEW_RESET_KEY,
        newValue: 'other-window',
      }),
    );
    expect(t.store.getState().views).toEqual({});
  });

  it('drops expired entries when hydrating and rewrites the mirror', async () => {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-20' });
    t.advance(1);
    await t.store.getState().load({ identifier: 'CAN-21' });
    jest.runOnlyPendingTimers();
    t.advance(LIMITS.retentionMs);

    const restarted = t.make();
    t.respondWith(() => new Promise(() => undefined));
    void restarted.getState().load({ identifier: 'CAN-21' });
    await Promise.resolve();
    await Promise.resolve();
    jest.runOnlyPendingTimers();
    const persisted = t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '';
    expect(persisted).not.toContain('CAN-20');
    expect(persisted).toContain('CAN-21');
  });

  it('treats a persisted entry with a malformed preview as a cache miss', async () => {
    const t = setup();
    t.storage.setItem(
      REFERENCE_PREVIEW_STORAGE_KEY,
      JSON.stringify({
        entries: [
          {
            scope: 'scope-a',
            key: '*/CAN-30',
            checkedAt: 1_000_000,
            usedAt: 1_000_000,
            preview: { ...preview('CAN-30'), description: { nested: true } },
          },
        ],
      }),
    );
    await t.make().getState().load({ identifier: 'CAN-30' });
    expect(t.reads).toEqual(['CAN-30']);
  });
});

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function keysOf(store: ClientStore<LinearPreviewStoreState>): string[] | null {
  const keys = store.getState().teamCatalog.keys;
  return keys ? Array.from(keys) : null;
}

describe('team catalog', () => {
  it('coalesces loads and publishes keys only from a complete fresh catalog', async () => {
    const t = setup();
    const pending = deferred<LinearTeamKeysResult>();
    t.respondTeamsWith(() => pending.promise);
    t.store.getState().ensureTeamCatalog();
    t.store.getState().ensureTeamCatalog();
    expect(t.teamReads()).toBe(1);
    expect(t.store.getState().teamCatalog).toEqual({
      status: 'loading',
      keys: null,
      connected: false,
    });
    pending.resolve({
      status: 'ok',
      scope: 'scope-a',
      keys: ['CAN', 'ECW'],
      fetchedAt: t.now(),
    });
    await flush();
    const catalog = t.store.getState().teamCatalog;
    expect(catalog.status).toBe('ready');
    expect(catalog.connected).toBe(true);
    expect(Array.from(catalog.keys ?? [])).toEqual(['CAN', 'ECW']);
    t.store.getState().ensureTeamCatalog();
    expect(t.teamReads()).toBe(1);
  });

  it('keeps publishing keys through a refresh; a successful one replaces them', async () => {
    const t = setup();
    t.store.getState().ensureTeamCatalog();
    await flush();
    t.advance(LIMITS.freshMs - 1);
    t.store.getState().ensureTeamCatalog();
    expect(t.teamReads()).toBe(1);
    t.advance(1);
    const pending = deferred<LinearTeamKeysResult>();
    t.respondTeamsWith(() => pending.promise);
    t.store.getState().ensureTeamCatalog();
    expect(t.teamReads()).toBe(2);
    expect(t.store.getState().teamCatalog).toMatchObject({
      status: 'loading',
      connected: true,
    });
    expect(keysOf(t.store)).toEqual(['CAN', 'ECW']);
    pending.resolve({
      status: 'ok',
      scope: 'scope-a',
      keys: ['REG'],
      fetchedAt: t.now(),
    });
    await flush();
    expect(keysOf(t.store)).toEqual(['REG']);
  });

  it('keeps the last known keys through failed, rate-limited and lost refreshes', async () => {
    const t = setup();
    t.store.getState().ensureTeamCatalog();
    await flush();
    const failures: RespondTeams[] = [
      (): Promise<LinearTeamKeysResult> =>
        Promise.resolve({ status: 'failed', scope: 'scope-a' }),
      (): Promise<LinearTeamKeysResult> =>
        Promise.resolve({
          status: 'rate-limited',
          scope: 'scope-a',
          retryAfterMs: null,
        }),
      (): Promise<LinearTeamKeysResult> =>
        Promise.reject(new Error('ipc down')),
    ];
    for (const failure of failures) {
      t.advance(LIMITS.freshMs);
      t.respondTeamsWith(failure);
      t.store.getState().ensureTeamCatalog();
      await flush();
      expect(t.store.getState().teamCatalog).toMatchObject({
        status: 'unavailable',
        connected: true,
      });
      expect(keysOf(t.store)).toEqual(['CAN', 'ECW']);
    }
    expect(t.teamReads()).toBe(4);
  });

  it('drops the last known keys once the catalog passes retention', async () => {
    const t = setup();
    t.store.getState().ensureTeamCatalog();
    await flush();
    t.advance(LIMITS.retentionMs + 1);
    t.respondTeamsWith(() =>
      Promise.resolve({ status: 'failed', scope: 'scope-a' }),
    );
    t.store.getState().ensureTeamCatalog();
    expect(keysOf(t.store)).toBeNull();
    await flush();
    expect(t.store.getState().teamCatalog).toEqual({
      status: 'unavailable',
      keys: null,
      connected: true,
    });
  });

  it('still clears keys on invalidation, a scope change and a disconnect', async () => {
    const t = setup();
    t.store.getState().ensureTeamCatalog();
    await flush();
    invalidateReferencePreviews(t.storage);
    expect(keysOf(t.store)).toBeNull();
    t.store.getState().ensureTeamCatalog();
    await flush();
    expect(keysOf(t.store)).toEqual(['CAN', 'ECW']);

    // Another credential's failed catalog never inherits the old keys.
    t.setScope('scope-b');
    t.advance(LIMITS.freshMs);
    t.respondTeamsWith(() =>
      Promise.resolve({ status: 'failed', scope: 'scope-b' }),
    );
    t.store.getState().ensureTeamCatalog();
    await flush();
    expect(keysOf(t.store)).toBeNull();

    t.respondTeamsWith(() =>
      Promise.resolve({
        status: 'ok',
        scope: 'scope-b',
        keys: ['REG'],
        fetchedAt: t.now(),
      }),
    );
    t.advance(LIMITS.negativeMs);
    t.store.getState().ensureTeamCatalog();
    await flush();
    expect(keysOf(t.store)).toEqual(['REG']);

    t.setScope(null);
    t.advance(LIMITS.freshMs);
    t.respondTeamsWith(() => Promise.resolve({ status: 'disconnected' }));
    t.store.getState().ensureTeamCatalog();
    await flush();
    expect(t.store.getState().teamCatalog).toEqual({
      status: 'unavailable',
      keys: null,
      connected: false,
    });
  });

  it('keeps bare IDs plain through failures and waits out the cooldown', async () => {
    const t = setup();
    t.respondTeamsWith(() =>
      Promise.resolve({ status: 'failed', scope: 'scope-a' }),
    );
    t.store.getState().ensureTeamCatalog();
    await flush();
    expect(t.store.getState().teamCatalog).toEqual({
      status: 'unavailable',
      keys: null,
      connected: true,
    });
    t.advance(LIMITS.negativeMs - 1);
    t.store.getState().ensureTeamCatalog();
    expect(t.teamReads()).toBe(1);
    t.respondTeamsWith(() =>
      Promise.resolve({
        status: 'rate-limited',
        scope: 'scope-a',
        retryAfterMs: 5 * 60 * 1000,
      }),
    );
    t.advance(1);
    t.store.getState().ensureTeamCatalog();
    await flush();
    expect(t.teamReads()).toBe(2);
    t.advance(4 * 60 * 1000);
    t.store.getState().ensureTeamCatalog();
    expect(t.teamReads()).toBe(2);
    t.advance(60 * 1000);
    t.respondTeamsWith(() => Promise.reject(new Error('ipc down')));
    t.store.getState().ensureTeamCatalog();
    await flush();
    expect(t.teamReads()).toBe(3);
    expect(t.store.getState().teamCatalog.keys).toBeNull();
  });

  it('reports a disconnected host and rechecks only after a reset or the freshness window', async () => {
    const t = setup();
    t.setScope(null);
    t.store.getState().ensureTeamCatalog();
    await flush();
    expect(t.store.getState().teamCatalog).toEqual({
      status: 'unavailable',
      keys: null,
      connected: false,
    });
    t.store.getState().ensureTeamCatalog();
    expect(t.teamReads()).toBe(1);
    t.setScope('scope-a');
    invalidateReferencePreviews(t.storage);
    expect(t.store.getState().teamCatalog.status).toBe('idle');
    t.store.getState().ensureTeamCatalog();
    await flush();
    expect(t.teamReads()).toBe(2);
    expect(t.store.getState().teamCatalog.connected).toBe(true);
  });

  it('discards a catalog that arrives after an identity reset', async () => {
    const t = setup();
    const late = deferred<LinearTeamKeysResult>();
    t.respondTeamsWith(() => late.promise);
    t.store.getState().ensureTeamCatalog();
    const epoch = t.store.getState().epoch;
    invalidateReferencePreviews(t.storage);
    expect(t.store.getState().epoch).toBe(epoch + 1);
    late.resolve({
      status: 'ok',
      scope: 'scope-a',
      keys: ['CAN'],
      fetchedAt: t.now(),
    });
    await flush();
    expect(t.store.getState().teamCatalog).toEqual({
      status: 'idle',
      keys: null,
      connected: false,
    });
  });

  it('resets when the catalog arrives for another credential', async () => {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-1' });
    expect(t.store.getState().views['*/CAN-1']).toBeDefined();
    t.setScope('scope-b');
    t.store.getState().ensureTeamCatalog();
    await flush();
    expect(t.store.getState().views['*/CAN-1']).toBeUndefined();
    expect(t.store.getState().teamCatalog.status).toBe('ready');
  });
});

describe('visibility queue', () => {
  async function tick(t: Harness, ms: number): Promise<void> {
    t.advance(ms);
    jest.advanceTimersByTime(ms);
    await flush();
  }

  it('reads a reference only after it stays visible through the debounce', async () => {
    const t = setup();
    const release = t.store.getState().watch({ identifier: 'CAN-1' });
    await tick(t, QUEUE.debounceMs - 1);
    expect(t.reads).toEqual([]);
    release();
    await tick(t, 10);
    expect(t.reads).toEqual([]);
    t.store.getState().watch({ identifier: 'CAN-1' });
    await tick(t, QUEUE.debounceMs);
    expect(t.reads).toEqual(['CAN-1']);
    expect(t.store.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
    });
  });

  it('dedupes repeated consumers and never re-reads a fresh title', async () => {
    const t = setup();
    const releases = [1, 2, 3].map(() =>
      t.store.getState().watch({ identifier: 'CAN-1' }),
    );
    await tick(t, QUEUE.debounceMs);
    releases.forEach((release) => release());
    t.store.getState().watch({ identifier: 'CAN-1' });
    await tick(t, QUEUE.debounceMs);
    expect(t.reads).toEqual(['CAN-1']);
  });

  it('runs two reads at a time, holds twenty pending, and drops unobserved work', async () => {
    const t = setup();
    const gates = new Map<
      string,
      ReturnType<typeof deferred<LinearIssuePreviewResult>>
    >();
    t.respondWith((identifier) => {
      const gate = deferred<LinearIssuePreviewResult>();
      gates.set(identifier, gate);
      return gate.promise;
    });
    const releases = new Map<string, () => void>();
    for (let index = 1; index <= 30; index += 1) {
      releases.set(
        `CAN-${index}`,
        t.store.getState().watch({ identifier: `CAN-${index}` }),
      );
    }
    await tick(t, QUEUE.debounceMs);
    expect(t.reads).toEqual(['CAN-1', 'CAN-2']);
    // CAN-3..CAN-22 are pending; scrolling CAN-3 away discards it.
    releases.get('CAN-3')?.();
    const ok = (identifier: string): LinearIssuePreviewResult => ({
      status: 'ok',
      scope: 'scope-a',
      preview: preview(identifier),
    });
    gates.get('CAN-1')?.resolve(ok('CAN-1'));
    await flush();
    expect(t.reads).toEqual(['CAN-1', 'CAN-2', 'CAN-4']);
    // Admitted still-visible references keep the queue moving past twenty.
    for (let index = 2; index <= 29; index += 1) {
      gates.get(`CAN-${index}`)?.resolve(ok(`CAN-${index}`));
      await flush();
    }
    expect(t.reads).not.toContain('CAN-3');
    expect(t.reads).toContain('CAN-30');
    expect(new Set(t.reads).size).toBe(t.reads.length);
  });

  it('lets hover bypass the passive queue', async () => {
    const t = setup();
    t.respondWith(() => new Promise(() => undefined));
    for (let index = 1; index <= 3; index += 1) {
      t.store.getState().watch({ identifier: `CAN-${index}` });
    }
    await tick(t, QUEUE.debounceMs);
    void t.store.getState().load({ identifier: 'CAN-9' });
    await flush();
    expect(t.reads).toEqual(['CAN-1', 'CAN-2', 'CAN-9']);
  });

  it('pauses passive reads for a provider retry-after', async () => {
    const t = setup();
    t.respondWith(() =>
      Promise.resolve({ status: 'rate-limited', retryAfterMs: 30_000 }),
    );
    for (let index = 1; index <= 4; index += 1) {
      t.store.getState().watch({ identifier: `CAN-${index}` });
    }
    await tick(t, QUEUE.debounceMs);
    expect(t.reads).toEqual(['CAN-1', 'CAN-2']);
    await tick(t, 29_000);
    expect(t.reads).toEqual(['CAN-1', 'CAN-2']);
    t.respondWith((identifier) =>
      Promise.resolve({
        status: 'ok',
        scope: 'scope-a',
        preview: preview(identifier),
      }),
    );
    await tick(t, 1_000);
    // The throttled pair retries once its cooldown has passed and a slot clears.
    expect(t.reads).toEqual([
      'CAN-1',
      'CAN-2',
      'CAN-3',
      'CAN-4',
      'CAN-1',
      'CAN-2',
    ]);
  });

  it('drops queued work and late titles on an identity reset', async () => {
    const t = setup();
    const gate = deferred<LinearIssuePreviewResult>();
    t.respondWith(() => gate.promise);
    t.store.getState().watch({ identifier: 'CAN-1' });
    t.store.getState().watch({ identifier: 'CAN-2' });
    t.store.getState().watch({ identifier: 'CAN-3' });
    await tick(t, QUEUE.debounceMs);
    invalidateReferencePreviews(t.storage);
    gate.resolve({
      status: 'ok',
      scope: 'scope-a',
      preview: preview('CAN-1'),
    });
    await tick(t, 1_000);
    expect(t.reads).toEqual(['CAN-1', 'CAN-2']);
    expect(t.store.getState().views).toEqual({});
  });

  describe('failure paths', () => {
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    };
    const resetWrites = (spy: jest.SpyInstance): number =>
      spy.mock.calls.filter(([key]) => key === REFERENCE_PREVIEW_RESET_KEY)
        .length;

    it('a catalog disconnect resets other windows once, without ping-pong', async () => {
      const t = setup();
      const other = t.make();
      t.store.getState().ensureTeamCatalog();
      await settle();
      expect(t.store.getState().teamCatalog.status).toBe('ready');
      await other.getState().load({ identifier: 'CAN-1' });
      expect(other.getState().views['*/CAN-1']).toBeDefined();

      const writes = jest.spyOn(t.storage, 'setItem');
      t.setScope(null);
      t.advance(LIMITS.freshMs + 1);
      t.store.getState().ensureTeamCatalog();
      await settle();
      expect(other.getState().views).toEqual({});
      other.getState().ensureTeamCatalog();
      t.store.getState().ensureTeamCatalog();
      await settle();
      expect(resetWrites(writes)).toBe(1);
      expect(other.getState().teamCatalog).toMatchObject({
        status: 'unavailable',
        connected: false,
      });
    });

    it('a rejected credential does not loop catalog and issue reads', async () => {
      const t = setup();
      t.store.getState().ensureTeamCatalog();
      await settle();
      // Main reports the credential revoked from now on.
      t.respondWith(() => {
        t.setScope(null);
        return Promise.resolve({ status: 'disconnected' });
      });
      await t.store.getState().load({ identifier: 'CAN-1' });
      for (let index = 0; index < 3; index += 1) {
        t.store.getState().ensureTeamCatalog();
        await settle();
        await t.store.getState().load({ identifier: 'CAN-1' });
      }
      expect(t.reads).toEqual(['CAN-1']);
      expect(t.teamReads()).toBe(2);
      expect(t.store.getState().teamCatalog.connected).toBe(false);
    });

    it('marks URLs connected without waiting for the team catalog', async () => {
      const t = setup();
      t.respondTeamsWith(() => new Promise(() => undefined));
      t.store.getState().ensureTeamCatalog();
      await settle();
      expect(t.store.getState().teamCatalog).toMatchObject({
        status: 'loading',
        keys: null,
        connected: true,
      });
    });

    it('hover and focus honor the provider Retry-After', async () => {
      const t = setup();
      t.respondWith(() =>
        Promise.resolve({ status: 'rate-limited', retryAfterMs: 30_000 }),
      );
      await t.store.getState().load({ identifier: 'CAN-1' });
      t.respondWith((identifier) =>
        Promise.resolve({
          status: 'ok',
          scope: 'scope-a',
          preview: preview(identifier),
        }),
      );
      expect(await t.store.getState().load({ identifier: 'CAN-2' })).toBeNull();
      expect(t.reads).toEqual(['CAN-1']);
      t.advance(30_001);
      await t.store.getState().load({ identifier: 'CAN-2' });
      expect(t.reads).toEqual(['CAN-1', 'CAN-2']);
    });

    it('a later, shorter Retry-After never shortens the pause', async () => {
      const t = setup();
      const long = deferred<LinearIssuePreviewResult>();
      const short = deferred<LinearIssuePreviewResult>();
      t.respondWith((identifier) =>
        identifier === 'CAN-1' ? long.promise : short.promise,
      );
      const first = t.store.getState().load({ identifier: 'CAN-1' });
      const second = t.store.getState().load({ identifier: 'CAN-2' });
      await settle();
      long.resolve({ status: 'rate-limited', retryAfterMs: 60_000 });
      await first;
      short.resolve({ status: 'rate-limited', retryAfterMs: 10_000 });
      await second;
      t.respondWith((identifier) =>
        Promise.resolve({
          status: 'ok',
          scope: 'scope-a',
          preview: preview(identifier),
        }),
      );
      t.advance(10_001);
      await t.store.getState().load({ identifier: 'CAN-3' });
      expect(t.reads).toEqual(['CAN-1', 'CAN-2']);
      t.advance(50_000);
      await t.store.getState().load({ identifier: 'CAN-3' });
      expect(t.reads).toEqual(['CAN-1', 'CAN-2', 'CAN-3']);
    });

    it('keeps publishing team keys when a mounted catalog expires', async () => {
      const t = setup();
      t.store.getState().ensureTeamCatalog();
      await settle();
      expect(t.store.getState().teamCatalog.keys).not.toBeNull();
      jest.advanceTimersByTime(LIMITS.freshMs);
      expect(t.store.getState().teamCatalog).toMatchObject({
        status: 'idle',
        connected: true,
      });
      expect(keysOf(t.store)).toEqual(['CAN', 'ECW']);
    });

    it('a mounted catalog reloads after a failure cooldown without another use', async () => {
      const t = setup();
      t.respondTeamsWith(() =>
        Promise.resolve({
          status: 'rate-limited',
          scope: 'scope-a',
          retryAfterMs: 90_000,
        }),
      );
      t.store.getState().ensureTeamCatalog();
      await settle();
      jest.advanceTimersByTime(90_000 - 1);
      expect(t.store.getState().teamCatalog.status).toBe('unavailable');
      jest.advanceTimersByTime(1);
      expect(t.store.getState().teamCatalog).toMatchObject({
        status: 'idle',
        connected: true,
      });
      t.respondTeamsWith(() => Promise.reject(new Error('ipc down')));
      t.store.getState().ensureTeamCatalog();
      await settle();
      jest.advanceTimersByTime(LIMITS.negativeMs);
      expect(t.store.getState().teamCatalog.status).toBe('idle');
      expect(t.teamReads()).toBe(2);
    });

    it('refreshes a reference that stays visible once its title goes stale', async () => {
      const t = setup();
      t.store.getState().watch({ identifier: 'CAN-1' });
      await tick(t, QUEUE.debounceMs);
      expect(t.reads).toEqual(['CAN-1']);
      await tick(t, LIMITS.freshMs);
      expect(t.reads).toEqual(['CAN-1']);
      await tick(t, 1);
      expect(t.reads).toEqual(['CAN-1', 'CAN-1']);
    });

    it('retries a visible reference after a failed read, and not once released', async () => {
      const t = setup();
      t.respondWith(() => Promise.resolve({ status: 'failed' }));
      const release = t.store.getState().watch({ identifier: 'CAN-1' });
      t.store.getState().watch({ identifier: 'CAN-2' });
      await tick(t, QUEUE.debounceMs);
      expect(t.reads).toEqual(['CAN-1', 'CAN-2']);
      release();
      t.respondWith((identifier) =>
        Promise.resolve({
          status: 'ok',
          scope: 'scope-a',
          preview: preview(identifier),
        }),
      );
      await tick(t, LIMITS.negativeMs);
      expect(t.reads).toEqual(['CAN-1', 'CAN-2', 'CAN-2']);
      expect(t.store.getState().views['*/CAN-2']).toMatchObject({
        status: 'ready',
      });
    });

    it('does not re-read visible references while Linear is disconnected', async () => {
      const t = setup();
      t.setScope(null);
      t.store.getState().watch({ identifier: 'CAN-1' });
      t.store.getState().watch({ identifier: 'CAN-2' });
      await tick(t, QUEUE.debounceMs);
      await tick(t, LIMITS.freshMs);
      expect(t.scopeReads()).toBe(2);
    });

    it('keeps an unsaved entry when another window writes the cache', async () => {
      const t = setup();
      await t.store.getState().load({ identifier: 'CAN-1' });
      const otherEntry = {
        scope: 'scope-a',
        key: '*/CAN-2',
        checkedAt: t.now(),
        usedAt: t.now(),
        preview: preview('CAN-2'),
      };
      const value = JSON.stringify({ entries: [otherEntry] });
      t.storage.setItem(REFERENCE_PREVIEW_STORAGE_KEY, value);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: REFERENCE_PREVIEW_STORAGE_KEY,
          newValue: value,
        }),
      );
      jest.runOnlyPendingTimers();
      const persisted = t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '';
      expect(persisted).toContain('*/CAN-1');
      expect(persisted).toContain('*/CAN-2');
    });
  });
});

describe('first-paint hydration', () => {
  const queries = (t: Harness): number =>
    t.reads.length + t.teamReads() + t.scopeReads();

  // A previous window that showed CAN-1 and CAN-2 and loaded the catalog.
  async function seeded(): Promise<Harness> {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-1' });
    t.advance(1);
    await t.store.getState().load({ identifier: 'CAN-2' });
    t.store.getState().ensureTeamCatalog();
    await flush();
    jest.advanceTimersByTime(250);
    return t;
  }

  const savedEntry = (identifier: string, scope = 'scope-a'): object => ({
    scope,
    key: `*/${identifier}`,
    checkedAt: 1_000_000,
    usedAt: 1_000_000,
    preview: preview(identifier),
  });

  it('shows saved titles and team keys at creation without any query', async () => {
    const t = await seeded();
    const before = queries(t);
    const restarted = t.make();
    expect(restarted.getState().views['*/CAN-1']).toEqual({
      status: 'ready',
      preview: preview('CAN-1'),
      checkedAt: 1_000_000,
      refreshing: false,
    });
    expect(restarted.getState().views['*/CAN-2']).toMatchObject({
      status: 'ready',
      checkedAt: 1_000_001,
    });
    expect(restarted.getState().teamCatalog).toMatchObject({
      status: 'ready',
      connected: true,
    });
    expect(keysOf(restarted)).toEqual(['CAN', 'ECW']);
    expect(queries(t)).toBe(before);

    // The same scope confirms locally; no provider read is needed.
    const teamReads = t.teamReads();
    restarted.getState().ensureTeamCatalog();
    await flush();
    expect(t.teamReads()).toBe(teamReads);
    expect(t.reads).toEqual(['CAN-1', 'CAN-2']);
    expect(restarted.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
    });
    expect(keysOf(restarted)).toEqual(['CAN', 'ECW']);
  });

  it('hydrates an expired catalog as idle with its keys, then refreshes it', async () => {
    const t = await seeded();
    t.advance(LIMITS.freshMs);
    const restarted = t.make();
    expect(restarted.getState().teamCatalog).toMatchObject({
      status: 'idle',
      connected: true,
    });
    expect(keysOf(restarted)).toEqual(['CAN', 'ECW']);
    const pending = deferred<LinearTeamKeysResult>();
    t.respondTeamsWith(() => pending.promise);
    restarted.getState().ensureTeamCatalog();
    expect(restarted.getState().teamCatalog.status).toBe('loading');
    expect(keysOf(restarted)).toEqual(['CAN', 'ECW']);
    pending.resolve({
      status: 'ok',
      scope: 'scope-a',
      keys: ['REG'],
      fetchedAt: t.now(),
    });
    await flush();
    expect(keysOf(restarted)).toEqual(['REG']);
  });

  it('refreshes a stale hydrated title through the visibility queue, keeping it', async () => {
    const t = await seeded();
    t.advance(LIMITS.freshMs + 1);
    const restarted = t.make();
    const gate = deferred<LinearIssuePreviewResult>();
    t.respondWith(() => gate.promise);
    restarted.getState().watch({ identifier: 'CAN-1' });
    jest.advanceTimersByTime(QUEUE.debounceMs);
    await flush();
    expect(t.reads).toEqual(['CAN-1', 'CAN-2', 'CAN-1']);
    expect(restarted.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
      refreshing: true,
    });
  });

  it.each(['scope-b', null])(
    'purges hydrated data when the host reports scope %s',
    async (next) => {
      const t = await seeded();
      t.setScope(next);
      const restarted = t.make();
      const other = t.make();
      expect(restarted.getState().views['*/CAN-1']).toBeDefined();
      const teamReads = t.teamReads();
      restarted.getState().ensureTeamCatalog();
      await flush();
      expect(restarted.getState().views).toEqual({});
      // The old keys are gone; a new scope loads its own catalog.
      expect(keysOf(restarted)).toEqual(next === null ? null : ['CAN', 'ECW']);
      expect(t.teamReads() - teamReads).toBe(next === null ? 0 : 1);
      expect(restarted.getState().teamCatalog.connected).toBe(next !== null);
      jest.runOnlyPendingTimers();
      expect(
        t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '',
      ).not.toContain('scope-a');
      // Any disowned saved scope resets every window that hydrated it.
      expect(other.getState().views).toEqual({});
      expect(keysOf(other)).toBeNull();
    },
  );

  it('does not write an emptied record back after a disconnect purge', async () => {
    const t = await seeded();
    t.setScope(null);
    const restarted = t.make();
    restarted.getState().ensureTeamCatalog();
    await flush();
    jest.runOnlyPendingTimers();
    expect(t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY)).toBeNull();
  });

  it.each(['scope-b', null])(
    'purges hydrated data when the catalog adopts the saved scope before the scope check reports %s',
    async (next) => {
      const t = await seeded();
      t.advance(LIMITS.freshMs);
      const restarted = t.make();
      const check = deferred<{ scope: string | null }>();
      t.respondScopeWith(() => check.promise);
      // The catalog still answers for the saved scope and lands first.
      restarted.getState().ensureTeamCatalog();
      await flush();
      expect(keysOf(restarted)).toEqual(['CAN', 'ECW']);
      const teamReads = t.teamReads();
      t.setScope(next);
      t.respondTeamsWith(() =>
        Promise.resolve({
          status: 'ok',
          scope: 'scope-b',
          keys: ['REG'],
          fetchedAt: t.now(),
        }),
      );
      t.respondScopeWith(() => Promise.resolve({ scope: next }));
      check.resolve({ scope: next });
      await flush();
      expect(restarted.getState().views).toEqual({});
      expect(keysOf(restarted)).toEqual(next === null ? null : ['REG']);
      expect(t.teamReads() - teamReads).toBe(next === null ? 0 : 1);
    },
  );

  it('retries a failed scope check on the next catalog use', async () => {
    const t = await seeded();
    const restarted = t.make();
    t.respondScopeWith(() => Promise.reject(new Error('ipc down')));
    restarted.getState().ensureTeamCatalog();
    await flush();
    // Unconfirmed, the saved data stays until a check can answer.
    expect(restarted.getState().views['*/CAN-1']).toBeDefined();
    const checks = t.scopeReads();
    t.setScope('scope-b');
    t.respondScopeWith(() => Promise.resolve({ scope: 'scope-b' }));
    restarted.getState().ensureTeamCatalog();
    await flush();
    expect(t.scopeReads()).toBe(checks + 1);
    expect(restarted.getState().views).toEqual({});
  });

  it('retries a failed scope check on its own while saved data is unconfirmed', async () => {
    const t = await seeded();
    const restarted = t.make();
    t.respondScopeWith(() => Promise.reject(new Error('ipc down')));
    restarted.getState().ensureTeamCatalog();
    await flush();
    expect(restarted.getState().views['*/CAN-1']).toBeDefined();
    t.setScope('scope-b');
    t.respondScopeWith(() => Promise.resolve({ scope: 'scope-b' }));
    jest.advanceTimersByTime(LIMITS.negativeMs);
    await flush();
    expect(restarted.getState().views).toEqual({});
  });

  it('drops kept team keys at retention even while a refresh never settles', async () => {
    const t = await seeded();
    const restarted = t.make();
    t.advance(LIMITS.freshMs);
    t.respondTeamsWith(() => new Promise(() => undefined));
    restarted.getState().ensureTeamCatalog();
    await flush();
    expect(keysOf(restarted)).toEqual(['CAN', 'ECW']);
    t.advance(LIMITS.retentionMs);
    jest.advanceTimersByTime(LIMITS.retentionMs);
    expect(keysOf(restarted)).toBeNull();
  });

  it("never writes an older team catalog over another window's newer one", async () => {
    const t = await seeded();
    const older = t.make();
    const newer = t.make();
    t.advance(LIMITS.freshMs);
    t.respondTeamsWith(() =>
      Promise.resolve({
        status: 'ok',
        scope: 'scope-a',
        keys: ['CAN'],
        fetchedAt: t.now(),
      }),
    );
    newer.getState().ensureTeamCatalog();
    await flush();
    jest.advanceTimersByTime(250);
    const value = t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '';
    expect(value).toContain('"keys":["CAN"]');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: REFERENCE_PREVIEW_STORAGE_KEY,
        newValue: value,
      }),
    );
    // The older window writes a title next; the saved catalog stays newer.
    await older.getState().load({ identifier: 'CAN-9' });
    jest.advanceTimersByTime(250);
    const saved = t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '';
    expect(saved).toContain('*/CAN-9');
    expect(saved).toContain('"keys":["CAN"]');
    // It does not apply live: no flicker in the older window.
    expect(keysOf(older)).toEqual(['CAN', 'ECW']);
  });

  it('keeps a pending last-shown stamp when another window writes the cache', async () => {
    const t = await seeded();
    const restarted = t.make();
    t.advance(2 * 60 * 1000);
    const shownAt = t.now();
    restarted.getState().watch({ identifier: 'CAN-1' });
    // Another window rewrites the cache before the lazy stamp is written.
    const value = t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '';
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: REFERENCE_PREVIEW_STORAGE_KEY,
        newValue: value,
      }),
    );
    jest.advanceTimersByTime(5_000);
    const saved: unknown = JSON.parse(
      t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '{}',
    );
    const entries: unknown = Reflect.get(Object(saved), 'entries');
    const list: unknown[] = Array.isArray(entries) ? entries : [];
    const can1 = list.find(
      (entry) => Reflect.get(Object(entry), 'key') === '*/CAN-1',
    );
    expect(Reflect.get(Object(can1), 'usedAt')).toBe(shownAt);
  });

  it('serves an entries-only payload lazily without hydrating it', async () => {
    const t = setup();
    t.storage.setItem(
      REFERENCE_PREVIEW_STORAGE_KEY,
      JSON.stringify({ entries: [savedEntry('CAN-30')] }),
    );
    const restarted = t.make();
    expect(restarted.getState().views).toEqual({});
    expect(restarted.getState().teamCatalog).toEqual({
      status: 'idle',
      keys: null,
      connected: false,
    });
    expect(await restarted.getState().load({ identifier: 'CAN-30' })).toEqual(
      preview('CAN-30'),
    );
    expect(t.reads).toEqual([]);
  });

  it.each<[string, unknown]>([
    [
      'an invalid key',
      { scope: 'scope-a', keys: ['CAN', 'no key'], checkedAt: 1_000_000 },
    ],
    [
      'too many keys',
      {
        scope: 'scope-a',
        keys: Array.from(
          { length: LIMITS.maxTeamKeys + 1 },
          (_, index) => `K${index}`,
        ),
        checkedAt: 1_000_000,
      },
    ],
    [
      'a non-numeric checkedAt',
      { scope: 'scope-a', keys: ['CAN'], checkedAt: '1000000' },
    ],
    [
      'another scope',
      { scope: 'scope-b', keys: ['CAN'], checkedAt: 1_000_000 },
    ],
    ['non-array keys', { scope: 'scope-a', keys: 'CAN', checkedAt: 1_000_000 }],
    ['a non-object catalog', 'CAN'],
  ])('ignores a saved catalog with %s but keeps its entries', (_, catalog) => {
    const t = setup();
    t.storage.setItem(
      REFERENCE_PREVIEW_STORAGE_KEY,
      JSON.stringify({
        scope: 'scope-a',
        entries: [savedEntry('CAN-30')],
        catalog,
      }),
    );
    const restarted = t.make();
    expect(restarted.getState().views['*/CAN-30']).toMatchObject({
      status: 'ready',
    });
    expect(keysOf(restarted)).toBeNull();
  });

  it('hydrates only entries of the saved scope within retention', () => {
    const t = setup();
    t.storage.setItem(
      REFERENCE_PREVIEW_STORAGE_KEY,
      JSON.stringify({
        scope: 'scope-a',
        entries: [
          savedEntry('CAN-30'),
          savedEntry('CAN-31', 'scope-b'),
          { ...savedEntry('CAN-32'), checkedAt: 1_000_000 - 1 },
        ],
        catalog: { scope: 'scope-a', keys: ['CAN'], checkedAt: 1_000_000 },
      }),
    );
    t.advance(LIMITS.retentionMs);
    const restarted = t.make();
    expect(Object.keys(restarted.getState().views)).toEqual(['*/CAN-30']);
    expect(restarted.getState().teamCatalog).toMatchObject({
      status: 'idle',
    });
    expect(keysOf(restarted)).toEqual(['CAN']);
    t.advance(1);
    expect(Object.keys(t.make().getState().views)).toEqual([]);
  });
});

describe('cache sizing', () => {
  const ready = (t: Harness): string[] =>
    Object.entries(t.store.getState().views)
      .filter(([, view]) => view.status === 'ready')
      .map(([key]) => key);

  it('keeps ready views while many other references are unavailable', async () => {
    const t = setup();
    for (let index = 0; index < LIMITS.maxEntries; index += 1) {
      t.advance(1);
      await t.store.getState().load({ identifier: `CAN-${index}` });
    }
    t.respondWith(() =>
      Promise.resolve({ status: 'unavailable', scope: 'scope-a' }),
    );
    for (let index = 0; index < 50; index += 1) {
      await t.store.getState().load({ identifier: `ECW-${index}` });
    }
    expect(ready(t)).toHaveLength(LIMITS.maxEntries);
    expect(t.store.getState().views['*/CAN-0']).toMatchObject({
      status: 'ready',
    });
  });

  it('bounds views without a title, dropping off-screen ones first', async () => {
    const t = setup();
    t.respondWith(() =>
      Promise.resolve({ status: 'unavailable', scope: 'scope-a' }),
    );
    await t.store.getState().load({ identifier: 'ECW-0' });
    t.store.getState().watch({ identifier: 'ECW-0' });
    for (let index = 1; index <= LIMITS.maxEntries + 5; index += 1) {
      await t.store.getState().load({ identifier: `ECW-${index}` });
    }
    const views = t.store.getState().views;
    expect(Object.keys(views)).toHaveLength(LIMITS.maxEntries);
    expect(views['*/ECW-0']).toBeDefined();
    expect(views['*/ECW-1']).toBeUndefined();
  });

  it('evicts the least recently shown entry, not the least recently read', async () => {
    const t = setup();
    for (let index = 0; index < LIMITS.maxEntries; index += 1) {
      t.advance(1);
      await t.store.getState().load({ identifier: `CAN-${index}` });
    }
    t.advance(61_000);
    t.store.getState().watch({ identifier: 'CAN-0' })();
    t.advance(1);
    await t.store.getState().load({ identifier: `CAN-${LIMITS.maxEntries}` });
    expect(t.store.getState().views['*/CAN-0']).toMatchObject({
      status: 'ready',
    });
    expect(t.store.getState().views['*/CAN-1']).toBeUndefined();
    expect(ready(t)).toHaveLength(LIMITS.maxEntries);
    jest.runOnlyPendingTimers();
    const persisted = t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '';
    expect(persisted).toContain('"key":"*/CAN-0"');
    expect(persisted).not.toContain('"key":"*/CAN-1"');
    const saved: unknown = JSON.parse(persisted);
    const list: unknown =
      typeof saved === 'object' && saved !== null
        ? Reflect.get(saved, 'entries')
        : null;
    expect(Array.isArray(list) ? list.length : 0).toBe(LIMITS.maxEntries);
  });

  it('records shown references without a storage write per scroll', async () => {
    const t = setup();
    for (const identifier of ['CAN-1', 'CAN-2', 'CAN-3']) {
      await t.store.getState().load({ identifier });
    }
    jest.runOnlyPendingTimers();
    const writes = jest.spyOn(t.storage, 'setItem');
    const scroll = (): void => {
      for (let pass = 0; pass < 5; pass += 1) {
        for (const identifier of ['CAN-1', 'CAN-2', 'CAN-3']) {
          t.store.getState().watch({ identifier })();
        }
      }
    };
    scroll();
    jest.advanceTimersByTime(10_000);
    expect(writes).not.toHaveBeenCalled();

    t.advance(61_000);
    scroll();
    jest.advanceTimersByTime(250);
    expect(writes).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2_000);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY)).toContain(
      `"usedAt":${t.now()}`,
    );
  });
});
