/** @jest-environment jsdom */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useExperimentalFeaturesStore } from '@/stores/experimentalFeaturesStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { buildBaseCommands, type PaletteCommand } from '../paletteCommands';

const SELECTION = { projectId: 'project-a', worktreeId: 'wt-1' };
const WORKTREE_KEY = makeWorktreePanelKey(
  SELECTION.projectId,
  SELECTION.worktreeId,
);

function makeTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-1',
    title: 'Session title',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false },
    fastModeExplicit: false,
    ...overrides,
  };
}

function commandById(id: string): PaletteCommand | undefined {
  return buildBaseCommands(SELECTION, true).find(
    (command) => command.commandKey === id,
  );
}

function panelTabs(kind: 'cost' | 'session-breakdown'): number {
  const layout = usePanelLayoutStore.getState().layouts[WORKTREE_KEY];
  return Object.values(layout?.groups ?? {}).flatMap((group) =>
    group.tabs.filter((tab) => tab.kind === kind),
  ).length;
}

beforeEach(() => {
  useNavigationStore.setState({ activePage: 'overview' });
  useChatStore.setState({ selectedWorktree: SELECTION, worktreeChats: {} });
  setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
});

afterEach(() => {
  setTestEarlyAccessFeatures({ enabled: false, hydrated: false });
  useChatStore.setState({ selectedWorktree: null, worktreeChats: {} });
  const state = usePanelLayoutStore.getState();
  for (const key of Object.keys(state.layouts)) {
    state.disposeLayout(key);
  }
});

test('offers the Cost panel command with Early access off', () => {
  expect(useExperimentalFeaturesStore.getState().enabled).toBe(false);
  expect(commandById('open-cost-panel')).toMatchObject({
    title: 'Open Cost panel',
  });
});

test('requires an active chat for Session breakdown, not a file tab', () => {
  expect(commandById('open-cost-panel')).toMatchObject({
    title: 'Open Cost panel',
    category: 'panels',
  });
  expect(commandById('open-session-breakdown')).toBeUndefined();

  useChatStore.setState({
    worktreeChats: {
      [WORKTREE_KEY]: {
        activeTabId: 'file-1',
        tabs: [makeTab({ id: 'file-1', kind: 'file' })],
      },
    },
  });
  expect(commandById('open-session-breakdown')).toBeUndefined();

  useChatStore.setState({
    worktreeChats: {
      [WORKTREE_KEY]: {
        activeTabId: 'chat-1',
        tabs: [makeTab()],
      },
    },
  });
  expect(commandById('open-session-breakdown')).toMatchObject({
    title: 'Open Session breakdown',
    category: 'panels',
  });
});

test('opens or focuses the selected scope panels from the palette', async () => {
  useChatStore.setState({
    worktreeChats: {
      [WORKTREE_KEY]: {
        activeTabId: 'chat-1',
        tabs: [makeTab({ title: 'Session title' })],
      },
    },
  });
  usePanelLayoutStore.getState().initializeLayout(WORKTREE_KEY, {
    orientation: 'horizontal',
    groups: [{ kind: 'chat', groupId: 'group-a', panelId: 'panel-chat' }],
    containerSize: { width: 800, height: 600 },
  });

  await expect(commandById('open-cost-panel')?.execute()).resolves.toEqual({
    closePalette: true,
  });
  await expect(
    commandById('open-session-breakdown')?.execute(),
  ).resolves.toEqual({
    closePalette: true,
  });
  await expect(commandById('open-cost-panel')?.execute()).resolves.toEqual({
    closePalette: true,
  });
  await expect(
    commandById('open-session-breakdown')?.execute(),
  ).resolves.toEqual({
    closePalette: true,
  });

  expect(useNavigationStore.getState().activePage).toBe('main');
  expect(panelTabs('cost')).toBe(1);
  expect(panelTabs('session-breakdown')).toBe(1);
});
