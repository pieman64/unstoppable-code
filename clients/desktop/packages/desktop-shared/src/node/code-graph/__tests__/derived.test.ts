import type { CommunityDetectionResult } from '../analysis/communities';
import type { FlowTracingResult } from '../analysis/flows';
import { readGraphDiagnostics, recordGraphDiagnostics } from '../diagnostics';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import { edgeRowId, fileRowId, symbolQualifiedName, symbolRowId } from '../ids';
import { computeDerivedForRepo } from '../analysis/derived';
import type {
  CodeGraphEdgeRecord,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';

// --- Fixture helpers (mirrors derived-store.test.ts's hand-built-facts
// pattern: real store writes through replaceFileFacts, not mocks). ---

const REPO = 'repo-a';

function makeSymbol(
  relativePath: string,
  name: string,
  index: number,
): CodeGraphSymbolRecord {
  const fileId = fileRowId(REPO, relativePath);
  return {
    id: symbolRowId(REPO, symbolQualifiedName(relativePath, [], name)),
    repositoryId: REPO,
    fileId,
    kind: 'function',
    name,
    qualifiedName: symbolQualifiedName(relativePath, [], name),
    parentSymbolId: null,
    lineStart: index + 1,
    lineEnd: index + 1,
    byteStart: index * 10,
    byteEnd: index * 10 + 5,
    signature: `function ${name}()`,
    exported: true,
    isTest: false,
    extra: {},
  };
}

function makeCallEdge(
  relativePath: string,
  source: CodeGraphSymbolRecord,
  target: CodeGraphSymbolRecord,
  line: number,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: REPO,
      kind: 'CALLS',
      sourceId: source.id,
      target: target.name,
      line,
    }),
    repositoryId: REPO,
    kind: 'CALLS',
    sourceSymbolId: source.id,
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

