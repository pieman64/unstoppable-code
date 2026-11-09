import type {
  AutomationAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { WORKFLOW_NO_PROJECT } from '@canopy/ui-app/workflows';
import { pipelineAutomationWorkspaceId } from '@canopy/desktop-shared/lib/automation-pipeline-target';
import { workflowScheduleDestination } from '@canopy/desktop-shared/lib/workflow-schedule-destination';

/**
 * The project an automation runs in; `undefined` for App Advisor and for a
 * pipeline automation with no project, which fall in the No project bucket.
 */
export function automationProjectId(
  action: AutomationAction,
): string | undefined {
  switch (action.type) {
    case 'worktree_prompt':
    case 'worktree_session_prompt':
      return action.workspaceId;
    case 'worktree_pipeline':
      return pipelineAutomationWorkspaceId(action);
    case 'standalone_prompt':
      return action.chatProjectId;
    case 'pipeline_execution_resume':
      return action.projectId;
    case 'app_advisor_prompt':
      return undefined;
  }
}

/**
 * The project a record runs in. A workflow schedule (CAN-5782) stores a
 * global pipeline, so its project comes from where its run values point.
 */
export function activityProjectId(
  activity: Pick<
    ScheduledActivity,
    'action' | 'ownedPipeline' | 'workflowSchedule'
  >,
): string | undefined {
  const destination = workflowScheduleDestination(activity);
  if (destination?.kind === 'chat_action')
    return automationProjectId(destination.action);
  if (destination?.kind === 'inputs') return destination.projectId;
  return automationProjectId(activity.action);
}

/** Whether an automation passes the Schedule tab's Project filter. */
export function matchesScheduleProject(
  activity: Pick<
    ScheduledActivity,
    'action' | 'ownedPipeline' | 'workflowSchedule'
  >,
  project: string | null,
): boolean {
  if (project === null) return true;
  const projectId = activityProjectId(activity);
  return project === WORKFLOW_NO_PROJECT
    ? projectId === undefined
    : projectId === project;
}
