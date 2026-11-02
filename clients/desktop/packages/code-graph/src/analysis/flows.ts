import { flowRowId } from '../ids';
import { CODE_GRAPH_SECURITY_KEYWORD_PATTERN } from './security-keywords';
import type {
  CodeGraphEdgeRecord,
  CodeGraphFlowMembershipRecord,
  CodeGraphFlowRecord,
  CodeGraphSymbolRecord,
} from '../types/code-graph';

// --- Deterministic forward flow tracing with criticality --------------------
//
// Pure module: takes symbol/edge arrays and returns entry points plus traced
// flows. No database access, no store imports -- callers (a later Phase 6
// task's engine wiring) own persistence via `CodeGraphStore.replaceDerivedForRepo`.
// Sibling of `analysis/communities.ts`; see that module's header for the
// shared determinism discipline this mirrors: no `Math.random`, no
// `Date.now`, no wall-clock/iteration-order dependence -- every tie is broken
// by ascending id, and Map/Set iteration is always materialized via
// `Array.from(...)` before being sorted rather than trusted as-is.

// --- Entry points ------------------------------------------------------------
//
// Three explicit, Canopy-relevant classes (no framework-decorator regex
// zoo): (a) call-graph roots -- function/method symbols with >=1 outgoing
// CALLS and 0 incoming CALLS; (b) the SOURCE of an IPC_HANDLES edge (an IPC
// handler); (c) function/method symbols whose name is an exact,
// case-sensitive match against a small conventional-entry-point name list.
// A symbol qualifying for more than one class is deduped into its single
// highest-priority class -- ipc-handler, then call-graph-root, then
// conventional-name -- and the final list orders ipc-handler entries first,
// then roots, then names, id-ascending within each class, capped at
// `CODE_GRAPH_FLOW_ENTRY_POINT_MAX`.
//
// Classes (a) and (c) both restrict to CALLABLE kinds (function/method,
// `ENTRY_CALLABLE_KINDS`): a flow's entry point is somewhere execution can
// start, so a `variable`/`config`/etc. symbol that merely happens to be
// named `run` or `handler` must not seed a flow -- see `flows.test.ts`'s
// "does not treat a non-callable symbol named 'run' as an entry point" case.

export type CodeGraphFlowEntryPointEvidence =
  | 'ipc-handler'
  | 'call-graph-root'
  | 'conventional-name';

export interface CodeGraphFlowEntryPoint {
  symbolId: string;
  evidence: CodeGraphFlowEntryPointEvidence;
}

export const CODE_GRAPH_FLOW_ENTRY_POINT_MAX = 500;

const CODE_GRAPH_FLOW_CONVENTIONAL_NAMES = new Set<string>([
  'main',
  'activate',
  'run',
  'handler',
  'execute',
]);

// Shared by entry-point classes (a) and (c) -- see the module comment above.
const ENTRY_CALLABLE_KINDS = new Set<string>(['function', 'method']);

function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function toEntryPoints(
  symbolIds: readonly string[],
  evidence: CodeGraphFlowEntryPointEvidence,
): CodeGraphFlowEntryPoint[] {
  return [...symbolIds]
    .sort(compareStrings)
    .map((symbolId): CodeGraphFlowEntryPoint => ({ symbolId, evidence }));
}

