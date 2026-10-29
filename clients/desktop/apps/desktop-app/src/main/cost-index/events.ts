import {
  costScopeKey,
  type CostScopeRef,
  type CostUpdatedEvent,
} from '@canopy/protocol/cost-view';

const watches = new Map<number, Set<string>>();
const listeners = new Set<(event: CostUpdatedEvent) => void>();

export function watchCostScope(windowId: number, scope: CostScopeRef): void {
  let scopes = watches.get(windowId);
  if (scopes === undefined) {
    scopes = new Set();
    watches.set(windowId, scopes);
  }
  scopes.add(costScopeKey(scope));
}

export function unwatchCostScope(windowId: number, scope: CostScopeRef): void {
  const scopes = watches.get(windowId);
  scopes?.delete(costScopeKey(scope));
  if (scopes?.size === 0) watches.delete(windowId);
}

export function dropCostScopeWatches(windowId: number): void {
  watches.delete(windowId);
}

export function isCostScopeWatched(scope: CostScopeRef): boolean {
  const key = costScopeKey(scope);
  return Array.from(watches.values()).some((scopes) => scopes.has(key));
}

export function onCostUpdated(
  listener: (event: CostUpdatedEvent) => void,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function emitCostUpdated(event: CostUpdatedEvent): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch {
      /* A view cannot break a committed refresh. */
    }
  }
}

export function resetCostEventsForTest(): void {
  watches.clear();
  listeners.clear();
}
