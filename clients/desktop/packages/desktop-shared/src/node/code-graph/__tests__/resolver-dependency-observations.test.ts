import {
  openCodeGraphDatabase,
  withImmediateTransaction,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import { fileRowId, symbolRowId, edgeRowId } from '../ids';
import type {
  CodeGraphFileFacts,
  CodeGraphSymbolRecord,
  CodeGraphEdgeRecord,
} from '../../../types/code-graph';
import {
  CapturedResolutionProjectionStore,
  ResolutionDependencyCapture,
} from '../resolve/resolution-dependency-capture';
import { SqliteResolutionDependencyWriter } from '../resolve/resolution-dependency-store';
import { resolveWorkflowActionEdges } from '../resolve/workflow-action-resolver';
import { resolveDocLinkEdges } from '../resolve/doc-link-resolver';
import { resolveConfigExtendsEdges } from '../resolve/config-extends-resolver';
import { resolveIpcEdges } from '../resolve/ipc-resolver';
import { linkTests } from '../resolve/test-linker';

function facts(
  relativePath: string,
  language = 'typescript',
): CodeGraphFileFacts {
  const fileId = fileRowId('r', relativePath);
  const symbol: CodeGraphSymbolRecord = {
    id: symbolRowId('r', relativePath),
    repositoryId: 'r',
    fileId,
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
    isTest: relativePath.includes('.test.'),
    extra: {},
  };
  return {
    file: {
      id: fileId,
      repositoryId: 'r',
      relativePath,
      absolutePath: `/fixture/${relativePath}`,
      language,
      contentHash: 'hash',
      sizeBytes: 1,
      mtimeNs: '1',
      lineCount: 1,
      grammarId: language,
      grammarAbi: null,
      parseStatus: 'parsed',
      hasErrors: false,
      updatedAt: 1,
    },
    symbols: [symbol],
    edges: [],
  };
}
function reference(
  file: CodeGraphFileFacts,
  kind: CodeGraphEdgeRecord['kind'],
  targetRef: string,
  evidence: Record<string, unknown> = {},
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: 'r',
      kind,
      sourceId: file.file.id,
      target: targetRef,
      line: 1,
    }),
    repositoryId: 'r',
    kind,
    sourceFileId: file.file.id,
    sourceSymbolId: file.symbols[0]?.id ?? null,
    targetSymbolId: null,
    targetRef,
    line: 1,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1,
    resolverId: null,
    evidence,
  };
}

