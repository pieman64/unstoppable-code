import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import { ChatSearchService } from '../chat-search/service';
import {
  ChatSearchIndexer,
  buildChatSearchDoc,
  transcriptFingerprint,
} from '../chat-search/indexer';
import {
  ChildSearchText,
  CHILD_SEARCH_TEXT_BYTES,
} from '../chat-search/child-text';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import {
  format4Scope,
  snapshotFormat4Files,
} from './helpers/chat-format4-scope';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { commitArchivedContainer } from '../lib/archived-containers';
import {
  getArchivedContainerDir,
  getWorkspaceChatHistoryDir,
} from '../lib/paths';
import { scopeSource } from './helpers/chat-delta-journal-harness';
import { text, upsert } from './helpers/chat-delta-journal-scope';
import { eventually } from './helpers/chat-delta-journal-sync-gate';
import { child, parent, target } from './helpers/stream-closure-copy-fixture';
import type { ChatWaitOperation } from '../observability/chat-wait-diagnostics';

jest.mock('electron', (): { BrowserWindow: { getAllWindows: () => [] } } => ({
  BrowserWindow: { getAllWindows: (): [] => [] },
}));
jest.mock(
  '../observability',
  (): {
    getObservabilityService: () => { recordSessionDiagnostic: jest.Mock };
  } => ({
    getObservabilityService: (): { recordSessionDiagnostic: jest.Mock } => ({
      recordSessionDiagnostic: jest.fn(),
    }),
  }),
);

jest.setTimeout(120_000);

function isGarbageCollector(value: unknown): value is () => void {
  return typeof value === 'function';
}

function garbageCollector(): () => void {
  setFlagsFromString('--expose-gc');
  const gc: unknown = runInNewContext('gc');
  if (!isGarbageCollector(gc)) throw new Error('gc is unavailable');
  return gc;
}
const scope = { projectId: 'project', worktreeId: 'worktree' };

