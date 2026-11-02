// Pending ask-user question persistence and lookup helpers.
import type {
  ChatTabsFile,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';
import { isRecord } from './utils';
import type { PendingQuestion, WorktreeChatState } from './types';

export function isPersistablePendingQuestion(
  pending: PendingQuestion,
  projectId: string,
  worktreeId: string,
  chatIds: Set<string>,
): boolean {
  // Answered records are intentionally retained (no `answeredAt === undefined`
  // gate): persisting them keeps the projected answered state durable across a
  // desktop restart (so the browser keeps showing the read-only answer bubble
  // instead of reverting to raw JSON) and preserves duplicate-answer
  // idempotency. Retention stays bounded by chat/tab ownership below — a record
  // whose chat tab no longer exists is still dropped.
  return (
    pending.projectId === projectId &&
    pending.worktreeId === worktreeId &&
    chatIds.has(pending.chatId)
  );
}

export function toPersistedPendingQuestions(
  projectId: string,
  worktreeId: string,
  chatState: WorktreeChatState,
  pendingQuestions: Record<string, PendingQuestion>,
): PersistedPendingQuestion[] | undefined {
  const chatIds = new Set(chatState.tabs.map((tab) => tab.id));
  const persisted = Object.values(pendingQuestions)
    .filter((pending) =>
      isPersistablePendingQuestion(pending, projectId, worktreeId, chatIds),
    )
    .map((pending) => ({
      requestId: pending.requestId,
      chatId: pending.chatId,
      questions: pending.questions,
      ...(pending.answers ? { answers: pending.answers } : {}),
      ...(pending.answeredAt !== undefined
        ? { answeredAt: pending.answeredAt }
        : {}),
      ...(pending.toolUseId ? { toolUseId: pending.toolUseId } : {}),
      ...(pending.delivery ? { delivery: pending.delivery } : {}),
      ...(pending.dismissedAt !== undefined
        ? { dismissedAt: pending.dismissedAt }
        : {}),
    }));

  return persisted.length > 0 ? persisted : undefined;
}

export function isPersistedPendingQuestion(
  value: unknown,
): value is PersistedPendingQuestion {
  if (!isRecord(value)) return false;
  return (
    typeof value.requestId === 'string' &&
    typeof value.chatId === 'string' &&
    Array.isArray(value.questions)
  );
}

export function hydratePendingQuestionsFromFile(
  file: ChatTabsFile,
  projectId: string,
  worktreeId: string,
  chatState: WorktreeChatState,
): Record<string, PendingQuestion> {
  const chatIds = new Set(chatState.tabs.map((tab) => tab.id));
  const pendingQuestions: Record<string, PendingQuestion> = {};
  for (const pending of file.pendingQuestions ?? []) {
    if (!isPersistedPendingQuestion(pending)) continue;
    if (!chatIds.has(pending.chatId)) continue;
    // Answered records are restored (not skipped) so the renderer keeps the
    // answered state after a restart/reload. `answeredAt` marks them
    // non-actionable: `hasPendingQuestionForChat` ignores them, the awaited
    // answer path treats an entry with `answeredAt` as an idempotent success,
    // and the idle-unload check ignores them (see hydration.ts). Dropping them
    // here would clear the projected answered state and defeat idempotency.
    pendingQuestions[pending.requestId] = {
      requestId: pending.requestId,
      projectId,
      worktreeId,
      chatId: pending.chatId,
      questions: pending.questions,
      ...(pending.answers ? { answers: pending.answers } : {}),
      ...(pending.answeredAt !== undefined
        ? { answeredAt: pending.answeredAt }
        : {}),
      ...(pending.toolUseId ? { toolUseId: pending.toolUseId } : {}),
      ...(pending.delivery ? { delivery: pending.delivery } : {}),
      ...(pending.dismissedAt !== undefined
        ? { dismissedAt: pending.dismissedAt }
        : {}),
    };
  }
  return pendingQuestions;
}

export function hasPendingQuestionForChat(
  pendingQuestions: Record<string, PendingQuestion>,
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return Object.values(pendingQuestions).some(
    (pending) =>
      pending.projectId === projectId &&
      pending.worktreeId === worktreeId &&
      pending.chatId === chatId &&
      pending.answeredAt === undefined,
  );
}

export function removePendingQuestionsForChats(
  pendingQuestions: Record<string, PendingQuestion>,
  projectId: string,
  worktreeId: string,
  chatIds: Iterable<string>,
): Record<string, PendingQuestion> {
  const chatIdSet = new Set(chatIds);
  if (chatIdSet.size === 0) {
    return pendingQuestions;
  }

  let changed = false;
  const next = { ...pendingQuestions };
  for (const [id, pending] of Object.entries(next)) {
    if (
      pending.projectId === projectId &&
      pending.worktreeId === worktreeId &&
      chatIdSet.has(pending.chatId)
    ) {
      delete next[id];
      changed = true;
    }
  }

  return changed ? next : pendingQuestions;
}

export function derivePendingQuestionUnreadState(
  chatState: WorktreeChatState,
  pendingQuestions: Record<string, PendingQuestion>,
  projectId: string,
  worktreeId: string,
  activeVisibleChatId?: string,
): { chatState: WorktreeChatState; hasUnreadPendingQuestion: boolean } {
  let tabsChanged = false;
  let hasUnreadPendingQuestion = false;
  const tabs = chatState.tabs.map((tab) => {
    if (
      !hasPendingQuestionForChat(
        pendingQuestions,
        projectId,
        worktreeId,
        tab.id,
      )
    ) {
      return tab;
    }
    if (tab.id === activeVisibleChatId) {
      return tab;
    }
    hasUnreadPendingQuestion = true;
    if (tab.unread === true && tab.attentionDismissedAt === undefined) {
      return tab;
    }
    tabsChanged = true;
    return {
      ...tab,
      unread: true,
      attentionDismissedAt: undefined,
      // Only a transition into unread is attributable to the question; a tab
      // that was already unread keeps whatever raised it, and a manual mark
      // left over from before is dropped.
      ...(tab.unread !== true
        ? { unreadRaisedByQuestion: true, unreadMarkedManually: undefined }
        : {}),
    };
  });
  return {
    chatState: tabsChanged ? { ...chatState, tabs } : chatState,
    hasUnreadPendingQuestion,
  };
}
