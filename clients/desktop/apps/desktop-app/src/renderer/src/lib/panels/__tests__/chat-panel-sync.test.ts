/** @jest-environment jsdom */

/**
 * Chat ⇄ panel sync bridge — exercised against the REAL chat and panel
 * layout stores. Chat state is driven via `setState` (the same posture as
 * registry.test.tsx); the two chat actions the bridge dispatches
 * (`switchTab`, `closeTab`) are replaced with light fakes that apply the
 * minimal semantics ChatTabBar relies on, so the tests can assert dispatch
 * counts (loop guard) without pulling the heavy real action paths (IPC,
 * persistence) into jsdom.
 */
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import {
  findPanelByInstanceKey,
  makeAuxPanelLayoutKey,
  setPanelLayoutChatGroup,
  setPanelLayoutFixedTopology,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
  type PanelInstanceLocation,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import {
  closePanelGroup,
  closePanelTab,
  closePanelTabs,
  flushChatPanelSyncForTests,
  forgetChatPanelSyncWorktree,
  getChatPanelSyncOwnerKeys,
  initChatPanelSync,
  openChangeDiagram,
  openContentPanel,
  placeFilePanelsBesideChat,
  placeOrRevealContentPanel,
  refuseFullNewChatRow,
  registerChatPanelSyncOwner,
  requestFilePanelPlacementAsSibling,
  requestFilePanelPlacementBesideChat,
  resetChatPanelSyncForTests,
} from '../chat-panel-sync';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  MAX_TABS_PER_GROUP,
  PANEL_TAB_ROW_FULL_NOTE,
} from '@canopy/ui-shared/panels';
import { ensureWorktreePanelLayout } from '../persistence-bridge';
import { pipelineExecutionPanelSeed } from '../pipeline-execution-panel-identity';

jest.mock('../persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(),
}));

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;

const originalSwitchTab = useChatStore.getState().switchTab;
const originalCloseTab = useChatStore.getState().closeTab;
const originalCreateTab = useChatStore.getState().createTab;

function makeChatTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-1',
    title: 'Chat One',
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
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    ...overrides,
  };
}

function makeFileTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return makeChatTab({
    id: 'file-1',
    kind: 'file',
    title: 'a.ts',
    filePath: '/tmp/a.ts',
    ...overrides,
  });
}

/** Fake switchTab: sets the target worktree's activeTabId. */
const switchTabMock = jest.fn(
  (tabId: string, target?: { projectId: string; worktreeId: string }): void => {
    const key = target ? `${target.projectId}/${target.worktreeId}` : KEY;
    useChatStore.setState((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: { ...wc, activeTabId: tabId },
        },
      };
    });
  },
);

/** Fake closeTab: removes the tab and fixes up activeTabId. */
const closeTabMock = jest.fn(
  (
    tabId: string,
    options?: { projectId?: string; worktreeId?: string },
  ): void => {
    const key =
      options?.projectId !== undefined && options.worktreeId !== undefined
        ? `${options.projectId}/${options.worktreeId}`
        : KEY;
    useChatStore.setState((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      const tabs = wc.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId =
        wc.activeTabId === tabId ? (tabs[0]?.id ?? '') : wc.activeTabId;
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: { ...wc, tabs, activeTabId },
        },
      };
    });
  },
);

const createTabMock = jest.fn(
  (target?: { projectId: string; worktreeId: string }): void => {
    const key = target ? `${target.projectId}/${target.worktreeId}` : KEY;
    useChatStore.setState((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      const fresh = makeChatTab({ id: 'chat-fresh', title: 'New Chat' });
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: {
            tabs: [...wc.tabs, fresh],
            activeTabId: fresh.id,
          },
        },
      };
    });
  },
);

/** Default-layout-shaped fixture: legacy instance-less chat + terminal. */
const DEFAULT_LIKE_LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    { kind: 'chat', groupId: 'group-chat', panelId: 'panel-chat' },
    { kind: 'terminal', groupId: 'group-terminal', panelId: 'panel-terminal' },
  ],
  containerSize: { width: 1200, height: 800 },
};

const MINIMAL_LIKE_LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    { groupId: 'group-chat' },
    {
      kind: 'activity-section',
      groupId: 'group-activity',
      panelId: 'panel-activity',
    },
  ],
  containerSize: { width: 1200, height: 800 },
};

function panelStore(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function setChatState(tabs: ChatTab[], activeTabId: string): void {
  useChatStore.setState({
    selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    worktreeChats: { [KEY]: { tabs, activeTabId } },
  });
}

/** All panel ids across the worktree's main layout. */
function allPanelIds(): string[] {
  const layout = panelStore().layouts[KEY];
  return Object.values(layout?.groups ?? {}).flatMap((group) =>
    group.tabs.map((tab) => tab.panelId),
  );
}

function groupChatTabs(): ReadonlyArray<{
  panelId: string;
  kind: string;
  title?: string;
  instance?: Readonly<Record<string, string>>;
  pinned?: boolean;
}> {
  return panelStore().layouts[KEY]?.groups['group-chat']?.tabs ?? [];
}

function groupChatTabIds(): string[] {
  return groupChatTabs().flatMap((tab) =>
    tab.instance?.chatTabId ? [tab.instance.chatTabId] : [],
  );
}

/** Initializes chat + layout state, installs the bridge, and reconciles. */
function initAll(tabs: ChatTab[], activeTabId: string): void {
  setChatState(tabs, activeTabId);
  panelStore().initializeLayout(KEY, DEFAULT_LIKE_LAYOUT);
  initChatPanelSync();
  flushChatPanelSyncForTests();
}

beforeEach(() => {
  jest.mocked(ensureWorktreePanelLayout).mockReset();
  useChatStore.setState({
    switchTab: switchTabMock,
    closeTab: closeTabMock,
    createTab: createTabMock,
  });
});

test('openChangeDiagram hydrates a missing panel layout before placing the panel', async () => {
  jest.mocked(ensureWorktreePanelLayout).mockImplementation(() => {
    panelStore().initializeLayout(KEY, DEFAULT_LIKE_LAYOUT);
    return Promise.resolve();
  });

  await openChangeDiagram(KEY);

  expect(ensureWorktreePanelLayout).toHaveBeenCalledWith(KEY);
  expect(findPanelByInstanceKey(KEY, 'change-diagram')).not.toBeNull();
});

afterEach(() => {
  resetChatPanelSyncForTests();
  const state = panelStore();
  for (const key of Object.keys(state.layouts)) {
    state.disposeLayout(key);
  }
  useChatStore.setState({
    switchTab: originalSwitchTab,
    closeTab: originalCloseTab,
    createTab: originalCreateTab,
    selectedWorktree: null,
    worktreeChats: {},
    closingChatTabs: {},
  });
  useWorkspaceLayoutModeStore.setState({ entries: {} });
  switchTabMock.mockClear();
  closeTabMock.mockClear();
  createTabMock.mockClear();
});

/**
 * Change Diagram placement is pinned end to end here so the shared
 * content-placement helper it runs through cannot drift from the original
 * sequence: family search → await layout → search again → file sibling →
 * beside the origin chat → Minimal / `pickContentTargetGroupId` fallback.
 */
describe('openChangeDiagram placement', () => {
  function diagramLocation(): ReturnType<typeof findPanelByInstanceKey> {
    return findPanelByInstanceKey(KEY, 'change-diagram');
  }

  test('reveals an existing diagram in place without awaiting the layout or moving it', async () => {
    initAll([makeChatTab()], 'chat-1');
    expect(
      panelStore().addTab(KEY, 'group-terminal', 'change-diagram', {
        panelId: 'panel-change-diagram',
      }),
    ).toBe('panel-change-diagram');
    panelStore().selectTab(KEY, 'group-terminal', 'panel-terminal');
    expect(panelStore().collapseGroup(KEY, 'group-terminal')).toBe(true);
    panelStore().focusGroup(KEY, 'group-chat');
    const groupIdsBefore = Object.keys(panelStore().layouts[KEY].groups);

    await openChangeDiagram(KEY, { chatTabId: 'chat-1' });

    expect(ensureWorktreePanelLayout).not.toHaveBeenCalled();
    expect(diagramLocation()).toEqual({
      layoutKey: KEY,
      groupId: 'group-terminal',
      panelId: 'panel-change-diagram',
    });
    const layout = panelStore().layouts[KEY];
    expect(Object.keys(layout.groups)).toEqual(groupIdsBefore);
    expect(layout.groups['group-terminal'].collapsed).toBeUndefined();
    expect(layout.groups['group-terminal'].activePanelId).toBe(
      'panel-change-diagram',
    );
    expect(layout.activeGroupId).toBe('group-terminal');
  });

  test('opens beside the origin chat in a new right sibling, collapsing the right rail', async () => {
    initAll([makeChatTab()], 'chat-1');

    await openChangeDiagram(KEY, { chatTabId: 'chat-1' });

    const location = diagramLocation();
    expect(location).not.toBeNull();
    expect(location?.panelId).toBe(`change-diagram-${KEY}`);
    expect(location?.groupId).not.toBe('group-chat');
    expect(location?.groupId).not.toBe('group-terminal');
    const layout = panelStore().layouts[KEY];
    expect(layout.groups['group-terminal'].collapsed?.edge).toBe('right');
    expect(layout.groups[location?.groupId ?? '']?.tabs).toHaveLength(1);
  });

  test('reuses an existing non-chat sibling group instead of splitting again', async () => {
    initAll([makeChatTab()], 'chat-1');
    const browserGroupId = panelStore().splitGroup(KEY, 'group-chat', 'right');
    expect(browserGroupId).not.toBeNull();
    if (browserGroupId === null) return;
    panelStore().addTab(KEY, browserGroupId, 'browser', {
      panelId: 'panel-browser-existing',
      instance: { browserId: 'browser-existing' },
    });
    const groupIdsBefore = Object.keys(panelStore().layouts[KEY].groups);

    await openChangeDiagram(KEY, { chatTabId: 'chat-1' });

    expect(diagramLocation()?.groupId).toBe(browserGroupId);
    expect(Object.keys(panelStore().layouts[KEY].groups)).toEqual(
      groupIdsBefore,
    );
    expect(
      panelStore().layouts[KEY].groups['group-terminal'].collapsed,
    ).toBeUndefined();
  });

  test('opens directly after the origin file tab in its group', async () => {
    initAll([makeChatTab(), makeFileTab()], 'file-1');
    const origin = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(origin).not.toBeNull();

    await openChangeDiagram(KEY, { fileTabId: 'file-1' });

    const location = diagramLocation();
    expect(location?.groupId).toBe(origin?.groupId);
    const tabs =
      panelStore().layouts[KEY].groups[origin?.groupId ?? '']?.tabs ?? [];
    const originIndex = tabs.findIndex(
      (tab) => tab.panelId === origin?.panelId,
    );
    expect(tabs.findIndex((tab) => tab.panelId === location?.panelId)).toBe(
      originIndex + 1,
    );
  });

  test('falls back to the chat group without an origin, or when the origin has no panel', async () => {
    initAll([makeChatTab()], 'chat-1');

    await openChangeDiagram(KEY, { chatTabId: 'chat-missing' });

    expect(diagramLocation()?.groupId).toBe('group-chat');
    expect(
      panelStore().layouts[KEY].groups['group-terminal'].collapsed,
    ).toBeUndefined();
  });

  test('uses the Minimal Side Panel destination in Minimal mode', async () => {
    setChatState([makeChatTab()], 'chat-1');
    panelStore().initializeLayout(KEY, MINIMAL_LIKE_LAYOUT);
    useWorkspaceLayoutModeStore.setState({
      entries: {
        [KEY]: { mode: 'minimal', status: 'ready', requestId: 1 },
      },
    });

    await openChangeDiagram(KEY);

    expect(diagramLocation()?.groupId).toBe('group-extras');
  });

  test('rolls back the sibling it created when the tab cannot be added', async () => {
    initAll([makeChatTab()], 'chat-1');
    const groupIdsBefore = Object.keys(panelStore().layouts[KEY].groups);
    const panelState = panelStore();
    const originalAddTab = panelState.addTab.bind(panelState);
    usePanelLayoutStore.setState({ addTab: () => null });
    try {
      await openChangeDiagram(KEY, { chatTabId: 'chat-1' });
    } finally {
      usePanelLayoutStore.setState({ addTab: originalAddTab });
    }

    expect(diagramLocation()).toBeNull();
    const layout = panelStore().layouts[KEY];
    expect(Object.keys(layout.groups)).toEqual(groupIdsBefore);
    expect(layout.groups['group-terminal'].collapsed).toBeUndefined();
  });
});

/**
 * The shared content placement helper for execution-bound run panels: the
 * same policy as Change Diagram, plus reveal-in-place for an open run.
 */
describe('placeOrRevealContentPanel (pipeline runs)', () => {
  const OTHER_KEY = `${PROJECT_ID}/worktree-other`;
  const initialWindowsState = usePanelWindowsStore.getState();
  const focusAuxWindow = jest.fn<boolean, [string]>(() => true);

  beforeEach(() => {
    usePanelWindowsStore.setState({ focusAuxWindowForLayout: focusAuxWindow });
  });

  afterEach(() => {
    usePanelWindowsStore.setState(initialWindowsState, true);
    focusAuxWindow.mockClear();
  });

  function openRun(
    executionId: string,
    origin?: { chatTabId?: string; fileTabId?: string },
    worktreeKey = KEY,
  ): ReturnType<typeof placeOrRevealContentPanel> {
    return placeOrRevealContentPanel({
      worktreeKey,
      seed: pipelineExecutionPanelSeed(executionId),
      ...(origin !== undefined ? { origin } : {}),
    });
  }

  test('opens beside the origin chat, and later runs share that sibling group', async () => {
    initAll([makeChatTab()], 'chat-1');

    const first = await openRun('run-1', { chatTabId: 'chat-1' });
    expect(first.outcome).toBe('placed');
    const firstGroupId =
      first.outcome === 'placed' ? first.location.groupId : null;
    expect(firstGroupId).not.toBe('group-chat');
    expect(first.outcome === 'placed' ? first.location.panelId : null).toBe(
      'panel-pipeline-run-1',
    );
    const groupIdsAfterFirst = Object.keys(panelStore().layouts[KEY].groups);

    const second = await openRun('run-2', { chatTabId: 'chat-1' });
    expect(second.outcome).toBe('placed');
    expect(second.outcome === 'placed' ? second.location.groupId : null).toBe(
      firstGroupId,
    );
    expect(Object.keys(panelStore().layouts[KEY].groups)).toEqual(
      groupIdsAfterFirst,
    );
    expect(
      panelStore().layouts[KEY].groups[firstGroupId ?? '']?.tabs.map(
        (tab) => tab.panelId,
      ),
    ).toEqual(['panel-pipeline-run-1', 'panel-pipeline-run-2']);
  });

  test('reveals an open run in its auxiliary window instead of moving it', async () => {
    initAll([makeChatTab()], 'chat-1');
    const placed = await openRun('run-1', { chatTabId: 'chat-1' });
    const runGroupId =
      placed.outcome === 'placed' ? placed.location.groupId : '';
    const auxKey = makeAuxPanelLayoutKey(KEY, 'aux-runs');
    expect(panelStore().extractGroupToLayout(KEY, runGroupId, auxKey)).toBe(
      true,
    );
    const mainGroupsBefore = Object.keys(panelStore().layouts[KEY].groups);

    const reopened = await openRun('run-1', { chatTabId: 'chat-1' });

    expect(reopened).toEqual({
      outcome: 'revealed',
      location: {
        layoutKey: auxKey,
        groupId: runGroupId,
        panelId: 'panel-pipeline-run-1',
      },
    });
    expect(focusAuxWindow).toHaveBeenCalledWith(auxKey);
    expect(ensureWorktreePanelLayout).not.toHaveBeenCalled();
    expect(Object.keys(panelStore().layouts[KEY].groups)).toEqual(
      mainGroupsBefore,
    );
    expect(findPanelByInstanceKey(KEY, 'pipeline-execution:run-1')).toEqual(
      reopened.outcome === 'revealed' ? reopened.location : null,
    );
  });

  test('awaits the owner layout, then reveals a run restored with it', async () => {
    jest.mocked(ensureWorktreePanelLayout).mockImplementation(() => {
      panelStore().initializeLayout(KEY, DEFAULT_LIKE_LAYOUT);
      panelStore().addTab(KEY, 'group-terminal', 'pipeline-execution', {
        panelId: 'panel-restored-run',
        instance: { executionId: 'run-1' },
      });
      return Promise.resolve();
    });

    const result = await openRun('run-1', { chatTabId: 'chat-1' });

    expect(ensureWorktreePanelLayout).toHaveBeenCalledWith(KEY);
    expect(result).toEqual({
      outcome: 'revealed',
      location: {
        layoutKey: KEY,
        groupId: 'group-terminal',
        panelId: 'panel-restored-run',
      },
    });
    expect(
      Object.values(panelStore().layouts[KEY].groups).flatMap((group) =>
        group.tabs.filter((tab) => tab.kind === 'pipeline-execution'),
      ),
    ).toHaveLength(1);
  });

  test('reports unavailable when the owner layout cannot be built', async () => {
    jest.mocked(ensureWorktreePanelLayout).mockResolvedValue(undefined);

    await expect(openRun('run-1')).resolves.toEqual({ outcome: 'unavailable' });
  });

  test('never places a run in another worktree through an origin chat there', async () => {
    initAll([makeChatTab()], 'chat-1');
    panelStore().initializeLayout(OTHER_KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-other-chat',
          panelId: 'panel-other-chat',
          instance: { chatTabId: 'chat-elsewhere' },
        },
      ],
      containerSize: { width: 1200, height: 800 },
    });
    const otherBefore = panelStore().layouts[OTHER_KEY];

    const result = await openRun('run-1', { chatTabId: 'chat-elsewhere' });

    expect(result.outcome === 'placed' ? result.location : null).toEqual({
      layoutKey: KEY,
      groupId: 'group-chat',
      panelId: 'panel-pipeline-run-1',
    });
    expect(panelStore().layouts[OTHER_KEY]).toBe(otherBefore);
  });

  test('non-chat entry points use the file destination fallback', async () => {
    setChatState([makeChatTab()], 'chat-1');
    panelStore().initializeLayout(KEY, MINIMAL_LIKE_LAYOUT);
    useWorkspaceLayoutModeStore.setState({
      entries: {
        [KEY]: { mode: 'minimal', status: 'ready', requestId: 1 },
      },
    });

    const result = await openRun('run-1');

    expect(result.outcome === 'placed' ? result.location.groupId : null).toBe(
      'group-extras',
    );
  });
});

