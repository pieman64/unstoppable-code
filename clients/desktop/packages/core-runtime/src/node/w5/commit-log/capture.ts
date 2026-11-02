import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import type { W5CommitLog } from './commit-log';
import { W5CommitRefusedError } from './errors';
import { isRecord } from './is-record';
import {
  W5_CAPTURE_LIMITS,
  freezeW5Capture,
  isW5CaptureWorkspaceId,
  w5CaptureFileComponents,
  type W5CaptureFile,
  type W5CaptureRequest,
  type W5CaptureResult,
  type W5ConfinedFileRead,
  type W5ConfinedFileReader,
  type W5ConfinedFileReaderSource,
  type W5FileImage,
} from './capture-contract';

// Darwin's atomic whole-path no-follow flag cannot be combined with O_NOFOLLOW.
const O_NOFOLLOW_ANY = 0x20000000;

type CaptureReader =
  | { readonly platform: 'darwin' | 'linux' }
  | { readonly platform: 'win32'; readonly confined: W5ConfinedFileReader };

function captureLimit(): never {
  throw new W5CommitRefusedError(
    'invalid-state',
    'The W5 capture exceeds its limits.',
    { capture: 'limit-exceeded' },
  );
}

// Typed, so the host keeps its worker: nothing was read or committed. Either
// refusal fails the whole query closed, before any log evidence is read.
function rootUnavailable(message: string, code?: string): W5CommitRefusedError {
  return new W5CommitRefusedError('invalid-state', message, {
    capture: 'root-unavailable',
    ...(code !== undefined && { code }),
  });
}

function rootChanged(): W5CommitRefusedError {
  return new W5CommitRefusedError(
    'invalid-state',
    'The W5 data root no longer resolves to its anchored path.',
    { capture: 'root-changed' },
  );
}

function captureFilePath(root: string, file: W5CaptureFile): string {
  return join(root, ...w5CaptureFileComponents(file));
}

/** Refuses before any capture file or log evidence is read. */
function captureReader(
  platform: NodeJS.Platform | null,
  confined: W5ConfinedFileReaderSource | undefined,
): CaptureReader {
  if (platform === 'darwin' || platform === 'linux') return { platform };
  if (platform === 'win32') {
    let reader: W5ConfinedFileReader | null = null;
    try {
      reader = confined?.() ?? null;
    } catch {
      reader = null;
    }
    // Never a pathname-only fallback: path checks cannot stop ancestor swaps.
    if (reader) return { platform, confined: reader };
    throw new W5CommitRefusedError(
      'invalid-state',
      'W5 capture requires platform handle confinement.',
      { capture: 'confinement-unavailable' },
    );
  }
  throw new W5CommitRefusedError(
    'invalid-state',
    'W5 capture requires platform handle confinement.',
    { capture: 'unsupported-platform' },
  );
}

/** Windows: the host reader holds every check; bytes come only from its handles. */
async function readConfinedImage(
  reader: W5ConfinedFileReader,
  root: string,
  file: W5CaptureFile,
  remaining: number,
): Promise<W5FileImage> {
  let read: W5ConfinedFileRead;
  try {
    read = await reader.read(root, w5CaptureFileComponents(file), remaining);
  } catch {
    return { ...file, state: 'unreadable', reason: 'io' };
  }
  switch (read.state) {
    case 'present':
      if (read.bytes.byteLength > remaining) captureLimit();
      return {
        ...file,
        state: 'present',
        base64: Buffer.from(
          read.bytes.buffer,
          read.bytes.byteOffset,
          read.bytes.byteLength,
        ).toString('base64'),
      };
    case 'too-large':
      return captureLimit();
    case 'absent':
      return { ...file, state: 'absent' };
    case 'unreadable':
      return { ...file, state: 'unreadable', reason: read.reason };
    // The root moved or vanished after it was resolved: not one file's image.
    case 'root-unavailable':
      throw rootUnavailable('The W5 data root could not be opened.');
    case 'root-changed':
      throw rootChanged();
  }
}

