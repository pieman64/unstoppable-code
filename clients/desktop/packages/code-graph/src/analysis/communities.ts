import { communityFingerprint, communityRowId } from '../ids';
import type {
  CodeGraphCommunityMembershipRecord,
  CodeGraphCommunityRecord,
  CodeGraphEdgeKind,
  CodeGraphEdgeRecord,
  CodeGraphSymbolRecord,
} from '../types/code-graph';

// --- Deterministic Louvain-style community detection -----------------------
//
// Pure module: takes symbol/edge arrays (plus optional previous memberships
// for stable-id retention) and returns a fresh community partition. No
// database access, no store imports -- callers (a later Phase 6 task's
// engine wiring) own persistence via `CodeGraphStore.replaceDerivedForRepo`.
//
// Determinism is a hard invariant: no `Math.random`, no `Date.now`, no
// wall-clock/iteration-order dependence. Every tie is broken by a
// lexicographic string compare over a stable identifier (a node/community
// id, or a directory-prefix label), and nodes/communities are always visited
// in a freshly-sorted order rather than relying on Map/Set insertion order.

// One weight per `CODE_GRAPH_EDGE_KINDS` entry -- typed as
// `Record<CodeGraphEdgeKind, number>` so omitting or mistyping a kind is a
// COMPILE-TIME error (TypeScript's excess/missing-property checking on an
// object literal assigned to a `Record<K, V>` requires every key of `K`,
// no more, no less). `communities.test.ts` also asserts this runtime shape
// against `CODE_GRAPH_EDGE_KINDS` and the brief's verbatim values, as a
// redundant regression guard.
export const CODE_GRAPH_COMMUNITY_EDGE_WEIGHTS: Record<
  CodeGraphEdgeKind,
  number
> = {
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
};

// Above this many symbols, use a bounded file projection. Expanded
// memberships retain every symbol and community metadata labels the approximation.
export const CODE_GRAPH_COMMUNITY_MAX_SYMBOLS = 50_000;

// Greedy stable-id remap only claims a previous community when the Jaccard
// overlap is at least this strong; below it, the new community is treated as
// unrelated and gets a freshly-minted id.
const STABLE_ID_MIN_JACCARD = 0.5;

// Local-moving passes within one Louvain level repeat until a full pass moves
// zero nodes, or this many passes have run -- whichever comes first.
const MAX_LOCAL_MOVE_PASSES = 20;

export interface CommunityDetectionInput {
  repoId: string;
  symbols: readonly CodeGraphSymbolRecord[];
  edges: readonly CodeGraphEdgeRecord[];
  // symbol.fileId -> file.relativePath. `CodeGraphSymbolRecord` only carries
  // `fileId`, not a path, so this lookup is how community labels resolve a
  // member's directory. A later engine-wiring task builds this from the same
  // repo's already-loaded `CodeGraphFileRecord[]`.
  fileRelativePathById: ReadonlyMap<string, string>;
  // Previous run's memberships (if any), consulted only for stable-id
  // retention. Assumed to already be a partition (each symbolId appears at
  // most once), matching the store's own invariant -- if violated, the
  // first membership encountered for a given symbolId wins.
  previousMemberships?: readonly CodeGraphCommunityMembershipRecord[];
}

export interface CommunityDetectionResult {
  skipReason?: string;
  skipped: boolean;
  symbolCount: number;
  communities: CodeGraphCommunityRecord[];
  memberships: CodeGraphCommunityMembershipRecord[];
}

function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

// Unordered pair key -- `a <= b` lexicographically, and `a === b` represents
// a self-loop. Used both for the level-0 projection and every aggregated
// (coarser) level's edge map, so the same weighted-graph representation
// carries through the whole multi-level algorithm.
function pairKey(a: string, b: string): string {
  return a <= b ? `${a} ${b}` : `${b} ${a}`;
}

function unpackPair(key: string): [string, string] {
  const separatorIndex = key.indexOf(' ');
  return [key.slice(0, separatorIndex), key.slice(separatorIndex + 1)];
}

