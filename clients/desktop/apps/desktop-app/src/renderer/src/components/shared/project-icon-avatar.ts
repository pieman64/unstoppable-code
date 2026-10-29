import { getGitHubOwnerAvatarUrl } from '@canopy/desktop-shared/lib/github-owner-avatar';

const resolvedAvatarUrls = new Map<string, string>();
const pendingAvatarUrls = new Map<string, Promise<string | null>>();
const loadedAvatarUrls = new Set<string>();
let remoteLookupQueue: Promise<void> = Promise.resolve();

export function getCachedProjectAvatarUrl(repoPath: string): string | null {
  return resolvedAvatarUrls.get(repoPath) ?? null;
}

export function isProjectAvatarLoaded(avatarUrl: string): boolean {
  return loadedAvatarUrls.has(avatarUrl);
}

export function markProjectAvatarLoaded(avatarUrl: string): void {
  loadedAvatarUrls.add(avatarUrl);
}

export function clearCachedProjectAvatar(
  repoPath: string,
  avatarUrl: string,
): void {
  if (resolvedAvatarUrls.get(repoPath) === avatarUrl) {
    resolvedAvatarUrls.delete(repoPath);
  }
  loadedAvatarUrls.delete(avatarUrl);
}

/** Resolve remotes serially so rendering a large sidebar cannot fan out Git. */
export function resolveProjectAvatarUrl(
  repoPath: string,
): Promise<string | null> {
  const resolved = resolvedAvatarUrls.get(repoPath);
  if (resolved) {
    return Promise.resolve(resolved);
  }

  const pending = pendingAvatarUrls.get(repoPath);
  if (pending) {
    return pending;
  }

  const lookup = remoteLookupQueue
    .then(async (): Promise<string | null> => {
      if (typeof window.api?.getRemoteUrl !== 'function') {
        return null;
      }
      const result = await window.api.getRemoteUrl({ repoPath });
      const avatarUrl = result.remoteUrl
        ? getGitHubOwnerAvatarUrl(result.remoteUrl)
        : null;
      if (avatarUrl) {
        resolvedAvatarUrls.set(repoPath, avatarUrl);
      }
      return avatarUrl;
    })
    .catch(() => null)
    .finally(() => {
      pendingAvatarUrls.delete(repoPath);
    });

  pendingAvatarUrls.set(repoPath, lookup);
  remoteLookupQueue = lookup.then(() => undefined);
  return lookup;
}
