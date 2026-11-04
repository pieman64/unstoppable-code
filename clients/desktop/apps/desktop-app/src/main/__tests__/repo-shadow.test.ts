import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

jest.mock('node:fs/promises', () => ({
  access: jest.fn().mockRejectedValue(new Error('ENOENT')),
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: jest.fn().mockResolvedValue(undefined),
  rm: jest.fn().mockResolvedValue(undefined),
  readdir: jest.fn().mockResolvedValue([]),
}));

jest.mock('../lib/git', () => ({
  fetchOrigin: jest.fn().mockResolvedValue(undefined),
  getRemoteDefaultBranch: jest.fn().mockResolvedValue('main'),
  addDetachedWorktree: jest.fn().mockResolvedValue(undefined),
  checkoutDetachedRef: jest.fn().mockResolvedValue(undefined),
  pruneWorktrees: jest.fn().mockResolvedValue(undefined),
  removeGitWorktree: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest
    .fn()
    .mockImplementation((p: string) => Promise.resolve(p)),
}));

jest.mock('../lib/paths', () => ({
  getRepoShadowsRootDir: (): string => '/data/repo-shadows',
}));

import {
  addDetachedWorktree,
  checkoutDetachedRef,
  fetchOrigin,
  getRemoteDefaultBranch,
  removeGitWorktree,
} from '../lib/git';
import {
  cleanupUnreferencedRepoShadows,
  clearRepoShadowRuntimeCaches,
  ensureRepoShadow,
  getBaselineReadPath,
  getRepoShadowDir,
  setRepoShadowRetirementHandler,
  withEnsuredRepoShadow,
} from '../lib/repo-shadow';

const mockedReadFile = jest.mocked(readFile);
const mockedAccess = jest.mocked(access);
const mockedAdd = jest.mocked(addDetachedWorktree);
const mockedCheckout = jest.mocked(checkoutDetachedRef);
const mockedDefaultBranch = jest.mocked(getRemoteDefaultBranch);
const mockedFetchOrigin = jest.mocked(fetchOrigin);
const mockedRm = jest.mocked(rm);
const mockedRemoveGitWorktree = jest.mocked(removeGitWorktree);

interface FakeDirEntry {
  name: string;
  isDirectory: () => boolean;
}

function getReaddirMock(): jest.Mock<
  Promise<FakeDirEntry[]>,
  [string, unknown?]
