import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { isErrnoException } from './type-guards';
import type { ArchivePayloadCopyEntry } from '../archive/archive-io-protocol';

export type ArchivedWorkspaceRootCopyExecutor = (args: {
  sourceRoots: readonly string[];
  destinationRoot: string;
  entries: readonly ArchivePayloadCopyEntry[];
}) => Promise<void>;

export type ArchivedWorkspaceRootRemoveExecutor = (args: {
  path: string;
  allowedRoot: string;
}) => Promise<void>;

export async function copyArchivedWorkspaceRootEntries(args: {
  source: string;
  destination: string;
  exclude?: ReadonlySet<string>;
}): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(args.source, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (args.exclude?.has(entry.name)) continue;
    await mkdir(args.destination, { recursive: true });
    await cp(
      join(args.source, entry.name),
      join(args.destination, entry.name),
      {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
      },
    );
  }
}

export interface ArchivedWorkspaceRepositoryRelocation {
  originalName: string;
  restoredName: string;
}

async function entryExists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch((error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return false;
      throw error;
    });
}

async function repositoryEntries(path: string): Promise<string[]> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return [];
  if (!info.isDirectory()) {
    throw new Error(
      `Repository restore directory must be a directory, not a symbolic link: ${path}`,
    );
  }
  return readdir(path);
}

export async function restoreArchivedWorkspaceRootPayload(args: {
  source: string;
  destination: string;
}): Promise<ArchivedWorkspaceRepositoryRelocation[]> {
  const sourceRepos = join(args.source, 'repos');
  const destinationRepos = join(args.destination, 'repos');
  const sourceNames = (await repositoryEntries(sourceRepos)).sort(
    (left, right) => left.localeCompare(right),
  );
  const destinationNames =
    sourceNames.length > 0 ? await repositoryEntries(destinationRepos) : [];
  const reservedNames = new Set(
    [...sourceNames, ...destinationNames].map((name) => name.toLowerCase()),
  );
  const targets: ArchivedWorkspaceRepositoryRelocation[] = [];
  for (const originalName of sourceNames) {
    let restoredName = originalName;
    if (await entryExists(join(destinationRepos, originalName))) {
      let suffix = 1;
      do {
        restoredName = `${originalName}-archived${suffix === 1 ? '' : `-${suffix}`}`;
        suffix += 1;
      } while (
        reservedNames.has(restoredName.toLowerCase()) ||
        (await entryExists(join(sourceRepos, restoredName))) ||
        (await entryExists(join(destinationRepos, restoredName)))
      );
    }
    reservedNames.add(restoredName.toLowerCase());
    targets.push({ originalName, restoredName });
  }
  await copyArchivedWorkspaceRootEntries({
    ...args,
    exclude: new Set(['repos', '.git']),
  });
  if (targets.length > 0) await mkdir(destinationRepos, { recursive: true });
  for (const target of targets) {
    const source = join(sourceRepos, target.originalName);
    const destination = join(destinationRepos, target.restoredName);
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
  }
  return targets.filter(
    (target) => target.originalName !== target.restoredName,
  );
}

export async function captureArchivedWorkspaceRootPayload(args: {
  source: string;
  destination: string;
  managedRepoIds: readonly string[];
  copyExecutor?: ArchivedWorkspaceRootCopyExecutor;
  removeExecutor?: ArchivedWorkspaceRootRemoveExecutor;
}): Promise<void> {
  const { source, destination, managedRepoIds, copyExecutor, removeExecutor } =
    args;
  const removeRecursively = async (path: string): Promise<void> => {
    if (removeExecutor) {
      await removeExecutor({ path, allowedRoot: dirname(destination) });
      return;
    }
    await rm(path, { recursive: true, force: true });
  };
  try {
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isDirectory()) {
      throw new Error(`Project root is not a directory: ${source}`);
    }
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }

  const suffix = randomUUID();
  const stagedDestination = `${destination}.${suffix}.tmp`;
  const previousDestination = `${destination}.${suffix}.previous`;
  let previousMoved = false;
  await mkdir(stagedDestination, { recursive: true });
  try {
    if (copyExecutor) {
      await copyExecutor({
        sourceRoots: [source],
        destinationRoot: stagedDestination,
        entries: [
          {
            kind: 'directory',
            source,
            destination: stagedDestination,
            missingSource: 'error',
            contentsOnly: true,
            excludeNames: ['repos', '.git'],
          },
          {
            kind: 'directory',
            source: join(source, 'repos'),
            destination: join(stagedDestination, 'repos'),
            missingSource: 'ignore',
            contentsOnly: true,
            excludeNames: managedRepoIds,
          },
        ],
      });
    } else {
      await copyArchivedWorkspaceRootEntries({
        source,
        destination: stagedDestination,
        // Child Git worktrees have their own archival lifecycle. The root .git
        // entry is also host-specific and must never be installed into a
        // restored checkout; unmanaged entries under repos/ remain
        // user-visible payload.
        exclude: new Set(['repos', '.git']),
      });
      await copyArchivedWorkspaceRootEntries({
        source: join(source, 'repos'),
        destination: join(stagedDestination, 'repos'),
        exclude: new Set(managedRepoIds),
      });
    }

    try {
      await rename(destination, previousDestination);
      previousMoved = true;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
    }
    await rename(stagedDestination, destination);
    if (previousMoved) {
      await removeRecursively(previousDestination);
    }
  } catch (error) {
    await removeRecursively(stagedDestination);
    if (previousMoved) {
      await removeRecursively(destination);
      await rename(previousDestination, destination);
    }
    throw error;
  }
}
