/** @jest-environment jsdom */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

/**
 * Plan panel open/split/reveal, exercised against the REAL panel layout,
 * activity, chat, and plan view stores (the chat-panel-sync.test.ts
 * posture). Only layout hydration and the plan fetch IPC are faked.
 */
import {
  STANDALONE_CHAT_PROJECT_ID,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import type { ISerializedPanelNode } from '@canopy/protocol';
import { useActivityStore } from '@/stores/activityStore';
import { useActivitySectionRevealStore } from '@/stores/activitySectionRevealStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import {
  findPanelByInstanceKey,
  makeAuxPanelLayoutKey,
  setPanelLayoutFixedTopology,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import {
  planViewKey,
  resetPlanViewStoreForTests,
  usePlanViewStore,
} from '@/stores/planViewStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import {
  isActivityCardOpen,
  useActivityCardStore,
} from '@/stores/activityCardStore';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import {
  openPlanDiagramPanel,
  openPlanPanel,
  planPanelOriginForWorktree,
  revealPlanDiagram,
  revealPlanDiagramNode,
  revealWorktreeActivityPanel,
  revealWorktreeChatPanel,
  splitPlanDiagram,
} from '../plan-panel-open';
import {
  flushChatPanelSyncForTests,
  initChatPanelSync,
  resetChatPanelSyncForTests,
} from '../chat-panel-sync';

jest.mock('../persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(),
}));

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const SCOPE = { projectId: PROJECT_ID, worktreeId: WORKTREE_ID };
const VIEW_KEY = planViewKey(PROJECT_ID, WORKTREE_ID, 'plan-1');
const AUX_KEY = makeAuxPanelLayoutKey(KEY, 'aux-1');

let getPlanMock: jest.Mock;

function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    source: 'claude',
    title: 'Importer plan',
    content: '# Importer plan\n\nBody',
    reviewStatus: 'pending',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

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
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    ...overrides,
  };
}

const ADVANCED_LAYOUT: DefaultLayoutDescriptor = {
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
  containerSize: { width: 1600, height: 800 },
};

const MINIMAL_LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-chat',
      panelId: 'panel-chat-chat-1',
      instance: { chatTabId: 'chat-1' },
    },
    {
      kind: 'activity-section',
      groupId: 'group-extras',
      panelId: 'panel-activity',
    },
    { kind: 'terminal', groupId: 'group-terminal', panelId: 'panel-terminal' },
  ],
  containerSize: { width: 1600, height: 800 },
};

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function seedPlans(plans: TrackedPlanData[] = [makePlan()]): void {
  useActivityStore.setState({
    trackedPlans: { [KEY]: plans },
    trackedPlanInventoryLoaded: { [KEY]: true },
  });
}

/** Adds the plan's document panel to `groupId` of `layoutKey`. */
function addDocument(groupId: string, layoutKey = KEY): void {
  store().addTab(layoutKey, groupId, 'plan', {
    panelId: 'panel-plan-plan-1',
    title: 'Importer plan',
    instance: { planId: 'plan-1' },
  });
}

/** Group ids of the main layout in grid (left-to-right) order. */
function leafGroupOrder(layoutKey = KEY): string[] {
  const serialized = store().serializeLayout(layoutKey);
  const walk = (node: ISerializedPanelNode): string[] =>
    node.type === 'leaf'
      ? [node.groupId]
      : node.children.flatMap((child) => walk(child));
  return serialized ? walk(serialized.grid.root) : [];
}

function tabIdsByGroup(layoutKey = KEY): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(store().layouts[layoutKey]?.groups ?? {}).map(
      ([groupId, group]) => [groupId, group.tabs.map((tab) => tab.panelId)],
    ),
  );
}

function countPlanPanels(kind: 'plan' | 'plan-diagram'): number {
  return Object.values(store().layouts).reduce(
    (count, layout) =>
      count +
      Object.values(layout.groups).reduce(
        (groupCount, group) =>
          groupCount + group.tabs.filter((tab) => tab.kind === kind).length,
        0,
      ),
    0,
  );
}

beforeEach(() => {
  getPlanMock = jest.fn().mockResolvedValue(null);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { activity: { plans: { get: getPlanMock } } },
  });
  seedPlans();
});

