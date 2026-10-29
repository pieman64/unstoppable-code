import type { ChatMigrationEntry } from '../lib/chat-storage-v2';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  ChatStorageTransactions,
  type ChatStorageIndexes,
} from '../lib/chat-storage-transactions';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { isRecord } from '../lib/type-guards';
import * as directorySync from '../lib/fsync-directory';
import * as cooperativeJson from '../lib/cooperative-json';
import type * as FsPromises from 'node:fs/promises';

const fsPromises = jest.requireActual<typeof FsPromises>('node:fs/promises');

const message = (id: string): PersistedChatMessage => ({
  id,
  role: 'user',
  timestamp: 1,
  blocks: [{ type: 'text', text: id }],
});
async function* rows(
  messages: PersistedChatMessage[],
): AsyncGenerator<PersistedChatMessage> {
  for (const message of messages) yield await Promise.resolve(message);
}
const toolMessage = (id: string, output: string): PersistedChatMessage => ({
  id,
  role: 'assistant',
  timestamp: 1,
  blocks: [
    {
      type: 'tool_result',
      toolUseId: `${id}-tool`,
      toolName: 'shell',
      output,
      isError: false,
    },
  ],
});
/** Spied fs calls receive paths as strings here; handles are not locators. */
const pathText = (path: unknown): string =>
  typeof path === 'string' ? path : '';
