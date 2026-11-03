import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { W5CaptureFile } from '../capture-contract';

import {
  W5CommitLog,
  W5_COMMIT_LOG_SCHEMA_VERSION,
  fingerprintW5File,
} from '..';
import { openW5CommitLogDatabase } from '../database';
import {
  schemaV2Capture,
  schemaV2Chains,
  type ChainValues,
} from './fixtures/schema-v2-capture-oracle';

// CAN-5563: schema 3 keeps each path's chain evidence in a summary its
// triggers maintain. It must equal schema 2's whole-history window query for
// every path, after every write and after upgrading an existing log.

function fingerprint(contents: string): string {
  const value = fingerprintW5File(contents);
  if (value === null) throw new Error('Expected a fingerprint');
  return value;
}

const A = fingerprint('a');
const B = fingerprint('b');
const C = fingerprint('c');
const FINGERPRINTS: readonly (string | null)[] = [
  A,
  B,
  C,
  null,
  'X',
  A.toUpperCase(),
  A.slice(1),
  `${A}0`,
  // 64 bytes but not 64 characters, and 64 characters with a NUL.
  'é'.repeat(32),
  `${A.slice(0, 63)}\0`,
  `${A.slice(0, 32)}${'é'.repeat(16)}`,
];

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'w5-chain-summary-'));
  dbPath = join(dir, 'commit-log.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withRaw<T>(run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function summaries(db: DatabaseSync): Map<string, ChainValues> {
  const chains = new Map<string, ChainValues>();
  for (const row of db
    .prepare('SELECT * FROM w5_file_chains ORDER BY path')
    .all())
    chains.set(String(row.path), {
      decisions: Number(row.decisions),
      startsAbsent: Number(row.starts_absent) === 1,
      discontinuities: Number(row.discontinuities),
    });
  return chains;
}

function retained(db: DatabaseSync): { kept: number; counted: number } {
  return {
    kept: Number(
      db.prepare('SELECT retained FROM w5_commit_totals').get()?.retained,
    ),
    counted: Number(
      db.prepare('SELECT COUNT(*) AS n FROM w5_commits').get()?.n,
    ),
  };
}

function expectSummariesExact(db: DatabaseSync): void {
  expect(summaries(db)).toEqual(schemaV2Chains(db));
  const { kept, counted } = retained(db);
  expect(kept).toBe(counted);
}

/** An empty log with the real schema 2 tables, as a schema 2 build left it. */
function createV2Log(fill: (db: DatabaseSync) => void): void {
  withRaw((db) => {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(
      readFileSync(join(__dirname, 'fixtures/schema-v2-base.sql'), 'utf8'),
    );
    db.exec(`DELETE FROM w5_receipts; DELETE FROM w5_reservations;
      DELETE FROM w5_commit_files; DELETE FROM w5_commits;
      DELETE FROM w5_revisions; DELETE FROM sqlite_sequence;`);
    db.exec('BEGIN');
    fill(db);
    db.exec('COMMIT');
  });
}

/** A deterministic PRNG, so a failure replays. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function captureFiles(
  paths: readonly string[],
): { file: W5CaptureFile; path: string }[] {
  return paths.map((path, index) => ({
    file: { kind: 'manifest', workspaceId: `w${String(index)}` },
    path,
  }));
}

/**
 * Capture as this build does, compared with schema 2's queries on the same
 * rows; false when both refuse a malformed evidence row instead.
 */
function expectCaptureMatchesSchemaV2(
  paths: readonly string[],
  expected = withRaw((db) => schemaV2Capture(db, captureFiles(paths))),
): boolean {
  const files = captureFiles(paths);
  const log = W5CommitLog.open(dbPath);
  try {
    if (expected.files === 'malformed') {
      expect(() => log.captureEvidence(files)).toThrow(
        'Unexpected fingerprint.',
      );
      return false;
    }
    expect(log.captureEvidence(files)).toMatchObject({
      retainedCommits: expected.retainedCommits,
      unresolvedCommits: expected.unresolvedCommits,
      files: expected.files,
      chains: expected.chains,
    });
    return true;
  } finally {
    log.close();
  }
}

