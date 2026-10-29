import {
  isSplitPrEligible,
  useGitHubStore,
  worktreeKey,
} from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { createDiffStatsKey } from '@/stores/projectsStore.diffStats';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useChatStore } from '@/stores/chatStore';
import { useSplitPrPreferencesStore } from '@/hooks/useSplitPrPreferences';
import type {
  SplitPrBlocker,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';

/**
 * The exact input shape `isSplitPrEligible` (in `@/stores/githubStore`)
 * consumes.
 */
export type SplitPrEligibilityInputs = Parameters<typeof isSplitPrEligible>[0];

/**
 * Shapes raw PR status / diff stats / gating-preference state into
 * `isSplitPrEligible`'s input contract for a `(projectId, worktreeId)`.
 *
 * Pure and side-effect free: callers own how they source `prStatus`,
 * `diffStats`, and the gating preferences (a reactive Zustand subscription
 * in `PullRequestSection` so the panel re-renders on change, or an
 * imperative `getState()` read in the App Advisor `github.split_pr`
 * dispatcher, which runs outside any component). This keeps both callers
 * deriving eligibility from identical logic instead of two independently
 * maintained ~50-line read/derive blocks that can silently drift.
 *
 * `isSingleRepo` is a caller-supplied input rather than derived here because
 * each caller computes it from a different source (workspace-record type in
 * the dispatcher, an `isSingleRepoWorkspace` lookup in the PR panel, a
 * `isMultiRepo === false` row flag in `WorktreeItem`).
 */
export function deriveSplitPrEligibilityInputs(args: {
  prStatus: WorktreePrStatus | null | undefined;
  diffStats: { insertions: number; deletions: number } | undefined;
  splitPrEnabled: boolean;
  thresholdLines: number;
  isSingleRepo: boolean;
}): SplitPrEligibilityInputs {
  const { prStatus, diffStats, splitPrEnabled, thresholdLines, isSingleRepo } =
    args;
  const singleRepoPrData =
    prStatus && prStatus.repos.length === 1
      ? (prStatus.repos[0].status ?? undefined)
      : undefined;

  return {
    prState: singleRepoPrData?.state,
    prAdditions: singleRepoPrData?.additions,
    prDeletions: singleRepoPrData?.deletions,
    diffStats,
    splitPrEnabled,
    thresholdLines,
    isSingleRepo,
  };
}

/**
 * Convenience wrapper for imperative (non-component) callers such as the App
 * Advisor `github.split_pr` dispatcher: reads current store state via
 * `getState()` (safe outside React) and derives the eligibility inputs for a
 * `(projectId, worktreeId)`.
 *
 * `getPrStatus`/`getDiffStats` each receive the raw `projectId`/`worktreeId`
 * pair rather than a single pre-joined key, so each accessor keys its own
 * store lookup with that store's own key helper (`worktreeKey` for
 * `prStatuses`, `createDiffStatsKey` for `diffStats`) instead of relying on
 * the two key formats happening to be identical strings.
 */
export function gatherSplitPrEligibilityInputs(
  projectId: string,
  worktreeId: string,
  isSingleRepo: boolean,
  stores: {
    getPrStatus: (
      projectId: string,
      worktreeId: string,
    ) => WorktreePrStatus | null | undefined;
    getDiffStats: (
      projectId: string,
      worktreeId: string,
    ) => { insertions: number; deletions: number } | undefined;
    getGatingPreferences: () => {
      splitPrEnabled: boolean;
      splitPrThresholdLines: number;
    };
  },
): SplitPrEligibilityInputs {
  const { splitPrEnabled, splitPrThresholdLines } =
    stores.getGatingPreferences();
  return deriveSplitPrEligibilityInputs({
    prStatus: stores.getPrStatus(projectId, worktreeId),
    diffStats: stores.getDiffStats(projectId, worktreeId),
    splitPrEnabled,
    thresholdLines: splitPrThresholdLines,
    isSingleRepo,
  });
}

/**
 * Changed-line count used for both eligibility math and refusal-reason
 * messages: PR additions/deletions take precedence over local diff stats
 * (mirrors `isSplitPrEligible`'s own precedence), since PR numbers reflect
 * the pushed/reviewed diff while local diff stats can lag or include
 * uncommitted work.
 */
export function splitPrLineCount(
  inputs: Pick<
    SplitPrEligibilityInputs,
    'prAdditions' | 'prDeletions' | 'diffStats'
  >,
): number | undefined {
  if (inputs.prAdditions !== undefined && inputs.prDeletions !== undefined) {
    return inputs.prAdditions + inputs.prDeletions;
  }
  if (inputs.diffStats !== undefined) {
    return inputs.diffStats.insertions + inputs.diffStats.deletions;
  }
  return undefined;
}

/**
 * Reasons the split-PR workflow cannot safely start for an otherwise
 * eligible worktree. Declaration order is also the stable display order used
 * by `deriveSplitPrReadiness`.
 *
 * Re-exported from `@canopy/desktop-shared/types/github` (rather than
 * declared here) so the cross-environment `worktree.pullRequest` App Advisor
 * UI-state slice type (`AppAdvisorUiStateSnapshot` in
 * `packages/desktop-shared/src/types.ts`) can reference the same closed set
 * without importing renderer-only code.
 */
export type { SplitPrBlocker } from '@canopy/desktop-shared/types/github';
export { SPLIT_PR_BLOCKER_COPY } from '@canopy/desktop-shared/types/github';

export interface SplitPrReadiness {
  eligible: boolean;
  blockers: SplitPrBlocker[];
}

/**
 * Derives split-PR readiness from the existing eligibility inputs plus the
 * live worktree signals that gate *starting* the workflow once eligible.
 *
 * `eligible` reuses `isSplitPrEligible` unchanged (threshold/toggle/open-PR/
 * single-repo gating). `blockers` are only ever computed when `eligible` is
 * true: an ineligible worktree yields an empty blocker list so callers can
 * hide the split-PR entry point entirely instead of showing blocked-but-
 * ineligible UI. When eligible, blockers are collected in the stable order
 * declared on `SplitPrBlocker` regardless of the order their inputs are
 * checked.
 */
export function deriveSplitPrReadiness(args: {
  eligibilityInputs: SplitPrEligibilityInputs;
  uncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  hasConflicts: boolean;
  hasActivePipelines: boolean;
  hasActiveChats: boolean;
}): SplitPrReadiness {
  const {
    eligibilityInputs,
    uncommittedChanges,
    hasUnpushedCommits,
    hasConflicts,
    hasActivePipelines,
    hasActiveChats,
  } = args;

  const eligible = isSplitPrEligible(eligibilityInputs);
  if (!eligible) {
    return { eligible: false, blockers: [] };
  }

  const blockers: SplitPrBlocker[] = [];
  if (uncommittedChanges) {
    blockers.push('uncommitted_changes');
  }
  if (hasUnpushedCommits) {
    blockers.push('unpushed_commits');
  }
  if (hasConflicts) {
    blockers.push('merge_conflicts');
  }
  if (hasActivePipelines) {
    blockers.push('active_pipelines');
  }
  if (hasActiveChats) {
    blockers.push('active_chats');
  }

  return { eligible: true, blockers };
}

/**
 * Convenience wrapper for imperative (non-component) and component callers
 * that already have a `(projectId, worktreeId)` pair: reads the live
 * uncommitted-changes / unpushed-commits / active-pipeline / active-chat
 * signals from the relevant stores via `getState()` (safe outside React) and
 * derives readiness for that worktree.
 *
 * `hasConflicts` is read from the same `prStatus` used to build
 * `eligibilityInputs` rather than a separate store lookup, since PR conflict
 * state only exists on the PR status record. `hasConflicts === true` is the
 * sole predicate — `mergeableState` is intentionally not consulted here.
 * Unlike `isPrReadyToMerge` (`packages/desktop-shared/src/types/github.ts`),
 * which falls back to `mergeableState` when `mergeable`/`hasConflicts` are
 * absent because it must positively confirm "ready", this predicate only
 * needs to detect the negative "known conflicting" case, and `hasConflicts`
 * is populated directly from GitHub's `mergeable === false` signal wherever
 * `WorktreePrStatus` is constructed. Treating an unknown/undetermined
 * `mergeableState` as a blocker would falsely block PRs where GitHub simply
 * hasn't finished computing mergeability yet.
 */
export function gatherSplitPrReadinessInputs(
  projectId: string,
  worktreeId: string,
  isSingleRepo: boolean,
  stores: {
    getPrStatus: (
      projectId: string,
      worktreeId: string,
    ) => WorktreePrStatus | null | undefined;
    getDiffStats: (
      projectId: string,
      worktreeId: string,
    ) => { insertions: number; deletions: number } | undefined;
    getGatingPreferences: () => {
      splitPrEnabled: boolean;
      splitPrThresholdLines: number;
    };
    getUncommittedChanges: (projectId: string, worktreeId: string) => boolean;
    getHasUnpushedCommits: (projectId: string, worktreeId: string) => boolean;
    getHasActivePipelines: (projectId: string, worktreeId: string) => boolean;
    getHasActiveChats: (projectId: string, worktreeId: string) => boolean;
  },
): SplitPrReadiness {
  const prStatus = stores.getPrStatus(projectId, worktreeId);
  const singleRepoPrData =
    prStatus && prStatus.repos.length === 1
      ? (prStatus.repos[0].status ?? undefined)
      : undefined;

  const eligibilityInputs = gatherSplitPrEligibilityInputs(
    projectId,
    worktreeId,
    isSingleRepo,
    stores,
  );

  return deriveSplitPrReadiness({
    eligibilityInputs,
    uncommittedChanges: stores.getUncommittedChanges(projectId, worktreeId),
    hasUnpushedCommits: stores.getHasUnpushedCommits(projectId, worktreeId),
    hasConflicts: singleRepoPrData?.hasConflicts === true,
    hasActivePipelines: stores.getHasActivePipelines(projectId, worktreeId),
    hasActiveChats: stores.getHasActiveChats(projectId, worktreeId),
  });
}

/**
 * Real (non-test) store accessors for {@link gatherSplitPrReadinessInputs}'s
 * `stores` argument, reading via `getState()` so this works both inside
 * component render (paired with a `useShallow`/`useSyncExternalStore`-backed
 * subscription elsewhere in the caller to trigger re-renders on change) and
 * from imperative, non-component call sites.
 *
 * `getHasActivePipelines` treats both `running` and `paused` executions as
 * active: a paused execution is still mid-workflow (e.g. waiting on an
 * approval) and would race with a split, not a finished/idle state.
 *
 * `getHasActiveChats` mirrors the same "any tab streaming" signal
 * `WorktreeManager` already uses to light up its worktree-row thinking
 * indicator (`badgeKeys.active` in `WorktreeManager.tsx`): a chat tab counts
 * as active while `status === 'streaming'` and it isn't mid pending-plan-exit
 * (a plan-exit-pending tab is functionally idle from the split-PR workflow's
 * perspective — no agent turn is in flight).
 */
export const splitPrReadinessStoreAccessors: Parameters<
  typeof gatherSplitPrReadinessInputs
>[3] = {
  getPrStatus: (projectId, worktreeId) =>
    useGitHubStore.getState().prStatuses[worktreeKey(projectId, worktreeId)],
  getDiffStats: (projectId, worktreeId) =>
    useProjectsStore.getState().diffStats[
      createDiffStatsKey(projectId, worktreeId)
    ],
  getGatingPreferences: () => {
    const { splitPrEnabled, splitPrThresholdLines } =
      useSplitPrPreferencesStore.getState();
    return { splitPrEnabled, splitPrThresholdLines };
  },
  getUncommittedChanges: (projectId, worktreeId) =>
    useProjectsStore.getState().uncommittedChanges[
      worktreeKey(projectId, worktreeId)
    ] ?? false,
  getHasUnpushedCommits: (projectId, worktreeId) =>
    useProjectsStore.getState().hasUnpushedCommits[
      worktreeKey(projectId, worktreeId)
    ] ?? false,
  getHasActivePipelines: (projectId, worktreeId) => {
    const key = worktreeKey(projectId, worktreeId);
    const pipelines = usePipelineRunsStore.getState();
    return (
      (pipelines.runningExecutionsByWorktree[key]?.size ?? 0) > 0 ||
      (pipelines.pausedExecutionsByWorktree[key]?.size ?? 0) > 0
    );
  },
  getHasActiveChats: (projectId, worktreeId) => {
    const key = worktreeKey(projectId, worktreeId);
    const worktreeChat = useChatStore.getState().worktreeChats[key];
    if (!worktreeChat) return false;
    return worktreeChat.tabs.some(
      (tab) => tab.status === 'streaming' && !tab.pendingPlanExit,
    );
  },
};
