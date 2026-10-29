import {
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';

const PLAN_EXPLORE_CHAT_KEY_PREFIX = `${PLAN_EXPLORE_CHAT_PROJECT_ID}/`;

type TrackedPlansByWorktree = Readonly<
  Record<string, readonly TrackedPlanData[]>
>;

export function addPlanExploreOriginWorktreeKeys(
  scopeKeys: Iterable<string>,
  trackedPlans: TrackedPlansByWorktree,
): Set<string> {
  const keys = new Set(scopeKeys);
  const planWorktreeKeyById = new Map<string, string>();
  for (const plans of Object.values(trackedPlans)) {
    for (const plan of plans) {
      planWorktreeKeyById.set(plan.id, `${plan.projectId}/${plan.worktreeId}`);
    }
  }
  for (const scopeKey of Array.from(keys)) {
    if (!scopeKey.startsWith(PLAN_EXPLORE_CHAT_KEY_PREFIX)) continue;
    const planId = scopeKey.slice(PLAN_EXPLORE_CHAT_KEY_PREFIX.length);
    const worktreeKey = planWorktreeKeyById.get(planId);
    if (worktreeKey) keys.add(worktreeKey);
  }
  return keys;
}
