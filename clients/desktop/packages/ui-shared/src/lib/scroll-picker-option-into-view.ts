'use client';

import { useCallback, useRef } from 'react';

export type PickerOptionKeyAttribute = 'data-option-key' | 'data-option-id';

/**
 * Scroll a highlighted picker row into view after keyboard navigation or an
 * open-time restore. Pointer hover must not call this — `scrollIntoView` with
 * `block: 'nearest'` nudges the list when a row is only partially clipped,
 * which feels like a jump.
 */
export function scrollPickerOptionIntoView(
  listRoot: HTMLElement | null,
  optionKey: string,
  keyAttribute: PickerOptionKeyAttribute = 'data-option-key',
): void {
  if (!listRoot || optionKey.length === 0) return;
  const dataProperty =
    keyAttribute === 'data-option-key' ? 'optionKey' : 'optionId';
  for (const node of listRoot.querySelectorAll<HTMLElement>(
    `[${keyAttribute}]`,
  )) {
    if (node.dataset[dataProperty] === optionKey) {
      // jsdom does not implement scrollIntoView.
      node.scrollIntoView?.({ block: 'nearest' });
      return;
    }
  }
}

/**
 * Gates picker auto-scroll so only keyboard navigation and open-time restore
 * scroll the list; pointer hover updates the active row without jumping.
 *
 * Intents may name the row they want revealed. Open-time restore must: the
 * effect that scrolls is flushed in the same passive pass as the
 * `setActiveIndex` that restores the selection, so it first runs against the
 * stale active row. An untargeted intent would be consumed there and the
 * restored row would never scroll. A targeted intent is held until the
 * matching row is active. Keyboard navigation marks no target and reveals
 * whichever row lands next.
 */
export function usePickerActiveScrollIntent(): {
  markActiveOptionScrollIntent: (targetKey?: string) => void;
  clearActiveOptionScrollIntent: () => void;
  consumeActiveOptionScrollIntent: (activeKey?: string) => boolean;
} {
  const scrollIntentRef = useRef<{ targetKey: string | null } | null>(null);
  const markActiveOptionScrollIntent = useCallback(
    (targetKey?: string): void => {
      scrollIntentRef.current = { targetKey: targetKey ?? null };
    },
    [],
  );
  const clearActiveOptionScrollIntent = useCallback((): void => {
    scrollIntentRef.current = null;
  }, []);
  const consumeActiveOptionScrollIntent = useCallback(
    (activeKey?: string): boolean => {
      const intent = scrollIntentRef.current;
      if (!intent) return false;
      if (intent.targetKey !== null && intent.targetKey !== activeKey) {
        // Keep waiting for the row this intent was raised for.
        return false;
      }
      scrollIntentRef.current = null;
      return true;
    },
    [],
  );
  return {
    markActiveOptionScrollIntent,
    clearActiveOptionScrollIntent,
    consumeActiveOptionScrollIntent,
  };
}
