import type {
  CanopyJsonRepoEntry,
  CanopyJsonFile,
  WorkspaceConfigFile,
  WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import { getManifestRepoById, readCanopyJson } from './canopy-json';
import { getBaselineReadPath } from './repo-shadow';
import { readWorkspaceConfig } from './workspace-persistence';

/** The workspace has no repository with this id. */
export class WorkspaceRepoNotFoundError extends Error {
  constructor(workspaceId: string, repoId: string) {
    super(`Repo ${repoId} not found in project ${workspaceId}`);
    this.name = 'WorkspaceRepoNotFoundError';
  }
}

export interface WorkspaceRepoLayerPaths {
  workspaceRootPath?: string;
  repoPath?: string;
  localConfig?: WorkspaceConfigFile;
}

export interface WorkspaceRepoLayerContext {
  localConfig: WorkspaceConfigFile;
  repo: WorkspaceRepoData;
  repoPath: string;
  repoManifest: CanopyJsonFile | null;
  workspaceManifestRepo?: CanopyJsonRepoEntry;
}

export async function readWorkspaceRepoLayerContext(
  workspaceId: string,
  repoId: string,
  paths?: WorkspaceRepoLayerPaths,
): Promise<WorkspaceRepoLayerContext> {
  const localConfig =
    paths?.localConfig ?? (await readWorkspaceConfig(workspaceId));
  const repo = localConfig.repos.find((candidate) => candidate.id === repoId);
  if (!repo) {
    throw new WorkspaceRepoNotFoundError(workspaceId, repoId);
  }

  const repoPath = paths?.repoPath ?? repo.repoPath;
  const [repoManifest, workspaceManifest] = await Promise.all([
    readCanopyJson(repoPath),
    readWorkspaceCanopyManifest(localConfig, paths?.workspaceRootPath),
  ]);
  const workspaceManifestRepo = workspaceManifest
    ? getManifestRepoById(workspaceManifest, repoId)
    : undefined;

  return {
    localConfig,
    repo,
    repoPath,
    repoManifest,
    workspaceManifestRepo,
  };
}

export async function readWorkspaceCanopyManifest(
  localConfig: {
    sourceRepoPath?: string;
  },
  workspaceRootPathOverride?: string,
): Promise<CanopyJsonFile | null> {
  const workspaceRootPath = workspaceRootPathOverride
    ? workspaceRootPathOverride
    : localConfig.sourceRepoPath
      ? await getBaselineReadPath(localConfig.sourceRepoPath)
      : undefined;
  if (!workspaceRootPath) {
    return null;
  }

  return readCanopyJson(workspaceRootPath);
}
