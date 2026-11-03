/**
 * @jest-environment jsdom
 *
 * jsdom-only behavior for the shared `Tooltip`: content is rendered via
 * `createPortal` into `document.body`, so it is absent until the trigger is
 * hovered/focused. These tests exercise the open path, viewport clamping, and
 * the optional interactive link (with its focus hover-bridge).
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetInputModality } from '../../lib/input-modality';
import { Tooltip } from '../Tooltip';
import { useOverlayEscape } from '../useOverlayEscape';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function findTrigger(container: HTMLElement): HTMLButtonElement {
  const trigger = container.querySelector<HTMLButtonElement>('button');
  if (!trigger) {
    throw new Error('Trigger button not found');
  }
  return trigger;
}

/** Stands in for a dialog or sheet: closes on Escape through the shared stack. */
function EscapeOverlay({
  onClose,
  children,
}: {
  onClose: () => void;
  children: JSX.Element;
}): JSX.Element {
  useOverlayEscape(true, onClose);
  return children;
}

function pressEscape(
  target: EventTarget,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function findPortalTooltip(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="tooltip"]');
}

/**
 * Focuses `element` the way Tab traversal does: a keydown reaches the document
 * first, so the focus that follows reads as keyboard-driven (`:focus-visible`).
 * Bare `.focus()` is programmatic focus and must NOT open a tooltip.
 */
function focusViaKeyboard(element: HTMLElement | null | undefined): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
  );
  element?.focus();
}

