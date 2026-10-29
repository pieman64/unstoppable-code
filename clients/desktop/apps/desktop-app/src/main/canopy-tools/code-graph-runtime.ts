import type { CodeGraphPathResult } from '@canopy/desktop-shared/types/code-graph-tools';
import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { existsSync } from 'node:fs';
import type {
  CodeGraphCommunityRecord,
  CodeGraphCustomLanguagesReport,
  CodeGraphFlowRecord,
  CodeGraphRepositoryInput,
} from '@canopy/desktop-shared/types/code-graph';
import type { CodeGraphSymbolDegreeSummary } from '@canopy/desktop-shared/node/code-graph/store/graph-store';
import { getWorktreeCodeGraphDbPath } from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import {
  getMergeBase,
  isSafeGitRef,
} from '@canopy/desktop-shared/node/code-graph/git/diff';
import { type ChangedSymbol } from '@canopy/desktop-shared/node/code-graph/impact/changed-symbols';
import type { ChangeImpactHit } from '@canopy/desktop-shared/node/code-graph/impact/change-impact';
import { getBundledCodeGraphDir } from '@canopy/desktop-shared/pipelines/config-paths';
import { isRecord } from '../lib/type-guards';
import {
  CODE_GRAPH_CHANGE_DETAIL_MAX_ITEMS,
  CODE_GRAPH_DERIVED_NONE_NOTE,
  CODE_GRAPH_DERIVED_STALE_NOTE,
  CODE_GRAPH_EXPLAIN_MAX_FLOWS,
  CODE_GRAPH_FILE_SUMMARY_MAX_SYMBOLS,
  CODE_GRAPH_IMPACT_DEFAULT_DEPTH,
  CODE_GRAPH_IMPACT_DEFAULT_NODES,
  CODE_GRAPH_IMPACT_MAX_DEPTH,
  CODE_GRAPH_IMPACT_MAX_NODES,
  CODE_GRAPH_TOOL_DEFAULT_RESULTS,
  CODE_GRAPH_TOOL_MAX_RESULTS,
  CODE_GRAPH_TOOL_MINIMAL_RESULTS,
  codeGraphDerivedState,
  codeGraphQueryModeRequiresTarget,
  type CodeGraphBuildToolResult,
  type CodeGraphChangeDelta,
  type CodeGraphChangedSymbolPayload,
  type CodeGraphCommunityHit,
  type CodeGraphContextResult,
  type CodeGraphDetailLevel,
  type CodeGraphExplainRequest,
  type CodeGraphExplainResult,
  type CodeGraphFlowHit,
  type CodeGraphImpactRequest,
  type CodeGraphImpactResult,
  type CodeGraphQueryMode,
  type CodeGraphQueryRequest,
  type CodeGraphQueryResult,
  type CodeGraphRiskAssessment,
  type CodeGraphSearchRequest,
  type CodeGraphSearchResultPayload,
  type CodeGraphSymbolHit,
  type CompareChangeImpactRequest,
  type CompareChangeImpactResult,
  type DetectChangedSymbolsRequest,
  type DetectChangedSymbolsResult,
  type GetReviewContextRequest,
  type GetReviewContextResult,
  collectCodeGraphDerivedBuildWarnings,
} from '@canopy/desktop-shared/types/code-graph-tools';
import { CODE_GRAPH_AGENT_BUILD_WAIT_TIMEOUT_MS } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import {
  CODE_GRAPH_UNAVAILABLE_MESSAGE,
  isCodeGraphAvailableForWorkspace,
} from '../lib/code-graph-availability';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  CodeGraphWorkerBuildError,
  getCodeGraphSourceBuildState,
  requestCodeGraphSummaryRepair,
} from '../code-graph/build-runner';
import {
  runCodeGraphWorkerRead,
  CodeGraphReadFailureError,
  CodeGraphWorkerReadError,
  codeGraphReadFailure,
  type CodeGraphReadCall,
  type CodeGraphWorkerReadResult,
  type CodeGraphWorkerReadTask,
} from '../code-graph/read-runner';
import { runWorktreeCodeGraphBuild } from '../lib/code-graph-build-service';

export interface CodeGraphToolRuntime {
  projectId: string;
  worktreeId: string;
}

const NO_GRAPH_MESSAGE =
  'No code graph yet for this worktree — call BuildOrUpdateCodeGraph first.';
const NO_GRAPH_SUGGESTIONS = ['BuildOrUpdateCodeGraph'];

class AgentBuildWaitTimeoutError extends Error {
  public constructor() {
    super(
      'Timed out after 10 minutes waiting for the code graph build. The build is still queued or running in the background; wait and try GetCodeGraphContext or BuildOrUpdateCodeGraph again later.',
    );
    this.name = 'AgentBuildWaitTimeoutError';
  }
}

async function waitForAgentBuild(
  build: ReturnType<typeof runWorktreeCodeGraphBuild>,
  timeoutMs = CODE_GRAPH_AGENT_BUILD_WAIT_TIMEOUT_MS,
): Promise<Awaited<ReturnType<typeof runWorktreeCodeGraphBuild>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AgentBuildWaitTimeoutError()),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    // This races only the tool's wait. The original build promise remains
    // live and is deliberately never canceled when the timeout wins.
    return await Promise.race([build, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export const codeGraphRuntimeTestExports = {
  agentBuildWaitTimeoutMs: CODE_GRAPH_AGENT_BUILD_WAIT_TIMEOUT_MS,
  waitForAgentBuild,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.floor(value), max));
}

function errorMessage(error: unknown): string {
  if (
    error instanceof CodeGraphReadFailureError ||
    error instanceof CodeGraphWorkerReadError
  )
    return 'The retained Code Graph could not be read. Try again.';
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mirrors `loadWorktreeScriptOutput`'s guard style (session-runtime.ts): a
 * cowork workspace or an assistant sentinel id (App Advisor / pipeline
 * editor) is never a valid code-graph target — graphs only exist for real
 * git worktrees. Returns the agent-facing rejection message, or null when the
 * runtime is a legitimate worktree.
 */
function guardRejectionMessage(
  toolDisplayName: string,
  projectId: string,
  worktreeId: string,
): string | null {
  if (isCoworkWorkspace(projectId)) {
    return `${toolDisplayName} is only available for worktree chats, not standalone chats.`;
  }
  if (
    projectId === APP_ADVISOR_PROJECT_ID ||
    (projectId === PIPELINE_EDITOR_PROJECT_ID &&
      worktreeId === PIPELINE_EDITOR_WORKTREE_ID)
  ) {
    return `${toolDisplayName} requires a real worktree; assistant sentinel ids are not valid code graph targets.`;
  }
  return null;
}

/**
 * Enumerates the worktree's repositories via the shared repo-entries helper
 * and maps them 1:1 onto `CodeGraphRepositoryInput`. `worktree-repo-entries.ts`
 * only synthesizes a workspace-root entry for multi-repo workspaces — a plain
 * single-repo project (or any other case where it returns no entries) falls
 * back to treating the whole worktree checkout as one repository, keyed by
 * the same `WORKSPACE_ROOT_REPO_ID` sentinel multi-repo workspaces use for
 * their root.
 */
async function resolveRepositories(
  projectId: string,
  worktreePath: string,
): Promise<CodeGraphRepositoryInput[]> {
  const entries = await listWorkspaceWorktreeRepoEntries(
    projectId,
    worktreePath,
  );
  if (entries.length === 0) {
    return [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: worktreePath }];
  }
  return entries.map((entry) => ({
    repoId: entry.repoId,
    rootPath: entry.repoPath,
  }));
}

// --- Change-impact tool helpers (Task 5) -----------------------------------
//
// `DetectChangedSymbols`/`CompareChangeImpact`/`GetReviewContext` all share:
// (1) resolving which repository to analyze (optional `repoId`, default
// FIRST repository — the documented single-repo simplification for Phase 4;
// multi-repo merged impact is deferred), (2) resolving the git ref to diff
// against. SQLite mapping and `assembleChangeImpact` run in the read utility
// process after these main-process scope/path checks finish.

/**
 * Picks the repository a change-impact call analyzes: the caller's
 * `repoId` when given (validated against the worktree's actual repository
 * list), else the FIRST entry from `resolveRepositories` — the documented
 * single-repo simplification for Phase 4 (multi-repo merged impact is
 * deferred).
 */
function resolveTargetRepository(
  repositories: readonly CodeGraphRepositoryInput[],
  repoId: string | undefined,
): { repository: CodeGraphRepositoryInput } | { error: string } {
  if (repositories.length === 0) {
    // `resolveRepositories` always synthesizes at least the workspace-root
    // entry — defensive only, never expected in practice.
    return { error: 'No repositories found for this worktree.' };
  }
  if (repoId === undefined) {
    return { repository: repositories[0] };
  }
  const match = repositories.find((repository) => repository.repoId === repoId);
  if (match === undefined) {
    const known = repositories
      .map((repository) => repository.repoId)
      .join(', ');
    return {
      error: `Unknown repoId "${repoId}" for this worktree. Known repositories: ${known}.`,
    };
  }
  return { repository: match };
}

/** Names the analyzed repo in a tool's `summary` only when the worktree has
 * more than one repository — a single-repo worktree's summary stays
 * unqualified. */
function repoNameSuffix(
  repositories: readonly CodeGraphRepositoryInput[],
  repoId: string,
): string {
  return repositories.length > 1 ? ` (repo: ${repoId})` : '';
}

