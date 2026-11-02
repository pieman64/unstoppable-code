/** @jest-environment jsdom */

/**
 * Persistence bridge — Phase 9 popped-out window persistence. Covers the
 * aux-inclusive save path (aux layouts fold into the OWNING worktree's one
 * debounced `panel-layout.json`, with a `poppedOut` snapshot per open aux
 * window), the parent-orchestrated relaunch restore, the failed-open
 * merge-back data-loss guard, and the full save→restore round-trip.
 *
 * The desktop panel registry is mocked to its `canPopOut` flags (the real
 * registry mounts heavy surfaces); `window.open` is mocked per test.
 */
import type { SaveWorktreePanelLayoutRequest } from '@canopy/desktop-shared/types';
import {
  migratePanelLayout,
  PANEL_INSTANCE_VALUE_MAX_LENGTH,
} from '@canopy/protocol';
import {
  getPanelLayoutViewModel,
  setFixedSidePanelTabsClosable,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { useBrowserStore } from '@/stores/browserStore';
import { readRemoteControlContext } from '@/stores/remoteControlStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { bindTerminalClient } from '@canopy/app-state/terminal';
import { ipcTerminalClient } from '@/client/ipc-terminal-client';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import {
  DEFAULT_ACTIVITY_GROUP_ID,
  DEFAULT_CHAT_GROUP_ID,
  DEFAULT_TERMINAL_GROUP_ID,
  DEFAULT_TERMINAL_PANEL_ID,
} from '../default-layout';
import { DEFAULT_EXTRAS_GROUP_ID } from '../panel-group-ids';
import {
  createAuxWindowBoundsWatcher,
  ensureWorktreePanelLayout,
  expandActivityRailFromContent,
  forkWorktreePanelLayout,
  flushPanelLayoutSaveForWorktree,
  flushPanelLayoutSavesForProject,
  schedulePanelLayoutSave,
  resetLayoutToDefault,
  resetPanelLayoutPersistenceBridgeForTests,
  resumePanelLayoutPersistence,
  saveCurrentLayoutAsDefault,
  suspendPanelLayoutPersistence,
  isPanelLayoutPersistenceSuspended,
} from '../persistence-bridge';

jest.mock('@/stores/remoteControlStore', () => ({
  readRemoteControlContext: jest.fn(() => ({ mode: 'local' })),
}));

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
const mockMaybeOpenStartPage = jest.fn<
  Promise<void>,
  [string, number, boolean]
>(() => Promise.resolve());
jest.mock('../start-page', () => ({
  maybeOpenStartPage: (
    worktreeKey: string,
    generation: number,
    createdLayout: boolean,
  ): Promise<void> =>
    mockMaybeOpenStartPage(worktreeKey, generation, createdLayout),
}));

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = makeWorktreePanelKey(PROJECT_ID, WORKTREE_ID);

const loadWorktreeLayout = jest.fn<Promise<{ layout: unknown }>, [unknown]>();
const saveWorktreeLayout = jest.fn<
  Promise<void>,
  [SaveWorktreePanelLayoutRequest]
>();
const loadDefaultLayout = jest.fn<
  Promise<{ layout: unknown }>,
  [{ surface: string }]
>();
const saveDefaultLayout = jest.fn<
  Promise<void>,
  [{ surface: string; layout: unknown }]
>();
const loadBrowserState = jest.fn<
  Promise<{ state: null }>,
  [{ projectId: string; worktreeId: string }]
>();
const saveBrowserState = jest.fn<Promise<void>, [unknown]>();
const loadWorktreeMode = jest.fn();
const saveWorktreeMode = jest.fn<Promise<void>, [unknown]>();
const loadTerminalState = jest.fn();

interface FakeChildWindow {
  closed: boolean;
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  close: jest.Mock;
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
}

function makeFakeChildWindow(
  bounds: { x: number; y: number; width: number; height: number } = {
    x: 120,
    y: 80,
    width: 900,
    height: 600,
  },
): FakeChildWindow {
  const child: FakeChildWindow = {
    closed: false,
    screenX: bounds.x,
    screenY: bounds.y,
    outerWidth: bounds.width,
    outerHeight: bounds.height,
    close: jest.fn((): void => {
      child.closed = true;
    }),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  return child;
}

interface WindowOpenCall {
  url?: string | URL;
  target?: string;
  features?: string;
}

function mockWindowOpen(child: FakeChildWindow | null): {
  calls: WindowOpenCall[];
} {
  const capture: { calls: WindowOpenCall[] } = { calls: [] };
  const handle: Window | null =
    child === null ? null : (child as unknown as Window);
  const impl: typeof window.open = (url?, target?, features?) => {
    capture.calls.push({ url, target, features });
    return handle;
  };
  jest.spyOn(window, 'open').mockImplementation(impl);
  return capture;
}

async function flushDebounce(): Promise<void> {
  jest.advanceTimersByTime(500);
  await Promise.resolve();
}

let disposeTerminalClient: (() => void) | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  setFixedSidePanelTabsClosable(true);
  jest.mocked(readRemoteControlContext).mockReturnValue({ mode: 'local' });
  loadWorktreeLayout.mockResolvedValue({ layout: null });
  saveWorktreeLayout.mockResolvedValue(undefined);
  loadDefaultLayout.mockResolvedValue({ layout: null });
  saveDefaultLayout.mockResolvedValue(undefined);
  loadBrowserState.mockResolvedValue({ state: null });
  saveBrowserState.mockResolvedValue(undefined);
  loadWorktreeMode.mockResolvedValue({ mode: 'advanced' });
  saveWorktreeMode.mockResolvedValue(undefined);
  loadTerminalState.mockResolvedValue({
    drawerCollapsed: false,
    groups: [],
    activeGroupId: null,
    nextGroupOrdinal: 1,
    groupOrdinals: {},
    terminalCustomNames: {},
    groupCustomNames: {},
    terminals: [],
    liveTerminalIds: [],
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      panelLayout: {
        loadWorktreeLayout,
        saveWorktreeLayout,
        loadDefaultLayout,
        saveDefaultLayout,
        loadWorktreeMode,
        saveWorktreeMode,
      },
      browser: {
        loadWorktreeState: loadBrowserState,
        saveWorktreeState: saveBrowserState,
      },
      terminal: { loadWorktreeState: loadTerminalState },
    },
  });
  disposeTerminalClient = bindTerminalClient(ipcTerminalClient);
});

