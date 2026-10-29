import type { JSX } from 'react';
import type { CostScopeStore } from '@canopy/app-state/cost';
import {
  CostScopeRefreshAction,
  CostScopeTotalLabel,
} from '@canopy/ui-app/cost';

export function CostActivityTotalLabel({
  store,
}: {
  readonly store: CostScopeStore;
}): JSX.Element | null {
  return <CostScopeTotalLabel store={store} />;
}

export function CostActivityRefreshAction({
  store,
}: {
  readonly store: CostScopeStore;
}): JSX.Element {
  return <CostScopeRefreshAction store={store} />;
}
