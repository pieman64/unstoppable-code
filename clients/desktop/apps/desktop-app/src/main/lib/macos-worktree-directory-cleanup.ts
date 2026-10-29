import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  getOrphanedWorktreeCleanupFilePath,
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreesRootDir,
} from './paths';
import { validateId } from './validation';
import { getWorktreeDeleteTimeoutMs } from './worktree-delete-config';

const ORPHANED_WORKTREE_CLEANUP_VERSION = 1;
const STAGED_WORKTREE_NAME_RE =
  /^\.([a-z0-9][a-z0-9-]*)\.deleting-([0-9a-f-]{36})$/;

interface OrphanedWorktreeCleanupEntry {
  workspaceId: string;
  worktreeId: string;
  repoId?: string;
  worktreePath: string;
  cleanupPath?: string;
  queuedAt: string;
  device: number;
  inode: number;
  lastAttemptAt?: string;
  lastError: string;
}

interface OrphanedWorktreeCleanupFile {
  version: typeof ORPHANED_WORKTREE_CLEANUP_VERSION;
  entries: OrphanedWorktreeCleanupEntry[];
}

let mutationQueue: Promise<void> = Promise.resolve();

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCleanupEntry(value: unknown): value is OrphanedWorktreeCleanupEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    typeof Reflect.get(value, 'workspaceId') === 'string' &&
    typeof Reflect.get(value, 'worktreeId') === 'string' &&
    (Reflect.get(value, 'repoId') === undefined ||
      typeof Reflect.get(value, 'repoId') === 'string') &&
    typeof Reflect.get(value, 'worktreePath') === 'string' &&
    (Reflect.get(value, 'cleanupPath') === undefined ||
      typeof Reflect.get(value, 'cleanupPath') === 'string') &&
    typeof Reflect.get(value, 'queuedAt') === 'string' &&
    typeof Reflect.get(value, 'device') === 'number' &&
    typeof Reflect.get(value, 'inode') === 'number' &&
    typeof Reflect.get(value, 'lastError') === 'string' &&
    (Reflect.get(value, 'lastAttemptAt') === undefined ||
      typeof Reflect.get(value, 'lastAttemptAt') === 'string')
  );
}

/**
 * Resolve and validate the only path the macOS native fallback may remove.
 * The candidate must exactly equal either the top-level directory derived from
 * the validated workspace/worktree ids or, when repoId is provided, that
 * repository's exact nested worktree directory.
 */
export function resolveExactWorktreeDirectoryTarget(
  workspaceId: string,
  worktreeId: string,
  candidatePath: string,
  repoId?: string,
): string {
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  if (repoId !== undefined) {
    validateId(repoId, 'repoId');
  }

  const expectedParent = resolve(
    repoId === undefined
      ? getWorkspaceWorktreesRootDir(workspaceId)
      : join(getWorkspaceWorktreeDir(workspaceId, worktreeId), 'repos'),
  );
  const expectedPath = resolve(
    repoId === undefined
      ? getWorkspaceWorktreeDir(workspaceId, worktreeId)
      : getWorkspaceWorktreeRepoDir(workspaceId, worktreeId, repoId),
  );
  const expectedName = repoId ?? worktreeId;
  const resolvedCandidate = resolve(candidatePath);

  if (
    expectedPath === expectedParent ||
    dirname(expectedPath) !== expectedParent ||
    basename(expectedPath) !== expectedName ||
    resolvedCandidate !== expectedPath
  ) {
    throw new Error(
      `Refusing native worktree removal outside the exact worktree directory: ${candidatePath}`,
    );
  }

  return expectedPath;
}

