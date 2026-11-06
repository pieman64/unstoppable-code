import type { RedeemedExecutionSecrets } from '@canopy/core-runtime/node/execution-secrets';
import { lstat, mkdir } from 'node:fs/promises';
import { setBrandEnv } from '@canopy/desktop-shared/brand/env';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  WorkerScriptContext,
  WorkerScriptExecuteParams,
} from '@canopy/protocol/canopy-core';
import {
  scriptContextUnavailableError,
  type ScriptExecutionPlace,
} from '@canopy/core-runtime/node/script/execution';
import { getEnhancedEnv } from '../pipelines/config-paths';
import {
  getAppAdvisorHomeDir,
  getSharedContainerRunRepoDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
  getWorktreeDir,
} from './paths';
import { buildSharedContainerRunEnv } from './shared-container-run-env';
import { validateId } from './validation';
import { buildWorktreeDataEnv } from './worktree-data-env';

function validIds(...ids: string[]): boolean {
  try {
    ids.forEach((id) => validateId(id, 'id'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The desktop's projection of a `worker.script.execute` scope and context
 * onto its trusted checkouts and environments (CAN-4143). Scripts run with
 * the worktree data environment; a shared-container run gets exactly the
 * declared variables its recipient assigned, supplied by the redeemed launch.
 */
export async function resolveScriptExecutionPlace(
  scope: WorkerScriptExecuteParams['scope'],
  context: WorkerScriptContext,
  secrets: RedeemedExecutionSecrets,
): Promise<ScriptExecutionPlace> {
  if (context.kind === 'automation-home') {
    const cwd = getAppAdvisorHomeDir();
    await mkdir(cwd, { recursive: true });
    return {
      cwd,
      env: {
        ...getEnhancedEnv({
          environment: { runtime: 'canopy', values: 'public' },
          includeCanopySecrets: false,
        }),
        ...secrets.env,
      },
    };
  }
  const { workspaceId, worktreeId } = scope;
  if (
    workspaceId === undefined ||
    worktreeId === undefined ||
    !validIds(workspaceId, worktreeId)
  )
    throw scriptContextUnavailableError();
  switch (context.kind) {
    case 'project':
      return {
        cwd: getWorktreeDir(workspaceId, worktreeId),
        env: buildWorktreeDataEnv(workspaceId, worktreeId, undefined, {
          runtime: 'canopy',
          secretEnv: secrets.env,
        }),
      };
    case 'workspace-root':
      return {
        cwd: getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId),
        env: buildWorktreeDataEnv(workspaceId, worktreeId, undefined, {
          runtime: 'canopy',
          secretEnv: secrets.env,
        }),
      };
    case 'workspace-repo': {
      if (!validIds(context.repoId)) throw scriptContextUnavailableError();
      const childRepoEnv: NodeJS.ProcessEnv = {};
      setBrandEnv(childRepoEnv, 'WORKSPACE_CHILD_REPO_ID', context.repoId);
      return {
        cwd: getWorkspaceWorktreeRepoDir(
          workspaceId,
          worktreeId,
          context.repoId,
        ),
        env: buildWorktreeDataEnv(workspaceId, worktreeId, childRepoEnv, {
          runtime: 'canopy',
          secretEnv: secrets.env,
        }),
      };
    }
    case 'shared-container': {
      if (workspaceId !== SHARED_CONTAINER_VIEWER_PROJECT_ID)
        throw scriptContextUnavailableError();
      // The run copy's own repository ID rule, which admits the workspace
      // root's reserved ID.
      let cwd: string;
      try {
        cwd = getSharedContainerRunRepoDir(worktreeId, context.repoId);
      } catch {
        throw scriptContextUnavailableError();
      }
      const cwdInfo = await lstat(cwd).catch(() => null);
      if (!cwdInfo || !cwdInfo.isDirectory() || cwdInfo.isSymbolicLink())
        throw scriptContextUnavailableError();
      const declared = new Set(context.environmentKeys);
      return {
        cwd,
        env: buildSharedContainerRunEnv(
          worktreeId,
          Object.fromEntries(
            Object.entries(secrets.env).filter(([key]) => declared.has(key)),
          ),
        ),
      };
    }
  }
}
