import { lstat, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CanopyWorkspaceScope,
  WorkerFilesystemEntryDeleteParams,
  WorkerFilesystemEntryDeleteResult,
} from '@canopy/protocol/canopy-core';
import type {
  PlatformOperatingSystem,
  PlatformTrashServices,
} from '../../platform/platform-services';
import {
  CanopyOperationError,
  canopyCancelledError,
} from '../../runtime/errors';
import {
  assertOutsideExcludedDescendantRoots,
  entryMutationError,
  isPathInsideRoot,
  requireMutableRelativePath,
  resolveExistingEntryInsideRoot,
  type FilesystemEntryRoot,
} from './entry-mutation-guards';

// `worker.filesystem.entry.*` engines, ported from the desktop explorer
// mutations (CAN-4101); the operation specs' desktop-host sections state the
// same rules.

/** What an entry instruction needs from its host; never caller data. */
export interface FilesystemEntryMutationHost {
  /** Decides the backslash rule; the engine never reads the process. */
  readonly os: PlatformOperatingSystem;
  /**
   * Refuses a scope whose files must not change: read-only scopes, managed
   * scopes without a target, locked worktrees. Runs before anything else.
   */
  assertMutable(this: void, scope: CanopyWorkspaceScope): void | Promise<void>;
  roots(
    this: void,
    scope: CanopyWorkspaceScope,
  ): Promise<readonly FilesystemEntryRoot[]>;
  /** Absent: a `trash` request fails before any effect, never deletes. */
  readonly trash?: PlatformTrashServices;
  /** The largest `file.write` content, in UTF-8 bytes; absent: 16 MiB. */
  readonly fileWriteLimitBytes?: number;
  /**
   * Runs a `file.write` replace inside the host's admission, such as a hold
   * against Auto Delete. Creates do not take it.
   */
  admitWrite?<Result>(
    this: void,
    scope: CanopyWorkspaceScope,
    run: () => Promise<Result>,
  ): Promise<Result>;
  /**
   * Runs right before a `file.write` replace changes the file's bytes, after
   * every check; the desktop records worktree activity. Creates skip it.
   */
  beforeReplace?(this: void, scope: CanopyWorkspaceScope): Promise<void>;
}

export interface FilesystemEntryRemoveOptions {
  readonly recursive: boolean;
  readonly force: false;
}

/** Test seams around the irreversible step. */
export interface FilesystemEntryDeleteIo {
  /** Runs after validation, before the parent re-check and the effect. */
  beforeDelete?: () => Promise<void>;
  removeEntry?: (
    pathValue: string,
    options: FilesystemEntryRemoveOptions,
  ) => Promise<void>;
}

const DELETE_LABEL = 'Delete target';

/**
 * The root-relative path a delete acts on, as the engine normalizes it; the
 * explorer projection reports it back. Throws the engine's path refusals.
 */
export function normalizeEntryDeletePath(
  relativePath: string,
  os: PlatformOperatingSystem,
): string {
  return requireMutableRelativePath(relativePath, DELETE_LABEL, os);
}

function requireTrash(
  trash: PlatformTrashServices | undefined,
): PlatformTrashServices {
  if (!trash)
    throw entryMutationError(
      'worker.filesystem.trash.unavailable',
      "Couldn't move the item to the trash; no trash is available here. Nothing was deleted.",
    );
  return trash;
}

function notEmpty(runtimeCause?: unknown): CanopyOperationError {
  return entryMutationError(
    'worker.filesystem.entry.invalidState',
    "The folder isn't empty, and recursive is false. Nothing was deleted.",
    runtimeCause,
  );
}

function nonRecursiveTrashUnavailable(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    message:
      "This host can't move a folder to the trash with recursive false; send recursive true or delete it permanently. Nothing was deleted.",
    details: { option: 'recursive' },
    retry: { kind: 'never' },
  });
}

function isNotEmptyError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  return code === 'ENOTEMPTY' || code === 'EEXIST';
}

async function removeEntry(
  pathValue: string,
  { recursive, force }: FilesystemEntryRemoveOptions,
): Promise<void> {
  if (recursive) return rm(pathValue, { recursive: true, force });
  // `rmdir` refuses a folder that filled since the check; `rm` refuses any folder.
  if ((await lstat(pathValue)).isDirectory()) return rmdir(pathValue);
  return rm(pathValue, { recursive: false, force });
}

