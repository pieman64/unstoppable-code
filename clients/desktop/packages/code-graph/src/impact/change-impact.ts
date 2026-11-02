import {
  CODE_GRAPH_IMPACT_DEFAULT_DEPTH,
  CODE_GRAPH_IMPACT_MAX_NODES,
  codeGraphDerivedState,
  type CodeGraphRiskAssessment,
} from '../types/code-graph-tools';
import type { CodeGraphStore } from '../store/graph-store';
import type { CodeGraphQueryService } from '../query/queries';
import { getDiffRanges } from '../git/diff';
import { CODE_GRAPH_SECURITY_KEYWORD_PATTERN } from '../analysis/security-keywords';
import { mapRangesToSymbols, type ChangedSymbol } from './changed-symbols';
import {
  buildBeforeGraphForChanges,
  type BeforeGraphResult,
} from './before-graph';

// --- Test-coverage lookup cache --------------------------------------------

// A single `assembleChangeImpact` call queries the same changed symbol's
// tests up to 3× — the risk coverage component, `computeImpactedTests`, and
// `findTestGaps` each ask independently. node:sqlite is synchronous (zero
// await points), so those redundant TESTED_BY lookups all run back-to-back on
// the caller's thread. This memoizes `queries.getTestsFor` per qualifiedName
// for the life of one assembly, so each symbol's tests are fetched at most
// once and reused across all three stages.
export interface TestsForCache {
  get(qualifiedName: string): string[];
}

export function createTestsForCache(
  queries: CodeGraphQueryService,
  repoId: string,
): TestsForCache {
  const cache = new Map<string, string[]>();
  return {
    get(qualifiedName: string): string[] {
      const cached = cache.get(qualifiedName);
      if (cached !== undefined) {
        return cached;
      }
      const tests = queries.getTestsFor(qualifiedName, repoId);
      cache.set(qualifiedName, tests);
      return tests;
    },
  };
}

// --- Delta -------------------------------------------------------------

export interface SymbolDelta {
  added: ChangedSymbol[];
  removed: Array<{ qualifiedName: string; kind: string; filePath: string }>;
  signatureChanged: Array<{
    qualifiedName: string;
    before: string | null;
    after: string | null;
  }>;
}

// Pure structural comparison, keyed by qualifiedName — there is no attempt
// to infer a rename from a deleted+added pair with a similar body/signature.
// A renamed symbol therefore always shows up as BOTH a `removed` entry (the
// old qualifiedName, from the before-graph) and an `added` entry (the new
// qualifiedName, from the current graph), never linked to each other. This
// matches the contract ("No rename inference") and keeps the delta a plain
// set comparison instead of a heuristic-driven match.
export function computeSymbolDelta(input: {
  changed: readonly ChangedSymbol[];
  before: BeforeGraphResult;
  store: CodeGraphStore;
  repoId: string;
}): SymbolDelta {
  const added: ChangedSymbol[] = [];
  const signatureChanged: SymbolDelta['signatureChanged'] = [];

  for (const symbol of input.changed) {
    const beforeSymbol = input.before.symbols.get(symbol.qualifiedName);
    if (beforeSymbol === undefined) {
      // No before-graph entry for this qualifiedName: either the symbol is
      // genuinely new, or it lives in a file the before-graph never had
      // base-ref content for (best-effort — see before-graph.ts). Either
      // way, there is nothing to diff a signature against.
      added.push(symbol);
      continue;
    }
    // `ChangedSymbol` does not carry a signature (see changed-symbols.ts),
    // so the CURRENT signature has to come from the live store.
    const currentRecord = input.store.getSymbolByQualifiedName(
      symbol.qualifiedName,
      input.repoId,
    );
    const afterSignature =
      currentRecord === null ? null : currentRecord.signature;
    if (beforeSymbol.signature !== afterSignature) {
      signatureChanged.push({
        qualifiedName: symbol.qualifiedName,
        before: beforeSymbol.signature,
        after: afterSignature,
      });
    }
  }

  const removed: SymbolDelta['removed'] = [];
  // Walk every before-graph entry (not just `changed`) — a removed symbol's
  // whole FILE is gone from the current graph, so it was never a candidate
  // for `mapRangesToSymbols`'s current-graph lookup and never appears in
  // `changed`. The before-graph is already scoped to just the diff's
  // touched files (see before-graph.ts), so this walk stays bounded.
  for (const [qualifiedName, beforeSymbol] of Array.from(
    input.before.symbols.entries(),
  )) {
    const currentRecord = input.store.getSymbolByQualifiedName(
      qualifiedName,
      input.repoId,
    );
    if (currentRecord === null) {
      removed.push({
        qualifiedName,
        kind: beforeSymbol.kind,
        filePath: beforeSymbol.filePath,
      });
    }
  }

  return { added, removed, signatureChanged };
}

