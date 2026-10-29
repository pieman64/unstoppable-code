import {
  CHAT_LABEL,
  WORKTREE_LABEL,
  WORKTREE_UNIT_LABEL,
} from '@canopy/protocol';

export const CODE_PROJECT_LABEL = `${WORKTREE_LABEL} project`;
export const COWORK_PROJECT_LABEL = `${CHAT_LABEL} project`;

/**
 * Shared by the import modal and Settings. A general explanation, not a
 * report on the folder's git state. Without a remote, creation can use HEAD.
 */
export const CODE_CHAT_DESTINATION_NOTE = `Chats from a ${CODE_PROJECT_LABEL} open in a new ${WORKTREE_UNIT_LABEL.toLowerCase()} based on the default branch from your remote when available. Uncommitted or unpushed changes stay in the original folder.`;
