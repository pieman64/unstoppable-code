import { randomUUID } from 'node:crypto';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  win32,
} from 'node:path';
import type {
  BrowserTransferError,
  BrowserTransferErrorCode,
} from '@canopy/execution-engine/types/browser';
import { sanitizeDownloadName } from './download-name';
import { bindFolder, type CommitOutcome } from './folder-commit';

/**
 * Copies a finished download to a file outside the task's folder: into the
 * workspace for `browser.save_download`, or where the user chose for Save a
 * copy. Node has no handle-relative `openat` or `renameat`, so the copy is
 * bound to the checked folder another way. The bytes go into a temp file with
 * an unguessable name, created exclusively and without following links in
 * that folder, and checked to be that folder's file before any byte is
 * written. The commit runs in a helper process whose working folder is the
 * checked folder (see `folder-commit.ts`), so it links or renames by bare
 * names that resolve in that folder however its parents change.
 */

interface FileIdentity {
  dev: number;
  ino: number;
}

export interface CopyDestination {
  /** Realpath of the deepest folder of the destination that exists. */
  base: string;
  baseIdentity: FileIdentity;
  /** Folders to create under `base`, in order, once the copy is approved. */
  missing: string[];
  /** The file's name, already checked. */
  name: string;
  /** Realpath of the workspace root the file must stay inside. */
  containmentRoot?: string;
  /** The absolute path the copy will have. */
  path: string;
  /** Something already has the name. */
  exists: boolean;
}

export type PrepareResult =
  | { ok: true; destination: CopyDestination }
  | { ok: false; error: BrowserTransferError };

export class CopyError extends Error {
  constructor(
    readonly code: BrowserTransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CopyError';
  }
}

const INVALID_PATH = 'Use a path to a file inside the workspace.';
const NOT_ELIGIBLE = "That location can't be written to safely.";
const FOLDER_AT_NAME = 'A folder already has that name.';
const SOURCE_CHANGED = 'The downloaded file changed. Download it again.';
const EXISTS = 'A file with that name already exists.';
const NO_LINKS =
  "This drive can't add the file without the risk of replacing one that takes its name. Save it with overwrite.";
const NOT_MARKED = 'The copy could not be marked as downloaded.';
const REPLACED = 'Another file took the name as the copy was saved.';
const TEMP_SUFFIX = '.part';
const TEMP_PREFIX = '.canopy-copy-';
/** Error codes of a filesystem that cannot make a hard link. */
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM']);

/** A temp file name that cannot be predicted and fits any name limit. */
export function copyTempName(): string {
  return `${TEMP_PREFIX}${randomUUID()}${TEMP_SUFFIX}`;
}
export function isCopyTempName(name: string): boolean {
  return (
    name.startsWith(TEMP_PREFIX) &&
    name.endsWith(TEMP_SUFFIX) &&
    /^[0-9a-f-]{36}$/.test(name.slice(TEMP_PREFIX.length, -TEMP_SUFFIX.length))
  );
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
}
function absent(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}
function failure(
  code: BrowserTransferErrorCode,
  message: string,
): PrepareResult {
  return { ok: false, error: { code, message } };
}
function insideOrSame(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === '' ||
    (child !== '..' &&
      !child.startsWith(
        `..${hostOperatingSystem() === 'win32' ? '\\' : '/'}`,
      ) &&
      !isAbsolute(child))
  );
}
function same(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
/** A real folder at a path with no link anywhere in it. */
function plainFolder(path: string): FileIdentity | undefined {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  return realpathSync(path) === path
    ? { dev: stat.dev, ino: stat.ino }
    : undefined;
}
/** Whether anything has the name, refusing a folder or a special file there. */
function occupied(path: string): boolean | 'refused' {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) return 'refused';
    return stat.isFile() || stat.isSymbolicLink() ? true : 'refused';
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}
function legalName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('\0') &&
    sanitizeDownloadName(name) === name
  );
}

/**
 * Checks a workspace-relative path for `browser.save_download`. Every folder
 * that exists must be a plain folder, not a link, and the file's name must be
 * one macOS and Windows can both hold. Nothing is created yet.
 */
