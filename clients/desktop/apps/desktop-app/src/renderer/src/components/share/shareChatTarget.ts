import { shareInstallActionLabel } from '@canopy/ui-app/sharing/share-install-copy';
import {
  INSERT_CHAT_TEXT_EVENT,
  type InsertChatTextDetail,
} from '@/lib/editorSelectionContext';
import { useChatStore } from '@/stores/chatStore';
import { isEditableChatTab } from '@/stores/chat/tab-utils';
import { worktreeKey } from '@/stores/chat/utils';
import { useGitHubStore, type ToastAction } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';

/**
 * The chat a share landing opened over (CAN-5219). Installing a shared skill
 * from it keeps the user in that chat and offers **Use in this chat**, which
 * appends the skill's invocation to that chat's composer without sending.
 *
 * The target is captured when the landing opens and never re-resolved: a
 * click after the user moved on must not write into whichever chat is now
 * active. Only the active, editable chat tab of the selected worktree on the
 * worktree chat page qualifies; a remembered chat behind a file tab does not,
 * because its composer is not the one on screen. The cowork `chat` page is
 * excluded: its composer is not addressed by a worktree tab.
 */
export interface ShareChatTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly tabId: string;
}

/** Current page/worktree/tab identity, without a DOM read on store updates. */
function activeShareChatTarget(): ShareChatTarget | null {
  const navigation = useNavigationStore.getState();
  if (
    navigation.activePage !== 'main' ||
    navigation.settingsOpen ||
    navigation.canopyPortalOpen
  ) {
    return null;
  }
  const { selectedWorktree, worktreeChats } = useChatStore.getState();
  if (!selectedWorktree) return null;
  const chats = worktreeChats[worktreeKey(selectedWorktree)];
  if (!chats) return null;
  const activeTab = chats.tabs.find((tab) => tab.id === chats.activeTabId);
  if (!isEditableChatTab(activeTab)) return null;
  return {
    projectId: selectedWorktree.projectId,
    worktreeId: selectedWorktree.worktreeId,
    tabId: activeTab.id,
  };
}

/** The chat whose composer is on screen right now, or null. */
export function captureShareChatTarget(): ShareChatTarget | null {
  const target = activeShareChatTarget();
  if (target === null) return null;
  // Targeted editor-selection events intentionally reach hidden composers.
  // This offer has a stricter contract: the captured tab must own a mounted,
  // visible editor, including when a layout has collapsed its chat panel.
  const visible = Array.from(
    document.querySelectorAll<HTMLElement>('[data-chat-composer-tab-id]'),
  ).some(
    (node): boolean =>
      node.dataset.chatComposerTabId === target.tabId &&
      node.getClientRects().length > 0 &&
      node.querySelector('[data-chat-textarea][contenteditable="true"]') !==
        null,
  );
  if (!visible) return null;
  return target;
}

function hasCurrentIdentity(target: ShareChatTarget): boolean {
  const current = activeShareChatTarget();
  return (
    current !== null &&
    current.projectId === target.projectId &&
    current.worktreeId === target.worktreeId &&
    current.tabId === target.tabId
  );
}

/** The captured chat is still the one on screen. */
export function isShareChatTargetCurrent(target: ShareChatTarget): boolean {
  const current = captureShareChatTarget();
  return (
    current !== null &&
    current.projectId === target.projectId &&
    current.worktreeId === target.worktreeId &&
    current.tabId === target.tabId
  );
}

/**
 * Calls `onInvalid` once, the first time the captured chat stops being the
 * one on screen (a page, worktree, or tab change, or the tab closing).
 * Returns the unsubscribe.
 */
export function watchShareChatTarget(
  target: ShareChatTarget,
  onInvalid: () => void,
): () => void {
  let active = true;
  const check = (): void => {
    if (!active || hasCurrentIdentity(target)) return;
    stop();
    onInvalid();
  };
  const unsubscribeChat = useChatStore.subscribe(check);
  const unsubscribeNavigation = useNavigationStore.subscribe(check);
  function stop(): void {
    active = false;
    unsubscribeChat();
    unsubscribeNavigation();
  }
  return stop;
}

