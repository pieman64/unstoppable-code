import { lazy, Suspense, useMemo, type JSX } from 'react';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { useCostScopeStore } from '@canopy/ui-app/cost';
import { desktopCostClient } from '@/lib/cost/ipc-cost-client';

const LazyCostActivityPreviewSection = lazy(() =>
  import('./CostActivityPreviewSection').then((module) => ({
    default: module.CostActivityPreviewSection,
  })),
);

/** Standalone registry body; the shared rail supplies its own shared store. */
export function CostActivitySection({
  projectId,
  worktreeId,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
}): JSX.Element {
  const scope = useMemo<CostScopeRef>(
    () => ({ kind: 'entry', projectId, worktreeId }),
    [projectId, worktreeId],
  );
  const store = useCostScopeStore(desktopCostClient, scope);
  return (
    <Suspense fallback={null}>
      <LazyCostActivityPreviewSection scope={scope} store={store} />
    </Suspense>
  );
}
