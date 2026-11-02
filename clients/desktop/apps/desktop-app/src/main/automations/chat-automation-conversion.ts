/**
 * Chat automation conversion in main (CAN-4551, step 7a): saves the
 * automation's owned pipeline through core, then rewrites the automation's
 * action to run it. Nothing calls it yet; the Start chat card (7b) and agent
 * creation (7c) will.
 */
import {
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  chatAutomationToPipeline,
  convertibleChatAutomation,
  type ChatAutomationAction,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type { PipelineData } from '@canopy/desktop-shared/types/pipeline';
import {
  APP_ADVISOR_PROJECT_ID,
  type AutomationAction,
  type AutomationMutationResponse,
  type ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  readPipelineLocalMetadata,
  recordUserPipelineOwner,
  setUserPipelineAgentAuthor,
  setUserPipelineOwnerAutomation,
} from '../pipelines/pipeline-local-metadata-store';
import { automationSendCaller } from './automation-send';

/** Electron main writing an automation's own pipeline. */
export const AUTOMATION_PIPELINE_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-automations',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [PIPELINE_GRANTS.write],
};

/** The project a chat action reaches, for its owner. */
function actionTarget(action: ChatAutomationAction): {
  projectId: string;
  worktreeId?: string;
} {
  switch (action.type) {
    case 'worktree_prompt':
      return { projectId: action.workspaceId };
    case 'standalone_prompt':
      return { projectId: action.chatProjectId };
    case 'app_advisor_prompt':
      return { projectId: APP_ADVISOR_PROJECT_ID };
    case 'worktree_session_prompt':
      return { projectId: action.workspaceId, worktreeId: action.worktreeId };
  }
}

/**
 * The owner the native action sent as: the automation's bound context, or
 * its target project's saved owner (Personal for the Orchestrator).
 */
async function conversionOwner(
  activity: ScheduledActivity,
  action: ChatAutomationAction,
): Promise<string> {
  const caller = await automationSendCaller(activity, actionTarget(action));
  return serializeWorkspaceContext(caller.source.owner);
}

/** What the service applies once the owned pipeline is saved. */
export interface OwnedPipelineReplacement {
  action: AutomationAction;
  /** The owner a global pipeline automation runs as. */
  executionContext: string;
  /** Deletes the saved pipeline when the rewrite fails. */
  rollback: () => Promise<void>;
}

/** An owned pipeline a save rewrites in place, as it was loaded. */
export interface OwnedPipelineInPlace {
  pipelineId: string;
  previous: PipelineData;
}

/**
 * The activity with a legacy chat project ID as the Cowork workspace the
 * native send resolves it to; the generated steps look the project up exactly.
 */
function withResolvedCoworkProject(
  activity: ScheduledActivity,
): ScheduledActivity {
  const { action } = activity;
  if (action.type !== 'standalone_prompt') return activity;
  const chatProjectId = resolveCoworkWorkspaceId(action.chatProjectId);
  return chatProjectId === action.chatProjectId
    ? activity
    : { ...activity, action: { ...action, chatProjectId } };
}

/**
 * Saves the activity's owned pipeline and returns the action that runs it:
 * a new pipeline, or `inPlace` the one it already owns, against the revision
 * that was loaded so a concurrent edit is never overwritten. Throws, changing
 * nothing, for an activity that can't convert.
 */