// Projects the raw edge list onto an undirected, kind-weighted graph over
// only the known symbol ids: edges with a null endpoint, or an endpoint
// outside `knownSymbolIds` (e.g. an unresolved target), are dropped. Parallel
// edges between the same unordered pair (any kind, any direction) sum.
function buildLevelZeroEdges(
  edges: readonly CodeGraphEdgeRecord[],
  knownSymbolIds: ReadonlySet<string>,
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const edge of edges) {
    const { sourceSymbolId, targetSymbolId } = edge;
    if (sourceSymbolId === null || targetSymbolId === null) {
      continue;
    }
    if (
      !knownSymbolIds.has(sourceSymbolId) ||
      !knownSymbolIds.has(targetSymbolId)
    ) {
      continue;
    }
    const weight = CODE_GRAPH_COMMUNITY_EDGE_WEIGHTS[edge.kind];
    const key = pairKey(sourceSymbolId, targetSymbolId);
    weights.set(key, (weights.get(key) ?? 0) + weight);
  }
  return weights;
}

interface GraphView {
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>;
  degree: ReadonlyMap<string, number>;
  totalWeight: number;
}

// Derives adjacency (non-self edges only), degree (k_i, with each self-loop
// counted TWICE per the standard Louvain/nx convention so aggregation stays
// consistent -- see `aggregateEdges`), and total graph weight `m` (each
// unordered pair, including self-loops, counted once) from the canonical
// pairKey->weight edge map. `nodes` is passed separately so a node with zero
// edges (isolated) is still represented, with degree 0.
function buildGraphView(
  nodes: readonly string[],
  edges: ReadonlyMap<string, number>,
): GraphView {
  const adjacency = new Map<string, Map<string, number>>();
  const loop = new Map<string, number>();
  for (const node of nodes) {
    adjacency.set(node, new Map());
  }
  let totalWeight = 0;
  for (const [key, weight] of Array.from(edges)) {
    totalWeight += weight;
    const [a, b] = unpackPair(key);
    if (a === b) {
      loop.set(a, (loop.get(a) ?? 0) + weight);
      continue;
    }
    const adjacencyA = adjacency.get(a) ?? new Map<string, number>();
    adjacencyA.set(b, (adjacencyA.get(b) ?? 0) + weight);
    adjacency.set(a, adjacencyA);
    const adjacencyB = adjacency.get(b) ?? new Map<string, number>();
    adjacencyB.set(a, (adjacencyB.get(a) ?? 0) + weight);
    adjacency.set(b, adjacencyB);
  }
  const degree = new Map<string, number>();
  for (const node of nodes) {
    let k = 2 * (loop.get(node) ?? 0);
    for (const weight of Array.from(
      (adjacency.get(node) ?? new Map<string, number>()).values(),
    )) {
      k += weight;
    }
    degree.set(node, k);
  }
  return { adjacency, degree, totalWeight };
}