afterEach(() => {
  resetPanelLayoutPersistenceBridgeForTests();
  useBrowserStore.setState({ worktrees: {} });
  useChatStore.setState({ worktreeChats: {} });
  disposeTerminalClient?.();
  useWorkspaceLayoutModeStore.setState({ entries: {} });
  usePanelWindowsStore.setState({ auxWindows: {} });
  const store = usePanelLayoutStore.getState();
  for (const key of Object.keys(store.layouts)) {
    store.disposeLayout(key);
  }
  setFixedSidePanelTabsClosable(false);
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('remote worktree layout hydration', () => {
  it('keeps a legacy remote arrangement and protects the host file from saves', async () => {
    jest.mocked(readRemoteControlContext).mockReturnValue({
      mode: 'remote',
      deviceId: 'remote-host',
      name: 'Host',
      platform: 'darwin',
    });
    loadWorktreeLayout.mockResolvedValue({
      layout: {
        version: 1,
        grid: {
          orientation: 0,
          width: 1200,
          height: 800,
          root: {
            type: 'leaf',
            groupId: 'group-legacy-arrangement',
            size: 800,
            panels: [
              { panelId: 'panel-legacy-files', kind: 'file-explorer' },
              { panelId: 'panel-legacy-browser', kind: 'browser' },
            ],
            activePanelId: 'panel-legacy-files',
          },
        },
        activeGroupId: 'group-legacy-arrangement',
        mostRecentActiveGroupIds: ['group-legacy-arrangement'],
      },
    });
    await ensureWorktreePanelLayout(KEY);
    const group =
      usePanelLayoutStore.getState().layouts[KEY]?.groups[
        'group-legacy-arrangement'
      ];
    expect(group?.tabs.map((tab) => tab.panelId)).toEqual([
      'panel-legacy-files',
    ]);
    expect(isPanelLayoutPersistenceSuspended(KEY)).toBe(true);
    schedulePanelLayoutSave(KEY);
    await flushDebounce();
    expect(saveWorktreeLayout).not.toHaveBeenCalled();
    expect(loadBrowserState).not.toHaveBeenCalled();
    expect(saveBrowserState).not.toHaveBeenCalled();
  });

  it.each(['advanced', 'minimal'])(
    'does not add Browser recovery or suspend saving in %s mode',
    async (mode) => {
      jest.mocked(readRemoteControlContext).mockReturnValue({
        mode: 'remote',
        deviceId: 'remote-host',
        name: 'Host',
        platform: 'darwin',
      });
      loadWorktreeMode.mockResolvedValue({ mode });
      loadBrowserState.mockRejectedValue(
        new Error('This is not available while controlling another computer.'),
      );

      await ensureWorktreePanelLayout(KEY);

      const layout = usePanelLayoutStore.getState().layouts[KEY];
      expect(layout).toBeDefined();
      expect(
        Object.values(layout.groups)
          .flatMap((group) => group.tabs)
          .some((tab) => tab.kind === 'browser'),
      ).toBe(false);
      expect(isPanelLayoutPersistenceSuspended(KEY)).toBe(false);
      expect(loadBrowserState).not.toHaveBeenCalled();
      schedulePanelLayoutSave(KEY);
      await flushDebounce();
      expect(saveWorktreeLayout).toHaveBeenCalled();
      expect(saveBrowserState).not.toHaveBeenCalled();
    },
  );

  it("preserves the host's saved Browser binding without migrating its browser state", async () => {
    await ensureWorktreePanelLayout(KEY);
    const panels = usePanelLayoutStore.getState();
    panels.addTab(KEY, DEFAULT_CHAT_GROUP_ID, 'browser', {
      instance: { browserId: 'host-browser' },
    });
    const savedLayout = panels.serializeLayout(KEY);
    resetPanelLayoutPersistenceBridgeForTests();
    panels.disposeLayout(KEY);
    useBrowserStore.setState({ worktrees: {} });
    loadBrowserState.mockClear();
    jest.mocked(readRemoteControlContext).mockReturnValue({
      mode: 'remote',
      deviceId: 'remote-host',
      name: 'Host',
      platform: 'darwin',
    });
    loadWorktreeLayout.mockResolvedValue({ layout: savedLayout });
    loadBrowserState.mockRejectedValue(
      new Error('Browser is unavailable remotely.'),
    );

    await ensureWorktreePanelLayout(KEY);

    const browsers = Object.values(
      usePanelLayoutStore.getState().layouts[KEY]?.groups ?? {},
    )
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.kind === 'browser');
    expect(browsers).toHaveLength(1);
    expect(browsers[0].instance).toEqual({ browserId: 'host-browser' });
    expect(loadBrowserState).not.toHaveBeenCalled();
    expect(isPanelLayoutPersistenceSuspended(KEY)).toBe(false);
  });
});

describe('start page hydration gate', () => {
  it('opens only for a newly created layout, not a restored local layout', async () => {
    await ensureWorktreePanelLayout(KEY);
    expect(mockMaybeOpenStartPage).toHaveBeenLastCalledWith(
      KEY,
      expect.any(Number),
      true,
    );
    const savedLayout = usePanelLayoutStore.getState().serializeLayout(KEY);
    expect(savedLayout).not.toBeNull();

    resetPanelLayoutPersistenceBridgeForTests();
    usePanelLayoutStore.getState().disposeLayout(KEY);
    mockMaybeOpenStartPage.mockClear();
    loadWorktreeLayout.mockResolvedValue({ layout: savedLayout });

    await ensureWorktreePanelLayout(KEY);

    expect(mockMaybeOpenStartPage).toHaveBeenLastCalledWith(
      KEY,
      expect.any(Number),
      false,
    );
  });
});

describe('Minimal layout restore', () => {
  it('hydrates terminal sessions before reconciling persisted placement', async () => {
    loadWorktreeMode.mockResolvedValue({ mode: 'minimal' });
    loadTerminalState.mockResolvedValue({
      drawerCollapsed: false,
      groups: [
        {
          id: 'terminal-group-1',
          terminalIds: ['terminal-side'],
          focusedTerminalId: 'terminal-side',
          splitSizes: [1],
        },
      ],
      activeGroupId: 'terminal-group-1',
      nextGroupOrdinal: 2,
      groupOrdinals: { 'terminal-group-1': 1 },
      terminalCustomNames: {},
      groupCustomNames: {},
      terminals: [
        {
          session: {
            id: 'terminal-side',
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            shell: '/bin/zsh',
            shellBasename: 'zsh',
            cwd: '/tmp',
            createdAt: 1,
          },
          scrollbackLines: [],
          exitCode: null,
          signal: null,
        },
      ],
      liveTerminalIds: ['terminal-side'],
    });
    loadWorktreeLayout.mockResolvedValue({
      layout: {
        version: 1,
        grid: {
          orientation: 1,
          width: 1200,
          height: 800,
          root: {
            type: 'branch',
            size: 1200,
            children: [
              {
                type: 'leaf',
                groupId: 'group-chat',
                size: 800,
                panels: [],
                activePanelId: null,
              },
              {
                type: 'leaf',
                groupId: 'group-extras',
                size: 400,
                panels: [
                  {
                    panelId: 'panel-terminal-terminal-side',
                    kind: 'terminal',
                    instance: { terminalId: 'terminal-side' },
                  },
                ],
                activePanelId: 'panel-terminal-terminal-side',
              },
            ],
          },
        },
        activeGroupId: 'group-extras',
        mostRecentActiveGroupIds: ['group-chat', 'group-extras'],
      },
    });

    await ensureWorktreePanelLayout(KEY);

    expect(loadTerminalState).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    const sideGroup =
      usePanelLayoutStore.getState().layouts[KEY]?.groups['group-extras'];
    expect(sideGroup?.tabs.map((tab) => tab.panelId)).toContain(
      'panel-terminal-terminal-side',
    );
  });

  it('retains persisted chat-backed panels while the chat scope is unhydrated', async () => {
    loadWorktreeMode.mockResolvedValue({ mode: 'minimal' });
    expect(useChatStore.getState().worktreeChats[KEY]).toBeUndefined();
    loadWorktreeLayout.mockResolvedValue({
      layout: {
        version: 1,
        grid: {
          orientation: 1,
          width: 1200,
          height: 800,
          root: {
            type: 'leaf',
            groupId: DEFAULT_CHAT_GROUP_ID,
            size: 1200,
            panels: [
              {
                panelId: 'panel-chat-chat-1',
                kind: 'chat',
                instance: { chatTabId: 'chat-1' },
              },
              {
                panelId: 'panel-file-file-1',
                kind: 'file-diff',
                instance: {
                  fileTabId: 'file-1',
                  filePath: '/tmp/file-1.ts',
                },
              },
            ],
            activePanelId: 'panel-file-file-1',
          },
        },
        activeGroupId: DEFAULT_CHAT_GROUP_ID,
        mostRecentActiveGroupIds: [DEFAULT_CHAT_GROUP_ID],
      },
    });

    await ensureWorktreePanelLayout(KEY);

    const chatGroup =
      usePanelLayoutStore.getState().layouts[KEY]?.groups[
        DEFAULT_CHAT_GROUP_ID
      ];
    expect(chatGroup?.tabs.map((tab) => tab.panelId)).toEqual([
      'panel-chat-chat-1',
      'panel-file-file-1',
    ]);
    expect(chatGroup?.activePanelId).toBe('panel-file-file-1');
  });

  it('keeps a file in the Bottom Drawer when its live path was assigned after panel creation', async () => {
    loadWorktreeMode.mockResolvedValue({ mode: 'minimal' });
    const fileTab: ChatTab = {
      id: 'file-1',
      kind: 'file',
      title: 'assigned.ts',
      filePath: '/tmp/assigned.ts',
      messages: [],
      status: 'idle',
      error: null,
      createdAt: '2026-09-04T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'standard',
        fastMode: false,
      },
      fastModeExplicit: false,
      model: 'claude-sonnet-4-5-20250514',
      providerType: 'claude',
    };
    useChatStore.setState({
      worktreeChats: { [KEY]: { tabs: [fileTab], activeTabId: fileTab.id } },
    });
    loadWorktreeLayout.mockResolvedValue({
      layout: {
        version: 1,
        grid: {
          orientation: 1,
          width: 1200,
          height: 800,
          root: {
            type: 'leaf',
            groupId: DEFAULT_TERMINAL_GROUP_ID,
            size: 1200,
            panels: [
              {
                panelId: 'panel-file-file-1',
                kind: 'file-diff',
                instance: { fileTabId: 'file-1' },
              },
            ],
            activePanelId: 'panel-file-file-1',
          },
        },
        activeGroupId: DEFAULT_TERMINAL_GROUP_ID,
        mostRecentActiveGroupIds: [DEFAULT_TERMINAL_GROUP_ID],
      },
    });

    await ensureWorktreePanelLayout(KEY);

    const bottomTabs =
      usePanelLayoutStore.getState().layouts[KEY]?.groups[
        DEFAULT_TERMINAL_GROUP_ID
      ]?.tabs;
    expect(bottomTabs).toHaveLength(1);
    expect(bottomTabs?.[0]?.panelId).toBe('panel-file-file-1');
    expect(bottomTabs?.[0]?.instance?.fileTabId).toBe('file-1');
    expect(
      usePanelLayoutStore
        .getState()
        .layouts[
          KEY
        ]?.groups[DEFAULT_EXTRAS_GROUP_ID]?.tabs.some((tab) => tab.instance?.fileTabId === 'file-1'),
    ).toBe(false);
  });

  it('folds persisted popped-out panels into Minimal without duplicating identities', async () => {
    loadWorktreeMode.mockResolvedValue({ mode: 'minimal' });
    loadWorktreeLayout.mockResolvedValue({
      layout: {
        version: 1,
        grid: {
          orientation: 1,
          width: 1200,
          height: 800,
          root: {
            type: 'leaf',
            groupId: DEFAULT_EXTRAS_GROUP_ID,
            size: 1200,
            panels: [
              {
                panelId: 'panel-usage-main',
                kind: 'usage',
                instance: { variant: 'all' },
              },
            ],
            activePanelId: 'panel-usage-main',
          },
        },
        activeGroupId: DEFAULT_EXTRAS_GROUP_ID,
        mostRecentActiveGroupIds: [DEFAULT_EXTRAS_GROUP_ID],
        poppedOut: [
          {
            windowId: 'aux-window-usage',
            grid: {
              orientation: 1,
              width: 640,
              height: 480,
              root: {
                type: 'leaf',
                groupId: 'group-aux-usage',
                size: 640,
                panels: [
                  {
                    panelId: 'panel-usage-duplicate',
                    kind: 'usage',
                    instance: { variant: 'all' },
                  },
                  {
                    panelId: 'panel-automations-popped',
                    kind: 'automations',
                    instance: { variant: 'overview' },
                  },
                ],
                activePanelId: 'panel-automations-popped',
              },
            },
            bounds: { x: 10, y: 20, width: 640, height: 480 },
            sourceGroupId: 'group-custom-bottom',
            returnTarget: {
              anchorGroupId: DEFAULT_CHAT_GROUP_ID,
              direction: 'down',
              size: 240,
            },
          },
        ],
      },
    });

    await ensureWorktreePanelLayout(KEY);

    const layout = usePanelLayoutStore.getState().serializeLayout(KEY);
    expect(layout?.poppedOut).toBeUndefined();
    const serialized = JSON.stringify(layout);
    expect(serialized).toContain('panel-automations-popped');
    expect(serialized.match(/\"variant\":\"all\"/g)).toHaveLength(1);
    expect(
      usePanelLayoutStore
        .getState()
        .layouts[
          KEY
        ]?.groups[DEFAULT_TERMINAL_GROUP_ID]?.tabs.map((tab) => tab.panelId),
    ).toContain('panel-automations-popped');
  });
  it('folds a run bound in the main grid and a popped-out window into one tab', async () => {
    loadWorktreeMode.mockResolvedValue({ mode: 'minimal' });
    loadWorktreeLayout.mockResolvedValue({
      layout: {
        version: 1,
        grid: {
          orientation: 1,
          width: 1200,
          height: 800,
          root: {
            type: 'leaf',
            groupId: DEFAULT_EXTRAS_GROUP_ID,
            size: 1200,
            panels: [
              {
                panelId: 'panel-pipeline-run-1',
                kind: 'pipeline-execution',
                instance: { executionId: 'run-1' },
              },
            ],
            activePanelId: 'panel-pipeline-run-1',
          },
        },
        activeGroupId: DEFAULT_EXTRAS_GROUP_ID,
        mostRecentActiveGroupIds: [DEFAULT_EXTRAS_GROUP_ID],
        poppedOut: [
          {
            windowId: 'aux-window-runs',
            grid: {
              orientation: 1,
              width: 640,
              height: 480,
              root: {
                type: 'leaf',
                groupId: 'group-aux-runs',
                size: 640,
                panels: [
                  {
                    panelId: 'panel-aux-run-1',
                    kind: 'pipeline-execution',
                    instance: { executionId: 'run-1' },
                  },
                  {
                    panelId: 'panel-pipeline-run-2',
                    kind: 'pipeline-execution',
                    instance: { executionId: 'run-2' },
                  },
                ],
                activePanelId: 'panel-aux-run-1',
              },
            },
            bounds: { x: 10, y: 20, width: 640, height: 480 },
            sourceGroupId: DEFAULT_EXTRAS_GROUP_ID,
          },
        ],
      },
    });

    await ensureWorktreePanelLayout(KEY);

    const layout = usePanelLayoutStore.getState().serializeLayout(KEY);
    expect(layout?.poppedOut).toBeUndefined();
    const serialized = JSON.stringify(layout);
    // The main grid's binding wins; the window's duplicate is dropped, and
    // run panels (no live source) are retained rather than reconciled away.
    expect(serialized.match(/"executionId":"run-1"/g)).toHaveLength(1);
    expect(serialized).toContain('panel-pipeline-run-1');
    expect(serialized).not.toContain('panel-aux-run-1');
    expect(serialized).toContain('panel-pipeline-run-2');
  });

  it('retains one subagent chat per root/subagent pair when Minimal folds windows', async () => {
    loadWorktreeMode.mockResolvedValue({ mode: 'minimal' });
    loadWorktreeLayout.mockResolvedValue({
      layout: {
        version: 1,
        grid: {
          orientation: 1,
          width: 1200,
          height: 800,
          root: {
            type: 'leaf',
            groupId: DEFAULT_EXTRAS_GROUP_ID,
            size: 1200,
            panels: [
              {
                panelId: 'panel-subagent-main',
                kind: 'subagent-chat',
                instance: {
                  rootChatId: 'chat-1',
                  subagentId: 'agent-1',
                  subagentKind: 'managed',
                },
              },
            ],
            activePanelId: 'panel-subagent-main',
          },
        },
        activeGroupId: DEFAULT_EXTRAS_GROUP_ID,
        mostRecentActiveGroupIds: [DEFAULT_EXTRAS_GROUP_ID],
        poppedOut: [
          {
            windowId: 'aux-subagents',
            grid: {
              orientation: 1,
              width: 640,
              height: 480,
              root: {
                type: 'leaf',
                groupId: 'group-aux-subagents',
                size: 640,
                panels: [
                  {
                    panelId: 'panel-subagent-duplicate',
                    kind: 'subagent-chat',
                    instance: {
                      rootChatId: 'chat-1',
                      subagentId: 'agent-1',
                      subagentKind: 'managed',
                    },
                  },
                  {
                    panelId: 'panel-subagent-second',
                    kind: 'subagent-chat',
                    instance: {
                      rootChatId: 'chat-1',
                      subagentId: 'agent-2',
                      subagentKind: 'claude-native',
                    },
                  },
                ],
                activePanelId: 'panel-subagent-duplicate',
              },
            },
            bounds: { x: 10, y: 20, width: 640, height: 480 },
            sourceGroupId: DEFAULT_EXTRAS_GROUP_ID,
          },
        ],
      },
    });

    await ensureWorktreePanelLayout(KEY);

    const serialized = JSON.stringify(
      usePanelLayoutStore.getState().serializeLayout(KEY),
    );
    expect(serialized.match(/"subagentId":"agent-1"/g)).toHaveLength(1);
    expect(serialized).toContain('panel-subagent-main');
    expect(serialized).not.toContain('panel-subagent-duplicate');
    expect(serialized).toContain('panel-subagent-second');
  });
});

describe('worktree layout fork', () => {
  it('saves the live source grid with its bound tab order remapped', async () => {
    const restored = usePanelLayoutStore.getState().restoreLayout(KEY, {
      version: 1,
      grid: {
        root: {
          type: 'leaf',
          groupId: 'group-tabs',
          size: 1200,
          panels: [
            {
              panelId: 'panel-file-source-file',
              kind: 'file-diff',
              instance: {
                fileTabId: 'source-file',
                filePath: '/source/index.ts',
              },
            },
            {
              panelId: 'panel-chat-source-chat',
              kind: 'chat',
              instance: { chatTabId: 'source-chat' },
            },
          ],
          activePanelId: 'panel-file-source-file',
        },
        orientation: 1,
        width: 1200,
        height: 800,
      },
      activeGroupId: 'group-tabs',
      mostRecentActiveGroupIds: ['group-tabs'],
    });
    expect(restored).toBe(true);

    const copied = await forkWorktreePanelLayout({
      projectId: PROJECT_ID,
      sourceWorktreeId: WORKTREE_ID,
      destinationWorktreeId: 'worktree-2',
      tabBindings: new Map([
        [
          'source-file',
          {
            destinationTabId: 'destination-file',
            destinationFilePath: '/destination/index.ts',
          },
        ],
        ['source-chat', { destinationTabId: 'destination-chat' }],
      ]),
    });

    expect(copied).toBe(true);
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    const request = saveWorktreeLayout.mock.calls[0][0];
    expect(request).toEqual(
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: 'worktree-2',
      }),
    );
    const root = request.layout.grid.root;
    const leaf = root.type === 'leaf' ? root : root.children[0];
    expect(leaf?.type).toBe('leaf');
    if (!leaf || leaf.type !== 'leaf') return;
    expect(leaf.panels.map((panel) => panel.panelId)).toEqual([
      'panel-file-destination-file',
      'panel-chat-destination-chat',
    ]);
    expect(leaf.panels[0]?.instance?.filePath).toBe('/destination/index.ts');
    expect(leaf.activePanelId).toBe('panel-file-destination-file');
  });
});

