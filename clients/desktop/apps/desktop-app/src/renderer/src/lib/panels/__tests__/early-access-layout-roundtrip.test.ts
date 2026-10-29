/** @jest-environment jsdom */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

// Early access must never change a user's layout mode or rewrite a layout
// they already have: on -> off round trips through the real experimental
// features store, shared-layout sync, early-access panel rules, layout mode
// store and actions, panel layout store and persistence bridge (IPC mocked).
import type { SaveWorktreePanelLayoutRequest } from '@canopy/desktop-shared/types';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { useChatStore } from '@/stores/chatStore';
import { bindTerminalClient } from '@canopy/app-state/terminal';
import { ipcTerminalClient } from '@/client/ipc-terminal-client';
import {
  getWorkspaceLayoutMode,
  useWorkspaceLayoutModeStore,
} from '@/stores/workspaceLayoutModeStore';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import {
  ensureWorktreePanelLayout,
  flushPendingPanelLayoutSaves,
  resetPanelLayoutPersistenceBridgeForTests,
} from '../persistence-bridge';
import {
  ensureEarlyAccessMinimalSync,
  resetEarlyAccessMinimalSyncForTest,
} from '../early-access-minimal-sync';
import {
  ensureEarlyAccessPanelRulesSync,
  resetEarlyAccessPanelRulesSyncForTest,
} from '../early-access-panel-rules';
import { setFixedSidePanelTabsClosable } from '@/stores/panelLayoutStore';

jest.mock('@/lib/panels/terminal-panel-sync', () => ({
  closeOmittedTerminalBinding: jest.fn(),
}));
jest.mock('@/lib/panels/browser-panel-sync', () => ({
  requestBrowserSessionDestruction: jest.fn(),
}));
jest.mock('@/lib/panels/registry', () => ({
  getPanelDefinition: (kind: string): { canPopOut: boolean } => ({
    canPopOut: kind !== 'browser',
  }),
}));
jest.mock('../start-page', () => ({
  maybeOpenStartPage: (): Promise<void> => Promise.resolve(),
}));

const KEY = makeWorktreePanelKey('project-1', 'worktree-1');
const saveWorktreeLayout = jest.fn<
  Promise<void>,
  [SaveWorktreePanelLayoutRequest]
>();
const saveWorktreeMode = jest.fn<Promise<void>, [unknown]>();
const loadWorktreeLayout = jest.fn();

const chat = (id: string): Record<string, unknown> => ({
  panelId: `panel-chat-${id}`,
  kind: 'chat',
  instance: { chatTabId: id },
});

/** A typical hand-arranged Advanced layout. */
const ADVANCED = {
  version: 1,
  grid: {
    orientation: 0,
    width: 1200,
    height: 800,
    root: {
      type: 'branch',
      size: 1200,
      children: [
        {
          type: 'branch',
          size: 560,
          children: [
            {
              type: 'leaf',
              groupId: 'group-chat',
              size: 500,
              panels: [chat('a'), chat('b')],
              activePanelId: 'panel-chat-a',
            },
            {
              type: 'leaf',
              groupId: 'group-split-right',
              size: 400,
              panels: [chat('c')],
              activePanelId: 'panel-chat-c',
            },
            {
              type: 'leaf',
              groupId: 'group-activity',
              size: 300,
              panels: [
                { panelId: 'panel-activity', kind: 'activity-section' },
                { panelId: 'panel-file-explorer', kind: 'file-explorer' },
              ],
              activePanelId: 'panel-file-explorer',
            },
          ],
        },
        {
          type: 'leaf',
          groupId: 'group-terminal',
          size: 240,
          panels: [{ panelId: 'panel-terminal', kind: 'terminal' }, chat('d')],
          activePanelId: 'panel-chat-d',
        },
      ],
    },
  },
  activeGroupId: 'group-split-right',
  mostRecentActiveGroupIds: ['group-split-right', 'group-chat'],
};

type Shape = Array<{ groupId: string; tabs: string[] }>;
function shape(): Shape {
  const layout = usePanelLayoutStore.getState().layouts[KEY];
  return Object.entries(layout?.groups ?? {}).map(([groupId, group]) => ({
    groupId,
    tabs: group.tabs.map((tab) => tab.panelId),
  }));
}
function lastSaved(): string {
  const call = saveWorktreeLayout.mock.calls.at(-1);
  return JSON.stringify(call?.[0].layout ?? null);
}
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  jest.advanceTimersByTime(1000);
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

