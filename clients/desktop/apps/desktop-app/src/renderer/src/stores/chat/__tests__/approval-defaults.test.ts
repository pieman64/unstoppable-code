import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  approvalDefaultCacheKey,
  getApprovalDefaultsGeneration,
  invalidateApprovalDefaults,
  subscribeApprovalDefaultsGeneration,
} from '../approval-defaults';

describe('approvalDefaultCacheKey', () => {
  it.each([
    CODE_REVIEW_CHAT_PROJECT_ID,
    PLAN_EXPLORE_CHAT_PROJECT_ID,
    STANDALONE_CHAT_PROJECT_ID,
  ])('includes the owning project for %s', (projectId) => {
    expect(approvalDefaultCacheKey(projectId, 'workspace-a')).toBe(
      `${projectId}/workspace-a`,
    );
    expect(approvalDefaultCacheKey(projectId, 'workspace-b')).not.toBe(
      approvalDefaultCacheKey(projectId, 'workspace-a'),
    );
  });

  it('keeps ordinary worktree projects keyed by project id', () => {
    expect(approvalDefaultCacheKey('project-a', 'worktree-a')).toBe(
      'project-a',
    );
  });
});

describe('approval defaults generation', () => {
  it('notifies mounted consumers on invalidation and supports cleanup', () => {
    const listener = jest.fn();
    const generation = getApprovalDefaultsGeneration();
    const unsubscribe = subscribeApprovalDefaultsGeneration(listener);

    invalidateApprovalDefaults();

    expect(getApprovalDefaultsGeneration()).toBe(generation + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    invalidateApprovalDefaults();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