> {
  const fsPromisesMock = jest.requireMock<{
    readdir: jest.Mock<Promise<FakeDirEntry[]>, [string, unknown?]>;
  }>('node:fs/promises');
  return fsPromisesMock.readdir;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// `jest.clearAllMocks()` clears calls but NOT implementations, and several
// tests install pausing/ordering implementations on the git-op mocks — reset
// them to plain resolutions so one test's paused fetch can never hang the
// next test's ensure behind the per-repo lock.
function resetGitOpImplementations(): void {
  mockedFetchOrigin.mockReset();
  mockedFetchOrigin.mockResolvedValue(undefined);
  mockedCheckout.mockReset();
  mockedCheckout.mockResolvedValue(undefined);
  mockedAdd.mockReset();
  mockedAdd.mockResolvedValue(undefined);
  mockedRm.mockReset();
  mockedRm.mockResolvedValue(undefined);
  jest.mocked(writeFile).mockReset();
  jest.mocked(writeFile).mockResolvedValue(undefined);
}

describe('ensureRepoShadow', () => {
  beforeEach((): void => {
    jest.clearAllMocks();
    clearRepoShadowRuntimeCaches();
    setRepoShadowRetirementHandler(null);
    resetGitOpImplementations();
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedAccess.mockRejectedValue(new Error('ENOENT'));
    mockedDefaultBranch.mockResolvedValue('main');
  });

  it('creates a detached shadow at origin/<default> on first call', async () => {
    const info = await ensureRepoShadow('/Users/me/repo');
    expect(info.defaultBranch).toBe('main');
    expect(info.shadowPath).toBe(
      `${getRepoShadowDir('/Users/me/repo')}/checkout`,
    );
    expect(mockedAdd).toHaveBeenCalledWith(
      '/Users/me/repo',
      info.shadowPath,
      'origin/main',
    );
    expect(writeFile).toHaveBeenCalled(); // meta.json persisted
    expect(mkdir).toHaveBeenCalled();
  });

  it('cancels creation when availability changes during preparation without caching a failure', async () => {
    let available = true;
    mockedDefaultBranch.mockImplementationOnce(() => {
      available = false;
      return Promise.resolve('main');
    });

    await expect(
      withEnsuredRepoShadow(
        '/Users/me/repo',
        { shouldContinue: () => available },
        () => Promise.resolve(undefined),
      ),
    ).rejects.toMatchObject({ name: 'RepoShadowEnsureCanceledError' });
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedAdd).not.toHaveBeenCalled();

    available = true;
    await expect(
      withEnsuredRepoShadow(
        '/Users/me/repo',
        { shouldContinue: () => available },
        (shadow) => Promise.resolve(shadow.defaultBranch),
      ),
    ).resolves.toBe('main');
  });

  it('aborts default-branch discovery during cancellable preparation', async () => {
    const controller = new AbortController();
    mockedDefaultBranch.mockImplementationOnce(
      (_repoPath, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );

    const preparation = withEnsuredRepoShadow(
      '/Users/me/repo',
      { shouldContinue: () => true, signal: controller.signal },
      () => Promise.resolve(undefined),
    );
    await flushMicrotasks();
    controller.abort();

    await expect(preparation).rejects.toMatchObject({
      name: 'RepoShadowEnsureCanceledError',
    });
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it('refreshes a stale shadow instead of recreating it', async () => {
    const meta = {
      version: 1,
      repoPath: '/Users/me/repo',
      defaultBranch: 'main',
      lastSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(meta));

    await ensureRepoShadow('/Users/me/repo');
    expect(mockedAdd).not.toHaveBeenCalled();
    expect(mockedCheckout).toHaveBeenCalledWith(
      `${getRepoShadowDir('/Users/me/repo')}/checkout`,
      'origin/main',
    );
  });

  it('aborts an in-flight Code Graph refresh and retains the existing shadow', async () => {
    const repoRoot = '/Users/me/repo';
    const meta = {
      version: 1,
      repoPath: repoRoot,
      defaultBranch: 'main',
      lastSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(meta));
    const controller = new AbortController();
    mockedFetchOrigin.mockImplementation(
      (_repoPath, options): Promise<void> =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );

    const refresh = withEnsuredRepoShadow(
      repoRoot,
      { maxAgeMs: 0, shouldContinue: () => true, signal: controller.signal },
      () => Promise.resolve(undefined),
    );
    await flushMicrotasks();
    controller.abort();

    await expect(refresh).rejects.toMatchObject({
      name: 'RepoShadowEnsureCanceledError',
    });
    expect(mockedCheckout).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('does not reconstruct an existing shadow after a cancellable refresh failure', async () => {
    const repoRoot = '/Users/me/repo';
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        repoPath: repoRoot,
        defaultBranch: 'main',
        lastSyncAt: new Date(0).toISOString(),
      }),
    );
    mockedFetchOrigin.mockRejectedValueOnce(new Error('offline'));

    await expect(
      withEnsuredRepoShadow(
        repoRoot,
        { maxAgeMs: 0, shouldContinue: () => true },
        () => Promise.resolve(undefined),
      ),
    ).rejects.toThrow('offline');
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it('skips refresh when the shadow is fresh', async () => {
    const meta = {
      version: 1,
      repoPath: '/Users/me/repo',
      defaultBranch: 'main',
      lastSyncAt: new Date().toISOString(),
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(meta));

    await ensureRepoShadow('/Users/me/repo');
    expect(mockedAdd).not.toHaveBeenCalled();
    expect(mockedCheckout).not.toHaveBeenCalled();
  });

  it('throws when the repo has no remote default branch', async () => {
    mockedDefaultBranch.mockResolvedValue(null);
    await expect(ensureRepoShadow('/Users/me/repo')).rejects.toThrow(
      /default branch/i,
    );
  });

  it('treats a corrupt meta.json (wrong version) as missing and recreates the shadow', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 2,
        repoPath: '/Users/me/repo',
        defaultBranch: 'main',
        lastSyncAt: new Date().toISOString(),
      }),
    );

    const info = await ensureRepoShadow('/Users/me/repo');
    expect(info.defaultBranch).toBe('main');
    expect(mockedAdd).toHaveBeenCalled();
  });

  it('keeps the code-graph base subtree when it recreates a shadow', async () => {
    const shadowDir = getRepoShadowDir('/Users/me/repo');
    mockedReadFile.mockResolvedValue(JSON.stringify('not-an-object'));

    await ensureRepoShadow('/Users/me/repo');

    // The base manager owns `code-graph/`; a recreate removes only what this
    // module writes (CAN-5084).
    expect(mockedRm.mock.calls.map(([target]) => target)).toEqual([
      `${shadowDir}/checkout`,
      `${shadowDir}/meta.json`,
    ]);
  });

  it('treats a non-object meta.json as missing and recreates the shadow', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify('not-an-object'));

    const info = await ensureRepoShadow('/Users/me/repo');
    expect(info.defaultBranch).toBe('main');
    expect(mockedAdd).toHaveBeenCalled();
  });

  it('writes a provisional stale meta before the network-bound checkout steps', async () => {
    const order: string[] = [];
    jest.mocked(writeFile).mockImplementation(() => {
      order.push('writeMeta');
      return Promise.resolve(undefined);
    });
    mockedFetchOrigin.mockImplementation(() => {
      order.push('fetchOrigin');
      return Promise.resolve(undefined);
    });
    mockedAdd.mockImplementation(() => {
      order.push('addWorktree');
      return Promise.resolve(undefined);
    });

    await ensureRepoShadow('/Users/me/repo');

    // Provisional meta first, then fetch + worktree add, then final meta.
    expect(order).toEqual([
      'writeMeta',
      'fetchOrigin',
      'addWorktree',
      'writeMeta',
    ]);
    const firstWriteData: unknown = jest.mocked(writeFile).mock.calls[0][1];
    expect(typeof firstWriteData).toBe('string');
    if (typeof firstWriteData === 'string') {
      expect(firstWriteData).toContain('"repoPath": "/Users/me/repo"');
      expect(firstWriteData).toContain(new Date(0).toISOString());
    }
  });

  it('recreates from a provisional meta left by a dead create attempt when refresh fails', async () => {
    // Provisional meta: valid shape, epoch lastSyncAt — never fresh.
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        repoPath: '/Users/me/repo',
        defaultBranch: 'main',
        lastSyncAt: new Date(0).toISOString(),
      }),
    );
    // Refresh attempt fails (no checkout exists yet); the create-path fetch
    // afterwards succeeds.
    mockedFetchOrigin.mockRejectedValueOnce(new Error('no such directory'));

    const info = await ensureRepoShadow('/Users/me/repo');
    expect(info.defaultBranch).toBe('main');
    expect(mockedAdd).toHaveBeenCalled();
  });

  it('caches an ensure failure and fast-fails the next call without re-probing', async () => {
    mockedDefaultBranch.mockResolvedValue(null);
    await expect(ensureRepoShadow('/Users/me/repo')).rejects.toThrow(
      /default branch/i,
    );
    expect(mockedDefaultBranch).toHaveBeenCalledTimes(1);

    // Second call within the failure TTL: same error, no new probe.
    await expect(ensureRepoShadow('/Users/me/repo')).rejects.toThrow(
      /default branch/i,
    );
    expect(mockedDefaultBranch).toHaveBeenCalledTimes(1);
  });

  it('bypassFailureCache re-probes live past a cached failure', async () => {
    mockedDefaultBranch.mockResolvedValue(null);
    await expect(ensureRepoShadow('/Users/me/repo')).rejects.toThrow(
      /default branch/i,
    );

    // The user attaches a remote; a health-style bypass call sees it now.
    mockedDefaultBranch.mockResolvedValue('main');
    const info = await ensureRepoShadow('/Users/me/repo', {
      bypassFailureCache: true,
    });
    expect(info.defaultBranch).toBe('main');
    expect(mockedDefaultBranch).toHaveBeenCalledTimes(2);

    // Success also clears the cached failure for plain callers.
    await expect(ensureRepoShadow('/Users/me/repo')).resolves.toMatchObject({
      defaultBranch: 'main',
    });
  });

  it('allowStale serves a stale shadow immediately and refreshes in the background', async () => {
    const staleSyncAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        repoPath: '/Users/me/repo',
        defaultBranch: 'main',
        lastSyncAt: staleSyncAt,
      }),
    );

    let resolveFetchOrigin: () => void = () => undefined;
    mockedFetchOrigin.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFetchOrigin = resolve;
        }),
    );

    // Returns the STALE info without waiting on the paused refresh fetch.
    const info = await ensureRepoShadow('/Users/me/repo', { allowStale: true });
    expect(info.lastSyncAt).toBe(staleSyncAt);
    expect(mockedCheckout).not.toHaveBeenCalled();

    // Let the background refresh reach its (paused) fetch, then release it —
    // draining the refresh fully so the per-repo lock is free again.
    await flushMicrotasks();
    expect(mockedFetchOrigin).toHaveBeenCalled();
    resolveFetchOrigin();
    await flushMicrotasks();
    expect(mockedCheckout).toHaveBeenCalledWith(
      `${getRepoShadowDir('/Users/me/repo')}/checkout`,
      'origin/main',
    );
  });

  it('allowStale with a fresh shadow returns without scheduling any refresh', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        repoPath: '/Users/me/repo',
        defaultBranch: 'main',
        lastSyncAt: new Date().toISOString(),
      }),
    );

    await ensureRepoShadow('/Users/me/repo', { allowStale: true });
    await flushMicrotasks();
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedCheckout).not.toHaveBeenCalled();
  });

  it('allowStale never serves a provisional (epoch) meta — it blocks on the full create', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        repoPath: '/Users/me/repo',
        defaultBranch: 'main',
        lastSyncAt: new Date(0).toISOString(),
      }),
    );
    // Refresh fails (no checkout), then the create path runs to completion.
    mockedFetchOrigin.mockRejectedValueOnce(new Error('no such directory'));

    const info = await ensureRepoShadow('/Users/me/repo', { allowStale: true });
    expect(Date.parse(info.lastSyncAt)).toBeGreaterThan(0);
    expect(mockedAdd).toHaveBeenCalled();
  });
});

