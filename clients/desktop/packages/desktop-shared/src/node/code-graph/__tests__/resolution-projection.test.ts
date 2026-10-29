import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  withImmediateTransaction,
  type CodeGraphDatabase,
  type CodeGraphSqlValue,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import {
  edgeRowId,
  fileQualifiedName,
  fileRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import type {
  CodeGraphConfidenceTier,
  CodeGraphEdgeKind,
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphSymbolKind,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import { SqliteResolutionProjection } from '../resolve/resolution-projection';

const REPO = 'resolution-projection-test';
const ROOT_PATH = '/repo';

interface Fixture {
  directory: string;
  db: CodeGraphDatabase;
  store: CodeGraphStore;
}

interface SymbolSpec {
  name: string;
  kind?: Exclude<CodeGraphSymbolKind, 'file'>;
  isTest?: boolean;
}

function trackCandidateBatches(db: CodeGraphDatabase): {
  database: CodeGraphDatabase;
  batchSizes: number[];
} {
  const batchSizes: number[] = [];
  const database: CodeGraphDatabase = {
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        all(...params: CodeGraphSqlValue[]): unknown[] {
          const rows = statement.all(...params);
          if (sql.includes('FROM resolution_projection_candidate_ids')) {
            batchSizes.push(rows.length);
          }
          return rows;
        },
        get(...params: CodeGraphSqlValue[]): unknown {
          return statement.get(...params);
        },
        run(...params: CodeGraphSqlValue[]): { changes: number | bigint } {
          return statement.run(...params);
        },
      };
    },
    close(): void {
      db.close();
    },
  };
  return { database, batchSizes };
}

function createFixture(): Fixture {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'code-graph-resolution-projection-'),
  );
  const db = openCodeGraphDatabase(path.join(directory, 'graph.db'));
  runCodeGraphMigrations(db);
  const store = new CodeGraphStore(db);
  store.upsertRepository({ repoId: REPO, rootPath: ROOT_PATH, gitHead: null });
  return { directory, db, store };
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function fileSymbol(
  relativePath: string,
  isTest = false,
): CodeGraphSymbolRecord {
  return {
    id: symbolRowId(REPO, fileQualifiedName(relativePath)),
    repositoryId: REPO,
    fileId: fileRowId(REPO, relativePath),
    kind: 'file',
    name: relativePath.split('/').pop() ?? relativePath,
    qualifiedName: fileQualifiedName(relativePath),
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: 10,
    byteStart: 0,
    byteEnd: 100,
    signature: null,
    exported: false,
    isTest,
    extra: {},
  };
}

function fileFacts(
  relativePath: string,
  symbols: CodeGraphSymbolRecord[],
  options: { language?: string; edges?: CodeGraphEdgeRecord[] } = {},
): CodeGraphFileFacts {
  return {
    file: {
      id: fileRowId(REPO, relativePath),
      repositoryId: REPO,
      relativePath,
      absolutePath: path.join(ROOT_PATH, relativePath),
      language: options.language ?? 'typescript',
      contentHash: 'projection-test',
      sizeBytes: 100,
      mtimeNs: '1',
      lineCount: 10,
      grammarId: null,
      grammarAbi: null,
      parseStatus: 'parsed',
      hasErrors: false,
      updatedAt: 1,
    },
    symbols,
    edges: options.edges ?? [],
  };
}

function symbol(relativePath: string, spec: SymbolSpec): CodeGraphSymbolRecord {
  const base = fileSymbol(relativePath, spec.isTest);
  const qualifiedName = symbolQualifiedName(relativePath, [], spec.name);
  return {
    ...base,
    id: symbolRowId(REPO, qualifiedName),
    kind: spec.kind ?? 'function',
    name: spec.name,
    qualifiedName,
    lineStart: 2,
    lineEnd: 4,
    byteStart: 10,
    byteEnd: 50,
    signature: spec.kind === 'config' ? null : 'function ' + spec.name + '()',
    exported: true,
  };
}

function configSymbol(relativePath: string): CodeGraphSymbolRecord {
  return {
    ...fileSymbol(relativePath),
    id: symbolRowId(REPO, relativePath + '::config'),
    kind: 'config',
    name: 'config',
    qualifiedName: relativePath + '::config',
    signature: null,
    exported: false,
  };
}

