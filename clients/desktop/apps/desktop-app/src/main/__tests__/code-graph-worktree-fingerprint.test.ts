import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getGitExecutableCommand } from '@canopy/desktop-shared/lib/git-executable';
import { runCodeGraphMigrations } from '@canopy/code-graph/store/migrations';
import {
  CODE_GRAPH_MAX_FILE_BYTES,
  CODE_GRAPH_SCHEMA_VERSION,
} from '@canopy/desktop-shared/types/code-graph';
import { executeCodeGraphFingerprint } from '../code-graph/fingerprint-worker';
import {
  readCodeGraphFingerprintMetadata,
  setMetadataValue,
  type CodeGraphFingerprintMetadata,
} from '@canopy/code-graph/store/database';
import { fingerprintCodeGraphWorktree } from '../lib/code-graph-worktree-fingerprint-core';
import {
  persistCodeGraphWorktreeFingerprint,
  persistStableCodeGraphWorktreeFingerprint,
  readCodeGraphBuildStampUncached,
  readCodeGraphWorktreeCompletion,
  readPersistedCodeGraphWorktreeFingerprint,
  readPersistedCodeGraphWorktreeFingerprintSnapshot,
  setCodeGraphFingerprintMetadataReaderForTests,
  setCodeGraphFingerprintMetadataWriterForTests,
} from '../lib/code-graph-worktree-fingerprint';

function git(root: string, args: string[]): void {
  execFileSync(getGitExecutableCommand(process.env), ['-C', root, ...args], {
    stdio: 'ignore',
  });
}

function createRepository(root: string, fileName: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ['init']);
  git(root, ['config', 'user.email', 'fingerprint@example.com']);
  git(root, ['config', 'user.name', 'Fingerprint Test']);
  writeFileSync(path.join(root, fileName), 'initial\n');
  git(root, ['add', fileName]);
  git(root, ['commit', '-m', 'initial']);
}

/**
 * The shared `${projectId}/${worktreeId}` read key. Worktree cleanup cancels
 * in-flight code-graph reads by exactly this key before removing
 * `worktree-data/{worktreeId}`.
 */
const KEY = 'project-a/worktree-b';

