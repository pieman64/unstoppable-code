import { readFile } from 'node:fs/promises';
import {
  readDesktopPreferencesRecord,
  type DirectoryReadPreferenceSourceOptions,
} from '../filesystem/directory-read-preferences';

const PRIMARY_PREFERENCES_FILE_NAME = 'preferences.json';
const LAST_GOOD_PREFERENCES_FILE_NAME = 'preferences.last-good.json';

export interface CodeGraphPreferenceSnapshot {
  readonly mode: 'enabled' | 'disabled' | 'selected-workspaces';
  readonly selectedWorkspaceIds: readonly string[];
  /** Whole minutes, 1 to 1,440. */
  readonly generationTimeoutMinutes: number;
}

export const DEFAULT_CODE_GRAPH_PREFERENCES: CodeGraphPreferenceSnapshot = {
  mode: 'enabled',
  selectedWorkspaceIds: [],
  generationTimeoutMinutes: 30,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

function readUtf8File(
  absolutePath: string,
  signal: AbortSignal,
): Promise<string> {
  return readFile(absolutePath, { encoding: 'utf8', signal });
}

/** Electron main's effective rule (`code-graph-availability.ts` normalizePreferences). */
export function normalizeCodeGraphPreferenceValue(
  value: unknown,
): CodeGraphPreferenceSnapshot {
  const preferences = isRecord(value) ? value : {};
  const mode =
    preferences.mode === 'disabled' ||
    preferences.mode === 'selected-workspaces'
      ? preferences.mode
      : 'enabled';
  const seen = new Set<string>();
  const selectedWorkspaceIds: string[] = [];
  const selected = Array.isArray(preferences.selectedWorkspaceIds)
    ? preferences.selectedWorkspaceIds
    : [];
  for (const id of selected) {
    if (typeof id !== 'string') {
      continue;
    }
    const trimmed = id.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    selectedWorkspaceIds.push(trimmed);
  }
  const timeout = preferences.generationTimeoutMinutes;
  return {
    mode,
    selectedWorkspaceIds,
    generationTimeoutMinutes:
      typeof timeout === 'number' &&
      Number.isInteger(timeout) &&
      timeout >= 1 &&
      timeout <= 1_440
        ? timeout
        : DEFAULT_CODE_GRAPH_PREFERENCES.generationTimeoutMinutes,
  };
}

export function isCodeGraphPreferenceEnabledForWorkspace(
  preferences: CodeGraphPreferenceSnapshot,
  workspaceId: string,
): boolean {
  if (preferences.mode === 'enabled') {
    return true;
  }
  return (
    preferences.mode === 'selected-workspaces' &&
    preferences.selectedWorkspaceIds.includes(workspaceId)
  );
}

export function sameCodeGraphPreferences(
  left: CodeGraphPreferenceSnapshot,
  right: CodeGraphPreferenceSnapshot,
): boolean {
  return (
    left.mode === right.mode &&
    left.generationTimeoutMinutes === right.generationTimeoutMinutes &&
    left.selectedWorkspaceIds.length === right.selectedWorkspaceIds.length &&
    left.selectedWorkspaceIds.every(
      (id, index) => right.selectedWorkspaceIds[index] === id,
    )
  );
}

export interface CodeGraphPreferenceSource {
  read(this: void, signal: AbortSignal): Promise<CodeGraphPreferenceSnapshot>;
}

/**
 * Read-only projection of the desktop's code-graph preferences for the
 * daemon (CAN-5629): `preferences.json`, else `preferences.last-good.json`,
 * else the defaults. Never writes, repairs or caches; Electron main stays
 * the single writer.
 */
export function createCodeGraphPreferenceSource(
  options: DirectoryReadPreferenceSourceOptions,
): CodeGraphPreferenceSource {
  const { canonicalDataRoot, paths } = options;
  if (!canonicalDataRoot || !paths.isAbsolute(canonicalDataRoot)) {
    throw new TypeError(
      'Code graph preferences require an absolute canonical data root.',
    );
  }
  const readText = options.readFile ?? readUtf8File;
  const primaryPath = paths.join(
    canonicalDataRoot,
    PRIMARY_PREFERENCES_FILE_NAME,
  );
  const lastGoodPath = paths.join(
    canonicalDataRoot,
    LAST_GOOD_PREFERENCES_FILE_NAME,
  );

  const readCandidate = async (
    absolutePath: string,
    signal: AbortSignal,
  ): Promise<CodeGraphPreferenceSnapshot | null> => {
    signal.throwIfAborted();
    let raw: string;
    try {
      raw = await readText(absolutePath, signal);
    } catch (error) {
      // Cancellation is not an unreadable file and must not select defaults.
      signal.throwIfAborted();
      if (isAbortError(error)) {
        throw error;
      }
      return null;
    }
    signal.throwIfAborted();
    const record = readDesktopPreferencesRecord(raw);
    return record ? normalizeCodeGraphPreferenceValue(record.codeGraph) : null;
  };

  return {
    async read(signal): Promise<CodeGraphPreferenceSnapshot> {
      const primary = await readCandidate(primaryPath, signal);
      signal.throwIfAborted();
      if (primary) {
        return primary;
      }
      const lastGood = await readCandidate(lastGoodPath, signal);
      signal.throwIfAborted();
      return lastGood ?? DEFAULT_CODE_GRAPH_PREFERENCES;
    },
  };
}
