import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';
import { mergeSeedPreferences } from './mergePreferences.mjs';
import { seedCoworkWorkspace } from './seedCoworkWorkspace.mjs';
import { seedWelcomeChecklist } from './seedWelcomeChecklist.mjs';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';

export const COWORK_RESUME_WORKSPACE_ID = 'support-ops';
export const COWORK_RESUME_WORKSPACE_NAME = 'Support Ops';
export const COWORK_RESUME_CHAT_ID = 'weekly-digest';
export const COWORK_RESUME_CHAT_TITLE = 'Weekly digest';
export const COWORK_RESUME_ENTRY_ID = 'friday-weekly-digest';
export const COWORK_RESUME_MESSAGE =
  'Friday Support Ops digest: review the seven escalations.';

/**
 * A returning user's Monday relaunch (CAN-4746): basics done so Getting
 * started has moved on to advanced suggestions, and Friday's Cowork chat
 * still resolves as the startup resume offer. A canonical Work Entry holds
 * Friday's exact chat; a newer decoy entry ensures workspace-only navigation
 * cannot accidentally satisfy the destination assertion.
 */
export function seedCoworkResumeChecklist() {
  const userDataDir = seedWelcomeChecklist();
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: COWORK_RESUME_WORKSPACE_ID,
    name: COWORK_RESUME_WORKSPACE_NAME,
    chatId: COWORK_RESUME_CHAT_ID,
    chatTitle: COWORK_RESUME_CHAT_TITLE,
    mergeIndex: true,
  });
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      COWORK_RESUME_WORKSPACE_ID,
      'work-entries.json',
    ),
    {
      version: 1,
      entries: [
        { id: 'monday-decoy', createdAt: '2026-10-19T12:00:00.000Z' },
        { id: COWORK_RESUME_ENTRY_ID, createdAt: '2026-10-16T12:00:00.000Z' },
      ],
    },
  );
  for (const [entryId, chatId, title, text] of [
    [
      'monday-decoy',
      'monday-planning',
      'Monday planning',
      'Decoy chat: this is not the Friday digest.',
    ],
    [
      COWORK_RESUME_ENTRY_ID,
      COWORK_RESUME_CHAT_ID,
      COWORK_RESUME_CHAT_TITLE,
      COWORK_RESUME_MESSAGE,
    ],
  ]) {
    seedWorktreeChat({
      userDataDir,
      workspaceId: COWORK_RESUME_WORKSPACE_ID,
      worktreeId: entryId,
      providerType: 'codex',
      tabs: [{ id: chatId, title, blocks: [{ type: 'text', text }] }],
    });
  }
  mergeSeedPreferences(userDataDir, {
    lastActiveContext: {
      kind: 'cowork',
      workspaceId: COWORK_RESUME_WORKSPACE_ID,
      workEntryId: COWORK_RESUME_ENTRY_ID,
    },
  });
  return userDataDir;
}
