import type {
  ApprovalRequestEvent,
  SidebarItem,
  WorktreeChatBadgesSummary,
} from '@canopy/desktop-shared/types';
import { chatDisplayLabel } from '@canopy/desktop-shared/lib/chat-display-label';
import {
  rankContinueAttention,
  type ContinueAttentionItem,
} from '@canopy/ui-app';
import type {
  ChatTab,
  PendingQuestion,
  WorktreeChatState,
} from '@/stores/chat/types';
import { hasPlanReviewSurface } from './overviewSelectors';
import { getWorkspaceDisplayName } from './workspaceDisplayName';

/** The chat store fields Home Continue attention is derived from. */
export interface DesktopContinueAttentionChatState {
  readonly worktreeChats: Readonly<Record<string, WorktreeChatState>>;
  readonly unreadWorktreeKeys: ReadonlySet<string>;
  readonly pendingQuestions: Readonly<Record<string, PendingQuestion>>;
  readonly pendingApprovals: Readonly<Record<string, ApprovalRequestEvent>>;
  /**
   * Badge summaries of worktrees whose tabs have NOT hydrated. An entry is
   * dropped the moment its worktree hydrates, so its presence is the explicit
   * "not loaded yet" signal for that worktree.
   */
  readonly persistedWorktreeBadges: Readonly<
    Record<string, WorktreeChatBadgesSummary>
  >;
}

export interface DesktopContinueAttentionContext {
  readonly projects: readonly SidebarItem[];
  /** The selected navigation context's workspace filter. */
  readonly isInContext: (workspaceId: string) => boolean;
  /** Visible worktree name: its label, else its branch display name. */
  readonly worktreeName: (worktree: {
    id: string;
    branchName: string;
    label?: string;
  }) => string;
}

