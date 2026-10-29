import { useMemo, type JSX } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import {
  FloatingChatRecentList,
  FloatingChatWindow,
  type FloatingChatRecentItem,
} from '@canopy/ui-shared';
import { formatCompactAge } from '@canopy/ui-shared/lib';
import {
  APP_ADVISOR_FLOATING_SIZE_LIMITS,
  APP_ADVISOR_PROJECT_ID,
  type CoworkWorkEntryMeta,
} from '@canopy/desktop-shared/types';
import { PinUserMessagesContext } from '@/components/chat/pin-user-messages-context';
import { WorktreeChatSurface } from '@/components/chat/WorktreeChatSurface';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';
import { readUiZoomFactor } from '@/lib/ui-zoom-factor';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { chatStoreRenderView, useChatStore } from '@/stores/chatStore';
import { chatTabHasConversationContent } from '@/stores/chat/tab-utils';
import type { ChatTab, WorktreeChatState } from '@/stores/chat/types';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/** How many earlier chats the empty floating chat offers to pick up. */
const RECENT_CHAT_COUNT = 5;
/** The title of a chat that has no messages yet. */
const NEW_CHAT_TITLE = 'New chat';

/**
 * One App Advisor chat as the panel lists it. Chats are chat tabs: "New
 * chat" opens a tab in the open Work Entry, so an entry can hold several.
 */
interface AdvisorChat {
  /** The chat tab's id, or the entry's while its tabs are not loaded. */
  readonly id: string;
  readonly entryId: string;
  /** Null while the entry's tabs are not loaded: picking it opens the entry. */
  readonly tabId: string | null;
  readonly title: string;
  /** When the chat last had a message, or null for one without any. */
  readonly lastMessageAt: number | null;
  /** Its last message, else its last activity or creation (epoch ms). */
  readonly activityAt: number;
}

/** A time string as epoch ms, or null when absent or unreadable. */
function parseTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** When the tab last had a message, or null for one without any. */
function tabLastMessageTime(
  tab: ChatTab,
  entry: CoworkWorkEntryMeta,
): number | null {
  if (!chatTabHasConversationContent(tab)) return null;
  return (
    tab.transcript?.lastMessageAt ??
    tab.messages[tab.messages.length - 1]?.timestamp ??
    parseTime(entry.lastMessageAt) ??
    parseTime(tab.createdAt)
  );
}

/**
 * Every App Advisor chat: each chat tab of an entry whose tabs are loaded,
 * else the entry itself.
 */
function collectAdvisorChats(
  entries: readonly CoworkWorkEntryMeta[],
  worktreeChats: Readonly<Record<string, WorktreeChatState>>,
): AdvisorChat[] {
  return entries.flatMap((entry): AdvisorChat[] => {
    const tabs = worktreeChats[`${APP_ADVISOR_PROJECT_ID}/${entry.id}`]?.tabs;
    if (tabs === undefined || tabs.length === 0) {
      const lastMessageAt = parseTime(entry.lastMessageAt);
      return [
        {
          id: entry.id,
          entryId: entry.id,
          tabId: null,
          title: entry.title,
          lastMessageAt,
          activityAt:
            lastMessageAt ??
            parseTime(entry.lastTouchedAt) ??
            parseTime(entry.createdAt) ??
            0,
        },
      ];
    }
    return tabs.flatMap((tab): AdvisorChat[] => {
      if (tab.kind === 'file') return [];
      const lastMessageAt = tabLastMessageTime(tab, entry);
      return [
        {
          id: tab.id,
          entryId: entry.id,
          tabId: tab.id,
          title: tab.title,
          lastMessageAt,
          activityAt: lastMessageAt ?? parseTime(tab.createdAt) ?? 0,
        },
      ];
    });
  });
}

function sameAdvisorChats(
  left: readonly AdvisorChat[],
  right: readonly AdvisorChat[],
): boolean {
  return (
    left.length === right.length &&
    left.every((chat, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        chat.id === other.id &&
        chat.entryId === other.entryId &&
        chat.tabId === other.tabId &&
        chat.title === other.title &&
        chat.lastMessageAt === other.lastMessageAt &&
        chat.activityAt === other.activityAt
      );
    })
  );
}

/** Most recently active first. */
function byActivity(a: AdvisorChat, b: AdvisorChat): number {
  return b.activityAt - a.activityAt;
}

function toMenuItem(chat: AdvisorChat, now: number): FloatingChatRecentItem {
  return {
    id: chat.id,
    title: chat.title,
    timeLabel: formatCompactAge(chat.activityAt, now),
  };
}

/**
 * The chats for the title's menu: every chat with messages, and the open
 * one, most recently active first.
 */
function switcherChats(
  chats: readonly AdvisorChat[],
  activeChatId: string | null,
  now: number,
): FloatingChatRecentItem[] {
  return chats
    .filter((chat) => chat.lastMessageAt !== null || chat.id === activeChatId)
    .sort(byActivity)
    .map((chat) => toMenuItem(chat, now));
}

