/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';
import {
  SidebarSurface,
  type SidebarSurfaceProps,
  type SidebarSurfaceSnapshot,
} from '../SidebarSurface';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const capabilities: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
  workspaceCreation: 'remote-clone',
  workspaceReordering: false,
  worktreeReordering: false,
  workspaceSettings: false,
  worktreeRemoval: 'archive',
  worktreeRetention: 'archive-or-delete',
};

const snapshot: SidebarSurfaceSnapshot = {
  workspaces: [
    { localId: 'workspace', name: 'Workspace', type: 'single-repo' as const },
  ],
  worktrees: ['alpha', 'beta', 'gamma', 'delta'].map((id, order) => ({
    localId: id,
    workspaceLocalId: 'workspace',
    branch: `${id}-branch`,
    order,
  })),
  standaloneChats: [],
};

const pinnedSnapshot = {
  ...snapshot,
  worktrees: snapshot.worktrees.map((worktree) =>
    worktree.localId === 'alpha' ? { ...worktree, pinned: true } : worktree,
  ),
} satisfies SidebarSurfaceSnapshot;

describe('SidebarSurface bulk selection (CAN-3975)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    props: Partial<SidebarSurfaceProps> = {},
    nextSnapshot: SidebarSurfaceSnapshot = snapshot,
  ): void {
    act(() => {
      root.render(
        <SidebarSurface
          variant="rail"
          snapshot={nextSnapshot}
          selection={{ kind: 'workspace', workspaceLocalId: 'workspace' }}
          capabilities={capabilities}
          contentState="ready"
          onSelect={() => undefined}
          onArchiveWorktree={jest.fn()}
          worktreeRetentionDaysFor={(): number => 7}
          {...props}
        />,
      );
    });
  }

  async function flush(): Promise<void> {
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  function rowFrame(id: string): HTMLElement {
    const row = container.querySelector(
      `[data-worktree-id="${id}"]:not([data-testid$="-sticky-slot"])`,
    );
    const frame = row?.closest<HTMLElement>('[data-sidebar-variant="bare"]');
    if (!frame) throw new Error(`Missing row ${id}`);
    return frame;
  }

  function rowElement(id: string): HTMLElement {
    const row = rowFrame(id).querySelector<HTMLElement>(
      `[data-worktree-id="${id}"]`,
    );
    if (!row) throw new Error(`Missing row element ${id}`);
    return row;
  }

  function checked(id: string): boolean {
    return rowElement(id).getAttribute('data-multiselected') === 'true';
  }

  function selectedCount(): number {
    return ['alpha', 'beta', 'gamma', 'delta'].filter(checked).length;
  }

  function openMenu(id: string): void {
    act(() => {
      rowFrame(id).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
  }

  function menuItem(testId: string): HTMLButtonElement | null {
    return document.body.querySelector<HTMLButtonElement>(
      `[data-testid="portal-worktree-actions-${testId}"]`,
    );
  }

  /**
   * Runs a bulk action from a selected row's right-click menu, then waits for
   * the batch dialog, which loads on demand.
   */
  async function bulk(id: string, action: 'archive' | 'delete'): Promise<void> {
    openMenu(id);
    const item = menuItem(`bulk-${action}`);
    if (!item) throw new Error(`Missing bulk ${action}`);
    click(item);
    await flush();
  }

  function pointerDown(target: Element, button = 0): void {
    act(() => {
      target.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button }),
      );
    });
  }

  function dialog(): HTMLElement | null {
    return document.body.querySelector(
      '[data-testid="worktree-batch-removal-dialog"]',
    );
  }

  function click(element: HTMLElement, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      element.dispatchEvent(event);
    });
    return event;
  }

  /** Cmd-click on macOS, Ctrl-click elsewhere: both set, either platform. */
  function toggle(id: string): MouseEvent {
    return click(rowFrame(id), { metaKey: true, ctrlKey: true });
  }

  function key(element: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      element.dispatchEvent(event);
    });
    return event;
  }

  function buttonIn(scope: ParentNode, testId: string): HTMLButtonElement {
    const button = scope.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (!button) throw new Error(`Missing ${testId}`);
    return button;
  }

  it('offers nothing without a host batch removal: no checkbox, and a modified click navigates', () => {
    const onSelect = jest.fn();
    render({ onSelect });
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="worktree-row-select-column"]'),
    ).toBeNull();
    toggle('alpha');
    expect(onSelect).toHaveBeenCalled();
    expect(checked('alpha')).toBe(false);
    expect(selectedCount()).toBe(0);
  });

  it('renders rows without a checkbox, selecting by highlight only', () => {
    render({ onRemoveWorktreeInBatch: jest.fn() });
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    toggle('alpha');
    expect(checked('alpha')).toBe(true);
    expect(rowElement('alpha').className).toContain('bg-accent-subtle');
  });

  it("selects from the row menu's Select, which names the Ctrl/Cmd-click shortcut", () => {
    const onSelect = jest.fn();
    render({ onSelect, onRemoveWorktreeInBatch: jest.fn() });
    openMenu('alpha');
    const item = menuItem('toggle-selection');
    if (!item) throw new Error('Missing Select');
    expect(item.textContent).toContain('Select');
    // jsdom reports no macOS platform, so the shortcut reads Ctrl Click.
    expect(
      item.querySelector('[data-testid="worktree-menu-item-shortcut"]')
        ?.textContent,
    ).toBe('Ctrl Click');
    click(item);
    expect(checked('alpha')).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    expect(selectedCount()).toBe(1);
    expect(
      container.querySelector('[data-testid="worktree-selection-bar"]'),
    ).toBeNull();
  });

  it('ends the selection on a click anywhere outside its rows, menus, and dialogs', () => {
    render({ onRemoveWorktreeInBatch: jest.fn() });
    const elsewhere = document.createElement('div');
    elsewhere.setAttribute('data-testid', 'chat-tab');
    document.body.appendChild(elsewhere);
    toggle('alpha');
    toggle('beta');
    // A right-click elsewhere, or a press on a selected row (the start of a
    // drag), keeps it.
    pointerDown(elsewhere, 2);
    pointerDown(rowElement('alpha'));
    expect(selectedCount()).toBe(2);
    // So does a press inside a menu acting on it.
    openMenu('alpha');
    const clearItem = menuItem('clear-selection');
    if (!clearItem) throw new Error('Missing Clear selection');
    pointerDown(clearItem);
    expect(selectedCount()).toBe(2);
    click(clearItem);
    expect(selectedCount()).toBe(0);

    toggle('gamma');
    pointerDown(elsewhere);
    expect(selectedCount()).toBe(0);
    elsewhere.remove();
  });

  it('keeps the selection on a press over a row that is being removed', () => {
    render({
      onRemoveWorktreeInBatch: jest.fn(),
      isWorktreeRemovalInProgress: (_workspace, worktree) =>
        worktree === 'gamma',
    });
    toggle('alpha');
    toggle('beta');
    // An inert row takes no events: a press over it lands on its container.
    const removing = rowFrame('gamma');
    expect(removing.hasAttribute('inert')).toBe(true);
    jest
      .spyOn(removing, 'getBoundingClientRect')
      .mockReturnValue(
        DOMRect.fromRect({ x: 0, y: 100, width: 240, height: 40 }),
      );
    const container = removing.parentElement;
    if (!container) throw new Error('Missing row container');
    act(() => {
      container.dispatchEvent(
        new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 20,
          clientY: 120,
        }),
      );
    });
    expect(selectedCount()).toBe(2);
    act(() => {
      container.dispatchEvent(
        new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 20,
          clientY: 400,
        }),
      );
    });
    expect(selectedCount()).toBe(0);
  });

  it("puts a 2+ selection's actions in its rows' right-click menu, leaving out what no row offers", () => {
    render({
      onRemoveWorktreeInBatch: jest.fn(),
      capabilitiesFor: () => ({
        ...capabilities,
        worktreeRetention: undefined,
      }),
    });
    toggle('alpha');
    openMenu('alpha');
    // One selected row keeps its own menu.
    expect(menuItem('bulk-archive')).toBeNull();
    expect(menuItem('toggle-selection')?.textContent).toContain('Deselect');
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    toggle('beta');
    openMenu('beta');
    expect(menuItem('bulk-archive')?.textContent).toContain(
      'Archive 2 worktrees',
    );
    expect(menuItem('bulk-delete')).toBeNull();
    expect(menuItem('clear-selection')).not.toBeNull();
  });

  it('keeps a Shift-click range from selecting row text', () => {
    render({ onRemoveWorktreeInBatch: jest.fn() });
    // Browsers select text on the mousedown, before the click that ranges.
    const press = (init: MouseEventInit): MouseEvent => {
      const event = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      act(() => {
        rowFrame('gamma').dispatchEvent(event);
      });
      return event;
    };
    expect(press({ shiftKey: true }).defaultPrevented).toBe(true);
    expect(press({}).defaultPrevented).toBe(false);
  });

  it('toggles on Cmd/Ctrl-click, ranges on Shift-click, and a plain click navigates and ends the selection', () => {
    const onSelect = jest.fn();
    render({ onSelect, onRemoveWorktreeInBatch: jest.fn() });
    const toggle = click(rowFrame('alpha'), { metaKey: true, ctrlKey: true });
    expect(toggle.defaultPrevented).toBe(true);
    expect(checked('alpha')).toBe(true);
    const range = click(rowFrame('gamma'), { shiftKey: true });
    expect(range.defaultPrevented).toBe(true);
    expect(['alpha', 'beta', 'gamma', 'delta'].map(checked)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(onSelect).not.toHaveBeenCalled();
    click(rowFrame('delta'));
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'worktree',
      workspaceLocalId: 'workspace',
      worktreeLocalId: 'delta',
    });
    // A plain click leaves bulk mode: the selection clears.
    expect(['alpha', 'beta', 'gamma', 'delta'].map(checked)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('ends the selection on a plain click of a row that is itself selected', () => {
    const onSelect = jest.fn();
    render({ onSelect, onRemoveWorktreeInBatch: jest.fn() });
    toggle('alpha');
    toggle('beta');
    click(rowFrame('alpha'));
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'worktree',
      workspaceLocalId: 'workspace',
      worktreeLocalId: 'alpha',
    });
    expect(checked('alpha')).toBe(false);
    expect(checked('beta')).toBe(false);
  });

  it('handles x, Cmd/Ctrl+A, and Esc only on the focused row itself', () => {
    render({ onRemoveWorktreeInBatch: jest.fn() });
    key(rowFrame('beta'), { key: 'x' });
    expect(checked('beta')).toBe(true);
    // A key from a nested element is not the row's.
    key(rowElement('alpha'), { key: 'x' });
    expect(checked('alpha')).toBe(false);
    const selectAll = key(rowFrame('beta'), {
      key: 'a',
      metaKey: true,
      ctrlKey: true,
    });
    expect(selectAll.defaultPrevented).toBe(true);
    expect(selectedCount()).toBe(4);
    key(rowFrame('beta'), { key: 'Escape' });
    expect(selectedCount()).toBe(0);
  });

  function notice(): HTMLElement | null {
    return container.querySelector(
      '[data-testid="worktree-batch-removal-notice"]',
    );
  }

  function inert(id: string): boolean {
    return rowFrame(id).hasAttribute('inert');
  }

  /** A remove whose settlement the test controls per worktree id. */
  function deferredRemove(): {
    remove: jest.Mock<Promise<void>, [string, string]>;
    settle: (id: string, error?: Error) => Promise<void>;
    calls: () => string[];
  } {
    const pending = new Map<
      string,
      { resolve: () => void; reject: (error: Error) => void }
    >();
    const remove = jest.fn(
      (_workspace: string, worktree: string) =>
        new Promise<void>((resolve, reject) => {
          pending.set(worktree, { resolve, reject });
        }),
    );
    const settle = async (id: string, error?: Error): Promise<void> => {
      const entry = pending.get(id);
      if (!entry) throw new Error(`no pending removal for ${id}`);
      pending.delete(id);
      await act(async () => {
        if (error) entry.reject(error);
        else entry.resolve();
        await Promise.resolve();
      });
      await flush();
    };
    return {
      remove,
      settle,
      calls: (): string[] => remove.mock.calls.map((call) => call[1]),
    };
  }

  async function confirmBatch(
    ids: readonly string[],
    action: 'archive' | 'delete',
  ): Promise<void> {
    for (const id of ids) toggle(id);
    const [first] = ids;
    if (first === undefined) throw new Error('No rows to confirm');
    await bulk(first, action);
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-confirm'));
    await flush();
  }

  it('confirms once, closes at once, and removes in the background with the open worktree last', async () => {
    const { remove, settle, calls } = deferredRemove();
    render({
      onRemoveWorktreeInBatch: remove,
      selection: {
        kind: 'worktree',
        workspaceLocalId: 'workspace',
        worktreeLocalId: 'alpha',
      },
    });
    toggle('alpha');
    toggle('beta');
    await bulk('alpha', 'delete');
    expect(dialog()?.textContent).toContain('Delete 2 worktrees?');
    expect(remove).not.toHaveBeenCalled();
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-confirm'));
    await flush();
    // The dialog closes while the first removal is still under way.
    expect(dialog()).toBeNull();
    expect(selectedCount()).toBe(0);
    expect(notice()?.textContent).toContain('Deleting worktrees');
    expect(notice()?.textContent).toContain('0 of 2 done.');
    for (const id of ['alpha', 'beta']) {
      expect(inert(id)).toBe(true);
      expect(rowFrame(id).getAttribute('aria-disabled')).toBe('true');
    }
    expect(calls()).toEqual(['beta']);
    expect(remove).toHaveBeenCalledWith('workspace', 'beta', {
      mode: 'delete',
      expectedBranchName: 'beta-branch',
    });
    await settle('beta');
    expect(calls()).toEqual(['beta', 'alpha']);
    expect(notice()?.textContent).toContain('1 of 2 done.');
    // All-success shows nothing: the footer callout leaves with its notice,
    // never emptied first for the render before the reset effect.
    const emptied: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (
          record.removedNodes.length > 0 &&
          record.target instanceof HTMLElement &&
          record.target.matches('[data-testid="sidebar-footer-callout"]')
        ) {
          emptied.push(record.target);
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    await settle('alpha');
    observer.disconnect();
    expect(emptied).toEqual([]);
    expect(notice()).toBeNull();
    expect(inert('alpha')).toBe(false);
    expect(inert('beta')).toBe(false);
  });

  it('lists a working worktree under Not included and removes only the rest', async () => {
    const remove = jest.fn<
      Promise<void>,
      [workspace: string, worktree: string]
    >(() => Promise.resolve());
    render({
      onRemoveWorktreeInBatch: remove,
      hasActiveWorktreeSession: (_workspace, worktree) => worktree === 'beta',
    });
    toggle('alpha');
    toggle('beta');
    toggle('gamma');
    await bulk('alpha', 'delete');
    const confirm = dialog();
    expect(confirm?.textContent).toContain('Delete 2 worktrees?');
    expect(confirm?.textContent).toContain('Not included (1)');
    expect(confirm?.textContent).toContain(
      'Stop all sessions before archiving',
    );
    expect(confirm?.textContent).toContain('Restorable for 7 days');
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-confirm'));
    await flush();
    expect(remove.mock.calls.map((call) => call[1])).toEqual([
      'alpha',
      'gamma',
    ]);
    // The confirm ends the selection; the Not included row is retried from
    // its own menu once its session stops.
    expect(dialog()).toBeNull();
    expect(selectedCount()).toBe(0);
    expect(notice()).toBeNull();
  });

  it('reports a partial failure in the notice and does not re-select the failed worktree', async () => {
    const { remove, settle } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta'], 'archive');
    await settle('alpha');
    await settle('beta', new Error('Teardown script failed.'));
    expect(notice()?.textContent).toContain('Archived 1 of 2 worktrees');
    expect(notice()?.textContent).toContain('1 failed.');
    expect(selectedCount()).toBe(0);
    expect(inert('beta')).toBe(false);
    click(buttonIn(container, 'worktree-batch-removal-notice-details'));
    await flush();
    const results = dialog();
    expect(results?.textContent).toContain('1 archived, 1 failed');
    const failed = results?.querySelector('[data-status="failed"]');
    expect(failed?.textContent).toContain('Teardown script failed.');
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-done'));
    await flush();
    expect(dialog()).toBeNull();
    expect(notice()).toBeNull();
    expect(selectedCount()).toBe(0);
  });

  it('keeps the confirmed names on rows that leave the rail mid-batch', async () => {
    const { remove, settle } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta'], 'archive');
    await settle('alpha');
    // Desktop drops a removed row from the snapshot as soon as it archives.
    render(
      { onRemoveWorktreeInBatch: remove },
      {
        ...snapshot,
        worktrees: snapshot.worktrees.filter(
          (worktree) => worktree.localId !== 'alpha',
        ),
      },
    );
    await settle('beta', new Error('Teardown script failed.'));
    click(buttonIn(container, 'worktree-batch-removal-notice-details'));
    await flush();
    const results = dialog();
    expect(results?.textContent).toContain('1 archived, 1 failed');
    expect(results?.textContent).toContain('alpha-branch');
    expect(results?.textContent).toContain('Workspace');
  });

  it('keeps a running queue visible and starts nothing more once the host removal goes away', async () => {
    const { remove, settle } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta', 'gamma'], 'delete');
    // Web: the desktop disconnected, so the host can't send commands.
    render({ onRemoveWorktreeInBatch: undefined });
    expect(notice()?.textContent).toContain('Deleting worktrees');
    expect(inert('beta')).toBe(true);
    await settle('alpha');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(notice()?.textContent).toContain('Deleted 1 of 3 worktrees');
    expect(notice()?.textContent).toContain('2 not started.');
    expect(inert('beta')).toBe(false);
  });

  it('keeps one queue when its confirm fires twice before re-rendering', async () => {
    const { remove, settle } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    toggle('alpha');
    toggle('beta');
    await bulk('alpha', 'archive');
    const confirmButton = buttonIn(
      document.body,
      'worktree-batch-removal-dialog-confirm',
    );
    act(() => {
      confirmButton.click();
      confirmButton.click();
    });
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(notice()?.textContent).toContain('0 of 2 done.');
    await settle('alpha');
    await settle('beta');
    expect(remove).toHaveBeenCalledTimes(2);
    expect(notice()).toBeNull();
  });

  it('drops an unconfirmed batch when the host removal goes away', async () => {
    const remove = jest.fn((): Promise<void> => Promise.resolve());
    render({ onRemoveWorktreeInBatch: remove });
    toggle('alpha');
    toggle('beta');
    await bulk('alpha', 'archive');
    expect(dialog()).not.toBeNull();
    render({ onRemoveWorktreeInBatch: undefined });
    render({ onRemoveWorktreeInBatch: remove });
    expect(dialog()).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it('appends a second confirmed selection to the running queue', async () => {
    const { remove, settle, calls } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta'], 'delete');
    await confirmBatch(['gamma', 'delta'], 'delete');
    expect(notice()?.textContent).toContain('0 of 4 done.');
    for (const id of ['alpha', 'beta', 'gamma', 'delta']) await settle(id);
    expect(calls()).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    expect(notice()).toBeNull();
  });

  it('keeps queued rows inert: no re-selection, navigation, or menu', async () => {
    const onSelect = jest.fn();
    const { remove } = deferredRemove();
    render({ onSelect, onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta'], 'delete');
    expect(inert('beta')).toBe(true);
    toggle('beta');
    expect(checked('beta')).toBe(false);
    click(rowFrame('beta'));
    expect(onSelect).not.toHaveBeenCalled();
    openMenu('beta');
    expect(menuItem('toggle-selection')).toBeNull();
  });

  it('names rows waiting in the queue, not the one being removed', async () => {
    const { remove, settle } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta'], 'delete');
    await confirmBatch(['gamma', 'delta'], 'archive');
    expect(rowFrame('alpha').textContent).not.toContain('Queued');
    expect(rowFrame('beta').textContent).toContain('Queued for deletion');
    expect(rowFrame('gamma').textContent).toContain('Queued for archiving');
    await settle('alpha');
    expect(rowFrame('beta').textContent).not.toContain('Queued');
    expect(rowFrame('gamma').textContent).toContain('Queued for archiving');
  });

  it('Stop drops the not-started items, reports them, and frees their rows', async () => {
    const { remove, settle } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta', 'gamma'], 'delete');
    const stop = buttonIn(container, 'worktree-batch-removal-notice-stop');
    click(stop);
    expect(stop.textContent).toBe('Stopping…');
    expect(stop.disabled).toBe(true);
    expect(inert('beta')).toBe(true);
    await settle('alpha');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(notice()?.textContent).toContain('Deleted 1 of 3 worktrees');
    expect(notice()?.textContent).toContain('2 not started.');
    expect(inert('beta')).toBe(false);
    expect(inert('gamma')).toBe(false);
    toggle('beta');
    expect(checked('beta')).toBe(true);
    click(buttonIn(container, 'worktree-batch-removal-notice-details'));
    await flush();
    expect(dialog()?.querySelectorAll('[data-status="pending"]').length).toBe(
      2,
    );
    expect(dialog()?.textContent).toContain('1 deleted, 2 not started');
  });

  it('Esc and an outside click clear a new selection but leave the running queue alone', async () => {
    const { remove } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);
    await confirmBatch(['alpha', 'beta'], 'delete');
    toggle('gamma');
    expect(selectedCount()).toBe(1);
    key(rowFrame('gamma'), { key: 'Escape' });
    expect(selectedCount()).toBe(0);
    expect(notice()).not.toBeNull();
    toggle('gamma');
    pointerDown(elsewhere);
    expect(selectedCount()).toBe(0);
    expect(notice()?.textContent).toContain('Deleting worktrees');
    expect(remove).toHaveBeenCalledTimes(1);
    elsewhere.remove();
  });

  it('uses Removing when queued batches mix archive and delete', async () => {
    const { remove } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta'], 'archive');
    expect(notice()?.textContent).toContain('Archiving worktrees');
    await confirmBatch(['gamma', 'delta'], 'delete');
    expect(notice()?.textContent).toContain('Removing worktrees');
  });

  it('reports background progress to the host state callback', async () => {
    const { remove, settle } = deferredRemove();
    const onStateChange = jest.fn();
    render({
      onRemoveWorktreeInBatch: remove,
      onWorktreeBatchRemovalStateChange: onStateChange,
      selection: {
        kind: 'worktree',
        workspaceLocalId: 'workspace',
        worktreeLocalId: 'alpha',
      },
    });
    toggle('alpha');
    toggle('beta');
    await bulk('alpha', 'delete');
    expect(onStateChange).toHaveBeenLastCalledWith({
      open: true,
      mode: 'delete',
      count: 2,
      phase: 'confirm',
    });
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-confirm'));
    await flush();
    expect(onStateChange).toHaveBeenLastCalledWith({
      open: false,
      mode: 'delete',
      count: 2,
      phase: 'running',
    });
    await settle('beta');
    expect(onStateChange).toHaveBeenLastCalledWith({
      open: false,
      mode: 'delete',
      count: 1,
      phase: 'running',
    });
    await settle('alpha');
    expect(onStateChange).toHaveBeenLastCalledWith(null);
  });

  it('refuses a new confirm while Stop is pending', async () => {
    const { remove, settle } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta'], 'delete');
    click(buttonIn(container, 'worktree-batch-removal-notice-stop'));
    toggle('gamma');
    toggle('delta');
    await bulk('gamma', 'delete');
    expect(dialog()).toBeNull();
    await settle('alpha');
    await bulk('gamma', 'delete');
    expect(dialog()?.textContent).toContain('Delete 2 worktrees?');
  });

  it('refuses a confirm that lands while Stop is pending, keeping the dialog open', async () => {
    const { remove, settle, calls } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta'], 'delete');
    toggle('gamma');
    toggle('delta');
    await bulk('gamma', 'delete');
    expect(dialog()?.textContent).toContain('Delete 2 worktrees?');
    click(buttonIn(container, 'worktree-batch-removal-notice-stop'));
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-confirm'));
    await flush();
    // Not enqueued only to be dropped as not started: still confirmable.
    expect(dialog()?.textContent).toContain('Delete 2 worktrees?');
    await settle('alpha');
    expect(calls()).toEqual(['alpha']);
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-confirm'));
    await flush();
    expect(dialog()).toBeNull();
    expect(calls()).toEqual(['alpha', 'gamma']);
  });

  it('retries a failed row from a new selection and clears the notice once the retry succeeds', async () => {
    const { remove, settle } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta'], 'delete');
    await settle('alpha');
    await settle('beta', new Error('Teardown script failed.'));
    expect(notice()?.textContent).toContain('Deleted 1 of 2 worktrees');
    await confirmBatch(['beta', 'gamma'], 'delete');
    // Counted by the latest attempt per worktree.
    expect(notice()?.textContent).toContain('Deleting worktrees');
    expect(notice()?.textContent).toContain('1 of 3 done.');
    await settle('beta');
    await settle('gamma');
    expect(notice()).toBeNull();
  });

  it('lists one results row per attempt when a retry fails again', async () => {
    const errorSpy = jest.spyOn(console, 'error');
    const { remove, settle } = deferredRemove();
    render({ onRemoveWorktreeInBatch: remove });
    await confirmBatch(['alpha', 'beta'], 'delete');
    await settle('alpha');
    await settle('beta', new Error('Teardown script failed.'));
    await confirmBatch(['beta', 'gamma'], 'delete');
    await settle('beta', new Error('Teardown script failed.'));
    await settle('gamma');
    expect(notice()?.textContent).toContain('Deleted 2 of 3 worktrees');
    expect(notice()?.textContent).toContain('1 failed.');
    click(buttonIn(container, 'worktree-batch-removal-notice-details'));
    await flush();
    expect(dialog()?.querySelectorAll('[data-status="failed"]').length).toBe(2);
    expect(dialog()?.querySelectorAll('[data-status="done"]').length).toBe(2);
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('same key'),
      expect.anything(),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it('says each project keeps its own window when Delete spans retention windows', async () => {
    render(
      {
        onRemoveWorktreeInBatch: jest.fn(),
        worktreeRetentionDaysFor: (workspace): number =>
          workspace === 'other' ? 30 : 7,
      },
      {
        ...snapshot,
        workspaces: [
          ...snapshot.workspaces,
          { localId: 'other', name: 'Other', type: 'single-repo' as const },
        ],
        worktrees: [
          ...snapshot.worktrees,
          {
            localId: 'omega',
            workspaceLocalId: 'other',
            branch: 'omega-branch',
            order: 0,
          },
        ],
      },
    );
    toggle('alpha');
    toggle('omega');
    await bulk('alpha', 'delete');
    expect(dialog()?.textContent).toContain("each project's retention window");
    const info = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="About restoring these worktrees"]',
    );
    await act(async () => {
      info?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      await Promise.resolve();
    });
    const detail = document.body.textContent ?? '';
    expect(detail).toContain('Deleting removes');
    expect(detail).toContain("its project's retention window");
    expect(detail).toContain('Git state, chats, and eligible workflow history');
    expect(detail).not.toMatch(/kept for \d+ days?/);
  });

  it('offers the branch choice only where the host sets it', async () => {
    render({
      onRemoveWorktreeInBatch: jest.fn(),
      worktreeBatchBranchChoice: true,
    });
    toggle('alpha');
    toggle('beta');
    await bulk('alpha', 'archive');
    expect(
      document.body.querySelector(
        '[data-testid="worktree-batch-removal-dialog-delete-branch"]',
      ),
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="worktree-batch-removal-dialog-confirm"]',
      ),
    ).toBeNull();
  });

  it('disables Delete when retention support is mixed across the selection', () => {
    render({
      onRemoveWorktreeInBatch: jest.fn(),
      capabilitiesFor: (localId) =>
        localId === 'beta'
          ? { ...capabilities, worktreeRetention: undefined }
          : capabilities,
    });
    toggle('alpha');
    toggle('beta');
    openMenu('alpha');
    const deleteItem = menuItem('bulk-delete');
    expect(deleteItem?.disabled).toBe(true);
    expect(deleteItem?.getAttribute('title')).toBe(
      "Some selected worktrees can't be deleted",
    );
    expect(menuItem('bulk-archive')?.disabled).toBe(false);
  });

  it('selects cloud chat rows with chat wording', async () => {
    const remove = jest.fn((): Promise<void> => Promise.resolve());
    const chats = {
      workspaces: [
        {
          localId: 'chats',
          name: 'Chats',
          type: 'cowork' as const,
          backend: 'cloud' as const,
          layout: 'tree' as const,
          chatsHome: true,
        },
      ],
      worktrees: ['alpha', 'beta'].map((id, order) => ({
        localId: id,
        workspaceLocalId: 'chats',
        branch: `${id}-branch`,
        order,
      })),
      standaloneChats: [],
    } satisfies SidebarSurfaceSnapshot;
    render(
      {
        onRemoveWorktreeInBatch: remove,
        selection: { kind: 'workspace', workspaceLocalId: 'chats' },
      },
      chats,
    );
    toggle('alpha');
    toggle('beta');
    expect(checked('alpha')).toBe(true);
    expect(checked('beta')).toBe(true);
    openMenu('alpha');
    expect(menuItem('bulk-archive')?.textContent).toContain('Archive 2 chats');
    await bulk('alpha', 'archive');
    expect(dialog()?.textContent).toContain('Archive 2 chats?');
    expect(
      buttonIn(document.body, 'worktree-batch-removal-dialog-summary')
        .textContent,
    ).toContain('Archived chats are kept until you delete them.');
  });

  it('pins and hides a selection through onUpdateWorktree, row by row', async () => {
    const onUpdateWorktree = jest.fn();
    render(
      {
        capabilities: {
          ...capabilities,
          worktreePinning: true,
          worktreeMetadata: true,
        },
        onRemoveWorktreeInBatch: jest.fn(() => Promise.resolve()),
        onUpdateWorktree,
      },
      pinnedSnapshot,
    );
    toggle('alpha');
    toggle('beta');
    openMenu('alpha');
    const pin = menuItem('bulk-pin');
    expect(pin?.textContent).toContain('Pin 2 worktrees');
    if (!pin) throw new Error('Missing bulk pin');
    click(pin);
    await flush();
    // Only the unpinned row changes.
    expect(onUpdateWorktree.mock.calls).toEqual([
      ['workspace', 'beta', { pinned: true }],
    ]);
    expect(selectedCount()).toBe(2);
    openMenu('alpha');
    const hide = menuItem('bulk-hide');
    expect(hide?.textContent).toContain('Hide 2 worktrees');
    if (!hide) throw new Error('Missing bulk hide');
    click(hide);
    await flush();
    expect(onUpdateWorktree.mock.calls.slice(1)).toEqual([
      ['workspace', 'alpha', { hidden: true }],
      ['workspace', 'beta', { hidden: true }],
    ]);
  });

  it('hidden rows leave the selection', async () => {
    const onRemoveWorktreeInBatch = jest.fn(() => Promise.resolve());
    render({ onRemoveWorktreeInBatch });
    toggle('alpha');
    toggle('beta');
    // The host's snapshot after Hide ran: both rows are hidden.
    render({ onRemoveWorktreeInBatch }, {
      ...snapshot,
      worktrees: snapshot.worktrees.map((worktree) =>
        ['alpha', 'beta'].includes(worktree.localId)
          ? { ...worktree, hidden: true }
          : worktree,
      ),
    } satisfies SidebarSurfaceSnapshot);
    await flush();
    // Adding a visible row makes a selection of one, not three.
    toggle('gamma');
    openMenu('gamma');
    expect(menuItem('bulk-archive')).toBeNull();
    expect(menuItem('toggle-selection')?.textContent).toContain('Deselect');
  });

  it('offers no Pin without the pinning capability and no Hide without onUpdateWorktree', () => {
    render({ onRemoveWorktreeInBatch: jest.fn(() => Promise.resolve()) });
    toggle('alpha');
    toggle('beta');
    openMenu('alpha');
    expect(menuItem('bulk-archive')).not.toBeNull();
    expect(menuItem('bulk-pin')).toBeNull();
    expect(menuItem('bulk-hide')).toBeNull();
    expect(menuItem('bulk-notifications')).toBeNull();
  });

  it('sets one notification choice on every row that differs', async () => {
    const onSetWorktreeNotificationLevel = jest.fn();
    render({
      onRemoveWorktreeInBatch: jest.fn(() => Promise.resolve()),
      getWorktreeNotificationSettings: (_workspace, worktree) => ({
        status: 'ready',
        selectionKnown: true,
        override: worktree === 'alpha' ? 'mute' : null,
      }),
      onSetWorktreeNotificationLevel,
    });
    toggle('alpha');
    toggle('beta');
    openMenu('alpha');
    const trigger = menuItem('bulk-notifications');
    if (!trigger) throw new Error('Missing bulk notifications');
    // The flyout opens on click as well as on hover.
    click(trigger);
    const mute = menuItem('bulk-notifications-notify-mute');
    if (!mute) throw new Error('Missing mute choice');
    // Mixed levels: nothing is checked.
    expect(mute.getAttribute('aria-checked')).toBe('false');
    click(mute);
    await flush();
    expect(onSetWorktreeNotificationLevel.mock.calls).toEqual([
      ['workspace', 'beta', 'mute'],
    ]);
  });

  it('keeps the selection menu when Archive is not offered', () => {
    render({
      capabilities: { ...capabilities, worktreePinning: true },
      // Rows that only delete: the selection offers no Archive.
      capabilitiesFor: () => ({
        ...capabilities,
        worktreePinning: true,
        worktreeRemoval: 'delete',
        worktreeRetention: undefined,
      }),
      onRemoveWorktreeInBatch: jest.fn(() => Promise.resolve()),
      onUpdateWorktree: jest.fn(),
    });
    toggle('alpha');
    toggle('beta');
    openMenu('alpha');
    expect(menuItem('bulk-archive')).toBeNull();
    expect(menuItem('bulk-delete')).not.toBeNull();
    expect(menuItem('bulk-pin')).not.toBeNull();
    // The single row's own items stay out of the selection's menu.
    expect(menuItem('toggle-pin')).toBeNull();
    expect(menuItem('toggle-hidden')).toBeNull();
  });
});