// One Louvain "local moving" stage: repeatedly scans every node (ascending id
// order, a fresh full pass each time) and moves it to the neighboring
// community that gives the strictly-highest modularity gain relative to
// staying put -- ties broken by smallest candidate community id. Stops when
// a full pass moves nothing, or after `MAX_LOCAL_MOVE_PASSES`.
//
// Returns each CURRENT node re-keyed to its final community's smallest
// member id (a stable, deterministic representative that survives
// aggregation -- see the module header comment). A node whose gain is never
// strictly better than its own baseline keeps its original singleton
// identity, which is how isolated/undominated nodes end up as singletons.
function runLocalMovingStage(
  nodes: readonly string[],
  edges: ReadonlyMap<string, number>,
  resolution: number,
): Map<string, string> {
  const { adjacency, degree, totalWeight } = buildGraphView(nodes, edges);
  const twoM = 2 * totalWeight;

  const community = new Map<string, string>();
  const communityTotalDegree = new Map<string, number>();
  for (const node of nodes) {
    community.set(node, node);
    communityTotalDegree.set(node, degree.get(node) ?? 0);
  }

  function gainFor(
    candidateCommunity: string,
    neighborWeight: number,
    nodeDegree: number,
  ): number {
    if (twoM === 0) {
      return 0;
    }
    const sigmaTot = communityTotalDegree.get(candidateCommunity) ?? 0;
    return neighborWeight - (resolution * sigmaTot * nodeDegree) / twoM;
  }

  for (let pass = 0; pass < MAX_LOCAL_MOVE_PASSES; pass++) {
    let movedThisPass = false;
    for (const node of nodes) {
      const currentCommunity = community.get(node) ?? node;
      const nodeDegree = degree.get(node) ?? 0;

      communityTotalDegree.set(
        currentCommunity,
        (communityTotalDegree.get(currentCommunity) ?? 0) - nodeDegree,
      );

      const neighborWeightByCommunity = new Map<string, number>();
      for (const [neighbor, weight] of Array.from(
        adjacency.get(node) ?? new Map<string, number>(),
      )) {
        const neighborCommunity = community.get(neighbor) ?? neighbor;
        neighborWeightByCommunity.set(
          neighborCommunity,
          (neighborWeightByCommunity.get(neighborCommunity) ?? 0) + weight,
        );
      }

      const baselineGain = gainFor(
        currentCommunity,
        neighborWeightByCommunity.get(currentCommunity) ?? 0,
        nodeDegree,
      );
      let bestCommunity = currentCommunity;
      let bestGain = baselineGain;
      const candidates = Array.from(neighborWeightByCommunity.keys()).sort(
        compareStrings,
      );
      for (const candidate of candidates) {
        if (candidate === currentCommunity) {
          continue;
        }
        const gain = gainFor(
          candidate,
          neighborWeightByCommunity.get(candidate) ?? 0,
          nodeDegree,
        );
        if (gain > bestGain) {
          bestGain = gain;
          bestCommunity = candidate;
        }
      }

      const destination =
        bestGain > baselineGain ? bestCommunity : currentCommunity;
      communityTotalDegree.set(
        destination,
        (communityTotalDegree.get(destination) ?? 0) + nodeDegree,
      );
      if (destination !== currentCommunity) {
        community.set(node, destination);
        movedThisPass = true;
      }
    }
    if (!movedThisPass) {
      break;
    }
  }

  const membersByCommunity = new Map<string, string[]>();
  for (const node of nodes) {
    const assigned = community.get(node) ?? node;
    const members = membersByCommunity.get(assigned);
    if (members) {
      members.push(node);
    } else {
      membersByCommunity.set(assigned, [node]);
    }
  }
  const representativeByNode = new Map<string, string>();
  for (const members of Array.from(membersByCommunity.values())) {
    const representative = [...members].sort(compareStrings)[0] ?? members[0];
    for (const member of members) {
      representativeByNode.set(member, representative);
    }
  }
  return representativeByNode;
}

// Remaps every edge (including pre-existing self-loops) through a
// current-node -> new-representative mapping. Two distinct members of the
// same new community produce a new self-loop (their formerly-internal edge
// weight becomes the aggregate node's loop weight); a pre-existing self-loop
// simply carries forward since its endpoints map to the same representative
// either way. This is the one rule that correctly handles BOTH cases with no
// special-casing (see `buildGraphView`'s doubled-self-loop degree comment).
function aggregateEdges(
  edges: ReadonlyMap<string, number>,
  representativeByNode: ReadonlyMap<string, string>,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const [key, weight] of Array.from(edges)) {
    const [a, b] = unpackPair(key);
    const repA = representativeByNode.get(a) ?? a;
    const repB = representativeByNode.get(b) ?? b;
    const newKey = pairKey(repA, repB);
    next.set(newKey, (next.get(newKey) ?? 0) + weight);
  }
  return next;
}

