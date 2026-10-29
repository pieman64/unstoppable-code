import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import {
  listWorkspaceWorktreeRepoEntries,
  resolveWorktreeCodeGraphRepositories,
} from '../lib/worktree-repo-entries';

export interface SharedContainerLocalRepository {
  repoId: string;
  repoName: string;
  repoPath: string;
  /** POSIX path from the workspace worktree root, empty for its root repo. */
  relativePrefix: string;
}

export async function listSharedContainerLocalRepositories(
  projectId: string,
  worktreeId: string,
): Promise<SharedContainerLocalRepository[]> {
  const worktreeRoot = resolveWorktreeCwd(projectId, worktreeId);
  const entries = await listWorkspaceWorktreeRepoEntries(
    projectId,
    worktreeRoot,
  );
  if (entries.length === 0) {
    // The canonical entry inventory deliberately omits an ordinary
    // single-repo root. Its code-graph companion distinguishes that case from
    // an empty multi-repo workspace and supplies the root fallback.
    const fallbackRepositories = await resolveWorktreeCodeGraphRepositories(
      projectId,
      worktreeRoot,
    );
    return fallbackRepositories.map((repository) => ({
      repoId: repository.repoId,
      repoName:
        repository.repoId === WORKSPACE_ROOT_REPO_ID
          ? WORKSPACE_ROOT_REPO_NAME
          : repository.repoId,
      repoPath: repository.rootPath,
      relativePrefix: '',
    }));
  }
  return entries.map((entry) => ({
    ...entry,
    relativePrefix:
      entry.repoPath === worktreeRoot ? '' : `repos/${entry.repoId}`,
  }));
}
