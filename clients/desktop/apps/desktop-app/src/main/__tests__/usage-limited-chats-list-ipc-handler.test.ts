import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ChatActiveSessionInfo,
  type ChatTabsFile,
  type PersistedChatMessage,
  type UsageLimitedChatEntry,
  type UsageLimitedChatTarget,
  type WorkspaceIndexEntry,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/desktop-shared/types/pipeline';
import type * as UsageLimitedChatsRegistryModule from '../lib/usage-limited-chats-registry';
import type * as ExecutorModule from '@canopy/desktop-shared/node/pipelines/executor';

const mockListExecutionSummaries = jest.fn<
  Promise<ExecutionSummary[]>,
  [string]
>();
const mockLoadExecutionState = jest.fn<
  Promise<ExecutionState | null>,
  [string, string]
>();
jest.mock('@canopy/desktop-shared/node/pipelines/executor', () => {
  const actual = jest.requireActual<typeof ExecutorModule>(
    '@canopy/desktop-shared/node/pipelines/executor',
  );
  return {
    ...actual,
    get listExecutionSummaries(): typeof mockListExecutionSummaries {
      return mockListExecutionSummaries;
    },
    get loadExecutionState(): typeof mockLoadExecutionState {
      return mockLoadExecutionState;
    },
  };
});
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(() => ({
    executionsDir: '/executions',
  })),
}));
jest.mock('../pipelines/pipeline-execution-registry', () => ({
  hasActiveExecution: jest.fn(() => false),
}));

jest.mock('../lib/usage-limited-chats-registry', () => {
  const actual = jest.requireActual<typeof UsageLimitedChatsRegistryModule>(
    '../lib/usage-limited-chats-registry',
  );
  return {
    ...actual,
    readUsageLimitedChats: jest.fn(),
    clearUsageLimitedChat: jest.fn(),
  };
});
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  getAllActiveSessionInfos: jest.fn(),
}));
jest.mock('../lib/sidebar-items', () => ({
  readWorkspaceIndexEntry: jest.fn(),
}));
jest.mock('../lib/cowork-work-entries-file', () => ({
  readWorkEntriesFile: jest.fn(),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  resolveWorkEntryForChat: jest.fn(),
}));
jest.mock('../lib/code-review-registry', () => ({
  getCodeReviewTarget: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceWorktrees: jest.fn(),
}));

import {
  handleListUsageLimitedIdleChats,
  handleListUsageLimitedIdleSessions,
  resolveResumeQueueItems,
} from '../ipc/usage-limited-chats';
import {
  clearUsageLimitedChat,
  readUsageLimitedChats,
} from '../lib/usage-limited-chats-registry';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { getAllActiveSessionInfos } from '../agents/session-manager';
import { readWorkspaceIndexEntry } from '../lib/sidebar-items';
import { readWorkEntriesFile } from '../lib/cowork-work-entries-file';
import { resolveWorkEntryForChat } from '../lib/cowork-work-entries';
import { getCodeReviewTarget } from '../lib/code-review-registry';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import { getWorkspaceWorktreeDir } from '../lib/paths';

const mockedReadWorkEntriesFile = jest.mocked(readWorkEntriesFile);
const mockedResolveWorkEntryForChat = jest.mocked(resolveWorkEntryForChat);
const mockedGetCodeReviewTarget = jest.mocked(getCodeReviewTarget);
const mockedReadUsageLimitedChats = jest.mocked(readUsageLimitedChats);
const mockedClearUsageLimitedChat = jest.mocked(clearUsageLimitedChat);
const mockedReadChatTabsFile = jest.mocked(readChatTabsFile);
const mockedGetAllActiveSessionInfos = jest.mocked(getAllActiveSessionInfos);
const mockedReadWorkspaceIndexEntry = jest.mocked(readWorkspaceIndexEntry);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);

const entry = (
  over: Partial<UsageLimitedChatEntry> = {},
): UsageLimitedChatEntry => ({
  projectId: 'ws-a',
  worktreeId: 'wt-1',
  chatId: 'chat-1',
  provider: 'claude',
  detectedAt: 100,
  workspaceName: 'stale-name',
  chatTitle: 'stale-title',
  ...over,
});

const session = (
  over: Partial<ChatActiveSessionInfo> = {},
): ChatActiveSessionInfo => ({
  chatId: 'chat-1',
  projectId: 'ws-a',
  worktreeId: 'wt-1',
  providerType: 'claude',
  turnActive: false,
  createdAt: 0,
  lastActivityAt: 0,
  turnCount: 1,
  pendingMessageCount: 0,
  ...over,
});

const emptyTabsFile: ChatTabsFile = {
  version: 1,
  tabs: [],
  activeTabId: '',
};

function tabsFileWith(tabs: { id: string; title: string }[]): ChatTabsFile {
  return {
    version: 1,
    activeTabId: tabs[0]?.id ?? '',
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      messages: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
  };
}

