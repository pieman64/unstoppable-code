// Sidebar and badge state, split out of the chat store (phase 15 of the
// desktop performance plan, P2 renderer item 11).
//
// Sidebar rows, unread markers and the review/plan/question badges read a few
// tab fields of every loaded worktree. As `useChatStore` selectors they ran
// on every chat store publication — so for every streamed token of any chat —
// and the badge derivation walked every worktree and tab each time. This
// store holds exactly what they read and publishes only when one of those
// values changes, which streamed content never does.
//
// It is fed from the chat store's frame-batched view (`chatStoreRenderView`),
// the same publication every `useChatStore` selector reads, so its values are
// always those selectors' values over the same snapshot: it can never
// disagree with the chat store, and phase 12's render cadence carries over.
// The live-delegate input of the badge keys comes from the delegation
// activity store, as before, and the live provider-task input from the live
// background-task store.

import { createStore, useStore, type StoreApi } from 'zustand';
import type {
  ApprovalRequestEvent,
  WorktreeChatBadgesSummary,
} from '@canopy/desktop-shared/types';
import {
  deriveChatBadgeKeys,
  type ChatBadgeKeys,
  type LiveDelegateChats,
  type LiveProviderTaskChats,
} from '@/components/sidebar/chatBadgeKeys';
import { chatStoreRenderView } from './chatStore';
import { useDelegationActivityStore } from './delegationActivityStore';
import { useLiveBackgroundTaskStore } from './liveBackgroundTaskStore';
import type { ChatState } from './chat/state';
import type {
  ChatTab,
  PendingPlanExit,
  PendingQuestion,
  WorktreeChatState,
} from './chat/types';

/** The tab fields sidebar rows and badges read. */
export interface ChatSidebarTab {
  readonly id: string;
  readonly title: ChatTab['title'];
  readonly providerType?: ChatTab['providerType'];
  readonly status: ChatTab['status'];
  readonly unread?: ChatTab['unread'];
  readonly pendingPlanExit?: ChatTab['pendingPlanExit'];
}

/** One loaded worktree's tabs, in tab order. */
export interface ChatSidebarWorktree {
  readonly tabs: readonly ChatSidebarTab[];
}

export interface ChatSidebarState {
  /** Every loaded worktree (`worktreeChats` keys), in the same order. */
  readonly worktrees: Readonly<Record<string, ChatSidebarWorktree>>;
  /** The chat store's `unreadWorktreeKeys`, by identity. */
  readonly unreadWorktreeKeys: ChatState['unreadWorktreeKeys'];
  /** The chat store's `pendingQuestions`, by identity. */
  readonly pendingQuestions: Readonly<Record<string, PendingQuestion>>;
  /** Every row's attention keys (`deriveChatBadgeKeys`). */
  readonly badgeKeys: ChatBadgeKeys;
}

/** The chat store fields the sidebar state is derived from. */
type ChatSidebarSource = Pick<
  ChatState,
  | 'worktreeChats'
  | 'unreadWorktreeKeys'
  | 'pendingQuestions'
  | 'pendingPlanExits'
  | 'pendingApprovals'
  | 'persistedWorktreeBadges'
>;

function toSidebarTab(tab: ChatTab): ChatSidebarTab {
  return {
    id: tab.id,
    title: tab.title,
    providerType: tab.providerType,
    status: tab.status,
    unread: tab.unread,
    pendingPlanExit: tab.pendingPlanExit,
  };
}

function sameSidebarTab(left: ChatSidebarTab, right: ChatSidebarTab): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.providerType === right.providerType &&
    left.status === right.status &&
    left.unread === right.unread &&
    left.pendingPlanExit === right.pendingPlanExit
  );
}

function sameBadgeKeys(left: ChatBadgeKeys, right: ChatBadgeKeys): boolean {
  return (
    left.streaming === right.streaming &&
    left.active === right.active &&
    left.awaiting === right.awaiting &&
    left.question === right.question &&
    left.toolApproval === right.toolApproval &&
    left.background === right.background
  );
}

