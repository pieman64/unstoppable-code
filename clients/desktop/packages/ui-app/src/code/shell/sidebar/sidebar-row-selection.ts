import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

/**
 * Multi-select for sidebar rows (CAN-3975), keyed by row key: worktree and
 * session rows by `worktreeRowKey`, Work Entry rows by `workEntryRowKey`.
 * A selection holds one kind of row: a gesture on a row of another kind
 * replaces it, so a rail never mixes worktrees and chats.
 * Separate from navigation: selecting rows never moves the open row.
 * A plain row click navigates and ends the selection (the rows clear it),
 * and so does a click anywhere else (the bulk hook listens for it).
 */

/** What a selectable row is; a selection holds rows of one kind. */
export type SidebarRowKind = 'worktree' | 'session' | 'work-entry';

/**
 * Marks a row that handles its own clicks for the selection: modifier clicks
 * build it and a plain click ends it, so a click there is not "elsewhere".
 */
export const SIDEBAR_SELECTION_ROW_ATTR = 'data-worktree-selection-row';

/**
 * Where a click leaves the selection alone: its rows, and the menus and
 * dialogs that act on it.
 */
export const SIDEBAR_SELECTION_KEEPER_SELECTOR = [
  `[${SIDEBAR_SELECTION_ROW_ATTR}]`,
  '[role="menu"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(', ');

/** One rendered row of a list, in the order the list renders it. */
export interface SidebarSelectionRow {
  readonly key: string;
  readonly kind: SidebarRowKind;
  readonly selectable: boolean;
  /** Names for a batch confirm; lists whose rows are not in the snapshot supply them. */
  readonly label?: string;
  readonly projectName?: string;
  /** The navigated row: a batch removes it last. */
  readonly open?: boolean;
}

/**
 * Rendered rows per list id (a workspace local id). Children of a collapsed
 * group are not rendered, so they are absent here and never fall inside a
 * range.
 */
export type SidebarSelectionRows = ReadonlyMap<
  string,
  readonly SidebarSelectionRow[]
>;

interface SidebarSelectionAnchor {
  readonly listId: string;
  readonly key: string;
}

export interface SidebarRowSelectionState {
  readonly keys: ReadonlySet<string>;
  /** The kind every selected key has; absent exactly when `keys` is empty. */
  readonly kind?: SidebarRowKind;
  readonly anchor?: SidebarSelectionAnchor;
}

export type SidebarRowSelectionAction =
  | {
      readonly type: 'toggle';
      readonly listId: string;
      readonly key: string;
      readonly kind: SidebarRowKind;
    }
  | {
      readonly type: 'selectRange';
      readonly listId: string;
      readonly key: string;
      readonly kind: SidebarRowKind;
      readonly rows: readonly SidebarSelectionRow[];
    }
  | {
      readonly type: 'selectAllInList';
      readonly kind: SidebarRowKind;
      readonly rows: readonly SidebarSelectionRow[];
    }
  | { readonly type: 'clear' }
  /**
   * Keep exactly these keys, e.g. the rows a finished batch left behind. A
   * key that is no longer rendered is dropped.
   */
  | {
      readonly type: 'replace';
      readonly keys: readonly string[];
      readonly kind: SidebarRowKind | undefined;
      readonly visibleKeys: ReadonlySet<string>;
    }
  | { readonly type: 'prune'; readonly visibleKeys: ReadonlySet<string> };

export const EMPTY_SIDEBAR_ROW_SELECTION: SidebarRowSelectionState = {
  keys: new Set(),
};

/** The facts that decide whether a row can join a bulk selection. */
export interface WorktreeSelectableInputs {
  /**
   * `'session'` for cowork rows. Sessions are selectable too; their row
   * kind keeps them out of a worktree selection.
   */
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
    inputs.worktreeRemoval !== undefined &&
    inputs.worktreeRemoval !== false &&
    !inputs.commandsDisabled &&
    !inputs.hidden &&
    !inputs.removalInProgress
  );
}

