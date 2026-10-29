import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import { resolveWorkflowActionEdges } from '../resolve/workflow-action-resolver';
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

function makeFacts(
  relativePath: string,
  symbolNames: string[],
  callTarget: string | null,
): CodeGraphFileFacts {
  const fileId = fileRowId(REPO, relativePath);
  const symbols: CodeGraphSymbolRecord[] = symbolNames.map((name, i) => ({
    id: symbolRowId(REPO, symbolQualifiedName(relativePath, [], name)),
    repositoryId: REPO,
    fileId,
    kind: 'function',
    name,
    qualifiedName: symbolQualifiedName(relativePath, [], name),
    parentSymbolId: null,
    lineStart: i + 1,
    lineEnd: i + 1,
    byteStart: i * 10,
    byteEnd: i * 10 + 5,
    signature: `function ${name}()`,
    exported: true,
    isTest: false,
    extra: {},
  }));
  const edges: CodeGraphEdgeRecord[] = [];
  if (callTarget !== null && symbols.length > 0) {
    edges.push({
      id: edgeRowId({
        repoId: REPO,
        kind: 'CALLS',
        sourceId: symbols[0].id,
        target: callTarget,
        line: 2,
      }),
      repositoryId: REPO,
      kind: 'CALLS',
      sourceSymbolId: symbols[0].id,
      targetSymbolId: null,
      sourceFileId: fileId,
      targetRef: callTarget,
      line: 2,
      confidenceTier: 'EXTRACTED',
      confidenceScore: 1.0,
      resolverId: null,
      evidence: {},
    });
  }
  return {
    file: {
      id: fileId,
      repositoryId: REPO,
      relativePath,
      absolutePath: `/abs/${relativePath}`,
      language: 'typescript',
      contentHash: 'hash-1',
      sizeBytes: 100,
      mtimeNs: '1700000000000000000',
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

describe('CodeGraphStore', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-store-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaceFileFacts is idempotent and fully replaces prior facts', () => {
    store.replaceFileFacts(makeFacts('src/a.ts', ['alpha', 'beta'], 'gamma'));
    store.replaceFileFacts(makeFacts('src/a.ts', ['alpha', 'beta'], 'gamma'));
    expect(store.countSymbols()).toBe(2);
    expect(store.countEdges()).toBe(1);
    store.replaceFileFacts(makeFacts('src/a.ts', ['alpha'], null));
    expect(store.countSymbols()).toBe(1);
    expect(store.countEdges()).toBe(0);
  });

  it('removeFiles deletes facts and file index entries', () => {
    store.replaceFileFacts(makeFacts('src/a.ts', ['alpha'], 'x'));
    store.replaceFileFacts(makeFacts('src/b.ts', ['bravo'], null));
    store.removeFiles(REPO, ['src/a.ts']);
    expect(store.listFileIndex(REPO).map((f) => f.relativePath)).toEqual([
      'src/b.ts',
    ]);
    expect(store.countSymbols()).toBe(1);
    expect(store.countEdges()).toBe(0);
  });

  it('nullDanglingEdgeTargets downgrades edges whose target symbol vanished', () => {
    store.replaceFileFacts(makeFacts('src/a.ts', ['alpha'], 'bravo'));
    store.replaceFileFacts(makeFacts('src/b.ts', ['bravo'], null));
    const edge = store.listEdges({ kind: 'CALLS' })[0];
    const bravoId = symbolRowId(
      REPO,
      symbolQualifiedName('src/b.ts', [], 'bravo'),
    );
    store.updateEdgeResolution(edge.id, {
      targetSymbolId: bravoId,
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.9,
      resolverId: 'import-binding',
      evidence: { via: 'test' },
    });
    expect(store.listEdges({ unresolvedOnly: true })).toHaveLength(0);
    store.removeFiles(REPO, ['src/b.ts']);
    expect(store.nullDanglingEdgeTargets()).toBe(1);
    const downgraded = store.listEdges({ kind: 'CALLS' })[0];
    expect(downgraded.targetSymbolId).toBeNull();
    expect(downgraded.targetRef).toBe('bravo');
    expect(downgraded.confidenceTier).toBe('EXTRACTED');
  });

  it('round-trips symbol records through getSymbolByQualifiedName', () => {
    store.replaceFileFacts(makeFacts('src/a.ts', ['alpha'], null));
    const found = store.getSymbolByQualifiedName('src/a.ts::alpha', REPO);
    expect(found).not.toBeNull();
    expect(found?.kind).toBe('function');
    expect(found?.exported).toBe(true);
    expect(found?.extra).toEqual({});
    // F4: the record carries the RAW repo id (not the hashed row id), so it
    // round-trips back through insert paths without double-hashing.
    expect(found?.repositoryId).toBe(REPO);
  });

  it('bounds SQL preparation for repeated resolution writes and reads without caching rows', () => {
    store.replaceFileFacts(makeFacts('src/a.ts', ['alpha'], 'bravo'));
    const edge = store.listEdges({ kind: 'CALLS' })[0];
    const prepare = jest.spyOn(db, 'prepare');
    try {
      for (let i = 0; i < 100; i++) {
        store.updateEdgeResolution(edge.id, {
          targetSymbolId: `target-${i}`,
          confidenceTier: 'RESOLVED',
          confidenceScore: 0.9,
          resolverId: 'import-binding',
          evidence: { iteration: i },
        });
        expect(store.getFileById(edge.sourceFileId)?.relativePath).toBe(
          'src/a.ts',
        );
        expect(
          store.getSymbolByQualifiedName('src/a.ts::alpha', REPO)?.name,
        ).toBe('alpha');
      }
      expect(prepare.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      prepare.mockRestore();
    }
    expect(store.listEdges({ kind: 'CALLS' })[0]).toMatchObject({
      targetSymbolId: 'target-99',
      evidence: { iteration: 99 },
    });
    store.replaceFileFacts(makeFacts('src/a.ts', ['changed'], null));
    expect(store.getSymbolByQualifiedName('src/a.ts::alpha', REPO)).toBeNull();
    expect(
      store.getSymbolByQualifiedName('src/a.ts::changed', REPO)?.name,
    ).toBe('changed');
  });

  it('countUnresolvedEdges counts unresolved DOCUMENTS edges but not unresolved TESTED_BY edges', () => {
    const relativePath = 'src/a.ts';
    const fileId = fileRowId(REPO, relativePath);
    const facts = makeFacts(relativePath, ['alpha'], null);
    const sourceId = facts.symbols[0].id;
    facts.edges.push({
      id: edgeRowId({
        repoId: REPO,
        kind: 'DOCUMENTS',
        sourceId,
        target: 'docs/readme.md::intro',
        line: 3,
      }),
      repositoryId: REPO,
      kind: 'DOCUMENTS',
      sourceSymbolId: sourceId,
      targetSymbolId: null,
      sourceFileId: fileId,
      targetRef: 'docs/readme.md::intro',
      line: 3,
      confidenceTier: 'EXTRACTED',
      confidenceScore: 1.0,
      resolverId: null,
      evidence: {},
    });
    facts.edges.push({
      id: edgeRowId({
        repoId: REPO,
        kind: 'TESTED_BY',
        sourceId,
        target: 'unresolved-test-file',
        line: null,
      }),
      repositoryId: REPO,
      kind: 'TESTED_BY',
      sourceSymbolId: sourceId,
      targetSymbolId: null,
      sourceFileId: fileId,
      targetRef: null,
      line: null,
      confidenceTier: 'INFERRED',
      confidenceScore: 0.8,
      resolverId: 'test-linker',
      evidence: {},
    });
    store.replaceFileFacts(facts);
    expect(store.countUnresolvedEdges()).toBe(1);
  });

  it('countUnresolvedEdges counts unresolved IPC_HANDLES, IPC_INVOKES, and USES_PIPELINE_ACTION edges but not unresolved DECLARES_MCP_TOOL edges (P5: canopy-semantics kinds)', () => {
    const relativePath = 'src/a.ts';
    const fileId = fileRowId(REPO, relativePath);
    const facts = makeFacts(relativePath, ['alpha'], null);
    const sourceId = facts.symbols[0].id;
    const resolvableKinds: CodeGraphEdgeRecord['kind'][] = [
      'IPC_HANDLES',
      'IPC_INVOKES',
      'USES_PIPELINE_ACTION',
    ];
    for (const kind of resolvableKinds) {
      facts.edges.push({
        id: edgeRowId({
          repoId: REPO,
          kind,
          sourceId,
          target: `unresolved-${kind}`,
          line: 3,
        }),
        repositoryId: REPO,
        kind,
        sourceSymbolId: sourceId,
        targetSymbolId: null,
        sourceFileId: fileId,
        targetRef: `unresolved-${kind}`,
        line: 3,
        confidenceTier: 'EXTRACTED',
        confidenceScore: 1.0,
        resolverId: null,
        evidence: {},
      });
    }
    // DECLARES_MCP_TOOL is structural (always resolved at parse time, like
    // DECLARES_SCRIPT/DECLARES_DEPENDENCY/CONFIGURES/RATIONALE_FOR) so it must
    // NOT count toward the unresolved total even with a null target.
    facts.edges.push({
      id: edgeRowId({
        repoId: REPO,
        kind: 'DECLARES_MCP_TOOL',
        sourceId,
        target: 'unresolved-mcp-tool',
        line: 4,
      }),
      repositoryId: REPO,
      kind: 'DECLARES_MCP_TOOL',
      sourceSymbolId: sourceId,
      targetSymbolId: null,
      sourceFileId: fileId,
      targetRef: 'unresolved-mcp-tool',
      line: 4,
      confidenceTier: 'EXTRACTED',
      confidenceScore: 1.0,
      resolverId: null,
      evidence: {},
    });
    store.replaceFileFacts(facts);
    expect(store.countUnresolvedEdges()).toBe(3);
  });

  it('countUnresolvedEdges drops once resolve/workflow-action-resolver.ts binds the local ref in a mixed local+external fixture (P6: local workflow-action resolution un-inerts this floor)', () => {
    const workflowPath = '.github/workflows/ci.yml';
    const manifestPath = '.github/actions/local-thing/action.yml';

    const jobId = symbolRowId(
      REPO,
      symbolQualifiedName(workflowPath, ['jobs'], 'build'),
    );
    const jobSymbol: CodeGraphSymbolRecord = {
      id: jobId,
      repositoryId: REPO,
      fileId: fileRowId(REPO, workflowPath),
      kind: 'workflow_job',
      name: 'build',
      qualifiedName: symbolQualifiedName(workflowPath, ['jobs'], 'build'),
      parentSymbolId: null,
      lineStart: 2,
      lineEnd: 5,
      byteStart: 0,
      byteEnd: 0,
      signature: null,
      exported: false,
      isTest: false,
      extra: {},
    };
    function usesEdge(
      targetRef: string,
      stepIndex: number,
    ): CodeGraphEdgeRecord {
      return {
        id: edgeRowId({
          repoId: REPO,
          kind: 'USES_PIPELINE_ACTION',
          sourceId: jobId,
          target: `${targetRef}#${stepIndex}`,
          line: 3 + stepIndex,
        }),
        repositoryId: REPO,
        kind: 'USES_PIPELINE_ACTION',
        sourceSymbolId: jobId,
        targetSymbolId: null,
        sourceFileId: fileRowId(REPO, workflowPath),
        targetRef,
        line: 3 + stepIndex,
        confidenceTier: 'EXTRACTED',
        confidenceScore: 1.0,
        resolverId: null,
        evidence: { stepIndex },
      };
    }
    store.replaceFileFacts({
      file: {
        id: fileRowId(REPO, workflowPath),
        repositoryId: REPO,
        relativePath: workflowPath,
        absolutePath: `/abs/${workflowPath}`,
        language: 'github-workflow',
        contentHash: 'hash-workflow',
        sizeBytes: 100,
        mtimeNs: '1',
        lineCount: 10,
        grammarId: 'github-workflow',
        grammarAbi: null,
        parseStatus: 'parsed',
        hasErrors: false,
        updatedAt: Date.now(),
      },
      symbols: [jobSymbol],
      edges: [
        usesEdge('./.github/actions/local-thing', 0),
        usesEdge('actions/checkout@v4', 1),
      ],
    });

    // The referenced action's manifest must itself be a real file symbol in
    // the graph -- normally produced by extract/extractor-registry.ts's
    // `github-action-manifest` matcher, fabricated directly here the same way
    // ipc-resolver.test.ts fabricates an ipc_channel declaration.
    const manifestFileSymbol: CodeGraphSymbolRecord = {
      id: symbolRowId(REPO, fileQualifiedName(manifestPath)),
      repositoryId: REPO,
      fileId: fileRowId(REPO, manifestPath),
      kind: 'file',
      name: 'action.yml',
      qualifiedName: fileQualifiedName(manifestPath),
      parentSymbolId: null,
      lineStart: 1,
      lineEnd: 5,
      byteStart: 0,
      byteEnd: 50,
      signature: null,
      exported: false,
      isTest: false,
      extra: {},
    };
    store.replaceFileFacts({
      file: {
        id: fileRowId(REPO, manifestPath),
        repositoryId: REPO,
        relativePath: manifestPath,
        absolutePath: `/abs/${manifestPath}`,
        language: 'github-action-manifest',
        contentHash: 'hash-manifest',
        sizeBytes: 50,
        mtimeNs: '1',
        lineCount: 5,
        grammarId: 'github-action-manifest',
        grammarAbi: null,
        parseStatus: 'parsed',
        hasErrors: false,
        updatedAt: Date.now(),
      },
      symbols: [manifestFileSymbol],
      edges: [],
    });

    // Both USES_PIPELINE_ACTION edges are unresolved before the resolver runs.
    expect(store.countUnresolvedEdges()).toBe(2);

    const resolved = resolveWorkflowActionEdges({ store, repoId: REPO });
    expect(resolved).toBe(1);

    // The local ref now binds and drops out of the count; the external ref
    // has no local symbol it could ever resolve to and keeps counting
    // forever -- a permanent floor from external refs alone, not local ones.
    expect(store.countUnresolvedEdges()).toBe(1);
  });
});
