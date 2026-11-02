import {
  dispatchAgentChatSend,
  isAgentChatSendError,
} from '../agent-messaging/send-orchestration';
import {
  APP_ADVISOR_PROJECT_ID,
  type AppAdvisorAction,
  type AppAdvisorActionErrorCode,
  type AppAdvisorActionResponse,
  type AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';
import { isAgentSenderContextError } from '../agent-messaging/sender-context';
import {
  listWorkEntryIds,
  resolveWorkEntryForChat,
} from '../lib/cowork-work-entries';
import { validateId } from '../lib/validation';
import type { AppAdvisorToolRuntimeSurfaces } from './runtime';

export type AdvisorChatAction = Extract<
  AppAdvisorAction,
  { type: `advisor-chat.${string}` }
>;

export function isAdvisorChatAction(
  action: AppAdvisorAction,
): action is AdvisorChatAction {
  return action.type.startsWith('advisor-chat.');
}

type AdvisorChatActionResult = Omit<AppAdvisorActionResponse, 'requestId'>;

function failure(
  code: AppAdvisorActionErrorCode,
  message: string,
): AdvisorChatActionResult {
  return { ok: false, error: { code, message } };
}

/**
 * Starts or continues App Advisor chats directly from an Advisor tool call.
 *
 * These run in main through the same canonical send service as the Portal's
 * App Advisor send and App Advisor automations, so the new chat's model,
 * thinking level, and plugins come from the App Advisor defaults (or, for an
 * existing chat, from that chat), and the visible selection never moves.
 */
export async function dispatchAdvisorChatAction(
  action: AdvisorChatAction,
  source: AppAdvisorWatcherDestination,
  surfaces: AppAdvisorToolRuntimeSurfaces,
  toolUseId?: string,
): Promise<AdvisorChatActionResult> {
  try {
    switch (action.type) {
      case 'advisor-chat.create_entry':
      case 'advisor-chat.create_chat': {
        if (action.type === 'advisor-chat.create_chat') {
          validateId(action.workEntryId, 'workEntryId');
          const entryIds = await listWorkEntryIds(APP_ADVISOR_PROJECT_ID);
          if (!entryIds.includes(action.workEntryId)) {
            return failure(
              'invalid_target',
              `Unknown Orchestrator Work Entry ${action.workEntryId}.`,
            );
          }
        }
        // Creation owns sender capture, canonical writes and conservative
        // cleanup. Do not mint another entry or send the initial input twice.
        const { dispatchAgentChatCreation } =
          await import('../agent-messaging/creation-orchestration');
        const title =
          action.type === 'advisor-chat.create_entry'
            ? action.title?.trim()
            : undefined;
        const receipt = await dispatchAgentChatCreation(
          action.type === 'advisor-chat.create_entry'
            ? {
                type: 'bots.create_task',
                botId: 'app_advisor',
                ...(title ? { title } : {}),
                initialMessage: action.text,
              }
            : {
                type: 'bots.create_task_chat',
                botId: 'app_advisor',
                taskId: action.workEntryId,
                initialMessage: action.text,
              },
          {
            caller: { kind: 'app_advisor', source },
            watcherDestination: source,
            surfaces,
            ...(toolUseId ? { toolUseId } : {}),
          },
        );
        return {
          ok: true,
          result: {
            workEntryId: receipt.address.taskId,
            chatId: receipt.address.chatId,
          },
        };
      }
      case 'advisor-chat.send_message': {
        validateId(action.chatId, 'chatId');
        if (action.workEntryId !== undefined) {
          validateId(action.workEntryId, 'workEntryId');
        }
        if (action.chatId === source.chatId) {
          return failure(
            'invalid_target',
            'Send to another Orchestrator chat; this chat is already running.',
          );
        }
        const owner = await resolveWorkEntryForChat(
          APP_ADVISOR_PROJECT_ID,
          action.chatId,
        );
        if (!owner.entryId) {
          return failure(
            'invalid_target',
            owner.archivedInEntryId
              ? `Orchestrator chat ${action.chatId} is archived.`
              : `Unknown Orchestrator chat ${action.chatId}.`,
          );
        }
        if (
          action.workEntryId !== undefined &&
          action.workEntryId !== owner.entryId
        ) {
          return failure(
            'invalid_target',
            `Orchestrator chat ${action.chatId} belongs to Work Entry ${owner.entryId}.`,
          );
        }
        await dispatchAgentChatSend(
          {
            type: 'bots.send_message',
            botId: 'app_advisor',
            taskId: owner.entryId,
            chatId: action.chatId,
            text: action.text,
          },
          {
            caller: { kind: 'app_advisor', source },
            watcherDestination: source,
            surfaces,
            ...(toolUseId ? { toolUseId } : {}),
          },
        );
        return {
          ok: true,
          result: { workEntryId: owner.entryId, chatId: action.chatId },
        };
      }
    }
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
    if (isAgentSenderContextError(error)) {
      return failure(
        error.code === 'owner_boundary'
          ? 'not_found'
          : error.code === 'target_not_ready'
            ? 'invalid_target'
            : error.code,
        error.code === 'owner_boundary' ? 'Chat was not found.' : error.message,
      );
    }
    return failure(
      'execution_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
