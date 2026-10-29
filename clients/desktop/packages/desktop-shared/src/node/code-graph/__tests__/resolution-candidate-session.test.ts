import {
  openCodeGraphDatabase,
  withImmediateTransaction,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import { fileRowId, symbolRowId, edgeRowId } from '../ids';
import type {
  CodeGraphFileFacts,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import { ResolutionCandidateBuildSession } from '../resolve/resolution-candidate-session';
import { SqliteResolutionDependencyWriter } from '../resolve/resolution-dependency-store';

function fixture(relativePath: string, isTest: boolean): CodeGraphFileFacts {
  const id = fileRowId('r', relativePath);
  const base: CodeGraphSymbolRecord = {
    id: symbolRowId('r', relativePath),
    repositoryId: 'r',
    fileId: id,
    kind: 'file',
    name: relativePath,
    qualifiedName: relativePath,
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: 1,
    byteStart: 0,
    byteEnd: 1,
    signature: null,
    exported: false,
    isTest,
    extra: {},
  };
  const fn: CodeGraphSymbolRecord = {
    ...base,
    id: symbolRowId('r', `${relativePath}::run`),
    kind: 'function',
    name: 'run',
    qualifiedName: `${relativePath}::run`,
    parentSymbolId: base.id,
    exported: true,
  };
  return {
    file: {
      id,
      repositoryId: 'r',
      relativePath,
      absolutePath: `/fixture/${relativePath}`,
      language: 'typescript',
      contentHash: 'hash',
      sizeBytes: 1,
      mtimeNs: '1',
      lineCount: 1,
      grammarId: 'typescript',
      grammarAbi: null,
      parseStatus: 'parsed',
      hasErrors: false,
      updatedAt: 1,
    },
    symbols: [base, fn],
    edges: [],
  };
}
function state(db: CodeGraphDatabase): unknown {
  return {
    files: db.prepare('SELECT * FROM files ORDER BY id').all(),
    symbols: db.prepare('SELECT * FROM symbols ORDER BY id').all(),
    edges: db.prepare('SELECT * FROM edges ORDER BY id').all(),
    deps: db
      .prepare(
        'SELECT * FROM resolution_dependencies ORDER BY repository_id,resolver,source_file_id,source_edge_id,dependency_kind,dependency_key',
      )
      .all(),
    fts: db.prepare('SELECT * FROM symbol_fts_rows ORDER BY symbol_id').all(),
    metadata: db.prepare('SELECT * FROM graph_metadata ORDER BY key').all(),
  };
}
function initialize(db: CodeGraphDatabase): {
  store: CodeGraphStore;
  target: CodeGraphFileFacts;
  test: CodeGraphFileFacts;
} {
  runCodeGraphMigrations(db);
  const store = new CodeGraphStore(db);
  const target = fixture('target.ts', false);
  const test = fixture('caller.test.ts', true);
  const targetSymbol = target.symbols.find(
    (symbol): boolean => symbol.kind === 'function',
  );
  const testSymbol = test.symbols.find(
    (symbol): boolean => symbol.kind === 'function',
  );
  if (targetSymbol === undefined || testSymbol === undefined)
    throw new Error('fixture missing symbols');
  test.edges.push({
    id: edgeRowId({
      repoId: 'r',
      kind: 'CALLS',
      sourceId: testSymbol.id,
      target: 'run',
      line: 1,
    }),
    repositoryId: 'r',
    kind: 'CALLS',
    sourceFileId: test.file.id,
    sourceSymbolId: testSymbol.id,
    targetSymbolId: targetSymbol.id,
    targetRef: 'run',
    line: 1,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1,
    resolverId: null,
    evidence: { lexicalScope: true },
  });
  withImmediateTransaction(db, () => {
    store.upsertRepository({
      repoId: 'r',
      rootPath: '/fixture',
      gitHead: null,
    });
    store.replaceFileFacts(target);
    store.replaceFileFacts(test);
    const session = new ResolutionCandidateBuildSession(
      db,
      store,
      [{ repoId: 'r', rootPath: '/fixture' }],
      'full-diff',
    );
    try {
      session.run();
    } finally {
      session.close();
    }
  });
  return { store, target, test };
}
describe('W3 owned transaction and generated-link controls', () => {
  it('captures target-isTest negative membership and removes stale links owned by unchanged test source', () => {
    const db = openCodeGraphDatabase(':memory:');
    try {
      const { store, target, test } = initialize(db);
      expect(store.listEdges({ repoId: 'r', kind: 'TESTED_BY' })).toHaveLength(
        1,
      );
      withImmediateTransaction(db, () => {
        const session = new ResolutionCandidateBuildSession(
          db,
          store,
          [{ repoId: 'r', rootPath: '/fixture' }],
          'incremental',
        );
        try {
          session.preserve(target.file.id);
          target.symbols = target.symbols.map(
            (symbol): CodeGraphSymbolRecord => ({ ...symbol, isTest: true }),
          );
          store.replaceFileFacts(target);
          session.changed('r', target.file.id);
          const result = session.run();
          const plan = result.repositories[0]?.closure;
          expect(plan?.mode).toBe('incremental');
          if (plan?.mode === 'incremental')
            expect(plan.resetSourceFileIds).toContain(test.file.id);
        } finally {
          session.close();
        }
      });
      expect(store.listEdges({ repoId: 'r', kind: 'TESTED_BY' })).toEqual([]);
      expect(
        new SqliteResolutionDependencyWriter(db).isCompatible({
          repoId: 'r',
          rootPath: '/fixture',
        }),
      ).toBe(true);
    } finally {
      db.close();
    }
  });
  it('never marks unknown/custom input complete and uses explicit full repository fallback', () => {
    const db = openCodeGraphDatabase(':memory:');
    try {
      const { store } = initialize(db);
      withImmediateTransaction(db, () => {
        const session = new ResolutionCandidateBuildSession(
          db,
          store,
          [{ repoId: 'r', rootPath: '/fixture' }],
          'incremental',
        );
        try {
          session.markAllGlobal('custom-grammar');
          const result = session.run();
          expect(result.repositories[0]?.closure?.mode).toBe('full');
          expect(result.repositories[0]?.capture.metadata.complete).toBe(false);
          expect(result.repositories[0]?.fallbackReasons).toContain(
            'custom-grammar',
          );
        } finally {
          session.close();
        }
      });
      expect(
        new SqliteResolutionDependencyWriter(db).isCompatible({
          repoId: 'r',
          rootPath: '/fixture',
        }),
      ).toBe(false);
    } finally {
      db.close();
    }
  });
  it('rolls facts, bindings, dependencies, FTS ownership and markers back after capture publication failure', () => {
    const db = openCodeGraphDatabase(':memory:');
    try {
      const { store, target } = initialize(db);
      const prior = state(db);
      const failure = jest.spyOn(
        SqliteResolutionDependencyWriter.prototype,
        'writeMetadata',
      );
      const original = failure.getMockImplementation();
      if (original === undefined) {
        failure.mockRestore();
        throw new Error(
          'Expected the original metadata writer implementation.',
        );
      }
      failure.mockImplementation(function (
        this: SqliteResolutionDependencyWriter,
        repoId,
        metadata,
      ): never {
        original.call(this, repoId, metadata);
        throw new Error('capture-publish-fault');
      });
      try {
        expect(() =>
          withImmediateTransaction(db, () => {
            const session = new ResolutionCandidateBuildSession(
              db,
              store,
              [{ repoId: 'r', rootPath: '/fixture' }],
              'incremental',
            );
            try {
              session.preserve(target.file.id);
              target.file.contentHash = 'changed';
              store.replaceFileFacts(target);
              session.changed('r', target.file.id);
              session.run();
            } finally {
              session.close();
            }
          }),
        ).toThrow('capture-publish-fault');
      } finally {
        failure.mockRestore();
      }
      expect(state(db)).toEqual(prior);
    } finally {
      db.close();
    }
  });
});