export async function saveOwnedChatPipeline(
  stored: ScheduledActivity,
  inPlace?: OwnedPipelineInPlace,
): Promise<OwnedPipelineReplacement> {
  const activity = withResolvedCoworkProject(stored);
  const verdict = convertibleChatAutomation(activity);
  if (!verdict.convertible)
    throw new Error(`This automation can't convert (${verdict.reason}).`);
  const { pipeline, inputs } = chatAutomationToPipeline(activity);
  const { action } = activity;
  if (
    action.type !== 'worktree_prompt' &&
    action.type !== 'standalone_prompt' &&
    action.type !== 'app_advisor_prompt' &&
    action.type !== 'worktree_session_prompt'
  )
    throw new Error("This automation can't convert (not_a_chat_action).");
  const owner = await conversionOwner(activity, action);
  // What a rollback of an in-place save puts back besides the content: the
  // owner and the agent author, whose runs keep their admission (D11).
  const previousMetadata = inPlace
    ? readPipelineLocalMetadata({
        type: 'stored',
        source: 'user',
        value: inPlace.pipelineId,
      })
    : undefined;
  const { saveUserPipeline, deleteUserPipeline } =
    await import('../canopy-runtime/pipeline-definition-dispatch');
  const saved = await saveUserPipeline(
    {
      ...(inPlace
        ? {
            id: inPlace.pipelineId,
            ...(inPlace.previous.info.revision !== undefined
              ? { expectedRevision: inPlace.previous.info.revision }
              : {}),
          }
        : {}),
      name: pipeline.name,
      description: '',
      icon: '',
      content: pipeline,
    },
    AUTOMATION_PIPELINE_CALLER,
  );
  if (!saved.success || !saved.data)
    throw new Error(saved.error ?? 'The workflow could not be saved.');
  const pipelineId = saved.data.id;
  const savedRevision = saved.data.revision;
  const rollback = async (): Promise<void> => {
    if (!inPlace) {
      await deleteUserPipeline(pipelineId, null, AUTOMATION_PIPELINE_CALLER);
      return;
    }
    // Back to what was loaded, unless someone has written it since: then
    // their content and metadata stay as they wrote them.
    const { info, content, rawContent } = inPlace.previous;
    const restored = await saveUserPipeline(
      {
        id: pipelineId,
        ...(savedRevision !== undefined
          ? { expectedRevision: savedRevision }
          : {}),
        name: info.name,
        description: info.description ?? '',
        icon: info.icon ?? '',
        content,
        rawContent,
      },
      AUTOMATION_PIPELINE_CALLER,
    );
    if (!restored.success) {
      logMainProcessWarn('Kept a workflow someone changed meanwhile', {
        operation: 'restore-owned-pipeline',
      });
      return;
    }
    if (previousMetadata?.owner !== undefined)
      recordUserPipelineOwner(pipelineId, previousMetadata.owner);
    setUserPipelineAgentAuthor(
      pipelineId,
      previousMetadata?.agentAuthor ?? null,
    );
  };
  try {
    recordUserPipelineOwner(pipelineId, owner);
    // An agent's automation keeps its admission (D11); a person's save, whose
    // activity carries no agent author, clears it.
    setUserPipelineAgentAuthor(pipelineId, activity.agentAuthor ?? null);
    setUserPipelineOwnerAutomation(pipelineId, activity.id);
    // The store logs a failed write instead of throwing; without the marker
    // the automation's delete could never find its pipeline.
    const recorded = readPipelineLocalMetadata({
      type: 'stored',
      source: 'user',
      value: pipelineId,
    });
    if (
      recorded.owner !== owner ||
      recorded.ownerAutomationId !== activity.id ||
      (activity.agentAuthor !== undefined && recorded.agentAuthor === undefined)
    )
      throw new Error('The workflow’s owner could not be recorded.');
  } catch (error) {
    await rollback();
    throw error;
  }
  return {
    action: {
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineId,
      pipelineSource: 'user',
      pipelineName: pipeline.name,
      inputs,
    },
    executionContext: owner,
    rollback,
  };
}

/**
 * Converts a chat automation into a `worktree_pipeline` automation that runs
 * a pipeline it owns. The automation keeps its ID, name, trigger, gate
 * command, enabled state and agent author, so its run history, calendar
 * entries and watchers stay with it.
 */
export async function convertChatAutomation(
  activityId: string,
): Promise<AutomationMutationResponse> {
  const { getAutomationsService } = await import('./service');
  return getAutomationsService().replaceWithOwnedPipeline(
    activityId,
    saveOwnedChatPipeline,
  );
}
