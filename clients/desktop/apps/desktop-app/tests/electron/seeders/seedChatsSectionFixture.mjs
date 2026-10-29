import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

export const CHATS_SECTION_CODE_WORKSPACE_ID = 'chats-section-code';
export const CHATS_SECTION_NAMED_COWORK_ID = 'cowork-research';
export const CHATS_SECTION_DEFAULT_COWORK_ID = 'cowork-default';
export const CHATS_SECTION_NAMED_COWORK_ENTRY_ID = 'entry-research-plan';

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buildMessage(id, role, text, timestamp) {
  return { id, role, blocks: [{ type: 'text', text }], timestamp };
}

function writeWorkEntryChat(workspaceDir, entryId, chatId, label, createdAt) {
  writeJson(path.join(workspaceDir, 'chats', `${entryId}.json`), {
    version: 1,
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: label,
        description: label,
        createdAt,
        kind: 'chat',
        messages: [
          buildMessage(
            `${chatId}-user-1`,
            'user',
            `Start on ${label.toLowerCase()}.`,
            Date.parse(createdAt),
          ),
          buildMessage(
            `${chatId}-assistant-1`,
            'assistant',
            `${label} is ready for review.`,
            Date.parse(createdAt) + 60_000,
          ),
        ],
      },
    ],
  });
}

/**
 * Seed the deterministic sidebar state for the CAN-2363 Chats section:
 *
 * - one real single-repo code workspace whose worktree list is long enough to
 *   push everything after it below the fold of a compact viewport;
 * - one named Cowork workspace (stays a workspace row in the Projects list);
 * - the auto-created default Cowork workspace (`cowork-default`) with several
 *   Work Entries whose chats carry messages, so `lastMessageAt` is derived
 *   and the rows sort most-recent-first.
 *
 * The git repository and its worktrees are created locally; no network,
 * agent, or provider process is involved.
 *
 * @param {string} userDataDir test-scoped CANOPY_DATA_DIR
 * @param {object} [options]
 * @param {number} [options.worktreeCount] worktrees in the code workspace
 * @param {number} [options.chatEntryCount] Work Entries in `cowork-default`
 * @returns {{ worktreeIds: string[], chatEntryIds: string[] }}
 */
export function seedChatsSectionFixture(
  userDataDir,
  { worktreeCount = 12, chatEntryCount = 10 } = {},
) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');

  // Code workspace: real repository plus `worktreeCount` linked worktrees.
  const repoPath = path.join(userDataDir, 'chats-section-repo');
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '--initial-branch=main']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Canopy Test']);
  writeFileSync(path.join(repoPath, 'README.md'), 'chats section\n', 'utf8');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-m', 'initial']);

  const codeWorkspaceDir = path.join(
    workspacesRoot,
    CHATS_SECTION_CODE_WORKSPACE_ID,
  );
  const worktreeIds = Array.from(
    { length: worktreeCount },
    (_, index) => `feature-${String(index + 1).padStart(2, '0')}`,
  );
  for (const worktreeId of worktreeIds) {
    git(repoPath, [
      'worktree',
      'add',
      '-b',
      worktreeId,
      path.join(codeWorkspaceDir, 'worktrees', worktreeId),
    ]);
  }
  writeJson(path.join(codeWorkspaceDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath,
    repos: [],
    alwaysShow: true,
  });
  writeJson(path.join(codeWorkspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: worktreeIds.map((id, index) => ({
      id,
      branchName: id,
      createdAt: `2026-07-01T09:${String(index).padStart(2, '0')}:00.000Z`,
    })),
  });

  // Named Cowork workspace: a regular row in the Projects list.
  const namedCoworkDir = path.join(
    workspacesRoot,
    CHATS_SECTION_NAMED_COWORK_ID,
  );
  writeJson(path.join(namedCoworkDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: {
      createdAt: '2026-07-02T10:00:00.000Z',
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(namedCoworkDir, 'work-entries.json'), {
    version: 1,
    entries: [
      {
        id: CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
        createdAt: '2026-07-02T10:00:00.000Z',
      },
    ],
  });
  writeWorkEntryChat(
    namedCoworkDir,
    CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
    'chat-research-plan',
    'Research plan',
    '2026-07-02T10:05:00.000Z',
  );

  // Default Cowork workspace: the Chats section source.
  const defaultCoworkDir = path.join(
    workspacesRoot,
    CHATS_SECTION_DEFAULT_COWORK_ID,
  );
  writeJson(path.join(defaultCoworkDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: {
      createdAt: '2026-07-01T10:00:00.000Z',
      archiveRetentionDays: null,
    },
    alwaysShow: true,
  });
  // One hour apart from a fixed origin, via epoch arithmetic.
  //
  // These used to be built as `2026-07-03T${10 + index}:00:00.000Z`, which
  // runs off the end of the clock: index 15 yields hour 25 and an Invalid
  // Date. Entries past that point were silently dropped, so every fixture
  // asking for a long chat list quietly got ~15 rows — a caller could request
  // 200 and get the same sidebar as one requesting 60.
  const entryTimestamp = (index, minute) =>
    new Date(
      Date.UTC(2026, 6, 3, 10, minute, 0) + index * 60 * 60 * 1000,
    ).toISOString();
  const chatEntryIds = Array.from(
    { length: chatEntryCount },
    (_, index) => `entry-chat-${String(index + 1).padStart(3, '0')}`,
  );
  writeJson(path.join(defaultCoworkDir, 'work-entries.json'), {
    version: 1,
    entries: chatEntryIds.map((id, index) => ({
      id,
      createdAt: entryTimestamp(index, 0),
    })),
  });
  chatEntryIds.forEach((entryId, index) => {
    writeWorkEntryChat(
      defaultCoworkDir,
      entryId,
      `chat-${entryId}`,
      `Chat topic ${index + 1}`,
      entryTimestamp(index, 5),
    );
  });

  writeJson(path.join(workspacesRoot, 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: CHATS_SECTION_CODE_WORKSPACE_ID,
        name: 'Chats Section Code',
        type: 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order: 0,
      },
      {
        id: CHATS_SECTION_NAMED_COWORK_ID,
        name: 'Research',
        type: 'cowork',
        color: '#467A64',
        collapsed: true,
        order: 1,
      },
      {
        id: CHATS_SECTION_DEFAULT_COWORK_ID,
        name: 'Personal',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 2,
        cowork: {
          createdAt: '2026-07-01T10:00:00.000Z',
          archiveRetentionDays: null,
        },
      },
    ],
  });

  return { worktreeIds, chatEntryIds };
}
