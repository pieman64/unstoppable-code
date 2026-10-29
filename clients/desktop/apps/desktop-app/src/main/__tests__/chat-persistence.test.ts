const emitCoworkRemovalsMock = jest.fn();
const emitCoworkEntryMock = jest.fn(() => Promise.resolve());
jest.mock('../services/standalone-chat-service', () => ({
  emitStandaloneChatRemovals: emitCoworkRemovalsMock,
  emitStandaloneWorkEntrySummary: emitCoworkEntryMock,
}));
/* eslint-disable @typescript-eslint/consistent-type-imports, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ArchivedChatSummary,
  type ChatTabsFile,
  type ChatReadArchiveResponse,
  type ChatRestoreArchiveResponse,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  isPersistedChatTab as IsPersistedChatTab,
  readChatTabsFile as ReadChatTabsFile,
} from '../lib/chat-tabs-reader';

type ChatTabsReaderModule = {
  isPersistedChatTab: typeof IsPersistedChatTab;
  readChatTabsFile: typeof ReadChatTabsFile;
};

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveChatArchivesFilePath: jest.fn(),
  resolveChatTabsFilePath: jest.fn(),
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  ...jest.requireActual<ChatTabsReaderModule>('../lib/chat-tabs-reader'),
  readChatTabsFile: jest.fn(),
}));

jest.mock('../lib/adhoc-migrate-tabs', () => ({
  adhocMigrateWorktreeTabs: jest.fn().mockResolvedValue({ migratedTabIds: [] }),
}));

const mockForkOpenWorktreeTabs = jest.fn().mockResolvedValue(new Map());
jest.mock('../lib/worktree-open-tabs-fork', () => ({
  ...jest.requireActual('../lib/worktree-open-tabs-fork'),
  forkOpenWorktreeTabs: mockForkOpenWorktreeTabs,
}));

const mockListAccountMcpConnections = jest.fn();
jest.mock('../canopy-cloud/mcp-connections', () => ({
  listAccountMcpConnections: (): unknown => mockListAccountMcpConnections(),
}));

jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: jest.fn(),
}));

/** Canonical live tabs the archive handler resolves `tabId` against. */
let liveCompatibilityTabs: PersistedChatTab[] = [];

const mockChatStateService = {
  getState: jest.fn(
    async (scope: { projectId: string; worktreeId: string }) => ({
      schemaVersion: 1 as const,
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      revision: 1,
      tabsFile: {
        version: 1 as const,
        tabs: liveCompatibilityTabs,
        activeTabId: liveCompatibilityTabs[0]?.id ?? '',
      },
      archives: [],
      runtimeByChatId: {},
      queue: [],
    }),
  ),
  getCompatibilityTabs: jest.fn(
    async (
      _scope: { projectId: string; worktreeId: string },
      selection?: { chatIds?: readonly string[] },
    ): Promise<ChatTabsFile> => ({
      version: 1,
      // Native metadata reads deliberately guard unselected transcript bodies.
      tabs: liveCompatibilityTabs.map((tab) =>
        selection?.chatIds?.includes(tab.id)
          ? tab
          : Object.defineProperty({ ...tab }, 'messages', {
              get: (): PersistedChatTab['messages'] => {
                throw new Error(`Transcript body was not selected: ${tab.id}`);
              },
            }),
      ),
      activeTabId: liveCompatibilityTabs[0]?.id ?? '',
    }),
  ),
  replaceCompatibilityArchives: jest.fn(
    async (
      scope: { projectId: string; worktreeId: string },
      data: import('@canopy/desktop-shared/types').ArchivedChatsFile,
    ) => {
      const archives = jest.requireActual('../lib/chat-archives');
      await archives.writeChatArchivesSnapshotForTests(
        scope.projectId,
        scope.worktreeId,
        data,
      );
      return data;
    },
  ),
  replaceCompatibilityTabs: jest.fn(
    async (
      scope: { projectId: string; worktreeId: string },
      data: ChatTabsFile,
      options?: {
        changedTabIds?: readonly string[];
        removedTabIds?: readonly string[];
      },
    ): Promise<ChatTabsFile> => {
      const reader = jest.requireMock('../lib/chat-tabs-reader');
      const writer = jest.requireMock('../lib/chat-tabs');
      const current = await Promise.resolve(
        reader.readChatTabsFile(scope.projectId, scope.worktreeId),
      ).catch(() => undefined);
      const currentById = new Map(
        (current?.tabs ?? []).map((tab) => [tab.id, tab]),
      );
      const removed = new Set(options?.removedTabIds ?? []);
      const tabs = data.tabs.map((tab) => {
        const canonical = currentById.get(tab.id);
        if (!canonical) return tab;
        const incomingMessages = new Map(
          tab.messages.map((message) => [message.id, message]),
        );
        return {
          ...canonical,
          ...tab,
          messages: [
            ...canonical.messages.map(
              (message) => incomingMessages.get(message.id) ?? message,
            ),
            ...tab.messages.filter(
              (message) =>
                !canonical.messages.some(
                  (candidate) => candidate.id === message.id,
                ),
            ),
          ],
        };
      });
      for (const tab of current?.tabs ?? []) {
        if (
          !removed.has(tab.id) &&
          !tabs.some((entry) => entry.id === tab.id)
        ) {
          tabs.push(tab);
        }
      }
      const next: ChatTabsFile = {
        ...data,
        ...(Math.max(current?.revision ?? 0, data.revision ?? 0) > 0
          ? {
              revision: Math.max(current?.revision ?? 0, data.revision ?? 0),
            }
          : {}),
        tabs,
      };
      if (options) {
        await writer.writeChatTabsFile(
          scope.projectId,
          scope.worktreeId,
          next,
          {
            changedTabIds: options.changedTabIds ?? [],
            removedTabIds: options.removedTabIds ?? [],
          },
        );
      } else {
        await writer.writeChatTabsFile(scope.projectId, scope.worktreeId, next);
      }
      return next;
    },
  ),
  archiveCompatibilityTab: jest.fn(
    async (
      scope: { projectId: string; worktreeId: string },
      entry: unknown,
    ) => {
      const archives = jest.requireActual('../lib/chat-archives');
      return archives.appendChatArchiveSnapshotForTests(
        scope.projectId,
        scope.worktreeId,
        entry,
      );
    },
  ),
  getCompatibilityArchives: jest.fn(
    async (scope: { projectId: string; worktreeId: string }) => {
      const archives = jest.requireActual('../lib/chat-archives');
      return archives.readChatArchivesSnapshotForTests(
        scope.projectId,
        scope.worktreeId,
      );
    },
  ),
  readCompatibilityArchive: jest.fn(
    async (
      scope: { projectId: string; worktreeId: string },
      chatId: string,
    ) => {
      const archives = jest.requireActual('../lib/chat-archives');
      const file = await archives.readChatArchivesSnapshotForTests(
        scope.projectId,
        scope.worktreeId,
      );
      return file.archived.find((entry) => entry.tab.id === chatId) ?? null;
    },
  ),
  command: jest.fn(
    async (envelope: {
      projectId: string;
      worktreeId: string;
      command: { type: string; archiveEntryId?: string };
    }) => {
      const archives = jest.requireActual('../lib/chat-archives');
      if (
        envelope.command.type === 'chat.restore_archive' &&
        envelope.command.archiveEntryId
      ) {
        const entry = await archives.removeChatArchiveSnapshotForTests(
          envelope.projectId,
          envelope.worktreeId,
          envelope.command.archiveEntryId,
        );
        return {
          commandId: 'test',
          revision: 1,
          outcome: entry ? 'applied' : 'not_found',
        };
      }
      if (
        envelope.command.type === 'chat.mark_archive_read' &&
        envelope.command.archiveEntryId
      ) {
        await archives.markChatArchiveReadSnapshotForTests(
          envelope.projectId,
          envelope.worktreeId,
          envelope.command.archiveEntryId,
        );
      } else if (envelope.command.type === 'chat.mark_all_archives_read') {
        await archives.markAllChatArchivesReadSnapshotForTests(
          envelope.projectId,
          envelope.worktreeId,
        );
      }
      return { commandId: 'test', revision: 1, outcome: 'applied' };
    },
  ),
};
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => mockChatStateService,
}));

