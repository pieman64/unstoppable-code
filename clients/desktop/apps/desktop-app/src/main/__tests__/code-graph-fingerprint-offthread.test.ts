/**
 * Regression guard: no synchronous SQLite on the Electron main thread.
 *
 * Stack samples captured during real desktop beachballs showed
 * `node:sqlite StatementSync::Get` accounting for up to 49.7% of Electron
 * main-thread samples, with 30.6% in `pread`, from the code-graph scheduler
 * opening a >500 MB `graph.db` inline to read three metadata rows.
 *
 * This asserts the invariant that broke: reading the persisted worktree
 * fingerprint must not construct a `DatabaseSync` on the calling thread. It is
 * written against the public API only, so it fails against the pre-fix
 * implementation for the intended reason rather than on a missing export.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type * as nodeSqlite from 'node:sqlite';
import { DatabaseSync as RealDatabaseSync } from 'node:sqlite';
import { runCodeGraphMigrations } from '@canopy/desktop-shared/node/code-graph/store/migrations';

type NodeSqliteModule = typeof nodeSqlite;

const databaseSyncConstructions: string[] = [];

jest.mock('node:sqlite', () => {
  const actual = jest.requireActual<NodeSqliteModule>('node:sqlite');
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      public constructor(
        ...args: ConstructorParameters<typeof actual.DatabaseSync>
      ) {
        databaseSyncConstructions.push(String(args[0]));
        super(...args);
      }
    },
  };
});

/** The shared `${projectId}/${worktreeId}` read key. */
const CANCELLATION_KEY = 'project-a/worktree-b';

const workerReads: Record<string, unknown>[] = [];
jest.mock('../code-graph/read-runner', () => ({
  runCodeGraphWorkerRead: (
    input: Record<string, unknown>,
  ): Promise<unknown> => {
    workerReads.push(input);
    return Promise.resolve({
      ok: true,
      result: {
        kind: 'fingerprint-metadata',
        value: {
          fingerprint: 'off-thread',
          schemaVersion: 1,
          extractorVersion: 1,
        },
      },
    });
  },
}));

import { readPersistedCodeGraphWorktreeFingerprintSnapshot } from '../lib/code-graph-worktree-fingerprint';

describe('code-graph fingerprint metadata reads', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-fp-offthread-'));
    databaseSyncConstructions.length = 0;
    workerReads.length = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('never opens the graph database on the calling thread', async () => {
    const dbPath = path.join(root, 'graph.db');
    const seed = new RealDatabaseSync(dbPath);
    runCodeGraphMigrations(seed);
    seed.close();
    // Only the seeding above may open the database directly.
    databaseSyncConstructions.length = 0;

    const snapshot = await readPersistedCodeGraphWorktreeFingerprintSnapshot(
      dbPath,
      CANCELLATION_KEY,
    );

    expect(snapshot.readFailed).toBe(false);
    expect(databaseSyncConstructions).toEqual([]);
    expect(workerReads).toHaveLength(1);
  });

  // Worktree cleanup drains in-flight reads with
  // `cancelCodeGraphReads(`${projectId}/${worktreeId}`)` before it closes the
  // engine and recursively removes `worktree-data/{worktreeId}`. A read queued
  // under any other key is invisible to that cancel, so the worker can still
  // hold graph.db open across the removal.
  it('queues the read under the shared worktree cancellation key', async () => {
    const dbPath = path.join(root, 'graph.db');
    const seed = new RealDatabaseSync(dbPath);
    runCodeGraphMigrations(seed);
    seed.close();

    await readPersistedCodeGraphWorktreeFingerprintSnapshot(
      dbPath,
      CANCELLATION_KEY,
    );

    expect(workerReads).toHaveLength(1);
    expect(workerReads[0]).toMatchObject({ key: CANCELLATION_KEY });
  });
});
