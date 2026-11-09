/**
 * Chat routing ids shared by the desktop, the portable CanopyClient adapter
 * and the web clients, so none of them keeps its own copy.
 */

/**
 * Synthetic project id that namespaces standalone chat IPC requests (chats
 * outside any workspace).
 */
export const STANDALONE_CHAT_PROJECT_ID = 'standalone-chat';

/**
 * LEGACY worktreeId slot for cowork workspaces from before Work Entries.
 * Cowork chats now key as (projectId = workspaceId, worktreeId = workEntryId)
 * — each Work Entry is a worktree-like multi-chat container — so chat tabs,
 * worktree-data, cleanup, and observability reuse the code workspace
 * (projectId, worktreeId) plumbing unchanged. `'home'` survives only as the
 * pre-entry data location (migration source, legacy `chat-archives/home.json`
 * reads, sentinel-branch fallback) and as the keying for the shared cowork
 * attachment bucket (cowork attachments physically live in the workspace's
 * managed dir regardless of entry). Do not write new per-entry data under it.
 */
export const COWORK_HOME_WORKTREE_ID = 'home';

/**
 * Synthetic project id of the Orchestrator (App Advisor): its Work Entries and
 * chats key as (projectId = this, worktreeId = workEntryId).
 */
export const APP_ADVISOR_PROJECT_ID = 'app-advisor';
