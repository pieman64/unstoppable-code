'use client';

import { useCallback, type RefCallback } from 'react';

/** Visible active indicators keep moving. Only visibility, document lifecycle
 * and the viewer's reduced-motion preference may pause them. */
interface Entry {
  element: HTMLElement;
  visible: boolean;
  cleanup(): void;
}
interface VisibilityController {
  add(element: HTMLElement, entry: Entry): () => void;
}
const documents = new WeakMap<Document, VisibilityController>();

function createVisibilityController(document: Document): VisibilityController {
  const entries = new Map<Element, Entry>();
  const view = document.defaultView;
  const motion = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const update = (): void => {
    for (const [element, entry] of entries) {
      if (element.ownerDocument !== document) {
        entry.cleanup();
        attach(entry.element, entry);
        continue;
      }
      const active = entry.visible && !document.hidden && !motion?.matches;
      const value = String(active);
      if (element.getAttribute('data-canopy-motion-active') !== value)
        element.setAttribute('data-canopy-motion-active', value);
    }
  };
  // Ref callbacks arrive in batches. Avoid scanning a large mounted list
  // once per ref; IntersectionObserver already batches visibility changes.
  let updatePending = false;
  const scheduleUpdate = (): void => {
    if (updatePending) return;
    updatePending = true;
    queueMicrotask(() => {
      updatePending = false;
      update();
    });
  };
  const observer = view?.IntersectionObserver
    ? new view.IntersectionObserver((changes) => {
        for (const change of changes) {
          const entry = entries.get(change.target);
          if (entry) entry.visible = change.isIntersecting;
        }
        update();
      })
    : null;
  // Adoption preserves React refs. Rebind after a subtree leaves this
  // document, even when neither window changes visibility.
  const adoptionObserver = view?.MutationObserver
    ? new view.MutationObserver((changes) => {
        if (changes.some((change) => change.removedNodes.length > 0)) update();
      })
    : null;
  adoptionObserver?.observe(document, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', update);
  motion?.addEventListener('change', update);
  return {
    add(element, entry) {
      entry.visible = observer === null;
      entries.set(element, entry);
      element.setAttribute('data-canopy-motion-active', 'false');
      observer?.observe(element);
      if (!observer) scheduleUpdate();
      return (): void => {
        observer?.unobserve(element);
        entries.delete(element);
        element.removeAttribute('data-canopy-motion-active');
        if (entries.size > 0) scheduleUpdate();
        else {
          observer?.disconnect();
          adoptionObserver?.disconnect();
          document.removeEventListener('visibilitychange', update);
          motion?.removeEventListener('change', update);
          documents.delete(document);
        }
      };
    },
  };
}

function attach(element: HTMLElement, entry: Entry): void {
  const document = element.ownerDocument;
  let controller = documents.get(document);
  if (!controller) {
    controller = createVisibilityController(document);
    documents.set(document, controller);
  }
  entry.cleanup = controller.add(element, entry);
}

/** Callback refs follow remounted spinner styles and StrictMode cleanup without
 * React renders on scroll, animation frames, or visibility changes. */
export function useContinuousMotion<T extends HTMLElement>(
  enabled = true,
): RefCallback<T> {
  return useCallback(
    (element) => {
      if (!element || !enabled) return;
      const entry: Entry = { element, visible: false, cleanup: () => {} };
      attach(element, entry);
      return (): void => entry.cleanup();
    },
    [enabled],
  );
}
