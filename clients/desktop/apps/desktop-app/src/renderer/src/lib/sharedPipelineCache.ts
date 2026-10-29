// ---------------------------------------------------------------------------
// Local cache for shared (Canopy Cloud) pipelines.
//
// Shared pipelines are fetched from the Cloud backend by every surface that
// shows them (the Pipelines list page, the dispatch/plan/task trigger pickers,
// etc.). Each `useSharedPipelineList` instance otherwise starts from an empty
// list and streams rows in, which flashes an empty/loading state every time a
// surface mounts.
//
// This module is a process-wide, localStorage-backed cache so those surfaces
// render the last-known rows immediately (stale-while-revalidate): the
// in-memory map shares results between concurrently mounted hooks within a
// session, and the localStorage mirror survives reloads/restarts.
//
// Only the default (unfiltered) list per trigger type is cached — search-text
// (`q`) and `createdBy` filtered fetches are intentionally not cached so the
// store cannot balloon with one entry per keystroke.
// ---------------------------------------------------------------------------
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import type { SharedListFilters } from '@/hooks/useSharedPipelineList';

const STORAGE_KEY = 'canopy.sharedPipelineCache.v1';

export interface SharedPipelineCacheEntry {
  rows: PipelineInfo[];
  nextCursor: string | null;
}

interface SharedPipelineCacheFile {
  lastAccountIdentity: string | null;
  entries: Record<string, SharedPipelineCacheEntry>;
}

interface SharedPipelineCacheState {
  lastAccountIdentity: string | null;
  entries: Map<string, SharedPipelineCacheEntry>;
}

function emptyState(): SharedPipelineCacheState {
  return { lastAccountIdentity: null, entries: new Map() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPipelineRows(value: unknown): value is PipelineInfo[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && typeof item.id === 'string')
  );
}

function isSharedPipelineCacheEntry(
  value: unknown,
): value is SharedPipelineCacheEntry {
  return (
    isRecord(value) &&
    isPipelineRows(value.rows) &&
    (value.nextCursor === null || typeof value.nextCursor === 'string')
  );
}

function hydrate(): SharedPipelineCacheState {
  try {
    if (typeof localStorage === 'undefined') return emptyState();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return emptyState();
    const entries = new Map<string, SharedPipelineCacheEntry>();
    if (isRecord(parsed.entries)) {
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (isSharedPipelineCacheEntry(value)) {
          entries.set(key, { rows: value.rows, nextCursor: value.nextCursor });
        }
      }
    }
    return {
      lastAccountIdentity:
        typeof parsed.lastAccountIdentity === 'string'
          ? parsed.lastAccountIdentity
          : null,
      entries,
    };
  } catch {
    return emptyState();
  }
}

const state: SharedPipelineCacheState = hydrate();

function persist(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const file: SharedPipelineCacheFile = {
      lastAccountIdentity: state.lastAccountIdentity,
      entries: Object.fromEntries(state.entries),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch {
    // Best-effort cache: ignore quota/serialization failures. The in-memory
    // map still provides within-session sharing.
  }
}

/**
 * Cache key for a shared-pipeline list, or `null` when the list should not be
 * cached. Only the default list per trigger type is cached; search-text and
 * `createdBy`-filtered fetches return `null`.
 */
export function sharedPipelineCacheKey(
  accountIdentity: string | null,
  filters: SharedListFilters,
): string | null {
  if (!accountIdentity) return null;
  if (filters.q || filters.createdBy) return null;
  return `${accountIdentity}::${filters.triggerType ?? 'all'}`;
}

export function readSharedPipelineCache(
  key: string,
): SharedPipelineCacheEntry | null {
  const entry = state.entries.get(key);
  if (!entry) return null;
  // Hand back a copy so callers can mutate their own state freely.
  return { rows: [...entry.rows], nextCursor: entry.nextCursor };
}

export function writeSharedPipelineCache(
  key: string,
  entry: SharedPipelineCacheEntry,
): void {
  state.entries.set(key, {
    rows: [...entry.rows],
    nextCursor: entry.nextCursor,
  });
  persist();
}

/**
 * Drop a deleted shared pipeline from every cached list so a remount can't
 * resurrect it.
 */
export function removeRowFromSharedPipelineCache(remoteId: string): void {
  let changed = false;
  state.entries.forEach((entry, key) => {
    const filtered = entry.rows.filter(
      (row: PipelineInfo) => row.remoteId !== remoteId,
    );
    if (filtered.length !== entry.rows.length) {
      state.entries.set(key, { rows: filtered, nextCursor: entry.nextCursor });
      changed = true;
    }
  });
  if (changed) persist();
}

export function readLastSharedAccountIdentity(): string | null {
  return state.lastAccountIdentity;
}

/**
 * Record the most recent live Cloud account identity so the next mount can
 * reconstruct its seed key before the async account load resolves.
 *
 * Entries are namespaced by account identity, so stale entries from a previous
 * account are simply never read by a different account's key — there is no
 * need to clear them here (and clearing on a transient offline blip would
 * needlessly cold-start the cache).
 */
export function writeLastSharedAccountIdentity(identity: string): void {
  if (state.lastAccountIdentity === identity) return;
  state.lastAccountIdentity = identity;
  persist();
}
