/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WORK_ENTRY_SELECTION_ROW_ATTR } from '@canopy/ui-shared/components';
import {
  EMPTY_SIDEBAR_ROW_SELECTION,
  SIDEBAR_SELECTION_ROW_ATTR,
  isWorktreeSelectable,
  useSidebarRowSelection,
  sidebarRowSelectionReducer,
  type SidebarRowSelection,
  type SidebarRowSelectionAction,
  type SidebarRowKind,
  type SidebarSelectionRow,
  type SidebarSelectionRows,
  type SidebarRowSelectionState,
} from '../sidebar-row-selection';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const row = (
  key: string,
  selectable = true,
  kind: SidebarRowKind = 'worktree',
): SidebarSelectionRow => ({ key, selectable, kind });

// Rendered order of one workspace, nesting included: `ws/b` is a nested
// child of `ws/a`. A collapsed group's children are simply absent.
const WS_ROWS = [row('ws/a'), row('ws/b'), row('ws/c'), row('ws/d')];

function reduce(
  ...actions: SidebarRowSelectionAction[]
): SidebarRowSelectionState {
  let state = EMPTY_SIDEBAR_ROW_SELECTION;
  for (const action of actions)
    state = sidebarRowSelectionReducer(state, action);
  return state;
}

const keysOf = (state: SidebarRowSelectionState): string[] =>
  Array.from(state.keys).sort();

describe('sidebarRowSelectionReducer', () => {
  it('toggles a key on and off and anchors at the toggled row', () => {
    const on = reduce({
      type: 'toggle',
      kind: 'worktree',
      listId: 'ws',
      key: 'ws/b',
    });
    expect(keysOf(on)).toEqual(['ws/b']);
    expect(on.anchor).toEqual({ listId: 'ws', key: 'ws/b' });
    const off = sidebarRowSelectionReducer(on, {
      type: 'toggle',
      kind: 'worktree',
      listId: 'ws',
      key: 'ws/b',
    });
    expect(keysOf(off)).toEqual([]);
    expect(off.anchor).toEqual({ listId: 'ws', key: 'ws/b' });
  });

  it('selects a range in rendered order in either direction, keeping the anchor', () => {
    const forward = reduce(
      { type: 'toggle', kind: 'worktree', listId: 'ws', key: 'ws/a' },
      {
        type: 'selectRange',
        kind: 'worktree',
        listId: 'ws',
        key: 'ws/c',
        rows: WS_ROWS,
      },
    );
    expect(keysOf(forward)).toEqual(['ws/a', 'ws/b', 'ws/c']);
    expect(forward.anchor?.key).toBe('ws/a');

    const backward = reduce(
      { type: 'toggle', kind: 'worktree', listId: 'ws', key: 'ws/d' },
      {
        type: 'selectRange',
        kind: 'worktree',
        listId: 'ws',
        key: 'ws/b',
        rows: WS_ROWS,
      },
    );
    expect(keysOf(backward)).toEqual(['ws/b', 'ws/c', 'ws/d']);
  });

  it('leaves out rows that are not rendered or not selectable', () => {
    const collapsed = [row('ws/a'), row('ws/c', false), row('ws/d')];
    const state = reduce(
      { type: 'toggle', kind: 'worktree', listId: 'ws', key: 'ws/a' },
      {
        type: 'selectRange',
        kind: 'worktree',
        listId: 'ws',
        key: 'ws/d',
        rows: collapsed,
      },
    );
    expect(keysOf(state)).toEqual(['ws/a', 'ws/d']);
  });

  it('selects just the row and anchors there when there is no anchor', () => {
    const state = reduce({
      type: 'selectRange',
      kind: 'worktree',
      listId: 'ws',
      key: 'ws/c',
      rows: WS_ROWS,
    });
    expect(keysOf(state)).toEqual(['ws/c']);
    expect(state.anchor).toEqual({ listId: 'ws', key: 'ws/c' });
  });

  it('resets the anchor when the range is in another workspace', () => {
    const other = [row('other/x'), row('other/y')];
    const state = reduce(
      { type: 'toggle', kind: 'worktree', listId: 'ws', key: 'ws/a' },
      {
        type: 'selectRange',
        kind: 'worktree',
        listId: 'other',
        key: 'other/y',
        rows: other,
      },
    );
    expect(keysOf(state)).toEqual(['other/y', 'ws/a']);
    expect(state.anchor).toEqual({ listId: 'other', key: 'other/y' });
  });

  it('selects every selectable row of one workspace', () => {
    const state = reduce(
      { type: 'toggle', kind: 'worktree', listId: 'other', key: 'other/x' },
      {
        type: 'selectAllInList',
        kind: 'worktree',
        rows: [row('ws/a'), row('ws/b', false), row('ws/c')],
      },
    );
    expect(keysOf(state)).toEqual(['other/x', 'ws/a', 'ws/c']);
  });

  it('prunes keys no longer rendered and clears a pruned anchor', () => {
    const selected = reduce(
      { type: 'toggle', kind: 'worktree', listId: 'ws', key: 'ws/a' },
      { type: 'toggle', kind: 'worktree', listId: 'ws', key: 'ws/b' },
    );
    const pruned = sidebarRowSelectionReducer(selected, {
      type: 'prune',
      visibleKeys: new Set(['ws/a', 'ws/c']),
    });
    expect(keysOf(pruned)).toEqual(['ws/a']);
    expect(pruned.anchor).toBeUndefined();
  });

  it('returns the same state when a prune changes nothing', () => {
    const selected = reduce({
      type: 'toggle',
      kind: 'worktree',
      listId: 'ws',
      key: 'ws/a',
    });
    expect(
      sidebarRowSelectionReducer(selected, {
        type: 'prune',
        visibleKeys: new Set(['ws/a', 'ws/b']),
      }),
    ).toBe(selected);
  });

  it('replaces the selection with the rendered keys it is given', () => {
    const state = reduce(
      { type: 'toggle', kind: 'worktree', listId: 'ws', key: 'ws/a' },
      {
        type: 'replace',
        kind: 'worktree',
        keys: ['ws/b', 'ws/gone'],
        visibleKeys: new Set(['ws/a', 'ws/b']),
      },
    );
    expect(keysOf(state)).toEqual(['ws/b']);
  });

  it('clears everything', () => {
    const state = reduce(
      { type: 'toggle', kind: 'worktree', listId: 'ws', key: 'ws/a' },
      { type: 'clear' },
    );
    expect(state).toBe(EMPTY_SIDEBAR_ROW_SELECTION);
  });
});

