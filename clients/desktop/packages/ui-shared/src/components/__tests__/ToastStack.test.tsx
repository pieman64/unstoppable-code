/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  IN_APP_NOTIFICATION_WIDTH_PX,
  type InAppNotificationPlacement,
} from '../../lib/notification-placement';
import {
  TOAST_STACK_LIMIT,
  ToastStack,
  ToastStackActivatableCard,
  ToastStackDescription,
  type ToastStackItem,
  type ToastStackSwipeInput,
} from '../ToastStack';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface TestToast extends ToastStackItem {
  readonly message: string;
}

/** Makes every three-line clamp report text hidden past its last line. */
function mockClampOverflow(): () => void {
  const isClamp = (element: Element): boolean =>
    element.classList.contains('line-clamp-3');
  const scroll = jest
    .spyOn(Element.prototype, 'scrollHeight', 'get')
    .mockImplementation(function (this: Element): number {
      return isClamp(this) ? 80 : 0;
    });
  const client = jest
    .spyOn(Element.prototype, 'clientHeight', 'get')
    .mockImplementation(function (this: Element): number {
      return isClamp(this) ? 54 : 0;
    });
  return (): void => {
    scroll.mockRestore();
    client.mockRestore();
  };
}

function toast(id: string, overrides: Partial<TestToast> = {}): TestToast {
  return {
    id,
    intent: 'neutral',
    timeoutMs: 5_000,
    message: `Message ${id}`,
    ...overrides,
  };
}

