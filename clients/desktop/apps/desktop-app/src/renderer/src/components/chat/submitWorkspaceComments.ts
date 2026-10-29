import type {
  ChatActivePlanContext,
  ChatSendMessageRequest,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { resolveSelectionTargetTabId } from '@/lib/editorSelectionContext';
import {
  resolveOwningWorktreeChatId,
  type OwningWorktreeScope,
} from '@/lib/chat/owningWorktreeChat';

/** Outcome of dispatching workspace comments to the owning worktree's chat. */
export type WorkspaceCommentDispatchResult =
  | { readonly ok: true; readonly chatId: string }
  | { readonly ok: false; readonly reason: 'no-chat' | 'rejected' };

/** The hidden instructions a comment submission sends with its message. */
type WorkspaceCommentHiddenContext = NonNullable<
  ChatSendMessageRequest['hiddenContext']
>;

/** Request-scoped context a comment submission sends with its message. */
export interface WorkspaceCommentDispatchOptions {
  /**
   * The tracked plan the comments are about (a plan panel's source plan, with
   * the older revision on screen), so the agent is pointed at its file.
   */
  readonly activePlan?: ChatActivePlanContext;
}

/**
 * Remove this submission's copy from the chat's renderer-local queue.
 * `sendMessage` stores the send's `hiddenContext` by reference on the queued
 * copy, and each dispatch sends its own copy of the context, so identity finds
 * exactly this submission's entry and never someone else's message. The entry
 * may already be gone: the user deleted the queued bubble, or the tab was
 * closed or its state rebuilt.
 */
function withdrawRendererQueuedComments(
  target: OwningWorktreeScope & { readonly chatId: string },
  hiddenContext: WorkspaceCommentHiddenContext,
): void {
  const index =
    useChatStore
      .getState()
      .worktreeChats[`${target.projectId}/${target.worktreeId}`]?.tabs.find(
        (tab) => tab.id === target.chatId,
      )
      ?.queuedMessages.findIndex(
        (entry) => entry.dispatchOptions?.hiddenContext === hiddenContext,
      ) ?? -1;
  if (index < 0) return;
  useChatStore.getState().clearQueuedMessage(index, {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
  });
}

/**
 * Dispatch `message` to the owning worktree's ordinary chat, creating one
 * when the worktree has no editable chat yet, and settle once main owns the
 * message or the send is refused — never merely because `sendMessage`'s own
 * promise settled. A Claude terminal-launch send can resolve before
 * `onDispatchAccepted` fires (messaging.ts fire-and-forgets the launch), so
 * resolving on that settlement alone would race the real outcome; resolving
 * only from the dispatch callbacks (or a caught throw) is what actually fixes
 * the pre-dispatch-rejection hang this replaces.
 *
 * The comments count as sent only once main or Claude owns them: an accepted
 * dispatch, main's input-delivery queue, or a Claude terminal launch that took
 * the prompt as its initial argument (even if saving it to the transcript then
 * failed). Callers acknowledge the comments on an ok result, so a message
 * parked only in this renderer's queue (worktree setup, a hook placeholder, or
 * a failed Claude terminal launch kept for retry) is not a send: that queue is
 * not saved with the chat tab, and a restart would drop the message while the
 * comments stayed marked sent. That copy is withdrawn and the result is
 * `rejected`, so the comments stay pending and a retry cannot deliver them
 * twice. A renderer-queue report that finds no copy is `rejected` too: comments
 * never ask for the setup queue's immediate flush (`queueForSetup`), so the
 * copy was removed (a deleted queued bubble, a closed or rebuilt tab), not
 * dispatched. The parking paths report acceptance and then, synchronously,
 * where the message is parked, so acceptance settles a microtask later to let
 * a renderer-queue report override it.
 *
 * The composer's staged attachments and revert summary belong to the user's
 * own next message, so the send is marked `composerAttachmentsReserved` with
 * nothing reserved: `sendMessage` neither carries nor clears them, whether it
 * dispatches or parks the comments, and a withdrawn copy leaves them where
 * they were.
 *
 * `options.activePlan` rides with the message (and with any queued copy) as
 * this turn's active plan; file and diagram comments send none.
 *
 * Picks the target chat the same way file/diagram comment submission always
 * has: the synchronous `resolveSelectionTargetTabId` policy over the
 * worktree's already-loaded tabs (fast path, no `await` before dispatch so
 * synchronous callers observe `switchTab`/`sendMessage` immediately). Only
 * when that finds nothing does this fall back to
 * `resolveOwningWorktreeChatId`, which loads the worktree's chats if needed
 * and creates a chat via the normal creation path — so a submission from a
 * worktree with no chat tab now creates one instead of silently doing
 * nothing.
 */
export async function dispatchWorkspaceComments(
  scope: OwningWorktreeScope,
  message: string,
  hiddenContext: WorkspaceCommentHiddenContext,
  options?: WorkspaceCommentDispatchOptions,
): Promise<WorkspaceCommentDispatchResult> {
  const worktree =
    useChatStore.getState().worktreeChats[
      `${scope.projectId}/${scope.worktreeId}`
    ];
  const inlineChatId = worktree
    ? resolveSelectionTargetTabId({
        tabs: worktree.tabs,
        activeTabId: worktree.activeTabId,
        lastActiveEditableChatId: worktree.lastActiveEditableChatId,
      })
    : null;

  let chatId = inlineChatId;
  if (!chatId) {
    try {
      chatId = await resolveOwningWorktreeChatId(scope);
    } catch {
      return { ok: false, reason: 'no-chat' };
    }
  }
  if (!chatId) {
    return { ok: false, reason: 'no-chat' };
  }
  const target = { ...scope, chatId };
  // This dispatch's own context object: the identity that finds its queued
  // copy even when the caller reuses one context across submissions.
  const dispatchHiddenContext: WorkspaceCommentHiddenContext = {
    ...hiddenContext,
  };

  useChatStore.getState().switchTab(chatId, scope);

  return new Promise<WorkspaceCommentDispatchResult>((resolve) => {
    let settled = false;
    const settle = (result: WorkspaceCommentDispatchResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const sent: WorkspaceCommentDispatchResult = {
      ok: true,
      chatId: target.chatId,
    };
    const refused: WorkspaceCommentDispatchResult = {
      ok: false,
      reason: 'rejected',
    };
    void useChatStore
      .getState()
      .sendMessage(message, undefined, target, undefined, {
        hiddenContext: dispatchHiddenContext,
        ...(options?.activePlan ? { activePlan: options.activePlan } : {}),
        composerAttachmentsReserved: true,
        throwOnDispatchFailure: true,
        onDispatchAccepted: () => {
          queueMicrotask(() => settle(sent));
        },
        onQueuedWithoutDispatch: (queue) => {
          // A later report (e.g. a terminal launch that failed after its
          // queued copy was already flushed and accepted) must not withdraw a
          // message already counted as sent.
          if (settled) return;
          if (queue === 'host') {
            settle(sent);
            return;
          }
          // Only this renderer holds the message, or held it until the copy
          // was removed; either way nothing was delivered.
          withdrawRendererQueuedComments(target, dispatchHiddenContext);
          settle(refused);
        },
        onDispatchRejected: () => settle(refused),
        // Fires for rejections that happen before the message is queued or
        // committed (e.g. no live target tab, a blocked scope, a refused
        // approval-mode transition). Without handling this, the returned
        // promise never settles for those paths.
        onPreDispatchRejected: () => settle(refused),
      })
      .catch(() => settle(refused));
  });
}

/** Submit to the owning worktree's ordinary chat; true only when {@link dispatchWorkspaceComments} counts the message as sent. */
export async function submitWorkspaceComments(
  scope: OwningWorktreeScope,
  message: string,
  hiddenContext: WorkspaceCommentHiddenContext,
  options?: WorkspaceCommentDispatchOptions,
): Promise<boolean> {
  return (
    await dispatchWorkspaceComments(scope, message, hiddenContext, options)
  ).ok;
}
