import { useEffect, useRef, useState } from 'react';
import type { GitHubCliStatus } from '@canopy/desktop-shared/types';

let cache: GitHubCliStatus | null = null;
let pending: Promise<GitHubCliStatus> | null = null;
let requestVersion = 0;

export function invalidateGitHubCliStatusCache(): void {
  requestVersion += 1;
  cache = null;
  pending = null;
}

export function useGitHubCliStatus(
  refreshKey: number = 0,
): GitHubCliStatus | null {
  const [status, setStatus] = useState<GitHubCliStatus | null>(cache);
  const lastRefreshKeyRef = useRef(refreshKey);

  useEffect(() => {
    let cancelled = false;
    const bypassCache = refreshKey !== lastRefreshKeyRef.current;
    lastRefreshKeyRef.current = refreshKey;
    if (bypassCache) {
      requestVersion += 1;
      pending = null;
    }
    if (cache && !bypassCache) {
      setStatus(cache);
      return (): void => {
        cancelled = true;
      };
    }
    if (!pending) {
      const activeRequestVersion = requestVersion;
      const promise = window.api
        .getGitHubCliStatus()
        .then((s: GitHubCliStatus) => {
          if (activeRequestVersion === requestVersion) {
            cache = s;
          }
          return s;
        })
        .catch((): GitHubCliStatus => {
          const fallback: GitHubCliStatus = {
            authenticated: false,
            username: null,
            error: 'Failed to check status.',
            tokenSource: null,
            envOverride: false,
            envOverrideName: null,
            hasCredentialStoreLogin: false,
          };
          if (activeRequestVersion === requestVersion) {
            cache = fallback;
          }
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
  }, [refreshKey]);

  return status;
}