describe('registered child search documents, option off', () => {
  let root: string;
  let previousDataDir: string | undefined;
  let state: ChatStateService;
  let search: ChatSearchService;
  let indexer: ChatSearchIndexer;

  function newSearch(): ChatSearchService {
    return new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => {
        indexer = new ChatSearchIndexer(db);
        return indexer;
      },
      debounceMs: 60_000,
      broadcastUpdated: () => undefined,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'child-search-'));
    previousDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = root;
    resetResolvedCanopyDataDirForTests();
    state = new ChatStateService({
      repository: new ChatStateV2Repository(),
      recordDiagnostic: (): void => undefined,
      cleanupSession: (): Promise<void> => Promise.resolve(),
    });
    resetChatStateServiceForTests(state);
    search = newSearch();
    state.subscribeChildSearchDirty((event) => search.childSearchDirty(event));
  });

  afterEach(async () => {
    await search.close();
    await state.drain();
    resetChatStateServiceForTests();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    resetResolvedCanopyDataDirForTests();
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(): Promise<void> {
    const source = await format4Scope(
      join(root, 'workspaces', 'project'),
      'worktree',
      scopeSource([{ id: 'chat', messages: [parent()] }]),
    );
    await source.backend.registerTranscriptStream(target);
    const rows: DelegationChildRow[] = Array.from({ length: 106 }, (_, i) => ({
      ...child(true, i === 0 ? 'oldpagecobaltneedle' : `row ${i}`),
      id: `row-${i}`,
      delegationSequence: i,
    }));
    rows[50] = {
      ...child(true),
      id: 'row-50',
      delegationSequence: 50,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'tool',
          toolName: 'Read',
          isError: false,
          output:
            'preview '.repeat(15000) +
            'referencedjasperneedle' +
            ' tail'.repeat(15000),
        },
      ],
    };
    await source.backend.commitChildStream(target, 'initial', rows.reverse());
    await source.backend.demoteFromDeltaJournal();
  }

  async function indexParent(): Promise<void> {
    search.indexLiveTabs(
      'project',
      'worktree',
      (await state.getState(scope)).tabsFile,
    );
    await search.flushPendingUpdates();
  }

  it('finds an under-cap old child page with a document locator and parent navigation', async () => {
    await fixture();
    await indexParent();
    expect(search.query({ query: 'oldpagecobaltneedle' })).toEqual([
      expect.objectContaining({
        documentKind: 'chat-child',
        chatId: 'chat',
        projectId: 'project',
        worktreeId: 'worktree',
        childLocator: { delegationId: 'delegate', runGeneration: 1 },
      }),
    ]);
  });

  it('finds a tool body needle beyond its preview without growing the parent', async () => {
    await fixture();
    await indexParent();
    expect(search.query({ query: 'referencedjasperneedle' })).toEqual([
      expect.objectContaining({
        documentKind: 'chat-child',
        chatId: 'chat',
        childLocator: { delegationId: 'delegate', runGeneration: 1 },
      }),
    ]);
    const tab = (await state.getState(scope)).tabsFile.tabs[0];
    expect(tab.transcript).toBeDefined();
    if (!tab.transcript)
      throw new Error('Expected canonical parent descriptor');
    expect(
      indexer.getIndexedBodiesIfTranscriptUnchanged(
        'project/worktree/chat/live',
        transcriptFingerprint(tab.transcript),
      ),
    ).toEqual(expect.objectContaining({ body: '' }));
  });

  function seedStandIn(): void {
    // The old schema has no child kind. A real indexed chat document with
    // the same palette owner stands in for the already-indexed child.
    indexer.upsertDoc({
      ...buildChatSearchDoc(
        'project',
        'worktree',
        'live',
        { id: 'chat', title: 'chat', createdAt: '2026-10-01', messages: [] },
        undefined,
        undefined,
        'seedamberneedle',
      ),
      docId: 'existing-child-stand-in',
    });
    expect(search.query({ query: 'seedamberneedle' })).toHaveLength(1);
  }

  it('does not hold the projected parent text while reconciling its children', async () => {
    await fixture();
    const gc = garbageCollector();
    let projected: WeakRef<object> | undefined;
    await search.close();
    search = new ChatSearchService({
      indexerFactory: (db): ChatSearchIndexer => {
        indexer = new ChatSearchIndexer(db);
        const upsertDoc = indexer.upsertDoc.bind(indexer);
        indexer.upsertDoc = (doc): void => {
          if (doc.documentKind === 'chat') projected = new WeakRef(doc);
          upsertDoc(doc);
        };
        return indexer;
      },
      debounceMs: 60_000,
      broadcastUpdated: (): void => undefined,
    });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => undefined;
    const reconciling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const enumerate = state.listChildSearchDocuments.bind(state);
    const listed = jest
      .spyOn(state, 'listChildSearchDocuments')
      .mockImplementation(async (...args) => {
        entered();
        await gate;
        return enumerate(...args);
      });

    search.indexLiveTabChanges(
      'project',
      'worktree',
      (await state.getState(scope)).tabsFile,
      ['chat'],
      [],
    );
    const flushed = search.flushPendingUpdates();
    await reconciling;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // A WeakRef target stays alive until the current job ends.
      await new Promise((resolve) => setImmediate(resolve));
      gc();
    }
    const parentRetained = projected?.deref() !== undefined;
    release();
    await flushed;
    listed.mockRestore();

    expect(projected).toBeDefined();
    expect(parentRetained).toBe(false);
    expect(search.query({ query: 'oldpagecobaltneedle' })).toEqual([
      expect.objectContaining({ documentKind: 'chat-child', chatId: 'chat' }),
    ]);
  });

  it('refreshes an already indexed child after child-only append despite parent reuse', async () => {
    await fixture();
    await indexParent();
    seedStandIn();
    await state.commitChildStream(scope, target, 'append', [
      {
        ...child(true, 'appendivoryneedle'),
        id: 'appended',
        delegationSequence: 106,
      },
    ]);
    await search.flushPendingUpdates();
    expect(search.query({ query: 'appendivoryneedle' })).toEqual([
      expect.objectContaining({ documentKind: 'chat-child', chatId: 'chat' }),
    ]);
  });

  it('refreshes a checkpointed child-only change on a restart scan', async () => {
    await fixture();
    await search.scanAllSources();
    seedStandIn();
    await state.commitChildStream(scope, target, 'restart-append', [
      {
        ...child(true, 'restartonyxneedle'),
        id: 'restarted',
        delegationSequence: 106,
      },
    ]);
    await state.drain();
    await search.close();
    state = new ChatStateService({
      repository: new ChatStateV2Repository(),
      recordDiagnostic: (): void => undefined,
    });
    resetChatStateServiceForTests(state);
    state.subscribeChildSearchDirty((event) => search.childSearchDirty(event));
    search = newSearch();
    await search.scanAllSources();
    expect(search.query({ query: 'restartonyxneedle' })).toEqual([
      expect.objectContaining({ documentKind: 'chat-child', chatId: 'chat' }),
    ]);
  });

  it('counts a queued child search notification in the queue depth of the commit publication behind it', async () => {
    await fixture();
    const repository = new ChatStateV2Repository();
    const queued: Array<{ depth: number; ownerId: string | undefined }> = [];
    let releaseFirst = (): void => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered = (): void => undefined;
    const firstPublishing = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let published = 0;
    repository.setCommitListener(
      async (): Promise<void> => {
        published += 1;
        if (published > 1) return;
        firstEntered();
        await firstHeld;
      },
      (commit): ChatWaitOperation => ({
        id: `publish-${commit.revision}`,
        name: 'chat_state.publish_commit',
        currentPhase: 'start',
        phase: (): void => undefined,
        attributeOwner: (): void => undefined,
        enterQueue: (depth, owner): void => {
          queued.push({ depth, ownerId: owner()?.id });
        },
        failPhase: (): void => undefined,
        claim: (): void => undefined,
        finish: (): void => undefined,
        noteProjectInventoryCall: (): void => undefined,
      }),
    );
    const write = (id: string): Promise<unknown> =>
      repository.transact(scope, [upsert('chat', text(id, 'probe'))], {
        source: 'provider',
        mutationId: id,
        chatIds: ['chat'],
      });
    try {
      const first = write('first');
      await firstPublishing;
      const childCommit = repository.commitChildStream(
        scope,
        target,
        'queued-append',
        [{ ...child(true, 'queued'), id: 'queued', delegationSequence: 106 }],
      );
      // Its lease turn is queued before the next commit's.
      await new Promise((resolve) => setImmediate(resolve));
      const second = write('second');
      await eventually(
        () => queued.length === 2,
        'the second commit publication is queued',
      );
      // Ahead of it: the held publication, which it names, and the child
      // search notification queued behind that.
      expect(queued.map(({ depth }) => depth)).toEqual([0, 2]);
      expect(queued[0]?.ownerId).toBeUndefined();
      expect(queued[1]?.ownerId).toMatch(/^publish-\d+$/);
      releaseFirst();
      await Promise.all([first, childCommit, second]);
    } finally {
      releaseFirst();
      await repository.drainAll();
    }
  });

  it('stops reconciling children once the parent leaves the live index mid-publish', async () => {
    await fixture();
    await indexParent();
    const publish = state.commitChildSearchDocuments.bind(state);
    // Archive removes the live parent doc without changing the generation.
    const archived = jest
      .spyOn(state, 'commitChildSearchDocuments')
      .mockImplementationOnce(async (...args) => {
        indexer.deleteChatDoc('project', 'worktree', 'chat', 'live');
        return publish(...args);
      });
    const enumerate = state.listChildSearchDocuments.bind(state);
    const listed = jest.spyOn(state, 'listChildSearchDocuments');
    listed.mockImplementation(async (...args) => {
      if (listed.mock.calls.length > 12)
        throw new Error('child reconciliation did not stop');
      return enumerate(...args);
    });
    await state.commitChildStream(scope, target, 'archive-race', [
      {
        ...child(true, 'archiveracegarnet'),
        id: 'archive-race',
        delegationSequence: 106,
      },
    ]);
    await search.flushPendingUpdates();
    await search.flushPendingUpdates();
    // One reconciliation reads the set twice (stage, then confirm); no retry loop.
    expect(listed.mock.calls.length).toBeLessThanOrEqual(2);
    expect(search.query({ query: 'archiveracegarnet' })).toEqual([]);
    archived.mockRestore();
    listed.mockRestore();
  });

  it('drops a queued child refresh for a deleted worktree without reading its state', async () => {
    await fixture();
    await indexParent();
    await state.commitChildStream(scope, target, 'before-delete', [
      {
        ...child(true, 'deletedworktreeamber'),
        id: 'before-delete',
        delegationSequence: 106,
      },
    ]);
    // The refresh waits on the debounce while the worktree is deleted.
    await search.deleteWorktreeDocs('project', 'worktree');
    const reads = jest.spyOn(state, 'getCompatibilityTabs');
    await search.flushPendingUpdates();
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
  });

  it('excludes children from the title catalog and exact parent deletion cascades', async () => {
    await fixture();
    await indexParent();
    expect(
      search.getCatalog().map((row) => [row.chatId, row.documentKind]),
    ).toEqual([['chat', 'chat']]);
    indexer.deleteChatDoc('project', 'worktree', 'chat', 'live');
    expect(search.query({ query: 'oldpagecobaltneedle' })).toEqual([]);
  });

  it('reuses unchanged child text inside SQLite, without rereading artifact ranges', async () => {
    await fixture();
    await indexParent();
    const read = jest.spyOn(state, 'readChildSearchDocument');
    await state.updateCompatibilityTab(
      scope,
      'chat',
      (tab) => ({
        ...tab,
        messages: [
          ...tab.messages,
          {
            id: 'primary-only',
            role: 'assistant',
            timestamp: 100,
            blocks: [{ type: 'text', text: 'primary content only' }],
          },
        ],
      }),
      'primary-only',
    );
    await indexParent();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('enumerates identities without walking the parent transcript', async () => {
    await fixture();
    await state.getState(scope);
    const iterate = jest.spyOn(ChatTranscriptLog.prototype, 'iterate');
    expect(await state.listChildSearchDocuments(scope, 'chat')).toHaveLength(1);
    expect(iterate).not.toHaveBeenCalled();
    iterate.mockRestore();
  });

  it('reads a much larger referenced body in bounded slices and enforces the UTF-8 cap', async () => {
    await fixture();
    const large = 'é'.repeat(10 * 1024 * 1024) + 'pastcaprubyneedle';
    await state.commitChildStream(scope, target, 'large-body', [
      {
        ...child(true),
        id: 'large',
        delegationSequence: 106,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'large',
            toolName: 'Read',
            isError: false,
            output: large,
          },
        ],
      },
    ]);
    const range = jest.spyOn(ChatTranscriptArtifacts.prototype, 'readRange');
    const expand = jest.spyOn(
      ChatTranscriptArtifacts.prototype,
      'expandBlocks',
    );
    const [identity] = await state.listChildSearchDocuments(scope, 'chat');
    const document = await state.readChildSearchDocument(scope, identity);
    expect(Buffer.byteLength(document.body, 'utf8')).toBeLessThanOrEqual(
      CHILD_SEARCH_TEXT_BYTES,
    );
    expect(document.body).toContain('oldpagecobaltneedle');
    expect(document.body).not.toContain('pastcaprubyneedle');
    expect(document.body).not.toContain('\ufffd');
    expect(range.mock.calls.length).toBeGreaterThan(200);
    expect(range.mock.calls.every((call) => (call[3] ?? 0) <= 65_536)).toBe(
      true,
    );
    expect(expand).not.toHaveBeenCalled();
    range.mockRestore();
    expand.mockRestore();
  });

  it('counts prefixes and never splits a UTF-8 encoded character', () => {
    const text = new ChildSearchText();
    text.append('x'.repeat(CHILD_SEARCH_TEXT_BYTES - 3));
    text.append('😀');
    text.append('é');
    expect(Buffer.byteLength(text.text())).toBe(CHILD_SEARCH_TEXT_BYTES - 1);
    expect(text.text().endsWith('é')).toBe(true);
    expect(text.text()).not.toContain('\ufffd');
  });

  it('iterates a paged-block row without whole-row expansion', async () => {
    await fixture();
    await state.commitChildStream(scope, target, 'paged-blocks', [
      {
        ...child(true),
        id: 'paged',
        delegationSequence: 106,
        blocks: Array.from({ length: 600 }, (_, i) => ({
          type: 'text' as const,
          text: i === 599 ? 'pagedsilverneedle' : 'paged padding '.repeat(100),
        })),
      },
    ]);
    const expand = jest.spyOn(
      ChatTranscriptArtifacts.prototype,
      'expandBlocks',
    );
    const [identity] = await state.listChildSearchDocuments(scope, 'chat');
    const document = await state.readChildSearchDocument(scope, identity);
    expect(document.body).toContain('pagedsilverneedle');
    expect(expand).not.toHaveBeenCalled();
    expand.mockRestore();
  });

  it('cancels bounded reads and rejects a stale descriptor rather than indexing changed content', async () => {
    await fixture();
    const [identity] = await state.listChildSearchDocuments(scope, 'chat');
    const controller = new AbortController();
    controller.abort();
    await expect(
      state.readChildSearchDocument(scope, identity, controller.signal),
    ).rejects.toThrow();
    await state.commitChildStream(scope, target, 'changed', [
      {
        ...child(true, 'changedtopazneedle'),
        id: 'changed',
        delegationSequence: 106,
      },
    ]);
    await expect(
      state.readChildSearchDocument(scope, identity),
    ).rejects.toThrow('superseded');
  });

  it('does not resurrect a scope purged after the child has been staged', async () => {
    await fixture();
    const publish = state.commitChildSearchDocuments.bind(state);
    const guarded = jest
      .spyOn(state, 'commitChildSearchDocuments')
      .mockImplementationOnce(async (...args) => {
        await search.deleteWorktreeDocs('project', 'worktree');
        return publish(...args);
      });
    await indexParent();
    expect(search.query({ query: 'oldpagecobaltneedle' })).toEqual([]);
    expect(search.getCatalog()).toEqual([]);
    guarded.mockRestore();
  });

  it('retains the previous child set when a bounded field read fails', async () => {
    await fixture();
    await indexParent();
    await state.commitChildStream(scope, target, 'changed-body', [
      { ...child(true, 'newquartzneele'), id: 'new', delegationSequence: 106 },
    ]);
    const read = jest
      .spyOn(state, 'readChildSearchDocument')
      .mockRejectedValueOnce(new Error('range close failed'));
    await expect(search.flushPendingUpdates()).rejects.toThrow(
      'range close failed',
    );
    expect(search.query({ query: 'oldpagecobaltneedle' })).toHaveLength(1);
    expect(search.query({ query: 'newquartzneele' })).toEqual([]);
    read.mockRestore();
  });

  it('rebuilds child ownership through rename, fork, archive, restore and purge', async () => {
    await fixture();
    await indexParent();
    await state.updateCompatibilityTab(
      scope,
      'chat',
      (tab) => ({ ...tab, title: 'Renamed parent' }),
      'rename',
      { metadataOnly: true },
    );
    await indexParent();
    expect(search.query({ query: 'oldpagecobaltneedle' })[0].title).toBe(
      'Renamed parent',
    );
    expect(
      (
        await state.command({
          schemaVersion: 1,
          commandId: 'fork',
          ...scope,
          command: {
            type: 'chat.fork_tab',
            sourceTabId: 'chat',
            targetTabId: 'copy',
          },
        })
      ).outcome,
    ).toBe('applied');
    await indexParent();
    expect(
      search
        .query({ query: 'oldpagecobaltneedle' })
        .map((row) => row.chatId)
        .sort(),
    ).toEqual(['chat', 'copy']);
    expect(
      (
        await state.command({
          schemaVersion: 1,
          commandId: 'archive',
          ...scope,
          command: { type: 'chat.archive_tab', tabId: 'chat' },
        })
      ).outcome,
    ).toBe('applied');
    search.worktreeChatArchived('project', 'worktree', 'chat');
    await search.flushPendingUpdates();
    expect(
      search
        .query({ query: 'oldpagecobaltneedle' })
        .find((row) => row.chatId === 'chat')?.source,
    ).toBe('worktree-archive');
    expect(
      (
        await state.command({
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
    await indexParent();
    search.indexWorktreeArchives('project', 'worktree');
    await search.flushPendingUpdates();
    expect(
      search
        .query({ query: 'oldpagecobaltneedle' })
        .map((row) => [row.chatId, row.source])
        .sort(),
    ).toEqual([
      ['copy', 'live'],
      ['restored', 'live'],
    ]);
    await search.deleteWorktreeDocs('project', 'worktree');
    expect(search.query({ query: 'oldpagecobaltneedle' })).toEqual([]);
  });

  it('indexes native archived-container and standalone sources with read-only backends', async () => {
    await fixture();
    await state.command({
      schemaVersion: 1,
      commandId: 'archive-for-capture',
      ...scope,
      command: { type: 'chat.archive_tab', tabId: 'chat' },
    });
    const container = getArchivedContainerDir('project', 'captured');
    await state.captureStorageScope(
      scope,
      new ChatStorageV2(container, 'captured'),
    );
    await commitArchivedContainer({
      version: 1,
      id: 'captured',
      kind: 'work-entry',
      projectId: 'project',
      name: 'Captured entry',
      createdAt: '2026-10-01T00:00:00.000Z',
      archivedAt: '2026-10-20T00:00:00.000Z',
      retentionDays: 365,
      expiresAt: '2099-10-20T00:00:00.000Z',
      chatCount: 0,
      archivedChatCount: 1,
      executionCount: 0,
    });
    const history = getWorkspaceChatHistoryDir('project', 'chat');
    await state.captureStorageScope(scope, new ChatStorageV2(history, 'chat'));
    await writeFile(
      join(history, 'meta.json'),
      JSON.stringify({
        version: 1,
        id: 'chat',
        title: 'History entry',
        description: 'Archived child search control',
        createdAt: '2026-10-01T00:00:00.000Z',
        archived: true,
        archivedAt: '2026-10-20T00:00:00.000Z',
      }),
    );
    const containerBefore = await snapshotFormat4Files(container);
    const historyBefore = await snapshotFormat4Files(history);
    await search.scanAllSources();
    const hits = search.query({ query: 'oldpagecobaltneedle' });
    expect(hits.find((row) => row.source === 'archived-container')).toEqual(
      expect.objectContaining({
        worktreeId: 'captured',
        documentKind: 'chat-child',
        childLocator: { delegationId: 'delegate', runGeneration: 1 },
      }),
    );
    expect(hits.find((row) => row.source === 'cowork-archive')).toEqual(
      expect.objectContaining({
        worktreeId: 'home',
        documentKind: 'chat-child',
        childLocator: { delegationId: 'delegate', runGeneration: 1 },
      }),
    );
    expect(await snapshotFormat4Files(container)).toEqual(containerBefore);
    expect(await snapshotFormat4Files(history)).toEqual(historyBefore);
  });

  it('cancels a traversal if its owner is deleted between bounded ranges', async () => {
    await fixture();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Applied with the original receiver below.
    const actual = ChatTranscriptArtifacts.prototype.readRange;
    const range = jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'readRange')
      .mockImplementationOnce(async function (
        this: ChatTranscriptArtifacts,
        ...args
      ) {
        const result = await actual.apply(this, args);
        await search.deleteWorktreeDocs('project', 'worktree');
        return result;
      });
    await indexParent();
    expect(search.query({ query: 'referencedjasperneedle' })).toEqual([]);
    expect(search.getCatalog()).toEqual([]);
    expect(range).toHaveBeenCalledTimes(1);
    range.mockRestore();
  });
});
