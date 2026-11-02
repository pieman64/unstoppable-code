import { useCallback, useMemo } from 'react';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { discardChatDraft } from '@/lib/chatDrafts';
import { useChatStore, useWorktreeChatRenderState } from '@/stores/chatStore';

/** The Pipeline Assistant's chats, kept under the pipeline-editor sentinel. */
export const PIPELINE_EDITOR_CHAT_KEY = `${PIPELINE_EDITOR_PROJECT_ID}/${PIPELINE_EDITOR_WORKTREE_ID}`;

export interface PipelineAssistantDraft {
  /** Text typed into the shown Assistant composer and not sent. */
  readonly present: boolean;
  /** Empties that composer and forgets its saved draft. */
  readonly discard: () => void;
}

/**
 * The Pipeline Assistant's unsent draft, which the pipeline editor counts as
 * unsaved work (Sergii's QA, 2026-10-23): leaving asks first, and Discard
 * drops it. Only a mounted composer reports text, so a closed drawer has
 * nothing to lose here.
 */
export function usePipelineAssistantDraft(): PipelineAssistantDraft {
  const tabId = useWorktreeChatRenderState(
    PIPELINE_EDITOR_CHAT_KEY,
    (chat) => chat?.activeTabId ?? null,
  );
  const present = useChatStore(
    (state) => tabId !== null && state.composerTextPresent[tabId] === true,
  );
  const discard = useCallback((): void => {
    if (tabId !== null) discardChatDraft(tabId);
  }, [tabId]);
  return useMemo(() => ({ present, discard }), [present, discard]);
}
