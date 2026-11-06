import { existsSync } from 'node:fs';
import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  cancelBuild,
  isCodeGraphBuildPending,
} from '../code-graph/build-runner';
import {
  cancelCodeGraphFingerprint,
  runCodeGraphWorkerFingerprint,
} from '../code-graph/fingerprint-runner';
import { isCodeGraphAvailableForWorkspace } from './code-graph-availability';
import { isE2eBuild } from './e2e-gate';
import { isCoworkWorkspace } from './workspace-registry';
import {
  cancelScheduledCodeGraphBuilds,
  startScheduledCodeGraphBuild,
} from '../code-graph/scheduled-builds';
import { getWorktreeCodeGraphDbPath } from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import { resolveWorktreeCwd } from './resolve-worktree';
import { resolveWorktreeCodeGraphRepositories } from './worktree-repo-entries';
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
} from '@canopy/desktop-shared/types/code-graph';
import {
  clearCodeGraphWorktreeFingerprintCache,
  readPersistedCodeGraphWorktreeFingerprintSnapshot,
} from './code-graph-worktree-fingerprint';
import { readAllSidebarItems } from './sidebar-items';
import {
  clearCodeGraphFirstRequest,
  noteCodeGraphFirstRequest,
} from './code-graph-build-diagnostics';

/**
 * Reason a code-graph (re)build was requested. Currently informational only —
 * every reason funnels through the same debounce/coalesce path and the same
 * `buildOrUpdate` call (the engine itself decides full build vs. incremental
 * update). Kept as an explicit part of the contract so future callers (chat
 * activity, pipeline steps) document why they asked for a rebuild.
 */
export type CodeGraphBuildReason = 'worktree-created' | 'refresh';

/** The bounded signal that asked for a build, recorded with its run. */
export type CodeGraphRefreshSource =
  | 'worktree-created'
  | 'turn-diff'
  | 'diff-stats'
  | 'edit-during-build'
  | 'availability-reconcile'
  | 'unspecified';

export interface ScheduleCodeGraphBuildOptions {
  projectId: string;
  worktreeId: string;
  reason: CodeGraphBuildReason;
  /** Debounce window in ms. Creation defaults to 5s; refresh defaults to 20s. */
  debounceMs?: number;
  /** Bounded origin recorded with the scheduled build's initiated-work run. */
  source?: CodeGraphRefreshSource;
}

const PERFORMANCE_SCHEDULER_ENV = 'CANOPY_PERFORMANCE_CODE_GRAPH_SCHEDULER';

/**
 * The normal E2E build suppresses background graph mutation. The desktop
 * performance harness can opt one scenario back into this scheduler so it
 * measures the production debounce/fingerprint/build path rather than the
 * manual UI build IPC path. Production builds always return false because the
 * build-time E2E constant is false.
 */
