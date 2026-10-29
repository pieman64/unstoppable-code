import { edgeRowId, fileRowId, symbolQualifiedName, symbolRowId } from '../ids';
import {
  CODE_GRAPH_EDGE_KINDS,
  type CodeGraphEdgeKind,
  type CodeGraphEdgeRecord,
  type CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import {
  CODE_GRAPH_COMMUNITY_EDGE_WEIGHTS,
  CODE_GRAPH_COMMUNITY_MAX_SYMBOLS,
  detectCommunities,
  type CommunityDetectionResult,
} from '../analysis/communities';

const REPO = 'repo-a';

// --- Fixture helpers (mirrors derived-store.test.ts's hand-built pattern) --

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

function makeEdge(
  kind: CodeGraphEdgeKind,
  relativePath: string,
  source: CodeGraphSymbolRecord,
  target: CodeGraphSymbolRecord,
  line: number,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: REPO,
      kind,
      sourceId: source.id,
      target: target.name,
      line,
    }),
    repositoryId: REPO,
    kind,
    sourceSymbolId: source.id,
    targetSymbolId: target.id,
    sourceFileId: fileRowId(REPO, relativePath),
    targetRef: target.name,
    line,
    confidenceTier: 'RESOLVED',
    confidenceScore: 0.9,
    resolverId: null,
    evidence: {},
  };
}

function fileMapFor(...relativePaths: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const relativePath of relativePaths) {
    map.set(fileRowId(REPO, relativePath), relativePath);
  }
  return map;
}

// Two internally-dense clusters {p,q} and {r,s,t} joined by exactly one weak
// (REFERENCES, weight 0.6) edge, plus a fully disconnected `iso` node. Chosen
// so the clusters' internal weight (CALLS, weight 1.0 each) heavily dominates
// the single cross-cluster edge -- a classic clean-separation Louvain case --
// AND so cohesion is hand-computable (see the "cohesion math" test).
function buildTwoClusterFixture(): {
  symbols: CodeGraphSymbolRecord[];
  edges: CodeGraphEdgeRecord[];
  fileRelativePathById: Map<string, string>;
  p: CodeGraphSymbolRecord;
  q: CodeGraphSymbolRecord;
  r: CodeGraphSymbolRecord;
  s: CodeGraphSymbolRecord;
  t: CodeGraphSymbolRecord;
  iso: CodeGraphSymbolRecord;
} {
  const p = makeSymbol('src/cluster-a/p.ts', 'p', 0);
  const q = makeSymbol('src/cluster-a/q.ts', 'q', 0);
  const r = makeSymbol('src/cluster-b/r.ts', 'r', 0);
  const s = makeSymbol('src/cluster-b/s.ts', 's', 0);
  const t = makeSymbol('src/cluster-b/t.ts', 't', 0);
  const iso = makeSymbol('src/misc/iso.ts', 'iso', 0);

  const edges: CodeGraphEdgeRecord[] = [
    makeEdge('CALLS', 'src/cluster-a/p.ts', p, q, 1),
    makeEdge('REFERENCES', 'src/cluster-a/p.ts', p, r, 2),
    makeEdge('CALLS', 'src/cluster-b/r.ts', r, s, 1),
    makeEdge('CALLS', 'src/cluster-b/r.ts', r, t, 2),
    makeEdge('CALLS', 'src/cluster-b/s.ts', s, t, 1),
  ];

  return {
    symbols: [p, q, r, s, t, iso],
    edges,
    fileRelativePathById: fileMapFor(
      'src/cluster-a/p.ts',
      'src/cluster-a/q.ts',
      'src/cluster-b/r.ts',
      'src/cluster-b/s.ts',
      'src/cluster-b/t.ts',
      'src/misc/iso.ts',
    ),
    p,
    q,
    r,
    s,
    t,
    iso,
  };
}

function communityOf(
  result: CommunityDetectionResult,
  symbolId: string,
): string | undefined {
  return result.memberships.find((m) => m.symbolId === symbolId)?.communityId;
}

