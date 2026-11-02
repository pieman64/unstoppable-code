jest.mock('node:fs/promises');
jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));
jest.mock('electron', () => ({
  dialog: {
    showOpenDialog: jest.fn(),
  },
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../agents/utils', () => ({
  generateChatSummary: jest.fn(),
}));
jest.mock('../lib/chat-project-utils', () => ({
  ensureChatProjectDir: jest.fn().mockResolvedValue(undefined),
  ensureCoworkHomeScaffold: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
  readChatTranscript: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getWorkspaceChatHistoryMetaFilePath: jest.fn(),
  getWorkspaceChatHistoryRootDir: jest.fn(),
  getWorkspaceChatTabsFilePath: jest.fn(),
  getWorkspaceDir: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}`,
  ),
  getWorkspaceHomeDir: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/home`,
  ),
  getCoworkWorkspaceRootDir: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/home`,
  ),
}));
jest.mock('../lib/cowork-workspace-crud', () => ({
  createCoworkWorkspace: jest.fn(),
  listCoworkWorkspacesAsChatProjects: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  normalizeCoworkSettings: jest.fn(),
  readWorkspaceConfig: jest.fn().mockResolvedValue({
    version: 1,
    type: 'cowork',
    repos: [],
  }),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn().mockResolvedValue({ version: 1, items: [] }),
  readWorkspaceIndexEntry: jest.fn().mockResolvedValue(null),
  writeAllSidebarItems: jest.fn(),
}));
jest.mock('../lib/standalone-history', () => ({
  readArchiveListing: jest.fn(),
  readArchiveSnapshot: jest.fn(),
  readArchiveSummary: jest.fn(),
}));
jest.mock('../lib/chat-archives', () => ({
  readChatArchivesFile: jest
    .fn()
    .mockResolvedValue({ version: 1, archived: [] }),
  writeChatArchivesFile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  listWorkEntryIds: jest.fn().mockResolvedValue([]),
  parseWorkEntriesFile: jest.fn(),
  readWorkEntryChatCatalog: jest
    .fn()
    .mockResolvedValue({ liveChatIds: [], archives: [] }),
}));
const mockGetCompatibilityTabs = jest.fn();
const mockReplaceCompatibilityTabs = jest.fn();
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: jest.fn(() => ({
    getCompatibilityTabs: mockGetCompatibilityTabs,
    replaceCompatibilityTabs: mockReplaceCompatibilityTabs,
  })),
}));
jest.mock('../lib/standalone-history-index', () => ({
  listHistoryChatIds: jest.fn().mockResolvedValue([]),
  loadHistoryIndex: jest.fn(),
  rebuildHistoryIndex: jest.fn().mockResolvedValue([]),
}));
const mockedChatSearchService = {
  deleteCoworkArchive: jest.fn(),
  indexCoworkArchive: jest.fn(),
};
jest.mock('../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => mockedChatSearchService),
}));
jest.mock('../lib/standalone-project-state', () => ({
  buildDefaultStandaloneProjectFile: jest.fn(
    (project: { id: string; name: string; createdAt: string }) => ({
      version: 1,
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      settings: {},
    }),
  ),
  readStandaloneProjectFile: jest.fn(),
  saveStandaloneProjectFile: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../memory/local/import/import-job', () => ({
  enqueueWorkspaceLocalMemoryImportBatch: jest.fn(),
}));
jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: jest.fn((id: string) => id),
}));
jest.mock('../lib/validation', () => ({
  validateId: jest.fn((value: string) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
      throw new Error('Invalid projectId');
    }
  }),
}));
jest.mock('../lib/type-guards', () => ({
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
}));

import { cp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import {
  IPC_CHANNELS,
  type StandaloneArchiveResumeResponse,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { registerStandaloneChatHandlers } from '../ipc/standalone-chat';
import {
  ensureChatProjectDir,
  ensureCoworkHomeScaffold,
} from '../lib/chat-project-utils';
import {
  readStandaloneProjectFile,
  saveStandaloneProjectFile,
} from '../lib/standalone-project-state';
import {
  loadHistoryIndex,
  listHistoryChatIds,
  rebuildHistoryIndex,
} from '../lib/standalone-history-index';
import {
  readArchiveListing,
  readArchiveSnapshot,
  readArchiveSummary,
} from '../lib/standalone-history';
import {
  readChatArchivesFile,
  writeChatArchivesFile,
} from '../lib/chat-archives';
import { readChatTranscript } from '../lib/chat-tabs-reader';
import {
  listWorkEntryIds,
  readWorkEntryChatCatalog,
} from '../lib/cowork-work-entries';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { readWorkspaceIndexEntry } from '../lib/sidebar-items';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { enqueueWorkspaceLocalMemoryImportBatch } from '../memory/local/import/import-job';

const mockedCp = jest.mocked(cp);
const mockedReadFile = jest.mocked(readFile);
const mockedWriteFile = jest.mocked(writeFile);
const mockedExecFile = jest.mocked(execFile);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedEnsureChatProjectDir = jest.mocked(ensureChatProjectDir);
const mockedEnsureCoworkHomeScaffold = jest.mocked(ensureCoworkHomeScaffold);
const mockedRebuildHistoryIndex = jest.mocked(rebuildHistoryIndex);
const mockedSaveStandaloneProjectFile = jest.mocked(saveStandaloneProjectFile);
const mockedReadStandaloneProjectFile = jest.mocked(readStandaloneProjectFile);
const mockedLoadHistoryIndex = jest.mocked(loadHistoryIndex);
const mockedListHistoryChatIds = jest.mocked(listHistoryChatIds);
const mockedReadArchiveSnapshot = jest.mocked(readArchiveSnapshot);
const mockedReadArchiveListing = jest.mocked(readArchiveListing);
const mockedWriteChatArchivesFile = jest.mocked(writeChatArchivesFile);
const mockedListWorkEntryIds = jest.mocked(listWorkEntryIds);
const mockedReadWorkEntryChatCatalog = jest.mocked(readWorkEntryChatCatalog);
const mockedReadArchiveSummary = jest.mocked(readArchiveSummary);
const mockedReadChatArchivesFile = jest.mocked(readChatArchivesFile);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorkspaceIndexEntry = jest.mocked(readWorkspaceIndexEntry);
const mockedEnqueueWorkspaceLocalMemoryImportBatch = jest.mocked(
  enqueueWorkspaceLocalMemoryImportBatch,
);
const mockedResolveCoworkWorkspaceId = jest.mocked(resolveCoworkWorkspaceId);

type HandlerFn = (event: undefined, ...args: unknown[]) => Promise<unknown>;

function getHandler(
  channel: typeof IPC_CHANNELS.standaloneChatResumeArchive,
): (
  event: undefined,
  ...args: unknown[]
) => Promise<StandaloneArchiveResumeResponse>;
function getHandler(channel: string): HandlerFn;
function getHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );

  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }

  const handler = call[1];
  if (!(handler instanceof Function)) {
    throw new Error(`Invalid handler for ${channel}`);
  }
  return async (_event: undefined, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(Reflect.apply(handler, undefined, [undefined, ...args]));
}

describe('standalone chat IPC handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCp.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRebuildHistoryIndex.mockResolvedValue([]);
    mockedReadWorkspaceIndexEntry.mockResolvedValue(null);
    mockedListHistoryChatIds.mockResolvedValue([]);
    mockedReadArchiveSnapshot.mockResolvedValue(null);
    mockedReadArchiveListing.mockResolvedValue(null);
    mockedReadArchiveSummary.mockResolvedValue('Summary not available.');
    mockedReadChatArchivesFile.mockResolvedValue({ version: 1, archived: [] });
    mockedWriteChatArchivesFile.mockResolvedValue(undefined);
    mockedListWorkEntryIds.mockResolvedValue([]);
    mockedReadWorkEntryChatCatalog.mockResolvedValue({
      liveChatIds: [],
      archives: [],
    });
    mockGetCompatibilityTabs.mockReset();
    mockReplaceCompatibilityTabs.mockReset().mockResolvedValue(undefined);
    mockedEnqueueWorkspaceLocalMemoryImportBatch.mockResolvedValue({
      disabled: false,
      staged: 0,
      skipped: 0,
      deferred: 0,
      errors: [],
    });
    mockedResolveCoworkWorkspaceId.mockImplementation((id: string) => id);
    registerWorkspaceTypes(new Map());
    registerStandaloneChatHandlers();
  });

  it('queues the workspace local memory import when a cowork workspace initializes', async () => {
    registerWorkspaceTypes(new Map([['default', 'cowork']]));

    await getHandler(IPC_CHANNELS.standaloneChatInit)(undefined, 'default');

    expect(mockedEnqueueWorkspaceLocalMemoryImportBatch).toHaveBeenCalledWith(
      'default',
    );
  });

  it('queues the memory import for a legacy chat-project id that maps to a cowork workspace', async () => {
    mockedResolveCoworkWorkspaceId.mockImplementation((id: string) =>
      id === 'legacy-chat' ? 'default' : id,
    );
    registerWorkspaceTypes(new Map([['default', 'cowork']]));

    await getHandler(IPC_CHANNELS.standaloneChatInit)(undefined, 'legacy-chat');

    expect(mockedEnqueueWorkspaceLocalMemoryImportBatch).toHaveBeenCalledWith(
      'default',
    );
  });

  it('does not queue a memory import for an id that is not a registered cowork workspace', async () => {
    await getHandler(IPC_CHANNELS.standaloneChatInit)(undefined, 'default');

    expect(mockedEnqueueWorkspaceLocalMemoryImportBatch).not.toHaveBeenCalled();
  });

  it('scaffolds the standalone chat project without spawning git', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    await expect(
      getHandler(IPC_CHANNELS.standaloneChatInit)(undefined, 'default'),
    ).resolves.toBeUndefined();

    expect(mockedExecFile).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalledWith(
      expect.stringContaining('.gitignore'),
      expect.anything(),
      'utf8',
    );
    expect(mockedWriteFile).not.toHaveBeenCalledWith(
      expect.stringContaining('.git'),
      expect.anything(),
      'utf8',
    );
    expect(mockedEnsureCoworkHomeScaffold).toHaveBeenCalledWith('default');
    expect(mockedRebuildHistoryIndex).toHaveBeenCalledWith('default');
  });

  it('continues initialization when an archive snapshot is corrupt', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: { archiveRetentionDays: 7 },
    });
    mockedListHistoryChatIds.mockResolvedValue(['broken', 'healthy']);
    mockedReadArchiveListing
      .mockRejectedValueOnce(new SyntaxError('Invalid archive JSON'))
      .mockResolvedValueOnce(null);

    await expect(
      getHandler(IPC_CHANNELS.standaloneChatInit)(undefined, 'default'),
    ).resolves.toBeUndefined();

    // Retention consults the read-only listing; it never opens (migrates)
    // an archive just to learn its archivedAt.
    expect(mockedReadArchiveListing).toHaveBeenCalledTimes(2);
    expect(mockedReadArchiveSnapshot).not.toHaveBeenCalled();
    expect(mockedRebuildHistoryIndex).toHaveBeenCalledWith('default');
  });

  it('admits only work entries with expirable archives when applying retention', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: { archiveRetentionDays: 7 },
    });
    mockedListWorkEntryIds.mockResolvedValue(['entry-fresh', 'entry-stale']);
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockedReadWorkEntryChatCatalog.mockImplementation((_projectId, entryId) =>
      Promise.resolve(
        entryId === 'entry-stale'
          ? {
              liveChatIds: [],
              archives: [{ chatId: 'old', archivedAt: stale }],
            }
          : entryId === 'entry-fresh'
            ? {
                liveChatIds: ['live'],
                archives: [{ chatId: 'recent', archivedAt: fresh }],
              }
            : { liveChatIds: [], archives: [] },
      ),
    );
    const staleTab = {
      id: 'old',
      title: 'Old',
      createdAt: stale,
      messages: [],
    };
    mockedReadChatArchivesFile.mockResolvedValue({
      version: 1,
      archived: [{ tab: staleTab, archivedAt: stale, turnCount: 1 }],
    });

    await expect(
      getHandler(IPC_CHANNELS.standaloneChatInit)(undefined, 'default'),
    ).resolves.toBeUndefined();

    // Catalog reads cover every entry plus the legacy home slot...
    expect(
      mockedReadWorkEntryChatCatalog.mock.calls.map(([, id]) => id),
    ).toEqual(['entry-fresh', 'entry-stale', 'home']);
    // ...but only the scope with something to expire is admitted and written.
    expect(mockedReadChatArchivesFile.mock.calls).toEqual([
      ['default', 'entry-stale'],
    ]);
    expect(mockedWriteChatArchivesFile).toHaveBeenCalledTimes(1);
    expect(mockedWriteChatArchivesFile).toHaveBeenCalledWith(
      'default',
      'entry-stale',
      { version: 1, archived: [] },
    );
  });

  it('registers no handler for the removed legacy archive/search/workspace-item channels', () => {
    const registeredChannels = mockedRegisterIpcHandler.mock.calls.map(
      ([channel]) => channel,
    );
    for (const removedChannel of [
      'standalone-chat:archive',
      'standalone-chat:search',
      'standalone-chat:read-note',
      'standalone-chat:save-note',
      'standalone-chat:read-prompt',
      'standalone-chat:save-prompt',
      'standalone-chat:import-attachments',
      'standalone-chat:save-artifact',
      'standalone-chat:read-artifact',
      'standalone-chat:delete-workspace-item',
      'standalone-chat:update-pinned-context',
      'standalone-chat:update-project-ui',
    ]) {
      expect(registeredChannels).not.toContain(removedChannel);
    }
  });

  it('keeps the archive read/resume/summary and list/load-workspace read paths registered', () => {
    const registeredChannels = mockedRegisterIpcHandler.mock.calls.map(
      ([channel]) => channel,
    );
    for (const keptChannel of [
      IPC_CHANNELS.standaloneChatList,
      IPC_CHANNELS.standaloneChatReadSummary,
      IPC_CHANNELS.standaloneChatReadArchive,
      IPC_CHANNELS.standaloneChatResumeArchive,
      IPC_CHANNELS.standaloneChatLoadWorkspace,
    ]) {
      expect(registeredChannels).toContain(keptChannel);
    }
  });

  it('lists, reads, and resumes pre-entry unified archives', async () => {
    mockedReadChatArchivesFile.mockResolvedValue({
      version: 1,
      archived: [
        {
          tab: {
            id: 'legacy-unified',
            title: 'Legacy unified chat',
            customTitle: 'My archived chat',
            description: 'Preserved archive summary',
            createdAt: '2026-07-10T00:00:00.000Z',
            messages: [],
            providerType: 'codex',
          },
          archivedAt: '2026-07-11T00:00:00.000Z',
          turnCount: 2,
        },
      ],
    });

    await expect(
      getHandler(IPC_CHANNELS.standaloneChatList)(undefined, 'default'),
    ).resolves.toEqual({
      chats: [
        expect.objectContaining({
          id: 'legacy-unified',
          customTitle: 'My archived chat',
          archived: true,
          archivedAt: '2026-07-11T00:00:00.000Z',
        }),
      ],
    });

    await expect(
      getHandler(IPC_CHANNELS.standaloneChatReadArchive)(undefined, {
        projectId: 'default',
        chatId: 'legacy-unified',
      }),
    ).resolves.toMatchObject({
      summary: 'Preserved archive summary',
      legacySummaryOnly: false,
      snapshot: {
        chatId: 'legacy-unified',
        tab: { id: 'legacy-unified' },
      },
    });

    const resumed = await getHandler(IPC_CHANNELS.standaloneChatResumeArchive)(
      undefined,
      {
        projectId: 'default',
        chatId: 'legacy-unified',
        mode: 'resume',
      },
    );
    expect(resumed.tab.title).toBe('Legacy unified chat');
    expect(resumed.tab.id).not.toBe('legacy-unified');
  });

  it('resumes an archive with its delegated tasks’ children as rows', async () => {
    mockedReadChatArchivesFile.mockResolvedValue({
      version: 1,
      archived: [
        {
          tab: {
            id: 'logged',
            title: 'Logged chat',
            createdAt: '2026-07-10T00:00:00.000Z',
            messages: [],
            providerType: 'codex',
            transcript: {
              format: 'complete-message-jsonl-v1',
              committedMessageCount: 1,
              committedByteLength: 1,
              transcriptRevision: 1,
              hasActiveSidecar: false,
            },
          },
          archivedAt: '2026-07-11T00:00:00.000Z',
          turnCount: 1,
        },
      ],
    });
    jest.mocked(readChatTranscript).mockResolvedValue([]);
    await getHandler(IPC_CHANNELS.standaloneChatResumeArchive)(undefined, {
      projectId: 'default',
      chatId: 'logged',
      mode: 'resume',
    });
    // The resumed chat is a copy without the archive's delegate logs.
    expect(readChatTranscript).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'logged',
      true,
      { inlineDelegationChildren: true },
    );
  });

  it('removes the empty starter replaced by a resumed archive', async () => {
    mockedReadChatArchivesFile.mockResolvedValue({
      version: 1,
      archived: [
        {
          tab: {
            id: 'archived-chat',
            title: 'Archived chat',
            createdAt: '2026-07-10T00:00:00.000Z',
            messages: [],
          },
          archivedAt: '2026-07-11T00:00:00.000Z',
          turnCount: 0,
        },
      ],
    });
    mockGetCompatibilityTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'starter-chat',
      tabs: [
        {
          id: 'starter-chat',
          title: 'New chat',
          createdAt: '2026-07-12T00:00:00.000Z',
          messages: [],
        },
      ],
    });

    const resumed = await getHandler(IPC_CHANNELS.standaloneChatResumeArchive)(
      undefined,
      {
        projectId: 'default',
        chatId: 'archived-chat',
        mode: 'resume',
        destinationEntryId: 'entry-1',
      },
    );

    expect(mockReplaceCompatibilityTabs).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        tabs: [expect.not.objectContaining({ id: 'starter-chat' })],
      }),
      {
        changedTabIds: [resumed.tab.id],
        removedTabIds: ['starter-chat'],
        activeTabId: resumed.tab.id,
      },
    );
  });

  it('activates a resumed archive appended beside an existing chat', async () => {
    mockedReadChatArchivesFile.mockResolvedValue({
      version: 1,
      archived: [
        {
          tab: {
            id: 'archived-chat',
            title: 'Archived chat',
            createdAt: '2026-07-10T00:00:00.000Z',
            messages: [
              { id: 'user-1', role: 'user', blocks: [], timestamp: 1 },
            ],
          },
          archivedAt: '2026-07-11T00:00:00.000Z',
          turnCount: 1,
        },
      ],
    });
    mockGetCompatibilityTabs.mockResolvedValue({
      version: 1,
      activeTabId: 'existing-chat',
      tabs: [
        {
          id: 'existing-chat',
          title: 'Existing chat',
          createdAt: '2026-07-12T00:00:00.000Z',
          messages: [{ id: 'user-2', role: 'user', blocks: [], timestamp: 2 }],
        },
      ],
    });

    const resumed = await getHandler(IPC_CHANNELS.standaloneChatResumeArchive)(
      undefined,
      {
        projectId: 'default',
        chatId: 'archived-chat',
        mode: 'resume',
        destinationEntryId: 'entry-1',
      },
    );

    expect(mockReplaceCompatibilityTabs).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ activeTabId: resumed.tab.id }),
      {
        changedTabIds: [resumed.tab.id],
        removedTabIds: [],
        activeTabId: resumed.tab.id,
      },
    );
  });

  it('does not resurrect the legacy standalone-chat/{project}/project.json tree on init', async () => {
    // Regression test for the cowork migration deleting `standalone-chat/`
    // and `standaloneChat.init` (via the old `ensureChatProjectDir` call)
    // silently re-creating a legacy `project.json` under it on every
    // subsequent init/switch. Cowork workspaces are self-scaffolded by their
    // CRUD create paths, so init must only touch the cowork home/derived
    // scaffold (`ensureCoworkHomeScaffold`) and must never call the legacy
    // `ensureChatProjectDir` seeding helper.
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    await getHandler(IPC_CHANNELS.standaloneChatInit)(
      undefined,
      'cowork-default',
    );

    expect(mockedEnsureChatProjectDir).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalledWith(
      expect.stringContaining('project.json'),
      expect.anything(),
      'utf8',
    );
  });

  // Export/import-project now bundle/restore from the cowork workspace
  // layout (home/, chats/home.json, chat-history/) rather than the legacy
  // `standalone-chat/{project}` on-disk shape, and creating the imported
  // workspace goes through `cowork-workspace-crud.ts` instead of raw `cp`
  // into a mocked `standalone-chat/` tree. That reshape needs real
  // filesystem behavior to exercise meaningfully, so its coverage lives in
  // the dedicated real-fs round-trip suite:
  // `standalone-chat-export-import.test.ts`.

  // Regression coverage: `getWorkspaceProjectFile` used to build the whole
  // `StandaloneProjectFile` from the (post-migration, deleted) legacy
  // `project.json`. Every field — name, color, description, model, presets,
  // and settings — kept reading back as
  // `buildDefaultStandaloneProjectFile`'s hard-coded defaults ("Untitled
  // Project", no description, `archiveRetentionDays: null`) for any migrated
  // or natively-created cowork workspace. The real values live on the
  // workspace's sidebar index entry (name/color) and its `workspace.json`
  // `cowork` block (everything else), so this asserts `loadWorkspace`
  // surfaces those, not the defaults.
  it('sources project name/color/description/model/presets/settings from the cowork project, not stale legacy defaults', async () => {
    mockedReadStandaloneProjectFile.mockResolvedValue(null);
    mockedReadWorkspaceIndexEntry.mockResolvedValue({
      id: 'cowork-default',
      name: 'Acme Research',
      type: 'cowork',
      color: '#336699',
      collapsed: false,
      order: 0,
    });
    // Keep the stale top-level name to verify the legacy field is ignored.
    const workspaceConfigWithLegacyName = {
      version: 1 as const,
      type: 'cowork' as const,
      repos: [],
      name: 'Acme Research',
      cowork: {
        createdAt: '2026-02-01T00:00:00.000Z',
        description: 'Deep research project',
        defaultModel: 'claude-real-model',
        defaultPresetId: 'preset-1',
        presets: [
          {
            id: 'preset-1',
            name: 'Research preset',
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        ],
        archiveRetentionDays: 45,
      },
    };
    mockedReadWorkspaceConfig.mockResolvedValue(workspaceConfigWithLegacyName);
    mockedLoadHistoryIndex.mockResolvedValue([]);

    const response = await getHandler(IPC_CHANNELS.standaloneChatLoadWorkspace)(
      undefined,
      { projectId: 'cowork-default' },
    );

    expect(response).toMatchObject({
      project: {
        id: 'cowork-default',
        name: 'Acme Research',
        color: '#336699',
        createdAt: '2026-02-01T00:00:00.000Z',
        description: 'Deep research project',
        defaultModel: 'claude-real-model',
        defaultPresetId: 'preset-1',
        presets: [expect.objectContaining({ id: 'preset-1' })],
        settings: {
          archiveRetentionDays: 45,
        },
      },
      archives: [],
    });
    expect(mockedEnsureChatProjectDir).not.toHaveBeenCalled();
    expect(mockedSaveStandaloneProjectFile).not.toHaveBeenCalled();
  });

  it('does not reject a workspace load until a history index rebuild still in flight settles', async () => {
    const failure = new Error('scaffold write failed');
    mockedEnsureCoworkHomeScaffold.mockRejectedValueOnce(failure);
    let releaseRebuild = (): void => undefined;
    let rebuildFinished = false;
    mockedLoadHistoryIndex.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRebuild = (): void => {
            rebuildFinished = true;
            resolve([]);
          };
        }),
    );
    let settled = false;
    const outcome = getHandler(IPC_CHANNELS.standaloneChatLoadWorkspace)(
      undefined,
      { projectId: 'cowork-default' },
    ).finally(() => {
      settled = true;
    });

    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockedLoadHistoryIndex).toHaveBeenCalledWith('cowork-default');
    expect(settled).toBe(false);

    releaseRebuild();
    await expect(outcome).rejects.toBe(failure);
    expect(rebuildFinished).toBe(true);
  });
});
