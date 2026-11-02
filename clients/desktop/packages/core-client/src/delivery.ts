import { CanopyClientError, toCanopyClientError } from './errors';

/** Bounded defaults for every core connection; tests pin their effect. */
export const CANOPY_CONNECTION_DEFAULTS = Object.freeze({
  /** Connect, authenticate, and initialize, as one deadline. */
  connectTimeoutMs: 10_000,
  /** One delivery: every attempt and every wait between them. */
  deliveryTimeoutMs: 30_000,
  /** Backoff before the first retry, doubling up to `retryMaxDelayMs`. */
  retryInitialDelayMs: 1_000,
  retryMaxDelayMs: 8_000,
});

/** The directive a delivery may honor by sending the same call again. */
export type CanopyReplayDirective = 'same_request' | 'same_idempotency_key';

export interface CanopyDeliveryAttempt {
  /** 1 for the first send. */
  readonly attempt: number;
  /** Aborts on cancellation or when the delivery's deadline passes. */
  readonly signal: AbortSignal;
  /** Time left under the original deadline; nested deadlines use it, never a fresh one. */
  readonly remainingMs: () => number;
}

export interface CanopyDeliveryOptions<T> {
  /**
   * `same_request` resends the exact arguments; `same_idempotency_key` also
   * keeps the original key, so a lost reply returns the recorded outcome.
   * Any other directive ends delivery with the failure as it arrived.
   */
  readonly replay: CanopyReplayDirective;
  readonly signal?: AbortSignal;
  /** Defaults to `CANOPY_CONNECTION_DEFAULTS.deliveryTimeoutMs`. */
  readonly timeoutMs?: number;
  /**
   * False once the authority, account, or connection this delivery started on
   * is gone. Checked before each send and before a result is accepted; there
   * is no failover.
   */
  readonly current?: () => boolean;
  /** Failures the caller recovers itself; they end delivery unretried. */
  readonly isFinal?: (error: CanopyClientError) => boolean;
  /** Receives a result that arrived stale or after delivery ended. */
  readonly release?: (value: T) => void;
  /**
   * Adopts the result in the same turn as the last `current()` check, so
   * nothing can go stale between them. Code after `await` cannot promise that.
   */
  readonly accept?: (value: T) => void;
  /** Each failure that will be retried, before the wait. */
  readonly onRetry?: (error: CanopyClientError) => void;
}

const MAX_TIMER_MS = 2 ** 31 - 1;
/** Ended access or an explicit stop is never retried, whatever its directive. */
const NEVER_RETRIED = new Set([
  'cancelled',
  'unauthenticated',
  'permission_denied',
]);
const ignore = (): void => {};

function staleDestination(): CanopyClientError {
  return new CanopyClientError({
    kind: 'failed_precondition',
    message: 'The delivery destination changed.',
    retry: { kind: 'after_refresh', resource: 'destination' },
  });
}

export interface CanopyDeliveryScopeOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly messages?: { readonly cancelled: string; readonly timedOut: string };
}

/**
 * One deadline and cancellation for a unit of delivery. Its signal aborts
 * once, with the first of the caller's abort or the deadline.
 */
export class CanopyDeliveryScope {
  failure: CanopyClientError | undefined;
  /** The latest replayed failure: an expiry keeps its directive. */
  retried: CanopyClientError | undefined;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly failed: Promise<never> = new Promise((_, reject) =>
    this.signal.addEventListener(
      'abort',
      () => reject(toCanopyClientError(this.signal.reason)),
      { once: true },
    ),
  );
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly messages: NonNullable<
    CanopyDeliveryScopeOptions['messages']
  >;
  private readonly onAbort = (): void =>
    this.fail(
      new CanopyClientError({
        kind: 'cancelled',
        message: this.messages.cancelled,
        retry: { kind: 'never' },
      }),
    );

  constructor(private readonly options: CanopyDeliveryScopeOptions) {
    this.failed.catch(ignore);
    this.messages = options.messages ?? {
      cancelled: 'Delivery was cancelled.',
      timedOut: 'Delivery timed out.',
    };
    // Clamped so the one timer is the deadline.
    const timeoutMs = Math.min(options.timeoutMs, MAX_TIMER_MS);
    this.expiresAt = performance.now() + timeoutMs;
    this.timer = setTimeout(() => this.expire(), timeoutMs);
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    if (options.signal?.aborted) this.onAbort();
  }

