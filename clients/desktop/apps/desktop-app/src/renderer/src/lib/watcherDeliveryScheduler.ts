/** Watcher deliveries the renderer runs at once, across every chat. */
export const WATCHER_DELIVERY_MAX_CONCURRENT = 4;
/**
 * How long one delivery may hold its chat and its global slot. Main waits up
 * to 30 minutes for the completion acknowledgement, so a timed-out delivery
 * reports its failure while main can still retry it.
 */
export const WATCHER_DELIVERY_TIMEOUT_MS = 5 * 60_000;

export class WatcherDeliveryTimeoutError extends Error {
  constructor() {
    super('Timed out delivering the watcher message.');
    this.name = 'WatcherDeliveryTimeoutError';
  }
}

export interface WatcherDeliverySchedulerOptions {
  maxConcurrent?: number;
  timeoutMs?: number;
}

/**
 * Settles with the delivery, or rejects once `timeoutMs` elapses. The
 * underlying send cannot be cancelled; a late result is ignored here, and
 * main-side delivery-id deduplication keeps a later retry from doubling it.
 */
export async function runWithWatcherDeliveryTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number = WATCHER_DELIVERY_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new WatcherDeliveryTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs watcher deliveries in order per destination chat, a bounded number at
 * once across chats, each within a timeout. A delivery stuck behind one busy
 * chat therefore never holds up another chat, and even a stuck chat frees its
 * lane and slot when the timeout elapses.
 */
export class WatcherDeliveryScheduler {
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly waiting: Array<() => void> = [];
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private active = 0;

  constructor(options: WatcherDeliverySchedulerOptions = {}) {
    this.maxConcurrent = Math.max(
      1,
      options.maxConcurrent ?? WATCHER_DELIVERY_MAX_CONCURRENT,
    );
    this.timeoutMs = options.timeoutMs ?? WATCHER_DELIVERY_TIMEOUT_MS;
  }

  schedule(laneKey: string, run: () => Promise<void>): Promise<void> {
    const previous = this.lanes.get(laneKey) ?? Promise.resolve();
    const result = previous.then(() => this.runInSlot(run));
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(laneKey, tail);
    void tail.then(() => {
      if (this.lanes.get(laneKey) === tail) this.lanes.delete(laneKey);
    });
    return result;
  }

  private async runInSlot(run: () => Promise<void>): Promise<void> {
    await this.acquire();
    try {
      await runWithWatcherDeliveryTimeout(run, this.timeoutMs);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(): void {
    // Hand the slot straight to the oldest waiter so the count never dips.
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}