export function detectFlowEntryPoints(
  symbols: readonly CodeGraphSymbolRecord[],
  edges: readonly CodeGraphEdgeRecord[],
): CodeGraphFlowEntryPoint[] {
  const outgoingCallCount = new Map<string, number>();
  const incomingCallCount = new Map<string, number>();
  const ipcHandlerSourceIds = new Set<string>();

  for (const edge of edges) {
    if (edge.kind === 'CALLS') {
      if (edge.sourceSymbolId !== null) {
        outgoingCallCount.set(
          edge.sourceSymbolId,
          (outgoingCallCount.get(edge.sourceSymbolId) ?? 0) + 1,
        );
      }
      if (edge.targetSymbolId !== null) {
        incomingCallCount.set(
          edge.targetSymbolId,
          (incomingCallCount.get(edge.targetSymbolId) ?? 0) + 1,
        );
      }
    } else if (edge.kind === 'IPC_HANDLES' && edge.sourceSymbolId !== null) {
      ipcHandlerSourceIds.add(edge.sourceSymbolId);
    }
  }

  const claimed = new Set<string>();
  const ipcHandlerIds: string[] = [];
  const rootIds: string[] = [];
  const nameIds: string[] = [];

  // Three passes over `symbols`, highest-priority class first, so `claimed`
  // naturally keeps each symbol in only its highest-priority class.
  for (const symbol of symbols) {
    if (ipcHandlerSourceIds.has(symbol.id)) {
      ipcHandlerIds.push(symbol.id);
      claimed.add(symbol.id);
    }
  }
  for (const symbol of symbols) {
    if (claimed.has(symbol.id)) {
      continue;
    }
    if (
      ENTRY_CALLABLE_KINDS.has(symbol.kind) &&
      (outgoingCallCount.get(symbol.id) ?? 0) >= 1 &&
      (incomingCallCount.get(symbol.id) ?? 0) === 0
    ) {
      rootIds.push(symbol.id);
      claimed.add(symbol.id);
    }
  }
  for (const symbol of symbols) {
    if (claimed.has(symbol.id)) {
      continue;
    }
    if (
      ENTRY_CALLABLE_KINDS.has(symbol.kind) &&
      CODE_GRAPH_FLOW_CONVENTIONAL_NAMES.has(symbol.name)
    ) {
      nameIds.push(symbol.id);
      claimed.add(symbol.id);
    }
  }

  const ordered = [
    ...toEntryPoints(ipcHandlerIds, 'ipc-handler'),
    ...toEntryPoints(rootIds, 'call-graph-root'),
    ...toEntryPoints(nameIds, 'conventional-name'),
  ];
  return ordered.slice(0, CODE_GRAPH_FLOW_ENTRY_POINT_MAX);
}

// --- Forward BFS over resolved CALLS edges -----------------------------------

export const CODE_GRAPH_FLOW_MAX_DEPTH = 15;
export const CODE_GRAPH_FLOW_MAX_MEMBERS = 2000;
export const CODE_GRAPH_FLOW_GLOBAL_MEMBERSHIP_CAP = 200_000;

// Resolved-CALLS-only forward adjacency (source and target both non-null).
// Parallel edges to the same target are deduped -- BFS only cares about
// reachability, never multiplicity -- and each node's neighbor list is
// sorted once up front so expansion order is deterministic without
// re-sorting on every BFS step.
function buildForwardAdjacency(
  edges: readonly CodeGraphEdgeRecord[],
): Map<string, string[]> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (
      edge.kind !== 'CALLS' ||
      edge.sourceSymbolId === null ||
      edge.targetSymbolId === null
    ) {
      continue;
    }
    const targets = adjacency.get(edge.sourceSymbolId);
    if (targets) {
      targets.add(edge.targetSymbolId);
    } else {
      adjacency.set(edge.sourceSymbolId, new Set([edge.targetSymbolId]));
    }
  }
  const sorted = new Map<string, string[]>();
  for (const [source, targets] of Array.from(adjacency)) {
    sorted.set(source, Array.from(targets).sort(compareStrings));
  }
  return sorted;
}

interface FlowTraceResult {
  depthBySymbolId: Map<string, number>;
  truncated: boolean;
  maxDepth: number;
}