// --- Risk ----------------------------------------------------------------

// Lifted into `types/code-graph-tools.ts` (Task 5) as `CodeGraphRiskAssessment`
// so the browser-safe tool/CLI wire layer and this Node-only assembly module
// share one shape instead of two independently-maintained ones.
export type RiskAssessment = CodeGraphRiskAssessment;

// Per-symbol breakdown feeding BOTH `scoreChangeRisk`'s aggregate output and
// `assembleChangeImpact`'s review context (per-symbol `riskReasons` on
// changed symbols, and `reviewPriorities`) — computed once per assembly so
// the two consumers never disagree about a given symbol's score.
interface SymbolRiskBreakdown {
  qualifiedName: string;
  kind: string;
  filePath: string;
  score: number;
  reasons: string[];
}

const RISK_UNTESTED_KINDS = new Set<string>(['function', 'method', 'class']);
// The security-keyword pattern this formula shares with `analysis/flows.ts`
// lives in `analysis/security-keywords.ts` (a dependency-free leaf module)
// — see that module's comment for why it is hosted there rather than here.

const RISK_UNTESTED_WEIGHT = 0.3;
const RISK_TESTED_WEIGHT = 0.05;
const RISK_SECURITY_KEYWORD_WEIGHT = 0.2;
const RISK_FAN_IN_DIVISOR = 20;
const RISK_FAN_IN_CAP = 0.1;
// Flow-participation and community-crossing terms (Phase 6 Task 7): the two
// derived-analysis-backed additions that finally make the high/critical
// levels reachable (0.30 + 0.20 + 0.10 + 0.25 + 0.15 = 1.00 per symbol).
const RISK_FLOW_PARTICIPATION_CAP = 0.25;
const RISK_COMMUNITY_CROSSING_WEIGHT = 0.05;
const RISK_COMMUNITY_CROSSING_CAP = 0.15;
// "All flows containing this symbol" for an accurate `in N flows` count —
// the store's own hard technical ceiling (`boundedListLimit` in
// graph-store.ts), reused here rather than the much smaller default (10)
// `listFlowsForSymbol` otherwise applies, since summing a truncated subset
// would under-report both the reason's `N` and (unlikely but possible for a
// low-criticality-per-flow symbol) the capped score itself.
const RISK_FLOW_QUERY_LIMIT = 1000;
const RISK_SCORE_CAP = 1;
const RISK_REASON_ROUND_PLACES = 1000;

export const CHANGE_IMPACT_MAX_RISK_REASONS = 10;

const RISK_FORMULA =
  'score(symbol) = min(1, untested + securityKeyword + fanIn + ' +
  'flowParticipation + communityCrossing), where untested = +0.30 when a ' +
  'function/method/class has zero TESTED_BY edges else +0.05 when tested ' +
  '(Phase 4 simplification — binary, no gradient by test count yet), ' +
  'securityKeyword = +0.20 when the qualified name/path matches ' +
  '/auth|token|crypt|secret|password|sql|exec|permission|sandbox/i, ' +
  'fanIn (fan-in) = min(callerCount / 20, 0.10), flowParticipation = ' +
  'min(sum of criticality over every flow containing the symbol, 0.25), ' +
  'communityCrossing = min(0.05 * cross-community caller count, 0.15); ' +
  'overall score = max(score(symbol)) across every changed + removed ' +
  'symbol. Per-symbol ceiling: 0.30 + 0.20 + 0.10 + 0.25 + 0.15 = 1.00, so ' +
  'the high (>=0.70) and critical (>=0.85) levels are reachable.';

// Appended to `RISK_FORMULA` when neither communities nor flows have ever
// been computed for the scored repo (see `computeRiskBreakdowns`'s
// `derivedComputed` check) — flowParticipation/communityCrossing then
// contribute 0 for every symbol, and this note says why rather than silently
// looking like an untouched repo with a genuinely low-risk change.
const RISK_FORMULA_DERIVED_ABSENT_NOTE =
  'derived analyses not computed — flow/community terms inactive';

