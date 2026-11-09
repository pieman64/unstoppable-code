import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  WORKER_FILESYSTEM_DIRECTORY_CREATE_ERROR_CODES,
  WORKER_FILESYSTEM_FILE_WRITE_ERROR_CODES,
  type CanopyOperationCode,
  type CanopyWorkspaceScope,
  type WorkerFilesystemDirectoryCreateParams,
  type WorkerFilesystemDirectoryCreateResult,
  type WorkerFilesystemFileWriteErrorCode,
  type WorkerFilesystemFileWriteParams,
  type WorkerFilesystemFileWriteResult,
} from '@canopy/protocol/canopy-core';
import type { PlatformOperatingSystem } from '../../platform/platform-services';
import {
  CanopyOperationError,
  canopyCancelledError,
} from '../../runtime/errors';
import {
  assertCreatableEntryInsideRoot,
  assertOutsideExcludedDescendantRoots,
  isPathInsideRoot,
  requireMutableRelativePath,
  resolveExistingEntryInsideRoot,
  type FilesystemEntryRoot,
} from './entry-mutation-guards';
import type { FilesystemEntryMutationHost } from './entry-mutations';

// `worker.filesystem.file.write` and `.directory.create` on the shared entry
// guards (CAN-4100). The operation specs' desktop-host sections state the
// same rules. Neither retains a keyed outcome (CAN-4733).

/** Test seams around the effect; defaults are `node:fs`. */
export interface FilesystemFileWriteIo {
  /**
   * Runs after the checks, right before the bytes or a folder change; a
   * replace re-checks its version after it.
   */
  beforeEffect?: () => Promise<void>;
  /** Windows create: exclusive publication of the staged file. */
  publishLinkEntry?: (source: string, destination: string) => Promise<void>;
}

export interface FilesystemFileWriteContext {
  host: FilesystemEntryMutationHost;
  signal?: AbortSignal;
  io?: FilesystemFileWriteIo;
}

/** The schema's content cap; a host may set a lower one. */
const DEFAULT_WRITE_LIMIT_BYTES = 16 * 1024 * 1024;

const CREATE_LABEL = 'Create target';
const WRITE_LABEL = 'Write target';

// `O_NOFOLLOW` is undefined on Windows, where it ORs to 0 and a final
// symlink is followed; containment still decides by real path. Read at call
// time: a module-scope `node:fs` read breaks importers whose jest mock omits
// `constants` (CAN-4100).
function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw canopyCancelledError();
}

type FileWriteKind = 'file' | 'directory';

function writeError(
  kind: CanopyOperationError['payload']['kind'],
  code: WorkerFilesystemFileWriteErrorCode | undefined,
  message: string,
  runtimeCause?: unknown,
  retry: CanopyOperationError['payload']['retry'] = { kind: 'never' },
): CanopyOperationError {
  return new CanopyOperationError(
    { kind, ...(code && { code }), message, retry },
    runtimeCause,
  );
}

function unsupportedOption(option: string, message: string): never {
  throw new CanopyOperationError({
    kind: 'capability_unavailable',
    message,
    details: { option },
    retry: { kind: 'never' },
  });
}

function revisionConflict(message: string): CanopyOperationError {
  return writeError(
    'conflict',
    'worker.filesystem.file.revisionConflict',
    message,
    undefined,
    { kind: 'after_refresh', resource: 'worker.filesystem.file' },
  );
}

// A switch, not a keyed map: the census reads `worker.*` keys as operations.
function translatedGuardCode(code: string | undefined): string | undefined {
  switch (code) {
    case 'worker.filesystem.entry.invalidPath':
      return 'worker.filesystem.path.invalid';
    case 'worker.filesystem.entry.outsideRoot':
      return 'worker.filesystem.path.escape';
    case 'worker.filesystem.entry.notFound':
      return 'worker.filesystem.file.notFound';
    default:
      return code;
  }
}

const DECLARED_CODES: Readonly<
  Record<FileWriteKind, readonly CanopyOperationCode[]>
> = {
  file: WORKER_FILESYSTEM_FILE_WRITE_ERROR_CODES,
  directory: WORKER_FILESYSTEM_DIRECTORY_CREATE_ERROR_CODES,
};

/**
 * A guard or host refusal under this instruction's codes; the kind, message
 * and cause stay. A code it does not declare, such as a host's `roots.*`
 * scope code, is dropped, so the dispatcher never answers "invalid error".
 */
