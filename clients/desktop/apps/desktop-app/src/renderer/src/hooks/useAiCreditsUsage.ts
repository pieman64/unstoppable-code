import { useCallback, useEffect, useState } from 'react';
import type {
  AiCreditsRoutingMode,
  AiCreditsScopeRequest,
  CanopyCloudAiCreditsState,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  aiCreditsScopeKey,
  readNavigationScopeKey,
  useStableAiCreditsScope,
} from '@/lib/aiCreditsScope';

/**
 * Full AI Credits usage snapshot shared by the sidebar alert coloring and the
 * Usage page AI Credits tile. Unlike {@link useAiCreditsAvailability} (which
 * returns only a boolean eligibility), this exposes the whole cloud state, the
 * persisted routing-mode preference, and a manual refresh so the tile can render
 * balance/subscription details and a refresh control.
 */
export interface AiCreditsUsage {
  /** Full cloud AI Credits state, or null until the first read resolves. */
  state: CanopyCloudAiCreditsState | null;
  /** Persisted fallback-routing mode (default `'off'`), or null until loaded. */
  routingMode: AiCreditsRoutingMode | null;
  /** Epoch ms of the last successful state read, or null before the first read. */
  lastUpdatedAt: number | null;
  /** True until the first read resolves. */
  loading: boolean;
  /** True while a manual (or invalidation-triggered) re-read is in flight. */
  refreshing: boolean;
  /** Force a fresh read of both the cloud state and the routing preference. */
  refresh: () => void;
}

interface Snapshot {
  state: CanopyCloudAiCreditsState | null;
  routingMode: AiCreditsRoutingMode | null;
  lastUpdatedAt: number | null;
}

/**
 * Module-level cache + in-flight dedupe, mirroring
 * {@link useAiCreditsAvailability}. A single credits read is shared across every
 * component that calls the hook, so mounting both the sidebar and the Usage tile
 * does not fan out redundant IPC calls.
 */
interface ScopeEntry {
  cache: Snapshot | null;
  cacheTimestamp: number;
  pending: Promise<Snapshot> | null;
}

/**
 * Keyed by owner scope (CAN-3463): the balance endpoint reports only the
 * owner's organization pool, so the snapshot for one context must never be
 * shown for another. The default scope follows the navigation context.
 */
const entries = new Map<string, ScopeEntry>();
let requestVersion = 0;

function entryFor(key: string): ScopeEntry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { cache: null, cacheTimestamp: 0, pending: null };
    entries.set(key, entry);
  }
  return entry;
}

/**
 * Mounted hook consumers that want to re-read when the cache is invalidated, so
 * a continuously-mounted consumer (e.g. the sidebar) reflects changes without
 * waiting for the TTL to lapse.
 */
const subscribers = new Set<() => void>();

/** TTL for the cached snapshot; defense-in-depth beyond explicit invalidation. */
const CACHE_TTL_MS = 60_000;

function isCacheFresh(entry: ScopeEntry | undefined): boolean {
  return (
    entry !== undefined &&
    entry.cache !== null &&
    Date.now() - entry.cacheTimestamp < CACHE_TTL_MS
  );
}

/**
 * Expire the cached snapshot and re-read AI Credits. The stale value remains
 * available only to preserve a known balance for a failed same-account refresh;
 * mounted consumers re-fetch immediately and unmounted ones on their next mount.
 */
export function invalidateAiCreditsUsageCache(): void {
  requestVersion += 1;
  entries.forEach((entry) => {
    entry.cacheTimestamp = 0;
    entry.pending = null;
  });
  subscribers.forEach((notify) => notify());
}

/**
 * Re-read AI Credits unless a read is already in flight. Mounted consumers keep
 * their current snapshot while the read runs, so callers can refresh without
 * blanking the tile. An in-flight read is already fresh, so it is reused rather
 * than superseded.
 */
export function refreshAiCreditsUsage(): void {
  const key = aiCreditsScopeKey(undefined, readNavigationScopeKey());
  if (entries.get(key)?.pending) {
    return;
  }
  invalidateAiCreditsUsageCache();
}

// Drop the cache whenever the cloud account connection changes (connect,
// disconnect, or API-key change all dispatch this event). Registered once at
// module load so usage re-reads no matter which surface mounts the hook.
if (typeof window !== 'undefined') {
  window.addEventListener(
    CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
    invalidateAiCreditsUsageCache,
  );
}

