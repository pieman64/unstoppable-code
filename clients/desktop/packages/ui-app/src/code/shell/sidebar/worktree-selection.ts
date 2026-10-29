import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

/**
 * Multi-select for worktree rows (CAN-3975), keyed by `worktreeRowKey`.
 * Separate from navigation: selecting rows never moves the open worktree.
 * A plain row click navigates and ends the selection (the sections clear it),
 * and so does a click anywhere else (the bulk hook listens for it).
 */

/**
 * Marks a row that handles its own clicks for the selection: modifier clicks
 * build it and a plain click ends it, so a click there is not "elsewhere".
 */
export const WORKTREE_SELECTION_ROW_ATTR = 'data-worktree-selection-row';

/**
 * Where a click leaves the selection alone: its rows, and the menus and
 * dialogs that act on it.
 */
export const WORKTREE_SELECTION_KEEPER_SELECTOR = [
  `[${WORKTREE_SELECTION_ROW_ATTR}]`,
  '[role="menu"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(', ');

/** One rendered row of a workspace, in the order the section renders it. */
export interface WorktreeSelectionRow {
  readonly key: string;
  readonly selectable: boolean;
}

/**
 * Rendered rows per workspace local id. Children of a collapsed nested group
 * are not rendered, so they are absent here and never fall inside a range.
 */
export type WorktreeSelectionRows = ReadonlyMap<
  string,
  readonly WorktreeSelectionRow[]
>;

interface WorktreeSelectionAnchor {
  readonly workspaceLocalId: string;
  readonly key: string;
}

export interface WorktreeSelectionState {
  readonly keys: ReadonlySet<string>;
  readonly anchor?: WorktreeSelectionAnchor;
}

export type WorktreeSelectionAction =
  | {
      readonly type: 'toggle';
      readonly workspaceLocalId: string;
      readonly key: string;
    }
  | {
      readonly type: 'selectRange';
      readonly workspaceLocalId: string;
      readonly key: string;
      readonly rows: readonly WorktreeSelectionRow[];
    }
  | {
      readonly type: 'selectAllInWorkspace';
      readonly rows: readonly WorktreeSelectionRow[];
    }
  | { readonly type: 'clear' }
  /**
   * Keep exactly these keys, e.g. the rows a finished batch left behind. A
   * key that is no longer rendered is dropped.
   */
  | {
      readonly type: 'replace';
      readonly keys: readonly string[];
      readonly visibleKeys: ReadonlySet<string>;
    }
  | { readonly type: 'prune'; readonly visibleKeys: ReadonlySet<string> };

export const EMPTY_WORKTREE_SELECTION: WorktreeSelectionState = {
  keys: new Set(),
};

/** The facts that decide whether a row can join a bulk selection. */
export interface WorktreeSelectableInputs {
  /** `'session'` for cowork rows, which bulk removal does not cover. */
  readonly subject: 'worktree' | 'session';
  /** The row's own `worktreeRemoval` capability. */
  readonly worktreeRemoval: false | 'archive' | 'delete' | undefined;
  readonly commandsDisabled: boolean;
  readonly hidden: boolean;
  /** Already being removed: the row is muted and inert. */
  readonly removalInProgress: boolean;
}

/**
 * Whether a row can be selected. A working agent, a Split PR lock, or setup
 * in progress does not prevent selection: the confirm lists such a row under
 * Not included with its reason.
 */
export function isWorktreeSelectable(
  inputs: WorktreeSelectableInputs,
): boolean {
  return (
    inputs.subject === 'worktree' &&
    inputs.worktreeRemoval !== undefined &&
    inputs.worktreeRemoval !== false &&
    !inputs.commandsDisabled &&
    !inputs.hidden &&
    !inputs.removalInProgress
  );
}

function withKeys(
  state: WorktreeSelectionState,
  keys: ReadonlySet<string>,
  anchor: WorktreeSelectionAnchor | undefined,
): WorktreeSelectionState {
  return anchor === undefined ? { keys } : { keys, anchor };
}

function toggleKey(
  state: WorktreeSelectionState,
  workspaceLocalId: string,
  key: string,
): WorktreeSelectionState {
  const keys = new Set(state.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return withKeys(state, keys, { workspaceLocalId, key });
}

function selectRange(
  state: WorktreeSelectionState,
  workspaceLocalId: string,
  key: string,
  rows: readonly WorktreeSelectionRow[],
): WorktreeSelectionState {
  const selectable = rows.filter((row) => row.selectable);
  const targetIndex = selectable.findIndex((row) => row.key === key);
  if (targetIndex === -1) return state;
  const anchor = state.anchor;
  const anchorIndex =
    anchor?.workspaceLocalId === workspaceLocalId
      ? selectable.findIndex((row) => row.key === anchor.key)
      : -1;
  const keys = new Set(state.keys);
  // No usable anchor (none yet, another workspace, or no longer selectable):
  // select the one row and anchor there.
  if (anchor === undefined || anchorIndex === -1) {
    keys.add(key);
    return withKeys(state, keys, { workspaceLocalId, key });
  }
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  for (const row of selectable.slice(from, to + 1)) keys.add(row.key);
  return withKeys(state, keys, anchor);
}

function selectAll(
  state: WorktreeSelectionState,
  rows: readonly WorktreeSelectionRow[],
): WorktreeSelectionState {
  const keys = new Set(state.keys);
  for (const row of rows) if (row.selectable) keys.add(row.key);
  return keys.size === state.keys.size
    ? state
    : withKeys(state, keys, state.anchor);
}

function prune(
  state: WorktreeSelectionState,
  visibleKeys: ReadonlySet<string>,
): WorktreeSelectionState {
  const keys = new Set([...state.keys].filter((key) => visibleKeys.has(key)));
  const anchor =
    state.anchor !== undefined && visibleKeys.has(state.anchor.key)
      ? state.anchor
      : undefined;
  if (keys.size === state.keys.size && anchor === state.anchor) return state;
  return withKeys(state, keys, anchor);
}

export function worktreeSelectionReducer(
  state: WorktreeSelectionState,
  action: WorktreeSelectionAction,
): WorktreeSelectionState {
  switch (action.type) {
    case 'toggle':
      return toggleKey(state, action.workspaceLocalId, action.key);
    case 'selectRange':
      return selectRange(
        state,
        action.workspaceLocalId,
        action.key,
        action.rows,
      );
    case 'selectAllInWorkspace':
      return selectAll(state, action.rows);
    case 'clear':
      return state.keys.size === 0 && state.anchor === undefined
        ? state
        : EMPTY_WORKTREE_SELECTION;
    case 'replace':
      return withKeys(
        state,
        new Set(action.keys.filter((key) => action.visibleKeys.has(key))),
        state.anchor,
      );
    case 'prune':
      return prune(state, action.visibleKeys);
  }
}

export interface WorktreeSelection {
  readonly keys: ReadonlySet<string>;
  /** True while any row is selected: selected rows show the accent tint. */
  readonly active: boolean;
  readonly count: number;
  readonly isSelected: (key: string) => boolean;
  readonly toggle: (workspaceLocalId: string, key: string) => void;
  /** Shift-click: from the anchor to `key` over the workspace's rendered rows. */
  readonly selectRange: (workspaceLocalId: string, key: string) => void;
  readonly selectAllInWorkspace: (workspaceLocalId: string) => void;
  readonly clear: () => void;
  readonly replace: (keys: readonly string[]) => void;
}

/**
 * Selection state over the rail's rendered rows. Keys that stop rendering
 * (removed, filtered out, project collapsed) or stop being selectable are
 * pruned. A running batch
 * keeps its own snapshot, so pruning never affects it.
 */
export function useWorktreeSelection(
  rows: WorktreeSelectionRows,
): WorktreeSelection {
  const [state, dispatch] = useReducer(
    worktreeSelectionReducer,
    EMPTY_WORKTREE_SELECTION,
  );

  // Only rows a list reports as selectable can be selected: a row no list
  // reports (a read-only list's menu) never enters the selection, and one
  // that becomes unselectable (hidden, removal withdrawn) leaves it.
  const visibleKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const workspaceRows of rows.values()) {
      for (const row of workspaceRows) if (row.selectable) keys.add(row.key);
    }
    return keys;
  }, [rows]);

  useEffect(() => {
    dispatch({ type: 'prune', visibleKeys });
  }, [visibleKeys]);

  const rowsFor = useCallback(
    (workspaceLocalId: string): readonly WorktreeSelectionRow[] =>
      rows.get(workspaceLocalId) ?? [],
    [rows],
  );
  const keysRef = useRef(state.keys);
  keysRef.current = state.keys;
  const toggle = useCallback(
    (workspaceLocalId: string, key: string): void => {
      if (!keysRef.current.has(key) && !visibleKeys.has(key)) return;
      dispatch({ type: 'toggle', workspaceLocalId, key });
    },
    [visibleKeys],
  );
  const selectRange = useCallback(
    (workspaceLocalId: string, key: string): void =>
      dispatch({
        type: 'selectRange',
        workspaceLocalId,
        key,
        rows: rowsFor(workspaceLocalId),
      }),
    [rowsFor],
  );
  const selectAllInWorkspace = useCallback(
    (workspaceLocalId: string): void =>
      dispatch({
        type: 'selectAllInWorkspace',
        rows: rowsFor(workspaceLocalId),
      }),
    [rowsFor],
  );
  const clear = useCallback((): void => dispatch({ type: 'clear' }), []);
  // A batch's completion calls `replace` from the render that confirmed it,
  // so it reads the rows rendered now rather than that render's.
  const visibleKeysRef = useRef(visibleKeys);
  visibleKeysRef.current = visibleKeys;
  const replace = useCallback(
    (keys: readonly string[]): void =>
      dispatch({ type: 'replace', keys, visibleKeys: visibleKeysRef.current }),
    [],
  );

  return useMemo(
    () => ({
      keys: state.keys,
      active: state.keys.size > 0,
      count: state.keys.size,
      isSelected: (key: string): boolean => state.keys.has(key),
      toggle,
      selectRange,
      selectAllInWorkspace,
      clear,
      replace,
    }),
    [state.keys, toggle, selectRange, selectAllInWorkspace, clear, replace],
  );
}
