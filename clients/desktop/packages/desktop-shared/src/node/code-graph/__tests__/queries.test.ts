import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { rebuildSymbolFts } from '../store/fts';
import { CodeGraphQueryService } from '../query/queries';
import { CodeGraphEngine } from '../engine';
import {
  edgeRowId,
  fileQualifiedName,
  fileRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import type {
  CodeGraphCommunityMembershipRecord,
  CodeGraphCommunityRecord,
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphFlowMembershipRecord,
  CodeGraphFlowRecord,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';

const REPO = 'repo-a';

// All fixture helpers accept an optional trailing repoId (default REPO) so
// the repoId-scoping describe below can reuse them for multi-repo seeding.
function fileSymbol(
  relativePath: string,
  isTest: boolean,
  repoId: string = REPO,
): CodeGraphSymbolRecord {
  return {
    id: symbolRowId(repoId, fileQualifiedName(relativePath)),
    repositoryId: repoId,
    fileId: fileRowId(repoId, relativePath),
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
  repoId: string = REPO,
): CodeGraphSymbolRecord {
  return {
    ...fileSymbol(relativePath, isTest, repoId),
    id: symbolRowId(repoId, symbolQualifiedName(relativePath, [], name)),
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
  repoId: string = REPO,
): CodeGraphFileFacts {
  return {
    file: {
      id: fileRowId(repoId, relativePath),
      repositoryId: repoId,
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

function docSectionSymbol(
  relativePath: string,
  slug: string,
  repoId: string = REPO,
): CodeGraphSymbolRecord {
  return {
    ...fileSymbol(relativePath, false, repoId),
    id: symbolRowId(repoId, symbolQualifiedName(relativePath, [], slug)),
    kind: 'doc_section',
    name: slug,
    qualifiedName: symbolQualifiedName(relativePath, [], slug),
    lineStart: 1,
    lineEnd: 3,
    byteStart: 0,
    byteEnd: 20,
    signature: null,
  };
}

function scriptSymbol(
  relativePath: string,
  name: string,
  command: string,
  repoId: string = REPO,
): CodeGraphSymbolRecord {
  return {
    ...fileSymbol(relativePath, false, repoId),
    id: symbolRowId(
      repoId,
      symbolQualifiedName(relativePath, ['scripts'], name),
    ),
    kind: 'script',
    name,
    qualifiedName: symbolQualifiedName(relativePath, ['scripts'], name),
    lineStart: 2,
    lineEnd: 2,
    byteStart: 0,
    byteEnd: 0,
    signature: command,
  };
}

function rationaleSymbol(
  relativePath: string,
  marker: string,
  text: string,
  line: number,
  repoId: string = REPO,
): CodeGraphSymbolRecord {
  const qualifiedName = `${fileQualifiedName(relativePath)}::rationale.L${line}`;
  return {
    ...fileSymbol(relativePath, false, repoId),
    id: symbolRowId(repoId, qualifiedName),
    kind: 'rationale',
    name: marker,
    qualifiedName,
    lineStart: line,
    lineEnd: line,
    byteStart: 0,
    byteEnd: 0,
    signature: text,
  };
}

function ipcChannelSymbol(
  relativePath: string,
  name: string,
  repoId: string = REPO,
): CodeGraphSymbolRecord {
  return {
    ...fileSymbol(relativePath, false, repoId),
    id: symbolRowId(repoId, symbolQualifiedName(relativePath, [], name)),
    kind: 'ipc_channel',
    name,
    qualifiedName: symbolQualifiedName(relativePath, [], name),
    lineStart: 1,
    lineEnd: 1,
    byteStart: 0,
    byteEnd: 0,
    signature: null,
  };
}

function workflowJobSymbol(
  relativePath: string,
  name: string,
  repoId: string = REPO,
): CodeGraphSymbolRecord {
  return {
    ...fileSymbol(relativePath, false, repoId),
    id: symbolRowId(repoId, symbolQualifiedName(relativePath, [], name)),
    kind: 'workflow_job',
    name,
    qualifiedName: symbolQualifiedName(relativePath, [], name),
    lineStart: 2,
    lineEnd: 5,
    byteStart: 0,
    byteEnd: 0,
    signature: null,
  };
}

// Stands in for the referenced pipeline action (a marketplace or local
// composite action) that a workflow_job's USES_PIPELINE_ACTION edge targets.
// Reuses the existing 'dependency' kind since a referenced action is, like a
// package.json dependency, an external declared reference rather than a
// symbol defined by the workflow file itself.
function actionSymbol(
  relativePath: string,
  name: string,
  repoId: string = REPO,
): CodeGraphSymbolRecord {
  return {
    ...fileSymbol(relativePath, false, repoId),
    id: symbolRowId(repoId, symbolQualifiedName(relativePath, [], name)),
    kind: 'dependency',
    name,
    qualifiedName: symbolQualifiedName(relativePath, [], name),
    lineStart: 3,
    lineEnd: 3,
    byteStart: 0,
    byteEnd: 0,
    signature: null,
  };
}

// Structural (non-CALLS) edge builder for DOCUMENTS/DECLARES_SCRIPT/
// RATIONALE_FOR fixtures below — mirrors `resolvedCall`'s shape further down
// this file but generalized over `kind` and confidence tier so it can build
// an already-RESOLVED DOCUMENTS edge without going through the real
// doc-link-resolver pass.
function structuralEdge(input: {
  repoId: string;
  kind: CodeGraphEdgeRecord['kind'];
  sourceSymbolId: string;
  targetSymbolId: string;
  sourceFileId: string;
  line: number | null;
  resolved?: boolean;
}): CodeGraphEdgeRecord {
  const resolved = input.resolved ?? false;
  return {
    id: edgeRowId({
      repoId: input.repoId,
      kind: input.kind,
      sourceId: input.sourceSymbolId,
      target: input.targetSymbolId,
      line: input.line,
    }),
    repositoryId: input.repoId,
    kind: input.kind,
    sourceSymbolId: input.sourceSymbolId,
    targetSymbolId: input.targetSymbolId,
    sourceFileId: input.sourceFileId,
    targetRef: null,
    line: input.line,
    confidenceTier: resolved ? 'RESOLVED' : 'EXTRACTED',
    confidenceScore: resolved ? 0.95 : 1.0,
    resolverId: resolved ? 'doc-link' : null,
    evidence: {},
  };
}

function callEdge(
  relativePath: string,
  sourceId: string,
  targetRef: string,
  line: number,
  repoId: string = REPO,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId,
      kind: 'CALLS',
      sourceId,
      target: targetRef,
      line,
    }),
    repositoryId: repoId,
    kind: 'CALLS',
    sourceSymbolId: sourceId,
    targetSymbolId: null,
    sourceFileId: fileRowId(repoId, relativePath),
    targetRef,
    line,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1.0,
    resolverId: null,
    evidence: {},
  };
}

describe('CodeGraphQueryService', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let service: CodeGraphQueryService;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-queries-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });

    // lib.ts: exports doWork; worker.ts: caller() calls doWork (imported) and helper (local)
    const libFile = fileSymbol('src/lib.ts', false);
    const doWork = {
      ...fnSymbol('src/lib.ts', 'doWork', false),
      exported: true,
    };
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

    resolveCallEdges({ store, repoId: REPO });
    linkTests({ store, repoId: REPO });
    rebuildSymbolFts(db);
    service = new CodeGraphQueryService(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds bounded directed and explanatory paths with source evidence', () => {
    const forward = service.getRelationshipPath({
      target: 'src/worker.ts::caller',
      to: 'src/lib.ts::doWork',
      mode: 'call-path',
      repoId: REPO,
    });
    expect(forward.status).toBe('found');
    expect(forward.hops).toHaveLength(1);
    expect(forward.hops[0]).toMatchObject({
      kind: 'CALLS',
      direction: 'forward',
      filePath: 'src/worker.ts',
      line: 3,
      confidenceTier: 'RESOLVED',
    });
    expect(
      service.getRelationshipPath({
        target: 'src/lib.ts::doWork',
        to: 'src/worker.ts::caller',
        mode: 'call-path',
        repoId: REPO,
      }).status,
    ).toBe('no-path');
    expect(
      service.getRelationshipPath({
        target: 'src/lib.ts::doWork',
        to: 'src/worker.ts::caller',
        mode: 'relationship-path',
        repoId: REPO,
      }).hops[0].direction,
    ).toBe('reverse');
  });

  it('bounds cycles, depth and examined edges, including unresolved references', () => {
    const helper = fnSymbol('src/worker.ts', 'helper', false);
    const caller = fnSymbol('src/worker.ts', 'caller', false);
    store.insertEdges([
      {
        ...callEdge('src/worker.ts', helper.id, 'caller', 8),
        targetSymbolId: caller.id,
      },
    ]);
    const input = {
      target: helper.qualifiedName,
      to: 'src/lib.ts::doWork',
      mode: 'call-path' as const,
      repoId: REPO,
    };
    expect(service.getRelationshipPath({ ...input, maxDepth: 1 }).status).toBe(
      'budget-exhausted',
    );
    expect(
      service.getRelationshipPath({ ...input, maxDepth: 2 }).hops,
    ).toHaveLength(2);
    const absent = { ...input, to: 'src/__tests__/lib.test.ts::runsDoWork' };
    expect(service.getRelationshipPath(absent).status).toBe('no-path');
    store.insertEdges(
      Array.from({ length: 5100 }, (_, index) =>
        callEdge('src/worker.ts', helper.id, `unresolved${index}`, index + 10),
      ),
    );
    expect(service.getRelationshipPath(absent)).toMatchObject({
      status: 'budget-exhausted',
      visitedEdges: 5000,
    });
  });

  it('does not charge non-call edges against a directed call-path budget', () => {
    const sourceFile = fileSymbol('src/budget.ts', false);
    const source = fnSymbol('src/budget.ts', 'source', false);
    const target = fnSymbol('src/budget.ts', 'target', false);
    store.replaceFileFacts(
      facts(
        'src/budget.ts',
        [sourceFile, source, target],
        [
          structuralEdge({
            repoId: REPO,
            kind: 'CONTAINS',
            sourceSymbolId: source.id,
            targetSymbolId: sourceFile.id,
            sourceFileId: sourceFile.fileId,
            line: 1,
          }),
          {
            ...callEdge('src/budget.ts', source.id, 'target', 2),
            targetSymbolId: target.id,
          },
        ],
      ),
    );

    expect(
      service.getRelationshipPath({
        target: source.qualifiedName,
        to: target.qualifiedName,
        mode: 'call-path',
        repoId: REPO,
      }),
    ).toMatchObject({
      status: 'found',
      visitedEdges: 1,
      limits: { maxEdges: 5000 },
    });
  });

  it('reports ambiguous endpoints and bounds oversized evidence explicitly', () => {
    const edge = store
      .listEdges({ kind: 'CALLS', repoId: REPO })
      .find(
        (value) =>
          value.targetRef === 'doWork' &&
          value.sourceFileId === fileRowId(REPO, 'src/worker.ts'),
      );
    if (edge === undefined) throw new Error('Missing fixture call');
    store.updateEdgeEvidence(edge.id, { raw: 'x'.repeat(10000) });
    const input = {
      target: 'src/worker.ts::caller',
      to: 'src/lib.ts::doWork',
      mode: 'call-path' as const,
    };
    const hop = service.getRelationshipPath(input).hops[0];
    expect(hop.evidenceTruncated).toBe(true);
    expect(hop.evidence.length).toBe(2048);
    store.upsertRepository({
      repoId: 'other',
      rootPath: '/other',
      gitHead: null,
    });
    store.replaceFileFacts(
      facts(
        'src/lib.ts',
        [
          fileSymbol('src/lib.ts', false, 'other'),
          fnSymbol('src/lib.ts', 'doWork', false, 'other'),
        ],
        [],
        'other',
      ),
    );
    expect(service.getRelationshipPath(input).status).toBe(
      'ambiguous-endpoint',
    );
    expect(service.getRelationshipPath({ ...input, repoId: REPO }).status).toBe(
      'found',
    );
  });

  it('distinguishes missing endpoints, identity, and exhausted budgets', () => {
    const input = {
      target: 'src/worker.ts::caller',
      to: 'src/lib.ts::doWork',
      mode: 'call-path' as const,
      repoId: REPO,
    };
    expect(
      service.getRelationshipPath({ ...input, to: 'missing' }).status,
    ).toBe('endpoint-not-found');
    expect(
      service.getRelationshipPath({ ...input, to: input.target }),
    ).toMatchObject({ status: 'found', hops: [] });
    expect(service.getRelationshipPath({ ...input, maxNodes: 1 }).status).toBe(
      'budget-exhausted',
    );
    expect(
      service.getRelationshipPath({ ...input, repoId: 'another' }).status,
    ).toBe('endpoint-not-found');
  });

  it('returns callers with location info', () => {
    const callers = service.getCallers('src/lib.ts::doWork');
    expect(callers.map((c) => c.qualifiedName).sort()).toEqual([
      'src/__tests__/lib.test.ts::runsDoWork',
      'src/worker.ts::caller',
    ]);
    expect(callers[0].filePath).toBeTruthy();
  });

  it('canonicalizes qualifiedName input (backslash path, dot-slash path)', () => {
    const canonical = service.getCallers('src/lib.ts::doWork');
    const viaBackslash = service.getCallers('src\\lib.ts::doWork');
    const viaDotSlash = service.getCallers('./src/lib.ts::doWork');
    expect(viaBackslash.map((c) => c.qualifiedName).sort()).toEqual(
      canonical.map((c) => c.qualifiedName).sort(),
    );
    expect(viaDotSlash.map((c) => c.qualifiedName).sort()).toEqual(
      canonical.map((c) => c.qualifiedName).sort(),
    );
    expect(canonical.length).toBeGreaterThan(0);
  });

  it('returns callees for a symbol', () => {
    const callees = service.getCallees('src/worker.ts::caller');
    expect(callees.map((c) => c.qualifiedName).sort()).toEqual([
      'src/lib.ts::doWork',
      'src/worker.ts::helper',
    ]);
  });

  it('returns importers of a file', () => {
    expect(service.getImporters('src/lib.ts').sort()).toEqual([
      'src/__tests__/lib.test.ts',
      'src/worker.ts',
    ]);
  });

  it('returns tests covering a symbol', () => {
    expect(service.getTestsFor('src/lib.ts::doWork')).toEqual([
      'src/__tests__/lib.test.ts',
    ]);
  });

  it('summarizes a file', () => {
    const summary = service.getFileSummary('src/worker.ts');
    expect(summary?.symbols.map((s) => s.qualifiedName)).toContain(
      'src/worker.ts::caller',
    );
    expect(summary?.imports).toEqual(['./lib']);
    expect(service.getFileSummary('src/nope.ts')).toBeNull();
  });

  it('returns resolved imports for a file', () => {
    const imports = service.getImports('src/worker.ts');
    expect(imports).toEqual([
      {
        qualifiedName: 'src/lib.ts',
        kind: 'file',
        filePath: 'src/lib.ts',
        line: 1,
      },
    ]);
    expect(service.getImports('src/lib.ts')).toEqual([]);
    expect(service.getImports('src/nope.ts')).toEqual([]);
  });

  it('returns child symbols nested under a parent symbol', () => {
    const classSymbol: CodeGraphSymbolRecord = {
      ...fileSymbol('src/widget.ts', false),
      id: symbolRowId(REPO, symbolQualifiedName('src/widget.ts', [], 'Widget')),
      kind: 'class',
      name: 'Widget',
      qualifiedName: symbolQualifiedName('src/widget.ts', [], 'Widget'),
      lineStart: 1,
      lineEnd: 10,
      byteStart: 0,
      byteEnd: 100,
      signature: 'class Widget',
    };
    const methodSymbol: CodeGraphSymbolRecord = {
      ...classSymbol,
      id: symbolRowId(
        REPO,
        symbolQualifiedName('src/widget.ts', ['Widget'], 'render'),
      ),
      kind: 'method',
      name: 'render',
      qualifiedName: symbolQualifiedName('src/widget.ts', ['Widget'], 'render'),
      parentSymbolId: classSymbol.id,
      lineStart: 2,
      lineEnd: 4,
      byteStart: 10,
      byteEnd: 50,
      signature: 'render()',
    };
    store.replaceFileFacts(
      facts(
        'src/widget.ts',
        [fileSymbol('src/widget.ts', false), classSymbol, methodSymbol],
        [],
      ),
    );

    expect(service.getChildren('src/widget.ts::Widget')).toEqual([
      {
        qualifiedName: 'src/widget.ts::Widget.render',
        kind: 'method',
        filePath: 'src/widget.ts',
        line: 2,
      },
    ]);
    expect(service.getChildren('src/widget.ts::Widget.render')).toEqual([]);
    expect(service.getChildren('src/nope.ts::Nope')).toEqual([]);
  });

  it('returns full symbol detail for explain', () => {
    expect(service.getSymbolDetail('src/lib.ts::doWork')).toEqual({
      qualifiedName: 'src/lib.ts::doWork',
      kind: 'function',
      filePath: 'src/lib.ts',
      lineStart: 2,
      lineEnd: 4,
      signature: 'function doWork()',
      exported: true,
    });
    expect(service.getSymbolDetail('src/lib.ts::nope')).toBeNull();
  });

  it('searches symbols through FTS', () => {
    const results = service.search('doWork');
    expect(results.some((r) => r.qualifiedName === 'src/lib.ts::doWork')).toBe(
      true,
    );
  });

  it('computes a bounded impact radius', () => {
    const impact = service.getImpactRadius('src/lib.ts::doWork', {
      maxDepth: 2,
      maxNodes: 10,
    });
    const names = impact.map((i) => i.qualifiedName);
    expect(names).toContain('src/worker.ts::caller');
    expect(impact.every((i) => i.depth >= 1 && i.depth <= 2)).toBe(true);
  });

  it('includes a doc_section that documents a changed file at depth 1 (Task 7: DOCUMENTS reverse traversal)', () => {
    const docsFile = fileSymbol('docs.md', false);
    const docSection = docSectionSymbol('docs.md', 'intro');
    store.replaceFileFacts(
      facts(
        'docs.md',
        [docsFile, docSection],
        [
          structuralEdge({
            repoId: REPO,
            kind: 'DOCUMENTS',
            sourceSymbolId: docSection.id,
            targetSymbolId: symbolRowId(REPO, fileQualifiedName('src/lib.ts')),
            sourceFileId: fileRowId(REPO, 'docs.md'),
            line: 3,
            resolved: true,
          }),
        ],
      ),
    );

    // Impact of the FILE (not a specific symbol inside it) — DOCUMENTS edges
    // only ever target file symbols (see doc-link-resolver.ts), so only a
    // file-level impact query walks this reverse edge.
    const impact = service.getImpactRadius('src/lib.ts', {
      maxDepth: 2,
      maxNodes: 20,
    });
    const docHit = impact.find(
      (entry) => entry.qualifiedName === 'docs.md::intro',
    );
    expect(docHit).toBeDefined();
    expect(docHit?.depth).toBe(1);
    expect(docHit?.kind).toBe('doc_section');
  });
});

