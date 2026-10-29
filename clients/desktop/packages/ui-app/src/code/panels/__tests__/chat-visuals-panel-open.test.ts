/** @jest-environment jsdom */
import {
  CHAT_VISUALS_PANEL_KIND,
  CHAT_VISUALS_PANEL_TITLE,
  openChatVisualsPanel,
  rebindChatVisualsPanel,
} from '../chat-visuals-panel-open';
import {
  makeWorktreePanelKey,
  setPanelLayoutFixedTopology,
  usePanelLayoutStore,
  type DefaultLayoutGroupSeed,
  type PanelTabDescriptor,
} from '../panel-layout-store';

const KEY = makeWorktreePanelKey('project-1', 'worktree-1');

function chatGroup(chatTabId: string, groupId: string): DefaultLayoutGroupSeed {
  return {
    kind: 'chat',
    groupId,
    panelId: `panel-${chatTabId}`,
    instance: { chatTabId },
  };
}

function visualsTabs(): Array<PanelTabDescriptor & { groupId: string }> {
  const layout = usePanelLayoutStore.getState().layouts[KEY];
  return Object.entries(layout?.groups ?? {}).flatMap(([groupId, group]) =>
    group.tabs
      .filter((tab) => tab.kind === CHAT_VISUALS_PANEL_KIND)
      .map((tab) => ({ ...tab, groupId })),
  );
}

afterEach(() => {
  setPanelLayoutFixedTopology(KEY, false);
  usePanelLayoutStore.getState().disposeLayout(KEY);
});

function open(chatId: string): boolean {
  return openChatVisualsPanel({ worktreeKey: KEY, chatTabId: chatId, chatId });
}

test('opens the panel in a new group to the right of the chat', () => {
  usePanelLayoutStore.getState().initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [chatGroup('chat-a', 'group-chat')],
    containerSize: { width: 1200, height: 800 },
  });

  expect(open('chat-a')).toBe(true);

  const [tab] = visualsTabs();
  expect(tab).toMatchObject({
    kind: 'chat-visuals',
    title: CHAT_VISUALS_PANEL_TITLE,
    instance: { chatId: 'chat-a' },
  });
  expect(tab?.groupId).not.toBe('group-chat');
  const layout = usePanelLayoutStore.getState().layouts[KEY];
  expect(layout.groups[tab?.groupId ?? ''].activePanelId).toBe(tab?.panelId);
  // The chat keeps its own group and tab.
  expect(layout.groups['group-chat'].tabs.map((item) => item.kind)).toEqual([
    'chat',
  ]);
});

test('joins the side group that content opened from chat already shares', () => {
  usePanelLayoutStore.getState().initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [
      chatGroup('chat-a', 'group-chat'),
      {
        kind: 'file-diff',
        groupId: 'group-side',
        panelId: 'panel-file',
        instance: { fileTabId: 'file-1' },
      },
    ],
    containerSize: { width: 1200, height: 800 },
  });

  expect(open('chat-a')).toBe(true);

  expect(visualsTabs().map((tab) => tab.groupId)).toEqual(['group-side']);
  expect(
    Object.keys(usePanelLayoutStore.getState().layouts[KEY].groups).sort(),
  ).toEqual(['group-chat', 'group-side']);
});

test('keeps one panel per worktree and rebinds it to the expanding chat', () => {
  usePanelLayoutStore.getState().initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [chatGroup('chat-a', 'group-chat')],
    containerSize: { width: 1200, height: 800 },
  });
  usePanelLayoutStore.getState().addTab(KEY, 'group-chat', 'chat', {
    panelId: 'panel-chat-b',
    instance: { chatTabId: 'chat-b' },
  });
  expect(open('chat-a')).toBe(true);
  const [first] = visualsTabs();

  expect(open('chat-b')).toBe(true);

  const tabs = visualsTabs();
  expect(tabs).toHaveLength(1);
  expect(tabs[0]?.panelId).toBe(first?.panelId);
  expect(tabs[0]?.groupId).toBe(first?.groupId);
  expect(tabs[0]?.instance).toEqual({ chatId: 'chat-b' });
});