// Appended when the stored communities/flows were computed for an earlier
// build than the latest published one (derived analysis runs after a refresh
// is published; see `codeGraphDerivedState`). The two terms still score from
// that stored analysis -- this says so instead of presenting it as current.
const RISK_FORMULA_DERIVED_STALE_NOTE =
  'derived analyses stale — flow/community terms use the analysis of an earlier build until the current one completes';
const RISK_STALE_INPUTS: NonNullable<RiskAssessment['staleInputs']> = [
  'flowParticipation',
  'communityCrossing',
];

function roundScore(value: number): number {
  return (
    Math.round(value * RISK_REASON_ROUND_PLACES) / RISK_REASON_ROUND_PLACES
  );
}

function compareQualifiedName(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

// Coverage component only applies to function/method/class kinds, and is
// skipped entirely for a symbol that is ITSELF a test (nothing "tests the
// tests" — scoring a test helper as "untested" would misrepresent a
// test-only change as risky for no real reason). `store` is what supplies
// the isTest flag: `ChangedSymbol`/`SymbolDelta.removed` carry `kind` but
// not `isTest`.
function scoreCoverageComponent(
  symbol: { qualifiedName: string; kind: string },
  store: CodeGraphStore,
  testsFor: TestsForCache,
  repoId: string,
): { score: number; reason: string } | null {
  if (!RISK_UNTESTED_KINDS.has(symbol.kind)) {
    return null;
  }
  const record = store.getSymbolByQualifiedName(symbol.qualifiedName, repoId);
  if (record !== null && record.isTest) {
    return null;
  }
  const testCount = testsFor.get(symbol.qualifiedName).length;
  if (testCount === 0) {
    return { score: RISK_UNTESTED_WEIGHT, reason: 'untested (+0.30)' };
  }
  return {
    score: RISK_TESTED_WEIGHT,
    reason: `tested by ${testCount} test file(s) (+0.05)`,
  };
}

function scoreSecurityKeywordComponent(symbol: {
  qualifiedName: string;
}): { score: number; reason: string } | null {
  if (!CODE_GRAPH_SECURITY_KEYWORD_PATTERN.test(symbol.qualifiedName)) {
    return null;
  }
  return {
    score: RISK_SECURITY_KEYWORD_WEIGHT,
    reason: 'security-sensitive name/path (+0.20)',
  };
}

function scoreFanInComponent(
  symbol: { qualifiedName: string },
  queries: CodeGraphQueryService,
  repoId: string,
): { score: number; reason: string } | null {
  const callerCount = queries.getCallers(symbol.qualifiedName, repoId).length;
  const score = Math.min(callerCount / RISK_FAN_IN_DIVISOR, RISK_FAN_IN_CAP);
  if (score <= 0) {
    return null;
  }
  return {
    score,
    reason: `fan-in: ${callerCount} caller(s) (+${score.toFixed(2)})`,
  };
}

// Flow-participation and community-crossing both read the CURRENT graph's
// derived tables ONLY (communities/flows/*_memberships) via
// `queries.listFlowsForSymbol`/`countCrossCommunityCallers` — a before-graph
// never has derived data computed against it (Task 6's scoped before-graph
// build skips the derived phase entirely), so there is nothing else these
// two terms could read even for a `changed` symbol whose before-graph
// counterpart exists.

// Sum of criticality across every flow containing the symbol, capped at
// RISK_FLOW_PARTICIPATION_CAP. A symbol threaded through many
// high-criticality flows (e.g. an IPC-handler-rooted flow) is more
// consequential to change than one with equal fan-in/coverage but no flow
// membership at all.
function scoreFlowParticipationComponent(
  symbol: { qualifiedName: string },
  queries: CodeGraphQueryService,
  repoId: string,
): { score: number; reason: string } | null {
  const flows = queries.listFlowsForSymbol(
    symbol.qualifiedName,
    repoId,
    RISK_FLOW_QUERY_LIMIT,
  );
  if (flows.length === 0) {
    return null;
  }
  const totalCriticality = flows.reduce(
    (sum, flow) => sum + flow.criticality,
    0,
  );
  const score = Math.min(totalCriticality, RISK_FLOW_PARTICIPATION_CAP);
  if (score <= 0) {
    return null;
  }
  return {
    score,
    reason: `in ${flows.length} ${flows.length === 1 ? 'flow' : 'flows'} (+${score.toFixed(2)})`,
  };
}

// 0.05 per distinct CALLER whose community differs from the symbol's own,
// capped at RISK_COMMUNITY_CROSSING_CAP. A symbol many OTHER communities
// depend on is riskier to change than one only its own community calls.
function scoreCommunityCrossingComponent(
  symbol: { qualifiedName: string },
  queries: CodeGraphQueryService,
  repoId: string,
): { score: number; reason: string } | null {
  const count = queries.countCrossCommunityCallers(
    symbol.qualifiedName,
    repoId,
  );
  if (count === 0) {
    return null;
  }
  const score = Math.min(
    count * RISK_COMMUNITY_CROSSING_WEIGHT,
    RISK_COMMUNITY_CROSSING_CAP,
  );
  return {
    score,
    reason: `${count} cross-community ${count === 1 ? 'caller' : 'callers'} (+${score.toFixed(2)})`,
  };
}

// `includeGraphComponents` is false for `delta.removed` symbols: they have
// no row left in the CURRENT graph, so `queries.getCallers`/`getTestsFor`
// (which resolve a symbol id in the current store first) can only ever
// report zero — that would misrepresent "we can't measure this anymore" as
// "this was untested with no callers". The security-keyword component still
// applies (it only inspects the known qualifiedName/filePath), so a removed
// symbol can still surface as risky when its name/path was security-sensitive.
// `derivedComputed` is false when neither communities nor flows have ever
// been computed for this repo (see `computeRiskBreakdowns`) — the two new
// components are skipped outright rather than attempted-and-naturally-zero,
// avoiding a wasted query against tables already known to be empty.
function scoreSymbol(
  symbol: { qualifiedName: string; kind: string; filePath: string },
  store: CodeGraphStore,
  queries: CodeGraphQueryService,
  testsFor: TestsForCache,
  repoId: string,
  includeGraphComponents: boolean,
  derivedComputed: boolean,
): SymbolRiskBreakdown {
  const components = includeGraphComponents
    ? [
        scoreCoverageComponent(symbol, store, testsFor, repoId),
        scoreSecurityKeywordComponent(symbol),
        scoreFanInComponent(symbol, queries, repoId),
        ...(derivedComputed
          ? [
              scoreFlowParticipationComponent(symbol, queries, repoId),
              scoreCommunityCrossingComponent(symbol, queries, repoId),
            ]
          : []),
      ]
    : [scoreSecurityKeywordComponent(symbol)];

  let rawScore = 0;
  const reasons: string[] = [];
  for (const component of components) {
    if (component === null) {
      continue;
    }
    rawScore += component.score;
    reasons.push(component.reason);
  }

  return {
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    filePath: symbol.filePath,
    score: Math.min(roundScore(rawScore), RISK_SCORE_CAP),
    reasons,
  };
}

interface RiskBreakdownsResult {
  breakdowns: SymbolRiskBreakdown[];
  // False when neither communities nor flows have ever been computed for
  // `repoId` (`store.getDerivedStats` reports 0 for both) — drives both
  // `scoreSymbol`'s component gating above and `aggregateRisk`'s honest
  // formula-note appendix below.
  derivedComputed: boolean;
  // True when that analysis exists but lags the latest build.
  derivedStale: boolean;
}

function computeRiskBreakdowns(input: {
  store: CodeGraphStore;
  repoId: string;
  delta: SymbolDelta;
  changed: readonly ChangedSymbol[];
  queries: CodeGraphQueryService;
  testsFor: TestsForCache;
}): RiskBreakdownsResult {
  const derivedStats = input.store.getDerivedStats(input.repoId);
  const derivedComputed =
    derivedStats.communityCount > 0 || derivedStats.flowCount > 0;
  const derivedStale =
    codeGraphDerivedState({
      ...input.store.getDerivedFreshness(),
      ...derivedStats,
    }) === 'stale';

  const breakdowns: SymbolRiskBreakdown[] = [];
  for (const symbol of input.changed) {
    breakdowns.push(
      scoreSymbol(
        symbol,
        input.store,
        input.queries,
        input.testsFor,
        input.repoId,
        true,
        derivedComputed,
      ),
    );
  }
  for (const symbol of input.delta.removed) {
    breakdowns.push(
      scoreSymbol(
        symbol,
        input.store,
        input.queries,
        input.testsFor,
        input.repoId,
        false,
        derivedComputed,
      ),
    );
  }
  return { breakdowns, derivedComputed, derivedStale };
}

export function changeRiskLevelForScore(
  score: number,
): RiskAssessment['level'] {
  if (score < 0.4) {
    return 'low';
  }
  if (score < 0.7) {
    return 'medium';
  }
  if (score < 0.85) {
    return 'high';
  }
  return 'critical';
}

function aggregateRisk(
  breakdowns: readonly SymbolRiskBreakdown[],
  derivedComputed: boolean,
  derivedStale: boolean,
): RiskAssessment {
  let overallScore = 0;
  for (const breakdown of breakdowns) {
    overallScore = Math.max(overallScore, breakdown.score);
  }

  const reasons = breakdowns
    .filter((breakdown) => breakdown.score > 0)
    .slice()
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareQualifiedName(a.qualifiedName, b.qualifiedName),
    )
    .slice(0, CHANGE_IMPACT_MAX_RISK_REASONS)
    .map(
      (breakdown) =>
        `${breakdown.qualifiedName}: ${breakdown.reasons.join(', ')} (score ${breakdown.score.toFixed(2)})`,
    );

  return {
    score: overallScore,
    level: changeRiskLevelForScore(overallScore),
    reasons,
    formula: !derivedComputed
      ? `${RISK_FORMULA} Note: ${RISK_FORMULA_DERIVED_ABSENT_NOTE}.`
      : derivedStale
        ? `${RISK_FORMULA} Note: ${RISK_FORMULA_DERIVED_STALE_NOTE}.`
        : RISK_FORMULA,
    ...(derivedComputed && derivedStale
      ? { staleInputs: [...RISK_STALE_INPUTS] }
      : {}),
  };
}

