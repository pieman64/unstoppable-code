import type * as FileListStore from '../fileListStore';
import {
  getDirectoryCacheKey,
  getFileTreeIndexCacheKey,
  getWorktreeCacheKey,
  isFileIndexStale,
  useFileListStore,
  snapshotFilesRendererEvidence,
} from '../fileListStore';

interface MockApi {
  getFileIndex: jest.Mock;
  getFileTreeRoots: jest.Mock;
  getFileTreeDirectory: jest.Mock;
}

let mockApi: MockApi;

beforeEach(() => {
  mockApi = {
    getFileIndex: jest.fn(),
    getFileTreeRoots: jest.fn(),
    getFileTreeDirectory: jest.fn(),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: mockApi,
    },
  });
  // Drop any root request a failed test left in flight, then reset the zustand
  // store before every test.
  useFileListStore.getState().invalidateAll();
  useFileListStore.setState({
    indexCache: {},
    indexErrors: {},
    indexLoading: new Set(),
    indexVersions: {},
    rootsCache: {},
    rootsErrors: {},
    rootsLoading: new Set(),
    rootsVersions: {},
    directoryCache: {},
    directoryErrors: {},
    directoryLoading: new Set(),
    directoryVersions: {},
    fileTreeExpandedPaths: {},
  });
});

function getMockApi(): MockApi {
  return mockApi;
}

describe('fetchFileIndex', () => {
  it('keeps the explorer index separate from mention search', async () => {
    getMockApi().getFileIndex.mockResolvedValueOnce({ repos: [] });

    await useFileListStore.getState().fetchFileTreeIndex('p1', 'wt-1');

    expect(getMockApi().getFileIndex).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'wt-1',
      purpose: 'file-explorer',
    });
    const state = useFileListStore.getState();
    expect(
      state.indexCache[getFileTreeIndexCacheKey('p1', 'wt-1')],
    ).toBeDefined();
    expect(state.indexCache[getWorktreeCacheKey('p1', 'wt-1')]).toBeUndefined();
  });

  it('populates indexCache on success', async () => {
    getMockApi().getFileIndex.mockResolvedValueOnce({
      repos: [
        {
          repoId: 'r1',
          repoName: 'r1',
          rootKind: 'git-repo',
          files: [
            {
              relativePath: 'a.txt',
              filename: 'a.txt',
              absolutePath: '/r1/a.txt',
              isIgnored: false,
            },
          ],
        },
      ],
    });

    await useFileListStore.getState().fetchFileIndex('p1', 'wt-1');

    const key = getWorktreeCacheKey('p1', 'wt-1');
    const cached = useFileListStore.getState().indexCache[key];
    expect(cached?.data.repos[0]?.files[0]?.relativePath).toBe('a.txt');
    expect(useFileListStore.getState().indexErrors[key]).toBeUndefined();
    expect(useFileListStore.getState().indexLoading.has(key)).toBe(false);
  });

  it('records an error message on rejection', async () => {
    getMockApi().getFileIndex.mockRejectedValueOnce(new Error('boom'));

    await useFileListStore.getState().fetchFileIndex('p1', 'wt-1');

    const key = getWorktreeCacheKey('p1', 'wt-1');
    expect(useFileListStore.getState().indexErrors[key]).toBe('boom');
    expect(useFileListStore.getState().indexCache[key]).toBeUndefined();
  });
});