// BFS from a single entry point, recording the depth each member is FIRST
// reached at and never revisiting a member once assigned. Two independent
// honesty caps can each cut the trace short, and either sets `truncated`:
//  - the per-flow member cap (`CODE_GRAPH_FLOW_MAX_MEMBERS`): stops adding
//    new members the instant the running count would exceed the cap, so the
//    already-discovered members stay exactly as first-reached.
//  - the depth cap (`CODE_GRAPH_FLOW_MAX_DEPTH`): BFS never assigns a depth
//    beyond this, but if the final (deepest) frontier still has an unvisited
//    neighbor, that reachable-but-uncounted node is exactly as "truncated"
//    as one dropped by the member cap, so it gets the same honest flag.
function traceFlowFromEntry(
  entrySymbolId: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
): FlowTraceResult {
  const depthBySymbolId = new Map<string, number>([[entrySymbolId, 0]]);
  let truncated = false;
  let maxDepth = 0;
  let frontier = [entrySymbolId];

  for (let depth = 0; depth < CODE_GRAPH_FLOW_MAX_DEPTH; depth++) {
    if (frontier.length === 0) {
      break;
    }
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      const neighbors = adjacency.get(node) ?? [];
      for (const neighbor of neighbors) {
        if (depthBySymbolId.has(neighbor)) {
          continue;
        }
        if (depthBySymbolId.size >= CODE_GRAPH_FLOW_MAX_MEMBERS) {
          truncated = true;
          break;
        }
        depthBySymbolId.set(neighbor, depth + 1);
        maxDepth = depth + 1;
        nextFrontier.push(neighbor);
      }
      if (truncated) {
        break;
      }
    }
    if (truncated) {
      break;
    }
    frontier = nextFrontier.sort(compareStrings);
  }

  if (!truncated && frontier.length > 0) {
    const hasMoreBeyondDepthCap = frontier.some((node) =>
      (adjacency.get(node) ?? []).some(
        (neighbor) => !depthBySymbolId.has(neighbor),
      ),
    );
    if (hasMoreBeyondDepthCap) {
      truncated = true;
    }
  }

  return { depthBySymbolId, truncated, maxDepth };
}

// --- Criticality --------------------------------------------------------------
//
// Five weighted components, each a ratio in [0, 1], with weights summing to
// exactly 1.000 -- so the aggregate is bounded to [0, 1] BY CONSTRUCTION, no
// extra `min(1, ...)` clamp needed (contrast change-impact.ts's risk score,
// whose components only cap at 0.60/symbol and so DOES need an explicit
// cap). Each component is rounded to 3 decimal places (round(x*1000)/1000,
// the same `RISK_REASON_ROUND_PLACES` convention change-impact.ts uses)
// BEFORE being weighted and summed, so the persisted breakdown and the
// number that produced the final `criticality` never disagree at the
// displayed precision.
const CRITICALITY_WEIGHT_FILE_SPREAD = 0.3;
const CRITICALITY_WEIGHT_EXTERNAL_CALL = 0.2;
const CRITICALITY_WEIGHT_SECURITY_KEYWORD = 0.25;
const CRITICALITY_WEIGHT_TEST_GAP = 0.15;
const CRITICALITY_WEIGHT_DEPTH = 0.1;

const CRITICALITY_ROUND_PLACES = 1000;

// The test-gap component only counts function/method members, per the plan
// ("function/method only") -- deliberately NARROWER than change-impact.ts's
// risk-coverage kind gate `RISK_UNTESTED_KINDS` ({function, method, class}):
// a class in a flow is not a meaningfully "test-gapped" unit the way a
// function/method body is. (change-impact.ts's own `findTestGaps` applies
// the same function/method narrowing via its local `TEST_GAP_KINDS`.)
const TEST_GAP_KINDS = new Set<string>(['function', 'method']);

function roundCriticality(value: number): number {
  return (
    Math.round(value * CRITICALITY_ROUND_PLACES) / CRITICALITY_ROUND_PLACES
  );
}

export interface CodeGraphFlowCriticalityComponents {
  fileSpreadRatio: number;
  externalCallRatio: number;
  securityKeywordFraction: number;
  testGapFraction: number;
  depthRatio: number;
}

