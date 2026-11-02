/**
 * A chat whose delegates or provider agents/workflows still run reports its
 * completion once, when it is idle again, not at every wake's result
 * (turn-state phase 36d). The latest notice is held per chat: a toast from the
 * unread transition stays a toast and takes the latest result's preview.
 */
import {
  isUnreadChatActivityStillStoppedAndUnread,
  maybeFireChatActivityNotification,
  maybeShowUnreadChatToast,
  type UnreadChatToastOptions,
} from './notifications';
import { chatHasCloseBlockingWork } from './slices/revisioned';
import { chatStoreApi } from './store-ref';
import {
  subscribeChatDelegatesSettled,
  type ChatDelegationTarget,
} from '../delegationActivityStore';
import { subscribeChatProviderWorkSettled } from '../liveBackgroundTaskStore';

/** Settled work usually wakes the chat at once; its own result reports then. */
const RELEASE_SETTLE_MS = 3_000;

export interface CompletionNotice {
  toast: UnreadChatToastOptions | null;
  pings: readonly UnreadChatToastOptions[];
}

const heldNotices = new Map<string, CompletionNotice>();
let stopListening: (() => void) | undefined;

function noticeKey(target: ChatDelegationTarget): string {
  return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

/** A held toast takes the latest result's preview and covers its pings. */
function mergeNotice(
  held: CompletionNotice | undefined,
  next: CompletionNotice,
): CompletionNotice {
  const latest = next.pings[next.pings.length - 1];
  const toast = next.toast ?? held?.toast ?? null;
  if (!toast || next.toast) return { toast, pings: next.pings };
  return {
    toast: latest
      ? {
          ...toast,
          agentResponsePreview: latest.agentResponsePreview,
          failed: latest.failed,
        }
      : toast,
    pings: [],
  };
}

/**
 * The notice to show now for a chat's result, or null while its background
 * work runs and the notice is held. A newer result takes a held notice, so
 * the chat reports once.
 */
export function takeCompletionNotice(
  target: ChatDelegationTarget,
  next: CompletionNotice,
): CompletionNotice | null {
  const key = noticeKey(target);
  const held = heldNotices.get(key);
  if (!held && next.toast === null && next.pings.length === 0) return next;
  const notice = mergeNotice(held, next);
  if (
    chatHasCloseBlockingWork(target.projectId, target.worktreeId, target.chatId)
  ) {
    heldNotices.set(key, notice);
    listenForSettledWork();
    return null;
  }
  forget(key);
  return notice;
}

export function showCompletionNotice(notice: CompletionNotice): void {
  if (notice.toast) maybeShowUnreadChatToast(notice.toast);
  for (const ping of notice.pings) maybeFireChatActivityNotification(ping);
}

function forget(key: string): void {
  if (!heldNotices.delete(key) || heldNotices.size > 0) return;
  stopListening?.();
  stopListening = undefined;
}

function listenForSettledWork(): void {
  if (stopListening) return;
  const stopDelegates = subscribeChatDelegatesSettled(releaseWhenIdle);
  const stopProviderWork = subscribeChatProviderWorkSettled(releaseWhenIdle);
  stopListening = (): void => {
    stopDelegates();
    stopProviderWork();
  };
}

function chatStreams(target: ChatDelegationTarget): boolean {
  return (
    chatStoreApi()
      .getState()
      .worktreeChats[`${target.projectId}/${target.worktreeId}`]?.tabs.find(
        (tab) => tab.id === target.chatId,
      )?.status === 'streaming'
  );
}

function releaseWhenIdle(target: ChatDelegationTarget): void {
  const key = noticeKey(target);
  if (!heldNotices.has(key)) return;
  setTimeout(() => {
    const notice = heldNotices.get(key);
    if (
      !notice ||
      chatStreams(target) ||
      chatHasCloseBlockingWork(
        target.projectId,
        target.worktreeId,
        target.chatId,
      )
    )
      return;
    forget(key);
    // The chat may have been read while the notice waited.
    showCompletionNotice({
      toast:
        notice.toast && isUnreadChatActivityStillStoppedAndUnread(notice.toast)
          ? notice.toast
          : null,
      pings: notice.pings.filter(
        (ping) =>
          !ping.requireUnreadBeforeDelivery ||
          isUnreadChatActivityStillStoppedAndUnread(ping),
      ),
    });
  }, RELEASE_SETTLE_MS);
}