async function isFolder(pathValue: string): Promise<boolean> {
  try {
    return (await lstat(pathValue)).isDirectory();
  } catch {
    return false;
  }
}

/** The irreversible step, after every check. */
async function applyDelete(
  targetPath: string,
  trash: PlatformTrashServices | undefined,
  recursive: boolean,
  io: FilesystemEntryDeleteIo | undefined,
): Promise<void> {
  if (trash) {
    // Narrows, not closes, the window for a folder swapped in since the check;
    // a vanished entry is left to the trash to refuse, as before.
    if (!recursive && (await isFolder(targetPath)))
      throw nonRecursiveTrashUnavailable();
    try {
      await trash.trashItem(targetPath);
    } catch (error) {
      throw entryMutationError(
        'worker.filesystem.trash.failed',
        "Couldn't move the item to the trash.",
        error,
      );
    }
    return;
  }
  try {
    await (io?.removeEntry ?? removeEntry)(targetPath, {
      recursive,
      force: false,
    });
  } catch (error) {
    if (!recursive && isNotEmptyError(error)) throw notEmpty(error);
    throw error;
  }
}

/**
 * Deletes one entry below a root: moved to the host's trash, or removed with
 * `rm` (never forced). The lexical path is the one acted on, so a symlink is
 * removed as a link and never followed. `recursive: false` refuses a
 * non-empty folder, and any folder bound for the trash, before any effect.
 * Retains no keyed outcome (CAN-4733).
 */
export async function deleteFilesystemEntry(
  params: WorkerFilesystemEntryDeleteParams,
  context: {
    host: FilesystemEntryMutationHost;
    signal?: AbortSignal;
    io?: FilesystemEntryDeleteIo;
  },
): Promise<WorkerFilesystemEntryDeleteResult> {
  const { host, signal, io } = context;
  await host.assertMutable(params.scope);
  // No version is computed for an entry, so none can be compared.
  if (params.expectedVersion !== null)
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message:
        "This host can't compare expectedVersion; send null. Nothing was deleted.",
      details: { option: 'expectedVersion' },
      retry: { kind: 'never' },
    });
  const trash =
    params.disposition === 'trash' ? requireTrash(host.trash) : undefined;
  const root = (await host.roots(params.scope)).find(
    (candidate) => candidate.fileRootId === params.fileRootId,
  );
  if (!root) {
    throw entryMutationError(
      'worker.filesystem.root.notFound',
      `Unknown file root: ${params.fileRootId}`,
    );
  }
  const relativePath = normalizeEntryDeletePath(params.relativePath, host.os);
  const rootReal = await realpath(root.absolutePath);
  const targetPath = join(root.absolutePath, ...relativePath.split('/'));
  await resolveExistingEntryInsideRoot(targetPath, rootReal);
  // Read with containment, so the re-check spans every later check too.
  const parentPath = dirname(targetPath);
  const parentReal = await realpath(parentPath);
  await assertOutsideExcludedDescendantRoots(root, [targetPath], {
    mayContainExcludedRoot: false,
  });
  // The link itself: a symlink to a folder is removed as a link.
  if (!params.recursive && (await lstat(targetPath)).isDirectory()) {
    if ((await readdir(targetPath)).length > 0) throw notEmpty();
    // `trashItem` moves a folder whole: it can't refuse one that fills after
    // this check, as `rmdir` does.
    if (trash) throw nonRecursiveTrashUnavailable();
  }
  await io?.beforeDelete?.();
  // The effect acts on the lexical path: refuse when its folder now resolves
  // elsewhere than the one validated, or outside the root.
  const currentParentReal = await realpath(parentPath);
  if (!isPathInsideRoot(currentParentReal, rootReal)) {
    throw entryMutationError(
      'worker.filesystem.entry.outsideRoot',
      'File is outside the selected worktree root.',
    );
  }
  if (currentParentReal !== parentReal) {
    throw entryMutationError(
      'worker.filesystem.entry.changed',
      "The item's folder changed while it was being deleted. Nothing was deleted.",
    );
  }
  // A cancelled caller already has its answer; the effect must not follow.
  if (signal?.aborted) throw canopyCancelledError();
  await applyDelete(targetPath, trash, params.recursive, io);
  // One entry: its descendants are not counted, as on the web core.
  return {
    deleted: true,
    deletedEntryCount: 1,
    disposition: params.disposition,
  };
}