describe('CodeGraphQueryService getImpactRadius TESTED_BY direction (F2)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let service: CodeGraphQueryService;

  function resolvedCall(
    relativePath: string,
    sourceId: string,
    targetRef: string,
    targetSymbolId: string,
    line: number,
  ): CodeGraphEdgeRecord {
    return {
      ...callEdge(relativePath, sourceId, targetRef, line),
      targetSymbolId,
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.9,
      resolverId: 'import-binding',
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-impact-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });

    // Two sibling production symbols that share nothing but a common test file.
    const prodFile = fileSymbol('src/prod.ts', false);
    const doWork = fnSymbol('src/prod.ts', 'doWork', false);
    const sibling = fnSymbol('src/prod.ts', 'sibling', false);
    store.replaceFileFacts(
      facts('src/prod.ts', [prodFile, doWork, sibling], []),
    );

    // One test file whose top-level body calls BOTH production symbols, so
    // linkTests links each of them to the same test file symbol.
    const testFile = fileSymbol('src/__tests__/prod.test.ts', true);
    store.replaceFileFacts(
      facts(
        'src/__tests__/prod.test.ts',
        [testFile],
        [
          resolvedCall(
            'src/__tests__/prod.test.ts',
            testFile.id,
            'doWork',
            doWork.id,
            2,
          ),
          resolvedCall(
            'src/__tests__/prod.test.ts',
            testFile.id,
            'sibling',
            sibling.id,
            3,
          ),
        ],
      ),
    );

    linkTests({ store, repoId: REPO });
    service = new CodeGraphQueryService(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not pull an unrelated sibling that merely shares a test file', () => {
    const impact = service.getImpactRadius('src/prod.ts::doWork', {
      maxDepth: 3,
      maxNodes: 50,
    });
    const names = impact.map((i) => i.qualifiedName);
    // The test file itself is reachable (its top-level body calls doWork)...
    expect(names).toContain('src/__tests__/prod.test.ts');
    // ...but its unrelated sibling must NOT bleed into doWork's impact set via
    // the shared TESTED_BY test-file symbol.
    expect(names).not.toContain('src/prod.ts::sibling');
  });
});

