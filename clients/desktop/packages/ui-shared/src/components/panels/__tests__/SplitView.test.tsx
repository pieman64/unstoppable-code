/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SplitView, type SplitViewPane } from '../SplitView';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  readonly callback: ResizeObserverCallback;
  readonly targets: Element[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(): void {
    // noop
  }

  disconnect(): void {
    // noop
  }

  trigger(width: number, height: number): void {
    const entry = {
      contentRect: { width, height },
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;

interface PointerEventOptions {
  pageX?: number;
  pageY?: number;
  altKey?: boolean;
}

// jsdom does not implement PointerEvent; fall back to MouseEvent, which
// structurally satisfies everything the sash drag logic reads.
function createPointerEvent(
  type: string,
  options: PointerEventOptions = {},
): MouseEvent {
  const Ctor =
    typeof window.PointerEvent === 'function'
      ? window.PointerEvent
      : MouseEvent;
  const event = new Ctor(type, {
    bubbles: true,
    cancelable: true,
    altKey: options.altKey ?? false,
  });
  Object.defineProperty(event, 'pageX', { value: options.pageX ?? 0 });
  Object.defineProperty(event, 'pageY', { value: options.pageY ?? 0 });
  return event;
}

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

/** Drives every observed ResizeObserver with the given size. */
function layoutAll(width: number, height: number): void {
  act(() => {
    for (const instance of ResizeObserverStub.instances) {
      if (instance.targets.length > 0) {
        instance.trigger(width, height);
      }
    }
  });
}

function getSashElement(container: HTMLElement, index = 0): HTMLElement {
  const sash = container.querySelectorAll('.canopy-sash').item(index);

  if (!(sash instanceof HTMLElement)) {
    throw new Error(`Expected sash element at index ${index}`);
  }

  return sash;
}

/** Simulates a full drag of a sash in a vertical (stacked) split view. */
function dragSashVertically(
  sashElement: HTMLElement,
  delta: number,
  options: { end?: boolean } = {},
): void {
  const start = 100;
  act(() => {
    sashElement.dispatchEvent(
      createPointerEvent('pointerdown', { pageX: 0, pageY: start }),
    );
    window.dispatchEvent(
      createPointerEvent('pointermove', { pageX: 0, pageY: start + delta }),
    );

    if (options.end ?? true) {
      window.dispatchEvent(
        createPointerEvent('pointerup', { pageX: 0, pageY: start + delta }),
      );
    }
  });
}

function pane(id: string, extra: Partial<SplitViewPane> = {}): SplitViewPane {
  return {
    id,
    content: <div data-testid={`content-${id}`}>{id}</div>,
    ...extra,
  };
}

describe('SplitView', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    ResizeObserverStub.instances.length = 0;
    jest.restoreAllMocks();
  });

  it('renders pane content into engine-owned wrappers with sashes between', () => {
    const { container, root } = render(
      <SplitView orientation="vertical" panes={[pane('a'), pane('b')]} />,
    );

    try {
      layoutAll(300, 200);

      expect(container.querySelector('.canopy-split-view')).not.toBeNull();
      expect(container.querySelectorAll('.split-view-view')).toHaveLength(2);
      expect(container.querySelectorAll('.canopy-sash')).toHaveLength(1);

      const contentA = container.querySelector('[data-testid="content-a"]');
      const contentB = container.querySelector('[data-testid="content-b"]');
      expect(contentA).not.toBeNull();
      expect(contentB).not.toBeNull();
      expect(contentA?.closest('.split-view-view')).not.toBeNull();
      expect(contentB?.closest('.split-view-view')).not.toBeNull();

      // Distributed evenly after the first real layout.
      const wrappers = container.querySelectorAll('.split-view-view');
      const first = wrappers.item(0);
      const second = wrappers.item(1);

      if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) {
        throw new Error('Expected split view wrappers');
      }

      expect(first.style.height).toBe('100px');
      expect(second.style.height).toBe('100px');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('keeps pane content DOM identity across resizes and sibling add/remove', () => {
    const { container, root } = render(
      <SplitView orientation="vertical" panes={[pane('a'), pane('b')]} />,
    );

    try {
      layoutAll(300, 200);

      const before = container.querySelector('[data-testid="content-a"]');
      expect(before).not.toBeNull();

      // Sizes-changing relayout: drag the sash.
      dragSashVertically(getSashElement(container), 30);
      expect(container.querySelector('[data-testid="content-a"]')).toBe(before);

      // Container relayout.
      layoutAll(300, 400);
      expect(container.querySelector('[data-testid="content-a"]')).toBe(before);

      // Add a sibling pane.
      act(() => {
        root.render(
          <SplitView
            orientation="vertical"
            panes={[pane('a'), pane('b'), pane('c')]}
          />,
        );
      });
      expect(container.querySelector('[data-testid="content-c"]')).not.toBe(
        null,
      );
      expect(container.querySelector('[data-testid="content-a"]')).toBe(before);

      // Remove a sibling pane.
      act(() => {
        root.render(
          <SplitView orientation="vertical" panes={[pane('a'), pane('c')]} />,
        );
      });
      expect(container.querySelector('[data-testid="content-b"]')).toBeNull();
      expect(container.querySelector('[data-testid="content-a"]')).toBe(before);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('diffs pane additions and removals by id', () => {
    const { container, root } = render(
      <SplitView orientation="vertical" panes={[pane('a'), pane('b')]} />,
    );

    try {
      layoutAll(300, 200);
      expect(container.querySelectorAll('.split-view-view')).toHaveLength(2);
      expect(container.querySelectorAll('.canopy-sash')).toHaveLength(1);

      act(() => {
        root.render(
          <SplitView
            orientation="vertical"
            panes={[pane('a'), pane('b'), pane('c')]}
          />,
        );
      });
      expect(container.querySelectorAll('.split-view-view')).toHaveLength(3);
      expect(container.querySelectorAll('.canopy-sash')).toHaveLength(2);

      act(() => {
        root.render(<SplitView orientation="vertical" panes={[pane('c')]} />);
      });
      expect(container.querySelectorAll('.split-view-view')).toHaveLength(1);
      expect(container.querySelectorAll('.canopy-sash')).toHaveLength(0);
      expect(container.querySelector('[data-testid="content-a"]')).toBeNull();
      expect(container.querySelector('[data-testid="content-b"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="content-c"]'),
      ).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('fires onResizeStart/onResize during a drag and onResizeEnd on commit', () => {
    const onResizeStart = jest.fn();
    const onResize = jest.fn();
    const onResizeEnd = jest.fn();
    const { container, root } = render(
      <SplitView
        orientation="vertical"
        panes={[pane('a'), pane('b')]}
        onResizeStart={onResizeStart}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
      />,
    );

    try {
      layoutAll(300, 200);

      dragSashVertically(getSashElement(container), 30, { end: false });

      expect(onResizeStart).toHaveBeenCalledTimes(1);
      expect(onResize).toHaveBeenCalledWith({ a: 130, b: 70 });
      expect(onResizeEnd).not.toHaveBeenCalled();

      act(() => {
        window.dispatchEvent(
          createPointerEvent('pointerup', { pageX: 0, pageY: 130 }),
        );
      });

      expect(onResizeEnd).toHaveBeenCalledTimes(1);
      expect(onResizeEnd).toHaveBeenCalledWith({ a: 130, b: 70 });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('applies initial and updated controlled pane sizes', () => {
    const { container, root } = render(
      <SplitView
        orientation="vertical"
        panes={[pane('a', { size: 150 }), pane('b', { size: 50 })]}
      />,
    );

    try {
      layoutAll(300, 200);

      const wrappers = container.querySelectorAll('.split-view-view');
      const first = wrappers.item(0);
      const second = wrappers.item(1);

      if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) {
        throw new Error('Expected split view wrappers');
      }

      expect(first.style.height).toBe('150px');
      expect(second.style.height).toBe('50px');

      act(() => {
        root.render(
          <SplitView
            orientation="vertical"
            panes={[pane('a', { size: 150 }), pane('b', { size: 120 })]}
          />,
        );
      });

      expect(second.style.height).toBe('120px');
      expect(first.style.height).toBe('80px');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('decorates sashes with the separator ARIA contract and keeps it updated', () => {
    const { container, root } = render(
      <SplitView
        orientation="vertical"
        panes={[pane('a', { minSize: 20, maxSize: 180 }), pane('b')]}
        sashAriaLabel="Resize sections"
      />,
    );

    try {
      layoutAll(300, 200);

      const sash = getSashElement(container);
      expect(sash.getAttribute('role')).toBe('separator');
      // A separator between vertically stacked panes is a horizontal line.
      expect(sash.getAttribute('aria-orientation')).toBe('horizontal');
      expect(sash.getAttribute('aria-label')).toBe('Resize sections');
      expect(sash.getAttribute('aria-valuemin')).toBe('20');
      expect(sash.getAttribute('aria-valuemax')).toBe('180');
      expect(sash.getAttribute('aria-valuenow')).toBe('100');
      expect(sash.tabIndex).toBe(0);

      dragSashVertically(sash, 30);
      expect(sash.getAttribute('aria-valuenow')).toBe('130');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('uses vertical separators for horizontal (side-by-side) orientation', () => {
    const { container, root } = render(
      <SplitView orientation="horizontal" panes={[pane('a'), pane('b')]} />,
    );

    try {
      layoutAll(200, 300);

      const sash = getSashElement(container);
      expect(sash.classList.contains('vertical')).toBe(true);
      expect(sash.getAttribute('aria-orientation')).toBe('vertical');

      const wrappers = container.querySelectorAll('.split-view-view');
      const first = wrappers.item(0);

      if (!(first instanceof HTMLElement)) {
        throw new Error('Expected split view wrapper');
      }

      expect(first.style.width).toBe('100px');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('resizes with arrow keys on a focused sash and commits via onResizeEnd', () => {
    const onResizeEnd = jest.fn();
    const { container, root } = render(
      <SplitView
        orientation="vertical"
        panes={[pane('a'), pane('b')]}
        onResizeEnd={onResizeEnd}
      />,
    );

    try {
      layoutAll(300, 200);

      const sash = getSashElement(container);
      sash.focus();

      act(() => {
        sash.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      expect(onResizeEnd).toHaveBeenCalledWith({ a: 110, b: 90 });
      expect(sash.getAttribute('aria-valuenow')).toBe('110');

      act(() => {
        sash.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowUp',
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      expect(onResizeEnd).toHaveBeenLastCalledWith({ a: 100, b: 100 });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('does not re-render pane content during a sash drag (perf guard)', () => {
    // A sash drag is a pure engine operation (DOM style mutation); it must
    // not schedule ANY React work for pane content — not just avoid
    // remounts. Guards the panel-grid resize path's render cost.
    const renderCount = jest.fn();

    function CountingPane(): JSX.Element {
      renderCount();
      return <div data-testid="counting-pane" />;
    }

    const { container, root } = render(
      <SplitView
        orientation="vertical"
        panes={[{ id: 'a', content: <CountingPane /> }, pane('b')]}
      />,
    );

    try {
      layoutAll(300, 200);
      const callsAfterMount = renderCount.mock.calls.length;
      expect(callsAfterMount).toBeGreaterThan(0);

      // Full drag (down + move + up) and a mid-flight drag with extra moves.
      dragSashVertically(getSashElement(container), 30);
      dragSashVertically(getSashElement(container), -10, { end: false });
      act(() => {
        window.dispatchEvent(
          createPointerEvent('pointermove', { pageX: 0, pageY: 70 }),
        );
        window.dispatchEvent(
          createPointerEvent('pointerup', { pageX: 0, pageY: 70 }),
        );
      });

      expect(renderCount.mock.calls.length).toBe(callsAfterMount);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('disposes cleanly on unmount, even mid-drag', () => {
    const onResize = jest.fn();
    const { container, root } = render(
      <SplitView
        orientation="vertical"
        panes={[pane('a'), pane('b')]}
        onResize={onResize}
      />,
    );

    layoutAll(300, 200);

    // Start a drag, then unmount before it finishes.
    dragSashVertically(getSashElement(container), 10, { end: false });

    act(() => {
      root.unmount();
    });

    expect(document.querySelectorAll('.canopy-split-view')).toHaveLength(0);

    const callsBefore = onResize.mock.calls.length;

    expect(() => {
      window.dispatchEvent(
        createPointerEvent('pointermove', { pageX: 0, pageY: 160 }),
      );
      window.dispatchEvent(
        createPointerEvent('pointerup', { pageX: 0, pageY: 160 }),
      );
      // Late ResizeObserver notification after unmount must be a no-op.
      for (const instance of ResizeObserverStub.instances) {
        if (instance.targets.length > 0) {
          instance.trigger(300, 500);
        }
      }
    }).not.toThrow();

    expect(onResize.mock.calls.length).toBe(callsBefore);
  });
});
