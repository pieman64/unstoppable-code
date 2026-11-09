'use client';

import { useState, type JSX } from 'react';
import { Surface } from '@canopy/ui-shared/components';
import type { CostClient, CostNavigator } from '@canopy/app-core';
import type { CostScopeStore } from '@canopy/app-state/cost';
import type {
  CostScopeRef,
  CostScopeView as CostScopeViewValue,
} from '@canopy/protocol/cost-view';
import {
  CostUnavailableState,
  useCostInsightsEnabled,
} from './CostInsightsGate';
import { CostScopeView } from './CostScopeView';
import { PipelineRunCostView } from './PipelineRunCostView';
import { SessionBreakdownView } from './SessionBreakdownView';
import {
  sortCostChats,
  sortCostRuns,
  type CostScopeRowTarget,
} from './cost-scope-model';
import { useCostScopeStore } from './use-cost-view-store';

export interface RetainedCostViewProps {
  readonly client: CostClient;
  /**
   * Opens subagents and pipeline jobs from the breakdown on the right. Rows
   * in the list never navigate; they choose what the right side shows.
   */
  readonly navigator: CostNavigator;
  /** The archived or deleted entry. */
  readonly scope: CostScopeRef;
  /** The chosen row, for a host that keeps it; otherwise the view keeps it. */
  readonly selectedRow?: CostScopeRowTarget | null;
  readonly onSelectRow?: (target: CostScopeRowTarget) => void;
  readonly now?: number;
  /** The host's app name, passed on to the chat breakdown's Top tools. */
  readonly appName?: string;
}

/** The most expensive chat, else the most expensive run: what opens first. */
export function defaultRetainedCostRow(
  view: CostScopeViewValue | null,
): CostScopeRowTarget | null {
  if (view === null) return null;
  const chat = sortCostChats(view.chats, 'cost', true)[0];
  if (chat !== undefined) return { kind: 'chat', chatId: chat.chatId };
  const run = sortCostRuns(view.pipelineRuns, 'cost')[0];
  if (run !== undefined) {
    return { kind: 'pipeline-run', executionId: run.executionId };
  }
  return null;
}

function RetainedCostDetail({
  client,
  navigator,
  scope,
  target,
  now,
  appName,
}: {
  readonly client: CostClient;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  readonly target: CostScopeRowTarget;
  readonly now?: number;
  readonly appName?: string;
}): JSX.Element {
  if (target.kind === 'chat') {
    return (
      <SessionBreakdownView
        key={`chat:${target.chatId}`}
        client={client}
        navigator={navigator}
        scope={scope}
        chatId={target.chatId}
        sealed
        {...(now === undefined ? {} : { now })}
        {...(appName === undefined ? {} : { appName })}
      />
    );
  }
  return (
    <div className="h-full min-h-0 overflow-y-auto p-3">
      <PipelineRunCostView
        key={`run:${target.executionId}`}
        client={client}
        navigator={navigator}
        scope={scope}
        executionId={target.executionId}
        sealed
        {...(now === undefined ? {} : { now })}
      />
    </div>
  );
}

function RetainedCostLayout({
  client,
  navigator,
  scope,
  selectedRow,
  onSelectRow,
  now,
  appName,
  store,
}: RetainedCostViewProps & { readonly store: CostScopeStore }): JSX.Element {
  const [ownSelection, setOwnSelection] = useState<CostScopeRowTarget | null>(
    null,
  );
  const value = store((state) => state.value);
  const chosen =
    selectedRow !== undefined && selectedRow !== null
      ? selectedRow
      : (ownSelection ?? defaultRetainedCostRow(value));
  const select = (target: CostScopeRowTarget): void => {
    setOwnSelection(target);
    onSelectRow?.(target);
  };

  return (
    <Surface
      variant="pane"
      extent="parent"
      data-testid="retained-cost-view"
      className="flex min-h-0 w-full"
    >
      <Surface
        variant="section"
        boundary="right"
        extent="parent"
        data-testid="retained-cost-list"
        className="flex min-h-0 w-96 shrink-0 flex-col"
      >
        <CostScopeView
          client={client}
          navigator={navigator}
          scope={scope}
          store={store}
          sealed
          selectedRow={chosen}
          onSelectRow={select}
          {...(now === undefined ? {} : { now })}
        />
      </Surface>
      <div
        data-testid="retained-cost-detail"
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      >
        {chosen === null ? null : (
          <RetainedCostDetail
            client={client}
            navigator={navigator}
            scope={scope}
            target={chosen}
            {...(now === undefined ? {} : { now })}
            {...(appName === undefined ? {} : { appName })}
          />
        )}
      </div>
    </Surface>
  );
}

function OwnedRetainedCostView(props: RetainedCostViewProps): JSX.Element {
  const store = useCostScopeStore(props.client, props.scope);
  return <RetainedCostLayout {...props} store={store} />;
}

/**
 * The archived viewer's Cost tab: the entry's sealed Cost list in a 384 px
 * column, and the chosen chat's Session breakdown or run's cost on the
 * right at a reading measure. Nothing refreshes and nothing runs; the
 * chosen row carries `aria-current`.
 */
export function RetainedCostView(props: RetainedCostViewProps): JSX.Element {
  const enabled = useCostInsightsEnabled();
  if (!enabled) return <CostUnavailableState />;
  return <OwnedRetainedCostView {...props} />;
}
