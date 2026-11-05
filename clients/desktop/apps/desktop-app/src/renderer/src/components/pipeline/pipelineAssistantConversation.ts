import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { consumePipelineAssistantNewChatRequest } from '@/lib/pipelineAssistantEvents';

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

const PIPELINE_EDITOR_TARGET = {
  projectId: PIPELINE_EDITOR_PROJECT_ID,
  worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
} as const;

/**
 * Picks the chat the loaded Pipeline Assistant opens on. A new workflow asks
 * for its own chat (CAN-4319), which only an edit view (`inEditView`) takes,
 * so its conversation starts empty with the starters: an untouched starter
 * tab is reused, and a tab holding a conversation, a draft or staged context
 * stays while the new chat opens beside it. Otherwise the assistant keeps
 * the chat it had, or gets one.
 */
export function openPipelineAssistantChat(inEditView: boolean): void {
  const store = useChatStore.getState();
  if (inEditView && consumePipelineAssistantNewChatRequest()) {
    store.createTab({ ...PIPELINE_EDITOR_TARGET, replaceActiveEmpty: true });
    return;
  }
  void store.ensureWorktreeHasChatTab(PIPELINE_EDITOR_TARGET);
}
