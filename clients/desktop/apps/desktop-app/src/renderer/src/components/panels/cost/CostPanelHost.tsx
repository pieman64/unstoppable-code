import { useMemo, type JSX } from 'react';
import { useStore } from 'zustand';
import type { CostScopeStore } from '@canopy/app-state/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { CostScopeView, useCostScopeStore } from '@canopy/ui-app/cost';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { DESKTOP_COST_NAVIGATOR } from '@/lib/cost/cost-navigator';
import {
  costPanelUiState,
  costPanelUiStateKey,
} from '@/lib/cost/cost-panel-ui-state';
import { desktopCostClient } from '@/lib/cost/ipc-cost-client';

export interface CostPanelHostProps {
  readonly projectId: string;
  readonly worktreeId: string;
}

/** Reports the open Cost panel to App Advisor (see `costPanelUiState`). */
function CostPanelUiStateReporter({
  store,
  projectId,
  worktreeId,
}: {
  readonly store: CostScopeStore;
  readonly projectId: string;
  readonly worktreeId: string;
}): null {
  const status = useStore(store, (state) => state.status);
  const value = useStore(store, (state) => state.value);
  useCurrentUiStateReporter(
    costPanelUiStateKey(projectId, worktreeId),
    costPanelUiState(projectId, worktreeId, status, value),
  );
  return null;
}

function CostPanelBody({
  projectId,
  worktreeId,
}: CostPanelHostProps): JSX.Element {
  const scope = useMemo(
    (): CostScopeRef => ({ kind: 'entry', projectId, worktreeId }),
    [projectId, worktreeId],
  );
  const store = useCostScopeStore(desktopCostClient, scope);
  return (
    <>
      <CostPanelUiStateReporter
        store={store}
        projectId={projectId}
        worktreeId={worktreeId}
      />
      <CostScopeView
        client={desktopCostClient}
        navigator={DESKTOP_COST_NAVIGATOR}
        scope={scope}
        store={store}
      />
    </>
  );
}

/** The desktop Cost panel (panel kind `cost`) for the panel's own work scope. */
export function CostPanelHost({
  projectId,
  worktreeId,
}: CostPanelHostProps): JSX.Element {
  return (
    <div
      data-testid="cost-panel-host"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <CostPanelBody projectId={projectId} worktreeId={worktreeId} />
    </div>
  );
}
