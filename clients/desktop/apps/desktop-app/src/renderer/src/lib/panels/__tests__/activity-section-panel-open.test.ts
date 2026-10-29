/** @jest-environment jsdom */

/**
 * Opening an Activity card row in the Side Panel, against the real panel
 * layout store: a Side Panel that held nothing opens at its minimum width,
 * and one that already holds tabs keeps the width the user gave it.
 */
import {
  makeWorktreePanelKey,
  findPanelByInstanceKey,
  getPanelInstanceKey,
  setFixedSidePanelTabsClosable,
  setPanelLayoutFixedTopology,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { openActivitySectionInSidePanel } from '../activity-section-panel-open';
import {
  COST_PANEL_ID,
  COST_PANEL_TITLE,
  costPanelSeed,
} from '@/lib/cost/open-cost-panels';

jest.mock('@/components/activity/activity-sections', () => ({
  getActivitySectionDefinition: (
    sectionId: string,
  ): { title: string } | undefined =>
    sectionId === 'summary' ? { title: 'Summary' } : undefined,
}));

// The Side Panel group already exists in these layouts.
const mockEnsureMinimalDestination = jest.fn((): string => 'group-extras');
jest.mock('../minimal-layout', () => ({
  ensureMinimalDestination: (): string => mockEnsureMinimalDestination(),
}));

let mockLayoutMode: 'minimal' | 'advanced' = 'minimal';
jest.mock('@/stores/workspaceLayoutModeStore', () => ({
  ...jest.requireActual<object>('@/stores/workspaceLayoutModeStore'),
  getWorkspaceLayoutMode: (): 'minimal' | 'advanced' => mockLayoutMode,
}));

// A fresh layout per test: initializing an existing layout keeps it.
let keyIndex = 0;
let KEY = '';

const LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    { kind: 'chat', groupId: 'group-chat', panelId: 'panel-chat' },
    {
      kind: 'file-explorer',
      groupId: 'group-extras',
      panelId: 'panel-files',
    },
  ],
  containerSize: { width: 1400, height: 800 },
};

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function sidePanelWidth(): number {
  const layout = store().layouts[KEY];
  const view = layout?.leafViews.get('group-extras');
  if (!layout || !view) throw new Error('Side Panel missing');
  return layout.grid.getViewSize(view).width;
}

beforeEach(() => {
  mockLayoutMode = 'minimal';
  mockEnsureMinimalDestination.mockClear();
  keyIndex += 1;
  KEY = makeWorktreePanelKey('project-1', `worktree-${keyIndex}`);
  setFixedSidePanelTabsClosable(true);
  store().initializeLayout(KEY, LAYOUT);
  setPanelLayoutFixedTopology(KEY, true);
});

afterEach(() => {
  setPanelLayoutFixedTopology(KEY, false);
  setFixedSidePanelTabsClosable(false);
});

it('opens an empty Side Panel at its minimum width', () => {
  store().closeTab(KEY, 'group-extras', 'panel-files');
  expect(store().layouts[KEY]?.groups['group-extras']?.tabs).toHaveLength(0);
  const minimum =
    store().layouts[KEY]?.leafViews.get('group-extras')?.minimumWidth ?? 0;
  expect(sidePanelWidth()).toBeGreaterThan(minimum);

  expect(openActivitySectionInSidePanel(KEY, 'summary')).toBe(true);

  expect(sidePanelWidth()).toBe(minimum);
});

it('replaces the New tab placeholder of an emptied Side Panel', () => {
  store().closeTab(KEY, 'group-extras', 'panel-files');
  store().addTab(KEY, 'group-extras', 'new-tab', {
    instance: { newTabId: 'placeholder' },
    title: 'New tab',
    activate: false,
  });
  const minimum =
    store().layouts[KEY]?.leafViews.get('group-extras')?.minimumWidth ?? 0;

  expect(openActivitySectionInSidePanel(KEY, 'summary')).toBe(true);

  expect(
    store().layouts[KEY]?.groups['group-extras']?.tabs.map((tab) => tab.kind),
  ).toEqual(['activity-card']);
  expect(sidePanelWidth()).toBe(minimum);
});

it('keeps the width of a Side Panel that already has tabs', () => {
  const before = sidePanelWidth();

  expect(openActivitySectionInSidePanel(KEY, 'summary')).toBe(true);

  expect(sidePanelWidth()).toBe(before);
  expect(
    store().layouts[KEY]?.groups['group-extras']?.tabs.map((tab) => tab.kind),
  ).toEqual(['file-explorer', 'activity-card']);
});

it('leaves an Advanced layout alone and lets the row open in place', () => {
  mockLayoutMode = 'advanced';
  const before = store().layouts[KEY]?.groups['group-extras']?.tabs.map(
    (tab) => tab.kind,
  );

  expect(openActivitySectionInSidePanel(KEY, 'summary')).toBe(false);

  expect(mockEnsureMinimalDestination).not.toHaveBeenCalled();
  expect(
    store().layouts[KEY]?.groups['group-extras']?.tabs.map((tab) => tab.kind),
  ).toEqual(before);
});

it('opens Cost as a cost panel and replaces an empty Side Panel placeholder', () => {
  store().closeTab(KEY, 'group-extras', 'panel-files');
  store().addTab(KEY, 'group-extras', 'new-tab', {
    instance: { newTabId: 'placeholder' },
    title: 'New tab',
    activate: false,
  });
  const minimum =
    store().layouts[KEY]?.leafViews.get('group-extras')?.minimumWidth ?? 0;

  expect(costPanelSeed()).toEqual({
    kind: 'cost',
    panelId: COST_PANEL_ID,
    instance: {},
    title: COST_PANEL_TITLE,
  });
  expect(openActivitySectionInSidePanel(KEY, 'cost')).toBe(true);

  const tabs = store().layouts[KEY]?.groups['group-extras']?.tabs ?? [];
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toEqual(
    expect.objectContaining({
      kind: 'cost',
      panelId: COST_PANEL_ID,
      title: COST_PANEL_TITLE,
    }),
  );
  expect(tabs[0]?.kind).not.toBe('activity-card');
  expect(sidePanelWidth()).toBe(minimum);
});

it('reveals the existing Cost panel anywhere in the family without adding another', () => {
  setPanelLayoutFixedTopology(KEY, false);
  store().addTab(KEY, 'group-chat', 'cost', {
    panelId: COST_PANEL_ID,
    title: COST_PANEL_TITLE,
    instance: {},
  });
  const instanceKey = getPanelInstanceKey({ kind: 'cost', instance: {} });

  expect(findPanelByInstanceKey(KEY, instanceKey)).not.toBeNull();
  expect(openActivitySectionInSidePanel(KEY, 'cost')).toBe(true);

  const tabs = Object.values(store().layouts[KEY]?.groups ?? {}).flatMap(
    (group) => group.tabs,
  );
  expect(tabs.filter((tab) => tab.kind === 'cost')).toHaveLength(1);
});

it('returns false for Cost in Advanced so the card row expands in place', () => {
  mockLayoutMode = 'advanced';
  const before = store().layouts[KEY]?.groups['group-extras']?.tabs.map(
    (tab) => tab.kind,
  );

  expect(openActivitySectionInSidePanel(KEY, 'cost')).toBe(false);

  expect(mockEnsureMinimalDestination).not.toHaveBeenCalled();
  expect(
    store().layouts[KEY]?.groups['group-extras']?.tabs.map((tab) => tab.kind),
  ).toEqual(before);
});
