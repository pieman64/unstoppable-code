/**
 * Phase 15: the keyed render stores' own contract, over a plain store
 * standing in for the chat store's frame-batched view.
 */
import { createStore, type StoreApi } from 'zustand';
import type { ChatRuntimeState } from '@canopy/desktop-shared/types';
import {
  createChatRenderStores,
  toChatTabStripTab,
  type ChatRenderSourceState as SourceState,
  type ChatRenderStores,
} from '../render-stores';
import { fromPersistedTab } from '../persisted-tabs';
import type { ChatTab, WorktreeChatState } from '../types';

function tab(id: string, overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    ...fromPersistedTab({
      id,
      title: `Tab ${id}`,
      createdAt: '2026-10-01T00:00:00.000Z',
      messages: [],
    }),
    ...overrides,
  };
}

function setup(initial: Record<string, WorktreeChatState>): {
  source: StoreApi<SourceState>;
  stores: ChatRenderStores;
} {
  const source = createStore<SourceState>()(() => ({
    worktreeChats: initial,
    runtimeByChatId: {},
  }));
  const stores = createChatRenderStores(source);
  return { source, stores };
}

function replaceTab(
  state: SourceState,
  key: string,
  id: string,
  update: (current: ChatTab) => ChatTab,
): Partial<SourceState> {
  const chatState = state.worktreeChats[key];
  return {
    worktreeChats: {
      ...state.worktreeChats,
      [key]: {
        ...chatState,
        tabs: chatState.tabs.map((entry) =>
          entry.id === id ? update(entry) : entry,
        ),
      },
    },
  };
}

describe('chat render stores', () => {
  it('notifies a chat only when its tab or runtime changes', () => {
    const { source, stores } = setup({
      'p/w': { activeTabId: 'a', tabs: [tab('a'), tab('b')] },
    });
    const chatA = stores.chatTab('p/w', 'a');
    const chatB = stores.chatTab('p/w', 'b');
    const seenA: number[] = [];
    const seenB: number[] = [];
    chatA.subscribe(() => seenA.push(1));
    chatB.subscribe(() => seenB.push(1));

    source.setState((state) =>
      replaceTab(state, 'p/w', 'a', (entry) => ({ ...entry, unread: true })),
    );
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(0);
    expect(chatA.getState().tab?.unread).toBe(true);

    const runtime: ChatRuntimeState = {
      status: 'streaming',
      queuedMessageIds: [],
      lastActivityAt: 5,
    };
    source.setState((state) => ({
      runtimeByChatId: { ...state.runtimeByChatId, b: runtime },
    }));
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    expect(chatB.getState().runtime).toBe(runtime);
  });

  it('keeps a strip projection while only transcript fields change', () => {
    const { source, stores } = setup({
      'p/w': { activeTabId: 'a', tabs: [tab('a'), tab('b')] },
    });
    const strip = stores.tabStrip('p/w');
    const byId = stores.stripTabById('a');
    const notified: string[] = [];
    strip.subscribe(() => notified.push('strip'));
    byId.subscribe(() => notified.push('byId'));
    const before = strip.getState();

    source.setState((state) =>
      replaceTab(state, 'p/w', 'a', (entry) => ({
        ...entry,
        lastEventAt: 10,
        currentTodos: [],
        transcriptWindow: { totalMessages: 0, transcriptRevision: 1 },
      })),
    );
    expect(notified).toStrictEqual([]);
    expect(strip.getState()).toBe(before);

    // The first message flips `hasMessages`.
    source.setState((state) =>
      replaceTab(state, 'p/w', 'a', (entry) => ({
        ...entry,
        messages: [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'hi' }],
            timestamp: 1,
          },
        ],
      })),
    );
    expect(notified.sort()).toStrictEqual(['byId', 'strip']);
    expect(strip.getState()[0]?.hasMessages).toBe(true);
    expect(strip.getState()[1]).toBe(before[1]);
    expect(byId.getState()).toBe(strip.getState()[0]);
  });

  it('leaves out the transcript fields and keeps every other field', () => {
    const source = tab('a', {
      unread: true,
      lastEventAt: 3,
      currentTodos: [],
      pinned: true,
    });
    const projected = toChatTabStripTab(source);
    expect(projected).toMatchObject({
      id: 'a',
      unread: true,
      pinned: true,
      hasMessages: false,
    });
    expect('messages' in projected).toBe(false);
    expect('lastEventAt' in projected).toBe(false);
    expect('currentTodos' in projected).toBe(false);
  });

  it('reads the current value without subscribers and after resubscribing', () => {
    const { source, stores } = setup({
      'p/w': { activeTabId: 'a', tabs: [tab('a')] },
    });
    const first = stores.worktreeChat('p/w');
    const unsubscribe = first.subscribe(() => undefined);
    unsubscribe();
    source.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        'p/w': { ...state.worktreeChats['p/w'], activeTabId: 'b' },
      },
    }));
    const again = stores.worktreeChat('p/w');
    expect(again.getState()).toBe(source.getState().worktreeChats['p/w']);
    expect(first.getState()).toBe(source.getState().worktreeChats['p/w']);
    expect(stores.worktreeChat('p/other').getState()).toBeUndefined();
  });
});
