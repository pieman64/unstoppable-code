/**
 * A person's automation save from the edit form (CAN-4551, 7b), by the chat
 * automation pipelines experiment's state:
 *
 * - on: a convertible chat automation is stored as a pipeline it owns, or
 *   its owned pipeline is regenerated in place;
 * - off: a converted automation is stored as the native chat action from the
 *   form, and its owned pipeline is deleted.
 *
 * D4 sends, the Home scheduled task and other actions that stay native keep
 * today's save. A failed conversion leaves the native save in place, which
 * runs as it always did. Agent writes never come through here.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  convertibleChatAutomation,
  ownedPipelineToChatAction,
} from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type { PipelineData } from '@canopy/desktop-shared/types/pipeline';
import type {
  AutomationAction,
  AutomationCreateRequest,
  AutomationMutationResponse,
  AutomationUpdateRequest,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { PipelineAgentAuthor } from '@canopy/desktop-shared/types/pipeline';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { getStoredPipelineBySource } from '../pipelines/pipeline-service';
import { saveOwnedChatPipeline } from './chat-automation-conversion';
import { chatAutomationPipelinesEnabled } from './chat-automation-experiment';
import { deleteOwnedPipeline, ownedPipelineId } from './owned-pipeline';
import { projectOwnedChatAutomation } from './owned-chat-projection';
import {
  getAutomationsService,
  type AutomationsService,
  type AutomationTrustedCreate,
} from './service';

/** A person writing the automation clears any agent marker. */
const PERSON = { agentAuthor: null } as const;

function projected(
  response: AutomationMutationResponse,
): AutomationMutationResponse {
  return response.ok && response.activity
    ? { ...response, activity: projectOwnedChatAutomation(response.activity) }
    : response;
}

/** Converts a saved native automation; a failure keeps the native save. */
async function convertSaved(
  saved: AutomationMutationResponse,
  service: AutomationsService,
): Promise<AutomationMutationResponse> {
  if (!saved.ok) return saved;
  const { activity } = saved;
  if (!activity || !convertibleChatAutomation(activity).convertible)
    return saved;
  const converted = await service.replaceWithOwnedPipeline(
    activity.id,
    saveOwnedChatPipeline,
  );
  if (converted.ok) return converted;
  logMainProcessWarn('Kept a chat automation native; it could not convert', {
    operation: 'convert-chat-automation',
  });
  return saved;
}

export async function createAutomationFromForm(
  request: AutomationCreateRequest,
  service: AutomationsService = getAutomationsService(),
): Promise<AutomationMutationResponse> {
  const created = await service.create(request, PERSON);
  if (!(await chatAutomationPipelinesEnabled())) return projected(created);
  return projected(await convertSaved(created, service));
}

/** Who writes an update, and the guard and context it writes with. */
interface UpdateWriter {
  agentAuthor: PipelineAgentAuthor | null;
  authorize?: (activity: ScheduledActivity) => Promise<boolean>;
  callerContext?: WorkspaceContext;
}

/** An agent's write, which may also have to be allowed a native action. */
interface AgentUpdateWriter extends UpdateWriter {
  agentAuthor: PipelineAgentAuthor;
  /**
   * Whether the agent may write `action` as a native action, checked before
   * converting back: its own access, which the converted action didn't need.
   */
  authorizeNative?: (action: AutomationAction) => Promise<boolean>;
}

const PERSON_WRITER: UpdateWriter = PERSON;

function writeUpdate(
  request: AutomationUpdateRequest,
  writer: UpdateWriter,
  service: AutomationsService,
): Promise<AutomationMutationResponse> {
  return service.update(request, writer.authorize, writer.callerContext, {
    agentAuthor: writer.agentAuthor,
  });
}

/**
 * The activity as the update would store it with chat action `action`: the
 * request's name and run restriction (so adding one keeps it native) and the
 * writer's agent author, which decide whether it converts.
 */
function editedActivity(
  request: AutomationUpdateRequest,
  stored: ScheduledActivity,
  action: AutomationAction,
  writer: UpdateWriter,
): ScheduledActivity {
  const targetRequirement =
    request.targetRequirement === undefined
      ? stored.targetRequirement
      : (request.targetRequirement ?? undefined);
  return {
    ...stored,
    name: request.name ?? stored.name,
    action,
    agentAuthor: writer.agentAuthor ?? undefined,
    targetRequirement,
  };
}

/**
 * Regenerates the owned pipeline for `edited`, then stores the activity;
 * `undefined` when `edited` doesn't convert.
 */
