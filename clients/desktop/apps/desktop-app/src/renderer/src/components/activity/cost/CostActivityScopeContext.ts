import { createContext } from 'react';
import type { CostScopeStore } from '@canopy/app-state/cost';
import type { CostScopeRef, CostScopeView } from '@canopy/protocol/cost-view';

export interface CostActivityScopeValue {
  readonly scope: CostScopeRef;
  readonly store: CostScopeStore;
  readonly value: CostScopeView | null;
  readonly hasContent: boolean;
}

export const CostActivityScopeContext =
  createContext<CostActivityScopeValue | null>(null);
