'use client';

import { useEffect, useState, type RefObject } from 'react';

/** Visibility and IME state for a mounted composer, including hidden hosts. */
export function useComposerHintActivity(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): { active: boolean; composing: boolean } {
  const [visible, setVisible] = useState(false);
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) {
      setComposing(false);
      setVisible(false);
      return;
    }
    const update = (): void =>
      setVisible(enabled && node.getClientRects().length > 0);
    const start = (): void => setComposing(true);
    const end = (): void => setComposing(false);
    node.addEventListener('compositionstart', start, true);
    node.addEventListener('compositionend', end, true);
    const observer = new MutationObserver(update);
    for (
      let ancestor: HTMLElement | null = node;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (enabled)
        observer.observe(ancestor, {
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden'],
        });
    }
    const resize =
      !enabled || typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(update);
    resize?.observe(node);
    update();
    return (): void => {
      observer.disconnect();
      resize?.disconnect();
      node.removeEventListener('compositionstart', start, true);
      node.removeEventListener('compositionend', end, true);
    };
  }, [ref, enabled]);
  return { active: enabled && visible, composing };
}
