import { randomUUID } from 'node:crypto';
import {
  CoreSharedContainerForkParamsSchema,
  CoreWorkspaceCompositionPromoteParamsSchema,
  CoreWorkspaceSourceChangesApplyParamsSchema,
  CoreWorkspaceSourceRepoInitializeParamsSchema,
  CoreWorkspaceTypeConvertParamsSchema,
  CoreWorktreeBranchRenameParamsSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { CoreSourceCompositionCommandName } from '@canopy/core-runtime/node/workspace/source-composition-commands';
import type { SharedContainerForkRequest } from '@canopy/protocol/shared-containers';
import type {
  ProjectApplySourceChangesRequest,
  WorkspaceApplySourceChangesRequest,
} from '@canopy/desktop-shared/types';
import {
  projectWorkspaceLifecycleCommand,
  type WorkspaceLifecycleProjectionTarget,
} from './workspace-lifecycle-dispatch';

/*
 * The IPC projections of the registered keyed lifecycles (W7b-4, CAN-5552),
 * W7b-3/2a's mechanism (`workspace-lifecycle-dispatch.ts`): each IPC call
 * dispatches its operation with the write grant added for this call and a
 * minted dispatcher key, and hands the handler the exact host request it made
 * before through an in-process projection context. The handler runs that
 * request unchanged (unkeyed, `desktop-host:*` receipts, its own window
 * hooks), so bytes, results and errors stay as they were, and the minted key
 * never reaches a receipt. A request the wire schema cannot express keeps its
 * in-process call (compatibility debt in the CAN-5552 inventory).
 */

// No IPC channel projects combine, split or retry (CAN-5710's cloud form).
type ProjectedOperation = Exclude<
  CoreSourceCompositionCommandName,
  | 'core.workspace.composition.combine'
  | 'core.workspace.composition.split'
  | 'core.workspace.composition.retry'
>;

function project<T>(
  operation: ProjectedOperation,
  run: () => Promise<T>,
  dispatch: () => Promise<unknown>,
): Promise<T> {
  return projectWorkspaceLifecycleCommand(operation, dispatch, run);
}

function withGrant(
  caller: CanopyCallerDescriptor,
  grant: 'core.workspace.write' | 'core.worktree.write',
): CanopyCallerDescriptor {
  return { ...caller, grants: [grant] };
}

/** The wire form of an IPC source change; host-only fields are dropped. */
function wireSourceChanges(
  workspaceId: string,
  request:
    | WorkspaceApplySourceChangesRequest
    | ProjectApplySourceChangesRequest,
): Record<string, unknown> {
  const common = {
    workspaceId,
    target: request.target,
    ...(request.startPage !== undefined && { startPage: request.startPage }),
  };
  if ('projectId' in request)
    return {
      ...common,
      ...(request.scripts !== undefined && { scripts: request.scripts }),
      ...(request.hooks !== undefined && { hooks: request.hooks }),
      ...(request.plugins !== undefined && { plugins: request.plugins }),
    };
  return {
    ...common,
    ...(request.workspaceScripts !== undefined && {
      scripts: request.workspaceScripts,
    }),
    ...(request.workspaceHooks !== undefined && {
      hooks: request.workspaceHooks,
    }),
    ...(request.workspacePlugins !== undefined && {
      plugins: request.workspacePlugins,
    }),
    ...(request.claudeMd !== undefined && { claudeMd: request.claudeMd }),
    ...(request.repoScriptChanges !== undefined && {
      repoScriptChanges: request.repoScriptChanges,
    }),
    ...(request.repoHookChanges !== undefined && {
      repoHookChanges: request.repoHookChanges,
    }),
    ...(request.repoAdds !== undefined && {
      repoAdds: request.repoAdds.map((add) => ({
        ...(add.repoId !== undefined && { repoId: add.repoId }),
        repoName: add.repoName,
        remoteUrl: add.remoteUrl,
        ...(add.scripts !== undefined && { scripts: add.scripts }),
        ...(add.hooks !== undefined && { hooks: add.hooks }),
      })),
    }),
    ...(request.repoRemovals !== undefined && {
      repoRemovals: request.repoRemovals,
    }),
  };
}

export interface ProjectedSourceCompositionCommands {
  initializeSourceRepo<T>(
    request: { workspaceId: string; repoName?: string },
    run: () => Promise<T>,
  ): Promise<T>;
  convertType<T>(
    request: {
      workspaceId: string;
      targetType: 'multi-repo' | 'single-repo';
      claudeMdMode?: 'replace' | 'update' | 'unchanged';
    },
    run: () => Promise<T>,
  ): Promise<T>;
  applySourceChanges<T>(
    workspaceId: string,
    request:
      | WorkspaceApplySourceChangesRequest
      | ProjectApplySourceChangesRequest,
    run: () => Promise<T>,
  ): Promise<T>;
  promote<T>(
    request: { workspaceId: string; name: string },
    run: () => Promise<T>,
  ): Promise<T>;
  renameBranch<T>(
    request: {
      workspaceId: string;
      worktreeId: string;
      repoId?: string;
      newBranchName: string;
    },
    run: () => Promise<T>,
  ): Promise<T>;
  fork<T>(
    request: SharedContainerForkRequest,
    run: () => Promise<T>,
  ): Promise<T>;
}

/**
 * The lifecycle IPC channels, each projected through its registered
 * operation. `run` is the channel's own host call, unchanged.
 */
export function projectedSourceCompositionCommands(
  target: WorkspaceLifecycleProjectionTarget,
): ProjectedSourceCompositionCommands {
  const { dispatcher } = target;
  const workspaceCaller = withGrant(target.caller, 'core.workspace.write');
  return {
    initializeSourceRepo(request, run) {
      const key = randomUUID();
      const params = CoreWorkspaceSourceRepoInitializeParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        ...(request.repoName !== undefined && { repoName: request.repoName }),
        _meta: { idempotencyKey: key },
      });
      if (!params.success) return run();
      return project('core.workspace.sourceRepo.initialize', run, () =>
        dispatcher.instruction(
          'core.workspace.sourceRepo.initialize',
          params.data,
          { caller: workspaceCaller, metadata: { idempotencyKey: key } },
        ),
      );
    },
    convertType(request, run) {
      const key = randomUUID();
      const params = CoreWorkspaceTypeConvertParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        targetKind:
          request.targetType === 'multi-repo' ? 'multi_repo' : 'single_repo',
        ...(request.claudeMdMode !== undefined && {
          claudeMdMode: request.claudeMdMode,
        }),
        _meta: { idempotencyKey: key },
      });
      if (!params.success) return run();
      return project('core.workspace.type.convert', run, () =>
        dispatcher.instruction('core.workspace.type.convert', params.data, {
          caller: workspaceCaller,
          metadata: { idempotencyKey: key },
        }),
      );
    },
    applySourceChanges(workspaceId, request, run) {
      const key = randomUUID();
      const params = CoreWorkspaceSourceChangesApplyParamsSchema.safeParse({
        ...wireSourceChanges(workspaceId, request),
        _meta: { idempotencyKey: key },
      });
      if (!params.success) return run();
      return project('core.workspace.sourceChanges.apply', run, () =>
        dispatcher.instruction(
          'core.workspace.sourceChanges.apply',
          params.data,
          { caller: workspaceCaller, metadata: { idempotencyKey: key } },
        ),
      );
    },
    promote(request, run) {
      const key = randomUUID();
      // The page requires a revision; the projection's host request is
      // unrevisioned, so `0` only satisfies the schema and is never checked.
      const params = CoreWorkspaceCompositionPromoteParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        expectedRevision: 0,
        name: request.name,
        _meta: { idempotencyKey: key },
      });
      if (!params.success) return run();
      return project('core.workspace.composition.promote', run, () =>
        dispatcher.instruction(
          'core.workspace.composition.promote',
          params.data,
          { caller: workspaceCaller, metadata: { idempotencyKey: key } },
        ),
      );
    },
    renameBranch(request, run) {
      const key = randomUUID();
      const params = CoreWorktreeBranchRenameParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        worktreeId: request.worktreeId,
        ...(request.repoId !== undefined && { repoId: request.repoId }),
        branchName: request.newBranchName,
        _meta: { idempotencyKey: key },
      });
      if (!params.success) return run();
      return project('core.worktree.branch.rename', run, () =>
        dispatcher.instruction('core.worktree.branch.rename', params.data, {
          caller: withGrant(target.caller, 'core.worktree.write'),
          metadata: { idempotencyKey: key },
        }),
      );
    },
    fork(request, run) {
      const key = randomUUID();
      const { destination } = request;
      const params = CoreSharedContainerForkParamsSchema.safeParse({
        containerId: request.containerId,
        revisionId: request.revisionId,
        ...(request.organizationId !== undefined && {
          organizationId: request.organizationId,
        }),
        sourceOwnerDisplayName: request.sourceOwnerDisplayName,
        // The new workspace's parent directory is the host request's own.
        destination:
          destination.kind === 'existing-workspace'
            ? destination
            : { kind: destination.kind, owner: destination.owner },
        ...(request.expectedPackageDigest !== undefined && {
          expectedPackageDigest: request.expectedPackageDigest,
        }),
        _meta: { idempotencyKey: key },
      });
      if (!params.success) return run();
      return project('core.sharedContainer.fork', run, () =>
        dispatcher.instruction('core.sharedContainer.fork', params.data, {
          caller: workspaceCaller,
          metadata: { idempotencyKey: key },
        }),
      );
    },
  };
}