/** Hydrates KEY (default layout), pops out the terminal group, and returns
 * the aux window id plus the fake child window. */
async function hydrateAndPopOut(child: FakeChildWindow): Promise<string> {
  await ensureWorktreePanelLayout(KEY);
  mockWindowOpen(child);
  const auxWindowId = usePanelWindowsStore
    .getState()
    .popOutGroup(KEY, DEFAULT_TERMINAL_GROUP_ID);
  expect(auxWindowId).not.toBeNull();
  if (auxWindowId === null) {
    throw new Error('pop-out failed');
  }
  return auxWindowId;
}

describe('poppedOut save path', () => {
  test('a pop-out saves the worktree file with a poppedOut snapshot (grid + bounds + source group)', async () => {
    const child = makeFakeChildWindow({
      x: 40,
      y: 50,
      width: 700,
      height: 450,
    });
    const auxWindowId = await hydrateAndPopOut(child);

    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    const request = saveWorktreeLayout.mock.calls[0][0];
    expect(request.projectId).toBe(PROJECT_ID);
    expect(request.worktreeId).toBe(WORKTREE_ID);

    // The main grid no longer contains the popped group…
    expect(JSON.stringify(request.layout.grid)).not.toContain(
      DEFAULT_TERMINAL_GROUP_ID,
    );
    // …and the poppedOut snapshot carries it, with live bounds + merge target.
    expect(request.layout.poppedOut).toHaveLength(1);
    const entry = request.layout.poppedOut?.[0];
    expect(entry?.windowId).toBe(auxWindowId);
    expect(entry?.sourceGroupId).toBe(DEFAULT_TERMINAL_GROUP_ID);
    expect(entry?.returnTarget?.anchorGroupId.length).toBeGreaterThan(0);
    expect(['up', 'down', 'left', 'right']).toContain(
      entry?.returnTarget?.direction,
    );
    expect(entry?.returnTarget?.size).toBeGreaterThan(0);
    expect(entry?.bounds).toEqual({ x: 40, y: 50, width: 700, height: 450 });
    expect(entry?.activeGroupId).toBe(DEFAULT_TERMINAL_GROUP_ID);
    expect(JSON.stringify(entry?.grid)).toContain(DEFAULT_TERMINAL_PANEL_ID);

    // The aux-inclusive file round-trips through the protocol validator.
    expect(migratePanelLayout(request.layout)).not.toBeNull();
  });

  test('aux-only layout changes fold into the owning worktree debounced save', async () => {
    const child = makeFakeChildWindow();
    const auxWindowId = await hydrateAndPopOut(child);
    await flushDebounce();
    saveWorktreeLayout.mockClear();

    // Mutate ONLY the aux layout (no worktree-layout commit). A second
    // terminal would violate singleton uniqueness, so add an entity-bound
    // chat tab instead.
    const { layoutKey } =
      usePanelWindowsStore.getState().auxWindows[auxWindowId];
    const added = usePanelLayoutStore
      .getState()
      .addTab(layoutKey, DEFAULT_TERMINAL_GROUP_ID, 'chat', {
        instance: { chatTabId: 'chat-aux' },
      });
    expect(added).not.toBeNull();
    expect(saveWorktreeLayout).not.toHaveBeenCalled();

    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    const request = saveWorktreeLayout.mock.calls[0][0];
    expect(request.projectId).toBe(PROJECT_ID);
    expect(request.worktreeId).toBe(WORKTREE_ID);
    const entry = request.layout.poppedOut?.[0];
    expect(entry?.windowId).toBe(auxWindowId);
    // The aux grid snapshot reflects the added second tab.
    expect(JSON.stringify(entry?.grid).match(/"panelId"/g)).toHaveLength(2);
  });

  test('a merge-back saves the worktree file without poppedOut', async () => {
    const child = makeFakeChildWindow();
    const auxWindowId = await hydrateAndPopOut(child);
    await flushDebounce();
    saveWorktreeLayout.mockClear();

    usePanelWindowsStore.getState().mergeBack(auxWindowId);
    await flushDebounce();

    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    const request = saveWorktreeLayout.mock.calls[0][0];
    expect(request.layout.poppedOut).toBeUndefined();
    expect(JSON.stringify(request.layout.grid)).toContain(
      DEFAULT_TERMINAL_PANEL_ID,
    );
  });
});

