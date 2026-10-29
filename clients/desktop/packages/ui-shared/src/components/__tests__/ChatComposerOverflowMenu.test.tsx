/**
 * @jest-environment jsdom
 */
/**
 * Unit coverage for the shared {@link ChatComposerOverflowMenu} (CAN-1229) — the
 * `⋯` dropdown that hosts the plan-mode / fast-mode / thinking-level controls on
 * the mobile composer toolbar. These tests pin the ARIA menu contract (roles,
 * `aria-checked` state display, keyboard navigation), the toggle-vs-cycle close
 * behavior, focus return to the trigger, and the shared Escape-stack
 * cooperation (Escape inside the menu is consumed with `preventDefault`).
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ChatComposerOverflowMenu,
  type ChatComposerOverflowMenuItemConfig,
} from '../ChatComposerOverflowMenu';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function cleanup(container: HTMLDivElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function click(el: Element | null | undefined): void {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function pressKey(el: Element | null | undefined, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    el?.dispatchEvent(event);
  });
  return event;
}

function makeItems(
  overrides: Partial<ChatComposerOverflowMenuItemConfig>[] = [],
): {
  items: ChatComposerOverflowMenuItemConfig[];
  onPlan: jest.Mock;
  onFast: jest.Mock;
  onThinking: jest.Mock;
} {
  const onPlan = jest.fn();
  const onFast = jest.fn();
  const onThinking = jest.fn();
  const items: ChatComposerOverflowMenuItemConfig[] = [
    {
      key: 'plan',
      icon: <svg data-testid="plan-icon" />,
      label: 'Plan mode',
      stateLabel: 'Off',
      active: false,
      onSelect: onPlan,
      closeOnSelect: true,
      ariaLabel: 'Plan mode off',
      dataTestId: 'overflow-plan',
      ...overrides[0],
    },
    {
      key: 'fast',
      icon: <svg data-testid="fast-icon" />,
      label: 'Fast mode',
      stateLabel: 'On',
      active: true,
      onSelect: onFast,
      closeOnSelect: true,
      ariaLabel: 'Fast mode on',
      dataTestId: 'overflow-fast',
      ...overrides[1],
    },
    {
      key: 'thinking',
      icon: <svg data-testid="thinking-icon" />,
      label: 'Thinking',
      stateLabel: 'High',
      active: true,
      onSelect: onThinking,
      closeOnSelect: false,
      ariaLabel: 'Thinking level high; tap to cycle',
      dataTestId: 'overflow-thinking',
      ...overrides[2],
    },
  ];
  return { items, onPlan, onFast, onThinking };
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

describe('ChatComposerOverflowMenu', () => {
  it('renders a collapsed trigger with the menu-button ARIA contract', () => {
    const { items } = makeItems();
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );
    const trigger = container.querySelector('[data-testid="overflow-trigger"]');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    // Closed by default: no menu in the DOM.
    expect(container.querySelector('[data-testid="overflow-menu"]')).toBeNull();
    cleanup(container, root);
  });

  /**
   * FOOTER-ONLY MENUS MUST OPEN BY KEYBOARD TOO.
   *
   * The phone composer folds its context-usage readout into the footer slot,
   * which can leave a menu with zero items but something real to show. The
   * click handler was taught that a footer counts as "something to show"; the
   * trigger's keydown handler was not, so ArrowDown/ArrowUp silently did
   * nothing on it.
   *
   * Enter/Space were never actually broken — returning early without calling
   * `preventDefault()` lets the button's native activation fire a click, which
   * reaches the click handler. The Arrow keys have no such fallback, which is
   * what made this a real keyboard-only dead end.
   */
  describe('footer-only menu', () => {
    const NO_ITEMS: ChatComposerOverflowMenuItemConfig[] = [];

    it.each<[string]>([['ArrowDown'], ['ArrowUp']])(
      'opens with %s when there are no items but a footer',
      (key) => {
        const { container, root } = render(
          <ChatComposerOverflowMenu
            items={NO_ITEMS}
            footerSlot={<span data-testid="overflow-footer-row">80% used</span>}
            triggerDataTestId="overflow-trigger"
            menuDataTestId="overflow-menu"
          />,
        );
        const trigger = container.querySelector<HTMLElement>(
          '[data-testid="overflow-trigger"]',
        );
        if (!trigger) throw new Error('no trigger');

        pressKey(trigger, key);

        expect(
          container.querySelector('[data-testid="overflow-menu"]'),
        ).not.toBeNull();
        expect(
          container.querySelector('[data-testid="overflow-footer-row"]'),
        ).not.toBeNull();
        cleanup(container, root);
      },
    );

    /**
     * Enter/Space must TOGGLE, not just open. Focus never enters an itemless
     * menu, so the in-menu key handler never sees them — the only thing that
     * can close it by keyboard is the trigger's own native activation reaching
     * the click handler. Swallowing the key with `preventDefault()` would leave
     * a keyboard user unable to close a menu with the key they opened it with,
     * and Escape being the only exit is not an acceptable answer.
     *
     * Verified in two halves, because jsdom does not synthesise the click a
     * real browser fires for Enter on a `<button>`: first that the handler does
     * not `preventDefault()` (which is what leaves the native activation free),
     * then that the resulting click path really does toggle both ways.
     */
    it('lets Enter toggle a footer-only menu rather than swallowing it', () => {
      const { container, root } = render(
        <ChatComposerOverflowMenu
          items={NO_ITEMS}
          footerSlot={<span data-testid="overflow-footer-row">80% used</span>}
          triggerDataTestId="overflow-trigger"
          menuDataTestId="overflow-menu"
        />,
      );
      const trigger = container.querySelector<HTMLElement>(
        '[data-testid="overflow-trigger"]',
      );
      if (!trigger) throw new Error('no trigger');

      // Not swallowed: the browser's native activation is left free to fire the
      // click that drives the open/close toggle.
      expect(pressKey(trigger, 'Enter').defaultPrevented).toBe(false);

      click(trigger);
      expect(
        container.querySelector('[data-testid="overflow-menu"]'),
      ).not.toBeNull();

      // ...and the same key closes it again.
      click(trigger);
      expect(
        container.querySelector('[data-testid="overflow-menu"]'),
      ).toBeNull();
      cleanup(container, root);
    });

    it.each<[string]>([['ArrowDown'], ['ArrowUp']])(
      'still ignores %s when there is neither an item nor a footer',
      (key) => {
        const { container, root } = render(
          <ChatComposerOverflowMenu
            items={NO_ITEMS}
            triggerDataTestId="overflow-trigger"
            menuDataTestId="overflow-menu"
          />,
        );
        const trigger = container.querySelector<HTMLElement>(
          '[data-testid="overflow-trigger"]',
        );
        if (!trigger) throw new Error('no trigger');

        pressKey(trigger, key);

        expect(
          container.querySelector('[data-testid="overflow-menu"]'),
        ).toBeNull();
        cleanup(container, root);
      },
    );
  });

  it('explains the trigger with a rich tooltip instead of a native title (CAN-2799)', () => {
    const { items } = makeItems();
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerTitle="More options"
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );
    const trigger = container.querySelector<HTMLElement>(
      '[data-testid="overflow-trigger"]',
    );
    expect(trigger?.hasAttribute('title')).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    act(() => {
      focusViaKeyboard(trigger);
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'More options',
    );

    // While the menu is open the tooltip is suppressed so it never overlaps
    // the surface the trigger just opened.
    click(trigger);
    expect(
      container.querySelector('[data-testid="overflow-menu"]'),
    ).not.toBeNull();
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    cleanup(container, root);
  });

  it('opens the menu and renders each item with its state label and checked state', () => {
    const { items } = makeItems();
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );
    click(container.querySelector('[data-testid="overflow-trigger"]'));

    const menu = container.querySelector('[data-testid="overflow-menu"]');
    expect(menu?.getAttribute('role')).toBe('menu');
    expect(
      container
        .querySelector('[data-testid="overflow-trigger"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');

    const plan = container.querySelector('[data-testid="overflow-plan"]');
    const fast = container.querySelector('[data-testid="overflow-fast"]');
    expect(plan?.getAttribute('role')).toBe('menuitemcheckbox');
    // Inactive item: aria-checked false, no check icon.
    expect(plan?.getAttribute('aria-checked')).toBe('false');
    expect(plan?.textContent).toContain('Plan mode');
    expect(plan?.textContent).toContain('Off');
    // Active item: aria-checked true.
    expect(fast?.getAttribute('aria-checked')).toBe('true');
    expect(fast?.textContent).toContain('On');
    cleanup(container, root);
  });

  it('toggles and closes on a plain toggle item, but keeps the menu open on a cycler', () => {
    const { items, onPlan, onThinking } = makeItems();
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );

    // Plan is a toggle (closeOnSelect): selecting it fires and closes.
    click(container.querySelector('[data-testid="overflow-trigger"]'));
    click(container.querySelector('[data-testid="overflow-plan"]'));
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="overflow-menu"]')).toBeNull();

    // Thinking is a cycler (closeOnSelect: false): selecting it fires and the
    // menu stays open so the advancing level remains visible.
    click(container.querySelector('[data-testid="overflow-trigger"]'));
    click(container.querySelector('[data-testid="overflow-thinking"]'));
    expect(onThinking).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="overflow-menu"]'),
    ).not.toBeNull();
    cleanup(container, root);
  });

  it('focuses the first item on open and walks with Arrow keys', () => {
    const { items } = makeItems();
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="overflow-trigger"]',
    );
    // ArrowDown on the trigger opens and focuses the first item.
    pressKey(trigger, 'ArrowDown');
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'overflow-plan',
    );

    const menu = container.querySelector('[data-testid="overflow-menu"]');
    pressKey(menu, 'ArrowDown');
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'overflow-fast',
    );
    pressKey(menu, 'ArrowUp');
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'overflow-plan',
    );
    // ArrowUp wraps to the last item.
    pressKey(menu, 'ArrowUp');
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'overflow-thinking',
    );
    cleanup(container, root);
  });

  it('activates the focused item with Enter', () => {
    const { items, onFast } = makeItems();
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );
    pressKey(
      container.querySelector('[data-testid="overflow-trigger"]'),
      'ArrowDown',
    );
    const menu = container.querySelector('[data-testid="overflow-menu"]');
    pressKey(menu, 'ArrowDown'); // move to fast
    pressKey(menu, 'Enter');
    expect(onFast).toHaveBeenCalledTimes(1);
    cleanup(container, root);
  });

  it('closes on Escape, returns focus to the trigger, and consumes the event', () => {
    const { items } = makeItems();
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );
    click(container.querySelector('[data-testid="overflow-trigger"]'));
    const menu = container.querySelector('[data-testid="overflow-menu"]');
    // Escape inside the menu must be preventDefault-ed so the shared overlay
    // stack (a background Sheet drawer) skips it.
    const event = pressKey(menu, 'Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector('[data-testid="overflow-menu"]')).toBeNull();
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'overflow-trigger',
    );
    cleanup(container, root);
  });

  it('skips disabled items in keyboard navigation and does not activate them', () => {
    const { items, onFast } = makeItems([{}, { disabled: true }]);
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );
    pressKey(
      container.querySelector('[data-testid="overflow-trigger"]'),
      'ArrowDown',
    );
    const menu = container.querySelector('[data-testid="overflow-menu"]');
    // From plan, ArrowDown skips the disabled fast item and lands on thinking.
    pressKey(menu, 'ArrowDown');
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'overflow-thinking',
    );
    // A direct click on the disabled item does nothing.
    click(container.querySelector('[data-testid="overflow-fast"]'));
    expect(onFast).not.toHaveBeenCalled();
    cleanup(container, root);
  });

  it('renders a cycler row as role=menuitem without a binary aria-checked', () => {
    // The thinking-level row is a multi-state cycler, so the portal passes
    // role=menuitem — a binary aria-checked would mis-announce the level.
    const { items } = makeItems([{}, {}, { role: 'menuitem' }]);
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );
    click(container.querySelector('[data-testid="overflow-trigger"]'));
    const thinking = container.querySelector(
      '[data-testid="overflow-thinking"]',
    );
    expect(thinking?.getAttribute('role')).toBe('menuitem');
    expect(thinking?.hasAttribute('aria-checked')).toBe(false);
    // Binary rows still default to menuitemcheckbox with aria-checked.
    const plan = container.querySelector('[data-testid="overflow-plan"]');
    expect(plan?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(plan?.hasAttribute('aria-checked')).toBe(true);
    cleanup(container, root);
  });

  it('wires aria-controls from the trigger to the open menu', () => {
    const { items } = makeItems();
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );
    const trigger = container.querySelector('[data-testid="overflow-trigger"]');
    // Closed: no dangling aria-controls.
    expect(trigger?.hasAttribute('aria-controls')).toBe(false);
    click(trigger);
    const menu = container.querySelector('[data-testid="overflow-menu"]');
    expect(menu?.id).toBeTruthy();
    expect(
      container
        .querySelector('[data-testid="overflow-trigger"]')
        ?.getAttribute('aria-controls'),
    ).toBe(menu?.id);
    cleanup(container, root);
  });

  it('never opens an empty/unfocusable menu when every item is disabled', () => {
    const { items } = makeItems([
      { disabled: true },
      { disabled: true },
      { disabled: true },
    ]);
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );
    const trigger = container.querySelector('[data-testid="overflow-trigger"]');
    click(trigger);
    expect(container.querySelector('[data-testid="overflow-menu"]')).toBeNull();
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    cleanup(container, root);
  });

  it('closes when a pointer-down lands outside the menu', () => {
    const { items } = makeItems();
    const { container, root } = render(
      <ChatComposerOverflowMenu
        items={items}
        triggerDataTestId="overflow-trigger"
        menuDataTestId="overflow-menu"
      />,
    );
    click(container.querySelector('[data-testid="overflow-trigger"]'));
    expect(
      container.querySelector('[data-testid="overflow-menu"]'),
    ).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
    });
    expect(container.querySelector('[data-testid="overflow-menu"]')).toBeNull();
    cleanup(container, root);
  });
});
