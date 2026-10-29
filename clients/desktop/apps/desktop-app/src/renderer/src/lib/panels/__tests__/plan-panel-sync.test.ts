/** @jest-environment jsdom */

/**
 * Plan panel reconciler, exercised against the REAL panel layout, activity,
 * chat, and panel-window stores. Only the tracked-plan list IPC is faked.
 */
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import {
  findPanelByInstanceKey,
  makeAuxPanelLayoutKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import {
  registerChatPanelSyncOwner,
  resetChatPanelSyncForTests,
} from '../chat-panel-sync';
import {
  flushPlanPanelSyncForTests,
  initPlanPanelSync,
  resetPlanPanelSyncForTests,
} from '../plan-panel-sync';

jest.mock('../persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(),
}));

const PROJECT_ID = 'project-1';
const KEY = `${PROJECT_ID}/worktree-1`;
const OTHER_KEY = `${PROJECT_ID}/worktree-2`;
const AUX_KEY = makeAuxPanelLayoutKey(KEY, 'aux-1');
const OTHER_AUX_KEY = makeAuxPanelLayoutKey(OTHER_KEY, 'aux-2');

let listMock: jest.Mock;

function makePlan(overrides: Partial<TrackedPlanData> = {}): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: PROJECT_ID,
    worktreeId: 'worktree-1',
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

/** Chat group plus the plan's document (and optionally its diagram). */
function planLayout(
  planId = 'plan-1',
  options: { diagram?: boolean; title?: string } = {},
): DefaultLayoutDescriptor {
  const title = options.title ?? 'Importer plan';
  return {
    orientation: 'horizontal',
    groups: [
      { kind: 'terminal', groupId: 'group-terminal', panelId: 'terminal-1' },
      {
        kind: 'plan',
        groupId: 'group-plan',
        panelId: `panel-plan-${planId}`,
        title,
        instance: { planId },
      },
      ...(options.diagram === true
        ? [
            {
              kind: 'plan-diagram' as const,
              groupId: 'group-plan-diagram',
              panelId: `panel-plan-diagram-${planId}`,
              title: `${title} (Diagram)`,
              instance: { planId },
            },
          ]
        : []),
    ],
    containerSize: { width: 1600, height: 800 },
  };
}

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function select(worktreeKey: string): void {
  const [projectId, worktreeId] = worktreeKey.split('/');
  useChatStore.setState({ selectedWorktree: { projectId, worktreeId } });
}

function setInventory(worktreeKey: string, plans: TrackedPlanData[]): void {
  useActivityStore.setState((state) => ({
    trackedPlans: { ...state.trackedPlans, [worktreeKey]: plans },
    trackedPlanInventoryLoaded: {
      ...state.trackedPlanInventoryLoaded,
      [worktreeKey]: true,
    },
  }));
}

function registerAuxWindow(worktreeKey: string, layoutKey: string): void {
  usePanelWindowsStore.setState({
    auxWindows: {
      'aux-window': {
        auxWindowId: 'aux-window',
        worktreeKey,
        layoutKey,
        sourceGroupId: 'group-terminal',
        childWindow: window,
        status: 'open',
        focusOnOpen: false,
      },
    },
  });
}

function install(): void {
  initPlanPanelSync();
  flushPlanPanelSyncForTests();
}