// Runs the full multi-level Louvain algorithm and returns each ORIGINAL
// symbol id mapped to its final community's representative id (the smallest
// original symbol id in that community -- a byproduct of always re-keying by
// smallest member id at every level, see `runLocalMovingStage`). Stops as
// soon as one level's local-moving stage makes no move at all (an "identity"
// partition), which also correctly terminates immediately for a graph with
// no edges at all (every node stays its own singleton).
function runLouvain(
  symbolIds: readonly string[],
  levelZeroEdges: ReadonlyMap<string, number>,
  resolution: number,
): Map<string, string> {
  let currentNodes = [...symbolIds].sort(compareStrings);
  let currentEdges = levelZeroEdges;

  const finalAssignment = new Map<string, string>();
  for (const id of currentNodes) {
    finalAssignment.set(id, id);
  }

  // Each successful (non-identity) level strictly reduces the distinct node
  // count, so this is a safe hard upper bound on the number of levels.
  const maxLevels = currentNodes.length + 1;
  for (let level = 0; level < maxLevels; level++) {
    const representativeByNode = runLocalMovingStage(
      currentNodes,
      currentEdges,
      resolution,
    );
    const isIdentity = currentNodes.every(
      (node) => representativeByNode.get(node) === node,
    );
    if (isIdentity) {
      break;
    }

    for (const [originalId, currentRepresentative] of Array.from(
      finalAssignment,
    )) {
      finalAssignment.set(
        originalId,
        representativeByNode.get(currentRepresentative) ??
          currentRepresentative,
      );
    }

    const nextNodes = Array.from(
      new Set(
        currentNodes.map((node) => representativeByNode.get(node) ?? node),
      ),
    ).sort(compareStrings);
    currentEdges = aggregateEdges(currentEdges, representativeByNode);
    currentNodes = nextNodes;
    if (currentNodes.length <= 1) {
      break;
    }
  }

  return finalAssignment;
}

// Single O(edges) pass: for every level-0 edge, both endpoints in the same
// final community add to that community's internal weight; a cross-boundary
// edge adds to BOTH communities' external weight. Cohesion is
// internal/(internal+external); a community with neither (a fully isolated
// singleton) defines cohesion as 0 -- an honest "no connectivity to measure"
// rather than a misleading 1.0 or NaN.
function computeCohesion(
  levelZeroEdges: ReadonlyMap<string, number>,
  representativeBySymbol: ReadonlyMap<string, string>,
): Map<string, number> {
  const internal = new Map<string, number>();
  const external = new Map<string, number>();
  for (const [key, weight] of Array.from(levelZeroEdges)) {
    const [a, b] = unpackPair(key);
    const repA = representativeBySymbol.get(a) ?? a;
    const repB = representativeBySymbol.get(b) ?? b;
    if (repA === repB) {
      internal.set(repA, (internal.get(repA) ?? 0) + weight);
    } else {
      external.set(repA, (external.get(repA) ?? 0) + weight);
      external.set(repB, (external.get(repB) ?? 0) + weight);
    }
  }

  const cohesion = new Map<string, number>();
  for (const representative of Array.from(
    new Set(representativeBySymbol.values()),
  )) {
    const internalWeight = internal.get(representative) ?? 0;
    const externalWeight = external.get(representative) ?? 0;
    const total = internalWeight + externalWeight;
    cohesion.set(representative, total === 0 ? 0 : internalWeight / total);
  }
  return cohesion;
}

// Top-2-path-segment directory prefix, e.g. 'packages/desktop-shared' from
// 'packages/desktop-shared/src/foo.ts'. A path with fewer than 2 segments
// (e.g. a root-level file) uses its full (single-segment) path as-is.
function topTwoSegmentPrefix(relativePath: string): string {
  return relativePath.split('/').slice(0, 2).join('/');
}

// Label = most common top-2-segment directory prefix among member file
// paths, counted once per member SYMBOL (not deduped by file), so a
// directory hosting many of the community's symbols dominates the label. A
// member whose file cannot be resolved (missing fileId/path lookup) is
// skipped rather than guessed at. Ties broken lexicographically by iterating
// candidate prefixes in sorted order and only updating on a strictly higher
// count, so the first (smallest) prefix wins any tie.
function computeLabel(
  members: readonly string[],
  symbolFileId: ReadonlyMap<string, string>,
  fileRelativePathById: ReadonlyMap<string, string>,
): string {
  const counts = new Map<string, number>();
  for (const symbolId of members) {
    const fileId = symbolFileId.get(symbolId);
    if (fileId === undefined) {
      continue;
    }
    const relativePath = fileRelativePathById.get(fileId);
    if (relativePath === undefined) {
      continue;
    }
    const prefix = topTwoSegmentPrefix(relativePath);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }

  let bestPrefix = '';
  let bestCount = -1;
  for (const prefix of Array.from(counts.keys()).sort(compareStrings)) {
    const count = counts.get(prefix) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      bestPrefix = prefix;
    }
  }
  return bestPrefix;
}

