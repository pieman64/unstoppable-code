import { forwardRef, type JSX } from 'react';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';
import { DiagramChunkFallback } from './DiagramChunkFallback';
import type { PlanDataModelDiffDiagramProps } from './PlanDataModelDiffDiagramView';
import { usePlanDiagramViews } from './usePlanDiagramViews';

// React Flow (`@xyflow/react`) loads with the first diagram, not at startup.
export const PlanDataModelDiffDiagram = forwardRef<
  DiagramSearchHandle,
  PlanDataModelDiffDiagramProps
>(function PlanDataModelDiffDiagram(props, ref): JSX.Element {
  const views = usePlanDiagramViews();
  return views ? (
    <views.PlanDataModelDiffDiagram {...props} ref={ref} />
  ) : (
    <DiagramChunkFallback />
  );
});
