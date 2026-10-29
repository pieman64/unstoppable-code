/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';
import { closestCenter, PointerSensor, TouchSensor } from '@dnd-kit/core';
import { sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import {
  resolveSortableDrop,
  restrictToVerticalAxis,
  SORTABLE_SIDEBAR_COARSE_POINTER_SENSOR,
  SORTABLE_SIDEBAR_COLLISION_DETECTION,
  SORTABLE_SIDEBAR_FINE_POINTER_SENSOR,
  SORTABLE_SIDEBAR_KEYBOARD_COORDINATE_GETTER,
  SORTABLE_SIDEBAR_POINTER_CONSTRAINT,
  SORTABLE_SIDEBAR_TOUCH_CONSTRAINT,
  SortableWorkspacesSidebar,
} from '../SortableWorkspacesSidebar';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const capabilities: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'read-only',
  routing: 'url',
  overviewNotifications: true,
};

const state = {
  workspaces: [
    {
      localId: 'workspace-1',
      name: 'Workspace One',
      type: 'single-repo',
      itemSortMode: 'manual',
    },
    {
      localId: 'workspace-2',
      name: 'Workspace Two',
      type: 'single-repo',
      itemSortMode: 'manual',
    },
    {
      localId: 'workspace-hidden',
      name: 'Workspace Hidden',
      type: 'single-repo',
      alwaysShow: false,
    },
  ] as const,
  worktrees: [
    {
      localId: 'worktree-1',
      workspaceLocalId: 'workspace-1',
      branch: 'one',
    },
    {
      localId: 'worktree-2',
      workspaceLocalId: 'workspace-1',
      branch: 'two',
    },
    {
      localId: 'worktree-other',
      workspaceLocalId: 'workspace-2',
      branch: 'other',
    },
    {
      localId: 'worktree-hidden',
      workspaceLocalId: 'workspace-1',
      branch: 'hidden',
      hidden: true,
    },
  ],
};

async function dispatchKey(element: Element, key: string): Promise<void> {
  const code = key === ' ' ? 'Space' : key;
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        code,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function dispatchPointer(
  element: HTMLElement | Document,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  pointerType = 'mouse',
  clientY = 0,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    buttons: 1,
    clientX,
    clientY,
  });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'isPrimary', { value: true });
  element.dispatchEvent(event);
}

function dispatchTouchStart(element: HTMLElement): void {
  element.dispatchEvent(
    new Event('touchstart', { bubbles: true, cancelable: true }),
  );
}

