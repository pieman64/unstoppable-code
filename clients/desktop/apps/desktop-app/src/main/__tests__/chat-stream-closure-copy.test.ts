import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { format4Scope, reopenFormat4Scope } from './helpers/chat-format4-scope';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import {
  child,
  parent,
  sourceFixture,
  target,
} from './helpers/stream-closure-copy-fixture';
import {
  streamRegistryPaths,
  parseStreamDescriptor,
} from '../lib/chat-delta-journal/stream-registry';
import { delegationStreamKey } from '../lib/transcript-stream-paths';
import {
  repositoryAt,
  drainOpenRepositories,
} from './helpers/chat-delta-journal-scope';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import * as streamRegistry from '../lib/chat-delta-journal/stream-registry';
import type * as FsPromises from 'node:fs/promises';
import { ChatStateService } from '../services/chat-state-service';
import type { CanonicalChatState } from '../services/chat-state-reducer';
import { ChatArtifactMaintenance } from '../lib/chat-artifact-maintenance';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';

jest.setTimeout(60_000);
describe('captured stream closure copies (option off)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stream-copy-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await drainOpenRepositories();
    await rm(root, { recursive: true, force: true });
  });
  async function destination(): Promise<ReturnType<typeof reopenFormat4Scope>> {
    const seeded = await format4Scope(
      root,
      'destination',
      scopeSource([
        { id: 'existing', messages: [message('existing', 'existing')] },
      ]),
    );
    await seeded.backend.demoteFromDeltaJournal();
    return reopenFormat4Scope(root, 'destination', {
      deltaJournal: false,
      enableFormat4: false,
    });
  }
  async function selectedMetadata(
    source: Awaited<ReturnType<typeof sourceFixture>>,
    targetId = 'copy',
  ): Promise<Pick<CanonicalChatState, 'tabsFile' | 'archivesFile'>> {
    const state = await source.backend.state();
    const tab = state.tabsFile.tabs.find((tab) => tab.id === 'chat');
    if (!tab) throw new Error('Missing fixture');
    return {
      tabsFile: {
        ...state.tabsFile,
        tabs: [{ ...tab, id: targetId }],
        activeTabId: targetId,
      },
      archivesFile: { ...state.archivesFile, archived: [] },
    };
  }
  it.each(['fork', 'new-id restore'])(
    '%s keeps exact registered child rows',
    async (kind) => {
      const { backend } = await sourceFixture(root);
      const state = await backend.state();
      const tab = state.tabsFile.tabs.find((tab) => tab.id === 'chat');
      if (!tab) throw new Error('Missing fixture parent');
      await backend.transact(
        () => [
          {
            type: 'tab.created',
            tab: { ...tab, id: 'copy', messages: [parent()] },
            transcriptSourceChatId: 'chat',
            replaceTranscript: true,
          },
          ...(kind === 'new-id restore'
            ? [{ type: 'tab.removed' as const, tabId: 'chat' }]
            : []),
        ],
        { source: 'migration', mutationId: kind, fullTranscript: true },
      );
      const page = await backend.childStreamPage(
        { projectId: 'p', worktreeId: 'w' },
        { ...target, chatId: 'copy' },
        2,
        undefined,
        10,
      );
      expect(page.rows).toEqual([child()]);
    },
  );
  it('cross-scope remap re-keys a selected stream at a low destination revision', async () => {
    const source = await sourceFixture(root);
    const dest = await destination();
    const state = await source.backend.state();
    const tab = state.tabsFile.tabs.find((tab) => tab.id === 'chat');
    if (!tab) throw new Error('Missing fixture');
    const metadata = {
      tabsFile: {
        ...state.tabsFile,
        tabs: [{ ...tab, id: 'copy' }],
        activeTabId: 'copy',
      },
      archivesFile: { ...state.archivesFile, archived: [] },
    };
    const committedBytes = await readFile(
      streamRegistryPaths(
        join(source.store.directory, 'transcripts'),
        'chat',
        delegationStreamKey(target),
      ).log,
    );
    await expect(
      dest.backend.importScope(source.store, metadata, {
        merge: true,
        sourceChatIds: { copy: 'chat' },
      }),
    ).resolves.toMatchObject({ applied: true });
    expect(
      await readFile(
        streamRegistryPaths(
          join(dest.store.directory, 'transcripts'),
          'copy',
          delegationStreamKey({ ...target, chatId: 'copy' }),
        ).log,
      ),
    ).toEqual(committedBytes);
    expect(
      (
        await dest.backend.childStreamPage(
          { projectId: 'p', worktreeId: 'w' },
          { ...target, chatId: 'copy' },
          2,
          undefined,
          10,
        )
      ).rows,
    ).toEqual([child()]);
    const registry = await streamRegistry.loadStreamRegistry(
      join(dest.store.directory, 'transcripts'),
      'copy',
      { readOnly: true },
    );
    expect(registry.entries[0].registeredAtRevision).toBe(0);
    expect(registry.header.checkpointRevision).toBe(0);
    const reentry = reopenFormat4Scope(root, 'destination', {
      enableFormat4: false,
    });
    await reentry.backend.load();
    await reentry.backend.promoteToDeltaJournal();
    await reentry.backend.checkpointPendingJournal();
    await reentry.backend.demoteFromDeltaJournal();
    expect(
      (
        await reentry.backend.childStreamPage(
          { projectId: 'p', worktreeId: 'w' },
          { ...target, chatId: 'copy' },
          2,
          undefined,
          10,
        )
      ).rows,
    ).toEqual([child()]);
  });
  it('unrelated source streams do not block a stream-free selected remap', async () => {
    const source = await sourceFixture(root);
    const dest = await destination();
    const state = await source.backend.state();
    const tab = state.tabsFile.tabs.find((tab) => tab.id === 'plain');
    if (!tab) throw new Error('Missing fixture');
    const metadata = {
      tabsFile: {
        ...state.tabsFile,
        tabs: [{ ...tab, id: 'plain-copy' }],
        activeTabId: 'plain-copy',
      },
      archivesFile: { ...state.archivesFile, archived: [] },
    };
    await expect(
      dest.backend.importScope(source.store, metadata, {
        merge: true,
        sourceChatIds: { 'plain-copy': 'plain' },
      }),
    ).resolves.toMatchObject({ applied: true });
  });
  it('permits a format-4 remap when there are no registered streams', async () => {
    const source = await format4Scope(
      root,
      'source',
      scopeSource([{ id: 'plain', messages: [message('plain', 'plain')] }]),
    );
    await source.backend.demoteFromDeltaJournal();
    const dest = await destination();
    const state = await source.backend.state();
    const metadata = {
      tabsFile: {
        ...state.tabsFile,
        tabs: state.tabsFile.tabs.map((tab) => ({ ...tab, id: 'plain-copy' })),
        activeTabId: 'plain-copy',
      },
      archivesFile: state.archivesFile,
    };
    await expect(
      dest.backend.importScope(source.store, metadata, {
        merge: true,
        sourceChatIds: { 'plain-copy': 'plain' },
      }),
    ).resolves.toMatchObject({ applied: true });
  });
  it.each(['open snapshot', 'card state'])(
    '%s changes the captured copy mutation identity',
    async (change) => {
      const source = await sourceFixture(root, 'source', true);
      await destination();
      const repo = repositoryAt(root, { enableFormat4: false });
      const scope = { projectId: 'p', worktreeId: 'source' };
      const dest = { projectId: 'p', worktreeId: 'destination' };
      const state = await source.backend.state();
      const ids: Array<string | undefined> = [];
      jest
        .spyOn(ChatStateV2Backend.prototype, 'importScope')
        .mockImplementation(function (
          this: ChatStateV2Backend,
          _source,
          _metadata,
          options,
        ) {
          ids.push(options?.mutationId);
          return this.transact(() => [], { source: 'migration' });
        });
      await repo.copyChats(scope, dest, state);
      const paths = streamRegistryPaths(
        join(source.store.directory, 'transcripts'),
        'chat',
        delegationStreamKey(target),
      );
      if (change === 'open snapshot') {
        const writer = new ChatStateV2Backend(source.store, {
          deltaJournal: {},
        });
        await writer.commitChildStream(target, 'open-update', [
          child(false, 'updated admitted preview', 1),
        ]);
        await writer.demoteFromDeltaJournal();
      } else {
        const descriptor = parseStreamDescriptor(
          await readFile(paths.descriptor),
        );
        await writeFile(
          paths.descriptor,
          JSON.stringify({
            ...descriptor,
            streamRevision: 2,
            cardState: {
              version: 1,
              status: 'running',
              resultIndex: null,
              error: null,
              usage: null,
              workspaceRevision: null,
              workspaceDiscarded: false,
              stopOutcome: null,
              controlOutcome: null,
              attribution: null,
              capabilitySummary: null,
              nestedChildSummary: null,
              partialPreview: 'changed card only',
              finalPreview: null,
            },
          }),
        );
      }
      await repo.copyChats(scope, dest, state);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toEqual(ids[1]);
      await repo.copyChats(scope, dest, state);
      expect(ids[2]).toEqual(ids[1]);
    },
  );
  it('retries an unpublished catalog orphan immediately, with no caller flush', async () => {
    const source = await sourceFixture(root);
    const dest = await destination();
    const metadata = await selectedMetadata(source);
    const options = {
      merge: true,
      mutationId: 'retry-catalog',
      sourceChatIds: { copy: 'chat' },
    };
    await expect(
      dest.backend.importScope(source.store, metadata, {
        ...options,
        beforePublish: () => {
          throw new Error('after-catalog');
        },
      }),
    ).rejects.toThrow('after-catalog');
    const catalog = await streamRegistry.loadStreamCatalog(
      join(dest.store.directory, 'transcripts'),
    );
    expect(catalog.parents.copy?.entryCount).toBe(1);
    expect((await dest.store.indexes()).live.tabs.map((tab) => tab.id)).toEqual(
      ['existing'],
    );
    await expect(
      dest.backend.importScope(source.store, metadata, options),
    ).resolves.toMatchObject({ applied: true });
    expect(
      (
        await dest.backend.childStreamPage(
          { projectId: 'p', worktreeId: 'w' },
          { ...target, chatId: 'copy' },
          2,
          undefined,
          10,
        )
      ).rows,
    ).toEqual([child()]);
  });
  it.each(['journal', 'between-indexes'])(
    'recovers published closure after %s and replays without pruning',
    async (point) => {
      const source = await sourceFixture(root);
      const dest = await destination();
      const metadata = await selectedMetadata(source);
      const options = {
        merge: true,
        mutationId: 'published-copy',
        sourceChatIds: { copy: 'chat' },
      };
      let faulted = false;
      if (point === 'journal') {
        const storage = new ChatStorageTransactions(dest.store, (boundary) => {
          if (boundary === 'journal' && !faulted) {
            faulted = true;
            return Promise.reject(new Error('post-wal-fault'));
          }
          return Promise.resolve();
        });
        Object.defineProperty(dest.backend, 'storage', { value: storage });
      } else {
        const actual =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        const rename = actual.rename;
        jest.spyOn(actual, 'rename').mockImplementation(async (from, to) => {
          await rename(from, to);
          if (
            to === join(dest.store.directory, 'live-index.json') &&
            !faulted
          ) {
            faulted = true;
            throw new Error('post-wal-fault');
          }
        });
      }
      await expect(
        dest.backend.importScope(source.store, metadata, options),
      ).rejects.toThrow('post-wal-fault');
      jest.restoreAllMocks();
      const reopened = reopenFormat4Scope(root, 'destination', {
        deltaJournal: false,
        enableFormat4: false,
      });
      await reopened.backend.flush();
      await expect(
        reopened.backend.importScope(source.store, metadata, options),
      ).resolves.toMatchObject({ applied: false });
      expect(
        (
          await reopened.backend.childStreamPage(
            { projectId: 'p', worktreeId: 'w' },
            { ...target, chatId: 'copy' },
            2,
            undefined,
            10,
          )
        ).rows,
      ).toEqual([child()]);
    },
  );
  it('refuses indexed empty ids and below-format-4 destinations without staging', async () => {
    const source = await sourceFixture(root);
    const seeded = await format4Scope(
      root,
      'destination',
      scopeSource([{ id: 'chat', messages: [] }]),
    );
    await seeded.backend.demoteFromDeltaJournal();
    const dest = reopenFormat4Scope(root, 'destination', {
      deltaJournal: false,
      enableFormat4: false,
    });
    const metadata = await source.backend.state();
    await expect(
      dest.backend.importScope(source.store, metadata),
    ).rejects.toMatchObject({ code: 'indexed_destination' });
    await expect(
      dest.backend.importScope(
        source.store,
        await selectedMetadata(source, 'chat'),
        { merge: true },
      ),
      // A merge refuses any existing id first, before the stream checks.
    ).rejects.toThrow('Import would overwrite an existing chat');
    expect(
      (
        await streamRegistry.loadStreamCatalog(
          join(dest.store.directory, 'transcripts'),
        )
      ).parents,
    ).toEqual({});
    const oldStore = new ChatStorageV2(root, 'old');
    await oldStore.migrate(scopeSource([{ id: 'old', messages: [] }]));
    const old = new ChatStateV2Backend(oldStore, { deltaJournal: {} });
    await old.promoteToDeltaJournal();
    expect(await oldStore.format()).toBe('v3');
    await expect(
      old.importScope(source.store, await selectedMetadata(source), {
        merge: true,
        sourceChatIds: { copy: 'chat' },
      }),
    ).rejects.toMatchObject({ code: 'unsupported_destination' });
    old.releaseJournal();
  });
  it('refuses a collision with destination-owned registered streams', async () => {
    const source = await sourceFixture(root);
    const dest = await sourceFixture(root, 'destination');
    const catalog = await streamRegistry.loadStreamCatalog(
      join(dest.store.directory, 'transcripts'),
    );
    await expect(
      dest.backend.importScope(
        source.store,
        await selectedMetadata(source, 'chat'),
        { merge: true },
      ),
      // A merge refuses any existing id first, before the stream checks.
    ).rejects.toThrow('Import would overwrite an existing chat');
    expect(
      await streamRegistry.loadStreamCatalog(
        join(dest.store.directory, 'transcripts'),
      ),
    ).toEqual(catalog);
  });
  it('known corrupt closure aborts but an unknown card copies as unknown', async () => {
    const source = await sourceFixture(root);
    const dest = await destination();
    const metadata = await selectedMetadata(source);
    const paths = streamRegistryPaths(
      join(source.store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    );
    await writeFile(paths.log, 'corrupt\n');
    await expect(
      dest.backend.importScope(source.store, metadata, {
        merge: true,
        sourceChatIds: { copy: 'chat' },
      }),
    ).rejects.toThrow('mismatch');
    expect(
      (
        await streamRegistry.loadStreamCatalog(
          join(dest.store.directory, 'transcripts'),
        )
      ).parents,
    ).toEqual({});
    const unknown = await format4Scope(
      root,
      'unknown',
      scopeSource([{ id: 'chat', messages: [parent()] }]),
    );
    await unknown.backend.demoteFromDeltaJournal();
    await dest.backend.importScope(
      unknown.store,
      await selectedMetadata(unknown),
      { merge: true, sourceChatIds: { copy: 'chat' } },
    );
    await expect(
      dest.backend.childStreamDescriptor({ ...target, chatId: 'copy' }),
    ).resolves.toBeUndefined();
    await expect(
      dest.backend.childStreamPage(
        { projectId: 'p', worktreeId: 'w' },
        { ...target, chatId: 'copy' },
        0,
        undefined,
        10,
      ),
    ).rejects.toThrow('Unknown child stream');
  });
  it('rechecks a source deleted after catalog publication and releases all leases', async () => {
    const source = await sourceFixture(root);
    const dest = await destination();
    const metadata = await selectedMetadata(source);
    let prepared = false;
    await expect(
      dest.backend.importScope(source.store, metadata, {
        merge: true,
        sourceChatIds: { copy: 'chat' },
        preparePublish: async () => {
          prepared = true;
          await source.backend.storage.transcripts.childDeleteFence.retire(
            'chat',
          );
        },
      }),
    ).rejects.toMatchObject({ code: 'source_deleted' });
    expect(prepared).toBe(true);
    expect((await dest.store.indexes()).live.tabs.map((tab) => tab.id)).toEqual(
      ['existing'],
    );
    await dest.backend.flush();
    expect(
      (
        await streamRegistry.loadStreamCatalog(
          join(dest.store.directory, 'transcripts'),
        )
      ).parents,
    ).toEqual({});
  });
  it('retains an admitted open prefix independently of a later source finalization', async () => {
    const source = await sourceFixture(root, 'source', true);
    const dest = await destination();
    const snapshotBytes = await readFile(
      join(
        source.store.directory,
        'transcripts',
        'delegations',
        'chat',
        'v2',
        delegationStreamKey(target),
        'transcript.active.json',
      ),
    );
    await dest.backend.importScope(
      source.store,
      await selectedMetadata(source),
      { merge: true, sourceChatIds: { copy: 'chat' }, settleFork: true },
    );
    expect(
      await readFile(
        join(
          dest.store.directory,
          'transcripts',
          'delegations',
          'copy',
          'v2',
          delegationStreamKey({ ...target, chatId: 'copy' }),
          'transcript.active.json',
        ),
      ),
    ).toEqual(snapshotBytes);
    const writer = new ChatStateV2Backend(source.store, { deltaJournal: {} });
    await writer.commitChildStream(target, 'late-final', [
      child(true, 'later source final', 1),
    ]);
    await writer.demoteFromDeltaJournal();
    expect(
      (
        await dest.backend.childStreamPage(
          { projectId: 'p', worktreeId: 'w' },
          { ...target, chatId: 'copy' },
          1,
          undefined,
          10,
        )
      ).rows,
    ).toEqual([child(false)]);
    expect(
      (await dest.backend.childStreamDescriptor({ ...target, chatId: 'copy' }))
        ?.status,
    ).toBe('open');
  });
  it('restores a real archived parent under a new id without holding its delete lease', async () => {
    await sourceFixture(root);
    const repo = repositoryAt(root, { enableFormat4: false });
    const service = new ChatStateService({
      repository: repo,
      recordDiagnostic: (): void => {},
      cleanupSession: (): Promise<void> => Promise.resolve(),
    });
    const scope = { projectId: 'p', worktreeId: 'source' };
    expect(
      (
        await service.command({
          schemaVersion: 1,
          commandId: 'archive',
          ...scope,
          command: { type: 'chat.archive_tab', tabId: 'chat' },
        })
      ).outcome,
    ).toBe('applied');
    expect(
      (
        await service.command({
          schemaVersion: 1,
          commandId: 'restore',
          ...scope,
          command: {
            type: 'chat.restore_archive',
            archiveEntryId: 'chat',
            targetTabId: 'restored',
          },
        })
      ).outcome,
    ).toBe('applied');
    expect(
      (
        await repo.page(scope, 'restored', undefined, undefined, {
          ...scope,
          chatId: 'restored',
          target: { ...target, chatId: 'restored' },
        })
      ).messages,
    ).toEqual([child()]);
  });
  it('copies descriptor-only answers without execution registry and retains them through delete, GC and recapture', async () => {
    const source = await sourceFixture(root);
    const artifacts = source.backend.storage.transcripts.artifacts;
    const answer = await artifacts.put(
      'chat',
      'descriptor-only independent answer',
    );
    const paths = streamRegistryPaths(
      join(source.store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    );
    const descriptor = parseStreamDescriptor(await readFile(paths.descriptor));
    await writeFile(
      paths.descriptor,
      streamRegistry.encodeStreamDescriptor({
        ...descriptor,
        cardState: {
          version: 2,
          cardRevision: 1,
          canonical: {
            status: 'completed',
            resultIndex: 1,
            finalText: 'answer preview',
            finalTextRef: answer,
          },
        },
      }),
    );
    const sourceAnswer = await readFile(
      join(
        source.store.directory,
        'transcripts',
        'tool-output',
        'chat',
        `${answer.artifactId}.txt`,
      ),
    );
    const dest = await destination();
    await dest.backend.storage.transcripts.childDeleteFence.retire('copy');
    await dest.backend.importScope(
      source.store,
      await selectedMetadata(source),
      { merge: true, sourceChatIds: { copy: 'chat' } },
    );
    const lease =
      dest.backend.storage.transcripts.childDeleteFence.acquire('copy');
    expect(lease).toBeDefined();
    lease?.release();
    const answerPath = join(
      dest.store.directory,
      'transcripts',
      'tool-output',
      'copy',
      `${answer.artifactId}.txt`,
    );
    expect(await readFile(answerPath)).toEqual(sourceAnswer);
    const generation = {
      chatId: 'copy',
      delegationId: 'delegate',
      runGeneration: 1,
    };
    await expect(dest.backend.generation(generation)).resolves.toBeUndefined();
    await expect(
      dest.backend.resultByGeneration(generation),
    ).resolves.toBeUndefined();
    await expect(
      readFile(
        join(
          dest.store.directory,
          'transcripts',
          'delegations',
          'copy',
          'registry',
          'manifest.json',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await source.backend.transact(
      () => [{ type: 'tab.removed', tabId: 'chat' }],
      { source: 'migration' },
    );
    await source.backend.flush();
    const maintenance = new ChatArtifactMaintenance(
      dest.backend.storage,
      dest.store.directory,
    );
    try {
      let complete = false;
      for (let i = 0; i < 64 && !complete; i++)
        complete = (await maintenance.maintain('copy', 1024)).complete;
      expect(complete).toBe(true);
    } finally {
      await maintenance.dispose();
    }
    expect(await readFile(answerPath)).toEqual(sourceAnswer);
    const capture = new ChatStorageV2(root, 'recapture');
    await dest.store.copyTo(capture);
    expect(
      await readFile(
        join(
          capture.directory,
          'transcripts',
          'tool-output',
          'copy',
          `${answer.artifactId}.txt`,
        ),
      ),
    ).toEqual(sourceAnswer);
  });
  it('detects a card in block pages and checkpoints admitted source work before a fork', async () => {
    const source = await sourceFixture(root, 'source', true);
    const writer = new ChatStateV2Backend(source.store, {
      deltaJournal: {},
      enableFormat4: false,
    });
    const pages = new ChatTranscriptArtifacts(
      join(source.store.directory, 'transcripts'),
      false,
      {
        rowTargetBytes: 4096,
        pageTargetBytes: 4096,
        manifestTargetBytes: 4096,
      },
    );
    const paged = await pages.externalize(
      'chat',
      {
        ...parent(),
        blocks: [
          ...Array.from({ length: 100 }, () => ({
            type: 'text' as const,
            text: 'x'.repeat(1024),
          })),
          ...parent().blocks,
        ],
      },
      undefined,
      { kind: 'format4', final: true },
    );
    await writer.transact(
      () => [
        {
          type: 'messages.replaced',
          chatId: 'chat',
          messages: [paged],
          removedMessageIds: [],
        },
      ],
      { source: 'migration', fullTranscript: true },
    );
    await writer.commitChildStream(target, 'admitted-open', [
      child(false, 'admitted open update', 1),
    ]);
    expect(writer.isDeltaJournal()).toBe(true);
    const state = await writer.state({
      chatIds: ['chat'],
      fullTranscript: true,
    });
    const tab = state.tabsFile.tabs.find((tab) => tab.id === 'chat');
    if (!tab) throw new Error('Missing fixture');
    const stored = await writer.storage.transcripts.page('chat');
    expect(stored.messages[0].blocksRef).toBeDefined();
    await writer.transact(
      () => [
        {
          type: 'tab.created',
          tab: { ...tab, id: 'paged-copy' },
          transcriptSourceChatId: 'chat',
        },
      ],
      { source: 'migration', fullTranscript: true },
    );
    expect(writer.isDeltaJournal()).toBe(false);
    expect(
      (
        await writer.childStreamPage(
          { projectId: 'p', worktreeId: 'w' },
          { ...target, chatId: 'paged-copy' },
          2,
          undefined,
          10,
        )
      ).rows,
    ).toEqual([child(false, 'admitted open update', 1)]);
  });
  it('aborts a source retirement during pinned stream staging and releases the pin', async () => {
    const source = await sourceFixture(root);
    const dest = await destination();
    const metadata = await selectedMetadata(source);
    const publish = streamRegistry.publishStreamMetadata;
    let retired: Promise<number> | undefined;
    jest
      .spyOn(streamRegistry, 'publishStreamMetadata')
      .mockImplementation(async (path, bytes) => {
        await publish(path, bytes);
        if (
          path.endsWith('/descriptor.json') &&
          path.startsWith(dest.store.directory) &&
          !retired
        )
          retired =
            source.backend.storage.transcripts.childDeleteFence.retire('chat');
      });
    await expect(
      dest.backend.importScope(source.store, metadata, {
        merge: true,
        sourceChatIds: { copy: 'chat' },
      }),
    ).rejects.toMatchObject({ code: 'source_deleted' });
    expect(retired).toBeDefined();
    await retired;
    expect(
      (
        await streamRegistry.loadStreamCatalog(
          join(dest.store.directory, 'transcripts'),
        )
      ).parents,
    ).toEqual({});
  });
  it('keeps same-digest bodies independently owned by primary and child rows after source deletion and damaged locators', async () => {
    const source = await sourceFixture(root, 'source', true);
    const log = source.backend.storage.transcripts;
    const reference = await log.artifacts.put(
      'chat',
      'one body, primary and child',
    );
    await source.backend.transact(
      () => [
        {
          type: 'messages.replaced',
          chatId: 'chat',
          messages: [
            {
              ...parent(),
              blocks: [
                ...parent().blocks,
                { type: 'text', text: 'preview', textRef: reference },
              ],
            },
          ],
          removedMessageIds: [],
        },
      ],
      { source: 'migration', fullTranscript: true },
    );
    const writer = new ChatStateV2Backend(source.store, { deltaJournal: {} });
    await writer.commitChildStream(target, 'shared-ref', [
      {
        ...child(true, 'preview', 1),
        blocks: [{ type: 'text', text: 'preview', textRef: reference }],
      },
    ]);
    await writer.demoteFromDeltaJournal();
    const expected = await readFile(
      join(
        source.store.directory,
        'transcripts',
        'tool-output',
        'chat',
        `${reference.artifactId}.txt`,
      ),
    );
    const dest = await destination();
    await dest.backend.importScope(
      source.store,
      await selectedMetadata(source),
      { merge: true, sourceChatIds: { copy: 'chat' } },
    );
    const paths = streamRegistryPaths(
      join(dest.store.directory, 'transcripts'),
      'copy',
      delegationStreamKey({ ...target, chatId: 'copy' }),
    );
    await writeFile(paths.index, 'damaged derived locator');
    await writeFile(
      join(paths.streamDirectory, 'transcript.index.json'),
      'damaged derived index',
    );
    await writer.transact(() => [{ type: 'tab.removed', tabId: 'chat' }], {
      source: 'migration',
    });
    await writer.flush();
    const maintenance = new ChatArtifactMaintenance(
      dest.backend.storage,
      dest.store.directory,
    );
    try {
      let complete = false;
      for (let i = 0; i < 64 && !complete; i++)
        complete = (await maintenance.maintain('copy', 1024)).complete;
      expect(complete).toBe(true);
    } finally {
      await maintenance.dispose();
    }
    expect(
      await readFile(
        join(
          dest.store.directory,
          'transcripts',
          'tool-output',
          'copy',
          `${reference.artifactId}.txt`,
        ),
      ),
    ).toEqual(expected);
  });
  it.each([
    ['missing', 'manifest'],
    ['corrupt', 'manifest'],
    ['missing', 'body'],
    ['corrupt', 'body'],
  ])(
    'aborts a known %s %s closure without publishing or deleting its source',
    async (damage, kind) => {
      const source = await sourceFixture(root);
      const sourceRoot = join(source.store.directory, 'transcripts');
      let path: string;
      if (kind === 'manifest') {
        const pages = new ChatTranscriptArtifacts(sourceRoot, false, {
          rowTargetBytes: 4096,
          pageTargetBytes: 4096,
          manifestTargetBytes: 4096,
        });
        const paged = await pages.externalize(
          'chat',
          {
            ...parent(),
            blocks: [
              ...Array.from({ length: 30 }, () => ({
                type: 'text' as const,
                text: 'x'.repeat(1024),
              })),
              ...parent().blocks,
            ],
          },
          undefined,
          { kind: 'format4', final: true },
        );
        if (!paged.blocksRef) throw new Error('Missing fixture block manifest');
        await source.backend.transact(
          () => [
            {
              type: 'messages.replaced',
              chatId: 'chat',
              messages: [paged],
              removedMessageIds: [],
            },
          ],
          { source: 'migration', fullTranscript: true },
        );
        path = join(
          sourceRoot,
          'tool-output',
          'chat',
          `${paged.blocksRef.manifest.artifactId}.txt`,
        );
      } else {
        const reference =
          await source.backend.storage.transcripts.artifacts.put(
            'chat',
            'descriptor body must be present',
          );
        const descriptorPath = streamRegistryPaths(
          sourceRoot,
          'chat',
          delegationStreamKey(target),
        ).descriptor;
        const descriptor = parseStreamDescriptor(
          await readFile(descriptorPath),
        );
        await writeFile(
          descriptorPath,
          streamRegistry.encodeStreamDescriptor({
            ...descriptor,
            cardState: {
              version: 2,
              cardRevision: 1,
              canonical: {
                status: 'completed',
                resultIndex: 1,
                finalText: 'descriptor body must be present',
                finalTextRef: reference,
              },
            },
          }),
        );
        path = join(
          sourceRoot,
          'tool-output',
          'chat',
          `${reference.artifactId}.txt`,
        );
      }
      const metadata = await selectedMetadata(source);
      const sourceRows = await readFile(join(sourceRoot, 'chat.jsonl'));
      if (damage === 'missing') await rm(path);
      else await writeFile(path, 'damaged canonical artifact');
      const dest = await destination();
      await expect(
        dest.backend.importScope(source.store, metadata, {
          merge: true,
          sourceChatIds: { copy: 'chat' },
        }),
      ).rejects.toThrow();
      expect(
        (
          await streamRegistry.loadStreamCatalog(
            join(dest.store.directory, 'transcripts'),
          )
        ).parents,
      ).toEqual({});
      expect(
        (await source.store.indexes()).live.tabs.some(
          (tab) => tab.id === 'chat',
        ),
      ).toBe(true);
      expect(await readFile(join(sourceRoot, 'chat.jsonl'))).toEqual(
        sourceRows,
      );
    },
  );
});
