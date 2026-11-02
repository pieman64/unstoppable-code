/**
 * @jest-environment jsdom
 */
import {
  isGitHubPreviewTarget,
  type GitHubOriginRepository,
  type GitHubItemPreview,
  type GitHubPreviewResult,
  type GitHubPreviewTarget,
  type GitHubRepositoryPreview,
  type LinearIssuePreview,
  type LinearIssuePreviewResult,
} from '@canopy/protocol/reference-previews';

type OriginResult = GitHubOriginRepository;
import { CLIENT_STORE_DISPOSE } from '../../create-client-store';
import type { ClientStore } from '../../create-client-store';
import {
  createFakeClient,
  deferred,
} from '../../__tests__/fake-org-projects-client';
import {
  createLinearPreviewStore,
  githubPreviewKey,
  githubTitleSlot,
  invalidateReferencePreviews,
  linearPreviewKey,
  LINEAR_PREVIEW_CACHE_LIMITS as LIMITS,
  LINEAR_VISIBILITY_QUEUE_LIMITS as QUEUE,
  REFERENCE_PREVIEW_RESET_KEY,
  REFERENCE_PREVIEW_STORAGE_KEY,
  setReferenceEnrichmentModes,
  type LinearPreviewStoreState,
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
    this.values.set(key, value);
  }
}

const item = (number: number, repository = 'canopy'): GitHubPreviewTarget => ({
  kind: 'item',
  owner: 'acme',
  repository,
  number,
});

const repo = (repository = 'canopy'): GitHubPreviewTarget => ({
  kind: 'repository',
  owner: 'acme',
  repository,
});

const PULL_FACTS = {
  additions: 12,
  deletions: 3,
  changedFiles: 1,
  mergeable: 'mergeable',
  checks: 'passing',
  reviewDecision: null,
  inMergeQueue: false,
} as const;

