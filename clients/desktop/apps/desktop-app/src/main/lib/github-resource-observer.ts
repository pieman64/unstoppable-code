import { GitHubBrokerError } from './github-broker';
import { withJitter } from './github-broker/rate-limit';

/**
 * Shared scheduling core for GitHub watcher observers: one coalesced read per
 * resource key for all local subscribers, a rescan generation that drops stale
 * subscription lists, one timer for the earliest due resource, jittered
 * transient backoff, and abort of in-flight reads whose last subscriber left.
 * Adapters own the reads and what they report.
 */

interface GitHubResourceSubscription {
  watcherId: string;
}

export interface GitHubObservedResource<
  TSubscription extends GitHubResourceSubscription,
> {
  key: string;
  subscribers: Map<string, TSubscription>;
  dueAt: number;
  errorCount: number;
  controller?: AbortController;
  inFlight: boolean;
  /** When the broker said it will send this resource's reads again. */
  rateLimitedUntil?: number;
}

interface GitHubResourceObserverCallbacks<TSubscription, TObservation> {
  listSubscriptions(): Promise<TSubscription[]>;
  applyObservation(observation: {
    observations: TObservation[];
  }): Promise<void>;
}

export interface GitHubResourceAdapter<
  TSubscription extends GitHubResourceSubscription,
  TResource extends GitHubObservedResource<TSubscription>,
  TObservation,
