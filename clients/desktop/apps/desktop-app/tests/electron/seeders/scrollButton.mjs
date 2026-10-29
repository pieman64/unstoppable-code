import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { seedCoworkWorkspace, seedWorktreeChat } from './index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'scroll-button-chat';

export function seedScrollButtonChat(
  userDataDir,
  { seedRepos = true, standalone = false } = {},
) {
  if (standalone)
    seedCoworkWorkspace({
      userDataDir,
      workspaceId: 'scroll-button-cowork',
      chatId: CHAT_ID,
      chatTitle: 'Scroll button',
      seedMessage: false,
      mergeIndex: true,
    });
  else if (seedRepos)
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const start = Date.parse('2026-10-01T10:00:00.000Z');
  const messages = [];
  for (let index = 0; index < 30; index += 1) {
    messages.push(
      {
        id: `scroll-user-${index}`,
        role: 'user',
        blocks: [{ type: 'text', text: `Question ${index}` }],
        timestamp: start + index * 10_000,
      },
      {
        id: `scroll-assistant-${index}`,
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: `Answer ${index}. ${'A long answer line. '.repeat(20)}`,
          },
        ],
        timestamp: start + index * 10_000 + 5_000,
      },
    );
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: standalone ? 'scroll-button-cowork' : WORKSPACE_ID,
    worktreeId: standalone ? 'home' : WORKTREE_ID,
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Scroll button', messages }],
  });
}
