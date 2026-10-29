import type {
  WorkspaceConfigFile,
  CanopyJsonRepoEntry,
  WorkspaceRepoData,
  WorkspaceSettingsDataResponse,
} from '@canopy/desktop-shared/types';
import { readCanopyJson, hasManifestRepos } from './canopy-json';
import { computeWorkspaceDriftIssues } from './workspace-drift';
import { getWorkspaceWorktreeRootRepoDir } from './paths';
import { resolveProjectReferenceRepoPath } from './project-reference-repo';
import { readWorkspaceConfig } from './workspace-persistence';
import {
  getCachedStatus,
  requestRefresh,
} from './workspace-reference-repo-poller';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';

export interface EffectiveWorkspaceConfig {
  sourceRepoPath?: string;
  manifest: WorkspaceSettingsDataResponse['manifest'];
  repos: WorkspaceRepoData[];
  scripts: WorkspaceSettingsDataResponse['localConfig']['scripts'];
  hooks?: WorkspaceSettingsDataResponse['localConfig']['hooks'];
  defaultPluginSelections: WorkspaceSettingsDataResponse['localConfig']['defaultPluginSelections'];
  suppressedRepoIds?: string[];
  suppressedManifestRepos: CanopyJsonRepoEntry[];
  unresolvedManifestRepoIds: string[];
  localConfig: WorkspaceSettingsDataResponse['localConfig'];
  alwaysShow?: boolean;
  /** Organization ownership from the local config; manifests never set it. */
  owner?: WorkspaceConfigFile['owner'];
  temporary?: boolean;
  temporarySourceWorkspaceIds?: string[];
  temporaryRepoIdentityKeys?: string[];
}

export async function readEffectiveWorkspaceConfig(
  workspaceId: string,
  /** An already-read local config, so the caller's read is the one used. */
  preReadLocalConfig?: WorkspaceConfigFile,
): Promise<EffectiveWorkspaceConfig> {
  const localConfig =
    preReadLocalConfig ?? (await readWorkspaceConfig(workspaceId));

  if (localConfig.type === 'single-repo' || !localConfig.sourceRepoPath) {
    return {
      sourceRepoPath: undefined,
      manifest: null,
      repos: localConfig.repos,
      scripts: localConfig.scripts,
      hooks: localConfig.hooks,
      defaultPluginSelections: localConfig.defaultPluginSelections,
      suppressedRepoIds: localConfig.suppressedRepoIds,
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
      localConfig,
      alwaysShow: localConfig.alwaysShow,
      owner: localConfig.owner,
      temporary: localConfig.temporary === true ? true : undefined,
      temporarySourceWorkspaceIds: localConfig.temporarySourceWorkspaceIds,
      temporaryRepoIdentityKeys: localConfig.temporaryRepoIdentityKeys,
    };
  }

  const referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
    localConfig.sourceRepoPath,
  );
  const manifest = await readCanopyJson(referenceRepoPath);
  if (manifest === null || !hasManifestRepos(manifest)) {
    return {
      sourceRepoPath: localConfig.sourceRepoPath,
      manifest,
      repos: localConfig.repos,
      scripts: localConfig.scripts,
      hooks: localConfig.hooks,
      defaultPluginSelections: localConfig.defaultPluginSelections,
      suppressedRepoIds: localConfig.suppressedRepoIds,
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
      localConfig,
      alwaysShow: localConfig.alwaysShow,
      owner: localConfig.owner,
      temporary: localConfig.temporary === true ? true : undefined,
      temporarySourceWorkspaceIds: localConfig.temporarySourceWorkspaceIds,
      temporaryRepoIdentityKeys: localConfig.temporaryRepoIdentityKeys,
    };
  }

  const localRepoById = new Map(
    localConfig.repos.map((repo) => [repo.id, repo]),
  );
  const manifestRepoIds = new Set<string>();
  const suppressedRepoIds = new Set(localConfig.suppressedRepoIds ?? []);
  const effectiveRepos: WorkspaceRepoData[] = [];
  const suppressedManifestRepos: CanopyJsonRepoEntry[] = [];
  const unresolvedManifestRepoIds: string[] = [];

  for (const manifestRepo of manifest.repos ?? []) {
    manifestRepoIds.add(manifestRepo.id);
    if (suppressedRepoIds.has(manifestRepo.id)) {
      suppressedManifestRepos.push(manifestRepo);
      continue;
    }

    const localRepo = localRepoById.get(manifestRepo.id);
    if (!localRepo) {
      unresolvedManifestRepoIds.push(manifestRepo.id);
      continue;
    }

    effectiveRepos.push({
      id: manifestRepo.id,
      name: localRepo.name,
      repoPath: localRepo.repoPath,
      source: 'manifest',
      manifestUrl: manifestRepo.url,
      scripts: localRepo.scripts,
      hooks: localRepo.hooks,
    });
  }

  for (const localRepo of localConfig.repos) {
    if (manifestRepoIds.has(localRepo.id)) {
      continue;
    }

    effectiveRepos.push({
      ...localRepo,
      source: 'local',
    });
  }

  return {
    sourceRepoPath: localConfig.sourceRepoPath,
    manifest,
    repos: effectiveRepos,
    scripts: localConfig.scripts,
    hooks: localConfig.hooks,
    defaultPluginSelections: localConfig.defaultPluginSelections,
    suppressedRepoIds: localConfig.suppressedRepoIds,
    suppressedManifestRepos,
    unresolvedManifestRepoIds,
    localConfig,
    alwaysShow: localConfig.alwaysShow,
    owner: localConfig.owner,
    temporary: localConfig.temporary === true ? true : undefined,
    temporarySourceWorkspaceIds: localConfig.temporarySourceWorkspaceIds,
    temporaryRepoIdentityKeys: localConfig.temporaryRepoIdentityKeys,
  };
}

