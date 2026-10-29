import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';

/**
 * Whether the Pipeline Assistant already holds a conversation: a chat tab with
 * at least one message. The drawer opens by default only then, so an empty
 * assistant stays out of the way until the user opens it (CAN-3980).
 */
export async function pipelineAssistantHasConversation(
  pluginSelections?: ChatTabPluginSelections,
): Promise<boolean> {
  const store = useChatStore.getState();
  await store.loadTabsForTarget(
    PIPELINE_EDITOR_PROJECT_ID,
    PIPELINE_EDITOR_WORKTREE_ID,
    pluginSelections ? { pluginSelections } : undefined,
  );
  const chat =
    useChatStore.getState().worktreeChats[
      `${PIPELINE_EDITOR_PROJECT_ID}/${PIPELINE_EDITOR_WORKTREE_ID}`
    ];
  return (chat?.tabs ?? []).some(
    (tab) => tab.kind !== 'file' && tab.messages.length > 0,
  );
}