function preserveBalanceAfterFailedRefresh(
  previousState: CanopyCloudAiCreditsState | null,
  nextState: CanopyCloudAiCreditsState | null,
): CanopyCloudAiCreditsState | null {
  if (
    !previousState?.connected ||
    !previousState.balance ||
    !nextState?.connected ||
    !nextState.error ||
    nextState.balance ||
    !nextState.email ||
    previousState.email !== nextState.email
  ) {
    return nextState;
  }

  return { ...nextState, balance: previousState.balance };
}

async function readSnapshot(
  previousState: CanopyCloudAiCreditsState | null,
  scope: AiCreditsScopeRequest | undefined,
): Promise<Snapshot> {
  const loadCredits = window.api?.loadCanopyCloudAiCredits;
  const loadPreferences = window.api?.loadPreferences;

  const [state, routingMode] = await Promise.all([
    typeof loadCredits === 'function'
      ? loadCredits(scope).catch((): CanopyCloudAiCreditsState | null => null)
      : Promise.resolve<CanopyCloudAiCreditsState | null>(null),
    typeof loadPreferences === 'function'
      ? loadPreferences()
          .then((prefs) => prefs.aiCreditsRoutingMode ?? 'off')
          .catch((): AiCreditsRoutingMode => 'off')
      : Promise.resolve<AiCreditsRoutingMode>('off'),
  ]);

  return {
    state: preserveBalanceAfterFailedRefresh(previousState, state),
    routingMode,
    lastUpdatedAt: Date.now(),
  };
}

export function useAiCreditsUsage(
  scope?: AiCreditsScopeRequest,
): AiCreditsUsage {
  const { scope: stableScope, key } = useStableAiCreditsScope(scope);
  const [keyedSnapshot, setKeyedSnapshot] = useState<{
    key: string;
    value: Snapshot;
  } | null>(() => {
    const entry = entries.get(key);
    return entry?.cache && isCacheFresh(entry)
      ? { key, value: entry.cache }
      : null;
  });
  // A snapshot read for another scope is never shown for this one.
  const snapshot = keyedSnapshot?.key === key ? keyedSnapshot.value : null;
  const setSnapshot = useCallback(
    (value: Snapshot | null): void =>
      setKeyedSnapshot(value ? { key, value } : null),
    [key],
  );
  const [refreshing, setRefreshing] = useState(false);
  // Bumped to force the fetch effect to re-run while this consumer is mounted.
  const [refreshSignal, setRefreshSignal] = useState(0);

  const refresh = useCallback((): void => {
    invalidateAiCreditsUsageCache();
  }, []);

  useEffect(() => {
    const notify = (): void => setRefreshSignal((n) => n + 1);
    subscribers.add(notify);
    return (): void => {
      subscribers.delete(notify);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const entry = entryFor(key);
    if (entry.cache && isCacheFresh(entry)) {
      setSnapshot(entry.cache);
      // Defensive symmetry: `refreshing` is only ever set true on the fetch path
      // below, but clearing it here keeps the invariant explicit if that changes.
      setRefreshing(false);
      return (): void => {
        cancelled = true;
      };
    }
    // Keep the last rendered/cache state long enough to retain a known balance
    // when this same account's refresh returns a transient error. Account
    // identity must match before any balance is carried forward.
    const previousState = entry.cache?.state ?? null;
    entry.cache = null;
    setRefreshing(true);
    if (!entry.pending) {
      const activeRequestVersion = requestVersion;
      const promise = readSnapshot(previousState, stableScope)
        .then((result) => {
          if (activeRequestVersion === requestVersion) {
            entry.cache = result;
            entry.cacheTimestamp = Date.now();
          }
          return result;
        })
        .finally(() => {
          if (entry.pending === promise) {
            entry.pending = null;
          }
        });
      entry.pending = promise;
    }
    // Guard the resolve against both unmount and a newer invalidation/refresh:
    // if `requestVersion` moved while this fetch was in flight, a fresher read
    // is already running, so a stale snapshot must not overwrite it.
    const versionAtSubscribe = requestVersion;
    void entry.pending.then((value) => {
      if (!cancelled && requestVersion === versionAtSubscribe) {
        setSnapshot(value);
        setRefreshing(false);
      }
    });
    return (): void => {
      cancelled = true;
    };
  }, [key, stableScope, setSnapshot, refreshSignal]);

  return {
    state: snapshot?.state ?? null,
    routingMode: snapshot?.routingMode ?? null,
    lastUpdatedAt: snapshot?.lastUpdatedAt ?? null,
    loading: snapshot === null,
    refreshing,
    refresh,
  };
}
