import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { BrowserProfileError } from '../../browser-profile-error';
import { renameWithRetry } from '@canopy/execution-engine/node/lib/rename-with-retry';

const queues = new Map<string, Promise<unknown>>();
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

export async function readProfileJson(path: string): Promise<unknown> {
  try {
    if ((await stat(path)).size > MAX_METADATA_BYTES)
      throw new Error('Metadata exceeds the supported size.');
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new BrowserProfileError(
      'recovery_required',
      'Browser profile metadata could not be read. Original files were preserved.',
    );
  }
}

const TEMPORARY_SUFFIX =
  /^\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/**
 * Whether `name` is an unrenamed temporary for `target`: writeProfileJson's
 * `<target>.<pid>.<uuid>.tmp`, which earlier repository versions also left,
 * or the repository's durable writer's `.<target>.<pid>.<uuid>.tmp`
 * (writeFileAtomically). Keep both in step with their writers.
 */
export function isProfileJsonTemporary(name: string, target: string): boolean {
  const prefix = [target, `.${target}`].find((candidate) =>
    name.startsWith(candidate),
  );
  return (
    prefix !== undefined && TEMPORARY_SUFFIX.test(name.slice(prefix.length))
  );
}

export async function writeProfileJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Termination before the rename leaves this file; keep isProfileJsonTemporary in step.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.close();
    await renameWithRetry(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isDead(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
}

interface Lease {
  pid: number;
  token: string;
}
function readLease(value: unknown): Lease | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('pid' in value) ||
    !('token' in value) ||
    typeof value.token !== 'string' ||
    !Number.isSafeInteger(value.pid)
  )
    return null;
  return { pid: Number(value.pid), token: value.token };
}

async function acquireLease(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'writer.lock');
  const mine: Lease = { pid: process.pid, token: randomUUID() };
  const claim = async (): Promise<void> => {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(mine));
    } finally {
      await handle.close();
    }
  };
  try {
    await claim();
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const old = readLease(await readProfileJson(path));
    if (!old || !isDead(old.pid))
      throw new BrowserProfileError(
        'storage_unavailable',
        'Browser profile metadata is in use by another process. Retry when it finishes.',
      );
    // Every stale removal holds this exclusive guard. Never recursively reap
    // this guard: a crash during reclamation requires explicit recovery.
    const reclaimPath = join(root, 'reclaim.lock');
    let reclaim;
    try {
      reclaim = await open(reclaimPath, 'wx', 0o600);
    } catch {
      throw new BrowserProfileError(
        'recovery_required',
        'Browser profile lock recovery is already in progress.',
      );
    }
    try {
      await reclaim.writeFile(JSON.stringify(mine));
      const current = readLease(await readProfileJson(path));
      if (current?.token !== old.token || !isDead(current.pid))
        throw new BrowserProfileError(
          'storage_unavailable',
          'Browser profile lock ownership changed. Retry the operation.',
        );
      await rm(path);
      try {
        await claim();
      } catch {
        throw new BrowserProfileError(
          'storage_unavailable',
          'Another process acquired the browser profile metadata. Retry the operation.',
        );
      }
    } finally {
      await reclaim.close();
      await rm(reclaimPath, { force: true });
    }
  }
  return async () => {
    const current = readLease(await readProfileJson(path));
    if (current?.token === mine.token) await rm(path, { force: true });
  };
}

/** Shared by Electron and CLI; no TTL can steal ownership from a live PID. */
export function withProfileWriter<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = resolve(root);
  const previous = queues.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const release = await acquireLease(key);
      try {
        return await action();
      } finally {
        await release();
      }
    });
  queues.set(key, operation);
  void operation
    .finally(() => {
      if (queues.get(key) === operation) queues.delete(key);
    })
    .catch(() => undefined);
  return operation;
}
