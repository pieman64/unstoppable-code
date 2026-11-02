import {
  WORKSPACE_ROOT_REPO_ID,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { getWorkspaceIndexRepository } from './sidebar-items';
import { readWorkspaceConfig } from './workspace-persistence';

/**
 * The repository location a workspace record names: the workspace's own
 * repository (a single-repo `repoPath`, a multi-repo `sourceRepoPath`) for an
 * absent `repoId` or `WORKSPACE_ROOT_REPO_ID`, otherwise the multi-repo member
 * with that id. `null` when the record names none.
 */
export function recordedRepositoryPath(
  config: WorkspaceConfigFile,
  repoId?: string,
): string | null {
  if (repoId === undefined || repoId === WORKSPACE_ROOT_REPO_ID) {
    if (config.type === 'single-repo') return config.repoPath || null;
    if (config.type === 'multi-repo') return config.sourceRepoPath || null;
    return null;
  }
  if (config.type !== 'multi-repo') return null;
  return config.repos.find((repo) => repo.id === repoId)?.repoPath || null;
}

export interface RecordedRepository {
  workspaceId: string;
  repoId?: string;
}

/**
 * The first workspace record, in index order, that names exactly `repoPath`
 * as a repository location; `null` for every other path, including another
 * spelling of a recorded one.
 */
export async function findRecordedRepository(
  repoPath: string,
): Promise<RecordedRepository | null> {
  const { entries } = await getWorkspaceIndexRepository().read();
  const configs = await Promise.all(
    entries.map(async ({ id }) => ({
      workspaceId: id,
      config: await readWorkspaceConfig(id),
    })),
  );
  for (const { workspaceId, config } of configs) {
    if (recordedRepositoryPath(config) === repoPath) return { workspaceId };
    if (config.type !== 'multi-repo') continue;
    const member = config.repos.find((repo) => repo.repoPath === repoPath);
    if (member) return { workspaceId, repoId: member.id };
  }
  return null;
}
