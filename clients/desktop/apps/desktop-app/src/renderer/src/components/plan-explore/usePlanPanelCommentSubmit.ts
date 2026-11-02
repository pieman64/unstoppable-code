import { useCallback } from 'react';
import type {
  ChatActivePlanContext,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import {
  dispatchWorkspaceComments,
  type WorkspaceCommentDispatchResult,
} from '@/components/chat/submitWorkspaceComments';
import type {
  PlanCommentSubmitHiddenContext,
  PlanCommentSubmitOutcome,
  UsePlanComments,
} from '@/components/plan-explore/usePlanComments';
import { OWNING_CHAT_UNAVAILABLE_MESSAGE } from '@/lib/chat/owningWorktreeChat';
import { revealWorktreeChatPanel } from '@/lib/panels/plan-panel-open';
import { useGitHubStore } from '@/stores/githubStore';

/** Shown when the owning chat refuses submitted plan comments. */
export const PLAN_COMMENTS_SEND_REJECTED_MESSAGE =
  "Couldn't send comments to chat. Try again.";

/** The error toast for a submit that ended without an accepted dispatch. */
function rejectedSubmitMessage(
  dispatch: WorkspaceCommentDispatchResult | null,
): string {
  return dispatch?.ok === false && dispatch.reason === 'no-chat'
    ? OWNING_CHAT_UNAVAILABLE_MESSAGE
    : PLAN_COMMENTS_SEND_REJECTED_MESSAGE;
}

/**
 * Submit a plan panel's pending comments to the ordinary chat of the worktree
 * that owns the plan (creating one when it has none), never a special plan
 * chat. The owning scope is captured when the submit starts, so switching
 * panels or worktrees meanwhile cannot retarget it. An accepted dispatch
 * brings that chat's panel forward; a refused one leaves every comment pending
 * and shows a recoverable error.
 *
 * The message carries this plan as its active plan, with `viewedRevision`
 * (the older revision on screen, or `null` for the latest) as captured when
 * the submit starts, so the agent is pointed at the plan's working file.
 *
 * `targetChatId`, when given, names the chat to send to (the chat waiting on
 * the plan) instead of the worktree's active editable chat.
 */
export function usePlanPanelCommentSubmit(
  plan: Pick<TrackedPlanData, 'projectId' | 'worktreeId' | 'id'>,
  submit: UsePlanComments['submit'],
  viewedRevision: number | null,
  targetChatId?: string,
): () => void {
  const { projectId, worktreeId, id: planId } = plan;
  const addToast = useGitHubStore((state) => state.addToast);

  return useCallback((): void => {
    const scope = { projectId, worktreeId };
    const activePlan: ChatActivePlanContext =
      viewedRevision !== null
        ? { planId, viewedRevisionNumber: viewedRevision }
        : { planId };
    const dispatch: { current: WorkspaceCommentDispatchResult | null } = {
      current: null,
    };
    const send = async (
      message: string,
      hiddenContext: PlanCommentSubmitHiddenContext,
    ): Promise<boolean> => {
      const result = await dispatchWorkspaceComments(
        scope,
        message,
        hiddenContext,
        targetChatId !== undefined
          ? { activePlan, chatId: targetChatId }
          : { activePlan },
      );
      dispatch.current = result;
      // A refused dispatch acknowledges nothing: every comment stays pending.
      return result.ok;
    };
    const showError = (message: string): void => {
      addToast(message, 'error', undefined, {
        category: 'Chat',
        projectId,
        worktreeId,
      });
    };
    const settle = (outcome: PlanCommentSubmitOutcome): void => {
      if (outcome === 'sent') {
        if (dispatch.current?.ok) {
          revealWorktreeChatPanel(scope, dispatch.current.chatId);
        }
        return;
      }
      if (outcome === 'rejected') {
        showError(rejectedSubmitMessage(dispatch.current));
      }
      // `empty` has nothing to send, and `busy` means an earlier submit of
      // this plan is still settling and reports its own outcome.
    };
    void submit(send).then(settle, () => {
      showError(PLAN_COMMENTS_SEND_REJECTED_MESSAGE);
    });
  }, [
    projectId,
    worktreeId,
    planId,
    viewedRevision,
    targetChatId,
    submit,
    addToast,
  ]);
}
