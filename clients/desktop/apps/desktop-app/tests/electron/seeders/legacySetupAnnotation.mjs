import { seedWorktreeChat } from './seedWorktreeChat.mjs';

export const LEGACY_SETUP_PROMPT = 'Check the project instructions.';
export const LEGACY_SETUP_REPLY = 'The project is ready for your next task.';

/** Fixed legacy history shared by reload coverage and before/after captures. */
export function seedLegacySetupChat(userDataDir) {
  const timestamp = Date.parse('2026-10-20T13:28:00.000Z');
  return seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    tabs: [
      {
        id: 'legacy-setup-chat',
        title: 'Project instructions',
        messages: [
          {
            id: 'legacy-setup',
            role: 'system',
            timestamp,
            blocks: [{ type: 'pending_setup_info', timestamp }],
          },
          {
            id: 'legacy-user',
            role: 'user',
            timestamp: timestamp + 1000,
            blocks: [{ type: 'text', text: LEGACY_SETUP_PROMPT }],
          },
          {
            id: 'legacy-assistant',
            role: 'assistant',
            timestamp: timestamp + 2000,
            blocks: [{ type: 'text', text: LEGACY_SETUP_REPLY }],
          },
        ],
      },
    ],
  });
}