export function isCodeGraphPerformanceSchedulerEnabled(
  e2eEnabled = isE2eBuild(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return e2eEnabled && env[PERFORMANCE_SCHEDULER_ENV] === '1';
}

const DEFAULT_CREATION_DEBOUNCE_MS = 5_000;
const DEFAULT_REFRESH_DEBOUNCE_MS = 20_000;

interface PendingBuildTimer {
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
  projectId: string;
  worktreeId: string;
  reason: CodeGraphBuildReason;
  source: CodeGraphRefreshSource;
  /** Earliest request this debounce coalesced (epoch ms), for diagnostics. */
  requestedAt: number;
}

const debounceTimers = new Map<string, PendingBuildTimer>();
const inFlight = new Set<string>();
const pendingRefire = new Map<
  string,
  {
    reason: CodeGraphBuildReason;
    source: CodeGraphRefreshSource;
    requestedAt: number;
  }
>();
const canceled = new Set<string>();
// Desktop-created worktrees defer their first graph seed/build until automatic
// setup settles; synchronous callers may already have an eager snapshot.
// Suppress diff-stat refreshes during that lifecycle so graph work does not
// compete with package installation either way.
const postCreateRefreshDeferred = new Map<string, symbol>();
const cancellationVersions = new Map<string, number>();

function buildKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

/**
 * Mirrors `code-graph-runtime.ts`'s `guardRejectionMessage` gate: a cowork
 * workspace or an assistant sentinel id (App Advisor / pipeline editor) is
 * never a valid code-graph target — graphs only exist for real git
 * worktrees. Deliberately duplicated (rather than imported) here so the
 * scheduler's dependency graph stays limited to lifecycle-scoped modules.
 */
function isSchedulableWorktree(projectId: string, worktreeId: string): boolean {
  if (isCoworkWorkspace(projectId)) {
    return false;
  }
  return !(
    projectId === APP_ADVISOR_PROJECT_ID ||
    (projectId === PIPELINE_EDITOR_PROJECT_ID &&
      worktreeId === PIPELINE_EDITOR_WORKTREE_ID)
  );
}

/**
 * Debounce + schedule a code-graph build/update for a worktree. No-op under
 * the UI-automation/E2E build (mutates disk state mid-test, mirroring
 * `worktree-summary-scheduler.ts`'s `scheduleSummaryGeneration` gate) and for
 * cowork/app-managed workspaces, which are never valid code-graph targets.
 *
 * Debounced and coalesced per `${projectId}/${worktreeId}`: repeated calls
 * within `debounceMs` collapse into a single build. A call that arrives while
 * a build for the same key is already running marks a pending refire and
 * returns immediately; the running build's `finally` block picks that up and
 * kicks off exactly one follow-up build once it settles.
 */
export function scheduleCodeGraphBuild(
  options: ScheduleCodeGraphBuildOptions,
): void {
  if (isE2eBuild() && !isCodeGraphPerformanceSchedulerEnabled()) {
    return;
  }
  if (!isSchedulableWorktree(options.projectId, options.worktreeId)) {
    return;
  }
  // Feature gate: when the code-graph feature is off, no graph builds. Covers
  // both worktree-create call sites (workspace-worktree-runtime.ts,
  // project-worktree-runtime.ts) since both funnel through here.
  if (!isCodeGraphAvailableForWorkspace(options.projectId)) {
    return;
  }

  const key = buildKey(options.projectId, options.worktreeId);
  if (options.reason === 'worktree-created') {
    postCreateRefreshDeferred.delete(key);
  }
  // Cancellation is a deletion tombstone. Only a new creation request may
  // clear it; late turn diffs/fingerprint checks must not resurrect graph.db.
  if (options.reason === 'refresh' && canceled.has(key)) {
    return;
  }
  canceled.delete(key);
  const source =
    options.source ??
    (options.reason === 'worktree-created'
      ? 'worktree-created'
      : 'unspecified');
  const debounceMs =
    options.debounceMs ??
    (options.reason === 'refresh'
      ? DEFAULT_REFRESH_DEBOUNCE_MS
      : DEFAULT_CREATION_DEBOUNCE_MS);
  const requestedAt = Date.now();
  const deadline = requestedAt + debounceMs;
  const existingTimer = debounceTimers.get(key);
  if (existingTimer?.deadline !== undefined) {
    // Never postpone a newly-created worktree's first graph. Refresh timers,
    // however, are true trailing-edge debounces so a burst of observed edits
    // gets one fingerprint check after the worktree becomes quiet.
    if (
      (existingTimer.reason === 'worktree-created' &&
        existingTimer.deadline <= deadline) ||
      (options.reason === 'worktree-created' &&
        existingTimer.deadline <= deadline)
    ) {
      return;
    }
    clearTimeout(existingTimer.timer);
  }
  const firstRequestedAt = Math.min(
    existingTimer?.requestedAt ?? requestedAt,
    requestedAt,
  );
  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    if (!isCodeGraphAvailableForWorkspace(options.projectId)) {
      return;
    }
    void runCodeGraphBuild(
      options.projectId,
      options.worktreeId,
      options.reason,
      source,
      firstRequestedAt,
    );
  }, debounceMs);
  debounceTimers.set(key, {
    timer,
    deadline,
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    reason: options.reason,
    source,
    requestedAt: firstRequestedAt,
  });
}

/** E2E performance seam for awaiting the production scheduler core. */
export async function runCodeGraphPerformanceBuild(options: {
  projectId: string;
  worktreeId: string;
}): Promise<boolean> {
  if (!isCodeGraphPerformanceSchedulerEnabled()) {
    return false;
  }
  await runCodeGraphBuild(
    options.projectId,
    options.worktreeId,
    'refresh',
    'unspecified',
    Date.now(),
    'in-process',
  );
  return true;
}

/** Schedules an edit-during-build follow-up unless cleanup canceled the key. */
export function scheduleCodeGraphFollowupBuild(
  options: Omit<ScheduleCodeGraphBuildOptions, 'reason'>,
): void {
  if (canceled.has(buildKey(options.projectId, options.worktreeId))) {
    return;
  }
  scheduleCodeGraphBuild({
    ...options,
    reason: 'refresh',
    source: options.source ?? 'edit-during-build',
  });
}

