import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import {
  classifyFileContentKind,
  fileImageMediaType,
  type WorkerFilesystemFileContentKind,
  type WorkerFilesystemFileReadResult,
} from '@canopy/protocol/canopy-core';
import { isSafePortableRelativePath } from '@canopy/protocol/safe-relative-path';
import { CanopyOperationError } from '../../runtime/errors';
import type { FilesystemRoot } from './root-catalog';

export { classifyFileContentKind };

export type FilesystemFileReadFailure =
  | 'notFound'
  | 'outsideRoots'
  | 'notRegularFile'
  | 'invalidState'
  | 'tooLarge';

// The desktop reader's messages, kept so its IPC projection reads the same.
const FAILURES: Readonly<
  Record<
    FilesystemFileReadFailure,
    { kind: CanopyOperationError['payload']['kind']; message: string }
  >
> = {
  notFound: { kind: 'not_found', message: 'The file does not exist.' },
  outsideRoots: {
    kind: 'not_found',
    message: 'Cannot read file outside the target project roots',
  },
  notRegularFile: {
    kind: 'failed_precondition',
    message: 'Cannot read a path that is not a regular file',
  },
  invalidState: {
    kind: 'failed_precondition',
    message: 'Cannot read a file that changed while being validated',
  },
  tooLarge: {
    kind: 'resource_exhausted',
    message: 'The file preview is too large to return over this connection.',
  },
};

/**
 * A typed `worker.filesystem.file.*` failure. Its runtime cause is the
 * original error, or an error carrying the same message, so an in-process
 * projection can rethrow the text its callers already handle.
 */
export function filesystemFileReadError(
  reason: FilesystemFileReadFailure,
  runtimeCause?: unknown,
): CanopyOperationError {
  const failure = FAILURES[reason];
  return new CanopyOperationError(
    {
      kind: failure.kind,
      code: `worker.filesystem.file.${reason}`,
      message: failure.message,
      retry: { kind: 'never' },
    },
    runtimeCause ?? new Error(failure.message),
  );
}

/** Test seam for the filesystem calls whose ordering the read depends on. */
export interface FilesystemFileReadIo {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

const NODE_IO: FilesystemFileReadIo = {
  realpath: (path) => realpath(path),
  lstat: (path) => lstat(path),
  open: (path, flags) => open(path, flags),
};

export interface FilesystemFileReadInput {
  /** Every root of the scope: the resolved file may lie in any of them. */
  readonly roots: readonly Pick<FilesystemRoot, 'id' | 'absolutePath'>[];
  readonly fileRootId: string;
  readonly relativePath: string;
  readonly maxBytes: number;
  readonly io?: FilesystemFileReadIo;
}

export interface FilesystemFileRead {
  /** The canonical result, without a catalog revision. */
  readonly result: WorkerFilesystemFileReadResult;
  /** The verified handle's exact `mtimeMs`, for in-process projections. */
  readonly modifiedAtMs: number;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function inside(path: string, root: string): boolean {
  return (
    path === root ||
    path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  );
}

/** A missing path is `notFound`; any other failure keeps its cause. */
function readFailure(error: unknown): unknown {
  if (error instanceof CanopyOperationError) return error;
  return isMissing(error) ? filesystemFileReadError('notFound', error) : error;
}

async function resolveRoots(
  roots: FilesystemFileReadInput['roots'],
  io: FilesystemFileReadIo,
): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      resolved.push(await io.realpath(root.absolutePath));
    } catch {
      // A missing optional root contains nothing.
    }
  }
  return resolved;
}

/**
 * Non-blocking, identity-checked open of a regular file inside any of the
 * resolved roots (`openRegularFileForRead` semantics). The caller closes the
 * returned handle.
 *
 * No network/device-path refusal: the path is a trusted root plus a safe
 * relative path, and a root on a UNC share keeps reading as it always did.
 */
