import { useMemo } from 'react';
import { useGitHubStore, worktreeKey } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { createDiffStatsKey } from '@/stores/projectsStore.diffStats';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import { useSplitPrGatingPreferences } from '@/hooks/useSplitPrPreferences';
import {
  deriveSplitPrEligibilityInputs,
  deriveSplitPrReadiness,
  type SplitPrReadiness,
} from '@/lib/splitPrEligibilityInputs';

/**
 * Reactive, per-`(projectId, worktreeId)` split-PR readiness for the four
 * launch surfaces (worktree-row menu item, PR activity panel button, PR
 * status bar button, post-failure "Plan new split" button). Subscribes to
 * exactly the store slices
 * `deriveSplitPrReadiness` consumes (via the same `deriveSplitPrEligibilityInputs`
 * helper the panel and menu-item eligibility checks already use, plus the
 * blocker-only signals below) so each surface re-renders when — and only
 * when — a signal that could flip its own gating actually changes.
 *
 * `hasActivePipelines` counts both `running` and `paused` executions: a
 * paused execution (e.g. waiting on an approval) is still mid-workflow, not a
 * settled/idle state, so it should still block starting a split.
 *
 * `hasActiveChats` mirrors the same "any tab streaming" signal
 * `WorktreeManager` already uses for its worktree-row thinking indicator
 * (`badgeKeys.active` in `WorktreeManager.tsx`): a tab counts as active while
 * `status === 'streaming'` and it isn't mid pending-plan-exit (a
 * plan-exit-pending tab has no agent turn in flight).
 *
 * The imperative (non-component) equivalent of this same signal set lives in
 * `splitPrReadinessStoreAccessors` (`@/lib/splitPrEligibilityInputs`) for
 * callers that read via `getState()` outside React, e.g. the App Advisor
 * dispatcher. Keep both in sync if a new blocker signal is added.
 */
export function useSplitPrReadiness(
  projectId: string,
  worktreeId: string,
  isSingleRepo: boolean,
): SplitPrReadiness {
  const key = worktreeKey(projectId, worktreeId);
  const diffStatsKey = createDiffStatsKey(projectId, worktreeId);

  const prStatus = useGitHubStore((state) => state.prStatuses[key]);
  const diffStats = useProjectsStore((state) => state.diffStats[diffStatsKey]);
  const { splitPrEnabled, splitPrThresholdLines } =
    useSplitPrGatingPreferences();
  const uncommittedChanges = useProjectsStore(
    (state) => state.uncommittedChanges[key] ?? false,
  );
  const hasUnpushedCommits = useProjectsStore(
    (state) => state.hasUnpushedCommits[key] ?? false,
  );
  const hasActivePipelines = usePipelineRunsStore(
    (state) =>
      (state.runningExecutionsByWorktree[key]?.size ?? 0) > 0 ||
      (state.pausedExecutionsByWorktree[key]?.size ?? 0) > 0,
  );
  const hasActiveChats = useChatSidebarStore((state) => {
    const worktreeChat = state.worktrees[key];
    if (!worktreeChat) return false;
    return worktreeChat.tabs.some(
      (tab) => tab.status === 'streaming' && !tab.pendingPlanExit,
    );
  });

  return useMemo((): SplitPrReadiness => {
    const eligibilityInputs = deriveSplitPrEligibilityInputs({
      prStatus,
      diffStats:
        diffStats !== undefined
          ? { insertions: diffStats.insertions, deletions: diffStats.deletions }
          : undefined,
      splitPrEnabled,
      thresholdLines: splitPrThresholdLines,
      isSingleRepo,
    });
    // Same single-repo-only precedence `gatherSplitPrReadinessInputs` uses:
    // conflict state only exists on the PR status record.
    const singleRepoPrData =
      prStatus && prStatus.repos.length === 1
        ? (prStatus.repos[0].status ?? undefined)
        : undefined;

    return deriveSplitPrReadiness({
      eligibilityInputs,
      uncommittedChanges,
      hasUnpushedCommits,
      hasConflicts: singleRepoPrData?.hasConflicts === true,
      hasActivePipelines,
      hasActiveChats,
    });
  }, [
    prStatus,
    diffStats,
    splitPrEnabled,
    splitPrThresholdLines,
    isSingleRepo,
    uncommittedChanges,
    hasUnpushedCommits,
    hasActivePipelines,
    hasActiveChats,
  ]);
}
