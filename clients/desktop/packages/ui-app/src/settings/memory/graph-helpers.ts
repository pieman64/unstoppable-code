import type { LinkObject, NodeObject } from 'react-force-graph-2d';
import type {
  ExplorerEntityGraph,
  ExplorerGraphNode,
  ExplorerRetrievalPreview,
} from '@canopy/protocol/settings/organization-memory';

// Pure helpers for the entity graph view. Everything here is deliberately free
// of React/DOM so the merge, cache-key, and highlight logic stays unit-testable.

export interface EntityGraphLinkDatum {
  // Precomputed `${sourceId}:${targetId}` so per-frame paint accessors never
  // rebuild the key with string concat.
  key: string;
  weight: number;
  factIds: string[];
}

export type EntityGraphSimNode = NodeObject<ExplorerGraphNode>;
export type EntityGraphSimLink = LinkObject<
  ExplorerGraphNode,
  EntityGraphLinkDatum
>;

export interface EntityGraphSimData {
  nodes: EntityGraphSimNode[];
  links: EntityGraphSimLink[];
}

export function linkKey(sourceId: string, targetId: string): string {
  return `${sourceId}:${targetId}`;
}

/**
 * Merge a fresh graph payload into the previous simulation data.
 *
 * - When the node and edge sets are unchanged, the previous node/link objects
 *   are updated in place and the previous container identity is returned
 *   (`reused: true`). Handing force-graph the same `graphData` object skips its
 *   unconditional alpha(1) reheat entirely, so plain refreshes cannot jitter.
 * - When the sets changed, new objects are built but existing nodes carry over
 *   their simulation state (x/y/vx/vy and any fx/fy pin), so only genuinely
 *   new nodes need to be laid out when the library reheats.
 */
export function mergeEntityGraphData(
  previous: EntityGraphSimData | null,
  graph: ExplorerEntityGraph,
): { data: EntityGraphSimData; reused: boolean } {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );

  if (previous !== null) {
    const previousNodes = new Map(
      previous.nodes.map((node) => [node.id, node]),
    );
    const previousLinks = new Map(
      previous.links.map((link) => [link.key, link]),
    );
    const sameSets =
      previousNodes.size === nodeIds.size &&
      graph.nodes.every((node) => previousNodes.has(node.id)) &&
      previousLinks.size === edges.length &&
      edges.every((edge) =>
        previousLinks.has(linkKey(edge.source, edge.target)),
      );
    if (sameSets) {
      for (const node of graph.nodes) {
        const existing = previousNodes.get(node.id);
        if (existing === undefined) continue;
        existing.canonicalName = node.canonicalName;
        existing.entityType = node.entityType;
        existing.factCount = node.factCount;
        existing.factIds = [...node.factIds];
      }
      for (const edge of edges) {
        const existing = previousLinks.get(linkKey(edge.source, edge.target));
        if (existing === undefined) continue;
        existing.weight = edge.weight;
        existing.factIds = [...edge.factIds];
      }
      return { data: previous, reused: true };
    }
  }

  const previousById = new Map(
    (previous?.nodes ?? []).map((node) => [node.id, node]),
  );
  const nodes: EntityGraphSimNode[] = graph.nodes.map((node) => {
    const next: EntityGraphSimNode = { ...node, factIds: [...node.factIds] };
    const existing = previousById.get(node.id);
    if (
      existing !== undefined &&
      typeof existing.x === 'number' &&
      typeof existing.y === 'number'
    ) {
      next.x = existing.x;
      next.y = existing.y;
      next.vx = existing.vx;
      next.vy = existing.vy;
      if (typeof existing.fx === 'number') next.fx = existing.fx;
      if (typeof existing.fy === 'number') next.fy = existing.fy;
    }
    return next;
  });
  const links: EntityGraphSimLink[] = edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    key: linkKey(edge.source, edge.target),
    weight: edge.weight,
    factIds: [...edge.factIds],
  }));
  return { data: { nodes, links }, reused: false };
}

export type EntityGraphLiveness = 'live' | 'superseded' | 'all';

export interface EntityGraphFilters {
  liveness: EntityGraphLiveness;
  /** YYYY-MM-DD or empty. */
  from: string;
  /** YYYY-MM-DD or empty. */
  to: string;
  /** Entity name contains-search or empty. */
  q: string;
}

export const DEFAULT_ENTITY_GRAPH_FILTERS: EntityGraphFilters = {
  liveness: 'live',
  from: '',
  to: '',
  q: '',
};

export function parseEntityGraphFilters(params: {
  get(name: string): string | null;
}): EntityGraphFilters {
  const liveness = params.get('liveness');
  return {
    liveness:
      liveness === 'superseded' || liveness === 'all' ? liveness : 'live',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    q: params.get('q')?.trim() ?? '',
  };
}

// Defaults are omitted so the string doubles as both the shareable URL search
// segment and the fetch query string, and so equivalent filter states always
// produce the same cache key.
export function entityGraphFilterSearch(filters: EntityGraphFilters): string {
  const params = new URLSearchParams();
  if (filters.liveness !== 'live') params.set('liveness', filters.liveness);
  if (filters.from.length > 0) params.set('from', filters.from);
  if (filters.to.length > 0) params.set('to', filters.to);
  if (filters.q.length > 0) params.set('q', filters.q);
  return params.toString();
}

