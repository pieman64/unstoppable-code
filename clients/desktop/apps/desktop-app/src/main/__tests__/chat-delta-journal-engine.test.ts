/**
 * Delta-journal engine: round trip, byte-identical checkpoints, hash chain,
 * torn tails, fail-closed recovery, limits, and the downgrade read path.
 *
 * The byte-identity test runs phase 07's golden command sequence through the
 * real version 2 backend, records each storage transaction it commits, and
 * journals the same transactions in a promoted copy of the starting scope.
 * After every step the replayed journal must equal the version 2 files; after
 * the final checkpoint every file must be byte-identical.
 */
import fs, {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import * as workCounters from '@canopy/desktop-shared/node/work-counters';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import {
  ChatDeltaJournalIntegrityError,
  ChatStorageNewerFormatError,
  DELTA_JOURNAL_FILE_NAME,
  encodeDeltaJournalFrame,
} from '../lib/chat-delta-journal/format';
import { readDeltaJournal } from '../lib/chat-delta-journal/replay';
import { openReplayedChatScope } from '../lib/chat-delta-journal/reader';
import {
  ChatDeltaJournalWriter,
  DeltaJournalCheckpointRequiredError,
  promoteToDeltaJournal,
  type DeltaJournalDiagnostic,
} from '../lib/chat-delta-journal/writer';
import {
  ChatStorageIndexRevisionMismatchError,
  assertChatStorageIndexes,
} from '../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { isRecord } from '../lib/type-guards';
import {
  TRICKY_TEXT,
  cloneScope,
  createV2Scope,
  journalOnlyFile,
  message,
  publishArtifacts,
  recordV2Commits,
  replayedScopeState,
  toolMessage,
  treeDigests,
  v2ScopeState,
  type RecordedCommit,
} from './helpers/chat-delta-journal-harness';
import {
  drainAfterTest,
  drainOpenRepositories,
} from './helpers/chat-delta-journal-scope';
import { enforceWindowsFileSync } from './helpers/windows-file-sync';

const FROZEN = new Date('2026-10-01T12:00:00.000Z');

function freezeDate(): void {
  jest.useFakeTimers({
    now: FROZEN,
    doNotFake: [
      'nextTick',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
      'queueMicrotask',
      'hrtime',
      'performance',
    ],
  });
}

const INITIAL_CHATS = [
  {
    id: 'chat',
    messages: [
      message('m0', 'hello', 'user'),
      message('m1', TRICKY_TEXT),
      message('m2', 'large timestamp', 'assistant', 1e21),
    ],
  },
  { id: 'sibling', messages: [message('s0', 'sibling', 'user')] },
];

interface Pair {
  v2: ChatStorageV2;
  journal: ChatStorageV2;
  writer: ChatDeltaJournalWriter;
  backend: ChatStateV2Backend;
  pending: RecordedCommit[];
  stop: () => void;
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(15_000);

describe('chat delta journal engine', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-engine-'));
    freezeDate();
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await drainOpenRepositories();
    await rm(root, { recursive: true, force: true });
  });

  async function pair(): Promise<Pair> {
    const v2 = await createV2Scope(join(root, 'v2'), 'scope', INITIAL_CHATS);
    const journal = await cloneScope(v2, join(root, 'journal'), 'scope');
    await promoteToDeltaJournal(journal);
    const writer = await ChatDeltaJournalWriter.open(journal);
    const backend = new ChatStateV2Backend(v2);
    await backend.load();
    const recorder = recordV2Commits(backend.storage, []);
    return {
      v2,
      journal,
      writer,
      backend,
      pending: recorder.commits,
      stop: recorder.stop,
    };
  }

  /** Journal what version 2 committed since the last call, then compare. */
  async function mirror(state: Pair): Promise<void> {
    for (const commit of state.pending.splice(0)) {
      await publishArtifacts(state.v2, state.journal);
      const result = await state.writer.commit(commit);
      expect(result.applied).toBe(true);
    }
    const expected = await v2ScopeState(state.v2);
    expect(await replayedScopeState(state.journal)).toEqual(expected);
    // The writer's in-memory view agrees with the files too.
    for (const [chatId, chat] of Object.entries(expected.chats)) {
      expect(
        (await state.writer.committedMessages(chatId)).map((row) =>
          JSON.stringify(row),
        ),
      ).toEqual(chat.committed);
      expect(
        (await state.writer.activeMessages(chatId)).map((row) =>
          JSON.stringify(row),
        ),
      ).toEqual(chat.active);
    }
  }

  async function transact(
    state: Pair,
    mutationId: string,
    build: (
      current: Awaited<ReturnType<ChatStateV2Backend['state']>>,
    ) => ChatCoreMutation[],
    options: {
      chatIds?: string[];
      fullTranscript?: boolean;
      receipt?: boolean;
    } = {},
  ): Promise<void> {
    await state.backend.transact((current) => build(current), {
      source: 'automation',
      mutationId,
      ...(options.chatIds ? { chatIds: options.chatIds } : {}),
      ...(options.fullTranscript ? { fullTranscript: true } : {}),
      ...(options.receipt
        ? {
            commandResult: {
              commandId: `command-${mutationId}`,
              revision: 0,
              outcome: 'applied' as const,
              entityId: 'sibling',
            },
          }
        : {}),
    });
    await mirror(state);
  }

  it('journals the golden sequence and checkpoints byte-identical v2 files', async () => {
    const state = await pair();
    await transact(state, 'm-1', () => [
      {
        type: 'runtime.patched',
        chatId: 'chat',
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurn: { userMessageId: 'p1', startedAt: 5 },
        },
      },
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: message('p1', 'prompt é', 'user'),
      },
    ]);
    await transact(state, 'm-2', () => [
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: message('a1', TRICKY_TEXT, 'assistant', -0),
      },
    ]);
    await state.writer.checkpoint();
    await transact(state, 'm-3', () => [
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: message(
          'a1',
          `${TRICKY_TEXT}\n${'long streamed reply 🌲 '.repeat(4096)}`,
        ),
      },
    ]);
    await transact(state, 'm-4', () => [
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: toolMessage('t1', 'tool output 🌲\n'.repeat(6000)),
      },
    ]);
    await transact(state, 'm-5', () => [
      {
        type: 'runtime.patched',
        chatId: 'chat',
        runtime: { status: 'idle', queuedMessageIds: [] },
      },
    ]);
    await transact(
      state,
      'm-6',
      () => [
        {
          type: 'tab.metadata_patched',
          tabId: 'sibling',
          patch: { title: 'Sibling ✓', unread: true },
        },
      ],
      { receipt: true },
    );
    await transact(
      state,
      'm-7',
      () => [
        {
          type: 'tab.created',
          tab: {
            id: 'fresh',
            title: 'Fresh',
            createdAt: '2026-10-01',
            messages: [
              message('f0', 'first', 'user'),
              message('f1', 'nested empties'),
            ],
          },
        },
      ],
      { chatIds: ['fresh'] },
    );
    await state.writer.checkpoint();
    await transact(state, 'm-8', () => [
      { type: 'message.removed', chatId: 'chat', messageId: 'm2' },
    ]);
    await transact(
      state,
      'm-9',
      (current) => {
        const sibling = current.tabsFile.tabs.find(
          (tab) => tab.id === 'sibling',
        );
        if (!sibling) throw new Error('Missing sibling');
        return [
          { type: 'tab.removed', tabId: 'sibling' },
          {
            type: 'archive.upserted',
            entry: { tab: sibling, archivedAt: '2026-10-01', turnCount: 1 },
          },
        ];
      },
      { chatIds: ['sibling'] },
    );
    await transact(state, 'm-10', () => [
      { type: 'tab.removed', tabId: 'fresh' },
    ]);
    const source = await createV2Scope(join(root, 'import'), 'import-source', [
      {
        id: 'imported',
        messages: [
          message('i0', 'imported prompt', 'user'),
          message('i1', TRICKY_TEXT),
        ],
      },
    ]);
    const metadata = await new ChatStateV2Backend(source).state();
    await state.backend.importScope(
      source,
      { tabsFile: metadata.tabsFile, archivesFile: metadata.archivesFile },
      { merge: true, mutationId: 'import-1' },
    );
    await mirror(state);
    state.stop();

    const records = (await readDeltaJournal(state.journal.directory, 'scope'))
      .records.length;
    expect(records).toBeGreaterThan(0);
    await state.writer.checkpoint();
    expect(state.writer.pendingRecordCount).toBe(0);
    expect(await treeDigests(state.journal.directory, journalOnlyFile)).toEqual(
      await treeDigests(state.v2.directory),
    );
    // The rotated journal holds only a segment header continuing the chain.
    const rotated = await readDeltaJournal(state.journal.directory, 'scope');
    expect(rotated.records).toEqual([]);
    expect(rotated.segment.baseRevision).toBe(
      (await state.v2.indexes()).live.revision,
    );
    expect(await state.journal.indexes()).toEqual(await state.v2.indexes());
  }, 120_000);

  async function quarantineFiles(store: ChatStorageV2): Promise<string[]> {
    return (await readdir(store.directory))
      .filter((name) => name.startsWith('delta-journal-tail-quarantine-'))
      .sort();
  }

  async function simpleWriter(): Promise<{
    store: ChatStorageV2;
    writer: ChatDeltaJournalWriter;
  }> {
    const store = await createV2Scope(join(root, 'simple'), 'scope', [
      { id: 'chat', messages: [message('m0', 'hello', 'user')] },
    ]);
    await promoteToDeltaJournal(store);
    return { store, writer: await ChatDeltaJournalWriter.open(store) };
  }

  function appendInput(
    writer: ChatDeltaJournalWriter,
    id: string,
    extra: Partial<RecordedCommit> = {},
  ): RecordedCommit {
    const current = writer.indexes();
    const revision = current.live.revision + 1;
    return {
      expectedRevision: current.live.revision,
      next: {
        live: {
          ...current.live,
          revision,
          tabs: current.live.tabs.map((tab) =>
            tab.id === 'chat' ? { ...tab, title: `title ${id}` } : tab,
          ),
        },
        archive: { ...current.archive, revision },
        recovery: {
          ...current.recovery,
          mutationIds: [...current.recovery.mutationIds, id],
        },
      },
      writes: [{ chatId: 'chat', kind: 'append', messages: [message(id, id)] }],
      mutationIds: [id],
      ...extra,
    };
  }

  it('round-trips records, verifies the hash chain, and reopens to the same state', async () => {
    const { store, writer } = await simpleWriter();
    for (const id of ['a', 'b', 'c'])
      expect((await writer.commit(appendInput(writer, id))).applied).toBe(true);
    const expected = await replayedScopeState(store);
    const journal = await readDeltaJournal(store.directory, 'scope');
    expect(journal.records.map((record) => record.mutationIds)).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
    expect(journal.records[1].prev).not.toBe(journal.records[2].prev);
    const reopened = await ChatDeltaJournalWriter.open(store);
    expect(reopened.revision).toBe(3);
    expect(await replayedScopeState(store)).toEqual(expected);
    expect(
      (await reopened.committedMessages('chat')).map((row) => row.id),
    ).toEqual(['m0', 'a', 'b', 'c']);
    // Records never carry whole indexes or descriptors.
    const bytes = await readFile(
      join(store.directory, DELTA_JOURNAL_FILE_NAME),
    );
    expect(bytes.toString('utf8')).not.toContain('committedDigest');
  });

  it('fails closed on a corrupt record followed by a valid one', async () => {
    const { store, writer } = await simpleWriter();
    for (const id of ['a', 'b', 'c'])
      await writer.commit(appendInput(writer, id));
    const journal = await readDeltaJournal(store.directory, 'scope');
    const path = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    const bytes = await readFile(path);
    const second = journal.records.length > 1;
    expect(second).toBe(true);
    // Flip one payload byte inside the middle record.
    const frames = bytes.toString('latin1');
    const middle = frames.indexOf('"mutationIds":["b"]');
    bytes[middle + 2] ^= 1;
    await writeFile(path, bytes);
    await expect(ChatDeltaJournalWriter.open(store)).rejects.toBeInstanceOf(
      ChatDeltaJournalIntegrityError,
    );
    // Kept as is for inspection: nothing truncated or quarantined.
    expect(await readFile(path)).toEqual(bytes);
    expect(await quarantineFiles(store)).toEqual([]);
    await expect(store.indexes()).rejects.toBeInstanceOf(
      ChatDeltaJournalIntegrityError,
    );
  });

  it('fails closed on a valid record that breaks the hash chain', async () => {
    const { store, writer } = await simpleWriter();
    await writer.commit(appendInput(writer, 'a'));
    const journal = await readDeltaJournal(store.directory, 'scope');
    const forged = encodeDeltaJournalFrame({
      ...journal.records[0],
      fromRevision: 2,
      toRevision: 3,
      prev: '0'.repeat(64),
    });
    await appendFile(
      join(store.directory, DELTA_JOURNAL_FILE_NAME),
      forged.frame,
    );
    await expect(ChatDeltaJournalWriter.open(store)).rejects.toThrow(
      'hash chain is broken',
    );
    await expect(store.indexes()).rejects.toThrow('hash chain is broken');
  });

  it('drops a torn tail with a diagnostic and never applies it', async () => {
    const { store, writer } = await simpleWriter();
    await writer.commit(appendInput(writer, 'a'));
    const before = await replayedScopeState(store);
    const path = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    const size = (await stat(path)).size;
    const journal = await readDeltaJournal(store.directory, 'scope');
    const next = encodeDeltaJournalFrame({
      ...journal.records[0],
      prev: journal.lastDigest,
      fromRevision: 2,
      toRevision: 3,
    });
    // A partial append: the header and half the payload.
    await appendFile(path, next.frame.subarray(0, next.frame.length / 2));
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
    );
    expect(view.tornTail).toEqual({
      offset: size,
      bytes: Math.floor(next.frame.length / 2),
      reason: 'incomplete',
    });
    await view.dispose();
    expect(await replayedScopeState(store)).toEqual(before);
    const diagnostics: DeltaJournalDiagnostic[] = [];
    const reopened = await ChatDeltaJournalWriter.open(store, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(diagnostics).toEqual([
      {
        kind: 'delta_journal_torn_tail_dropped',
        journalBytes: size,
        recordBytes: Math.floor(next.frame.length / 2),
        recordCount: 1,
        journalTailReason: 'incomplete',
      },
    ]);
    expect((await stat(path)).size).toBe(size);
    // A partial frame is truncated, not quarantined.
    expect(await quarantineFiles(store)).toEqual([]);
    expect(reopened.revision).toBe(1);
    // Appending continues the chain after the truncated tail.
    await reopened.commit(appendInput(reopened, 'b'));
    expect(
      (await readDeltaJournal(store.directory, 'scope')).records,
    ).toHaveLength(2);
    // A zero-filled extension (size grew, data never written) is a
    // complete header without a frame: excluded, and kept as evidence.
    await appendFile(path, Buffer.alloc(97));
    expect((await readDeltaJournal(store.directory, 'scope')).tornTail).toEqual(
      expect.objectContaining({ bytes: 97, reason: 'checksum_mismatch' }),
    );
  });

  it('quarantines a complete final frame whose checksum does not match, then truncates it', async () => {
    const { store, writer } = await simpleWriter();
    await writer.commit(appendInput(writer, 'a'));
    const before = await replayedScopeState(store);
    const path = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    const size = (await stat(path)).size;
    const journal = await readDeltaJournal(store.directory, 'scope');
    const next = encodeDeltaJournalFrame({
      ...journal.records[0],
      prev: journal.lastDigest,
      fromRevision: 1,
      toRevision: 2,
    });
    // Full length, garbage content: the sync never completed.
    const garbled = Buffer.from(next.frame);
    garbled[garbled.length - 5] ^= 0x40;
    await appendFile(path, garbled);

    // The read-only helper excludes it, reports why, and changes nothing.
    const untouched = await treeDigests(store.directory);
    const view = await openReplayedChatScope(
      { directory: store.directory, scopeId: 'scope' },
      assertChatStorageIndexes,
    );
    expect(view.tornTail).toEqual({
      offset: size,
      bytes: garbled.length,
      reason: 'checksum_mismatch',
    });
    expect(view.revision).toBe(1);
    await view.dispose();
    expect(await replayedScopeState(store)).toEqual(before);
    expect(await treeDigests(store.directory)).toEqual(untouched);

    // The copy and its directory entry are durable before the truncation.
    const order: string[] = [];
    const fileSync = workCounters.recordChatStorageFileSync;
    jest
      .spyOn(workCounters, 'recordChatStorageFileSync')
      .mockImplementation((synced) => {
        order.push(`file ${basename(synced)}`);
        fileSync(synced);
      });
    const directorySync = workCounters.recordChatStorageDirectorySync;
    jest
      .spyOn(workCounters, 'recordChatStorageDirectorySync')
      .mockImplementation((synced) => {
        if (synced === store.directory) order.push('directory scope');
        directorySync(synced);
      });
    const diagnostics: DeltaJournalDiagnostic[] = [];
    const reopened = await ChatDeltaJournalWriter.open(store, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const truncated = order.indexOf(`file ${DELTA_JOURNAL_FILE_NAME}`);
    const copySynced = order.findIndex((entry) =>
      /^file \.delta-journal-tail-quarantine-.*\.tmp$/.test(entry),
    );
    expect(copySynced).toBeGreaterThanOrEqual(0);
    expect(order.slice(copySynced + 1, truncated)).toContain('directory scope');
    expect(truncated).toBeGreaterThan(copySynced);
    jest.restoreAllMocks();
    expect(diagnostics).toEqual([
      {
        kind: 'delta_journal_torn_tail_dropped',
        journalBytes: size,
        recordBytes: garbled.length,
        recordCount: 1,
        journalTailReason: 'checksum_mismatch',
        journalQuarantineFile: 'delta-journal-tail-quarantine-1.bin',
      },
    ]);
    expect(await quarantineFiles(store)).toEqual([
      'delta-journal-tail-quarantine-1.bin',
    ]);
    expect(
      await readFile(
        join(store.directory, 'delta-journal-tail-quarantine-1.bin'),
      ),
    ).toEqual(garbled);
    expect((await stat(path)).size).toBe(size);
    expect(reopened.revision).toBe(1);
    // Appends continue after the truncated tail and replay correctly.
    await reopened.commit(appendInput(reopened, 'b'));
    expect(
      (await readDeltaJournal(store.directory, 'scope')).records,
    ).toHaveLength(2);
    expect((await replayedScopeState(store)).chats.chat.committed).toEqual(
      ['m0', 'a', 'b'].map((id) =>
        JSON.stringify(
          id === 'm0' ? message('m0', 'hello', 'user') : message(id, id),
        ),
      ),
    );
    // Reopening is a no-op: nothing more to drop, no second quarantine.
    const quiet: DeltaJournalDiagnostic[] = [];
    await ChatDeltaJournalWriter.open(store, {
      onDiagnostic: (diagnostic) => quiet.push(diagnostic),
    });
    expect(quiet).toEqual([]);
    expect(await quarantineFiles(store)).toHaveLength(1);
  });

  it('fails closed on a verified final frame that is not a valid record', async () => {
    const { store, writer } = await simpleWriter();
    await writer.commit(appendInput(writer, 'a'));
    const path = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    // Its checksum proves these are the bytes that were written, so it may
    // have been acknowledged: it is never dropped as a torn tail.
    const payload = Buffer.from('{"not":"a record"', 'utf8');
    const header = Buffer.alloc(40);
    header.write('CDJ1', 0, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    createHash('sha256').update(payload).digest().copy(header, 8);
    await appendFile(path, Buffer.concat([header, payload]));
    const bytes = await readFile(path);
    await expect(ChatDeltaJournalWriter.open(store)).rejects.toBeInstanceOf(
      ChatDeltaJournalIntegrityError,
    );
    await expect(store.indexes()).rejects.toBeInstanceOf(
      ChatDeltaJournalIntegrityError,
    );
    expect(await readFile(path)).toEqual(bytes);
    expect(await quarantineFiles(store)).toEqual([]);
  });

  it('enters recovery_error when a referenced artifact is missing, never an empty chat', async () => {
    const { store, writer } = await simpleWriter();
    await writer.commit({
      ...appendInput(writer, 'a'),
      writes: [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [toolMessage('a', 'large tool output 🌲\n'.repeat(5000))],
        },
      ],
    });
    const before = await treeDigests(store.directory);
    const [name] = Object.keys(before).filter((path) =>
      path.startsWith('transcripts/tool-output/chat/'),
    );
    expect(name).toBeDefined();
    await rm(join(store.directory, name));
    await expect(ChatDeltaJournalWriter.open(store)).rejects.toThrow(
      'missing or damaged artifact',
    );
    await expect(store.indexes()).rejects.toBeInstanceOf(
      ChatDeltaJournalIntegrityError,
    );
  });

  it('publishes and syncs artifacts before the record that references them', async () => {
    const { store, writer } = await simpleWriter();
    const events: string[] = [];
    const sync = workCounters.recordChatStorageFileSync;
    jest
      .spyOn(workCounters, 'recordChatStorageFileSync')
      .mockImplementation((path) => {
        events.push(`sync ${path.slice(store.directory.length)}`);
        sync(path);
      });
    const write = workCounters.recordChatStorageFileWrite;
    jest
      .spyOn(workCounters, 'recordChatStorageFileWrite')
      .mockImplementation((path, bytes, serialized) => {
        events.push(`write ${path.slice(store.directory.length)}`);
        write(path, bytes, serialized);
      });
    await writer.commit({
      ...appendInput(writer, 'a'),
      writes: [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [toolMessage('a', 'x'.repeat(70 * 1024))],
        },
      ],
    });
    const artifactSync = events.findIndex((event) =>
      event.startsWith('sync /transcripts/tool-output/chat/'),
    );
    const journalWrite = events.indexOf(`write /${DELTA_JOURNAL_FILE_NAME}`);
    expect(artifactSync).toBeGreaterThanOrEqual(0);
    expect(journalWrite).toBeGreaterThan(artifactSync);
    expect(events.slice(journalWrite)).toEqual([
      `write /${DELTA_JOURNAL_FILE_NAME}`,
      `sync /${DELTA_JOURNAL_FILE_NAME}`,
    ]);
  });

  it('returns the existing receipt when a synced but unacknowledged commit is retried', async () => {
    const { store, writer } = await simpleWriter();
    const input: RecordedCommit = {
      ...appendInput(writer, 'mutation-1'),
    };
    input.next.recovery.receipts = [
      { commandId: 'command-1', revision: 1, outcome: 'applied' },
    ];
    const crashing = await ChatDeltaJournalWriter.open(store, {
      onBoundary: (point) =>
        point === 'record-synced'
          ? Promise.reject(new Error('crash after sync'))
          : Promise.resolve(),
    });
    await expect(crashing.commit(input)).rejects.toThrow('crash after sync');
    // The writer cannot be used until recovery reads the bytes on disk.
    expect(() => crashing.revision).toThrow('must be reopened');
    const reopened = await ChatDeltaJournalWriter.open(store);
    expect(reopened.revision).toBe(1);
    expect(reopened.hasMutation('mutation-1')).toBe(true);
    expect(reopened.receipt('command-1')).toEqual({
      commandId: 'command-1',
      revision: 1,
      outcome: 'applied',
    });
    const bytes = await readFile(
      join(store.directory, DELTA_JOURNAL_FILE_NAME),
    );
    expect(await reopened.commit(input)).toEqual({
      applied: false,
      revision: 1,
    });
    expect(
      await readFile(join(store.directory, DELTA_JOURNAL_FILE_NAME)),
    ).toEqual(bytes);
    expect(
      (await reopened.committedMessages('chat')).map((row) => row.id),
    ).toEqual(['m0', 'mutation-1']);
  });

  it('requires a checkpoint before recreating a chat deleted since the last one', async () => {
    const { store, writer } = await simpleWriter();
    const current = writer.indexes();
    const [chat] = current.live.tabs;
    await writer.commit({
      expectedRevision: 0,
      next: {
        live: { ...current.live, revision: 1, activeTabId: '', tabs: [] },
        archive: { ...current.archive, revision: 1 },
        recovery: { ...current.recovery, mutationIds: ['delete'] },
      },
      writes: [{ chatId: 'chat', kind: 'delete' }],
      mutationIds: ['delete'],
    });
    const recreate: RecordedCommit = {
      expectedRevision: 1,
      next: {
        live: { ...current.live, revision: 2, tabs: [chat] },
        archive: { ...current.archive, revision: 2 },
        recovery: { ...current.recovery, mutationIds: ['delete', 'create'] },
      },
      writes: [
        {
          chatId: 'chat',
          kind: 'replace',
          messages: [message('n0', 'new', 'user')],
        },
      ],
      mutationIds: ['create'],
    };
    const bytes = await readFile(
      join(store.directory, DELTA_JOURNAL_FILE_NAME),
    );
    expect(writer.checkpointRequiredFor(['chat'])).toBe(true);
    await expect(writer.commit(recreate)).rejects.toBeInstanceOf(
      DeltaJournalCheckpointRequiredError,
    );
    expect(
      await readFile(join(store.directory, DELTA_JOURNAL_FILE_NAME)),
    ).toEqual(bytes);
    await writer.checkpoint();
    expect((await writer.commit(recreate)).applied).toBe(true);
    expect((await replayedScopeState(store)).chats.chat.committed).toEqual([
      JSON.stringify(message('n0', 'new', 'user')),
    ]);
  });

  it('keeps the artifacts of a record whose sync failed while the process lives', async () => {
    const { store } = await simpleWriter();
    const failing = await ChatDeltaJournalWriter.open(store, {
      onBoundary: (point) =>
        point === 'record-written'
          ? Promise.reject(
              Object.assign(new Error('EIO: i/o error, fsync'), {
                code: 'EIO',
              }),
            )
          : Promise.resolve(),
    });
    await expect(
      failing.commit({
        ...appendInput(failing, 'a'),
        writes: [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [toolMessage('a', 'kept output 🌲\n'.repeat(5000))],
          },
        ],
      }),
    ).rejects.toThrow('EIO');
    expect(() => failing.revision).toThrow('must be reopened');
    // The bytes reached the file; recovery decides from them, and the
    // artifacts they reference must still be there.
    const reopened = await ChatDeltaJournalWriter.open(store);
    expect(reopened.revision).toBe(1);
    expect((await replayedScopeState(store)).chats.chat.committed).toHaveLength(
      2,
    );
  });

  it('rejects a row over the 16 MiB limit before writing anything', async () => {
    const { store, writer } = await simpleWriter();
    const bytes = await readFile(
      join(store.directory, DELTA_JOURNAL_FILE_NAME),
    );
    await expect(
      writer.commit({
        ...appendInput(writer, 'a'),
        writes: [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [message('a', 'x'.repeat(16 * 1024 * 1024 + 1))],
          },
        ],
      }),
    ).rejects.toThrow('Transcript row exceeds maximum size');
    expect(
      await readFile(join(store.directory, DELTA_JOURNAL_FILE_NAME)),
    ).toEqual(bytes);
    expect(writer.revision).toBe(0);
  }, 60_000);

  it('refuses records a checkpoint could not apply', async () => {
    const { writer } = await simpleWriter();
    await expect(
      writer.commit({
        ...appendInput(writer, 'a'),
        writes: [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [message('m0', 'a different body', 'user')],
          },
        ],
      }),
    ).rejects.toThrow('Conflicting committed message m0');
    await expect(
      writer.commit({
        ...appendInput(writer, 'a'),
        writes: [
          {
            chatId: 'chat',
            kind: 'active-upsert',
            messages: [message('m0', 'rewritten while streaming', 'user')],
          },
        ],
      }),
    ).rejects.toThrow('Active message conflicts with committed history');
    await expect(
      writer.commit({ ...appendInput(writer, 'a'), expectedRevision: 7 }),
    ).rejects.toThrow('V2 revision conflict');
    expect(writer.revision).toBe(0);
  });

  it('keeps directory sync a no-op on Windows with file sync as the boundary', async () => {
    const { store } = await simpleWriter();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const synced = enforceWindowsFileSync();
    const directories = jest.spyOn(
      workCounters,
      'recordChatStorageDirectorySync',
    );
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const writer = await ChatDeltaJournalWriter.open(store);
      await writer.commit(appendInput(writer, 'a'));
      await writer.commit(appendInput(writer, 'b'));
      await writer.checkpoint();
      expect(directories).not.toHaveBeenCalled();
      expect(synced).toContain(join(store.directory, DELTA_JOURNAL_FILE_NAME));
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
    const reopened = await ChatDeltaJournalWriter.open(store);
    expect(
      (await reopened.committedMessages('chat')).map((row) => row.id),
    ).toEqual(['m0', 'a', 'b']);
  });

  describe('downgrade read path', () => {
    async function journaledScope(): Promise<{
      store: ChatStorageV2;
      writer: ChatDeltaJournalWriter;
      expected: Awaited<ReturnType<typeof replayedScopeState>>;
    }> {
      const { store, writer } = await simpleWriter();
      await writer.commit(appendInput(writer, 'a'));
      await writer.checkpoint();
      await writer.commit(appendInput(writer, 'b'));
      return { store, writer, expected: await replayedScopeState(store) };
    }

    /** Count reads of one index file; run `before` ahead of the first. */
    function interceptIndexReads(
      path: string,
      before: () => Promise<void> = (): Promise<void> => Promise.resolve(),
    ): { reads: () => number } {
      const read = fs.readFile;
      let reads = 0;
      jest.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
        if (file === path) {
          reads += 1;
          if (reads === 1) await before();
        }
        return read(file, options);
      });
      return { reads: (): number => reads };
    }

    it('retries a lease-free read that meets a checkpoint between its index reads', async () => {
      const { store, writer, expected } = await journaledScope();
      const loader = new ChatStorageV2(join(root, 'simple'), 'scope');
      // The reader has loaded the live index at revision 1; a checkpoint
      // then publishes revision 2 before it reads the archive index.
      const archive = interceptIndexReads(
        join(store.directory, 'archive-index.json'),
        () => writer.checkpoint(),
      );
      const indexes = await loader.indexes();
      expect(archive.reads()).toBe(2);
      expect(indexes.live.revision).toBe(2);
      expect(indexes.archive.revision).toBe(2);
      expect(JSON.stringify(indexes)).toBe(expected.indexes);
    });

    it('loads a version 3 scope through checkpoint + replay', async () => {
      const { store, expected } = await journaledScope();
      const loader = new ChatStorageV2(join(root, 'simple'), 'scope');
      expect(await loader.authority()).toBe('v2');
      expect(await loader.format()).toBe('v3');
      expect(JSON.stringify(await loader.indexes())).toBe(expected.indexes);
      expect((await loader.indexes()).live.revision).toBe(2);
      // The checkpoint files alone are one record behind.
      const checkpoint: unknown = JSON.parse(
        await readFile(join(store.directory, 'live-index.json'), 'utf8'),
      );
      expect(checkpoint).toMatchObject({ revision: 1 });
    });

    it('rejects a persistent live and archive revision mismatch after bounded retries', async () => {
      const { store } = await journaledScope();
      const path = join(store.directory, 'archive-index.json');
      const archive: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isRecord(archive)) throw new Error('Invalid archive index');
      await writeFile(path, JSON.stringify({ ...archive, revision: 7 }));
      const reads = interceptIndexReads(path);
      const loader = new ChatStorageV2(join(root, 'simple'), 'scope');
      const failure = loader.indexes();
      await expect(failure).rejects.toBeInstanceOf(
        ChatStorageIndexRevisionMismatchError,
      );
      await expect(failure).rejects.toThrow('Invalid v2 chat indexes');
      expect(reads.reads()).toBe(3);
    });

    it('fails a version 2 scope closed on a revision mismatch without retrying', async () => {
      const store = await createV2Scope(join(root, 'plain'), 'scope', [
        { id: 'chat', messages: [message('m0', 'hello', 'user')] },
      ]);
      const path = join(store.directory, 'archive-index.json');
      const archive: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isRecord(archive)) throw new Error('Invalid archive index');
      await writeFile(path, JSON.stringify({ ...archive, revision: 7 }));
      const reads = interceptIndexReads(path);
      await expect(store.indexes()).rejects.toThrow('Invalid v2 chat indexes');
      expect(reads.reads()).toBe(1);
      await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
        'Invalid v2 chat indexes',
      );
    });

    it('fails every version 2 write path closed without changing a byte', async () => {
      const { store } = await journaledScope();
      const before = await treeDigests(join(root, 'simple'));
      await expect(
        new ChatStorageTransactions(store).load(),
      ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
      await expect(new ChatStateV2Backend(store).load()).rejects.toBeInstanceOf(
        ChatStorageNewerFormatError,
      );
      await expect(
        store.migrate(() => Promise.reject(new Error('unreachable'))),
      ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
      await expect(store.committedIndexSummary()).rejects.toBeInstanceOf(
        ChatStorageNewerFormatError,
      );
      expect(await new ChatStorageTransactions(store).journalIsClear()).toBe(
        false,
      );
      const elsewhere = await createV2Scope(join(root, 'other'), 'other', [
        { id: 'x', messages: [message('x0', 'x', 'user')] },
      ]);
      // A capture copies only a checkpointed journal (phase 09); this one
      // still holds a record.
      await expect(
        store.copyTo(new ChatStorageV2(join(root, 'capture'), 'capture')),
      ).rejects.toThrow('checkpointed delta journal');
      await expect(elsewhere.copyTo(store)).rejects.toBeInstanceOf(
        ChatStorageNewerFormatError,
      );
      await expect(
        elsewhere.copyRecoveryEvidenceTo(store, []),
      ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
      expect(await treeDigests(join(root, 'simple'))).toEqual(before);
    });

    it('preserves journal authority when the repository loads an existing journal scope', async () => {
      const { expected } = await journaledScope();
      const scopeRoot = join(root, 'simple');
      const repository = drainAfterTest(
        new ChatStateV2Repository({
          resolvePaths: (): {
            tabs: string;
            archives: string;
            journal: string;
          } => ({
            tabs: join(scopeRoot, 'chats', 'scope.json'),
            archives: join(scopeRoot, 'chat-archives', 'scope.json'),
            journal: join(scopeRoot, 'chat-journals', 'scope.jsonl'),
          }),
        }),
      );
      const scope = { projectId: 'workspace', worktreeId: 'scope' };
      expect(await repository.getRevision(scope)).toBe(2);
      expect(repository.getLifecycle(scope)).toBe('ready');
      const store = new ChatStorageV2(scopeRoot, 'scope');
      expect(await store.format()).toBe('v3');
      await repository.flushScope(scope);
      // Flushing materializes the journal state while preserving its authority.
      expect(JSON.stringify(await store.indexes())).toBe(expected.indexes);
      expect(
        Object.keys(await treeDigests(store.directory)).filter((name) =>
          name.startsWith('delta-'),
        ),
      ).toEqual([DELTA_JOURNAL_FILE_NAME]);
    });

    it('fails closed on a record from a newer journal version', async () => {
      const { store } = await journaledScope();
      const journal = await readDeltaJournal(store.directory, 'scope');
      const path = join(store.directory, DELTA_JOURNAL_FILE_NAME);
      const newer = encodeDeltaJournalFrame({
        ...journal.records[0],
        prev: journal.lastDigest,
        fromRevision: 2,
        toRevision: 3,
        transcripts: [],
      });
      const payload: unknown = JSON.parse(
        newer.frame.subarray(40).toString('utf8'),
      );
      if (!isRecord(payload)) throw new Error('Invalid payload');
      const bumped = Buffer.from(JSON.stringify({ ...payload, v: 2 }), 'utf8');
      const header = Buffer.alloc(40);
      header.write('CDJ1', 0, 'ascii');
      header.writeUInt32LE(bumped.length, 4);
      createHash('sha256').update(bumped).digest().copy(header, 8);
      await appendFile(path, Buffer.concat([header, bumped]));
      await expect(store.indexes()).rejects.toBeInstanceOf(
        ChatStorageNewerFormatError,
      );
      await expect(ChatDeltaJournalWriter.open(store)).rejects.toBeInstanceOf(
        ChatStorageNewerFormatError,
      );
    });
  });
});
