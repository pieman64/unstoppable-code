/**
 * PRIVATE DRAFT ONLY. Intended as additive lifecycle coverage after the
 * implementation is adopted. No test, typecheck, build, or app command was run.
 */
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodeGraphEngine } from '../engine';
import {
  cloneCompletedCodeGraphDatabase,
  readCodeGraphSummaryProjection,
} from '../base-graph';
import {
  backfillCodeGraphSummaryProjection,
  type CodeGraphSummaryProjectionV1,
  type ReadCodeGraphSummaryProjectionResult,
} from '../summary-projection';
import * as derivedAnalysis from '../analysis/derived';
import { applyCodeGraphSnapshot } from '../snapshot/import';
import { buildCodeGraphSnapshot } from '../snapshot/export';
import { getMetadataValue, openCodeGraphDatabase } from '../store/database';
import { CodeGraphStore } from '../store/graph-store';

const REPO = 'lifecycle-revision-repo';
const LIB = `export function work(): number { return 42; }\n`;
const MAIN = `import { work } from './lib';\nexport function run(): number { return work(); }\n`;
const FIXED_BUILD_AT = 1791417600000;

function writeFixture(rootPath: string): void {
  mkdirSync(path.join(rootPath, 'src'), { recursive: true });
  writeFileSync(path.join(rootPath, 'src', 'lib.ts'), LIB);
  writeFileSync(path.join(rootPath, 'src', 'main.ts'), MAIN);
}

function metadata(dbPath: string, key: string): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT value FROM graph_metadata WHERE key = ?')
      .get(key);
    return row === undefined ? null : String(Reflect.get(row, 'value'));
  } finally {
    db.close();
  }
}

function revisionAt(dbPath: string): number {
  const raw = metadata(dbPath, 'summary_projection_revision');
  if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error('Expected a safe summary projection revision marker.');
  }
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision)) {
    throw new Error('Expected a safe summary projection revision marker.');
  }
  return revision;
}

function readyProjection(
  result: ReadCodeGraphSummaryProjectionResult,
): CodeGraphSummaryProjectionV1 {
  if (result.state !== 'ready') {
    throw new Error(
      `Expected a ready summary projection, got ${result.state}.`,
    );
  }
  return result.projection;
}

async function openEngine(
  checkoutRoot: string,
  dbPath: string,
): Promise<CodeGraphEngine> {
  return CodeGraphEngine.open({
    dbPath,
    repositories: [{ repoId: REPO, rootPath: checkoutRoot }],
    worktreeRootPath: checkoutRoot,
  });
}

