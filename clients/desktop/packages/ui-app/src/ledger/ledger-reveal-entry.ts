import { useCallback, useEffect, useRef } from 'react';

/** Frames to wait for an opened entry's row before settling for `fallback`. */
const REVEAL_FRAMES_MAX = 30;

function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(callback);
  } else {
    setTimeout(callback, 16);
  }
}

/**
 * Scrolls an Activity entry's row to the top of view once it renders, after a
 * control such as Open entry opens it there, so the jump always lands on the
 * entry. Falls back to `fallback` (the Activity section) when the row never
 * appears. Returns a cancel that stops a reveal still waiting for its row.
 */
export function revealLedgerEntryRow(
  container: HTMLElement | null,
  entryId: string,
  fallback: HTMLElement | null,
): () => void {
  let frames = 0;
  let cancelled = false;
  const attempt = (): void => {
    if (cancelled) return;
    const row = container?.querySelector<HTMLElement>(
      `[data-testid="ledger-entry-row"][data-entry-id="${entryId}"]`,
    );
    if (row !== null && row !== undefined) {
      row.scrollIntoView?.({ block: 'start' });
      return;
    }
    frames += 1;
    if (frames < REVEAL_FRAMES_MAX) {
      nextFrame(attempt);
      return;
    }
    fallback?.scrollIntoView?.({ block: 'start' });
  };
  nextFrame(attempt);
  return () => {
    cancelled = true;
  };
}

export type LedgerEntryReveal = (
  container: HTMLElement | null,
  entryId: string,
  fallback: HTMLElement | null,
) => void;

/**
 * Reveals entries one at a time: opening another entry drops a reveal still
 * waiting for its row, so its fallback never scrolls the newer entry away, and
 * unmounting drops it too.
 */
export function useLedgerEntryReveal(): LedgerEntryReveal {
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(
    () => (): void => {
      cancelRef.current?.();
    },
    [],
  );
  return useCallback((container, entryId, fallback) => {
    cancelRef.current?.();
    cancelRef.current = revealLedgerEntryRow(container, entryId, fallback);
  }, []);
}
