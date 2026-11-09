import { createHash } from 'node:crypto';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { open, rm, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import type { BrowserTransferErrorCode } from '@canopy/execution-engine/types/browser';

/**
 * Files an agent names for `browser.upload_files`: checked to be inside the
 * task's workspace, then staged as private copies whose bytes are hashed, so
 * an approval covers exactly what reaches the page. Node can only clone a
 * file by its path, which a folder swapped after the check could redirect, so
 * staging streams from a handle checked to be the file that passed.
 */

interface FileIdentity {
  dev: number;
  ino: number;
}

export interface UploadSource {
  /** Where the file comes from, for diagnostics. */
  kind: 'workspace' | 'download' | 'attachment';
  /** The name the page sees. */
  name: string;
  /**
   * Workspace-relative path of the file itself, after links: what the card
   * shows and what approval rules match.
   */
  displayPath: string;
  /** The path as asked for, when a link inside the workspace makes it differ. */
  requestedPath?: string;
  /** Real path of the file to read. */
  path: string;
  identity: FileIdentity;
  sizeBytes: number;
}

export type UploadSourceResult =
  | { ok: true; source: UploadSource }
  | { ok: false; error: { code: 'file_not_eligible'; message: string } };

export class UploadError extends Error {
  constructor(
    readonly code: BrowserTransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

const OUTSIDE = 'Upload a file inside the workspace, by its workspace path.';
const NOT_A_FILE = "That isn't a file in the workspace.";
const GIT = "Files in a .git folder can't be uploaded.";
export const SOURCE_CHANGED = 'The file changed. Try the upload again.';
const WINDOWS = "Uploading workspace files isn't available on Windows yet.";

// Opens refuse a link anywhere in the path on macOS (O_NOFOLLOW_ANY, which
// can't be combined with O_NOFOLLOW), and in the last name elsewhere, where
// Linux then checks the open file's own path. Windows can't check the open
// file, so it refuses workspace files and stages only task downloads, which
// live in app data. O_NONBLOCK keeps a named pipe from blocking the open.
const O_NOFOLLOW_ANY = 0x20000000;
const READ_FLAGS =
  constants.O_RDONLY |
  constants.O_NONBLOCK |
  (hostOperatingSystem() === 'darwin' ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW);
/** Staged copies live in app data, whose path may hold a link (`/var` on macOS). */
const STAGED_READ_FLAGS =
  constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/** Whether an open file is the one at `path`, where the platform can tell. */
function openedAt(fd: number, path: string): boolean {
  return (
    hostOperatingSystem() !== 'linux' ||
    readlinkSync(`/proc/self/fd/${fd}`) === path
  );
}

function refused(message: string): UploadSourceResult {
  return { ok: false, error: { code: 'file_not_eligible', message } };
}
function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child !== '' &&
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}
function underGit(root: string, path: string): boolean {
  return relative(root, path)
    .split(sep)
    .some((segment) => segment.toLowerCase() === '.git');
}

/**
 * Resolves a workspace-relative path to a regular file whose real path is
 * inside the workspace's real path and not under any `.git` folder. A link is
 * followed only while it stays inside.
 */
export function workspaceUploadSource(
  root: string,
  relativePath: string,
): UploadSourceResult {
  // shortcut: no handle-based containment check on Windows; add one
  // (GetFinalPathNameByHandle) when Windows uploads are verified.
  if (hostOperatingSystem() === 'win32') return refused(WINDOWS);
  if (
    typeof relativePath !== 'string' ||
    relativePath.trim() === '' ||
    relativePath.includes('\0') ||
    isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath)
  )
    return refused(OUTSIDE);
  try {
    const rootReal = realpathSync(root);
    const requested = resolve(rootReal, relativePath);
    if (!inside(rootReal, requested)) return refused(OUTSIDE);
    if (underGit(rootReal, requested)) return refused(GIT);
    const path = realpathSync(requested);
    if (!inside(rootReal, path)) return refused(OUTSIDE);
    if (underGit(rootReal, path)) return refused(GIT);
    // The file opened must be the one at the checked path, with no link in
    // it, so a folder swapped after the path resolved cannot hand over a file
    // from outside. Staging opens it the same way.
    const fd = openSync(path, READ_FLAGS);
    let opened: Stats;
    let at: boolean;
    try {
      opened = fstatSync(fd);
      at = openedAt(fd, path);
    } finally {
      closeSync(fd);
    }
    const now = lstatSync(path);
    if (
      !opened.isFile() ||
      !at ||
      realpathSync(path) !== path ||
      !now.isFile() ||
      now.dev !== opened.dev ||
      now.ino !== opened.ino
    )
      return refused(NOT_A_FILE);
    const displayPath = relative(rootReal, path).split(sep).join('/');
    const requestedPath = relative(rootReal, requested).split(sep).join('/');
    return {
      ok: true,
      source: {
        kind: 'workspace',
        name: basename(requested),
        displayPath,
        ...(requestedPath !== displayPath ? { requestedPath } : {}),
        path,
        identity: { dev: opened.dev, ino: opened.ino },
        sizeBytes: opened.size,
      },
    };
  } catch {
    return refused(NOT_A_FILE);
  }
}

const NOT_ATTACHED = "That isn't a file the user attached to this chat.";

/**
 * Resolves a file the user attached to the calling chat, named by its file
 * name in the chat's attachments folder. The chat's own messages must name
 * it (`referenced`), so another chat's attachment is refused, and the name
 * must be a regular file there, not a link.
 */
export function attachmentUploadSource(
  folder: string,
  attachmentId: string,
  referenced: readonly string[],
): UploadSourceResult {
  if (
    typeof attachmentId !== 'string' ||
    attachmentId.trim() === '' ||
    attachmentId.includes('\0') ||
    attachmentId === '.' ||
    attachmentId === '..' ||
    basename(attachmentId) !== attachmentId ||
    win32.basename(attachmentId) !== attachmentId
  )
    return refused(NOT_ATTACHED);
  const requested = resolve(folder, attachmentId);
  if (!referenced.some((path) => resolve(path) === requested))
    return refused(NOT_ATTACHED);
  try {
    const path = resolve(realpathSync(folder), attachmentId);
    const fd = openSync(path, READ_FLAGS);
    let opened: Stats;
    let at: boolean;
    try {
      opened = fstatSync(fd);
      at = openedAt(fd, path);
    } finally {
      closeSync(fd);
    }
    const now = lstatSync(path);
    if (
      !opened.isFile() ||
      !at ||
      realpathSync(path) !== path ||
      !now.isFile() ||
      now.dev !== opened.dev ||
      now.ino !== opened.ino
    )
      return refused(NOT_ATTACHED);
    return {
      ok: true,
      source: {
        kind: 'attachment',
        name: attachmentId,
        displayPath: `${attachmentId} (attached to this chat)`,
        path,
        identity: { dev: opened.dev, ino: opened.ino },
        sizeBytes: opened.size,
      },
    };
  } catch {
    return refused(NOT_ATTACHED);
  }
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
    if (bytesWritten <= 0) throw new Error('Staging stopped');
    written += bytesWritten;
  }
}