it('matches schema 2 after every insert, delete and rewrite, anywhere in a path', () => {
  let db = openW5CommitLogDatabase(dbPath);
  try {
    // Keep the per-write oracle checks, without an fsync for every probe.
    db.exec('BEGIN');
    const next = random(5563);
    const pick = <T>(values: readonly T[]): T =>
      values[Math.floor(next() * values.length)];
    const paths = ['/p/one', '/p/two', '/p/three'];
    // Mostly linkable values, so continuous links are common too.
    const fingerprint = (): string | null =>
      next() < 0.9 ? pick([A, B, null]) : pick(FINGERPRINTS);
    // Mostly applied, so many captures have well-formed evidence to compare.
    const state = (): string =>
      next() < 0.9 ? 'applied' : pick(['committed', 'recovery-required']);
    const addCommit = (commitState: string): void => {
      db.prepare(
        `INSERT INTO w5_commits (operation, outcome_json, state, committed_at)
         VALUES ('test', 'null', ?, '2026-11-02T00:00:00Z')`,
      ).run(commitState);
    };
    for (let i = 0; i < 40; i++) addCommit('applied');
    const commitIds = (): number[] =>
      db
        .prepare('SELECT commit_id FROM w5_commits')
        .all()
        .map((row) => Number(row.commit_id));
    const fileRow = (): { commit_id: number; path: string } | undefined => {
      const rows = db
        .prepare('SELECT commit_id, path FROM w5_commit_files')
        .all();
      if (rows.length === 0) return undefined;
      const row = pick(rows);
      return { commit_id: Number(row.commit_id), path: String(row.path) };
    };
    const insert = (): void => {
      db.prepare(
        `INSERT INTO w5_commit_files (commit_id, path, previous_fingerprint, new_fingerprint)
         VALUES (?, ?, ?, ?)`,
      ).run(pick(commitIds()), pick(paths), fingerprint(), fingerprint());
    };
    const operations: Array<() => void> = [
      insert,
      insert,
      insert,
      insert,
      () => {
        const row = fileRow();
        if (row)
          db.prepare(
            'DELETE FROM w5_commit_files WHERE commit_id = ? AND path = ?',
          ).run(row.commit_id, row.path);
      },
      // As an abandoned commit does: every file row of one commit.
      () =>
        db
          .prepare('DELETE FROM w5_commit_files WHERE commit_id = ?')
          .run(pick(commitIds())),
      () => {
        const row = fileRow();
        const column = pick(['previous_fingerprint', 'new_fingerprint']);
        if (row)
          db.prepare(
            `UPDATE w5_commit_files SET ${column} = ? WHERE commit_id = ? AND path = ?`,
          ).run(fingerprint(), row.commit_id, row.path);
      },
      // Moves a row within or across paths; a key collision changes nothing.
      () => {
        const row = fileRow();
        if (row)
          db.prepare(
            'UPDATE w5_commit_files SET commit_id = ?, path = ? WHERE commit_id = ? AND path = ?',
          ).run(pick(commitIds()), pick(paths), row.commit_id, row.path);
      },
      // One statement rewriting many rows of a path, as eligibility tests do.
      () =>
        db
          .prepare(
            'UPDATE w5_commit_files SET new_fingerprint = ? WHERE path = ? AND new_fingerprint IS ?',
          )
          .run(fingerprint(), pick(paths), fingerprint()),
      () => {
        addCommit(state());
      },
      () => {
        db.prepare('UPDATE w5_commits SET state = ? WHERE commit_id = ?').run(
          state(),
          pick(commitIds()),
        );
      },
      () => {
        db.prepare(
          `DELETE FROM w5_commits WHERE commit_id = ? AND NOT EXISTS
             (SELECT 1 FROM w5_commit_files f WHERE f.commit_id = w5_commits.commit_id)`,
        ).run(pick(commitIds()));
      },
    ];
    let longest = 0;
    let broken = 0;
    let linked = 0;
    let captures = 0;
    for (let step = 0; step < 4000; step++) {
      try {
        pick(operations)();
      } catch (error) {
        // A primary key collision rolls back the statement and its triggers.
        expect(String(error)).toContain(
          'UNIQUE constraint failed: w5_commit_files.commit_id, w5_commit_files.path',
        );
      }
      expectSummariesExact(db);
      if (step % 100 === 99) {
        db.exec('COMMIT');
        db.close();
        for (const path of paths)
          if (expectCaptureMatchesSchemaV2([path])) captures++;
        db = openW5CommitLogDatabase(dbPath);
        db.exec('BEGIN');
      }
      for (const chain of summaries(db).values()) {
        longest = Math.max(longest, chain.decisions);
        if (
          chain.discontinuities > 0 &&
          chain.discontinuities < chain.decisions
        )
          broken++;
        // At least this many rows after the first link to their predecessor.
        linked += chain.decisions - chain.discontinuities - 1;
      }
    }
    db.exec('COMMIT');
    expect(longest).toBeGreaterThan(20);
    expect(broken).toBeGreaterThan(1000);
    expect(linked).toBeGreaterThan(4000);
    expect(captures).toBeGreaterThan(20);
  } finally {
    db.close();
  }
}, 120_000);

