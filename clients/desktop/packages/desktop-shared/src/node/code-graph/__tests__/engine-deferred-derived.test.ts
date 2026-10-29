/**
 * Phase 20 (G6): a worktree refresh publishes its facts, resolutions and
 * full-text index first, and derived analysis (communities, flows) plus
 * diagnostics run afterwards. Until they do, derived data is reported as
 * stale through the existing markers: `derived_at` is absent while
 * `last_build_at` is set and earlier derived rows remain, and the diagnostics'
 * community and flow statuses read `stale`.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodeGraphEngine } from '../engine';
import { CodeGraphQueryService } from '../query/queries';
import { openCodeGraphDatabase, requireRow } from '../store/database';
import { codeGraphDerivedState } from '../../../types/code-graph-tools';
import type { CodeGraphStatus } from '../../../types/code-graph';

const LIB = `export function doWork(): number {
  return 42;
}

export function helper(): number {
  return doWork() + 1;
}
`;
const MAIN = `import { doWork, helper } from './lib';

export function run(): number {
  return doWork() + helper();
}
`;
const OTHER = `import { run } from './main';

export function entry(): number {
  return run();
}
`;

const GRAPH_TABLES = [
  'repositories',
  'files',
  'symbols',
  'edges',
  'communities',
  'community_memberships',
  'flows',
  'flow_memberships',
  'symbol_fts',
  'symbol_fragment_fts',
] as const;

/**
 * Every graph table without checkout paths, stat times or timestamps (the
 * two checkouts were written at different times). `ordered` keeps rowid
 * order, for builds with identical histories; otherwise rows are compared as
 * sets, since a different sequence of incremental builds inserts the same
 * rows in a different order.
 */
function graphRows(dbPath: string, ordered = true): Record<string, unknown[]> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const result: Record<string, unknown[]> = {};
    for (const table of GRAPH_TABLES) {
      const rows = db
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .all()
        .map((value) => {
          const row = { ...requireRow(value) };
          delete row.updated_at;
          delete row.root_path;
          delete row.absolute_path;
          delete row.mtime_ns;
          return row;
        });
      result[table] = ordered
        ? rows
        : rows.map((row) => JSON.stringify(row)).sort();
    }
    return result;
  } finally {
    db.close();
  }
}

function derivedStatuses(status: CodeGraphStatus): string[] {
  return (status.diagnostics?.repositories ?? []).map(
    (repository) =>
      `${repository.repoId}:${repository.communityStatus}/${repository.flowStatus}`,
  );
}

function stateOf(status: CodeGraphStatus): string {
  return codeGraphDerivedState({
    lastBuildAt: status.lastBuildAt,
    derivedAt: status.derivedAt,
    communityCount: status.communityCount,
    flowCount: status.flowCount,
  });
}

function writeFixture(root: string): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'lib.ts'), LIB);
  writeFileSync(path.join(root, 'src', 'main.ts'), MAIN);
}

async function openEngine(
  root: string,
  dbPath: string,
): Promise<CodeGraphEngine> {
  return CodeGraphEngine.open({
    dbPath,
    repositories: [{ repoId: 'fixture', rootPath: root }],
  });
}

