import { AsyncLocalStorage } from 'node:async_hooks';
import type { Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  constants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { isPathInside } from '@canopy/execution-engine/node/lib/path-safety';

// Owner-only permissions for memory data at rest. Node accepts `mode` on all
// platforms; on Windows it is effectively a no-op, which is the intended
// graceful degradation (no chmod calls that could throw there).
export const MEMORY_DIR_MODE = 0o700;
export const MEMORY_FILE_MODE = 0o600;

export function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

export async function ensureOwnerOnlyDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: MEMORY_DIR_MODE });
  // mkdir's mode only applies on creation; tighten pre-existing directories
  // (e.g. created by the open-memory-folder flow) to owner-only too.
  try {
    await chmod(directory, MEMORY_DIR_MODE);
  } catch (error) {
    // Windows has no POSIX modes; keep the directory as created there. On
    // POSIX platforms fail closed instead of writing memory data into a
    // directory whose permissions could not be tightened.
    if (hostOperatingSystem() !== 'win32') throw error;
  }
}

/**
 * A memory path that is a symbolic link or junction, lies under one, or
 * resolves outside its scope directory. `linkedPath` is the first component
 * that broke containment.
 */
export class MemoryPathNotContainedError extends Error {
  constructor(readonly linkedPath: string) {
    super(`${linkedPath} is a link or leads outside its memory folder`);
    this.name = 'MemoryPathNotContainedError';
  }
}

/**
 * Rejects with {@link MemoryPathNotContainedError} unless `path` stays in
 * `scopeDir`: every existing component below the scope directory is a real
 * file or directory, never a symbolic link or junction (lstat reports both
 * as links), and the deepest existing one resolves inside the scope
 * directory's real path, which also catches other reparse points. Missing
 * components pass, so a write may create them. The scope directory itself
 * is trusted as it is reached; a data root may be linked.
 */
export async function assertMemoryPathContained(
  scopeDir: string,
  path: string,
): Promise<void> {
  const root = resolve(scopeDir);
  const target = resolve(path);
  if (!isPathInside(root, target)) throw new MemoryPathNotContainedError(path);
  if (target === root) return;
  let deepest = root;
  for (const segment of relative(root, target).split(sep)) {
    const next = join(deepest, segment);
    let info: Stats;
    try {
      info = await lstat(next);
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) break;
      throw error;
    }
    if (info.isSymbolicLink()) throw new MemoryPathNotContainedError(next);
    deepest = next;
  }
  if (deepest === root) return;
  const [rootReal, deepestReal] = await Promise.all([
    realpath(root),
    realpath(deepest),
  ]);
  if (deepestReal === rootReal || !isPathInside(rootReal, deepestReal)) {
    throw new MemoryPathNotContainedError(deepest);
  }
}

/** Whether `path` stays in `scopeDir` (see {@link assertMemoryPathContained}). */
export async function isMemoryPathContained(
  scopeDir: string,
  path: string,
): Promise<boolean> {
  try {
    await assertMemoryPathContained(scopeDir, path);
    return true;
  } catch (error) {
    if (error instanceof MemoryPathNotContainedError) return false;
    throw error;
  }
}

/**
 * {@link ensureOwnerOnlyDir} for a directory in `scopeDir`, refusing one
 * that is a link or under one before anything is created or chmodded.
 */
export async function ensureOwnerOnlyMemoryDir(
  scopeDir: string,
  directory: string,
): Promise<void> {
  await assertMemoryPathContained(scopeDir, directory);
  await ensureOwnerOnlyDir(directory);
}

/** A scope lock a critical section holds (see `withMemoryScopeLock`). */
export interface HeldMemoryScopeLock {
  assertHeld(): Promise<void>;
}

interface ScopeLockHold {
  lock: HeldMemoryScopeLock;
  active: boolean;
}

const heldScopeLocks = new AsyncLocalStorage<readonly ScopeLockHold[]>();

/** Runs `critical` as a section holding `lock`, nested in any outer one. */
export async function runHoldingMemoryScopeLock<T>(
  lock: HeldMemoryScopeLock,
  critical: () => Promise<T>,
): Promise<T> {
  const hold: ScopeLockHold = { lock, active: true };
  try {
    return await heldScopeLocks.run(
      [...(heldScopeLocks.getStore() ?? []), hold],
      critical,
    );
  } finally {
    hold.active = false;
  }
}

/**
 * Call right before each write commit (a rename, link, create or delete of a
 * memory file). Inside a section holding scope locks it rejects with
 * `LocalMemoryScopeLockLostError` once another process has taken one over,
 * so a holder never commits a write after losing its lock. Elsewhere, and
 * in work a section leaves running after it ends, it does nothing.
 */
export async function assertMemoryScopeLockHeld(): Promise<void> {
  for (const hold of heldScopeLocks.getStore() ?? []) {
    if (hold.active) await hold.lock.assertHeld();
  }
}

export interface MemoryFileTimes {
  atime: Date;
  mtime: Date;
}

