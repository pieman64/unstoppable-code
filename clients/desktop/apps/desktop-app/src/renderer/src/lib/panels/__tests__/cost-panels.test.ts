/** @jest-environment jsdom */

import {
  makeAuxPanelLayoutKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import {
  DEFAULT_CHAT_GROUP_ID,
  DEFAULT_EXTRAS_GROUP_ID,
  DEFAULT_TERMINAL_GROUP_ID,
} from '@/lib/panels/panel-group-ids';
import {
  COST_PANEL_ID,
  COST_PANEL_TITLE,
  SESSION_BREAKDOWN_PANEL_NAME,
  costPanelSeed,
  openCostPanel,
  openSessionBreakdownPanel,
  sessionBreakdownPanelIdFor,
  sessionBreakdownPanelInstanceKey,
  sessionBreakdownPanelSeed,
} from '@/lib/cost/open-cost-panels';

const SCOPE = { projectId: 'project-a', worktreeId: 'wt-1' };
const WORKTREE_KEY = `${SCOPE.projectId}/${SCOPE.worktreeId}`;

function countPanels(kind: 'cost' | 'session-breakdown'): number {
  return Object.values(usePanelLayoutStore.getState().layouts).flatMap(
    (layout) =>
      Object.values(layout.groups).flatMap((group) =>
        group.tabs.filter((tab) => tab.kind === kind),
      ),
  ).length;
}

function initializeAdvancedLayout(): void {
  usePanelLayoutStore.getState().initializeLayout(WORKTREE_KEY, {
    orientation: 'horizontal',
    groups: [
      { kind: 'chat', groupId: 'group-chat', panelId: 'panel-chat' },
      { kind: 'usage', groupId: 'group-active', panelId: 'panel-usage' },
    ],
    containerSize: { width: 1000, height: 700 },
  });
}

function initializeMinimalLayout(): void {
  usePanelLayoutStore.getState().initializeLayout(WORKTREE_KEY, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: DEFAULT_CHAT_GROUP_ID,
        panelId: 'panel-chat',
      },
      {
        kind: 'file-explorer',
        groupId: DEFAULT_EXTRAS_GROUP_ID,
        panelId: 'panel-explorer',
      },
      { groupId: DEFAULT_TERMINAL_GROUP_ID },
    ],
    containerSize: { width: 1000, height: 700 },
  });
  useWorkspaceLayoutModeStore.setState({
    entries: {
      [WORKTREE_KEY]: { mode: 'minimal', status: 'ready', requestId: 1 },
    },
  });
}

afterEach(() => {
  const state = usePanelLayoutStore.getState();
  for (const key of Object.keys(state.layouts)) {
    state.disposeLayout(key);
  }
  useWorkspaceLayoutModeStore.setState({ entries: {} });
});

test('seeds a scope singleton and a chat-bound Session breakdown', () => {
  expect(costPanelSeed()).toEqual({
    kind: 'cost',
    panelId: COST_PANEL_ID,
    title: COST_PANEL_TITLE,
    instance: {},
  });
  expect(sessionBreakdownPanelIdFor('chat/one')).toBe(
    'panel-session-breakdown-chat_one',
  );
  expect(sessionBreakdownPanelInstanceKey('chat-1')).toBe(
    'session-breakdown:chat-1',
  );
  expect(sessionBreakdownPanelSeed('chat-1', 'Session title')).toEqual({
    kind: 'session-breakdown',
    panelId: 'panel-session-breakdown-chat-1',
    title: 'Session title',
    instance: { chatId: 'chat-1' },
  });
});

test('puts new panels in the active Advanced group', async () => {
  initializeAdvancedLayout();
  usePanelLayoutStore.getState().focusGroup(WORKTREE_KEY, 'group-active');

  const cost = await openCostPanel(SCOPE);
  const breakdown = await openSessionBreakdownPanel(SCOPE, 'chat-1');

  expect(cost).toMatchObject({
    status: 'placed',
    location: { groupId: 'group-active' },
  });
  expect(breakdown).toMatchObject({
    status: 'placed',
    location: { groupId: 'group-active' },
  });
  const costTab = Object.values(
    usePanelLayoutStore.getState().layouts[WORKTREE_KEY]?.groups ?? {},
  )
    .flatMap((group) => group.tabs)
    .find((tab) => tab.kind === 'cost');
  expect(costTab?.instance).toBeUndefined();
});

test('puts new panels in the Side Panel in Minimal', async () => {
  initializeMinimalLayout();

  const cost = await openCostPanel(SCOPE);
  const breakdown = await openSessionBreakdownPanel(SCOPE, 'chat-1');

  expect(cost).toMatchObject({
    status: 'placed',
    location: { groupId: DEFAULT_EXTRAS_GROUP_ID },
  });
  expect(breakdown).toMatchObject({
    status: 'placed',
    location: { groupId: DEFAULT_EXTRAS_GROUP_ID },
  });
});

test('reveals an existing breakdown in an auxiliary layout without duplicating it', async () => {
  const store = usePanelLayoutStore.getState();
  const auxiliaryKey = makeAuxPanelLayoutKey(WORKTREE_KEY, 'aux-1');
  store.initializeLayout(WORKTREE_KEY, {
    orientation: 'horizontal',
    groups: [{ kind: 'chat', groupId: 'group-main', panelId: 'panel-main' }],
    containerSize: { width: 1000, height: 700 },
  });
  store.initializeLayout(auxiliaryKey, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'session-breakdown',
        groupId: 'group-aux',
        panelId: 'panel-breakdown',
        title: 'Chat title',
        instance: { chatId: 'chat-1' },
      },
    ],
    containerSize: { width: 600, height: 500 },
  });

  const result = await openSessionBreakdownPanel(SCOPE, 'chat-1');

  expect(result).toMatchObject({
    status: 'revealed',
    location: { layoutKey: auxiliaryKey, groupId: 'group-aux' },
  });
  expect(countPanels('session-breakdown')).toBe(1);
});

test('focuses the scope singleton instead of adding another Cost panel', async () => {
  initializeAdvancedLayout();

  await expect(openCostPanel(SCOPE)).resolves.toMatchObject({
    status: 'placed',
  });
  await expect(openCostPanel(SCOPE)).resolves.toMatchObject({
    status: 'revealed',
  });
  expect(countPanels('cost')).toBe(1);
  expect(SESSION_BREAKDOWN_PANEL_NAME).toBe('Session breakdown');
});
