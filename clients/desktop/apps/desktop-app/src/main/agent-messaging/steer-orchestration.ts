import { randomUUID } from 'node:crypto';
import {
  parseProjectMessageControlAction,
  type ProjectsSteerQueuedMessageAction,
  type SteeredInputReceipt,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import {
  APP_ADVISOR_PROJECT_ID,
  type ChatCommandEnvelope,
  type ChatCommandResult,
} from '@canopy/desktop-shared/types';
import {
  canonicalSource,
  AgentChatSendError,
  pipelineDiscoveryCaller,
  type AgentSendFixedIds,
  type TrustedSendCaller,
} from './send-orchestration';
import {
  isAgentSenderContextError,
  pipelineSenderIdentity,
  resolveAgentSenderIdentity,
  revalidatePipelineAgentOrigin,
} from './sender-context';
import { resolveAuthorizedChat } from '../project-discovery/chat-target';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import { DiscoveryError } from '../project-discovery/errors';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../canopy-runtime/core-chat-command-adapter';
import { getChatStateCommandPort } from '../ipc/chat-state';

type SteeringActor = Awaited<ReturnType<typeof resolveAgentSenderIdentity>>;

const STEERING_UNAVAILABLE =
  "The queued message can't be steered now. It stays queued.";

/** Promote an existing input without replacing its captured sender context. */
export async function dispatchAgentChatSteer(
  action: ProjectsSteerQueuedMessageAction,
  context: {
    caller: TrustedSendCaller;
    /** Host-step replays: the steer's fixed command ID. */
    fixedIds?: Pick<AgentSendFixedIds, 'steerCommandId'>;
  },
): Promise<SteeredInputReceipt> {
  try {
    return await steer(
      action,
      context.caller,
      context.fixedIds?.steerCommandId,
    );
  } catch (error) {
    if (isAgentSenderContextError(error)) {
      const hidden =
        error.code === 'owner_boundary' ||
        error.code === 'authorization_conflict';
      throw new AgentChatSendError(
        hidden ? 'not_found' : error.code,
        hidden ? 'The target chat is not available.' : error.message,
      );
    }
    if (error instanceof DiscoveryError)
      throw new AgentChatSendError(
        error.code === 'advisor_access_disabled'
          ? 'advisor_access_disabled'
          : 'not_found',
        'The target chat is not available.',
      );
    throw error;
  }
}

async function steer(
  input: ProjectsSteerQueuedMessageAction,
  trustedCaller: TrustedSendCaller,
  fixedCommandId: string | undefined,
): Promise<SteeredInputReceipt> {
  const parsed = parseProjectMessageControlAction(input);
  if (!parsed.ok)
    throw new AgentChatSendError('validation_failed', parsed.message);
  const action = parsed.action;
  if (action.type !== 'projects.steer_queued_message')
    throw new AgentChatSendError(
      'validation_failed',
      'Expected a steer action.',
    );
  let caller: ProjectDiscoveryCaller;
  let steeringActor: () => Promise<SteeringActor>;
  if (trustedCaller.kind === 'pipeline') {
    caller = pipelineDiscoveryCaller(trustedCaller.source);
    // A pipeline's actor is its captured identity, with no I/O; the queue
    // checks at claim time that it steers only its own row.
    const actor = pipelineSenderIdentity(trustedCaller.source);
    steeringActor = (): Promise<SteeringActor> => Promise.resolve(actor);
  } else {
    const source = await canonicalSource(trustedCaller.source);
    steeringActor = (): Promise<SteeringActor> =>
      resolveAgentSenderIdentity(source);
    if (
      (trustedCaller.kind === 'app_advisor') !==
      (source.projectId === APP_ADVISOR_PROJECT_ID)
    )
      throw new AgentChatSendError(
        'validation_failed',
        'The trusted sender runtime is inconsistent.',
      );
    caller =
      trustedCaller.kind === 'app_advisor'
        ? { kind: 'app_advisor', chatId: source.chatId }
        : { kind: 'project_agent', ...source };
  }
  const target = await resolveAuthorizedChat(
    {
      projectId: action.projectId,
      taskId: action.taskId,
      chatId: action.chatId,
    },
    caller,
  );
  if (
    target.tab.readOnly ||
    target.tab.staleSessionDetected !== undefined ||
    target.tab.kind === 'file'
  )
    throw new AgentChatSendError(
      'not_found',
      'The target chat is not available.',
    );
  // D11: before any effect, the run's agent must still be current and keep
  // the run's owner, as for a send or a creation.
  if (trustedCaller.kind === 'pipeline' && trustedCaller.source.agentOrigin)
    await revalidatePipelineAgentOrigin(
      trustedCaller.source.agentOrigin,
      trustedCaller.source.owner,
      target.scope.workspaceId,
    );
  const agentSteeringActor = await steeringActor();
  const envelope: ChatCommandEnvelope = {
    schemaVersion: 1,
    commandId: fixedCommandId ?? randomUUID(),
    projectId: target.scope.workspaceId,
    worktreeId: target.scope.worktreeId,
    command: {
      type: 'chat.steer_queued_message',
      chatId: target.scope.chatId,
      queuedMessageId: action.queuedMessageId,
      agentSteeringActor,
    },
  };
  const port = getChatStateCommandPort();
  if (!port)
    throw new AgentChatSendError(
      'target_not_ready',
      'Chat command dispatch is unavailable.',
    );
  // A host-step replay of an applied steer does not steer again.
  const replayed = fixedCommandId
    ? await port.getCommandReceipt?.(envelope)
    : undefined;
  if (
    replayed?.outcome === 'applied' ||
    replayed?.outcome === 'already_applied'
  )
    return {
      address: target.address,
      queuedMessageId: action.queuedMessageId,
      disposition: 'steered',
      // The command receipt keeps no time; the host journal holds the first.
      steeredAt: new Date().toISOString(),
    };
  let result: ChatCommandResult;
  try {
    result = await dispatchTrustedChatCommand(
      envelope,
      createChatCommandDispatchOptions(port, getActiveDesktopRuntime(), {
        principalId: 'local-desktop-user',
        clientInstanceId: 'agent-chat-steer',
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'mcp',
        grants: ['core.chat.write'],
      }),
    );
  } catch (error) {
    // Authorization refusals map like acceptance ones; other queue refusals
    // restore the row before the durable claim.
    if (isAgentSenderContextError(error)) throw error;
    throw new AgentChatSendError('missing_capability', STEERING_UNAVAILABLE);
  }
  if (result.outcome === 'applied' || result.outcome === 'already_applied')
    return {
      address: target.address,
      queuedMessageId: action.queuedMessageId,
      disposition: 'steered',
      steeredAt: new Date().toISOString(),
    };
  if (result.outcome === 'rejected')
    throw new AgentChatSendError('missing_capability', STEERING_UNAVAILABLE);
  throw new AgentChatSendError(
    result.outcome === 'not_found' ? 'not_found' : 'target_not_ready',
    result.reason ?? 'The target refused this input.',
  );
}
