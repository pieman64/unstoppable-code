/**
 * Readers that bypass the chat state service see committed state of a
 * delta-journal scope, not only its last checkpoint (P1 "File readers that
 * bypass the service"). Each test commits records that stay journaled
 * (metadata and active rows; committed rows are checkpointed before they are
 * acknowledged) and checks one reader:
 *
 * - the chat search indexer: its change fingerprint and its preview capture;
 * - the discovery index behind plugin pruning, and the chat-history scan;
 * - the Work Entry catalog and summary fingerprint (cowork catalog readers);
 * - the memory query context and shared-container publication, which read
 *   through the service;
 * - export, archive capture and split backups, which checkpoint first and
 *   copy version 2 files;
 * - archive restore and portable import, one version 2 transaction.
 *
 * The interrupted-work scan and feedback bundles have their cases in their
 * own suites; restart recovery is in the write-path suite.
 */
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as FsPromisesModule from 'node:fs/promises';
import type {
  ChatCoreMutation,
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { getWorkspaceChatTabsFilePath } from '../lib/paths';
import {
  assertChatStorageIndexes,
  ChatStorageV2,
} from '../lib/chat-storage-v2';
import {
  ChatStorageNewerFormatError,
  DELTA_JOURNAL_FILE_NAME,
  FRAME_HEADER_BYTES,
  scanDeltaJournalFrames,
} from '../lib/chat-delta-journal/format';
import {
  readReplayedChatIndexes,
  summarizeDeltaJournal,
} from '../lib/chat-delta-journal/reader';
import { readChatStorageDiscoveryIndex } from '../lib/chat-storage-discovery';
import {
  hasEverSentChatMessage,
  resetChatHistoryScanForTests,
} from '../lib/chat-history-scan';
import {
  readChatTabsFile,
  readChatTranscript,
  readPersistedChatDispatchMetadata,
} from '../lib/chat-tabs-reader';
import {
  createWorkEntry,
  listWorkEntries,
  readWorkEntriesFile,
  readWorkEntryChatCatalog,
  summarySourcePath,
  syncWorkEntrySummaryFromWrite,
} from '../lib/cowork-work-entries';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { ChatSearchService } from '../chat-search/service';
import { ChatSearchIndexer } from '../chat-search/indexer';
import {
  ChatStateService,
  getChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { ChatStateRepositoryLoadError } from '../services/chat-state-contracts';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import { readChildStreamCompatibilityPage } from '../lib/chat-delta-journal/child-overlay';
import type { ChildStreamSequenceEntry } from '../lib/child-stream-sequence-index';
import { scopeSource } from './helpers/chat-delta-journal-harness';
import {
  manifestVersion,
  streaming,
  text,
  toolResult,
  upsert,
} from './helpers/chat-delta-journal-scope';

jest.mock('../observability', () => ({
  getObservabilityService: (): { recordSessionDiagnostic: jest.Mock } => ({
    recordSessionDiagnostic: jest.fn(),
  }),
}));
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): never[] => [] },
}));
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
  return { ...actual };
});

const SCOPE = { projectId: 'workspace-r', worktreeId: 'worktree-r' };

function repository(): ChatStateV2Repository {
  const value: unknown = Reflect.get(getChatStateService(), 'repository');
  if (!(value instanceof ChatStateV2Repository))
    throw new Error('Missing chat state repository');
  return value;
}

function store(scope = SCOPE): ChatStorageV2 {
  const tabs = getWorkspaceChatTabsFilePath(scope.projectId, scope.worktreeId);
  return ChatStorageV2.fromLegacyPaths({
    tabs,
    archives: `${tabs}.archives`,
    journal: `${tabs}.journal`,
  });
}

async function pending(scope = SCOPE): Promise<number> {
  const target = store(scope);
  return (
    await summarizeDeltaJournal({
      directory: target.directory,
      scopeId: scope.worktreeId,
    })
  ).recordCount;
}

async function commit(
  mutations: ChatCoreMutation[],
  mutationId: string,
  scope = SCOPE,
): Promise<void> {
  await repository().transact(scope, mutations, {
    source: 'provider',
    mutationId,
  });
}

function tab(id: string, title: string): PersistedChatTab {
  return {
    id,
    title,
    createdAt: '2026-10-01T00:00:00.000Z',
    providerType: 'claude',
    messages: [text(`${id}-user`, 'opening words', 'user')],
  };
}

function tabsFile(...tabs: PersistedChatTab[]): ChatTabsFile {
  return { version: 1, tabs, activeTabId: tabs[0]?.id ?? '' };
}

