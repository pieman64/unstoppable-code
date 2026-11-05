import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import path from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

const DEFAULT_POLL_MS = 100;
const INCOMPLETE_OWNER_GRACE_MS = 30_000;
const MISSING_LOCK = Symbol('missing-lock');

interface OwnerLockRecord {
  version: 1;
  pid: number;
  nonce: string;
  createdAt: string;
}

export interface OwnerLockFileOptions {
  /** How long a waiter polls before it gives up. */
  maxWaitMs: number;
  pollMs?: number;
  timeoutMessage: string;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

async function assertOwnedPath(
  target: string,
  expected: 'directory' | 'file',
): Promise<void> {
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link for lock ${expected}: ${target}`);
  }
  const matchesType =
    expected === 'directory' ? targetStat.isDirectory() : targetStat.isFile();
  if (!matchesType) {
    throw new Error(`Lock ${expected} has the wrong type: ${target}`);
  }
  if (
    typeof process.getuid === 'function' &&
    targetStat.uid !== process.getuid()
  ) {
    throw new Error(`Lock ${expected} is not owned by this user: ${target}`);
  }
}

/** Creates `directory` private to this user, refusing a link or a foreign owner. */
export async function ensurePrivateLockDirectory(
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertOwnedPath(directory, 'directory');
  if (hostOperatingSystem() !== 'win32') {
    await chmod(directory, 0o700);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function parseLockOwner(contents: string): OwnerLockRecord | null {
  try {
    const value: unknown = JSON.parse(contents);
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      !('pid' in value) ||
      !('nonce' in value) ||
      !('createdAt' in value)
    ) {
      return null;
    }
    const version = value.version;
    const pid = value.pid;
    const nonce = value.nonce;
    const createdAt = value.createdAt;
    return version === 1 &&
      typeof pid === 'number' &&
      Number.isInteger(pid) &&
      typeof nonce === 'string' &&
      typeof createdAt === 'string'
      ? { version, pid, nonce, createdAt }
      : null;
  } catch {
    return null;
  }
}

function newOwner(): OwnerLockRecord {
  return {
    version: 1,
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

async function staleLockSnapshot(
  lockPath: string,
): Promise<string | typeof MISSING_LOCK | null> {
  try {
    await assertOwnedPath(lockPath, 'file');
    const contents = await readFile(lockPath, 'utf8');
    const owner = parseLockOwner(contents);
    if (owner) {
      return isProcessAlive(owner.pid) ? null : contents;
    }
    try {
      const lockStat = await stat(lockPath);
      return Date.now() - lockStat.mtimeMs >= INCOMPLETE_OWNER_GRACE_MS
        ? contents
        : null;
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? MISSING_LOCK : null;
    }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? MISSING_LOCK : null;
  }
}

async function tryReclaimStaleLock(lockPath: string): Promise<boolean> {
  const staleSnapshot = await staleLockSnapshot(lockPath);
  if (staleSnapshot === null) {
    return false;
  }
  if (staleSnapshot === MISSING_LOCK) {
    return true;
  }

  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimOwnerPath = path.join(reclaimPath, 'owner.json');
  const reclaimOwner = newOwner();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(reclaimPath, { mode: 0o700 });
      await assertOwnedPath(reclaimPath, 'directory');
      try {
        await writeFile(reclaimOwnerPath, JSON.stringify(reclaimOwner), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        await rmdir(reclaimPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      await assertOwnedPath(reclaimPath, 'directory');
      if (await removeStaleReclaimDirectory(reclaimPath, reclaimOwnerPath)) {
        continue;
      }
      return false;
    }

    try {
      const current = await readFile(lockPath, 'utf8').catch((error) => {
        if (errorCode(error) === 'ENOENT') {
          return MISSING_LOCK;
        }
        throw error;
      });
      if (current !== staleSnapshot) {
        return current === MISSING_LOCK;
      }
      await unlink(lockPath);
      return true;
    } finally {
      await releaseReclaimDirectory(
        reclaimPath,
        reclaimOwnerPath,
        reclaimOwner,
      );
    }
  }

  return false;
}

async function removeStaleReclaimDirectory(
  reclaimPath: string,
  ownerPath: string,
): Promise<boolean> {
  await assertOwnedPath(reclaimPath, 'directory');
  let snapshot: string;
  try {
    snapshot = await readFile(ownerPath, 'utf8');
    const owner = parseLockOwner(snapshot);
    if (owner) {
      if (isProcessAlive(owner.pid)) return false;
    } else if (
      Date.now() - (await stat(ownerPath)).mtimeMs <
      INCOMPLETE_OWNER_GRACE_MS
    ) {
      return false;
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return false;
    try {
      if (
        Date.now() - (await stat(reclaimPath)).mtimeMs <
        INCOMPLETE_OWNER_GRACE_MS
      ) {
        return false;
      }
      await rmdir(reclaimPath);
      return true;
    } catch {
      return false;
    }
  }

  try {
    if ((await readFile(ownerPath, 'utf8')) !== snapshot) return false;
    await unlink(ownerPath);
    await rmdir(reclaimPath);
    return true;
  } catch {
    return false;
  }
}

async function releaseReclaimDirectory(
  reclaimPath: string,
  ownerPath: string,
  owner: OwnerLockRecord,
): Promise<void> {
  try {
    await assertOwnedPath(reclaimPath, 'directory');
    const current = parseLockOwner(await readFile(ownerPath, 'utf8'));
    if (current?.nonce !== owner.nonce) return;
    await unlink(ownerPath);
    await rmdir(reclaimPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

async function releaseOwnedLock(
  lockPath: string,
  owner: OwnerLockRecord,
): Promise<void> {
  try {
    await assertOwnedPath(lockPath, 'file');
    const current = parseLockOwner(await readFile(lockPath, 'utf8'));
    if (current?.nonce === owner.nonce) {
      await unlink(lockPath);
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Runs `operation` while holding `lockPath`, an exclusively created
 * `{pid, nonce}` file in a private directory, across every process of this
 * user. A lock whose owner PID is gone is reclaimed; a live owner is never
 * displaced, so a waiter gives up after `maxWaitMs`.
 */
export async function withOwnerLockFile<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: OwnerLockFileOptions,
): Promise<T> {
  const deadline = Date.now() + options.maxWaitMs;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  while (Date.now() < deadline) {
    const owner = newOwner();
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      if (await tryReclaimStaleLock(lockPath)) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    try {
      await handle.writeFile(JSON.stringify(owner), 'utf8');
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    try {
      await handle.close();
    } catch (error) {
      // Left in place, this live-PID lock is never reclaimed: every later
      // waiter, in any process, times out after maxWaitMs.
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    await assertOwnedPath(lockPath, 'file');
    try {
      return await operation();
    } finally {
      await releaseOwnedLock(lockPath, owner);
    }
  }

  throw new Error(options.timeoutMessage);
}

function assertOwnedPathSync(
  target: string,
  expected: 'directory' | 'file',
): void {
  const targetStat = lstatSync(target);
  if (targetStat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link for lock ${expected}: ${target}`);
  }
  const matchesType =
    expected === 'directory' ? targetStat.isDirectory() : targetStat.isFile();
  if (!matchesType) {
    throw new Error(`Lock ${expected} has the wrong type: ${target}`);
  }
  if (
    typeof process.getuid === 'function' &&
    targetStat.uid !== process.getuid()
  ) {
    throw new Error(`Lock ${expected} is not owned by this user: ${target}`);
  }
}

