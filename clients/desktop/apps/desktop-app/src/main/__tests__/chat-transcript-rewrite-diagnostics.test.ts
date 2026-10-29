/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatCoreMutation,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type { ChatMigrationEntry } from '../lib/chat-storage-v2';
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
    const store = new ChatStorageV2(root, 'scope');
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

  it('records a turn start that mixes committed and active rows', async () => {
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
    expect(records).toEqual([
      expect.objectContaining({
        reason: 'mixed_active',
        chatTranscriptRewriteActiveTail: true,
        chatTranscriptRewritePatchedRows: 0,
      }),
    ]);
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
});
