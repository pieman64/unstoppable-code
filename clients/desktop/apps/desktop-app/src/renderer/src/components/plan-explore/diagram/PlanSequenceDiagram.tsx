import { forwardRef, type JSX } from 'react';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';
import { DiagramChunkFallback } from './DiagramChunkFallback';
import type { PlanSequenceDiagramProps } from './PlanSequenceDiagramView';
import { usePlanDiagramViews } from './usePlanDiagramViews';

// React Flow (`@xyflow/react`) loads with the first diagram, not at startup.
export const PlanSequenceDiagram = forwardRef<
  DiagramSearchHandle,
  PlanSequenceDiagramProps
>(function PlanSequenceDiagram(props, ref): JSX.Element {
  const views = usePlanDiagramViews();
  return views ? (
    <views.PlanSequenceDiagram {...props} ref={ref} />
  ) : (
    <DiagramChunkFallback />
  );
});
