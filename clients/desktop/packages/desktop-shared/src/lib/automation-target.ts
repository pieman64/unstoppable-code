import {
  projectKindToTargetContext,
  type SharedAutomationActionType,
  type SharedAutomationTargetRequirement,
  type TargetContext,
} from '@canopy/protocol/automations';
import {
  resolveAutomationTargetRequirement,
  type AutomationPipelineResolution,
  type AutomationTargetResolution,
} from '@canopy/pipeline-interop/automation-target';
import type { AutomationAction } from '../types';
import { CHAT_LABEL } from '@canopy/protocol';

export type AutomationSessionTargetKind =
  | 'cowork'
  | 'single-repo'
  | 'multi-repo'
  | 'app_advisor';

export function sessionSharedActionType(
  kind: unknown,
): SharedAutomationActionType | null {
  switch (projectKindToTargetContext(kind)) {
    case 'cowork':
      return 'standalone_prompt';
    case 'app_advisor':
      return 'app_advisor_prompt';
    case 'worktree':
      return 'worktree_prompt';
    default:
      return null;
  }
}

export function resolveLocalAutomationTargetRequirement(
  action: AutomationAction,
  projectKind: unknown,
  requirement?: SharedAutomationTargetRequirement,
  pipeline?: AutomationPipelineResolution,
): AutomationTargetResolution {
  if (action.type === 'pipeline_execution_resume') {
    return requirement === undefined
      ? { status: 'resolved', contexts: [] }
      : {
          status: 'error',
          contexts: [],
          error:
            'Execution resume automations cannot declare a project target.',
        };
  }
  const type =
    action.type === 'worktree_session_prompt'
      ? sessionSharedActionType(projectKind)
      : action.type;
  if (!type)
    return {
      status: 'error',
      contexts: [],
      error: 'Choose an accessible project or chat in the automation editor.',
    };
  return resolveAutomationTargetRequirement(type, requirement, pipeline);
}

export function automationTargetMismatchMessage(
  contexts: readonly TargetContext[],
): string {
  const labels: Record<TargetContext, string> = {
    cowork: `${CHAT_LABEL} project`,
    worktree: 'Code project',
    app_advisor: 'App Advisor',
  };
  return `Edit this automation and choose a compatible target: ${contexts.map((context) => labels[context]).join(' or ')}.`;
}

function targetBinding(
  action: AutomationAction,
): readonly (string | undefined)[] {
  switch (action.type) {
    case 'app_advisor_prompt':
      return [action.workEntryId];
    case 'standalone_prompt':
      return [action.chatProjectId, action.workEntryId];
    case 'worktree_prompt':
      return [
        action.workspaceId,
        action.existingWorktreeId,
        action.baseWorktreeId,
        action.existingBranch,
      ];
    case 'worktree_pipeline':
      return [action.workspaceId, action.baseWorktreeId, action.repoId];
    case 'worktree_session_prompt':
      return [action.workspaceId, action.worktreeId, action.chatId];
    case 'pipeline_execution_resume':
      return [action.executionId, action.projectId, action.worktreeId];
  }
}

export function automationTargetBindingChanged(
  current: AutomationAction,
  next: AutomationAction,
): boolean {
  if (current.type !== next.type) return true;
  const left = targetBinding(current);
  const right = targetBinding(next);
  return (
    left.length !== right.length ||
    left.some((value, index) => value !== right[index])
  );
}
