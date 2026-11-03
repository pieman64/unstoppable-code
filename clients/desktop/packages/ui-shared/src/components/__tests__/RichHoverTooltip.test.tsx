/** @jest-environment jsdom */

import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetInputModality } from '../../lib/input-modality';
import { ActionTooltip } from '../ActionTooltip';
import { RichHoverTooltip } from '../RichHoverTooltip';
import { useOverlayEscape } from '../useOverlayEscape';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe.each([false, true])(
  'controlled rich tooltip (deferred=%s)',
  (deferred) => {
    let root: Root;
    let container: HTMLDivElement;
    beforeEach(() => {
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      resetInputModality(document);
    });
    afterEach(() => {
      act(() => root.unmount());
      document.body.replaceChildren();
    });
    function render(
      open?: boolean,
      disabled = false,
      suppressed = false,
    ): void {
      act(() =>
        root.render(
          <RichHoverTooltip
            content="Detail"
            open={open}
            disabled={disabled}
            suppressed={suppressed}
            deferUntilInteraction={deferred}
          >
            <button>Trigger</button>
          </RichHoverTooltip>,
        ),
      );
    }
    function hover(): void {
      act(() => {
        container.querySelector('button')?.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
    }
    const surface = (): Element | null =>
      document.querySelector('[role="tooltip"]');
    it('forces true open and false closed, while undefined preserves hover', () => {
      render(true);
      expect(surface()?.textContent).toBe('Detail');
      render(false);
      hover();
      expect(surface()).toBeNull();
      render(undefined);
      hover();
      expect(surface()?.textContent).toBe('Detail');
    });
    it('preserves disabled and suppressed precedence over forced open', () => {
      render(true, true);
      expect(surface()).toBeNull();
      render(true, false, true);
      expect(surface()).toBeNull();
      render(true);
      expect(surface()).not.toBeNull();
    });
    it('lets a controlled caller honor Escape dismissal', () => {
      function Controlled(): JSX.Element {
        const [open, setOpen] = useState(true);
        return (
          <RichHoverTooltip
            content="Detail"
            open={open}
            onOpenChange={setOpen}
            dismissOnEscape
            deferUntilInteraction={deferred}
          >
            <button>Trigger</button>
          </RichHoverTooltip>
        );
      }
      act(() => root.render(<Controlled />));
      expect(surface()).not.toBeNull();
      act(() => {
        container.querySelector('button')?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(surface()).toBeNull();
    });
  },
);

describe('RichHoverTooltip surface padding', () => {
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

  function openTooltip(node: JSX.Element): HTMLElement | null {
    act(() => root.render(node));
    const trigger = container.querySelector('button');
    act(() => {
      trigger?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    return document.body.querySelector<HTMLElement>('[role="tooltip"]');
  }

  function tokens(node: JSX.Element): string[] {
    return (openTooltip(node)?.className ?? '').split(/\s+/);
  }

  it('pads a multi-line surface 8px by 6px by default', () => {
    const classes = tokens(
      <RichHoverTooltip content={<span>Body</span>}>
        <button type="button">Trigger</button>
      </RichHoverTooltip>,
    );

    expect(classes).toEqual(expect.arrayContaining(['px-2', 'py-1.5']));
    expect(classes).toEqual(expect.arrayContaining(['min-w-45', 'max-w-80']));
  });

  it('offers compact, relaxed, and card densities', () => {
    const compact = tokens(
      <RichHoverTooltip content={<span>Body</span>} surfacePadding="compact">
        <button type="button">Trigger</button>
      </RichHoverTooltip>,
    );
    expect(compact).toEqual(expect.arrayContaining(['px-2', 'py-1']));
    expect(compact).not.toContain('py-1.5');

    act(() => root.unmount());
    root = createRoot(container);
    const relaxed = tokens(
      <RichHoverTooltip content={<span>Body</span>} surfacePadding="relaxed">
        <button type="button">Trigger</button>
      </RichHoverTooltip>,
    );
    expect(relaxed).toEqual(expect.arrayContaining(['px-2.5', 'py-1.5']));
    expect(relaxed).not.toContain('px-2');

    act(() => root.unmount());
    root = createRoot(container);
    const card = tokens(
      <RichHoverTooltip content={<span>Body</span>} surfacePadding="card">
        <button type="button">Trigger</button>
      </RichHoverTooltip>,
    );
    expect(card).toEqual(expect.arrayContaining(['px-3', 'py-2']));
    expect(card).not.toContain('px-2');
  });

  it('keeps the padding when a caller sizes the surface', () => {
    const classes = tokens(
      <RichHoverTooltip
        content={<span>Body</span>}
        surfacePadding="card"
        surfaceClassName="min-w-65 max-w-85"
      >
        <button type="button">Trigger</button>
      </RichHoverTooltip>,
    );

    expect(classes).toEqual(
      expect.arrayContaining(['min-w-65', 'max-w-85', 'px-3', 'py-2']),
    );
    expect(classes).not.toContain('min-w-45');
  });
});

describe('RichHoverTooltip right placement', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // A 40px row at y=100 and a 120px tall card, inside a 1024x768 window.
    jest
      .spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(
        DOMRect.fromRect({ x: 0, y: 100, width: 200, height: 40 }),
      );
    jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(120);
    jest
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockReturnValue(200);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    jest.restoreAllMocks();
  });

  function openTop(node: JSX.Element): string | undefined {
    act(() => root.render(node));
    act(() => {
      container.querySelector('button')?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    return document.body.querySelector<HTMLElement>('[role="tooltip"]')?.style
      .top;
  }

  it('centers on the trigger by default', () => {
    expect(
      openTop(
        <RichHoverTooltip content={<span>Body</span>} preferRightPlacement>
          <button type="button">Trigger</button>
        </RichHoverTooltip>,
      ),
    ).toBe('60px');
  });

  it('lines its top up with the trigger when aligned to start', () => {
    expect(
      openTop(
        <RichHoverTooltip
          content={<span>Body</span>}
          preferRightPlacement
          rightPlacementAlign="start"
        >
          <button type="button">Trigger</button>
        </RichHoverTooltip>,
      ),
    ).toBe('100px');
  });
});

describe('RichHoverTooltip below-start placement', () => {
  let container: HTMLDivElement;
  let root: Root;
  let anchor: HTMLDivElement;
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    anchor = document.createElement('div');
    document.body.appendChild(anchor);
    // The trigger (a tab's label) sits inside a larger anchor (the tab); a
    // 280 x 120 card in a 1024 x 768 window.
    jest
      .spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 10, height: 10 }));
    jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(120);
    jest
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockReturnValue(280);
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 768,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    jest.restoreAllMocks();
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalWidth,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalHeight,
    });
  });

  function openAt(
    rect: { x: number; y: number; width: number; height: number },
    extra: { placement?: 'auto' | 'below-start'; gap?: number } = {},
  ): { top: string; left: string } {
    jest
      .spyOn(anchor, 'getBoundingClientRect')
      .mockReturnValue(DOMRect.fromRect(rect));
    act(() =>
      root.render(
        <RichHoverTooltip
          content={<span>Body</span>}
          placement={extra.placement ?? 'below-start'}
          placementGap={extra.gap ?? 8}
          getPlacementAnchor={(): Element => anchor}
        >
          <button type="button">Trigger</button>
        </RichHoverTooltip>,
      ),
    );
    act(() => {
      container.querySelector('button')?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    const style =
      document.body.querySelector<HTMLElement>('[role="tooltip"]')?.style;
    return { top: style?.top ?? '', left: style?.left ?? '' };
  }

  it('hangs below the anchor with left edges lined up', () => {
    expect(openAt({ x: 100, y: 40, width: 160, height: 32 })).toEqual({
      top: '80px',
      left: '100px',
    });
  });

  it('uses a visible anchor when the trigger wrapper has no layout box', () => {
    Object.defineProperty(HTMLSpanElement.prototype, 'checkVisibility', {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(anchor, 'checkVisibility', {
      configurable: true,
      value: () => true,
    });
    try {
      expect(openAt({ x: 100, y: 40, width: 160, height: 32 })).toEqual({
        top: '80px',
        left: '100px',
      });
    } finally {
      Reflect.deleteProperty(HTMLSpanElement.prototype, 'checkVisibility');
    }
  });

  it('lines up with the anchor’s right edge near the right window edge', () => {
    // Left-aligned it would end at 1180px; the anchor ends at 1000px.
    expect(openAt({ x: 900, y: 40, width: 100, height: 32 })).toEqual({
      top: '80px',
      left: '720px',
    });
  });

  it('clamps to the window padding when neither edge fits', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 300,
    });
    expect(openAt({ x: 100, y: 40, width: 60, height: 32 }).left).toBe('8px');
  });

  it('flips above the anchor when there is no room below', () => {
    expect(openAt({ x: 100, y: 700, width: 160, height: 32 }).top).toBe(
      '572px',
    );
  });

  it('keeps the default placement above and centered', () => {
    // Centered over the anchor (x 100..260), 6px above it.
    expect(
      openAt({ x: 100, y: 400, width: 160, height: 32 }, { placement: 'auto' }),
    ).toEqual({ top: '274px', left: '40px' });
  });
});

