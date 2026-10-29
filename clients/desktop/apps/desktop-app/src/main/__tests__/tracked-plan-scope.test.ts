import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { hasTrackedPlanCommentStorage } from '../canopy-tools/plan-comment-threads';
import { hasTrackedPlanStorage } from '../lib/tracked-plan-scope';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

describe('hasTrackedPlanStorage', () => {
  afterEach(() => {
    registerWorkspaceTypes(new Map());
  });

  it.each([
    APP_ADVISOR_PROJECT_ID,
    PIPELINE_EDITOR_PROJECT_ID,
    PLAN_EXPLORE_CHAT_PROJECT_ID,
    CODE_REVIEW_CHAT_PROJECT_ID,
    STANDALONE_CHAT_PROJECT_ID,
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
  ])('is false for the %s sentinel', (projectId) => {
    expect(hasTrackedPlanStorage(projectId)).toBe(false);
  });

  it('is false for Cowork workspaces and true for code workspaces', () => {
    registerWorkspaceTypes(
      new Map([
        ['cowork-workspace', 'cowork'],
        ['single-repo', 'single-repo'],
      ]),
    );

    expect(hasTrackedPlanStorage('cowork-workspace')).toBe(false);
    expect(hasTrackedPlanStorage('single-repo')).toBe(true);
  });

  it('backs the plan comment tools scope gate', () => {
    registerWorkspaceTypes(new Map([['cowork-workspace', 'cowork']]));

    for (const projectId of [
      APP_ADVISOR_PROJECT_ID,
      'cowork-workspace',
      'single-repo',
    ]) {
      expect(hasTrackedPlanCommentStorage(projectId)).toBe(
        hasTrackedPlanStorage(projectId),
      );
    }
  });
});
