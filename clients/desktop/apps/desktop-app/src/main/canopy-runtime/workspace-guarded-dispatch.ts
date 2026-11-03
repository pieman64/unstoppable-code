import { randomUUID } from 'node:crypto';
import {
  CoreWorkspaceCoworkUpdateParamsSchema,
  CoreWorkspaceHooksUpdateParamsSchema,
  CoreWorkspacePluginsUpdateParamsSchema,
  CoreWorkspaceRetentionUpdateParamsSchema,
  CoreWorktreeHooksSetPausedParamsSchema,
  CoreWorktreeReorderParamsSchema,
  CoreWorktreeUpdateParamsSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS,
  type CoreWorkspaceGuardedCommandName,
} from '@canopy/core-runtime/node/workspace/guarded-commands';
import type { HookInputMap } from '@canopy/desktop-shared/hooks';
import {
  setWorktreeHooksPaused,
  updateWorkspaceHooks,
  type WorkspaceHooksChange,
  type WorkspaceHooksUpdateRequest,
  type WorktreeHooksSetPausedOutcome,
  type WorktreeHooksSetPausedRequest,
} from '../lib/workspace-script-hook-settings';
import {
  updateWorkspaceRetention,
  type WorkspaceRetentionUpdateOutcome,
  type WorkspaceRetentionUpdateRequest,
} from '../lib/workspace-retention';
import {
  updateWorkspacePlugins,
  type WorkspacePluginsUpdateOutcome,
  type WorkspacePluginsUserChange,
  type WorkspacePluginsUserChangeRequest,
} from '../lib/workspace-plugin-defaults';
import {
  updateCoworkWorkspaceSettings,
  type CoworkSettingsUpdateOutcome,
  type CoworkSettingsUpdateRequest,
} from '../lib/cowork-workspace-crud';
import {
  moveWorktree,
  updateWorktree,
  type WorktreeMoveRequest,
  type WorktreeUpdateOutcome,
  type WorktreeUpdateRequest,
} from '../lib/worktree-update';
import {
  project,
  type WorkspaceMetadataProjection,
  type WorkspaceMetadataProjectionTarget,
} from './workspace-metadata-dispatch';

/*
 * The IPC projections of the registered guarded commands (W7b-1b, CAN-5549):
 * #7 hooks, #11 retention, #22 worktree update, #23 move and #26 paused
 * hooks; and (W7b-1c, CAN-5568) #9 plugins and #12 Cowork settings. As the
 * W7a metadata projections do, each dispatches its operation with that
 * operation's grant added for this call and a fresh dispatcher key, and
 * hands the handler the exact host request today's caller makes
 * (its source, its unkeyed `desktop-host:*` decision), which the handler
 * runs unchanged. A keyed request, or one whose params the operation's
 * schema refuses, keeps its in-process call. The params name only what the
 * wire carries, as W7a's mixed Cowork save does for #3: #22's host-only
 * fields and missing revision stay in the host request (CAN-5526, DP-1).
 */

/** The caller with `operation`'s required grants for this call only. */
function withGrants(
  caller: CanopyCallerDescriptor,
  operation: CoreWorkspaceGuardedCommandName,
): CanopyCallerDescriptor {
  return {
    ...caller,
    grants: [
      ...CORE_WORKSPACE_GUARDED_COMMAND_DEFINITIONS[operation].requiredGrants,
    ],
  };
}

function revision(request: { expectedRevision?: number }): {
  expectedRevision?: number;
} {
  return request.expectedRevision === undefined
    ? {}
    : { expectedRevision: request.expectedRevision };
}

/** A record without its undefined entries, as the wire carries it. */
function defined<T>(
  record: Readonly<Record<string, T | undefined>>,
): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [key, value] of Object.entries(record))
    if (value !== undefined) kept[key] = value;
  return kept;
}

function wireHooks(
  hooks: HookInputMap | undefined,
): Record<string, unknown> | undefined {
  return hooks === undefined ? undefined : defined(hooks);
}

function wireHooksChange(change: WorkspaceHooksChange): unknown {
  return change.kind === 'replace'
    ? defined({ kind: change.kind, hooks: wireHooks(change.hooks) })
    : {
        kind: change.kind,
        repos: change.repos.map((repo) =>
          defined({ repoId: repo.repoId, hooks: wireHooks(repo.hooks) }),
        ),
      };
}

