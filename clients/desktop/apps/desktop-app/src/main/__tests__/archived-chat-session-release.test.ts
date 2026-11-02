import type {
  ArchivedChatEntry,
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { IdleChatSessionReleaseDecision } from '../agents/session-manager';

const mockReleaseChatSessionWhenIdle = jest.fn<
  void,
  [
    { projectId: string; worktreeId: string; chatId: string },
    () => Promise<IdleChatSessionReleaseDecision>,
  ]
>();
jest.mock('../agents/session-manager', () => ({
  releaseChatSessionWhenIdle: (
    target: { projectId: string; worktreeId: string; chatId: string },
    confirm: () => Promise<IdleChatSessionReleaseDecision>,
  ): void => mockReleaseChatSessionWhenIdle(target, confirm),
}));

const mockHasActiveReload = jest.fn<boolean, [unknown]>(() => false);
jest.mock('../deferred-tools/reload-coordinator', () => ({
  deferredToolsReloadCoordinator: {
    hasActiveReload: (scope: unknown): boolean => mockHasActiveReload(scope),
  },
}));

const mockReadCompatibilityArchive = jest.fn<
  Promise<ArchivedChatEntry | null>,
  [unknown, string, boolean]
>();
const mockGetCompatibilityTabs = jest.fn<
  Promise<ChatTabsFile>,
  [unknown, unknown]
>();
const mockIsDispatchInFlight = jest.fn<boolean, [unknown]>(() => false);
const CHAT_STATE = {
  readCompatibilityArchive: mockReadCompatibilityArchive,
  getCompatibilityTabs: mockGetCompatibilityTabs,
  isDispatchInFlight: mockIsDispatchInFlight,
};

import { releaseArchivedChatSessionWhenIdle } from '../lib/archived-chat-session-release';

const TARGET = { projectId: 'p', worktreeId: 'w', chatId: 'chat-1' };

function tab(overrides: Partial<PersistedChatTab> = {}): PersistedChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: [],
    ...overrides,
  };
}

function archive(overrides: Partial<PersistedChatTab> = {}): ArchivedChatEntry {
  return {
    tab: tab(overrides),
    archivedAt: '2026-10-23T00:00:00.000Z',
    turnCount: 1,
  };
}

function tabsFile(tabs: PersistedChatTab[]): ChatTabsFile {
  return { version: 1, tabs, activeTabId: tabs[0]?.id ?? '' };
}

async function decide(): Promise<IdleChatSessionReleaseDecision> {
  releaseArchivedChatSessionWhenIdle(TARGET, CHAT_STATE);
  expect(mockReleaseChatSessionWhenIdle).toHaveBeenCalledWith(
    TARGET,
    expect.any(Function),
  );
  const confirm = mockReleaseChatSessionWhenIdle.mock.calls.at(-1)?.[1];
  if (!confirm) throw new Error('No release was requested');
  return confirm();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHasActiveReload.mockReturnValue(false);
  mockIsDispatchInFlight.mockReturnValue(false);
  mockReadCompatibilityArchive.mockResolvedValue(archive());
  mockGetCompatibilityTabs.mockResolvedValue(tabsFile([]));
});

it('releases a chat that is still archived with nothing pending', async () => {
  await expect(decide()).resolves.toBe('release');
  expect(mockReadCompatibilityArchive).toHaveBeenCalledWith(
    { projectId: 'p', worktreeId: 'w' },
    'chat-1',
    false,
  );
  expect(mockGetCompatibilityTabs).toHaveBeenCalledWith(
    { projectId: 'p', worktreeId: 'w' },
    { chatIds: ['chat-1'] },
  );
});

it('keeps the session of a chat that is no longer archived', async () => {
  mockReadCompatibilityArchive.mockResolvedValue(null);
  await expect(decide()).resolves.toBe('retain');
});

it('keeps the session of a chat that is open again', async () => {
  mockGetCompatibilityTabs.mockResolvedValue(tabsFile([tab()]));
  await expect(decide()).resolves.toBe('retain');
});

it('waits while the archived chat has a pending plan exit', async () => {
  mockReadCompatibilityArchive.mockResolvedValue(
    archive({ pendingPlanExit: { plan: 'Ship it' } }),
  );
  await expect(decide()).resolves.toBe('wait');
});

it('waits while a deferred-tools reload is restarting the chat', async () => {
  mockHasActiveReload.mockReturnValue(true);
  await expect(decide()).resolves.toBe('wait');
  expect(mockHasActiveReload).toHaveBeenCalledWith(TARGET);
  expect(mockReadCompatibilityArchive).not.toHaveBeenCalled();
});

it('waits while a send to the chat is still being dispatched', async () => {
  mockIsDispatchInFlight.mockReturnValue(true);
  await expect(decide()).resolves.toBe('wait');
  expect(mockIsDispatchInFlight).toHaveBeenCalledWith(TARGET);
  expect(mockReadCompatibilityArchive).not.toHaveBeenCalled();
});
