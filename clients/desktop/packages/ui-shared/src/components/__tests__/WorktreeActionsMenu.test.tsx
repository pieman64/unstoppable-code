/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TrashIcon } from '../../icons/AppIcons';
import {
  openWorktreeActionsMenuAt,
  WorktreeActionsMenu,
  worktreeActionsMenuButtonCount,
  type WorktreeMenuItem,
} from '../WorktreeActionsMenu';
import { ContextMenuPlacementProvider } from '../context-menu-placement';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('WorktreeActionsMenu', () => {
  let container: HTMLDivElement;
  let root: Root;
  const selected = jest.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    selected.mockClear();
  });

  afterEach(() => {
    void act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('marks its row while the menu is open, with pointer-placed menus', () => {
    const items: WorktreeMenuItem[] = [
      { key: 'set-label', label: 'Set label', icon: null, onSelect: selected },
    ];
    const renderMenu = (placement: 'anchored' | 'cursor'): void => {
      act(() =>
        root.render(
          <ContextMenuPlacementProvider value={placement}>
            <div data-testid="row">
              <WorktreeActionsMenu items={items} accessibleLabel="Row" />
            </div>
          </ContextMenuPlacementProvider>,
        ),
      );
    };
    const marked = (): boolean =>
      container.querySelector('[data-row-menu-open="true"]') !== null;

    renderMenu('cursor');
    expect(marked()).toBe(false);
    const row = container.querySelector<HTMLElement>('[data-testid="row"]');
    if (!row) throw new Error('row not rendered');
    act(() => {
      openWorktreeActionsMenuAt(row, { x: 40, y: 40 });
    });
    expect(marked()).toBe(true);
    act(() => {
      // A whole outside press: the menu swallows the click it completes.
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(marked()).toBe(false);

    // Without early access the row keeps today's look.
    renderMenu('anchored');
    act(() => {
      openWorktreeActionsMenuAt(row, { x: 40, y: 40 });
    });
    expect(marked()).toBe(false);
  });

  // Every host draws the same quiet rows, wherever the menu opens.
  it.each([
    ['anchored', 'text-xs', true],
    ['cursor', 'text-xs', true],
  ] as const)(
    'draws %s menu rows with %s (quiet icons: %s)',
    (placement, textClass, quietIcons) => {
      const items: WorktreeMenuItem[] = [
        {
          key: 'sidebar-group-label',
          kind: 'label',
          label: 'Frontend',
          icon: null,
        },
        {
          key: 'set-label',
          label: 'Set label',
          icon: <span>L</span>,
          onSelect: selected,
        },
      ];
      act(() =>
        root.render(
          <ContextMenuPlacementProvider value={placement}>
            <div data-testid="row">
              <WorktreeActionsMenu items={items} accessibleLabel="Row" />
            </div>
          </ContextMenuPlacementProvider>,
        ),
      );
      const row = container.querySelector<HTMLElement>('[data-testid="row"]');
      if (!row) throw new Error('row not rendered');
      act(() => {
        openWorktreeActionsMenuAt(row, { x: 40, y: 40 });
      });
      const label = Array.from(document.body.querySelectorAll('div')).find(
        (node) => node.textContent === 'Frontend',
      );
      expect(label?.classList.contains(textClass)).toBe(true);
      const action = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((node) => node.textContent === 'LSet label');
      expect(action?.classList.contains(textClass)).toBe(true);
      expect(
        action
          ?.querySelector('[aria-hidden="true"]')
          ?.classList.contains('fg-tertiary'),
      ).toBe(quietIcons);
    },
  );

  it('keeps nested pointer actions mounted and closes the root after selection', () => {
    const items: WorktreeMenuItem[] = [
      {
        key: 'sidebar-group-add',
        kind: 'submenu',
        label: 'Add to group',
        icon: <span>G</span>,
        testId: 'groups',
        submenu: [
          {
            key: 'sidebar-group-label',
            kind: 'label',
            label: 'Move to',
            icon: null,
          },
          {
            key: 'sidebar-group-one',
            label: 'One',
            icon: null,
            onSelect: selected,
            testId: 'destination',
          },
        ],
      },
    ];
    void act(() =>
      root.render(
        <WorktreeActionsMenu
          items={items}
          accessibleLabel="Actions"
          triggerTestId="trigger"
          menuTestId="menu"
        />,
      ),
    );
    void act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="trigger"]')
        ?.click(),
    );
    void act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="groups"]')
        ?.click(),
    );
    const target = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="destination"]',
    );
    void act(() =>
      target?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
    expect(document.body.querySelector('[data-testid="menu"]')).not.toBeNull();
    void act(() => target?.click());
    expect(selected).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="menu"]')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="trigger"]'),
    );
  });

  it('explains a disabled row inside a submenu with its hover card', () => {
    const items: WorktreeMenuItem[] = [
      {
        key: 'more',
        kind: 'submenu',
        label: 'More',
        icon: null,
        testId: 'more',
        submenu: [
          {
            key: 'split-pr',
            label: 'Split PR…',
            icon: null,
            onSelect: selected,
            disabled: true,
            testId: 'split-pr',
            richTooltip: <span>Uncommitted changes</span>,
            richTooltipTestId: 'split-pr-card',
          },
        ],
      },
    ];
    void act(() =>
      root.render(
        <WorktreeActionsMenu
          items={items}
          accessibleLabel="Actions"
          triggerTestId="trigger"
          menuTestId="menu"
        />,
      ),
    );
    void act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="trigger"]')
        ?.click(),
    );
    void act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="more"]')
        ?.click(),
    );
    const row = document.body.querySelector<HTMLElement>(
      '[data-testid="split-pr"]',
    );
    expect(row).not.toBeNull();
    // The hover handlers live on the card's wrapper, since a disabled row
    // emits no pointer events of its own.
    const wrapper = row?.parentElement;
    void act(() =>
      wrapper?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      ),
    );
    const card = document.body.querySelector('[data-testid="split-pr-card"]');
    expect(card?.textContent).toContain('Uncommitted changes');
  });

  it('roves to a typed submenu, skips labels, and closes only the flyout on Escape', () => {
    const items: WorktreeMenuItem[] = [
      {
        key: 'sidebar-group-label',
        kind: 'label',
        label: 'Organize',
        icon: null,
      },
      {
        key: 'sidebar-group-add',
        kind: 'submenu',
        label: 'Group',
        icon: null,
        testId: 'groups',
        submenu: [
          {
            key: 'sidebar-group-one',
            label: 'One',
            icon: null,
            onSelect: selected,
          },
        ],
      },
    ];
    void act(() =>
      root.render(
        <WorktreeActionsMenu
          items={items}
          accessibleLabel="Actions"
          triggerTestId="trigger"
          menuTestId="menu"
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="trigger"]',
    );
    void act(() => trigger?.click());
    expect(document.activeElement?.getAttribute('data-testid')).toBe('groups');
    void act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      ),
    );
    expect(document.activeElement?.textContent).toBe('One');
    void act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(
      document.body.querySelector('[data-testid="groups-menu"]'),
    ).toBeNull();
    expect(document.body.querySelector('[data-testid="menu"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('groups');
  });

  function renderMenu(
    items = [
      {
        key: 'set-label' as const,
        label: 'Set label',
        icon: <span>L</span>,
        onSelect: selected,
        testId: 'set-label',
      },
      {
        key: 'launch' as const,
        label: 'Launch',
        icon: <span>R</span>,
        disabled: true,
        tooltip: 'Running',
      },
      {
        key: 'delete' as const,
        label: 'Delete',
        icon: <span>D</span>,
        onSelect: selected,
        tone: 'destructive' as const,
        separatorBefore: true,
      },
    ],
  ): void {
    act(() => {
      root.render(
        <WorktreeActionsMenu
          items={items}
          accessibleLabel="Actions for feature"
          triggerTestId="trigger"
          menuTestId="menu"
          directActions={[
            {
              key: 'remove',
              icon: TrashIcon,
              label: 'Delete feature',
              onSelect: selected,
              className: 'pointer-coarse:hidden',
              testId: 'direct',
            },
          ]}
        />,
      );
    });
  }

  it('portals the menu to body and renders disabled, tooltip, divider, and direct action', () => {
    renderMenu();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="trigger"]',
    );
    act(() => trigger?.click());
    const menu = document.body.querySelector('[data-testid="menu"]');
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
    // A fixed compact width: a long status line wraps instead of widening it.
    expect(menu?.classList.contains('w-45')).toBe(true);
    expect(menu?.classList.contains('min-w-45')).toBe(false);
    expect(menu?.querySelector('[role="separator"]')).not.toBeNull();
    expect(
      menu?.querySelector<HTMLButtonElement>('button[disabled]')?.title,
    ).toBe('Running');
    expect(
      container.querySelector('[data-testid="direct"]')?.className,
    ).toContain('pointer-coarse:hidden');
  });

  it('reveals direct actions and the menu trigger on fine-pointer hover or focus while keeping them visible on coarse pointers', () => {
    renderMenu();
    const chip = container.querySelector(
      '[data-testid="worktree-row-action-chip"]',
    );
    expect(chip?.getAttribute('data-always-visible')).toBeNull();

    for (const testId of ['direct', 'trigger']) {
      const wrapper = container.querySelector(`[data-testid="${testId}"]`)
        ?.parentElement?.parentElement;
      expect(wrapper?.className).toContain('opacity-0');
      expect(wrapper?.className).toContain(
        'group-hover/sidebar-item:opacity-100',
      );
      expect(wrapper?.className).toContain(
        'group-focus-within/sidebar-item:opacity-100',
      );
      expect(wrapper?.className).toContain('pointer-coarse:opacity-100');
    }
  });

  it('opens from the keyboard, skips disabled rows, activates, and restores focus', () => {
    renderMenu();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="trigger"]',
    );
    act(() => {
      trigger?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toContain('Delete');
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(selected).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it('supports roving keys, Escape, Tab, and outside dismissal', () => {
    renderMenu();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="trigger"]',
    );
    act(() => trigger?.click());
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.body.querySelector('[data-testid="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    act(() => trigger?.click());
    act(() => {
      // A whole outside press: the menu swallows the click it completes.
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[data-testid="menu"]')).toBeNull();
  });

  // A host that withholds every row command — the web rail on any route but
  // `/chat`, which is navigation-only by policy — used to get a "More actions"
  // button anyway. Its click handler opened at `items[-1]` and returned, so the
  // control revealed on hover, looked live, and did nothing on press. Nothing
  // to trigger means no trigger.
  it('renders no trigger when the host supplies no menu items', () => {
    act(() => {
      root.render(
        <WorktreeActionsMenu
          items={[]}
          accessibleLabel="Actions for feature"
          triggerTestId="trigger"
          menuTestId="menu"
        />,
      );
    });
    expect(container.querySelector('[data-testid="trigger"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="worktree-row-action-chip"]'),
    ).toBeNull();
  });

  it('keeps direct actions without offering an empty menu', () => {
    act(() => {
      root.render(
        <WorktreeActionsMenu
          items={[]}
          accessibleLabel="Actions for feature"
          triggerTestId="trigger"
          menuTestId="menu"
          directActions={[
            {
              key: 'remove',
              icon: TrashIcon,
              label: 'Delete feature',
              onSelect: selected,
              testId: 'direct',
            },
          ]}
        />,
      );
    });
    expect(container.querySelector('[data-testid="direct"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trigger"]')).toBeNull();
  });

  // PR #4127 review: anchoring the menu's right edge directly at the pointer
  // (`right: innerWidth - x`) pushes the menu's LEFT edge off-screen for any
  // right-click near the left edge of a left-docked rail — the menu never
  // gets clamped back into the viewport the way the button-anchored open
  // already was. Mock a real measured size so the clamp branch (which reads
  // `offsetWidth`/`offsetHeight`) actually engages, the way it does once the
  // portaled menu has painted.
  it('clamps a pointer-anchored menu inside the viewport for a right-click near the left edge', () => {
    const widthSpy = jest
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockReturnValue(180);
    const heightSpy = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(120);
    try {
      renderMenu();
      act(() => {
        openWorktreeActionsMenuAt(container, { x: 10, y: 10 });
      });
      const menu = document.body.querySelector<HTMLElement>(
        '[data-testid="menu"]',
      );
      expect(menu).not.toBeNull();
      const leftEdge = Number.parseFloat(menu?.style.left ?? 'NaN');
      expect(Number.isNaN(leftEdge)).toBe(false);
      // Fully on screen: the menu's own left edge never goes negative.
      expect(leftEdge).toBeGreaterThanOrEqual(0);
    } finally {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
  });

  // CAN-3053: rows reserve hover space from this count, so it must agree with
  // the buttons the menu actually renders for every prop combination.
  it.each([
    { items: 0, direct: 0 },
    { items: 0, direct: 1 },
    { items: 2, direct: 0 },
    { items: 2, direct: 2 },
  ])(
    'counts the buttons it renders (items=$items, direct=$direct)',
    ({ items: itemCount, direct }) => {
      const items = Array.from({ length: itemCount }, (_, index) => ({
        key: index === 0 ? ('set-label' as const) : ('launch' as const),
        label: `Item ${index}`,
        icon: <span>I</span>,
        onSelect: selected,
      }));
      const directActions = Array.from({ length: direct }, (_, index) => ({
        key: `direct-${index}`,
        icon: TrashIcon,
        label: `Direct ${index}`,
        onSelect: selected,
      }));
      act(() => {
        root.render(
          <WorktreeActionsMenu
            items={items}
            accessibleLabel="Actions for feature"
            directActions={directActions}
          />,
        );
      });
      expect(worktreeActionsMenuButtonCount({ items, directActions })).toBe(
        container.querySelectorAll('button').length,
      );
    },
  );
});
