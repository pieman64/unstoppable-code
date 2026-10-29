/**
 * Which `(projectId, worktreeId)` pairs keep cost: a Code worktree, or a
 * Cowork or App Advisor Work Entry. Reserved chat scopes, such as the
 * Pipeline Assistant's, the plan and review helpers' and the Cowork home
 * composer's, keep none and have no cost views.
 */
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  CURSOR_APPROVAL_CHECK_PROJECT_ID,
  DEFAULT_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '../types';

const SYNTHETIC_PROJECT_IDS: ReadonlySet<string> = new Set([
  STANDALONE_CHAT_PROJECT_ID,
  DEFAULT_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  CURSOR_APPROVAL_CHECK_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
]);

const SYNTHETIC_WORKTREE_IDS: ReadonlySet<string> = new Set([
  APP_ADVISOR_WORKTREE_ID,
  COWORK_HOME_WORKTREE_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
]);

/** Whether the pair names a scope the cost index keeps an entry for. */
export function isCostWorkScope(
  projectId: string,
  worktreeId: string,
): boolean {
  // App Advisor's project id is a reserved scope name, but a Work Entry id in
  // its worktree slot is a real, independently retained cost scope. The old
  // `global` slot is not a Work Entry and is deliberately excluded.
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    return worktreeId !== APP_ADVISOR_WORKTREE_ID;
  }

  return (
    !SYNTHETIC_PROJECT_IDS.has(projectId) &&
    !SYNTHETIC_WORKTREE_IDS.has(worktreeId)
  );
}
