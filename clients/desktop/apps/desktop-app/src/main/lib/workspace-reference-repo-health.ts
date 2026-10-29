import type { WorkspaceReferenceRepoStatus } from '@canopy/desktop-shared/types';
import { getRemoteUrlStrict, isGitRepo } from './git';
import { ensureRepoShadow } from './repo-shadow';
import { readWorkspaceConfig } from './workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';

export async function inspectReferenceRepo(
  workspaceId: string,
): Promise<WorkspaceReferenceRepoStatus | null> {
  const config = await readWorkspaceConfig(workspaceId);
  if (!config.sourceRepoPath) {
    return null;
  }
  const referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
    config.sourceRepoPath,
  );
  let remoteUrl: string | null;
  try {
    remoteUrl = await getRemoteUrlStrict(referenceRepoPath);
  } catch (error) {
    if (await isGitRepo(referenceRepoPath)) {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : 'Shadow sync failed';
    return {
      referenceRepoPath,
      healthy: false,
      warnings: [{ code: 'shadow-sync-failed', message }],
      lastCheckedAt: new Date().toISOString(),
    };
  }
  if (!remoteUrl && (await isGitRepo(referenceRepoPath))) {
    return {
      referenceRepoPath,
      healthy: true,
      warnings: [],
      lastCheckedAt: new Date().toISOString(),
    };
  }
  try {
    // Health inspection must observe a live sync (poller ticks and
    // user-triggered refreshes both land here), so it always probes past the
    // recent-failure cache — a just-fixed remote heals immediately instead of
    // after the cache TTL.
    const shadow = await ensureRepoShadow(referenceRepoPath, {
      bypassFailureCache: true,
    });
    return {
      referenceRepoPath,
      shadowPath: shadow.shadowPath,
      healthy: true,
      warnings: [],
      lastCheckedAt: new Date().toISOString(),
      remoteUrl: remoteUrl ?? undefined,
      defaultBranch: shadow.defaultBranch,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Shadow sync failed';
    return {
      referenceRepoPath,
      healthy: false,
      warnings: [{ code: 'shadow-sync-failed', message }],
      lastCheckedAt: new Date().toISOString(),
      remoteUrl: remoteUrl ?? undefined,
    };
  }
}
