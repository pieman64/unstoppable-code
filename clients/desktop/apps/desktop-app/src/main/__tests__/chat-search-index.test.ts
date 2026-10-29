import { DatabaseSync } from 'node:sqlite';
import type * as FsPromisesModule from 'node:fs/promises';

// Search tests own their temporary storage lifetime. Canonical chat diagnostics
// must not start an unrelated background persistence writer during teardown.
jest.mock('../observability', () => ({
  getObservabilityService: (): { recordSessionDiagnostic: jest.Mock } => ({
    recordSessionDiagnostic: jest.fn(),
  }),
}));

jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  return {
    ...actual,
    readFile: jest.fn(actual.readFile),
    stat: jest.fn(actual.stat),
  };
});

import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  IPC_CHANNELS,
  type ArchivedChatsFile,
  type ArchivedContainerManifest,
  type ChatTabsFile,
  type PersistedChatBlock,
  type PersistedChatMessage,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';

interface MockBrowserWindow {
  isDestroyed: jest.MockedFunction<() => boolean>;
  webContents: { send: jest.MockedFunction<(channel: string) => void> };
}

const mockGetAllWindows = jest.fn<MockBrowserWindow[], []>();

jest.mock(
  'electron',
  (): {
    BrowserWindow: { getAllWindows: typeof mockGetAllWindows };
  } => ({
    BrowserWindow: { getAllWindows: mockGetAllWindows },
  }),
);

