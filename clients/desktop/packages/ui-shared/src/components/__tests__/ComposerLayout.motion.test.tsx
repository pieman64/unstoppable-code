/** @jest-environment jsdom */
import { act, useRef, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { useAnimatedComposerBox } from '../ComposerLayout';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

it('animates composer height and corners between capsule and full shapes', () => {
  let resized: ResizeObserverCallback | undefined;
  const resize = globalThis.ResizeObserver;
  class Observer implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resized = callback;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = Observer;
  const animate = jest
    .fn()
    .mockReturnValue({ cancel: jest.fn(), onfinish: null });
  const previousAnimate = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'animate',
  );
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: animate,
  });
  const rect = jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, 300, Number.parseFloat(this.style.height));
    });
  function Shell(): JSX.Element {
    const ref = useRef<HTMLDivElement>(null);
    useAnimatedComposerBox(ref);
    return <div ref={ref} style={{ height: 48, borderTopLeftRadius: 24 }} />;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Shell />));
    const box = host.querySelector('div');
    if (!box) throw new Error('Missing shell');
    box.style.height = '140px';
    box.style.borderTopLeftRadius = '16px';
    const notify = resized;
    const notifySize = (height: number): void => {
      const size = { inlineSize: 300, blockSize: height };
      const entry: ResizeObserverEntry = {
        target: box,
        borderBoxSize: [size],
        contentBoxSize: [size],
        devicePixelContentBoxSize: [size],
        contentRect: new DOMRect(0, 0, 300, height),
      };
      act(() => notify?.([entry], new Observer(() => {})));
    };
    rect.mockClear();
    notifySize(140);
    expect(rect).not.toHaveBeenCalled();
    expect(box.getBoundingClientRect().height).toBe(140);
    expect(animate).toHaveBeenCalledWith(
      [
        { height: '48px', borderRadius: '24px', overflow: 'hidden' },
        { height: '140px', borderRadius: '16px', overflow: 'hidden' },
      ],
      expect.objectContaining({ duration: 200 }),
    );
    // Additional lines within the full shape keep up with typing immediately.
    box.style.height = '170px';
    notifySize(170);
    expect(animate).toHaveBeenCalledTimes(1);
    // Width-only observations need neither a new height read nor an animation.
    rect.mockClear();
    notifySize(170);
    expect(rect).not.toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(1);
    // Clearing the draft animates back from its current full height.
    box.style.height = '48px';
    box.style.borderTopLeftRadius = '24px';
    notifySize(48);
    expect(animate).toHaveBeenLastCalledWith(
      [
        { height: '170px', borderRadius: '16px', overflow: 'hidden' },
        { height: '48px', borderRadius: '24px', overflow: 'hidden' },
      ],
      expect.objectContaining({ duration: 200 }),
    );
  } finally {
    act(() => root.unmount());
    host.remove();
    rect.mockRestore();
    globalThis.ResizeObserver = resize;
    if (previousAnimate)
      Object.defineProperty(HTMLElement.prototype, 'animate', previousAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  }
});
