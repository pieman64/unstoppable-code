/** @jest-environment jsdom */

/**
 * `revealChatPanel` — brings the panel bound to one chat into view, against
 * the REAL panel layout store. The auxiliary-window focus step is observed
 * through the panel-windows store action it delegates to.
 */
import {
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { revealChatPanel } from '../reveal-chat-panel';

jest.mock('@/lib/panels/registry', () => ({
  getPanelDefinition: (): { canPopOut: boolean } => ({ canPopOut: true }),
}));
const ensureWorktreePanelLayout = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
jest.mock('../persistence-bridge', () => ({
  ensureWorktreePanelLayout: (key: string): Promise<void> =>
    ensureWorktreePanelLayout(key),
}));

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-chat-reveal';
const KEY = makeWorktreePanelKey(PROJECT_ID, WORKTREE_ID);
const TARGET = {
  projectId: PROJECT_ID,
  worktreeId: WORKTREE_ID,
  chatId: 'chat-2',
};

const LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-chat',
      panelId: 'panel-chat-chat-1',
      instance: { chatTabId: 'chat-1' },
    },
    {
      kind: 'pipeline-execution',
      groupId: 'group-runs',
      panelId: 'panel-pipeline-run-1',
      instance: { executionId: 'run-1' },
    },
  ],
  containerSize: { width: 1200, height: 800 },
};

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

const initialWindowsState = usePanelWindowsStore.getState();
const focusAuxWindow = jest.fn<boolean, [string]>(() => true);

beforeEach(() => {
  store().initializeLayout(KEY, LAYOUT);
  // The receiving chat shares a group with chat-1 and is NOT the active tab.
  expect(
    store().addTab(KEY, 'group-chat', 'chat', {
      panelId: 'panel-chat-chat-2',
      instance: { chatTabId: 'chat-2' },
    }),
  ).toBe('panel-chat-chat-2');
  store().selectTab(KEY, 'group-chat', 'panel-chat-chat-1');
  store().selectTab(KEY, 'group-runs', 'panel-pipeline-run-1', {
    focus: true,
  });
  usePanelWindowsStore.setState({ focusAuxWindowForLayout: focusAuxWindow });
});

afterEach(() => {
  usePanelWindowsStore.setState(initialWindowsState, true);
  focusAuxWindow.mockClear();
  ensureWorktreePanelLayout.mockClear();
  for (const key of Object.keys(store().layouts)) {
    store().disposeLayout(key);
  }
});

test('selects the chat tab when another tab of its group is active', async () => {
  expect(store().layouts[KEY]?.groups['group-chat']?.activePanelId).toBe(
    'panel-chat-chat-1',
  );

  await expect(revealChatPanel(TARGET)).resolves.toBe(true);

  const layout = store().layouts[KEY];
  expect(layout?.groups['group-chat']?.activePanelId).toBe('panel-chat-chat-2');
  expect(layout?.activeGroupId).toBe('group-chat');
});

test('expands a collapsed group before selecting the chat', async () => {
  expect(store().collapseGroup(KEY, 'group-chat')).toBe(true);

  await expect(revealChatPanel(TARGET)).resolves.toBe(true);

  const layout = store().layouts[KEY];
  expect(layout?.groups['group-chat']?.collapsed).toBeUndefined();
  expect(layout?.groups['group-chat']?.activePanelId).toBe('panel-chat-chat-2');
});

test('exits a maximize of a different group', async () => {
  store().maximizeGroup(KEY, 'group-runs', true);
  expect(store().layouts[KEY]?.maximizedGroupId).toBe('group-runs');

  await expect(revealChatPanel(TARGET)).resolves.toBe(true);

  const layout = store().layouts[KEY];
  expect(layout?.maximizedGroupId).toBeNull();
  expect(layout?.activeGroupId).toBe('group-chat');
});

test('focuses the auxiliary window holding the chat', async () => {
  const auxKey = makeAuxPanelLayoutKey(KEY, 'aux-chat');
  expect(store().extractGroupToLayout(KEY, 'group-chat', auxKey)).toBe(true);

  await expect(revealChatPanel(TARGET)).resolves.toBe(true);

  expect(focusAuxWindow).toHaveBeenCalledWith(auxKey);
  expect(store().layouts[auxKey]?.groups['group-chat']?.activePanelId).toBe(
    'panel-chat-chat-2',
  );
});

test('waits for the chat sync bridge to materialize a missing panel', async () => {
  store().closeTab(KEY, 'group-chat', 'panel-chat-chat-2');
  setTimeout(() => {
    store().addTab(KEY, 'group-chat', 'chat', {
      panelId: 'panel-chat-chat-2',
      instance: { chatTabId: 'chat-2' },
    });
  }, 40);

  await expect(revealChatPanel(TARGET)).resolves.toBe(true);

  expect(store().layouts[KEY]?.groups['group-chat']?.activePanelId).toBe(
    'panel-chat-chat-2',
  );
});

test('gives up without mutating anything when the chat never gets a panel', async () => {
  store().closeTab(KEY, 'group-chat', 'panel-chat-chat-2');
  const revision = store().layouts[KEY]?.revision;

  await expect(revealChatPanel(TARGET, { timeoutMs: 60 })).resolves.toBe(false);

  expect(store().layouts[KEY]?.revision).toBe(revision);
});

test('loads the owner layout first when it is not live yet', async () => {
  store().disposeLayout(KEY);
  ensureWorktreePanelLayout.mockImplementation(() => {
    store().initializeLayout(KEY, LAYOUT);
    store().addTab(KEY, 'group-chat', 'chat', {
      panelId: 'panel-chat-chat-2',
      instance: { chatTabId: 'chat-2' },
    });
    return Promise.resolve();
  });

  await expect(revealChatPanel(TARGET)).resolves.toBe(true);

  expect(ensureWorktreePanelLayout).toHaveBeenCalledWith(KEY);
  expect(store().layouts[KEY]?.groups['group-chat']?.activePanelId).toBe(
    'panel-chat-chat-2',
  );
});
