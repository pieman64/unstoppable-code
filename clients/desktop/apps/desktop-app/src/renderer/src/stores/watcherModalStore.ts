import { create } from 'zustand';
import { useAppAdvisorWatchersStore } from './appAdvisorWatchersStore';

/** Worktree chat a "watch this chat" modal is targeting. */
export interface WatcherModalTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * Drives the single, app-level "watch this chat" modal. The modal is decoupled
 * from the {@link ChatWatcherButton} that opens it because that button is only
 * rendered during an active turn — once the turn ends the button unmounts, but
 * the modal must stay open until the user closes it (per the watcher UX
 * requirement that a turn completing while the modal is open defers firing).
 *
 * Opening the modal holds the chat's completion firing; closing it releases the
 * hold, which replays any completion that arrived while open so the configured
 * watchers fire then.
 */
interface WatcherModalStore {
  target: WatcherModalTarget | null;
  open: (target: WatcherModalTarget) => void;
  close: () => void;
}

export const useWatcherModalStore = create<WatcherModalStore>((set, get) => ({
  target: null,
  open: (target): void => {
    const current = get().target;
    const watchersStore = useAppAdvisorWatchersStore.getState();
    // Switching directly from one chat's modal to another: release the prior
    // hold first so a deferred completion for it is not stranded.
    if (
      current &&
      (current.projectId !== target.projectId ||
        current.worktreeId !== target.worktreeId ||
        current.chatId !== target.chatId)
    ) {
      watchersStore.releaseChatFiring({ scope: 'worktree', ...current });
    }
    watchersStore.holdChatFiring({ scope: 'worktree', ...target });
    set({ target });
  },
  close: (): void => {
    const current = get().target;
    if (current) {
      useAppAdvisorWatchersStore
        .getState()
        .releaseChatFiring({ scope: 'worktree', ...current });
    }
    set({ target: null });
  },
}));