// Per-source-symbol outgoing CALLS counts, split into total vs. unresolved
// (null target). Built once per `traceFlows` call and reused across every
// flow's criticality computation.
function buildOutgoingCallCounts(
  edges: readonly CodeGraphEdgeRecord[],
): Map<string, { total: number; unresolved: number }> {
  const counts = new Map<string, { total: number; unresolved: number }>();
  for (const edge of edges) {
    if (edge.kind !== 'CALLS' || edge.sourceSymbolId === null) {
      continue;
    }
    const current = counts.get(edge.sourceSymbolId) ?? {
      total: 0,
      unresolved: 0,
    };
    current.total += 1;
    if (edge.targetSymbolId === null) {
      current.unresolved += 1;
    }
    counts.set(edge.sourceSymbolId, current);
  }
  return counts;
}

// Symbol ids that are the SOURCE of a TESTED_BY edge -- i.e. symbols WITH
// test coverage. Verified against `resolve/test-linker.ts`: a TESTED_BY edge
// is minted with `sourceSymbolId` = the PRODUCTION symbol a test calls (the
// CALLS edge's target) and `targetSymbolId` = the test's file symbol, so
// "this symbol is tested" is "this symbol is a TESTED_BY source", matching
// change-impact.ts's `getTestsFor` query (`WHERE e.source_symbol_id = ?`).
function buildTestedSourceIds(
  edges: readonly CodeGraphEdgeRecord[],
): Set<string> {
  const ids = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === 'TESTED_BY' && edge.sourceSymbolId !== null) {
      ids.add(edge.sourceSymbolId);
    }
  }
  return ids;
}

function computeCriticality(input: {
  memberIds: readonly string[];
  maxDepth: number;
  symbolsById: ReadonlyMap<string, CodeGraphSymbolRecord>;
  outgoingCallCounts: ReadonlyMap<
    string,
    { total: number; unresolved: number }
  >;
  testedSourceIds: ReadonlySet<string>;
}): {
  criticality: number;
  distinctFileCount: number;
  components: CodeGraphFlowCriticalityComponents;
} {
  const memberCount = input.memberIds.length;

  const distinctFiles = new Set<string>();
  let securityKeywordCount = 0;
  let functionMethodCount = 0;
  let untestedFunctionMethodCount = 0;

  for (const symbolId of input.memberIds) {
    const symbol = input.symbolsById.get(symbolId);
    if (symbol === undefined) {
      continue;
    }
    distinctFiles.add(symbol.fileId);
    if (CODE_GRAPH_SECURITY_KEYWORD_PATTERN.test(symbol.qualifiedName)) {
      securityKeywordCount += 1;
    }
    if (TEST_GAP_KINDS.has(symbol.kind)) {
      functionMethodCount += 1;
      if (!input.testedSourceIds.has(symbolId)) {
        untestedFunctionMethodCount += 1;
      }
    }
  }

  let totalOutgoing = 0;
  let unresolvedOutgoing = 0;
  for (const symbolId of input.memberIds) {
    const counts = input.outgoingCallCounts.get(symbolId);
    if (counts !== undefined) {
      totalOutgoing += counts.total;
      unresolvedOutgoing += counts.unresolved;
    }
  }

  const fileSpreadRatio =
    memberCount === 0 ? 0 : roundCriticality(distinctFiles.size / memberCount);
  const externalCallRatio =
    totalOutgoing === 0
      ? 0
      : roundCriticality(unresolvedOutgoing / totalOutgoing);
  const securityKeywordFraction =
    memberCount === 0
      ? 0
      : roundCriticality(securityKeywordCount / memberCount);
  const testGapFraction =
    functionMethodCount === 0
      ? 0
      : roundCriticality(untestedFunctionMethodCount / functionMethodCount);
  const depthRatio = roundCriticality(
    input.maxDepth / CODE_GRAPH_FLOW_MAX_DEPTH,
  );

  const components: CodeGraphFlowCriticalityComponents = {
    fileSpreadRatio,
    externalCallRatio,
    securityKeywordFraction,
    testGapFraction,
    depthRatio,
  };

  const criticality = roundCriticality(
    fileSpreadRatio * CRITICALITY_WEIGHT_FILE_SPREAD +
      externalCallRatio * CRITICALITY_WEIGHT_EXTERNAL_CALL +
      securityKeywordFraction * CRITICALITY_WEIGHT_SECURITY_KEYWORD +
      testGapFraction * CRITICALITY_WEIGHT_TEST_GAP +
      depthRatio * CRITICALITY_WEIGHT_DEPTH,
  );

  return { criticality, distinctFileCount: distinctFiles.size, components };
}

