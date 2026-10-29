import type { JSX } from 'react';
import type { CostScopeStore } from '@canopy/app-state/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { CostActivityPreview } from '@canopy/ui-app/cost';
import { DESKTOP_COST_NAVIGATOR } from '@/lib/cost/cost-navigator';
import { desktopCostClient } from '@/lib/cost/ipc-cost-client';

export interface CostActivityPreviewSectionProps {
  readonly scope: CostScopeRef;
  readonly store: CostScopeStore;
  readonly maxRows?: number;
  readonly expandedCard?: boolean;
}

/** Lazy desktop mount for the shared cost Activity preview. */
export function CostActivityPreviewSection({
  scope,
  store,
  maxRows,
  expandedCard = false,
}: CostActivityPreviewSectionProps): JSX.Element {
  const preview = (
    <CostActivityPreview
      client={desktopCostClient}
      navigator={DESKTOP_COST_NAVIGATOR}
      scope={scope}
      store={store}
      maxRows={maxRows}
    />
  );
  return expandedCard ? (
    <div data-testid="activity-card-cost-expanded">{preview}</div>
  ) : (
    preview
  );
}
