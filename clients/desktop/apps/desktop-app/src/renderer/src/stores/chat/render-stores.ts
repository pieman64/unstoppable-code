// Keyed render stores: React's per-chat and per-worktree views of the chat
// store (phase 15 of the desktop performance plan, P2 renderer item 11).
//
// The chat store stays the single writer and the only imperative read
// surface: every reducer, IPC handler, store action and `getState()` reader
// keeps the `worktreeChats` shape. React reads through the frame-batched view
// (`chatStoreRenderView`), and before this module every `useChatStore`
// selector ran on every publication, whichever chat changed: one chat's
// streamed reply re-ran every mounted surface's transcript and composer
// projection, the tab strip re-rendered, and so on.
//
// The stores here are keyed slices of that same view. Each one derives its
// value from the view's snapshot (so it is exactly what a `useChatStore`
// selector over the same snapshot would read) and notifies its subscribers
// only when its own value changes:
// - `chatTab(projectId, worktreeId, chatId)`: the tab object and the chat's
//   canonical runtime, by identity. Another chat's commit never notifies it.
// - `worktreeChat(worktreeKey)`: one worktree's `WorktreeChatState`.
// - `tabStrip(worktreeKey)` / `stripTabById(tabId)`: tab-strip projections
//   without the fields streamed content changes (see `ChatTabStripTab`), so
//   a streamed reply does not re-render the strip or panel tab headers.
//
// Every store reads the view, not the store, so phase 12's cadence carries
// over unchanged: streamed content reaches these stores once per animation
// frame, anything else at once, and `chatStoreRenderView.flush()` (user input,
// a hidden window, unsubscribe) publishes them synchronously too.

import type { StoreApi } from 'zustand';
import { shallow } from 'zustand/shallow';
import type { ChatRuntimeState } from '@canopy/desktop-shared/types';
import type { ChatState } from './state';
import type { ChatTab, WorktreeChatState } from './types';

/** The read side of a store, as zustand's `useStore` consumes it. */
export type ReadonlyRenderStore<T> = Pick<
  StoreApi<T>,
  'getState' | 'getInitialState' | 'subscribe'
>;

/** The chat state fields the render stores read. */
export type ChatRenderSourceState = Pick<
  ChatState,
  'worktreeChats' | 'runtimeByChatId'
>;

/** What the render stores read: the chat store's frame-batched view. */
export type ChatRenderSource = Pick<
  StoreApi<ChatRenderSourceState>,
  'getState' | 'subscribe'
>;

/** One chat as React sees it: its tab and its canonical runtime state. */
export interface ChatTabRenderEntry {
  readonly tab: ChatTab | undefined;
  readonly runtime: ChatRuntimeState | undefined;
}

/**
 * Tab fields that streamed content changes (`message.upserted`, a
 * non-resetting `transcript.updated`, an activity-only `runtime.patched`; see
 * `canonical-changes.ts`), plus the rest of the transcript state. Tab-strip
 * projections leave them out so a streamed reply does not re-render the strip.
 */
export const CHAT_TAB_TRANSCRIPT_FIELDS = [
  'messages',
  'transcript',
  'transcriptLoaded',
  'transcriptWindow',
  'currentTodos',
  'currentTaskTodos',
  'lastEventAt',
  'pendingUserMessages',
  'pendingTurn',
  'pendingQueueDispatch',
  'pendingQueueMessages',
] as const satisfies readonly (keyof ChatTab)[];

type ChatTabTranscriptField = (typeof CHAT_TAB_TRANSCRIPT_FIELDS)[number];

/**
 * A chat tab as the tab strip and panel tab headers see it: every field but
 * the transcript state, with `hasMessages` standing in for `messages`.
 */
export type ChatTabStripTab = Omit<ChatTab, ChatTabTranscriptField> & {
  readonly hasMessages: boolean;
};

