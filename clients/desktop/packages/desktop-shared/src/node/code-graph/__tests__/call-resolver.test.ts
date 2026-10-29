import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import { resolveCallEdges } from '../resolve/call-resolver';
import { linkTests } from '../resolve/test-linker';
import {
  edgeRowId,
  fileQualifiedName,
  fileRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import type {
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';

const REPO = 'repo-a';

function fileSymbol(
  relativePath: string,
  isTest: boolean,
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

function fnSymbol(
  relativePath: string,
  name: string,
  isTest: boolean,
): CodeGraphSymbolRecord {
  return {
    ...fileSymbol(relativePath, isTest),
    id: symbolRowId(REPO, symbolQualifiedName(relativePath, [], name)),
    kind: 'function',
    name,
    qualifiedName: symbolQualifiedName(relativePath, [], name),
    lineStart: 2,
    lineEnd: 4,
    byteStart: 10,
    byteEnd: 50,
    signature: `function ${name}()`,
  };
}

function facts(
  relativePath: string,
  symbols: CodeGraphSymbolRecord[],
  edges: CodeGraphEdgeRecord[],
): CodeGraphFileFacts {
  return {
    file: {
      id: fileRowId(REPO, relativePath),
      repositoryId: REPO,
      relativePath,
      absolutePath: `/abs/${relativePath}`,
      language: 'typescript',
      contentHash: 'h',
      sizeBytes: 100,
      mtimeNs: '1',
      lineCount: 10,
      grammarId: 'typescript',
      grammarAbi: 14,
      parseStatus: 'parsed',
      hasErrors: false,
      updatedAt: Date.now(),
    },
    symbols,
    edges,
  };
}

function callEdge(
  relativePath: string,
  sourceId: string,
  targetRef: string,
  line: number,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: REPO,
      kind: 'CALLS',
      sourceId,
      target: targetRef,
      line,
    }),
    repositoryId: REPO,
    kind: 'CALLS',
    sourceSymbolId: sourceId,
    targetSymbolId: null,
    sourceFileId: fileRowId(REPO, relativePath),
    targetRef,
    line,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1.0,
    resolverId: null,
    evidence: {},
  };
}

