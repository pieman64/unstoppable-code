import type { Descendant } from 'slate';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';

/**
 * Stages a skill starter prompt for the deep-link landing's "Try now"
 * (CAN-2361 v2): a prefilled NEW chat tab in the active worktree (the
 * `summarizeArchivedChat` precedent — draft only, the user sends), or the
 * Home "new task" composer when no worktree is selected. Never auto-submits.
 * Extracted from `usePublicShareLanding` so the worktree branch is directly
 * unit-testable against the store's immutable-update semantics.
 */
export function stageSkillStarterPrompt(prompt: string): void {
  const navigation = useNavigationStore.getState();
  const chat = useChatStore.getState();
  const worktree = chat.selectedWorktree;
  if (!worktree) {
    // No worktree selected: seed the Home "new task" composer instead.
    navigation.requestHomeComposerText(prompt);
    return;
  }
  chat.createTab({
    projectId: worktree.projectId,
    worktreeId: worktree.worktreeId,
  });
  const key = `${worktree.projectId}/${worktree.worktreeId}`;
  // Re-read AFTER createTab: Zustand state updates are immutable, so the
  // pre-createTab snapshot would miss the new tab's activeTabId.
  const newTabId = useChatStore.getState().worktreeChats[key]?.activeTabId;
  if (newTabId) {
    const draft: Descendant[] = [
      { type: 'paragraph', children: [{ text: prompt }] },
    ];
    chat.saveTabDraft(newTabId, draft);
  }
  navigation.navigate('main');
}