describe('W3 concrete resolver observations', () => {
  it('captures absent local action manifests and external disposition, then ambiguity after creation', () => {
    const db = openCodeGraphDatabase(':memory:');
    try {
      runCodeGraphMigrations(db);
      withImmediateTransaction(db, () => {
        const store = new CodeGraphStore(db);
        store.upsertRepository({
          repoId: 'r',
          rootPath: '/fixture',
          gitHead: null,
        });
        const workflow = facts('.github/workflows/main.yml', 'github-workflow');
        workflow.edges.push(
          reference(workflow, 'USES_PIPELINE_ACTION', './action'),
          reference(workflow, 'USES_PIPELINE_ACTION', 'owner/repo@main'),
        );
        store.replaceFileFacts(workflow);
        const writer = new SqliteResolutionDependencyWriter(db);
        const capture = new ResolutionDependencyCapture(
          'r',
          '/fixture',
          writer,
        );
        const port = new CapturedResolutionProjectionStore(store, capture);
        capture.beginResolver('workflow-action');
        resolveWorkflowActionEdges({ store: port, repoId: 'r', capture });
        capture.finishResolver('workflow-action');
        expect(
          db
            .prepare(
              "SELECT dependency_value FROM resolution_dependencies WHERE dependency_kind='workflow-manifest-candidate-set'",
            )
            .all(),
        ).toHaveLength(2);
        expect(
          db
            .prepare(
              "SELECT * FROM resolution_dependencies WHERE dependency_kind='workflow-action-disposition'",
            )
            .all(),
        ).toHaveLength(2);
        store.replaceFileFacts(facts('action/action.yml'));
        store.replaceFileFacts(facts('action/action.yaml'));
        store.resetResolutions();
        const second = new ResolutionDependencyCapture('r', '/fixture', writer);
        second.beginResolver('workflow-action');
        resolveWorkflowActionEdges({
          store: new CapturedResolutionProjectionStore(store, second),
          repoId: 'r',
          capture: second,
        });
        second.finishResolver('workflow-action');
        expect(
          store
            .listEdges({ kind: 'USES_PIPELINE_ACTION', repoId: 'r' })
            .find((edge) => edge.targetRef === './action')?.evidence.candidates,
        ).toBe(2);
      });
    } finally {
      db.close();
    }
  });
  it('records both missing documentation paths and config candidates without guessing a destination', () => {
    const db = openCodeGraphDatabase(':memory:');
    try {
      runCodeGraphMigrations(db);
      withImmediateTransaction(db, () => {
        const store = new CodeGraphStore(db);
        store.upsertRepository({
          repoId: 'r',
          rootPath: '/fixture',
          gitHead: null,
        });
        const doc = facts('docs/main.md', 'markdown');
        doc.edges.push(reference(doc, 'DOCUMENTS', 'missing.md'));
        store.replaceFileFacts(doc);
        const config = facts('tsconfig.json', 'tsconfig');
        config.edges.push(
          reference(config, 'REFERENCES', './base', { configExtends: true }),
        );
        store.replaceFileFacts(config);
        const capture = new ResolutionDependencyCapture(
          'r',
          '/fixture',
          new SqliteResolutionDependencyWriter(db),
        );
        const port = new CapturedResolutionProjectionStore(store, capture);
        capture.beginResolver('doc-link');
        resolveDocLinkEdges({
          store: port,
          repoId: 'r',
          rootPath: '/fixture',
          capture,
        });
        capture.finishResolver('doc-link');
        capture.beginResolver('config-extends');
        resolveConfigExtendsEdges({
          store: port,
          repoId: 'r',
          rootPath: '/fixture',
          capture,
        });
        capture.finishResolver('config-extends');
        expect(
          db
            .prepare(
              "SELECT * FROM resolution_dependencies WHERE dependency_kind='doc-path-fragment' AND dependency_value='null'",
            )
            .all(),
        ).toHaveLength(2);
        expect(
          db
            .prepare(
              "SELECT * FROM resolution_dependencies WHERE resolver='config-extends' AND dependency_kind='config-target' AND dependency_value='null'",
            )
            .all(),
        ).toHaveLength(2);
        expect(
          store
            .listEdges({ repoId: 'r' })
            .every((edge) => edge.targetSymbolId === null),
        ).toBe(true);
      });
    } finally {
      db.close();
    }
  });
  it('captures IPC absent candidate keys and excludes unselected mutable source owners', () => {
    const db = openCodeGraphDatabase(':memory:');
    try {
      runCodeGraphMigrations(db);
      withImmediateTransaction(db, () => {
        const store = new CodeGraphStore(db);
        store.upsertRepository({
          repoId: 'r',
          rootPath: '/fixture',
          gitHead: null,
        });
        const a = facts('a.ts');
        a.edges.push(reference(a, 'IPC_INVOKES', 'ipc:missing'));
        store.replaceFileFacts(a);
        const b = facts('b.ts');
        b.edges.push(reference(b, 'IPC_HANDLES', 'ipc:missing'));
        store.replaceFileFacts(b);
        const capture = new ResolutionDependencyCapture(
          'r',
          '/fixture',
          new SqliteResolutionDependencyWriter(db),
        );
        capture.beginResolver('ipc-channel', [a.file.id]);
        resolveIpcEdges({
          store: new CapturedResolutionProjectionStore(store, capture),
          repoId: 'r',
          capture,
          sourceFileIds: [a.file.id],
        });
        capture.finishResolver('ipc-channel', [a.file.id]);
        expect(
          db
            .prepare(
              "SELECT DISTINCT source_file_id FROM resolution_dependencies WHERE resolver='ipc-channel'",
            )
            .all(),
        ).toEqual([{ source_file_id: a.file.id }]);
        expect(
          db
            .prepare(
              "SELECT dependency_value FROM resolution_dependencies WHERE dependency_kind='ipc-channel-candidate-set'",
            )
            .all(),
        ).toEqual([{ dependency_value: '[]' }]);
      });
    } finally {
      db.close();
    }
  });
  it('records negative test membership even when no test-call projection row exists', () => {
    const db = openCodeGraphDatabase(':memory:');
    try {
      runCodeGraphMigrations(db);
      withImmediateTransaction(db, () => {
        const store = new CodeGraphStore(db);
        store.upsertRepository({
          repoId: 'r',
          rootPath: '/fixture',
          gitHead: null,
        });
        const source = facts('source.test.ts');
        source.edges.push(reference(source, 'CALLS', 'missing'));
        store.replaceFileFacts(source);
        const capture = new ResolutionDependencyCapture(
          'r',
          '/fixture',
          new SqliteResolutionDependencyWriter(db),
        );
        capture.beginResolver('test-linker');
        linkTests({
          store: new CapturedResolutionProjectionStore(store, capture),
          repoId: 'r',
          capture,
        });
        capture.finishResolver('test-linker');
        expect(store.listEdges({ repoId: 'r', kind: 'TESTED_BY' })).toEqual([]);
        expect(
          db
            .prepare(
              "SELECT * FROM resolution_dependencies WHERE resolver='test-linker' AND dependency_kind='test-call-candidate-set'",
            )
            .all().length,
        ).toBeGreaterThanOrEqual(2);
      });
    } finally {
      db.close();
    }
  });
  it('keeps test-membership capture stable across storage-only file timestamp updates', () => {
    const db = openCodeGraphDatabase(':memory:');
    try {
      runCodeGraphMigrations(db);
      withImmediateTransaction(db, () => {
        const store = new CodeGraphStore(db);
        store.upsertRepository({
          repoId: 'r',
          rootPath: '/fixture',
          gitHead: null,
        });
        const source = facts('source.test.ts');
        store.replaceFileFacts(source);
        const captureRows = (): unknown[] => {
          const capture = new ResolutionDependencyCapture(
            'r',
            '/fixture',
            new SqliteResolutionDependencyWriter(db),
          );
          capture.beginResolver('test-linker');
          linkTests({
            store: new CapturedResolutionProjectionStore(store, capture),
            repoId: 'r',
            capture,
          });
          capture.finishResolver('test-linker');
          return db
            .prepare(
              "SELECT * FROM resolution_dependencies WHERE resolver='test-linker' ORDER BY source_file_id, source_edge_id, dependency_kind, dependency_key",
            )
            .all();
        };
        const before = captureRows();
        expect(before.length).toBeGreaterThan(0);
        db.prepare(
          'UPDATE files SET updated_at = ?, mtime_ns = ? WHERE id = ?',
        ).run(200, '200', source.file.id);
        expect(captureRows()).toEqual(before);
        db.prepare('UPDATE symbols SET is_test = 0 WHERE file_id = ?').run(
          source.file.id,
        );
        expect(captureRows()).not.toEqual(before);
      });
    } finally {
      db.close();
    }
  });
});
