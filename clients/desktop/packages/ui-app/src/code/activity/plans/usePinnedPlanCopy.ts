import { useEffect, useState } from 'react';
import { useOptionalCanopyClient } from '@canopy/app-state';
import {
  planCopyStateFromMarkdown,
  type PlanCopyState,
} from '@canopy/ui-shared/components';

/** One stored revision of a tracked plan. */
export interface PinnedPlanTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly planId: string;
  readonly revisionNumber: number;
}

type Loaded = {
  readonly key: string;
  readonly client: ReturnType<typeof useOptionalCanopyClient>;
  readonly state: PlanCopyState;
};

function targetKey(target: PinnedPlanTarget): string {
  return JSON.stringify([
    target.projectId,
    target.worktreeId,
    target.planId,
    target.revisionNumber,
  ]);
}

/**
 * Copy plan for one exact plan revision, such as the proposal a plan prompt
 * asks about (CAN-5354). Reads that revision's full Markdown through the
 * host's `plan.get`, pinned by `revisionNumber`, so a truncated transcript or
 * a newer revision is never copied in its place. A changed target discards
 * the previous result and any read still in flight.
 */
export function usePinnedPlanCopy(
  target: PinnedPlanTarget | null,
): PlanCopyState | undefined {
  const client = useOptionalCanopyClient();
  const key = target === null ? null : targetKey(target);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect((): (() => void) | undefined => {
    if (target === null || key === null || client === null) return undefined;
    let current = true;
    client
      .query('plan.get', {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        planId: target.planId,
        revisionNumber: target.revisionNumber,
      })
      .then(
        (plan): void => {
          if (!current) return;
          const matches =
            plan.workspaceLocalId === target.projectId &&
            plan.worktreeLocalId === target.worktreeId &&
            plan.planId === target.planId &&
            plan.revisionNumber === target.revisionNumber;
          setLoaded({
            key,
            client,
            state: planCopyStateFromMarkdown(matches ? plan.content : null),
          });
        },
        (): void => {
          if (current) {
            setLoaded({ key, client, state: planCopyStateFromMarkdown(null) });
          }
        },
      );
    return (): void => {
      current = false;
    };
    // `key` carries every field of `target`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  if (target === null) return undefined;
  if (client === null) return planCopyStateFromMarkdown(null);
  return loaded?.key === key && loaded.client === client
    ? loaded.state
    : planCopyStateFromMarkdown(null, { loading: true });
}
