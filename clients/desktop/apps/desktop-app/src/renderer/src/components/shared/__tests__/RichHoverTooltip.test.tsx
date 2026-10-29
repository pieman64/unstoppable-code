/**
 * @jest-environment jsdom
 *
 * Static-render tests for {@link RichHoverTooltip} plus a jsdom interaction
 * test that exercises the open-on-hover behavior. The hover test fires a
 * `mouseover` event (bubbles: true) on the trigger span — React synthesizes
 * `onMouseEnter` from `mouseover`, matching the pattern used throughout this
 * repo's existing jsdom tests (see WatcherManagementButton.test.tsx and
 * pipeline-advisor-ui.test.tsx).
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { resetInputModality } from '@canopy/ui-shared/lib';
import { RichHoverTooltip } from '../RichHoverTooltip';

describe('RichHoverTooltip', () => {
  it('renders the trigger children inside the wrapper span', () => {
    const html = renderToStaticMarkup(
      <RichHoverTooltip content={<div>tip body</div>}>
        <button type="button">Trigger</button>
      </RichHoverTooltip>,
    );
    expect(html).toContain('Trigger');
    expect(html).toContain('relative inline-flex');
  });

  it('renders children bare when disabled (no aria-describedby wiring)', () => {
    const html = renderToStaticMarkup(
      <RichHoverTooltip content={<div>tip body</div>} disabled>
        <button type="button">Trigger</button>
      </RichHoverTooltip>,
    );
    expect(html).toContain('Trigger');
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('relative inline-flex');
  });

  describe('focus interaction', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      resetInputModality(document);
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() => {
        root.render(
          <RichHoverTooltip content={<span>release/next</span>}>
            <button type="button">main</button>
          </RichHoverTooltip>,
        );
      });
    });

    afterEach(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
      document
        .querySelectorAll('[role="tooltip"]')
        .forEach((node) => node.remove());
    });

    const findTrigger = (): HTMLButtonElement => {
      const trigger = container.querySelector('button');
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error('Trigger button not found');
      }
      return trigger;
    };

    it('does not open on programmatic focus with no preceding input', () => {
      // Regression: `handleBaseBranchClose` in the PR status bar refocuses
      // the base-branch trigger after a pick. That `.focus()` must not pop
      // the "release/next" tooltip open until blur.
      const trigger = findTrigger();
      act(() => {
        trigger.focus();
      });
      expect(document.activeElement).toBe(trigger);
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      expect(trigger.getAttribute('aria-describedby')).toBeNull();
    });

    it('opens when focus arrives by keyboard', () => {
      const trigger = findTrigger();
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
        );
        trigger.focus();
      });
      expect(
        document.body.querySelector('[role="tooltip"]')?.textContent,
      ).toContain('release/next');
    });

    it('does not open when focus follows a pointer press', () => {
      const trigger = findTrigger();
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
        );
        trigger.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        trigger.focus();
      });
      expect(document.activeElement).toBe(trigger);
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    });
  });

  describe('hover interaction', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
      // Remove any portaled tooltip nodes that may linger after unmount.
      document
        .querySelectorAll('[role="tooltip"]')
        .forEach((node) => node.remove());
    });

    it('portals the tooltip to document.body on mouseenter and removes it on mouseleave', () => {
      act(() => {
        root.render(
          <RichHoverTooltip content={<span>hover tip text</span>}>
            <button type="button">Trigger</button>
          </RichHoverTooltip>,
        );
      });

      const wrapper = container.querySelector('span.relative');
      if (!(wrapper instanceof HTMLElement)) {
        throw new Error('Trigger wrapper not found');
      }
      const trigger = wrapper.querySelector('button');
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error('Trigger button not found');
      }

      // Before hover: tooltip must not be present.
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

      // Hover over the trigger: React synthesizes onMouseEnter from mouseover.
      act(() => {
        trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });

      const tooltip = document.body.querySelector('[role="tooltip"]');
      if (!(tooltip instanceof HTMLElement)) {
        throw new Error('Tooltip not found in document.body after mouseenter');
      }
      expect(tooltip.textContent).toContain('hover tip text');
      expect(tooltip.className).toContain('shadow-tooltip');
      expect(tooltip.className).toContain('rounded-md');
      expect(tooltip.className).toContain('font-normal');
      expect(tooltip.className).toContain('text-2xs');
      expect(tooltip.className).toContain('px-2');
      expect(tooltip.className).toContain('py-1.5');
      expect(tooltip.className).toContain('bg-quaternary');
      expect(tooltip.className).not.toContain('rounded-lg');
      expect(tooltip.className).not.toContain('border');
      expect(tooltip.className).not.toContain('bg-inverse');

      // The focused trigger must wire aria-describedby to the tooltip id.
      const tooltipId = tooltip.getAttribute('id');
      expect(typeof tooltipId).toBe('string');
      expect(tooltipId).not.toBe('');
      expect(trigger.getAttribute('aria-describedby')).toBe(tooltipId);
      expect(wrapper.getAttribute('aria-describedby')).toBeNull();

      // Mouse leaves the trigger: React synthesizes onMouseLeave from mouseout.
      act(() => {
        trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });

      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    });

    it('closes when its trigger stops rendering without a mouseleave (CAN-3480)', () => {
      // Clicking a chat skill tile navigates to Plugins, which only hides the
      // always-mounted main page. The pointer never "leaves" the hidden
      // trigger, and its zeroed rect used to pin the card over the sidebar.
      const observerCallbacks: Array<() => void> = [];
      const originalResizeObserver = globalThis.ResizeObserver;
      const originalRequestAnimationFrame = window.requestAnimationFrame;
      class FakeResizeObserver {
        constructor(callback: () => void) {
          observerCallbacks.push(callback);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: FakeResizeObserver,
      });
      window.requestAnimationFrame = (
        callback: FrameRequestCallback,
      ): number => {
        callback(0);
        return 1;
      };
      try {
        act(() => {
          root.render(
            <RichHoverTooltip content={<span>linear-workflow</span>}>
              <button type="button">Skill tile</button>
            </RichHoverTooltip>,
          );
        });
        const wrapper = container.querySelector('span.relative');
        const trigger = wrapper?.querySelector('button');
        if (!(wrapper instanceof HTMLElement) || !trigger) {
          throw new Error('Trigger not found');
        }

        act(() => {
          trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        });
        expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull();
        expect(observerCallbacks.length).toBeGreaterThan(0);

        // The page hosting the trigger becomes `display: none`.
        Object.defineProperty(wrapper, 'checkVisibility', {
          configurable: true,
          value: (): boolean => false,
        });
        act(() => {
          observerCallbacks.forEach((callback) => callback());
        });

        expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      } finally {
        Object.defineProperty(globalThis, 'ResizeObserver', {
          configurable: true,
          writable: true,
          value: originalResizeObserver,
        });
        window.requestAnimationFrame = originalRequestAnimationFrame;
      }
    });

    it('applies the inverse tone surface for high-contrast rich tips', () => {
      act(() => {
        root.render(
          <RichHoverTooltip
            tone="inverse"
            content={
              <div>
                <p>Base branch</p>
                <p>Branch, worktree, or pull request</p>
              </div>
            }
          >
            <button type="button">Trigger</button>
          </RichHoverTooltip>,
        );
      });

      const trigger = container.querySelector('button');
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error('Trigger button not found');
      }

      act(() => {
        trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });

      const tooltip = document.body.querySelector('[role="tooltip"]');
      if (!(tooltip instanceof HTMLElement)) {
        throw new Error('Tooltip not found after mouseenter');
      }
      expect(tooltip.className).toContain('bg-tooltip-inverse');
      expect(tooltip.className).toContain('fg-tooltip-inverse');
      expect(tooltip.className).not.toContain('bg-quaternary');
      expect(tooltip.textContent).toContain('Base branch');
    });

    it("portals into the trigger's own document when mounted in an auxiliary window", () => {
      // A popped-out activity card renders in another window. The tooltip
      // must land in THAT document's body, not the module-global one, or it
      // paints in the wrong window at unrelated coordinates.
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      const auxDocument = iframe.contentDocument;
      const auxWindow = auxDocument?.defaultView;
      if (!auxDocument || !auxWindow) {
        throw new Error('Auxiliary document unavailable');
      }
      const auxContainer = auxDocument.createElement('div');
      auxDocument.body.appendChild(auxContainer);
      const auxRoot = createRoot(auxContainer);
      try {
        act(() => {
          auxRoot.render(
            <RichHoverTooltip content={<span>aux tip text</span>}>
              <button type="button">Aux trigger</button>
            </RichHoverTooltip>,
          );
        });
        const trigger = auxContainer.querySelector('button');
        if (!(trigger instanceof auxWindow.HTMLButtonElement)) {
          throw new Error('Auxiliary trigger button not found');
        }

        act(() => {
          trigger.dispatchEvent(
            new auxWindow.MouseEvent('mouseover', {
              bubbles: true,
            }),
          );
        });

        const auxTooltip = auxDocument.body.querySelector('[role="tooltip"]');
        expect(auxTooltip?.textContent).toContain('aux tip text');
        expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      } finally {
        act(() => {
          auxRoot.unmount();
        });
        iframe.remove();
      }
    });

    it('opens on pointer movement when the trigger appeared under a resting cursor', () => {
      // Mirrors the shared Tooltip regression: the node under the pointer
      // unmounts and this trigger mounts in its place. Chromium sends no
      // `mouseout` for the removed node and delivers the new `mouseover` with
      // the nearest still-connected ancestor (a React-rendered node with a
      // fiber) as `relatedTarget`, so React never fires `onMouseEnter`.
      // Moving the pointer within the trigger only produces `mousemove`,
      // which must still open the tooltip.
      act(() => {
        root.render(
          <div data-testid="host">
            <button type="button" data-testid="old">
              old
            </button>
          </div>,
        );
      });
      const oldButton = container.querySelector('[data-testid="old"]');
      const host = container.querySelector('[data-testid="host"]');
      if (
        !(oldButton instanceof HTMLElement) ||
        !(host instanceof HTMLElement)
      ) {
        throw new Error('fixture not found');
      }
      act(() => {
        oldButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });

      act(() => {
        root.render(
          <div data-testid="host">
            <RichHoverTooltip content={<span>swapped tip text</span>}>
              <button type="button">Trigger</button>
            </RichHoverTooltip>
          </div>,
        );
      });
      expect(oldButton.isConnected).toBe(false);
      const trigger = container.querySelector('button');
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error('Trigger button not found');
      }

      act(() => {
        trigger.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true, relatedTarget: host }),
        );
      });
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

      act(() => {
        trigger.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      });
      expect(
        document.body.querySelector('[role="tooltip"]')?.textContent,
      ).toContain('swapped tip text');
    });

    it('opens on hover over the wrapper even when the trigger is disabled', () => {
      // Regression guard: in-progress git buttons are `disabled`, and disabled
      // controls emit no pointer events. The open/close handlers must live on
      // the wrapper span (not the trigger) so hovering still opens the tooltip.
      act(() => {
        root.render(
          <RichHoverTooltip content={<span>disabled tip text</span>}>
            <button type="button" disabled>
              Pushing...
            </button>
          </RichHoverTooltip>,
        );
      });

      const wrapper = container.querySelector('span.relative');
      if (!(wrapper instanceof HTMLElement)) {
        throw new Error('Trigger wrapper not found');
      }

      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

      // Hover targets the wrapper span itself (the disabled button never would).
      // With handlers cloned onto the trigger instead, this would not open.
      act(() => {
        wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });

      const tooltip = document.body.querySelector('[role="tooltip"]');
      if (!(tooltip instanceof HTMLElement)) {
        throw new Error('Tooltip did not open for a disabled trigger');
      }
      expect(tooltip.textContent).toContain('disabled tip text');
    });

    it('keeps an interactive tooltip open while the pointer moves into its surface', () => {
      jest.useFakeTimers();
      try {
        act(() => {
          root.render(
            <RichHoverTooltip
              content={<div className="overflow-y-auto">scrollable detail</div>}
              interactive
            >
              <button type="button">Trigger</button>
            </RichHoverTooltip>,
          );
        });

        const wrapper = container.querySelector('span.relative');
        if (!(wrapper instanceof HTMLElement)) {
          throw new Error('Trigger wrapper not found');
        }
        act(() => {
          wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        });
        const tooltip = document.body.querySelector('[role="tooltip"]');
        if (!(tooltip instanceof HTMLElement)) {
          throw new Error('Interactive tooltip not found');
        }
        expect(tooltip.className).toContain('pointer-events-auto');

        act(() => {
          wrapper.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
          tooltip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          jest.advanceTimersByTime(200);
        });
        expect(document.body.querySelector('[role="tooltip"]')).toBe(tooltip);

        act(() => {
          tooltip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
          jest.advanceTimersByTime(200);
        });
        expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('moves focus into Enter-opened content only once the surface is positioned', () => {
      // Chromium refuses to focus an element inside a `visibility: hidden`
      // subtree, and the surface stays hidden until its position is applied.
      // Since keyboard focus no longer pre-opens the tooltip, Enter opens and
      // focuses in one go, so the focus call must land after positioning
      // (watcher-sticky-chat-ux.spec.mjs walks this flow in Electron).
      act(() => {
        root.render(
          <RichHoverTooltip
            content={
              <div data-rich-tooltip-autofocus tabIndex={0}>
                keyboard detail
              </div>
            }
            interactive
          >
            <button type="button">Trigger</button>
          </RichHoverTooltip>,
        );
      });
      const trigger = container.querySelector('button');
      if (!(trigger instanceof HTMLButtonElement))
        throw new Error('trigger missing');

      const visibilityAtFocus: string[] = [];
      const focusSpy = jest
        .spyOn(HTMLElement.prototype, 'focus')
        .mockImplementation(function (this: HTMLElement) {
          const surface = this.closest<HTMLElement>('[role="tooltip"]');
          if (surface) visibilityAtFocus.push(surface.style.visibility);
        });
      try {
        act(() => {
          trigger.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
          );
        });
      } finally {
        focusSpy.mockRestore();
      }
      expect(visibilityAtFocus).toEqual(['']);
    });

    it('does not reactivate the trigger for keys pressed inside interactive content', () => {
      act(() => {
        root.render(
          <RichHoverTooltip
            content={
              <div data-rich-tooltip-autofocus tabIndex={0}>
                keyboard detail
              </div>
            }
            interactive
          >
            <button type="button">Trigger</button>
          </RichHoverTooltip>,
        );
      });

      const wrapper = container.querySelector('span.relative');
      const trigger = container.querySelector('button');
      if (!(wrapper instanceof HTMLElement)) throw new Error('wrapper missing');
      if (!(trigger instanceof HTMLButtonElement))
        throw new Error('trigger missing');
      act(() => {
        trigger.focus();
        trigger.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });

      const detail = document.querySelector('[data-rich-tooltip-autofocus]');
      if (!(detail instanceof HTMLElement)) throw new Error('detail missing');
      expect(document.activeElement).toBe(detail);

      const space = new KeyboardEvent('keydown', {
        key: ' ',
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        detail.dispatchEvent(space);
      });
      expect(space.defaultPrevented).toBe(false);

      act(() => {
        detail.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(trigger);
    });
  });

  describe('preferRightPlacement', () => {
    let container: HTMLDivElement;
    let root: Root;
    const TOOLTIP_WIDTH = 200;
    const TOOLTIP_HEIGHT = 40;
    let widthSpy: jest.SpyInstance;
    let heightSpy: jest.SpyInstance;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      // The portaled tooltip surface is the only element whose offset dims are
      // read; stub the prototype so jsdom (which reports 0) yields real sizes.
      widthSpy = jest
        .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
        .mockReturnValue(TOOLTIP_WIDTH);
      heightSpy = jest
        .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
        .mockReturnValue(TOOLTIP_HEIGHT);
    });

    afterEach(() => {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
      act(() => {
        root.unmount();
      });
      container.remove();
      document
        .querySelectorAll('[role="tooltip"]')
        .forEach((node) => node.remove());
    });

    const openTooltipWithTriggerRect = (
      rect: Partial<DOMRect>,
    ): HTMLElement => {
      act(() => {
        root.render(
          <RichHoverTooltip
            content={<span>tip text</span>}
            preferRightPlacement
          >
            <button type="button">Trigger</button>
          </RichHoverTooltip>,
        );
      });

      const wrapper = container.querySelector('span.relative');
      if (!(wrapper instanceof HTMLElement)) {
        throw new Error('Trigger wrapper not found');
      }
      const fullRect: DOMRect = {
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
        ...rect,
      };
      jest.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue(fullRect);

      act(() => {
        wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });

      const tooltip = document.body.querySelector('[role="tooltip"]');
      if (!(tooltip instanceof HTMLElement)) {
        throw new Error('Tooltip not found after mouseenter');
      }
      return tooltip;
    };

    it('anchors to the right of the trigger when it fits in the viewport', () => {
      // innerWidth defaults to 1024 in jsdom; a trigger near the left has ample
      // room to the right (right + gap + width well under the viewport).
      const tooltip = openTooltipWithTriggerRect({
        top: 100,
        left: 50,
        right: 80,
        bottom: 120,
        width: 30,
        height: 20,
      });

      // left edge sits at trigger.right (80) + TOOLTIP_GAP (6).
      expect(tooltip.style.left).toBe('86px');
      // vertically centered on the trigger: top + height/2 - tooltipHeight/2.
      expect(tooltip.style.top).toBe('90px');
    });

    it('falls back to centered above/below placement when the right side is cut off', () => {
      // Trigger pinned to the far right edge: right placement would overflow the
      // viewport, so the default centered-above behavior is used instead.
      const tooltip = openTooltipWithTriggerRect({
        top: 300,
        left: window.innerWidth - 30,
        right: window.innerWidth,
        bottom: 320,
        width: 30,
        height: 20,
      });

      // Centered horizontally on the trigger, clamped to the viewport, so the
      // left edge is NOT the right-placement value (right + gap).
      expect(tooltip.style.left).not.toBe(`${window.innerWidth + 6}px`);
      // Positioned above the trigger (top - gap - tooltipHeight = 300 - 6 - 40).
      expect(tooltip.style.top).toBe('254px');
    });
  });
});
