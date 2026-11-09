import { serializeRepoMap } from '@canopy/desktop-shared/pipelines/base-branch-env';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { setBrandEnv } from '@canopy/execution-engine/brand/env';
import { resolveEffectiveBaseBranchesForWorktree } from '../lib/worktree-base-branches';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { isCoworkWorkspace } from '../lib/workspace-registry';

function buildPrimaryBaseBranchEnv(
  isMultiRepoWorkspace: boolean,
  branchByRepo: Record<string, string>,
  existsInRemoteByRepo: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};

  const workspaceRootBranch = branchByRepo[WORKSPACE_ROOT_REPO_ID];
  if (workspaceRootBranch) {
    setBrandEnv(env, 'BASE_BRANCH', workspaceRootBranch);
    setBrandEnv(
      env,
      'BASE_BRANCH_EXISTS_IN_REMOTE',
      existsInRemoteByRepo[WORKSPACE_ROOT_REPO_ID] ?? 'false',
    );
    return env;
  }

  if (isMultiRepoWorkspace) {
    return env;
  }

  const repoIds = Object.keys(branchByRepo);
  if (repoIds.length !== 1) {
    return env;
  }

  const repoId = repoIds[0];
  const branchName = branchByRepo[repoId];
  if (!branchName) {
    return env;
  }

  setBrandEnv(env, 'BASE_BRANCH', branchName);
  setBrandEnv(
    env,
    'BASE_BRANCH_EXISTS_IN_REMOTE',
    existsInRemoteByRepo[repoId] ?? 'false',
  );
  return env;
}

export async function buildPipelineBaseBranchEnv(params: {
  cwd: string;
  projectId?: string;
  worktreeId?: string;
}): Promise<Record<string, string>> {
  if (!params.projectId || !params.worktreeId) {
    return {};
  }

  // Cowork workspaces have no git repos/branches: runs execute directory-
  // scoped at the cowork root, so base-branch env (which shells out to git)
  // must be a no-op. Covers both real cowork ids and the legacy sentinel.
  if (isCoworkWorkspace(params.projectId)) {
    return {};
  }

  const effectiveBaseBranches = await resolveEffectiveBaseBranchesForWorktree({
    projectId: params.projectId,
    worktreeId: params.worktreeId,
    cwd: params.cwd,
  });
  const workspaceConfig = await readWorkspaceConfig(params.projectId);

  const branchByRepo: Record<string, string> = {};
  const existsInRemoteByRepo: Record<string, string> = {};
  for (const [repoId, effectiveBaseBranch] of Object.entries(
    effectiveBaseBranches,
  )) {
    if (!effectiveBaseBranch.branch) {
      continue;
    }

    branchByRepo[repoId] = effectiveBaseBranch.branch;
    existsInRemoteByRepo[repoId] = effectiveBaseBranch.existsInRemote
      ? 'true'
      : 'false';
  }

  const env = buildPrimaryBaseBranchEnv(
    workspaceConfig.type === 'multi-repo',
    branchByRepo,
    existsInRemoteByRepo,
  );
  const serializedBranchesByRepo = serializeRepoMap(branchByRepo);
  if (serializedBranchesByRepo) {
    setBrandEnv(env, 'BASE_BRANCH_BY_REPO', serializedBranchesByRepo);
  }

  const serializedExistsByRepo = serializeRepoMap(existsInRemoteByRepo);
  if (serializedExistsByRepo) {
    setBrandEnv(
      env,
      'BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO',
      serializedExistsByRepo,
    );
  }

  return env;
}