// The chat-history live-meta mirror was removed with Work Entries; this mock
// only exists so the suite can assert nothing calls back into the module.
const mockSyncStandaloneChatMetaFromTabs = jest.fn();
jest.mock('../ipc/standalone-chat', () => ({
  syncStandaloneChatMetaFromTabs: mockSyncStandaloneChatMetaFromTabs,
}));

jest.mock('../agents/session-manager', () => ({
  destroySession: jest.fn().mockResolvedValue(undefined),
  getActiveChatIds: jest.fn(() => ['chat-a']),
  markChatSessionIdle: jest.fn(),
}));

jest.mock('../lib/chat-turn-cancel', () => ({
  cancelChatTurn: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../agents/delegation/lifecycle', () => ({
  hasDelegationLifecycle: jest.fn(() => false),
  closeDelegationScope: jest.fn(() => Promise.resolve()),
}));

const mockRemoveDelegateWatchersForChat = jest.fn<
  Promise<void>,
  [{ projectId: string; worktreeId: string; chatId: string }]
>(() => Promise.resolve());
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): {
    removeDelegateWatchersForChat: typeof mockRemoveDelegateWatchersForChat;
  } => ({
    removeDelegateWatchersForChat: mockRemoveDelegateWatchersForChat,
  }),
}));

jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: (id: string): boolean =>
    id === 'cowork-default' || id === 'standalone-chat',
}));

jest.mock('../services/chat-service', () => ({
  projectAppAdvisorChatSummaries: jest.fn().mockResolvedValue(undefined),
  projectAppAdvisorChatSummaryRemovals: jest.fn(),
  projectWorktreeChatSummaries: jest.fn().mockResolvedValue(undefined),
  projectWorktreeChatSummaryRemovals: jest.fn(),
  projectWorktreeChatTodos: jest.fn().mockResolvedValue(undefined),
  projectWorktreeChatTodoRemovals: jest.fn(),
}));

jest.mock('../portal/portal-event-bus', () => ({
  isCanopyPortalActive: jest.fn(() => true),
}));

jest.mock('../portal/adapters/mcp-adapter', () => ({
  projectWorktreeMcpServersForChat: jest.fn().mockResolvedValue(undefined),
}));

const mockedChatSearchService = {
  worktreeChatArchived: jest.fn(),
  worktreeChatRestored: jest.fn(),
};
jest.mock('../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => mockedChatSearchService),
}));

