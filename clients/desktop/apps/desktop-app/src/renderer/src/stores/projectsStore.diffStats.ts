/**
 * Pure helpers extracted from {@link
 * import('./projectsStore').useProjectsStore}'s `runRefreshDiffStatsOnce`.
 * Each helper has a single, narrow responsibility and is tested in
 * `projectsStore.test.ts` so the store body can stay focused on
 * stale-generation guards, queueing, and IPC orchestration.
 *
 * These helpers are intentionally side-effect free apart from the explicit
 * "side-effect" entry points (`invalidateChangedFileLists`,
 * `registerPrPolling`) which take their effect callbacks as arguments so the
 * helper can be tested without touching the file-list / GitHub stores.
 */
import type {
  DiffStats,
  DiffStatsBatchResponseItem,
  RepoBranchInfo,
  SidebarItem,
  WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';

export function createDiffStatsKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${projectId}/${worktreeId}`;
}

export interface RefreshableWorktreeRef {
  projectId: string;
  worktreeId: string;
}

export function getSidebarStatsRequestMode(
  worktreeKey: string,
  foregroundKey: string | null,
  hasAuthoritativeMetadataSnapshot: boolean,
): 'full' | 'diff_only' {
  return worktreeKey === foregroundKey || !hasAuthoritativeMetadataSnapshot
    ? 'full'
    : 'diff_only';
}

export function shouldPollSidebarStats(params: {
  visibilityState: DocumentVisibilityState;
  hasFocus: boolean;
}): boolean {
  return params.visibilityState === 'visible' && params.hasFocus;
}

/**
 * Splits the projects' worktrees into the subset eligible for a fresh stats
 * pull and the keys of those still in the `git-pending` setup phase. Keeps the
 * helper deterministic so tests can pass plain projects without rebuilding the
 * full sidebar shape.
 */
export function collectRefreshableWorktrees(projects: SidebarItem[]): {
  refreshableWorktrees: RefreshableWorktreeRef[];
  pendingWorktreeKeys: Set<string>;
  totalCount: number;
} {
  const allWorktrees = projects.flatMap((item) =>
    item.type === 'cowork'
      ? []
      : item.worktrees.map((wt) => ({
          projectId: item.id,
          worktreeId: wt.id,
          setupPhase: wt.setupPhase,
        })),
  );
  const refreshableWorktrees = allWorktrees
    .filter((worktree) => worktree.setupPhase !== 'git-pending')
    .map(({ projectId, worktreeId }) => ({ projectId, worktreeId }));
  const pendingWorktreeKeys = new Set(
    allWorktrees
      .filter((worktree) => worktree.setupPhase === 'git-pending')
      .map((worktree) =>
        createDiffStatsKey(worktree.projectId, worktree.worktreeId),
      ),
  );
  return {
    refreshableWorktrees,
    pendingWorktreeKeys,
    totalCount: allWorktrees.length,
  };
}

export interface DiffStatsState {
  diffStats: Record<string, DiffStats>;
  commitsAhead: Record<string, boolean>;
  baseBranches: Record<string, string | null>;
  defaultBranches: Record<string, string | null>;
  uncommittedChanges: Record<string, boolean>;
  hasRemoteTracking: Record<string, boolean>;
  hasOriginRemote: Record<string, boolean>;
  hasBranchBeenPushed: Record<string, boolean>;
  hasUnpushedCommits: Record<string, boolean>;
  hasUnpulledCommits: Record<string, boolean>;
  repoBranches: Record<string, RepoBranchInfo[]>;
  baseBranchExistsLocally: Record<string, boolean>;
  baseBranchExistsInRemote: Record<string, boolean>;
}

/** Empty next-state used when there are no worktrees to refresh. */
export function emptyDiffStatsState(): DiffStatsState {
  return {
    diffStats: {},
    commitsAhead: {},
    baseBranches: {},
    defaultBranches: {},
    uncommittedChanges: {},
    hasRemoteTracking: {},
    hasOriginRemote: {},
    hasBranchBeenPushed: {},
    hasUnpushedCommits: {},
    hasUnpulledCommits: {},
    repoBranches: {},
    baseBranchExistsLocally: {},
    baseBranchExistsInRemote: {},
  };
}

function retainMapKeys<T>(
  source: Record<string, T>,
  validKeys: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => validKeys.has(key)),
  );
}

/** Removes cached stats for worktrees that no longer exist. */
export function pruneDiffStatsState(
  state: DiffStatsState,
  validKeys: ReadonlySet<string>,
): DiffStatsState {
  return {
    diffStats: retainMapKeys(state.diffStats, validKeys),
    commitsAhead: retainMapKeys(state.commitsAhead, validKeys),
    baseBranches: retainMapKeys(state.baseBranches, validKeys),
    defaultBranches: retainMapKeys(state.defaultBranches, validKeys),
    uncommittedChanges: retainMapKeys(state.uncommittedChanges, validKeys),
    hasRemoteTracking: retainMapKeys(state.hasRemoteTracking, validKeys),
    hasOriginRemote: retainMapKeys(state.hasOriginRemote, validKeys),
    hasBranchBeenPushed: retainMapKeys(state.hasBranchBeenPushed, validKeys),
    hasUnpushedCommits: retainMapKeys(state.hasUnpushedCommits, validKeys),
    hasUnpulledCommits: retainMapKeys(state.hasUnpulledCommits, validKeys),
    repoBranches: retainMapKeys(state.repoBranches, validKeys),
    baseBranchExistsLocally: retainMapKeys(
      state.baseBranchExistsLocally,
      validKeys,
    ),
    baseBranchExistsInRemote: retainMapKeys(
      state.baseBranchExistsInRemote,
      validKeys,
    ),
  };
}

function mapKeysEqual<T>(
  left: Record<string, T>,
  right: Record<string, T>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key))
  );
}

function stabilizeMap<T>(
  previous: Record<string, T>,
  next: Record<string, T>,
  equal: (left: T, right: T) => boolean,
): { map: Record<string, T>; changed: boolean } {
  let changed = !mapKeysEqual(previous, next);
  const stabilized: Record<string, T> = {};

  for (const [key, nextValue] of Object.entries(next)) {
    const previousValue = previous[key];
    if (previousValue !== undefined && equal(previousValue, nextValue)) {
      stabilized[key] = previousValue;
      continue;
    }
    stabilized[key] = nextValue;
    changed = true;
  }

  return { map: changed ? stabilized : previous, changed };
}

function diffStatsEqual(left: DiffStats, right: DiffStats): boolean {
  return (
    left.insertions === right.insertions && left.deletions === right.deletions
  );
}

function primitiveEqual<T>(left: T, right: T): boolean {
  return left === right;
}

function repoBranchInfoEqual(
  left: RepoBranchInfo,
  right: RepoBranchInfo,
): boolean {
  return (
    left.repoId === right.repoId &&
    left.repoName === right.repoName &&
    left.branch === right.branch &&
    left.baseBranch === right.baseBranch &&
    left.insertions === right.insertions &&
    left.deletions === right.deletions &&
    left.commitsAhead === right.commitsAhead &&
    left.hasUncommittedChanges === right.hasUncommittedChanges &&
    left.hasRemoteTrackingBranch === right.hasRemoteTrackingBranch &&
    left.hasUnpushedCommits === right.hasUnpushedCommits &&
    left.hasUnpulledCommits === right.hasUnpulledCommits &&
    left.hasBranchBeenPushed === right.hasBranchBeenPushed &&
    left.baseBranchExistsLocally === right.baseBranchExistsLocally &&
    left.baseBranchExistsInRemote === right.baseBranchExistsInRemote &&
    left.hasOriginRemote === right.hasOriginRemote
  );
}

function repoBranchInfoListEqual(
  left: RepoBranchInfo[],
  right: RepoBranchInfo[],
): boolean {
  return (
    left.length === right.length &&
    left.every((repo, index) => repoBranchInfoEqual(repo, right[index]))
  );
}

export function stabilizeDiffStatsState(
  previous: DiffStatsState,
  next: DiffStatsState,
): { state: DiffStatsState; changed: boolean } {
  const diffStats = stabilizeMap(
    previous.diffStats,
    next.diffStats,
    diffStatsEqual,
  );
  const commitsAhead = stabilizeMap(
    previous.commitsAhead,
    next.commitsAhead,
    primitiveEqual,
  );
  const baseBranches = stabilizeMap(
    previous.baseBranches,
    next.baseBranches,
    primitiveEqual,
  );
  const defaultBranches = stabilizeMap(
    previous.defaultBranches,
    next.defaultBranches,
    primitiveEqual,
  );
  const uncommittedChanges = stabilizeMap(
    previous.uncommittedChanges,
    next.uncommittedChanges,
    primitiveEqual,
  );
  const hasRemoteTracking = stabilizeMap(
    previous.hasRemoteTracking,
    next.hasRemoteTracking,
    primitiveEqual,
  );
  const hasOriginRemote = stabilizeMap(
    previous.hasOriginRemote,
    next.hasOriginRemote,
    primitiveEqual,
  );
  const hasBranchBeenPushed = stabilizeMap(
    previous.hasBranchBeenPushed,
    next.hasBranchBeenPushed,
    primitiveEqual,
  );
  const hasUnpushedCommits = stabilizeMap(
    previous.hasUnpushedCommits,
    next.hasUnpushedCommits,
    primitiveEqual,
  );
  const hasUnpulledCommits = stabilizeMap(
    previous.hasUnpulledCommits,
    next.hasUnpulledCommits,
    primitiveEqual,
  );
  const repoBranches = stabilizeMap(
    previous.repoBranches,
    next.repoBranches,
    repoBranchInfoListEqual,
  );
  const baseBranchExistsLocally = stabilizeMap(
    previous.baseBranchExistsLocally,
    next.baseBranchExistsLocally,
    primitiveEqual,
  );
  const baseBranchExistsInRemote = stabilizeMap(
    previous.baseBranchExistsInRemote,
    next.baseBranchExistsInRemote,
    primitiveEqual,
  );
  const changed =
    diffStats.changed ||
    commitsAhead.changed ||
    baseBranches.changed ||
    defaultBranches.changed ||
    uncommittedChanges.changed ||
    hasRemoteTracking.changed ||
    hasOriginRemote.changed ||
    hasBranchBeenPushed.changed ||
    hasUnpushedCommits.changed ||
    hasUnpulledCommits.changed ||
    repoBranches.changed ||
    baseBranchExistsLocally.changed ||
    baseBranchExistsInRemote.changed;

  return {
    state: changed
      ? {
          diffStats: diffStats.map,
          commitsAhead: commitsAhead.map,
          baseBranches: baseBranches.map,
          defaultBranches: defaultBranches.map,
          uncommittedChanges: uncommittedChanges.map,
          hasRemoteTracking: hasRemoteTracking.map,
          hasOriginRemote: hasOriginRemote.map,
          hasBranchBeenPushed: hasBranchBeenPushed.map,
          hasUnpushedCommits: hasUnpushedCommits.map,
          hasUnpulledCommits: hasUnpulledCommits.map,
          repoBranches: repoBranches.map,
          baseBranchExistsLocally: baseBranchExistsLocally.map,
          baseBranchExistsInRemote: baseBranchExistsInRemote.map,
        }
      : previous,
    changed,
  };
}

export interface BuildDiffStatsResult extends DiffStatsState {
  branchUpdates: Map<string, string>;
  healthUpdates: Map<string, WorktreeHealthIssue | null>;
  /** Lightweight rows update only their badge and preserve prior metadata. */
  diffOnlyKeys: Set<string>;
  /** Keys flagged as broken by the backend. Aggregate diff maps skip these
   * to avoid showing stale stats; the per-repo `repoBranches` map still
   * populates so the branch info modal can surface healthy child repos. */
  brokenKeys: Set<string>;
}

/**
 * Builds the next aggregate diff-stats state and the metadata-update maps
 * from a backend batch response. Pending worktrees seed `healthUpdates` so a
 * later in-flight setup completes cleanly and clears any stale health issue.
 */
export function buildDiffStatsState(
  response: DiffStatsBatchResponseItem[],
  pendingWorktreeKeys: Set<string>,
): BuildDiffStatsResult {
  const next = emptyDiffStatsState();
  const branchUpdates = new Map<string, string>();
  const healthUpdates = new Map<string, WorktreeHealthIssue | null>();
  const brokenKeys = new Set<string>();
  const diffOnlyKeys = new Set<string>();

  pendingWorktreeKeys.forEach((pendingKey) => {
    healthUpdates.set(pendingKey, null);
  });

  for (const item of response) {
    const key = createDiffStatsKey(item.projectId, item.worktreeId);

    if (item.mode === 'diff_only') {
      diffOnlyKeys.add(key);
      next.diffStats[key] = {
        insertions: item.insertions,
        deletions: item.deletions,
      };
      continue;
    }

    if (item.healthIssue) {
      healthUpdates.set(key, item.healthIssue);
    } else {
      healthUpdates.set(key, null);
    }

    if (item.healthIssue?.status === 'broken') {
      brokenKeys.add(key);
      if (item.repoBranches) {
        next.repoBranches[key] = item.repoBranches;
      }
      continue;
    }

    next.diffStats[key] = {
      insertions: item.insertions,
      deletions: item.deletions,
    };
    next.commitsAhead[key] = item.hasCommitsAhead ?? false;
    if (item.baseBranch !== undefined) {
      next.baseBranches[key] = item.baseBranch;
    }
    if (item.defaultBranch !== undefined) {
      next.defaultBranches[key] = item.defaultBranch;
    }
    next.uncommittedChanges[key] = item.hasUncommittedChanges ?? false;
    next.hasRemoteTracking[key] = item.hasRemoteTrackingBranch ?? false;
    next.hasOriginRemote[key] = item.hasOriginRemote ?? true;
    next.hasBranchBeenPushed[key] = item.hasBranchBeenPushed ?? false;
    next.hasUnpushedCommits[key] = item.hasUnpushedCommits ?? false;
    next.hasUnpulledCommits[key] = item.hasUnpulledCommits ?? false;
    next.baseBranchExistsLocally[key] = item.baseBranchExistsLocally ?? false;
    next.baseBranchExistsInRemote[key] = item.baseBranchExistsInRemote ?? false;

    if (item.branchName) {
      branchUpdates.set(key, item.branchName);
    }

    if (item.repoBranches) {
      next.repoBranches[key] = item.repoBranches;
    }
  }

  return {
    ...next,
    branchUpdates,
    healthUpdates,
    brokenKeys,
    diffOnlyKeys,
  };
}

function healthIssuesEqual(
  a: WorktreeHealthIssue | null | undefined,
  b: WorktreeHealthIssue | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.checkedAt === b.checkedAt &&
    a.code === b.code &&
    a.message === b.message &&
    a.gitError === b.gitError &&
    a.worktreePath === b.worktreePath
  );
}

/**
 * Detects whether `branchUpdates` or `healthUpdates` carry any change vs the
 * current `projects` snapshot. The store uses both flags to decide whether to
 * fan out a `setProjects` write — `hasBranchChange` additionally triggers
 * persistence (backend owns persistence for health changes).
 */
export function detectProjectMetadataChanges(
  projects: SidebarItem[],
  branchUpdates: Map<string, string>,
  healthUpdates: Map<string, WorktreeHealthIssue | null>,
): { hasBranchChange: boolean; hasHealthChange: boolean } {
  let hasBranchChange = false;
  let hasHealthChange = false;
  for (const project of projects) {
    if (project.type === 'cowork') {
      continue;
    }

    for (const wt of project.worktrees) {
      const key = createDiffStatsKey(project.id, wt.id);
      const newBranch = branchUpdates.get(key);
      if (newBranch && newBranch !== wt.branchName) {
        hasBranchChange = true;
      }
      if (healthUpdates.has(key)) {
        const nextIssue = healthUpdates.get(key) ?? null;
        const currentIssue = wt.healthIssue ?? null;
        if (!healthIssuesEqual(currentIssue, nextIssue)) {
          hasHealthChange = true;
        }
      }
      if (hasBranchChange && hasHealthChange) {
        return { hasBranchChange, hasHealthChange };
      }
    }
  }
  return { hasBranchChange, hasHealthChange };
}

/**
 * Returns a new projects array with `branchName` and `healthIssue` updated to
 * match the supplied maps. Always returns a new top-level array; only updates
 * the worktree objects whose values actually change so React reference checks
 * stay stable for unaffected rows.
 */
export function applyProjectMetadataChanges(
  projects: SidebarItem[],
  branchUpdates: Map<string, string>,
  healthUpdates: Map<string, WorktreeHealthIssue | null>,
): SidebarItem[] {
  return projects.map((project) => {
    if (project.type === 'cowork') {
      return project;
    }

    return {
      ...project,
      worktrees: project.worktrees.map((wt) => {
        const key = createDiffStatsKey(project.id, wt.id);
        const newBranch = branchUpdates.get(key);
        let next = wt;
        if (newBranch && newBranch !== wt.branchName) {
          next = { ...next, branchName: newBranch };
        }
        if (healthUpdates.has(key)) {
          const nextIssue = healthUpdates.get(key);
          if (nextIssue) {
            if (!healthIssuesEqual(wt.healthIssue, nextIssue)) {
              next = { ...next, healthIssue: nextIssue };
            }
          } else if (wt.healthIssue) {
            const { healthIssue: _removed, ...rest } = next;
            void _removed;
            next = rest;
          }
        }
        return next;
      }),
    };
  });
}

/**
 * Invokes `invalidate` for every key whose diff stats appeared, disappeared,
 * or changed values across the refresh. Pulled out so the file-list-store
 * coupling is testable without spinning up the full store.
 */
export function invalidateChangedFileLists(
  previousDiffStats: Record<string, DiffStats>,
  nextDiffStats: Record<string, DiffStats>,
  invalidate: (projectId: string, worktreeId: string) => void,
): void {
  for (const [key, stats] of Object.entries(nextDiffStats)) {
    const previous = previousDiffStats[key];
    if (
      !previous ||
      previous.insertions !== stats.insertions ||
      previous.deletions !== stats.deletions
    ) {
      const [projectId, worktreeId] = key.split('/');
      if (projectId && worktreeId) {
        invalidate(projectId, worktreeId);
      }
    }
  }

  // Invalidate when diff keys disappear (e.g. files deleted or worktree
  // newly marked broken and filtered out).
  for (const key of Object.keys(previousDiffStats)) {
    if (!nextDiffStats[key]) {
      const [projectId, worktreeId] = key.split('/');
      if (projectId && worktreeId) {
        invalidate(projectId, worktreeId);
      }
    }
  }
}

function hasLineChanges(
  stats: { insertions?: number; deletions?: number } | undefined,
): boolean {
  return Boolean(
    stats && ((stats.insertions ?? 0) > 0 || (stats.deletions ?? 0) > 0),
  );
}

function isAggregateRemoteBackedComparison(
  key: string,
  hasOriginRemote: Record<string, boolean>,
  baseBranchExistsInRemote: Record<string, boolean>,
): boolean {
  return (
    hasOriginRemote[key] !== false && baseBranchExistsInRemote[key] === true
  );
}

function isRemoteBackedRepoComparison(
  previousRepo: RepoBranchInfo,
  nextRepo: RepoBranchInfo,
): boolean {
  return (
    previousRepo.hasOriginRemote !== false &&
    previousRepo.baseBranchExistsInRemote === true &&
    nextRepo.hasOriginRemote !== false &&
    nextRepo.baseBranchExistsInRemote === true
  );
}

function hasRemoteBackedRepoCleanTransition(
  previousRepos: RepoBranchInfo[],
  nextRepos: RepoBranchInfo[],
): boolean {
  const previousByRepoId = new Map(
    previousRepos.map((repo) => [repo.repoId, repo]),
  );

  return nextRepos.some((nextRepo) => {
    const previousRepo = previousByRepoId.get(nextRepo.repoId);
    return (
      previousRepo !== undefined &&
      isRemoteBackedRepoComparison(previousRepo, nextRepo) &&
      hasLineChanges(previousRepo) &&
      !hasLineChanges(nextRepo)
    );
  });
}

/**
 * Returns worktrees whose remote-backed diff comparison just collapsed from
 * changed to clean. That is a strong signal that an open PR may have just been
 * merged, so callers should promote the PR-status refresh for those worktrees.
 */
export function collectRemoteCleanDiffStatTransitions(
  previousDiffStats: Record<string, DiffStats>,
  nextDiffStats: Record<string, DiffStats>,
  previousHasOriginRemote: Record<string, boolean>,
  previousBaseBranchExistsInRemote: Record<string, boolean>,
  previousRepoBranches: Record<string, RepoBranchInfo[]>,
  nextHasOriginRemote: Record<string, boolean>,
  nextBaseBranchExistsInRemote: Record<string, boolean>,
  nextRepoBranches: Record<string, RepoBranchInfo[]>,
): RefreshableWorktreeRef[] {
  const transitions: RefreshableWorktreeRef[] = [];

  for (const [key, stats] of Object.entries(nextDiffStats)) {
    const previousRepos = previousRepoBranches[key];
    const nextRepos = nextRepoBranches[key];
    const hasPerRepoStats =
      (previousRepos?.length ?? 0) > 0 || (nextRepos?.length ?? 0) > 0;

    if (hasPerRepoStats) {
      if (
        !hasRemoteBackedRepoCleanTransition(
          previousRepos ?? [],
          nextRepos ?? [],
        )
      ) {
        continue;
      }

      const [projectId, worktreeId] = key.split('/');
      if (projectId && worktreeId) {
        transitions.push({ projectId, worktreeId });
      }
      continue;
    }

    if (!hasLineChanges(previousDiffStats[key]) || hasLineChanges(stats)) {
      continue;
    }

    if (
      !isAggregateRemoteBackedComparison(
        key,
        previousHasOriginRemote,
        previousBaseBranchExistsInRemote,
      ) ||
      !isAggregateRemoteBackedComparison(
        key,
        nextHasOriginRemote,
        nextBaseBranchExistsInRemote,
      )
    ) {
      continue;
    }

    const [projectId, worktreeId] = key.split('/');
    if (projectId && worktreeId) {
      transitions.push({ projectId, worktreeId });
    }
  }

  return transitions;
}

/**
 * Registers any newly-seen worktrees for background PR polling. The caller
 * owns the `registered` set so the same set persists across calls (used to
 * prevent re-registration). `requestRefresh` is the call to make exactly once
 * per first-seen key.
 */
export function registerPrPolling(
  nextCommitsAhead: Record<string, boolean>,
  registered: Set<string>,
  requestRefresh: (projectId: string, worktreeId: string) => void,
): void {
  for (const key of Object.keys(nextCommitsAhead)) {
    if (registered.has(key)) continue;
    registered.add(key);
    const [projectId, worktreeId] = key.split('/');
    if (projectId && worktreeId) {
      requestRefresh(projectId, worktreeId);
    }
  }
}

// ---------------------------------------------------------------------------
// Adaptive per-worktree polling (foreground priority + background backoff)
// ---------------------------------------------------------------------------

/** Cadence for the foreground worktree while the app is active. */
export const DIFF_STATS_BASE_POLL_INTERVAL_MS = 30_000;
/** Background rows trade status freshness for a substantially lower Git tax. */
export const DIFF_STATS_BACKGROUND_POLL_INTERVAL_MS = 10 * 60_000;
/** Activity remains recent for this long after the last observed signal. */
export const DIFF_STATS_RECENT_ACTIVITY_WINDOW_MS = 15 * 60_000;
/** Very slow cadence for worktrees with no recent user/runtime/Git activity. */
export const DIFF_STATS_MAX_POLL_INTERVAL_MS = 60 * 60_000;
/**
 * Maximum background worktrees refreshed per scheduler tick. Bounds the burst
 * of git work one tick can queue in the main process; overdue worktrees not
 * picked this tick stay due and are drained on subsequent ticks (oldest due
 * first).
 */
export const DIFF_STATS_BACKGROUND_BATCH_LIMIT = 4;

export interface WorktreeDiffStatsPollState {
  intervalMs: number;
  nextDueAtMs: number;
  lastChangeSignature: string | null;
}

/**
 * Stable digest of the fields whose change should reset a worktree's polling
 * backoff. Anything the sidebar/branch surfaces render is included; transient
 * fields (health `checkedAt`) are not, so a re-check without a state change
 * still backs off.
 */
export function buildDiffStatsChangeSignature(
  item: DiffStatsBatchResponseItem,
): string {
  if (item.mode === 'diff_only') {
    return JSON.stringify(['diff_only', item.insertions, item.deletions]);
  }
  return JSON.stringify([
    item.insertions,
    item.deletions,
    item.branchName ?? null,
    item.baseBranch ?? null,
    item.defaultBranch ?? null,
    item.hasCommitsAhead ?? null,
    item.hasUncommittedChanges ?? null,
    item.hasRemoteTrackingBranch ?? null,
    item.hasOriginRemote ?? null,
    item.hasBranchBeenPushed ?? null,
    item.hasUnpushedCommits ?? null,
    item.hasUnpulledCommits ?? null,
    item.baseBranchExistsLocally ?? null,
    item.baseBranchExistsInRemote ?? null,
    item.canopyJsonHash ?? null,
    item.healthIssue?.code ?? null,
    (item.repoBranches ?? []).map((repo) => [
      repo.repoId,
      repo.branch,
      repo.baseBranch,
      repo.insertions,
      repo.deletions,
      repo.commitsAhead,
      repo.hasUncommittedChanges,
      repo.hasUnpushedCommits,
      repo.hasUnpulledCommits,
      repo.hasBranchBeenPushed,
    ]),
  ]);
}

export interface ScheduledDiffStatsBatchPlan {
  batch: RefreshableWorktreeRef[];
  /** Poll-state keys for worktrees that no longer exist. */
  prunedKeys: string[];
}

/**
 * Picks this tick's refresh batch: the foreground worktree always refreshes,
 * due recently-active worktrees come next in most-recently-active order, and
 * inactive worktrees use the remaining slots oldest-due first. Worktrees
 * without poll state count as immediately due for their initial observation.
 */
export function planScheduledDiffStatsBatch(params: {
  worktrees: RefreshableWorktreeRef[];
  pollStates: ReadonlyMap<string, WorktreeDiffStatsPollState>;
  activityAtMs: ReadonlyMap<string, number>;
  foregroundKey: string | null;
  nowMs: number;
  batchLimit: number;
  recentActivityWindowMs?: number;
}): ScheduledDiffStatsBatchPlan {
  const validKeys = new Set(
    params.worktrees.map((worktree) =>
      createDiffStatsKey(worktree.projectId, worktree.worktreeId),
    ),
  );
  const prunedKeys = Array.from(params.pollStates.keys()).filter(
    (key) => !validKeys.has(key),
  );

  const foreground: RefreshableWorktreeRef[] = [];
  const dueRecent: Array<{
    worktree: RefreshableWorktreeRef;
    activityAtMs: number;
    dueAtMs: number;
  }> = [];
  const dueInactive: Array<{
    worktree: RefreshableWorktreeRef;
    dueAtMs: number;
  }> = [];
  const recentCutoffMs =
    params.nowMs -
    (params.recentActivityWindowMs ?? DIFF_STATS_RECENT_ACTIVITY_WINDOW_MS);
  for (const worktree of params.worktrees) {
    const key = createDiffStatsKey(worktree.projectId, worktree.worktreeId);
    if (key === params.foregroundKey) {
      foreground.push(worktree);
      continue;
    }
    const state = params.pollStates.get(key);
    const dueAtMs = state?.nextDueAtMs ?? 0;
    if (dueAtMs <= params.nowMs) {
      const activityAt = params.activityAtMs.get(key) ?? 0;
      if (activityAt >= recentCutoffMs) {
        dueRecent.push({ worktree, activityAtMs: activityAt, dueAtMs });
      } else {
        dueInactive.push({ worktree, dueAtMs });
      }
    }
  }
  dueRecent.sort(
    (left, right) =>
      right.activityAtMs - left.activityAtMs || left.dueAtMs - right.dueAtMs,
  );
  dueInactive.sort((left, right) => left.dueAtMs - right.dueAtMs);

  return {
    batch: [
      ...foreground,
      ...[...dueRecent, ...dueInactive]
        .slice(0, params.batchLimit)
        .map((entry) => entry.worktree),
    ],
    prunedKeys,
  };
}

/**
 * Next poll state after a refresh: the foreground uses the fast cadence;
 * explicitly-triggered, recently-active, and changed background worktrees use
 * the throttled background cadence. Inactive worktrees use the slowest loop.
 */
export function computeNextDiffStatsPollState(params: {
  previous: WorktreeDiffStatsPollState | undefined;
  signature: string;
  isForeground: boolean;
  isRecentlyActive: boolean;
  forceReset: boolean;
  nowMs: number;
}): WorktreeDiffStatsPollState {
  const changed =
    !params.previous ||
    params.previous.lastChangeSignature !== params.signature;
  const intervalMs = params.isForeground
    ? DIFF_STATS_BASE_POLL_INTERVAL_MS
    : params.isRecentlyActive || params.forceReset || changed
      ? DIFF_STATS_BACKGROUND_POLL_INTERVAL_MS
      : DIFF_STATS_MAX_POLL_INTERVAL_MS;
  return {
    intervalMs,
    nextDueAtMs: params.nowMs + intervalMs,
    lastChangeSignature: params.signature,
  };
}
