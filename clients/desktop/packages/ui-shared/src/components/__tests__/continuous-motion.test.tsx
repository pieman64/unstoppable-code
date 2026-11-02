/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThinkingSpinner } from '../ThinkingSpinner';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('continuous status motion visibility', () => {
  let host: HTMLDivElement;
  let root: Root;
  let callback: IntersectionObserverCallback | undefined;
  const observers = new Set<IntersectionObserver>();
  const originalMatchMedia = Object.getOwnPropertyDescriptor(
    window,
    'matchMedia',
  );
  const observed = new Set<Element>();
  const originalObserver = globalThis.IntersectionObserver;
  let reduced = false;
  const mediaListeners = new Set<() => void>();
  const visible = (
    target: Element,
    isIntersecting: boolean,
  ): IntersectionObserverEntry => ({
    target,
    isIntersecting,
    intersectionRatio: isIntersecting ? 1 : 0,
    boundingClientRect: target.getBoundingClientRect(),
    intersectionRect: target.getBoundingClientRect(),
    rootBounds: null,
    time: 0,
  });
  class Observer implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly scrollMargin = '0px';
    readonly thresholds = [0];
    constructor(cb: IntersectionObserverCallback) {
      callback = cb;
      observers.add(this);
    }
    observe(target: Element): void {
      observed.add(target);
    }
    unobserve(target: Element): void {
      observed.delete(target);
    }
    disconnect(): void {
      observed.clear();
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  beforeEach(() => {
    reduced = false;
    observers.clear();
    observed.clear();
    mediaListeners.clear();
    globalThis.IntersectionObserver = Observer;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (): {
        readonly matches: boolean;
        addEventListener(name: string, listener: () => void): void;
        removeEventListener(name: string, listener: () => void): void;
      } => ({
        get matches(): boolean {
          return reduced;
        },
        addEventListener: (_name: string, listener: () => void): void => {
          mediaListeners.add(listener);
        },
        removeEventListener: (_name: string, listener: () => void): void => {
          mediaListeners.delete(listener);
        },
      }),
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    globalThis.IntersectionObserver = originalObserver;
    if (originalMatchMedia)
      Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    else Reflect.deleteProperty(window, 'matchMedia');
  });
  function render(children: JSX.Element): void {
    act(() => root.render(children));
  }
  function active(): number {
    return host.querySelectorAll('[data-canopy-motion-active="true"]').length;
  }
  it('animates every visible indicator and pauses only indicators leaving the viewport', () => {
    render(
      <>
        {Array.from({ length: 100 }, (_, i) => (
          <ThinkingSpinner key={i} />
        ))}
      </>,
    );
    const cb = callback;
    const currentObserver = Array.from(observers)[0];
    if (!cb || !currentObserver)
      throw new Error('No production visibility observer');
    cb?.(
      Array.from(observed).map((target) => visible(target, true)),
      currentObserver,
    );
    expect(host.querySelectorAll('[aria-label="Thinking"]')).toHaveLength(100);
    expect(active()).toBe(100);
    const first = Array.from(observed)[0];
    if (!first) throw new Error('No observed spinner');
    cb([visible(first, false)], currentObserver);
    expect(first.getAttribute('data-canopy-motion-active')).toBe('false');
    expect(active()).toBe(99);
  });
  it('stops motion when reduced motion changes without removing running state', () => {
    render(<ThinkingSpinner />);
    const cb = callback;
    const currentObserver = Array.from(observers)[0];
    if (!cb || !currentObserver)
      throw new Error('No production visibility observer');
    cb?.(
      Array.from(observed).map((target) => visible(target, true)),
      currentObserver,
    );
    expect(active()).toBe(1);
    reduced = true;
    mediaListeners.forEach((listener) => listener());
    expect(active()).toBe(0);
    expect(host.querySelector('[aria-label="Thinking"]')).not.toBeNull();
    reduced = false;
    mediaListeners.forEach((listener) => listener());
    expect(active()).toBe(1);
  });
  it('stops motion in a background document and cleans up on unmount', () => {
    render(
      <>
        <ThinkingSpinner />
        <ThinkingSpinner />
      </>,
    );
    const cb = callback;
    const currentObserver = Array.from(observers)[0];
    if (!cb || !currentObserver)
      throw new Error('No production visibility observer');
    cb?.(
      Array.from(observed).map((target) => visible(target, true)),
      currentObserver,
    );
    expect(active()).toBe(2);
    const hidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    try {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(active()).toBe(0);
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        value: false,
      });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(active()).toBe(2);
      render(<div />);
      expect(observed.size).toBe(0);
      expect(mediaListeners.size).toBe(0);
    } finally {
      if (hidden) Object.defineProperty(document, 'hidden', hidden);
      else Reflect.deleteProperty(document, 'hidden');
    }
  });
  it('follows an adopted indicator into its new document without remounting', async () => {
    render(<ThinkingSpinner />);
    const cb = callback;
    const observer = Array.from(observers)[0];
    const spinner = host.querySelector('[aria-label="Thinking"]');
    if (!cb || !observer || !spinner) throw new Error('Missing spinner');
    cb([visible(spinner, true)], observer);
    const destination = document.implementation.createHTMLDocument();
    Object.defineProperty(destination, 'hidden', {
      configurable: true,
      value: false,
    });
    destination.body.append(destination.adoptNode(host));
    const hidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    try {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      expect(spinner.ownerDocument).toBe(destination);
      expect(spinner.getAttribute('data-canopy-motion-active')).toBe('true');
      Object.defineProperty(destination, 'hidden', {
        configurable: true,
        value: true,
      });
      destination.dispatchEvent(new Event('visibilitychange'));
      expect(spinner.getAttribute('data-canopy-motion-active')).toBe('false');
      Object.defineProperty(destination, 'hidden', {
        configurable: true,
        value: false,
      });
      destination.dispatchEvent(new Event('visibilitychange'));
      expect(spinner.getAttribute('data-canopy-motion-active')).toBe('true');
      render(<div />);
      expect(spinner.hasAttribute('data-canopy-motion-active')).toBe(false);
    } finally {
      if (hidden) Object.defineProperty(document, 'hidden', hidden);
      else Reflect.deleteProperty(document, 'hidden');
    }
  });
});
