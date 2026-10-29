import type * as FsPromisesModule from 'node:fs/promises';

// Failure injection; everything not armed passes through to the real
// filesystem. `rename` rejection is one-shot (the next call rejects), which
// forces a usage-store write failure while leaving the best-effort store
// invalidation writable. `unlink` rejection persists while armed — a failed
// mutation unlinks twice (temp-file cleanup, then store invalidation), and
// both must fail for the stale store to stay on disk. Injection is used
// instead of chmod-based setups because the writer re-tightens the scope
// directory to owner-only on every write, undoing permission tricks.
let mockRenameRejection: Error | null = null;
let mockUnlinkRejection: Error | null = null;

jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  const rename = async (
    ...args: Parameters<typeof actual.rename>
  ): Promise<void> => {
    if (mockRenameRejection !== null) {
      const error = mockRenameRejection;
      mockRenameRejection = null;
      throw error;
    }
    return actual.rename(...args);
  };
  const unlink = async (
    ...args: Parameters<typeof actual.unlink>
  ): Promise<void> => {
    if (mockUnlinkRejection !== null) {
      throw mockUnlinkRejection;
    }
    return actual.unlink(...args);
  };
  return { ...actual, rename, unlink };
});

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteStaleUsageRows } from '../memory/local/consolidation-usage-cleanup';
import { isRecord } from '../lib/type-guards';
import {
  deleteUsageEntries,
  flushPendingUsage,
  readUsage,
  recordUsage,
  recordUsageSoon,
  seedEntry,
  USAGE_BATCH_DELAY_MS,
  usageEntryFor,
} from '../memory/local/usage';

const itOnPosix = process.platform === 'win32' ? it.skip : it;

