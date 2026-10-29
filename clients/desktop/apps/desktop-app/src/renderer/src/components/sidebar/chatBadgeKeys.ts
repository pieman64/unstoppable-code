import type {
  ApprovalRequestEvent,
  WorktreeChatBadgesSummary,
} from '@canopy/desktop-shared/types';
import type { PendingPlanExit, PendingQuestion } from '@/stores/chat/types';

/** The only tab fields the badge-key derivation reads. */
export interface ChatBadgeKeyTab {
  id: string;
  status: string;
  pendingPlanExit?: Record<string, unknown>;
}

/**
 * Narrow structural view of the chat store consumed by
 * {@link deriveChatBadgeKeys}. Declaring the inputs rather than the whole
 * `ChatState` keeps the derivation unit-testable without standing up a store.
 */
export interface ChatBadgeKeySource {
  pendingPlanExits: Record<string, PendingPlanExit>;
  pendingQuestions: Record<string, PendingQuestion>;
  pendingApprovals: Record<string, ApprovalRequestEvent>;
  worktreeChats: Record<string, { tabs: readonly ChatBadgeKeyTab[] }>;
  persistedWorktreeBadges: Record<string, WorktreeChatBadgesSummary>;
}

/**
 * Chats with live managed delegates, as the delegation activity store keeps
 * them (`byChat`). Only the identity and counts are read.
 */
export type LiveDelegateChats = Readonly<
  Record<
    string,
    {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly chatId: string;
      readonly live: number;
      readonly queued: number;
    }
  >
>;

/**
 * Sorted, comma-joined `${projectId}/${worktreeId}` key lists. Strings rather
 * than Sets on purpose: the sidebar selectors compare them by value, so a
 * streaming token that changes no membership produces no re-render.
 */
export interface ChatBadgeKeys {
  /** Worktrees with a chat the agent is actively working in. */
  streaming: string;
  /**
   * Worktrees with a live provider session or live managed delegates
   * (currently mirrors `streaming`). Drives `hasActiveSession`, which
   * disables Archive and Delete.
   */
  active: string;
  /** Worktrees with a plan awaiting the user's approval. */
  awaiting: string;
  /** Worktrees with an unanswered ask-user question. */
  question: string;
  /** Worktrees with a chat blocked on a Canopy tool-approval prompt. */
  toolApproval: string;
}

/**
 * Derive every sidebar row's attention key sets from the chat store.
 *
 * THE single implementation — both sidebar hosts call this rather than
 * maintaining their own copy, because the hand-duplicated versions had already
 * drifted (only one folded `persistedWorktreeBadges` into `awaiting`, so the
 * other lost cold-start plan-approval dots until the worktree hydrated).
 *
 * A chat blocked on the user is deliberately excluded from `streaming`: the
 * agent is parked, not working, so the row shows the needs-input dot instead
 * of a spinner that would read as healthy progress. This is a derivation-only
 * suppression — `tab.status` stays `'streaming'` so session restore does not
 * force-close the tab out from under a backend prompt that has no timeout.
 *
 * A chat whose managed delegates are still queued or running counts as working
 * even after its own turn ended (`liveDelegateChats`), with the same
 * blocked-on-the-user suppression. Delegate activity never goes through
 * `tab.status`, for the same restore reason.
 */
export function deriveChatBadgeKeys(
  state: ChatBadgeKeySource,
  liveDelegateChats: LiveDelegateChats = {},
): ChatBadgeKeys {
  const planExits = Object.values(state.pendingPlanExits);
  const planExitChatIds = new Set(planExits.map((exit) => exit.chatId));
  const unansweredQuestions = Object.values(state.pendingQuestions).filter(
    (question) => question.answeredAt === undefined,
  );
  const questionChatIds = new Set(
    unansweredQuestions.map((question) => question.chatId),
  );
  const approvals = Object.values(state.pendingApprovals);
  const approvalChatIds = new Set(approvals.map((approval) => approval.chatId));

  const streaming: string[] = [];
  const activeSessions: string[] = [];
  const awaiting: string[] = [];
  const question: string[] = [];
  const toolApproval: string[] = [];

  for (const exit of planExits) {
    awaiting.push(`${exit.projectId}/${exit.worktreeId}`);
  }
  for (const pending of unansweredQuestions) {
    question.push(`${pending.projectId}/${pending.worktreeId}`);
  }
  for (const approval of approvals) {
    toolApproval.push(`${approval.projectId}/${approval.worktreeId}`);
  }

  for (const [key, chats] of Object.entries(state.worktreeChats)) {
    // Any tab streaming lights the row, not just the active one.
    const hasStreaming = chats.tabs.some(
      (tab) =>
        tab.status === 'streaming' &&
        !tab.pendingPlanExit &&
        !planExitChatIds.has(tab.id) &&
        !questionChatIds.has(tab.id) &&
        !approvalChatIds.has(tab.id),
    );
    if (hasStreaming) {
      streaming.push(key);
      activeSessions.push(key);
    }
    if (chats.tabs.some((tab) => !!tab.pendingPlanExit)) {
      awaiting.push(key);
    }
  }

  // Live delegates light the row whether or not the worktree is hydrated.
  for (const entry of Object.values(liveDelegateChats)) {
    if (entry.live + entry.queued <= 0) continue;
    const key = `${entry.projectId}/${entry.worktreeId}`;
    // Pending input suppresses only the working indicator. The delegate
    // still owns the worktree, so Archive and Delete remain unavailable.
    activeSessions.push(key);
    if (
      planExitChatIds.has(entry.chatId) ||
      questionChatIds.has(entry.chatId) ||
      approvalChatIds.has(entry.chatId)
    ) {
      continue;
    }
    const pendingPlanExit = state.worktreeChats[key]?.tabs.some(
      (tab) => tab.id === entry.chatId && !!tab.pendingPlanExit,
    );
    if (pendingPlanExit) continue;
    streaming.push(key);
  }

  // Non-hydrated worktrees: persisted badge summaries stand in for live tab
  // state (entries are dropped the moment a worktree hydrates).
  for (const [key, badges] of Object.entries(state.persistedWorktreeBadges)) {
    if (badges.approvalChats.length > 0) {
      awaiting.push(key);
    }
  }

  return {
    streaming: Array.from(new Set(streaming)).sort().join(','),
    active: Array.from(new Set(activeSessions)).sort().join(','),
    awaiting: Array.from(new Set(awaiting)).sort().join(','),
    question: Array.from(new Set(question)).sort().join(','),
    toolApproval: Array.from(new Set(toolApproval)).sort().join(','),
  };
}