describe('CODE_GRAPH_COMMUNITY_EDGE_WEIGHTS', () => {
  it('assigns a weight to every CODE_GRAPH_EDGE_KINDS entry, matching the brief verbatim (compile-time exhaustive via Record<CodeGraphEdgeKind, number> -- this is a redundant runtime guard)', () => {
    expect(Object.keys(CODE_GRAPH_COMMUNITY_EDGE_WEIGHTS).sort()).toEqual(
      [...CODE_GRAPH_EDGE_KINDS].sort(),
    );
    expect(CODE_GRAPH_COMMUNITY_EDGE_WEIGHTS).toEqual({
      CALLS: 1.0,
      IMPORTS_FROM: 0.8,
      IPC_HANDLES: 0.8,
      IPC_INVOKES: 0.8,
      USES_PIPELINE_ACTION: 0.7,
      REFERENCES: 0.6,
      DECLARES_MCP_TOOL: 0.5,
      DECLARES_DEPENDENCY: 0.4,
      DECLARES_SCRIPT: 0.4,
      CONFIGURES: 0.4,
      TESTED_BY: 0.4,
      DOCUMENTS: 0.3,
      RATIONALE_FOR: 0.3,
      CONTAINS: 0.3,
    });
  });
});

describe('detectCommunities: determinism', () => {
  it('produces byte-identical output across two runs on the same input', () => {
    const fixture = buildTwoClusterFixture();
    const run = (): CommunityDetectionResult =>
      detectCommunities({
        repoId: REPO,
        symbols: fixture.symbols,
        edges: fixture.edges,
        fileRelativePathById: fixture.fileRelativePathById,
      });

    const result1 = run();
    const result2 = run();
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
    expect(result1.communities.length).toBeGreaterThan(0);
  });
});

describe('detectCommunities: two-cluster separation', () => {
  it('separates two dense clusters joined by one weak edge, and leaves a disconnected node as its own singleton', () => {
    const fixture = buildTwoClusterFixture();
    const result = detectCommunities({
      repoId: REPO,
      symbols: fixture.symbols,
      edges: fixture.edges,
      fileRelativePathById: fixture.fileRelativePathById,
    });

    expect(result.skipped).toBe(false);
    expect(result.communities).toHaveLength(3);

    const communityA = communityOf(result, fixture.p.id);
    const communityB = communityOf(result, fixture.r.id);
    const communityIso = communityOf(result, fixture.iso.id);

    expect(communityOf(result, fixture.q.id)).toBe(communityA);
    expect(communityOf(result, fixture.s.id)).toBe(communityB);
    expect(communityOf(result, fixture.t.id)).toBe(communityB);
    expect(communityA).not.toBe(communityB);
    expect(communityIso).not.toBe(communityA);
    expect(communityIso).not.toBe(communityB);

    // Isolated nodes (zero edges) form their own singleton community, with
    // cohesion defined as 0 (0/0 internal+external -- see communities.ts).
    const isoCommunity = result.communities.find((c) => c.id === communityIso);
    expect(isoCommunity?.size).toBe(1);
    expect(isoCommunity?.cohesion).toBe(0);

    const clusterACommunity = result.communities.find(
      (c) => c.id === communityA,
    );
    const clusterBCommunity = result.communities.find(
      (c) => c.id === communityB,
    );
    expect(clusterACommunity?.label).toBe('src/cluster-a');
    expect(clusterBCommunity?.label).toBe('src/cluster-b');
  });
});

describe('detectCommunities: cohesion math', () => {
  it('matches hand-computed internal/(internal+external) values', () => {
    const fixture = buildTwoClusterFixture();
    const result = detectCommunities({
      repoId: REPO,
      symbols: fixture.symbols,
      edges: fixture.edges,
      fileRelativePathById: fixture.fileRelativePathById,
    });

    const communityA = result.communities.find(
      (c) => c.id === communityOf(result, fixture.p.id),
    );
    const communityB = result.communities.find(
      (c) => c.id === communityOf(result, fixture.r.id),
    );

    // A = {p,q}: internal = CALLS p-q (1.0); external = REFERENCES p-r (0.6).
    expect(communityA?.cohesion).toBeCloseTo(1.0 / 1.6, 10);
    // B = {r,s,t}: internal = CALLS r-s + r-t + s-t (3.0); external = the
    // same p-r edge (0.6), counted from B's side too.
    expect(communityB?.cohesion).toBeCloseTo(3.0 / 3.6, 10);
  });
});

