import {
  GRAPH_LABEL_CAP,
  buildLinkHoverState,
  buildNodeHoverState,
  buildRetrievalPaintState,
  countHiddenHighlightEntities,
  DEFAULT_ENTITY_GRAPH_FILTERS,
  deriveRetrievalHighlight,
  entityGraphCacheKey,
  entityGraphFilterSearch,
  hasActiveEntityGraphFilters,
  mergeEntityGraphData,
  parseEntityGraphFilters,
  sameIdSet,
  type EntityGraphSimData,
} from '../graph-helpers';
import type {
  ExplorerEntityGraph,
  ExplorerRetrievalPreview,
} from '@canopy/protocol/settings/organization-memory';

function makeGraph(
  overrides: Partial<ExplorerEntityGraph> = {},
): ExplorerEntityGraph {
  return {
    nodes: [
      {
        id: 'a',
        canonicalName: 'Alpha',
        entityType: 'SERVICE',
        factCount: 2,
        factIds: ['f1', 'f2'],
      },
      {
        id: 'b',
        canonicalName: 'Beta',
        entityType: 'CODE',
        factCount: 1,
        factIds: ['f1'],
      },
    ],
    edges: [{ source: 'a', target: 'b', weight: 2, factIds: ['f1'] }],
    truncated: false,
    ...overrides,
  };
}

