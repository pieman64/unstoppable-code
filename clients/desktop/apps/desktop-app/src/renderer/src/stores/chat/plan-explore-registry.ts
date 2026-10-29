// Legacy plan chats: the retired plan-explore scope. Plans open in their
// worktree's Plan panel and are discussed in the worktree's ordinary chats,
// so no surface shows a plan-explore chat any more. Its persisted chats are
// never loaded by the app itself; these helpers keep any that still reach
// the renderer (old notifications, Overview cards) pointed at the plan and
// keep them from starting a session nobody can see.
import { useActivityStore } from '../activityStore';

/** Whether a chat scope is the retired plan-chat scope. */
export { isRetiredPlanChatScope } from '@canopy/desktop-shared/lib/retired-chat-scopes';

/**
 * The worktree that owns a legacy plan chat's plan, from the loaded tracked
 * plans. Null when the plan is not loaded (its worktree was never visited
 * this session) or no longer exists.
 */
export function findPlanExploreTarget(
  planId: string,
): { projectId: string; worktreeId: string } | null {
  const trackedPlans = useActivityStore.getState().trackedPlans;
  for (const plans of Object.values(trackedPlans)) {
    const plan = plans.find((entry) => entry.id === planId);
    if (plan) {
      return { projectId: plan.projectId, worktreeId: plan.worktreeId };
    }
  }
  return null;
}

/**
 * Whether a legacy plan chat is on screen. Always false: no surface shows
 * one, so its activity is unread like any chat that is not in view. Kept so
 * the unread and notification gates stay uniform with the code-review chat.
 */
export function isVisiblePlanExploreChat(
  _projectId: string,
  _worktreeId: string,
): boolean {
  void _projectId;
  void _worktreeId;
  return false;
}
