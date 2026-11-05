/**
 * Renderer mirror of main's per-chat managed delegation activity.
 *
 * A root chat "has live delegates" while any delegation in its tree is
 * queued, starting or running (`live + queued > 0`), even after the parent
 * turn ended. Tabs, closing, auto-archive and the sidebar read this store to
 * keep such a chat open and shown as working.
 *
 * Deliberately separate from `tab.status`: session restore closes streaming
 * tabs that main does not report as active, and `verifyStreamingTabs`
 * downgrades them to idle, either of which would drop the close guard while a
 * delegate is still running.
 *
 * Hydrated from `window.api.managedDelegation.listActivity()` and kept current
 * by `onActivityChanged`; main emits every aggregate change, including the
 * change to 0/0, which removes the chat's entry here.
 */
import { create } from 'zustand';
import type { ChatDelegationActivity } from '@canopy/desktop-shared/types';

/** One chat's live delegation counts. Only chats with work are stored. */
export interface ChatDelegationActivityEntry {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  /** Slot holders: starting or running. */
  readonly live: number;
  /** Waiting for a slot. */
  readonly queued: number;
}

/** A chat identity whose delegates just finished (its count reached 0/0). */
export interface ChatDelegationTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

export interface DelegationActivityState {
  /** Keyed by {@link chatDelegationKey}; entries always have work. */
  byChat: Readonly<Record<string, ChatDelegationActivityEntry>>;
  /** Whether the first `listActivity()` snapshot has been applied. */
  hydrated: boolean;
  /** Replace every entry with main's snapshot. */
  hydrate: (activities: readonly ChatDelegationActivity[]) => void;
  /** Apply one chat's absolute aggregate (0/0 removes the entry). */
  applyActivity: (activity: ChatDelegationActivity) => void;
  /** Forget every entry (tests and teardown). */
  reset: () => void;
}