/** Synchronous {@link ensurePrivateLockDirectory}. */
export function ensurePrivateLockDirectorySync(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertOwnedPathSync(directory, 'directory');
  if (hostOperatingSystem() !== 'win32') {
    chmodSync(directory, 0o700);
  }
}

function staleLockSnapshotSync(
  lockPath: string,
): string | typeof MISSING_LOCK | null {
  try {
    assertOwnedPathSync(lockPath, 'file');
    const contents = readFileSync(lockPath, 'utf8');
    const owner = parseLockOwner(contents);
    if (owner) {
      return isProcessAlive(owner.pid) ? null : contents;
    }
    try {
      const lockStat = statSync(lockPath);
      return Date.now() - lockStat.mtimeMs >= INCOMPLETE_OWNER_GRACE_MS
        ? contents
        : null;
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? MISSING_LOCK : null;
    }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? MISSING_LOCK : null;
  }
}

function tryReclaimStaleLockSync(lockPath: string): boolean {
  const staleSnapshot = staleLockSnapshotSync(lockPath);
  if (staleSnapshot === null) {
    return false;
  }
  if (staleSnapshot === MISSING_LOCK) {
    return true;
  }

  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimOwnerPath = path.join(reclaimPath, 'owner.json');
  const reclaimOwner = newOwner();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(reclaimPath, { mode: 0o700 });
      assertOwnedPathSync(reclaimPath, 'directory');
      try {
        writeFileSync(reclaimOwnerPath, JSON.stringify(reclaimOwner), {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      } catch (error) {
        try {
          rmdirSync(reclaimPath);
        } catch {
          // Preserve the original failure if cleanup also fails.
        }
        throw error;
      }
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
      assertOwnedPathSync(reclaimPath, 'directory');
      if (removeStaleReclaimDirectorySync(reclaimPath, reclaimOwnerPath)) {
        continue;
      }
      return false;
    }

    try {
      let current: string | typeof MISSING_LOCK;
      try {
        current = readFileSync(lockPath, 'utf8');
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        current = MISSING_LOCK;
      }
      if (current !== staleSnapshot) {
        return current === MISSING_LOCK;
      }
      unlinkSync(lockPath);
      return true;
    } finally {
      releaseReclaimDirectorySync(reclaimPath, reclaimOwnerPath, reclaimOwner);
    }
  }

  return false;
}

