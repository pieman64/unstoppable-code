/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import type * as ChatTabsReader from '../lib/chat-tabs-reader';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// This suite exercises real Git snapshots with fixture-owned commands.
jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
}));

jest.unmock('../lib/git-tree-snapshot');
jest.unmock('../lib/git');

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
  resolveChatTabsFilePath: jest.fn(),
}));

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    getCompatibilityTabs: async (scope: {
      projectId: string;
      worktreeId: string;
    }) => {
      // Git reset fixtures use legacy snapshot I/O; never recurse through the
      // canonical reader back into this mocked service.
      const { readFile } = jest.requireActual('node:fs/promises');
      const { resolveChatTabsFilePath } = jest.requireMock(
        '../lib/resolve-worktree',
      );
      const contents: string = await readFile(
        resolveChatTabsFilePath(scope.projectId, scope.worktreeId),
        'utf8',
      );
      const file = JSON.parse(contents);
      const { isChatTabsFile } = jest.requireActual('../lib/chat-tabs-reader');
      if (!isChatTabsFile(file)) throw new Error('Invalid chat tabs fixture');
      return file;
    },
    updateCompatibilityTabs: async (
      scope: { projectId: string; worktreeId: string },
      update: (current: ChatTabsFile) => ChatTabsFile,
    ) => {
      const reader = jest.requireActual<typeof ChatTabsReader>(
        '../lib/chat-tabs-reader',
      );
      const writer = jest.requireActual('../lib/chat-tabs');
      const data = update(
        await reader.readChatTabsFileForIndex(
          scope.projectId,
          scope.worktreeId,
        ),
      );
      await writer.writeChatTabsSnapshotForTests(
        scope.projectId,
        scope.worktreeId,
        data,
      );
      return data;
    },
    replaceCompatibilityTabs: async (
      scope: { projectId: string; worktreeId: string },
      data: ChatTabsFile,
    ) => {
      const writer = jest.requireActual('../lib/chat-tabs');
      await writer.writeChatTabsSnapshotForTests(
        scope.projectId,
        scope.worktreeId,
        data,
      );
      return data;
    },
  }),
}));

jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(),
  isCoworkWorkspace: jest.fn((id: string) => id === 'standalone-chat'),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

const attachmentsDirRef: { current: string } = { current: '' };
jest.mock('../lib/paths', () => ({
  getWorktreeAttachmentsDir: jest.fn(() => attachmentsDirRef.current),
}));

import { __testing, resetChatToPoint } from '../lib/chat-reset-to-point';
import {
  captureHeadCommitSha,
  captureWorkingTreeSha,
} from '../lib/git-tree-snapshot';
import {
  resolveWorktreeCwd,
  resolveChatTabsFilePath,
} from '../lib/resolve-worktree';
import { isMultiRepoWorkspace } from '../lib/workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import type {
  ChatTabsFile,
  PersistedChatTab,
  TurnDiffTreeRef,
} from '@canopy/desktop-shared/types';

const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedResolveChatTabsFilePath = jest.mocked(resolveChatTabsFilePath);
const mockedIsMultiRepoWorkspace = jest.mocked(isMultiRepoWorkspace);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);

function runGit(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
  }).trim();
}

function createRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'canopy-reset-'));
  runGit(repoPath, ['init']);
  runGit(repoPath, ['config', 'user.name', 'Canopy Test']);
  runGit(repoPath, ['config', 'user.email', 'canopy@example.com']);
  runGit(repoPath, ['config', 'commit.gpgsign', 'false']);
  return repoPath;
}

function makeUserMessage(
  id: string,
  text: string,
): PersistedChatTab['messages'][number] {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1700000000000,
  };
}

function makeAssistantMessage(
  id: string,
  toolUseId: string,
): PersistedChatTab['messages'][number] {
  return {
    id,
    role: 'assistant',
    blocks: [
      {
        type: 'tool_use',
        toolUseId,
        toolName: 'Edit',
        input: '{}',
      },
    ],
    timestamp: 1700000001000,
  };
}

async function writeChatFile(
  filePath: string,
  file: ChatTabsFile,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf8');
}

