import type { DiffStats, RepoBranchInfo } from '@canopy/desktop-shared/types';
import {
  emptyDiffStatsState,
  type DiffStatsState,
  type WorktreeDiffStatsPollState,
} from './projectsStore.diffStats';

const STORAGE_KEY = 'canopy.diffStatsCache.v1';
const CACHE_VERSION = 1;
const PERSIST_DELAY_MS = 500;
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60_000;

function ownsDiffStatsCachePersistence(): boolean {
  if (typeof window === 'undefined' || !window.location) return true;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('surface') !== 'app-advisor';
  } catch {
    return true;
  }
}

interface PersistedDiffStatsCache {
  version: 1;
  savedAtMs: number;
  state: DiffStatsState;
  activityAtMs: Record<string, number>;
  pollStates: Record<string, WorktreeDiffStatsPollState>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMap<T>(
  value: unknown,
  readValue: (entry: unknown) => T | undefined,
): Record<string, T> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key.includes('/')) continue;
    const parsed = readValue(entry);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  return typeof value === 'string' || value === null ? value : undefined;
}

function readDiffStats(value: unknown): DiffStats | undefined {
  if (!isRecord(value)) return undefined;
  const insertions = readFiniteNumber(value.insertions);
  const deletions = readFiniteNumber(value.deletions);
  return insertions === undefined || deletions === undefined
    ? undefined
    : { insertions, deletions };
}

function readOptionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : readFiniteNumber(value);
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return value === undefined ? undefined : readBoolean(value);
}

function readRepoBranchInfo(value: unknown): RepoBranchInfo | undefined {
  if (
    !isRecord(value) ||
    typeof value.repoId !== 'string' ||
    typeof value.repoName !== 'string' ||
    typeof value.branch !== 'string'
  ) {
    return undefined;
  }
  const baseBranch = readNullableString(value.baseBranch);
  const result: RepoBranchInfo = {
    repoId: value.repoId,
    repoName: value.repoName,
    branch: value.branch,
    baseBranch,
    insertions: readOptionalNumber(value.insertions),
    deletions: readOptionalNumber(value.deletions),
    commitsAhead: readOptionalBoolean(value.commitsAhead),
    hasUncommittedChanges: readOptionalBoolean(value.hasUncommittedChanges),
    hasRemoteTrackingBranch: readOptionalBoolean(value.hasRemoteTrackingBranch),
    hasUnpushedCommits: readOptionalBoolean(value.hasUnpushedCommits),
    hasUnpulledCommits: readOptionalBoolean(value.hasUnpulledCommits),
    hasBranchBeenPushed: readOptionalBoolean(value.hasBranchBeenPushed),
    baseBranchExistsLocally: readOptionalBoolean(value.baseBranchExistsLocally),
    baseBranchExistsInRemote: readOptionalBoolean(
      value.baseBranchExistsInRemote,
    ),
    hasOriginRemote: readOptionalBoolean(value.hasOriginRemote),
  };
  return result;
}

function readRepoBranchList(value: unknown): RepoBranchInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(readRepoBranchInfo);
  const valid = parsed.filter(
    (entry): entry is RepoBranchInfo => entry !== undefined,
  );
  return valid.length === parsed.length ? valid : undefined;
}

function readDiffStatsState(value: unknown): DiffStatsState | null {
  if (!isRecord(value)) return null;
  const state: DiffStatsState = {
    diffStats: readMap(value.diffStats, readDiffStats) ?? {},
    commitsAhead: readMap(value.commitsAhead, readBoolean) ?? {},
    baseBranches: readMap(value.baseBranches, readNullableString) ?? {},
    defaultBranches: readMap(value.defaultBranches, readNullableString) ?? {},
    uncommittedChanges: readMap(value.uncommittedChanges, readBoolean) ?? {},
    hasRemoteTracking: readMap(value.hasRemoteTracking, readBoolean) ?? {},
    hasOriginRemote: readMap(value.hasOriginRemote, readBoolean) ?? {},
    hasBranchBeenPushed: readMap(value.hasBranchBeenPushed, readBoolean) ?? {},
    hasUnpushedCommits: readMap(value.hasUnpushedCommits, readBoolean) ?? {},
    hasUnpulledCommits: readMap(value.hasUnpulledCommits, readBoolean) ?? {},
    repoBranches: readMap(value.repoBranches, readRepoBranchList) ?? {},
    baseBranchExistsLocally:
      readMap(value.baseBranchExistsLocally, readBoolean) ?? {},
    baseBranchExistsInRemote:
      readMap(value.baseBranchExistsInRemote, readBoolean) ?? {},
  };
  return state;
}

