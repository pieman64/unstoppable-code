import {
  CHAT_LABEL,
  WORKTREE_LABEL,
  WORKTREE_UNIT_LABEL,
} from '@canopy/protocol';

export const CODE_PROJECT_LABEL = `${WORKTREE_LABEL} project`;
export const COWORK_PROJECT_LABEL = `${CHAT_LABEL} project`;

/**
 * Shared by the import modal and Settings. A general reminder, not a report
 * on the folder's git state: uncommitted or unpushed work stays behind.
 */
export const CODE_CHAT_DESTINATION_NOTE = `Chats from ${CODE_PROJECT_LABEL}s open in a new ${WORKTREE_UNIT_LABEL.toLowerCase()}, so commit and push your work before you import.`;

/** Leads the import modal's choose phase. */
export const IMPORT_SAFETY_NOTE = `Your folders stay put and nothing changes until you say so. ${CODE_CHAT_DESTINATION_NOTE}`;