describe('ToastStack', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: jest.Mock<void, [string]>;

  beforeEach(() => {
    jest.useFakeTimers();
    onClose = jest.fn<void, [string]>();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    jest.useRealTimers();
  });

  function render(
    toasts: readonly TestToast[],
    placement: InAppNotificationPlacement = 'bottom-right',
  ): void {
    act(() =>
      root.render(
        <ToastStack
          data-testid="stack"
          toasts={toasts}
          placement={placement}
          onClose={onClose}
          renderToast={(item): JSX.Element => (
            <p data-testid="content">
              <ToastStackDescription>{item.message}</ToastStackDescription>
            </p>
          )}
        />,
      ),
    );
  }

  function cards(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="toast-stack-card"]',
      ),
    );
  }

  function texts(): string[] {
    return cards().map((card) => card.textContent ?? '');
  }

  it('renders an empty polite region until a toast arrives', () => {
    render([]);

    const region = container.querySelector('[data-testid="stack"]');
    expect(region?.getAttribute('role')).toBe('region');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(cards()).toHaveLength(0);
  });

  it('shows host toasts newest first and keeps them in step with the host list', () => {
    const first = toast('a');
    const second = toast('b');
    render([first]);
    render([first, second]);

    expect(texts()).toEqual(['Message b', 'Message a']);

    // An updated toast changes in place instead of re-entering.
    render([first, { ...second, message: 'Edited' }]);
    expect(texts()).toEqual(['Edited', 'Message a']);
  });

  it('closes a toast the host dropped without reporting it back', () => {
    const first = toast('a');
    render([first, toast('b')]);

    render([first]);
    // Long enough for the exit to finish, well short of the 5s lifetime.
    act(() => jest.advanceTimersByTime(500));

    expect(texts()).toEqual(['Message a']);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports an expired toast to the host once', () => {
    render([toast('a', { timeoutMs: 1_000 })]);

    act(() => jest.advanceTimersByTime(999));
    expect(onClose).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('a');
  });

  it('keeps a toast with no timeout until the host drops it', () => {
    render([toast('a', { timeoutMs: 0 })]);

    act(() => jest.advanceTimersByTime(10 * 60_000));

    expect(onClose).not.toHaveBeenCalled();
    expect(texts()).toEqual(['Message a']);
  });

  it('enters from and leaves to the side of the screen it sits on', () => {
    render([toast('a')], 'top-right');
    expect(
      container
        .querySelector('[data-testid="stack"]')
        ?.getAttribute('data-side'),
    ).toBe('right');

    render([toast('a')], 'bottom-left');
    expect(
      container
        .querySelector('[data-testid="stack"]')
        ?.getAttribute('data-side'),
    ).toBe('left');
  });

  it('reports a toast the user closed with Escape', () => {
    render([toast('a', { timeoutMs: 0 })]);
    const [card] = cards();
    if (card === undefined) throw new Error('no card');

    // Escape closes the toast that holds keyboard focus.
    card.tabIndex = -1;
    act(() => card.focus());
    act(() => {
      card.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(onClose).toHaveBeenCalledWith('a');
  });

  it(`hides toasts beyond the newest ${String(TOAST_STACK_LIMIT)} until room frees up`, () => {
    const toasts = ['a', 'b', 'c', 'd'].map((id) => toast(id));
    render(toasts);

    const limited = cards().filter((card) => card.hasAttribute('data-limited'));
    expect(limited.map((card) => card.textContent)).toEqual(['Message a']);

    render(toasts.slice(0, 3));
    act(() => jest.advanceTimersByTime(500));
    expect(cards().some((card) => card.hasAttribute('data-limited'))).toBe(
      false,
    );
  });

  it('carries the intent and keeps a failure reachable by assistive technology', () => {
    render([toast('a', { intent: 'destructive' }), toast('b')]);

    const [neutral, destructive] = cards();
    expect(destructive?.dataset.toastIntent).toBe('destructive');
    // Polite like every other toast: an urgent toast is aria-hidden until
    // the stack takes focus, which would hide its actions.
    expect(destructive?.getAttribute('role')).toBe('dialog');
    expect(destructive?.hasAttribute('aria-hidden')).toBe(false);
    expect(neutral?.getAttribute('role')).toBe('dialog');
  });

  it('draws keyboard focus with the shared ring, not the browser outline', () => {
    render([toast('a')]);

    const [card] = cards();
    expect(card?.classList.contains('focus-ring')).toBe(true);
  });

  it('describes each card with its message', () => {
    render([toast('a')]);

    const [card] = cards();
    const describedBy = card?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(
      describedBy === null || describedBy === undefined
        ? null
        : document.getElementById(describedBy)?.textContent,
    ).toBe('Message a');
  });

  it('clamps the message and reports when the clamp hides text', () => {
    const restore = mockClampOverflow();
    const onOverflowChange = jest.fn<void, [boolean]>();
    try {
      act(() =>
        root.render(
          <ToastStack
            toasts={[toast('a')]}
            placement="top-right"
            onClose={onClose}
            renderToast={(item): JSX.Element => (
              <ToastStackDescription onOverflowChange={onOverflowChange}>
                {item.message}
              </ToastStackDescription>
            )}
          />,
        ),
      );
    } finally {
      restore();
    }

    expect(container.querySelector('.line-clamp-3')?.textContent).toBe(
      'Message a',
    );
    expect(onOverflowChange).toHaveBeenLastCalledWith(true);
  });

  it('grows away from the screen edge it is pinned to', () => {
    render([toast('a')], 'top-left');
    expect(
      container
        .querySelector('[data-testid="stack"]')
        ?.getAttribute('data-edge'),
    ).toBe('top');

    render([toast('a')], 'bottom-left');
    expect(
      container
        .querySelector('[data-testid="stack"]')
        ?.getAttribute('data-edge'),
    ).toBe('bottom');
  });

  /** Mouse events standing in for pointer events (jsdom has none). */
  function pointer(type: string, target: Element, clientX: number): void {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY: 100,
      button: 0,
    });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    act(() => {
      target.dispatchEvent(event);
    });
  }

  function onlyContent(): Element {
    const content = container.querySelector('[data-testid="content"]');
    if (content === null) throw new Error('no card content');
    return content;
  }

  it('reports a toast flicked away, however short the flick', () => {
    render([toast('a', { timeoutMs: 0 })]);

    // A quick 30px flick: short of any distance line, but fast.
    pointer('pointerdown', onlyContent(), 100);
    for (const x of [110, 120, 130]) {
      act(() => jest.advanceTimersByTime(16));
      pointer('pointermove', onlyContent(), x);
    }
    pointer('pointerup', onlyContent(), 130);

    act(() => jest.advanceTimersByTime(500));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('a');
  });

  it('moves a dragged card from the first move, then sends it off past the edge', () => {
    render([toast('a', { timeoutMs: 0 })]);
    const [card] = cards();
    if (card === undefined) throw new Error('no card');
    expect(card.getAttribute('data-toast-stack-id')).toBe('a');

    pointer('pointerdown', onlyContent(), 100);
    pointer('pointermove', onlyContent(), 102);
    expect(card.style.getPropertyValue('--toast-swipe-x')).toBe('2px');
    expect(card.hasAttribute('data-swipe-dragging')).toBe(true);
    for (const x of [140, 180, 220]) {
      act(() => jest.advanceTimersByTime(16));
      pointer('pointermove', onlyContent(), x);
    }
    pointer('pointerup', onlyContent(), 220);
    expect(card.hasAttribute('data-swipe-flung')).toBe(true);
    // jsdom draws nothing, so the card is the stack's width: it travels all
    // of that and on past the window edge.
    expect(
      Number.parseFloat(card.style.getPropertyValue('--toast-swipe-x')),
    ).toBeGreaterThan(IN_APP_NOTIFICATION_WIDTH_PX);
  });

  it('keeps a held toast up past its time, and closes it in full time after', () => {
    render([toast('a', { timeoutMs: 1_000 })]);

    // Held, as a finger on a touchscreen holds it (no hover to pause it).
    pointer('pointerdown', onlyContent(), 100);
    act(() => jest.advanceTimersByTime(3_000));
    expect(onClose).not.toHaveBeenCalled();

    pointer('pointerup', onlyContent(), 100);
    act(() => jest.advanceTimersByTime(999));
    expect(onClose).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledWith('a');
  });

  it('keeps a toast up while its own button is held past its time', () => {
    act(() =>
      root.render(
        <ToastStack
          toasts={[toast('a', { timeoutMs: 1_000 })]}
          placement="bottom-right"
          onClose={onClose}
          renderToast={(item): JSX.Element => (
            <p>
              {item.message}
              <button type="button" data-testid="action">
                Undo
              </button>
            </p>
          )}
        />,
      ),
    );
    const action = container.querySelector('[data-testid="action"]');
    if (action === null) throw new Error('no action button');

    pointer('pointerdown', action, 100);
    act(() => jest.advanceTimersByTime(3_000));
    expect(onClose).not.toHaveBeenCalled();

    pointer('pointerup', action, 100);
    act(() => jest.advanceTimersByTime(999));
    expect(onClose).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledWith('a');
  });

  it('springs a slow, short drag back and keeps the toast', () => {
    render([toast('a', { timeoutMs: 0 })]);
    const [card] = cards();
    if (card === undefined) throw new Error('no card');

    pointer('pointerdown', onlyContent(), 100);
    for (const x of [110, 120, 130, 140, 150]) {
      act(() => jest.advanceTimersByTime(16));
      pointer('pointermove', onlyContent(), x);
    }
    act(() => jest.advanceTimersByTime(300));
    pointer('pointerup', onlyContent(), 150);
    expect(card.hasAttribute('data-swipe-settling')).toBe(true);

    act(() => jest.advanceTimersByTime(1000));
    expect(onClose).not.toHaveBeenCalled();
    expect(card.style.getPropertyValue('--toast-swipe-x')).toBe('');
  });

  it('hands a host swipe input the stack controller and cleans it up', () => {
    const detachInput = jest.fn();
    const swipeInput = jest.fn<() => void, Parameters<ToastStackSwipeInput>>(
      () => detachInput,
    );
    act(() =>
      root.render(
        <ToastStack
          toasts={[toast('a')]}
          placement="top-left"
          onClose={onClose}
          swipeInput={swipeInput}
          renderToast={(item): JSX.Element => <p>{item.message}</p>}
        />,
      ),
    );
    expect(swipeInput).toHaveBeenCalledTimes(1);
    expect(swipeInput.mock.calls[0]?.[2]).toBe('left');
    expect(swipeInput.mock.calls[0]?.[1]).toBeInstanceOf(HTMLElement);

    act(() => root.render(<p>gone</p>));
    expect(detachInput).toHaveBeenCalledTimes(1);
  });
});