export function scoreChangeRisk(input: {
  store: CodeGraphStore;
  repoId: string;
  delta: SymbolDelta;
  changed: readonly ChangedSymbol[];
  queries: CodeGraphQueryService;
  testsFor?: TestsForCache;
}): RiskAssessment {
  const testsFor =
    input.testsFor ?? createTestsForCache(input.queries, input.repoId);
  const { breakdowns, derivedComputed, derivedStale } = computeRiskBreakdowns({
    ...input,
    testsFor,
  });
  return aggregateRisk(breakdowns, derivedComputed, derivedStale);
}

// --- Impact ----------------------------------------------------------------

export interface ChangeImpactHit {
  qualifiedName: string;
  kind: string;
  filePath: string;
  depth: number;
}

export const CHANGE_IMPACT_MAX_IMPACTED_TESTS = 50;
export const CHANGE_IMPACT_MAX_IMPACTED_FILES = 100;
export const CHANGE_IMPACT_MAX_TEST_GAPS = 50;
export const CHANGE_IMPACT_MAX_REVIEW_PRIORITIES = 10;

// Hard cap on the number of impact-traversal seeds a single change-impact
// assembly will fan out from. Uncapped, a mass-add or a very wide diff would
// fire one synchronous recursive CTE PER SEED (node:sqlite is sync — zero
// await points), blocking Electron main for the whole batch. The cap bounds
// per-call work the same way this module's other honesty caps do; when it
// bites, `impactSeedQualifiedNames` reports `truncated`.
export const CHANGE_IMPACT_MAX_SEEDS = 200;