function removeStaleReclaimDirectorySync(
  reclaimPath: string,
  ownerPath: string,
): boolean {
  assertOwnedPathSync(reclaimPath, 'directory');
  let snapshot: string;
  try {
    snapshot = readFileSync(ownerPath, 'utf8');
    const owner = parseLockOwner(snapshot);
    if (owner) {
      if (isProcessAlive(owner.pid)) return false;
    } else if (
      Date.now() - statSync(ownerPath).mtimeMs <
      INCOMPLETE_OWNER_GRACE_MS
    ) {
      return false;
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return false;
    try {
      if (
        Date.now() - statSync(reclaimPath).mtimeMs <
        INCOMPLETE_OWNER_GRACE_MS
      ) {
        return false;
      }
      rmdirSync(reclaimPath);
      return true;
    } catch {
      return false;
    }
  }

  try {
    if (readFileSync(ownerPath, 'utf8') !== snapshot) return false;
    unlinkSync(ownerPath);
    rmdirSync(reclaimPath);
    return true;
  } catch {
    return false;
  }
}

function releaseReclaimDirectorySync(
  reclaimPath: string,
  ownerPath: string,
  owner: OwnerLockRecord,
): void {
  try {
    assertOwnedPathSync(reclaimPath, 'directory');
    const current = parseLockOwner(readFileSync(ownerPath, 'utf8'));
    if (current?.nonce !== owner.nonce) return;
    unlinkSync(ownerPath);
    rmdirSync(reclaimPath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function releaseOwnedLockSync(lockPath: string, owner: OwnerLockRecord): void {
  try {
    assertOwnedPathSync(lockPath, 'file');
    const current = parseLockOwner(readFileSync(lockPath, 'utf8'));
    if (current?.nonce === owner.nonce) {
      unlinkSync(lockPath);
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Synchronous {@link withOwnerLockFile}. Blocks between attempts and refuses
 * after `maxWaitMs`; `operation` must be synchronous.
 */
export function withOwnerLockFileSync<T>(
  lockPath: string,
  operation: () => T,
  options: OwnerLockFileOptions,
): T {
  const deadline = Date.now() + options.maxWaitMs;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  while (Date.now() < deadline) {
    const owner = newOwner();
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (tryReclaimStaleLockSync(lockPath)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
      continue;
    }
    try {
      writeFileSync(fd, JSON.stringify(owner), 'utf8');
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original failure if cleanup also fails.
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Preserve the original failure if cleanup also fails.
      }
      throw error;
    }
    try {
      closeSync(fd);
    } catch (error) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Preserve the original failure if cleanup also fails.
      }
      throw error;
    }
    assertOwnedPathSync(lockPath, 'file');
    try {
      return operation();
    } finally {
      releaseOwnedLockSync(lockPath, owner);
    }
  }
  throw new Error(options.timeoutMessage);
}
