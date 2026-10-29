import { forwardRef, type JSX } from 'react';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';
import { DiagramChunkFallback } from './DiagramChunkFallback';
import type { PlanLogicDiffDiagramProps } from './PlanLogicDiffDiagramView';
import { usePlanDiagramViews } from './usePlanDiagramViews';

// React Flow (`@xyflow/react`) loads with the first diagram, not at startup.
export const PlanLogicDiffDiagram = forwardRef<
  DiagramSearchHandle,
  PlanLogicDiffDiagramProps
>(function PlanLogicDiffDiagram(props, ref): JSX.Element {
  const views = usePlanDiagramViews();
  return views ? (
    <views.PlanLogicDiffDiagram {...props} ref={ref} />
  ) : (
    <DiagramChunkFallback />
  );
});
