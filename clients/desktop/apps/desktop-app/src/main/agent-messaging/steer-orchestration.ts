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
  type TrustedSendCaller,
} from './send-orchestration';
import {
  isAgentSenderContextError,
  resolveAgentSenderIdentity,
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

const STEERING_UNAVAILABLE =
  "The queued message can't be steered now. It stays queued.";

/** Promote an existing input without replacing its captured sender context. */
export async function dispatchAgentChatSteer(
  action: ProjectsSteerQueuedMessageAction,
  context: { caller: TrustedSendCaller },
): Promise<SteeredInputReceipt> {
  try {
    return await steer(action, context.caller);
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
  const source = await canonicalSource(trustedCaller.source);
  if (
    (trustedCaller.kind === 'app_advisor') !==
    (source.projectId === APP_ADVISOR_PROJECT_ID)
  )
    throw new AgentChatSendError(
      'validation_failed',
      'The trusted sender runtime is inconsistent.',
    );
  const caller: ProjectDiscoveryCaller =
    trustedCaller.kind === 'app_advisor'
      ? { kind: 'app_advisor', chatId: source.chatId }
      : { kind: 'project_agent', ...source };
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
  const agentSteeringActor = await resolveAgentSenderIdentity(source);
  const envelope: ChatCommandEnvelope = {
    schemaVersion: 1,
    commandId: randomUUID(),
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