describe('fetchFileTreeDirectory', () => {
  it('caches by (project, worktree, repo, relativeDir)', async () => {
    getMockApi().getFileTreeDirectory.mockResolvedValueOnce({
      entries: [
        {
          name: 'index.ts',
          relativePath: 'src/index.ts',
          absolutePath: '/r1/src/index.ts',
          kind: 'file',
          isIgnored: false,
          isIndexExcluded: false,
          isSymlink: false,
          hasChildren: false,
        },
      ],
    });

    await useFileListStore
      .getState()
      .fetchFileTreeDirectory('p1', 'wt-1', 'r1', 'src');

    const key = getDirectoryCacheKey('p1', 'wt-1', 'r1', 'src');
    expect(
      useFileListStore.getState().directoryCache[key]?.data.entries[0]?.name,
    ).toBe('index.ts');
  });

  it('keeps unchanged entries referentially stable across refreshes', async () => {
    const firstResponse = {
      entries: [
        {
          name: 'index.ts',
          relativePath: 'src/index.ts',
          absolutePath: '/r1/src/index.ts',
          kind: 'file' as const,
          isIgnored: false,
          isIndexExcluded: false,
          isSymlink: false,
          hasChildren: false,
        },
      ],
    };
    getMockApi().getFileTreeDirectory.mockResolvedValueOnce(firstResponse);

    await useFileListStore
      .getState()
      .fetchFileTreeDirectory('p1', 'wt-1', 'r1', 'src');
    const key = getDirectoryCacheKey('p1', 'wt-1', 'r1', 'src');
    const before = useFileListStore.getState().directoryCache[key];

    getMockApi().getFileTreeDirectory.mockResolvedValueOnce({
      entries: [{ ...firstResponse.entries[0] }],
    });
    await useFileListStore
      .getState()
      .fetchFileTreeDirectory('p1', 'wt-1', 'r1', 'src');

    const after = useFileListStore.getState().directoryCache[key];
    expect(after?.data).toBe(before?.data);
    expect(after?.data.entries[0]).toBe(before?.data.entries[0]);
  });

  it('reuses unaffected entries when a refresh adds one sibling', async () => {
    const stableEntry = {
      name: 'index.ts',
      relativePath: 'src/index.ts',
      absolutePath: '/r1/src/index.ts',
      kind: 'file' as const,
      isIgnored: false,
      isIndexExcluded: false,
      isSymlink: false,
      hasChildren: false,
    };
    getMockApi().getFileTreeDirectory.mockResolvedValueOnce({
      entries: [stableEntry],
    });

    await useFileListStore
      .getState()
      .fetchFileTreeDirectory('p1', 'wt-1', 'r1', 'src');
    const key = getDirectoryCacheKey('p1', 'wt-1', 'r1', 'src');
    const before = useFileListStore.getState().directoryCache[key];

    getMockApi().getFileTreeDirectory.mockResolvedValueOnce({
      entries: [
        { ...stableEntry },
        {
          ...stableEntry,
          name: 'new.ts',
          relativePath: 'src/new.ts',
          absolutePath: '/r1/src/new.ts',
        },
      ],
    });
    await useFileListStore
      .getState()
      .fetchFileTreeDirectory('p1', 'wt-1', 'r1', 'src');

    const after = useFileListStore.getState().directoryCache[key];
    expect(after?.data).not.toBe(before?.data);
    expect(after?.data.entries[0]).toBe(before?.data.entries[0]);
    expect(after?.data.entries[1]?.relativePath).toBe('src/new.ts');
  });
});

