/** @jest-environment jsdom */

/**
 * Chat-panel reveal bridge — a `requestChatPanelReveal` for a chat whose panel
 * is collapsed expands + focuses that group (the toast/overview navigation
 * gap where switchTab clears unread but never re-activates the tab).
 */
import { requestChatPanelReveal } from '@/lib/chatPanelReveal';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { initChatPanelReveal } from '../chat-panel-activation';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = makeWorktreePanelKey(PROJECT_ID, WORKTREE_ID);

const LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-chat',
      panelId: 'panel-chat-chat-1',
      instance: { chatTabId: 'chat-1' },
    },
    { kind: 'terminal', groupId: 'group-terminal', panelId: 'panel-terminal' },
  ],
  containerSize: { width: 1200, height: 800 },
};

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

beforeAll(() => {
  initChatPanelReveal();
});

afterEach(() => {
  const state = store();
  for (const key of Object.keys(state.layouts)) {
    state.disposeLayout(key);
  }
});

test('reveal request expands and focuses the collapsed group holding the chat', () => {
  store().initializeLayout(KEY, LAYOUT);
  expect(store().collapseGroup(KEY, 'group-chat')).toBe(true);
  expect(store().layouts[KEY].groups['group-chat'].collapsed).toBeDefined();

  requestChatPanelReveal(PROJECT_ID, WORKTREE_ID, 'chat-1');

  expect(store().layouts[KEY].groups['group-chat'].collapsed).toBeUndefined();
  expect(store().layouts[KEY].activeGroupId).toBe('group-chat');
});

test('reveal request is a no-op when the chat panel is not in the layout', () => {
  store().initializeLayout(KEY, LAYOUT);
  const revisionBefore = store().layouts[KEY].revision;

  requestChatPanelReveal(PROJECT_ID, WORKTREE_ID, 'chat-absent');

  expect(store().layouts[KEY].revision).toBe(revisionBefore);
});
