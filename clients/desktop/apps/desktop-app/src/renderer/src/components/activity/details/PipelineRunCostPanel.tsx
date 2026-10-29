import { type JSX, type ReactNode } from 'react';
import type { CostClient, CostNavigator } from '@canopy/app-core';
import type { PipelineRunCostStore } from '@canopy/app-state/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { usePipelineRunCostStore } from '@canopy/ui-app/cost';
import { useStore } from 'zustand';
import { DESKTOP_COST_NAVIGATOR } from '@/lib/cost/cost-navigator';
import { desktopCostClient } from '@/lib/cost/ipc-cost-client';
import {
  PipelineRunCostPanelContext,
  type PipelineRunCostPanelValue,
} from './pipelineRunCostPanelContext';

export interface PipelineRunCostProviderProps {
  readonly scope: CostScopeRef;
  readonly executionId: string;
  readonly enabled?: boolean;
  readonly client?: CostClient;
  readonly navigator?: CostNavigator;
  /** Test seam; production panels use the cost view store hook. */
  readonly store?: PipelineRunCostStore;
  readonly children: ReactNode;
}

interface PipelineRunCostProviderContentProps {
  readonly client: CostClient;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  readonly executionId: string;
  readonly children: ReactNode;
}

/**
 * Supplies the single run-cost store to the job list, Summary preview,
 * breakdown and agent-step rows. `enabled` is checked before the store hook
 * mounts, so a disabled panel issues no cost read at all.
 */
export function PipelineRunCostProvider({
  scope,
  executionId,
  enabled = true,
  client = desktopCostClient,
  navigator = DESKTOP_COST_NAVIGATOR,
  store,
  children,
}: PipelineRunCostProviderProps): JSX.Element {
  if (!enabled) {
    return (
      <PipelineRunCostPanelContext.Provider value={null}>
        {children}
      </PipelineRunCostPanelContext.Provider>
    );
  }

  return store === undefined ? (
    <PipelineRunCostClientProvider
      client={client}
      navigator={navigator}
      scope={scope}
      executionId={executionId}
    >
      {children}
    </PipelineRunCostClientProvider>
  ) : (
    <PipelineRunCostStoreProvider
      client={client}
      navigator={navigator}
      scope={scope}
      executionId={executionId}
      store={store}
    >
      {children}
    </PipelineRunCostStoreProvider>
  );
}

function PipelineRunCostClientProvider({
  client,
  navigator,
  scope,
  executionId,
  children,
}: PipelineRunCostProviderContentProps): JSX.Element {
  const store = usePipelineRunCostStore(client, scope, executionId);
  return (
    <PipelineRunCostStoreProvider
      client={client}
      navigator={navigator}
      scope={scope}
      executionId={executionId}
      store={store}
    >
      {children}
    </PipelineRunCostStoreProvider>
  );
}

function PipelineRunCostStoreProvider({
  client,
  navigator,
  scope,
  executionId,
  store,
  children,
}: PipelineRunCostProviderContentProps & {
  readonly store: PipelineRunCostStore;
}): JSX.Element {
  const value = useStore(store, (state) => state.value);
  const status = useStore(store, (state) => state.status);
  const context: PipelineRunCostPanelValue = {
    client,
    navigator,
    scope,
    executionId,
    store,
    value,
    status,
  };
  return (
    <PipelineRunCostPanelContext.Provider value={context}>
      {children}
    </PipelineRunCostPanelContext.Provider>
  );
}
