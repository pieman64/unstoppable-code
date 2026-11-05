import { CHAT_HISTORY_PROFILE_FILE_KEY } from './chat-history-profile';
import type { ConsolidationInputFile } from './input';
import { MAX_UNUSED_DAYS } from './limits';
import { memoryFileIdentity } from './topic-identity';

const DAY_MS = 24 * 60 * 60 * 1_000;

export function parseTimestamp(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function compareUsageForRetention(
  left: Pick<ConsolidationInputFile, 'fileKey' | 'usage'>,
  right: Pick<ConsolidationInputFile, 'fileKey' | 'usage'>,
): number {
  return (
    right.usage.usageCount - left.usage.usageCount ||
    parseTimestamp(right.usage.lastUsedAt) -
      parseTimestamp(left.usage.lastUsedAt) ||
    left.fileKey.localeCompare(right.fileKey)
  );
}

// Usage counts SearchMemory hits, ReadMemory reads, and injection into a chat
// (topics linked from the injected index lines and quoted inbox notes). A
// topic the model recalls only from an index line that was cut from the
// injected excerpt still records nothing. Containment is the 90-day mtime
// floor below, the tracking-window gate, and archive-not-delete semantics.
export function shouldPruneMemoryFile(options: {
  fileKey: string;
  usageCount: number;
  createdAt: string;
  modifiedAt: string;
  // When continuous usage tracking started for this scope; null when the
  // usage store is absent or was unreadable.
  trackingSince: string | null;
  now: Date;
}): boolean {
  if (
    options.fileKey === 'MEMORY.md' ||
    (!options.fileKey.startsWith('topics/') &&
      !options.fileKey.startsWith('inbox/')) ||
    options.usageCount !== 0 ||
    // The chat history profile reaches every chat through its index line, so
    // its topic is rarely opened; a scan rewrites it rather than letting it
    // age out.
    memoryFileIdentity(options.fileKey) === CHAT_HISTORY_PROFILE_FILE_KEY
  ) {
    return false;
  }

  const nowMs = options.now.getTime();

  // A zero usage count is prune evidence only when tracking was continuously
  // active for the entire unused window. An absent, freshly created, or
  // reset-after-corruption usage store must never authorize deletion —
  // usage is advisory, and content remains intact when counters fail.
  if (options.trackingSince === null) {
    return false;
  }
  const trackingSinceMs = Date.parse(options.trackingSince);
  if (
    !Number.isFinite(trackingSinceMs) ||
    nowMs - trackingSinceMs < MAX_UNUSED_DAYS * DAY_MS
  ) {
    return false;
  }
  const createdAt = Date.parse(options.createdAt);
  const modifiedAt = Date.parse(options.modifiedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(modifiedAt)) {
    return false;
  }

  // The age gate on createdAt doubles as the "fresh memories haven't had a
  // chance to be searched" floor: a file cannot be pruned before it has
  // existed for the full unused window, which strictly subsumes any shorter
  // minimum-age requirement.
  const ageMs = nowMs - createdAt;
  const unmodifiedMs = nowMs - modifiedAt;
  return (
    ageMs >= MAX_UNUSED_DAYS * DAY_MS &&
    unmodifiedMs >= MAX_UNUSED_DAYS * DAY_MS
  );
}

const FILE_KEY_BOUNDARY = /[A-Za-z0-9._-]/;

// Matching is case-folded like topic identity (topic-identity.ts), as the
// prune set is: on macOS/Windows `topics/Legacy.md` and `topics/legacy.md`
// are the same file, so an index reference in either casing must be dropped
// when that topic is archived.
export function lineReferencesFileKey(line: string, fileKey: string): boolean {
  const foldedLine = line.toLowerCase();
  const foldedKey = fileKey.toLowerCase();
  let index = foldedLine.indexOf(foldedKey);
  while (index !== -1) {
    const before = index === 0 ? '' : foldedLine.charAt(index - 1);
    const after = foldedLine.charAt(index + foldedKey.length);
    if (!FILE_KEY_BOUNDARY.test(before) && !FILE_KEY_BOUNDARY.test(after)) {
      return true;
    }
    index = foldedLine.indexOf(foldedKey, index + 1);
  }
  return false;
}

// Removes index lines that clearly reference a pruned topic file, so the
// freshly written MEMORY.md never points at a file the prune pass is about
// to archive. Deliberately conservative: only whole lines containing the
// pruned `topics/<filename>` path as a delimited reference (never as a
// substring of a longer name) are dropped; every other line stays
// byte-identical.
export function stripPrunedIndexLines(
  memoryMd: string,
  prunedTopics: ConsolidationInputFile[],
): string {
  if (prunedTopics.length === 0) {
    return memoryMd;
  }
  const prunedKeys = prunedTopics.map((file) => file.fileKey);
  return memoryMd
    .split('\n')
    .filter(
      (line) => !prunedKeys.some((key) => lineReferencesFileKey(line, key)),
    )
    .join('\n');
}