describe('CodeGraphQueryService getImpactRadius IPC/workflow edge kinds (P5)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let service: CodeGraphQueryService;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-impact-ipc-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });

    // ipc_channel symbol declared in a dedicated channels module; a main-
    // process handler registers it and a renderer/preload invoker calls it.
    const channelFile = fileSymbol('src/main/ipc-channels.ts', false);
    const channel = ipcChannelSymbol(
      'src/main/ipc-channels.ts',
      'WORKTREE_CREATE',
    );
    store.replaceFileFacts(
      facts('src/main/ipc-channels.ts', [channelFile, channel], []),
    );

    const handlerFile = fileSymbol('src/main/ipc/worktrees.ts', false);
    const handler = fnSymbol(
      'src/main/ipc/worktrees.ts',
      'handleWorktreeCreate',
      false,
    );
    store.replaceFileFacts(
      facts(
        'src/main/ipc/worktrees.ts',
        [handlerFile, handler],
        [
          structuralEdge({
            repoId: REPO,
            kind: 'IPC_HANDLES',
            sourceSymbolId: handler.id,
            targetSymbolId: channel.id,
            sourceFileId: fileRowId(REPO, 'src/main/ipc/worktrees.ts'),
            line: 5,
            resolved: true,
          }),
        ],
      ),
    );

    const invokerFile = fileSymbol('src/renderer/api.ts', false);
    const invoker = fnSymbol('src/renderer/api.ts', 'createWorktree', false);
    store.replaceFileFacts(
      facts(
        'src/renderer/api.ts',
        [invokerFile, invoker],
        [
          structuralEdge({
            repoId: REPO,
            kind: 'IPC_INVOKES',
            sourceSymbolId: invoker.id,
            targetSymbolId: channel.id,
            sourceFileId: fileRowId(REPO, 'src/renderer/api.ts'),
            line: 8,
            resolved: true,
          }),
        ],
      ),
    );

    // workflow_job symbol that references (USES_PIPELINE_ACTION) a marketplace
    // action, modeled as a 'dependency' target symbol.
    const workflowFile = fileSymbol('.github/workflows/ci.yml', false);
    const job = workflowJobSymbol('.github/workflows/ci.yml', 'build');
    const action = actionSymbol(
      '.github/workflows/ci.yml',
      'actions-checkout-v4',
    );
    store.replaceFileFacts(
      facts(
        '.github/workflows/ci.yml',
        [workflowFile, job, action],
        [
          structuralEdge({
            repoId: REPO,
            kind: 'USES_PIPELINE_ACTION',
            sourceSymbolId: job.id,
            targetSymbolId: action.id,
            sourceFileId: fileRowId(REPO, '.github/workflows/ci.yml'),
            line: 3,
            resolved: true,
          }),
        ],
      ),
    );

    service = new CodeGraphQueryService(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('impact of an ipc_channel includes the IPC_INVOKES invoker but excludes the IPC_HANDLES handler', () => {
    // The handler IS the channel's implementation: its own edits already
    // surface by running impact analysis starting from the handler symbol
    // itself, so walking channel -> handler here would treat the
    // implementation as merely "impacted" by its own contract, inverting the
    // real dependency direction. The invoker genuinely depends on the
    // channel's contract, so it belongs in the impact set.
    const impact = service.getImpactRadius(
      'src/main/ipc-channels.ts::WORKTREE_CREATE',
      { maxDepth: 2, maxNodes: 20 },
    );
    const names = impact.map((i) => i.qualifiedName);
    expect(names).toContain('src/renderer/api.ts::createWorktree');
    expect(names).not.toContain(
      'src/main/ipc/worktrees.ts::handleWorktreeCreate',
    );
  });

  it('impact of a referenced pipeline action includes the workflow_job that uses it', () => {
    const impact = service.getImpactRadius(
      '.github/workflows/ci.yml::actions-checkout-v4',
      { maxDepth: 2, maxNodes: 20 },
    );
    const names = impact.map((i) => i.qualifiedName);
    expect(names).toContain('.github/workflows/ci.yml::build');
  });
});

