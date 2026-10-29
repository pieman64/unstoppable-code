import { create } from 'zustand';
import type {
  AppAdvisorWatcherChatFiringHoldRequest,
  AppAdvisorWatcherCreateRequest,
  AppAdvisorWatcherDestination,
  AppAdvisorWatcherSummary,
  SetupAppAdvisorWatchersResult,
} from '@canopy/desktop-shared/types';

/** Identifies a worktree chat used as a watcher target. */
export interface WatcherTargetChat {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * Renderer-side mirror of the visible App Advisor watcher list. The
 * main-process watcher service is the source of truth: this store hydrates
 * from `window.api.appAdvisor.listWatchers()` and stays in sync via the
 * `onWatchersChanged` broadcast, never deriving the visible set locally.
 *
 * "Visible" matches the backend filter: only watchers whose status is
 * `active` or `delivery_failed` are surfaced to the UI. The `firing`
 * variant is a transient internal state and `fired` watchers are retained by
 * the backend for diagnostics but hidden from renderer lists.
 *
 * The store is safe to consume from both the main renderer and the
 * standalone App Advisor window renderer — hydrate() avoids DOM-only side
 * effects, and the subscription wires up lazily through the first
 * `subscribeBridge()` call.
 */
export interface AppAdvisorWatchersStore {
  watchers: AppAdvisorWatcherSummary[];
  /**
   * Recent watcher fires (`fired` / `delivery_failed`, plus `firing` while
   * the message is still being delivered), newest first, capped by the
   * backend. Hydrated alongside {@link watchers} and
   * re-fetched whenever the `onWatchersChanged` broadcast fires (a fire
   * always mutates the visible set too, so the broadcast is a reliable
   * refresh signal without widening its payload).
   */
  completedWatchers: AppAdvisorWatcherSummary[];
  loading: boolean;
  hydrated: boolean;
  error: string | null;
  /**
   * Per-watcher delete failure message keyed by watcher id. The modal reads
   * this to surface an inline `Could not delete watcher.` message next to
   * the offending row. Cleared whenever the upstream snapshot drops the
   * watcher (e.g. it actually got deleted) so stale errors don't linger.
   */
  deleteErrors: Record<string, string>;
  /**
   * Lazily mount the `onWatchersChanged` subscription. Returns the
   * unsubscribe handle so callers (typically `useEffect` cleanup) can
   * detach the underlying IPC listener on unmount.
   *
   * Safe to call from both renderers and from multiple components — each
   * call mounts its own listener so unmounts stay symmetric.
   */
  subscribeBridge: () => () => void;
  /**
   * Snapshot the visible watcher set from the main process and replace
   * local state with it. Sets `loading=true` while in flight, clears
   * `error` on success, captures the error string on failure.
   */
  hydrate: () => Promise<void>;
  /**
   * Forward a delete to the main process. The backend resolves with
   * `{ ok: false, error }` for recoverable failures (unknown id, watcher
   * already firing) — we record the message in `deleteErrors[id]` so the
   * modal can render it inline. Returns the IPC result for callers that
   * need to react synchronously (e.g. tests).
   *
   * `options.notifySubscriber`, when `true`, opts into the backend's
   * delete-with-notify path: the subscribing chat receives a final
   * `watcher-deleted` message before the watcher is removed. Defaults to
   * `false` to preserve the legacy "silent delete" semantics that callers
   * who pass a bare watcher id rely on.
   */
  deleteWatcher: (
    watcherId: string,
    options?: { notifySubscriber?: boolean },
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Selector for "watchers whose destination is this chat AND whose status
   * is renderer-visible." Pure read of current state — components should
   * still subscribe through the zustand hook to get re-renders on update.
   */
  watchersForChat: (chatId: string) => AppAdvisorWatcherSummary[];
  watchersForDestination: (
    destination: AppAdvisorWatcherDestination,
  ) => AppAdvisorWatcherSummary[];
  /**
   * Selector for "watchers whose TARGET is this worktree chat" — i.e. watchers
   * that observe this chat (as opposed to {@link watchersForChat}, which
   * matches watchers whose destination is this chat). Used by the chat-surface
   * eye button so a chat can see what is watching it.
   */
  watchersForTargetChat: (
    target: WatcherTargetChat,
  ) => AppAdvisorWatcherSummary[];
  /**
   * Create a watcher from a trusted UI gesture. Forwards to the main process,
   * which validates and dedupes. Resolves with the backend
   * {@link SetupAppAdvisorWatchersResult} so callers can surface inline errors.
   */
  createWatcher: (
    request: AppAdvisorWatcherCreateRequest,
  ) => Promise<SetupAppAdvisorWatchersResult>;
  /** Edit a watcher's follow-up instruction (empty value clears it). */
  updateWatcherFollowUp: (
    watcherId: string,
    followUpInstruction: string | undefined,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Pause completion-watcher firing for a chat while its modal is open. */
  holdChatFiring: (request: AppAdvisorWatcherChatFiringHoldRequest) => void;
  /** Resume firing for a chat and replay any deferred completion. */
  releaseChatFiring: (request: AppAdvisorWatcherChatFiringHoldRequest) => void;
}

function isVisibleWatcher(watcher: AppAdvisorWatcherSummary): boolean {
  return watcher.status === 'active' || watcher.status === 'delivery_failed';
}

function pruneDeleteErrors(
  existing: Record<string, string>,
  watchers: AppAdvisorWatcherSummary[],
): Record<string, string> {
  if (Object.keys(existing).length === 0) return existing;
  const presentIds = new Set(watchers.map((w) => w.id));
  let changed = false;
  const next: Record<string, string> = {};
  for (const [id, message] of Object.entries(existing)) {
    if (presentIds.has(id)) {
      next[id] = message;
    } else {
      changed = true;
    }
  }
  return changed ? next : existing;
}

let completedRefreshInFlight = false;
let completedRefreshQueued = false;

/**
 * Best-effort refresh of the completed-fire history. Separate from the
 * visible-list flow so a missing bridge method (older preload, unit tests)
 * or a transient failure degrades to an unchanged history instead of
 * poisoning the primary watcher list state.
 *
 * Watcher broadcasts arrive in bursts (polls, fires, deliveries), so one
 * history read runs at a time and requests made during it fold into a
 * single follow-up read that reflects the latest broadcast.
 */
async function refreshCompletedWatchers(
  set: (partial: Partial<AppAdvisorWatchersStore>) => void,
): Promise<void> {
  const api =
    typeof window !== 'undefined' ? window.api?.appAdvisor : undefined;
  if (!api?.listCompletedWatchers) return;
  if (completedRefreshInFlight) {
    completedRefreshQueued = true;
    return;
  }
  completedRefreshInFlight = true;
  try {
    const completedWatchers = await api.listCompletedWatchers();
    set({ completedWatchers });
  } catch {
    // Keep the previous history snapshot on failure.
  } finally {
    completedRefreshInFlight = false;
    if (completedRefreshQueued) {
      completedRefreshQueued = false;
      void refreshCompletedWatchers(set);
    }
  }
}

export const useAppAdvisorWatchersStore = create<AppAdvisorWatchersStore>(
  (set, get) => ({
    watchers: [],
    completedWatchers: [],
    loading: false,
    hydrated: false,
    error: null,
    deleteErrors: {},
    subscribeBridge: (): (() => void) => {
      // Defensive: in tests `window.api` may not yet be wired up. Fall
      // back to a no-op unsubscribe so callers never throw on mount.
      const api =
        typeof window !== 'undefined' ? window.api?.appAdvisor : undefined;
      if (!api?.onWatchersChanged) {
        return (): void => undefined;
      }
      return api.onWatchersChanged((next) => {
        set((state) => ({
          watchers: next,
          hydrated: true,
          deleteErrors: pruneDeleteErrors(state.deleteErrors, next),
        }));
        void refreshCompletedWatchers(set);
      });
    },
    hydrate: async (): Promise<void> => {
      const api =
        typeof window !== 'undefined' ? window.api?.appAdvisor : undefined;
      if (!api?.listWatchers) {
        set({ loading: false, hydrated: true, error: null });
        return;
      }
      set({ loading: true, error: null });
      try {
        const watchers = await api.listWatchers();
        set((state) => ({
          watchers,
          loading: false,
          hydrated: true,
          error: null,
          deleteErrors: pruneDeleteErrors(state.deleteErrors, watchers),
        }));
        void refreshCompletedWatchers(set);
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to load App Advisor watchers.';
        set({ loading: false, error: message });
      }
    },
    deleteWatcher: async (
      watcherId,
      options,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const api =
        typeof window !== 'undefined' ? window.api?.appAdvisor : undefined;
      if (!api?.deleteWatcher) {
        const result = {
          ok: false as const,
          error: 'App Advisor IPC unavailable.',
        };
        set((state) => ({
          deleteErrors: { ...state.deleteErrors, [watcherId]: result.error },
        }));
        return result;
      }
      try {
        // The preload bridge normalizes a bare string id into
        // `{ watcherId, notifySubscriber: false }`. Pass the structured
        // request when the caller asked us to notify so the preload doesn't
        // have to second-guess legacy callers.
        const result = await api.deleteWatcher(
          options?.notifySubscriber === true
            ? { watcherId, notifySubscriber: true }
            : watcherId,
        );
        if (result.ok) {
          // Clear any prior failure note for this id — successful deletes
          // will get a fresh snapshot via onWatchersChanged anyway, but
          // dropping the entry here keeps the UI responsive in tests that
          // don't drive the broadcast.
          set((state) => {
            if (!(watcherId in state.deleteErrors)) return {};
            const next = { ...state.deleteErrors };
            delete next[watcherId];
            return { deleteErrors: next };
          });
        } else {
          set((state) => ({
            deleteErrors: { ...state.deleteErrors, [watcherId]: result.error },
          }));
        }
        return result;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Failed to delete watcher.';
        const result = { ok: false as const, error: message };
        set((state) => ({
          deleteErrors: { ...state.deleteErrors, [watcherId]: message },
        }));
        return result;
      }
    },
    watchersForChat: (chatId): AppAdvisorWatcherSummary[] => {
      return get().watchers.filter(
        (watcher) =>
          watcher.destination.chatId === chatId && isVisibleWatcher(watcher),
      );
    },
    watchersForDestination: (destination): AppAdvisorWatcherSummary[] => {
      return get().watchers.filter(
        (watcher) =>
          watcher.destination.projectId === destination.projectId &&
          watcher.destination.worktreeId === destination.worktreeId &&
          watcher.destination.chatId === destination.chatId &&
          isVisibleWatcher(watcher),
      );
    },
    watchersForTargetChat: (target): AppAdvisorWatcherSummary[] => {
      return get().watchers.filter(
        (watcher) =>
          watcher.target.kind === 'worktree_chat' &&
          watcher.target.projectId === target.projectId &&
          watcher.target.worktreeId === target.worktreeId &&
          watcher.target.chatId === target.chatId &&
          isVisibleWatcher(watcher),
      );
    },
    createWatcher: async (request): Promise<SetupAppAdvisorWatchersResult> => {
      const api =
        typeof window !== 'undefined' ? window.api?.appAdvisor : undefined;
      if (!api?.createWatcher) {
        return { ok: false, error: 'App Advisor IPC unavailable.' };
      }
      try {
        return await api.createWatcher(request);
      } catch (error: unknown) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to create watcher.',
        };
      }
    },
    updateWatcherFollowUp: async (
      watcherId,
      followUpInstruction,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const api =
        typeof window !== 'undefined' ? window.api?.appAdvisor : undefined;
      if (!api?.updateWatcher) {
        return { ok: false, error: 'App Advisor IPC unavailable.' };
      }
      try {
        return await api.updateWatcher({ watcherId, followUpInstruction });
      } catch (error: unknown) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to update watcher.',
        };
      }
    },
    holdChatFiring: (request): void => {
      const api =
        typeof window !== 'undefined' ? window.api?.appAdvisor : undefined;
      if (!api?.holdChatFiring) return;
      void api.holdChatFiring(request);
    },
    releaseChatFiring: (request): void => {
      const api =
        typeof window !== 'undefined' ? window.api?.appAdvisor : undefined;
      if (!api?.releaseChatFiring) return;
      void api.releaseChatFiring(request);
    },
  }),
);

let retainedWatchersBridge: { refs: number; unsubscribe: () => void } | null =
  null;

/**
 * Ref-counted `subscribeBridge()` plus a one-time `hydrate()`, for surfaces
 * that mount many instances at once (every pipeline execution detail,
 * including each inline child execution). All holders share one IPC
 * listener; the last release removes it. Returns an idempotent release.
 */
export function retainAppAdvisorWatchersBridge(): () => void {
  const store = useAppAdvisorWatchersStore.getState();
  if (!retainedWatchersBridge) {
    retainedWatchersBridge = { refs: 0, unsubscribe: store.subscribeBridge() };
  }
  const bridge = retainedWatchersBridge;
  bridge.refs += 1;
  if (!store.hydrated && !store.loading) {
    void store.hydrate();
  }
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    bridge.refs -= 1;
    if (bridge.refs === 0 && retainedWatchersBridge === bridge) {
      retainedWatchersBridge = null;
      bridge.unsubscribe();
    }
  };
}
