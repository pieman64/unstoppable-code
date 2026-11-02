import { constants } from 'node:fs';
import {
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  posix,
  relative,
  sep,
  win32,
} from 'node:path';
import type {
  CanopyWorkspaceScope,
  WorkerFilesystemEntryCopyErrorCode,
  WorkerFilesystemEntryCopyParams,
  WorkerFilesystemEntryCopyResult,
  WorkerFilesystemEntryMoveParams,
  WorkerFilesystemEntryMoveResult,
} from '@canopy/protocol/canopy-core';
import type { PlatformOperatingSystem } from '../../platform/platform-services';
import {
  CanopyOperationError,
  canopyCancelledError,
} from '../../runtime/errors';
import {
  assertCreatableEntryInsideRoot,
  assertOutsideExcludedDescendantRoots,
  entryMutationError,
  requireMutableRelativePath,
  resolveExistingEntryInsideRoot,
  type FilesystemEntryRoot,
} from './entry-mutation-guards';
import type { FilesystemEntryMutationHost } from './entry-mutations';

// `worker.filesystem.entry.copy` and `.move`, ported from the desktop
// explorer's `mutateFileTree` (CAN-4101) with the same order of checks and
// publish strategies; the operation specs' desktop-host sections state the
// same rules.

type EntryPathPair = (sourcePath: string, targetPath: string) => Promise<void>;

/** Test seams around each filesystem effect; defaults are `node:fs`. */
export interface FilesystemEntryTransferIo {
  /** Move only: runs after the conflict check, before re-validation. */
  beforeMove?: () => Promise<void>;
  /** Copies the validated source into staging. */
  copyEntry?: EntryPathPair;
  /** Move only: the rename of the entry itself. */
  renameEntry?: EntryPathPair;
  /** Move only: the hard link of a file to its destination. */
  linkEntry?: EntryPathPair;
  /** Publishes a staged folder. */
  publishRenameEntry?: EntryPathPair;
  /** Publishes a staged file. */
  publishLinkEntry?: EntryPathPair;
  /** Move only: removes the source name, or rolls the destination back. */
  unlinkEntry?: (pathValue: string) => Promise<void>;
  /** Move only: removes the source after a cross-device copy. */
  removeEntry?: (
    pathValue: string,
    options: { recursive: true; force: false },
  ) => Promise<void>;
}

export interface FilesystemEntryTransferContext {
  host: FilesystemEntryMutationHost;
  signal?: AbortSignal;
  io?: FilesystemEntryTransferIo;
}

/** Both instructions' endpoints, under the copy page's names. */
interface TransferEndpoints {
  readonly scope: CanopyWorkspaceScope;
  readonly sourceFileRootId: string;
  readonly sourceRelativePath: string;
  readonly destinationFileRootId: string;
  readonly destinationRelativePath: string;
}

interface TransferRequest {
  readonly endpoints: TransferEndpoints;
  readonly operation: 'copy' | 'move';
  readonly conflictPolicy: 'error' | 'increment';
  /** Option refusals, after the host's and before any other check. */
  readonly refuseUnsupportedOptions: () => void;
}

interface TransferPlan {
  readonly sourceRoot: FilesystemEntryRoot;
  readonly targetRoot: FilesystemEntryRoot;
  readonly sourceRelativePath: string;
  readonly requestedTargetRelativePath: string;
  readonly targetRelativePath: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  /** The source's real path, read last, right before the effect. */
  readonly validatedSourcePath: string;
  readonly sourceIsDirectory: boolean;
  readonly sourceIsSymlink: boolean;
  readonly caseOnlyRename: boolean;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

/**
 * An option this host cannot honour, refused before any effect. No version
 * is computed for an entry before the effect, so none can be compared.
 */
function unsupportedOption(option: string, message: string): never {
  throw new CanopyOperationError({
    kind: 'capability_unavailable',
    message,
    details: { option },
    retry: { kind: 'never' },
  });
}

/** A cancelled caller already has its answer; the next effect must not run. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw canopyCancelledError();
}

function destinationExists(targetRelativePath: string): never {
  throw entryMutationError(
    'worker.filesystem.entry.exists',
    `A file or folder already exists at ${targetRelativePath}.`,
  );
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await lstat(pathValue);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * True only while both names still link the same inode, so removing one
 * cannot drop the last copy. A vanished or replaced source keeps the target.
 */
async function isSameFilesystemEntry(
  firstPath: string,
  secondPath: string,
): Promise<boolean> {
  const [first, second] = await Promise.all([
    lstat(firstPath, { bigint: true }),
    lstat(secondPath, { bigint: true }),
  ]);
  return first.dev === second.dev && first.ino === second.ino;
}

async function isSymlinkTo(
  pathValue: string,
  linkTarget: Buffer,
): Promise<boolean> {
  return (await readlink(pathValue, { encoding: 'buffer' })).equals(linkTarget);
}

function isNestedPath(
  sourcePath: string,
  targetPath: string,
  os: PlatformOperatingSystem,
): boolean {
  const normalizeCase = (value: string): string =>
    os === 'win32' ? value.toLowerCase() : value;
  const relativePath = relative(
    normalizeCase(sourcePath),
    normalizeCase(targetPath),
  );
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !win32.isAbsolute(relativePath) &&
    !posix.isAbsolute(relativePath)
  );
}