describe('CodeGraphQueryService getIpcChannel (P5)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let service: CodeGraphQueryService;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-ipc-channel-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });

    const channelFile = fileSymbol('src/shared/ipc-channels.ts', false);
    const channel = ipcChannelSymbol(
      'src/shared/ipc-channels.ts',
      'panelLayoutLoad',
    );
    store.replaceFileFacts(
      facts('src/shared/ipc-channels.ts', [channelFile, channel], []),
    );

    const handlerFile = fileSymbol('src/main/ipc/panel.ts', false);
    const handler = fnSymbol(
      'src/main/ipc/panel.ts',
      'handlePanelLayoutLoad',
      false,
    );
    store.replaceFileFacts(
      facts(
        'src/main/ipc/panel.ts',
        [handlerFile, handler],
        [
          structuralEdge({
            repoId: REPO,
            kind: 'IPC_HANDLES',
            sourceSymbolId: handler.id,
            targetSymbolId: channel.id,
            sourceFileId: fileRowId(REPO, 'src/main/ipc/panel.ts'),
            line: 4,
            resolved: true,
          }),
        ],
      ),
    );

    const invokerFile = fileSymbol('src/renderer/api.ts', false);
    const invoker = fnSymbol('src/renderer/api.ts', 'loadPanelLayout', false);
    store.replaceFileFacts(
      facts(
        'src/renderer/api.ts',
        [invokerFile, invoker],
        [
          structuralEdge({
            repoId: REPO,
            kind: 'IPC_INVOKES',
            sourceSymbolId: invoker.id,
            targetSymbolId: channel.id,
            sourceFileId: fileRowId(REPO, 'src/renderer/api.ts'),
            line: 7,
            resolved: true,
          }),
        ],
      ),
    );

    // A plain (non-channel) symbol used by the honesty-guard test below: a
    // `::`-qualified input that resolves to a REAL symbol which is not an
    // ipc_channel must not be treated as if it were one.
    const libFile = fileSymbol('src/lib.ts', false);
    const doWork = {
      ...fnSymbol('src/lib.ts', 'doWork', false),
      exported: true,
    };
    store.replaceFileFacts(facts('src/lib.ts', [libFile, doWork], []));

    // Two DIFFERENT channel declarations sharing the SAME bare key
    // ('dupKey') across two files -- an ambiguous bare-key lookup, mirroring
    // resolveIpcEdges' own "two files declare the same channel key" case
    // (ipc-resolver.ts).
    const dupFileOne = fileSymbol('src/shared/one.ts', false);
    const dupOne = ipcChannelSymbol('src/shared/one.ts', 'dupKey');
    store.replaceFileFacts(
      facts('src/shared/one.ts', [dupFileOne, dupOne], []),
    );
    const dupFileTwo = fileSymbol('src/shared/two.ts', false);
    const dupTwo = ipcChannelSymbol('src/shared/two.ts', 'dupKey');
    store.replaceFileFacts(
      facts('src/shared/two.ts', [dupFileTwo, dupTwo], []),
    );

    // A handler call site referencing the shared 'dupKey' key -- mirrors what
    // resolve/ipc-resolver.ts leaves behind for a genuine same-repo
    // ambiguity: the edge stays UNRESOLVED (targetSymbolId: null, the raw
    // `ipc:dupKey` targetRef) rather than being bound to either duplicate
    // declaration. Used by the F2 unresolvedCallSiteCount tests below.
    const dupHandlerFile = fileSymbol('src/main/ipc/dup.ts', false);
    const dupHandler = fnSymbol('src/main/ipc/dup.ts', 'handleDupKey', false);
    store.replaceFileFacts(
      facts(
        'src/main/ipc/dup.ts',
        [dupHandlerFile, dupHandler],
        [
          {
            id: edgeRowId({
              repoId: REPO,
              kind: 'IPC_HANDLES',
              sourceId: dupHandler.id,
              target: 'ipc:dupKey',
              line: 3,
            }),
            repositoryId: REPO,
            kind: 'IPC_HANDLES',
            sourceSymbolId: dupHandler.id,
            targetSymbolId: null,
            sourceFileId: fileRowId(REPO, 'src/main/ipc/dup.ts'),
            targetRef: 'ipc:dupKey',
            line: 3,
            confidenceTier: 'EXTRACTED',
            confidenceScore: 1.0,
            resolverId: null,
            evidence: {},
          },
        ],
      ),
    );

    // A channel whose signature (string value) is a realistic Canopy shape,
    // used by the F1 signature-value-fallback tests below -- an agent
    // reading renderer/preload call sites most plausibly sees this value
    // ('panel-layout:save'), not the bare declaration key.
    const savedChannelFile = fileSymbol('src/shared/ipc-channels-2.ts', false);
    const savedChannel = {
      ...ipcChannelSymbol('src/shared/ipc-channels-2.ts', 'panelLayoutSave'),
      signature: 'panel-layout:save',
    };
    store.replaceFileFacts(
      facts(
        'src/shared/ipc-channels-2.ts',
        [savedChannelFile, savedChannel],
        [],
      ),
    );

    // Two DIFFERENT channels sharing the SAME signature value -- an
    // ambiguous signature-fallback lookup, mirroring the dupKey bare-key
    // ambiguity above but for the F1 fallback path.
    const dupSigFileOne = fileSymbol('src/shared/sig-one.ts', false);
    const dupSigOne = {
      ...ipcChannelSymbol('src/shared/sig-one.ts', 'dupSigKeyOne'),
      signature: 'dup:signature',
    };
    store.replaceFileFacts(
      facts('src/shared/sig-one.ts', [dupSigFileOne, dupSigOne], []),
    );
    const dupSigFileTwo = fileSymbol('src/shared/sig-two.ts', false);
    const dupSigTwo = {
      ...ipcChannelSymbol('src/shared/sig-two.ts', 'dupSigKeyTwo'),
      signature: 'dup:signature',
    };
    store.replaceFileFacts(
      facts('src/shared/sig-two.ts', [dupSigFileTwo, dupSigTwo], []),
    );

    service = new CodeGraphQueryService(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a channel via its bare key with handlers and invokers', () => {
    const result = service.getIpcChannel('panelLayoutLoad');
    expect(result.ambiguousCount).toBe(0);
    expect(result.unresolvedCallSiteCount).toBe(0);
    expect(result.channel).toEqual({
      qualifiedName: 'src/shared/ipc-channels.ts::panelLayoutLoad',
      filePath: 'src/shared/ipc-channels.ts',
      signature: null,
      line: 1,
    });
    expect(result.handlers).toEqual([
      {
        qualifiedName: 'src/main/ipc/panel.ts::handlePanelLayoutLoad',
        kind: 'function',
        filePath: 'src/main/ipc/panel.ts',
        line: 4,
      },
    ]);
    expect(result.invokers).toEqual([
      {
        qualifiedName: 'src/renderer/api.ts::loadPanelLayout',
        kind: 'function',
        filePath: 'src/renderer/api.ts',
        line: 7,
      },
    ]);
  });

  it('resolves the identical channel via its qualified name', () => {
    const byKey = service.getIpcChannel('panelLayoutLoad');
    const byQualifiedName = service.getIpcChannel(
      'src/shared/ipc-channels.ts::panelLayoutLoad',
    );
    expect(byQualifiedName).toEqual(byKey);
  });

  it('canonicalizes a qualified-name input (backslash path, dot-slash path)', () => {
    const canonical = service.getIpcChannel(
      'src/shared/ipc-channels.ts::panelLayoutLoad',
    );
    expect(
      service.getIpcChannel('src\\shared\\ipc-channels.ts::panelLayoutLoad'),
    ).toEqual(canonical);
    expect(
      service.getIpcChannel('./src/shared/ipc-channels.ts::panelLayoutLoad'),
    ).toEqual(canonical);
  });

  it('returns an empty result for an unknown bare key', () => {
    expect(service.getIpcChannel('noSuchChannel')).toEqual({
      channel: null,
      handlers: [],
      invokers: [],
      ambiguousCount: 0,
      unresolvedCallSiteCount: 0,
    });
  });

  it('returns an empty result for an unknown qualified name', () => {
    expect(service.getIpcChannel('src/nope.ts::whatever')).toEqual({
      channel: null,
      handlers: [],
      invokers: [],
      ambiguousCount: 0,
      unresolvedCallSiteCount: 0,
    });
  });

  it('honestly reports no channel when a qualified name resolves to a non-ipc_channel symbol', () => {
    expect(service.getIpcChannel('src/lib.ts::doWork')).toEqual({
      channel: null,
      handlers: [],
      invokers: [],
      ambiguousCount: 0,
      unresolvedCallSiteCount: 0,
    });
  });

  it('reports ambiguity for a bare key shared by two channel declarations instead of guessing the first match', () => {
    expect(service.getIpcChannel('dupKey')).toEqual({
      channel: null,
      handlers: [],
      invokers: [],
      ambiguousCount: 2,
      ambiguousLookup: 'key',
      unresolvedCallSiteCount: 0,
    });
  });

  // F1: an agent reading renderer/preload call sites most plausibly passes
  // the channel's STRING VALUE (its signature), not its bare declaration key.
  describe('signature-value fallback (F1)', () => {
    it('falls back to a signature-value lookup when the bare key finds no match', () => {
      const result = service.getIpcChannel('panel-layout:save');
      expect(result).toEqual({
        channel: {
          qualifiedName: 'src/shared/ipc-channels-2.ts::panelLayoutSave',
          filePath: 'src/shared/ipc-channels-2.ts',
          signature: 'panel-layout:save',
          line: 1,
        },
        handlers: [],
        invokers: [],
        ambiguousCount: 0,
        unresolvedCallSiteCount: 0,
      });
    });

    it('does NOT try the signature fallback when the bare key already matches (key lookup wins)', () => {
      // 'panelLayoutSave' is itself a valid bare key for the same channel --
      // the key lookup must resolve it directly without ever reaching the
      // signature fallback.
      const byKey = service.getIpcChannel('panelLayoutSave');
      const bySignature = service.getIpcChannel('panel-layout:save');
      expect(byKey).toEqual(bySignature);
    });

    it('reports ambiguity for a signature value shared by two channel declarations instead of guessing the first match', () => {
      // `ambiguousLookup` says WHICH lookup produced the multiple matches --
      // the tool/CLI summary copy uses it to say "value"/"string value"
      // instead of dishonestly claiming the KEY was ambiguous.
      expect(service.getIpcChannel('dup:signature')).toEqual({
        channel: null,
        handlers: [],
        invokers: [],
        ambiguousCount: 2,
        ambiguousLookup: 'signature-value',
        unresolvedCallSiteCount: 0,
      });
    });
  });

  // F2: resolving one of two same-repo-duplicate channel declarations
  // directly by qualified name bypasses the bare-key ambiguity check, but the
  // handler call site referencing the shared key was never bound to either
  // declaration by resolve/ipc-resolver.ts -- unresolvedCallSiteCount must
  // surface that instead of silently reporting zero handlers.
  describe('unresolvedCallSiteCount for a same-repo-duplicate key (F2)', () => {
    it('reports the still-unbound handler count when resolving one duplicate declaration by qualified name', () => {
      const resolved = service.getIpcChannel('src/shared/one.ts::dupKey');
      expect(resolved.channel).not.toBeNull();
      expect(resolved.ambiguousCount).toBe(0);
      expect(resolved.handlers).toEqual([]);
      expect(resolved.unresolvedCallSiteCount).toBe(1);
    });

    it('reports the same unresolved count for the OTHER duplicate declaration too', () => {
      const resolved = service.getIpcChannel('src/shared/two.ts::dupKey');
      expect(resolved.channel).not.toBeNull();
      expect(resolved.unresolvedCallSiteCount).toBe(1);
    });
  });
});

