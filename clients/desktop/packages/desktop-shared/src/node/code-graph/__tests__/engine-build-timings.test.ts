import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import { CodeGraphEngine } from '../engine';
import { cloneCompletedCodeGraphDatabase } from '../base-graph';
import {
  CODE_GRAPH_BUILD_TIMING_KEY_PREFIX,
  CODE_GRAPH_TIME_TO_FIRST_GRAPH_KEY,
} from '../build-timings';

const LIB = `export function doWork(): number {
  return 42;
}
`;
const MAIN = `import { doWork } from './lib';

export function run(): number {
  return doWork();
}
`;

const ENGINE_PHASE_KEYS = [
  'prepare_ms',
  'scan_ms',
  'hash_ms',
  'parse_ms',
  'diagnostics_ms',
  'commit_ms',
  'rows_written',
  'wal_start_bytes',
  'peak_wal_bytes',
  'peak_rss_bytes',
];
const RESOLVER_KEYS = [
  'resolve_reset_ms',
  'resolve_imports_ms',
  'resolve_config_extends_ms',
  'resolve_doc_links_ms',
  'resolve_ipc_ms',
  'resolve_workflow_actions_ms',
  'resolve_calls_ms',
  'resolve_tests_ms',
  'fts_ms',
];

function timingMetadata(dbPath: string): Record<string, number> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(
      db
        .prepare(
          `SELECT key, value FROM graph_metadata WHERE key LIKE '${CODE_GRAPH_BUILD_TIMING_KEY_PREFIX}%' ORDER BY key`,
        )
        .all()
        .map((row) => [
          String(row.key).slice(CODE_GRAPH_BUILD_TIMING_KEY_PREFIX.length),
          Number(row.value),
        ]),
    );
  } finally {
    db.close();
  }
}

function metadataValue(dbPath: string, key: string): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT value FROM graph_metadata WHERE key = ?')
      .get(key);
    return row === undefined ? null : String(row.value);
  } finally {
    db.close();
  }
}