describe('fetchFileTreeRoots', () => {
  it('coalesces overlapping root requests so every caller waits for the committed result', async () => {
    let resolveRoots!: (value: {
      roots: Array<{
        repoId: string;
        repoName: string;
        absolutePath: string;
        rootKind: 'git-repo';
      }>;
    }) => void;
    const roots = new Promise<Parameters<typeof resolveRoots>[0]>((resolve) => {
      resolveRoots = resolve;
    });
    getMockApi().getFileTreeRoots.mockReturnValue(roots);

    const first = useFileListStore.getState().fetchFileTreeRoots('p1', 'wt-1');
    const second = useFileListStore.getState().fetchFileTreeRoots('p1', 'wt-1');

    expect(getMockApi().getFileTreeRoots).toHaveBeenCalledTimes(1);

    resolveRoots({
      roots: [
        {
          repoId: 'r1',
          repoName: 'repo',
          absolutePath: '/r1',
          rootKind: 'git-repo',
        },
      ],
    });
    await Promise.all([first, second]);

    const key = getWorktreeCacheKey('p1', 'wt-1');
    expect(
      useFileListStore.getState().rootsCache[key]?.data.roots,
    ).toHaveLength(1);
    expect(useFileListStore.getState().rootsLoading.has(key)).toBe(false);
  });

  // A worktree's first diff stats invalidate its file lists. When that lands
  // while a root request is in flight, the request's response is discarded,
  // and an imperative waiter (the Changed Files context menu reads the cache
  // right after awaiting) used to resume with no roots and silently drop the
  // user's gesture.
  it.each(['resolved', 'rejected'])(
    'waits for current roots when an invalidated request is %s',
    async (reply) => {
      const staleRoot = {
        repoId: 'stale',
        repoName: 'repo',
        absolutePath: '/stale',
        rootKind: 'git-repo' as const,
      };
      const freshRoot = {
        ...staleRoot,
        repoId: 'fresh',
        absolutePath: '/fresh',
      };
      let resolveStale!: (value: { roots: (typeof staleRoot)[] }) => void;
      let rejectStale!: (error: Error) => void;
      getMockApi()
        .getFileTreeRoots.mockReturnValueOnce(
          new Promise((resolve, reject) => {
            resolveStale = resolve;
            rejectStale = reject;
          }),
        )
        .mockResolvedValueOnce({ roots: [freshRoot] });

      const target = {
        projectId: 'p1',
        worktreeId: 'wt-1',
        operation: 'roots' as const,
      };
      const baseline = snapshotFilesRendererEvidence(target).cursor;
      const waiting = useFileListStore
        .getState()
        .fetchFileTreeRoots('p1', 'wt-1');
      useFileListStore.getState().invalidate('p1', 'wt-1');
      if (reply === 'resolved') resolveStale({ roots: [staleRoot] });
      else rejectStale(new Error('stale private error'));
      await waiting;

      const key = getWorktreeCacheKey('p1', 'wt-1');
      expect(useFileListStore.getState().rootsCache[key]?.data.roots).toEqual([
        freshRoot,
      ]);
      expect(useFileListStore.getState().rootsLoading.has(key)).toBe(false);
      expect(getMockApi().getFileTreeRoots).toHaveBeenCalledTimes(2);
      const evidence = snapshotFilesRendererEvidence(target, baseline);
      expect(evidence).toMatchObject({
        complete: true,
        currentSuccess: true,
        hasError: false,
        settled: true,
      });
      expect(evidence.entries.map((entry) => entry.phase)).toEqual([
        'started',
        'discarded',
        'started',
        'success',
      ]);
    },
  );

  it('joins the request that replaced an invalidated one instead of fetching again', async () => {
    const root = {
      repoId: 'r1',
      repoName: 'repo',
      absolutePath: '/r1',
      rootKind: 'git-repo' as const,
    };
    let resolveStale!: (value: { roots: (typeof root)[] }) => void;
    let resolveFresh!: (value: { roots: (typeof root)[] }) => void;
    getMockApi()
      .getFileTreeRoots.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFresh = resolve;
        }),
      );

    const first = useFileListStore.getState().fetchFileTreeRoots('p1', 'wt-1');
    useFileListStore.getState().invalidate('p1', 'wt-1');
    const replacement = useFileListStore
      .getState()
      .fetchFileTreeRoots('p1', 'wt-1');
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    resolveStale({ roots: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    resolveFresh({ roots: [root] });
    await Promise.all([first, replacement]);

    const key = getWorktreeCacheKey('p1', 'wt-1');
    expect(useFileListStore.getState().rootsCache[key]?.data.roots).toEqual([
      root,
    ]);
    expect(getMockApi().getFileTreeRoots).toHaveBeenCalledTimes(2);
  });

  it('stops following requests that keep being invalidated', async () => {
    const pending: Array<(value: { roots: [] }) => void> = [];
    getMockApi().getFileTreeRoots.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );

    const waiting = useFileListStore
      .getState()
      .fetchFileTreeRoots('p1', 'wt-1');
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    for (let attempt = 0; attempt < 10 && !settled; attempt += 1) {
      await Promise.resolve();
      useFileListStore.getState().invalidate('p1', 'wt-1');
      pending.shift()?.({ roots: [] });
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    }

    await waiting;
    expect(getMockApi().getFileTreeRoots.mock.calls.length).toBeLessThan(10);
  });

  it('keeps an unchanged roots payload referentially stable across refreshes', async () => {
    const root = {
      repoId: 'r1',
      repoName: 'repo',
      absolutePath: '/r1',
      rootKind: 'git-repo' as const,
    };
    getMockApi().getFileTreeRoots.mockResolvedValueOnce({ roots: [root] });
    await useFileListStore.getState().fetchFileTreeRoots('p1', 'wt-1');
    const key = getWorktreeCacheKey('p1', 'wt-1');
    const before = useFileListStore.getState().rootsCache[key];

    getMockApi().getFileTreeRoots.mockResolvedValueOnce({
      roots: [{ ...root }],
    });
    await useFileListStore.getState().fetchFileTreeRoots('p1', 'wt-1');

    const after = useFileListStore.getState().rootsCache[key];
    expect(after?.data).toBe(before?.data);
    expect(after?.data.roots[0]).toBe(before?.data.roots[0]);
  });
});