import {
  destroySession,
  getActiveChatIds,
  markChatSessionIdle,
} from '../agents/session-manager';
import { cancelChatTurn } from '../lib/chat-turn-cancel';
import { adhocMigrateWorktreeTabs } from '../lib/adhoc-migrate-tabs';
import {
  closeDelegationScope,
  hasDelegationLifecycle,
} from '../agents/delegation/lifecycle';
import { setDelegationActivity } from '../agents/delegation/activity';
import {
  projectChatTabsMaterialization,
  registerChatPersistenceHandlers,
} from '../ipc/chat-persistence';
import { registerIpcHandler } from '../ipc/register';
import { readChatArchivesFile } from '../lib/chat-archives';
import {
  projectAppAdvisorChatSummaries,
  projectAppAdvisorChatSummaryRemovals,
  projectWorktreeChatSummaries,
  projectWorktreeChatSummaryRemovals,
  projectWorktreeChatTodos,
  projectWorktreeChatTodoRemovals,
} from '../services/chat-service';
import { isCanopyPortalActive } from '../portal/portal-event-bus';
import { projectWorktreeMcpServersForChat } from '../portal/adapters/mcp-adapter';
import { resolveChatArchivesFilePath } from '../lib/resolve-worktree';
import { getFeatureFlagService } from '../feature-flags/service';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';

const mockedDestroySession = jest.mocked(destroySession);
const mockedGetActiveChatIds = jest.mocked(getActiveChatIds);
const mockedMarkChatSessionIdle = jest.mocked(markChatSessionIdle);
const mockedCancelChatTurn = jest.mocked(cancelChatTurn);
const mockedAdhocMigrateWorktreeTabs = jest.mocked(adhocMigrateWorktreeTabs);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedResolveChatArchivesFilePath = jest.mocked(
  resolveChatArchivesFilePath,
);

type HandlerFn<T> = (event: undefined, request: unknown) => Promise<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPersistedChatTab(value: unknown): value is PersistedChatTab {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    Array.isArray(value.messages)
  );
}

function isArchivedChatSummary(value: unknown): value is ArchivedChatSummary {
  return (
    isRecord(value) &&
    typeof value.chatId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.turnCount === 'number' &&
    typeof value.archivedAt === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.restorable === 'boolean'
  );
}

function expectArchivedChatSummaries(value: unknown): ArchivedChatSummary[] {
  if (!Array.isArray(value) || !value.every(isArchivedChatSummary)) {
    throw new Error('Expected archived chat summaries');
  }
  return value;
}

function expectChatReadArchiveResponse(
  value: unknown,
): ChatReadArchiveResponse {
  if (!isRecord(value) || !isPersistedChatTab(value.tab)) {
    throw new Error('Expected chat read archive response');
  }
  return { tab: value.tab };
}

function expectChatRestoreArchiveResponse(
  value: unknown,
): ChatRestoreArchiveResponse {
  if (!isRecord(value) || !isPersistedChatTab(value.tab)) {
    throw new Error('Expected chat restore archive response');
  }
  return { tab: value.tab };
}

function getHandler<T>(
  channel: string,
  decode: (value: unknown) => T,
): HandlerFn<T> {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );

  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }

  const handler = call[1];
  if (typeof handler !== 'function') {
    throw new Error(`Invalid handler for ${channel}`);
  }
  return async (_event: undefined, request: unknown): Promise<T> => {
    const rawResult: unknown = await Promise.resolve(
      Reflect.apply(handler, undefined, [undefined, request]),
    );
    return decode(rawResult);
  };
}

function makeTab(id: string): PersistedChatTab {
  return {
    id,
    title: `Chat ${id}`,
    description: 'A test chat',
    createdAt: '2026-06-19T00:00:00.000Z',
    providerType: 'codex',
    model: 'gpt-6-sol',
    sdkSessionId: `session-${id}`,
    messages: [
      {
        id: 'user-1',
        role: 'user',
        timestamp: 1000,
        blocks: [{ type: 'text', text: 'hello' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        timestamp: 2000,
        blocks: [{ type: 'text', text: 'hi' }],
      },
      {
        id: 'timer-1',
        role: 'system',
        timestamp: 3000,
        blocks: [{ type: 'turn_timer', completedAt: 3000 }],
      },
    ],
  };
}

function makeSendableWindow(): { window: BrowserWindow; send: jest.Mock } {
  const send = jest.fn();
  return {
    window: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        isCrashed: () => false,
        mainFrame: {
          isDestroyed: () => false,
          detached: false,
        },
        send,
      },
    } as unknown as BrowserWindow,
    send,
  };
}

