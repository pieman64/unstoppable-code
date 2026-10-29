/**
 * @jest-environment jsdom
 *
 * Early access keeps chats in the chat group. A chat the user starts from
 * another group's `+` (the add menu, a standalone chat page) is redirected
 * there by the store, so the desktop helpers check the chat group's row and
 * reveal the chat in it, even behind another group's maximize.
 */
import {
  makeWorktreePanelKey,
  setPanelLayoutChatGroup,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { addChatPanelToGroup } from '../addChatPanel';
import { placeActiveStandaloneChatInGroup } from '../startChatInGroup';

interface MockChatTab {
  readonly id: string;
  readonly kind: 'chat';
  readonly title: string;
}

const mockChats: {
  tabs: MockChatTab[];
  activeTabId: string | null;
} = { tabs: [], activeTabId: null };
let mockNextChatId = 0;

jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): unknown => ({
      worktreeChats: { 'project/worktree': mockChats },
      createTab: (): void => {
        mockNextChatId += 1;
        const id = `chat-new-${mockNextChatId}`;
        mockChats.tabs.push({ id, kind: 'chat', title: id });
        mockChats.activeTabId = id;
      },
      closeTab: (): void => undefined,
    }),
  },
}));

jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): unknown => ({ toasts: [], addToast: jest.fn() }),
  },
}));

const KEY = makeWorktreePanelKey('project', 'worktree');

const LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-chat',
      panelId: 'panel-chat-chat-a',
      instance: { chatTabId: 'chat-a' },
    },
    { kind: 'terminal', groupId: 'group-extras', panelId: 'panel-term' },
    { kind: 'terminal', groupId: 'group-terminal', panelId: 'panel-term-2' },
  ],
  containerSize: { width: 1200, height: 800 },
};

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function tabsOf(groupId: string): string[] {
  return (
    store()
      .layouts[KEY]?.viewModel.groups.find((group) => group.groupId === groupId)
      ?.tabs.map((tab) => tab.panelId) ?? []
  );
}

beforeEach(() => {
  mockChats.tabs = [{ id: 'chat-a', kind: 'chat', title: 'A' }];
  mockChats.activeTabId = 'chat-a';
  store().initializeLayout(KEY, LAYOUT);
  setPanelLayoutChatGroup('group-chat');
});

afterEach(() => {
  setPanelLayoutChatGroup(null);
  store().setTabRowLimit(null);
  for (const key of Object.keys(store().layouts)) store().disposeLayout(key);
});

describe('chats started from another group', () => {
  it('a new chat from the drawer shows in the chat group past a maximize', () => {
    store().maximizeGroup(KEY, 'group-extras', true);

    addChatPanelToGroup(KEY, 'group-extras');

    const layout = store().layouts[KEY];
    expect(tabsOf('group-chat')).toEqual([
      'panel-chat-chat-a',
      'panel-chat-chat-new-1',
    ]);
    expect(tabsOf('group-extras')).toEqual(['panel-term']);
    expect(layout.maximizedGroupId).toBeNull();
    expect(layout.activeGroupId).toBe('group-chat');
  });

  it('checks the chat group row, not the row that asked', () => {
    mockChats.tabs.push({ id: 'chat-b', kind: 'chat', title: 'B' });
    store().addTab(KEY, 'group-chat', 'chat', {
      panelId: 'panel-chat-chat-b',
      instance: { chatTabId: 'chat-b' },
    });
    store().setTabRowLimit(2);

    addChatPanelToGroup(KEY, 'group-extras');

    // The drawer row has room, but the chat group the chat would land in is
    // full, so nothing is created or added.
    expect(mockChats.tabs.map((tab) => tab.id)).toEqual(['chat-a', 'chat-b']);
    expect(tabsOf('group-chat')).toEqual([
      'panel-chat-chat-a',
      'panel-chat-chat-b',
    ]);
  });

  it('a standalone chat already in the chat group is revealed there', () => {
    store().maximizeGroup(KEY, 'group-extras', true);
    store().focusGroup(KEY, 'group-extras');

    placeActiveStandaloneChatInGroup(KEY, 'group-extras');

    const layout = store().layouts[KEY];
    expect(layout.maximizedGroupId).toBeNull();
    expect(layout.activeGroupId).toBe('group-chat');
    expect(layout.groups['group-chat'].activePanelId).toBe('panel-chat-chat-a');
    expect(tabsOf('group-extras')).toEqual(['panel-term']);
  });
});