it('matches schema 2 through the log API, when a recovery-required commit is abandoned', () => {
  const log = W5CommitLog.open(dbPath);
  const path = '/p/worktrees.json';
  const other = '/p/other.json';
  let image: string | null = null;
  const commit = (
    contents: string | null,
    previousFingerprint = image,
  ): number => {
    const result = log.commit({
      operation: 'test',
      advance: [],
      outcome: null,
      files: [
        { path, contents, previousFingerprint },
        { path: other, contents, previousFingerprint: null },
      ],
    });
    if (result.status !== 'committed') throw new Error(result.status);
    return result.commitId;
  };
  try {
    for (const contents of ['1', '2', null, '3']) {
      log.markApplied(commit(contents));
      image = fingerprintW5File(contents);
    }
    log.markApplied(commit('4', fingerprintW5File('foreign')));
    image = fingerprintW5File('4');
    const abandoned = commit('5');
    log.markCommitRecoveryRequired(abandoned, null);
    log.close();
    expectCaptureMatchesSchemaV2([path, other]);
    withRaw(expectSummariesExact);

    const reopened = W5CommitLog.open(dbPath);
    reopened.abandonRecoveryRequiredCommit(abandoned);
    reopened.close();
    expectCaptureMatchesSchemaV2([path, other]);
    withRaw((db) => {
      expectSummariesExact(db);
      expect(summaries(db).get(path)).toEqual({
        decisions: 5,
        startsAbsent: true,
        discontinuities: 1,
      });
    });
  } finally {
    log.close();
  }
});

