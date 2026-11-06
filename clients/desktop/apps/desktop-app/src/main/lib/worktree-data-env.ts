import type { EnvironmentRuntime } from '@canopy/desktop-shared/types';
import { getBrandEnv, setBrandEnv } from '@canopy/desktop-shared/brand/env';
import { getWorktreeDataDir } from './paths';
import { getEnhancedEnv } from '../pipelines/config-paths';

export function buildWorktreeDataEnv(
  projectId: string,
  worktreeId: string,
  env?: NodeJS.ProcessEnv,
  options?: {
    runtime?: EnvironmentRuntime;
    secretEnv?: Readonly<Record<string, string>>;
  },
): NodeJS.ProcessEnv {
  const runtime = options?.runtime ?? 'canopy';
  const nextEnv: NodeJS.ProcessEnv = {
    ...getEnhancedEnv(
      options?.secretEnv !== undefined
        ? {
            environment: { runtime, workspaceId: projectId, values: 'public' },
            includeCanopySecrets: false,
          }
        : { environment: { runtime, workspaceId: projectId } },
    ),
    ...options?.secretEnv,
    ...env,
    CONDUCTOR_WORKSPACE_NAME: worktreeId,
  };
  setBrandEnv(nextEnv, 'WORKSPACE_ID', projectId);
  setBrandEnv(nextEnv, 'WORKTREE_NAME', worktreeId);
  setBrandEnv(
    nextEnv,
    'WORKTREE_DATA_DIR',
    getWorktreeDataDir(projectId, worktreeId),
  );
  const childRepoId = getBrandEnv(nextEnv, 'WORKSPACE_CHILD_REPO_ID');
  if (childRepoId) {
    setBrandEnv(nextEnv, 'WORKSPACE_CHILD_REPO_ID', childRepoId);
  }
  return nextEnv;
}
