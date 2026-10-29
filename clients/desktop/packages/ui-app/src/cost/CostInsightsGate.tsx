'use client';

import type { JSX, ReactNode } from 'react';
import { useCapabilities } from '@canopy/app-state';
import { EmptyState } from '@canopy/ui-shared/components';

/** The copy a cost panel shows on a host that cannot read cost. */
export const COST_UNAVAILABLE_COPY = 'Cost is not available here.';

/**
 * What a cost panel shows when the host reports no `costInsights`
 * capability: it has no cost read path yet.
 */
export function CostUnavailableState(): JSX.Element {
  return (
    <EmptyState
      testId="cost-unavailable"
      title={COST_UNAVAILABLE_COPY}
      tone="quiet"
      titleWeight="normal"
    />
  );
}

/** True when the host can read observed cost. Default-deny. */
export function useCostInsightsEnabled(): boolean {
  return useCapabilities().costInsights === true;
}

export interface CostInsightsGateProps {
  readonly children: ReactNode;
  /**
   * Rendered when the capability is absent. Panels pass nothing and show the
   * unavailable state; embedded previews pass `null` to show nothing.
   */
  readonly fallback?: ReactNode;
}

/**
 * Gates a cost view on the host's `costInsights` capability rather than on
 * which host it runs in.
 */
export function CostInsightsGate({
  children,
  fallback,
}: CostInsightsGateProps): JSX.Element {
  const enabled = useCostInsightsEnabled();
  if (enabled) return <>{children}</>;
  return <>{fallback === undefined ? <CostUnavailableState /> : fallback}</>;
}