export function prepareWorkspaceDestination(
  root: string,
  relativePath: string,
): Promise<PrepareResult> {
  if (
    typeof relativePath !== 'string' ||
    relativePath === '' ||
    relativePath.includes('\0') ||
    isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath) ||
    /[/\\]$/.test(relativePath)
  )
    return Promise.resolve(failure('invalid_path', INVALID_PATH));
  const segments = relativePath
    .split(/[/\\]/)
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || !segments.every(legalName))
    return Promise.resolve(failure('invalid_path', INVALID_PATH));
  try {
    const rootReal = realpathSync(root);
    const rootIdentity = plainFolder(rootReal);
    if (!rootIdentity)
      return Promise.resolve(failure('file_not_eligible', NOT_ELIGIBLE));
    let base = rootReal;
    let baseIdentity = rootIdentity;
    const folders = segments.slice(0, -1);
    let index = 0;
    for (; index < folders.length; index++) {
      const next = join(base, folders[index] ?? '');
      let identity: FileIdentity | undefined;
      try {
        identity = plainFolder(next);
      } catch (error) {
        if (absent(error)) break;
        throw error;
      }
      if (!identity)
        return Promise.resolve(failure('file_not_eligible', NOT_ELIGIBLE));
      base = next;
      baseIdentity = identity;
    }
    const missing = folders.slice(index);
    const name = segments[segments.length - 1] ?? '';
    const path = join(base, ...missing, name);
    const taken = missing.length === 0 ? occupied(path) : false;
    if (taken === 'refused')
      return Promise.resolve(failure('file_not_eligible', FOLDER_AT_NAME));
    return Promise.resolve({
      ok: true,
      destination: {
        base,
        baseIdentity,
        missing,
        name,
        containmentRoot: rootReal,
        path,
        exists: taken,
      },
    });
  } catch {
    return Promise.resolve(failure('file_not_eligible', NOT_ELIGIBLE));
  }
}

/** Checks a path the user chose in the save dialog. Its folder must exist. */
export function prepareChosenDestination(
  absolutePath: string,
): Promise<PrepareResult> {
  if (
    typeof absolutePath !== 'string' ||
    !isAbsolute(absolutePath) ||
    absolutePath.includes('\0')
  )
    return Promise.resolve(failure('invalid_path', INVALID_PATH));
  const name = basename(absolutePath);
  if (name === '' || name === '.' || name === '..')
    return Promise.resolve(failure('invalid_path', INVALID_PATH));
  try {
    const base = realpathSync(dirname(absolutePath));
    const baseIdentity = plainFolder(base);
    if (!baseIdentity)
      return Promise.resolve(failure('file_not_eligible', NOT_ELIGIBLE));
    const path = join(base, name);
    const taken = occupied(path);
    if (taken === 'refused')
      return Promise.resolve(failure('file_not_eligible', FOLDER_AT_NAME));
    return Promise.resolve({
      ok: true,
      destination: {
        base,
        baseIdentity,
        missing: [],
        name,
        path,
        exists: taken,
      },
    });
  } catch {
    return Promise.resolve(failure('file_not_eligible', NOT_ELIGIBLE));
  }
}

/** The folder still is the one checked, with no link in its path, inside the root. */
function checkFolder(
  path: string,
  expected: FileIdentity,
  containmentRoot: string | undefined,
): void {
  const identity = plainFolder(path);
  if (
    !identity ||
    !same(identity, expected) ||
    (containmentRoot !== undefined && !insideOrSame(containmentRoot, path))
  )
    throw new CopyError('file_not_eligible', NOT_ELIGIBLE);
}

/** Creates the destination's missing folders one at a time, each a plain folder. */
function createFolders(destination: CopyDestination): {
  folder: string;
  identity: FileIdentity;
} {
  checkFolder(
    destination.base,
    destination.baseIdentity,
    destination.containmentRoot,
  );
  let folder = destination.base;
  let identity = destination.baseIdentity;
  for (const name of destination.missing) {
    const next = join(folder, name);
    try {
      mkdirSync(next);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const created = plainFolder(next);
    if (!created) throw new CopyError('file_not_eligible', NOT_ELIGIBLE);
    folder = next;
    identity = created;
  }
  return { folder, identity };
}

/** Removes `path` only while it is still the file with this identity. */
function removeIfSame(path: string, identity: FileIdentity): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && same(stat, identity)) unlinkSync(path);
  } catch {
    /* Already gone, or no longer ours. */
  }
}

/** Throws unless the helper put the copy at its name. */
function committed(outcome: CommitOutcome, overwrite: boolean): void {
  if (outcome.type === 'committed') return;
  if (outcome.type === 'refused') {
    if (outcome.reason === 'folder_at_name')
      throw new CopyError('file_not_eligible', FOLDER_AT_NAME);
    if (outcome.reason === 'not_placed')
      throw new CopyError('copy_failed', REPLACED);
    throw new CopyError('file_not_eligible', NOT_ELIGIBLE);
  }
  if (outcome.code === 'EEXIST')
    throw new CopyError('destination_exists', EXISTS);
  // Without a link, only a path-based create could keep another file, and a
  // folder swapped after the check could redirect it.
  if (!overwrite && NO_HARD_LINKS.has(outcome.code))
    throw new CopyError('file_not_eligible', NO_LINKS);
  throw Object.assign(new Error('The commit failed'), { code: outcome.code });
}