> {
  resourceKey(subscription: TSubscription): string;
  /** Build a new resource; `subscribers` is already keyed by watcher id. */
  createResource(
    key: string,
    subscriptions: TSubscription[],
    subscribers: Map<string, TSubscription>,
    now: number,
  ): TResource;
  /** Refresh adapter fields after the core replaced `subscribers`. */
  refreshResource?(resource: TResource, subscriptions: TSubscription[]): void;
  /**
   * Read one due resource and return its observations. The adapter schedules
   * the next read on success; `isCurrent()` is false once the resource was
   * dropped or lost every subscriber, in which case nothing is reported.
   */
  observe(
    resource: TResource,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<TObservation[]>;
  /** Observations reported to every subscriber after a permanent failure. */
  sourceFailure(resource: TResource): TObservation[];
  /**
   * Observations reported when the broker holds this resource's reads until
   * `retryAt` (epoch ms): to every subscriber once per pause, and to a
   * subscriber that joins while the pause lasts. The next successful read
   * reports a snapshot instead.
   */
  rateLimited?(
    resource: TResource,
    retryAt: number,
    subscriberIds?: string[],
  ): TObservation[];
}

const TRANSIENT_DELAYS_MS = [10_000, 20_000, 40_000, 60_000];
const RESCAN_RETRY_DELAY_MS = 10_000;
/** Spreads reads that resume together after a pause. */
const RATE_LIMIT_RESUME_SLACK_MS = 2_000;

export function githubResourceBackoffDelayMs(errorCount: number): number {
  return TRANSIENT_DELAYS_MS[
    Math.min(
      Math.max(0, Math.floor(errorCount)),
      TRANSIENT_DELAYS_MS.length - 1,
    )
  ];
}

export function githubResourceNextDelayMs(
  computedDelayMs: number,
  pollIntervalMs?: number,
): number {
  return Math.max(withJitter(computedDelayMs), pollIntervalMs ?? 0);
}

/** When a broker rate-limit refusal says reads resume, if it says. */
export function githubRateLimitRetryAt(error: unknown): number | undefined {
  return error instanceof GitHubBrokerError &&
    error.code === 'rate_limited' &&
    error.retryAt !== undefined
    ? error.retryAt
    : undefined;
}

/** Missing, forbidden, or malformed sources never recover by polling. */
export function isPermanentGitHubSourceFailure(error: unknown): boolean {
  return (
    error instanceof GitHubBrokerError &&
    (error.code === 'permission_denied' ||
      error.code === 'not_found' ||
      error.code === 'invalid_response')
  );
}

export class GitHubResourceObserver<
  TSubscription extends GitHubResourceSubscription,
  TResource extends GitHubObservedResource<TSubscription>,
  TObservation,
> {
  private callbacks: GitHubResourceObserverCallbacks<
    TSubscription,
    TObservation
  > | null = null;
  private resources = new Map<string, TResource>();
  /** Subscribers that received a stopped resource's permanent failure. */
  private failedSubscriberIds = new WeakMap<TResource, ReadonlySet<string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cycleActive = false;
  private rescanGeneration = 0;

  constructor(
    private readonly adapter: GitHubResourceAdapter<
      TSubscription,
      TResource,
      TObservation
    >,
  ) {}

  configure(
    callbacks: GitHubResourceObserverCallbacks<TSubscription, TObservation>,
  ): void {
    this.callbacks = callbacks;
    this.start();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.rescan();
  }

  async rescan(): Promise<void> {
    if (!this.running || !this.callbacks) return;
    const generation = ++this.rescanGeneration;
    let subscriptions: TSubscription[];
    try {
      subscriptions = await this.callbacks.listSubscriptions();
    } catch {
      if (generation !== this.rescanGeneration || !this.running) return;
      this.armTimer(Date.now() + RESCAN_RETRY_DELAY_MS);
      return;
    }
    if (generation !== this.rescanGeneration || !this.running) return;

    const nextSubscribers = new Map<string, TSubscription[]>();
    for (const subscription of subscriptions) {
      const key = this.adapter.resourceKey(subscription);
      const entries = nextSubscribers.get(key) ?? [];
      entries.push(subscription);
      nextSubscribers.set(key, entries);
    }

    for (const [key, resource] of Array.from(this.resources.entries())) {
      if (nextSubscribers.has(key)) continue;
      resource.controller?.abort();
      this.resources.delete(key);
    }

    const now = Date.now();
    const pausedJoins: TObservation[] = [];
    for (const [key, entries] of Array.from(nextSubscribers.entries())) {
      const subscribers = new Map(
        entries.map((entry) => [entry.watcherId, entry]),
      );
      const existing = this.resources.get(key);
      if (existing && !this.joinedAfterPermanentFailure(existing, entries)) {
        const joined = Array.from(subscribers.keys()).filter(
          (watcherId) => !existing.subscribers.has(watcherId),
        );
        existing.subscribers = subscribers;
        this.adapter.refreshResource?.(existing, entries);
        if (
          joined.length > 0 &&
          existing.rateLimitedUntil !== undefined &&
          existing.rateLimitedUntil > now
        ) {
          pausedJoins.push(
            ...(this.adapter.rateLimited?.(
              existing,
              existing.rateLimitedUntil,
              joined,
            ) ?? []),
          );
        }
        continue;
      }
      this.resources.set(
        key,
        this.adapter.createResource(key, entries, subscribers, now),
      );
    }
    if (pausedJoins.length > 0) {
      await this.callbacks
        .applyObservation({ observations: pausedJoins })
        .catch(() => undefined);
    }
    this.scheduleNextCycle();
  }

  /**
   * A subscriber that missed a stopped resource's failure delivery would never
   * be observed, so its resource is recreated for a fresh read.
   */
  private joinedAfterPermanentFailure(
    resource: TResource,
    entries: TSubscription[],
  ): boolean {
    if (resource.inFlight || Number.isFinite(resource.dueAt)) return false;
    const failed = this.failedSubscriberIds.get(resource);
    return entries.some((entry) => !failed?.has(entry.watcherId));
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.rescanGeneration += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const resource of Array.from(this.resources.values())) {
      resource.controller?.abort();
    }
    this.resources.clear();
  }

  private scheduleNextCycle(): void {
    if (!this.running || this.cycleActive) return;
    const dueAt = Math.min(
      ...Array.from(this.resources.values())
        .filter((resource) => !resource.inFlight)
        .map((resource) => resource.dueAt),
    );
    if (Number.isFinite(dueAt)) this.armTimer(dueAt);
    else if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private armTimer(timestampMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.runCycle();
      },
      Math.max(0, timestampMs - Date.now()),
    );
    this.timer.unref?.();
  }

  private async runCycle(): Promise<void> {
    if (!this.running || this.cycleActive || !this.callbacks) return;
    this.cycleActive = true;
    try {
      const now = Date.now();
      const due = Array.from(this.resources.values()).filter(
        (resource) => !resource.inFlight && resource.dueAt <= now,
      );
      due.sort((left, right) => left.dueAt - right.dueAt);
      const observations: TObservation[] = [];

      await Promise.all(
        due.map(async (resource) => {
          resource.inFlight = true;
          const controller = new AbortController();
          resource.controller = controller;
          const isCurrent = (): boolean =>
            this.running &&
            this.resources.get(resource.key) === resource &&
            resource.subscribers.size > 0;
          try {
            observations.push(
              ...(await this.adapter.observe(
                resource,
                controller.signal,
                isCurrent,
              )),
            );
            resource.rateLimitedUntil = undefined;
          } catch (error) {
            if (
              !this.running ||
              this.resources.get(resource.key) !== resource ||
              controller.signal.aborted
            ) {
              return;
            }
            const retryAt = githubRateLimitRetryAt(error);
            if (isPermanentGitHubSourceFailure(error)) {
              observations.push(...this.adapter.sourceFailure(resource));
              this.failedSubscriberIds.set(
                resource,
                new Set(resource.subscribers.keys()),
              );
              resource.dueAt = Number.POSITIVE_INFINITY;
            } else if (retryAt !== undefined && retryAt > Date.now()) {
              resource.dueAt = retryAt + withJitter(RATE_LIMIT_RESUME_SLACK_MS);
              if (resource.rateLimitedUntil !== retryAt) {
                resource.rateLimitedUntil = retryAt;
                observations.push(
                  ...(this.adapter.rateLimited?.(resource, retryAt) ?? []),
                );
              }
            } else {
              const delay = githubResourceBackoffDelayMs(resource.errorCount);
              resource.errorCount += 1;
              resource.dueAt = Date.now() + withJitter(delay);
            }
          } finally {
            resource.inFlight = false;
            resource.controller = undefined;
          }
        }),
      );

      if (observations.length > 0 && this.running) {
        await this.callbacks.applyObservation({ observations });
      }
    } finally {
      this.cycleActive = false;
      if (this.running) {
        await this.rescan();
        this.scheduleNextCycle();
      }
    }
  }
}