describe('chat persistence archive IPC handlers', () => {
  let tempDir = '';
  let archivePath = '';

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetActiveChatIds.mockReturnValue(['chat-a']);
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-chat-persistence-'));
    archivePath = join(tempDir, 'workspace-a', 'chat-archives', 'wt-a.json');
    mockedResolveChatArchivesFilePath.mockReturnValue(archivePath);
    liveCompatibilityTabs = [makeTab('chat-a')];
    registerChatPersistenceHandlers();
  });

  it('loads tabs with legacy account MCP refs in the server key shape', async (): Promise<void> => {
    const flags = getFeatureFlagService();
    const isEnabled = flags.isEnabled.bind(flags);
    const spy = jest
      .spyOn(flags, 'isEnabled')
      .mockImplementation(
        (key): boolean =>
          key === CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key ||
          isEnabled(key),
      );
    mockListAccountMcpConnections.mockResolvedValue([
      {
        id: 'connection-github',
        serverKey: 'github',
        configId: 'default',
        kind: 'CURATED',
      },
    ]);
    const plain = makeTab('chat-plain');
    liveCompatibilityTabs = [
      {
        ...makeTab('chat-a'),
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [
            { serverId: 'account:connection-github', configId: 'default' },
          ],
        },
        disabledGlobalPluginSelections: {
          mcpServerRefs: [
            { serverId: 'account:connection-github', configId: 'default' },
          ],
        },
      },
      plain,
    ];
    try {
      const tabs = await getHandler(
        IPC_CHANNELS.chatLoadTabs,
        (value): PersistedChatTab[] => {
          if (
            !isRecord(value) ||
            !Array.isArray(value.tabs) ||
            !value.tabs.every(isPersistedChatTab)
          )
            throw new Error('Expected chat tabs');
          return value.tabs;
        },
      )(undefined, { projectId: 'project-a', worktreeId: 'wt-a' });
      expect(tabs[0]?.pluginSelections?.mcpServerRefs).toEqual([
        { serverId: 'github', configId: 'default' },
      ]);
      expect(tabs[0]?.disabledGlobalPluginSelections).toEqual({
        mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
      });
      expect(tabs[1]).toBe(plain);
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts a main-minted composite transcript anchor when forking selected tabs', async () => {
    const destinationTab = { ...makeTab('destination-tab'), messages: [] };

    await getHandler(IPC_CHANNELS.chatForkOpenWorktreeTabs, (value) => value)(
      undefined,
      {
        projectId: 'project-a',
        sourceWorktreeId: 'source-worktree',
        destinationWorktreeId: 'destination-worktree',
        selectedTab: {
          sourceTabId: 'source-tab',
          destinationTab,
          throughMessageId: 'chat-1:mut-1:3',
        },
      },
    );

    expect(mockForkOpenWorktreeTabs).toHaveBeenCalledWith({
      projectId: 'project-a',
      sourceWorktreeId: 'source-worktree',
      destinationWorktreeId: 'destination-worktree',
      selectedTab: {
        sourceTabId: 'source-tab',
        destinationTab,
        throughMessageId: 'chat-1:mut-1:3',
      },
      forkPanelLayout: false,
    });
  });

  it('returns a typed source-change result when branch authorization is revoked', async () => {
    const { SourceApprovalChangedDuringBranchError } = jest.requireActual<
      typeof import('../lib/worktree-open-tabs-fork')
    >('../lib/worktree-open-tabs-fork');
    mockForkOpenWorktreeTabs.mockRejectedValueOnce(
      new SourceApprovalChangedDuringBranchError(),
    );

    await expect(
      getHandler(IPC_CHANNELS.chatForkOpenWorktreeTabs, (value) => value)(
        undefined,
        {
          projectId: 'project-a',
          sourceWorktreeId: 'source-worktree',
          destinationWorktreeId: 'destination-worktree',
          selectedTab: {
            sourceTabId: 'source-tab',
            destinationTab: { ...makeTab('destination-tab'), messages: [] },
          },
        },
      ),
    ).resolves.toEqual({
      tabBindings: {},
      failureCode: 'source_approval_changed',
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    {
      label: 'source root rewrite',
      overrides: { sourceRootRepoIdRewrite: 'Invalid Repo' },
    },
    {
      label: 'selected rewrite source',
      overrides: { selectedRepoIdRewrites: { 'Invalid Repo': 'repo-a' } },
    },
    {
      label: 'selected rewrite destination',
      overrides: { selectedRepoIdRewrites: { 'repo-a': 'Invalid Repo' } },
    },
  ])(
    'rejects an invalid migration repository ID in $label',
    async ({ overrides }) => {
      const handler = getHandler(
        IPC_CHANNELS.chatAdhocMigrateTabs,
        (value) => value,
      );

      await expect(
        handler(undefined, {
          sourceWorkspaceId: 'source-workspace',
          sourceWorktreeId: 'source-worktree',
          destinationWorkspaceId: 'destination-workspace',
          destinationWorktreeId: 'destination-worktree',
          filePathRewrites: [],
          selectedRepoIdRewrites: {},
          ...overrides,
        }),
      ).rejects.toThrow('Invalid');
      expect(mockedAdhocMigrateWorktreeTabs).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: 'source',
      sourceWorkspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      destinationWorkspaceId: 'destination-workspace',
    },
    {
      label: 'destination',
      sourceWorkspaceId: 'source-workspace',
      destinationWorkspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
    },
  ])(
    'rejects an ad-hoc migration whose $label is the read-only viewer scope',
    async ({ sourceWorkspaceId, destinationWorkspaceId }) => {
      const handler = getHandler(
        IPC_CHANNELS.chatAdhocMigrateTabs,
        (value) => value,
      );

      await expect(
        handler(undefined, {
          sourceWorkspaceId,
          sourceWorktreeId: 'source-worktree',
          destinationWorkspaceId,
          destinationWorktreeId: 'destination-worktree',
          filePathRewrites: [],
          selectedRepoIdRewrites: {},
        }),
      ).rejects.toThrow('read-only');
      expect(mockedAdhocMigrateWorktreeTabs).not.toHaveBeenCalled();
    },
  );

  it('defers compatibility auto archive while the root owns a delegated task', async () => {
    const { setDelegationActivity } =
      await import('../agents/delegation/activity');
    setDelegationActivity('archive-test-child', 'project-a/wt-a/chat-a', 1);
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatArchiveTab, expectArchivedChatSummaries)(
          undefined,
          {
            projectId: 'project-a',
            worktreeId: 'wt-a',
            tabId: 'chat-a',
            keepSession: true,
          },
        ),
      ).rejects.toThrow(
        'Delegates are still running in this chat. Stop them first.',
      );
    } finally {
      setDelegationActivity('archive-test-child', 'project-a/wt-a/chat-a', 0);
    }
  });

  it('defers compatibility auto archive while delegated work is only queued', async () => {
    const { setDelegationActivity } =
      await import('../agents/delegation/activity');
    setDelegationActivity('archive-test-queued', 'project-a/wt-a/chat-a', 0, 1);
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatArchiveTab, expectArchivedChatSummaries)(
          undefined,
          {
            projectId: 'project-a',
            worktreeId: 'wt-a',
            tabId: 'chat-a',
            keepSession: true,
          },
        ),
      ).rejects.toThrow(
        'Delegates are still running in this chat. Stop them first.',
      );
    } finally {
      setDelegationActivity('archive-test-queued', 'project-a/wt-a/chat-a', 0);
    }
  });

  it('refuses to close a chat whose delegates are still running', async () => {
    jest.mocked(hasDelegationLifecycle).mockReturnValue(true);
    setDelegationActivity('archive-test-close', 'project-a/wt-a/chat-a', 0, 1);
    try {
      await expect(
        getHandler(IPC_CHANNELS.chatArchiveTab, expectArchivedChatSummaries)(
          undefined,
          { projectId: 'project-a', worktreeId: 'wt-a', tabId: 'chat-a' },
        ),
      ).rejects.toThrow(
        'Delegates are still running in this chat. Stop them first.',
      );
      expect(closeDelegationScope).not.toHaveBeenCalled();
      expect(mockedCancelChatTurn).not.toHaveBeenCalled();
      expect(mockedDestroySession).not.toHaveBeenCalled();
    } finally {
      setDelegationActivity('archive-test-close', 'project-a/wt-a/chat-a', 0);
      jest.mocked(hasDelegationLifecycle).mockReturnValue(false);
    }
  });

  it('closes the delegation scope when a chat with no live delegates closes', async () => {
    jest.mocked(hasDelegationLifecycle).mockReturnValue(true);
    try {
      await getHandler(
        IPC_CHANNELS.chatArchiveTab,
        expectArchivedChatSummaries,
      )(undefined, {
        projectId: 'project-a',
        worktreeId: 'wt-a',
        tabId: 'chat-a',
      });
      expect(closeDelegationScope).toHaveBeenCalledWith({
        projectId: 'project-a',
        worktreeId: 'wt-a',
        chatId: 'chat-a',
      });
    } finally {
      jest.mocked(hasDelegationLifecycle).mockReturnValue(false);
    }
  });

  it('archives a tab, cancels any active turn, and destroys the provider session', async () => {
    const result = await getHandler(
      IPC_CHANNELS.chatArchiveTab,
      expectArchivedChatSummaries,
    )(undefined, {
      projectId: 'project-a',
      worktreeId: 'wt-a',
      tabId: 'chat-a',
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      chatId: 'chat-a',
      turnCount: 1,
      providerType: 'codex',
      model: 'gpt-6-sol',
    });
    expect(mockedDestroySession).toHaveBeenCalledWith(
      'project-a',
      'wt-a',
      'chat-a',
    );
    expect(mockedCancelChatTurn).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-a',
      chatId: 'chat-a',
    });
    expect(mockedMarkChatSessionIdle).not.toHaveBeenCalled();
    expect(mockedChatSearchService.worktreeChatArchived).toHaveBeenCalledWith(
      'project-a',
      'wt-a',
      'chat-a',
    );

    const file = await readChatArchivesFile('project-a', 'wt-a');
    expect(file.archived).toHaveLength(1);
    expect(file.archived[0].tab.sdkSessionId).toBe('session-chat-a');
    expect(file.archived[0].turnCount).toBe(1);
  });

  it.each(['entry-app-advisor', APP_ADVISOR_WORKTREE_ID])(
    'keeps generic archive loading keyed by App Advisor worktree id %s',
    async (worktreeId) => {
      await expect(
        getHandler(IPC_CHANNELS.chatLoadArchives, expectArchivedChatSummaries)(
          undefined,
          {
            projectId: APP_ADVISOR_PROJECT_ID,
            worktreeId,
          },
        ),
      ).resolves.toEqual([]);

      expect(mockedResolveChatArchivesFilePath).toHaveBeenCalledWith(
        APP_ADVISOR_PROJECT_ID,
        worktreeId,
      );
    },
  );

  it('archives and destroys an idle session without interrupting it', async () => {
    mockedGetActiveChatIds.mockReturnValue([]);
    const tab = makeTab('chat-a');
    liveCompatibilityTabs = [tab];

    await getHandler(IPC_CHANNELS.chatArchiveTab, expectArchivedChatSummaries)(
      undefined,
      {
        projectId: 'project-a',
        worktreeId: 'wt-a',
        tabId: 'chat-a',
      },
    );

    expect(mockedCancelChatTurn).not.toHaveBeenCalled();
    expect(mockedDestroySession).toHaveBeenCalledWith(
      'project-a',
      'wt-a',
      'chat-a',
    );

    const file = await readChatArchivesFile('project-a', 'wt-a');
    expect(file.archived[0].tab).toEqual(tab);
  });

  it('closes pending question state in an idle archived snapshot', async () => {
    mockedGetActiveChatIds.mockReturnValue([]);
    const tab: PersistedChatTab = {
      ...makeTab('chat-a'),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          timestamp: 1000,
          blocks: [{ type: 'text', text: 'ask a question' }],
        },
        {
          id: 'timer-1',
          role: 'system',
          timestamp: 1000,
          blocks: [
            {
              type: 'turn_timer',
              startedAt: 1000,
              completedAt: null,
              pausedAt: 1500,
              resumedAt: null,
            },
          ],
        },
        {
          id: 'tool-use-1',
          role: 'system',
          timestamp: 1500,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'question-1',
              toolName: 'canopy_ask_user_question',
              input: '{"questions":[]}',
            },
          ],
        },
      ],
    };

    liveCompatibilityTabs = [tab];
    await getHandler(IPC_CHANNELS.chatArchiveTab, expectArchivedChatSummaries)(
      undefined,
      {
        projectId: 'project-a',
        worktreeId: 'wt-a',
        tabId: 'chat-a',
      },
    );

    const file = await readChatArchivesFile('project-a', 'wt-a');
    const archivedBlocks = file.archived[0].tab.messages.flatMap(
      (message) => message.blocks,
    );
    expect(
      archivedBlocks.some(
        (block) => block.type === 'turn_timer' && block.completedAt !== null,
      ),
    ).toBe(true);
    expect(archivedBlocks).toContainEqual({
      type: 'tool_result',
      toolUseId: 'question-1',
      toolName: 'canopy_ask_user_question',
      output: 'Cancelled',
      isError: true,
    });
    expect(mockedCancelChatTurn).not.toHaveBeenCalled();
  });

  it('preserves Codex subthread attribution on synthetic archive tool results', async () => {
    const tab: PersistedChatTab = {
      ...makeTab('chat-a'),
      messages: [
        {
          id: 'sub-tool-use-1',
          role: 'system',
          timestamp: 1500,
          parentToolUseId: 'agent-1',
          parentBlockId: 'agent-block-1',
          codexThreadId: 'sub-thread-1',
          codexTurnId: 'turn-1',
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'question-1',
              toolName: 'canopy_ask_user_question',
              input: '{"questions":[]}',
            },
          ],
        },
        {
          id: 'sub-tool-use-2',
          role: 'system',
          timestamp: 1600,
          parentToolUseId: 'agent-1',
          parentBlockId: 'agent-block-1',
          codexThreadId: 'sub-thread-2',
          codexTurnId: 'turn-2',
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'question-2',
              toolName: 'canopy_ask_user_question',
              input: '{"questions":[]}',
            },
          ],
        },
      ],
    };

    liveCompatibilityTabs = [tab];
    await getHandler(IPC_CHANNELS.chatArchiveTab, expectArchivedChatSummaries)(
      undefined,
      {
        projectId: 'project-a',
        worktreeId: 'wt-a',
        tabId: 'chat-a',
      },
    );

    const file = await readChatArchivesFile('project-a', 'wt-a');
    const syntheticMessages = file.archived[0].tab.messages.filter((message) =>
      message.id.startsWith('archive-cancel-'),
    );
    expect(syntheticMessages).toHaveLength(2);
    expect(syntheticMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentToolUseId: 'agent-1',
          parentBlockId: 'agent-block-1',
          codexThreadId: 'sub-thread-1',
          codexTurnId: 'turn-1',
          blocks: [
            expect.objectContaining({
              type: 'tool_result',
              toolUseId: 'question-1',
              output: 'Cancelled',
            }),
          ],
        }),
        expect.objectContaining({
          parentToolUseId: 'agent-1',
          parentBlockId: 'agent-block-1',
          codexThreadId: 'sub-thread-2',
          codexTurnId: 'turn-2',
          blocks: [
            expect.objectContaining({
              type: 'tool_result',
              toolUseId: 'question-2',
              output: 'Cancelled',
            }),
          ],
        }),
      ]),
    );
  });

  it('emits a synthetic cancelled chat event when archiving cancels an active turn', async () => {
    mockedRegisterIpcHandler.mockClear();
    const { window, send } = makeSendableWindow();
    registerChatPersistenceHandlers(() => window);

    await getHandler(IPC_CHANNELS.chatArchiveTab, expectArchivedChatSummaries)(
      undefined,
      {
        projectId: 'project-a',
        worktreeId: 'wt-a',
        tabId: 'chat-a',
      },
    );

    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.chatEvent, {
      projectId: 'project-a',
      worktreeId: 'wt-a',
      chatId: 'chat-a',
      data: {
        type: 'result',
        is_error: false,
        result: 'Cancelled',
      },
    });
  });

  it('does not emit a cancelled chat event when keeping an archived session alive', async () => {
    liveCompatibilityTabs = [makeTab('chat-a'), makeTab('unrelated-chat')];
    mockedRegisterIpcHandler.mockClear();
    const { window, send } = makeSendableWindow();
    registerChatPersistenceHandlers(() => window);

    await getHandler(IPC_CHANNELS.chatArchiveTab, expectArchivedChatSummaries)(
      undefined,
      {
        projectId: 'project-a',
        worktreeId: 'wt-a',
        tabId: 'chat-a',
        keepSession: true,
      },
    );

    expect(mockChatStateService.getCompatibilityTabs).toHaveBeenCalledWith(
      { projectId: 'project-a', worktreeId: 'wt-a' },
      { chatIds: ['chat-a'] },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('removes the archived chat’s delegate watchers only when its session ends', async () => {
    const archive = getHandler(
      IPC_CHANNELS.chatArchiveTab,
      expectArchivedChatSummaries,
    );
    await archive(undefined, {
      projectId: 'project-a',
      worktreeId: 'wt-a',
      tabId: 'chat-a',
      keepSession: true,
    });
    expect(mockRemoveDelegateWatchersForChat).not.toHaveBeenCalled();

    liveCompatibilityTabs = [makeTab('chat-a')];
    mockRemoveDelegateWatchersForChat.mockRejectedValueOnce(
      new Error('watcher store unavailable'),
    );
    // A cleanup failure never blocks the durable archive.
    await expect(
      archive(undefined, {
        projectId: 'project-a',
        worktreeId: 'wt-a',
        tabId: 'chat-a',
      }),
    ).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ chatId: 'chat-a' })]),
    );
    expect(mockRemoveDelegateWatchersForChat).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'wt-a',
      chatId: 'chat-a',
    });
  });

  it('still returns archive summaries when active-session cleanup rejects', async () => {
    mockedDestroySession.mockRejectedValueOnce(new Error('already gone'));

    const result = await getHandler(
      IPC_CHANNELS.chatArchiveTab,
      expectArchivedChatSummaries,
    )(undefined, {
      projectId: 'project-a',
      worktreeId: 'wt-a',
      tabId: 'chat-a',
    });

    expect(result.map((entry) => entry.chatId)).toEqual(['chat-a']);
    const file = await readChatArchivesFile('project-a', 'wt-a');
    expect(file.archived[0]?.tab.id).toBe('chat-a');
  });

  it('clears the active-session gate instead of destroying kept auto-archived sessions', async () => {
    const result = await getHandler(
      IPC_CHANNELS.chatArchiveTab,
      expectArchivedChatSummaries,
    )(undefined, {
      projectId: 'project-a',
      worktreeId: 'wt-a',
      tabId: 'chat-a',
      keepSession: true,
      unread: true,
    });

    expect(result.map((entry) => entry.chatId)).toEqual(['chat-a']);
    expect(mockedMarkChatSessionIdle).toHaveBeenCalledWith(
      'project-a',
      'wt-a',
      'chat-a',
    );
    expect(mockedCancelChatTurn).not.toHaveBeenCalled();
    expect(mockedDestroySession).not.toHaveBeenCalled();

    const file = await readChatArchivesFile('project-a', 'wt-a');
    expect(file.archived[0]?.unread).toBe(true);
  });

  it('reads an archive non-destructively', async () => {
    const archiveHandler = getHandler(
      IPC_CHANNELS.chatArchiveTab,
      expectArchivedChatSummaries,
    );
    const readHandler = getHandler(
      IPC_CHANNELS.chatReadArchive,
      expectChatReadArchiveResponse,
    );
    await archiveHandler(undefined, {
      projectId: 'project-a',
      worktreeId: 'wt-a',
      tabId: 'chat-a',
    });

    const response = await readHandler(undefined, {
      projectId: 'project-a',
      worktreeId: 'wt-a',
      chatId: 'chat-a',
      fullTranscript: true,
    });

    expect(response.tab.sdkSessionId).toBe('session-chat-a');
    expect(mockChatStateService.readCompatibilityArchive).toHaveBeenCalledWith(
      { projectId: 'project-a', worktreeId: 'wt-a' },
      'chat-a',
      true,
    );
    expect(mockedChatSearchService.worktreeChatRestored).not.toHaveBeenCalled();
    expect(
      (await readChatArchivesFile('project-a', 'wt-a')).archived,
    ).toHaveLength(1);
  });

  it('restores an archive by removing it and returning the tab', async () => {
    const archiveHandler = getHandler(
      IPC_CHANNELS.chatArchiveTab,
      expectArchivedChatSummaries,
    );
    const restoreHandler = getHandler(
      IPC_CHANNELS.chatRestoreArchive,
      expectChatRestoreArchiveResponse,
    );

    await archiveHandler(undefined, {
      projectId: 'project-a',
      worktreeId: 'wt-a',
      tabId: 'chat-a',
    });

    const response = await restoreHandler(undefined, {
      projectId: 'project-a',
      worktreeId: 'wt-a',
      chatId: 'chat-a',
    });

    expect(response.tab.id).toBe('chat-a');
    expect(response.tab.sdkSessionId).toBe('session-chat-a');
    expect(mockedChatSearchService.worktreeChatRestored).toHaveBeenCalledWith(
      'project-a',
      'wt-a',
      expect.objectContaining({ id: 'chat-a' }),
    );
    expect((await readChatArchivesFile('project-a', 'wt-a')).archived).toEqual(
      [],
    );
  });
});

