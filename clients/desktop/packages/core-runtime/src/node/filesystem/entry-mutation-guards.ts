import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path';
import type {
  CanopyErrorKind,
  WorkerFilesystemEntryErrorCode,
} from '@canopy/protocol/canopy-core';
import type { PlatformOperatingSystem } from '../../platform/platform-services';
import { CanopyOperationError } from '../../runtime/errors';

// The guards every `worker.filesystem.entry.*` instruction shares, ported
// from the desktop explorer mutations (CAN-4101). Messages are the desktop's,
// which the `file-tree:mutate` projection shows unchanged.

/** One root an entry instruction may change, from trusted host records. */
export interface FilesystemEntryRoot {
  readonly fileRootId: string;
  readonly absolutePath: string;
  /** Other roots nested under this one: child checkouts, managed folders. */
  readonly excludedDescendantRoots: readonly string[];
}

const KINDS: Readonly<Record<WorkerFilesystemEntryErrorCode, CanopyErrorKind>> =
  {
    'worker.filesystem.entry.invalidState': 'failed_precondition',
    'worker.filesystem.entry.revisionConflict': 'conflict',
    'worker.filesystem.entry.invalidPath': 'invalid_argument',
    'worker.filesystem.entry.notFound': 'not_found',
    'worker.filesystem.entry.outsideRoot': 'failed_precondition',
    'worker.filesystem.entry.changed': 'conflict',
    'worker.filesystem.root.notFound': 'not_found',
    'worker.filesystem.root.excluded': 'failed_precondition',
    'worker.filesystem.trash.unavailable': 'capability_unavailable',
    'worker.filesystem.trash.failed': 'failed_precondition',
    'worker.filesystem.entry.exists': 'already_exists',
    'worker.filesystem.entry.nested': 'invalid_argument',
    'worker.filesystem.entry.crossRootSymlink': 'failed_precondition',
  };

// Retry `never` throughout: the desktop host retains no keyed outcome
// (CAN-4733), so it never directs a same-key replay.
export function entryMutationError(
  code: WorkerFilesystemEntryErrorCode,
  message: string,
  runtimeCause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    { kind: KINDS[code], code, message, retry: { kind: 'never' } },
    runtimeCause,
  );
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function isPathInsideRoot(pathValue: string, rootPath: string): boolean {
  return pathValue === rootPath || pathValue.startsWith(`${rootPath}${sep}`);
}

/**
 * A root-relative path with `/` separators; `''` names the root. Absolute
 * paths, drive prefixes and `..` segments are refused.
 */
export function normalizeEntryRelativePath(value: string): string {
  if (win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw entryMutationError(
      'worker.filesystem.entry.invalidPath',
      'Path must be relative.',
    );
  }
  const normalizedInput = value.replace(/\\/g, '/');
  if (posix.isAbsolute(normalizedInput)) {
    throw entryMutationError(
      'worker.filesystem.entry.invalidPath',
      'Path must be relative.',
    );
  }
  if (normalizedInput.split('/').some((segment) => segment === '..')) {
    throw entryMutationError(
      'worker.filesystem.entry.invalidPath',
      'Path cannot traverse outside the worktree.',
    );
  }
  const normalized = posix.normalize(normalizedInput);
  if (normalized === '.') return '';
  return normalized.split('/').filter(Boolean).join('/');
}

/**
 * A mutation path below its root. `\` is a filename character off Windows;
 * reading it as `/` would act on a different entry, so it is refused.
 */
export function requireMutableRelativePath(
  value: string,
  label: string,
  os: PlatformOperatingSystem,
): string {
  if (value.includes('\\') && os !== 'win32') {
    throw entryMutationError(
      'worker.filesystem.entry.invalidPath',
      `${label} cannot contain a backslash.`,
    );
  }
  const normalized = normalizeEntryRelativePath(value);
  // `./` normalizes to `.`, which names the root as well.
  if (!normalized || normalized === '.') {
    throw entryMutationError(
      'worker.filesystem.entry.invalidPath',
      `${label} cannot be a file-tree root.`,
    );
  }
  return normalized;
}