async function isCaseOnlyRename(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  if (
    sourcePath === targetPath ||
    sourcePath.toLowerCase() !== targetPath.toLowerCase()
  ) {
    return false;
  }
  const [sourceStats, targetStats] = await Promise.all([
    lstat(sourcePath),
    lstat(targetPath),
  ]);
  const targetHasDistinctDirectoryEntry = (
    await readdir(dirname(targetPath))
  ).includes(basename(targetPath));
  return (
    !sourceStats.isSymbolicLink() &&
    !targetStats.isSymbolicLink() &&
    !targetHasDistinctDirectoryEntry &&
    sourceStats.dev === targetStats.dev &&
    sourceStats.ino === targetStats.ino
  );
}

async function assertTreeHasNoSymlinks(pathValue: string): Promise<void> {
  const stats = await lstat(pathValue);
  if (stats.isSymbolicLink()) {
    throw entryMutationError(
      'worker.filesystem.entry.crossRootSymlink',
      'Cross-root transfers cannot contain symlinks.',
    );
  }
  if (!stats.isDirectory()) return;
  for (const entry of await readdir(pathValue)) {
    await assertTreeHasNoSymlinks(join(pathValue, entry));
  }
}

function incrementalCopyPath(
  relativePath: string,
  copyNumber: number,
  isDirectory: boolean,
): string {
  const directory = posix.dirname(relativePath);
  const filename = posix.basename(relativePath);
  const extension = isDirectory ? '' : posix.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const suffix = copyNumber === 1 ? ' copy' : ` copy ${copyNumber}`;
  const nextName = `${stem}${suffix}${extension}`;
  return directory === '.' ? nextName : posix.join(directory, nextName);
}

/** The first free name; a dangling symlink counts as taken. */
async function resolveAvailableCopyTarget(
  root: FilesystemEntryRoot,
  requestedRelativePath: string,
  isDirectory: boolean,
): Promise<{ relativePath: string; absolutePath: string }> {
  let relativePath = requestedRelativePath;
  let copyNumber = 0;
  for (;;) {
    const absolutePath = join(root.absolutePath, ...relativePath.split('/'));
    if (!(await pathExists(absolutePath))) {
      return { relativePath, absolutePath };
    }
    copyNumber += 1;
    relativePath = incrementalCopyPath(
      requestedRelativePath,
      copyNumber,
      isDirectory,
    );
  }
}