const WRITE_TEMP_PREFIX = '.memory-write-';
const WRITE_TEMP_PATTERN = /^\.memory-write-[0-9a-f-]{36}\.tmp$/;

/**
 * A sibling temp file for a write into `directory`: a dot entry every reader
 * ignores, whose name does not grow with the target's. Only writers holding
 * the scope lock create these, so one found under the lock was left by a
 * writer that died (see {@link sweepAbandonedMemoryWrites}).
 */
function memoryWriteTempPath(directory: string): string {
  return join(directory, `${WRITE_TEMP_PREFIX}${randomUUID()}.tmp`);
}

/** The scope's folders a write may leave a temp file in, the scope first. */
const WRITE_FOLDERS = [
  '',
  'inbox',
  join('inbox', '.consolidated'),
  'imported',
  join('imported', '.consolidated'),
  'topics',
];

/**
 * Removes the temp files of writes that never finished: a writer that died
 * between writing its temp file and renaming it leaves one behind. Call it
 * holding the scope lock, so no live writer's temp file can be among them.
 * Folders that are links, or under one, are left alone.
 */
export async function sweepAbandonedMemoryWrites(
  scopeDir: string,
): Promise<void> {
  for (const folder of WRITE_FOLDERS) {
    const directory = join(scopeDir, folder);
    if (!(await isMemoryPathContained(scopeDir, directory))) continue;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR')) {
        continue;
      }
      throw error;
    }
    for (const name of names.filter((entry) =>
      WRITE_TEMP_PATTERN.test(entry),
    )) {
      const path = join(directory, name);
      const info = await lstat(path).catch(() => null);
      if (info === null || info.isDirectory()) continue;
      await assertMemoryScopeLockHeld();
      await unlink(path).catch(() => undefined);
    }
  }
}

/**
 * Replaces a memory file in `scopeDir` owner-only through a sibling temp
 * file and rename, refusing a directory that is a link or under one (see
 * {@link assertMemoryPathContained}); a link at `filePath` itself is
 * replaced, never followed. With `times`, the replacement keeps them: they
 * are set on the temp file before the rename, so the target never holds the
 * new bytes with a new modification time, even after a crash. The temp file
 * is a dot entry whose name does not grow with the target's, so a target
 * near the file name length limit can still be replaced.
 */
export async function writeMemoryFileAtomically(
  scopeDir: string,
  filePath: string,
  content: string | Buffer,
  times?: MemoryFileTimes,
): Promise<void> {
  await replaceThroughTempFile(scopeDir, filePath, content, times);
}

/**
 * {@link writeMemoryFileAtomically} while `unchanged` still holds right
 * before the rename; false, with nothing replaced, once it does not. The
 * scope lock keeps the app's writers out, not another editor: checked last,
 * a save that editor makes while the caller decided what to write is kept.
 */
export function replaceMemoryFileIfUnchanged(
  scopeDir: string,
  filePath: string,
  content: string,
  unchanged: () => Promise<boolean>,
): Promise<boolean> {
  return replaceThroughTempFile(
    scopeDir,
    filePath,
    content,
    undefined,
    unchanged,
  );
}

async function replaceThroughTempFile(
  scopeDir: string,
  filePath: string,
  content: string | Buffer,
  times?: MemoryFileTimes,
  unchanged?: () => Promise<boolean>,
): Promise<boolean> {
  const directory = dirname(filePath);
  await ensureOwnerOnlyMemoryDir(scopeDir, directory);
  const temporaryPath = memoryWriteTempPath(directory);
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: MEMORY_FILE_MODE,
    });
    if (times) await utimes(temporaryPath, times.atime, times.mtime);
    await assertMemoryPathContained(scopeDir, directory);
    await assertMemoryScopeLockHeld();
    if (unchanged !== undefined && !(await unchanged())) {
      await unlink(temporaryPath).catch(() => undefined);
      return false;
    }
    await rename(temporaryPath, filePath);
    return true;
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Memory files are `.md` exactly; the check is case-sensitive everywhere
 * (listing, consolidation input, pending-note counts) so a `NOTE.MD` is
 * consistently ignored rather than counted in one place and skipped in
 * another. Dot entries (`.lock/`, `.sync/`, temp and editor files) are never
 * memory.
 */
export function isMemoryMarkdownFileName(name: string): boolean {
  return name.endsWith('.md') && !name.startsWith('.');
}

const HARD_LINK_UNSUPPORTED = ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EMLINK'];

function hardLinksUnsupported(error: unknown): boolean {
  return (
    !isNodeError(error, 'EEXIST') &&
    HARD_LINK_UNSUPPORTED.some((code) => isNodeError(error, code))
  );
}

/** A create-only write or move whose destination name is taken. */
class MemoryFileExistsError extends Error {
  readonly code = 'EEXIST';

