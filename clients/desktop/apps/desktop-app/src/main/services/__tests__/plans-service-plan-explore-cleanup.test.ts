const mockedDeleteTrackedPlan = jest.fn<
  Promise<void>,
  [projectId: string, worktreeId: string, planId: string]
>(() => Promise.resolve());
// `deletePlan` reads the plan before removing it so it can name the deleted
// plan on the renderer's `trackedPlansUpdated` channel (CAN-1305).
const mockedGetTrackedPlan = jest.fn<
  Promise<null>,
  [projectId: string, worktreeId: string, planId: string]
>(() => Promise.resolve(null));
jest.mock('../../lib/plan-persistence', () => ({
  deleteTrackedPlan: (
    projectId: string,
    worktreeId: string,
    planId: string,
  ): Promise<void> => mockedDeleteTrackedPlan(projectId, worktreeId, planId),
  getTrackedPlan: (
    projectId: string,
    worktreeId: string,
    planId: string,
  ): Promise<null> => mockedGetTrackedPlan(projectId, worktreeId, planId),
}));
jest.mock('../../lib/shared-plan-sync', () => ({
  shareTrackedPlan: jest.fn(),
}));
const mockedEmitPortalFeatureRemove = jest.fn();
jest.mock('../portal-feature-event-service', () => ({
  emitPortalFeatureRemove: (...args: unknown[]): void => {
    mockedEmitPortalFeatureRemove(...args);
  },
  emitPortalFeatureUpsert: jest.fn(),
}));
interface PlanExploreOwner {
  projectId: string;
  worktreeId: string;
}
const callOrder: string[] = [];
const mockedRemovePlanExploreChat = jest.fn(
  (planId: string, owner: PlanExploreOwner): Promise<string[]> => {
    callOrder.push(`explore:${owner.projectId}/${owner.worktreeId}/${planId}`);
    return Promise.resolve([]);
  },
);
jest.mock('../../lib/plan-explore-cleanup', () => ({
  removePlanExploreChat: (
    planId: string,
    owner: PlanExploreOwner,
  ): Promise<string[]> => mockedRemovePlanExploreChat(planId, owner),
}));

import { deletePlan, deleteTrackedPlanData } from '../plans-service';

describe('plans-service plan deletion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    callOrder.length = 0;
    mockedDeleteTrackedPlan.mockImplementation((): Promise<void> => {
      callOrder.push('plan');
      return Promise.resolve();
    });
  });

  it('removes the plan-explore chat scope when the desktop deletes a plan', async () => {
    await deleteTrackedPlanData({
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      planId: 'plan-1',
    });

    expect(mockedDeleteTrackedPlan).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      'plan-1',
    );
    // The owning worktree scopes the cleanup: a same-id plan in another
    // worktree must never be reclaimed by this deletion.
    expect(mockedRemovePlanExploreChat).toHaveBeenCalledWith('plan-1', {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
    expect(callOrder).toEqual(['plan', 'explore:ws-1/wt-1/plan-1']);
  });

  it('removes the plan-explore chat scope when the portal deletes a plan', async () => {
    await expect(
      deletePlan(
        { projectId: 'ws-1', worktreeId: 'wt-1', planId: 'plan-2' },
        { portalCommandId: 'cmd-1' },
      ),
    ).resolves.toEqual({ ok: true });

    expect(mockedRemovePlanExploreChat).toHaveBeenCalledWith('plan-2', {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
    });
    expect(mockedEmitPortalFeatureRemove).toHaveBeenCalledWith(
      expect.objectContaining({ localId: 'plan-2', commandId: 'cmd-1' }),
    );
  });

  it('still deletes the plan when the renderer-notification read fails', async () => {
    // The pre-delete read exists only to populate the renderer event. A
    // corrupt or unreadable plan file must not turn a working portal delete
    // into a failed command.
    mockedGetTrackedPlan.mockRejectedValueOnce(new Error('unreadable'));

    await expect(
      deletePlan(
        { projectId: 'ws-1', worktreeId: 'wt-1', planId: 'plan-4' },
        { portalCommandId: 'cmd-2' },
      ),
    ).resolves.toEqual({ ok: true });

    expect(mockedDeleteTrackedPlan).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      'plan-4',
    );
  });

  it('still deletes the plan when the explore chat cleanup fails', async () => {
    mockedRemovePlanExploreChat.mockRejectedValueOnce(new Error('locked'));

    await expect(
      deleteTrackedPlanData({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        planId: 'plan-3',
      }),
    ).resolves.toBeUndefined();

    expect(mockedDeleteTrackedPlan).toHaveBeenCalledTimes(1);
    expect(mockedEmitPortalFeatureRemove).toHaveBeenCalledTimes(1);
  });
});
