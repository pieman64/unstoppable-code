/**
 * `dev:ino:birthtimeNs` from a bigint stat. A folder deleted and recreated
 * gets a new identity, so its entry is flushed again. A recreated folder that
 * reuses the inode keeps its identity, and is not flushed again, where the
 * filesystem has no birth time (`birthtimeNs` 0) or within the birth time's
 * tick of the original's creation (a kernel tick on Linux ext4; accepted,
 * CAN-5153).
 */
export type FolderIdentity = string;

/** Folders whose entry in their holder is flushed, by resolved path. */
export type ConfirmedFolders = Map<string, FolderIdentity>;

export function folderIdentityOf(stats: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}): FolderIdentity {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

/** The host's file system, with resolved paths. */
export interface FolderChainPorts {
  /** Creates the folder and any missing folder above it. */
  readonly mkdir: (folder: string) => Promise<unknown>;
  /** Rejects when the folder is missing or not a folder. */
  readonly identity: (folder: string) => Promise<FolderIdentity>;
  readonly dirname: (path: string) => string;
  /** Flushes a folder so its entries persist; rejects on any failure. */
  readonly flush: (folder: string) => Promise<unknown>;
}

export interface FolderChainOptions {
  /** Resolved; every target must be it or inside it. */
  readonly dataRoot: string;
  /** Updated in place; only a successful flush adds to it. */
  readonly confirmed: ConfirmedFolders;
}

/** `target` and each folder above it up to `dataRoot`, deepest first. */
function folderChain(
  target: string,
  dataRoot: string,
  dirname: (path: string) => string,
): string[] {
  const chain: string[] = [];
  for (let folder = target; ; folder = dirname(folder)) {
    chain.push(folder);
    if (folder === dataRoot) return chain;
    if (dirname(folder) === folder) {
      throw new TypeError('A durable folder must be inside the data root');
    }
  }
}

/**
 * Creates each target and makes every folder from it up to the data root
 * durable: each folder's entry is flushed in its holder unless `confirmed`
 * already holds it with the same identity. Who created a folder does not
 * matter, so one another process or an earlier start created is covered.
 *
 * The anchor, the data root's parent, is flushed last; nothing above it is,
 * as Windows refuses a standard user the read-write handle a flush needs on
 * `C:\Users` and `C:\`. Folders above the anchor that a data-root override
 * created stay unflushed (accepted, CAN-5153). A refused anchor flush fails
 * closed like any other (CAN-5151 D1; Mike, 2026-10-30).
 *
 * A failed `mkdir` or flush records nothing for the folders it left, so the
 * next call retries them. Concurrent calls may flush a holder twice.
 */
export async function ensureFolderChainDurable(
  targets: readonly string[],
  ports: FolderChainPorts,
  options: FolderChainOptions,
): Promise<void> {
  const { dataRoot, confirmed } = options;
  const anchor = ports.dirname(dataRoot);
  if (anchor === dataRoot) {
    throw new TypeError('The data root must have a parent folder');
  }
  const folders = new Set(
    targets.flatMap((target) => folderChain(target, dataRoot, ports.dirname)),
  );
  // Last, so the anchor is flushed after every holder below it.
  folders.delete(dataRoot);
  folders.add(dataRoot);
  for (const target of Array.from(new Set(targets))) await ports.mkdir(target);

  const pending = new Map<string, Array<[string, FolderIdentity]>>();
  for (const folder of Array.from(folders)) {
    const identity = await ports.identity(folder);
    if (confirmed.get(folder) === identity) continue;
    const holder = ports.dirname(folder);
    const entries = pending.get(holder) ?? [];
    entries.push([folder, identity]);
    pending.set(holder, entries);
  }
  for (const [holder, entries] of Array.from(pending)) {
    await ports.flush(holder);
    for (const [folder, identity] of entries) confirmed.set(folder, identity);
  }
}