const DEFAULT_BASE_REF_CANDIDATES: readonly string[] = [
  'origin/develop',
  'develop',
  'origin/main',
  'main',
];

/**
 * baseRef resolution order (Task 5 contract): an explicit caller-supplied ref
 * is validated for shell/argv safety only via `isSafeGitRef` — existence is
 * NOT checked here; a safe-but-nonexistent ref surfaces as a generic
 * git-failure `error` envelope from the tool's own catch-all, not from this
 * function. With no caller-supplied ref, try a merge-base against each of the
 * repo's likely default branches in order; the first one that resolves
 * wins. If none resolve (e.g. a fresh repo with no `develop`/`main` and no
 * matching remote), fall back to the literal `'HEAD'` — a
 * working-tree-vs-HEAD diff.
 */
async function resolveBaseRef(
  rootPath: string,
  requestedBaseRef: string | undefined,
): Promise<{ baseRef: string } | { error: string }> {
  if (requestedBaseRef !== undefined) {
    if (!isSafeGitRef(requestedBaseRef)) {
      return { error: `Unsafe git ref: "${requestedBaseRef}".` };
    }
    return { baseRef: requestedBaseRef };
  }
  for (const candidate of DEFAULT_BASE_REF_CANDIDATES) {
    const mergeBase = await getMergeBase(rootPath, candidate);
    if (mergeBase !== null) {
      return { baseRef: mergeBase };
    }
  }
  return { baseRef: 'HEAD' };
}

function hasCodeGraph(runtime: CodeGraphToolRuntime): boolean {
  return existsSync(
    getWorktreeCodeGraphDbPath(runtime.projectId, runtime.worktreeId),
  );
}

async function runReadTask(
  runtime: CodeGraphToolRuntime,
  kind:
    | 'context'
    | 'query'
    | 'search'
    | 'explain'
    | 'impact-radius'
    | 'detect-changed'
    | 'compare-impact'
    | 'review-context',
  task: CodeGraphWorkerReadTask,
): Promise<CodeGraphWorkerReadResult> {
  const response = await runCodeGraphWorkerRead({
    key: `${runtime.projectId}/${runtime.worktreeId}`,
    kind,
    request: {
      dbPath: getWorktreeCodeGraphDbPath(runtime.projectId, runtime.worktreeId),
      task,
    },
  });
  if (!response.ok) throw new CodeGraphReadFailureError(response.code);
  return response.result;
}

async function runReadCalls(
  runtime: CodeGraphToolRuntime,
  kind: 'context' | 'query' | 'search' | 'explain' | 'impact-radius',
  calls: readonly CodeGraphReadCall[],
): Promise<unknown[]> {
  const result = await runReadTask(runtime, kind, { kind: 'calls', calls });
  if (result.kind !== 'calls') {
    throw new Error('Code graph read worker returned an unexpected result');
  }
  return result.value;
}

// Wire-narrows the persisted per-build custom-language report to the compact
// `CodeGraphContextResult.customLanguages` shape (loaded ids + one message
// string per diagnostic). Kept in lockstep with the identical helper in the
// CLI's `apps/desktop-cli/src/commands/code-graph.ts` (which cannot import
// this Electron-main-only file).
function toCustomLanguagesStatus(
  report: Pick<CodeGraphCustomLanguagesReport, 'loaded' | 'diagnostics'> | null,
): { loaded: string[]; warnings: string[] } | undefined {
  if (report === null) {
    return undefined;
  }
  return {
    loaded: report.loaded.map((language) => language.id),
    warnings: report.diagnostics.map((diagnostic) =>
      diagnostic.entryId === null
        ? diagnostic.message
        : `${diagnostic.entryId}: ${diagnostic.message}`,
    ),
  };
}

function toChangedSymbolPayload(
  symbol: ChangedSymbol,
): CodeGraphChangedSymbolPayload {
  return {
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    filePath: symbol.filePath,
    lineStart: symbol.lineStart,
    lineEnd: symbol.lineEnd,
    changeKind: symbol.changeKind,
  };
}

function toImpactHitPayload(
  hit: ChangeImpactHit,
): CodeGraphSymbolHit & { depth: number } {
  return {
    qualifiedName: hit.qualifiedName,
    kind: hit.kind,
    filePath: hit.filePath,
    line: null,
    depth: hit.depth,
  };
}

/** Caps a list to `standardCap` at `detailLevel: 'standard'`, or to the
 * shared `CODE_GRAPH_TOOL_MINIMAL_RESULTS` top-5 rule otherwise. */
function capList<T>(
  items: readonly T[],
  detailLevel: CodeGraphDetailLevel,
  standardCap: number,
): { items: T[]; truncated: boolean } {
  const cap =
    detailLevel === 'standard' ? standardCap : CODE_GRAPH_TOOL_MINIMAL_RESULTS;
  const capped = items.slice(0, cap);
  return { items: capped, truncated: items.length > capped.length };
}

/** Like `capList`, but for lists `assembleChangeImpact` already bounded to a
 * sane size internally: `detailLevel: 'standard'` passes the array through
 * unchanged, and only `'minimal'` imposes the shared top-5 rule on top. */
function capForMinimal<T>(
  items: readonly T[],
  detailLevel: CodeGraphDetailLevel,
): { items: T[]; truncated: boolean } {
  return capList(items, detailLevel, items.length);
}

const EMPTY_RISK: CodeGraphRiskAssessment = {
  score: 0,
  level: 'low',
  reasons: [],
  formula: '',
};

function unavailableDetect(
  message: string,
  suggestedNextTools?: string[],
): DetectChangedSymbolsResult {
  return {
    status: 'unavailable',
    summary: message,
    truncated: false,
    ...(suggestedNextTools ? { suggestedNextTools } : {}),
    baseRef: '',
    lastBuildAt: null,
    changed: [],
    unmatchedFiles: [],
  };
}

function errorDetect(message: string): DetectChangedSymbolsResult {
  return {
    status: 'error',
    summary: message,
    truncated: false,
    baseRef: '',
    lastBuildAt: null,
    changed: [],
    unmatchedFiles: [],
  };
}

function unavailableCompare(
  message: string,
  suggestedNextTools?: string[],
): CompareChangeImpactResult {
  return {
    status: 'unavailable',
    summary: message,
    truncated: false,
    ...(suggestedNextTools ? { suggestedNextTools } : {}),
    baseRef: '',
    lastBuildAt: null,
    delta: { addedCount: 0, removedCount: 0, signatureChangedCount: 0 },
    impacted: [],
    impactedTests: [],
    risk: EMPTY_RISK,
  };
}

function errorCompare(message: string): CompareChangeImpactResult {
  return {
    status: 'error',
    summary: message,
    truncated: false,
    baseRef: '',
    lastBuildAt: null,
    delta: { addedCount: 0, removedCount: 0, signatureChangedCount: 0 },
    impacted: [],
    impactedTests: [],
    risk: EMPTY_RISK,
  };
}

function unavailableReview(
  message: string,
  suggestedNextTools?: string[],
): GetReviewContextResult {
  return {
    status: 'unavailable',
    summary: message,
    truncated: false,
    ...(suggestedNextTools ? { suggestedNextTools } : {}),
    baseRef: '',
    lastBuildAt: null,
    changedSymbols: [],
    impactedFiles: [],
    impactedTests: [],
    testGaps: [],
    reviewPriorities: [],
    risk: EMPTY_RISK,
  };
}

function errorReview(message: string): GetReviewContextResult {
  return {
    status: 'error',
    summary: message,
    truncated: false,
    baseRef: '',
    lastBuildAt: null,
    changedSymbols: [],
    impactedFiles: [],
    impactedTests: [],
    testGaps: [],
    reviewPriorities: [],
    risk: EMPTY_RISK,
  };
}

function resolveDetailLimit(
  detailLevel: CodeGraphDetailLevel,
  requestedLimit: number | undefined,
): number {
  if (detailLevel === 'standard') {
    return clamp(
      requestedLimit ?? CODE_GRAPH_TOOL_DEFAULT_RESULTS,
      1,
      CODE_GRAPH_TOOL_MAX_RESULTS,
    );
  }
  return CODE_GRAPH_TOOL_MINIMAL_RESULTS;
}

// Appended to the 'ipc-channel' resolved-channel summary when
// `getIpcChannel`'s `unresolvedCallSiteCount` is nonzero: the same-repo-
// duplicate aftermath resolve/ipc-resolver.ts leaves behind (see that
// module's "Ambiguous" branch and `countUnresolvedIpcEdgesForKey` in
// queries.ts) means resolving one of the duplicate declarations by qualified
// name can still show an incomplete handlers/invokers list. Kept in lockstep
// with the identical helper in the desktop CLI's `code-graph.ts` (that file
// cannot import this one — see its own `fetchHitsForMode` comment for why).
function formatUnresolvedIpcCallSiteNote(
  unresolvedCallSiteCount: number,
): string {
  if (unresolvedCallSiteCount === 0) {
    return '';
  }
  return ` ${unresolvedCallSiteCount} call site(s) remain unbound due to an ambiguous duplicate declaration.`;
}

