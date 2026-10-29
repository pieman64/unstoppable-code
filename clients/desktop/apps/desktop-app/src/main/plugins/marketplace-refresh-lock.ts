import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getDataDir } from '../lib/paths';

const LOCK_POLL_MS = 100;
const LOCK_MAX_WAIT_MS = 10 * 60 * 1000;
const INCOMPLETE_OWNER_GRACE_MS = 30_000;
const MISSING_LOCK = Symbol('missing-lock');

interface MarketplaceRefreshLockOwner {
  version: 1;
  pid: number;
  nonce: string;
  createdAt: string;
}

async function canonicalizeProviderRoot(root: string): Promise<string> {
  const suffix: string[] = [];
  let existingAncestor = path.resolve(root);
  while (true) {
    try {
      return path.join(await realpath(existingAncestor), ...suffix.reverse());
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return path.resolve(root);
      suffix.push(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function canonicalProviderStateRoots(): Promise<string[]> {
  const claudeConfigDir =
    process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), '.claude');
  const codexHome =
    process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex');
  const roots = await Promise.all(
    [claudeConfigDir, codexHome].map(canonicalizeProviderRoot),
  );
  return Array.from(
    new Set(
      roots.map((root) =>
        process.platform === 'win32' ? root.toLowerCase() : root,
      ),
    ),
  ).sort();
}

function marketplaceRefreshLockPath(
  lockRoot: string,
  providerRoot: string,
): string {
  const testScope = process.env.NODE_ENV === 'test' ? `:${process.pid}` : '';
  const identityHash = createHash('sha256')
    .update(`${providerRoot}${testScope}`)
    .digest('hex')
    .slice(0, 24);
  return path.join(lockRoot, `provider-${identityHash}.lock`);
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
    throw new Error(
      `Refusing symbolic link for refresh lock ${expected}: ${target}`,
    );
  }
  const matchesType =
    expected === 'directory' ? targetStat.isDirectory() : targetStat.isFile();
  if (!matchesType) {
    throw new Error(`Refresh lock ${expected} has the wrong type: ${target}`);
  }
  if (
    typeof process.getuid === 'function' &&
    targetStat.uid !== process.getuid()
  ) {
    throw new Error(
      `Refresh lock ${expected} is not owned by this user: ${target}`,
    );
  }
}

async function ensurePrivateLockRoot(): Promise<string> {
  const lockRoot = path.join(getDataDir(), 'locks', 'marketplace-refresh');
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await assertOwnedPath(lockRoot, 'directory');
  if (process.platform !== 'win32') {
    await chmod(lockRoot, 0o700);
  }
  return lockRoot;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function parseLockOwner(contents: string): MarketplaceRefreshLockOwner | null {
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
  const reclaimOwner: MarketplaceRefreshLockOwner = {
    version: 1,
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };

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
  owner: MarketplaceRefreshLockOwner,
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
  owner: MarketplaceRefreshLockOwner,
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

/** Serializes provider marketplace mutations across app processes sharing state. */
async function withSingleMarketplaceRefreshLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const owner: MarketplaceRefreshLockOwner = {
      version: 1,
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    };
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
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      continue;
    }

    try {
      await handle.writeFile(JSON.stringify(owner), 'utf8');
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await assertOwnedPath(lockPath, 'file');
    try {
      return await operation();
    } finally {
      await releaseOwnedLock(lockPath, owner);
    }
  }

  throw new Error(
    'Timed out waiting for the provider marketplace refresh lock.',
  );
}

/** Serializes provider mutations by acquiring each canonical state-root lock. */
export async function withMarketplaceRefreshLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const lockRoot = await ensurePrivateLockRoot();
  const lockPaths = (await canonicalProviderStateRoots()).map((providerRoot) =>
    marketplaceRefreshLockPath(lockRoot, providerRoot),
  );
  const acquireAt = (index: number): Promise<T> =>
    index === lockPaths.length
      ? operation()
      : withSingleMarketplaceRefreshLock(lockPaths[index], () =>
          acquireAt(index + 1),
        );
  return acquireAt(0);
}