describe('ToastStackActivatableCard', (): void => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach((): void => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach((): void => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function render(onActivate?: () => void): HTMLElement {
    act(() =>
      root.render(
        <ToastStackActivatableCard
          onActivate={onActivate}
          activateLabel="Read full notification"
          blurFocusBeforeActivate
          toastType="error"
        >
          <p data-testid="message">Message</p>
          <button type="button" data-testid="inner">
            Dismiss
          </button>
        </ToastStackActivatableCard>,
      ),
    );
    const card = container.firstElementChild;
    if (!(card instanceof HTMLElement)) throw new Error('card not rendered');
    return card;
  }

  function activateButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      'button[aria-label="Read full notification"]',
    );
  }

  it('is the outermost toast-card element and carries the toast type', (): void => {
    const card = render(jest.fn());
    expect(card.getAttribute('data-testid')).toBe('toast-card');
    expect(card.getAttribute('data-toast-type')).toBe('error');
  });

  it('activates once when the card is clicked outside its buttons', (): void => {
    const onActivate = jest.fn();
    render(onActivate);

    act(() => {
      container.querySelector<HTMLElement>('[data-testid="message"]')?.click();
    });

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('does not activate when one of its own buttons is clicked', (): void => {
    const onActivate = jest.fn();
    render(onActivate);

    act(() => {
      container.querySelector<HTMLElement>('[data-testid="inner"]')?.click();
    });

    expect(onActivate).not.toHaveBeenCalled();
  });

  it('activates from its screen-reader button by click and keyboard', (): void => {
    const onActivate = jest.fn();
    render(onActivate);
    const button = activateButton();
    expect(button).not.toBeNull();
    expect(button?.classList.contains('sr-only')).toBe(true);

    act(() => button?.click());
    expect(onActivate).toHaveBeenCalledTimes(1);

    // Enter and Space on a native button dispatch a click.
    act(() => {
      button?.focus();
      button?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 0 }),
      );
    });
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(document.activeElement).not.toBe(button);
  });

  it('renders a plain card without onActivate', (): void => {
    const card = render();
    expect(activateButton()).toBeNull();
    expect(card.classList.contains('cursor-pointer')).toBe(false);

    act(() => {
      container.querySelector<HTMLElement>('[data-testid="message"]')?.click();
    });
    expect(card.getAttribute('data-testid')).toBe('toast-card');
  });
});
