// Pure canopy.json rules shared by the desktop parser and the cloud server
// (REG-3023). `apps/web` may not import `@canopy/desktop-shared`, so it reads
// the `repos[]` section of canopy.json through this module. Only the id and
// `repos[]` entry subset can live here: the rest of the desktop parser needs
// `node:path` and the brand. The desktop parser stays the reference, and
// `canopy-json-repos-parity.test.ts` there keeps the two in step. Everything
// here is pure: no transport, no Node, no React.

/** An id in canopy.json (repo ids, script ids, hook ids). */
export const CANOPY_JSON_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isCanopyJsonId(value: unknown): value is string {
  return typeof value === 'string' && CANOPY_JSON_ID_PATTERN.test(value);
}

/** The keys of a `repos[]` entry. Any other key is dropped silently. */
export const CANOPY_JSON_REPO_ENTRY_KEYS = [
  'id',
  'name',
  'url',
  'scripts',
  'hooks',
] as const;

export interface CanopyJsonRepoEntry {
  id: string;
  name: string;
  url: string;
  /** Left unvalidated: the consumer checks the script values. */
  scripts?: Readonly<Record<string, unknown>>;
}

export type CanopyJsonRepoEntriesFailureReason =
  | 'not-an-array'
  | 'entry-not-an-object'
  | 'invalid-id'
  | 'missing-name'
  | 'missing-url'
  | 'duplicate-id'
  | 'invalid-scripts';

export type CanopyJsonRepoEntriesResult =
  | { ok: true; repos: readonly CanopyJsonRepoEntry[] }
  | {
      ok: false;
      reason: CanopyJsonRepoEntriesFailureReason;
      /** Position in `repos` of the entry that failed. */
      index?: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the `repos` value of a canopy.json file. Mirrors the desktop's strict
 * parser: `hooks` is read through and not returned, and the URL is only
 * required to be non-empty, since each consumer applies its own URL rule.
 */
export function readCanopyJsonRepoEntries(
  value: unknown,
): CanopyJsonRepoEntriesResult {
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'not-an-array' };
  }

  const entries: readonly unknown[] = value;
  const seenIds = new Set<string>();
  const repos: CanopyJsonRepoEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry)) {
      return { ok: false, reason: 'entry-not-an-object', index };
    }
    const { id, name, url, scripts } = entry;
    if (!isCanopyJsonId(id)) {
      return { ok: false, reason: 'invalid-id', index };
    }
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, reason: 'missing-name', index };
    }
    if (typeof url !== 'string' || !url.trim()) {
      return { ok: false, reason: 'missing-url', index };
    }
    if (scripts !== undefined && !isRecord(scripts)) {
      return { ok: false, reason: 'invalid-scripts', index };
    }
    if (seenIds.has(id)) {
      return { ok: false, reason: 'duplicate-id', index };
    }
    seenIds.add(id);
    repos.push({
      id,
      name: name.trim(),
      url: url.trim(),
      ...(scripts === undefined ? {} : { scripts }),
    });
  }

  return { ok: true, repos };
}
