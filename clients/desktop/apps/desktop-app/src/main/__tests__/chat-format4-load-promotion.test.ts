import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import type { ChatStateV2RepositoryOptions } from '../services/chat-state-v2-repository';
import {
  ChatDeltaJournalWriter,
  promoteToFormat4Journal,
} from '../lib/chat-delta-journal/writer';
import * as writerModule from '../lib/chat-delta-journal/writer';
import * as journalReader from '../lib/chat-delta-journal/replay';
import fs from 'node:fs/promises';
import * as delegationRecovery from '../agents/delegation/recovery';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import { ChatStateRepositoryLoadError } from '../services/chat-state-contracts';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { DeltaJournalBoundary } from '../lib/chat-delta-journal/writer';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import * as workspaceRegistry from '../lib/workspace-registry';
import { getArchivedContainerDir } from '../lib/paths';
import {
  resolveChatTabsFilePath,
  resolveChatArchivesFilePath,
  resolveChatJournalFilePath,
} from '../lib/resolve-worktree';
import {
  commitArchivedContainer,
  readArchivedContainerChats,
} from '../lib/archived-containers';
import {
  getStandaloneHistoryStorage,
  writeArchiveSnapshot,
  readArchiveSnapshot,
} from '../lib/standalone-history';
import { snapshotFormat4Files } from './helpers/chat-format4-scope';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import {
  drainAfterTest,
  drainOpenRepositories,
  streaming,
} from './helpers/chat-delta-journal-scope';

const scope = { projectId: 'project', worktreeId: 'scope' };
const pathsAt = (
  root: string,
): { tabs: string; archives: string; journal: string } => ({
  tabs: join(root, 'chats', 'scope.json'),
  archives: join(root, 'chat-archives', 'scope.json'),
  journal: join(root, 'chat-journals', 'scope.jsonl'),
});

