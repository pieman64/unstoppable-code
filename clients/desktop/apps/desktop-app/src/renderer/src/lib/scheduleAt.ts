/** `setTimeout` treats any delay above this (≈24.8 days) as 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Run `callback` once the wall clock reaches `at` (ms since epoch). Delays
 * beyond the timer limit are clamped and re-armed until `at` passes, so a far
 * reset never fires early. Returns a disposer that cancels the pending timer.
 */
export function scheduleAt(at: number, callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const remaining = at - Date.now();
    if (remaining <= 0) {
      timer = undefined;
      callback();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  timer = setTimeout(
    arm,
    Math.min(Math.max(at - Date.now(), 0), MAX_TIMER_DELAY_MS),
  );
  return (): void => {
    if (timer !== undefined) clearTimeout(timer);
  };
}
