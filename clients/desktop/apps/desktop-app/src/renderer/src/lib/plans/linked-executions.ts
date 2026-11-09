import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import type { ExecutionSummary } from '@canopy/execution-engine/types/pipeline';

/** Persisted links plus live plan references, scoped and deduplicated. */
export function planLinkedExecutionIds(
  plan: Pick<
    TrackedPlanData,
    'id' | 'projectId' | 'worktreeId' | 'linkedExecutionIds'
  >,
  summaries: readonly ExecutionSummary[],
): ReadonlySet<string> {
  const ids = new Set(plan.linkedExecutionIds);
  for (const summary of summaries) {
    if (
      summary.planId === plan.id &&
      (summary.project_id === undefined ||
        summary.project_id === plan.projectId) &&
      (summary.worktree_id === undefined ||
        summary.worktree_id === plan.worktreeId)
    )
      ids.add(summary.id);
  }
  return ids;
}