afterEach(() => {
  for (const key of Object.keys(store().layouts)) {
    store().disposeLayout(key);
  }
  setPanelLayoutFixedTopology(KEY, false);
  useWorkspaceLayoutModeStore.setState({ entries: {} });
  useActivityStore.setState({
    trackedPlans: {},
    trackedPlanInventoryLoaded: {},
  });
  useChatStore.setState({ worktreeChats: {}, selectedWorktree: null });
  resetPlanViewStoreForTests();
});

describe('openPlanPanel', () => {
  test('a group intent places the document in that group, titled by the plan', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);

    const result = await openPlanPanel(SCOPE, 'plan-1', {
      intent: { groupId: 'group-terminal' },
    });

    const location = {
      layoutKey: KEY,
      groupId: 'group-terminal',
      panelId: 'panel-plan-plan-1',
    };
    expect(result).toEqual({ status: 'placed', location });
    const tab = store().layouts[KEY].groups['group-terminal'].tabs.find(
      (candidate) => candidate.panelId === location.panelId,
    );
    expect(tab).toMatchObject({
      kind: 'plan',
      title: 'Importer plan',
      instance: { planId: 'plan-1' },
    });
    expect(store().layouts[KEY].activeGroupId).toBe('group-terminal');
  });

  test('an auto open from a chat places the document beside that chat', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);

    const result = await openPlanPanel(SCOPE, 'plan-1', {
      origin: { chatTabId: 'chat-1' },
    });

    expect(result.status).toBe('placed');
    const placed = findPanelByInstanceKey(KEY, 'plan:plan-1');
    expect(placed?.groupId).not.toBe('group-chat');
    expect(placed?.groupId).not.toBe('group-terminal');
    expect(leafGroupOrder().indexOf(placed?.groupId ?? '')).toBe(1);
  });

  test('reveals an open document where it is, exiting another group’s maximize', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    addDocument('group-terminal');
    store().maximizeGroup(KEY, 'group-chat', true);
    const before = tabIdsByGroup();

    const result = await openPlanPanel(SCOPE, 'plan-1', {
      intent: { groupId: 'group-chat' },
    });

    expect(result).toEqual({
      status: 'revealed',
      location: {
        layoutKey: KEY,
        groupId: 'group-terminal',
        panelId: 'panel-plan-plan-1',
      },
    });
    expect(tabIdsByGroup()).toEqual(before);
    expect(store().layouts[KEY].maximizedGroupId).toBeNull();
    expect(store().layouts[KEY].activeGroupId).toBe('group-terminal');
    expect(countPlanPanels('plan')).toBe(1);
  });

  test('reasserts the Document tab of an open combined panel', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    addDocument('group-terminal');
    usePlanViewStore.getState().acquire(VIEW_KEY);
    usePlanViewStore.getState().setInnerTab(VIEW_KEY, 'diagram');

    await openPlanPanel(SCOPE, 'plan-1');

    expect(usePlanViewStore.getState().entries[VIEW_KEY]?.innerTab).toBe(
      'document',
    );
  });

  test('recreates a closed document in the menu group and leaves the diagram alone', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    const diagramGroup = store().splitGroup(KEY, 'group-terminal', 'right', {
      kind: 'plan-diagram',
      panelId: 'panel-plan-diagram-plan-1',
      title: 'Importer plan (Diagram)',
      instance: { planId: 'plan-1' },
    });

    const result = await openPlanPanel(SCOPE, 'plan-1', {
      intent: { groupId: 'group-chat' },
    });

    expect(result.status).toBe('placed');
    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')?.groupId).toBe(
      'group-chat',
    );
    expect(findPanelByInstanceKey(KEY, 'plan-diagram:plan-1')?.groupId).toBe(
      diagramGroup,
    );
    expect(countPlanPanels('plan-diagram')).toBe(1);
  });

  test('opens in a group of an auxiliary window of the owning worktree', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    store().initializeLayout(AUX_KEY, {
      orientation: 'horizontal',
      groups: [{ kind: 'terminal', groupId: 'group-aux', panelId: 'aux-t' }],
    });

    const result = await openPlanPanel(SCOPE, 'plan-1', {
      intent: { groupId: 'group-aux', layoutKey: AUX_KEY },
    });

    expect(result).toEqual({
      status: 'placed',
      location: {
        layoutKey: AUX_KEY,
        groupId: 'group-aux',
        panelId: 'panel-plan-plan-1',
      },
    });
  });

  test('fetches a plan that is not in the store yet', async () => {
    useActivityStore.setState({
      trackedPlans: {},
      trackedPlanInventoryLoaded: {},
    });
    getPlanMock.mockResolvedValue(makePlan({ title: 'Fetched plan' }));
    store().initializeLayout(KEY, ADVANCED_LAYOUT);

    const result = await openPlanPanel(SCOPE, 'plan-1', {
      intent: { groupId: 'group-terminal' },
    });

    expect(result.status).toBe('placed');
    expect(getPlanMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      planId: 'plan-1',
    });
    expect(
      store().layouts[KEY].groups['group-terminal'].tabs.find(
        (tab) => tab.kind === 'plan',
      )?.title,
    ).toBe('Fetched plan');
  });

  test('is unavailable when the plan does not exist', async () => {
    useActivityStore.setState({
      trackedPlans: {},
      trackedPlanInventoryLoaded: {},
    });
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    const before = tabIdsByGroup();

    await expect(
      openPlanPanel(SCOPE, 'plan-1', { intent: { groupId: 'group-chat' } }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(tabIdsByGroup()).toEqual(before);
  });

  test('is unavailable in a scope that has no plans', async () => {
    const coworkKey = `${STANDALONE_CHAT_PROJECT_ID}/entry-1`;
    store().initializeLayout(coworkKey, ADVANCED_LAYOUT);

    await expect(
      openPlanPanel(
        { projectId: STANDALONE_CHAT_PROJECT_ID, worktreeId: 'entry-1' },
        'plan-1',
        { intent: { groupId: 'group-chat' } },
      ),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(getPlanMock).not.toHaveBeenCalled();
    expect(countPlanPanels('plan')).toBe(0);
  });
});

describe('splitPlanDiagram', () => {
  test('splits the diagram into a new group right of the document', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    addDocument('group-chat');
    usePlanViewStore.getState().acquire(VIEW_KEY);
    usePlanViewStore.getState().setInnerTab(VIEW_KEY, 'diagram');

    const result = await splitPlanDiagram(SCOPE, 'plan-1');

    expect(result.status).toBe('placed');
    const diagram = findPanelByInstanceKey(KEY, 'plan-diagram:plan-1');
    expect(diagram?.layoutKey).toBe(KEY);
    expect(diagram?.panelId).toBe('panel-plan-diagram-plan-1');
    const order = leafGroupOrder();
    expect(order.indexOf(diagram?.groupId ?? '')).toBe(
      order.indexOf('group-chat') + 1,
    );
    const tab = store().layouts[KEY].groups[diagram?.groupId ?? ''].tabs[0];
    expect(tab.title).toBe('Importer plan (Diagram)');
    expect(store().layouts[KEY].activeGroupId).toBe(diagram?.groupId);
    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')?.groupId).toBe(
      'group-chat',
    );
    expect(usePlanViewStore.getState().entries[VIEW_KEY]?.innerTab).toBe(
      'document',
    );
  });

  test('splitting twice only reveals the existing diagram', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    addDocument('group-chat');
    const first = await splitPlanDiagram(SCOPE, 'plan-1');
    store().focusGroup(KEY, 'group-chat');
    const before = tabIdsByGroup();

    const second = await splitPlanDiagram(SCOPE, 'plan-1');

    expect(first.status).toBe('placed');
    expect(second.status).toBe('revealed');
    expect(second.status === 'revealed' && second.location).toEqual(
      first.status === 'placed' && first.location,
    );
    expect(tabIdsByGroup()).toEqual(before);
    expect(countPlanPanels('plan-diagram')).toBe(1);
  });

  test('splits inside the auxiliary window that holds the document', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    store().initializeLayout(AUX_KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'plan',
          groupId: 'group-aux',
          panelId: 'panel-plan-plan-1',
          instance: { planId: 'plan-1' },
        },
      ],
    });

    const result = await splitPlanDiagram(SCOPE, 'plan-1');

    expect(result.status).toBe('placed');
    const diagram = findPanelByInstanceKey(KEY, 'plan-diagram:plan-1');
    expect(diagram?.layoutKey).toBe(AUX_KEY);
    expect(leafGroupOrder(AUX_KEY)).toEqual(['group-aux', diagram?.groupId]);
  });

  test.each([
    ['group-extras', 'group-terminal'],
    ['group-terminal', 'group-extras'],
  ])(
    'in a Minimal layout a document in %s splits into %s',
    async (documentGroup, diagramGroup) => {
      store().initializeLayout(KEY, MINIMAL_LAYOUT);
      setPanelLayoutFixedTopology(KEY, true);
      useWorkspaceLayoutModeStore.setState({
        entries: { [KEY]: { mode: 'minimal', status: 'ready', requestId: 1 } },
      });
      addDocument(documentGroup);
      const groupsBefore = Object.keys(store().layouts[KEY].groups).sort();

      const result = await splitPlanDiagram(SCOPE, 'plan-1');

      expect(result.status).toBe('placed');
      expect(findPanelByInstanceKey(KEY, 'plan-diagram:plan-1')?.groupId).toBe(
        diagramGroup,
      );
      expect(Object.keys(store().layouts[KEY].groups).sort()).toEqual(
        groupsBefore,
      );
    },
  );

  test('fails without changes when the document is not open', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    const before = tabIdsByGroup();

    await expect(splitPlanDiagram(SCOPE, 'plan-1')).resolves.toEqual({
      status: 'failed',
    });
    expect(tabIdsByGroup()).toEqual(before);
  });

  test('is unavailable when the plan does not exist', async () => {
    useActivityStore.setState({
      trackedPlans: {},
      trackedPlanInventoryLoaded: {},
    });
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    addDocument('group-chat');

    await expect(splitPlanDiagram(SCOPE, 'plan-1')).resolves.toEqual({
      status: 'unavailable',
    });
    expect(countPlanPanels('plan-diagram')).toBe(0);
  });
});

