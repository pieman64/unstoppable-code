import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { sep } from 'node:path';
import {
  getFileBrowserRoots,
  getFileBrowserSupplementalWatchPaths,
} from './file-browser-roots';

export interface AuthorizedFileRoots {
  readonly paths: readonly string[];
}

export interface AuthorizedRegularFile {
  absolutePath: string;
  fileHandle: FileHandle;
  fileStat: Stats;
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function isWindowsNetworkOrDevicePath(path: string): boolean {
  const windowsPath = path.replace(/\//g, '\\');
  return (
    windowsPath.startsWith('\\\\') ||
    windowsPath.startsWith('\\??\\') ||
    windowsPath.toUpperCase().startsWith('\\GLOBALROOT\\')
  );
}

/** Resolve roots once, before accepting any agent-supplied paths. */
export async function getAuthorizedFileRoots(
  scope: { projectId: string; worktreeId: string },
  options: { images?: boolean; extraRoots?: readonly string[] } = {},
): Promise<AuthorizedFileRoots> {
  const { roots } = await getFileBrowserRoots(
    scope.projectId,
    scope.worktreeId,
  );
  const candidates = roots.map((root) => root.absolutePath);
  if (options.images) {
    candidates.push(
      ...getFileBrowserSupplementalWatchPaths(
        scope.projectId,
        scope.worktreeId,
      ),
    );
  }
  candidates.push(...(options.extraRoots ?? []));
  const paths: string[] = [];
  for (const candidate of candidates) {
    try {
      paths.push(await realpath(candidate));
    } catch {
      // Missing optional roots grant nothing.
    }
  }
  return { paths };
}

/** Nonblocking, identity-checked open; the caller owns the returned handle. */
export function openAuthorizedRegularFile(
  absolutePath: string,
  roots: AuthorizedFileRoots,
): Promise<AuthorizedRegularFile> {
  return openRegularFileForRead(absolutePath, roots);
}

/**
 * The same open for requests that name no project, such as the optional-scope
 * `file:open-external`: `roots` null skips containment, every other check
 * still applies.
 */
export async function openRegularFileForRead(
  absolutePath: string,
  roots: AuthorizedFileRoots | null,
): Promise<AuthorizedRegularFile> {
  if (isWindowsNetworkOrDevicePath(absolutePath)) {
    throw new Error(
      'Invalid absolutePath: network and device paths are not allowed',
    );
  }
  const canonical = await realpath(absolutePath);
  const root =
    roots === null
      ? null
      : roots.paths.find((candidate) => inside(canonical, candidate));
  if (root === undefined)
    throw new Error('Cannot read file outside the target project roots');
  const pathStat = await lstat(canonical);
  if (!pathStat.isFile())
    throw new Error('Document preview requires a regular file');
  const fileHandle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile())
      throw new Error('Document preview requires a regular file');
    if (fileStat.dev !== pathStat.dev || fileStat.ino !== pathStat.ino) {
      throw new Error('Cannot read a file that changed while being validated');
    }
    const resolvedAgain = await realpath(canonical);
    if (root !== null && !inside(resolvedAgain, root)) {
      throw new Error('Cannot read file outside the target project roots');
    }
    const currentStat = await lstat(resolvedAgain);
    if (
      resolvedAgain !== canonical ||
      !currentStat.isFile() ||
      fileStat.dev !== currentStat.dev ||
      fileStat.ino !== currentStat.ino
    ) {
      throw new Error('Cannot read a file that changed while being validated');
    }
    return { absolutePath: canonical, fileHandle, fileStat };
  } catch (error) {
    await fileHandle.close();
    throw error;
  }
}

/** Reads at most maxBytes + 1 so oversized files are rejected without an unbounded read. */
export async function readAuthorizedRegularFile(
  absolutePath: string,
  roots: AuthorizedFileRoots,
  maxBytes: number,
): Promise<Buffer> {
  const opened = await openAuthorizedRegularFile(absolutePath, roots);
  try {
    if (opened.fileStat.size > maxBytes)
      throw new Error('Image exceeds the 2 MiB limit');
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, maxBytes + 1 - size),
      );
      const { bytesRead } = await opened.fileHandle.read(
        chunk,
        0,
        chunk.length,
        null,
      );
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error('Image exceeds the 2 MiB limit');
    return Buffer.concat(chunks, size);
  } finally {
    await opened.fileHandle.close();
  }
}
