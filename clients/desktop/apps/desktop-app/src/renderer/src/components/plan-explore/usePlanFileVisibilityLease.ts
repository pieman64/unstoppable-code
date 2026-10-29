import { useEffect, useState } from 'react';

/** The tracked plan a view shows, in the worktree that owns it. */
export interface PlanFileVisibilityRef {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly planId: string;
}

function sendPlanFileVisibility(
  ref: PlanFileVisibilityRef,
  consumerId: string,
  visible: boolean,
): void {
  // Best effort: a lost lease only delays noticing an agent's edit to the
  // plan file until the next turn ends or another view leases it.
  window.api.activity.plans
    .setFileVisibility({ ...ref, consumerId, visible })
    .catch(() => undefined);
}

/**
 * Tell main this view is showing `ref`'s plan while `visible`, so the plan's
 * working file is checked for agent edits when the view appears and polled
 * while it stays on screen. The lease is released, under the same consumer
 * id, when the view hides, unmounts, or switches plans. Pass `null` for a view
 * that must not lease (read-only recipients, a plan that is not loaded).
 */
export function usePlanFileVisibilityLease(
  ref: PlanFileVisibilityRef | null,
  visible: boolean,
): void {
  const [consumerId] = useState(() => crypto.randomUUID());
  const projectId = ref?.projectId;
  const worktreeId = ref?.worktreeId;
  const planId = ref?.planId;

  useEffect(() => {
    if (
      !visible ||
      projectId === undefined ||
      worktreeId === undefined ||
      planId === undefined
    ) {
      return undefined;
    }
    const leased: PlanFileVisibilityRef = { projectId, worktreeId, planId };
    sendPlanFileVisibility(leased, consumerId, true);
    return (): void => {
      sendPlanFileVisibility(leased, consumerId, false);
    };
  }, [visible, projectId, worktreeId, planId, consumerId]);
}
