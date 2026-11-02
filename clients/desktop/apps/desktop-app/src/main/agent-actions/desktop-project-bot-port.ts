import {
  AgentPortError,
  BOT_ACTION_TYPES,
  type AgentActionCall,
  type AgentActionResponse,
  type AgentJson,
  type AgentProjectBotPort,
  type BotAction,
  type ProjectAction,
} from '@canopy/agent-actions';
import type {
  AcceptedInputReceipt,
  AgentSendRefusalCode,
  CreatedTaskChatReceipt,
  SteeredInputReceipt,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import type {
  AgentChatSendContext,
  AgentSendAdmission,
  TrustedSendCaller,
} from '../agent-messaging/send-orchestration';
import type {
  AgentSenderRuntimeSource,
  PipelineSenderSource,
} from '../agent-messaging/sender-context';
import type { PipelineTrustedCaller } from '../agent-messaging/pipeline-caller';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { DesktopEnvironmentPort } from './desktop-environment-port';
import type { ChatSendAdmissionTab } from '../services/chat-send-admission';

type DesktopAgentActionCall = AgentActionCall<CanopyInjectedToolRuntime>;

const BOT_TYPES: ReadonlySet<string> = new Set(BOT_ACTION_TYPES);

/** Whether this call's surface may offer the bot actions. */
export function offersBotActions(actionTypes: readonly string[]): boolean {
  return actionTypes.some((type) => BOT_TYPES.has(type));
}

/** The trusted calling chat, or null when the surface supplied no scope. */
export function desktopProjectAgentCaller(
  call: Pick<AgentActionCall<unknown>, 'scope'>,
): Extract<ProjectDiscoveryCaller, { kind: 'project_agent' }> | null {
  const scope = call.scope;
  return scope
    ? {
        kind: 'project_agent',
        projectId: scope.workspaceId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      }
    : null;
}

/**
 * Bot actions are offered only while the calling chat's bot access is on.
 * Read on every call; dispatch rechecks it in the bot service.
 */
export async function desktopBotAccessAllowed(
  call: Pick<AgentActionCall<unknown>, 'scope'>,
): Promise<boolean> {
  const caller = desktopProjectAgentCaller(call);
  if (!caller) return false;
  // Deferred: the bot service imports the watcher and sidebar modules.
  const { isBotAccessAllowed } = await import('../project-discovery/bots');
  return isBotAccessAllowed(caller);
}

/** The environment port's admissions a root agent's project writes pass. */
export type DesktopAgentAdmissions = Pick<
  DesktopEnvironmentPort,
  | 'agentMessageAdmission'
  | 'agentChatStartAdmission'
  | 'agentStartedChatMessageAdmission'
>;

let admissionPort: DesktopEnvironmentPort | undefined;

/** The production admissions, from a lazily built desktop environment port. */
async function desktopAgentAdmissions(): Promise<DesktopAgentAdmissions> {
  // Deferred: the environment port imports the chat and approval services.
  const { createDesktopEnvironmentPort, desktopEnvironmentPortDeps } =
    await import('./desktop-environment-port');
  admissionPort ??= createDesktopEnvironmentPort(desktopEnvironmentPortDeps());
  return admissionPort;
}

/** No user or tool turn attends a pipeline or scheduled delivery. */
export const unattendedDeliveryHost: CanopyInjectedToolRuntime = {
  requestUserAnswers: () =>
    Promise.reject(new Error('No user attends this delivery.')),
  loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
};

/**
 * Admits a project chat's scheduled message again as it is delivered, with
 * the scheduling chat as the caller and `sent`, the tab settings the
 * delivery carries, checked against the ones admitted. Throws its refusal.
 * The automation commits through the legacy send, which runs no commit-time
 * check.
 */
export async function admitScheduledProjectMessage(
  sender: { workspaceId: string; worktreeId: string; chatId: string },
  target: { workspaceId: string; worktreeId: string; chatId: string },
  sent: ChatSendAdmissionTab,
): Promise<void> {
  await (
    await desktopAgentAdmissions()
  ).agentMessageAdmission(
    target,
    { scope: sender, host: unattendedDeliveryHost },
    sent,
  );
}

/**
 * Admits a root agent's queued message again as it is dispatched, against
 * the target chat as it is then; the dispatch runs with that chat's current
 * approval settings. The first message of a chat the sender started in a new
 * worktree is admitted as that start was, with the sender's approvals
 * carried into the new worktree. Throws the sender-context refusal the queue
 * cancels a delivery with.
 */
export async function readmitQueuedProjectMessage(
  sender: { workspaceId: string; worktreeId: string; chatId: string },
  target: { workspaceId: string; worktreeId: string; chatId: string },
  startedChat = false,
): Promise<void> {
  const call = { scope: sender, host: unattendedDeliveryHost };
  try {
    const admissions = await desktopAgentAdmissions();
    await (startedChat
      ? admissions.agentStartedChatMessageAdmission(target, call)
      : admissions.agentMessageAdmission(target, call));
  } catch (error) {
    if (!(error instanceof AgentPortError)) throw error;
    const { AgentSenderContextError } =
      await import('../agent-messaging/sender-context');
    throw new AgentSenderContextError(
      error.code === 'invalid_target'
        ? 'target_not_ready'
        : error.code === 'not_found'
          ? 'not_found'
          : 'authorization_conflict',
      error.message,
    );
  }
}

function sendRefusalCode(error: AgentPortError): AgentSendRefusalCode {
  return error.code === 'authorization_conflict' ||
    error.code === 'stale_ui_state'
    ? error.code
    : 'target_not_ready';
}

/** Reads an admission, its port refusal typed as a send refusal. */
async function readAdmission<T>(read: () => Promise<T>): Promise<T> {
  const { AgentChatSendError } =
    await import('../agent-messaging/send-orchestration');
  try {
    return await read();
  } catch (error) {
    throw error instanceof AgentPortError
      ? new AgentChatSendError(sendRefusalCode(error), error.message)
      : error;
  }
}

/** The admissions as the send orchestrations take them, with typed refusals. */
function sendAdmissions(
  admissions: () => Promise<DesktopAgentAdmissions>,
  call: DesktopAgentActionCall,
): Pick<AgentChatSendContext, 'admission' | 'startAdmission'> {
  return {
    admission: async (target): Promise<AgentSendAdmission> => {
      const { AgentChatSendError } =
        await import('../agent-messaging/send-orchestration');
      const admission = await readAdmission(async () =>
        (await admissions()).agentMessageAdmission(target, call),
      );
      return {
        check: admission.check,
        refusal: (): InstanceType<typeof AgentChatSendError> | undefined => {
          const error = admission.refusal();
          return (
            error &&
            new AgentChatSendError(sendRefusalCode(error), error.message)
          );
        },
      };
    },
    startAdmission: (task, firstMessage) =>
      readAdmission(async () =>
        (await admissions()).agentChatStartAdmission(task, firstMessage, call),
      ),
  };
}

/**
 * An agent-originated run's admissions (D11): the recording agent's own, as
 * its scheduled deliveries are admitted, with no attending user or tool turn.
 * Orchestrator agents have no project admission.
 */
function pipelineAgentAdmissions(
  agentOrigin: AgentSenderRuntimeSource,
): Pick<AgentChatSendContext, 'admission' | 'startAdmission'> {
  if (agentOrigin.projectId === APP_ADVISOR_PROJECT_ID) return {};
  return sendAdmissions(desktopAgentAdmissions, {
    scope: {
      workspaceId: agentOrigin.projectId,
      worktreeId: agentOrigin.worktreeId,
      chatId: agentOrigin.chatId,
    },
    host: unattendedDeliveryHost,
  });
}

/** What a pipeline step or an automation's own send may pass to the orchestrations. */
export type PipelineProjectBotOptions = Pick<
  AgentChatSendContext,
  | 'turnOverride'
  | 'composition'
  | 'fixedIds'
  | 'newChatSeed'
  | 'onChatResolved'
  | 'automationDispatch'
  | 'surfaces'
  | 'plannedTaskId'
  | 'reuseStarterChat'
  | 'newChat'
>;

/**
 * A pipeline step's project or bot write, through the same orchestrations and
 * refusal mapping as the agent port. Not an agent action: a pipeline has no
 * calling chat, so it is authorized by its run's owner and, when an agent
 * started the run, that agent's admission. Never reachable from an agent
 * surface or catalog.
 */
export async function dispatchPipelineProjectBotAction(
  action: ProjectAction | BotAction,
  caller: Extract<TrustedSendCaller, { kind: 'pipeline' }>,
  options: PipelineProjectBotOptions = {},
): Promise<Omit<AgentActionResponse<string>, 'requestId'>> {
  return writeResponse(async () => ({
    ...(await runPipelineProjectBotAction(action, caller, options)),
  }));
}

/**
 * The typed form of the pipeline entry: the orchestration's receipt, or an
 * `AgentChatSendError`. `dispatchPipelineProjectBotAction` wraps it for the
 * host step; the automations service uses it directly, so no JSON receipt is
 * ever cast back.
 */
export async function runPipelineProjectBotAction(
  action: ProjectAction | BotAction,
  caller: Extract<TrustedSendCaller, { kind: 'pipeline' }>,
  options: PipelineProjectBotOptions = {},
): Promise<
  AcceptedInputReceipt | SteeredInputReceipt | CreatedTaskChatReceipt
> {
  const sendContext: AgentChatSendContext = {
    caller,
    ...(caller.source.agentOrigin
      ? pipelineAgentAdmissions(caller.source.agentOrigin)
      : {}),
    ...options,
  };
  switch (action.type) {
    case 'projects.send_message':
    case 'bots.send_message': {
      const { dispatchAgentChatSend } =
        await import('../agent-messaging/send-orchestration');
      return dispatchAgentChatSend(action, sendContext);
    }
    case 'projects.steer_queued_message': {
      const { dispatchAgentChatSteer } =
        await import('../agent-messaging/steer-orchestration');
      return dispatchAgentChatSteer(action, sendContext);
    }
    case 'projects.create_task_chat':
    case 'bots.create_task_chat': {
      const { dispatchAgentChatCreation } =
        await import('../agent-messaging/creation-orchestration');
      return dispatchAgentChatCreation(action, sendContext);
    }
    case 'projects.create_task':
    case 'bots.create_task': {
      // A task ID this caller has not pinned could not be found again on a
      // replay, so a pipeline never creates a task without one.
      const { AgentChatSendError } =
        await import('../agent-messaging/send-orchestration');
      if (options.plannedTaskId === undefined)
        throw new AgentChatSendError(
          'validation_failed',
          'A pipeline task creation needs its planned task ID.',
        );
      const { dispatchAgentChatCreation } =
        await import('../agent-messaging/creation-orchestration');
      return dispatchAgentChatCreation(action, sendContext);
    }
    default: {
      const { AgentChatSendError } =
        await import('../agent-messaging/send-orchestration');
      throw new AgentChatSendError(
        'unsupported_action',
        `A pipeline step cannot run ${action.type}.`,
      );
    }
  }
}

/**
 * A write's receipt, or its typed refusal. An owner boundary looks like a
 * missing chat, and a target that is not ready is an invalid target.
 */
async function writeResponse(
  run: () => Promise<AgentJson>,
): Promise<Omit<AgentActionResponse<string>, 'requestId'>> {
  const { isAgentChatSendError } =
    await import('../agent-messaging/send-orchestration');
  try {
    return { ok: true, result: await run() };
  } catch (cause) {
    if (!isAgentChatSendError(cause)) throw cause;
    return {
      ok: false,
      error: {
        code:
          cause.code === 'owner_boundary'
            ? 'not_found'
            : cause.code === 'target_not_ready'
              ? 'invalid_target'
              : cause.code,
        message:
          cause.code === 'owner_boundary'
            ? 'Chat was not found.'
            : cause.message,
        ...(cause.code === 'stale_ui_state' ? { retryable: true } : {}),
      },
    };
  }
}

/**
 * The explicit-target project and bot actions, run by the project discovery
 * services and the agent messaging orchestrations for the trusted calling
 * chat. They authorize every target against the chat's saved owner; inline
 * watchers notify the calling chat. Project messages, including scheduled
 * ones and a created chat's first message, also pass the calling chat's
 * approval admission, and a created project chat starts within it.
 */
export function createDesktopProjectBotPort(
  admissions: () => Promise<DesktopAgentAdmissions>,
): AgentProjectBotPort<CanopyInjectedToolRuntime> {
  return {
    async dispatch(
      action,
      call,
    ): Promise<Omit<AgentActionResponse<string>, 'requestId'>> {
      const caller = desktopProjectAgentCaller(call);
      if (!caller)
        throw new AgentPortError(
          'surface_unavailable',
          `${action.type} needs the calling chat's scope.`,
        );
      const source = {
        projectId: caller.projectId,
        worktreeId: caller.worktreeId,
        chatId: caller.chatId,
      };
      const sendContext = {
        caller: { kind: 'project_root', source } as const,
        watcherDestination: source,
        ...sendAdmissions(admissions, call),
        ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
      };
      switch (action.type) {
        case 'projects.list':
        case 'projects.list_tasks':
        case 'projects.list_task_chats': {
          const { dispatchProjectDiscoveryAction } =
            await import('../project-discovery');
          return dispatchProjectDiscoveryAction(action, caller);
        }
        case 'projects.get_last_user_message':
        case 'projects.get_last_agent_response':
        case 'projects.read_history': {
          const { dispatchProjectReadAction } =
            await import('../project-discovery/reads');
          return dispatchProjectReadAction(action, caller);
        }
        case 'projects.send_message':
        case 'bots.send_message': {
          const { dispatchAgentChatSend } =
            await import('../agent-messaging/send-orchestration');
          return writeResponse(async () => ({
            ...(await dispatchAgentChatSend(action, sendContext)),
          }));
        }
        case 'projects.steer_queued_message': {
          const { dispatchAgentChatSteer } =
            await import('../agent-messaging/steer-orchestration');
          return writeResponse(async () => ({
            ...(await dispatchAgentChatSteer(action, sendContext)),
          }));
        }
        case 'projects.schedule_message': {
          const { dispatchAgentChatSchedule } =
            await import('../agent-messaging/schedule-orchestration');
          return writeResponse(async () => ({
            ...(await dispatchAgentChatSchedule(action, sendContext)).receipt,
          }));
        }
        case 'projects.create_task':
        case 'projects.create_task_chat':
        case 'bots.create_task':
        case 'bots.create_task_chat': {
          const { dispatchAgentChatCreation } =
            await import('../agent-messaging/creation-orchestration');
          return writeResponse(async () => ({
            ...(await dispatchAgentChatCreation(action, sendContext)),
          }));
        }
        default: {
          const { dispatchBotAction } =
            await import('../project-discovery/bots');
          return dispatchBotAction(action, caller);
        }
      }
    },
  };
}

export const desktopProjectBotPort = createDesktopProjectBotPort(
  desktopAgentAdmissions,
);

/**
 * A creation-only host step's pipeline source. Its display fields stand in
 * for a sender that is never built, as the port refuses a first message.
 */
function pipelineCreationSource(
  caller: PipelineTrustedCaller,
): PipelineSenderSource {
  return {
    executionId: caller.executionId,
    pipelineId: caller.pipelineId ?? caller.executionId,
    stepId: caller.stepId,
    pipelineName: '',
    owner: caller.owner,
    ...(caller.agentOrigin ? { agentOrigin: caller.agentOrigin } : {}),
  };
}

/**
 * The explicit-target actions for a pipeline host step, bound to its trusted
 * caller at construction; the call's own scope is ignored. In this phase only
 * task creation is available. `plannedTaskId` is the step's journaled task ID.
 */
export function createDesktopPipelineProjectBotPort(
  caller: PipelineTrustedCaller,
  admissions: () => Promise<DesktopAgentAdmissions> = desktopAgentAdmissions,
  plannedTaskId?: string,
): AgentProjectBotPort<CanopyInjectedToolRuntime> {
  return {
    async dispatch(
      action,
      call,
    ): Promise<Omit<AgentActionResponse<string>, 'requestId'>> {
      if (
        action.type !== 'projects.create_task' &&
        action.type !== 'bots.create_task'
      )
        throw new AgentPortError(
          'unsupported_action',
          `${action.type} isn't available to pipelines yet.`,
        );
      const origin = caller.agentOrigin;
      const originCall: DesktopAgentActionCall | undefined = origin
        ? {
            scope: {
              workspaceId: origin.projectId,
              worktreeId: origin.worktreeId,
              chatId: origin.chatId,
            },
            host: call.host,
          }
        : undefined;
      // No first message, so no pipeline sender is ever built from `source`.
      if (action.initialMessage !== undefined)
        throw new AgentPortError(
          'unsupported_action',
          "A pipeline's created task can't take a first message yet.",
        );
      const { dispatchAgentChatCreation } =
        await import('../agent-messaging/creation-orchestration');
      return writeResponse(async () => ({
        ...(await dispatchAgentChatCreation(action, {
          caller: { kind: 'pipeline', source: pipelineCreationSource(caller) },
          ...(plannedTaskId !== undefined ? { plannedTaskId } : {}),
          // Agent-originated runs: a created chat starts within the origin
          // agent's approvals, so that agent's later sends to it are admitted.
          ...(originCall
            ? {
                startAdmission: sendAdmissions(admissions, originCall)
                  .startAdmission,
              }
            : {}),
        })),
      }));
    },
  };
}