describe('call resolver and test linker', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-callres-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });

    // lib.ts: exports doWork; worker.ts: caller() calls doWork (imported) and helper (local)
    const libFile = fileSymbol('src/lib.ts', false);
    const doWork = {
      ...fnSymbol('src/lib.ts', 'doWork', false),
      exported: true,
    }; // This fixture represents an exported declaration.
    store.replaceFileFacts(facts('src/lib.ts', [libFile, doWork], []));

    const workerFile = fileSymbol('src/worker.ts', false);
    const caller = fnSymbol('src/worker.ts', 'caller', false);
    const helper = fnSymbol('src/worker.ts', 'helper', false);
    const importEdge: CodeGraphEdgeRecord = {
      id: edgeRowId({
        repoId: REPO,
        kind: 'IMPORTS_FROM',
        sourceId: workerFile.id,
        target: './lib',
        line: 1,
      }),
      repositoryId: REPO,
      kind: 'IMPORTS_FROM',
      sourceSymbolId: workerFile.id,
      targetSymbolId: libFile.id,
      sourceFileId: fileRowId(REPO, 'src/worker.ts'),
      targetRef: './lib',
      line: 1,
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.95,
      resolverId: 'ts-module-resolution',
      evidence: {
        names: [{ imported: 'doWork', local: 'doWork' }],
        resolvedPath: 'src/lib.ts',
      },
    };
    store.replaceFileFacts(
      facts(
        'src/worker.ts',
        [workerFile, caller, helper],
        [
          importEdge,
          callEdge('src/worker.ts', caller.id, 'doWork', 3),
          callEdge('src/worker.ts', caller.id, 'helper', 4),
          callEdge('src/worker.ts', caller.id, 'phantom', 5),
        ],
      ),
    );

    // test file calling doWork through a resolved import
    const testFile = fileSymbol('src/__tests__/lib.test.ts', true);
    const testFn = fnSymbol('src/__tests__/lib.test.ts', 'runsDoWork', true);
    const testImport: CodeGraphEdgeRecord = {
      ...importEdge,
      id: edgeRowId({
        repoId: REPO,
        kind: 'IMPORTS_FROM',
        sourceId: testFile.id,
        target: '../lib',
        line: 1,
      }),
      sourceSymbolId: testFile.id,
      sourceFileId: fileRowId(REPO, 'src/__tests__/lib.test.ts'),
      targetRef: '../lib',
    };
    store.replaceFileFacts(
      facts(
        'src/__tests__/lib.test.ts',
        [testFile, testFn],
        [
          testImport,
          callEdge('src/__tests__/lib.test.ts', testFn.id, 'doWork', 5),
        ],
      ),
    );
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('binds local calls and import-evidenced calls, leaves phantoms unresolved', () => {
    const upgraded = resolveCallEdges({ store, repoId: REPO });
    expect(upgraded).toBe(3); // helper (local), doWork in worker.ts, doWork in test
    const calls = store.listEdges({ kind: 'CALLS' });
    const byRef = new Map(
      calls.map((e) => [`${e.sourceFileId}:${e.targetRef}`, e]),
    );
    const workerFileId = fileRowId(REPO, 'src/worker.ts');
    expect(byRef.get(`${workerFileId}:helper`)?.resolverId).toBe('local-scope');
    expect(byRef.get(`${workerFileId}:doWork`)?.resolverId).toBe(
      'import-binding',
    );
    expect(byRef.get(`${workerFileId}:doWork`)?.targetSymbolId).toBe(
      symbolRowId(REPO, 'src/lib.ts::doWork'),
    );
    expect(byRef.get(`${workerFileId}:phantom`)?.targetSymbolId).toBeNull();
    expect(resolveCallEdges({ store, repoId: REPO })).toBe(0); // idempotent
  });

  it('links tests to the production symbols they call', () => {
    resolveCallEdges({ store, repoId: REPO });
    const inserted = linkTests({ store, repoId: REPO });
    expect(inserted).toBe(1);
    const testedBy = store.listEdges({ kind: 'TESTED_BY' });
    expect(testedBy).toHaveLength(1);
    expect(testedBy[0].sourceSymbolId).toBe(
      symbolRowId(REPO, 'src/lib.ts::doWork'),
    );
    expect(testedBy[0].targetSymbolId).toBe(
      symbolRowId(REPO, 'src/__tests__/lib.test.ts'),
    );
    expect(testedBy[0].confidenceTier).toBe('INFERRED');
    linkTests({ store, repoId: REPO });
    expect(store.listEdges({ kind: 'TESTED_BY' })).toHaveLength(1); // deterministic id ⇒ idempotent
  });

  it('keeps test-linking database reads bounded as production calls grow', () => {
    resolveCallEdges({ store, repoId: REPO });
    const productionCall = store
      .listEdges({ kind: 'CALLS' })
      .find(
        (edge) =>
          edge.sourceFileId === fileRowId(REPO, 'src/worker.ts') &&
          edge.targetSymbolId !== null,
      );
    if (productionCall === undefined)
      throw new Error('Missing resolved production fixture');
    store.insertEdges(
      Array.from({ length: 200 }, (_, i) => ({
        ...productionCall,
        id: `production-call-${i}`,
      })),
    );
    const prepare = db.prepare.bind(db);
    let reads = 0;
    let rows = 0;
    const spy = jest.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      return {
        run: (...params): { changes: number | bigint } =>
          statement.run(...params),
        get: (...params): unknown => {
          reads++;
          const result = statement.get(...params);
          rows += result === undefined ? 0 : 1;
          return result;
        },
        all: (...params): unknown[] => {
          reads++;
          const result = statement.all(...params);
          rows += result.length;
          return result;
        },
      };
    });
    try {
      expect(linkTests({ store, repoId: REPO })).toBe(1);
      expect(reads).toBeLessThanOrEqual(5);
      expect(rows).toBeLessThanOrEqual(10);
    } finally {
      spy.mockRestore();
    }
    expect(store.listEdges({ kind: 'TESTED_BY' })).toHaveLength(1);
  });
});