// Seeds for the impact traversal, in a DETERMINISTIC priority order so the
// cap truncates predictably: `added` first, then `signatureChanged`, then any
// `changed` symbol whose changeKind is `modified` (a body edit that never
// touched a signature can still change behavior callers depend on). Each
// group is sorted by qualifiedName, and the whole list is deduped
// (first-occurrence wins). `removed` symbols are deliberately excluded: they
// have no row left in the current graph for `getImpactRadius` to seed from.
// `added-file` changeKind entries never need listing separately — a changed
// symbol with no before-graph entry is ALWAYS in `delta.added` regardless of
// its changeKind (see computeSymbolDelta), so they are already covered.
export function impactSeedQualifiedNames(
  delta: SymbolDelta,
  changed: readonly ChangedSymbol[],
): { seeds: string[]; truncated: boolean } {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const pushGroup = (names: readonly string[]): void => {
    for (const name of [...names].sort(compareQualifiedName)) {
      if (!seen.has(name)) {
        seen.add(name);
        ordered.push(name);
      }
    }
  };
  pushGroup(delta.added.map((symbol) => symbol.qualifiedName));
  pushGroup(delta.signatureChanged.map((symbol) => symbol.qualifiedName));
  pushGroup(
    changed
      .filter((symbol) => symbol.changeKind === 'modified')
      .map((symbol) => symbol.qualifiedName),
  );
  return {
    seeds: ordered.slice(0, CHANGE_IMPACT_MAX_SEEDS),
    truncated: ordered.length > CHANGE_IMPACT_MAX_SEEDS,
  };
}

