/**
 * Repository-level fixtures for the phase 09 delta-journal suites: scopes
 * under a temporary root, a repository resolving every scope there, the
 * default journal policy, and work-counter deltas.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ChatCoreMutation,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { snapshotWorkCounters } from '@canopy/desktop-shared/node/work-counters';
import { ChatStorageV2 } from '../../lib/chat-storage-v2';
import {
  ChatStateV2Repository,
  type ChatStateV2RepositoryOptions,
} from '../../services/chat-state-v2-repository';
import type { ChatScopeKey } from '../../services/chat-state-contracts';

/** Every repository a test opened, until afterEach drains it. */
const openRepositories = new Set<ChatStateV2Repository>();

/**
 * Drain `target` after the test, even when the test fails first. A test
 * that simulates a process stopping without a drain still has its
 * repository drained here: its idle checkpoint timers are real,
 * and Jest runs later test files in the same process, sharing the
 * `node:fs/promises` module their spies observe.
 */
export function drainAfterTest(
  repository: ChatStateV2Repository,
): ChatStateV2Repository {
  openRepositories.add(repository);
  return repository;
}

/**
 * For afterEach: drain everything {@link drainAfterTest} registered. A drain
 * clears its timers synchronously; a test that left an operation blocked
 * forever only bounds how long this waits for the rest. Never rejects.
 */
export async function drainOpenRepositories(): Promise<void> {
  const repositories = Array.from(openRepositories);
  openRepositories.clear();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(repositories.map((repository) => repository.drainAll())),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 10_000);
    }),
  ]);
  clearTimeout(timer);
}

/** A repository whose scopes all live under `root`, drained after the test. */
export function repositoryAt(
  root: string,
  options: ChatStateV2RepositoryOptions = {},
): ChatStateV2Repository {
  return drainAfterTest(
    new ChatStateV2Repository({
      resolvePaths: (scope: ChatScopeKey) => ({
        tabs: join(root, 'chats', `${scope.worktreeId}.json`),
        archives: join(root, 'chat-archives', `${scope.worktreeId}.json`),
        journal: join(root, 'chat-journals', `${scope.worktreeId}.jsonl`),
      }),
      ...options,
    }),
  );
}

export function storeAt(root: string, scopeId: string): ChatStorageV2 {
  return new ChatStorageV2(root, scopeId);
}

export interface WorkDelta {
  fileSyncs: number;
  directorySyncs: number;
  syncs: number;
  written: number;
  writtenByClass: Record<string, number>;
  commits: number;
  /** File syncs of the delta journal (commits and rotations). */
  journalSyncs: number;
  checkpoints: number;
}

/** Chat-storage work done between the call and the returned function. */
export function measureWork(): () => WorkDelta {
  const before = snapshotWorkCounters().chatStorage;
  return () => {
    const after = snapshotWorkCounters().chatStorage;
    const delta = (key: string): number =>
      (after[key] ?? 0) - (before[key] ?? 0);
    const writtenByClass: Record<string, number> = {};
    let written = 0;
    for (const key of Object.keys(after)) {
      const match = /^written\.(.+)\.bytes$/.exec(key);
      if (!match) continue;
      const bytes = delta(key);
      if (bytes === 0) continue;
      writtenByClass[match[1]] = bytes;
      written += bytes;
    }
    const fileSyncs = delta('syncs.file');
    const directorySyncs = delta('syncs.directory');
    return {
      fileSyncs,
      directorySyncs,
      syncs: fileSyncs + directorySyncs,
      written,
      writtenByClass,
      commits: delta('commits'),
      journalSyncs: delta('syncs.file.deltaJournal'),
      checkpoints: delta('deltaJournal.checkpoints'),
    };
  };
}

export function text(
  id: string,
  body: string,
  role: PersistedChatMessage['role'] = 'assistant',
  timestamp = 1,
): PersistedChatMessage {
  return { id, role, timestamp, blocks: [{ type: 'text', text: body }] };
}

export function toolResult(
  id: string,
  output: string,
  timestamp = 2,
): PersistedChatMessage {
  return {
    id,
    role: 'user',
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

export function streaming(
  chatId: string,
  userMessageId: string,
): ChatCoreMutation {
  return {
    type: 'runtime.patched',
    chatId,
    runtime: {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurn: { userMessageId, startedAt: 5 },
    },
  };
}

export function idle(chatId: string): ChatCoreMutation {
  return {
    type: 'runtime.patched',
    chatId,
    runtime: { status: 'idle', queuedMessageIds: [] },
  };
}

export function upsert(
  chatId: string,
  message: PersistedChatMessage,
): ChatCoreMutation {
  return { type: 'message.upserted', chatId, message };
}

/** Records after the scope's last checkpoint, read from its journal file. */
export async function journalBytes(store: ChatStorageV2): Promise<number> {
  try {
    return (await stat(join(store.directory, 'delta-journal.log'))).size;
  } catch {
    return 0;
  }
}

export async function manifestVersion(
  store: ChatStorageV2,
): Promise<number | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(store.manifestPath, 'utf8'),
    );
    return typeof value === 'object' && value !== null && 'version' in value
      ? Number(Reflect.get(value, 'version'))
      : undefined;
  } catch {
    return undefined;
  }
}

/** Names in the scope directory that only the delta journal writes. */
export async function journalFiles(store: ChatStorageV2): Promise<string[]> {
  try {
    return (await readdir(store.directory))
      .filter((name) => name.startsWith('delta-'))
      .sort();
  } catch {
    return [];
  }
}
