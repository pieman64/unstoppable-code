import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  CORE_WORKSPACE_METADATA_GRANTS,
  CoreWorkspacePlanDetectionUpdateParamsSchema,
  CoreWorkspacePrivateMemoryUpdateParamsSchema,
  CoreWorkspaceReorderParamsSchema,
  CoreWorkspaceRepositoryAddParamsSchema,
  CoreWorkspaceRepositoryRemoveParamsSchema,
  CoreWorkspaceUpdateParamsSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { WorkspaceRepoData } from '@canopy/desktop-shared/types';
import type { WorkspaceMoveRequest } from '@canopy/core-runtime/node/w5/workspace-metadata/metadata';
import type { WorkspaceRepositoryCandidate } from '@canopy/core-runtime/node/w5/workspace-metadata/repositories';
import type { W5BoundaryOptions } from '@canopy/core-runtime/node/w5/boundary-operation';
import {
  reorderWorkspaces,
  updateWorkspaceMetadata,
  type WorkspaceMetadataPatch,
  type WorkspaceMetadataUpdateOutcome,
  type WorkspaceMetadataUpdateRequest,
  type WorkspaceReorderOutcome,
} from '../lib/workspace-metadata';
import {
  updateWorkspacePrivateMemory,
  type WorkspacePrivateMemoryUpdateOutcome,
  type WorkspacePrivateMemoryUpdateRequest,
} from '../lib/workspace-private-memory';
import {
  addWorkspaceRepository,
  removeWorkspaceRepository,
  type WorkspaceRepositoryRemoveOutcome,
  type WorkspaceRepositoryRemoveRequest,
} from '../lib/workspace-repositories';
import {
  updateWorkspacePlanDetection,
  type WorkspacePlanDetectionUpdateRequest,
  type WorktreeHooksSetPausedOutcome,
} from '../lib/workspace-script-hook-settings';
import type { WorkspaceRetentionUpdateOutcome } from '../lib/workspace-retention';
import type { WorktreeUpdateOutcome } from '../lib/worktree-update';
import type { WorkspacePluginsUpdateOutcome } from '../lib/workspace-plugin-defaults';
import type { CoworkSettingsUpdateOutcome } from '../lib/cowork-workspace-crud';
import type { DesktopCanopyDispatcher } from './desktop-runtime';

/*
 * The IPC projections of the registered `core.workspace.*` metadata commands
 * (W7a, CAN-5523). Each dispatches its operation with `core.workspace.write`
 * added for this call, so the dispatcher's grant check and draining apply,
 * and hands the handler the host request today's caller makes (its source,
 * its unkeyed `desktop-host:*` decision, a trusted path) in an in-process
 * projection context. The handler runs that request unchanged, so bytes,
 * results, receipts and errors stay as they were; the dispatcher key minted
 * per call never reaches a receipt. A request the wire cannot express, or a
 * keyed one, keeps its in-process call.
 */

type AddedRepository = WorkspaceRepoData & {
  scriptActionsOperationId?: string;
};

interface ProjectedOutcomes {
  // The caller's own outcome type; the handler never reads it.
  'core.workspace.update': unknown;
  'core.workspace.reorder': WorkspaceReorderOutcome;
  'core.workspace.planDetection.update': void;
  'core.workspace.privateMemory.update': WorkspacePrivateMemoryUpdateOutcome;
  'core.workspace.repository.add': AddedRepository;
  'core.workspace.repository.remove': WorkspaceRepositoryRemoveOutcome;
  // The guarded commands (W7b-1b and 1c, workspace-guarded-dispatch.ts).
  'core.workspace.hooks.update': void;
  'core.workspace.plugins.update': WorkspacePluginsUpdateOutcome;
  'core.workspace.retention.update': WorkspaceRetentionUpdateOutcome;
  'core.workspace.cowork.update': CoworkSettingsUpdateOutcome;
  'core.worktree.update': WorktreeUpdateOutcome;
  'core.worktree.reorder': void;
  'core.worktree.hooks.setPaused': WorktreeHooksSetPausedOutcome;
}

/** The host request one projected call runs, and how it settled. */
export interface WorkspaceMetadataProjection<T> {
  readonly run: () => Promise<T>;
  outcome?: { readonly value: T };
  failure?: { readonly error: unknown };
}

type ProjectionSlots = {
  [Operation in keyof ProjectedOutcomes]?: WorkspaceMetadataProjection<
    ProjectedOutcomes[Operation]
  >;
};

const projections = new AsyncLocalStorage<ProjectionSlots>();

/**
 * The projection the current call carries for `operation`, taken once so a
 * nested call of the same operation runs as a wire call.
 */
export function takeWorkspaceMetadataProjection<
  Operation extends keyof ProjectedOutcomes,
