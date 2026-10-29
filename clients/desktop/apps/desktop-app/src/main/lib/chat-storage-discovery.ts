import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatStorageV2 } from './chat-storage-v2';
import { summarizeDeltaJournal } from './chat-delta-journal/reader';
import { isErrnoException, isRecord } from './type-guards';

/** Lightweight discovery only; the repository validates/replays full storage. */
export async function chatStorageScopeIds(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, 'chat-storage-manifests')))
      .filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name))
      .map((name) => name.slice(0, -5));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

export interface ChatStorageDiscoveryIndex {
  tabs: Record<string, unknown>[];
  runtimeByChatId: Record<string, unknown>;
  /**
   * A delta-journal (version 3) scope holds records after its last
   * checkpoint: `tabs` and `runtimeByChatId` include them (through the
   * read-only replay), but loading the scope replays them durably.
   */
  pendingJournal: boolean;
}

function parseLiveIndex(
  index: unknown,
): Omit<ChatStorageDiscoveryIndex, 'pendingJournal'> {
  if (
    !isRecord(index) ||
    index.version !== 2 ||
    !Array.isArray(index.tabs) ||
    !index.tabs.every(isRecord) ||
    !isRecord(index.runtimeByChatId)
  )
    throw new Error('Invalid chat storage live index');
  return { tabs: index.tabs, runtimeByChatId: index.runtimeByChatId };
}

/**
 * The committed live index of a scope, read without admitting it. A version
 * 2 scope answers from `live-index.json`. A delta-journal scope answers from
 * its last checkpoint plus the journal records after it, through the shared
 * read-only replay, because its index file alone is only the checkpoint.
 */
export async function readChatStorageDiscoveryIndex(
  root: string,
  scopeId: string,
): Promise<ChatStorageDiscoveryIndex> {
  if (!/^[a-zA-Z0-9_-]+$/.test(scopeId))
    throw new Error('Invalid chat storage scope');
  const manifest: unknown = JSON.parse(
    await readFile(
      join(root, 'chat-storage-manifests', `${scopeId}.json`),
      'utf8',
    ),
  );
  if (
    !isRecord(manifest) ||
    (manifest.version !== 2 && manifest.version !== 3) ||
    manifest.scopeId !== scopeId
  )
    throw new Error('Invalid chat storage authority manifest');
  if (manifest.version === 3) {
    const store = new ChatStorageV2(root, scopeId);
    const summary = await summarizeDeltaJournal({
      directory: store.directory,
      scopeId,
    });
    const indexes = await store.indexes();
    // A plain-data copy, validated like the version 2 file.
    const live: unknown = JSON.parse(JSON.stringify(indexes.live));
    return {
      ...parseLiveIndex(live),
      pendingJournal: summary.recordCount > 0 || summary.tornTail !== undefined,
    };
  }
  const index: unknown = JSON.parse(
    await readFile(
      join(root, 'chat-storage-v2', scopeId, 'live-index.json'),
      'utf8',
    ),
  );
  return { ...parseLiveIndex(index), pendingJournal: false };
}
