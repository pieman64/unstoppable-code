// Shared contract for the code-graph injected tools (Phase 2). This file is
// consumed by the Electron-main tool runtime
// (`apps/desktop-app/src/main/canopy-tools/code-graph-runtime.ts`) and is
// intended to be reused as-is by the desktop CLI, so it must stay free of
// Electron/Node-only imports.

import type {
  CodeGraphConfidenceTier,
  CodeGraphDiagnostics,
  CodeGraphDerivedRepoStats,
  CodeGraphEdgeKind,
  CodeGraphParseStatus,
  CodeGraphSymbolKind,
} from './code-graph';

/** Availability of retained measured data, independent of source work. */
export type CodeGraphSnapshotState =
  | 'missing'
  | 'summary-pending'
  | 'readable'
  | 'read-error';
export type CodeGraphBuildState = 'idle' | 'queued' | 'running';
export type CodeGraphReadFailure =
  | 'queue-timeout'
  | 'execution-timeout'
  | 'busy'
  | 'worker-exit'
  | 'canceled'
  | 'invalid-response'
  | 'database-error';

export type CodeGraphDetailLevel = 'minimal' | 'standard';

export const CODE_GRAPH_TOOL_MAX_RESULTS = 50;
export const CODE_GRAPH_TOOL_DEFAULT_RESULTS = 20;
export const CODE_GRAPH_IMPACT_MAX_DEPTH = 4;
export const CODE_GRAPH_IMPACT_DEFAULT_DEPTH = 2;
export const CODE_GRAPH_IMPACT_MAX_NODES = 500;
export const CODE_GRAPH_IMPACT_DEFAULT_NODES = 200;

export const CODE_GRAPH_QUERY_MODES = [
  'call-path',
  'relationship-path',
  'callers',
  'callees',
  'importers',
  'imports',
  'children',
  'tests-for',
  'file-summary',
  'docs-for',
  'rationale-for',
  'scripts-for-file',
  'ipc-channel',
  // Phase 6 Task 7: derived-analysis modes. 'communities'/'flows' read the
  // Phase 6 Task 3 derived tables (communities/flows/*_memberships) and are
  // honestly empty (never an error) when those tables are empty/absent for
  // the repo -- see CODE_GRAPH_DERIVED_NONE_NOTE. 'hubs' is NOT a derived
  // reading: `listTopDegreeSymbols` computes total edge degree directly from
  // the `edges` table, so it is available as soon as a graph exists at all,
  // with no dependency on the derived-analysis phase ever having run.
  'communities',
  'flows',
  'hubs',
] as const;
export type CodeGraphQueryMode = (typeof CODE_GRAPH_QUERY_MODES)[number];

// Shared verbatim by the Electron tool runtime and the desktop CLI (both
// cannot import from each other -- see code-graph-runtime.ts's
// `fetchHitsForMode` comment) so the honesty note for an empty 'communities'/
// 'flows' result reads identically everywhere it appears.
export const CODE_GRAPH_DERIVED_NONE_NOTE = 'derived: none';

// Same sharing as `CODE_GRAPH_DERIVED_NONE_NOTE`: appended when communities
// or flows exist but were computed for an earlier build than the latest
// published one (derived analysis runs after a refresh is published).
export const CODE_GRAPH_DERIVED_STALE_NOTE = 'derived: stale';

/**
 * Freshness of a graph's derived analysis (communities and flows), from the
 * existing markers. `derived_at` is cleared whenever a build changes facts
 * and set again when derived analysis completes, so it is present exactly
 * when the stored analysis matches the latest build. Without it, analysis
 * rows left by an earlier build are `stale`; no rows at all is `none` (never
 * computed, or the first computation is still pending).
 */
export type CodeGraphDerivedState = 'current' | 'stale' | 'none';

export function codeGraphDerivedState(input: {
  lastBuildAt: number | null;
  derivedAt: number | null;
  communityCount: number;
  flowCount: number;
}): CodeGraphDerivedState {
  if (input.derivedAt !== null) return 'current';
  return input.lastBuildAt !== null &&
    (input.communityCount > 0 || input.flowCount > 0)
    ? 'stale'
    : 'none';
}