// `getImpactRadius` clamps its own `maxNodes` option to at most 1000 (see
// query/queries.ts) — the hard technical ceiling for a single seed's query.
// Per-seed fetches always use that ceiling regardless of the caller's
// requested union cap below: if the per-seed fetch were capped at the same
// (potentially much smaller) final `maxNodes`, a single seed's own query
// would silently truncate BEFORE the union/dedupe step, and comparing the
// union's size against `maxNodes` would then always look non-truncated even
// when more impacted symbols really exist.
const IMPACT_RADIUS_PER_SEED_FETCH_CAP = 1000;

// Every this-many seeds, the radius loop yields to the event loop. node:sqlite
// runs each seed's breadth-first traversal synchronously, so a large seed set
// would otherwise execute back-to-back with no await points and block the
// caller's thread (Electron main). Yielding keeps it responsive.
const IMPACT_RADIUS_SEED_YIELD_INTERVAL = 25;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => resolve());
  });
}

// `maxNodes`/`maxDepth` default to the SAME shared constants the rest of the
// code-graph tool surface uses for `getImpactRadius` (see
// types/code-graph-tools.ts) — "per existing radius caps" from the brief —
// but are exposed as overridable inputs so this can be unit tested with a
// small cap instead of constructing hundreds of fixture symbols.
export async function computeChangeImpactRadius(input: {
  queries: CodeGraphQueryService;
  repoId: string;
  seedQualifiedNames: readonly string[];
  maxDepth?: number;
  maxNodes?: number;
}): Promise<{ impacted: ChangeImpactHit[]; truncated: boolean }> {
  const maxDepth = input.maxDepth ?? CODE_GRAPH_IMPACT_DEFAULT_DEPTH;
  const maxNodes = input.maxNodes ?? CODE_GRAPH_IMPACT_MAX_NODES;

  const byQualifiedName = new Map<string, ChangeImpactHit>();
  let processed = 0;
  for (const seed of input.seedQualifiedNames) {
    const hits = input.queries.getImpactRadius(
      seed,
      { maxDepth, maxNodes: IMPACT_RADIUS_PER_SEED_FETCH_CAP },
      input.repoId,
    );
    for (const hit of hits) {
      const existing = byQualifiedName.get(hit.qualifiedName);
      if (existing === undefined || hit.depth < existing.depth) {
        byQualifiedName.set(hit.qualifiedName, hit);
      }
    }
    processed += 1;
    if (processed % IMPACT_RADIUS_SEED_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }
  }

  const all = Array.from(byQualifiedName.values()).sort((a, b) => {
    if (a.depth !== b.depth) {
      return a.depth - b.depth;
    }
    return compareQualifiedName(a.qualifiedName, b.qualifiedName);
  });
  const truncated = all.length > maxNodes;
  return { impacted: all.slice(0, maxNodes), truncated };
}

// "impacted tests via getTestsFor per changed symbol, deduped, bounded 50" —
// runs over EVERY `changed` symbol (not just the impact-radius seeds), since
// a symbol whose body changed without a signature change still needs its
// own direct test coverage surfaced even though it seeds impact traversal
// the same way.
export function computeImpactedTests(input: {
  queries: CodeGraphQueryService;
  repoId: string;
  changed: readonly ChangedSymbol[];
  maxTests?: number;
  testsFor?: TestsForCache;
}): { impactedTests: string[]; truncated: boolean } {
  const testsFor =
    input.testsFor ?? createTestsForCache(input.queries, input.repoId);
  const maxTests = input.maxTests ?? CHANGE_IMPACT_MAX_IMPACTED_TESTS;
  const seen = new Set<string>();
  for (const symbol of input.changed) {
    for (const test of testsFor.get(symbol.qualifiedName)) {
      seen.add(test);
    }
  }
  const all = Array.from(seen).sort();
  const truncated = all.length > maxTests;
  return { impactedTests: all.slice(0, maxTests), truncated };
}

export interface TestGapSymbol {
  qualifiedName: string;
  kind: string;
  filePath: string;
}

// function/method only (narrower than the risk formula's untested-coverage
// kind gate, which also includes `class` — a changed class itself is not a
// meaningfully "test-gapped" unit the way a function/method body is).
const TEST_GAP_KINDS = new Set<string>(['function', 'method']);

