import {
  getHookTriggerDisplayName,
  type HookSourceInfoRequest,
  type HookSourceInfoResponse,
} from '@canopy/desktop-shared/types';
import {
  CORE_INITIATED_WORK_SOURCE_GRANTS,
  type CanopyCallerDescriptor,
  type CoreHookSourceTarget,
} from '@canopy/protocol/canopy-core';
import { effectiveHookSourceActions } from '@canopy/core-runtime/node/initiated-work/hook-sources';
import {
  labelHookSourceLayers,
  type ResolvedHookMap,
} from '../lib/hook-resolver';
import { validateId } from '../lib/validation';
import { captureHookSourceProjection } from './core-initiated-work-source-adapter';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import type { DesktopCanopyDispatcher } from './desktop-runtime';
import { preserveRuntimeCauseError } from './runtime-cause-error';

/*
 * The `core.initiatedWork.source.*` projections behind `hook:source-info`,
 * the Portal `portal.hook.source_info` command and the Portal hook list.
 * Each call holds only `core.initiatedWork.read`. Results come back in host
 * types from the in-process handler, so legacy payloads are unchanged.
 */

export type HookSourceDispatcher = Pick<DesktopCanopyDispatcher, 'query'>;

/** Main-process readers with no interface session of their own. */
export const HOOK_SOURCE_HOST_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-hook-sources',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [CORE_INITIATED_WORK_SOURCE_GRANTS.read],
};

function hookSourceReadCaller(
  caller: CanopyCallerDescriptor,
): CanopyCallerDescriptor {
  return { ...caller, grants: [CORE_INITIATED_WORK_SOURCE_GRANTS.read] };
}

function projectionMissing(): never {
  throw new Error('Hook source projection was not captured.');
}

// Legacy readers treated an empty worktree ID as absent.
function worktreeField(worktreeId: unknown): { worktreeId?: string } {
  return typeof worktreeId === 'string' && worktreeId.length > 0
    ? { worktreeId }
    : {};
}

/** Validates identifiers first so a rejected ID keeps its legacy message. */
export function hookSourceTarget(
  request: HookSourceInfoRequest,
): CoreHookSourceTarget {
  if (request.target === 'project') {
    validateId(request.projectId, 'projectId');
    return {
      kind: 'project',
      workspaceId: request.projectId,
      ...worktreeField(request.worktreeId),
    };
  }
  validateId(request.workspaceId, 'workspaceId');
  if (request.target === 'workspace-root') {
    return {
      kind: 'workspace-root',
      workspaceId: request.workspaceId,
      ...worktreeField(request.worktreeId),
    };
  }
  return {
    kind: 'workspace-repo',
    workspaceId: request.workspaceId,
    repoId: request.repoId,
    ...worktreeField(request.worktreeId),
  };
}

/** `core.initiatedWork.source.get`, projected to the legacy source info. */
export async function getHookSourceInfoThroughCore(
  dispatcher: HookSourceDispatcher,
  caller: CanopyCallerDescriptor,
  request: HookSourceInfoRequest,
): Promise<HookSourceInfoResponse> {
  const target = hookSourceTarget(request);
  const triggerName = request.triggerName;
  const { projection } = await captureHookSourceProjection(() =>
    preserveRuntimeCauseError(
      dispatcher.query(
        'core.initiatedWork.source.get',
        { sourceKind: 'hook', target, triggerName },
        { caller: hookSourceReadCaller(caller) },
      ),
    ),
  );
  const layers = projection.layers ?? projectionMissing();
  return {
    triggerName,
    triggerDisplayName: getHookTriggerDisplayName(triggerName),
    effectiveActions: effectiveHookSourceActions(layers),
    layers: labelHookSourceLayers(layers),
  };
}

/** `core.initiatedWork.source.list`, projected to the resolved hook map. */
export async function listHookSourcesThroughCore(
  dispatcher: HookSourceDispatcher,
  caller: CanopyCallerDescriptor,
  target: CoreHookSourceTarget,
): Promise<ResolvedHookMap> {
  const { projection } = await captureHookSourceProjection(() =>
    preserveRuntimeCauseError(
      dispatcher.query(
        'core.initiatedWork.source.list',
        { sourceKind: 'hook', target },
        { caller: hookSourceReadCaller(caller) },
      ),
    ),
  );
  return projection.resolved ?? projectionMissing();
}