describe('invalidate', () => {
  it('clears the index, roots, and matching directory caches for a worktree', async () => {
    getMockApi().getFileIndex.mockResolvedValue({ repos: [] });
    getMockApi().getFileTreeRoots.mockResolvedValue({ roots: [] });
    getMockApi().getFileTreeDirectory.mockResolvedValue({ entries: [] });

    const store = useFileListStore.getState();
    await store.fetchFileIndex('p1', 'wt-1');
    await store.fetchFileTreeRoots('p1', 'wt-1');
    await store.fetchFileTreeDirectory('p1', 'wt-1', 'r1', 'src');
    // Pre-condition: caches populated for both worktrees.
    await store.fetchFileIndex('p2', 'wt-2');

    useFileListStore.getState().invalidate('p1', 'wt-1');

    const wt1Key = getWorktreeCacheKey('p1', 'wt-1');
    const wt2Key = getWorktreeCacheKey('p2', 'wt-2');
    const dirKey = getDirectoryCacheKey('p1', 'wt-1', 'r1', 'src');
    const state = useFileListStore.getState();
    expect(state.indexCache[wt1Key]).toBeUndefined();
    expect(state.rootsCache[wt1Key]).toBeUndefined();
    expect(state.directoryCache[dirKey]).toBeUndefined();
    // Other worktree's index cache is untouched.
    expect(state.indexCache[wt2Key]).toBeDefined();
  });
});

describe('markFileTreeStale', () => {
  it('preserves rendered data while making every worktree cache eligible for refresh', async () => {
    getMockApi().getFileIndex.mockResolvedValue({ repos: [] });
    getMockApi().getFileTreeRoots.mockResolvedValue({ roots: [] });
    getMockApi().getFileTreeDirectory.mockResolvedValue({ entries: [] });
    const store = useFileListStore.getState();
    await store.fetchFileTreeIndex('p1', 'wt-1');
    await store.fetchFileTreeRoots('p1', 'wt-1');
    await store.fetchFileTreeDirectory('p1', 'wt-1', 'r1', 'src');

    useFileListStore.getState().markFileTreeStale('p1', 'wt-1');

    const state = useFileListStore.getState();
    expect(
      state.indexCache[getFileTreeIndexCacheKey('p1', 'wt-1')]?.fetchedAt,
    ).toBe(0);
    expect(state.rootsCache[getWorktreeCacheKey('p1', 'wt-1')]?.fetchedAt).toBe(
      0,
    );
    expect(
      state.directoryCache[getDirectoryCacheKey('p1', 'wt-1', 'r1', 'src')]
        ?.fetchedAt,
    ).toBe(0);
    expect(
      state.directoryCache[getDirectoryCacheKey('p1', 'wt-1', 'r1', 'src')]
        ?.data,
    ).toEqual({ entries: [] });
  });
});

