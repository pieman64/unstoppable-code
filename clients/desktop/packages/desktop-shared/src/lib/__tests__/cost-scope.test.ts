import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '../../types';
import { isCostWorkScope } from '../cost-scope';

describe('isCostWorkScope', () => {
  it('keeps cost for a worktree and for a Work Entry', () => {
    expect(isCostWorkScope('project-1', 'worktree-1')).toBe(true);
    expect(isCostWorkScope('cowork-1', 'entry-1')).toBe(true);
    expect(isCostWorkScope(APP_ADVISOR_PROJECT_ID, 'entry-1')).toBe(true);
  });

  it('keeps none for a reserved chat scope', () => {
    expect(
      isCostWorkScope(PIPELINE_EDITOR_PROJECT_ID, PIPELINE_EDITOR_WORKTREE_ID),
    ).toBe(false);
    expect(isCostWorkScope(PLAN_EXPLORE_CHAT_PROJECT_ID, 'worktree-1')).toBe(
      false,
    );
    expect(isCostWorkScope(CODE_REVIEW_CHAT_PROJECT_ID, 'worktree-1')).toBe(
      false,
    );
    expect(isCostWorkScope('cowork-1', COWORK_HOME_WORKTREE_ID)).toBe(false);
    expect(
      isCostWorkScope(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID),
    ).toBe(false);
  });
});
