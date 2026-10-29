import { useCallback, useEffect } from 'react';
import type { PlanFileVisibilityRef } from '@/components/plan-explore/usePlanFileVisibilityLease';
import { useActivePlanStore } from '@/stores/activePlanStore';

/**
 * Register a mounted plan view with the active-plan store, so the owning
 * worktree's composer sends can carry this plan as their active plan.
 *
 * The view counts as mounted while `ref` is set, and becomes the worktree's
 * active plan whenever `active` turns true (the view became its group's
 * visible, active tab). The returned callback marks it active on demand, for
 * pointer or focus inside the view; it is stable while `ref` names the same
 * plan. Pass `null` for a view that must never become active (read-only
 * recipients, a plan that is not loaded).
 */
export function useActivePlanRegistration(
  ref: PlanFileVisibilityRef | null,
  active: boolean,
): () => void {
  const projectId = ref?.projectId;
  const worktreeId = ref?.worktreeId;
  const planId = ref?.planId;

  useEffect(() => {
    if (
      projectId === undefined ||
      worktreeId === undefined ||
      planId === undefined
    ) {
      return undefined;
    }
    const scope = { projectId, worktreeId };
    useActivePlanStore.getState().mountView(scope, planId);
    return (): void => {
      useActivePlanStore.getState().unmountView(scope, planId);
    };
  }, [projectId, worktreeId, planId]);

  const markActive = useCallback((): void => {
    if (
      projectId === undefined ||
      worktreeId === undefined ||
      planId === undefined
    ) {
      return;
    }
    useActivePlanStore.getState().markActive({ projectId, worktreeId }, planId);
  }, [projectId, worktreeId, planId]);

  // Declared after the mount effect so a view that mounts already active is
  // registered before it is marked (marking an unmounted plan is a no-op).
  useEffect(() => {
    if (active) {
      markActive();
    }
  }, [active, markActive]);

  return markActive;
}
