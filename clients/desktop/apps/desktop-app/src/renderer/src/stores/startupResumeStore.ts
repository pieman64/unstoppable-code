import { create } from 'zustand';
import type { StartupResumeTarget } from '@/lib/startup-resume';

/**
 * Session-scoped startup "Resume" offer. Startup routing always lands on the
 * Home composer; when the MRU context (`lastActiveContext` / legacy
 * `lastSelectedWorktree*` preferences) still resolves to a live target,
 * `WorktreeManager`'s initialize pass stores it here instead of navigating,
 * and `HomeSurface` renders it as a dismissible Resume card.
 *
 * Clearing semantics: the offer is cleared when the user navigates to ANY
 * workspace/worktree/chat — every such navigation funnels through
 * `chatStore.selectWorktree` (sidebar/kanban worktree clicks, cowork chat
 * activation, Home sends, notification deep links), which calls
 * {@link StartupResumeState.clearOffer}. Navigating to other areas
 * (Settings, Pipelines, Automations, …) intentionally leaves the offer
 * intact. Dismissing is session-only: the MRU preference is untouched, so the
 * next launch offers the same target again.
 */
interface StartupResumeState {
  offer: StartupResumeTarget | null;
  setOffer: (offer: StartupResumeTarget) => void;
  clearOffer: () => void;
}

export const useStartupResumeStore = create<StartupResumeState>((set) => ({
  offer: null,
  setOffer: (offer): void => {
    set({ offer });
  },
  clearOffer: (): void => {
    // No-op when already clear so the frequent selectWorktree call sites do
    // not trigger spurious subscriber notifications.
    set((state) => (state.offer === null ? state : { offer: null }));
  },
}));
