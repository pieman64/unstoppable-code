/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CtaBanner } from '../CtaBanner';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('CtaBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function render(
    overrides: Partial<Parameters<typeof CtaBanner>[0]> = {},
  ): void {
    act(() =>
      root.render(
        <CtaBanner
          data-testid="cta"
          message="Get the thing"
          actionLabel="Show me"
          onDismiss={overrides.onDismiss ?? ((): void => {})}
          popoverAriaLabel="Thing details"
          {...overrides}
        >
          {overrides.children ?? <button data-testid="popover-body">Go</button>}
        </CtaBanner>,
      ),
    );
  }

  function query<T extends HTMLElement>(testId: string): T | null {
    return document.body.querySelector<T>(`[data-testid="${testId}"]`);
  }

  function action(): HTMLButtonElement {
    const element = query<HTMLButtonElement>('cta-action');
    if (!element) throw new Error('Action button missing');
    return element;
  }

  it('renders the pill with derived test ids and no popover until asked', () => {
    render({ icon: <span data-testid="cta-icon">*</span> });

    const pill = query('cta');
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute('role')).toBe('status');
    expect(pill?.getAttribute('aria-live')).toBe('polite');
    expect(pill?.textContent).toContain('Get the thing');
    expect(query('cta-icon')).not.toBeNull();
    expect(query('cta-dismiss')).not.toBeNull();
    expect(action().getAttribute('aria-haspopup')).toBe('dialog');
    expect(action().getAttribute('aria-expanded')).toBe('false');
    expect(query('cta-popover')).toBeNull();
  });

  it('uses the default dismiss label and fires onDismiss', () => {
    const onDismiss = jest.fn();
    render({ onDismiss });

    const dismiss = query<HTMLButtonElement>('cta-dismiss');
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss');

    act(() => dismiss?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('honors a custom dismiss aria-label', () => {
    render({ dismissAriaLabel: 'Not right now' });
    expect(query('cta-dismiss')?.getAttribute('aria-label')).toBe(
      'Not right now',
    );
  });

  it('opens the popover on action, reporting through onPopoverOpenChange', () => {
    const onPopoverOpenChange = jest.fn();
    render({ onPopoverOpenChange });

    act(() => action().click());

    expect(onPopoverOpenChange).toHaveBeenCalledWith(true);
    const popover = query('cta-popover');
    expect(popover).not.toBeNull();
    expect(popover?.getAttribute('role')).toBe('dialog');
    expect(popover?.getAttribute('aria-label')).toBe('Thing details');
    // Portalled out of the banner, not nested inside it.
    expect(container.contains(popover)).toBe(false);
    expect(query('popover-body')).not.toBeNull();
    expect(action().getAttribute('aria-expanded')).toBe('true');
    // `aria-orientation` belongs to the menu-family roles, not to a dialog.
    expect(popover?.hasAttribute('aria-orientation')).toBe(false);
  });

  it('toggles the popover closed when the action is pressed again', () => {
    const onPopoverOpenChange = jest.fn();
    render({ onPopoverOpenChange });

    act(() => action().click());
    act(() => action().click());

    expect(onPopoverOpenChange).toHaveBeenNthCalledWith(2, false);
    expect(query('cta-popover')).toBeNull();
    expect(action().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape and restores focus to the action button', () => {
    render();

    act(() => action().click());
    expect(query('cta-popover')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(query('cta-popover')).toBeNull();
    expect(document.activeElement).toBe(action());
  });

  // Locks in the "no auto-dismiss" decision: this pill sits beside toasts that
  // self-expire after 15s, but it has no notification-history entry, so a
  // timer would be a silent loss — and it would yank an open QR popover out
  // from under a phone camera mid-scan.
  it('never removes itself on a timer', () => {
    jest.useFakeTimers();
    try {
      render();
      act(() => action().click());

      act(() => {
        jest.advanceTimersByTime(60_000);
      });

      expect(query('cta')).not.toBeNull();
      expect(query('cta-popover')).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  // The popover's contents are its whole point. `FloatingMenu`'s `manual`
  // contract deliberately leaves focus on the trigger and closes on ANY Tab,
  // which left the store toggle and both badges reachable by mouse only — a
  // regression from the inline cue this replaced, whose badges were tabbable.
  it('moves focus into the popover and cycles Tab inside it', () => {
    render({
      children: (
        <>
          <button data-testid="popover-body">Go</button>
          <button data-testid="popover-second">More</button>
        </>
      ),
    });

    act(() => action().click());
    expect(document.activeElement).toBe(query('popover-body'));

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });

    // Still open, and focus advanced rather than the popover being torn down.
    expect(query('cta-popover')).not.toBeNull();
    expect(document.activeElement).toBe(query('popover-second'));

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });

    // Wraps back to the first control instead of escaping the dialog.
    expect(query('cta-popover')).not.toBeNull();
    expect(document.activeElement).toBe(query('popover-body'));
  });

  // The trap listens on the document, so without a scope check an open
  // popover would steal Tab from unrelated UI — the command palette opens by
  // keyboard (no outside press, no Escape), so both can be open at once.
  //
  // The contract when focus is elsewhere is the plain `manual` one: the
  // surface dismisses. What must NOT happen is the trap pulling focus back
  // into a popover the user has already navigated away from.
  it('never steals Tab focus when focus is outside the banner', () => {
    const outside = document.createElement('button');
    outside.setAttribute('data-testid', 'outside');
    document.body.appendChild(outside);

    render();
    act(() => action().click());
    expect(query('cta-popover')).not.toBeNull();

    act(() => {
      outside.focus();
      outside.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });

    // Focus stays put — the trap does not reach outside its own surface.
    expect(document.activeElement).toBe(outside);
    // And the surface dismisses, as an unfocused `manual` surface should.
    expect(query('cta-popover')).toBeNull();
  });

  // An async body can be empty on first paint. Tab must not dismiss the
  // surface and drop focus on the floor before the content arrives.
  it('holds focus on an empty popover instead of closing on Tab', () => {
    render({ children: <span>No controls yet</span> });

    act(() => action().click());
    const popover = query('cta-popover');
    expect(popover).not.toBeNull();
    expect(document.activeElement).toBe(popover);

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });

    expect(query('cta-popover')).not.toBeNull();
    expect(document.activeElement).toBe(popover);
  });

  it('still closes on Escape from inside the popover and restores focus', () => {
    render();

    act(() => action().click());
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(query('cta-popover')).toBeNull();
    expect(document.activeElement).toBe(action());
  });

  // The X is a sibling of the trigger, so an open popover used to read the
  // press as an outside dismiss, close, and swallow the click that would have
  // fired `onDismiss` — the user had to click X twice to snooze the banner.
  it('dismisses in a single click while the popover is open', () => {
    const onDismiss = jest.fn();
    render({ onDismiss });

    act(() => action().click());
    expect(query('cta-popover')).not.toBeNull();

    const dismiss = query<HTMLButtonElement>('cta-dismiss');
    act(() => {
      dismiss?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      dismiss?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      dismiss?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // A press genuinely outside the banner must still dismiss the popover.
  it('closes the popover on an outside press', () => {
    render();

    act(() => action().click());
    expect(query('cta-popover')).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
    });

    expect(query('cta-popover')).toBeNull();
  });

  // The pill is a flex child of a fixed-width notification column (24rem in
  // the desktop shell). A flex item with `width: auto` stretches to fill that
  // column, which is how "Get Unstoppable Code on your phone" shipped
  // ellipsised — the copy was clipped to ~190px inside a 384px pill that had
  // nothing left to give it. `w-max` sizes the pill to its own content;
  // `truncate` stays as the last resort for a viewport too narrow to hold it.
  it('sizes to its content instead of stretching to fill its column', () => {
    render();

    const pill = query('cta');
    // NOT `w-fit`: `fit-content` clamps to the containing block, so copy that
    // outgrows the column would still truncate at 24rem.
    expect(pill?.className).toContain('w-max');
    expect(pill?.className).not.toContain('w-fit');
    // The viewport, not the column, is the only real cap on a floating pill.
    expect(pill?.className).toContain('max-w-[calc(100vw-2rem)]');
    // `flex-1` on the message would re-stretch it inside the hugged pill,
    // reinstating the ellipsis this fix removes.
    expect(pill?.querySelector('.truncate')?.className).not.toContain('flex-1');
  });

  // A hugged pill no longer fills the column, so it needs to be told which
  // edge to sit against: flex's `stretch` default falls back to flex-start
  // once the item has a definite width, which would leave the pill floating
  // off the left edge of a right-corner notification stack.
  it('sits against the requested edge of its stack', () => {
    render();
    expect(query('cta')?.className).toContain('self-start');

    render({ align: 'end' });
    expect(query('cta')?.className).toContain('self-end');
  });

  it('omits derived test ids when no data-testid is supplied', () => {
    act(() =>
      root.render(
        <CtaBanner
          message="Anonymous"
          actionLabel="Show me"
          onDismiss={(): void => {}}
          popoverAriaLabel="Details"
        >
          <span>Body</span>
        </CtaBanner>,
      ),
    );

    expect(container.querySelectorAll('[data-testid]')).toHaveLength(0);
  });
});