describe('New tab persistence', () => {
  test('never writes a New tab to the saved layout', async () => {
    await ensureWorktreePanelLayout(KEY);
    await flushDebounce();
    saveWorktreeLayout.mockClear();

    const groupId =
      usePanelLayoutStore.getState().layouts[KEY]?.viewModel.groups[0]?.groupId;
    expect(groupId).toBeDefined();
    const added = usePanelLayoutStore
      .getState()
      .addTab(KEY, groupId ?? '', 'new-tab', {
        instance: { newTabId: 'new-1' },
        title: 'New tab',
      });
    expect(added).not.toBeNull();

    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    const request = saveWorktreeLayout.mock.calls[0][0];
    expect(JSON.stringify(request.layout)).not.toContain('new-tab');
    expect(JSON.stringify(request.layout)).not.toContain(added ?? 'missing');
    expect(migratePanelLayout(request.layout)).not.toBeNull();
  });
});

describe('poppedOut restore path', () => {
  /**
   * An instance-compliant persisted layout mirroring the default arrangement.
   * The DEFAULT layout still seeds a legacy instance-less chat tab, which the
   * layout store's restore now rejects (the legacy-layout fallback trigger),
   * so round-trip coverage hydrates from a compliant file: chat tabs carry
   * their `chatTabId` binding the way sync-bridge-materialized tabs do.
   */
  const COMPLIANT_PERSISTED_LAYOUT = {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        children: [
          {
            type: 'leaf',
            groupId: DEFAULT_CHAT_GROUP_ID,
            panels: [
              {
                panelId: 'panel-chat',
                kind: 'chat',
                instance: { chatTabId: 'chat-1' },
              },
            ],
            activePanelId: 'panel-chat',
            size: 600,
          },
          {
            type: 'leaf',
            groupId: DEFAULT_TERMINAL_GROUP_ID,
            panels: [{ panelId: DEFAULT_TERMINAL_PANEL_ID, kind: 'terminal' }],
            activePanelId: DEFAULT_TERMINAL_PANEL_ID,
            size: 600,
          },
        ],
        size: 800,
      },
      orientation: 1,
      width: 1200,
      height: 800,
    },
    activeGroupId: DEFAULT_CHAT_GROUP_ID,
    mostRecentActiveGroupIds: [
      DEFAULT_CHAT_GROUP_ID,
      DEFAULT_TERMINAL_GROUP_ID,
    ],
  };

  /** Runs launch 1 (restore → pop out → save) and returns the saved file. */
  async function captureSavedFileWithPoppedOut(): Promise<unknown> {
    const child = makeFakeChildWindow({
      x: 10,
      y: 20,
      width: 640,
      height: 480,
    });
    loadWorktreeLayout.mockResolvedValue({
      layout: COMPLIANT_PERSISTED_LAYOUT,
    });
    await hydrateAndPopOut(child);
    await flushDebounce();
    const request = saveWorktreeLayout.mock.calls[0][0];

    // Simulate app shutdown: reset bridge/module state and all stores.
    resetPanelLayoutPersistenceBridgeForTests();
    usePanelWindowsStore.setState({ auxWindows: {} });
    const store = usePanelLayoutStore.getState();
    for (const key of Object.keys(store.layouts)) {
      store.disposeLayout(key);
    }
    jest.restoreAllMocks();
    saveWorktreeLayout.mockClear();
    return request.layout;
  }

  test('relaunch restore re-creates the aux window and its layout (round-trip)', async () => {
    const savedLayout = await captureSavedFileWithPoppedOut();

    loadWorktreeLayout.mockResolvedValue({ layout: savedLayout });
    const restoredChild = makeFakeChildWindow();
    const openCapture = mockWindowOpen(restoredChild);

    await ensureWorktreePanelLayout(KEY);

    // The aux window re-opened at the persisted bounds…
    expect(openCapture.calls).toHaveLength(1);
    expect(openCapture.calls[0].features).toBe(
      'left=10,top=20,width=640,height=480',
    );
    // …with the record re-registered (no startup focus steal)…
    const records = Object.values(usePanelWindowsStore.getState().auxWindows);
    expect(records).toHaveLength(1);
    expect(records[0].worktreeKey).toBe(KEY);
    expect(records[0].sourceGroupId).toBe(DEFAULT_TERMINAL_GROUP_ID);
    expect(records[0].focusOnOpen).toBe(false);
    // …and the aux layout rebuilt around the persisted terminal group.
    const auxViewModel = getPanelLayoutViewModel(records[0].layoutKey);
    expect(auxViewModel?.groups.map((group) => group.groupId)).toEqual([
      DEFAULT_TERMINAL_GROUP_ID,
    ]);
    // The main layout does NOT contain the popped-out group.
    expect(
      getPanelLayoutViewModel(KEY)?.groups.map((group) => group.groupId),
    ).not.toContain(DEFAULT_TERMINAL_GROUP_ID);

    // Hydration (restore commits) must not echo a save.
    await flushDebounce();
    expect(saveWorktreeLayout).not.toHaveBeenCalled();
  });

  test('a blocked re-open merges the persisted tabs into the main layout and persists that', async () => {
    const savedLayout = await captureSavedFileWithPoppedOut();

    loadWorktreeLayout.mockResolvedValue({ layout: savedLayout });
    mockWindowOpen(null);

    await ensureWorktreePanelLayout(KEY);

    // No aux window; the tabs landed back in the worktree layout.
    expect(
      Object.keys(usePanelWindowsStore.getState().auxWindows),
    ).toHaveLength(0);
    const viewModel = getPanelLayoutViewModel(KEY);
    const allPanelIds = viewModel?.groups.flatMap((group) =>
      group.tabs.map((tab) => tab.panelId),
    );
    expect(allPanelIds).toContain(DEFAULT_TERMINAL_PANEL_ID);

    // The merge-back is saved so the file stops claiming a popped-out window.
    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    const request = saveWorktreeLayout.mock.calls[0][0];
    expect(request.layout.poppedOut).toBeUndefined();
    expect(JSON.stringify(request.layout.grid)).toContain(
      DEFAULT_TERMINAL_PANEL_ID,
    );
  });
  test('relaunch keeps the rest of the layout when a run tab is malformed or duplicated in a window', async () => {
    loadWorktreeLayout.mockResolvedValue({
      layout: {
        version: 1,
        grid: {
          root: {
            type: 'branch',
            size: 800,
            children: [
              {
                type: 'leaf',
                groupId: DEFAULT_CHAT_GROUP_ID,
                panels: [
                  {
                    panelId: 'panel-chat',
                    kind: 'chat',
                    instance: { chatTabId: 'chat-1' },
                  },
                  // Hand-edited: a run tab with no binding.
                  { panelId: 'panel-unbound-run', kind: 'pipeline-execution' },
                ],
                activePanelId: 'panel-unbound-run',
                size: 600,
              },
              {
                type: 'leaf',
                groupId: 'group-runs',
                panels: [
                  {
                    panelId: 'panel-pipeline-run-1',
                    kind: 'pipeline-execution',
                    instance: { executionId: 'run-1' },
                  },
                ],
                activePanelId: 'panel-pipeline-run-1',
                size: 600,
              },
            ],
          },
          orientation: 1,
          width: 1200,
          height: 800,
        },
        activeGroupId: DEFAULT_CHAT_GROUP_ID,
        mostRecentActiveGroupIds: [DEFAULT_CHAT_GROUP_ID, 'group-runs'],
        poppedOut: [
          {
            windowId: 'aux-window-runs',
            grid: {
              root: {
                type: 'leaf',
                groupId: 'group-aux-runs',
                panels: [
                  {
                    panelId: 'panel-aux-run-1',
                    kind: 'pipeline-execution',
                    instance: { executionId: 'run-1' },
                  },
                  {
                    panelId: 'panel-pipeline-run-2',
                    kind: 'pipeline-execution',
                    instance: { executionId: 'run-2' },
                  },
                ],
                activePanelId: 'panel-aux-run-1',
                size: 640,
              },
              orientation: 1,
              width: 640,
              height: 480,
            },
            bounds: { x: 10, y: 20, width: 640, height: 480 },
            sourceGroupId: 'group-runs',
          },
        ],
      },
    });
    mockWindowOpen(makeFakeChildWindow());

    await ensureWorktreePanelLayout(KEY);

    // The file was restored, not replaced by the default layout.
    const main = usePanelLayoutStore.getState().layouts[KEY];
    expect(
      main?.groups[DEFAULT_CHAT_GROUP_ID]?.tabs.map((tab) => tab.panelId),
    ).toEqual(['panel-chat']);
    expect(main?.groups[DEFAULT_CHAT_GROUP_ID]?.activePanelId).toBe(
      'panel-chat',
    );
    expect(main?.groups['group-runs']?.tabs.map((tab) => tab.panelId)).toEqual([
      'panel-pipeline-run-1',
    ]);
    // The window reopened with only the run the main grid did not bind.
    const records = Object.values(usePanelWindowsStore.getState().auxWindows);
    expect(records).toHaveLength(1);
    const auxLayout =
      usePanelLayoutStore.getState().layouts[records[0]?.layoutKey ?? ''];
    expect(
      auxLayout?.groups['group-aux-runs']?.tabs.map((tab) => tab.panelId),
    ).toEqual(['panel-pipeline-run-2']);
  });
});

