import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import type * as FsPromisesModule from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readImportState,
  writeImportState,
  type ImportState,
} from '../memory/local/import/ledger';
import { countPendingSources } from '../memory/local/pending-sources';
import {
  clearConsolidatedMemory,
  consolidatedSourcesFullyRestored,
  drainConsolidation,
  planConsolidatedSourceRestore,
  REBUILD_IMPORT_LEDGER_MISSING_REASON,
  REBUILD_IMPORT_LEDGER_UNREADABLE_REASON,
  REBUILD_IMPORTS_NOT_RECORDED_REASON,
  rebuildUnrecoverableImportsReason,
  restoreConsolidatedSources,
  type RestoredConsolidatedSources,
} from '../memory/local/rebuild';
import type { RunConsolidationResult } from '../memory/local/consolidation-task';
import {
  createLocalMemorySnapshot,
  isLocalMemorySnapshotId,
  listLocalMemorySnapshots,
  LOCAL_MEMORY_RESTORE_SCOPE_CHANGED_MESSAGE,
  LOCAL_MEMORY_SNAPSHOT_RETENTION,
  LocalMemoryScopeChangedError,
  localMemorySnapshotMatchesScope,
  readLocalMemorySnapshot,
  readLocalMemoryState,
  restoreLocalMemorySnapshot,
  runVerifiedLocalMemoryWrite,
  type LocalMemoryState,
} from '../memory/local/snapshots';
import { memoryEditRevision } from '../memory/local/edit-coordination';

const PROFILE_LINE =
  '- [Chat history profile](topics/chat-history-profile.md): Role: Engineer.';
