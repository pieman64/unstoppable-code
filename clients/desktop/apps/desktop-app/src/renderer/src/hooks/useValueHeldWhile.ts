import { useState } from 'react';

/**
 * Returns `value`, except that while `hold` is true it keeps returning the
 * value it had when the hold began, and takes the latest value once the hold
 * ends. Use it for a setting whose change would remount something holding
 * unsaved state, such as an open editor.
 */
export function useValueHeldWhile<T>(value: T, hold: boolean): T {
  const [held, setHeld] = useState(value);
  if (!hold && held !== value) {
    // Adjusting state during render: React re-renders at once with the new
    // value, before anything commits.
    setHeld(value);
    return value;
  }
  return hold ? held : value;
}