describe('file tree expansion state', () => {
  it('stores expanded paths per worktree', () => {
    const store = useFileListStore.getState();

    store.setFileTreeExpandedPaths('p1', 'wt-1', new Set(['repo:r1']));
    store.setFileTreeExpandedPaths('p1', 'wt-2', new Set(['repo:r2']));
    store.toggleFileTreeExpandedPath('p1', 'wt-1', 'repo:r1/src');

    const state = useFileListStore.getState();
    expect(Array.from(state.fileTreeExpandedPaths['p1/wt-1'] ?? [])).toEqual([
      'repo:r1',
      'repo:r1/src',
    ]);
    expect(Array.from(state.fileTreeExpandedPaths['p1/wt-2'] ?? [])).toEqual([
      'repo:r2',
    ]);
  });

  it('preserves expansion state when file caches are invalidated', async () => {
    getMockApi().getFileIndex.mockResolvedValue({ repos: [] });
    await useFileListStore.getState().fetchFileIndex('p1', 'wt-1');
    useFileListStore
      .getState()
      .setFileTreeExpandedPaths('p1', 'wt-1', new Set(['repo:r1']));

    useFileListStore.getState().invalidate('p1', 'wt-1');

    expect(
      Array.from(
        useFileListStore.getState().fileTreeExpandedPaths['p1/wt-1'] ?? [],
      ),
    ).toEqual(['repo:r1']);
  });

  it('isolates expansion state for standalone and per-file-tab trees', () => {
    const store = useFileListStore.getState();
    store.setFileTreeExpandedPaths('p1', 'wt-1', new Set(['repo:standalone']));
    store.setFileTreeExpandedPaths(
      'p1',
      'wt-1',
      new Set(['repo:file-1']),
      'file-tab:file-1',
    );
    store.setFileTreeExpandedPaths(
      'p1',
      'wt-1',
      new Set(['repo:file-2']),
      'file-tab:file-2',
    );

    const state = useFileListStore.getState();
    expect(Array.from(state.fileTreeExpandedPaths['p1/wt-1'] ?? [])).toEqual([
      'repo:standalone',
    ]);
    expect(
      Array.from(
        state.fileTreeExpandedPaths['p1/wt-1::file-tree-ui:file-tab:file-1'] ??
          [],
      ),
    ).toEqual(['repo:file-1']);
    expect(
      Array.from(
        state.fileTreeExpandedPaths['p1/wt-1::file-tree-ui:file-tab:file-2'] ??
          [],
      ),
    ).toEqual(['repo:file-2']);
  });
});

describe('file tree scroll position', () => {
  beforeEach(() => {
    useFileListStore.setState({ fileTreeScrollPositions: {} });
  });

  it('stores scroll offset per worktree', () => {
    const store = useFileListStore.getState();
    store.setFileTreeScrollPosition('p1', 'wt-1', 240);
    store.setFileTreeScrollPosition('p1', 'wt-2', 12);

    const state = useFileListStore.getState();
    expect(state.fileTreeScrollPositions['p1/wt-1']).toBe(240);
    expect(state.fileTreeScrollPositions['p1/wt-2']).toBe(12);
  });

  it('preserves the scroll offset across a refresh invalidation', async () => {
    getMockApi().getFileIndex.mockResolvedValue({ repos: [] });
    await useFileListStore.getState().fetchFileIndex('p1', 'wt-1');
    useFileListStore.getState().setFileTreeScrollPosition('p1', 'wt-1', 320);

    useFileListStore.getState().invalidate('p1', 'wt-1');

    expect(useFileListStore.getState().fileTreeScrollPositions['p1/wt-1']).toBe(
      320,
    );
  });

  it('isolates scroll offsets for standalone and per-file-tab trees', () => {
    const store = useFileListStore.getState();
    store.setFileTreeScrollPosition('p1', 'wt-1', 120);
    store.setFileTreeScrollPosition('p1', 'wt-1', 240, 'file-tab:file-1');

    const state = useFileListStore.getState();
    expect(state.fileTreeScrollPositions['p1/wt-1']).toBe(120);
    expect(
      state.fileTreeScrollPositions['p1/wt-1::file-tree-ui:file-tab:file-1'],
    ).toBe(240);
  });
});

describe('invalidateAll', () => {
  it('clears every cache and bumps versions for in-flight requests', async () => {
    getMockApi().getFileIndex.mockResolvedValue({ repos: [] });
    const store = useFileListStore.getState();
    await store.fetchFileIndex('p1', 'wt-1');
    await store.fetchFileIndex('p2', 'wt-2');

    useFileListStore.getState().invalidateAll();

    const state = useFileListStore.getState();
    expect(state.indexCache).toEqual({});
    expect(state.rootsCache).toEqual({});
    expect(state.directoryCache).toEqual({});
  });
});

describe('isFileIndexStale', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-26T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('treats undefined entries as stale', () => {
    expect(isFileIndexStale(undefined)).toBe(true);
  });

  it('treats fresh entries as not stale and old entries as stale', () => {
    expect(
      isFileIndexStale({ data: { repos: [] }, fetchedAt: Date.now() }),
    ).toBe(false);
    expect(
      isFileIndexStale({
        data: { repos: [] },
        fetchedAt: Date.now() - 61_000,
      }),
    ).toBe(true);
  });
});