describe('sidebarRowSelectionReducer kinds', () => {
  it('replaces a selection of another kind instead of mixing kinds', () => {
    const chats = reduce(
      {
        type: 'toggle',
        listId: 'chats',
        key: 'work-entry:chats/a',
        kind: 'work-entry',
      },
      {
        type: 'toggle',
        listId: 'chats',
        key: 'work-entry:chats/b',
        kind: 'work-entry',
      },
    );
    expect(chats.kind).toBe('work-entry');
    const replaced = sidebarRowSelectionReducer(chats, {
      type: 'toggle',
      kind: 'worktree',
      listId: 'ws',
      key: 'ws/a',
    });
    expect(keysOf(replaced)).toEqual(['ws/a']);
    expect(replaced.kind).toBe('worktree');
    expect(replaced.anchor).toEqual({ listId: 'ws', key: 'ws/a' });
  });

  it('ranges never cross kinds: a Shift-click of another kind starts a new selection there', () => {
    const state = reduce(
      { type: 'toggle', listId: 'ws', key: 'ws/a', kind: 'worktree' },
      {
        type: 'selectRange',
        listId: 'chats',
        key: 'work-entry:chats/b',
        kind: 'work-entry',
        rows: [
          row('work-entry:chats/a', true, 'work-entry'),
          row('work-entry:chats/b', true, 'work-entry'),
        ],
      },
    );
    expect(keysOf(state)).toEqual(['work-entry:chats/b']);
    expect(state.kind).toBe('work-entry');
  });

  it('select all of another kind replaces the selection', () => {
    const state = reduce(
      { type: 'toggle', listId: 'ws', key: 'ws/a', kind: 'worktree' },
      {
        type: 'selectAllInList',
        kind: 'work-entry',
        rows: [row('work-entry:chats/a', true, 'work-entry')],
      },
    );
    expect(keysOf(state)).toEqual(['work-entry:chats/a']);
  });

  it('forgets the kind when the last key leaves, by toggle, prune, or replace', () => {
    const on = reduce({
      type: 'toggle',
      kind: 'worktree',
      listId: 'ws',
      key: 'ws/a',
    });
    expect(
      sidebarRowSelectionReducer(on, {
        type: 'toggle',
        listId: 'ws',
        key: 'ws/a',
        kind: 'worktree',
      }).kind,
    ).toBeUndefined();
    expect(
      sidebarRowSelectionReducer(on, { type: 'prune', visibleKeys: new Set() })
        .kind,
    ).toBeUndefined();
    expect(
      sidebarRowSelectionReducer(on, {
        type: 'replace',
        keys: [],
        kind: undefined,
        visibleKeys: new Set(['ws/a']),
      }).kind,
    ).toBeUndefined();
  });

  it('replace on an empty state records the given kind', () => {
    const state = reduce({
      type: 'replace',
      keys: ['work-entry:chats/a'],
      kind: 'work-entry',
      visibleKeys: new Set(['work-entry:chats/a']),
    });
    expect(state.kind).toBe('work-entry');
  });
});

