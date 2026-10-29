import {
  getGitCommonDir,
  getLocalRemoteHeadBranch,
  getRemoteDefaultBranch,
  getRemoteHeadBranch,
  getRemoteUrl,
  setLocalRemoteHeadBranch,
} from './git';
import {
  readGitDefaultBranchFreshness,
  recordGitDefaultBranch,
  type GitDefaultBranchFreshnessEntry,
  type GitDefaultBranchFreshnessIdentity,
} from './git-default-branch-freshness';

export const DEFAULT_BRANCH_FRESHNESS_TTL_MS = 5 * 60_000;

function isFresh(entry: GitDefaultBranchFreshnessEntry, now: number): boolean {
  const resolvedAt = Date.parse(entry.resolvedAt);
  return (
    Number.isFinite(resolvedAt) &&
    resolvedAt <= now &&
    now - resolvedAt < DEFAULT_BRANCH_FRESHNESS_TTL_MS
  );
}

async function resolveIdentity(
  repoPath: string,
): Promise<GitDefaultBranchFreshnessIdentity | null> {
  const [commonDir, originUrl] = await Promise.all([
    getGitCommonDir(repoPath).catch(() => null),
    getRemoteUrl(repoPath).catch(() => null),
  ]);
  return commonDir && originUrl ? { commonDir, originUrl } : null;
}

/**
 * Resolves advisory default-branch knowledge for automatic display/state reads.
 * Remote-capable reads reuse recent identity-matched remote knowledge, then
 * revalidate origin HEAD. Local origin/HEAD remains the offline fallback.
 */
export async function resolveFreshDefaultBranch(
  repoPath: string,
  options: { allowRemoteLookup?: boolean } = {},
): Promise<string | null> {
  const now = Date.now();
  const identity = await resolveIdentity(repoPath);
  const stored = identity
    ? await readGitDefaultBranchFreshness(identity).catch(() => null)
    : null;

  if (stored && (options.allowRemoteLookup === false || isFresh(stored, now))) {
    return stored.defaultBranch;
  }

  if (options.allowRemoteLookup !== false) {
    const remoteHead = await getRemoteHeadBranch(repoPath).catch(() => null);
    if (remoteHead) {
      const resolvedIdentity = identity ?? (await resolveIdentity(repoPath));
      if (resolvedIdentity) {
        await recordGitDefaultBranch({
          identity: resolvedIdentity,
          defaultBranch: remoteHead,
          resolvedAt: now,
        }).catch(() => undefined);
      }
      const localRemoteHead = await getLocalRemoteHeadBranch(repoPath).catch(
        () => null,
      );
      if (localRemoteHead !== remoteHead) {
        try {
          await setLocalRemoteHeadBranch(repoPath, remoteHead);
        } catch {
          // Repair is best-effort for read-only repositories and permissions.
        }
      }
      return remoteHead;
    }
  }

  const localRemoteHead = await getLocalRemoteHeadBranch(repoPath).catch(
    () => null,
  );
  if (localRemoteHead) {
    return localRemoteHead;
  }

  if (stored) {
    return stored.defaultBranch;
  }

  return getRemoteDefaultBranch(repoPath, { allowNetwork: false }).catch(
    () => null,
  );
}

const backgroundRevalidations = new Map<string, Promise<void>>();

/**
 * Revalidates stale default-branch knowledge against the remote without making
 * the caller wait. Reads that must not block on the network resolve the
 * default branch locally and call this, so a changed remote default branch is
 * still recorded and a stale local origin/HEAD is still repaired. Concurrent
 * calls for one repository share a single lookup.
 */
export function revalidateDefaultBranchInBackground(repoPath: string): void {
  if (backgroundRevalidations.has(repoPath)) {
    return;
  }
  const revalidation = resolveFreshDefaultBranch(repoPath)
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      backgroundRevalidations.delete(repoPath);
    });
  backgroundRevalidations.set(repoPath, revalidation);
}