// Summary for the 'ipc-channel' ambiguous outcome. Says WHICH lookup
// produced the multiple matches -- the bare-key lookup or the signature
// (string-value) fallback (`getIpcChannel`'s `ambiguousLookup`) -- instead of
// always claiming the KEY was ambiguous when the caller actually passed a
// channel's string value. Kept in lockstep with the identical helper in the
// desktop CLI's `code-graph.ts` (that file cannot import this one -- see its
// own `fetchHitsForMode` comment for why).
function formatAmbiguousIpcChannelSummary(
  target: string,
  ambiguousCount: number,
  ambiguousLookup: 'key' | 'signature-value' | undefined,
): string {
  const matched =
    ambiguousLookup === 'signature-value'
      ? { noun: 'value', clause: 'declare this string value' }
      : { noun: 'key', clause: 'declare this key' };
  return `Ambiguous channel ${matched.noun} "${target}": ${ambiguousCount} channel(s) ${matched.clause}; retry with a qualified name (path/to/file.ts::ipc.<key>) and repoId to disambiguate.`;
}

function fileHit(filePath: string): CodeGraphSymbolHit {
  return { qualifiedName: filePath, kind: 'file', filePath, line: null };
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isArrayOf<T>(
  value: unknown,
  guard: (entry: unknown) => entry is T,
): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

function expectWorkerValue<T>(
  value: unknown,
  guard: (entry: unknown) => entry is T,
  description: string,
): T {
  if (!guard(value)) {
    throw new Error(`Code graph read worker returned invalid ${description}`);
  }
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return isArrayOf(
    value,
    (entry): entry is string => typeof entry === 'string',
  );
}

function isCodeGraphSymbolHit(value: unknown): value is CodeGraphSymbolHit {
  return (
    isRecord(value) &&
    typeof value.qualifiedName === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.filePath === 'string' &&
    isNumberOrNull(value.line)
  );
}

function isCommunityRecord(value: unknown): value is CodeGraphCommunityRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    typeof value.size === 'number' &&
    typeof value.cohesion === 'number'
  );
}

function isFlowRecord(value: unknown): value is CodeGraphFlowRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.criticality === 'number' &&
    typeof value.symbolCount === 'number' &&
    typeof value.fileSpread === 'number'
  );
}

type FileSummaryResult = NonNullable<CodeGraphQueryResult['fileSummary']>;

function isFileSummaryResult(value: unknown): value is FileSummaryResult {
  return (
    isRecord(value) &&
    typeof value.file === 'string' &&
    isArrayOf(
      value.symbols,
      (entry): entry is FileSummaryResult['symbols'][number] =>
        isRecord(entry) &&
        typeof entry.qualifiedName === 'string' &&
        typeof entry.kind === 'string' &&
        typeof entry.exported === 'boolean',
    ) &&
    isStringArray(value.imports) &&
    typeof value.importerCount === 'number'
  );
}

type ScriptResult = NonNullable<CodeGraphQueryResult['scripts']>[number];

function isScriptResult(value: unknown): value is ScriptResult {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    (value.command === null || typeof value.command === 'string')
  );
}

type IpcChannelResult = NonNullable<CodeGraphQueryResult['ipcChannel']> & {
  ambiguousLookup?: 'key' | 'signature-value';
};

function isIpcChannelResult(value: unknown): value is IpcChannelResult {
  const channelValid =
    isRecord(value) &&
    (value.channel === null ||
      (isRecord(value.channel) &&
        typeof value.channel.qualifiedName === 'string' &&
        typeof value.channel.filePath === 'string' &&
        (value.channel.signature === null ||
          typeof value.channel.signature === 'string') &&
        typeof value.channel.line === 'number'));
  return (
    channelValid &&
    isArrayOf(value.handlers, isCodeGraphSymbolHit) &&
    isArrayOf(value.invokers, isCodeGraphSymbolHit) &&
    typeof value.ambiguousCount === 'number' &&
    typeof value.unresolvedCallSiteCount === 'number' &&
    (value.ambiguousLookup === undefined ||
      value.ambiguousLookup === 'key' ||
      value.ambiguousLookup === 'signature-value')
  );
}

function isDerivedStats(
  value: unknown,
): value is { communityCount: number; flowCount: number; stale?: true } {
  return (
    isRecord(value) &&
    typeof value.communityCount === 'number' &&
    typeof value.flowCount === 'number' &&
    (value.stale === undefined || value.stale === true)
  );
}

/**
 * The honesty note for a communities/flows result: the stored analysis lags
 * the latest build (`stale`), or none exists for the repository (`none`).
 */
function derivedResultNote(stats: { stale?: true }, count: number): string {
  if (stats.stale === true) return ` (${CODE_GRAPH_DERIVED_STALE_NOTE})`;
  return count === 0 ? ` (${CODE_GRAPH_DERIVED_NONE_NOTE})` : '';
}

/** Summary suffix when change impact's flow/community inputs are stale. */
function staleRiskInputsNote(risk: {
  staleInputs?: readonly string[];
}): string {
  return risk.staleInputs !== undefined && risk.staleInputs.length > 0
    ? ' (flow/community inputs stale)'
    : '';
}

function isSymbolDegreeSummary(
  value: unknown,
): value is CodeGraphSymbolDegreeSummary {
  return (
    isRecord(value) &&
    typeof value.qualifiedName === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.degree === 'number'
  );
}

function isSearchResult(value: unknown): value is {
  qualifiedName: string;
  kind: string;
  filePath: string;
  lineStart: number;
} {
  return (
    isRecord(value) &&
    typeof value.qualifiedName === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.lineStart === 'number'
  );
}

type ExplainSymbol = NonNullable<CodeGraphExplainResult['symbol']>;

function isExplainSymbol(value: unknown): value is ExplainSymbol {
  return (
    isRecord(value) &&
    typeof value.qualifiedName === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.lineStart === 'number' &&
    typeof value.lineEnd === 'number' &&
    (value.signature === null || typeof value.signature === 'string') &&
    typeof value.exported === 'boolean'
  );
}

function isImpactEntry(value: unknown): value is {
  qualifiedName: string;
  kind: string;
  filePath: string;
  depth: number;
} {
  return (
    isRecord(value) &&
    typeof value.qualifiedName === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.depth === 'number'
  );
}

function isDocHitEntry(value: unknown): value is Parameters<typeof docHit>[0] {
  return (
    isRecord(value) &&
    typeof value.qualifiedName === 'string' &&
    typeof value.filePath === 'string' &&
    isNumberOrNull(value.line)
  );
}

function isRationaleHitEntry(
  value: unknown,
): value is Parameters<typeof rationaleHit>[0] {
  return (
    isRecord(value) &&
    typeof value.qualifiedName === 'string' &&
    typeof value.marker === 'string' &&
    (value.text === null || typeof value.text === 'string') &&
    typeof value.filePath === 'string' &&
    isNumberOrNull(value.line)
  );
}

// docs-for/rationale-for reuse the shared `hits` shape with `kind` conveying
// the mode's flavor. Both keep `qualifiedName` a REAL, chainable identifier
// (the doc_section/file symbol's qualified name; the rationale symbol's
// `${path}::rationale.L${line}` name) — the same invariant every other mode
// upholds — and rationale hits additionally carry the human-readable
// marker+text in the optional `label` field.
function docHit(entry: {
  qualifiedName: string;
  filePath: string;
  line: number | null;
}): CodeGraphSymbolHit {
  return {
    qualifiedName: entry.qualifiedName,
    kind: 'doc_section',
    filePath: entry.filePath,
    line: entry.line,
  };
}

function rationaleHit(entry: {
  qualifiedName: string;
  marker: string;
  text: string | null;
  filePath: string;
  line: number | null;
}): CodeGraphSymbolHit {
  return {
    qualifiedName: entry.qualifiedName,
    kind: 'rationale',
    filePath: entry.filePath,
    line: entry.line,
    label:
      entry.text === null ? entry.marker : `${entry.marker}: ${entry.text}`,
  };
}

// Wire-narrows a full `CodeGraphCommunityRecord`/`CodeGraphFlowRecord` down
// to the `CodeGraphCommunityHit`/`CodeGraphFlowHit` shapes — shared by the
// 'communities'/'flows' query modes, ExplainCodeSymbol's enrichment, and
// GetCodeGraphContext's `topCommunities`.
function communityHit(record: CodeGraphCommunityRecord): CodeGraphCommunityHit {
  return {
    id: record.id,
    label: record.label,
    size: record.size,
    cohesion: record.cohesion,
  };
}

function flowHit(record: CodeGraphFlowRecord): CodeGraphFlowHit {
  return {
    id: record.id,
    name: record.name,
    criticality: record.criticality,
    symbolCount: record.symbolCount,
    fileSpread: record.fileSpread,
  };
}

// 'hubs' reuses the shared `CodeGraphSymbolHit` shape (like every other hit
// flavor here) with total edge degree carried in `label`, since
// `CodeGraphSymbolHit` has no dedicated numeric field for it.
function hubHit(entry: CodeGraphSymbolDegreeSummary): CodeGraphSymbolHit {
  return {
    qualifiedName: entry.qualifiedName,
    kind: entry.kind,
    filePath: entry.filePath,
    line: null,
    label: `degree ${entry.degree}`,
  };
}

// Fetch cap used to determine the TRUE result count for 'communities'/
// 'flows'/'hubs' before display-capping and slicing — the store's own hard
// technical ceiling (`boundedListLimit` in graph-store.ts), the same value
// the risk formula's flow-participation term uses for the same "get
// everything, then decide what's truncated" reason.
const CODE_GRAPH_DERIVED_QUERY_FETCH_CAP = 1000;