async function copyForTransfer(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  await cp(sourcePath, targetPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

/**
 * The root-relative source and destination a transfer acts on, as the engine
 * normalizes them, source first. Throws the engine's path refusals.
 */
export function normalizeEntryTransferPaths(
  sourceRelativePath: string,
  destinationRelativePath: string,
  os: PlatformOperatingSystem,
): [string, string] {
  return [
    requireMutableRelativePath(sourceRelativePath, 'Source', os),
    requireMutableRelativePath(destinationRelativePath, 'Target', os),
  ];
}

function findRoot(
  roots: readonly FilesystemEntryRoot[],
  fileRootId: string,
): FilesystemEntryRoot {
  const root = roots.find((candidate) => candidate.fileRootId === fileRootId);
  if (!root) {
    throw entryMutationError(
      'worker.filesystem.root.notFound',
      `Unknown file root: ${fileRootId}`,
    );
  }
  return root;
}

/**
 * Every check before the first effect, then the destination's parent
 * folders (created, never removed on failure) and a last re-validation.
 */
async function prepareTransfer(
  {
    endpoints: params,
    operation,
    conflictPolicy,
    refuseUnsupportedOptions,
  }: TransferRequest,
  { host, signal, io }: FilesystemEntryTransferContext,
): Promise<TransferPlan> {
  await host.assertMutable(params.scope);
  refuseUnsupportedOptions();
  const roots = await host.roots(params.scope);
  const sourceRoot = findRoot(roots, params.sourceFileRootId);
  const targetRoot = findRoot(roots, params.destinationFileRootId);
  const [sourceRelativePath, requestedTargetRelativePath] =
    normalizeEntryTransferPaths(
      params.sourceRelativePath,
      params.destinationRelativePath,
      host.os,
    );
  let targetRelativePath = requestedTargetRelativePath;
  const [sourceRootReal, targetRootReal] = await Promise.all([
    realpath(sourceRoot.absolutePath),
    realpath(targetRoot.absolutePath),
  ]);
  const sourcePath = join(
    sourceRoot.absolutePath,
    ...sourceRelativePath.split('/'),
  );
  const sourceReal = await resolveExistingEntryInsideRoot(
    sourcePath,
    sourceRootReal,
  );
  const sourceStats = await lstat(sourcePath);
  let targetPath = join(
    targetRoot.absolutePath,
    ...targetRelativePath.split('/'),
  );
  if (conflictPolicy === 'increment') {
    const available = await resolveAvailableCopyTarget(
      targetRoot,
      targetRelativePath,
      sourceStats.isDirectory(),
    );
    targetRelativePath = available.relativePath;
    targetPath = available.absolutePath;
  }
  await assertCreatableEntryInsideRoot(targetPath, targetRootReal);
  // Copy reads through a final source symlink; move acts on the link.
  const assertEndpointsOutsideExcludedRoots = async (
    resolvedSourcePath: string,
  ): Promise<void> => {
    await Promise.all([
      operation === 'copy'
        ? assertOutsideExcludedDescendantRoots(
            sourceRoot,
            [sourcePath, resolvedSourcePath],
            { mayContainExcludedRoot: true },
          )
        : assertOutsideExcludedDescendantRoots(sourceRoot, [sourcePath], {
            mayContainExcludedRoot: false,
          }),
      assertOutsideExcludedDescendantRoots(targetRoot, [targetPath], {
        mayContainExcludedRoot: false,
      }),
    ]);
  };
  await assertEndpointsOutsideExcludedRoots(sourceReal);
  const sameRoot = sourceRoot.fileRootId === targetRoot.fileRootId;
  if (sameRoot && isNestedPath(sourcePath, targetPath, host.os)) {
    throw entryMutationError(
      'worker.filesystem.entry.nested',
      'A folder cannot be moved or copied into itself.',
    );
  }
  if (!sameRoot) {
    await assertTreeHasNoSymlinks(sourcePath);
  }
  let caseOnlyRename = false;
  if (await pathExists(targetPath)) {
    caseOnlyRename =
      operation === 'move' && (await isCaseOnlyRename(sourcePath, targetPath));
    if (!caseOnlyRename) destinationExists(targetRelativePath);
  }
  if (operation === 'move') {
    await io?.beforeMove?.();
  }
  const [revalidatedSourcePath] = await Promise.all([
    resolveExistingEntryInsideRoot(sourcePath, sourceRootReal),
    assertCreatableEntryInsideRoot(targetPath, targetRootReal),
  ]);
  await assertEndpointsOutsideExcludedRoots(revalidatedSourcePath);
  throwIfAborted(signal);
  await mkdir(dirname(targetPath), { recursive: true });
  const [validatedSourcePath] = await Promise.all([
    resolveExistingEntryInsideRoot(sourcePath, sourceRootReal),
    assertCreatableEntryInsideRoot(targetPath, targetRootReal),
  ]);
  await assertEndpointsOutsideExcludedRoots(validatedSourcePath);
  return {
    sourceRoot,
    targetRoot,
    sourceRelativePath,
    requestedTargetRelativePath,
    targetRelativePath,
    sourcePath,
    targetPath,
    validatedSourcePath,
    sourceIsDirectory: sourceStats.isDirectory(),
    sourceIsSymlink: sourceStats.isSymbolicLink(),
    caseOnlyRename,
  };
}

/**
 * Copies into `<destination folder>/.canopy-copy-*` and publishes the result
 * exclusively, so a destination created meanwhile is kept and reported as a
 * conflict. Staging is removed on failure; after a publish its removal is
 * best effort.
 */
async function copyIntoStaging(
  plan: TransferPlan,
  { host, signal, io }: FilesystemEntryTransferContext,
): Promise<void> {
  const { targetPath, targetRelativePath } = plan;
  const copyEntry = io?.copyEntry ?? copyForTransfer;
  const publishRenameEntry = io?.publishRenameEntry ?? rename;
  const publishLinkEntry = io?.publishLinkEntry ?? link;
  const publishStagedEntry = async (stagingPath: string): Promise<void> => {
    if (!plan.sourceIsDirectory) {
      try {
        await publishLinkEntry(stagingPath, targetPath);
      } catch (error) {
        const code = errorCode(error);
        if (
          code !== 'EPERM' &&
          code !== 'ENOTSUP' &&
          code !== 'EOPNOTSUPP' &&
          code !== 'ENOSYS'
        ) {
          throw error;
        }
        await copyFile(stagingPath, targetPath, constants.COPYFILE_EXCL);
      }
      await unlink(stagingPath);
      return;
    }

    // Windows renames a folder only onto a missing name, so no reservation.
    if (host.os === 'win32') {
      await publishRenameEntry(stagingPath, targetPath);
      return;
    }

    try {
      await mkdir(targetPath, { recursive: false });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') destinationExists(targetRelativePath);
      throw error;
    }
    try {
      await publishRenameEntry(stagingPath, targetPath);
    } catch (error) {
      try {
        await rmdir(targetPath);
      } catch {
        // Only remove our empty reservation; concurrent content is preserved.
      }
      throw error;
    }
  };
  const stagingDirectory = await mkdtemp(
    join(dirname(targetPath), '.canopy-copy-'),
  );
  const stagingPath = join(stagingDirectory, basename(targetPath));
  try {
    await copyEntry(plan.validatedSourcePath, stagingPath);
    throwIfAborted(signal);
    await publishStagedEntry(stagingPath);
  } catch (error) {
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch {
      // Preserve the original copy/publish failure when cleanup cannot finish.
    }
    const code = errorCode(error);
    if (
      code === 'EEXIST' ||
      code === 'ENOTEMPTY' ||
      code === 'ERR_FS_CP_EEXIST'
    ) {
      destinationExists(targetRelativePath);
    }
    throw error;
  }
  try {
    await rm(stagingDirectory, { recursive: true, force: true });
  } catch {
    // The copy is already published; an empty staging cleanup is best-effort.
  }
}

/** The `<size>:<mtimeMs>` version the file reader reports, of the entry itself. */
async function entryVersion(pathValue: string): Promise<string> {
  const stats = await lstat(pathValue);
  return `${stats.size}:${Math.round(stats.mtimeMs)}`;
}

// A switch, not a keyed map: the copy page has its own code for each of
// these shared-guard refusals; the kind and message stay the guard's.
function copyErrorCode(
  code: string | undefined,
): WorkerFilesystemEntryCopyErrorCode | undefined {
  switch (code) {
    case 'worker.filesystem.entry.notFound':
      return 'worker.filesystem.source.notFound';
    case 'worker.filesystem.entry.outsideRoot':
      return 'worker.filesystem.path.escape';
    case 'worker.filesystem.entry.exists':
      return 'worker.filesystem.destination.exists';
    case 'worker.filesystem.entry.nested':
      return 'worker.filesystem.destination.nested';
    case 'worker.filesystem.entry.crossRootSymlink':
      return 'worker.filesystem.symlink.rejected';
    default:
      return undefined;
  }
}

function asCopyError(error: unknown): unknown {
  if (!(error instanceof CanopyOperationError)) return error;
  const code = copyErrorCode(error.payload.code);
  return code
    ? new CanopyOperationError({ ...error.payload, code }, error.runtimeCause)
    : error;
}

/**
 * Copies one entry, folder trees included, to a destination below a root of
 * the same scope. The source is read through its real path, so a final
 * symlink is copied as what it points to; nested symlinks stay verbatim.
 * Retains no keyed outcome (CAN-4733).
 */
export async function copyFilesystemEntry(
  params: WorkerFilesystemEntryCopyParams,
  context: FilesystemEntryTransferContext,
): Promise<WorkerFilesystemEntryCopyResult> {
  try {
    const plan = await prepareTransfer(
      {
        endpoints: params,
        operation: 'copy',
        conflictPolicy: params.conflictPolicy,
        refuseUnsupportedOptions: () => {
          if (params.expectedSourceVersion !== null)
            unsupportedOption(
              'expectedSourceVersion',
              "This host can't compare expectedSourceVersion; send null. Nothing was copied.",
            );
        },
      },
      context,
    );
    await copyIntoStaging(plan, context);
    return {
      sourceFileRootId: plan.sourceRoot.fileRootId,
      sourceRelativePath: plan.sourceRelativePath,
      destinationFileRootId: plan.targetRoot.fileRootId,
      requestedDestinationRelativePath: plan.requestedTargetRelativePath,
      destinationRelativePath: plan.targetRelativePath,
      // One entry: its descendants are not counted, as for a delete.
      copiedEntryCount: 1,
      version: await entryVersion(plan.targetPath),
    };
  } catch (error) {
    throw asCopyError(error);
  }
}

interface MoveSteps {
  readonly plan: TransferPlan;
  readonly signal: AbortSignal | undefined;
  readonly renameEntry: EntryPathPair;
  readonly linkEntry: EntryPathPair;
  readonly unlinkEntry: (pathValue: string) => Promise<void>;
  /** Copy, then `rm` the source; a cancellation before `rm` keeps both. */
  readonly copyAcrossDevices: () => Promise<void>;
}

// macOS link(2) follows a symlink source, so recreate the link itself.
async function moveSymlink({
  plan,
  signal,
  unlinkEntry,
}: MoveSteps): Promise<void> {
  const { sourcePath, targetPath, targetRelativePath } = plan;
  const linkTarget = await readlink(sourcePath, { encoding: 'buffer' });
  try {
    await symlink(linkTarget, targetPath);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') destinationExists(targetRelativePath);
    throw error;
  }
  try {
    throwIfAborted(signal);
    await unlinkEntry(sourcePath);
  } catch (error) {
    try {
      const [sourceRemains, targetRemains] = await Promise.all([
        isSymlinkTo(sourcePath, linkTarget),
        isSymlinkTo(targetPath, linkTarget),
      ]);
      if (sourceRemains && targetRemains) {
        await unlinkEntry(targetPath);
      }
    } catch {
      // Preserve the source-cleanup error if rollback also fails.
    }
    throw error;
  }
}

// Windows renames a folder only onto a missing name, so no reservation.
async function moveWindowsDirectory({
  plan,
  renameEntry,
  copyAcrossDevices,
}: MoveSteps): Promise<void> {
  const { sourcePath, targetPath, targetRelativePath } = plan;
  try {
    await renameEntry(sourcePath, targetPath);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EXDEV') {
      await copyAcrossDevices();
    } else if (
      code === 'EEXIST' ||
      code === 'ENOTEMPTY' ||
      ((code === 'EPERM' || code === 'EACCES') &&
        (await pathExists(targetPath)))
    ) {
      destinationExists(targetRelativePath);
    } else {
      throw error;
    }
  }
}

async function movePosixDirectory({
  plan,
  renameEntry,
  copyAcrossDevices,
}: MoveSteps): Promise<void> {
  const { sourcePath, targetPath, targetRelativePath } = plan;
  try {
    await mkdir(targetPath, { recursive: false });
  } catch (error) {
    if (errorCode(error) === 'EEXIST') destinationExists(targetRelativePath);
    throw error;
  }
  try {
    await renameEntry(sourcePath, targetPath);
  } catch (error) {
    try {
      await rmdir(targetPath);
    } catch {
      // Only remove our still-empty reservation. A changed target is kept.
    }
    const moveCode = errorCode(error);
    if (moveCode === 'EEXIST' || moveCode === 'ENOTEMPTY') {
      destinationExists(targetRelativePath);
    }
    if (moveCode !== 'EXDEV') throw error;
    await copyAcrossDevices();
  }
}

async function moveFile({
  plan,
  signal,
  linkEntry,
  unlinkEntry,
  copyAcrossDevices,
}: MoveSteps): Promise<void> {
  const { sourcePath, targetPath, targetRelativePath } = plan;
  try {
    await linkEntry(sourcePath, targetPath);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EEXIST' || code === 'ERR_FS_CP_EEXIST') {
      destinationExists(targetRelativePath);
    }
    if (
      code !== 'EXDEV' &&
      code !== 'EPERM' &&
      code !== 'ENOTSUP' &&
      code !== 'EOPNOTSUPP' &&
      code !== 'ENOSYS'
    ) {
      throw error;
    }
    await copyAcrossDevices();
    return;
  }
  try {
    throwIfAborted(signal);
    await unlinkEntry(sourcePath);
  } catch (error) {
    // Roll back only while the source still names the linked inode, so a
    // vanished or replaced source never loses the moved file (W2).
    try {
      if (await isSameFilesystemEntry(sourcePath, targetPath)) {
        await unlinkEntry(targetPath);
      }
    } catch {
      // Preserve the source-cleanup error if rollback also fails.
    }
    throw error;
  }
}