const STAGED = 'claude-projects-memory-notes-0123456789abcdef.md';
const OTHER_STAGED = 'codex-memories-prefs-fedcba9876543210.md';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function write(
  scopeDir: string,
  fileKey: string,
  content: string,
): Promise<void> {
  const path = join(scopeDir, fileKey);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function read(scopeDir: string, fileKey: string): Promise<string> {
  return readFile(join(scopeDir, fileKey), 'utf8');
}

/** Clears the scope as a rebuild does, verified against its current state. */
async function clearScope(scopeDir: string): Promise<void> {
  await runVerifiedLocalMemoryWrite(
    scopeDir,
    [await readLocalMemoryState(scopeDir)],
    (guard) => clearConsolidatedMemory(scopeDir, guard),
  );
}

/** Temp files a write staged next to the index or a topic and left behind. */
async function stagedLeftovers(scopeDir: string): Promise<string[]> {
  const names = async (directory: string): Promise<string[]> =>
    readdir(directory).catch(() => []);
  return [
    ...(await names(scopeDir)),
    ...(await names(join(scopeDir, 'topics'))),
  ].filter((name) => name.endsWith('.tmp'));
}

/** Plans and runs the source restore, failing the test on a refusal. */
async function restoreSources(
  scopeDir: string,
): Promise<RestoredConsolidatedSources> {
  const plan = await planConsolidatedSourceRestore(scopeDir);
  if (!plan.ok) throw new Error(plan.reason);
  const restored = await restoreConsolidatedSources(scopeDir, plan.imports);
  expect(await consolidatedSourcesFullyRestored(scopeDir, restored)).toBe(true);
  return { inboxNotes: restored.inboxNotes, imports: restored.imports };
}

function stagedEntry(
  stagedAs: string,
  consolidatedAt?: string,
): ImportState['sources'][string] {
  return {
    fileHash: 'a'.repeat(64),
    importedAt: '2026-09-01T00:00:00.000Z',
    stagedAs,
    ...(consolidatedAt ? { consolidatedAt } : {}),
  };
}

describe('local memory rebuild', () => {
  let scopeDir: string;

  beforeEach(async () => {
    scopeDir = await mkdtemp(join(tmpdir(), 'local-memory-rebuild-'));
  });

  afterEach(async () => {
    await rm(scopeDir, { recursive: true, force: true });
  });

  describe('restoreConsolidatedSources', () => {
    it('returns archived notes to the inbox and leaves pruned topics archived', async () => {
      await write(scopeDir, 'inbox/.consolidated/2026-09-01-a.md', 'A');
      await write(scopeDir, 'inbox/.consolidated/2026-09-02-b.md', 'B');
      await write(scopeDir, 'inbox/.consolidated/topic-old.md', 'Old topic');
      await write(scopeDir, 'inbox/2026-09-03-c.md', 'C');

      const restored = await restoreSources(scopeDir);

      expect(restored).toEqual({ inboxNotes: 2, imports: 0 });
      expect((await readdir(join(scopeDir, 'inbox'))).sort()).toEqual([
        '.consolidated',
        '2026-09-01-a.md',
        '2026-09-02-b.md',
        '2026-09-03-c.md',
      ]);
      expect(await readdir(join(scopeDir, 'inbox', '.consolidated'))).toEqual([
        'topic-old.md',
      ]);
    });

    it('keeps a different pending note and skips an identical one', async () => {
      await write(scopeDir, 'inbox/.consolidated/same.md', 'Same');
      await write(scopeDir, 'inbox/same.md', 'Same');
      await write(scopeDir, 'inbox/.consolidated/clash.md', 'Archived');
      await write(scopeDir, 'inbox/clash.md', 'Pending');

      const restored = await restoreSources(scopeDir);

      expect(restored.inboxNotes).toBe(1);
      expect(await read(scopeDir, 'inbox/clash.md')).toBe('Pending');
      expect(await read(scopeDir, 'inbox/clash-2.md')).toBe('Archived');
      expect(await read(scopeDir, 'inbox/same.md')).toBe('Same');
      expect(
        await pathExists(join(scopeDir, 'inbox/.consolidated/same.md')),
      ).toBe(true);
    });

    it('restores the newest suffixed import copy under its ledger name and marks it pending', async () => {
      const stem = STAGED.slice(0, -3);
      await write(scopeDir, `imported/.consolidated/${STAGED}`, 'Older');
      await write(scopeDir, `imported/.consolidated/${stem}-2.md`, 'Newer');
      await write(scopeDir, `imported/.consolidated/${stem}-extra.md`, 'X');
      await write(scopeDir, 'imported/.consolidated/orphan.md', 'Orphan');
      await writeImportState(scopeDir, {
        version: 1,
        sources: {
          '/home/me/.claude/projects/memory/notes.md': stagedEntry(
            `imported/${STAGED}`,
            '2026-09-02T00:00:00.000Z',
          ),
          '/home/me/.codex/memories/big.md': {
            checkedAt: '2026-09-02T00:00:00.000Z',
            skipReason: 'oversize',
          },
        },
      });

      const restored = await restoreSources(scopeDir);

      expect(restored.imports).toBe(1);
      expect(await read(scopeDir, `imported/${STAGED}`)).toBe('Newer');
      expect(
        (await readdir(join(scopeDir, 'imported', '.consolidated'))).sort(),
      ).toEqual([STAGED, `${stem}-extra.md`, 'orphan.md'].sort());
      const ledger = await readImportState(scopeDir);
      expect(
        ledger.sources['/home/me/.claude/projects/memory/notes.md'],
      ).toEqual(stagedEntry(`imported/${STAGED}`));
      expect(ledger.sources['/home/me/.codex/memories/big.md']).toEqual({
        checkedAt: '2026-09-02T00:00:00.000Z',
        skipReason: 'oversize',
      });
    });

    it('clears a stale consolidated stamp on an import that is still staged', async () => {
      await write(scopeDir, `imported/${STAGED}`, 'Pending');
      await writeImportState(scopeDir, {
        version: 1,
        sources: {
          '/source.md': stagedEntry(
            `imported/${STAGED}`,
            '2026-09-02T00:00:00.000Z',
          ),
        },
      });

      await expect(restoreSources(scopeDir)).resolves.toEqual({
        inboxNotes: 0,
        imports: 0,
      });
      expect((await readImportState(scopeDir)).sources['/source.md']).toEqual(
        stagedEntry(`imported/${STAGED}`),
      );
    });
  });

  describe('planConsolidatedSourceRestore', () => {
    const corruptLedger = '{"version":1,"sources":{"/x.md":{"stagedAs":7}}}';

    it('refuses archived imports when the ledger is unreadable, leaving it as it was', async () => {
      await write(scopeDir, `imported/.consolidated/${STAGED}`, 'Archived');
      await write(scopeDir, 'import-state.json', corruptLedger);

      await expect(planConsolidatedSourceRestore(scopeDir)).resolves.toEqual({
        ok: false,
        reason: REBUILD_IMPORT_LEDGER_UNREADABLE_REASON,
      });
      // Not quarantined or reset: the bytes are still there to recover.
      expect(await read(scopeDir, 'import-state.json')).toBe(corruptLedger);
      expect(
        await pathExists(join(scopeDir, 'import-state.json.corrupt')),
      ).toBe(false);
    });

    it('refuses staged imports when the ledger is unreadable', async () => {
      await write(scopeDir, `imported/${STAGED}`, 'Staged');
      await write(scopeDir, 'import-state.json', 'not json');

      await expect(planConsolidatedSourceRestore(scopeDir)).resolves.toEqual({
        ok: false,
        reason: REBUILD_IMPORT_LEDGER_UNREADABLE_REASON,
      });
    });

    it('refuses archived imports when the ledger is missing', async () => {
      await write(scopeDir, `imported/.consolidated/${STAGED}`, 'Archived');

      await expect(planConsolidatedSourceRestore(scopeDir)).resolves.toEqual({
        ok: false,
        reason: REBUILD_IMPORT_LEDGER_MISSING_REASON,
      });
    });

    it('refuses staged imports when the ledger is missing', async () => {
      await write(scopeDir, `imported/${STAGED}`, 'Staged');

      await expect(planConsolidatedSourceRestore(scopeDir)).resolves.toEqual({
        ok: false,
        reason: REBUILD_IMPORT_LEDGER_MISSING_REASON,
      });
    });

    it('refuses a staged import the ledger does not name', async () => {
      await write(scopeDir, `imported/${STAGED}`, 'Staged');
      await write(scopeDir, `imported/${OTHER_STAGED}`, 'Not in the ledger');
      await writeImportState(scopeDir, {
        version: 1,
        sources: { '/source.md': stagedEntry(`imported/${STAGED}`) },
      });

      await expect(planConsolidatedSourceRestore(scopeDir)).resolves.toEqual({
        ok: false,
        reason: REBUILD_IMPORTS_NOT_RECORDED_REASON,
      });
    });

    it('leaves archived revisions the ledger no longer names archived', async () => {
      await write(scopeDir, `imported/${STAGED}`, 'Current');
      await write(scopeDir, `imported/.consolidated/${OTHER_STAGED}`, 'Older');
      await writeImportState(scopeDir, {
        version: 1,
        sources: { '/source.md': stagedEntry(`imported/${STAGED}`) },
      });

      await expect(planConsolidatedSourceRestore(scopeDir)).resolves.toEqual({
        ok: true,
        imports: {
          staged: [`imported/${STAGED}`],
          restores: [],
          restages: [],
          ledger: null,
          originalLedger: await read(scopeDir, 'import-state.json'),
        },
      });
    });

    it('accepts a scope that never imported anything', async () => {
      await write(scopeDir, 'inbox/.consolidated/a.md', 'A');
      await expect(planConsolidatedSourceRestore(scopeDir)).resolves.toEqual({
        ok: true,
        imports: {
          staged: [],
          restores: [],
          restages: [],
          ledger: null,
          originalLedger: null,
        },
      });
    });

    it('plans to stage an import again from its original when its archived copy is gone, changing nothing', async () => {
      const prefsSource = join(scopeDir, 'sources', 'prefs.md');
      await write(scopeDir, 'sources/prefs.md', 'Prefs');
      const entry = stagedEntry(
        `imported/${OTHER_STAGED}`,
        '2026-09-02T00:00:00.000Z',
      );
      await writeImportState(scopeDir, {
        version: 1,
        sources: { [prefsSource]: entry },
      });
      const ledgerBefore = await read(scopeDir, 'import-state.json');

      const plan = await planConsolidatedSourceRestore(scopeDir);

      expect(plan).toEqual({
        ok: true,
        imports: {
          staged: [],
          restores: [],
          restages: [{ sourcePath: prefsSource, entry }],
          ledger: null,
          originalLedger: ledgerBefore,
        },
      });
      expect(await read(scopeDir, 'import-state.json')).toBe(ledgerBefore);
      expect(await pathExists(join(scopeDir, 'imported'))).toBe(false);
    });

    it('refuses a consolidated import with no staged file, archived copy, or original', async () => {
      await writeImportState(scopeDir, {
        version: 1,
        sources: {
          [join(scopeDir, 'sources', 'deleted.md')]: stagedEntry(
            `imported/${STAGED}`,
            '2026-09-02T00:00:00.000Z',
          ),
        },
      });
      const ledgerBefore = await read(scopeDir, 'import-state.json');

      await expect(planConsolidatedSourceRestore(scopeDir)).resolves.toEqual({
        ok: false,
        reason: rebuildUnrecoverableImportsReason(1),
      });
      expect(await read(scopeDir, 'import-state.json')).toBe(ledgerBefore);
    });
  });

  it('puts every moved source back when the restore fails part way', async () => {
    await write(scopeDir, 'inbox/.consolidated/2026-09-01-a.md', 'A');
    await write(scopeDir, `imported/.consolidated/${STAGED}`, 'Archived');
    await writeImportState(scopeDir, {
      version: 1,
      sources: {
        '/source.md': stagedEntry(
          `imported/${STAGED}`,
          '2026-09-02T00:00:00.000Z',
        ),
      },
    });
    const plan = await planConsolidatedSourceRestore(scopeDir);
    if (!plan.ok) throw new Error(plan.reason);
    // The ledger write fails: its path is now a folder that is not empty.
    await rm(join(scopeDir, 'import-state.json'));
    await write(scopeDir, 'import-state.json/blocker', 'x');

    await expect(
      restoreConsolidatedSources(scopeDir, plan.imports),
    ).rejects.toThrow();

    expect(await readdir(join(scopeDir, 'inbox', '.consolidated'))).toEqual([
      '2026-09-01-a.md',
    ]);
    expect(await readdir(join(scopeDir, 'imported', '.consolidated'))).toEqual([
      STAGED,
    ]);
    expect(await pathExists(join(scopeDir, 'inbox', '2026-09-01-a.md'))).toBe(
      false,
    );
    expect(await pathExists(join(scopeDir, `imported/${STAGED}`))).toBe(false);
  });

  it('never replaces a pending note that appears under the archived name', async () => {
    await write(scopeDir, 'inbox/.consolidated/note.md', 'Archived');
    await write(scopeDir, 'inbox/note.md', 'Saved meanwhile');

    await expect(restoreSources(scopeDir)).resolves.toEqual({
      inboxNotes: 1,
      imports: 0,
    });
    expect(await read(scopeDir, 'inbox/note.md')).toBe('Saved meanwhile');
    expect(await read(scopeDir, 'inbox/note-2.md')).toBe('Archived');
  });

  describe('clearConsolidatedMemory', () => {
    it('keeps only the chat history profile topic and its index line', async () => {
      await write(
        scopeDir,
        'MEMORY.md',
        `# Memory\n\n${PROFILE_LINE}\n\n- [Travel](topics/travel.md)\n`,
      );
      await write(scopeDir, 'topics/travel.md', 'Window seat');
      await write(scopeDir, 'topics/chat-history-profile.md', 'Profile');

      await clearScope(scopeDir);

      expect(await read(scopeDir, 'MEMORY.md')).toBe(`${PROFILE_LINE}\n`);
      expect(await readdir(join(scopeDir, 'topics'))).toEqual([
        'chat-history-profile.md',
      ]);
    });

    it('leaves topic files a snapshot does not capture', async () => {
      await write(scopeDir, 'topics/travel.md', 'Window seat');
      await write(scopeDir, 'topics/.draft.md', 'Hidden draft');

      await clearScope(scopeDir);

      expect(await readdir(join(scopeDir, 'topics'))).toEqual(['.draft.md']);
    });

    it('keeps the profile topic whatever its case', async () => {
      await write(scopeDir, 'MEMORY.md', `${PROFILE_LINE}\n- Fact\n`);
      await write(scopeDir, 'topics/Chat-History-Profile.md', 'Profile');

      await clearScope(scopeDir);

      expect(await readdir(join(scopeDir, 'topics'))).toEqual([
        'Chat-History-Profile.md',
      ]);
      expect(await read(scopeDir, 'MEMORY.md')).toBe(`${PROFILE_LINE}\n`);
    });

    it('deletes nothing when a topic is edited after the index is staged', async () => {
      await write(scopeDir, 'MEMORY.md', `# Memory\n\n${PROFILE_LINE}\n`);
      await write(scopeDir, 'topics/travel.md', 'Window seat');
      await write(scopeDir, 'topics/chat-history-profile.md', 'Profile');
      const prior = await readLocalMemoryState(scopeDir);
      const fsPromises =
        jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
      const realWriteFile = fsPromises.writeFile;
      // The kept index line is staged first; the topic is edited outside
      // the app before anything is deleted.
      const spy = jest
        .spyOn(fsPromises, 'writeFile')
        .mockImplementation(async (file, data, options) => {
          await realWriteFile(file, data, options);
          if (typeof file === 'string' && file.endsWith('.tmp')) {
            await realWriteFile(
              join(scopeDir, 'topics', 'travel.md'),
              'Aisle, edited meanwhile',
            );
          }
        });
      try {
        await expect(
          runVerifiedLocalMemoryWrite(scopeDir, [prior], (guard) =>
            clearConsolidatedMemory(scopeDir, guard),
          ),
        ).rejects.toEqual(new LocalMemoryScopeChangedError(false));
      } finally {
        spy.mockRestore();
      }
      expect(await read(scopeDir, 'topics/travel.md')).toBe(
        'Aisle, edited meanwhile',
      );
      expect(await read(scopeDir, 'MEMORY.md')).toBe(
        `# Memory\n\n${PROFILE_LINE}\n`,
      );
      expect(await stagedLeftovers(scopeDir)).toEqual([]);
    });

    it('removes the index when there is no profile to keep', async () => {
      await write(scopeDir, 'MEMORY.md', `${PROFILE_LINE}\n- Fact\n`);
      await write(scopeDir, 'topics/travel.md', 'Window seat');

      await clearScope(scopeDir);

      expect(await pathExists(join(scopeDir, 'MEMORY.md'))).toBe(false);
      expect(await readdir(join(scopeDir, 'topics'))).toEqual([]);
    });
  });

  it('counts inbox notes and usable staged imports, but not archives or orphans', async () => {
    await write(scopeDir, 'inbox/a.md', 'A');
    await write(scopeDir, 'inbox/.consolidated/b.md', 'B');
    await write(scopeDir, `imported/${STAGED}`, 'C');
    await write(scopeDir, `imported/${OTHER_STAGED}`, 'orphan');
    await write(scopeDir, 'imported/.consolidated/d.md', 'D');
    await writeImportState(scopeDir, {
      version: 1,
      sources: { '/source.md': stagedEntry(`imported/${STAGED}`) },
    });
    await expect(countPendingSources(scopeDir)).resolves.toBe(2);
  });

  describe('drainConsolidation', () => {
    function runs(
      results: RunConsolidationResult[],
      pending: number[],
    ): {
      runOnce: jest.Mock<Promise<RunConsolidationResult>, []>;
      countPending: jest.Mock<Promise<number>, []>;
    } {
      const runOnce = jest.fn<Promise<RunConsolidationResult>, []>();
      for (const result of results) runOnce.mockResolvedValueOnce(result);
      const countPending = jest.fn<Promise<number>, []>();
      for (const count of pending) countPending.mockResolvedValueOnce(count);
      return { runOnce, countPending };
    }

    it('runs until nothing is pending', async () => {
      const options = runs(
        [{ status: 'success' }, { status: 'success' }],
        [300, 100, 0],
      );
      const onRun = jest.fn(() => Promise.resolve());
      await expect(drainConsolidation({ ...options, onRun })).resolves.toEqual({
        status: 'completed',
        runs: 2,
      });
      expect(onRun).toHaveBeenCalledTimes(2);
    });

    it('completes when a clean run leaves nothing pending', async () => {
      const options = runs(
        [{ status: 'success' }, { status: 'clean' }],
        [5, 1, 0],
      );
      await expect(drainConsolidation(options)).resolves.toEqual({
        status: 'completed',
        runs: 2,
      });
    });

    it('stops as undrainable when a clean run leaves sources pending', async () => {
      const options = runs([{ status: 'clean' }], [1, 1]);
      await expect(drainConsolidation(options)).resolves.toEqual({
        status: 'stopped',
        reason: 'undrainable',
        runs: 1,
      });
      expect(options.countPending).toHaveBeenCalledTimes(2);
    });

    it.each<[RunConsolidationResult, string]>([
      [
        { status: 'partial', reason: 'Partial consolidation: x' },
        'Partial consolidation: x',
      ],
      [{ status: 'failed', reason: 'model unavailable' }, 'model unavailable'],
      [{ status: 'cancelled' }, 'cancelled'],
      [{ status: 'invalid-output' }, 'invalid-output'],
    ])('stops at a run that does not succeed (%o)', async (result, reason) => {
      const options = runs([{ status: 'success' }, result], [9, 4]);
      await expect(drainConsolidation(options)).resolves.toEqual({
        status: 'stopped',
        reason,
        runs: 2,
      });
      expect(options.runOnce).toHaveBeenCalledTimes(2);
    });

    it('stops when a successful run leaves as much pending as before', async () => {
      const options = runs([{ status: 'success' }], [4, 4]);
      await expect(drainConsolidation(options)).resolves.toEqual({
        status: 'stopped',
        reason: 'no-progress',
        runs: 1,
      });
    });

    it('turns a thrown run into a stop with its message', async () => {
      const runOnce = jest
        .fn<Promise<RunConsolidationResult>, []>()
        .mockRejectedValue(new Error('queue shutting down'));
      await expect(
        drainConsolidation({ runOnce, countPending: () => Promise.resolve(3) }),
      ).resolves.toEqual({
        status: 'stopped',
        reason: 'queue shutting down',
        runs: 1,
      });
    });

    it('stops before a run once the caller withdraws permission', async () => {
      const runOnce = jest.fn<Promise<RunConsolidationResult>, []>();
      await expect(
        drainConsolidation({
          runOnce,
          countPending: () => Promise.resolve(3),
          mayContinue: () => Promise.resolve(false),
          stopReason: 'local-memory-disabled',
        }),
      ).resolves.toEqual({
        status: 'stopped',
        reason: 'local-memory-disabled',
        runs: 0,
      });
      expect(runOnce).not.toHaveBeenCalled();
    });

    it('never exceeds the run cap', async () => {
      let pending = 100;
      await expect(
        drainConsolidation({
          runOnce: () => Promise.resolve({ status: 'success' }),
          countPending: () => Promise.resolve((pending -= 1)),
          maxRuns: 3,
        }),
      ).resolves.toEqual({
        status: 'stopped',
        reason: 'too-many-runs',
        runs: 3,
      });
    });
  });
});

describe('local memory snapshots', () => {
  let scopeDir: string;

  beforeEach(async () => {
    scopeDir = await mkdtemp(join(tmpdir(), 'local-memory-snapshots-'));
  });

  afterEach(async () => {
    await rm(scopeDir, { recursive: true, force: true });
  });

  it('captures nothing for an empty scope', async () => {
    await expect(
      createLocalMemorySnapshot(scopeDir, 'consolidation'),
    ).resolves.toBeNull();
    await expect(listLocalMemorySnapshots(scopeDir)).resolves.toEqual([]);
  });

  it('keeps the newest snapshots up to the retention limit', async () => {
    await write(scopeDir, 'MEMORY.md', '# Memory\n');
    const ids: string[] = [];
    for (let index = 0; index < LOCAL_MEMORY_SNAPSHOT_RETENTION + 2; index++) {
      const summary = await createLocalMemorySnapshot(
        scopeDir,
        'consolidation',
        new Date(Date.UTC(2026, 8, 1, 0, index)),
      );
      if (summary) ids.push(summary.id);
    }
    const listed = await listLocalMemorySnapshots(scopeDir);
    expect(listed.map((snapshot) => snapshot.id)).toEqual(
      ids.slice(2).reverse(),
    );
    expect(ids.every(isLocalMemorySnapshotId)).toBe(true);
  }, 15_000);

  it('restores the index and topics, keeps the current profile, and snapshots what it replaced', async () => {
    await write(
      scopeDir,
      'MEMORY.md',
      '# Old\n\n- [Travel](topics/travel.md)\n',
    );
    await write(scopeDir, 'topics/travel.md', 'Window seat');
    await write(scopeDir, 'topics/chat-history-profile.md', 'Old profile');
    const saved = await createLocalMemorySnapshot(scopeDir, 'rebuild');
    if (!saved) throw new Error('expected a snapshot');

    await write(scopeDir, 'MEMORY.md', `${PROFILE_LINE}\n\n- New fact\n`);
    await rm(join(scopeDir, 'topics', 'travel.md'));
    await write(scopeDir, 'topics/new.md', 'New');
    await write(scopeDir, 'topics/chat-history-profile.md', 'New profile');
    const revision = memoryEditRevision(scopeDir);

    const { previousSnapshotId } = await restoreLocalMemorySnapshot(
      scopeDir,
      saved.id,
    );

    expect(await read(scopeDir, 'MEMORY.md')).toBe(
      `# Old\n\n${PROFILE_LINE}\n\n- [Travel](topics/travel.md)\n`,
    );
    expect((await readdir(join(scopeDir, 'topics'))).sort()).toEqual([
      'chat-history-profile.md',
      'travel.md',
    ]);
    expect(await read(scopeDir, 'topics/chat-history-profile.md')).toBe(
      'New profile',
    );
    expect(memoryEditRevision(scopeDir)).toBe(revision + 1);
    expect(previousSnapshotId).not.toBeNull();
    const previous = await readLocalMemorySnapshot(
      scopeDir,
      previousSnapshotId ?? '',
    );
    expect(previous.summary.reason).toBe('restore');
    expect(previous.memoryMd).toBe(`${PROFILE_LINE}\n\n- New fact\n`);
  });

  it('restores an index over the read limits exactly as it was saved', async () => {
    // Over 200 lines and over 25 KiB, with spacing and line endings that
    // reading would normalize: a rollback must give all of it back.
    const oversized = `# Memory\r\n\r\n\r\n${Array.from(
      { length: 320 },
      (_, index) => `- fact ${index}: ${'x'.repeat(100)}`,
    ).join('\n')}\n\n\n`;
    expect(oversized.split('\n').length).toBeGreaterThan(200);
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(25 * 1024);
    await write(scopeDir, 'MEMORY.md', oversized);
    await write(scopeDir, 'topics/travel.md', '  Window seat\r\n\n\n');
    const saved = await createLocalMemorySnapshot(scopeDir, 'consolidation');
    if (!saved) throw new Error('expected a snapshot');

    await write(scopeDir, 'MEMORY.md', '- Compacted\n');
    await write(scopeDir, 'topics/travel.md', 'Aisle');

    await restoreLocalMemorySnapshot(scopeDir, saved.id);

    expect(await read(scopeDir, 'MEMORY.md')).toBe(oversized);
    expect(await read(scopeDir, 'topics/travel.md')).toBe(
      '  Window seat\r\n\n\n',
    );
  });

  it('changes only the profile line when it keeps the current profile', async () => {
    const savedIndex = `# Memory\n\n\n- [Old profile](topics/chat-history-profile.md): Role: Student.\n\n\n${Array.from(
      { length: 260 },
      (_, index) => `- fact ${index}: ${'y'.repeat(100)}`,
    ).join('\n')}\n`;
    await write(scopeDir, 'MEMORY.md', savedIndex);
    await write(scopeDir, 'topics/chat-history-profile.md', 'Old profile');
    const saved = await createLocalMemorySnapshot(scopeDir, 'consolidation');
    if (!saved) throw new Error('expected a snapshot');

    await write(scopeDir, 'MEMORY.md', `${PROFILE_LINE}\n- New fact\n`);
    await write(scopeDir, 'topics/chat-history-profile.md', 'New profile');

    await restoreLocalMemorySnapshot(scopeDir, saved.id);

    expect(await read(scopeDir, 'MEMORY.md')).toBe(
      savedIndex.replace(
        '- [Old profile](topics/chat-history-profile.md): Role: Student.',
        PROFILE_LINE,
      ),
    );
    expect(await read(scopeDir, 'topics/chat-history-profile.md')).toBe(
      'New profile',
    );
  });

  it('drops the saved profile line when the kept current profile has no index line', async () => {
    const savedIndex = `# Memory\n\n- [Old profile](topics/chat-history-profile.md): Role: Student.\n- Fact\n`;
    await write(scopeDir, 'MEMORY.md', savedIndex);
    await write(scopeDir, 'topics/chat-history-profile.md', 'Old profile');
    const saved = await createLocalMemorySnapshot(scopeDir, 'consolidation');
    if (!saved) throw new Error('expected a snapshot');

    await write(scopeDir, 'MEMORY.md', '# Memory\n\n- New fact\n');
    await write(scopeDir, 'topics/chat-history-profile.md', 'New profile');

    await restoreLocalMemorySnapshot(scopeDir, saved.id);

    expect(await read(scopeDir, 'MEMORY.md')).toBe('# Memory\n\n- Fact\n');
    expect(await read(scopeDir, 'topics/chat-history-profile.md')).toBe(
      'New profile',
    );
  });

  it('writes no index when the kept profile has no line and the saved index linked only the profile', async () => {
    await write(
      scopeDir,
      'MEMORY.md',
      '- [Old profile](topics/chat-history-profile.md): Role: Student.\n',
    );
    await write(scopeDir, 'topics/chat-history-profile.md', 'Old profile');
    await write(scopeDir, 'topics/travel.md', 'Window seat');
    const saved = await createLocalMemorySnapshot(scopeDir, 'consolidation');
    if (!saved) throw new Error('expected a snapshot');

    await rm(join(scopeDir, 'MEMORY.md'));
    await write(scopeDir, 'topics/chat-history-profile.md', 'New profile');

    await restoreLocalMemorySnapshot(scopeDir, saved.id);

    expect(await pathExists(join(scopeDir, 'MEMORY.md'))).toBe(false);
    expect(await read(scopeDir, 'topics/chat-history-profile.md')).toBe(
      'New profile',
    );
    expect(await read(scopeDir, 'topics/travel.md')).toBe('Window seat');
  });

  it('restores the saved profile and its index line when there is no current profile', async () => {
    const savedIndex = `- [Old profile](topics/chat-history-profile.md): Role: Student.\n\n\n- Fact\n`;
    await write(scopeDir, 'MEMORY.md', savedIndex);
    await write(scopeDir, 'topics/chat-history-profile.md', 'Old profile');
    const saved = await createLocalMemorySnapshot(scopeDir, 'consolidation');
    if (!saved) throw new Error('expected a snapshot');

    await write(scopeDir, 'MEMORY.md', `${PROFILE_LINE}\n- New fact\n`);
    await rm(join(scopeDir, 'topics', 'chat-history-profile.md'));

    await restoreLocalMemorySnapshot(scopeDir, saved.id);

    expect(await read(scopeDir, 'MEMORY.md')).toBe(savedIndex);
    expect(await read(scopeDir, 'topics/chat-history-profile.md')).toBe(
      'Old profile',
    );
  });

  it('keeps a restored topic whose name differs only in case from the current file', async () => {
    await write(scopeDir, 'MEMORY.md', '- [Travel](topics/travel.md)\n');
    await write(scopeDir, 'topics/travel.md', 'Window seat');
    const saved = await createLocalMemorySnapshot(scopeDir, 'consolidation');
    if (!saved) throw new Error('expected a snapshot');
    await rm(join(scopeDir, 'topics', 'travel.md'));
    await write(scopeDir, 'topics/Travel.md', 'Aisle');

    await restoreLocalMemorySnapshot(scopeDir, saved.id);

    // On macOS and Windows the restore writes into Travel.md, which keeps
    // its spelling; on a case-sensitive filesystem Travel.md is a different
    // file and goes. Either way exactly one travel topic holds the snapshot.
    const topics = await readdir(join(scopeDir, 'topics'));
    expect(topics.map((name) => name.toLowerCase())).toEqual(['travel.md']);
    expect(await read(scopeDir, `topics/${topics[0]}`)).toBe('Window seat');
  });

  it('keeps the current profile topic whatever its case', async () => {
    await write(scopeDir, 'topics/travel.md', 'Window seat');
    const saved = await createLocalMemorySnapshot(scopeDir, 'consolidation');
    if (!saved) throw new Error('expected a snapshot');
    await write(scopeDir, 'topics/Chat-History-Profile.md', 'New profile');

    await restoreLocalMemorySnapshot(scopeDir, saved.id);

    expect((await readdir(join(scopeDir, 'topics'))).sort()).toEqual([
      'Chat-History-Profile.md',
      'travel.md',
    ]);
  });

  it('counts only readable snapshots toward retention and keeps the last rebuild and restore', async () => {
    await write(scopeDir, 'MEMORY.md', '# Memory\n');
    const at = (minute: number): Date =>
      new Date(Date.UTC(2026, 8, 1, 0, minute));
    const rebuild = await createLocalMemorySnapshot(scopeDir, 'rebuild', at(0));
    const restore = await createLocalMemorySnapshot(scopeDir, 'restore', at(1));
    // Damaged folders newer than everything else: they must not push the
    // readable snapshots out, and they are left in place.
    const damaged = [
      '2026-09-02T00-00-00-000Z-0000000a',
      '2026-09-02T00-00-00-000Z-0000000b',
    ];
    for (const id of damaged) {
      await mkdir(join(scopeDir, '.snapshots', id), { recursive: true });
    }
    const routine: string[] = [];
    for (let index = 0; index < LOCAL_MEMORY_SNAPSHOT_RETENTION + 3; index++) {
      const summary = await createLocalMemorySnapshot(
        scopeDir,
        'consolidation',
        at(10 + index),
      );
      if (summary) routine.push(summary.id);
    }

    const listed = (await listLocalMemorySnapshots(scopeDir)).map(
      (snapshot) => snapshot.id,
    );
    expect(listed).toEqual([
      ...routine.slice(3).reverse(),
      restore?.id,
      rebuild?.id,
    ]);
    for (const id of damaged) {
      expect(await pathExists(join(scopeDir, '.snapshots', id))).toBe(true);
    }
  }, 15_000);

  it('neither counts nor lists a snapshot missing a file its manifest names', async () => {
    await write(scopeDir, 'MEMORY.md', '# Memory\n');
    await write(scopeDir, 'topics/travel.md', 'Window seat');
    const at = (minute: number): Date =>
      new Date(Date.UTC(2026, 8, 1, 0, minute));
    const ids: string[] = [];
    for (let index = 0; index < LOCAL_MEMORY_SNAPSHOT_RETENTION; index++) {
      const summary = await createLocalMemorySnapshot(
        scopeDir,
        'consolidation',
        at(index),
      );
      if (summary) ids.push(summary.id);
    }
    // The three newest keep a valid manifest but lose a file it names.
    const damaged = ids.slice(-3);
    await rm(join(scopeDir, '.snapshots', damaged[0], 'topics', 'travel.md'));
    await rm(join(scopeDir, '.snapshots', damaged[1], 'MEMORY.md'));
    await rm(join(scopeDir, '.snapshots', damaged[2], 'topics'), {
      recursive: true,
    });

    const latest = await createLocalMemorySnapshot(
      scopeDir,
      'consolidation',
      at(30),
    );

    const listed = (await listLocalMemorySnapshots(scopeDir)).map(
      (snapshot) => snapshot.id,
    );
    // Only the readable ones count, so the oldest readable one is kept.
    expect(listed).toEqual([latest?.id, ...ids.slice(0, -3).reverse()]);
    for (const id of damaged) {
      expect(
        await pathExists(join(scopeDir, '.snapshots', id, 'snapshot.json')),
      ).toBe(true);
    }
  }, 15_000);

  it('verifies a snapshot against the scope byte for byte', async () => {
    await write(scopeDir, 'MEMORY.md', '# Memory\n');
    await write(scopeDir, 'topics/travel.md', 'Window seat');
    const saved = await createLocalMemorySnapshot(scopeDir, 'rebuild');
    if (!saved) throw new Error('expected a snapshot');
    expect(await localMemorySnapshotMatchesScope(scopeDir, saved.id)).toBe(
      true,
    );

    await write(scopeDir, 'topics/travel.md', 'Aisle');
    expect(await localMemorySnapshotMatchesScope(scopeDir, saved.id)).toBe(
      false,
    );
    await write(scopeDir, 'topics/travel.md', 'Window seat');
    await write(scopeDir, 'topics/food.md', 'Noodles');
    expect(await localMemorySnapshotMatchesScope(scopeDir, saved.id)).toBe(
      false,
    );
    await rm(join(scopeDir, 'topics', 'food.md'));
    await rm(join(scopeDir, '.snapshots', saved.id, 'topics', 'travel.md'));
    expect(await localMemorySnapshotMatchesScope(scopeDir, saved.id)).toBe(
      false,
    );
  });

  it('keeps a new snapshot even when the clock stepped back', async () => {
    await write(scopeDir, 'MEMORY.md', '# Memory\n');
    for (let index = 0; index < LOCAL_MEMORY_SNAPSHOT_RETENTION; index++) {
      await createLocalMemorySnapshot(
        scopeDir,
        'consolidation',
        new Date(Date.UTC(2026, 8, 2, 0, index)),
      );
    }
    const late = await createLocalMemorySnapshot(
      scopeDir,
      'consolidation',
      new Date(Date.UTC(2026, 8, 1)),
    );

    const listed = await listLocalMemorySnapshots(scopeDir);
    expect(listed.map((snapshot) => snapshot.id)).toContain(late?.id);
  }, 15_000);

  it('overwrites nothing when the snapshot of the replaced state does not read back the same', async () => {
    await write(scopeDir, 'MEMORY.md', '# Old\n');
    await write(scopeDir, 'topics/travel.md', 'Window seat');
    const target = await createLocalMemorySnapshot(scopeDir, 'consolidation');
    if (!target) throw new Error('expected a snapshot');
    await write(scopeDir, 'topics/travel.md', 'Aisle');
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const realWriteFile = fsPromises.writeFile;
    // Snapshot files are staged under `.<id>.tmp`: corrupt the copy there.
    const spy = jest
      .spyOn(fsPromises, 'writeFile')
      .mockImplementation((file, data, options) =>
        realWriteFile(
          file,
          typeof file === 'string' &&
            file.includes('.tmp') &&
            file.endsWith('travel.md')
            ? 'Corrupted'
            : data,
          options,
        ),
      );
    try {
      await expect(
        restoreLocalMemorySnapshot(scopeDir, target.id),
      ).rejects.toThrow(
        "Couldn't save a snapshot of current memories, so nothing was changed.",
      );
    } finally {
      spy.mockRestore();
    }
    expect(await read(scopeDir, 'topics/travel.md')).toBe('Aisle');
    expect(await read(scopeDir, 'MEMORY.md')).toBe('# Old\n');
  });

  it('overwrites nothing when content appears in an empty scope during the restore', async () => {
    await write(scopeDir, 'MEMORY.md', '# Saved\n');
    await write(scopeDir, 'topics/travel.md', 'Window seat');
    const target = await createLocalMemorySnapshot(scopeDir, 'consolidation');
    if (!target) throw new Error('expected a snapshot');
    await rm(join(scopeDir, 'MEMORY.md'));
    await rm(join(scopeDir, 'topics'), { recursive: true });
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const realReadFile = fsPromises.readFile;
    const indexPath = join(scopeDir, 'MEMORY.md');
    let indexReads = 0;
    // The restore reads the empty scope, then an index is written outside
    // the app before the snapshot is applied.
    const spy = jest
      .spyOn(fsPromises, 'readFile')
      .mockImplementation(async (...args: Parameters<typeof realReadFile>) => {
        try {
          return await realReadFile(...args);
        } finally {
          if (args[0] === indexPath && (indexReads += 1) === 1) {
            await fsPromises.writeFile(indexPath, '# Written meanwhile\n');
          }
        }
      });
    try {
      await expect(
        restoreLocalMemorySnapshot(scopeDir, target.id),
      ).rejects.toThrow(LOCAL_MEMORY_RESTORE_SCOPE_CHANGED_MESSAGE);
    } finally {
      spy.mockRestore();
    }
    expect(await read(scopeDir, 'MEMORY.md')).toBe('# Written meanwhile\n');
    expect(await pathExists(join(scopeDir, 'topics', 'travel.md'))).toBe(false);
  });

  describe('runVerifiedLocalMemoryWrite', () => {
    const empty: LocalMemoryState = { memoryMd: null, topicFiles: [] };

    it('refuses an empty expected state once a topic exists', async () => {
      await write(scopeDir, 'topics/new.md', 'New');
      const destroy = jest.fn((): Promise<void> => Promise.resolve());

      await expect(
        runVerifiedLocalMemoryWrite(scopeDir, [empty], destroy),
      ).rejects.toBeInstanceOf(LocalMemoryScopeChangedError);
      expect(destroy).not.toHaveBeenCalled();
    });

    it('runs the write while the scope is exactly the expected state', async () => {
      await write(scopeDir, 'MEMORY.md', '# Index\n');
      await write(scopeDir, 'topics/a.md', 'A');

      await expect(
        runVerifiedLocalMemoryWrite(
          scopeDir,
          [
            {
              memoryMd: '# Index\n',
              topicFiles: [{ filename: 'a.md', content: 'A' }],
            },
          ],
          () => Promise.resolve('written'),
        ),
      ).resolves.toBe('written');
    });

    it('renames nothing when a target is edited after it was staged, and deletes the staged file', async () => {
      await write(scopeDir, 'MEMORY.md', '# Index\n');
      const expected = await readLocalMemoryState(scopeDir);

      await expect(
        runVerifiedLocalMemoryWrite(scopeDir, [expected], async (guard) => {
          const staged = await guard.stage(
            join(scopeDir, 'MEMORY.md'),
            '# Replaced\n',
          );
          await write(scopeDir, 'MEMORY.md', '# Edited meanwhile\n');
          await guard.replace(staged);
        }),
      ).rejects.toEqual(new LocalMemoryScopeChangedError(false));

      expect(await read(scopeDir, 'MEMORY.md')).toBe('# Edited meanwhile\n');
      expect(await stagedLeftovers(scopeDir)).toEqual([]);
    });

    it('checks each target before it is replaced and stops every later change', async () => {
      await write(scopeDir, 'topics/a.md', 'A1');
      await write(scopeDir, 'topics/b.md', 'B1');
      await write(scopeDir, 'topics/c.md', 'C1');
      const expected = await readLocalMemoryState(scopeDir);
      const removeC = jest.fn();

      await expect(
        runVerifiedLocalMemoryWrite(scopeDir, [expected], async (guard) => {
          const a = await guard.stage(join(scopeDir, 'topics', 'a.md'), 'A2');
          const b = await guard.stage(join(scopeDir, 'topics', 'b.md'), 'B2');
          await guard.replace(a);
          await write(scopeDir, 'topics/b.md', 'B edited meanwhile');
          try {
            await guard.replace(b);
          } finally {
            await guard
              .remove(join(scopeDir, 'topics', 'c.md'))
              .then(removeC, () => undefined);
          }
        }),
      ).rejects.toEqual(new LocalMemoryScopeChangedError(true));

      expect(await read(scopeDir, 'topics/a.md')).toBe('A2');
      expect(await read(scopeDir, 'topics/b.md')).toBe('B edited meanwhile');
      expect(await read(scopeDir, 'topics/c.md')).toBe('C1');
      expect(removeC).not.toHaveBeenCalled();
      expect(await stagedLeftovers(scopeDir)).toEqual([]);
    });

    it('accepts a mix of the before and after states, and nothing else', async () => {
      const before: LocalMemoryState = {
        memoryMd: '# Before\n',
        topicFiles: [
          { filename: 'a.md', content: 'A1' },
          { filename: 'b.md', content: 'B1' },
        ],
      };
      const after: LocalMemoryState = {
        memoryMd: '# After\n',
        topicFiles: [{ filename: 'a.md', content: 'A2' }],
      };
      // Part way: a.md rewritten, b.md not yet deleted, index unchanged.
      await write(scopeDir, 'MEMORY.md', '# Before\n');
      await write(scopeDir, 'topics/a.md', 'A2');
      await write(scopeDir, 'topics/b.md', 'B1');
      await expect(
        runVerifiedLocalMemoryWrite(scopeDir, [before, after], () =>
          Promise.resolve(true),
        ),
      ).resolves.toBe(true);

      await write(scopeDir, 'topics/b.md', 'Edited outside');
      await expect(
        runVerifiedLocalMemoryWrite(scopeDir, [before, after], () =>
          Promise.resolve(true),
        ),
      ).rejects.toBeInstanceOf(LocalMemoryScopeChangedError);
    });
  });

  it('rejects a snapshot id that could leave the snapshots folder', async () => {
    await expect(
      restoreLocalMemorySnapshot(scopeDir, '../../MEMORY'),
    ).rejects.toThrow('Choose a memory snapshot.');
  });
});