describe('production Files renderer evidence', () => {
  const target = {
    projectId: 'observer-project',
    worktreeId: 'observer-worktree',
    operation: 'directory' as const,
    repoId: 'repo',
    relativeDir: 'private/path',
  };
  const observe = (
    after?: Parameters<typeof snapshotFilesRendererEvidence>[1],
  ): ReturnType<typeof snapshotFilesRendererEvidence> =>
    snapshotFilesRendererEvidence(target, after);
  const read = (): Promise<void> =>
    useFileListStore
      .getState()
      .fetchFileTreeDirectory(
        target.projectId,
        target.worktreeId,
        target.repoId,
        target.relativeDir,
      );
  const deferDirectory = (): {
    resolve: (value: { entries: [] }) => void;
    reject: (error: Error) => void;
  } => {
    let done!: (value: { entries: [] }) => void;
    let fail!: (error: Error) => void;
    const p = new Promise<{ entries: [] }>((r, j) => ([done, fail] = [r, j]));
    getMockApi().getFileTreeDirectory.mockReturnValueOnce(p);
    return { resolve: done, reject: fail };
  };

  it('rejects a completion whose start is outside the observed interval', async () => {
    const deferred = deferDirectory();
    const pending = read();
    const baseline = observe().cursor;
    deferred.resolve({ entries: [] });
    await pending;
    expect(observe(baseline)).toMatchObject({
      complete: true,
      settled: true,
      currentSuccess: false,
      entries: [expect.objectContaining({ phase: 'success' })],
    });
  });

  it('rejects ambiguous completion while another observed target request remains in flight', async () => {
    const deferred = deferDirectory();
    getMockApi().getFileTreeDirectory.mockResolvedValueOnce({ entries: [] });
    const baseline = observe().cursor;
    const old = read();
    try {
      await read();
      expect(observe(baseline)).toMatchObject({
        complete: true,
        currentSuccess: false,
      });
    } finally {
      deferred.resolve({ entries: [] });
      await old;
    }
  });

  it('admits only a new current commit from the actual store, not retained cache or API resolution', async () => {
    getMockApi().getFileTreeDirectory.mockResolvedValue({ entries: [] });
    const baseline = observe().cursor;
    expect(observe().currentSuccess).toBe(false);
    await read();
    const result = observe(baseline);
    expect(result).toMatchObject({
      complete: true,
      currentSuccess: true,
      itemCount: 0,
      settled: true,
    });
    expect(result.entries.map((entry) => entry.phase)).toEqual([
      'started',
      'success',
    ]);
    expect(JSON.stringify(result)).not.toContain('private/path');
    expect(observe(result.cursor).currentSuccess).toBe(false);
    useFileListStore
      .getState()
      .markFileTreeStale(target.projectId, target.worktreeId);
    expect(observe(baseline).currentSuccess).toBe(false);
    useFileListStore.getState().invalidateAll();
    expect(observe(baseline).currentSuccess).toBe(false);
    const globals = Object.getOwnPropertyDescriptors(globalThis);
    const descriptor = globals.__CANOPY_FILES_RENDERER_EVIDENCE__;
    expect(descriptor).toMatchObject({ configurable: false, writable: false });
    expect(descriptor?.enumerable).toBe(false);
    expect(Object.isFrozen(descriptor?.value)).toBe(true);
    expect(descriptor?.value).toEqual({
      snapshot: snapshotFilesRendererEvidence,
    });
  });

  it.each(['directory', 'roots'] as const)(
    'rejects a current %s commit once its cache leaves the freshness window',
    async (operation) => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const subject =
        operation === 'roots'
          ? {
              projectId: target.projectId,
              worktreeId: target.worktreeId,
              operation,
            }
          : target;
      try {
        const baseline = snapshotFilesRendererEvidence(subject).cursor;
        if (operation === 'roots') {
          getMockApi().getFileTreeRoots.mockResolvedValueOnce({ roots: [] });
          await useFileListStore
            .getState()
            .fetchFileTreeRoots(target.projectId, target.worktreeId);
        } else {
          getMockApi().getFileTreeDirectory.mockResolvedValueOnce({
            entries: [],
          });
          await read();
        }
        now.mockReturnValue(1_060_000);
        expect(
          snapshotFilesRendererEvidence(subject, baseline).currentSuccess,
        ).toBe(true);
        now.mockReturnValue(1_060_001);
        expect(snapshotFilesRendererEvidence(subject, baseline)).toMatchObject({
          complete: true,
          settled: true,
          hasError: false,
          currentSuccess: false,
        });
      } finally {
        now.mockRestore();
      }
    },
  );

  it.each(['success', 'error'])(
    'discards stale %s without overwriting the newer commit or leaking errors',
    async (outcome) => {
      const deferred = deferDirectory();
      getMockApi().getFileTreeDirectory.mockResolvedValueOnce({ entries: [] });
      const baseline = observe().cursor;
      const old = read();
      await read();
      const current = observe(baseline);
      const state = useFileListStore.getState();
      if (outcome === 'success') deferred.resolve({ entries: [] });
      else deferred.reject(new Error('stale private error'));
      await old;
      expect(useFileListStore.getState()).toBe(state);
      expect(observe(current.cursor)).toMatchObject({
        complete: true,
        currentSuccess: false,
        settled: true,
        hasError: false,
        version: current.version,
        entries: [expect.objectContaining({ phase: 'discarded' })],
      });
      expect(observe(baseline)).toMatchObject({
        currentSuccess: true,
        hasError: false,
      });
      expect(observe(baseline).entries.map((entry) => entry.phase)).toEqual([
        'started',
        'started',
        'success',
        'discarded',
      ]);
      expect(JSON.stringify(observe(baseline))).not.toContain(
        'stale private error',
      );
      const committed = observe().cursor;
      getMockApi().getFileTreeDirectory.mockRejectedValueOnce(
        new Error('private error'),
      );
      await read();
      expect(observe(committed)).toMatchObject({
        currentSuccess: false,
        hasError: true,
      });
      expect(JSON.stringify(observe(committed))).not.toContain('private error');
    },
  );

  it('rejects wrong observer identity and overflow rather than accepting retained roots', async () => {
    const roots = {
      projectId: 'observer-project',
      worktreeId: 'observer-worktree',
      operation: 'roots' as const,
    };
    getMockApi().getFileTreeRoots.mockResolvedValue({ roots: [] });
    const baseline = snapshotFilesRendererEvidence(roots).cursor;
    for (let i = 0; i < 129; i++)
      await useFileListStore
        .getState()
        .fetchFileTreeRoots(roots.projectId, roots.worktreeId);
    expect(snapshotFilesRendererEvidence(roots, baseline)).toMatchObject({
      complete: false,
      currentSuccess: false,
      entries: [],
    });
    expect(
      snapshotFilesRendererEvidence(roots, { ...baseline, observerId: 'wrong' })
        .complete,
    ).toBe(false);
    const current = snapshotFilesRendererEvidence(roots).cursor;
    await useFileListStore
      .getState()
      .fetchFileTreeRoots(roots.projectId, roots.worktreeId);
    expect(snapshotFilesRendererEvidence(roots, current).currentSuccess).toBe(
      true,
    );
  });

  it('keeps the first store observer when the module is evaluated again', async () => {
    const published =
      Object.getOwnPropertyDescriptors(
        globalThis,
      ).__CANOPY_FILES_RENDERER_EVIDENCE__;
    const first = observe().cursor;
    await jest.isolateModulesAsync(async () => {
      const reloaded =
        jest.requireActual<typeof FileListStore>('../fileListStore');
      const current =
        Object.getOwnPropertyDescriptors(
          globalThis,
        ).__CANOPY_FILES_RENDERER_EVIDENCE__;
      expect(current).toEqual(published);
      expect(current?.value).toBe(published?.value);
      const cursor = reloaded.snapshotFilesRendererEvidence(target).cursor;
      expect(cursor.observerId).not.toBe(first.observerId);
      getMockApi().getFileTreeDirectory.mockResolvedValueOnce({ entries: [] });
      await reloaded.useFileListStore
        .getState()
        .fetchFileTreeDirectory(
          target.projectId,
          target.worktreeId,
          target.repoId,
          target.relativeDir,
        );
      expect(
        reloaded.snapshotFilesRendererEvidence(target, cursor).currentSuccess,
      ).toBe(true);
      expect(observe(cursor).complete).toBe(false);
      expect(observe(first)).toMatchObject({ complete: true, entries: [] });
      expect(
        reloaded.snapshotFilesRendererEvidence(target, first).complete,
      ).toBe(false);
    });
  });
});
