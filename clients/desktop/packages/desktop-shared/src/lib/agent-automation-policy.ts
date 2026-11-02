import type {
  AutomationAction,
  AutomationCreateRequest,
  AutomationUpdateRequest,
} from '../types';
import { resolveAutomationPipelineTarget } from './automation-pipeline-target';

export const WORKTREE_SESSION_PROMPT_CREATE_POLICY_ERROR =
  'Worktree session prompts cannot be created through agent automation actions. Use projects.schedule_message, the chat composer, or the usage-limit banner.';

export const AGENT_SCHEDULED_SEND_EDIT_POLICY_ERROR =
  'Agent-scheduled messages keep their sender. Edit them on the Automations page, or cancel and schedule a new one.';

export const WORKTREE_SESSION_PROMPT_CONVERSION_POLICY_ERROR =
  'Converting an activity into a worktree session prompt is not allowed. Schedule these from the chat composer or usage-limit banner.';

export const WORKTREE_SESSION_PROMPT_ACTION_CHANGE_POLICY_ERROR =
  'Changing a worktree session prompt to another action type is not allowed.';

export const WORKTREE_SESSION_PROMPT_RETARGET_POLICY_ERROR =
  'Retargeting or changing the purpose of a worktree session prompt is not allowed.';

export const AGENT_AUTOMATION_SESSION_AUTHORITY_POLICY_ERROR =
  "Agent automation actions cannot change an existing chat's model, plan mode, approval mode, or plugins.";

export const AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR =
  'If Command gates cannot be configured or executed through agent automation actions.';

export const PIPELINE_EXECUTION_RESUME_POLICY_ERROR =
  'Pipeline resume activities can only be created, retargeted, or run through the trusted usage-limit recovery flow.';

export const AGENT_AUTOMATION_OWNER_POLICY_ERROR =
  "Agent automation actions can't choose an automation's owner. It takes the owner of where it runs.";

export const AGENT_AUTOMATION_SHARED_PIPELINE_PIN_POLICY_ERROR =
  'Shared pipeline approval must be completed explicitly in the Automations UI.';

function sharedPipelineInstallPinChanged(
  currentAction: AutomationAction,
  patchAction: AutomationAction,
): boolean {
  if (
    currentAction.type !== 'worktree_pipeline' ||
    currentAction.pipelineSource !== 'shared'
  ) {
    return false;
  }
  const currentShared = currentAction.sharedPipeline;
  const currentPin = currentShared?.installPin;
  if (
    patchAction.type !== 'worktree_pipeline' ||
    patchAction.pipelineSource !== 'shared'
  ) {
    return Boolean(currentPin);
  }
  const patchShared = patchAction.sharedPipeline;
  const patchPin = patchShared?.installPin;
  if (!currentShared || !currentPin || !patchShared || !patchPin) {
    return currentPin !== patchPin;
  }
  return (
    currentShared.serverId !== patchShared.serverId ||
    currentShared.remoteId !== patchShared.remoteId ||
    currentPin.pipelineContentHash !== patchPin.pipelineContentHash ||
    currentPin.distributionMode !== patchPin.distributionMode ||
    currentPin.packageDigest !== patchPin.packageDigest
  );
}

/**
 * Pure policy for agent-authored automation creation. Runtime feature flags,
 * persistence, and target validation intentionally remain at their owning
 * process boundary.
 */
export function validateAgentAutomationCreatePolicy(
  request: Pick<
    AutomationCreateRequest,
    'action' | 'ifCommand' | 'executionContext'
  >,
): string | null {
  // Only a trusted host caller names an owner; an agent's automation is bound
  // the way any other is.
  if (request.executionContext !== undefined) {
    return AGENT_AUTOMATION_OWNER_POLICY_ERROR;
  }
  if (request.ifCommand?.trim()) {
    return AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR;
  }
  if (request.action.type === 'pipeline_execution_resume') {
    return PIPELINE_EXECUTION_RESUME_POLICY_ERROR;
  }
  return request.action.type === 'worktree_session_prompt'
    ? WORKTREE_SESSION_PROMPT_CREATE_POLICY_ERROR
    : null;
}

/**
 * Pure policy for agent-authored automation updates. Lifecycle/content edits
 * remain permitted, including disabling a protected session activity. Only an
 * action replacement can convert or retarget the protected action kind.
 */
