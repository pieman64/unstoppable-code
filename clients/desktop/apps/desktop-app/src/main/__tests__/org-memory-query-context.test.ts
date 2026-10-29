import type {
  ChatTabsFile,
  PersistedChatMessage,
  PersistedChatTab,
  WorktreeSummaryData,
} from '@canopy/desktop-shared/types';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { readWorktreeSummary } from '../lib/worktree-summary-persistence';
import {
  collectMemoryQueryContext,
  recentUserMessageTexts,
} from '../memory/query-context';

jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));
jest.mock('../lib/worktree-summary-persistence', () => ({
  readWorktreeSummary: jest.fn(),
}));

const readChatTabsFileMock = jest.mocked(readChatTabsFile);
const readWorktreeSummaryMock = jest.mocked(readWorktreeSummary);

function userMessage(id: string, text: string): PersistedChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 1 };
}

function assistantMessage(id: string, text: string): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
  };
}

function tabsFile(tabs: PersistedChatTab[]): ChatTabsFile {
  return { version: 1, tabs, activeTabId: tabs[0]?.id ?? '' };
}

function chatTab(
  id: string,
  messages: PersistedChatMessage[],
  description?: string,
): PersistedChatTab {
  return {
    id,
    title: 'Chat',
    messages,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(description === undefined ? {} : { description }),
  };
}

const summary: WorktreeSummaryData = {
  title: 'Memory work',
  description: 'Improving retrieval quality',
  highlights: [],
  generatedAt: '2026-01-01T00:00:00.000Z',
  turnCountAtGeneration: 1,
  lastFullRefreshAt: '2026-01-01T00:00:00.000Z',
  lastFullRefreshTurnCount: 1,
};

describe('recentUserMessageTexts', () => {
  it('keeps the last three non-trivial prior user messages in order', () => {
    const texts = recentUserMessageTexts(
      [
        userMessage('m1', 'oldest question with enough characters here'),
        userMessage('m2', 'second question with enough characters here'),
        assistantMessage('a1', 'assistant reply that must never be included'),
        userMessage('m3', 'yes'),
        userMessage('m4', '/compact run the compaction command now'),
        userMessage('m5', 'third question with enough characters here'),
        userMessage('m6', 'fourth question with enough characters here'),
        userMessage('current', 'the current message with enough characters'),
      ],
      'current',
    );
    expect(texts).toEqual([
      'second question with enough characters here',
      'third question with enough characters here',
      'fourth question with enough characters here',
    ]);
  });

  it('excludes machine-generated messages from the context blend', () => {
    const texts = recentUserMessageTexts(
      [
        userMessage('m1', 'real question with enough characters here'),
        userMessage(
          'm2',
          'Unstoppable Code watcher fired.\nWorktree pipeline completion: Code Review (Claude)',
        ),
        userMessage(
          'm3',
          '$builtin-gh:handle-pr-comments --follow-up-pipeline="Code Review" --auto-archive',
        ),
        userMessage(
          'm4',
          'GitHub workflow watcher update: a workflow run completed with success.',
        ),
        userMessage('m5', 'This ordinary human prompt says my watcher fired.'),
        userMessage('current', 'the current message with enough characters'),
      ],
      'current',
    );
    expect(texts).toEqual([
      'real question with enough characters here',
      'This ordinary human prompt says my watcher fired.',
    ]);
  });
});

describe('collectMemoryQueryContext', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('collects prior messages and prefers the chat description', async () => {
    readChatTabsFileMock.mockResolvedValue(
      tabsFile([
        chatTab(
          'chat-1',
          [
            userMessage('m1', 'earlier question with enough characters here'),
            userMessage('current', 'current message with enough characters'),
          ],
          'Chat-scoped description',
        ),
      ]),
    );
    readWorktreeSummaryMock.mockResolvedValue(summary);
    await expect(
      collectMemoryQueryContext({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        currentUserMessageId: 'current',
      }),
    ).resolves.toEqual({
      recentUserMessages: ['earlier question with enough characters here'],
      summaryDescription: 'Chat-scoped description',
    });
  });

  it('falls back to the worktree summary description', async () => {
    readChatTabsFileMock.mockResolvedValue(tabsFile([chatTab('chat-1', [])]));
    readWorktreeSummaryMock.mockResolvedValue(summary);
    await expect(
      collectMemoryQueryContext({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        currentUserMessageId: 'current',
      }),
    ).resolves.toEqual({
      recentUserMessages: [],
      summaryDescription: 'Improving retrieval quality',
    });
  });

  it('returns empty context when the chat is unknown or reads fail', async () => {
    readChatTabsFileMock.mockResolvedValue(tabsFile([]));
    readWorktreeSummaryMock.mockRejectedValue(new Error('missing'));
    await expect(
      collectMemoryQueryContext({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-unknown',
        currentUserMessageId: 'current',
      }),
    ).resolves.toEqual({ recentUserMessages: [], summaryDescription: null });
  });
});
