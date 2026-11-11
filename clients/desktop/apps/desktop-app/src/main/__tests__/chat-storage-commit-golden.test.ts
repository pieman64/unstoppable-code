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
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type {
  ChatCoreMutation,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import * as workCounters from '@canopy/desktop-shared/node/work-counters';
import { serializeVisibleReadMessage } from '@canopy/desktop-shared/lib/chat-history-serialization';
import {
  ChatStorageV2,
  type ChatMigrationEntry,
  type ChatMigrationSource,
} from '../lib/chat-storage-v2';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import * as cooperativeJson from '../lib/cooperative-json';
import * as directorySync from '../lib/fsync-directory';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { isErrnoException, isRecord } from '../lib/type-guards';

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

  it('restores exact file identities and visible references from a committed transcript', async () => {
    // Probe the real temporary volume, not the OS default: insensitive volumes
    // cannot represent both targets. Keep all other names covered there.
    await writeFile(join(sourceRoot, 'A.ts'), 'upper-case target\n', {
      flag: 'wx',
    });
    let caseSensitive = true;
    try {
      await writeFile(join(sourceRoot, 'a.ts'), 'lower-case target\n', {
        flag: 'wx',
      });
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error;
      expect(await readFile(join(sourceRoot, 'a.ts'), 'utf8')).toBe(
        'upper-case target\n',
      );
      caseSensitive = false;
    }
    const fixtures = [
      { path: 'A.ts', label: 'A.ts', bytes: 'upper-case target\n' },
      ...(caseSensitive
        ? [{ path: 'a.ts', label: 'a.ts', bytes: 'lower-case target\n' }]
        : []),
      { path: '資料/雪🌲.ts', label: '雪🌲.ts', bytes: 'Unicode target\n' },
      {
        path: "folder with spaces/it's here.ts",
        label: "it's here.ts",
        bytes: 'spaces and apostrophe target\n',
      },
      { path: 'literal/name.ts', label: 'name.ts', bytes: 'nested target\n' },
      // Win32 treats backslash as a separator and colon as a stream delimiter;
      // neither can represent these literal POSIX filenames.
      ...(process.platform === 'win32'
        ? []
        : [
            {
              path: 'literal\\name.ts',
              label: 'literal\\name.ts',
              bytes: 'literal backslash target\n',
            },
            {
              path: 'colon:name.ts',
              label: 'colon:name.ts',
              bytes: 'literal colon target\n',
            },
          ]),
    ];
    for (const fixture of fixtures) {
      const path = join(sourceRoot, fixture.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, fixture.bytes);
    }
    const references = fixtures.map((fixture) => ({
      displayPath: fixture.path,
      absolutePath: join(sourceRoot, fixture.path),
    }));
    const prompt: PersistedChatMessage = {
      ...message('file-prompt', 'Inspect these files.', 'user'),
      blocks: [
        { type: 'text', text: 'Inspect these files.' },
        { type: 'file_references', references },
      ],
    };
    const store = new ChatStorageV2(root, 'scope');
    await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
    const backend = new ChatStateV2Backend(store);
    await backend.load();
    await backend.transact(
      () => [{ type: 'message.upserted', chatId: 'chat', message: prompt }],
      {
        source: 'renderer-command',
        mutationId: 'file-prompt',
        chatIds: ['chat'],
      },
    );

    // Neither the backend nor the transcript reader may retain the writer's
    // in-memory message: a new storage owner must recover the committed row.
    const restored = new ChatStateV2Backend(new ChatStorageV2(root, 'scope'));
    await restored.load();
    const page = await restored.page('chat');
    expect(page.totalMessages).toBe(1);
    expect(page.messages).toEqual([prompt]);
    const row = page.messages[0];
    if (!row) throw new Error('Missing restored file-reference prompt');
    const block = row.blocks.find((entry) => entry.type === 'file_references');
    if (!block || block.type !== 'file_references')
      throw new Error('Missing restored file references');
    expect(block.references).toEqual(references);
    expect(
      new Set(block.references.map((entry) => entry.absolutePath)).size,
    ).toBe(fixtures.length);
    for (const [index, reference] of block.references.entries()) {
      expect(await readFile(reference.absolutePath)).toEqual(
        Buffer.from(fixtures[index].bytes),
      );
    }
    expect(serializeVisibleReadMessage(row)).toEqual({
      messageId: 'file-prompt',
      role: 'user',
      timestamp: '1970-01-01T00:00:00.001Z',
      text: `Inspect these files.\n\n${fixtures.map((fixture) => `[file] ${fixture.label}`).join('\n')}`,
      truncated: false,
    });
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
      // Retain the legacy input key order covered by the byte-for-byte golden.
      const commandResult = options.receipt
        ? ({
            commandId: `command-${mutationOrdinal}`,
            revision: 0,
            outcome: 'applied' as const,
            entityId: 'sibling',
          } satisfies NonNullable<
            Parameters<ChatStateV2Backend['transact']>[1]['commandResult']
          > & { revision: number })
        : undefined;
      await backend.transact((current) => build(current), {
        source: 'automation',
        mutationId: `mutation-${mutationOrdinal}`,
        ...(options.chatIds ? { chatIds: options.chatIds } : {}),
        ...(options.fullTranscript ? { fullTranscript: true } : {}),
        ...(commandResult ? { commandResult } : {}),
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