describe('openPlanDiagramPanel', () => {
  test('a group intent places the diagram in that group, titled by the plan', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);

    const result = await openPlanDiagramPanel(SCOPE, 'plan-1', {
      intent: { groupId: 'group-terminal' },
    });

    expect(result).toEqual({
      status: 'placed',
      location: {
        layoutKey: KEY,
        groupId: 'group-terminal',
        panelId: 'panel-plan-diagram-plan-1',
      },
    });
    const tab = store().layouts[KEY].groups['group-terminal'].tabs.find(
      (candidate) => candidate.panelId === 'panel-plan-diagram-plan-1',
    );
    expect(tab).toMatchObject({
      kind: 'plan-diagram',
      title: 'Importer plan (Diagram)',
      instance: { planId: 'plan-1' },
    });
    expect(store().layouts[KEY].activeGroupId).toBe('group-terminal');
    expect(countPlanPanels('plan')).toBe(0);
  });

  test('reveals an open diagram where it is instead of moving it', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    addDocument('group-chat');
    const split = await splitPlanDiagram(SCOPE, 'plan-1');
    store().focusGroup(KEY, 'group-chat');
    const before = tabIdsByGroup();

    const result = await openPlanDiagramPanel(SCOPE, 'plan-1', {
      intent: { groupId: 'group-terminal' },
    });

    expect(split.status).toBe('placed');
    expect(result).toEqual({
      status: 'revealed',
      location: split.status === 'placed' ? split.location : null,
    });
    expect(tabIdsByGroup()).toEqual(before);
    expect(countPlanPanels('plan-diagram')).toBe(1);
    expect(store().layouts[KEY].activeGroupId).toBe(
      split.status === 'placed' ? split.location.groupId : null,
    );
  });

  test('is unavailable when the plan does not exist', async () => {
    useActivityStore.setState({
      trackedPlans: {},
      trackedPlanInventoryLoaded: {},
    });
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    const before = tabIdsByGroup();

    await expect(
      openPlanDiagramPanel(SCOPE, 'plan-1', {
        intent: { groupId: 'group-terminal' },
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(tabIdsByGroup()).toEqual(before);
    expect(countPlanPanels('plan-diagram')).toBe(0);
  });
});

describe('diagram reveal', () => {
  test('a node reveal on a combined panel switches it to the Diagram tab', () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    addDocument('group-chat');
    usePlanViewStore.getState().acquire(VIEW_KEY);

    expect(revealPlanDiagram(SCOPE, 'plan-1')).toBe(false);
    revealPlanDiagramNode(SCOPE, 'plan-1', 'logicDiff', 'node-7');

    const entry = usePlanViewStore.getState().entries[VIEW_KEY];
    expect(entry?.innerTab).toBe('diagram');
    expect(entry?.diagramReveal).toMatchObject({
      diagramKind: 'logicDiff',
      nodeId: 'node-7',
    });
  });

  test('a node reveal on a split plan brings up the diagram panel', async () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    addDocument('group-chat');
    const split = await splitPlanDiagram(SCOPE, 'plan-1');
    store().focusGroup(KEY, 'group-chat');
    usePlanViewStore.getState().acquire(VIEW_KEY);

    revealPlanDiagramNode(SCOPE, 'plan-1', 'sequence', 'node-1');

    const entry = usePlanViewStore.getState().entries[VIEW_KEY];
    expect(entry?.innerTab).toBe('document');
    expect(entry?.diagramReveal?.nodeId).toBe('node-1');
    expect(store().layouts[KEY].activeGroupId).toBe(
      split.status === 'placed' ? split.location.groupId : null,
    );
  });
});