/** Fingerprint-gated refresh nudge used by periodic diff-stat activity. */
export function nudgeCodeGraphRefreshAfterDiffStats(
  projectId: string,
  worktreeId: string,
): void {
  if (
    isE2eBuild() ||
    !isCodeGraphAvailableForWorkspace(projectId) ||
    !isSchedulableWorktree(projectId, worktreeId)
  ) {
    return;
  }
  // Diff-stat polling is a refresh signal, not the owner of a worktree's first
  // graph. Creation eagerly installs a readable snapshot off-main before
  // git-ready; the post-create runtime owns its full refresh after setup. For
  // absent graphs, startup reconciliation and explicit tool calls remain the
  // authoritative cold-build paths.
  if (!existsSync(getWorktreeCodeGraphDbPath(projectId, worktreeId))) {
    return;
  }
  if (postCreateRefreshDeferred.has(buildKey(projectId, worktreeId))) {
    return;
  }
  scheduleCodeGraphBuild({
    projectId,
    worktreeId,
    reason: 'refresh',
    source: 'diff-stats',
  });
}

export function deferCodeGraphRefreshUntilPostCreateSetup(
  projectId: string,
  worktreeId: string,
): () => void {
  const key = buildKey(projectId, worktreeId);
  const token = Symbol(key);
  postCreateRefreshDeferred.set(key, token);
  return (): void => {
    if (postCreateRefreshDeferred.get(key) === token) {
      postCreateRefreshDeferred.delete(key);
    }
  };
}

/**
 * Cancels any pending debounced build for a worktree and clears its timer.
 * Composes with (does not replace) the off-main worker cancellation: this
 * also cancels any in-flight `runCodeGraphWorkerBuild` for the same key, so
 * a caller does not need to separately reach into `build-runner.ts` to stop
 * a build this scheduler kicked off.
 */
export function cancelCodeGraphBuilds(
  projectId: string,
  worktreeId: string,
  reason: 'canceled' | 'unavailable' = 'canceled',
): void {
  const key = buildKey(projectId, worktreeId);
  const existingTimer = debounceTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer.timer);
    debounceTimers.delete(key);
  }
  pendingRefire.delete(key);
  postCreateRefreshDeferred.delete(key);
  clearCodeGraphFirstRequest(key);
  canceled.add(key);
  cancellationVersions.set(key, (cancellationVersions.get(key) ?? 0) + 1);
  clearCodeGraphWorktreeFingerprintCache(
    getWorktreeCodeGraphDbPath(projectId, worktreeId),
  );
  // Fire-and-forget on purpose: this synchronous cancel path only needs the
  // worker kill ISSUED (cancelBuild never rejects). The one caller that must
  // wait for the killed worker to actually exit — worktree cleanup, before
  // it closes engines and removes worktree-data — awaits its own direct
  // cancelBuild call instead.
  cancelScheduledCodeGraphBuilds(
    projectId,
    worktreeId,
    reason === 'unavailable'
      ? 'Code graph generation is unavailable for this project.'
      : "This worktree's graph builds were canceled.",
  );
  if (reason === 'unavailable') {
    void cancelBuild(key, {
      reason,
      message: 'Code graph generation is unavailable for this project.',
    });
  } else {
    void cancelBuild(key);
  }
  void cancelCodeGraphFingerprint(key);
}

export async function reconcileCodeGraphSchedulerAvailability(): Promise<void> {
  for (const pending of Array.from(debounceTimers.values())) {
    if (!isCodeGraphAvailableForWorkspace(pending.projectId)) {
      cancelCodeGraphBuilds(
        pending.projectId,
        pending.worktreeId,
        'unavailable',
      );
    }
  }
  for (const key of Array.from(inFlight)) {
    const [projectId, worktreeId] = key.split('/');
    if (
      projectId &&
      worktreeId &&
      !isCodeGraphAvailableForWorkspace(projectId)
    ) {
      cancelCodeGraphBuilds(projectId, worktreeId, 'unavailable');
    }
  }

  const { items } = await readAllSidebarItems();
  for (const item of items) {
    if (item.type === 'cowork' || !isCodeGraphAvailableForWorkspace(item.id)) {
      continue;
    }
    for (const worktree of item.worktrees) {
      scheduleCodeGraphBuild({
        projectId: item.id,
        worktreeId: worktree.id,
        reason: 'worktree-created',
        debounceMs: 0,
        source: 'availability-reconcile',
      });
    }
  }
}

/**
 * Runs (or coalesces into) a single build for a worktree. Never throws — a
 * failure at any stage is recorded by the build's local diagnostic and
 * swallowed here so the caller's fire-and-forget
 * `void runCodeGraphBuild(...)` can never produce an unhandled rejection.
 */
