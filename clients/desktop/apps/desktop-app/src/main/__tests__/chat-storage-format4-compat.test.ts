import {
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import * as directorySync from '../lib/fsync-directory';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import type { ChatMigrationEntry } from '../lib/chat-storage-v2';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { readChatStorageDiscoveryIndex } from '../lib/chat-storage-discovery';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import {
  ChatStorageNewerFormatError,
  DELTA_JOURNAL_V2_FILE_NAME,
} from '../lib/chat-delta-journal/format';
import {
  loadStreamCatalog,
  parseStreamDescriptor,
  streamRegistryPaths,
} from '../lib/chat-delta-journal/stream-registry';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import { delegationStreamKey } from '../lib/transcript-stream-paths';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import {
  format4Scope,
  reopenFormat4Scope,
  snapshotFormat4Files,
} from './helpers/chat-format4-scope';
import {
  drainOpenRepositories,
  repositoryAt,
  streaming,
  upsert,
} from './helpers/chat-delta-journal-scope';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';

jest.setTimeout(120_000);
const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');

describe('opted-in format-4 compatibility', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-format4-compat-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await drainOpenRepositories();
    await rm(root, { recursive: true, force: true });
  });

  it('option-off repository load never promotes format 3 to 4', async () => {
    const store = new ChatStorageV2(root, 'scope');
    await store.migrate(
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    const backend = new ChatStateV2Backend(store, { deltaJournal: {} });
    await backend.promoteToDeltaJournal();
    const repository = repositoryAt(root, { enableFormat4: false });
    await repository.getState({ projectId: 'project', worktreeId: 'scope' });
    const manifest: unknown = JSON.parse(
      await readFile(store.manifestPath, 'utf8'),
    );
    expect(manifest).toMatchObject({ version: 3 });
  });

  it.each(['store', 'discovery', 'repository'] as const)(
    'reads a real format-4 index through the default %s',
    async (lane) => {
      const { backend } = await format4Scope(
        root,
        'scope',
        scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
      );
      await backend.flush();
      backend.releaseJournal();
      if (lane === 'store') {
        expect(
          (await new ChatStorageV2(root, 'scope').indexes()).live.tabs,
        ).toMatchObject([{ id: 'chat' }]);
      } else if (lane === 'discovery') {
        expect(
          (await readChatStorageDiscoveryIndex(root, 'scope')).tabs,
        ).toMatchObject([{ id: 'chat' }]);
      } else {
        const repository = repositoryAt(root);
        expect(
          (
            await repository.getState({
              projectId: 'project',
              worktreeId: 'scope',
            })
          ).tabsFile.tabs,
        ).toMatchObject([{ id: 'chat' }]);
      }
    },
  );

  it('reads format 4 by default while retaining explicit old-reader refusal', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    const manifest: unknown = JSON.parse(
      await readFile(store.manifestPath, 'utf8'),
    );
    expect(manifest).toMatchObject({
      version: 4,
      journal: 'chat-delta-journal-v2',
    });
    expect(manifest).not.toHaveProperty('demotesTo');
    expect(await backend.promoteToFormat4()).toBe(false);
    if (typeof manifest !== 'object' || manifest === null)
      throw new Error('Missing format-4 fixture manifest');
    expect(await new ChatStorageV2(root, 'scope').format()).toBe('v4');
    expect(
      (await readChatStorageDiscoveryIndex(root, 'scope')).tabs,
    ).toHaveLength(1);
    const oldReader = new ChatStorageV2(root, 'scope', undefined, {
      maxManifestVersion: 3,
    });
    const beforeRefusal = await snapshotFormat4Files(root);
    await expect(oldReader.format()).rejects.toThrow(
      ChatStorageNewerFormatError,
    );
    await expect(
      readChatStorageDiscoveryIndex(root, 'scope', {
        maxManifestVersion: 3,
      }),
    ).rejects.toThrow(ChatStorageNewerFormatError);
    expect(await snapshotFormat4Files(root)).toEqual(beforeRefusal);
    expect(
      (
        await readChatStorageDiscoveryIndex(root, 'scope', {
          maxManifestVersion: 4,
        })
      ).tabs,
    ).toHaveLength(1);
    const reopened = reopenFormat4Scope(root, 'scope', {
      enableFormat4: false,
    });
    expect(await reopened.backend.load()).toMatchObject({
      live: { revision: 0 },
    });
    await writeFile(
      store.manifestPath,
      JSON.stringify({ ...manifest, version: 5 }),
    );
    const beforeFuture = await snapshotFormat4Files(root);
    await expect(reopened.store.format()).rejects.toThrow(
      ChatStorageNewerFormatError,
    );
    expect(await snapshotFormat4Files(root)).toEqual(beforeFuture);
  });

  it('copies only checkpointed format 4 and validates catalog-rooted stream closure', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 0,
    };
    await backend.registerTranscriptStream(target);
    expect(backend.pendingJournalRecords()).toBeGreaterThan(0);
    expect(backend.pendingPrimaryRecordCount()).toBe(0);
    expect(await backend.storage.journalIsClear()).toBe(false);
    await expect(backend.maintainArtifacts('chat')).rejects.toThrow(
      'replay is pending',
    );
    await backend.checkpointPendingJournal();
    const catalog = await loadStreamCatalog(
      join(store.directory, 'transcripts'),
    );
    expect(catalog.parents.chat?.entryCount).toBe(1);
    const imported = new ChatStorageV2(root, 'import-source');
    await imported.migrate(
      scopeSource([{ id: 'new', messages: [message('n1', 'new')] }]),
    );
    const metadata = await new ChatStateV2Backend(imported).state();
    await expect(
      backend.importScope(imported, metadata, { merge: true }),
    ).resolves.toMatchObject({ applied: true });
    expect(
      (
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8')
      ).trim(),
    ).toBe('');
    // The locator is derived; a source without one copies without one.
    await rm(
      streamRegistryPaths(
        join(store.directory, 'transcripts'),
        'chat',
        delegationStreamKey(target),
      ).index,
      { force: true },
    );
    const capture = new ChatStorageV2(root, 'capture', undefined, {
      maxManifestVersion: 4,
    });
    await store.copyTo(capture);
    const captureManifest: unknown = JSON.parse(
      await readFile(capture.manifestPath, 'utf8'),
    );
    expect(captureManifest).toMatchObject({ version: 4 });
    expect(await capture.journalFile()).toBeUndefined();
    expect(
      (await new ChatStateV2Backend(capture).load()).live.tabs,
    ).toHaveLength(2);
    // A retry compares tree digests, so validation must not add a locator.
    await expect(store.copyTo(capture)).resolves.toBeUndefined();
    const remapped = new ChatStorageV2(root, 'remapped', undefined, {
      maxManifestVersion: 4,
    });
    await expect(
      store.copyTo(remapped, (indexes) => {
        indexes.live.tabs[0].id = 'other';
      }),
    ).rejects.toThrow('re-key');
    await expect(stat(remapped.directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const paths = streamRegistryPaths(
      join(store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    );
    await unlink(paths.descriptor);
    const failed = new ChatStorageV2(root, 'failed', undefined, {
      maxManifestVersion: 4,
    });
    await expect(store.copyTo(failed)).rejects.toThrow();
    expect(await failed.authority()).toBe('v1');
  });

  it('copies a child-only artifact and refuses capture when its body is missing', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 0,
    };
    await backend.registerTranscriptStream(target);
    await backend.checkpointPendingJournal();
    const transcripts = join(store.directory, 'transcripts');
    const artifacts = new ChatTranscriptArtifacts(transcripts);
    const ref = await artifacts.put(
      'chat',
      'only a child references this body',
    );
    const paths = streamRegistryPaths(
      transcripts,
      'chat',
      delegationStreamKey(target),
    );
    const row = {
      id: 'agent:item',
      role: 'assistant',
      timestamp: 1,
      parentBlockId: 'agent',
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
      blocks: [
        {
          type: 'tool_result',
          toolName: 'shell',
          toolUseId: 'call-1',
          output: 'preview',
          isError: false,
          fullOutputRef: ref,
        },
      ],
    };
    const log = Buffer.from(`${JSON.stringify(row)}\n`);
    await writeFile(paths.log, log);
    const descriptor = parseStreamDescriptor(await readFile(paths.descriptor));
    await writeFile(
      paths.descriptor,
      JSON.stringify({
        ...descriptor,
        committedRowCount: 1,
        committedByteLength: log.length,
        committedSha256: createHash('sha256').update(log).digest('hex'),
      }),
    );
    for (let attempt = 0; attempt < 20; attempt++) {
      const progress = await backend.maintainArtifacts('chat');
      if (progress.complete) break;
    }
    expect(
      await readFile(
        join(transcripts, 'tool-output', 'chat', `${ref.artifactId}.txt`),
        'utf8',
      ),
    ).toBe('only a child references this body');
    const first = new ChatStorageV2(root, 'child-capture', undefined, {
      maxManifestVersion: 4,
    });
    await store.copyTo(first);
    expect(
      await readFile(
        join(
          first.directory,
          'transcripts',
          'tool-output',
          'chat',
          `${ref.artifactId}.txt`,
        ),
        'utf8',
      ),
    ).toBe('only a child references this body');
    await unlink(
      join(transcripts, 'tool-output', 'chat', `${ref.artifactId}.txt`),
    );
    const second = new ChatStorageV2(root, 'missing-child-body', undefined, {
      maxManifestVersion: 4,
    });
    await expect(store.copyTo(second)).rejects.toThrow();
    expect(await second.authority()).toBe('v1');
  });

  it('cancels publication when parent deletion races a child-stream capture', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 0,
    };
    await backend.registerTranscriptStream(target);
    await backend.checkpointPendingJournal();
    let copied: () => void = () => undefined;
    let resume: () => void = () => undefined;
    const copiedPromise = new Promise<void>((resolve) => {
      copied = resolve;
    });
    const resumePromise = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalCopy = fsPromises.copyFile;
    jest
      .spyOn(fsPromises, 'copyFile')
      .mockImplementation(async (source, destination, mode) => {
        await originalCopy(source, destination, mode);
        if (String(source).endsWith('descriptor.json')) {
          copied();
          await resumePromise;
        }
      });
    const capture = new ChatStorageV2(root, 'racing-capture', undefined, {
      maxManifestVersion: 4,
    });
    const copying = store.copyTo(capture);
    await copiedPromise;
    const retiring =
      backend.storage.transcripts.childDeleteFence.retire('chat');
    resume();
    await expect(copying).rejects.toThrow('deleted during capture');
    await retiring;
    expect(await capture.authority()).toBe('v1');
    jest.restoreAllMocks();
    backend.storage.transcripts.childDeleteFence.restore('chat');
    await store.copyTo(capture);
    expect(await capture.authority()).toBe('v2');
  });

  it('registers through checkpointed format-4 journal re-entry with the option off', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    await backend.demoteFromDeltaJournal();
    expect(await store.journalFile()).toBeUndefined();
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 0,
    };
    const gated = reopenFormat4Scope(root, 'scope', { enableFormat4: false });
    await gated.backend.registerTranscriptStream(target);
    expect(await store.journalFile()).toBe(DELTA_JOURNAL_V2_FILE_NAME);
    await gated.backend.checkpointPendingJournal();
    expect(
      (await loadStreamCatalog(join(store.directory, 'transcripts'))).parents
        .chat?.entryCount,
    ).toBe(1);
  });

  it('routes an oversized journal record through one checkpointed format-4 transaction', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    backend.releaseJournal();
    const bounded = new ChatStateV2Backend(store, {
      deltaJournal: { largeRecordBytes: 4096 },
      enableFormat4: true,
    });
    await bounded.load();
    await bounded.transact(
      () => [
        streaming('chat', 'm1'),
        upsert('chat', message('m2', 'go', 'user')),
      ],
      { source: 'provider', chatIds: ['chat'] },
    );
    await bounded.transact(
      () => [
        upsert('chat', message('m3', '漢'.repeat(1000))),
        upsert('chat', message('m4', '字'.repeat(1000))),
      ],
      { source: 'provider', chatIds: ['chat'] },
    );
    expect(await store.format()).toBe('v4');
    expect(await store.journalFile()).toBeUndefined();
    const manifest: unknown = JSON.parse(
      await readFile(store.manifestPath, 'utf8'),
    );
    expect(manifest).not.toHaveProperty('demotesTo');
  });

  it('re-stamps stream metadata when the journal re-enters after a checkpointed transaction', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    const target = {
      kind: 'delegation' as const,
      chatId: 'chat',
      delegationId: 'first',
      runGeneration: 0,
    };
    await backend.registerTranscriptStream(target);
    await backend.checkpointPendingJournal();
    backend.releaseJournal();
    const bounded = new ChatStateV2Backend(store, {
      deltaJournal: { largeRecordBytes: 4096 },
      enableFormat4: true,
    });
    await bounded.load();
    await bounded.transact(
      () => [upsert('chat', message('m2', '漢'.repeat(3000)))],
      { source: 'provider', chatIds: ['chat'] },
    );
    expect(await store.journalFile()).toBeUndefined();
    await bounded.registerTranscriptStream({ ...target, delegationId: 'next' });
    const indexes = await store.indexes();
    const transcripts = join(store.directory, 'transcripts');
    expect(
      (await loadStreamCatalog(transcripts)).checkpointRevision,
    ).toBeLessThanOrEqual(indexes.live.revision);
    await bounded.checkpointPendingJournal();
    expect(
      (await loadStreamCatalog(transcripts)).parents.chat?.entryCount,
    ).toBe(2);
    expect((await store.indexes()).live.tabs.map((tab) => tab.id)).toEqual([
      'chat',
    ]);
  });

  it('syncs every directory a new stream registration creates before publishing', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    await backend.registerTranscriptStream({
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 0,
    });
    const synced = jest.spyOn(directorySync, 'fsyncDirectory');
    try {
      await backend.checkpointPendingJournal();
      const delegations = join(store.directory, 'transcripts', 'delegations');
      const paths = synced.mock.calls.map(([path]) => path);
      for (const directory of [
        join(delegations, 'chat', 'v2'),
        join(delegations, 'chat'),
        delegations,
        join(store.directory, 'transcripts'),
      ])
        expect(paths).toContain(directory);
    } finally {
      synced.mockRestore();
    }
  });

  it('removes a parent deleted in checkpointed format 4 when the journal re-enters', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([
        { id: 'chat', messages: [message('m1', 'hello')] },
        { id: 'other', messages: [message('m2', 'bye')] },
      ]),
    );
    await backend.registerTranscriptStream({
      kind: 'delegation',
      chatId: 'other',
      delegationId: 'child',
      runGeneration: 0,
    });
    await backend.checkpointPendingJournal();
    await backend.demoteFromDeltaJournal();
    await backend.transact(() => [{ type: 'tab.removed', tabId: 'other' }], {
      source: 'automation',
      chatIds: ['other'],
    });
    expect(await store.journalFile()).toBeUndefined();
    const transcripts = join(store.directory, 'transcripts');
    await expect(
      stat(join(transcripts, 'delegations', 'other')),
    ).resolves.toBeDefined();
    await backend.registerTranscriptStream({
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 0,
    });
    await expect(
      stat(join(transcripts, 'delegations', 'other')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await loadStreamCatalog(transcripts)).parents).not.toHaveProperty(
      'other',
    );
    expect((await store.indexes()).live.tabs.map((tab) => tab.id)).toEqual([
      'chat',
    ]);
  });

  it('captures after a checkpointed transaction deletes a registered parent', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([
        { id: 'chat', messages: [message('m1', 'hello')] },
        { id: 'other', messages: [message('m2', 'bye')] },
      ]),
    );
    await backend.registerTranscriptStream({
      kind: 'delegation',
      chatId: 'other',
      delegationId: 'child',
      runGeneration: 0,
    });
    await backend.checkpointPendingJournal();
    await backend.demoteFromDeltaJournal();
    await backend.transact(() => [{ type: 'tab.removed', tabId: 'other' }], {
      source: 'automation',
      chatIds: ['other'],
    });
    await backend.flush();
    const transcripts = join(store.directory, 'transcripts');
    expect((await loadStreamCatalog(transcripts)).parents).not.toHaveProperty(
      'other',
    );
    await expect(
      stat(join(transcripts, 'delegations', 'other')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const capture = new ChatStorageV2(root, 'capture', undefined, {
      maxManifestVersion: 4,
    });
    await store.copyTo(capture);
    expect((await capture.indexes()).live.tabs.map((tab) => tab.id)).toEqual([
      'chat',
    ]);
  });

  it('replays a committed import after streams are registered', async () => {
    const { backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    const source = new ChatStorageV2(root, 'source');
    await source.migrate(
      scopeSource([{ id: 'imported', messages: [message('m2', 'world')] }]),
    );
    const metadata = await new ChatStateV2Backend(source).state();
    const options = { merge: true, mutationId: 'import-once' };
    await expect(
      backend.importScope(source, metadata, options),
    ).resolves.toMatchObject({ applied: true });
    await backend.registerTranscriptStream({
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 0,
    });
    await backend.checkpointPendingJournal();
    await expect(
      backend.importScope(source, metadata, options),
    ).resolves.toMatchObject({ applied: false });
  });

  it('imports unrelated rows while preserving a registration pending in the journal', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    await backend.registerTranscriptStream({
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'pending',
      runGeneration: 0,
    });
    const source = new ChatStorageV2(root, 'source');
    await source.migrate(
      scopeSource([{ id: 'imported', messages: [message('m2', 'world')] }]),
    );
    const metadata = await new ChatStateV2Backend(source).state();
    await expect(
      backend.importScope(source, metadata, { merge: true }),
    ).resolves.toMatchObject({ applied: true });
    expect((await store.indexes()).live.tabs.map((tab) => tab.id)).toEqual([
      'chat',
      'imported',
    ]);
  });

  it('routes an option-off format-4 import through checkpointed format 4, never version 2', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('m1', 'hello')] }]),
    );
    const source = new ChatStorageV2(root, 'source');
    await source.migrate(
      scopeSource([{ id: 'imported', messages: [message('m2', 'world')] }]),
    );
    const metadata = await new ChatStateV2Backend(source).state();
    backend.releaseJournal();
    const optionOff = reopenFormat4Scope(root, 'scope', {
      enableFormat4: false,
    });
    await optionOff.backend.importScope(source, metadata, { merge: true });
    const manifest: unknown = JSON.parse(
      await readFile(store.manifestPath, 'utf8'),
    );
    expect(manifest).toMatchObject({ version: 4 });
    expect(manifest).not.toHaveProperty('journal');
    expect(manifest).not.toHaveProperty('demotesTo');
    expect((await store.indexes()).live.tabs.map((tab) => tab.id)).toContain(
      'imported',
    );
    optionOff.backend.releaseJournal();
  });
});

