import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';
import { mergeSeedPreferences } from './mergePreferences.mjs';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';

export const ATTENTION_WORKSPACE = 'demo-ts-pnpm-vite';
export const ATTENTION_AWAY = 'attention-away';

/** Start elsewhere so the target's unread state survives until its row click. */
export function seedAttentionAwayWorktree(userDataDir) {
  const directory = path.join(userDataDir, 'workspaces', ATTENTION_WORKSPACE);
  execFileSync(
    'git',
    [
      '-C',
      path.join(directory, 'worktrees', 'demo-main'),
      'worktree',
      'add',
      '-b',
      ATTENTION_AWAY,
      path.join(directory, 'worktrees', ATTENTION_AWAY),
      'HEAD',
    ],
    { stdio: 'pipe' },
  );
  const file = path.join(directory, 'worktrees.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  writeJson(file, {
    ...data,
    worktrees: [
      ...data.worktrees,
      {
        id: ATTENTION_AWAY,
        branchName: ATTENTION_AWAY,
        createdAt: '2026-09-01T00:00:00.000Z',
        trackedBaseBranch: 'main',
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: ATTENTION_WORKSPACE,
    worktreeId: ATTENTION_AWAY,
    tabs: [
      {
        id: 'away-chat',
        title: 'Other work',
        blocks: [{ type: 'text', text: 'Start here.' }],
      },
    ],
  });
  mergeSeedPreferences(userDataDir, {
    lastSelectedWorktreeProjectId: ATTENTION_WORKSPACE,
    lastSelectedWorktreeId: ATTENTION_AWAY,
    lastActiveContext: {
      kind: 'worktree',
      workspaceId: ATTENTION_WORKSPACE,
      worktreeId: ATTENTION_AWAY,
    },
  });
}

/** A restored multi-group layout whose focused group contains an old chat. */
export function seedAttentionPanelLayout(
  userDataDir,
  targetChatId,
  otherChatIds,
) {
  const directory = path.join(
    userDataDir,
    'workspaces',
    ATTENTION_WORKSPACE,
    'worktree-data',
    'demo-main',
  );
  const panel = (chatId) => ({
    panelId: `panel-chat-${chatId}`,
    kind: 'chat',
    title: chatId,
    instance: { chatTabId: chatId },
  });
  writeJson(path.join(directory, 'panel-layout-mode.json'), {
    version: 1,
    mode: 'advanced',
  });
  writeJson(path.join(directory, 'panel-layout.json'), {
    version: 1,
    grid: {
      orientation: 0,
      width: 1200,
      height: 800,
      root: {
        type: 'branch',
        size: 1200,
        children: [
          {
            type: 'leaf',
            groupId: 'old-chat-group',
            size: 600,
            panels: otherChatIds.map(panel),
            activePanelId: `panel-chat-${otherChatIds[0]}`,
          },
          {
            type: 'leaf',
            groupId: 'attention-chat-group',
            size: 600,
            panels: [panel(targetChatId)],
            activePanelId: `panel-chat-${targetChatId}`,
          },
        ],
      },
    },
    activeGroupId: 'old-chat-group',
    mostRecentActiveGroupIds: ['old-chat-group', 'attention-chat-group'],
  });
}
