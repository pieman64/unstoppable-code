import { createContext, useContext } from 'react';
import type { CostClient, CostNavigator } from '@canopy/app-core';
import type { PipelineRunCostStore } from '@canopy/app-state/cost';
import type {
  CostScopeRef,
  PipelineRunCostView,
} from '@canopy/protocol/cost-view';
import type {
  PipelineDetailsCostTarget,
  PipelineDetailsSelection,
} from './PipelineDetailsNav';

/** Cost read shared by the owned pipeline panel's related detail surfaces. */
export interface PipelineRunCostPanelValue {
  readonly client: CostClient;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  readonly executionId: string;
  readonly store: PipelineRunCostStore;
  readonly value: PipelineRunCostView | null;
  readonly status: 'idle' | 'loading' | 'ready' | 'problem';
}

export const PipelineRunCostPanelContext =
  createContext<PipelineRunCostPanelValue | null>(null);

export function isPipelineDetailsCostSelection(
  selection: PipelineDetailsSelection,
): selection is PipelineDetailsCostTarget {
  return (
    selection !== null && 'entry' in selection && selection.entry === 'cost'
  );
}

export function usePipelineRunCostPanel(): PipelineRunCostPanelValue | null {
  return useContext(PipelineRunCostPanelContext);
}