describe('Tooltip (portal)', () => {
  beforeEach(() => {
    resetInputModality(document);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('waits 100ms and cancels pending hover when the pointer leaves', () => {
    jest.useFakeTimers();
    const { container, root } = render(
      <Tooltip label="Delayed tip" openDelay={100}>
        <button>trigger</button>
      </Tooltip>,
    );
    const trigger = findTrigger(container);
    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => jest.advanceTimersByTime(99));
    expect(findPortalTooltip()).toBeNull();
    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    act(() => jest.advanceTimersByTime(100));
    expect(findPortalTooltip()).toBeNull();
    act(() => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => jest.advanceTimersByTime(100));
    expect(findPortalTooltip()?.textContent).toBe('Delayed tip');
    act(() => root.unmount());
    jest.useRealTimers();
  });

  it('does not open on programmatic focus with no preceding input', () => {
    // Regression: after a base-branch pick, the PR status bar refocuses its
    // trigger. That `.focus()` is programmatic and must not pop the tooltip
    // open until blur.
    const { container, root } = render(
      <Tooltip label="release/next">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      const trigger = findTrigger(container);
      act(() => {
        trigger.focus();
      });
      expect(document.activeElement).toBe(trigger);
      expect(findPortalTooltip()).toBeNull();
      expect(trigger.getAttribute('aria-describedby')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('opens when focus arrives by keyboard', () => {
    const { container, root } = render(
      <Tooltip label="release/next">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      act(() => {
        focusViaKeyboard(findTrigger(container));
      });
      expect(findPortalTooltip()?.textContent).toContain('release/next');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('describes a focusable span itself rather than its decorative children', () => {
    const { container, root } = render(
      <Tooltip label="Full setup explanation">
        <span tabIndex={0} data-testid="status-trigger">
          <span aria-hidden="true">Working</span>
        </span>
      </Tooltip>,
    );
    try {
      const trigger = container.querySelector<HTMLElement>(
        '[data-testid="status-trigger"]',
      );
      act(() => focusViaKeyboard(trigger));
      expect(findPortalTooltip()).not.toBeNull();
      expect(trigger?.getAttribute('aria-describedby')).toBe(
        findPortalTooltip()?.id,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it('does not open when focus follows a pointer press', () => {
    const { container, root } = render(
      <Tooltip label="release/next">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      const trigger = findTrigger(container);
      act(() => {
        // Even after earlier keyboard use, a pointer press resets modality.
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
        );
        trigger.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        trigger.focus();
      });
      expect(document.activeElement).toBe(trigger);
      expect(findPortalTooltip()).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('mounts the tooltip into document.body on focus and shows the label', () => {
    const { container, root } = render(
      <Tooltip label="Worktrees">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      expect(findPortalTooltip()).toBeNull();

      act(() => {
        focusViaKeyboard(findTrigger(container));
      });

      const tooltip = findPortalTooltip();
      expect(tooltip).not.toBeNull();
      expect(container.contains(tooltip)).toBe(false);
      expect(tooltip?.textContent).toContain('Worktrees');
      expect(tooltip?.className).toContain('text-xs');
      expect(tooltip?.className).toContain('font-normal');
      expect(tooltip?.className).not.toContain('font-[450]');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows a shortcut as a key cap after the label', () => {
    const { container, root } = render(
      <Tooltip label="Add files and more" shortcut="@">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      act(() => {
        focusViaKeyboard(findTrigger(container));
      });

      const tooltip = findPortalTooltip();
      expect(tooltip?.textContent).toBe('Add files and more@');
      expect(tooltip?.querySelector('kbd')?.textContent).toBe('@');
      // A filled capsule with no border, and `@` lifted to centre its
      // low-sitting ink.
      const cap = tooltip?.querySelector('kbd');
      expect(cap?.className).toContain('rounded-full');
      expect(cap?.className).toContain('bg-muted');
      expect(cap?.className).not.toMatch(/(^|\s)border(\s|$)/);
      expect(tooltip?.querySelector('kbd > span')?.className).toContain(
        '-translate-y-px',
      );
      // The cap's right inset matches its 4px top and bottom insets.
      expect(tooltip?.className).toContain('pr-1');
      expect(tooltip?.className).toContain('py-1');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('waits half a second on hover with the long delay, but opens at once on keyboard focus', () => {
    jest.useFakeTimers();
    const { container, root } = render(
      <Tooltip label="Model for this chat" delay="long">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      const trigger = findTrigger(container);
      act(() => {
        trigger?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(findPortalTooltip()).toBeNull();
      act(() => {
        jest.advanceTimersByTime(499);
      });
      expect(findPortalTooltip()).toBeNull();
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(findPortalTooltip()?.textContent).toContain('Model for this chat');

      // Leaving before the delay cancels it.
      act(() => {
        trigger?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      expect(findPortalTooltip()).toBeNull();
      act(() => {
        trigger?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        jest.advanceTimersByTime(250);
        trigger?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        jest.advanceTimersByTime(500);
      });
      expect(findPortalTooltip()).toBeNull();

      act(() => {
        focusViaKeyboard(trigger);
      });
      expect(findPortalTooltip()).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      jest.useRealTimers();
    }
  });

  it('opens on pointer movement when the trigger appeared under a resting cursor', () => {
    // Regression (CAN-2799 follow-up): a control the pointer is resting on
    // unmounts and a Tooltip trigger takes its place (e.g. the update banner
    // swapping from its split row to the error button). Chromium dispatches
    // no `mouseout` for the removed node and delivers the new trigger's
    // `mouseover` with the nearest still-connected ancestor as
    // `relatedTarget` — a React-rendered node with a fiber — so React's
    // enter/leave plugin assumes the matching `mouseout` will handle it and
    // never fires `onMouseEnter`. The user then moves the pointer within the
    // trigger — which only yields `mousemove` — and must still get the tooltip.
    function Swap({ swapped }: { swapped: boolean }): JSX.Element {
      return (
        <div data-testid="host">
          {swapped ? (
            <Tooltip label="GitHub release request failed with HTTP 403.">
              <button type="button">Update failed</button>
            </Tooltip>
          ) : (
            <button type="button" data-testid="old">
              Install when idle
            </button>
          )}
        </div>
      );
    }
    const { container, root } = render(<Swap swapped={false} />);

    try {
      const oldButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="old"]',
      );
      const host = container.querySelector<HTMLElement>('[data-testid="host"]');
      if (!oldButton || !host) throw new Error('fixture not found');
      act(() => {
        oldButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });

      act(() => {
        root.render(<Swap swapped />);
      });
      expect(oldButton.isConnected).toBe(false);

      const trigger = findTrigger(container);
      act(() => {
        trigger.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true, relatedTarget: host }),
        );
      });
      // Documents the swallowed enter: React bails on this `mouseover`.
      expect(findPortalTooltip()).toBeNull();

      act(() => {
        trigger.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      });
      expect(findPortalTooltip()?.textContent).toContain(
        'GitHub release request failed with HTTP 403.',
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('stacks above dialog overlays that raise their own z-index', () => {
    const { container, root } = render(
      <Tooltip label="Managed by Acme">
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    try {
      const trigger = container.querySelector('button');
      act(() => focusViaKeyboard(trigger));

      // The tooltip portals to `document.body`, so its stacking level competes
      // with every other body-level overlay rather than with its trigger's
      expect(findPortalTooltip()?.className).toContain('z-tooltip');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('uses the shared quaternary surface with tooltip elevation', () => {
    const { container, root } = render(
      <Tooltip label="Surface">
        <button type="button">Trigger</button>
      </Tooltip>,
    );

    try {
      const trigger = container.querySelector('button');
      act(() => focusViaKeyboard(trigger));

      const tooltip = findPortalTooltip();
      expect(tooltip?.className).toContain('rounded-md');
      expect(tooltip?.className).not.toContain('rounded-lg');
      expect(tooltip?.className).toContain('bg-quaternary');
      expect(tooltip?.className).toContain('shadow-tooltip');
      expect(tooltip?.className).not.toContain('border');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('wires aria-describedby to the trigger while open', () => {
    const { container, root } = render(
      <Tooltip label="Settings">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      const trigger = findTrigger(container);
      expect(trigger.getAttribute('aria-describedby')).toBeNull();

      act(() => {
        focusViaKeyboard(trigger);
      });

      const tooltip = findPortalTooltip();
      expect(tooltip?.id).toBeTruthy();
      expect(trigger.getAttribute('aria-describedby')).toBe(tooltip?.id);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('clamps the tooltip inside the viewport against the right edge', () => {
    const { container, root } = render(
      <Tooltip label="Edge label">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      const trigger = findTrigger(container);
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 800,
      });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 600,
      });
      jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 116,
        left: 780,
        right: 800,
        width: 20,
        height: 16,
        x: 780,
        y: 100,
        toJSON: () => ({}),
      });
      const offsetWidthSpy = jest
        .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
        .mockReturnValue(220);
      const offsetHeightSpy = jest
        .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
        .mockReturnValue(80);

      try {
        act(() => {
          focusViaKeyboard(trigger);
        });
        const style = findPortalTooltip()?.style;
        if (!style) throw new Error('Tooltip style missing');
        const left = parseFloat(style.left || '0');
        expect(left).toBeLessThanOrEqual(572);
        expect(left).toBeGreaterThanOrEqual(0);
      } finally {
        offsetWidthSpy.mockRestore();
        offsetHeightSpy.mockRestore();
      }
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it.each([
    ['opens right', 100, 100, 150, 68],
    ['falls back left', 750, 100, 520, 68],
    ['clamps at the top', 100, 0, 150, 8],
    ['clamps at the bottom', 100, 590, 150, 512],
    ['clamps when neither side fits', 100, 100, 8, 68],
  ])('right placement %s', (scenario, x, y, left, top) => {
    const width = scenario === 'clamps when neither side fits' ? 780 : 220;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 600,
    });
    const { container, root } = render(
      <Tooltip label="Section description" placement="right">
        <button type="button">trigger</button>
      </Tooltip>,
    );
    const wrapper = findTrigger(container).parentElement;
    if (!wrapper) throw new Error('Tooltip wrapper missing');
    const rectSpy = jest
      .spyOn(wrapper, 'getBoundingClientRect')
      .mockReturnValue({
        x,
        y,
        left: x,
        top: y,
        right: x + 40,
        bottom: y + 16,
        width: 40,
        height: 16,
        toJSON: () => ({}),
      });
    const widthSpy = jest
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockReturnValue(width);
    const heightSpy = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(80);
    try {
      act(() => focusViaKeyboard(findTrigger(container)));
      expect(findPortalTooltip()?.style.left).toBe(`${left}px`);
      expect(findPortalTooltip()?.style.top).toBe(`${top}px`);
    } finally {
      act(() => root.unmount());
      rectSpy.mockRestore();
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
  });

  it('marks a plain tip to draw above an in-app browser page, but not one with a link', () => {
    const plain = render(
      <Tooltip label="Plain tip">
        <button type="button">trigger</button>
      </Tooltip>,
    );
    try {
      act(() => {
        focusViaKeyboard(findTrigger(plain.container));
      });
      expect(
        findPortalTooltip()?.getAttribute('data-canopy-above-browser'),
      ).toBe('true');
    } finally {
      act(() => plain.root.unmount());
    }
    document.body.innerHTML = '';

    // A tip with a link takes the pointer, which a copy above the page cannot.
    const linked = render(
      <Tooltip label="With link" link={{ href: 'https://example.com/docs' }}>
        <button type="button">trigger</button>
      </Tooltip>,
    );
    try {
      act(() => {
        focusViaKeyboard(findTrigger(linked.container));
      });
      expect(
        findPortalTooltip()?.hasAttribute('data-canopy-above-browser'),
      ).toBe(false);
    } finally {
      act(() => linked.root.unmount());
    }
  });

  it('renders an interactive link and keeps the tooltip open when focus moves into it', () => {
    const { container, root } = render(
      <Tooltip label="With link" link={{ href: 'https://example.com/docs' }}>
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      act(() => {
        focusViaKeyboard(findTrigger(container));
      });

      const tooltip = findPortalTooltip();
      expect(tooltip).not.toBeNull();
      // Interactive tooltips accept pointer events so the link is clickable.
      expect(tooltip?.className).toContain('pointer-events-auto');

      const link = tooltip?.querySelector('a');
      expect(link).not.toBeNull();
      expect(link?.getAttribute('href')).toBe('https://example.com/docs');
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
      // Defaults to "Learn more" when no text is provided.
      expect(link?.textContent).toBe('Learn more');

      // Focus moving from the trigger into the link (relatedTarget inside the
      // tooltip) must NOT close the tooltip — this is the keyboard hover-bridge.
      act(() => {
        findTrigger(container).dispatchEvent(
          new FocusEvent('focusout', {
            bubbles: true,
            relatedTarget: link,
          }),
        );
      });
      expect(findPortalTooltip()).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders a same-tab link with no target/rel when external is false', () => {
    const { container, root } = render(
      <Tooltip
        label="Locked"
        link={{
          href: '/organization/org-123/settings?tab=billing',
          text: 'Upgrade',
          external: false,
        }}
      >
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      act(() => {
        focusViaKeyboard(findTrigger(container));
      });

      const link = findPortalTooltip()?.querySelector('a');
      expect(link).not.toBeNull();
      expect(link?.getAttribute('href')).toBe(
        '/organization/org-123/settings?tab=billing',
      );
      expect(link?.textContent).toBe('Upgrade');
      // In-app routes must navigate in the same tab: no new-tab plumbing.
      expect(link?.hasAttribute('target')).toBe(false);
      expect(link?.hasAttribute('rel')).toBe(false);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('keeps new-tab attributes when external is explicitly true', () => {
    const { container, root } = render(
      <Tooltip
        label="With link"
        link={{ href: 'https://example.com/docs', external: true }}
      >
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      act(() => {
        focusViaKeyboard(findTrigger(container));
      });

      const link = findPortalTooltip()?.querySelector('a');
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders the trigger with no tooltip wiring when disabled', () => {
    const { container, root } = render(
      <Tooltip label="Environments" disabled>
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      const trigger = findTrigger(container);
      // No wrapper span and no aria-describedby are added in the disabled state.
      expect(trigger.parentElement).toBe(container);
      expect(trigger.getAttribute('aria-describedby')).toBeNull();

      act(() => {
        focusViaKeyboard(trigger);
      });

      // Focusing the trigger must not mount the portal tooltip.
      expect(findPortalTooltip()).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('suppresses an open tooltip without remounting or blurring its trigger', () => {
    const { container, root } = render(
      <Tooltip label="CPU 23%, Memory 0.5 GB">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      const trigger = findTrigger(container);
      act(() => {
        focusViaKeyboard(trigger);
      });
      expect(findPortalTooltip()).not.toBeNull();

      act(() => {
        root.render(
          <Tooltip label="CPU 23%, Memory 0.5 GB" suppressed>
            <button type="button">trigger</button>
          </Tooltip>,
        );
      });

      expect(findPortalTooltip()).toBeNull();
      expect(findTrigger(container)).toBe(trigger);
      expect(document.activeElement).toBe(trigger);

      act(() => {
        trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(findPortalTooltip()).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('shows and removes a tooltip immediately without transitions', () => {
    const { container, root } = render(
      <Tooltip label="Wake lock">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      const trigger = findTrigger(container);
      act(() => {
        focusViaKeyboard(trigger);
      });

      const tooltip = findPortalTooltip();
      expect(tooltip?.className).not.toContain('transition');
      expect(tooltip?.className).not.toContain('duration-');
      expect(tooltip?.className).not.toContain('translate-');
      expect(tooltip?.className).not.toContain('opacity-');

      act(() => {
        trigger.blur();
      });
      expect(findPortalTooltip()).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('re-centers when the label changes while mounted', () => {
    // A mounted tooltip can swap content in place (e.g. a toggle button whose
    // action label flips on click while the pointer stays put); the position
    // must be recomputed for the new tooltip width.
    const CHAR_WIDTH = 10;
    const offsetWidthDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'offsetWidth',
    );
    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'offsetHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement): number {
        return (this.textContent?.length ?? 0) * CHAR_WIDTH;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(): number {
        return 20;
      },
    });
    const triggerRect: DOMRect = {
      x: 500,
      y: 300,
      width: 28,
      height: 24,
      top: 300,
      left: 500,
      right: 528,
      bottom: 324,
      toJSON: (): unknown => ({}),
    };
    const rectSpy = jest
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(triggerRect);

    const expectedLeft = (label: string): string =>
      `${500 + 28 / 2 - (label.length * CHAR_WIDTH) / 2}px`;

    const renderTooltip = (label: string): JSX.Element => (
      <Tooltip label={label}>
        <button type="button">trigger</button>
      </Tooltip>
    );
    const { container, root } = render(renderTooltip('Short'));

    try {
      act(() => {
        focusViaKeyboard(findTrigger(container));
      });
      expect(findPortalTooltip()?.style.left).toBe(expectedLeft('Short'));

      act(() => {
        root.render(renderTooltip('Considerably longer label'));
      });
      expect(findPortalTooltip()?.textContent).toContain(
        'Considerably longer label',
      );
      expect(findPortalTooltip()?.style.left).toBe(
        expectedLeft('Considerably longer label'),
      );
    } finally {
      act(() => {
        root.unmount();
      });
      rectSpy.mockRestore();
      if (offsetWidthDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          'offsetWidth',
          offsetWidthDescriptor,
        );
      }
      if (offsetHeightDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          'offsetHeight',
          offsetHeightDescriptor,
        );
      }
    }
  });

  it('uses custom link text when provided', () => {
    const { container, root } = render(
      <Tooltip
        label="With link"
        link={{ href: 'https://example.com', text: 'Read the guide' }}
      >
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      act(() => {
        focusViaKeyboard(findTrigger(container));
      });
      expect(findPortalTooltip()?.querySelector('a')?.textContent).toBe(
        'Read the guide',
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('supports inverse tone and right placement', () => {
    const { container, root } = render(
      <Tooltip label="Why disabled" placement="right" tone="inverse">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      act(() => {
        focusViaKeyboard(findTrigger(container));
      });
      const tip = findPortalTooltip();
      expect(tip?.textContent).toContain('Why disabled');
      expect(tip?.className).toContain('bg-tooltip-inverse');
      expect(tip?.className).toContain('fg-tooltip-inverse');
      // Tone changes the surface colour only. Width and wrapping stay the
      // shared single-line default so tone never reflows an existing caller.
      expect(tip?.className).toContain('whitespace-nowrap');
      expect(tip?.className).not.toContain('max-w-36');
      expect(tip?.className).not.toContain('whitespace-normal');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('closes a hover-opened tip on Escape and keeps the dialog beneath it open', () => {
    const onClose = jest.fn();
    const { container, root } = render(
      <EscapeOverlay onClose={onClose}>
        <Tooltip label="Hover tip">
          <button type="button">trigger</button>
        </Tooltip>
      </EscapeOverlay>,
    );

    try {
      const trigger = findTrigger(container);
      act(() => {
        trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(findPortalTooltip()).not.toBeNull();

      // Focus is not on the trigger: the pointer opened the tip.
      expect(pressEscape(document.body).defaultPrevented).toBe(true);
      expect(findPortalTooltip()).toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      // The resting pointer does not bring it back.
      act(() => {
        trigger.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      });
      expect(findPortalTooltip()).toBeNull();

      // With no tip open, Escape belongs to the dialog again.
      pressEscape(document.body);
      expect(onClose).toHaveBeenCalledTimes(1);

      // Leaving and coming back shows the tip again.
      act(() => {
        trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(findPortalTooltip()).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('lets the focused control take Escape first where React listens on the document', () => {
    // On web, Next.js hydrates the React root on `document`, so a focused
    // control's onKeyDown (SearchField clearing, InlineTextInput cancelling)
    // runs from a document listener. A tip under the resting pointer must not
    // take the press before it.
    const onControlEscape = jest.fn((event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    });
    document.addEventListener('keydown', onControlEscape);
    const { container, root } = render(
      <Tooltip label="Hover tip">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      act(() => {
        findTrigger(container).dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(findPortalTooltip()).not.toBeNull();

      pressEscape(document.body);
      expect(onControlEscape).toHaveBeenCalledTimes(1);
      // The control handled it, so the tip leaves this press alone.
      expect(findPortalTooltip()).not.toBeNull();

      // An unhandled press still closes the tip.
      document.removeEventListener('keydown', onControlEscape);
      expect(pressEscape(document.body).defaultPrevented).toBe(true);
      expect(findPortalTooltip()).toBeNull();
    } finally {
      document.removeEventListener('keydown', onControlEscape);
      act(() => {
        root.unmount();
      });
    }
  });

  it('leaves Escape to a menu that has focus, which closes with its tips', () => {
    const onMenuEscape = jest.fn();
    document.addEventListener('keydown', onMenuEscape);
    const { container, root } = render(
      <div role="menu">
        <button type="button" role="menuitem">
          Focused row
        </button>
        <Tooltip label="Row tip">
          <button type="button">trigger</button>
        </Tooltip>
      </div>,
    );

    try {
      const row = container.querySelector<HTMLElement>('[role="menuitem"]');
      act(() => row?.focus());
      act(() => {
        container
          .querySelectorAll('button')[1]
          ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(findPortalTooltip()).not.toBeNull();

      expect(pressEscape(row ?? document.body).defaultPrevented).toBe(false);
      expect(onMenuEscape).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', onMenuEscape);
      act(() => {
        root.unmount();
      });
    }
  });

  it('leaves Escape alone during IME composition', () => {
    const { container, root } = render(
      <Tooltip label="Hover tip">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      act(() => {
        findTrigger(container).dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(
        pressEscape(document.body, { isComposing: true }).defaultPrevented,
      ).toBe(false);
      expect(
        pressEscape(document.body, { keyCode: 229 }).defaultPrevented,
      ).toBe(false);
      expect(findPortalTooltip()).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('does not reappear after being disabled and re-enabled', () => {
    const { container, root } = render(
      <Tooltip label="Environments">
        <button type="button">trigger</button>
      </Tooltip>,
    );

    try {
      act(() => {
        findTrigger(container).dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(findPortalTooltip()).not.toBeNull();

      act(() => {
        root.render(
          <Tooltip label="Environments" disabled>
            <button type="button">trigger</button>
          </Tooltip>,
        );
      });
      expect(findPortalTooltip()).toBeNull();

      act(() => {
        root.render(
          <Tooltip label="Environments">
            <button type="button">trigger</button>
          </Tooltip>,
        );
      });
      // Nothing hovered the new wrapper, so no tip and no stale position.
      expect(findPortalTooltip()).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
