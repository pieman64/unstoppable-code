import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  RemoteDirectoryEntry,
  RemoteDirectoryListing,
} from '@canopy/desktop-shared/types';
import type { Dirent } from 'node:fs';

const MAX_ENTRIES = 2_000;

/** A link counts as what it points at; broken links and the rest are left out. */
async function entryKind(
  entry: Dirent,
  path: string,
): Promise<RemoteDirectoryEntry['kind'] | null> {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return null;
  const target = await stat(path).catch(() => null);
  if (target?.isDirectory()) return 'directory';
  if (target?.isFile()) return 'file';
  return null;
}

/**
 * Lists one directory for the path picker a controlling computer shows when
 * a handler here raises a file dialog. It reveals names only; the controller
 * already has full access to this computer through the session.
 */
export async function listRemoteDirectory(
  request: unknown,
): Promise<RemoteDirectoryListing> {
  const requested =
    request !== null &&
    typeof request === 'object' &&
    'path' in request &&
    typeof request.path === 'string' &&
    request.path.length > 0
      ? request.path
      : null;
  if (requested !== null && !isAbsolute(requested)) {
    throw new Error('Choose an absolute folder path.');
  }
  const path = resolve(requested ?? homedir());
  const dirents = await readdir(path, { withFileTypes: true });
  const kinds = await Promise.all(
    dirents.map((entry) => entryKind(entry, join(path, entry.name))),
  );
  const entries: RemoteDirectoryEntry[] = [];
  dirents.forEach((entry, index) => {
    const kind = kinds[index];
    if (kind)
      entries.push({ name: entry.name, path: join(path, entry.name), kind });
  });
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    const leftHidden = left.name.startsWith('.');
    const rightHidden = right.name.startsWith('.');
    if (leftHidden !== rightHidden) return leftHidden ? 1 : -1;
    return left.name.localeCompare(right.name);
  });
  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    entries: entries.slice(0, MAX_ENTRIES),
  };
}
