/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnchorHighlightRing } from '../AnchorHighlightRing';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('AnchorHighlightRing', () => {
  let container: HTMLDivElement;
  let anchor: HTMLDivElement;
  let root: Root;
  let box = { left: 20, top: 30, width: 200, height: 40 };

  beforeEach(() => {
    container = document.createElement('div');
    anchor = document.createElement('div');
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      value: (): Record<string, unknown> => ({
        ...box,
        right: box.left + box.width,
        bottom: box.top + box.height,
        x: box.left,
        y: box.top,
        toJSON: () => ({}),
      }),
    });
    document.body.append(container, anchor);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    anchor.remove();
    box = { left: 20, top: 30, width: 200, height: 40 };
  });

  const rect = (): Element | null =>
    document.querySelector('[data-testid="ring"] rect');

  it('rings the anchor in a pointer-transparent overlay and follows it when the window changes', () => {
    act(() => {
      root.render(
        <AnchorHighlightRing resolveAnchor={() => anchor} testId="ring" />,
      );
    });
    const overlay = document.querySelector('[data-testid="ring"]');
    expect(overlay?.parentElement).toBe(document.body);
    expect(overlay?.className).toContain('pointer-events-none');
    expect(overlay?.className).toContain('fixed');
    expect(overlay?.className).toContain('z-spotlight');
    expect(rect()?.getAttribute('x')).toBe('14');
    expect(rect()?.getAttribute('y')).toBe('24');
    expect(rect()?.getAttribute('width')).toBe('212');
    expect(rect()?.getAttribute('height')).toBe('52');
    expect(rect()?.getAttribute('stroke')).toBe('var(--fg-accent)');
    box = { left: 50, top: 30, width: 200, height: 40 };
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(rect()?.getAttribute('x')).toBe('44');
  });

  it('follows an anchor that React re-creates', () => {
    let target: HTMLElement = anchor;
    act(() => {
      root.render(
        <AnchorHighlightRing resolveAnchor={() => target} testId="ring" />,
      );
    });
    expect(rect()?.getAttribute('x')).toBe('14');
    const replacement = document.createElement('div');
    Object.defineProperty(replacement, 'getBoundingClientRect', {
      value: (): Record<string, unknown> => ({
        left: 300,
        top: 30,
        width: 200,
        height: 40,
        right: 500,
        bottom: 70,
        x: 300,
        y: 30,
        toJSON: () => ({}),
      }),
    });
    anchor.remove();
    document.body.append(replacement);
    target = replacement;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(rect()?.getAttribute('x')).toBe('294');
    replacement.remove();
  });

  it("stays within the anchor's scroll container and hides once it is scrolled out", () => {
    const scroller = document.createElement('div');
    scroller.style.overflowX = 'hidden';
    scroller.style.overflowY = 'auto';
    let bounds = { left: 0, top: 0, right: 120, bottom: 200 };
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      value: (): Record<string, unknown> => ({
        ...bounds,
        width: bounds.right - bounds.left,
        height: bounds.bottom - bounds.top,
        x: bounds.left,
        y: bounds.top,
        toJSON: () => ({}),
      }),
    });
    document.body.append(scroller);
    scroller.append(anchor);
    act(() => {
      root.render(
        <AnchorHighlightRing resolveAnchor={() => anchor} testId="ring" />,
      );
    });
    // The anchor spans 20..220; the scroller shows 0..120 of it.
    expect(rect()?.getAttribute('x')).toBe('14');
    expect(rect()?.getAttribute('width')).toBe('112');
    bounds = { left: 0, top: 0, right: 10, bottom: 200 };
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(document.querySelector('[data-testid="ring"]')).toBeNull();
    scroller.remove();
  });

  it('moves to the element a new resolver names, as the next tour stop does', () => {
    const other = document.createElement('div');
    Object.defineProperty(other, 'getBoundingClientRect', {
      value: (): Record<string, unknown> => ({
        left: 300,
        top: 30,
        width: 200,
        height: 40,
        right: 500,
        bottom: 70,
        x: 300,
        y: 30,
        toJSON: () => ({}),
      }),
    });
    document.body.append(other);
    act(() => {
      root.render(
        <AnchorHighlightRing resolveAnchor={() => anchor} testId="ring" />,
      );
    });
    expect(rect()?.getAttribute('x')).toBe('14');
    // The first anchor is still in the document; the resolver changed.
    act(() => {
      root.render(
        <AnchorHighlightRing resolveAnchor={() => other} testId="ring" />,
      );
    });
    expect(rect()?.getAttribute('x')).toBe('294');
    other.remove();
  });

  it('watches a re-created anchor for size changes, not only the first one', () => {
    const observed: Element[] = [];
    class RecordingObserver {
      observe(target: Element): void {
        observed.push(target);
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    const previous = Reflect.get(globalThis, 'ResizeObserver');
    Reflect.set(globalThis, 'ResizeObserver', RecordingObserver);
    try {
      let target: HTMLElement = anchor;
      act(() => {
        root.render(
          <AnchorHighlightRing resolveAnchor={() => target} testId="ring" />,
        );
      });
      expect(observed).toEqual([anchor, document.body]);
      const replacement = document.createElement('div');
      Object.defineProperty(replacement, 'getBoundingClientRect', {
        value: (): Record<string, unknown> => ({
          left: 40,
          top: 30,
          width: 200,
          height: 40,
          right: 240,
          bottom: 70,
          x: 40,
          y: 30,
          toJSON: () => ({}),
        }),
      });
      anchor.remove();
      document.body.append(replacement);
      target = replacement;
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      expect(observed).toEqual([anchor, document.body, replacement]);
      replacement.remove();
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(globalThis, 'ResizeObserver');
      else Reflect.set(globalThis, 'ResizeObserver', previous);
    }
  });

  it('re-measures for a transition around the anchor and ignores one elsewhere', () => {
    const elsewhere = document.createElement('div');
    document.body.append(elsewhere);
    act(() => {
      root.render(
        <AnchorHighlightRing resolveAnchor={() => anchor} testId="ring" />,
      );
    });
    expect(rect()?.getAttribute('x')).toBe('14');
    box = { left: 50, top: 30, width: 200, height: 40 };
    act(() => {
      elsewhere.dispatchEvent(new Event('transitionend', { bubbles: true }));
    });
    expect(rect()?.getAttribute('x')).toBe('14');
    act(() => {
      anchor.dispatchEvent(new Event('transitionend', { bubbles: true }));
    });
    expect(rect()?.getAttribute('x')).toBe('44');
    elsewhere.remove();
  });

  it('draws nothing for an anchor without a box', () => {
    box = { left: 0, top: 0, width: 0, height: 0 };
    act(() => {
      root.render(
        <AnchorHighlightRing resolveAnchor={() => anchor} testId="ring" />,
      );
    });
    expect(document.querySelector('[data-testid="ring"]')).toBeNull();
  });
});
