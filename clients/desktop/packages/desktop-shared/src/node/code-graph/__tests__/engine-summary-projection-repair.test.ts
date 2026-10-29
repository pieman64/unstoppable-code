// PRIVATE ADDITIVE DRAFT: unapplied and unrun; requires the R2 + repair supplements.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as analysis from '../analysis/derived';
import { CodeGraphEngine } from '../engine';
import * as deferredDerived from '../deferred-derived';
import * as database from '../store/database';
import * as migrations from '../store/migrations';
import * as scanner from '../scan/scanner';
import { CodeGraphParserRuntime } from '../parser/runtime';
import type { LoadedCodeGraphGrammar } from '../parser/runtime';
import {
  backfillCodeGraphSummaryProjection,
  clearCodeGraphSummaryProjection,
  readCodeGraphSummaryProjectionFromDatabase,
} from '../summary-projection';

const LIB =
  'export function add(left: number, right: number): number { return left + right; }\n';
const MAIN =
  "import { add } from './lib';\nexport function run(): number { return add(20, 22); }\n";

const BUILD_MARKER_KEYS = [
  'last_build_at',
  'completed_build_at',
  'derived_at',
  'derived_pending',
  'schema_version',
  'extractor_version',
  'custom_languages_fingerprint',
  'custom_languages',
  'imported_from_snapshot',
  'graph_diagnostics',
  'worktree_fingerprint',
];

interface AsyncGate {
  entered: Promise<void>;
  wait: Promise<void>;
  enter(): void;
  release(): void;
}

function createAsyncGate(): AsyncGate {
  let signalEntered: () => void = () => undefined;
  let releaseGate: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  return {
    entered,
    wait,
    enter: signalEntered,
    release: releaseGate,
  };
}

function writeTwoFileGraph(rootPath: string): void {
  mkdirSync(path.join(rootPath, 'src'), { recursive: true });
  writeFileSync(path.join(rootPath, 'src', 'lib.ts'), LIB);
  writeFileSync(path.join(rootPath, 'src', 'main.ts'), MAIN);
}

function readBuildMarkerValues(dbPath: string): Array<string | null> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return BUILD_MARKER_KEYS.map((key) => {
      const row = db
        .prepare('SELECT value FROM graph_metadata WHERE key = ?')
        .get(key);
      return row === undefined ? null : String(row.value);
    });
  } finally {
    db.close();
  }
}

function clearProjectionWithSeparateIdleWriter(dbPath: string): void {
  const writer = database.openCodeGraphDatabase(dbPath);
  try {
    clearCodeGraphSummaryProjection(writer);
  } finally {
    writer.close();
  }
}

function readProjection(
  dbPath: string,
): ReturnType<typeof readCodeGraphSummaryProjectionFromDatabase> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return readCodeGraphSummaryProjectionFromDatabase(db);
  } finally {
    db.close();
  }
}

function expectRepairBusyWithoutSql(engine: CodeGraphEngine): void {
  const prepareSpy = jest.spyOn(DatabaseSync.prototype, 'prepare');
  const execSpy = jest.spyOn(DatabaseSync.prototype, 'exec');
  try {
    expect(engine.repairSummaryProjection()).toEqual({
      state: 'error',
      classification: 'busy',
    });
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
  } finally {
    prepareSpy.mockRestore();
    execSpy.mockRestore();
  }
}