function edge(input: {
  kind: CodeGraphEdgeKind;
  sourceFileId: string;
  sourceSymbolId: string | null;
  targetRef: string | null;
  line?: number | null;
  targetSymbolId?: string | null;
  confidenceTier?: CodeGraphConfidenceTier;
  confidenceScore?: number;
  resolverId?: string | null;
  evidence?: Record<string, unknown>;
}): CodeGraphEdgeRecord {
  const line = input.line ?? null;
  return {
    id: edgeRowId({
      repoId: REPO,
      kind: input.kind,
      sourceId: input.sourceSymbolId ?? input.sourceFileId,
      target: input.targetRef ?? 'unresolved',
      line,
    }),
    repositoryId: REPO,
    kind: input.kind,
    sourceSymbolId: input.sourceSymbolId,
    targetSymbolId: input.targetSymbolId ?? null,
    sourceFileId: input.sourceFileId,
    targetRef: input.targetRef,
    line,
    confidenceTier: input.confidenceTier ?? 'EXTRACTED',
    confidenceScore: input.confidenceScore ?? 1,
    resolverId: input.resolverId ?? null,
    evidence: input.evidence ?? {},
  };
}

describe('SqliteResolutionProjection', () => {
  let fixture: Fixture | null = null;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    if (fixture !== null) {
      closeFixture(fixture);
      fixture = null;
    }
  });

  function currentFixture(): Fixture {
    if (fixture === null) {
      throw new Error('Test fixture has not been initialized');
    }
    return fixture;
  }

  it('overlays earlier proposals for all edge reads and test linking', () => {
    const { db, store } = currentFixture();
    const testPath = 'src/__tests__/service.test.ts';
    const servicePath = 'src/service.ts';
    const configPath = 'tsconfig.json';
    const testFile = fileSymbol(testPath, true);
    const testFunction = symbol(testPath, {
      name: 'callsService',
      isTest: true,
    });
    const serviceFile = fileSymbol(servicePath);
    const serviceFunction = symbol(servicePath, { name: 'service' });
    const configFile = fileSymbol(configPath);
    const config = configSymbol(configPath);
    const call = edge({
      kind: 'CALLS',
      sourceFileId: testFile.fileId,
      sourceSymbolId: testFunction.id,
      targetRef: 'service',
      line: 5,
    });
    const configExtends = edge({
      kind: 'REFERENCES',
      sourceFileId: configFile.fileId,
      sourceSymbolId: configFile.id,
      targetRef: './base',
      line: 1,
      evidence: { configExtends: true },
    });

    store.replaceFileFacts(
      fileFacts(testPath, [testFile, testFunction], { edges: [call] }),
    );
    store.replaceFileFacts(
      fileFacts(servicePath, [serviceFile, serviceFunction]),
    );
    store.replaceFileFacts(
      fileFacts(configPath, [configFile, config], {
        language: 'tsconfig',
        edges: [configExtends],
      }),
    );

    const projection = new SqliteResolutionProjection(db, store);
    try {
      projection.updateEdgeResolution(call.id, {
        targetSymbolId: serviceFunction.id,
        confidenceTier: 'RESOLVED',
        confidenceScore: 0.9,
        resolverId: 'call-resolver',
        evidence: { resolvedPath: servicePath },
      });
      projection.updateEdgeResolution(configExtends.id, {
        targetSymbolId: config.id,
        confidenceTier: 'RESOLVED',
        confidenceScore: 1,
        resolverId: 'config-extends',
        evidence: { configExtends: true, resolvedPath: 'tsconfig.base.json' },
      });

      expect(
        projection.listEdges({
          kind: 'CALLS',
          unresolvedOnly: true,
          repoId: REPO,
        }),
      ).toEqual([]);
      expect(
        projection.listEdges({ kind: 'CALLS', repoId: REPO }),
      ).toMatchObject([
        {
          id: call.id,
          targetSymbolId: serviceFunction.id,
          resolverId: 'call-resolver',
        },
      ]);
      expect(projection.listConfigExtendsEdges(REPO)).toEqual([]);
      expect(projection.listTestCallTargets(REPO)).toEqual([
        {
          sourceFileId: testFile.fileId,
          targetSymbolId: serviceFunction.id,
          testFileSymbolId: testFile.id,
        },
      ]);

      const testedBy: CodeGraphEdgeRecord = {
        ...edge({
          kind: 'TESTED_BY',
          sourceFileId: testFile.fileId,
          sourceSymbolId: serviceFunction.id,
          targetRef: null,
          targetSymbolId: testFile.id,
          confidenceTier: 'INFERRED',
          confidenceScore: 0.8,
          resolverId: 'test-linker',
        }),
        id: edgeRowId({
          repoId: REPO,
          kind: 'TESTED_BY',
          sourceId: serviceFunction.id,
          target: testFile.id,
          line: null,
        }),
      };
      projection.insertEdges([testedBy]);
      expect(
        projection.listEdges({ kind: 'TESTED_BY', repoId: REPO }),
      ).toMatchObject([{ id: testedBy.id, targetSymbolId: testFile.id }]);

      const counters = withImmediateTransaction(db, () => projection.apply());
      expect(counters.finalChangedEdges).toBe(3);
      expect(counters.tempIoKind).toBe('logical-payload');
      expect(counters.tempIoBytesMeasured).toBeNull();
      expect(counters.tempIoBytes).toBeGreaterThan(0);
      expect(
        store.listEdges({ kind: 'TESTED_BY', repoId: REPO }),
      ).toMatchObject([{ id: testedBy.id, targetSymbolId: testFile.id }]);
    } finally {
      projection.close();
    }
  });

  it('applies unproposed reset candidates, including stale resolved missing targets', () => {
    const { db, store } = currentFixture();
    const sourcePath = 'src/source.ts';
    const sourceFile = fileSymbol(sourcePath);
    const source = symbol(sourcePath, { name: 'caller' });
    const stale = edge({
      kind: 'CALLS',
      sourceFileId: sourceFile.fileId,
      sourceSymbolId: source.id,
      targetRef: 'removedExport',
      targetSymbolId: 'missing-target-symbol',
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.9,
      resolverId: 'local-scope',
      evidence: {
        resolvedPath: 'src/removed.ts',
        via: 'src/barrel.ts',
        candidates: 2,
        lexicalTarget: 'removedExport',
      },
    });
    store.replaceFileFacts(
      fileFacts(sourcePath, [sourceFile, source], { edges: [stale] }),
    );

    const projection = new SqliteResolutionProjection(db, store);
    try {
      expect(
        projection.listEdges({ kind: 'CALLS', repoId: REPO }),
      ).toMatchObject([
        {
          id: stale.id,
          targetSymbolId: null,
          confidenceTier: 'EXTRACTED',
          confidenceScore: 1,
          resolverId: null,
          evidence: { lexicalTarget: 'removedExport' },
        },
      ]);

      const counters = withImmediateTransaction(db, () => projection.apply());
      expect(counters.candidateEdges).toBe(1);
      expect(counters.finalChangedEdges).toBe(1);
      expect(store.listEdges({ kind: 'CALLS', repoId: REPO })).toMatchObject([
        {
          id: stale.id,
          targetSymbolId: null,
          confidenceTier: 'EXTRACTED',
          confidenceScore: 1,
          resolverId: null,
          evidence: { lexicalTarget: 'removedExport' },
        },
      ]);
    } finally {
      projection.close();
    }
  });

  it('persists a candidate-removal-only evidence change', () => {
    const { db, store } = currentFixture();
    const sourcePath = 'src/ipc.ts';
    const sourceFile = fileSymbol(sourcePath);
    const source = symbol(sourcePath, { name: 'ipcCall' });
    const ambiguous = edge({
      kind: 'IPC_INVOKES',
      sourceFileId: sourceFile.fileId,
      sourceSymbolId: source.id,
      targetRef: 'ipc:save',
      evidence: { candidates: 2, configExtends: false, keep: 'stable' },
    });
    store.replaceFileFacts(
      fileFacts(sourcePath, [sourceFile, source], { edges: [ambiguous] }),
    );

    const projection = new SqliteResolutionProjection(db, store);
    try {
      const counters = withImmediateTransaction(db, () => projection.apply());
      expect(counters.candidateEdges).toBe(1);
      expect(counters.finalChangedEdges).toBe(1);
      expect(
        store.listEdges({ kind: 'IPC_INVOKES', repoId: REPO }),
      ).toMatchObject([
        {
          id: ambiguous.id,
          targetSymbolId: null,
          confidenceTier: 'EXTRACTED',
          confidenceScore: 1,
          resolverId: null,
          evidence: { configExtends: false, keep: 'stable' },
        },
      ]);
    } finally {
      projection.close();
    }
  });

  it('overlays null dangling targets and applies the exact dangling-target reset', () => {
    const { db, store } = currentFixture();
    const sourcePath = 'src/dangling.ts';
    const sourceFile = fileSymbol(sourcePath);
    const source = symbol(sourcePath, { name: 'danglingCaller' });
    const dangling = edge({
      kind: 'REFERENCES',
      sourceFileId: sourceFile.fileId,
      sourceSymbolId: source.id,
      targetRef: 'old-target',
      targetSymbolId: 'missing-target-symbol',
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.7,
      resolverId: null,
      evidence: { preserve: ['second', 'first'] },
    });
    store.replaceFileFacts(
      fileFacts(sourcePath, [sourceFile, source], { edges: [dangling] }),
    );

    const projection = new SqliteResolutionProjection(db, store);
    try {
      expect(
        projection.listEdges({ kind: 'REFERENCES', repoId: REPO }),
      ).toMatchObject([
        {
          id: dangling.id,
          targetSymbolId: null,
          confidenceTier: 'EXTRACTED',
          confidenceScore: 1,
          resolverId: null,
          evidence: { preserve: ['second', 'first'] },
        },
      ]);

      const counters = withImmediateTransaction(db, () => projection.apply());
      expect(counters.finalChangedEdges).toBe(1);
      expect(
        store.listEdges({ kind: 'REFERENCES', repoId: REPO }),
      ).toMatchObject([
        {
          id: dangling.id,
          targetSymbolId: null,
          confidenceTier: 'EXTRACTED',
          confidenceScore: 1,
          resolverId: null,
          evidence: { preserve: ['second', 'first'] },
        },
      ]);
    } finally {
      projection.close();
    }
  });

  it('preserves a bound edge outside the exact reset predicate', () => {
    const { db, store } = currentFixture();
    const sourcePath = 'src/unowned-resolution.ts';
    const targetPath = 'src/stable-target.ts';
    const sourceFile = fileSymbol(sourcePath);
    const source = symbol(sourcePath, { name: 'caller' });
    const targetFile = fileSymbol(targetPath);
    const target = symbol(targetPath, { name: 'stableTarget' });
    store.replaceFileFacts(fileFacts(sourcePath, [sourceFile, source]));
    store.replaceFileFacts(fileFacts(targetPath, [targetFile, target]));
    const unowned = edge({
      kind: 'REFERENCES',
      sourceFileId: sourceFile.fileId,
      sourceSymbolId: source.id,
      targetRef: 'stableTarget',
      targetSymbolId: target.id,
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.83,
      resolverId: null,
      evidence: {
        resolvedPath: targetPath,
        via: 'existing-owner',
        keep: true,
      },
    });
    store.insertEdges([unowned]);

    const projection = new SqliteResolutionProjection(db, store);
    try {
      expect(
        projection.listEdges({ kind: 'REFERENCES', repoId: REPO }),
      ).toEqual([unowned]);
      const counters = withImmediateTransaction(db, () => projection.apply());
      expect(counters.candidateEdges).toBe(0);
      expect(counters.finalChangedEdges).toBe(0);
      expect(store.listEdges({ kind: 'REFERENCES', repoId: REPO })).toEqual([
        unowned,
      ]);
    } finally {
      projection.close();
    }
  });

  it('preserves resolver evidence JSON ordering through TEMP reads and final writes', () => {
    const { db, store } = currentFixture();
    const sourcePath = 'src/evidence-order.ts';
    const targetPath = 'src/evidence-target.ts';
    const sourceFile = fileSymbol(sourcePath);
    const source = symbol(sourcePath, { name: 'caller' });
    const targetFile = fileSymbol(targetPath);
    const target = symbol(targetPath, { name: 'target' });
    store.replaceFileFacts(fileFacts(sourcePath, [sourceFile, source]));
    store.replaceFileFacts(fileFacts(targetPath, [targetFile, target]));
    const original = edge({
      kind: 'CALLS',
      sourceFileId: sourceFile.fileId,
      sourceSymbolId: source.id,
      targetRef: 'target',
    });
    store.insertEdges([original]);
    const evidence = {
      capture: 'reference.call',
      offset: 168,
      lexicalScope: true,
      via: targetPath,
      nested: { z: 2, a: 1 },
    };
    const generated = edge({
      kind: 'TESTED_BY',
      sourceFileId: targetFile.fileId,
      sourceSymbolId: target.id,
      targetRef: source.qualifiedName,
      targetSymbolId: source.id,
      confidenceTier: 'RESOLVED',
      resolverId: 'test-linker',
      evidence,
    });
    const projection = new SqliteResolutionProjection(db, store);
    try {
      projection.updateEdgeResolution(original.id, {
        targetSymbolId: target.id,
        confidenceTier: 'RESOLVED',
        confidenceScore: 0.9,
        resolverId: 'local-scope',
        evidence,
      });
      projection.insertEdges([generated]);
      const proposed = projection.listEdges({ kind: 'CALLS', repoId: REPO });
      expect(proposed).toHaveLength(1);
      expect(JSON.stringify(proposed[0]?.evidence)).toBe(
        JSON.stringify(evidence),
      );
      const inserted = projection.listEdges({
        kind: 'TESTED_BY',
        repoId: REPO,
      });
      expect(inserted).toHaveLength(1);
      expect(JSON.stringify(inserted[0]?.evidence)).toBe(
        JSON.stringify(evidence),
      );
      withImmediateTransaction(db, () => projection.apply());
      for (const id of [original.id, generated.id]) {
        expect(
          db.prepare('SELECT evidence_json FROM edges WHERE id = ?').get(id),
        ).toEqual({
          evidence_json: JSON.stringify(evidence),
        });
      }
    } finally {
      projection.close();
    }
  });

  it('suppresses no-op writes after recursively stable evidence comparison', () => {
    const { db, store } = currentFixture();
    const sourcePath = 'src/noop.ts';
    const targetPath = 'src/target.ts';
    const sourceFile = fileSymbol(sourcePath);
    const source = symbol(sourcePath, { name: 'caller' });
    const targetFile = fileSymbol(targetPath);
    const target = symbol(targetPath, { name: 'target' });
    store.replaceFileFacts(fileFacts(sourcePath, [sourceFile, source]));
    store.replaceFileFacts(fileFacts(targetPath, [targetFile, target]));
    const original = edge({
      kind: 'CALLS',
      sourceFileId: sourceFile.fileId,
      sourceSymbolId: source.id,
      targetRef: 'target',
      targetSymbolId: target.id,
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.9,
      resolverId: 'local-scope',
      evidence: {
        resolvedPath: targetPath,
        via: targetPath,
        nested: { z: 2, a: 1 },
        sequence: ['first', 'second'],
      },
    });
    store.insertEdges([original]);

    const projection = new SqliteResolutionProjection(db, store);
    try {
      projection.updateEdgeResolution(original.id, {
        targetSymbolId: target.id,
        confidenceTier: 'RESOLVED',
        confidenceScore: 0.9,
        resolverId: 'local-scope',
        evidence: {
          sequence: ['first', 'second'],
          nested: { a: 1, z: 2 },
          via: targetPath,
          resolvedPath: targetPath,
        },
      });
      const counters = withImmediateTransaction(db, () => projection.apply());
      expect(counters.candidateEdges).toBe(1);
      expect(counters.finalChangedEdges).toBe(0);
      expect(store.listEdges({ kind: 'CALLS', repoId: REPO })).toEqual([
        original,
      ]);
    } finally {
      projection.close();
    }
  });

  it('treats array reordering as an evidence change', () => {
    const { db, store } = currentFixture();
    const sourcePath = 'src/array-order.ts';
    const targetPath = 'src/array-target.ts';
    const sourceFile = fileSymbol(sourcePath);
    const source = symbol(sourcePath, { name: 'caller' });
    const targetFile = fileSymbol(targetPath);
    const target = symbol(targetPath, { name: 'target' });
    store.replaceFileFacts(fileFacts(sourcePath, [sourceFile, source]));
    store.replaceFileFacts(fileFacts(targetPath, [targetFile, target]));
    const original = edge({
      kind: 'CALLS',
      sourceFileId: sourceFile.fileId,
      sourceSymbolId: source.id,
      targetRef: 'target',
      targetSymbolId: target.id,
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.9,
      resolverId: 'call-resolver',
      evidence: { candidates: ['first', 'second'] },
    });
    store.insertEdges([original]);

    const projection = new SqliteResolutionProjection(db, store);
    try {
      projection.updateEdgeResolution(original.id, {
        targetSymbolId: target.id,
        confidenceTier: 'RESOLVED',
        confidenceScore: 0.9,
        resolverId: 'call-resolver',
        evidence: { candidates: ['second', 'first'] },
      });
      const counters = withImmediateTransaction(db, () => projection.apply());
      expect(counters.finalChangedEdges).toBe(1);
      expect(store.listEdges({ kind: 'CALLS', repoId: REPO })).toMatchObject([
        { id: original.id, evidence: { candidates: ['second', 'first'] } },
      ]);
    } finally {
      projection.close();
    }
  });

  it('does not write an identical regenerated inferred test link', () => {
    const { db, store } = currentFixture();
    const testPath = 'src/__tests__/stable.test.ts';
    const targetPath = 'src/stable-service.ts';
    const testFile = fileSymbol(testPath, true);
    const testFunction = symbol(testPath, {
      name: 'callsStableService',
      isTest: true,
    });
    const targetFile = fileSymbol(targetPath);
    const target = symbol(targetPath, { name: 'stableService' });
    store.replaceFileFacts(fileFacts(testPath, [testFile, testFunction]));
    store.replaceFileFacts(fileFacts(targetPath, [targetFile, target]));
    const call = edge({
      kind: 'CALLS',
      sourceFileId: testFile.fileId,
      sourceSymbolId: testFunction.id,
      targetRef: 'stableService',
      targetSymbolId: target.id,
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.9,
      resolverId: null,
    });
    const link: CodeGraphEdgeRecord = {
      ...edge({
        kind: 'TESTED_BY',
        sourceFileId: testFile.fileId,
        sourceSymbolId: target.id,
        targetRef: null,
        targetSymbolId: testFile.id,
        confidenceTier: 'INFERRED',
        confidenceScore: 0.8,
        resolverId: 'test-linker',
      }),
      id: edgeRowId({
        repoId: REPO,
        kind: 'TESTED_BY',
        sourceId: target.id,
        target: testFile.id,
        line: null,
      }),
    };
    store.insertEdges([call, link]);

    const projection = new SqliteResolutionProjection(db, store);
    try {
      projection.insertEdges([link]);
      expect(projection.listEdges({ kind: 'TESTED_BY', repoId: REPO })).toEqual(
        [link],
      );
      const counters = withImmediateTransaction(db, () => projection.apply());
      expect(counters.candidateEdges).toBe(1);
      expect(counters.finalChangedEdges).toBe(0);
      expect(store.listEdges({ kind: 'TESTED_BY', repoId: REPO })).toEqual([
        link,
      ]);
    } finally {
      projection.close();
    }
  });

  it('applies stable-ID candidates in batches larger than one thousand rows', () => {
    const { db, store } = currentFixture();
    const sourcePath = 'src/large.ts';
    const targetPath = 'src/large-target.ts';
    const sourceFile = fileSymbol(sourcePath);
    const targetFile = fileSymbol(targetPath);
    const sourceSymbols = Array.from({ length: 1001 }, (_, index) =>
      symbol(sourcePath, { name: 'source' + String(index) }),
    );
    const target = symbol(targetPath, { name: 'target' });
    store.replaceFileFacts(
      fileFacts(sourcePath, [sourceFile, ...sourceSymbols]),
    );
    store.replaceFileFacts(fileFacts(targetPath, [targetFile, target]));
    const edges = sourceSymbols.map((source, index) =>
      edge({
        kind: 'REFERENCES',
        sourceFileId: sourceFile.fileId,
        sourceSymbolId: source.id,
        targetRef: 'target' + String(index),
        targetSymbolId: target.id,
        confidenceTier: 'RESOLVED',
        confidenceScore: 0.9,
        resolverId: 'call-resolver',
        evidence: { index },
      }),
    );
    store.insertEdges(edges);

    const tracked = trackCandidateBatches(db);
    const projection = new SqliteResolutionProjection(tracked.database, store);
    try {
      for (const current of edges) {
        projection.updateEdgeResolution(current.id, {
          targetSymbolId: target.id,
          confidenceTier: 'RESOLVED',
          confidenceScore: 0.9,
          resolverId: 'call-resolver',
          evidence: { ...current.evidence, changed: true },
        });
      }
      const counters = withImmediateTransaction(tracked.database, () =>
        projection.apply(),
      );
      expect(counters.candidateEdges).toBe(1001);
      expect(counters.finalChangedEdges).toBe(1001);
      expect(tracked.batchSizes).toEqual([1000, 1, 0]);
      expect(tracked.batchSizes.every((size) => size <= 1000)).toBe(true);
      expect(
        store
          .listEdges({ kind: 'REFERENCES', repoId: REPO })
          .filter((current) => current.evidence.changed === true),
      ).toHaveLength(1001);
    } finally {
      projection.close();
    }
  });

  it('deletes old inferred test links that are not regenerated', () => {
    const { db, store } = currentFixture();
    const testPath = 'src/__tests__/removed.test.ts';
    const targetPath = 'src/target.ts';
    const testFile = fileSymbol(testPath, true);
    const testFunction = symbol(testPath, { name: 'oldTest', isTest: true });
    const targetFile = fileSymbol(targetPath);
    const target = symbol(targetPath, { name: 'target' });
    store.replaceFileFacts(fileFacts(testPath, [testFile, testFunction]));
    store.replaceFileFacts(fileFacts(targetPath, [targetFile, target]));
    const oldLink: CodeGraphEdgeRecord = {
      ...edge({
        kind: 'TESTED_BY',
        sourceFileId: testFile.fileId,
        sourceSymbolId: target.id,
        targetRef: null,
        targetSymbolId: testFile.id,
        confidenceTier: 'INFERRED',
        confidenceScore: 0.8,
        resolverId: 'test-linker',
      }),
      id: edgeRowId({
        repoId: REPO,
        kind: 'TESTED_BY',
        sourceId: target.id,
        target: testFile.id,
        line: null,
      }),
    };
    store.insertEdges([oldLink]);

    const projection = new SqliteResolutionProjection(db, store);
    try {
      expect(projection.listEdges({ kind: 'TESTED_BY', repoId: REPO })).toEqual(
        [],
      );
      const counters = withImmediateTransaction(db, () => projection.apply());
      expect(counters.candidateEdges).toBe(1);
      expect(counters.finalChangedEdges).toBe(1);
      expect(store.listEdges({ kind: 'TESTED_BY', repoId: REPO })).toEqual([]);
    } finally {
      projection.close();
    }
  });

  it('throws on apply failure so the outer build transaction rolls back', () => {
    const { db, store } = currentFixture();
    const sourcePath = 'src/failure.ts';
    const targetPath = 'src/target.ts';
    const sourceFile = fileSymbol(sourcePath);
    const source = symbol(sourcePath, { name: 'caller' });
    const targetFile = fileSymbol(targetPath);
    const target = symbol(targetPath, { name: 'target' });
    store.replaceFileFacts(fileFacts(sourcePath, [sourceFile, source]));
    store.replaceFileFacts(fileFacts(targetPath, [targetFile, target]));
    const original = edge({
      kind: 'CALLS',
      sourceFileId: sourceFile.fileId,
      sourceSymbolId: source.id,
      targetRef: 'target',
      targetSymbolId: target.id,
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.9,
      resolverId: 'local-scope',
      evidence: { resolvedPath: targetPath },
    });
    store.insertEdges([original]);
    db.exec(
      "CREATE TRIGGER fail_resolution_projection BEFORE UPDATE ON edges BEGIN SELECT RAISE(ABORT, 'projection injected failure'); END",
    );

    const projection = new SqliteResolutionProjection(db, store);
    try {
      projection.updateEdgeResolution(original.id, {
        targetSymbolId: target.id,
        confidenceTier: 'RESOLVED',
        confidenceScore: 0.9,
        resolverId: 'local-scope',
        evidence: { resolvedPath: targetPath, changed: true },
      });
      expect(() =>
        withImmediateTransaction(db, () => projection.apply()),
      ).toThrow('projection injected failure');
      expect(store.listEdges({ kind: 'CALLS', repoId: REPO })).toEqual([
        original,
      ]);
    } finally {
      projection.close();
    }
  });
});
