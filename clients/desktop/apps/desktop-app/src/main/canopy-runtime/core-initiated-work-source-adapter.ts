import { AsyncLocalStorage } from 'node:async_hooks';
import type { HookAction } from '@canopy/desktop-shared/hooks';
import type { CoreHookSourceTarget } from '@canopy/protocol/canopy-core';
import {
  createCoreInitiatedWorkSourceHandlers,
  type CoreHookSourceHost,
  type CoreInitiatedWorkSourceHandlers,
  type HookSourceLayer,
} from '@canopy/core-runtime/node/initiated-work/hook-sources';
import {
  readProjectHookLayers,
  readWorkspaceRepoHookLayers,
  readWorkspaceRootHookLayers,
  type HookLayerRead,
  type ResolvedHookMap,
} from '../lib/hook-resolver';
import { IdentifierValidationError } from '../lib/identifier-validation-error';
import { validateId } from '../lib/validation';
import {
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
  getWorktreeDir,
} from '../lib/paths';
import { readWorkspaceConfig } from '../lib/workspace-persistence';

/** Host-typed values captured for one in-process compatibility projection. */
export interface HookSourceProjection {
  resolved?: ResolvedHookMap;
  layers?: HookSourceLayer<HookAction>[];
}

const projectionContext = new AsyncLocalStorage<HookSourceProjection>();

/** Runs a dispatch and returns what the handler resolved, in host types. */
export async function captureHookSourceProjection<Result>(
  dispatch: () => Promise<Result>,
): Promise<{ result: Result; projection: HookSourceProjection }> {
  const projection: HookSourceProjection = {};
  const result = await projectionContext.run(projection, dispatch);
  return { result, projection };
}

// Target IDs become path segments, and the relay lets renderer principals
// call these queries directly, so every ID is validated before any read.
function validateHookSourceTarget(target: CoreHookSourceTarget): void {
  validateId(
    target.workspaceId,
    target.kind === 'project' ? 'projectId' : 'workspaceId',
  );
  if (target.worktreeId) validateId(target.worktreeId, 'worktreeId');
  if (target.kind === 'workspace-repo') validateId(target.repoId, 'repoId');
}

/** Maps a target to the checkout and config the legacy hook readers used. */
export async function readHookSourceTargetLayers(
  target: CoreHookSourceTarget,
): Promise<HookLayerRead> {
  validateHookSourceTarget(target);
  if (target.kind === 'project') {
    const config = await readWorkspaceConfig(target.workspaceId);
    const checkout = target.worktreeId
      ? getWorktreeDir(target.workspaceId, target.worktreeId)
      : undefined;
    return readProjectHookLayers(
      {
        id: target.workspaceId,
        owner: config.owner,
        repoPath: config.repoPath ?? checkout ?? '',
        hooks: config.hooks,
      },
      checkout,
    );
  }
  if (target.kind === 'workspace-root') {
    return readWorkspaceRootHookLayers(
      target.workspaceId,
      target.worktreeId
        ? {
            workspaceRootPath: getWorkspaceWorktreeRootRepoDir(
              target.workspaceId,
              target.worktreeId,
            ),
          }
        : undefined,
    );
  }
  return readWorkspaceRepoHookLayers(
    target.workspaceId,
    target.repoId,
    target.worktreeId
      ? {
          workspaceRootPath: getWorkspaceWorktreeRootRepoDir(
            target.workspaceId,
            target.worktreeId,
          ),
          repoPath: getWorkspaceWorktreeRepoDir(
            target.workspaceId,
            target.worktreeId,
            target.repoId,
          ),
        }
      : undefined,
  );
}

export const desktopHookSourceHost: CoreHookSourceHost<HookAction> = {
  readLayers: readHookSourceTargetLayers,
  isInvalidTarget: (error) => error instanceof IdentifierValidationError,
  observeResolved: (resolved) => {
    const projection = projectionContext.getStore();
    if (projection) projection.resolved = resolved;
  },
  observeLayers: (layers) => {
    const projection = projectionContext.getStore();
    if (projection) projection.layers = layers;
  },
};

/** `core.initiatedWork.source.*` handlers over the desktop hook files. */
export function createCoreInitiatedWorkSourceAdapter(
  host: CoreHookSourceHost<HookAction> = desktopHookSourceHost,
): CoreInitiatedWorkSourceHandlers {
  return createCoreInitiatedWorkSourceHandlers(host);
}