/** Inputs of the last derivation, to skip what did not change. */
interface ChatSidebarDerivationMemo {
  /** False until the first derivation, which always derives the badge keys. */
  derived: boolean;
  worktreeChats?: Record<string, WorktreeChatState>;
  sources: WeakMap<WorktreeChatState, ChatSidebarWorktree>;
  pendingPlanExits?: Record<string, PendingPlanExit>;
  pendingQuestions?: Record<string, PendingQuestion>;
  pendingApprovals?: Record<string, ApprovalRequestEvent>;
  persistedWorktreeBadges?: Record<string, WorktreeChatBadgesSummary>;
  liveDelegateChats?: LiveDelegateChats;
  liveProviderTaskChats?: LiveProviderTaskChats;
}

function createChatSidebarDerivationMemo(): ChatSidebarDerivationMemo {
  return { derived: false, sources: new WeakMap() };
}

function deriveWorktree(
  chatState: WorktreeChatState,
  previous: ChatSidebarWorktree | undefined,
): ChatSidebarWorktree {
  let changed = !previous || previous.tabs.length !== chatState.tabs.length;
  const tabs = chatState.tabs.map((tab, index) => {
    const before = previous?.tabs[index];
    const next = toSidebarTab(tab);
    if (before && sameSidebarTab(before, next)) return before;
    changed = true;
    return next;
  });
  return changed || !previous ? { tabs } : previous;
}

function deriveWorktrees(
  worktreeChats: Record<string, WorktreeChatState>,
  previous: Readonly<Record<string, ChatSidebarWorktree>>,
  memo: ChatSidebarDerivationMemo,
): Readonly<Record<string, ChatSidebarWorktree>> {
  const keys = Object.keys(worktreeChats);
  const previousKeys = Object.keys(previous);
  let changed = keys.length !== previousKeys.length;
  const next: Record<string, ChatSidebarWorktree> = {};
  keys.forEach((key, index) => {
    if (previousKeys[index] !== key) changed = true;
    const chatState = worktreeChats[key];
    const before = previous[key];
    let entry = memo.sources.get(chatState);
    if (!entry || (before !== undefined && entry !== before)) {
      entry = deriveWorktree(chatState, before);
      memo.sources.set(chatState, entry);
    }
    if (entry !== before) changed = true;
    next[key] = entry;
  });
  return changed ? next : previous;
}

const EMPTY_BADGE_KEYS: ChatBadgeKeys = {
  streaming: '',
  active: '',
  awaiting: '',
  question: '',
  toolApproval: '',
  background: '',
};

const EMPTY_CHAT_SIDEBAR_STATE: ChatSidebarState = {
  worktrees: {},
  unreadWorktreeKeys: new Set(),
  pendingQuestions: {},
  badgeKeys: EMPTY_BADGE_KEYS,
};

/**
 * Derive the sidebar state from the chat store's fields and the chats with
 * live managed delegates. Returns `previous` itself when no value changed,
 * and keeps every unchanged worktree and tab entry by identity.
 */