describe('tab row limit', () => {
  /** Fills `group-chat` with terminal tabs until it holds the maximum. */
  function fillChatRow(): void {
    let index = 0;
    while (
      panelStore().layouts[KEY].groups['group-chat'].tabs.length <
      MAX_TABS_PER_GROUP
    ) {
      index += 1;
      expect(
        panelStore().addTab(KEY, 'group-chat', 'terminal', {
          instance: { terminalId: `filler-${index}` },
          activate: false,
        }),
      ).not.toBeNull();
    }
  }

  // The limit is on only while early access shows the non-scrolling tabs.
  beforeEach(() => {
    panelStore().setTabRowLimit(MAX_TABS_PER_GROUP);
  });

  afterEach(() => {
    panelStore().setTabRowLimit(null);
    useGitHubStore.setState({ toasts: [] });
  });

  test('a chat arriving for a full row opens in a new row beside it', () => {
    initAll([makeChatTab()], 'chat-1');
    fillChatRow();

    setChatState(
      [makeChatTab(), makeChatTab({ id: 'chat-new', title: 'New' })],
      'chat-new',
    );
    flushChatPanelSyncForTests();

    const location = findPanelByInstanceKey(KEY, 'chat:chat-new');
    expect(location).not.toBeNull();
    expect(location?.groupId).not.toBe('group-chat');
    expect(panelStore().layouts[KEY].groups['group-chat'].tabs).toHaveLength(
      MAX_TABS_PER_GROUP,
    );
  });

  test('a chat arriving for a full row of a fixed layout still gets a tab there', () => {
    initAll([makeChatTab()], 'chat-1');
    fillChatRow();
    // Minimal mode's fixed layout cannot split a new row beside it.
    setPanelLayoutFixedTopology(KEY, true);
    try {
      setChatState(
        [makeChatTab(), makeChatTab({ id: 'chat-new', title: 'New' })],
        'chat-new',
      );
      flushChatPanelSyncForTests();

      expect(findPanelByInstanceKey(KEY, 'chat:chat-new')?.groupId).toBe(
        'group-chat',
      );
      expect(panelStore().layouts[KEY].groups['group-chat'].tabs).toHaveLength(
        MAX_TABS_PER_GROUP + 1,
      );
    } finally {
      setPanelLayoutFixedTopology(KEY, false);
    }
  });

  test('chats arriving for a full restricted chat group open no new rows', () => {
    initAll([makeChatTab()], 'chat-1');
    fillChatRow();
    const groupsBefore = Object.keys(panelStore().layouts[KEY].groups);
    setPanelLayoutChatGroup('group-chat');
    try {
      setChatState(
        [makeChatTab(), makeChatTab({ id: 'chat-new', title: 'New' })],
        'chat-new',
      );
      flushChatPanelSyncForTests();
      setChatState(
        [
          makeChatTab(),
          makeChatTab({ id: 'chat-new', title: 'New' }),
          makeChatTab({ id: 'chat-next', title: 'Next' }),
        ],
        'chat-next',
      );
      flushChatPanelSyncForTests();

      const layout = panelStore().layouts[KEY];
      expect(Object.keys(layout.groups)).toEqual(groupsBefore);
      expect(findPanelByInstanceKey(KEY, 'chat:chat-new')?.groupId).toBe(
        'group-chat',
      );
      expect(findPanelByInstanceKey(KEY, 'chat:chat-next')?.groupId).toBe(
        'group-chat',
      );
    } finally {
      setPanelLayoutChatGroup(null);
    }
  });

  test('a new chat without a target row is refused with a note while that row is full', () => {
    initAll([makeChatTab()], 'chat-1');
    expect(refuseFullNewChatRow(KEY)).toBe(false);
    expect(useGitHubStore.getState().toasts).toHaveLength(0);

    fillChatRow();

    expect(refuseFullNewChatRow(KEY)).toBe(true);
    expect(refuseFullNewChatRow(KEY)).toBe(true);
    expect(
      useGitHubStore
        .getState()
        .toasts.filter((toast) => toast.message === PANEL_TAB_ROW_FULL_NOTE),
    ).toHaveLength(1);
  });

  test('a new chat is checked against the restricted chat group, not the last used row', () => {
    initAll([makeChatTab()], 'chat-1');
    fillChatRow();
    setPanelLayoutChatGroup('group-terminal');
    try {
      // The full row is the most recently used one, but the chat would land
      // in the chat group, which has room.
      expect(refuseFullNewChatRow(KEY)).toBe(false);
      expect(useGitHubStore.getState().toasts).toHaveLength(0);
    } finally {
      setPanelLayoutChatGroup(null);
    }
  });

  test('without the limit a chat joins the row however many tabs it holds', () => {
    panelStore().setTabRowLimit(null);
    initAll([makeChatTab()], 'chat-1');
    fillChatRow();

    expect(refuseFullNewChatRow(KEY)).toBe(false);
    setChatState(
      [makeChatTab(), makeChatTab({ id: 'chat-new', title: 'New' })],
      'chat-new',
    );
    flushChatPanelSyncForTests();

    expect(findPanelByInstanceKey(KEY, 'chat:chat-new')?.groupId).toBe(
      'group-chat',
    );
  });
});