describe('CodeGraphEngine summary projection repair seam', () => {
  let rootPath: string;
  let dbPath: string;
  let engine: CodeGraphEngine;
  let engineClosed: boolean;

  beforeEach(async () => {
    rootPath = mkdtempSync(path.join(tmpdir(), 'code-graph-repair-seam-'));
    writeTwoFileGraph(rootPath);
    dbPath = path.join(rootPath, '.graph', 'graph.db');
    engineClosed = false;
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath }],
      worktreeRootPath: rootPath,
    });

    // Every case starts with a healthy, real two-file graph. The barriers below
    // are installed only after this succeeds, so setup can never be gated.
    const initialBuild = await engine.buildOrUpdate();
    expect(initialBuild.filesParsed).toBe(2);
  });

  afterEach(() => {
    if (!engineClosed) {
      engine.close();
    }
    rmSync(rootPath, { recursive: true, force: true });
  });

  it('repairs a cleared projection through the idle owned writer without reopening, rebuilding, parsing, or changing build markers', () => {
    clearProjectionWithSeparateIdleWriter(dbPath);
    expect(readProjection(dbPath)).toMatchObject({
      state: 'pending',
      reason: 'projection-missing',
    });
    const markersBefore = readBuildMarkerValues(dbPath);

    const engineOpenSpy = jest
      .spyOn(CodeGraphEngine, 'open')
      .mockImplementation(() => {
        throw new Error('repair must not reopen CodeGraphEngine');
      });
    const databaseOpenSpy = jest
      .spyOn(database, 'openCodeGraphDatabase')
      .mockImplementation(() => {
        throw new Error('repair must not open a writer database');
      });
    const migrationsSpy = jest
      .spyOn(migrations, 'runCodeGraphMigrations')
      .mockImplementation(() => {
        throw new Error('repair must not run migrations');
      });
    const runtimeCreateSpy = jest
      .spyOn(CodeGraphParserRuntime, 'create')
      .mockImplementation(() => {
        throw new Error('repair must not create a parser runtime');
      });
    const grammarSpy = jest.spyOn(
      CodeGraphParserRuntime.prototype,
      'getGrammar',
    );
    const buildSpy = jest
      .spyOn(CodeGraphEngine.prototype, 'buildOrUpdate')
      .mockImplementation(() => {
        throw new Error('repair must not build source');
      });

    const sourceScanSpy = jest.spyOn(scanner, 'enumerateSourceFiles');
    const prepareSpy = jest.spyOn(DatabaseSync.prototype, 'prepare');
    const closeSpy = jest.spyOn(DatabaseSync.prototype, 'close');
    let repairedState: string | undefined;
    try {
      // Call-through capture through public query SQL, not private Engine fields.
      expect(
        engine.queries().getSymbolDetail('src/main.ts::run'),
      ).not.toBeNull();
      const ownedWriter: unknown = prepareSpy.mock.contexts[0];
      if (ownedWriter === undefined)
        throw new Error('Expected owned writer query.');
      prepareSpy.mockClear();
      const repaired = engine.repairSummaryProjection();
      repairedState = repaired.state;
      expect(repaired).toMatchObject({ state: 'ready' });
      expect(engineOpenSpy).not.toHaveBeenCalled();
      expect(databaseOpenSpy).not.toHaveBeenCalled();
      expect(migrationsSpy).not.toHaveBeenCalled();
      expect(runtimeCreateSpy).not.toHaveBeenCalled();
      expect(grammarSpy).not.toHaveBeenCalled();
      expect(buildSpy).not.toHaveBeenCalled();
      expect(sourceScanSpy).not.toHaveBeenCalled();
      const writerVerificationIndex = prepareSpy.mock.calls.findIndex(
        ([sql]) => sql === 'PRAGMA database_list',
      );
      expect(writerVerificationIndex).toBeGreaterThanOrEqual(0);
      expect(prepareSpy.mock.contexts[writerVerificationIndex]).toBe(
        ownedWriter,
      );
      expect(closeSpy.mock.contexts).not.toContain(ownedWriter);
    } finally {
      engineOpenSpy.mockRestore();
      databaseOpenSpy.mockRestore();
      migrationsSpy.mockRestore();
      runtimeCreateSpy.mockRestore();
      grammarSpy.mockRestore();
      buildSpy.mockRestore();
      sourceScanSpy.mockRestore();
      prepareSpy.mockRestore();
      closeSpy.mockRestore();
    }

    expect(repairedState).toBe('ready');
    expect(readBuildMarkerValues(dbPath)).toEqual(markersBefore);
    expect(readProjection(dbPath)).toMatchObject({ state: 'ready' });

    // This query is served through the engine's actual constructor-owned
    // writer; a successful repair did not close or replace that connection.
    expect(engine.queries().getSymbolDetail('src/main.ts::run')).not.toBeNull();
  });

  it('returns busy without SQL while a real build is held in parser work, then repairs after it settles', async () => {
    expect(engine.repairSummaryProjection()).toMatchObject({ state: 'ready' });

    const gate = createAsyncGate();
    let held = false;
    const grammarSpy = jest.spyOn(
      CodeGraphParserRuntime.prototype,
      'getGrammar',
    );
    const originalGetGrammar = grammarSpy.getMockImplementation();
    if (originalGetGrammar === undefined) {
      grammarSpy.mockRestore();
      throw new Error('Expected the original grammar implementation.');
    }
    grammarSpy.mockImplementation(async function (
      this: CodeGraphParserRuntime,
      grammarId: string,
    ): Promise<LoadedCodeGraphGrammar> {
      if (!held && grammarId === 'typescript') {
        held = true;
        gate.enter();
        await gate.wait;
      }
      return originalGetGrammar.call(this, grammarId);
    });

    writeFileSync(
      path.join(rootPath, 'src', 'lib.ts'),
      LIB + '\nexport function extra(): number { return add(1, 2); }\n',
    );
    const build = engine.buildOrUpdate();
    try {
      await gate.entered;
      expect(held).toBe(true);
      expect(grammarSpy).toHaveBeenCalled();
      expectRepairBusyWithoutSql(engine);
    } finally {
      gate.release();
      grammarSpy.mockRestore();
      await build;
    }

    expect(engine.repairSummaryProjection()).toMatchObject({ state: 'ready' });
  });

  it('keeps repair busy until every concurrent real deferred-analysis promise settles', async () => {
    const noPendingWork = await engine.completeDeferredDerived();
    expect(noPendingWork.ran).toBe(false);

    writeFileSync(
      path.join(rootPath, 'src', 'main.ts'),
      MAIN + '\nexport function changed(): number { return add(1, 2); }\n',
    );
    const deferredBuild = await engine.buildOrUpdate({ deferDerived: true });
    expect(deferredBuild.derivedDeferred).toBe(true);

    const firstGate = createAsyncGate();
    const secondGate = createAsyncGate();
    const gates = [firstGate, secondGate];
    let callIndex = 0;
    const originalCompute = analysis.computeDerivedForRepo;
    const computeSpy = jest
      .spyOn(analysis, 'computeDerivedForRepo')
      .mockImplementation(async (input) => {
        const gate = gates[callIndex];
        callIndex += 1;
        if (gate !== undefined) {
          gate.enter();
          await gate.wait;
        }
        return originalCompute(input);
      });

    const first = engine.completeDeferredDerived();
    let second:
      | ReturnType<CodeGraphEngine['completeDeferredDerived']>
      | undefined;
    try {
      await firstGate.entered;
      const secondRun = engine.completeDeferredDerived();
      second = secondRun;
      await secondGate.entered;
      expect(computeSpy).toHaveBeenCalledTimes(2);

      // Both independent reached signals fire before either gate is released:
      // the Engine guard is observational, not a new serialization policy.
      expectRepairBusyWithoutSql(engine);

      firstGate.release();
      const firstResult = await first;
      expect(firstResult.ran).toBe(true);

      // Settling one promise must not clear the guard while another remains.
      expectRepairBusyWithoutSql(engine);

      secondGate.release();
      const secondResult = await secondRun;
      expect(secondResult.ran).toBe(true);
    } finally {
      firstGate.release();
      secondGate.release();
      computeSpy.mockRestore();
      await first;
      if (second !== undefined) {
        await second;
      }
    }

    expect(engine.repairSummaryProjection()).toMatchObject({ state: 'ready' });
  });

  it('refuses direct backfill before any SQL while its supplied writer is inside the real transaction wrapper', () => {
    const writer = database.openCodeGraphDatabase(dbPath);
    const prepareSpy = jest.spyOn(DatabaseSync.prototype, 'prepare');
    const execSpy = jest.spyOn(DatabaseSync.prototype, 'exec');
    try {
      const result = database.withImmediateTransaction(writer, () => {
        expect(database.hasActiveCodeGraphWriteTransaction(writer)).toBe(true);
        const prepareCountBefore = prepareSpy.mock.calls.length;
        const execCountBefore = execSpy.mock.calls.length;

        const backfill = backfillCodeGraphSummaryProjection(dbPath, {
          db: writer,
        });
        expect(backfill).toEqual({
          state: 'error',
          classification: 'busy',
        });
        expect(prepareSpy).toHaveBeenCalledTimes(prepareCountBefore);
        expect(execSpy).toHaveBeenCalledTimes(execCountBefore);
        return backfill;
      });

      expect(result).toEqual({
        state: 'error',
        classification: 'busy',
      });
      expect(database.hasActiveCodeGraphWriteTransaction(writer)).toBe(false);
      expect(
        backfillCodeGraphSummaryProjection(dbPath, { db: writer }),
      ).toMatchObject({
        state: 'ready',
      });
    } finally {
      prepareSpy.mockRestore();
      execSpy.mockRestore();
      writer.close();
    }
  });

  it('refuses repair while the actual owned writer is inside an immediate transaction', () => {
    const prepareSpy = jest.spyOn(DatabaseSync.prototype, 'prepare');
    let ownedWriter: unknown;
    try {
      expect(
        engine.queries().getSymbolDetail('src/main.ts::run'),
      ).not.toBeNull();
      ownedWriter = prepareSpy.mock.contexts[0];
    } finally {
      prepareSpy.mockRestore();
    }
    if (!(ownedWriter instanceof DatabaseSync))
      throw new Error('Expected a public-query writer.');
    const writer = ownedWriter;
    expect(database.hasActiveCodeGraphWriteTransaction(writer)).toBe(false);
    database.withImmediateTransaction(writer, () => {
      expect(database.hasActiveCodeGraphWriteTransaction(writer)).toBe(true);
      expectRepairBusyWithoutSql(engine);
    });
    expect(database.hasActiveCodeGraphWriteTransaction(ownedWriter)).toBe(
      false,
    );
    expect(engine.repairSummaryProjection()).toMatchObject({ state: 'ready' });
  });

  it('preserves deferred rejection semantics and releases the repair guard after throwing and no-op completion', async () => {
    const failure = new Error('injected deferred-analysis failure');
    const completionSpy = jest
      .spyOn(deferredDerived, 'completeDeferredCodeGraphDerived')
      .mockRejectedValueOnce(failure);
    try {
      await expect(engine.completeDeferredDerived()).rejects.toThrow(
        'injected deferred-analysis failure',
      );
    } finally {
      completionSpy.mockRestore();
    }

    const noPendingPromise = engine.completeDeferredDerived();
    // Even an immediately resolved no-op remains outstanding until awaited.
    expectRepairBusyWithoutSql(engine);
    const noPendingWork = await noPendingPromise;
    expect(noPendingWork.ran).toBe(false);
    expect(engine.repairSummaryProjection()).toMatchObject({ state: 'ready' });
  });

  it('returns io without touching the closed writer', () => {
    engineClosed = true;
    engine.close();

    const prepareSpy = jest.spyOn(DatabaseSync.prototype, 'prepare');
    const execSpy = jest.spyOn(DatabaseSync.prototype, 'exec');
    try {
      expect(engine.repairSummaryProjection()).toEqual({
        state: 'error',
        classification: 'io',
      });
      expect(prepareSpy).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      prepareSpy.mockRestore();
      execSpy.mockRestore();
    }
  });
});
