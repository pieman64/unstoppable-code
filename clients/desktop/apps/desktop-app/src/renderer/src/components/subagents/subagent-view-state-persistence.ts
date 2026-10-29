import {
  sanitizeSubagentViewStateSnapshot,
  type SubagentViewStatePersistence,
  type SubagentViewStateSnapshot,
} from '@canopy/ui-app/subagents';

type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STORAGE_KEY_PREFIX = 'canopy.subagents.viewState.v1:';
const MAX_STORED_ROOTS = 200;

interface ScopeRootRecency {
  readonly touchedAtByRoot: Map<string, number>;
  previousSnapshot: SubagentViewStateSnapshot | null;
  nextTouchAt: number;
}

function storageFor(storage: StoragePort | undefined): StoragePort | null {
  if (storage) return storage;
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function scopeStorageKey(scopeKey: string): string {
  return `${STORAGE_KEY_PREFIX}${scopeKey}`;
}

function recencyForSnapshot(
  snapshot: SubagentViewStateSnapshot,
): ScopeRootRecency {
  const touchedAtByRoot = new Map<string, number>();
  let nextTouchAt = 0;
  for (const rootId of Object.keys(snapshot.roots)) {
    nextTouchAt += 1;
    touchedAtByRoot.set(rootId, nextTouchAt);
  }
  return { touchedAtByRoot, previousSnapshot: snapshot, nextTouchAt };
}

function sameRootView(
  left: SubagentViewStateSnapshot['roots'][string] | undefined,
  right: SubagentViewStateSnapshot['roots'][string] | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.levels === right.levels &&
      left.focusId === right.focusId)
  );
}

function boundedSnapshot(
  snapshot: SubagentViewStateSnapshot,
  recency: ScopeRootRecency,
): SubagentViewStateSnapshot {
  const rootIds = Object.keys(snapshot.roots);
  const presentIds = new Set(rootIds);
  recency.touchedAtByRoot.forEach((_touch: number, knownId: string): void => {
    if (!presentIds.has(knownId)) recency.touchedAtByRoot.delete(knownId);
  });

  for (const rootId of rootIds) {
    const previous = recency.previousSnapshot?.roots[rootId];
    const current = snapshot.roots[rootId];
    if (
      !recency.touchedAtByRoot.has(rootId) ||
      !sameRootView(previous, current)
    ) {
      recency.nextTouchAt += 1;
      recency.touchedAtByRoot.set(rootId, recency.nextTouchAt);
    }
  }
  if (
    snapshot.selectedRootId !== null &&
    presentIds.has(snapshot.selectedRootId)
  ) {
    recency.nextTouchAt += 1;
    recency.touchedAtByRoot.set(snapshot.selectedRootId, recency.nextTouchAt);
  }

  const retainedIds = Array.from(recency.touchedAtByRoot.entries())
    .sort((left, right) => left[1] - right[1])
    .slice(-MAX_STORED_ROOTS)
    .map(([rootId]) => rootId);
  const roots: Record<string, SubagentViewStateSnapshot['roots'][string]> = {};
  for (const rootId of retainedIds) {
    const rootState = snapshot.roots[rootId];
    if (rootState) roots[rootId] = rootState;
  }
  return { ...snapshot, roots };
}

/** Renderer-local persistence for Levels and Focus, never a worktree file. */
export function createSubagentViewStatePersistence(
  storage?: StoragePort,
): SubagentViewStatePersistence {
  const recencyByScope = new Map<string, ScopeRootRecency>();

  return {
    load(scopeKey: string): Promise<SubagentViewStateSnapshot | null> {
      const backing = storageFor(storage);
      if (!backing) return Promise.resolve(null);
      try {
        const raw = backing.getItem(scopeStorageKey(scopeKey));
        if (raw === null) return Promise.resolve(null);
        const parsed: unknown = JSON.parse(raw);
        const snapshot = sanitizeSubagentViewStateSnapshot(parsed);
        if (snapshot) {
          recencyByScope.set(scopeKey, recencyForSnapshot(snapshot));
        }
        return Promise.resolve(snapshot);
      } catch {
        return Promise.resolve(null);
      }
    },
    save(scopeKey: string, snapshot: SubagentViewStateSnapshot): void {
      const backing = storageFor(storage);
      if (!backing) return;
      try {
        const recency =
          recencyByScope.get(scopeKey) ?? recencyForSnapshot(snapshot);
        recencyByScope.set(scopeKey, recency);
        const bounded = boundedSnapshot(snapshot, recency);
        recency.previousSnapshot = bounded;
        backing.setItem(scopeStorageKey(scopeKey), JSON.stringify(bounded));
      } catch {
        // Private browsing and a full storage quota are best-effort states.
      }
    },
  };
}

export const desktopSubagentViewStatePersistence: SubagentViewStatePersistence =
  createSubagentViewStatePersistence();
