'use client';

import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import type {
  SubagentLevelsSetting,
  SubagentStatusFilter,
} from '@canopy/ui-shared';
import type { SubagentsViewMode } from '../types';

/** Root-chat view preferences remembered independently inside each scope. */
export interface SubagentRootViewState {
  readonly levels: SubagentLevelsSetting;
  readonly focusId: string | null;
}

/** Serializable v1 persistence snapshot for one Subagents panel scope. */
export interface SubagentViewStateSnapshot {
  readonly version: 1;
  readonly filter: SubagentStatusFilter;
  readonly view: SubagentsViewMode;
  readonly selectedRootId: string | null;
  readonly roots: Readonly<Record<string, SubagentRootViewState>>;
}

/** Optional host-owned persistence. The store never touches a browser or file API. */
export interface SubagentViewStatePersistence {
  /** Reads a possibly stale or malformed persisted value for this scope. */
  load(scopeKey: string): Promise<SubagentViewStateSnapshot | null>;
  /** Writes the current v1 snapshot after hydration has started. */
  save(scopeKey: string, snapshot: SubagentViewStateSnapshot): void;
}

/** Scope fields consumed by React panels. */
export interface SubagentScopeViewState {
  readonly filter: SubagentStatusFilter;
  readonly view: SubagentsViewMode;
  readonly selectedRootId: string | null;
}

type HydrationStatus = 'idle' | 'loading' | 'ready';

interface InternalSubagentScopeState extends SubagentScopeViewState {
  readonly roots: Readonly<Record<string, SubagentRootViewState>>;
  readonly hydrationStatus: HydrationStatus;
  readonly fieldRevisions: Readonly<Record<string, number>>;
  readonly revision: number;
}

/** Public store state and its mutation actions. */
export interface SubagentViewStateStore {
  readonly scopes: Readonly<Record<string, InternalSubagentScopeState>>;
  /** Choose which status filter this panel scope displays. */
  setFilter(this: void, scopeKey: string, filter: SubagentStatusFilter): void;
  /** Choose Tree or List for this panel scope. */
  setView(this: void, scopeKey: string, view: SubagentsViewMode): void;
  /** Remember the selected root chat, or clear the selection. */
  setSelectedRoot(this: void, scopeKey: string, rootId: string | null): void;
  /** Remember Levels for a root chat without affecting other roots. */
  setLevels(
    this: void,
    scopeKey: string,
    rootId: string,
    levels: SubagentLevelsSetting,
  ): void;
  /** Remember tree focus for a root chat without affecting other roots. */
  setFocus(
    this: void,
    scopeKey: string,
    rootId: string,
    focusId: string | null,
  ): void;
  /** Remove archived/deleted roots and clear a matching current selection. */
  forgetSubagentRootChats(
    this: void,
    scopeKey: string,
    rootChatIds: readonly string[],
  ): void;
}

const DEFAULT_ROOT_VIEW_STATE: SubagentRootViewState = {
  levels: 'auto',
  focusId: null,
};

const DEFAULT_SCOPE_VIEW_STATE: SubagentScopeViewState = {
  filter: 'all',
  view: 'tree',
  selectedRootId: null,
};