import {
  getChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import {
  getArchivedContainerChatStorage,
  removeArchivedContainerPayloadsAfterPartialRestore,
} from '../lib/archived-containers';
import { getStandaloneHistoryStorage } from '../lib/standalone-history';
import { ChatTranscriptIntegrityError } from '../lib/chat-transcript-log';
import {
  CHAT_SEARCH_INDEXER_RECOVERY_DELAY_MS,
  ChatSearchService,
  sanitizeChatSearchQuery,
} from '../chat-search/service';
import type { ThreadedChatSearchIndexer } from '../chat-search/threaded-indexer';
import {
  type ChatSearchDoc,
  ChatSearchIndexer,
  buildChatSearchDoc,
  extractChatSearchBody,
} from '../chat-search/indexer';
import {
  chatSearchQueryExceedsBodyThreshold,
  queryChatSearchDatabase,
} from '../chat-search/query';
import {
  CHAT_SEARCH_SCHEMA_VERSION,
  openChatSearchDatabase,
} from '../chat-search/schema';
import { commitArchivedContainer } from '../lib/archived-containers';

const actualFsPromises =
  jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
const mockedReadFile = jest.mocked(fsPromises.readFile);
const mockedStat = jest.mocked(fsPromises.stat);

function textBlock(text: string): PersistedChatBlock {
  return { type: 'text', text };
}

function projectedMessage(
  message: PersistedChatMessage,
): AsyncIterable<PersistedChatMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<PersistedChatMessage> {
      let next: PersistedChatMessage | undefined = message;
      return {
        next(): Promise<IteratorResult<PersistedChatMessage>> {
          if (!next) return Promise.resolve({ done: true, value: undefined });
          const value = next;
          next = undefined;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

function makeTab(
  id: string,
  title: string,
  blocks: PersistedChatBlock[] = [textBlock('Visible transcript text')],
): PersistedChatTab {
  return {
    id,
    title,
    description: `Description for ${title}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    providerType: 'claude',
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        timestamp: 1_700_000_000_000,
        blocks,
      },
      {
        id: `${id}-assistant`,
        role: 'assistant',
        timestamp: 1_700_000_001_000,
        blocks: [textBlock('Assistant answer with needle')],
      },
    ],
  };
}

interface FakeThreadedIndexer {
  indexer: ThreadedChatSearchIndexer;
  stagedDocIds: string[];
}

/** A worker-backed indexer double; `failed` behaves like a timed-out worker. */
function fakeThreadedIndexer(failed: boolean): FakeThreadedIndexer {
  const stagedDocIds: string[] = [];
  const failure = (): Promise<never> =>
    Promise.reject(new Error('Search index worker timed out'));
  const settle = <T>(value: T): (() => Promise<T>) =>
    failed ? failure : (): Promise<T> => Promise.resolve(value);
  const indexer = new Proxy(
    {
      ready: new Promise<string>(() => undefined),
      isFailed: (): boolean => failed,
      flush: settle(undefined),
      close: (): Promise<void> => Promise.resolve(),
      beginStagedScope: settle('job'),
      listSourceFileKeys: settle([]),
      replaceStreamedScope: async (
        _projectId: string,
        _worktreeId: string,
        _source: string,
        docs: AsyncIterable<ChatSearchDoc>,
      ): Promise<void> => {
        if (failed) return failure();
        for await (const doc of docs) stagedDocIds.push(doc.chatId);
      },
    },
    {
      get: (target, key): unknown =>
        key in target
          ? Reflect.get(target, key)
          : key === 'then'
            ? undefined
            : settle(null),
    },
  ) as unknown as ThreadedChatSearchIndexer;
  return { indexer, stagedDocIds };
}

function tabsFile(...tabs: PersistedChatTab[]): ChatTabsFile {
  return {
    version: 1,
    tabs,
    activeTabId: tabs[0]?.id ?? '',
  };
}

let atomicWriteCounter = 0;
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Write atomically (temp file + rename) so a concurrent scan read can never
  // observe a truncated/empty file mid-write. A plain writeFile truncates the
  // target before repopulating it, and under slow CI I/O a racing manifest read
  // landing in that window surfaces as a flaky "Unexpected end of JSON input".
  atomicWriteCounter += 1;
  const tempPath = `${path}.${atomicWriteCounter}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await rename(tempPath, path);
}

function scopeIndexPath(path: string): string {
  return join(
    dirname(dirname(path)),
    'chat-storage-v2',
    basename(path, '.json'),
    basename(dirname(path)) === 'chats'
      ? 'live-index.json'
      : 'archive-index.json',
  );
}

async function writeCanonical(
  path: string,
  value: ChatTabsFile | ArchivedChatsFile,
): Promise<void> {
  const scope = {
    projectId: basename(dirname(dirname(path))),
    worktreeId: basename(path, '.json'),
  };
  if ('tabs' in value)
    await getChatStateService().replaceCompatibilityTabs(scope, value, {
      authoritative: true,
    });
  else
    await getChatStateService().replaceCompatibilityArchives(scope, value, {
      authoritative: true,
    });
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('ChatSearchService', () => {
  let dataDir: string;
  let service: ChatSearchService;
  let originalDataDir: string | undefined;
  let broadcastUpdated: jest.Mock;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'chat-search-index-'));
    originalDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = dataDir;
    resetResolvedCanopyDataDirForTests();
    resetChatStateServiceForTests();
    broadcastUpdated = jest.fn();
    mockGetAllWindows.mockReset();
    mockGetAllWindows.mockReturnValue([]);
    mockedReadFile.mockImplementation(actualFsPromises.readFile);
    mockedStat.mockImplementation(actualFsPromises.stat);
    service = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      debounceMs: 60_000,
      broadcastDebounceMs: 10,
      broadcastUpdated,
    });
  });

  afterEach(async () => {
    await service.close();
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    resetResolvedCanopyDataDirForTests();
  });

  it('replaces a failed index worker and rescans instead of staying stopped', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const fakes: FakeThreadedIndexer[] = [];
    const recovering = new ChatSearchService({
      threadedIndexerFactory: (): ThreadedChatSearchIndexer => {
        const fake = fakeThreadedIndexer(fakes.length === 0);
        fakes.push(fake);
        return fake.indexer;
      },
      dbPath: join(dataDir, 'recovering.sqlite'),
      debounceMs: 60_000,
      broadcastDebounceMs: 10,
      broadcastUpdated,
    });
    try {
      recovering.indexLiveTabs(
        'workspace-1',
        'worktree-1',
        tabsFile(makeTab('before', 'Before', [textBlock('first')])),
      );
      await expect(recovering.flushPendingUpdates()).rejects.toThrow(
        'Search index worker timed out',
      );
      expect(fakes).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(
        CHAT_SEARCH_INDEXER_RECOVERY_DELAY_MS,
      );

      recovering.indexLiveTabs(
        'workspace-1',
        'worktree-1',
        tabsFile(makeTab('after', 'After', [textBlock('second')])),
      );
      await recovering.flushPendingUpdates();
      expect(fakes).toHaveLength(2);
      expect(fakes[1]?.stagedDocIds).toContain('after');
    } finally {
      await recovering.close();
      consoleError.mockRestore();
      jest.useRealTimers();
    }
  });

  it('indexes inline tool-output previews without hydrating deferred middles', async () => {
    const scope = { projectId: 'workspace-full', worktreeId: 'worktree-full' };
    const tab = makeTab('full-chat', 'Full transcript', [
      {
        type: 'tool_result',
        toolUseId: 'read',
        toolName: 'Read',
        isError: false,
        output:
          'prefix '.repeat(12000) +
          'artifactmiddleneedle' +
          'suffix '.repeat(12000),
      },
    ]);
    await getChatStateService().replaceCompatibilityTabs(scope, tabsFile(tab), {
      authoritative: true,
    });
    const canonical = await getChatStateService().getCompatibilityTabs(scope);
    service.indexLiveTabs(scope.projectId, scope.worktreeId, canonical);
    await service.flushPendingUpdates();
    expect(service.query({ query: 'prefix' }).map((row) => row.chatId)).toEqual(
      ['full-chat'],
    );
    expect(service.query({ query: 'artifactmiddleneedle' })).toEqual([]);
  });

  it('probes migrated large-body search writes across scan, query, and append', async () => {
    const scope = {
      projectId: 'search-write-probe',
      worktreeId: 'live',
    };
    const chatId = 'large-body';
    const dbPath = join(dataDir, 'search-write-probe.sqlite');
    const livePath = join(
      dataDir,
      'workspaces',
      scope.projectId,
      'chats',
      `${scope.worktreeId}.json`,
    );
    const requestedBodyBytes = Number(
      process.env.CANOPY_SEARCH_WRITE_PROBE_BYTES ?? 1_200_000,
    );
    const prefix = 'Chat search indexing benchmark body. ';
    const suffix = ' chatsearchinitialneedle';
    const body = `${prefix
      .repeat(Math.ceil((requestedBodyBytes - suffix.length) / prefix.length))
      .slice(0, Math.max(0, requestedBodyBytes - suffix.length))}${suffix}`;
    const messages: PersistedChatMessage[] = Array.from(
      { length: Math.ceil(body.length / 8_000_000) },
      (_, index) => ({
        id: `large-body-${index}`,
        role: 'assistant',
        timestamp: 1_700_000_001_000 + index,
        blocks: [
          textBlock(body.slice(index * 8_000_000, (index + 1) * 8_000_000)),
        ],
      }),
    );
    const initial: PersistedChatTab = {
      ...makeTab(chatId, 'Large body'),
      messages,
    };
    const foreground: PersistedChatTab = {
      ...makeTab('foreground', 'Foreground chat'),
      messages: [],
    };
    await writeJson(livePath, tabsFile(foreground, initial));
    const state = getChatStateService();
    const migrated = await state.getCompatibilityTabs(scope);

    await service.close();
    service = new ChatSearchService({
      dbPath,
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      debounceMs: 60_000,
      broadcastUpdated,
    });
    const staged = jest.spyOn(ChatSearchIndexer.prototype, 'stageScopeDoc');
    const upserted = jest.spyOn(ChatSearchIndexer.prototype, 'upsertDoc');
    const cached = jest.spyOn(
      ChatSearchIndexer.prototype,
      'getIndexedBodiesIfTranscriptUnchanged',
    );
    const metadata = jest.spyOn(
      ChatSearchIndexer.prototype,
      'updateDocMetadataIfTranscriptUnchanged',
    );
    try {
      await service.scanAllSources();
      const walAfterScan = (await stat(`${dbPath}-wal`)).size;
      expect(
        service
          .query({ query: 'chatsearchinitialneedle' })
          .map((row) => row.chatId),
      ).toEqual([chatId]);

      await state.updateCompatibilityTab(scope, chatId, (current) => ({
        ...current,
        messages: [
          ...current.messages,
          {
            id: 'appended-search-message',
            role: 'user',
            timestamp: 1_700_000_002_000,
            blocks: [textBlock('chatsearchappendneedle')],
          },
        ],
      }));
      const changed = await state.getCompatibilityTabs(scope);
      service.indexLiveTabChanges(
        scope.projectId,
        scope.worktreeId,
        changed,
        [chatId],
        [],
      );
      await service.flushPendingUpdates();
      const walAfterAppend = (await stat(`${dbPath}-wal`)).size;
      expect(
        service
          .query({ query: 'chatsearchappendneedle' })
          .map((row) => row.chatId),
      ).toEqual([chatId]);

      const checkpointDb = new DatabaseSync(dbPath);
      let checkpoint: unknown;
      try {
        checkpoint = checkpointDb
          .prepare('PRAGMA wal_checkpoint(PASSIVE)')
          .get();
      } finally {
        checkpointDb.close();
      }
      process.stdout.write(
        `${JSON.stringify({
          kind: 'search-write-probe',
          requestedBodyBytes,
          incomingDigestOnMigration:
            migrated.tabs.find((tab) => tab.id === chatId)?.transcript
              ?.committedDigest !== undefined,
          incomingDigestOnAppend:
            changed.tabs.find((tab) => tab.id === chatId)?.transcript
              ?.committedDigest !== undefined,
          stagedBodies: staged.mock.calls.map(([, , doc]) => ({
            bytes: Buffer.byteLength(doc.body),
            fingerprint: doc.transcriptFingerprint,
          })),
          upsertedBodies: upserted.mock.calls.map(([doc]) => ({
            bytes: Buffer.byteLength(doc.body),
            fingerprint: doc.transcriptFingerprint,
          })),
          indexedBodyRequests: cached.mock.calls.map(
            ([, fingerprint]) => fingerprint,
          ),
          metadataAttempts: metadata.mock.calls.length,
          walAfterScan,
          walAfterAppend,
          checkpoint,
        })}\n`,
      );
      expect(staged).toHaveBeenCalledTimes(2);
      expect(upserted).toHaveBeenCalledTimes(1);
    } finally {
      staged.mockRestore();
      upserted.mockRestore();
      cached.mockRestore();
      metadata.mockRestore();
    }
  }, 120_000);

  it('fills limited catalog and query pages past stale hidden rows', async () => {
    const hidden = makeTab('hidden-chat', 'Hidden ranked first', [
      textBlock('pagingneedle pagingneedle pagingneedle'),
    ]);
    hidden.messages = hidden.messages.map((message) => ({
      ...message,
      timestamp: message.timestamp + 10_000,
    }));
    const visible = makeTab('visible-chat', 'Visible ranked second', [
      textBlock('pagingneedle'),
    ]);
    service.indexLiveTabs(
      'workspace-page-visibility',
      'hidden-worktree',
      tabsFile(hidden),
    );
    service.indexLiveTabs(
      'workspace-page-visibility',
      'visible-worktree',
      tabsFile(visible),
    );
    await service.flushPendingUpdates();

    const deleteFailure = jest
      .spyOn(ChatSearchIndexer.prototype, 'deleteWorktreeDocs')
      .mockRejectedValueOnce(new Error('derived cleanup unavailable'));
    await expect(
      service.worktreeContainerArchived(
        'workspace-page-visibility',
        'hidden-worktree',
      ),
    ).rejects.toThrow('derived cleanup unavailable');
    deleteFailure.mockRestore();
    service.archivedContainerUpdated(
      'workspace-page-visibility',
      'hidden-worktree',
    );

    expect(service.getCatalog(1).map((entry) => entry.chatId)).toEqual([
      visible.id,
    ]);
    expect(
      service
        .query({ query: 'pagingneedle', limit: 1 })
        .map((entry) => entry.chatId),
    ).toEqual([visible.id]);
  });

  it('scopes main-side catalog and transcript search to the selected context', async () => {
    const organizationAId = '11111111-1111-4111-8111-111111111111';
    const organizationBId = '22222222-2222-4222-8222-222222222222';
    const owners = new Map([
      [
        'workspace-org-a',
        { type: 'organization' as const, organizationId: organizationAId },
      ],
      [
        'workspace-org-b',
        { type: 'organization' as const, organizationId: organizationBId },
      ],
    ]);
    await service.close();
    service = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      debounceMs: 60_000,
      broadcastDebounceMs: 10,
      broadcastUpdated,
      resolveWorkspaceOwner: (
        workspaceId,
      ): Promise<
        { type: 'organization'; organizationId: string } | undefined
      > => Promise.resolve(owners.get(workspaceId)),
    });
    const organizationATab = makeTab('chat-a', 'Needle in organization A');
    const organizationBTab = makeTab('chat-b', 'Needle in organization B');
    organizationBTab.messages = organizationBTab.messages.map((message) => ({
      ...message,
      timestamp: message.timestamp + 20_000,
    }));
    const personalTab = makeTab('chat-personal', 'Needle in Personal');
    personalTab.messages = personalTab.messages.map((message) => ({
      ...message,
      timestamp: message.timestamp + 10_000,
    }));
    service.indexLiveTabs(
      'workspace-org-a',
      'worktree-a',
      tabsFile(organizationATab),
    );
    service.indexLiveTabs(
      'workspace-org-b',
      'worktree-b',
      tabsFile(organizationBTab),
    );
    service.indexLiveTabs(
      'workspace-personal',
      'worktree-personal',
      tabsFile(personalTab),
    );
    await service.flushPendingUpdates();

    await expect(
      service.getCatalogScoped(
        {
          kind: 'organization',
          organizationId: organizationAId,
        },
        1,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ projectId: 'workspace-org-a' }),
    ]);
    await expect(
      service.queryResponsive(
        { query: 'needle' },
        { kind: 'organization', organizationId: organizationBId },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ projectId: 'workspace-org-b' }),
    ]);
    await expect(
      service.getCatalogScoped({ kind: 'personal' }),
    ).resolves.toEqual([
      expect.objectContaining({ projectId: 'workspace-personal' }),
    ]);
    await expect(
      service.getCatalogScoped(
        {
          kind: 'organization',
          organizationId: organizationAId,
        },
        undefined,
        ['workspace-personal'],
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: 'workspace-org-a' }),
        expect.objectContaining({ projectId: 'workspace-personal' }),
      ]),
    );

    expect(
      (await service.queryResponsive({ query: 'needle' }, undefined))
        .map((entry) => entry.projectId)
        .sort(),
    ).toEqual(['workspace-org-a', 'workspace-org-b', 'workspace-personal']);
  });

  it('keeps App Advisor global but hides workspaces whose owner cannot be established', async () => {
    const organizationAId = '11111111-1111-4111-8111-111111111111';
    const organizationBId = '22222222-2222-4222-8222-222222222222';
    await writeJson(
      join(dataDir, 'workspaces', 'workspace-org-a', 'workspace.json'),
      {
        version: 1,
        type: 'single-repo',
        repoPath: join(dataDir, 'repo-a'),
        repos: [],
        owner: {
          type: 'organization',
          organizationId: organizationAId,
          projectId: '33333333-3333-4333-8333-333333333333',
          instanceId: '44444444-4444-4444-8444-444444444444',
          bindingGeneration: 0,
        },
      },
    );
    await writeJson(
      join(dataDir, 'workspaces', 'workspace-personal', 'workspace.json'),
      {
        version: 1,
        type: 'single-repo',
        repoPath: join(dataDir, 'repo-personal'),
        repos: [],
      },
    );
    await mkdir(join(dataDir, 'workspaces', 'workspace-unreadable'), {
      recursive: true,
    });
    await writeFile(
      join(dataDir, 'workspaces', 'workspace-unreadable', 'workspace.json'),
      '{',
      'utf8',
    );
    await writeJson(
      join(dataDir, 'workspaces', 'workspace-malformed', 'workspace.json'),
      {
        version: 1,
        type: 'single-repo',
        repoPath: join(dataDir, 'repo-malformed'),
        repos: [],
        owner: { type: 'organization', organizationId: organizationBId },
      },
    );
    service.indexLiveTabs(
      'workspace-org-a',
      'worktree-a',
      tabsFile(makeTab('chat-a', 'Needle in organization A')),
    );
    service.indexLiveTabs(
      'workspace-personal',
      'worktree-personal',
      tabsFile(makeTab('chat-personal', 'Needle in Personal')),
    );
    service.indexLiveTabs(
      APP_ADVISOR_PROJECT_ID,
      APP_ADVISOR_WORKTREE_ID,
      tabsFile(makeTab('chat-advisor', 'Needle in App Advisor')),
    );
    service.indexLiveTabs(
      'workspace-without-config',
      'worktree-orphan',
      tabsFile(makeTab('chat-orphan', 'Needle without a workspace')),
    );
    service.indexLiveTabs(
      'workspace-unreadable',
      'worktree-unreadable',
      tabsFile(makeTab('chat-unreadable', 'Needle with unreadable ownership')),
    );
    service.indexLiveTabs(
      'workspace-malformed',
      'worktree-malformed',
      tabsFile(makeTab('chat-malformed', 'Needle with malformed ownership')),
    );
    await service.flushPendingUpdates();

    const projectIds = (entries: { projectId: string }[]): string[] =>
      entries.map((entry) => entry.projectId).sort();
    expect(
      projectIds(
        await service.getCatalogScoped({
          kind: 'organization',
          organizationId: organizationAId,
        }),
      ),
    ).toEqual([APP_ADVISOR_PROJECT_ID, 'workspace-org-a']);
    expect(
      projectIds(
        await service.queryResponsive(
          { query: 'needle' },
          { kind: 'organization', organizationId: organizationBId },
        ),
      ),
    ).toEqual([APP_ADVISOR_PROJECT_ID]);
    expect(
      projectIds(await service.getCatalogScoped({ kind: 'personal' })),
    ).toEqual([APP_ADVISOR_PROJECT_ID, 'workspace-personal']);

    expect(projectIds(await service.getCatalogScoped(undefined))).toContain(
      'workspace-without-config',
    );
  });

  it('updates canonical search metadata without rereading an unchanged transcript', async () => {
    const scope = {
      projectId: 'workspace-metadata',
      worktreeId: 'worktree-metadata',
    };
    const state = getChatStateService();
    const tab = makeTab('metadata-chat', 'Original searchable title', [
      {
        type: 'tool_result',
        toolUseId: 'read',
        toolName: 'Read',
        isError: false,
        output:
          'prefix '.repeat(12000) +
          'artifactmiddleneedle' +
          'suffix '.repeat(12000),
      },
    ]);
    await state.replaceCompatibilityTabs(scope, tabsFile(tab), {
      authoritative: true,
    });
    service.indexLiveTabs(
      scope.projectId,
      scope.worktreeId,
      await state.getCompatibilityTabs(scope),
    );
    await service.flushPendingUpdates();
    await service.close();
    service = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      debounceMs: 60_000,
      broadcastUpdated,
    });
    const consume = jest.spyOn(state, 'consumeTranscriptPreview');
    try {
      await state.updateCompatibilityTab(
        scope,
        tab.id,
        (current) => ({
          ...current,
          title: 'Renamed searchable title',
          customTitle: 'Zebracorn',
          description: 'Updated description',
          unread: true,
        }),
        undefined,
        { metadataOnly: true },
      );
      service.indexLiveTabChanges(
        scope.projectId,
        scope.worktreeId,
        await state.getCompatibilityTabs(scope),
        [tab.id],
        [],
      );
      await service.flushPendingUpdates();
      expect(consume).not.toHaveBeenCalled();
      expect(
        service
          .getCatalog()
          .filter((entry) => entry.title === 'Zebracorn')
          .map((entry) => entry.chatId),
      ).toEqual([tab.id]);
      expect(service.query({ query: 'prefix' })).toEqual([
        expect.objectContaining({
          chatId: tab.id,
          title: 'Zebracorn',
        }),
      ]);
      expect(service.getCatalog()).toEqual([
        expect.objectContaining({
          title: 'Zebracorn',
          description: 'Updated description',
        }),
      ]);
      await state.updateCompatibilityTab(scope, tab.id, (current) => ({
        ...current,
        messages: [
          ...current.messages,
          {
            id: 'new-response',
            role: 'assistant',
            timestamp: 1_700_000_002_000,
            blocks: [{ type: 'text', text: 'newcontentneedle' }],
          },
        ],
      }));
      service.indexLiveTabChanges(
        scope.projectId,
        scope.worktreeId,
        await state.getCompatibilityTabs(scope),
        [tab.id],
        [],
      );
      await service.flushPendingUpdates();
      expect(consume).toHaveBeenCalledTimes(1);
      expect(service.query({ query: 'newcontentneedle' })).toHaveLength(1);
    } finally {
      consume.mockRestore();
    }
  });

  it('re-projects active-sidecar edits and removal with an unchanged committed prefix', async () => {
    const scope = {
      projectId: 'workspace-active',
      worktreeId: 'worktree-active',
    };
    const describeTab = (
      committedMessageCount: number,
      committedByteLength: number,
      transcriptRevision: number,
      hasActiveSidecar: boolean,
      messageCount: number,
      committedDigest = 'a'.repeat(64),
    ): PersistedChatTab => ({
      ...makeTab('active-chat', 'Streaming chat'),
      messages: [],
      transcript: {
        format: 'complete-message-jsonl-v1',
        committedMessageCount,
        committedByteLength,
        transcriptRevision,
        hasActiveSidecar,
        messageCount,
        committedDigest,
      },
    });
    let body = 'Assistant: committed prefix needle';
    let projectedTab = describeTab(2, 100, 2, false, 2);
    const consume = jest
      .spyOn(getChatStateService(), 'consumeTranscriptPreview')
      .mockImplementation((_scope, _chatId, project) => {
        const descriptor = projectedTab.transcript;
        if (!descriptor)
          throw new Error('Missing mocked transcript descriptor');
        return project(
          projectedMessage({
            id: 'projected',
            role: 'assistant',
            timestamp: 1,
            blocks: [textBlock(body)],
          }),
          descriptor,
          { committedIncluded: true },
        );
      });
    const index = async (tab: PersistedChatTab): Promise<void> => {
      projectedTab = tab;
      service.indexLiveTabs(scope.projectId, scope.worktreeId, tabsFile(tab));
      await service.flushPendingUpdates();
    };
    try {
      await index(describeTab(2, 100, 2, false, 2));
      expect(consume).toHaveBeenCalledTimes(1);
      body = 'Assistant: first staged needle';
      await index(describeTab(2, 100, 3, true, 3));
      expect(service.query({ query: 'first staged needle' })).toHaveLength(1);
      body = 'Assistant: replacement staged needle';
      await index(describeTab(2, 100, 4, true, 3));
      expect(service.query({ query: 'first staged needle' })).toEqual([]);
      expect(
        service.query({ query: 'replacement staged needle' }),
      ).toHaveLength(1);
      body = 'Assistant: committed prefix needle';
      await index(describeTab(2, 100, 5, false, 2));
      expect(service.query({ query: 'replacement staged needle' })).toEqual([]);
      expect(service.query({ query: 'prefix needle' })).toHaveLength(1);
      expect(consume).toHaveBeenCalledTimes(4);
      body = `${body}\n\nAssistant: settled tail needle`;
      await index(describeTab(3, 180, 6, false, 3));
      expect(consume).toHaveBeenCalledTimes(5);
      expect(service.query({ query: 'settled tail' })).toHaveLength(1);
      // A rewrite that keeps the message count but changes the bytes is a
      // transcript edit and must take the full projection path.
      await index(describeTab(3, 170, 7, false, 3));
      expect(consume).toHaveBeenCalledTimes(6);
    } finally {
      consume.mockRestore();
    }
  });

  it('re-indexes only in-flight text while the active sidecar changes', async () => {
    // Active-sidecar revisions arrive at every pause in a turn. Re-reading the
    // committed transcript and rewriting its FTS row for each one cost
    // O(transcript) per revision (a 2h45m turn streamed over a 194 MB
    // transcript whose search text was 9.2 million characters). While the
    // committed prefix identity is unchanged, only the active rows may be read
    // and only the in-flight FTS row may be replaced.
    const scope = {
      projectId: 'workspace-active-cost',
      worktreeId: 'worktree-active-cost',
    };
    const describeTab = (
      committedMessageCount: number,
      committedByteLength: number,
      transcriptRevision: number,
      hasActiveSidecar: boolean,
      committedDigest: string,
    ): PersistedChatTab => ({
      ...makeTab('active-cost-chat', 'Streaming cost chat'),
      messages: [],
      transcript: {
        format: 'complete-message-jsonl-v1',
        committedMessageCount,
        committedByteLength,
        transcriptRevision,
        hasActiveSidecar,
        messageCount: committedMessageCount + (hasActiveSidecar ? 1 : 0),
        committedDigest,
      },
    });
    const textMessage = (
      id: string,
      role: PersistedChatMessage['role'],
      text: string,
    ): PersistedChatMessage => ({
      id,
      role,
      timestamp: 1,
      blocks: [textBlock(text)],
    });
    async function* rows(
      messages: PersistedChatMessage[],
    ): AsyncGenerator<PersistedChatMessage> {
      for (const message of messages) yield await Promise.resolve(message);
    }
    let committed = [
      textMessage('question', 'user', 'committed question needle'),
      textMessage('answer', 'assistant', 'committed answer needle'),
    ];
    let active: PersistedChatMessage[] = [];
    let projectedTab = describeTab(2, 100, 1, false, 'a'.repeat(64));
    let committedReads = 0;
    const consume = jest
      .spyOn(getChatStateService(), 'consumeTranscriptPreview')
      .mockImplementation((_scope, _chatId, project, _isCurrent, options) => {
        const descriptor = projectedTab.transcript;
        if (!descriptor)
          throw new Error('Missing mocked transcript descriptor');
        const reuse = options?.reuseCommittedPrefix?.(descriptor) === true;
        if (!reuse) committedReads += 1;
        return project(
          rows(reuse ? active : [...committed, ...active]),
          descriptor,
          { committedIncluded: !reuse },
        );
      });
    const fullWrites = jest.spyOn(ChatSearchIndexer.prototype, 'upsertDoc');
    // Production commits publish a per-chat delta.
    const index = async (tab: PersistedChatTab): Promise<void> => {
      projectedTab = tab;
      service.indexLiveTabChanges(
        scope.projectId,
        scope.worktreeId,
        tabsFile(tab),
        [tab.id],
        [],
      );
      await service.flushPendingUpdates();
    };
    try {
      await index(describeTab(2, 100, 1, false, 'a'.repeat(64)));
      expect(committedReads).toBe(1);
      expect(fullWrites).toHaveBeenCalledTimes(1);

      active = [textMessage('draft', 'assistant', 'first draft needle')];
      await index(describeTab(2, 100, 2, true, 'a'.repeat(64)));
      active = [textMessage('draft', 'assistant', 'second draft needle')];
      await index(describeTab(2, 100, 3, true, 'a'.repeat(64)));
      expect(committedReads).toBe(1);
      expect(fullWrites).toHaveBeenCalledTimes(1);
      expect(service.query({ query: 'first draft needle' })).toEqual([]);
      expect(service.query({ query: 'second draft needle' })).toHaveLength(1);
      expect(
        service.query({ query: 'committed question needle' }),
      ).toHaveLength(1);
      // Committed and in-flight rows both match; the chat is listed once.
      expect(
        service.query({ query: 'needle' }).map((row) => row.chatId),
      ).toEqual(['active-cost-chat']);

      // An aborted turn drops the sidecar without committing: its in-flight
      // text leaves the index, still without a committed read or rewrite.
      active = [];
      await index(describeTab(2, 100, 4, false, 'a'.repeat(64)));
      expect(committedReads).toBe(1);
      expect(fullWrites).toHaveBeenCalledTimes(1);
      expect(service.query({ query: 'second draft needle' })).toEqual([]);

      // Settling a turn changes the committed prefix: one full read and write.
      active = [textMessage('draft', 'assistant', 'third draft needle')];
      await index(describeTab(2, 100, 5, true, 'a'.repeat(64)));
      committed = [
        ...committed,
        textMessage('settled', 'assistant', 'settled reply needle'),
      ];
      active = [];
      await index(describeTab(3, 160, 6, false, 'b'.repeat(64)));
      expect(committedReads).toBe(2);
      expect(fullWrites).toHaveBeenCalledTimes(2);
      expect(service.query({ query: 'third draft needle' })).toEqual([]);
      expect(service.query({ query: 'settled reply needle' })).toHaveLength(1);
      expect(consume).toHaveBeenCalledTimes(6);
    } finally {
      consume.mockRestore();
      fullWrites.mockRestore();
    }
  });

  it('projects the whole transcript when an active-only preview refuses a changed committed log', async () => {
    // The active-only read never checks committed bytes, so it refuses any
    // committed file that changed after capture. That refusal must fall back
    // to a full projection, not drop the chat's in-flight text or fail the
    // batch of live updates it arrived in.
    const scope = {
      projectId: 'workspace-active-refused',
      worktreeId: 'worktree-active-refused',
    };
    const describeTab = (
      transcriptRevision: number,
      hasActiveSidecar: boolean,
    ): PersistedChatTab => ({
      ...makeTab('active-refused-chat', 'Refused preview chat'),
      messages: [],
      transcript: {
        format: 'complete-message-jsonl-v1',
        committedMessageCount: 1,
        committedByteLength: 80,
        transcriptRevision,
        hasActiveSidecar,
        messageCount: hasActiveSidecar ? 2 : 1,
        committedDigest: 'c'.repeat(64),
      },
    });
    const committed: PersistedChatMessage = {
      id: 'question',
      role: 'user',
      timestamp: 1,
      blocks: [textBlock('committed refusal needle')],
    };
    let active: PersistedChatMessage[] = [];
    async function* rows(
      messages: PersistedChatMessage[],
    ): AsyncGenerator<PersistedChatMessage> {
      for (const message of messages) yield await Promise.resolve(message);
    }
    let projectedTab = describeTab(1, false);
    const reads: Array<'active-only' | 'full'> = [];
    const consume = jest
      .spyOn(getChatStateService(), 'consumeTranscriptPreview')
      .mockImplementation((_scope, _chatId, project, _isCurrent, options) => {
        const descriptor = projectedTab.transcript;
        if (!descriptor)
          throw new Error('Missing mocked transcript descriptor');
        if (options?.reuseCommittedPrefix?.(descriptor) === true) {
          reads.push('active-only');
          return Promise.reject(
            new ChatTranscriptIntegrityError(
              'Transcript preview changed during read',
            ),
          );
        }
        reads.push('full');
        return project(rows([committed, ...active]), descriptor, {
          committedIncluded: true,
        });
      });
    const index = async (tab: PersistedChatTab): Promise<void> => {
      projectedTab = tab;
      service.indexLiveTabChanges(
        scope.projectId,
        scope.worktreeId,
        tabsFile(tab),
        [tab.id],
        [],
      );
      await service.flushPendingUpdates();
    };
    try {
      await index(describeTab(1, false));
      active = [
        {
          id: 'draft',
          role: 'assistant',
          timestamp: 2,
          blocks: [textBlock('refused draft needle')],
        },
      ];
      await index(describeTab(2, true));

      expect(reads).toEqual(['full', 'active-only', 'full']);
      expect(
        service.query({ query: 'refused draft needle' }).map((r) => r.chatId),
      ).toEqual(['active-refused-chat']);
      expect(service.query({ query: 'committed refusal needle' })).toHaveLength(
        1,
      );
    } finally {
      consume.mockRestore();
    }
  });

  it('re-projects a live transcript whose committed digest changes at equal length', async () => {
    const scope = {
      projectId: 'workspace-digest',
      worktreeId: 'worktree-digest',
    };
    const describeTab = (
      transcriptRevision: number,
      hasActiveSidecar: boolean,
      committedDigest: string,
    ): PersistedChatTab => ({
      ...makeTab('digest-chat', 'Edited chat'),
      messages: [],
      transcript: {
        format: 'complete-message-jsonl-v1',
        committedMessageCount: 2,
        committedByteLength: 100,
        transcriptRevision,
        hasActiveSidecar,
        messageCount: 2,
        committedDigest,
      },
    });
    let body = 'Assistant: original same-length needle';
    let projectedTab = describeTab(2, false, 'a'.repeat(64));
    const consume = jest
      .spyOn(getChatStateService(), 'consumeTranscriptPreview')
      .mockImplementation((_scope, _chatId, project) => {
        const descriptor = projectedTab.transcript;
        if (!descriptor)
          throw new Error('Missing mocked transcript descriptor');
        return project(
          projectedMessage({
            id: 'projected',
            role: 'assistant',
            timestamp: 1,
            blocks: [textBlock(body)],
          }),
          descriptor,
          { committedIncluded: true },
        );
      });
    const index = async (tab: PersistedChatTab): Promise<void> => {
      projectedTab = tab;
      service.indexLiveTabChanges(
        scope.projectId,
        scope.worktreeId,
        tabsFile(tab),
        [tab.id],
        [],
      );
      await service.flushPendingUpdates();
    };
    try {
      await index(describeTab(2, false, 'a'.repeat(64)));
      expect(consume).toHaveBeenCalledTimes(1);
      // Active-sidecar revisions can change the preview even when the
      // committed digest is stable.
      await index(describeTab(3, true, 'a'.repeat(64)));
      await index(describeTab(4, true, 'a'.repeat(64)));
      expect(consume).toHaveBeenCalledTimes(3);
      // A same-length in-place edit changes only the digest; the indexed
      // body is stale and must be projected again.
      body = 'Assistant: replaced same-length needle';
      await index(describeTab(5, false, 'b'.repeat(64)));
      expect(consume).toHaveBeenCalledTimes(4);
      expect(
        service
          .query({ query: 'replaced same-length' })
          .map((row) => row.chatId),
      ).toEqual(['digest-chat']);
      expect(service.query({ query: 'original same-length' })).toEqual([]);
    } finally {
      consume.mockRestore();
    }
  });

  it('re-projects legacy live descriptors without a committed digest', async () => {
    const scope = { projectId: 'legacy-digest', worktreeId: 'scope' };
    const tab: PersistedChatTab = {
      ...makeTab('legacy-chat', 'Legacy search'),
      messages: [],
      transcript: {
        format: 'complete-message-jsonl-v1',
        committedMessageCount: 1,
        committedByteLength: 100,
        transcriptRevision: 1,
        hasActiveSidecar: false,
      },
    };
    let body = 'first legacy body needle';
    const consume = jest
      .spyOn(getChatStateService(), 'consumeTranscriptPreview')
      .mockImplementation((_scope, _chatId, project) => {
        if (!tab.transcript) throw new Error('Missing legacy descriptor');
        return project(
          projectedMessage({
            id: 'legacy-body',
            role: 'assistant',
            timestamp: 1,
            blocks: [textBlock(body)],
          }),
          { ...tab.transcript, committedDigest: 'a'.repeat(64) },
          { committedIncluded: true },
        );
      });
    try {
      for (const text of [
        'first legacy body needle',
        'fresh legacy body needle',
      ]) {
        body = text;
        service.indexLiveTabChanges(
          scope.projectId,
          scope.worktreeId,
          tabsFile(tab),
          [tab.id],
          [],
        );
        await service.flushPendingUpdates();
      }
      expect(consume).toHaveBeenCalledTimes(2);
      expect(service.query({ query: 'fresh legacy body needle' })).toHaveLength(
        1,
      );
      expect(service.query({ query: 'first legacy body needle' })).toEqual([]);
    } finally {
      consume.mockRestore();
    }
  });

  it('reuses indexed archive bodies whose committed transcript is unchanged', async () => {
    const archivePath = join(
      dataDir,
      'workspaces',
      'workspace-1',
      'chat-archives',
      'worktree-1.json',
    );
    const tab = makeTab('archived-chat', 'Archived chat', [
      textBlock('archived body needle'),
    ]);
    await writeCanonical(archivePath, {
      version: 1,
      archived: [{ tab, archivedAt: '2026-02-01T00:00:00.000Z', turnCount: 1 }],
    });
    const consume = jest.spyOn(
      getChatStateService(),
      'consumeTranscriptPreview',
    );
    try {
      service.indexWorktreeArchives('workspace-1', 'worktree-1');
      await service.flushPendingUpdates();
      expect(consume).toHaveBeenCalledTimes(1);
      service.indexWorktreeArchives('workspace-1', 'worktree-1');
      await service.flushPendingUpdates();
      expect(consume).toHaveBeenCalledTimes(1);
      expect(
        service
          .query({ query: 'archived body needle' })
          .map((row) => [row.chatId, row.source]),
      ).toEqual([['archived-chat', 'worktree-archive']]);
    } finally {
      consume.mockRestore();
    }
  });

  it('indexes role-prefixed text and inline tool-result previews without private blocks', async () => {
    const tab = makeTab('chat-1', 'Text only', [
      textBlock('Searchable prose'),
      { type: 'thinking', text: 'private-thought-token' },
      {
        type: 'tool_use',
        toolUseId: 'tool-1',
        toolName: 'Read',
        input: 'private-tool-token',
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        toolName: 'Read',
        output: 'private-result-token',
        isError: false,
      },
    ]);

    expect(extractChatSearchBody(tab.messages)).toContain(
      'User: Searchable prose',
    );
    expect(extractChatSearchBody(tab.messages)).toContain(
      'Searchable prose\nprivate-result-token',
    );
    expect(extractChatSearchBody(tab.messages)).not.toContain(
      'private-thought-token',
    );
    expect(extractChatSearchBody(tab.messages)).not.toContain(
      'private-tool-token',
    );
    expect(
      extractChatSearchBody([
        {
          ...tab.messages[0],
          role: 'system',
          blocks: [textBlock('private-system-token')],
        },
      ]),
    ).not.toContain('private-system-token');
    expect(
      extractChatSearchBody([
        {
          ...tab.messages[0],
          hidden: true,
          blocks: [textBlock('private-hidden-token')],
        },
      ]),
    ).not.toContain('private-hidden-token');

    service.indexLiveTabs('workspace-1', 'worktree-1', tabsFile(tab));
    await service.flushPendingUpdates();

    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Text only',
        description: 'Description for Text only',
        providerType: 'claude',
        messageCount: 2,
      }),
    ]);
    expect(service.query({ query: 'Searchable' })).toHaveLength(1);
    expect(service.query({ query: 'private thought token' })).toEqual([]);
    expect(service.query({ query: 'private tool token' })).toEqual([]);
    expect(service.query({ query: 'private result token' })).toHaveLength(1);
  });

  it('applies exact live-tab deltas during partial persistence updates', async () => {
    const changed = makeTab('changed-chat', 'Changed chat', [
      textBlock('actively changing search body'),
    ]);
    const inactive = makeTab('inactive-chat', 'Inactive chat', [
      textBlock('large unchanged search body'),
    ]);
    const removed = makeTab('removed-chat', 'Removed chat', [
      textBlock('removed search body'),
    ]);
    const initial = tabsFile(inactive);
    initial.tabs.push(removed);
    service.indexLiveTabs('workspace-1', 'worktree-1', initial);
    await service.flushPendingUpdates();

    const file = tabsFile(changed);
    file.tabs.push(inactive);

    service.indexLiveTabChanges(
      'workspace-1',
      'worktree-1',
      file,
      ['changed-chat'],
      ['removed-chat'],
    );
    await service.flushPendingUpdates();

    expect(service.query({ query: 'actively changing' })).toHaveLength(1);
    expect(service.query({ query: 'large unchanged' })).toHaveLength(1);
    expect(service.query({ query: 'removed search' })).toEqual([]);
  });

  it('coalesces live-tab deltas queued within the debounce window', async () => {
    const first = makeTab('first-chat', 'First chat', [
      textBlock('first updated body'),
    ]);
    const second = makeTab('second-chat', 'Second chat', [
      textBlock('second updated body'),
    ]);
    const firstRemoved = makeTab('first-removed', 'First removed', [
      textBlock('first removed body'),
    ]);
    const secondRemoved = makeTab('second-removed', 'Second removed', [
      textBlock('second removed body'),
    ]);
    const initial = tabsFile(firstRemoved);
    initial.tabs.push(secondRemoved);
    service.indexLiveTabs('workspace-1', 'worktree-1', initial);
    await service.flushPendingUpdates();

    service.indexLiveTabChanges(
      'workspace-1',
      'worktree-1',
      tabsFile(first),
      [first.id],
      [firstRemoved.id],
    );
    service.indexLiveTabChanges(
      'workspace-1',
      'worktree-1',
      tabsFile(second),
      [second.id],
      [secondRemoved.id],
    );
    await service.flushPendingUpdates();

    expect(service.query({ query: 'first updated' })).toHaveLength(1);
    expect(service.query({ query: 'second updated' })).toHaveLength(1);
    expect(service.query({ query: 'first removed' })).toEqual([]);
    expect(service.query({ query: 'second removed' })).toEqual([]);
  });

  it('preserves a queued full reconciliation when a later delta arrives', async () => {
    const stale = makeTab('stale-chat', 'Stale chat', [
      textBlock('stale body before full reconciliation'),
    ]);
    const removed = makeTab('removed-chat', 'Removed chat', [
      textBlock('body removed by full reconciliation'),
    ]);
    const initial = tabsFile(stale);
    initial.tabs.push(removed);
    service.indexLiveTabs('workspace-1', 'worktree-1', initial);
    await service.flushPendingUpdates();

    const reconciled = makeTab('stale-chat', 'Reconciled chat', [
      textBlock('fresh body from full reconciliation'),
    ]);
    const changed = makeTab('changed-chat', 'Changed chat', [
      textBlock('body from the later delta'),
    ]);
    const latest = tabsFile(reconciled);
    latest.tabs.push(changed);

    service.indexLiveTabs('workspace-1', 'worktree-1', latest);
    service.indexLiveTabChanges(
      'workspace-1',
      'worktree-1',
      latest,
      [changed.id],
      [],
    );
    await service.flushPendingUpdates();

    expect(service.query({ query: 'fresh body' })).toHaveLength(1);
    expect(service.query({ query: 'later delta' })).toHaveLength(1);
    expect(service.query({ query: 'stale body' })).toEqual([]);
    expect(service.query({ query: 'removed by full' })).toEqual([]);
  });

  it('does not let a staged live rebuild replace a newer committed delta', async () => {
    const workspaceId = 'workspace-live-race';
    const worktreeId = 'worktree-live-race';
    const livePath = join(
      dataDir,
      'workspaces',
      workspaceId,
      'chats',
      `${worktreeId}.json`,
    );
    const stale = makeTab('chat-race', 'Stale live chat', [
      textBlock('stale staged search body'),
    ]);
    await writeJson(livePath, tabsFile(stale));
    const staleMetadata = await getChatStateService().getCompatibilityTabs({
      projectId: workspaceId,
      worktreeId,
    });
    let releaseRead = (): void => undefined;
    let markReadStarted = (): void => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const consume = jest
      .spyOn(getChatStateService(), 'consumeTranscriptPreview')
      .mockImplementationOnce(async (_scope, _chatId, project) => {
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
          markReadStarted();
        });
        const descriptor = staleMetadata.tabs[0].transcript;
        if (!descriptor)
          throw new Error('Missing mocked transcript descriptor');
        return project(
          projectedMessage({
            id: 'stale-body',
            role: 'assistant',
            timestamp: 1,
            blocks: [textBlock('stale staged search body')],
          }),
          descriptor,
          { committedIncluded: true },
        );
      });

    service.indexLiveTabs(workspaceId, worktreeId, staleMetadata);
    const staleFlush = service.flushPendingUpdates();
    await readStarted;
    const fresh = makeTab('chat-race', 'Fresh live chat', [
      textBlock('newly committed search body'),
    ]);
    service.indexLiveTabChanges(
      workspaceId,
      worktreeId,
      tabsFile(fresh),
      [fresh.id],
      [],
    );
    await service.flushPendingUpdates();
    const beforeRelease = service.query({ query: 'newly committed' });

    releaseRead();
    await staleFlush;
    const afterRelease = service.query({ query: 'newly committed' });
    const staleResults = service.query({ query: 'stale staged' });
    consume.mockRestore();

    expect(beforeRelease).toHaveLength(1);
    expect(afterRelease).toHaveLength(1);
    expect(staleResults).toEqual([]);
  }, 20_000);

  it('does not publish a staged live transcript after its worktree is deleted', async () => {
    const projectId = 'workspace-deleted-search-read';
    const worktreeId = 'worktree-deleted-search-read';
    const livePath = join(
      dataDir,
      'workspaces',
      projectId,
      'chats',
      `${worktreeId}.json`,
    );
    await writeJson(
      livePath,
      tabsFile(
        makeTab('chat-deleted-search-read', 'Deleted during search read', [
          textBlock('deleted generation needle'),
        ]),
      ),
    );
    const metadata = await getChatStateService().getCompatibilityTabs({
      projectId,
      worktreeId,
    });
    let releaseRead = (): void => undefined;
    let markReadStarted = (): void => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const consume = jest
      .spyOn(getChatStateService(), 'consumeTranscriptPreview')
      .mockImplementationOnce(async (_scope, _chatId, project) => {
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
          markReadStarted();
        });
        const descriptor = metadata.tabs[0].transcript;
        if (!descriptor)
          throw new Error('Missing mocked transcript descriptor');
        return project(
          projectedMessage({
            id: 'deleted-body',
            role: 'assistant',
            timestamp: 1,
            blocks: [textBlock('deleted generation needle')],
          }),
          descriptor,
          { committedIncluded: true },
        );
      });

    try {
      service.indexLiveTabs(projectId, worktreeId, metadata);
      const indexing = service.flushPendingUpdates();
      await readStarted;

      await service.deleteWorktreeDocs(projectId, worktreeId);
      expect(service.query({ query: 'deleted generation needle' })).toEqual([]);

      releaseRead();
      await indexing;
      expect(service.query({ query: 'deleted generation needle' })).toEqual([]);
      expect(
        service.getCatalog().filter((entry) => entry.worktreeId === worktreeId),
      ).toEqual([]);
    } finally {
      releaseRead();
      consume.mockRestore();
    }
  }, 20_000);

  it('transitions a chat from live to archived and back to live', async () => {
    const tab = {
      ...makeTab('chat-1', 'Transition chat'),
      customTitle: 'Zebracorn',
    };
    service.indexLiveTabs('workspace-1', 'worktree-1', tabsFile(tab));
    await service.flushPendingUpdates();

    const archivePath = join(
      dataDir,
      'workspaces',
      'workspace-1',
      'chat-archives',
      'worktree-1.json',
    );
    const archive: ArchivedChatsFile = {
      version: 1,
      archived: [
        {
          tab,
          archivedAt: '2026-02-01T00:00:00.000Z',
          turnCount: 1,
        },
      ],
    };
    await writeJson(archivePath, archive);
    service.worktreeChatArchived('workspace-1', 'worktree-1', tab.id);
    await service.flushPendingUpdates();

    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: tab.id,
        source: 'worktree-archive',
        title: 'Zebracorn',
      }),
    ]);

    expect(
      service
        .getCatalog()
        .filter((entry) => entry.title === 'Zebracorn')
        .map((entry) => entry.chatId),
    ).toEqual([tab.id]);
    const restored: PersistedChatTab = { ...tab };
    delete restored.customTitle;
    await writeCanonical(archivePath, { version: 1, archived: [] });
    service.worktreeChatRestored('workspace-1', 'worktree-1', restored);
    await service.flushPendingUpdates();

    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: tab.id,
        source: 'live',
        title: 'Transition chat',
      }),
    ]);
    expect(
      service.getCatalog().filter((entry) => entry.title === 'Zebracorn'),
    ).toEqual([]);
  });

  it('indexes tracked plans with review status and excludes hidden plans', async () => {
    service.indexWorktreePlans('workspace-1', 'worktree-1', [
      {
        id: 'plan-1',
        title: 'Search rollout plan',
        content: 'Ship the palindrome indexing milestone first.',
        reviewStatus: 'approved',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
      {
        id: 'plan-hidden',
        title: 'Hidden plan',
        content: 'invisible-plan-token',
        reviewStatus: 'pending',
        hidden: true,
      },
    ]);
    await service.flushPendingUpdates();

    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: 'plan-1',
        source: 'plan',
        title: 'Search rollout plan',
        reviewStatus: 'approved',
      }),
    ]);
    const contentHits = service.query({ query: 'palindrome indexing' });
    expect(contentHits).toEqual([
      expect.objectContaining({
        chatId: 'plan-1',
        source: 'plan',
      }),
    ]);
    expect(contentHits[0]?.snippet).toContain('palindrome');
    expect(service.query({ query: 'invisible plan token' })).toEqual([]);

    // The empty-file write (last plan deleted) clears the docs.
    service.indexWorktreePlans('workspace-1', 'worktree-1', []);
    await service.flushPendingUpdates();
    expect(service.getCatalog()).toEqual([]);
  });

  it('discovers tracked-plans files during the full scan', async () => {
    await writeJson(
      join(dataDir, 'workspaces', 'workspace-1', 'plans', 'worktree-1.json'),
      {
        version: 1,
        plans: [
          {
            id: 'plan-scan',
            title: 'Scanned plan',
            content: 'Content found by the disk walk: quokka.',
            reviewStatus: 'pending',
            createdAt: '2026-03-01T00:00:00.000Z',
            updatedAt: '2026-03-02T00:00:00.000Z',
            revisions: [],
            linkedExecutionIds: [],
            latestRevisionNumber: 1,
            source: 'claude',
          },
        ],
      },
    );

    await service.scanAllSources();

    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: 'plan-scan',
        source: 'plan',
        title: 'Scanned plan',
        reviewStatus: 'pending',
      }),
    ]);
    expect(service.query({ query: 'quokka' })).toHaveLength(1);
  });

  it('skips an unchanged-size source whose mtime fingerprint is unchanged', async () => {
    const livePath = join(
      dataDir,
      'workspaces',
      'workspace-1',
      'chats',
      'worktree-1.json',
    );
    await writeJson(livePath, tabsFile(makeTab('chat-1', 'AAAAA')));
    const fixedTimestamp = new Date('2026-01-02T03:04:05.000Z');
    await utimes(livePath, fixedTimestamp, fixedTimestamp);
    await service.scanAllSources();
    expect(service.getCatalog()[0]?.title).toBe('AAAAA');

    await writeJson(livePath, tabsFile(makeTab('chat-1', 'BBBBB')));
    await utimes(livePath, fixedTimestamp, fixedTimestamp);
    await service.scanAllSources();

    expect(service.getCatalog()[0]?.title).toBe('AAAAA');
  });

  it('refreshes the source fingerprint after a live-tab delta', async () => {
    const livePath = join(
      dataDir,
      'workspaces',
      'workspace-1',
      'chats',
      'worktree-1.json',
    );
    const initialTimestamp = new Date('2026-01-02T03:04:05.000Z');
    const updatedTimestamp = new Date('2026-01-02T03:04:06.000Z');
    await writeJson(livePath, tabsFile(makeTab('chat-1', 'AAAAA')));
    await utimes(livePath, initialTimestamp, initialTimestamp);
    await service.scanAllSources();

    const updated = tabsFile(makeTab('chat-1', 'BBBBB'));
    await writeJson(livePath, updated);
    await utimes(livePath, updatedTimestamp, updatedTimestamp);
    service.indexLiveTabChanges(
      'workspace-1',
      'worktree-1',
      updated,
      ['chat-1'],
      [],
    );
    await service.flushPendingUpdates();
    expect(service.getCatalog()[0]?.title).toBe('BBBBB');

    await writeJson(livePath, tabsFile(makeTab('chat-1', 'CCCCC')));
    await utimes(livePath, updatedTimestamp, updatedTimestamp);
    await service.scanAllSources();

    expect(service.getCatalog()[0]?.title).toBe('BBBBB');
  });

  it('returns immediately while the first scan fills and later prunes the catalog', async () => {
    const livePath = join(
      dataDir,
      'workspaces',
      'workspace-1',
      'chats',
      'worktree-1.json',
    );
    await writeJson(livePath, tabsFile(makeTab('chat-1', 'Lazy result')));

    service.ensureInitialScan();
    expect(service.getCatalog()).toEqual([]);
    await service.waitForInitialScan();
    expect(service.getCatalog()[0]?.title).toBe('Lazy result');

    await getChatStateService().replaceCompatibilityTabs(
      { projectId: 'workspace-1', worktreeId: 'worktree-1' },
      { version: 1, tabs: [], activeTabId: '' },
      { authoritative: true },
    );
    await service.scanAllSources();
    expect(service.getCatalog()).toEqual([]);
  });

  it('preserves indexed rows when source enumeration fails transiently', async () => {
    service.indexLiveTabs(
      'workspace-1',
      'worktree-1',
      tabsFile(makeTab('chat-1', 'Retained result')),
    );
    await service.flushPendingUpdates();
    await writeFile(join(dataDir, 'workspaces'), 'not a directory', 'utf8');

    await expect(service.scanAllSources()).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Retained result',
      }),
    ]);
  });

  it('preserves indexed rows when a source stat fails transiently', async () => {
    const livePath = join(
      dataDir,
      'workspaces',
      'workspace-1',
      'chats',
      'worktree-1.json',
    );
    await writeJson(livePath, tabsFile(makeTab('chat-1', 'Retained result')));
    await service.scanAllSources();

    const statError = Object.assign(new Error('temporary stat failure'), {
      code: 'EIO',
    });
    mockedStat.mockImplementation((path) => {
      if (path === scopeIndexPath(livePath)) return Promise.reject(statError);
      return actualFsPromises.stat(path);
    });

    await expect(service.scanAllSources()).rejects.toBe(statError);
    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Retained result',
      }),
    ]);
  });

  it('preserves indexed plans when their file read fails transiently', async () => {
    const plansPath = join(
      dataDir,
      'workspaces',
      'workspace-1',
      'plans',
      'worktree-1.json',
    );
    const planFile = {
      version: 1,
      plans: [
        {
          id: 'plan-1',
          title: 'Retained plan',
          content: 'Keep this indexed content.',
        },
      ],
    };
    await writeJson(plansPath, planFile);
    await service.scanAllSources();
    await writeJson(plansPath, {
      ...planFile,
      plans: [{ ...planFile.plans[0], content: 'Changed content.' }],
    });

    const readError = Object.assign(new Error('temporary read failure'), {
      code: 'EIO',
    });
    mockedReadFile.mockImplementation((path, options) => {
      if (path === plansPath) return Promise.reject(readError);
      return actualFsPromises.readFile(path, options);
    });

    await expect(service.scanAllSources()).rejects.toBe(readError);
    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: 'plan-1',
        title: 'Retained plan',
      }),
    ]);
    expect(service.query({ query: 'indexed content' })).toHaveLength(1);
  });

  it('preserves indexed plans when their file is malformed', async () => {
    const plansPath = join(
      dataDir,
      'workspaces',
      'workspace-1',
      'plans',
      'worktree-1.json',
    );
    await writeJson(plansPath, {
      version: 1,
      plans: [
        {
          id: 'plan-1',
          title: 'Retained plan',
          content: 'Keep this indexed content.',
        },
      ],
    });
    await utimes(plansPath, new Date(1_000), new Date(1_000));
    await service.scanAllSources();

    await writeFile(plansPath, '{"version":1,"plans":', 'utf8');
    await utimes(plansPath, new Date(2_000), new Date(2_000));

    await expect(service.scanAllSources()).rejects.toThrow(
      'Invalid tracked plans JSON',
    );
    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: 'plan-1',
        title: 'Retained plan',
      }),
    ]);
    expect(service.query({ query: 'indexed content' })).toHaveLength(1);

    await writeJson(plansPath, {
      version: 1,
      plans: [
        {
          id: 'plan-1',
          title: 'Updated plan',
          content: 'Recovered indexed content.',
        },
      ],
    });
    await utimes(plansPath, new Date(3_000), new Date(3_000));
    await service.scanAllSources();
    expect(service.getCatalog()[0]?.title).toBe('Updated plan');
  });

  it('preserves and retries live chats after a transient read failure', async () => {
    const livePath = join(
      dataDir,
      'workspaces',
      'workspace-1',
      'chats',
      'worktree-1.json',
    );
    await writeJson(livePath, tabsFile(makeTab('chat-1', 'Retained live')));
    await utimes(livePath, new Date(1_000), new Date(1_000));
    await service.scanAllSources();

    await writeCanonical(livePath, tabsFile(makeTab('chat-1', 'Updated live')));

    const readError = Object.assign(new Error('temporary live read failure'), {
      code: 'EIO',
    });
    resetChatStateServiceForTests();
    mockedReadFile.mockImplementation((path, options) => {
      if (path === scopeIndexPath(livePath)) return Promise.reject(readError);
      return actualFsPromises.readFile(path, options);
    });

    await expect(service.scanAllSources()).rejects.toThrow(readError.message);
    expect(service.getCatalog()[0]?.title).toBe('Retained live');

    mockedReadFile.mockImplementation(actualFsPromises.readFile);
    await service.scanAllSources();
    expect(service.getCatalog()[0]?.title).toBe('Updated live');
  });

  it('preserves and retries worktree archives after a transient read failure', async () => {
    const archivePath = join(
      dataDir,
      'workspaces',
      'workspace-1',
      'chat-archives',
      'worktree-1.json',
    );
    const archiveFile = (title: string): ArchivedChatsFile => ({
      version: 1,
      archived: [
        {
          tab: makeTab('chat-1', title),
          archivedAt: '2026-02-01T00:00:00.000Z',
          turnCount: 1,
        },
      ],
    });
    await writeJson(archivePath, archiveFile('Retained archive'));
    await utimes(archivePath, new Date(1_000), new Date(1_000));
    await service.scanAllSources();

    await writeCanonical(archivePath, archiveFile('Updated archive'));

    const readError = Object.assign(
      new Error('temporary archive read failure'),
      { code: 'EIO' },
    );
    resetChatStateServiceForTests();
    mockedReadFile.mockImplementation((path, options) => {
      if (path === scopeIndexPath(archivePath))
        return Promise.reject(readError);
      return actualFsPromises.readFile(path, options);
    });

    await expect(service.scanAllSources()).rejects.toThrow(readError.message);
    expect(service.getCatalog()[0]?.title).toBe('Retained archive');

    mockedReadFile.mockImplementation(actualFsPromises.readFile);
    await service.scanAllSources();
    expect(service.getCatalog()[0]?.title).toBe('Updated archive');
  });

  it('preserves incremental archive rows after a transient read failure', async () => {
    const archivePath = join(
      dataDir,
      'workspaces',
      'workspace-1',
      'chat-archives',
      'worktree-1.json',
    );
    const archiveFile = (title: string): ArchivedChatsFile => ({
      version: 1,
      archived: [
        {
          tab: makeTab('chat-1', title),
          archivedAt: '2026-02-01T00:00:00.000Z',
          turnCount: 1,
        },
      ],
    });
    await writeJson(archivePath, archiveFile('Retained archive'));
    service.indexWorktreeArchives('workspace-1', 'worktree-1');
    await service.flushPendingUpdates();

    const readError = Object.assign(
      new Error('temporary incremental archive read failure'),
      { code: 'EIO' },
    );
    resetChatStateServiceForTests();
    mockedReadFile.mockImplementation((path, options) => {
      if (path === scopeIndexPath(archivePath))
        return Promise.reject(readError);
      return actualFsPromises.readFile(path, options);
    });

    service.indexWorktreeArchives('workspace-1', 'worktree-1');
    await expect(service.flushPendingUpdates()).rejects.toThrow(
      readError.message,
    );
    expect(service.getCatalog()[0]?.title).toBe('Retained archive');

    mockedReadFile.mockImplementation(actualFsPromises.readFile);
    await writeCanonical(archivePath, archiveFile('Updated archive'));
    service.indexWorktreeArchives('workspace-1', 'worktree-1');
    await service.flushPendingUpdates();
    expect(service.getCatalog()[0]?.title).toBe('Updated archive');
  });

  it('preserves and retries cowork archives after a transient read failure', async () => {
    const tab = makeTab('cowork-chat', 'Retained cowork archive');
    const archiveDir = join(
      dataDir,
      'workspaces',
      'cowork-1',
      'chat-history',
      tab.id,
    );
    const conversationPath = join(archiveDir, 'conversation.json');
    const metaPath = join(archiveDir, 'meta.json');
    await writeJson(conversationPath, {
      version: 1,
      projectId: 'cowork-1',
      chatId: tab.id,
      archivedAt: '2026-02-01T00:00:00.000Z',
      tab,
    });
    await writeJson(metaPath, {
      version: 1,
      id: tab.id,
      title: tab.title,
      description: tab.description,
      createdAt: tab.createdAt,
      archived: true,
      archivedAt: '2026-02-01T00:00:00.000Z',
    });
    await service.scanAllSources();

    await writeJson(metaPath, {
      version: 1,
      id: tab.id,
      title: 'Updated cowork archive',
      description: tab.description,
      createdAt: tab.createdAt,
      archived: true,
      archivedAt: '2026-02-01T00:00:00.000Z',
    });
    await utimes(metaPath, new Date(2_000), new Date(2_000));
    const readError = Object.assign(
      new Error('temporary cowork read failure'),
      {
        code: 'EIO',
      },
    );
    mockedReadFile.mockImplementation((path, options) => {
      if (
        path ===
        join(archiveDir, 'chat-storage-v2', tab.id, 'archive-index.json')
      )
        return Promise.reject(readError);
      return actualFsPromises.readFile(path, options);
    });

    await expect(service.scanAllSources()).rejects.toBe(readError);
    expect(service.getCatalog()[0]?.title).toBe('Retained cowork archive');

    mockedReadFile.mockImplementation(actualFsPromises.readFile);
    await service.scanAllSources();
    expect(service.getCatalog()[0]?.title).toBe('Updated cowork archive');
  });

  it('preserves a source indexed incrementally while a full scan is active', async () => {
    const scan = service.scanAllSources();
    service.indexLiveTabs(
      'workspace-concurrent',
      'worktree-concurrent',
      tabsFile(makeTab('chat-concurrent', 'Created during scan')),
    );
    await service.flushPendingUpdates();
    await scan;

    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: 'chat-concurrent',
        title: 'Created during scan',
      }),
    ]);
  });

  it('finishes a full scan when a live projection is superseded by a tabs update', async () => {
    const firstScope = { projectId: 'scan-epoch', worktreeId: 'first' };
    const secondScope = { projectId: 'scan-epoch', worktreeId: 'second' };
    await getChatStateService().replaceCompatibilityTabs(
      firstScope,
      tabsFile(makeTab('first-chat', 'First scan chat')),
      { authoritative: true },
    );
    await getChatStateService().replaceCompatibilityTabs(
      secondScope,
      tabsFile(makeTab('second-chat', 'Second scan chat')),
      { authoritative: true },
    );
    const state = getChatStateService();
    const originalConsume = state.consumeTranscriptPreview.bind(state);
    const consume = jest
      .spyOn(state, 'consumeTranscriptPreview')
      .mockImplementation((scope, chatId, project, isCurrent) =>
        originalConsume(
          scope,
          chatId,
          async (messages, descriptor, read) => {
            if (chatId === 'first-chat') {
              service.indexLiveTabs(
                firstScope.projectId,
                firstScope.worktreeId,
                tabsFile(makeTab('first-chat', 'Updated first chat')),
              );
            }
            return project(messages, descriptor, read);
          },
          isCurrent,
        ),
      );
    try {
      await service.scanAllSources();
      expect(service.getCatalog()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ chatId: 'second-chat' }),
        ]),
      );
      const db = Reflect.get(service, 'db') as DatabaseSync;
      const metadata = db
        .prepare(
          "SELECT value FROM search_meta WHERE key = 'last_full_scan_at'",
        )
        .get() as { value: string } | undefined;
      expect(Number(metadata?.value)).toBeGreaterThan(0);
    } finally {
      consume.mockRestore();
    }
  });

  it('discovers App Advisor live and archived chats across entries and global', async () => {
    const advisorChatsDir = join(
      dataDir,
      'app-workspaces',
      APP_ADVISOR_PROJECT_ID,
      'chats',
    );
    await writeJson(
      join(advisorChatsDir, 'entry-one.json'),
      tabsFile(makeTab('advisor-chat-one', 'Advisor entry one')),
    );
    await writeJson(
      join(advisorChatsDir, 'entry-two.json'),
      tabsFile(makeTab('advisor-chat-two', 'Advisor entry two')),
    );
    await writeJson(
      join(advisorChatsDir, `${APP_ADVISOR_WORKTREE_ID}.json`),
      tabsFile(makeTab('advisor-chat-global', 'Advisor legacy global')),
    );
    const archivedTab = makeTab('advisor-chat-archived', 'Advisor archived');
    await writeJson(
      join(
        dataDir,
        'app-workspaces',
        APP_ADVISOR_PROJECT_ID,
        'chat-archives',
        'entry-one.json',
      ),
      {
        version: 1,
        archived: [
          {
            tab: archivedTab,
            archivedAt: '2026-02-01T00:00:00.000Z',
            turnCount: 1,
          },
        ],
      } satisfies ArchivedChatsFile,
    );

    await service.scanAllSources();
    expect(service.getCatalog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat-one',
        }),
        expect.objectContaining({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-two',
          chatId: 'advisor-chat-two',
        }),
        expect.objectContaining({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
          chatId: 'advisor-chat-global',
        }),
        expect.objectContaining({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-one',
          chatId: 'advisor-chat-archived',
          source: 'worktree-archive',
        }),
      ]),
    );
    expect(service.getCatalog()).toHaveLength(4);
  });

  it('discovers cowork archive snapshots and removes retained archive rows', async () => {
    const tab = makeTab('cowork-chat', 'Cowork archive');
    const archiveDir = join(
      dataDir,
      'workspaces',
      'cowork-1',
      'chat-history',
      tab.id,
    );
    await writeJson(join(archiveDir, 'conversation.json'), {
      version: 1,
      projectId: 'cowork-1',
      chatId: tab.id,
      archivedAt: '2026-02-01T00:00:00.000Z',
      tab,
    });
    await writeJson(join(archiveDir, 'meta.json'), {
      version: 1,
      id: tab.id,
      title: tab.title,
      description: tab.description,
      createdAt: tab.createdAt,
      archived: true,
      archivedAt: '2026-02-01T00:00:00.000Z',
    });

    await service.scanAllSources();
    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        projectId: 'cowork-1',
        worktreeId: 'home',
        chatId: tab.id,
        source: 'cowork-archive',
      }),
    ]);

    // A restored live chat can retain the archive's chat ID. Purging its old
    // history must hide only that archive, not the restored session.
    service.indexLiveTabs('cowork-1', 'restored-entry', tabsFile(tab));
    await service.flushPendingUpdates();
    await service.deleteCoworkArchive('cowork-1', tab.id);
    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: tab.id,
        worktreeId: 'restored-entry',
        source: 'live',
      }),
    ]);
  });

  it('discovers committed archived containers and removes their documents on purge', async () => {
    const workspaceId = 'workspace-archived';
    const containerId = 'worktree-archived';
    const containerDir = join(
      dataDir,
      'workspaces',
      workspaceId,
      'archived-containers',
      containerId,
    );
    const tab = makeTab('archived-chat', 'Retained deleted worktree');
    await writeJson(join(containerDir, 'chats.json'), tabsFile(tab));
    await writeJson(join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    await writeJson(join(containerDir, 'container.json'), {
      version: 1,
      id: containerId,
      kind: 'worktree',
      projectId: workspaceId,
      name: 'Deleted feature',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-02-01T00:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2099-02-08T00:00:00.000Z',
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'single-repo',
      label: 'Retired glacier work',
    });
    await writeJson(join(containerDir, 'summary.json'), {
      version: 1,
      summary: {
        title: 'Glacier migration',
        description: 'Retired the frozen transport adapter',
        highlights: ['Preserved compatibility notes'],
        generatedAt: '2026-02-01T00:00:00.000Z',
        turnCountAtGeneration: 3,
        lastFullRefreshAt: '2026-02-01T00:00:00.000Z',
        lastFullRefreshTurnCount: 3,
      },
    });
    await writeJson(join(containerDir, 'tracked-plans.json'), {
      version: 1,
      plans: [
        {
          id: 'archived-plan',
          projectId: workspaceId,
          worktreeId: containerId,
          source: 'claude',
          title: 'Frozen rollout plan',
          content:
            '# Frozen rollout plan\n\nValidate the cryoplanneedle phase.',
          reviewStatus: 'approved',
          createdAt: '2026-01-20T00:00:00.000Z',
          updatedAt: '2026-01-21T00:00:00.000Z',
          latestRevisionNumber: 1,
          revisions: [],
          linkedExecutionIds: [],
        },
      ],
    });

    await service.scanAllSources();

    expect(service.getCatalog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: workspaceId,
          worktreeId: containerId,
          chatId: tab.id,
          source: 'archived-container',
          documentKind: 'chat',
        }),
        expect.objectContaining({
          projectId: workspaceId,
          worktreeId: containerId,
          source: 'archived-container',
          documentKind: 'archived-container',
          title: 'Retired glacier work',
          description: 'Retired the frozen transport adapter',
          messageCount: tab.messages.length,
        }),
        expect.objectContaining({
          projectId: workspaceId,
          worktreeId: containerId,
          chatId: 'archived-plan',
          source: 'archived-container',
          documentKind: 'plan',
          title: 'Frozen rollout plan',
        }),
      ]),
    );
    expect(service.query({ query: 'cryoplanneedle' })).toEqual([
      expect.objectContaining({
        chatId: 'archived-plan',
        documentKind: 'plan',
        source: 'archived-container',
      }),
    ]);

    await writeJson(join(containerDir, 'container.json'), {
      version: 1,
      id: containerId,
      kind: 'worktree',
      projectId: workspaceId,
      name: 'Deleted feature',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-02-01T00:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2099-02-08T00:00:00.000Z',
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'single-repo',
      label: 'Retired glacier work',
      restoredTo: {
        kind: 'worktree',
        id: 'restored-worktree',
        restoredAt: '2026-03-01T00:00:00.000Z',
      },
    });
    await removeArchivedContainerPayloadsAfterPartialRestore(
      workspaceId,
      containerId,
    );

    await expect(service.scanAllSources()).resolves.toBeUndefined();
    expect(
      service.getCatalog().filter((entry) => entry.worktreeId === containerId),
    ).toEqual([]);

    await rm(containerDir, { recursive: true, force: true });
    await service.scanAllSources();
    expect(service.getCatalog()).toEqual([]);

    await service.worktreeContainerPurged(workspaceId, containerId);
    expect(service.getCatalog()).toEqual([]);
  });

  it('hides archived-container documents as soon as retention expires', async () => {
    const workspaceId = 'workspace-expiring';
    const containerId = 'worktree-expiring';
    const containerDir = join(
      dataDir,
      'workspaces',
      workspaceId,
      'archived-containers',
      containerId,
    );
    const tab = makeTab('expired-chat', 'Secret retained transcript');
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await writeJson(join(containerDir, 'chats.json'), tabsFile(tab));
      await writeJson(join(containerDir, 'chat-archives.json'), {
        version: 1,
        archived: [],
      });
      await writeJson(join(containerDir, 'container.json'), {
        version: 1,
        id: containerId,
        kind: 'worktree',
        projectId: workspaceId,
        name: 'Deleted feature',
        createdAt: '2026-01-01T00:00:00.000Z',
        archivedAt: new Date(now - 1_000).toISOString(),
        retentionDays: 7,
        expiresAt: new Date(now + 1_000).toISOString(),
        chatCount: 1,
        archivedChatCount: 0,
        executionCount: 0,
        workspaceType: 'single-repo',
      });

      await service.scanAllSources();
      expect(service.getCatalog()).toHaveLength(2);
      expect(service.query({ query: 'Visible' })).toHaveLength(1);

      nowSpy.mockReturnValue(now + 2_000);
      expect(service.getCatalog()).toEqual([]);
      expect(service.query({ query: 'Visible' })).toEqual([]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not let an active archived-container scan restore purged documents', async () => {
    const workspaceId = 'workspace-archived-race';
    const containerId = 'worktree-archived-race';
    const containerDir = join(
      dataDir,
      'workspaces',
      workspaceId,
      'archived-containers',
      containerId,
    );
    const chatsPath = join(containerDir, 'chats.json');
    const archivedTab = makeTab('archived-race-chat', 'Purged during scan');
    await writeJson(chatsPath, tabsFile(archivedTab));
    await writeJson(join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    await writeJson(join(containerDir, 'container.json'), {
      version: 1,
      id: containerId,
      kind: 'worktree',
      projectId: workspaceId,
      name: 'Deleted feature',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-02-01T00:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2099-02-08T00:00:00.000Z',
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'single-repo',
    });
    const store = await getArchivedContainerChatStorage(
      workspaceId,
      containerId,
    );
    const nativeChatsPath = join(store.directory, 'live-index.json');
    const chats = await actualFsPromises.readFile(nativeChatsPath, 'utf8');
    let blockFirstRead = true;
    let releaseChatsRead: (() => void) | undefined;
    const chatsReadStarted = new Promise<void>((resolve) => {
      mockedReadFile.mockImplementation((path, options) => {
        if (path !== nativeChatsPath || !blockFirstRead) {
          return actualFsPromises.readFile(path, options);
        }
        blockFirstRead = false;
        resolve();
        return new Promise((release) => {
          releaseChatsRead = (): void => release(chats);
        });
      });
    });

    const scan = service.scanAllSources();
    await chatsReadStarted;
    await service.worktreeContainerPurged(workspaceId, containerId);
    releaseChatsRead?.();
    await scan;

    expect(service.getCatalog()).toEqual([]);
  });

  it('switches live documents to archived-container documents and reactivates the restored destination', async () => {
    const workspaceId = 'workspace-incremental-archive';
    const containerId = 'worktree-original';
    const destinationId = 'worktree-restored';
    const archivedTab = makeTab('chat-retained', 'Retained transcript');
    service.indexLiveTabs(workspaceId, containerId, tabsFile(archivedTab));
    await service.flushPendingUpdates();

    const containerDir = join(
      dataDir,
      'workspaces',
      workspaceId,
      'archived-containers',
      containerId,
    );
    await writeJson(join(containerDir, 'chats.json'), tabsFile(archivedTab));
    await writeJson(join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    await writeJson(join(containerDir, 'container.json'), {
      version: 1,
      id: containerId,
      kind: 'worktree',
      projectId: workspaceId,
      name: 'Deleted feature',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-02-01T00:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2099-02-08T00:00:00.000Z',
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'single-repo',
    });

    await service.worktreeContainerArchived(workspaceId, containerId);
    await service.flushPendingUpdates();

    expect(
      service.getCatalog().filter((entry) => entry.documentKind === 'chat'),
    ).toEqual([
      expect.objectContaining({
        worktreeId: containerId,
        chatId: archivedTab.id,
        source: 'archived-container',
      }),
    ]);

    const restoredTab = makeTab('chat-restored', 'Restored transcript');
    const workspaceDir = join(dataDir, 'workspaces', workspaceId);
    await writeJson(
      join(workspaceDir, 'chats', `${destinationId}.json`),
      tabsFile(restoredTab),
    );
    await writeJson(
      join(workspaceDir, 'chat-archives', `${destinationId}.json`),
      { version: 1, archived: [] },
    );

    await service.worktreeContainerRestored(
      workspaceId,
      containerId,
      destinationId,
    );
    await service.flushPendingUpdates();

    expect(
      service.getCatalog().filter((entry) => entry.documentKind === 'chat'),
    ).toEqual([
      expect.objectContaining({
        worktreeId: destinationId,
        chatId: restoredTab.id,
        source: 'live',
      }),
    ]);
  });

  it('refreshes a restored destination when derived archive purge fails', async () => {
    const workspaceId = 'workspace-restore-purge-failure';
    const containerId = 'worktree-original';
    const destinationId = 'worktree-restored';
    const restoredTab = makeTab('chat-restored', 'Restored transcript');
    const workspaceDir = join(dataDir, 'workspaces', workspaceId);
    await writeJson(
      join(workspaceDir, 'chats', `${destinationId}.json`),
      tabsFile(restoredTab),
    );
    await writeJson(
      join(workspaceDir, 'chat-archives', `${destinationId}.json`),
      { version: 1, archived: [] },
    );
    jest
      .spyOn(service, 'worktreeContainerPurged')
      .mockRejectedValueOnce(new Error('Search index worker is closing'));

    await expect(
      service.worktreeContainerRestored(
        workspaceId,
        containerId,
        destinationId,
      ),
    ).resolves.toBeUndefined();
    await service.flushPendingUpdates();

    expect(service.getCatalog()).toContainEqual(
      expect.objectContaining({
        worktreeId: destinationId,
        chatId: restoredTab.id,
        source: 'live',
      }),
    );
  });

  it('keeps archived-container search expiry in sync with lock state', async () => {
    const workspaceId = 'workspace-locked-archive';
    const containerId = 'worktree-locked';
    const archivedTab = makeTab('chat-locked', 'Locked transcript');
    const containerDir = join(
      dataDir,
      'workspaces',
      workspaceId,
      'archived-containers',
      containerId,
    );
    const manifestPath = join(containerDir, 'container.json');
    await writeJson(join(containerDir, 'chats.json'), tabsFile(archivedTab));
    await writeJson(join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    await writeJson(manifestPath, {
      version: 1,
      id: containerId,
      kind: 'worktree',
      projectId: workspaceId,
      name: 'Locked worktree',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-02-01T00:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2026-02-08T00:00:00.000Z',
      lockedAt: '2026-02-02T00:00:00.000Z',
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'single-repo',
    });

    service.archivedContainerUpdated(workspaceId, containerId);
    await service.flushPendingUpdates();

    expect(
      service.getCatalog().filter((entry) => entry.documentKind === 'chat'),
    ).toEqual([
      expect.objectContaining({
        worktreeId: containerId,
        chatId: archivedTab.id,
        source: 'archived-container',
      }),
    ]);
    const database = new DatabaseSync(
      join(dataDir, 'derived', 'chat-search.sqlite'),
      { readOnly: true },
    );
    try {
      expect(
        database
          .prepare(
            'SELECT expires_at FROM chat_docs WHERE project_id = ? AND worktree_id = ?',
          )
          .get(workspaceId, containerId),
      ).toEqual({ expires_at: null });

      const unlockedExpiry = '2099-02-08T00:00:00.000Z';
      await writeJson(manifestPath, {
        version: 1,
        id: containerId,
        kind: 'worktree',
        projectId: workspaceId,
        name: 'Locked worktree',
        createdAt: '2026-01-01T00:00:00.000Z',
        archivedAt: '2026-02-01T00:00:00.000Z',
        retentionDays: 7,
        expiresAt: unlockedExpiry,
        chatCount: 1,
        archivedChatCount: 0,
        executionCount: 0,
        workspaceType: 'single-repo',
      });
      service.archivedContainerUpdated(workspaceId, containerId);
      await service.flushPendingUpdates();

      expect(
        database
          .prepare(
            'SELECT expires_at FROM chat_docs WHERE project_id = ? AND worktree_id = ?',
          )
          .get(workspaceId, containerId),
      ).toEqual({ expires_at: Date.parse(unlockedExpiry) });
    } finally {
      database.close();
    }
  });

  it('does not let a full scan overwrite an archived-container lock update', async () => {
    const workspaceId = 'workspace-locked-archive-race';
    const containerId = 'worktree-locked-race';
    const archivedTab = makeTab('chat-locked-race', 'Locked race transcript');
    const containerDir = join(
      dataDir,
      'workspaces',
      workspaceId,
      'archived-containers',
      containerId,
    );
    const manifestPath = join(containerDir, 'container.json');
    await writeJson(join(containerDir, 'chats.json'), tabsFile(archivedTab));
    await writeJson(join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    const unlockedManifest: ArchivedContainerManifest = {
      version: 1,
      id: containerId,
      kind: 'worktree',
      projectId: workspaceId,
      name: 'Lock race worktree',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-02-01T00:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2099-02-08T00:00:00.000Z',
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'single-repo',
    };
    await writeJson(manifestPath, unlockedManifest);
    const staleManifestContents = JSON.stringify(unlockedManifest, null, 2);

    let markReadStarted = (): void => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let releaseRead = (): void => undefined;
    let shouldBlockRead = true;
    let serveStaleManifest = true;
    mockedReadFile.mockImplementation((path, options) => {
      if (path === manifestPath && serveStaleManifest) {
        if (shouldBlockRead) {
          shouldBlockRead = false;
          return new Promise((resolve) => {
            releaseRead = (): void => resolve(staleManifestContents);
            markReadStarted();
          });
        }
        return Promise.resolve(staleManifestContents);
      }
      return actualFsPromises.readFile(path, options);
    });

    const scan = service.scanAllSources();
    await readStarted;

    await commitArchivedContainer({
      ...unlockedManifest,
      lockedAt: '2026-02-02T00:00:00.000Z',
    });
    serveStaleManifest = false;
    service.archivedContainerUpdated(workspaceId, containerId);

    releaseRead();
    await scan;
    await service.flushPendingUpdates();

    const database = new DatabaseSync(
      join(dataDir, 'derived', 'chat-search.sqlite'),
      { readOnly: true },
    );
    try {
      expect(
        database
          .prepare(
            'SELECT expires_at FROM chat_docs WHERE project_id = ? AND worktree_id = ?',
          )
          .get(workspaceId, containerId),
      ).toEqual({ expires_at: null });
    } finally {
      database.close();
    }
  });

  it('does not let in-flight worktree archive indexing cross the container archive transition', async () => {
    const workspaceId = 'workspace-archive-race';
    const containerId = 'worktree-archive-race';
    const staleTab = makeTab('chat-stale', 'Stale worktree archive');
    const retainedTab = makeTab('chat-retained', 'Retained container chat');
    const workspaceDir = join(dataDir, 'workspaces', workspaceId);
    const worktreeArchivePath = join(
      workspaceDir,
      'chat-archives',
      `${containerId}.json`,
    );
    await writeJson(worktreeArchivePath, {
      version: 1,
      archived: [
        {
          tab: staleTab,
          archivedAt: '2026-01-15T00:00:00.000Z',
          turnCount: 1,
        },
      ],
    });

    await getChatStateService().getCompatibilityArchives({
      projectId: workspaceId,
      worktreeId: containerId,
    });
    resetChatStateServiceForTests();
    let markReadStarted = (): void => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let releaseRead = (): void => undefined;
    let shouldBlockRead = true;
    mockedReadFile.mockImplementation((path, options) => {
      if (path === scopeIndexPath(worktreeArchivePath) && shouldBlockRead) {
        shouldBlockRead = false;
        return new Promise((resolve, reject) => {
          releaseRead = (): void => {
            void actualFsPromises.readFile(path, options).then(resolve, reject);
          };
          markReadStarted();
        });
      }
      return actualFsPromises.readFile(path, options);
    });

    service.indexWorktreeArchives(workspaceId, containerId);
    const staleFlush = service.flushPendingUpdates();
    await readStarted;

    const containerDir = join(workspaceDir, 'archived-containers', containerId);
    await writeJson(join(containerDir, 'chats.json'), tabsFile(retainedTab));
    await writeJson(join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    await writeJson(join(containerDir, 'container.json'), {
      version: 1,
      id: containerId,
      kind: 'worktree',
      projectId: workspaceId,
      name: 'Archived worktree',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-02-01T00:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2099-02-08T00:00:00.000Z',
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'single-repo',
    });
    await service.worktreeContainerArchived(workspaceId, containerId);

    releaseRead();
    await staleFlush;
    await service.flushPendingUpdates();

    expect(
      service.getCatalog().filter((entry) => entry.documentKind === 'chat'),
    ).toEqual([
      expect.objectContaining({
        worktreeId: containerId,
        chatId: retainedTab.id,
        source: 'archived-container',
      }),
    ]);
  });

  it('does not let a full-scan read cross the container archive transition', async () => {
    const workspaceId = 'workspace-full-scan-archive-race';
    const containerId = 'worktree-full-scan-archive-race';
    const staleTab = makeTab('chat-stale-live', 'Stale live chat');
    const retainedTab = makeTab('chat-retained', 'Retained container chat');
    const workspaceDir = join(dataDir, 'workspaces', workspaceId);
    const livePath = join(workspaceDir, 'chats', `${containerId}.json`);
    await writeJson(livePath, tabsFile(staleTab));
    await getChatStateService().getCompatibilityTabs({
      projectId: workspaceId,
      worktreeId: containerId,
    });
    resetChatStateServiceForTests();
    const liveContents = await actualFsPromises.readFile(
      scopeIndexPath(livePath),
      'utf8',
    );

    let markReadStarted = (): void => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let releaseRead = (): void => undefined;
    mockedReadFile.mockImplementation((path, options) => {
      if (path === scopeIndexPath(livePath)) {
        markReadStarted();
        return new Promise((resolve) => {
          releaseRead = (): void => resolve(liveContents);
        });
      }
      return actualFsPromises.readFile(path, options);
    });

    const scan = service.scanAllSources();
    await readStarted;

    const containerDir = join(workspaceDir, 'archived-containers', containerId);
    await writeJson(join(containerDir, 'chats.json'), tabsFile(retainedTab));
    await writeJson(join(containerDir, 'chat-archives.json'), {
      version: 1,
      archived: [],
    });
    await writeJson(join(containerDir, 'container.json'), {
      version: 1,
      id: containerId,
      kind: 'worktree',
      projectId: workspaceId,
      name: 'Archived worktree',
      createdAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-02-01T00:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2099-02-08T00:00:00.000Z',
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'single-repo',
    });
    await service.worktreeContainerArchived(workspaceId, containerId);

    releaseRead();
    await scan;
    await service.flushPendingUpdates();

    expect(
      service.getCatalog().filter((entry) => entry.documentKind === 'chat'),
    ).toEqual([
      expect.objectContaining({
        worktreeId: containerId,
        chatId: retainedTab.id,
        source: 'archived-container',
      }),
    ]);
  });

  it('does not let a full archive scan overwrite a newer incremental archive refresh', async () => {
    const workspaceId = 'workspace-archive-content-race';
    const worktreeId = 'worktree-archive-content-race';
    const archivePath = join(
      dataDir,
      'workspaces',
      workspaceId,
      'chat-archives',
      `${worktreeId}.json`,
    );
    const archiveFile = (title: string): ArchivedChatsFile => ({
      version: 1,
      archived: [
        {
          tab: makeTab('archive-chat', title),
          archivedAt: '2026-02-01T00:00:00.000Z',
          turnCount: 1,
        },
      ],
    });
    await writeJson(archivePath, archiveFile('Stale archive title'));
    await getChatStateService().getCompatibilityArchives({
      projectId: workspaceId,
      worktreeId,
    });

    // Preserve the real implementation while the prototype is temporarily
    // intercepted to make the cross-refresh ordering deterministic.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalReplace = ChatSearchIndexer.prototype.replaceStreamedScope;
    let markFullReplaceStarted = (): void => undefined;
    const fullReplaceStarted = new Promise<void>((resolve) => {
      markFullReplaceStarted = resolve;
    });
    let releaseFullReplace = (): void => undefined;
    let blocked = false;
    const replace = jest
      .spyOn(ChatSearchIndexer.prototype, 'replaceStreamedScope')
      .mockImplementation(async function (...args) {
        if (args[2] === 'worktree-archive' && !blocked) {
          blocked = true;
          markFullReplaceStarted();
          await new Promise<void>((resolve) => {
            releaseFullReplace = resolve;
          });
        }
        return originalReplace.apply(this, args);
      });

    try {
      const scan = service.scanAllSources();
      await fullReplaceStarted;

      await writeCanonical(archivePath, archiveFile('Current archive title'));
      service.indexWorktreeArchives(workspaceId, worktreeId);
      await service.flushPendingUpdates();
      expect(service.getCatalog()[0]?.title).toBe('Current archive title');

      releaseFullReplace();
      await scan;
      expect(service.getCatalog()[0]?.title).toBe('Current archive title');
    } finally {
      releaseFullReplace();
      replace.mockRestore();
    }
  });

  it('does not let an active full scan restore a deleted cowork archive', async () => {
    const tab = makeTab('cowork-race', 'Cowork archive deleted during scan');
    const archiveDir = join(
      dataDir,
      'workspaces',
      'cowork-race-workspace',
      'chat-history',
      tab.id,
    );
    const conversationPath = join(archiveDir, 'conversation.json');
    await writeJson(conversationPath, {
      version: 1,
      projectId: 'cowork-race-workspace',
      chatId: tab.id,
      archivedAt: '2026-02-01T00:00:00.000Z',
      tab,
    });
    await writeJson(join(archiveDir, 'meta.json'), {
      version: 1,
      id: tab.id,
      title: tab.title,
      description: tab.description,
      createdAt: tab.createdAt,
      archived: true,
      archivedAt: '2026-02-01T00:00:00.000Z',
    });
    const store = await getStandaloneHistoryStorage(
      'cowork-race-workspace',
      tab.id,
    );
    if (!store) throw new Error('Archive missing');
    const indexPath = join(store.directory, 'archive-index.json');
    const conversation = await actualFsPromises.readFile(indexPath, 'utf8');
    let releaseConversationRead: (() => void) | undefined;
    const conversationReadStarted = new Promise<void>((resolve) => {
      mockedReadFile.mockImplementation((path, options) => {
        if (path !== indexPath) {
          return actualFsPromises.readFile(path, options);
        }
        resolve();
        return new Promise((release) => {
          releaseConversationRead = (): void => release(conversation);
        });
      });
    });

    const scan = service.scanAllSources();
    await conversationReadStarted;
    await rm(archiveDir, { recursive: true, force: true });
    await service.deleteCoworkArchive('cowork-race-workspace', tab.id);
    releaseConversationRead?.();
    await scan;

    expect(service.getCatalog()).toEqual([]);
  });

  it('uses the description as the title for legacy metadata-only archives', async () => {
    const chatId = 'legacy-metadata-only';
    await writeJson(
      join(
        dataDir,
        'workspaces',
        'cowork-legacy',
        'chat-history',
        chatId,
        'meta.json',
      ),
      {
        version: 1,
        id: chatId,
        description: 'Legacy archive title',
        createdAt: '2026-01-01T00:00:00.000Z',
        archived: true,
        archivedAt: '2026-02-01T00:00:00.000Z',
      },
    );

    await service.scanAllSources();

    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId,
        title: 'Legacy archive title',
      }),
    ]);
  });

  it('does not treat a provisioned live cowork history directory as an archive', async () => {
    const tab = makeTab('cowork-live', 'Cowork live chat');
    const workspaceDir = join(dataDir, 'workspaces', 'cowork-live-workspace');
    await writeJson(join(workspaceDir, 'chats', 'home.json'), tabsFile(tab));
    await writeJson(join(workspaceDir, 'chat-history', tab.id, 'meta.json'), {
      version: 1,
      id: tab.id,
      title: tab.title,
      description: tab.description,
      createdAt: tab.createdAt,
      archived: false,
    });

    await service.scanAllSources();

    expect(service.getCatalog()).toEqual([
      expect.objectContaining({
        chatId: tab.id,
        source: 'live',
      }),
    ]);
  });

  it('indexes cowork transcripts regardless of the legacy project search preference', async () => {
    const workspaceDir = join(dataDir, 'workspaces', 'cowork-private');
    const livePath = join(workspaceDir, 'chats', 'home.json');
    const worktreePath = join(workspaceDir, 'chats', 'worktree-1.json');
    const configPath = join(workspaceDir, 'workspace.json');
    await writeJson(configPath, {
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: { searchIndexingEnabled: true },
    });
    await writeJson(
      livePath,
      tabsFile(
        makeTab('private-chat', 'Private cowork transcript', [
          textBlock('Private cowork searchable body'),
        ]),
      ),
    );
    await writeJson(
      worktreePath,
      tabsFile(makeTab('worktree-chat', 'Normal worktree transcript')),
    );

    await service.scanAllSources();
    expect(
      service
        .getCatalog()
        .map((entry) => entry.chatId)
        .sort(),
    ).toEqual(['private-chat', 'worktree-chat']);

    await writeJson(configPath, {
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: { searchIndexingEnabled: false },
    });
    await service.scanAllSources();

    expect(
      service
        .getCatalog()
        .map((entry) => entry.chatId)
        .sort(),
    ).toEqual(['private-chat', 'worktree-chat']);
    expect(service.query({ query: 'cowork searchable body' })).toHaveLength(1);
  });

  it('persists cowork archive deletion even when shutdown follows immediately', async () => {
    const tab = makeTab('expired-chat', 'Expired cowork archive');
    service.indexCoworkArchive(
      'cowork-retention',
      tab,
      '2026-02-01T00:00:00.000Z',
    );
    await service.flushPendingUpdates();
    expect(service.getCatalog()).toHaveLength(1);

    await service.deleteCoworkArchive('cowork-retention', tab.id);
    await service.close();

    service = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      debounceMs: 60_000,
      broadcastDebounceMs: 10,
      broadcastUpdated,
    });
    expect(service.getCatalog()).toEqual([]);
  });

  it('coalesces refresh broadcasts after scans and incremental flushes', async () => {
    service.ensureInitialScan();
    await service.waitForInitialScan();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(broadcastUpdated).toHaveBeenCalledTimes(1);

    broadcastUpdated.mockClear();
    service.indexLiveTabs(
      'workspace-1',
      'worktree-1',
      tabsFile(makeTab('chat-1', 'One')),
    );
    service.indexLiveTabs(
      'workspace-1',
      'worktree-2',
      tabsFile(makeTab('chat-2', 'Two')),
    );
    await service.flushPendingUpdates();

    expect(broadcastUpdated).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(broadcastUpdated).toHaveBeenCalledTimes(1);
  });

  it('broadcasts refreshes to every live renderer window', async () => {
    await service.close();
    const liveWindow: MockBrowserWindow = {
      isDestroyed: jest.fn(() => false),
      webContents: { send: jest.fn() },
    };
    const destroyedWindow: MockBrowserWindow = {
      isDestroyed: jest.fn(() => true),
      webContents: { send: jest.fn() },
    };
    mockGetAllWindows.mockReturnValue([liveWindow, destroyedWindow]);
    service = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      debounceMs: 60_000,
      broadcastDebounceMs: 10,
    });

    service.indexLiveTabs(
      'workspace-1',
      'worktree-1',
      tabsFile(makeTab('chat-1', 'One')),
    );
    await service.flushPendingUpdates();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.chatSearchUpdated,
    );
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('escapes raw FTS syntax and returns sentinel-free snippet ranges', async () => {
    const tab = makeTab('chat-1', 'Escaping', [
      textBlock('A quoted hyphen star phrase surrounds the needle.'),
    ]);
    service.indexLiveTabs('workspace-1', 'worktree-1', tabsFile(tab));
    await service.flushPendingUpdates();

    expect(sanitizeChatSearchQuery('"quoted" -hyphen * star')).toBe(
      '"quoted"* "hyphen"* "star"*',
    );
    expect(sanitizeChatSearchQuery('héllo')).toBe('"héllo"*');
    expect(() =>
      service.query({ query: '"quoted" -hyphen * star' }),
    ).not.toThrow();
    expect(service.query({ query: '"quoted" -hyphen * star' })).toHaveLength(1);
    expect(service.query({ query: 'Escaping' })).toEqual([]);

    const [result] = service.query({ query: 'needle' });
    expect(result).toBeDefined();
    expect(result?.snippet).not.toContain('\u0001');
    expect(result?.snippet).not.toContain('\u0002');
    expect(result?.matchRanges.length).toBeGreaterThan(0);
    expect(
      result?.matchRanges.map((range) =>
        result.snippet.slice(range.start, range.end).toLowerCase(),
      ),
    ).toContain('needle');
  });

  it('does not write unchanged search metadata during repeated session updates', () => {
    const db = openChatSearchDatabase(join(dataDir, 'metadata-noop.sqlite'));
    const indexer = new ChatSearchIndexer(db);
    const doc = {
      ...buildChatSearchDoc(
        'project',
        'worktree',
        'live',
        makeTab('chat', 'Stable', [textBlock('searchneedle')]),
      ),
      transcriptFingerprint: 'revision-1',
    };
    try {
      indexer.upsertDoc(doc);
      const before = db.prepare('SELECT total_changes() AS changes').get();
      for (let index = 0; index < 17; index++)
        expect(indexer.updateDocMetadataIfTranscriptUnchanged(doc)).toBe(true);
      expect(db.prepare('SELECT total_changes() AS changes').get()).toEqual(
        before,
      );
      expect(
        indexer.updateDocMetadataIfTranscriptUnchanged({
          ...doc,
          description: 'Updated description',
        }),
      ).toBe(true);
      expect(
        db
          .prepare('SELECT description FROM chat_docs WHERE doc_id = ?')
          .get(doc.docId),
      ).toEqual({ description: 'Updated description' });
    } finally {
      db.close();
    }
  });

  it('rebuilds metadata fast paths when the body is absent or its version differs', () => {
    const db = openChatSearchDatabase(
      join(dataDir, 'metadata-fallback.sqlite'),
    );
    const indexer = new ChatSearchIndexer(db);
    const doc = {
      ...buildChatSearchDoc(
        'project',
        'worktree',
        'live',
        makeTab('chat', 'Original', [textBlock('oldbodyneedle')]),
      ),
      transcriptFingerprint: 'revision-1',
    };
    try {
      indexer.upsertDoc(doc);
      expect(
        indexer.updateDocMetadataIfTranscriptUnchanged({
          ...doc,
          transcriptFingerprint: 'revision-2',
        }),
      ).toBe(false);
      expect(
        indexer.updateDocMetadataIfTranscriptUnchanged({
          ...doc,
          transcriptFingerprint: undefined,
        }),
      ).toBe(false);
      expect(
        indexer.updateDocMetadataIfTranscriptUnchanged({
          ...doc,
          title: 'Renamed',
          body: '',
        }),
      ).toBe(true);
      expect(
        db
          .prepare('SELECT title, body FROM chat_fts WHERE doc_id = ?')
          .get(doc.docId),
      ).toEqual({ title: 'Renamed', body: doc.body });
      db.prepare('DELETE FROM chat_fts WHERE doc_id = ?').run(doc.docId);
      expect(indexer.updateDocMetadataIfTranscriptUnchanged(doc)).toBe(false);
      indexer.upsertDoc(doc);
      indexer.deleteWorktreeDocs('project', 'worktree');
      expect(indexer.updateDocMetadataIfTranscriptUnchanged(doc)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('keeps the complete prior search scope when a streamed replacement fails', async () => {
    const db = openChatSearchDatabase(join(dataDir, 'streamed.sqlite'));
    const indexer = new ChatSearchIndexer(db);
    try {
      indexer.replaceLiveTabs(
        'workspace-1',
        'worktree-1',
        tabsFile(makeTab('old', 'Old', [textBlock('old historical needle')])),
      );
      await expect(
        indexer.replaceStreamedScope(
          'workspace-1',
          'worktree-1',
          'live',
          (async function* (): AsyncGenerator<ChatSearchDoc> {
            yield await Promise.resolve(
              buildChatSearchDoc(
                'workspace-1',
                'worktree-1',
                'live',
                makeTab('new', 'New', [textBlock('new streamed needle')]),
              ),
            );
            throw new Error('transcript unreadable');
          })(),
        ),
      ).rejects.toThrow('transcript unreadable');
      expect(
        queryChatSearchDatabase(db, { query: 'old historical' }).map(
          (result) => result.chatId,
        ),
      ).toEqual(['old']);
      expect(queryChatSearchDatabase(db, { query: 'new streamed' })).toEqual(
        [],
      );
      await indexer.replaceStreamedScope(
        'workspace-1',
        'worktree-1',
        'live',
        (async function* (): AsyncGenerator<ChatSearchDoc> {
          yield await Promise.resolve(
            buildChatSearchDoc(
              'workspace-1',
              'worktree-1',
              'live',
              makeTab('new', 'New', [textBlock('new streamed needle')]),
            ),
          );
        })(),
      );
      expect(queryChatSearchDatabase(db, { query: 'old historical' })).toEqual(
        [],
      );
      expect(
        queryChatSearchDatabase(db, { query: 'new streamed' }).map(
          (result) => result.chatId,
        ),
      ).toEqual(['new']);
    } finally {
      db.close();
    }
  });

  it('probes ranked body sizes without changing query projection semantics', async () => {
    await service.close();
    const dbPath = join(dataDir, 'query-probe.sqlite');
    const db = openChatSearchDatabase(dbPath);
    const indexer = new ChatSearchIndexer(db);
    indexer.replaceLiveTabs(
      'workspace-1',
      'worktree-1',
      tabsFile(
        makeTab('small', 'Small', [textBlock('small threshold needle')]),
        makeTab('large', 'Large', [
          textBlock(`${'x'.repeat(1_024)} large threshold needle`),
        ]),
        makeTab('aggregate-a', 'Aggregate A', [
          textBlock(`${'a'.repeat(300)} aggregate threshold needle`),
        ]),
        makeTab('aggregate-b', 'Aggregate B', [
          textBlock(`${'b'.repeat(300)} aggregate threshold needle`),
        ]),
      ),
    );

    expect(
      chatSearchQueryExceedsBodyThreshold(
        db,
        { query: 'small threshold' },
        512,
      ),
    ).toBe(false);
    expect(
      chatSearchQueryExceedsBodyThreshold(
        db,
        { query: 'large threshold' },
        512,
      ),
    ).toBe(true);
    expect(
      chatSearchQueryExceedsBodyThreshold(
        db,
        { query: 'aggregate threshold' },
        512,
      ),
    ).toBe(true);
    expect(
      queryChatSearchDatabase(db, { query: 'large threshold' }).map(
        (result) => result.chatId,
      ),
    ).toEqual(['large']);
    expect(chatSearchQueryExceedsBodyThreshold(db, { query: '---' }, 0)).toBe(
      false,
    );
    db.close();
    service = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      debounceMs: 60_000,
      broadcastDebounceMs: 10,
      broadcastUpdated,
    });
  });

  it('degrades without re-projecting oversized results in-process when the query worker is unavailable', async () => {
    const dbPath = join(dataDir, 'worker-fallback.sqlite');
    const oversized = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      dbPath,
      largeQueryBodyThresholdBytes: 512,
    });
    oversized.indexLiveTabs(
      'workspace-1',
      'worktree-1',
      tabsFile(
        makeTab('large', 'Large', [
          textBlock(`${'x'.repeat(1_024)} fallback needle`),
        ]),
      ),
    );
    await oversized.flushPendingUpdates();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      // `utilityProcess` is absent from the electron mock, so the worker fork
      // fails the same way a genuine spawn failure does.
      await expect(
        oversized.queryResponsive({ query: 'fallback needle' }),
      ).resolves.toEqual([]);
      // The empty response must not hide why: it reads as "no matches".
      expect(consoleError).toHaveBeenCalledWith(
        'Chat search query failed:',
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
      await oversized.close();
    }
  });

  it('queries oversized results from the active in-memory recovery database', async () => {
    const blockedParent = join(dataDir, 'blocked-chat-search-parent');
    await writeFile(blockedParent, 'not a directory', 'utf8');
    const recovered = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      dbPath: join(blockedParent, 'chat-search.sqlite'),
      largeQueryBodyThresholdBytes: 512,
    });
    recovered.indexLiveTabs(
      'workspace-1',
      'worktree-1',
      tabsFile(
        makeTab('memory-large', 'Memory large', [
          textBlock(`${'x'.repeat(1_024)} memory recovery needle`),
        ]),
      ),
    );
    await recovered.flushPendingUpdates();

    await expect(
      recovered.queryResponsive({ query: 'memory recovery needle' }),
    ).resolves.toEqual([expect.objectContaining({ chatId: 'memory-large' })]);
    await recovered.close();
  });

  it('returns empty results instead of re-querying when closed mid-query', async () => {
    const dbPath = join(dataDir, 'shutdown-cancellation.sqlite');
    const closing = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      dbPath,
      largeQueryBodyThresholdBytes: 512,
    });
    closing.indexLiveTabs(
      'workspace-1',
      'worktree-1',
      tabsFile(
        makeTab('large', 'Large', [
          textBlock(`${'x'.repeat(1_024)} shutdown needle`),
        ]),
      ),
    );
    await closing.flushPendingUpdates();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      const pending = closing.queryResponsive({ query: 'shutdown needle' });
      // No await between the two calls, so the worker rejection is still
      // pending when shutdown flips `closed`, matching a real quit racing a
      // live query.
      await closing.close();

      await expect(pending).resolves.toEqual([]);
      // A shutdown cancellation is expected, not a failure worth reporting.
      expect(consoleError).not.toHaveBeenCalledWith(
        'Chat search query failed:',
        expect.anything(),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('deletes all documents for a worktree or project', async () => {
    service.indexLiveTabs(
      'workspace-1',
      'worktree-1',
      tabsFile(makeTab('chat-1', 'One')),
    );
    service.indexLiveTabs(
      'workspace-1',
      'worktree-2',
      tabsFile(makeTab('chat-2', 'Two')),
    );
    service.indexLiveTabs(
      'workspace-2',
      'worktree-3',
      tabsFile(makeTab('chat-3', 'Three')),
    );
    await service.flushPendingUpdates();

    await service.deleteWorktreeDocs('workspace-1', 'worktree-1');
    expect(
      service
        .getCatalog()
        .map((entry) => entry.chatId)
        .sort(),
    ).toEqual(['chat-2', 'chat-3']);

    await service.deleteWorkspaceDocs('workspace-1');
    expect(service.getCatalog().map((entry) => entry.chatId)).toEqual([
      'chat-3',
    ]);
  });

  it('drops and rebuilds a stale schema version', async () => {
    const dbPath = join(dataDir, 'derived', 'stale-chat-search.sqlite');
    await mkdir(dirname(dbPath), { recursive: true });
    const staleDb = new DatabaseSync(dbPath);
    staleDb.exec(
      `CREATE TABLE search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       INSERT INTO search_meta (key, value) VALUES ('schema_version', '1');
       CREATE TABLE chat_docs (doc_id TEXT PRIMARY KEY);
       INSERT INTO chat_docs (doc_id) VALUES ('stale-row');`,
    );
    staleDb.close();

    const migrated = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      dbPath,
    });
    expect(migrated.getCatalog()).toEqual([]);
    await migrated.close();

    const verifiedDb = new DatabaseSync(dbPath, { readOnly: true });
    const row: unknown = verifiedDb
      .prepare(`SELECT value FROM search_meta WHERE key = 'schema_version'`)
      .get();
    expect(row).toEqual({ value: String(CHAT_SEARCH_SCHEMA_VERSION) });
    verifiedDb.close();
  });

  it('adds in-flight text columns to a current-version index in place', async () => {
    // A rebuild re-reads every transcript after an upgrade; additive columns
    // must keep the rows that are already indexed.
    const dbPath = join(dataDir, 'derived', 'additive-chat-search.sqlite');
    await mkdir(dirname(dbPath), { recursive: true });
    const existing = new DatabaseSync(dbPath);
    existing.exec(
      `CREATE TABLE search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       INSERT INTO search_meta (key, value)
         VALUES ('schema_version', '${CHAT_SEARCH_SCHEMA_VERSION}');
       CREATE TABLE chat_docs (
         doc_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
         worktree_id TEXT NOT NULL, chat_id TEXT NOT NULL,
         source TEXT NOT NULL, document_kind TEXT NOT NULL,
         title TEXT NOT NULL, description TEXT, provider_type TEXT,
         updated_at INTEGER NOT NULL, archived_at INTEGER,
         expires_at INTEGER, message_count INTEGER NOT NULL DEFAULT 0,
         review_status TEXT, transcript_fingerprint TEXT);
       CREATE TABLE source_files (file_key TEXT PRIMARY KEY,
         mtime_ms INTEGER NOT NULL, size_bytes INTEGER NOT NULL);
       CREATE VIRTUAL TABLE chat_fts USING fts5(
         doc_id UNINDEXED, title, body, tokenize = 'porter unicode61');
       INSERT INTO chat_docs (doc_id, project_id, worktree_id, chat_id,
         source, document_kind, title, updated_at, message_count)
         VALUES ('p/w/kept/live', 'p', 'w', 'kept', 'live', 'chat', 'Kept',
           1, 1);
       INSERT INTO chat_fts (doc_id, title, body)
         VALUES ('p/w/kept/live', 'Kept', 'upgradeneedle');`,
    );
    existing.close();

    const db = openChatSearchDatabase(dbPath);
    try {
      expect(
        db
          .prepare('PRAGMA table_info(chat_docs)')
          .all()
          .map((column) => column.name),
      ).toEqual(
        expect.arrayContaining(['committed_fingerprint', 'active_fts_rowid']),
      );
      expect(
        queryChatSearchDatabase(db, { query: 'upgradeneedle' }).map(
          (row) => row.chatId,
        ),
      ).toEqual(['kept']);
    } finally {
      db.close();
    }
  });

  it('keeps in-flight text in a separate row that revisions replace alone', () => {
    const db = openChatSearchDatabase(join(dataDir, 'in-flight-rows.sqlite'));
    const indexer = new ChatSearchIndexer(db);
    const base = buildChatSearchDoc(
      'project',
      'worktree',
      'live',
      makeTab('streaming', 'Streaming chat'),
      undefined,
      undefined,
      'committed history needle',
    );
    const committedFingerprint = 'committed-1';
    const rows = (): Array<Record<string, unknown>> =>
      db
        .prepare(
          'SELECT rowid AS id, body FROM chat_fts WHERE doc_id = ? ORDER BY rowid',
        )
        .all(base.docId);
    try {
      indexer.upsertDoc({
        ...base,
        transcriptFingerprint: 'revision-1',
        committedFingerprint,
        activeBody: 'first draft needle',
      });
      const [committedRow] = rows();
      expect(rows().map((row) => row.body)).toEqual([
        'committed history needle',
        'first draft needle',
      ]);
      expect(indexer.getIndexedCommittedFingerprint(base.docId)).toBe(
        committedFingerprint,
      );
      expect(
        indexer.getIndexedBodiesIfTranscriptUnchanged(base.docId, 'revision-1'),
      ).toEqual({
        body: 'committed history needle',
        activeBody: 'first draft needle',
        committedFingerprint,
      });

      // A revision replaces the in-flight row; the committed row is untouched.
      expect(
        indexer.replaceActiveBodyIfCommittedUnchanged({
          ...base,
          body: '',
          transcriptFingerprint: 'revision-2',
          committedFingerprint,
          activeBody: 'second draft needle',
        }),
      ).toBe(true);
      expect(rows()).toEqual([
        committedRow,
        expect.objectContaining({ body: 'second draft needle' }),
      ]);
      expect(queryChatSearchDatabase(db, { query: 'first draft' })).toEqual([]);
      expect(
        queryChatSearchDatabase(db, { query: 'second draft' })[0]?.snippet,
      ).toBe('second draft needle');

      // Pages count documents, not rows.
      indexer.upsertDoc(
        buildChatSearchDoc(
          'project',
          'worktree',
          'live',
          makeTab('other', 'Other chat', [textBlock('other needle')]),
        ),
      );
      const pages = [0, 1, 2].map((offset) =>
        queryChatSearchDatabase(
          db,
          { query: 'needle', limit: 1 },
          Date.now(),
          offset,
        ).map((row) => row.chatId),
      );
      expect(pages.flat().sort()).toEqual(['other', 'streaming']);
      expect(pages[2]).toEqual([]);

      // Another committed prefix, or an unknown doc, needs a full projection.
      expect(
        indexer.replaceActiveBodyIfCommittedUnchanged({
          ...base,
          committedFingerprint: 'committed-2',
          activeBody: 'stale draft',
        }),
      ).toBe(false);
      expect(
        indexer.replaceActiveBodyIfCommittedUnchanged({
          ...base,
          docId: 'project/worktree/unknown/live',
          committedFingerprint,
          activeBody: 'stale draft',
        }),
      ).toBe(false);
      expect(queryChatSearchDatabase(db, { query: 'stale draft' })).toEqual([]);

      // Dropping the sidecar removes the in-flight row.
      expect(
        indexer.replaceActiveBodyIfCommittedUnchanged({
          ...base,
          body: '',
          transcriptFingerprint: 'revision-3',
          committedFingerprint,
        }),
      ).toBe(true);
      expect(rows()).toEqual([committedRow]);
      expect(
        indexer.getIndexedBodiesIfTranscriptUnchanged(base.docId, 'revision-3'),
      ).toEqual({ body: 'committed history needle', committedFingerprint });

      // Scope replacement stages and restores the split.
      const job = indexer.beginStagedScope();
      indexer.stageScopeDoc(job, 0, {
        ...base,
        transcriptFingerprint: 'revision-4',
        committedFingerprint,
        activeBody: 'staged draft needle',
      });
      indexer.commitStagedScope(job, 'project', 'worktree', 'live');
      indexer.discardStagedScope(job);
      expect(rows().map((row) => row.body)).toEqual([
        'committed history needle',
        'staged draft needle',
      ]);
      expect(
        indexer.replaceActiveBodyIfCommittedUnchanged({
          ...base,
          body: '',
          transcriptFingerprint: 'revision-5',
          committedFingerprint,
          activeBody: 'restaged draft needle',
        }),
      ).toBe(true);
      expect(rows().map((row) => row.body)).toEqual([
        'committed history needle',
        'restaged draft needle',
      ]);

      indexer.deleteChatDoc('project', 'worktree', 'streaming', 'live');
      expect(rows()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('builds snippets only for the chats on the returned page', () => {
    // Palette queries run on Electron main. snippet() scans each projected
    // body, so a query must not build snippets for matches outside the page:
    // grouping every match first cost 277 ms for 10,000 matching chats.
    const db = openChatSearchDatabase(join(dataDir, 'page-snippets.sqlite'));
    const indexer = new ChatSearchIndexer(db);
    const doc = (
      chatId: string,
      body: string,
      extra: Partial<ChatSearchDoc> = {},
    ): ChatSearchDoc => ({
      ...buildChatSearchDoc(
        'project',
        'worktree',
        'live',
        makeTab(chatId, chatId),
        undefined,
        undefined,
        body,
      ),
      ...extra,
    });
    // FTS5 resolves snippet() through the virtual table, so a test cannot
    // wrap it. Run the production query with a counting function in its
    // place: SQLite evaluates either one wherever the query computes it.
    let snippetDocIds: unknown[] = [];
    db.function('count_snippet', { varargs: true }, (docId) => {
      snippetDocIds.push(docId);
      return '';
    });
    const prepare = db.prepare.bind(db);
    const snippetsBuilt = (limit: number): unknown[] => {
      snippetDocIds = [];
      const counted = jest.spyOn(db, 'prepare').mockImplementation((sql) => {
        const probed = sql.replace(
          'snippet(chat_fts,',
          'count_snippet(chat_fts.doc_id,',
        );
        expect(probed).not.toBe(sql);
        return prepare(probed);
      });
      try {
        queryChatSearchDatabase(db, { query: 'pageneedle', limit });
        return snippetDocIds;
      } finally {
        counted.mockRestore();
      }
    };
    const huge = doc(
      'huge',
      `${'long transcript filler '.repeat(530_000)} pageneedle`,
    );
    try {
      // Committed and in-flight text both match, as two rows of one chat.
      indexer.upsertDoc(
        doc('streaming', 'pageneedle pageneedle pageneedle', {
          committedFingerprint: 'committed',
          activeBody: 'pageneedle pageneedle pageneedle draft',
        }),
      );
      for (let index = 0; index < 30; index += 1)
        indexer.upsertDoc(doc(`small-${index}`, `pageneedle note ${index}`));
      // One occurrence in 12 MB ranks below every short chat.
      indexer.upsertDoc(huge);

      const page = queryChatSearchDatabase(db, {
        query: 'pageneedle',
        limit: 10,
      }).map((row) => row.chatId);
      expect(page).toHaveLength(10);
      expect(new Set(page).size).toBe(10);
      expect(page[0]).toBe('streaming');
      expect(page).not.toContain('huge');
      expect(
        queryChatSearchDatabase(db, { query: 'pageneedle', limit: 40 }).map(
          (row) => row.chatId,
        ),
      ).toContain('huge');

      // Only a page that includes the 12 MB chat should pay for its snippet.
      const pageSnippets = snippetsBuilt(10);
      expect(pageSnippets.length).toBeLessThanOrEqual(20);
      expect(pageSnippets).not.toContain(huge.docId);
      expect(snippetsBuilt(40)).toContain(huge.docId);
    } finally {
      db.close();
    }
  });

  it('widens the ranked window when one chat has more than two matching rows', () => {
    const db = openChatSearchDatabase(join(dataDir, 'wide-window.sqlite'));
    const indexer = new ChatSearchIndexer(db);
    try {
      for (const chatId of ['crowded', 'second', 'third'])
        indexer.upsertDoc(
          buildChatSearchDoc(
            'project',
            'worktree',
            'live',
            makeTab(chatId, chatId),
            undefined,
            undefined,
            chatId === 'crowded'
              ? 'widenneedle widenneedle widenneedle'
              : 'widenneedle',
          ),
        );
      // More rows than the two-per-chat invariant allows fill the first window.
      const extra = db.prepare(
        'INSERT INTO chat_fts (doc_id, title, body) VALUES (?, ?, ?)',
      );
      for (let index = 0; index < 4; index += 1)
        extra.run(
          'project/worktree/crowded/live',
          'crowded',
          'widenneedle widenneedle widenneedle',
        );

      expect(
        queryChatSearchDatabase(db, { query: 'widenneedle', limit: 2 }).map(
          (row) => row.chatId,
        ),
      ).toEqual(['crowded', expect.stringMatching(/^(second|third)$/)]);
      expect(
        queryChatSearchDatabase(
          db,
          { query: 'widenneedle', limit: 2 },
          Date.now(),
          1,
        ).map((row) => row.chatId),
      ).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('replaces a corrupt derived database with an empty usable index', async () => {
    const dbPath = join(dataDir, 'derived', 'corrupt-chat-search.sqlite');
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, 'not a sqlite database', 'utf8');

    const recovered = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      dbPath,
    });
    expect(recovered.getCatalog()).toEqual([]);
    recovered.indexLiveTabs(
      'workspace-1',
      'worktree-1',
      tabsFile(makeTab('recovered-chat', 'Recovered index')),
    );
    await recovered.flushPendingUpdates();
    expect(recovered.getCatalog()[0]?.chatId).toBe('recovered-chat');
    await recovered.close();
  });
});

describe('chat search body for delegated tasks', () => {
  const card = (transcriptStore?: 'chat-log-v1'): PersistedChatMessage => ({
    id: 'delegated-agent-child',
    role: 'assistant',
    timestamp: 2,
    blocks: [
      {
        type: 'delegated_agent_call',
        agentBlockId: 'delegated-agent-child',
        delegationId: 'child',
        runGeneration: 1,
        sequence: 2,
        parentHarnessId: 'claude',
        parentTurnId: 'prompt',
        parentToolCallId: 'spawn',
        createdAt: 1,
        selectedModelId: 'model',
        runtimeModelId: 'model',
        targetHarnessId: 'claude',
        description: 'Audit the migration',
        prompt: 'Audit it',
        executionMode: 'background',
        status: 'completed',
        outputTruncated: false,
        finalText: 'Found two unsafe writes',
        ...(transcriptStore ? { transcriptStore } : {}),
      },
    ],
  });

  it('indexes a logged card’s task and result, whose children are not rows', () => {
    const body = extractChatSearchBody([card('chat-log-v1')]);
    expect(body).toContain('Audit the migration');
    expect(body).toContain('Found two unsafe writes');
  });

  it('leaves a card with committed children to its child rows', () => {
    expect(extractChatSearchBody([card()])).toBe('');
  });
});
