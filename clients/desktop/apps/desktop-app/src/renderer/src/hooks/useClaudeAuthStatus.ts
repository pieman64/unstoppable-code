import { useEffect, useRef, useState } from 'react';
import type { AgentProviderAuthStatus } from '@canopy/desktop-shared/types';

interface CachedAuthStatus {
  status: AgentProviderAuthStatus;
  cachedAtMs: number;
}

// Bound how long a confirmed status is reused so a stale negative can never
// outlive the condition that produced it; failed probes are never cached.
const AUTH_STATUS_CACHE_TTL_MS = 60_000;

let cache: CachedAuthStatus | null = null;
let pending: Promise<AgentProviderAuthStatus> | null = null;
let requestVersion = 0;
let cacheEpoch = 0;
const subscribers = new Set<() => void>();

function readFreshCachedStatus(): AgentProviderAuthStatus | null {
  if (!cache) {
    return null;
  }
  if (Date.now() - cache.cachedAtMs > AUTH_STATUS_CACHE_TTL_MS) {
    return null;
  }
  return cache.status;
}

export function invalidateClaudeAuthStatusCache(): void {
  requestVersion += 1;
  cache = null;
  pending = null;
  cacheEpoch += 1;
  subscribers.forEach((subscriber) => subscriber());
}

export function useClaudeAuthStatus(
  refreshKey: number = 0,
  options: { forceRefreshOnMount?: boolean } = {},
): AgentProviderAuthStatus | null {
  const [status, setStatus] = useState<AgentProviderAuthStatus | null>(() =>
    options.forceRefreshOnMount === true ? null : readFreshCachedStatus(),
  );
  const [observedCacheEpoch, setObservedCacheEpoch] = useState(cacheEpoch);
  const lastRefreshKeyRef = useRef(refreshKey);
  const lastCacheEpochRef = useRef(observedCacheEpoch);
  const mountedRef = useRef(false);

  useEffect(() => {
    const subscriber = (): void => {
      setObservedCacheEpoch(cacheEpoch);
    };
    subscribers.add(subscriber);
    return (): void => {
      subscribers.delete(subscriber);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const forceRefreshOnMount =
      !mountedRef.current && options.forceRefreshOnMount === true;
    const refreshKeyChanged = refreshKey !== lastRefreshKeyRef.current;
    const cacheInvalidated = observedCacheEpoch !== lastCacheEpochRef.current;
    const bypassCache =
      refreshKeyChanged || cacheInvalidated || forceRefreshOnMount;
    lastRefreshKeyRef.current = refreshKey;
    lastCacheEpochRef.current = observedCacheEpoch;
    mountedRef.current = true;
    if (refreshKeyChanged || forceRefreshOnMount) {
      requestVersion += 1;
      cache = null;
      pending = null;
    }
    if (bypassCache) {
      setStatus(null);
    }
    const freshCachedStatus = readFreshCachedStatus();
    if (freshCachedStatus && !bypassCache) {
      setStatus(freshCachedStatus);
      return (): void => {
        cancelled = true;
      };
    }
    if (!pending) {
      const activeRequestVersion = requestVersion;
      const promise = window.api
        // A deliberate refresh (post-sign-in / cache invalidation) bypasses the
        // main-process TTL cache too so the re-probe reflects the new state.
        .getClaudeAuthStatus(bypassCache ? { forceRefresh: true } : undefined)
        .then((s: AgentProviderAuthStatus) => {
          // Never persist an inconclusive probe — it must re-probe, not stick.
          if (
            activeRequestVersion === requestVersion &&
            s.probeFailed !== true
          ) {
            cache = { status: s, cachedAtMs: Date.now() };
          }
          return s;
        })
        .catch((): AgentProviderAuthStatus => {
          // A rejected invoke is itself an inconclusive probe: mark it
          // probeFailed so it reads as "unknown" (hidden toggle), and do not
          // cache it so the next render re-probes.
          const fallback: AgentProviderAuthStatus = {
            authenticated: false,
            accountLabel: null,
            detail: null,
            error: 'Failed to check Claude status.',
            probeFailed: true,
          };
          return fallback;
        })
        .finally(() => {
          if (pending === promise) {
            pending = null;
          }
        });
      pending = promise;
    }
    void pending.then((value) => {
      if (!cancelled) {
        setStatus(value);
      }
    });
    return (): void => {
      cancelled = true;
    };
  }, [observedCacheEpoch, options.forceRefreshOnMount, refreshKey]);

  return status;
}