/** Query modes that take NO target at all. 'flows' is intentionally NOT
 * listed: its target is an OPTIONAL symbol filter (present -> flows
 * containing that symbol; absent -> top flows overall), so it neither
 * requires nor ignores one. This is the single source of truth for the
 * per-mode target rule enforced by both the Electron tool runtime and the
 * desktop CLI -- the schema layer keeps `target` optional (whether a given
 * mode needs one is a semantic rule, not a shape rule). */
export const CODE_GRAPH_TARGETLESS_QUERY_MODES = [
  'communities',
  'hubs',
] as const;

/** True when `mode` cannot produce a meaningful result without a target.
 * Both query surfaces (runtime + CLI) reject such calls with an explicit
 * missing-argument error instead of resolving an absent target as an
 * honest-looking 0-hit "ok" -- a silent empty result for `callers` with no
 * target would read as "this symbol has no callers", which is dishonest. */
export function codeGraphQueryModeRequiresTarget(
  mode: CodeGraphQueryMode,
): boolean {
  if (mode === 'flows') {
    return false;
  }
  return !CODE_GRAPH_TARGETLESS_QUERY_MODES.some(
    (targetless) => targetless === mode,
  );
}

/** Cap on `CodeGraphExplainResult.flows` -- ExplainCodeSymbol surfaces at
 * most this many of a symbol's flow memberships (most-critical-first),
 * regardless of `detailLevel`/`limit` (this tool takes neither). */
export const CODE_GRAPH_EXPLAIN_MAX_FLOWS = 3;

/** Cap on `CodeGraphContextResult.topCommunities` -- GetCodeGraphContext's
 * ~100-token discovery budget only affords a handful of communities, largest
 * first. */
export const CODE_GRAPH_CONTEXT_MAX_COMMUNITIES = 5;

export interface CodeGraphToolEnvelope {
  status: 'ok' | 'unavailable' | 'error';
  summary: string; // one line, always present
  truncated: boolean;
  suggestedNextTools?: string[];
}

export interface CodeGraphContextResult extends CodeGraphToolEnvelope {
  snapshotState?: CodeGraphSnapshotState;
  buildState?: CodeGraphBuildState;
  /** Present for classified read failures; required counts are unmeasured then. */
  readFailure?: CodeGraphReadFailure;
  diagnostics?: CodeGraphDiagnostics | null;
  hasGraph: boolean;
  lastBuildAt: number | null;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  unresolvedEdgeCount: number;
  filesWithErrors: number;
  repositories: Array<{ repoId: string; fileCount: number }>;
  // Derived-analysis (communities + flows, Phase 6 Task 6) counts, mirrored
  // straight through from `CodeGraphStatus` — see that type's doc comment
  // for why `derivedAt: null` is the honest "never computed" marker rather
  // than a separate discriminant.
  communityCount: number;
  flowCount: number;
  derivedAt: number | null;
  // Present only while derived analysis lags the latest build (see
  // `codeGraphDerivedState`); `summary` then carries
  // `CODE_GRAPH_DERIVED_STALE_NOTE`.
  derivedState?: 'stale';
  // Top communities by size across every repository in this worktree's
  // graph (repoId omitted, same aggregation convention `communityCount`/
  // `flowCount` already use), capped at CODE_GRAPH_CONTEXT_MAX_COMMUNITIES.
  // Empty exactly when `communityCount` is 0 (derived analysis never
  // computed, or computed and found none) -- no separate honesty note is
  // needed here since `derivedAt`/`communityCount` already say so
  // machine-readably.
  topCommunities: CodeGraphCommunityHit[];
  // Compact mirror of `CodeGraphStatus.customLanguages` (Phase 6 Task 8):
  // ids that loaded plus per-entry warn-and-skip diagnostic messages from
  // the LAST build. Absent when that build saw no custom language config.
  customLanguages?: { loaded: string[]; warnings: string[] };
}

