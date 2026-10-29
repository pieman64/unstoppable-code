import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { CURSOR_PLAN_EXECUTION_UNAVAILABLE } from '@canopy/desktop-shared/plan-review';
import { isCursorPlanExecutionUnavailable } from '@canopy/app-core/client';
import { sendToOwningWorktreeChat } from '@/lib/chat/owningWorktreeChat';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';

/** The chat message that asks the agent to implement a plan. */
export function buildImplementPlanMessage(content: string): string {
  return `Implement this plan:\n\n${content}`;
}

export interface ImplementTrackedPlanOptions {
  /**
   * Called once with the chat that will receive the request, as soon as it is
   * chosen and before the send settles (for example to show it right away).
   */
  readonly onChatChosen?: (chatId: string) => void;
}

/**
 * Implement a tracked plan in its own worktree's chat (never the globally
 * selected worktree's), then record the plan as executed and approved and
 * refresh the worktree's plan list. Resolves with the chat that received the
 * request; rejects when the message could not be sent, leaving the plan
 * unapproved.
 */
export async function implementTrackedPlan(
  plan: TrackedPlanData,
  options: ImplementTrackedPlanOptions = {},
): Promise<{ chatId: string }> {
  if (isCursorPlanExecutionUnavailable(plan)) {
    throw new Error(CURSOR_PLAN_EXECUTION_UNAVAILABLE);
  }
  const { projectId, worktreeId } = plan;
  const chatId = await sendToOwningWorktreeChat(
    { projectId, worktreeId },
    buildImplementPlanMessage(plan.content),
    options,
  );
  useChatStore
    .getState()
    .markTrackedPlanExecuted({ projectId, worktreeId, planId: plan.id });
  await window.api.activity.plans.update({
    projectId,
    worktreeId,
    planId: plan.id,
    reviewStatus: 'approved',
    approvedAt: new Date().toISOString(),
    initiationSource: 'user',
  });
  await useActivityStore.getState().loadTrackedPlans(projectId, worktreeId);
  return { chatId };
}
