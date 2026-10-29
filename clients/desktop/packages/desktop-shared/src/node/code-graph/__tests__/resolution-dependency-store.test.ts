import { createHash } from 'node:crypto';
/**
 * Focused source draft for
 * packages/desktop-shared/src/node/code-graph/__tests__/
 * resolution-dependency-store.test.ts. Do not execute under this task's
 * text-only authorization.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  requireNumber,
  requireRow,
  type CodeGraphDatabase,
  type CodeGraphStatement,
  type CodeGraphSqlValue,
} from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import { runCodeGraphMigrations } from '../store/migrations';
import { edgeRowId, fileRowId, repositoryRowId } from '../ids';
import {
  canonicalResolutionDependencyJson,
  RESOLUTION_CAPTURE_ALGORITHM_VERSIONS,
  RESOLUTION_CAPTURE_FORMAT_VERSION,
  RESOLUTION_CAPTURE_SCHEMA_VERSION,
  resolutionDependencyCaptureMetadataKey,
} from '../resolve/resolution-dependency-capture';
import { SqliteResolutionDependencyWriter } from '../resolve/resolution-dependency-store';
import type { ResolutionDependencySource } from '../resolve/resolution-dependency-capture';
import type {
  CodeGraphEdgeRecord,
  CodeGraphFileRecord,
} from '../../../types/code-graph';

const REPO_ID = 'dependency-store-repo';
const ROOT_PATH = '/workspace/dependency-store-repo';

function configFile(): CodeGraphFileRecord {
  return {
    id: fileRowId(REPO_ID, 'tsconfig.json'),
    repositoryId: REPO_ID,
    relativePath: 'tsconfig.json',
    absolutePath: path.join(ROOT_PATH, 'tsconfig.json'),
    language: 'tsconfig',
    contentHash: 'hash',
    sizeBytes: 64,
    mtimeNs: '1',
    lineCount: 1,
    grammarId: null,
    grammarAbi: null,
    parseStatus: 'parsed',
    hasErrors: false,
    updatedAt: 1,
  };
}

function configExtendsEdge(
  targetRef: string,
  extendsConfig: boolean,
): CodeGraphEdgeRecord {
  const file = configFile();
  return {
    id: edgeRowId({
      repoId: REPO_ID,
      kind: 'REFERENCES',
      sourceId: file.id,
      target: targetRef,
      line: 1,
    }),
    repositoryId: REPO_ID,
    kind: 'REFERENCES',
    sourceSymbolId: null,
    targetSymbolId: null,
    sourceFileId: file.id,
    targetRef,
    line: 1,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1,
    resolverId: null,
    evidence: { configExtends: extendsConfig },
  };
}

function dependencySource(
  edge: CodeGraphEdgeRecord,
): ResolutionDependencySource {
  return {
    resolver: 'config-extends',
    sourceFileId: edge.sourceFileId,
    sourceEdgeId: edge.id,
  };
}

function dependencyRowCount(db: CodeGraphDatabase): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS count FROM resolution_dependencies WHERE repository_id = ?',
    )
    .get(repositoryRowId(REPO_ID));
  return requireNumber(requireRow(row), 'count');
}

describe('SqliteResolutionDependencyWriter', () => {
  let directory: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let writer: SqliteResolutionDependencyWriter;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'resolution-dependencies-'));
    db = openCodeGraphDatabase(path.join(directory, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({
      repoId: REPO_ID,
      rootPath: ROOT_PATH,
      gitHead: null,
    });
    writer = new SqliteResolutionDependencyWriter(db);
  });

  afterEach(() => {
    writer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('retains config dependency rows only for exact tsconfig REFERENCES inputs', () => {
    const edge = configExtendsEdge('./base', true);
    store.replaceFileFacts({ file: configFile(), symbols: [], edges: [edge] });
    writer.beginResolver(REPO_ID, 'config-extends', undefined);
    writer.replaceSource(REPO_ID, dependencySource(edge), [
      {
        dependencyKind: 'config-target',
        dependencyKey: 'base.json',
        dependencyValue: { symbolId: 'base-config' },
      },
    ]);

    writer.finishResolver(REPO_ID, 'config-extends', undefined);
    expect(dependencyRowCount(db)).toBe(1);

    const notAnExtendsEdge = configExtendsEdge('./other', false);
    store.replaceFileFacts({
      file: configFile(),
      symbols: [],
      edges: [notAnExtendsEdge],
    });
    writer.beginResolver(REPO_ID, 'config-extends', undefined);
    writer.finishResolver(REPO_ID, 'config-extends', undefined);
    expect(dependencyRowCount(db)).toBe(0);
  });

  it('rejects a complete marker when expected observed rows are missing', () => {
    const edge = configExtendsEdge('./base', true);
    store.replaceFileFacts({ file: configFile(), symbols: [], edges: [edge] });
    writer.beginResolver(REPO_ID, 'config-extends', undefined);
    writer.replaceSource(REPO_ID, dependencySource(edge), [
      {
        dependencyKind: 'capture-source-coverage',
        dependencyKey: 'config-extends/source/edge',
        dependencyValue: true,
      },
      {
        dependencyKind: 'config-target',
        dependencyKey: 'base.json',
        dependencyValue: null,
      },
    ]);
    writer.finishResolver(REPO_ID, 'config-extends', undefined);
    writer.writeMetadata(REPO_ID, {
      schemaVersion: RESOLUTION_CAPTURE_SCHEMA_VERSION,
      captureVersion: RESOLUTION_CAPTURE_FORMAT_VERSION,
      rootPath: ROOT_PATH,
      complete: true,
      algorithmVersions: RESOLUTION_CAPTURE_ALGORITHM_VERSIONS,
      incompleteResolvers: [],
      reasonsByResolver: {},
    });

    expect(writer.isCompatible({ repoId: REPO_ID, rootPath: ROOT_PATH })).toBe(
      true,
    );
    expect(
      db
        .prepare('SELECT value FROM graph_metadata WHERE key = ?')
        .get(resolutionDependencyCaptureMetadataKey(REPO_ID)),
    ).toBeDefined();

    db.prepare(
      'DELETE FROM resolution_dependencies WHERE repository_id = ?',
    ).run(repositoryRowId(REPO_ID));
    expect(writer.isCompatible({ repoId: REPO_ID, rootPath: ROOT_PATH })).toBe(
      false,
    );
  });

  it('refuses completeness when an observed owner lacks its source sentinel', () => {
    const edge = configExtendsEdge('./base', true);
    store.replaceFileFacts({ file: configFile(), symbols: [], edges: [edge] });
    writer.beginResolver(REPO_ID, 'config-extends', undefined);
    writer.replaceSource(REPO_ID, dependencySource(edge), [
      {
        dependencyKind: 'config-target',
        dependencyKey: 'base.json',
        dependencyValue: null,
      },
    ]);
    writer.finishResolver(REPO_ID, 'config-extends', undefined);

    const metadata = writer.writeMetadata(REPO_ID, {
      schemaVersion: RESOLUTION_CAPTURE_SCHEMA_VERSION,
      captureVersion: RESOLUTION_CAPTURE_FORMAT_VERSION,
      rootPath: ROOT_PATH,
      complete: true,
      algorithmVersions: RESOLUTION_CAPTURE_ALGORITHM_VERSIONS,
      incompleteResolvers: [],
      reasonsByResolver: {},
    });

    expect(metadata.complete).toBe(false);
    expect(metadata.incompleteResolvers).toContain('config-extends');
    expect(writer.isCompatible({ repoId: REPO_ID, rootPath: ROOT_PATH })).toBe(
      false,
    );
  });

  it('refuses completeness when a current resolver input owner has no captured source scope', () => {
    const edge = configExtendsEdge('./base', true);
    store.replaceFileFacts({ file: configFile(), symbols: [], edges: [edge] });

    const metadata = writer.writeMetadata(REPO_ID, {
      schemaVersion: RESOLUTION_CAPTURE_SCHEMA_VERSION,
      captureVersion: RESOLUTION_CAPTURE_FORMAT_VERSION,
      rootPath: ROOT_PATH,
      complete: true,
      algorithmVersions: RESOLUTION_CAPTURE_ALGORITHM_VERSIONS,
      incompleteResolvers: [],
      reasonsByResolver: {},
    });

    expect(metadata.complete).toBe(false);
    expect(metadata.incompleteResolvers).toContain('config-extends');
    expect(writer.isCompatible({ repoId: REPO_ID, rootPath: ROOT_PATH })).toBe(
      false,
    );
  });

  it('binds capture metadata to the exact root path', () => {
    writer.writeMetadata(REPO_ID, {
      schemaVersion: RESOLUTION_CAPTURE_SCHEMA_VERSION,
      captureVersion: RESOLUTION_CAPTURE_FORMAT_VERSION,
      rootPath: ROOT_PATH,
      complete: true,
      algorithmVersions: RESOLUTION_CAPTURE_ALGORITHM_VERSIONS,
      incompleteResolvers: [],
      reasonsByResolver: {},
    });
    expect(writer.isCompatible({ repoId: REPO_ID, rootPath: ROOT_PATH })).toBe(
      true,
    );
    expect(
      writer.isCompatible({ repoId: REPO_ID, rootPath: `${ROOT_PATH}-copy` }),
    ).toBe(false);
  });
  it('hashes complete dependency coverage in bounded batches without changing its digest', () => {
    const rows = 3_001;
    const insert = db.prepare(`INSERT INTO resolution_dependencies
      (repository_id, resolver, source_file_id, source_edge_id,
       dependency_kind, dependency_key, dependency_value) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const expectedHash = createHash('sha256');
    for (let index = 0; index < rows; index += 1) {
      const key = index.toString().padStart(5, '0');
      insert.run(
        repositoryRowId(REPO_ID),
        'call-resolution',
        'coverage-source',
        'coverage-edge',
        'file',
        key,
        'null',
      );
      expectedHash.update(
        canonicalResolutionDependencyJson([
          'coverage-source',
          'coverage-edge',
          'file',
          key,
          'null',
        ]),
      );
      expectedHash.update('\n');
    }
    const sizes: number[] = [];
    const prepare = db.prepare.bind(db);
    const observation = jest
      .spyOn(db, 'prepare')
      .mockImplementation((sql): CodeGraphStatement => {
        const statement = prepare.call(db, sql);
        return {
          all: (...parameters: CodeGraphSqlValue[]): unknown[] => {
            const result = statement.all(...parameters);
            if (
              sql.includes(
                'SELECT resolver, source_file_id, source_edge_id, dependency_kind',
              )
            ) {
              sizes.push(result.length);
            }
            return result;
          },
          get: (...parameters: CodeGraphSqlValue[]): unknown =>
            statement.get(...parameters),
          run: (
            ...parameters: CodeGraphSqlValue[]
          ): { changes: number | bigint } => statement.run(...parameters),
        };
      });
    try {
      const result = writer.writeMetadata(REPO_ID, {
        schemaVersion: RESOLUTION_CAPTURE_SCHEMA_VERSION,
        captureVersion: RESOLUTION_CAPTURE_FORMAT_VERSION,
        rootPath: ROOT_PATH,
        complete: true,
        algorithmVersions: RESOLUTION_CAPTURE_ALGORITHM_VERSIONS,
        incompleteResolvers: [],
        reasonsByResolver: {},
      });
      expect(result.dependencyCoverage['call-resolution']).toEqual({
        rowCount: rows,
        sourceCount: 1,
        sha256: expectedHash.digest('hex'),
      });
      expect(sizes.length).toBeGreaterThan(0);
      expect(sizes.reduce((total, size) => total + size, 0)).toBe(rows);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(1_000);
    } finally {
      observation.mockRestore();
    }
  });
});
