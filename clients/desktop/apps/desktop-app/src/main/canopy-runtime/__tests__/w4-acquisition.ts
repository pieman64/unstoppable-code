// Late releases outlive their scope and its caller, so teardown hooks settle
// them here via settleW4LateReleases().
const lateReleases = new Set<Promise<void>>();
const lateFailures: Error[] = [];

/**
 * Records cleanup that no caller awaits because `primary` already ended the
 * work it belongs to; settleW4LateReleases() reports its failure.
 */
export function trackW4LateCleanup(
  cleanup: Promise<unknown>,
  primary: unknown,
): void {
  const reason = primary instanceof Error ? primary.message : String(primary);
  const settled = cleanup
    .then(
      () => undefined,
      (failure: unknown) => {
        lateFailures.push(
          new Error(`W4 late release after "${reason}" failed.`, {
            cause: failure,
          }),
        );
      },
    )
    .finally(() => lateReleases.delete(settled));
  lateReleases.add(settled);
}

function trackLateRelease<T>(
  work: Promise<T>,
  release: (value: T) => Promise<void> | void,
  primary: unknown,
): void {
  trackW4LateCleanup(
    work.then(release, () => undefined),
    primary,
  );
}

/** Test-host ownership, including acquisitions that finish after cancellation. */
export class W4Resources {
  readonly controller = new AbortController();
  private releases: Array<() => Promise<void> | void> = [];
  private closing?: Promise<void>;
  private stopped = false;

  async own<T>(
    value: T,
    release: (value: T) => Promise<void> | void,
  ): Promise<T> {
    if (this.stopped) {
      const reason: unknown = this.controller.signal.reason;
      const error =
        reason instanceof Error
          ? reason
          : new Error('W4 resources closed.', { cause: reason });
      try {
        await release(value);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'W4 late acquisition cleanup failed',
        );
      }
      throw error;
    }
    this.releases.push(() => release(value));
    return value;
  }

  async acquire<T>(
    work: Promise<T>,
    release: (value: T) => Promise<void> | void,
  ): Promise<T> {
    const { signal } = this.controller;
    let abort = (): void => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = (): void =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('W4 setup aborted.', { cause: signal.reason }),
        );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    let value: T;
    try {
      value = await Promise.race([work, cancelled]);
    } catch (error) {
      trackLateRelease(work, release, error);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
    return this.own(value, release);
  }

  cancel(
    reason: unknown = new Error('W4 host stopped during setup.'),
  ): Promise<void> {
    this.controller.abort(reason);
    return this.close();
  }

  async fail(error: unknown, label: string): Promise<never> {
    try {
      await this.close();
    } catch (cleanup) {
      if (error !== cleanup) throw new AggregateError([error, cleanup], label);
    }
    throw error;
  }

  close(): Promise<void> {
    this.stopped = true;
    return (this.closing ??= (async (): Promise<void> => {
      const errors: unknown[] = [];
      for (const release of this.releases.splice(0).reverse()) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      this.controller.abort();
      if (errors.length) throw new AggregateError(errors, 'W4 cleanup failed');
    })());
  }
}

export async function acquireW4Within<T>(
  work: Promise<T>,
  release: (value: T) => Promise<void> | void,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  const scope = new W4Resources();
  const timer = setTimeout(() => {
    void scope.cancel(new Error(`Timed out: ${label}`)).catch(() => undefined);
  }, timeoutMs);
  try {
    return await scope.acquire(work, release);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits a bounded time for releases of acquisitions that finished after their
 * scope was cancelled, then reports and clears every failed or pending one.
 */
export async function settleW4LateReleases(timeoutMs = 2_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    // A release may itself be cancelled late, so loop until none are left.
    while (lateReleases.size) {
      const drained = Promise.all(lateReleases).then(() => true);
      if (!(await Promise.race([drained, expired.then(() => false)]))) break;
    }
  } finally {
    clearTimeout(timer);
  }
  const errors: Error[] = lateFailures.splice(0);
  if (lateReleases.size) {
    errors.push(
      new Error(
        `${lateReleases.size} W4 late release(s) still pending after ${timeoutMs}ms.`,
      ),
    );
    // Reported once; their eventual failures still surface at a later settle.
    lateReleases.clear();
  }
  if (errors.length)
    throw new AggregateError(errors, 'W4 late acquisition cleanup failed');
}

export function w4Gate<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