describe('getBaselineReadPath', () => {
  beforeEach((): void => {
    jest.clearAllMocks();
    clearRepoShadowRuntimeCaches();
    resetGitOpImplementations();
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedDefaultBranch.mockResolvedValue('main');
  });

  it('falls back to the repo root when the shadow cannot be created', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedDefaultBranch.mockResolvedValue(null);
    await expect(getBaselineReadPath('/Users/me/repo')).resolves.toBe(
      '/Users/me/repo',
    );
  });

  it('serves a stale shadow path without blocking on the refresh', async () => {
    // A dedicated repo path: the deliberately never-resolving refresh fetch
    // below holds this repo's lock for the rest of the suite, so no other
    // test may share it.
    const repoPath = '/Users/me/repo-baseline-stale';
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        repoPath,
        defaultBranch: 'main',
        lastSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    );
    // A hanging refresh fetch must not delay the read.
    mockedFetchOrigin.mockImplementation(() => new Promise<void>(() => {}));

    await expect(getBaselineReadPath(repoPath)).resolves.toBe(
      `${getRepoShadowDir(repoPath)}/checkout`,
    );
  });

  it('reads the repo root without waiting on the remote while the first shadow is created', async () => {
    // A dedicated repo path: the never-resolving remote lookup below holds
    // this repo's lock for the rest of the suite.
    const repoPath = '/Users/me/repo-baseline-first-create';
    // `git ls-remote` waiting on a credential helper that never answers.
    mockedDefaultBranch.mockImplementation(
      () => new Promise<string | null>(() => {}),
    );

    await expect(getBaselineReadPath(repoPath)).resolves.toBe(repoPath);
    await flushMicrotasks();
    expect(mockedDefaultBranch).toHaveBeenCalledTimes(1);

    // A second read neither waits nor starts a second lookup.
    await expect(getBaselineReadPath(repoPath)).resolves.toBe(repoPath);
    await flushMicrotasks();
    expect(mockedDefaultBranch).toHaveBeenCalledTimes(1);
  });

  it('serves the shadow once the background create completes', async () => {
    const repoPath = '/Users/me/repo-baseline-background-create';
    let releaseLookup: (branch: string) => void = () => undefined;
    mockedDefaultBranch.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          releaseLookup = resolve;
        }),
    );
    const writes: string[] = [];
    jest.mocked(writeFile).mockImplementation((_path, data) => {
      if (typeof data === 'string') writes.push(data);
      return Promise.resolve();
    });

    await expect(getBaselineReadPath(repoPath)).resolves.toBe(repoPath);
    await flushMicrotasks();
    expect(mockedDefaultBranch).toHaveBeenCalledTimes(1);
    releaseLookup('main');
    for (let tick = 0; tick < 50 && mockedAdd.mock.calls.length === 0; tick++) {
      await flushMicrotasks();
    }
    expect(mockedAdd).toHaveBeenCalledWith(
      repoPath,
      `${getRepoShadowDir(repoPath)}/checkout`,
      'origin/main',
    );

    const completed = writes.at(-1);
    if (completed === undefined) throw new Error('Expected shadow meta');
    mockedReadFile.mockResolvedValue(completed);
    await expect(getBaselineReadPath(repoPath)).resolves.toBe(
      `${getRepoShadowDir(repoPath)}/checkout`,
    );
  });
});

