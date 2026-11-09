import type { AutomationAction, ScheduledActivity } from '../types';
import {
  pipelineAutomationTaskId,
  pipelineAutomationWorkspaceId,
} from './automation-pipeline-target';

/**
 * Where a workflow schedule runs (CAN-5782): the chat action its owned
 * pipeline stands for, or the destination its action or run values name.
 */
export type WorkflowScheduleDestination =
  | { kind: 'chat_action'; action: AutomationAction }
  | {
      kind: 'inputs';
      /** The action's project, else `project_id`. */
      projectId?: string;
      /** A worktree in a code project, a Work Entry in a Cowork one. */
      taskId?: string;
      chatId?: string;
      /** The run values name the Orchestrator (`bot_id`), not a project. */
      orchestrator?: true;
    };

/**
 * The one answer to "where does this schedule run?" (CAN-5782). A workflow
 * schedule usually stores a global `worktree_pipeline`, so reading its
 * action alone finds nothing. An owner's projected chat action names it,
 * kept when other schedules share the pipeline; otherwise the action's own
 * project and task do, when its target names them, and else the record's
 * `project_id`, `task_id` and `chat_id` inputs. `undefined` for a record
 * that isn't a workflow schedule.
 */
export function workflowScheduleDestination(
  activity: Pick<
    ScheduledActivity,
    'action' | 'ownedPipeline' | 'workflowSchedule'
  >,
): WorkflowScheduleDestination | undefined {
  if (activity.workflowSchedule === undefined) return undefined;
  const chatAction = activity.ownedPipeline?.chatAction;
  if (chatAction !== undefined)
    return { kind: 'chat_action', action: chatAction };
  const stored = activity.ownedPipeline?.storedAction ?? activity.action;
  if (stored.type !== 'worktree_pipeline') return undefined;
  const inputs = stored.inputs ?? {};
  const projectId = pipelineAutomationWorkspaceId(stored) ?? inputs.project_id;
  const taskId = pipelineAutomationTaskId(stored) ?? inputs.task_id;
  return {
    kind: 'inputs',
    ...(projectId ? { projectId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(inputs.chat_id ? { chatId: inputs.chat_id } : {}),
    ...(inputs.bot_id ? { orchestrator: true } : {}),
  };
}
