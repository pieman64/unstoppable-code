import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { CodeGraphRepositoryInput } from '@canopy/desktop-shared/types/code-graph';
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
  const repoEntries: WorktreeRepoEntry[] = [];

  const hasWorkspaceRootRepo =
    config.type === 'multi-repo' &&
    (Boolean(config.sourceRepoPath) || (await isGitRepo(worktreePath)));

  if (hasWorkspaceRootRepo) {
    repoEntries.push({
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoName: WORKSPACE_ROOT_REPO_NAME,
      repoPath: worktreePath,
    });
  }

  const repoNameById = new Map(
    config.repos.map((repo) => [repo.id, repo.name]),
  );
  const reposDir = join(worktreePath, 'repos');
  const entries = await readdir(reposDir, { withFileTypes: true }).catch(
    () => [],
  );

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    repoEntries.push({
      repoId: entry.name,
      repoName: repoNameById.get(entry.name) ?? entry.name,
      repoPath: join(reposDir, entry.name),
    });
  }

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
  if (entries.length === 0) {
    if (config.type === 'multi-repo') {
      return [];
    }
    return [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: worktreePath }];
  }
  return entries.map((entry) => ({
    repoId: entry.repoId,
    rootPath: entry.repoPath,
  }));
}