function withKeys(
  keys: ReadonlySet<string>,
  kind: SidebarRowKind | undefined,
  anchor: SidebarSelectionAnchor | undefined,
): SidebarRowSelectionState {
  if (keys.size === 0)
    return anchor === undefined ? { keys } : { keys, anchor };
  return anchor === undefined ? { keys, kind } : { keys, kind, anchor };
}

/** A gesture on a row of another kind starts from an empty selection. */
function forKind(
  state: SidebarRowSelectionState,
  kind: SidebarRowKind,
): SidebarRowSelectionState {
  return state.kind !== undefined && state.kind !== kind
    ? EMPTY_SIDEBAR_ROW_SELECTION
    : state;
}

function toggleKey(
  state: SidebarRowSelectionState,
  listId: string,
  key: string,
  kind: SidebarRowKind,
): SidebarRowSelectionState {
  const base = forKind(state, kind);
  const keys = new Set(base.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return withKeys(keys, kind, { listId, key });
}

function selectRange(
  state: SidebarRowSelectionState,
  listId: string,
  key: string,
  kind: SidebarRowKind,
  rows: readonly SidebarSelectionRow[],
): SidebarRowSelectionState {
  const selectable = rows.filter((row) => row.selectable && row.kind === kind);
  const targetIndex = selectable.findIndex((row) => row.key === key);
  if (targetIndex === -1) return state;
  const base = forKind(state, kind);
  const anchor = base.anchor;
  const anchorIndex =
    anchor?.listId === listId
      ? selectable.findIndex((row) => row.key === anchor.key)
      : -1;
  const keys = new Set(base.keys);
  // No usable anchor (none yet, another list, another kind, or no longer
  // selectable): select the one row and anchor there.
  if (anchor === undefined || anchorIndex === -1) {
    keys.add(key);
    return withKeys(keys, kind, { listId, key });
  }
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  for (const row of selectable.slice(from, to + 1)) keys.add(row.key);
  return withKeys(keys, kind, anchor);
}

function selectAll(
  state: SidebarRowSelectionState,
  kind: SidebarRowKind,
  rows: readonly SidebarSelectionRow[],
): SidebarRowSelectionState {
  const base = forKind(state, kind);
  const keys = new Set(base.keys);
  for (const row of rows) {
    if (row.selectable && row.kind === kind) keys.add(row.key);
  }
  if (base === state && keys.size === state.keys.size) return state;
  return withKeys(keys, kind, base.anchor);
}

function prune(
  state: SidebarRowSelectionState,
  visibleKeys: ReadonlySet<string>,
): SidebarRowSelectionState {
  const keys = new Set([...state.keys].filter((key) => visibleKeys.has(key)));
  const anchor =
    state.anchor !== undefined && visibleKeys.has(state.anchor.key)
      ? state.anchor
      : undefined;
  if (keys.size === state.keys.size && anchor === state.anchor) return state;
  return withKeys(keys, state.kind, anchor);
}

export function sidebarRowSelectionReducer(
  state: SidebarRowSelectionState,
  action: SidebarRowSelectionAction,
): SidebarRowSelectionState {
  switch (action.type) {
    case 'toggle':
      return toggleKey(state, action.listId, action.key, action.kind);
    case 'selectRange':
      return selectRange(
        state,
        action.listId,
        action.key,
        action.kind,
        action.rows,
      );
    case 'selectAllInList':
      return selectAll(state, action.kind, action.rows);
    case 'clear':
      return state.keys.size === 0 && state.anchor === undefined
        ? state
        : EMPTY_SIDEBAR_ROW_SELECTION;
    case 'replace':
      return withKeys(
        new Set(action.keys.filter((key) => action.visibleKeys.has(key))),
        action.kind,
        state.anchor,
      );
    case 'prune':
      return prune(state, action.visibleKeys);
  }
}

export interface SidebarRowSelection {
  readonly keys: ReadonlySet<string>;
  /** The kind of the selected rows; `undefined` while nothing is selected. */
  readonly kind: SidebarRowKind | undefined;
  /** True while any row is selected: selected rows show the accent tint. */
  readonly active: boolean;
  readonly count: number;
  readonly isSelected: (key: string) => boolean;
  /** Toggles a rendered row; its kind comes from the reported rows. */
  readonly toggle: (listId: string, key: string) => void;
  /** Shift-click: from the anchor to `key` over the list's rendered rows. */
  readonly selectRange: (listId: string, key: string) => void;
  readonly selectAllInList: (listId: string) => void;
  readonly clear: () => void;
  readonly replace: (keys: readonly string[]) => void;
}

/**
 * Selection state over the rail's rendered rows. Keys that stop rendering
 * (removed, filtered out, project collapsed) or stop being selectable are
 * pruned. A running batch keeps its own snapshot, so pruning never affects
 * it.
 */
export function useSidebarRowSelection(
  rows: SidebarSelectionRows,
): SidebarRowSelection {
  const [state, dispatch] = useReducer(
    sidebarRowSelectionReducer,
    EMPTY_SIDEBAR_ROW_SELECTION,
  );

  // Only rows a list reports as selectable can be selected: a row no list
  // reports (a read-only list's menu) never enters the selection, and one
  // that becomes unselectable (hidden, removal withdrawn) leaves it. Kinds
  // cover every reported row, so a selected row that turned unselectable can
  // still be toggled off.
  const { visibleKeys, kindByKey } = useMemo(() => {
    const keys = new Set<string>();
    const kinds = new Map<string, SidebarRowKind>();
    for (const listRows of rows.values()) {
      for (const row of listRows) {
        kinds.set(row.key, row.kind);
        if (row.selectable) keys.add(row.key);
      }
    }
    return { visibleKeys: keys, kindByKey: kinds };
  }, [rows]);

  useEffect(() => {
    dispatch({ type: 'prune', visibleKeys });
  }, [visibleKeys]);

  const rowsFor = useCallback(
    (listId: string): readonly SidebarSelectionRow[] => rows.get(listId) ?? [],
    [rows],
  );
  const keysRef = useRef(state.keys);
  keysRef.current = state.keys;
  const toggle = useCallback(
    (listId: string, key: string): void => {
      if (!keysRef.current.has(key) && !visibleKeys.has(key)) return;
      const kind = kindByKey.get(key);
      if (kind === undefined) return;
      dispatch({ type: 'toggle', listId, key, kind });
    },
    [visibleKeys, kindByKey],
  );
  const selectRange = useCallback(
    (listId: string, key: string): void => {
      const kind = kindByKey.get(key);
      if (kind === undefined) return;
      dispatch({
        type: 'selectRange',
        listId,
        key,
        kind,
        rows: rowsFor(listId),
      });
    },
    [kindByKey, rowsFor],
  );
  const selectAllInList = useCallback(
    (listId: string): void => {
      const listRows = rowsFor(listId);
      const kind = listRows.find((row) => row.selectable)?.kind;
      if (kind === undefined) return;
      dispatch({ type: 'selectAllInList', kind, rows: listRows });
    },
    [rowsFor],
  );
  const clear = useCallback((): void => dispatch({ type: 'clear' }), []);
  // A batch's completion calls `replace` from the render that confirmed it,
  // so it reads the rows rendered now rather than that render's.
  const visibleKeysRef = useRef(visibleKeys);
  visibleKeysRef.current = visibleKeys;
  const kindByKeyRef = useRef(kindByKey);
  kindByKeyRef.current = kindByKey;
  const replace = useCallback((keys: readonly string[]): void => {
    const first = keys.find((key) => kindByKeyRef.current.has(key));
    const kind =
      first === undefined ? undefined : kindByKeyRef.current.get(first);
    dispatch({
      type: 'replace',
      keys: keys.filter((key) => kindByKeyRef.current.get(key) === kind),
      kind,
      visibleKeys: visibleKeysRef.current,
    });
  }, []);

  return useMemo(
    () => ({
      keys: state.keys,
      kind: state.kind,
      active: state.keys.size > 0,
      count: state.keys.size,
      isSelected: (key: string): boolean => state.keys.has(key),
      toggle,
      selectRange,
      selectAllInList,
      clear,
      replace,
    }),
    [
      state.keys,
      state.kind,
      toggle,
      selectRange,
      selectAllInList,
      clear,
      replace,
    ],
  );
}