  constructor(readonly path: string) {
    super(`${path} already exists`);
    this.name = 'MemoryFileExistsError';
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  throw new MemoryFileExistsError(path);
}

/**
 * Gives the complete file at `temporary` the name `destination`, which must
 * not exist yet; the temp file's name is gone afterwards. A hard link
 * publishes it atomically and never replaces anything. Without hard links no
 * portable rename refuses an existing target, so the name is checked free
 * and then renamed onto: only a writer outside the scope lock (an older
 * build, the user) creating that exact name in between could be replaced.
 * Either way a crash leaves the destination absent or complete, never cut
 * short. Callers have checked containment and the scope lock.
 */
async function publishWithoutReplacing(
  temporary: string,
  destination: string,
  tryLink: boolean,
): Promise<void> {
  if (tryLink) {
    try {
      await link(temporary, destination);
      // Published: a temp name left behind is swept as an abandoned write.
      await unlink(temporary).catch(() => undefined);
      return;
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        throw new MemoryFileExistsError(destination);
      }
      if (!hardLinksUnsupported(error)) throw error;
    }
  }
  await assertAbsent(destination);
  await rename(temporary, destination);
}

/**
 * Creates a memory file in `scopeDir` owner-only, whole or not at all,
 * rejecting with {@link MemoryFileExistsError} when `filePath` is taken. The
 * bytes go to a sibling temp file first, so a crash part way never leaves a
 * file cut short under the new name.
 */
export async function writeNewMemoryFile(
  scopeDir: string,
  filePath: string,
  content: string,
): Promise<void> {
  const directory = dirname(filePath);
  await assertMemoryPathContained(scopeDir, directory);
  const temporaryPath = memoryWriteTempPath(directory);
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: MEMORY_FILE_MODE,
    });
    await assertMemoryPathContained(scopeDir, directory);
    await assertMemoryScopeLockHeld();
    await publishWithoutReplacing(temporaryPath, filePath, true);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function isSameFile(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    lstat(left, { bigint: true }),
    lstat(right, { bigint: true }),
  ]);
  return a.isFile() && a.dev === b.dev && a.ino === b.ino;
}

/**
 * {@link writeNewMemoryFile}, or with `replace` {@link writeMemoryFileAtomically},
 * for a file that must survive a crash before the caller drops the only other
 * copy of its content: the bytes and the name are flushed to disk before it
 * resolves. A taken name rejects with EEXIST unless `replace` is set.
 */
export async function writeMemoryFileDurably(
  scopeDir: string,
  filePath: string,
  content: string,
  options: { replace: boolean; times?: MemoryFileTimes },
): Promise<void> {
  const directory = dirname(filePath);
  await ensureOwnerOnlyMemoryDir(scopeDir, directory);
  const temporaryPath = memoryWriteTempPath(directory);
  try {
    const handle = await open(temporaryPath, 'wx', MEMORY_FILE_MODE);
    try {
      await handle.writeFile(content, 'utf8');
      if (options.times) {
        await handle.utimes(options.times.atime, options.times.mtime);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertMemoryPathContained(scopeDir, directory);
    await assertMemoryScopeLockHeld();
    if (options.replace) {
      await rename(temporaryPath, filePath);
    } else {
      await publishWithoutReplacing(temporaryPath, filePath, true);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await flushDirectory(directory);
}

/**
 * Moves a file in `scopeDir` to a name that must not exist yet. Unlike
 * rename, an existing destination (a note saved meanwhile under the same
 * name) is never replaced: the move rejects with EEXIST and changes nothing.
 * A destination that already is the source, as a crash between linking and
 * unlinking leaves it, only loses the old name. Where hard links are
 * unavailable the file is copied to a sibling temp file, which keeps `times`
 * (the source's own by default) and is published under the destination name
 * only once complete (see {@link publishWithoutReplacing}); the source goes
 * last. A source that is a link, or either end under one, is refused (see
 * {@link assertMemoryPathContained}).
 */
export async function moveWithoutReplacing(
  scopeDir: string,
  source: string,
  destination: string,
  times?: MemoryFileTimes,
): Promise<void> {
  await assertMemoryPathContained(scopeDir, source);
  await assertMemoryPathContained(scopeDir, dirname(destination));
  await assertMemoryScopeLockHeld();
  try {
    await link(source, destination);
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) {
      if (!(await isSameFile(source, destination))) throw error;
    } else if (hardLinksUnsupported(error)) {
      await copyWithoutReplacing(scopeDir, source, destination, times);
    } else {
      throw error;
    }
  }
  try {
    await unlink(source);
  } catch (error) {
    // Already gone: the destination is now the only copy, so it stays.
    if (isNodeError(error, 'ENOENT')) return;
    // Leave exactly one copy: the source, where it was.
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

async function copyWithoutReplacing(
  scopeDir: string,
  source: string,
  destination: string,
  times: MemoryFileTimes | undefined,
): Promise<void> {
  const directory = dirname(destination);
  const temporaryPath = memoryWriteTempPath(directory);
  try {
    const kept = times ?? (await lstat(source));
    await copyFile(source, temporaryPath, constants.COPYFILE_EXCL);
    await utimes(temporaryPath, kept.atime, kept.mtime);
    await assertMemoryPathContained(scopeDir, directory);
    await assertMemoryScopeLockHeld();
    await publishWithoutReplacing(temporaryPath, destination, false);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
