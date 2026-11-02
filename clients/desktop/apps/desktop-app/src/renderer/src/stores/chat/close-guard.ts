/**
 * The single "can this chat be closed right now?" predicate.
 *
 * A chat stays open while its own turn is active (streaming, queued messages
 * other than a lone hook placeholder, or a plan awaiting review), while it
 * has live managed delegates (queued, starting or running, even after the
 * parent turn ended), or while its provider runs background agents or
 * workflows (never shells). `closeTab` / `closeTabs`, the tab context menu,
 * the tab ×, and every panel close path share this so none of them removes a
 * chat the store would refuse. Main refuses the same cases, delegates first.
 *
 * Delegate activity comes from `delegationActivityStore` and provider work
 * from `liveBackgroundTaskStore`, never from `tab.status`; see those stores
 * for why.
 */
import type { ChatTab } from './types';
import {
  getOnlyQueuedHookPlaceholderQueueId,
  type QueuedHookPlaceholderTab,
} from './tab-utils';
import {
  selectChatHasLiveDelegates,
  selectWorktreeHasLiveDelegates,
  useDelegationActivityStore,
  type DelegationActivityState,
} from '../delegationActivityStore';
import {
  isWorktreeLiveTasksHydrated,
  selectChatProviderBlocksClose,
  selectWorkspaceProviderBlocksClose,
  selectWorktreeProviderBlocksClose,
  useLiveBackgroundTaskStore,
  type LiveBackgroundTaskState,
  type LiveBackgroundTaskWorktreeTarget,
} from '../liveBackgroundTaskStore';
import { useGitHubStore } from '../githubStore';
import { findWorktreeRemovalRefusal } from '@/lib/worktreeRemovalAdmission';

/** Tooltip on the disabled tab × while delegates keep the chat open. */
export const DELEGATES_BLOCK_CLOSE_TOOLTIP =
  'Stop its delegates to close this chat';

/** Notice when a close request is refused because delegates are running. */
export const DELEGATES_BLOCK_CLOSE_NOTICE =
  'Delegates are still running. Open background work and stop them to close this chat.';

export function delegatesBlockCloseNotice(): string {
  return DELEGATES_BLOCK_CLOSE_NOTICE;
}

/** Appended to the auto-archive toggle tooltip while delegates are running. */
export const DELEGATES_DEFER_AUTO_ARCHIVE_TOOLTIP =
  'Archives after its delegates finish.';

/** Refusal copy for removing a worktree or Work Entry with live delegates. */
export const DELEGATES_BLOCK_REMOVAL_TOOLTIP =
  'Delegates are still running here. Stop them first.';

/** Tooltip on the disabled tab × while provider agents or workflows run. */
export const BACKGROUND_BLOCKS_CLOSE_TOOLTIP =
  'Stop its background agents and workflows to close this chat';

/** Notice when a close request is refused because provider work is running. */
export const BACKGROUND_BLOCKS_CLOSE_NOTICE =
  'Background agents or workflows are still running. Open background work and stop them to close this chat.';

/** Appended to the auto-archive toggle tooltip while provider work runs. */
export const BACKGROUND_DEFERS_AUTO_ARCHIVE_TOOLTIP =
  'Archives after its background agents and workflows finish.';

/** Refusal copy for removing a scope whose provider agents or workflows run. */
export const BACKGROUND_BLOCKS_REMOVAL_TOOLTIP =
  'Background agents or workflows are still running here. Stop them first.';

/** Removal refusal when the live-task state of a target could not be loaded. */
export const BACKGROUND_WORK_CHECK_FAILED =
  "Couldn't check for running background agents or workflows. Try again.";

/**
 * Why a chat cannot close: `active` for its own turn state, `delegates` when
 * its live delegates hold it open, `background` when only its provider's
 * background agents or workflows do.
 */
export type ChatCloseBlocker = 'active' | 'delegates' | 'background';

/** Why a worktree, Work Entry or workspace cannot be removed right now. */
export type RemovalBlocker = 'delegates' | 'background';

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
  liveTaskState: Pick<
    LiveBackgroundTaskState,
    'byChat'
  > = useLiveBackgroundTaskStore.getState(),
): ChatCloseBlocker | null {
  if (tab.kind === 'file') return null;
  if (isChatTabTurnActive(tab)) return 'active';
  if (
    selectChatHasLiveDelegates(delegationState, projectId, worktreeId, tab.id)
  ) {
    return 'delegates';
  }
  if (
    selectChatProviderBlocksClose(liveTaskState, projectId, worktreeId, tab.id)
  ) {
    return 'background';
  }
  return null;
}

/** Whether the chat is busy and must stay open. */
export function isChatTabBusy(
  tab: ChatTabCloseFields,
  projectId: string,
  worktreeId: string,
  delegationState?: DelegationActivityState,
  liveTaskState?: Pick<LiveBackgroundTaskState, 'byChat'>,
): boolean {
  return (
    getChatTabCloseBlocker(
      tab,
      projectId,
      worktreeId,
      delegationState,
      liveTaskState,
    ) !== null
  );
}

/**
 * Tooltip for the disabled tab ×. A chat's own running turn already shows
 * its spinner, so only work the tab does not show is spelled out.
 */
export function closeBlockedTooltip(
  blocker: ChatCloseBlocker | null,
): string | undefined {
  if (blocker === 'delegates') return DELEGATES_BLOCK_CLOSE_TOOLTIP;
  if (blocker === 'background') return BACKGROUND_BLOCKS_CLOSE_TOOLTIP;
  return undefined;
}

/**
 * The one notice for a close gesture that refused these chats: delegates win
 * over provider work, and a chat's own turn says nothing.
 */
