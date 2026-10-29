/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { PortalSessionShellState } from '@canopy/protocol/portal';
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

const snapshot = {
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
} as PortalSessionShellState;

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
    // jsdom reports no macOS platform, so the shortcut reads Ctrl+Click.
    expect(
      item.querySelector('[data-testid="worktree-menu-item-shortcut"]')
        ?.textContent,
    ).toBe('Ctrl+Click');
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

  it('confirms once, removes sequentially with the open worktree last, and clears on success', async () => {
    const calls: string[] = [];
    const remove = jest.fn(
      (_workspace: string, worktree: string): Promise<void> => {
        calls.push(worktree);
        return Promise.resolve();
      },
    );
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
    await bulk('alpha', 'archive');
    const confirm = dialog();
    expect(confirm?.textContent).toContain('Archive 2 worktrees?');
    expect(remove).not.toHaveBeenCalled();
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-confirm'));
    await flush();
    expect(calls).toEqual(['beta', 'alpha']);
    expect(remove).toHaveBeenCalledWith('workspace', 'beta', {
      mode: 'archive',
      expectedBranchName: 'beta-branch',
    });
    expect(dialog()).toBeNull();
    expect(selectedCount()).toBe(0);
  });

  it('lists a working worktree under Not included and removes only the rest', async () => {
    const remove = jest.fn((): Promise<void> => Promise.resolve());
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
    // The Not included row stays selected for a later try.
    expect(dialog()).toBeNull();
    expect(selectedCount()).toBe(1);
    expect(checked('beta')).toBe(true);
  });

  it('reports a partial failure and keeps the failed worktree selected', async () => {
    const remove = jest.fn(
      (_workspace: string, worktree: string): Promise<void> =>
        worktree === 'beta'
          ? Promise.reject(new Error('Teardown script failed.'))
          : Promise.resolve(),
    );
    render({ onRemoveWorktreeInBatch: remove });
    toggle('alpha');
    toggle('beta');
    await bulk('alpha', 'archive');
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-confirm'));
    await flush();
    const results = dialog();
    expect(results?.textContent).toContain('1 archived, 1 failed');
    expect(results?.textContent).toContain('Teardown script failed.');
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-done'));
    expect(dialog()).toBeNull();
    expect(checked('beta')).toBe(true);
    expect(checked('alpha')).toBe(false);
  });

  it('keeps the confirmed names on rows that leave the rail mid-batch', async () => {
    const remove = jest.fn(
      (_workspace: string, worktree: string): Promise<void> =>
        worktree === 'beta'
          ? Promise.reject(new Error('Teardown script failed.'))
          : Promise.resolve(),
    );
    render({ onRemoveWorktreeInBatch: remove });
    toggle('alpha');
    toggle('beta');
    await bulk('alpha', 'archive');
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-confirm'));
    await flush();
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
    const results = dialog();
    expect(results?.textContent).toContain('1 archived, 1 failed');
    expect(results?.textContent).toContain('alpha-branch');
    expect(results?.textContent).toContain('Workspace');
  });

  it('keeps a running batch visible and starts nothing more once the host removal goes away', async () => {
    let finishFirst: () => void = () => undefined;
    const remove = jest.fn(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    render({ onRemoveWorktreeInBatch: remove });
    toggle('alpha');
    toggle('beta');
    toggle('gamma');
    await bulk('alpha', 'archive');
    click(buttonIn(document.body, 'worktree-batch-removal-dialog-confirm'));
    await flush();
    // Web: the desktop disconnected, so the host can't send commands.
    render({ onRemoveWorktreeInBatch: undefined });
    expect(dialog()).not.toBeNull();
    await act(async () => {
      finishFirst();
      await Promise.resolve();
    });
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(dialog()?.textContent).toContain('2 not started');
  });

  it('keeps the running batch when its confirm fires twice before re-rendering', async () => {
    let finishFirst: () => void = () => undefined;
    const remove = jest.fn(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
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
    expect(dialog()).not.toBeNull();
    for (let item = 0; item < 2; item += 1) {
      await act(async () => {
        finishFirst();
        await Promise.resolve();
      });
      await flush();
    }
    expect(remove).toHaveBeenCalledTimes(2);
    expect(dialog()).toBeNull();
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
});
