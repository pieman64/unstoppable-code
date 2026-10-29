/** @jest-environment jsdom */

import {
  APP_ADVISOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  getPanelInstanceKey,
  makeAuxPanelLayoutKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import {
  collectPlanPanelBindings,
  familyHasPlanPanel,
  isPlanPanelKind,
  isPlanPanelOnScreen,
  isPlanPanelScope,
  planDiagramPanelIdFor,
  planDiagramPanelTitle,
  planDiagramSeed,
  planDocumentSeed,
  planPanelIdFor,
  planPanelInstanceKey,
  planPanelTitle,
  planPanelTitleFor,
} from '../plan-panel-identity';

const KEY = 'project-1/worktree-1';
const OTHER_KEY = 'project-1/worktree-2';
const AUX_KEY = makeAuxPanelLayoutKey(KEY, 'aux-1');

afterEach(() => {
  const store = usePanelLayoutStore.getState();
  for (const key of Object.keys(store.layouts)) {
    store.disposeLayout(key);
  }
});

describe('plan panel identity', () => {
  test('derives deterministic panel ids and the layout instance keys', () => {
    expect(planPanelIdFor('plan-1')).toBe('panel-plan-plan-1');
    expect(planDiagramPanelIdFor('plan-1')).toBe('panel-plan-diagram-plan-1');
    expect(planPanelInstanceKey('plan', 'plan-1')).toBe(
      getPanelInstanceKey({ kind: 'plan', instance: { planId: 'plan-1' } }),
    );
    expect(planPanelInstanceKey('plan-diagram', 'plan-1')).toBe(
      'plan-diagram:plan-1',
    );
    expect(isPlanPanelKind('plan')).toBe(true);
    expect(isPlanPanelKind('plan-diagram')).toBe(true);
    expect(isPlanPanelKind('change-diagram')).toBe(false);
  });

  test('titles panels with the plan title, falling back to Plan', () => {
    expect(planPanelTitle({ title: '  Ship the importer  ' })).toBe(
      'Ship the importer',
    );
    expect(planPanelTitle({ title: '   ' })).toBe('Plan');
    expect(planDiagramPanelTitle({ title: 'Ship the importer' })).toBe(
      'Ship the importer (Diagram)',
    );
    expect(planPanelTitleFor('plan', { title: 'A' })).toBe('A');
    expect(planPanelTitleFor('plan-diagram', { title: 'A' })).toBe(
      'A (Diagram)',
    );
  });

  test('builds content seeds bound to the plan id', () => {
    const plan = { id: 'plan-1', title: 'Importer' };
    expect(planDocumentSeed(plan)).toEqual({
      kind: 'plan',
      panelId: 'panel-plan-plan-1',
      instance: { planId: 'plan-1' },
      title: 'Importer',
    });
    expect(planDiagramSeed(plan)).toEqual({
      kind: 'plan-diagram',
      panelId: 'panel-plan-diagram-plan-1',
      instance: { planId: 'plan-1' },
      title: 'Importer (Diagram)',
    });
  });

  test.each([
    [STANDALONE_CHAT_PROJECT_ID, false],
    [APP_ADVISOR_PROJECT_ID, false],
    [PLAN_EXPLORE_CHAT_PROJECT_ID, false],
    [SHARED_CONTAINER_VIEWER_PROJECT_ID, true],
    ['project-1', true],
  ])('isPlanPanelScope(%s) is %s', (projectId, expected) => {
    expect(isPlanPanelScope(projectId)).toBe(expected);
  });

  test('collects plan panels across the main layout and its windows only', () => {
    const store = usePanelLayoutStore.getState();
    store.initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'plan',
          groupId: 'group-main',
          panelId: 'panel-plan-plan-1',
          title: 'One',
          instance: { planId: 'plan-1' },
        },
        { kind: 'terminal', groupId: 'group-terminal', panelId: 'terminal' },
      ],
    });
    store.initializeLayout(AUX_KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'plan-diagram',
          groupId: 'group-aux',
          panelId: 'panel-plan-diagram-plan-1',
          instance: { planId: 'plan-1' },
        },
      ],
    });
    store.initializeLayout(OTHER_KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'plan',
          groupId: 'group-other',
          panelId: 'panel-plan-plan-2',
          instance: { planId: 'plan-2' },
        },
      ],
    });
    const layouts = usePanelLayoutStore.getState().layouts;

    expect(collectPlanPanelBindings(layouts, KEY)).toEqual([
      {
        layoutKey: KEY,
        groupId: 'group-main',
        panelId: 'panel-plan-plan-1',
        kind: 'plan',
        planId: 'plan-1',
        title: 'One',
      },
      {
        layoutKey: AUX_KEY,
        groupId: 'group-aux',
        panelId: 'panel-plan-diagram-plan-1',
        kind: 'plan-diagram',
        planId: 'plan-1',
        title: undefined,
      },
    ]);
    expect(familyHasPlanPanel(layouts, KEY, 'plan-diagram', 'plan-1')).toBe(
      true,
    );
    expect(familyHasPlanPanel(layouts, KEY, 'plan', 'plan-2')).toBe(false);
    expect(familyHasPlanPanel(layouts, OTHER_KEY, 'plan', 'plan-2')).toBe(true);
  });

  describe('isPlanPanelOnScreen', () => {
    function seedSplit(): void {
      usePanelLayoutStore.getState().initializeLayout(KEY, {
        orientation: 'horizontal',
        groups: [
          {
            kind: 'plan',
            groupId: 'group-document',
            panelId: 'panel-plan-plan-1',
            instance: { planId: 'plan-1' },
          },
          {
            kind: 'plan-diagram',
            groupId: 'group-diagram',
            panelId: 'panel-plan-diagram-plan-1',
            instance: { planId: 'plan-1' },
          },
        ],
      });
    }

    function onScreen(kind: 'plan' | 'plan-diagram'): boolean {
      return isPlanPanelOnScreen(
        usePanelLayoutStore.getState().layouts,
        KEY,
        kind,
        'plan-1',
      );
    }

    it('is on screen as the active tab of an expanded group', () => {
      seedSplit();
      expect(onScreen('plan')).toBe(true);
      expect(onScreen('plan-diagram')).toBe(true);
      expect(
        isPlanPanelOnScreen(
          usePanelLayoutStore.getState().layouts,
          KEY,
          'plan',
          'plan-2',
        ),
      ).toBe(false);
    });

    it('is off screen behind another tab of its group', () => {
      seedSplit();
      usePanelLayoutStore
        .getState()
        .addTab(KEY, 'group-diagram', 'terminal', { panelId: 'terminal-1' });
      expect(onScreen('plan-diagram')).toBe(false);
      usePanelLayoutStore
        .getState()
        .selectTab(KEY, 'group-diagram', 'panel-plan-diagram-plan-1');
      expect(onScreen('plan-diagram')).toBe(true);
    });

    it('is off screen while its group is collapsed or another group is maximized', () => {
      seedSplit();
      usePanelLayoutStore.getState().collapseGroup(KEY, 'group-diagram');
      expect(onScreen('plan-diagram')).toBe(false);
      usePanelLayoutStore.getState().expandGroup(KEY, 'group-diagram');
      expect(onScreen('plan-diagram')).toBe(true);

      usePanelLayoutStore.getState().maximizeGroup(KEY, 'group-document', true);
      expect(onScreen('plan-diagram')).toBe(false);
      expect(onScreen('plan')).toBe(true);
    });

    it('counts a panel popped out into one of the worktree windows', () => {
      usePanelLayoutStore.getState().initializeLayout(KEY, {
        orientation: 'horizontal',
        groups: [
          {
            kind: 'plan',
            groupId: 'group-document',
            panelId: 'panel-plan-plan-1',
            instance: { planId: 'plan-1' },
          },
        ],
      });
      usePanelLayoutStore.getState().initializeLayout(AUX_KEY, {
        orientation: 'horizontal',
        groups: [
          {
            kind: 'plan-diagram',
            groupId: 'group-aux',
            panelId: 'panel-plan-diagram-plan-1',
            instance: { planId: 'plan-1' },
          },
        ],
      });
      expect(onScreen('plan-diagram')).toBe(true);
    });
  });
});