describe('local memory usage store', () => {
  let scopeDir: string;

  beforeEach(async () => {
    scopeDir = await mkdtemp(join(tmpdir(), 'local-memory-usage-'));
  });

  afterEach(async () => {
    await rm(scopeDir, { recursive: true, force: true });
  });

  it('batches injected uses into one write that every reader sees first', async () => {
    recordUsageSoon(scopeDir, ['topics/a.md', 'topics/b.md']);
    recordUsageSoon(scopeDir, ['topics/a.md', 'topics/a.md']);
    // Nothing is written on the hot path.
    expect(existsSync(join(scopeDir, 'usage.json'))).toBe(false);

    const usage = await readUsage(scopeDir);
    expect(usage.entries.get('topics/a.md')?.usageCount).toBe(2);
    expect(usage.entries.get('topics/b.md')?.usageCount).toBe(1);
    expect(usage.entries.get('topics/a.md')?.lastUsedAt).toEqual(
      expect.any(String),
    );
  });

  it('resolves deferred keys when the batch is applied, once per use', async () => {
    const resolveTopics = jest.fn(() => ['topics/a.md', 'Topics/A.md']);
    recordUsageSoon(scopeDir, ['inbox/note.md'], resolveTopics);
    recordUsageSoon(scopeDir, [], resolveTopics);
    recordUsageSoon(scopeDir, [], () => {
      throw new Error('unparseable excerpt');
    });
    // Recording a use never resolves its deferred keys.
    expect(resolveTopics).not.toHaveBeenCalled();

    const usage = await readUsage(scopeDir);
    expect(resolveTopics).toHaveBeenCalledTimes(2);
    expect(usage.entries.get('topics/a.md')?.usageCount).toBe(2);
    expect(usage.entries.get('inbox/note.md')?.usageCount).toBe(1);
  });

  it('writes nothing when deferred keys name no file', async () => {
    recordUsageSoon(scopeDir, [], () => []);
    await flushPendingUsage();
    expect(existsSync(join(scopeDir, 'usage.json'))).toBe(false);
  });

  it('writes batched uses after the delay and on shutdown', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      recordUsageSoon(scopeDir, ['topics/a.md']);
      jest.advanceTimersByTime(USAGE_BATCH_DELAY_MS);
    } finally {
      jest.useRealTimers();
    }
    await flushPendingUsage();
    expect(
      (await readUsage(scopeDir)).entries.get('topics/a.md')?.usageCount,
    ).toBe(1);

    recordUsageSoon(scopeDir, ['topics/a.md']);
    await flushPendingUsage();
    const persisted: unknown = JSON.parse(
      await readFile(join(scopeDir, 'usage.json'), 'utf8'),
    );
    expect(persisted).toMatchObject({
      entries: { 'topics/a.md': { usageCount: 2 } },
    });
  });

  it('applies batched uses before a later deletion of the same row', async () => {
    await seedEntry(scopeDir, 'topics/gone.md');
    recordUsageSoon(scopeDir, ['topics/gone.md']);
    await deleteUsageEntries(scopeDir, ['topics/gone.md']);
    expect((await readUsage(scopeDir)).entries.has('topics/gone.md')).toBe(
      false,
    );
  });

  it('seeds without counting and records deduplicated usage bumps', async () => {
    await seedEntry(scopeDir, 'inbox/note.md');
    let usage = await readUsage(scopeDir);
    expect(usage.trackingSince).toEqual(expect.any(String));
    expect(usage.entries.get('inbox/note.md')).toMatchObject({
      usageCount: 0,
      lastUsedAt: null,
    });

    await recordUsage(scopeDir, ['inbox/note.md', 'inbox/note.md']);
    await recordUsage(scopeDir, ['inbox/note.md', 'topics/build.md']);
    usage = await readUsage(scopeDir);
    expect(usage.entries.get('inbox/note.md')?.usageCount).toBe(2);
    expect(usage.entries.get('inbox/note.md')?.lastUsedAt).toEqual(
      expect.any(String),
    );
    expect(usage.entries.get('topics/build.md')?.usageCount).toBe(1);
    expect(usage.entries.get('topics/build.md')?.createdAt).toEqual(
      expect.any(String),
    );
  });

  it('does not lose bumps from overlapping usage writes to one scope', async () => {
    await Promise.all([
      recordUsage(scopeDir, ['topics/hot.md']),
      recordUsage(scopeDir, ['topics/hot.md']),
      recordUsage(scopeDir, ['topics/hot.md']),
      seedEntry(scopeDir, 'inbox/seeded.md'),
    ]);

    const usage = await readUsage(scopeDir);
    expect(usage.entries.get('topics/hot.md')?.usageCount).toBe(3);
    expect(usage.entries.get('inbox/seeded.md')?.usageCount).toBe(0);
  });

  it('observes an in-flight usage write instead of a stale snapshot', async () => {
    await seedEntry(scopeDir, 'topics/hot.md');

    // Deliberately not awaited: the read must join the per-scope mutation
    // chain and report the completed bump, never the pre-write zero-count
    // snapshot a concurrent prune revalidation would otherwise act on.
    const pendingBump = recordUsage(scopeDir, ['topics/hot.md']);
    const usage = await readUsage(scopeDir);

    expect(usage.entries.get('topics/hot.md')?.usageCount).toBe(1);
    await pendingBump;
  });

  it('returns unavailable tracking without creating a missing scope or store', async () => {
    const missingScopeDir = join(scopeDir, 'deleted-workspace-memory');

    await expect(readUsage(missingScopeDir)).resolves.toEqual({
      trackingSince: null,
      entries: new Map(),
    });
    expect(existsSync(missingScopeDir)).toBe(false);
    expect(existsSync(join(missingScopeDir, 'usage.json'))).toBe(false);
  });

  it('reads a corrupt store as unavailable and resets tracking on the next write', async () => {
    await writeFile(join(scopeDir, 'usage.json'), '{not-json');

    // The read path only surfaces "tracking unavailable"; it must not
    // silently convert corruption into zero counts.
    await expect(readUsage(scopeDir)).resolves.toEqual({
      trackingSince: null,
      entries: new Map(),
    });

    const before = Date.now();
    await seedEntry(scopeDir, 'topics/recovered.md');
    const usage = await readUsage(scopeDir);
    expect(usage.entries.get('topics/recovered.md')?.usageCount).toBe(0);
    // Recreation restarts the tracking window instead of inheriting one.
    expect(usage.trackingSince).toEqual(expect.any(String));
    if (usage.trackingSince === null) {
      throw new Error('expected trackingSince after recreation');
    }
    expect(Date.parse(usage.trackingSince)).toBeGreaterThanOrEqual(
      before - 1_000,
    );
  });

  it('treats an incompatible version as unavailable and resets on write', async () => {
    await writeFile(
      join(scopeDir, 'usage.json'),
      `${JSON.stringify({
        version: 999,
        trackingSince: '2026-01-01T00:00:00.000Z',
        entries: {
          'topics/stale.md': {
            usageCount: 9,
            lastUsedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      })}\n`,
    );

    await expect(readUsage(scopeDir)).resolves.toEqual({
      trackingSince: null,
      entries: new Map(),
    });

    await seedEntry(scopeDir, 'topics/recovered.md');
    const usage = await readUsage(scopeDir);
    expect(usage.entries.get('topics/stale.md')).toBeUndefined();
    expect(usage.entries.get('topics/recovered.md')?.usageCount).toBe(0);
    expect(usage.trackingSince).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('treats a store with one malformed entry as wholly unavailable', async () => {
    await writeFile(
      join(scopeDir, 'usage.json'),
      `${JSON.stringify({
        version: 1,
        trackingSince: '2026-01-01T00:00:00.000Z',
        entries: {
          'topics/valid.md': {
            usageCount: 3,
            lastUsedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          'topics/broken.md': {
            usageCount: 'many',
            lastUsedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      })}\n`,
    );

    // One malformed row poisons the whole store: dropping just that row
    // would be indistinguishable from "never used" while the retained
    // tracking window still authorized pruning.
    await expect(readUsage(scopeDir)).resolves.toEqual({
      trackingSince: null,
      entries: new Map(),
    });

    // The next write recreates the store with a fresh tracking window.
    await seedEntry(scopeDir, 'topics/recovered.md');
    const usage = await readUsage(scopeDir);
    expect(usage.entries.get('topics/valid.md')).toBeUndefined();
    expect(usage.entries.get('topics/recovered.md')?.usageCount).toBe(0);
    expect(usage.trackingSince).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('treats a store containing an invalid file key as wholly unavailable', async () => {
    await writeFile(
      join(scopeDir, 'usage.json'),
      `${JSON.stringify({
        version: 1,
        trackingSince: '2026-01-01T00:00:00.000Z',
        entries: {
          '../escape.md': {
            usageCount: 1,
            lastUsedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      })}\n`,
    );

    await expect(readUsage(scopeDir)).resolves.toEqual({
      trackingSince: null,
      entries: new Map(),
    });
  });

  it('treats post-normalization key collisions as store corruption', async () => {
    await writeFile(
      join(scopeDir, 'usage.json'),
      `${JSON.stringify({
        version: 1,
        trackingSince: '2026-01-01T00:00:00.000Z',
        entries: {
          'topics/a.md': {
            usageCount: 3,
            lastUsedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          './topics/a.md': {
            usageCount: 0,
            lastUsedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      })}\n`,
    );

    // Two distinct on-disk keys collapsing to one normalized key would
    // otherwise silently last-win, losing a row whose absence reads as
    // "never used" while the tracking window stayed valid. Same fail-closed
    // handling as any other invalid row.
    await expect(readUsage(scopeDir)).resolves.toEqual({
      trackingSince: null,
      entries: new Map(),
    });
  });

  it('merges rows that name one topic in different cases, keeping every use', async () => {
    // Written before topic keys were case-folded: one topic under the
    // spelling of its file and the spelling of an index link. Both rows are
    // the same file on macOS and Windows; neither may read as unused.
    await writeFile(
      join(scopeDir, 'usage.json'),
      `${JSON.stringify({
        version: 1,
        trackingSince: '2026-01-01T00:00:00.000Z',
        entries: {
          'topics/Build.md': {
            usageCount: 2,
            lastUsedAt: '2026-03-01T00:00:00.000Z',
            createdAt: '2026-02-01T00:00:00.000Z',
          },
          'topics/build.md': {
            usageCount: 3,
            lastUsedAt: '2026-04-01T00:00:00.000Z',
            createdAt: '2026-01-15T00:00:00.000Z',
          },
          'Topics/BUILD.md': {
            usageCount: 0,
            lastUsedAt: null,
            createdAt: '2026-01-20T00:00:00.000Z',
          },
          'inbox/2026-01-01T00-00-00Z-note.md': {
            usageCount: 1,
            lastUsedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      })}\n`,
    );

    const merged = await readUsage(scopeDir);
    expect(merged.trackingSince).toBe('2026-01-01T00:00:00.000Z');
    expect(merged.entries).toEqual(
      new Map([
        [
          'topics/build.md',
          {
            usageCount: 5,
            lastUsedAt: '2026-04-01T00:00:00.000Z',
            createdAt: '2026-01-15T00:00:00.000Z',
          },
        ],
        [
          'inbox/2026-01-01T00-00-00Z-note.md',
          {
            usageCount: 1,
            lastUsedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      ]),
    );

    // The next write stores the merged row under the folded key only.
    await recordUsage(scopeDir, ['topics/BUILD.md']);
    const raw: unknown = JSON.parse(
      await readFile(join(scopeDir, 'usage.json'), 'utf8'),
    );
    if (!isRecord(raw) || !isRecord(raw.entries)) {
      throw new Error('usage.json must be a JSON object with entries');
    }
    expect(Object.keys(raw.entries).sort()).toEqual([
      'inbox/2026-01-01T00-00-00Z-note.md',
      'topics/build.md',
    ]);
    expect(raw.entries['topics/build.md']).toMatchObject({ usageCount: 6 });
    expect(raw.trackingSince).toBe('2026-01-01T00:00:00.000Z');
  });

  it('records every spelling of a topic on one row', async () => {
    await recordUsage(scopeDir, ['topics/Build.md', 'topics/build.md']);
    await recordUsage(scopeDir, ['Topics/BUILD.md']);
    recordUsageSoon(scopeDir, ['topics/build.MD']);

    const usage = await readUsage(scopeDir);
    expect(Array.from(usage.entries.keys())).toEqual(['topics/build.md']);
    expect(usage.entries.get('topics/build.md')?.usageCount).toBe(3);
    expect(usageEntryFor(usage.entries, 'topics/Build.md')?.usageCount).toBe(3);
  });

  it('deletes entries without restarting tracking or creating a missing store', async () => {
    await seedEntry(scopeDir, 'topics/kept.md');
    await seedEntry(scopeDir, 'topics/gone.md');
    const { trackingSince } = await readUsage(scopeDir);

    await deleteUsageEntries(scopeDir, ['topics/gone.md']);
    const usage = await readUsage(scopeDir);
    expect(Array.from(usage.entries.keys())).toEqual(['topics/kept.md']);
    expect(usage.trackingSince).toBe(trackingSince);

    const missingScopeDir = join(scopeDir, 'deleted-workspace-memory');
    await deleteUsageEntries(missingScopeDir, ['topics/anything.md']);
    expect(existsSync(join(missingScopeDir, 'usage.json'))).toBe(false);
  });

  it('persists a versioned normalized file', async () => {
    await recordUsage(scopeDir, ['topics/build.md', './topics/../evil.md']);

    const raw: unknown = JSON.parse(
      await readFile(join(scopeDir, 'usage.json'), 'utf8'),
    );
    if (!isRecord(raw) || !isRecord(raw.entries)) {
      throw new Error('usage.json must be a JSON object with entries');
    }
    expect(raw.version).toBe(1);
    expect(typeof raw.trackingSince).toBe('string');
    // The path-traversal key is dropped by normalization on write.
    expect(Object.keys(raw.entries)).toEqual(['topics/build.md']);
    expect(raw.entries['topics/build.md']).toMatchObject({ usageCount: 1 });
    const usage = await readUsage(scopeDir);
    expect(usage.entries.get('topics/build.md')?.lastUsedAt).toEqual(
      expect.any(String),
    );
    expect(usage.entries.get('topics/build.md')?.createdAt).toEqual(
      expect.any(String),
    );
  });

  it('fails closed for the scope when a usage mutation cannot persist', async () => {
    await seedEntry(scopeDir, 'topics/hot.md');
    const before = await readUsage(scopeDir);
    expect(before.trackingSince).toEqual(expect.any(String));
    expect(before.entries.get('topics/hot.md')?.usageCount).toBe(0);

    // Make both the write and the best-effort store invalidation fail: the
    // stale zero-count row stays on disk, and only the in-memory failure
    // flag keeps it from reading as non-use evidence.
    try {
      mockRenameRejection = new Error('EACCES: usage write failed');
      mockUnlinkRejection = new Error('EACCES: invalidation failed');
      await recordUsage(scopeDir, ['topics/hot.md']);
      expect(existsSync(join(scopeDir, 'usage.json'))).toBe(true);

      // The recorded hit was lost. The old zero-count row and tracking
      // window must not read as affirmative evidence of non-use: the
      // scope reports "tracking unavailable" until a successful write.
      await expect(readUsage(scopeDir)).resolves.toEqual({
        trackingSince: null,
        entries: new Map(),
      });
    } finally {
      mockRenameRejection = null;
      mockUnlinkRejection = null;
    }

    // A subsequent successful write restores tracking with a fresh
    // window: the stale pre-failure rows are gone, not resurrected.
    await recordUsage(scopeDir, ['topics/fresh.md']);
    const recovered = await readUsage(scopeDir);
    expect(recovered.trackingSince).toEqual(expect.any(String));
    expect(Array.from(recovered.entries.keys())).toEqual(['topics/fresh.md']);
    expect(recovered.entries.get('topics/fresh.md')?.usageCount).toBe(1);
  });

  it('invalidates the persisted store when a usage write fails', async () => {
    await seedEntry(scopeDir, 'topics/hot.md');
    expect(existsSync(join(scopeDir, 'usage.json'))).toBe(true);

    try {
      mockRenameRejection = new Error('EIO: usage write failed');
      await recordUsage(scopeDir, ['topics/hot.md']);

      // The failed mutation must not leave a valid-looking stale store on
      // disk: fail-closed state has to survive a process restart, so the
      // persisted file is invalidated best-effort.
      expect(existsSync(join(scopeDir, 'usage.json'))).toBe(false);
      await expect(readUsage(scopeDir)).resolves.toEqual({
        trackingSince: null,
        entries: new Map(),
      });
    } finally {
      mockRenameRejection = null;
    }

    // Recovery: the next successful write recreates the store with a fresh
    // tracking window instead of trusting anything that predates the failure.
    await recordUsage(scopeDir, ['topics/fresh.md']);
    const recovered = await readUsage(scopeDir);
    expect(recovered.trackingSince).toEqual(expect.any(String));
    expect(Array.from(recovered.entries.keys())).toEqual(['topics/fresh.md']);
  });

  it('does not create a store when deleting from a failure-flagged scope', async () => {
    await seedEntry(scopeDir, 'topics/hot.md');

    try {
      mockRenameRejection = new Error('EIO: usage write failed');
      await recordUsage(scopeDir, ['topics/hot.md']);
    } finally {
      mockRenameRejection = null;
    }
    // The failed mutation flagged the scope and invalidated the store.
    expect(existsSync(join(scopeDir, 'usage.json'))).toBe(false);

    // Deleting rows never creates a missing store — not even on a flagged
    // scope, where the corrupt-recreate override must not fabricate a
    // fresh tracking window (and clear the flag) out of a deletion.
    await deleteUsageEntries(scopeDir, ['topics/hot.md']);
    expect(existsSync(join(scopeDir, 'usage.json'))).toBe(false);
    await expect(readUsage(scopeDir)).resolves.toEqual({
      trackingSince: null,
      entries: new Map(),
    });

    // The failure flag stays intact: only a real write recreates the store,
    // and it restarts the tracking window when it does.
    await recordUsage(scopeDir, ['topics/fresh.md']);
    const recovered = await readUsage(scopeDir);
    expect(recovered.trackingSince).toEqual(expect.any(String));
    expect(Array.from(recovered.entries.keys())).toEqual(['topics/fresh.md']);
  });

  it('swallows a corrupt store during stale-row cleanup', async () => {
    await writeFile(join(scopeDir, 'usage.json'), 'not a json document');

    await expect(
      deleteStaleUsageRows(scopeDir, ['topics/missing.md']),
    ).resolves.toBeUndefined();
  });

  it('removes only rows whose files no longer exist during cleanup', async () => {
    await writeFile(join(scopeDir, 'present.md'), 'still here');
    await seedEntry(scopeDir, 'present.md');
    await seedEntry(scopeDir, 'inbox/missing.md');

    await deleteStaleUsageRows(
      scopeDir,
      (await readUsage(scopeDir)).entries.keys(),
    );

    const usage = await readUsage(scopeDir);
    expect(Array.from(usage.entries.keys())).toEqual(['present.md']);
  });

  it('keeps a topic row while a file of that topic exists in any case', async () => {
    await mkdir(join(scopeDir, 'topics'), { recursive: true });
    await writeFile(join(scopeDir, 'topics', 'Build.md'), 'pnpm build');
    await recordUsage(scopeDir, ['topics/build.md', 'topics/gone.md']);

    await deleteStaleUsageRows(
      scopeDir,
      (await readUsage(scopeDir)).entries.keys(),
    );

    const usage = await readUsage(scopeDir);
    expect(Array.from(usage.entries.keys())).toEqual(['topics/build.md']);
  });

  itOnPosix(
    'retains rows on ambiguous fs errors and deletes only on definitive absence',
    async () => {
      const lockedDir = join(scopeDir, 'locked');
      await mkdir(lockedDir, { recursive: true });
      await writeFile(join(lockedDir, 'file.md'), 'guarded', 'utf8');
      await writeFile(join(scopeDir, 'note.md'), 'plain file', 'utf8');
      await seedEntry(scopeDir, 'locked/file.md');
      await seedEntry(scopeDir, 'inbox/missing.md');
      // ENOTDIR: a path component that is a regular file, not a directory.
      await seedEntry(scopeDir, 'note.md/child.md');
      await chmod(lockedDir, 0o000);

      try {
        await deleteStaleUsageRows(
          scopeDir,
          (await readUsage(scopeDir)).entries.keys(),
        );
      } finally {
        await chmod(lockedDir, 0o700);
      }

      const usage = await readUsage(scopeDir);
      // EACCES is ambiguous, so the row survives; ENOENT and ENOTDIR are
      // definitive absence, so those rows are deleted.
      expect(Array.from(usage.entries.keys()).sort()).toEqual([
        'locked/file.md',
      ]);
    },
  );
});