/** Lets a resolved plan-list load land, then runs the sweep it scheduled. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
  flushPlanPanelSyncForTests();
}

function tabTitle(worktreeKey: string, instanceKey: string): string | null {
  const location = findPanelByInstanceKey(worktreeKey, instanceKey);
  if (location === null) return null;
  return (
    store().layouts[location.layoutKey]?.groups[location.groupId]?.tabs.find(
      (tab) => tab.panelId === location.panelId,
    )?.title ?? null
  );
}

beforeEach(() => {
  listMock = jest.fn().mockResolvedValue([]);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { activity: { plans: { list: listMock } } },
  });
  useActivityStore.setState({
    trackedPlans: {},
    trackedPlanInventoryLoaded: {},
  });
  select(KEY);
});

afterEach(() => {
  resetPlanPanelSyncForTests();
  resetChatPanelSyncForTests();
  for (const key of Object.keys(store().layouts)) {
    store().disposeLayout(key);
  }
  usePanelWindowsStore.setState({ auxWindows: {} });
  useChatStore.setState({ selectedWorktree: null, worktreeChats: {} });
});

describe('plan panel reconciliation', () => {
  test('waits for the full plan inventory before closing anything', async () => {
    store().initializeLayout(KEY, planLayout('plan-1'));
    // A partial list (a single fetched plan) is not evidence of deletion.
    useActivityStore.setState({
      trackedPlans: { [KEY]: [makePlan({ id: 'plan-2' })] },
    });
    let resolveList: (plans: TrackedPlanData[]) => void = () => undefined;
    listMock.mockReturnValue(
      new Promise<TrackedPlanData[]>((resolve) => {
        resolveList = resolve;
      }),
    );

    install();

    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')).not.toBeNull();
    expect(listMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: 'worktree-1',
    });

    resolveList([makePlan({ id: 'plan-2' })]);
    await settle();

    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')).toBeNull();
    expect(store().layouts[KEY].groups['group-terminal']).toBeDefined();
  });

  test('requests the inventory once per worktree while it loads', () => {
    store().initializeLayout(KEY, planLayout('plan-1'));
    listMock.mockReturnValue(new Promise<TrackedPlanData[]>(() => undefined));

    install();
    store().focusGroup(KEY, 'group-plan');
    flushPlanPanelSyncForTests();
    store().focusGroup(KEY, 'group-terminal');
    flushPlanPanelSyncForTests();

    expect(listMock).toHaveBeenCalledTimes(1);
  });

  test('retries the inventory after a failed load', async () => {
    store().initializeLayout(KEY, planLayout('plan-1'));
    listMock.mockRejectedValueOnce(new Error('offline'));

    install();
    await settle();
    store().focusGroup(KEY, 'group-plan');
    flushPlanPanelSyncForTests();

    expect(listMock).toHaveBeenCalledTimes(2);
  });

  test('closes the document and diagram of a deleted plan, including in a window', () => {
    store().initializeLayout(KEY, planLayout('plan-1', { diagram: true }));
    store().initializeLayout(AUX_KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'plan',
          groupId: 'group-aux',
          panelId: 'panel-plan-plan-2',
          instance: { planId: 'plan-2' },
        },
        { kind: 'terminal', groupId: 'group-aux-terminal', panelId: 't-2' },
      ],
    });
    setInventory(KEY, [makePlan({ id: 'plan-3' })]);

    install();

    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')).toBeNull();
    expect(findPanelByInstanceKey(KEY, 'plan-diagram:plan-1')).toBeNull();
    expect(findPanelByInstanceKey(KEY, 'plan:plan-2')).toBeNull();
    expect(
      store().layouts[AUX_KEY].groups['group-aux-terminal'].tabs,
    ).toHaveLength(1);
    expect(store().layouts[KEY].groups['group-terminal'].tabs).toHaveLength(1);
  });

  test('closes a plan’s panels when a live update deletes it', () => {
    store().initializeLayout(KEY, planLayout('plan-1', { diagram: true }));
    setInventory(KEY, [makePlan()]);
    install();
    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')).not.toBeNull();

    useActivityStore
      .getState()
      .removeTrackedPlan(PROJECT_ID, 'worktree-1', 'plan-1');
    flushPlanPanelSyncForTests();

    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')).toBeNull();
    expect(findPanelByInstanceKey(KEY, 'plan-diagram:plan-1')).toBeNull();
  });

  test('keeps the panels of a hidden plan', () => {
    store().initializeLayout(KEY, planLayout('plan-1', { diagram: true }));
    setInventory(KEY, [makePlan({ hidden: true })]);

    install();

    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')).not.toBeNull();
    expect(findPanelByInstanceKey(KEY, 'plan-diagram:plan-1')).not.toBeNull();
  });

  test('keeps panel titles in step with the plan title', () => {
    store().initializeLayout(
      KEY,
      planLayout('plan-1', { diagram: true, title: 'Old title' }),
    );
    setInventory(KEY, [makePlan({ title: 'Importer plan' })]);

    install();

    expect(tabTitle(KEY, 'plan:plan-1')).toBe('Importer plan');
    expect(tabTitle(KEY, 'plan-diagram:plan-1')).toBe(
      'Importer plan (Diagram)',
    );

    setInventory(KEY, [makePlan({ title: '  Renamed plan  ' })]);
    flushPlanPanelSyncForTests();

    expect(tabTitle(KEY, 'plan:plan-1')).toBe('Renamed plan');
    expect(tabTitle(KEY, 'plan-diagram:plan-1')).toBe('Renamed plan (Diagram)');
  });

  test('leaves other worktrees alone until an open window makes them an owner', () => {
    store().initializeLayout(KEY, planLayout('plan-9'));
    setInventory(KEY, [makePlan({ id: 'plan-9' })]);
    store().initializeLayout(OTHER_KEY, planLayout('plan-1'));
    store().initializeLayout(OTHER_AUX_KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'plan-diagram',
          groupId: 'group-aux',
          panelId: 'panel-plan-diagram-plan-1',
          instance: { planId: 'plan-1' },
        },
        { kind: 'terminal', groupId: 'group-aux-terminal', panelId: 't-2' },
      ],
    });
    setInventory(OTHER_KEY, []);

    install();

    expect(findPanelByInstanceKey(OTHER_KEY, 'plan:plan-1')).not.toBeNull();
    expect(
      findPanelByInstanceKey(OTHER_KEY, 'plan-diagram:plan-1'),
    ).not.toBeNull();

    registerAuxWindow(OTHER_KEY, OTHER_AUX_KEY);
    flushPlanPanelSyncForTests();

    expect(findPanelByInstanceKey(OTHER_KEY, 'plan:plan-1')).toBeNull();
    expect(findPanelByInstanceKey(OTHER_KEY, 'plan-diagram:plan-1')).toBeNull();
  });

  test('reconciles a registered overlay owner that is not selected', () => {
    const viewerKey = `${SHARED_CONTAINER_VIEWER_PROJECT_ID}/container-1`;
    store().initializeLayout(viewerKey, planLayout('plan-1'));
    setInventory(viewerKey, []);
    install();
    expect(findPanelByInstanceKey(viewerKey, 'plan:plan-1')).not.toBeNull();

    registerChatPanelSyncOwner(viewerKey);
    // Registration is not a store change of its own; the next layout
    // change (the overlay's restore) sweeps it.
    store().focusGroup(viewerKey, 'group-plan');
    flushPlanPanelSyncForTests();

    expect(findPanelByInstanceKey(viewerKey, 'plan:plan-1')).toBeNull();
  });

  test('waits for the main layout before reconciling a window', () => {
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
    setInventory(KEY, []);
    registerAuxWindow(KEY, AUX_KEY);

    install();

    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')).not.toBeNull();
    expect(listMock).not.toHaveBeenCalled();
  });

  test('never reopens panels after a bulk close or a layout teardown', () => {
    store().initializeLayout(KEY, planLayout('plan-1', { diagram: true }));
    setInventory(KEY, [makePlan()]);
    install();

    store().closeTabs(KEY, 'group-plan', ['panel-plan-plan-1']);
    store().closeTabs(KEY, 'group-plan-diagram', ['panel-plan-diagram-plan-1']);
    flushPlanPanelSyncForTests();

    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')).toBeNull();
    expect(findPanelByInstanceKey(KEY, 'plan-diagram:plan-1')).toBeNull();

    store().initializeLayout(OTHER_KEY, planLayout('plan-1'));
    select(OTHER_KEY);
    setInventory(OTHER_KEY, [makePlan()]);
    flushPlanPanelSyncForTests();
    store().disposeLayout(OTHER_KEY);
    flushPlanPanelSyncForTests();

    expect(store().layouts[OTHER_KEY]).toBeUndefined();
    expect(findPanelByInstanceKey(KEY, 'plan:plan-1')).toBeNull();
  });

  test('ignores scopes that cannot hold plans', () => {
    const coworkKey = `${STANDALONE_CHAT_PROJECT_ID}/entry-1`;
    store().initializeLayout(coworkKey, planLayout('plan-1'));
    select(coworkKey);

    install();

    expect(findPanelByInstanceKey(coworkKey, 'plan:plan-1')).not.toBeNull();
    expect(listMock).not.toHaveBeenCalled();
  });
});
