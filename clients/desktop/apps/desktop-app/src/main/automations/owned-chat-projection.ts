/**
 * The renderer's view of automations (CAN-4551, 7b): an automation that owns
 * its pipeline shows as the chat action the pipeline stands for, so the edit
 * form keeps one model, and names the pipeline. Main still runs, shares and
 * reports the stored action; only the automations list and its push are
 * projected.
 */
import { ownedPipelineToChatAction } from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type {
  AutomationsListResponse,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import { ownedPipelineId } from './owned-pipeline';

export function projectOwnedChatAutomation(
  activity: ScheduledActivity,
): ScheduledActivity {
  const { action } = activity;
  if (action.type !== 'worktree_pipeline') return activity;
  const pipelineId = ownedPipelineId(activity);
  if (pipelineId === undefined) return activity;
  const stored = getStoredPipelineBySource('user', pipelineId);
  if (!stored.success || !stored.data) return activity;
  const chatAction = ownedPipelineToChatAction(
    stored.data.content,
    action.inputs ?? {},
    isCoworkWorkspace,
    action.modelAliasPreferences,
  );
  return chatAction
    ? {
        ...activity,
        action: chatAction,
        ownedPipeline: { pipelineId, chatEditable: true, storedAction: action },
      }
    : {
        ...activity,
        ownedPipeline: {
          pipelineId,
          chatEditable: false,
          storedAction: action,
        },
      };
}

export function projectOwnedChatAutomations(
  snapshot: AutomationsListResponse,
): AutomationsListResponse {
  return {
    ...snapshot,
    activities: snapshot.activities.map(projectOwnedChatAutomation),
  };
}
