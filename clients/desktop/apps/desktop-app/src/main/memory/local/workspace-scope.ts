import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { getPlanExploreTarget } from '../../lib/plan-explore-registry';
import { getCodeReviewTarget } from '../../lib/code-review-registry';

/**
 * Resolve the REAL workspace id whose local-memory directory a session may
 * use, or null when the session has no workspace scope. Plan-explore and
 * code-review chats run under global sentinel project ids with the plan id /
 * review scope key in the worktree slot; keying memory by the sentinel would
 * share one durable memory directory across every project's special chats
 * (cross-project disclosure and poisoning). Resolve the sentinel through its
 * target registry instead, and fail toward NO workspace scope when no real
 * target is registered. Real project and cowork workspace ids pass through
 * unchanged. Shared by the SaveMemory/SearchMemory tool runtime and the
 * turn-injection preparation so both sides always read the same directory.
 */
export async function resolveMemoryWorkspaceId(options: {
  projectId: string;
  worktreeId: string;
}): Promise<string | null> {
  if (options.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    const ref = await getPlanExploreTarget(options.worktreeId);
    return ref === null ? null : ref.projectId;
  }
  if (options.projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    const ref = await getCodeReviewTarget(options.worktreeId);
    return ref === null ? null : ref.projectId;
  }
  // Legacy cowork wire shape: the permanent standalone-chat sentinel carries
  // the real cowork workspace id in the worktree slot.
  if (options.projectId === STANDALONE_CHAT_PROJECT_ID) {
    return options.worktreeId;
  }
  return options.projectId;
}
