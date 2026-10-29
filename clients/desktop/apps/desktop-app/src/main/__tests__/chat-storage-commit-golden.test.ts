/**
 * Byte-identity golden for the canonical chat-storage write path.
 *
 * A fixed command sequence runs against the real V2 backend on a temporary
 * directory. The test records every JSON file the cooperative writer produced
 * (journal records, pending payloads, index files, sidecars) in write order,
 * every file and directory sync in order, a digest of the scope tree after
 * each step, and the complete final tree. The fixture was recorded from the
 * pre-phase-07 write path, refreshed for CAN-390 conversational-role metadata.
 * Any change to the bytes a commit writes, the
 * order it writes them in, or the syncs it issues fails here.
 *
 * Only non-deterministic identifiers are normalized: random UUIDs (temporary
 * suffixes, transaction and migration ids) become `<uuid>`. `Date` is frozen.
 *
 * Re-record deliberately, and only for an intended format change:
 * `RECORD_CHAT_STORAGE_GOLDEN=1 npm test -- chat-storage-commit-golden`.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type {
  ChatCoreMutation,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import * as workCounters from '@canopy/desktop-shared/node/work-counters';
import {
  ChatStorageV2,
  type ChatMigrationEntry,
  type ChatMigrationSource,
} from '../lib/chat-storage-v2';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import * as cooperativeJson from '../lib/cooperative-json';
import * as directorySync from '../lib/fsync-directory';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { isRecord } from '../lib/type-guards';

const FIXTURE = join(__dirname, 'fixtures', 'chat-storage-commit-golden.json');
const RECORD = process.env.RECORD_CHAT_STORAGE_GOLDEN === '1';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Files up to this size are kept verbatim; larger ones by digest. */
const VERBATIM_BYTES = 4096;

interface GoldenFile {
  bytes: number;
  sha256: string;
  text?: string;
}

interface Golden {
  writes: Array<{ path: string } & GoldenFile>;
  syncs: string[];
  steps: Array<{ label: string; tree: string }>;
  tree: Record<string, GoldenFile>;
}

function isGolden(value: unknown): value is Golden {
  return (
    isRecord(value) &&
    Array.isArray(value.writes) &&
    Array.isArray(value.syncs) &&
    Array.isArray(value.steps) &&
    isRecord(value.tree)
  );
}

const message = (
  id: string,
  text: string,
  role: PersistedChatMessage['role'] = 'assistant',
  timestamp = 1,
): PersistedChatMessage => ({
  id,
  role,
  timestamp,
  blocks: [{ type: 'text', text }],
});

/** Escapes, separators, astral and lone surrogates, and control characters. */
const TRICKY_TEXT =
  'quote " backslash \\ tab \t newline \n nul \u0000 bell \u0007 ' +
  'line-sep \u2028 para-sep \u2029 emoji 🌲👩‍💻 cjk 漢字 accent é ' +
  'lone-high \ud800 lone-low \udc00 slash / del \u007f';

function scopeSource(
  chats: Array<{ id: string; messages: PersistedChatMessage[] }>,
): () => Promise<ChatMigrationSource> {
  return () =>
    Promise.resolve({
      revision: 0,
      index: { activeTabId: chats[0].id, runtimeByChatId: {} },
      recovery: {
        receipts: [],
        mutationIds: [],
        removedTabIds: [],
        removedArchiveEntryIds: [],
        removedMessageIds: [],
      },
      chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
        for (const chat of chats)
          yield await Promise.resolve({
            metadata: { id: chat.id, title: chat.id, createdAt: '2026-09-05' },
            messages:
              (async function* (): AsyncGenerator<PersistedChatMessage> {
                for (const row of chat.messages)
                  yield await Promise.resolve(row);
              })(),
          });
      })(),
    });
}

function normalize(text: string): string {
  return text.replace(UUID, '<uuid>');
}