describe('isWorktreeSelectable', () => {
  const base = {
    subject: 'worktree',
    worktreeRemoval: 'archive',
    commandsDisabled: false,
    hidden: false,
    removalInProgress: false,
  } as const;

  it('allows a removable worktree row', () => {
    expect(isWorktreeSelectable(base)).toBe(true);
  });

  it('allows a removable session row', () => {
    expect(isWorktreeSelectable({ ...base, subject: 'session' })).toBe(true);
  });

  it.each([
    ['a row without removal', { worktreeRemoval: false }],
    ['a row with unknown removal', { worktreeRemoval: undefined }],
    ['a gated workspace', { commandsDisabled: true }],
    ['a hidden row', { hidden: true }],
    ['a row mid-removal', { removalInProgress: true }],
  ] as const)('rejects %s', (_name, override) => {
    expect(isWorktreeSelectable({ ...base, ...override })).toBe(false);
  });
});

describe('useSidebarRowSelection', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: SidebarRowSelection | undefined;

  function Probe({ rows }: { rows: SidebarSelectionRows }): JSX.Element {
    latest = useSidebarRowSelection(rows);
    return <span>{latest.count}</span>;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = undefined;
  });

  it('ranges over the workspace rows it was given and prunes vanished rows', () => {
    const rows: SidebarSelectionRows = new Map([['ws', WS_ROWS]]);
    act(() => root.render(<Probe rows={rows} />));
    act(() => latest?.toggle('ws', 'ws/a'));
    act(() => latest?.selectRange('ws', 'ws/c'));
    expect(Array.from(latest?.keys ?? []).sort()).toEqual([
      'ws/a',
      'ws/b',
      'ws/c',
    ]);
    expect(latest?.active).toBe(true);

    const fewer: SidebarSelectionRows = new Map([
      ['ws', [row('ws/a'), row('ws/c')]],
    ]);
    act(() => root.render(<Probe rows={fewer} />));
    expect(Array.from(latest?.keys ?? []).sort()).toEqual(['ws/a', 'ws/c']);

    act(() => latest?.selectAllInList('ws'));
    act(() => latest?.clear());
    expect(latest?.active).toBe(false);
  });

  it('selects only reported selectable rows and drops rows that become unselectable', () => {
    const rows: SidebarSelectionRows = new Map([
      ['ws', [row('ws/a'), row('ws/b', false)]],
    ]);
    act(() => root.render(<Probe rows={rows} />));
    // A row no list reports (a read-only list's menu) or one that can't be
    // removed never enters the selection.
    act(() => latest?.toggle('shared', 'shared/x'));
    act(() => latest?.toggle('ws', 'ws/b'));
    act(() => latest?.toggle('ws', 'ws/a'));
    expect(Array.from(latest?.keys ?? [])).toEqual(['ws/a']);

    const unselectable: SidebarSelectionRows = new Map([
      ['ws', [row('ws/a', false), row('ws/b', false)]],
    ]);
    act(() => root.render(<Probe rows={unselectable} />));
    expect(latest?.active).toBe(false);
  });

  it('replaces against the rows rendered now, even through an earlier render', () => {
    // A batch's completion calls the `replace` from the render that confirmed
    // it; a kept row that has since stopped rendering must not come back.
    act(() => root.render(<Probe rows={new Map([['ws', WS_ROWS]])} />));
    const confirmTimeReplace = latest?.replace;
    act(() => root.render(<Probe rows={new Map([['ws', [row('ws/a')]]])} />));
    act(() => confirmTimeReplace?.(['ws/a', 'ws/b']));
    expect(Array.from(latest?.keys ?? [])).toEqual(['ws/a']);
  });

  it('keeps one kind: a toggle of another kind replaces, and an unrendered key is a no-op', () => {
    const rows: SidebarSelectionRows = new Map([
      ['ws', [row('ws/a')]],
      ['chats', [row('work-entry:chats/a', true, 'work-entry')]],
    ]);
    act(() => root.render(<Probe rows={rows} />));
    act(() => latest?.toggle('ws', 'ws/a'));
    act(() => latest?.toggle('chats', 'work-entry:chats/a'));
    expect(Array.from(latest?.keys ?? [])).toEqual(['work-entry:chats/a']);
    expect(latest?.kind).toBe('work-entry');
    act(() => latest?.toggle('chats', 'not-rendered'));
    expect(Array.from(latest?.keys ?? [])).toEqual(['work-entry:chats/a']);
  });
});

describe('SIDEBAR_SELECTION_ROW_ATTR', () => {
  it('matches the attribute the shared Work Entry row sets', () => {
    // The outside-click keeper matches rows by this attribute; a drift would
    // make every Work Entry row click clear the selection.
    expect(WORK_ENTRY_SELECTION_ROW_ATTR).toBe(SIDEBAR_SELECTION_ROW_ATTR);
  });
});
