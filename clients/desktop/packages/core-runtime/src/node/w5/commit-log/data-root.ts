import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  ensureFolderChainDurable,
  folderIdentityOf,
  type ConfirmedFolders,
  type FolderIdentity,
} from '../../../storage';

export interface W5DataRootOptions {
  /** The Canopy data root; `root` must be it or inside it. Default: `root`. */
  readonly dataRoot?: string;
  /** The commit log database's folder, inside `dataRoot`. */
  readonly dbFolder?: string;
}

/** Folders this worker thread confirmed durable. */
const confirmedFolders: ConfirmedFolders = new Map();

async function folderIdentity(folder: string): Promise<FolderIdentity> {
  const stats = await stat(folder, { bigint: true });
  if (!stats.isDirectory()) {
    throw Object.assign(new Error(`ENOTDIR: not a directory, ${folder}`), {
      code: 'ENOTDIR',
    });
  }
  return folderIdentityOf(stats);
}

/**
 * Creates the W5 data root when it is missing and makes it durable before
 * any commit: every folder from the root (and the database folder) up to the
 * Canopy data root has its entry flushed, the data root's parent last, unless
 * this thread already confirmed it (`ensureFolderChainDurable`). Commits are
 * applied only inside an existing root, so without it a first commit would
 * land as awaiting recovery.
 *
 * Who created a folder does not matter: host registration creates the data
 * root on POSIX without flushing its parent, and a worker that stopped
 * before its flush leaves a root that already exists. A new worker thread
 * starts with no record, so each worker start flushes the chain again.
 * Nothing above the data root's parent is flushed: Windows refuses a
 * standard user the read-write handle its flush needs on `C:\Users` and `C:\`.
 *
 * The database folder itself is then flushed on every start and platform, so
 * the database file's entry does not depend on SQLite's own folder sync,
 * which SQLite never does on Windows.
 */
export async function ensureW5DataRoot(
  root: string,
  /** The host's folder sync: its durability port's `syncDirectory`. */
  sync: (folder: string) => Promise<void>,
  options: W5DataRootOptions = {},
): Promise<void> {
  const resolvedRoot = resolve(root);
  const dbFolder =
    options.dbFolder === undefined ? undefined : resolve(options.dbFolder);
  await ensureFolderChainDurable(
    dbFolder === undefined ? [resolvedRoot] : [resolvedRoot, dbFolder],
    {
      mkdir: (folder) => mkdir(folder, { recursive: true }),
      identity: folderIdentity,
      dirname,
      flush: sync,
    },
    {
      dataRoot: resolve(options.dataRoot ?? root),
      confirmed: confirmedFolders,
    },
  );
  if (dbFolder !== undefined) await sync(dbFolder);
}

/**
 * Where a host's W5 commit log and data root live under its canonical data
 * root, the same paths as the desktop's `getW5CommitLogPath()` and
 * `getWorkspacesRootDir()`.
 */
export function w5CommitLogLocation(dataRoot: string): {
  readonly dbPath: string;
  readonly root: string;
} {
  return {
    dbPath: join(dataRoot, 'w5', 'commit-log.sqlite'),
    root: join(dataRoot, 'workspaces'),
  };
}

/**
 * The capture root a worker uses: the host's anchored one, or, for the host's
 * first worker, the realpath of the root it has just ensured. Undefined when
 * that does not resolve; Windows capture then refuses, and the host replaces
 * such a worker before a capture so a later one can anchor.
 */
export async function anchorW5CaptureRoot(
  root: string,
  anchored: string | undefined,
): Promise<string | undefined> {
  if (anchored !== undefined) return anchored;
  try {
    return await realpath(root);
  } catch {
    return undefined;
  }
}
