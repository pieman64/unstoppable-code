import { create } from 'zustand';
import type { PlanCommentThread } from '@canopy/desktop-shared/types';
import type { DiagramNodeRevealRequest } from '@/components/plan-explore/PlanVisualizerPanel';

/**
 * Shared view state for one tracked plan, keyed by
 * `(projectId, worktreeId, planId)`. Every mounted view of a plan (a plan
 * panel, its split diagram panel, in any window) reads and writes the same
 * entry, so there is exactly one comment writer per plan and no cross-view
 * lost updates.
 *
 * The entry lives while at least one view, submit, or comment save holds it
 * ({@link PlanViewState.acquire} / {@link PlanViewState.release}). Persisted
 * comment threads from the activity store flow in through
 * {@link PlanViewState.syncPersistedThreads}; local edits go through
 * {@link PlanViewState.mutateThreads}, which updates the entry and saves. At
 * most one submit-to-chat runs per plan at a time
 * ({@link PlanViewState.beginSubmit} / {@link PlanViewState.endSubmit}).
 *
 * Saves are not sequenced, and main echoes each one back through
 * `trackedPlansUpdated`. While any save is in flight, persisted arrays are
 * held back rather than adopted, so the echo of an earlier save cannot drop an
 * edit staged after it. When the last save settles, the entry adopts the
 * persisted threads that save returned (else the newest array held back);
 * after a failed save it keeps its local threads instead. With no save in
 * flight, a persisted array (a teammate's comment) applies at once.
 */

/** Which inner tab a combined plan panel shows. */
export type PlanViewInnerTab = 'document' | 'diagram';

/** The diagram a node reveal targets. */
export type PlanDiagramKind = DiagramNodeRevealRequest['diagramKind'];

/** Identity of a tracked plan, used to persist comment mutations. */
export interface PlanViewTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly planId: string;
}

/** A persisted threads array held back while comment saves are in flight. */
export interface DeferredThreadsSource {
  readonly incoming: PlanCommentThread[] | undefined;
}

export interface PlanViewEntry {
  /** Mounted views, in-flight submits, and in-flight saves holding it. */
  refs: number;
  /**
   * Whether `threads` has been seeded from the persisted plan. A fresh entry
   * is unsynced until its first {@link PlanViewState.syncPersistedThreads}.
   */
  threadsSynced: boolean;
  /**
   * The persisted `plan.commentThreads` array last copied into `threads`, or
   * seen while a save was in flight. Syncing the same array again is a no-op,
   * so views that re-render with an unchanged plan never clobber local edits.
   */
  threadsSource: PlanCommentThread[] | undefined;
  /** Current comment threads, including local edits not yet echoed back. */
  threads: PlanCommentThread[];
  /** In-flight saves started by {@link PlanViewState.mutateThreads}. */
  pendingSaves: number;
  /**
   * The newest persisted array that arrived while saves were in flight, held
   * back until the last one settles; `null` when none arrived.
   */
  deferredSource: DeferredThreadsSource | null;
  /** Whether a save failed while the current saves were in flight. */
  saveFailed: boolean;
  /**
   * Whether a submit-to-chat of this plan's comments is in flight, from any
   * view. A second submit is refused until it settles, so one pending comment
   * is never handed to two chats.
   */
  submitting: boolean;
  innerTab: PlanViewInnerTab;
  /** Latest diagram-node reveal; `requestId` grows with every request. */
  diagramReveal: DiagramNodeRevealRequest | null;
}