/**
 * Moves or renames one entry, acting on a symlink as a link. Never replaces
 * a destination; across devices it copies, then removes the source. Retains
 * no keyed outcome (CAN-4733).
 */
export async function moveFilesystemEntry(
  params: WorkerFilesystemEntryMoveParams,
  context: FilesystemEntryTransferContext,
): Promise<WorkerFilesystemEntryMoveResult> {
  const plan = await prepareTransfer(
    {
      endpoints: {
        scope: params.scope,
        sourceFileRootId: params.sourceFileRootId,
        sourceRelativePath: params.fromRelativePath,
        destinationFileRootId: params.destinationFileRootId,
        destinationRelativePath: params.toRelativePath,
      },
      operation: 'move',
      conflictPolicy: 'error',
      refuseUnsupportedOptions: () => {
        if (params.expectedSourceVersion !== null)
          unsupportedOption(
            'expectedSourceVersion',
            "This host can't compare expectedSourceVersion; send null. Nothing was moved.",
          );
        if (!params.expectedDestinationAbsent)
          unsupportedOption(
            'expectedDestinationAbsent',
            'This host never replaces a destination; send expectedDestinationAbsent: true. Nothing was moved.',
          );
        if (params.conflictPolicy !== 'error')
          unsupportedOption(
            'conflictPolicy',
            'This host moves only onto a free name; send conflictPolicy: error. Nothing was moved.',
          );
      },
    },
    context,
  );
  const { host, signal, io } = context;
  const removeEntry = io?.removeEntry ?? rm;
  const steps: MoveSteps = {
    plan,
    signal,
    renameEntry: io?.renameEntry ?? rename,
    linkEntry: io?.linkEntry ?? link,
    unlinkEntry: io?.unlinkEntry ?? unlink,
    copyAcrossDevices: async () => {
      await copyIntoStaging(plan, context);
      throwIfAborted(signal);
      await removeEntry(plan.sourcePath, { recursive: true, force: false });
    },
  };
  if (plan.caseOnlyRename) {
    await steps.renameEntry(plan.sourcePath, plan.targetPath);
  } else if (plan.sourceIsSymlink && host.os === 'darwin') {
    await moveSymlink(steps);
  } else if (plan.sourceIsDirectory) {
    await (host.os === 'win32' ? moveWindowsDirectory : movePosixDirectory)(
      steps,
    );
  } else {
    await moveFile(steps);
  }
  return {
    fromRelativePath: plan.sourceRelativePath,
    toRelativePath: plan.targetRelativePath,
    version: await entryVersion(plan.targetPath),
    sourceFileRootId: plan.sourceRoot.fileRootId,
    destinationFileRootId: plan.targetRoot.fileRootId,
    requestedToRelativePath: plan.requestedTargetRelativePath,
    conflictPolicy: 'error',
  };
}
