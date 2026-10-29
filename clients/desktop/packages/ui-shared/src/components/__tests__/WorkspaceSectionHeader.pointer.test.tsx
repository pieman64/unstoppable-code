/** @jest-environment jsdom */

import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkspaceSectionHeader } from '../WorkspaceSectionHeader';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function setCoarsePointer(matches: boolean): void {
  window.matchMedia = jest.fn().mockImplementation(
    (query: string): MediaQueryList =>
      ({
        matches: query === '(pointer: coarse)' && matches,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }) as MediaQueryList,
  );
}

/**
 * Keyboard-driven focus. The shared tooltips follow `:focus-visible`: a Tab
 * keydown reaches the document before focus moves, so the tooltip opens. A
 * bare `.focus()` is programmatic focus and keeps it closed.
 */
function focusViaKeyboard(element: HTMLElement | null | undefined): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
  );
  element?.focus();
}

describe('WorkspaceSectionHeader pointer behavior', () => {
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
    jest.restoreAllMocks();
  });

  it('rests after collapse without dropping keyboard focus, then reveals on Tab', () => {
    setCoarsePointer(false);
    function Host(): JSX.Element {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <WorkspaceSectionHeader
          name="Resting workspace"
          workspaceType="single-repo"
          worktreeCount={2}
          collapsed={collapsed}
          deferHoverActions
          textScale="sidebar"
          onToggleCollapse={() => setCollapsed((value) => !value)}
          onAdd={jest.fn()}
        />
      );
    }
    act(() => root.render(<Host />));
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse Resting workspace"]',
    );
    if (!toggle) throw new Error('Missing workspace collapse control');
    act(() => {
      toggle.focus();
      toggle.click();
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    expect(
      container.querySelector('[data-sidebar-header-resting="true"]'),
    ).not.toBeNull();
    void act(() =>
      toggle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      ),
    );
    expect(
      container.querySelector('[data-sidebar-header-resting="true"]'),
    ).toBeNull();
  });

  it('keeps the trailing collapse control visible while it retains keyboard focus', () => {
    setCoarsePointer(false);
    function Host(): JSX.Element {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <WorkspaceSectionHeader
          name="Keyboard workspace"
          workspaceType="single-repo"
          worktreeCount={2}
          collapsed={collapsed}
          deferHoverActions
          onSelectName={jest.fn()}
          onToggleCollapse={() => setCollapsed((value) => !value)}
          onAdd={jest.fn()}
        />
      );
    }
    act(() => root.render(<Host />));
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse Keyboard workspace"]',
    );
    if (!toggle) throw new Error('Missing trailing collapse control');
    act(() => {
      focusViaKeyboard(toggle);
      toggle.click();
    });
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-label')).toBe('Expand Keyboard workspace');
    const actions = container.querySelector(
      '[data-workspace-header-actions="true"]',
    );
    expect(
      actions?.classList.contains('pointer-fine:focus-within:visible'),
    ).toBe(true);
  });

  it('clears pointer focus from the trailing disclosure after collapse', () => {
    setCoarsePointer(false);
    function Host(): JSX.Element {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <WorkspaceSectionHeader
          name="Pointer disclosure"
          workspaceType="single-repo"
          worktreeCount={2}
          collapsed={collapsed}
          deferHoverActions
          onSelectName={jest.fn()}
          onToggleCollapse={() => setCollapsed((value) => !value)}
        />
      );
    }
    act(() => root.render(<Host />));
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse Pointer disclosure"]',
    );
    if (!toggle) throw new Error('Missing trailing disclosure');
    act(() => {
      toggle.focus();
      toggle.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      );
    });
    expect(toggle.getAttribute('aria-label')).toBe('Expand Pointer disclosure');
    expect(document.activeElement).not.toBe(toggle);
  });

  it('preserves the open menu and its focus return across a host collapse', () => {
    setCoarsePointer(false);
    const renderHeader = (collapsed: boolean): void => {
      root.render(
        <WorkspaceSectionHeader
          name="Editing workspace"
          workspaceType="single-repo"
          worktreeCount={2}
          collapsed={collapsed}
          dataTestId="editing-header"
          onToggleCollapse={jest.fn()}
          contextMenuActions={[
            { id: 'inspect', label: 'Inspect', onSelect: jest.fn() },
          ]}
        />,
      );
    };
    act(() => renderHeader(false));
    const header = container.querySelector<HTMLElement>(
      '[data-testid="editing-header"]',
    );
    if (!header) throw new Error('Missing workspace header');
    act(() => {
      header.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    if (!menu) throw new Error('Missing workspace menu');
    act(() => renderHeader(true));
    expect(header.getAttribute('data-sidebar-header-resting')).toBeNull();
    act(() => {
      menu.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(header);
  });

  it('ignores stationary pointer updates after collapse and reveals on movement', () => {
    setCoarsePointer(false);
    const renderHeader = (collapsed: boolean): void => {
      root.render(
        <WorkspaceSectionHeader
          name="Pointer workspace"
          workspaceType="single-repo"
          worktreeCount={2}
          collapsed={collapsed}
          dataTestId="pointer-header"
          onToggleCollapse={jest.fn()}
          onAdd={jest.fn()}
          deferHoverActions
        />,
      );
    };
    act(() => renderHeader(false));
    const header = container.querySelector<HTMLElement>(
      '[data-testid="pointer-header"]',
    );
    if (!header) throw new Error('Missing workspace header');
    act(() => {
      header.dispatchEvent(
        new MouseEvent('pointerover', {
          bubbles: true,
          clientX: 10,
          clientY: 10,
        }),
      );
      renderHeader(true);
    });
    act(() => {
      header.dispatchEvent(
        new MouseEvent('pointermove', {
          bubbles: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    expect(header.getAttribute('data-sidebar-header-resting')).toBe('true');
    act(() => {
      header.dispatchEvent(
        new MouseEvent('pointermove', {
          bubbles: true,
          clientX: 11,
          clientY: 10,
        }),
      );
    });
    expect(header.getAttribute('data-sidebar-header-resting')).toBeNull();
  });

  it('uses the name as the collapse toggle and omits the chevron for coarse pointers', () => {
    setCoarsePointer(true);
    const onSelectName = jest.fn();
    const onToggleCollapse = jest.fn();

    act(() => {
      root.render(
        <WorkspaceSectionHeader
          name="Touch workspace"
          workspaceType="single-repo"
          worktreeCount={2}
          collapsed={false}
          deferHoverActions
          onSelectName={onSelectName}
          onToggleCollapse={onToggleCollapse}
          onSettings={jest.fn()}
          onAdd={jest.fn()}
        />,
      );
    });

    const nameButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse Touch workspace"]',
    );
    expect(nameButton?.getAttribute('aria-expanded')).toBe('true');
    // Badge + name + settings + add; there is no separate chevron button.
    expect(container.querySelectorAll('button')).toHaveLength(4);

    act(() => nameButton?.click());
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    expect(onSelectName).not.toHaveBeenCalled();
  });

  it('keeps name selection and the dedicated collapse chevron for fine pointers', () => {
    setCoarsePointer(false);
    const onSelectName = jest.fn();
    const onToggleCollapse = jest.fn();

    act(() => {
      root.render(
        <WorkspaceSectionHeader
          name="Fine workspace"
          workspaceType="single-repo"
          worktreeCount={2}
          collapsed
          deferHoverActions
          onSelectName={onSelectName}
          onToggleCollapse={onToggleCollapse}
          onSettings={jest.fn()}
          onAdd={jest.fn()}
        />,
      );
    });

    const nameButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Select Fine workspace"]',
    );
    expect(nameButton?.hasAttribute('aria-expanded')).toBe(false);
    expect(
      container.querySelector('[aria-label="Expand Fine workspace"]'),
    ).not.toBeNull();
    // Fine pointers retain the badge, name, settings, add, and chevron pins.
    expect(container.querySelectorAll('button')).toHaveLength(5);

    act(() => nameButton?.click());
    expect(onSelectName).toHaveBeenCalledTimes(1);
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });

  // The shared workspace sidebar (web portal cloud/remote-control workspaces)
  // renders this header WITHOUT `inlineCollapseChevron`, so the deferred
  // hover-action guard is live there. Entering the row anywhere over the
  // trailing rail — the usual approach when aiming for "+" — armed the guard,
  // and the next press was rerouted to disclosure: the workspace collapsed or
  // expanded instead of creating a session.
  it('lets a revealed trailing control own a press that lands on it', () => {
    setCoarsePointer(false);
    const onToggleCollapse = jest.fn();
    const onAdd = jest.fn();

    act(() => {
      root.render(
        <WorkspaceSectionHeader
          name="Cloud workspace"
          workspaceType="cowork"
          worktreeCount={2}
          collapsed={false}
          textScale="sidebar"
          deferHoverActions
          onToggleCollapse={onToggleCollapse}
          onSelectName={jest.fn()}
          onAdd={onAdd}
          onSettings={jest.fn()}
        />,
      );
    });

    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="Create chat for Cloud workspace"]',
    );
    expect(add).not.toBeNull();

    act(() => focusViaKeyboard(add));
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Create chat',
    );

    act(() => {
      const header = container.firstElementChild;
      // Entering at the trailing rail (jsdom reports a zero rect, which the
      // guard reads as "inside the action slot") arms the guard.
      header?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      add?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
      add?.click();
    });

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });

  it('still routes a press on the trailing rail background to disclosure', () => {
    setCoarsePointer(false);
    const onToggleCollapse = jest.fn();

    act(() => {
      root.render(
        <WorkspaceSectionHeader
          name="Cloud workspace"
          workspaceType="cowork"
          worktreeCount={2}
          collapsed={false}
          textScale="sidebar"
          deferHoverActions
          onToggleCollapse={onToggleCollapse}
          onSelectName={jest.fn()}
          onAdd={jest.fn()}
          onSettings={jest.fn()}
        />,
      );
    });

    const actions = container.querySelector<HTMLElement>(
      '[data-testid="workspace-section-actions"]',
    );

    act(() => {
      const header = container.firstElementChild;
      header?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      actions?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      );
    });

    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  describe('inlineCollapseChevron', () => {
    it('swaps the badge for the disclosure chevron on hover instead of rendering one after the name', () => {
      setCoarsePointer(false);
      const onToggleCollapse = jest.fn();

      act(() => {
        root.render(
          <WorkspaceSectionHeader
            name="Chevron workspace"
            workspaceType="single-repo"
            worktreeCount={2}
            collapsed={false}
            textScale="sidebar"
            deferHoverActions
            inlineCollapseChevron
            showCollapseChevron={false}
            onToggleCollapse={onToggleCollapse}
            onSettings={jest.fn()}
            onAdd={jest.fn()}
          />,
        );
      });

      const nameButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Collapse Chevron workspace"]',
      );
      const swap = container.querySelector<HTMLElement>(
        '[data-testid="workspace-icon-disclosure-swap"]',
      );
      const chevron = container.querySelector<HTMLElement>(
        '[data-testid="workspace-section-collapse-chevron"]',
      );
      expect(swap).not.toBeNull();
      expect(chevron).not.toBeNull();
      // The chevron overlays the leading badge slot rather than rendering
      // after the workspace name inside the toggle button.
      expect(nameButton?.contains(chevron)).toBe(false);
      expect(swap?.contains(chevron)).toBe(true);
      // No chevron in the default state: hidden at rest and revealed on row
      // hover/focus, while the badge fades out symmetrically in place.
      expect(chevron?.getAttribute('class')).toContain('opacity-0');
      expect(chevron?.getAttribute('class')).toContain(
        'group-hover/sidebar-item:opacity-100',
      );
      expect(chevron?.getAttribute('class')).toContain(
        'group-focus-within/sidebar-item:opacity-100',
      );
      const badgeWrapper = swap?.querySelector<HTMLElement>(':scope > span');
      expect(badgeWrapper?.getAttribute('class')).toContain(
        'group-hover/sidebar-item:opacity-0',
      );
    });

    it('toggles from the row background but keeps controls and the action region independent', () => {
      setCoarsePointer(false);
      const onToggleCollapse = jest.fn();
      const onSettings = jest.fn();

      act(() => {
        root.render(
          <WorkspaceSectionHeader
            name="Row workspace"
            workspaceType="single-repo"
            worktreeCount={2}
            collapsed={false}
            textScale="sidebar"
            deferHoverActions
            inlineCollapseChevron
            showCollapseChevron={false}
            onToggleCollapse={onToggleCollapse}
            onSettings={onSettings}
            onAdd={jest.fn()}
          />,
        );
      });

      const rowRoot = container.firstElementChild;
      if (!(rowRoot instanceof HTMLElement)) {
        throw new Error('Expected header row root');
      }

      // The whole row container is the disclosure hitbox: a click on the row
      // background (padding, gaps, strips around the controls) toggles.
      act(() => rowRoot.click());
      expect(onToggleCollapse).toHaveBeenCalledTimes(1);

      // The trailing action region stays inert so near-misses on settings/add
      // cannot collapse the section.
      const actions = container.querySelector<HTMLElement>(
        '[data-testid="workspace-section-actions"]',
      );
      act(() => actions?.click());
      expect(onToggleCollapse).toHaveBeenCalledTimes(1);

      // Buttons keep their own actions without also toggling through the row.
      const settings = container.querySelector<HTMLButtonElement>(
        '[aria-label="Settings for Row workspace"]',
      );
      act(() => settings?.click());
      expect(onSettings).toHaveBeenCalledTimes(1);
      expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    });

    it('makes the built-in badge a collapse toggle on the no-slot path', () => {
      setCoarsePointer(false);
      const onToggleCollapse = jest.fn();

      act(() => {
        root.render(
          <WorkspaceSectionHeader
            name="Badge workspace"
            workspaceType="single-repo"
            worktreeCount={2}
            collapsed={false}
            textScale="sidebar"
            deferHoverActions
            inlineCollapseChevron
            showCollapseChevron={false}
            onToggleCollapse={onToggleCollapse}
            onAdd={jest.fn()}
          />,
        );
      });

      // Without a host dragHandleSlot the built-in badge carries the hover
      // chevron, so clicking it must toggle — a visible disclosure control
      // that ignored clicks would be functionally dead on this path.
      const badgeToggle = container.querySelector<HTMLButtonElement>(
        '[aria-label="Collapse project Badge workspace"]',
      );
      expect(badgeToggle).not.toBeNull();
      expect(
        badgeToggle?.querySelector(
          '[data-testid="workspace-section-collapse-chevron"]',
        ),
      ).not.toBeNull();
      act(() => badgeToggle?.click());
      expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    });

    it('keeps the row background inert when the section cannot be toggled', () => {
      setCoarsePointer(false);
      const onToggleCollapse = jest.fn();

      act(() => {
        root.render(
          <WorkspaceSectionHeader
            name="Empty row workspace"
            workspaceType="single-repo"
            worktreeCount={0}
            collapsed={false}
            textScale="sidebar"
            deferHoverActions
            inlineCollapseChevron
            showCollapseChevron={false}
            onToggleCollapse={onToggleCollapse}
            onAdd={jest.fn()}
          />,
        );
      });

      const rowRoot = container.firstElementChild;
      if (!(rowRoot instanceof HTMLElement)) {
        throw new Error('Expected header row root');
      }
      act(() => rowRoot.click());
      expect(onToggleCollapse).not.toHaveBeenCalled();
    });

    it('keeps the chevron hidden at rest while collapsed, pre-rotated for the reveal', () => {
      setCoarsePointer(false);

      act(() => {
        root.render(
          <WorkspaceSectionHeader
            name="Chevron workspace"
            workspaceType="single-repo"
            worktreeCount={2}
            collapsed
            textScale="sidebar"
            deferHoverActions
            inlineCollapseChevron
            showCollapseChevron={false}
            onToggleCollapse={jest.fn()}
            onSettings={jest.fn()}
            onAdd={jest.fn()}
          />,
        );
      });

      const chevron = container.querySelector<HTMLElement>(
        '[data-testid="workspace-section-collapse-chevron"]',
      );
      expect(chevron).not.toBeNull();
      // Collapsed rows no longer pin the chevron visible in their default
      // state; it stays hover-revealed and only the rotation persists.
      expect(chevron?.getAttribute('class')).toContain('opacity-0');
      expect(chevron?.getAttribute('class')).toContain('-rotate-90');
      // Expanding/collapsing while hovered animates the rotation (Tailwind 4
      // rotate-* utilities set the standalone `rotate` property).
      expect(chevron?.getAttribute('class')).toContain(
        'transition-[opacity,rotate]',
      );
      // The only opacity-100 classes are the hover/focus reveal variants.
      const classNames = chevron?.getAttribute('class')?.split(/\s+/) ?? [];
      expect(classNames).not.toContain('opacity-100');
    });

    it('omits the chevron when the section cannot be toggled', () => {
      setCoarsePointer(false);

      act(() => {
        root.render(
          <WorkspaceSectionHeader
            name="Empty workspace"
            workspaceType="single-repo"
            worktreeCount={0}
            collapsed={false}
            textScale="sidebar"
            deferHoverActions
            inlineCollapseChevron
            showCollapseChevron={false}
            onToggleCollapse={jest.fn()}
            onAdd={jest.fn()}
          />,
        );
      });

      expect(
        container.querySelector(
          '[data-testid="workspace-section-collapse-chevron"]',
        ),
      ).toBeNull();
    });

    it('never routes a trailing-action press to the collapse toggle', () => {
      setCoarsePointer(false);
      const onToggleCollapse = jest.fn();
      const onSettings = jest.fn();

      act(() => {
        root.render(
          <WorkspaceSectionHeader
            name="Guarded workspace"
            workspaceType="single-repo"
            worktreeCount={2}
            collapsed={false}
            textScale="sidebar"
            deferHoverActions
            inlineCollapseChevron
            showCollapseChevron={false}
            onToggleCollapse={onToggleCollapse}
            onSettings={onSettings}
            onAdd={jest.fn()}
          />,
        );
      });

      const settings = container.querySelector<HTMLButtonElement>(
        '[aria-label="Settings for Guarded workspace"]',
      );
      const actions = container.querySelector<HTMLElement>(
        '[data-testid="workspace-section-actions"]',
      );
      expect(settings).not.toBeNull();
      expect(actions?.className).toContain('pointer-fine:inset-y-0');

      // Enter the row directly at the trailing controls and press without an
      // intermediate move. Previously the first such press was rerouted to
      // disclosure; the settings button must own it now.
      act(() => {
        const header = container.firstElementChild;
        // MouseEvent carries every field the pointer handlers read; jsdom
        // dispatches purely by type, and React derives pointerenter from
        // pointerover.
        header?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
        settings?.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        );
        settings?.click();
      });

      expect(onToggleCollapse).not.toHaveBeenCalled();
      expect(onSettings).toHaveBeenCalledTimes(1);
    });
  });
});
