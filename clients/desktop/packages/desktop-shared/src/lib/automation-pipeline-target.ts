/**
 * Destination of a `worktree_pipeline` automation. The stored `target` is
 * optional: absent keeps the legacy behavior (a fresh worktree on a code
 * project, the project folder on a cowork project). For a `global` target a
 * stored `workspaceId` is inert compatibility data and is never read here.
 */
import { isAutomationPipelineTargetKind } from '@canopy/protocol/automations';
import { CHAT_LABEL, WORKTREE_UNIT_LABEL } from '@canopy/protocol/ui-labels';
import type { AutomationAction } from '../types';

export {
  PIPELINE_TARGET_NO_PROJECT_SCOPE_ERROR,
  PIPELINE_TARGET_REQUIREMENT_GLOBAL_ERROR,
} from '@canopy/pipeline-interop/automation-target';

export type PipelineAutomationAction = Extract<
  AutomationAction,
  { type: 'worktree_pipeline' }
>;

/** `explicit` is false for a legacy action that carries no `target`. */
export type ResolvedAutomationPipelineTarget =
  | { kind: 'global' }
  | { kind: 'new_worktree'; workspaceId: string; explicit: boolean }
  | { kind: 'task'; workspaceId: string; taskId: string }
  | { kind: 'project'; workspaceId: string };

export const PIPELINE_TARGET_KIND_ERROR =
  'Pipeline automation target.kind must be global, new_worktree, task, or project.';
export const PIPELINE_TARGET_TASK_ID_ERROR =
  'Pipeline automation target task requires a taskId.';
export const PIPELINE_TARGET_WORKSPACE_REQUIRED_ERROR =
  'Worktree pipeline action requires a workspaceId.';
export const PIPELINE_TARGET_GLOBAL_PROJECT_FIELDS_ERROR =
  "A workflow automation with no project can't name a worktree, repository, or project file.";
export const PIPELINE_TARGET_GLOBAL_PROJECT_PIPELINE_ERROR =
  'Project workflows need a project. Choose another workflow or a project destination.';
export const PIPELINE_TARGET_BASE_WORKTREE_ERROR =
  'baseWorktreeId only applies when each run creates a new worktree.';
export const PIPELINE_TARGET_NEW_WORKTREE_COWORK_ERROR = `${CHAT_LABEL} projects can't create a new ${WORKTREE_UNIT_LABEL.toLowerCase()} each run. Choose the project folder or an existing task.`;
export const PIPELINE_TARGET_TASK_MISSING_ERROR =
  'This task is no longer available. Choose another task.';
export const PIPELINE_TARGET_OWNER_MISMATCH_ERROR =
  "This workflow belongs to a different owner than this automation. Choose a workflow from the automation's owner.";
export const PIPELINE_TARGET_PROJECT_ROOT_REQUIRED_ERROR =
  'This project has no folder to run the workflow in. Choose a repository or another destination.';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validation error for the destination fields of a pipeline action, or null.
 * An absent (or in-memory `undefined`) target falls through to the legacy
 * `workspaceId` requirement.
 */
export function automationPipelineTargetError(
  action: Record<string, unknown>,
): string | null {
  const target = action.target;
  if (target === undefined) {
    return isNonEmptyString(action.workspaceId)
      ? null
      : PIPELINE_TARGET_WORKSPACE_REQUIRED_ERROR;
  }
  if (
    !isPlainObject(target) ||
    !isAutomationPipelineTargetKind(target.kind) ||
    Object.keys(target).some(
      (key) => key !== 'kind' && !(target.kind === 'task' && key === 'taskId'),
    )
  ) {
    return PIPELINE_TARGET_KIND_ERROR;
  }
  if (target.kind === 'global') {
    if (
      action.workspaceId !== undefined &&
      typeof action.workspaceId !== 'string'
    ) {
      return PIPELINE_TARGET_WORKSPACE_REQUIRED_ERROR;
    }
    if (
      action.baseWorktreeId !== undefined ||
      action.repoId !== undefined ||
      action.projectPipelineFilename !== undefined
    ) {
      return PIPELINE_TARGET_GLOBAL_PROJECT_FIELDS_ERROR;
    }
    if (action.pipelineSource === 'project') {
      return PIPELINE_TARGET_GLOBAL_PROJECT_PIPELINE_ERROR;
    }
    return null;
  }
  if (target.kind === 'task' && !isNonEmptyString(target.taskId)) {
    return PIPELINE_TARGET_TASK_ID_ERROR;
  }
  if (!isNonEmptyString(action.workspaceId)) {
    return PIPELINE_TARGET_WORKSPACE_REQUIRED_ERROR;
  }
  if (target.kind !== 'new_worktree' && action.baseWorktreeId !== undefined) {
    return PIPELINE_TARGET_BASE_WORKTREE_ERROR;
  }
  return null;
}

