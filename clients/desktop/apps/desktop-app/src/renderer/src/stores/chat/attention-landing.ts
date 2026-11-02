import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import { hasPendingApprovalForChat } from './pending-approvals';
import { hasPendingQuestionForChat } from './pending-questions';
import type { ChatTab, PendingPlanExit, PendingQuestion } from './types';

/**
 * Attention landing (CAN-4957): which tab an implicit worktree entry opens
 * on, so a returning user lands on the chat that needs them rather than the
 * tab they last read.
 *
 * Tiers, highest first, over the worktree's visible chat tabs:
 *
 * 1. An unanswered question.
 * 2. A pending tool approval.
 * 3. A plan waiting for review.
 * 4. An unread chat.
 * 5. Otherwise the persisted active tab (and its existing fallbacks).
 *
 * Within a needs-input tier the active tab stays when it is in that tier;
 * otherwise the first tab in strip order wins. Within the unread tier an
 * unread active tab stays; otherwise the newest unread tab wins. The active
 * tab never outranks a higher tier on another tab.
 *
 * Hidden tabs and file tabs are never targets, and only records for this
 * scope and for tabs that still exist count. Dismissal alone does not resolve
 * a question: only an answer does.
 */
export interface AttentionLandingInput {
  readonly projectId: string;
  readonly worktreeId: string;
  /** The worktree's tabs in strip order. */
  readonly tabs: readonly ChatTab[];
  readonly activeTabId: string | undefined;
  readonly hiddenChatTabIds: ReadonlySet<string>;
  readonly pendingQuestions: Record<string, PendingQuestion>;
  readonly pendingApprovals: Record<string, ApprovalRequestEvent>;
  readonly pendingPlanExits: Record<string, PendingPlanExit>;
}

/**
 * An implicit entry's landing: the tab to switch to, or `null` to keep the
 * current selection, and whether any tab needs attention (so `tabId: null`
 * with `attended: true` means the active tab already is the target).
 */
export interface AttentionLanding {
  readonly tabId: string | null;
  readonly attended: boolean;
}

export const NO_ATTENTION_LANDING: AttentionLanding = {
  tabId: null,
  attended: false,
};

export function resolveAttentionLanding(
  input: AttentionLandingInput,
): AttentionLanding {
  const eligible = input.tabs.filter(
    (tab) => tab.kind !== 'file' && !input.hiddenChatTabIds.has(tab.id),
  );
  const tiers: readonly ((tab: ChatTab) => boolean)[] = [
    (tab): boolean =>
      hasPendingQuestionForChat(
        input.pendingQuestions,
        input.projectId,
        input.worktreeId,
        tab.id,
      ),
    (tab): boolean =>
      hasPendingApprovalForChat(
        input.pendingApprovals,
        input.projectId,
        input.worktreeId,
        tab.id,
      ),
    (tab): boolean => hasPendingPlanReview(input, tab),
  ];
  for (const inTier of tiers) {
    const candidates = eligible.filter(inTier);
    if (candidates.length === 0) continue;
    return {
      tabId: pickInStripOrder(candidates, input.activeTabId),
      attended: true,
    };
  }

  const unread = eligible.filter((tab) => tab.unread === true);
  if (unread.length === 0) return NO_ATTENTION_LANDING;
  if (unread.some((tab) => tab.id === input.activeTabId)) {
    return { tabId: null, attended: true };
  }
  return {
    tabId: keepOrReplace(newestUnread(unread), input.activeTabId),
    attended: true,
  };
}

function hasPendingPlanReview(
  input: AttentionLandingInput,
  tab: ChatTab,
): boolean {
  if (tab.pendingPlanExit !== undefined) return true;
  return Object.values(input.pendingPlanExits).some(
    (pending) =>
      pending.projectId === input.projectId &&
      pending.worktreeId === input.worktreeId &&
      pending.chatId === tab.id,
  );
}

function pickInStripOrder(
  candidates: readonly ChatTab[],
  activeTabId: string | undefined,
): string | null {
  if (candidates.some((tab) => tab.id === activeTabId)) return null;
  return keepOrReplace(candidates[0], activeTabId);
}

function keepOrReplace(
  tab: ChatTab | undefined,
  activeTabId: string | undefined,
): string | null {
  return tab === undefined || tab.id === activeTabId ? null : tab.id;
}

/**
 * The most recently active unread tab: by its latest valid message time, then
 * its last live event, then its creation time. A missing or invalid time
 * sorts oldest, and a later strip position breaks ties.
 */
function newestUnread(tabs: readonly ChatTab[]): ChatTab | undefined {
  let newest: ChatTab | undefined;
  let newestTime = Number.NEGATIVE_INFINITY;
  for (const tab of tabs) {
    const time = tabActivityTime(tab);
    if (newest === undefined || time >= newestTime) {
      newest = tab;
      newestTime = time;
    }
  }
  return newest;
}

function tabActivityTime(tab: ChatTab): number {
  // Messages are not guaranteed to be in time order (imports, restored
  // history), so take the latest valid one rather than the last element.
  let latestMessage = Number.NEGATIVE_INFINITY;
  for (const message of tab.messages) {
    if (validTime(message.timestamp)) {
      latestMessage = Math.max(latestMessage, message.timestamp);
    }
  }
  if (latestMessage !== Number.NEGATIVE_INFINITY) return latestMessage;
  if (validTime(tab.lastEventAt)) return tab.lastEventAt;
  const created = Date.parse(tab.createdAt);
  return validTime(created) ? created : Number.NEGATIVE_INFINITY;
}

function validTime(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}
