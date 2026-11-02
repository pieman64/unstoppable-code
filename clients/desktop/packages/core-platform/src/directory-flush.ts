import { closeSync, fsyncSync, openSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { hostOperatingSystem } from './host-platform';

/**
 * What a Windows directory flush proves (CAN-5151 D1). Windows opens the
 * directory read-write (`r+`), as `FlushFileBuffers` refuses a read-only
 * handle, and Microsoft does not document that the flush orders or persists
 * the directory's entries.
 */
export const WINDOWS_DIRECTORY_FLUSH_LABEL =
  'API-level flush; namespace ordering undocumented; power-loss unverified';

export type DirectoryFlushStage = 'open' | 'flush' | 'close';

/**
 * A failed directory flush; never a silent no-op. `code` keeps the errno and
 * the message keeps the cause's, as the raw error did before this wrapper.
 */
export class DirectoryFlushError extends Error {
  public readonly code: string;
  public readonly stage: DirectoryFlushStage;
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare public readonly cause: unknown;

  public constructor(stage: DirectoryFlushStage, cause: unknown) {
    const code = errnoCode(cause) ?? 'EUNKNOWN';
    super(`Directory ${stage} failed: ${causeMessage(cause) ?? code}`);
    this.name = 'DirectoryFlushError';
    this.code = code;
    this.stage = stage;
    this.cause = cause;
  }
}

export interface DirectoryFlushHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

function stringField(error: unknown, field: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value: unknown = Reflect.get(error, field);
  return typeof value === 'string' ? value : undefined;
}

const errnoCode = (error: unknown): string | undefined =>
  stringField(error, 'code');
// Read by field: errors from another realm (Node's, under Jest) fail `instanceof`.
const causeMessage = (error: unknown): string | undefined =>
  stringField(error, 'message');

const windowsHost = (os: PlatformOperatingSystem | null): boolean =>
  os === 'win32';

/** The open flags for a directory flush on `os`. */
export function directoryFlushOpenFlags(
  os: PlatformOperatingSystem | null,
): 'r' | 'r+' {
  return windowsHost(os) ? 'r+' : 'r';
}

/** Opens `directoryPath` so `sync()` flushes it on `os`. */
export function openDirectoryForFlush(
  directoryPath: string,
  os: PlatformOperatingSystem | null = hostOperatingSystem(),
): Promise<DirectoryFlushHandle> {
  return open(directoryPath, directoryFlushOpenFlags(os));
}

/**
 * Flushes a directory so entries created, renamed or removed in it persist.
 * POSIX `fsync`s it; Windows flushes it with {@link WINDOWS_DIRECTORY_FLUSH_LABEL}.
 * Any open, flush or close error rejects with {@link DirectoryFlushError}.
 */
export async function flushDirectory(
  directoryPath: string,
  options: {
    readonly os?: PlatformOperatingSystem | null;
    readonly openDirectory?: (path: string) => Promise<DirectoryFlushHandle>;
  } = {},
): Promise<'flushed'> {
  const os = options.os === undefined ? hostOperatingSystem() : options.os;
  let handle: DirectoryFlushHandle;
  try {
    handle = await (options.openDirectory
      ? options.openDirectory(directoryPath)
      : openDirectoryForFlush(directoryPath, os));
  } catch (error) {
    throw new DirectoryFlushError('open', error);
  }
  try {
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw new DirectoryFlushError('flush', error);
  }
  try {
    await handle.close();
  } catch (error) {
    throw new DirectoryFlushError('close', error);
  }
  return 'flushed';
}

/** Synchronous {@link flushDirectory}; blocks the calling thread. */
export function flushDirectorySync(
  directoryPath: string,
  options: { readonly os?: PlatformOperatingSystem | null } = {},
): 'flushed' {
  const os = options.os === undefined ? hostOperatingSystem() : options.os;
  let fd: number;
  try {
    fd = openSync(directoryPath, directoryFlushOpenFlags(os));
  } catch (error) {
    throw new DirectoryFlushError('open', error);
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // The flush error is the failure to report.
    }
    throw new DirectoryFlushError('flush', error);
  }
  try {
    closeSync(fd);
  } catch (error) {
    throw new DirectoryFlushError('close', error);
  }
  return 'flushed';
}