describe('deferred derived analysis (G6)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-deferred-derived-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('publishes the refreshed graph before derived analysis and reports derived data stale until it completes', async () => {
    const checkout = path.join(root, 'checkout');
    writeFixture(checkout);
    const dbPath = path.join(root, 'graph.db');
    const engine = await openEngine(checkout, dbPath);
    try {
      await engine.buildOrUpdate();
      const before = engine.getStatus();
      expect(stateOf(before)).toBe('current');
      expect(before.communityCount).toBeGreaterThan(0);

      writeFileSync(path.join(checkout, 'src', 'other.ts'), OTHER);
      const published = await engine.buildOrUpdate({ deferDerived: true });
      expect(published.factsChanged).toBe(true);
      expect(published.derivedDeferred).toBe(true);
      expect(published.derived).toEqual([]);
      expect(published.timings?.derivedMs).toBeUndefined();

      const stale = engine.getStatus();
      expect(stale.lastBuildAt).not.toBeNull();
      expect(stale.derivedAt).toBeNull();
      // The earlier analysis is still readable, and reported as stale; its
      // persisted counts remain useful until deferred analysis replaces it.
      expect(stale.communityCount).toBe(before.communityCount);
      expect(stale.flowCount).toBe(before.flowCount);
      expect(stateOf(stale)).toBe('stale');
      expect(derivedStatuses(stale)).toEqual(['fixture:stale/stale']);
      // The published facts are already the new ones.
      expect(stale.symbolCount).toBeGreaterThan(before.symbolCount);

      const db = openCodeGraphDatabase(dbPath);
      try {
        expect(new CodeGraphQueryService(db).getDerivedStats()).toMatchObject({
          stale: true,
          communityCount: before.communityCount,
          flowCount: before.flowCount,
        });
      } finally {
        db.close();
      }

      const completed = await engine.completeDeferredDerived();
      expect(completed.ran).toBe(true);
      expect(completed.derived).toHaveLength(1);
      expect(completed.derived[0]?.computed).toBe(true);

      const current = engine.getStatus();
      expect(current.derivedAt).not.toBeNull();
      expect(stateOf(current)).toBe('current');
      expect(derivedStatuses(current)).toEqual(['fixture:complete/complete']);
      const reopened = openCodeGraphDatabase(dbPath);
      try {
        expect(
          new CodeGraphQueryService(reopened).getDerivedStats(),
        ).not.toHaveProperty('stale');
      } finally {
        reopened.close();
      }
    } finally {
      engine.close();
    }
  });

  it('produces exactly the inline build’s graph, derived rows and diagnostics once derived analysis completes', async () => {
    const inlineCheckout = path.join(root, 'inline');
    const deferredCheckout = path.join(root, 'deferred');
    writeFixture(inlineCheckout);
    cpSync(inlineCheckout, deferredCheckout, { recursive: true });
    const inlineDb = path.join(root, 'inline.db');
    const deferredDb = path.join(root, 'deferred.db');
    const inline = await openEngine(inlineCheckout, inlineDb);
    const deferred = await openEngine(deferredCheckout, deferredDb);
    try {
      // Cold build.
      await inline.buildOrUpdate();
      await deferred.buildOrUpdate({ deferDerived: true });
      expect(stateOf(deferred.getStatus())).toBe('none');
      await deferred.completeDeferredDerived();
      expect(graphRows(deferredDb)).toEqual(graphRows(inlineDb));

      // Incremental edit.
      for (const checkout of [inlineCheckout, deferredCheckout]) {
        writeFileSync(path.join(checkout, 'src', 'other.ts'), OTHER);
      }
      const inlineResult = await inline.buildOrUpdate();
      await deferred.buildOrUpdate({ deferDerived: true });
      const completed = await deferred.completeDeferredDerived();
      expect(completed.derived).toEqual(inlineResult.derived);
      expect(graphRows(deferredDb)).toEqual(graphRows(inlineDb));

      const inlineStatus = inline.getStatus();
      const deferredStatus = deferred.getStatus();
      expect(deferredStatus.diagnostics?.repositories).toEqual(
        inlineStatus.diagnostics?.repositories,
      );
      expect(deferredStatus.diagnostics?.freshness).toBe(
        inlineStatus.diagnostics?.freshness,
      );
    } finally {
      inline.close();
      deferred.close();
    }
  });

  it('does not defer or report staleness when derived analysis is already current', async () => {
    const checkout = path.join(root, 'checkout');
    writeFixture(checkout);
    const engine = await openEngine(checkout, path.join(root, 'graph.db'));
    try {
      await engine.buildOrUpdate();
      const noOp = await engine.buildOrUpdate({ deferDerived: true });
      expect(noOp.factsChanged).toBe(false);
      expect(noOp.derivedDeferred).toBeUndefined();
      expect(stateOf(engine.getStatus())).toBe('current');
      const completion = await engine.completeDeferredDerived();
      expect(completion.ran).toBe(false);
    } finally {
      engine.close();
    }
  });

  it('coalesces deferred work: several refreshes before completion run derived analysis once, on the latest graph', async () => {
    const inlineCheckout = path.join(root, 'inline');
    const deferredCheckout = path.join(root, 'deferred');
    writeFixture(inlineCheckout);
    cpSync(inlineCheckout, deferredCheckout, { recursive: true });
    const inlineDb = path.join(root, 'inline.db');
    const deferredDb = path.join(root, 'deferred.db');
    const inline = await openEngine(inlineCheckout, inlineDb);
    const deferred = await openEngine(deferredCheckout, deferredDb);
    try {
      await inline.buildOrUpdate();
      await deferred.buildOrUpdate();

      writeFileSync(path.join(deferredCheckout, 'src', 'other.ts'), OTHER);
      await deferred.buildOrUpdate({ deferDerived: true });
      writeFileSync(
        path.join(deferredCheckout, 'src', 'lib.ts'),
        `${LIB}\nexport function extra(): number { return helper(); }\n`,
      );
      await deferred.buildOrUpdate({ deferDerived: true });
      expect(stateOf(deferred.getStatus())).toBe('stale');

      const first = await deferred.completeDeferredDerived();
      expect(first.ran).toBe(true);
      const second = await deferred.completeDeferredDerived();
      expect(second.ran).toBe(false);

      writeFileSync(path.join(inlineCheckout, 'src', 'other.ts'), OTHER);
      writeFileSync(
        path.join(inlineCheckout, 'src', 'lib.ts'),
        `${LIB}\nexport function extra(): number { return helper(); }\n`,
      );
      await inline.buildOrUpdate();
      expect(graphRows(deferredDb, false)).toEqual(graphRows(inlineDb, false));
      expect(stateOf(deferred.getStatus())).toBe('current');
    } finally {
      inline.close();
      deferred.close();
    }
  });

  it('keeps building inline when deferral is not requested', async () => {
    const checkout = path.join(root, 'checkout');
    writeFixture(checkout);
    const engine = await openEngine(checkout, path.join(root, 'graph.db'));
    try {
      const result = await engine.buildOrUpdate();
      expect(result.derivedDeferred).toBeUndefined();
      expect(result.derived[0]?.computed).toBe(true);
      expect(stateOf(engine.getStatus())).toBe('current');
    } finally {
      engine.close();
    }
  });
});