describe('CodeGraphQueryService repoId scoping', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let service: CodeGraphQueryService;

  // Deliberately ASYMMETRIC two-repo fixture: both repos share the same
  // relative paths and the same target symbol (src/lib.ts::doWork), but the
  // caller function names differ (caller vs callerB) and only repo-a has an
  // IMPORTS_FROM edge into src/lib.ts. A scoped read that silently ignored
  // its repoId parameter would return the OTHER repo's rows for at least one
  // of the per-repo assertions below, so these tests actually discriminate a
  // scoping regression (a symmetric fixture would pass either way). Mirrors
  // the multi-repo seeding pattern from engine-multi-repo.test.ts, built
  // directly against the store via the shared repoId-parameterized fixture
  // helpers at the top of this file.
  function resolvedCall(
    repoId: string,
    relativePath: string,
    sourceId: string,
    targetSymbolId: string,
    targetRef: string,
    line: number,
  ): CodeGraphEdgeRecord {
    return {
      ...callEdge(relativePath, sourceId, targetRef, line, repoId),
      targetSymbolId,
      confidenceTier: 'RESOLVED',
      confidenceScore: 0.9,
      resolverId: 'import-binding',
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-queries-scope-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);

    const repos = [
      {
        repoId: 'repo-a',
        callerName: 'caller',
        docSlug: 'intro',
        scriptCommand: 'tsc -p .',
        rationaleMarker: 'NOTE',
        rationaleText: 'explains repo-a doWork',
        ipcHandlerName: 'handleA',
        ipcInvokerName: 'invokeA',
      },
      {
        repoId: 'repo-b',
        callerName: 'callerB',
        docSlug: 'overview',
        scriptCommand: 'webpack',
        rationaleMarker: 'WHY',
        rationaleText: 'explains repo-b doWork',
        ipcHandlerName: 'handleB',
        ipcInvokerName: 'invokeB',
      },
    ];
    for (const {
      repoId,
      callerName,
      docSlug,
      scriptCommand,
      rationaleMarker,
      rationaleText,
      ipcHandlerName,
      ipcInvokerName,
    } of repos) {
      store.upsertRepository({
        repoId,
        rootPath: `/abs/${repoId}`,
        gitHead: null,
      });
      const lib = fileSymbol('src/lib.ts', false, repoId);
      const doWork = fnSymbol('src/lib.ts', 'doWork', false, repoId);

      // Rationale asymmetry: same target (doWork), repo-distinct marker/text —
      // discriminates a scoping regression the same way callerName does above.
      const rationale = rationaleSymbol(
        'src/lib.ts',
        rationaleMarker,
        rationaleText,
        1,
        repoId,
      );
      store.replaceFileFacts(
        facts(
          'src/lib.ts',
          [lib, doWork, rationale],
          [
            structuralEdge({
              repoId,
              kind: 'RATIONALE_FOR',
              sourceSymbolId: rationale.id,
              targetSymbolId: doWork.id,
              sourceFileId: fileRowId(repoId, 'src/lib.ts'),
              line: 1,
            }),
          ],
          repoId,
        ),
      );

      const worker = fileSymbol('src/worker.ts', false, repoId);
      const callerFn = fnSymbol('src/worker.ts', callerName, false, repoId);
      const edges: CodeGraphEdgeRecord[] = [
        resolvedCall(
          repoId,
          'src/worker.ts',
          callerFn.id,
          doWork.id,
          'doWork',
          3,
        ),
      ];
      if (repoId === 'repo-a') {
        // Import-edge asymmetry: only repo-a imports src/lib.ts, so a scoped
        // getImporters for repo-b must come back empty.
        edges.push({
          id: edgeRowId({
            repoId,
            kind: 'IMPORTS_FROM',
            sourceId: worker.id,
            target: './lib',
            line: 1,
          }),
          repositoryId: repoId,
          kind: 'IMPORTS_FROM',
          sourceSymbolId: worker.id,
          targetSymbolId: lib.id,
          sourceFileId: fileRowId(repoId, 'src/worker.ts'),
          targetRef: './lib',
          line: 1,
          confidenceTier: 'RESOLVED',
          confidenceScore: 0.95,
          resolverId: 'ts-module-resolution',
          evidence: { resolvedPath: 'src/lib.ts' },
        });
      }
      store.replaceFileFacts(
        facts('src/worker.ts', [worker, callerFn], edges, repoId),
      );

      // Docs asymmetry: both repos document src/lib.ts, but under a
      // repo-distinct doc_section slug (intro vs overview).
      const docsFile = fileSymbol('docs.md', false, repoId);
      const docSection = docSectionSymbol('docs.md', docSlug, repoId);
      store.replaceFileFacts(
        facts(
          'docs.md',
          [docsFile, docSection],
          [
            structuralEdge({
              repoId,
              kind: 'DOCUMENTS',
              sourceSymbolId: docSection.id,
              targetSymbolId: lib.id,
              sourceFileId: fileRowId(repoId, 'docs.md'),
              line: 3,
              resolved: true,
            }),
          ],
          repoId,
        ),
      );

      // Scripts asymmetry: both repos declare a "build" script, but with a
      // repo-distinct command.
      const packageFile = fileSymbol('package.json', false, repoId);
      const script = scriptSymbol(
        'package.json',
        'build',
        scriptCommand,
        repoId,
      );
      store.replaceFileFacts(
        facts(
          'package.json',
          [packageFile, script],
          [
            structuralEdge({
              repoId,
              kind: 'DECLARES_SCRIPT',
              sourceSymbolId: packageFile.id,
              targetSymbolId: script.id,
              sourceFileId: fileRowId(repoId, 'package.json'),
              line: 2,
            }),
          ],
          repoId,
        ),
      );

      // IPC channel asymmetry: both repos declare the SAME bare channel key
      // ('sharedChannel') at the SAME relative path -- the channel object
      // itself is therefore identical text across repos, so only its
      // handler/invoker NAMES discriminate a scoping regression (mirrors
      // callerName's discriminating role above).
      const ipcChannelsFile = fileSymbol(
        'src/shared/ipc-channels.ts',
        false,
        repoId,
      );
      const ipcChannel = ipcChannelSymbol(
        'src/shared/ipc-channels.ts',
        'sharedChannel',
        repoId,
      );
      store.replaceFileFacts(
        facts(
          'src/shared/ipc-channels.ts',
          [ipcChannelsFile, ipcChannel],
          [],
          repoId,
        ),
      );

      const ipcHandlerFile = fileSymbol('src/main/ipc/panel.ts', false, repoId);
      const ipcHandler = fnSymbol(
        'src/main/ipc/panel.ts',
        ipcHandlerName,
        false,
        repoId,
      );
      store.replaceFileFacts(
        facts(
          'src/main/ipc/panel.ts',
          [ipcHandlerFile, ipcHandler],
          [
            structuralEdge({
              repoId,
              kind: 'IPC_HANDLES',
              sourceSymbolId: ipcHandler.id,
              targetSymbolId: ipcChannel.id,
              sourceFileId: fileRowId(repoId, 'src/main/ipc/panel.ts'),
              line: 4,
              resolved: true,
            }),
          ],
          repoId,
        ),
      );

      const ipcInvokerFile = fileSymbol('src/renderer/api.ts', false, repoId);
      const ipcInvoker = fnSymbol(
        'src/renderer/api.ts',
        ipcInvokerName,
        false,
        repoId,
      );
      store.replaceFileFacts(
        facts(
          'src/renderer/api.ts',
          [ipcInvokerFile, ipcInvoker],
          [
            structuralEdge({
              repoId,
              kind: 'IPC_INVOKES',
              sourceSymbolId: ipcInvoker.id,
              targetSymbolId: ipcChannel.id,
              sourceFileId: fileRowId(repoId, 'src/renderer/api.ts'),
              line: 7,
              resolved: true,
            }),
          ],
          repoId,
        ),
      );
    }

    // Residual-fix fixture (P6): a channel declared ONLY in repo-a, plus one
    // still-unresolved `ipc:aOnlyChannel` call-site edge in EACH repo.
    // repo-b's same-key edge belongs to a repo where the channel does not
    // even exist -- cross-repo binding never happens (ipc-resolver.ts), so
    // that edge can never be a call site of repo-a's channel and must not
    // inflate its unresolvedCallSiteCount.
    const aOnlyFile = fileSymbol('src/shared/a-only.ts', false, 'repo-a');
    const aOnlyChannel = ipcChannelSymbol(
      'src/shared/a-only.ts',
      'aOnlyChannel',
      'repo-a',
    );
    store.replaceFileFacts(
      facts('src/shared/a-only.ts', [aOnlyFile, aOnlyChannel], [], 'repo-a'),
    );
    for (const repoId of ['repo-a', 'repo-b']) {
      const unresolvedFile = fileSymbol(
        'src/main/ipc/unresolved.ts',
        false,
        repoId,
      );
      store.replaceFileFacts(
        facts(
          'src/main/ipc/unresolved.ts',
          [unresolvedFile],
          [
            {
              id: edgeRowId({
                repoId,
                kind: 'IPC_HANDLES',
                sourceId: unresolvedFile.id,
                target: 'ipc:aOnlyChannel',
                line: 3,
              }),
              repositoryId: repoId,
              kind: 'IPC_HANDLES',
              sourceSymbolId: unresolvedFile.id,
              targetSymbolId: null,
              sourceFileId: fileRowId(repoId, 'src/main/ipc/unresolved.ts'),
              targetRef: 'ipc:aOnlyChannel',
              line: 3,
              confidenceTier: 'EXTRACTED',
              confidenceScore: 1.0,
              resolverId: null,
              evidence: {},
            },
          ],
          repoId,
        ),
      );
    }

    service = new CodeGraphQueryService(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('scopes getCallers per repo: colliding target, repo-distinct callers', () => {
    const scopedA = service.getCallers('src/lib.ts::doWork', 'repo-a');
    expect(scopedA.map((c) => c.qualifiedName)).toEqual([
      'src/worker.ts::caller',
    ]);
    expect(scopedA[0].filePath).toBe('src/worker.ts');

    const scopedB = service.getCallers('src/lib.ts::doWork', 'repo-b');
    expect(scopedB.map((c) => c.qualifiedName)).toEqual([
      'src/worker.ts::callerB',
    ]);
  });

  it('scopes getFileSummary and getImporters per repo (repo-distinct symbols and imports)', () => {
    const summaryA = service.getFileSummary('src/worker.ts', 'repo-a');
    const summaryB = service.getFileSummary('src/worker.ts', 'repo-b');
    expect(summaryA?.symbols.map((s) => s.qualifiedName)).toEqual([
      'src/worker.ts::caller',
    ]);
    expect(summaryB?.symbols.map((s) => s.qualifiedName)).toEqual([
      'src/worker.ts::callerB',
    ]);

    // Only repo-a has an import edge into src/lib.ts.
    expect(service.getImporters('src/lib.ts', 'repo-a')).toEqual([
      'src/worker.ts',
    ]);
    expect(service.getImporters('src/lib.ts', 'repo-b')).toEqual([]);
  });

  it('returns empty results for a nonexistent repoId instead of falling back to unscoped rows', () => {
    expect(service.getCallers('src/lib.ts::doWork', 'repo-nope')).toEqual([]);
    expect(service.getImporters('src/lib.ts', 'repo-nope')).toEqual([]);
    expect(service.getFileSummary('src/worker.ts', 'repo-nope')).toBeNull();
    expect(service.getDocsFor('src/lib.ts', 'repo-nope')).toEqual([]);
    expect(service.getRationaleFor('src/lib.ts::doWork', 'repo-nope')).toEqual(
      [],
    );
    expect(service.getScriptsForFile('package.json', 'repo-nope')).toEqual([]);
    expect(service.getIpcChannel('sharedChannel', 'repo-nope')).toEqual({
      channel: null,
      handlers: [],
      invokers: [],
      ambiguousCount: 0,
      unresolvedCallSiteCount: 0,
    });
  });

  it('omitting repoId still returns exactly one repo worth of rows (unchanged single-repo behavior)', () => {
    const unscoped = service.getCallers('src/lib.ts::doWork');
    expect(unscoped).toHaveLength(1);
  });

  it('scopes getDocsFor per repo: colliding target, repo-distinct doc_section slug (Task 7)', () => {
    const docsA = service.getDocsFor('src/lib.ts', 'repo-a');
    expect(docsA).toEqual([
      { qualifiedName: 'docs.md::intro', filePath: 'docs.md', line: 3 },
    ]);

    const docsB = service.getDocsFor('src/lib.ts', 'repo-b');
    expect(docsB).toEqual([
      { qualifiedName: 'docs.md::overview', filePath: 'docs.md', line: 3 },
    ]);
  });

  it('scopes getRationaleFor per repo: colliding target, repo-distinct marker/text (Task 7)', () => {
    const rationaleA = service.getRationaleFor('src/lib.ts::doWork', 'repo-a');
    expect(rationaleA).toEqual([
      {
        qualifiedName: 'src/lib.ts::rationale.L1',
        marker: 'NOTE',
        text: 'explains repo-a doWork',
        filePath: 'src/lib.ts',
        line: 1,
      },
    ]);

    const rationaleB = service.getRationaleFor('src/lib.ts::doWork', 'repo-b');
    expect(rationaleB).toEqual([
      {
        qualifiedName: 'src/lib.ts::rationale.L1',
        marker: 'WHY',
        text: 'explains repo-b doWork',
        filePath: 'src/lib.ts',
        line: 1,
      },
    ]);
  });

  it('scopes getScriptsForFile per repo: colliding target, repo-distinct command (Task 7)', () => {
    const scriptsA = service.getScriptsForFile('package.json', 'repo-a');
    expect(scriptsA).toEqual([{ name: 'build', command: 'tsc -p .' }]);

    const scriptsB = service.getScriptsForFile('package.json', 'repo-b');
    expect(scriptsB).toEqual([{ name: 'build', command: 'webpack' }]);
  });

  it('scopes getIpcChannel per repo: colliding bare key, repo-distinct handler/invoker (P5)', () => {
    const channelA = service.getIpcChannel('sharedChannel', 'repo-a');
    expect(channelA.ambiguousCount).toBe(0);
    expect(channelA.channel).toEqual({
      qualifiedName: 'src/shared/ipc-channels.ts::sharedChannel',
      filePath: 'src/shared/ipc-channels.ts',
      signature: null,
      line: 1,
    });
    expect(channelA.handlers).toEqual([
      {
        qualifiedName: 'src/main/ipc/panel.ts::handleA',
        kind: 'function',
        filePath: 'src/main/ipc/panel.ts',
        line: 4,
      },
    ]);
    expect(channelA.invokers).toEqual([
      {
        qualifiedName: 'src/renderer/api.ts::invokeA',
        kind: 'function',
        filePath: 'src/renderer/api.ts',
        line: 7,
      },
    ]);

    const channelB = service.getIpcChannel('sharedChannel', 'repo-b');
    expect(channelB.handlers).toEqual([
      {
        qualifiedName: 'src/main/ipc/panel.ts::handleB',
        kind: 'function',
        filePath: 'src/main/ipc/panel.ts',
        line: 4,
      },
    ]);
    expect(channelB.invokers).toEqual([
      {
        qualifiedName: 'src/renderer/api.ts::invokeB',
        kind: 'function',
        filePath: 'src/renderer/api.ts',
        line: 7,
      },
    ]);
  });

  it('reports cross-repo ambiguity when repoId is omitted for a bare key declared in both repos', () => {
    // Both repos declare 'sharedChannel'; without a repoId to scope the
    // lookup, both are legitimate candidates -- this is the same honesty
    // rule as the same-repo dupKey case, just triggered by omitting repoId
    // instead of a same-repo collision.
    expect(service.getIpcChannel('sharedChannel')).toEqual({
      channel: null,
      handlers: [],
      invokers: [],
      ambiguousCount: 2,
      ambiguousLookup: 'key',
      unresolvedCallSiteCount: 0,
    });
  });

  it("scopes unresolvedCallSiteCount by the resolved channel's OWN repository, not the optional request repoId (P6 residual)", () => {
    // 'aOnlyChannel' is declared only in repo-a, but BOTH repos carry one
    // unresolved `ipc:aOnlyChannel` edge (seeded in beforeEach). repo-b's
    // edge can never bind to repo-a's channel, so the count must be 1 --
    // with or without a request repoId.
    const scoped = service.getIpcChannel('aOnlyChannel', 'repo-a');
    expect(scoped.channel).not.toBeNull();
    expect(scoped.unresolvedCallSiteCount).toBe(1);

    const unscoped = service.getIpcChannel('aOnlyChannel');
    expect(unscoped.channel).not.toBeNull();
    expect(unscoped.unresolvedCallSiteCount).toBe(1);
  });
});

// Task 7: getDocsFor/getRationaleFor/getScriptsForFile, seeded through the
// REAL extraction pipeline (CodeGraphEngine + on-disk fixture files) rather
// than hand-built store facts — reusing the markdown/manifest/rationale
// extractor fixture patterns from engine.test.ts, manifest-extractors.test.ts,
// and rationale.test.ts so these three query modes are exercised against
// actual DOCUMENTS/RATIONALE_FOR/DECLARES_SCRIPT edges produced by Tasks 4-6.
describe('CodeGraphQueryService docs/rationale/scripts query modes (Task 7, real fixtures)', () => {
  let root: string;
  let dbPath: string;
  let engine: CodeGraphEngine;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-queries-nca-'));
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'lib.ts'),
      '// NOTE: doWork returns the answer to everything.\n' +
        'export function doWork(): number {\n' +
        '  return 42;\n' +
        '}\n',
    );
    writeFileSync(
      path.join(root, 'docs.md'),
      '# Guide\n\nSee [lib](./src/lib.ts) for details.\n',
    );
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { build: 'tsc -p .' } }),
    );

    dbPath = path.join(root, '.graph', 'graph.db');
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
    await engine.buildOrUpdate();
  });

  afterEach(() => {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('getDocsFor resolves a doc_section that links to a file-path target', () => {
    expect(engine.queries().getDocsFor('src/lib.ts')).toEqual([
      { qualifiedName: 'docs.md::guide', filePath: 'docs.md', line: 3 },
    ]);
  });

  it('getDocsFor resolves the same docs via a symbol qualifiedName target (hops symbol -> file)', () => {
    expect(engine.queries().getDocsFor('src/lib.ts::doWork')).toEqual([
      { qualifiedName: 'docs.md::guide', filePath: 'docs.md', line: 3 },
    ]);
  });

  it('getDocsFor returns [] for a file with no incoming DOCUMENTS edges and for an unknown file', () => {
    expect(engine.queries().getDocsFor('package.json')).toEqual([]);
    expect(engine.queries().getDocsFor('src/nope.ts')).toEqual([]);
  });

  it('getRationaleFor attributes a NOTE comment to the following function', () => {
    expect(engine.queries().getRationaleFor('src/lib.ts::doWork')).toEqual([
      {
        qualifiedName: 'src/lib.ts::rationale.L1',
        marker: 'NOTE',
        text: 'doWork returns the answer to everything.',
        filePath: 'src/lib.ts',
        line: 1,
      },
    ]);
  });

  it('getRationaleFor returns [] for a target with no rationale comments and for an unknown symbol', () => {
    expect(engine.queries().getRationaleFor('src/lib.ts')).toEqual([]);
    expect(engine.queries().getRationaleFor('src/nope.ts::x')).toEqual([]);
  });

  it('getScriptsForFile returns declared script name/command pairs for a manifest file', () => {
    expect(engine.queries().getScriptsForFile('package.json')).toEqual([
      { name: 'build', command: 'tsc -p .' },
    ]);
  });

  it('getScriptsForFile returns [] for a non-manifest file and an unknown file', () => {
    expect(engine.queries().getScriptsForFile('src/lib.ts')).toEqual([]);
    expect(engine.queries().getScriptsForFile('nope.json')).toEqual([]);
  });

  it('canonicalizes inputs for the new query modes (backslash path, dot-slash path)', () => {
    const canonicalDocs = engine.queries().getDocsFor('src/lib.ts');
    expect(engine.queries().getDocsFor('./src/lib.ts')).toEqual(canonicalDocs);
    expect(engine.queries().getDocsFor('src\\lib.ts')).toEqual(canonicalDocs);

    const canonicalRationale = engine
      .queries()
      .getRationaleFor('src/lib.ts::doWork');
    expect(engine.queries().getRationaleFor('src\\lib.ts::doWork')).toEqual(
      canonicalRationale,
    );

    const canonicalScripts = engine.queries().getScriptsForFile('package.json');
    expect(engine.queries().getScriptsForFile('./package.json')).toEqual(
      canonicalScripts,
    );
  });
});