function readCallForMode(
  mode: Exclude<
    CodeGraphQueryMode,
    | 'call-path'
    | 'relationship-path'
    | 'file-summary'
    | 'scripts-for-file'
    | 'ipc-channel'
    | 'communities'
    | 'flows'
    | 'hubs'
  >,
  target: string,
  repoId: string | undefined,
): CodeGraphReadCall {
  switch (mode) {
    case 'callers':
    case 'callees':
    case 'imports':
    case 'children':
      return { method: mode, target, ...(repoId ? { repoId } : {}) };
    case 'importers':
    case 'tests-for':
    case 'docs-for':
    case 'rationale-for':
      return { method: mode, target, ...(repoId ? { repoId } : {}) };
  }
}

function hitsForMode(
  mode: Exclude<
    CodeGraphQueryMode,
    | 'call-path'
    | 'relationship-path'
    | 'file-summary'
    | 'scripts-for-file'
    | 'ipc-channel'
    | 'communities'
    | 'flows'
    | 'hubs'
  >,
  raw: unknown,
): CodeGraphSymbolHit[] {
  if (mode === 'importers' || mode === 'tests-for') {
    return expectWorkerValue(raw, isStringArray, `${mode} results`).map(
      fileHit,
    );
  }
  if (mode === 'docs-for') {
    return expectWorkerValue(
      raw,
      (value): value is Parameters<typeof docHit>[0][] =>
        isArrayOf(value, isDocHitEntry),
      'docs results',
    ).map(docHit);
  }
  if (mode === 'rationale-for') {
    return expectWorkerValue(
      raw,
      (value): value is Parameters<typeof rationaleHit>[0][] =>
        isArrayOf(value, isRationaleHitEntry),
      'rationale results',
    ).map(rationaleHit);
  }
  return expectWorkerValue(
    raw,
    (value): value is CodeGraphSymbolHit[] =>
      isArrayOf(value, isCodeGraphSymbolHit),
    `${mode} results`,
  );
}

function unavailableContext(
  message: string,
  suggestedNextTools?: string[],
): CodeGraphContextResult {
  return {
    status: 'unavailable',
    snapshotState: 'missing',
    buildState: 'idle',
    summary: `${message} Counts are unmeasured.`,
    truncated: false,
    ...(suggestedNextTools ? { suggestedNextTools } : {}),
    hasGraph: false,
    lastBuildAt: null,
    fileCount: 0,
    symbolCount: 0,
    edgeCount: 0,
    unresolvedEdgeCount: 0,
    filesWithErrors: 0,
    repositories: [],
    communityCount: 0,
    flowCount: 0,
    derivedAt: null,
    topCommunities: [],
  };
}

function pendingContext(
  runtime: CodeGraphToolRuntime,
  lastBuildAt: number | null = null,
): CodeGraphContextResult {
  const buildState = getCodeGraphSourceBuildState(
    `${runtime.projectId}/${runtime.worktreeId}`,
  );
  return {
    ...unavailableContext(
      'The retained Code Graph summary is not ready. Try again.',
    ),
    status: 'ok',
    snapshotState: 'summary-pending',
    buildState,
    hasGraph: hasCodeGraph(runtime),
    lastBuildAt,
    suggestedNextTools: ['GetCodeGraphContext', 'BuildOrUpdateCodeGraph'],
  };
}

function unavailableBuild(message: string): CodeGraphBuildToolResult {
  return {
    status: 'unavailable',
    summary: message,
    truncated: false,
    filesScanned: 0,
    filesParsed: 0,
    filesUnchanged: 0,
    filesRemoved: 0,
    filesSkipped: 0,
    parseFailures: 0,
    durationMs: 0,
  };
}

function errorBuild(message: string): CodeGraphBuildToolResult {
  return {
    status: 'error',
    summary: message,
    truncated: false,
    filesScanned: 0,
    filesParsed: 0,
    filesUnchanged: 0,
    filesRemoved: 0,
    filesSkipped: 0,
    parseFailures: 0,
    durationMs: 0,
  };
}

function unavailableQuery(
  mode: CodeGraphQueryMode,
  target: string,
  message: string,
  suggestedNextTools?: string[],
): CodeGraphQueryResult {
  return {
    status: 'unavailable',
    summary: message,
    truncated: false,
    ...(suggestedNextTools ? { suggestedNextTools } : {}),
    mode,
    target,
    hits: [],
  };
}

function unavailableSearch(
  message: string,
  suggestedNextTools?: string[],
): CodeGraphSearchResultPayload {
  return {
    status: 'unavailable',
    summary: message,
    truncated: false,
    ...(suggestedNextTools ? { suggestedNextTools } : {}),
    hits: [],
  };
}

function unavailableExplain(
  message: string,
  suggestedNextTools?: string[],
): CodeGraphExplainResult {
  return {
    status: 'unavailable',
    summary: message,
    truncated: false,
    ...(suggestedNextTools ? { suggestedNextTools } : {}),
    callers: [],
    callees: [],
    tests: [],
    community: null,
    flows: [],
  };
}

function unavailableImpact(
  message: string,
  suggestedNextTools?: string[],
): CodeGraphImpactResult {
  return {
    status: 'unavailable',
    summary: message,
    truncated: false,
    ...(suggestedNextTools ? { suggestedNextTools } : {}),
    impacted: [],
    maxDepth: 0,
  };
}

/**
 * The ~100-token discovery entry point: counts + freshness + suggested next
 * tools, never a symbol list. Like every other tool, this still follows the
 * "never auto-build on read" rule — when no graph exists yet it reports
 * `hasGraph: false` with an `unavailable` envelope instead of building one.
 */
export async function getCodeGraphContext(
  runtime: CodeGraphToolRuntime,
): Promise<CodeGraphContextResult> {
  const rejection = guardRejectionMessage(
    'GetCodeGraphContext',
    runtime.projectId,
    runtime.worktreeId,
  );
  if (rejection !== null) return unavailableContext(rejection);
  const key = `${runtime.projectId}/${runtime.worktreeId}`;
  if (!hasCodeGraph(runtime)) {
    const buildState = getCodeGraphSourceBuildState(key);
    return {
      ...unavailableContext(NO_GRAPH_MESSAGE, NO_GRAPH_SUGGESTIONS),
      buildState,
    };
  }
  try {
    const result = await runReadTask(runtime, 'context', {
      kind: 'readonly-summary',
    });
    if (result.kind !== 'readonly-summary')
      throw new CodeGraphReadFailureError('invalid-response');
    const read = result.value;
    if (read.state === 'error')
      throw new CodeGraphReadFailureError(
        read.classification === 'busy' ? 'busy' : 'database-error',
      );
    if (read.state === 'missing')
      return {
        ...unavailableContext(NO_GRAPH_MESSAGE, NO_GRAPH_SUGGESTIONS),
        buildState: getCodeGraphSourceBuildState(key),
      };
    if (read.state === 'pending' && read.reason === 'build-incomplete') {
      // No build or seed has committed, so a repair has nothing to publish.
      // Unless a build is already under way, only a build makes this ready.
      const pending = pendingContext(runtime, read.observed.lastBuildAt);
      return pending.buildState === 'idle'
        ? {
            ...pending,
            summary:
              'The Code Graph has no completed build. Run BuildOrUpdateCodeGraph. Counts are unmeasured.',
            suggestedNextTools: ['BuildOrUpdateCodeGraph'],
            diagnostics: read.diagnostics,
          }
        : { ...pending, diagnostics: read.diagnostics };
    }
    if (read.state === 'pending') {
      // Maintenance is independent of this bounded interactive read; a waiter cannot cancel it.
      void requestCodeGraphSummaryRepair({
        key,
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
        dbPath: getWorktreeCodeGraphDbPath(
          runtime.projectId,
          runtime.worktreeId,
        ),
      }).catch(() => undefined);
      return {
        ...pendingContext(runtime, read.observed.lastBuildAt),
        diagnostics: read.diagnostics,
      };
    }
    const projection = read.projection;
    const counts = projection.totals;
    const customLanguages = toCustomLanguagesStatus(projection.customLanguages);
    const derivedStale =
      codeGraphDerivedState({
        lastBuildAt: projection.lastBuildAt,
        derivedAt: projection.derivedAt,
        communityCount: counts.communityCount,
        flowCount: counts.flowCount,
      }) === 'stale';
    return {
      status: 'ok',
      snapshotState: 'readable',
      buildState: getCodeGraphSourceBuildState(key),
      summary: `Code graph: ${counts.fileCount} file(s), ${counts.symbolCount} symbol(s), ${counts.edgeCount} edge(s)${counts.contextUnresolvedEdgeCount > 0 ? `, ${counts.contextUnresolvedEdgeCount} unresolved` : ''}${derivedStale ? ` (${CODE_GRAPH_DERIVED_STALE_NOTE})` : ''}.`,
      truncated: false,
      suggestedNextTools: ['QueryCodeGraph', 'SearchCodeGraph'],
      hasGraph: true,
      lastBuildAt: projection.lastBuildAt,
      ...(customLanguages === undefined ? {} : { customLanguages }),
      fileCount: counts.fileCount,
      symbolCount: counts.symbolCount,
      edgeCount: counts.edgeCount,
      unresolvedEdgeCount: counts.contextUnresolvedEdgeCount,
      filesWithErrors: counts.contextFilesWithErrors,
      repositories: projection.repositories.map((repo) => ({
        repoId: repo.repoId,
        fileCount: repo.counts.fileCount,
      })),
      communityCount: counts.communityCount,
      flowCount: counts.flowCount,
      derivedAt: projection.derivedAt,
      ...(derivedStale ? { derivedState: 'stale' as const } : {}),
      diagnostics: read.diagnostics,
      topCommunities: projection.topCommunities.map(
        ({ id, label, size, cohesion }) => ({ id, label, size, cohesion }),
      ),
    };
  } catch (error) {
    // A queued source refresh, drain or maintenance never rewrites a genuine read rejection.
    return {
      ...unavailableContext(
        'The retained Code Graph could not be read. Try again.',
      ),
      status: 'error',
      snapshotState: 'read-error',
      buildState: getCodeGraphSourceBuildState(key),
      readFailure: codeGraphReadFailure(error),
      hasGraph: hasCodeGraph(runtime),
    };
  }
}

