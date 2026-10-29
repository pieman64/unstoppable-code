import { CHAT_TAB_TRANSCRIPT_FIELDS } from '@/stores/chat/render-stores';

/**
 * The render-store hooks `@/stores/chatStore` exports (phase 15), over a
 * fixed chat state, for tests that mock the module with
 * `useChatStore: (selector) => selector(state)`. Spread the result into the
 * mocked module so components that read one chat, one worktree or a tab strip
 * see the same state their `useChatStore` selectors do:
 *
 *   jest.mock('@/stores/chatStore', () => ({
 *     useChatStore: (selector) => selector(mockState()),
 *     ...jest
 *       .requireActual<typeof ChatRenderStoresTestUtils>(
 *         '@/test-utils/chatRenderStores',
 *       )
 *       .mockChatRenderHooks(mockState),
 *   }));
 *
 * Fixtures are often partial objects, so the state is read structurally.
 */

interface MockChatTabEntry {
  readonly tab: unknown;
  readonly runtime: unknown;
}

type Lookup = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Lookup {
  return typeof value === 'object' && value !== null;
}

function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}

function tabsOf(chatState: unknown): readonly unknown[] {
  const tabs = field(chatState, 'tabs');
  return Array.isArray(tabs) ? tabs : [];
}

function findTab(chatState: unknown, chatId: unknown): unknown {
  return tabsOf(chatState).find((tab) => field(tab, 'id') === chatId);
}

function stripTab(tab: unknown): unknown {
  if (!isRecord(tab)) return tab;
  const messages = tab.messages;
  const projected: Record<string, unknown> = {
    ...tab,
    hasMessages: Array.isArray(messages) && messages.length > 0,
  };
  for (const name of CHAT_TAB_TRANSCRIPT_FIELDS) delete projected[name];
  return projected;
}

export interface MockChatRenderHooks {
  useChatTabRenderState(
    target: unknown,
    selector: (entry: MockChatTabEntry) => unknown,
  ): unknown;
  useActiveChatTabRenderState(
    worktreeKey: unknown,
    selector: (entry: MockChatTabEntry) => unknown,
  ): unknown;
  useWorktreeChatRenderState(
    worktreeKey: unknown,
    selector: (chatState: unknown) => unknown,
  ): unknown;
  useChatTabStrip(worktreeKey: unknown): unknown[];
  useChatTabStripTabById(tabId: unknown): unknown;
}

export function mockChatRenderHooks(
  getState: () => unknown,
): MockChatRenderHooks {
  const worktree = (key: unknown): unknown =>
    typeof key === 'string'
      ? field(field(getState(), 'worktreeChats'), key)
      : undefined;
  const entry = (key: unknown, chatId: unknown): MockChatTabEntry => ({
    tab: chatId === undefined ? undefined : findTab(worktree(key), chatId),
    runtime:
      typeof chatId === 'string'
        ? field(field(getState(), 'runtimeByChatId'), chatId)
        : undefined,
  });
  return {
    useChatTabRenderState: (target, selector) =>
      selector(
        entry(
          `${String(field(target, 'projectId'))}/${String(field(target, 'worktreeId'))}`,
          isRecord(target) ? target.chatId : undefined,
        ),
      ),
    useActiveChatTabRenderState: (key, selector) =>
      selector(entry(key, field(worktree(key), 'activeTabId'))),
    useWorktreeChatRenderState: (key, selector) => selector(worktree(key)),
    useChatTabStrip: (key) => tabsOf(worktree(key)).map(stripTab),
    useChatTabStripTabById: (tabId): unknown => {
      const chats = field(getState(), 'worktreeChats');
      for (const chatState of isRecord(chats) ? Object.values(chats) : []) {
        const tab = findTab(chatState, tabId);
        if (tab !== undefined) return stripTab(tab);
      }
      return undefined;
    },
  };
}