export interface CodeGraphSymbolHit {
  matchKind?: 'exact' | 'prefix' | 'token-prefix' | 'fragment';
  // Always a REAL, chainable identifier: a symbol qualified name (or a bare
  // canonical relative path for file-flavored hits) that an agent can feed
  // back into ExplainCodeSymbol/QueryCodeGraph. Never fabricated display text.
  qualifiedName: string;
  kind: string;
  filePath: string;
  line: number | null;
  // Optional human-readable display text for hit flavors whose qualifiedName
  // alone is not self-describing (e.g. rationale-for hits carry
  // "MARKER: comment text" here). Renderers should prefer `label` when
  // present; `qualifiedName` stays the machine-usable identifier.
  label?: string;
}

// Wire form of a `CodeGraphCommunityRecord` (node/code-graph/store/graph-store.ts)
// -- deliberately narrower than the full store record (drops `repositoryId`/
// `fingerprint`/`extra`, none of which an agent/CLI caller needs) the same
// way `CodeGraphSymbolHit` narrows a full symbol row.
export interface CodeGraphCommunityHit {
  id: string;
  label: string;
  size: number;
  cohesion: number;
}

// Wire form of a `CodeGraphFlowRecord` (same narrowing rationale as
// `CodeGraphCommunityHit` above).
export interface CodeGraphFlowHit {
  id: string;
  name: string;
  criticality: number;
  symbolCount: number;
  fileSpread: number;
}

export interface CodeGraphQueryResult extends CodeGraphToolEnvelope {
  mode: CodeGraphQueryMode;
  // Echoes the request's target ('' when omitted). Modes 'communities'/
  // 'hubs' ignore it entirely, 'flows' treats it as an OPTIONAL symbol
  // filter, and every other mode requires it (a missing target produces an
  // `error` envelope, not a 0-hit "ok" — see codeGraphQueryModeRequiresTarget).
  target: string;
  hits: CodeGraphSymbolHit[]; // empty at detailLevel 'minimal' beyond top 5
  path?: CodeGraphPathResult;
  fileSummary?: {
    file: string;
    symbols: Array<{ qualifiedName: string; kind: string; exported: boolean }>;
    imports: string[];
    importerCount: number;
  };
  // Populated only for mode 'scripts-for-file' — a manifest file's declared
  // script name/command pairs. `hits` stays empty for this mode, mirroring
  // how `fileSummary` mode leaves `hits` empty in favor of its own payload.
  scripts?: Array<{ name: string; command: string | null }>;
  // Populated only for mode 'ipc-channel' — the resolved channel's own
  // location plus its handler/invoker call sites. `hits` stays empty for
  // this mode, same convention as `fileSummary`/`scripts`. `channel` is null
  // when the key/qualified name doesn't resolve to an ipc_channel symbol OR
  // (see `ambiguousCount`) when a bare key or signature value matched more
  // than one channel — in the ambiguous case `handlers`/`invokers` also stay
  // empty rather than guessing which match the caller meant.
  ipcChannel?: {
    channel: {
      qualifiedName: string;
      filePath: string;
      signature: string | null;
      line: number;
    } | null;
    handlers: CodeGraphSymbolHit[];
    invokers: CodeGraphSymbolHit[];
    ambiguousCount: number;
    // Nonzero only when `channel` resolved AND the same-repo-duplicate
    // aftermath left some of ITS call sites unbound: resolve/ipc-resolver.ts
    // never binds an IPC_HANDLES/IPC_INVOKES edge when more than one
    // ipc_channel symbol shares the resolved channel's bare key in the same
    // repo, so resolving one of the duplicates by qualified name can still
    // return an incomplete handlers/invokers list. Always 0 when `channel`
    // is null (ambiguous or not-found).
    unresolvedCallSiteCount: number;
  };
  // Populated only for mode 'communities' — top communities by size
  // (optionally scoped to `repoId`). `hits` stays empty for this mode, same
  // convention as `fileSummary`/`scripts`/`ipcChannel`. Empty exactly when
  // the repo's `communities` table is empty/absent (derived analysis never
  // computed, or computed and found none) — an honest empty result, not an
  // error; `summary` appends `CODE_GRAPH_DERIVED_NONE_NOTE` in that case.
  communities?: CodeGraphCommunityHit[];
  // Populated only for mode 'flows' — top flows by criticality, optionally
  // filtered down to flows containing the symbol named by `target` (empty/
  // absent `target` means "no filter, list top flows overall"). Same empty
  // conventions as `communities` above, but scoped to the `flows` table.
  flows?: CodeGraphFlowHit[];
}

