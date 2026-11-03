import { randomUUID } from 'node:crypto';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  CORE_SCRIPT_GRANTS,
  CoreScriptTargetSchema,
  type CanopyCallerDescriptor,
  type CoreScriptTarget,
} from '@canopy/protocol/canopy-core';
import type { ScriptInputMap, ScriptOverrides } from '@canopy/protocol/scripts';
import { planLocalScriptChanges } from '@canopy/core-runtime/node/script/definitions';
import { mergeScriptCommands } from '@canopy/core-runtime/node/w5/workspace-metadata/settings';
import type {
  MergeWorkspaceScriptsRequest,
  SaveProjectScriptsRequest,
  SaveWorkspaceRepoScriptsRequest,
  SaveWorkspaceScriptsRequest,
} from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { preserveRuntimeCauseError } from '../canopy-runtime/runtime-cause-error';
import { validateId } from './validation';
import { ScriptHookSettingsRefusedError } from './workspace-script-hook-settings';

/*
 * Compatibility projections of the script settings saves over
 * `core.script.definition.*` (CAN-5369): `project:save-scripts`,
 * `workspace:save-scripts`, `workspace:save-repo-scripts`,
 * `workspace:merge-scripts` and `portal.workspace.scripts.save`. Each reads
 * the target's own settings with `list` and applies only the scripts that
 * differ, one `upsert` or `delete` each, so the W5 settings command stays the
 * single writer. Requests are validated as before, and a runtime failure
 * rethrows its original cause, so callers see the same messages.
 */

type ScriptSaveDispatcher = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction'
>;

function saving(caller: CanopyCallerDescriptor): {
  caller: CanopyCallerDescriptor;
} {
  return {
    caller: {
      ...caller,
      grants: [CORE_SCRIPT_GRANTS.read, CORE_SCRIPT_GRANTS.write],
    },
  };
}

const MAX_PLAN_ATTEMPTS = 3;

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    error.payload.code === 'core.script.revisionConflict'
  );
}

/**
 * Applies the plan from one read. Each change expects the revision the one
 * before it leaves, so any other write in between is a conflict, never
 * overwritten by a value planned from older settings.
 */
async function applyPlan(
  dispatcher: ScriptSaveDispatcher,
  options: { caller: CanopyCallerDescriptor },
  target: CoreScriptTarget,
  desired: (current: ScriptOverrides) => ScriptInputMap | undefined,
): Promise<void> {
  const { settings = {}, revision } = await preserveRuntimeCauseError(
    dispatcher.query(
      'core.script.definition.list',
      { target, layer: 'local' },
      options,
    ),
  );
  const changes = planLocalScriptChanges(settings, desired(settings));
  for (const [index, change] of changes.entries()) {
    const expected =
      revision === undefined ? {} : { expectedRevision: revision + index };
    const metadata = { idempotencyKey: randomUUID() };
    await (change.kind === 'set'
      ? dispatcher.instruction(
          'core.script.definition.upsert',
          { target, name: change.name, value: change.value, ...expected },
          { ...options, metadata },
        )
      : dispatcher.instruction(
          'core.script.definition.delete',
          { target, name: change.name, ...expected },
          { ...options, metadata },
        ));
  }
}

/** Plans again from fresh settings when another write lands first. */
async function saveTargetScripts(
  dispatcher: ScriptSaveDispatcher,
  caller: CanopyCallerDescriptor,
  target: CoreScriptTarget,
  desired: (current: ScriptOverrides) => ScriptInputMap | undefined,
): Promise<void> {
  const options = saving(caller);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await applyPlan(dispatcher, options, target, desired);
      return;
    } catch (error) {
      if (attempt < MAX_PLAN_ATTEMPTS && isRevisionConflict(error)) continue;
      // Legacy callers see the host error itself.
      throw error instanceof CanopyOperationError &&
        error.runtimeCause instanceof Error
        ? error.runtimeCause
        : error;
    }
  }
}

/**
 * `project:save-scripts`: the project's own scripts become `scripts`. They
 * are its workspace's top-level settings, which the `workspace-root` target
 * reads and changes for any workspace type, as the W5 command always did.
 */
export async function saveProjectScripts(
  dispatcher: ScriptSaveDispatcher,
  caller: CanopyCallerDescriptor,
  request: SaveProjectScriptsRequest,
): Promise<void> {
  validateId(request.projectId, 'projectId');
  await saveTargetScripts(
    dispatcher,
    caller,
    { kind: 'workspace-root', workspaceId: request.projectId },
    () => request.scripts,
  );
}

/** `workspace:save-scripts`: the workspace's own scripts become `scripts`. */
export async function saveWorkspaceScripts(
  dispatcher: ScriptSaveDispatcher,
  caller: CanopyCallerDescriptor,
  request: SaveWorkspaceScriptsRequest,
): Promise<void> {
  validateId(request.workspaceId, 'workspaceId');
  await saveTargetScripts(
    dispatcher,
    caller,
    { kind: 'workspace-root', workspaceId: request.workspaceId },
    () => request.scripts,
  );
}

function isRepositoryNotFound(error: unknown): boolean {
  return (
    error instanceof ScriptHookSettingsRefusedError &&
    error.reason === 'not-found'
  );
}

/**
 * `workspace:save-repo-scripts`: each named repository's own scripts become
 * its `scripts`. A repository the workspace does not have is skipped, as it
 * always was.
 */
export async function saveWorkspaceRepoScripts(
  dispatcher: ScriptSaveDispatcher,
  caller: CanopyCallerDescriptor,
  request: SaveWorkspaceRepoScriptsRequest,
): Promise<void> {
  validateId(request.workspaceId, 'workspaceId');
  const repos: unknown = request.repos;
  if (!Array.isArray(repos)) {
    throw new ScriptHookSettingsRefusedError(
      'invalid-request',
      'Invalid repository scripts.',
    );
  }
  for (const repo of request.repos) {
    const target = CoreScriptTargetSchema.safeParse({
      kind: 'workspace-repo',
      workspaceId: request.workspaceId,
      repoId: repo.repoId,
    });
    // No member repository has an id the target refuses.
    if (!target.success) continue;
    try {
      await saveTargetScripts(
        dispatcher,
        caller,
        target.data,
        () => repo.scripts,
      );
    } catch (error) {
      if (!isRepositoryNotFound(error)) throw error;
    }
  }
}

function isCommandMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((command) => typeof command === 'string')
  );
}

/**
 * `workspace:merge-scripts` and `portal.workspace.scripts.save`: only the
 * named scripts change. An empty command removes a script, and a
 * definition's other fields are kept.
 */
export async function mergeWorkspaceScriptCommands(
  dispatcher: ScriptSaveDispatcher,
  caller: CanopyCallerDescriptor,
  request: MergeWorkspaceScriptsRequest,
): Promise<void> {
  validateId(request.workspaceId, 'workspaceId');
  const commands: unknown = request.commands;
  if (!isCommandMap(commands)) {
    throw new ScriptHookSettingsRefusedError(
      'invalid-request',
      'Invalid script commands.',
    );
  }
  await saveTargetScripts(
    dispatcher,
    caller,
    { kind: 'workspace-root', workspaceId: request.workspaceId },
    (current) => mergeScriptCommands(current, commands),
  );
}
