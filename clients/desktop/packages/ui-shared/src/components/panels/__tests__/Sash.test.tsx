/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Sash, type SashDragEvent } from '../Sash';

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

function getSashElement(container: HTMLElement): HTMLElement {
  const sash = container.querySelector('.canopy-sash');

  if (!(sash instanceof HTMLElement)) {
    throw new Error('Expected a sash element');
  }

  return sash;
}

describe('Sash', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    ResizeObserverStub.instances.length = 0;
    jest.restoreAllMocks();
  });

  it('renders an engine sash with the separator ARIA contract', () => {
    const { container, root } = render(
      <Sash
        orientation="vertical"
        ariaLabel="Resize sidebar"
        ariaValueMin={100}
        ariaValueMax={400}
        ariaValueNow={250}
      />,
    );

    try {
      const sash = getSashElement(container);
      expect(sash.classList.contains('vertical')).toBe(true);
      expect(sash.getAttribute('role')).toBe('separator');
      expect(sash.getAttribute('aria-orientation')).toBe('vertical');
      expect(sash.getAttribute('aria-label')).toBe('Resize sidebar');
      expect(sash.getAttribute('aria-valuemin')).toBe('100');
      expect(sash.getAttribute('aria-valuemax')).toBe('400');
      expect(sash.getAttribute('aria-valuenow')).toBe('250');
      expect(sash.tabIndex).toBe(0);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('fires drag start/change/end callbacks for a pointer drag', () => {
    const onDragStart = jest.fn();
    const onChange = jest.fn();
    const onDragEnd = jest.fn();
    const { container, root } = render(
      <Sash
        orientation="vertical"
        onDragStart={onDragStart}
        onChange={onChange}
        onDragEnd={onDragEnd}
      />,
    );

    try {
      const sash = getSashElement(container);

      act(() => {
        sash.dispatchEvent(
          createPointerEvent('pointerdown', { pageX: 50, pageY: 10 }),
        );
        window.dispatchEvent(
          createPointerEvent('pointermove', { pageX: 80, pageY: 10 }),
        );
        window.dispatchEvent(
          createPointerEvent('pointerup', { pageX: 80, pageY: 10 }),
        );
      });

      const expectedStart: SashDragEvent = {
        startX: 50,
        currentX: 50,
        startY: 10,
        currentY: 10,
        altKey: false,
      };
      expect(onDragStart).toHaveBeenCalledTimes(1);
      expect(onDragStart).toHaveBeenCalledWith(expectedStart);

      const expectedChange: SashDragEvent = {
        startX: 50,
        currentX: 80,
        startY: 10,
        currentY: 10,
        altKey: false,
      };
      expect(onChange).toHaveBeenCalledWith(expectedChange);
      expect(onDragEnd).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('ignores pointer drags and keyboard input when disabled', () => {
    const onDragStart = jest.fn();
    const onChange = jest.fn();
    const { container, root } = render(
      <Sash
        orientation="vertical"
        onDragStart={onDragStart}
        onChange={onChange}
        disabled
      />,
    );

    try {
      const sash = getSashElement(container);
      expect(sash.classList.contains('disabled')).toBe(true);
      expect(sash.getAttribute('aria-disabled')).toBe('true');
      expect(sash.tabIndex).toBe(-1);

      act(() => {
        sash.dispatchEvent(
          createPointerEvent('pointerdown', { pageX: 50, pageY: 10 }),
        );
        window.dispatchEvent(
          createPointerEvent('pointermove', { pageX: 80, pageY: 10 }),
        );
        window.dispatchEvent(
          createPointerEvent('pointerup', { pageX: 80, pageY: 10 }),
        );
        sash.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      expect(onDragStart).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('fires onReset on double click', () => {
    const onReset = jest.fn();
    const { container, root } = render(
      <Sash orientation="horizontal" onReset={onReset} />,
    );

    try {
      const sash = getSashElement(container);

      act(() => {
        sash.dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
        );
      });

      expect(onReset).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('emits a synthetic drag sequence for arrow-key resizes', () => {
    const onDragStart = jest.fn();
    const onChange = jest.fn();
    const onDragEnd = jest.fn();
    const { container, root } = render(
      <Sash
        orientation="vertical"
        onDragStart={onDragStart}
        onChange={onChange}
        onDragEnd={onDragEnd}
      />,
    );

    try {
      const sash = getSashElement(container);
      sash.focus();

      act(() => {
        sash.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      expect(onDragStart).toHaveBeenCalledTimes(1);
      const expectedChange: SashDragEvent = {
        startX: 0,
        currentX: 10,
        startY: 0,
        currentY: 0,
        altKey: false,
      };
      expect(onChange).toHaveBeenCalledWith(expectedChange);
      expect(onDragEnd).toHaveBeenCalledTimes(1);

      act(() => {
        sash.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowLeft',
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      expect(onChange).toHaveBeenLastCalledWith({
        startX: 0,
        currentX: -10,
        startY: 0,
        currentY: 0,
        altKey: false,
      });

      // A horizontal sash uses the vertical axis keys, so ArrowRight is
      // ignored there; covered via the orientation prop contract above.
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('uses up/down arrows for horizontal sashes', () => {
    const onChange = jest.fn();
    const { container, root } = render(
      <Sash orientation="horizontal" onChange={onChange} />,
    );

    try {
      const sash = getSashElement(container);

      act(() => {
        sash.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(onChange).not.toHaveBeenCalled();

      act(() => {
        sash.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(onChange).toHaveBeenCalledWith({
        startX: 0,
        currentX: 0,
        startY: 0,
        currentY: 10,
        altKey: false,
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('disposes cleanly on unmount', () => {
    const onChange = jest.fn();
    const { container, root } = render(
      <Sash orientation="vertical" onChange={onChange} />,
    );

    const sash = getSashElement(container);

    act(() => {
      sash.dispatchEvent(
        createPointerEvent('pointerdown', { pageX: 50, pageY: 10 }),
      );
    });

    act(() => {
      root.unmount();
    });

    expect(document.querySelectorAll('.canopy-sash')).toHaveLength(0);

    const callsBefore = onChange.mock.calls.length;

    expect(() => {
      window.dispatchEvent(
        createPointerEvent('pointermove', { pageX: 90, pageY: 10 }),
      );
      window.dispatchEvent(
        createPointerEvent('pointerup', { pageX: 90, pageY: 10 }),
      );
    }).not.toThrow();

    expect(onChange.mock.calls.length).toBe(callsBefore);
  });
});
