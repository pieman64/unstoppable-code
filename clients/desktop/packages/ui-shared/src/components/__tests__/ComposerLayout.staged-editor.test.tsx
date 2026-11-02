/** @jest-environment jsdom */
import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useOneLineComposer } from '../ComposerLayout';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function Harness({
  text,
  stage = 'textarea',
}: {
  text: string;
  stage?: 'textarea' | 'slate';
}): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  const inline = useOneLineComposer({
    boxRef,
    hasDraftText: text.length > 0,
    draftRevision: text,
    measurementText: text,
    allowed: true,
    minTextWidth: 160,
  });
  return (
    <div ref={boxRef} data-testid="shell" data-inline={inline}>
      <span data-composer-inline-fixed />
      <div style={{ fontSize: '14px', lineHeight: '20px' }}>
        {stage === 'textarea' ? (
          <textarea
            data-testid="editable"
            style={{ fontSize: '14px', lineHeight: '20px' }}
          />
        ) : (
          <div
            contentEditable
            style={{ fontSize: '14px', lineHeight: '20px' }}
            data-slate-editor="true"
            data-testid="editable"
          />
        )}
      </div>
      <span data-composer-inline-fixed />
    </div>
  );
}

describe('staged composer measurement', () => {
  let container: HTMLDivElement;
  let root: Root;
  let width: number;
  let frames: Map<number, (time: number) => void>;
  let resizeCallbacks: ResizeObserverCallback[];
  let observed: Set<Element>;
  let disconnected: number;
  const originalResize = globalThis.ResizeObserver;

  beforeEach(() => {
    width = 400;
    frames = new Map();
    resizeCallbacks = [];
    observed = new Set();
    disconnected = 0;
    let nextFrame = 0;
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    Reflect.set(
      globalThis,
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback);
        }
        observe(element: Element): void {
          observed.add(element);
        }
        unobserve(element: Element): void {
          observed.delete(element);
        }
        disconnect(): void {
          disconnected += 1;
        }
      },
    );
    jest
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'shell' ? width : width - 104;
      });
    jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-composer-inline-fixed'))
          return new DOMRect(0, 0, 32, 32);
        if (this.style.visibility === 'hidden') {
          const slot = Number.parseFloat(this.style.width);
          return new DOMRect(
            0,
            0,
            slot,
            Math.max(
              1,
              Math.ceil(((this.textContent?.length ?? 0) * 7) / slot),
            ) * 20,
          );
        }
        return new DOMRect(0, 0, width, 20);
      });
    document.documentElement.style.fontSize = '16px';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.documentElement.style.fontSize = '';
    Reflect.set(globalThis, 'ResizeObserver', originalResize);
    jest.restoreAllMocks();
  });

  function render(
    text: string,
    stage: 'textarea' | 'slate' = 'textarea',
  ): void {
    act(() => root.render(<Harness text={text} stage={stage} />));
  }
  function inline(): string | undefined {
    return container.querySelector<HTMLElement>('[data-testid="shell"]')
      ?.dataset.inline;
  }
  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      const pending: Array<(time: number) => void> = Array.from(
        frames.values(),
      );
      frames.clear();
      for (const callback of pending) callback(0);
    });
  }
  function resize(): void {
    // The hook uses observer callbacks as invalidations, independent of entries.
    for (const callback of resizeCallbacks)
      Reflect.apply(callback, undefined, [[], {}]);
  }

  it('expands hard breaks and soft wraps, then returns at the inline width', () => {
    render('short');
    expect(inline()).toBe('true');
    const editable = container.querySelector('[data-testid="editable"]');
    render('a'.repeat(60));
    expect(inline()).toBe('false');
    expect(container.querySelector('[data-testid="editable"]')).toBe(editable);
    render('a'.repeat(45)); // Fits the expanded editor, but not its inline slot.
    expect(inline()).toBe('false');
    render('one\ntwo');
    expect(inline()).toBe('false');
    render('short');
    expect(inline()).toBe('true');
  });

  it('rebinds to Slate with an unchanged draft and disconnects the old editable', async () => {
    render('unchanged');
    const textarea = container.querySelector('textarea');
    expect(textarea && observed.has(textarea)).toBe(true);
    render('unchanged', 'slate');
    await flush();
    const slate = container.querySelector('[data-slate-editor]');
    expect(slate && observed.has(slate)).toBe(true);
    expect(textarea && observed.has(textarea)).toBe(false);
    expect(inline()).toBe('true');
    act(() => root.render(<div />));
    expect(disconnected).toBeGreaterThan(0);
  });

  it('recovers after hidden and narrow layouts and removes its inaccessible probe', async () => {
    width = 0;
    render('a'.repeat(60));
    expect(inline()).toBe('true');
    width = 400;
    act(() => resize());
    await flush();
    expect(inline()).toBe('false');
    width = 900;
    act(() => resize());
    await flush();
    expect(inline()).toBe('true');
    expect(document.body.querySelector('[aria-hidden="true"]')).not.toBeNull();
    act(() => root.render(<div />));
    expect(document.body.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(frames.size).toBe(0);
  });
});