/**
 * The most recently active chats with messages, newest first: up to `count`,
 * leaving out the open one.
 */
function recentChats(
  chats: readonly AdvisorChat[],
  activeChatId: string | null,
  count: number,
  now: number,
): FloatingChatRecentItem[] {
  return chats
    .filter((chat) => chat.lastMessageAt !== null && chat.id !== activeChatId)
    .sort(byActivity)
    .slice(0, count)
    .map((chat) => toMenuItem(chat, now));
}

export interface AppAdvisorFloatingSurfaceProps {
  /** The workspace has loaded and a chat is selected. */
  ready: boolean;
  activeWorkEntryId: string | null;
  activeChatId: string | null;
}

/**
 * Early access: App Advisor as a chat panel floating inside the main Canopy
 * window, in the bottom-right corner (the main process hosts this page in a
 * native view there). It shows the open chat alone (no nav, tabs, or
 * panels); its title is a menu to switch chats, and an empty chat lists
 * recent chats above the composer. Open full
 * window moves the same page into the full App Advisor window on this chat,
 * Minimize folds the panel into a bubble in the main window's corner, and
 * Close hides it.
 */
export function AppAdvisorFloatingSurface({
  ready,
  activeWorkEntryId,
  activeChatId,
}: AppAdvisorFloatingSurfaceProps): JSX.Element {
  const workEntries = useStandaloneChatStore((s) => s.workEntries);
  const selectWorkEntry = useStandaloneChatStore((s) => s.selectWorkEntry);
  const startNewChat = useStandaloneChatStore((s) => s.startNewChat);
  const expandDialog = useAppAdvisorStore((s) => s.expandDialog);
  const closeDialog = useAppAdvisorStore((s) => s.closeDialog);
  const minimizeDialog = useAppAdvisorStore((s) => s.minimizeDialog);
  const setFloatingSize = useAppAdvisorStore((s) => s.setFloatingSize);

  // Chat tabs across the entries, re-derived only when a listed field
  // changes (not on every streamed reply).
  const chats = useStoreWithEqualityFn(
    chatStoreRenderView,
    (state) => collectAdvisorChats(workEntries, state.worktreeChats),
    sameAdvisorChats,
  );
  const activeChat = chats.find((chat) => chat.id === activeChatId);
  // A chat with messages shows its title and offers a fresh one.
  const activeTitle =
    activeChat !== undefined && activeChat.lastMessageAt !== null
      ? activeChat.title
      : null;
  const recent = useMemo(
    () => recentChats(chats, activeChatId, RECENT_CHAT_COUNT, Date.now()),
    [chats, activeChatId],
  );
  // The title's menu lists the chats, the open one checked.
  const switcherItems = useMemo(
    () => switcherChats(chats, activeChatId, Date.now()),
    [chats, activeChatId],
  );
  // Opens a chat: its Work Entry, then its tab within the entry.
  const openChat = (id: string): void => {
    const chat = chats.find((candidate) => candidate.id === id);
    if (chat === undefined) return;
    void selectWorkEntry(chat.entryId).then((selected): void => {
      if (!selected || chat.tabId === null) return;
      useChatStore.getState().switchTab(chat.tabId, {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: chat.entryId,
      });
    });
  };

  return (
    <FloatingChatWindow
      title={activeTitle ?? NEW_CHAT_TITLE}
      surface="panel"
      onNewChat={
        activeTitle !== null
          ? (): void => {
              void startNewChat();
            }
          : undefined
      }
      onExpand={expandDialog}
      onMinimize={minimizeDialog}
      onClose={closeDialog}
      resize={{
        ...APP_ADVISOR_FLOATING_SIZE_LIMITS,
        onResize: setFloatingSize,
        // The interface scale is a page zoom.
        pageZoom: readUiZoomFactor,
      }}
      switcher={{
        items: switcherItems,
        activeId: activeChatId,
        onSelect: openChat,
      }}
      dataTestId="app-advisor-floating"
    >
      {ready && activeWorkEntryId !== null && activeChatId !== null ? (
        // A panel this small has no room for a pinned prompt over the
        // reply, so its user messages scroll with the rest.
        <PinUserMessagesContext.Provider value={false}>
          <WorktreeChatSurface
            chatTabId={activeChatId}
            worktreeSelection={{
              projectId: APP_ADVISOR_PROJECT_ID,
              worktreeId: activeWorkEntryId,
            }}
            visible
            isActivePanel
            emptyStateCenter={
              <FloatingChatRecentList items={recent} onSelect={openChat} />
            }
          />
        </PinUserMessagesContext.Provider>
      ) : (
        <div
          className="flex flex-1 items-center justify-center"
          data-testid="app-advisor-floating-loading"
        >
          <LoadingSpinner tone="secondary" />
        </div>
      )}
    </FloatingChatWindow>
  );
}
