import {
  AgentPortError,
  BOT_ACTION_TYPES,
  type AgentActionCall,
  type AgentActionResponse,
  type AgentJson,
  type AgentProjectBotPort,
} from '@canopy/agent-actions';
import type { AgentSendRefusalCode } from '@canopy/desktop-shared/lib/chat-send-actions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import type {
  AgentChatSendContext,
  AgentSendAdmission,
} from '../agent-messaging/send-orchestration';
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

/** A scheduled delivery's host: no user or tool turn attends it. */
const scheduledDeliveryHost: CanopyInjectedToolRuntime = {
  requestUserAnswers: () =>
    Promise.reject(new Error('No user attends a scheduled delivery.')),
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
    { scope: sender, host: scheduledDeliveryHost },
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
  const call = { scope: sender, host: scheduledDeliveryHost };
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