// communityId -> its member symbol id set, from the previous run's
// memberships -- the input to Jaccard overlap scoring below.
function groupPreviousMembers(
  previousMemberships: readonly CodeGraphCommunityMembershipRecord[],
): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  for (const membership of previousMemberships) {
    const set = sets.get(membership.communityId);
    if (set) {
      set.add(membership.symbolId);
    } else {
      sets.set(membership.communityId, new Set([membership.symbolId]));
    }
  }
  return sets;
}

// Greedy stable-id remap: processes new communities largest-first (ties
// broken by smallest representative id), and for each one claims the
// not-yet-claimed previous community with the highest Jaccard overlap that
// clears `STABLE_ID_MIN_JACCARD`. A community that claims nothing mints a
// fresh `com_` + sha256(sorted member ids) id instead.
function assignCommunityIds(
  membersByRepresentative: ReadonlyMap<string, readonly string[]>,
  previousMemberships: readonly CodeGraphCommunityMembershipRecord[],
): Map<string, string> {
  const previousMemberSets = groupPreviousMembers(previousMemberships);
  const previousCommunityBySymbol = new Map<string, string>();
  for (const membership of previousMemberships) {
    if (!previousCommunityBySymbol.has(membership.symbolId)) {
      previousCommunityBySymbol.set(
        membership.symbolId,
        membership.communityId,
      );
    }
  }

  const orderedRepresentatives = Array.from(
    membersByRepresentative.keys(),
  ).sort((repA, repB) => {
    const sizeA = membersByRepresentative.get(repA)?.length ?? 0;
    const sizeB = membersByRepresentative.get(repB)?.length ?? 0;
    if (sizeA !== sizeB) {
      return sizeB - sizeA;
    }
    return compareStrings(repA, repB);
  });

  const claimed = new Set<string>();
  const idByRepresentative = new Map<string, string>();
  for (const representative of orderedRepresentatives) {
    const members = membersByRepresentative.get(representative) ?? [];
    const overlapCounts = new Map<string, number>();
    for (const symbolId of members) {
      const previousCommunityId = previousCommunityBySymbol.get(symbolId);
      if (previousCommunityId === undefined) {
        continue;
      }
      overlapCounts.set(
        previousCommunityId,
        (overlapCounts.get(previousCommunityId) ?? 0) + 1,
      );
    }

    let bestPreviousId: string | null = null;
    let bestJaccard = -1;
    for (const previousId of Array.from(overlapCounts.keys()).sort(
      compareStrings,
    )) {
      if (claimed.has(previousId)) {
        continue;
      }
      const overlap = overlapCounts.get(previousId) ?? 0;
      const previousSize = previousMemberSets.get(previousId)?.size ?? 0;
      const union = members.length + previousSize - overlap;
      const jaccard = union === 0 ? 0 : overlap / union;
      if (jaccard >= STABLE_ID_MIN_JACCARD && jaccard > bestJaccard) {
        bestJaccard = jaccard;
        bestPreviousId = previousId;
      }
    }

    if (bestPreviousId !== null) {
      claimed.add(bestPreviousId);
      idByRepresentative.set(representative, bestPreviousId);
    } else {
      idByRepresentative.set(
        representative,
        communityRowId(communityFingerprint(members)),
      );
    }
  }
  return idByRepresentative;
}

