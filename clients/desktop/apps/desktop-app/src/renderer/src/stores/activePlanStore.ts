import { create } from 'zustand';
import type { ChatActivePlanContext } from '@canopy/desktop-shared/types';
import { isSyntheticChatTarget } from './chat/surface';
import { planViewKey } from './planViewStore';

/**
 * Which tracked plan a worktree's chat turns should carry as their "active
 * plan" context, and how many mounted views (plan panel or split diagram
 * panel) are currently showing each plan. The full-window takeover does not
 * register: its chat is a sentinel scope that never carries plan context.
 *
 * A worktree's active plan is "last focus wins":
 * {@link ActivePlanState.markActive} moves it whenever a mounted, non-read-
 * only view becomes the one the user is looking at (pointer/focus, or
 * becoming the visible tab — see the renderer registration hook added in a
 * later sub-step). A plan can only become or stay active while at least one
 * view of it is mounted ({@link ActivePlanState.mountView} /
 * {@link ActivePlanState.unmountView}): the last view of a plan unmounting
 * clears both its viewed-revision marker and the worktree's active plan, if
 * it still points there. Read-only views never call `mountView`, so they
 * never register and can never become active.
 *
 * {@link captureActivePlanContext} is the read side: a composer send
 * captures the target worktree's active plan (plus the older revision on
 * screen, if the user has one open) to attach to the outgoing chat message.
 * It returns `undefined` for a missing scope and for the app-managed
 * sentinel scopes ({@link isSyntheticChatTarget} — cowork, App Advisor, plan
 * explore, code review, the pipeline editor) that never have tracked plans.
 */
export interface ActivePlanScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

export interface ActivePlanState {
  /** `${projectId}/${worktreeId}` -> that worktree's active plan id. */
  activeByWorktree: Record<string, string>;
  /** Plan view key -> number of views of that plan currently mounted. */
  viewCounts: Record<string, number>;
  /** Plan view key -> older revision on screen, while one is set. */
  viewedRevisions: Record<string, number>;
  /** Register one more mounted view of `planId` in `scope`. */
  mountView: (scope: ActivePlanScope, planId: string) => void;
  /**
   * Drop one mounted view of `planId` in `scope`. When no views of it
   * remain: drops its viewed-revision marker, and if `scope`'s active plan
   * is still `planId`, clears it.
   */
  unmountView: (scope: ActivePlanScope, planId: string) => void;
  /**
   * Make `planId` the active plan for `scope`. No-op, returning state
   * unchanged, when `planId` is already `scope`'s active plan or has no
   * mounted view.
   */
  markActive: (scope: ActivePlanScope, planId: string) => void;
  /**
   * Set the older revision currently on screen for `planId` in `scope`, or
   * clear it with `null`.
   */
  setViewedRevision: (
    scope: ActivePlanScope,
    planId: string,
    revisionNumber: number | null,
  ) => void;
}

function worktreeKey(scope: ActivePlanScope): string {
  return `${scope.projectId}/${scope.worktreeId}`;
}

function withoutKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export const useActivePlanStore = create<ActivePlanState>((set) => ({
  activeByWorktree: {},
  viewCounts: {},
  viewedRevisions: {},

  mountView: (scope, planId): void => {
    const key = planViewKey(scope.projectId, scope.worktreeId, planId);
    set((state) => ({
      viewCounts: {
        ...state.viewCounts,
        [key]: (state.viewCounts[key] ?? 0) + 1,
      },
    }));
  },

  unmountView: (scope, planId): void => {
    const key = planViewKey(scope.projectId, scope.worktreeId, planId);
    const wKey = worktreeKey(scope);
    set((state) => {
      const current = state.viewCounts[key] ?? 0;
      if (current <= 0) {
        return state;
      }
      if (current > 1) {
        return {
          viewCounts: { ...state.viewCounts, [key]: current - 1 },
        };
      }
      return {
        viewCounts: withoutKey(state.viewCounts, key),
        viewedRevisions: withoutKey(state.viewedRevisions, key),
        activeByWorktree:
          state.activeByWorktree[wKey] === planId
            ? withoutKey(state.activeByWorktree, wKey)
            : state.activeByWorktree,
      };
    });
  },

  markActive: (scope, planId): void => {
    const key = planViewKey(scope.projectId, scope.worktreeId, planId);
    const wKey = worktreeKey(scope);
    set((state) => {
      if (state.activeByWorktree[wKey] === planId) {
        return state;
      }
      if (!state.viewCounts[key]) {
        return state;
      }
      return {
        activeByWorktree: { ...state.activeByWorktree, [wKey]: planId },
      };
    });
  },

  setViewedRevision: (scope, planId, revisionNumber): void => {
    const key = planViewKey(scope.projectId, scope.worktreeId, planId);
    set((state) => {
      const current = state.viewedRevisions[key];
      if (revisionNumber === null) {
        return current === undefined
          ? state
          : { viewedRevisions: withoutKey(state.viewedRevisions, key) };
      }
      return current === revisionNumber
        ? state
        : {
            viewedRevisions: {
              ...state.viewedRevisions,
              [key]: revisionNumber,
            },
          };
    });
  },
}));

/**
 * The worktree's active plan, plus the viewed revision when the user has an
 * older one on screen, ready to attach to an outgoing chat message.
 * `undefined` for a missing scope, a worktree with no active plan, or an
 * app-managed sentinel scope ({@link isSyntheticChatTarget}) that never has
 * tracked plans.
 */
export function captureActivePlanContext(
  scope: ActivePlanScope | null | undefined,
): ChatActivePlanContext | undefined {
  if (!scope || isSyntheticChatTarget(scope.projectId, scope.worktreeId)) {
    return undefined;
  }
  const state = useActivePlanStore.getState();
  const planId = state.activeByWorktree[worktreeKey(scope)];
  if (!planId) {
    return undefined;
  }
  const key = planViewKey(scope.projectId, scope.worktreeId, planId);
  const viewedRevisionNumber = state.viewedRevisions[key];
  return viewedRevisionNumber === undefined
    ? { planId }
    : { planId, viewedRevisionNumber };
}

/** Clear every entry. Tests only. */
export function resetActivePlanStoreForTests(): void {
  useActivePlanStore.setState({
    activeByWorktree: {},
    viewCounts: {},
    viewedRevisions: {},
  });
}
