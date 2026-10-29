import { PLAN_EXPLORE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  captureActivePlanContext,
  resetActivePlanStoreForTests,
  useActivePlanStore,
  type ActivePlanScope,
} from '../activePlanStore';

const SCOPE: ActivePlanScope = { projectId: 'proj-1', worktreeId: 'wt-1' };
const OTHER_SCOPE: ActivePlanScope = {
  projectId: 'proj-1',
  worktreeId: 'wt-2',
};

function state(): ReturnType<typeof useActivePlanStore.getState> {
  return useActivePlanStore.getState();
}

beforeEach(() => {
  resetActivePlanStoreForTests();
});

describe('activePlanStore mount/markActive/capture', () => {
  it('captures the active plan once mounted and marked active', () => {
    state().mountView(SCOPE, 'plan-1');
    state().markActive(SCOPE, 'plan-1');

    expect(captureActivePlanContext(SCOPE)).toEqual({ planId: 'plan-1' });
  });

  it('gives the last focus the active slot across two plans', () => {
    state().mountView(SCOPE, 'plan-1');
    state().mountView(SCOPE, 'plan-2');

    state().markActive(SCOPE, 'plan-1');
    expect(captureActivePlanContext(SCOPE)).toEqual({ planId: 'plan-1' });

    state().markActive(SCOPE, 'plan-2');
    expect(captureActivePlanContext(SCOPE)).toEqual({ planId: 'plan-2' });

    // Focus moves back.
    state().markActive(SCOPE, 'plan-1');
    expect(captureActivePlanContext(SCOPE)).toEqual({ planId: 'plan-1' });
  });

  it('keeps a plan active while one of its two mounted views unmounts', () => {
    state().mountView(SCOPE, 'plan-1');
    state().mountView(SCOPE, 'plan-1');
    state().markActive(SCOPE, 'plan-1');

    state().unmountView(SCOPE, 'plan-1');
    expect(captureActivePlanContext(SCOPE)).toEqual({ planId: 'plan-1' });
    expect(state().viewCounts).toMatchObject(
      expect.objectContaining({
        [JSON.stringify([SCOPE.projectId, SCOPE.worktreeId, 'plan-1'])]: 1,
      }),
    );
  });

  it('clears the active plan and its viewed revision on the last unmount', () => {
    state().mountView(SCOPE, 'plan-1');
    state().markActive(SCOPE, 'plan-1');
    state().setViewedRevision(SCOPE, 'plan-1', 3);

    state().unmountView(SCOPE, 'plan-1');

    expect(captureActivePlanContext(SCOPE)).toBeUndefined();
    expect(
      state().activeByWorktree[`${SCOPE.projectId}/${SCOPE.worktreeId}`],
    ).toBeUndefined();
    const key = JSON.stringify([SCOPE.projectId, SCOPE.worktreeId, 'plan-1']);
    expect(state().viewedRevisions[key]).toBeUndefined();
    expect(state().viewCounts[key]).toBeUndefined();
  });

  it('includes the viewed revision only while one is set', () => {
    state().mountView(SCOPE, 'plan-1');
    state().markActive(SCOPE, 'plan-1');

    expect(captureActivePlanContext(SCOPE)).toEqual({ planId: 'plan-1' });

    state().setViewedRevision(SCOPE, 'plan-1', 2);
    expect(captureActivePlanContext(SCOPE)).toEqual({
      planId: 'plan-1',
      viewedRevisionNumber: 2,
    });

    state().setViewedRevision(SCOPE, 'plan-1', null);
    expect(captureActivePlanContext(SCOPE)).toEqual({ planId: 'plan-1' });
  });

  it('leaves another worktree unaffected', () => {
    state().mountView(SCOPE, 'plan-1');
    state().markActive(SCOPE, 'plan-1');

    state().mountView(OTHER_SCOPE, 'plan-2');
    state().markActive(OTHER_SCOPE, 'plan-2');

    expect(captureActivePlanContext(SCOPE)).toEqual({ planId: 'plan-1' });
    expect(captureActivePlanContext(OTHER_SCOPE)).toEqual({
      planId: 'plan-2',
    });

    state().unmountView(OTHER_SCOPE, 'plan-2');
    expect(captureActivePlanContext(SCOPE)).toEqual({ planId: 'plan-1' });
    expect(captureActivePlanContext(OTHER_SCOPE)).toBeUndefined();
  });

  it('returns undefined for a sentinel or missing scope', () => {
    state().mountView(SCOPE, 'plan-1');
    state().markActive(SCOPE, 'plan-1');

    expect(captureActivePlanContext(undefined)).toBeUndefined();
    expect(captureActivePlanContext(null)).toBeUndefined();
    expect(
      captureActivePlanContext({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
      }),
    ).toBeUndefined();
  });

  it('keeps state identity when markActive is a no-op', () => {
    state().mountView(SCOPE, 'plan-1');
    state().markActive(SCOPE, 'plan-1');
    const afterFirstMark = state();

    // Already active: no-op.
    state().markActive(SCOPE, 'plan-1');
    expect(state()).toBe(afterFirstMark);

    // No mounted view: no-op.
    state().markActive(SCOPE, 'plan-unmounted');
    expect(state()).toBe(afterFirstMark);
  });
});
