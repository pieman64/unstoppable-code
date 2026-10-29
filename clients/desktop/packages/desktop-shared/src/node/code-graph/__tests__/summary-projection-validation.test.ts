// PRIVATE UNRUN DRAFT. Apply only after the private implementation is adopted.
// These tests intentionally build real generated graphs through CodeGraphEngine;
// they do not depend on an incident database or hand-authored schema fixture.
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
} from '../../../types/code-graph';
import { CodeGraphEngine } from '../engine';
import {
  readCodeGraphSummaryProjection,
  readReadonlyCodeGraphSummaryProjectionAssembly,
} from '../base-graph';
import {
  backfillCodeGraphSummaryProjection,
  clearCodeGraphSummaryProjection,
  codeGraphSummaryProjectionV1Schema,
  parseCodeGraphImportedTimestamp,
  publishCodeGraphSummaryProjection,
  type CodeGraphSummaryProjectionV1,
} from '../summary-projection';
import {
  getMetadataValue,
  openCodeGraphDatabase,
  requireRow,
  requireString,
  setMetadataValue,
  withImmediateTransaction,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';

const REPO_ID = 'summary-validation-fixture';
const FRESHNESS_KEYS = [
  'last_build_at',
  'completed_build_at',
  'derived_at',
  'imported_from_snapshot',
  'derived_pending',
] as const;

let root: string;
let sourceRoot: string;
let dbPath: string;

async function buildGeneratedGraph(targetDbPath: string): Promise<void> {
  const engine = await CodeGraphEngine.open({
    dbPath: targetDbPath,
    repositories: [{ repoId: REPO_ID, rootPath: sourceRoot }],
    worktreeRootPath: sourceRoot,
  });
  try {
    await engine.buildOrUpdate();
  } finally {
    engine.close();
  }
}

function withGraphWriter<T>(operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function mutateGraph(operation: (db: DatabaseSync) => void): void {
  withGraphWriter((db) => {
    withImmediateTransaction(db, () => operation(db));
  });
}

function readyProjection(): CodeGraphSummaryProjectionV1 {
  const result = readCodeGraphSummaryProjection(dbPath);
  if (result.state !== 'ready') {
    throw new Error(
      `Expected a generated summary projection, got ${result.state}.`,
    );
  }
  return result.projection;
}

function storeProjection(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Expected a serializable projection test value.');
  }
  mutateGraph((db) =>
    setMetadataValue(db, 'summary_projection_v1', serialized),
  );
}

function clearProjection(db: DatabaseSync): void {
  withImmediateTransaction(db, () => clearCodeGraphSummaryProjection(db));
}

function freshnessMetadata(db: DatabaseSync): Array<string | null> {
  return FRESHNESS_KEYS.map((key) => getMetadataValue(db, key));
}

function expectPending(
  result: ReturnType<typeof readCodeGraphSummaryProjection>,
  reason: 'projection-invalid' | 'projection-mismatch',
): void {
  expect(result).toMatchObject({ state: 'pending', reason });
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'summary-projection-validation-'));
  sourceRoot = path.join(root, 'repo');
  mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  writeFileSync(
    path.join(sourceRoot, 'src', 'first.ts'),
    'export function first(): number { return 1; }\n',
  );
  writeFileSync(
    path.join(sourceRoot, 'src', 'second.ts'),
    'export const second = 2;\n',
  );
  dbPath = path.join(root, '.canopy', 'code-graph', 'graph.db');
  await buildGeneratedGraph(dbPath);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('summary projection V1 validation', () => {
  it('accepts generated safe totals and rejects inconsistent or unsafe totals', () => {
    const projection = readyProjection();
    expect(
      codeGraphSummaryProjectionV1Schema.safeParse(projection).success,
    ).toBe(true);
    expect(projection.totals.fileCount).toBe(
      projection.repositories.reduce(
        (total, repository) => total + repository.counts.fileCount,
        0,
      ),
    );

    storeProjection({
      ...projection,
      totals: {
        ...projection.totals,
        fileCount: projection.totals.fileCount + 1,
      },
    });
    expectPending(readCodeGraphSummaryProjection(dbPath), 'projection-invalid');

    storeProjection({
      ...projection,
      repositories: projection.repositories.map((repository, index) =>
        index === 0
          ? {
              ...repository,
              counts: {
                ...repository.counts,
                fileCount: Number.MAX_SAFE_INTEGER + 1,
              },
            }
          : repository,
      ),
    });
    expectPending(readCodeGraphSummaryProjection(dbPath), 'projection-invalid');
  });

  it('rejects aggregate overflow even when every individual count is a safe integer', () => {
    const projection = readyProjection();
    const repository = projection.repositories[0];
    if (repository === undefined)
      throw new Error('Expected generated repository.');
    const overflowing = {
      ...projection,
      repositories: [
        {
          ...repository,
          counts: { ...repository.counts, fileCount: Number.MAX_SAFE_INTEGER },
        },
        {
          repoId: 'overflow-extra',
          gitHead: null,
          counts: {
            fileCount: 1,
            symbolCount: 0,
            edgeCount: 0,
            contextUnresolvedEdgeCount: 0,
            contextFilesWithErrors: 0,
            legacyUnresolvedEdgeCount: 0,
            legacyFilesWithErrors: 0,
            communityCount: 0,
            flowCount: 0,
          },
        },
      ],
      totals: { ...projection.totals, fileCount: Number.MAX_SAFE_INTEGER },
    };
    expect(
      codeGraphSummaryProjectionV1Schema.safeParse(overflowing).success,
    ).toBe(false);
  });

  it('rejects top-community order that violates SQLite BINARY ranking', () => {
    const projection = readyProjection();
    storeProjection({
      ...projection,
      topCommunities: [
        {
          id: 'z-community',
          repoId: REPO_ID,
          label: 'z',
          size: 5,
          cohesion: 0.5,
        },
        {
          id: 'a-community',
          repoId: REPO_ID,
          label: 'a',
          size: 5,
          cohesion: 0.5,
        },
      ],
    });
    expectPending(readCodeGraphSummaryProjection(dbPath), 'projection-invalid');
  });

  it('rejects unknown V1 properties rather than accepting an extended shape', () => {
    const projection = readyProjection();
    storeProjection({ ...projection, unrecognized: 'must remain strict' });
    expectPending(readCodeGraphSummaryProjection(dbPath), 'projection-invalid');
  });

  it('bounds the stored UTF-8 payload before attempting JSON.parse', () => {
    const oversized = 'x'.repeat(1_048_577);
    mutateGraph((db) =>
      setMetadataValue(db, 'summary_projection_v1', oversized),
    );
    const parseSpy = jest.spyOn(JSON, 'parse');
    try {
      expectPending(
        readCodeGraphSummaryProjection(dbPath),
        'projection-invalid',
      );
      expect(parseSpy.mock.calls.some(([input]) => input === oversized)).toBe(
        false,
      );
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('accepts the exact persisted 1MiB bound and rejects its next byte', () => {
    const serialized = JSON.stringify(readyProjection());
    const remainingBytes = 1_048_576 - Buffer.byteLength(serialized, 'utf8');
    expect(remainingBytes).toBeGreaterThan(0);
    const atBound = serialized + ' '.repeat(remainingBytes);
    expect(Buffer.byteLength(atBound, 'utf8')).toBe(1_048_576);
    mutateGraph((db) => setMetadataValue(db, 'summary_projection_v1', atBound));
    expect(readCodeGraphSummaryProjection(dbPath).state).toBe('ready');
    mutateGraph((db) =>
      setMetadataValue(db, 'summary_projection_v1', atBound + ' '),
    );
    expectPending(readCodeGraphSummaryProjection(dbPath), 'projection-invalid');
  });

  it('bounds schema bytes and rejects a multibyte overflow before parsing', () => {
    const projection = readyProjection();
    const empty = {
      fileCount: 0,
      symbolCount: 0,
      edgeCount: 0,
      contextUnresolvedEdgeCount: 0,
      contextFilesWithErrors: 0,
      legacyUnresolvedEdgeCount: 0,
      legacyFilesWithErrors: 0,
      communityCount: 0,
      flowCount: 0,
    };
    // Identical valid shape/counts and bounded id character lengths: only the
    // UTF8 byte cost of the padding changes. The positive control rules out
    // rejecting either candidate for totals, attribution, array or field bounds.
    const paddedCandidate = (
      character: string,
    ): CodeGraphSummaryProjectionV1 => ({
      ...projection,
      repositories: [
        ...projection.repositories,
        ...Array.from({ length: 1200 }, (_, index) => ({
          repoId: `padding-${String(index).padStart(4, '0')}-${character.repeat(350)}`,
          gitHead: null,
          counts: empty,
        })),
      ],
    });
    const underBound = paddedCandidate('x');
    const underBoundJson = JSON.stringify(underBound);
    expect(Buffer.byteLength(underBoundJson, 'utf8')).toBeLessThan(1_048_576);
    expect(
      codeGraphSummaryProjectionV1Schema.safeParse(underBound).success,
    ).toBe(true);
    const overBound = paddedCandidate('é');
    const multiByte = JSON.stringify(overBound);
    expect(multiByte.length).toBe(underBoundJson.length);
    expect(multiByte.length).toBeLessThan(1_048_576);
    expect(Buffer.byteLength(multiByte, 'utf8')).toBeGreaterThan(1_048_576);
    expect(
      codeGraphSummaryProjectionV1Schema.safeParse(overBound).success,
    ).toBe(false);
    mutateGraph((db) =>
      setMetadataValue(db, 'summary_projection_v1', multiByte),
    );
    const parseSpy = jest.spyOn(JSON, 'parse');
    try {
      expectPending(
        readCodeGraphSummaryProjection(dbPath),
        'projection-invalid',
      );
      expect(parseSpy.mock.calls.some(([input]) => input === multiByte)).toBe(
        false,
      );
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('reports schema/extractor and revision drift as projection mismatch', () => {
    const projection = readyProjection();
    storeProjection({
      ...projection,
      schemaVersion: projection.schemaVersion + 1,
    });
    expectPending(
      readCodeGraphSummaryProjection(dbPath),
      'projection-mismatch',
    );

    storeProjection({
      ...projection,
      extractorVersion: projection.extractorVersion + 1,
    });
    expectPending(
      readCodeGraphSummaryProjection(dbPath),
      'projection-mismatch',
    );

    storeProjection({
      ...projection,
      projectionRevision: projection.projectionRevision + 1,
    });
    expectPending(
      readCodeGraphSummaryProjection(dbPath),
      'projection-mismatch',
    );
  });

  it('retains a malformed revision counter when publication clears an invalid projection', () => {
    mutateGraph((db) =>
      setMetadataValue(db, 'summary_projection_revision', '01'),
    );
    expect(readCodeGraphSummaryProjection(dbPath)).toMatchObject({
      state: 'pending',
      reason: 'projection-mismatch',
      observed: { projectionRevision: null },
    });

    withGraphWriter((db) => {
      withImmediateTransaction(db, () => {
        expect(
          publishCodeGraphSummaryProjection(db, {
            worktreeRootPath: sourceRoot,
          }),
        ).toBeNull();
      });
      expect(getMetadataValue(db, 'summary_projection_revision')).toBe('01');
    });
  });

  it('retains an exhausted revision without wrapping or publishing a lower revision', () => {
    mutateGraph((db) => {
      setMetadataValue(
        db,
        'summary_projection_revision',
        String(Number.MAX_SAFE_INTEGER),
      );
      expect(publishCodeGraphSummaryProjection(db)).toBeNull();
    });
    withGraphWriter((db) => {
      expect(getMetadataValue(db, 'summary_projection_revision')).toBe(
        String(Number.MAX_SAFE_INTEGER),
      );
      expect(getMetadataValue(db, 'summary_projection_v1')).toBeNull();
    });
    expect(readCodeGraphSummaryProjection(dbPath)).toMatchObject({
      state: 'pending',
      reason: 'projection-missing',
      observed: { projectionRevision: Number.MAX_SAFE_INTEGER },
    });
  });

  it('keeps context and legacy unresolved/error counts distinct', () => {
    const baseline = readyProjection();
    const baselineRepository = baseline.repositories.find(
      (repository) => repository.repoId === REPO_ID,
    );
    if (baselineRepository === undefined) {
      throw new Error(
        'Expected the generated graph repository in its projection.',
      );
    }

    mutateGraph((db) => {
      const repository = requireRow(
        db
          .prepare('SELECT id FROM repositories WHERE repo_id = ?')
          .get(REPO_ID),
      );
      const repositoryId = requireString(repository, 'id');
      const fileIds = db
        .prepare(
          'SELECT id FROM files WHERE repository_id = ? ORDER BY relative_path',
        )
        .all(repositoryId)
        .map((value) => requireString(requireRow(value), 'id'));
      const firstFileId = fileIds[0];
      const secondFileId = fileIds[1];
      if (firstFileId === undefined || secondFileId === undefined) {
        throw new Error('Expected two files from the generated graph fixture.');
      }

      db.prepare('UPDATE files SET has_errors = 0 WHERE repository_id = ?').run(
        repositoryId,
      );
      db.prepare('UPDATE files SET has_errors = ? WHERE id = ?').run(
        1,
        firstFileId,
      );
      db.prepare('UPDATE files SET has_errors = ? WHERE id = ?').run(
        2,
        secondFileId,
      );
      const insertEdge = db.prepare(
        `INSERT INTO edges (
          id, repository_id, kind, source_symbol_id, target_symbol_id,
          source_file_id, target_ref, line, confidence_tier,
          confidence_score, resolver_id, evidence_json
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, 1, 'EXTRACTED', 1, NULL, '{}')`,
      );
      insertEdge.run(
        'context-unresolved',
        repositoryId,
        'CALLS',
        null,
        firstFileId,
        'missing-call',
      );
      insertEdge.run(
        'legacy-only-unresolved',
        repositoryId,
        'CONTAINS',
        null,
        firstFileId,
        'missing-containment',
      );
      expect(
        publishCodeGraphSummaryProjection(db, { worktreeRootPath: sourceRoot }),
      ).not.toBeNull();
    });

    const result = readCodeGraphSummaryProjection(dbPath);
    if (result.state !== 'ready') {
      throw new Error(
        'Expected the mutated generated graph projection to be ready.',
      );
    }
    const countsMatcher: unknown = expect.objectContaining({
      edgeCount: baselineRepository.counts.edgeCount + 2,
      contextUnresolvedEdgeCount:
        baselineRepository.counts.contextUnresolvedEdgeCount + 1,
      legacyUnresolvedEdgeCount:
        baselineRepository.counts.legacyUnresolvedEdgeCount + 2,
      contextFilesWithErrors: 1,
      legacyFilesWithErrors: 2,
    });
    expect(result.projection.repositories).toEqual([
      expect.objectContaining({
        repoId: REPO_ID,
        counts: countsMatcher,
      }),
    ]);
  });
});

describe('readonly projection transaction boundary', () => {
  it('commits and closes after a metadata-only read without facts, migrations, quick_check, or writes', () => {
    const prepareSpy = jest.spyOn(DatabaseSync.prototype, 'prepare');
    const execSpy = jest.spyOn(DatabaseSync.prototype, 'exec');
    const closeSpy = jest.spyOn(DatabaseSync.prototype, 'close');
    try {
      expect(readCodeGraphSummaryProjection(dbPath).state).toBe('ready');

      const statements = prepareSpy.mock.calls.map(([sql]) => sql);
      const execStatements = execSpy.mock.calls.map(([sql]) => sql);
      const allSql = [...statements, ...execStatements];
      expect(execStatements).toEqual(['BEGIN;', 'COMMIT;']);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(allSql.some((sql) => /PRAGMA\s+quick_check/i.test(sql))).toBe(
        false,
      );
      expect(allSql.some((sql) => /sqlite_master/i.test(sql))).toBe(false);
      expect(
        allSql.some((sql) =>
          /\b(?:FROM|JOIN)\s+(?:repositories|files|symbols|edges|communities|flows)\b/i.test(
            sql,
          ),
        ),
      ).toBe(false);
      expect(
        allSql.some((sql) =>
          /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM)\b/i.test(
            sql,
          ),
        ),
      ).toBe(false);
    } finally {
      prepareSpy.mockRestore();
      execSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('ends and closes a pending read without placeholder metrics or writes', () => {
    mutateGraph((db) => clearCodeGraphSummaryProjection(db));
    const execSpy = jest.spyOn(DatabaseSync.prototype, 'exec');
    const closeSpy = jest.spyOn(DatabaseSync.prototype, 'close');
    try {
      const result = readCodeGraphSummaryProjection(dbPath);
      expect(result).toMatchObject({
        state: 'pending',
        reason: 'projection-missing',
      });
      expect(result).not.toHaveProperty('projection');
      expect(result).not.toHaveProperty('totals');
      expect(execSpy.mock.calls.map(([sql]) => sql)).toEqual([
        'BEGIN;',
        'COMMIT;',
      ]);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      execSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('rolls back and closes when the committed read transaction cannot commit', () => {
    const execStatements: string[] = [];
    const execSpy = jest.spyOn(DatabaseSync.prototype, 'exec');
    const originalExec = execSpy.getMockImplementation();
    if (originalExec === undefined) {
      execSpy.mockRestore();
      throw new Error('Expected the original database exec implementation.');
    }
    execSpy.mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ): void {
      execStatements.push(sql);
      if (sql === 'COMMIT;') {
        throw new Error('controlled read commit failure');
      }
      return originalExec.call(this, sql);
    });
    const closeSpy = jest.spyOn(DatabaseSync.prototype, 'close');
    try {
      expect(readCodeGraphSummaryProjection(dbPath)).toEqual({
        state: 'error',
        classification: 'io',
      });
      expect(execStatements).toEqual(['BEGIN;', 'COMMIT;', 'ROLLBACK;']);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      execSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });
});

describe('summary projection backfill CAS', () => {
  it('commits and closes its readonly count view before writer CAS and does not change freshness markers', () => {
    const writer = new DatabaseSync(dbPath);
    clearProjection(writer);
    const revisionBefore = getMetadataValue(
      writer,
      'summary_projection_revision',
    );
    const freshnessBefore = freshnessMetadata(writer);
    const events: Array<
      | { kind: 'exec'; connection: 'reader' | 'writer'; sql: string }
      | { kind: 'close'; connection: 'reader' | 'writer' }
    > = [];
    const execSpy = jest.spyOn(DatabaseSync.prototype, 'exec');
    const originalExec = execSpy.getMockImplementation();
    if (originalExec === undefined) {
      execSpy.mockRestore();
      writer.close();
      throw new Error('Expected the original database exec implementation.');
    }
    execSpy.mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ): void {
      events.push({
        kind: 'exec',
        connection: this === writer ? 'writer' : 'reader',
        sql,
      });
      return originalExec.call(this, sql);
    });
    let writerWasClosedByBackfill = false;
    const closeSpy = jest.spyOn(DatabaseSync.prototype, 'close');
    const originalClose = closeSpy.getMockImplementation();
    if (originalClose === undefined) {
      closeSpy.mockRestore();
      execSpy.mockRestore();
      writer.close();
      throw new Error('Expected the original database close implementation.');
    }
    closeSpy.mockImplementation(function (this: DatabaseSync): void {
      events.push({
        kind: 'close',
        connection: this === writer ? 'writer' : 'reader',
      });
      if (this === writer) writerWasClosedByBackfill = true;
      return originalClose.call(this);
    });

    try {
      const result = backfillCodeGraphSummaryProjection(dbPath, {
        db: writer,
        worktreeRootPath: sourceRoot,
      });
      if (result.state !== 'ready') {
        throw new Error(
          `Expected a backfilled projection, got ${result.state}.`,
        );
      }
      const readerCommitIndex = events.findIndex(
        (event) =>
          event.kind === 'exec' &&
          event.connection === 'reader' &&
          event.sql === 'COMMIT;',
      );
      const readerCloseIndex = events.findIndex(
        (event) => event.kind === 'close' && event.connection === 'reader',
      );
      const writerBeginIndex = events.findIndex(
        (event) =>
          event.kind === 'exec' &&
          event.connection === 'writer' &&
          event.sql === 'BEGIN IMMEDIATE;',
      );
      expect(readerCommitIndex).toBeGreaterThanOrEqual(0);
      expect(readerCloseIndex).toBeGreaterThan(readerCommitIndex);
      expect(writerBeginIndex).toBeGreaterThan(readerCloseIndex);
      expect(writerWasClosedByBackfill).toBe(false);
      expect(result.projection.projectionRevision).toBe(
        revisionBefore === null ? 1 : Number(revisionBefore) + 1,
      );
      expect(freshnessMetadata(writer)).toEqual(freshnessBefore);
      expect(getMetadataValue(writer, 'summary_projection_v1')).not.toBeNull();
    } finally {
      execSpy.mockRestore();
      closeSpy.mockRestore();
      writer.close();
    }
  });

  it('returns superseded when raw metadata changes between the committed read and writer CAS', () => {
    const writer = new DatabaseSync(dbPath);
    clearProjection(writer);
    const revisionBefore = getMetadataValue(
      writer,
      'summary_projection_revision',
    );
    let changedBetweenReadAndCas = false;
    const execSpy = jest.spyOn(DatabaseSync.prototype, 'exec');
    const originalExec = execSpy.getMockImplementation();
    if (originalExec === undefined) {
      execSpy.mockRestore();
      writer.close();
      throw new Error('Expected the original database exec implementation.');
    }
    execSpy.mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ): void {
      if (
        !changedBetweenReadAndCas &&
        this === writer &&
        sql === 'BEGIN IMMEDIATE;'
      ) {
        changedBetweenReadAndCas = true;
        setMetadataValue(writer, 'last_build_at', '987654321');
      }
      return originalExec.call(this, sql);
    });
    try {
      expect(
        backfillCodeGraphSummaryProjection(dbPath, {
          db: writer,
          worktreeRootPath: sourceRoot,
        }),
      ).toEqual({ state: 'superseded' });
      expect(changedBetweenReadAndCas).toBe(true);
      expect(getMetadataValue(writer, 'last_build_at')).toBe('987654321');
      expect(getMetadataValue(writer, 'summary_projection_v1')).toBeNull();
      expect(getMetadataValue(writer, 'summary_projection_revision')).toBe(
        revisionBefore,
      );
    } finally {
      execSpy.mockRestore();
      writer.close();
    }
  });

  it('rejects a writer connected to a different graph without publishing to either database', async () => {
    const wrongDbPath = path.join(root, 'wrong-writer', 'graph.db');
    await buildGeneratedGraph(wrongDbPath);
    withGraphWriter((db) => clearProjection(db));
    const targetRevisionBefore = withGraphWriter((db) =>
      getMetadataValue(db, 'summary_projection_revision'),
    );
    const wrongWriter = new DatabaseSync(wrongDbPath);
    const wrongRevisionBefore = getMetadataValue(
      wrongWriter,
      'summary_projection_revision',
    );
    const wrongProjectionBefore = getMetadataValue(
      wrongWriter,
      'summary_projection_v1',
    );
    try {
      expect(
        backfillCodeGraphSummaryProjection(dbPath, {
          db: wrongWriter,
          worktreeRootPath: sourceRoot,
        }),
      ).toEqual({ state: 'error', classification: 'io' });
      expect(
        withGraphWriter((db) => getMetadataValue(db, 'summary_projection_v1')),
      ).toBeNull();
      expect(
        withGraphWriter((db) =>
          getMetadataValue(db, 'summary_projection_revision'),
        ),
      ).toBe(targetRevisionBefore);
      expect(getMetadataValue(wrongWriter, 'summary_projection_revision')).toBe(
        wrongRevisionBefore,
      );
      expect(getMetadataValue(wrongWriter, 'summary_projection_v1')).toBe(
        wrongProjectionBefore,
      );
    } finally {
      wrongWriter.close();
    }
  });

  it('rejects immutable generation paths through either side of a symlink', async () => {
    const immutableDbPath = path.join(
      root,
      'published',
      'generations',
      'generation-immutable',
      'graph.db',
    );
    await buildGeneratedGraph(immutableDbPath);
    const outsideAlias = path.join(root, 'immutable-alias.db');
    symlinkSync(immutableDbPath, outsideAlias);
    const immutableWriter = new DatabaseSync(immutableDbPath);
    try {
      expect(
        backfillCodeGraphSummaryProjection(outsideAlias, {
          db: immutableWriter,
          worktreeRootPath: sourceRoot,
        }),
      ).toMatchObject({
        state: 'error',
        classification: 'unsupported-schema',
        reason: 'immutable-published-base',
      });
    } finally {
      immutableWriter.close();
    }

    const disguisedMutablePath = path.join(
      root,
      'generations',
      'generation-symlink',
      'graph.db',
    );
    mkdirSync(path.dirname(disguisedMutablePath), { recursive: true });
    symlinkSync(dbPath, disguisedMutablePath);
    const mutableWriter = new DatabaseSync(dbPath);
    try {
      expect(
        backfillCodeGraphSummaryProjection(disguisedMutablePath, {
          db: mutableWriter,
          worktreeRootPath: sourceRoot,
        }),
      ).toMatchObject({
        state: 'error',
        classification: 'unsupported-schema',
        reason: 'immutable-published-base',
      });
    } finally {
      mutableWriter.close();
    }
  });
});

describe('migrated graph without a committed build or seed', () => {
  let unbuiltDbPath: string;

  function setExtractorVersion(value: string): void {
    const db = new DatabaseSync(unbuiltDbPath);
    try {
      withImmediateTransaction(db, () =>
        setMetadataValue(db, 'extractor_version', value),
      );
    } finally {
      db.close();
    }
  }

  beforeEach(() => {
    // Opening a graph commits its schema version; only a build or seed
    // commits the extractor version.
    unbuiltDbPath = path.join(root, 'unbuilt', 'graph.db');
    mkdirSync(path.dirname(unbuiltDbPath), { recursive: true });
    const db = openCodeGraphDatabase(unbuiltDbPath);
    try {
      runCodeGraphMigrations(db);
    } finally {
      db.close();
    }
  });

  it('reads as a pending incomplete build, not an unsupported schema', () => {
    const pending = {
      state: 'pending',
      reason: 'build-incomplete',
      observed: {
        schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
        extractorVersion: null,
        projectionRevision: null,
        lastBuildAt: null,
        completedBuildAt: null,
        derivedAt: null,
      },
      diagnostics: null,
    };
    expect(readCodeGraphSummaryProjection(unbuiltDbPath)).toEqual(pending);
    expect(
      readReadonlyCodeGraphSummaryProjectionAssembly(unbuiltDbPath),
    ).toEqual(pending);
  });

  it('does not count facts for the readonly assembly of an incomplete build', () => {
    const prepareSpy = jest.spyOn(DatabaseSync.prototype, 'prepare');
    try {
      readReadonlyCodeGraphSummaryProjectionAssembly(unbuiltDbPath);
      expect(
        prepareSpy.mock.calls.some(([sql]) =>
          /\b(?:FROM|JOIN)\s+(?:repositories|files|symbols|edges|communities|flows)\b/i.test(
            sql,
          ),
        ),
      ).toBe(false);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('becomes ready once a build commits', async () => {
    expect(readCodeGraphSummaryProjection(unbuiltDbPath)).toMatchObject({
      state: 'pending',
      reason: 'build-incomplete',
    });
    await buildGeneratedGraph(unbuiltDbPath);
    const recovered = readCodeGraphSummaryProjection(unbuiltDbPath);
    if (recovered.state !== 'ready') {
      throw new Error(`Expected a ready projection, got ${recovered.state}.`);
    }
    expect(recovered.projection.extractorVersion).toBe(
      CODE_GRAPH_EXTRACTOR_VERSION,
    );
    expect(recovered.projection.totals.fileCount).toBe(2);
  });

  it('still refuses to backfill a projection until a build or seed commits', () => {
    const writer = new DatabaseSync(unbuiltDbPath);
    try {
      expect(
        backfillCodeGraphSummaryProjection(unbuiltDbPath, {
          db: writer,
          worktreeRootPath: sourceRoot,
        }),
      ).toEqual({ state: 'error', classification: 'unsupported-schema' });
      expect(getMetadataValue(writer, 'summary_projection_v1')).toBeNull();
    } finally {
      writer.close();
    }
  });

  it.each([
    ['a malformed', 'not-a-version'],
    ['a zero', '0'],
    ['a newer', String(CODE_GRAPH_EXTRACTOR_VERSION + 1)],
  ])('keeps %s extractor version unsupported', (_label, value) => {
    setExtractorVersion(value);
    const unsupported = {
      state: 'error',
      classification: 'unsupported-schema',
    };
    expect(readCodeGraphSummaryProjection(unbuiltDbPath)).toEqual(unsupported);
    expect(
      readReadonlyCodeGraphSummaryProjectionAssembly(unbuiltDbPath),
    ).toEqual(unsupported);
  });
});

describe('imported build timestamp parser', () => {
  it.each([
    {
      raw: '2026-10-08T12:34:56Z',
      expected: Date.parse('2026-10-08T12:34:56Z'),
    },
    {
      raw: '2026-10-08T12:34:56.1Z',
      expected: Date.parse('2026-10-08T12:34:56.1Z'),
    },
    {
      raw: '2026-10-08T12:34:56.123Z',
      expected: Date.parse('2026-10-08T12:34:56.123Z'),
    },
  ])('accepts canonical UTC timestamp $raw', ({ raw, expected }) => {
    expect(parseCodeGraphImportedTimestamp(raw)).toBe(expected);
  });

  it.each([
    '1',
    '10/08/2026',
    '2026-10-08T12:34:56+00:00',
    '2026-02-30T12:34:56Z',
    '2026-10-08T12:34:56.1234Z',
    '2026-10-08T12:34Z',
    '2026-10-08T12:34:56z',
    `2026-10-08T12:34:56Z${' '.repeat(110)}`,
  ])('rejects noncanonical imported timestamp %s', (raw) => {
    expect(parseCodeGraphImportedTimestamp(raw)).toBeNull();
  });
});