describe('chat → panels', () => {
  test('gives a background chat a panel without selecting or focusing it', () => {
    // A hook, automation, or agent can add a chat while the user works in
    // another one. The chat store keeps the user's active tab, and the panel
    // grid must keep the user's tab and group too.
    initAll([makeChatTab()], 'chat-1');
    panelStore().focusGroup(KEY, 'group-terminal');
    setChatState(
      [makeChatTab(), makeChatTab({ id: 'chat-hook', title: 'Hook chat' })],
      'chat-1',
    );
    flushChatPanelSyncForTests();

    expect(groupChatTabIds()).toContain('chat-hook');
    const layout = panelStore().layouts[KEY];
    expect(layout?.activeGroupId).toBe('group-terminal');
    expect(findPanelByInstanceKey(KEY, 'chat:chat-1')?.panelId).toBe(
      layout?.groups['group-chat']?.activePanelId,
    );
    expect(switchTabMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-1',
    );
  });

  test('returns to the tab the user left when a background chat arrived while away', () => {
    initAll([makeChatTab()], 'chat-1');
    const otherKey = 'project-2/worktree-2';
    useChatStore.setState((state) => ({
      selectedWorktree: { projectId: 'project-2', worktreeId: 'worktree-2' },
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
          tabs: [
            makeChatTab(),
            makeChatTab({ id: 'chat-hook', title: 'Hook chat' }),
          ],
          activeTabId: 'chat-1',
        },
        [otherKey]: { tabs: [], activeTabId: '' },
      },
    }));
    flushChatPanelSyncForTests();

    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });
    flushChatPanelSyncForTests();

    expect(groupChatTabIds()).toContain('chat-hook');
    const layout = panelStore().layouts[KEY];
    expect(layout?.groups['group-chat']?.activePanelId).toBe(
      findPanelByInstanceKey(KEY, 'chat:chat-1')?.panelId,
    );
    expect(switchTabMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-1',
    );
  });

  test('reconciles a mounted grid owner without changing global worktree selection', () => {
    const viewerProjectId = 'shared-container-viewer';
    const viewerWorktreeId = 'container-1';
    const viewerKey = `${viewerProjectId}/${viewerWorktreeId}`;
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [viewerKey]: {
          tabs: [makeChatTab(), makeFileTab()],
          activeTabId: 'file-1',
        },
      },
    });
    panelStore().initializeLayout(viewerKey, DEFAULT_LIKE_LAYOUT);

    const unregister = registerChatPanelSyncOwner(viewerKey);
    flushChatPanelSyncForTests();

    expect(findPanelByInstanceKey(viewerKey, 'chat:chat-1')).not.toBeNull();
    expect(
      findPanelByInstanceKey(viewerKey, 'file-diff:file-1'),
    ).not.toBeNull();
    expect(useChatStore.getState().selectedWorktree).toEqual({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });

    unregister();
  });

  test('reports the selected worktree and registered overlay owners as sync owners', () => {
    const viewerKey = 'shared-container-viewer/container-1';
    const otherKey = 'project-2/worktree-2';
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });

    const unregisterViewer = registerChatPanelSyncOwner(viewerKey);
    // Ordinary grids reconcile through the selection, not a registration.
    const unregisterOther = registerChatPanelSyncOwner(otherKey);

    expect(getChatPanelSyncOwnerKeys().sort()).toEqual([KEY, viewerKey]);

    unregisterViewer();
    unregisterOther();
    useChatStore.setState({ selectedWorktree: null });

    expect(getChatPanelSyncOwnerKeys()).toEqual([]);
  });

  test('leaves a mounted worktree grid alone while another worktree is selected', () => {
    // When the selection moves, the outgoing grid stays mounted until React
    // commits the switch, and the sweep the selection change schedules runs
    // first. Only the selected worktree and page-like overlays reconcile; the
    // outgoing grid must not gain panels or have its chat and panel selection
    // driven by the sweep.
    const otherKey = 'project-2/worktree-2';
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: {
        [otherKey]: {
          tabs: [makeChatTab(), makeFileTab()],
          activeTabId: 'file-1',
        },
      },
    });
    panelStore().initializeLayout(otherKey, DEFAULT_LIKE_LAYOUT);
    panelStore().addTab(otherKey, 'group-chat', 'chat', {
      panelId: 'panel-chat-1',
      title: 'Chat One',
      instance: { chatTabId: 'chat-1' },
    });
    panelStore().addTab(otherKey, 'group-chat', 'file-explorer', {
      panelId: 'panel-files',
      title: 'File Explorer',
    });
    panelStore().selectTab(otherKey, 'group-chat', 'panel-files');

    const unregister = registerChatPanelSyncOwner(otherKey);
    flushChatPanelSyncForTests();

    expect(findPanelByInstanceKey(otherKey, 'file-diff:file-1')).toBeNull();
    expect(
      panelStore().layouts[otherKey].groups['group-chat'].activePanelId,
    ).toBe('panel-files');

    // A panel-side change on the background grid must not drive its chat.
    panelStore().selectTab(otherKey, 'group-chat', 'panel-chat-1');
    flushChatPanelSyncForTests();
    expect(switchTabMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().worktreeChats[otherKey]?.activeTabId).toBe(
      'file-1',
    );

    unregister();
  });

  test('preserves a recipient-local active non-chat tab during hydration', () => {
    const viewerProjectId = 'shared-container-viewer';
    const viewerWorktreeId = 'container-layout';
    const viewerKey = `${viewerProjectId}/${viewerWorktreeId}`;
    useChatStore.setState({
      worktreeChats: {
        [viewerKey]: {
          tabs: [makeChatTab()],
          activeTabId: 'chat-1',
        },
      },
    });
    panelStore().initializeLayout(viewerKey, DEFAULT_LIKE_LAYOUT);
    panelStore().addTab(viewerKey, 'group-chat', 'chat', {
      panelId: 'panel-chat-1',
      title: 'Chat One',
      instance: { chatTabId: 'chat-1' },
    });
    panelStore().addTab(viewerKey, 'group-chat', 'file-explorer', {
      panelId: 'panel-files',
      title: 'File Explorer',
    });
    panelStore().selectTab(viewerKey, 'group-chat', 'panel-files');

    const unregister = registerChatPanelSyncOwner(viewerKey);
    flushChatPanelSyncForTests();

    expect(
      panelStore().layouts[viewerKey].groups['group-chat'].activePanelId,
    ).toBe('panel-files');
    expect(switchTabMock).not.toHaveBeenCalled();

    unregister();
  });

  test('keeps the restored selection of a reopened share once its sweep history is forgotten', () => {
    const viewerKey = 'shared-container-viewer/container-reopened';
    const seedLayout = (): void => {
      panelStore().initializeLayout(viewerKey, DEFAULT_LIKE_LAYOUT);
      panelStore().addTab(viewerKey, 'group-chat', 'chat', {
        panelId: 'panel-chat-1',
        title: 'Chat One',
        instance: { chatTabId: 'chat-1' },
      });
      panelStore().addTab(viewerKey, 'group-chat', 'chat', {
        panelId: 'panel-chat-2',
        title: 'Chat Two',
        instance: { chatTabId: 'chat-2' },
      });
      panelStore().addTab(viewerKey, 'group-chat', 'file-explorer', {
        panelId: 'panel-files',
        title: 'File Explorer',
      });
      panelStore().selectTab(viewerKey, 'group-chat', 'panel-files');
    };
    const tabs = [
      makeChatTab(),
      makeChatTab({ id: 'chat-2', title: 'Chat Two' }),
    ];
    useChatStore.setState({
      worktreeChats: { [viewerKey]: { tabs, activeTabId: 'chat-1' } },
    });
    seedLayout();
    const unregister = registerChatPanelSyncOwner(viewerKey);
    flushChatPanelSyncForTests();

    // The viewer closes: its layout is dropped and its history forgotten.
    panelStore().disposeLayout(viewerKey);
    flushChatPanelSyncForTests();
    forgetChatPanelSyncWorktree(viewerKey);

    // The next open restores a layout, and the projected chat manifest names
    // a different active chat than the last visit ended on.
    useChatStore.setState({
      worktreeChats: { [viewerKey]: { tabs, activeTabId: 'chat-2' } },
    });
    seedLayout();
    flushChatPanelSyncForTests();

    expect(
      panelStore().layouts[viewerKey].groups['group-chat'].activePanelId,
    ).toBe('panel-files');

    unregister();
  });

  test('adds a published chat missing from the restored layout without taking the active tab', () => {
    const viewerProjectId = 'shared-container-viewer';
    const viewerWorktreeId = 'container-extra-chat';
    const viewerKey = `${viewerProjectId}/${viewerWorktreeId}`;
    useChatStore.setState({
      worktreeChats: {
        [viewerKey]: {
          tabs: [
            makeChatTab(),
            makeChatTab({ id: 'chat-2', title: 'Chat Two' }),
          ],
          activeTabId: 'chat-1',
        },
      },
    });
    panelStore().initializeLayout(viewerKey, DEFAULT_LIKE_LAYOUT);
    panelStore().addTab(viewerKey, 'group-chat', 'chat', {
      panelId: 'panel-chat-1',
      title: 'Chat One',
      instance: { chatTabId: 'chat-1' },
    });
    panelStore().addTab(viewerKey, 'group-chat', 'browser', {
      panelId: 'panel-browser-1',
      title: 'Browser',
      instance: { browserId: 'browser-1' },
    });
    panelStore().selectTab(viewerKey, 'group-chat', 'panel-browser-1');

    const unregister = registerChatPanelSyncOwner(viewerKey);
    flushChatPanelSyncForTests();

    expect(findPanelByInstanceKey(viewerKey, 'chat:chat-2')).not.toBeNull();
    expect(
      panelStore().layouts[viewerKey].groups['group-chat'].activePanelId,
    ).toBe('panel-browser-1');
    expect(switchTabMock).not.toHaveBeenCalled();

    unregister();
  });

  test('keeps the restored active tab when the chat-active chat was missing from the layout', () => {
    const viewerProjectId = 'shared-container-viewer';
    const viewerWorktreeId = 'container-active-extra-chat';
    const viewerKey = `${viewerProjectId}/${viewerWorktreeId}`;
    useChatStore.setState({
      worktreeChats: {
        [viewerKey]: {
          tabs: [
            makeChatTab({ id: 'chat-2', title: 'Chat Two' }),
            makeChatTab(),
          ],
          activeTabId: 'chat-2',
        },
      },
    });
    panelStore().initializeLayout(viewerKey, DEFAULT_LIKE_LAYOUT);
    panelStore().addTab(viewerKey, 'group-chat', 'chat', {
      panelId: 'panel-chat-1',
      title: 'Chat One',
      instance: { chatTabId: 'chat-1' },
    });
    panelStore().addTab(viewerKey, 'group-chat', 'browser', {
      panelId: 'panel-browser-1',
      title: 'Browser',
      instance: { browserId: 'browser-1' },
    });
    panelStore().selectTab(viewerKey, 'group-chat', 'panel-browser-1');

    const unregister = registerChatPanelSyncOwner(viewerKey);
    flushChatPanelSyncForTests();

    expect(findPanelByInstanceKey(viewerKey, 'chat:chat-2')).not.toBeNull();
    expect(
      panelStore().layouts[viewerKey].groups['group-chat'].activePanelId,
    ).toBe('panel-browser-1');

    unregister();
  });

  test('materializes a user-opened file in the canonical Minimal Side Panel group', () => {
    setChatState([makeChatTab()], 'chat-1');
    panelStore().initializeLayout(KEY, MINIMAL_LIKE_LAYOUT);
    useWorkspaceLayoutModeStore.setState({
      entries: {
        [KEY]: { mode: 'minimal', status: 'ready', requestId: 1 },
      },
    });
    initChatPanelSync();
    flushChatPanelSyncForTests();

    setChatState([makeChatTab(), makeFileTab()], 'file-1');
    flushChatPanelSyncForTests();

    expect(findPanelByInstanceKey(KEY, 'file-diff:file-1')).toMatchObject({
      layoutKey: KEY,
      groupId: 'group-extras',
    });
  });

  test('reconcile-on-init materializes a bound panel per chat/file tab with instance + title', () => {
    initAll([makeChatTab(), makeFileTab()], 'chat-1');

    const chatLocation = findPanelByInstanceKey(KEY, 'chat:chat-1');
    expect(chatLocation).not.toBeNull();
    // Placement: the MRU group already holding a chat-kind panel.
    expect(chatLocation?.groupId).toBe('group-chat');
    const fileLocation = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(fileLocation).not.toBeNull();

    const tabs = groupChatTabs();
    const chatPanel = tabs.find((tab) => tab.instance?.chatTabId === 'chat-1');
    expect(chatPanel?.title).toBe('Chat One');
    const filePanel = tabs.find((tab) => tab.instance?.fileTabId === 'file-1');
    expect(filePanel?.kind).toBe('file-diff');
    expect(filePanel?.instance).toEqual({
      fileTabId: 'file-1',
      filePath: '/tmp/a.ts',
    });
    expect(filePanel?.title).toBe('a.ts');

    // The chat store's active tab drives the initial panel selection.
    const layout = panelStore().layouts[KEY];
    expect(layout.activeGroupId).toBe('group-chat');
    expect(layout.groups['group-chat'].activePanelId).toBe(
      chatLocation?.panelId,
    );
  });

  test('a chat tab added later materializes its panel', () => {
    initAll([makeChatTab()], 'chat-1');
    expect(findPanelByInstanceKey(KEY, 'chat:chat-2')).toBeNull();

    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [...wc.tabs, makeChatTab({ id: 'chat-2', title: 'Second' })],
        },
      },
    });
    flushChatPanelSyncForTests();

    const location = findPanelByInstanceKey(KEY, 'chat:chat-2');
    expect(location).not.toBeNull();
    expect(
      groupChatTabs().find((tab) => tab.instance?.chatTabId === 'chat-2')
        ?.title,
    ).toBe('Second');
  });

  test('a chat created in the background joins without taking the selected panel', () => {
    // Main created chat-2 with preserveActiveTab: the canonical snapshot adds
    // the tab and keeps chat-1 active.
    initAll([makeChatTab()], 'chat-1');
    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [...wc.tabs, makeChatTab({ id: 'chat-2', title: 'Child' })],
          activeTabId: 'chat-1',
        },
      },
    });
    flushChatPanelSyncForTests();

    expect(findPanelByInstanceKey(KEY, 'chat:chat-2')).not.toBeNull();
    const parent = findPanelByInstanceKey(KEY, 'chat:chat-1');
    expect(panelStore().layouts[KEY].groups['group-chat'].activePanelId).toBe(
      parent?.panelId,
    );
    expect(switchTabMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().worktreeChats[KEY]?.activeTabId).toBe(
      'chat-1',
    );

    // The next sweep leaves both sides on the parent.
    flushChatPanelSyncForTests();
    expect(panelStore().layouts[KEY].groups['group-chat'].activePanelId).toBe(
      parent?.panelId,
    );
    expect(switchTabMock).not.toHaveBeenCalled();
  });

  test('a chat the user creates is selected and focused', () => {
    initAll([makeChatTab()], 'chat-1');
    panelStore().selectTab(KEY, 'group-terminal', 'panel-terminal');
    flushChatPanelSyncForTests();
    expect(panelStore().layouts[KEY].activeGroupId).toBe('group-terminal');
    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [...wc.tabs, makeChatTab({ id: 'chat-2', title: 'New' })],
          activeTabId: 'chat-2',
        },
      },
    });
    flushChatPanelSyncForTests();

    const created = findPanelByInstanceKey(KEY, 'chat:chat-2');
    expect(created).not.toBeNull();
    const layout = panelStore().layouts[KEY];
    expect(layout.groups[created?.groupId ?? '']?.activePanelId).toBe(
      created?.panelId,
    );
    expect(layout.activeGroupId).toBe(created?.groupId);
  });

  test('a forked chat tab materializes directly after its source panel', () => {
    initAll(
      [
        makeChatTab({ id: 'chat-1', title: 'First' }),
        makeChatTab({ id: 'chat-2', title: 'Source' }),
        makeChatTab({ id: 'chat-3', title: 'Last' }),
      ],
      'chat-1',
    );

    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [
            ...wc.tabs,
            makeChatTab({
              id: 'fork-2',
              title: 'Fork: Source',
              forkedFrom: {
                projectId: PROJECT_ID,
                worktreeId: WORKTREE_ID,
                chatId: 'chat-2',
              },
            }),
          ],
          activeTabId: 'fork-2',
        },
      },
    });
    flushChatPanelSyncForTests();

    expect(groupChatTabIds()).toEqual(['chat-1', 'chat-2', 'fork-2', 'chat-3']);
    expect(
      groupChatTabs().find((tab) => tab.instance?.chatTabId === 'fork-2')
        ?.pinned,
    ).toBeUndefined();
  });

  test('multiple forks from the same source preserve persisted sibling order', () => {
    initAll([makeChatTab({ id: 'source', title: 'Source' })], 'source');

    const wc = useChatStore.getState().worktreeChats[KEY];
    const sourceTab = wc.tabs[0];
    if (!sourceTab) {
      throw new Error('Expected source chat tab to be seeded');
    }
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [
            sourceTab,
            makeChatTab({
              id: 'fork-2',
              title: 'Fork: Source 2',
              forkedFrom: {
                projectId: PROJECT_ID,
                worktreeId: WORKTREE_ID,
                chatId: 'source',
              },
            }),
            makeChatTab({
              id: 'fork-1',
              title: 'Fork: Source 1',
              forkedFrom: {
                projectId: PROJECT_ID,
                worktreeId: WORKTREE_ID,
                chatId: 'source',
              },
            }),
          ],
          activeTabId: 'fork-1',
        },
      },
    });
    flushChatPanelSyncForTests();

    expect(groupChatTabIds()).toEqual(['source', 'fork-2', 'fork-1']);
  });

  test('a fork from a pinned chat panel inherits pinning and stays next to the source', () => {
    initAll(
      [
        makeChatTab({ id: 'chat-1', title: 'Pinned source' }),
        makeChatTab({ id: 'chat-2', title: 'Pinned neighbor' }),
        makeChatTab({ id: 'chat-3', title: 'Unpinned' }),
      ],
      'chat-1',
    );
    const sourceLocation = findPanelByInstanceKey(KEY, 'chat:chat-1');
    const neighborLocation = findPanelByInstanceKey(KEY, 'chat:chat-2');
    expect(sourceLocation).not.toBeNull();
    expect(neighborLocation).not.toBeNull();
    if (sourceLocation === null || neighborLocation === null) return;
    panelStore().setTabPinned(
      sourceLocation.layoutKey,
      sourceLocation.groupId,
      sourceLocation.panelId,
      true,
    );
    panelStore().setTabPinned(
      neighborLocation.layoutKey,
      neighborLocation.groupId,
      neighborLocation.panelId,
      true,
    );

    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [
            ...wc.tabs,
            makeChatTab({
              id: 'fork-1',
              title: 'Fork: Pinned source',
              forkedFrom: {
                projectId: PROJECT_ID,
                worktreeId: WORKTREE_ID,
                chatId: 'chat-1',
              },
            }),
          ],
          activeTabId: 'fork-1',
        },
      },
    });
    flushChatPanelSyncForTests();

    expect(groupChatTabIds()).toEqual(['chat-1', 'fork-1', 'chat-2', 'chat-3']);
    expect(
      groupChatTabs().find((tab) => tab.instance?.chatTabId === 'fork-1')
        ?.pinned,
    ).toBe(true);
  });

  test('a file tab with a chat-origin placement opens in a side group', () => {
    initAll([makeChatTab()], 'chat-1');

    requestFilePanelPlacementBesideChat('file-1', 'chat-1');
    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [...wc.tabs, makeFileTab()],
          activeTabId: 'file-1',
        },
      },
    });
    flushChatPanelSyncForTests();

    const fileLocation = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(fileLocation).not.toBeNull();
    expect(fileLocation?.groupId).not.toBe('group-chat');
    const layout = panelStore().layouts[KEY];
    const sideGroup = layout.groups[fileLocation?.groupId ?? ''];
    expect(sideGroup?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'file-diff',
          instance: { fileTabId: 'file-1', filePath: '/tmp/a.ts' },
        }),
      ]),
    );
    expect(
      layout.groups['group-chat'].tabs.some((tab) => tab.kind === 'chat'),
    ).toBe(true);
    expect(layout.groups['group-terminal'].collapsed?.edge).toBe('right');
  });

  test('a file tab with a file-sibling placement opens next to its origin file panel', () => {
    // The origin file tab has no placement hint, so its panel materializes
    // in the chat group via the MRU rule.
    initAll([makeChatTab(), makeFileTab()], 'file-1');
    const origin = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(origin).not.toBeNull();

    requestFilePanelPlacementAsSibling('file-2', 'file-1');
    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [
            ...wc.tabs,
            makeFileTab({ id: 'file-2', title: 'b.ts', filePath: '/tmp/b.ts' }),
          ],
          activeTabId: 'file-2',
        },
      },
    });
    flushChatPanelSyncForTests();

    const sibling = findPanelByInstanceKey(KEY, 'file-diff:file-2');
    expect(sibling).not.toBeNull();
    // Same group as the origin file panel, directly after it.
    expect(sibling?.groupId).toBe(origin?.groupId);
    const group = panelStore().layouts[KEY].groups[sibling?.groupId ?? ''];
    const originIndex = group.tabs.findIndex(
      (tab) => tab.panelId === origin?.panelId,
    );
    const siblingIndex = group.tabs.findIndex(
      (tab) => tab.panelId === sibling?.panelId,
    );
    expect(siblingIndex).toBe(originIndex + 1);
  });

  test('a file-sibling placement for an already-open file only activates it', () => {
    initAll([makeChatTab(), makeFileTab()], 'file-1');
    const before = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(before).not.toBeNull();

    // The "open" of an already-open file: the chat store switches tabs and
    // the hint must not move or duplicate the existing panel.
    requestFilePanelPlacementAsSibling('file-1', 'file-1');
    flushChatPanelSyncForTests();

    const after = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(after).toEqual(before);
  });

  test('ShowFiles aggressively moves existing files beside chat in requested order', () => {
    initAll(
      [
        makeChatTab(),
        makeFileTab({
          id: 'file-2',
          title: 'b.ts',
          filePath: '/tmp/b.ts',
        }),
        makeFileTab(),
      ],
      'chat-1',
    );

    expect(findPanelByInstanceKey(KEY, 'file-diff:file-1')?.groupId).toBe(
      'group-chat',
    );
    expect(findPanelByInstanceKey(KEY, 'file-diff:file-2')?.groupId).toBe(
      'group-chat',
    );

    const targetGroupId = placeFilePanelsBesideChat(
      PROJECT_ID,
      WORKTREE_ID,
      ['file-1', 'file-2'],
      'chat-1',
    );

    expect(targetGroupId).not.toBeNull();
    expect(targetGroupId).not.toBe('group-chat');
    const targetGroup =
      panelStore().layouts[KEY].groups[targetGroupId ?? 'missing'];
    expect(targetGroup.tabs.map((tab) => tab.instance?.fileTabId)).toEqual([
      'file-1',
      'file-2',
    ]);
    expect(targetGroup.activePanelId).toBe(
      findPanelByInstanceKey(KEY, 'file-diff:file-1')?.panelId,
    );
    expect(
      panelStore().layouts[KEY].groups['group-chat'].tabs.map(
        (tab) => tab.instance?.chatTabId,
      ),
    ).toContain('chat-1');
    expect(
      panelStore().layouts[KEY].groups['group-terminal'].collapsed?.edge,
    ).toBe('right');
  });

  test('background ShowFiles keeps the focused group and every selected panel (CAN-4663)', () => {
    initAll(
      [
        makeChatTab(),
        makeFileTab({
          id: 'file-2',
          title: 'b.ts',
          filePath: '/tmp/b.ts',
        }),
        makeFileTab(),
      ],
      'chat-1',
    );
    const chatPanel = findPanelByInstanceKey(KEY, 'chat:chat-1');
    const focusedGroupId = panelStore().layouts[KEY].activeGroupId;

    const targetGroupId = placeFilePanelsBesideChat(
      PROJECT_ID,
      WORKTREE_ID,
      ['file-1', 'file-2'],
      'chat-1',
      { activate: false },
    );

    expect(targetGroupId).not.toBeNull();
    expect(panelStore().layouts[KEY].activeGroupId).toBe(focusedGroupId);
    expect(panelStore().layouts[KEY].groups['group-chat'].activePanelId).toBe(
      chatPanel?.panelId,
    );

    // A later background file joins the side group without taking it over.
    const sideGroup = panelStore().layouts[KEY].groups[targetGroupId ?? ''];
    const selectedSidePanelId = sideGroup.activePanelId;
    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [
            ...wc.tabs,
            makeFileTab({ id: 'file-3', title: 'c.ts', filePath: '/tmp/c.ts' }),
          ],
        },
      },
    });
    requestFilePanelPlacementBesideChat('file-3', 'chat-1');
    flushChatPanelSyncForTests();

    expect(findPanelByInstanceKey(KEY, 'file-diff:file-3')?.groupId).toBe(
      targetGroupId,
    );
    expect(
      panelStore().layouts[KEY].groups[targetGroupId ?? ''].activePanelId,
    ).toBe(selectedSidePanelId);
    expect(panelStore().layouts[KEY].activeGroupId).toBe(focusedGroupId);
  });

  test('background placement never publishes intermediate focus changes', () => {
    initAll([makeChatTab(), makeFileTab()], 'chat-1');
    const before = panelStore().layouts[KEY];
    const focusedGroups: Array<string | null> = [];
    const selections: Array<string | null> = [];
    const unsubscribe = usePanelLayoutStore.subscribe((state) => {
      focusedGroups.push(state.layouts[KEY].activeGroupId);
      selections.push(
        state.layouts[KEY].groups['group-chat']?.activePanelId ?? null,
      );
    });
    try {
      placeFilePanelsBesideChat(PROJECT_ID, WORKTREE_ID, ['file-1'], 'chat-1', {
        activate: false,
      });
      expect(focusedGroups.every((id) => id === before.activeGroupId)).toBe(
        true,
      );
      expect(
        selections.every(
          (id) => id === before.groups['group-chat'].activePanelId,
        ),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  test('background ShowFiles never moves the panel a group is showing', () => {
    initAll([makeChatTab(), makeFileTab()], 'file-1');
    const before = findPanelByInstanceKey(KEY, 'file-diff:file-1');

    placeFilePanelsBesideChat(PROJECT_ID, WORKTREE_ID, ['file-1'], 'chat-1', {
      activate: false,
    });

    expect(findPanelByInstanceKey(KEY, 'file-diff:file-1')).toEqual(before);
  });

  test('ShowFiles consolidates files when the originating chat is on another surface', () => {
    initAll(
      [
        makeChatTab(),
        makeFileTab(),
        makeFileTab({
          id: 'file-2',
          title: 'b.ts',
          filePath: '/tmp/b.ts',
        }),
      ],
      'chat-1',
    );
    const second = findPanelByInstanceKey(KEY, 'file-diff:file-2');
    expect(second).not.toBeNull();
    panelStore().movePanel(
      KEY,
      second?.panelId ?? 'missing',
      'group-terminal',
      'center',
    );

    const targetGroupId = placeFilePanelsBesideChat(
      PROJECT_ID,
      WORKTREE_ID,
      ['file-1', 'file-2'],
      'advisor-chat-in-another-window',
    );

    expect(targetGroupId).toBe('group-chat');
    const targetGroup = panelStore().layouts[KEY].groups['group-chat'];
    expect(
      targetGroup.tabs
        .filter((tab) => tab.kind === 'file-diff')
        .map((tab) => tab.instance?.fileTabId),
    ).toEqual(['file-1', 'file-2']);
    expect(targetGroup.activePanelId).toBe(
      findPanelByInstanceKey(KEY, 'file-diff:file-1')?.panelId,
    );
  });

  test('ShowFiles rolls back a new sibling when every requested file is on another surface', () => {
    initAll([makeChatTab()], 'chat-1');
    const auxKey = makeAuxPanelLayoutKey(KEY, 'file-window');
    panelStore().initializeLayout(auxKey, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'file-diff',
          groupId: 'group-aux-file',
          panelId: 'panel-aux-file',
          title: 'a.ts',
          instance: { fileTabId: 'file-1', filePath: '/tmp/a.ts' },
        },
      ],
      containerSize: { width: 800, height: 600 },
    });
    const beforeGroupIds = Object.keys(panelStore().layouts[KEY].groups);

    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [...wc.tabs, makeFileTab()],
          activeTabId: 'file-1',
        },
      },
    });

    expect(
      placeFilePanelsBesideChat(PROJECT_ID, WORKTREE_ID, ['file-1'], 'chat-1'),
    ).toBeNull();

    expect(Object.keys(panelStore().layouts[KEY].groups)).toEqual(
      beforeGroupIds,
    );
    expect(
      panelStore().layouts[KEY].groups['group-terminal'].collapsed,
    ).toBeUndefined();
    expect(findPanelByInstanceKey(KEY, 'file-diff:file-1')).toMatchObject({
      layoutKey: auxKey,
      groupId: 'group-aux-file',
      panelId: 'panel-aux-file',
    });
  });

  test('chat-origin file placement removes empty side group when addTab rejects the seeded panel id', () => {
    initAll([makeChatTab()], 'chat-1');
    const auxKey = makeAuxPanelLayoutKey(KEY, 'duplicate-file-panel');
    panelStore().initializeLayout(auxKey, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'activity-card',
          groupId: 'group-aux-activity',
          panelId: 'panel-file-file-1',
          title: 'Other activity',
          instance: { sectionId: 'other-activity' },
        },
      ],
      containerSize: { width: 800, height: 600 },
    });
    const beforeGroupIds = Object.keys(panelStore().layouts[KEY].groups);

    requestFilePanelPlacementBesideChat('file-1', 'chat-1');
    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [...wc.tabs, makeFileTab()],
          activeTabId: 'file-1',
        },
      },
    });
    flushChatPanelSyncForTests();

    const layout = panelStore().layouts[KEY];
    expect(Object.keys(layout.groups)).toEqual(beforeGroupIds);
    const fileLocation = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(fileLocation).not.toBeNull();
    expect(fileLocation?.groupId).toBe('group-chat');
    expect(fileLocation?.panelId).not.toBe('panel-file-file-1');
    expect(
      panelStore().layouts[auxKey].groups['group-aux-activity'].tabs[0].panelId,
    ).toBe('panel-file-file-1');
    expect(
      panelStore().layouts[KEY].groups['group-terminal'].collapsed,
    ).toBeUndefined();
  });

  test('chat-origin file placement reuses an existing file side group', () => {
    initAll([makeChatTab()], 'chat-1');

    requestFilePanelPlacementBesideChat('file-1', 'chat-1');
    let wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [...wc.tabs, makeFileTab()],
          activeTabId: 'file-1',
        },
      },
    });
    flushChatPanelSyncForTests();
    const firstLocation = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(firstLocation).not.toBeNull();

    requestFilePanelPlacementBesideChat('file-2', 'chat-1');
    wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [
            ...wc.tabs,
            makeFileTab({
              id: 'file-2',
              title: 'b.ts',
              filePath: '/tmp/b.ts',
            }),
          ],
          activeTabId: 'file-2',
        },
      },
    });
    flushChatPanelSyncForTests();

    const secondLocation = findPanelByInstanceKey(KEY, 'file-diff:file-2');
    expect(secondLocation).not.toBeNull();
    expect(secondLocation?.groupId).toBe(firstLocation?.groupId);
    expect(
      panelStore().layouts[KEY].groups[secondLocation?.groupId ?? ''].tabs,
    ).toHaveLength(2);
  });

  test('chat-origin file placement reuses an existing browser side group', () => {
    initAll([makeChatTab()], 'chat-1');

    const browserGroupId = panelStore().splitGroup(KEY, 'group-chat', 'right');
    expect(browserGroupId).not.toBeNull();
    if (browserGroupId === null) return;
    expect(
      panelStore().addTab(KEY, browserGroupId, 'browser', {
        panelId: 'panel-browser-existing',
        instance: { browserId: 'browser-existing' },
      }),
    ).toBe('panel-browser-existing');

    requestFilePanelPlacementBesideChat('file-1', 'chat-1');
    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [...wc.tabs, makeFileTab()],
          activeTabId: 'file-1',
        },
      },
    });
    flushChatPanelSyncForTests();

    const fileLocation = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(fileLocation).not.toBeNull();
    expect(fileLocation?.groupId).toBe(browserGroupId);
    expect(
      panelStore().layouts[KEY].groups[browserGroupId].tabs.map(
        (tab) => tab.kind,
      ),
    ).toEqual(['browser', 'file-diff']);
    expect(
      panelStore().layouts[KEY].groups['group-terminal'].collapsed,
    ).toBeUndefined();
  });

  test('a removed chat tab closes its panel; non-chat panels stay untouched', () => {
    initAll(
      [makeChatTab(), makeChatTab({ id: 'chat-2', title: 'Second' })],
      'chat-1',
    );
    expect(findPanelByInstanceKey(KEY, 'chat:chat-2')).not.toBeNull();

    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: wc.tabs.filter((tab) => tab.id !== 'chat-2'),
        },
      },
    });
    flushChatPanelSyncForTests();

    expect(findPanelByInstanceKey(KEY, 'chat:chat-2')).toBeNull();
    // The terminal singleton and the legacy instance-less chat panel remain.
    expect(allPanelIds()).toContain('panel-terminal');
    expect(allPanelIds()).toContain('panel-chat');
    // The removal direction did NOT echo into chatStore.closeTab.
    expect(closeTabMock).not.toHaveBeenCalled();
  });

  test('a chat tab rename propagates to the panel instance title', () => {
    initAll([makeChatTab()], 'chat-1');

    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: wc.tabs.map((tab) =>
            tab.id === 'chat-1' ? { ...tab, title: 'Renamed' } : tab,
          ),
        },
      },
    });
    flushChatPanelSyncForTests();

    expect(
      groupChatTabs().find((tab) => tab.instance?.chatTabId === 'chat-1')
        ?.title,
    ).toBe('Renamed');
  });

  test('a chat-side active tab change selects the bound panel', () => {
    initAll(
      [makeChatTab(), makeChatTab({ id: 'chat-2', title: 'Second' })],
      'chat-1',
    );
    const location = findPanelByInstanceKey(KEY, 'chat:chat-2');
    expect(location).not.toBeNull();
    expect(
      panelStore().layouts[KEY].groups['group-chat'].activePanelId,
    ).not.toBe(location?.panelId);

    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: { [KEY]: { ...wc, activeTabId: 'chat-2' } },
    });
    flushChatPanelSyncForTests();

    const layout = panelStore().layouts[KEY];
    expect(layout.activeGroupId).toBe('group-chat');
    expect(layout.groups['group-chat'].activePanelId).toBe(location?.panelId);
    // The chat-driven selection did not bounce back through switchTab.
    expect(switchTabMock).not.toHaveBeenCalled();
  });

  test('a chat-side active tab change expands a collapsed group before selecting', () => {
    initAll(
      [makeChatTab(), makeChatTab({ id: 'chat-2', title: 'Second' })],
      'chat-1',
    );
    const location = findPanelByInstanceKey(KEY, 'chat:chat-2');
    expect(location).not.toBeNull();
    if (location === null) return;

    expect(panelStore().collapseGroup(KEY, 'group-chat')).toBe(true);
    expect(
      panelStore().layouts[KEY].groups['group-chat'].collapsed,
    ).toBeDefined();

    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: { [KEY]: { ...wc, activeTabId: 'chat-2' } },
    });
    flushChatPanelSyncForTests();

    expect(
      panelStore().layouts[KEY].groups['group-chat'].collapsed,
    ).toBeUndefined();
    expect(panelStore().layouts[KEY].groups['group-chat'].activePanelId).toBe(
      location.panelId,
    );
  });

  test('a hydration sweep expands an already-active collapsed group', () => {
    // Simulate a restored layout where the chat-active tab's panel is
    // ALREADY its group's active tab AND that group is already the layout's
    // active group (e.g. the user quit while focused inside a collapsed
    // group). From the bridge's point of view nothing "changed"
    // (`alreadyActive`), but the group must still be revealed.
    setChatState([makeChatTab()], 'chat-1');
    panelStore().initializeLayout(KEY, DEFAULT_LIKE_LAYOUT);
    panelStore().addTab(KEY, 'group-chat', 'chat', {
      panelId: 'panel-chat-1',
      title: 'Chat One',
      instance: { chatTabId: 'chat-1' },
    });
    expect(panelStore().collapseGroup(KEY, 'group-chat')).toBe(true);
    expect(
      panelStore().layouts[KEY].groups['group-chat'].collapsed,
    ).toBeDefined();

    initChatPanelSync();
    flushChatPanelSyncForTests();

    const layout = panelStore().layouts[KEY];
    expect(layout.groups['group-chat'].collapsed).toBeUndefined();
    expect(layout.activeGroupId).toBe('group-chat');
    expect(layout.groups['group-chat'].activePanelId).toBe('panel-chat-1');
    // Already-active reveal must not spuriously reselect/refocus via
    // switchTab (no chat-side echo).
    expect(switchTabMock).not.toHaveBeenCalled();
  });

  test('hydration re-activates the chat-active tab within its group WITHOUT stealing the active group', () => {
    // Simulate a restored layout: bound panels already exist (no
    // materialization), the chat-active tab is a background tab of its
    // group, and the restored active group is NOT the chat group.
    setChatState(
      [makeChatTab(), makeChatTab({ id: 'chat-2', title: 'Second' })],
      'chat-2',
    );
    panelStore().initializeLayout(KEY, DEFAULT_LIKE_LAYOUT);
    panelStore().addTab(KEY, 'group-chat', 'chat', {
      panelId: 'panel-chat-1',
      title: 'Chat One',
      instance: { chatTabId: 'chat-1' },
    });
    panelStore().addTab(KEY, 'group-chat', 'chat', {
      panelId: 'panel-chat-2',
      title: 'Second',
      instance: { chatTabId: 'chat-2' },
    });
    panelStore().selectTab(KEY, 'group-chat', 'panel-chat-1');
    expect(panelStore().collapseGroup(KEY, 'group-chat')).toBe(true);
    panelStore().focusGroup(KEY, 'group-terminal');

    initChatPanelSync();
    flushChatPanelSyncForTests();

    const layout = panelStore().layouts[KEY];
    // Hydration reveals the restored active chat tab without treating the
    // reveal as an interaction-driven focus change.
    expect(layout.groups['group-chat'].collapsed).toBeUndefined();
    // The chat-active tab became its group's active tab (background → front)…
    expect(layout.groups['group-chat'].activePanelId).toBe('panel-chat-2');
    // …but the restored active group was NOT clobbered by hydration.
    expect(layout.activeGroupId).toBe('group-terminal');
    // And the non-focusing selection did not echo back into switchTab.
    expect(switchTabMock).not.toHaveBeenCalled();

    // An EXPLICIT chat-side change afterwards focuses the chat group again.
    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: { [KEY]: { ...wc, activeTabId: 'chat-1' } },
    });
    flushChatPanelSyncForTests();
    expect(panelStore().layouts[KEY].activeGroupId).toBe('group-chat');
    expect(panelStore().layouts[KEY].groups['group-chat'].activePanelId).toBe(
      'panel-chat-1',
    );
  });
});