export function entityGraphCacheKey(
  orgId: string,
  filters: EntityGraphFilters,
): string {
  return `${orgId}?${entityGraphFilterSearch(filters)}`;
}

export function sameEntityGraphFilters(
  left: EntityGraphFilters,
  right: EntityGraphFilters,
): boolean {
  return (
    left.liveness === right.liveness &&
    left.from === right.from &&
    left.to === right.to &&
    left.q === right.q
  );
}

export function hasActiveEntityGraphFilters(
  filters: EntityGraphFilters,
): boolean {
  return !sameEntityGraphFilters(filters, DEFAULT_ENTITY_GRAPH_FILTERS);
}

/** Order-insensitive id-set equality (used to skip redundant fact refetches). */
export function sameIdSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  if (seen.size !== left.length) {
    // Duplicates make length comparison unreliable; fall back to set compare.
    const rightSet = new Set(right);
    return (
      seen.size === rightSet.size && [...seen].every((id) => rightSet.has(id))
    );
  }
  return right.every((id) => seen.has(id));
}

export interface RetrievalHighlight {
  /** Entities of facts the pipeline would inject: strong highlight. */
  injectedIds: ReadonlySet<string>;
  /** Entities of post-rerank near-miss candidates: secondary highlight. */
  candidateIds: ReadonlySet<string>;
}

export function deriveRetrievalHighlight(
  preview: ExplorerRetrievalPreview,
): RetrievalHighlight {
  const injectedIds = new Set<string>();
  for (const fact of preview.facts) {
    for (const entity of fact.entities) {
      injectedIds.add(entity.id);
    }
  }
  const candidateIds = new Set<string>();
  for (const candidate of preview.candidates) {
    for (const entityId of candidate.entityIds) {
      if (!injectedIds.has(entityId)) {
        candidateIds.add(entityId);
      }
    }
  }
  return { injectedIds, candidateIds };
}

export function countHiddenHighlightEntities(
  highlight: RetrievalHighlight,
  visibleNodeIds: ReadonlySet<string>,
): number {
  let hidden = 0;
  for (const id of highlight.injectedIds) {
    if (!visibleNodeIds.has(id)) hidden += 1;
  }
  for (const id of highlight.candidateIds) {
    if (!visibleNodeIds.has(id)) hidden += 1;
  }
  return hidden;
}

// Hovering a hub node would otherwise paint hundreds of fillText labels per
// frame; the neighborhood label set is capped, highlight rings are not.
export const GRAPH_LABEL_CAP = 30;

export interface HoverHighlightState {
  active: boolean;
  // Whether non-highlighted elements fade. Only node hover dims the rest of
  // the graph; link hover just emphasizes the hovered link. Fading the whole
  // canvas on link hover made ordinary mouse travel across the view strobe,
  // because wide link hit areas toggle hover constantly.
  dim: boolean;
  nodeIds: ReadonlySet<string>;
  linkKeys: ReadonlySet<string>;
  labelIds: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export const INACTIVE_HOVER: HoverHighlightState = {
  active: false,
  dim: false,
  nodeIds: EMPTY_SET,
  linkKeys: EMPTY_SET,
  labelIds: EMPTY_SET,
};

export function buildNodeHoverState(
  nodeId: string,
  neighborIds: ReadonlySet<string> | undefined,
): HoverHighlightState {
  const nodes = new Set<string>([nodeId]);
  const links = new Set<string>();
  const labels = new Set<string>([nodeId]);
  for (const neighborId of neighborIds ?? []) {
    nodes.add(neighborId);
    links.add(linkKey(nodeId, neighborId));
    links.add(linkKey(neighborId, nodeId));
    if (labels.size < GRAPH_LABEL_CAP) {
      labels.add(neighborId);
    }
  }
  return {
    active: true,
    dim: true,
    nodeIds: nodes,
    linkKeys: links,
    labelIds: labels,
  };
}

export function buildLinkHoverState(key: string): HoverHighlightState {
  const [source, target] = key.split(':');
  const nodes = new Set(
    [source, target].filter((id): id is string => id !== undefined),
  );
  return {
    active: true,
    dim: false,
    nodeIds: nodes,
    linkKeys: new Set([key]),
    labelIds: nodes,
  };
}

export interface RetrievalPaintState {
  injectedIds: ReadonlySet<string>;
  candidateIds: ReadonlySet<string>;
  labelIds: ReadonlySet<string>;
}

export function buildRetrievalPaintState(
  highlight: RetrievalHighlight,
): RetrievalPaintState {
  const labels = new Set<string>();
  for (const id of highlight.injectedIds) {
    if (labels.size >= GRAPH_LABEL_CAP) break;
    labels.add(id);
  }
  for (const id of highlight.candidateIds) {
    if (labels.size >= GRAPH_LABEL_CAP) break;
    labels.add(id);
  }
  return {
    injectedIds: highlight.injectedIds,
    candidateIds: highlight.candidateIds,
    labelIds: labels,
  };
}