describe('format-4 ordered repository load promotion (S2)', () => {
  let root: string;
  const previousDataDir = process.env.CANOPY_DATA_DIR;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'format4-load-'));
    process.env.CANOPY_DATA_DIR = root;
    resetResolvedCanopyDataDirForTests();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await drainOpenRepositories();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    resetResolvedCanopyDataDirForTests();
    await rm(root, { recursive: true, force: true });
  });

  function repository(
    options: ChatStateV2RepositoryOptions = {},
    at = root,
  ): ChatStateV2Repository {
    return drainAfterTest(
      new ChatStateV2Repository({
        resolvePaths: () => pathsAt(at),
        enableFormat4: true,
        deltaJournalIdleCheckpointMs: 60_000,
        ...options,
      }),
    );
  }

  async function seed(
    version: 2 | 3 = 3,
    at = root,
  ): Promise<{ store: ChatStorageV2; backend: ChatStateV2Backend }> {
    const store = ChatStorageV2.fromLegacyPaths(pathsAt(at));
    await store.migrate(
      scopeSource([
        { id: 'chat', messages: [message('initial', 'Initial', 'user')] },
      ]),
    );
    const backend = new ChatStateV2Backend(store, {
      enableFormat4: true,
      deltaJournal: {},
    });
    if (version === 3) await backend.promoteToDeltaJournal();
    return { store, backend };
  }

  it('promotes an already-journaled v3 scope after recovery and ready', async () => {
    const { store } = await seed();
    const target = repository();
    const checkpoint = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'checkpoint',
    );
    await target.getState(scope, { fullTranscript: true });
    expect(await store.format()).toBe('v4');
    expect(target.getLifecycle(scope)).toBe('ready');
    expect(checkpoint).toHaveBeenCalled();
    expect(await target.getRevision(scope)).toBe(0);
  });

  it('re-enters a checkpointed format-4 journal after a large mutation with the option off', async () => {
    const seeded = await seed();
    seeded.backend.releaseJournal();
    const promoter = new ChatStateV2Backend(seeded.store, {
      enableFormat4: true,
      deltaJournal: {},
    });
    await promoter.load();
    await promoter.promoteToFormat4();
    promoter.releaseJournal();
    const target = repository({
      enableFormat4: false,
      deltaJournalLargeRecordBytes: 4096,
    });
    const format = jest.spyOn(ChatStorageV2.prototype, 'format');
    await target.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('large', '漢'.repeat(3000)),
        },
      ],
      { source: 'provider', chatIds: ['chat'] },
    );
    await target.flushScope(scope);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = format.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Handling a selected format 4 never waits on the option, and nothing
    // keeps re-queueing reconciliation once the journal is re-entered.
    expect(format.mock.calls.length).toBe(settled);
    expect(await seeded.store.format()).toBe('v4');
    expect(await seeded.store.journalFile()).toBeDefined();
  });

  it('arms an independent 3→4 retry only after durable activity and expiry', async () => {
    const { store } = await seed();
    let now = 10_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const backend = new ChatStateV2Backend(store, {
      enableFormat4: true,
      deltaJournal: {
        promotionRetry: { delayMs: 100 },
        onBoundary: async (point): Promise<void> => {
          if (point === 'manifest-temp-written')
            throw new Error('promotion-fault');
          await Promise.resolve();
        },
      },
    });
    await backend.load();
    await backend.promoteToFormat4().catch(() => false);
    now += 100;
    expect(backend.wantsRepromotion()).toBe(false);
    await backend.transact(
      () => [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('activity', 'Activity', 'user'),
        },
      ],
      { source: 'provider', mutationId: 'activity' },
    );
    expect(backend.wantsRepromotion()).toBe(true);
  });

  it('removes an empty unselected v2 segment on journaled load but retains the catalog', async () => {
    const { store } = await seed();
    await expect(
      promoteToFormat4Journal(store, {
        onBoundary: async (point) => {
          if (point === 'manifest-temp-written')
            throw new Error('before-publication');
          await Promise.resolve();
        },
      }),
    ).rejects.toThrow('before-publication');
    const segment = join(store.directory, 'delta-journal-v2.log');
    const catalog = join(
      store.directory,
      'transcripts',
      'delegations',
      'stream-catalog.json',
    );
    // Capture the actual layout; the catalog is never a journal-cleanup target.
    const before = await readFile(segment);
    const catalogBefore = await readFile(catalog);
    expect(before.length).toBeGreaterThan(0);
    const target = repository({ enableFormat4: false });
    await target.getState(scope);
    await expect(readFile(segment)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.format()).toBe('v3');
    expect(await readFile(catalog)).toEqual(catalogBefore);
  });

  const boundaries: DeltaJournalBoundary[] = [
    'checkpoint-transcripts-applied',
    'checkpoint-metadata-staged',
    'checkpoint-publishing-marked',
    'checkpoint-indexes-published',
    'checkpoint-journal-rotated',
    'marker-removed',
    'catalog-temp-written',
    'catalog-temp-synced',
    'segment-temp-written',
    'segment-temp-synced',
    'segment-renamed',
    'segment-directory-synced',
    'manifest-temp-written',
    'manifest-temp-synced',
    'manifest-published',
    'manifest-directory-synced',
    'writer-reopened',
  ];
  const faults = [...boundaries, 'verify', 'v1-cleanup', 'reopen'] as const;

  it.each(faults)(
    'continues and reopens a pre-close crash image after %s without losing acknowledged rows',
    async (fault) => {
      const live = join(root, 'live');
      const crash = join(root, 'crash');
      const { store, backend } = await seed(3, live);
      await backend.transact(
        () => [
          streaming('chat', 'initial'),
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: message('pending', 'Pending v3 row'),
          },
        ],
        { source: 'provider', mutationId: 'pending' },
      );
      expect(backend.pendingJournalRecords()).toBe(1);
      let injected = false;
      let promoting = false;
      let retired: ChatDeltaJournalWriter | undefined;
      const originalPromotion = writerModule.promoteToFormat4Journal;
      jest
        .spyOn(writerModule, 'promoteToFormat4Journal')
        .mockImplementation(async (selected, options) => {
          promoting = true;
          retired = options?.writer;
          return originalPromotion(selected, options);
        });
      const stop = async (): Promise<void> => {
        injected = true;
        // Snapshot at the fault itself, before fallback recovery/close can fix it.
        await cp(live, crash, { recursive: true });
        throw new Error(`fault:${fault}`);
      };
      const originalRead = journalReader.readDeltaJournal;
      jest
        .spyOn(journalReader, 'readDeltaJournal')
        .mockImplementation(async (...args) => {
          if (
            fault === 'verify' &&
            promoting &&
            !injected &&
            retired &&
            !retired.isOpen()
          )
            await stop();
          return originalRead(...args);
        });
      const originalRm = fs.rm;
      jest.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
        if (
          fault === 'v1-cleanup' &&
          promoting &&
          !injected &&
          path === join(store.directory, 'delta-journal.log')
        )
          await stop();
        return originalRm(path, options);
      });
      const originalOpen = ChatDeltaJournalWriter.open.bind(
        ChatDeltaJournalWriter,
      );
      jest
        .spyOn(ChatDeltaJournalWriter, 'open')
        .mockImplementation(async (selected, options) => {
          if (
            fault === 'reopen' &&
            promoting &&
            !injected &&
            (await selected.format()) === 'v4'
          )
            await stop();
          return originalOpen(selected, options);
        });
      const target = repository(
        {
          deltaJournalOnBoundary: async (point) => {
            if (!injected && point === fault) await stop();
          },
        },
        live,
      );
      const state = await target.getState(scope, {
        chatIds: ['chat'],
        fullTranscript: true,
      });
      expect(injected).toBe(true);
      expect(target.getLifecycle(scope)).toBe('ready');
      const published = [
        'manifest-published',
        'manifest-directory-synced',
        'writer-reopened',
        'v1-cleanup',
        'reopen',
      ].includes(fault);
      expect(await store.format()).toBe(published ? 'v4' : 'v3');
      expect(state.tabsFile.tabs[0]?.messages.map((row) => row.blocks)).toEqual(
        [
          [{ type: 'text', text: 'Initial' }],
          [{ type: 'text', text: 'Pending v3 row' }],
        ],
      );
      expect(await target.getRevision(scope)).toBe(1);
      if (!retired) throw new Error('Promotion did not receive its old writer');
      expect(retired.isOpen()).toBe(false);
      await expect(
        retired.commit({
          expectedRevision: 1,
          next: await store.indexes(),
          writes: [],
          mutationIds: ['stale'],
        }),
      ).rejects.toThrow();
      await target.transact(
        scope,
        [
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: message('continued', 'Continued', 'user'),
          },
        ],
        { source: 'provider', mutationId: 'continued' },
      );
      expect(await target.getRevision(scope)).toBe(2);
      const imageStore = ChatStorageV2.fromLegacyPaths(pathsAt(crash));
      const image = repository({ enableFormat4: false }, crash);
      const imageState = await image.getState(scope, {
        chatIds: ['chat'],
        fullTranscript: true,
      });
      expect(await image.getRevision(scope)).toBe(1);
      expect(
        imageState.tabsFile.tabs[0]?.messages.map((row) => row.id),
      ).toEqual(['initial', 'pending']);
      expect(await imageStore.format()).toBe(published ? 'v4' : 'v3');
      if (published) {
        await retainPostPublicationChild(target, live);
        await retainPostPublicationChild(image, crash);
      }
      // A fresh repository, not close/reopen of the writer being tested, resumes twice.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const resumed = repository({}, crash);
        await resumed.getState(scope);
        expect(await imageStore.format()).toBe('v4');
        expect(await resumed.getRevision(scope)).toBe(published ? 3 : 1);
      }
    },
    // Real fsyncs on two scope copies; allow for a loaded host.
    30_000,
  );

  it.each([false, true])(
    'bounds retry to initial + five, including 2→3 success=%s',
    async (demote) => {
      const { store } = await seed();
      let now = 1_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      let attempts = 0;
      const target = repository({
        deltaJournalPromotionRetryMs: 10,
        ...(demote ? { deltaJournalLargeRecordBytes: 1 } : {}),
        deltaJournalOnBoundary: (point) => {
          if (point === 'catalog-temp-written') {
            attempts += 1;
            return Promise.reject(new Error('persistent-catalog-fault'));
          }
          return Promise.resolve();
        },
      });
      await target.getState(scope);
      expect(attempts).toBe(1);
      const idlePoint = async (): Promise<void> => {
        await target.transact(scope, [], { source: 'provider' });
        await target.getRevision(scope); // Drain queued reconciliation, not a timer/sleep.
      };
      now = 1_010;
      await idlePoint();
      expect(attempts).toBe(1); // Expired, but no activity.
      let failedAt = 1_000;
      for (const [index, delay] of [10, 20, 40, 80, 160].entries()) {
        now = index === 0 ? 1_010 : failedAt + delay - 1;
        await target.transact(
          scope,
          [
            {
              type: 'message.upserted',
              chatId: 'chat',
              message: message(`retry-${index}`, 'Activity', 'user'),
            },
          ],
          { source: 'provider', mutationId: `retry-${index}` },
        );
        await target.getRevision(scope);
        // The first attempt failed at 1000 (not the 1010 idle point).
        if (index === 0) {
          // This first activity is already after its backoff; it may retry now.
          expect(attempts).toBe(2);
        } else {
          expect(attempts).toBe(index + 1);
          now += 1;
          await idlePoint();
          expect(attempts).toBe(index + 2);
        }
        failedAt = now;
      }
      now += 1_000_000;
      await target.transact(
        scope,
        [
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: message('exhausted', 'Still writable', 'user'),
          },
        ],
        { source: 'provider', mutationId: 'exhausted' },
      );
      await idlePoint();
      expect(attempts).toBe(6);
      expect(await store.format()).toBe('v3');
      expect(await target.getRevision(scope)).toBe(6);
      expect(target.getLifecycle(scope)).toBe('ready');
    },
  );

  it('recovers the compatibility WAL and commits delegation recovery before checkpoint/promotion', async () => {
    const { store } = await seed(2);
    const wal = new ChatStorageTransactions(store, (point) =>
      point === 'journal'
        ? Promise.reject(new Error('wal-fault'))
        : Promise.resolve(),
    );
    const next = await wal.load();
    next.live.revision = next.archive.revision = 1;
    const chat = next.live.tabs[0];
    if (!chat) throw new Error('Missing fixture chat');
    chat.title = 'WAL recovered';
    await expect(
      wal.commit(0, next, [
        {
          kind: 'append',
          chatId: 'chat',
          messages: [message('wal', 'WAL row', 'user')],
        },
      ]),
    ).rejects.toThrow('wal-fault');
    const events: string[] = [];
    jest
      .spyOn(delegationRecovery, 'hasDelegationRecoveryRecords')
      .mockResolvedValue(true);
    jest
      .spyOn(delegationRecovery, 'loadDelegationRecoveryMutations')
      .mockImplementation(async (_scope, tabs) => {
        expect(tabs.tabs[0]?.title).toBe('WAL recovered');
        expect(tabs.tabs[0]?.messages.map((row) => row.id)).toEqual([
          'initial',
          'wal',
        ]);
        expect(
          await readFile(
            join(store.directory, 'metadata-journal.jsonl'),
            'utf8',
          ),
        ).toBe('');
        events.push('wal-recovered');
        return [
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: message('recovery', 'Delegation recovery', 'user'),
          },
        ];
      });
    const originalPromotion = writerModule.promoteToFormat4Journal;
    jest
      .spyOn(writerModule, 'promoteToFormat4Journal')
      .mockImplementation(async (selected, options) => {
        expect(target.getLifecycle(scope)).toBe('ready');
        expect(options?.writer?.revision).toBe(2);
        expect((await selected.indexes()).recovery.mutationIds).toEqual([
          expect.stringMatching(/^delegation-recovery:/),
        ]);
        events.push('promotion-after-ready');
        return originalPromotion(selected, options);
      });
    const checkpoint = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'checkpoint',
    );
    const originalCheckpoint = checkpoint.getMockImplementation();
    if (!originalCheckpoint) throw new Error('Missing original checkpoint');
    checkpoint.mockImplementation(function (this: ChatDeltaJournalWriter) {
      events.push('checkpoint');
      return originalCheckpoint.call(this);
    });
    const target = repository();
    const state = await target.getState(scope, {
      chatIds: ['chat'],
      fullTranscript: true,
    });
    expect(events).toEqual([
      'wal-recovered',
      'promotion-after-ready',
      'checkpoint',
    ]);
    expect(state.tabsFile.tabs[0]?.messages.map((row) => row.id)).toEqual([
      'initial',
      'wal',
      'recovery',
    ]);
    expect(await target.getRevision(scope)).toBe(2);
    expect(await store.format()).toBe('v4');
  });

  it.each([
    ['reopen', 'catalog-temp-written', 'v3'],
    ['recovery', 'catalog-temp-written', 'v3'],
    ['reopen', 'manifest-published', 'v4'],
    ['recovery', 'manifest-published', 'v4'],
  ] as const)(
    'reports storage failure, not loaded, when fallback %s fails at %s',
    async (failure, boundary, selected) => {
      const live = join(root, 'live');
      const crash = join(root, 'crash');
      const { store } = await seed(3, live);
      let broken = false;
      const target = repository(
        {
          deltaJournalOnBoundary: async (point) => {
            if (point === boundary) {
              await cp(live, crash, { recursive: true });
              broken = true;
              throw new Error('publication-fault');
            }
          },
        },
        live,
      );
      if (failure === 'reopen') {
        const original = ChatDeltaJournalWriter.open.bind(
          ChatDeltaJournalWriter,
        );
        jest
          .spyOn(ChatDeltaJournalWriter, 'open')
          .mockImplementation(async (...args) => {
            if (broken) throw new Error('fallback-reopen-fault');
            return original(...args);
          });
      } else {
        const recover = jest.spyOn(
          ChatDeltaJournalWriter.prototype,
          'hasCommittedRowChanges',
        );
        const original = recover.getMockImplementation();
        if (!original) throw new Error('Missing original recovery check');
        recover.mockImplementation(function (this: ChatDeltaJournalWriter) {
          if (broken) throw new Error('fallback-recovery-fault');
          return original.call(this);
        });
      }
      await expect(target.getState(scope)).rejects.toBeInstanceOf(
        ChatStateRepositoryLoadError,
      );
      expect(target.getLifecycle(scope)).toBe('recovery_error');
      expect(await store.format()).toBe(selected);
      const image = repository({ enableFormat4: false }, crash);
      await expect(image.getState(scope)).rejects.toBeInstanceOf(
        ChatStateRepositoryLoadError,
      );
      expect(image.getLifecycle(scope)).toBe('recovery_error');
      jest.restoreAllMocks();
      expect(await image.releaseScope(scope)).toBe(true);
      expect(
        (await image.getState(scope)).tabsFile.tabs.map((tab) => tab.id),
      ).toEqual(['chat']);
      expect(image.getLifecycle(scope)).toBe('ready');
    },
  );

  it.each(['off', 'viewer'] as const)(
    'does not promote %s (control)',
    async (lane) => {
      const { store } = await seed();
      const promote = jest.spyOn(writerModule, 'promoteToFormat4Journal');
      await repository({ enableFormat4: lane !== 'off' }).getState(
        lane === 'viewer'
          ? { ...scope, projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID }
          : scope,
      );
      expect(await store.format()).toBe('v3');
      expect(promote).not.toHaveBeenCalled();
    },
  );

  it('does not promote a real standalone archive read (control)', async () => {
    await writeArchiveSnapshot('cowork-workspace', 'archived-chat', {
      version: 1,
      projectId: 'cowork-workspace',
      chatId: 'archived-chat',
      archivedAt: '2026-10-01',
      tab: {
        id: 'archived-chat',
        title: 'Archive',
        createdAt: '2026-10-01',
        messages: [message('archived', 'Archived row', 'user')],
      },
    });
    const store = await getStandaloneHistoryStorage(
      'cowork-workspace',
      'archived-chat',
    );
    if (!store) throw new Error('Missing standalone archive');
    const before = await snapshotFormat4Files(store.directory);
    expect(
      (
        await readArchiveSnapshot('cowork-workspace', 'archived-chat', {
          chatIds: ['archived-chat'],
          fullTranscript: true,
        })
      )?.tab.messages.map((row) => row.id),
    ).toEqual(['archived']);
    expect(await store.format()).toBe('v2');
    expect(await snapshotFormat4Files(store.directory)).toEqual(before);
  });

  it('does not promote a real archived-container read (control)', async () => {
    await commitArchivedContainer({
      version: 1,
      id: 'container',
      kind: 'worktree',
      projectId: 'workspace',
      name: 'Archive',
      createdAt: '2026-10-01T00:00:00.000Z',
      archivedAt: '2026-10-01T00:00:00.000Z',
      retentionDays: 3650,
      expiresAt: '2099-10-01T00:00:00.000Z',
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
    });
    const store = new ChatStorageV2(
      getArchivedContainerDir('workspace', 'container'),
      'container',
    );
    await store.migrate(
      scopeSource([
        {
          id: 'chat',
          messages: [message('archived', 'Container row', 'user')],
        },
      ]),
    );
    const before = await snapshotFormat4Files(store.directory);
    expect(
      (await readArchivedContainerChats('workspace', 'container')).tabs.map(
        (tab) => tab.id,
      ),
    ).toEqual(['chat']);
    expect(await store.format()).toBe('v2');
    expect(await snapshotFormat4Files(store.directory)).toEqual(before);
  });

  it('does not promote an immutable scope capture (control)', async () => {
    await seed();
    const target = repository({ enableFormat4: false });
    await target.getState(scope);
    const copy = new ChatStorageV2(join(root, 'immutable'), 'copy');
    await target.captureScope(scope, copy);
    const before = await snapshotFormat4Files(copy.directory);
    const loaded = new ChatStateV2Backend(copy, { enableFormat4: true });
    expect(
      (
        await loaded.state({ chatIds: ['chat'], fullTranscript: true })
      ).tabsFile.tabs[0]?.messages.map((row) => row.id),
    ).toEqual(['initial']);
    expect(await copy.format()).toBe('v2');
    expect(await snapshotFormat4Files(copy.directory)).toEqual(before);
  });

  it('promotes a writable Cowork Work Entry scope (control)', async () => {
    const entry = { projectId: 'cowork-workspace', worktreeId: 'entry' };
    const original = workspaceRegistry.getWorkspaceType;
    jest
      .spyOn(workspaceRegistry, 'getWorkspaceType')
      .mockImplementation((id) =>
        id === entry.projectId ? 'cowork' : original(id),
      );
    const paths = {
      tabs: resolveChatTabsFilePath(entry.projectId, entry.worktreeId),
      archives: resolveChatArchivesFilePath(entry.projectId, entry.worktreeId),
      journal: resolveChatJournalFilePath(entry.projectId, entry.worktreeId),
    };
    expect(paths.tabs).toBe(
      join(root, 'workspaces', 'cowork-workspace', 'chats', 'entry.json'),
    );
    const store = ChatStorageV2.fromLegacyPaths(paths);
    await store.migrate(
      scopeSource([
        { id: 'chat', messages: [message('entry', 'Work Entry', 'user')] },
      ]),
    );
    await new ChatStateV2Backend(store, {
      deltaJournal: {},
    }).promoteToDeltaJournal();
    const target = drainAfterTest(
      new ChatStateV2Repository({ enableFormat4: true }),
    );
    await target.getState(entry);
    expect(await store.format()).toBe('v4');
  });

  it('retains children created after publication through later opted-in loads', async () => {
    await seed();
    const target = repository();
    await target.getState(scope);
    await retainPostPublicationChild(target, root);
  });

  async function retainPostPublicationChild(
    target: ChatStateV2Repository,
    at: string,
  ): Promise<void> {
    const child = {
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 1,
    } as const;
    await target.openChildStream(scope, child);
    const row: DelegationChildRow = {
      ...message('child-row', 'Child after publication'),
      parentBlockId: 'child',
      delegationSequence: 1,
      itemRevision: 0,
      final: true,
    };
    await target.commitChildStream(scope, child, 'child-row', [row]);
    await target.flushScope(scope);
    const descriptor = await target.openChildStream(scope, child);
    const catalog = join(
      ChatStorageV2.fromLegacyPaths(pathsAt(at)).directory,
      'transcripts',
      'delegations',
      'stream-catalog.json',
    );
    const before = await readFile(catalog);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const later = repository({}, at);
      expect(await later.openChildStream(scope, child)).toEqual(descriptor);
      expect(
        await later.getChildStreamMessage(
          scope,
          child,
          'child-row',
          descriptor.streamRevision,
        ),
      ).toEqual(row);
      expect(await readFile(catalog)).toEqual(before);
      expect(await ChatStorageV2.fromLegacyPaths(pathsAt(at)).format()).toBe(
        'v4',
      );
    }
  }

  it.each(['nonempty', 'torn', 'selected v4'] as const)(
    'journaled load retains %s evidence and never deletes the catalog',
    async (kind) => {
      const { store } = await seed();
      const selectedV1 = await readFile(
        join(store.directory, 'delta-journal.log'),
      );
      await expect(
        promoteToFormat4Journal(store, {
          onBoundary: (point) =>
            point === 'manifest-temp-written'
              ? Promise.reject(new Error('stop'))
              : Promise.resolve(),
        }),
      ).rejects.toThrow('stop');
      const v2 = join(store.directory, 'delta-journal-v2.log');
      if (kind === 'torn') {
        await writeFile(
          v2,
          Buffer.concat([await readFile(v2), Buffer.from('CDJ1')]),
        );
      } else if (kind === 'nonempty') {
        const other = await seed(3, join(root, 'other'));
        const writer = await promoteToFormat4Journal(other.store);
        const current = writer.indexes();
        await writer.commit({
          expectedRevision: 0,
          next: {
            live: { ...current.live, revision: 1 },
            archive: { ...current.archive, revision: 1 },
            recovery: { ...current.recovery, mutationIds: ['evidence'] },
          },
          writes: [],
          mutationIds: ['evidence'],
        });
        await writeFile(
          v2,
          await readFile(join(other.store.directory, 'delta-journal-v2.log')),
        );
      } else {
        await promoteToFormat4Journal(store);
        await writeFile(join(store.directory, 'delta-journal.log'), selectedV1);
      }
      const selected =
        kind === 'selected v4'
          ? v2
          : join(store.directory, 'delta-journal.log');
      const selectedBefore = await readFile(selected);
      const v2Before = await readFile(v2);
      const catalog = join(
        store.directory,
        'transcripts',
        'delegations',
        'stream-catalog.json',
      );
      const catalogBefore = await readFile(catalog);
      await repository({ enableFormat4: false }).getState(scope);
      expect(await readFile(selected)).toEqual(selectedBefore);
      expect(await readFile(v2)).toEqual(v2Before);
      expect(await readFile(catalog)).toEqual(catalogBefore);
      if (kind === 'selected v4')
        await expect(
          readFile(join(store.directory, 'delta-journal.log')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('does not keep a scope ready if a scheduled retry cannot reopen its selected manifest', async () => {
    const { store } = await seed();
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let attempts = 0;
    let broken = false;
    const open = ChatDeltaJournalWriter.open.bind(ChatDeltaJournalWriter);
    jest
      .spyOn(ChatDeltaJournalWriter, 'open')
      .mockImplementation(async (...args) => {
        if (broken) throw new Error('retry-recovery-fault');
        return open(...args);
      });
    const target = repository({
      deltaJournalPromotionRetryMs: 10,
      deltaJournalOnBoundary: (point) => {
        if (point === 'catalog-temp-written') {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error('first-fault'));
        }
        if (point === 'manifest-published') {
          broken = true;
          return Promise.reject(new Error('published-fault'));
        }
        return Promise.resolve();
      },
    });
    await target.getState(scope);
    expect(target.getLifecycle(scope)).toBe('ready');
    now += 10;
    await target.transact(
      scope,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { title: 'Retry' },
        },
      ],
      { source: 'provider', mutationId: 'retry' },
    );
    await expect(target.getState(scope)).rejects.toBeInstanceOf(
      ChatStateRepositoryLoadError,
    );
    expect(target.getLifecycle(scope)).toBe('recovery_error');
    expect(await store.format()).toBe('v4');
  });

  it('queues a due retry after a group commit becomes durable without another mutation', async () => {
    await seed();
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let attempts = 0;
    const target = repository({
      deltaJournalPromotionRetryMs: 10,
      deltaJournalOnBoundary: (point) => {
        if (point === 'catalog-temp-written') {
          attempts += 1;
          return Promise.reject(new Error('catalog-fault'));
        }
        return Promise.resolve();
      },
    });
    await target.getState(scope);
    expect(attempts).toBe(1);
    now += 10;
    await target.transact(
      scope,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { title: 'Durable activity' },
        },
      ],
      { source: 'provider', mutationId: 'activity' },
    );
    await target.getRevision(scope);
    expect(attempts).toBe(2);
  });
});
