/** @jest-environment jsdom */

/**
 * `revealPanel` with pipeline-execution run tabs, exercised against the REAL
 * panel layout store. The auxiliary-window focus step is
 * observed through the panel-windows store action it delegates to.
 */
import {
  findPanelByInstanceKey,
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { revealPanel } from '../panel-reveal';

jest.mock('@/lib/panels/registry', () => ({
  getPanelDefinition: (kind: string): { canPopOut: boolean } => ({
    canPopOut: kind !== 'browser',
  }),
}));

const KEY = makeWorktreePanelKey('project-1', 'worktree-reveal');

const THREE_GROUPS: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-chat',
      panelId: 'panel-chat',
      instance: { chatTabId: 'chat-1' },
    },
    { kind: 'terminal', groupId: 'group-terminal', panelId: 'panel-terminal' },
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
  store().initializeLayout(KEY, THREE_GROUPS);
  expect(
    store().addTab(KEY, 'group-runs', 'pipeline-execution', {
      panelId: 'panel-pipeline-run-2',
      instance: { executionId: 'run-2' },
    }),
  ).toBe('panel-pipeline-run-2');
  usePanelWindowsStore.setState({ focusAuxWindowForLayout: focusAuxWindow });
});

afterEach(() => {
  usePanelWindowsStore.setState(initialWindowsState, true);
  focusAuxWindow.mockClear();
  for (const key of Object.keys(store().layouts)) {
    store().disposeLayout(key);
  }
});

test('exits a conflicting maximize, expands, selects, and focuses without moving the tab', () => {
  store().selectTab(KEY, 'group-runs', 'panel-pipeline-run-2');
  expect(store().collapseGroup(KEY, 'group-runs')).toBe(true);
  store().maximizeGroup(KEY, 'group-chat', true);
  expect(store().layouts[KEY]?.maximizedGroupId).toBe('group-chat');
  const location = findPanelByInstanceKey(KEY, 'pipeline-execution:run-1');
  expect(location).not.toBeNull();
  if (location === null) return;

  revealPanel(location);

  const layout = store().layouts[KEY];
  expect(layout?.maximizedGroupId).toBeNull();
  expect(layout?.groups['group-runs']?.collapsed).toBeUndefined();
  expect(layout?.groups['group-runs']?.activePanelId).toBe(
    'panel-pipeline-run-1',
  );
  expect(layout?.activeGroupId).toBe('group-runs');
  expect(layout?.mruGroupIds[0]).toBe('group-runs');
  expect(findPanelByInstanceKey(KEY, 'pipeline-execution:run-1')).toEqual(
    location,
  );
  // A main-layout tab never pulls an auxiliary window forward.
  expect(focusAuxWindow).not.toHaveBeenCalledWith(
    expect.stringContaining('#aux:'),
  );
});

test('keeps the target group maximized when it is the maximized one', () => {
  store().maximizeGroup(KEY, 'group-runs', true);

  revealPanel({
    layoutKey: KEY,
    groupId: 'group-runs',
    panelId: 'panel-pipeline-run-2',
  });

  const layout = store().layouts[KEY];
  expect(layout?.maximizedGroupId).toBe('group-runs');
  expect(layout?.groups['group-runs']?.activePanelId).toBe(
    'panel-pipeline-run-2',
  );
});

test('brings the owning auxiliary window forward unless asked not to', () => {
  const auxKey = makeAuxPanelLayoutKey(KEY, 'aux-runs');
  expect(store().extractGroupToLayout(KEY, 'group-runs', auxKey)).toBe(true);
  const location = findPanelByInstanceKey(KEY, 'pipeline-execution:run-1');
  expect(location?.layoutKey).toBe(auxKey);
  if (location === null) return;
  store().selectTab(auxKey, 'group-runs', 'panel-pipeline-run-2');

  revealPanel(location);

  expect(focusAuxWindow).toHaveBeenCalledTimes(1);
  expect(focusAuxWindow).toHaveBeenCalledWith(auxKey);
  expect(store().layouts[auxKey]?.groups['group-runs']?.activePanelId).toBe(
    'panel-pipeline-run-1',
  );

  revealPanel(location, { focusWindow: false });
  expect(focusAuxWindow).toHaveBeenCalledTimes(1);
});

test('is a no-op for a location whose layout no longer exists', () => {
  const before = store().layouts[KEY];

  revealPanel({
    layoutKey: `${KEY}#aux:gone`,
    groupId: 'group-runs',
    panelId: 'panel-pipeline-run-1',
  });

  expect(store().layouts[KEY]).toBe(before);
});
