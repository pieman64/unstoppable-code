'use client';

import { useStore } from 'zustand';
import type { CostClient, CostNavigator } from '@canopy/app-core';
import type { SessionBreakdownStore } from '@canopy/app-state/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import type { JSX } from 'react';
import {
  CostUnavailableState,
  useCostInsightsEnabled,
} from './CostInsightsGate';
import { CostViewFrame, costRefreshFailureReason } from './CostViewFrame';
import { useSessionBreakdownStore } from './use-cost-view-store';
import {
  SessionBreakdownContent,
  type SessionBreakdownTab,
} from './session-breakdown/SessionBreakdownContent';

export type { SessionBreakdownTab } from './session-breakdown/SessionBreakdownContent';

export interface SessionBreakdownViewProps {
  readonly client: CostClient;
  readonly navigator: CostNavigator;
  readonly scope: CostScopeRef;
  readonly chatId: string;
  /** Retained entries: final figures only. Defaults to a retained scope. */
  readonly sealed?: boolean;
  readonly initialTab?: SessionBreakdownTab;
  readonly store?: SessionBreakdownStore;
  readonly now?: number;
  /**
   * The host's app name. Top tools lists the app's own tools under it; a
   * host that passes none gets a neutral label.
   */
  readonly appName?: string;
}

/** A capability-gated, shared breakdown of one chat's cost and usage. */
export function SessionBreakdownView(
  props: SessionBreakdownViewProps,
): JSX.Element {
  const enabled = useCostInsightsEnabled();
  if (!enabled) return <CostUnavailableState />;

  return <SessionBreakdownStoreView {...props} />;
}

function SessionBreakdownStoreView(
  props: SessionBreakdownViewProps,
): JSX.Element {
  const sealed = props.sealed ?? props.scope.kind === 'retained';
  if (props.store !== undefined) {
    return (
      <SessionBreakdownWithStore
        {...props}
        sealed={sealed}
        store={props.store}
      />
    );
  }
  return <SessionBreakdownWithManagedStore {...props} sealed={sealed} />;
}

interface StoreViewProps extends SessionBreakdownViewProps {
  readonly sealed: boolean;
  readonly store: SessionBreakdownStore;
}

function SessionBreakdownWithManagedStore(
  props: SessionBreakdownViewProps & { readonly sealed: boolean },
): JSX.Element {
  const store = useSessionBreakdownStore(
    props.client,
    props.scope,
    props.chatId,
  );
  return <SessionBreakdownWithStore {...props} store={store} />;
}

function SessionBreakdownWithStore({
  navigator,
  scope,
  chatId,
  sealed,
  initialTab = 'cost',
  store,
  now,
  appName,
}: StoreViewProps): JSX.Element {
  const state = useStore(store, (current) => current);
  const retry = (): void => {
    void store.getState().load();
  };
  const onRefresh = (): void => {
    void store.getState().requestRefresh('manual');
  };

  return (
    <CostViewFrame
      value={state.value}
      status={state.status}
      problem={state.problem}
      onRetry={retry}
      testId="session-breakdown-view"
    >
      {(view) => (
        <SessionBreakdownContent
          view={view}
          navigator={navigator}
          scope={scope}
          chatId={chatId}
          sealed={sealed}
          initialTab={initialTab}
          updatedAt={state.updatedAt}
          refreshing={state.refresh.status === 'refreshing'}
          refreshProblemMessage={costRefreshFailureReason(
            state.refresh.problem,
          )}
          completedRefreshes={state.refresh.completedManual}
          onRefresh={onRefresh}
          now={now}
          appName={appName}
        />
      )}
    </CostViewFrame>
  );
}
