import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
  AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';
import {
  dispatchAgentChatSend,
  isAgentChatSendError,
  type AgentChatSendContext,
} from '../agent-messaging/send-orchestration';
import { isRecord } from '../lib/type-guards';
import { DiscoveryError } from '../project-discovery/errors';
import { isSplitLocked } from '../services/split-lock-service';
import { presentAppAdvisorAction } from './presentation-tools';
import type { AppAdvisorToolRuntimeSurfaces } from './runtime';

/** Compatibility projection: create in main, reveal in the UI, then send. */
export async function dispatchLegacyChatCreation(
  action:
    | Extract<AppAdvisorAction, { type: 'standalone-chat.create_chat' }>
    | Extract<AppAdvisorAction, { type: 'worktree-chat.open_tab' }>,
  context: {
    destination: AppAdvisorWatcherDestination;
    surfaces: AppAdvisorToolRuntimeSurfaces;
    /** The calling session's or route's bound interface tools. */
    boundTools?: readonly InterfaceToolName[];
    requestId: string;
    expectedUiRevision?: number;
    signal?: AbortSignal;
  },
): Promise<AppAdvisorActionResponse> {
  const { destination, surfaces, boundTools, requestId, signal } = context;
  const failure = (
    code: NonNullable<AppAdvisorActionResponse['error']>['code'],
    message: string,
  ): AppAdvisorActionResponse => ({
    requestId,
    ok: false,
    error: { code, message },
  });
  try {
    if (action.type === 'worktree-chat.open_tab' && action.chatId !== undefined)
      return failure('invalid_payload', 'This adapter only creates chat tabs.');

    if (
      action.type === 'worktree-chat.open_tab' &&
      action.initialMessage?.trim() &&
      isSplitLocked(action.projectId, action.worktreeId)
    )
      return failure(
        'surface_unavailable',
        'A Split PR is in progress for this worktree; it is locked until the split finishes.',
      );
    if (signal?.aborted)
      return failure('execution_failed', 'Chat creation was cancelled.');

    // Deferred: orchestration imports the App Advisor runtime transitively.
    const { dispatchAgentChatCreation } =
      await import('../agent-messaging/creation-orchestration');
    const sendContext: AgentChatSendContext = {
      caller: { kind: 'app_advisor', source: destination },
      watcherDestination: destination,
      surfaces,
      toolUseId: requestId,
    };
    const receipt = await dispatchAgentChatCreation(
      action.type === 'standalone-chat.create_chat'
        ? { type: 'projects.create_task', projectId: action.projectId }
        : {
            type: 'projects.create_task_chat',
            projectId: action.projectId,
            taskId: action.worktreeId,
          },
      sendContext,
    );
    const address = receipt.address;
    if (!('projectId' in address))
      return failure(
        'execution_failed',
        'The created project chat address is unavailable.',
      );
    // A cancelled reveal leaves the durable empty chat available for discovery;
    // never compensate by deleting a chat or sending into an unseen destination.
    if (signal?.aborted)
      return failure(
        'execution_failed',
        'Chat creation was cancelled after creation. The chat remains available.',
      );
    const response = await presentAppAdvisorAction({
      action:
        action.type === 'standalone-chat.create_chat'
          ? {
              type: 'standalone-chat.switch_chat',
              projectId: address.projectId,
              chatId: address.chatId,
            }
          : {
              type: 'worktree-chat.open_tab',
              projectId: address.projectId,
              worktreeId: address.taskId,
              chatId: address.chatId,
            },
      requestId,
      destination,
      ...(boundTools ? { boundTools } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return { ...response, requestId };
    if (action.type === 'standalone-chat.create_chat') {
      const projection = response.result;
      if (
        !isRecord(projection) ||
        !isRecord(projection.chat) ||
        !isRecord(projection.settings) ||
        projection.workEntryId !== address.taskId
      )
        return failure(
          'execution_failed',
          'The created chat settings could not be read. The chat remains available.',
        );
      return {
        requestId,
        ok: true,
        result: {
          projectId: address.projectId,
          workEntryId: address.taskId,
          chatId: address.chatId,
          chat: projection.chat,
          settings: projection.settings,
        },
      };
    }
    if (action.initialMessage?.trim()) {
      if (signal?.aborted)
        return failure(
          'execution_failed',
          'Chat creation was cancelled before sending. The chat remains available.',
        );
      // No queueForSetup: the legacy tool never supplied the nested Home flow's
      // setup-queue intent. That retained renderer-only flow is unchanged.
      await dispatchAgentChatSend(
        {
          type: 'projects.send_message',
          ...address,
          text: action.initialMessage,
        },
        sendContext,
      );
    }
    return { requestId, ok: true, result: { chatId: address.chatId } };
  } catch (error) {
    if (isAgentChatSendError(error))
      return failure(
        error.code === 'owner_boundary'
          ? 'not_found'
          : error.code === 'target_not_ready'
            ? 'invalid_target'
            : error.code,
        error.code === 'owner_boundary' ? 'Chat was not found.' : error.message,
      );
    if (error instanceof DiscoveryError)
      return failure(error.code, error.message);
    return failure(
      'execution_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
