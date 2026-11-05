import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { RmOptions } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

/** The filesystem calls checkout cleanup makes on directories it removes. */
const nodeFs = { lstat, readdir, rm };

type AsarFreeFs = typeof nodeFs;

let originalFs: AsarFreeFs | null = null;

/** Shape check only: confirms the calls exist, not how they treat asar. */
function isAsarFreeFs(value: unknown): value is AsarFreeFs {
  return (
    typeof value === 'object' &&
    value !== null &&
    'lstat' in value &&
    typeof value.lstat === 'function' &&
    'readdir' in value &&
    typeof value.readdir === 'function' &&
    'rm' in value &&
    typeof value.rm === 'function'
  );
}

function loadOriginalFs(): AsarFreeFs {
  if (!originalFs) {
    // Resolved at runtime so the bundler leaves Electron's built-in
    // `original-fs` module as a plain require.
    const loaded: unknown = createRequire(__filename)('original-fs');
    if (
      typeof loaded !== 'object' ||
      loaded === null ||
      !('promises' in loaded) ||
      !isAsarFreeFs(loaded.promises)
    ) {
      // Deliberately no fallback to the patched `fs`: it would bring back the
      // ENOTEMPTY failure this module exists to prevent, with a worse message.
      throw new Error('Electron original-fs is unavailable.');
    }
    originalFs = loaded.promises;
  }
  return originalFs;
}

/**
 * Returns filesystem calls that treat `*.asar` files as plain files.
 *
 * Electron patches `fs` so `*.asar` files behave like read-only folders. Its
 * unpatched `original-fs` sees them as files. Plain Node (Jest, CLI) has no
 * asar patching, and a process that set `process.noAsar` has already turned
 * the redirection off, so the regular `fs` is used in both.
 */
export function fsWithoutAsar(): AsarFreeFs {
  if (process.versions.electron && !process.noAsar) {
    return loadOriginalFs();
  }
  return nodeFs;
}

/** Codes that mean something still holds the tree and may let go shortly. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'EBUSY',
  'ENOTEMPTY',
  'ETXTBSY',
]);

/** Codes a retry cannot fix, mapped to what the failure means. */
const PERMANENT_FAILURES: ReadonlyMap<string, string> = new Map([
  ['EACCES', 'permission denied'],
  ['EPERM', 'permission denied'],
  ['EROFS', 'read-only filesystem'],
  ['EXDEV', 'cross-device operation'],
]);

/** Node's default `retryDelay` for `fs.rm`. */
const DEFAULT_RETRY_DELAY_MS = 100;

/** A removal failure that retrying cannot fix, keeping the original error. */
export class RemoveTreePermanentError extends Error {
  readonly code: string;

  constructor(message: string, code: string, cause: unknown) {
    super(message);
    this.name = 'RemoveTreePermanentError';
    this.code = code;
    Object.defineProperty(this, 'cause', { value: cause, configurable: true });
  }
}

/**
 * Reads `code` without `instanceof Error`: errors raised by the native fs
 * binding can come from another realm (Jest, Electron).
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function causeMessage(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
    ? error.message
    : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Linux removal with an explicit retry loop.
 *
 * Node's built-in `maxRetries` also retries EPERM, which on Linux is a
 * permanent permission failure, so it is switched off and only the codes in
 * {@link TRANSIENT_CODES} are retried, `maxRetries` times with Node's linear
 * backoff.
 */
async function removeOnLinux(
  remove: AsarFreeFs['rm'],
  path: string,
  options: RmOptions | undefined,
): Promise<void> {
  const maxRetries = options?.maxRetries ?? 0;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError('maxRetries must be a finite nonnegative integer.');
  }
  const retryDelay = Math.max(0, options?.retryDelay ?? DEFAULT_RETRY_DELAY_MS);
  const attemptOptions: RmOptions = { ...options, maxRetries: 0 };
  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(path, attemptOptions);
      return;
    } catch (error) {
      const code = errorCode(error);
      const meaning =
        code === undefined ? undefined : PERMANENT_FAILURES.get(code);
      if (code !== undefined && meaning !== undefined) {
        throw new RemoveTreePermanentError(
          `Could not remove ${path}: ${meaning} (${code}): ${causeMessage(error)}`,
          code,
          error,
        );
      }
      if (
        code === undefined ||
        !TRANSIENT_CODES.has(code) ||
        attempt >= maxRetries
      ) {
        throw error;
      }
      await sleep(retryDelay * (attempt + 1));
    }
  }
}

/**
 * Removes a directory tree that may contain checkout contents.
 *
 * A patched recursive `rm` descends into `*.asar` files instead of unlinking
 * them, and the parent `rmdir` then fails with ENOTEMPTY (for example
 * `node_modules/electron/dist/.../default_app.asar`). Removing through
 * {@link fsWithoutAsar} unlinks them as plain files.
 *
 * On Linux, retries are owned here: only EBUSY, ENOTEMPTY and ETXTBSY are
 * retried (bounded by `maxRetries`/`retryDelay`), and permission, read-only
 * and cross-device failures are reported at once as
 * {@link RemoveTreePermanentError}. macOS and Windows keep Node's behavior.
 */
export async function removeTreeWithoutAsar(
  path: string,
  options?: RmOptions,
): Promise<void> {
  const { rm: remove } = fsWithoutAsar();
  if (hostOperatingSystem() === 'linux') {
    await removeOnLinux(remove, path, options);
    return;
  }
  await remove(path, options);
}