describe('panel → chat file-tab close', () => {
  test('starts the backing file-tab close synchronously before removing its panel', () => {
    initAll([makeChatTab(), makeFileTab()], 'file-1');
    const location = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(location).not.toBeNull();

    closePanelTab(
      KEY,
      location?.groupId ?? 'missing-group',
      location?.panelId ?? 'missing-panel',
    );

    expect(closeTabMock).toHaveBeenCalledWith('file-1', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(findPanelByInstanceKey(KEY, 'file-diff:file-1')).toBeNull();

    flushChatPanelSyncForTests();
    expect(findPanelByInstanceKey(KEY, 'file-diff:file-1')).toBeNull();
  });

  test('keeps the panel while the backing file-tab close is guarded', () => {
    initAll([makeChatTab(), makeFileTab()], 'file-1');
    const location = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(location).not.toBeNull();
    const guardedClose = jest.fn();
    useChatStore.setState({ closeTab: guardedClose });

    closePanelTab(
      KEY,
      location?.groupId ?? 'missing-group',
      location?.panelId ?? 'missing-panel',
    );

    expect(guardedClose).toHaveBeenCalledWith('file-1', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(findPanelByInstanceKey(KEY, 'file-diff:file-1')).toEqual(location);
  });
});

describe('panels → chat', () => {
  test('focusing a chat-bound panel switches the chat store active tab', () => {
    initAll(
      [makeChatTab(), makeChatTab({ id: 'chat-2', title: 'Second' })],
      'chat-1',
    );
    const location = findPanelByInstanceKey(KEY, 'chat:chat-2');
    expect(location).not.toBeNull();
    if (location === null) return;

    panelStore().selectTab(KEY, location.groupId, location.panelId);
    flushChatPanelSyncForTests();

    expect(switchTabMock).toHaveBeenCalledTimes(1);
    expect(switchTabMock).toHaveBeenCalledWith('chat-2', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(useChatStore.getState().worktreeChats[KEY].activeTabId).toBe(
      'chat-2',
    );
  });

  test('closing a chat-bound panel closes the chat tab (ChatTabBar close action)', () => {
    initAll(
      [makeChatTab(), makeChatTab({ id: 'chat-2', title: 'Second' })],
      'chat-1',
    );
    const location = findPanelByInstanceKey(KEY, 'chat:chat-2');
    expect(location).not.toBeNull();
    if (location === null) return;

    panelStore().closeTab(KEY, location.groupId, location.panelId);
    flushChatPanelSyncForTests();

    expect(closeTabMock).toHaveBeenCalledTimes(1);
    expect(closeTabMock).toHaveBeenCalledWith('chat-2', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(
      useChatStore
        .getState()
        .worktreeChats[KEY].tabs.some((tab) => tab.id === 'chat-2'),
    ).toBe(false);
    // Settled: the panel is not re-materialized on subsequent sweeps.
    flushChatPanelSyncForTests();
    expect(findPanelByInstanceKey(KEY, 'chat:chat-2')).toBeNull();
  });

  test('does not recreate a chat panel while its asynchronous close is pending', () => {
    const delayedClose = jest.fn((tabId: string): void => {
      useChatStore.setState((state) => ({
        closingChatTabs: {
          ...state.closingChatTabs,
          [KEY]: new Set([tabId]),
        },
      }));
    });
    useChatStore.setState({ closeTab: delayedClose });
    initAll(
      [makeChatTab(), makeChatTab({ id: 'chat-2', title: 'Second' })],
      'chat-1',
    );
    const location = findPanelByInstanceKey(KEY, 'chat:chat-2');
    expect(location).not.toBeNull();
    if (location === null) return;

    panelStore().closeTab(KEY, location.groupId, location.panelId);
    flushChatPanelSyncForTests();

    expect(delayedClose).toHaveBeenCalledWith('chat-2', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(
      useChatStore
        .getState()
        .worktreeChats[KEY].tabs.some((tab) => tab.id === 'chat-2'),
    ).toBe(true);
    expect(findPanelByInstanceKey(KEY, 'chat:chat-2')).toBeNull();

    // A failed archive clears the pending marker while leaving the chat live,
    // so reconciliation restores the panel and the user can retry.
    useChatStore.setState({ closingChatTabs: {} });
    flushChatPanelSyncForTests();
    expect(findPanelByInstanceKey(KEY, 'chat:chat-2')).not.toBeNull();
  });

  test('closing the final chat in an otherwise-empty group replaces it in place', () => {
    const layout: DefaultLayoutDescriptor = {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-1',
          instance: { chatTabId: 'chat-1' },
        },
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal',
        },
      ],
      containerSize: { width: 1200, height: 800 },
    };
    setChatState([makeChatTab()], 'chat-1');
    panelStore().initializeLayout(KEY, layout);
    initChatPanelSync();
    flushChatPanelSyncForTests();
    expect(panelStore().collapseGroup(KEY, 'group-chat')).toBe(true);
    const revisionBeforeClose = panelStore().layouts[KEY].revision;

    closePanelTab(KEY, 'group-chat', 'panel-chat-1');

    const replacedLayout = panelStore().layouts[KEY];
    expect(Object.keys(replacedLayout.groups)).toEqual([
      'group-chat',
      'group-terminal',
    ]);
    expect(replacedLayout.groups['group-chat'].tabs).toHaveLength(1);
    expect(
      replacedLayout.groups['group-chat'].tabs[0].instance?.chatTabId,
    ).toBe('chat-fresh');
    expect(replacedLayout.groups['group-chat'].collapsed?.edge).toBe('left');
    expect(replacedLayout.revision).toBe(revisionBeforeClose);

    flushChatPanelSyncForTests();

    expect(createTabMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(closeTabMock).toHaveBeenCalledWith('chat-1', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(
      useChatStore.getState().worktreeChats[KEY].tabs.map((tab) => tab.id),
    ).toEqual(['chat-fresh']);
    expect(findPanelByInstanceKey(KEY, 'chat:chat-fresh')?.groupId).toBe(
      'group-chat',
    );
  });

  test('a chat-side last-tab fallback also replaces the stale panel in place', () => {
    const layout: DefaultLayoutDescriptor = {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-1',
          instance: { chatTabId: 'chat-1' },
        },
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal',
        },
      ],
      containerSize: { width: 1200, height: 800 },
    };
    setChatState([makeChatTab()], 'chat-1');
    panelStore().initializeLayout(KEY, layout);
    initChatPanelSync();
    flushChatPanelSyncForTests();
    expect(panelStore().collapseGroup(KEY, 'group-chat')).toBe(true);
    const revisionBeforeClose = panelStore().layouts[KEY].revision;

    const fresh = makeChatTab({ id: 'chat-fresh', title: 'New Chat' });
    useChatStore.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: { tabs: [fresh], activeTabId: fresh.id },
      },
    }));
    flushChatPanelSyncForTests();

    const settled = panelStore().layouts[KEY];
    expect(Object.keys(settled.groups)).toEqual([
      'group-chat',
      'group-terminal',
    ]);
    expect(settled.groups['group-chat'].tabs).toHaveLength(1);
    expect(settled.groups['group-chat'].tabs[0].instance?.chatTabId).toBe(
      'chat-fresh',
    );
    // The active fresh chat intentionally expands its group during active-tab
    // sync, but the original grid node survives instead of being removed and
    // generically re-created elsewhere.
    expect(settled.revision).toBeGreaterThanOrEqual(revisionBeforeClose);
  });

  test('a replaced last chat is not re-materialized while its async close is pending', () => {
    // Model the real store's behaviour: a chat with history archives over an
    // async IPC round-trip, so `closeTab` does not remove the tab synchronously.
    let resolveClose: (() => void) | null = null;
    const deferredCloseTab = jest.fn((tabId: string): void => {
      resolveClose = (): void => {
        useChatStore.setState((state) => {
          const wc = state.worktreeChats[KEY];
          if (!wc) return state;
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [KEY]: { ...wc, tabs: wc.tabs.filter((t) => t.id !== tabId) },
            },
          };
        });
      };
    });

    const layout: DefaultLayoutDescriptor = {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-1',
          instance: { chatTabId: 'chat-1' },
        },
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal',
        },
      ],
      containerSize: { width: 1200, height: 800 },
    };
    setChatState([makeChatTab({ messages: [] })], 'chat-1');
    panelStore().initializeLayout(KEY, layout);
    initChatPanelSync();
    flushChatPanelSyncForTests();
    useChatStore.setState({ closeTab: deferredCloseTab });

    closePanelTab(KEY, 'group-chat', 'panel-chat-1');
    // Fresh chat took the slot immediately (no flicker of the empty group).
    expect(
      panelStore().layouts[KEY].groups['group-chat'].tabs[0].instance
        ?.chatTabId,
    ).toBe('chat-fresh');

    flushChatPanelSyncForTests();
    // The old chat's async close is in flight, so it is still in the store...
    expect(
      useChatStore
        .getState()
        .worktreeChats[KEY].tabs.some((tab) => tab.id === 'chat-1'),
    ).toBe(true);
    // ...but it must NOT be re-materialized as a second, side-by-side panel.
    expect(findPanelByInstanceKey(KEY, 'chat:chat-1')).toBeNull();
    expect(panelStore().layouts[KEY].groups['group-chat'].tabs).toHaveLength(1);

    // Once the archive resolves the old chat leaves the store and the guard is
    // pruned; nothing re-appears.
    if (resolveClose === null) throw new Error('expected a deferred close');
    resolveClose();
    flushChatPanelSyncForTests();
    expect(
      useChatStore.getState().worktreeChats[KEY].tabs.map((tab) => tab.id),
    ).toEqual(['chat-fresh']);
    expect(findPanelByInstanceKey(KEY, 'chat:chat-1')).toBeNull();
    expect(findPanelByInstanceKey(KEY, 'chat:chat-fresh')?.groupId).toBe(
      'group-chat',
    );
  });

  test('a replaced chat panel is restored when its async close times out', () => {
    jest.useFakeTimers();
    const deferredCloseTab = jest.fn();
    const layout: DefaultLayoutDescriptor = {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-1',
          instance: { chatTabId: 'chat-1' },
        },
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal',
        },
      ],
      containerSize: { width: 1200, height: 800 },
    };
    setChatState(
      [makeChatTab({ messages: [{ role: 'user', content: 'Hi' }] })],
      'chat-1',
    );
    panelStore().initializeLayout(KEY, layout);
    initChatPanelSync();
    flushChatPanelSyncForTests();
    useChatStore.setState({ closeTab: deferredCloseTab });

    closePanelTab(KEY, 'group-chat', 'panel-chat-1');
    flushChatPanelSyncForTests();
    expect(findPanelByInstanceKey(KEY, 'chat:chat-1')).toBeNull();

    jest.advanceTimersByTime(10_000);
    flushChatPanelSyncForTests();

    expect(findPanelByInstanceKey(KEY, 'chat:chat-1')).not.toBeNull();
    expect(deferredCloseTab).toHaveBeenCalledWith('chat-1', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    jest.useRealTimers();
  });

  test('a replaced chat panel is restored if the chat becomes active again', () => {
    const deferredCloseTab = jest.fn();
    const layout: DefaultLayoutDescriptor = {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-1',
          instance: { chatTabId: 'chat-1' },
        },
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal',
        },
      ],
      containerSize: { width: 1200, height: 800 },
    };
    setChatState([makeChatTab()], 'chat-1');
    panelStore().initializeLayout(KEY, layout);
    initChatPanelSync();
    flushChatPanelSyncForTests();
    useChatStore.setState({ closeTab: deferredCloseTab });

    closePanelTab(KEY, 'group-chat', 'panel-chat-1');
    flushChatPanelSyncForTests();
    expect(findPanelByInstanceKey(KEY, 'chat:chat-1')).toBeNull();

    useChatStore.setState((state) => ({
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
          ...state.worktreeChats[KEY],
          tabs: state.worktreeChats[KEY].tabs.map((tab) =>
            tab.id === 'chat-1' ? { ...tab, status: 'streaming' } : tab,
          ),
        },
      },
    }));
    flushChatPanelSyncForTests();

    expect(findPanelByInstanceKey(KEY, 'chat:chat-1')).not.toBeNull();
  });

  test('bulk final-chat close suppresses every removed chat until close settles', () => {
    const deferredCloseTab = jest.fn();
    const layout: DefaultLayoutDescriptor = {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-1',
          instance: { chatTabId: 'chat-1' },
        },
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-2',
          instance: { chatTabId: 'chat-2' },
        },
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal',
        },
      ],
      containerSize: { width: 1200, height: 800 },
    };
    setChatState(
      [makeChatTab(), makeChatTab({ id: 'chat-2', title: 'Second' })],
      'chat-1',
    );
    panelStore().initializeLayout(KEY, layout);
    initChatPanelSync();
    flushChatPanelSyncForTests();
    useChatStore.setState({ closeTab: deferredCloseTab });

    expect(groupChatTabs().map((tab) => tab.panelId)).toEqual([
      'panel-chat-1',
      'panel-chat-chat-2',
    ]);
    closePanelTabs(KEY, 'group-chat', ['panel-chat-1', 'panel-chat-chat-2']);
    expect(groupChatTabIds()).toEqual(['chat-fresh']);
    flushChatPanelSyncForTests();

    expect(deferredCloseTab).toHaveBeenCalledTimes(2);
    expect(findPanelByInstanceKey(KEY, 'chat:chat-1')).toBeNull();
    expect(findPanelByInstanceKey(KEY, 'chat:chat-2')).toBeNull();
    expect(groupChatTabIds()).toEqual(['chat-fresh']);
  });

  test('bulk close suppresses removed chats when a sibling survives', () => {
    const deferredCloseTab = jest.fn();
    const layout: DefaultLayoutDescriptor = {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-1',
          instance: { chatTabId: 'chat-1' },
        },
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-2',
          instance: { chatTabId: 'chat-2' },
        },
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-3',
          instance: { chatTabId: 'chat-3' },
        },
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal',
        },
      ],
      containerSize: { width: 1200, height: 800 },
    };
    setChatState(
      [
        makeChatTab(),
        makeChatTab({ id: 'chat-2', title: 'Second' }),
        makeChatTab({ id: 'chat-3', title: 'Third' }),
      ],
      'chat-3',
    );
    panelStore().initializeLayout(KEY, layout);
    initChatPanelSync();
    flushChatPanelSyncForTests();
    useChatStore.setState({ closeTab: deferredCloseTab });

    closePanelTabs(KEY, 'group-chat', ['panel-chat-1', 'panel-chat-chat-2']);
    expect(groupChatTabIds()).toEqual(['chat-3']);
    flushChatPanelSyncForTests();

    expect(deferredCloseTab).toHaveBeenCalledTimes(2);
    expect(findPanelByInstanceKey(KEY, 'chat:chat-1')).toBeNull();
    expect(findPanelByInstanceKey(KEY, 'chat:chat-2')).toBeNull();
    expect(groupChatTabIds()).toEqual(['chat-3']);
  });

  test('bulk close preserves an active chat while closing eligible siblings', () => {
    const layout: DefaultLayoutDescriptor = {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-1',
          instance: { chatTabId: 'chat-1' },
        },
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-2',
          instance: { chatTabId: 'chat-2' },
        },
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal',
        },
      ],
      containerSize: { width: 1200, height: 800 },
    };
    setChatState(
      [
        makeChatTab({ status: 'streaming' }),
        makeChatTab({ id: 'chat-2', title: 'Second' }),
      ],
      'chat-1',
    );
    panelStore().initializeLayout(KEY, layout);
    initChatPanelSync();
    flushChatPanelSyncForTests();

    closePanelTabs(KEY, 'group-chat', ['panel-chat-1', 'panel-chat-chat-2']);
    flushChatPanelSyncForTests();

    expect(createTabMock).not.toHaveBeenCalled();
    expect(closeTabMock).toHaveBeenCalledTimes(1);
    expect(closeTabMock).toHaveBeenCalledWith('chat-2', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(groupChatTabIds()).toEqual(['chat-1']);
    expect(
      useChatStore.getState().worktreeChats[KEY].tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);
  });

  test('closing the final chat while it is streaming is a no-op (no fresh chat, no replace)', () => {
    const layout: DefaultLayoutDescriptor = {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-1',
          instance: { chatTabId: 'chat-1' },
        },
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal',
        },
      ],
      containerSize: { width: 1200, height: 800 },
    };
    setChatState([makeChatTab({ status: 'streaming' })], 'chat-1');
    panelStore().initializeLayout(KEY, layout);
    initChatPanelSync();
    flushChatPanelSyncForTests();

    closePanelTab(KEY, 'group-chat', 'panel-chat-1');
    flushChatPanelSyncForTests();

    // The running chat keeps its panel; no replacement chat was created.
    expect(createTabMock).not.toHaveBeenCalled();
    expect(closeTabMock).not.toHaveBeenCalled();
    expect(
      panelStore().layouts[KEY].groups['group-chat'].tabs[0].instance
        ?.chatTabId,
    ).toBe('chat-1');
    expect(
      useChatStore.getState().worktreeChats[KEY].tabs.map((tab) => tab.id),
    ).toEqual(['chat-1']);
  });

  test('loop guard: propagation settles without recursive dispatches', () => {
    initAll(
      [makeChatTab(), makeChatTab({ id: 'chat-2', title: 'Second' })],
      'chat-1',
    );
    const location = findPanelByInstanceKey(KEY, 'chat:chat-2');
    if (location === null) {
      throw new Error('expected chat-2 panel');
    }

    panelStore().closeTab(KEY, location.groupId, location.panelId);
    flushChatPanelSyncForTests();
    // Drain any re-scheduled sweeps: dispatch counts must not grow.
    flushChatPanelSyncForTests();
    flushChatPanelSyncForTests();

    expect(closeTabMock).toHaveBeenCalledTimes(1);
    expect(switchTabMock).not.toHaveBeenCalled();

    // Same for the focus direction.
    const first = findPanelByInstanceKey(KEY, 'chat:chat-1');
    if (first === null) {
      throw new Error('expected chat-1 panel');
    }
    panelStore().selectTab(KEY, first.groupId, first.panelId);
    flushChatPanelSyncForTests();
    flushChatPanelSyncForTests();
    expect(switchTabMock).toHaveBeenCalledTimes(0);
    // chat-1 was already the chat-side active tab, so no dispatch at all.
    expect(useChatStore.getState().worktreeChats[KEY].activeTabId).toBe(
      'chat-1',
    );
  });

  test('init is idempotent (double init installs one subscription set)', () => {
    initAll([makeChatTab()], 'chat-1');
    initChatPanelSync();

    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [...wc.tabs, makeChatTab({ id: 'chat-2', title: 'Second' })],
        },
      },
    });
    flushChatPanelSyncForTests();
    flushChatPanelSyncForTests();

    // Exactly one panel was materialized for chat-2 (no duplicate adds).
    const bound = allPanelIds().filter((panelId) => {
      const tab = groupChatTabs().find(
        (candidate) => candidate.panelId === panelId,
      );
      return tab?.instance?.chatTabId === 'chat-2';
    });
    expect(bound).toHaveLength(1);
  });
});