async function runCodeGraphBuild(
  projectId: string,
  worktreeId: string,
  reason: CodeGraphBuildReason,
  source: CodeGraphRefreshSource,
  requestedAt: number,
  placement: 'default' | 'in-process' = 'default',
): Promise<void> {
  const key = buildKey(projectId, worktreeId);
  const cancellationVersion = cancellationVersions.get(key) ?? 0;
  if (!isCodeGraphAvailableForWorkspace(projectId)) {
    return;
  }
  if (inFlight.has(key)) {
    pendingRefire.set(key, {
      reason,
      source,
      requestedAt: Math.min(
        pendingRefire.get(key)?.requestedAt ?? requestedAt,
        requestedAt,
      ),
    });
    return;
  }

  inFlight.add(key);

  try {
    const fingerprintStartedAtMs = Date.now();
    let observedFingerprint: string;
    let observedFingerprintMs: number;
    try {
      const worktreePath = resolveWorktreeCwd(projectId, worktreeId);
      const repositories = await resolveWorktreeCodeGraphRepositories(
        projectId,
        worktreePath,
      );
      const response = await runCodeGraphWorkerFingerprint(key, repositories);
      if (!response.ok) {
        throw new Error(response.message);
      }
      observedFingerprint = response.fingerprint;
      const dbPath = getWorktreeCodeGraphDbPath(projectId, worktreeId);
      let persistedFingerprint =
        await readPersistedCodeGraphWorktreeFingerprintSnapshot(
          dbPath,
          // Same key the fingerprint worker above uses, so worktree cleanup's
          // `cancelCodeGraphReads` can drain this read before removing
          // `worktree-data/{worktreeId}`.
          key,
        );
      if (
        persistedFingerprint.cacheHit &&
        persistedFingerprint.derivedPending === true &&
        !isCodeGraphBuildPending(key)
      ) {
        // The cache is keyed by graph.db's stat, which a drain's WAL writes
        // can leave unchanged: confirm the analysis is still pending before
        // starting a build for it.
        clearCodeGraphWorktreeFingerprintCache(dbPath);
        persistedFingerprint =
          await readPersistedCodeGraphWorktreeFingerprintSnapshot(dbPath, key);
      }
      // A worktree without a completed graph is waiting for its first one;
      // the earliest request starts its time to first graph.
      if (!persistedFingerprint.readFailed) {
        if (persistedFingerprint.completed) clearCodeGraphFirstRequest(key);
        else noteCodeGraphFirstRequest(key, requestedAt);
      }
      if (persistedFingerprint.readFailed) {
        // Any read-worker failure leaves freshness unknown; in particular,
        // busy admission is not an absent/incomplete graph. Do not start a
        // build or seed fallback. A later scheduler trigger can retry after
        // the lane has capacity.
        return;
      }
      if (
        persistedFingerprint.schemaVersion !== null &&
        persistedFingerprint.schemaVersion > CODE_GRAPH_SCHEMA_VERSION
      ) {
        // A newer app version wrote this graph. Its build worker would refuse
        // the schema, and rebuilding over it would discard that version's data.
        return;
      }
      observedFingerprintMs = Date.now() - fingerprintStartedAtMs;
      // Derived analysis left pending by a worker that was stopped before it
      // finished (app quit, timeout) needs one more build, which publishes
      // nothing new and finishes the analysis. A build or derived drain
      // already running for the key will answer it, and a new build would
      // supersede that drain, so it is left alone.
      const derivedLeftPending =
        persistedFingerprint.derivedPending === true &&
        !isCodeGraphBuildPending(key);
      if (
        observedFingerprint === persistedFingerprint.fingerprint &&
        persistedFingerprint.schemaVersion === CODE_GRAPH_SCHEMA_VERSION &&
        persistedFingerprint.extractorVersion ===
          CODE_GRAPH_EXTRACTOR_VERSION &&
        !derivedLeftPending
      ) {
        return;
      }
    } catch {
      return;
    }

    // The build is core initiated work that dispatches
    // `worker.codeGraph.build` (CAN-5617); the run records whether it was
    // skipped, ran or failed. Code-graph builds are background maintenance,
    // not agent turns, so they deliberately do not enter the local agent
    // Audit Trail.
    await startScheduledCodeGraphBuild({
      projectId,
      worktreeId,
      trigger: reason,
      refreshSource: source,
      observedFingerprint,
      observedFingerprintMs,
      available: () => isCodeGraphAvailableForWorkspace(projectId),
      canceled: () =>
        cancellationVersion !== (cancellationVersions.get(key) ?? 0) ||
        canceled.has(key),
      // Performance runs keep every scheduler build in Electron main's
      // hosts, whatever triggered it, as the harness measures them (CAN-5719).
      placement: isCodeGraphPerformanceSchedulerEnabled()
        ? 'in-process'
        : placement,
    });
  } catch {
    // Best-effort: a scheduled code-graph build must never produce an
    // unhandled rejection.
  } finally {
    inFlight.delete(key);
    const wasCanceled = canceled.has(key);
    const refire = pendingRefire.get(key);
    pendingRefire.delete(key);
    if (
      refire !== undefined &&
      !wasCanceled &&
      isCodeGraphAvailableForWorkspace(projectId)
    ) {
      void runCodeGraphBuild(
        projectId,
        worktreeId,
        refire.reason,
        refire.source,
        refire.requestedAt,
      );
    }
  }
}