export interface PlanViewState {
  entries: Record<string, PlanViewEntry>;
  /** Hold the entry for `key`, creating an empty unsynced one when absent. */
  acquire: (key: string) => void;
  /** Drop one hold; the entry is removed when no holds remain. */
  release: (key: string) => void;
  /**
   * Adopt the persisted threads when they differ from the array last synced.
   * While a comment save is in flight the array is held back instead, and
   * applied when the last save settles. No-op for an unknown key.
   */
  syncPersistedThreads: (
    key: string,
    incoming: PlanCommentThread[] | undefined,
  ) => void;
  /**
   * Apply `updater` to the entry's current threads, store the result, and save
   * it through `window.api.activity.plans.saveComments`, holding the entry
   * until the save settles. No-op (and no save) for an unknown or
   * not-yet-synced key, or when `updater` returns the same array, so a stale
   * or empty base can never be persisted over the plan's comments.
   */
  mutateThreads: (
    key: string,
    target: PlanViewTarget,
    updater: (current: PlanCommentThread[]) => PlanCommentThread[],
  ) => void;
  /**
   * Mark a submit-to-chat as in flight. Returns `false`, changing nothing,
   * for an unknown key or while another submit of the plan is in flight.
   */
  beginSubmit: (key: string) => boolean;
  /** Clear the in-flight submit mark. No-op for an unknown key. */
  endSubmit: (key: string) => void;
  /** Select a combined panel's inner tab. No-op for an unknown key. */
  setInnerTab: (key: string, tab: PlanViewInnerTab) => void;
  /** Ask the plan's diagram view to show a node. No-op for an unknown key. */
  requestDiagramReveal: (
    key: string,
    diagramKind: PlanDiagramKind,
    nodeId: string,
  ) => void;
}

/** Stable store key for a tracked plan's view state. */
export function planViewKey(
  projectId: string,
  worktreeId: string,
  planId: string,
): string {
  return JSON.stringify([projectId, worktreeId, planId]);
}

let lastDiagramRevealId = 0;

function createEntry(): PlanViewEntry {
  return {
    refs: 0,
    threadsSynced: false,
    threadsSource: undefined,
    threads: [],
    pendingSaves: 0,
    deferredSource: null,
    saveFailed: false,
    submitting: false,
    innerTab: 'document',
    diagramReveal: null,
  };
}

/**
 * How one comment save settled: `saved` carries the persisted threads the
 * save returned (`null` when it returned no plan).
 */
type CommentSaveOutcome =
  | { readonly status: 'saved'; readonly persisted: PlanCommentThread[] | null }
  | { readonly status: 'failed' };

/**
 * The entry after one of its saves settles and drops its hold, or `null` when
 * that was the last hold. While other saves are in flight only the counters
 * change. When the last one settles, every array held back meanwhile counts as
 * seen, and the threads catch up with the persisted state: the threads the
 * final save returned, else the newest array held back. Each save carries the
 * full list, so those include every edit made before it. After a failed save
 * the local threads stay as they are; the next edit saves them again.
 */
function settleCommentSave(
  entry: PlanViewEntry,
  outcome: CommentSaveOutcome,
): PlanViewEntry | null {
  if (entry.refs <= 1) {
    return null;
  }
  const refs = entry.refs - 1;
  const saveFailed = entry.saveFailed || outcome.status === 'failed';
  if (entry.pendingSaves > 1) {
    return {
      ...entry,
      refs,
      pendingSaves: entry.pendingSaves - 1,
      saveFailed,
    };
  }
  const deferred = entry.deferredSource;
  const settled: PlanViewEntry = {
    ...entry,
    refs,
    pendingSaves: 0,
    deferredSource: null,
    saveFailed: false,
    threadsSource: deferred === null ? entry.threadsSource : deferred.incoming,
  };
  if (saveFailed) {
    return settled;
  }
  if (outcome.status === 'saved' && outcome.persisted !== null) {
    return { ...settled, threads: outcome.persisted };
  }
  return deferred === null
    ? settled
    : { ...settled, threads: deferred.incoming ?? [] };
}

function withEntry(
  entries: Record<string, PlanViewEntry>,
  key: string,
  entry: PlanViewEntry,
): Record<string, PlanViewEntry> {
  return { ...entries, [key]: entry };
}

function withoutEntry(
  entries: Record<string, PlanViewEntry>,
  key: string,
): Record<string, PlanViewEntry> {
  const next = { ...entries };
  delete next[key];
  return next;
}

