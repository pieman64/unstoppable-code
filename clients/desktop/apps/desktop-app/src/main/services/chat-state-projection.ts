import type {
  ChatCoreMutation,
  ChatStateChange,
} from '@canopy/desktop-shared/types';
import { toArchivedChatSummary } from '../lib/chat-archives';

export function projectChatStateChanges(
  mutations: readonly ChatCoreMutation[],
  now = Date.now(),
): ChatStateChange[] {
  return mutations.map((mutation): ChatStateChange => {
    switch (mutation.type) {
      case 'tab.created':
        return { type: 'tab.upserted', tab: mutation.tab };
      case 'tab.metadata_patched':
        return mutation;
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
        return mutation;
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
