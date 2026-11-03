import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { CURSOR_PLAN_EXECUTION_UNAVAILABLE } from '@canopy/desktop-shared/plan-review';
import { isCursorPlanExecutionUnavailable } from '@canopy/app-core/client';
import {
  OWNING_CHAT_SEND_REJECTED_MESSAGE,
  OWNING_CHAT_UNAVAILABLE_MESSAGE,
  resolveOwningWorktreeChatId,
} from '@/lib/chat/owningWorktreeChat';
import { reconcileExecutedPlan } from '@/lib/plans/reconcile-tracked-plans';
import { useChatStore } from '@/stores/chatStore';
import {
  createTrackedPlanImplementation,
  beginPlanDispatch,
  PLAN_DISPATCH_BUSY_MESSAGE,
  updateTrackedPlanReview,
} from '@/stores/chat/plan-utils';

/** The chat message that asks the agent to implement a plan. */
export function buildImplementPlanMessage(content: string): string {
  return `Implement this plan:\n\n${content}`;
}

/** Shown when the plan could not be approved before its linked send. */
export const PLAN_APPROVAL_FAILED_MESSAGE =
  "Couldn't approve this plan. Try again.";

export interface ImplementTrackedPlanOptions {
  /**
   * Called once with the chat that will receive the request, as soon as it is
   * chosen and before the send settles (for example to show it right away).
   */
  readonly onChatChosen?: (chatId: string) => void;
}

// One pending implementation per reviewed revision: a repeated click or a retry from
// the overflow menu joins the request already in flight.
const implementationsInFlight = new Map<string, Promise<{ chatId: string }>>();

/**
 * Implement a tracked plan in its own worktree's chat (never the globally
 * selected worktree's). The send carries a new attempt identity that main
 * registers durably with admission, so the Plans surfaces can follow that
 * exact turn. Main admits the link only for an approved revision, so a
 * plan awaiting review is approved first; a refused send then leaves it
 * Approved with Execute available. Resolves with the chat that received
 * the request; rejects when the message could not be sent.
 */
export function implementTrackedPlan(
  plan: TrackedPlanData,
  options: ImplementTrackedPlanOptions = {},
): Promise<{ chatId: string }> {
  if (isCursorPlanExecutionUnavailable(plan)) {
    return Promise.reject(new Error(CURSOR_PLAN_EXECUTION_UNAVAILABLE));
  }
  const key = `${plan.projectId}/${plan.worktreeId}/${plan.id}/${plan.latestRevisionNumber}`;
  const inFlight = implementationsInFlight.get(key);
  if (inFlight) return inFlight;
  const release = beginPlanDispatch(plan);
  if (!release) return Promise.reject(new Error(PLAN_DISPATCH_BUSY_MESSAGE));
  const implementation = implementLinkedPlan(plan, options).finally(() => {
    implementationsInFlight.delete(key);
    release();
  });
  implementationsInFlight.set(key, implementation);
  return implementation;
}

async function implementLinkedPlan(
  plan: TrackedPlanData,
  options: ImplementTrackedPlanOptions,
): Promise<{ chatId: string }> {
  const { projectId, worktreeId } = plan;
  // Snapshot the revision being implemented before any asynchronous step.
  const attempt = createTrackedPlanImplementation(
    plan.id,
    plan.latestRevisionNumber,
  );
  const chatId = await resolveOwningWorktreeChatId({ projectId, worktreeId });
  if (!chatId) {
    throw new Error(OWNING_CHAT_UNAVAILABLE_MESSAGE);
  }
  const store = useChatStore.getState();
  store.switchTab(chatId, { projectId, worktreeId });
  try {
    options.onChatChosen?.(chatId);
  } catch {
    // Reporting the chosen chat (for example showing it) is best-effort and
    // must never keep the message from being sent.
  }
  if (plan.reviewStatus !== 'approved') {
    const approved = await updateTrackedPlanReview(
      {
        projectId,
        worktreeId,
        targetChatId: chatId,
        tab: { trackedPlanId: plan.id },
      },
      'approved',
    );
    if (approved === 'update-failed' || approved === 'skipped') {
      throw new Error(PLAN_APPROVAL_FAILED_MESSAGE);
    }
  }
  const disposition = await useChatStore.getState().dispatchChatCommand(
    { projectId, worktreeId },
    {
      type: 'chat.send_message',
      chatId,
      userMessageId: attempt.userMessageId,
      text: buildImplementPlanMessage(plan.content),
      trackedPlanImplementation: attempt,
    },
  );
  if (disposition !== 'accepted') {
    throw new Error(OWNING_CHAT_SEND_REJECTED_MESSAGE);
  }
  useChatStore
    .getState()
    .markTrackedPlanExecuted({ projectId, worktreeId, planId: plan.id });
  await reconcileExecutedPlan({ projectId, worktreeId, chatId }, plan.id);
  return { chatId };
}