describe('handleListUsageLimitedIdleChats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListExecutionSummaries.mockResolvedValue([]);

    mockedReadUsageLimitedChats.mockResolvedValue([
      // ws-a: idle (no session) -> included
      entry({
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'claude',
        detectedAt: 100,
        workspaceName: 'Workspace A (snapshot)',
        chatTitle: 'Old Title 1',
      }),
      // ws-a: active turn -> excluded
      entry({
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        chatId: 'chat-2',
        provider: 'claude',
        detectedAt: 200,
        workspaceName: 'Workspace A (snapshot)',
        chatTitle: 'Old Title 2',
      }),
      // ws-b: matching provider but tab is gone -> pruned
      entry({
        projectId: 'ws-b',
        worktreeId: 'wt-2',
        chatId: 'chat-3',
        provider: 'claude',
        detectedAt: 300,
        workspaceName: 'Workspace B (snapshot)',
        chatTitle: 'Old Title 3',
      }),
      // ws-b: other provider -> excluded by provider scoping
      entry({
        projectId: 'ws-b',
        worktreeId: 'wt-2',
        chatId: 'chat-4',
        provider: 'codex',
        detectedAt: 400,
        workspaceName: 'Workspace B (snapshot)',
        chatTitle: 'Old Title 4',
      }),
      // ws-c: idle (no session at all), live workspace
      entry({
        projectId: 'ws-c',
        worktreeId: 'wt-3',
        chatId: 'chat-5',
        provider: 'claude',
        detectedAt: 500,
        workspaceName: 'Workspace C (snapshot)',
        chatTitle: 'Old Title 5',
      }),
      // cowork-x: cowork workspace (home worktree) -> rendered flat, no branch
      entry({
        projectId: 'cowork-x',
        worktreeId: 'home',
        chatId: 'chat-6',
        provider: 'claude',
        detectedAt: 600,
        workspaceName: 'Cowork X (snapshot)',
        chatTitle: 'Old Title 6',
      }),
    ]);

    mockedGetAllActiveSessionInfos.mockReturnValue([
      session({
        chatId: 'chat-1',
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        turnActive: false,
      }),
      session({
        chatId: 'chat-2',
        projectId: 'ws-a',
        worktreeId: 'wt-1',
        turnActive: true,
      }),
    ]);

    mockedReadChatTabsFile.mockImplementation(
      (projectId: string, worktreeId: string): Promise<ChatTabsFile> => {
        if (projectId === 'ws-a' && worktreeId === 'wt-1') {
          return Promise.resolve(
            tabsFileWith([
              { id: 'chat-1', title: 'Fresh Title 1' },
              { id: 'chat-2', title: 'Fresh Title 2' },
            ]),
          );
        }
        if (projectId === 'ws-b' && worktreeId === 'wt-2') {
          // chat-3's tab no longer exists.
          return Promise.resolve(emptyTabsFile);
        }
        if (projectId === 'ws-c' && worktreeId === 'wt-3') {
          return Promise.resolve(
            tabsFileWith([{ id: 'chat-5', title: 'Fresh Title 5' }]),
          );
        }
        if (projectId === 'cowork-x' && worktreeId === 'home') {
          return Promise.resolve(
            tabsFileWith([{ id: 'chat-6', title: 'Fresh Title 6' }]),
          );
        }
        return Promise.resolve(emptyTabsFile);
      },
    );

    mockedReadWorkspaceIndexEntry.mockImplementation(
      (workspaceId: string): Promise<WorkspaceIndexEntry | null> => {
        if (workspaceId === 'ws-a') {
          return Promise.resolve({
            id: 'ws-a',
            name: 'Workspace A Real',
            type: 'multi-repo',
            color: 'blue',
            collapsed: false,
            order: 0,
          });
        }
        if (workspaceId === 'ws-b') {
          return Promise.resolve({
            id: 'ws-b',
            name: 'Workspace B Real',
            type: 'single-repo',
            color: 'green',
            collapsed: false,
            order: 1,
          });
        }
        if (workspaceId === 'cowork-x') {
          return Promise.resolve({
            id: 'cowork-x',
            name: 'Cowork X Real',
            type: 'cowork',
            color: 'purple',
            collapsed: false,
            order: 2,
          });
        }
        if (workspaceId === 'ws-c') {
          return Promise.resolve({
            id: 'ws-c',
            name: 'Workspace C Live',
            type: 'single-repo',
            color: 'blue',
            collapsed: false,
            order: 3,
          });
        }
        return Promise.resolve(null);
      },
    );

    mockedReadWorkspaceWorktrees.mockImplementation((workspaceId: string) => {
      if (workspaceId === 'ws-a') {
        return Promise.resolve([
          {
            id: 'wt-1',
            branchName: 'feat/a',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]);
      }
      return Promise.resolve([
        {
          id: workspaceId === 'ws-c' ? 'wt-3' : 'wt-2',
          branchName: '',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    });

    mockedReadWorkEntriesFile.mockResolvedValue({
      version: 1,
      entries: [{ id: 'chat-6', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: null,
    });
    mockedGetCodeReviewTarget.mockResolvedValue(null);
    mockedClearUsageLimitedChat.mockResolvedValue(undefined);
  });

  it('derives previews from a full chat-scoped read and refreshes them on each listing', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([entry()]);
    const messages: PersistedChatMessage[] = [
      {
        id: 'prompt',
        role: 'user',
        blocks: [{ type: 'text', text: 'Private prompt' }],
        timestamp: 1,
      },
      {
        id: 'step',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'edit',
            toolName: 'Edit',
            input: JSON.stringify({
              file_path: `${getWorkspaceWorktreeDir('ws-a', 'wt-1')}/src/client.ts`,
            }),
          },
        ],
        timestamp: 2,
      },
      ...Array.from(
        { length: 600 },
        (_, index): PersistedChatMessage => ({
          id: `timer-${index}`,
          role: 'system',
          blocks: [{ type: 'turn_timer', completedAt: 3 }],
          timestamp: 3,
        }),
      ),
      {
        id: 'result',
        role: 'system',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'edit',
            toolName: 'Edit',
            output: 'done',
            isError: false,
          },
        ],
        timestamp: 4,
      },
    ];
    mockedReadChatTabsFile.mockImplementation(
      (_project, _worktree, selection): Promise<ChatTabsFile> => {
        const file = tabsFileWith([{ id: 'chat-1', title: 'Fresh title' }]);
        if (selection?.fullTranscript && selection.chatIds?.includes('chat-1'))
          file.tabs[0].messages = messages;
        return Promise.resolve(file);
      },
    );
    const before = structuredClone(messages);
    const result = await handleListUsageLimitedIdleSessions({
      includeResumePreview: true,
    });
    expect(result[0].sessions[0]).toMatchObject({
      resumePromptKind: 'continue',
      lastStep: { toolName: 'Edit', detail: 'src/client.ts', finished: true },
    });
    expect(mockedReadChatTabsFile.mock.calls).toEqual([
      ['ws-a', 'wt-1'],
      ['ws-a', 'wt-1', { chatIds: ['chat-1'], fullTranscript: true }],
    ]);
    expect(messages).toEqual(before);
    expect(JSON.stringify(result)).not.toContain('Private prompt');
    expect(JSON.stringify(result)).not.toContain(
      getWorkspaceWorktreeDir('ws-a', 'wt-1'),
    );
    expect(mockedClearUsageLimitedChat).not.toHaveBeenCalled();
    messages.splice(1);
    const refreshed = await handleListUsageLimitedIdleChats({
      provider: 'claude',
      includeResumePreview: true,
    });
    expect(refreshed[0].chats[0]).toMatchObject({
      resumePromptKind: 'resend_user_message',
    });
    expect(refreshed[0].chats[0]).not.toHaveProperty('lastStep');
  });

  it('does not supply a worktree root for cowork chat previews', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      entry({ projectId: 'cowork-x', worktreeId: 'home', chatId: 'chat-6' }),
    ]);
    mockedReadChatTabsFile.mockImplementation(
      (_project, _worktree, selection): Promise<ChatTabsFile> => {
        const file = tabsFileWith([{ id: 'chat-6', title: 'Cowork' }]);
        if (selection?.fullTranscript)
          file.tabs[0].messages = [
            {
              id: 'prompt',
              role: 'user',
              blocks: [{ type: 'text', text: 'Fix it' }],
              timestamp: 1,
            },
            {
              id: 'step',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'read',
                  toolName: 'Read',
                  input: '{"path":"/private/workspace/src/file.ts"}',
                },
              ],
              timestamp: 2,
            },
          ];
        return Promise.resolve(file);
      },
    );
    const result = await handleListUsageLimitedIdleChats({
      provider: 'claude',
      includeResumePreview: true,
    });
    expect(result[0].chats[0]).toMatchObject({
      worktreeName: '',
      resumePromptKind: 'continue',
      lastStep: { toolName: 'Read', detail: 'file.ts' },
    });
  });

  it.each(['success', 'error', 'missing'] as const)(
    'serializes %s completion evidence only for preview listings',
    async (status) => {
      mockedReadUsageLimitedChats.mockResolvedValue([entry()]);
      const messages: PersistedChatMessage[] = [
        {
          id: 'prompt',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Fix it' }],
        },
        {
          id: 'step',
          role: 'assistant',
          timestamp: 2,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'edit',
              toolName: 'Edit',
              input: '{}',
            },
          ],
        },
      ];
      if (status !== 'missing')
        messages.push({
          id: 'result',
          role: 'system',
          timestamp: 3,
          blocks: [
            {
              type: 'tool_result',
              toolUseId: 'edit',
              toolName: 'Edit',
              output: 'done',
              isError: status === 'error',
            },
          ],
        });
      mockedReadChatTabsFile.mockImplementation(() => {
        const file = tabsFileWith([{ id: 'chat-1', title: 'Fresh title' }]);
        file.tabs[0].messages = messages;
        return Promise.resolve(file);
      });
      const expected =
        status === 'success'
          ? { toolName: 'Edit', finished: true }
          : { toolName: 'Edit' };
      const chats = await handleListUsageLimitedIdleChats({
        provider: 'claude',
        includeResumePreview: true,
      });
      expect(JSON.parse(JSON.stringify(chats))).toEqual([
        expect.objectContaining({
          chats: [expect.objectContaining({ lastStep: expected })],
        }),
      ]);
      const sessions = await handleListUsageLimitedIdleSessions({
        includeResumePreview: true,
      });
      expect(JSON.parse(JSON.stringify(sessions))).toEqual([
        expect.objectContaining({
          sessions: [expect.objectContaining({ lastStep: expected })],
        }),
      ]);
      mockedReadChatTabsFile.mockClear();
      const plainChats = await handleListUsageLimitedIdleChats({
        provider: 'claude',
      });
      const plainSessions = await handleListUsageLimitedIdleSessions({});
      expect(plainChats[0].chats[0]).not.toHaveProperty('lastStep');
      expect(plainSessions[0].sessions[0]).not.toHaveProperty('lastStep');
      expect(
        mockedReadChatTabsFile.mock.calls.every(
          ([, , selection]) => !selection?.fullTranscript,
        ),
      ).toBe(true);
    },
  );

  it.each(['missing', 'unreadable', 'empty', 'no-user'])(
    'keeps %s transcript previews unknown without dropping the listed chat',
    async (scenario) => {
      mockedReadUsageLimitedChats.mockResolvedValue([entry()]);
      mockedReadChatTabsFile.mockImplementation(
        (_project, _worktree, selection): Promise<ChatTabsFile> => {
          if (selection?.fullTranscript && scenario === 'unreadable')
            return Promise.reject(new Error('unreadable transcript'));
          if (selection?.fullTranscript && scenario === 'missing')
            return Promise.resolve(emptyTabsFile);
          const file = tabsFileWith([{ id: 'chat-1', title: 'Fresh title' }]);
          if (scenario === 'no-user')
            file.tabs[0].messages = [
              {
                id: 'assistant',
                role: 'assistant',
                blocks: [{ type: 'text', text: 'Hello' }],
                timestamp: 1,
              },
            ];
          return Promise.resolve(file);
        },
      );
      const result = await handleListUsageLimitedIdleChats({
        provider: 'claude',
        includeResumePreview: true,
      });
      expect(result[0].chats[0]).toMatchObject({
        chatId: 'chat-1',
        chatTitle: 'Fresh title',
      });
      expect(result[0].chats[0]).not.toHaveProperty('resumePromptKind');
      expect(result[0].chats[0]).not.toHaveProperty('lastStep');
      expect(mockedClearUsageLimitedChat).not.toHaveBeenCalled();
    },
  );

  it('scopes to the requested provider, filters active turns, prunes missing chats, refreshes titles, and sources project display data correctly', async () => {
    const result = await handleListUsageLimitedIdleChats({
      provider: 'claude',
    });

    // 5. Empty-group drop: ws-b's only claude-provider chat (chat-3) gets
    // pruned, leaving the group empty, so ws-b is absent entirely.
    expect(result.map((g) => g.workspaceId).sort()).toEqual([
      'cowork-x',
      'ws-a',
      'ws-c',
    ]);

    const wsA = result.find((g) => g.workspaceId === 'ws-a');
    if (!wsA) throw new Error('expected a ws-a group in the result');

    // 2. Idle filter: chat-2 (turnActive: true) is excluded; chat-1
    // (turnActive: false) is included.
    expect(wsA.chats.map((c) => c.chatId)).toEqual(['chat-1']);

    // 1. Provider scoping: chat-4 (codex) never appears anywhere in the
    // claude-scoped result.
    expect(result.some((g) => g.chats.some((c) => c.chatId === 'chat-4'))).toBe(
      false,
    );

    // 4. Title refresh: the result's chatTitle comes from the live tab,
    // not the stale registry snapshot.
    expect(wsA.chats[0].chatTitle).toBe('Fresh Title 1');
    expect(wsA.chats[0].chatTitle).not.toBe('Old Title 1');

    // 6. Workspace name/type come from the mocked index entry when present.
    expect(wsA.workspaceName).toBe('Workspace A Real');
    expect(wsA.workspaceType).toBe('multi-repo');
    // Workspace color forwarded from the index entry for the badge.
    expect(wsA.workspaceColor).toBe('blue');
    // Worktree name resolved from readWorkspaceWorktrees (branch name).
    expect(wsA.chats[0].worktreeName).toBe('feat/a');

    const wsC = result.find((g) => g.workspaceId === 'ws-c');
    if (!wsC) throw new Error('expected a ws-c group in the result');

    // 2. An entry with no session at all is treated as idle and included.
    expect(wsC.chats.map((c) => c.chatId)).toEqual(['chat-5']);

    // 6. Idle chats still use current workspace metadata.
    expect(wsC.workspaceName).toBe('Workspace C Live');
    expect(wsC.workspaceType).toBe('single-repo');
    // An explicitly empty branch label remains empty.
    expect(wsC.chats[0].worktreeName).toBe('');

    // Cowork workspace renders flat and reads its Work Entry registry.
    const coworkGroup = result.find((g) => g.workspaceId === 'cowork-x');
    if (!coworkGroup)
      throw new Error('expected a cowork-x group in the result');
    expect(coworkGroup.workspaceType).toBe('cowork');
    expect(coworkGroup.chats[0].worktreeName).toBe('');
    expect(mockedReadWorkspaceWorktrees).not.toHaveBeenCalledWith('cowork-x');

    // 3. Missing-chat prune: chat-3's tab was gone, so it was removed from
    // the registry as a side effect.
    const clearedTargets: UsageLimitedChatTarget[] =
      mockedClearUsageLimitedChat.mock.calls.map((call) => call[0]);
    expect(clearedTargets).toContainEqual(
      expect.objectContaining({
        projectId: 'ws-b',
        worktreeId: 'wt-2',
        chatId: 'chat-3',
      }),
    );
    expect(mockedClearUsageLimitedChat).toHaveBeenCalledTimes(1);
  });

  it.each(['deleted-workspace', 'removed-worktree', 'removed-work-entry'])(
    'excludes %s even when its chat tab survives',
    async (kind) => {
      mockedReadUsageLimitedChats.mockResolvedValue([entry()]);
      mockedGetAllActiveSessionInfos.mockReturnValue([]);
      mockedReadChatTabsFile.mockResolvedValue(
        tabsFileWith([{ id: 'chat-1', title: 'Retained chat' }]),
      );
      if (kind === 'deleted-workspace')
        mockedReadWorkspaceIndexEntry.mockResolvedValue(null);
      if (kind === 'removed-worktree')
        mockedReadWorkspaceWorktrees.mockResolvedValue([]);
      if (kind === 'removed-work-entry') {
        mockedReadWorkspaceIndexEntry.mockResolvedValue({
          id: 'ws-a',
          name: 'Cowork',
          type: 'cowork',
          color: 'purple',
          collapsed: false,
          order: 0,
        });
        mockedReadWorkEntriesFile.mockResolvedValue({
          version: 1,
          entries: [],
        });
      }
      expect(
        await handleListUsageLimitedIdleChats({ provider: 'claude' }),
      ).toEqual([]);
      expect(mockedReadChatTabsFile).not.toHaveBeenCalled();
      // Retained interruption records can become eligible after restoration.
      expect(mockedClearUsageLimitedChat).not.toHaveBeenCalled();
      mockedReadWorkspaceIndexEntry.mockResolvedValue({
        id: 'ws-a',
        name: 'Restored workspace',
        type: kind === 'removed-work-entry' ? 'cowork' : 'single-repo',
        color: 'blue',
        collapsed: false,
        order: 0,
      });
      mockedReadWorkspaceWorktrees.mockResolvedValue([
        {
          id: 'wt-1',
          branchName: 'main',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      mockedReadWorkEntriesFile.mockResolvedValue({
        version: 1,
        entries: [{ id: 'wt-1', createdAt: '2026-01-01T00:00:00.000Z' }],
      });
      expect(
        (await handleListUsageLimitedIdleChats({ provider: 'claude' })).flatMap(
          (group) => group.chats,
        ),
      ).toHaveLength(1);
    },
  );

  it('validates Code Review against its real worktree and keeps live review chats', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      entry({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'review-scope',
      }),
    ]);
    mockedGetAllActiveSessionInfos.mockReturnValue([]);
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFileWith([{ id: 'chat-1', title: 'Review' }]),
    );
    mockedGetCodeReviewTarget.mockResolvedValue({
      projectId: 'ws-a',
      worktreeId: 'wt-1',
    });
    expect(
      (
        await handleListUsageLimitedIdleSessions({ provider: 'claude' })
      ).flatMap((g) => g.sessions),
    ).toContainEqual(expect.objectContaining({ chatId: 'chat-1' }));
    mockedReadWorkspaceWorktrees.mockResolvedValue([]);
    expect(
      await handleListUsageLimitedIdleSessions({ provider: 'claude' }),
    ).toEqual([]);
    mockedGetCodeReviewTarget.mockResolvedValue(null);
    expect(
      await handleListUsageLimitedIdleSessions({ provider: 'claude' }),
    ).toEqual([]);
  });

  it('reads registry and scope metadata once, and each eligible transcript once across providers', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      entry({ chatId: 'chat-1', provider: 'claude' }),
      entry({ chatId: 'chat-2', provider: 'codex' }),
    ]);
    mockedGetAllActiveSessionInfos.mockReturnValue([]);

    const groups = await handleListUsageLimitedIdleSessions({
      includeResumePreview: true,
    });

    expect(
      groups
        .flatMap((group) => group.sessions)
        .map((item) => ('chatId' in item ? item.chatId : item.executionId))
        .sort(),
    ).toEqual(['chat-1', 'chat-2']);
    expect(mockedReadUsageLimitedChats).toHaveBeenCalledTimes(1);
    expect(mockedReadChatTabsFile.mock.calls).toEqual([
      ['ws-a', 'wt-1'],
      ['ws-a', 'wt-1', { chatIds: ['chat-1'], fullTranscript: true }],
      ['ws-a', 'wt-1', { chatIds: ['chat-2'], fullTranscript: true }],
    ]);
  });

  it('keeps count and dispatch listings metadata-only unless a preview is requested', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      entry({ chatId: 'chat-1', provider: 'claude' }),
      entry({ chatId: 'chat-2', provider: 'codex' }),
    ]);
    mockedGetAllActiveSessionInfos.mockReturnValue([]);

    const sessions = await handleListUsageLimitedIdleSessions({});
    const chats = await handleListUsageLimitedIdleChats({
      provider: 'claude',
    });
    const items = await resolveResumeQueueItems({
      targets: [
        {
          kind: 'chat',
          projectId: 'ws-a',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
        },
      ],
    });

    expect(sessions.flatMap((group) => group.sessions)).toHaveLength(2);
    expect(chats[0].chats).toHaveLength(1);
    expect(items).toHaveLength(1);
    for (const item of [
      ...sessions.flatMap((group) => group.sessions),
      ...chats[0].chats,
    ]) {
      expect(item).not.toHaveProperty('resumePromptKind');
      expect(item).not.toHaveProperty('lastStep');
    }
    expect(
      mockedReadChatTabsFile.mock.calls.filter((call) => call.length > 2),
    ).toEqual([]);
  });

  it('rejects a non-boolean preview flag', async () => {
    const includeResumePreview: unknown = 'yes';
    await expect(
      handleListUsageLimitedIdleSessions(
        // @ts-expect-error -- IPC payloads are untyped at the boundary.
        { includeResumePreview },
      ),
    ).rejects.toThrow('includeResumePreview must be a boolean');
    await expect(
      handleListUsageLimitedIdleChats({
        provider: 'claude',
        // @ts-expect-error -- IPC payloads are untyped at the boundary.
        includeResumePreview,
      }),
    ).rejects.toThrow('includeResumePreview must be a boolean');
  });

  it('offers a retained legacy standalone chat from its migrated owning entry', async () => {
    const legacy = entry({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'cowork-x',
    });
    mockedReadUsageLimitedChats.mockResolvedValue([legacy]);
    mockedGetAllActiveSessionInfos.mockReturnValue([]);
    mockedReadWorkEntriesFile.mockResolvedValue({
      version: 1,
      entries: [{ id: 'owning-entry', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: 'owning-entry',
      archivedInEntryId: null,
    });
    mockedReadChatTabsFile.mockImplementation((projectId, worktreeId) =>
      Promise.resolve(
        projectId === 'cowork-x' && worktreeId === 'owning-entry'
          ? tabsFileWith([{ id: 'chat-1', title: 'Migrated chat' }])
          : emptyTabsFile,
      ),
    );
    expect(
      (await handleListUsageLimitedIdleChats({ provider: 'claude' })).flatMap(
        (group) => group.chats,
      ),
    ).toEqual([
      expect.objectContaining({
        projectId: legacy.projectId,
        worktreeId: legacy.worktreeId,
        chatId: legacy.chatId,
        chatTitle: 'Migrated chat',
        worktreeName: '',
      }),
    ]);
    expect(mockedResolveWorkEntryForChat).toHaveBeenCalledWith(
      'cowork-x',
      'chat-1',
    );
    expect(mockedClearUsageLimitedChat).not.toHaveBeenCalled();
    mockedGetAllActiveSessionInfos.mockReturnValue([
      session({
        projectId: 'cowork-x',
        worktreeId: 'owning-entry',
        turnActive: true,
      }),
    ]);
    expect(
      await handleListUsageLimitedIdleChats({ provider: 'claude' }),
    ).toEqual([]);
  });

  it('retains an archived legacy standalone interruption without offering it', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      entry({ projectId: STANDALONE_CHAT_PROJECT_ID, worktreeId: 'cowork-x' }),
    ]);
    mockedGetAllActiveSessionInfos.mockReturnValue([]);
    mockedResolveWorkEntryForChat.mockResolvedValue({
      entryId: null,
      archivedInEntryId: 'chat-6',
    });
    expect(
      await handleListUsageLimitedIdleChats({ provider: 'claude' }),
    ).toEqual([]);
    expect(mockedClearUsageLimitedChat).not.toHaveBeenCalled();
  });

  it('prunes a missing legacy standalone chat after checking current ownership', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      entry({ projectId: STANDALONE_CHAT_PROJECT_ID, worktreeId: 'cowork-x' }),
    ]);
    mockedGetAllActiveSessionInfos.mockReturnValue([]);
    mockedReadWorkEntriesFile.mockResolvedValue({
      version: 1,
      entries: [{ id: 'chat-1', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    mockedReadChatTabsFile.mockResolvedValue(emptyTabsFile);
    expect(
      await handleListUsageLimitedIdleChats({ provider: 'claude' }),
    ).toEqual([]);
    expect(mockedReadChatTabsFile).toHaveBeenCalledWith('cowork-x', 'home');
    expect(mockedClearUsageLimitedChat).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' }),
    );
  });

  it('sorts groups by refreshed project name before returning', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      entry({
        projectId: 'ws-z',
        worktreeId: 'wt-z',
        chatId: 'chat-z',
        workspaceName: 'A Snapshot',
      }),
      entry({
        projectId: 'ws-a',
        worktreeId: 'wt-a',
        chatId: 'chat-a',
        workspaceName: 'Z Snapshot',
      }),
    ]);
    mockedGetAllActiveSessionInfos.mockReturnValue([]);
    mockedReadChatTabsFile.mockImplementation(
      (projectId: string): Promise<ChatTabsFile> => {
        if (projectId === 'ws-z') {
          return Promise.resolve(
            tabsFileWith([{ id: 'chat-z', title: 'Chat Z' }]),
          );
        }
        return Promise.resolve(
          tabsFileWith([{ id: 'chat-a', title: 'Chat A' }]),
        );
      },
    );
    mockedReadWorkspaceIndexEntry.mockImplementation(
      (workspaceId: string): Promise<WorkspaceIndexEntry | null> => {
        if (workspaceId === 'ws-z') {
          return Promise.resolve({
            id: 'ws-z',
            name: 'Z Live',
            type: 'single-repo',
            color: 'blue',
            collapsed: false,
            order: 0,
          });
        }
        return Promise.resolve({
          id: 'ws-a',
          name: 'A Live',
          type: 'single-repo',
          color: 'blue',
          collapsed: false,
          order: 1,
        });
      },
    );
    mockedReadWorkspaceWorktrees.mockImplementation((id) =>
      Promise.resolve([
        {
          id: id === 'ws-z' ? 'wt-z' : 'wt-a',
          branchName: 'main',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );

    const result = await handleListUsageLimitedIdleChats({
      provider: 'claude',
    });

    expect(result.map((group) => group.workspaceName)).toEqual([
      'A Live',
      'Z Live',
    ]);
  });
});