describe('mergeEntityGraphData', () => {
  it('builds fresh sim objects with precomputed link keys on first load', () => {
    const { data, reused } = mergeEntityGraphData(null, makeGraph());
    expect(reused).toBe(false);
    expect(data.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(data.links).toHaveLength(1);
    expect(data.links[0].key).toBe('a:b');
    expect(data.links[0].source).toBe('a');
  });

  it('drops edges whose endpoints are not in the node set', () => {
    const graph = makeGraph({
      edges: [
        { source: 'a', target: 'b', weight: 1, factIds: [] },
        { source: 'a', target: 'ghost', weight: 1, factIds: [] },
      ],
    });
    const { data } = mergeEntityGraphData(null, graph);
    expect(data.links).toHaveLength(1);
  });

  it('reuses the container identity and updates fields in place when sets match', () => {
    const first = mergeEntityGraphData(null, makeGraph()).data;
    // Simulate the force layout having positioned the nodes.
    first.nodes[0].x = 10;
    first.nodes[0].y = 20;
    first.nodes[0].vx = 0.5;
    first.nodes[0].vy = -0.5;

    const refreshed = makeGraph();
    refreshed.nodes[0].factCount = 7;
    refreshed.nodes[0].canonicalName = 'Alpha Renamed';
    refreshed.edges[0].weight = 9;
    const { data, reused } = mergeEntityGraphData(first, refreshed);

    expect(reused).toBe(true);
    expect(data).toBe(first);
    expect(data.nodes[0]).toBe(first.nodes[0]);
    expect(data.nodes[0].factCount).toBe(7);
    expect(data.nodes[0].canonicalName).toBe('Alpha Renamed');
    expect(data.nodes[0].x).toBe(10);
    expect(data.links[0].weight).toBe(9);
  });

  it('carries positions, velocities, and pins onto new node objects when the set changes', () => {
    const first = mergeEntityGraphData(null, makeGraph()).data;
    first.nodes[0].x = 10;
    first.nodes[0].y = 20;
    first.nodes[0].vx = 1;
    first.nodes[0].vy = 2;
    first.nodes[1].x = -5;
    first.nodes[1].y = -6;
    first.nodes[1].fx = -5;
    first.nodes[1].fy = -6;

    const grown = makeGraph();
    grown.nodes.push({
      id: 'c',
      canonicalName: 'Gamma',
      entityType: 'TOOL',
      factCount: 1,
      factIds: ['f3'],
    });
    grown.edges.push({ source: 'b', target: 'c', weight: 1, factIds: ['f3'] });
    const { data, reused } = mergeEntityGraphData(first, grown);

    expect(reused).toBe(false);
    expect(data).not.toBe(first);
    const carriedA = data.nodes.find((node) => node.id === 'a');
    expect(carriedA).not.toBe(first.nodes[0]);
    expect(carriedA?.x).toBe(10);
    expect(carriedA?.y).toBe(20);
    expect(carriedA?.vx).toBe(1);
    expect(carriedA?.vy).toBe(2);
    const carriedB = data.nodes.find((node) => node.id === 'b');
    expect(carriedB?.fx).toBe(-5);
    expect(carriedB?.fy).toBe(-6);
    const fresh = data.nodes.find((node) => node.id === 'c');
    expect(fresh?.x).toBeUndefined();
  });

  it('treats an edge-set change as a set change even with identical nodes', () => {
    const first = mergeEntityGraphData(null, makeGraph()).data;
    const rewired = makeGraph({ edges: [] });
    const { reused } = mergeEntityGraphData(first, rewired);
    expect(reused).toBe(false);
  });

  it('is idempotent when re-run with the same payload (StrictMode double render)', () => {
    const first = mergeEntityGraphData(null, makeGraph()).data;
    const again = mergeEntityGraphData(first, makeGraph());
    expect(again.reused).toBe(true);
    expect(again.data).toBe(first);
  });
});

describe('entity graph filters', () => {
  it('parses missing params to the defaults', () => {
    expect(parseEntityGraphFilters(new URLSearchParams())).toEqual(
      DEFAULT_ENTITY_GRAPH_FILTERS,
    );
  });

  it('sanitizes an invalid liveness to live', () => {
    expect(
      parseEntityGraphFilters(new URLSearchParams('liveness=bogus')).liveness,
    ).toBe('live');
  });

  it('round-trips through the search string', () => {
    const filters = {
      liveness: 'all',
      from: '2026-07-01',
      to: '2026-07-31',
      q: 'billing',
    } as const;
    const search = entityGraphFilterSearch(filters);
    expect(parseEntityGraphFilters(new URLSearchParams(search))).toEqual(
      filters,
    );
  });

  it('omits defaults so equivalent filters share a cache key', () => {
    expect(entityGraphFilterSearch(DEFAULT_ENTITY_GRAPH_FILTERS)).toBe('');
    expect(entityGraphCacheKey('org1', DEFAULT_ENTITY_GRAPH_FILTERS)).toBe(
      entityGraphCacheKey('org1', {
        ...DEFAULT_ENTITY_GRAPH_FILTERS,
        liveness: 'live',
      }),
    );
    expect(entityGraphCacheKey('org1', DEFAULT_ENTITY_GRAPH_FILTERS)).not.toBe(
      entityGraphCacheKey('org2', DEFAULT_ENTITY_GRAPH_FILTERS),
    );
    expect(entityGraphCacheKey('org1', DEFAULT_ENTITY_GRAPH_FILTERS)).not.toBe(
      entityGraphCacheKey('org1', {
        ...DEFAULT_ENTITY_GRAPH_FILTERS,
        q: 'api',
      }),
    );
  });

  it('reports active filters', () => {
    expect(hasActiveEntityGraphFilters(DEFAULT_ENTITY_GRAPH_FILTERS)).toBe(
      false,
    );
    expect(
      hasActiveEntityGraphFilters({
        ...DEFAULT_ENTITY_GRAPH_FILTERS,
        from: '2026-01-01',
      }),
    ).toBe(true);
  });
});

describe('sameIdSet', () => {
  it('matches order-insensitively', () => {
    expect(sameIdSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIdSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameIdSet(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });

  it('handles duplicate ids', () => {
    expect(sameIdSet(['a', 'a'], ['a', 'a'])).toBe(true);
    expect(sameIdSet(['a', 'a'], ['a', 'b'])).toBe(false);
  });
});

function makePreview(): ExplorerRetrievalPreview {
  const fact: ExplorerRetrievalPreview['facts'][number] = {
    id: 'f1',
    factText: 'Alpha talks to Beta',
    evidenceType: 'OBSERVED',
    evidenceQuote: null,
    validAt: null,
    invalidAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    expiredAt: null,
    invalidatedById: null,
    liveness: 'live',
    entities: [
      { id: 'a', canonicalName: 'Alpha', entityType: 'SERVICE' },
      { id: 'b', canonicalName: 'Beta', entityType: 'CODE' },
    ],
  };
  return {
    gatePassed: true,
    candidateCount: 3,
    facts: [fact],
    candidates: [
      { factId: 'f2', score: 0.4, entityIds: ['b', 'c'] },
      { factId: 'f3', score: 0.3, entityIds: ['d'] },
    ],
    renderedBlock: null,
    truncated: false,
    diagnostics: {
      laneCounts: { vector: 1, fts: 1, trigram: 0, graph: 0 },
      rerankUsed: true,
      topRerankScore: 0.9,
      topCosineScore: 0.8,
      latencyMs: 12,
      topScores: { rerank: [0.9], cosine: [0.8], rrf: [0.5] },
    },
  };
}

describe('retrieval highlight derivation', () => {
  it('splits injected entities from non-injected candidate entities', () => {
    const highlight = deriveRetrievalHighlight(makePreview());
    expect([...highlight.injectedIds].sort()).toEqual(['a', 'b']);
    // 'b' is injected, so the candidate set only keeps the near-miss-only ids.
    expect([...highlight.candidateIds].sort()).toEqual(['c', 'd']);
  });

  it('counts highlighted entities hidden by the current filters', () => {
    const highlight = deriveRetrievalHighlight(makePreview());
    expect(
      countHiddenHighlightEntities(highlight, new Set(['a', 'b', 'c', 'd'])),
    ).toBe(0);
    expect(countHiddenHighlightEntities(highlight, new Set(['a', 'c']))).toBe(
      2,
    );
    expect(countHiddenHighlightEntities(highlight, new Set())).toBe(4);
  });

  it('caps paint labels at GRAPH_LABEL_CAP, injected first', () => {
    const injectedIds = new Set<string>(
      Array.from({ length: 20 }, (_, index) => `i${index}`),
    );
    const candidateIds = new Set<string>(
      Array.from({ length: 20 }, (_, index) => `c${index}`),
    );
    const paint = buildRetrievalPaintState({ injectedIds, candidateIds });
    expect(paint.labelIds.size).toBe(GRAPH_LABEL_CAP);
    for (const id of Array.from(injectedIds)) {
      expect(paint.labelIds.has(id)).toBe(true);
    }
  });
});

describe('hover state builders', () => {
  it('caps hover neighborhood labels but not the highlight itself', () => {
    const neighbors = new Set(
      Array.from({ length: 100 }, (_, index) => `n${index}`),
    );
    const state = buildNodeHoverState('hub', neighbors);
    expect(state.dim).toBe(true);
    expect(state.nodeIds.size).toBe(101);
    expect(state.linkKeys.size).toBe(200);
    expect(state.labelIds.size).toBe(GRAPH_LABEL_CAP);
    expect(state.labelIds.has('hub')).toBe(true);
  });

  it('builds a non-dimming link hover state from the precomputed key', () => {
    const state = buildLinkHoverState('a:b');
    expect(state.dim).toBe(false);
    expect([...state.nodeIds].sort()).toEqual(['a', 'b']);
    expect([...state.linkKeys]).toEqual(['a:b']);
  });
});

describe('EntityGraphSimData type usage', () => {
  it('accepts the merged data as simulation data', () => {
    const { data } = mergeEntityGraphData(null, makeGraph());
    const sim: EntityGraphSimData = data;
    expect(sim.nodes.length).toBeGreaterThan(0);
  });
});