/**
 * Normalized destination. `null` only for stored data the validator rejects;
 * callers refuse it instead of picking a fallback project. A legacy action
 * resolves to `new_worktree` with `explicit: false`: whether that means a
 * worktree or the cowork project folder depends on the project kind, which
 * only the host knows.
 */
export function resolveAutomationPipelineTarget(
  action: PipelineAutomationAction,
): ResolvedAutomationPipelineTarget | null {
  const target = action.target;
  if (target?.kind === 'global') return { kind: 'global' };
  const workspaceId = action.workspaceId;
  if (!isNonEmptyString(workspaceId)) return null;
  switch (target?.kind) {
    case undefined:
      return { kind: 'new_worktree', workspaceId, explicit: false };
    case 'new_worktree':
      return { kind: 'new_worktree', workspaceId, explicit: true };
    case 'task':
      return isNonEmptyString(target.taskId)
        ? { kind: 'task', workspaceId, taskId: target.taskId }
        : null;
    case 'project':
      return { kind: 'project', workspaceId };
    default:
      return null;
  }
}

/** Project the automation runs in; undefined for global, even when the inert field is present. */
export function pipelineAutomationWorkspaceId(
  action: PipelineAutomationAction,
): string | undefined {
  const resolved = resolveAutomationPipelineTarget(action);
  return resolved && resolved.kind !== 'global'
    ? resolved.workspaceId
    : undefined;
}

/** Existing task (worktree or Work Entry) the automation runs in, if any. */
export function pipelineAutomationTaskId(
  action: PipelineAutomationAction,
): string | undefined {
  const resolved = resolveAutomationPipelineTarget(action);
  return resolved?.kind === 'task' ? resolved.taskId : undefined;
}

/** Audit and receipt text for where a pipeline automation runs; never "project undefined". */
export function pipelineAutomationTargetSummary(
  action: PipelineAutomationAction,
): string {
  const target = resolveAutomationPipelineTarget(action);
  if (!target) return `pipeline ${action.pipelineId}`;
  switch (target.kind) {
    case 'global':
      return `pipeline ${action.pipelineId} with no project`;
    case 'task':
      return `pipeline ${action.pipelineId} in task ${target.taskId} of project ${target.workspaceId}`;
    case 'project':
      return `pipeline ${action.pipelineId} in project ${target.workspaceId} folder`;
    case 'new_worktree':
      return `pipeline ${action.pipelineId} in project ${target.workspaceId}`;
  }
}

/** Whether the action runs with no project. */
export function isGlobalPipelineAutomationAction(
  action: AutomationAction,
): action is PipelineAutomationAction & { target: { kind: 'global' } } {
  return (
    action.type === 'worktree_pipeline' && action.target?.kind === 'global'
  );
}

/**
 * Stable identity for change detection. A legacy action and an explicit
 * `new_worktree` differ, so retargeting is a binding change; the inert
 * global `workspaceId` is ignored.
 */
export function automationPipelineDestinationKey(
  action: PipelineAutomationAction,
): string {
  const resolved = resolveAutomationPipelineTarget(action);
  if (!resolved) return 'unavailable';
  switch (resolved.kind) {
    case 'global':
      return 'global';
    case 'new_worktree':
      return `${resolved.explicit ? 'new_worktree' : 'legacy'}:${resolved.workspaceId}`;
    case 'task':
      return `task:${resolved.workspaceId}:${resolved.taskId}`;
    case 'project':
      return `project:${resolved.workspaceId}`;
  }
}