export function findTestGaps(input: {
  store: CodeGraphStore;
  queries: CodeGraphQueryService;
  repoId: string;
  changed: readonly ChangedSymbol[];
  maxGaps?: number;
  testsFor?: TestsForCache;
}): { testGaps: TestGapSymbol[]; truncated: boolean } {
  const testsFor =
    input.testsFor ?? createTestsForCache(input.queries, input.repoId);
  const maxGaps = input.maxGaps ?? CHANGE_IMPACT_MAX_TEST_GAPS;
  const gaps: TestGapSymbol[] = [];
  for (const symbol of input.changed) {
    if (!TEST_GAP_KINDS.has(symbol.kind)) {
      continue;
    }
    const record = input.store.getSymbolByQualifiedName(
      symbol.qualifiedName,
      input.repoId,
    );
    if (record !== null && record.isTest) {
      continue;
    }
    if (testsFor.get(symbol.qualifiedName).length > 0) {
      continue;
    }
    gaps.push({
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      filePath: symbol.filePath,
    });
  }
  const truncated = gaps.length > maxGaps;
  return { testGaps: gaps.slice(0, maxGaps), truncated };
}

// --- Review context + full report ------------------------------------------

export interface ChangeReviewContext {
  changedSymbols: Array<{
    qualifiedName: string;
    kind: string;
    filePath: string;
    changeKind: ChangedSymbol['changeKind'];
    riskScore: number;
    riskReasons: string[];
  }>;
  impactedFiles: string[];
  impactedFilesTruncated: boolean;
  testGaps: TestGapSymbol[];
  testGapsTruncated: boolean;
  reviewPriorities: Array<{ qualifiedName: string; score: number }>;
  reviewPrioritiesTruncated: boolean;
}

// NOTE for Task 5: this is the FULL internal shape. Task 5 lifts only the
// wire-shape subset the injected tool/CLI surfaces actually need into
// types/code-graph-tools.ts — this interface is not meant to be serialized
// as-is.
export interface ChangeImpactReport {
  repoId: string;
  baseRef: string;
  changed: ChangedSymbol[];
  unmatchedFiles: string[];
  delta: SymbolDelta;
  risk: RiskAssessment;
  impacted: ChangeImpactHit[];
  impactTruncated: boolean;
  // True when the diff produced more impact-traversal seeds than
  // `CHANGE_IMPACT_MAX_SEEDS`, so only that many were fanned out from (see
  // `impactSeedQualifiedNames`). The impacted set is therefore a lower bound.
  impactSeedsTruncated: boolean;
  impactedTests: string[];
  impactedTestsTruncated: boolean;
  beforeGraph: { filesBuilt: number; filesSkipped: number };
  reviewContext: ChangeReviewContext;
}

function buildChangedSymbolsReview(
  changed: readonly ChangedSymbol[],
  breakdownByName: ReadonlyMap<string, SymbolRiskBreakdown>,
): ChangeReviewContext['changedSymbols'] {
  return changed.map((symbol) => {
    const breakdown = breakdownByName.get(symbol.qualifiedName);
    return {
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      filePath: symbol.filePath,
      changeKind: symbol.changeKind,
      riskScore: breakdown?.score ?? 0,
      riskReasons: breakdown?.reasons ?? [],
    };
  });
}

function dedupeImpactedFiles(
  impacted: readonly ChangeImpactHit[],
  maxFiles: number,
): { files: string[]; truncated: boolean } {
  const seen = new Set<string>();
  for (const hit of impacted) {
    seen.add(hit.filePath);
  }
  const files = Array.from(seen).sort();
  const truncated = files.length > maxFiles;
  return { files: files.slice(0, maxFiles), truncated };
}

function topReviewPriorities(
  breakdowns: readonly SymbolRiskBreakdown[],
  maxPriorities: number,
): {
  priorities: Array<{ qualifiedName: string; score: number }>;
  truncated: boolean;
} {
  const sorted = [...breakdowns].sort(
    (a, b) =>
      b.score - a.score ||
      compareQualifiedName(a.qualifiedName, b.qualifiedName),
  );
  const truncated = sorted.length > maxPriorities;
  return {
    priorities: sorted.slice(0, maxPriorities).map((breakdown) => ({
      qualifiedName: breakdown.qualifiedName,
      score: breakdown.score,
    })),
    truncated,
  };
}