function describeBytes(bytes: Buffer): GoldenFile {
  const text = normalize(bytes.toString('utf8'));
  return {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(text).digest('hex'),
    ...(bytes.byteLength <= VERBATIM_BYTES ? { text } : {}),
  };
}

async function* files(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

describe('chat storage commit golden', () => {
  let root: string;
  let sourceRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-storage-golden-'));
    sourceRoot = await mkdtemp(join(tmpdir(), 'chat-storage-golden-source-'));
    jest.useFakeTimers({
      now: new Date('2026-09-30T12:00:00.000Z'),
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
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it('writes byte-identical files, in the same order, with the same syncs', async () => {
    const store = new ChatStorageV2(root, 'scope');
    const display = (path: string): string => {
      const base = path.startsWith(root) ? relative(root, path) : path;
      return normalize(base.split(sep).join('/'));
    };

    // Payload files are removed once their commit applies, so record every
    // cooperative write as it lands.
    const writes: Golden['writes'] = [];
    const write = cooperativeJson.writeJsonValuesCooperatively;
    jest
      .spyOn(cooperativeJson, 'writeJsonValuesCooperatively')
      .mockImplementation(async (path, values, options) => {
        const bytes = await write(path, values, options);
        if (path.startsWith(root))
          writes.push({
            path: display(path),
            ...describeBytes(await readFile(path)),
          });
        return bytes;
      });
    const syncs: string[] = [];
    const recordFileSync = workCounters.recordChatStorageFileSync;
    jest
      .spyOn(workCounters, 'recordChatStorageFileSync')
      .mockImplementation((path) => {
        if (path.startsWith(root)) syncs.push(`file ${display(path)}`);
        recordFileSync(path);
      });
    const syncDirectory = directorySync.fsyncDirectory;
    jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        if (directory.startsWith(root))
          syncs.push(`directory ${display(directory)}`);
        await syncDirectory(directory);
      });

    const tree = async (): Promise<Record<string, GoldenFile>> => {
      const result: Record<string, GoldenFile> = {};
      for await (const path of files(store.directory))
        result[display(path)] = describeBytes(await readFile(path));
      result[display(store.manifestPath)] = describeBytes(
        await readFile(store.manifestPath),
      );
      return result;
    };
    const steps: Golden['steps'] = [];
    const step = async (label: string): Promise<void> => {
      steps.push({
        label,
        tree: createHash('sha256')
          .update(JSON.stringify(await tree()))
          .digest('hex'),
      });
    };

    await store.migrate(
      scopeSource([
        {
          id: 'chat',
          messages: [
            message('m0', 'hello', 'user'),
            message('m1', TRICKY_TEXT),
            message('m2', 'large timestamp', 'assistant', 1e21),
          ],
        },
        { id: 'sibling', messages: [message('s0', 'sibling', 'user')] },
      ]),
    );
    await step('migrated');

    const backend = new ChatStateV2Backend(store);
    await backend.load();
    let mutationOrdinal = 0;
    const transact = async (
      label: string,
      build: (
        current: Awaited<ReturnType<ChatStateV2Backend['state']>>,
      ) => ChatCoreMutation[],
      options: {
        chatIds?: string[];
        fullTranscript?: boolean;
        receipt?: boolean;
      } = {},
    ): Promise<void> => {
      mutationOrdinal += 1;
      await backend.transact((current) => build(current), {
        source: 'automation',
        mutationId: `mutation-${mutationOrdinal}`,
        ...(options.chatIds ? { chatIds: options.chatIds } : {}),
        ...(options.fullTranscript ? { fullTranscript: true } : {}),
        ...(options.receipt
          ? {
              commandResult: {
                commandId: `command-${mutationOrdinal}`,
                revision: 0,
                outcome: 'applied' as const,
                entityId: 'sibling',
              },
            }
          : {}),
      });
      await step(label);
    };

    await transact('prompt appended while streaming', () => [
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
    await transact('active reply', () => [
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: message('a1', TRICKY_TEXT, 'assistant', -0),
      },
    ]);
    await transact('active reply grows past the native threshold', () => [
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: message(
          'a1',
          `${TRICKY_TEXT}\n${'long streamed reply 🌲 '.repeat(4096)}`,
        ),
      },
    ]);
    await transact('externalized tool output', () => [
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: {
          id: 't1',
          role: 'assistant',
          timestamp: 2,
          blocks: [
            {
              type: 'tool_result',
              toolUseId: 't1-tool',
              toolName: 'shell',
              output: 'tool output 🌲\n'.repeat(6000),
              isError: false,
            },
          ],
        },
      },
    ]);
    await transact('turn finalized', () => [
      {
        type: 'runtime.patched',
        chatId: 'chat',
        runtime: { status: 'idle', queuedMessageIds: [] },
      },
    ]);
    await transact(
      'metadata-only commit with a receipt',
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
      'new chat with a transcript',
      () => [
        {
          type: 'tab.created',
          tab: {
            id: 'fresh',
            title: 'Fresh',
            createdAt: '2026-09-30',
            messages: [
              message('f0', 'first', 'user'),
              message('f1', 'nested empties', 'assistant'),
            ],
          },
        },
      ],
      { chatIds: ['fresh'] },
    );
    await transact('committed message removed', () => [
      { type: 'message.removed', chatId: 'chat', messageId: 'm2' },
    ]);
    await transact(
      'chat archived',
      (current) => {
        const sibling = current.tabsFile.tabs.find(
          (tab) => tab.id === 'sibling',
        );
        if (!sibling) throw new Error('Missing sibling');
        return [
          { type: 'tab.removed', tabId: 'sibling' },
          {
            type: 'archive.upserted',
            entry: { tab: sibling, archivedAt: '2026-09-30', turnCount: 1 },
          },
        ];
      },
      { chatIds: ['sibling'] },
    );
    await transact('chat deleted', () => [
      { type: 'tab.removed', tabId: 'fresh' },
    ]);

    const source = new ChatStorageV2(sourceRoot, 'import-source');
    await source.migrate(
      scopeSource([
        {
          id: 'imported',
          messages: [
            message('i0', 'imported prompt', 'user'),
            message('i1', TRICKY_TEXT),
          ],
        },
      ]),
    );
    const metadata = await new ChatStateV2Backend(source).state();
    await backend.importScope(
      source,
      { tabsFile: metadata.tabsFile, archivesFile: metadata.archivesFile },
      { merge: true, mutationId: 'import-1' },
    );
    await step('merged import');

    // A commit interrupted after its journal record published, then recovered
    // by a new owner.
    const interrupted = new ChatStorageTransactions(store, (point) =>
      point === 'journal'
        ? Promise.reject(new Error('interrupt'))
        : Promise.resolve(),
    );
    const next = await interrupted.load();
    next.live.tabs[0].title = 'Recovered title';
    next.live.revision = next.archive.revision = next.live.revision + 1;
    await expect(
      interrupted.commit(next.live.revision - 1, next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [message('r1', 'recovered row', 'user')],
        },
      ]),
    ).rejects.toThrow('interrupt');
    await step('journal published, apply interrupted');
    await new ChatStateV2Backend(new ChatStorageV2(root, 'scope')).load();
    await step('recovered');

    const actual: Golden = { writes, syncs, steps, tree: await tree() };
    if (RECORD) {
      await writeFile(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    const expected: unknown = JSON.parse(await readFile(FIXTURE, 'utf8'));
    if (!isGolden(expected)) throw new Error('Invalid golden fixture');
    // Compare the parts separately so a failure names what diverged.
    expect(actual.syncs).toEqual(expected.syncs);
    expect(actual.writes).toEqual(expected.writes);
    expect(actual.tree).toEqual(expected.tree);
    expect(actual.steps).toEqual(expected.steps);
  }, 60_000);
});