export function validateAgentAutomationUpdatePolicy(
  currentAction: AutomationAction,
  patch: Omit<AutomationUpdateRequest, 'id'>,
  currentIfCommand?: string,
  currentAgentScheduled?: boolean,
): string | null {
  if (currentAgentScheduled && patch.action !== undefined) {
    return AGENT_SCHEDULED_SEND_EDIT_POLICY_ERROR;
  }
  if (patch.ifCommand?.trim()) {
    return AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR;
  }
  const isDisableOnly =
    patch.enabled === false &&
    patch.name === undefined &&
    patch.schedule === undefined &&
    patch.action === undefined &&
    patch.ifCommand === undefined;
  const patchAction = patch.action;

  if (
    currentAction.type === 'pipeline_execution_resume' ||
    patchAction?.type === 'pipeline_execution_resume'
  ) {
    return isDisableOnly ? null : PIPELINE_EXECUTION_RESUME_POLICY_ERROR;
  }

  if (
    currentIfCommand?.trim() &&
    patch.ifCommand === undefined &&
    !isDisableOnly
  ) {
    return AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR;
  }

  if (!patchAction) {
    return null;
  }

  if (sharedPipelineInstallPinChanged(currentAction, patchAction)) {
    return AGENT_AUTOMATION_SHARED_PIPELINE_PIN_POLICY_ERROR;
  }

  const currentIsSession = currentAction.type === 'worktree_session_prompt';
  const patchIsSession = patchAction.type === 'worktree_session_prompt';

  if (patchIsSession && !currentIsSession) {
    return WORKTREE_SESSION_PROMPT_CONVERSION_POLICY_ERROR;
  }

  if (!currentIsSession) return null;
  if (!patchIsSession) {
    return WORKTREE_SESSION_PROMPT_ACTION_CHANGE_POLICY_ERROR;
  }
  if (
    patchAction.workspaceId !== currentAction.workspaceId ||
    patchAction.worktreeId !== currentAction.worktreeId ||
    patchAction.chatId !== currentAction.chatId ||
    patchAction.purpose !== currentAction.purpose
  ) {
    return WORKTREE_SESSION_PROMPT_RETARGET_POLICY_ERROR;
  }

  // Session automations run inside a pre-existing chat. An agent may edit the
  // text or schedule, but cannot grant itself more authority through the
  // automation record that a trusted composer created.
  const authorityFields = [
    'model',
    'modelConfig',
    'planMode',
    'approvalMode',
    'pluginSelections',
    'plugins',
  ] as const;
  if (
    authorityFields.some(
      (field) =>
        JSON.stringify(patchAction[field]) !==
        JSON.stringify(currentAction[field]),
    )
  ) {
    return AGENT_AUTOMATION_SESSION_AUTHORITY_POLICY_ERROR;
  }

  // Prompt references can implicitly enable plugin tools at execution time.
  // Keep the plugin identities fixed while still allowing ordinary text and
  // file-reference edits to a trusted session automation.
  const pluginIdentities = (
    action: Extract<AutomationAction, { type: 'worktree_session_prompt' }>,
  ): string[] =>
    (action.promptReferences ?? [])
      .filter((ref) => ref.kind === 'plugin')
      .map((ref) => JSON.stringify(ref.plugin))
      .sort();
  if (
    JSON.stringify(pluginIdentities(patchAction)) !==
    JSON.stringify(pluginIdentities(currentAction))
  ) {
    return AGENT_AUTOMATION_SESSION_AUTHORITY_POLICY_ERROR;
  }

  return null;
}

export function validateAgentAutomationRunPolicy(
  action: AutomationAction,
): string | null {
  return action.type === 'pipeline_execution_resume'
    ? PIPELINE_EXECUTION_RESUME_POLICY_ERROR
    : null;
}

/**
 * The project an automation action targets, for the code and cowork agent
 * owner rule. App Advisor prompts have no owner and follow the App Advisor
 * access setting instead. A pipeline with no project (`global`) is owned by
 * its saved `executionContext`, not by a project. An action without a usable
 * project ID is unknown, and callers treat it as not disclosed.
 */
export type AgentAutomationTargetProject =
  | { kind: 'project'; projectId: string; worktreeId?: string }
  | { kind: 'app_advisor' }
  | { kind: 'global' }
  | { kind: 'unknown' };

function projectTarget(
  projectId: string | undefined,
  worktreeId?: string,
): AgentAutomationTargetProject {
  const project = projectId?.trim();
  if (!project) return { kind: 'unknown' };
  const worktree = worktreeId?.trim();
  return worktree
    ? { kind: 'project', projectId: project, worktreeId: worktree }
    : { kind: 'project', projectId: project };
}

export function agentAutomationTargetProject(
  action: AutomationAction,
): AgentAutomationTargetProject {
  switch (action.type) {
    case 'app_advisor_prompt':
      return { kind: 'app_advisor' };
    case 'standalone_prompt':
      return projectTarget(action.chatProjectId);
    case 'worktree_prompt':
      return projectTarget(action.workspaceId);
    case 'worktree_pipeline': {
      const target = resolveAutomationPipelineTarget(action);
      if (!target) return { kind: 'unknown' };
      if (target.kind === 'global') return { kind: 'global' };
      return target.kind === 'task'
        ? projectTarget(target.workspaceId, target.taskId)
        : projectTarget(target.workspaceId);
    }
    case 'worktree_session_prompt':
      return projectTarget(action.workspaceId, action.worktreeId);
    case 'pipeline_execution_resume':
      return projectTarget(action.projectId, action.worktreeId);
    default: {
      const unhandled: never = action;
      void unhandled;
      return { kind: 'unknown' };
    }
  }
}
