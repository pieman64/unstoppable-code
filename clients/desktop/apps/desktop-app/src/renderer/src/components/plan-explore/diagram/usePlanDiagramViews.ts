import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PlanDataModelDiffDiagram } from './PlanDataModelDiffDiagramView';
import type { PlanLogicDiffDiagram } from './PlanLogicDiffDiagramView';
import type { PlanSequenceDiagram } from './PlanSequenceDiagramView';

/** The React Flow plan diagram implementations, once their code has loaded. */
export interface PlanDiagramViews {
  PlanSequenceDiagram: typeof PlanSequenceDiagram;
  PlanLogicDiffDiagram: typeof PlanLogicDiffDiagram;
  PlanDataModelDiffDiagram: typeof PlanDataModelDiffDiagram;
}

let loadedViews: PlanDiagramViews | null = null;
let pendingLoad: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PlanDiagramViews | null {
  return loadedViews;
}

/**
 * Loads all three plan diagram kinds together (React Flow, `@xyflow/react`,
 * loads with the first diagram, not at startup), so switching diagram tabs
 * afterwards renders synchronously, as it did before the split.
 */
function loadPlanDiagramViews(): Promise<void> {
  pendingLoad ??= Promise.all([
    import('./PlanSequenceDiagramView'),
    import('./PlanLogicDiffDiagramView'),
    import('./PlanDataModelDiffDiagramView'),
  ]).then(
    ([sequence, logicDiff, dataModel]) => {
      loadedViews = {
        PlanSequenceDiagram: sequence.PlanSequenceDiagram,
        PlanLogicDiffDiagram: logicDiff.PlanLogicDiffDiagram,
        PlanDataModelDiffDiagram: dataModel.PlanDataModelDiffDiagram,
      };
      for (const listener of Array.from(listeners)) {
        listener();
      }
    },
    (error: unknown) => {
      // Let a later mount retry a failed chunk load.
      pendingLoad = null;
      throw error;
    },
  );
  return pendingLoad;
}

/**
 * The plan diagram implementations, or null while their code loads.
 *
 * Every caller reads one shared store, so the render that receives the loaded
 * code mounts the diagram and attaches its handle in the same commit. Panels
 * that drive a diagram through its handle (reveal, search) gate their effects
 * on this value: the effects run again once the handle exists instead of
 * calling a handle that is not attached yet. A failed load reaches the
 * nearest error boundary, as a failed `React.lazy` import does.
 */
export function usePlanDiagramViews(): PlanDiagramViews | null {
  const views = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    if (views) {
      return undefined;
    }
    let mounted = true;
    loadPlanDiagramViews().catch((error: unknown) => {
      if (mounted) {
        setLoadError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return (): void => {
      mounted = false;
    };
  }, [views]);

  if (loadError) {
    throw loadError;
  }
  return views;
}
