import type { AgentAuditLinkTarget } from '@canopy/desktop-shared/types';

/**
 * `chatId` is optional: callers that cannot identify a specific chat must omit
 * it rather than substitute another id. `AuditTrailPage.openEntry` passes
 * `chatId` to `selectChat`, which resolves the owning Work Entry, so a
 * non-chat id there produces a dead link. Omitting it yields a
 * workspace-level target that still navigates.
 */
export function buildStandaloneChatLinkTarget(
  standaloneProjectId: string,
  chatId?: string,
): AgentAuditLinkTarget {
  return {
    page: 'chat',
    kind: 'standalone-chat',
    worktreeId: standaloneProjectId,
    ...(chatId ? { chatId } : {}),
  };
}
