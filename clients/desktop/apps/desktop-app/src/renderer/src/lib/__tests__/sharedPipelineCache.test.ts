/**
 * @jest-environment jsdom
 */
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import type * as SharedPipelineCache from '../sharedPipelineCache';

function makeRow(remoteId: string, name: string): PipelineInfo {
  return {
    id: `shared:canopy-cloud:${remoteId}`,
    name,
    filename: '',
    description: '',
    icon: '',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    source: 'shared',
    readonly: false,
    serverId: 'canopy-cloud',
    remoteId,
    triggerTypes: ['dispatch'],
  };
}

// The cache is a module singleton hydrated from localStorage at import time, so
// each test resets modules and re-imports to get a clean, isolated instance.
async function loadCache(): Promise<typeof SharedPipelineCache> {
  return import('../sharedPipelineCache');
}

describe('sharedPipelineCache', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.resetModules();
  });

  it('builds a cache key only for the default (unfiltered) list per trigger', async () => {
    const cache = await loadCache();
    expect(cache.sharedPipelineCacheKey('acct-1', {})).toBe('acct-1::all');
    expect(
      cache.sharedPipelineCacheKey('acct-1', { triggerType: 'plan_ready' }),
    ).toBe('acct-1::plan_ready');
    // Not cacheable: search text, createdBy filter, or no account identity.
    expect(cache.sharedPipelineCacheKey('acct-1', { q: 'foo' })).toBeNull();
    expect(
      cache.sharedPipelineCacheKey('acct-1', { createdBy: 'user-1' }),
    ).toBeNull();
    expect(cache.sharedPipelineCacheKey(null, {})).toBeNull();
  });

  it('round-trips rows and nextCursor through write/read', async () => {
    const cache = await loadCache();
    const entry = { rows: [makeRow('a', 'A')], nextCursor: 'cur-1' };
    cache.writeSharedPipelineCache('acct-1::all', entry);

    const read = cache.readSharedPipelineCache('acct-1::all');
    expect(read?.rows.map((r) => r.remoteId)).toEqual(['a']);
    expect(read?.nextCursor).toBe('cur-1');
    expect(cache.readSharedPipelineCache('missing')).toBeNull();
  });

  it('persists to localStorage so a fresh import hydrates the same data', async () => {
    const first = await loadCache();
    first.writeSharedPipelineCache('acct-1::all', {
      rows: [makeRow('a', 'A')],
      nextCursor: null,
    });
    first.writeLastSharedAccountIdentity('acct-1');

    // Simulate a reload: drop the module instance and re-import.
    jest.resetModules();
    const second = await loadCache();
    expect(second.readLastSharedAccountIdentity()).toBe('acct-1');
    expect(
      second.readSharedPipelineCache('acct-1::all')?.rows.map((r) => r.name),
    ).toEqual(['A']);
  });

  it('skips cached entries whose rows are not pipeline-like objects', async () => {
    localStorage.setItem(
      'canopy.sharedPipelineCache.v1',
      JSON.stringify({
        lastAccountIdentity: 'acct-1',
        entries: {
          'acct-1::all': {
            rows: ['not-a-row'],
            nextCursor: null,
          },
          'acct-1::dispatch': {
            rows: [makeRow('a', 'A')],
            nextCursor: null,
          },
        },
      }),
    );

    const cache = await loadCache();

    expect(cache.readSharedPipelineCache('acct-1::all')).toBeNull();
    expect(
      cache.readSharedPipelineCache('acct-1::dispatch')?.rows.map((r) => r.id),
    ).toEqual(['shared:canopy-cloud:a']);
  });

  it('removes a deleted row from every cached list', async () => {
    const cache = await loadCache();
    cache.writeSharedPipelineCache('acct-1::all', {
      rows: [makeRow('a', 'A'), makeRow('b', 'B')],
      nextCursor: null,
    });
    cache.writeSharedPipelineCache('acct-1::dispatch', {
      rows: [makeRow('a', 'A')],
      nextCursor: null,
    });

    cache.removeRowFromSharedPipelineCache('a');

    expect(
      cache.readSharedPipelineCache('acct-1::all')?.rows.map((r) => r.remoteId),
    ).toEqual(['b']);
    expect(
      cache
        .readSharedPipelineCache('acct-1::dispatch')
        ?.rows.map((r) => r.remoteId),
    ).toEqual([]);
  });

  it('keeps cached entries from a previous account (keys are namespaced)', async () => {
    const cache = await loadCache();
    cache.writeLastSharedAccountIdentity('acct-1');
    cache.writeSharedPipelineCache('acct-1::all', {
      rows: [makeRow('a', 'A')],
      nextCursor: null,
    });

    // Switching the recorded identity does not wipe the other account's entry.
    cache.writeLastSharedAccountIdentity('acct-2');
    expect(cache.readLastSharedAccountIdentity()).toBe('acct-2');
    expect(cache.readSharedPipelineCache('acct-1::all')?.rows).toHaveLength(1);
    // ...and the new account simply has no entry yet.
    expect(cache.readSharedPipelineCache('acct-2::all')).toBeNull();
  });
});