/** The store key for one chat: `${projectId}/${worktreeId}/${chatId}`. */
export function chatDelegationKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}/${worktreeId}/${chatId}`;
}

function hasWork(counts: { live: number; queued: number }): boolean {
  return counts.live + counts.queued > 0;
}

function toEntry(
  activity: ChatDelegationActivity,
): ChatDelegationActivityEntry {
  return {
    projectId: activity.projectId,
    worktreeId: activity.worktreeId,
    chatId: activity.chatId,
    live: Math.max(0, activity.live),
    queued: Math.max(0, activity.queued),
  };
}

type SettledListener = (target: ChatDelegationTarget) => void;
const settledListeners = new Set<SettledListener>();

function notifySettled(targets: readonly ChatDelegationTarget[]): void {
  for (const target of targets) {
    settledListeners.forEach((listener: SettledListener): void => {
      try {
        listener(target);
      } catch {
        // One listener's failure must not starve the others.
      }
    });
  }
}

/**
 * Subscribe to chats whose delegates just finished: their aggregate went from
 * `live + queued > 0` to zero (an event or a fresh snapshot without them).
 */
export function subscribeChatDelegatesSettled(
  listener: SettledListener,
): () => void {
  settledListeners.add(listener);
  return (): void => {
    settledListeners.delete(listener);
  };
}

export const useDelegationActivityStore = create<DelegationActivityState>(
  (set, get) => ({
    byChat: {},
    hydrated: false,
    hydrate: (activities): void => {
      const previous = get().byChat;
      const next: Record<string, ChatDelegationActivityEntry> = {};
      for (const activity of activities) {
        if (!hasWork(activity)) continue;
        next[
          chatDelegationKey(
            activity.projectId,
            activity.worktreeId,
            activity.chatId,
          )
        ] = toEntry(activity);
      }
      const settled = Object.entries(previous)
        .filter(([key]) => next[key] === undefined)
        .map(([, entry]) => ({
          projectId: entry.projectId,
          worktreeId: entry.worktreeId,
          chatId: entry.chatId,
        }));
      set({ byChat: next, hydrated: true });
      notifySettled(settled);
    },
    applyActivity: (activity): void => {
      const key = chatDelegationKey(
        activity.projectId,
        activity.worktreeId,
        activity.chatId,
      );
      const previous = get().byChat[key];
      if (!hasWork(activity)) {
        if (previous === undefined) return;
        const next = { ...get().byChat };
        delete next[key];
        set({ byChat: next });
        notifySettled([
          {
            projectId: activity.projectId,
            worktreeId: activity.worktreeId,
            chatId: activity.chatId,
          },
        ]);
        return;
      }
      if (
        previous !== undefined &&
        previous.live === activity.live &&
        previous.queued === activity.queued
      ) {
        return;
      }
      set({ byChat: { ...get().byChat, [key]: toEntry(activity) } });
    },
    reset: (): void => {
      set({ byChat: {}, hydrated: false });
    },
  }),
);

/** Whether this chat has any queued, starting or running delegation. */
export function selectChatHasLiveDelegates(
  state: DelegationActivityState,
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  const entry = state.byChat[chatDelegationKey(projectId, worktreeId, chatId)];
  return entry !== undefined && hasWork(entry);
}

/** Whether any chat in this worktree (or Cowork Work Entry) has live delegates. */
export function selectWorktreeHasLiveDelegates(
  state: DelegationActivityState,
  projectId: string,
  worktreeId: string,
): boolean {
  for (const entry of Object.values(state.byChat)) {
    if (
      entry.projectId === projectId &&
      entry.worktreeId === worktreeId &&
      hasWork(entry)
    ) {
      return true;
    }
  }
  return false;
}

/** Queued and live delegations per worktree (or Work Entry) of a project. */
export function selectDelegationCountsByWorktree(
  state: DelegationActivityState,
  projectId: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of Object.values(state.byChat)) {
    if (entry.projectId !== projectId || !hasWork(entry)) continue;
    counts[entry.worktreeId] =
      (counts[entry.worktreeId] ?? 0) + entry.live + entry.queued;
  }
  return counts;
}

/** Non-reactive read of {@link selectChatHasLiveDelegates}. */
export function chatHasLiveDelegates(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return selectChatHasLiveDelegates(
    useDelegationActivityStore.getState(),
    projectId,
    worktreeId,
    chatId,
  );
}

let disposeInitialization: (() => void) | null = null;

/**
 * Hydrate the store from main and keep it current. Idempotent; returns a
 * disposer. Events that arrive while the snapshot is loading are replayed on
 * top of it (each event is an absolute per-chat aggregate, so replay is
 * safe). A renderer without the bridge (tests, older preload) is a no-op.
 */
export function initializeDelegationActivityStore(): () => void {
  if (disposeInitialization !== null) {
    return disposeInitialization;
  }
  const api =
    typeof window === 'undefined' ? undefined : window.api?.managedDelegation;
  if (
    api === undefined ||
    typeof api.listActivity !== 'function' ||
    typeof api.onActivityChanged !== 'function'
  ) {
    return (): void => {};
  }

  let disposed = false;
  let snapshotApplied = false;
  const buffered: ChatDelegationActivity[] = [];
  const unsubscribe = api.onActivityChanged((activity): void => {
    if (disposed) return;
    if (!snapshotApplied) {
      buffered.push(activity);
      return;
    }
    useDelegationActivityStore.getState().applyActivity(activity);
  });

  const applySnapshot = (
    activities: readonly ChatDelegationActivity[],
  ): void => {
    if (disposed) return;
    const store = useDelegationActivityStore.getState();
    store.hydrate(activities);
    snapshotApplied = true;
    for (const activity of buffered.splice(0)) {
      store.applyActivity(activity);
    }
  };

  void api
    .listActivity()
    .then(applySnapshot)
    .catch((): void => {
      // Degrade to live events only: nothing is known to be running, and
      // each later change arrives as an absolute aggregate.
      applySnapshot([]);
    });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    buffered.length = 0;
    if (disposeInitialization === dispose) {
      disposeInitialization = null;
    }
  };
  disposeInitialization = dispose;
  return dispose;
}