function readPollState(value: unknown): WorktreeDiffStatsPollState | undefined {
  if (!isRecord(value)) return undefined;
  const intervalMs = readFiniteNumber(value.intervalMs);
  const nextDueAtMs = readFiniteNumber(value.nextDueAtMs);
  const lastChangeSignature = readNullableString(value.lastChangeSignature);
  if (
    intervalMs === undefined ||
    nextDueAtMs === undefined ||
    lastChangeSignature === undefined
  ) {
    return undefined;
  }
  return { intervalMs, nextDueAtMs, lastChangeSignature };
}

export function parsePersistedDiffStatsCache(
  raw: string,
  nowMs = Date.now(),
): PersistedDiffStatsCache | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value.version !== CACHE_VERSION ||
      typeof value.savedAtMs !== 'number' ||
      !Number.isFinite(value.savedAtMs) ||
      nowMs - value.savedAtMs > MAX_CACHE_AGE_MS
    ) {
      return null;
    }
    const state = readDiffStatsState(value.state);
    if (!state) return null;
    return {
      version: CACHE_VERSION,
      savedAtMs: value.savedAtMs,
      state,
      activityAtMs: readMap(value.activityAtMs, readFiniteNumber) ?? {},
      pollStates: readMap(value.pollStates, readPollState) ?? {},
    };
  } catch {
    return null;
  }
}

function loadCache(): PersistedDiffStatsCache | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? parsePersistedDiffStatsCache(raw) : null;
  } catch {
    return null;
  }
}

const loadedCache = loadCache();
let latestState = loadedCache?.state ?? emptyDiffStatsState();
export const worktreeDiffStatsActivityAtMs = new Map<string, number>(
  Object.entries(loadedCache?.activityAtMs ?? {}),
);
export const worktreeDiffStatsPollStates = new Map<
  string,
  WorktreeDiffStatsPollState
>(Object.entries(loadedCache?.pollStates ?? {}));
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export const initialPersistedDiffStatsState: DiffStatsState = latestState;

function persistNow(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!ownsDiffStatsCachePersistence()) return;
  try {
    const cache: PersistedDiffStatsCache = {
      version: CACHE_VERSION,
      savedAtMs: Date.now(),
      state: latestState,
      activityAtMs: Object.fromEntries(worktreeDiffStatsActivityAtMs),
      pollStates: Object.fromEntries(worktreeDiffStatsPollStates),
    };
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Best-effort cache: quota, privacy, and shutdown failures are harmless.
  }
}

function schedulePersist(): void {
  if (!ownsDiffStatsCachePersistence()) return;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS);
}

// Debouncing keeps synchronous localStorage writes off hot polling paths, but
// a last-second Git update should still survive an immediate app restart when
// the renderer receives a normal page lifecycle notification.
if (ownsDiffStatsCachePersistence()) {
  globalThis.addEventListener?.('pagehide', persistNow);
}

export function updatePersistedDiffStatsState(state: DiffStatsState): void {
  latestState = state;
  schedulePersist();
}

export function markWorktreeDiffStatsActivity(
  projectId: string,
  worktreeId: string,
  atMs = Date.now(),
): void {
  markWorktreeDiffStatsActivityKey(`${projectId}/${worktreeId}`, atMs);
}

export function markWorktreeDiffStatsActivityKey(
  key: string,
  atMs = Date.now(),
): void {
  if (!key.includes('/') || !Number.isFinite(atMs)) return;
  worktreeDiffStatsActivityAtMs.set(
    key,
    Math.max(worktreeDiffStatsActivityAtMs.get(key) ?? 0, atMs),
  );
  schedulePersist();
}

export function getWorktreeDiffStatsActivityAtMs(
  key: string,
): number | undefined {
  return worktreeDiffStatsActivityAtMs.get(key);
}

export function pruneWorktreeDiffStatsRuntime(validKeys: Set<string>): void {
  let changed = false;
  for (const key of Array.from(worktreeDiffStatsActivityAtMs.keys())) {
    if (!validKeys.has(key)) {
      worktreeDiffStatsActivityAtMs.delete(key);
      changed = true;
    }
  }
  for (const key of Array.from(worktreeDiffStatsPollStates.keys())) {
    if (!validKeys.has(key)) {
      worktreeDiffStatsPollStates.delete(key);
      changed = true;
    }
  }
  if (changed) schedulePersist();
}

export const diffStatsRuntimeTestExports = {
  storageKey: STORAGE_KEY,
  maxCacheAgeMs: MAX_CACHE_AGE_MS,
  flush: persistNow,
};
