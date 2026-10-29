import { FrameRegistry } from '../frame-registry';
import {
  buildConsistentModel as buildConsistentPair,
  MAX_CONSISTENT_BUILD_ATTEMPTS,
  PageModelCache,
  type PageModelBuild,
} from '../page-model';
import type { BrowserPageModel, PageModelCacheKey } from '../model-types';

function key(
  domEventRevision = 1,
  navigationSequence = 1,
  actionSequence = 1,
): PageModelCacheKey {
  return { domEventRevision, navigationSequence, actionSequence };
}

function model(capturedAt: string): BrowserPageModel {
  return {
    nodes: [],
    frames: [],
    coverage: [],
    registry: new FrameRegistry(),
    capturedAt,
    page: {
      browserId: '',
      url: '',
      title: '',
      viewport: { width: 0, height: 0, deviceScaleFactor: 1 },
      themeMode: 'light',
    },
    accessibility: [],
    listeners: [],
    styleSupplement: { candidates: 0, read: 0, skipped: 0 },
    trackerHistory: {
      inputs: 0,
      queried: 0,
      never: 0,
      was: 0,
      calls: 0,
      summaries: 0,
      durationMs: 0,
    },
    timings: {
      extractionMs: 0,
      assemblyMs: 0,
      accessibilityMs: 0,
      listenersMs: 0,
      styleSupplementMs: 0,
      totalMs: 0,
    },
  };
}

/** A build whose withheld re-assembly is recognizable by `capturedAt`. */
function asBuild(
  build: () => Promise<BrowserPageModel>,
): () => Promise<PageModelBuild> {
  return async () => {
    const built = await build();
    return {
      model: built,
      withheld: () => model(`withheld:${built.capturedAt}`),
    };
  };
}

function getOrBuild(
  cache: PageModelCache,
  currentKey: () => PageModelCacheKey,
  build: () => Promise<BrowserPageModel>,
): Promise<BrowserPageModel> {
  return cache.getOrBuild(currentKey, asBuild(build));
}

function buildConsistentModel(
  currentKey: () => PageModelCacheKey,
  build: () => Promise<BrowserPageModel>,
): ReturnType<typeof buildConsistentPair> {
  return buildConsistentPair(currentKey, asBuild(build));
}

describe('PageModelCache', () => {
  it('coalesces an identical in-flight build and serves it for 500 ms', async () => {
    let time = 100;
    let resolveBuild: ((value: BrowserPageModel) => void) | undefined;
    const cache = new PageModelCache(() => time);
    const built = model('built');
    const build = jest.fn(
      () =>
        new Promise<BrowserPageModel>((resolve) => {
          resolveBuild = resolve;
        }),
    );

    const first = getOrBuild(cache, () => key(), build);
    const second = getOrBuild(cache, () => key(), build);
    expect(build).toHaveBeenCalledTimes(1);
    resolveBuild?.(built);
    await expect(first).resolves.toBe(built);
    await expect(second).resolves.toBe(built);
    expect(cache.hasFresh(key())).toBe(true);

    time = 599;
    await expect(
      getOrBuild(
        cache,
        () => key(),
        () => Promise.resolve(model('wrong')),
      ),
    ).resolves.toBe(built);
    time = 600;
    await expect(
      getOrBuild(
        cache,
        () => key(),
        () => Promise.resolve(model('expired')),
      ),
    ).resolves.toMatchObject({ capturedAt: 'expired' });
  });

  it('uses every revision component as part of the cache key', async () => {
    const cache = new PageModelCache(() => 10);
    const builds: string[] = [];
    const build = (label: string): Promise<BrowserPageModel> => {
      builds.push(label);
      return Promise.resolve(model(label));
    };
    await getOrBuild(
      cache,
      () => key(1, 1, 1),
      () => build('initial'),
    );
    await getOrBuild(
      cache,
      () => key(2, 1, 1),
      () => build('dom'),
    );
    await getOrBuild(
      cache,
      () => key(2, 2, 1),
      () => build('navigation'),
    );
    await getOrBuild(
      cache,
      () => key(2, 2, 2),
      () => build('action'),
    );
    expect(builds).toEqual(['initial', 'dom', 'navigation', 'action']);
  });

  it('compares the key when a build completes and retries a build the page changed under (M6)', async () => {
    let current = key(1);
    const cache = new PageModelCache(() => 10);
    const builds: string[] = [];
    const result = await getOrBuild(
      cache,
      () => current,
      () => {
        builds.push(`build-${builds.length + 1}`);
        // A DOM event arrives while the first build is in flight.
        if (builds.length === 1) current = key(2);
        return Promise.resolve(model(`build-${builds.length}`));
      },
    );
    expect(builds).toEqual(['build-1', 'build-2']);
    expect(result.capturedAt).toBe('build-2');
    expect(cache.hasFresh(key(2))).toBe(true);
    expect(cache.hasFresh(key(1))).toBe(false);
  });

  it('returns a model for a continuously mutating page and does not cache it', async () => {
    let revision = 1;
    const cache = new PageModelCache(() => 10);
    const build = jest.fn(() => {
      revision += 1;
      return Promise.resolve(model(`revision-${revision}`));
    });
    const result = await getOrBuild(cache, () => key(revision), build);
    expect(build).toHaveBeenCalledTimes(MAX_CONSISTENT_BUILD_ATTEMPTS);
    // No third capture: the last capture, re-assembled with values withheld.
    expect(result.capturedAt).toBe(
      `withheld:revision-${1 + MAX_CONSISTENT_BUILD_ATTEMPTS}`,
    );
    expect(cache.hasFresh(key(revision))).toBe(false);
  });

  it('retries a build that was invalidated in flight and never caches the stale one', async () => {
    const cache = new PageModelCache(() => 10);
    const resolvers: Array<(value: BrowserPageModel) => void> = [];
    const pending = getOrBuild(
      cache,
      () => key(),
      () =>
        new Promise<BrowserPageModel>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    cache.invalidate();
    resolvers[0]?.(model('stale'));
    await Promise.resolve();
    await Promise.resolve();
    resolvers[1]?.(model('fresh'));
    await expect(pending).resolves.toMatchObject({ capturedAt: 'fresh' });
    expect(resolvers).toHaveLength(2);
    expect(cache.hasFresh(key())).toBe(true);
  });

  it('propagates a build error and permits a retry', async () => {
    const cache = new PageModelCache(() => 10);
    await expect(
      getOrBuild(
        cache,
        () => key(),
        () => Promise.reject(new Error('CDP failed')),
      ),
    ).rejects.toThrow('CDP failed');
    await expect(
      getOrBuild(
        cache,
        () => key(),
        () => Promise.resolve(model('retry')),
      ),
    ).resolves.toMatchObject({ capturedAt: 'retry' });
  });
});

describe('buildConsistentModel', () => {
  it('builds once when the key holds and reports consistency', async () => {
    const result = await buildConsistentModel(
      () => key(),
      () => Promise.resolve(model('once')),
    );
    expect(result).toMatchObject({ consistent: true, key: key() });
    expect(result.model.capturedAt).toBe('once');
  });
});