describe('RichHoverTooltip Escape dismissal', () => {
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

  function render(dismissOnEscape: boolean): HTMLButtonElement {
    act(() =>
      root.render(
        <RichHoverTooltip
          content={<span>Body</span>}
          dismissOnEscape={dismissOnEscape}
        >
          <button type="button">Trigger</button>
        </RichHoverTooltip>,
      ),
    );
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('trigger missing');
    return trigger;
  }

  const hover = (trigger: HTMLElement, type = 'mouseover'): void => {
    act(() => {
      trigger.dispatchEvent(
        new MouseEvent(type, { bubbles: true, relatedTarget: document.body }),
      );
    });
  };

  const pressEscape = (trigger: HTMLElement): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      trigger.dispatchEvent(event);
    });
    return event;
  };

  const tooltip = (): Element | null =>
    document.body.querySelector('[role="tooltip"]');

  it('closes until the pointer leaves, then opens again', () => {
    const trigger = render(true);
    hover(trigger);
    expect(tooltip()).not.toBeNull();
    expect(pressEscape(trigger).defaultPrevented).toBe(true);
    expect(tooltip()).toBeNull();
    hover(trigger, 'mousemove');
    expect(tooltip()).toBeNull();
    hover(trigger, 'mouseout');
    hover(trigger);
    expect(tooltip()).not.toBeNull();
  });

  it('leaves Escape alone for callers that opt out or while closed', () => {
    const trigger = render(false);
    hover(trigger);
    expect(pressEscape(trigger).defaultPrevented).toBe(false);
    expect(tooltip()).not.toBeNull();

    const optedIn = render(true);
    hover(optedIn, 'mouseout');
    expect(pressEscape(optedIn).defaultPrevented).toBe(false);
  });
});

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