export interface ChatRenderStores {
  /** `worktreeKey` is `${projectId}/${worktreeId}`, as in `worktreeChats`. */
  chatTab(
    worktreeKey: string,
    chatId: string,
  ): ReadonlyRenderStore<ChatTabRenderEntry>;
  worktreeChat(
    worktreeKey: string,
  ): ReadonlyRenderStore<WorktreeChatState | undefined>;
  tabStrip(
    worktreeKey: string,
  ): ReadonlyRenderStore<readonly ChatTabStripTab[]>;
  stripTabById(tabId: string): ReadonlyRenderStore<ChatTabStripTab | undefined>;
}

type Listener<T> = (state: T, previousState: T) => void;
type Derive<T> = (state: ChatRenderSourceState, previous: T | undefined) => T;

interface FamilyMember {
  /** Notify the member's subscribers if its value changed. */
  refresh(): void;
}

interface RenderStoreFamily<T> {
  get(key: string, createDerive: () => Derive<T>): ReadonlyRenderStore<T>;
}

/**
 * Shared bookkeeping for the members of every family: the members that have
 * subscribers are refreshed on each view publication, and members without
 * subscribers are dropped from the family caches (a component re-reads its
 * store on each render, and subscribing re-adds it).
 */
interface RenderStoreRegistry {
  readonly live: Set<FamilyMember>;
  readonly caches: Map<string, FamilyMember>[];
}

function createFamily<T>(
  source: ChatRenderSource,
  registry: RenderStoreRegistry,
): RenderStoreFamily<T> {
  const cache = new Map<string, ReadonlyRenderStore<T> & FamilyMember>();
  registry.caches.push(cache);

  const create = (
    key: string,
    derive: Derive<T>,
  ): ReadonlyRenderStore<T> & FamilyMember => {
    let snapshot = source.getState();
    let value = derive(snapshot, undefined);
    let notified = value;
    const listeners = new Set<Listener<T>>();

    const getState = (): T => {
      const state = source.getState();
      if (state !== snapshot) {
        value = derive(state, value);
        snapshot = state;
      }
      return value;
    };

    const member: ReadonlyRenderStore<T> & FamilyMember = {
      getState,
      getInitialState: getState,
      subscribe(listener: Listener<T>): () => void {
        if (listeners.size === 0) {
          notified = getState();
          registry.live.add(member);
          if (!cache.has(key)) cache.set(key, member);
        }
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
          if (listeners.size > 0) return;
          registry.live.delete(member);
          if (cache.get(key) === member) cache.delete(key);
        };
      },
      refresh(): void {
        const next = getState();
        if (next === notified) return;
        const previous = notified;
        notified = next;
        for (const listener of Array.from(listeners)) listener(next, previous);
      },
    };
    return member;
  };

  return {
    get(key, createDerive): ReadonlyRenderStore<T> {
      const cached = cache.get(key);
      if (cached) return cached;
      const member = create(key, createDerive());
      cache.set(key, member);
      return member;
    },
  };
}

function findTab(
  chatState: WorktreeChatState | undefined,
  tabId: string,
): ChatTab | undefined {
  return chatState?.tabs.find((tab) => tab.id === tabId);
}

/** Project a tab for the tab strip. */
export function toChatTabStripTab(tab: ChatTab): ChatTabStripTab {
  const projected: ChatTabStripTab &
    Partial<Pick<ChatTab, ChatTabTranscriptField>> = {
    ...tab,
    hasMessages: tab.messages.length > 0,
  };
  for (const field of CHAT_TAB_TRANSCRIPT_FIELDS) delete projected[field];
  return projected;
}

/**
 * Strip projections keyed by tab object, so each tab is projected once
 * however many strips and headers show it. A projection with the same own
 * values as the one shown before (`previous`) keeps that object, so a tab
 * object replaced by streamed content keeps its strip projection.
 */
function createStripProjector(): (
  tab: ChatTab,
  previous: ChatTabStripTab | undefined,
) => ChatTabStripTab {
  const byTab = new WeakMap<ChatTab, ChatTabStripTab>();
  return (tab, previous) => {
    let projected = byTab.get(tab);
    if (!projected) {
      projected = toChatTabStripTab(tab);
      byTab.set(tab, projected);
    }
    if (
      previous &&
      previous !== projected &&
      previous.id === projected.id &&
      shallow(previous, projected)
    ) {
      byTab.set(tab, previous);
      return previous;
    }
    return projected;
  };
}

