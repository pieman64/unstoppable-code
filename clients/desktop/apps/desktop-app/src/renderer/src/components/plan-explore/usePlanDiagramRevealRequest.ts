import { useEffect, useState } from 'react';
import type { DiagramNodeRevealRequest } from './PlanVisualizerPanel';
import { usePlanViewStore } from '@/stores/planViewStore';

/**
 * The diagram-node reveal a plan view's diagram should apply, or `null`.
 *
 * Reveal requests live in the shared plan view entry, so a diagram that
 * mounts later would otherwise replay the last one. Only requests made while
 * this view's diagram is shown, or made just before it is shown (a comment's
 * diagram jump switches the inner tab and asks for the node together), are
 * returned; requests that predate the view, or that were already applied
 * before the diagram was hidden, are not.
 */
export function usePlanDiagramRevealRequest(
  viewKey: string,
  shown: boolean,
): DiagramNodeRevealRequest | null {
  const request = usePlanViewStore(
    (state) => state.entries[viewKey]?.diagramReveal ?? null,
  );
  const latestId = request?.requestId ?? 0;
  const [appliedThrough, setAppliedThrough] = useState(latestId);

  useEffect(() => {
    if (!shown) {
      setAppliedThrough(latestId);
    }
  }, [shown, latestId]);

  return shown && request !== null && request.requestId > appliedThrough
    ? request
    : null;
}