let disposeTerminalClient: (() => void) | undefined;
beforeEach(() => {
  jest.useFakeTimers();
  loadWorktreeLayout.mockResolvedValue({ layout: ADVANCED });
  saveWorktreeLayout.mockResolvedValue(undefined);
  saveWorktreeMode.mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      panelLayout: {
        loadWorktreeLayout,
        saveWorktreeLayout,
        loadDefaultLayout: jest.fn().mockResolvedValue({ layout: null }),
        saveDefaultLayout: jest.fn(),
        loadWorktreeMode: jest.fn().mockResolvedValue({ mode: 'advanced' }),
        saveWorktreeMode,
      },
      browser: {
        loadWorktreeState: jest
          .fn()
          .mockResolvedValue({ status: 'missing', state: null }),
        saveWorktreeState: jest.fn().mockResolvedValue(undefined),
      },
      terminal: {
        loadWorktreeState: jest.fn().mockResolvedValue({
          drawerCollapsed: false,
          groups: [],
          activeGroupId: null,
          nextGroupOrdinal: 1,
          groupOrdinals: {},
          terminalCustomNames: {},
          groupCustomNames: {},
          terminals: [],
          liveTerminalIds: [],
        }),
      },
    },
  });
  disposeTerminalClient = bindTerminalClient(ipcTerminalClient);
  // Hydrated, early access off.
  setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
  ensureEarlyAccessMinimalSync();
  ensureEarlyAccessPanelRulesSync();
});

afterEach(() => {
  resetEarlyAccessMinimalSyncForTest();
  resetEarlyAccessPanelRulesSyncForTest();
  setFixedSidePanelTabsClosable(false);
  resetExperimentalFeaturesStoreForTest();
  resetPanelLayoutPersistenceBridgeForTests();
  useChatStore.setState({ worktreeChats: {} });
  disposeTerminalClient?.();
  useWorkspaceLayoutModeStore.setState({ entries: {} });
  usePanelWindowsStore.setState({ auxWindows: {} });
  const store = usePanelLayoutStore.getState();
  for (const key of Object.keys(store.layouts)) store.disposeLayout(key);
  jest.useRealTimers();
});

function flipEarlyAccess(enabled: boolean): void {
  // App.tsx does this in a layout effect on the same flip.
  setFixedSidePanelTabsClosable(enabled);
  setTestEarlyAccessFeatures({ enabled: enabled, hydrated: true });
}

async function flipAndSettle(enabled: boolean): Promise<void> {
  flipEarlyAccess(enabled);
  await settle();
  flushPendingPanelLayoutSaves();
  await settle();
}

function collapsedState(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(
      usePanelLayoutStore.getState().layouts[KEY]?.groups ?? {},
    ).map(([id, group]) => [id, group.collapsed ?? null]),
  );
}

/** Drops the live layout and opens it again from what was last saved. */
async function relaunch(): Promise<void> {
  const saved = saveWorktreeLayout.mock.calls.at(-1)?.[0].layout;
  if (saved !== undefined) {
    loadWorktreeLayout.mockResolvedValue({ layout: saved });
  }
  resetPanelLayoutPersistenceBridgeForTests();
  usePanelLayoutStore.getState().disposeLayout(KEY);
  useWorkspaceLayoutModeStore.setState({ entries: {} });
  await ensureWorktreePanelLayout(KEY);
  await settle();
}

describe('an Advanced user turning early access on and off', () => {
  it('keeps Advanced and the layout unchanged, in memory and on disk', async () => {
    await ensureWorktreePanelLayout(KEY);
    const before = shape();
    expect(before).toEqual([
      { groupId: 'group-chat', tabs: ['panel-chat-a', 'panel-chat-b'] },
      { groupId: 'group-split-right', tabs: ['panel-chat-c'] },
      {
        groupId: 'group-activity',
        tabs: ['panel-activity', 'panel-file-explorer'],
      },
      { groupId: 'group-terminal', tabs: ['panel-terminal', 'panel-chat-d'] },
    ]);
    saveWorktreeLayout.mockClear();

    await flipAndSettle(true);
    expect(getWorkspaceLayoutMode(KEY)).toBe('advanced');
    expect(shape()).toEqual(before);
    // Nothing early access did was written over the saved layout or mode.
    expect(saveWorktreeLayout).not.toHaveBeenCalled();
    expect(saveWorktreeMode).not.toHaveBeenCalled();

    await flipAndSettle(false);
    expect(getWorkspaceLayoutMode(KEY)).toBe('advanced');
    expect(shape()).toEqual(before);
    expect(saveWorktreeLayout).not.toHaveBeenCalled();
    expect(saveWorktreeMode).not.toHaveBeenCalled();
  });

  it('opens an Advanced worktree unchanged while early access is on', async () => {
    await flipAndSettle(true);
    await ensureWorktreePanelLayout(KEY);
    await settle();

    expect(getWorkspaceLayoutMode(KEY)).toBe('advanced');
    const opened = shape();
    expect(opened.map((group) => group.groupId)).toEqual([
      'group-chat',
      'group-split-right',
      'group-activity',
      'group-terminal',
    ]);
    // Opening saves nothing.
    expect(saveWorktreeLayout).not.toHaveBeenCalled();

    // A user's own change saves the layout as it is, still Advanced.
    usePanelLayoutStore.getState().selectTab(KEY, 'group-chat', 'panel-chat-b');
    await settle();
    expect(saveWorktreeLayout).toHaveBeenCalled();
    expect(lastSaved()).toContain('group-split-right');
    expect(lastSaved()).toContain('panel-activity');
    expect(shape()).toEqual(opened);

    await flipAndSettle(false);
    expect(getWorkspaceLayoutMode(KEY)).toBe('advanced');
    expect(shape()).toEqual(opened);
  });

  it('still routes new chats to the chat group under early access', async () => {
    await ensureWorktreePanelLayout(KEY);
    await flipAndSettle(true);

    usePanelLayoutStore.getState().addTab(KEY, 'group-terminal', 'chat', {
      instance: { chatTabId: 'new' },
    });

    const groups = Object.fromEntries(
      shape().map((group) => [group.groupId, group.tabs]),
    );
    expect(groups['group-chat']).toHaveLength(3);
    expect(groups['group-terminal']).toEqual([
      'panel-terminal',
      'panel-chat-d',
    ]);
  });
});

