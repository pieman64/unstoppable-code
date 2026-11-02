/**
 * Leaf reader/parser for the Work Entry registry file
 * (`workspaces/{workspaceId}/work-entries.json`).
 *
 * Deliberately split out of `cowork-work-entries.ts`: that module imports
 * `APP_ADVISOR_PROJECT_ID` as a *value* from `@canopy/desktop-shared/types`,
 * which pulls the whole types barrel (and, transitively, the brand runtime) in
 * at require time. The telemetry sync service only needs to read the registry,
 * and it runs in suites that stub the brand module, so importing the full
 * registry there would fail the suite at module load.
 *
 * Everything here is type-only at the boundary plus pure fs/path/validation
 * helpers, so the import graph stays narrow. `cowork-work-entries.ts`
 * re-exports both functions, which remain the single implementation.
 */
import { readFile } from 'node:fs/promises';
import type {
  CoworkWorkEntriesFile,
  CoworkWorkEntryData,
  CoworkWorkEntrySummary,
} from '@canopy/desktop-shared/types';
import { getWorkspaceWorkEntriesFilePath } from './paths';
import { isRecord, isErrnoException } from './type-guards';

export const EMPTY_WORK_ENTRIES_FILE: CoworkWorkEntriesFile = {
  version: 1,
  entries: [],
};

/**
 * Mirrors `SAFE_ID_RE` in `./validation`. Inlined rather than imported because
 * `validation.ts` imports `@canopy/desktop-shared/types` as a value, which is
 * the exact require-time dependency this leaf module exists to avoid.
 */
const SAFE_WORK_ENTRY_ID = /^[a-z0-9][a-z0-9-]*$/;

export function isWorkEntryData(value: unknown): value is CoworkWorkEntryData {
  if (!isRecord(value) || typeof value.id !== 'string') return false;
  if (!SAFE_WORK_ENTRY_ID.test(value.id)) return false;
  return (
    typeof value.createdAt === 'string' &&
    (value.title === undefined || typeof value.title === 'string')
    // `status` is deliberately NOT validated here — `normalizeWorkEntryStatus`
    // narrows every unrecognized shape (unknown string, number, object) to
    // absent. Rejecting the row instead would make one bad status blank the
    // whole workspace, which is the failure this normalization exists to avoid.
  );
}

/**
 * Narrow a persisted `status` to the values this build understands, treating
 * anything else as absent (which reads as "active").
 *
 * `parseWorkEntriesFile` is all-or-nothing and `readWorkEntriesFile` swallows a
 * parse failure into an EMPTY registry, so rejecting an unrecognized status
 * would make a single row written by a NEWER build hide every Work Entry in the
 * workspace — a far worse outcome than ignoring a value this build cannot act
 * on.
 *
 * Scope of the guarantee: READS are lenient. WRITES are still lossy — every
 * mutation path (`updateWorkEntry`, `reorderWorkEntries`, `removeWorkEntryRow`,
 * `createWorkEntry`) reads the whole registry through this parser and rewrites
 * it, so an older build renaming entry A drops an unrecognized status on
 * untouched entry B. That is an accepted tradeoff, not an oversight: it
 * replaces a loud failure that hid every entry with a silent one that loses a
 * single field this build never understood. Revisit if `status` ever gains a
 * value old builds must preserve.
 */
function normalizeWorkEntryStatus(
  value: unknown,
): CoworkWorkEntryData['status'] {
  return value === 'active' || value === 'done' ? value : undefined;
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function isProviderType(value: unknown): boolean {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'ollama' ||
    value === 'opencode'
  );
}

function isUnreadChatRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.chatId === 'string' &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.providerType === undefined || isProviderType(value.providerType)) &&
    (value.preview === undefined || typeof value.preview === 'string') &&
    (value.markedUnread === undefined ||
      typeof value.markedUnread === 'boolean')
  );
}

/** Shape check only; summaries are written already normalized. */
function isCompactPluginSelections(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.collectionIds) &&
    Array.isArray(value.skillRefs) &&
    Array.isArray(value.pluginRefs)
  );
}

function isWorkEntryChatSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.lastMessageAt === 'string' &&
    (value.lastMessageRole === undefined ||
      value.lastMessageRole === 'user' ||
      value.lastMessageRole === 'assistant') &&
    (value.description === undefined ||
      typeof value.description === 'string') &&
    (value.providerType === undefined || isProviderType(value.providerType)) &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.unread === undefined || typeof value.unread === 'boolean') &&
    (value.pluginSelections === undefined ||
      isCompactPluginSelections(value.pluginSelections))
  );
}