function createEmptyScopeState(): InternalSubagentScopeState {
  return {
    ...DEFAULT_SCOPE_VIEW_STATE,
    roots: {},
    hydrationStatus: 'idle',
    fieldRevisions: {},
    revision: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilter(value: unknown): value is SubagentStatusFilter {
  return value === 'all' || value === 'active' || value === 'attention';
}

function isView(value: unknown): value is SubagentsViewMode {
  return value === 'tree' || value === 'list';
}

function isLevelsSetting(value: unknown): value is SubagentLevelsSetting {
  return (
    value === 'auto' ||
    value === 'all' ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= 3)
  );
}

function isRootId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function isSafeRecordKey(key: string): boolean {
  return key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
}

/**
 * Validates untrusted storage data without casts. Invalid snapshots return
 * null; malformed individual root-chat entries are skipped defensively.
 */
export function sanitizeSubagentViewStateSnapshot(
  value: unknown,
): SubagentViewStateSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    !isFilter(value.filter) ||
    !isView(value.view) ||
    !isRootId(value.selectedRootId) ||
    !isRecord(value.roots)
  ) {
    return null;
  }

  const roots: Record<string, SubagentRootViewState> = {};
  for (const [rootId, candidate] of Object.entries(value.roots)) {
    if (!isSafeRecordKey(rootId) || !isRecord(candidate)) continue;
    if (!isLevelsSetting(candidate.levels) || !isRootId(candidate.focusId))
      continue;
    roots[rootId] = {
      levels: candidate.levels,
      focusId: candidate.focusId,
    };
  }

  return {
    version: 1,
    filter: value.filter,
    view: value.view,
    selectedRootId: value.selectedRootId,
    roots,
  };
}

function scopeSnapshot(
  scope: InternalSubagentScopeState,
): SubagentViewStateSnapshot {
  return {
    version: 1,
    filter: scope.filter,
    view: scope.view,
    selectedRootId: scope.selectedRootId,
    roots: scope.roots,
  };
}

function fieldRevisionKey(field: 'filter' | 'view' | 'selectedRootId'): string {
  return field;
}

function rootFieldRevisionKey(
  rootId: string,
  field: 'levels' | 'focusId' | 'forgotten',
): string {
  return `root:${rootId}:${field}`;
}

function advanceRevision(
  scope: InternalSubagentScopeState,
  revisionKey: string,
): Pick<InternalSubagentScopeState, 'fieldRevisions' | 'revision'> {
  const nextRevision = scope.revision + 1;
  return {
    fieldRevisions: { ...scope.fieldRevisions, [revisionKey]: nextRevision },
    revision: nextRevision,
  };
}

function mergeLoadedSnapshot(
  scope: InternalSubagentScopeState,
  snapshot: SubagentViewStateSnapshot | null,
): InternalSubagentScopeState {
  if (!snapshot) return { ...scope, hydrationStatus: 'ready' };

  const filterWasChanged =
    (scope.fieldRevisions[fieldRevisionKey('filter')] ?? 0) > 0;
  const viewWasChanged =
    (scope.fieldRevisions[fieldRevisionKey('view')] ?? 0) > 0;
  const selectedWasChanged =
    (scope.fieldRevisions[fieldRevisionKey('selectedRootId')] ?? 0) > 0;
  const roots: Record<string, SubagentRootViewState> = {};
  const rootIds = new Set([
    ...Object.keys(snapshot.roots),
    ...Object.keys(scope.roots),
  ]);

  for (const rootId of rootIds) {
    const forgotten =
      (scope.fieldRevisions[rootFieldRevisionKey(rootId, 'forgotten')] ?? 0) >
      0;
    if (forgotten) continue;
    const loaded = snapshot.roots[rootId];
    const current = scope.roots[rootId];
    const levelsChanged =
      (scope.fieldRevisions[rootFieldRevisionKey(rootId, 'levels')] ?? 0) > 0;
    const focusChanged =
      (scope.fieldRevisions[rootFieldRevisionKey(rootId, 'focusId')] ?? 0) > 0;
    if (!loaded && !current) continue;
    roots[rootId] = {
      levels: levelsChanged
        ? (current?.levels ?? DEFAULT_ROOT_VIEW_STATE.levels)
        : (loaded?.levels ?? DEFAULT_ROOT_VIEW_STATE.levels),
      focusId: focusChanged
        ? (current?.focusId ?? DEFAULT_ROOT_VIEW_STATE.focusId)
        : (loaded?.focusId ?? DEFAULT_ROOT_VIEW_STATE.focusId),
    };
  }

  const selectedRootId = selectedWasChanged
    ? scope.selectedRootId
    : snapshot.selectedRootId !== null &&
        (scope.fieldRevisions[
          rootFieldRevisionKey(snapshot.selectedRootId, 'forgotten')
        ] ?? 0) > 0
      ? null
      : snapshot.selectedRootId;

  return {
    ...scope,
    filter: filterWasChanged ? scope.filter : snapshot.filter,
    view: viewWasChanged ? scope.view : snapshot.view,
    selectedRootId,
    roots,
    hydrationStatus: 'ready',
  };
}