// --- Top-level orchestration --------------------------------------------------

export interface FlowTracingInput {
  repoId: string;
  symbols: readonly CodeGraphSymbolRecord[];
  edges: readonly CodeGraphEdgeRecord[];
  // Overridable only for tests -- mirrors `computeChangeImpactRadius`'s own
  // overridable `maxDepth`/`maxNodes` precedent in impact/change-impact.ts,
  // so the global cap's honest-drop behavior can be exercised with a small
  // fixture instead of constructing 200k real membership rows.
  globalMembershipCap?: number;
}

export interface FlowTracingResult {
  entryPointCount: number;
  flows: CodeGraphFlowRecord[];
  memberships: CodeGraphFlowMembershipRecord[];
  // True once the global membership-row cap stopped tracing FURTHER flows --
  // the flow that would have breached the cap is dropped WHOLE (never
  // partially included), and no flow after it is even attempted. Mirrors
  // `communities.ts`'s `skipped` honest-warning-marker style.
  globalCapReached: boolean;
}

export function traceFlows(input: FlowTracingInput): FlowTracingResult {
  const globalMembershipCap =
    input.globalMembershipCap ?? CODE_GRAPH_FLOW_GLOBAL_MEMBERSHIP_CAP;
  const symbolsById = new Map(
    input.symbols.map((symbol): [string, CodeGraphSymbolRecord] => [
      symbol.id,
      symbol,
    ]),
  );
  const entryPoints = detectFlowEntryPoints(input.symbols, input.edges);
  const adjacency = buildForwardAdjacency(input.edges);
  const outgoingCallCounts = buildOutgoingCallCounts(input.edges);
  const testedSourceIds = buildTestedSourceIds(input.edges);

  const flows: CodeGraphFlowRecord[] = [];
  const memberships: CodeGraphFlowMembershipRecord[] = [];
  let totalMembershipRows = 0;
  let globalCapReached = false;

  for (const entryPoint of entryPoints) {
    const entrySymbol = symbolsById.get(entryPoint.symbolId);
    if (entrySymbol === undefined) {
      continue;
    }

    const { depthBySymbolId, truncated, maxDepth } = traceFlowFromEntry(
      entryPoint.symbolId,
      adjacency,
    );
    const memberIds = Array.from(depthBySymbolId.keys()).sort(compareStrings);

    if (totalMembershipRows + memberIds.length > globalMembershipCap) {
      globalCapReached = true;
      break;
    }

    const { criticality, distinctFileCount, components } = computeCriticality({
      memberIds,
      maxDepth,
      symbolsById,
      outgoingCallCounts,
      testedSourceIds,
    });

    const flowId = flowRowId(input.repoId, entryPoint.symbolId);
    flows.push({
      id: flowId,
      repositoryId: input.repoId,
      entrySymbolId: entryPoint.symbolId,
      name: entrySymbol.qualifiedName,
      criticality,
      symbolCount: memberIds.length,
      fileSpread: distinctFileCount,
      maxDepth,
      extra: {
        entryPointEvidence: entryPoint.evidence,
        truncated,
        criticalityComponents: components,
      },
    });
    for (const symbolId of memberIds) {
      memberships.push({
        flowId,
        symbolId,
        depth: depthBySymbolId.get(symbolId) ?? 0,
      });
    }
    totalMembershipRows += memberIds.length;
  }

  flows.sort((a, b) => compareStrings(a.id, b.id));
  memberships.sort(
    (a, b) =>
      compareStrings(a.flowId, b.flowId) ||
      compareStrings(a.symbolId, b.symbolId),
  );

  return {
    entryPointCount: entryPoints.length,
    flows,
    memberships,
    globalCapReached,
  };
}