describe('busy chat panel closes', () => {
  const DELEGATES_NOTICE =
    'Delegates are still running. Stop them in Agent activity to close this chat.';
  const originalAddToast = useGitHubStore.getState().addToast;
  const addToastMock = jest.fn();

  const TWO_CHAT_LAYOUT: DefaultLayoutDescriptor = {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-chat',
        panelId: 'panel-chat-1',
        instance: { chatTabId: 'chat-1' },
      },
      {
        kind: 'terminal',
        groupId: 'group-terminal',
        panelId: 'panel-terminal',
      },
    ],
    containerSize: { width: 1200, height: 800 },
  };

  function setLiveDelegates(chatId: string, live: number): void {
    useDelegationActivityStore.getState().applyActivity({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      live,
      queued: 0,
    });
  }

  /** chat-1 and chat-2 share the chat group beside a terminal group. */
  function initTwoChats(chat1: ChatTab): void {
    setChatState(
      [chat1, makeChatTab({ id: 'chat-2', title: 'Second' })],
      'chat-1',
    );
    panelStore().initializeLayout(KEY, TWO_CHAT_LAYOUT);
    initChatPanelSync();
    flushChatPanelSyncForTests();
    expect(groupChatTabIds()).toEqual(['chat-1', 'chat-2']);
  }

  beforeEach(() => {
    useGitHubStore.setState({ toasts: [], addToast: addToastMock });
  });

  afterEach(() => {
    resetDelegationActivityStoreForTests();
    useGitHubStore.setState({ addToast: originalAddToast });
    addToastMock.mockReset();
  });

  test('the panel × refuses an idle chat with live delegates before removing its panel', () => {
    initTwoChats(makeChatTab());
    setLiveDelegates('chat-1', 1);

    closePanelTab(KEY, 'group-chat', 'panel-chat-1');
    flushChatPanelSyncForTests();

    expect(closeTabMock).not.toHaveBeenCalled();
    expect(groupChatTabIds()).toEqual(['chat-1', 'chat-2']);
    expect(addToastMock).toHaveBeenCalledWith(
      DELEGATES_NOTICE,
      'info',
      undefined,
      expect.objectContaining({ forceInApp: true }),
    );

    // Once the delegates finish, the same close goes through.
    setLiveDelegates('chat-1', 0);
    closePanelTab(KEY, 'group-chat', 'panel-chat-1');
    flushChatPanelSyncForTests();
    expect(closeTabMock).toHaveBeenCalledWith('chat-1', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
  });

  test('the panel × refuses a streaming chat before removing its panel', () => {
    initTwoChats(makeChatTab({ status: 'streaming' }));

    closePanelTab(KEY, 'group-chat', 'panel-chat-1');
    flushChatPanelSyncForTests();

    expect(closeTabMock).not.toHaveBeenCalled();
    expect(groupChatTabIds()).toEqual(['chat-1', 'chat-2']);
    // The spinner already says why; no delegate notice.
    expect(addToastMock).not.toHaveBeenCalled();
  });

  test('Close group keeps a busy chat open in its group and closes the rest', () => {
    initTwoChats(makeChatTab());
    setLiveDelegates('chat-1', 1);

    closePanelGroup(KEY, 'group-chat');
    flushChatPanelSyncForTests();

    expect(Object.keys(panelStore().layouts[KEY].groups)).toContain(
      'group-chat',
    );
    expect(groupChatTabIds()).toEqual(['chat-1']);
    expect(closeTabMock).toHaveBeenCalledTimes(1);
    expect(closeTabMock).toHaveBeenCalledWith('chat-2', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(addToastMock).toHaveBeenCalledWith(
      DELEGATES_NOTICE,
      'info',
      undefined,
      expect.anything(),
    );
  });

  test('a store-level group close (panel command, App Advisor) keeps a busy chat open', () => {
    initTwoChats(makeChatTab());
    setLiveDelegates('chat-1', 1);

    const closed = panelStore().closeGroup(KEY, 'group-chat');
    flushChatPanelSyncForTests();

    expect(closed).toBe(false);
    expect(groupChatTabIds()).toEqual(['chat-1']);
    expect(closeTabMock).not.toHaveBeenCalledWith('chat-1', expect.anything());
  });

  test('Close group still removes a group with no busy chat', () => {
    initTwoChats(makeChatTab());

    closePanelGroup(KEY, 'group-chat');
    flushChatPanelSyncForTests();

    expect(Object.keys(panelStore().layouts[KEY]?.groups ?? {})).not.toContain(
      'group-chat',
    );
  });
});

