/** An outcome classification supplied by the service after each completed read. */
export type ClaudeUsageFetchGateOutcome =
  | { status: 'success' }
  | {
      status: 'failure';
      rateLimited?: boolean;
      retryAfter?: string | null;
    };

/** Result returned for a skipped, deferred, or completed usage read. */
export type ClaudeUsageFetchGateResult<T> =
  | { kind: 'fresh'; lastSuccessAt: number }
  | { kind: 'cooldown'; retryAt: number }
  | { kind: 'completed'; value: T; startedAt: number; retryAt?: number };

/** Injectable time and randomness sources for deterministic gate tests. */
export interface ClaudeUsageFetchGateOptions {
  now?: () => number;
  random?: () => number;
  onRateLimited?: (cooldown: { retryAt: number; cooldownMs: number }) => void;
}

interface AccountTiming<T> {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  inFlight: Promise<ClaudeUsageFetchGateResult<T>> | null;
  retryAt: number | null;
  consecutive429Count: number;
}

const MIN_RETRY_DELAY_MS = 10_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;
const FALLBACK_RETRY_BASE_MS = 60 * 1_000;
const FALLBACK_RETRY_MAX_MS = 15 * 60 * 1_000;
const HTTP_DATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Per-account single-flight, freshness, and rate-limit timing for Claude usage.
 *
 * This class intentionally retains only timing metadata and the in-flight read;
 * the caller remains the sole owner of the canonical usage summary.
 */
export class ClaudeUsageFetchGate<T> {
  private readonly accounts = new Map<string | null, AccountTiming<T>>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onRateLimited: ClaudeUsageFetchGateOptions['onRateLimited'];

  public constructor(options: ClaudeUsageFetchGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.onRateLimited = options.onRateLimited;
  }

  /**
   * Join an existing read, report a cooldown or fresh successful read, or start
   * one read for `accountKey`. A `null` key is one shared accountless group.
   */
  public run(
    accountKey: string | null,
    freshnessMs: number,
    read: () => Promise<T>,
    outcome: (result: T) => ClaudeUsageFetchGateOutcome,
  ): Promise<ClaudeUsageFetchGateResult<T>> {
    const account = this.getAccountTiming(accountKey);
    if (account.inFlight !== null) {
      return account.inFlight;
    }

    const now = this.now();
    if (account.retryAt !== null && now < account.retryAt) {
      return Promise.resolve({ kind: 'cooldown', retryAt: account.retryAt });
    }

    const lastSuccessAt = account.lastSuccessAt;
    if (
      lastSuccessAt !== null &&
      account.lastAttemptAt !== null &&
      account.lastAttemptAt <= lastSuccessAt &&
      this.isFresh(lastSuccessAt, now, freshnessMs)
    ) {
      return Promise.resolve({ kind: 'fresh', lastSuccessAt });
    }

    account.retryAt = null;
    const startedAt = now;
    account.lastAttemptAt = startedAt;

    const operation: Promise<ClaudeUsageFetchGateResult<T>> = Promise.resolve()
      .then(read)
      .then((value): ClaudeUsageFetchGateResult<T> => {
        const completedAt = Math.max(this.now(), startedAt);
        const readOutcome = outcome(value);

        if (readOutcome.status === 'success') {
          account.lastSuccessAt = completedAt;
          account.retryAt = null;
          account.consecutive429Count = 0;
          return { kind: 'completed', value, startedAt };
        }

        this.markLatestAttemptFailed(account, startedAt);
        if (readOutcome.rateLimited === true) {
          account.consecutive429Count += 1;
          const retryAt = this.getRetryAt(
            readOutcome.retryAfter,
            completedAt,
            account.consecutive429Count,
          );
          account.retryAt = retryAt;
          this.onRateLimited?.({ retryAt, cooldownMs: retryAt - completedAt });
          return { kind: 'completed', value, startedAt, retryAt };
        }

        return { kind: 'completed', value, startedAt };
      })
      .catch((error: unknown): never => {
        this.markLatestAttemptFailed(account, startedAt);
        throw error;
      })
      .finally((): void => {
        if (account.inFlight === operation) {
          account.inFlight = null;
        }
      });
    account.inFlight = operation;
    return operation;
  }

  private getAccountTiming(accountKey: string | null): AccountTiming<T> {
    const existing = this.accounts.get(accountKey);
    if (existing !== undefined) {
      return existing;
    }

    const created: AccountTiming<T> = {
      lastSuccessAt: null,
      lastAttemptAt: null,
      inFlight: null,
      retryAt: null,
      consecutive429Count: 0,
    };
    this.accounts.set(accountKey, created);
    return created;
  }

  private markLatestAttemptFailed(
    account: AccountTiming<T>,
    startedAt: number,
  ): void {
    const lastSuccessAt = account.lastSuccessAt;
    account.lastAttemptAt =
      lastSuccessAt !== null && startedAt <= lastSuccessAt
        ? lastSuccessAt + 1
        : startedAt;
  }

  private isFresh(
    lastSuccessAt: number,
    now: number,
    freshnessMs: number,
  ): boolean {
    if (lastSuccessAt === null || freshnessMs <= 0) {
      return false;
    }

    const ageMs = now - lastSuccessAt;
    return ageMs >= 0 && ageMs < freshnessMs;
  }

  private getRetryAt(
    retryAfter: string | null | undefined,
    now: number,
    consecutive429Count: number,
  ): number {
    const providerRetryAt = parseRetryAfter(retryAfter, now);
    if (providerRetryAt !== null) {
      return providerRetryAt;
    }

    return now + this.getFallbackRetryDelay(consecutive429Count);
  }

  private getFallbackRetryDelay(consecutive429Count: number): number {
    const exponent = Math.max(0, Math.min(consecutive429Count - 1, 52));
    const baseDelayMs = FALLBACK_RETRY_BASE_MS * 2 ** exponent;
    const randomValue = this.random();
    const normalizedRandom = Number.isFinite(randomValue)
      ? Math.min(1, Math.max(0, randomValue))
      : 0.5;
    const jitterMultiplier = 0.8 + normalizedRandom * 0.4;

    return Math.min(
      FALLBACK_RETRY_MAX_MS,
      Math.round(baseDelayMs * jitterMultiplier),
    );
  }
}

function parseRetryAfter(
  retryAfter: string | null | undefined,
  now: number,
): number | null {
  if (retryAfter === null || retryAfter === undefined) {
    return null;
  }

  const normalized = retryAfter.trim();
  if (/^\d+$/.test(normalized)) {
    const delayMs = Number(normalized) * 1_000;
    return now + clampRetryDelay(delayMs);
  }

  if (!HTTP_DATE_PATTERN.test(normalized)) {
    return null;
  }

  const parsedDate = Date.parse(normalized);
  if (
    !Number.isFinite(parsedDate) ||
    new Date(parsedDate).toUTCString() !== normalized ||
    parsedDate <= now
  ) {
    return null;
  }

  return now + clampRetryDelay(parsedDate - now);
}

function clampRetryDelay(delayMs: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, delayMs));
}
