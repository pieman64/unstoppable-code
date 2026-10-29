/**
 * Small trailing-edge throttle: invokes `fn` immediately on the first call
 * (leading edge), then coalesces any subsequent calls that arrive before
 * `waitMs` has elapsed into a single trailing call once the window closes.
 * This guarantees the final invocation's arguments always land, even if
 * calls stop arriving mid-window.
 *
 * Used to coalesce `useSidebarStore` subscription notifications during a
 * width-drag (which fires once per `mousemove`) down to roughly one
 * recompute per `waitMs`. A 100ms window was chosen over a
 * `requestAnimationFrame`-per-frame batch because it is simpler to reason
 * about and unit-test deterministically with fake timers, while still
 * comfortably capping recompute frequency well below native `mousemove`
 * rates (which can fire far more often than every 100ms during a fast drag).
 */
export interface ThrottledFn<Args extends unknown[]> {
  (...args: Args): void;
  /** Cancels any pending trailing call. Does not fire it. */
  cancel: () => void;
}

export function throttleTrailing<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): ThrottledFn<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastCallTime: number | null = null;
  let pendingArgs: Args | null = null;

  const invoke = (args: Args): void => {
    lastCallTime = Date.now();
    fn(...args);
  };

  const call = (...args: Args): void => {
    const now = Date.now();
    if (lastCallTime === null || now - lastCallTime >= waitMs) {
      // Leading edge: nothing scheduled yet in this window, run now.
      pendingArgs = null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      invoke(args);
      return;
    }

    // Within the throttle window: remember the latest args and schedule a
    // trailing call for when the window closes, unless one is already
    // pending.
    pendingArgs = args;
    if (timer !== null) {
      return;
    }
    const remaining = waitMs - (now - lastCallTime);
    timer = setTimeout(
      () => {
        timer = null;
        if (pendingArgs !== null) {
          const argsToRun = pendingArgs;
          pendingArgs = null;
          invoke(argsToRun);
        }
      },
      Math.max(0, remaining),
    );
  };

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pendingArgs = null;
  };

  const throttled: ThrottledFn<Args> = Object.assign(call, { cancel });
  return throttled;
}