function itemPreview(
  number: number,
  repository = 'canopy',
  title = `Item ${number}`,
): GitHubItemPreview {
  return {
    kind: 'item',
    owner: 'acme',
    repository,
    number,
    itemType: 'pull',
    title,
    url: `https://github.com/acme/${repository}/pull/${number}`,
    description: null,
    state: 'open',
    draft: false,
    author: 'octocat',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function repoPreview(
  repository = 'canopy',
  description: string | null = 'Agentic desktop',
): GitHubRepositoryPreview {
  return {
    kind: 'repository',
    owner: 'acme',
    repository,
    fullName: `Acme/${repository}`,
    url: `https://github.com/acme/${repository}`,
    description,
    private: false,
    archived: false,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function previewFor(
  target: GitHubPreviewTarget,
): GitHubItemPreview | GitHubRepositoryPreview {
  return target.kind === 'item'
    ? itemPreview(target.number, target.repository)
    : repoPreview(target.repository);
}

function linearPreview(identifier: string): LinearIssuePreview {
  return {
    identifier,
    title: `Linear ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
    description: null,
    status: 'Todo',
    assignee: null,
    project: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

type RespondGitHub = (
  target: GitHubPreviewTarget,
) => Promise<GitHubPreviewResult>;
type RespondLinear = (identifier: string) => Promise<LinearIssuePreviewResult>;

interface Harness {
  storage: MemoryStorage;
  githubReads: string[];
  linearReads: string[];
  originReads: string[];
  scopeReads: { linear: number; github: number };
  make: () => ClientStore<LinearPreviewStoreState>;
  store: ClientStore<LinearPreviewStoreState>;
  advance: (ms: number) => void;
  setLinearScope: (next: string | null) => void;
  setGitHubScope: (next: string | null, retryAfterMs?: number) => void;
  respondGitHubScopeWith: (
    fn: () => Promise<{ scope: string | null; retryAfterMs?: number }>,
  ) => void;
  respondGitHubWith: (fn: RespondGitHub) => void;
  respondLinearWith: (fn: RespondLinear) => void;
  respondOriginWith: (
    fn: () => Promise<{
      repository: { owner: string; repository: string } | null;
    }>,
  ) => void;
  now: () => number;
}

function setup(storage = new MemoryStorage()): Harness {
  let now = 1_000_000;
  let linearScope: string | null = 'linear-a';
  let githubScope: string | null = 'github-a';
  let githubRetryAfterMs: number | undefined;
  let readGitHubScope = (): Promise<{
    scope: string | null;
    retryAfterMs?: number;
  }> =>
    Promise.resolve({
      scope: githubScope,
      ...(githubRetryAfterMs === undefined
        ? {}
        : { retryAfterMs: githubRetryAfterMs }),
    });
  const fake = createFakeClient();
  const githubReads: string[] = [];
  const linearReads: string[] = [];
  const originReads: string[] = [];
  const scopeReads = { linear: 0, github: 0 };
  let respondGitHub: RespondGitHub = (target) =>
    Promise.resolve({
      status: 'ok',
      scope: githubScope ?? '',
      preview: previewFor(target),
    });
  let respondLinear: RespondLinear = (identifier) =>
    Promise.resolve({
      status: 'ok',
      scope: linearScope ?? '',
      preview: linearPreview(identifier),
    });
  let respondOrigin = (): Promise<OriginResult> =>
    Promise.resolve({ repository: { owner: 'acme', repository: 'canopy' } });
  fake.query.mockImplementation((name: string, args: unknown) => {
    switch (name) {
      case 'referencePreview.linearScope':
        scopeReads.linear += 1;
        return Promise.resolve({ scope: linearScope });
      case 'referencePreview.githubScope':
        scopeReads.github += 1;
        return readGitHubScope();
      case 'referencePreview.linearTeams':
        return Promise.resolve({
          status: 'ok',
          scope: linearScope,
          keys: ['CAN'],
          fetchedAt: now,
        });
      case 'referencePreview.githubOrigin':
        originReads.push(JSON.stringify(args));
        return respondOrigin();
      case 'referencePreview.github': {
        if (!isGitHubPreviewTarget(args)) throw new Error('bad target');
        githubReads.push(githubPreviewKey(args));
        return respondGitHub(args);
      }
      default: {
        const identifier: unknown =
          typeof args === 'object' && args !== null
            ? Reflect.get(args, 'identifier')
            : null;
        const id = typeof identifier === 'string' ? identifier : '';
        linearReads.push(id);
        return respondLinear(id);
      }
    }
  });
  const make = (): ClientStore<LinearPreviewStoreState> =>
    createLinearPreviewStore(fake.client, {
      now: () => now,
      storage: () => storage,
    });
  return {
    storage,
    githubReads,
    linearReads,
    originReads,
    scopeReads,
    make,
    store: make(),
    advance: (ms: number): void => {
      now += ms;
    },
    setLinearScope: (next: string | null): void => {
      linearScope = next;
    },
    setGitHubScope: (next: string | null, retryAfterMs?: number): void => {
      githubScope = next;
      githubRetryAfterMs = retryAfterMs;
    },
    respondGitHubScopeWith: (fn): void => {
      readGitHubScope = fn;
    },
    respondGitHubWith: (fn: RespondGitHub): void => {
      respondGitHub = fn;
    },
    respondLinearWith: (fn: RespondLinear): void => {
      respondLinear = fn;
    },
    respondOriginWith: (fn: () => Promise<OriginResult>): void => {
      respondOrigin = fn;
    },
    now: () => now,
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function persisted(t: Harness): Record<string, unknown> {
  const raw = t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY);
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  return typeof parsed === 'object' && parsed !== null
    ? Object.fromEntries(Object.entries(parsed))
    : {};
}

function persistedKeys(t: Harness): string[] {
  const list = persisted(t).entries;
  return Array.isArray(list)
    ? list.map((entry: unknown) =>
        typeof entry === 'object' && entry !== null
          ? String(Reflect.get(entry, 'key'))
          : '',
      )
    : [];
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('inconclusive GitHub scope reads', () => {
  it.each([0, 6 * 60_000])(
    'keeps the cached title at age %sms without a provider read or freshness renewal',
    async (age) => {
      const t = setup();
      await t.store.getState().loadGitHub(item(1));
      const checkedAt = t.now();
      t.advance(age);
      t.respondGitHubScopeWith(() =>
        Promise.reject(new Error('account unavailable')),
      );
      expect(await t.store.getState().loadGitHub(item(1))).toEqual(
        itemPreview(1),
      );
      expect(t.store.getState().githubViews[githubPreviewKey(item(1))]).toEqual(
        {
          status: 'ready',
          preview: itemPreview(1),
          checkedAt,
          refreshing: false,
        },
      );
      expect(t.githubReads).toHaveLength(1);
      disposePreviewStore(t.store);
    },
  );

  it('keeps a persisted title on remount through a failed scope check', async () => {
    const t = setup();
    await t.store.getState().loadGitHub(item(1));
    await jest.advanceTimersByTimeAsync(300);
    expect(persistedKeys(t)).toContain(githubPreviewKey(item(1)));
    disposePreviewStore(t.store);
    t.respondGitHubScopeWith(() => Promise.reject(new Error('decrypt failed')));
    const remounted = t.make();
    remounted.getState().ensureGitHubConnection();
    expect(await remounted.getState().loadGitHub(item(1))).toEqual(
      itemPreview(1),
    );
    expect(
      remounted.getState().githubViews[githubPreviewKey(item(1))]?.status,
    ).toBe('ready');
    expect(t.githubReads).toHaveLength(1);
    disposePreviewStore(remounted);
  });

  it('never revives cached data after identity invalidation during a scope failure', async () => {
    const t = setup();
    await t.store.getState().loadGitHub(item(1));
    let rejectScope: (reason: Error) => void = () => undefined;
    t.respondGitHubScopeWith(
      () =>
        new Promise((_resolve, reject) => {
          rejectScope = reject;
        }),
    );
    const pending = t.store.getState().loadGitHub(item(1));
    await flush();
    invalidateReferencePreviews(t.storage, 'github');
    rejectScope(new Error('account unavailable'));
    expect(await pending).toBeNull();
    expect(
      t.store.getState().githubViews[githubPreviewKey(item(1))]?.status,
    ).not.toBe('ready');
    expect(t.githubReads).toHaveLength(1);
    disposePreviewStore(t.store);
  });

  it('does not display expired data or fetch on an inconclusive scope', async () => {
    const t = setup();
    await t.store.getState().loadGitHub(item(1));
    t.advance(8 * 24 * 60 * 60_000);
    t.respondGitHubScopeWith(() =>
      Promise.reject(new Error('account unavailable')),
    );
    expect(await t.store.getState().loadGitHub(item(1))).toBeNull();
    expect(
      t.store.getState().githubViews[githubPreviewKey(item(1))]?.status,
    ).toBe('unavailable');
    expect(t.githubReads).toHaveLength(1);
    disposePreviewStore(t.store);
  });

  it('still removes cached titles on a confirmed disconnected scope', async () => {
    const t = setup();
    await t.store.getState().loadGitHub(item(1));
    t.respondGitHubScopeWith(() => Promise.resolve({ scope: null }));
    expect(await t.store.getState().loadGitHub(item(1))).toBeNull();
    expect(t.store.getState().githubViews[githubPreviewKey(item(1))]).toEqual({
      status: 'unavailable',
      reason: 'disconnected',
    });
    disposePreviewStore(t.store);
  });
});

describe('GitHub enrichment modes', () => {
  afterEach(() => {
    setReferenceEnrichmentModes({ linear: 'replace', github: 'replace' });
  });
  it('resumes a rejected credential check after Off without skipping its cooldown', async () => {
    const t = setup();
    t.setGitHubScope(null, 30_000);
    t.store.getState().ensureGitHubConnection();
    await flush();
    const reads = t.scopeReads.github;
    setReferenceEnrichmentModes({ linear: 'replace', github: 'off' });
    t.advance(100);
    await jest.advanceTimersByTimeAsync(100);
    setReferenceEnrichmentModes({ linear: 'replace', github: 'hover' });
    t.store.getState().ensureGitHubConnection();
    await flush();
    expect(t.scopeReads.github).toBe(reads);
    t.setGitHubScope('github-scope');
    t.advance(29_900);
    await jest.advanceTimersByTimeAsync(29_900);
    expect(t.scopeReads.github).toBe(reads + 1);
    expect(t.store.getState().githubConnected).toBe(true);
    disposePreviewStore(t.store);
    setReferenceEnrichmentModes({ linear: 'replace', github: 'replace' });
  });

  it('gates scope, origin, load and passive watch in Off without blocking Linear', async () => {
    setReferenceEnrichmentModes({ linear: 'replace', github: 'off' });
    const t = setup();
    const origin = {
      kind: 'worktree',
      projectId: 'p1',
      worktreeId: 'w1',
    } as const;
    t.store.getState().ensureGitHubConnection();
    t.store.getState().ensureGitHubOrigin(origin);
    const release = t.store.getState().watchGitHub(item(12));
    expect(await t.store.getState().loadGitHub(item(12))).toBeNull();
    await jest.advanceTimersByTimeAsync(QUEUE.debounceMs + 1);
    expect(t.scopeReads.github).toBe(0);
    expect(t.originReads).toEqual([]);
    expect(t.githubReads).toEqual([]);
    expect(await t.store.getState().load({ identifier: 'CAN-1' })).toEqual(
      linearPreview('CAN-1'),
    );
    release();
    disposePreviewStore(t.store);
  });

  it('keeps true provider invalidation active while Off', async () => {
    const t = setup();
    await t.store.getState().loadGitHub(item(12));
    await t.store.getState().load({ identifier: 'CAN-1' });
    setReferenceEnrichmentModes({ linear: 'replace', github: 'off' });
    invalidateReferencePreviews(t.storage, 'github');
    expect(t.store.getState().githubViews).toEqual({});
    expect(
      t.store.getState().views[linearPreviewKey({ identifier: 'CAN-1' })]
        ?.status,
    ).toBe('ready');
    disposePreviewStore(t.store);
  });

  it('fences a pending origin and permits a new read after Off', async () => {
    const t = setup();
    const pending = deferred<OriginResult>();
    t.respondOriginWith(() => pending.promise);
    const origin = {
      kind: 'worktree',
      projectId: 'p1',
      worktreeId: 'w1',
    } as const;
    t.store.getState().ensureGitHubOrigin(origin);
    setReferenceEnrichmentModes({ linear: 'replace', github: 'off' });
    pending.resolve({ repository: { owner: 'acme', repository: 'canopy' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.store.getState().githubOrigins).toEqual({});
    setReferenceEnrichmentModes({ linear: 'replace', github: 'hover' });
    t.store.getState().ensureGitHubOrigin(origin);
    expect(t.originReads).toHaveLength(2);
    await Promise.resolve();
    await Promise.resolve();
    disposePreviewStore(t.store);
  });
});

describe('GitHub partition', () => {
  it('does not renew a tracked snapshot lifetime when the host reads it', async () => {
    const t = setup();
    t.respondGitHubWith(() =>
      Promise.resolve({
        status: 'ok',
        scope: 'github-a',
        preview: itemPreview(12),
        fetchedAt: t.now() - LIMITS.freshMs + 1_000,
      }),
    );
    await t.store.getState().loadGitHub(item(12));
    t.advance(1_001);
    await t.store.getState().loadGitHub(item(12));
    expect(t.githubReads).toHaveLength(2);
  });

  it.each([NaN, Infinity, 1_000_001, -1, 1_000_000 - LIMITS.retentionMs - 1])(
    'rejects invalid tracked acquisition time %s',
    async (fetchedAt) => {
      const t = setup();
      t.respondGitHubWith(() =>
        Promise.resolve({
          status: 'ok',
          scope: 'github-a',
          preview: itemPreview(12),
          fetchedAt,
        }),
      );
      expect(await t.store.getState().loadGitHub(item(12))).toBeNull();
      expect(
        t.store.getState().githubViews[githubPreviewKey(item(12))],
      ).not.toMatchObject({
        status: 'ready',
      });
    },
  );

  it('namespaces keys apart from Linear and apart across repositories', () => {
    const key = githubPreviewKey(item(12));
    expect(key).not.toBe(githubPreviewKey(item(12, 'other')));
    expect(key).not.toBe(githubPreviewKey(repo()));
    expect(key).not.toBe(linearPreviewKey({ identifier: 'CAN-12' }));
    expect(key.startsWith('github:')).toBe(true);
  });

  it('loads, caches and coalesces one item read', async () => {
    const t = setup();
    const [first] = await Promise.all([
      t.store.getState().loadGitHub(item(12)),
      t.store.getState().loadGitHub(item(12)),
    ]);
    expect(first).toEqual(itemPreview(12));
    await t.store.getState().loadGitHub(item(12));
    expect(t.githubReads).toEqual([githubPreviewKey(item(12))]);
    expect(
      t.store.getState().githubViews[githubPreviewKey(item(12))],
    ).toMatchObject({ status: 'ready', preview: itemPreview(12) });
    expect(t.store.getState().views).toEqual({});
  });

  it('keeps two repositories that share a number distinct', async () => {
    const t = setup();
    await t.store.getState().loadGitHub(item(7, 'canopy'));
    await t.store.getState().loadGitHub(item(7, 'website'));
    expect(t.githubReads).toHaveLength(2);
    const views = t.store.getState().githubViews;
    const first = views[githubPreviewKey(item(7, 'canopy'))];
    const second = views[githubPreviewKey(item(7, 'website'))];
    expect(first?.status === 'ready' && first.preview.url).toBe(
      'https://github.com/acme/canopy/pull/7',
    );
    expect(second?.status === 'ready' && second.preview.url).toBe(
      'https://github.com/acme/website/pull/7',
    );
  });

  it('reports title slots for items and repositories', async () => {
    const t = setup();
    expect(githubTitleSlot(undefined)).toEqual({
      kind: 'pending',
      reading: false,
    });
    expect(githubTitleSlot({ status: 'loading' })).toEqual({
      kind: 'pending',
      reading: true,
    });
    await t.store.getState().loadGitHub(item(3));
    expect(
      githubTitleSlot(
        t.store.getState().githubViews[githubPreviewKey(item(3))],
      ),
    ).toEqual({ kind: 'title', title: 'Item 3' });
    await t.store.getState().loadGitHub(repo());
    expect(
      githubTitleSlot(t.store.getState().githubViews[githubPreviewKey(repo())]),
    ).toEqual({ kind: 'title', title: 'Agentic desktop' });
    const bare = {
      status: 'ready',
      preview: repoPreview('bare', null),
      checkedAt: 0,
      refreshing: false,
    } as const;
    expect(githubTitleSlot(bare)).toEqual({ kind: 'none' });
    for (const reason of ['disconnected', 'unavailable', 'failed'] as const) {
      expect(githubTitleSlot({ status: 'unavailable', reason })).toEqual({
        kind: 'none',
      });
    }
  });

  it('leaves no placeholder after disconnected, unavailable or failed reads', async () => {
    const t = setup();
    t.respondGitHubWith(() =>
      Promise.resolve({ status: 'unavailable', scope: 'github-a' }),
    );
    await t.store.getState().loadGitHub(item(1));
    t.respondGitHubWith(() => Promise.resolve({ status: 'failed' }));
    await t.store.getState().loadGitHub(item(2));
    const slot = (number: number): unknown =>
      githubTitleSlot(
        t.store.getState().githubViews[githubPreviewKey(item(number))],
      );
    expect(slot(1)).toEqual({ kind: 'none' });
    expect(slot(2)).toEqual({ kind: 'none' });
    t.store.getState().ensureGitHubConnection();
    await flush();
    expect(t.store.getState().githubConnected).toBe(true);
    t.setGitHubScope(null);
    await t.store.getState().loadGitHub(item(3));
    expect(slot(3)).toEqual({ kind: 'none' });
    // The disconnect resets the partition, so connection is re-checked.
    expect(t.store.getState().githubConnected).toBe(false);
  });

  it('reports the local connection without a provider read', async () => {
    const t = setup();
    expect(t.store.getState().githubConnected).toBe(false);
    t.store.getState().ensureGitHubConnection();
    t.store.getState().ensureGitHubConnection();
    await flush();
    expect(t.scopeReads.github).toBe(1);
    expect(t.store.getState().githubConnected).toBe(true);
    expect(t.githubReads).toEqual([]);
    expect(t.scopeReads.linear).toBe(0);
  });

  it('discards a late result after a GitHub scope change or invalidation', async () => {
    const t = setup();
    const late = deferred<GitHubPreviewResult>();
    t.respondGitHubWith(() => late.promise);
    const load = t.store.getState().loadGitHub(item(5));
    await flush();
    expect(t.store.getState().githubViews[githubPreviewKey(item(5))]).toEqual({
      status: 'loading',
    });
    invalidateReferencePreviews(t.storage, 'github');
    late.resolve({ status: 'ok', scope: 'github-a', preview: itemPreview(5) });
    expect(await load).toBeNull();
    expect(t.store.getState().githubViews).toEqual({});
    jest.runOnlyPendingTimers();
    expect(persistedKeys(t)).not.toContain(githubPreviewKey(item(5)));
  });

  it('discards a late result once another read adopts a new GitHub scope', async () => {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-1' });
    const late = deferred<GitHubPreviewResult>();
    t.respondGitHubWith(() => late.promise);
    const first = t.store.getState().loadGitHub(item(5));
    await flush();
    t.setGitHubScope('github-b');
    t.respondGitHubWith((target) =>
      Promise.resolve({
        status: 'ok',
        scope: 'github-b',
        preview: previewFor(target),
      }),
    );
    await t.store.getState().loadGitHub(item(6));
    late.resolve({ status: 'ok', scope: 'github-a', preview: itemPreview(5) });
    expect(await first).toBeNull();
    expect(Object.keys(t.store.getState().githubViews)).toEqual([
      githubPreviewKey(item(6)),
    ]);
    expect(t.store.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
    });
  });

  it('resets only GitHub when a result arrives for another GitHub scope', async () => {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-1' });
    await t.store.getState().loadGitHub(item(1));
    const epoch = t.store.getState().epoch;
    t.respondGitHubWith((target) =>
      Promise.resolve({
        status: 'ok',
        scope: 'github-b',
        preview: previewFor(target),
      }),
    );
    t.advance(LIMITS.freshMs + 1);
    expect(await t.store.getState().loadGitHub(item(1))).toBeNull();
    expect(t.store.getState().githubViews).toEqual({});
    expect(t.store.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
    });
    expect(t.store.getState().epoch).toBe(epoch);
  });

  it('pauses only GitHub reads for a GitHub Retry-After', async () => {
    const t = setup();
    t.respondGitHubWith(() =>
      Promise.resolve({ status: 'rate-limited', retryAfterMs: 30_000 }),
    );
    await t.store.getState().loadGitHub(item(1));
    t.respondGitHubWith((target) =>
      Promise.resolve({
        status: 'ok',
        scope: 'github-a',
        preview: previewFor(target),
      }),
    );
    expect(await t.store.getState().loadGitHub(item(2))).toBeNull();
    expect(t.githubReads).toHaveLength(1);
    // Linear is not paused by GitHub's limit.
    expect(
      await t.store.getState().load({ identifier: 'CAN-1' }),
    ).not.toBeNull();
    t.advance(30_001);
    expect(await t.store.getState().loadGitHub(item(2))).not.toBeNull();
    expect(t.githubReads).toHaveLength(2);
  });

  it('does not pause GitHub for a Linear Retry-After', async () => {
    const t = setup();
    t.respondLinearWith(() =>
      Promise.resolve({ status: 'rate-limited', retryAfterMs: 30_000 }),
    );
    await t.store.getState().load({ identifier: 'CAN-1' });
    expect(await t.store.getState().loadGitHub(item(1))).not.toBeNull();
  });

  it('queues GitHub references through the visibility queue while Linear is paused', async () => {
    const t = setup();
    t.respondLinearWith(() =>
      Promise.resolve({ status: 'rate-limited', retryAfterMs: 30_000 }),
    );
    await t.store.getState().load({ identifier: 'CAN-1' });
    t.store.getState().watch({ identifier: 'CAN-2' });
    const release = t.store.getState().watchGitHub(item(9));
    t.advance(QUEUE.debounceMs - 1);
    jest.advanceTimersByTime(QUEUE.debounceMs - 1);
    await flush();
    expect(t.githubReads).toEqual([]);
    t.advance(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(t.githubReads).toEqual([githubPreviewKey(item(9))]);
    expect(t.linearReads).toEqual(['CAN-1']);
    release();
  });

  it('a paused provider never fills the pending queue for the other provider', async () => {
    const t = setup();
    t.respondGitHubWith(() =>
      Promise.resolve({ status: 'rate-limited', retryAfterMs: 30_000 }),
    );
    await t.store.getState().loadGitHub(item(1));
    const reads = t.githubReads.length;
    const releases = Array.from({ length: QUEUE.pending + 5 }, (_, index) =>
      t.store.getState().watchGitHub(item(100 + index)),
    );
    t.advance(QUEUE.debounceMs);
    jest.advanceTimersByTime(QUEUE.debounceMs);
    await flush();
    expect(t.githubReads).toHaveLength(reads);
    const release = t.store.getState().watch({ identifier: 'CAN-7' });
    t.advance(QUEUE.debounceMs);
    jest.advanceTimersByTime(QUEUE.debounceMs);
    await flush();
    expect(t.linearReads).toContain('CAN-7');
    // GitHub resumes once its pause lifts.
    t.respondGitHubWith((target) =>
      Promise.resolve({
        status: 'ok',
        scope: 'github-a',
        preview: previewFor(target),
      }),
    );
    t.advance(30_000);
    jest.advanceTimersByTime(30_000);
    await flush();
    expect(t.githubReads.length).toBeGreaterThan(reads);
    release();
    releases.forEach((done) => done());
  });

  it('frees the queue slots of references released mid-read when a provider resets', async () => {
    const t = setup();
    const held: (() => void)[] = [];
    t.respondGitHubWith(
      (target) =>
        new Promise((resolve) => {
          held.push(() =>
            resolve({
              status: 'ok',
              scope: 'github-a',
              preview: previewFor(target),
            }),
          );
        }),
    );
    const releases = [1, 2].map((n) => t.store.getState().watchGitHub(item(n)));
    t.advance(QUEUE.debounceMs);
    jest.advanceTimersByTime(QUEUE.debounceMs);
    await flush();
    expect(t.githubReads).toHaveLength(QUEUE.concurrent);
    releases.forEach((release) => release());
    invalidateReferencePreviews(t.storage, 'github');
    held.forEach((settle) => settle());
    await flush();
    t.respondGitHubWith((target) =>
      Promise.resolve({
        status: 'ok',
        scope: 'github-a',
        preview: previewFor(target),
      }),
    );
    const release = t.store.getState().watchGitHub(item(3));
    t.advance(QUEUE.debounceMs);
    jest.advanceTimersByTime(QUEUE.debounceMs);
    await flush();
    expect(t.githubReads).toContain(githubPreviewKey(item(3)));
    release();
  });
});

describe('GitHub origins', () => {
  it('resolves one origin once per store and caches null results', async () => {
    const t = setup();
    const origin = {
      kind: 'worktree',
      projectId: 'p1',
      worktreeId: 'w1',
    } as const;
    t.store.getState().ensureGitHubOrigin(origin);
    t.store.getState().ensureGitHubOrigin(origin);
    expect(t.originReads).toHaveLength(1);
    await flush();
    expect(t.store.getState().githubOrigins['p1\0w1']).toEqual({
      owner: 'acme',
      repository: 'canopy',
    });
    t.respondOriginWith(() => Promise.resolve({ repository: null }));
    t.store.getState().ensureGitHubOrigin({
      kind: 'worktree',
      projectId: 'p1',
      worktreeId: 'w2',
    });
    await flush();
    expect(t.store.getState().githubOrigins['p1\0w2']).toBeNull();
    t.store.getState().ensureGitHubOrigin({
      kind: 'worktree',
      projectId: 'p1',
      worktreeId: 'w2',
    });
    t.store.getState().ensureGitHubOrigin(origin);
    expect(t.originReads).toHaveLength(2);
  });

  it('never queries a cowork origin', () => {
    const t = setup();
    t.store.getState().ensureGitHubOrigin({ kind: 'cowork' });
    expect(t.originReads).toEqual([]);
  });

  it('resolves a failed or malformed origin to null', async () => {
    const t = setup();
    t.respondOriginWith(() => Promise.reject(new Error('ipc down')));
    t.store.getState().ensureGitHubOrigin({
      kind: 'worktree',
      projectId: 'p',
      worktreeId: 'a',
    });
    t.respondOriginWith(() =>
      Promise.resolve({ repository: { owner: 'Bad Owner', repository: 'x' } }),
    );
    t.store.getState().ensureGitHubOrigin({
      kind: 'worktree',
      projectId: 'p',
      worktreeId: 'b',
    });
    await flush();
    expect(t.store.getState().githubOrigins).toEqual({
      'p\0a': null,
      'p\0b': null,
    });
  });

  it('keeps resolved origins through a GitHub invalidation', async () => {
    const t = setup();
    t.store.getState().ensureGitHubOrigin({
      kind: 'worktree',
      projectId: 'p',
      worktreeId: 'a',
    });
    await flush();
    invalidateReferencePreviews(t.storage, 'github');
    expect(t.store.getState().githubOrigins['p\0a']).toEqual({
      owner: 'acme',
      repository: 'canopy',
    });
  });
});

describe('persisted GitHub entries', () => {
  it('retains a restored origin when the local host revalidation rejects', async () => {
    const t = await seeded();
    const origin = {
      kind: 'worktree' as const,
      projectId: 'p',
      worktreeId: 'a',
    };
    t.store.getState().ensureGitHubOrigin(origin);
    await flush();
    jest.advanceTimersByTime(250);
    const restarted = t.make();
    t.respondOriginWith(() =>
      Promise.reject(new Error('temporary IPC failure')),
    );
    restarted.getState().ensureGitHubOrigin(origin);
    await flush();
    expect(restarted.getState().githubOrigins['p\0a']).toEqual({
      owner: 'acme',
      repository: 'canopy',
    });
  });

  it('expires a restored origin after rejected revalidation and allows a new host read', async () => {
    const t = await seeded();
    const origin = {
      kind: 'worktree' as const,
      projectId: 'p',
      worktreeId: 'a',
    };
    t.store.getState().ensureGitHubOrigin(origin);
    await flush();
    jest.advanceTimersByTime(250);
    disposePreviewStore(t.store);
    t.advance(LIMITS.retentionMs - 1);
    const restarted = t.make();
    t.respondOriginWith(() => Promise.reject(new Error('host unavailable')));
    restarted.getState().ensureGitHubOrigin(origin);
    await flush();
    expect(restarted.getState().githubOrigins['p\0a']).toEqual({
      owner: 'acme',
      repository: 'canopy',
    });
    t.advance(2);
    jest.advanceTimersByTime(2);
    expect(restarted.getState().githubOrigins['p\0a']).toBeUndefined();
    t.respondOriginWith(() =>
      Promise.resolve({ repository: { owner: 'new', repository: 'remote' } }),
    );
    restarted.getState().ensureGitHubOrigin(origin);
    await flush();
    expect(t.originReads).toHaveLength(3);
    expect(restarted.getState().githubOrigins['p\0a']).toEqual({
      owner: 'new',
      repository: 'remote',
    });
    disposePreviewStore(restarted);
  });

  it('drops an origin while its host read is held and does not resurrect it on a late rejection', async () => {
    const t = await seeded();
    const origin = {
      kind: 'worktree' as const,
      projectId: 'p',
      worktreeId: 'a',
    };
    t.store.getState().ensureGitHubOrigin(origin);
    await flush();
    jest.advanceTimersByTime(250);
    disposePreviewStore(t.store);
    t.advance(LIMITS.retentionMs - 1);
    const held = deferred<OriginResult>();
    t.respondOriginWith(() => held.promise);
    const restarted = t.make();
    restarted.getState().ensureGitHubOrigin(origin);
    t.advance(2);
    jest.advanceTimersByTime(2);
    expect(restarted.getState().githubOrigins['p\0a']).toBeUndefined();
    restarted.getState().ensureGitHubOrigin(origin);
    expect(t.originReads).toHaveLength(2);
    held.reject(new Error('host still unavailable'));
    await flush();
    expect(restarted.getState().githubOrigins['p\0a']).toBeNull();
    disposePreviewStore(restarted);
  });

  it('does not retain an expired origin when a delayed rejection beats its timer', async () => {
    const t = await seeded();
    const origin = {
      kind: 'worktree' as const,
      projectId: 'p',
      worktreeId: 'a',
    };
    t.store.getState().ensureGitHubOrigin(origin);
    await flush();
    jest.advanceTimersByTime(250);
    disposePreviewStore(t.store);
    t.advance(LIMITS.retentionMs - 1);
    const held = deferred<OriginResult>();
    t.respondOriginWith(() => held.promise);
    const restarted = t.make();
    restarted.getState().ensureGitHubOrigin(origin);
    t.advance(2);
    held.reject(new Error('host unavailable after retention'));
    await flush();
    expect(restarted.getState().githubOrigins['p\0a']).toBeNull();
    disposePreviewStore(restarted);
  });

  it('does not leave a published origin behind when its retention metadata is evicted', async () => {
    const t = setup();
    for (let index = 0; index <= LIMITS.maxEntries; index += 1) {
      t.store.getState().ensureGitHubOrigin({
        kind: 'worktree',
        projectId: 'p',
        worktreeId: String(index),
      });
      await flush();
    }
    expect(t.store.getState().githubOrigins[`p\0${0}`]).toBeUndefined();
    expect(Object.keys(t.store.getState().githubOrigins)).toHaveLength(
      LIMITS.maxEntries,
    );
  });

  it('does not publish or schedule origin retention after the store is disposed', async () => {
    const t = setup();
    const held = deferred<OriginResult>();
    t.respondOriginWith(() => held.promise);
    t.store.getState().ensureGitHubOrigin({
      kind: 'worktree',
      projectId: 'p',
      worktreeId: 'a',
    });
    disposePreviewStore(t.store);
    held.resolve({ repository: { owner: 'acme', repository: 'canopy' } });
    await flush();
    expect(t.store.getState().githubOrigins['p\0a']).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('uses a successful origin revalidation timestamp instead of the restored deadline', async () => {
    const t = await seeded();
    const origin = {
      kind: 'worktree' as const,
      projectId: 'p',
      worktreeId: 'a',
    };
    t.store.getState().ensureGitHubOrigin(origin);
    await flush();
    jest.advanceTimersByTime(250);
    disposePreviewStore(t.store);
    t.advance(LIMITS.retentionMs - 1);
    const restarted = t.make();
    t.respondOriginWith(() =>
      Promise.resolve({ repository: { owner: 'new', repository: 'remote' } }),
    );
    restarted.getState().ensureGitHubOrigin(origin);
    await flush();
    t.advance(2);
    jest.advanceTimersByTime(2);
    expect(restarted.getState().githubOrigins['p\0a']).toEqual({
      owner: 'new',
      repository: 'remote',
    });
    disposePreviewStore(restarted);
  });

  it.each([
    {
      label: 'corrupt',
      value: {
        key: 'p\0a',
        repository: { owner: 'Bad Owner', repository: 'x' },
        checkedAt: 1_000_000,
      },
    },
    {
      label: 'future',
      value: { key: 'p\0a', repository: null, checkedAt: 1_000_001 },
    },
    {
      label: 'expired',
      value: {
        key: 'p\0a',
        repository: null,
        checkedAt: 1_000_000 - LIMITS.retentionMs - 1,
      },
    },
  ])(
    'rejects $label persisted origin metadata without losing valid titles',
    async ({ value, label }) => {
      const t = await seeded();
      t.advance(LIMITS.retentionMs * 2);
      await t.store.getState().loadGitHub(item(12));
      jest.advanceTimersByTime(250);
      const checkedAt =
        label === 'expired'
          ? t.now() - LIMITS.retentionMs - 1
          : label === 'future'
            ? t.now() + 1
            : t.now();
      t.storage.setItem(
        REFERENCE_PREVIEW_STORAGE_KEY,
        JSON.stringify({ ...persisted(t), origins: [{ ...value, checkedAt }] }),
      );
      const restarted = t.make();
      expect(restarted.getState().githubOrigins).toEqual({});
      expect(
        githubTitleSlot(
          restarted.getState().githubViews[githubPreviewKey(item(12))],
        ),
      ).toEqual({ kind: 'title', title: 'Item 12' });
    },
  );

  it.each([
    {
      label: 'single repository',
      repository: { owner: 'acme', repository: 'canopy' },
    },
    { label: 'ambiguous repository', repository: null },
  ])(
    'restores $label origin before a held host revalidation',
    async ({ repository }) => {
      const t = await seeded();
      const origin = {
        kind: 'worktree' as const,
        projectId: 'p',
        worktreeId: 'a',
      };
      t.respondOriginWith(() => Promise.resolve({ repository }));
      t.store.getState().ensureGitHubOrigin(origin);
      await flush();
      jest.advanceTimersByTime(250);
      const held = deferred<OriginResult>();
      t.respondOriginWith(() => held.promise);
      const restarted = t.make();
      expect(restarted.getState().githubOrigins['p\0a']).toEqual(repository);
      restarted.getState().ensureGitHubOrigin(origin);
      await flush();
      expect(restarted.getState().githubOrigins['p\0a']).toEqual(repository);
      held.resolve({ repository: null });
      await flush();
      expect(restarted.getState().githubOrigins['p\0a']).toBeNull();
    },
  );

  async function seeded(): Promise<Harness> {
    const t = setup();
    await t.store.getState().load({ identifier: 'CAN-1' });
    t.advance(1);
    await t.store.getState().loadGitHub(item(12));
    t.advance(1);
    await t.store.getState().loadGitHub(repo());
    t.store.getState().ensureTeamCatalog();
    t.store.getState().ensureGitHubConnection();
    await flush();
    jest.advanceTimersByTime(250);
    return t;
  }

  it('persists a provider tag and the GitHub scope in the shared record', async () => {
    const t = await seeded();
    const record = persisted(t);
    expect(record.scope).toBe('linear-a');
    expect(record.githubScope).toBe('github-a');
    const providers = Array.isArray(record.entries)
      ? record.entries.map((entry: unknown): unknown =>
          typeof entry === 'object' && entry !== null
            ? Reflect.get(entry, 'provider')
            : null,
        )
      : [];
    expect(providers.sort()).toEqual(['github', 'github', 'linear']);
  });

  it('paints saved GitHub titles at creation without any query', async () => {
    const t = await seeded();
    const reads = t.githubReads.length + t.scopeReads.github;
    const restarted = t.make();
    expect(restarted.getState().githubConnected).toBe(true);
    expect(
      githubTitleSlot(
        restarted.getState().githubViews[githubPreviewKey(item(12))],
      ),
    ).toEqual({ kind: 'title', title: 'Item 12' });
    expect(
      githubTitleSlot(
        restarted.getState().githubViews[githubPreviewKey(repo())],
      ),
    ).toEqual({ kind: 'title', title: 'Agentic desktop' });
    expect(restarted.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
    });
    expect(t.githubReads.length + t.scopeReads.github).toBe(reads);
  });

  it('confirms the saved GitHub scope in the background and purges GitHub, not Linear, in every window on mismatch', async () => {
    const t = await seeded();
    t.setGitHubScope('github-b');
    const restarted = t.make();
    const other = t.make();
    restarted.getState().ensureGitHubConnection();
    await flush();
    expect(restarted.getState().githubViews).toEqual({});
    expect(restarted.getState().githubConnected).toBe(true);
    expect(restarted.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
    });
    jest.runOnlyPendingTimers();
    const record = persisted(t);
    expect(record.scope).toBe('linear-a');
    expect(persistedKeys(t)).toEqual(['*/CAN-1']);
    // The disowned scope's titles were shown, so every window purges GitHub
    // (as CAN-3978 does for Linear) and keeps Linear.
    expect(other.getState().githubViews).toEqual({});
    expect(other.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
    });
  });

  it('a disowned saved GitHub scope resets GitHub in every window, not Linear', async () => {
    const t = await seeded();
    t.setGitHubScope(null);
    const restarted = t.make();
    const other = t.make();
    restarted.getState().ensureGitHubConnection();
    await flush();
    expect(restarted.getState().githubConnected).toBe(false);
    expect(other.getState().githubViews).toEqual({});
    expect(other.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
    });
    expect(other.getState().teamCatalog.keys).not.toBeNull();
    jest.runOnlyPendingTimers();
    expect(persisted(t).githubScope).toBeUndefined();
    expect(persisted(t).scope).toBe('linear-a');
    expect(persistedKeys(t)).toEqual(['*/CAN-1']);
  });

  it('restores a pull request with its avatar and facts', () => {
    const t = setup();
    const preview = {
      ...itemPreview(1),
      authorAvatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      pull: PULL_FACTS,
    };
    t.storage.setItem(
      REFERENCE_PREVIEW_STORAGE_KEY,
      JSON.stringify({
        githubScope: 'github-a',
        entries: [
          {
            provider: 'github',
            scope: 'github-a',
            key: githubPreviewKey(item(1)),
            checkedAt: 1_000_000,
            usedAt: 1_000_000,
            preview,
          },
        ],
      }),
    );
    expect(
      t.make().getState().githubViews[githubPreviewKey(item(1))],
    ).toMatchObject({ status: 'ready', preview });
  });

  it('drops a malformed GitHub entry while Linear entries survive', () => {
    const t = setup();
    const valid = {
      provider: 'github',
      scope: 'github-a',
      key: githubPreviewKey(item(1)),
      checkedAt: 1_000_000,
      usedAt: 1_000_000,
      preview: itemPreview(1),
    };
    const malformed: unknown[] = [
      {
        ...valid,
        preview: { ...itemPreview(2), url: 'https://evil.test/x' },
        key: githubPreviewKey(item(2)),
      },
      {
        ...valid,
        preview: { ...itemPreview(3), state: 'draft' },
        key: githubPreviewKey(item(3)),
      },
      {
        ...valid,
        preview: { ...itemPreview(4), number: 0 },
        key: githubPreviewKey(item(4)),
      },
      {
        ...valid,
        preview: { ...itemPreview(5), owner: 'Acme' },
        key: githubPreviewKey(item(5)),
      },
      {
        ...valid,
        preview: { ...itemPreview(6), title: 'x'.repeat(513) },
        key: githubPreviewKey(item(6)),
      },
      {
        ...valid,
        preview: { ...itemPreview(7), itemType: 'discussion' },
        key: githubPreviewKey(item(7)),
      },
      {
        ...valid,
        preview: { ...itemPreview(8), draft: 'no' },
        key: githubPreviewKey(item(8)),
      },
      {
        ...valid,
        preview: { ...itemPreview(9), author: 9 },
        key: githubPreviewKey(item(9)),
      },
      {
        ...valid,
        preview: { ...repoPreview('r'), private: 'yes' },
        key: githubPreviewKey(repo('r')),
      },
      // A preview filed under another target's key never paints.
      { ...valid, preview: itemPreview(10), key: githubPreviewKey(item(11)) },
      // The card loads only a GitHub avatar and draws only well-formed facts.
      {
        ...valid,
        preview: {
          ...itemPreview(12),
          authorAvatarUrl: 'https://evil.test/a.png',
        },
        key: githubPreviewKey(item(12)),
      },
      {
        ...valid,
        preview: { ...itemPreview(13), pull: { ...PULL_FACTS, additions: -1 } },
        key: githubPreviewKey(item(13)),
      },
      {
        ...valid,
        preview: { ...itemPreview(14), pull: { ...PULL_FACTS, checks: 'red' } },
        key: githubPreviewKey(item(14)),
      },
    ];
    t.storage.setItem(
      REFERENCE_PREVIEW_STORAGE_KEY,
      JSON.stringify({
        scope: 'linear-a',
        githubScope: 'github-a',
        entries: [
          {
            scope: 'linear-a',
            key: '*/CAN-1',
            checkedAt: 1_000_000,
            usedAt: 1_000_000,
            preview: linearPreview('CAN-1'),
          },
          valid,
          ...malformed,
        ],
      }),
    );
    const restarted = t.make();
    expect(Object.keys(restarted.getState().githubViews)).toEqual([
      githubPreviewKey(item(1)),
    ]);
    expect(Object.keys(restarted.getState().views)).toEqual(['*/CAN-1']);
    jest.runOnlyPendingTimers();
    expect(persistedKeys(t).sort()).toEqual(
      ['*/CAN-1', githubPreviewKey(item(1))].sort(),
    );
  });
});

describe('provider-specific invalidation', () => {
  async function both(t: Harness): Promise<void> {
    await t.store.getState().load({ identifier: 'CAN-1' });
    await t.store.getState().loadGitHub(item(1));
    t.store.getState().ensureTeamCatalog();
    t.store.getState().ensureGitHubConnection();
    await flush();
    jest.advanceTimersByTime(250);
  }

  it('a GitHub invalidation keeps Linear views, catalog, entries and epoch', async () => {
    const t = setup();
    await both(t);
    const { epoch, githubEpoch } = t.store.getState();
    invalidateReferencePreviews(t.storage, 'github');
    const state = t.store.getState();
    expect(state.githubViews).toEqual({});
    expect(state.githubConnected).toBe(false);
    expect(state.githubEpoch).toBe(githubEpoch + 1);
    expect(state.epoch).toBe(epoch);
    expect(state.views['*/CAN-1']).toMatchObject({ status: 'ready' });
    expect(state.teamCatalog.status).toBe('ready');
    expect(persisted(t).scope).toBe('linear-a');
    expect(persisted(t).githubScope).toBeUndefined();
    expect(persistedKeys(t)).toEqual(['*/CAN-1']);
    expect(t.storage.getItem(REFERENCE_PREVIEW_RESET_KEY)).toMatch(/^github:/);
    // Linear is still served from cache.
    await t.store.getState().load({ identifier: 'CAN-1' });
    expect(t.linearReads).toEqual(['CAN-1']);
  });

  it('a Linear invalidation keeps GitHub views, entries and epoch', async () => {
    const t = setup();
    await both(t);
    const { epoch, githubEpoch } = t.store.getState();
    invalidateReferencePreviews(t.storage, 'linear');
    const state = t.store.getState();
    expect(state.views).toEqual({});
    expect(state.teamCatalog.keys).toBeNull();
    expect(state.epoch).toBe(epoch + 1);
    expect(state.githubEpoch).toBe(githubEpoch);
    expect(state.githubConnected).toBe(true);
    expect(state.githubViews[githubPreviewKey(item(1))]).toMatchObject({
      status: 'ready',
    });
    expect(persisted(t).scope).toBeUndefined();
    expect(persisted(t).catalog).toBeUndefined();
    expect(persisted(t).githubScope).toBe('github-a');
    expect(persistedKeys(t)).toEqual([githubPreviewKey(item(1))]);
    await t.store.getState().loadGitHub(item(1));
    expect(t.githubReads).toHaveLength(1);
  });

  it('a full invalidation still clears both partitions', async () => {
    const t = setup();
    await both(t);
    invalidateReferencePreviews(t.storage);
    expect(t.store.getState().views).toEqual({});
    expect(t.store.getState().githubViews).toEqual({});
    expect(t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ['github', 'views', 'githubViews'],
    ['linear', 'githubViews', 'views'],
  ] as const)(
    'another window resetting %s resets only that partition here',
    async (provider, kept, cleared) => {
      const t = setup();
      await both(t);
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: REFERENCE_PREVIEW_RESET_KEY,
          newValue: `${provider}:1:0.5`,
        }),
      );
      expect(Object.keys(t.store.getState()[kept])).toHaveLength(1);
      expect(t.store.getState()[cleared]).toEqual({});
    },
  );

  it.each([
    ['github', 'views', 'githubViews'],
    ['linear', 'githubViews', 'views'],
  ] as const)(
    'another window removing the record for a %s reset keeps the other partition',
    async (provider, kept, cleared) => {
      const t = setup();
      await both(t);
      // A provider-scoped reset that left nothing behind names the provider
      // in the reset key, then removes the record.
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: REFERENCE_PREVIEW_RESET_KEY,
          newValue: `${provider}:1:0.5`,
        }),
      );
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: REFERENCE_PREVIEW_STORAGE_KEY,
          newValue: null,
        }),
      );
      expect(Object.keys(t.store.getState()[kept])).toHaveLength(1);
      expect(t.store.getState()[cleared]).toEqual({});
    },
  );

  it('a malformed saved record still broadcasts the provider reset', () => {
    const storage = new MemoryStorage();
    storage.setItem(REFERENCE_PREVIEW_STORAGE_KEY, '{not json');
    invalidateReferencePreviews(storage, 'github');
    expect(storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(REFERENCE_PREVIEW_RESET_KEY)).toMatch(/^github:/);
  });

  it('an older or unknown reset value resets everything', async () => {
    const t = setup();
    await both(t);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: REFERENCE_PREVIEW_RESET_KEY,
        newValue: '1700000000000:0.25',
      }),
    );
    expect(t.store.getState().views).toEqual({});
    expect(t.store.getState().githubViews).toEqual({});
  });

  it('a GitHub disconnect result invalidates GitHub only', async () => {
    const t = setup();
    await both(t);
    const other = t.make();
    await other.getState().loadGitHub(item(1));
    await other.getState().load({ identifier: 'CAN-1' });
    t.advance(LIMITS.freshMs + 1);
    t.respondGitHubWith(() => Promise.resolve({ status: 'disconnected' }));
    await t.store.getState().loadGitHub(item(1));
    expect(other.getState().githubViews).toEqual({});
    expect(other.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
    });
    expect(t.store.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
    });
  });

  it('a Linear disconnect result invalidates Linear only', async () => {
    const t = setup();
    await both(t);
    t.advance(LIMITS.freshMs + 1);
    t.respondLinearWith(() => Promise.resolve({ status: 'disconnected' }));
    await t.store.getState().load({ identifier: 'CAN-1' });
    expect(
      t.store.getState().githubViews[githubPreviewKey(item(1))],
    ).toMatchObject({ status: 'ready' });
    expect(t.store.getState().githubConnected).toBe(true);
  });
});

describe('shared cache budget', () => {
  it('bounds Linear and GitHub entries together and evicts the least recently shown of either', async () => {
    const t = setup();
    const half = LIMITS.maxEntries / 2;
    for (let index = 0; index < half; index += 1) {
      t.advance(1);
      await t.store.getState().load({ identifier: `CAN-${index}` });
      t.advance(1);
      await t.store.getState().loadGitHub(item(index + 1));
    }
    // CAN-0 is the oldest; show it so GitHub #1 becomes the least recently shown.
    t.advance(61_000);
    t.store.getState().watch({ identifier: 'CAN-0' })();
    t.advance(1);
    await t.store.getState().loadGitHub(item(5000));
    const state = t.store.getState();
    expect(state.views['*/CAN-0']).toMatchObject({ status: 'ready' });
    expect(state.githubViews[githubPreviewKey(item(1))]).toBeUndefined();
    t.advance(1);
    await t.store.getState().load({ identifier: 'ECW-1' });
    expect(t.store.getState().views['*/CAN-1']).toBeUndefined();
    const ready =
      Object.values(t.store.getState().views).filter(
        (view) => view.status === 'ready',
      ).length +
      Object.values(t.store.getState().githubViews).filter(
        (view) => view.status === 'ready',
      ).length;
    expect(ready).toBe(LIMITS.maxEntries);
    jest.runOnlyPendingTimers();
    const keys = persistedKeys(t);
    expect(keys).toHaveLength(LIMITS.maxEntries);
    expect(keys).toContain('*/CAN-0');
    expect(keys).not.toContain(githubPreviewKey(item(1)));
    expect(keys).not.toContain('*/CAN-1');
  });

  it('holds the serialized size bound across providers', async () => {
    const t = setup();
    t.respondGitHubWith((target) =>
      Promise.resolve({
        status: 'ok',
        scope: 'github-a',
        preview:
          target.kind === 'item'
            ? itemPreview(target.number, target.repository, 'y'.repeat(500))
            : repoPreview(target.repository),
      }),
    );
    t.respondLinearWith((identifier) =>
      Promise.resolve({
        status: 'ok',
        scope: 'linear-a',
        preview: {
          ...linearPreview(identifier),
          description: 'x'.repeat(4_000),
        },
      }),
    );
    for (let index = 0; index < 300; index += 1) {
      await t.store.getState().load({ identifier: `CAN-${index}` });
      await t.store.getState().loadGitHub(item(index + 1));
    }
    jest.runOnlyPendingTimers();
    const raw = t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? '';
    expect(raw.length).toBeLessThanOrEqual(LIMITS.maxSerializedChars);
    expect(persistedKeys(t).some((key) => key.startsWith('github:'))).toBe(
      true,
    );
    expect(persistedKeys(t).some((key) => key.startsWith('*/'))).toBe(true);
  });
});

describe('provider-scoped invalidation of the saved record', () => {
  it('removes the record when one provider was the only one saved', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      REFERENCE_PREVIEW_STORAGE_KEY,
      JSON.stringify({ scope: 'linear-a', entries: [] }),
    );
    invalidateReferencePreviews(storage, 'linear');
    expect(storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(REFERENCE_PREVIEW_RESET_KEY)).toMatch(/^linear:/);
  });

  it('keeps the other provider when it still has a scope', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      REFERENCE_PREVIEW_STORAGE_KEY,
      JSON.stringify({ scope: 'linear-a', githubScope: 'gh-a', entries: [] }),
    );
    invalidateReferencePreviews(storage, 'linear');
    expect(
      JSON.parse(storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY) ?? 'null'),
    ).toEqual({ githubScope: 'gh-a', entries: [] });
  });
});

describe('GitHub recovery after a rejected credential', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('checks the scope again when the host says the quarantine ends', async () => {
    const t = setup();
    t.respondGitHubWith(() => Promise.resolve({ status: 'disconnected' }));
    await t.store.getState().loadGitHub(item(1));
    t.setGitHubScope(null, LIMITS.freshMs);
    t.store.getState().ensureGitHubConnection();
    await flush();
    expect(t.store.getState().githubConnected).toBe(false);
    t.setGitHubScope('github-a');
    t.advance(LIMITS.freshMs);
    jest.advanceTimersByTime(LIMITS.freshMs);
    await flush();
    expect(t.store.getState().githubConnected).toBe(true);
  });

  it('recovers a window that never saw the rejected read', async () => {
    const t = setup();
    // Another window got the 401; this one starts during the quarantine.
    t.setGitHubScope(null, 90_000);
    const other = t.make();
    other.getState().ensureGitHubConnection();
    await flush();
    expect(other.getState().githubConnected).toBe(false);
    t.setGitHubScope('github-a');
    t.advance(90_000);
    jest.advanceTimersByTime(90_000);
    await flush();
    expect(other.getState().githubConnected).toBe(true);
  });

  it('does not keep checking a credential that is simply absent', async () => {
    const t = setup();
    t.setGitHubScope(null);
    t.store.getState().ensureGitHubConnection();
    await flush();
    const checks = t.scopeReads.github;
    t.advance(LIMITS.freshMs * 3);
    jest.advanceTimersByTime(LIMITS.freshMs * 3);
    await flush();
    expect(t.scopeReads.github).toBe(checks);
  });
});

describe('a window that has not confirmed one provider', () => {
  // Both windows start before anything is saved; the first saves both
  // providers, and the second only ever uses one.
  async function twoWindows(): Promise<{
    t: Harness;
    other: ClientStore<LinearPreviewStoreState>;
  }> {
    const t = setup();
    const other = t.make();
    await t.store.getState().load({ identifier: 'CAN-1' });
    await t.store.getState().loadGitHub(item(12));
    t.store.getState().ensureTeamCatalog();
    await flush();
    jest.advanceTimersByTime(250);
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: REFERENCE_PREVIEW_STORAGE_KEY,
        newValue: t.storage.getItem(REFERENCE_PREVIEW_STORAGE_KEY),
      }),
    );
    return { t, other };
  }

  it('keeps the GitHub scope another window saved when it writes', async () => {
    const { t, other } = await twoWindows();
    await other.getState().load({ identifier: 'CAN-2' });
    jest.advanceTimersByTime(250);
    expect(persisted(t).githubScope).toBe('github-a');
    const restarted = t.make();
    expect(restarted.getState().githubConnected).toBe(true);
    expect(
      githubTitleSlot(
        restarted.getState().githubViews[githubPreviewKey(item(12))],
      ),
    ).toEqual({ kind: 'title', title: 'Item 12' });
  });

  it('keeps the Linear scope and team catalog another window saved when it writes', async () => {
    const { t, other } = await twoWindows();
    await other.getState().loadGitHub(item(13));
    jest.advanceTimersByTime(250);
    expect(persisted(t).scope).toBe('linear-a');
    expect(persisted(t).catalog).toMatchObject({
      scope: 'linear-a',
      keys: ['CAN'],
    });
    const restarted = t.make();
    expect(restarted.getState().teamCatalog.keys).toEqual(new Set(['CAN']));
    expect(restarted.getState().views['*/CAN-1']).toMatchObject({
      status: 'ready',
    });
  });

  it('does not restore a scope it reset itself', async () => {
    const { t, other } = await twoWindows();
    invalidateReferencePreviews(t.storage, 'github');
    await other.getState().load({ identifier: 'CAN-2' });
    jest.advanceTimersByTime(250);
    expect(persisted(t).githubScope).toBeUndefined();
    expect(persisted(t).scope).toBe('linear-a');
  });
});