async function regenerateOwned(
  request: AutomationUpdateRequest,
  stored: ScheduledActivity,
  edited: ScheduledActivity,
  pipelineId: string,
  previous: PipelineData,
  writer: UpdateWriter,
  service: AutomationsService,
): Promise<AutomationMutationResponse | undefined> {
  if (!convertibleChatAutomation(edited).convertible) return undefined;
  // The global pipeline's write never sees the chat's own target: check it
  // as the native save would, before anything is written.
  const targetRefusal = await service.nativeTargetRefusal(edited);
  if (targetRefusal) return { ok: false, error: targetRefusal };
  let replacement;
  try {
    // The snapshot the hand-edit check read: a write since then fails the
    // save's revision check instead of being overwritten.
    replacement = await saveOwnedChatPipeline(edited, { pipelineId, previous });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const restore = (): Promise<void> =>
    replacement.rollback().catch(() =>
      logMainProcessWarn('Failed to restore an automation’s workflow', {
        operation: 'restore-owned-pipeline',
      }),
    );
  let updated: AutomationMutationResponse;
  try {
    updated = await writeUpdate(
      { ...request, action: replacement.action },
      writer,
      service,
    );
  } catch (error) {
    // The update can throw after storing the activity (while notifying);
    // then the regenerated pipeline is the one it runs, so keep it.
    const current = await (
      writer.callerContext
        ? service.listForContext(writer.callerContext)
        : service.list()
    )
      .then(({ activities }) =>
        activities.find((entry) => entry.id === stored.id),
      )
      .catch(() => undefined);
    if (current === undefined || isDeepStrictEqual(current, stored))
      await restore();
    throw error;
  }
  if (!updated.ok) await restore();
  return updated;
}

export const OWNED_PIPELINE_CHANGED =
  'Its workflow was changed since you opened it. Reopen the automation to see it.';

/**
 * Whether the workflow an automation owns, as read now, is still what its
 * chat action stands for. A workflow changed by hand, or one that can't be
 * read, is not, so a chat save must neither rebuild nor delete it.
 */
function ownedPipelineMatchesChat(
  stored: ScheduledActivity,
  current: PipelineData | undefined,
): boolean {
  const { action } = stored;
  return (
    action.type === 'worktree_pipeline' &&
    current !== undefined &&
    ownedPipelineToChatAction(
      current.content,
      action.inputs ?? {},
      isCoworkWorkspace,
    ) !== null
  );
}

export async function updateAutomationFromForm(
  request: AutomationUpdateRequest,
  service: AutomationsService = getAutomationsService(),
): Promise<AutomationMutationResponse> {
  const stored = (await service.list()).activities.find(
    (entry) => entry.id === request.id,
  );
  const owned = stored ? ownedPipelineId(stored) : undefined;
  const loaded =
    owned === undefined ? undefined : getStoredPipelineBySource('user', owned);
  const current = loaded?.success ? loaded.data : undefined;
  // The form sends the chat action it loaded. When the workflow has been
  // changed by hand since, saving it would overwrite or delete that work:
  // refuse, and send the windows a fresh snapshot to reopen.
  if (
    stored &&
    owned !== undefined &&
    request.action !== undefined &&
    request.action.type !== 'worktree_pipeline' &&
    !ownedPipelineMatchesChat(stored, current)
  ) {
    await service.republish();
    return { ok: false, error: OWNED_PIPELINE_CHANGED };
  }
  const enabled = await chatAutomationPipelinesEnabled();
  if (
    stored &&
    owned !== undefined &&
    current !== undefined &&
    request.action !== undefined &&
    enabled
  ) {
    const regenerated = await regenerateOwned(
      request,
      stored,
      editedActivity(request, stored, request.action, PERSON_WRITER),
      owned,
      current,
      PERSON_WRITER,
      service,
    );
    if (regenerated) return projected(regenerated);
  }
  const updated = await service.update(request, undefined, undefined, PERSON);
  if (!updated.ok || !updated.activity) return updated;
  // Converted back, or pointed at another pipeline: it no longer owns this one.
  // Delete the revision checked above; a write since then keeps the pipeline.
  if (
    stored &&
    owned !== undefined &&
    ownedPipelineId(updated.activity) !== owned
  )
    await deleteOwnedPipeline(stored, current?.info.revision ?? null);
  // Only an edit of the action converts; switching it on or off doesn't.
  if (
    enabled &&
    request.action !== undefined &&
    ownedPipelineId(updated.activity) === undefined
  )
    return projected(await convertSaved(updated, service));
  return projected(updated);
}

/**
 * An agent's create (CAN-4551, 7c): stored as the native action, then, while
 * the experiment is on, converted with the agent's marker on the automation
 * and its pipeline, so runs stay agent-originated (D11). An action whose
 * runs D11 would refuse doesn't convert, and keeps working natively.
 */
export async function createAutomationForAgent(
  request: AutomationCreateRequest,
  trusted: AutomationTrustedCreate,
  service: AutomationsService = getAutomationsService(),
): Promise<AutomationMutationResponse> {
  const created = await service.create(request, trusted);
  if (!created.ok || !created.activity) return created;
  if (!convertibleChatAutomation(created.activity).convertible) return created;
  if (!(await chatAutomationPipelinesEnabled())) return created;
  return convertSaved(created, service);
}

export const AUTOMATION_CHANGED_MEANWHILE =
  'This automation changed while it was being updated. Read it again with automation.get, then retry.';

export const OWNED_PIPELINE_HAND_EDITED =
  'This automation runs a workflow that was changed by hand. Edit that workflow with pipeline.update, or send the automation’s worktree_pipeline action.';

/**
 * An agent's update (CAN-4551, 7c). A native automation updates as before.
 * One that owns its pipeline is re-checked as agent-authored, whatever the
 * experiment's state: while it still converts, its pipeline is regenerated
 * with the agent's marker; once D11 would refuse its runs, it converts back
 * to the native action and the pipeline is deleted. Its chat action is the
 * one sent, else the one its pipeline stands for.
 */
export async function updateAutomationForAgent(
  request: AutomationUpdateRequest,
  writer: AgentUpdateWriter,
  service: AutomationsService = getAutomationsService(),
): Promise<AutomationMutationResponse> {
  // What the agent may see: its caller's context, not the selected one.
  const snapshot = writer.callerContext
    ? await service.listForContext(writer.callerContext)
    : await service.list();
  const stored = snapshot.activities.find((entry) => entry.id === request.id);
  const owned = stored ? ownedPipelineId(stored) : undefined;
  if (
    !stored ||
    owned === undefined ||
    stored.action.type !== 'worktree_pipeline'
  )
    return writeUpdate(request, writer, service);
  const loaded = getStoredPipelineBySource('user', owned);
  const current = loaded.success ? loaded.data : undefined;
  const sentChat =
    request.action !== undefined && request.action.type !== 'worktree_pipeline'
      ? request.action
      : undefined;
  // A chat action would overwrite or delete a workflow changed by hand.
  if (sentChat && !ownedPipelineMatchesChat(stored, current))
    return { ok: false, error: OWNED_PIPELINE_HAND_EDITED };
  const chat =
    sentChat ??
    (request.action === undefined && current !== undefined
      ? (ownedPipelineToChatAction(
          current.content,
          stored.action.inputs ?? {},
          isCoworkWorkspace,
        ) ?? undefined)
      : undefined);
  if (chat === undefined || current === undefined) {
    // A pipeline action, or a workflow changed by hand: updated as sent.
    const updated = await writeUpdate(request, writer, service);
    if (
      updated.ok &&
      updated.activity &&
      ownedPipelineId(updated.activity) !== owned
    )
      await deleteOwnedPipeline(stored, current?.info.revision ?? null);
    return updated;
  }
  // A chat action read from the workflow stands for the action read above;
  // a write since then must not be overwritten with it.
  let changedMeanwhile = false;
  const guarded: UpdateWriter = sentChat
    ? writer
    : {
        ...writer,
        authorize: async (fresh: ScheduledActivity): Promise<boolean> => {
          if (!isDeepStrictEqual(fresh.action, stored.action)) {
            changedMeanwhile = true;
            return false;
          }
          return writer.authorize ? writer.authorize(fresh) : true;
        },
      };
  const changed = (
    response: AutomationMutationResponse,
  ): AutomationMutationResponse =>
    changedMeanwhile
      ? { ok: false, error: AUTOMATION_CHANGED_MEANWHILE }
      : response;
  const edited = editedActivity(request, stored, chat, writer);
  const regenerated = await regenerateOwned(
    request,
    stored,
    edited,
    owned,
    current,
    guarded,
    service,
  );
  if (regenerated) return changed(regenerated);
  // D11 would refuse its converted runs: back to the native action, if the
  // agent may write that, checked inside the queued write.
  const { authorizeNative } = writer;
  const nativeWriter: UpdateWriter = authorizeNative
    ? {
        ...guarded,
        authorize: async (fresh: ScheduledActivity): Promise<boolean> =>
          (guarded.authorize ? await guarded.authorize(fresh) : true) &&
          authorizeNative(chat),
      }
    : guarded;
  const updated = await writeUpdate(
    { ...request, action: chat },
    nativeWriter,
    service,
  );
  if (
    updated.ok &&
    updated.activity &&
    ownedPipelineId(updated.activity) !== owned
  )
    await deleteOwnedPipeline(stored, current.info.revision ?? null);
  return changed(updated);
}
