/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useSidebarBulk,
  useSidebarSelectionRows,
  type SidebarBulk,
  type SidebarBulkBinding,
  type SidebarBulkTarget,
} from '../use-sidebar-bulk';
import type {
  SidebarRowKind,
  SidebarSelectionRow,
} from '../sidebar-row-selection';
import type {
  SidebarBulkRowState,
  SidebarBulkStateAction,
} from '../../sidebar-selection-menu-items';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CHATS = { singular: 'chat', plural: 'chats' };

function row(
  key: string,
  kind: SidebarRowKind = 'work-entry',
): SidebarSelectionRow {
  return { key, kind, selectable: true, label: key, projectName: 'Chats' };
}

function fakeBinding(
  overrides: Partial<SidebarBulkBinding> = {},
): SidebarBulkBinding {
  return {
    kinds: ['work-entry'],
    enabled: true,
    remove: () => Promise.resolve(),
    targetFor: (key): SidebarBulkTarget => ({
      key,
      projectName: 'Chats',
      label: key,
    }),
    blockedReasonFor: () => undefined,
    availabilityFor: () => ({
      archive: { enabled: true },
      delete: { enabled: true },
    }),
    unitLabelFor: () => CHATS,
    copyFor: () => ({ retentionSummary: 'Kept', retentionDetail: 'Detail' }),
    branchChoice: false,
    activeKey: undefined,
    dialogTestId: 'bulk-dialog',
    ...overrides,
  };
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('useSidebarBulk (CAN-3975)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: SidebarBulk | undefined;

  function Probe({
    bindings,
  }: {
    bindings: readonly SidebarBulkBinding[];
  }): JSX.Element {
    const selectionRows = useSidebarSelectionRows();
    latest = useSidebarBulk({ ...selectionRows, bindings });
    return (
      <div data-testid="rail">
        {latest.dialog}
        {latest.notice}
      </div>
    );
  }

  function mount(bindings: readonly SidebarBulkBinding[]): () => SidebarBulk {
    act(() => root.render(<Probe bindings={bindings} />));
    return () => {
      if (latest === undefined) throw new Error('Not mounted');
      return latest;
    };
  }

  async function flush(): Promise<void> {
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  function report(
    bulk: () => SidebarBulk,
    rows: readonly SidebarSelectionRow[],
    listId = 'list',
  ): void {
    act(() =>
      bulk()
        .bindingFor(listId)
        .onRowsChange(new Map([[listId, rows]])),
    );
  }

  function select(bulk: () => SidebarBulk, ...keys: string[]): void {
    for (const key of keys) {
      act(() => bulk().bindingFor('list').selection.toggle('list', key));
    }
  }

  function byTestId(testId: string): HTMLElement | null {
    return document.body.querySelector(`[data-testid="${testId}"]`);
  }

  function click(element: HTMLElement | null): void {
    if (element === null) throw new Error('Missing element');
    act(() => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  async function openArchive(
    bulk: () => SidebarBulk,
    key: string,
  ): Promise<void> {
    const menu = bulk().bindingFor('list').menuItemsFor(key);
    act(() =>
      menu.items.find((item) => item.key === 'bulk-archive')?.onSelect?.(),
    );
    await flush();
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = undefined;
  });

  it('opens one confirm for the selection, runs the binding, and clears on success', async () => {
    const removed: string[] = [];
    const bulk = mount([
      fakeBinding({
        remove: (target) => {
          removed.push(target.key);
          return Promise.resolve();
        },
      }),
    ]);
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a', 'b');
    const menu = bulk().bindingFor('list').menuItemsFor('a');
    expect(menu.replacesMenu).toBe(true);
    expect(menu.items.map((item) => item.label)).toContain('Archive 2 chats');
    await openArchive(bulk, 'a');
    expect(byTestId('bulk-dialog')?.textContent).toContain('Archive 2 chats?');
    click(byTestId('bulk-dialog-confirm'));
    await flush();
    expect(removed).toEqual(['a', 'b']);
    expect(bulk().bindingFor('list').selection.active).toBe(false);
    expect(byTestId('bulk-dialog')).toBeNull();
  });

  it('offers Select on one row and nothing for a row no list reports', () => {
    const bulk = mount([fakeBinding()]);
    report(bulk, [row('a')]);
    const menu = bulk().bindingFor('list').menuItemsFor('a', {
      toggleSelection: 'a-toggle',
    });
    expect(menu.replacesMenu).toBe(false);
    expect(menu.items.map((item) => [item.label, item.testId])).toEqual([
      ['Select', 'a-toggle'],
    ]);
    expect(bulk().bindingFor('list').menuItemsFor('zzz').items).toEqual([]);
  });

  it('uses the binding whose kinds match the selection', async () => {
    const worktreeAvailability = jest.fn(() => ({
      archive: { enabled: true },
      delete: { enabled: true },
    }));
    const chatAvailability = jest.fn(() => ({
      archive: { enabled: true },
      delete: { enabled: true },
    }));
    const bulk = mount([
      fakeBinding({
        kinds: ['worktree'],
        availabilityFor: worktreeAvailability,
        dialogTestId: 'worktree-dialog',
      }),
      fakeBinding({
        availabilityFor: chatAvailability,
        dialogTestId: 'chat-dialog',
      }),
    ]);
    report(bulk, [row('w', 'worktree'), row('a'), row('b')]);
    select(bulk, 'a', 'b');
    await openArchive(bulk, 'a');
    expect(chatAvailability).toHaveBeenCalled();
    expect(worktreeAvailability).not.toHaveBeenCalled();
    expect(byTestId('chat-dialog')).not.toBeNull();
    expect(byTestId('worktree-dialog')).toBeNull();
  });

  it('a disabled binding keeps its rows out of the selection', () => {
    const bulk = mount([fakeBinding({ enabled: false })]);
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a');
    expect(bulk().bindingFor('list').selection.active).toBe(false);
    expect(bulk().bindingFor('list').menuItemsFor('a').items).toEqual([]);
  });

  it('a withdrawn binding drops an unconfirmed dialog and stops a running queue after its in-flight item', async () => {
    const first = deferred();
    const remove = jest.fn(() => first.promise);
    const bulk = mount([fakeBinding({ remove })]);
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a', 'b');
    await openArchive(bulk, 'a');
    expect(byTestId('bulk-dialog')).not.toBeNull();
    act(() =>
      root.render(
        <Probe bindings={[fakeBinding({ enabled: false, remove })]} />,
      ),
    );
    expect(byTestId('bulk-dialog')).toBeNull();

    act(() => root.render(<Probe bindings={[fakeBinding({ remove })]} />));
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a', 'b');
    await openArchive(bulk, 'a');
    click(byTestId('bulk-dialog-confirm'));
    act(() =>
      root.render(
        <Probe bindings={[fakeBinding({ enabled: false, remove })]} />,
      ),
    );
    // The confirm closed at once; the queue reports its progress instead.
    expect(byTestId('bulk-dialog')).toBeNull();
    expect(byTestId('worktree-batch-removal-notice')).not.toBeNull();
    await act(async () => {
      first.resolve();
      await first.promise;
    });
    await flush();
    // The host withdrew: the second item never starts.
    expect(remove).toHaveBeenCalledTimes(1);
    expect(byTestId('worktree-batch-removal-notice')?.textContent).toContain(
      '1 not started',
    );
  });

  it('runs a confirmed batch in the background: rows queued, selection cleared, notice with Stop', async () => {
    const pending = [deferred(), deferred(), deferred()];
    const removed: string[] = [];
    const bulk = mount([
      fakeBinding({
        remove: (target) => {
          removed.push(target.key);
          return pending[removed.length - 1]?.promise ?? Promise.resolve();
        },
      }),
    ]);
    report(bulk, [row('a'), row('b'), row('c')]);
    select(bulk, 'a', 'b', 'c');
    await openArchive(bulk, 'a');
    click(byTestId('bulk-dialog-confirm'));
    await flush();
    expect(byTestId('bulk-dialog')).toBeNull();
    expect(bulk().bindingFor('list').selection.active).toBe(false);
    expect(bulk().isQueuedForRemoval('a')).toBe(true);
    expect(bulk().bindingFor('list').isRemoving('c')).toBe(true);
    // A queued row can't join a new selection.
    select(bulk, 'b');
    expect(bulk().bindingFor('list').selection.active).toBe(false);
    expect(byTestId('worktree-batch-removal-notice')?.textContent).toContain(
      'Archiving chats',
    );
    click(byTestId('worktree-batch-removal-notice-stop'));
    await act(async () => {
      pending[0]?.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(removed).toEqual(['a']);
    // Stopped: the dropped rows return to normal.
    expect(bulk().isQueuedForRemoval('b')).toBe(false);
    expect(byTestId('worktree-batch-removal-notice')?.textContent).toContain(
      '2 not started',
    );
    click(byTestId('worktree-batch-removal-notice-details'));
    await flush();
    expect(byTestId('bulk-dialog')?.textContent).toContain(
      '1 archived, 2 not started',
    );
    click(byTestId('bulk-dialog-done'));
    expect(byTestId('bulk-dialog')).toBeNull();
    expect(byTestId('worktree-batch-removal-notice')).toBeNull();
  });

  it('appends a second kind to the running queue and removes each through its own binding', async () => {
    const first = deferred();
    const calls: string[] = [];
    const bulk = mount([
      fakeBinding({
        kinds: ['worktree'],
        unitLabelFor: () => ({ singular: 'worktree', plural: 'worktrees' }),
        remove: (target) => {
          calls.push(`worktree:${target.key}`);
          return first.promise;
        },
      }),
      fakeBinding({
        remove: (target) => {
          calls.push(`chat:${target.key}`);
          return Promise.resolve();
        },
      }),
    ]);
    report(bulk, [
      row('w1', 'worktree'),
      row('w2', 'worktree'),
      row('a'),
      row('b'),
    ]);
    select(bulk, 'w1', 'w2');
    await openArchive(bulk, 'w1');
    click(byTestId('bulk-dialog-confirm'));
    await flush();
    expect(byTestId('worktree-batch-removal-notice')?.textContent).toContain(
      'Archiving worktrees',
    );
    select(bulk, 'a', 'b');
    await openArchive(bulk, 'a');
    click(byTestId('bulk-dialog-confirm'));
    await flush();
    expect(byTestId('worktree-batch-removal-notice')?.textContent).toContain(
      'Archiving items',
    );
    await act(async () => {
      first.resolve();
      await first.promise;
    });
    await flush();
    expect(calls).toEqual(['worktree:w1', 'worktree:w2', 'chat:a', 'chat:b']);
    // Everything succeeded: the notice goes away on its own.
    expect(byTestId('worktree-batch-removal-notice')).toBeNull();
  });

  it('reports rows draining in the background to their binding, then null', async () => {
    const pending = deferred();
    const onStateChange = jest.fn();
    const bulk = mount([
      fakeBinding({ onStateChange, remove: () => pending.promise }),
    ]);
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a', 'b');
    await openArchive(bulk, 'a');
    click(byTestId('bulk-dialog-confirm'));
    await flush();
    expect(onStateChange).toHaveBeenLastCalledWith({
      open: false,
      mode: 'archive',
      count: 2,
      phase: 'running',
    });
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    await flush();
    expect(onStateChange).toHaveBeenLastCalledWith(null);
  });

  it('a queued batch keeps its binding after the list stops reporting rows', async () => {
    const pending = [deferred(), deferred()];
    const removed: string[] = [];
    const bulk = mount([
      fakeBinding({
        remove: (target) => {
          removed.push(target.key);
          return pending[removed.length - 1]?.promise ?? Promise.resolve();
        },
      }),
    ]);
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a', 'b');
    await openArchive(bulk, 'a');
    click(byTestId('bulk-dialog-confirm'));
    // The list stops reporting rows (a collapsed nav) while the queue runs.
    report(bulk, []);
    await act(async () => {
      pending[0]?.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      pending[1]?.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(removed).toEqual(['a', 'b']);
    expect(byTestId('bulk-dialog')).toBeNull();
  });

  it('a click inside the batch dialog does not clear the selection', async () => {
    const bulk = mount([fakeBinding()]);
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a', 'b');
    await openArchive(bulk, 'a');
    const dialog = byTestId('bulk-dialog');
    if (dialog === null) throw new Error('Missing dialog');
    act(() => {
      dialog.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });
    expect(bulk().bindingFor('list').selection.active).toBe(true);
  });

  it('reports the open dialog to its binding and null when it closes', async () => {
    const onStateChange = jest.fn();
    const bulk = mount([fakeBinding({ onStateChange })]);
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a', 'b');
    await openArchive(bulk, 'a');
    expect(onStateChange).toHaveBeenLastCalledWith({
      open: true,
      mode: 'archive',
      count: 2,
      phase: 'confirm',
    });
    click(byTestId('bulk-dialog-cancel'));
    expect(onStateChange).toHaveBeenLastCalledWith(null);
  });

  it('offers the state actions every row offers and runs only rows that need them', async () => {
    const states: Record<string, SidebarBulkRowState> = {
      a: { pinned: true, hideable: true },
      b: { pinned: false, hideable: true },
      c: { pinned: false },
    };
    const applied: [string, SidebarBulkStateAction][] = [];
    const bulk = mount([
      fakeBinding({
        rowStateFor: (key) => states[key],
        applyStateAction: (target, action) => {
          applied.push([target.key, action]);
          return Promise.resolve();
        },
      }),
    ]);
    report(bulk, [row('a'), row('b'), row('c')]);
    select(bulk, 'a', 'b');
    const menu = bulk().bindingFor('list').rowMenuFor('a');
    expect(menu?.bulk?.stateActions).toEqual({
      pin: { pinned: true },
      hide: true,
    });
    const items = bulk().bindingFor('list').menuItemsFor('a').items;
    expect(items.map((item) => item.label)).toEqual([
      'Pin 2 chats',
      'Hide 2 chats',
      'Archive 2 chats',
      'Delete 2 chats',
      'Clear selection',
    ]);
    act(() => items[0]?.onSelect?.());
    await flush();
    expect(applied).toEqual([['b', { kind: 'pin', pinned: true }]]);
    // The selection stays for the next action.
    expect(bulk().bindingFor('list').selection.count).toBe(2);

    // Add c (use the toggle helper if `select` replaces): it offers no Hide.
    select(bulk, 'c');
    expect(bulk().bindingFor('list').selection.count).toBe(3);
    expect(
      bulk().bindingFor('list').rowMenuFor('a')?.bulk?.stateActions,
    ).toEqual({ pin: { pinned: true } });
  });

  it('a failing row does not stop the rest', async () => {
    const applied: string[] = [];
    const bulk = mount([
      fakeBinding({
        rowStateFor: () => ({ pinned: false }),
        applyStateAction: (target) => {
          applied.push(target.key);
          return target.key === 'a'
            ? Promise.reject(new Error('nope'))
            : Promise.resolve();
        },
      }),
    ]);
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a', 'b');
    act(() =>
      bulk().bindingFor('list').rowMenuFor('a')?.bulk?.onStateAction({
        kind: 'pin',
        pinned: true,
      }),
    );
    await flush();
    expect(applied).toEqual(['a', 'b']);
  });

  it('offers no state actions while a batch runs', async () => {
    const removal = deferred();
    const bulk = mount([
      fakeBinding({
        remove: () => removal.promise,
        rowStateFor: () => ({ pinned: false }),
        applyStateAction: () => undefined,
      }),
    ]);
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a', 'b');
    await openArchive(bulk, 'a');
    click(byTestId('bulk-dialog-confirm'));
    await flush();
    const menu = bulk().bindingFor('list').rowMenuFor('a');
    // The core either keeps the locked selection (empty state actions) or
    // drops the selection menu while the batch runs; both satisfy the rule.
    expect(menu?.bulk?.stateActions ?? {}).toEqual({});
    removal.resolve();
    await flush();
  });

  it('a binding without a runner offers no state actions', () => {
    const bulk = mount([
      fakeBinding({ rowStateFor: () => ({ pinned: false }) }),
    ]);
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a', 'b');
    expect(
      bulk().bindingFor('list').rowMenuFor('a')?.bulk?.stateActions,
    ).toEqual({});
  });

  it('a gone row makes the selection offer nothing', () => {
    const bulk = mount([
      fakeBinding({
        rowStateFor: (key) => (key === 'a' ? { pinned: false } : undefined),
        applyStateAction: () => undefined,
      }),
    ]);
    report(bulk, [row('a'), row('b')]);
    select(bulk, 'a', 'b');
    expect(
      bulk().bindingFor('list').rowMenuFor('a')?.bulk?.stateActions,
    ).toEqual({});
  });

  it('requests unknown row state once per selection', () => {
    const requested: string[] = [];
    const bulk = mount([
      fakeBinding({
        rowStateFor: () => ({}),
        requestRowState: (key) => requested.push(key),
      }),
    ]);
    report(bulk, [row('a'), row('b'), row('c')]);
    select(bulk, 'a');
    expect(requested).toEqual([]);
    select(bulk, 'b');
    expect(requested).toEqual(['a', 'b']);
    // An unrelated render asks again for nothing.
    report(bulk, [row('a'), row('b'), row('c')]);
    expect(requested).toEqual(['a', 'b']);
  });
});