describe('code-graph build phase timings', () => {
  let root: string;
  let dbPath: string;
  let engine: CodeGraphEngine;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-timings-'));
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'lib.ts'), LIB);
    writeFileSync(path.join(root, 'src', 'main.ts'), MAIN);
    dbPath = path.join(root, '.graph', 'graph.db');
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
  });

  afterEach(() => {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('persists every phase of a full build and returns the same timings', async () => {
    const result = await engine.buildOrUpdate({
      prelude: {
        queueWaitMs: 1_250.04,
        fingerprintMs: 31.26,
        seedCopyMs: 402,
        fusionMs: 88.5,
      },
    });

    const persisted = timingMetadata(dbPath);
    for (const key of [
      'queue_wait_ms',
      'fingerprint_ms',
      'seed_copy_ms',
      'fusion_ms',
      ...ENGINE_PHASE_KEYS,
      ...RESOLVER_KEYS,
      'derived_ms',
    ]) {
      expect(persisted).toHaveProperty([key]);
      expect(Number.isFinite(persisted[key])).toBe(true);
      expect(persisted[key]).toBeGreaterThanOrEqual(0);
    }
    expect(persisted.queue_wait_ms).toBe(1_250);
    expect(persisted.fingerprint_ms).toBe(31.3);
    expect(persisted.seed_copy_ms).toBe(402);
    expect(persisted.fusion_ms).toBe(88.5);
    expect(persisted.rows_written).toBeGreaterThan(10);
    expect(persisted.peak_wal_bytes).toBeGreaterThan(0);
    // Opening the engine already wrote the schema to the WAL; the build's
    // commit grows the file past that.
    expect(persisted.peak_wal_bytes).toBeGreaterThan(persisted.wal_start_bytes);
    expect(persisted.peak_rss_bytes).toBeGreaterThan(1_000_000);

    expect(result.timings).toMatchObject({
      queueWaitMs: 1_250,
      fingerprintMs: 31.3,
      seedCopyMs: 402,
      fusionMs: 88.5,
      rowsWritten: persisted.rows_written,
      peakWalBytes: persisted.peak_wal_bytes,
      commitMs: persisted.commit_ms,
      resolveMs: {
        resetMs: persisted.resolve_reset_ms,
        callsMs: persisted.resolve_calls_ms,
      },
      ftsMs: persisted.fts_ms,
    });
    // A build with no first-graph request records no time-to-first-graph.
    expect(
      metadataValue(dbPath, CODE_GRAPH_TIME_TO_FIRST_GRAPH_KEY),
    ).toBeNull();
    expect(result.timings?.timeToFirstGraphMs).toBeUndefined();
  });

  it('clears the previous build so skipped phases are absent, not stale', async () => {
    await engine.buildOrUpdate({ prelude: { queueWaitMs: 5 } });
    const noOp = await engine.buildOrUpdate();

    const persisted = timingMetadata(dbPath);
    expect(noOp.factsChanged).toBe(false);
    for (const key of ENGINE_PHASE_KEYS)
      expect(persisted).toHaveProperty([key]);
    // Facts did not change: the resolvers, FTS and derived analysis did not run.
    for (const key of [...RESOLVER_KEYS, 'derived_ms', 'queue_wait_ms']) {
      expect(persisted).not.toHaveProperty([key]);
    }
    expect(noOp.timings?.resolveMs).toBeUndefined();
    expect(noOp.timings?.ftsMs).toBeUndefined();
  });

  it('persists actual selective FTS time for replacement and removal', async () => {
    await engine.buildOrUpdate();
    engine.close();
    let now = 0;
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
      now: () => {
        now += 2;
        return now;
      },
    });

    writeFileSync(
      path.join(root, 'src', 'lib.ts'),
      `${LIB}export const added = 1;\n`,
    );
    const replaced = await engine.buildOrUpdate({ verifyContent: true });
    expect(replaced.filesParsed).toBeGreaterThan(0);
    expect(replaced.timings?.ftsMs).toBeGreaterThan(0);
    expect(timingMetadata(dbPath).fts_ms).toBe(replaced.timings?.ftsMs);

    rmSync(path.join(root, 'src', 'lib.ts'));
    const removed = await engine.buildOrUpdate();
    expect(removed.filesRemoved).toBe(1);
    expect(removed.timings?.ftsMs).toBeGreaterThan(0);
    expect(timingMetadata(dbPath).fts_ms).toBe(removed.timings?.ftsMs);

    const noOp = await engine.buildOrUpdate();
    expect(noOp.factsChanged).toBe(false);
    expect(noOp.timings?.ftsMs).toBeUndefined();
    expect(timingMetadata(dbPath)).not.toHaveProperty('fts_ms');
  });

  it('records time to first graph once, on the build that completes the first graph', async () => {
    const requestedAt = Date.now() - 5_000;
    const first = await engine.buildOrUpdate({
      prelude: { firstGraphRequestedAt: requestedAt },
    });

    const recorded = Number(
      metadataValue(dbPath, CODE_GRAPH_TIME_TO_FIRST_GRAPH_KEY),
    );
    expect(recorded).toBeGreaterThanOrEqual(5_000);
    expect(first.timings?.timeToFirstGraphMs).toBe(recorded);

    // Later builds of an existing graph never restamp it.
    writeFileSync(
      path.join(root, 'src', 'lib.ts'),
      `${LIB}export const extra = 1;\n`,
    );
    const later = await engine.buildOrUpdate({
      prelude: { firstGraphRequestedAt: requestedAt - 60_000 },
    });
    expect(later.timings?.timeToFirstGraphMs).toBeUndefined();
    expect(
      Number(metadataValue(dbPath, CODE_GRAPH_TIME_TO_FIRST_GRAPH_KEY)),
    ).toBe(recorded);
  });

  it('does not carry time to first graph into a clone for another worktree', async () => {
    await engine.buildOrUpdate({
      prelude: { firstGraphRequestedAt: Date.now() - 1_000 },
    });
    expect(
      metadataValue(dbPath, CODE_GRAPH_TIME_TO_FIRST_GRAPH_KEY),
    ).not.toBeNull();
    const cloneRoot = path.join(root, 'clone-worktree');
    const clonePath = path.join(root, '.clone', 'graph.db');

    const cloned = await cloneCompletedCodeGraphDatabase({
      sourceDbPath: dbPath,
      targetDbPath: clonePath,
      repositories: [{ repoId: 'fixture', rootPath: cloneRoot }],
    });

    expect(cloned.installed).toBe(true);
    expect(
      metadataValue(clonePath, CODE_GRAPH_TIME_TO_FIRST_GRAPH_KEY),
    ).toBeNull();
    // The copied phase timings still describe the build that wrote the data.
    expect(metadataValue(clonePath, 'build_timing:commit_ms')).not.toBeNull();
  });

  it('times phases with the injected monotonic clock', async () => {
    engine.close();
    let now = 0;
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
      // Every reading advances the clock by 2 ms, so each measured span is a
      // positive multiple of 2 regardless of host speed.
      now: () => {
        now += 2;
        return now;
      },
    });

    const result = await engine.buildOrUpdate();

    const timings = result.timings;
    expect(timings).toBeDefined();
    for (const value of [
      timings?.prepareMs,
      timings?.scanMs,
      timings?.hashMs,
      timings?.parseMs,
      timings?.ftsMs,
      timings?.derivedMs,
      timings?.diagnosticsMs,
      timings?.commitMs,
    ]) {
      expect(value).toBeGreaterThan(0);
      expect((value ?? 1) % 2).toBe(0);
    }
  });
});