function buildReviewContext(input: {
  store: CodeGraphStore;
  queries: CodeGraphQueryService;
  repoId: string;
  changed: readonly ChangedSymbol[];
  impacted: readonly ChangeImpactHit[];
  breakdowns: readonly SymbolRiskBreakdown[];
  testsFor: TestsForCache;
}): ChangeReviewContext {
  const breakdownByName = new Map(
    input.breakdowns.map((breakdown) => [breakdown.qualifiedName, breakdown]),
  );
  const changedSymbols = buildChangedSymbolsReview(
    input.changed,
    breakdownByName,
  );
  const { files: impactedFiles, truncated: impactedFilesTruncated } =
    dedupeImpactedFiles(input.impacted, CHANGE_IMPACT_MAX_IMPACTED_FILES);
  const { testGaps, truncated: testGapsTruncated } = findTestGaps({
    store: input.store,
    queries: input.queries,
    repoId: input.repoId,
    changed: input.changed,
    testsFor: input.testsFor,
  });
  const { priorities: reviewPriorities, truncated: reviewPrioritiesTruncated } =
    topReviewPriorities(input.breakdowns, CHANGE_IMPACT_MAX_REVIEW_PRIORITIES);

  return {
    changedSymbols,
    impactedFiles,
    impactedFilesTruncated,
    testGaps,
    testGapsTruncated,
    reviewPriorities,
    reviewPrioritiesTruncated,
  };
}

// Orchestrates the full change-impact pipeline: diff -> changed symbols ->
// scoped before-graph -> delta -> risk -> impact traversal -> review
// context. Each stage is also independently exported/testable above so
// tests can exercise cap/truncation and scoring logic with small seeded
// fixtures instead of reconstructing an entire git+engine pipeline per case.
export async function assembleChangeImpact(input: {
  store: CodeGraphStore;
  queries: CodeGraphQueryService;
  repoId: string;
  rootPath: string;
  baseRef: string;
  maxDepth?: number;
  resourcesDir?: string;
  cachePath?: string;
}): Promise<ChangeImpactReport> {
  const diffChanges = await getDiffRanges(input.rootPath, input.baseRef);
  const { changed, unmatchedFiles } = mapRangesToSymbols({
    store: input.store,
    repoId: input.repoId,
    changes: diffChanges,
  });

  const beforeGraphInput: Parameters<typeof buildBeforeGraphForChanges>[0] = {
    rootPath: input.rootPath,
    repoId: input.repoId,
    baseRef: input.baseRef,
    changes: diffChanges,
    cachePath: input.cachePath,
  };
  if (input.resourcesDir !== undefined) {
    beforeGraphInput.resourcesDir = input.resourcesDir;
  }
  const before = await buildBeforeGraphForChanges(beforeGraphInput);

  // One TESTED_BY lookup cache shared by the risk, impacted-tests, and
  // test-gap stages so no changed symbol's tests are queried more than once
  // per assembly (see createTestsForCache).
  const testsFor = createTestsForCache(input.queries, input.repoId);

  const delta = computeSymbolDelta({
    changed,
    before,
    store: input.store,
    repoId: input.repoId,
  });

  const { breakdowns, derivedComputed, derivedStale } = computeRiskBreakdowns({
    store: input.store,
    repoId: input.repoId,
    delta,
    changed,
    queries: input.queries,
    testsFor,
  });
  const risk = aggregateRisk(breakdowns, derivedComputed, derivedStale);

  const { seeds: seedQualifiedNames, truncated: impactSeedsTruncated } =
    impactSeedQualifiedNames(delta, changed);
  const { impacted, truncated: impactTruncated } =
    await computeChangeImpactRadius({
      queries: input.queries,
      repoId: input.repoId,
      seedQualifiedNames,
      maxDepth: input.maxDepth,
    });

  const { impactedTests, truncated: impactedTestsTruncated } =
    computeImpactedTests({
      queries: input.queries,
      repoId: input.repoId,
      changed,
      testsFor,
    });

  const reviewContext = buildReviewContext({
    store: input.store,
    queries: input.queries,
    repoId: input.repoId,
    changed,
    impacted,
    breakdowns,
    testsFor,
  });

  return {
    repoId: input.repoId,
    baseRef: input.baseRef,
    changed,
    unmatchedFiles,
    delta,
    risk,
    impacted,
    impactTruncated,
    impactSeedsTruncated,
    impactedTests,
    impactedTestsTruncated,
    beforeGraph: {
      filesBuilt: before.filesBuilt,
      filesSkipped: before.filesSkipped,
    },
    reviewContext,
  };
}