describe('plan panel pruning on restore', () => {
  const PLAN_GROUP_ID = 'group-plans';

  function planLeaf(
    groupId: string,
    panels: ReadonlyArray<Record<string, unknown>>,
    size: number,
  ): Record<string, unknown> {
    return {
      type: 'leaf',
      groupId,
      panels,
      activePanelId: panels[0]?.panelId ?? null,
      size,
    };
  }

  /** Invalid + duplicate plan entries in the main grid and popped-out windows. */
  const LAYOUT_WITH_BAD_PLAN_ENTRIES = {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        children: [
          planLeaf(
            DEFAULT_CHAT_GROUP_ID,
            [
              {
                panelId: 'panel-chat',
                kind: 'chat',
                instance: { chatTabId: 'chat-1' },
              },
            ],
            500,
          ),
          planLeaf(
            PLAN_GROUP_ID,
            [
              { panelId: 'panel-plan-unbound', kind: 'plan' },
              {
                panelId: 'panel-plan-1',
                kind: 'plan',
                title: 'Plan one',
                instance: { planId: 'plan-1' },
              },
              {
                panelId: 'panel-plan-1-dup',
                kind: 'plan',
                instance: { planId: 'plan-1' },
              },
            ],
            400,
          ),
          planLeaf(
            DEFAULT_TERMINAL_GROUP_ID,
            [{ panelId: DEFAULT_TERMINAL_PANEL_ID, kind: 'terminal' }],
            300,
          ),
        ],
        size: 800,
      },
      orientation: 1,
      width: 1200,
      height: 800,
    },
    activeGroupId: DEFAULT_CHAT_GROUP_ID,
    mostRecentActiveGroupIds: [
      DEFAULT_CHAT_GROUP_ID,
      PLAN_GROUP_ID,
      DEFAULT_TERMINAL_GROUP_ID,
    ],
    poppedOut: [
      {
        // Only a duplicate of the main-grid plan panel: pruned away entirely.
        windowId: 'aux-duplicate-only',
        grid: {
          root: planLeaf(
            'group-aux-duplicate',
            [
              {
                panelId: 'panel-aux-plan-dup',
                kind: 'plan',
                instance: { planId: 'plan-1' },
              },
            ],
            600,
          ),
          orientation: 0,
          width: 640,
          height: 480,
        },
        bounds: { x: 10, y: 20, width: 640, height: 480 },
        sourceGroupId: PLAN_GROUP_ID,
      },
      {
        // Keeps its diagram (a different kind for the same plan).
        windowId: 'aux-diagram',
        grid: {
          root: planLeaf(
            'group-aux-diagram',
            [
              {
                panelId: 'panel-aux-diagram',
                kind: 'plan-diagram',
                instance: { planId: 'plan-1' },
              },
              {
                panelId: 'panel-aux-diagram-dup',
                kind: 'plan-diagram',
                instance: { planId: 'plan-1' },
              },
            ],
            600,
          ),
          orientation: 0,
          width: 640,
          height: 480,
        },
        bounds: { x: 30, y: 40, width: 640, height: 480 },
        sourceGroupId: PLAN_GROUP_ID,
      },
    ],
  };

  function familyPanelIds(): string[] {
    const layouts = usePanelLayoutStore.getState().layouts;
    return Object.keys(layouts).flatMap((layoutKey) =>
      (getPanelLayoutViewModel(layoutKey)?.groups ?? []).flatMap((group) =>
        group.tabs.map((tab) => tab.panelId),
      ),
    );
  }

  test('the unpruned file is rejected by restoreLayout as a whole', () => {
    expect(migratePanelLayout(LAYOUT_WITH_BAD_PLAN_ENTRIES)).not.toBeNull();
    expect(
      usePanelLayoutStore
        .getState()
        .restoreLayout(
          makeWorktreePanelKey(PROJECT_ID, 'worktree-unpruned'),
          LAYOUT_WITH_BAD_PLAN_ENTRIES,
        ),
    ).toBe(false);
  });

  test('restores unrelated groups and geometry with one panel per plan per kind', async () => {
    loadWorktreeLayout.mockResolvedValue({
      layout: LAYOUT_WITH_BAD_PLAN_ENTRIES,
    });
    const openCapture = mockWindowOpen(makeFakeChildWindow());

    await ensureWorktreePanelLayout(KEY);

    // The persisted main grid survived (not the default layout).
    const viewModel = getPanelLayoutViewModel(KEY);
    expect(viewModel?.groups.map((group) => group.groupId)).toEqual([
      DEFAULT_CHAT_GROUP_ID,
      PLAN_GROUP_ID,
      DEFAULT_TERMINAL_GROUP_ID,
    ]);
    const planGroup = viewModel?.groups.find(
      (group) => group.groupId === PLAN_GROUP_ID,
    );
    expect(planGroup?.tabs.map((tab) => tab.panelId)).toEqual(['panel-plan-1']);
    expect(planGroup?.activePanelId).toBe('panel-plan-1');
    expect(planGroup?.tabs[0]?.title).toBe('Plan one');

    // Only the window that still holds a panel re-opened.
    expect(openCapture.calls).toHaveLength(1);
    expect(openCapture.calls[0].features).toBe(
      'left=30,top=40,width=640,height=480',
    );
    const records = Object.values(usePanelWindowsStore.getState().auxWindows);
    expect(records).toHaveLength(1);
    expect(
      getPanelLayoutViewModel(records[0].layoutKey)?.groups.flatMap((group) =>
        group.tabs.map((tab) => tab.panelId),
      ),
    ).toEqual(['panel-aux-diagram']);

    // Exactly one document and one diagram panel for the plan family-wide.
    expect(familyPanelIds().sort()).toEqual(
      [
        'panel-chat',
        'panel-plan-1',
        DEFAULT_TERMINAL_PANEL_ID,
        'panel-aux-diagram',
      ].sort(),
    );
  });
});

/**
 * Review finding (PR #4198): `migratePanelLayout` runs the protocol entry
 * validator FIRST, which rejects a shape-invalid plan `instance` (a
 * non-string value, an over-length string, a non-object `instance`) by
 * returning `null` for the WHOLE FILE — so the post-migration
 * `pruneInvalidBoundPanelEntries` call at the end of the try block never
 * runs, and one damaged plan entry resets a user's entire saved layout
 * (worktree file) or saved default template. `sanitizeRawPlanPanelBindings`
 * closes the gap by running on the raw parsed JSON BEFORE
 * `migratePanelLayout`, so only the bad plan entry is lost.
 */
