import { resolveSelectionTargetTabId } from '@/lib/editorSelectionContext';
import { useChatStore } from '@/stores/chatStore';
import type { SendMessageDispatchOptions } from '@/stores/chat/types';

/** A worktree that owns a piece of content (a tracked plan, a comment). */
export interface OwningWorktreeScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

/**
 * Dispatch options a caller may pass through to the owning chat's send, plus
 * an optional notification of the chat that was chosen.
 */
export type OwningWorktreeChatSendOptions = Pick<
  SendMessageDispatchOptions,
  'hiddenContext' | 'initiationSource'
> & {
  /**
   * Called once with the chosen chat as soon as it is the worktree's active
   * tab, before the send is dispatched or settles (for example to show it).
   */
  readonly onChatChosen?: (chatId: string) => void;
  /** Observes accepted admission without waiting for the send to settle. */
  readonly onDispatchAccepted?: (chatId: string) => void;
};

/** Shown when the owning worktree has no chat that can take the message. */
export const OWNING_CHAT_UNAVAILABLE_MESSAGE =
  "Couldn't find a chat to send to. Start a chat and try again.";

/** Shown when the owning chat refuses the message before dispatching it. */
export const OWNING_CHAT_SEND_REJECTED_MESSAGE =
  "Couldn't send to chat. Try again.";

function pickEditableChatId(scope: OwningWorktreeScope): string | null {
  const worktree =
    useChatStore.getState().worktreeChats[
      `${scope.projectId}/${scope.worktreeId}`
    ];
  if (!worktree) {
    return null;
  }
  return resolveSelectionTargetTabId({
    tabs: worktree.tabs,
    activeTabId: worktree.activeTabId,
    lastActiveEditableChatId: worktree.lastActiveEditableChatId,
  });
}

/**
 * Resolve the ordinary chat that should receive work for content owned by
 * `scope`, whether or not that worktree is the selected one. Loads the
 * worktree's chats when they are not in the store yet, then uses the
 * active/last-editable/first-editable chat policy. When the worktree has no
 * editable chat, the normal chat creation path adds one. Resolves `null` only
 * when no editable chat can be found or created.
 */
export async function resolveOwningWorktreeChatId(
  scope: OwningWorktreeScope,
): Promise<string | null> {
  const store = useChatStore.getState();
  if (!store.worktreeChats[`${scope.projectId}/${scope.worktreeId}`]) {
    await store.loadTabsForTarget(scope.projectId, scope.worktreeId);
  }
  const existing = pickEditableChatId(scope);
  if (existing) {
    return existing;
  }
  await useChatStore.getState().ensureWorktreeHasChatTab({
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
  });
  return pickEditableChatId(scope);
}

/**
 * Send `text` to the owning worktree's ordinary chat (never the globally
 * selected worktree's) and make that chat the worktree's active tab. Reports
 * the chosen chat through `onChatChosen` before sending. Resolves with the
 * chat id once the send is accepted. Rejects when no chat is available or the
 * send is refused before dispatch, so the caller can keep its state and
 * report the failure.
 */
export async function sendToOwningWorktreeChat(
  scope: OwningWorktreeScope,
  text: string,
  {
    onChatChosen,
    onDispatchAccepted,
    ...dispatchOptions
  }: OwningWorktreeChatSendOptions = {},
): Promise<string> {
  const chatId = await resolveOwningWorktreeChatId(scope);
  if (!chatId) {
    throw new Error(OWNING_CHAT_UNAVAILABLE_MESSAGE);
  }
  const target = {
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId,
  };
  const store = useChatStore.getState();
  store.switchTab(chatId, {
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
  });
  try {
    onChatChosen?.(chatId);
  } catch {
    // Reporting the chosen chat (for example showing it) is best-effort and
    // must never keep the message from being sent.
  }
  const dispatch = { rejectedBeforeDispatch: false };
  await store.sendMessage(text, undefined, target, undefined, {
    ...dispatchOptions,
    throwOnDispatchFailure: true,
    ...(onDispatchAccepted
      ? { onDispatchAccepted: (): void => onDispatchAccepted(chatId) }
      : {}),
    onPreDispatchRejected: () => {
      dispatch.rejectedBeforeDispatch = true;
    },
  });
  if (dispatch.rejectedBeforeDispatch) {
    throw new Error(OWNING_CHAT_SEND_REJECTED_MESSAGE);
  }
  return chatId;
}
