/**
 * The single "can this chat be closed right now?" predicate.
 *
 * A chat stays open while its own turn is active (streaming, queued messages
 * other than a lone hook placeholder, or a plan awaiting review) or while it
 * has live managed delegates (queued, starting or running, even after the
 * parent turn ended). `closeTab` / `closeTabs`, the tab context menu, the tab
 * ×, and every panel close path share this so none of them removes a chat the
 * store would refuse.
 *
 * Delegate activity comes from `delegationActivityStore`, never from
 * `tab.status`; see that store for why.
 */
import type { ChatTab } from './types';
import {
  getOnlyQueuedHookPlaceholderQueueId,
  type QueuedHookPlaceholderTab,
} from './tab-utils';
import {
  selectChatHasLiveDelegates,
  useDelegationActivityStore,
  type DelegationActivityState,
} from '../delegationActivityStore';
import { useGitHubStore } from '../githubStore';
import { getLabsFeatureEnabled } from '../labsExperimentsStore';

/** Tooltip on the disabled tab × while delegates keep the chat open. */
export const DELEGATES_BLOCK_CLOSE_TOOLTIP =
  'Stop its delegates to close this chat';

/** Notice when a close request is refused because delegates are running. */
export const DELEGATES_BLOCK_CLOSE_NOTICE =
  'Delegates are still running. Stop them in Agent activity to close this chat.';

/**
 * The same notice under the Subagents view experiment, which moves Stop all
 * from the chat's Agent activity section to the Subagents panel.
 */
export const DELEGATES_BLOCK_CLOSE_NOTICE_SUBAGENTS_VIEW =
  'Delegates are still running. Stop them in Subagents to close this chat.';

/** The close notice for the current Subagents view choice. */
export function delegatesBlockCloseNotice(): string {
  return getLabsFeatureEnabled('subagents-view')
    ? DELEGATES_BLOCK_CLOSE_NOTICE_SUBAGENTS_VIEW
    : DELEGATES_BLOCK_CLOSE_NOTICE;
}

/** Appended to the auto-archive toggle tooltip while delegates are running. */
export const DELEGATES_DEFER_AUTO_ARCHIVE_TOOLTIP =
  'Archives after its delegates finish.';

/** Refusal copy for removing a worktree or Work Entry with live delegates. */
export const DELEGATES_BLOCK_REMOVAL_TOOLTIP =
  'Delegates are still running here. Stop them first.';

/**
 * Why a chat cannot close: `active` for its own turn state, `delegates` when
 * only its live delegates hold it open.
 */
export type ChatCloseBlocker = 'active' | 'delegates';

/**
 * Whether the chat's own turn keeps it open. A queued hook placeholder with
 * only the hook prompt is the one exception: closing it cancels the queue
 * entry instead.
 */
/**
 * The tab fields the close predicates read: a chat tab, or a tab-strip
 * projection (`ChatTabStripTab`).
 */
export type ChatTabCloseFields = Pick<
  ChatTab,
  'id' | 'kind' | 'status' | 'queuedMessages' | 'pendingPlanExit'
> &
  QueuedHookPlaceholderTab;

export function isChatTabTurnActive(tab: ChatTabCloseFields): boolean {
  if (tab.kind === 'file') return false;
  return (
    tab.status === 'streaming' ||
    (tab.queuedMessages.length > 0 &&
      getOnlyQueuedHookPlaceholderQueueId(tab) === null) ||
    tab.pendingPlanExit !== undefined
  );
}

/** The reason a chat cannot close, or `null` when it can. File tabs never block. */
export function getChatTabCloseBlocker(
  tab: ChatTabCloseFields,
  projectId: string,
  worktreeId: string,
  delegationState: DelegationActivityState = useDelegationActivityStore.getState(),
): ChatCloseBlocker | null {
  if (tab.kind === 'file') return null;
  if (isChatTabTurnActive(tab)) return 'active';
  if (
    selectChatHasLiveDelegates(delegationState, projectId, worktreeId, tab.id)
  ) {
    return 'delegates';
  }
  return null;
}

/** Whether the chat is busy and must stay open. */
export function isChatTabBusy(
  tab: ChatTabCloseFields,
  projectId: string,
  worktreeId: string,
  delegationState?: DelegationActivityState,
): boolean {
  return (
    getChatTabCloseBlocker(tab, projectId, worktreeId, delegationState) !== null
  );
}

/**
 * Tell the user why a close did nothing. A notice still on screen is not
 * repeated, so a burst of close attempts shows one.
 */
export function notifyDelegatesBlockClose(): void {
  const github = useGitHubStore.getState();
  const notice = delegatesBlockCloseNotice();
  if (github.toasts.some((toast) => toast.message === notice)) {
    return;
  }
  github.addToast(notice, 'info', undefined, {
    // Feedback to the user's own close gesture, not a notification.
    forceInApp: true,
    suppressOsNotification: true,
  });
}
