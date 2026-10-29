/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { getWindow } from '../../panels/window-registry';
import type { LayoutTier } from '../../lib/layout-tier';
import { LayoutTierProvider } from '../LayoutTierProvider';
import { UserBubble } from '../UserBubble';

jest.mock('../../panels/window-registry', () => ({
  getWindow: jest.fn(() => window),
}));

const mockGetWindow = getWindow as jest.MockedFunction<typeof getWindow>;

/**
 * The collapse/expand behavior lives in the desktop
 * `CollapsibleUserMessageContent` (and is covered by its own suite), not in
 * this shared shell. What the shell owns is the surface and the corner badge
 * chrome, which both the desktop transcript and the web portal render.
 */
/**
 * The bubble's separation from the transcript in dark mode. `shadow-sm` is a
 * black shadow, invisible on a near-black `bg-base`, so the edge is carried by
 * a hairline drawn *inside* the surface on a line token: an outer `ring`
 * would composite over the base and land within a few levels of the bubble
 * itself. The surface also steps up one ramp to `bg-quaternary` (identical to
 * `bg-tertiary` in light, one step brighter in dark).
 */
const BUBBLE_HAIRLINE =
  'inset-ring-[length:var(--border-hairline)] inset-ring-line-secondary';

describe('UserBubble', () => {
  it('renders the raised bubble surface with an inset hairline', () => {
    const html = renderToStaticMarkup(
      <UserBubble copyText="hello">
        <p>hello</p>
      </UserBubble>,
    );

    expect(html).toContain('rounded-xl bg-quaternary');
    expect(html).toContain(`shadow-sm ${BUBBLE_HAIRLINE}`);
    expect(html).not.toContain('bg-tertiary');
  });

  it('gives every surface variant the same top and bottom inset', () => {
    // The inset lives on the shared surface constants so the sent, info, and
    // queued bubbles cannot drift apart (the queued bubble once used `p-3`
    // against the sent bubble's `py-1.5`).
    const sent = renderToStaticMarkup(
      <UserBubble copyText="hello">
        <p>hello</p>
      </UserBubble>,
    );
    const info = renderToStaticMarkup(
      <UserBubble copyText="hello" variant="info">
        <p>hello</p>
      </UserBubble>,
    );
    for (const html of [sent, info]) {
      expect(html).toContain('px-3 py-1.5');
      expect(html).not.toMatch(/\bp-3\b/);
    }
  });

  it('draws the muted variant on a flat muted fill, with no shadow or hairline', () => {
    const html = renderToStaticMarkup(
      <UserBubble copyText="hello" variant="muted">
        <p>hello</p>
      </UserBubble>,
    );

    // The bubble's own class (its hover actions keep their badge chrome).
    const bubble =
      /class="([^"]*)" data-testid="portal-chat-message-content"/.exec(
        html,
      )?.[1] ?? '';
    expect(bubble).toBe('rounded-xl bg-muted px-3 py-1.5 text-s fg-primary');
  });

  it('keeps the info variant on its own tint with the same hairline', () => {
    const html = renderToStaticMarkup(
      <UserBubble copyText="hello" variant="info">
        <p>hello</p>
      </UserBubble>,
    );

    expect(html).toContain('rounded-xl bg-info-subtle');
    expect(html).toContain(`shadow-sm ${BUBBLE_HAIRLINE}`);
  });

  // The bubble carries no timestamp of its own. Placing a turn in time is the
  // completion stamp's job, and it belongs to the answer; duplicating it on
  // the prompt put two clocks on one turn. Hovering the prompt reveals that
  // stamp instead, via the turn-level hover scope the transcript owns.
  it('carries no timestamp of its own', () => {
    const html = renderToStaticMarkup(
      <UserBubble copyText="hello">
        <p>hello</p>
      </UserBubble>,
    );

    expect(html).not.toContain('user-bubble-timestamp');
  });

  it('renders the copy and revert actions with the same badge chrome as the leading indicator', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <UserBubble
        copyText="hello"
        onRevert={(): void => {}}
        leading={<span data-testid="demo-leading" />}
      >
        <p>hello</p>
      </UserBubble>,
    );

    // Size differs by role (compact indicator vs. pointer-sized actions);
    // the surface, shape, and elevation must not. The badges overlap a bubble
    // on the same quaternary surface, so they carry the house hairline ring to
    // stay legible against it in dark mode.
    const badgeChrome =
      'flex items-center justify-center rounded-full bg-quaternary fg-secondary shadow-sm ring-[length:var(--border-hairline)] ring-line-secondary';
    const leading = container.querySelector(
      '[data-testid="demo-leading"]',
    )?.parentElement;
    const revert = container.querySelector(
      '[data-testid="reset-to-point-button"]',
    );
    const copy = container.querySelector(
      'button[aria-label="Copy to clipboard"]',
    );

    for (const element of [leading, revert, copy]) {
      expect(element).not.toBeNull();
      expect(element?.getAttribute('class')).toContain(badgeChrome);
    }
  });

  /**
   * The bubble's geometry is the only thing in this file that is tier
   * dependent, and it is driven here through {@link LayoutTierProvider} rather
   * than a `matchMedia` mock. `useLayoutTier` reads the seed as its *server*
   * snapshot, so a `renderToStaticMarkup` pass under a provider is an exact,
   * synchronous way to ask "what class string does a phone get?" without
   * standing up a DOM root and a fake MediaQueryList for a pure styling
   * assertion. `useLayoutTier`'s own suite covers the live subscription.
   */
  describe('phone-tier bubble geometry', () => {
    function renderAt(
      tier: LayoutTier | undefined,
      extra?: {
        leading?: ReactNode;
        footer?: ReactNode;
        onRevert?: boolean;
        actionsOnCorner?: boolean;
      },
    ): string {
      const bubble = (
        <UserBubble
          copyText="hello"
          onRevert={extra?.onRevert === false ? undefined : (): void => {}}
          leading={extra?.leading}
          footer={extra?.footer}
          actionsOnCorner={extra?.actionsOnCorner}
        >
          <p>hello</p>
        </UserBubble>
      );
      const tree: ReactNode =
        tier === undefined ? (
          bubble
        ) : (
          <LayoutTierProvider tier={tier}>{bubble}</LayoutTierProvider>
        );
      return renderToStaticMarkup(tree);
    }

    function classOf(html: string, selector: string): string {
      const container = document.createElement('div');
      container.innerHTML = html;
      const element = container.querySelector(selector);
      if (!element) throw new Error(`expected to find ${selector}`);
      return element.getAttribute('class') ?? '';
    }

    const SURFACE = '[data-testid="portal-chat-message-content"]';
    // The outer positioning wrapper. It owns the phone geometry, because it is
    // also the box the leading badge anchors to and the footer lays out in.
    const WRAPPER = '[data-role="user"]';
    // The badge cluster is the only element carrying this run of utilities;
    // both of its children are Tooltip wrapper spans, so walking up from the
    // buttons would land on those instead.
    const CLUSTER = 'div[class*="z-10 flex items-center gap-1"]';

    /**
     * The 5.4 defect. At 390px a full-width tinted pill directly above the
     * composer reads as a second composer. Shrink-wrapping it and pushing it
     * flush right is the only authorship cue a one-column transcript has room
     * for.
     */
    it('shrink-wraps and right-aligns the message on the phone tier', () => {
      const wrapper = classOf(renderAt('phone'), WRAPPER);

      expect(wrapper).toContain('w-fit');
      expect(wrapper).toContain('ml-auto');
      // Capped so a long message wraps instead of running edge to edge, which
      // would put it back at full width and undo the cue.
      expect(wrapper).toContain('max-w-17/20');
    });

    it.each<[LayoutTier | undefined]>([['tablet'], ['desktop'], [undefined]])(
      'leaves the message full width at %s',
      (tier) => {
        const wrapper = classOf(renderAt(tier), WRAPPER);

        expect(wrapper).not.toContain('w-fit');
        expect(wrapper).not.toContain('ml-auto');
        expect(wrapper).not.toContain('max-w-');
      },
    );

    /**
     * THE GEOMETRY MUST MOVE THE WHOLE MESSAGE, NOT JUST THE BUBBLE.
     *
     * The wrapper is the positioning context for the `leading` badge
     * (`absolute -left-2`) and the box `footer` lays out in. Shrinking only the
     * inner surface right-aligned the bubble while leaving both behind at full
     * column width: the leading badge stranded itself at the far left of the
     * transcript, and the footer's attachment chips stayed left-aligned under a
     * right-aligned message.
     *
     * Both props are live. The desktop renderer passes `leading` for
     * voice-dictated messages, and the App Advisor popout goes down to 360px;
     * `footer` carries the attachment chip row on `/chat`.
     */
    it('right-aligns the leading badge and footer with the bubble on phone', () => {
      const html = renderAt('phone', {
        leading: <span data-testid="leading-badge">mic</span>,
        footer: <div data-testid="bubble-footer">attachment</div>,
      });

      // All three live inside the one shrink-wrapped, right-aligned wrapper,
      // so none of them can strand itself at the column's left edge.
      const wrapper = classOf(html, WRAPPER);
      expect(wrapper).toContain('ml-auto');
      expect(wrapper).toContain('w-fit');

      // The inner surface must NOT also carry the geometry. WHICH BOX carries
      // it is the entire regression: `leading` and `footer` were always
      // children of the wrapper, so asserting containment here would pass
      // against the broken code too and prove nothing.
      const surface = classOf(html, SURFACE);
      expect(surface).not.toContain('ml-auto');
      expect(surface).not.toContain('w-fit');
      expect(surface).not.toContain('max-w-17/20');
    });

    /**
     * The geometric claim itself — that the badge and the footer end up
     * right-aligned WITH the bubble rather than stranded at the column's left
     * edge — is a layout outcome, and jsdom has no layout engine. What can be
     * pinned is the structural precondition it follows from: exactly ONE box
     * carries the shrink-wrap, and that box is an ancestor of all three
     * decorations. Given that, standard CSS gives the alignment.
     */
    it('puts the shrink-wrap on a single box containing all three decorations', () => {
      const html = renderAt('phone', {
        leading: <span data-testid="leading-badge">mic</span>,
        footer: <div data-testid="bubble-footer">attachment</div>,
      });
      const container = document.createElement('div');
      container.innerHTML = html;

      const shrinkWrapped = Array.from(
        container.querySelectorAll('[class*="w-fit"]'),
      );
      expect(shrinkWrapped).toHaveLength(1);

      const box = shrinkWrapped[0];
      if (!box) throw new Error('expected one shrink-wrapped box');
      expect(box.getAttribute('data-role')).toBe('user');
      for (const testId of [
        'leading-badge',
        'bubble-footer',
        'portal-chat-message-content',
      ]) {
        expect(box.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
      }
    });

    /**
     * The in-bubble cluster overlaps the first line of a short message without
     * reserved space — and `pointer-coarse:opacity-100` keeps those badges
     * permanently visible on touch, so it is not a hover-only annoyance.
     *
     * Each badge is `h-7 w-7` (28px) with `gap-1` (4px), and the cluster is
     * inset `right-1` (4px): one badge needs 32px of clearance, two need 64px,
     * plus 4px of breathing room.
     */
    it('reserves clearance for the in-bubble cluster on phone', () => {
      expect(classOf(renderAt('phone'), SURFACE)).toContain('pr-17');
      expect(
        classOf(renderAt('phone', { onRevert: false }), SURFACE),
      ).toContain('pr-9');
    });

    it.each<[LayoutTier | undefined]>([['tablet'], ['desktop'], [undefined]])(
      'reserves no clearance at %s, where the cluster overhangs outside',
      (tier) => {
        expect(classOf(renderAt(tier), SURFACE)).not.toContain('pr-[');
      },
    );

    /**
     * Tablet and desktop must come out byte-identical to the pre-change class
     * string, not merely "close enough" — this is the guard against a phone
     * treatment leaking upward through a shared utility.
     */
    it('emits the unchanged desktop surface class string', () => {
      expect(classOf(renderAt('desktop'), SURFACE)).toBe(
        'rounded-xl bg-quaternary px-3 py-1.5 shadow-sm inset-ring-[length:var(--border-hairline)] inset-ring-line-secondary text-s fg-primary',
      );
    });

    /**
     * The 5.4 residual. `-right-2 -top-2` only works while the bubble spans
     * the column and has the transcript's padding to spill into; once the
     * phone bubble is flush right the same overhang clips at the transcript
     * edge.
     */
    it('moves the action cluster inside the bubble on the phone tier', () => {
      const cluster = classOf(renderAt('phone'), CLUSTER);

      expect(cluster).toContain('right-1');
      expect(cluster).toContain('top-1');
      expect(cluster).not.toContain('-right-2');
      expect(cluster).not.toContain('-top-2');
    });

    it('keeps the actions on the corner at the phone tier when the host asks', () => {
      const html = renderAt('phone', { actionsOnCorner: true });
      expect(classOf(html, CLUSTER)).toContain('-right-2 -top-2');
      // No room reserved for them in the bubble.
      expect(classOf(html, SURFACE)).not.toMatch(/\bpr-/);
    });

    it('keeps the corner overhang at tablet and desktop', () => {
      for (const tier of ['tablet', 'desktop', undefined] as const) {
        expect(classOf(renderAt(tier), CLUSTER)).toContain('-right-2 -top-2');
      }
    });

    /**
     * The 5.5 defect, and the reason it is NOT tier gated: a touch device has
     * no hover, so `opacity-0` + `group-hover:opacity-100` left Copy and
     * Revert unreachable on a phone, a tablet, and a touchscreen laptop alike.
     * The escape is keyed on pointer type, so it must be present at every
     * tier. `ChatTab` carries the identical idiom on its close button.
     */
    it.each<[LayoutTier | undefined]>([
      ['phone'],
      ['tablet'],
      ['desktop'],
      [undefined],
    ])('gives the action cluster a coarse-pointer escape at %s', (tier) => {
      const cluster = classOf(renderAt(tier), CLUSTER);

      expect(cluster).toContain('opacity-0');
      expect(cluster).toContain('group-hover:opacity-100');
      expect(cluster).toContain('pointer-coarse:opacity-100');
    });
  });

  describe('navigate-on-click', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      mockGetWindow.mockReturnValue(window);
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
    });

    function mountNavigable(
      onNavigate: ((element: HTMLElement) => void) | undefined,
      variant: 'default' | 'info' | 'muted' = 'default',
    ): HTMLElement {
      act(() => {
        root.render(
          <UserBubble
            copyText="hello"
            onNavigate={onNavigate}
            variant={variant}
          >
            <p>hello body</p>
            <button type="button" data-testid="inner-toggle">
              Show more
            </button>
            <a href="/somewhere" data-testid="inner-link">
              a link
            </a>
            <input data-testid="inner-input" />
            <span role="button" data-testid="inner-role-button">
              role button
            </span>
          </UserBubble>,
        );
      });
      const surface = container.querySelector<HTMLElement>(
        '[data-testid="portal-chat-message-content"]',
      );
      if (!surface) throw new Error('expected the bubble surface');
      return surface;
    }

    function click(el: Element | null): void {
      if (!el) throw new Error('expected element to click');
      act(() => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }

    it('shows a pointer only when navigable', () => {
      const inert = mountNavigable(undefined);
      expect(inert.getAttribute('class')).not.toContain('cursor-pointer');
    });

    // The pointer cursor is the whole navigation affordance: hovering a
    // navigable bubble must leave its resting surface untouched.
    it.each([
      ['default', 'bg-quaternary'],
      ['info', 'bg-info-subtle'],
      ['muted', 'bg-muted'],
    ] as const)(
      'keeps the %s surface unchanged on hover when navigable',
      (variant, restingClass) => {
        const surface = mountNavigable(() => {}, variant);
        const classes = (surface.getAttribute('class') ?? '').split(/\s+/);
        expect(classes).toContain('cursor-pointer');
        expect(classes).toContain(restingClass);
        expect(surface.getAttribute('class')).not.toContain(
          'background-image:linear-gradient',
        );
      },
    );

    it('invokes onNavigate with the bubble surface on body clicks', () => {
      const onNavigate = jest.fn();
      const surface = mountNavigable(onNavigate);

      click(surface.querySelector('p'));

      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(onNavigate).toHaveBeenCalledWith(surface);
    });

    it('ignores clicks on interactive descendants like Show more or links', () => {
      const onNavigate = jest.fn();
      const surface = mountNavigable(onNavigate);

      click(surface.querySelector('[data-testid="inner-toggle"]'));
      click(surface.querySelector('[data-testid="inner-link"]'));
      click(surface.querySelector('[data-testid="inner-input"]'));
      click(surface.querySelector('[data-testid="inner-role-button"]'));

      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("reads selection state from the bubble's owning window", () => {
      const onNavigate = jest.fn();
      const surface = mountNavigable(onNavigate);
      const owningWindow = {
        Element: window.Element,
        getSelection: jest.fn(() => ({ isCollapsed: false }) as Selection),
      } as unknown as ReturnType<typeof getWindow>;
      mockGetWindow.mockReturnValue(owningWindow);

      click(surface.querySelector('p'));

      expect(mockGetWindow).toHaveBeenCalledWith(surface);
      expect(owningWindow.getSelection).toHaveBeenCalled();
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('ignores clicks that finish a text selection', () => {
      const onNavigate = jest.fn();
      const surface = mountNavigable(onNavigate);
      const originalGetSelection = window.getSelection;
      const fakeSelection: Pick<Selection, 'isCollapsed'> = {
        isCollapsed: false,
      };
      Object.defineProperty(window, 'getSelection', {
        configurable: true,
        value: (): Pick<Selection, 'isCollapsed'> => fakeSelection,
      });
      try {
        click(surface.querySelector('p'));
      } finally {
        Object.defineProperty(window, 'getSelection', {
          configurable: true,
          value: originalGetSelection,
        });
      }

      expect(onNavigate).not.toHaveBeenCalled();
    });
  });

  describe('message context menu target', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });

    function mount(withMenu: boolean): {
      wrapper: HTMLElement;
      onContextMenu: jest.Mock;
      onKeyDown: jest.Mock;
    } {
      const onContextMenu = jest.fn();
      const onKeyDown = jest.fn();
      act(() => {
        root.render(
          <UserBubble
            copyText="hello"
            dataTestId="bubble"
            onRevert={jest.fn()}
            {...(withMenu ? { contextMenu: { onContextMenu, onKeyDown } } : {})}
          >
            <p>hello</p>
          </UserBubble>,
        );
      });
      const wrapper = container.querySelector('[data-testid="bubble"]');
      if (!(wrapper instanceof HTMLElement)) throw new Error('missing bubble');
      return { wrapper, onContextMenu, onKeyDown };
    }

    function contextMenuOn(target: Element | null): void {
      if (!target) throw new Error('missing target');
      act(() => {
        target.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
      });
    }

    it('adds no focus target or handler without a menu', () => {
      const { wrapper } = mount(false);
      expect(wrapper.hasAttribute('tabindex')).toBe(false);
      expect(wrapper.className).not.toContain('focus-ring');
    });

    it('forwards body events to the menu and makes the wrapper focusable', () => {
      const { wrapper, onContextMenu, onKeyDown } = mount(true);
      expect(wrapper.getAttribute('tabindex')).toBe('-1');
      contextMenuOn(wrapper.querySelector('p'));
      expect(onContextMenu).toHaveBeenCalledTimes(1);
      act(() => {
        wrapper.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
        );
      });
      expect(onKeyDown).toHaveBeenCalledTimes(1);
    });

    it('preserves badge pointer menus and reuses their tab stops for keyboard menus', () => {
      const { wrapper, onContextMenu, onKeyDown } = mount(true);
      const copy = wrapper.querySelector('[aria-label="Copy to clipboard"]');
      const revert = wrapper.querySelector(
        '[data-testid="reset-to-point-button"]',
      );
      contextMenuOn(copy);
      contextMenuOn(revert);
      act(() => {
        copy?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
        );
      });
      expect(onContextMenu).not.toHaveBeenCalled();
      expect(onKeyDown).toHaveBeenCalledTimes(1);
    });
  });
});
