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