async function storageSnapshot(
  root: string,
): Promise<Array<[string, string, number]>> {
  const result: Array<[string, string, number]> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const [bytes, metadata] = await Promise.all([
          readFile(path),
          stat(path),
        ]);
        result.push([
          path.slice(root.length + 1),
          createHash('sha256').update(bytes).digest('hex'),
          metadata.mtimeMs,
        ]);
      }
    }
  };
  await visit(root);
  return result.sort(([left], [right]) => left.localeCompare(right));
}

describe('delta journal readers', () => {
  let dataDir: string;
  const previous = process.env.CANOPY_DATA_DIR;
  jest.setTimeout(60_000);

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'chat-delta-journal-readers-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    resetResolvedCanopyDataDirForTests();
    // These readers must observe records that only the journal holds, so no
    // idle checkpoint may fold them into the files mid-test, even on a host
    // slow enough for a scan to outlast the default one-second idle window.
    resetChatStateServiceForTests(
      new ChatStateService({
        repository: new ChatStateV2Repository({
          deltaJournalIdleCheckpointMs: 3_600_000,
        }),
      }),
    );
    resetChatHistoryScanForTests();

    await getChatStateService().replaceCompatibilityTabs(
      SCOPE,
      tabsFile(tab('chat', 'Alpha')),
      { authoritative: true },
    );
    expect(await manifestVersion(store())).toBe(3);
  });

  afterEach(async () => {
    await getChatStateService().drain();
    resetChatStateServiceForTests();

    if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previous;
    resetResolvedCanopyDataDirForTests();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('accounts decoded pending child rows separately from committed page bytes', async () => {
    const pending: DelegationChildRow = {
      id: 'delegated-agent-child-1:pending',
      role: 'assistant',
      timestamp: 2,
      parentBlockId: 'delegated-agent-child-1',
      delegationSequence: 2,
      itemRevision: 0,
      final: true,
      blocks: [{ type: 'text', text: 'pending row payload' }],
    };
    const committed: ChildStreamSequenceEntry = {
      id: 'delegated-agent-child-1:committed',
      delegationSequence: 1,
      offset: 0,
      end: 128,
    };
    const pendingBytes = Buffer.byteLength(JSON.stringify(pending), 'utf8');
    const readCommittedRow = jest.fn(
      (): Promise<DelegationChildRow> =>
        Promise.resolve({
          ...pending,
          id: committed.id,
          delegationSequence: committed.delegationSequence,
        }),
    );

    const page = await readChildStreamCompatibilityPage(
      [committed],
      [],
      [pending],
      readCommittedRow,
      (row) => row.id,
      {
        limit: 10,
        physicalByteBudget: pendingBytes,
        encodedBudget: 1024,
      },
    );

    expect(page).toEqual({
      items: [pending.id],
      hasMore: true,
      physicalBytes: 0,
      activeBytes: 0,
      pendingBytes,
    });
    expect(readCommittedRow).not.toHaveBeenCalled();
  });

  it('chat search: rescans journaled metadata and indexes journaled active rows', async () => {
    const search = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => new ChatSearchIndexer(db),
      debounceMs: 60_000,
      broadcastDebounceMs: 10,
      broadcastUpdated: (): void => undefined,
    });
    try {
      await commit(
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { title: 'Bravo' },
          },
        ],
        'bravo',
      );
      expect(await pending()).toBe(1);
      await search.scanAllSources();
      expect(search.getCatalog()[0]?.title).toBe('Bravo');
      // A second journaled change still reaches the next scan: the source
      // fingerprint follows the journal, not only the checkpointed index.
      await commit(
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { title: 'Charlie' },
          },
        ],
        'charlie',
      );
      expect(await pending()).toBe(2);
      await search.scanAllSources();
      expect(search.getCatalog()[0]?.title).toBe('Charlie');
      // In-flight text lives only in journal records.
      await commit(
        [streaming('chat', 'p'), upsert('chat', text('p', 'question', 'user'))],
        'turn',
      );
      await commit([upsert('chat', text('a', 'zebranium answer'))], 'active');
      expect(await pending()).toBe(1);
      const canonical = await getChatStateService().getCompatibilityTabs(SCOPE);
      search.indexLiveTabs(SCOPE.projectId, SCOPE.worktreeId, canonical);
      await search.flushPendingUpdates();
      expect(
        search.query({ query: 'zebranium' }).map((row) => row.chatId),
      ).toEqual(['chat']);
    } finally {
      await search.close();
    }
  });

  it('discovery index (plugin pruning, interrupted work): replays journaled metadata', async () => {
    await commit(
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { title: 'Discovered' },
        },
      ],
      'discovered',
    );
    const index = await readChatStorageDiscoveryIndex(
      join(dataDir, 'workspaces', SCOPE.projectId),
      SCOPE.worktreeId,
    );
    expect(index.pendingJournal).toBe(true);
    expect(index.tabs.map((entry) => entry.title)).toEqual(['Discovered']);
  });

  it('chat-history scan: counts a user message only the journal holds', async () => {
    const scope = { projectId: 'workspace-h', worktreeId: 'history' };
    await store(scope).migrate(
      scopeSource([{ id: 'chat', messages: [text('a0', 'assistant only')] }]),
    );
    await repository().getState(scope);
    expect(await hasEverSentChatMessage()).toBe(true);
    resetChatHistoryScanForTests();
    // Only the history scope remains, assistant-only so far.
    await getChatStateService().deleteScope(SCOPE);
    expect(await hasEverSentChatMessage()).toBe(false);
    resetChatHistoryScanForTests();
    // A streamed tool result after an assistant row is a user-role row of
    // the active turn: journaled, never checkpointed yet.
    await commit(
      [streaming('chat', 'a0'), upsert('chat', text('a1', 'running a tool'))],
      'turn',
      scope,
    );
    await commit([upsert('chat', toolResult('t', 'output'))], 'tool', scope);
    expect(await pending(scope)).toBe(2);
    expect(await hasEverSentChatMessage()).toBe(true);
  });

  it('Work Entry catalog and summary source: follow the journal', async () => {
    await getChatStateService().replaceCompatibilityTabs(
      SCOPE,
      tabsFile(tab('chat', 'Alpha'), tab('second', 'Second')),
      { authoritative: true },
    );
    // Archiving is metadata only: it stays journaled.
    const state = await repository().getState(SCOPE);
    const second = state.tabsFile.tabs.find((entry) => entry.id === 'second');
    if (!second) throw new Error('Missing chat');
    await commit(
      [
        { type: 'tab.removed', tabId: 'second' },
        {
          type: 'archive.upserted',
          entry: { tab: second, archivedAt: '2026-10-01', turnCount: 1 },
        },
      ],
      'archive',
    );
    expect(await pending()).toBe(1);
    expect(
      await readWorkEntryChatCatalog(SCOPE.projectId, SCOPE.worktreeId),
    ).toEqual({
      liveChatIds: ['chat'],
      archives: [{ chatId: 'second', archivedAt: '2026-10-01' }],
    });
    const source = await summarySourcePath(SCOPE.projectId, SCOPE.worktreeId);
    expect(source.endsWith('delta-journal.log')).toBe(true);
    const before = (await stat(source, { bigint: true })).mtimeNs;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await commit(
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      'unread',
    );
    expect((await stat(source, { bigint: true })).mtimeNs).not.toBe(before);
  });

  it('Work Entry summary: a checkpoint after a commit does not make the next listing backfill', async () => {
    const workspaceId = APP_ADVISOR_PROJECT_ID;
    const { entry } = await createWorkEntry(workspaceId);
    const scope = { projectId: workspaceId, worktreeId: entry.id };
    await getChatStateService().replaceCompatibilityTabs(
      scope,
      tabsFile(tab('chat', 'Alpha')),
      { authoritative: true },
    );
    expect(await manifestVersion(store(scope))).toBe(3);
    await commit(
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      'unread',
      scope,
    );
    await syncWorkEntrySummaryFromWrite(
      workspaceId,
      entry.id,
      await getChatStateService().getCompatibilityTabs(scope),
    );
    const journal = await summarySourcePath(workspaceId, entry.id);
    const committedMtimeNs = (
      await stat(journal, { bigint: true })
    ).mtimeNs.toString();
    const stamp = async (): Promise<string | undefined> =>
      (await readWorkEntriesFile(workspaceId)).entries.find(
        (candidate) => candidate.id === entry.id,
      )?.summary?.sourceMtimeNs;
    expect(await stamp()).toBe(committedMtimeNs);

    // Checkpoint only after the committed stamp is recorded. The suite's
    // one-hour idle window keeps the timer from rotating the journal first,
    // and flushScope takes the same checkpoint path as the idle timer.
    await repository().flushScope(scope);
    expect(await pending(scope)).toBe(0);
    const checkpointedMtimeNs = (
      await stat(journal, { bigint: true })
    ).mtimeNs.toString();
    // The checkpoint hook refreshes the stamp asynchronously. A rotation that
    // keeps the mtime (coarse clock) skips the hook, and the stamp is current.
    const deadline = Date.now() + 5_000;
    while ((await stamp()) !== checkpointedMtimeNs) {
      if (Date.now() > deadline)
        throw new Error(
          'The checkpoint did not carry the summary stamp to the new journal',
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const reads = jest.spyOn(getChatStateService(), 'getCompatibilityTabs');
    try {
      expect(await listWorkEntries(workspaceId)).toEqual([
        expect.objectContaining({
          id: entry.id,
          unreadChats: [expect.objectContaining({ chatId: 'chat' })],
        }),
      ]);
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  });

  it('dispatch metadata preserves the history fact from thin canonical projections', async () => {
    const thin = await readChatTabsFile(SCOPE.projectId, SCOPE.worktreeId);
    expect(thin.tabs[0]?.transcript?.messageCount).toBeGreaterThan(0);
    const metadata = await readPersistedChatDispatchMetadata(
      SCOPE.projectId,
      SCOPE.worktreeId,
      'chat',
    );
    expect(metadata.hasConversation).toBe(true);
  });

  it('memory query context and shared-container publication: read journaled rows through the service', async () => {
    await commit(
      [streaming('chat', 'p'), upsert('chat', text('p', 'prompt', 'user'))],
      'turn',
    );
    await commit([upsert('chat', text('a', 'journaled reply'))], 'reply');
    await commit(
      [{ type: 'tab.metadata_patched', tabId: 'chat', patch: { title: 'Q' } }],
      'title',
    );
    expect(await pending()).toBe(2);
    const tabs = await readChatTabsFile(SCOPE.projectId, SCOPE.worktreeId, {
      chatIds: ['chat'],
      fullTranscript: true,
    });
    expect(tabs.tabs[0].title).toBe('Q');
    expect(tabs.tabs[0].messages.map((row) => row.id)).toEqual([
      'chat-user',
      'p',
      'a',
    ]);
    expect(
      (await readChatTranscript(SCOPE.projectId, SCOPE.worktreeId, 'chat')).map(
        (row) => row.id,
      ),
    ).toEqual(['chat-user', 'p', 'a']);
  });

  it('export, archive capture and split backups: checkpoint first and copy version 2 files', async () => {
    await commit(
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { title: 'Exported' },
        },
      ],
      'exported',
    );
    expect(await pending()).toBe(1);
    const destination = new ChatStorageV2(join(dataDir, 'export'), 'copy');
    await getChatStateService().captureStorageScope(SCOPE, destination);
    expect(await pending()).toBe(0);
    expect(await destination.format()).toBe('v2');
    const copied = await new ChatStateV2Backend(destination).state();
    expect(copied.tabsFile.tabs[0].title).toBe('Exported');
  });

  it('archive restore and portable import: one version 2 transaction, then the journal again', async () => {
    await commit(
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      'journaled',
    );
    const source = new ChatStorageV2(join(dataDir, 'bundle'), 'bundle');
    await source.migrate(
      scopeSource([
        { id: 'restored', messages: [text('r0', 'restored chat', 'user')] },
      ]),
    );
    const metadata = await new ChatStateV2Backend(source).state();
    await getChatStateService().importStorageScope(
      SCOPE,
      source,
      metadata.tabsFile,
      metadata.archivesFile,
      { merge: true, mutationId: 'restore' },
    );
    const deadline = Date.now() + 5000;
    while ((await manifestVersion(store())) !== 3 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await manifestVersion(store())).toBe(3);
    const state = await repository().getState(SCOPE);
    expect(state.tabsFile.tabs.map((entry) => entry.id).sort()).toEqual([
      'chat',
      'restored',
    ]);
    expect(
      state.tabsFile.tabs.find((entry) => entry.id === 'chat')?.unread,
    ).toBe(true);
  });
  it('refuses a future record during lease-free replay and repository admission without writing', async () => {
    const target = store();
    const journalPath = join(target.directory, DELTA_JOURNAL_FILE_NAME);
    const frames = scanDeltaJournalFrames(await readFile(journalPath)).frames;
    const prev = frames.at(-1)?.digest;
    if (!prev) throw new Error('Expected a delta-journal segment');
    const payload = Buffer.from(JSON.stringify({ type: 'commit', v: 2, prev }));
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.write('CDJ1', 0, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    createHash('sha256').update(payload).digest().copy(header, 8);
    await appendFile(journalPath, Buffer.concat([header, payload]));
    const root = dirname(dirname(target.directory));
    const before = await storageSnapshot(root);

    await expect(
      readReplayedChatIndexes(
        { directory: target.directory, scopeId: SCOPE.worktreeId },
        assertChatStorageIndexes,
      ),
    ).rejects.toThrow(ChatStorageNewerFormatError);
    const fresh = new ChatStateV2Repository({
      deltaJournalIdleCheckpointMs: 3_600_000,
    });
    const error = await fresh.getState(SCOPE).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ChatStateRepositoryLoadError);
    expect(error instanceof Error && error.cause).toBeInstanceOf(
      ChatStorageNewerFormatError,
    );
    expect(fresh.getLifecycle(SCOPE)).toBe('recovery_error');
    expect(await fresh.getState(SCOPE).catch((cause: unknown) => cause)).toBe(
      error,
    );
    expect(fresh.getStorageDiagnostics(SCOPE)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'delta_journal_newer_format' }),
      ]),
    );
    expect(await storageSnapshot(root)).toEqual(before);
  });
});
