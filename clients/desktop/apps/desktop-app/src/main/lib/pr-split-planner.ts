/**
 * Split PR — Phase A planner (the feature's single LLM step).
 *
 * `planPrSplit` runs the read-only planning phase from
 * `docs/planning/2026-06-30-pr-splits/03-executor-prompts.md`: it refuses
 * unsupported topologies with typed errors, locates the worktree's open PR,
 * detects the PR's real base branch (never assumed `main`), gates on
 * freshness/ancestry, gathers the hunk-level diff snapshot plus repo context,
 * and asks the configured planner model for a structured `SplitPlan`. The plan
 * is validated deterministically; on validation errors the model is retried
 * exactly once with the issues appended, then the issues are surfaced.
 *
 * No git or GitHub mutation happens here — Phase B (the deterministic
 * orchestrator) owns all mutations after the human gate.
 */

import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { type ThinkingLevel } from '@canopy/desktop-shared/types';
import type {
  PrDiffSnapshot,
  SplitPlan,
  SplitPrPlanRefusalCode,
  SplitPrPlanResponse,
} from '@canopy/desktop-shared/types/github';
import { gatherPrDiffSnapshot } from '@canopy/desktop-shared/node/lib/pr-split-diff';
import {
  isSplitPlan,
  validateSplitPlan,
} from '@canopy/desktop-shared/lib/pr-split-plan';
import type { SplitPlanIssue } from '@canopy/desktop-shared/types/pr-split-plan';
import {
  getStructuredHelperQueryErrorUsage,
  runCodexStructuredHelperQuery,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import type { HelperUsage } from '@canopy/desktop-shared/lib/helper-usage';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  codexStructuredHelperRunner,
  runStructuredHelper,
  structuredHelperReportOnlyPermission,
} from '../integration/structured-helper-dispatch';
import { resolveHelperInvocation } from '../ollama/helper-invocation';
import { resolveInvocationWorkOwner } from '../agents/work-owner';
import {
  fetchOrigin,
  getCurrentBranch,
  isAncestor,
  resolveRefSha,
} from './git';
import { fetchRepoPrTrackingData } from './github-pr';
import {
  finalizeObservedHelperTask,
  startObservedHelperTask,
} from './helper-observed-task';
import { createHelperTranscriptObserver } from './helper-transcript-observer';
import {
  readLocalMemoryEnabledPreference,
  readPreferencesFile,
} from './preferences-store';
import { resolveWorktreeCwd } from './resolve-worktree';
import { isMultiRepoWorkspace } from './workspace-registry';
import { resolveEffectiveBaseBranchForRepo } from './worktree-base-branches';
import {
  buildSplitPlannerSystemPrompt,
  buildSplitPlannerUserPrompt,
  buildSplitPlanStructuralRetryAddendum,
  buildSplitPlanValidationRetryAddendum,
  SPLIT_PLAN_JSON_SCHEMA,
  type SplitPlannerRepoContext,
} from './pr-split-planner-prompt';

export interface PlanPrSplitOptions {
  projectId: string;
  worktreeId: string;
}

/**
 * Typed refusal/failure codes so the IPC layer can relay a stable machine-
 * readable reason alongside the user-facing message. The union itself lives
 * in `@canopy/desktop-shared/types/github` as `SplitPrPlanRefusalCode` so the
 * IPC boundary and renderer can depend on the same source of truth.
 */
export type PrSplitPlanningErrorCode = SplitPrPlanRefusalCode;

export class PrSplitPlanningError extends Error {
  readonly code: PrSplitPlanningErrorCode;
  /** Deterministic-validation issues; populated for `invalid_plan` failures. */
  readonly issues: SplitPlanIssue[];

  constructor(
    code: PrSplitPlanningErrorCode,
    message: string,
    issues: SplitPlanIssue[] = [],
  ) {
    super(message);
    this.name = 'PrSplitPlanningError';
    this.code = code;
    this.issues = issues;
  }
}

