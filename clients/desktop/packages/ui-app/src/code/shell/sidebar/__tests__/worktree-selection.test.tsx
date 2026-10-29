/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  EMPTY_WORKTREE_SELECTION,
  isWorktreeSelectable,
  useWorktreeSelection,
  worktreeSelectionReducer,
  type WorktreeSelection,
  type WorktreeSelectionAction,
  type WorktreeSelectionRow,
  type WorktreeSelectionRows,
  type WorktreeSelectionState,
} from '../worktree-selection';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const row = (key: string, selectable = true): WorktreeSelectionRow => ({
  key,
  selectable,
});

// Rendered order of one workspace, nesting included: `ws/b` is a nested
// child of `ws/a`. A collapsed group's children are simply absent.
const WS_ROWS = [row('ws/a'), row('ws/b'), row('ws/c'), row('ws/d')];

function reduce(...actions: WorktreeSelectionAction[]): WorktreeSelectionState {
  let state = EMPTY_WORKTREE_SELECTION;
  for (const action of actions) state = worktreeSelectionReducer(state, action);
  return state;
}

const keysOf = (state: WorktreeSelectionState): string[] =>
  Array.from(state.keys).sort();

describe('worktreeSelectionReducer', () => {
  it('toggles a key on and off and anchors at the toggled row', () => {
    const on = reduce({ type: 'toggle', workspaceLocalId: 'ws', key: 'ws/b' });
    expect(keysOf(on)).toEqual(['ws/b']);
    expect(on.anchor).toEqual({ workspaceLocalId: 'ws', key: 'ws/b' });
    const off = worktreeSelectionReducer(on, {
      type: 'toggle',
      workspaceLocalId: 'ws',
      key: 'ws/b',
    });
    expect(keysOf(off)).toEqual([]);
    expect(off.anchor).toEqual({ workspaceLocalId: 'ws', key: 'ws/b' });
  });

  it('selects a range in rendered order in either direction, keeping the anchor', () => {
    const forward = reduce(
      { type: 'toggle', workspaceLocalId: 'ws', key: 'ws/a' },
      {
        type: 'selectRange',
        workspaceLocalId: 'ws',
        key: 'ws/c',
        rows: WS_ROWS,
      },
    );
    expect(keysOf(forward)).toEqual(['ws/a', 'ws/b', 'ws/c']);
    expect(forward.anchor?.key).toBe('ws/a');

    const backward = reduce(
      { type: 'toggle', workspaceLocalId: 'ws', key: 'ws/d' },
      {
        type: 'selectRange',
        workspaceLocalId: 'ws',
        key: 'ws/b',
        rows: WS_ROWS,
      },
    );
    expect(keysOf(backward)).toEqual(['ws/b', 'ws/c', 'ws/d']);
  });

  it('leaves out rows that are not rendered or not selectable', () => {
    const collapsed = [row('ws/a'), row('ws/c', false), row('ws/d')];
    const state = reduce(
      { type: 'toggle', workspaceLocalId: 'ws', key: 'ws/a' },
      {
        type: 'selectRange',
        workspaceLocalId: 'ws',
        key: 'ws/d',
        rows: collapsed,
      },
    );
    expect(keysOf(state)).toEqual(['ws/a', 'ws/d']);
  });

  it('selects just the row and anchors there when there is no anchor', () => {
    const state = reduce({
      type: 'selectRange',
      workspaceLocalId: 'ws',
      key: 'ws/c',
      rows: WS_ROWS,
    });
    expect(keysOf(state)).toEqual(['ws/c']);
    expect(state.anchor).toEqual({ workspaceLocalId: 'ws', key: 'ws/c' });
  });

  it('resets the anchor when the range is in another workspace', () => {
    const other = [row('other/x'), row('other/y')];
    const state = reduce(
      { type: 'toggle', workspaceLocalId: 'ws', key: 'ws/a' },
      {
        type: 'selectRange',
        workspaceLocalId: 'other',
        key: 'other/y',
        rows: other,
      },
    );
    expect(keysOf(state)).toEqual(['other/y', 'ws/a']);
    expect(state.anchor).toEqual({ workspaceLocalId: 'other', key: 'other/y' });
  });

  it('selects every selectable row of one workspace', () => {
    const state = reduce(
      { type: 'toggle', workspaceLocalId: 'other', key: 'other/x' },
      {
        type: 'selectAllInWorkspace',
        rows: [row('ws/a'), row('ws/b', false), row('ws/c')],
      },
    );
    expect(keysOf(state)).toEqual(['other/x', 'ws/a', 'ws/c']);
  });

  it('prunes keys no longer rendered and clears a pruned anchor', () => {
    const selected = reduce(
      { type: 'toggle', workspaceLocalId: 'ws', key: 'ws/a' },
      { type: 'toggle', workspaceLocalId: 'ws', key: 'ws/b' },
    );
    const pruned = worktreeSelectionReducer(selected, {
      type: 'prune',
      visibleKeys: new Set(['ws/a', 'ws/c']),
    });
    expect(keysOf(pruned)).toEqual(['ws/a']);
    expect(pruned.anchor).toBeUndefined();
  });

  it('returns the same state when a prune changes nothing', () => {
    const selected = reduce({
      type: 'toggle',
      workspaceLocalId: 'ws',
      key: 'ws/a',
    });
    expect(
      worktreeSelectionReducer(selected, {
        type: 'prune',
        visibleKeys: new Set(['ws/a', 'ws/b']),
      }),
    ).toBe(selected);
  });

  it('replaces the selection with the rendered keys it is given', () => {
    const state = reduce(
      { type: 'toggle', workspaceLocalId: 'ws', key: 'ws/a' },
      {
        type: 'replace',
        keys: ['ws/b', 'ws/gone'],
        visibleKeys: new Set(['ws/a', 'ws/b']),
      },
    );
    expect(keysOf(state)).toEqual(['ws/b']);
  });

  it('clears everything', () => {
    const state = reduce(
      { type: 'toggle', workspaceLocalId: 'ws', key: 'ws/a' },
      { type: 'clear' },
    );
    expect(state).toBe(EMPTY_WORKTREE_SELECTION);
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

  it.each([
    ['a session row', { subject: 'session' }],
    ['a row without removal', { worktreeRemoval: false }],
    ['a row with unknown removal', { worktreeRemoval: undefined }],
    ['a gated workspace', { commandsDisabled: true }],
    ['a hidden row', { hidden: true }],
    ['a row mid-removal', { removalInProgress: true }],
  ] as const)('rejects %s', (_name, override) => {
    expect(isWorktreeSelectable({ ...base, ...override })).toBe(false);
  });
});

describe('useWorktreeSelection', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: WorktreeSelection | undefined;

  function Probe({ rows }: { rows: WorktreeSelectionRows }): JSX.Element {
    latest = useWorktreeSelection(rows);
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
    const rows: WorktreeSelectionRows = new Map([['ws', WS_ROWS]]);
    act(() => root.render(<Probe rows={rows} />));
    act(() => latest?.toggle('ws', 'ws/a'));
    act(() => latest?.selectRange('ws', 'ws/c'));
    expect(Array.from(latest?.keys ?? []).sort()).toEqual([
      'ws/a',
      'ws/b',
      'ws/c',
    ]);
    expect(latest?.active).toBe(true);

    const fewer: WorktreeSelectionRows = new Map([
      ['ws', [row('ws/a'), row('ws/c')]],
    ]);
    act(() => root.render(<Probe rows={fewer} />));
    expect(Array.from(latest?.keys ?? []).sort()).toEqual(['ws/a', 'ws/c']);

    act(() => latest?.selectAllInWorkspace('ws'));
    act(() => latest?.clear());
    expect(latest?.active).toBe(false);
  });

  it('selects only reported selectable rows and drops rows that become unselectable', () => {
    const rows: WorktreeSelectionRows = new Map([
      ['ws', [row('ws/a'), row('ws/b', false)]],
    ]);
    act(() => root.render(<Probe rows={rows} />));
    // A row no list reports (a read-only list's menu) or one that can't be
    // removed never enters the selection.
    act(() => latest?.toggle('shared', 'shared/x'));
    act(() => latest?.toggle('ws', 'ws/b'));
    act(() => latest?.toggle('ws', 'ws/a'));
    expect(Array.from(latest?.keys ?? [])).toEqual(['ws/a']);

    const unselectable: WorktreeSelectionRows = new Map([
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
});