/**
 * The only tool exempt from the "no code graph yet" gate — it always
 * attempts to build (a fresh graph when none exists, an incremental update
 * otherwise).
 */
export async function buildOrUpdateCodeGraph(
  runtime: CodeGraphToolRuntime,
): Promise<CodeGraphBuildToolResult> {
  // Feature gate (defense-in-depth): makes an OFF flip effective for a tool
  // call even from an already-running Codex session whose specs were baked in
  // while the flag was on. Checked before any work so no graph builds.
  if (!isCodeGraphAvailableForWorkspace(runtime.projectId)) {
    return unavailableBuild(CODE_GRAPH_UNAVAILABLE_MESSAGE);
  }
  const rejection = guardRejectionMessage(
    'BuildOrUpdateCodeGraph',
    runtime.projectId,
    runtime.worktreeId,
  );
  if (rejection !== null) {
    return unavailableBuild(rejection);
  }

  try {
    // Builds and request-time reads both run in utility processes. WAL keeps
    // a read worker's snapshot consistent while this build commits, without
    // putting synchronous SQLite or graph traversal on Electron main.
    const response = await waitForAgentBuild(
      runWorktreeCodeGraphBuild({
        projectId: runtime.projectId,
        worktreeId: runtime.worktreeId,
        reason: 'tool-request',
        options: { verifyContent: true },
      }),
    );
    if (!response.ok) {
      if (response.message === CODE_GRAPH_UNAVAILABLE_MESSAGE) {
        return unavailableBuild(CODE_GRAPH_UNAVAILABLE_MESSAGE);
      }
      return errorBuild(`Failed to build code graph: ${response.message}`);
    }

    const result = response.result;
    const buildResult: CodeGraphBuildToolResult = {
      status: 'ok',
      summary: `Built code graph: ${result.filesParsed} parsed, ${result.filesUnchanged} unchanged, ${result.filesRemoved} removed${result.parseFailures > 0 ? `, ${result.parseFailures} parse failure(s)` : ''} in ${result.durationMs}ms.${result.derivedDeferred === true ? ' Derived analysis (communities, flows) is still running; until it completes, those results are reported as stale.' : ''}`,
      truncated: false,
      suggestedNextTools: ['GetCodeGraphContext', 'QueryCodeGraph'],
      filesScanned: result.filesScanned,
      filesParsed: result.filesParsed,
      filesUnchanged: result.filesUnchanged,
      filesRemoved: result.filesRemoved,
      filesSkipped: result.filesSkipped,
      parseFailures: result.parseFailures,
      durationMs: result.durationMs,
    };
    if (result.customLanguages !== null) {
      buildResult.customLanguageWarnings =
        result.customLanguages.diagnostics.map((diagnostic) =>
          diagnostic.entryId === null
            ? diagnostic.message
            : `${diagnostic.entryId}: ${diagnostic.message}`,
        );
    }
    if (result.derived.length > 0) {
      buildResult.derivedWarnings = collectCodeGraphDerivedBuildWarnings(
        result.derived,
      );
    }
    return buildResult;
  } catch (error) {
    if (error instanceof AgentBuildWaitTimeoutError) {
      return errorBuild(error.message);
    }
    if (error instanceof CodeGraphWorkerBuildError) {
      if (error.reason === 'unavailable') {
        return unavailableBuild(CODE_GRAPH_UNAVAILABLE_MESSAGE);
      }
      // Names the cause (timeout / canceled / worker-exit / spawn-failed /
      // post-failed / malformed-response) via `error.reason` so the agent
      // (and anyone reading the audit trail) can distinguish e.g. a
      // user-driven cancel from a genuine build failure.
      return errorBuild(
        `Failed to build code graph (${error.reason}): ${error.message}`,
      );
    }
    return errorBuild(`Failed to build code graph: ${errorMessage(error)}`);
  }
}

function isPathResult(value: unknown): value is CodeGraphPathResult {
  return (
    isRecord(value) &&
    [
      'found',
      'no-path',
      'budget-exhausted',
      'endpoint-not-found',
      'ambiguous-endpoint',
    ].includes(String(value.status)) &&
    typeof value.visitedNodes === 'number' &&
    typeof value.visitedEdges === 'number' &&
    isRecord(value.limits) &&
    typeof value.limits.maxDepth === 'number' &&
    typeof value.limits.maxNodes === 'number' &&
    typeof value.limits.maxEdges === 'number' &&
    Array.isArray(value.hops) &&
    value.hops.every(
      (hop) =>
        isRecord(hop) &&
        typeof hop.source === 'string' &&
        typeof hop.target === 'string' &&
        typeof hop.kind === 'string' &&
        (hop.direction === 'forward' || hop.direction === 'reverse') &&
        typeof hop.filePath === 'string' &&
        (hop.line === null || typeof hop.line === 'number') &&
        typeof hop.confidenceTier === 'string' &&
        typeof hop.confidenceScore === 'number' &&
        (hop.resolverId === null || typeof hop.resolverId === 'string') &&
        typeof hop.evidence === 'string' &&
        typeof hop.evidenceTruncated === 'boolean',
    )
  );
}

