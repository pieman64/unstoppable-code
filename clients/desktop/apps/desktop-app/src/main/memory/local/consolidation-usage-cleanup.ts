import { access, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { memoryFileIdentity, topicIdentity } from './topic-identity';
import { deleteUsageEntries } from './usage';

const TOPICS_PREFIX = 'topics/';

function isSafeFileKey(scopeDir: string, fileKey: string): boolean {
  const relativePath = relative(scopeDir, join(scopeDir, fileKey));
  return (
    relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`)
  );
}

function isDefinitiveAbsenceError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function fileKeyExists(
  scopeDir: string,
  fileKey: string,
): Promise<boolean> {
  if (!isSafeFileKey(scopeDir, fileKey)) {
    return false;
  }
  try {
    await access(join(scopeDir, fileKey));
    return true;
  } catch (error) {
    // Only definitive absence may delete usage history. Ambiguous failures
    // (EACCES, EIO, interrupted syscalls, …) silently retain the row:
    // cleanup is advisory, and a transient error must never destroy the
    // usage evidence that gates pruning.
    return !isDefinitiveAbsenceError(error);
  }
}

/**
 * Identities of every entry in `topics/`, or null when the folder cannot be
 * listed for a reason other than being absent (then no topic row is stale).
 */
async function topicIdentities(scopeDir: string): Promise<Set<string> | null> {
  try {
    const names = await readdir(join(scopeDir, 'topics'));
    return new Set(names.map(topicIdentity));
  } catch (error) {
    return isDefinitiveAbsenceError(error) ? new Set() : null;
  }
}

/**
 * Deletes usage rows whose files are gone. Topic rows are keyed by topic
 * identity (case-folded), so a topic row is stale only when no file in
 * `topics/` has that identity: a direct path check would miss `Build.md`
 * for the row `topics/build.md` on a case-sensitive filesystem.
 */
export async function deleteStaleUsageRows(
  scopeDir: string,
  fileKeys: Iterable<string>,
): Promise<void> {
  const staleKeys: string[] = [];
  let topics: Set<string> | null | undefined;
  for (const fileKey of Array.from(fileKeys)) {
    const identity = memoryFileIdentity(fileKey);
    const topicName = identity.startsWith(TOPICS_PREFIX)
      ? identity.slice(TOPICS_PREFIX.length)
      : null;
    if (
      topicName !== null &&
      !topicName.includes('/') &&
      isSafeFileKey(scopeDir, fileKey)
    ) {
      topics ??= await topicIdentities(scopeDir);
      if (topics !== null && !topics.has(topicName)) staleKeys.push(fileKey);
      continue;
    }
    if (!(await fileKeyExists(scopeDir, fileKey))) {
      staleKeys.push(fileKey);
    }
  }
  if (staleKeys.length === 0) {
    return;
  }
  // Usage cleanup is advisory and best-effort; the store swallows
  // persistence failures and never fails consolidation.
  await deleteUsageEntries(scopeDir, staleKeys);
}