function asWriteError(error: unknown, target: FileWriteKind): unknown {
  if (!(error instanceof CanopyOperationError)) return error;
  const translated = translatedGuardCode(error.payload.code);
  const code = DECLARED_CODES[target].find(
    (candidate) => candidate === translated,
  );
  if (code === error.payload.code) return error;
  const { kind, message, details, retry } = error.payload;
  return new CanopyOperationError(
    {
      kind,
      message,
      retry,
      ...(code !== undefined && { code }),
      ...(details !== undefined && { details }),
    },
    error.runtimeCause,
  );
}

function findRoot(
  roots: readonly FilesystemEntryRoot[],
  fileRootId: string,
): FilesystemEntryRoot {
  const root = roots.find((candidate) => candidate.fileRootId === fileRootId);
  if (!root) {
    throw writeError(
      'not_found',
      'worker.filesystem.root.notFound',
      `Unknown file root: ${fileRootId}`,
    );
  }
  return root;
}

/** `<size>:<mtimeMs>`, the version the file reader reports. */
function versionOf(stats: { size: number; mtimeMs: number }): string {
  return `${stats.size}:${Math.round(stats.mtimeMs)}`;
}

/**
 * The root-relative path a create acts on, as the engine normalizes it. The
 * explorer projection uses it to find the folder to create first. Throws the
 * engine's path refusals.
 */
export function normalizeFileCreatePath(
  relativePath: string,
  os: PlatformOperatingSystem,
): string {
  return requireMutableRelativePath(relativePath, CREATE_LABEL, os);
}

interface ResolvedTarget {
  readonly root: FilesystemEntryRoot;
  readonly rootReal: string;
  readonly relativePath: string;
  readonly targetPath: string;
}

async function resolveTarget(
  host: FilesystemEntryMutationHost,
  scope: CanopyWorkspaceScope,
  fileRootId: string,
  relativePath: string,
  label: string,
): Promise<ResolvedTarget> {
  const root = findRoot(await host.roots(scope), fileRootId);
  const normalized = requireMutableRelativePath(relativePath, label, host.os);
  const rootReal = await realpath(root.absolutePath);
  return {
    root,
    rootReal,
    relativePath: normalized,
    targetPath: join(root.absolutePath, ...normalized.split('/')),
  };
}

function refuseFileWriteOptions(
  params: WorkerFilesystemFileWriteParams,
  limitBytes: number,
): Buffer {
  if (params.executable === true)
    unsupportedOption(
      'executable',
      "This host can't set the executable bit; omit it or send false. Nothing was written.",
    );
  if (params.sourceArtifactId != null)
    unsupportedOption(
      'sourceArtifactId',
      "This host can't write from an artifact; send content. Nothing was written.",
    );
  if (params.content == null)
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'A write needs content.',
      retry: { kind: 'never' },
    });
  const bytes = Buffer.from(params.content, 'utf8');
  if (bytes.length > limitBytes)
    throw new CanopyOperationError({
      kind: 'resource_exhausted',
      message: 'The file is too large to write.',
      details: { limitBytes },
      retry: { kind: 'never' },
    });
  return bytes;
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    offset += bytesWritten;
  }
}

async function readAll(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      size - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function writeResult(
  relativePath: string,
  bytes: Buffer,
  stats: { size: number; mtimeMs: number },
): WorkerFilesystemFileWriteResult {
  return {
    relativePath,
    sizeBytes: stats.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    version: versionOf(stats),
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
  };
}

/** The tail of each file identity's queue of replaces in this process. */
const replaceQueues = new Map<string, Promise<void>>();

/**
 * Runs `replace` once every earlier replace of the same `dev:ino` settled.
 * In-process only: no OS advisory lock holds off another process.
 */
async function serializeReplace<Result>(
  identity: string,
  replace: () => Promise<Result>,
): Promise<Result> {
  const previous = replaceQueues.get(identity) ?? Promise.resolve();
  let release = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => done);
  replaceQueues.set(identity, tail);
  await previous;
  try {
    return await replace();
  } finally {
    release();
    if (replaceQueues.get(identity) === tail) replaceQueues.delete(identity);
  }
}

interface PinnedFile {
  readonly handle: FileHandle;
  /** `dev:ino` of the opened file. */
  readonly identity: string;
}

