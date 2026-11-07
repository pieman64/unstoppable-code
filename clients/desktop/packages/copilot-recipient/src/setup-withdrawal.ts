/**
 * The canonical step-timeout wording, in a module with no heavy dependencies.
 *
 * It lives here rather than beside the Cursor runner because BOTH host runners
 * need it and the runner module statically imports the ESM-only ACP client, so
 * every caller that wanted just this sentence had to mock the whole graph — and
 * a mock is exactly how a divergent timeout sentence would go unnoticed.
 *
 * The subprocess path (`executor/step-runner.ts`, `executor/spawned-process.ts`)
 * already emits this form. The ACP client reports its own deadline as "ACP
 * prompt did not settle within its deadline", which reads as a provider fault
 * rather than the step simply exceeding the timeout its author declared; a
 * reader cannot tell a too-slow step from a broken one.
 */
export function stepTimedOutMessage(timeoutMs: number): string {
  return `Step timed out after ${timeoutMs / 60_000} minute(s)`;
}

/** Why a step stopped waiting for its own setup. */
export type WithdrawalReason = 'cancelled' | 'timeout';

export interface SetupWithdrawal {
  /** Aborted on caller cancellation or when the step's budget elapses. */
  readonly signal: AbortSignal;
  /** Set once withdrawn; distinguishes a user stop from an expired budget. */
  readonly reason: WithdrawalReason | undefined;
  /** True once this step should stop waiting for anything. */
  readonly withdrawn: boolean;
  /**
   * Races one setup step against withdrawal.
   *
   * Returns the sentinel when the step withdrew first. The abandoned work has
   * its rejection absorbed so a late failure cannot surface as an unhandled
   * rejection, and its late result can no longer influence the outcome.
   */
  race<T>(work: Promise<T>): Promise<T | typeof SETUP_WITHDRAWN>;
  /** Clears the timer and the caller-abort listener. Always call it. */
  release(): void;
}

/** Returned by `race` when the step withdrew before the work settled. */
export const SETUP_WITHDRAWN: unique symbol = Symbol('setup-withdrawn');

/**
 * Bounds a step's SETUP by its own deadline and its caller's cancellation.
 *
 * Checking the clock before and after an `await` is accounting, not
 * enforcement: a probe that never settles leaves the step pending however long
 * it takes, whatever budget was declared. This makes the step settle on time
 * even when the operation it is waiting on does not, and threads a signal into
 * operations that accept one so the work is cancelled rather than orphaned.
 */
export function createSetupWithdrawal(
  callerSignal: AbortSignal,
  remainingMs: number,
): SetupWithdrawal {
  const controller = new AbortController();
  const state: { reason: WithdrawalReason | undefined } = { reason: undefined };
  const onCallerAbort = (): void => {
    state.reason ??= 'cancelled';
    controller.abort();
  };
  if (callerSignal.aborted) onCallerAbort();
  else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (remainingMs <= 0) {
    state.reason ??= 'timeout';
    controller.abort();
  } else {
    timer = setTimeout(() => {
      state.reason ??= 'timeout';
      controller.abort();
    }, remainingMs);
  }
  /** Abort listeners currently attached by an in-flight `race`. */
  const attached = new Set<() => void>();
  return {
    signal: controller.signal,
    get reason(): WithdrawalReason | undefined {
      return state.reason;
    },
    get withdrawn(): boolean {
      return controller.signal.aborted;
    },
    async race<T>(work: Promise<T>): Promise<T | typeof SETUP_WITHDRAWN> {
      if (controller.signal.aborted) {
        void work.catch(() => undefined);
        return SETUP_WITHDRAWN;
      }
      // `{ once: true }` only detaches on abort. A race the WORK wins — or that
      // the work rejects — left its listener attached, so the contract's
      // "always released" claim was false: three completed races left three
      // listeners, and `release()` left them too. Every outcome detaches now.
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<typeof SETUP_WITHDRAWN>((resolve) => {
            onAbort = (): void => {
              void work.catch(() => undefined);
              resolve(SETUP_WITHDRAWN);
            };
            attached.add(onAbort);
            controller.signal.addEventListener('abort', onAbort, {
              once: true,
            });
          }),
        ]);
      } finally {
        if (onAbort) {
          controller.signal.removeEventListener('abort', onAbort);
          attached.delete(onAbort);
        }
      }
    },
    release(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      callerSignal.removeEventListener('abort', onCallerAbort);
      // A race still in flight when the caller releases (an exception on
      // another path, say) would otherwise keep its listener attached.
      attached.forEach((listener) => {
        controller.signal.removeEventListener('abort', listener);
      });
      attached.clear();
    },
  };
}
