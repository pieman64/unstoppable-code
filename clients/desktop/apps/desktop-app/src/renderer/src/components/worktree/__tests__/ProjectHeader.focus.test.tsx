/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DraggableAttributes } from '@dnd-kit/core';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { ProjectHeader } from '../ProjectHeader';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const dragHandleAttributes = {} as DraggableAttributes;

function renderHeader(overrides?: {
  onToggleCollapsed?: jest.Mock;
  onCreateWorktree?: jest.Mock;
  onOpenSettings?: jest.Mock;
  worktreeCount?: number;
  surface?: 'flow' | 'sticky-slot' | 'pin-top' | 'pin-bottom';
}): {
  container: HTMLDivElement;
  root: Root;
  onToggleCollapsed: jest.Mock;
  onCreateWorktree: jest.Mock;
  onOpenSettings: jest.Mock;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onToggleCollapsed = overrides?.onToggleCollapsed ?? jest.fn();
  const onCreateWorktree = overrides?.onCreateWorktree ?? jest.fn();
  const onOpenSettings = overrides?.onOpenSettings ?? jest.fn();

  act(() => {
    root.render(
      <ProjectHeader
        projectId="alpha"
        name="Alpha"
        color="#123456"
        worktreeCount={overrides?.worktreeCount ?? 2}
        collapsed={false}
        onToggleCollapsed={onToggleCollapsed}
        onCreateWorktree={onCreateWorktree}
        onOpenSettings={onOpenSettings}
        dragHandleAttributes={dragHandleAttributes}
        surface={overrides?.surface}
      />,
    );
  });

  return {
    container,
    root,
    onToggleCollapsed,
    onCreateWorktree,
    onOpenSettings,
  };
}

function dispatchPointerEvent(
  element: HTMLElement,
  type: 'pointerdown' | 'pointermove',
  options: MouseEventInit & { pointerType?: string } = {},
): void {
  const event = new MouseEvent(type, { bubbles: true, ...options });
  Object.defineProperty(event, 'pointerType', {
    configurable: true,
    value: options.pointerType ?? 'mouse',
  });
  element.dispatchEvent(event);
}

function mockFocusVisible(
  element: HTMLElement,
  focusVisible: boolean,
): jest.SpyInstance {
  const nativeMatches = element.matches.bind(element);
  return jest
    .spyOn(element, 'matches')
    .mockImplementation((selector: string): boolean =>
      selector === ':focus-visible' ? focusVisible : nativeMatches(selector),
    );
}

/**
 * Every command row in a sidebar menu carries a leading glyph. Ordering rows
 * are radios whose leading rail is the selection check, so they are exempt.
 */
function expectMenuCommandRowsHaveIcons(menu: HTMLElement | null): void {
  expect(menu).not.toBeNull();
  const rows = Array.from(
    menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.querySelector('svg')).not.toBeNull();
  }
}

