import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { isCoworkWorkspace } from './workspace-registry';

/**
 * Sentinel project ids whose chats have no tracked-plan storage of their own.
 * The plan-explore and Code Review sentinels are listed for completeness:
 * callers resolve them to the real scope they act on before asking, so those
 * chats still reach that scope's plans.
 */
const PROJECT_IDS_WITHOUT_TRACKED_PLANS: ReadonlySet<string> = new Set([
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
]);

/**
 * Whether a real `(projectId, worktreeId)` scope can own tracked plans, and so
 * plan comment threads and materialized plan files. Assistant and app-managed
 * sentinels, the shared-container viewer, and Cowork workspaces cannot.
 */
export function hasTrackedPlanStorage(projectId: string): boolean {
  return (
    !PROJECT_IDS_WITHOUT_TRACKED_PLANS.has(projectId) &&
    !isCoworkWorkspace(projectId)
  );
}