describe('SortableWorkspacesSidebar', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rectSpy: jest.SpyInstance;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    rectSpy = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getRect(this: HTMLElement): DOMRect {
        const sortable = this.closest<HTMLElement>(
          '[data-workspace-sortable-wrapper], [data-worktree-sortable-wrapper]',
        );
        const id =
          sortable?.dataset.workspaceSortableWrapper ??
          sortable?.dataset.worktreeSortableWrapper;
        const order = ['workspace-1', 'worktree-1'].includes(id ?? '') ? 0 : 1;
        const top = Math.max(order, 0) * 40;
        return DOMRect.fromRect({ y: top, width: 200, height: 32 });
      });
  });

  afterEach(() => {
    act(() => root.unmount());
    rectSpy.mockRestore();
    container.remove();
  });

  function renderSidebar(
    onReorderWorkspace?: (activeId: string, overId: string) => void,
    onReorderWorktree?: (
      workspaceId: string,
      activeId: string,
      overId: string,
    ) => void,
    options: {
      readonly workspaceNameTogglesCollapse?: boolean;
      readonly onSelectWorkspace?: (workspaceLocalId: string) => void;
    } = {},
  ): void {
    act(() => {
      root.render(
        <SortableWorkspacesSidebar
          workspaceNameTogglesCollapse={options.workspaceNameTogglesCollapse}
          onSelectWorkspace={options.onSelectWorkspace}
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          onReorderWorkspace={onReorderWorkspace}
          onReorderWorktree={onReorderWorktree}
          renderWorkspaceDragHandleContent={({ workspace }) => workspace.name}
          renderWorktreeActions={() => ({
            node: (
              <>
                <span tabIndex={0} data-testid="worktree-popover-anchor">
                  Status
                </span>
                <button
                  type="button"
                  className="cursor-pointer"
                  data-testid="worktree-action"
                >
                  Action
                </button>
              </>
            ),
            buttonCount: 1,
          })}
          testIds={{
            hiddenWorkspacesToggle: 'hidden-workspaces',
            hiddenWorktreesToggle: (workspaceId) =>
              `hidden-worktrees-${workspaceId}`,
          }}
        />,
      );
    });
  }

  it('registers an admitted linked Personal row in the sortable item set', () => {
    function SortableItems(): React.JSX.Element {
      const { items } = useSortable({ id: 'workspace-1' });
      return <output data-testid="sortable-items">{items.join(',')}</output>;
    }
    act(() =>
      root.render(
        <SortableWorkspacesSidebar
          state={state}
          context={{ kind: 'organization', organizationId: 'org-a' }}
          linkedPersonalWorkspaceIds={['workspace-1']}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          onReorderWorkspace={jest.fn()}
          onReorderWorktree={jest.fn()}
          renderWorkspaceDragHandleContent={() => <SortableItems />}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="sortable-items"]')?.textContent,
    ).toBe('workspace-1');
  });

  it('uses the approved pointer, keyboard, and collision configuration', () => {
    expect(SORTABLE_SIDEBAR_POINTER_CONSTRAINT).toEqual({
      activationConstraint: { distance: 6 },
    });
    expect(SORTABLE_SIDEBAR_TOUCH_CONSTRAINT).toEqual({
      activationConstraint: { delay: 250, tolerance: 8 },
    });
    expect(SORTABLE_SIDEBAR_FINE_POINTER_SENSOR).toBe(PointerSensor);
    expect(SORTABLE_SIDEBAR_COARSE_POINTER_SENSOR).toBe(TouchSensor);
    expect(SORTABLE_SIDEBAR_KEYBOARD_COORDINATE_GETTER).toBe(
      sortableKeyboardCoordinates,
    );
    expect(SORTABLE_SIDEBAR_COLLISION_DETECTION).toBe(closestCenter);
  });

  it.each([
    ['null over', 'workspace-1', null],
    ['self drop', 'workspace-1', 'workspace-1'],
    ['unknown active', 'unknown', 'workspace-1'],
    ['unknown over', 'workspace-1', 'unknown'],
    ['cross-workspace worktree', 'worktree-1', 'worktree-other'],
  ])('rejects %s', (_label, activeId, overId) => {
    expect(
      resolveSortableDrop(
        activeId,
        overId,
        new Set(['workspace-1', 'workspace-2', 'worktree-1', 'worktree-2']),
      ),
    ).toBeNull();
  });

  it('rejects cross-group drops while allowing same-container pointer and keyboard intents', () => {
    const containers = new Map([
      ['parent', 'top'],
      ['child-a', 'group:parent'],
      ['child-b', 'group:parent'],
      ['other', 'top'],
    ]);
    const ids = new Set(containers.keys());
    expect(resolveSortableDrop('child-a', 'child-b', ids, containers)).toEqual([
      'child-a',
      'child-b',
    ]);
    expect(resolveSortableDrop('child-a', 'other', ids, containers)).toBeNull();
  });

  it('requires both callbacks before mounting sortable wrappers and handles', () => {
    renderSidebar(jest.fn());
    expect(container.querySelector('[aria-label^="Reorder "]')).toBeNull();
    expect(
      container.querySelector('[data-workspace-sortable-wrapper]'),
    ).toBeNull();
    expect(
      container.querySelector<HTMLElement>('[data-worktree-id]')?.className,
    ).not.toContain('cursor-grab');

    renderSidebar(jest.fn(), jest.fn());
    expect(
      container.querySelector(
        '[data-workspace-sortable-wrapper="workspace-1"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-worktree-sortable-wrapper="worktree-1"]'),
    ).not.toBeNull();
  });

  it('excludes hidden entities from sortable registration and handles', () => {
    renderSidebar(jest.fn(), jest.fn());
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="hidden-workspaces"]')
        ?.click(),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="hidden-worktrees-workspace-1"]',
        )
        ?.click(),
    );
    expect(
      container.querySelector(
        '[data-workspace-sortable-wrapper="workspace-hidden"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-worktree-sortable-wrapper="worktree-hidden"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Reorder Workspace Hidden"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-workspace-id="workspace-1"]')
        ?.querySelector('[aria-label="Move hidden"]'),
    ).toBeNull();
  });

  it('preserves wrapper identity, truncation styling, and sortable metadata', () => {
    renderSidebar(jest.fn(), jest.fn());
    const workspaceWrapper = container.querySelector<HTMLElement>(
      '[data-workspace-sortable-wrapper="workspace-1"]',
    );
    const worktreeWrapper = container.querySelector<HTMLElement>(
      '[data-worktree-sortable-wrapper="worktree-1"]',
    );
    expect(workspaceWrapper?.classList.contains('min-w-0')).toBe(true);
    expect(worktreeWrapper?.classList.contains('min-w-0')).toBe(true);
    expect(worktreeWrapper?.classList.contains('touch-pan-y')).toBe(true);
    expect(worktreeWrapper?.classList.contains('pointer-fine:touch-none')).toBe(
      true,
    );
    expect(worktreeWrapper?.classList.contains('touch-none')).toBe(false);
    expect(workspaceWrapper?.style.transform).toBe('');
    expect(workspaceWrapper?.style.transition).toBe('');
    expect(
      workspaceWrapper?.querySelector('[data-workspace-id]'),
    ).not.toBeNull();
    expect(worktreeWrapper?.querySelector('[data-worktree-id]')).not.toBeNull();
    expect(
      container
        .querySelector('[aria-label="Reorder Workspace One"]')
        ?.getAttribute('aria-roledescription'),
    ).toBe('sortable');
  });

  it('toggles collapse from a plain click on the workspace icon handle', () => {
    // The hover-revealed collapse chevron lives inside this reorder button;
    // desktop toggles collapse through the header's row-background handler,
    // which only sees the click if the handle does not swallow it. That is the
    // desktop disclosure, which the host opts into with name-toggles-collapse.
    renderSidebar(jest.fn(), jest.fn(), { workspaceNameTogglesCollapse: true });
    const wrapper = container.querySelector<HTMLElement>(
      '[data-workspace-sortable-wrapper="workspace-1"]',
    );
    const section = wrapper?.querySelector<HTMLElement>(
      '[data-workspace-expanded]',
    );
    const handle = wrapper?.querySelector<HTMLElement>(
      '[data-workspace-drag-activator="icon"]',
    );
    if (!wrapper || !section || !handle)
      throw new Error('workspace handle missing');
    expect(section.dataset.workspaceExpanded).toBe('true');
    act(() => {
      handle.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
      );
    });
    expect(section.dataset.workspaceExpanded).toBe('false');
  });

  it('drops pointer focus from the icon handle after toggling collapse', () => {
    // Legacy ProjectHeader rule: a mouse click must not leave the handle
    // focused, or `group-focus-within` keeps the hover actions revealed and
    // hides the counter after the pointer leaves.
    renderSidebar(jest.fn(), jest.fn(), { workspaceNameTogglesCollapse: true });
    const handle = container.querySelector<HTMLElement>(
      '[data-workspace-sortable-wrapper="workspace-1"] [data-workspace-drag-activator="icon"]',
    );
    if (!handle) throw new Error('workspace handle missing');
    act(() => {
      handle.focus();
      handle.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
      );
    });
    expect(document.activeElement).not.toBe(handle);
  });

  it('activates pointer dragging from the row surface', async () => {
    renderSidebar(jest.fn(), jest.fn());
    const wrapper = container.querySelector<HTMLElement>(
      '[data-worktree-sortable-wrapper="worktree-1"]',
    );
    const row = wrapper?.querySelector<HTMLElement>('[data-worktree-id]');
    if (!wrapper || !row) throw new Error('worktree row missing');

    // CAN-3053: a sortable row keeps the plain arrow cursor at rest — a
    // hand/grab cursor on every row made the whole rail look draggable-only
    // instead of clickable. Only an active drag switches to the grabbing
    // cursor, asserted below.
    expect(row.className).toContain('cursor-default');
    expect(row.className).not.toContain('pointer-fine:hover:cursor-grab');
    expect(
      wrapper.querySelector<HTMLElement>('[data-testid="worktree-action"]')
        ?.className,
    ).toContain('cursor-pointer');

    await act(async () => {
      dispatchPointer(row, 'pointerdown', 0);
      dispatchPointer(document, 'pointermove', 8);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(wrapper.dataset.dragging).toBe('true');
    expect(wrapper.classList.contains('touch-none')).toBe(true);
    expect(wrapper.classList.contains('touch-pan-y')).toBe(false);
    expect(wrapper.classList.contains('pointer-fine:touch-none')).toBe(false);
    expect(row.className).toContain('pointer-fine:cursor-grabbing');
    expect(row.className).not.toContain('pointer-fine:hover:cursor-grab');
  });

  // CAN-3053: a diagonal pointer drag on a worktree row used to carry the row
  // sideways with the pointer ("into the void") instead of only reordering it
  // vertically. dnd-kit's own pointer/rect handling is not meaningfully
  // reproducible in jsdom (the sortable transform it reports for a simulated
  // diagonal move does not track raw pointer deltas the way a real browser
  // does), so the modifier itself — the actual fix — gets a direct,
  // deterministic unit test here; the visible "moves off to the side" bug is
  // covered end-to-end by the Electron UI automation spec.
  it('clamps the drag transform to the vertical axis (restrictToVerticalAxis)', () => {
    const clamped = restrictToVerticalAxis({
      transform: { x: 120, y: 24, scaleX: 1, scaleY: 1 },
      active: null,
      activeNodeRect: null,
      draggingNodeRect: null,
      containerNodeRect: null,
      over: null,
      overlayNodeRect: null,
      scale: { x: 1, y: 1 },
      windowRect: null,
    });
    expect(clamped).toEqual({ x: 0, y: 24, scaleX: 1, scaleY: 1 });
  });

  it('still activates a worktree row drag with the vertical-axis modifier applied', async () => {
    renderSidebar(jest.fn(), jest.fn());
    const wrapper = container.querySelector<HTMLElement>(
      '[data-worktree-sortable-wrapper="worktree-1"]',
    );
    const row = wrapper?.querySelector<HTMLElement>('[data-worktree-id]');
    if (!wrapper || !row) throw new Error('worktree row missing');

    await act(async () => {
      dispatchPointer(row, 'pointerdown', 0, 'mouse', 0);
      // A large diagonal move: mostly horizontal, a little vertical.
      dispatchPointer(document, 'pointermove', 120, 'mouse', 24);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(wrapper.dataset.dragging).toBe('true');
    expect(wrapper.style.transform).not.toBe('');
  });

  it.each([
    ['action button', '[data-testid="worktree-action"]'],
    ['popover anchor', '[data-testid="worktree-popover-anchor"]'],
  ])(
    'excludes the interactive %s from pointer dragging',
    (_label, selector) => {
      renderSidebar(jest.fn(), jest.fn());
      const wrapper = container.querySelector<HTMLElement>(
        '[data-worktree-sortable-wrapper="worktree-1"]',
      );
      const interactiveChild = wrapper?.querySelector<HTMLElement>(selector);
      if (!wrapper || !interactiveChild)
        throw new Error('worktree row missing');

      act(() => {
        dispatchPointer(interactiveChild, 'pointerdown', 0);
        dispatchPointer(document, 'pointermove', 8);
      });
      expect(wrapper.dataset.dragging).toBeUndefined();
    },
  );

  it('excludes an interactive button from touch dragging', async () => {
    renderSidebar(jest.fn(), jest.fn());
    const wrapper = container.querySelector<HTMLElement>(
      '[data-worktree-sortable-wrapper="worktree-1"]',
    );
    const action = wrapper?.querySelector<HTMLElement>(
      '[data-testid="worktree-action"]',
    );
    if (!wrapper || !action) throw new Error('worktree row missing');

    await act(async () => {
      dispatchTouchStart(action);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(wrapper.dataset.dragging).toBeUndefined();
  });

  it('does not activate the pointer sensor for touch pointer events', () => {
    renderSidebar(jest.fn(), jest.fn());
    const wrapper = container.querySelector<HTMLElement>(
      '[data-worktree-sortable-wrapper="worktree-1"]',
    );
    const row = wrapper?.querySelector<HTMLElement>('[data-worktree-id]');
    if (!wrapper || !row) throw new Error('worktree row missing');

    act(() => {
      dispatchPointer(row, 'pointerdown', 0, 'touch');
      dispatchPointer(document, 'pointermove', 8, 'touch');
    });
    expect(wrapper.dataset.dragging).toBeUndefined();
  });

  // Desktop parity: the header's name is a drag activator like the icon. A
  // press that travels past the sensor threshold starts the reorder.
  it('starts a project drag from the header label', async () => {
    renderSidebar(jest.fn(), jest.fn(), { workspaceNameTogglesCollapse: true });
    const icon = container.querySelector<HTMLElement>(
      '[aria-label="Reorder Workspace One"]',
    );
    expect(icon?.getAttribute('data-workspace-drag-activator')).toBe('icon');
    const wrapper = container.querySelector<HTMLElement>(
      '[data-workspace-sortable-wrapper="workspace-1"]',
    );
    const label = wrapper?.querySelector<HTMLElement>(
      'button[data-workspace-drag-activator="label"]',
    );
    if (!wrapper || !label) throw new Error('project label activator missing');
    expect(label.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      dispatchPointer(label, 'pointerdown', 0);
      dispatchPointer(document, 'pointermove', 8);
    });
    expect(wrapper.dataset.dragging).toBe('true');
    // The drag copies dim and mark themselves as desktop's do.
    const flowHeader = wrapper.querySelector<HTMLElement>(
      '[data-sidebar-workspace-sortable-header="workspace-1"]',
    );
    expect(flowHeader?.dataset.sidebarWorkspaceSourceDragging).toBe('true');
    expect(flowHeader?.classList.contains('opacity-60')).toBe(true);
    // The document-level preview (desktop's `workspace-drag-overlay`) follows
    // the pointer while the flow section keeps its footprint.
    const overlay = document.querySelector<HTMLElement>(
      '[data-testid="workspace-drag-overlay"]',
    );
    expect(overlay?.dataset.sidebarWorkspaceDragOverlayId).toBe('workspace-1');
    // Portaled to the document, outside the rail's clipped rows wrapper.
    expect(overlay?.closest('[data-workspace-sortable-wrapper]')).toBeNull();
    expect(container.contains(overlay)).toBe(false);
    expect(overlay?.textContent).toContain('Workspace One');
    await act(async () => {
      dispatchPointer(document, 'pointerup', 8);
      await Promise.resolve();
    });
    expect(wrapper.dataset.dragging).toBeUndefined();
    expect(
      document.querySelector('[data-testid="workspace-drag-overlay"]'),
    ).toBeNull();
    // Reorder-disabled hosts render no activators at all.
    renderSidebar(undefined, jest.fn());
    expect(
      container.querySelector('[data-workspace-drag-activator]'),
    ).toBeNull();
    // dnd-kit keeps a capture-phase click blocker on the document for 50 ms
    // after a drag ends; let it lapse so it cannot eat the next test's click.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  });

  // CAN-3053: the same vertical-only restriction applies to a project/
  // workspace header drag (see the modifier unit test above for the
  // deterministic assertion; dnd-kit's simulated drag deltas are not
  // reproducible in jsdom).
  it('still activates a workspace header drag with the vertical-axis modifier applied', async () => {
    renderSidebar(jest.fn(), jest.fn(), { workspaceNameTogglesCollapse: true });
    const wrapper = container.querySelector<HTMLElement>(
      '[data-workspace-sortable-wrapper="workspace-1"]',
    );
    const label = wrapper?.querySelector<HTMLElement>(
      'button[data-workspace-drag-activator="label"]',
    );
    if (!wrapper || !label) throw new Error('project label activator missing');

    await act(async () => {
      dispatchPointer(label, 'pointerdown', 0, 'mouse', 0);
      dispatchPointer(document, 'pointermove', 120, 'mouse', 24);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Activation is the contract here. Where the dragged header is drawn is
    // not: the in-flow row may move itself or leave that to a drag overlay.
    expect(wrapper.dataset.dragging).toBe('true');
    await act(async () => {
      dispatchPointer(document, 'pointerup', 120);
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  });

  // A drag released outside the wrapper never delivers its own click, so the
  // guard that swallows that click must not outlive the gesture.
  it('does not swallow a later click after a drag released elsewhere', async () => {
    renderSidebar(jest.fn(), jest.fn(), { workspaceNameTogglesCollapse: true });
    const wrapper = container.querySelector<HTMLElement>(
      '[data-workspace-sortable-wrapper="workspace-1"]',
    );
    const label = wrapper?.querySelector<HTMLElement>(
      'button[data-workspace-drag-activator="label"]',
    );
    if (!wrapper || !label) throw new Error('project label activator missing');
    act(() => {
      dispatchPointer(label, 'pointerdown', 0);
      dispatchPointer(document, 'pointermove', 8);
    });
    expect(wrapper.dataset.dragging).toBe('true');
    await act(async () => {
      dispatchPointer(document, 'pointerup', 8);
      // Past dnd-kit's own 50 ms post-drag click blocker.
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(label.getAttribute('aria-expanded')).toBe('true');
    act(() => label.click());
    expect(label.getAttribute('aria-expanded')).toBe('false');
  });

  // Escape cancels a pointer drag while the pointer is still held, so the
  // drag's own click arrives only with the eventual release, however much
  // later the user lets go. That click must not collapse the project whose
  // drag was just cancelled; dnd-kit's own post-drag click blocker lapses
  // 50 ms after the cancel, so the guard is all that stands in its way.
  it('swallows the release click of an Escape-cancelled drag however late the release', async () => {
    renderSidebar(jest.fn(), jest.fn(), { workspaceNameTogglesCollapse: true });
    const wrapper = container.querySelector<HTMLElement>(
      '[data-workspace-sortable-wrapper="workspace-1"]',
    );
    const section = wrapper?.querySelector<HTMLElement>(
      '[data-workspace-expanded]',
    );
    const handle = wrapper?.querySelector<HTMLElement>(
      '[data-workspace-drag-activator="icon"]',
    );
    if (!wrapper || !section || !handle)
      throw new Error('workspace handle missing');
    const releaseWithClick = (): void => {
      dispatchPointer(handle, 'pointerup', 8);
      handle.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
      );
    };

    act(() => {
      dispatchPointer(handle, 'pointerdown', 0);
      dispatchPointer(document, 'pointermove', 8);
    });
    expect(wrapper.dataset.dragging).toBe('true');
    await dispatchKey(handle, 'Escape');
    expect(wrapper.dataset.dragging).toBeUndefined();
    // The user holds the pointer past dnd-kit's 50 ms click blocker.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    act(releaseWithClick);
    expect(section.dataset.workspaceExpanded).toBe('true');

    // The guard ends with that gesture: the next plain click toggles.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => {
      dispatchPointer(handle, 'pointerdown', 0);
      releaseWithClick();
    });
    expect(section.dataset.workspaceExpanded).toBe('false');
  });

  // An Escape-cancelled drag released outside the wrapper never delivers a
  // click there, so its guard must not survive the release either.
  it('does not swallow a later click after an Escape-cancelled drag released elsewhere', async () => {
    renderSidebar(jest.fn(), jest.fn(), { workspaceNameTogglesCollapse: true });
    const wrapper = container.querySelector<HTMLElement>(
      '[data-workspace-sortable-wrapper="workspace-1"]',
    );
    const label = wrapper?.querySelector<HTMLElement>(
      'button[data-workspace-drag-activator="label"]',
    );
    if (!wrapper || !label) throw new Error('project label activator missing');
    act(() => {
      dispatchPointer(label, 'pointerdown', 0);
      dispatchPointer(document, 'pointermove', 8);
    });
    expect(wrapper.dataset.dragging).toBe('true');
    await dispatchKey(label, 'Escape');
    await act(async () => {
      dispatchPointer(document, 'pointerup', 8);
      // Past dnd-kit's own 50 ms post-drag click blocker.
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(label.getAttribute('aria-expanded')).toBe('true');
    act(() => label.click());
    expect(label.getAttribute('aria-expanded')).toBe('false');
  });

  // Touch stays with the long-press sensor, as on worktree rows: a scroll
  // that starts on a project name must not begin a reorder.
  it('does not start a project drag from a touch press on the label', () => {
    renderSidebar(jest.fn(), jest.fn(), { workspaceNameTogglesCollapse: true });
    const wrapper = container.querySelector<HTMLElement>(
      '[data-workspace-sortable-wrapper="workspace-1"]',
    );
    const label = wrapper?.querySelector<HTMLElement>(
      'button[data-workspace-drag-activator="label"]',
    );
    if (!wrapper || !label) throw new Error('project label activator missing');
    act(() => {
      dispatchPointer(label, 'pointerdown', 0, 'touch');
      dispatchPointer(document, 'pointermove', 8, 'touch');
    });
    expect(wrapper.dataset.dragging).toBeUndefined();
  });

  // A host that does not opt into desktop's header presentation (the portal)
  // still toggles collapse from the project name, as desktop does — the name
  // never selects the project (CAN-3053: selecting it landed on the dead-end
  // "Select a worktree" placeholder). The trailing chevron collapses too, the
  // name is no drag activator, and an icon click does not toggle.
  it('toggles collapse from the project name on hosts that do not opt in', () => {
    const selected: string[] = [];
    renderSidebar(jest.fn(), jest.fn(), {
      onSelectWorkspace: (workspaceLocalId): void => {
        selected.push(workspaceLocalId);
      },
    });
    const wrapper = container.querySelector<HTMLElement>(
      '[data-workspace-sortable-wrapper="workspace-1"]',
    );
    const section = wrapper?.querySelector<HTMLElement>(
      '[data-workspace-expanded]',
    );
    const icon = wrapper?.querySelector<HTMLElement>(
      '[data-workspace-drag-activator="icon"]',
    );
    // The harness renders the name inside the icon handle too, so skip it.
    const name = Array.from(
      wrapper?.querySelectorAll<HTMLButtonElement>(
        'button:not([data-workspace-drag-activator="icon"])',
      ) ?? [],
    ).find((button) => button.textContent?.includes('Workspace One'));
    if (!wrapper || !section || !icon || !name) {
      throw new Error('portal header controls missing');
    }
    expect(
      wrapper.querySelector('[data-workspace-drag-activator="label"]'),
    ).toBeNull();
    expect(name.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      icon.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
      );
    });
    expect(section.dataset.workspaceExpanded).toBe('true');

    act(() => name.click());
    expect(selected).toEqual([]);
    expect(section.dataset.workspaceExpanded).toBe('false');
    expect(name.getAttribute('aria-expanded')).toBe('false');

    act(() => name.click());
    expect(section.dataset.workspaceExpanded).toBe('true');

    // The trailing chevron stays a second collapse control on the portal.
    const chevron = Array.from(
      wrapper.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Collapse Workspace One"]',
      ),
    ).find((button) => button !== name);
    if (!chevron) throw new Error('trailing chevron missing');
    act(() => chevron.click());
    expect(section.dataset.workspaceExpanded).toBe('false');
    expect(selected).toEqual([]);
  });

  it('emits neighbor-relative project intent through a real keyboard drag', async () => {
    const onReorderWorkspace = jest.fn();
    renderSidebar(onReorderWorkspace, jest.fn());
    const handle = container.querySelector<HTMLElement>(
      '[aria-label="Reorder Workspace One"]',
    );
    if (!handle) throw new Error('project reorder handle missing');
    act(() => handle.focus());
    await dispatchKey(handle, 'Enter');
    const wrapper = container.querySelector<HTMLElement>(
      '[data-workspace-sortable-wrapper="workspace-1"]',
    );
    expect(wrapper?.dataset.dragging).toBe('true');
    expect(wrapper?.classList.contains('opacity-50')).toBe(true);
    await dispatchKey(handle, 'ArrowDown');
    await dispatchKey(handle, 'Enter');
    expect(wrapper?.dataset.dragging).toBeUndefined();
    expect(onReorderWorkspace).toHaveBeenCalledWith(
      'workspace-1',
      'workspace-2',
    );
  });

  // Desktop's project reorder preview is static: the projects stay where they
  // are and a drop line marks the landing edge of the one under the drag.
  it('previews a project drop with an indicator instead of moving projects', async () => {
    renderSidebar(jest.fn(), jest.fn());
    const handle = container.querySelector<HTMLElement>(
      '[aria-label="Reorder Workspace One"]',
    );
    if (!handle) throw new Error('project reorder handle missing');
    act(() => handle.focus());
    await dispatchKey(handle, 'Enter');
    await dispatchKey(handle, 'ArrowDown');

    const target = container.querySelector<HTMLElement>(
      '[data-sidebar-workspace-id="workspace-2"]',
    );
    const indicator = target?.querySelector<HTMLElement>(
      '[data-testid="workspace-drop-indicator"]',
    );
    expect(indicator?.dataset.dropPosition).toBe('after');
    // The indicator is seated against the project it marks.
    expect(target?.classList.contains('relative')).toBe(true);
    const wrappers = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-workspace-sortable-wrapper]',
      ),
    );
    expect(wrappers.length).toBeGreaterThan(1);
    expect(wrappers.map((wrapper) => wrapper.style.transform)).toEqual(
      wrappers.map(() => ''),
    );

    await dispatchKey(handle, 'Escape');
    expect(
      container.querySelector('[data-testid="workspace-drop-indicator"]'),
    ).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  });

  it('emits neighbor-relative worktree intent through a real keyboard drag', async () => {
    const onReorderWorktree = jest.fn();
    renderSidebar(jest.fn(), onReorderWorktree);
    const handle = container.querySelector<HTMLElement>(
      '[aria-label="Move one"]',
    );
    if (!handle) throw new Error('worktree reorder handle missing');
    act(() => handle.focus());
    await dispatchKey(handle, 'Enter');
    await dispatchKey(handle, 'ArrowDown');
    await dispatchKey(handle, 'Enter');
    expect(onReorderWorktree).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
      'worktree-2',
    );
  });
});
