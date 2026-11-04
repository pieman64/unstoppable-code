import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { CodeGraphRepositoryInput } from '@canopy/desktop-shared/types/code-graph';
import {
  codeGraphBuildRepositories,
  listCodeGraphWorktreeRepositories,
} from '@canopy/code-graph/host/worktree-repositories';
import { isGitRepo } from './git';
import { readWorkspaceConfig } from './workspace-persistence';

export interface WorktreeRepoEntry {
  repoId: string;
  repoName: string;
  repoPath: string;
}

interface WorkspaceRepoEntries {
  config: WorkspaceConfigFile;
  entries: WorktreeRepoEntry[];
}

async function loadWorkspaceWorktreeRepoEntries(
  workspaceId: string,
  worktreePath: string,
): Promise<WorkspaceRepoEntries> {
  const emptyConfig: WorkspaceConfigFile = {
    version: 1,
    type: 'multi-repo',
    repos: [],
  };
  const config = await readWorkspaceConfig(workspaceId).catch(
    (): WorkspaceConfigFile => emptyConfig,
  );
  const repoNameById = new Map(
    config.repos.map((repo) => [repo.id, repo.name]),
  );
  const repositories = await listCodeGraphWorktreeRepositories(
    worktreePath,
    {
      multiRepo: config.type === 'multi-repo',
      hasSourceRepo:
        config.type === 'multi-repo' && Boolean(config.sourceRepoPath),
    },
    isGitRepo,
  );
  const repoEntries = repositories.map(
    (repository): WorktreeRepoEntry => ({
      repoId: repository.repoId,
      repoName:
        repository.repoId === WORKSPACE_ROOT_REPO_ID
          ? WORKSPACE_ROOT_REPO_NAME
          : (repoNameById.get(repository.repoId) ?? repository.repoId),
      repoPath: repository.rootPath,
    }),
  );

  return { config, entries: repoEntries };
}

export async function listWorkspaceWorktreeRepoEntries(
  workspaceId: string,
  worktreePath: string,
): Promise<WorktreeRepoEntry[]> {
  return (await loadWorkspaceWorktreeRepoEntries(workspaceId, worktreePath))
    .entries;
}

/** Canonical graph descriptor resolution shared by scheduler and tool builds. */
export async function resolveWorktreeCodeGraphRepositories(
  workspaceId: string,
  worktreePath: string,
): Promise<CodeGraphRepositoryInput[]> {
  const { config, entries } = await loadWorkspaceWorktreeRepoEntries(
    workspaceId,
    worktreePath,
  );
  return codeGraphBuildRepositories(
    worktreePath,
    config.type === 'multi-repo',
    entries.map((entry) => ({
      repoId: entry.repoId,
      rootPath: entry.repoPath,
    })),
  );
}