export interface CodeGraphSearchResultPayload extends CodeGraphToolEnvelope {
  hits: CodeGraphSymbolHit[];
}

export interface CodeGraphExplainResult extends CodeGraphToolEnvelope {
  symbol?: {
    qualifiedName: string;
    kind: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    signature: string | null;
    exported: boolean;
  };
  callers: CodeGraphSymbolHit[];
  callees: CodeGraphSymbolHit[];
  tests: string[];
  // Derived-analysis enrichment (Phase 6 Task 7). `community` is null when
  // the symbol has no community assignment (derived analysis never
  // computed for this repo, or the symbol was never placed — e.g. an
  // isolated symbol the partition skipped). `flows` is every flow
  // containing the symbol, most-critical-first, capped at
  // CODE_GRAPH_EXPLAIN_MAX_FLOWS; empty for the same "no derived data" or
  // "not part of any traced flow" reasons. Neither ever causes an error —
  // both are honest-empty defaults, matching the rest of this tool's
  // not-found handling.
  community: CodeGraphCommunityHit | null;
  flows: CodeGraphFlowHit[];
}

export interface CodeGraphImpactResult extends CodeGraphToolEnvelope {
  impacted: Array<CodeGraphSymbolHit & { depth: number }>;
  maxDepth: number;
}

export interface CodeGraphBuildToolResult extends CodeGraphToolEnvelope {
  filesScanned: number;
  filesParsed: number;
  filesUnchanged: number;
  filesRemoved: number;
  filesSkipped: number;
  parseFailures: number;
  durationMs: number;
  // Custom-language warn-and-skip diagnostic messages from this build
  // (Phase 6 Task 8) -- one string per skipped/failed config entry, plus the
  // single config-level message when the config file itself was malformed.
  // Absent when the build saw no custom language config; empty when every
  // entry loaded cleanly.
  customLanguageWarnings?: string[];
  // Derived-analysis warnings from this build (whole-branch-review fix,
  // Phase 6) -- the flattened `CodeGraphBuildResult.derived[].warnings`
  // across every repository this build processed (community detection
  // skipped over the 50k-symbol cap, the flow global-membership cap
  // reached, or a caught non-fatal derived-analysis failure -- see
  // analysis/derived.ts's `computeDerivedForRepo`). Each message already
  // names its own repoId, so no additional prefix is added. Absent when
  // `computeDerived: false` was passed for this build (so
  // `CodeGraphBuildResult.derived` was empty); empty when every processed
  // repository's derived-analysis warnings array was empty. See
  // `collectCodeGraphDerivedBuildWarnings` below for the shared mapping.
  derivedWarnings?: string[];
}

/**
 * Flattens `CodeGraphBuildResult.derived[].warnings` into the flat list both
 * build-tool consumers (the Electron `BuildOrUpdateCodeGraph` tool runtime
 * and the CLI `code-graph build` command) surface as
 * `CodeGraphBuildToolResult.derivedWarnings`. Shared verbatim by both (same
 * reasoning as `CODE_GRAPH_DERIVED_NONE_NOTE` above: the two consumers
 * cannot import from each other, but both already depend on this file), so
 * neither has to re-derive the flattening rule on its own. Pure and total --
 * an empty `derived` input just yields `[]`; callers decide whether an empty
 * `derived` means the field should be OMITTED entirely (computeDerived:
 * false) rather than set to `[]`.
 */
export function collectCodeGraphDerivedBuildWarnings(
  derived: readonly CodeGraphDerivedRepoStats[],
): string[] {
  return derived.flatMap((repoStats) => repoStats.warnings);
}

// --- Request shapes + supplementary caps below are not part of the literal
// result-type contract above; they exist so the runtime (and, later, the CLI
// and the Task 4 zod schemas) share one definition of "what a tool call looks
// like" instead of redeclaring these shapes per consumer. Field names/optionality
// mirror the schema shapes documented in the Phase 2 plan (Task 4) exactly. ---

