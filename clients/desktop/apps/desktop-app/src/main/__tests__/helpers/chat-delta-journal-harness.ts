/**
 * Shared fixtures for the delta-journal suites: a seeded PRNG, version 2
 * scopes, byte-level tree snapshots, and a recorder that captures the exact
 * storage transactions the version 2 backend commits so the same inputs can
 * be journaled.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import {
  ChatStorageV2,
  assertChatStorageIndexes,
  type ChatMigrationEntry,
  type ChatMigrationSource,
} from '../../lib/chat-storage-v2';
import type {
  ChatStorageTransactions,
  ChatStorageIndexes,
  ChatTranscriptWrite,
} from '../../lib/chat-storage-transactions';
import { iterateAsync } from '../../lib/cooperative-json';
import { ChatTranscriptLog } from '../../lib/chat-transcript-log';
import { openReplayedChatScope } from '../../lib/chat-delta-journal/reader';
import type { DeltaJournalCommitInput } from '../../lib/chat-delta-journal/writer';

/** Deterministic PRNG (mulberry32); every property test names its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)];
}

export const TRICKY_TEXT =
  'quote " backslash \\ tab \t newline \n nul \u0000 ' +
  'line-sep   emoji 🌲👩‍💻 cjk 漢字 lone-high \ud800 lone-low \udc00';

export function message(
  id: string,
  text: string,
  role: PersistedChatMessage['role'] = 'assistant',
  timestamp = 1,
): PersistedChatMessage {
  return { id, role, timestamp, blocks: [{ type: 'text', text }] };
}

export function toolMessage(
  id: string,
  output: string,
  timestamp = 2,
): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp,
    blocks: [
      {
        type: 'tool_result',
        toolUseId: `${id}-tool`,
        toolName: 'shell',
        output,
        isError: false,
      },
    ],
  };
}

export function scopeSource(
  chats: Array<{ id: string; messages: PersistedChatMessage[] }>,
): () => Promise<ChatMigrationSource> {
  return () =>
    Promise.resolve({
      revision: 0,
      index: { activeTabId: chats[0]?.id ?? '', runtimeByChatId: {} },
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
            metadata: { id: chat.id, title: chat.id, createdAt: '2026-10-01' },
            messages:
              (async function* (): AsyncGenerator<PersistedChatMessage> {
                for (const row of chat.messages)
                  yield await Promise.resolve(row);
              })(),
          });
      })(),
    });
}

export async function createV2Scope(
  root: string,
  scopeId: string,
  chats: Array<{ id: string; messages: PersistedChatMessage[] }>,
): Promise<ChatStorageV2> {
  const store = new ChatStorageV2(root, scopeId);
  await store.migrate(scopeSource(chats));
  return store;
}

/** Copy a scope directory and its manifest under another root. */
export async function cloneScope(
  source: ChatStorageV2,
  root: string,
  scopeId: string,
): Promise<ChatStorageV2> {
  const target = new ChatStorageV2(root, scopeId);
  await mkdir(dirname(target.directory), { recursive: true });
  await mkdir(dirname(target.manifestPath), { recursive: true });
  await cp(source.directory, target.directory, { recursive: true });
  const manifest: unknown = JSON.parse(
    await readFile(source.manifestPath, 'utf8'),
  );
  if (typeof manifest !== 'object' || manifest === null)
    throw new Error('Invalid manifest');
  await writeFile(
    target.manifestPath,
    JSON.stringify({ ...manifest, scopeId }),
  );
  return target;
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

/** Every file under `root` by relative path, as a SHA-256 of its bytes. */
export async function treeDigests(
  root: string,
  exclude: (relativePath: string) => boolean = () => false,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for await (const path of files(root)) {
    const name = relative(root, path).split(sep).join('/');
    if (exclude(name)) continue;
    result[name] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  }
  return result;
}

/**
 * `<chat>.turns.json` is a derived cache that version 2 also writes on read
 * paths (turn-view pages), so its bytes depend on read history, not on the
 * commit path. Suites that read between commits compare its projection
 * (`ScopeState.chats[*].turnPage`) instead of its bytes.
 */
export function readPopulatedCache(relativePath: string): boolean {
  return relativePath.endsWith('.turns.json');
}

/** Files the journal adds to a scope; everything else must match v2. */
export function journalOnlyFile(relativePath: string): boolean {
  return (
    relativePath === 'delta-journal.log' ||
    relativePath.startsWith('delta-journal-tail-quarantine-') ||
    relativePath.startsWith('delta-checkpoint')
  );
}

export interface ScopeState {
  revision: number;
  indexes: string;
  chats: Record<
    string,
    { committed: string[]; active: string[]; turnPage: string }
  >;
}

function chatIds(indexes: ChatStorageIndexes): string[] {
  return [
    ...indexes.live.tabs.map((tab) => tab.id),
    ...indexes.archive.archived.map((entry) => entry.tab.id),
  ].sort();
}

async function logState(
  log: ChatTranscriptLog,
  chatId: string,
): Promise<{ committed: string[]; active: string[]; turnPage: string }> {
  const committed: string[] = [];
  for await (const row of log.iterate(chatId))
    committed.push(JSON.stringify(row));
  return {
    committed,
    active: (await log.activeMessages(chatId)).map((row) =>
      JSON.stringify(row),
    ),
    // The derived turn index, as a reader sees it (read-only: not cached).
    turnPage: JSON.stringify(
      await log.page(chatId, undefined, { view: 'turns' }),
    ),
  };
}

/** Committed state of a version 2 scope, read from its files. */
export async function v2ScopeState(store: ChatStorageV2): Promise<ScopeState> {
  const indexes = await store.indexes();
  const log = new ChatTranscriptLog(
    join(store.directory, 'transcripts'),
    undefined,
    { readOnly: true },
  );
  const chats: ScopeState['chats'] = {};
  for (const id of chatIds(indexes)) chats[id] = await logState(log, id);
  return {
    revision: indexes.live.revision,
    indexes: JSON.stringify(indexes),
    chats,
  };
}

/** Committed state of a delta-journal scope, through the replay helper. */
export async function replayedScopeState(
  store: ChatStorageV2,
): Promise<ScopeState> {
  const view = await openReplayedChatScope(
    { directory: store.directory, scopeId: store.descriptor().scopeId },
    assertChatStorageIndexes,
  );
  try {
    const chats: ScopeState['chats'] = {};
    for (const id of chatIds(view.indexes))
      chats[id] = await logState(view.transcript(id), id);
    return {
      revision: view.revision,
      indexes: JSON.stringify(view.indexes),
      chats,
    };
  } finally {
    await view.dispose();
  }
}

/** A version 2 transaction's inputs, with every message stream drained. */
export type RecordedCommit = DeltaJournalCommitInput;

/**
 * Record every commit `transactions` makes while the returned stop function
 * has not run. Message streams are drained once, and the drained rows are
 * what both the version 2 commit and the recording see. `mutationIds` are
 * the ids each commit adds to the retained window.
 */
export function recordV2Commits(
  transactions: ChatStorageTransactions,
  initialMutationIds: readonly string[],
): { commits: RecordedCommit[]; stop: () => void } {
  const commits: RecordedCommit[] = [];
  let retained = new Set(initialMutationIds);
  const original = transactions.commit.bind(transactions);
  const spy = jest
    .spyOn(transactions, 'commit')
    .mockImplementation(
      async (
        expectedRevision,
        next,
        writes,
        created,
        beforePublish,
        preparePublish,
      ): Promise<ChatStorageIndexes> => {
        const drained: ChatTranscriptWrite[] = [];
        for (const write of writes) {
          const rows: PersistedChatMessage[] = [];
          for await (const row of iterateAsync(write.messages ?? []))
            rows.push(row);
          drained.push({ ...write, messages: rows });
        }
        const snapshot: ChatStorageIndexes = structuredClone(next);
        const result = await original(
          expectedRevision,
          next,
          drained,
          created,
          beforePublish,
          preparePublish,
        );
        commits.push({
          expectedRevision,
          next: snapshot,
          writes: drained,
          mutationIds: snapshot.recovery.mutationIds.filter(
            (id) => !retained.has(id),
          ),
        });
        retained = new Set(snapshot.recovery.mutationIds);
        return result;
      },
    );
  return { commits, stop: (): void => spy.mockRestore() };
}

/**
 * Publish every tool output the version 2 scope holds into the journal
 * scope, as a caller does before committing a record that references them.
 */
export async function publishArtifacts(
  from: ChatStorageV2,
  to: ChatStorageV2,
): Promise<void> {
  const source = join(from.directory, 'transcripts', 'tool-output');
  const target = join(to.directory, 'transcripts', 'tool-output');
  for await (const path of files(source)) {
    const destination = join(target, relative(source, path));
    await mkdir(dirname(destination), { recursive: true });
    await cp(path, destination, { force: false, errorOnExist: false });
  }
}