/**
 * The entry's real path, inside the root's real path. A symlink is placed
 * by its target, so one that points outside the root is refused.
 */
export async function resolveExistingEntryInsideRoot(
  targetPath: string,
  rootReal: string,
): Promise<string> {
  let targetReal: string;
  try {
    targetReal = await realpath(targetPath);
  } catch (error) {
    if (isMissingPathError(error))
      throw entryMutationError(
        'worker.filesystem.entry.notFound',
        'The file or folder does not exist.',
        error,
      );
    throw error;
  }
  if (!isPathInsideRoot(targetReal, rootReal)) {
    throw entryMutationError(
      'worker.filesystem.entry.outsideRoot',
      'File is outside the selected worktree root.',
    );
  }
  return targetReal;
}

/**
 * Refuses a path, existing or not, whose nearest existing ancestor resolves
 * outside the root's real path. Only a missing ancestor is walked past; any
 * other read failure is thrown as it is.
 */
export async function assertCreatableEntryInsideRoot(
  targetPath: string,
  rootReal: string,
): Promise<void> {
  let cursor = targetPath;
  for (;;) {
    let ancestorReal: string;
    try {
      ancestorReal = await realpath(cursor);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
      continue;
    }
    if (!isPathInsideRoot(ancestorReal, rootReal)) {
      throw entryMutationError(
        'worker.filesystem.entry.outsideRoot',
        'File is outside the selected worktree root.',
      );
    }
    return;
  }
}

async function resolveThroughExistingAncestor(
  pathValue: string,
): Promise<string> {
  const missingSegments: string[] = [];
  let cursor = resolve(pathValue);
  for (;;) {
    try {
      return join(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(pathValue);
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Where an entry itself lives: ancestor symlinks and case aliases resolve, a
 * final symlink stays, because delete and move act on the link, not its target.
 */
async function resolveEntryLocation(pathValue: string): Promise<string> {
  const location = join(
    await resolveThroughExistingAncestor(dirname(pathValue)),
    basename(pathValue),
  );
  try {
    const stats = await lstat(location);
    return stats.isSymbolicLink() ? location : await realpath(location);
  } catch (error) {
    if (isMissingPathError(error)) return location;
    throw error;
  }
}

async function resolveExcludedRootForms(
  excludedRoot: string,
): Promise<string[]> {
  const forms = [
    resolve(excludedRoot),
    await resolveEntryLocation(excludedRoot),
  ];
  try {
    forms.push(await realpath(excludedRoot));
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  return forms;
}

/**
 * A root's excluded descendants are other roots; mutating them through the
 * parent bypasses that root. A delete, move source, or move/copy target that
 * contains one would also remove or write inside it; only a copy source may
 * contain one.
 */
export async function assertOutsideExcludedDescendantRoots(
  root: FilesystemEntryRoot,
  pathValues: readonly string[],
  { mayContainExcludedRoot }: { mayContainExcludedRoot: boolean },
): Promise<void> {
  if (root.excludedDescendantRoots.length === 0) return;
  const [excludedForms, pathForms] = await Promise.all([
    Promise.all(root.excludedDescendantRoots.map(resolveExcludedRootForms)),
    Promise.all(
      pathValues.map(async (pathValue) => [
        resolve(pathValue),
        await resolveEntryLocation(pathValue),
      ]),
    ),
  ]);
  const excluded = excludedForms.flat();
  const paths = pathForms.flat();
  if (
    paths.some((pathForm) =>
      excluded.some((excludedForm) => isPathInsideRoot(pathForm, excludedForm)),
    )
  ) {
    throw entryMutationError(
      'worker.filesystem.root.excluded',
      'Path belongs to another file-tree root; use that root instead.',
    );
  }
  if (
    !mayContainExcludedRoot &&
    paths.some((pathForm) =>
      excluded.some((excludedForm) => isPathInsideRoot(excludedForm, pathForm)),
    )
  ) {
    throw entryMutationError(
      'worker.filesystem.root.excluded',
      'Path contains another file-tree root.',
    );
  }
}
