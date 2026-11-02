/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention (@testing-library/react is
 * not installed). jsdom reports no layout, so `scrollHeight` is stubbed per
 * test to simulate short vs. overflowing content; the computed line-height
 * falls back to the component's 20px default, making the collapse threshold
 * 20 × 3.5 = 70px.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CollapsibleUserMessageContent } from '../CollapsibleUserMessageContent';

let triggerResizeObserver: (() => void) | undefined;

class ResizeObserverStub {
  constructor(callback: ResizeObserverCallback) {
    triggerResizeObserver = (): void => {
      callback([], this);
    };
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
}

let container: HTMLDivElement;
let root: Root;
let scrollHeightValue = 0;
const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollHeight',
);
const originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'getBoundingClientRect',
);

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeightValue,
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function getBoundingClientRect(this: HTMLElement): DOMRect {
      return new DOMRect(
        0,
        Number.parseFloat(this.dataset.offsetTop ?? '0'),
        10,
        10,
      );
    },
  });
});

afterAll(() => {
  if (originalResizeObserver) {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: originalResizeObserver,
    });
  }
  if (originalScrollHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollHeight',
      originalScrollHeight,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  }
  if (originalGetBoundingClientRect) {
    Object.defineProperty(
      HTMLElement.prototype,
      'getBoundingClientRect',
      originalGetBoundingClientRect,
    );
  }
});

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
});

function mount(
  forceExpanded = false,
  deliverInitialResize = true,
  measurementKey?: string,
): void {
  act(() => {
    root.render(
      createElement(CollapsibleUserMessageContent, {
        forceExpanded,
        measurementKey,
        children: createElement('p', null, 'message body'),
      }),
    );
  });
  if (deliverInitialResize) act(() => triggerResizeObserver?.());
}

function mountWithLinks(onVisibleClick: () => void): void {
  act(() => {
    root.render(
      createElement(
        CollapsibleUserMessageContent,
        null,
        createElement(
          'a',
          {
            href: '/visible-target',
            'data-offset-top': '20',
            onClick: onVisibleClick,
          },
          'visible link',
        ),
        createElement(
          'a',
          // Inside the surviving part of the cut row (the clamp ends at 78).
          { href: '/faded-target', 'data-offset-top': '65' },
          'faded row link',
        ),
        createElement(
          'a',
          { href: '/hidden-target', 'data-offset-top': '100' },
          'hidden link',
        ),
      ),
    );
  });
  act(() => triggerResizeObserver?.());
}