describe('ProjectHeader action focus', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it.each([
    ['collapse', 'Collapse Alpha'],
    ['settings', 'Settings for Alpha'],
    ['create', 'Create worktree for Alpha'],
  ])(
    'clears pointer-acquired focus after the %s action',
    (_action, ariaLabel) => {
      const rendered = renderHeader();
      const button = rendered.container.querySelector<HTMLButtonElement>(
        `[aria-label="${ariaLabel}"]`,
      );
      expect(button).not.toBeNull();

      button?.focus();
      if (!button) {
        throw new Error(`Expected ${ariaLabel} button`);
      }
      mockFocusVisible(button, false);

      act(() => {
        button.click();
      });

      expect(document.activeElement).not.toBe(button);
      expect(rendered.onToggleCollapsed).toHaveBeenCalledTimes(
        ariaLabel === 'Collapse Alpha' ? 1 : 0,
      );
      expect(rendered.onOpenSettings).toHaveBeenCalledTimes(
        ariaLabel === 'Settings for Alpha' ? 1 : 0,
      );
      expect(rendered.onCreateWorktree).toHaveBeenCalledTimes(
        ariaLabel === 'Create worktree for Alpha' ? 1 : 0,
      );

      act(() => {
        rendered.root.unmount();
      });
    },
  );

  it('preserves focus-visible keyboard focus after activation', () => {
    const rendered = renderHeader();
    const button = rendered.container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse Alpha"]',
    );
    expect(button).not.toBeNull();

    button?.focus();
    if (!button) {
      throw new Error('Expected collapse button');
    }
    mockFocusVisible(button, true);

    act(() => {
      button.click();
    });

    expect(rendered.onToggleCollapsed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button);

    act(() => {
      rendered.root.unmount();
    });
  });

  it('activates an action directly when the project has no counter', () => {
    const rendered = renderHeader({ worktreeCount: 0 });
    const createButton = rendered.container.querySelector<HTMLButtonElement>(
      '[aria-label="Create worktree for Alpha"]',
    );
    expect(createButton).not.toBeNull();
    if (!createButton) {
      throw new Error('Expected create worktree button');
    }

    act(() => {
      dispatchPointerEvent(createButton, 'pointerdown', { button: 0 });
      createButton.click();
    });

    expect(rendered.onCreateWorktree).toHaveBeenCalledTimes(1);
    expect(rendered.onToggleCollapsed).not.toHaveBeenCalled();

    act(() => {
      rendered.root.unmount();
    });
  });

  it('never routes a trailing-action press to disclosure', () => {
    // The inline chevron is now the row's disclosure affordance, so the
    // settings/add region must own every press that lands in it — including
    // the very first one after the pointer enters the row.
    const rendered = renderHeader();
    const settingsButton = rendered.container.querySelector<HTMLButtonElement>(
      '[aria-label="Settings for Alpha"]',
    );
    expect(settingsButton).not.toBeNull();
    if (!settingsButton) {
      throw new Error('Expected settings button');
    }

    act(() => {
      dispatchPointerEvent(settingsButton, 'pointerdown', { button: 0 });
      settingsButton.click();
    });

    expect(rendered.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(rendered.onToggleCollapsed).not.toHaveBeenCalled();

    act(() => {
      rendered.root.unmount();
    });
  });

  it('swaps the icon for the hover disclosure chevron and toggles on click', () => {
    const rendered = renderHeader();
    const toggle = rendered.container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse Alpha"]',
    );
    const iconButton = rendered.container.querySelector<HTMLButtonElement>(
      '[aria-label="Reorder Alpha"]',
    );
    const chevron = rendered.container.querySelector<HTMLElement>(
      '[data-testid="workspace-section-collapse-chevron"]',
    );
    expect(chevron).not.toBeNull();
    // The chevron lives over the leading icon slot, not after the name.
    expect(toggle?.contains(chevron)).toBe(false);
    expect(iconButton?.contains(chevron)).toBe(true);
    // No chevron in the default state: hidden at rest, revealed on
    // hover/focus in place of the icon, which fades out symmetrically so the
    // swap never reflows the row.
    expect(chevron?.getAttribute('class')).toContain('opacity-0');
    expect(chevron?.getAttribute('class')).toContain(
      'group-hover/sidebar-item:opacity-100',
    );
    expect(chevron?.getAttribute('class')).toContain('pointer-events-none');
    const iconWrapper = iconButton?.querySelector<HTMLElement>(
      '[data-testid="workspace-icon-disclosure-swap"] > span',
    );
    expect(iconWrapper?.getAttribute('class')).toContain(
      'group-hover/sidebar-item:opacity-0',
    );

    // A POINTER click (detail > 0) on the swapped slot toggles collapse via
    // the row-background fall-through.
    act(() => {
      iconButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
      );
    });
    expect(rendered.onToggleCollapsed).toHaveBeenCalledTimes(1);

    // Keyboard/AT activation synthesizes a detail-0 click and must NOT
    // toggle: the button announces reorder semantics, not collapse.
    act(() => {
      iconButton?.click();
    });
    expect(rendered.onToggleCollapsed).toHaveBeenCalledTimes(1);

    act(() => {
      rendered.root.unmount();
    });
  });

  it('keeps the disclosure chevron when the project has no worktrees', () => {
    const rendered = renderHeader({ worktreeCount: 0 });
    // Empty workspaces stay toggleable (cowork parity): the icon slot keeps
    // its hover-revealed chevron so the "No worktrees" empty state can be
    // disclosed, while the button's accessible name stays "Reorder".
    const iconButton = rendered.container.querySelector<HTMLButtonElement>(
      '[aria-label="Reorder Alpha"]',
    );
    expect(iconButton).not.toBeNull();
    expect(
      rendered.container.querySelector(
        '[data-testid="workspace-section-collapse-chevron"]',
      ),
    ).not.toBeNull();

    // A POINTER click (detail > 0) toggles collapse via the row-background
    // fall-through, exactly like a populated workspace.
    act(() => {
      iconButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
      );
    });
    expect(rendered.onToggleCollapsed).toHaveBeenCalledTimes(1);

    // Keyboard/AT activation synthesizes a detail-0 click and must NOT
    // toggle: the button announces reorder semantics, not collapse.
    act(() => {
      iconButton?.click();
    });
    expect(rendered.onToggleCollapsed).toHaveBeenCalledTimes(1);

    act(() => {
      rendered.root.unmount();
    });
  });

  it('gives every command row in the project menu a leading icon', () => {
    const rendered = renderHeader();
    const header = rendered.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-project-header-alpha"]',
    );

    act(() => {
      header?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 160,
        }),
      );
    });

    expectMenuCommandRowsHaveIcons(
      document.querySelector<HTMLElement>(
        '[data-testid="workspace-session-context-menu"]',
      ),
    );

    act(() => rendered.root.unmount());
  });

  it('uses the shared floating action-menu contract for session import', () => {
    const rendered = renderHeader();
    const header = rendered.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-project-header-alpha"]',
    );
    expect(header).not.toBeNull();
    if (!header) {
      throw new Error('Expected project header');
    }

    act(() => {
      header.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 160,
        }),
      );
    });

    const menu = document.querySelector<HTMLElement>(
      '[data-testid="workspace-session-context-menu"]',
    );
    const item = document.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-import-session-menu-item"]',
    );
    // The right-click menu carries the workspace's actions, not just the
    // session import.
    expect(
      document.querySelector('[data-testid="workspace-new-task-menu-item"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="workspace-settings-menu-item"]'),
    ).not.toBeNull();
    expect(menu?.classList).toContain('canopy-floating-menu');
    // Sidebar context menus appear instantly — no entry animation.
    expect(menu?.classList).toContain('canopy-floating-menu-no-motion');
    expect(menu?.classList).toContain('rounded-lg');
    expect(menu?.classList).toContain('bg-quaternary');
    expect(menu?.classList).toContain('p-1');
    expect(menu?.classList).toContain('shadow-xl');
    expect(item?.classList).toContain('canopy-dropdown-menu-item');
    expect(item?.classList).toContain('h-8');
    expect(item?.classList).toContain('rounded-md');
    expect(item?.classList).toContain('text-s');
    expect(item?.querySelector('.truncate')?.textContent).toBe(
      'Import session…',
    );

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(
      document.querySelector('[data-testid="workspace-session-context-menu"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(header);

    act(() => {
      rendered.root.unmount();
    });
  });

  it('preserves the cloud-connect gate before importing a session', () => {
    const requestConnect = jest
      .spyOn(useCloudConnectGateStore.getState(), 'requestConnect')
      .mockImplementation(() => {});
    const rendered = renderHeader();
    const header = rendered.container.querySelector<HTMLElement>(
      '[data-testid="sidebar-project-header-alpha"]',
    );

    act(() => {
      header?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 160,
        }),
      );
    });
    const item = document.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-import-session-menu-item"]',
    );
    act(() => item?.click());

    expect(requestConnect).toHaveBeenCalledWith(
      {},
      expect.any(Function) as () => void,
    );

    act(() => rendered.root.unmount());
  });
});

// A header renders in flow and again in the sticky slot and both pin bands.
// Every copy's fixed ids — including the disclosure chevron the header's own
// drag-handle slot renders — carry the surface suffix; the in-flow header
// stays bare (CAN-3127).
describe('pinned copy test ids', () => {
  const ids = [
    'workspace-section-actions',
    'workspace-section-counter',
    'workspace-kind-badge',
    'workspace-icon-disclosure-swap',
    'workspace-section-collapse-chevron',
  ];

  it.each(['sticky-slot', 'pin-top', 'pin-bottom'] as const)(
    'suffixes every fixed id on the %s copy',
    (surface) => {
      const { container, root } = renderHeader({ surface });
      try {
        for (const id of ids) {
          expect(
            container.querySelectorAll(`[data-testid="${id}-${surface}"]`),
          ).toHaveLength(1);
          expect(
            container.querySelectorAll(`[data-testid="${id}"]`),
          ).toHaveLength(0);
        }
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );

  it('keeps the in-flow header bare', () => {
    const { container, root } = renderHeader();
    try {
      for (const id of ids) {
        expect(
          container.querySelectorAll(`[data-testid="${id}"]`),
        ).toHaveLength(1);
      }
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