/** Hit cap applied at `detailLevel: 'minimal'` (the default) across every
 * list-returning tool (query/search/impact). */
export const CODE_GRAPH_TOOL_MINIMAL_RESULTS = 5;

/** Max symbols returned inside a `file-summary` query-mode payload. */
export const CODE_GRAPH_FILE_SUMMARY_MAX_SYMBOLS = 100;

export interface CodeGraphPathRequest {
  mode: 'call-path' | 'relationship-path';
  target: string;
  to: string;
  repoId?: string;
  maxDepth?: number;
  maxNodes?: number;
}

export interface CodeGraphPathHop {
  source: string;
  target: string;
  kind: string;
  direction: 'forward' | 'reverse';
  filePath: string;
  line: number | null;
  confidenceTier: string;
  confidenceScore: number;
  resolverId: string | null;
  /** Raw JSON evidence, capped at 2048 characters per hop. */
  evidence: string;
  evidenceTruncated: boolean;
}

export interface CodeGraphPathResult {
  status:
    | 'found'
    | 'no-path'
    | 'budget-exhausted'
    | 'endpoint-not-found'
    | 'ambiguous-endpoint';
  hops: CodeGraphPathHop[];
  visitedNodes: number;
  visitedEdges: number;
  limits: { maxDepth: number; maxNodes: number; maxEdges: number };
}

export interface CodeGraphQueryRequest {
  to?: string;
  maxDepth?: number;
  maxNodes?: number;
  mode: CodeGraphQueryMode;
  // Optional at the SCHEMA level only: 'communities'/'hubs' ignore it and
  // 'flows' treats it as an optional symbol filter, but every other mode
  // requires one (see codeGraphQueryModeRequiresTarget) — the runtime and
  // CLI both reject a target-requiring mode called without a target as an
  // explicit missing-argument error, never a silent 0-hit "ok".
  target?: string;
  repoId?: string;
  detailLevel?: CodeGraphDetailLevel;
  limit?: number;
}

export interface CodeGraphSearchRequest {
  query: string;
  limit?: number;
  detailLevel?: CodeGraphDetailLevel;
}

export interface CodeGraphExplainRequest {
  qualifiedName: string;
  repoId?: string;
}

export interface CodeGraphImpactRequest {
  target: string;
  maxDepth?: number;
  maxNodes?: number;
  detailLevel?: CodeGraphDetailLevel;
}

// --- Change-impact tool contracts (Phase 4) --------------------------------
//
// `assembleChangeImpact` (node/code-graph/impact/change-impact.ts) assembles
// a much richer INTERNAL report (`ChangeImpactReport`) than any tool response
// should serialize verbatim — raw impact-radius hits carry traversal `depth`,
// `unmatchedFiles`/before-graph coverage counts are diagnostic-only, etc. The
// types below are the deliberately-narrowed WIRE subset the three injected
// tools (`DetectChangedSymbols`/`CompareChangeImpact`/`GetReviewContext`) and
// the future CLI mirror actually need. They live in this browser-safe file —
// not in `change-impact.ts` — so a browser-safe consumer never needs to pull
// in Node-only `change-impact.ts`. That module imports `CodeGraphRiskAssessment`
// back from here (its own `RiskAssessment` is now a type alias onto it) so
// there is exactly one risk-assessment shape, not two independently
// maintained ones. The runtime (`code-graph-runtime.ts`) maps the other
// internal shapes (`ChangedSymbol`, `SymbolDelta`, `ChangeImpactHit`,
// `ChangeReviewContext`) onto these.

/** Mirrors `ChangedSymbol['changeKind']` (impact/changed-symbols.ts). */
export type CodeGraphChangeKind = 'modified' | 'added-file' | 'deleted-file';

/** Wire form of a single changed symbol (mirrors `ChangedSymbol`). */
export interface CodeGraphChangedSymbolPayload {
  qualifiedName: string;
  kind: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  changeKind: CodeGraphChangeKind;
}

export type CodeGraphRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Wire form of `RiskAssessment` (impact/change-impact.ts) — that module's
 * own `RiskAssessment` type is now a plain alias onto this interface. */