export function detectCommunities(
  input: CommunityDetectionInput,
): CommunityDetectionResult {
  const symbolCount = input.symbols.length;
  const coarse = symbolCount > CODE_GRAPH_COMMUNITY_MAX_SYMBOLS;
  // Project a large symbol graph onto files. Every original symbol is retained
  // in the expanded memberships; this is explicitly a coarse partition.
  const fileIds = new Set(input.symbols.map((symbol) => symbol.fileId));
  if (
    symbolCount > 1_000_000 ||
    input.edges.length > 5_000_000 ||
    (coarse &&
      (fileIds.size > CODE_GRAPH_COMMUNITY_MAX_SYMBOLS ||
        Array.from(fileIds).some((id) => !input.fileRelativePathById.has(id))))
  ) {
    return {
      skipped: true,
      symbolCount,
      communities: [],
      memberships: [],
      skipReason:
        symbolCount > 1_000_000
          ? '1,000,000-symbol work budget exceeded'
          : input.edges.length > 5_000_000
            ? '5,000,000-edge work budget exceeded'
            : fileIds.size > CODE_GRAPH_COMMUNITY_MAX_SYMBOLS
              ? '50,000-file projection budget exceeded'
              : 'file projection unavailable: missing file paths',
    };
  }
  if (symbolCount === 0) {
    return { skipped: false, symbolCount, communities: [], memberships: [] };
  }

  const symbolIds = input.symbols
    .map((symbol) => symbol.id)
    .sort(compareStrings);
  const knownSymbolIds = new Set(symbolIds);
  const symbolFileId = new Map(
    input.symbols.map((symbol) => [symbol.id, symbol.fileId]),
  );

  const levelZeroEdges = buildLevelZeroEdges(input.edges, knownSymbolIds);
  // n=symbolCount clamped to a floor of 10 before log10, so a small repo
  // never divides by a sub-1 log and never runs at resolution above 1.
  const resolution = Math.max(0.05, 1 / Math.log10(Math.max(symbolCount, 10)));
  let representativeBySymbol: Map<string, string>;
  if (coarse) {
    const projectedEdges = new Map<string, number>();
    for (const [key, weight] of Array.from(levelZeroEdges)) {
      const [source, target] = unpackPair(key);
      const sourceFile = symbolFileId.get(source);
      const targetFile = symbolFileId.get(target);
      if (sourceFile === undefined || targetFile === undefined) continue;
      const projectedKey = pairKey(sourceFile, targetFile);
      projectedEdges.set(
        projectedKey,
        (projectedEdges.get(projectedKey) ?? 0) + weight,
      );
    }
    const fileRepresentatives = runLouvain(
      Array.from(fileIds).sort(compareStrings),
      projectedEdges,
      Math.max(0.05, 1 / Math.log10(Math.max(fileIds.size, 10))),
    );
    representativeBySymbol = new Map(
      symbolIds.map((id) => {
        const fileId = symbolFileId.get(id) ?? id;
        return [id, fileRepresentatives.get(fileId) ?? fileId];
      }),
    );
  } else {
    representativeBySymbol = runLouvain(symbolIds, levelZeroEdges, resolution);
  }

  const membersByRepresentative = new Map<string, string[]>();
  for (const symbolId of symbolIds) {
    const representative = representativeBySymbol.get(symbolId) ?? symbolId;
    const members = membersByRepresentative.get(representative);
    if (members) {
      members.push(symbolId);
    } else {
      membersByRepresentative.set(representative, [symbolId]);
    }
  }

  const cohesionByRepresentative = computeCohesion(
    levelZeroEdges,
    representativeBySymbol,
  );
  const idByRepresentative = assignCommunityIds(
    membersByRepresentative,
    input.previousMemberships ?? [],
  );

  const communities: CodeGraphCommunityRecord[] = [];
  const memberships: CodeGraphCommunityMembershipRecord[] = [];
  for (const [representative, members] of Array.from(membersByRepresentative)) {
    const fingerprint = communityFingerprint(members);
    const communityId =
      idByRepresentative.get(representative) ?? communityRowId(fingerprint);
    const label = computeLabel(
      members,
      symbolFileId,
      input.fileRelativePathById,
    );
    communities.push({
      id: communityId,
      repositoryId: input.repoId,
      label,
      cohesion: cohesionByRepresentative.get(representative) ?? 0,
      size: members.length,
      fingerprint,
      extra: coarse
        ? {
            resolution: 'file',
            projectedNodeCount: fileIds.size,
            omittedSymbols: 0,
          }
        : {},
    });
    for (const symbolId of members) {
      memberships.push({ communityId, symbolId });
    }
  }

  communities.sort((a, b) =>
    b.size !== a.size ? b.size - a.size : compareStrings(a.id, b.id),
  );
  memberships.sort(
    (a, b) =>
      compareStrings(a.communityId, b.communityId) ||
      compareStrings(a.symbolId, b.symbolId),
  );

  return { skipped: false, symbolCount, communities, memberships };
}
