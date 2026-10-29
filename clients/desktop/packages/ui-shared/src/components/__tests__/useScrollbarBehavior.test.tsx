/**
 * @jest-environment jsdom
 */
import { act, type JSX, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useScrollbarBehavior } from '../../lib/useAlwaysVisibleScrollbars';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function Harness(): JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const behavior = useScrollbarBehavior(scrollerRef);
  return (
    <div
      ref={scrollerRef}
      data-testid="native-scroller"
      data-behavior={behavior}
    />
  );
}

describe('useScrollbarBehavior native scrollers', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    document.documentElement.dataset.scrollbarBehavior = 'scroll';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(<Harness />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.documentElement.removeAttribute('data-scrollbar-behavior');
    jest.useRealTimers();
  });

  it('marks a native scroller during explicit while-scrolling activity', () => {
    const scroller = container.querySelector('[data-testid="native-scroller"]');
    if (!(scroller instanceof HTMLElement)) {
      throw new Error('native scroller not rendered');
    }

    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.dataset.nativeScrollbarScrolling).toBe('true');

    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(scroller.dataset.nativeScrollbarScrolling).toBeUndefined();
  });

  it('marks the hovered native scroller for the explicit hover policy', () => {
    document.documentElement.dataset.scrollbarBehavior = 'hover';
    const scroller = container.querySelector('[data-testid="native-scroller"]');
    if (!(scroller instanceof HTMLElement)) {
      throw new Error('native scroller not rendered');
    }
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(scroller, 'clientHeight', {
      configurable: true,
      value: 100,
    });

    scroller.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    expect(scroller.dataset.nativeScrollbarHovered).toBe('true');

    scroller.dispatchEvent(
      new MouseEvent('pointerout', {
        bubbles: true,
        relatedTarget: document.body,
      }),
    );
    expect(scroller.dataset.nativeScrollbarHovered).toBeUndefined();
  });

  it('subscribes to activity in the rendered element owner document', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const childDocument = frame.contentDocument;
    if (childDocument === null) throw new Error('iframe document unavailable');
    childDocument.documentElement.dataset.scrollbarBehavior = 'scroll';
    const childContainer = childDocument.createElement('div');
    childDocument.body.append(childContainer);
    const childRoot = createRoot(childContainer);

    act(() => {
      childRoot.render(<Harness />);
    });
    const scroller = childContainer.querySelector(
      '[data-testid="native-scroller"]',
    );
    if (scroller === null) {
      throw new Error('child native scroller not rendered');
    }

    const adoptedScroller = document.createElement('div');
    childDocument.body.append(childDocument.adoptNode(adoptedScroller));
    const scrollEvent = childDocument.createEvent('Event');
    scrollEvent.initEvent('scroll', false, false);
    adoptedScroller.dispatchEvent(scrollEvent);
    expect(
      adoptedScroller.getAttribute('data-native-scrollbar-scrolling'),
    ).toBe('true');

    act(() => {
      childRoot.unmount();
    });
    frame.remove();
  });

  it('skips clipped descendants when locating the hovered scroller', () => {
    document.documentElement.dataset.scrollbarBehavior = 'hover';
    const scroller = container.querySelector('[data-testid="native-scroller"]');
    if (!(scroller instanceof HTMLElement)) {
      throw new Error('native scroller not rendered');
    }
    scroller.style.overflowY = 'auto';
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 100 },
    });
    const clippedLabel = document.createElement('span');
    clippedLabel.style.overflow = 'hidden';
    Object.defineProperties(clippedLabel, {
      scrollWidth: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 100 },
    });
    scroller.append(clippedLabel);

    clippedLabel.dispatchEvent(
      new MouseEvent('pointerover', { bubbles: true }),
    );

    expect(clippedLabel.dataset.nativeScrollbarHovered).toBeUndefined();
    expect(scroller.dataset.nativeScrollbarHovered).toBe('true');
  });
});