describe('summary projection lifecycle revisions', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-lifecycle-revision-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps clone, snapshot invalidation, and backfill revisions monotonic while preserving imported null markers and measured counts', async () => {
    const sourceRoot = path.join(root, 'source');
    const cloneRoot = path.join(root, 'clone');
    const sourceDbPath = path.join(root, 'source.db');
    const cloneDbPath = path.join(root, 'clone', 'graph.db');
    writeFixture(sourceRoot);
    cpSync(sourceRoot, cloneRoot, { recursive: true });

    const engine = await openEngine(sourceRoot, sourceDbPath);
    try {
      await engine.buildOrUpdate();
    } finally {
      engine.close();
    }
    const sourceProjection = readyProjection(
      readCodeGraphSummaryProjection(sourceDbPath),
    );
    const sourceRevision = sourceProjection.projectionRevision;

    const clearedCloneRoot = path.join(root, 'cleared-clone');
    const clearedCloneDbPath = path.join(clearedCloneRoot, 'graph.db');
    cpSync(sourceRoot, clearedCloneRoot, { recursive: true });
    const cleared = await cloneCompletedCodeGraphDatabase({
      sourceDbPath,
      targetDbPath: clearedCloneDbPath,
      repositories: [{ repoId: REPO, rootPath: clearedCloneRoot }],
      completion: 'clear',
    });
    expect(cleared.installed).toBe(true);
    expect(revisionAt(clearedCloneDbPath)).toBe(sourceRevision);
    expect(metadata(clearedCloneDbPath, 'summary_projection_v1')).toBeNull();
    expect(metadata(clearedCloneDbPath, 'last_build_at')).toBeNull();
    expect(metadata(clearedCloneDbPath, 'completed_build_at')).toBeNull();
    expect(readCodeGraphSummaryProjection(clearedCloneDbPath)).toMatchObject({
      state: 'pending',
      reason: 'projection-missing',
      observed: {
        projectionRevision: sourceRevision,
        lastBuildAt: null,
        completedBuildAt: null,
      },
    });
    const clearedWriter = openCodeGraphDatabase(clearedCloneDbPath);
    try {
      expect(
        backfillCodeGraphSummaryProjection(clearedCloneDbPath, {
          db: clearedWriter,
          worktreeRootPath: clearedCloneRoot,
        }).state,
      ).toBe('ready');
      const measuredIncomplete = readyProjection(
        readCodeGraphSummaryProjection(clearedCloneDbPath),
      );
      expect(measuredIncomplete).toMatchObject({
        assembly: 'incomplete',
        lastBuildAt: null,
        completedBuildAt: null,
        totals: sourceProjection.totals,
      });
      expect(measuredIncomplete.projectionRevision).toBeGreaterThan(
        sourceRevision,
      );
      expect(metadata(clearedCloneDbPath, 'last_build_at')).toBeNull();
      expect(metadata(clearedCloneDbPath, 'completed_build_at')).toBeNull();
    } finally {
      clearedWriter.close();
    }

    const cloned = await cloneCompletedCodeGraphDatabase({
      sourceDbPath,
      targetDbPath: cloneDbPath,
      repositories: [{ repoId: REPO, rootPath: cloneRoot }],
    });
    expect(cloned.installed).toBe(true);
    const cloneProjection = readyProjection(
      readCodeGraphSummaryProjection(cloneDbPath),
    );
    expect(cloneProjection.projectionRevision).toBeGreaterThan(sourceRevision);
    const cloneRevision = cloneProjection.projectionRevision;

    const db = openCodeGraphDatabase(cloneDbPath);
    try {
      const store = new CodeGraphStore(db);
      const snapshot = await buildCodeGraphSnapshot({
        store,
        repoId: REPO,
        generatedAt: '2026-10-08T00:00:00.000Z',
      });
      const imported = await applyCodeGraphSnapshot({
        store,
        db,
        repoId: REPO,
        rootPath: cloneRoot,
        envelope: snapshot.envelope,
      });

      expect(getMetadataValue(db, 'summary_projection_revision')).toBe(
        String(cloneRevision),
      );
      expect(getMetadataValue(db, 'last_build_at')).toBeNull();
      expect(getMetadataValue(db, 'completed_build_at')).toBeNull();
      expect(getMetadataValue(db, 'derived_at')).toBeNull();
      expect(readCodeGraphSummaryProjection(cloneDbPath)).toMatchObject({
        state: 'pending',
        reason: 'projection-missing',
        observed: {
          projectionRevision: cloneRevision,
          lastBuildAt: null,
          completedBuildAt: null,
          derivedAt: null,
        },
      });

      const backfilled = backfillCodeGraphSummaryProjection(cloneDbPath, {
        db,
        worktreeRootPath: cloneRoot,
      });
      expect(backfilled.state).toBe('ready');
      if (backfilled.state !== 'ready') {
        throw new Error('Expected backfill to publish a measured projection.');
      }
      const projection = readyProjection(
        readCodeGraphSummaryProjection(cloneDbPath),
      );
      expect(projection.projectionRevision).toBeGreaterThan(cloneRevision);
      expect(getMetadataValue(db, 'summary_projection_revision')).toBe(
        String(projection.projectionRevision),
      );
      expect(projection).toMatchObject({
        assembly: 'imported',
        lastBuildAt: null,
        completedBuildAt: null,
        derivedAt: null,
        totals: {
          fileCount: imported.filesImported,
          symbolCount: imported.symbolsImported,
          edgeCount: imported.edgesImported,
          communityCount: 0,
          flowCount: 0,
        },
        repositories: [
          {
            repoId: REPO,
            counts: {
              fileCount: imported.filesImported,
              symbolCount: imported.symbolsImported,
              edgeCount: imported.edgesImported,
              communityCount: 0,
              flowCount: 0,
            },
          },
        ],
      });
      expect(getMetadataValue(db, 'last_build_at')).toBeNull();
      expect(getMetadataValue(db, 'completed_build_at')).toBeNull();
      expect(getMetadataValue(db, 'derived_at')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('does not remeasure projection fact counts or rank communities on an unchanged build', async () => {
    const checkout = path.join(root, 'checkout');
    const dbPath = path.join(root, 'graph.db');
    writeFixture(checkout);
    const engine = await openEngine(checkout, dbPath);
    try {
      await engine.buildOrUpdate();
      const before = readyProjection(readCodeGraphSummaryProjection(dbPath));
      const prepareObserver = jest.spyOn(DatabaseSync.prototype, 'prepare');
      try {
        prepareObserver.mockClear();
        const unchanged = await engine.buildOrUpdate();
        const statements = prepareObserver.mock.calls.map(([sql]) => sql);
        const projectionFactOrRankScans = statements.filter(
          (sql) =>
            /WITH\s+file_counts\s+AS\s*\(/i.test(sql) ||
            /ORDER\s+BY\s+c\.size\s+DESC\s*,\s*c\.id/i.test(sql),
        );

        expect(unchanged.factsChanged).toBe(false);
        expect(unchanged.filesParsed).toBe(0);
        expect(projectionFactOrRankScans).toEqual([]);
        const after = readyProjection(readCodeGraphSummaryProjection(dbPath));
        expect(after.projectionRevision).toBeGreaterThan(
          before.projectionRevision,
        );
        expect(after.repositories).toEqual(before.repositories);
        expect(after.totals).toEqual(before.totals);
        expect(after.topCommunities).toEqual(before.topCommunities);
      } finally {
        prepareObserver.mockRestore();
      }
    } finally {
      engine.close();
    }
  });

  it('does not let deferred derived publication overwrite a newer equal-millisecond revision', async () => {
    const checkout = path.join(root, 'checkout');
    const dbPath = path.join(root, 'graph.db');
    writeFixture(checkout);
    const engine = await openEngine(checkout, dbPath);
    let unblockComputation = (): void => undefined;
    let signalComputationStarted = (): void => undefined;
    let inFlight: Promise<
      Awaited<ReturnType<CodeGraphEngine['completeDeferredDerived']>>
    > | null = null;
    const computationStarted = new Promise<void>((resolve) => {
      signalComputationStarted = resolve;
    });
    const computationGate = new Promise<void>((resolve) => {
      unblockComputation = resolve;
    });
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(FIXED_BUILD_AT);
    let restoreCompute = (): void => undefined;

    try {
      await engine.buildOrUpdate();
      writeFileSync(
        path.join(checkout, 'src', 'lib.ts'),
        `${LIB}export function newer(): number { return 7; }\n`,
      );
      await engine.buildOrUpdate({ deferDerived: true });
      const oldLastBuildAt = metadata(dbPath, 'last_build_at');
      const oldCompletedAt = metadata(dbPath, 'completed_build_at');
      const oldRevision = revisionAt(dbPath);
      const oldPending = metadata(dbPath, 'derived_pending');
      if (oldPending === null) {
        throw new Error(
          'Expected the deferred build to leave a pending request.',
        );
      }

      // Block at the exported analysis boundary. The mock deliberately does not
      // call the real per-repository replaceDerivedForRepo write; this isolates
      // the final guarded metadata/projection publication fence.
      const compute = jest
        .spyOn(derivedAnalysis, 'computeDerivedForRepo')
        .mockImplementation(async ({ repoId }) => {
          signalComputationStarted();
          await computationGate;
          return {
            repoId,
            computed: true,
            communityCount: 1,
            flowCount: 1,
            communitiesSkipped: false,
            flowsGlobalCapReached: false,
            warnings: [],
          };
        });
      restoreCompute = (): void => compute.mockRestore();

      inFlight = engine.completeDeferredDerived();
      await computationStarted;
      expect(compute).toHaveBeenCalledTimes(1);
      await engine.buildOrUpdate({ deferDerived: true });
      const newerLastBuildAt = metadata(dbPath, 'last_build_at');
      const newerCompletedAt = metadata(dbPath, 'completed_build_at');
      const newerRevision = revisionAt(dbPath);
      const newerPending = metadata(dbPath, 'derived_pending');
      const newerDiagnostics = metadata(dbPath, 'graph_diagnostics');
      const newerProjection = readyProjection(
        readCodeGraphSummaryProjection(dbPath),
      );

      // The equal raw time and unchanged coalesced pending request leave the
      // projection revision as the differentiator for this supersede fence.
      expect(newerLastBuildAt).toBe(oldLastBuildAt);
      expect(newerCompletedAt).toBe(oldCompletedAt);
      expect(newerPending).toBe(oldPending);
      expect(newerRevision).toBeGreaterThan(oldRevision);
      expect(newerProjection.projectionRevision).toBe(newerRevision);
      expect(newerProjection.lastBuildAt).toBe(FIXED_BUILD_AT);
      expect(newerProjection.completedBuildAt).toBe(FIXED_BUILD_AT);
      expect(newerProjection.derivedAt).toBeNull();

      unblockComputation();
      const completed = await inFlight;
      expect(completed.ran).toBe(true);
      expect(revisionAt(dbPath)).toBe(newerRevision);
      expect(metadata(dbPath, 'derived_pending')).toBe(newerPending);
      expect(metadata(dbPath, 'graph_diagnostics')).toBe(newerDiagnostics);
      expect(metadata(dbPath, 'derived_at')).toBeNull();
      expect(readyProjection(readCodeGraphSummaryProjection(dbPath))).toEqual(
        newerProjection,
      );
    } finally {
      unblockComputation();
      if (inFlight !== null) {
        await inFlight.catch(() => undefined);
      }
      restoreCompute();
      dateNow.mockRestore();
      engine.close();
    }
  });
});
