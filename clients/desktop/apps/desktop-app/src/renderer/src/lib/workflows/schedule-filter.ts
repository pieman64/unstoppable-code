import type {
  AutomationAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { WORKFLOW_NO_PROJECT } from '@canopy/ui-app/workflows';

/** The project an automation runs in; `undefined` for App Advisor. */
export function automationProjectId(
  action: AutomationAction,
): string | undefined {
  switch (action.type) {
    case 'worktree_prompt':
    case 'worktree_session_prompt':
    case 'worktree_pipeline':
      return action.workspaceId;
    case 'standalone_prompt':
      return action.chatProjectId;
    case 'pipeline_execution_resume':
      return action.projectId;
    case 'app_advisor_prompt':
      return undefined;
  }
}

/** Whether an automation passes the Schedule tab's Project filter. */
export function matchesScheduleProject(
  activity: Pick<ScheduledActivity, 'action'>,
  project: string | null,
): boolean {
  if (project === null) return true;
  const projectId = automationProjectId(activity.action);
  return project === WORKFLOW_NO_PROJECT
    ? projectId === undefined
    : projectId === project;
}
