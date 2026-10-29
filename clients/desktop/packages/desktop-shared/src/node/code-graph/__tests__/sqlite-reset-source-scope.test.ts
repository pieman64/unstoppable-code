import type {
  CodeGraphDatabase,
  CodeGraphSqlValue,
  CodeGraphStatement,
} from '../store/database';
import {
  ResolutionResetSourceScopeOverflowError,
  RESET_SOURCE_SCOPE_INSERT_BATCH_SIZE,
  SqliteResetSourceScope,
  sqliteResolutionResetSqlPredicates,
} from '../resolve/sqlite-reset-source-scope';

class RecordingDatabase implements CodeGraphDatabase {
  public readonly executions: string[] = [];
  public readonly statements: string[] = [];
  public readonly insertedIds: string[] = [];

  public exec(sql: string): void {
    this.executions.push(sql);
  }

  public prepare(sql: string): CodeGraphStatement {
    this.statements.push(sql);
    return {
      all: (..._params: CodeGraphSqlValue[]): unknown[] => {
        void _params;
        return [];
      },
      get: (..._params: CodeGraphSqlValue[]): unknown => {
        void _params;
        return undefined;
      },
      run: (...params: CodeGraphSqlValue[]): { changes: number } => {
        const sourceFileId = params[0];
        if (typeof sourceFileId === 'string')
          this.insertedIds.push(sourceFileId);
        return { changes: 1 };
      },
    };
  }

  public close(): void {}
}

describe('SQLite scoped reset-source membership', () => {
  it('installs a sorted source-ID TEMP table and emits fixed-alias predicates', () => {
    const db = new RecordingDatabase();
    const scope = new SqliteResetSourceScope(db, {
      resetSourceFileIds: ['source-z', 'source-a', 'source-z'],
    });
    scope.install();

    expect(scope.isWholeGraph).toBe(false);
    expect(scope.sourceFileIds).toEqual(['source-a', 'source-z']);
    expect(db.insertedIds).toEqual(['source-a', 'source-z']);
    expect(scope.includes('source-a')).toBe(true);
    expect(scope.includes('unselected')).toBe(false);
    expect(scope.predicate('e')).toContain(
      'reset_scope.source_file_id = e.source_file_id',
    );
    const predicates = sqliteResolutionResetSqlPredicates(scope);
    expect(predicates.resetEvidence).toContain('evidence_json');
    expect(predicates.resetEvidence).toContain(
      'reset_scope.source_file_id = e.source_file_id',
    );
    expect(predicates.resetOrDangling).toContain(predicates.resetEvidence);
    expect(predicates.keepBaseEdge).toContain('test-linker');
    expect(predicates.keepBaseEdge).toContain(
      'reset_scope.source_file_id = e.source_file_id',
    );
    scope.close();
    expect(db.executions[db.executions.length - 1]).toContain(
      'DROP TABLE IF EXISTS',
    );
  });

  it('distinguishes no-reset empty scope from the independent full-reset default', () => {
    const emptyDb = new RecordingDatabase();
    const empty = new SqliteResetSourceScope(emptyDb, {
      resetSourceFileIds: [],
    });
    empty.install();
    expect(empty.isWholeGraph).toBe(false);
    expect(empty.selectedCount).toBe(0);
    expect(empty.includes('any-file')).toBe(false);
    expect(emptyDb.insertedIds).toEqual([]);
    const emptyPredicates = sqliteResolutionResetSqlPredicates(empty);
    expect(empty.predicate('e')).toContain('EXISTS');
    expect(emptyPredicates.resetEvidence).toContain('EXISTS');
    expect(emptyPredicates.keepBaseEdge).toContain('NOT (EXISTS');

    const fullDb = new RecordingDatabase();
    const full = new SqliteResetSourceScope(fullDb, {});
    full.install();
    expect(full.isWholeGraph).toBe(true);
    expect(full.sourceFileIds).toBeUndefined();
    expect(full.predicate('e')).toBe('1 = 1');
    expect(sqliteResolutionResetSqlPredicates(full)).toEqual({
      resetEvidence:
        "(1 = 1 AND (e.resolver_id IS NOT NULL OR json_type(e.evidence_json, '$.candidates') IS NOT NULL))",
      resetOrDangling:
        "((1 = 1 AND (e.resolver_id IS NOT NULL OR json_type(e.evidence_json, '$.candidates') IS NOT NULL)) OR (1 = 1 AND (e.target_symbol_id IS NOT NULL AND e.target_symbol_id NOT IN (SELECT id FROM symbols))))",
      keepBaseEdge:
        "(e.resolver_id IS NULL OR e.resolver_id <> 'test-linker' OR NOT (1 = 1))",
    });
    expect(fullDb.executions).toEqual([]);
    expect(fullDb.statements).toEqual([]);
  });

  it('loads a large valid scope in stable batches of at most 1000 IDs', () => {
    const db = new RecordingDatabase();
    const sourceFileIds = Array.from(
      { length: 2_001 },
      (_, index) => `source-${index.toString().padStart(4, '0')}`,
    ).reverse();
    const scope = new SqliteResetSourceScope(db, {
      resetSourceFileIds: sourceFileIds,
    });
    scope.install();
    expect(RESET_SOURCE_SCOPE_INSERT_BATCH_SIZE).toBe(1_000);
    expect(db.insertedIds).toHaveLength(2_001);
    expect(db.insertedIds[0]).toBe('source-0000');
    expect(db.insertedIds[2_000]).toBe('source-2000');
    expect(db.statements[0]).toContain('VALUES (?)');
    expect(db.statements[0]).not.toContain('IN (');
  });

  it('rejects oversized scope before any TEMP table mutation', () => {
    const db = new RecordingDatabase();
    const sourceFileIds = Array.from(
      { length: 10_001 },
      (_, index) => `source-${index}`,
    );
    expect(
      () =>
        new SqliteResetSourceScope(db, { resetSourceFileIds: sourceFileIds }),
    ).toThrow(ResolutionResetSourceScopeOverflowError);
    expect(db.executions).toEqual([]);
    expect(db.statements).toEqual([]);
    expect(db.insertedIds).toEqual([]);
  });
});
