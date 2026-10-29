import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';

const UNSUPPORTED_SESSION_TRANSFER_TARGETS = new Set([
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
]);

/** Real git-backed and Cowork workspaces can create private session exports. */
export function canTransferChatSession(projectId: string): boolean {
  return !UNSUPPORTED_SESSION_TRANSFER_TARGETS.has(projectId);
}