describe('projectChatTabsMaterialization', () => {
  const mockedProjectSummaries = jest.mocked(projectWorktreeChatSummaries);
  const mockedProjectRemovals = jest.mocked(projectWorktreeChatSummaryRemovals);
  const mockedProjectTodos = jest.mocked(projectWorktreeChatTodos);
  const mockedProjectMcpServers = jest.mocked(projectWorktreeMcpServersForChat);
  const mockedProjectTodoRemovals = jest.mocked(
    projectWorktreeChatTodoRemovals,
  );
  const mockedIsPortalActive = jest.mocked(isCanopyPortalActive);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockedIsPortalActive.mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function tabsFile(tabs: PersistedChatTab[] = []): ChatTabsFile {
    return { version: 1, tabs, activeTabId: tabs[0]?.id ?? '' };
  }

  it('nudges the cowork sidebar instead of projecting worktree summaries', () => {
    const { window, send } = makeSendableWindow();
    projectChatTabsMaterialization(
      () => window,
      'cowork-default',
      'entry-nudge',
      tabsFile(),
      undefined,
    );
    jest.advanceTimersByTime(1_100);

    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.standaloneChatMetaUpdated, {
      projectId: 'cowork-default',
    });
    expect(mockedProjectSummaries).not.toHaveBeenCalled();
    expect(mockedProjectRemovals).not.toHaveBeenCalled();
  });

  it('removes archived cowork chats and refreshes sibling entry metadata', async () => {
    projectChatTabsMaterialization(
      () => null,
      'cowork-default',
      'entry-archive',
      tabsFile([makeTab('remaining')]),
      { changedTabIds: [], removedTabIds: ['archived'] },
    );
    await jest.advanceTimersByTimeAsync(1_100);
    expect(emitCoworkRemovalsMock).toHaveBeenCalledWith('cowork-default', [
      'archived',
    ]);
    expect(emitCoworkEntryMock).toHaveBeenCalledWith(
      'cowork-default',
      'entry-archive',
      tabsFile([makeTab('remaining')]),
    );
    expect(mockedProjectRemovals).not.toHaveBeenCalled();
  });

  it('projects removals immediately and throttles full portal projections', async () => {
    projectChatTabsMaterialization(
      () => null,
      'project-a',
      'wt-removals',
      tabsFile([makeTab('chat-1')]),
      { changedTabIds: [], removedTabIds: ['chat-2'] },
    );

    // Removals must never wait for the projection throttle.
    expect(mockedProjectRemovals).toHaveBeenCalledWith({
      workspaceId: 'project-a',
      worktreeId: 'wt-removals',
      removedChatIds: ['chat-2'],
    });
    expect(mockedProjectTodoRemovals).toHaveBeenCalledWith({
      workspaceId: 'project-a',
      worktreeId: 'wt-removals',
      removedChatIds: ['chat-2'],
    });
    expect(mockedProjectSummaries).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_100);
    expect(mockedProjectSummaries).toHaveBeenCalledWith({
      workspaceId: 'project-a',
      worktreeId: 'wt-removals',
    });
    expect(mockedProjectTodos).toHaveBeenCalledWith({
      workspaceId: 'project-a',
      worktreeId: 'wt-removals',
    });
    expect(mockedProjectMcpServers).toHaveBeenCalledWith(
      {
        workspaceLocalId: 'project-a',
        worktreeLocalId: 'wt-removals',
      },
      expect.objectContaining({ id: 'chat-1' }),
    );
  });

  it('coalesces a burst of materializations into one trailing projection', () => {
    for (let index = 0; index < 5; index += 1) {
      projectChatTabsMaterialization(
        () => null,
        'project-a',
        'wt-burst',
        tabsFile([makeTab(`chat-${index}`)]),
        { changedTabIds: [`chat-${index}`], removedTabIds: [] },
      );
    }
    jest.advanceTimersByTime(1_100);

    expect(mockedProjectSummaries).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a worktree scope when no portal session is active', () => {
    mockedIsPortalActive.mockReturnValue(false);
    projectChatTabsMaterialization(
      () => null,
      'project-a',
      'wt-inactive',
      tabsFile(),
      { changedTabIds: [], removedTabIds: ['chat-2'] },
    );
    jest.advanceTimersByTime(2_000);

    expect(mockedProjectRemovals).not.toHaveBeenCalled();
    expect(mockedProjectSummaries).not.toHaveBeenCalled();
  });

  it('projects App Advisor materialization without leaking sentinel ids into worktree projections', async () => {
    const mockedProjectAppAdvisorSummaries = jest.mocked(
      projectAppAdvisorChatSummaries,
    );
    const mockedProjectAppAdvisorRemovals = jest.mocked(
      projectAppAdvisorChatSummaryRemovals,
    );

    projectChatTabsMaterialization(
      () => null,
      APP_ADVISOR_PROJECT_ID,
      'entry-1',
      tabsFile([makeTab('chat-1')]),
      { changedTabIds: ['chat-1'], removedTabIds: ['chat-2'] },
    );

    expect(mockedProjectAppAdvisorRemovals).toHaveBeenCalledWith({
      removedChatIds: ['chat-2'],
    });
    await jest.advanceTimersByTimeAsync(1_100);
    expect(mockedProjectAppAdvisorSummaries).toHaveBeenCalledWith('entry-1');
    expect(mockedProjectSummaries).not.toHaveBeenCalled();
    expect(mockedProjectRemovals).not.toHaveBeenCalled();
    expect(mockedProjectTodos).not.toHaveBeenCalled();
    expect(mockedProjectTodoRemovals).not.toHaveBeenCalled();
    expect(mockedProjectMcpServers).not.toHaveBeenCalled();
  });
});