export interface CodeGraphRiskAssessment {
  score: number;
  level: CodeGraphRiskLevel;
  reasons: string[];
  formula: string;
  /**
   * Formula terms whose inputs come from derived analysis computed for an
   * earlier build (present only while that analysis is stale). The terms are
   * still scored from the stored analysis; `formula` carries the same note.
   */
  staleInputs?: Array<'flowParticipation' | 'communityCrossing'>;
}

/** Hard cap on `DetectChangedSymbolsResult.changed`, and on
 * `CompareChangeImpactResult.delta.{added,removed,signatureChanged}` /
 * `GetReviewContextResult.changedSymbols`, at `detailLevel: 'standard'`.
 * `detailLevel: 'minimal'` applies the shared `CODE_GRAPH_TOOL_MINIMAL_RESULTS`
 * top-5 cap instead, same as every other list-returning code-graph tool. */
export const CODE_GRAPH_CHANGE_DETAIL_MAX_ITEMS = 200;

export interface DetectChangedSymbolsRequest {
  baseRef?: string;
  repoId?: string;
  detailLevel?: CodeGraphDetailLevel;
}

export interface DetectChangedSymbolsResult extends CodeGraphToolEnvelope {
  // The ref actually diffed against: either the caller's validated `baseRef`,
  // a resolved merge-base against the repo's default branch, or the literal
  // `'HEAD'` fallback (working-tree-vs-HEAD diff). Always a real ref string;
  // an `error`/`unavailable` envelope reports it as an empty string.
  baseRef: string;
  // Epoch-ms of the graph's last build (from getStatus), or null when unknown
  // (never built / error path). Range mapping is only as accurate as the graph
  // is fresh: a stale graph maps diff ranges onto out-of-date symbol lines.
  lastBuildAt: number | null;
  changed: CodeGraphChangedSymbolPayload[];
  unmatchedFiles: string[];
}

export interface CompareChangeImpactRequest {
  baseRef?: string;
  repoId?: string;
  maxDepth?: number;
  detailLevel?: CodeGraphDetailLevel;
}

export interface CodeGraphChangeDelta {
  addedCount: number;
  removedCount: number;
  signatureChangedCount: number;
  // Present only at `detailLevel: 'standard'`.
  added?: CodeGraphChangedSymbolPayload[];
  removed?: Array<{ qualifiedName: string; kind: string; filePath: string }>;
  signatureChanged?: Array<{
    qualifiedName: string;
    before: string | null;
    after: string | null;
  }>;
}

export interface CompareChangeImpactResult extends CodeGraphToolEnvelope {
  baseRef: string;
  // Epoch-ms of the graph's last build (from getStatus), or null when unknown.
  // Delta/impact accuracy depends on graph freshness — see
  // `DetectChangedSymbolsResult.lastBuildAt`.
  lastBuildAt: number | null;
  delta: CodeGraphChangeDelta;
  // `depth` mirrors `CodeGraphImpactResult.impacted` (the sibling
  // GetImpactRadius tool): 1 = direct caller/dependent of a changed symbol,
  // 2+ = transitive. Carried here so agents keep the direct-vs-indirect
  // distinction without needing a follow-up GetImpactRadius call.
  impacted: Array<CodeGraphSymbolHit & { depth: number }>;
  impactedTests: string[];
  risk: CodeGraphRiskAssessment;
}

export interface GetReviewContextRequest {
  baseRef?: string;
  repoId?: string;
  detailLevel?: CodeGraphDetailLevel;
}

export interface CodeGraphChangedSymbolReview {
  qualifiedName: string;
  kind: string;
  filePath: string;
  changeKind: CodeGraphChangeKind;
  riskScore: number;
  riskReasons: string[];
}

export interface CodeGraphTestGap {
  qualifiedName: string;
  kind: string;
  filePath: string;
}

export interface CodeGraphReviewPriority {
  qualifiedName: string;
  score: number;
}

