import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '../types';

/**
 * Chat project ids that are sentinels, not memory workspaces. A selection
 * carrying one of these has no workspace-scoped memory of its own; the
 * memory IPC rejects them and callers must fall back to the user scope.
 */
export const LOCAL_MEMORY_CHAT_SCOPE_SENTINELS: ReadonlySet<string> =
  new Set<string>([
    PLAN_EXPLORE_CHAT_PROJECT_ID,
    CODE_REVIEW_CHAT_PROJECT_ID,
    STANDALONE_CHAT_PROJECT_ID,
  ]);

/** Project id that can back a workspace memory scope (not a chat sentinel). */
export function isLocalMemoryWorkspaceId(
  projectId: string | undefined,
): projectId is string {
  return (
    typeof projectId === 'string' &&
    projectId !== '' &&
    !LOCAL_MEMORY_CHAT_SCOPE_SENTINELS.has(projectId)
  );
}
