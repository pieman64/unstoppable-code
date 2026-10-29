/** @jest-environment jsdom */
import {
  resetActivePlanStoreForTests,
  useActivePlanStore,
  type ActivePlanScope,
} from '@/stores/activePlanStore';
import { useChatStore } from '@/stores/chatStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

const SCOPE: ActivePlanScope = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};
const OTHER_SCOPE: ActivePlanScope = {
  projectId: 'project-1',
  worktreeId: 'worktree-2',
};

beforeEach(() => {
  useChatStore.setState({ selectedWorktree: null });
  resetActivePlanStoreForTests();
});

describe('buildCurrentUiStateSnapshot activePlan slice (CAN-4235)', () => {
  it('omits the field when no worktree is selected', () => {
    expect(buildCurrentUiStateSnapshot({}).activePlan).toBeUndefined();
  });

  it('omits the field when the selected worktree has no active plan', () => {
    useChatStore.setState({ selectedWorktree: SCOPE });

    expect(buildCurrentUiStateSnapshot({}).activePlan).toBeUndefined();
  });

  it('reports only the plan id while its latest revision is on screen', () => {
    useChatStore.setState({ selectedWorktree: SCOPE });
    useActivePlanStore.getState().mountView(SCOPE, 'plan-1');
    useActivePlanStore.getState().markActive(SCOPE, 'plan-1');

    expect(buildCurrentUiStateSnapshot({}).activePlan).toEqual({
      planId: 'plan-1',
    });
  });

  it('reports the viewed revision number while an older revision is on screen', () => {
    useChatStore.setState({ selectedWorktree: SCOPE });
    useActivePlanStore.getState().mountView(SCOPE, 'plan-1');
    useActivePlanStore.getState().markActive(SCOPE, 'plan-1');
    useActivePlanStore.getState().setViewedRevision(SCOPE, 'plan-1', 2);

    expect(buildCurrentUiStateSnapshot({}).activePlan).toEqual({
      planId: 'plan-1',
      viewedRevisionNumber: 2,
    });
  });

  it('never reports another worktree’s active plan', () => {
    useActivePlanStore.getState().mountView(OTHER_SCOPE, 'plan-2');
    useActivePlanStore.getState().markActive(OTHER_SCOPE, 'plan-2');
    useChatStore.setState({ selectedWorktree: SCOPE });

    expect(buildCurrentUiStateSnapshot({}).activePlan).toBeUndefined();
    // Sanity check: the other worktree's own snapshot does see it.
    useChatStore.setState({ selectedWorktree: OTHER_SCOPE });
    expect(buildCurrentUiStateSnapshot({}).activePlan).toEqual({
      planId: 'plan-2',
    });
  });

  it('never includes plan content, only the id and revision number', () => {
    useChatStore.setState({ selectedWorktree: SCOPE });
    useActivePlanStore.getState().mountView(SCOPE, 'plan-1');
    useActivePlanStore.getState().markActive(SCOPE, 'plan-1');
    useActivePlanStore.getState().setViewedRevision(SCOPE, 'plan-1', 2);

    const activePlan = buildCurrentUiStateSnapshot({}).activePlan;
    expect(activePlan && Object.keys(activePlan).sort()).toEqual([
      'planId',
      'viewedRevisionNumber',
    ]);
  });
});

describe('buildCurrentUiStateSnapshot plan panels (phase 06)', () => {
  const KEY = makeWorktreePanelKey(SCOPE.projectId, SCOPE.worktreeId);
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
        kind: 'plan',
        groupId: 'group-plan',
        panelId: 'panel-plan-plan-1',
        instance: { planId: 'plan-1' },
        title: 'Importer plan',
      },
    ],
    containerSize: { width: 1200, height: 800 },
  };

  afterEach(() => {
    const store = usePanelLayoutStore.getState();
    for (const key of Object.keys(store.layouts)) store.disposeLayout(key);
  });

  it('never reports the retired Explore takeover slice', () => {
    useChatStore.setState({ selectedWorktree: SCOPE });

    const snapshot = buildCurrentUiStateSnapshot({
      'planExplore.modal': { open: true, planId: 'plan-1' },
    });

    expect(Object.keys(snapshot)).not.toContain('planExplore');
  });

  it('reports the bound plan id on plan and plan-diagram tabs only', () => {
    useChatStore.setState({ selectedWorktree: SCOPE });
    usePanelLayoutStore.getState().initializeLayout(KEY, LAYOUT);
    usePanelLayoutStore.getState().addTab(KEY, 'group-plan', 'plan-diagram', {
      panelId: 'panel-plan-diagram-plan-1',
      title: 'Importer plan (Diagram)',
      instance: { planId: 'plan-1' },
    });

    const groups = buildCurrentUiStateSnapshot({}).panels?.groups ?? [];
    const tabs = groups.flatMap((group) => group.tabs);

    expect(tabs).toEqual([
      { panelId: 'panel-chat-chat-1', kind: 'chat', chatId: 'chat-1' },
      {
        panelId: 'panel-plan-plan-1',
        kind: 'plan',
        title: 'Importer plan',
        planId: 'plan-1',
      },
      {
        panelId: 'panel-plan-diagram-plan-1',
        kind: 'plan-diagram',
        title: 'Importer plan (Diagram)',
        planId: 'plan-1',
      },
    ]);
  });
});