function deriveChatSidebarState(
  source: ChatSidebarSource,
  liveDelegateChats: LiveDelegateChats,
  liveProviderTaskChats: LiveProviderTaskChats,
  previous: ChatSidebarState,
  memo: ChatSidebarDerivationMemo,
): ChatSidebarState {
  const worktrees =
    source.worktreeChats === memo.worktreeChats
      ? previous.worktrees
      : deriveWorktrees(source.worktreeChats, previous.worktrees, memo);
  memo.worktreeChats = source.worktreeChats;

  let badgeKeys = previous.badgeKeys;
  if (
    !memo.derived ||
    worktrees !== previous.worktrees ||
    source.pendingPlanExits !== memo.pendingPlanExits ||
    source.pendingQuestions !== memo.pendingQuestions ||
    source.pendingApprovals !== memo.pendingApprovals ||
    source.persistedWorktreeBadges !== memo.persistedWorktreeBadges ||
    liveDelegateChats !== memo.liveDelegateChats ||
    liveProviderTaskChats !== memo.liveProviderTaskChats
  ) {
    const derived = deriveChatBadgeKeys(
      {
        pendingPlanExits: source.pendingPlanExits,
        pendingQuestions: source.pendingQuestions,
        pendingApprovals: source.pendingApprovals,
        persistedWorktreeBadges: source.persistedWorktreeBadges,
        worktreeChats: worktrees,
      },
      liveDelegateChats,
      liveProviderTaskChats,
    );
    if (!sameBadgeKeys(derived, badgeKeys)) badgeKeys = derived;
  }
  memo.pendingPlanExits = source.pendingPlanExits;
  memo.pendingQuestions = source.pendingQuestions;
  memo.pendingApprovals = source.pendingApprovals;
  memo.persistedWorktreeBadges = source.persistedWorktreeBadges;
  memo.liveDelegateChats = liveDelegateChats;
  memo.liveProviderTaskChats = liveProviderTaskChats;
  memo.derived = true;

  if (
    worktrees === previous.worktrees &&
    badgeKeys === previous.badgeKeys &&
    source.unreadWorktreeKeys === previous.unreadWorktreeKeys &&
    source.pendingQuestions === previous.pendingQuestions
  ) {
    return previous;
  }
  return {
    worktrees,
    unreadWorktreeKeys: source.unreadWorktreeKeys,
    pendingQuestions: source.pendingQuestions,
    badgeKeys,
  };
}

const sidebarStore = createStore<ChatSidebarState>()(
  () => EMPTY_CHAT_SIDEBAR_STATE,
);
let connected = false;

/**
 * Feed the store from the chat store's view, the delegation activity store
 * and the live background-task store. Runs on first use, then on every
 * publication of any of them.
 */
function ensureChatSidebarStoreConnected(): void {
  if (connected) return;
  connected = true;
  const memo = createChatSidebarDerivationMemo();
  let chatState = chatStoreRenderView.getState();
  let liveDelegateChats: LiveDelegateChats =
    useDelegationActivityStore.getState().byChat;
  let liveProviderTaskChats: LiveProviderTaskChats =
    useLiveBackgroundTaskStore.getState().byChat;
  const update = (): void => {
    const previous = sidebarStore.getState();
    const next = deriveChatSidebarState(
      chatState,
      liveDelegateChats,
      liveProviderTaskChats,
      previous,
      memo,
    );
    if (next !== previous) sidebarStore.setState(next, true);
  };
  update();
  chatStoreRenderView.subscribe((state) => {
    chatState = state;
    update();
  });
  useDelegationActivityStore.subscribe((state) => {
    if (state.byChat === liveDelegateChats) return;
    liveDelegateChats = state.byChat;
    update();
  });
  useLiveBackgroundTaskStore.subscribe((state) => {
    if (state.byChat === liveProviderTaskChats) return;
    liveProviderTaskChats = state.byChat;
    update();
  });
}

function useChatSidebarSelector<U>(
  selector: (state: ChatSidebarState) => U,
): U {
  ensureChatSidebarStoreConnected();
  return useStore(sidebarStore, selector);
}

/**
 * React's sidebar and badge state. Select from it like any Zustand store; it
 * is derived, so it has no setter. Imperative code reads the chat store.
 */
export const useChatSidebarStore: typeof useChatSidebarSelector &
  Pick<StoreApi<ChatSidebarState>, 'getState' | 'subscribe'> = Object.assign(
  useChatSidebarSelector,
  {
    getState(): ChatSidebarState {
      ensureChatSidebarStoreConnected();
      return sidebarStore.getState();
    },
    subscribe(
      listener: (state: ChatSidebarState, previous: ChatSidebarState) => void,
    ): () => void {
      ensureChatSidebarStoreConnected();
      return sidebarStore.subscribe(listener);
    },
  },
);