describe('raw plan sanitization before migration (prune malformed plan bindings pre-migration)', () => {
  const PLAN_GROUP_ID = 'group-plans-raw';
  const GOOD_PLAN_PANEL = {
    panelId: 'panel-plan-good',
    kind: 'plan',
    instance: { planId: 'plan-good' },
  };

  function chatLeaf(): Record<string, unknown> {
    return {
      type: 'leaf',
      groupId: DEFAULT_CHAT_GROUP_ID,
      panels: [
        {
          panelId: 'panel-chat',
          kind: 'chat',
          instance: { chatTabId: 'chat-1' },
        },
      ],
      activePanelId: 'panel-chat',
      size: 800,
    };
  }

  function planLeaf(
    panels: ReadonlyArray<Record<string, unknown>>,
  ): Record<string, unknown> {
    return {
      type: 'leaf',
      groupId: PLAN_GROUP_ID,
      panels,
      activePanelId: panels[0]?.panelId ?? null,
      size: 400,
    };
  }

  /**
   * A worktree/default layout with one good chat group and a plan group
   * holding the bad panel FIRST (so it starts as the active tab) plus a good
   * plan panel — proving both that the bad entry is dropped and that
   * `activePanelId` is re-pointed at the survivor.
   */
  function layoutWithBadPlanPanel(
    badPanel: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      version: 1,
      grid: {
        root: {
          type: 'branch',
          size: 1200,
          children: [chatLeaf(), planLeaf([badPanel, GOOD_PLAN_PANEL])],
        },
        orientation: 1,
        width: 1200,
        height: 800,
      },
      activeGroupId: DEFAULT_CHAT_GROUP_ID,
      mostRecentActiveGroupIds: [DEFAULT_CHAT_GROUP_ID, PLAN_GROUP_ID],
    };
  }

  const MALFORMED_PLAN_CASES: ReadonlyArray<[string, Record<string, unknown>]> =
    [
      [
        'a non-string planId (instance: { planId: 42 })',
        {
          panelId: 'panel-plan-bad-numeric',
          kind: 'plan',
          instance: { planId: 42 },
        },
      ],
      [
        'an over-length planId string',
        {
          panelId: 'panel-plan-diagram-bad-overlong',
          kind: 'plan-diagram',
          instance: {
            planId: 'p'.repeat(PANEL_INSTANCE_VALUE_MAX_LENGTH + 1),
          },
        },
      ],
      [
        'a non-object instance',
        {
          panelId: 'panel-plan-bad-non-object',
          kind: 'plan',
          instance: 'plan-1',
        },
      ],
    ];

  describe.each(MALFORMED_PLAN_CASES)('%s', (_label, badPanel) => {
    test('worktree load path: prunes the bad plan entry instead of discarding the whole layout', async () => {
      const raw = layoutWithBadPlanPanel(badPanel);
      // Confirms this is genuinely the whole-file-rejection case the finding
      // describes, not something `migratePanelLayout` already tolerates.
      expect(migratePanelLayout(raw)).toBeNull();
      loadWorktreeLayout.mockResolvedValue({ layout: raw });

      await ensureWorktreePanelLayout(KEY);

      const viewModel = getPanelLayoutViewModel(KEY);
      const groupIds = viewModel?.groups.map((group) => group.groupId) ?? [];
      // The persisted grid survived — not the hardcoded default (which never
      // has a `group-plans-raw` group).
      expect(groupIds).toContain(PLAN_GROUP_ID);
      const chatGroup = viewModel?.groups.find(
        (group) => group.groupId === DEFAULT_CHAT_GROUP_ID,
      );
      expect(chatGroup?.tabs.map((tab) => tab.panelId)).toEqual(['panel-chat']);
      const planGroup = viewModel?.groups.find(
        (group) => group.groupId === PLAN_GROUP_ID,
      );
      expect(planGroup?.tabs.map((tab) => tab.panelId)).toEqual([
        'panel-plan-good',
      ]);
      // The dropped panel was active; the survivor takes over.
      expect(planGroup?.activePanelId).toBe('panel-plan-good');
    });

    test('saved-default path: prunes the bad plan entry instead of falling back to the hardcoded default', async () => {
      const raw = layoutWithBadPlanPanel(badPanel);
      expect(migratePanelLayout(raw)).toBeNull();
      loadWorktreeLayout.mockResolvedValue({ layout: null });
      loadDefaultLayout.mockResolvedValue({ layout: raw });

      await ensureWorktreePanelLayout(KEY);

      const layout = usePanelLayoutStore.getState().serializeLayout(KEY);
      expect(layout).not.toBeNull();
      // The retargeted saved default was applied (carries the plan group);
      // the hardcoded 3-group default (which has a terminal group) was not.
      expect(JSON.stringify(layout)).toContain(PLAN_GROUP_ID);
      expect(JSON.stringify(layout)).not.toContain(DEFAULT_TERMINAL_GROUP_ID);
      const viewModel = getPanelLayoutViewModel(KEY);
      const planGroup = viewModel?.groups.find(
        (group) => group.groupId === PLAN_GROUP_ID,
      );
      expect(planGroup?.tabs.map((tab) => tab.panelId)).toEqual([
        'panel-plan-good',
      ]);
    });
  });

  test('control: a malformed NON-plan entry still discards the whole layout (unchanged by the fix)', async () => {
    const badChatPanel = {
      panelId: 'panel-chat-bad',
      kind: 'chat',
      instance: { chatTabId: 42 },
    };
    const raw = {
      version: 1,
      grid: {
        root: {
          type: 'branch',
          size: 1200,
          children: [
            planLeaf([GOOD_PLAN_PANEL]),
            {
              type: 'leaf',
              groupId: 'group-bad-chat',
              panels: [badChatPanel],
              activePanelId: 'panel-chat-bad',
              size: 800,
            },
          ],
        },
        orientation: 1,
        width: 1200,
        height: 800,
      },
      activeGroupId: PLAN_GROUP_ID,
      mostRecentActiveGroupIds: [PLAN_GROUP_ID, 'group-bad-chat'],
    };
    expect(migratePanelLayout(raw)).toBeNull();
    loadWorktreeLayout.mockResolvedValue({ layout: raw });

    await ensureWorktreePanelLayout(KEY);

    // Still falls back to the hardcoded default entirely: only plan /
    // plan-diagram entries are sanitized pre-migration, so an unrelated
    // malformed (non-plan) entry still fails migration exactly as before.
    const viewModel = getPanelLayoutViewModel(KEY);
    const groupIds = viewModel?.groups.map((group) => group.groupId) ?? [];
    expect(groupIds).not.toContain(PLAN_GROUP_ID);
  });
});

describe('aux window bounds watch', () => {
  test('a bounds-only change schedules exactly one debounced save carrying the new bounds', async () => {
    const child = makeFakeChildWindow({
      x: 40,
      y: 50,
      width: 700,
      height: 450,
    });
    await hydrateAndPopOut(child);
    await flushDebounce();
    saveWorktreeLayout.mockClear();

    // The watcher AuxPanelWindow drives from its close-poll/resize wiring.
    const watcher = createAuxWindowBoundsWatcher(child, KEY);

    // Unchanged bounds: ticks schedule nothing.
    watcher.check();
    watcher.check();
    await flushDebounce();
    expect(saveWorktreeLayout).not.toHaveBeenCalled();

    // The OS window moved and resized; the next ticks schedule ONE save.
    child.screenX = 200;
    child.outerWidth = 640;
    watcher.check();
    expect(saveWorktreeLayout).not.toHaveBeenCalled(); // still debounced
    watcher.check(); // same bounds again inside the debounce — no double save
    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    const entry = saveWorktreeLayout.mock.calls[0][0].layout.poppedOut?.[0];
    expect(entry?.bounds).toEqual({ x: 200, y: 50, width: 640, height: 450 });

    // No further change → no further save.
    watcher.check();
    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
  });

  test('a closed child window and an unhydrated key schedule nothing', async () => {
    const child = makeFakeChildWindow();
    await hydrateAndPopOut(child);
    await flushDebounce();
    saveWorktreeLayout.mockClear();

    // Unhydrated key: the schedule seam is gated on hydration.
    const foreign = createAuxWindowBoundsWatcher(
      makeFakeChildWindow(),
      'project-none/worktree-none',
    );
    foreign.check();

    // Closed window: the bounds read yields null; close detection owns this.
    const watcher = createAuxWindowBoundsWatcher(child, KEY);
    child.screenX = 999;
    child.closed = true;
    watcher.check();

    await flushDebounce();
    expect(saveWorktreeLayout).not.toHaveBeenCalled();
  });
});

describe('teardown flush', () => {
  test('pagehide flushes a pending debounced save immediately and consumes the timer', async () => {
    await ensureWorktreePanelLayout(KEY);
    usePanelLayoutStore.getState().focusGroup(KEY, DEFAULT_CHAT_GROUP_ID);
    usePanelLayoutStore.getState().focusGroup(KEY, DEFAULT_TERMINAL_GROUP_ID);
    expect(saveWorktreeLayout).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pagehide'));

    // Flushed synchronously, without waiting out the 500ms debounce…
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    expect(saveWorktreeLayout.mock.calls[0][0].projectId).toBe(PROJECT_ID);
    expect(saveWorktreeLayout.mock.calls[0][0].worktreeId).toBe(WORKTREE_ID);

    // …and the pending timer was consumed: the debounce elapsing later must
    // not double-save.
    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
  });

  test('pagehide with nothing pending saves nothing', async () => {
    await ensureWorktreePanelLayout(KEY);
    await flushDebounce();
    saveWorktreeLayout.mockClear();

    window.dispatchEvent(new Event('pagehide'));
    expect(saveWorktreeLayout).not.toHaveBeenCalled();
  });
});

