import { basename } from 'node:path';
import { safeFileName, type RemoteUploadStore } from '../host/uploads';
import {
  REMOTE_FILE_OPEN_MAX_BYTES,
  REMOTE_FILE_READ_CHUNK_BYTES,
  REMOTE_FILE_TOO_LARGE_CODE,
  RemoteFileTargetSchema,
  type FileReadParams,
  type FileReadResult,
  type RemoteFileTarget,
} from '../remote-protocol';
import { RpcRemoteError } from '../transport/rpc-peer';

/**
 * Opening a file from a window that shows another computer happens on this
 * computer: the file is copied here first. A copy came from another machine,
 * so types that run programs when opened are refused, as a browser warns
 * about such downloads.
 */
const EXTENSIONS_THAT_RUN_PROGRAMS = new Set([
  // macOS
  'app',
  'action',
  'applescript',
  'command',
  'dmg',
  'fileloc',
  'inetloc',
  'kext',
  'mpkg',
  'osax',
  'pkg',
  'prefpane',
  'scpt',
  'scptd',
  'terminal',
  'tool',
  'webloc',
  'workflow',
  // Windows
  'appref-ms',
  'application',
  'appx',
  'appxbundle',
  'bat',
  'chm',
  'cmd',
  'com',
  'cpl',
  'diagcab',
  'exe',
  'gadget',
  'hta',
  'inf',
  'js',
  'jse',
  'library-ms',
  'lnk',
  'msc',
  'msi',
  'msix',
  'msixbundle',
  'msp',
  'mst',
  'pif',
  'ps1',
  'ps1xml',
  'psc1',
  'psd1',
  'psm1',
  'reg',
  'scf',
  'scr',
  'sct',
  'settingcontent-ms',
  'url',
  'vb',
  'vbe',
  'vbs',
  'ws',
  'wsc',
  'wsf',
  'wsh',
  // Scripts and archives an installed runtime executes when opened.
  'bash',
  'csh',
  'jar',
  'jnlp',
  'ksh',
  'pl',
  'py',
  'pyc',
  'pyw',
  'pyz',
  'rb',
  'sh',
  'zsh',
]);

const RASTER_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

const DATA_URL_PATTERN =
  /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/;
const MAX_STEM_LENGTH = 100;

export interface RemoteFileCopyOptions {
  deviceId: string;
  target: RemoteFileTarget;
  read: (params: FileReadParams) => Promise<FileReadResult>;
  store: RemoteUploadStore;
  maxBytes?: number;
  chunkBytes?: number;
}

export interface RemoteImageFile {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nameOf(path: string): string {
  const name = path.split(/[\\/]/).pop();
  return name === undefined || name === '' ? path : name;
}

function tooLargeError(fileName: string, maxBytes: number): Error {
  const megabytes = Math.floor(maxBytes / (1024 * 1024));
  return new Error(
    `Couldn't open ${fileName}. Files over ${String(megabytes)} MB can't be copied from another computer.`,
  );
}

function changedError(fileName: string): Error {
  return new Error(
    `Couldn't open ${fileName} because it changed while it was being copied. Try again.`,
  );
}

/** The file a remote window's open request names. */
export function parseFileOpenTarget(
  args: ReadonlyArray<unknown>,
): RemoteFileTarget {
  const parsed = RemoteFileTargetSchema.safeParse(args[0]);
  if (!parsed.success) throw new Error('Invalid file.');
  const { absolutePath, projectId, worktreeId } = parsed.data;
  return {
    absolutePath,
    ...(projectId === undefined ? {} : { projectId }),
    ...(worktreeId === undefined ? {} : { worktreeId }),
  };
}

/**
 * The extension a file opens by: everything after the last dot, so `.exe` is
 * an `.exe`, after dropping the trailing dots and spaces Windows ignores.
 */
function openingExtension(fileName: string): string {
  const name = fileName.replace(/[. ]+$/, '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1);
}

/**
 * Whether a file named this runs a program when opened in its default app,
 * judged by its name as given and as this computer would store it.
 */
export function runsProgramsWhenOpened(fileName: string): boolean {
  const name = nameOf(fileName);
  return [name, safeFileName(name)].some((candidate) =>
    EXTENSIONS_THAT_RUN_PROGRAMS.has(openingExtension(candidate)),
  );
}

/** Fails for files this computer won't open once copied from another one. */
export function assertSafeToOpen(fileName: string): void {
  if (runsProgramsWhenOpened(fileName)) {
    throw new Error(
      `Couldn't open ${nameOf(fileName)}. Files of this type can run programs, so they aren't opened from another computer.`,
    );
  }
}

/**
 * Copies a file from the controlled computer, one part at a time so at most
 * one part is held in memory, and returns the copy's path here. The copy is
 * deleted when anything fails, including the file changing between parts.
 */
export async function copyRemoteFile(
  options: RemoteFileCopyOptions,
): Promise<string> {
  const maxBytes = options.maxBytes ?? REMOTE_FILE_OPEN_MAX_BYTES;
  const chunkBytes = options.chunkBytes ?? REMOTE_FILE_READ_CHUNK_BYTES;
  const requestedName = nameOf(options.target.absolutePath);
  assertSafeToOpen(requestedName);
  const read = async (offset: number): Promise<FileReadResult> => {
    try {
      return await options.read({
        ...options.target,
        offset,
        length: chunkBytes,
      });
    } catch (error) {
      if (
        error instanceof RpcRemoteError &&
        error.code === REMOTE_FILE_TOO_LARGE_CODE
      ) {
        throw tooLargeError(requestedName, maxBytes);
      }
      throw error;
    }
  };
  const first = await read(0);
  // Symbolic links resolve on the host, so the file's own name decides too.
  assertSafeToOpen(first.fileName);
  if (first.sizeBytes > maxBytes) throw tooLargeError(first.fileName, maxBytes);
  const file = await options.store.create(options.deviceId, first.fileName);
  try {
    // Storing can shorten a name and expose another extension.
    assertSafeToOpen(basename(file.path));
    let received = 0;
    let part = first;
    for (;;) {
      if (
        part.sizeBytes !== first.sizeBytes ||
        part.modifiedAtMs !== first.modifiedAtMs ||
        received + part.bytes.byteLength > first.sizeBytes
      ) {
        throw changedError(first.fileName);
      }
      await file.write(part.bytes);
      received += part.bytes.byteLength;
      if (received === first.sizeBytes) break;
      if (part.bytes.byteLength === 0) throw changedError(first.fileName);
      part = await read(received);
    }
    await file.close();
    return file.path;
  } catch (error) {
    await file.discard();
    throw error;
  }
}

/**
 * The raster image in a `file:read-preview` result, named with the extension
 * of its actual type; null for anything else. Hosts that predate `file.read`
 * can still send pictures this way.
 */
export function remoteImageForLocalOpen(
  preview: unknown,
): RemoteImageFile | null {
  if (
    !isRecord(preview) ||
    preview.kind !== 'image' ||
    typeof preview.content !== 'string' ||
    typeof preview.filename !== 'string'
  ) {
    return null;
  }
  const match = DATA_URL_PATTERN.exec(preview.content);
  const extension = match?.[1] ? RASTER_IMAGE_EXTENSIONS[match[1]] : undefined;
  if (!match || extension === undefined) return null;
  const stem =
    preview.filename.replace(/\.[^.]*$/, '').slice(0, MAX_STEM_LENGTH) ||
    'image';
  return {
    fileName: `${stem}.${extension}`,
    bytes: Uint8Array.from(Buffer.from(match[2] ?? '', 'base64')),
  };
}