test('selects an open panel again and expands its collapsed group', () => {
  const store = usePanelLayoutStore.getState();
  store.initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [
      chatGroup('chat-a', 'group-chat'),
      {
        kind: 'file-diff',
        groupId: 'group-side',
        panelId: 'panel-file',
        instance: { fileTabId: 'file-1' },
      },
    ],
    containerSize: { width: 1200, height: 800 },
  });
  expect(open('chat-a')).toBe(true);
  const [tab] = visualsTabs();
  store.selectTab(KEY, 'group-side', 'panel-file');
  expect(store.collapseGroup(KEY, 'group-side')).toBe(true);

  expect(open('chat-a')).toBe(true);

  const group =
    usePanelLayoutStore.getState().layouts[KEY].groups['group-side'];
  expect(group.collapsed).toBeUndefined();
  expect(group.activePanelId).toBe(tab?.panelId);
  expect(visualsTabs()).toHaveLength(1);
});

test('leaves a maximized chat so an open panel in another group shows', () => {
  const store = usePanelLayoutStore.getState();
  store.initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [
      chatGroup('chat-a', 'group-chat'),
      {
        kind: 'file-diff',
        groupId: 'group-side',
        panelId: 'panel-file',
        instance: { fileTabId: 'file-1' },
      },
    ],
    containerSize: { width: 1200, height: 800 },
  });
  expect(open('chat-a')).toBe(true);
  store.maximizeGroup(KEY, 'group-chat', true);
  expect(usePanelLayoutStore.getState().layouts[KEY].maximizedGroupId).toBe(
    'group-chat',
  );

  expect(open('chat-a')).toBe(true);

  const layout = usePanelLayoutStore.getState().layouts[KEY];
  expect(layout.maximizedGroupId).toBeNull();
  expect(layout.activeGroupId).toBe('group-side');
});

test('leaves a maximized chat so a newly placed panel shows', () => {
  const store = usePanelLayoutStore.getState();
  store.initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [chatGroup('chat-a', 'group-chat')],
    containerSize: { width: 1200, height: 800 },
  });
  store.maximizeGroup(KEY, 'group-chat', true);

  expect(open('chat-a')).toBe(true);

  const [tab] = visualsTabs();
  const layout = usePanelLayoutStore.getState().layouts[KEY];
  expect(layout.maximizedGroupId).toBeNull();
  expect(layout.activeGroupId).toBe(tab?.groupId);
});

test('reports failure when the chat has no panel to open beside', () => {
  usePanelLayoutStore.getState().initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [chatGroup('chat-a', 'group-chat')],
    containerSize: { width: 1200, height: 800 },
  });

  expect(open('chat-missing')).toBe(false);
  expect(open('chat-a')).toBe(true);
  expect(
    openChatVisualsPanel({
      worktreeKey: 'other/worktree',
      chatTabId: 'chat-a',
      chatId: 'chat-a',
    }),
  ).toBe(false);
});

test('reports failure and leaves the layout alone when no group can be made', () => {
  usePanelLayoutStore.getState().initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [chatGroup('chat-a', 'group-chat')],
    containerSize: { width: 1200, height: 800 },
  });
  setPanelLayoutFixedTopology(KEY, true);

  expect(open('chat-a')).toBe(false);

  expect(visualsTabs()).toEqual([]);
  expect(
    Object.keys(usePanelLayoutStore.getState().layouts[KEY].groups),
  ).toEqual(['group-chat']);
});

test('rebinding finds nothing when no panel is open', () => {
  usePanelLayoutStore.getState().initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [chatGroup('chat-a', 'group-chat')],
    containerSize: { width: 1200, height: 800 },
  });
  expect(rebindChatVisualsPanel(KEY, 'chat-a')).toBeNull();
});
