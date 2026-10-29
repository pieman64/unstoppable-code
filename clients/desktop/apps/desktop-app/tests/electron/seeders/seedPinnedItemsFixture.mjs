import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';
import {
  CHATS_SECTION_CODE_WORKSPACE_ID,
  CHATS_SECTION_DEFAULT_COWORK_ID,
  CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
  CHATS_SECTION_NAMED_COWORK_ID,
  seedChatsSectionFixture,
} from './seedChatsSectionFixture.mjs';

export const PINNED_ITEMS_PINNED_WORKTREE_ID = 'feature-02';
export const PINNED_ITEMS_PINNED_CHAT_ENTRY_ID = 'entry-chat-003';
export const PINNED_ITEMS_ADVISOR_ENTRY_IDS = [
  'advisor-entry-1',
  'advisor-entry-2',
  'advisor-entry-3',
];
export const PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID = 'advisor-entry-3';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeAdvisorEntryChat(workspaceDir, entryId, title, createdAt) {
  const chatId = `chat-${entryId}`;
  writeJson(path.join(workspaceDir, 'chats', `${entryId}.json`), {
    version: 1,
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title,
        description: title,
        createdAt,
        kind: 'chat',
        messages: [
          {
            id: `${chatId}-user-1`,
            role: 'user',
            blocks: [{ type: 'text', text: `${title}?` }],
            timestamp: Date.parse(createdAt),
          },
        ],
      },
    ],
  });
}

/**
 * Seed one pin at every sidebar tier on top of the CAN-2363 Chats-section
 * fixture, plus App Advisor Work Entries:
 *
 * - the code workspace is a pinned project (`index.json` `pinned: true`);
 * - one of its worktrees is pinned (`worktrees.json` `pinned: true`);
 * - the named Cowork workspace stays unpinned and expanded, and its one Work
 *   Entry is pinned, so a pinned row shows inside an unpinned project;
 * - one Chats-section Work Entry (the default Cowork workspace) is pinned;
 * - App Advisor gets three Work Entries with chats; the last one is pinned
 *   (`app-workspaces/app-advisor/work-entries.json` `pinned: true`).
 *
 * Every pin is written in the same shape the main process persists, so the
 * fixture exercises the real readers. No network, agent, or provider process.
 *
 * @param {string} userDataDir test-scoped CANOPY_DATA_DIR
 * @param {object} [options]
 * @param {boolean} [options.pinAdvisorEntry] seed the App Advisor pin
 */
export function seedPinnedItemsFixture(
  userDataDir,
  { pinAdvisorEntry = true } = {},
) {
  const seeded = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 4,
    chatEntryCount: 5,
  });
  const workspacesRoot = path.join(userDataDir, 'workspaces');

  const indexPath = path.join(workspacesRoot, 'index.json');
  const index = readJson(indexPath);
  writeJson(indexPath, {
    ...index,
    workspaces: index.workspaces.map((workspace) => {
      if (workspace.id === CHATS_SECTION_CODE_WORKSPACE_ID) {
        return { ...workspace, pinned: true };
      }
      if (workspace.id === CHATS_SECTION_NAMED_COWORK_ID) {
        return { ...workspace, collapsed: false };
      }
      return workspace;
    }),
  });

  const worktreesPath = path.join(
    workspacesRoot,
    CHATS_SECTION_CODE_WORKSPACE_ID,
    'worktrees.json',
  );
  const worktrees = readJson(worktreesPath);
  writeJson(worktreesPath, {
    ...worktrees,
    worktrees: worktrees.worktrees.map((worktree) =>
      worktree.id === PINNED_ITEMS_PINNED_WORKTREE_ID
        ? { ...worktree, pinned: true }
        : worktree,
    ),
  });

  const pinEntry = (workspaceId, entryId) => {
    const entriesPath = path.join(
      workspacesRoot,
      workspaceId,
      'work-entries.json',
    );
    const entries = readJson(entriesPath);
    writeJson(entriesPath, {
      ...entries,
      entries: entries.entries.map((entry) =>
        entry.id === entryId ? { ...entry, pinned: true } : entry,
      ),
    });
  };
  pinEntry(CHATS_SECTION_NAMED_COWORK_ID, CHATS_SECTION_NAMED_COWORK_ENTRY_ID);
  pinEntry(CHATS_SECTION_DEFAULT_COWORK_ID, PINNED_ITEMS_PINNED_CHAT_ENTRY_ID);

  const advisorDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  const advisorTitles = [
    'Set up Slack alerts',
    'Why is sync slow',
    'Slide theme',
  ];
  const advisorCreatedAt = (index) =>
    new Date(Date.UTC(2026, 6, 4, 9, 0, 0) + index * 60_000).toISOString();
  writeJson(path.join(advisorDir, 'work-entries.json'), {
    version: 1,
    entries: PINNED_ITEMS_ADVISOR_ENTRY_IDS.map((id, index) => ({
      id,
      createdAt: advisorCreatedAt(index),
      ...(pinAdvisorEntry && id === PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID
        ? { pinned: true }
        : {}),
    })),
  });
  PINNED_ITEMS_ADVISOR_ENTRY_IDS.forEach((id, index) => {
    writeAdvisorEntryChat(
      advisorDir,
      id,
      advisorTitles[index],
      advisorCreatedAt(index),
    );
  });

  return seeded;
}
