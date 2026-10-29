import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type UsageLimitedChatTarget,
} from '@canopy/desktop-shared/types';

const USAGE_LIMIT_RESUME_EXCLUDED_PROJECT_IDS = new Set<string>([
  APP_ADVISOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
]);

export function isRealWorkspaceTarget(target: UsageLimitedChatTarget): boolean {
  return !USAGE_LIMIT_RESUME_EXCLUDED_PROJECT_IDS.has(target.projectId);
}

/** Whether the Chats preference should automatically retry this surface. */
export function isTransientRetryEligibleTarget(
  target: UsageLimitedChatTarget,
): boolean {
  // App Advisor is app-managed rather than a user chat. Pipeline Assistant,
  // Plan Explore, Code Review, code workspaces, and Cowork are all user-facing
  // chat surfaces governed by the Chats preference.
  return target.projectId !== APP_ADVISOR_PROJECT_ID;
}
