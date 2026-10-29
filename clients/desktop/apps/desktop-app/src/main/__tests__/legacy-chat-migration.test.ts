import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ChatJournalRecord,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import { migrateLegacyChatScope } from '../lib/legacy-chat-migration';

const message = (id: string, text = id): PersistedChatMessage => ({
  id,
  role: 'user',
  timestamp: 1,
  blocks: [{ type: 'text', text }],
});
const tab = (
  id: string,
  messages: PersistedChatMessage[] = [],
): PersistedChatTab => ({
  id,
  title: id,
  createdAt: '2026-09-05',
  messages,
});
const record = (
  revision: number,
  mutations: ChatJournalRecord['mutations'],
): ChatJournalRecord => ({
  v: 1,
  revision,
  mutations,
  mutationId: `mutation-${revision}`,
  source: 'provider',
  occurredAt: '2026-09-05',
});

describe('actual v1 scope migration', () => {
  let root: string;
  let paths: { tabs: string; archives: string; journal: string };
  let store: ChatStorageV2;
  async function json(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  }
  async function journal(records: ChatJournalRecord[]): Promise<void> {
    await mkdir(dirname(paths.journal), { recursive: true });
    await writeFile(
      paths.journal,
      records.map((row) => JSON.stringify(row) + '\n').join(''),
    );
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'legacy-chat-migrate-'));
    paths = {
      tabs: join(root, 'chats', 'scope.json'),
      archives: join(root, 'chat-archives', 'scope.json'),
      journal: join(root, 'chat-journals', 'scope.jsonl'),
    };
    store = new ChatStorageV2(root, 'scope');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('retains recovery receipts in canonical revision order even when journal rows arrive out of order', async () => {
    await json(paths.tabs, {
      version: 1,
      revision: 2,
      tabs: [tab('chat')],
      activeTabId: 'chat',
    });
    await journal([
      {
        ...record(2, [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { title: 'new' },
          },
        ]),
        commandResult: {
          commandId: 'same-command',
          outcome: 'applied',
          revision: 2,
          entityId: 'new',
        },
      },
      {
        ...record(1, [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { title: 'old' },
          },
        ]),
        commandResult: {
          commandId: 'same-command',
          outcome: 'applied',
          revision: 1,
          entityId: 'old',
        },
      },
    ]);
    await migrateLegacyChatScope(store, paths);
    const { recovery } = await store.indexes();
    expect(recovery.receipts).toEqual([
      expect.objectContaining({ revision: 2, entityId: 'new' }),
    ]);
    expect(recovery.mutationIds).toEqual(['mutation-1', 'mutation-2']);
  });

  it.each([undefined, 7])(
    'directly migrates v1 snapshot revision %s and archives',
    async (revision) => {
      await json(paths.tabs, {
        version: 1,
        revision,
        activeTabId: 'live',
        tabs: [tab('live', [message('a', 'preserve\n🌲\ud800')])],
      });
      await json(paths.archives, {
        version: 1,
        revision,
        archived: [
          {
            tab: tab('archive', [message('b')]),
            archivedAt: '2026-09-05',
            turnCount: 1,
          },
        ],
      });
      await migrateLegacyChatScope(store, paths);
      const reader = new ChatTranscriptLog(
        join(store.directory, 'transcripts'),
      );
      expect((await reader.page('live')).messages).toEqual([
        message('a', 'preserve\n🌲\ud800'),
      ]);
      expect((await reader.page('archive')).messages).toEqual([message('b')]);
      expect((await store.indexes()).live.revision).toBe(revision ?? 0);
      await expect(readFile(paths.tabs)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('recovers a valid backup, replays sorted journal revisions and retains receipts/tombstones', async () => {
    await json(paths.tabs, { broken: true });
    await json(paths.tabs + '.bak', {
      version: 1,
      revision: 1,
      activeTabId: 'live',
      tabs: [tab('live', [message('a', 'old'), message('remove')])],
    });
    await json(paths.archives, { version: 1, revision: 1, archived: [] });
    const second = record(2, [
      {
        type: 'message.upserted',
        chatId: 'live',
        message: message('a', 'amended'),
      },
    ]);
    const third = {
      ...record(3, [
        {
          type: 'message.removed' as const,
          chatId: 'live',
          messageId: 'remove',
        },
      ]),
      commandResult: {
        commandId: 'command-3',
        revision: 3,
        outcome: 'applied' as const,
      },
    };
    await journal([third, second, second]);
    await migrateLegacyChatScope(store, paths);
    expect(
      (
        await new ChatTranscriptLog(join(store.directory, 'transcripts')).page(
          'live',
        )
      ).messages,
    ).toEqual([message('a', 'amended')]);
    expect((await store.indexes()).recovery).toMatchObject({
      removedMessageIds: ['remove'],
      removedMessageKeys: [JSON.stringify(['live', 'remove'])],
      receipts: [third.commandResult],
    });
    const evidence = (await store.indexes()).recovery.legacyEvidence;
    expect(evidence).toHaveLength(1);
    if (!evidence) throw new Error('Missing recovery evidence');
    expect(
      await readFile(join(store.directory, evidence[0].relativePath), 'utf8'),
    ).toBe(JSON.stringify({ broken: true }));
  });

  it('ignores runtime replay for a removed chat and retains the lean sibling', async () => {
    await json(paths.tabs, {
      version: 1,
      revision: 2,
      activeTabId: 'lean',
      tabs: [tab('lean', [message('a')])],
    });
    await json(paths.archives, { version: 1, revision: 2, archived: [] });
    await journal([
      record(1, [
        {
          type: 'runtime.patched',
          chatId: 'deleted',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
      ]),
      record(2, [{ type: 'tab.removed', tabId: 'deleted' }]),
    ]);
    await migrateLegacyChatScope(store, paths);
    expect((await store.indexes()).live.runtimeByChatId).not.toHaveProperty(
      'deleted',
    );
  });

  async function evidenceBytes(): Promise<string[]> {
    const evidence = (await store.indexes()).recovery.legacyEvidence ?? [];
    return Promise.all(
      evidence.map((item) =>
        readFile(join(store.directory, item.relativePath), 'utf8'),
      ),
    );
  }
  async function transcript(chatId: string): Promise<PersistedChatMessage[]> {
    return (
      await new ChatTranscriptLog(join(store.directory, 'transcripts')).page(
        chatId,
      )
    ).messages;
  }

  it('recovers a journal-internal revision gap, replays surviving records and retains the source bytes as evidence', async () => {
    await json(paths.tabs, {
      version: 1,
      activeTabId: 'live',
      tabs: [tab('live', [message('a')])],
    });
    await journal([
      record(2, [
        { type: 'message.upserted', chatId: 'live', message: message('b') },
      ]),
    ]);
    const tabsBytes = await readFile(paths.tabs, 'utf8');
    const journalBytes = await readFile(paths.journal, 'utf8');
    const report = await migrateLegacyChatScope(store, paths);
    expect(report.revisionGapRecovery).toEqual({
      expectedRevision: 1,
      foundRevision: 2,
      newestRevision: 0,
      tabsRevision: 0,
      archiveRevision: 0,
      staleComponent: 'journal',
      skippedMutationCount: 0,
    });
    expect(await store.authority()).toBe('v2');
    expect(await transcript('live')).toEqual([message('a'), message('b')]);
    expect((await store.indexes()).live.revision).toBe(2);
    const evidence = await evidenceBytes();
    expect(evidence).toEqual(expect.arrayContaining([tabsBytes, journalBytes]));
  });

  it('recovers the owl shape: a stale archive snapshot whose bridging journal records were compacted', async () => {
    await json(paths.tabs, {
      version: 1,
      revision: 20,
      activeTabId: 'live',
      tabs: [
        tab('live', [message('a')]),
        tab('to-archive', [message('c')]),
        tab('restored-in-gap', [message('r', 'newer')]),
      ],
    });
    await json(paths.archives, {
      version: 1,
      revision: 5,
      archived: [
        {
          tab: tab('old-archive', [message('o')]),
          archivedAt: '2026-09-01',
          turnCount: 1,
        },
        {
          tab: tab('restored-in-gap', [message('r', 'stale')]),
          archivedAt: '2026-09-01',
          turnCount: 1,
        },
      ],
    });
    await journal([
      record(21, [
        { type: 'message.upserted', chatId: 'live', message: message('b') },
      ]),
      record(22, [
        { type: 'tab.removed', tabId: 'to-archive' },
        {
          type: 'archive.upserted',
          entry: {
            tab: tab('to-archive', [message('c')]),
            archivedAt: '2026-09-05',
            turnCount: 1,
          },
        },
      ]),
      record(23, [{ type: 'tab.created', tab: tab('new', [message('n')]) }]),
    ]);
    const originals = await Promise.all(
      [paths.tabs, paths.archives, paths.journal].map((path) =>
        readFile(path, 'utf8'),
      ),
    );
    const report = await migrateLegacyChatScope(store, paths);
    expect(report.revisionGapRecovery).toEqual({
      expectedRevision: 6,
      foundRevision: 21,
      newestRevision: 20,
      tabsRevision: 20,
      archiveRevision: 5,
      staleComponent: 'archives',
      skippedMutationCount: 0,
    });
    const indexes = await store.indexes();
    expect(indexes.live.revision).toBe(23);
    expect(indexes.live.tabs.map((entry) => entry.id)).toEqual([
      'live',
      'restored-in-gap',
      'new',
    ]);
    // Archiving prepends, so the chat archived at revision 22 leads.
    expect(indexes.archive.archived.map((entry) => entry.tab.id)).toEqual([
      'to-archive',
      'old-archive',
    ]);
    expect(await transcript('live')).toEqual([message('a'), message('b')]);
    expect(await transcript('restored-in-gap')).toEqual([
      message('r', 'newer'),
    ]);
    expect(await transcript('old-archive')).toEqual([message('o')]);
    expect(await transcript('new')).toEqual([message('n')]);
    expect(await evidenceBytes()).toEqual(expect.arrayContaining(originals));
    await expect(readFile(paths.archives)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('prefers the newer archive copy when the tabs snapshot is the stale component', async () => {
    await json(paths.tabs, {
      version: 1,
      revision: 5,
      activeTabId: 'archived-in-gap',
      tabs: [
        tab('live', [message('a')]),
        tab('archived-in-gap', [message('x', 'stale')]),
      ],
    });
    await json(paths.archives, {
      version: 1,
      revision: 20,
      archived: [
        {
          tab: tab('archived-in-gap', [message('x', 'newer')]),
          archivedAt: '2026-09-05',
          turnCount: 1,
        },
      ],
    });
    await journal([
      record(21, [
        { type: 'message.upserted', chatId: 'live', message: message('b') },
        {
          type: 'message.upserted',
          chatId: 'created-in-gap',
          message: message('lost'),
        },
      ]),
    ]);
    const report = await migrateLegacyChatScope(store, paths);
    expect(report.revisionGapRecovery).toMatchObject({
      expectedRevision: 6,
      foundRevision: 21,
      staleComponent: 'tabs',
      skippedMutationCount: 1,
    });
    const indexes = await store.indexes();
    expect(indexes.live.tabs.map((entry) => entry.id)).toEqual(['live']);
    expect(indexes.live.activeTabId).toBe('live');
    expect(indexes.archive.archived.map((entry) => entry.tab.id)).toEqual([
      'archived-in-gap',
    ]);
    expect(await transcript('archived-in-gap')).toEqual([
      message('x', 'newer'),
    ]);
    expect(await transcript('live')).toEqual([message('a'), message('b')]);
  });

  it('recovers an archive snapshot behind the tabs snapshot when no journal record bridges them', async () => {
    await json(paths.tabs, {
      version: 1,
      revision: 10,
      activeTabId: 'live',
      tabs: [tab('live', [message('a')])],
    });
    await json(paths.archives, {
      version: 1,
      revision: 7,
      archived: [
        {
          tab: tab('archived', [message('b')]),
          archivedAt: '2026-09-05',
          turnCount: 1,
        },
      ],
    });
    await journal([
      record(7, [
        { type: 'tab.metadata_patched', tabId: 'live', patch: { title: '7' } },
      ]),
    ]);
    const archiveBytes = await readFile(paths.archives, 'utf8');
    const report = await migrateLegacyChatScope(store, paths);
    expect(report.revisionGapRecovery).toEqual({
      expectedRevision: 8,
      newestRevision: 10,
      tabsRevision: 10,
      archiveRevision: 7,
      staleComponent: 'archives',
      skippedMutationCount: 0,
    });
    const indexes = await store.indexes();
    expect(indexes.live.revision).toBe(10);
    expect(indexes.live.tabs[0]?.title).toBe('live');
    expect(indexes.archive.archived.map((entry) => entry.tab.id)).toEqual([
      'archived',
    ]);
    expect(await evidenceBytes()).toContain(archiveBytes);
  });

  it('still fails closed on conflicting duplicate revisions and leaves the source intact', async () => {
    await json(paths.tabs, {
      version: 1,
      revision: 5,
      activeTabId: 'live',
      tabs: [tab('live', [message('a')])],
    });
    await json(paths.archives, { version: 1, revision: 20, archived: [] });
    await journal([
      record(21, [
        { type: 'tab.metadata_patched', tabId: 'live', patch: { title: 'x' } },
      ]),
      record(21, [
        { type: 'tab.metadata_patched', tabId: 'live', patch: { title: 'y' } },
      ]),
    ]);
    const before = await readFile(paths.tabs);
    await expect(migrateLegacyChatScope(store, paths)).rejects.toThrow(
      'Conflicting duplicate chat revision 21',
    );
    expect(await readFile(paths.tabs)).toEqual(before);
    expect(await store.authority()).toBe('v1');
  });

  it('reports no gap recovery for a contiguous journal', async () => {
    await json(paths.tabs, {
      version: 1,
      revision: 1,
      activeTabId: 'live',
      tabs: [tab('live', [message('a')])],
    });
    await journal([
      record(2, [
        { type: 'message.upserted', chatId: 'live', message: message('b') },
      ]),
    ]);
    const report = await migrateLegacyChatScope(store, paths);
    expect(report.revisionGapRecovery).toBeUndefined();
    expect((await store.indexes()).recovery.legacyEvidence).toBeUndefined();
  });

  it('replays a journal that bridges snapshots checkpointed at different revisions', async () => {
    await json(paths.tabs, {
      version: 1,
      revision: 10,
      activeTabId: 'live',
      tabs: [tab('live', [message('a')])],
    });
    await json(paths.archives, { version: 1, revision: 7, archived: [] });
    await journal([
      record(8, [
        {
          type: 'archive.upserted',
          entry: {
            tab: tab('archived', [message('b')]),
            archivedAt: '2026-09-05',
            turnCount: 1,
          },
        },
      ]),
      record(9, [
        { type: 'tab.metadata_patched', tabId: 'live', patch: { title: '9' } },
      ]),
      record(10, [
        { type: 'tab.metadata_patched', tabId: 'live', patch: { title: '10' } },
      ]),
    ]);
    await migrateLegacyChatScope(store, paths);
    const indexes = await store.indexes();
    expect(indexes.live.revision).toBe(10);
    expect(indexes.archive.archived.map((entry) => entry.tab.id)).toEqual([
      'archived',
    ]);
    expect(indexes.live.tabs[0]?.title).toBe('live');
  });

  it('migrates a tabs-only snapshot whose archive file never existed', async () => {
    await json(paths.tabs, {
      version: 1,
      revision: 10,
      activeTabId: 'live',
      tabs: [tab('live', [message('a')])],
    });
    await migrateLegacyChatScope(store, paths);
    expect((await store.indexes()).live.revision).toBe(10);
  });

  it('creates a new scope when its workspace directory does not exist yet', async () => {
    const fresh = join(root, 'fresh');
    const freshPaths = {
      tabs: join(fresh, 'chats', 'home.json'),
      archives: join(fresh, 'chat-archives', 'home.json'),
      journal: join(fresh, 'chat-journals', 'home.jsonl'),
    };
    const freshStore = new ChatStorageV2(fresh, 'home');
    await migrateLegacyChatScope(freshStore, freshPaths);
    expect((await freshStore.indexes()).live.tabs).toEqual([]);
  });

  it('routes a sentinel namespace and cleans its exact legacy file families', async () => {
    const sentinelPaths = {
      tabs: join(root, 'plan-explore-chats', 'plan.json'),
      archives: join(root, 'sentinel-workspace', 'chat-archives', 'plan.json'),
      journal: join(root, 'chat-journals', 'plan.jsonl'),
    };
    await json(sentinelPaths.tabs, {
      version: 1,
      activeTabId: 'chat',
      tabs: [tab('chat', [message('human')])],
    });
    await json(sentinelPaths.archives, { version: 1, archived: [] });
    const sentinel = ChatStorageV2.fromLegacyPaths(sentinelPaths);
    await migrateLegacyChatScope(sentinel, sentinelPaths);
    expect((await sentinel.indexes()).live.tabs[0].id).toBe('chat');
    await expect(readFile(sentinelPaths.tabs)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(sentinelPaths.archives)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(sentinel.directory).not.toBe(
      new ChatStorageV2(root, 'plan').directory,
    );
  });

  it('retains previously quarantined bytes after the primary has already been repaired', async () => {
    await json(paths.tabs, {
      version: 1,
      activeTabId: 'chat',
      tabs: [tab('chat', [message('a')])],
    });
    const suspect = '{"tabs":[{"messages":[{"id":"unrecovered"';
    await writeFile(paths.tabs + '.conflict-123', suspect);
    await migrateLegacyChatScope(store, paths);
    const evidence = (await store.indexes()).recovery.legacyEvidence;
    expect(evidence).toHaveLength(1);
    if (!evidence) throw new Error('Missing recovery evidence');
    expect(
      await readFile(join(store.directory, evidence[0].relativePath), 'utf8'),
    ).toBe(suspect);
  });

  it('settles abandoned active turns while preserving their complete transcript', async () => {
    const timer: PersistedChatMessage = {
      ...message('timer'),
      role: 'assistant',
      blocks: [{ type: 'turn_timer', startedAt: 10, completedAt: null }],
    };
    await json(paths.tabs, {
      version: 1,
      activeTabId: 'live',
      tabs: [tab('live', [message('human'), timer])],
    });
    await journal([
      record(1, [
        {
          type: 'runtime.patched',
          chatId: 'live',
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId: 'human', startedAt: 10 },
          },
        },
      ]),
    ]);
    await migrateLegacyChatScope(store, paths);
    const migrated = (
      await new ChatTranscriptLog(join(store.directory, 'transcripts')).page(
        'live',
      )
    ).messages;
    expect(migrated[0]).toEqual(message('human'));
    expect(migrated[1]).toMatchObject({
      id: timer.id,
      role: timer.role,
      timestamp: timer.timestamp,
    });
    const completedTimer = migrated[1]?.blocks[0];
    if (completedTimer?.type !== 'turn_timer')
      throw new Error('Expected a completed turn timer');
    expect(completedTimer.startedAt).toBe(10);
    expect(typeof completedTimer.completedAt).toBe('number');
    expect((await store.indexes()).live.runtimeByChatId.live).toMatchObject({
      status: 'interrupted',
      queuedMessageIds: [],
    });
    expect(
      (await store.indexes()).live.runtimeByChatId.live.activeTurn,
    ).toBeUndefined();
  });
});
