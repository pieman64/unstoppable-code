// Proposed target: packages/desktop-shared/src/node/code-graph/__tests__/
// resolution-projection-reset-scope.test.ts
//
// Text-only production-adapter integration draft. It intentionally constructs
// the adopted W2 SqliteResolutionProjection over SQLite, rather than using the
// SQL-predicate recording fake in sqlite-reset-source-scope.test.ts.

import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '../store/database';
import type {
  CodeGraphConfidenceTier,
  CodeGraphEdgeKind,
  CodeGraphEdgeRecord,
  CodeGraphFileRecord,
  CodeGraphSymbolKind,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import {
  SqliteResolutionProjection,
  type ResolutionProjectionStore,
} from '../resolve/resolution-projection';
import { ScopedResolutionProjectionStore } from '../resolve/scoped-resolution-projection';

const REPO_ROW_ID = 'opaque-repository-row-A';
const REPO_ID = 'public-repository-A';

function edge(
  id: string,
  kind: CodeGraphEdgeKind,
  sourceFileId: string,
  targetSymbolId: string | null,
  resolverId: string | null,
  evidence: Record<string, unknown> = {},
  sourceSymbolId: string | null = null,
): CodeGraphEdgeRecord {
  return {
    id,
    repositoryId: REPO_ID,
    kind,
    sourceSymbolId,
    targetSymbolId,
    sourceFileId,
    targetRef: null,
    line: 1,
    confidenceTier: resolverId === null ? 'EXTRACTED' : 'RESOLVED',
    confidenceScore: resolverId === null ? 1 : 0.99,
    resolverId,
    evidence,
  };
}

const PERSISTED_EDGES: readonly CodeGraphEdgeRecord[] = [
  edge(
    'call-changed',
    'CALLS',
    'changed',
    'callee-changed',
    'call-resolution',
    {
      resolvedPath: 'src/callee.ts',
      via: 'barrel.ts',
      candidates: ['src/callee.ts'],
      preserved: 'changed-source-only',
    },
  ),
  edge(
    'call-unselected',
    'CALLS',
    'unselected',
    'callee-unselected',
    'call-resolution',
    {
      resolvedPath: 'src/unselected.ts',
      via: 'other-barrel.ts',
      candidates: ['src/unselected.ts'],
      preserved: 'unaffected',
    },
  ),
  edge(
    'test-call-a',
    'CALLS',
    'test-a',
    'candidate-a',
    'call-resolution',
    {},
    'test-source-a',
  ),
  edge(
    'test-call-z',
    'CALLS',
    'test-z',
    'candidate-z',
    'call-resolution',
    {},
    'test-source-z',
  ),
  edge('import-changed', 'IMPORTS_FROM', 'changed', null, null),
  edge('import-unselected', 'IMPORTS_FROM', 'unselected', null, null),
  edge('test-link-a', 'TESTED_BY', 'test-a', 'callee-changed', 'test-linker'),
  edge(
    'test-link-z',
    'TESTED_BY',
    'test-z',
    'callee-unselected',
    'test-linker',
  ),
];

class ProjectionFixtureStore implements ResolutionProjectionStore {
  public readonly qualifiedLookups: string[] = [];
  public listEdges(filter: {
    kind?: CodeGraphEdgeKind;
    unresolvedOnly?: boolean;
    sourceFileId?: string;
    repoId?: string;
  }): CodeGraphEdgeRecord[] {
    return PERSISTED_EDGES.filter(
      (row) =>
        (filter.kind === undefined || row.kind === filter.kind) &&
        (filter.sourceFileId === undefined ||
          row.sourceFileId === filter.sourceFileId),
    );
  }

  public listConfigExtendsEdges(_repoId: string): CodeGraphEdgeRecord[] {
    void _repoId;
    return [];
  }

  public listTestCallTargets(_repoId: string): Array<{
    sourceFileId: string;
    targetSymbolId: string;
    testFileSymbolId: string;
  }> {
    void _repoId;
    throw new Error('Test-call candidates must come from the SQLite overlay');
  }

  public getFileById(_fileId: string): CodeGraphFileRecord | null {
    void _fileId;
    return null;
  }

  public listFiles(_repoId: string): CodeGraphFileRecord[] {
    void _repoId;
    return [];
  }

  public getSymbolByQualifiedName(
    qualifiedName: string,
    _repoId: string,
  ): CodeGraphSymbolRecord | null {
    void _repoId;
    this.qualifiedLookups.push(qualifiedName);
    return null;
  }

  public listSymbolsForFile(_fileId: string): CodeGraphSymbolRecord[] {
    void _fileId;
    return [];
  }

  public listSymbolsByKindAndName(
    _kind: CodeGraphSymbolKind,
    _name: string,
    _repoId: string,
  ): CodeGraphSymbolRecord[] {
    void _kind;
    void _name;
    void _repoId;
    return [];
  }

  public updateEdgeResolution(
    _edgeId: string,
    _update: {
      targetSymbolId: string;
      confidenceTier: CodeGraphConfidenceTier;
      confidenceScore: number;
      resolverId: string;
      evidence: Record<string, unknown>;
    },
  ): void {
    void _edgeId;
    void _update;
  }

  public updateEdgeEvidence(
    _edgeId: string,
    _evidence: Record<string, unknown>,
  ): void {
    void _edgeId;
    void _evidence;
  }

  public insertEdges(_edges: readonly CodeGraphEdgeRecord[]): void {
    void _edges;
  }
}

function seedProjectionDatabase(db: CodeGraphDatabase): void {
  db.exec(`
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL
    );
    CREATE TABLE files (id TEXT PRIMARY KEY);
    CREATE TABLE symbols (
      id TEXT PRIMARY KEY,
      file_id TEXT,
      kind TEXT,
      byte_start INTEGER,
      is_test INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_symbol_id TEXT,
      target_symbol_id TEXT,
      source_file_id TEXT NOT NULL,
      target_ref TEXT,
      line INTEGER,
      confidence_tier TEXT NOT NULL,
      confidence_score REAL NOT NULL,
      resolver_id TEXT,
      evidence_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.prepare('INSERT INTO repositories (id, repo_id) VALUES (?, ?)').run(
    REPO_ROW_ID,
    REPO_ID,
  );
  const insertSymbol = db.prepare('INSERT INTO symbols (id) VALUES (?)');
  for (const symbolId of [
    'callee-changed',
    'callee-unselected',
    'candidate-a',
    'candidate-z',
  ]) {
    insertSymbol.run(symbolId);
  }
  for (const owner of ['a', 'z']) {
    db.prepare('INSERT INTO files (id) VALUES (?)').run(`test-${owner}`);
    db.prepare(
      'INSERT INTO symbols (id, file_id, kind, byte_start, is_test) VALUES (?, ?, ?, ?, ?)',
    ).run(`test-file-symbol-${owner}`, `test-${owner}`, 'file', 0, 1);
    db.prepare(
      'INSERT INTO symbols (id, file_id, kind, byte_start, is_test) VALUES (?, ?, ?, ?, ?)',
    ).run(`test-source-${owner}`, `test-${owner}`, 'function', 1, 1);
  }
  const insertEdge = db.prepare(`
    INSERT INTO edges (
      id, repository_id, kind, source_symbol_id, target_symbol_id,
      source_file_id, target_ref, line, confidence_tier, confidence_score,
      resolver_id, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of PERSISTED_EDGES) {
    insertEdge.run(
      row.id,
      REPO_ROW_ID,
      row.kind,
      row.sourceSymbolId,
      row.targetSymbolId,
      row.sourceFileId,
      row.targetRef,
      row.line,
      row.confidenceTier,
      row.confidenceScore,
      row.resolverId,
      JSON.stringify(row.evidence),
    );
  }
}

function withProjection(
  options: { resetSourceFileIds?: readonly string[] } | undefined,
  inspect: (
    projection: SqliteResolutionProjection,
    store: ProjectionFixtureStore,
    db: CodeGraphDatabase,
  ) => void,
): void {
  const db = openCodeGraphDatabase(':memory:');
  seedProjectionDatabase(db);
  const store = new ProjectionFixtureStore();
  const projection =
    options === undefined
      ? new SqliteResolutionProjection(db, store)
      : new SqliteResolutionProjection(db, store, options);
  try {
    inspect(projection, store, db);
  } finally {
    projection.close();
    db.close();
  }
}

function projectionRows(
  projection: SqliteResolutionProjection,
  kind: CodeGraphEdgeKind,
): CodeGraphEdgeRecord[] {
  return projection
    .listEdges({ kind, repoId: REPO_ID })
    .filter((row) => kind !== 'CALLS' || !row.id.startsWith('test-call-'))
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
}

describe('adopted SQLite resolution-projection source reset scope', () => {
  it('preserves the absent full-reset default, global imports, and immutable lookups', () => {
    withProjection(undefined, (projection, store) => {
      const calls = projectionRows(projection, 'CALLS');
      expect(calls.map((row) => row.targetSymbolId)).toEqual([null, null]);
      expect(calls[0]?.evidence).toEqual({ preserved: 'changed-source-only' });

      expect(
        projectionRows(projection, 'IMPORTS_FROM').map((row) => row.id),
      ).toEqual(['import-changed', 'import-unselected']);
      expect(
        projectionRows(projection, 'TESTED_BY').map((row) => row.id),
      ).toEqual([]);

      expect(
        projection.getSymbolByQualifiedName('outside::immutable', REPO_ID),
      ).toBeNull();
      expect(store.qualifiedLookups).toEqual(['outside::immutable']);
    });
  });

  it('treats [] as no reset and keeps all old test links visible', () => {
    withProjection({ resetSourceFileIds: [] }, (projection) => {
      const calls = projectionRows(projection, 'CALLS');
      expect(calls.map((row) => row.targetSymbolId)).toEqual([
        'callee-changed',
        'callee-unselected',
      ]);
      expect(calls[0]?.evidence).toEqual({
        resolvedPath: 'src/callee.ts',
        via: 'barrel.ts',
        candidates: ['src/callee.ts'],
        preserved: 'changed-source-only',
      });
      expect(
        projectionRows(projection, 'IMPORTS_FROM').map((row) => row.id),
      ).toEqual(['import-changed', 'import-unselected']);
      expect(
        projectionRows(projection, 'TESTED_BY').map((row) => row.id),
      ).toEqual(['test-link-a', 'test-link-z']);
    });
  });

  it('resets only one source, hides only its stale test link, and keeps import adjacency global', () => {
    withProjection(
      { resetSourceFileIds: ['changed', 'test-a'] },
      (projection) => {
        const calls = projectionRows(projection, 'CALLS');
        expect(calls[0]?.targetSymbolId).toBeNull();
        expect(calls[0]?.evidence).toEqual({
          preserved: 'changed-source-only',
        });
        expect(calls[1]?.targetSymbolId).toBe('callee-unselected');
        expect(calls[1]?.evidence).toEqual({
          resolvedPath: 'src/unselected.ts',
          via: 'other-barrel.ts',
          candidates: ['src/unselected.ts'],
          preserved: 'unaffected',
        });
        expect(
          projectionRows(projection, 'IMPORTS_FROM').map((row) => row.id),
        ).toEqual(['import-changed', 'import-unselected']);
        expect(
          projectionRows(projection, 'TESTED_BY').map((row) => row.id),
        ).toEqual(['test-link-z']);
      },
    );
  });

  it('adds or retires only one TESTED_BY owner when a target changes isTest membership', () => {
    withProjection({ resetSourceFileIds: ['test-a'] }, (projection) => {
      projection.updateEdgeResolution('test-call-a', {
        targetSymbolId: 'candidate-a',
        confidenceTier: 'RESOLVED',
        confidenceScore: 0.99,
        resolverId: 'call-resolution',
        evidence: {},
      });
      const selected = new ScopedResolutionProjectionStore(projection);
      const candidates = selected.listTestCallTargetsForSources(REPO_ID, [
        'test-a',
      ]);
      expect(candidates).toEqual([
        {
          sourceFileId: 'test-a',
          targetSymbolId: 'candidate-a',
          testFileSymbolId: 'test-file-symbol-a',
        },
      ]);
      const candidate = candidates[0];
      if (candidate === undefined) {
        throw new Error('Expected one selected test-call candidate');
      }
      projection.insertEdges([
        edge(
          'generated-test-link-a',
          'TESTED_BY',
          candidate.sourceFileId,
          candidate.targetSymbolId,
          'test-linker',
        ),
      ]);
      expect(
        projectionRows(projection, 'TESTED_BY').map((row) => row.id),
      ).toEqual(['generated-test-link-a', 'test-link-z']);
    });

    withProjection(
      { resetSourceFileIds: ['test-a'] },
      (projection, _store, db) => {
        projection.updateEdgeResolution('test-call-a', {
          targetSymbolId: 'candidate-a',
          confidenceTier: 'RESOLVED',
          confidenceScore: 0.99,
          resolverId: 'call-resolution',
          evidence: {},
        });
        db.prepare('UPDATE symbols SET is_test = 1 WHERE id = ?').run(
          'candidate-a',
        );
        const selected = new ScopedResolutionProjectionStore(projection);
        expect(
          selected.listTestCallTargetsForSources(REPO_ID, ['test-a']),
        ).toEqual([]);
        expect(
          selected.listTestCallTargetsForSources(REPO_ID, ['test-z']),
        ).toEqual([
          {
            sourceFileId: 'test-z',
            targetSymbolId: 'candidate-z',
            testFileSymbolId: 'test-file-symbol-z',
          },
        ]);
        // The old selected link is hidden, while the unrelated generated owner
        // remains visible. The pass adds no replacement when its target isTest.
        expect(
          projectionRows(projection, 'TESTED_BY').map((row) => row.id),
        ).toEqual(['test-link-z']);
      },
    );
  });
});