// P5 Task 5: getIpcChannel, seeded through the REAL extraction + IPC-resolver
// pipeline (CodeGraphEngine + on-disk fixture files) rather than hand-built
// store facts -- reuses the exact IPC_CHANNELS/registerIpcHandler/
// ipcRenderer.invoke fixture shape from ipc-resolver.test.ts's
// "CodeGraphEngine IPC resolution wiring" describe block, so this exercises
// actual IPC_HANDLES/IPC_INVOKES edges resolved by resolveIpcEdges (Task 3)
// against a real ipc_channel symbol produced by extractCanopyPatterns
// (Task 2).
describe('CodeGraphQueryService getIpcChannel (P5, real fixtures)', () => {
  let root: string;
  let dbPath: string;
  let engine: CodeGraphEngine;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-queries-ipc-'));
    mkdirSync(path.join(root, 'src', 'shared'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'main', 'ipc'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'preload'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'shared', 'types.ts'),
      `export const IPC_CHANNELS = {
  fooLoad: 'foo:load',
} as const;
`,
    );
    writeFileSync(
      path.join(root, 'src', 'main', 'ipc', 'register.ts'),
      `import { IPC_CHANNELS } from '../../shared/types';

export function registerIpcHandler(channel: string, handler: () => void): void {}

export function registerHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.fooLoad, () => {});
}
`,
    );
    // declare-const shim instead of an electron import: the extractor keys on
    // callee text alone, and a literal electron specifier (even inside a
    // template string) trips the regex-based check:electron-boundary scanner.
    writeFileSync(
      path.join(root, 'src', 'preload', 'index.ts'),
      `declare const ipcRenderer: { invoke: Function; send: Function; on: Function };
import { IPC_CHANNELS } from '../shared/types';

export function loadFoo(): void {
  ipcRenderer.invoke(IPC_CHANNELS.fooLoad);
}
`,
    );

    dbPath = path.join(root, '.graph', 'graph.db');
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
    await engine.buildOrUpdate();
  });

  afterEach(() => {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a channel by bare key with its real handler and invoker', () => {
    const result = engine.queries().getIpcChannel('fooLoad');
    expect(result.ambiguousCount).toBe(0);
    expect(result.channel).toEqual({
      qualifiedName: 'src/shared/types.ts::ipc.fooLoad',
      filePath: 'src/shared/types.ts',
      signature: 'foo:load',
      line: 2,
    });
    expect(result.handlers).toEqual([
      {
        qualifiedName: 'src/main/ipc/register.ts::registerHandlers',
        kind: 'function',
        filePath: 'src/main/ipc/register.ts',
        line: 6,
      },
    ]);
    expect(result.invokers).toEqual([
      {
        qualifiedName: 'src/preload/index.ts::loadFoo',
        kind: 'function',
        filePath: 'src/preload/index.ts',
        line: 5,
      },
    ]);
  });

  it('resolves the same channel by its real qualified name', () => {
    const byKey = engine.queries().getIpcChannel('fooLoad');
    expect(
      engine.queries().getIpcChannel('src/shared/types.ts::ipc.fooLoad'),
    ).toEqual(byKey);
  });

  it('returns an empty result for an unknown channel key', () => {
    expect(engine.queries().getIpcChannel('nopeChannel')).toEqual({
      channel: null,
      handlers: [],
      invokers: [],
      ambiguousCount: 0,
      unresolvedCallSiteCount: 0,
    });
  });
});

