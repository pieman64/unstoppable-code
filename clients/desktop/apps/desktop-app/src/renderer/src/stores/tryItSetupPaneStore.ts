import { create } from 'zustand';

/**
 * The in-app authorization pane a Try it setup attempt opens beside its chat
 * (CAN-4451). Transient: never persisted, and its URL is a single-use page.
 *
 * Every pane shares `MCP_OAUTH_BROWSER_SCOPE`, so one attempt holds the pane
 * at a time. Another chat's attempt is refused rather than replaced, and only
 * the attempt that opened a pane can close it.
 */
export interface TryItSetupPane {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  /** Identity of the attempt that opened the pane. */
  readonly attempt: object;
  readonly url: string;
  readonly capabilityName: string;
  /** Cancels the attempt, exactly like the notice's Cancel. */
  readonly onClose: () => void;
  /** Fails the attempt when the native browser can't be created. */
  readonly onError: () => void;
}

interface TryItSetupPaneState {
  pane: TryItSetupPane | null;
  reservation: object | null;
  /** Reserve the shared native scope before starting an embedded flow. */
  reserve: (attempt: object) => boolean;
  release: (attempt: object) => void;
  /** False when another attempt holds the pane. */
  open: (pane: TryItSetupPane) => boolean;
  /** Closes the pane only while `attempt` still owns it. */
  close: (attempt: object) => void;
}

export const useTryItSetupPaneStore = create<TryItSetupPaneState>(
  (set, get) => ({
    pane: null,
    reservation: null,
    reserve: (attempt): boolean => {
      if (get().reservation !== null && get().reservation !== attempt)
        return false;
      set({ reservation: attempt });
      return true;
    },
    release: (attempt): void => {
      if (get().reservation === attempt) set({ reservation: null });
    },
    open: (pane): boolean => {
      if (!get().reserve(pane.attempt)) return false;
      const current = get().pane;
      if (current && current.attempt !== pane.attempt) return false;
      set({ pane });
      return true;
    },
    close: (attempt): void => {
      if (get().pane?.attempt === attempt) set({ pane: null });
      get().release(attempt);
    },
  }),
);

/** The pane for exactly this chat, or null. */
export function useTryItSetupPane(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): TryItSetupPane | null {
  return useTryItSetupPaneStore((state) =>
    state.pane &&
    state.pane.projectId === target.projectId &&
    state.pane.worktreeId === target.worktreeId &&
    state.pane.chatId === target.chatId
      ? state.pane
      : null,
  );
}