describe('rich tooltip Escape over a dialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    resetInputModality(document);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  const tooltip = (): Element | null =>
    document.body.querySelector('[role="tooltip"]');

  function hoverOpen(): void {
    act(() => {
      container.querySelector('button')?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    expect(tooltip()).not.toBeNull();
  }

  function pressEscape(): void {
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  const plain = (deferred: boolean): JSX.Element => (
    <RichHoverTooltip content="Body" deferUntilInteraction={deferred}>
      <button type="button">Trigger</button>
    </RichHoverTooltip>
  );
  const interactive = (deferred: boolean): JSX.Element => (
    <RichHoverTooltip
      content={<button type="button">Action</button>}
      interactive
      deferUntilInteraction={deferred}
    >
      <button type="button">Trigger</button>
    </RichHoverTooltip>
  );

  it.each([
    ['a plain card', (): JSX.Element => plain(false)],
    ['a deferred plain card', (): JSX.Element => plain(true)],
    ['an interactive card', (): JSX.Element => interactive(false)],
    ['a deferred interactive card', (): JSX.Element => interactive(true)],
    [
      'an action tooltip',
      (): JSX.Element => (
        <ActionTooltip title="Run" description="Starts the pipeline">
          <button type="button">Trigger</button>
        </ActionTooltip>
      ),
    ],
  ])(
    'closes %s opened by hover first, then lets Escape reach the dialog',
    (_kind, renderTip) => {
      const onClose = jest.fn();
      act(() =>
        root.render(
          <EscapeOverlay onClose={onClose}>{renderTip()}</EscapeOverlay>,
        ),
      );
      hoverOpen();

      pressEscape();
      expect(tooltip()).toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      pressEscape();
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );
});

describe.each([false, true])(
  'interactive card blur (deferred=%s)',
  (deferUntilInteraction) => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      jest.useFakeTimers();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      resetInputModality(document);
    });

    afterEach(() => {
      act(() => root.unmount());
      document.body.replaceChildren();
      jest.useRealTimers();
    });

    const card = (): Element | null =>
      document.body.querySelector('[role="tooltip"]');

    function openCard(): {
      readonly trigger: HTMLButtonElement;
      readonly first: HTMLButtonElement;
      readonly second: HTMLButtonElement;
      readonly text: HTMLElement;
    } {
      act(() =>
        root.render(
          <RichHoverTooltip
            interactive
            deferUntilInteraction={deferUntilInteraction}
            content={
              <span>
                <span data-testid="card-text">feature-01</span>
                <button type="button">First</button>
                <button type="button">Second</button>
              </span>
            }
          >
            <button type="button">Trigger</button>
          </RichHoverTooltip>,
        ),
      );
      const trigger = container.querySelector('button');
      if (!trigger) throw new Error('trigger missing');
      act(() => {
        trigger.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      const surface = card();
      const [first, second] = Array.from(
        surface?.querySelectorAll('button') ?? [],
      );
      const text = surface?.querySelector<HTMLElement>(
        '[data-testid="card-text"]',
      );
      if (!surface || !first || !second || !text) {
        throw new Error('card not open');
      }
      // The pointer crosses from the trigger onto the card.
      act(() => {
        trigger.dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true, relatedTarget: text }),
        );
        text.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: trigger,
          }),
        );
      });
      return { trigger, first, second, text };
    }

    it('stays open when a press inside the hovered card moves focus off a control', () => {
      const { first } = openCard();
      act(() => first.focus());
      // Pressing the card's text drops focus to nothing.
      act(() => first.blur());
      act(() => jest.advanceTimersByTime(500));
      expect(card()).not.toBeNull();
    });

    it('stays open when a press moves focus to another control in the card', () => {
      const { first, second } = openCard();
      act(() => first.focus());
      act(() => second.focus());
      act(() => jest.advanceTimersByTime(500));
      expect(card()).not.toBeNull();
    });

    it('reopens from the keyboard after Escape closes the card under the pointer', () => {
      act(() =>
        root.render(
          <RichHoverTooltip
            interactive
            dismissOnEscape
            deferUntilInteraction={deferUntilInteraction}
            content={
              <span>
                <span data-testid="card-text">feature-01</span>
                <button type="button">First</button>
              </span>
            }
          >
            <button type="button">Trigger</button>
          </RichHoverTooltip>,
        ),
      );
      const trigger = container.querySelector('button');
      if (!trigger) throw new Error('trigger missing');
      act(() => {
        trigger.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      const text = card()?.querySelector('[data-testid="card-text"]');
      if (!text) throw new Error('card not open');
      act(() => {
        trigger.dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true, relatedTarget: text }),
        );
        text.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: trigger,
          }),
        );
      });
      // Escape removes the card under the pointer, so no mouseleave follows.
      act(() => {
        trigger.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(card()).toBeNull();
      // Focus leaving clears the dismissal; focus returning opens the card.
      act(() => trigger.focus());
      act(() => trigger.blur());
      act(() => jest.advanceTimersByTime(500));
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
        );
        trigger.focus();
      });
      act(() => jest.advanceTimersByTime(500));
      expect(card()).not.toBeNull();
    });

    it('closes once focus and the pointer have both left', () => {
      const { first, text } = openCard();
      act(() => first.focus());
      act(() => {
        text.dispatchEvent(
          new MouseEvent('mouseout', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      act(() => first.blur());
      act(() => jest.advanceTimersByTime(500));
      expect(card()).toBeNull();
    });
  },
);

describe('RichHoverTooltip mount cost', () => {
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

  it('renders a closed trigger once, then portals and positions on first open', () => {
    let renders = 0;
    function Trigger(props: { 'aria-describedby'?: string }): JSX.Element {
      renders += 1;
      return (
        <button type="button" {...props}>
          Trigger
        </button>
      );
    }
    act(() =>
      root.render(
        <RichHoverTooltip content={<span>Body</span>}>
          <Trigger />
        </RichHoverTooltip>,
      ),
    );
    expect(renders).toBe(1);
    act(() => {
      container.querySelector('button')?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    const tooltip =
      document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Body');
    expect(tooltip?.style.visibility).not.toBe('hidden');
  });
});

describe.each([false, true])(
  'RichHoverTooltip interactive surface events (deferred=%s)',
  (deferUntilInteraction) => {
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

    function renderCard(containEvents: boolean): {
      readonly row: Record<string, jest.Mock>;
      readonly text: HTMLElement;
    } {
      const row = {
        onPointerDown: jest.fn(),
        onMouseDown: jest.fn(),
        onClick: jest.fn(),
        onContextMenu: jest.fn(),
        onKeyDown: jest.fn(),
      };
      act(() =>
        root.render(
          // A draggable, clickable row around the trigger: the card is portaled
          // out of it in the DOM but stays inside it in React.
          <div {...row}>
            <RichHoverTooltip
              content={<span data-testid="card-text">feature-01</span>}
              interactive
              deferUntilInteraction={deferUntilInteraction}
              containEvents={containEvents}
            >
              <button type="button">Row</button>
            </RichHoverTooltip>
          </div>,
        ),
      );
      act(() => {
        container.querySelector('button')?.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      const text = document.body.querySelector<HTMLElement>(
        '[data-testid="card-text"]',
      );
      if (!text) throw new Error('card not open');
      return { row, text };
    }

    it("keeps presses, clicks, and Enter or Space in a card from reaching the trigger's row", () => {
      const { row, text } = renderCard(true);

      act(() => {
        text.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        text.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        text.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        text.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        text.dispatchEvent(
          new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
        );
        text.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });

      expect(row.onPointerDown).not.toHaveBeenCalled();
      expect(row.onMouseDown).not.toHaveBeenCalled();
      expect(row.onClick).not.toHaveBeenCalled();
      expect(row.onContextMenu).not.toHaveBeenCalled();
      expect(row.onKeyDown).not.toHaveBeenCalled();
    });

    it('lets card events reach the row unless the caller contains them', () => {
      const { row, text } = renderCard(false);

      act(() => {
        text.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        text.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        text.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });

      expect(row.onPointerDown).toHaveBeenCalledTimes(1);
      expect(row.onClick).toHaveBeenCalledTimes(1);
      expect(row.onKeyDown).toHaveBeenCalledTimes(1);
    });

    it('lets other keys through, so app shortcuts still work in the card', () => {
      const { row, text } = renderCard(true);

      act(() => {
        text.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            metaKey: true,
            bubbles: true,
          }),
        );
      });

      expect(row.onKeyDown).toHaveBeenCalledTimes(1);
    });
  },
);

describe.each([false, true])(
  'RichHoverTooltip interactive first event (deferred=%s)',
  (deferUntilInteraction) => {
    it('opens on Enter synchronously, focuses content and restores the original trigger on Escape', () => {
      resetInputModality(document);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        act(() =>
          root.render(
            <RichHoverTooltip
              deferUntilInteraction={deferUntilInteraction}
              interactive
              content={
                <button type="button" data-rich-tooltip-autofocus>
                  Action
                </button>
              }
            >
              <button type="button" aria-describedby="existing">
                Trigger
              </button>
            </RichHoverTooltip>,
          ),
        );
        const trigger = container.querySelector('button');
        if (!trigger) throw new Error('trigger missing');
        act(() => trigger.focus());
        expect(document.querySelector('[role="tooltip"]')).toBeNull();
        const enter = new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        });
        act(() => {
          trigger.dispatchEvent(enter);
        });
        expect(enter.defaultPrevented).toBe(true);
        const card = document.querySelector('[role="tooltip"]');
        const action = card?.querySelector('button');
        expect(action).not.toBeNull();
        expect(document.activeElement).toBe(action);
        expect(trigger.getAttribute('aria-controls')).toBe(card?.id);
        expect(trigger.getAttribute('aria-describedby')).toBe(
          `existing ${card?.id}`,
        );
        act(() => {
          action?.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        expect(document.querySelector('[role="tooltip"]')).toBeNull();
        expect(container.querySelector('button')).toBe(trigger);
        expect(document.activeElement).toBe(trigger);
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    });
  },
);

describe.each([false, true])('adopted tooltip (deferred=%s)', (deferred) => {
  let frame: HTMLIFrameElement;
  let child: Window;
  let container: HTMLDivElement;
  let root: Root;
  let childSetTimeout: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const view = frame.contentDocument?.defaultView;
    if (!view) throw new Error('child window missing');
    child = view;
    const timers = new Map<number, number>();
    let nextId = 1;
    childSetTimeout = jest
      .spyOn(child, 'setTimeout')
      .mockImplementation((fn, delay) => {
        const id = nextId++;
        timers.set(
          id,
          window.setTimeout(() => {
            if (typeof fn === 'function') Reflect.apply(fn, child, []);
          }, delay),
        );
        return id;
      });
    jest.spyOn(child, 'clearTimeout').mockImplementation((id) => {
      if (id === undefined) return;
      const timer = timers.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.delete(id);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    jest.restoreAllMocks();
    document.body.replaceChildren();
    jest.useRealTimers();
  });
  const render = (): HTMLButtonElement => {
    act(() =>
      root.render(
        <RichHoverTooltip
          deferUntilInteraction={deferred}
          interactive
          openDelay={250}
          content={
            <button type="button" data-rich-tooltip-autofocus>
              Action
            </button>
          }
        >
          <button type="button">Trigger</button>
        </RichHoverTooltip>,
      ),
    );
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('trigger missing');
    return trigger;
  };
  const pointer = (
    target: Element,
    type: string,
    relatedTarget: Element,
  ): void => {
    act(() => {
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, relatedTarget }),
      );
    });
  };
  it('clears interactive close grace in the window that scheduled it after adoption', () => {
    const trigger = render();
    pointer(trigger, 'mouseover', document.body);
    act(() => jest.advanceTimersByTime(250));
    pointer(trigger, 'mouseout', document.body);
    act(() => jest.advanceTimersByTime(120));
    child.document.body.appendChild(container);
    pointer(trigger, 'mouseover', child.document.body);
    act(() => jest.advanceTimersByTime(250));
    const card = child.document.querySelector('[role="tooltip"]');
    if (!card) throw new Error('child card missing');
    pointer(trigger, 'mouseout', child.document.body);
    pointer(card, 'mouseover', child.document.body);
    act(() => jest.advanceTimersByTime(120));
    expect(child.document.querySelector('[role="tooltip"]')).toBe(card);
  });
  it('schedules delayed opens in the current window after merge-back', () => {
    child.document.body.appendChild(container);
    const trigger = render();
    pointer(trigger, 'mouseover', child.document.body);
    act(() => jest.advanceTimersByTime(250));
    pointer(trigger, 'mouseout', child.document.body);
    act(() => jest.advanceTimersByTime(120));
    document.body.appendChild(container);
    // A closed child window cannot deliver a new timeout after merge-back.
    childSetTimeout.mockImplementation(() => 999);
    pointer(trigger, 'mouseover', document.body);
    act(() => jest.advanceTimersByTime(250));
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  });
  it('returns keyboard focus to the opener-created trigger adopted into a child', () => {
    const trigger = render();
    child.document.body.appendChild(container);
    expect(trigger instanceof HTMLElement).toBe(true);
    const childHTMLElement = frame.contentDocument?.defaultView?.HTMLElement;
    if (!childHTMLElement) throw new Error('child constructor missing');
    expect(trigger instanceof childHTMLElement).toBe(false);
    act(() => {
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const action = child.document.querySelector<HTMLButtonElement>(
      '[role="tooltip"] button',
    );
    if (!action) throw new Error('child action missing');
    expect(child.document.activeElement).toBe(action);
    act(() => {
      action.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(child.document.activeElement).toBe(trigger);
    expect(child.document.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe('RichHoverTooltip above the browser page', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });
  function render(props: {
    aboveBrowser?: boolean;
    interactive?: boolean;
  }): void {
    act(() =>
      root.render(
        <RichHoverTooltip content="Detail" open {...props}>
          <button>Trigger</button>
        </RichHoverTooltip>,
      ),
    );
  }
  const attribute = (): string | null | undefined =>
    document
      .querySelector('[role="tooltip"]')
      ?.getAttribute('data-canopy-above-browser');

  it('marks the surface to draw over the live page when asked', () => {
    render({ aboveBrowser: true });
    expect(attribute()).toBe('true');
  });

  it('leaves the surface unmarked by default', () => {
    render({});
    expect(attribute()).toBeNull();
  });

  it('never marks an interactive surface, which the page copy cannot click', () => {
    render({ aboveBrowser: true, interactive: true });
    expect(attribute()).toBeNull();
  });
});