it('summarizes an existing schema 2 log once, with the values schema 2 reported', () => {
  const paths = ['/p/normal', '/p/broken', '/p/malformed', '/p/removed'];
  createV2Log((db) => {
    const addCommit = db.prepare(
      `INSERT INTO w5_commits (operation, outcome_json, state, committed_at)
       VALUES ('test', 'null', 'applied', '2026-10-01T00:00:00Z')`,
    );
    const file = db.prepare(
      `INSERT INTO w5_commit_files (commit_id, path, previous_fingerprint, new_fingerprint)
       VALUES (?, ?, ?, ?)`,
    );
    const row = (
      path: string,
      previous: string | null,
      image: string | null,
    ): void => {
      file.run(Number(addCommit.run().lastInsertRowid), path, previous, image);
    };
    row(paths[0], null, A);
    row(paths[0], A, B);
    row(paths[1], A, B);
    row(paths[1], C, A);
    row(paths[2], null, 'X');
    row(paths[2], 'X', A);
    row(paths[3], A, null);
    row(paths[3], null, B);
    // An abandoned commit left a gap in the IDs.
    db.prepare('DELETE FROM w5_commits WHERE commit_id = ?').run(
      Number(addCommit.run().lastInsertRowid),
    );
    row(paths[0], B, C);
  });
  const before = withRaw(schemaV2Chains);
  expect(before.get(paths[1])).toEqual({
    decisions: 2,
    startsAbsent: false,
    discontinuities: 1,
  });
  expect(before.get(paths[2])).toMatchObject({ discontinuities: 2 });

  W5CommitLog.open(dbPath).close();

  withRaw((db) => {
    expect(
      db.prepare("SELECT value FROM w5_meta WHERE key = 'schema_version'").get()
        ?.value,
    ).toBe(String(W5_COMMIT_LOG_SCHEMA_VERSION));
    expect(summaries(db)).toEqual(before);
    expect(retained(db)).toEqual({ kept: 9, counted: 9 });
  });
});

it('backfills v1 images before summarizing malformed, absent and unresolved links', () => {
  const path = '/p/v1';
  const removed = '/p/removed';
  withRaw((db) => {
    db.exec(readFileSync(join(__dirname, 'fixtures/schema-v1.sql'), 'utf8'));
    const commit = db.prepare(
      `INSERT INTO w5_commits (operation, outcome_json, state, committed_at)
       VALUES ('test', 'null', ?, '2026-10-01T00:00:00Z')`,
    );
    const file = db.prepare('INSERT INTO w5_commit_files VALUES (?, ?, ?, ?)');
    const row = (
      state: string,
      path: string,
      previous: string | null,
      contents: string | null,
    ): void => {
      file.run(commit.run(state).lastInsertRowid, path, previous, contents);
    };
    db.exec('BEGIN');
    row('applied', path, null, 'a');
    row('applied', path, 'X', null);
    row('applied', path, null, 'b');
    row('committed', path, B, 'c');
    row('recovery-required', path, C, null);
    row('applied', removed, A, null);
    db.exec('COMMIT');
  });

  const log = W5CommitLog.open(dbPath);
  try {
    expect(
      log.captureEvidence(captureFiles([path, removed, '/p/missing'])),
    ).toMatchObject({
      retainedCommits: 6,
      unresolvedCommits: 2,
      chains: [
        { decisions: 5, startsAbsent: true, discontinuities: 1 },
        { decisions: 1, startsAbsent: false, discontinuities: 0 },
        { decisions: 0, startsAbsent: false, discontinuities: 0 },
      ],
      files: [
        { commitId: 3, previousFingerprint: null, newFingerprint: B },
        { commitId: 4, previousFingerprint: B, newFingerprint: C },
        { commitId: 5, previousFingerprint: C, newFingerprint: null },
        { commitId: 6, previousFingerprint: A, newFingerprint: null },
      ],
    });
    log.abandonRecoveryRequiredCommit(5);
    log.markApplied(4);
  } finally {
    log.close();
  }
  withRaw((db) => {
    expectSummariesExact(db);
    expect(summaries(db).get(path)).toEqual({
      decisions: 4,
      startsAbsent: true,
      discontinuities: 1,
    });
    expect(db.prepare('SELECT contents FROM w5_commit_files').all()).toEqual(
      Array.from({ length: 5 }, () => ({ contents: null })),
    );
  });
  expectCaptureMatchesSchemaV2([path, removed, '/p/missing']);
});