/**
 * Opens the contained file for an in-place replace and pins it: the handle
 * must be a regular file, and the path it was opened by must still resolve to
 * that same file, with no symlink on the way.
 */
async function openContainedFile(targetReal: string): Promise<PinnedFile> {
  let handle: FileHandle;
  try {
    handle = await open(targetReal, constants.O_RDWR | noFollowFlag());
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EISDIR')
      throw writeError(
        'failed_precondition',
        'worker.filesystem.file.invalidState',
        'Path is not a file.',
        error,
      );
    if (code === 'ENOENT')
      throw writeError(
        'not_found',
        'worker.filesystem.file.notFound',
        'The file does not exist.',
        error,
      );
    if (code === 'ELOOP')
      throw revisionConflict(
        'The file changed while it was being saved. Nothing was written.',
      );
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile())
      throw writeError(
        'failed_precondition',
        'worker.filesystem.file.invalidState',
        'Path is not a file.',
      );
    const identity = `${opened.dev}:${opened.ino}`;
    await assertStillPinned(targetReal, identity);
    return { handle, identity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Refuses when `targetReal` no longer resolves, link-free, to `identity`. */
async function assertStillPinned(
  targetReal: string,
  identity: string,
): Promise<void> {
  let current: { dev: bigint; ino: bigint };
  let currentReal: string;
  try {
    [current, currentReal] = await Promise.all([
      stat(targetReal, { bigint: true }),
      realpath(targetReal),
    ]);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    current = { dev: -1n, ino: -1n };
    currentReal = '';
  }
  if (
    currentReal !== targetReal ||
    `${current.dev}:${current.ino}` !== identity
  )
    throw revisionConflict(
      'The file changed while it was being saved. Nothing was written.',
    );
}

/**
 * `null` when the path still names the pinned file and it has
 * `expectedVersion`. Otherwise the result of a retry whose bytes already
 * landed, or a revision conflict.
 */
async function checkExpectedVersion(
  { handle, identity }: PinnedFile,
  targetReal: string,
  expectedVersion: string,
  bytes: Buffer,
  relativePath: string,
): Promise<WorkerFilesystemFileWriteResult | null> {
  // A rename over the path leaves the handle's stat unchanged.
  await assertStillPinned(targetReal, identity);
  const current = await handle.stat();
  if (versionOf(current) === expectedVersion) return null;
  if (
    current.size === bytes.length &&
    (await readAll(handle, current.size)).equals(bytes)
  )
    return writeResult(relativePath, bytes, current);
  throw revisionConflict(
    'The file changed since it was read. Nothing was written.',
  );
}

async function replaceFile(
  params: Extract<WorkerFilesystemFileWriteParams, { createOnly: false }>,
  bytes: Buffer,
  { host, signal, io }: FilesystemFileWriteContext,
): Promise<WorkerFilesystemFileWriteResult> {
  const target = await resolveTarget(
    host,
    params.scope,
    params.fileRootId,
    params.relativePath,
    WRITE_LABEL,
  );
  const targetReal = await resolveExistingEntryInsideRoot(
    target.targetPath,
    target.rootReal,
  );
  await assertOutsideExcludedDescendantRoots(
    target.root,
    [target.targetPath, targetReal],
    { mayContainExcludedRoot: false },
  );
  const pinned = await openContainedFile(targetReal);
  const { handle, identity } = pinned;
  const check = (): Promise<WorkerFilesystemFileWriteResult | null> =>
    checkExpectedVersion(
      pinned,
      targetReal,
      params.expectedVersion,
      bytes,
      target.relativePath,
    );
  try {
    // Serialized from the check through the write, so two saves under one
    // version can't both win here.
    return await serializeReplace(identity, async () => {
      // A retry whose bytes already landed succeeds without writing again.
      const settled = await check();
      if (settled) return settled;
      await host.beforeReplace?.(params.scope);
      await io?.beforeEffect?.();
      throwIfAborted(signal);
      // Again after the host work, for a writer outside this process; a
      // change between this stat and the write still lands unseen.
      const changed = await check();
      if (changed) return changed;
      // In place: the inode, hard links and permissions stay; not atomic.
      await handle.truncate(0);
      await writeAll(handle, bytes);
      return writeResult(target.relativePath, bytes, await handle.stat());
    });
  } finally {
    await handle.close();
  }
}

async function createFile(
  params: Extract<WorkerFilesystemFileWriteParams, { createOnly: true }>,
  bytes: Buffer,
  { host, signal, io }: FilesystemFileWriteContext,
): Promise<WorkerFilesystemFileWriteResult> {
  const target = await resolveTarget(
    host,
    params.scope,
    params.fileRootId,
    params.relativePath,
    CREATE_LABEL,
  );
  await assertCreatableEntryInsideRoot(target.targetPath, target.rootReal);
  await assertOutsideExcludedDescendantRoots(target.root, [target.targetPath], {
    mayContainExcludedRoot: false,
  });
  const parentPath = dirname(target.targetPath);
  let parentReal: string;
  try {
    parentReal = await realpath(parentPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT')
      throw writeError(
        'not_found',
        'worker.filesystem.file.notFound',
        'The parent folder does not exist.',
        error,
      );
    throw error;
  }
  await io?.beforeEffect?.();
  // Opened through the folder validated above: refuse when it now resolves
  // elsewhere, or outside the root.
  const currentParentReal = await realpath(parentPath);
  if (!isPathInsideRoot(currentParentReal, target.rootReal))
    throw writeError(
      'failed_precondition',
      'worker.filesystem.path.escape',
      'File is outside the selected worktree root.',
    );
  if (currentParentReal !== parentReal)
    throw revisionConflict(
      "The file's folder changed while it was being created. Nothing was written.",
    );
  throwIfAborted(signal);
  if (host.os === 'win32') {
    try {
      return await createWindowsFile(target, parentReal, bytes, signal, io);
    } catch (error) {
      if (errorCode(error) === 'EEXIST')
        throw writeError(
          'already_exists',
          undefined,
          `A file or folder already exists at ${target.relativePath}.`,
          error,
        );
      throw error;
    }
  }
  let handle: FileHandle;
  try {
    handle = await open(
      join(parentReal, basename(target.targetPath)),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        noFollowFlag(),
      0o666,
    );
  } catch (error) {
    if (errorCode(error) === 'EEXIST')
      throw writeError(
        'already_exists',
        undefined,
        `A file or folder already exists at ${target.relativePath}.`,
        error,
      );
    throw error;
  }
  try {
    await writeAll(handle, bytes);
    return writeResult(target.relativePath, bytes, await handle.stat());
  } finally {
    await handle.close();
  }
}

/** Prefer link publication: Windows exclusive open can follow dangling links. */
async function createWindowsFile(
  target: ResolvedTarget,
  parentReal: string,
  bytes: Buffer,
  signal: AbortSignal | undefined,
  io: FilesystemFileWriteIo | undefined,
): Promise<WorkerFilesystemFileWriteResult> {
  const stagingDirectory = await mkdtemp(join(parentReal, '.canopy-create-'));
  const stagedPath = join(stagingDirectory, 'file');
  const destination = join(parentReal, basename(target.targetPath));
  try {
    const handle = await open(stagedPath, 'wx', 0o666);
    try {
      await writeAll(handle, bytes);
      throwIfAborted(signal);
      if ((await realpath(parentReal)) !== parentReal)
        throw revisionConflict(
          "The file's folder changed while it was being created. Nothing was written.",
        );
      try {
        await (io?.publishLinkEntry ?? link)(stagedPath, destination);
      } catch (error) {
        try {
          await lstat(destination);
        } catch (lookupError) {
          if (errorCode(lookupError) !== 'ENOENT') throw lookupError;
          const code = errorCode(error);
          // libuv maps FAT/exFAT's ERROR_INVALID_FUNCTION from CreateHardLinkW to EISDIR.
          if (
            code !== 'EPERM' &&
            code !== 'ENOTSUP' &&
            code !== 'EOPNOTSUPP' &&
            code !== 'ENOSYS' &&
            code !== 'EISDIR'
          )
            throw error;
          // Without hard links, lstat narrows but cannot close the link-swap-to-open window.
          throwIfAborted(signal);
          const published = await open(
            destination,
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_WRONLY |
              noFollowFlag(),
            0o666,
          );
          try {
            await writeAll(published, bytes);
            return writeResult(
              target.relativePath,
              bytes,
              await published.stat(),
            );
          } finally {
            await published.close();
          }
        }
        throw writeError(
          'already_exists',
          undefined,
          `A file or folder already exists at ${target.relativePath}.`,
          error,
        );
      }
      return writeResult(target.relativePath, bytes, await handle.stat());
    } finally {
      await handle.close();
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes one text file below a root. A replace edits the file in place (its
 * inode, hard links and mode stay; not atomic) after comparing the exact
 * `expectedVersion`; a stale version whose bytes already match succeeds
 * without writing. A create is exclusive and never creates parent folders.
 * Retains no keyed outcome (CAN-4733).
 */
export async function writeFilesystemFile(
  params: WorkerFilesystemFileWriteParams,
  context: FilesystemFileWriteContext,
): Promise<WorkerFilesystemFileWriteResult> {
  const { host } = context;
  const run = async (): Promise<WorkerFilesystemFileWriteResult> => {
    await host.assertMutable(params.scope);
    const bytes = refuseFileWriteOptions(
      params,
      host.fileWriteLimitBytes ?? DEFAULT_WRITE_LIMIT_BYTES,
    );
    return params.createOnly
      ? createFile(params, bytes, context)
      : replaceFile(params, bytes, context);
  };
  try {
    return await (!params.createOnly && host.admitWrite
      ? host.admitWrite(params.scope, run)
      : run());
  } catch (error) {
    throw asWriteError(error, 'file');
  }
}

/** True when `pathValue` is missing, or names no folder (a dangling link). */
async function isMissing(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue);
    return false;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    throw error;
  }
}

/**
 * The target's missing parent folders, made one level at a time, each after
 * a fresh containment check; answers the ones made, in creation order.
 */
async function createMissingParents(
  target: ResolvedTarget,
  createParents: boolean,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const segments = target.relativePath.split('/');
  const created: string[] = [];
  for (let depth = 1; depth < segments.length; depth += 1) {
    const levelSegments = segments.slice(0, depth);
    const levelPath = join(target.root.absolutePath, ...levelSegments);
    if (!(await isMissing(levelPath))) continue;
    if (!createParents)
      throw new CanopyOperationError({
        kind: 'not_found',
        message:
          'The parent folder does not exist, and createParents is false.',
        retry: { kind: 'never' },
      });
    await assertCreatableEntryInsideRoot(levelPath, target.rootReal);
    throwIfAborted(signal);
    try {
      await mkdir(levelPath, { recursive: false });
      created.push(levelSegments.join('/'));
    } catch (error) {
      // Created meanwhile: the next level's checks decide.
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    // A link planted at this level must not lead the next one outside.
    if (!isPathInsideRoot(await realpath(levelPath), target.rootReal))
      throw writeError(
        'failed_precondition',
        'worker.filesystem.path.escape',
        'File is outside the selected worktree root.',
      );
  }
  return created;
}

/**
 * Creates one folder below a root, never merging into an existing one. With
 * `createParents`, missing folders on the way are created one level at a
 * time, each re-checked for containment right before its `mkdir`; they are
 * not removed on a later failure. Retains no keyed outcome (CAN-4733).
 */
export async function createFilesystemDirectory(
  params: WorkerFilesystemDirectoryCreateParams,
  { host, signal, io }: FilesystemFileWriteContext,
): Promise<WorkerFilesystemDirectoryCreateResult> {
  try {
    await host.assertMutable(params.scope);
    const target = await resolveTarget(
      host,
      params.scope,
      params.fileRootId,
      params.relativePath,
      CREATE_LABEL,
    );
    await assertCreatableEntryInsideRoot(target.targetPath, target.rootReal);
    await assertOutsideExcludedDescendantRoots(
      target.root,
      [target.targetPath],
      { mayContainExcludedRoot: false },
    );
    await io?.beforeEffect?.();
    const createdParentPaths = await createMissingParents(
      target,
      params.createParents,
      signal,
    );
    await assertCreatableEntryInsideRoot(target.targetPath, target.rootReal);
    throwIfAborted(signal);
    try {
      await mkdir(target.targetPath, { recursive: false });
    } catch (error) {
      if (errorCode(error) === 'EEXIST')
        throw new CanopyOperationError(
          {
            kind: 'already_exists',
            code: 'worker.filesystem.entry.exists',
            message: `A file or folder already exists at ${target.relativePath}.`,
            retry: { kind: 'never' },
          },
          error,
        );
      throw error;
    }
    return {
      fileRootId: target.root.fileRootId,
      relativePath: target.relativePath,
      createdParentPaths,
      version: versionOf(await lstat(target.targetPath)),
    };
  } catch (error) {
    throw asWriteError(error, 'directory');
  }
}