>(
  operation: Operation,
): WorkspaceMetadataProjection<ProjectedOutcomes[Operation]> | undefined {
  const slots = projections.getStore();
  const projection = slots?.[operation];
  if (slots) delete slots[operation];
  return projection;
}

/** Runs a projection's host request and records how it settled. */
export async function runWorkspaceMetadataProjection<T>(
  projection: WorkspaceMetadataProjection<T>,
): Promise<T> {
  let value: T;
  try {
    value = await projection.run();
  } catch (error) {
    projection.failure = { error };
    throw error;
  }
  projection.outcome = { value };
  return value;
}

/**
 * Ends a projected call once its host request answered, where building the
 * wire result would cost a read the IPC caller never uses (#3's workspace
 * projection): the projection's outcome is the answer.
 */
export class WorkspaceMetadataProjectionAnswered extends Error {
  constructor() {
    super('The IPC projection answered from its host request.');
    this.name = 'WorkspaceMetadataProjectionAnswered';
  }
}

export interface WorkspaceMetadataProjectionTarget {
  dispatcher: Pick<DesktopCanopyDispatcher, 'instruction'>;
  caller: CanopyCallerDescriptor;
}

/**
 * Once the host request settled, it is the answer: its outcome, or its own
 * error whatever the wire mapping made of it. A refusal before the handler
 * (grant, draining) is the dispatcher's.
 */
export async function project<T>(
  slots: ProjectionSlots,
  projection: WorkspaceMetadataProjection<T>,
  dispatch: () => Promise<unknown>,
): Promise<T> {
  try {
    await projections.run(slots, dispatch);
  } catch (error) {
    if (projection.outcome) return projection.outcome.value;
    if (projection.failure) throw projection.failure.error;
    throw hostError(error);
  }
  if (!projection.outcome)
    throw new Error('The workspace metadata projection did not run.');
  return projection.outcome.value;
}

function hostError(error: unknown): unknown {
  return error instanceof CanopyOperationError &&
    error.runtimeCause instanceof Error
    ? error.runtimeCause
    : error;
}

function withWriteGrant(
  caller: CanopyCallerDescriptor,
): CanopyCallerDescriptor {
  return { ...caller, grants: [CORE_WORKSPACE_METADATA_GRANTS.write] };
}

function revision(request: W5BoundaryOptions): { expectedRevision?: number } {
  return request.expectedRevision === undefined
    ? {}
    : { expectedRevision: request.expectedRevision };
}

/** The wire form of a desktop patch; undefined when it has none. */
function wirePatch(
  patch: WorkspaceMetadataPatch,
): Record<string, unknown> | undefined {
  const { startPage, ...fields } = patch;
  const defined = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  if (startPage === undefined) return defined;
  if (startPage.kind === 'inherit')
    return { ...defined, startPage: { kind: 'inherit' } };
  if (startPage.kind === 'set')
    return { ...defined, startPage: startPage.startPage };
  return undefined;
}

export interface ProjectedWorkspaceMetadataCommands {
  updateMetadata(
    request: WorkspaceMetadataUpdateRequest,
  ): Promise<WorkspaceMetadataUpdateOutcome>;
  /**
   * #3 for the name, color and Always show part of a mixed Cowork save,
   * whose `run` writes that part; its Cowork settings project #12 first
   * (W7b-1c, A28'(a)).
   */
  updateCoworkMetadata<T>(
    request: {
      workspaceId: string;
      patch: Pick<WorkspaceMetadataPatch, 'name' | 'color' | 'alwaysShow'>;
    },
    run: () => Promise<T>,
  ): Promise<T>;
  reorder(
    request: WorkspaceMoveRequest & W5BoundaryOptions,
  ): Promise<WorkspaceReorderOutcome>;
  updatePlanDetection(
    request: WorkspacePlanDetectionUpdateRequest,
  ): Promise<void>;
  updatePrivateMemory(
    request: WorkspacePrivateMemoryUpdateRequest,
  ): Promise<WorkspacePrivateMemoryUpdateOutcome>;
  /** A settings add of a trusted folder; the wire names it by a selection. */
  addRepository(request: {
    workspaceId: string;
    source: 'workspace_settings';
    repository: WorkspaceRepositoryCandidate;
  }): Promise<AddedRepository>;
  removeRepository(
    request: WorkspaceRepositoryRemoveRequest,
  ): Promise<WorkspaceRepositoryRemoveOutcome>;
}