describe('cleanupUnreferencedRepoShadows', () => {
  beforeEach((): void => {
    jest.clearAllMocks();
    clearRepoShadowRuntimeCaches();
    setRepoShadowRetirementHandler(null);
    resetGitOpImplementations();
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedDefaultBranch.mockResolvedValue('main');
    getReaddirMock().mockResolvedValue([]);
  });

  it('removes shadows whose repo is no longer referenced but keeps referenced ones', async () => {
    getReaddirMock().mockResolvedValueOnce([
      { name: 'aaa', isDirectory: (): boolean => true },
      { name: 'bbb', isDirectory: (): boolean => true },
    ]);
    mockedReadFile.mockImplementation((path) => {
      const p = typeof path === 'string' ? path : '';
      if (p.includes('aaa')) {
        return Promise.resolve(
          JSON.stringify({ version: 1, repoPath: '/repo/kept' }),
        );
      }
      return Promise.resolve(
        JSON.stringify({ version: 1, repoPath: '/repo/gone' }),
      );
    });

    await cleanupUnreferencedRepoShadows(['/repo/kept']);

    expect(mockedRm).toHaveBeenCalledWith(expect.stringContaining('bbb'), {
      recursive: true,
      force: true,
    });
    expect(mockedRm).not.toHaveBeenCalledWith(
      expect.stringContaining('aaa'),
      expect.anything(),
    );
    expect(mockedRemoveGitWorktree).toHaveBeenCalledWith(
      '/repo/gone',
      expect.stringContaining('checkout'),
    );
    expect(mockedRemoveGitWorktree).not.toHaveBeenCalledWith(
      '/repo/kept',
      expect.anything(),
    );
  });

  it('serializes with an in-flight ensureRepoShadow for the same repo', async () => {
    const repoRoot = '/Users/me/repo';
    const shadowDir = getRepoShadowDir(repoRoot);
    const shadowDirName = shadowDir.slice(shadowDir.lastIndexOf('/') + 1);

    const order: string[] = [];

    let resolveFetchOrigin: () => void = () => undefined;
    const deferredFetchOrigin = new Promise<void>((resolve) => {
      resolveFetchOrigin = resolve;
    });
    mockedFetchOrigin.mockImplementation(() => {
      order.push('ensure:fetchOrigin');
      return deferredFetchOrigin;
    });

    // Stale meta drives ensureRepoShadow down the "refresh" path (which
    // pauses on fetchOrigin) instead of the "create from scratch" path.
    const staleMeta = {
      version: 1,
      repoPath: repoRoot,
      defaultBranch: 'main',
      lastSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(staleMeta));

    getReaddirMock().mockResolvedValueOnce([
      { name: shadowDirName, isDirectory: (): boolean => true },
    ]);

    mockedRm.mockImplementation(() => {
      order.push('cleanup:rm');
      return Promise.resolve(undefined);
    });

    const ensurePromise = ensureRepoShadow(repoRoot);
    await flushMicrotasks();
    expect(order).toEqual(['ensure:fetchOrigin']);

    const cleanupPromise = cleanupUnreferencedRepoShadows([]);
    await flushMicrotasks();
    // Cleanup must not touch the shadow while ensureRepoShadow is in flight.
    expect(order).toEqual(['ensure:fetchOrigin']);

    resolveFetchOrigin();
    await ensurePromise;
    await cleanupPromise;

    expect(order).toEqual(['ensure:fetchOrigin', 'cleanup:rm']);
  });

  it('holds the repository lock for the full leased callback', async () => {
    const repoRoot = '/Users/me/leased-repo';
    const shadowDir = getRepoShadowDir(repoRoot);
    const shadowDirName = shadowDir.slice(shadowDir.lastIndexOf('/') + 1);
    const order: string[] = [];
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        repoPath: repoRoot,
        defaultBranch: 'main',
        lastSyncAt: new Date().toISOString(),
      }),
    );
    getReaddirMock().mockResolvedValueOnce([
      { name: shadowDirName, isDirectory: (): boolean => true },
    ]);
    let releaseLease: () => void = () => undefined;
    const leaseGate = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    mockedRm.mockImplementation(() => {
      order.push('cleanup:rm');
      return Promise.resolve(undefined);
    });

    const lease = withEnsuredRepoShadow(repoRoot, {}, async () => {
      order.push('lease:start');
      await leaseGate;
      order.push('lease:end');
    });
    await flushMicrotasks();
    const cleanup = cleanupUnreferencedRepoShadows([]);
    await flushMicrotasks();
    expect(order).toEqual(['lease:start']);

    releaseLease();
    await lease;
    await cleanup;
    expect(order).toEqual(['lease:start', 'lease:end', 'cleanup:rm']);
  });

  it('awaits the retirement drain before taking the removal lock', async () => {
    const repoRoot = '/Users/me/retiring-repo';
    const shadowDir = getRepoShadowDir(repoRoot);
    const shadowDirName = shadowDir.slice(shadowDir.lastIndexOf('/') + 1);
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ version: 1, repoPath: repoRoot }),
    );
    getReaddirMock().mockResolvedValueOnce([
      { name: shadowDirName, isDirectory: (): boolean => true },
    ]);
    const order: string[] = [];
    let finishRetirement: () => void = () => undefined;
    const retirementGate = new Promise<void>((resolve) => {
      finishRetirement = resolve;
    });
    setRepoShadowRetirementHandler(async (retiringRoot) => {
      expect(retiringRoot).toBe(repoRoot);
      order.push('retire:start');
      await retirementGate;
      order.push('retire:end');
      return (): void => {
        order.push('retire:released');
      };
    });
    mockedRm.mockImplementation(() => {
      order.push('cleanup:rm');
      return Promise.resolve(undefined);
    });

    const cleanup = cleanupUnreferencedRepoShadows([]);
    await flushMicrotasks();
    expect(order).toEqual(['retire:start']);

    finishRetirement();
    await cleanup;
    expect(order).toEqual([
      'retire:start',
      'retire:end',
      'cleanup:rm',
      'retire:released',
    ]);
  });

  it('routes a provisional-meta shadow dir through the lock while ensure is creating it', async () => {
    const repoRoot = '/Users/me/repo';
    const shadowDir = getRepoShadowDir(repoRoot);
    const shadowDirName = shadowDir.slice(shadowDir.lastIndexOf('/') + 1);

    const order: string[] = [];

    // Ensure takes the create path (no meta yet on its own read)...
    mockedReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    // ...but by the time cleanup scans the dir, the provisional meta written
    // before fetch/checkout is on disk.
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        repoPath: repoRoot,
        defaultBranch: 'main',
        lastSyncAt: new Date(0).toISOString(),
      }),
    );

    let resolveFetchOrigin: () => void = () => undefined;
    const deferredFetchOrigin = new Promise<void>((resolve) => {
      resolveFetchOrigin = resolve;
    });
    mockedFetchOrigin.mockImplementation(() => {
      order.push('ensure:fetchOrigin');
      return deferredFetchOrigin;
    });
    mockedAdd.mockImplementation(() => {
      order.push('ensure:addWorktree');
      return Promise.resolve(undefined);
    });
    mockedRm.mockImplementation(() => {
      order.push('rm');
      return Promise.resolve(undefined);
    });

    getReaddirMock().mockResolvedValueOnce([
      { name: shadowDirName, isDirectory: (): boolean => true },
    ]);

    // Pause ensure mid-create: after removing the shadow's checkout and meta,
    // mkdir and the provisional meta, on fetch.
    const ensurePromise = ensureRepoShadow(repoRoot);
    await flushMicrotasks();
    expect(order).toEqual(['rm', 'rm', 'ensure:fetchOrigin']);

    const cleanupPromise = cleanupUnreferencedRepoShadows([]);
    await flushMicrotasks();
    // Cleanup derived the lock key from the provisional meta and is waiting
    // on the in-flight ensure instead of rm-ing the half-built shadow.
    expect(order).toEqual(['rm', 'rm', 'ensure:fetchOrigin']);

    resolveFetchOrigin();
    await ensurePromise;
    await cleanupPromise;

    expect(order).toEqual([
      'rm',
      'rm',
      'ensure:fetchOrigin',
      'ensure:addWorktree',
      'rm',
    ]);
  });

  it('still removes a truly meta-less shadow dir without a lock key', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    getReaddirMock().mockResolvedValueOnce([
      { name: 'deadbeefdeadbeef', isDirectory: (): boolean => true },
    ]);

    await cleanupUnreferencedRepoShadows([]);

    expect(mockedRm).toHaveBeenCalledWith(
      '/data/repo-shadows/deadbeefdeadbeef',
      {
        recursive: true,
        force: true,
      },
    );
  });
});
