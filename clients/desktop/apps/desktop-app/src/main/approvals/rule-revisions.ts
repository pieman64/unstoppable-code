const workspaceRuleRevisions = new Map<string, number>();
let globalRuleRevision = 0;
let approvalSettingsRevision = 0;

export function getWorkspaceApprovalRulesRevision(workspaceId: string): number {
  return workspaceRuleRevisions.get(workspaceId) ?? 0;
}

export function markWorkspaceApprovalRulesChanged(workspaceId: string): void {
  workspaceRuleRevisions.set(
    workspaceId,
    getWorkspaceApprovalRulesRevision(workspaceId) + 1,
  );
  approvalSettingsRevision++;
}

export function getGlobalApprovalRulesRevision(): number {
  return globalRuleRevision;
}

export function markGlobalApprovalRulesChanged(): void {
  globalRuleRevision++;
  approvalSettingsRevision++;
}

/** A surface's persisted default approval mode is changing or changed. */
export function markApprovalDefaultsChanged(): void {
  approvalSettingsRevision++;
}

/**
 * Changes whenever a workspace or global rule tier, a workspace's
 * approvals file, or a surface's default mode changes, so a synchronous
 * step can tell whether policies read before it are still current.
 */
export function getApprovalSettingsRevision(): number {
  return approvalSettingsRevision;
}

const chatApprovalStateRevisions = new Map<string, number>();

function chatApprovalStateKey(chat: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return `${chat.projectId}\u0000${chat.worktreeId}\u0000${chat.chatId}`;
}

/** A chat's tab changed its approval mode, session grants, or repository. */
export function markChatApprovalStateChanged(chat: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): void {
  const key = chatApprovalStateKey(chat);
  chatApprovalStateRevisions.set(
    key,
    (chatApprovalStateRevisions.get(key) ?? 0) + 1,
  );
}

/**
 * Changes whenever a commit changes the chat's tab approval mode, session
 * grants, or selected repository, in the synchronous step that builds it.
 */
export function getChatApprovalStateRevision(chat: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): number {
  return chatApprovalStateRevisions.get(chatApprovalStateKey(chat)) ?? 0;
}