export async function readWorkspaceSettingsData(
  workspaceId: string,
  worktreeId?: string,
): Promise<WorkspaceSettingsDataResponse> {
  const config = await readWorkspaceConfig(workspaceId);
  let referenceRepoPath: string | undefined;
  let manifest: WorkspaceSettingsDataResponse['manifest'] = null;
  let referenceRepoStatus: WorkspaceSettingsDataResponse['referenceRepoStatus'];

  if (config.type === 'single-repo' && config.repoPath) {
    referenceRepoPath = await resolveProjectReferenceRepoPath(config.repoPath);
    manifest = await readCanopyJson(referenceRepoPath);
  } else if (config.sourceRepoPath) {
    referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
      config.sourceRepoPath,
    );
    requestRefresh(workspaceId);
    referenceRepoStatus = getCachedStatus(workspaceId);
  }
  const [effective, drift] = await Promise.all([
    readEffectiveWorkspaceConfig(workspaceId),
    computeWorkspaceDriftIssues(workspaceId, worktreeId),
  ]);

  // When inspecting a specific worktree, read the manifest from that worktree's
  // checkout so the "Source Controlled" view shows branch-specific content.
  const fallbackManifest =
    config.type === 'single-repo' ? manifest : effective.manifest;

  let resolvedManifest: WorkspaceSettingsDataResponse['manifest'] =
    fallbackManifest;
  if (worktreeId) {
    const worktreeRepoDir = getWorkspaceWorktreeRootRepoDir(
      workspaceId,
      worktreeId,
    );
    const worktreeManifest = await readCanopyJson(worktreeRepoDir);
    if (worktreeManifest !== null) {
      resolvedManifest = worktreeManifest;
    }
  }

  return {
    manifest: resolvedManifest,
    localConfig: effective.localConfig,
    effectiveRepos: effective.repos,
    sourceRepoPath: effective.sourceRepoPath,
    referenceRepoPath,
    referenceRepoStatus,
    suppressedManifestRepos: effective.suppressedManifestRepos,
    unresolvedManifestRepoIds: effective.unresolvedManifestRepoIds,
    driftIssues: drift.issues,
    driftTargetPath: drift.targetCanopyJsonPath,
    driftWorktreeId: worktreeId,
  };
}
