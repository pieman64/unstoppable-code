jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));
jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: jest.fn(),
}));

import type {
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { writeChatTabsFile } from '../lib/chat-tabs';
import {
  capturePersistedUsageLimitBannerSnapshot,
  clearPersistedUsageLimitBanner,
} from '../lib/chat-usage-limit-cleanup';

const mockedReadChatTabsFile = jest.mocked(readChatTabsFile);
const mockedWriteChatTabsFile = jest.mocked(writeChatTabsFile);

function chatTabsFile(tab: PersistedChatTab): ChatTabsFile {
  return {
    version: 1,
    tabs: [tab],
    activeTabId: tab.id,
  };
}

function bannerState(dismissKey: string): {
  provider: 'claude';
  message: string;
  detectedAt: number;
  dismissKey: string;
} {
  return {
    provider: 'claude',
    message: 'Usage limit reached',
    detectedAt: 1,
    dismissKey,
  };
}

describe('chat usage-limit cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedWriteChatTabsFile.mockResolvedValue(undefined);
  });

  it('clears current and legacy banner fields from the accepted turn', async () => {
    const tab: PersistedChatTab & Record<string, unknown> = {
      id: 'chat-1',
      title: 'Existing chat',
      createdAt: '2026-08-04T00:00:00.000Z',
      kind: 'chat',
      messages: [],
      llmProviderUsageLimitBanner: bannerState('current-limit'),
      dismissedLlmProviderUsageLimitBannerKey: 'current-limit',
      claudeUsageLimitBanner: bannerState('legacy-limit'),
      dismissedClaudeUsageLimitBannerKey: 'legacy-limit',
    };
    let persistedTabsFile = chatTabsFile(tab);
    mockedReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabsFile),
    );
    mockedWriteChatTabsFile.mockImplementation(
      (_projectId, _worktreeId, tabsFile) => {
        persistedTabsFile = tabsFile;
        return Promise.resolve();
      },
    );

    await clearPersistedUsageLimitBanner({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      expectedBannerState: capturePersistedUsageLimitBannerSnapshot(tab),
    });

    expect(persistedTabsFile.tabs[0]).not.toHaveProperty(
      'llmProviderUsageLimitBanner',
    );
    expect(persistedTabsFile.tabs[0]).not.toHaveProperty(
      'dismissedLlmProviderUsageLimitBannerKey',
    );
    expect(persistedTabsFile.tabs[0]).not.toHaveProperty(
      'claudeUsageLimitBanner',
    );
    expect(persistedTabsFile.tabs[0]).not.toHaveProperty(
      'dismissedClaudeUsageLimitBannerKey',
    );
  });

  it('preserves a newer banner installed after dispatch began', async () => {
    const acceptedTurnTab: PersistedChatTab = {
      id: 'chat-1',
      title: 'Existing chat',
      createdAt: '2026-08-04T00:00:00.000Z',
      kind: 'chat',
      messages: [],
      llmProviderUsageLimitBanner: bannerState('accepted-turn-limit'),
    };
    const newerBannerTab: PersistedChatTab = {
      ...acceptedTurnTab,
      llmProviderUsageLimitBanner: bannerState('newer-limit'),
    };
    mockedReadChatTabsFile.mockResolvedValue(chatTabsFile(newerBannerTab));

    await clearPersistedUsageLimitBanner({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      expectedBannerState:
        capturePersistedUsageLimitBannerSnapshot(acceptedTurnTab),
    });

    expect(mockedWriteChatTabsFile).not.toHaveBeenCalled();
  });
});