function resolveWorktreeCleanupTarget(
  workspaceId: string,
  worktreeId: string,
  worktreePath: string,
  cleanupPath?: string,
  repoId?: string,
): string {
  const exactWorktreePath = resolveExactWorktreeDirectoryTarget(
    workspaceId,
    worktreeId,
    worktreePath,
    repoId,
  );
  if (cleanupPath === undefined) {
    return exactWorktreePath;
  }

  const resolvedCleanupPath = resolve(cleanupPath);
  const cleanupName = basename(resolvedCleanupPath);
  const match = STAGED_WORKTREE_NAME_RE.exec(cleanupName);
  if (
    dirname(resolvedCleanupPath) !== dirname(exactWorktreePath) ||
    match?.[1] !== (repoId ?? worktreeId)
  ) {
    throw new Error(
      `Refusing staged worktree removal outside the validated worktree directory: ${cleanupPath}`,
    );
  }
  return resolvedCleanupPath;
}

function runNativeRm(worktreePath: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      '/bin/rm',
      ['-rf', '--', worktreePath],
      { timeout: getWorktreeDeleteTimeoutMs() },
      (error) => {
        if (error) {
          rejectPromise(
            error instanceof Error ? error : new Error('Native rm failed.'),
          );
          return;
        }
        resolvePromise();
      },
    );
  });
}

async function assertPathRemoved(worktreePath: string): Promise<void> {
  try {
    await lstat(worktreePath);
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  throw new Error(
    `Native rm completed but the worktree directory remains: ${worktreePath}`,
  );
}

export async function stageExactMacosWorktreeDirectoryForRemoval(
  workspaceId: string,
  worktreeId: string,
  candidatePath: string,
  repoId?: string,
): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('Staged worktree directory removal is macOS-only.');
  }
  const worktreePath = resolveExactWorktreeDirectoryTarget(
    workspaceId,
    worktreeId,
    candidatePath,
    repoId,
  );
  const stats = await lstat(worktreePath);
  if (!stats.isDirectory()) {
    throw new Error(
      `Refusing to stage a non-directory worktree path: ${worktreePath}`,
    );
  }
  const cleanupPath = join(
    dirname(worktreePath),
    `.${repoId ?? worktreeId}.deleting-${randomUUID()}`,
  );
  await enqueueMutation(async () => {
    const file = await readCleanupFile();
    upsertCleanupEntry(file, {
      workspaceId,
      worktreeId,
      repoId,
      worktreePath,
      cleanupPath,
      directoryIdentity: { device: stats.dev, inode: stats.ino },
      error: new Error('Staged worktree cleanup is pending.'),
    });
    await writeCleanupFile(file);
    try {
      await rename(worktreePath, cleanupPath);
    } catch (error) {
      removeCleanupEntry(file, {
        workspaceId,
        worktreeId,
        repoId,
        cleanupPath,
      });
      await writeCleanupFile(file).catch(() => undefined);
      throw error;
    }
  });
  return cleanupPath;
}

export async function restoreStagedMacosWorktreeDirectory(
  workspaceId: string,
  worktreeId: string,
  worktreePath: string,
  cleanupPath: string,
  repoId?: string,
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Staged worktree directory restoration is macOS-only.');
  }
  const validatedCleanupPath = resolveWorktreeCleanupTarget(
    workspaceId,
    worktreeId,
    worktreePath,
    cleanupPath,
    repoId,
  );
  await rename(validatedCleanupPath, resolve(worktreePath));
  await discardCleanupEntry({
    workspaceId,
    worktreeId,
    repoId,
    cleanupPath: validatedCleanupPath,
  }).catch(() => undefined);
}

export async function removeStagedMacosWorktreeDirectory(
  workspaceId: string,
  worktreeId: string,
  worktreePath: string,
  cleanupPath: string,
  repoId?: string,
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Staged worktree directory removal is macOS-only.');
  }
  const validatedCleanupPath = resolveWorktreeCleanupTarget(
    workspaceId,
    worktreeId,
    worktreePath,
    cleanupPath,
    repoId,
  );
  await runNativeRm(validatedCleanupPath);
  await assertPathRemoved(validatedCleanupPath);
  await discardCleanupEntry({
    workspaceId,
    worktreeId,
    repoId,
    cleanupPath: validatedCleanupPath,
  }).catch(() => undefined);
}

