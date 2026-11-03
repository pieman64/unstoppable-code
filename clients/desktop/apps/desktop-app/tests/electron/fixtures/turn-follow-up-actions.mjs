import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { seedWorktreeChat } from '../seeders/seedWorktreeChat.mjs';
export const target = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
  chatId: 'reply-actions',
};
export function seedReplyActions(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const base = Date.parse('2026-10-29T10:00:00Z');
  const messages = [
    {
      id: 'prompt-1',
      role: 'user',
      timestamp: base,
      blocks: [{ type: 'text', text: 'Run the full test suite.' }],
    },
  ];
  for (let i = 0; i < 3; i++) {
    messages.push({
      id: `timer-${i}`,
      role: 'system',
      timestamp: base + i * 60000 + 1000,
      blocks: [
        {
          type: 'turn_timer',
          turnId: `turn-${i}`,
          ...(i === 0 ? { userMessageId: 'prompt-1' } : { spawnedBy: {} }),
          startedAt: base + i * 60000,
          completedAt: base + i * 60000 + 5000,
        },
      ],
    });
    messages.push({
      id: `reply-${i}`,
      role: 'assistant',
      timestamp: base + i * 60000 + 4000,
      blocks: [
        {
          type: 'text',
          text: [
            'The tests are running in the background.',
            'The test suite passed. All 48 tests are green.',
            'The background review passed too.',
          ][i],
        },
      ],
    });
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: target.projectId,
    worktreeId: target.worktreeId,
    providerType: 'codex',
    activeTabId: target.chatId,
    tabs: [{ id: target.chatId, title: 'Test runner', messages }],
  });
}