export interface GetReviewContextResult extends CodeGraphToolEnvelope {
  baseRef: string;
  // Epoch-ms of the graph's last build (from getStatus), or null when unknown.
  // Review accuracy depends on graph freshness — see
  // `DetectChangedSymbolsResult.lastBuildAt`.
  lastBuildAt: number | null;
  changedSymbols: CodeGraphChangedSymbolReview[];
  impactedFiles: string[];
  impactedTests: string[];
  testGaps: CodeGraphTestGap[];
  reviewPriorities: CodeGraphReviewPriority[];
  risk: CodeGraphRiskAssessment;
}

// --- Snapshot export/import (Phase 4 Task 8) --------------------------------
//
// A deterministic, source-controllable JSON snapshot of ONE repository's code
// graph — repo-relative paths only (no absolute paths, and no internal
// sqlite row ids: those are hashes of `(repoId, relativePath/qualifiedName)`
// — see `node/code-graph/ids.ts` — and are RECOMPUTED fresh at import time
// against whatever repoId the import target actually uses, so a snapshot
// never has to assume its origin repoId matches the destination). The
// read/write side lives in `node/code-graph/snapshot/export.ts` and
// `import.ts`; the on-disk format, refuse-to-shrink guard, and merge story
// are documented in `docs/code-graph.md`.

export const CODE_GRAPH_SNAPSHOT_SCHEMA_VERSION = 1;

/** One entry from the bundled code-graph resources manifest.json's
 * `grammars` array, carried into the snapshot so `import.ts` can warn (not
 * block) on a grammar-version mismatch between the snapshot's origin and the
 * importing machine's bundled grammars. */
export interface CodeGraphSnapshotGrammar {
  package: string;
  version: string;
  grammar?: string;
  built?: boolean;
}

export interface CodeGraphSnapshotFile {
  relativePath: string;
  language: string | null;
  contentHash: string | null;
  sizeBytes: number;
  mtimeNs: string;
  lineCount: number | null;
  grammarId: string | null;
  grammarAbi: number | null;
  parseStatus: CodeGraphParseStatus;
  hasErrors: boolean;
}

/** Deliberately the SAME narrow projection `CodeGraphStore.listSymbols`
 * already returns (qualifiedName/kind/signature/filePath) rather than the
 * full `CodeGraphSymbolRecord` — a snapshot is a lightweight, rebuildable
 * SEED, not a lossless mirror of the operational database. Fields the full
 * record carries but this one omits (`parentSymbolId`, line/byte ranges,
 * `exported`, `isTest`, `extra`) are reconstructed with placeholder/heuristic
 * values on import; a file whose content hash matches what the snapshot
 * recorded will keep those placeholders until something else forces a
 * reparse (content change or an `extractor_version` bump) — see
 * docs/code-graph.md's snapshot section for the documented tradeoff. */
export interface CodeGraphSnapshotSymbol {
  qualifiedName: string;
  kind: CodeGraphSymbolKind;
  signature: string | null;
  filePath: string;
}

/** Edge identity is expressed purely in PORTABLE terms (qualifiedName /
 * relativePath) rather than the operational database's internal hash ids, so
 * an edge can be re-hashed against whatever repoId the import target
 * actually uses. `sourceQualifiedName`/`targetQualifiedName` are `null`
 * exactly when the operational edge's own `sourceSymbolId`/`targetSymbolId`
 * was `null` (an edge with no bound source symbol, or an unresolved/dangling
 * target). */
export interface CodeGraphSnapshotEdge {
  kind: CodeGraphEdgeKind;
  sourceFilePath: string;
  sourceQualifiedName: string | null;
  targetQualifiedName: string | null;
  targetRef: string | null;
  line: number | null;
  confidenceTier: CodeGraphConfidenceTier;
  confidenceScore: number;
  resolverId: string | null;
  evidence: Record<string, unknown>;
}

export interface CodeGraphSnapshotEnvelope {
  schemaVersion: number;
  generatedAt: string;
  repository: {
    repoId: string;
    gitHead: string | null;
  };
  grammars: CodeGraphSnapshotGrammar[];
  files: CodeGraphSnapshotFile[];
  symbols: CodeGraphSnapshotSymbol[];
  edges: CodeGraphSnapshotEdge[];
}
