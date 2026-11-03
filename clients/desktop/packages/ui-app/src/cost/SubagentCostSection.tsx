'use client';

import type { JSX } from 'react';
import type { CostClient, CostNavigator } from '@canopy/app-core';
import type { CostSubagentValue, CostViewState } from '@canopy/app-state/cost';
import { useShallow } from 'zustand/react/shallow';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { SubagentCostDetails } from '@canopy/ui-shared/components/cost';
import { useCostInsightsEnabled } from './CostInsightsGate';
import { useCostSubagentStore } from './use-cost-view-store';
import { EmptyStateRow } from '@canopy/ui-shared/components';

export interface SubagentCostSectionProps {
  readonly client: CostClient;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  /** The root chat. */
  readonly chatId: string;
  readonly subagentId: string;
}

function SubagentCostSectionContent({
  client,
  navigator,
  scope,
  chatId,
  subagentId,
}: SubagentCostSectionProps): JSX.Element {
  const store = useCostSubagentStore(client, scope, chatId, subagentId);
  const { problem, value } = store(
    useShallow(
      (
        state: CostViewState<CostSubagentValue>,
      ): Pick<CostViewState<CostSubagentValue>, 'value' | 'problem'> => ({
        value: state.value,
        problem: state.problem,
      }),
    ),
  );

  if (value !== null) {
    return (
      <SubagentCostDetails
        item={value.item}
        onOpenSessionBreakdown={
          navigator.openSessionBreakdown
            ? (): void => navigator.openSessionBreakdown?.(scope, chatId)
            : undefined
        }
      />
    );
  }

  if (problem?.kind === 'error' && problem.reason === 'NOT_FOUND') {
    return <EmptyStateRow title="No cost recorded yet." />;
  }
  if (problem !== null) {
    return <p className="text-xs fg-tertiary">Couldn't load cost.</p>;
  }
  return <p className="text-xs fg-tertiary">Loading cost…</p>;
}

/** Reads and displays one subagent's cost while the cost capability is enabled. */
export function SubagentCostSection(
  props: SubagentCostSectionProps,
): JSX.Element | null {
  const enabled = useCostInsightsEnabled();
  if (!enabled) return null;
  return <SubagentCostSectionContent {...props} />;
}