describe('resetChatToPoint', () => {
  let repoPath = '';
  let chatTabsPath = '';
  let attachmentsDir = '';

  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsMultiRepoWorkspace.mockReturnValue(false);
    attachmentsDir = mkdtempSync(join(tmpdir(), 'canopy-attach-'));
    attachmentsDirRef.current = attachmentsDir;
  });

  afterEach(() => {
    if (repoPath) {
      rmSync(repoPath, { recursive: true, force: true });
      repoPath = '';
    }
    if (chatTabsPath) {
      rmSync(dirname(chatTabsPath), { recursive: true, force: true });
      chatTabsPath = '';
    }
    if (attachmentsDir) {
      rmSync(attachmentsDir, { recursive: true, force: true });
      attachmentsDir = '';
    }
  });

  it('appends a revert_info marker, restores git state, and stages a synthetic attachment without truncating', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'a.txt'), 'one\n', 'utf8');
    runGit(repoPath, ['add', 'a.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);

    const startHead = await captureHeadCommitSha(repoPath);
    const startTree = await captureWorkingTreeSha(repoPath);

    // Agent commits a "bad" change after the snapshot.
    writeFileSync(join(repoPath, 'a.txt'), 'one\nbad\n', 'utf8');
    writeFileSync(join(repoPath, 'b.txt'), 'created\n', 'utf8');
    runGit(repoPath, ['add', '-A']);
    runGit(repoPath, ['commit', '-m', 'agent-made']);
    const endTree = await captureWorkingTreeSha(repoPath);

    chatTabsPath = join(
      mkdtempSync(join(tmpdir(), 'canopy-chats-')),
      'chats.json',
    );
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);
    mockedResolveChatTabsFilePath.mockReturnValue(chatTabsPath);

    const treeRef: TurnDiffTreeRef = {
      startTree,
      endTree,
      startHeadCommitSha: startHead,
    };

    const tab: PersistedChatTab = {
      id: 'chat-1',
      title: 'Test chat',
      createdAt: '2026-04-29T00:00:00.000Z',
      messages: [
        makeUserMessage('user-1', 'do thing 1'),
        makeAssistantMessage('asst-1', 'tool-1'),
        makeUserMessage('user-2', 'do thing 2'),
        {
          id: 'asst-2',
          role: 'assistant',
          timestamp: 1700000002000,
          blocks: [
            {
              type: 'text',
              text: 'Which scope?',
              asyncQuestion: {
                requestId: 'async-reset',
                questions: [{ title: 'Which scope?', options: ['Full'] }],
              },
            },
          ],
        },
      ],
      sdkSessionId: 'session-abc',
      turnDiffs: {
        'user-2': {
          files: [],
          totalInsertions: 0,
          totalDeletions: 0,
          capturedAt: 2,
          treeRefs: [treeRef],
        },
      },
    };

    await writeChatFile(chatTabsPath, {
      version: 1,
      tabs: [tab],
      activeTabId: 'chat-1',
      pendingQuestions: [
        {
          requestId: 'async-reset',
          chatId: 'chat-1',
          delivery: 'async',
          questions: [{ id: '0', question: 'Which scope?', options: ['Full'] }],
        },
      ],
    });

    const resetTab = await resetChatToPoint({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      userMessageId: 'user-2',
    });

    // Working tree restored; agent commit rolled back.
    expect(runGit(repoPath, ['rev-parse', 'HEAD'])).toBe(startHead);
    expect(readFileSync(join(repoPath, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(repoPath, 'b.txt'))).toBe(false);

    // Transcript NOT truncated: original four messages survive, plus a new
    // revert_info system message appended at the end.
    expect(resetTab.messages).toHaveLength(5);
    expect(resetTab.messages.slice(0, 4).map((m) => m.id)).toEqual([
      'user-1',
      'asst-1',
      'user-2',
      'asst-2',
    ]);
    const marker = resetTab.messages[4];
    expect(marker.role).toBe('system');
    expect(marker.blocks[0].type).toBe('revert_info');
    if (marker.blocks[0].type === 'revert_info') {
      expect(marker.blocks[0].revertedFromMessageId).toBe('user-2');
      expect(marker.blocks[0].files.length).toBeGreaterThan(0);
      expect(marker.blocks[0].attachmentPath).toBeTruthy();
    }

    // SDK session is NOT cleared (the conversation rolls forward).
    expect(resetTab.sdkSessionId).toBe('session-abc');

    // Synthetic attachment file written and tab pointer set.
    expect(resetTab.pendingRevertAttachmentPath).toBeTruthy();
    expect(existsSync(resetTab.pendingRevertAttachmentPath ?? '')).toBe(true);
    const attachmentBody = readFileSync(
      resetTab.pendingRevertAttachmentPath ?? '',
      'utf8',
    );
    expect(attachmentBody).toContain('Reverted turn');
    expect(attachmentBody).toContain('do thing 2');

    // File on disk reflects the new persisted state.
    const written = await readChatTabsFile('proj', 'wt');
    expect(written.tabs[0].messages).toHaveLength(5);
    expect(written.tabs[0].pendingRevertAttachmentPath).toBe(
      resetTab.pendingRevertAttachmentPath,
    );
    expect(written.pendingQuestions).toEqual([]);
  });

  it('rejects when the user message has no captured snapshot (no side effects)', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'a.txt'), 'one\n', 'utf8');
    runGit(repoPath, ['add', 'a.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);

    chatTabsPath = join(
      mkdtempSync(join(tmpdir(), 'canopy-chats-')),
      'chats.json',
    );
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);
    mockedResolveChatTabsFilePath.mockReturnValue(chatTabsPath);

    const tab: PersistedChatTab = {
      id: 'chat-1',
      title: 'Test',
      createdAt: '2026-04-29T00:00:00.000Z',
      messages: [makeUserMessage('user-1', 'no snapshot')],
    };

    await writeChatFile(chatTabsPath, {
      version: 1,
      tabs: [tab],
      activeTabId: 'chat-1',
    });

    await expect(
      resetChatToPoint({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        userMessageId: 'user-1',
      }),
    ).rejects.toThrow(/No snapshot available/);
  });

  it('rejects standalone chats outright', async () => {
    await expect(
      resetChatToPoint({
        projectId: 'standalone-chat',
        worktreeId: 'project-a',
        chatId: 'chat-1',
        userMessageId: 'user-1',
      }),
    ).rejects.toThrow(/worktree chats/);
  });

  it('restores every repo in a multi-repo project', async () => {
    const alphaPath = createRepo();
    const bravoPath = createRepo();
    try {
      writeFileSync(join(alphaPath, 'a.txt'), 'alpha-good\n', 'utf8');
      runGit(alphaPath, ['add', 'a.txt']);
      runGit(alphaPath, ['commit', '-m', 'alpha initial']);
      const alphaHead = await captureHeadCommitSha(alphaPath);
      const alphaTree = await captureWorkingTreeSha(alphaPath);

      writeFileSync(join(alphaPath, 'a.txt'), 'alpha-bad\n', 'utf8');
      runGit(alphaPath, ['add', 'a.txt']);
      runGit(alphaPath, ['commit', '-m', 'alpha agent commit']);

      writeFileSync(join(bravoPath, 'b.txt'), 'bravo-base\n', 'utf8');
      runGit(bravoPath, ['add', 'b.txt']);
      runGit(bravoPath, ['commit', '-m', 'bravo initial']);
      const bravoHead = await captureHeadCommitSha(bravoPath);
      writeFileSync(join(bravoPath, 'b.txt'), 'bravo-staged\n', 'utf8');
      const bravoTree = await captureWorkingTreeSha(bravoPath);

      writeFileSync(join(bravoPath, 'b.txt'), 'bravo-bad\n', 'utf8');

      chatTabsPath = join(
        mkdtempSync(join(tmpdir(), 'canopy-chats-')),
        'chats.json',
      );

      mockedIsMultiRepoWorkspace.mockReturnValue(true);
      mockedResolveWorktreeCwd.mockReturnValue('/workspace');
      mockedResolveChatTabsFilePath.mockReturnValue(chatTabsPath);
      mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
        { repoId: 'alpha', repoName: 'Alpha', repoPath: alphaPath },
        { repoId: 'bravo', repoName: 'Bravo', repoPath: bravoPath },
      ]);

      const tab: PersistedChatTab = {
        id: 'chat-1',
        title: 'Multi-repo chat',
        createdAt: '2026-04-29T00:00:00.000Z',
        messages: [
          makeUserMessage('user-1', 'do thing'),
          makeAssistantMessage('asst-1', 'tool-1'),
        ],
        sdkSessionId: 'session-multi',
        turnDiffs: {
          'user-1': {
            files: [],
            totalInsertions: 0,
            totalDeletions: 0,
            capturedAt: 1,
            treeRefs: [
              {
                startTree: alphaTree,
                endTree: alphaTree,
                repoId: 'alpha',
                startHeadCommitSha: alphaHead,
              },
              {
                startTree: bravoTree,
                endTree: bravoTree,
                repoId: 'bravo',
                startHeadCommitSha: bravoHead,
              },
            ],
          },
        },
      };

      await writeChatFile(chatTabsPath, {
        version: 1,
        tabs: [tab],
        activeTabId: 'chat-1',
      });

      const resetTab = await resetChatToPoint({
        projectId: 'workspace',
        worktreeId: 'wt',
        chatId: 'chat-1',
        userMessageId: 'user-1',
      });

      expect(runGit(alphaPath, ['rev-parse', 'HEAD'])).toBe(alphaHead);
      expect(readFileSync(join(alphaPath, 'a.txt'), 'utf8')).toBe(
        'alpha-good\n',
      );
      expect(runGit(bravoPath, ['rev-parse', 'HEAD'])).toBe(bravoHead);
      expect(readFileSync(join(bravoPath, 'b.txt'), 'utf8')).toBe(
        'bravo-staged\n',
      );

      // Transcript preserved + revert_info appended.
      expect(resetTab.messages).toHaveLength(3);
      expect(resetTab.messages[2].blocks[0].type).toBe('revert_info');
      expect(resetTab.pendingRevertAttachmentPath).toBeTruthy();
      const attachmentBody = readFileSync(
        resetTab.pendingRevertAttachmentPath ?? '',
        'utf8',
      );
      expect(attachmentBody).toContain('`Alpha/a.txt`');
      expect(attachmentBody).toContain('`Bravo/b.txt`');
      // Session preserved.
      expect(resetTab.sdkSessionId).toBe('session-multi');
    } finally {
      rmSync(alphaPath, { recursive: true, force: true });
      rmSync(bravoPath, { recursive: true, force: true });
    }
  });

  it('rejects multi-repo projects missing a snapshot for any repo', async () => {
    repoPath = createRepo();
    writeFileSync(join(repoPath, 'a.txt'), 'one\n', 'utf8');
    runGit(repoPath, ['add', 'a.txt']);
    runGit(repoPath, ['commit', '-m', 'initial']);
    const startHead = await captureHeadCommitSha(repoPath);
    const startTree = await captureWorkingTreeSha(repoPath);

    chatTabsPath = join(
      mkdtempSync(join(tmpdir(), 'canopy-chats-')),
      'chats.json',
    );

    mockedIsMultiRepoWorkspace.mockReturnValue(true);
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);
    mockedResolveChatTabsFilePath.mockReturnValue(chatTabsPath);
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      { repoId: 'first', repoName: 'first', repoPath },
      { repoId: 'second', repoName: 'second', repoPath: '/nonexistent' },
    ]);

    const tab: PersistedChatTab = {
      id: 'chat-1',
      title: 'Test',
      createdAt: '2026-04-29T00:00:00.000Z',
      messages: [makeUserMessage('user-1', 'multi')],
      turnDiffs: {
        'user-1': {
          files: [],
          totalInsertions: 0,
          totalDeletions: 0,
          capturedAt: 1,
          treeRefs: [
            {
              startTree,
              endTree: startTree,
              repoId: 'first',
              startHeadCommitSha: startHead,
            },
            // Note: no snapshot for "second" repo.
          ],
        },
      },
    };

    await writeChatFile(chatTabsPath, {
      version: 1,
      tabs: [tab],
      activeTabId: 'chat-1',
    });

    await expect(
      resetChatToPoint({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        userMessageId: 'user-1',
      }),
    ).rejects.toThrow(/No snapshot available for repo/);
  });
});

