import { useEffect, useState } from 'react';
import type {
  GitHubPermissionSource,
  GitHubPermissionsStatus,
} from '@canopy/desktop-shared/types';

// Cache keyed by source so toggling between PAT and OAuth doesn't show stale
// scopes from the other credential.
const caches: Partial<Record<GitHubPermissionSource, GitHubPermissionsStatus>> =
  {};
const pending: Partial<
  Record<GitHubPermissionSource, Promise<GitHubPermissionsStatus>>
> = {};
let requestVersion = 0;

function fallback(message: string): GitHubPermissionsStatus {
  return {
    tokenAvailable: false,
    tokenType: 'unknown',
    scopes: [],
    permissions: [],
    canListRepos: false,
    error: message,
  };
}

function fetchPermissions(
  source: GitHubPermissionSource,
): Promise<GitHubPermissionsStatus> {
  const existing = pending[source];
  if (existing) return existing;
  const activeRequestVersion = requestVersion;
  const promise = window.api
    .getGitHubPermissions({ source })
    .then((status: GitHubPermissionsStatus) => {
      if (activeRequestVersion === requestVersion) {
        caches[source] = status;
      }
      return status;
    })
    .catch((): GitHubPermissionsStatus => {
      const value = fallback('Unable to check GitHub permissions.');
      if (activeRequestVersion === requestVersion) {
        caches[source] = value;
      }
      return value;
    })
    .finally(() => {
      if (pending[source] === promise) {
        delete pending[source];
      }
    });
  pending[source] = promise;
  return promise;
}

export function invalidateGitHubPermissionsCache(): void {
  requestVersion += 1;
  delete caches.pat;
  delete caches.oauth;
  delete caches.any;
  delete pending.pat;
  delete pending.oauth;
  delete pending.any;
}

export function useGitHubPermissions(
  source: GitHubPermissionSource | null,
  refreshKey: string | number = 0,
): GitHubPermissionsStatus | null {
  const [status, setStatus] = useState<GitHubPermissionsStatus | null>(
    source ? (caches[source] ?? null) : null,
  );

  useEffect(() => {
    if (!source) {
      setStatus(null);
      return;
    }
    let canceled = false;
    setStatus(caches[source] ?? null);
    void fetchPermissions(source).then((value) => {
      if (!canceled) {
        setStatus(value);
      }
    });
    return (): void => {
      canceled = true;
    };
  }, [source, refreshKey]);

  return status;
}