it('rolls back chain summaries and commit totals with a refused multi-file commit', () => {
  const log = W5CommitLog.open(dbPath);
  const path = '/p/worktrees.json';
  const file = { path, contents: 'a', previousFingerprint: null };
  try {
    const saved = log.commit({
      operation: 'test',
      advance: [],
      outcome: null,
      files: [file],
    });
    log.markApplied(saved.commitId);
    const before = log.captureEvidence(captureFiles([path]));
    expect(() =>
      log.commit({
        operation: 'test',
        advance: [],
        outcome: null,
        files: [file, file],
      }),
    ).toThrow('UNIQUE constraint failed');
    expect(log.captureEvidence(captureFiles([path]))).toEqual(before);
  } finally {
    log.close();
  }
  withRaw(expectSummariesExact);
});

describe('a path with 200,000 decisions', () => {
  const path = '/p/canopy/worktrees.json';
  const small = '/p/canopy/workspace.json';
  const recoveryRequired = [60_001, 140_001];

  /**
   * A schema 2 log with `decisions` rows for one path: continuous, with a
   * foreign preimage, a malformed image and removals at fixed positions, and
   * two recovery-required commits in the middle of its history.
   */
  function createLongV2Log(decisions: number): void {
    createV2Log((db) => {
      const addCommit = db.prepare(
        `INSERT INTO w5_commits (operation, outcome_json, state, committed_at, completed_at)
         VALUES ('test', 'null', ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
      );
      const file = db.prepare(
        `INSERT INTO w5_commit_files (commit_id, path, previous_fingerprint, new_fingerprint)
       VALUES (?, ?, ?, ?)`,
      );
      const images = [A, B];
      let image: string | null = null;
      for (let i = 1; i <= decisions; i++) {
        const state = recoveryRequired.includes(i)
          ? 'recovery-required'
          : 'applied';
        const commitId = Number(addCommit.run(state).lastInsertRowid);
        let previous = image;
        let next: string | null = images[i % 2];
        if (i % 50_000 === 25_000) previous = C;
        if (i % 50_000 === 30_000) next = 'X';
        if (i % 50_000 === 40_000) next = null;
        file.run(commitId, path, previous, next);
        image = next;
        if (i <= 3) file.run(commitId, small, null, A);
      }
    });
  }

  function captureMs(): number {
    const log = W5CommitLog.open(dbPath);
    try {
      const files = captureFiles([path, small]);
      log.captureEvidence(files);
      let best = Number.POSITIVE_INFINITY;
      for (let batch = 0; batch < 5; batch++) {
        const start = performance.now();
        for (let i = 0; i < 40; i++) log.captureEvidence(files);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    } finally {
      log.close();
    }
  }

  it('upgrades, abandons mid-history and captures as schema 2 did, in flat time', () => {
    createLongV2Log(2_000);
    const shortHistory = captureMs();
    rmSync(dbPath);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    createLongV2Log(200_000);
    const before = withRaw((db) =>
      schemaV2Capture(db, captureFiles([path, small])),
    );
    expect(before.chains[0]).toMatchObject({
      decisions: 200_000,
      startsAbsent: true,
      // Per 50,000: a foreign preimage, and a malformed image and the
      // decision after it. A removal followed by a creation is continuous.
      discontinuities: 12,
    });
    expectCaptureMatchesSchemaV2([path, small], before);
    const longHistory = captureMs();
    // Schema 2 took over 100 times longer here; allow scheduling noise.
    expect(longHistory).toBeLessThan(shortHistory * 3);

    // Removing a mid-history row links its successor to its predecessor,
    // whose image differs from the successor's preimage.
    const log = W5CommitLog.open(dbPath);
    log.abandonRecoveryRequiredCommit(recoveryRequired[0]);
    log.close();
    expectCaptureMatchesSchemaV2([path, small]);
    withRaw((db) => {
      expect(summaries(db).get(path)).toMatchObject({
        decisions: 199_999,
        discontinuities: 13,
      });
      expect(retained(db)).toEqual({ kept: 199_999, counted: 199_999 });
    });
  }, 300_000);
});
