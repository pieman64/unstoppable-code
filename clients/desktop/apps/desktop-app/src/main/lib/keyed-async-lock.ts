/**
 * Promise-chain keyed async lock: operations for the same key run strictly in
 * FIFO order; different keys run independently. Shared by the chat-archive and
 * archived-container stores so the subtle release/cleanup sequencing lives in
 * exactly one place.
 */
export class KeyedAsyncLock {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.locks.get(key) ?? Promise.resolve();
    let releaseCurrent: () => void = () => {};
    const current = new Promise<void>((resolveCurrent) => {
      releaseCurrent = resolveCurrent;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.locks.set(key, queued);
    const ready = previous.catch(() => undefined);
    let removeAbortListener = (): void => {};
    try {
      if (signal) {
        await new Promise<void>((resolveReady, reject) => {
          const abort = (): void => {
            const reason: unknown = signal.reason;
            reject(
              reason instanceof Error
                ? reason
                : new Error('Queued operation cancelled.'),
            );
          };
          signal.addEventListener('abort', abort, { once: true });
          removeAbortListener = (): void =>
            signal.removeEventListener('abort', abort);
          void ready.then(resolveReady);
          if (signal.aborted) abort();
        });
        signal.throwIfAborted();
      } else await ready;
      // Cancellation withdraws queued work, never detaches an active commit.
      removeAbortListener();
      return await operation();
    } finally {
      removeAbortListener();
      releaseCurrent();
      // A cancelled waiter still follows its predecessor. Do not expose the
      // key as unlocked while that earlier operation remains active.
      void queued.then(() => {
        if (this.locks.get(key) === queued) this.locks.delete(key);
      });
    }
  }

  /** Resolves once every operation queued for `key` so far has settled. */
  async wait(key: string): Promise<void> {
    await this.locks.get(key)?.catch(() => undefined);
  }
}
