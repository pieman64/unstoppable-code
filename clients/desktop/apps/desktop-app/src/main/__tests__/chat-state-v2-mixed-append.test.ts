import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatCoreMutation,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type { ChatMigrationEntry } from '../lib/chat-storage-v2';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import {
  ChatStateV2Backend,
  type ChatStorageTransactionCheckpoint,
} from '../services/chat-state-v2-backend';
import {
  setChatTranscriptRewriteDiagnosticsForTests,
  type ChatTranscriptFullRewriteDiagnostic,
} from '../services/chat-transcript-rewrite-diagnostics';

const CHAT_ID = 'chat';

function message(
  id: string,
  role: PersistedChatMessage['role'] = 'user',
): PersistedChatMessage {
  return {
    id,
    role,
    timestamp: 1,
    blocks: [{ type: 'text', text: id }],
  };
}

function timerMessage(id: string): PersistedChatMessage {
  return {
    id,
    role: 'system',
    timestamp: 2,
    blocks: [{ type: 'turn_timer', startedAt: 2, completedAt: null }],
  };
}

function turnStartMutations(
  userMessage: PersistedChatMessage,
  timer: PersistedChatMessage,
): ChatCoreMutation[] {
  return [
    {
      type: 'runtime.patched',
      chatId: CHAT_ID,
      runtime: { status: 'starting', queuedMessageIds: [] },
    },
    { type: 'message.upserted', chatId: CHAT_ID, message: userMessage },
    { type: 'message.upserted', chatId: CHAT_ID, message: timer },
  ];
}

async function createStore(
  directory: string,
  committedRows: number,
): Promise<ChatStorageV2> {
  const store = new ChatStorageV2(directory, 'scope');
  await store.migrate(() =>
    Promise.resolve({
      revision: 0,
      index: { activeTabId: CHAT_ID, runtimeByChatId: {} },
      recovery: {
        receipts: [],
        mutationIds: [],
        removedTabIds: [],
        removedArchiveEntryIds: [],
        removedMessageIds: [],
      },
      chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
        await Promise.resolve();
        yield {
          metadata: {
            id: CHAT_ID,
            title: CHAT_ID,
            createdAt: '2026-10-01',
          },
          messages: (async function* (): AsyncGenerator<PersistedChatMessage> {
            await Promise.resolve();
            for (let ordinal = 0; ordinal < committedRows; ordinal += 1)
              yield message(`committed-${ordinal}`);
          })(),
        };
      })(),
    }),
  );
  return store;
}

function locatorPath(store: ChatStorageV2, messageId: string): string {
  const locatorKey = createHash('sha256').update(messageId).digest('hex');
  return join(
    store.directory,
    'transcripts',
    'message-index',
    CHAT_ID,
    `${locatorKey}.json`,
  );
}

function writtenChatStorageBytes(): number {
  return Object.entries(snapshotWorkCounters().chatStorage).reduce(
    (total, [key, bytes]) =>
      key.startsWith('written.') && key.endsWith('.bytes')
        ? total + bytes
        : total,
    0,
  );
}

