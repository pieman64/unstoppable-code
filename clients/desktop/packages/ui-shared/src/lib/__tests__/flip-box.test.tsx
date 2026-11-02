/**
 * @jest-environment jsdom
 */
import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useFlipBox } from '../flip-box';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

const SLIDE = { durationMs: 200, easing: 'ease-out' } as const;

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** jsdom does no layout: the box reports the offsets its styles ask for. */
const OFFSETS = {
  offsetLeft: (element: HTMLElement): number =>
    Number.parseFloat(element.style.left),
  offsetTop: (element: HTMLElement): number =>
    Number.parseFloat(element.style.top),
  offsetWidth: (element: HTMLElement): number =>
    Number.parseFloat(element.style.width),
  offsetHeight: (element: HTMLElement): number =>
    Number.parseFloat(element.style.height),
} as const;

function Moving({ box }: { box: Box }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useFlipBox(ref, SLIDE);
  return <div ref={ref} data-testid="moving" style={{ ...box }} />;
}

/**
 * A fill inside an unpositioned row: both report offsets from the same
 * offset parent, as a progress bar in a list does.
 */
function InRow({
  rowTop,
  width,
}: {
  rowTop: number;
  width: number;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useFlipBox(ref, SLIDE);
  return (
    <div
      data-testid="row"
      style={{ left: 0, top: rowTop, width: 200, height: 8 }}
    >
      <div
        ref={ref}
        data-testid="moving"
        style={{ left: 0, top: rowTop, width, height: 8 }}
      />
    </div>
  );
}

describe('useFlipBox', () => {
  let container: HTMLDivElement;
  let root: Root;
  let animate: jest.Mock;
  const restore: Array<() => void> = [];

  beforeEach(() => {
    const prototype = HTMLElement.prototype;
    for (const [name, read] of Object.entries(OFFSETS)) {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      Object.defineProperty(prototype, name, {
        configurable: true,
        get(this: HTMLElement): number {
          return this.dataset.testid === 'moving' ||
            this.dataset.testid === 'row'
            ? read(this)
            : 0;
        },
      });
      restore.push(() => {
        if (original) Object.defineProperty(prototype, name, original);
      });
    }
    animate = jest.fn(() => ({ cancel: jest.fn() }));
    Object.defineProperty(prototype, 'animate', {
      configurable: true,
      writable: true,
      value: animate,
    });
    restore.push(() => Reflect.deleteProperty(prototype, 'animate'));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    while (restore.length > 0) restore.pop()?.();
  });

  it('draws the first box in place and moves to a new box by transform only', () => {
    act(() =>
      root.render(<Moving box={{ left: 0, top: 0, width: 40, height: 20 }} />),
    );
    expect(animate).not.toHaveBeenCalled();

    act(() =>
      root.render(
        <Moving box={{ left: 100, top: 10, width: 80, height: 10 }} />,
      ),
    );
    const moving = container.querySelector<HTMLElement>(
      '[data-testid="moving"]',
    );
    // The layout box is final at once; only the drawing travels.
    expect(moving?.style.left).toBe('100px');
    expect(moving?.style.width).toBe('80px');
    expect(animate).toHaveBeenCalledWith(
      [
        { transform: 'translate(-100px, -10px) scale(0.5, 2)' },
        { transform: 'none' },
      ],
      { duration: 200, easing: 'ease-out' },
    );
  });

  it('ignores its whole row moving and animates only a change within it', () => {
    act(() => root.render(<InRow rowTop={0} width={40} />));
    // The list re-sorts: the row moves down, the fill inside it does not.
    act(() => root.render(<InRow rowTop={40} width={40} />));
    expect(animate).not.toHaveBeenCalled();

    act(() => root.render(<InRow rowTop={40} width={80} />));
    expect(animate).toHaveBeenCalledWith(
      [
        { transform: 'translate(0px, 0px) scale(0.5, 1)' },
        { transform: 'none' },
      ],
      { duration: 200, easing: 'ease-out' },
    );
  });

  it('leaves an unchanged box alone across renders', () => {
    const box = { left: 4, top: 0, width: 40, height: 20 };
    act(() => root.render(<Moving box={box} />));
    act(() => root.render(<Moving box={{ ...box }} />));
    expect(animate).not.toHaveBeenCalled();
  });

  it('picks a new move up from where a running one has drawn the box', () => {
    const view = window;
    const computed = jest
      .spyOn(view, 'getComputedStyle')
      .mockReturnValue({ transform: 'matrix(0.5, 0, 0, 1, 30, 0)' } as never);
    const matrix = Object.getOwnPropertyDescriptor(view, 'DOMMatrixReadOnly');
    Object.defineProperty(view, 'DOMMatrixReadOnly', {
      configurable: true,
      writable: true,
      value: class {
        readonly a = 0.5;
        readonly d = 1;
        readonly e = 30;
        readonly f = 0;
      },
    });
    try {
      act(() =>
        root.render(
          <Moving box={{ left: 0, top: 0, width: 40, height: 20 }} />,
        ),
      );
      act(() =>
        root.render(
          <Moving box={{ left: 100, top: 0, width: 40, height: 20 }} />,
        ),
      );
      // Drawn at left 30, 20 wide: half the old box, a third of the way.
      expect(animate).toHaveBeenLastCalledWith(
        [
          { transform: 'translate(-70px, 0px) scale(0.5, 1)' },
          { transform: 'none' },
        ],
        { duration: 200, easing: 'ease-out' },
      );
    } finally {
      computed.mockRestore();
      if (matrix) Object.defineProperty(view, 'DOMMatrixReadOnly', matrix);
      else Reflect.deleteProperty(view, 'DOMMatrixReadOnly');
    }
  });

  it('follows a container resize between renders instead of sliding from a stale box', () => {
    let resized: (() => void) | null = null;
    const original = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    });
    try {
      act(() =>
        root.render(
          <Moving box={{ left: 0, top: 0, width: 40, height: 20 }} />,
        ),
      );
      // The container grows: the box follows without a render.
      const moving = container.querySelector<HTMLElement>(
        '[data-testid="moving"]',
      );
      if (moving) moving.style.width = '60px';
      act(() => resized?.());
      act(() =>
        root.render(
          <Moving box={{ left: 0, top: 0, width: 60, height: 20 }} />,
        ),
      );
      expect(animate).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(window, 'ResizeObserver', original);
      else Reflect.deleteProperty(window, 'ResizeObserver');
    }
  });

  it('jumps without motion when reduced motion is asked for', () => {
    const matchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
      }),
    });
    try {
      act(() =>
        root.render(
          <Moving box={{ left: 0, top: 0, width: 40, height: 20 }} />,
        ),
      );
      act(() =>
        root.render(
          <Moving box={{ left: 100, top: 0, width: 40, height: 20 }} />,
        ),
      );
      expect(animate).not.toHaveBeenCalled();
    } finally {
      if (matchMedia) Object.defineProperty(window, 'matchMedia', matchMedia);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });
});
