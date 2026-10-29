import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  type UsageLimitedSessionGroup,
  type UsageLimitedSessionItem,
} from '@canopy/desktop-shared/types';
import { getCodeReviewOrigin } from '@/stores/chat/code-review-registry';

export function usageLimitedSessionWorkspaceId(
  session: UsageLimitedSessionItem,
  fallbackWorkspaceId: string | undefined,
): string | undefined {
  if (session.projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    return (
      getCodeReviewOrigin(session.worktreeId ?? '')?.projectId ??
      fallbackWorkspaceId ??
      session.projectId
    );
  }
  return session.projectId ?? fallbackWorkspaceId;
}

export function filterSessionGroupsByWorkspace(
  groups: UsageLimitedSessionGroup[],
  isInContext: (workspaceId: string) => boolean,
): UsageLimitedSessionGroup[] {
  return groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((session) => {
        const workspaceId = usageLimitedSessionWorkspaceId(
          session,
          group.workspaceId,
        );
        return workspaceId === undefined || isInContext(workspaceId);
      }),
    }))
    .filter((group) => group.sessions.length > 0);
}