/** An object without its undefined entries, as the wire carries it. */
function definedEntries(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function wirePluginsChange(change: WorkspacePluginsUserChange): unknown {
  return change.kind === 'setDefaults'
    ? {
        kind: change.kind,
        defaultPluginSelections: definedEntries(change.defaultPluginSelections),
      }
    : {
        kind: change.kind,
        selections: [...change.selections],
        optOutKeys: [...change.optOutKeys],
        clearOptOutKeys: [...change.clearOptOutKeys],
      };
}

/** #12's settings: the request's Cowork settings fields (A28'(a)). */
function wireCoworkSettings(
  request: CoworkSettingsUpdateRequest,
): Record<string, unknown> {
  return definedEntries({
    description: request.description,
    defaultModel: request.defaultModel,
    defaultPresetId: request.defaultPresetId,
    presets: request.presets,
    archiveRetentionDays: request.archiveRetentionDays,
    autoArchiveDays: request.autoArchiveDays,
    starterPrompts: request.starterPrompts,
    startPage: request.startPage,
  });
}

/**
 * #22's required `expectedRevision` (DP-1) in a projected call, whose host
 * request has none: the handler runs that request, which checks only its own.
 */
const PROJECTED_UNCHECKED_REVISION = 0;

export interface ProjectedWorkspaceGuardedCommands {
  updateHooks(request: WorkspaceHooksUpdateRequest): Promise<void>;
  /** A user change: `setDefaults` or `selectRecommended`. */
  updatePlugins(
    request: WorkspacePluginsUserChangeRequest,
  ): Promise<WorkspacePluginsUpdateOutcome>;
  /**
   * A Cowork save's settings: `updateCoworkWorkspaceSettings`, which retries
   * a stale-file refusal (W5d2 P2), instead of the unkeyed save.
   */
  updateCoworkSettings(
    request: CoworkSettingsUpdateRequest,
  ): Promise<CoworkSettingsUpdateOutcome>;
  updateRetention(
    request: WorkspaceRetentionUpdateRequest,
  ): Promise<WorkspaceRetentionUpdateOutcome>;
  /**
   * Projected with them: the host-only `expectedCreatedAt` and
   * `worktreeOrder` ride in the host request only; the wire never carries
   * them (CAN-5526).
   */
  updateWorktree(
    request: WorktreeUpdateRequest,
  ): Promise<WorktreeUpdateOutcome>;
  moveWorktree(request: WorktreeMoveRequest): Promise<void>;
  setWorktreeHooksPaused(
    request: WorktreeHooksSetPausedRequest,
  ): Promise<WorktreeHooksSetPausedOutcome>;
}

/** The desktop guarded commands, each projected through its operation. */
export function projectedWorkspaceGuardedCommands(
  target: WorkspaceMetadataProjectionTarget,
): ProjectedWorkspaceGuardedCommands {
  const { dispatcher, caller } = target;
  const options = (
    operation: CoreWorkspaceGuardedCommandName,
    idempotencyKey: string,
  ): {
    caller: CanopyCallerDescriptor;
    metadata: { idempotencyKey: string };
  } => ({
    caller: withGrants(caller, operation),
    metadata: { idempotencyKey },
  });
  return {
    updateHooks(request) {
      const run = (): Promise<void> => updateWorkspaceHooks(request);
      const idempotencyKey = randomUUID();
      const params = CoreWorkspaceHooksUpdateParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        ...revision(request),
        change: wireHooksChange(request.change),
        _meta: { idempotencyKey },
      });
      if (request.idempotencyKey !== undefined || !params.success) return run();
      const projection: WorkspaceMetadataProjection<void> = { run };
      return project(
        { 'core.workspace.hooks.update': projection },
        projection,
        () =>
          dispatcher.instruction(
            'core.workspace.hooks.update',
            params.data,
            options('core.workspace.hooks.update', idempotencyKey),
          ),
      );
    },
    updatePlugins(request) {
      const run = (): Promise<WorkspacePluginsUpdateOutcome> =>
        updateWorkspacePlugins(request);
      const idempotencyKey = randomUUID();
      const params = CoreWorkspacePluginsUpdateParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        ...revision(request),
        change: wirePluginsChange(request.change),
        _meta: { idempotencyKey },
      });
      if (request.idempotencyKey !== undefined || !params.success) return run();
      const projection: WorkspaceMetadataProjection<WorkspacePluginsUpdateOutcome> =
        { run };
      return project(
        { 'core.workspace.plugins.update': projection },
        projection,
        () =>
          dispatcher.instruction(
            'core.workspace.plugins.update',
            params.data,
            options('core.workspace.plugins.update', idempotencyKey),
          ),
      );
    },
    updateCoworkSettings(request) {
      const run = (): Promise<CoworkSettingsUpdateOutcome> =>
        updateCoworkWorkspaceSettings(request);
      const idempotencyKey = randomUUID();
      const params = CoreWorkspaceCoworkUpdateParamsSchema.safeParse({
        workspaceId: request.projectId,
        ...revision(request),
        settings: wireCoworkSettings(request),
        _meta: { idempotencyKey },
      });
      if (request.idempotencyKey !== undefined || !params.success) return run();
      const projection: WorkspaceMetadataProjection<CoworkSettingsUpdateOutcome> =
        { run };
      return project(
        { 'core.workspace.cowork.update': projection },
        projection,
        () =>
          dispatcher.instruction(
            'core.workspace.cowork.update',
            params.data,
            options('core.workspace.cowork.update', idempotencyKey),
          ),
      );
    },
    updateRetention(request) {
      const run = (): Promise<WorkspaceRetentionUpdateOutcome> =>
        updateWorkspaceRetention(request);
      const idempotencyKey = randomUUID();
      const params = CoreWorkspaceRetentionUpdateParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        ...revision(request),
        patch: defined({ ...request.patch }),
        _meta: { idempotencyKey },
      });
      if (request.idempotencyKey !== undefined || !params.success) return run();
      const projection: WorkspaceMetadataProjection<WorkspaceRetentionUpdateOutcome> =
        { run };
      return project(
        { 'core.workspace.retention.update': projection },
        projection,
        () =>
          dispatcher.instruction(
            'core.workspace.retention.update',
            params.data,
            options('core.workspace.retention.update', idempotencyKey),
          ),
      );
    },
    updateWorktree(request) {
      const run = (): Promise<WorktreeUpdateOutcome> => updateWorktree(request);
      const idempotencyKey = randomUUID();
      const params = CoreWorktreeUpdateParamsSchema.safeParse({
        scope: { workspaceId: request.workspaceId },
        worktreeId: request.worktreeId,
        expectedRevision:
          request.expectedRevision ?? PROJECTED_UNCHECKED_REVISION,
        patch: defined({ ...request.patch }),
        _meta: { idempotencyKey },
      });
      if (request.idempotencyKey !== undefined || !params.success) return run();
      const projection: WorkspaceMetadataProjection<WorktreeUpdateOutcome> = {
        run,
      };
      return project({ 'core.worktree.update': projection }, projection, () =>
        dispatcher.instruction(
          'core.worktree.update',
          params.data,
          options('core.worktree.update', idempotencyKey),
        ),
      );
    },
    moveWorktree(request) {
      const run = (): Promise<void> => moveWorktree(request);
      const idempotencyKey = randomUUID();
      const params = CoreWorktreeReorderParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        activeWorktreeId: request.activeWorktreeId,
        overWorktreeId: request.overWorktreeId,
        ...revision(request),
        _meta: { idempotencyKey },
      });
      if (request.idempotencyKey !== undefined || !params.success) return run();
      const projection: WorkspaceMetadataProjection<void> = { run };
      return project({ 'core.worktree.reorder': projection }, projection, () =>
        dispatcher.instruction(
          'core.worktree.reorder',
          params.data,
          options('core.worktree.reorder', idempotencyKey),
        ),
      );
    },
    setWorktreeHooksPaused(request) {
      const run = (): Promise<WorktreeHooksSetPausedOutcome> =>
        setWorktreeHooksPaused(request);
      const idempotencyKey = randomUUID();
      const params = CoreWorktreeHooksSetPausedParamsSchema.safeParse({
        workspaceId: request.workspaceId,
        worktreeId: request.worktreeId,
        ...revision(request),
        change: request.change,
        _meta: { idempotencyKey },
      });
      if (request.idempotencyKey !== undefined || !params.success) return run();
      const projection: WorkspaceMetadataProjection<WorktreeHooksSetPausedOutcome> =
        { run };
      return project(
        { 'core.worktree.hooks.setPaused': projection },
        projection,
        () =>
          dispatcher.instruction(
            'core.worktree.hooks.setPaused',
            params.data,
            options('core.worktree.hooks.setPaused', idempotencyKey),
          ),
      );
    },
  };
}
