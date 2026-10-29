/** @jest-environment jsdom */
import { useChatStore } from '@/stores/chatStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

const SCOPE = { projectId: 'project-1', worktreeId: 'worktree-1' };
const KEY = makeWorktreePanelKey(SCOPE.projectId, SCOPE.worktreeId);

afterEach(() => {
  const store = usePanelLayoutStore.getState();
  for (const key of Object.keys(store.layouts)) store.disposeLayout(key);
  useChatStore.setState({ selectedWorktree: null });
});

it('reports which chat each chat and Chat visuals panel shows', () => {
  useChatStore.setState({ selectedWorktree: SCOPE });
  usePanelLayoutStore.getState().initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-chat',
        panelId: 'panel-chat-chat-1',
        instance: { chatTabId: 'chat-1' },
      },
      {
        kind: 'chat-visuals',
        groupId: 'group-visuals',
        panelId: 'panel-chat-visuals',
        instance: { chatId: 'chat-1' },
        title: 'Chat visuals',
      },
    ],
    containerSize: { width: 1200, height: 800 },
  });

  const tabs = (buildCurrentUiStateSnapshot({}).panels?.groups ?? []).flatMap(
    (group) => group.tabs,
  );

  expect(tabs).toEqual([
    { panelId: 'panel-chat-chat-1', kind: 'chat', chatId: 'chat-1' },
    {
      panelId: 'panel-chat-visuals',
      kind: 'chat-visuals',
      title: 'Chat visuals',
      chatId: 'chat-1',
    },
  ]);
});
