/** @jest-environment jsdom */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposerControlHighlight } from '../ComposerControlHighlight';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; the outline only needs one that never fires.
class StubResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('ComposerControlHighlight', () => {
  let container: HTMLElement;
  let root: Root;
  let target: HTMLButtonElement;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    globalThis.ResizeObserver = StubResizeObserver;
    container = document.createElement('div');
    document.body.appendChild(container);
    target = document.createElement('button');
    // jsdom lays nothing out; the outline only renders around a measured box.
    target.getBoundingClientRect = (): DOMRect => new DOMRect(40, 20, 32, 32);
    document.body.appendChild(target);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    target.remove();
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('sits on the spotlight layer, above every popover it teaches', () => {
    const ref = createRef<HTMLElement>();
    Object.assign(ref, { current: target });
    act(() => {
      root.render(<ComposerControlHighlight target={ref} testId="outline" />);
    });

    const outline = document.querySelector('[data-testid="outline"]');
    expect(outline).not.toBeNull();
    const tokens = (outline?.className ?? '').split(/\s+/);
    expect(tokens).toContain('z-spotlight');
    // `z-popover` was never a class the stylesheet generates: the outline
    // rendered on the base layer and could sit under the surface it framed.
    expect(tokens).not.toContain('z-popover');
    expect(tokens).toContain('fixed');
  });
});
