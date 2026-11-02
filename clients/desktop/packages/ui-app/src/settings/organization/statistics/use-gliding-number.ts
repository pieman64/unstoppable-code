'use client';
import { useEffect, useRef, useState } from 'react';

/** How long the turn counter takes to glide to a new poll's value. */
const PROGRESS_GLIDE_MS = 900;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Eases from the value on screen to `target` whenever it changes, so each
 * poll's jump reads as steady progress. Jumps straight there when the
 * viewer prefers reduced motion.
 */
export function useGlidingNumber(target: number): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    const origin = shownRef.current;
    if (origin === target) return;
    const show = (value: number): void => {
      const rounded = Math.round(value);
      if (rounded === shownRef.current) return;
      shownRef.current = rounded;
      setShown(rounded);
    };
    if (prefersReducedMotion()) {
      show(target);
      return;
    }
    let frame = 0;
    let startedAt: number | null = null;
    let lastPaint = -Infinity;
    const step = (now: number): void => {
      startedAt ??= now;
      const t = Math.min(1, (now - startedAt) / PROGRESS_GLIDE_MS);
      // Polling progress needs readable numbers, not a React commit on every
      // display refresh. Keep the same curve and exact terminal count.
      if (t === 1 || now - lastPaint >= 1000 / 30) {
        show(origin + (target - origin) * (1 - (1 - t) ** 3));
        lastPaint = now;
      }
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return (): void => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}