describe('non-popped saves', () => {
  test('entry creation flushes layout customization before the debounce expires', async () => {
    await ensureWorktreePanelLayout(KEY);
    usePanelLayoutStore.getState().expandGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID);
    expect(saveWorktreeLayout).not.toHaveBeenCalled();
    await flushPanelLayoutSavesForProject(PROJECT_ID);
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    expect(saveWorktreeLayout.mock.calls[0][0].hasUserChanges).toBe(true);
    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
  });

  test('a per-worktree flush resolves only after the save round-trips', async () => {
    await ensureWorktreePanelLayout(KEY);
    let resolveSave: () => void = () => undefined;
    saveWorktreeLayout.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );
    usePanelLayoutStore.getState().expandGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID);

    let settled = false;
    const flushed = flushPanelLayoutSaveForWorktree(KEY).then(() => {
      settled = true;
    });
    // The save is issued synchronously, before the debounce expires.
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSave();
    await flushed;
    expect(settled).toBe(true);
    saveWorktreeLayout.mockResolvedValue(undefined);
    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
  });

  test('a per-worktree flush leaves other worktrees pending and saves nothing when idle', async () => {
    await ensureWorktreePanelLayout(KEY);
    usePanelLayoutStore.getState().expandGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID);

    await flushPanelLayoutSaveForWorktree('other-project/other-worktree');
    expect(saveWorktreeLayout).not.toHaveBeenCalled();

    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    await flushPanelLayoutSaveForWorktree(KEY);
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
  });

  test('entry creation fails when an in-flight layout save fails', async () => {
    await ensureWorktreePanelLayout(KEY);
    let rejectSave: (reason: Error) => void = () => undefined;
    saveWorktreeLayout.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectSave = reject;
      }),
    );
    usePanelLayoutStore.getState().expandGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID);
    await flushDebounce();
    const failed = expect(
      flushPanelLayoutSavesForProject(PROJECT_ID),
    ).rejects.toThrow('Cannot persist layout');
    rejectSave(new Error('Cannot persist layout'));
    await failed;
    saveWorktreeLayout.mockResolvedValue(undefined);
    await flushPanelLayoutSavesForProject(PROJECT_ID);
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(2);
  });

  test('automatic layout saves do not customize an untouched entry', async () => {
    await ensureWorktreePanelLayout(KEY);
    schedulePanelLayoutSave(KEY, { userInitiated: false });
    await flushPanelLayoutSavesForProject(PROJECT_ID);
    expect(saveWorktreeLayout.mock.calls.at(-1)?.[0].hasUserChanges).toBe(
      false,
    );
  });

  test('a plain worktree layout saves without a poppedOut section', async () => {
    await ensureWorktreePanelLayout(KEY);
    usePanelLayoutStore.getState().focusGroup(KEY, DEFAULT_CHAT_GROUP_ID);
    usePanelLayoutStore.getState().focusGroup(KEY, DEFAULT_TERMINAL_GROUP_ID);

    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    expect(saveWorktreeLayout.mock.calls[0][0].hasUserChanges).toBe(false);
    expect(
      saveWorktreeLayout.mock.calls[0][0].layout.poppedOut,
    ).toBeUndefined();
  });

  test('container size changes schedule a save with updated grid dimensions', async () => {
    await ensureWorktreePanelLayout(KEY);
    await flushDebounce();
    saveWorktreeLayout.mockClear();

    const before = usePanelLayoutStore.getState().serializeLayout(KEY);
    expect(before).not.toBeNull();
    if (before === null) {
      throw new Error('expected default layout to serialize');
    }

    usePanelLayoutStore
      .getState()
      .layoutContainer(KEY, before.grid.width + 160, before.grid.height + 90);

    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    expect(saveWorktreeLayout.mock.calls[0][0].hasUserChanges).toBe(false);
    expect(saveWorktreeLayout.mock.calls[0][0].layout.grid.width).toBe(
      before.grid.width + 160,
    );
    expect(saveWorktreeLayout.mock.calls[0][0].layout.grid.height).toBe(
      before.grid.height + 90,
    );

    saveWorktreeLayout.mockClear();
    usePanelLayoutStore
      .getState()
      .layoutContainer(KEY, before.grid.width + 160, before.grid.height + 90);

    await flushDebounce();
    expect(saveWorktreeLayout).not.toHaveBeenCalled();
  });

  test('size-only resize and arrange operations schedule debounced saves', async () => {
    await ensureWorktreePanelLayout(KEY);
    // The default layout seeds BOTH the activity rail and the terminal
    // collapsed (CAN-2836), and a collapsed group is pinned to the collapsed
    // bar size on its axis — so in the pristine default every sibling resize
    // is refused and nothing would be left for this test to save. Expand the
    // rail to get a resizable horizontal split back.
    usePanelLayoutStore.getState().expandGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID);
    await flushDebounce();
    saveWorktreeLayout.mockClear();

    usePanelLayoutStore
      .getState()
      .resizeGroup(KEY, DEFAULT_CHAT_GROUP_ID, { width: 360, height: 420 });
    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    expect(saveWorktreeLayout.mock.calls[0][0].hasUserChanges).toBe(true);
    expect(
      migratePanelLayout(saveWorktreeLayout.mock.calls[0][0].layout),
    ).not.toBeNull();

    saveWorktreeLayout.mockClear();
    usePanelLayoutStore.getState().arrangeGroups(KEY, 'even');
    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    expect(saveWorktreeLayout.mock.calls[0][0].hasUserChanges).toBe(true);
    expect(
      migratePanelLayout(saveWorktreeLayout.mock.calls[0][0].layout),
    ).not.toBeNull();
  });

  test('aux size-only changes fold into the owning worktree save', async () => {
    const child = makeFakeChildWindow();
    const auxWindowId = await hydrateAndPopOut(child);
    await flushDebounce();
    saveWorktreeLayout.mockClear();

    const { layoutKey } =
      usePanelWindowsStore.getState().auxWindows[auxWindowId];
    const before = usePanelLayoutStore.getState().serializeLayout(layoutKey);
    expect(before).not.toBeNull();
    if (before === null) {
      throw new Error('expected aux layout to serialize');
    }

    usePanelLayoutStore
      .getState()
      .layoutContainer(
        layoutKey,
        before.grid.width + 80,
        before.grid.height + 40,
      );

    await flushDebounce();
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    const entry = saveWorktreeLayout.mock.calls[0][0].layout.poppedOut?.[0];
    expect(entry?.grid.width).toBe(before.grid.width + 80);
    expect(entry?.grid.height).toBe(before.grid.height + 40);
  });
});

describe('reset to default', () => {
  test('closes terminal and browser resources the default layout omits', async () => {
    const { closeOmittedTerminalBinding } = jest.requireMock<{
      closeOmittedTerminalBinding: jest.Mock;
    }>('@/lib/panels/terminal-panel-sync');
    const { requestBrowserSessionDestruction } = jest.requireMock<{
      requestBrowserSessionDestruction: jest.Mock;
    }>('@/lib/panels/browser-panel-sync');
    await ensureWorktreePanelLayout(KEY);
    const layoutStore = usePanelLayoutStore.getState();
    layoutStore.addTab(KEY, DEFAULT_CHAT_GROUP_ID, 'terminal', {
      instance: { terminalId: 'pty-orphan' },
    });
    layoutStore.addTab(KEY, DEFAULT_CHAT_GROUP_ID, 'browser', {
      instance: { browserId: 'browser-orphan' },
    });

    loadDefaultLayout.mockResolvedValue({ layout: null });
    await expect(resetLayoutToDefault(KEY)).resolves.toBe(true);

    // The incremental sweeps treat the disposed family as transient
    // teardown, so the reset must close omitted resources itself.
    expect(closeOmittedTerminalBinding).toHaveBeenCalledWith(KEY, 'pty-orphan');
    expect(requestBrowserSessionDestruction).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'browser-orphan',
    );
  });

  test('refuses while persistence is suspended (migration recovery)', async () => {
    await ensureWorktreePanelLayout(KEY);
    const before = usePanelLayoutStore.getState().layouts[KEY];
    suspendPanelLayoutPersistence(KEY);

    // A suspended layout holds a non-persistable recovery panel and its save
    // path is a no-op, so a "successful" reset would silently never reach
    // disk and drop the recovery affordance for the session.
    await expect(resetLayoutToDefault(KEY)).resolves.toBe(false);
    expect(usePanelLayoutStore.getState().layouts[KEY]).toBe(before);
  });

  test('closes popped-out aux windows so the post-reset save cannot resurrect them', async () => {
    const child = makeFakeChildWindow({
      x: 40,
      y: 50,
      width: 700,
      height: 450,
    });
    const auxWindowId = await hydrateAndPopOut(child);
    expect(
      usePanelWindowsStore.getState().auxWindows[auxWindowId],
    ).toBeDefined();

    loadDefaultLayout.mockResolvedValue({ layout: null });
    const reset = await resetLayoutToDefault(KEY);
    expect(reset).toBe(true);

    // The aux record is gone and its OS window closed BEFORE the rebuild —
    // the post-reset save snapshots every still-open aux window back into
    // the persisted file, so a surviving window would resurrect its entry
    // (and itself) inside the pristine default layout.
    expect(
      usePanelWindowsStore.getState().auxWindows[auxWindowId],
    ).toBeUndefined();
    expect(child.closed).toBe(true);

    await flushDebounce();
    const { calls } = saveWorktreeLayout.mock;
    const lastSave = calls[calls.length - 1][0];
    expect(lastSave.layout.poppedOut ?? []).toEqual([]);
  });
});

describe('saved default layout', () => {
  it('starts a fresh Minimal layout with a hidden 50%-width Side Panel and hidden Bottom Drawer', async () => {
    loadWorktreeMode.mockResolvedValue({ mode: 'minimal' });
    loadWorktreeLayout.mockResolvedValue({ layout: null });

    await ensureWorktreePanelLayout(KEY);

    const layout = usePanelLayoutStore.getState().serializeLayout(KEY);
    expect(layout).not.toBeNull();
    if (!layout) throw new Error('Expected a serialized layout');
    const collectLeaves = (
      node: NonNullable<typeof layout>['grid']['root'],
    ): Array<Extract<typeof node, { type: 'leaf' }>> =>
      node.type === 'leaf'
        ? [node]
        : node.children.flatMap((child) => collectLeaves(child));
    const leaves = layout ? collectLeaves(layout.grid.root) : [];
    const chat = leaves.find(
      (child) => child.groupId === DEFAULT_CHAT_GROUP_ID,
    );
    const side = leaves.find(
      (child) => child.groupId === DEFAULT_EXTRAS_GROUP_ID,
    );
    const bottom = leaves.find(
      (child) => child.groupId === DEFAULT_TERMINAL_GROUP_ID,
    );
    expect(chat?.type).toBe('leaf');
    expect(side?.type).toBe('leaf');
    expect(bottom?.type).toBe('leaf');
    if (
      chat?.type !== 'leaf' ||
      side?.type !== 'leaf' ||
      bottom?.type !== 'leaf'
    ) {
      return;
    }
    expect(side.size).toBe(layout.grid.width / 2);
    // Simplified Minimal defaults keep both optional regions hidden until
    // the user opens them, including the initially empty Side Panel.
    expect(side.collapsed).toEqual({
      edge: 'right',
      expandedSize: layout.grid.width / 2,
    });
    expect(bottom.collapsed).toEqual({
      edge: 'bottom',
      expandedSize: bottom.size,
    });
  });

  it('applies the saved default (retargeted) when a worktree has no file', async () => {
    // No per-worktree file...
    loadWorktreeLayout.mockResolvedValue({ layout: null });
    // ...but a saved global default with a group-chat host exists.
    loadDefaultLayout.mockResolvedValue({
      layout: {
        version: 1,
        grid: {
          root: {
            type: 'branch',
            size: 1200,
            children: [
              {
                type: 'leaf',
                groupId: 'group-chat',
                size: 800,
                panels: [],
                activePanelId: null,
              },
              {
                type: 'leaf',
                groupId: 'group-activity',
                size: 400,
                panels: [
                  { panelId: 'panel-activity', kind: 'activity-section' },
                ],
                activePanelId: 'panel-activity',
                collapsed: { edge: 'right', expandedSize: 400 },
              },
            ],
          },
          orientation: 1,
          width: 1200,
          height: 800,
        },
        activeGroupId: 'group-chat',
        mostRecentActiveGroupIds: ['group-chat'],
      },
    });

    await ensureWorktreePanelLayout(KEY);

    const layout = usePanelLayoutStore.getState().serializeLayout(KEY);
    expect(layout).not.toBeNull();
    if (!layout) throw new Error('Expected a serialized layout');
    // The applied default carried the activity group + its collapse, and did
    // NOT fall back to the 3-group hardcoded default (no group-terminal).
    const groupIds = (layout?.mostRecentActiveGroupIds ?? []).concat(
      layout?.activeGroupId ?? '',
    );
    expect(groupIds).toContain('group-chat');
    expect(JSON.stringify(layout)).not.toContain(DEFAULT_TERMINAL_GROUP_ID);
  });

  it('falls back to the hardcoded default when no saved default exists', async () => {
    loadWorktreeLayout.mockResolvedValue({ layout: null });
    loadDefaultLayout.mockResolvedValue({ layout: null });

    await ensureWorktreePanelLayout(KEY);

    // Hardcoded default has a terminal group.
    const layout = usePanelLayoutStore.getState().serializeLayout(KEY);
    expect(layout).not.toBeNull();
    expect(JSON.stringify(layout)).toContain(DEFAULT_TERMINAL_GROUP_ID);
  });

  it('saveCurrentLayoutAsDefault templatizes and calls the IPC', async () => {
    await ensureWorktreePanelLayout(KEY); // build a layout first
    const ok = await saveCurrentLayoutAsDefault(KEY);
    expect(ok).toBe(true);
    expect(saveDefaultLayout).toHaveBeenCalledTimes(1);
    const arg = saveDefaultLayout.mock.calls[0][0];
    expect(arg.surface).toBe('code');
    if (
      typeof arg.layout !== 'object' ||
      arg.layout === null ||
      !('version' in arg.layout)
    ) {
      throw new Error('Expected a serialized default layout');
    }
    expect(arg.layout.version).toBe(1);
    // Chat instance stripped from the template's group-chat leaf.
    const chatLeaf = JSON.stringify(arg.layout);
    expect(chatLeaf).not.toContain('chatTabId');
  });

  it('saveCurrentLayoutAsDefault returns false and skips the IPC when the layout has no chat host', async () => {
    // Hydrate with a saved default that has no group-chat leaf at all (only
    // an activity group survives templatizing), so the current worktree
    // layout ends up chat-less.
    loadWorktreeLayout.mockResolvedValue({
      layout: {
        version: 1,
        grid: {
          root: {
            type: 'leaf',
            groupId: 'group-activity',
            size: 1200,
            panels: [{ panelId: 'panel-activity', kind: 'activity-section' }],
            activePanelId: 'panel-activity',
          },
          orientation: 1,
          width: 1200,
          height: 800,
        },
        activeGroupId: 'group-activity',
        mostRecentActiveGroupIds: ['group-activity'],
      },
    });

    await ensureWorktreePanelLayout(KEY);

    const ok = await saveCurrentLayoutAsDefault(KEY);
    expect(ok).toBe(false);
    expect(saveDefaultLayout).not.toHaveBeenCalled();
  });

  it('saveCurrentLayoutAsDefault rejects Minimal layouts for every caller', async () => {
    await ensureWorktreePanelLayout(KEY);
    useWorkspaceLayoutModeStore.setState({
      entries: {
        [KEY]: { mode: 'minimal', status: 'ready', requestId: 1 },
      },
    });

    const ok = await saveCurrentLayoutAsDefault(KEY);

    expect(ok).toBe(false);
    expect(saveDefaultLayout).not.toHaveBeenCalled();
  });
});