export const usePlanViewStore = create<PlanViewState>((set, get) => ({
  entries: {},

  acquire: (key): void => {
    set((state) => {
      const entry = state.entries[key] ?? createEntry();
      return {
        entries: withEntry(state.entries, key, {
          ...entry,
          refs: entry.refs + 1,
        }),
      };
    });
  },

  release: (key): void => {
    set((state) => {
      const entry = state.entries[key];
      if (!entry) {
        return state;
      }
      if (entry.refs <= 1) {
        return { entries: withoutEntry(state.entries, key) };
      }
      return {
        entries: withEntry(state.entries, key, {
          ...entry,
          refs: entry.refs - 1,
        }),
      };
    });
  },

  syncPersistedThreads: (key, incoming): void => {
    set((state) => {
      const entry = state.entries[key];
      if (!entry || (entry.threadsSynced && entry.threadsSource === incoming)) {
        return state;
      }
      if (entry.pendingSaves > 0) {
        // It may be the echo of an earlier save, without a newer edit.
        const deferred = entry.deferredSource;
        if (deferred !== null && deferred.incoming === incoming) {
          return state;
        }
        return {
          entries: withEntry(state.entries, key, {
            ...entry,
            deferredSource: { incoming },
          }),
        };
      }
      return {
        entries: withEntry(state.entries, key, {
          ...entry,
          threadsSynced: true,
          threadsSource: incoming,
          threads: incoming ?? [],
        }),
      };
    });
  },

  mutateThreads: (key, target, updater): void => {
    const entry = get().entries[key];
    if (!entry?.threadsSynced) {
      return;
    }
    const next = updater(entry.threads);
    if (next === entry.threads) {
      return;
    }
    set((state) => {
      const current = state.entries[key];
      return current
        ? {
            entries: withEntry(state.entries, key, {
              ...current,
              refs: current.refs + 1,
              pendingSaves: current.pendingSaves + 1,
              threads: next,
            }),
          }
        : state;
    });
    const settle = (outcome: CommentSaveOutcome): void => {
      set((state) => {
        const current = state.entries[key];
        if (!current) {
          return state;
        }
        const settled = settleCommentSave(current, outcome);
        return {
          entries:
            settled === null
              ? withoutEntry(state.entries, key)
              : withEntry(state.entries, key, settled),
        };
      });
    };
    const saved = window.api.activity.plans.saveComments({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      planId: target.planId,
      commentThreads: next,
    });
    void Promise.resolve(saved).then(
      (plan) => {
        settle({
          status: 'saved',
          persisted: plan ? (plan.commentThreads ?? []) : null,
        });
      },
      () => {
        // Non-fatal: the next edit saves the full list again, and the
        // persisted plan stays authoritative on the next refresh.
        settle({ status: 'failed' });
      },
    );
  },

  beginSubmit: (key): boolean => {
    const entry = get().entries[key];
    if (!entry || entry.submitting) {
      return false;
    }
    set((state) => {
      const current = state.entries[key];
      return current
        ? {
            entries: withEntry(state.entries, key, {
              ...current,
              submitting: true,
            }),
          }
        : state;
    });
    return true;
  },

  endSubmit: (key): void => {
    set((state) => {
      const entry = state.entries[key];
      if (!entry?.submitting) {
        return state;
      }
      return {
        entries: withEntry(state.entries, key, {
          ...entry,
          submitting: false,
        }),
      };
    });
  },

  setInnerTab: (key, tab): void => {
    set((state) => {
      const entry = state.entries[key];
      if (!entry || entry.innerTab === tab) {
        return state;
      }
      return {
        entries: withEntry(state.entries, key, { ...entry, innerTab: tab }),
      };
    });
  },

  requestDiagramReveal: (key, diagramKind, nodeId): void => {
    if (!get().entries[key]) {
      return;
    }
    lastDiagramRevealId += 1;
    const diagramReveal: DiagramNodeRevealRequest = {
      requestId: lastDiagramRevealId,
      diagramKind,
      nodeId,
    };
    set((state) => {
      const entry = state.entries[key];
      return entry
        ? {
            entries: withEntry(state.entries, key, { ...entry, diagramReveal }),
          }
        : state;
    });
  },
}));