describe('chat-reset-to-point internals', () => {
  it('summarizeFileLine renders status with repo prefix and rename arrow', () => {
    expect(
      __testing.summarizeFileLine({
        path: 'src/foo.ts',
        status: 'modified',
        insertions: 3,
        deletions: 1,
      }),
    ).toBe('- modified `src/foo.ts` (+3, -1)');

    expect(
      __testing.summarizeFileLine({
        path: 'src/new.ts',
        previousPath: 'src/old.ts',
        status: 'renamed',
        insertions: 0,
        deletions: 0,
        repoName: 'alpha',
      }),
    ).toBe('- renamed `alpha/src/old.ts → alpha/src/new.ts` (+0, -0)');
  });

  it('buildAttachmentMarkdown lists files and quotes the reverted user message', () => {
    const md = __testing.buildAttachmentMarkdown(
      {
        id: 'u1',
        role: 'user',
        timestamp: 1700000000000,
        blocks: [{ type: 'text', text: 'do the thing' }],
      },
      [
        {
          path: 'a.ts',
          status: 'modified',
          insertions: 1,
          deletions: 0,
        },
      ],
      1,
      0,
    );
    expect(md).toContain('# Reverted turn');
    expect(md).toContain('> do the thing');
    expect(md).toContain('Files rolled back:** 1');
    expect(md).toContain('- modified `a.ts` (+1, -0)');
  });

  it('buildAttachmentMarkdown handles empty file lists gracefully', () => {
    const md = __testing.buildAttachmentMarkdown(
      {
        id: 'u1',
        role: 'user',
        timestamp: 1700000000000,
        blocks: [{ type: 'text', text: 'just asking' }],
      },
      [],
      0,
      0,
    );
    expect(md).toContain('Files rolled back:** 0');
    expect(md).toContain('No tracked file changes');
  });
});