interface EligibleWorktree {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly workspaceName: string;
  readonly worktreeName: string;
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

/**
 * Worktrees Continue may point at: code workspaces in the selected context,
 * excluding hidden worktrees. Cowork projects and the synthetic plan-explore
 * scope are absent by construction.
 */
function eligibleWorktrees(
  context: DesktopContinueAttentionContext,
): Map<string, EligibleWorktree> {
  const byKey = new Map<string, EligibleWorktree>();
  for (const project of context.projects) {
    if (project.type === 'cowork' || !context.isInContext(project.id)) continue;
    const workspaceName = getWorkspaceDisplayName(project);
    for (const worktree of project.worktrees) {
      if (worktree.hidden === true) continue;
      byKey.set(worktreeKey(project.id, worktree.id), {
        workspaceId: project.id,
        worktreeId: worktree.id,
        workspaceName,
        worktreeName: context.worktreeName(worktree),
      });
    }
  }
  return byKey;
}

function tabTitle(tab: ChatTab): string {
  return chatDisplayLabel({
    customTitle: tab.customTitle,
    title: tab.title,
    description: tab.description,
    fallback: 'Untitled chat',
  });
}

function chatAttention(
  kind: ContinueAttentionItem['kind'],
  worktree: EligibleWorktree,
  tab: ChatTab,
  extra: Pick<ContinueAttentionItem, 'completed'> = {},
): ContinueAttentionItem {
  return {
    kind,
    target: {
      kind: 'chat',
      workspaceId: worktree.workspaceId,
      worktreeId: worktree.worktreeId,
      chatId: tab.id,
    },
    workspaceName: worktree.workspaceName,
    worktreeName: worktree.worktreeName,
    chatTitle: tabTitle(tab),
    ...(tab.status !== 'streaming' && tab.lastEventAt !== undefined
      ? { eventAt: tab.lastEventAt }
      : {}),
    ...extra,
  };
}

function findTab(
  chats: DesktopContinueAttentionChatState['worktreeChats'],
  key: string,
  chatId: string,
): ChatTab | undefined {
  return chats[key]?.tabs.find((tab) => tab.id === chatId);
}

/**
 * Home Continue attention for desktop (CAN-4958), reusing the Overview and
 * sidebar semantics:
 *
 * - question: unanswered, undismissed ask-user records on a live chat tab;
 * - tool approval: pending chat approvals (`surface: 'non-chat'` excluded);
 * - plan review: tabs with a plan review surface;
 * - unread: tabs flagged unread by a finished turn, not by a question. An idle
 *   tab needs a canonical completed accepted turn before saying "finished".
 *
 * Before a worktree hydrates, its persisted badge summary may report unread
 * chats; it yields one worktree-level row that opens the worktree, since a
 * badge proves neither which tab to open nor that a turn completed. The row
 * disappears atomically when hydration drops the badge entry.
 */
export function selectDesktopContinueAttention(
  chat: DesktopContinueAttentionChatState,
  context: DesktopContinueAttentionContext,
): ContinueAttentionItem[] {
  const worktrees = eligibleWorktrees(context);
  const items: ContinueAttentionItem[] = [];

  for (const question of Object.values(chat.pendingQuestions)) {
    if (
      question.dismissedAt !== undefined ||
      question.answeredAt !== undefined ||
      question.answers !== undefined
    ) {
      continue;
    }
    const key = worktreeKey(question.projectId, question.worktreeId);
    const worktree = worktrees.get(key);
    const tab = worktree && findTab(chat.worktreeChats, key, question.chatId);
    if (worktree && tab) items.push(chatAttention('question', worktree, tab));
  }

  for (const approval of Object.values(chat.pendingApprovals)) {
    if (approval.surface === 'non-chat') continue;
    const key = worktreeKey(approval.projectId, approval.worktreeId);
    const worktree = worktrees.get(key);
    const tab = worktree && findTab(chat.worktreeChats, key, approval.chatId);
    if (worktree && tab) {
      items.push(chatAttention('tool-approval', worktree, tab));
    }
  }

  for (const [key, worktreeChat] of Object.entries(chat.worktreeChats)) {
    const worktree = worktrees.get(key);
    if (!worktree) continue;
    const unreadWorktree = chat.unreadWorktreeKeys.has(key);
    for (const tab of worktreeChat.tabs) {
      if (hasPlanReviewSurface(tab)) {
        items.push(chatAttention('plan-review', worktree, tab));
      }
      if (
        unreadWorktree &&
        tab.unread === true &&
        tab.unreadRaisedByQuestion !== true
      ) {
        items.push(
          chatAttention('unread', worktree, tab, {
            completed:
              tab.status === 'idle' &&
              tab.staleSessionDetected === undefined &&
              tab.lastAcceptedUserMessageId !== undefined &&
              tab.turnEnds?.[tab.lastAcceptedUserMessageId]?.outcome ===
                'completed' &&
              Object.keys(tab.unacceptedTurnEnds ?? {}).length === 0,
          }),
        );
      }
    }
  }

  for (const [key, badges] of Object.entries(chat.persistedWorktreeBadges)) {
    const worktree = worktrees.get(key);
    if (
      !worktree ||
      chat.worktreeChats[key] !== undefined ||
      badges.unreadChats.length === 0
    ) {
      continue;
    }
    const updatedAt = Date.parse(badges.updatedAt);
    items.push({
      kind: 'unread',
      target: {
        kind: 'worktree',
        workspaceId: worktree.workspaceId,
        worktreeId: worktree.worktreeId,
      },
      workspaceName: worktree.workspaceName,
      worktreeName: worktree.worktreeName,
      ...(Number.isFinite(updatedAt) ? { eventAt: updatedAt } : {}),
    });
  }

  return rankContinueAttention(items);
}

/** Compare only attention inputs, never streamed message bodies or token times. */
function sameAttentionTab(left: ChatTab, right: ChatTab): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.customTitle === right.customTitle &&
    left.description === right.description &&
    left.status === right.status &&
    left.unread === right.unread &&
    left.unreadRaisedByQuestion === right.unreadRaisedByQuestion &&
    left.pendingPlanExit === right.pendingPlanExit &&
    left.trackedPlanId === right.trackedPlanId &&
    left.trackedPlanReviewStatus === right.trackedPlanReviewStatus &&
    left.staleSessionDetected === right.staleSessionDetected &&
    left.lastAcceptedUserMessageId === right.lastAcceptedUserMessageId &&
    left.turnEnds === right.turnEnds &&
    left.unacceptedTurnEnds === right.unacceptedTurnEnds &&
    (left.status === 'streaming' || left.lastEventAt === right.lastEventAt)
  );
}

/**
 * A component-owned narrow selector. Token publications compare projected tab
 * fields but never rebuild/rank attention, look up labels, or serialize messages.
 * Context changes create a new selector; all eligibility and copy fields above
 * are compared explicitly, including resolution and hydration references.
 */
export function createDesktopContinueAttentionSelector(
  context: DesktopContinueAttentionContext,
): (state: DesktopContinueAttentionChatState) => ContinueAttentionItem[] {
  let previous: DesktopContinueAttentionChatState | undefined;
  let items: ContinueAttentionItem[] = [];
  return (state): ContinueAttentionItem[] => {
    const before = previous;
    previous = state;
    if (
      before !== undefined &&
      before.pendingQuestions === state.pendingQuestions &&
      before.pendingApprovals === state.pendingApprovals &&
      before.persistedWorktreeBadges === state.persistedWorktreeBadges &&
      before.unreadWorktreeKeys === state.unreadWorktreeKeys
    ) {
      const keys = Object.keys(state.worktreeChats);
      if (
        keys.length === Object.keys(before.worktreeChats).length &&
        keys.every((key) => {
          const left = before.worktreeChats[key];
          const right = state.worktreeChats[key];
          return (
            left !== undefined &&
            right !== undefined &&
            (left === right ||
              (left.tabs.length === right.tabs.length &&
                right.tabs.every((tab, index) => {
                  const prior = left.tabs[index];
                  return prior !== undefined && sameAttentionTab(prior, tab);
                })))
          );
        })
      )
        return items;
    }
    items = selectDesktopContinueAttention(state, context);
    return items;
  };
}
