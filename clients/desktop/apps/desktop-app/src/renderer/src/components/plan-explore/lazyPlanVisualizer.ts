import {
  createElement,
  forwardRef,
  lazy,
  useState,
  type LazyExoticComponent,
} from 'react';
import type { DiagramSearchHandle } from '@canopy/ui-app/find';
import type {
  PlanVisualizerPanel,
  PlanVisualizerPanelProps,
} from './PlanVisualizerPanel';

let loadedPanel: typeof PlanVisualizerPanel | null = null;
let loading: Promise<{ default: typeof PlanVisualizerPanel }> | null = null;

function loadPlanVisualizer(): Promise<{
  default: typeof PlanVisualizerPanel;
}> {
  loading ??= import('./PlanVisualizerPanel').then((module) => {
    loadedPanel = module.PlanVisualizerPanel;
    return { default: module.PlanVisualizerPanel };
  });
  return loading;
}

/**
 * The plan visualizer (React Flow and dagre diagrams), loaded only when a
 * plan panel shows a diagram. Refs forward to the loaded panel's
 * `DiagramSearchHandle` (`@canopy/ui-app/find`).
 */
export const LazyPlanVisualizerPanel: LazyExoticComponent<
  typeof PlanVisualizerPanel
> = lazy(loadPlanVisualizer);

/** Starts loading the visualizer code before a diagram is first shown. */
export function preloadPlanVisualizer(): Promise<void> {
  return loadPlanVisualizer().then(() => undefined);
}

/**
 * The visualizer for a diagram that mounts after its code may have loaded.
 * A lazy component suspends on its first render even when its code is
 * already loaded, and React then holds the diagram behind the Suspense
 * fallback for its ~300 ms reveal throttle. Loaded code renders directly
 * instead; the choice is fixed per mount so the panel never remounts.
 */
export const PlanVisualizer = forwardRef<
  DiagramSearchHandle,
  PlanVisualizerPanelProps
>(function PlanVisualizer(props, ref) {
  const [Panel] = useState(() => loadedPanel ?? LazyPlanVisualizerPanel);
  return createElement(Panel, { ...props, ref });
});
