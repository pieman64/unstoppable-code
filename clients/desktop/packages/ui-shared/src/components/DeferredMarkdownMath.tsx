'use client';

import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type HTMLAttributes,
  type JSX,
} from 'react';
import type { MarkdownMathProps } from './MarkdownMath';
import type { MarkdownMathExpression } from './markdown-math';

interface MarkdownMathModule {
  readonly MarkdownMath: ComponentType<MarkdownMathProps>;
}

let markdownMathModulePromise: Promise<MarkdownMathModule> | null = null;

function loadMarkdownMathModule(): Promise<MarkdownMathModule> {
  markdownMathModulePromise ??= import('./MarkdownMath');
  return markdownMathModulePromise;
}

const LazyMarkdownMath = lazy(async () => {
  const module = await loadMarkdownMathModule();
  return { default: module.MarkdownMath };
});

const mathVisibilityCallbacks = new WeakMap<Element, () => void>();
let mathVisibilityObserver: IntersectionObserver | null = null;
const pendingMathRenders = new Set<() => void>();
let mathRenderScheduled = false;
let mathKeyboardListenerAttached = false;
let lastMathKeyboardInputAt = Number.NEGATIVE_INFINITY;

function trackMathKeyboardInput(): void {
  lastMathKeyboardInputAt = performance.now();
}

function ensureMathKeyboardTracking(): void {
  if (mathKeyboardListenerAttached || typeof document === 'undefined') return;
  document.addEventListener('keydown', trackMathKeyboardInput, {
    capture: true,
    passive: true,
  });
  mathKeyboardListenerAttached = true;
}

function stopMathKeyboardTracking(): void {
  if (!mathKeyboardListenerAttached || typeof document === 'undefined') return;
  document.removeEventListener('keydown', trackMathKeyboardInput, {
    capture: true,
  });
  mathKeyboardListenerAttached = false;
}

function scheduleNextMathRender(): void {
  if (mathRenderScheduled) return;
  if (pendingMathRenders.size === 0) {
    stopMathKeyboardTracking();
    return;
  }
  mathRenderScheduled = true;
  const schedule =
    typeof requestAnimationFrame === 'function'
      ? (callback: FrameRequestCallback): void => {
          requestAnimationFrame(callback);
        }
      : (callback: FrameRequestCallback): void => {
          globalThis.setTimeout(() => callback(performance.now()), 16);
        };
  schedule(() => {
    mathRenderScheduled = false;
    if (performance.now() - lastMathKeyboardInputAt < 120) {
      scheduleNextMathRender();
      return;
    }
    const nextCallback = pendingMathRenders.values().next();
    if (!nextCallback.done) {
      const callback: () => void = nextCallback.value;
      pendingMathRenders.delete(callback);
      callback();
    }
    scheduleNextMathRender();
  });
}

function enqueueLoadedMathRender(callback: () => void): () => void {
  ensureMathKeyboardTracking();
  pendingMathRenders.add(callback);
  scheduleNextMathRender();
  return () => pendingMathRenders.delete(callback);
}

function enqueueMathRender(callback: () => void): () => void {
  ensureMathKeyboardTracking();
  let cancelled = false;
  let cancelLoadedRender = (): void => undefined;
  void loadMarkdownMathModule().then(
    () => {
      if (!cancelled) {
        cancelLoadedRender = enqueueLoadedMathRender(callback);
      }
    },
    () => undefined,
  );
  return () => {
    cancelled = true;
    cancelLoadedRender();
  };
}

function observeMathVisibility(
  element: Element,
  onVisible: () => void,
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onVisible();
    return () => undefined;
  }
  mathVisibilityObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = mathVisibilityCallbacks.get(entry.target);
        if (!callback) continue;
        mathVisibilityCallbacks.delete(entry.target);
        mathVisibilityObserver?.unobserve(entry.target);
        callback();
      }
    },
    { rootMargin: '300px 0px' },
  );
  mathVisibilityCallbacks.set(element, onVisible);
  mathVisibilityObserver.observe(element);
  return () => {
    mathVisibilityCallbacks.delete(element);
    mathVisibilityObserver?.unobserve(element);
  };
}

function mathFallback(expression: MarkdownMathExpression): JSX.Element {
  return (
    <code
      className="canopy-markdown-math-loading"
      data-math-display={expression.display ? 'true' : 'false'}
    >
      {expression.source}
    </code>
  );
}

export interface DeferredMarkdownMathProps extends HTMLAttributes<HTMLSpanElement> {
  readonly expression: MarkdownMathExpression;
}

function DeferredMarkdownMathComponent({
  expression,
  className,
  style,
  ...containerProps
}: DeferredMarkdownMathProps): JSX.Element {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [shouldRender, setShouldRender] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || shouldRender) return;
    let cancelScheduledRender = (): void => undefined;
    const stopObserving = observeMathVisibility(element, () => {
      cancelScheduledRender = enqueueMathRender(() => setShouldRender(true));
    });
    return (): void => {
      stopObserving();
      cancelScheduledRender();
    };
  }, [shouldRender]);

  return (
    <span
      {...containerProps}
      ref={containerRef}
      className={
        className
          ? `canopy-markdown-math-container ${className}`
          : 'canopy-markdown-math-container'
      }
      data-math-display={expression.display ? 'true' : 'false'}
      style={{
        ...style,
        display: expression.display ? 'block' : 'inline',
      }}
    >
      {shouldRender ? (
        <Suspense fallback={mathFallback(expression)}>
          <LazyMarkdownMath
            source={expression.source}
            display={expression.display}
          />
        </Suspense>
      ) : (
        mathFallback(expression)
      )}
    </span>
  );
}

export const DeferredMarkdownMath = memo(DeferredMarkdownMathComponent);
