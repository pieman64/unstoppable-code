'use client';

import { useEffect, useState } from 'react';

/**
 * How long a loading placeholder waits before it shows, so answers that
 * arrive quickly never flash a skeleton or spinner. Shared by settings
 * placeholders and the web portal's hydration loaders.
 */
export const LOADING_PLACEHOLDER_DELAY_MS = 200;

/**
 * `true` once `value` has stayed `true` for `delayMs`. Goes back to `false`
 * as soon as `value` does, and a `value` that turns `false` inside the window
 * cancels the timer, so the flag never flips. Keep `delayMs` stable for a
 * mount: changing it while `value` is `true` restarts the wait.
 */
export function useDelayedFlag(value: boolean, delayMs: number): boolean {
  const [delayedValue, setDelayedValue] = useState(false);

  useEffect(() => {
    if (!value) {
      return undefined;
    }

    const timeout = setTimeout(() => setDelayedValue(true), delayMs);
    return (): void => {
      clearTimeout(timeout);
      // Reset from the cleanup (never synchronously in the effect body —
      // react-hooks/set-state-in-effect) so the next cycle waits out the
      // delay again instead of showing the placeholder instantly.
      setDelayedValue(false);
    };
  }, [delayMs, value]);

  return value && delayedValue;
}

/**
 * How long a load runs before one quiet line says what is slow. Before then
 * the skeleton alone says "loading"; after it, the line names what is still
 * on its way, so a stalled load never looks finished.
 */
export const SLOW_LOAD_NOTE_DELAY_MS = 8_000;

/**
 * Where a load stands, for a surface that shows nothing at first, then a
 * skeleton, then a note. `idle` is not loading; `pending` is loading but
 * still inside {@link LOADING_PLACEHOLDER_DELAY_MS}, so nothing shows yet;
 * `skeleton` shows the placeholder; `slow` adds the note after
 * {@link SLOW_LOAD_NOTE_DELAY_MS}.
 */
export type LoadingPhase = 'idle' | 'pending' | 'skeleton' | 'slow';

export interface LoadingPhaseOptions {
  /** Wait before the skeleton shows. Keep it stable for a mount. */
  readonly delayMs?: number;
  /** Wait, from the start of the load, before the note shows. */
  readonly slowAfterMs?: number;
}

/**
 * The {@link LoadingPhase} of a load that is running while `loading` is true.
 * Both clocks start when `loading` turns true and reset when it turns false.
 */
export function useLoadingPhase(
  loading: boolean,
  {
    delayMs = LOADING_PLACEHOLDER_DELAY_MS,
    slowAfterMs = SLOW_LOAD_NOTE_DELAY_MS,
  }: LoadingPhaseOptions = {},
): LoadingPhase {
  const skeleton = useDelayedFlag(loading, delayMs);
  const slow = useDelayedFlag(loading, slowAfterMs);
  if (!loading) return 'idle';
  if (slow) return 'slow';
  return skeleton ? 'skeleton' : 'pending';
}