describe('code graph worktree fingerprint', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-worktree-fp-'));
    // Stand in for the read worker: same disk read, same process. Tests that
    // care about the worker contract override this.
    setCodeGraphFingerprintMetadataReaderForTests((dbPath) => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return Promise.resolve(readCodeGraphFingerprintMetadata(db));
      } finally {
        db.close();
      }
    });
    setCodeGraphFingerprintMetadataWriterForTests((dbPath, fingerprint) => {
      const db = new DatabaseSync(dbPath);
      try {
        setMetadataValue(db, 'worktree_fingerprint', fingerprint);
      } finally {
        db.close();
      }
      return Promise.resolve();
    });
  });

  afterEach(() => {
    setCodeGraphFingerprintMetadataReaderForTests(null);
    setCodeGraphFingerprintMetadataWriterForTests(null);
    rmSync(root, { recursive: true, force: true });
  });

  it('is repository-order independent and includes untracked changes', async () => {
    const repoA = path.join(root, 'a');
    const repoB = path.join(root, 'b');
    createRepository(repoA, 'a.txt');
    createRepository(repoB, 'b.txt');
    const aFirst = await fingerprintCodeGraphWorktree([
      { repoId: 'a', rootPath: repoA },
      { repoId: 'b', rootPath: repoB },
    ]);
    const bFirst = await fingerprintCodeGraphWorktree([
      { repoId: 'b', rootPath: repoB },
      { repoId: 'a', rootPath: repoA },
    ]);
    expect(bFirst).toBe(aFirst);

    writeFileSync(path.join(repoA, 'untracked.txt'), 'new\n');
    expect(
      await fingerprintCodeGraphWorktree([
        { repoId: 'a', rootPath: repoA },
        { repoId: 'b', rootPath: repoB },
      ]),
    ).not.toBe(aFirst);
  });

  it('changes when the bytes of an already-dirty tracked or untracked file change again', async () => {
    const repo = path.join(root, 'repo');
    createRepository(repo, 'tracked.ts');
    const repositories = [{ repoId: 'repo', rootPath: repo }];
    const fixedTime = new Date('2026-01-01T00:00:00.000Z');
    const trackedPath = path.join(repo, 'tracked.ts');
    const untrackedPath = path.join(repo, 'untracked.ts');

    writeFileSync(trackedPath, 'tracked edit one\n');
    utimesSync(trackedPath, fixedTime, fixedTime);
    const firstTracked = await fingerprintCodeGraphWorktree(repositories);
    writeFileSync(trackedPath, 'tracked edit two\n');
    utimesSync(trackedPath, fixedTime, fixedTime);
    expect(await fingerprintCodeGraphWorktree(repositories)).not.toBe(
      firstTracked,
    );

    writeFileSync(untrackedPath, 'untracked edit one\n');
    utimesSync(untrackedPath, fixedTime, fixedTime);
    const firstUntracked = await fingerprintCodeGraphWorktree(repositories);
    writeFileSync(untrackedPath, 'untracked edit two\n');
    utimesSync(untrackedPath, fixedTime, fixedTime);
    expect(await fingerprintCodeGraphWorktree(repositories)).not.toBe(
      firstUntracked,
    );
  });

  it('preserves the canonical digest across the worker boundary for deleted, symlink, oversized, and Git-error inputs', async () => {
    const repo = path.join(root, 'repo');
    const nonRepo = path.join(root, 'not-a-repository');
    createRepository(repo, 'tracked.ts');
    mkdirSync(nonRepo, { recursive: true });
    writeFileSync(path.join(repo, 'deleted.ts'), 'delete me\n');
    git(repo, ['add', 'deleted.ts']);
    git(repo, ['commit', '-m', 'add deletion fixture']);

    writeFileSync(path.join(repo, 'tracked.ts'), 'modified\n');
    rmSync(path.join(repo, 'deleted.ts'));
    writeFileSync(path.join(repo, 'untracked.ts'), 'untracked\n');
    symlinkSync('untracked.ts', path.join(repo, 'untracked-link.ts'));
    writeFileSync(
      path.join(repo, 'oversized.ts'),
      Buffer.alloc(CODE_GRAPH_MAX_FILE_BYTES + 1, 0x61),
    );

    const repositories = [
      { repoId: 'repo', rootPath: repo },
      { repoId: 'git-error', rootPath: nonRepo },
    ];
    const direct = await fingerprintCodeGraphWorktree(repositories);
    await expect(
      executeCodeGraphFingerprint({ repositories }),
    ).resolves.toEqual({ ok: true, fingerprint: direct });
  });

  it('round-trips the persisted end-of-build fingerprint', async () => {
    const dbPath = path.join(root, 'graph.db');
    const db = new DatabaseSync(dbPath);
    runCodeGraphMigrations(db);
    db.close();

    const initialRead = await readPersistedCodeGraphWorktreeFingerprintSnapshot(
      dbPath,
      KEY,
    );
    expect(initialRead).toMatchObject({
      fingerprint: null,
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      extractorVersion: null,
      cacheHit: false,
    });
    expect(
      await readPersistedCodeGraphWorktreeFingerprintSnapshot(dbPath, KEY),
    ).toMatchObject({ fingerprint: null, cacheHit: true });
    await persistCodeGraphWorktreeFingerprint(dbPath, 'fingerprint-value', KEY);
    expect(
      await readPersistedCodeGraphWorktreeFingerprintSnapshot(dbPath, KEY),
    ).toMatchObject({
      fingerprint: 'fingerprint-value',
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      extractorVersion: null,
      cacheHit: false,
    });
  });

  it('only persists a fingerprint for a stable build window', async () => {
    const dbPath = path.join(root, 'stable-graph.db');
    const db = new DatabaseSync(dbPath);
    runCodeGraphMigrations(db);
    db.close();

    await persistCodeGraphWorktreeFingerprint(dbPath, 'previous', KEY);
    await expect(
      persistStableCodeGraphWorktreeFingerprint(dbPath, 'start', 'end', KEY),
    ).resolves.toBe(false);
    await expect(
      readPersistedCodeGraphWorktreeFingerprint(dbPath, KEY),
    ).resolves.toBe('previous');

    await expect(
      persistStableCodeGraphWorktreeFingerprint(
        dbPath,
        'stable',
        'stable',
        KEY,
      ),
    ).resolves.toBe(true);
    await expect(
      readPersistedCodeGraphWorktreeFingerprint(dbPath, KEY),
    ).resolves.toBe('stable');
  });

  // Stack samples taken during real beachballs showed
  // `node:sqlite StatementSync::Get` at up to 49.7% of Electron main-thread
  // samples, reading a >500 MB graph database opened by this module. The read
  // must never open the database on the calling thread again.
  it('reads metadata through the worker without opening the database inline', async () => {
    const dbPath = path.join(root, 'offthread-graph.db');
    const db = new DatabaseSync(dbPath);
    runCodeGraphMigrations(db);
    db.close();

    const reader = jest.fn((): Promise<CodeGraphFingerprintMetadata> => {
      return Promise.resolve({
        fingerprint: 'from-worker',
        schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
        extractorVersion: 7,
        completed: true,
      });
    });
    setCodeGraphFingerprintMetadataReaderForTests(reader);

    const first = await readPersistedCodeGraphWorktreeFingerprintSnapshot(
      dbPath,
      KEY,
    );
    expect(first).toMatchObject({
      fingerprint: 'from-worker',
      extractorVersion: 7,
      cacheHit: false,
      readFailed: false,
    });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(dbPath, KEY);

    // An unchanged database must be answered from the stat-keyed cache, so a
    // steady-state scheduler tick costs one stat() and no worker round trip.
    const second = await readPersistedCodeGraphWorktreeFingerprintSnapshot(
      dbPath,
      KEY,
    );
    expect(second).toMatchObject({
      fingerprint: 'from-worker',
      cacheHit: true,
    });
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('reads the build stamp through the worker on every call, bypassing the stat cache', async () => {
    const dbPath = path.join(root, 'stamp-graph.db');
    const db = new DatabaseSync(dbPath);
    runCodeGraphMigrations(db);
    db.close();
    let stamp = '100';
    const reader = jest.fn(
      (): Promise<CodeGraphFingerprintMetadata> =>
        Promise.resolve({
          fingerprint: null,
          schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
          extractorVersion: 7,
          completed: true,
          lastBuildAt: stamp,
        }),
    );
    setCodeGraphFingerprintMetadataReaderForTests(reader);
    await readPersistedCodeGraphWorktreeFingerprintSnapshot(dbPath, KEY);

    // A WAL-only publication leaves graph.db's stat unchanged.
    stamp = '101';
    await expect(readCodeGraphBuildStampUncached(dbPath, KEY)).resolves.toBe(
      '101',
    );
    expect(reader).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenLastCalledWith(dbPath, KEY);
  });

  it('reports an unreadable build stamp as null', async () => {
    setCodeGraphFingerprintMetadataReaderForTests(() =>
      Promise.reject(new Error('SQLITE_BUSY')),
    );

    await expect(
      readCodeGraphBuildStampUncached(path.join(root, 'busy.db'), KEY),
    ).resolves.toBeNull();
  });

  // The end-of-build write previously opened `graph.db` read-write on the
  // Electron main thread after every build. It must stay in the worker lane.
  it('writes the stable fingerprint through the worker without opening the database inline', async () => {
    const dbPath = path.join(root, 'offthread-write-graph.db');
    const db = new DatabaseSync(dbPath);
    runCodeGraphMigrations(db);
    db.close();
    const writer = jest.fn<Promise<void>, [string, string, string]>(() =>
      Promise.resolve(),
    );
    setCodeGraphFingerprintMetadataWriterForTests(writer);

    await expect(
      persistStableCodeGraphWorktreeFingerprint(dbPath, 'same', 'same', KEY),
    ).resolves.toBe(true);
    await expect(
      persistStableCodeGraphWorktreeFingerprint(dbPath, 'before', 'after', KEY),
    ).resolves.toBe(false);

    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith(dbPath, 'same', KEY);
  });

  it('reports completion from the worker-read metadata', async () => {
    const dbPath = path.join(root, 'completion-graph.db');
    const db = new DatabaseSync(dbPath);
    runCodeGraphMigrations(db);
    db.close();
    await expect(readCodeGraphWorktreeCompletion(dbPath, KEY)).resolves.toBe(
      false,
    );

    const completed = new DatabaseSync(dbPath);
    setMetadataValue(completed, 'completed_build_at', '1');
    completed.close();
    // The metadata cache is keyed on mtime/size; make the change observable.
    const later = new Date(Date.now() + 5_000);
    utimesSync(dbPath, later, later);
    await expect(readCodeGraphWorktreeCompletion(dbPath, KEY)).resolves.toBe(
      true,
    );
    await expect(
      readCodeGraphWorktreeCompletion(path.join(root, 'missing.db'), KEY),
    ).resolves.toBe(false);
  });

  it('does not cache a failed metadata read', async () => {
    const dbPath = path.join(root, 'busy-graph.db');
    const db = new DatabaseSync(dbPath);
    runCodeGraphMigrations(db);
    db.close();

    // SQLITE_BUSY while the build worker holds the database. A transient
    // failure must stay retryable rather than becoming a durable
    // "no fingerprint" answer.
    const reader = jest
      .fn<Promise<CodeGraphFingerprintMetadata>, [string]>()
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockResolvedValueOnce({
        fingerprint: 'recovered',
        schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
        extractorVersion: null,
        completed: false,
      });
    setCodeGraphFingerprintMetadataReaderForTests(reader);

    expect(
      await readPersistedCodeGraphWorktreeFingerprintSnapshot(dbPath, KEY),
    ).toMatchObject({ fingerprint: null, readFailed: true, cacheHit: false });

    expect(
      await readPersistedCodeGraphWorktreeFingerprintSnapshot(dbPath, KEY),
    ).toMatchObject({ fingerprint: 'recovered', readFailed: false });
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('reports an absent graph database without consulting the worker', async () => {
    const reader = jest.fn<Promise<CodeGraphFingerprintMetadata>, [string]>();
    setCodeGraphFingerprintMetadataReaderForTests(reader);

    expect(
      await readPersistedCodeGraphWorktreeFingerprintSnapshot(
        path.join(root, 'missing.db'),
        KEY,
      ),
    ).toMatchObject({
      fingerprint: null,
      schemaVersion: null,
      readFailed: false,
    });
    expect(reader).not.toHaveBeenCalled();
  });

  // A `stat` failure that is not ENOENT (EACCES/EIO/ELOOP) is environmental,
  // not "this worktree has no graph". Caching it would make the scheduler
  // treat a temporarily unreadable graph as permanently absent.
  it('keeps a non-ENOENT stat failure retryable instead of caching it as absent', async () => {
    const reader = jest.fn<Promise<CodeGraphFingerprintMetadata>, [string]>();
    setCodeGraphFingerprintMetadataReaderForTests(reader);
    // A path whose parent is a file, not a directory, yields ENOTDIR.
    const blockingFile = path.join(root, 'not-a-directory');
    writeFileSync(blockingFile, 'x');

    expect(
      await readPersistedCodeGraphWorktreeFingerprintSnapshot(
        path.join(blockingFile, 'graph.db'),
        KEY,
      ),
    ).toMatchObject({
      fingerprint: null,
      readFailed: true,
      cacheHit: false,
    });
    expect(reader).not.toHaveBeenCalled();
  });
});
