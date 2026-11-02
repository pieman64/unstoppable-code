/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SIDEBAR_SCROLLBAR_HIDE_DELAY_MS,
  SidebarScrollArea,
} from '../sidebar/SidebarScrollArea';

const GLOBALS_SOURCE = readFileSync(
  join(process.cwd(), 'apps/desktop-app/src/renderer/src/styles/globals.css'),
  'utf8',
);

const TOKENS_SOURCE = readFileSync(
  join(process.cwd(), 'packages/ui-shared/src/styles/canopy-tokens-core.css'),
  'utf8',
);

describe('SidebarScrollArea', () => {
  it('keeps the viewport full-width and its idle scrollbar hidden', () => {
    const html = renderToStaticMarkup(
      <SidebarScrollArea viewportTestId="viewport">
        <div>Content</div>
      </SidebarScrollArea>,
    );

    expect(html).toContain('data-sidebar-scroll-area=""');
    expect(html).toContain('data-sidebar-scroll-content=""');
    expect(html).toContain('scrollbar-hide h-full overflow-y-auto');
    expect(html).toContain('absolute inset-y-0 right-0');
    expect(html).toContain('absolute inset-y-0 right-0 z-50');
    expect(html).toContain('bg-fg-quaternary');
    // Rail/thumb SIZES deliberately are not utility classes: they switch with
    // the OS scroller style, so they live in the shared token stylesheet and
    // are asserted there (see the scrollbar-geometry test below).
    expect(html).not.toMatch(/\bw-2\.5\b/);
    expect(html).not.toMatch(/\bw-1\.5\b/);
    expect(html).not.toMatch(/\bright-0\.5\b/);
    expect(html).toContain('data-sidebar-scrollbar-thumb=""');
    expect(html).not.toContain('cursor-grab');
    expect(html).not.toContain('cursor-grabbing');
    expect(html).toMatch(/opacity-0" data-sidebar-scrollbar=""/);
    expect(html).not.toMatch(/\b-mr-/);
    expect(html).not.toMatch(/\bpr-/);
    expect(html).not.toContain('scrollbar-gutter');
  });

  // The same rules also carry `[data-overlay-scrollbar]`, so every surface
  // built on the shared OverlayScrollArea inherits the sidebar's exact
  // scrollbar motion rather than re-deriving it.
  it('overrides the sidebar instant-interaction rule for scrollbar motion', () => {
    expect(GLOBALS_SOURCE).toContain(
      '[data-sidebar-scrollbar],\n[data-overlay-scrollbar] {\n  transition: opacity 200ms ease-out !important;',
    );
    // The thumb grows by `scale` from its right edge, never by `width`, so
    // the motion runs on the compositor.
    expect(GLOBALS_SOURCE).toContain(
      'transform-origin: right center;\n  transition:\n    scale 250ms ease-out,\n    background-color 250ms ease-out !important;',
    );
    expect(TOKENS_SOURCE).toContain(
      '[data-overlay-scrollbar-thumb] {\n  transform-origin: right center;\n  transition:\n    scale 250ms ease-out,\n    background-color 250ms ease-out;',
    );
    expect(GLOBALS_SOURCE).toContain(
      '[data-sidebar-scrollbar]:hover [data-sidebar-scrollbar-thumb]',
    );
    // Hover widens the thumb from its 6px resting width to 8px (scaled, with
    // the corner narrowed across so it lands on a true 4px round end) and
    // darkens the fill two token steps, fg-quaternary → fg-secondary.
    expect(GLOBALS_SOURCE).toContain(
      '[data-sidebar-scrollbar]:hover [data-sidebar-scrollbar-thumb],\n[data-overlay-scrollbar]:hover [data-overlay-scrollbar-thumb] {\n  scale: calc(8 / 6) 1;\n  border-radius: 3px / 4px;\n  background-color: var(--fg-secondary);',
    );
  });

  it('sizes both scrollbar families from one mode-switched geometry block', () => {
    // Overlay mode: slim thumb that grows on hover, since the bar is hidden
    // until you interact with it.
    expect(TOKENS_SOURCE).toMatch(
      /:root \{[\s\S]*?--canopy-scrollbar-thumb-inset: 2px;[\s\S]*?--canopy-scrollbar-thumb-size: 6px;[\s\S]*?--canopy-scrollbar-rail-size: 10px;/,
    );
    expect(GLOBALS_SOURCE).toContain(
      '[data-overlay-scrollbar]:hover [data-overlay-scrollbar-thumb] {\n  scale: calc(8 / 6) 1;',
    );
    expect(TOKENS_SOURCE).toContain(
      '[data-overlay-scrollbar]:hover [data-overlay-scrollbar-thumb] {\n  scale: calc(8 / 6) 1;',
    );

    // Always mode: match the platform's own track width rather than a magic
    // number, and keep a >=2px inset.
    expect(TOKENS_SOURCE).toMatch(
      /:root\[data-scrollbars='always'\] \{[\s\S]*?--canopy-scrollbar-thumb-inset: 3px;[\s\S]*?--canopy-native-scrollbar-width, 15px\)[\s\S]*?\}/,
    );
    // ...and no hover growth there: native always-visible scrollbars keep a
    // fixed width.
    expect(GLOBALS_SOURCE).toMatch(
      /:root\[data-scrollbars='always'\][\s\S]*?\[data-overlay-scrollbar-thumb\] \{\n {2}scale: none;/,
    );

    // Both scrollbar families read the same variables.
    expect(TOKENS_SOURCE).toMatch(
      /\[data-overlay-scrollbar\],\s*\[data-sidebar-scrollbar\] \{\s*width: var\(--canopy-scrollbar-rail-size\);/,
    );
    expect(TOKENS_SOURCE).toMatch(
      /::-webkit-scrollbar \{\s*width: var\(--canopy-scrollbar-rail-size\);/,
    );
    // EVERY custom-scrollbar rule must carry the probe exclusion: any
    // `::-webkit-scrollbar*` rule matching the probe opts it into a custom
    // space-taking scrollbar and misdetects overlay machines as always-show.
    // Only UNIVERSAL rules can reach the probe; class/attribute-scoped
    // scrollbar rules (e.g. `.canopy-picker-menu-tabs::-webkit-scrollbar`)
    // cannot match it and stay unguarded.
    const unguardedScrollbarRules = TOKENS_SOURCE.match(
      /^(\*)?::-webkit-scrollbar[a-z-]*(:hover)? \{/gm,
    );
    expect(unguardedScrollbarRules).toBeNull();
    // Longhands only: the `background` shorthand resets `background-clip`,
    // so a separate later colour rule would silently cancel the inset.
    expect(TOKENS_SOURCE).toMatch(
      /::-webkit-scrollbar-thumb \{[\s\S]*?border: var\(--canopy-scrollbar-thumb-inset\) solid transparent;[\s\S]*?background-color: var\(--fg-quaternary\);[\s\S]*?background-clip: padding-box;/,
    );
    const thumbShorthandUses = TOKENS_SOURCE.match(
      /::-webkit-scrollbar-thumb[^{]*\{[^}]*[^-]background:/g,
    );
    expect(thumbShorthandUses).toBeNull();
  });

  describe('auto-hide visibility', () => {
    interface Mounted {
      readonly container: HTMLDivElement;
      readonly root: Root;
      readonly viewport: HTMLElement;
      readonly scrollbar: HTMLElement;
      readonly thumb: HTMLElement;
      readonly cleanup: () => void;
    }

    function mountScrollable(): Mounted {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root: Root = createRoot(container);
      act(() => {
        root.render(
          <SidebarScrollArea viewportTestId="viewport">
            <div>Scrollable content</div>
          </SidebarScrollArea>,
        );
      });

      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="viewport"]',
      );
      const scrollbar = container.querySelector<HTMLElement>(
        '[data-sidebar-scrollbar]',
      );
      const thumb = container.querySelector<HTMLElement>(
        '[data-sidebar-scrollbar-thumb]',
      );
      if (!viewport || !scrollbar || !thumb) {
        throw new Error('Expected scroll area to render');
      }

      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 300, writable: true },
        scrollTop: { configurable: true, value: 40, writable: true },
      });

      return {
        container,
        root,
        viewport,
        scrollbar,
        thumb,
        cleanup: (): void => {
          act(() => {
            root.unmount();
          });
          container.remove();
        },
      };
    }

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
      document.documentElement.removeAttribute('data-scrollbar-behavior');
    });

    /**
     * macOS "Show scroll bars: Always" (and the mouse-attached case of
     * "Automatically") has no media query or Electron API, so the shared
     * detector probes behaviour: an `overflow: scroll` element reserves
     * layout width for a classic scrollbar and none for an overlay one. Here
     * that probe is simulated by giving the detector's throwaway element a
     * non-zero gutter.
     */
    function withAlwaysVisibleScrollbars(run: () => void): void {
      const offset = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'offsetWidth',
      );
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get(this: HTMLElement): number {
          return this.hasAttribute('data-native-scrollbar-probe') ? 115 : 0;
        },
      });
      try {
        run();
      } finally {
        Object.defineProperty(
          HTMLElement.prototype,
          'offsetWidth',
          offset ?? { configurable: true, value: 0 },
        );
      }
    }

    it('keeps the scrollbar visible with no interaction when the OS always shows scrollbars', () => {
      withAlwaysVisibleScrollbars(() => {
        const view = mountScrollable();
        try {
          act(() => {
            view.viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
          // No wheel input, and well past the idle hide delay: the overlay
          // convention would have this hidden, but the OS setting wins.
          act(() => {
            jest.advanceTimersByTime(SIDEBAR_SCROLLBAR_HIDE_DELAY_MS * 3);
          });
          expect(view.scrollbar.className).toContain('opacity-100');
          expect(view.thumb.className).toContain('pointer-events-auto');
        } finally {
          view.cleanup();
        }
      });
    });

    it('bypasses native detection and keeps an explicit Always scrollbar visible', () => {
      document.documentElement.dataset.scrollbarBehavior = 'always';
      const offset = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'offsetWidth',
      );
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get(this: HTMLElement): number {
          if (this.hasAttribute('data-native-scrollbar-probe')) {
            throw new Error('Explicit scrollbar behavior must not probe');
          }
          return 0;
        },
      });

      try {
        const view = mountScrollable();
        try {
          act(() => {
            view.viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
          });
          expect(view.scrollbar.className).toContain('opacity-100');
        } finally {
          view.cleanup();
        }
      } finally {
        Object.defineProperty(
          HTMLElement.prototype,
          'offsetWidth',
          offset ?? { configurable: true, value: 0 },
        );
      }
    });

    it('keeps an explicit Never scrollbar hidden even when the native style is classic', () => {
      document.documentElement.dataset.scrollbarBehavior = 'never';
      withAlwaysVisibleScrollbars(() => {
        const view = mountScrollable();
        try {
          act(() => {
            view.viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
            view.viewport.dispatchEvent(new Event('wheel', { bubbles: true }));
          });
          expect(view.scrollbar.className).toContain('opacity-0');
        } finally {
          view.cleanup();
        }
      });
    });

    it('reveals an explicit On hover scrollbar when the scroll area is hovered', () => {
      document.documentElement.dataset.scrollbarBehavior = 'hover';
      const view = mountScrollable();
      try {
        act(() => {
          view.viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
          view.container
            .querySelector('[data-sidebar-scroll-area]')
            ?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
        });
        expect(view.scrollbar.className).toContain('opacity-100');

        act(() => {
          view.container
            .querySelector('[data-sidebar-scroll-area]')
            ?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
        });
        expect(view.scrollbar.className).toContain('opacity-0');
      } finally {
        view.cleanup();
      }
    });

    it('reveals on wheel input but not on programmatic scrolls, then fades', () => {
      const mounted = mountScrollable();
      try {
        const { viewport, scrollbar, thumb } = mounted;
        // A bare scroll event (startup restoration, scrollIntoView) updates
        // geometry but must NOT reveal the scrollbar.
        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        expect(scrollbar.classList.contains('opacity-0')).toBe(true);

        // User wheel input reveals it.
        act(() => {
          viewport.dispatchEvent(new Event('wheel', { bubbles: true }));
        });

        expect(scrollbar.classList.contains('opacity-100')).toBe(true);
        expect(scrollbar.classList.contains('pointer-events-auto')).toBe(true);
        expect(thumb.classList.contains('pointer-events-auto')).toBe(true);

        act(() => {
          jest.advanceTimersByTime(SIDEBAR_SCROLLBAR_HIDE_DELAY_MS - 1);
        });
        expect(scrollbar.classList.contains('opacity-100')).toBe(true);

        act(() => {
          jest.advanceTimersByTime(1);
        });
        expect(scrollbar.classList.contains('opacity-0')).toBe(true);
        // While faded out the rail is fully inert: proximity to the sidebar
        // edge must not interact with (or reveal) the hidden scrollbar.
        expect(scrollbar.classList.contains('pointer-events-none')).toBe(true);
        expect(thumb.classList.contains('pointer-events-none')).toBe(true);

        act(() => {
          viewport.dispatchEvent(new Event('wheel', { bubbles: true }));
        });
        expect(scrollbar.classList.contains('opacity-100')).toBe(true);
      } finally {
        mounted.cleanup();
      }
    });

    it('hides immediately when overflow goes away', () => {
      const mounted = mountScrollable();
      try {
        const { viewport, scrollbar } = mounted;
        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
          viewport.dispatchEvent(new Event('wheel', { bubbles: true }));
        });
        expect(scrollbar.classList.contains('opacity-100')).toBe(true);

        Object.defineProperty(viewport, 'scrollHeight', {
          configurable: true,
          value: 100,
        });
        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        });

        expect(scrollbar.classList.contains('opacity-0')).toBe(true);
        expect(scrollbar.classList.contains('pointer-events-none')).toBe(true);
      } finally {
        mounted.cleanup();
      }
    });

    it('does not resurrect the reveal when overflow returns within the hide delay', () => {
      const mounted = mountScrollable();
      try {
        const { viewport, scrollbar } = mounted;
        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
          viewport.dispatchEvent(new Event('wheel', { bubbles: true }));
        });
        expect(scrollbar.classList.contains('opacity-100')).toBe(true);

        // Overflow disappears (e.g. collapsing a workspace): the reveal and
        // its pending hide timer must be cleared, not merely masked.
        Object.defineProperty(viewport, 'scrollHeight', {
          configurable: true,
          value: 100,
        });
        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        expect(scrollbar.classList.contains('opacity-0')).toBe(true);

        // Overflow returns within the original hide delay without any new
        // wheel input (e.g. re-expanding the workspace): still hidden.
        Object.defineProperty(viewport, 'scrollHeight', {
          configurable: true,
          value: 300,
        });
        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        expect(scrollbar.classList.contains('opacity-0')).toBe(true);

        act(() => {
          jest.advanceTimersByTime(SIDEBAR_SCROLLBAR_HIDE_DELAY_MS * 2);
        });
        expect(scrollbar.classList.contains('opacity-0')).toBe(true);
      } finally {
        mounted.cleanup();
      }
    });

    it('stays revealed while the pointer is over the rail and hides after it leaves', () => {
      const mounted = mountScrollable();
      try {
        const { viewport, scrollbar } = mounted;
        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
          viewport.dispatchEvent(new Event('wheel', { bubbles: true }));
          scrollbar.dispatchEvent(new Event('pointerenter'));
        });

        act(() => {
          jest.advanceTimersByTime(SIDEBAR_SCROLLBAR_HIDE_DELAY_MS * 5);
        });
        expect(scrollbar.classList.contains('opacity-100')).toBe(true);

        act(() => {
          scrollbar.dispatchEvent(new Event('pointerleave'));
        });
        act(() => {
          jest.advanceTimersByTime(SIDEBAR_SCROLLBAR_HIDE_DELAY_MS);
        });
        expect(scrollbar.classList.contains('opacity-0')).toBe(true);
      } finally {
        mounted.cleanup();
      }
    });

    it('does not reveal on rail hover while hidden', () => {
      const mounted = mountScrollable();
      try {
        const { viewport, scrollbar } = mounted;
        // Establish overflow state via a wheel reveal, then let it fade.
        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
          viewport.dispatchEvent(new Event('wheel', { bubbles: true }));
        });
        act(() => {
          jest.advanceTimersByTime(SIDEBAR_SCROLLBAR_HIDE_DELAY_MS);
        });
        expect(scrollbar.classList.contains('opacity-0')).toBe(true);

        // Cursor proximity to the sidebar edge must not reveal the hidden
        // scrollbar — only scroll activity does.
        act(() => {
          scrollbar.dispatchEvent(new Event('pointerenter'));
        });
        expect(scrollbar.classList.contains('opacity-0')).toBe(true);
      } finally {
        mounted.cleanup();
      }
    });

    it('stays revealed while dragging the thumb and hides after release', () => {
      const mounted = mountScrollable();
      try {
        const { viewport, scrollbar, thumb } = mounted;
        Object.assign(thumb, {
          setPointerCapture: (): void => {},
          releasePointerCapture: (): void => {},
          hasPointerCapture: (): boolean => false,
        });

        act(() => {
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
          viewport.dispatchEvent(new Event('wheel', { bubbles: true }));
        });
        act(() => {
          thumb.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        });

        act(() => {
          jest.advanceTimersByTime(SIDEBAR_SCROLLBAR_HIDE_DELAY_MS * 5);
        });
        expect(scrollbar.classList.contains('opacity-100')).toBe(true);

        act(() => {
          thumb.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        });
        act(() => {
          jest.advanceTimersByTime(SIDEBAR_SCROLLBAR_HIDE_DELAY_MS);
        });
        expect(scrollbar.classList.contains('opacity-0')).toBe(true);
      } finally {
        mounted.cleanup();
      }
    });

    it('stays hidden when overflow appears without scrolling', async () => {
      const mounted = mountScrollable();
      try {
        const { viewport, scrollbar } = mounted;
        expect(scrollbar.classList.contains('opacity-0')).toBe(true);

        // Content growth (e.g. expanding a workspace) makes the viewport
        // overflow: the mutation observer schedules a layout pass that
        // discovers overflow. That alone must NOT reveal the scrollbar —
        // only actual scrolling does.
        await act(async () => {
          viewport.appendChild(document.createElement('div'));
          await Promise.resolve();
        });
        act(() => {
          jest.advanceTimersByTime(16);
        });

        expect(scrollbar.classList.contains('opacity-0')).toBe(true);
        act(() => {
          jest.advanceTimersByTime(SIDEBAR_SCROLLBAR_HIDE_DELAY_MS * 2);
        });
        expect(scrollbar.classList.contains('opacity-0')).toBe(true);

        // Wheel scrolling still reveals it once overflow exists.
        act(() => {
          viewport.dispatchEvent(new Event('wheel', { bubbles: true }));
        });
        expect(scrollbar.classList.contains('opacity-100')).toBe(true);
      } finally {
        mounted.cleanup();
      }
    });
  });

  it('keeps mutation-only scrollbar refreshes out of host geometry work', () => {
    let mutationObserverCallback: MutationCallback | null = null;
    let resizeObserverCallback: ResizeObserverCallback | null = null;
    class MutationObserverStub implements MutationObserver {
      constructor(callback: MutationCallback) {
        mutationObserverCallback = callback;
      }

      observe(): void {
        // noop
      }

      disconnect(): void {
        // noop
      }

      takeRecords(): MutationRecord[] {
        return [];
      }
    }

    class ResizeObserverStub implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }

      observe(): void {
        // noop
      }

      unobserve(): void {
        // noop
      }

      disconnect(): void {
        // noop
      }
    }

    const originalMutationObserver = window.MutationObserver;
    const originalResizeObserver = window.ResizeObserver;
    Object.defineProperty(window, 'MutationObserver', {
      configurable: true,
      value: MutationObserverStub,
    });
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverStub,
    });
    let nextFrameId = 1;
    const frameCallbacks = new Map<number, (timestamp: number) => void>();
    let scheduledFrame: ((timestamp: number) => void) | null = null;
    const getScheduledFrame = (): ((timestamp: number) => void) | null =>
      scheduledFrame;
    const requestAnimationFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: (timestamp: number) => void) => {
        const frameId = nextFrameId++;
        frameCallbacks.set(frameId, callback);
        scheduledFrame = callback;
        return frameId;
      });
    const cancelAnimationFrame = jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((frameId) => {
        frameCallbacks.delete(frameId);
      });
    const onViewportLayout = jest.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      act(() => {
        root.render(
          <SidebarScrollArea
            viewportTestId="viewport"
            onViewportLayout={onViewportLayout}
          >
            <div>Content</div>
          </SidebarScrollArea>,
        );
      });

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(onViewportLayout).not.toHaveBeenCalled();
      if (!mutationObserverCallback || !resizeObserverCallback) {
        throw new Error('Expected observer registration');
      }
      const registeredMutationObserver = new MutationObserverStub(
        mutationObserverCallback,
      );
      const registeredResizeObserver = new ResizeObserverStub(
        resizeObserverCallback,
      );

      const initialFrame = getScheduledFrame();
      if (!initialFrame) throw new Error('Expected an initial layout frame');
      act(() => {
        frameCallbacks.clear();
        initialFrame(performance.now());
      });
      expect(onViewportLayout).not.toHaveBeenCalled();
      expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
      const initialHostFrame = getScheduledFrame();
      if (!initialHostFrame || initialHostFrame === initialFrame) {
        throw new Error('Expected host layout in a follow-up frame');
      }
      act(() => {
        frameCallbacks.clear();
        initialHostFrame(performance.now());
      });
      expect(onViewportLayout).toHaveBeenCalledTimes(1);
      onViewportLayout.mockClear();

      act(() => {
        mutationObserverCallback?.([], registeredMutationObserver);
        mutationObserverCallback?.([], registeredMutationObserver);
        mutationObserverCallback?.([], registeredMutationObserver);
      });

      expect(requestAnimationFrame).toHaveBeenCalledTimes(3);
      expect(onViewportLayout).not.toHaveBeenCalled();
      const mutationFrame = getScheduledFrame();
      if (!mutationFrame) {
        throw new Error('Expected a scheduled mutation frame');
      }

      act(() => {
        frameCallbacks.clear();
        mutationFrame(performance.now());
      });

      expect(onViewportLayout).not.toHaveBeenCalled();

      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="viewport"]',
      );
      if (!viewport) throw new Error('Expected the scroll viewport');
      const emptyNodes = document.createElement('div').childNodes;
      const selectionMutation: MutationRecord = {
        type: 'attributes',
        target: viewport,
        addedNodes: emptyNodes,
        removedNodes: emptyNodes,
        previousSibling: null,
        nextSibling: null,
        attributeName: 'data-sidebar-selected-item',
        attributeNamespace: null,
        oldValue: null,
      };
      act(() => {
        mutationObserverCallback?.(
          [selectionMutation],
          registeredMutationObserver,
        );
      });
      const selectionMutationFrame = getScheduledFrame();
      if (!selectionMutationFrame) {
        throw new Error('Expected a scheduled selection-mutation frame');
      }
      act(() => {
        frameCallbacks.clear();
        selectionMutationFrame(performance.now());
      });
      expect(onViewportLayout).not.toHaveBeenCalled();
      const selectionHostFrame = getScheduledFrame();
      if (
        !selectionHostFrame ||
        selectionHostFrame === selectionMutationFrame
      ) {
        throw new Error('Expected selection host layout in a follow-up frame');
      }
      act(() => {
        frameCallbacks.clear();
        selectionHostFrame(performance.now());
      });
      expect(onViewportLayout).toHaveBeenCalledTimes(1);
      onViewportLayout.mockClear();

      const groupContent = document.createElement('div');
      groupContent.dataset.sidebarItemGroupId = 'headerless';
      viewport.appendChild(groupContent);
      act(() =>
        mutationObserverCallback?.(
          [
            {
              ...selectionMutation,
              type: 'childList',
              target: groupContent,
              attributeName: null,
            },
          ],
          registeredMutationObserver,
        ),
      );
      const membershipFrame = getScheduledFrame();
      if (!membershipFrame) throw new Error('Expected membership layout frame');
      act(() => {
        membershipFrame(performance.now());
      });
      const membershipHostFrame = getScheduledFrame();
      if (!membershipHostFrame || membershipHostFrame === membershipFrame) {
        throw new Error(
          'Expected headerless membership to invalidate host geometry',
        );
      }
      act(() => {
        membershipHostFrame(performance.now());
      });
      expect(onViewportLayout).toHaveBeenCalledTimes(1);
      onViewportLayout.mockClear();

      act(() => {
        resizeObserverCallback?.([], registeredResizeObserver);
      });
      const resizeFrame = getScheduledFrame();
      if (!resizeFrame) throw new Error('Expected a scheduled resize frame');
      act(() => {
        frameCallbacks.clear();
        resizeFrame(performance.now());
      });

      expect(onViewportLayout).not.toHaveBeenCalled();
      const resizeHostFrame = getScheduledFrame();
      if (!resizeHostFrame || resizeHostFrame === resizeFrame) {
        throw new Error('Expected resized host layout in a follow-up frame');
      }
      act(() => {
        frameCallbacks.clear();
        resizeHostFrame(performance.now());
      });
      expect(onViewportLayout).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
      requestAnimationFrame.mockRestore();
      cancelAnimationFrame.mockRestore();
      Object.defineProperty(window, 'MutationObserver', {
        configurable: true,
        value: originalMutationObserver,
      });
      Object.defineProperty(window, 'ResizeObserver', {
        configurable: true,
        value: originalResizeObserver,
      });
    }
  });
});