const artifactName = (output: string): string =>
  `sha256-v1-${createHash('sha256').update(output, 'utf8').digest('hex')}.txt`;

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('v2 scope transactions', () => {
  let root: string;
  let store: ChatStorageV2;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-v2-transaction-'));
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
            metadata: { id: 'chat', title: 'Chat', createdAt: '2026-09-05' },
            messages: rows([message('a')]),
          });
        })(),
      }),
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('publishes a metadata-only commit without staging a transcript directory or syncing each index separately', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.tabs[0].title = 'Runtime metadata';
    next.live.revision = next.archive.revision = 1;
    const syncDirectory = directorySync.fsyncDirectory;
    const synced: string[] = [];
    jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        synced.push(directory);
        await syncDirectory(directory);
      });

    await transaction.commit(0, next, []);

    expect(
      synced.filter((directory) => directory === store.directory),
    ).toHaveLength(3);
    expect(
      synced.some((directory) => directory.includes('pending-transcripts')),
    ).toBe(false);
    expect(
      (await new ChatStorageTransactions(store).load()).live.tabs[0].title,
    ).toBe('Runtime metadata');
  });

  it('does not remove temporary files that were already renamed into place', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.tabs[0].title = 'Renamed';
    next.live.revision = next.archive.revision = 1;
    const removeFile = fsPromises.rm;
    const removedTemporaries: string[] = [];
    jest.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
      if (String(path).endsWith('.tmp')) removedTemporaries.push(String(path));
      await removeFile(path, options);
    });

    await transaction.commit(0, next, []);

    // Each successful atomic write used to end with an `rm` of a path its own
    // rename had already consumed: one failed `lstat` and one ENOENT error per
    // index and journal write on every commit.
    expect(removedTemporaries).toEqual([]);
    expect(
      (await new ChatStorageTransactions(store).load()).live.tabs[0].title,
    ).toBe('Renamed');
  });

  it('returns the committed index snapshot without rereading every index file', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.tabs[0].title = 'Committed snapshot';
    next.live.revision = next.archive.revision = 1;
    const indexes = jest.spyOn(store, 'indexes');
    const summary = jest.spyOn(store, 'committedIndexSummary');

    const committed = await transaction.commit(0, next, []);

    // The loaded indexes are unchanged on disk, so the commit checks them
    // from memory instead of reading the files back.
    expect(indexes).not.toHaveBeenCalled();
    expect(summary).toHaveBeenCalledTimes(1);
    expect(committed.live.tabs[0].title).toBe('Committed snapshot');
    committed.live.tabs[0].title = 'Caller mutation';
    expect(
      (await new ChatStorageTransactions(store).load()).live.tabs[0].title,
    ).toBe('Committed snapshot');
  });

  it.each([
    {
      label: 'runtime map',
      corrupt: (indexes: ChatStorageIndexes): void => {
        Reflect.set(indexes.live, 'runtimeByChatId', []);
      },
      error: 'Invalid v2 chat indexes',
    },
    {
      label: 'recovery ids',
      corrupt: (indexes: ChatStorageIndexes): void => {
        Reflect.set(indexes.recovery, 'mutationIds', [42]);
      },
      error: 'Invalid v2 recovery metadata',
    },
    {
      label: 'transcript descriptor',
      corrupt: (indexes: ChatStorageIndexes): void => {
        Reflect.set(indexes.live.tabs[0].transcript, 'format', 'invalid');
      },
      error: 'Invalid or duplicate chat index entry',
    },
  ])(
    'rejects a malformed $label index after publication validation',
    async ({ corrupt, error }) => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      corrupt(next);
      await expect(transaction.commit(0, next, [])).rejects.toThrow(error);
    },
  );

  it.each(['numeric', 'missing'] as const)(
    'rejects a %s tab ID before publishing an index',
    async (kind) => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      next.live.activeTabId = '';
      if (kind === 'numeric') Reflect.set(next.live.tabs[0], 'id', 123);
      else Reflect.deleteProperty(next.live.tabs[0], 'id');

      await expect(transaction.commit(0, next, [])).rejects.toThrow(
        /index entry/,
      );
      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
      expect((await store.indexes()).live.tabs[0].id).toBe('chat');
    },
  );

  it('removes an old metadata-only WAL payload directory during recovery', async () => {
    const interrupted = new ChatStorageTransactions(store, (point) =>
      point === 'journal'
        ? Promise.reject(new Error('interrupt'))
        : Promise.resolve(),
    );
    const next = await interrupted.load();
    next.live.revision = next.archive.revision = 1;
    await expect(interrupted.commit(0, next, [])).rejects.toThrow('interrupt');
    const pending: unknown = JSON.parse(
      await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
    );
    if (!isRecord(pending) || typeof pending.transactionId !== 'string')
      throw new Error('Missing pending transaction');
    const directory = join(
      store.directory,
      'pending-transcripts',
      pending.transactionId,
    );
    await mkdir(directory, { recursive: true });

    expect(
      (await new ChatStorageTransactions(store).load()).live.revision,
    ).toBe(1);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains replay payloads when the published journal directory sync fails', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;
    const sync = directorySync.fsyncDirectory;
    let injected = false;
    jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        if (
          !injected &&
          directory === store.directory &&
          (
            await readFile(join(directory, 'metadata-journal.jsonl'), 'utf8')
          ).trim()
        ) {
          injected = true;
          throw new Error('journal directory sync failed');
        }
        await sync(directory);
      });
    await expect(
      transaction.commit(0, next, [
        { chatId: 'chat', kind: 'append', messages: [message('b')] },
      ]),
    ).rejects.toThrow('journal directory sync failed');
    expect(injected).toBe(true);

    const recovered = new ChatStorageTransactions(store);
    await expect(recovered.load()).resolves.toMatchObject({
      live: { revision: 1 },
    });
    expect((await recovered.transcripts.page('chat')).messages).toEqual([
      message('a'),
      message('b'),
    ]);
    await recovered.load();
    expect((await recovered.transcripts.page('chat')).messages).toHaveLength(2);
  });

  it('checks authorization after preparing the atomic journal write', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;
    let authorized = true;
    let authorityRefreshed = false;
    const writeValues = cooperativeJson.writeJsonValuesCooperatively;
    jest
      .spyOn(cooperativeJson, 'writeJsonValuesCooperatively')
      .mockImplementation(async (path, values, options) => {
        await writeValues(path, values, options);
        if (path.includes('metadata-journal.jsonl.')) authorized = false;
      });

    await expect(
      transaction.commit(
        0,
        next,
        [{ chatId: 'chat', kind: 'append', messages: [message('b')] }],
        undefined,
        () => {
          expect(authorityRefreshed).toBe(true);
          if (!authorized) throw new Error('approval changed during write');
        },
        () => {
          expect(authorized).toBe(false);
          authorityRefreshed = true;
          return Promise.resolve();
        },
      ),
    ).rejects.toThrow('approval changed during write');
    expect((await transaction.load()).live.revision).toBe(0);
    expect((await transaction.transcripts.page('chat')).messages).toEqual([
      message('a'),
    ]);
  });

  describe('artifacts of a commit that fails before publication', () => {
    const committedOutput = 'committed output 🌲\n'.repeat(8000);
    let artifactDirectory: string;
    beforeEach(async () => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      await transaction.commit(0, next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [toolMessage('b', committedOutput)],
        },
      ]);
      artifactDirectory = join(
        store.directory,
        'transcripts',
        'tool-output',
        'chat',
      );
      expect(await readdir(artifactDirectory)).toEqual([
        artifactName(committedOutput),
      ]);
    });
    const failBeforePublication = async (
      output: string,
    ): Promise<ChatStorageTransactions> => {
      const failing = new ChatStorageTransactions(store, (point) =>
        point === 'prepared'
          ? Promise.reject(new Error('interrupt'))
          : Promise.resolve(),
      );
      const next = await failing.load();
      next.live.revision = next.archive.revision = 2;
      await expect(
        failing.commit(1, next, [
          {
            chatId: 'chat',
            kind: 'append',
            messages: [toolMessage('c', output)],
          },
        ]),
      ).rejects.toThrow('interrupt');
      expect(
        await readdir(join(store.directory, 'pending-transcripts')),
      ).toEqual([]);
      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
      return failing;
    };
    const committedReference = async (
      transaction: ChatStorageTransactions,
    ): Promise<void> => {
      const page = await transaction.transcripts.page('chat');
      expect(page.messages.map((message) => message.id)).toEqual(['a', 'b']);
      const block = page.messages[1].blocks[0];
      if (block.type !== 'tool_result' || !block.fullOutputRef)
        throw new Error('Missing committed artifact reference');
      await transaction.transcripts.artifacts.verify(
        'chat',
        block.fullOutputRef,
      );
      expect(
        (
          await transaction.transcripts.artifacts.readRange(
            'chat',
            block.fullOutputRef,
          )
        ).text,
      ).toContain('committed output 🌲');
    };

    it('removes exactly the artifacts the failed commit created', async () => {
      const failing = await failBeforePublication(
        'orphan output 🌲\n'.repeat(8000),
      );
      expect(await readdir(artifactDirectory)).toEqual([
        artifactName(committedOutput),
      ]);
      await committedReference(failing);
      expect(
        (await new ChatStorageTransactions(store).load()).live.revision,
      ).toBe(1);
    });

    it('keeps an artifact that an earlier committed row already shares', async () => {
      const failing = await failBeforePublication(committedOutput);
      expect(await readdir(artifactDirectory)).toEqual([
        artifactName(committedOutput),
      ]);
      await committedReference(failing);
    });
  });

  it.each(['prepared', 'journal', 'transcripts', 'indexes'] as const)(
    'recovers a scope transaction interrupted at %s',
    async (boundary) => {
      const transaction = new ChatStorageTransactions(store, (point) =>
        point === boundary
          ? Promise.reject(new Error('interrupt'))
          : Promise.resolve(),
      );
      const next = await store.indexes();
      next.live.tabs[0].title = 'Changed';
      next.live.revision = next.archive.revision = 1;
      await expect(
        transaction.commit(0, next, [
          { chatId: 'chat', kind: 'append', messages: rows([message('b')]) },
        ]),
      ).rejects.toThrow('interrupt');
      const resumed = new ChatStorageTransactions(store);
      const recovered = await resumed.load();
      expect(recovered.live.revision).toBe(boundary === 'prepared' ? 0 : 1);
      expect(recovered.live.tabs[0].title).toBe(
        boundary === 'prepared' ? 'Chat' : 'Changed',
      );
      expect((await resumed.transcripts.page('chat')).messages).toEqual(
        boundary === 'prepared' ? [message('a')] : [message('a'), message('b')],
      );
      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
    },
  );

  it.each([
    'live-index.json',
    'archive-index.json',
    'recovery-index.json',
  ] as const)(
    'replays a durable journal after an interrupted %s rename',
    async (name) => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.tabs[0].title = 'Recovered title';
      next.live.revision = next.archive.revision = 1;
      const rename = fsPromises.rename;
      let injected = false;
      const spy = jest
        .spyOn(fsPromises, 'rename')
        .mockImplementation(async (source, destination) => {
          await rename(source, destination);
          if (!injected && destination === join(store.directory, name)) {
            injected = true;
            throw new Error('interrupted index rename');
          }
        });
      await expect(transaction.commit(0, next, [])).rejects.toThrow(
        'interrupted index rename',
      );
      expect(injected).toBe(true);
      spy.mockRestore();

      const recovered = await new ChatStorageTransactions(store).load();
      expect(recovered.live.revision).toBe(1);
      expect(recovered.archive.revision).toBe(1);
      expect(recovered.live.tabs[0].title).toBe('Recovered title');
      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
    },
  );

  it('replays a durable journal if the shared index directory sync fails', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.tabs[0].title = 'Recovered after sync';
    next.live.revision = next.archive.revision = 1;
    const rename = fsPromises.rename;
    let indexRenames = 0;
    const renameSpy = jest
      .spyOn(fsPromises, 'rename')
      .mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (
          ['live-index.json', 'archive-index.json', 'recovery-index.json'].some(
            (name) => destination === join(store.directory, name),
          )
        )
          indexRenames += 1;
      });
    const syncDirectory = directorySync.fsyncDirectory;
    let injected = false;
    const syncSpy = jest
      .spyOn(directorySync, 'fsyncDirectory')
      .mockImplementation(async (directory) => {
        if (!injected && directory === store.directory && indexRenames === 3) {
          injected = true;
          throw new Error('index directory sync failed');
        }
        await syncDirectory(directory);
      });
    await expect(transaction.commit(0, next, [])).rejects.toThrow(
      'index directory sync failed',
    );
    expect(injected).toBe(true);
    renameSpy.mockRestore();
    syncSpy.mockRestore();

    const recovered = await new ChatStorageTransactions(store).load();
    expect(recovered.live.revision).toBe(1);
    expect(recovered.archive.revision).toBe(1);
    expect(recovered.live.tabs[0].title).toBe('Recovered after sync');
    expect(
      await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
    ).toBe('');
  });

  it.each(['append', 'active'] as const)(
    'rejects an invalid %s before admitting it into the durable scope journal',
    async (kind) => {
      const transaction = new ChatStorageTransactions(store);
      await transaction.transcripts.writeActive('chat', [message('pending')]);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      await expect(
        transaction.commit(0, next, [
          { chatId: 'chat', kind, messages: [message('unrelated')] },
        ]),
      ).rejects.toThrow();
      expect(
        await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
      ).toBe('');
      expect(
        (await new ChatStorageTransactions(store).load()).live.revision,
      ).toBe(0);
      expect((await transaction.transcripts.page('chat')).messages).toEqual([
        message('a'),
        message('pending'),
      ]);
    },
  );

  it('admits removal of a non-trailing mutable message as an active replacement', async () => {
    const transaction = new ChatStorageTransactions(store);
    await transaction.transcripts.writeActive('chat', [
      message('pending-first'),
      message('pending-second'),
    ]);
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;

    await expect(
      transaction.commit(0, next, [
        {
          chatId: 'chat',
          kind: 'active-replace',
          messages: [message('pending-second')],
        },
      ]),
    ).resolves.toBeDefined();

    expect((await transaction.transcripts.page('chat')).messages).toEqual([
      message('a'),
      message('pending-second'),
    ]);
  });

  it('archives and restores without rewriting the continuous transcript', async () => {
    const transaction = new ChatStorageTransactions(store);
    const original = await readFile(
      join(store.directory, 'transcripts', 'chat.jsonl'),
    );
    const archived = await transaction.load();
    const [tab] = archived.live.tabs;
    archived.live.tabs = [];
    archived.live.activeTabId = '';
    archived.archive.archived = [
      { tab, turnCount: 1, archivedAt: '2026-09-05' },
    ];
    archived.live.revision = archived.archive.revision = 1;
    await transaction.commit(0, archived, []);
    const restored = await transaction.load();
    restored.live.tabs = [restored.archive.archived[0].tab];
    restored.live.activeTabId = 'chat';
    restored.archive.archived = [];
    restored.live.revision = restored.archive.revision = 2;
    await transaction.commit(1, restored, []);
    expect(
      await readFile(join(store.directory, 'transcripts', 'chat.jsonl')),
    ).toEqual(original);
  });

  it.each([
    ['at a row boundary', 2],
    ['to zero bytes', 0],
  ])(
    'fails closed instead of loading a transcript truncated %s',
    async (_label, keep) => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      await transaction.commit(0, next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: rows([message('b'), message('c'), message('d')]),
        },
      ]);
      const path = join(store.directory, 'transcripts', 'chat.jsonl');
      const lines = (await readFile(path, 'utf8')).split('\n');
      expect(lines.filter(Boolean)).toHaveLength(4);
      await truncate(
        path,
        Buffer.byteLength(lines.slice(0, keep).join('\n') + (keep ? '\n' : '')),
      );
      await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
        'shorter',
      );
      await expect(
        new ChatStorageTransactions(store).transcripts.page('chat'),
      ).rejects.toThrow('shorter');
      // A rebuilt sparse index must not launder the truncation either.
      await rm(join(store.directory, 'transcripts', 'chat.index.json'));
      await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
        'shorter',
      );
    },
  );

  it('never recreates a missing existing transcript as empty', async () => {
    await rm(join(store.directory, 'transcripts', 'chat.jsonl'));
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;
    await expect(
      transaction.commit(0, next, [
        { chatId: 'chat', kind: 'append', messages: rows([message('b')]) },
      ]),
    ).rejects.toThrow();
    await expect(
      readFile(join(store.directory, 'transcripts', 'chat.jsonl')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // Rejected input must not install an unreplayable scope WAL that prevents
    // metadata work or use of other chats in the same scope.
    expect(
      await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
    ).toBe('');
    expect((await transaction.load()).live.revision).toBe(0);
  });

  it('rejects invalid replacement suffixes before durable admission', async () => {
    const transaction = new ChatStorageTransactions(store);
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;
    await expect(
      transaction.commit(0, next, [
        {
          chatId: 'chat',
          kind: 'replace',
          messages: [message('b')],
          activeTailCount: 2,
        },
      ]),
    ).rejects.toThrow('suffix');
    expect(
      await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
    ).toBe('');
    expect((await transaction.load()).live.revision).toBe(0);
  });

  it('refuses a stale durable journal instead of rolling newer metadata backward', async () => {
    const interrupted = new ChatStorageTransactions(store, (point) =>
      point === 'journal'
        ? Promise.reject(new Error('interrupt'))
        : Promise.resolve(),
    );
    const next = await interrupted.load();
    next.live.revision = next.archive.revision = 1;
    await expect(interrupted.commit(0, next, [])).rejects.toThrow('interrupt');
    const journalPath = join(store.directory, 'metadata-journal.jsonl');
    const staleJournal = await readFile(journalPath, 'utf8');
    const recovered = new ChatStorageTransactions(store);
    const newer = await recovered.load();
    newer.live.revision = newer.archive.revision = 2;
    newer.live.tabs[0].title = 'Newer durable title';
    await recovered.commit(1, newer, []);
    // An old journal restored independently of the newer canonical indexes.
    await writeFile(journalPath, staleJournal);
    await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
      'revision',
    );
    expect((await store.indexes()).live.tabs[0].title).toBe(
      'Newer durable title',
    );
    expect(await readFile(journalPath, 'utf8')).toBe(staleJournal);
  });

  describe('replacement of a committed message', () => {
    const history = Array.from({ length: 300 }, (_, i) => message(`row-${i}`));
    const committed = [message('a'), ...history];
    const transcriptDirectory = (): string =>
      join(store.directory, 'transcripts');
    const locatorPath = (id: string): string =>
      join(
        transcriptDirectory(),
        'message-index',
        'chat',
        `${createHash('sha256').update(id).digest('hex')}.json`,
      );
    const patch = (
      rows: readonly PersistedChatMessage[],
      id: string,
    ): PersistedChatMessage[] =>
      rows.map((row) =>
        row.id === id
          ? { ...row, blocks: [{ type: 'text', text: `${id} was patched` }] }
          : row,
      );
    const commitReplace = async (
      transaction: ChatStorageTransactions,
      replacement: PersistedChatMessage[],
      activeTailCount?: number,
    ): Promise<void> => {
      const next = await transaction.load();
      const revision = next.live.revision;
      next.live.revision = next.archive.revision = revision + 1;
      await transaction.commit(revision, next, [
        {
          chatId: 'chat',
          kind: 'replace',
          messages: rows(replacement),
          ...(activeTailCount !== undefined ? { activeTailCount } : {}),
        },
      ]);
    };
    /** Each derived locator must describe exactly its committed JSONL row. */
    const expectLocatorsMatchLog = async (
      expected: readonly PersistedChatMessage[],
    ): Promise<void> => {
      const log = await readFile(
        join(transcriptDirectory(), 'chat.jsonl'),
        'utf8',
      );
      const lines = log.split('\n').filter(Boolean);
      expect(lines).toEqual(expected.map((row) => JSON.stringify(row)));
      let offset = 0;
      for (let ordinal = 0; ordinal < lines.length; ordinal += 1) {
        const line = lines[ordinal];
        const end = offset + Buffer.byteLength(line) + 1;
        const id = expected[ordinal].id;
        expect(JSON.parse(await readFile(locatorPath(id), 'utf8'))).toEqual({
          version: 1,
          messageId: id,
          offset,
          end,
          digest: createHash('sha256').update(line).digest('hex'),
        });
        offset = end;
      }
      expect(
        await readdir(join(transcriptDirectory(), 'message-index', 'chat')),
      ).toHaveLength(expected.length);
    };
    beforeEach(async () => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      await transaction.commit(0, next, [
        { chatId: 'chat', kind: 'append', messages: rows(history) },
      ]);
    });

    it('rewrites only the locators of the changed suffix', async () => {
      const transaction = new ChatStorageTransactions(store);
      const prefixLocator = await stat(locatorPath('row-10'), {
        bigint: true,
      });
      const writeFile = fsPromises.writeFile;
      const locatorWrites: string[] = [];
      jest
        .spyOn(fsPromises, 'writeFile')
        .mockImplementation(async (path, data, options) => {
          if (pathText(path).includes('message-index'))
            locatorWrites.push(pathText(path));
          await writeFile(path, data, options);
        });
      const replacement = patch(committed, 'row-295');
      await commitReplace(transaction, replacement);
      // The patched row and the four rows that moved after it.
      expect(locatorWrites).toHaveLength(5);
      const after = await stat(locatorPath('row-10'), { bigint: true });
      expect(after.ino).toBe(prefixLocator.ino);
      expect(after.mtimeNs).toBe(prefixLocator.mtimeNs);
      jest.restoreAllMocks();
      const reloaded = new ChatStorageTransactions(store);
      expect((await reloaded.load()).live.revision).toBe(2);
      expect((await reloaded.transcripts.page('chat')).messages).toEqual(
        replacement,
      );
      await expectLocatorsMatchLog(replacement);
    });

    it('keeps an unchanged committed prefix when the caller splits an active tail', async () => {
      const transaction = new ChatStorageTransactions(store);
      const writeFile = fsPromises.writeFile;
      let locatorWrites = 0;
      jest
        .spyOn(fsPromises, 'writeFile')
        .mockImplementation(async (path, data, options) => {
          if (pathText(path).includes('message-index')) locatorWrites += 1;
          await writeFile(path, data, options);
        });
      const live = [message('live-1'), message('live-2')];
      await commitReplace(transaction, [...committed, ...live], live.length);
      expect(locatorWrites).toBe(0);
      jest.restoreAllMocks();
      const reloaded = new ChatStorageTransactions(store);
      const indexes = await reloaded.load();
      expect(indexes.live.tabs[0].transcript).toMatchObject({
        committedMessageCount: committed.length,
        hasActiveSidecar: true,
        messageCount: committed.length + live.length,
      });
      expect((await reloaded.transcripts.page('chat')).messages).toEqual([
        ...committed,
        ...live,
      ]);
      await expectLocatorsMatchLog(committed);
    });

    it('commits a turn start without rewriting the committed history', async () => {
      // The planner commits the new prompt and keeps its open timer active in
      // one replacement, so the whole committed log is a shared prefix.
      const transaction = new ChatStorageTransactions(store);
      const logPath = join(transcriptDirectory(), 'chat.jsonl');
      const before = await stat(logPath, { bigint: true });
      const prefixLocator = await stat(locatorPath('row-299'), {
        bigint: true,
      });
      const writeFile = fsPromises.writeFile;
      const locatorWrites: string[] = [];
      jest
        .spyOn(fsPromises, 'writeFile')
        .mockImplementation(async (path, data, options) => {
          if (pathText(path).includes('message-index'))
            locatorWrites.push(pathText(path));
          await writeFile(path, data, options);
        });
      const copy = jest.spyOn(fsPromises, 'copyFile');
      const prompt = message('next-prompt');
      const timer: PersistedChatMessage = {
        id: 'next-timer',
        role: 'system',
        timestamp: 2,
        blocks: [{ type: 'turn_timer', startedAt: 2, completedAt: null }],
      };
      await commitReplace(transaction, [...committed, prompt, timer], 1);

      // The committed prefix is cloned, not serialized, and published by an
      // atomic rename; only the prompt's locator is written.
      expect(copy).toHaveBeenCalledTimes(1);
      expect(copy.mock.calls[0][0]).toBe(logPath);
      expect(locatorWrites).toEqual([locatorPath('next-prompt')]);
      const after = await stat(logPath, { bigint: true });
      expect(after.ino).not.toBe(before.ino);
      expect(after.size).toBe(
        before.size + BigInt(Buffer.byteLength(JSON.stringify(prompt)) + 1),
      );
      const locator = await stat(locatorPath('row-299'), { bigint: true });
      expect(locator.ino).toBe(prefixLocator.ino);
      expect(locator.mtimeNs).toBe(prefixLocator.mtimeNs);
      jest.restoreAllMocks();

      const reloaded = new ChatStorageTransactions(store);
      const indexes = await reloaded.load();
      expect(indexes.live.tabs[0].transcript).toMatchObject({
        committedMessageCount: committed.length + 1,
        hasActiveSidecar: true,
        messageCount: committed.length + 2,
      });
      expect((await reloaded.transcripts.page('chat')).messages).toEqual([
        ...committed,
        prompt,
        timer,
      ]);
      await expectLocatorsMatchLog([...committed, prompt]);
    });

    it('keeps the old log readable when a turn start fails before publication, then replays it', async () => {
      const transaction = new ChatStorageTransactions(store);
      const logPath = join(transcriptDirectory(), 'chat.jsonl');
      const committedBytes = await readFile(logPath);
      const write = cooperativeJson.writeJsonValuesCooperatively;
      jest
        .spyOn(cooperativeJson, 'writeJsonValuesCooperatively')
        .mockImplementation(async (path, values, options) => {
          const written = await write(path, values, options);
          if (path.endsWith('.rewrite.tmp'))
            throw new Error('injected failure');
          return written;
        });
      const replacement = [...committed, message('next-prompt')];
      await expect(commitReplace(transaction, replacement)).rejects.toThrow(
        'injected failure',
      );
      jest.restoreAllMocks();

      // The crash left the committed log byte for byte, readable without
      // replay, and no temporary log.
      expect(await readFile(logPath)).toEqual(committedBytes);
      expect(await readdir(transcriptDirectory())).not.toContainEqual(
        expect.stringMatching(/\.tmp$/),
      );
      expect(
        (await new ChatStorageTransactions(store).transcripts.page('chat'))
          .messages,
      ).toEqual(committed);

      const recovered = new ChatStorageTransactions(store);
      expect((await recovered.load()).live.revision).toBe(2);
      expect((await recovered.transcripts.page('chat')).messages).toEqual(
        replacement,
      );
      await expectLocatorsMatchLog(replacement);
    });

    it.each([
      [
        'after publishing the log',
        (fail: () => Error): void => {
          const rename = fsPromises.rename;
          jest
            .spyOn(fsPromises, 'rename')
            .mockImplementation(async (source, destination) => {
              await rename(source, destination);
              if (String(destination).endsWith('chat.jsonl')) throw fail();
            });
        },
      ],
      [
        'midway through locator updates',
        (fail: () => Error): void => {
          const writeFile = fsPromises.writeFile;
          let written = 0;
          jest
            .spyOn(fsPromises, 'writeFile')
            .mockImplementation(async (path, data, options) => {
              if (pathText(path).includes('message-index') && ++written === 2)
                throw fail();
              await writeFile(path, data, options);
            });
        },
      ],
      [
        'before writing the sparse index',
        (fail: () => Error): void => {
          const rename = fsPromises.rename;
          jest
            .spyOn(fsPromises, 'rename')
            .mockImplementation(async (source, destination) => {
              if (String(destination).endsWith('chat.index.json')) throw fail();
              await rename(source, destination);
            });
        },
      ],
    ])(
      'replays a replacement interrupted %s into a valid log',
      async (_label, install) => {
        const transaction = new ChatStorageTransactions(store);
        const replacement = patch(
          committed.filter((row) => row.id !== 'row-297'),
          'row-294',
        );
        let fired = false;
        install(() => {
          fired = true;
          return new Error('injected failure');
        });
        await expect(commitReplace(transaction, replacement)).rejects.toThrow(
          'injected failure',
        );
        expect(fired).toBe(true);
        jest.restoreAllMocks();

        const recovered = new ChatStorageTransactions(store);
        const indexes = await recovered.load();
        expect(indexes.live.revision).toBe(2);
        expect(
          await readFile(
            join(store.directory, 'metadata-journal.jsonl'),
            'utf8',
          ),
        ).toBe('');
        expect((await recovered.transcripts.page('chat')).messages).toEqual(
          replacement,
        );
        expect(indexes.live.tabs[0].transcript).toEqual(
          await recovered.transcripts.descriptor('chat'),
        );
        await expect(
          recovered.transcripts.hasCommittedMessage('chat', 'row-297'),
        ).resolves.toBe(false);
        for (const row of replacement.slice(-8))
          await expect(
            recovered.transcripts.committedMessageState('chat', row),
          ).resolves.toBe('identical');
        await expectLocatorsMatchLog(replacement);
      },
    );
  });

  it('validates prepared message bytes before replaying a durable journal', async () => {
    const transaction = new ChatStorageTransactions(store, (point) =>
      point === 'journal'
        ? Promise.reject(new Error('interrupt'))
        : Promise.resolve(),
    );
    const next = await transaction.load();
    next.live.revision = next.archive.revision = 1;
    await expect(
      transaction.commit(0, next, [
        { chatId: 'chat', kind: 'append', messages: rows([message('b')]) },
      ]),
    ).rejects.toThrow('interrupt');
    const pending: unknown = JSON.parse(
      await readFile(join(store.directory, 'metadata-journal.jsonl'), 'utf8'),
    );
    if (!isRecord(pending) || typeof pending.transactionId !== 'string')
      throw new Error('Missing pending transaction id');
    await writeFile(
      join(
        store.directory,
        'pending-transcripts',
        pending.transactionId,
        '0.jsonl',
      ),
      JSON.stringify(message('wrong')) + '\n',
    );
    await expect(new ChatStorageTransactions(store).load()).rejects.toThrow(
      'integrity',
    );
    expect((await store.indexes()).live.revision).toBe(0);
  });

  describe('work counters', () => {
    const readIndex = async (name: string): Promise<string> =>
      readFile(join(store.directory, name), 'utf8');

    it('counts a metadata-only commit exactly', async () => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.tabs[0].title = 'Counted';
      next.live.revision = next.archive.revision = 1;
      resetWorkCounters();

      await transaction.commit(0, next, []);

      const live = await readIndex('live-index.json');
      const archive = await readIndex('archive-index.json');
      const recovery = await readIndex('recovery-index.json');
      const parsed = (text: string): unknown => JSON.parse(text);
      // The cleared journal held one record: the three whole indexes and the
      // transaction id. Clearing it writes no bytes.
      const journal =
        Buffer.byteLength(
          JSON.stringify({
            v: 2,
            transactionId: '00000000-0000-4000-8000-000000000000',
            expectedRevision: 0,
            indexes: {
              live: parsed(live),
              archive: parsed(archive),
              recovery: parsed(recovery),
            },
            writes: [],
          }),
        ) + 1;
      expect(snapshotWorkCounters().chatStorage).toEqual({
        commits: 1,
        // The journal record and each of the three index files.
        indexSerializations: 6,
        // Journal publish, three index renames, journal clear.
        atomicReplacements: 5,
        'syncs.file': 5,
        // After the journal, after the indexes, after the journal clear.
        'syncs.directory': 3,
        'serialized.journal.bytes': journal,
        'written.journal.bytes': journal,
        'serialized.liveIndex.bytes': Buffer.byteLength(live),
        'written.liveIndex.bytes': Buffer.byteLength(live),
        'serialized.archiveIndex.bytes': Buffer.byteLength(archive),
        'written.archiveIndex.bytes': Buffer.byteLength(archive),
        'serialized.recoveryIndex.bytes': Buffer.byteLength(recovery),
        'written.recoveryIndex.bytes': Buffer.byteLength(recovery),
      });
    });

    it('attributes payload, staging, transcript, and artifact bytes by file class', async () => {
      const transaction = new ChatStorageTransactions(store);
      const next = await transaction.load();
      next.live.revision = next.archive.revision = 1;
      const transcript = join(store.directory, 'transcripts', 'chat.jsonl');
      const before = (await stat(transcript)).size;
      const output = 'counted output 🌲\n'.repeat(8000);
      resetWorkCounters();

      await transaction.commit(0, next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [toolMessage('b', output)],
        },
      ]);

      const appended = (await stat(transcript)).size - before;
      const artifact = await stat(
        join(
          store.directory,
          'transcripts',
          'tool-output',
          'chat',
          artifactName(output),
        ),
      );
      const counters = snapshotWorkCounters().chatStorage;
      expect(counters).toMatchObject({
        commits: 1,
        artifactsPublished: 1,
        // The prepared payload and the staged append hold the same rows the
        // log grew by; the log itself is extended by copying staged bytes.
        'serialized.payload.bytes': appended,
        'written.payload.bytes': appended,
        'serialized.appendStaging.bytes': appended,
        'written.appendStaging.bytes': appended,
        'written.transcript.bytes': appended,
        'written.artifact.bytes': artifact.size,
      });
      expect(counters['serialized.transcript.bytes']).toBeUndefined();
      expect(counters['serialized.artifact.bytes']).toBeUndefined();
      expect(counters['syncs.file']).toBeGreaterThan(5);
      expect(counters['syncs.directory']).toBeGreaterThan(3);
    });
  });
});