/** The desktop commands, each projected through its registered operation. */
export function projectedWorkspaceMetadataCommands(
  target: WorkspaceMetadataProjectionTarget,
): ProjectedWorkspaceMetadataCommands {
  const caller = withWriteGrant(target.caller);
  const { dispatcher } = target;
  /** #3 for one workspace's patch, running `run` as its host request. */
  function projectUpdate<T>(
    request: W5BoundaryOptions & {
      workspaceId: string;
      patch: WorkspaceMetadataPatch;
    },
    run: () => Promise<T>,
  ): Promise<T> {
    const idempotencyKey = randomUUID();
    const params = CoreWorkspaceUpdateParamsSchema.safeParse({
      workspaceId: request.workspaceId,
      ...revision(request),
      patch: wirePatch(request.patch),
      _meta: { idempotencyKey },
    });
    if (!params.success) return run();
    const projection: WorkspaceMetadataProjection<T> = { run };
    return project({ 'core.workspace.update': projection }, projection, () =>
      dispatcher.instruction('core.workspace.update', params.data, {
        caller,
        metadata: { idempotencyKey },
      }),
    );
  }
  return {
    updateMetadata(request) {
      const run = (): Promise<WorkspaceMetadataUpdateOutcome> =>
        updateWorkspaceMetadata(request);
      return request.idempotencyKey === undefined
        ? projectUpdate(request, run)
        : run();
    },
    updateCoworkMetadata: projectUpdate,
    reorder(request) {
      const run = (): Promise<WorkspaceReorderOutcome> =>
        reorderWorkspaces(request);
      const params = CoreWorkspaceReorderParamsSchema.safeParse({
        visibleWorkspaceIds: request.visibleWorkspaceIds,
        activeWorkspaceId: request.activeWorkspaceId,
        overWorkspaceId: request.overWorkspaceId,
        ...revision(request),
      });
      if (request.idempotencyKey !== undefined || !params.success) return run();
      const projection: WorkspaceMetadataProjection<WorkspaceReorderOutcome> = {
        run,
      };
      return project({ 'core.workspace.reorder': projection }, projection, () =>
        dispatcher.instruction('core.workspace.reorder', params.data, {
          caller,
          metadata: { idempotencyKey: randomUUID() },
        }),
      );
    },
    updatePlanDetection(request) {
      const run = (): Promise<void> => updateWorkspacePlanDetection(request);
      const params = CoreWorkspacePlanDetectionUpdateParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        ...revision(request),
        planDetection: request.planDetection,
      });
      if (request.idempotencyKey !== undefined || !params.success) return run();
      const projection: WorkspaceMetadataProjection<void> = { run };
      return project(
        { 'core.workspace.planDetection.update': projection },
        projection,
        () =>
          dispatcher.instruction(
            'core.workspace.planDetection.update',
            params.data,
            { caller, metadata: { idempotencyKey: randomUUID() } },
          ),
      );
    },
    updatePrivateMemory(request) {
      const run = (): Promise<WorkspacePrivateMemoryUpdateOutcome> =>
        updateWorkspacePrivateMemory(request);
      const params = CoreWorkspacePrivateMemoryUpdateParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        ...revision(request),
        privateMemory: request.privateMemory,
      });
      if (request.idempotencyKey !== undefined || !params.success) return run();
      const projection: WorkspaceMetadataProjection<WorkspacePrivateMemoryUpdateOutcome> =
        { run };
      return project(
        { 'core.workspace.privateMemory.update': projection },
        projection,
        () =>
          dispatcher.instruction(
            'core.workspace.privateMemory.update',
            params.data,
            { caller, metadata: { idempotencyKey: randomUUID() } },
          ),
      );
    },
    addRepository(request) {
      const run = (): Promise<AddedRepository> =>
        addWorkspaceRepository(request);
      const { id, name } = request.repository;
      // The projection's own selection of its trusted folder (D8): only this
      // call's context redeems it.
      const params = CoreWorkspaceRepositoryAddParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        repository: {
          selection: {
            kind: 'local_picker_selection',
            selectionId: randomUUID(),
          },
          ...(id !== undefined && { id }),
          ...(name !== undefined && { name }),
        },
      });
      if (!params.success) return run();
      const projection: WorkspaceMetadataProjection<AddedRepository> = { run };
      return project(
        { 'core.workspace.repository.add': projection },
        projection,
        () =>
          dispatcher.instruction('core.workspace.repository.add', params.data, {
            caller,
            metadata: { idempotencyKey: randomUUID() },
          }),
      );
    },
    removeRepository(request) {
      const run = (): Promise<WorkspaceRepositoryRemoveOutcome> =>
        removeWorkspaceRepository(request);
      const params = CoreWorkspaceRepositoryRemoveParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        repoId: request.repoId,
        ...revision(request),
      });
      if (request.idempotencyKey !== undefined || !params.success) return run();
      const projection: WorkspaceMetadataProjection<WorkspaceRepositoryRemoveOutcome> =
        { run };
      return project(
        { 'core.workspace.repository.remove': projection },
        projection,
        () =>
          dispatcher.instruction(
            'core.workspace.repository.remove',
            params.data,
            { caller, metadata: { idempotencyKey: randomUUID() } },
          ),
      );
    },
  };
}