describe('test linker skips self-referential test-to-test edges', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let doWorkId: string;
  let helperId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-testlinker-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });

    // Production file with a real symbol under test.
    const prodFile = fileSymbol('src/lib.ts', false);
    const doWork = {
      ...fnSymbol('src/lib.ts', 'doWork', false),
      exported: true,
    }; // This fixture represents an exported declaration.
    doWorkId = doWork.id;
    store.replaceFileFacts(facts('src/lib.ts', [prodFile, doWork], []));

    // A test file with an internal helper it calls from module scope, plus a
    // resolved call into the production doWork symbol. The self-referential
    // call (test file -> its own internal helper) must not produce a
    // TESTED_BY edge targeting that helper — only the doWork call should.
    const testFile = fileSymbol('src/__tests__/lib.test.ts', true);
    const helper = fnSymbol(
      'src/__tests__/lib.test.ts',
      'internalHelper',
      true,
    );
    helperId = helper.id;
    const doWorkCall: CodeGraphEdgeRecord = {
      ...callEdge('src/__tests__/lib.test.ts', testFile.id, 'doWork', 2),
      targetSymbolId: doWork.id,
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.9,
      resolverId: 'import-binding',
    };
    const helperCall: CodeGraphEdgeRecord = {
      ...callEdge(
        'src/__tests__/lib.test.ts',
        testFile.id,
        'internalHelper',
        6,
      ),
      targetSymbolId: helper.id,
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.9,
      resolverId: 'local-scope',
    };
    store.replaceFileFacts(
      facts(
        'src/__tests__/lib.test.ts',
        [testFile, helper],
        [doWorkCall, helperCall],
      ),
    );
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("links the production call but skips the call targeting the test file's own helper", () => {
    const inserted = linkTests({ store, repoId: REPO });
    expect(inserted).toBe(1);
    const testedBy = store.listEdges({ kind: 'TESTED_BY' });
    expect(testedBy).toHaveLength(1);
    expect(testedBy[0].sourceSymbolId).toBe(doWorkId);
    expect(testedBy.some((edge) => edge.sourceSymbolId === helperId)).toBe(
      false,
    );
  });

  it('preserves repeated-call counts and rejects dangling or misowned test facts', () => {
    const call = store
      .listEdges({ kind: 'CALLS' })
      .find((edge) => edge.targetSymbolId === doWorkId);
    if (call === undefined) throw new Error('Missing production call fixture');
    store.insertEdges([
      { ...call, id: 'repeated-call' },
      { ...call, id: 'dangling-target', targetSymbolId: 'missing' },
      { ...call, id: 'dangling-source', sourceSymbolId: 'missing' },
      {
        ...call,
        id: 'wrong-file',
        sourceFileId: fileRowId(REPO, 'src/lib.ts'),
      },
    ]);
    expect(linkTests({ store, repoId: 'another-repository' })).toBe(0);
    expect(linkTests({ store, repoId: REPO })).toBe(2);
    expect(store.listEdges({ kind: 'TESTED_BY' })).toHaveLength(1);
    db.prepare('DELETE FROM symbols WHERE id = ?').run(
      symbolRowId(REPO, 'src/__tests__/lib.test.ts'),
    );
    store.insertEdges([
      { ...call, id: 'missing-file-symbol', sourceSymbolId: helperId },
    ]);
    expect(linkTests({ store, repoId: REPO })).toBe(0);
  });
});