describe('V2 mixed committed and active appends', () => {
  let root: string;
  let backends: ChatStateV2Backend[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-state-v2-mixed-append-'));
    backends = [];
    setChatTranscriptRewriteDiagnosticsForTests({ sink: () => undefined });
  }, 240_000);

  afterEach(async () => {
    jest.restoreAllMocks();
    setChatTranscriptRewriteDiagnosticsForTests({ sink: () => undefined });
    for (const backend of backends) await backend.disposeArtifactMaintenance();
    await rm(root, { recursive: true, force: true });
  }, 240_000);

  it.each([100, 25_000])(
    'appends a mixed turn start with a complete active suffix and bounded writes for %i committed rows',
    async (committedRows) => {
      const store = await createStore(
        join(root, `rows-${committedRows}`),
        committedRows,
      );
      const backend = new ChatStateV2Backend(store);
      backends.push(backend);
      const transcriptPath = join(
        store.directory,
        'transcripts',
        `${CHAT_ID}.jsonl`,
      );
      const committedPrefix = await readFile(transcriptPath);
      const locatorIds = [
        'committed-0',
        `committed-${Math.floor(committedRows / 2)}`,
        `committed-${committedRows - 1}`,
      ];
      const locatorBytes = new Map<string, Buffer>();
      for (const id of locatorIds)
        locatorBytes.set(id, await readFile(locatorPath(store, id)));
      const userMessage = message('next-user');
      const timer = timerMessage('next-timer');
      const commit = jest.spyOn(backend.storage, 'commit');
      resetWorkCounters();

      await backend.transact(() => turnStartMutations(userMessage, timer), {
        source: 'provider',
        chatIds: [CHAT_ID],
      });

      const writes = commit.mock.calls.at(-1)?.[2];
      const write = writes?.find((candidate) => candidate.chatId === CHAT_ID);
      expect(write).toBeDefined();
      if (!write) throw new Error('Missing chat transcript write');
      expect(write.kind).toBe('append');
      expect(write.activeTailCount).toBe(1);
      expect(write.messages).toEqual([userMessage, timer]);
      expect(
        commit.mock.calls
          .at(-1)?.[2]
          .some((candidate) => candidate.kind === 'replace'),
      ).toBe(false);

      const committedAfter = await readFile(transcriptPath);
      expect(committedAfter.subarray(0, committedPrefix.length)).toEqual(
        committedPrefix,
      );
      expect(committedAfter.subarray(committedPrefix.length)).toEqual(
        Buffer.from(`${JSON.stringify(userMessage)}\n`),
      );
      for (const id of locatorIds)
        expect(await readFile(locatorPath(store, id))).toEqual(
          locatorBytes.get(id),
        );
      expect(await backend.storage.transcripts.activeMessages(CHAT_ID)).toEqual(
        [timer],
      );
      expect(writtenChatStorageBytes()).toBeLessThan(8_192);
      expect(
        snapshotWorkCounters().chatStorage['written.transcript.bytes'],
      ).toBe(Buffer.byteLength(`${JSON.stringify(userMessage)}\n`));
    },
    240_000,
  );

  it('recovers the complete append as old-or-whole at every V2 storage checkpoint', async () => {
    const checkpoints: ChatStorageTransactionCheckpoint[] = [
      'prepared',
      'journal',
      'transcripts',
      'indexes',
    ];
    for (const checkpoint of checkpoints) {
      const store = await createStore(join(root, checkpoint), 3);
      const interrupted = new ChatStateV2Backend(store, {
        testHooks: {
          storageCheckpoint: (point): Promise<void> =>
            point === checkpoint
              ? Promise.reject(new Error(`crash at ${point}`))
              : Promise.resolve(),
        },
      });
      backends.push(interrupted);
      const userMessage = message('next-user');
      const timer = timerMessage('next-timer');
      await expect(
        interrupted.transact(() => turnStartMutations(userMessage, timer), {
          source: 'provider',
          chatIds: [CHAT_ID],
        }),
      ).rejects.toThrow(`crash at ${checkpoint}`);
      const reopened = new ChatStateV2Backend(store);
      backends.push(reopened);
      await reopened.storage.load();
      const committed: string[] = [];
      for await (const row of reopened.storage.transcripts.iterate(CHAT_ID))
        committed.push(row.id);
      const active = await reopened.storage.transcripts.activeMessages(CHAT_ID);
      const oldState =
        JSON.stringify(committed) ===
          JSON.stringify(['committed-0', 'committed-1', 'committed-2']) &&
        active.length === 0;
      const wholeState =
        JSON.stringify(committed) ===
          JSON.stringify([
            'committed-0',
            'committed-1',
            'committed-2',
            userMessage.id,
          ]) &&
        JSON.stringify(active.map((row) => row.id)) ===
          JSON.stringify([timer.id]);
      if (!oldState && !wholeState)
        throw new Error(
          `Unexpected ${checkpoint} recovery: committed=${JSON.stringify(committed)}, active=${JSON.stringify(active.map((row) => row.id))}`,
        );
      if (checkpoint === 'prepared') expect(oldState).toBe(true);
      else expect(wholeState).toBe(true);
    }
  });

  it('retains existing journal checkpoint behavior without demoting a mixed turn start', async () => {
    const store = await createStore(join(root, 'journal'), 3);
    const backend = new ChatStateV2Backend(store, { deltaJournal: {} });
    backends.push(backend);
    expect(await backend.promoteToDeltaJournal()).toBe(true);
    resetWorkCounters();
    const userMessage = message('next-user');
    const timer = timerMessage('next-timer');

    await backend.transact(() => turnStartMutations(userMessage, timer), {
      source: 'provider',
      chatIds: [CHAT_ID],
    });

    expect(await store.format()).toBe('v3');
    expect(backend.isDeltaJournal()).toBe(true);
    // The pre-existing journal patch form checkpoints this mixed append once;
    // the complete-active-set V2 append form must not add another checkpoint.
    expect(
      snapshotWorkCounters().chatStorage['deltaJournal.checkpoints'] ?? 0,
    ).toBe(1);
    expect(
      (await stat(join(store.directory, 'delta-journal.log'))).size,
    ).toBeGreaterThan(0);
  });

  it('reports prompt relocation instead of patch/removal reasons for a replace', async () => {
    const store = await createStore(join(root, 'relocation'), 3);
    const backend = new ChatStateV2Backend(store);
    backends.push(backend);
    const records: ChatTranscriptFullRewriteDiagnostic[] = [];
    setChatTranscriptRewriteDiagnosticsForTests({
      sink: (record) => records.push(record),
      now: () => 1_790_000_000_000,
    });
    const patched = {
      ...message('committed-1'),
      blocks: [{ type: 'text', text: 'relocated prompt' }],
    } satisfies PersistedChatMessage;
    const inserted = message('relocated-prompt');
    const commit = jest.spyOn(backend.storage, 'commit');

    await backend.transact(
      () => [
        { type: 'message.upserted', chatId: CHAT_ID, message: patched },
        {
          type: 'message.upserted',
          chatId: CHAT_ID,
          message: inserted,
          afterMessageId: 'committed-0',
        },
      ],
      {
        source: 'provider',
        chatIds: [CHAT_ID],
        rewriteReason: 'prompt_relocation',
      },
    );

    const write = commit.mock.calls
      .at(-1)?.[2]
      .find((candidate) => candidate.chatId === CHAT_ID);
    expect(write?.kind).toBe('replace');
    const committed: string[] = [];
    for await (const row of backend.storage.transcripts.iterate(CHAT_ID))
      committed.push(row.id);
    expect(committed).toEqual([
      'committed-0',
      inserted.id,
      patched.id,
      'committed-2',
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]?.reason).toBe('prompt_relocation');
  });
});
