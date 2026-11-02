import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import type {
  DetectedPlanEntry,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';

// Detection's legacy repo id for the worktree root; main treats it as the
// workspace root too (`detected-plan-matcher.ts`).
const WORKTREE_SENTINEL_REPO_ID = '__worktree__';

/**
 * Map a repo id main stored on a plan or detection to the file root that
 * serves it. Main records the worktree root as `WORKSPACE_ROOT_REPO_ID` (or
 * the legacy sentinel), but a single-repo worktree's file root is the
 * workspace id, so pass that root's id as `worktreeRootFileRootId`.
 */
export function toSourceFileRootId(
  repoId: string,
  worktreeRootFileRootId: string = WORKSPACE_ROOT_REPO_ID,
): string {
  return repoId === WORKSPACE_ROOT_REPO_ID ||
    repoId === WORKTREE_SENTINEL_REPO_ID
    ? worktreeRootFileRootId
    : repoId;
}

function sourceKey(
  repoId: string,
  filePath: string,
  worktreeRootFileRootId: string,
): string {
  const repo = toSourceFileRootId(repoId, worktreeRootFileRootId);
  const path = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return `${repo}\u0000${path}`;
}

/**
 * Index the source files that are already tracked plans in a worktree, so the
 * import picker can open the existing plan instead of importing a duplicate.
 * Browse imports keep only a basename and no repo id, so they never match.
 * Lookups take file-root ids; see {@link toSourceFileRootId}.
 */
export function createTrackedPlanSourceLookup(
  plans: readonly TrackedPlanData[],
  detectedEntries: readonly DetectedPlanEntry[],
  worktreeRootFileRootId: string = WORKSPACE_ROOT_REPO_ID,
): (repoId: string, filePath: string) => string | undefined {
  const keyOf = (repoId: string, filePath: string): string =>
    sourceKey(repoId, filePath, worktreeRootFileRootId);
  const planIds = new Set(plans.map((plan) => plan.id));
  const bySource = new Map<string, string>();
  for (const plan of plans) {
    if (
      plan.source === 'imported' &&
      plan.sourceRepoId &&
      plan.sourceFilePath
    ) {
      bySource.set(keyOf(plan.sourceRepoId, plan.sourceFilePath), plan.id);
    }
  }
  for (const entry of detectedEntries) {
    // A plan deleted since its import falls back to importing again.
    if (
      entry.status === 'imported' &&
      entry.importedPlanId &&
      planIds.has(entry.importedPlanId)
    ) {
      const key = keyOf(entry.sourceRepoId, entry.sourceFilePath);
      if (!bySource.has(key)) bySource.set(key, entry.importedPlanId);
    }
  }
  return (repoId, filePath) => bySource.get(keyOf(repoId, filePath));
}
