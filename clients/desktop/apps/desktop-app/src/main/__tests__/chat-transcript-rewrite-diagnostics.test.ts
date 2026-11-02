/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatCoreMutation,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type { ChatMigrationEntry } from '../lib/chat-storage-v2';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import {
  CHAT_TRANSCRIPT_REWRITE_DIAGNOSTIC_INTERVAL_MS,
  installChatTranscriptRewriteDiagnosticSink,
  setChatTranscriptRewriteDiagnosticsForTests,
  type ChatTranscriptFullRewriteDiagnostic,
} from '../services/chat-transcript-rewrite-diagnostics';

const SECRET = 'private prompt text';
const prompt: PersistedChatMessage = {
  id: 'user-secret-id',
  role: 'user',
  timestamp: 1,
  blocks: [{ type: 'text', text: SECRET }],
};
const timer: PersistedChatMessage = {
  id: 'timer-secret-id',
  role: 'system',
  timestamp: 1,
  blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 5 }],
};
const answer: PersistedChatMessage = {
  id: 'answer-secret-id',
  role: 'assistant',
  timestamp: 2,
  blocks: [{ type: 'text', text: SECRET }],
};

describe('full committed transcript rewrite diagnostics', () => {
  let root: string;
  let backend: ChatStateV2Backend;
  let store: ChatStorageV2;
  let records: ChatTranscriptFullRewriteDiagnostic[];
  let clock: number;

  beforeEach(async () => {
    records = [];
    clock = 1_790_000_000_000;
    setChatTranscriptRewriteDiagnosticsForTests({
      sink: (record) => records.push(record),
      now: () => clock,
    });
    root = await mkdtemp(join(tmpdir(), 'chat-rewrite-diagnostics-'));
    store = new ChatStorageV2(root, 'scope');
    await store.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: 'chat', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
          yield await Promise.resolve({
            metadata: { id: 'chat', title: 'chat', createdAt: '2026-09-30' },
            messages:
              (async function* (): AsyncGenerator<PersistedChatMessage> {
                for (const row of [prompt, timer, answer])
                  yield await Promise.resolve(row);
              })(),
          });
        })(),
      }),
    );
    backend = new ChatStateV2Backend(store);
  });

  afterEach(async () => {
    setChatTranscriptRewriteDiagnosticsForTests();
    await backend.disposeArtifactMaintenance();
    await rm(root, { recursive: true, force: true });
  });

  const commit = (
    mutations: ChatCoreMutation[],
    fullTranscript = false,
  ): Promise<unknown> =>
    backend.transact(() => mutations, {
      source: 'provider',
      chatIds: ['chat'],
      ...(fullTranscript ? { fullTranscript: true } : {}),
    });

  const reopen = (completedAt: number | null): ChatCoreMutation => ({
    type: 'message.upserted',
    chatId: 'chat',
    message: {
      ...timer,
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt }],
    },
  });

  it('measures full, suffix and identical replacements with Unicode and a deterministic clock', async () => {
    let ticks = 0;
    const measured: Array<{
      chatId: string;
      bytesWritten: number;
      durationMs: number;
    }> = [];
    const log = new ChatTranscriptLog(join(root, 'measured'), undefined, {
      now: (): number => ticks++ * 7,
    });
    const unsubscribe = log.observeReplacements((measurement): void => {
      measured.push(measurement);
    });
    const unicode = {
      ...answer,
      blocks: [{ type: 'text', text: '🌲 café' }],
    } satisfies PersistedChatMessage;
    const rows = [prompt, timer, unicode];
    const bytes = (values: PersistedChatMessage[]): number =>
      Buffer.byteLength(
        values.map((row) => JSON.stringify(row) + '\n').join(''),
      );
    await log.replace('one', rows, 1);
    const changed = { ...unicode, timestamp: 99 };
    await log.replace('one', [prompt, timer, changed], 2);
    await log.replace('one', [prompt, timer, changed], 3);
    await log.replace('two', [unicode], 1);
    expect(measured).toEqual([
      { chatId: 'one', bytesWritten: bytes(rows), durationMs: 7 },
      { chatId: 'one', bytesWritten: bytes([changed]), durationMs: 7 },
      { chatId: 'one', bytesWritten: 0, durationMs: 7 },
      { chatId: 'two', bytesWritten: bytes([unicode]), durationMs: 7 },
    ]);
    unsubscribe();
    await log.replace('two', [unicode], 2);
    expect(measured).toHaveLength(4);
  });

  it('attaches actual suffix bytes after durability, not the previous committed size', async () => {
    const changed = {
      ...answer,
      blocks: [{ type: 'text', text: '🌲 café' }],
    } satisfies PersistedChatMessage;
    await commit([
      { type: 'message.upserted', chatId: 'chat', message: changed },
    ]);
    expect(records[0]?.chatTranscriptRewriteBytesWritten).toBe(
      Buffer.byteLength(JSON.stringify(changed) + '\n'),
    );
    expect(records[0]?.chatTranscriptRewriteDurationMs).toBeGreaterThanOrEqual(
      0,
    );
  });

  it('correlates different chats within one durable transaction', async () => {
    await backend.transact(
      (current) => [
        {
          type: 'tab.created',
          tab: {
            ...current.tabsFile.tabs[0],
            id: 'other',
            messages: [prompt, timer, answer],
          },
        },
      ],
      { source: 'provider', chatIds: ['chat'], fullTranscript: true },
    );
    const first = {
      ...prompt,
      blocks: [{ type: 'text', text: 'new first 🌲' }],
    } satisfies PersistedChatMessage;
    const last = {
      ...answer,
      blocks: [{ type: 'text', text: 'new last café' }],
    } satisfies PersistedChatMessage;
    await backend.transact(
      () => [
        { type: 'message.upserted', chatId: 'chat', message: first },
        { type: 'message.upserted', chatId: 'other', message: last },
      ],
      { source: 'provider', chatIds: ['chat', 'other'] },
    );
    expect(records).toHaveLength(2);
    expect(
      new Set(records.map((record) => record.chatTranscriptRewriteChatKey))
        .size,
    ).toBe(2);
    expect(
      records.map((record) => record.chatTranscriptRewriteBytesWritten).sort(),
    ).toEqual(
      [
        Buffer.byteLength(
          [first, timer, answer]
            .map((row) => JSON.stringify(row) + '\n')
            .join(''),
        ),
        Buffer.byteLength(JSON.stringify(last) + '\n'),
      ].sort(),
    );
  });

  it('attaches replacement measurements from the journal checkpoint path', async () => {
    await backend.disposeArtifactMaintenance();
    backend = new ChatStateV2Backend(store, { deltaJournal: {} });
    expect(await backend.promoteToDeltaJournal()).toBe(true);
    const changed = {
      ...answer,
      blocks: [{ type: 'text', text: 'checkpoint 🌲' }],
    } satisfies PersistedChatMessage;
    await commit([
      { type: 'message.upserted', chatId: 'chat', message: changed },
    ]);
    expect(records[0]?.chatTranscriptRewriteBytesWritten).toBe(
      Buffer.byteLength(JSON.stringify(changed) + '\n'),
    );
    expect(records[0]?.chatTranscriptRewriteDurationMs).toBeGreaterThanOrEqual(
      0,
    );
  });

  it('emits no success record when publication fails', async () => {
    await expect(
      backend.transact(() => [reopen(null)], {
        source: 'provider',
        chatIds: ['chat'],
        beforePublish: () => {
          throw new Error('publication failed');
        },
      }),
    ).rejects.toThrow('publication failed');
    expect(records).toEqual([]);
  });

  it('reports a relocated committed prompt with its own rewrite reason', async () => {
    await backend.transact(
      () => [
        {
          type: 'messages.replaced',
          chatId: 'chat',
          messages: [timer, answer, prompt],
          removedMessageIds: [],
        },
      ],
      {
        source: 'provider',
        chatIds: ['chat'],
        fullTranscript: true,
        rewriteReason: 'prompt_relocation',
      },
    );
    expect(records).toEqual([
      expect.objectContaining({
        kind: 'chat_transcript_full_rewrite',
        reason: 'prompt_relocation',
      }),
    ]);
  });

  it('records a content-free patch rewrite with the patched block types', async () => {
    await commit([reopen(null)]);
    expect(records).toEqual([
      {
        version: 1,
        timestamp: new Date(clock).toISOString(),
        kind: 'chat_transcript_full_rewrite',
        reason: 'patch',
        chatTranscriptRewriteChatKey: expect.stringMatching(/^[0-9a-f]{16}$/),
        chatTranscriptRewriteCommittedRows: 3,
        chatTranscriptRewriteCommittedBytes: expect.any(Number),
        chatTranscriptRewriteBytesWritten: expect.any(Number),
        chatTranscriptRewriteDurationMs: expect.any(Number),
        chatTranscriptRewritePatchedRows: 1,
        chatTranscriptRewriteRemovedRows: 0,
        chatTranscriptRewritePatchedBlockTypes: ['turn_timer'],
        chatTranscriptRewriteActiveTail: false,
        chatTranscriptRewriteSuppressedCount: 0,
      },
    ]);
    expect(records[0].chatTranscriptRewriteCommittedBytes).toBeGreaterThan(0);
    const serialized = JSON.stringify(records);
    for (const forbidden of [SECRET, 'secret-id', '"chat"', root, 'scope'])
      expect(serialized).not.toContain(forbidden);
  });

  it('rate-limits one chat and reports the suppressed rewrites', async () => {
    await commit([reopen(null)]);
    await commit([reopen(7)]);
    await commit([reopen(null)]);
    expect(records).toHaveLength(1);
    clock += CHAT_TRANSCRIPT_REWRITE_DIAGNOSTIC_INTERVAL_MS;
    await commit([reopen(9)]);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      reason: 'patch',
      chatTranscriptRewriteChatKey: records[0].chatTranscriptRewriteChatKey,
      chatTranscriptRewriteSuppressedCount: 2,
    });
  });

  it('forwards each rate-limited record to an installed app-diagnostic sink', async () => {
    const forwarded: ChatTranscriptFullRewriteDiagnostic[] = [];
    installChatTranscriptRewriteDiagnosticSink((record) =>
      forwarded.push(record),
    );
    await commit([reopen(null)]);
    await commit([reopen(7)]);
    expect(forwarded).toEqual(records);
    expect(forwarded).toHaveLength(1);
  });

  it('records committed removals', async () => {
    await commit([
      { type: 'message.removed', chatId: 'chat', messageId: answer.id },
    ]);
    expect(records).toEqual([
      expect.objectContaining({
        reason: 'removal',
        chatTranscriptRewritePatchedRows: 0,
        chatTranscriptRewriteRemovedRows: 1,
        chatTranscriptRewritePatchedBlockTypes: [],
      }),
    ]);
  });

  it('appends a mixed runtime, user, and timer turn start without a full rewrite', async () => {
    const transcriptPath = join(store.directory, 'transcripts', 'chat.jsonl');
    const committedPrefix = await readFile(transcriptPath);
    await commit([
      {
        type: 'runtime.patched',
        chatId: 'chat',
        runtime: { status: 'starting', queuedMessageIds: [] },
      },
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: { ...prompt, id: 'next-user' },
      },
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: {
          ...timer,
          id: 'next-timer',
          blocks: [{ type: 'turn_timer', startedAt: 9, completedAt: null }],
        },
      },
    ]);
    const committedAfter = await readFile(transcriptPath);
    expect(committedAfter.subarray(0, committedPrefix.length)).toEqual(
      committedPrefix,
    );
    expect(committedAfter.subarray(committedPrefix.length)).toEqual(
      Buffer.from(JSON.stringify({ ...prompt, id: 'next-user' }) + '\n'),
    );
    expect(
      await new ChatTranscriptLog(
        join(store.directory, 'transcripts'),
      ).activeMessages('chat'),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'next-timer' })]),
    );
    expect(records).toEqual([]);
  });

  it('does not report appends, identical upserts, or intentional replacements', async () => {
    await commit([
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: { ...answer, id: 'appended' },
      },
    ]);
    await commit([
      { type: 'message.upserted', chatId: 'chat', message: timer },
    ]);
    await commit(
      [
        {
          type: 'messages.replaced',
          chatId: 'chat',
          messages: [prompt],
          removedMessageIds: [],
        },
      ],
      true,
    );
    expect(records).toEqual([]);
  });

  it('reports committed replacements after durability but not appended tails', async () => {
    const committedRows = [
      prompt,
      timer,
      answer,
      ...Array.from(
        { length: 52 },
        (_, index) =>
          ({
            ...answer,
            id: `large-${index}`,
            blocks: [{ type: 'text', text: 'x'.repeat(410_000) }],
          }) satisfies PersistedChatMessage,
      ),
    ];
    await backend.transact(
      () => [
        {
          type: 'messages.replaced',
          chatId: 'chat',
          messages: committedRows,
          removedMessageIds: [],
        },
      ],
      { source: 'import', chatIds: ['chat'], fullTranscript: true },
    );
    const before = await backend.storage.transcripts.descriptor('chat');
    expect(before.committedMessageCount).toBe(55);
    expect(before.committedByteLength).toBeGreaterThan(20 * 1024 * 1024);
    const appendedTail: PersistedChatMessage = {
      id: 'active-tail',
      role: 'assistant',
      timestamp: 3,
      blocks: [{ type: 'text', text: 'active tail' }],
    };
    await backend.transact(
      () => [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'messages.replaced',
          chatId: 'chat',
          messages: [...committedRows, appendedTail],
          removedMessageIds: [],
        },
      ],
      {
        source: 'provider',
        chatIds: ['chat'],
        fullTranscript: true,
      },
    );
    expect(records).toEqual([]);

    const reordered = [timer, prompt, ...committedRows.slice(2)];
    const committedBytes = Buffer.byteLength(
      reordered.map((row) => `${JSON.stringify(row)}\n`).join(''),
    );
    let replacementWasNotReportedAtPublish = false;
    await backend.transact(
      () => [
        {
          type: 'messages.replaced',
          chatId: 'chat',
          messages: [...reordered, appendedTail],
          removedMessageIds: [],
        },
      ],
      {
        source: 'provider',
        chatIds: ['chat'],
        fullTranscript: true,
        beforePublish: () => {
          replacementWasNotReportedAtPublish = records.length === 0;
        },
      },
    );

    expect(replacementWasNotReportedAtPublish).toBe(true);
    expect(records).toHaveLength(1);
    const after = await backend.storage.transcripts.descriptor('chat');
    expect(after.committedMessageCount).toBe(55);
    expect(after.committedByteLength).toBe(before.committedByteLength);
    expect(
      (await backend.storage.transcripts.activeMessages('chat')).map(
        (row) => row.id,
      ),
    ).toEqual([appendedTail.id]);
    expect(records[0]).toMatchObject({
      kind: 'chat_transcript_full_rewrite',
      reason: 'replacement',
      chatTranscriptRewriteCommittedRows: 55,
      chatTranscriptRewriteCommittedBytes: before.committedByteLength,
      chatTranscriptRewriteBytesWritten: committedBytes,
      chatTranscriptRewriteDurationMs: expect.any(Number),
      chatTranscriptRewritePatchedRows: 0,
      chatTranscriptRewriteRemovedRows: 0,
      chatTranscriptRewritePatchedBlockTypes: [],
      chatTranscriptRewriteActiveTail: true,
    });
    for (const privateValue of [SECRET, 'user-secret-id', 'active-tail'])
      expect(JSON.stringify(records)).not.toContain(privateValue);
  }, 30_000);

  it('does not report import, migration, or reset replacements', async () => {
    const reordered = [timer, prompt, answer];
    const replace = (
      messages: PersistedChatMessage[],
      removedMessageIds: string[],
    ): ChatCoreMutation[] => [
      {
        type: 'messages.replaced',
        chatId: 'chat',
        messages,
        removedMessageIds,
      },
    ];
    await backend.transact(() => replace(reordered, []), {
      source: 'import',
      chatIds: ['chat'],
      fullTranscript: true,
    });
    await backend.transact(() => replace([prompt, timer, answer], []), {
      source: 'migration',
      chatIds: ['chat'],
      fullTranscript: true,
    });
    await backend.transact(() => replace([prompt], [timer.id, answer.id]), {
      source: 'provider',
      chatIds: ['chat'],
      fullTranscript: true,
    });
    expect(records).toEqual([]);
  });
});