/**
 * macOS-only native fallback for deleting one exact top-level worktree
 * directory. This never invokes a shell and never accepts an arbitrary path.
 */
export async function removeExactMacosWorktreeDirectory(
  workspaceId: string,
  worktreeId: string,
  candidatePath: string,
  repoId?: string,
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Native worktree directory removal is macOS-only.');
  }

  const worktreePath = resolveExactWorktreeDirectoryTarget(
    workspaceId,
    worktreeId,
    candidatePath,
    repoId,
  );
  await runNativeRm(worktreePath);
  await assertPathRemoved(worktreePath);
}

async function readCleanupFile(): Promise<OrphanedWorktreeCleanupFile> {
  const filePath = getOrphanedWorktreeCleanupFilePath();
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    const entries: unknown =
      typeof parsed === 'object' && parsed !== null
        ? Reflect.get(parsed, 'entries')
        : undefined;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Reflect.get(parsed, 'version') !== ORPHANED_WORKTREE_CLEANUP_VERSION ||
      !Array.isArray(entries)
    ) {
      return { version: ORPHANED_WORKTREE_CLEANUP_VERSION, entries: [] };
    }
    return {
      version: ORPHANED_WORKTREE_CLEANUP_VERSION,
      entries: entries.filter(isCleanupEntry),
    };
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT') || error instanceof SyntaxError) {
      return { version: ORPHANED_WORKTREE_CLEANUP_VERSION, entries: [] };
    }
    throw error;
  }
}