/**
 * The composer text that invokes an installed skill: its installed folder
 * name (a collision rename included) as a slash command, with a trailing
 * space so the user can keep typing. Null when the name cannot be invoked.
 */
function skillInvocationText(skillName: string): string | null {
  return skillName === '' || /\s/.test(skillName) ? null : `/${skillName} `;
}

export type ShareChatInsertOutcome =
  /** The captured composer appended the invocation. */
  | 'inserted'
  /** The captured chat is no longer the one on screen. */
  | 'stale'
  /** No composer for the captured chat accepted the text. */
  | 'unhandled'
  /** The installed skill has no invocable name. */
  | 'invalid';

/**
 * Appends a skill's invocation to the captured chat's composer, keeping its
 * draft, and never sends. Revalidates the target first; a request no
 * composer acknowledges reports `unhandled` and changes nothing.
 */
export function insertSkillInvocation(
  target: ShareChatTarget,
  skillName: string,
): ShareChatInsertOutcome {
  const text = skillInvocationText(skillName);
  if (text === null) return 'invalid';
  if (!isShareChatTargetCurrent(target)) return 'stale';
  let handled = false;
  const detail: InsertChatTextDetail = {
    text,
    targetTabId: target.tabId,
    markHandled: (): void => {
      handled = true;
    },
  };
  document.dispatchEvent(new CustomEvent(INSERT_CHAT_TEXT_EVENT, { detail }));
  return handled ? 'inserted' : 'unhandled';
}

/**
 * Says why Use in this chat could not stage the skill. It answers a click,
 * so like the offer it shows with in-app notifications off and raises no
 * native banner.
 */
export function notifyUseInChatFailure(
  outcome: Exclude<ShareChatInsertOutcome, 'inserted'>,
): void {
  useGitHubStore
    .getState()
    .addToast(
      outcome === 'stale'
        ? 'That chat is no longer open. Type / in a chat to use the skill.'
        : 'Couldn’t add the skill to the chat. Type / in a chat to use it.',
      'warning',
      undefined,
      { forceInApp: true, suppressOsNotification: true },
    );
}

export interface UseInChatOffer {
  /** The installation notice the action rides on. */
  message: string;
  target: ShareChatTarget;
  /** Stages the skill in the target chat; see `insertSkillInvocation`. */
  stage: () => ShareChatInsertOutcome | Promise<ShareChatInsertOutcome>;
}

/**
 * Shows the installation notice with **Use in this chat** as its one
 * action. The notice stays up until it is dismissed so keyboard and
 * screen reader users can reach it, shows even with in-app notifications off
 * (the landing it replaces has closed), and leaves when it is used,
 * dismissed, or the captured chat stops being the one on screen. The action
 * stages the skill at most once.
 */
export function offerUseInChat({
  message,
  target,
  stage,
}: UseInChatOffer): void {
  let settled = false;
  let stopWatching = (): void => undefined;
  let stopReview = (): void => undefined;
  const settle = (): void => {
    settled = true;
    stopWatching();
    stopReview();
  };
  const action: ToastAction = {
    label: shareInstallActionLabel('skill', 'use-in-chat'),
    onClick: async (): Promise<void> => {
      if (settled) return;
      settle();
      const outcome = await stage();
      if (outcome !== 'inserted') notifyUseInChatFailure(outcome);
    },
  };
  const github = useGitHubStore.getState();
  github.addToast(
    message,
    'success',
    undefined,
    {
      action,
      keepUntilDismissed: true,
      forceInApp: true,
      suppressOsNotification: true,
    },
    settle,
  );
  const { toasts, notifications } = useGitHubStore.getState();
  const toastId = [...toasts, ...notifications].find(
    (toast) => toast.meta?.action === action,
  )?.id;
  const invalidate = (): void => {
    if (settled) return;
    settle();
    if (toastId !== undefined) useGitHubStore.getState().dismissToast(toastId);
  };
  stopWatching = watchShareChatTarget(target, invalidate);
  stopReview = useNavigationStore.subscribe((state): void => {
    if (state.pendingShareInstall !== undefined) invalidate();
  });
}