describe('a Minimal user turning early access on and off', () => {
  const MINIMAL = {
    version: 1,
    grid: {
      orientation: 0,
      width: 1200,
      height: 800,
      root: {
        type: 'branch',
        size: 1200,
        children: [
          {
            type: 'branch',
            size: 560,
            children: [
              {
                type: 'leaf',
                groupId: 'group-chat',
                size: 800,
                panels: [chat('a')],
                activePanelId: 'panel-chat-a',
              },
              {
                type: 'leaf',
                groupId: 'group-extras',
                size: 400,
                panels: [
                  { panelId: 'panel-activity', kind: 'activity-section' },
                  { panelId: 'panel-file-explorer', kind: 'file-explorer' },
                  chat('side'),
                ],
                activePanelId: 'panel-file-explorer',
              },
            ],
          },
          {
            type: 'leaf',
            groupId: 'group-terminal',
            size: 240,
            panels: [
              { panelId: 'panel-terminal', kind: 'terminal' },
              chat('d'),
            ],
            activePanelId: 'panel-chat-d',
          },
        ],
      },
    },
    activeGroupId: 'group-chat',
    mostRecentActiveGroupIds: ['group-chat'],
  };

  beforeEach(() => {
    loadWorktreeLayout.mockResolvedValue({ layout: MINIMAL });
    (window.api.panelLayout.loadWorktreeMode as jest.Mock).mockResolvedValue({
      mode: 'minimal',
    });
  });

  it('keeps the Side Panel tabs, their order and what is shown', async () => {
    await ensureWorktreePanelLayout(KEY);
    const before = shape();
    const collapsedBefore = collapsedState();
    expect(before).toContainEqual({
      groupId: 'group-extras',
      tabs: ['panel-activity', 'panel-file-explorer', 'panel-chat-side'],
    });

    await flipAndSettle(true);
    expect(getWorkspaceLayoutMode(KEY)).toBe('minimal');
    expect(shape()).toEqual(before);
    expect(collapsedState()).toEqual(collapsedBefore);

    await flipAndSettle(false);
    expect(shape()).toEqual(before);
    expect(collapsedState()).toEqual(collapsedBefore);
    expect(saveWorktreeMode).not.toHaveBeenCalled();
  });

  it('keeps a Side Panel order the user chose across launches with early access on', async () => {
    await flipAndSettle(true);
    await ensureWorktreePanelLayout(KEY);
    await settle();
    // The user moves File explorer to the front of the Side Panel.
    usePanelLayoutStore
      .getState()
      .reorderTab(KEY, 'group-extras', 'panel-file-explorer', 0);
    await settle();
    flushPendingPanelLayoutSaves();
    await settle();
    const arranged = shape();
    const collapsedArranged = collapsedState();
    expect(arranged).toContainEqual({
      groupId: 'group-extras',
      tabs: ['panel-file-explorer', 'panel-activity', 'panel-chat-side'],
    });

    await relaunch();
    expect(shape()).toEqual(arranged);
    expect(collapsedState()).toEqual(collapsedArranged);

    await relaunch();
    expect(shape()).toEqual(arranged);
    expect(collapsedState()).toEqual(collapsedArranged);
  });
});