const EMPTY_STRIP: readonly ChatTabStripTab[] = [];

/**
 * First tab with `tabId` across the loaded worktrees, in `worktreeChats`
 * order (chat ids are globally unique; the order only matters if one is not).
 */
function findTabAcrossWorktrees(
  worktreeChats: Record<string, WorktreeChatState>,
  tabId: string,
): ChatTab | undefined {
  for (const chatState of Object.values(worktreeChats)) {
    const tab = findTab(chatState, tabId);
    if (tab) return tab;
  }
  return undefined;
}

export function createChatRenderStores(
  source: ChatRenderSource,
): ChatRenderStores {
  const registry: RenderStoreRegistry = { live: new Set(), caches: [] };
  const chatTabs = createFamily<ChatTabRenderEntry>(source, registry);
  const worktreeChats = createFamily<WorktreeChatState | undefined>(
    source,
    registry,
  );
  const tabStrips = createFamily<readonly ChatTabStripTab[]>(source, registry);
  const stripTabs = createFamily<ChatTabStripTab | undefined>(source, registry);
  const projectStripTab = createStripProjector();

  source.subscribe((): void => {
    for (const member of Array.from(registry.live)) member.refresh();
    for (const cache of registry.caches) {
      cache.forEach((member, key) => {
        if (!registry.live.has(member)) cache.delete(key);
      });
    }
  });

  return {
    chatTab(worktreeKey, chatId): ReadonlyRenderStore<ChatTabRenderEntry> {
      return chatTabs.get(`${worktreeKey}\u0000${chatId}`, () => {
        let lastChatState: WorktreeChatState | undefined;
        let lastRuntimes: Record<string, ChatRuntimeState> | undefined;
        return (state, previous) => {
          const chatState = state.worktreeChats[worktreeKey];
          const runtimes = state.runtimeByChatId;
          if (
            previous &&
            chatState === lastChatState &&
            runtimes === lastRuntimes
          ) {
            return previous;
          }
          lastChatState = chatState;
          lastRuntimes = runtimes;
          const tab = findTab(chatState, chatId);
          const runtime = runtimes[chatId];
          if (
            previous &&
            previous.tab === tab &&
            previous.runtime === runtime
          ) {
            return previous;
          }
          return { tab, runtime };
        };
      });
    },
    worktreeChat(
      worktreeKey,
    ): ReadonlyRenderStore<WorktreeChatState | undefined> {
      return worktreeChats.get(
        worktreeKey,
        () => (state) => state.worktreeChats[worktreeKey],
      );
    },
    tabStrip(worktreeKey): ReadonlyRenderStore<readonly ChatTabStripTab[]> {
      return tabStrips.get(worktreeKey, () => {
        let lastTabs: ChatTab[] | undefined;
        return (state, previous) => {
          const tabs = state.worktreeChats[worktreeKey]?.tabs;
          if (previous && tabs === lastTabs) return previous;
          lastTabs = tabs;
          if (!tabs || tabs.length === 0) return EMPTY_STRIP;
          let changed = !previous || previous.length !== tabs.length;
          const next = tabs.map((tab, index) => {
            const projected = projectStripTab(tab, previous?.[index]);
            if (projected !== previous?.[index]) changed = true;
            return projected;
          });
          return changed || !previous ? next : previous;
        };
      });
    },
    stripTabById(tabId): ReadonlyRenderStore<ChatTabStripTab | undefined> {
      return stripTabs.get(tabId, () => {
        let lastWorktreeChats: Record<string, WorktreeChatState> | undefined;
        return (state, previous) => {
          if (
            previous !== undefined &&
            state.worktreeChats === lastWorktreeChats
          ) {
            return previous;
          }
          lastWorktreeChats = state.worktreeChats;
          const tab = findTabAcrossWorktrees(state.worktreeChats, tabId);
          return tab ? projectStripTab(tab, previous) : undefined;
        };
      });
    },
  };
}