describe('collapsed-chat unread bridge', () => {
  test('collapsing a bound chat feeds hiddenChatTabIds; expanding reveals and marks it read', () => {
    initAll([makeChatTab()], 'chat-1');
    const location = findPanelByInstanceKey(KEY, 'chat:chat-1');
    expect(location).not.toBeNull();
    const groupId = location?.groupId ?? '';

    // Collapse the group holding the active chat → the chat becomes hidden.
    expect(panelStore().collapseGroup(KEY, groupId)).toBe(true);
    flushChatPanelSyncForTests();
    expect(Array.from(useChatStore.getState().hiddenChatTabIds)).toContain(
      'chat-1',
    );
    // The collapsed group's view model reports no active panel.
    expect(panelStore().layouts[KEY]?.viewModel.groups).toContainEqual(
      expect.objectContaining({ groupId, activePanelId: null }),
    );

    switchTabMock.mockClear();

    // Expand → the revealed, still-active chat is marked read via switchTab.
    panelStore().expandGroup(KEY, groupId);
    flushChatPanelSyncForTests();
    expect(useChatStore.getState().hiddenChatTabIds.has('chat-1')).toBe(false);
    expect(switchTabMock).toHaveBeenCalledWith('chat-1', {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
  });

  test('hiddenChatTabIds stays empty when nothing is collapsed', () => {
    initAll([makeChatTab()], 'chat-1');
    expect(useChatStore.getState().hiddenChatTabIds.size).toBe(0);
  });
});

describe('Change Diagram opener', () => {
  const DIAGRAM_PANEL_ID = `change-diagram-${KEY}`;
  const disposers: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    usePanelWindowsStore.setState({ auxWindows: {} });
    setPanelLayoutFixedTopology(KEY, false);
  });

  function diagramLocation(): PanelInstanceLocation | null {
    return findPanelByInstanceKey(KEY, 'change-diagram');
  }

  /** A real (iframe-backed) jsdom window standing in for an aux child window. */
  function createChildWindow(): Window {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    disposers.push((): void => {
      frame.remove();
    });
    const childWindow = frame.contentWindow;
    if (childWindow === null) {
      throw new Error('Expected the test iframe to expose a window');
    }
    return childWindow;
  }

  /** Opens a file tab beside `chat-1` so a reusable content group exists. */
  function openFileBesideChat(): PanelInstanceLocation {
    requestFilePanelPlacementBesideChat('file-1', 'chat-1');
    const wc = useChatStore.getState().worktreeChats[KEY];
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          ...wc,
          tabs: [...wc.tabs, makeFileTab()],
          activeTabId: 'file-1',
        },
      },
    });
    flushChatPanelSyncForTests();
    const location = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    if (location === null) throw new Error('Expected the file panel to open');
    return location;
  }

  /** An aux-layout panel holding the diagram's seeded id makes that id fail. */
  function occupyDiagramPanelIdInAuxLayout(): void {
    panelStore().initializeLayout(makeAuxPanelLayoutKey(KEY, 'id-holder'), {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'activity-card',
          groupId: 'group-aux-activity',
          panelId: DIAGRAM_PANEL_ID,
          title: 'Other activity',
          instance: { sectionId: 'other-activity' },
        },
      ],
      containerSize: { width: 800, height: 600 },
    });
  }

  test('revealing an existing diagram exits another group maximize and activates it', async () => {
    initAll([makeChatTab()], 'chat-1');
    await openChangeDiagram(KEY);
    const placed = diagramLocation();
    expect(placed).toMatchObject({ layoutKey: KEY, groupId: 'group-chat' });
    panelStore().maximizeGroup(KEY, 'group-terminal', true);
    expect(panelStore().layouts[KEY].maximizedGroupId).toBe('group-terminal');

    await openChangeDiagram(KEY);

    const layout = panelStore().layouts[KEY];
    expect(layout.maximizedGroupId).toBeNull();
    expect(layout.activeGroupId).toBe('group-chat');
    expect(layout.groups['group-chat'].activePanelId).toBe(placed?.panelId);
    expect(diagramLocation()).toEqual(placed);
  });

  test('revealing a diagram inside the maximized group keeps that maximize', async () => {
    initAll([makeChatTab()], 'chat-1');
    await openChangeDiagram(KEY);
    const placed = diagramLocation();
    panelStore().maximizeGroup(KEY, 'group-chat', true);
    panelStore().selectTab(KEY, 'group-chat', 'panel-chat');

    await openChangeDiagram(KEY);

    const layout = panelStore().layouts[KEY];
    expect(layout.maximizedGroupId).toBe('group-chat');
    expect(layout.groups['group-chat'].activePanelId).toBe(placed?.panelId);
  });

  test('revealing a diagram in a collapsed group expands it', async () => {
    initAll([makeChatTab()], 'chat-1');
    await openChangeDiagram(KEY);
    const placed = diagramLocation();
    expect(panelStore().collapseGroup(KEY, 'group-chat')).toBe(true);

    await openChangeDiagram(KEY);

    const layout = panelStore().layouts[KEY];
    expect(layout.groups['group-chat'].collapsed).toBeUndefined();
    expect(layout.groups['group-chat'].activePanelId).toBe(placed?.panelId);
    expect(layout.activeGroupId).toBe('group-chat');
  });

  test('a new diagram without an origin exits a conflicting maximize', async () => {
    initAll([makeChatTab()], 'chat-1');
    panelStore().maximizeGroup(KEY, 'group-terminal', true);

    await openChangeDiagram(KEY);

    const placed = diagramLocation();
    expect(placed).toMatchObject({ layoutKey: KEY, groupId: 'group-chat' });
    const layout = panelStore().layouts[KEY];
    expect(layout.maximizedGroupId).toBeNull();
    expect(layout.activeGroupId).toBe('group-chat');
    expect(layout.groups['group-chat'].activePanelId).toBe(placed?.panelId);
  });

  test('a chat origin reuses the file side group with the deterministic id', async () => {
    initAll([makeChatTab()], 'chat-1');
    const file = openFileBesideChat();
    expect(file.groupId).not.toBe('group-chat');

    await openChangeDiagram(KEY, { chatTabId: 'chat-1' });

    expect(diagramLocation()).toEqual({
      layoutKey: KEY,
      groupId: file.groupId,
      panelId: DIAGRAM_PANEL_ID,
    });
    const layout = panelStore().layouts[KEY];
    expect(layout.groups[file.groupId].activePanelId).toBe(DIAGRAM_PANEL_ID);
    expect(layout.activeGroupId).toBe(file.groupId);
  });

  test('a file origin places the diagram directly after the origin file', async () => {
    initAll([makeChatTab(), makeFileTab()], 'file-1');
    const origin = findPanelByInstanceKey(KEY, 'file-diff:file-1');
    expect(origin).not.toBeNull();

    await openChangeDiagram(KEY, { fileTabId: 'file-1' });

    const placed = diagramLocation();
    expect(placed).toEqual({
      layoutKey: KEY,
      groupId: origin?.groupId,
      panelId: DIAGRAM_PANEL_ID,
    });
    const tabs = panelStore().layouts[KEY].groups[origin?.groupId ?? ''].tabs;
    const originIndex = tabs.findIndex(
      (tab) => tab.panelId === origin?.panelId,
    );
    expect(tabs.findIndex((tab) => tab.panelId === DIAGRAM_PANEL_ID)).toBe(
      originIndex + 1,
    );
  });

  test('a failed beside-chat split rolls back before falling back to the chat group', async () => {
    initAll([makeChatTab()], 'chat-1');
    occupyDiagramPanelIdInAuxLayout();
    const beforeGroupIds = Object.keys(panelStore().layouts[KEY].groups);

    await openChangeDiagram(KEY, { chatTabId: 'chat-1' });

    const layout = panelStore().layouts[KEY];
    expect(Object.keys(layout.groups)).toEqual(beforeGroupIds);
    expect(layout.groups['group-terminal'].collapsed).toBeUndefined();
    const placed = diagramLocation();
    expect(placed).toMatchObject({ layoutKey: KEY, groupId: 'group-chat' });
    expect(placed?.panelId).not.toBe(DIAGRAM_PANEL_ID);
    expect(layout.groups['group-chat'].activePanelId).toBe(placed?.panelId);
  });

  test('a failed beside-chat split restores the origin group maximize', async () => {
    initAll([makeChatTab()], 'chat-1');
    occupyDiagramPanelIdInAuxLayout();
    panelStore().maximizeGroup(KEY, 'group-chat', true);

    await openChangeDiagram(KEY, { chatTabId: 'chat-1' });

    const layout = panelStore().layouts[KEY];
    expect(layout.maximizedGroupId).toBe('group-chat');
    expect(layout.groups['group-terminal'].collapsed).toBeUndefined();
    expect(diagramLocation()).toMatchObject({
      layoutKey: KEY,
      groupId: 'group-chat',
    });
  });

  test('a fallback placement uses the deterministic diagram panel id', async () => {
    initAll([makeChatTab()], 'chat-1');

    await openChangeDiagram(KEY);

    expect(diagramLocation()).toEqual({
      layoutKey: KEY,
      groupId: 'group-chat',
      panelId: DIAGRAM_PANEL_ID,
    });
    const diagram = groupChatTabs().find(
      (tab) => tab.panelId === DIAGRAM_PANEL_ID,
    );
    expect(diagram).toMatchObject({
      kind: 'change-diagram',
      title: 'Change Diagram',
    });
    expect(diagram?.instance).toBeUndefined();
  });

  test('Minimal mode places a new diagram in the Side Panel group', async () => {
    setChatState([makeChatTab()], 'chat-1');
    panelStore().initializeLayout(KEY, MINIMAL_LIKE_LAYOUT);
    useWorkspaceLayoutModeStore.setState({
      entries: {
        [KEY]: { mode: 'minimal', status: 'ready', requestId: 1 },
      },
    });

    await openChangeDiagram(KEY);

    expect(diagramLocation()).toMatchObject({
      layoutKey: KEY,
      groupId: 'group-extras',
    });
  });

  test('revealing a diagram hosted in an auxiliary window focuses that window', async () => {
    initAll([makeChatTab()], 'chat-1');
    const auxKey = makeAuxPanelLayoutKey(KEY, 'aux-1');
    panelStore().initializeLayout(auxKey, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'terminal',
          groupId: 'group-aux',
          panelId: 'panel-aux-terminal',
          instance: { terminalId: 'term-aux' },
        },
      ],
      containerSize: { width: 800, height: 600 },
    });
    expect(
      panelStore().addTab(auxKey, 'group-aux', 'change-diagram', {
        panelId: 'panel-aux-diagram',
        title: 'Change Diagram',
      }),
    ).toBe('panel-aux-diagram');
    panelStore().selectTab(auxKey, 'group-aux', 'panel-aux-terminal');
    const childWindow = createChildWindow();
    const focus = jest
      .spyOn(childWindow, 'focus')
      .mockImplementation((): void => undefined);
    usePanelWindowsStore.setState({
      auxWindows: {
        'aux-1': {
          auxWindowId: 'aux-1',
          worktreeKey: KEY,
          layoutKey: auxKey,
          sourceGroupId: 'group-terminal',
          childWindow,
          status: 'open',
          focusOnOpen: false,
        },
      },
    });

    await openChangeDiagram(KEY);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(diagramLocation()).toEqual({
      layoutKey: auxKey,
      groupId: 'group-aux',
      panelId: 'panel-aux-diagram',
    });
    expect(panelStore().layouts[auxKey].groups['group-aux'].activePanelId).toBe(
      'panel-aux-diagram',
    );
  });
});