/**
 * CAN-2836 reopen half: the auto-expand is routed through the bridge so the
 * hydration ordering (`handleLayoutsChanged` assigns `previousLayouts` BEFORE
 * the hydration filter) is stated and pinned in the module that owns it.
 */
describe('expandActivityRailFromContent', () => {
  function savedLeaf(
    node: SaveWorktreePanelLayoutRequest['layout']['grid']['root'],
    groupId: string,
  ): Extract<
    SaveWorktreePanelLayoutRequest['layout']['grid']['root'],
    { type: 'leaf' }
  > | null {
    if (node.type === 'leaf') {
      return node.groupId === groupId ? node : null;
    }
    for (const child of node.children) {
      const found = savedLeaf(child, groupId);
      if (found !== null) return found;
    }
    return null;
  }

  function collapsedOf(groupId: string): unknown {
    return usePanelLayoutStore.getState().layouts[KEY]?.groups[groupId]
      ?.collapsed;
  }

  it('expands the seeded rail and the expand reaches disk', async () => {
    await ensureWorktreePanelLayout(KEY);
    await flushDebounce();
    saveWorktreeLayout.mockClear();
    expect(collapsedOf(DEFAULT_ACTIVITY_GROUP_ID)).toMatchObject({
      auto: true,
    });

    expect(expandActivityRailFromContent(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(
      true,
    );
    await flushDebounce();

    // The flag is spent: `collapsed` is gone entirely, so the rail reopens
    // itself at most once.
    expect(collapsedOf(DEFAULT_ACTIVITY_GROUP_ID)).toBeUndefined();
    expect(saveWorktreeLayout).toHaveBeenCalled();
    const request = saveWorktreeLayout.mock.calls[0][0];
    const leaf = savedLeaf(request.layout.grid.root, DEFAULT_ACTIVITY_GROUP_ID);
    expect(leaf).not.toBeNull();
    expect(leaf?.collapsed).toBeUndefined();
  });

  it('declines while persistence is suspended, keeping the flag intact', async () => {
    // During browser-panel-migration recovery persistence is suspended. An
    // expand here would mutate memory but never reach disk, so `auto` would
    // survive on disk and the documented at-most-once guarantee would
    // silently degrade to per-session. Declining keeps the flag intact in
    // BOTH places so a later revision can retry it durably.
    await ensureWorktreePanelLayout(KEY);
    await flushDebounce();
    saveWorktreeLayout.mockClear();
    expect(collapsedOf(DEFAULT_ACTIVITY_GROUP_ID)).toMatchObject({
      auto: true,
    });

    suspendPanelLayoutPersistence(KEY);
    expect(expandActivityRailFromContent(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(
      false,
    );
    await flushDebounce();

    // Still collapsed, still flagged, nothing written.
    expect(collapsedOf(DEFAULT_ACTIVITY_GROUP_ID)).toMatchObject({
      auto: true,
    });
    expect(saveWorktreeLayout).not.toHaveBeenCalled();

    // Once persistence resumes the retry succeeds and DOES reach disk.
    resumePanelLayoutPersistence(KEY);
    expect(expandActivityRailFromContent(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(
      true,
    );
    await flushDebounce();
    expect(collapsedOf(DEFAULT_ACTIVITY_GROUP_ID)).toBeUndefined();
    expect(saveWorktreeLayout).toHaveBeenCalled();
  });

  it('keeps focus on the chat group (the rail filling is not a focus event)', async () => {
    await ensureWorktreePanelLayout(KEY);

    expect(expandActivityRailFromContent(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(
      true,
    );

    expect(usePanelLayoutStore.getState().layouts[KEY]?.activeGroupId).toBe(
      DEFAULT_CHAT_GROUP_ID,
    );
  });

  it('fires for a decision restored from disk across a restart', async () => {
    await ensureWorktreePanelLayout(KEY);
    await flushDebounce();
    const persisted = usePanelLayoutStore.getState().serializeLayout(KEY);
    expect(persisted).not.toBeNull();
    if (persisted === null) throw new Error('expected a serialized layout');
    // The pending decision survives serialization…
    expect(
      savedLeaf(persisted.grid.root, DEFAULT_ACTIVITY_GROUP_ID)?.collapsed,
    ).toMatchObject({ auto: true });

    // …and a relaunch that restores that file still reopens the rail.
    resetPanelLayoutPersistenceBridgeForTests();
    usePanelLayoutStore.getState().disposeLayout(KEY);
    loadWorktreeLayout.mockResolvedValue({ layout: persisted });
    await ensureWorktreePanelLayout(KEY);

    expect(collapsedOf(DEFAULT_ACTIVITY_GROUP_ID)).toMatchObject({
      auto: true,
    });
    expect(expandActivityRailFromContent(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(
      true,
    );
  });

  it('never undoes a collapse the user performed by hand', async () => {
    await ensureWorktreePanelLayout(KEY);
    const store = usePanelLayoutStore.getState();
    store.expandGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID, { focus: false });
    expect(store.collapseGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(true);

    expect(expandActivityRailFromContent(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(
      false,
    );
    expect(collapsedOf(DEFAULT_ACTIVITY_GROUP_ID)).toMatchObject({
      edge: 'right',
    });
  });

  it('no-ops on an already expanded rail', async () => {
    await ensureWorktreePanelLayout(KEY);
    usePanelLayoutStore
      .getState()
      .expandGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID, { focus: false });

    expect(expandActivityRailFromContent(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(
      false,
    );
  });

  it('skips while a group is maximized, then fires on the next revision', async () => {
    await ensureWorktreePanelLayout(KEY);
    usePanelLayoutStore
      .getState()
      .maximizeGroup(KEY, DEFAULT_CHAT_GROUP_ID, true);
    expect(usePanelLayoutStore.getState().layouts[KEY]?.maximizedGroupId).toBe(
      DEFAULT_CHAT_GROUP_ID,
    );

    // `expandGroup` silently exits maximize, so acting here would yank the
    // user out of a maximized chat.
    expect(expandActivityRailFromContent(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(
      false,
    );
    expect(usePanelLayoutStore.getState().layouts[KEY]?.maximizedGroupId).toBe(
      DEFAULT_CHAT_GROUP_ID,
    );
    expect(collapsedOf(DEFAULT_ACTIVITY_GROUP_ID)).toMatchObject({
      auto: true,
    });

    usePanelLayoutStore
      .getState()
      .maximizeGroup(KEY, DEFAULT_CHAT_GROUP_ID, false);

    expect(expandActivityRailFromContent(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(
      true,
    );
  });

  it('refuses before the worktree has finished hydrating', () => {
    // A commit made mid-hydration is absorbed by `handleLayoutsChanged` and
    // never reaches disk, so the bridge declines rather than losing it.
    void ensureWorktreePanelLayout(KEY);

    expect(expandActivityRailFromContent(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(
      false,
    );
  });

  it('refuses an unknown layout key', () => {
    expect(expandActivityRailFromContent('nope/nope', 'group-x')).toBe(false);
  });
});