function click(el: Element | null): void {
  if (!el) throw new Error('expected element to click');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('CollapsibleUserMessageContent', () => {
  it('waits for initial browser layout before measuring prompt line boxes', () => {
    scrollHeightValue = 200;
    const read = jest.spyOn(document, 'createRange');
    try {
      mount(false, false);
      expect(read).not.toHaveBeenCalled();
      act(() => triggerResizeObserver?.());
      expect(read).toHaveBeenCalled();
      expect(
        container
          .querySelector('[data-testid="user-message-content"]')
          ?.getAttribute('data-collapsed'),
      ).toBe('true');
    } finally {
      read.mockRestore();
    }
  });
  // Switching chat tabs remounts the transcript. Without the last
  // measurement, every long prompt painted at full height for a frame and
  // then collapsed, which jumped the panel on each switch.
  it('opens a remounted prompt collapsed from its last measurement', () => {
    scrollHeightValue = 200;
    mount(false, true, 'remount-prompt');
    act(() => {
      root.unmount();
    });
    root = createRoot(container);

    const read = jest.spyOn(document, 'createRange');
    try {
      mount(false, false, 'remount-prompt');
      const content = container.querySelector<HTMLElement>(
        '[data-testid="user-message-content"]',
      );
      expect(content?.getAttribute('data-collapsed')).toBe('true');
      expect(content?.style.maxHeight).toBe('78px');
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('does not reuse a measurement across different prompts', () => {
    scrollHeightValue = 200;
    mount(false, true, 'measured-prompt');
    act(() => {
      root.unmount();
    });
    root = createRoot(container);

    mount(false, false, 'unmeasured-prompt');
    expect(
      container
        .querySelector('[data-testid="user-message-content"]')
        ?.getAttribute('data-collapsed'),
    ).toBe('false');
  });

  it('renders short content without any collapse affordance', () => {
    scrollHeightValue = 40;
    mount();

    expect(
      container.querySelector('[data-testid="user-message-show-more"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="user-message-show-less"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="user-message-content"]')
        ?.getAttribute('data-collapsed'),
    ).toBe('false');
  });

  // Past the 78px clamp but inside its half-row tolerance: shown in full, and
  // not marked collapsible, so the sticky header pins it by its top edge.
  it('does not mark content within the overflow tolerance as collapsible', () => {
    scrollHeightValue = 84;
    mount();

    const content = container.querySelector<HTMLElement>(
      '[data-testid="user-message-content"]',
    );
    expect(content?.getAttribute('data-collapsed')).toBe('false');
    expect(content?.hasAttribute('data-collapsible')).toBe(false);
    expect(
      container.querySelector('[data-testid="user-message-show-more"]'),
    ).toBeNull();
  });

  it('collapses overflowing content to the row budget with a faded Show more', () => {
    scrollHeightValue = 200;
    mount();

    const content = container.querySelector<HTMLElement>(
      '[data-testid="user-message-content"]',
    );
    expect(content?.getAttribute('data-collapsed')).toBe('true');
    expect(content?.getAttribute('data-collapsible')).toBe('true');
    // 3 full rows, plus most of the 4th, plus the extra reveal, at the 20px
    // fallback line-height: 3 × 20 + 0.6 × 20 + 6.
    expect(content?.style.maxHeight).toBe('78px');
    expect(content?.style.maskImage).toContain('linear-gradient');

    const showMore = container.querySelector(
      '[data-testid="user-message-show-more"]',
    );
    expect(showMore?.getAttribute('aria-expanded')).toBe('false');
    expect(showMore?.textContent).toBe('Show more');
  });

  it('keeps visible controls interactive and hides only clipped controls', () => {
    scrollHeightValue = 200;
    const onVisibleClick = jest.fn();
    mountWithLinks(onVisibleClick);

    const content = container.querySelector<HTMLElement>(
      '[data-testid="user-message-content"]',
    );
    const visibleLink = container.querySelector<HTMLAnchorElement>(
      'a[href="/visible-target"]',
    );
    const hiddenLink = container.querySelector<HTMLAnchorElement>(
      'a[href="/hidden-target"]',
    );
    const fadedLink = container.querySelector<HTMLAnchorElement>(
      'a[href="/faded-target"]',
    );
    expect(content?.hasAttribute('inert')).toBe(false);
    expect(content?.hasAttribute('aria-hidden')).toBe(false);
    expect(visibleLink?.hasAttribute('tabindex')).toBe(false);
    expect(visibleLink?.hasAttribute('aria-hidden')).toBe(false);
    click(visibleLink);
    expect(onVisibleClick).toHaveBeenCalledTimes(1);
    expect(fadedLink?.hasAttribute('tabindex')).toBe(false);
    expect(fadedLink?.hasAttribute('aria-hidden')).toBe(false);
    expect(hiddenLink?.getAttribute('tabindex')).toBe('-1');
    expect(hiddenLink?.getAttribute('aria-hidden')).toBe('true');

    click(container.querySelector('[data-testid="user-message-show-more"]'));
    expect(hiddenLink?.hasAttribute('tabindex')).toBe(false);
    expect(hiddenLink?.hasAttribute('aria-hidden')).toBe(false);
  });

  it('recomputes clipped-control suppression after layout reflow', () => {
    scrollHeightValue = 200;
    mountWithLinks(jest.fn());

    const visibleLink = container.querySelector<HTMLAnchorElement>(
      'a[href="/visible-target"]',
    );
    const hiddenLink = container.querySelector<HTMLAnchorElement>(
      'a[href="/hidden-target"]',
    );
    expect(hiddenLink?.getAttribute('tabindex')).toBe('-1');

    hiddenLink?.setAttribute('data-offset-top', '40');
    visibleLink?.setAttribute('data-offset-top', '100');
    act(() => triggerResizeObserver?.());

    expect(hiddenLink?.hasAttribute('tabindex')).toBe(false);
    expect(hiddenLink?.hasAttribute('aria-hidden')).toBe(false);
    expect(visibleLink?.getAttribute('tabindex')).toBe('-1');
    expect(visibleLink?.getAttribute('aria-hidden')).toBe('true');
  });

  it('publishes the collapsed clamp height in both collapse states', () => {
    scrollHeightValue = 200;
    mount();

    const content = container.querySelector<HTMLElement>(
      '[data-testid="user-message-content"]',
    );
    // Same 78px budget the maxHeight clamp uses (3 rows + 0.6 of the cut row
    // + the 6px extra reveal at the 20px fallback line-height).
    expect(content?.getAttribute('data-collapsed-max-px')).toBe('78');

    click(container.querySelector('[data-testid="user-message-show-more"]'));
    // Still published while expanded: the sticky transcript header reads it
    // to compute how much of the expansion scrolls out of view before the
    // message's bottom edge pins.
    expect(content?.getAttribute('data-collapsed-max-px')).toBe('78');
  });

  it('reveals overflowing content while transcript search is active', () => {
    scrollHeightValue = 200;
    mount(true);

    expect(
      container
        .querySelector('[data-testid="user-message-content"]')
        ?.getAttribute('data-collapsed'),
    ).toBe('false');
    expect(
      container.querySelector('[data-testid="user-message-show-more"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="user-message-show-less"]'),
    ).toBeNull();
  });

  it('expands to the full message and re-collapses via Show less', () => {
    scrollHeightValue = 200;
    mount();

    click(container.querySelector('[data-testid="user-message-show-more"]'));

    const content = container.querySelector<HTMLElement>(
      '[data-testid="user-message-content"]',
    );
    expect(content?.getAttribute('data-collapsed')).toBe('false');
    expect(content?.style.maxHeight).toBe('');
    expect(
      container.querySelector('[data-testid="user-message-show-more"]'),
    ).toBeNull();

    const showLess = container.querySelector(
      '[data-testid="user-message-show-less"]',
    );
    expect(showLess?.getAttribute('aria-expanded')).toBe('true');

    click(showLess);
    expect(
      container
        .querySelector('[data-testid="user-message-content"]')
        ?.getAttribute('data-collapsed'),
    ).toBe('true');
    expect(
      container.querySelector('[data-testid="user-message-show-more"]'),
    ).not.toBeNull();
  });
});