// --- Derived-analysis query methods (Phase 6 Task 7) -----------------------
//
// `CodeGraphQueryService`'s new communities/flows/hubs/community-crossing
// methods are thin delegations onto `CodeGraphStore`'s own Task 3 methods
// (see queries.ts's `derivedStore` field) -- these tests exercise them
// through the QUERY SERVICE'S public surface (qualified-name-based, unlike
// the store's own symbol-id-based tests in derived-store.test.ts) so a
// regression in the delegation/symbol-id-resolution wiring itself is caught.
function communityRecord(
  id: string,
  size: number,
  cohesion = 0.5,
): CodeGraphCommunityRecord {
  return {
    id,
    repositoryId: REPO,
    label: id,
    cohesion,
    size,
    fingerprint: `fp-${id}`,
    extra: {},
  };
}

function communityMembership(
  communityId: string,
  symbolId: string,
): CodeGraphCommunityMembershipRecord {
  return { communityId, symbolId };
}

function flowRecord(
  id: string,
  entrySymbolId: string,
  criticality: number,
): CodeGraphFlowRecord {
  return {
    id,
    repositoryId: REPO,
    entrySymbolId,
    name: `flow ${id}`,
    criticality,
    symbolCount: 1,
    fileSpread: 1,
    maxDepth: 1,
    extra: {},
  };
}