const persistenceByScope = new Map<string, SubagentViewStatePersistence>();
const hydrationByScope = new Map<string, Promise<void>>();

function saveIfReady(
  scopeKey: string,
  scope: InternalSubagentScopeState,
): void {
  if (scope.hydrationStatus !== 'ready') return;
  const adapter = persistenceByScope.get(scopeKey);
  if (!adapter) return;
  try {
    adapter.save(scopeKey, scopeSnapshot(scope));
  } catch {
    // Persistence is host-owned; a rejected write must not break the view.
  }
}

function updateScope(
  scopeKey: string,
  update: (scope: InternalSubagentScopeState) => InternalSubagentScopeState,
  set: (
    partial:
      | Partial<SubagentViewStateStore>
      | ((state: SubagentViewStateStore) => Partial<SubagentViewStateStore>),
  ) => void,
  get: () => SubagentViewStateStore,
): void {
  let updated: InternalSubagentScopeState | undefined;
  set((state) => {
    const current = state.scopes[scopeKey] ?? createEmptyScopeState();
    updated = update(current);
    return { scopes: { ...state.scopes, [scopeKey]: updated } };
  });
  if (updated) saveIfReady(scopeKey, updated);
  // Keep `get` in this helper's API so update actions never need stale state.
  void get;
}

/** Zustand store used by all Subagents panels without requiring an adapter. */
export const useSubagentViewStateStore = create<SubagentViewStateStore>(
  (set, get) => ({
    scopes: {},
    setFilter: (scopeKey, filter): void => {
      updateScope(
        scopeKey,
        (scope) => ({
          ...scope,
          filter,
          ...advanceRevision(scope, fieldRevisionKey('filter')),
        }),
        set,
        get,
      );
    },
    setView: (scopeKey, view): void => {
      updateScope(
        scopeKey,
        (scope) => ({
          ...scope,
          view,
          ...advanceRevision(scope, fieldRevisionKey('view')),
        }),
        set,
        get,
      );
    },
    setSelectedRoot: (scopeKey, selectedRootId): void => {
      updateScope(
        scopeKey,
        (scope) => ({
          ...scope,
          selectedRootId,
          ...advanceRevision(scope, fieldRevisionKey('selectedRootId')),
        }),
        set,
        get,
      );
    },
    setLevels: (scopeKey, rootId, levels): void => {
      updateScope(
        scopeKey,
        (scope) => ({
          ...scope,
          roots: {
            ...scope.roots,
            [rootId]: {
              ...(scope.roots[rootId] ?? DEFAULT_ROOT_VIEW_STATE),
              levels,
            },
          },
          ...advanceRevision(scope, rootFieldRevisionKey(rootId, 'levels')),
        }),
        set,
        get,
      );
    },
    setFocus: (scopeKey, rootId, focusId): void => {
      updateScope(
        scopeKey,
        (scope) => ({
          ...scope,
          roots: {
            ...scope.roots,
            [rootId]: {
              ...(scope.roots[rootId] ?? DEFAULT_ROOT_VIEW_STATE),
              focusId,
            },
          },
          ...advanceRevision(scope, rootFieldRevisionKey(rootId, 'focusId')),
        }),
        set,
        get,
      );
    },
    forgetSubagentRootChats: (scopeKey, rootChatIds): void => {
      updateScope(
        scopeKey,
        (scope) => {
          const roots: Record<string, SubagentRootViewState> = {
            ...scope.roots,
          };
          let nextScope = scope;
          for (const rootId of rootChatIds) {
            delete roots[rootId];
            nextScope = {
              ...nextScope,
              ...advanceRevision(
                nextScope,
                rootFieldRevisionKey(rootId, 'forgotten'),
              ),
            };
          }
          const clearSelection =
            scope.selectedRootId !== null &&
            rootChatIds.includes(scope.selectedRootId);
          if (clearSelection) {
            nextScope = {
              ...nextScope,
              selectedRootId: null,
              ...advanceRevision(nextScope, fieldRevisionKey('selectedRootId')),
            };
          }
          return { ...nextScope, roots };
        },
        set,
        get,
      );
    },
  }),
);