describe('detectCommunities: stable IDs across a small membership change', () => {
  it('retains the previous community id when Jaccard overlap >= 0.5, and mints a fresh id otherwise', () => {
    const fixture = buildTwoClusterFixture();
    const firstRun = detectCommunities({
      repoId: REPO,
      symbols: fixture.symbols,
      edges: fixture.edges,
      fileRelativePathById: fixture.fileRelativePathById,
    });

    const previousClusterAId = communityOf(firstRun, fixture.p.id);
    const previousClusterBId = communityOf(firstRun, fixture.r.id);
    expect(previousClusterAId).toBeDefined();
    expect(previousClusterBId).toBeDefined();

    // Small membership change: add `u`, densely wired only into cluster B.
    const u = makeSymbol('src/cluster-b/u.ts', 'u', 0);
    const secondSymbols = [...fixture.symbols, u];
    const secondEdges = [
      ...fixture.edges,
      makeEdge('CALLS', 'src/cluster-b/u.ts', u, fixture.r, 1),
      makeEdge('CALLS', 'src/cluster-b/u.ts', u, fixture.s, 2),
      makeEdge('CALLS', 'src/cluster-b/u.ts', u, fixture.t, 3),
    ];
    const secondFileMap = new Map(fixture.fileRelativePathById);
    secondFileMap.set(
      fileRowId(REPO, 'src/cluster-b/u.ts'),
      'src/cluster-b/u.ts',
    );

    const secondRun = detectCommunities({
      repoId: REPO,
      symbols: secondSymbols,
      edges: secondEdges,
      fileRelativePathById: secondFileMap,
      previousMemberships: firstRun.memberships,
    });

    expect(communityOf(secondRun, fixture.p.id)).toBe(previousClusterAId);
    expect(communityOf(secondRun, fixture.r.id)).toBe(previousClusterBId);
    expect(communityOf(secondRun, fixture.s.id)).toBe(previousClusterBId);
    expect(communityOf(secondRun, fixture.t.id)).toBe(previousClusterBId);
    expect(communityOf(secondRun, u.id)).toBe(previousClusterBId);
  });
});

describe('detectCommunities: skip cap', () => {
  it('returns an honest skipped marker instead of running Louvain above 50k symbols', () => {
    function makeMinimalSymbol(id: string): CodeGraphSymbolRecord {
      return {
        id,
        repositoryId: REPO,
        fileId: 'file_stub',
        kind: 'function',
        name: id,
        qualifiedName: id,
        parentSymbolId: null,
        lineStart: 1,
        lineEnd: 1,
        byteStart: 0,
        byteEnd: 1,
        signature: null,
        exported: false,
        isTest: false,
        extra: {},
      };
    }

    const symbols: CodeGraphSymbolRecord[] = [];
    for (let i = 0; i < CODE_GRAPH_COMMUNITY_MAX_SYMBOLS + 1; i++) {
      symbols.push(makeMinimalSymbol(`sym_${i}`));
    }

    const result = detectCommunities({
      repoId: REPO,
      symbols,
      edges: [],
      fileRelativePathById: new Map(),
    });

    expect(result.skipped).toBe(true);
    expect(result.symbolCount).toBe(CODE_GRAPH_COMMUNITY_MAX_SYMBOLS + 1);
    expect(result.communities).toEqual([]);
    expect(result.memberships).toEqual([]);
  });
});

describe('large graph architecture summaries', () => {
  it.each([49_999, 50_000])(
    'retains symbol resolution at the %i-symbol boundary',
    (count) => {
      const symbols = Array.from({ length: count }, (_, i) =>
        makeSymbol('src/one.ts', `fn${i}`, i),
      );
      const result = detectCommunities({
        repoId: REPO,
        symbols,
        edges: [],
        fileRelativePathById: fileMapFor('src/one.ts'),
      });
      expect(result.skipped).toBe(false);
      expect(result.memberships).toHaveLength(count);
      expect(
        result.communities.every(
          (community) => community.extra.resolution !== 'file',
        ),
      ).toBe(true);
    },
  );

  it('projects onto known files above the symbol cap without losing memberships', () => {
    const paths = ['packages/alpha/a.ts', 'packages/beta/b.ts'];
    const symbols = Array.from(
      { length: CODE_GRAPH_COMMUNITY_MAX_SYMBOLS + 1 },
      (_, i) => makeSymbol(paths[i % 2], `f${i}`, i),
    );
    const input = {
      repoId: REPO,
      symbols,
      edges: [],
      fileRelativePathById: fileMapFor(...paths),
    };
    const result = detectCommunities(input);
    expect(result.skipped).toBe(false);
    expect(result.memberships).toHaveLength(symbols.length);
    expect(result.communities.map((c) => c.label).sort()).toEqual([
      'packages/alpha',
      'packages/beta',
    ]);
    expect(result.communities.every((c) => c.extra.resolution === 'file')).toBe(
      true,
    );
    const repeated = detectCommunities({
      ...input,
      symbols: [...symbols].reverse(),
      previousMemberships: result.memberships,
    });
    expect(repeated).toEqual(result);
  });
});
