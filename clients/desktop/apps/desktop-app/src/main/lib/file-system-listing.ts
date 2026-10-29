import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type {
  FileIndexEntry,
  FileTreeEntry,
} from '@canopy/desktop-shared/types';
import type { FileGlobMatcher } from './file-glob-matcher';
import {
  readFilesystemDirectory,
  readDirectoryEntries,
  sortDirectoryEntries,
  type FileSystemReadBoundary,
  type FilesystemRoot,
} from '@canopy/core-runtime/node';
export type { FileSystemReadBoundary } from '@canopy/core-runtime/node';
import { checkIgnoredPaths, listIgnoredPathEntries } from './git';

export interface FileSystemListingOptions {
  gitAware: boolean;
  globMatcher: FileGlobMatcher;
  excludedDescendantRoots?: string[];
  readBoundary?: FileSystemReadBoundary;
}

interface WalkFile {
  absolutePath: string;
  relativePath: string;
  filename: string;
}

export interface FileIndexBuildResult {
  files: FileIndexEntry[];
  truncated: boolean;
}

interface FileIndexWalkState {
  readonly maxEntries: number;
  readonly deferredDirectories: string[];
  /**
   * Every walked file, appended in traversal order. One shared array, because
   * merging each subtree's own array into its parent with a spread call
   * overflows the call stack once a subtree holds ~125k files.
   */
  readonly files: WalkFile[];
  count: number;
  truncated: boolean;
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

/**
 * Ignore status for a whole-tree index. One listing of the root's ignored
 * paths replaces a `check-ignore` test per indexed file, which takes minutes
 * in a large repository. A file is ignored when it is listed itself or lies
 * under a listed directory (an entry ending in `/`). A failed listing marks
 * nothing, as a failed per-path check did.
 */
async function getIndexIgnoreMatcher(
  root: string,
  gitAware: boolean,
): Promise<(relativePath: string) => boolean> {
  if (!gitAware) return () => false;
  let entries: string[];
  try {
    entries = await listIgnoredPathEntries(root);
  } catch {
    return () => false;
  }
  if (entries.length === 0) return () => false;
  const ignored = new Set(entries);
  return (relativePath) => {
    if (ignored.has(relativePath)) return true;
    for (
      let separator = relativePath.indexOf('/');
      separator !== -1;
      separator = relativePath.indexOf('/', separator + 1)
    ) {
      if (ignored.has(relativePath.slice(0, separator + 1))) return true;
    }
    return false;
  };
}

export async function listDirectory(
  root:
    | string
    | Pick<
        FilesystemRoot,
        'absolutePath' | 'gitAware' | 'excludedDescendantRoots'
      >,
  relativeDir: string,
  options: FileSystemListingOptions,
): Promise<FileTreeEntry[]> {
  const catalogRoot =
    typeof root === 'string'
      ? {
          absolutePath: root,
          gitAware: options.gitAware,
          excludedDescendantRoots: options.excludedDescendantRoots ?? [],
        }
      : root;
  return readFilesystemDirectory(catalogRoot, relativeDir, {
    matchingRules: options.globMatcher,
    gitIgnore: { checkIgnoredPaths },
    ...(options.readBoundary ? { readBoundary: options.readBoundary } : {}),
  });
}

async function walkFiles(
  root: string,
  directoryAbsolutePath: string,
  options: FileSystemListingOptions,
  visitedRealPaths: Set<string>,
  state: FileIndexWalkState,
  walkingDeferredDirectories: boolean,
): Promise<void> {
  let realDirectoryPath: string;
  try {
    if (options.readBoundary) {
      await options.readBoundary.assertDirectory(root, directoryAbsolutePath);
      realDirectoryPath = resolve(directoryAbsolutePath);
    } else {
      realDirectoryPath = await realpath(directoryAbsolutePath);
    }
  } catch (error) {
    if (isMissingError(error)) {
      return;
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  if (visitedRealPaths.has(realDirectoryPath)) {
    return;
  }
  visitedRealPaths.add(realDirectoryPath);

  const entries = await readDirectoryEntries(
    root,
    directoryAbsolutePath,
    options.excludedDescendantRoots ?? [],
    options.readBoundary,
  );
  const sortedEntries = sortDirectoryEntries(
    entries.map((directoryEntry) => ({
      ...directoryEntry,
      name: directoryEntry.entry.name,
    })),
  );
  for (const entry of sortedEntries) {
    if (state.count >= state.maxEntries) {
      state.truncated = true;
      break;
    }
    if (entry.kind === 'directory') {
      if (
        entry.isSymlink ||
        options.globMatcher.isIndexExcluded(entry.relativePath, 'directory')
      ) {
        continue;
      }
      if (
        !walkingDeferredDirectories &&
        options.globMatcher.isTraversalDeferred?.(entry.relativePath) === true
      ) {
        state.deferredDirectories.push(entry.absolutePath);
        continue;
      }
      await walkFiles(
        root,
        entry.absolutePath,
        options,
        visitedRealPaths,
        state,
        walkingDeferredDirectories,
      );
      continue;
    }

    if (!options.globMatcher.isIndexExcluded(entry.relativePath, 'file')) {
      state.count += 1;
      state.files.push({
        absolutePath: entry.absolutePath,
        relativePath: entry.relativePath,
        filename: basename(entry.absolutePath),
      });
    }
  }
}

export async function buildFileIndex(
  root: string,
  options: FileSystemListingOptions,
): Promise<FileIndexEntry[]> {
  return (await buildFileIndexResult(root, options)).files;
}

export async function buildFileIndexResult(
  root: string,
  options: FileSystemListingOptions,
  maxEntries = Number.POSITIVE_INFINITY,
): Promise<FileIndexBuildResult> {
  const state: FileIndexWalkState = {
    maxEntries,
    deferredDirectories: [],
    files: [],
    count: 0,
    truncated: false,
  };
  const visitedRealPaths = new Set<string>();
  await walkFiles(root, root, options, visitedRealPaths, state, false);
  for (const deferredDirectory of state.deferredDirectories) {
    if (state.count >= state.maxEntries) {
      state.truncated = true;
      break;
    }
    await walkFiles(
      root,
      deferredDirectory,
      options,
      visitedRealPaths,
      state,
      true,
    );
  }
  const { files } = state;
  const isIgnored = await getIndexIgnoreMatcher(root, options.gitAware);
  return {
    files: files.map((file) => ({
      relativePath: file.relativePath,
      filename: file.filename,
      absolutePath: file.absolutePath,
      isIgnored: isIgnored(file.relativePath),
    })),
    truncated: state.truncated,
  };
}
