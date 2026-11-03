/**
 * @jest-environment jsdom
 */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FloatingMenuPointAnchor } from '../FloatingMenu';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('FloatingMenuPointAnchor', () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  it('places a zero-size anchor at the pointer in the owner window', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const ownerDocument = iframe.contentDocument;
    if (ownerDocument === null) throw new Error('Expected iframe document');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const ref = createRef<HTMLSpanElement>();

    root = createRoot(container);
    act(() => {
      root?.render(
        <FloatingMenuPointAnchor
          ref={ref}
          x={120}
          y={48}
          ownerDocument={ownerDocument}
          data-testid="row-menu-anchor"
        />,
      );
    });

    const anchor = ownerDocument.querySelector<HTMLElement>(
      '[data-testid="row-menu-anchor"]',
    );
    expect(anchor).not.toBeNull();
    expect(ref.current).toBe(anchor);
    expect(container.contains(anchor)).toBe(false);
    expect(anchor?.parentElement).toBe(ownerDocument.body);
    expect(anchor?.getAttribute('aria-hidden')).toBe('true');
    expect(anchor?.style.left).toBe('120px');
    expect(anchor?.style.top).toBe('48px');
    expect(anchor?.className).toContain('pointer-events-none');
  });
});