async function writeAll(
  target: FileHandle,
  buffer: Buffer,
  length: number,
): Promise<void> {
  // A write may take less than it is given; the rest is written next.
  for (let written = 0; written < length; ) {
    const { bytesWritten } = await target.write(
      buffer,
      written,
      length - written,
    );
    if (bytesWritten <= 0) throw new Error('Copy stopped');
    written += bytesWritten;
  }
}

/**
 * Copies `source`, which must still be the file with `sourceIdentity`, to the
 * prepared destination. Without `overwrite` the copy never replaces anything
 * that has the name, including a file that took it after the check. With it,
 * a file or a link at the name is replaced as a directory entry, never
 * written through. On a file system without hard links nothing is ever added
 * by its path: without `overwrite` the copy is refused. The temp file is
 * marked as downloaded before it takes the name, and removed on any failure
 * or cancel.
 */
export async function copyIntoDestination(input: {
  source: string;
  sourceIdentity: FileIdentity;
  destination: CopyDestination;
  overwrite: boolean;
  tempName: string;
  signal: AbortSignal;
  onProgress?: (copied: number) => void;
  /** Called once the temp file exists, with its path. */
  onTempCreated?: (path: string) => void;
  /** Applies the host's download marking to the finished temp file. */
  mark?: (path: string) => Promise<void>;
}): Promise<{ path: string; bytes: number }> {
  const { destination, signal } = input;
  signal.throwIfAborted();
  if (!isCopyTempName(input.tempName))
    throw new CopyError('file_not_eligible', NOT_ELIGIBLE);
  const source = await open(
    input.source,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((): never => {
    throw new CopyError('file_not_eligible', SOURCE_CHANGED);
  });
  let tempIdentity: FileIdentity | undefined;
  let tempPath: string | undefined;
  try {
    const sourceStat = await source.stat();
    if (!sourceStat.isFile() || !same(sourceStat, input.sourceIdentity))
      throw new CopyError('file_not_eligible', SOURCE_CHANGED);
    const { folder, identity } = createFolders(destination);
    tempPath = join(folder, input.tempName);
    const target = await open(
      tempPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o666,
    );
    let bytes = 0;
    try {
      const created = await target.stat();
      tempIdentity = { dev: created.dev, ino: created.ino };
      // The open followed the folder's path. Before any byte is written, the
      // open file must be the one at that name in the checked folder: a folder
      // swapped for a link before the open would put it somewhere else.
      checkFolder(folder, identity, destination.containmentRoot);
      const opened = lstatSync(tempPath);
      if (!opened.isFile() || !same(opened, tempIdentity))
        throw new CopyError('file_not_eligible', NOT_ELIGIBLE);
      checkFolder(folder, identity, destination.containmentRoot);
      input.onTempCreated?.(tempPath);
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        await writeAll(target, buffer, bytesRead);
        bytes += bytesRead;
        input.onProgress?.(bytes);
      }
      signal.throwIfAborted();
      await target.sync();
      if (bytes !== sourceStat.size || (await target.stat()).size !== bytes)
        throw new CopyError('copy_failed', 'The copy is incomplete.');
    } finally {
      await target.close();
    }
    if (input.mark) {
      const marking = tempPath;
      await input.mark(marking).catch((): never => {
        throw new CopyError('copy_failed', NOT_MARKED);
      });
    }
    // The folder and the temp file must still be the ones written.
    checkFolder(folder, identity, destination.containmentRoot);
    const temp = lstatSync(tempPath);
    if (!temp.isFile() || !same(temp, tempIdentity))
      throw new CopyError('file_not_eligible', NOT_ELIGIBLE);
    signal.throwIfAborted();
    // A link or rename by absolute paths looks up its two names one after the
    // other, so the commit runs where both resolve in the checked folder.
    const bound = await bindFolder(folder);
    let outcome: CommitOutcome;
    try {
      if (!same(bound.identity, identity))
        throw new CopyError('file_not_eligible', NOT_ELIGIBLE);
      signal.throwIfAborted();
      outcome = await bound.commit({
        tempName: input.tempName,
        temp: tempIdentity,
        name: destination.name,
        overwrite: input.overwrite,
      });
    } finally {
      bound.close();
    }
    committed(outcome, input.overwrite);
    tempPath = undefined;
    return { path: join(folder, destination.name), bytes };
  } catch (error) {
    if (tempPath && tempIdentity) removeIfSame(tempPath, tempIdentity);
    if (error instanceof CopyError || signal.aborted) throw error;
    throw new CopyError(
      errorCode(error) === 'ENOSPC' ? 'disk_full' : 'copy_failed',
      errorCode(error) === 'ENOSPC'
        ? 'Not enough disk space.'
        : 'The copy failed.',
    );
  } finally {
    await source.close();
  }
}