async function openContainedRegularFile(
  joinedPath: string,
  roots: FilesystemFileReadInput['roots'],
  io: FilesystemFileReadIo,
): Promise<{ canonical: string; handle: FileHandle; stats: Stats }> {
  const canonical = await io.realpath(joinedPath);
  const resolvedRoots = await resolveRoots(roots, io);
  const containing = resolvedRoots.find((root) => inside(canonical, root));
  if (containing === undefined) throw filesystemFileReadError('outsideRoots');
  const pathStats = await io.lstat(canonical);
  if (!pathStats.isFile()) throw filesystemFileReadError('notRegularFile');
  // O_NONBLOCK is undefined on Windows, where the OR leaves O_RDONLY.
  const handle = await io.open(
    canonical,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw filesystemFileReadError('notRegularFile');
    if (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino)
      throw filesystemFileReadError('invalidState');
    const resolvedAgain = await io.realpath(canonical);
    if (resolvedAgain !== canonical || !inside(resolvedAgain, containing))
      throw filesystemFileReadError('invalidState');
    const currentStats = await io.lstat(resolvedAgain);
    if (
      !currentStats.isFile() ||
      currentStats.dev !== stats.dev ||
      currentStats.ino !== stats.ino
    )
      throw filesystemFileReadError('invalidState');
    return { canonical, handle, stats };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Reads from the start of the handle until `limit` bytes or end of file. The
 * first read covers the `fstat` size, so a stable file takes one read.
 */
async function readFromStart(
  handle: FileHandle,
  limit: number,
  sizeHint: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const chunk = Buffer.allocUnsafe(
      Math.min(limit - total, Math.max(64 * 1024, sizeHint + 1 - total)),
    );
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

type FileContentPart =
  | {
      contentKind: 'image';
      encoding: 'base64';
      content: string;
      mediaType: string;
      returnedBytes: number;
      truncated: false;
    }
  | {
      contentKind: Exclude<WorkerFilesystemFileContentKind, 'image'>;
      encoding: 'utf8';
      content: string;
      returnedBytes: number;
      truncated: boolean;
    };

const UNSUPPORTED_CONTENT: FileContentPart = {
  contentKind: 'unsupported',
  encoding: 'utf8',
  content: '',
  returnedBytes: 0,
  truncated: false,
};

/** Classifies the verified file by its resolved name and reads its content. */
async function readContentPart(
  handle: FileHandle,
  name: string,
  size: number,
  maxBytes: number,
): Promise<FileContentPart> {
  const contentKind = classifyFileContentKind(name);
  if (contentKind === 'unsupported') return UNSUPPORTED_CONTENT;
  const mediaType = fileImageMediaType(name);
  if (mediaType !== undefined) {
    if (size > maxBytes) return UNSUPPORTED_CONTENT;
    const bytes = await readFromStart(handle, maxBytes + 1, size);
    // A file that grew past the cap after its stat is still too large.
    if (bytes.length > maxBytes) return UNSUPPORTED_CONTENT;
    return {
      contentKind: 'image',
      encoding: 'base64',
      content: bytes.toString('base64'),
      mediaType,
      returnedBytes: bytes.length,
      truncated: false,
    };
  }
  // Every image extension has a media type, so only text kinds reach here.
  const textKind = contentKind === 'image' ? 'text' : contentKind;
  const bytes = await readFromStart(handle, maxBytes, size);
  // A NUL byte marks a binary file; an empty read of a non-empty file is
  // treated the same way, as the desktop reader always did.
  const binary = bytes.includes(0);
  const content = binary ? '' : bytes.toString('utf8');
  if (content === '' && size > 0) return UNSUPPORTED_CONTENT;
  return {
    contentKind: textKind,
    encoding: 'utf8',
    content,
    returnedBytes: binary ? 0 : bytes.length,
    truncated: size > maxBytes,
  };
}

/**
 * Reads one contained regular file as `worker.filesystem.file.read`
 * specifies: classification by the resolved name, bounded content, size,
 * truncation, timestamp and version.
 */
export async function readFilesystemFile(
  input: FilesystemFileReadInput,
): Promise<FilesystemFileRead> {
  const io = input.io ?? NODE_IO;
  const { relativePath, maxBytes } = input;
  if (!isSafePortableRelativePath(relativePath) || relativePath.includes('\0'))
    throw filesystemFileReadError('outsideRoots');
  const root = input.roots.find((entry) => entry.id === input.fileRootId);
  if (!root) throw filesystemFileReadError('notFound');
  let opened: Awaited<ReturnType<typeof openContainedRegularFile>>;
  try {
    opened = await openContainedRegularFile(
      join(root.absolutePath, ...relativePath.split('/')),
      input.roots,
      io,
    );
  } catch (error) {
    throw readFailure(error);
  }
  const { canonical, handle, stats } = opened;
  try {
    const name = basename(canonical);
    const part = await readContentPart(handle, name, stats.size, maxBytes);
    return {
      result: {
        fileRootId: input.fileRootId,
        relativePath,
        name,
        sizeBytes: stats.size,
        modifiedAt: new Date(stats.mtimeMs).toISOString(),
        version: `${stats.size}:${Math.round(stats.mtimeMs)}`,
        ...part,
      },
      modifiedAtMs: stats.mtimeMs,
    };
  } catch (error) {
    throw readFailure(error);
  } finally {
    await handle.close();
  }
}

/** The JSON-encoded size of a result, for a framed binding's budget. */
export function encodedFileReadResultBytes(
  result: WorkerFilesystemFileReadResult,
): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}