describe('format-4 streamed compatibility import', () => {
  let root: string;
  let source: ChatStorageV2;
  let destination: ChatStorageV2;
  let backend: ChatStateV2Backend;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-format4-large-'));
    source = new ChatStorageV2(root, 'large-source');
    await source.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: 'large', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
          yield await Promise.resolve({
            metadata: { id: 'large', title: 'large', createdAt: '2026-10-01' },
            messages:
              (async function* (): AsyncGenerator<PersistedChatMessage> {
                for (let index = 0; index < 2050; index += 1) {
                  yield message(`row-${index}`, 'x'.repeat(32 * 1024));
                  if (index % 128 === 0)
                    await new Promise((resolve) => setImmediate(resolve));
                }
              })(),
          });
        })(),
      }),
    );
    ({ store: destination, backend } = await format4Scope(
      root,
      'large-destination',
      scopeSource([{ id: 'existing', messages: [message('one', 'small')] }]),
    ));
  }, 120_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('imports more than 64 MiB without a journal commit or manifest downgrade', async () => {
    const publications: unknown[] = [];
    const rename = fsPromises.rename;
    const spy = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (from, to) => {
        if (String(to) === destination.manifestPath)
          publications.push(JSON.parse(await readFile(from, 'utf8')));
        return rename(from, to);
      });
    try {
      resetWorkCounters();
      const metadata = await new ChatStateV2Backend(source).state();
      await backend.importScope(source, metadata, { merge: true });
      const counters = snapshotWorkCounters().chatStorage;
      expect(counters['written.deltaJournal.bytes'] ?? 0).toBeLessThan(4096);
    } finally {
      spy.mockRestore();
    }
    expect(publications.length).toBeGreaterThan(0);
    for (const publication of publications) {
      expect(publication).toMatchObject({ version: 4 });
      expect(publication).not.toHaveProperty('demotesTo');
    }
    expect(
      (await destination.indexes()).live.tabs.find((tab) => tab.id === 'large')
        ?.transcript.committedMessageCount,
    ).toBe(2050);
  }, 120_000);

  it('recovers one over-64-MiB import after the file WAL is synced', async () => {
    const { store, backend: importing } = await format4Scope(
      root,
      'crash-destination',
      scopeSource([{ id: 'existing', messages: [message('one', 'small')] }]),
    );
    const sync = directorySync.fsyncDirectory;
    let interrupted = false;
    const spy = jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        await sync(directory);
        if (
          !interrupted &&
          directory === store.directory &&
          (
            await readFile(join(directory, 'metadata-journal.jsonl'), 'utf8')
          ).trim()
        ) {
          interrupted = true;
          throw new Error('interrupted after WAL sync');
        }
      });
    const metadata = await new ChatStateV2Backend(source).state();
    try {
      await expect(
        importing.importScope(source, metadata, { merge: true }),
      ).rejects.toThrow('interrupted after WAL sync');
    } finally {
      spy.mockRestore();
    }
    expect(interrupted).toBe(true);
    const reopened = reopenFormat4Scope(root, 'crash-destination');
    expect(
      (await reopened.backend.load()).live.tabs.find(
        (tab) => tab.id === 'large',
      )?.transcript.committedMessageCount,
    ).toBe(2050);
    const manifest: unknown = JSON.parse(
      await readFile(store.manifestPath, 'utf8'),
    );
    expect(manifest).toMatchObject({ version: 4 });
    expect(manifest).not.toHaveProperty('demotesTo');
  }, 120_000);
});
