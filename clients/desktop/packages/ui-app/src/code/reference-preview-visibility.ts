'use client';

import { useEffect, type RefObject } from 'react';

interface VisibilityRealm {
  readonly observer: IntersectionObserver;
  readonly callbacks: Map<Element, (visible: boolean) => void>;
}

// One observer per window realm (main or popped-out), shared by every
// reference label of every provider.
const realms = new WeakMap<Window, VisibilityRealm>();

function observeVisibility(
  element: Element,
  onChange: (visible: boolean) => void,
): () => void {
  const view = element.ownerDocument.defaultView;
  if (!view || typeof view.IntersectionObserver !== 'function') {
    return () => undefined;
  }
  let realm = realms.get(view);
  if (!realm) {
    const callbacks = new Map<Element, (visible: boolean) => void>();
    realm = {
      callbacks,
      observer: new view.IntersectionObserver((entries) => {
        for (const entry of entries) {
          callbacks.get(entry.target)?.(entry.isIntersecting);
        }
      }),
    };
    realms.set(view, realm);
  }
  const { observer, callbacks } = realm;
  callbacks.set(element, onChange);
  observer.observe(element);
  return () => {
    callbacks.delete(element);
    observer.unobserve(element);
  };
}

/**
 * Hold `watch(target)` while the element is on screen and release it when it
 * leaves. A new `epoch` (an identity reset dropped every registration)
 * registers again.
 */
export function useWatchWhileVisible<T>(
  ref: RefObject<HTMLElement | null>,
  watch: (target: T) => () => void,
  target: T,
  epoch: number,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const element = ref.current;
    if (!element) return undefined;
    let release: (() => void) | null = null;
    const stop = observeVisibility(element, (visible) => {
      if (visible) {
        release ??= watch(target);
      } else {
        release?.();
        release = null;
      }
    });
    return (): void => {
      stop();
      release?.();
    };
  }, [enabled, epoch, ref, target, watch]);
}