  /** Whole milliseconds left; expires the scope once none remain. */
  remainingMs(): number {
    const remaining = Math.ceil(this.expiresAt - performance.now());
    if (remaining < 1) this.expire();
    return Math.max(0, remaining);
  }

  /** Throws the scope's failure once it has one. */
  check(): void {
    if (this.failure) throw this.failure;
  }

  /** Settles with `work` unless the scope ends first; a late value goes to `release`. */
  async guard<T>(work: Promise<T>, release: (value: T) => void): Promise<T> {
    let value: T;
    try {
      value = await Promise.race([work, this.failed]);
    } catch (error) {
      this.remainingMs();
      if (this.failure) void work.then(release, ignore);
      throw this.failure ?? error;
    }
    // A starved timer must not admit a result that settled past the deadline.
    this.remainingMs();
    if (!this.failure) return value;
    release(value);
    throw this.failure;
  }

  wait(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.min(ms, MAX_TIMER_MS));
    });
    return this.guard(elapsed, ignore).finally(() => clearTimeout(timer));
  }

  expire(): void {
    this.fail(
      new CanopyClientError({
        kind: 'deadline_exceeded',
        message: this.messages.timedOut,
        // The last attempt's outcome is still unknown; keep how to recover it.
        retry: this.retried?.payload.retry ?? { kind: 'never' },
      }),
    );
  }

  fail(error: CanopyClientError): void {
    if (this.failure) return;
    this.failure = error;
    this.controller.abort(error);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener('abort', this.onAbort);
  }
}

/** The wait before replaying `failure`, or null when it ends delivery. */
function replayDelayMs(
  failure: CanopyClientError,
  replay: CanopyReplayDirective,
  attempt: number,
): number | null {
  const { kind, retry } = failure.payload;
  if (retry.kind !== replay || NEVER_RETRIED.has(kind)) return null;
  const { retryInitialDelayMs, retryMaxDelayMs } = CANOPY_CONNECTION_DEFAULTS;
  const backoff = retryInitialDelayMs * 2 ** (attempt - 1);
  return Math.max(retry.delayMs ?? 0, Math.min(retryMaxDelayMs, backoff));
}

function notify(
  onRetry: ((error: CanopyClientError) => void) | undefined,
  failure: CanopyClientError,
): void {
  try {
    onRetry?.(failure);
  } catch {
    // A throwing observer must not change delivery.
  }
}

/**
 * Sends `run` until it succeeds, retrying only failures whose directive is
 * `replay`, with exponential backoff (a directive's `delayMs` is a floor),
 * all within one deadline. `run` must address the same destination with the
 * same operation and arguments every time. It stops on cancellation, revoked
 * access, a stale destination, or a wait that would pass the deadline.
 */
export async function deliverCanopy<T>(
  run: (attempt: CanopyDeliveryAttempt) => Promise<T>,
  options: CanopyDeliveryOptions<T>,
): Promise<T> {
  const {
    current = (): boolean => true,
    isFinal = (): boolean => false,
    release = ignore,
  } = options;
  const scope = new CanopyDeliveryScope({
    timeoutMs:
      options.timeoutMs ?? CANOPY_CONNECTION_DEFAULTS.deliveryTimeoutMs,
    signal: options.signal,
  });
  const { signal } = scope;
  const remainingMs = (): number => scope.remainingMs();
  try {
    for (let attempt = 1; ; attempt += 1) {
      scope.check();
      if (!current()) throw staleDestination();
      let outcome: { value: T } | { failure: CanopyClientError };
      try {
        const work = run({ attempt, signal, remainingMs });
        outcome = { value: await scope.guard(work, release) };
      } catch (error) {
        outcome = { failure: toCanopyClientError(error) };
      }
      scope.check();
      if (!current()) {
        if ('value' in outcome) release(outcome.value);
        throw staleDestination();
      }
      if ('value' in outcome) {
        // Detached first: aborts during or after adoption leave the attempt alone.
        scope.dispose();
        options.accept?.(outcome.value);
        return outcome.value;
      }
      const { failure } = outcome;
      const delay = isFinal(failure)
        ? null
        : replayDelayMs(failure, options.replay, attempt);
      if (delay === null) throw failure;
      scope.retried = failure;
      if (delay >= remainingMs()) scope.expire();
      scope.check();
      notify(options.onRetry, failure);
      await scope.wait(delay);
    }
  } finally {
    scope.dispose();
  }
}
