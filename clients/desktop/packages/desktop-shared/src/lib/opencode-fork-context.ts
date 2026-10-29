import type { PersistedChatTab } from '../types';

type ForkPlanTab = Pick<
  PersistedChatTab,
  | 'pendingPlanExit'
  | 'pendingPlanExitRequestId'
  | 'trackedPlanId'
  | 'trackedPlanSource'
  | 'trackedPlanReviewStatus'
  | 'latestRevisionNumber'
  | 'hasOutstandingProposal'
>;

/** A fork starts without authority over its source's pending plan. */
export function clearOpenCodeForkPlanReview(tab: ForkPlanTab): void {
  delete tab.pendingPlanExit;
  delete tab.pendingPlanExitRequestId;
  delete tab.trackedPlanId;
  delete tab.trackedPlanSource;
  delete tab.trackedPlanReviewStatus;
  delete tab.latestRevisionNumber;
  delete tab.hasOutstandingProposal;
}

/** A text-seeded fork preserves only the visible transcript context. */
export function prepareOpenCodeVisibleFork(
  tab: ForkPlanTab & Pick<PersistedChatTab, 'forkedFrom'>,
): void {
  if (tab.forkedFrom) {
    if (tab.forkedFrom.atMessageId)
      tab.forkedFrom.modelContext = 'visible-transcript';
    else delete tab.forkedFrom.modelContext;
  }
  clearOpenCodeForkPlanReview(tab);
}