function flowMembershipRecord(
  flowId: string,
  symbolId: string,
): CodeGraphFlowMembershipRecord {
  return { flowId, symbolId, depth: 0 };
}

function resolvedCallEdge(
  relativePath: string,
  sourceId: string,
  target: CodeGraphSymbolRecord,
  line: number,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: REPO,
      kind: 'CALLS',
      sourceId,
      target: target.name,
      line,
    }),
    repositoryId: REPO,
    kind: 'CALLS',
    sourceSymbolId: sourceId,
    targetSymbolId: target.id,
    sourceFileId: fileRowId(REPO, relativePath),
    targetRef: target.name,
    line,
    confidenceTier: 'RESOLVED',
    confidenceScore: 0.9,
    resolverId: 'import-binding',
    evidence: {},
  };
}

describe('CodeGraphQueryService derived-analysis methods (communities/flows/hubs)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let service: CodeGraphQueryService;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-queries-derived-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });
    service = new CodeGraphQueryService(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('listCommunities returns communities largest-first, scoped by repoId', () => {
    const file = fileSymbol('src/a.ts', false);
    const alpha = fnSymbol('src/a.ts', 'alpha', false);
    store.replaceFileFacts(facts('src/a.ts', [file, alpha], []));
    store.replaceDerivedForRepo(
      REPO,
      [communityRecord('com-small', 1), communityRecord('com-big', 5)],
      [communityMembership('com-small', alpha.id)],
      [],
      [],
    );

    expect(service.listCommunities(REPO).map((c) => c.id)).toEqual([
      'com-big',
      'com-small',
    ]);
  });

  it('listCommunities is honestly empty when no derived analysis has been computed', () => {
    expect(service.listCommunities(REPO)).toEqual([]);
  });

  it('listFlows returns flows most-critical-first, scoped by repoId', () => {
    const file = fileSymbol('src/a.ts', false);
    const alpha = fnSymbol('src/a.ts', 'alpha', false);
    store.replaceFileFacts(facts('src/a.ts', [file, alpha], []));
    store.replaceDerivedForRepo(
      REPO,
      [],
      [],
      [
        flowRecord('flow-low', alpha.id, 0.2),
        flowRecord('flow-high', alpha.id, 0.9),
      ],
      [],
    );

    expect(service.listFlows(REPO).map((f) => f.id)).toEqual([
      'flow-high',
      'flow-low',
    ]);
  });

  it('listFlowsForSymbol resolves a qualified name to its flow memberships, most-critical-first', () => {
    const file = fileSymbol('src/a.ts', false);
    const alpha = fnSymbol('src/a.ts', 'alpha', false);
    const beta = fnSymbol('src/a.ts', 'beta', false);
    store.replaceFileFacts(facts('src/a.ts', [file, alpha, beta], []));
    store.replaceDerivedForRepo(
      REPO,
      [],
      [],
      [
        flowRecord('flow-1', alpha.id, 0.3),
        flowRecord('flow-2', alpha.id, 0.7),
      ],
      [
        flowMembershipRecord('flow-1', alpha.id),
        flowMembershipRecord('flow-2', alpha.id),
        // beta is not a member of either flow -- proves the join is scoped
        // to the requested symbol, not every flow in the repo.
      ],
    );

    expect(
      service.listFlowsForSymbol(alpha.qualifiedName, REPO).map((f) => f.id),
    ).toEqual(['flow-2', 'flow-1']);
    expect(service.listFlowsForSymbol(beta.qualifiedName, REPO)).toEqual([]);
  });

  it('listFlowsForSymbol returns [] for an unresolvable qualified name (never throws)', () => {
    expect(service.listFlowsForSymbol('src/nope.ts::missing', REPO)).toEqual(
      [],
    );
  });

  it('getCommunityForSymbol resolves a qualified name to its community, or null when unassigned', () => {
    const file = fileSymbol('src/a.ts', false);
    const alpha = fnSymbol('src/a.ts', 'alpha', false);
    const beta = fnSymbol('src/a.ts', 'beta', false);
    store.replaceFileFacts(facts('src/a.ts', [file, alpha, beta], []));
    store.replaceDerivedForRepo(
      REPO,
      [communityRecord('com-1', 1)],
      [communityMembership('com-1', alpha.id)],
      [],
      [],
    );

    expect(service.getCommunityForSymbol(alpha.qualifiedName, REPO)?.id).toBe(
      'com-1',
    );
    expect(service.getCommunityForSymbol(beta.qualifiedName, REPO)).toBeNull();
  });

  it('getCommunityForSymbol returns null for an unresolvable qualified name (never throws)', () => {
    expect(
      service.getCommunityForSymbol('src/nope.ts::missing', REPO),
    ).toBeNull();
  });

  it('countCrossCommunityCallers resolves a qualified name and counts distinct cross-community callers', () => {
    const file = fileSymbol('src/a.ts', false);
    const target = fnSymbol('src/a.ts', 'target', false);
    const callerFile = fileSymbol('src/b.ts', false);
    const callerFn = fnSymbol('src/b.ts', 'callerFn', false);
    store.replaceFileFacts(facts('src/a.ts', [file, target], []));
    store.replaceFileFacts(
      facts(
        'src/b.ts',
        [callerFile, callerFn],
        [resolvedCallEdge('src/b.ts', callerFn.id, target, 3)],
      ),
    );
    store.replaceDerivedForRepo(
      REPO,
      [communityRecord('com-target', 1), communityRecord('com-caller', 1)],
      [
        communityMembership('com-target', target.id),
        communityMembership('com-caller', callerFn.id),
      ],
      [],
      [],
    );

    expect(service.countCrossCommunityCallers(target.qualifiedName, REPO)).toBe(
      1,
    );
  });

  it('countCrossCommunityCallers returns 0 for an unresolvable qualified name (never throws)', () => {
    expect(
      service.countCrossCommunityCallers('src/nope.ts::missing', REPO),
    ).toBe(0);
  });

  it('listTopDegreeSymbols ranks symbols by total edge degree, independent of any derived-analysis computation', () => {
    const file = fileSymbol('src/a.ts', false);
    const hub = fnSymbol('src/a.ts', 'hub', false);
    const leafFile = fileSymbol('src/b.ts', false);
    const leaf = fnSymbol('src/b.ts', 'leaf', false);
    store.replaceFileFacts(facts('src/a.ts', [file, hub], []));
    store.replaceFileFacts(
      facts(
        'src/b.ts',
        [leafFile, leaf],
        [resolvedCallEdge('src/b.ts', leaf.id, hub, 3)],
      ),
    );

    // No replaceDerivedForRepo call at all -- hubs are a live edges-table
    // aggregate, not a derived-analysis reading, so this must still work.
    const ranked = service.listTopDegreeSymbols(REPO);
    expect(ranked[0]).toEqual({
      qualifiedName: hub.qualifiedName,
      kind: 'function',
      filePath: 'src/a.ts',
      degree: 1,
    });
  });

  it('getDerivedStats reports 0/0 before any derived computation and real counts after', () => {
    const file = fileSymbol('src/a.ts', false);
    const alpha = fnSymbol('src/a.ts', 'alpha', false);
    store.replaceFileFacts(facts('src/a.ts', [file, alpha], []));

    expect(service.getDerivedStats(REPO)).toEqual({
      communityCount: 0,
      flowCount: 0,
    });

    store.replaceDerivedForRepo(
      REPO,
      [communityRecord('com-1', 1)],
      [communityMembership('com-1', alpha.id)],
      [flowRecord('flow-1', alpha.id, 0.5)],
      [flowMembershipRecord('flow-1', alpha.id)],
    );

    expect(service.getDerivedStats(REPO)).toEqual({
      communityCount: 1,
      flowCount: 1,
    });
  });
});