export async function queryCodeGraph(
  runtime: CodeGraphToolRuntime,
  request: CodeGraphQueryRequest,
): Promise<CodeGraphQueryResult> {
  // 'communities'/'hubs' ignore target entirely and 'flows' treats it as an
  // optional symbol filter (see CodeGraphQueryRequest.target's comment), so
  // an omitted target is normalized to '' once here rather than threaded
  // through every branch below as `string | undefined`.
  const target = request.target ?? '';

  const rejection = guardRejectionMessage(
    'QueryCodeGraph',
    runtime.projectId,
    runtime.worktreeId,
  );
  if (rejection !== null) {
    return unavailableQuery(request.mode, target, rejection);
  }

  // Per-mode target requirement (semantic, not schema-level — see
  // codeGraphQueryModeRequiresTarget): a target-requiring mode called
  // without a target must fail loudly as a missing argument. A silent 0-hit
  // "ok" here would misread as "no callers/importers/..." — an honesty
  // regression on an agent-facing tool. Checked before the no-graph gate so
  // the caller error is reported precisely even when no graph exists yet.
  if (target === '' && codeGraphQueryModeRequiresTarget(request.mode)) {
    return {
      status: 'error',
      summary: `QueryCodeGraph mode "${request.mode}" requires a target (symbol qualified name or file path); none was provided.`,
      truncated: false,
      mode: request.mode,
      target,
      hits: [],
    };
  }

  if (
    (request.mode === 'call-path' || request.mode === 'relationship-path') &&
    !request.to?.trim()
  ) {
    return {
      status: 'error',
      summary: 'Path queries require a second endpoint: to.',
      truncated: false,
      mode: request.mode,
      target,
      hits: [],
    };
  }

  if (!hasCodeGraph(runtime)) {
    return unavailableQuery(
      request.mode,
      target,
      NO_GRAPH_MESSAGE,
      NO_GRAPH_SUGGESTIONS,
    );
  }

  try {
    if (request.mode === 'call-path' || request.mode === 'relationship-path') {
      const values = await runReadCalls(runtime, 'query', [
        {
          method: 'relationship-path',
          options: {
            mode: request.mode,
            target,
            to: request.to ?? '',
            repoId: request.repoId,
            maxDepth: request.maxDepth,
            maxNodes: request.maxNodes,
          },
        },
      ]);
      const path = expectWorkerValue(
        values[0],
        isPathResult,
        'relationship path',
      );
      return {
        status: 'ok',
        summary: `${request.mode}: ${path.status}; ${path.hops.length} hop(s), ${path.visitedNodes} nodes and ${path.visitedEdges} edges examined.`,
        truncated:
          path.status === 'budget-exhausted' ||
          path.hops.some((hop) => hop.evidenceTruncated),
        mode: request.mode,
        target,
        hits: [],
        path,
      };
    }
    const detailLevel: CodeGraphDetailLevel = request.detailLevel ?? 'minimal';
    let calls: CodeGraphReadCall[];
    switch (request.mode) {
      case 'file-summary':
      case 'scripts-for-file':
      case 'ipc-channel':
        calls = [
          {
            method: request.mode,
            target,
            ...(request.repoId ? { repoId: request.repoId } : {}),
          },
        ];
        break;
      case 'communities':
        calls = [
          {
            method: 'derived-stats',
            ...(request.repoId ? { repoId: request.repoId } : {}),
          },
          {
            method: 'communities',
            limit: CODE_GRAPH_DERIVED_QUERY_FETCH_CAP,
            ...(request.repoId ? { repoId: request.repoId } : {}),
          },
        ];
        break;
      case 'flows':
        calls = [
          {
            method: 'derived-stats',
            ...(request.repoId ? { repoId: request.repoId } : {}),
          },
          target === ''
            ? {
                method: 'flows',
                limit: CODE_GRAPH_DERIVED_QUERY_FETCH_CAP,
                ...(request.repoId ? { repoId: request.repoId } : {}),
              }
            : {
                method: 'flows-for-symbol',
                target,
                limit: CODE_GRAPH_DERIVED_QUERY_FETCH_CAP,
                ...(request.repoId ? { repoId: request.repoId } : {}),
              },
        ];
        break;
      case 'hubs':
        calls = [
          {
            method: 'hubs',
            limit: CODE_GRAPH_DERIVED_QUERY_FETCH_CAP,
            ...(request.repoId ? { repoId: request.repoId } : {}),
          },
        ];
        break;
      default:
        calls = [readCallForMode(request.mode, target, request.repoId)];
    }
    const rawResults = await runReadCalls(runtime, 'query', calls);

    if (request.mode === 'file-summary') {
      const rawFileSummary = rawResults[0];
      const fileSummary =
        rawFileSummary === null
          ? null
          : expectWorkerValue(
              rawFileSummary,
              isFileSummaryResult,
              'file summary',
            );
      if (fileSummary === null) {
        return {
          status: 'ok',
          summary: `File not found in code graph: ${target}`,
          truncated: false,
          mode: request.mode,
          target,
          hits: [],
        };
      }
      const totalSymbols = fileSummary.symbols.length;
      const cappedSymbols = fileSummary.symbols.slice(
        0,
        CODE_GRAPH_FILE_SUMMARY_MAX_SYMBOLS,
      );
      const truncated = totalSymbols > cappedSymbols.length;
      return {
        status: 'ok',
        summary: `${fileSummary.file}: ${totalSymbols} symbol(s), ${fileSummary.imports.length} import(s), ${fileSummary.importerCount} importer(s).`,
        truncated,
        ...(truncated ? { suggestedNextTools: ['QueryCodeGraph'] } : {}),
        mode: request.mode,
        target,
        hits: [],
        fileSummary: {
          file: fileSummary.file,
          symbols: cappedSymbols,
          imports: fileSummary.imports,
          importerCount: fileSummary.importerCount,
        },
      };
    }

    if (request.mode === 'scripts-for-file') {
      const rawScripts = expectWorkerValue(
        rawResults[0],
        (value): value is ScriptResult[] => isArrayOf(value, isScriptResult),
        'script results',
      );
      const limit = resolveDetailLimit(detailLevel, request.limit);
      const scripts = rawScripts.slice(0, limit);
      const truncated = rawScripts.length > scripts.length;
      return {
        status: 'ok',
        summary: `${target}: ${rawScripts.length} script(s)${truncated ? `, showing ${scripts.length}` : ''}.`,
        truncated,
        ...(truncated ? { suggestedNextTools: ['QueryCodeGraph'] } : {}),
        mode: request.mode,
        target,
        hits: [],
        scripts,
      };
    }

    if (request.mode === 'ipc-channel') {
      const result = expectWorkerValue(
        rawResults[0],
        isIpcChannelResult,
        'IPC channel result',
      );
      if (result.ambiguousCount > 0) {
        return {
          status: 'ok',
          summary: formatAmbiguousIpcChannelSummary(
            target,
            result.ambiguousCount,
            result.ambiguousLookup,
          ),
          truncated: false,
          mode: request.mode,
          target,
          hits: [],
          ipcChannel: {
            channel: null,
            handlers: [],
            invokers: [],
            ambiguousCount: result.ambiguousCount,
            unresolvedCallSiteCount: 0,
          },
        };
      }
      if (result.channel === null) {
        return {
          status: 'ok',
          summary: `IPC channel not found in code graph: ${target}`,
          truncated: false,
          mode: request.mode,
          target,
          hits: [],
          ipcChannel: {
            channel: null,
            handlers: [],
            invokers: [],
            ambiguousCount: 0,
            unresolvedCallSiteCount: 0,
          },
        };
      }
      const ipcLimit = resolveDetailLimit(detailLevel, request.limit);
      const handlers = result.handlers.slice(0, ipcLimit);
      const invokers = result.invokers.slice(0, ipcLimit);
      const ipcTruncated =
        result.handlers.length > handlers.length ||
        result.invokers.length > invokers.length;
      return {
        status: 'ok',
        summary:
          `${result.channel.qualifiedName}: ${result.handlers.length} handler(s), ${result.invokers.length} invoker(s)` +
          `${ipcTruncated ? `, showing ${handlers.length}/${invokers.length}` : ''}.` +
          formatUnresolvedIpcCallSiteNote(result.unresolvedCallSiteCount),
        truncated: ipcTruncated,
        ...(ipcTruncated ? { suggestedNextTools: ['QueryCodeGraph'] } : {}),
        mode: request.mode,
        target,
        hits: [],
        ipcChannel: {
          channel: result.channel,
          handlers,
          invokers,
          ambiguousCount: 0,
          unresolvedCallSiteCount: result.unresolvedCallSiteCount,
        },
      };
    }

    if (request.mode === 'communities') {
      const derivedStats = expectWorkerValue(
        rawResults[0],
        isDerivedStats,
        'derived stats',
      );
      const rawCommunities = expectWorkerValue(
        rawResults[1],
        (value): value is CodeGraphCommunityRecord[] =>
          isArrayOf(value, isCommunityRecord),
        'community results',
      );
      const limit = resolveDetailLimit(detailLevel, request.limit);
      const capped = rawCommunities.slice(0, limit);
      const truncated = rawCommunities.length > capped.length;
      const derivedNote = derivedResultNote(
        derivedStats,
        derivedStats.communityCount,
      );
      return {
        status: 'ok',
        summary: `communities: ${rawCommunities.length} result(s)${truncated ? `, showing ${capped.length}` : ''}.${derivedNote}`,
        truncated,
        ...(truncated ? { suggestedNextTools: ['QueryCodeGraph'] } : {}),
        mode: request.mode,
        target,
        hits: [],
        communities: capped.map(communityHit),
      };
    }

    if (request.mode === 'flows') {
      const derivedStats = expectWorkerValue(
        rawResults[0],
        isDerivedStats,
        'derived stats',
      );
      const rawFlows = expectWorkerValue(
        rawResults[1],
        (value): value is CodeGraphFlowRecord[] =>
          isArrayOf(value, isFlowRecord),
        'flow results',
      );
      const limit = resolveDetailLimit(detailLevel, request.limit);
      const capped = rawFlows.slice(0, limit);
      const truncated = rawFlows.length > capped.length;
      const derivedNote = derivedResultNote(
        derivedStats,
        derivedStats.flowCount,
      );
      return {
        status: 'ok',
        summary: `flows${target === '' ? '' : ` for "${target}"`}: ${rawFlows.length} result(s)${truncated ? `, showing ${capped.length}` : ''}.${derivedNote}`,
        truncated,
        ...(truncated ? { suggestedNextTools: ['QueryCodeGraph'] } : {}),
        mode: request.mode,
        target,
        hits: [],
        flows: capped.map(flowHit),
      };
    }

    if (request.mode === 'hubs') {
      const rawHubs = expectWorkerValue(
        rawResults[0],
        (value): value is CodeGraphSymbolDegreeSummary[] =>
          isArrayOf(value, isSymbolDegreeSummary),
        'hub results',
      );
      const limit = resolveDetailLimit(detailLevel, request.limit);
      const capped = rawHubs.slice(0, limit);
      const truncated = rawHubs.length > capped.length;
      return {
        status: 'ok',
        summary: `hubs: ${rawHubs.length} result(s)${truncated ? `, showing ${capped.length}` : ''}.`,
        truncated,
        ...(truncated ? { suggestedNextTools: ['QueryCodeGraph'] } : {}),
        mode: request.mode,
        target,
        hits: capped.map(hubHit),
      };
    }

    const mode = request.mode;
    const rawHits = hitsForMode(mode, rawResults[0]);
    const limit = resolveDetailLimit(detailLevel, request.limit);
    const hits = rawHits.slice(0, limit);
    const truncated = rawHits.length > hits.length;
    return {
      status: 'ok',
      summary: `${mode} for "${target}": ${rawHits.length} result(s)${truncated ? `, showing ${hits.length}` : ''}.`,
      truncated,
      ...(truncated ? { suggestedNextTools: ['QueryCodeGraph'] } : {}),
      mode,
      target,
      hits,
    };
  } catch (error) {
    return {
      status: 'error',
      summary: `Failed to query code graph: ${errorMessage(error)}`,
      truncated: false,
      mode: request.mode,
      target,
      hits: [],
    };
  }
}

export async function searchCodeGraph(
  runtime: CodeGraphToolRuntime,
  request: CodeGraphSearchRequest,
): Promise<CodeGraphSearchResultPayload> {
  const rejection = guardRejectionMessage(
    'SearchCodeGraph',
    runtime.projectId,
    runtime.worktreeId,
  );
  if (rejection !== null) {
    return unavailableSearch(rejection);
  }

  if (!hasCodeGraph(runtime)) {
    return unavailableSearch(NO_GRAPH_MESSAGE, NO_GRAPH_SUGGESTIONS);
  }

  try {
    const detailLevel: CodeGraphDetailLevel = request.detailLevel ?? 'minimal';
    const limit = resolveDetailLimit(detailLevel, request.limit);
    // Fetch one extra row so a full page can be distinguished from an exact
    // match (search's own limit is enforced in SQL, unlike the other query
    // modes which return every match and get sliced here).
    const results = await runReadCalls(runtime, 'search', [
      { method: 'search', query: request.query, limit: limit + 1 },
    ]);
    const rawResults = expectWorkerValue(
      results[0],
      (
        value,
      ): value is Array<{
        qualifiedName: string;
        kind: string;
        filePath: string;
        lineStart: number;
        matchKind?: CodeGraphSymbolHit['matchKind'];
      }> => isArrayOf(value, isSearchResult),
      'search results',
    );
    const capped = rawResults.slice(0, limit);
    const truncated = rawResults.length > capped.length;
    const hits: CodeGraphSymbolHit[] = capped.map((result) => ({
      qualifiedName: result.qualifiedName,
      kind: result.kind,
      filePath: result.filePath,
      line: result.lineStart,
      ...(result.matchKind ? { matchKind: result.matchKind } : {}),
    }));
    return {
      status: 'ok',
      summary: `Search "${request.query}": ${hits.length} result(s)${truncated ? ' (more available)' : ''}.`,
      truncated,
      ...(truncated ? { suggestedNextTools: ['SearchCodeGraph'] } : {}),
      hits,
    };
  } catch (error) {
    return {
      status: 'error',
      summary: `Failed to search code graph: ${errorMessage(error)}`,
      truncated: false,
      hits: [],
    };
  }
}

