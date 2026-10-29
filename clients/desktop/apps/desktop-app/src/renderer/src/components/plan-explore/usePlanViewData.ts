import { useCallback, useEffect, useState } from 'react';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { hasVisiblePlanShare } from '@/components/shared/planShareLabel';
import { useActivityStore } from '@/stores/activityStore';
import { planViewKey } from '@/stores/planViewStore';

/** The current data behind a plan view, by the plan's exact identity. */
export type PlanViewData =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly plan: TrackedPlanData }
  | { readonly status: 'missing' }
  /** The direct fetch failed; `retry` fetches the plan again. */
  | { readonly status: 'error'; readonly retry: () => void };

const LOADING: PlanViewData = { status: 'loading' };
const MISSING: PlanViewData = { status: 'missing' };

/** What the last direct fetch reported for a target it could not load. */
interface PlanFetchFailure {
  readonly target: string;
  readonly status: 'missing' | 'error';
}

/**
 * Resolve a tracked plan for a view that is bound to it by id (a restored or
 * newly opened plan panel). Reads the worktree's tracked-plan list and, when
 * the plan is not there yet, fetches just that plan
 * (`ensureTrackedPlanLoaded`) without opening the takeover.
 *
 * The plan is `missing` only when the worktree's full inventory has loaded
 * without it, or a direct fetch reports it gone. A plan absent from a partial
 * list is still `loading`, because an unloaded plan is not evidence of
 * deletion. A fetch that fails is not evidence either: the view reports
 * `error` with a `retry` that fetches again, and settles by itself once the
 * inventory loads. Live updates flow in through the activity store, so a
 * plan that reappears returns to `ready`.
 */
export function usePlanViewData(
  scope: { readonly projectId: string; readonly worktreeId: string },
  planId: string,
): PlanViewData {
  const { projectId, worktreeId } = scope;
  const listKey = `${projectId}/${worktreeId}`;
  const targetKey = planViewKey(projectId, worktreeId, planId);
  const plan = useActivityStore(
    (state) =>
      state.trackedPlans[listKey]?.find((entry) => entry.id === planId) ?? null,
  );
  const inventoryLoaded = useActivityStore(
    (state) => state.trackedPlanInventoryLoaded[listKey] === true,
  );
  const ensureTrackedPlanLoaded = useActivityStore(
    (state) => state.ensureTrackedPlanLoaded,
  );
  const [failure, setFailure] = useState<PlanFetchFailure | null>(null);
  // Bumped by `retry` so the fetch runs again for the same target.
  const [attempt, setAttempt] = useState(0);
  const hasPlan = plan !== null;

  useEffect(() => {
    if (hasPlan || inventoryLoaded) {
      return;
    }
    let cancelled = false;
    const report = (status: PlanFetchFailure['status']): void => {
      if (!cancelled) {
        setFailure({ target: targetKey, status });
      }
    };
    void ensureTrackedPlanLoaded(projectId, worktreeId, planId).then(
      (loaded) => {
        if (!loaded) {
          report('missing');
        }
      },
      () => {
        report('error');
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [
    hasPlan,
    inventoryLoaded,
    ensureTrackedPlanLoaded,
    projectId,
    worktreeId,
    planId,
    targetKey,
    attempt,
  ]);

  const retry = useCallback((): void => {
    setFailure(null);
    setAttempt((current) => current + 1);
  }, []);

  if (plan) {
    return { status: 'ready', plan };
  }
  if (inventoryLoaded) {
    return MISSING;
  }
  if (failure?.target === targetKey) {
    return failure.status === 'missing' ? MISSING : { status: 'error', retry };
  }
  return LOADING;
}

/** Views holding a shared plan's comment pull, keyed by plan identity. */
const sharedPullHolders = new Map<string, number>();

/**
 * Pull a shared plan's latest web-authored comment threads when a view of it
 * opens (CAN-393). The merge emits `trackedPlansUpdated`, which flows the new
 * comments into the store. Pulls again when the plan becomes shared or a
 * different plan is shown, but not when only its comments change. Views of
 * one plan that are open together (a document and its split diagram, or a
 * panel beside the takeover) pull once. A failed pull is non-fatal: cached
 * comments stay readable and the next sync retries.
 */
export function useSharedPlanCommentPull(plan: TrackedPlanData | null): void {
  const isShared = plan !== null && hasVisiblePlanShare(plan);
  const projectId = plan?.projectId;
  const worktreeId = plan?.worktreeId;
  const planId = plan?.id;

  useEffect(() => {
    if (!isShared || !projectId || !worktreeId || !planId) {
      return;
    }
    const key = planViewKey(projectId, worktreeId, planId);
    const holders = sharedPullHolders.get(key) ?? 0;
    sharedPullHolders.set(key, holders + 1);
    if (holders === 0) {
      void window.api.activity.plans
        .refreshComments({ projectId, worktreeId, planId })
        .catch(() => {
          // Non-fatal: the comment pull retries on the next sync.
        });
    }
    return (): void => {
      const remaining = (sharedPullHolders.get(key) ?? 1) - 1;
      if (remaining > 0) {
        sharedPullHolders.set(key, remaining);
      } else {
        sharedPullHolders.delete(key);
      }
    };
  }, [isShared, projectId, worktreeId, planId]);
}