describe('origin and chat reveal', () => {
  test('uses the worktree’s active chat tab as the placement origin', () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab(),
            makeChatTab({ id: 'file-1', kind: 'file', title: 'a.ts' }),
          ],
          activeTabId: 'chat-1',
        },
      },
    });
    expect(planPanelOriginForWorktree(KEY)).toEqual({ chatTabId: 'chat-1' });

    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab(),
            makeChatTab({ id: 'file-1', kind: 'file', title: 'a.ts' }),
          ],
          activeTabId: 'file-1',
        },
      },
    });
    expect(planPanelOriginForWorktree(KEY)).toBeUndefined();
    expect(planPanelOriginForWorktree('project-1/unknown')).toBeUndefined();
  });

  test('falls back to the last active chat while a file tab is active', () => {
    // Opening a file from a chat mention makes its tab the active one; a plan
    // opened next must still go beside the chat, not over it.
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab(),
            makeChatTab({ id: 'file-1', kind: 'file', title: 'a.ts' }),
          ],
          activeTabId: 'file-1',
          lastActiveEditableChatId: 'chat-1',
        },
      },
    });
    expect(planPanelOriginForWorktree(KEY)).toEqual({ chatTabId: 'chat-1' });

    // A remembered chat that no longer exists is not an origin.
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [makeChatTab({ id: 'file-1', kind: 'file', title: 'a.ts' })],
          activeTabId: 'file-1',
          lastActiveEditableChatId: 'chat-gone',
        },
      },
    });
    expect(planPanelOriginForWorktree(KEY)).toBeUndefined();
  });

  test('reveals the owning worktree’s chat panel', () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    store().maximizeGroup(KEY, 'group-terminal', true);

    expect(revealWorktreeChatPanel(SCOPE, 'chat-1')).toBe(true);
    expect(store().layouts[KEY].maximizedGroupId).toBeNull();
    expect(store().layouts[KEY].activeGroupId).toBe('group-chat');
    expect(revealWorktreeChatPanel(SCOPE, 'chat-unknown')).toBe(false);
  });

  describe('a chat whose panel the bridge has not materialized yet', () => {
    const originalChatActions = {
      switchTab: useChatStore.getState().switchTab,
      closeTab: useChatStore.getState().closeTab,
    };

    /** The bridge reconciling chat-1 against the layout, terminal maximized. */
    function seedBridge(): void {
      useChatStore.setState({
        switchTab: jest.fn(),
        closeTab: jest.fn(),
        selectedWorktree: SCOPE,
        worktreeChats: {
          [KEY]: { tabs: [makeChatTab()], activeTabId: 'chat-1' },
        },
      });
      store().initializeLayout(KEY, ADVANCED_LAYOUT);
      initChatPanelSync();
      flushChatPanelSyncForTests();
      store().maximizeGroup(KEY, 'group-terminal', true);
      store().focusGroup(KEY, 'group-terminal');
    }

    /** A fresh chat becomes the active tab, as chat creation does. */
    function addActiveChat(id: string): void {
      useChatStore.setState({
        worktreeChats: {
          [KEY]: {
            tabs: [makeChatTab(), makeChatTab({ id, title: `Chat ${id}` })],
            activeTabId: id,
          },
        },
      });
    }

    function chatLocation(
      id: string,
    ): ReturnType<typeof findPanelByInstanceKey> {
      return findPanelByInstanceKey(KEY, `chat:${id}`);
    }

    async function settle(): Promise<void> {
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
    }

    afterEach(() => {
      jest.useRealTimers();
      resetChatPanelSyncForTests();
      useChatStore.setState(originalChatActions);
    });

    test('reveals the panel once the bridge places it', async () => {
      seedBridge();
      addActiveChat('chat-2');

      expect(chatLocation('chat-2')).toBeNull();
      expect(revealWorktreeChatPanel(SCOPE, 'chat-2')).toBe(true);
      await settle();

      const location = chatLocation('chat-2');
      expect(location).not.toBeNull();
      const layout = store().layouts[KEY];
      // The bridge alone would select the panel but keep the terminal's
      // maximize, hiding it; the reveal leaves the maximize.
      expect(layout.maximizedGroupId).toBeNull();
      expect(layout.activeGroupId).toBe(location?.groupId);
      expect(
        location === null
          ? null
          : layout.groups[location.groupId].activePanelId,
      ).toBe(location?.panelId);
    });

    test('a newer reveal replaces a pending one', async () => {
      seedBridge();
      addActiveChat('chat-2');

      expect(revealWorktreeChatPanel(SCOPE, 'chat-2')).toBe(true);
      expect(revealWorktreeChatPanel(SCOPE, 'chat-1')).toBe(true);
      expect(store().layouts[KEY].maximizedGroupId).toBeNull();
      // The user maximizes the terminal again before chat-2's panel exists;
      // the superseded reveal must not undo that once the panel appears.
      store().maximizeGroup(KEY, 'group-terminal', true);
      await settle();

      expect(chatLocation('chat-2')).not.toBeNull();
      expect(store().layouts[KEY].maximizedGroupId).toBe('group-terminal');
    });

    test('stops waiting for a panel that never appears', async () => {
      jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
      seedBridge();
      // An unselected worktree's chat: no bridge materializes its panel.
      useChatStore.setState({ selectedWorktree: null });
      addActiveChat('chat-2');

      expect(revealWorktreeChatPanel(SCOPE, 'chat-2')).toBe(true);
      jest.runOnlyPendingTimers();
      await settle();
      // A panel placed after the wait ended is not revealed.
      store().addTab(KEY, 'group-chat', 'chat', {
        panelId: 'panel-chat-chat-2',
        instance: { chatTabId: 'chat-2' },
        activate: false,
      });
      await settle();

      expect(store().layouts[KEY].maximizedGroupId).toBe('group-terminal');
    });
  });
});

