import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import type {
  PlatformRenameRequest as Request,
  PlatformRenameResult as Result,
} from '@canopy/core-runtime';
import { flushDirectory, openDirectoryForFlush } from '../directory-flush';
import { errorCode, sameNode, secureFileError } from './shared';

export interface SecureFileOperations {
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly link: (from: string, to: string) => Promise<void>;
  readonly unlink: (target: string) => Promise<void>;
  readonly openDirectory: (
    target: string,
  ) => Promise<{ sync(): Promise<void>; close(): Promise<void> }>;
}

export const NODE_OPERATIONS: SecureFileOperations = {
  rename,
  link,
  unlink,
  openDirectory: (target) =>
    open(target, constants.O_RDONLY | constants.O_DIRECTORY),
};

/** Windows opens directories as the shared D1 flush does. */
export const WINDOWS_OPERATIONS: SecureFileOperations = {
  ...NODE_OPERATIONS,
  openDirectory: (target) => openDirectoryForFlush(target, 'win32'),
};

/** `attempts` counts total tries; 1 disables retry. */
export interface RetryPolicy {
  readonly attempts: number;
  readonly delay: (ms: number) => Promise<void>;
}

// Windows scanners and indexers briefly hold new files open.
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const NO_LINK_CODES = new Set([
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
  'EMLINK',
]);
const RENAMED: Result = { kind: 'renamed', sourceState: 'removed' };
const RETAINED: Result = { kind: 'renamed', sourceState: 'retained' };

async function withRetry(
  run: () => Promise<void>,
  policy: RetryPolicy,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const code = errorCode(error) ?? '';
      if (attempt >= policy.attempts || !LOCK_CODES.has(code)) throw error;
      await policy.delay(50 * attempt);
    }
  }
}

const node = (target: string): Promise<BigIntStats | null> =>
  lstat(target, { bigint: true }).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });

function assertRegular(stats: BigIntStats | null, role: string): void {
  if (stats !== null && !stats.isFile()) {
    throw secureFileError('not_regular_file', `${role} is not a regular file`);
  }
}

function assertSource(stats: BigIntStats): void {
  assertRegular(stats, 'rename source');
  if (stats.nlink !== BigInt(1)) {
    throw secureFileError(
      'not_regular_file',
      'rename source has multiple links',
    );
  }
}

/**
 * Singly-linked regular sources, inside caller-private parents. Identity re-checks
 * narrow, but do not eliminate, races with another local process there.
 * No-replace publishes by hard link, never by copy, and never touches an
 * existing target. `posixLinks` maps EPERM from link(2) to unsupported.
 */
export async function renameRegularFile(
  { from, to, mode }: Request,
  operations: SecureFileOperations,
  policy: RetryPolicy,
  posixLinks: boolean,
): Promise<Result> {
  const source = await lstat(from, { bigint: true });
  assertSource(source);
  const requireSource = async (): Promise<void> => {
    const current = await node(from);
    if (current === null || !sameNode(source, current)) {
      throw secureFileError('source_changed', 'rename source changed');
    }
    assertSource(current);
  };
  if (mode === 'replace') {
    await withRetry(async () => {
      await requireSource();
      assertRegular(await node(to), 'rename target');
      await operations.rename(from, to);
    }, policy);
    try {
      const remaining = await node(from);
      if (remaining === null) return RENAMED;
      return sameNode(source, remaining)
        ? RETAINED
        : { kind: 'renamed', sourceState: 'changed-or-absent' };
    } catch {
      return { kind: 'renamed', sourceState: 'unknown' };
    }
  }
  try {
    await withRetry(async () => {
      await requireSource();
      await operations.link(from, to);
    }, policy);
  } catch (error) {
    const code = errorCode(error) ?? '';
    if (code === 'EEXIST') return { kind: 'exists' };
    if (NO_LINK_CODES.has(code) || (posixLinks && code === 'EPERM')) {
      throw secureFileError('hard_links_unsupported', 'hard links unavailable');
    }
    throw error;
  }
  const [published, current] = [await node(to), await node(from)];
  if (published === null || !sameNode(source, published)) {
    // Roll back only a link of the swapped source still at `from`; any other
    // node at `to` is not ours to remove.
    if (published && current && sameNode(published, current)) {
      await operations.unlink(to);
    }
    throw secureFileError('source_changed', 'rename source changed');
  }
  // A replaced or missing source is not ours to unlink after publication.
  if (current === null || !sameNode(source, current)) {
    return { kind: 'renamed', sourceState: 'changed-or-absent' };
  }
  try {
    await withRetry(async () => {
      // A lock retry must not unlink a replacement that appeared while waiting.
      const remaining = await node(from);
      if (remaining === null || !sameNode(source, remaining)) {
        throw secureFileError('source_changed', 'rename source changed');
      }
      await operations.unlink(from);
    }, policy);
    return RENAMED;
  } catch {
    // Already published; retrying publication could clobber a newer target.
    try {
      const remaining = await node(from);
      return remaining && sameNode(source, remaining)
        ? RETAINED
        : { kind: 'renamed', sourceState: 'changed-or-absent' };
    } catch {
      return { kind: 'renamed', sourceState: 'unknown' };
    }
  }
}

export function syncDirectory(
  target: string,
  operations: SecureFileOperations,
): Promise<'flushed'> {
  return flushDirectory(target, { openDirectory: operations.openDirectory });
}