export async function explainCodeSymbol(
  runtime: CodeGraphToolRuntime,
  request: CodeGraphExplainRequest,
): Promise<CodeGraphExplainResult> {
  const rejection = guardRejectionMessage(
    'ExplainCodeSymbol',
    runtime.projectId,
    runtime.worktreeId,
  );
  if (rejection !== null) {
    return unavailableExplain(rejection);
  }

  if (!hasCodeGraph(runtime)) {
    return unavailableExplain(NO_GRAPH_MESSAGE, NO_GRAPH_SUGGESTIONS);
  }

  try {
    const repo = request.repoId ? { repoId: request.repoId } : {};
    const results = await runReadCalls(runtime, 'explain', [
      { method: 'symbol-detail', target: request.qualifiedName, ...repo },
      { method: 'callers', target: request.qualifiedName, ...repo },
      { method: 'callees', target: request.qualifiedName, ...repo },
      { method: 'tests-for', target: request.qualifiedName, ...repo },
      {
        method: 'flows-for-symbol',
        target: request.qualifiedName,
        limit: CODE_GRAPH_DERIVED_QUERY_FETCH_CAP,
        ...repo,
      },
      {
        method: 'community-for-symbol',
        target: request.qualifiedName,
        ...repo,
      },
    ]);
    const detail =
      results[0] === null
        ? null
        : expectWorkerValue(results[0], isExplainSymbol, 'symbol detail');
    const rawCallers = expectWorkerValue(
      results[1],
      (value): value is CodeGraphSymbolHit[] =>
        isArrayOf(value, isCodeGraphSymbolHit),
      'caller results',
    );
    const rawCallees = expectWorkerValue(
      results[2],
      (value): value is CodeGraphSymbolHit[] =>
        isArrayOf(value, isCodeGraphSymbolHit),
      'callee results',
    );
    const rawTests = expectWorkerValue(
      results[3],
      isStringArray,
      'test results',
    );
    const rawFlows = expectWorkerValue(
      results[4],
      (value): value is CodeGraphFlowRecord[] => isArrayOf(value, isFlowRecord),
      'flow results',
    );
    const community =
      results[5] === null
        ? null
        : expectWorkerValue(results[5], isCommunityRecord, 'community result');
    if (detail === null) {
      return {
        status: 'ok',
        summary: `Symbol not found in code graph: ${request.qualifiedName}`,
        truncated: false,
        callers: [],
        callees: [],
        tests: [],
        community: null,
        flows: [],
      };
    }

    // Derived-analysis enrichment (Phase 6 Task 7): fetch generously (the
    // same fetch-then-cap-then-report-truncated pattern callers/callees/
    // tests already use above) so `flowsTruncated` reflects the symbol's
    // TRUE flow membership count, not an artificially small default limit.
    const callers = rawCallers.slice(0, CODE_GRAPH_TOOL_DEFAULT_RESULTS);
    const callees = rawCallees.slice(0, CODE_GRAPH_TOOL_DEFAULT_RESULTS);
    const tests = rawTests.slice(0, CODE_GRAPH_TOOL_DEFAULT_RESULTS);
    const flows = rawFlows.slice(0, CODE_GRAPH_EXPLAIN_MAX_FLOWS);
    const truncated =
      rawCallers.length > callers.length ||
      rawCallees.length > callees.length ||
      rawTests.length > tests.length ||
      rawFlows.length > flows.length;

    return {
      status: 'ok',
      summary: `${detail.qualifiedName} (${detail.kind}): ${rawCallers.length} caller(s), ${rawCallees.length} callee(s), ${rawTests.length} test(s).`,
      truncated,
      ...(truncated ? { suggestedNextTools: ['QueryCodeGraph'] } : {}),
      symbol: detail,
      callers,
      callees,
      tests,
      community: community === null ? null : communityHit(community),
      flows: flows.map(flowHit),
    };
  } catch (error) {
    return {
      status: 'error',
      summary: `Failed to explain code symbol: ${errorMessage(error)}`,
      truncated: false,
      callers: [],
      callees: [],
      tests: [],
      community: null,
      flows: [],
    };
  }
}

export async function getImpactRadius(
  runtime: CodeGraphToolRuntime,
  request: CodeGraphImpactRequest,
): Promise<CodeGraphImpactResult> {
  const rejection = guardRejectionMessage(
    'GetImpactRadius',
    runtime.projectId,
    runtime.worktreeId,
  );
  if (rejection !== null) {
    return unavailableImpact(rejection);
  }

  if (!hasCodeGraph(runtime)) {
    return unavailableImpact(NO_GRAPH_MESSAGE, NO_GRAPH_SUGGESTIONS);
  }

  try {
    const maxDepth = clamp(
      request.maxDepth ?? CODE_GRAPH_IMPACT_DEFAULT_DEPTH,
      1,
      CODE_GRAPH_IMPACT_MAX_DEPTH,
    );
    const maxNodes = clamp(
      request.maxNodes ?? CODE_GRAPH_IMPACT_DEFAULT_NODES,
      1,
      CODE_GRAPH_IMPACT_MAX_NODES,
    );
    const detailLevel: CodeGraphDetailLevel = request.detailLevel ?? 'minimal';
    const responseLimit =
      detailLevel === 'standard' ? maxNodes : CODE_GRAPH_TOOL_MINIMAL_RESULTS;
    // Fetch one extra node past the response limit purely to detect
    // truncation. The breadth-first walk stops after the first depth that
    // fills maxNodes, so a smaller limit also bounds the work; results stay
    // nearest-first (MIN-depth) ordered either way.
    const results = await runReadCalls(runtime, 'impact-radius', [
      {
        method: 'impact-radius',
        target: request.target,
        options: {
          maxDepth,
          maxNodes: Math.min(responseLimit + 1, maxNodes + 1),
        },
      },
    ]);
    const raw = expectWorkerValue(
      results[0],
      (
        value,
      ): value is Array<{
        qualifiedName: string;
        kind: string;
        filePath: string;
        depth: number;
      }> => isArrayOf(value, isImpactEntry),
      'impact-radius results',
    );
    const impacted = raw.slice(0, responseLimit).map((entry) => ({
      qualifiedName: entry.qualifiedName,
      kind: entry.kind,
      filePath: entry.filePath,
      line: null,
      depth: entry.depth,
    }));
    const truncated = raw.length > impacted.length;
    return {
      status: 'ok',
      summary: `Impact radius for "${request.target}" (depth ≤ ${maxDepth}): ${impacted.length} symbol(s)${truncated ? ' (more available)' : ''}.`,
      truncated,
      ...(truncated ? { suggestedNextTools: ['GetImpactRadius'] } : {}),
      impacted,
      maxDepth,
    };
  } catch (error) {
    return {
      status: 'error',
      summary: `Failed to compute impact radius: ${errorMessage(error)}`,
      truncated: false,
      impacted: [],
      maxDepth: 0,
    };
  }
}

/**
 * Diff-only: maps a git diff's touched ranges onto graph symbols via
 * `mapRangesToSymbols` (no before-graph build — that only matters for the
 * delta/risk/impact machinery in `CompareChangeImpact`/`GetReviewContext`).
 */
export async function detectChangedSymbols(
  runtime: CodeGraphToolRuntime,
  request: DetectChangedSymbolsRequest,
): Promise<DetectChangedSymbolsResult> {
  const rejection = guardRejectionMessage(
    'DetectChangedSymbols',
    runtime.projectId,
    runtime.worktreeId,
  );
  if (rejection !== null) {
    return unavailableDetect(rejection);
  }

  if (!hasCodeGraph(runtime)) {
    return unavailableDetect(NO_GRAPH_MESSAGE, NO_GRAPH_SUGGESTIONS);
  }

  try {
    const worktreePath = resolveWorktreeCwd(
      runtime.projectId,
      runtime.worktreeId,
    );
    const repositories = await resolveRepositories(
      runtime.projectId,
      worktreePath,
    );
    const resolvedRepo = resolveTargetRepository(repositories, request.repoId);
    if ('error' in resolvedRepo) {
      return errorDetect(resolvedRepo.error);
    }
    const { repository } = resolvedRepo;

    const baseRefOutcome = await resolveBaseRef(
      repository.rootPath,
      request.baseRef,
    );
    if ('error' in baseRefOutcome) {
      return errorDetect(baseRefOutcome.error);
    }
    const { baseRef } = baseRefOutcome;
    const result = await runReadTask(runtime, 'detect-changed', {
      kind: 'detect-changed',
      repoId: repository.repoId,
      rootPath: repository.rootPath,
      baseRef,
    });
    if (result.kind !== 'detect-changed') {
      throw new Error('Code graph read worker returned an unexpected result');
    }
    const { changed, unmatchedFiles, lastBuildAt } = result.value;

    const detailLevel: CodeGraphDetailLevel = request.detailLevel ?? 'minimal';
    const { items: capped, truncated } = capList(
      changed,
      detailLevel,
      CODE_GRAPH_CHANGE_DETAIL_MAX_ITEMS,
    );

    return {
      status: 'ok',
      summary:
        `Detected ${changed.length} changed symbol(s) vs ${baseRef}` +
        `${repoNameSuffix(repositories, repository.repoId)}` +
        `${truncated ? `, showing ${capped.length}` : ''}.`,
      truncated,
      ...(truncated
        ? {
            suggestedNextTools: ['CompareChangeImpact', 'GetReviewContext'],
          }
        : {}),
      baseRef,
      lastBuildAt,
      changed: capped.map(toChangedSymbolPayload),
      unmatchedFiles,
    };
  } catch (error) {
    return errorDetect(
      `Failed to detect changed symbols: ${errorMessage(error)}`,
    );
  }
}