function writeFile(
  store: CodeGraphStore,
  relativePath: string,
  symbols: CodeGraphSymbolRecord[],
  edges: CodeGraphEdgeRecord[],
  language: string | null = 'typescript',
): void {
  store.replaceFileFacts({
    file: {
      id: fileRowId(REPO, relativePath),
      repositoryId: REPO,
      relativePath,
      absolutePath: `/abs/${relativePath}`,
      language,
      contentHash: `hash-${relativePath}`,
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
  });
}

describe('computeDerivedForRepo (analysis/derived.ts orchestrator)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-derived-orchestrator-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // `run` and `checksDoWork` both call `doWork` and are each called by
  // nobody, so both qualify as call-graph-root flow entry points (see
  // analysis/flows.ts's entry-point classification) -- this fixture always
  // produces at least one community and at least one flow.
  function seedCallGraph(): {
    run: CodeGraphSymbolRecord;
    doWork: CodeGraphSymbolRecord;
    checksDoWork: CodeGraphSymbolRecord;
  } {
    const doWork = makeSymbol('src/lib.ts', 'doWork', 0);
    const run = makeSymbol('src/main.ts', 'run', 0);
    const checksDoWork = makeSymbol(
      'src/__tests__/lib.test.ts',
      'checksDoWork',
      0,
    );
    writeFile(store, 'src/lib.ts', [doWork], []);
    writeFile(
      store,
      'src/main.ts',
      [run],
      [makeCallEdge('src/main.ts', run, doWork, 2)],
    );
    writeFile(
      store,
      'src/__tests__/lib.test.ts',
      [checksDoWork],
      [makeCallEdge('src/__tests__/lib.test.ts', checksDoWork, doWork, 2)],
    );
    return { run, doWork, checksDoWork };
  }

  it.each(['skipped', 'failed', 'partial'])(
    'persists %s analysis status across a reopen and no-op',
    async (stage) => {
      seedCallGraph();
      const result = await computeDerivedForRepo({
        store,
        repoId: REPO,
        ...(stage === 'failed'
          ? {
              detectCommunitiesFn: (): CommunityDetectionResult => {
                throw new Error('diagnostic failure');
              },
            }
          : {}),
        ...(stage === 'skipped'
          ? {
              detectCommunitiesFn: (): CommunityDetectionResult => ({
                skipped: true,
                symbolCount: 3,
                communities: [],
                memberships: [],
                skipReason: 'fixture work budget',
              }),
            }
          : {}),
        ...(stage === 'partial'
          ? {
              traceFlowsFn: (): FlowTracingResult => ({
                entryPointCount: 2,
                flows: [],
                memberships: [],
                globalCapReached: true,
              }),
            }
          : {}),
      });
      const scans = new Map([
        [
          REPO,
          {
            eligibleFiles: 3,
            unsupportedFiles: 0,
            excludedFiles: 0,
            examples: [],
          },
        ],
      ]);
      recordGraphDiagnostics({
        db,
        scans,
        derived: [result],
        derivedRefreshed: true,
        computeDerived: true,
        factsChanged: true,
        freshness: 'content',
      });
      const before = readGraphDiagnostics(db)?.repositories[0];
      expect(before?.communityStatus).toBe(
        stage === 'partial' ? 'complete' : stage,
      );
      expect(before?.flowStatus).toBe(
        stage === 'failed'
          ? 'failed'
          : stage === 'partial'
            ? 'partial'
            : 'complete',
      );
      expect(before?.edges.reduce((sum, entry) => sum + entry.count, 0)).toBe(
        2,
      );
      recordGraphDiagnostics({
        db,
        scans,
        derived: [],
        derivedRefreshed: false,
        computeDerived: true,
        factsChanged: false,
        freshness: 'stat',
      });
      const reopened = openCodeGraphDatabase(path.join(dir, 'graph.db'));
      try {
        expect(readGraphDiagnostics(reopened)?.repositories[0]).toEqual(before);
      } finally {
        reopened.close();
      }
    },
  );

  it('records edges from files with null languages as unknown language', () => {
    const source = makeSymbol('src/source', 'source', 0);
    const target = makeSymbol('src/target.ts', 'target', 0);
    writeFile(store, 'src/target.ts', [target], []);
    writeFile(
      store,
      'src/source',
      [source],
      [makeCallEdge('src/source', source, target, 1)],
      null,
    );

    recordGraphDiagnostics({
      db,
      scans: new Map([
        [
          REPO,
          {
            eligibleFiles: 2,
            unsupportedFiles: 0,
            excludedFiles: 0,
            examples: [],
          },
        ],
      ]),
      derived: [],
      derivedRefreshed: false,
      computeDerived: false,
      factsChanged: true,
      freshness: 'content',
    });

    expect(readGraphDiagnostics(db)?.repositories[0].edges).toContainEqual({
      kind: 'CALLS',
      language: 'unknown',
      reason: 'resolved',
      count: 1,
    });
  });

  it('loads symbols/edges/files from the store, computes communities + flows, and persists them', async () => {
    seedCallGraph();

    const result = await computeDerivedForRepo({ store, repoId: REPO });

    expect(result.repoId).toBe(REPO);
    expect(result.computed).toBe(true);
    expect(result.communitiesSkipped).toBe(false);
    expect(result.flowsGlobalCapReached).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.communityCount).toBeGreaterThan(0);
    expect(result.flowCount).toBeGreaterThan(0);

    // Persisted, not just returned in memory.
    expect(store.getDerivedStats(REPO)).toEqual({
      communityCount: result.communityCount,
      flowCount: result.flowCount,
    });
    const flows = store.listFlows(REPO);
    expect(flows).toHaveLength(result.flowCount);
    expect(flows.some((flow) => flow.name === 'src/main.ts::run')).toBe(true);
    expect(store.listCommunities(REPO).length).toBe(result.communityCount);
  });

  it('returns zeroed, computed:true stats for a repo with no symbols yet', async () => {
    const result = await computeDerivedForRepo({ store, repoId: REPO });

    expect(result).toEqual({
      repoId: REPO,
      computed: true,
      communityCount: 0,
      flowCount: 0,
      communitiesSkipped: false,
      flowsGlobalCapReached: false,
      warnings: [],
    });
  });

  it('is non-fatal for a thrown flow-tracing stage: reports a warning and leaves prior derived data untouched', async () => {
    seedCallGraph();
    const first = await computeDerivedForRepo({ store, repoId: REPO });
    expect(first.computed).toBe(true);
    const priorCommunityIds = store
      .listCommunities(REPO)
      .map((c) => c.id)
      .sort();
    const priorFlowIds = store
      .listFlows(REPO)
      .map((f) => f.id)
      .sort();
    expect(priorCommunityIds.length).toBeGreaterThan(0);
    expect(priorFlowIds.length).toBeGreaterThan(0);

    const second = await computeDerivedForRepo({
      store,
      repoId: REPO,
      traceFlowsFn: () => {
        throw new Error('boom: flow tracing exploded');
      },
    });

    expect(second.computed).toBe(false);
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).toContain('boom: flow tracing exploded');
    // Reports the CURRENT (unchanged) store state, not a hardcoded 0.
    expect(second.communityCount).toBe(priorCommunityIds.length);
    expect(second.flowCount).toBe(priorFlowIds.length);

    // `replaceDerivedForRepo` was never reached: the prior successful run's
    // rows are still exactly what's in the store.
    expect(
      store
        .listCommunities(REPO)
        .map((c) => c.id)
        .sort(),
    ).toEqual(priorCommunityIds);
    expect(
      store
        .listFlows(REPO)
        .map((f) => f.id)
        .sort(),
    ).toEqual(priorFlowIds);
  });

  it('is non-fatal for a thrown community-detection stage too, and never reaches flow tracing or persistence', async () => {
    seedCallGraph();
    let traceFlowsCalled = false;

    const result = await computeDerivedForRepo({
      store,
      repoId: REPO,
      detectCommunitiesFn: (): CommunityDetectionResult => {
        throw new Error('boom: community detection exploded');
      },
      traceFlowsFn: () => {
        traceFlowsCalled = true;
        return {
          entryPointCount: 0,
          flows: [],
          memberships: [],
          globalCapReached: false,
        };
      },
    });

    expect(result.computed).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('boom: community detection exploded');
    expect(result.communityCount).toBe(0);
    expect(result.flowCount).toBe(0);
    expect(traceFlowsCalled).toBe(false);
    expect(store.getDerivedStats(REPO)).toEqual({
      communityCount: 0,
      flowCount: 0,
    });
  });

  it('is deterministic across two calls: stable community/flow ids survive a real store round-trip of previousMemberships', async () => {
    seedCallGraph();

    const first = await computeDerivedForRepo({ store, repoId: REPO });
    const firstCommunityIds = store
      .listCommunities(REPO)
      .map((c) => c.id)
      .sort();
    const firstFlowIds = store
      .listFlows(REPO)
      .map((f) => f.id)
      .sort();

    const second = await computeDerivedForRepo({ store, repoId: REPO });
    const secondCommunityIds = store
      .listCommunities(REPO)
      .map((c) => c.id)
      .sort();
    const secondFlowIds = store
      .listFlows(REPO)
      .map((f) => f.id)
      .sort();

    expect(second.communityCount).toBe(first.communityCount);
    expect(second.flowCount).toBe(first.flowCount);
    expect(secondCommunityIds).toEqual(firstCommunityIds);
    expect(secondFlowIds).toEqual(firstFlowIds);
  });
});