async function writeCleanupFile(
  file: OrphanedWorktreeCleanupFile,
): Promise<void> {
  const filePath = getOrphanedWorktreeCleanupFilePath();
  if (file.entries.length === 0) {
    await rm(filePath, { force: true });
    return;
  }

  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let renamed = false;
  try {
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

function enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(mutation, mutation);
  mutationQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function upsertCleanupEntry(
  file: OrphanedWorktreeCleanupFile,
  options: {
    workspaceId: string;
    worktreeId: string;
    repoId?: string;
    worktreePath: string;
    cleanupPath?: string;
    directoryIdentity: { device: number; inode: number };
    error: unknown;
  },
): void {
  const cleanupPath = options.cleanupPath ?? options.worktreePath;
  const existing = file.entries.find(
    (entry) =>
      entry.workspaceId === options.workspaceId &&
      entry.worktreeId === options.worktreeId &&
      entry.repoId === options.repoId &&
      (entry.cleanupPath ?? entry.worktreePath) === cleanupPath,
  );
  if (existing) {
    existing.worktreePath = options.worktreePath;
    existing.cleanupPath = options.cleanupPath;
    existing.device = options.directoryIdentity.device;
    existing.inode = options.directoryIdentity.inode;
    existing.lastAttemptAt = new Date().toISOString();
    existing.lastError = errorMessage(options.error);
    return;
  }
  file.entries.push({
    workspaceId: options.workspaceId,
    worktreeId: options.worktreeId,
    repoId: options.repoId,
    worktreePath: options.worktreePath,
    cleanupPath: options.cleanupPath,
    queuedAt: new Date().toISOString(),
    device: options.directoryIdentity.device,
    inode: options.directoryIdentity.inode,
    lastError: errorMessage(options.error),
  });
}

function removeCleanupEntry(
  file: OrphanedWorktreeCleanupFile,
  target: {
    workspaceId: string;
    worktreeId: string;
    repoId?: string;
    cleanupPath: string;
  },
): void {
  file.entries = file.entries.filter(
    (entry) =>
      entry.workspaceId !== target.workspaceId ||
      entry.worktreeId !== target.worktreeId ||
      entry.repoId !== target.repoId ||
      (entry.cleanupPath ?? entry.worktreePath) !== target.cleanupPath,
  );
}

async function discardCleanupEntry(target: {
  workspaceId: string;
  worktreeId: string;
  repoId?: string;
  cleanupPath: string;
}): Promise<void> {
  await enqueueMutation(async () => {
    const file = await readCleanupFile();
    removeCleanupEntry(file, target);
    await writeCleanupFile(file);
  });
}

export async function queueOrphanedMacosWorktreeDirectory(options: {
  workspaceId: string;
  worktreeId: string;
  repoId?: string;
  worktreePath: string;
  cleanupPath?: string;
  error: unknown;
}): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }
  const worktreePath = resolveExactWorktreeDirectoryTarget(
    options.workspaceId,
    options.worktreeId,
    options.worktreePath,
    options.repoId,
  );
  const cleanupPath = resolveWorktreeCleanupTarget(
    options.workspaceId,
    options.worktreeId,
    worktreePath,
    options.cleanupPath,
    options.repoId,
  );
  let directoryIdentity: { device: number; inode: number };
  try {
    const stats = await lstat(cleanupPath);
    if (!stats.isDirectory()) {
      throw new Error(
        `Refusing to queue a non-directory worktree path: ${cleanupPath}`,
      );
    }
    directoryIdentity = { device: stats.dev, inode: stats.ino };
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  await enqueueMutation(async () => {
    const file = await readCleanupFile();
    upsertCleanupEntry(file, {
      workspaceId: options.workspaceId,
      worktreeId: options.worktreeId,
      repoId: options.repoId,
      worktreePath,
      cleanupPath: options.cleanupPath === undefined ? undefined : cleanupPath,
      directoryIdentity,
      error: options.error,
    });
    await writeCleanupFile(file);
  });
}

export async function sweepOrphanedMacosWorktreeDirectories(): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }
  await enqueueMutation(async () => {
    const file = await readCleanupFile();
    const remaining: OrphanedWorktreeCleanupEntry[] = [];

    for (const entry of file.entries) {
      try {
        const cleanupPath = resolveWorktreeCleanupTarget(
          entry.workspaceId,
          entry.worktreeId,
          entry.worktreePath,
          entry.cleanupPath,
          entry.repoId,
        );
        let stats: Awaited<ReturnType<typeof lstat>>;
        try {
          stats = await lstat(cleanupPath);
        } catch (error) {
          if (isNodeErrorCode(error, 'ENOENT')) {
            continue;
          }
          throw error;
        }
        if (
          !stats.isDirectory() ||
          stats.dev !== entry.device ||
          stats.ino !== entry.inode
        ) {
          // The original residue disappeared or was replaced. Drop the stale
          // queue entry without ever deleting the current path.
          // eslint-disable-next-line no-console
          console.warn(
            'Skipping stale orphaned worktree cleanup entry because the path identity changed.',
            {
              workspaceId: entry.workspaceId,
              worktreeId: entry.worktreeId,
              worktreePath: entry.worktreePath,
            },
          );
          continue;
        }
        await runNativeRm(cleanupPath);
        await assertPathRemoved(cleanupPath);
        // eslint-disable-next-line no-console
        console.info('Removed orphaned macOS worktree directory.', {
          workspaceId: entry.workspaceId,
          worktreeId: entry.worktreeId,
          worktreePath: entry.worktreePath,
        });
      } catch (error) {
        // Invalid/tampered entries are retained but never passed to /bin/rm.
        remaining.push({
          ...entry,
          lastAttemptAt: new Date().toISOString(),
          lastError: errorMessage(error),
        });
        // eslint-disable-next-line no-console
        console.warn('Failed to remove orphaned macOS worktree directory.', {
          workspaceId: entry.workspaceId,
          worktreeId: entry.worktreeId,
          worktreePath: entry.worktreePath,
          error: errorMessage(error),
        });
      }
    }

    await writeCleanupFile({
      version: ORPHANED_WORKTREE_CLEANUP_VERSION,
      entries: remaining,
    });
  });
}

export function resetOrphanedWorktreeCleanupQueueForTests(): void {
  mutationQueue = Promise.resolve();
}
