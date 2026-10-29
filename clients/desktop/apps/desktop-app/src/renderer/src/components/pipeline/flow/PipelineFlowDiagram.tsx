import { lazy, Suspense, type ComponentProps, type JSX } from 'react';
import type { PipelineFlowDiagram as PipelineFlowDiagramView } from './PipelineFlowDiagramView';

export type {
  PipelineFlowSelection,
  PipelineFlowSource,
} from './PipelineFlowDiagramView';

// React Flow (`@xyflow/react`) loads with the first pipeline diagram, not at
// startup. The diagram fills its container, which stays empty meanwhile.
const LazyPipelineFlowDiagram = lazy(() =>
  import('./PipelineFlowDiagramView').then((module) => ({
    default: module.PipelineFlowDiagram,
  })),
);

export function PipelineFlowDiagram(
  props: ComponentProps<typeof PipelineFlowDiagramView>,
): JSX.Element {
  return (
    <Suspense fallback={null}>
      <LazyPipelineFlowDiagram {...props} />
    </Suspense>
  );
}
