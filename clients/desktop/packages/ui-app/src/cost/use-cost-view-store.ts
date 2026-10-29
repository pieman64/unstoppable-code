'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { CostClient } from '@canopy/app-core';
import {
  createCostChatSummaryStore,
  createCostScopeStore,
  createCostSubagentStore,
  createPipelineRunCostStore,
  createSessionBreakdownStore,
  type CostChatSummaryStore,
  type CostScopeStore,
  type CostSubagentStore,
  type CostViewStore,
  type PipelineRunCostStore,
  type SessionBreakdownStore,
} from '@canopy/app-state/cost';
import { costScopeKey, type CostScopeRef } from '@canopy/protocol/cost-view';

interface PendingDisposal {
  cancelled: boolean;
}

function useCostViewStoreInternal<Value>(
  client: CostClient,
  key: string,
  createStore: () => CostViewStore<Value>,
  enabled: boolean,
): CostViewStore<Value> {
  // The factory's identity is not a key; callers commonly pass an inline
  // closure, and `key` carries every value that changes the store's target.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => createStore(), [client, key]);
  const pendingDisposals = useRef(
    new WeakMap<CostViewStore<Value>, PendingDisposal>(),
  );
  const disposalMap = pendingDisposals.current;

  useEffect(() => {
    if (!enabled) return;
    return store.getState().attach();
  }, [enabled, store]);

  useEffect(() => {
    const pending = disposalMap.get(store);
    if (pending !== undefined) pending.cancelled = true;

    return (): void => {
      const disposal: PendingDisposal = { cancelled: false };
      disposalMap.set(store, disposal);
      queueMicrotask(() => {
        if (disposal.cancelled) return;
        store.getState().dispose();
        if (disposalMap.get(store) === disposal) {
          disposalMap.delete(store);
        }
      });
    };
  }, [disposalMap, store]);

  return store;
}

/**
 * Creates a store for (client, key) once, attaches it while mounted, disposes
 * it on unmount or when client/key change. `key` must identify the scope and
 * target (e.g. costScopeKey(scope) + chatId).
 */
export function useCostViewStore<Value>(
  client: CostClient,
  key: string,
  create: () => CostViewStore<Value>,
): CostViewStore<Value> {
  return useCostViewStoreInternal(client, key, create, true);
}

export function useCostScopeStore(
  client: CostClient,
  scope: CostScopeRef,
): CostScopeStore {
  const key = `scope:${costScopeKey(scope)}`;
  return useCostViewStore(client, key, () =>
    createCostScopeStore(client, scope),
  );
}

export function useSessionBreakdownStore(
  client: CostClient,
  scope: CostScopeRef,
  chatId: string,
): SessionBreakdownStore {
  const key = `session:${costScopeKey(scope)}:${chatId}`;
  return useCostViewStore(client, key, () =>
    createSessionBreakdownStore(client, scope, chatId),
  );
}

export function usePipelineRunCostStore(
  client: CostClient,
  scope: CostScopeRef,
  executionId: string,
): PipelineRunCostStore {
  const key = `pipeline:${costScopeKey(scope)}:${executionId}`;
  return useCostViewStore(client, key, () =>
    createPipelineRunCostStore(client, scope, executionId),
  );
}

export function useCostChatSummaryStore(
  client: CostClient,
  scope: CostScopeRef,
  chatId: string,
  options: { readonly enabled?: boolean } = {},
): CostChatSummaryStore {
  const key = `summary:${costScopeKey(scope)}:${chatId}`;
  return useCostViewStoreInternal(
    client,
    key,
    () => createCostChatSummaryStore(client, scope, chatId),
    options.enabled !== false,
  );
}

export function useCostSubagentStore(
  client: CostClient,
  scope: CostScopeRef,
  chatId: string,
  subagentId: string,
): CostSubagentStore {
  const key = `subagent:${costScopeKey(scope)}:${chatId}:${subagentId}`;
  return useCostViewStore(client, key, () =>
    createCostSubagentStore(client, scope, chatId, subagentId),
  );
}