/**
 * Full change-impact assembly (delta + risk + impact-radius seeded from the
 * delta + impacted tests) via `assembleChangeImpact`.
 */
export async function compareChangeImpact(
  runtime: CodeGraphToolRuntime,
  request: CompareChangeImpactRequest,
): Promise<CompareChangeImpactResult> {
  const rejection = guardRejectionMessage(
    'CompareChangeImpact',
    runtime.projectId,
    runtime.worktreeId,
  );
  if (rejection !== null) {
    return unavailableCompare(rejection);
  }

  if (!hasCodeGraph(runtime)) {
    return unavailableCompare(NO_GRAPH_MESSAGE, NO_GRAPH_SUGGESTIONS);
  }

  try {
    const worktreePath = resolveWorktreeCwd(
      runtime.projectId,
      runtime.worktreeId,
    );
    const repositories = await resolveRepositories(
      runtime.projectId,
      worktreePath,
    );
    const resolvedRepo = resolveTargetRepository(repositories, request.repoId);
    if ('error' in resolvedRepo) {
      return errorCompare(resolvedRepo.error);
    }
    const { repository } = resolvedRepo;

    const baseRefOutcome = await resolveBaseRef(
      repository.rootPath,
      request.baseRef,
    );
    if ('error' in baseRefOutcome) {
      return errorCompare(baseRefOutcome.error);
    }
    const { baseRef } = baseRefOutcome;

    const maxDepth = clamp(
      request.maxDepth ?? CODE_GRAPH_IMPACT_DEFAULT_DEPTH,
      1,
      CODE_GRAPH_IMPACT_MAX_DEPTH,
    );
    const detailLevel: CodeGraphDetailLevel = request.detailLevel ?? 'minimal';
    const result = await runReadTask(runtime, 'compare-impact', {
      kind: 'change-impact',
      repoId: repository.repoId,
      rootPath: repository.rootPath,
      baseRef,
      maxDepth,
      resourcesDir: getBundledCodeGraphDir(),
    });
    if (result.kind !== 'change-impact') {
      throw new Error('Code graph read worker returned an unexpected result');
    }
    const { report, lastBuildAt } = result.value;

    const addedCap = capList(
      report.delta.added,
      detailLevel,
      CODE_GRAPH_CHANGE_DETAIL_MAX_ITEMS,
    );
    const removedCap = capList(
      report.delta.removed,
      detailLevel,
      CODE_GRAPH_CHANGE_DETAIL_MAX_ITEMS,
    );
    const signatureChangedCap = capList(
      report.delta.signatureChanged,
      detailLevel,
      CODE_GRAPH_CHANGE_DETAIL_MAX_ITEMS,
    );
    const impactedCap = capList(
      report.impacted,
      detailLevel,
      CODE_GRAPH_IMPACT_DEFAULT_NODES,
    );
    const impactedTestsCap = capForMinimal(report.impactedTests, detailLevel);

    const delta: CodeGraphChangeDelta = {
      addedCount: report.delta.added.length,
      removedCount: report.delta.removed.length,
      signatureChangedCount: report.delta.signatureChanged.length,
      // Detail arrays only at 'standard' — 'minimal' stays counts + risk.
      ...(detailLevel === 'standard'
        ? {
            added: addedCap.items.map(toChangedSymbolPayload),
            removed: removedCap.items,
            signatureChanged: signatureChangedCap.items,
          }
        : {}),
    };

    const truncated =
      report.impactTruncated ||
      report.impactSeedsTruncated ||
      report.impactedTestsTruncated ||
      impactedCap.truncated ||
      impactedTestsCap.truncated ||
      (detailLevel === 'standard' &&
        (addedCap.truncated ||
          removedCap.truncated ||
          signatureChangedCap.truncated));

    return {
      status: 'ok',
      summary:
        `Change impact vs ${baseRef}${repoNameSuffix(repositories, repository.repoId)}: ` +
        `+${delta.addedCount} added, -${delta.removedCount} removed, ` +
        `${delta.signatureChangedCount} signature change(s); ` +
        `${report.impacted.length} impacted symbol(s), risk ${report.risk.level}${staleRiskInputsNote(report.risk)}.`,
      truncated,
      ...(truncated ? { suggestedNextTools: ['GetReviewContext'] } : {}),
      baseRef,
      lastBuildAt,
      delta,
      impacted: impactedCap.items.map(toImpactHitPayload),
      impactedTests: impactedTestsCap.items,
      risk: report.risk,
    };
  } catch (error) {
    return errorCompare(
      `Failed to compare change impact: ${errorMessage(error)}`,
    );
  }
}

/**
 * Review-oriented framing of `assembleChangeImpact`'s report: per-symbol risk
 * reasons, impacted files/tests, test gaps, and top review priorities.
 */
export async function getReviewContext(
  runtime: CodeGraphToolRuntime,
  request: GetReviewContextRequest,
): Promise<GetReviewContextResult> {
  const rejection = guardRejectionMessage(
    'GetReviewContext',
    runtime.projectId,
    runtime.worktreeId,
  );
  if (rejection !== null) {
    return unavailableReview(rejection);
  }

  if (!hasCodeGraph(runtime)) {
    return unavailableReview(NO_GRAPH_MESSAGE, NO_GRAPH_SUGGESTIONS);
  }

  try {
    const worktreePath = resolveWorktreeCwd(
      runtime.projectId,
      runtime.worktreeId,
    );
    const repositories = await resolveRepositories(
      runtime.projectId,
      worktreePath,
    );
    const resolvedRepo = resolveTargetRepository(repositories, request.repoId);
    if ('error' in resolvedRepo) {
      return errorReview(resolvedRepo.error);
    }
    const { repository } = resolvedRepo;

    const baseRefOutcome = await resolveBaseRef(
      repository.rootPath,
      request.baseRef,
    );
    if ('error' in baseRefOutcome) {
      return errorReview(baseRefOutcome.error);
    }
    const { baseRef } = baseRefOutcome;
    const detailLevel: CodeGraphDetailLevel = request.detailLevel ?? 'minimal';
    const result = await runReadTask(runtime, 'review-context', {
      kind: 'change-impact',
      repoId: repository.repoId,
      rootPath: repository.rootPath,
      baseRef,
      resourcesDir: getBundledCodeGraphDir(),
    });
    if (result.kind !== 'change-impact') {
      throw new Error('Code graph read worker returned an unexpected result');
    }
    const { report, lastBuildAt } = result.value;

    const changedSymbolsCap = capList(
      report.reviewContext.changedSymbols,
      detailLevel,
      CODE_GRAPH_CHANGE_DETAIL_MAX_ITEMS,
    );
    const impactedFilesCap = capForMinimal(
      report.reviewContext.impactedFiles,
      detailLevel,
    );
    const impactedTestsCap = capForMinimal(report.impactedTests, detailLevel);
    const testGapsCap = capForMinimal(
      report.reviewContext.testGaps,
      detailLevel,
    );
    const reviewPrioritiesCap = capForMinimal(
      report.reviewContext.reviewPriorities,
      detailLevel,
    );

    const truncated =
      changedSymbolsCap.truncated ||
      impactedFilesCap.truncated ||
      impactedTestsCap.truncated ||
      testGapsCap.truncated ||
      reviewPrioritiesCap.truncated ||
      report.reviewContext.impactedFilesTruncated ||
      report.impactedTestsTruncated ||
      report.impactSeedsTruncated ||
      report.reviewContext.testGapsTruncated ||
      report.reviewContext.reviewPrioritiesTruncated;

    return {
      status: 'ok',
      summary:
        `Review context vs ${baseRef}${repoNameSuffix(repositories, repository.repoId)}: ` +
        `${report.reviewContext.changedSymbols.length} changed symbol(s), ` +
        `${report.reviewContext.testGaps.length} test gap(s), risk ${report.risk.level}${staleRiskInputsNote(report.risk)}.`,
      truncated,
      ...(truncated ? { suggestedNextTools: ['CompareChangeImpact'] } : {}),
      baseRef,
      lastBuildAt,
      changedSymbols: changedSymbolsCap.items,
      impactedFiles: impactedFilesCap.items,
      impactedTests: impactedTestsCap.items,
      testGaps: testGapsCap.items,
      reviewPriorities: reviewPrioritiesCap.items,
      risk: report.risk,
    };
  } catch (error) {
    return errorReview(
      `Failed to build review context: ${errorMessage(error)}`,
    );
  }
}
