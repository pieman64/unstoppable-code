import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type { SpaceNotificationScope } from '@canopy/desktop-shared/types';
import { ADVISORY_WORKSPACE_PROJECT_IDS } from '@canopy/protocol/telemetry';
import { getCodeReviewTarget } from './code-review-registry';
import { getPlanExploreTarget } from './plan-explore-registry';

const ADVISORY_PROJECT_IDS: ReadonlySet<string> = new Set(
  ADVISORY_WORKSPACE_PROJECT_IDS,
);

/**
 * The space a chat's notifications belong to (CAN-3615). Plan-explore and
 * code-review chats run under sentinel project ids, with the plan id or
 * review scope key in the worktree slot; they count toward the real
 * worktree their registry records, as the renderer's chat scope does. App
 * Advisor and the Pipeline Assistant belong to no space, and an
 * unregistered sentinel has none either; both keep the default.
 */
export async function resolveSpaceNotificationScope(
  target: SpaceNotificationScope,
): Promise<SpaceNotificationScope | null> {
  if (target.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID)
    return getPlanExploreTarget(target.worktreeId);
  if (target.projectId === CODE_REVIEW_CHAT_PROJECT_ID)
    return getCodeReviewTarget(target.worktreeId);
  if (ADVISORY_PROJECT_IDS.has(target.projectId)) return null;
  return { projectId: target.projectId, worktreeId: target.worktreeId };
}