export function closeBlockedNotice(
  blockers: Iterable<ChatCloseBlocker | null>,
): string | null {
  let notice: string | null = null;
  for (const blocker of Array.from(blockers)) {
    if (blocker === 'delegates') return delegatesBlockCloseNotice();
    if (blocker === 'background') notice = BACKGROUND_BLOCKS_CLOSE_NOTICE;
  }
  return notice;
}

/**
 * Tell the user why a close gesture did nothing, once per gesture: pass every
 * blocker the gesture hit. A notice still on screen is not repeated, so a
 * burst of close attempts shows one.
 */
export function notifyCloseBlocked(
  blockers: Iterable<ChatCloseBlocker | null>,
): void {
  const notice = closeBlockedNotice(blockers);
  if (notice === null) return;
  const github = useGitHubStore.getState();
  if (github.toasts.some((toast) => toast.message === notice)) {
    return;
  }
  github.addToast(notice, 'info', undefined, {
    // Feedback to the user's own close gesture, not a notification.
    forceInApp: true,
    suppressOsNotification: true,
  });
}

/**
 * Why this worktree (or Cowork Work Entry) cannot be removed, delegates
 * first, or `null`. Reads only what the mirrors know; destructive paths call
 * {@link recheckWorktreeRemovalBlockedReason} first.
 */
export function getWorktreeRemovalBlocker(
  projectId: string,
  worktreeId: string,
  delegationState: DelegationActivityState = useDelegationActivityStore.getState(),
  liveTaskState: Pick<
    LiveBackgroundTaskState,
    'byChat'
  > = useLiveBackgroundTaskStore.getState(),
): RemovalBlocker | null {
  if (selectWorktreeHasLiveDelegates(delegationState, projectId, worktreeId)) {
    return 'delegates';
  }
  if (selectWorktreeProviderBlocksClose(liveTaskState, projectId, worktreeId)) {
    return 'background';
  }
  return null;
}

/** Why this project or Cowork project cannot be deleted, or `null`. */
export function getWorkspaceRemovalBlocker(
  projectId: string,
  delegationState: Pick<
    DelegationActivityState,
    'byChat'
  > = useDelegationActivityStore.getState(),
  liveTaskState: Pick<
    LiveBackgroundTaskState,
    'byChat'
  > = useLiveBackgroundTaskStore.getState(),
): RemovalBlocker | null {
  if (
    Object.values(delegationState.byChat).some(
      (entry) => entry.projectId === projectId && entry.live + entry.queued > 0,
    )
  ) {
    return 'delegates';
  }
  if (selectWorkspaceProviderBlocksClose(liveTaskState, projectId)) {
    return 'background';
  }
  return null;
}

/** Refusal copy for a removal blocker. */
export function removalBlockedReason(
  blocker: RemovalBlocker | null,
): string | undefined {
  if (blocker === 'delegates') return DELEGATES_BLOCK_REMOVAL_TOOLTIP;
  if (blocker === 'background') return BACKGROUND_BLOCKS_REMOVAL_TOOLTIP;
  return undefined;
}

/**
 * Re-check right before removing these worktrees or Work Entries: hydrate
 * the live-task mirror for any the renderer has not pulled (an unvisited
 * worktree after a reload), then return the refusal copy if any target has
 * close-blocking work (delegates first), else `undefined`.
 */
export async function recheckWorktreeRemovalBlockedReason(
  targets: readonly LiveBackgroundTaskWorktreeTarget[],
): Promise<string | undefined> {
  await useLiveBackgroundTaskStore.getState().ensureWorktreesHydrated(targets);
  // A failed pull leaves its target unknown; removing siblings first would
  // leave the removal half done when main then refuses the busy one.
  if (!targetsHydrated(targets)) return BACKGROUND_WORK_CHECK_FAILED;
  const delegationState = useDelegationActivityStore.getState();
  const liveTaskState = useLiveBackgroundTaskStore.getState();
  const blockers = targets.map((target) =>
    getWorktreeRemovalBlocker(
      target.projectId,
      target.worktreeId,
      delegationState,
      liveTaskState,
    ),
  );
  return removalBlockedReason(
    blockers.includes('delegates')
      ? 'delegates'
      : blockers.includes('background')
        ? 'background'
        : null,
  );
}

/**
 * {@link recheckWorktreeRemovalBlockedReason} for deleting a whole project or
 * Cowork project: hydrate its worktrees, then check every chat it holds. A
 * code project passes its `sourceAdmissionKind` so every worktree also passes
 * main's source admission before the first archive (CAN-5333); a failed check
 * rejects.
 */
export async function recheckWorkspaceRemovalBlockedReason(
  projectId: string,
  worktreeIds: readonly string[],
  sourceAdmissionKind?: 'single-repo' | 'multi-repo',
): Promise<string | undefined> {
  const targets = worktreeIds.map((worktreeId) => ({ projectId, worktreeId }));
  await useLiveBackgroundTaskStore.getState().ensureWorktreesHydrated(targets);
  if (!targetsHydrated(targets)) return BACKGROUND_WORK_CHECK_FAILED;
  const blocked = removalBlockedReason(getWorkspaceRemovalBlocker(projectId));
  if (blocked !== undefined || sourceAdmissionKind === undefined) {
    return blocked;
  }
  const refusal = await findWorktreeRemovalRefusal(
    projectId,
    worktreeIds,
    sourceAdmissionKind,
  );
  return refusal?.message;
}

function targetsHydrated(
  targets: readonly LiveBackgroundTaskWorktreeTarget[],
): boolean {
  return targets.every((target) =>
    isWorktreeLiveTasksHydrated(target.projectId, target.worktreeId),
  );
}