describe('revealWorktreeActivityPanel', () => {
  function pipelineRunsExpandRequest(): number | undefined {
    return useActivitySectionRevealStore.getState().expandRequests[KEY]?.[
      'pipeline-runs'
    ];
  }

  beforeEach(() => {
    useActivitySectionRevealStore.setState({ expandRequests: {} });
  });

  const ACTIVITY_LAYOUT: DefaultLayoutDescriptor = {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-chat',
        panelId: 'panel-chat-chat-1',
        instance: { chatTabId: 'chat-1' },
      },
      {
        kind: 'activity-section',
        groupId: 'group-activity',
        panelId: 'panel-activity',
      },
    ],
    containerSize: { width: 1600, height: 800 },
  };

  test('prefers the Pipeline Runs card panel over the Activity panel', () => {
    store().initializeLayout(KEY, ACTIVITY_LAYOUT);
    store().addTab(KEY, 'group-chat', 'activity-card', {
      panelId: 'panel-card-runs',
      instance: { sectionId: 'pipeline-runs' },
    });
    store().selectTab(KEY, 'group-chat', 'panel-chat-chat-1');
    store().focusGroup(KEY, 'group-activity');

    expect(revealWorktreeActivityPanel(SCOPE)).toBe(true);

    expect(store().layouts[KEY].activeGroupId).toBe('group-chat');
    expect(store().layouts[KEY].groups['group-chat'].activePanelId).toBe(
      'panel-card-runs',
    );
    // The card panel is frameless: its section has no collapsed state.
    expect(pipelineRunsExpandRequest()).toBeUndefined();
  });

  test('expands the Pipeline runs section when it falls back to the Activity panel', () => {
    store().initializeLayout(KEY, ACTIVITY_LAYOUT);

    expect(revealWorktreeActivityPanel(SCOPE)).toBe(true);
    const first = pipelineRunsExpandRequest();
    expect(first).toEqual(expect.any(Number));

    // Every reveal is a new request, so a section the user collapsed again
    // after the last run opens for the next one.
    expect(revealWorktreeActivityPanel(SCOPE)).toBe(true);
    expect(pipelineRunsExpandRequest()).not.toBe(first);
  });

  test('expands a collapsed Activity panel', () => {
    store().initializeLayout(KEY, ACTIVITY_LAYOUT);
    expect(store().collapseGroup(KEY, 'group-activity')).toBe(true);
    store().focusGroup(KEY, 'group-chat');

    expect(revealWorktreeActivityPanel(SCOPE)).toBe(true);

    expect(
      store().layouts[KEY].groups['group-activity'].collapsed,
    ).toBeUndefined();
    expect(store().layouts[KEY].activeGroupId).toBe('group-activity');
  });

  describe('with early access (Activity is a card, not a panel)', () => {
    beforeEach(() => {
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
      useActivityCardStore.setState({ openWorktrees: {} });
    });
    afterEach(() => {
      resetExperimentalFeaturesStoreForTest();
    });

    const SIDE_PANEL_LAYOUT: DefaultLayoutDescriptor = {
      ...MINIMAL_LAYOUT,
      groups: [
        MINIMAL_LAYOUT.groups[0],
        {
          kind: 'file-explorer',
          groupId: 'group-extras',
          panelId: 'panel-files',
        },
        MINIMAL_LAYOUT.groups[2],
      ],
    };

    test('opens Pipeline runs in the Side Panel in Minimal', () => {
      store().initializeLayout(KEY, SIDE_PANEL_LAYOUT);
      useWorkspaceLayoutModeStore.setState({
        entries: { [KEY]: { mode: 'minimal', status: 'ready', requestId: 1 } },
      });

      expect(revealWorktreeActivityPanel(SCOPE)).toBe(true);

      const extras = store().layouts[KEY].groups['group-extras'];
      const active = extras.tabs.find(
        (tab) => tab.panelId === extras.activePanelId,
      );
      expect(active?.kind).toBe('activity-card');
      expect(active?.instance?.sectionId).toBe('pipeline-runs');
    });

    test('shows the Activity card in Advanced, leaving the layout alone', () => {
      store().initializeLayout(KEY, ADVANCED_LAYOUT);
      const revisionBefore = store().layouts[KEY].revision;

      expect(revealWorktreeActivityPanel(SCOPE)).toBe(true);

      expect(store().layouts[KEY].revision).toBe(revisionBefore);
      expect(isActivityCardOpen(useActivityCardStore.getState(), KEY)).toBe(
        true,
      );
    });
  });

  describe('with early access, from a maximized panel in Advanced', () => {
    beforeEach(() => {
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
      useActivityCardStore.setState({ openWorktrees: {} });
    });
    afterEach(() => {
      resetExperimentalFeaturesStoreForTest();
    });

    test('selects a chat tab when another tab is in front of the chat', () => {
      store().initializeLayout(KEY, ADVANCED_LAYOUT);
      store().addTab(KEY, 'group-chat', 'file-diff', {
        panelId: 'panel-file',
        instance: { filePath: '/repo/README.md' },
      });
      store().selectTab(KEY, 'group-chat', 'panel-file');

      expect(revealWorktreeActivityPanel(SCOPE)).toBe(true);

      // The card shows only beside a chat, so the chat comes to the front.
      expect(store().layouts[KEY].groups['group-chat'].activePanelId).toBe(
        'panel-chat-chat-1',
      );
    });

    test('brings the chat back, so its Activity card shows the run', () => {
      store().initializeLayout(KEY, ADVANCED_LAYOUT);
      // The plan's panel (here the terminal group) fills the layout.
      store().maximizeGroup(KEY, 'group-terminal', true);
      expect(store().layouts[KEY].maximizedGroupId).toBe('group-terminal');

      expect(revealWorktreeActivityPanel(SCOPE)).toBe(true);

      expect(store().layouts[KEY].maximizedGroupId ?? null).toBeNull();
      expect(store().layouts[KEY].groups['group-chat'].activePanelId).toBe(
        'panel-chat-chat-1',
      );
      expect(isActivityCardOpen(useActivityCardStore.getState(), KEY)).toBe(
        true,
      );
    });
  });

  test('is false when the worktree has no activity panel', () => {
    store().initializeLayout(KEY, ADVANCED_LAYOUT);
    const revisionBefore = store().layouts[KEY].revision;

    expect(revealWorktreeActivityPanel(SCOPE)).toBe(false);
    expect(store().layouts[KEY].revision).toBe(revisionBefore);
    expect(pipelineRunsExpandRequest()).toBeUndefined();
  });
});