describe('handleListUsageLimitedIdleSessions pipeline eligibility', () => {
  const reasonId = '123e4567-e89b-42d3-a456-426614174000';

  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadUsageLimitedChats.mockResolvedValue([]);
    mockedGetAllActiveSessionInfos.mockReturnValue([]);
    mockListExecutionSummaries.mockResolvedValue([
      {
        id: 'claude-native',
        pipeline_id: 'pipeline',
        pipeline_name: 'Claude pipeline',
        status: 'paused',
        status_reasons: [],
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
      },
      {
        id: 'codex-native',
        pipeline_id: 'pipeline',
        pipeline_name: 'Codex pipeline',
        status: 'paused',
        status_reasons: [],
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
      },
      {
        id: 'claude-credits',
        pipeline_id: 'pipeline',
        pipeline_name: 'Credits pipeline',
        status: 'paused',
        status_reasons: [],
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
      },
      {
        id: 'hidden-child',
        pipeline_id: 'pipeline',
        pipeline_name: 'Hidden child',
        status: 'paused',
        status_reasons: [],
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
        hidden: true,
        parent_execution_id: 'claude-native',
      },
    ]);
    mockLoadExecutionState.mockImplementation((id) => {
      const provider = id === 'codex-native' ? 'codex' : 'claude';
      const accountScope = id === 'claude-credits' ? 'ai_credits' : 'native';
      return Promise.resolve({
        version: 6,
        id,
        pipeline_id: 'pipeline',
        pipeline_snapshot: {
          name: id === 'claude-native' ? 'Claude pipeline' : `${id} pipeline`,
          scope: ['directory'],
          jobs: {},
        },
        status: 'paused',
        status_reasons: [
          {
            id: reasonId,
            kind: 'provider_usage_limit',
            code: 'usage_limit_exceeded',
            provider,
            account_scope: accountScope,
            model: provider === 'claude' ? 'sonnet' : 'gpt',
            detected_at: '2026-01-01T00:00:00.000Z',
            source: {
              job_id: 'agent',
              step_id: 'prompt',
              attempt: 0,
              iteration: 1,
            },
          },
        ],
        jobs: {},
        job_definitions: {},
        job_groups: {},
        pending_pauses: [],
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
        env: {},
        inputs: {},
      });
    });
  });

  it('validates legacy standalone directory pipelines against their workspace only', async () => {
    const base = await mockLoadExecutionState('claude-native', '/executions');
    if (!base) throw new Error('Missing fixture');
    const state = {
      ...base,
      project_id: STANDALONE_CHAT_PROJECT_ID,
      worktree_id: 'cowork-x',
    };
    mockListExecutionSummaries.mockResolvedValue([
      { ...state, pipeline_name: 'Legacy' },
    ]);
    mockLoadExecutionState.mockResolvedValue(state);
    mockedReadWorkspaceIndexEntry.mockResolvedValue({
      id: 'cowork-x',
      name: 'Cowork',
      type: 'cowork',
      color: 'purple',
      collapsed: false,
      order: 0,
    });
    mockedReadWorkEntriesFile.mockResolvedValue({ version: 1, entries: [] });
    expect(
      (
        await handleListUsageLimitedIdleSessions({ provider: 'claude' })
      ).flatMap((group) => group.sessions),
    ).toEqual([
      expect.objectContaining({
        executionId: state.id,
        projectId: state.project_id,
      }),
    ]);
    expect(mockedResolveWorkEntryForChat).not.toHaveBeenCalled();
    mockedReadWorkspaceIndexEntry.mockResolvedValue(null);
    expect(
      await handleListUsageLimitedIdleSessions({ provider: 'claude' }),
    ).toEqual([]);
  });

  it.each(['deleted-workspace', 'removed-worktree', 'removed-work-entry'])(
    'excludes pipelines attached to %s and retains local pipelines',
    async (kind) => {
      const base = await mockLoadExecutionState('claude-native', '/executions');
      if (!base) throw new Error('Missing fixture');
      const scoped = {
        ...base,
        id: 'scoped',
        project_id: 'ws-a',
        worktree_id: 'wt-1',
      };
      mockListExecutionSummaries.mockResolvedValue([
        { ...base, pipeline_name: 'Local' },
        { ...scoped, pipeline_name: 'Scoped' },
      ]);
      mockLoadExecutionState.mockImplementation((id) =>
        Promise.resolve(id === 'scoped' ? scoped : base),
      );
      mockedReadWorkspaceIndexEntry.mockResolvedValue(
        kind === 'deleted-workspace'
          ? null
          : {
              id: 'ws-a',
              name: 'Workspace',
              type: kind === 'removed-work-entry' ? 'cowork' : 'single-repo',
              color: 'blue',
              collapsed: false,
              order: 0,
            },
      );
      mockedReadWorkspaceWorktrees.mockResolvedValue([]);
      mockedReadWorkEntriesFile.mockResolvedValue({ version: 1, entries: [] });
      const groups = await handleListUsageLimitedIdleSessions({
        provider: 'claude',
      });
      expect(
        groups
          .flatMap((g) => g.sessions)
          .map((s) => (s.kind === 'pipeline' ? s.executionId : s.chatId)),
      ).toEqual(['claude-native']);
      mockedReadWorkspaceWorktrees.mockResolvedValue([
        {
          id: 'wt-1',
          branchName: 'main',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      mockedReadWorkEntriesFile.mockResolvedValue({
        version: 1,
        entries: [{ id: 'wt-1', createdAt: '2026-01-01T00:00:00.000Z' }],
      });
      if (kind !== 'deleted-workspace') {
        expect(
          (
            await handleListUsageLimitedIdleSessions({ provider: 'claude' })
          ).flatMap((group) => group.sessions),
        ).toHaveLength(2);
      }
      scoped.worktree_id = '';
      if (kind !== 'deleted-workspace') {
        expect(
          (
            await handleListUsageLimitedIdleSessions({ provider: 'claude' })
          ).flatMap((g) => g.sessions),
        ).toHaveLength(2);
      }
    },
  );

  it('scopes sign-in recovery to this attempt and leaves unrelated paused work out', async () => {
    mockedReadUsageLimitedChats.mockResolvedValue([
      entry({
        provider: 'codex',
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: 'current',
      }),
      entry({
        chatId: 'other',
        provider: 'codex',
        resumeReason: 'provider_sign_in',
        authenticationAttemptId: 'older',
      }),
      entry({
        chatId: 'limited',
        provider: 'codex',
        resumeReason: 'usage_limit',
      }),
    ]);
    mockedReadChatTabsFile.mockResolvedValue(
      tabsFileWith([
        { id: 'chat-1', title: 'Current' },
        { id: 'other', title: 'Earlier' },
        { id: 'limited', title: 'Limited' },
      ]),
    );
    mockedReadWorkspaceIndexEntry.mockResolvedValue({
      id: 'ws-a',
      name: 'Workspace A',
      type: 'single-repo',
      color: 'blue',
      collapsed: false,
      order: 0,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      { id: 'wt-1', branchName: 'main', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const groups = await handleListUsageLimitedIdleSessions({
      authenticationAttemptId: 'current',
    });
    expect(groups.flatMap((group) => group.sessions)).toEqual([
      expect.objectContaining({
        kind: 'chat',
        chatId: 'chat-1',
        authenticationAttemptId: 'current',
      }),
    ]);
  });

  it.each([undefined, 'cursor'] as const)(
    'lists interrupted Cursor chats with provider filter %s',
    async (provider) => {
      mockedReadUsageLimitedChats.mockResolvedValue([
        entry({ provider: 'cursor', resumeReason: 'app_shutdown' }),
      ]);
      mockedReadChatTabsFile.mockResolvedValue(
        tabsFileWith([{ id: 'chat-1', title: 'Cursor interrupted' }]),
      );
      mockedReadWorkspaceIndexEntry.mockResolvedValue({
        id: 'ws-a',
        name: 'Workspace A',
        type: 'single-repo',
        color: 'blue',
        collapsed: false,
        order: 0,
      });
      mockedReadWorkspaceWorktrees.mockResolvedValue([
        {
          id: 'wt-1',
          branchName: 'main',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      mockListExecutionSummaries.mockResolvedValue([]);
      const groups = await handleListUsageLimitedIdleSessions({
        provider,
        resumeReason: 'app_shutdown',
      });
      expect(groups.flatMap((group) => group.sessions)).toContainEqual(
        expect.objectContaining({
          kind: 'chat',
          provider: 'cursor',
          chatTitle: 'Cursor interrupted',
        }),
      );
    },
  );

  it('lists shutdown checkpoints across billing sources and shell-only pipelines without consuming other blockers', async () => {
    const base = await mockLoadExecutionState('claude-credits', '/tmp');
    if (!base) throw new Error('Missing fixture');
    const shell = {
      ...base,
      id: 'shell',
      status_reasons: [
        {
          id: 'shutdown-shell',
          kind: 'app_shutdown' as const,
          code: 'app_shutdown' as const,
          detected_at: '2026-09-08T12:00:00Z',
          source: {
            job_id: 'script',
            step_id: 'run',
            attempt: 0,
            iteration: 1,
          },
        },
      ],
    };
    const credits = {
      ...base,
      status_reasons: [
        ...base.status_reasons,
        {
          ...shell.status_reasons[0],
          id: 'shutdown-credits',
          provider: 'claude' as const,
          account_scope: 'ai_credits' as const,
        },
      ],
    };
    mockListExecutionSummaries.mockResolvedValue([
      { ...shell, pipeline_name: 'Shell pipeline' },
      { ...credits, pipeline_name: 'Credits pipeline' },
    ]);
    mockLoadExecutionState.mockImplementation((id) =>
      Promise.resolve(id === 'shell' ? shell : credits),
    );
    const groups = await handleListUsageLimitedIdleSessions({
      resumeReason: 'app_shutdown',
    });
    expect(groups.flatMap((group) => group.sessions)).toEqual([
      expect.objectContaining({
        executionId: 'shell',
        statusReasonIds: ['shutdown-shell'],
        resumeReasons: ['app_shutdown'],
      }),
      expect.objectContaining({
        executionId: 'claude-credits',
        statusReasonIds: ['shutdown-credits'],
        otherBlockingReasonCount: 1,
      }),
    ]);
  });

  it('retains all selected pipeline providers in queued metadata', async () => {
    const base = await mockLoadExecutionState('claude-credits', '/tmp');
    if (!base) throw new Error('Missing fixture');
    const reasons = (['claude', 'codex'] as const).map((provider, index) => ({
      ...base.status_reasons[0],
      id: `reason-${index}`,
      kind: 'app_shutdown' as const,
      provider,
    }));
    const state = { ...base, status_reasons: reasons };
    mockListExecutionSummaries.mockResolvedValue([
      { ...state, pipeline_name: 'Mixed providers' },
    ]);
    mockLoadExecutionState.mockResolvedValue(state);
    mockLoadExecutionState.mockClear();
    const items = await resolveResumeQueueItems({
      targets: [
        {
          kind: 'pipeline',
          executionId: state.id,
          statusReasonIds: reasons.map((reason) => reason.id),
        },
      ],
    });
    expect(items).toEqual([
      expect.objectContaining({ providers: ['claude', 'codex'] }),
    ]);
    expect(mockLoadExecutionState).toHaveBeenCalledTimes(1);
    const selected = await resolveResumeQueueItems({
      targets: [
        {
          kind: 'pipeline',
          executionId: state.id,
          statusReasonIds: ['reason-1'],
        },
      ],
    });
    expect(selected).toEqual([
      expect.objectContaining({ providers: ['codex'] }),
    ]);
    expect(mockLoadExecutionState).toHaveBeenCalledTimes(2);
  });

  it('lists execution checkpoints created before matrix jobs materialize', async () => {
    const base = await mockLoadExecutionState('claude-credits', '/tmp');
    if (!base) throw new Error('Missing fixture');
    const pending = {
      ...base,
      status: 'paused' as const,
      status_reasons: [],
      shutdown_checkpoint: {
        id: 'startup-checkpoint',
        detected_at: '2026-09-08T12:00:00Z',
      },
    };
    mockListExecutionSummaries.mockResolvedValue([
      { ...pending, pipeline_name: 'Pending matrix' },
    ]);
    mockLoadExecutionState.mockResolvedValue(pending);
    const groups = await handleListUsageLimitedIdleSessions({
      resumeReason: 'app_shutdown',
    });
    expect(groups.flatMap((group) => group.sessions)).toEqual([
      expect.objectContaining({
        statusReasonIds: ['startup-checkpoint'],
        resumeReasons: ['app_shutdown'],
        pausedStepCount: 0,
      }),
    ]);
  });

  it('lists only visible native usage reasons for the changed provider', async () => {
    await expect(
      handleListUsageLimitedIdleSessions({ provider: 'claude' }),
    ).resolves.toEqual([
      expect.objectContaining({
        groupKind: 'local',
        workspaceName: 'Local workflows',
        sessions: [
          expect.objectContaining({
            kind: 'pipeline',
            executionId: 'claude-native',
            statusReasonIds: [reasonId],
            provider: 'claude',
            pausedStepCount: 1,
            modelLabels: ['sonnet'],
          }),
        ],
      }),
    ]);
  });

  it('lists paused steps while the overall pipeline is still running', async () => {
    mockListExecutionSummaries.mockResolvedValue([
      {
        id: 'claude-running',
        pipeline_id: 'pipeline',
        pipeline_name: 'Partially paused pipeline',
        status: 'running',
        status_reasons: [],
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
      },
    ]);

    await expect(
      handleListUsageLimitedIdleSessions({ provider: 'claude' }),
    ).resolves.toEqual([
      expect.objectContaining({
        sessions: [
          expect.objectContaining({
            kind: 'pipeline',
            executionId: 'claude-running',
            statusReasonIds: [reasonId],
          }),
        ],
      }),
    ]);
  });

  it('lists native authentication reasons for account-change resume', async () => {
    mockListExecutionSummaries.mockResolvedValue([
      {
        id: 'claude-auth',
        pipeline_id: 'pipeline',
        pipeline_name: 'Claude auth pipeline',
        status: 'paused',
        status_reasons: [],
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
      },
    ]);
    mockLoadExecutionState.mockResolvedValue({
      version: 6,
      id: 'claude-auth',
      pipeline_id: 'pipeline',
      pipeline_snapshot: {
        name: 'Claude auth pipeline',
        scope: ['directory'],
        jobs: {},
      },
      status: 'paused',
      status_reasons: [
        {
          id: reasonId,
          kind: 'provider_authentication_required',
          code: 'authentication_failed',
          provider: 'claude',
          account_scope: 'native',
          model: 'sonnet',
          detected_at: '2026-01-01T00:00:00.000Z',
          source: {
            job_id: 'agent',
            step_id: 'prompt',
            attempt: 0,
            iteration: 1,
          },
        },
      ],
      jobs: {},
      job_definitions: {},
      job_groups: {},
      pending_pauses: [],
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      env: {},
      inputs: {},
    });

    await expect(
      handleListUsageLimitedIdleSessions({ provider: 'claude' }),
    ).resolves.toEqual([
      expect.objectContaining({
        sessions: [
          expect.objectContaining({
            executionId: 'claude-auth',
            statusReasonIds: [reasonId],
            resumeReasons: ['authentication'],
          }),
        ],
      }),
    ]);
  });
});
