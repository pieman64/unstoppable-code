import { createHash } from 'node:crypto';
import type { BotAction, ProjectAction } from '@canopy/agent-actions';
import type {
  AcceptedInputReceipt,
  AgentSendRefusalCode,
  CreatedTaskChatReceipt,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import {
  STANDALONE_CHAT_PROJECT_ID,
  type AgentProviderType,
  type AutomationAction,
  type ProjectOwnerContext,
  type ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { ModelHarness } from '@canopy/desktop-shared/types/model-harnesses';
import type {
  AgentSendFixedIds,
  TrustedSendCaller,
} from '../agent-messaging/send-orchestration';
import type { PipelineProjectBotOptions } from '../agent-actions/desktop-project-bot-port';
import { backgroundExecutionContextEnabled } from '../services/background-execution-context';
import { pipelineHostCallerOwner } from '../pipelines/pipeline-owner-policy';
import { resolveProjectSavedOwner } from '../lib/project-owner';

type AutomationSendCaller = Extract<TrustedSendCaller, { kind: 'pipeline' }>;

/** Run history text when the automation's owner cannot reach its target. */
export const AUTOMATION_OWNER_MISMATCH_MESSAGE =
  'This automation can no longer reach that chat. Edit this automation and pick another destination.';

/** Run history text for a Work Entry that is gone, as the native Cowork send said it. */
export const AUTOMATION_WORK_ENTRY_UNAVAILABLE_MESSAGE =
  'The selected work entry is no longer available. Choose another work entry and try again.';

/** Run history text for a refusal no automation produced before the shared port. */
export const AUTOMATION_SEND_REFUSED_MESSAGE =
  'The automation could not send its message.';

/**
 * The trusted caller for an automation's own send (CAN-4549). Owner: the
 * automation's bound context when background contexts are on and it is set,
 * otherwise the target project's saved owner; Personal for an Orchestrator
 * target. An unknown owner refuses with the owner-mismatch text. Agent
 * admission (D11) is not applied yet, so `agentOrigin` stays unset.
 */
export async function automationSendCaller(
  activity: Pick<ScheduledActivity, 'id' | 'name' | 'executionContext'>,
  target: { projectId: string; worktreeId?: string },
): Promise<AutomationSendCaller> {
  return {
    kind: 'pipeline',
    source: {
      kind: 'automation',
      automationId: activity.id,
      automationName: activity.name,
      owner: await automationSendOwner(activity.executionContext, target),
    },
  };
}

async function automationSendOwner(
  executionContext: string | undefined,
  target: { projectId: string; worktreeId?: string },
): Promise<ProjectOwnerContext> {
  const bound = backgroundExecutionContextEnabled()
    ? executionContext
    : undefined;
  // A bound context is not second-guessed: a target outside it reads as an
  // owner mismatch when the send is authorized.
  const owner =
    bound !== undefined
      ? pipelineHostCallerOwner(bound)
      : await resolveProjectSavedOwner(target);
  if (owner.kind === 'unknown')
    throw new Error(AUTOMATION_OWNER_MISMATCH_MESSAGE);
  return owner.kind === 'none' ? { kind: 'personal' } : owner;
}

// Fixed, so an automation run's IDs are the same in every build.
const AUTOMATION_SEND_NAMESPACE = Buffer.from(
  '6f1d8a52c3b94e07a5d2e4b19c7f3a60',
  'hex',
);

/** An RFC 4122 version-5 UUID of `name` in the automation send namespace. */
function automationSendUuid(name: string): string {
  const bytes = createHash('sha1')
    .update(AUTOMATION_SEND_NAMESPACE)
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Deterministic per-run IDs, so a resend within the same run finds its
 * receipt; a new run is a new message. A session send keeps today's message
 * ID (`automation-<runId>`, or `runId` for OpenCode, which needs a UUID).
 */
export function automationSendIds(
  runId: string,
  kind: 'session' | 'create',
  harness: ModelHarness | AgentProviderType | undefined,
): AgentSendFixedIds & { taskId: string } {
  const id = (purpose: string): string =>
    automationSendUuid(`${runId}\n${kind}\n${purpose}`);
  return {
    commandId: id('command'),
    userMessageId:
      kind === 'session'
        ? harness === 'opencode'
          ? runId
          : `automation-${runId}`
        : id('message'),
    tabId: id('tab'),
    createTabCommandId: id('create-tab'),
    taskId: id('task'),
  };
}

const OWNER_MISMATCH_CODES: ReadonlySet<AgentSendRefusalCode> =
  new Set<AgentSendRefusalCode>([
    'not_found',
    'owner_boundary',
    'owner_context_unavailable',
    'authorization_conflict',
  ]);

/**
 * Run history text for a port refusal. The service checks that its target
 * exists before dispatch, so a missing target here means the automation's
 * owner cannot reach it. Other refusals keep their name-free reason.
 */
export function automationRefusalError(
  _action: AutomationAction['type'],
  refusal: { code: AgentSendRefusalCode; message: string },
): Error {
  if (OWNER_MISMATCH_CODES.has(refusal.code))
    return new Error(AUTOMATION_OWNER_MISMATCH_MESSAGE);
  return new Error(`${AUTOMATION_SEND_REFUSED_MESSAGE} ${refusal.message}`);
}

/**
 * D4: sends a person or agent composed for later keep the native path. That
 * is usage-limit resumes, composer, Orchestrator and agent scheduled sends,
 * and the Home composer's deferred `scheduled_task` prompt. A session prompt
 * saved against a legacy standalone chat project also stays: the shared port
 * resolves only indexed projects. A person's scheduled send keeps this path
 * only until it converts to a pipeline (CAN-5479).
 */
export function staysNativeAutomationSend(
  activity: Pick<ScheduledActivity, 'action' | 'agentScheduledSend'>,
): boolean {
  const action = activity.action;
  if (action.type === 'worktree_session_prompt')
    return (
      action.purpose !== undefined ||
      activity.agentScheduledSend !== undefined ||
      action.workspaceId === STANDALONE_CHAT_PROJECT_ID
    );
  if (action.type === 'worktree_prompt')
    return action.purpose === 'scheduled_task';
  return false;
}

/**
 * Dispatch one canonical action for an automation and return its receipt,
 * or throw `automationRefusalError`. Anything else rethrows unchanged.
 */
export async function dispatchAutomationAction(
  action: ProjectAction | BotAction,
  caller: AutomationSendCaller,
  options: PipelineProjectBotOptions & { actionType: AutomationAction['type'] },
): Promise<AcceptedInputReceipt | CreatedTaskChatReceipt> {
  const { actionType, ...portOptions } = options;
  const [{ runPipelineProjectBotAction }, { isAgentChatSendError }] =
    await Promise.all([
      import('../agent-actions/desktop-project-bot-port'),
      import('../agent-messaging/send-orchestration'),
    ]);
  let receipt: Awaited<ReturnType<typeof runPipelineProjectBotAction>>;
  try {
    receipt = await runPipelineProjectBotAction(action, caller, portOptions);
  } catch (error) {
    if (isAgentChatSendError(error))
      throw automationRefusalError(actionType, error);
    throw error;
  }
  if ('steeredAt' in receipt)
    throw automationRefusalError(actionType, {
      code: 'unsupported_action',
      message: `An automation cannot run ${action.type}.`,
    });
  return receipt;
}

/**
 * An automation's own task or chat creation with its first message
 * (CAN-5379, CAN-5380): the creation receipt, whose input is the run's message.
 */
export async function dispatchAutomationCreation(
  action:
    | Extract<
        ProjectAction,
        { type: 'projects.create_task' | 'projects.create_task_chat' }
      >
    | Extract<
        BotAction,
        { type: 'bots.create_task' | 'bots.create_task_chat' }
      >,
  caller: AutomationSendCaller,
  options: PipelineProjectBotOptions & { actionType: AutomationAction['type'] },
): Promise<CreatedTaskChatReceipt & { input: AcceptedInputReceipt }> {
  const receipt = await dispatchAutomationAction(action, caller, options);
  if (!('taskCreated' in receipt) || !receipt.input)
    throw new Error(AUTOMATION_SEND_REFUSED_MESSAGE);
  return { ...receipt, input: receipt.input };
}