async function readImage(
  root: string,
  file: W5CaptureFile,
  remaining: number,
  platform: 'darwin' | 'linux',
): Promise<W5FileImage> {
  const path = captureFilePath(root, file);
  let acquired = false;
  try {
    const parent = dirname(path);
    // Reject even in-root directory aliases, as well as final-component links.
    if (
      parent !== root &&
      ((await lstat(parent)).isSymbolicLink() ||
        (await realpath(parent)) !== parent)
    )
      return { ...file, state: 'unreadable', reason: 'unsafe-path' };
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      return { ...file, state: 'unreadable', reason: 'unsafe-path' };
    if (!stat.isFile())
      return { ...file, state: 'unreadable', reason: 'not-file' };
    const handle = await open(
      path,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        (platform === 'darwin' ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW),
    );
    acquired = true;
    const readOpenedImage = async (): Promise<W5FileImage> => {
      const opened = await handle.stat();
      if (!opened.isFile())
        return { ...file, state: 'unreadable', reason: 'not-file' };
      // Inspect the opened descriptor, not a pathname an ancestor swap can restore.
      // No procfs (or a deleted/renamed file) fails closed before reading bytes.
      if (
        platform === 'linux' &&
        (await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null)) !==
          path
      )
        return { ...file, state: 'unreadable', reason: 'unsafe-path' };
      const current = await lstat(path);
      if (
        current.isSymbolicLink() ||
        (await realpath(path)) !== path ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      )
        return { ...file, state: 'unreadable', reason: 'unsafe-path' };
      if (opened.size > remaining) captureLimit();
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, remaining - size + 1));
        const { bytesRead } = await handle.read(chunk);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > remaining) captureLimit();
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return {
        ...file,
        state: 'present',
        base64: Buffer.concat(chunks).toString('base64'),
      };
    };
    const outcome:
      | { kind: 'success'; image: W5FileImage }
      | { kind: 'failure'; error: unknown } = await readOpenedImage().then(
      (image) => ({ kind: 'success', image }),
      (error: unknown) => ({ kind: 'failure', error }),
    );
    try {
      await handle.close();
    } catch (closeError) {
      if (outcome.kind === 'success') throw closeError;
    }
    if (outcome.kind === 'failure') throw outcome.error;
    return outcome.image;
  } catch (error) {
    if (error instanceof W5CommitRefusedError) throw error;
    if (isRecord(error) && error.code === 'ELOOP')
      return { ...file, state: 'unreadable', reason: 'unsafe-path' };
    // Descriptor/revalidation failures are not evidence that a file was absent.
    return !acquired && isRecord(error) && error.code === 'ENOENT'
      ? { ...file, state: 'absent' }
      : { ...file, state: 'unreadable', reason: 'io' };
  }
}

/** Read-only after worker readiness. Never calls recovery or receipt admission. */
export async function captureW5Files(
  log: W5CommitLog,
  trustedRoot: string,
  request: W5CaptureRequest,
  platform: NodeJS.Platform | null,
  /** Windows handle confinement (CAN-5202); without it Windows refuses. */
  confined?: W5ConfinedFileReaderSource,
  /**
   * Windows: the trusted root's realpath, resolved once by the host before
   * any capture (`W5CommitLogWorkerData.captureRoot`). Unused elsewhere.
   */
  anchoredRoot?: string,
): Promise<W5CaptureResult> {
  const reader = captureReader(platform, confined);
  const resolved = resolve(trustedRoot);
  let root: string;
  try {
    root = await realpath(resolved);
  } catch (error) {
    // A root mid-swap or removed fails the query's reads closed.
    throw rootUnavailable(
      'The W5 data root could not be resolved.',
      isRecord(error) && typeof error.code === 'string'
        ? error.code
        : undefined,
    );
  }
  // An ancestor swapped for a junction redirects realpath too, so Windows
  // confines reads to the root the host anchored before any capture. A
  // stable alias (junction, 8.3 name, case) resolves to it; a later swap does
  // not, and fails the query's reads closed. A swap after this check is the
  // reader's `root-changed` or `root-unavailable`, which refuses the same way.
  if (reader.platform === 'win32') {
    if (anchoredRoot === undefined)
      throw rootUnavailable(
        'The W5 data root was not anchored before capture.',
      );
    if (root !== anchoredRoot) throw rootChanged();
  }
  const requested = new Map<string, W5CaptureFile>();
  const add = (file: W5CaptureFile): void => {
    requested.set(captureFilePath(root, file), { ...file });
    if (requested.size > W5_CAPTURE_LIMITS.files) captureLimit();
  };
  if (request.discoverWorkspaces) add({ kind: 'index' });
  for (const file of request.files) add(file);
  const images: W5FileImage[] = [];
  let bytes = 0;
  let discovery: W5CaptureResult['discovery'] = request.discoverWorkspaces
    ? 'unavailable'
    : 'not-requested';
  // Map iteration includes dependencies added from the captured index image.
  const pending = requested.values();
  for (let next = pending.next(); !next.done; next = pending.next()) {
    const file = next.value;
    const remaining = W5_CAPTURE_LIMITS.bytes - bytes;
    const image =
      reader.platform === 'win32'
        ? await readConfinedImage(reader.confined, root, file, remaining)
        : await readImage(root, file, remaining, reader.platform);
    images.push(image);
    if (image.state === 'present')
      bytes += Buffer.byteLength(image.base64, 'base64');
    if (
      file.kind !== 'index' ||
      !request.discoverWorkspaces ||
      image.state !== 'present'
    )
      continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.from(image.base64, 'base64'),
        ),
      );
    } catch {
      discovery = 'invalid-index';
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.workspaces)) {
      discovery = 'invalid-index';
      continue;
    }
    discovery = 'complete';
    for (const entry of parsed.workspaces) {
      if (!isRecord(entry) || !isW5CaptureWorkspaceId(entry.id)) {
        discovery = 'invalid-index';
        continue;
      }
      add({ kind: 'manifest', workspaceId: entry.id });
      add({ kind: 'worktrees', workspaceId: entry.id });
    }
  }
  const result: W5CaptureResult = {
    files: images,
    discovery,
    log: log.captureEvidence(
      Array.from(requested.values()).map((file) => ({
        file,
        path: captureFilePath(resolved, file),
      })),
    ),
  };
  if (
    Buffer.byteLength(JSON.stringify(result)) > W5_CAPTURE_LIMITS.responseBytes
  )
    captureLimit();
  return freezeW5Capture(result);
}