/** Streams an open file through SHA-256. */
async function hashOpenFile(file: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) return hash.digest('hex');
    hash.update(buffer.subarray(0, bytesRead));
  }
}

/**
 * Copies the checked source to `destination`, created exclusively, hashing
 * the bytes it writes. The copy is read-only once complete and removed on any
 * failure or cancel. The hash and size describe the staged bytes, whatever
 * the source does meanwhile.
 */
export async function stageUploadFile(input: {
  source: UploadSource;
  destination: string;
  signal: AbortSignal;
  onProgress?: (bytes: number) => void;
}): Promise<{ sha256: string; sizeBytes: number }> {
  input.signal.throwIfAborted();
  const source = await open(input.source.path, READ_FLAGS).catch((): never => {
    throw new UploadError('file_not_eligible', SOURCE_CHANGED);
  });
  let created = false;
  try {
    const opened = await source.stat();
    if (
      !opened.isFile() ||
      !openedAt(source.fd, input.source.path) ||
      opened.dev !== input.source.identity.dev ||
      opened.ino !== input.source.identity.ino
    )
      throw new UploadError('file_not_eligible', SOURCE_CHANGED);
    const target = await open(
      input.destination,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        input.signal.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        await writeAll(target, buffer, bytesRead);
        bytes += bytesRead;
        input.onProgress?.(bytes);
      }
      input.signal.throwIfAborted();
      await target.sync();
      await target.chmod(0o400);
    } finally {
      await target.close();
    }
    return { sha256: hash.digest('hex'), sizeBytes: bytes };
  } catch (error) {
    if (created) await rm(input.destination, { force: true });
    throw error;
  } finally {
    await source.close();
  }
}

/** Whether a staged file still holds exactly the approved bytes. */
export async function stagedFileMatches(
  path: string,
  expected: { sha256: string; sizeBytes: number },
): Promise<boolean> {
  let file: FileHandle;
  try {
    file = await open(path, STAGED_READ_FLAGS);
  } catch {
    return false;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== expected.sizeBytes) return false;
    return (await hashOpenFile(file)) === expected.sha256;
  } catch {
    return false;
  } finally {
    await file.close();
  }
}
