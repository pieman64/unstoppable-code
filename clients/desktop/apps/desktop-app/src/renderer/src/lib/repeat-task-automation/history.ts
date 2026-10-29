import {
  REPEAT_TASK_HISTORY_LIMIT,
  REPEAT_TASK_MIN_TOKENS,
  REPEAT_TASK_SIMILARITY_THRESHOLD,
  REPEAT_TASK_WINDOW_MS,
  signatureSimilarity,
} from './similarity';

export const REPEAT_TASK_HISTORY_STORAGE_KEY = 'canopy:repeat-task-history:v1';

export interface RepeatTaskHistoryEntry {
  id: string;
  scope: string;
  tokens: string[];
  lastRunAt: number;
  resolvedAt?: number;
}

export type RepeatTaskStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

export function repeatTaskScope(
  accountKey: string,
  workspaceId: string,
): string {
  return `${accountKey}\u0000${workspaceId}`;
}

function resolveStorage(storage?: RepeatTaskStorage): RepeatTaskStorage | null {
  if (storage !== undefined) return storage;

  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((token: unknown) => typeof token === 'string')
  );
}

function isRepeatTaskHistoryEntry(
  value: unknown,
): value is RepeatTaskHistoryEntry {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.scope !== 'string' ||
    value.scope.length === 0 ||
    typeof value.lastRunAt !== 'number' ||
    !Number.isFinite(value.lastRunAt) ||
    !isStringArray(value.tokens)
  ) {
    return false;
  }

  if (new Set(value.tokens).size < REPEAT_TASK_MIN_TOKENS) return false;
  return (
    value.resolvedAt === undefined ||
    (typeof value.resolvedAt === 'number' && Number.isFinite(value.resolvedAt))
  );
}

function readHistory(
  storage: RepeatTaskStorage | null,
): RepeatTaskHistoryEntry[] {
  if (!storage) return [];

  try {
    const raw = storage.getItem(REPEAT_TASK_HISTORY_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: RepeatTaskHistoryEntry[] = [];
    for (const rawEntry of parsed) {
      const entry: unknown = rawEntry;
      if (isRepeatTaskHistoryEntry(entry)) entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

function writeHistory(
  entries: readonly RepeatTaskHistoryEntry[],
  now: number,
  storage: RepeatTaskStorage | null,
): void {
  if (!storage) return;

  const withinWindow = entries.filter(
    (entry) => now - entry.lastRunAt <= REPEAT_TASK_WINDOW_MS,
  );
  const newestEntries =
    withinWindow.length > REPEAT_TASK_HISTORY_LIMIT
      ? withinWindow
          .sort((left, right) => left.lastRunAt - right.lastRunAt)
          .slice(-REPEAT_TASK_HISTORY_LIMIT)
      : withinWindow;

  try {
    storage.setItem(
      REPEAT_TASK_HISTORY_STORAGE_KEY,
      JSON.stringify(newestEntries),
    );
  } catch {
    return;
  }
}

function createEntryId(now: number): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // Use a local fallback when the platform UUID provider is unavailable.
  }

  return `repeat-task-${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function uniqueSortedTokens(tokens: readonly string[]): string[] {
  const uniqueTokens = new Set<string>();
  for (const token of tokens) uniqueTokens.add(token);
  return Array.from(uniqueTokens).sort();
}

export function recordRepeatTask(
  task: { scope: string; tokens: readonly string[] },
  now: number,
  storage?: RepeatTaskStorage,
): { entryId: string } | null {
  const tokens = uniqueSortedTokens(task.tokens);
  if (tokens.length < REPEAT_TASK_MIN_TOKENS) return null;

  const resolvedStorage = resolveStorage(storage);
  const entries = readHistory(resolvedStorage);
  let bestMatch: RepeatTaskHistoryEntry | undefined;
  let bestSimilarity = REPEAT_TASK_SIMILARITY_THRESHOLD;

  for (const entry of entries) {
    if (
      entry.scope !== task.scope ||
      now - entry.lastRunAt > REPEAT_TASK_WINDOW_MS
    ) {
      continue;
    }

    const similarity = signatureSimilarity(tokens, entry.tokens);
    if (similarity >= bestSimilarity) {
      if (bestMatch === undefined || similarity > bestSimilarity) {
        bestMatch = entry;
        bestSimilarity = similarity;
      }
    }
  }

  if (bestMatch !== undefined) {
    const updatedEntry: RepeatTaskHistoryEntry = {
      ...bestMatch,
      lastRunAt: now,
    };
    writeHistory(
      entries.map((entry) =>
        entry.id === bestMatch.id ? updatedEntry : entry,
      ),
      now,
      resolvedStorage,
    );
    return updatedEntry.resolvedAt === undefined
      ? { entryId: updatedEntry.id }
      : null;
  }

  const entry: RepeatTaskHistoryEntry = {
    id: createEntryId(now),
    scope: task.scope,
    tokens,
    lastRunAt: now,
  };
  writeHistory([...entries, entry], now, resolvedStorage);
  return null;
}

export function resolveRepeatTask(
  entryId: string,
  now: number,
  storage?: RepeatTaskStorage,
): void {
  const resolvedStorage = resolveStorage(storage);
  const entries = readHistory(resolvedStorage);
  if (!entries.some((entry) => entry.id === entryId)) return;

  writeHistory(
    entries.map((entry) =>
      entry.id === entryId ? { ...entry, resolvedAt: now } : entry,
    ),
    now,
    resolvedStorage,
  );
}

export function clearRepeatTaskHistory(storage?: RepeatTaskStorage): void {
  try {
    resolveStorage(storage)?.removeItem(REPEAT_TASK_HISTORY_STORAGE_KEY);
  } catch {
    return;
  }
}
