import { useEffect, useState } from 'react';

/**
 * Returns a `Date` that advances once per minute, aligned to the minute
 * boundary so the now-line jumps exactly when the wall clock ticks over.
 *
 * Initialized synchronously to `new Date()` so the first paint is already
 * correct. The interval is cleared on unmount.
 *
 * IMPORTANT: this value drives only the red now-indicator. It must NOT feed the
 * occurrence `useMemo` — keying expansion on `now` would re-enumerate every
 * minute. Callers key that memo on the window times instead.
 */
export function useNowTick(): Date {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    const timeoutId = setTimeout(() => {
      setNow(new Date());
      intervalId = setInterval(() => {
        setNow(new Date());
      }, 60_000);
    }, msUntilNextMinute);

    return (): void => {
      clearTimeout(timeoutId);
      if (intervalId !== undefined) {
        clearInterval(intervalId);
      }
    };
  }, []);

  return now;
}