function isWorkEntrySummary(value: unknown): value is CoworkWorkEntrySummary {
  return (
    isRecord(value) &&
    value.version === 1 &&
    (value.sourceMtimeNs === undefined ||
      typeof value.sourceMtimeNs === 'string') &&
    typeof value.title === 'string' &&
    Number.isInteger(value.chatCount) &&
    Number(value.chatCount) >= 0 &&
    (value.lastMessageAt === undefined ||
      typeof value.lastMessageAt === 'string') &&
    (value.providerType === undefined || isProviderType(value.providerType)) &&
    (value.sharedRun === undefined || isRecord(value.sharedRun)) &&
    (value.unreadChats === undefined ||
      (Array.isArray(value.unreadChats) &&
        value.unreadChats.every(isUnreadChatRef))) &&
    Array.isArray(value.chats) &&
    value.chats.every(isWorkEntryChatSummary)
  );
}

function parseWorkEntryRows(raw: string): CoworkWorkEntryData[] {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.entries) ||
    !parsed.entries.every(isWorkEntryData)
  ) {
    throw new Error('Invalid work-entry registry');
  }
  return parsed.entries;
}

export function parseWorkEntriesFile(raw: string): CoworkWorkEntriesFile {
  const entries = parseWorkEntryRows(raw);
  return {
    version: 1,
    entries: entries.map((entry) => {
      const normalized: CoworkWorkEntryData = { ...entry };
      if (entry.pinned !== true) {
        delete normalized.pinned;
      }
      if (entry.hasUserChanges !== true) {
        delete normalized.hasUserChanges;
      }
      const status = normalizeWorkEntryStatus(entry.status);
      if (status === undefined) {
        // Drop the key entirely rather than setting it to `undefined`, so the
        // parsed shape matches a row that never carried a status at all.
        delete normalized.status;
      } else {
        normalized.status = status;
      }
      const lastTouchedAt = normalizeIsoTimestamp(entry.lastTouchedAt);
      if (lastTouchedAt === undefined) {
        delete normalized.lastTouchedAt;
      } else {
        normalized.lastTouchedAt = lastTouchedAt;
      }
      delete (
        normalized as CoworkWorkEntryData & {
          autoArchiveLocked?: boolean;
        }
      ).autoArchiveLocked;
      // A malformed or newer summary must not blank the whole registry. It is
      // safe to discard because the list path can rebuild this derived field
      // from the owning chat file.
      if (!isWorkEntrySummary(entry.summary)) {
        delete normalized.summary;
      }
      return normalized;
    }),
  };
}

/**
 * Count registry rows without normalizing status or walking derived summaries.
 * The top-level shape and every row identity are still validated so corrupt
 * registries retain the same lenient zero-entry behavior as the full reader.
 */
export function parseWorkEntryCount(raw: string): number {
  return parseWorkEntryRows(raw).length;
}

export interface WorkEntrySidebarSummary {
  count: number;
  /** Latest persisted activity across every entry in the workspace. */
  lastActivityAt?: string;
}

/**
 * Project the fields the top-level sidebar needs without hydrating chat files
 * or validating the full derived-summary payload.
 */
export function parseWorkEntrySidebarSummary(
  raw: string,
): WorkEntrySidebarSummary {
  const entries = parseWorkEntryRows(raw);
  let latestActivityMs: number | undefined;
  const record = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const parsed = Date.parse(value);
    if (
      Number.isFinite(parsed) &&
      (latestActivityMs === undefined || parsed > latestActivityMs)
    ) {
      latestActivityMs = parsed;
    }
  };

  for (const entry of entries) {
    record(entry.createdAt);
    record(entry.lastTouchedAt);
    if (isRecord(entry.summary)) {
      record(entry.summary.lastMessageAt);
    }
  }

  return {
    count: entries.length,
    ...(latestActivityMs === undefined
      ? {}
      : { lastActivityAt: new Date(latestActivityMs).toISOString() }),
  };
}

/** Lenient read: any read/validation failure yields an empty registry. */
export async function readWorkEntriesFile(
  workspaceId: string,
  options?: { strict?: boolean },
): Promise<CoworkWorkEntriesFile> {
  const filePath = getWorkspaceWorkEntriesFilePath(workspaceId);
  try {
    return parseWorkEntriesFile(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (
      options?.strict &&
      !(isErrnoException(error) && error.code === 'ENOENT')
    )
      throw error;
    return EMPTY_WORK_ENTRIES_FILE;
  }
}

/** Lenient count read: any read/validation failure yields zero entries. */
export async function readWorkEntryCount(workspaceId: string): Promise<number> {
  const filePath = getWorkspaceWorkEntriesFilePath(workspaceId);
  try {
    return parseWorkEntryCount(await readFile(filePath, 'utf8'));
  } catch {
    return 0;
  }
}

/** Lenient sidebar projection: any read/validation failure yields no activity. */
export async function readWorkEntrySidebarSummary(
  workspaceId: string,
): Promise<WorkEntrySidebarSummary> {
  const filePath = getWorkspaceWorkEntriesFilePath(workspaceId);
  try {
    return parseWorkEntrySidebarSummary(await readFile(filePath, 'utf8'));
  } catch {
    return { count: 0 };
  }
}