describe('openContentPanel', () => {
  const DIAGRAM_SEED = {
    kind: 'change-diagram',
    panelId: `change-diagram-${KEY}`,
    title: 'Change Diagram',
    instance: {},
  } as const;

  const FIXED_LIKE_LAYOUT: DefaultLayoutDescriptor = {
    orientation: 'horizontal',
    groups: [
      { kind: 'chat', groupId: 'group-chat', panelId: 'panel-chat' },
      {
        kind: 'activity-section',
        groupId: 'group-extras',
        panelId: 'panel-activity',
      },
      {
        kind: 'terminal',
        groupId: 'group-terminal',
        panelId: 'panel-terminal',
      },
    ],
    containerSize: { width: 1200, height: 800 },
  };

  afterEach(() => {
    setPanelLayoutFixedTopology(KEY, false);
  });

  /** Tab ids per group, for asserting that nothing changed. */
  function tabIdsByGroup(): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(panelStore().layouts[KEY]?.groups ?? {}).map(
        ([groupId, group]) => [groupId, group.tabs.map((tab) => tab.panelId)],
      ),
    );
  }

  test('an explicit group intent places the panel there even with a chat origin', async () => {
    initAll([makeChatTab()], 'chat-1');

    const result = await openContentPanel(KEY, DIAGRAM_SEED, {
      origin: { chatTabId: 'chat-1' },
      intent: { kind: 'group', groupId: 'group-terminal' },
    });

    const location = {
      layoutKey: KEY,
      groupId: 'group-terminal',
      panelId: DIAGRAM_SEED.panelId,
    };
    expect(result).toEqual({ status: 'placed', location });
    expect(findPanelByInstanceKey(KEY, 'change-diagram')).toEqual(location);
    const layout = panelStore().layouts[KEY];
    expect(Object.keys(layout.groups)).toEqual([
      'group-chat',
      'group-terminal',
    ]);
    expect(layout.activeGroupId).toBe('group-terminal');
    expect(layout.groups['group-terminal'].activePanelId).toBe(
      DIAGRAM_SEED.panelId,
    );
  });

  test('an explicit group intent reveals an instance open elsewhere without moving it', async () => {
    initAll([makeChatTab()], 'chat-1');
    await openChangeDiagram(KEY);
    const placed = findPanelByInstanceKey(KEY, 'change-diagram');
    expect(placed?.groupId).toBe('group-chat');
    panelStore().focusGroup(KEY, 'group-terminal');

    const result = await openContentPanel(KEY, DIAGRAM_SEED, {
      intent: { kind: 'group', groupId: 'group-terminal' },
    });

    expect(result).toEqual({ status: 'revealed', location: placed });
    expect(findPanelByInstanceKey(KEY, 'change-diagram')).toEqual(placed);
    expect(panelStore().layouts[KEY].activeGroupId).toBe('group-chat');
  });

  test('an explicit group intent in a fixed topology fails without changes when the group rejects content', async () => {
    panelStore().initializeLayout(KEY, FIXED_LIKE_LAYOUT);
    setPanelLayoutFixedTopology(KEY, true);
    const before = tabIdsByGroup();

    const result = await openContentPanel(KEY, DIAGRAM_SEED, {
      intent: { kind: 'group', groupId: 'group-chat' },
    });

    expect(result).toEqual({ status: 'failed' });
    expect(tabIdsByGroup()).toEqual(before);
    expect(findPanelByInstanceKey(KEY, 'change-diagram')).toBeNull();
  });

  test.each(['group-extras', 'group-terminal'])(
    'an explicit group intent in a fixed topology places content in %s',
    async (groupId) => {
      panelStore().initializeLayout(KEY, FIXED_LIKE_LAYOUT);
      setPanelLayoutFixedTopology(KEY, true);

      const result = await openContentPanel(KEY, DIAGRAM_SEED, {
        intent: { kind: 'group', groupId },
      });

      expect(result).toEqual({
        status: 'placed',
        location: { layoutKey: KEY, groupId, panelId: DIAGRAM_SEED.panelId },
      });
    },
  );

  test('an explicit group intent outside the worktree layout family fails', async () => {
    initAll([makeChatTab()], 'chat-1');
    const otherKey = 'project-2/worktree-2';
    panelStore().initializeLayout(otherKey, DEFAULT_LIKE_LAYOUT);
    const before = tabIdsByGroup();

    const result = await openContentPanel(KEY, DIAGRAM_SEED, {
      intent: { kind: 'group', groupId: 'group-chat', layoutKey: otherKey },
    });

    expect(result).toEqual({ status: 'failed' });
    expect(tabIdsByGroup()).toEqual(before);
    expect(
      Object.values(panelStore().layouts[otherKey].groups).flatMap((group) =>
        group.tabs.filter((tab) => tab.kind === 'change-diagram'),
      ),
    ).toEqual([]);
  });

  test('keys identity on the seed instance and passes a non-empty instance through', async () => {
    initAll([makeChatTab()], 'chat-1');
    const seed = {
      kind: 'activity-card',
      panelId: 'panel-activity-card-notes',
      title: 'Notes',
      instance: { sectionId: 'notes' },
    } as const;

    const location = {
      layoutKey: KEY,
      groupId: 'group-chat',
      panelId: 'panel-activity-card-notes',
    };

    await expect(openContentPanel(KEY, seed)).resolves.toEqual({
      status: 'placed',
      location,
    });
    await expect(
      openContentPanel(KEY, {
        ...seed,
        panelId: 'panel-activity-card-notes-again',
      }),
    ).resolves.toEqual({ status: 'revealed', location });
    expect(
      groupChatTabs().find((tab) => tab.panelId === seed.panelId)?.instance,
    ).toEqual({ sectionId: 'notes' });
  });

  test('reports unavailable when the worktree layout cannot be hydrated', async () => {
    jest.mocked(ensureWorktreePanelLayout).mockResolvedValue(undefined);

    const result = await openContentPanel(KEY, DIAGRAM_SEED);

    expect(ensureWorktreePanelLayout).toHaveBeenCalledWith(KEY);
    expect(result).toEqual({ status: 'unavailable' });
  });
});