/** Idempotently starts persistence hydration and protects local edits from races. */
export function hydrateSubagentViewState(
  scopeKey: string,
  adapter?: SubagentViewStatePersistence,
): Promise<void> {
  const currentScope = useSubagentViewStateStore.getState().scopes[scopeKey];
  if (!currentScope && hydrationByScope.has(scopeKey)) {
    hydrationByScope.delete(scopeKey);
    persistenceByScope.delete(scopeKey);
  }
  if (adapter) persistenceByScope.set(scopeKey, adapter);
  const existing = hydrationByScope.get(scopeKey);
  if (existing) return existing;

  const registeredAdapter = persistenceByScope.get(scopeKey);
  let resolveHydration: (() => void) | undefined;
  const hydration = new Promise<void>((resolve) => {
    resolveHydration = resolve;
  });
  hydrationByScope.set(scopeKey, hydration);
  updateScope(
    scopeKey,
    (scope) => ({
      ...scope,
      hydrationStatus: registeredAdapter ? 'loading' : 'ready',
    }),
    useSubagentViewStateStore.setState,
    useSubagentViewStateStore.getState,
  );

  const finish = (snapshot: SubagentViewStateSnapshot | null): void => {
    let merged: InternalSubagentScopeState | undefined;
    useSubagentViewStateStore.setState((state) => {
      const scope = state.scopes[scopeKey] ?? createEmptyScopeState();
      merged = mergeLoadedSnapshot(scope, snapshot);
      return { scopes: { ...state.scopes, [scopeKey]: merged } };
    });
    if (merged) saveIfReady(scopeKey, merged);
    resolveHydration?.();
  };

  if (!registeredAdapter) {
    finish(null);
    return hydration;
  }

  try {
    void registeredAdapter
      .load(scopeKey)
      .then((loaded) => finish(sanitizeSubagentViewStateSnapshot(loaded)))
      .catch(() => finish(null));
  } catch {
    finish(null);
  }
  return hydration;
}

/** React selector for scope-level fields; `useShallow` avoids object churn. */
export function useSubagentScopeViewState(
  scopeKey: string,
): SubagentScopeViewState {
  return useSubagentViewStateStore(
    useShallow((state): SubagentScopeViewState => {
      const scope = state.scopes[scopeKey];
      return scope
        ? {
            filter: scope.filter,
            view: scope.view,
            selectedRootId: scope.selectedRootId,
          }
        : DEFAULT_SCOPE_VIEW_STATE;
    }),
  );
}

/** React selector that lets root auto-selection wait for persisted state. */
export function useSubagentScopeHydrated(scopeKey: string): boolean {
  return useSubagentViewStateStore(
    (state): boolean => state.scopes[scopeKey]?.hydrationStatus === 'ready',
  );
}

/** React selector for a root's independent Levels and focus preferences. */
export function useSubagentRootViewState(
  scopeKey: string,
  rootId: string | null,
): SubagentRootViewState {
  return useSubagentViewStateStore(
    useShallow((state): SubagentRootViewState => {
      const root = rootId ? state.scopes[scopeKey]?.roots[rootId] : undefined;
      return root ?? DEFAULT_ROOT_VIEW_STATE;
    }),
  );
}
