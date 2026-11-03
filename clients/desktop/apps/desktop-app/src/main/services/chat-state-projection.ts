import type {
  ChatCoreMutation,
  ChatRuntimeState,
  ChatStateChange,
} from '@canopy/desktop-shared/types';
import { isInternalChatRequest } from '@canopy/desktop-shared/lib/internal-chat-row';
import { toArchivedChatSummary } from '../lib/chat-archives';
import type { CanonicalChatState } from './chat-state-reducer';

type ChatStateProjectionOptions =
  | number
  | {
      now?: number;
      snapshot?: Pick<CanonicalChatState, 'runtimeByChatId'> &
        Partial<Pick<CanonicalChatState, 'tabsFile'>>;
    };

/** Project private queue rows out of runtime state sent to outward consumers. */
export function projectChatRuntime(
  runtime: ChatRuntimeState,
): ChatRuntimeState {
  const internalQueuedMessageIds = new Set(
    (runtime.queuedMessages ?? [])
      .filter((message) => isInternalChatRequest(message.request))
      .map((message) => message.id),
  );

  return {
    ...runtime,
    queuedMessageIds: runtime.queuedMessageIds.filter(
      (id) => !internalQueuedMessageIds.has(id),
    ),
    ...(runtime.queuedMessages === undefined
      ? {}
      : {
          queuedMessages: runtime.queuedMessages.filter(
            (message) => !isInternalChatRequest(message.request),
          ),
        }),
  };
}

export function projectChatStateChanges(
  mutations: readonly ChatCoreMutation[],
  options: ChatStateProjectionOptions = {},
): ChatStateChange[] {
  const now =
    typeof options === 'number' ? options : (options.now ?? Date.now());
  const runtimeByChatId =
    typeof options === 'number' ? undefined : options.snapshot?.runtimeByChatId;

  return mutations.map((mutation): ChatStateChange => {
    switch (mutation.type) {
      case 'tab.created': {
        const tab =
          typeof options === 'number'
            ? undefined
            : options.snapshot?.tabsFile?.tabs.find(
                (candidate) => candidate.id === mutation.tab.id,
              );
        return {
          type: 'tab.upserted',
          tab:
            tab &&
            tab.trackedPlanImplementation !==
              mutation.tab.trackedPlanImplementation
              ? {
                  ...mutation.tab,
                  trackedPlanImplementation: tab.trackedPlanImplementation,
                }
              : mutation.tab,
        };
      }
      case 'tab.metadata_patched': {
        const tab =
          typeof options === 'number'
            ? undefined
            : options.snapshot?.tabsFile?.tabs.find(
                (candidate) => candidate.id === mutation.tabId,
              );
        return tab &&
          ('trackedPlanImplementation' in mutation.patch ||
            'trackedPlanId' in mutation.patch ||
            'turnEnds' in mutation.patch)
          ? {
              ...mutation,
              patch: {
                ...mutation.patch,
                trackedPlanImplementation:
                  tab.trackedPlanImplementation ?? null,
              },
            }
          : mutation;
      }
      case 'tab.removed':
        return mutation;
      case 'tab.order_changed':
        return mutation;
      case 'tab.active_changed':
        return mutation;
      case 'message.upserted':
        return mutation;
      case 'message.removed':
        return mutation;
      case 'messages.replaced':
        return mutation;
      case 'pending_question.upserted':
        return mutation;
      case 'pending_question.removed':
        return mutation;
      case 'runtime.patched':
        return {
          ...mutation,
          runtime: projectChatRuntime(
            runtimeByChatId?.[mutation.chatId] ?? mutation.runtime,
          ),
        };
      case 'archive.upserted':
        return {
          type: 'archive.upserted',
          archive: toArchivedChatSummary(mutation.entry, now),
        };
      case 'archive.removed':
        return mutation;
      case 'archive.read_state_changed':
        return mutation;
    }
  });
}
