import { ChatStorageV2 } from '../../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../../services/chat-state-v2-backend';
import type { ChatMigrationSource } from '../../lib/chat-storage-v2';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Explicit promotion remains opt-in; production readers also support format 4. */
export async function format4Scope(
  root: string,
  scopeId: string,
  source: () => Promise<ChatMigrationSource>,
): Promise<{ store: ChatStorageV2; backend: ChatStateV2Backend }> {
  const store = new ChatStorageV2(root, scopeId, undefined, {
    maxManifestVersion: 4,
  });
  await store.migrate(source);
  const backend = new ChatStateV2Backend(store, {
    deltaJournal: {},
    enableFormat4: true,
  });
  await backend.promoteToDeltaJournal();
  await backend.promoteToFormat4();
  return { store, backend };
}

/** Exact refusal evidence; call before opening a scope, not around recovery. */
export async function snapshotFormat4Files(
  root: string,
): Promise<
  Array<{ path: string; size: number; sha256: string; mtimeMs: number }>
> {
  const result: Array<{
    path: string;
    size: number;
    sha256: string;
    mtimeMs: number;
  }> = [];
  async function visit(directory: string, relative: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile()) {
        const info = await stat(absolute);
        result.push({
          path,
          size: info.size,
          mtimeMs: info.mtimeMs,
          sha256: createHash('sha256')
            .update(await readFile(absolute))
            .digest('hex'),
        });
      }
    }
  }
  await visit(root, '');
  return result;
}

export function reopenFormat4Scope(
  root: string,
  scopeId: string,
  options: { deltaJournal?: boolean; enableFormat4?: boolean } = {},
): { store: ChatStorageV2; backend: ChatStateV2Backend } {
  const store = new ChatStorageV2(root, scopeId, undefined, {
    maxManifestVersion: 4,
  });
  const backend = new ChatStateV2Backend(store, {
    ...(options.deltaJournal === false ? {} : { deltaJournal: {} }),
    enableFormat4: options.enableFormat4 ?? true,
  });
  return { store, backend };
}