const MAX_CONTEXT_CHARS = 4000;
const MAX_PLANNER_TURNS = 4;
const ORIGIN_FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Repo context gathering (SKILL.md §"Inspect Local Context")
// ---------------------------------------------------------------------------

function isInsidePath(parentPath: string, childPath: string): boolean {
  const childRelativePath = relative(parentPath, childPath);
  return (
    childRelativePath === '' ||
    (!childRelativePath.startsWith('..') && !isAbsolute(childRelativePath))
  );
}

async function readSafeRepoFile(
  repoPath: string,
  relativePath: string,
): Promise<string | null> {
  const absolutePath = resolve(repoPath, relativePath);
  try {
    const [repoRealPath, candidateStats] = await Promise.all([
      realpath(repoPath),
      lstat(absolutePath),
    ]);
    if (candidateStats.isSymbolicLink() || !candidateStats.isFile()) {
      return null;
    }

    const candidateRealPath = await realpath(absolutePath);
    if (!isInsidePath(repoRealPath, candidateRealPath)) {
      return null;
    }

    return await readFile(candidateRealPath, 'utf-8');
  } catch {
    return null;
  }
}

async function readOptionalRepoFile(
  repoPath: string,
  relativePaths: string[],
): Promise<string | null> {
  for (const relativePath of relativePaths) {
    const text = await readSafeRepoFile(repoPath, relativePath);
    if (text !== null) {
      return text.length > MAX_CONTEXT_CHARS
        ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n… (truncated)`
        : text;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function gatherBuildTestHint(repoPath: string): Promise<string | null> {
  const hints: string[] = [];
  try {
    const raw = await readSafeRepoFile(repoPath, 'package.json');
    if (raw === null) {
      throw new Error('package.json unavailable');
    }
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && isRecord(parsed.scripts)) {
      const scriptNames = Object.keys(parsed.scripts);
      if (scriptNames.length > 0) {
        hints.push(`package.json scripts: ${scriptNames.join(', ')}`);
      }
    }
  } catch {
    // No package.json (or unparsable) — fall through to other manifests.
  }

  for (const manifest of ['pyproject.toml', 'Cargo.toml', 'go.mod']) {
    const text = await readSafeRepoFile(repoPath, manifest);
    if (text !== null) {
      hints.push(`${manifest} present`);
    }
  }

  return hints.length > 0 ? hints.join('\n') : null;
}

async function gatherRepoContext(
  repoPath: string,
): Promise<SplitPlannerRepoContext> {
  const [codeowners, prTemplate, contributing, claudeMd, buildTestHint] =
    await Promise.all([
      readOptionalRepoFile(repoPath, [
        '.github/CODEOWNERS',
        'CODEOWNERS',
        'docs/CODEOWNERS',
      ]),
      readOptionalRepoFile(repoPath, [
        '.github/PULL_REQUEST_TEMPLATE.md',
        '.github/pull_request_template.md',
      ]),
      readOptionalRepoFile(repoPath, ['CONTRIBUTING.md']),
      readOptionalRepoFile(repoPath, ['CLAUDE.md']),
      gatherBuildTestHint(repoPath),
    ]);
  return { codeowners, prTemplate, contributing, claudeMd, buildTestHint };
}

// ---------------------------------------------------------------------------
// E2E fixture seam
// ---------------------------------------------------------------------------

/**
 * E2E-only fixture seam (Doc 11 build-time gating principle; same pattern as
 * `github-octokit-options.ts`). Production builds fold `__CANOPY_E2E__` to
 * `false` and dead-code-eliminate the env read, so the fixture path is
 * unreachable outside `CANOPY_E2E_BUILD=1` builds.
 */
function resolveSplitPlanFixturePath(): string | undefined {
  if (__CANOPY_E2E__) {
    return process.env.CANOPY_TEST_SPLIT_PLAN_FIXTURE;
  }
  return undefined;
}

async function readSplitPlanFixture(fixturePath: string): Promise<SplitPlan> {
  const raw = await readFile(fixturePath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (!isSplitPlan(parsed)) {
    throw new PrSplitPlanningError(
      'invalid_plan',
      `Split plan fixture at ${fixturePath} is not a valid SplitPlan`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Usage aggregation across the validation-retry attempts
// ---------------------------------------------------------------------------

function addCounters(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  return (a ?? 0) + (b ?? 0);
}

function mergeUsage(a: HelperUsage, b: HelperUsage): HelperUsage {
  return {
    inputTokens: addCounters(a.inputTokens, b.inputTokens),
    outputTokens: addCounters(a.outputTokens, b.outputTokens),
    cacheReadInputTokens: addCounters(
      a.cacheReadInputTokens,
      b.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: addCounters(
      a.cacheCreationInputTokens,
      b.cacheCreationInputTokens,
    ),
    reasoningOutputTokens: addCounters(
      a.reasoningOutputTokens,
      b.reasoningOutputTokens,
    ),
    totalCostUsd: addCounters(a.totalCostUsd, b.totalCostUsd),
    messageCount: addCounters(a.messageCount, b.messageCount),
    assistantMessageCount: addCounters(
      a.assistantMessageCount,
      b.assistantMessageCount,
    ),
  };
}

function hasUsageData(usage: HelperUsage): boolean {
  return Object.values(usage).some((value) => value !== undefined);
}

// ---------------------------------------------------------------------------
// LLM query (Claude/Ollama via runStructuredHelper, Codex via the SDK query)
// ---------------------------------------------------------------------------

interface PlannerQueryArgs {
  repoPath: string;
  projectId: string;
  worktreeId: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  userMessage: string;
  taskKey: string;
  workOwner: WorkOwner | null;
}

interface PlannerQueryResult {
  plan: SplitPlan | null;
  usage: HelperUsage;
}

async function runPlannerQuery(
  args: PlannerQueryArgs,
): Promise<PlannerQueryResult> {
  const transcriptObserver = createHelperTranscriptObserver(args.taskKey);
  const invocation = await resolveHelperInvocation(args.model, undefined, {
    workspaceId: args.projectId,
    workOwner: args.workOwner,
  });
  try {
    if (invocation.harness === 'codex') {
      const combinedPrompt = `${args.systemPrompt}\n\n${args.userMessage}\n\nRespond with ONLY the JSON Split Plan object, with no code fence or explanation.`;
      await transcriptObserver.seed({
        provider: invocation.providerType,
        originalText: args.userMessage,
        submittedText: combinedPrompt,
        systemPrompt: args.systemPrompt,
      });
      const result = await runCodexStructuredHelperQuery({
        runner: codexStructuredHelperRunner,
        repoPath: args.repoPath,
        model: invocation.sdkModel ?? args.model,
        systemPrompt: '',
        userMessage: '',
        combinedPrompt,
        schema: SPLIT_PLAN_JSON_SCHEMA,
        thinkingLevel: args.thinkingLevel,
        workspaceId: args.projectId,
        localMemoryEnabled: await readLocalMemoryEnabledPreference(),
        transcriptObserver,
        isResult: isSplitPlan,
        codexConfigOverride: invocation.codexConfig,
        waitForQuotaRecovery: invocation.waitForQuotaRecovery,
      });
      return { plan: result.value, usage: result.usage };
    }

    await transcriptObserver.seed({
      provider: invocation.providerType === 'ollama' ? 'ollama' : 'claude',
      originalText: args.userMessage,
      submittedText: args.userMessage,
      systemPrompt: args.systemPrompt,
    });
    const result = await runStructuredHelper({
      kind: 'pr_split_planning',
      label: 'Split PR Planning',
      repoPath: args.repoPath,
      model: invocation.sdkModel ?? args.model,
      provider: invocation.providerType === 'ollama' ? 'ollama' : 'claude',
      executionHarness: invocation.harness,
      maxTurns: MAX_PLANNER_TURNS,
      systemPrompt: args.systemPrompt,
      userMessage: args.userMessage,
      schema: SPLIT_PLAN_JSON_SCHEMA,
      thinkingLevel: args.thinkingLevel,
      workspaceId: args.projectId,
      localMemoryEnabled: await readLocalMemoryEnabledPreference(),
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      claudeEnvOverride: invocation.envOverride,
      waitForQuotaRecovery: invocation.waitForQuotaRecovery,
      isResult: isSplitPlan,
      permission: structuredHelperReportOnlyPermission(),
      settingSources: [],
      linkTarget: {
        page: 'main',
        kind: 'worktree-chat',
        projectId: args.projectId,
        worktreeId: args.worktreeId,
      },
      transcriptObserver: {
        // Seeded above; keep the dispatched observer's seed a no-op so the
        // transcript is not seeded twice (matches the branch-namer pattern).
        seed: () => undefined,
        appendEvent: transcriptObserver.appendEvent,
        markChatMode: transcriptObserver.markChatMode,
        markAttempt: transcriptObserver.markAttempt,
        markSessionId: transcriptObserver.markSessionId,
      },
    });
    return { plan: result.value, usage: result.usage };
  } finally {
    invocation.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// Steps 1–4 — refusals, PR lookup, base detection, gates, gathering
// ---------------------------------------------------------------------------

interface PlanningInputs {
  repoPath: string;
  snapshot: PrDiffSnapshot;
  repoContext: SplitPlannerRepoContext;
  originalPr: SplitPrPlanResponse['originalPr'];
  prTitle: string;
  prBody: string;
}

async function gatherPlanningInputs(
  options: PlanPrSplitOptions,
): Promise<PlanningInputs> {
  const { projectId, worktreeId } = options;

  // Step 1 — topology refusals that need no PR data.
  if (isMultiRepoWorkspace(projectId)) {
    throw new PrSplitPlanningError(
      'multi_repo_unsupported',
      'Split PR is not supported for multi-repo projects yet. Open the PR from a single-repo worktree to split it.',
    );
  }
  const repoPath = resolveWorktreeCwd(projectId, worktreeId);

  // Step 2 — locate the open PR for the current branch and detect its base.
  const branchName = await getCurrentBranch(repoPath);
  const tracking = await fetchRepoPrTrackingData(repoPath, branchName, {
    priority: 'high',
  });
  const prSnapshot = tracking.snapshot;
  if (
    !prSnapshot ||
    (prSnapshot.pr.state !== 'open' && prSnapshot.pr.state !== 'draft')
  ) {
    throw new PrSplitPlanningError(
      'no_open_pr',
      `No open pull request was found for branch "${branchName}". Open a PR before splitting it.`,
    );
  }
  // Fork detection: `fetchRepoPrTrackingData` computes `isCrossRepository` as
  // `pulls.get().head.repo.full_name !== base.repo.full_name`, which is the
  // only fork signal the snapshot carries. The carve phase pushes new branches
  // to origin, which cannot work when the PR head lives in a different repo.
  if (prSnapshot.pr.isCrossRepository) {
    throw new PrSplitPlanningError(
      'fork_pr_unsupported',
      'The open PR is a fork/cross-repository PR. Split PR only supports PRs whose head branch lives in the same repository as the base.',
    );
  }

  // Detected base = the branch the PR targets (never assumed `main`). The
  // worktree-configured base is only a fallback when the PR snapshot somehow
  // lacks a base ref; on mismatch the PR's own base wins.
  const worktreeBase = await resolveEffectiveBaseBranchForRepo({
    projectId,
    worktreeId,
    repoPath,
  }).catch(() => null);
  const baseBranch = prSnapshot.branch.baseRefName || worktreeBase?.branch;
  if (!baseBranch) {
    throw new PrSplitPlanningError(
      'no_open_pr',
      'Could not determine the base branch of the open pull request.',
    );
  }
  const originalHeadSha = prSnapshot.branch.headSha;

  // Step 3 — freshness and topology gates. Prune so stale remote-tracking
  // refs do not skew the base-ancestry gate against a deleted/rewritten base.
  // The fetch is non-interactive and bounded: with no stored credential git
  // asks for one on any terminal it can reach and then waits forever, which
  // leaves the split on "Analyzing PR diff…". The bound is a signal, not a
  // process timeout, because this call usually joins the automatic refresh
  // fetch already in flight for the repository, and only a signal limits that
  // wait. A fetch that fails or times out is tolerated, as before, and the
  // gates run on the refs already here.
  await fetchOrigin(repoPath, {
    prune: true,
    nonInteractive: true,
    signal: AbortSignal.timeout(ORIGIN_FETCH_TIMEOUT_MS),
  }).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(
      '[split-pr] origin fetch failed or timed out; planning on the refs already present',
      { repoPath, error },
    );
  });
  const baseSha = await resolveRefSha(repoPath, `origin/${baseBranch}`);
  const localHeadSha = await resolveRefSha(repoPath, 'HEAD');
  if (localHeadSha !== originalHeadSha) {
    throw new PrSplitPlanningError(
      'head_out_of_sync',
      `Local HEAD (${localHeadSha.slice(0, 12)}) does not match the PR head (${originalHeadSha.slice(0, 12)}). Sync your worktree and push the branch first.`,
    );
  }
  if (!(await isAncestor(repoPath, baseSha, originalHeadSha))) {
    throw new PrSplitPlanningError(
      'base_not_ancestor',
      `origin/${baseBranch} is not an ancestor of the PR head. Rebase onto or merge the base branch first.`,
    );
  }

  // Step 4 — gather the hunk-level diff snapshot and repo context.
  const snapshot: PrDiffSnapshot = await gatherPrDiffSnapshot(
    repoPath,
    baseSha,
    originalHeadSha,
  );
  const repoContext = await gatherRepoContext(repoPath);

  return {
    repoPath,
    snapshot,
    repoContext,
    originalPr: {
      prNumber: prSnapshot.pr.number,
      prUrl: prSnapshot.pr.htmlUrl,
      baseBranch,
      headBranch: prSnapshot.branch.headRefName,
      headSha: originalHeadSha,
    },
    prTitle: prSnapshot.pr.title,
    prBody: prSnapshot.pr.body,
  };
}

// ---------------------------------------------------------------------------
// Step 7 — E2E fixture path (steps 1–4 already ran)
// ---------------------------------------------------------------------------

async function buildFixturePlanResponse(
  fixturePath: string,
  inputs: PlanningInputs,
): Promise<SplitPrPlanResponse> {
  const fixturePlan = await readSplitPlanFixture(fixturePath);
  const validation = validateSplitPlan(fixturePlan, inputs.snapshot);
  const errors = validation.issues.filter(
    (issue) => issue.severity === 'error',
  );
  if (errors.length > 0) {
    throw new PrSplitPlanningError(
      'invalid_plan',
      `Split plan fixture failed validation: ${errors
        .map((issue) => issue.message)
        .join('; ')}`,
      errors,
    );
  }
  return {
    plan: fixturePlan,
    snapshot: inputs.snapshot,
    originalPr: inputs.originalPr,
  };
}

// ---------------------------------------------------------------------------
// Steps 5–6 — the observed LLM query with a single shared retry
// ---------------------------------------------------------------------------
//
// The loop below is bounded at 2 LLM calls total, shared between two
// DIFFERENT kinds of provider failure:
//
//  1. STRUCTURAL failure — `runPlannerQuery` returns `{ plan: null }` because
//     `isSplitPlan` rejected the parsed output (wrong shape entirely: missing
//     keys, a `pr` wrapper, `files` instead of `changes`, etc. — see the
//     2026-07-02 dogfood failure). This is checked FIRST each attempt.
//  2. VALIDATION failure — the plan parsed into the right shape but
//     `validateSplitPlan` found deterministic issues (unassigned hunks, bad
//     topology, etc.). This is checked SECOND, only once a plan exists.
//
// Both kinds retry with a feedback addendum appended to the base prompt, but
// they share the SAME two-attempt budget — there is no separate "structural
// retry budget" on top of "validation retry budget". Concretely: attempt 1
// structural-fail -> attempt 2 with the structural addendum. If attempt 2
// also structurally fails, we throw the "no structured Split Plan" error
// (unchanged behavior, just reached one attempt later than before). If
// attempt 2 produces a plan that passes `isSplitPlan` but then FAILS
// `validateSplitPlan`, we do NOT spend a third call retrying validation — we
// go straight to surfacing the validation issues, because the loop has
// already exhausted its 2-call budget. This mirrors the pre-existing
// behavior where two validation failures in a row (with no structural issue)
// also stop after attempt 2 with issues surfaced rather than looping again.
//
// This single seam is shared by both providers (`runPlannerQuery` dispatches
// to Codex vs Claude internally), so hooking the retry here covers both
// without provider-specific branching. In practice this matters almost
// entirely for Codex: `runCodexStructuredHelperQuery` only conveys the schema
// as prose in `combinedPrompt`, so a wrong-shape response is plausible and
// returns `{ value: null }` rather than throwing (see
// `runCodexStructuredHelperQuery` in `structured-helper-query.ts`). Claude's
// path (`runStructuredHelper` / `runClaudeStructuredHelperQuery`) passes a
// real `outputFormat: { type: 'json_schema', schema }` to the SDK, so a
// structural mismatch is expected to be rare — but `isResult` can still
// return false there in principle (e.g. if the model's structured-output
// tool call is truncated), and the same generic retry seam handles it for
// free without any provider-specific code.

interface ObservedPlanningLoopArgs {
  projectId: string;
  worktreeId: string;
  inputs: PlanningInputs;
  model: string;
  thinkingLevel: ThinkingLevel;
  taskKey: string;
}

async function runPlanningLoop(
  args: ObservedPlanningLoopArgs,
): Promise<{ response: SplitPrPlanResponse; usage: HelperUsage }> {
  const { inputs } = args;
  const systemPrompt = buildSplitPlannerSystemPrompt();
  const baseUserPrompt = buildSplitPlannerUserPrompt({
    pr: {
      prNumber: inputs.originalPr.prNumber,
      title: inputs.prTitle,
      body: inputs.prBody,
      headBranch: inputs.originalPr.headBranch,
      baseBranch: inputs.originalPr.baseBranch,
      headSha: inputs.originalPr.headSha,
    },
    snapshot: inputs.snapshot,
    repoContext: inputs.repoContext,
  });

  let totalUsage: HelperUsage = {};
  let userMessage = baseUserPrompt;
  let lastErrors: SplitPlanIssue[] = [];
  const totalAttempts = 2;
  const workOwner =
    (await resolveInvocationWorkOwner({
      projectId: args.projectId,
      worktreeId: args.worktreeId,
    })) ?? null;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    let result: PlannerQueryResult;
    try {
      result = await runPlannerQuery({
        repoPath: inputs.repoPath,
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        model: args.model,
        thinkingLevel: args.thinkingLevel,
        systemPrompt,
        userMessage,
        taskKey: args.taskKey,
        workOwner,
      });
    } catch (error) {
      // Wrap provider failures so usage accrued on an earlier attempt is not
      // lost when finalizing the observed task.
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new PlanningLoopError(
        cause,
        mergeUsage(totalUsage, getStructuredHelperQueryErrorUsage(error) ?? {}),
      );
    }
    totalUsage = mergeUsage(totalUsage, result.usage);
    const isLastAttempt = attempt === totalAttempts - 1;
    if (!result.plan) {
      // Structural failure. Retry once with shape feedback if a call remains
      // in the shared budget; otherwise surface the existing error.
      if (!isLastAttempt) {
        userMessage = `${baseUserPrompt}\n\n${buildSplitPlanStructuralRetryAddendum()}`;
        continue;
      }
      throw new PlanningLoopError(
        new PrSplitPlanningError(
          'invalid_plan',
          'The Split PR planner returned no structured Split Plan.',
        ),
        totalUsage,
      );
    }
    const validation = validateSplitPlan(result.plan, inputs.snapshot);
    const errors = validation.issues.filter(
      (issue) => issue.severity === 'error',
    );
    if (errors.length === 0) {
      return {
        response: {
          plan: result.plan,
          snapshot: inputs.snapshot,
          originalPr: inputs.originalPr,
        },
        usage: totalUsage,
      };
    }
    lastErrors = errors;
    if (isLastAttempt) {
      break;
    }
    userMessage = `${baseUserPrompt}\n\n${buildSplitPlanValidationRetryAddendum(errors)}`;
  }
  throw new PlanningLoopError(
    new PrSplitPlanningError(
      'invalid_plan',
      `The Split PR planner produced an invalid plan after a retry: ${lastErrors
        .map((issue) => issue.message)
        .join('; ')}`,
      lastErrors,
    ),
    totalUsage,
  );
}

/** Internal wrapper carrying the accumulated usage across a failed loop. */
class PlanningLoopError extends Error {
  readonly cause: Error;
  readonly usage: HelperUsage;

  constructor(cause: Error, usage: HelperUsage) {
    super(cause.message);
    this.name = 'PlanningLoopError';
    this.cause = cause;
    this.usage = usage;
  }
}

// ---------------------------------------------------------------------------
// planPrSplit
// ---------------------------------------------------------------------------

export async function planPrSplit(
  options: PlanPrSplitOptions,
): Promise<SplitPrPlanResponse> {
  const { projectId, worktreeId } = options;
  const inputs = await gatherPlanningInputs(options);

  // Step 7 — E2E fixture hook: replaces only the LLM call (the refusals and
  // gathering above still ran); unreachable in production builds.
  const fixturePath = resolveSplitPlanFixturePath();
  if (fixturePath) {
    return buildFixturePlanResponse(fixturePath, inputs);
  }

  // Steps 5–6 — the observed LLM query with a single validation retry. The
  // observed task starts only here so pre-LLM refusals never create one.
  const preferences = await readPreferencesFile();
  const model = preferences.splitPrPlannerModel;
  const taskKey = `helper:pr-split-planning:${inputs.repoPath}:${Date.now()}`;
  startObservedHelperTask({
    taskKey,
    eventType: 'pr_split_planning',
    label: 'Split PR Planning',
    model,
    auditContext: { projectId, worktreeId },
  });

  try {
    const { response, usage } = await runPlanningLoop({
      projectId,
      worktreeId,
      inputs,
      model,
      thinkingLevel: preferences.splitPrPlannerThinkingLevel,
      taskKey,
    });
    finalizeObservedHelperTask(taskKey, 'success', undefined, usage);
    return response;
  } catch (error) {
    const unwrapped = error instanceof PlanningLoopError ? error.cause : error;
    const detail =
      unwrapped instanceof Error ? unwrapped.message : String(unwrapped);
    const loopUsage =
      error instanceof PlanningLoopError && hasUsageData(error.usage)
        ? error.usage
        : undefined;
    finalizeObservedHelperTask(
      taskKey,
      'failure',
      detail,
      loopUsage ?? getStructuredHelperQueryErrorUsage(unwrapped),
    );
    throw unwrapped instanceof Error ? unwrapped : new Error(detail);
  }
}
