/**
 * Redundant per-commit work on the canonical chat-storage write path, counted
 * with the chat-storage work counters (phase 07 of the desktop performance
 * plan). Each commit may parse the index files, clone whole indexes, and read,
 * parse and hash a staged payload only as often as the commit needs to; the
 * durable bytes and syncs are pinned separately by the commit golden test.
 *
 * The coherence tests pin the other half of the contract: a commit's view of
 * the committed indexes must never go stale when another writer, another
 * store instance, or an external edit changes the index files.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatCoreMutation,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { ChatStorageV2, type ChatMigrationEntry } from '../lib/chat-storage-v2';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { isRecord } from '../lib/type-guards';

const message = (
  id: string,
  role: PersistedChatMessage['role'] = 'assistant',
  text = id,
): PersistedChatMessage => ({
  id,
  role,
  timestamp: 1,
  blocks: [{ type: 'text', text }],
});

async function migrate(
  root: string,
  scopeId = 'scope',
): Promise<ChatStorageV2> {
  const store = new ChatStorageV2(root, scopeId);
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
        for (const id of ['chat', 'sibling'])
          yield await Promise.resolve({
            metadata: { id, title: id, createdAt: '2026-09-30' },
            messages:
              (async function* (): AsyncGenerator<PersistedChatMessage> {
                yield await Promise.resolve(message(`${id}-prompt`, 'user'));
                yield await Promise.resolve(message(`${id}-reply`));
              })(),
          });
      })(),
    }),
  );
  return store;
}

const streaming: ChatCoreMutation = {
  type: 'runtime.patched',
  chatId: 'chat',
  runtime: { status: 'streaming', queuedMessageIds: [] },
};
const idle: ChatCoreMutation = {
  type: 'runtime.patched',
  chatId: 'chat',
  runtime: { status: 'idle', queuedMessageIds: [] },
};

function count(name: string): number {
  return snapshotWorkCounters().chatStorage[name] ?? 0;
}

describe('per-commit chat storage work', () => {
  let root: string;
  let store: ChatStorageV2;
  let backend: ChatStateV2Backend;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-storage-commit-work-'));
    store = await migrate(root);
    backend = new ChatStateV2Backend(store);
    await backend.load();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await backend.disposeArtifactMaintenance();
    await rm(root, { recursive: true, force: true });
  });

  const transact = async (
    mutations: ChatCoreMutation[],
    options: { chatIds?: string[]; fullTranscript?: boolean } = {},
  ): Promise<void> => {
    const result = await backend.transact(() => mutations, {
      source: 'automation',
      ...options,
    });
    expect(result.applied).toBe(true);
  };

  it('parses no index file for a commit after the scope is loaded', async () => {
    resetWorkCounters();
    await transact([streaming]);
    await transact([
      { type: 'message.upserted', chatId: 'chat', message: message('a1') },
    ]);

    expect(count('commits')).toBe(2);
    expect(count('indexParses')).toBe(0);
  });

  it('clones whole indexes only for the two state views a commit returns', async () => {
    resetWorkCounters();
    await transact([
      streaming,
      { type: 'message.upserted', chatId: 'chat', message: message('a1') },
    ]);

    expect(count('commits')).toBe(1);
    // The build view handed to the caller's mutation builder and the result
    // view the commit returns. The transaction's own prepared indexes, its
    // returned snapshot, and the recovery metadata are no longer cloned.
    expect(count('indexClones')).toBe(2);
  });

  it.each([
    {
      kind: 'active',
      prepare: [streaming],
      mutations: [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: message('a1'),
        },
      ],
    },
    {
      kind: 'append',
      prepare: [
        streaming,
        { type: 'message.upserted', chatId: 'chat', message: message('a1') },
      ],
      mutations: [idle],
    },
    {
      kind: 'replace',
      prepare: [],
      mutations: [
        { type: 'message.removed', chatId: 'chat', messageId: 'chat-reply' },
      ],
    },
  ] satisfies Array<{
    kind: string;
    prepare: ChatCoreMutation[];
    mutations: ChatCoreMutation[];
  }>)(
    'reads, parses and hashes an $kind payload once per commit',
    async ({ prepare, mutations }) => {
      if (prepare.length) await transact(prepare);
      resetWorkCounters();

      await transact(mutations);

      expect(count('commits')).toBe(1);
      expect({
        reads: count('payloadReads'),
        parses: count('payloadParses'),
        hashes: count('payloadHashes'),
      }).toEqual({ reads: 1, parses: 1, hashes: 1 });
    },
  );

  it('counts the index parses of a cold load', async () => {
    resetWorkCounters();
    await new ChatStateV2Backend(new ChatStorageV2(root, 'scope')).load();

    expect(count('indexParses')).toBe(3);
  });

  describe('coherence with other writers', () => {
    it('sees a commit made through another store instance', async () => {
      await transact([streaming]);
      const other = new ChatStateV2Backend(new ChatStorageV2(root, 'scope'));
      await other.load();
      await other.transact(() => [idle], { source: 'automation' });

      // This backend still holds revision 1; the files are at revision 2. The
      // commit must be refused, never written over the other commit.
      await expect(
        backend.transact(
          () => [
            {
              type: 'message.upserted',
              chatId: 'chat',
              message: message('a1'),
            },
          ],
          { source: 'automation' },
        ),
      ).rejects.toThrow('V2 revision conflict: expected 1, current 2');
      expect(await other.revision()).toBe(2);
      // After the refusal the backend reloads and commits on the new revision.
      await transact([
        { type: 'message.upserted', chatId: 'chat', message: message('a2') },
      ]);
      expect(await backend.revision()).toBe(3);
    });

    it('sees an index file replaced outside the transaction path', async () => {
      await transact([streaming]);
      const transactions = new ChatStorageTransactions(store);
      const next = await transactions.load();
      // An in-place edit keeps the inode; its size and times still change.
      const livePath = join(store.directory, 'live-index.json');
      const live: unknown = JSON.parse(await readFile(livePath, 'utf8'));
      if (!isRecord(live)) throw new Error('Invalid live index');
      live.revision = 17;
      const archivePath = join(store.directory, 'archive-index.json');
      const archive: unknown = JSON.parse(await readFile(archivePath, 'utf8'));
      if (!isRecord(archive)) throw new Error('Invalid archive index');
      archive.revision = 17;
      await writeFile(livePath, JSON.stringify(live));
      await writeFile(archivePath, JSON.stringify(archive));

      next.live.revision = next.archive.revision = 2;
      await expect(transactions.commit(1, next, [])).rejects.toThrow(
        'V2 revision conflict: expected 1, current 17',
      );
    });

    it('sees a scope re-created at the same path and revision', async () => {
      const transactions = new ChatStorageTransactions(store);
      const next = await transactions.load();
      await rm(store.directory, { recursive: true, force: true });
      await rm(store.manifestPath, { force: true });
      const recreated = new ChatStorageV2(root, 'scope');
      await recreated.migrate(() =>
        Promise.resolve({
          revision: 0,
          index: { activeTabId: 'other', runtimeByChatId: {} },
          recovery: {
            receipts: [],
            mutationIds: [],
            removedTabIds: [],
            removedArchiveEntryIds: [],
            removedMessageIds: [],
          },
          chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
            yield await Promise.resolve({
              metadata: {
                id: 'other',
                title: 'other',
                createdAt: '2026-09-30',
              },
              messages:
                (async function* (): AsyncGenerator<PersistedChatMessage> {
                  yield await Promise.resolve(message('other-prompt', 'user'));
                })(),
            });
          })(),
        }),
      );

      // Revision 0 matches, but the chats the commit would publish have no
      // transcripts in the new scope. What the commit knows about the old
      // scope must not let it through.
      next.live.revision = next.archive.revision = 1;
      await expect(transactions.commit(0, next, [])).rejects.toThrow(
        'New chat must initialize a transcript in the same transaction',
      );
    });

    it('refuses to commit into a deleted scope', async () => {
      await transact([streaming]);
      await rm(store.directory, { recursive: true, force: true });
      await rm(store.manifestPath, { force: true });

      await expect(
        backend.transact(() => [idle], { source: 'automation' }),
      ).rejects.toThrow();
    });
  });
});
