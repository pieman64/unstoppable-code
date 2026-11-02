const DEFAULT_CADENCE_MS = 10_000;
const EXACT_BUCKET_MAX_MS = 1_000;
const UPPER_BUCKET_RATIO = 1.01;
const UPPER_BUCKET_LOG_RATIO = Math.log(UPPER_BUCKET_RATIO);
const MAX_HISTOGRAM_VALUE_MS = Number.MAX_SAFE_INTEGER;

/**
 * Flush-time values for one concrete ingestion session. Percentiles are
 * omitted when no latency samples were recorded in the window.
 */
export interface IngestionAdmissionMetricsSnapshot {
  admissionLatencyP50Ms?: number;
  admissionLatencyP95Ms?: number;
  admissionReceiptSampleCount: number;
  admissionSampleCount: number;
  admissionWindowMs: number;
  backlogDepth: number;
  backlogOldestAgeMs: number;
  backlogPeakDepth: number;
}

export interface IngestionAdmissionBacklogSnapshot {
  depth: number;
  oldestAgeMs: number;
}

export interface IngestionAdmissionMetricsOptions {
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
  cadenceMs?: number;
  dormant?: boolean;
  now?: () => number;
  onFlush: (snapshot: IngestionAdmissionMetricsSnapshot) => void;
  readBacklog?: () => IngestionAdmissionBacklogSnapshot;
  schedule?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
}

/**
 * Bounded histogram for one session's receipt-or-admission-to-release latency.
 * Buckets are exact to integer milliseconds through 1,000ms. Above that they
 * use 1% logarithmic upper bounds (less than 1ms of error in exact buckets,
 * at most 1% overestimation in logarithmic buckets). Values beyond
 * Number.MAX_SAFE_INTEGER milliseconds saturate at that representable limit.
 * The number of buckets is bounded independently of the number of events; no
 * raw latency samples are retained.
 */
export class IngestionAdmissionMetrics {
  private readonly cancelTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly cadenceMs: number;
  private readonly dormant: boolean;
  private readonly histogram = new Map<number, number>();
  private readonly nowProvider: () => number;
  private readonly onFlush: (
    snapshot: IngestionAdmissionMetricsSnapshot,
  ) => void;
  private readonly readBacklog:
    | (() => IngestionAdmissionBacklogSnapshot)
    | undefined;
  private readonly scheduleTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  private admissionSampleCount = 0;
  private admissionReceiptSampleCount = 0;
  private backlogDepth = 0;
  private backlogOldestAgeMs = 0;
  private backlogObservedAt: number | undefined;
  private backlogPeakDepth = 0;
  private disposed = false;
  private lastKnownNow = Date.now();
  private timerHandle: ReturnType<typeof setTimeout> | undefined;
  private windowStartedAt: number;

  public constructor(options: IngestionAdmissionMetricsOptions) {
    this.nowProvider = options.now ?? Date.now;
    this.scheduleTimer =
      options.schedule ??
      ((callback, delayMs): ReturnType<typeof setTimeout> =>
        setTimeout(callback, delayMs));
    this.cancelTimer =
      options.cancel ??
      ((handle): void => {
        clearTimeout(handle);
      });
    this.readBacklog = options.readBacklog;
    this.onFlush = options.onFlush;
    this.cadenceMs =
      options.cadenceMs !== undefined &&
      Number.isFinite(options.cadenceMs) &&
      options.cadenceMs > 0
        ? options.cadenceMs
        : DEFAULT_CADENCE_MS;
    this.dormant = options.dormant ?? false;
    this.windowStartedAt = this.readNow();
  }

  /** Number of populated histogram buckets; storage is bounded by design. */
  public get storedHistogramBucketCount(): number {
    return this.histogram.size;
  }

  /**
   * Adds exactly one sample for a settled event. Receipt time is preferred;
   * admission time is the fallback when the event had no valid receipt time.
   */
  public recordSettled(
    admittedAt: number,
    receiptAt?: number,
    settledAt?: number,
  ): void {
    if (this.disposed) {
      return;
    }

    const validReceiptAt =
      receiptAt !== undefined && Number.isFinite(receiptAt)
        ? receiptAt
        : undefined;
    const startedAt = validReceiptAt ?? admittedAt;
    const releasedAt = settledAt ?? this.readNow();
    if (!Number.isFinite(startedAt) || !Number.isFinite(releasedAt)) {
      return;
    }

    const latencyMs = Math.max(0, releasedAt - startedAt);
    if (!Number.isFinite(latencyMs)) {
      return;
    }

    const bucket = this.getBucketKey(latencyMs);
    this.histogram.set(bucket, (this.histogram.get(bucket) ?? 0) + 1);
    this.admissionSampleCount += 1;
    if (validReceiptAt !== undefined) {
      this.admissionReceiptSampleCount += 1;
    }
    this.ensureTimer();
  }

  /** Samples the current backlog without changing admission or release order. */
  public observeBacklog(): void {
    if (this.disposed) {
      return;
    }

    this.captureBacklog(this.readNow());
    this.ensureTimer();
  }

  /**
   * Transfers and consumes another accumulator's pending window metrics.
   * The receiving session's window start and pending cadence are unchanged.
   */
  public merge(other: IngestionAdmissionMetrics): void {
    if (this === other || this.disposed || other.disposed) {
      return;
    }

    other.histogram.forEach((count, bucket) => {
      this.histogram.set(bucket, (this.histogram.get(bucket) ?? 0) + count);
    });
    this.admissionSampleCount += other.admissionSampleCount;
    this.admissionReceiptSampleCount += other.admissionReceiptSampleCount;
    this.backlogPeakDepth = Math.max(
      this.backlogPeakDepth,
      other.backlogPeakDepth,
    );
    this.backlogOldestAgeMs = Math.max(
      this.backlogOldestAgeMs,
      other.backlogOldestAgeMs,
    );

    if (
      other.backlogObservedAt !== undefined &&
      (this.backlogObservedAt === undefined ||
        other.backlogObservedAt > this.backlogObservedAt)
    ) {
      this.backlogDepth = other.backlogDepth;
      this.backlogObservedAt = other.backlogObservedAt;
    }

    other.cancelScheduledTimer();
    other.clearWindowMetrics(true);
    this.ensureTimer();
  }

  /** Flushes one due window; early calls leave its window and samples intact. */
  public flushDue(): boolean {
    if (this.disposed || this.dormant) {
      return false;
    }

    const flushedAt = this.readNow();
    const windowMs = Math.max(0, flushedAt - this.windowStartedAt);
    if (windowMs < this.cadenceMs) {
      this.ensureTimer();
      return false;
    }

    this.cancelScheduledTimer();
    this.captureBacklog(flushedAt);
    if (!this.hasWindowActivity()) {
      return false;
    }

    const snapshot = this.createSnapshot(windowMs);
    this.windowStartedAt = flushedAt;
    this.clearWindowMetrics(false);
    try {
      this.onFlush(snapshot);
    } catch {
      // Diagnostics are best-effort and must never affect ingestion behavior.
    }
    this.ensureTimer();
    return true;
  }

  /**
   * Flushes the pending window once, before cadence, when its session ends,
   * so the last partial window is not lost. A no-op without activity.
   */
  public flushFinal(): void {
    if (this.disposed || this.dormant) {
      return;
    }

    const flushedAt = this.readNow();
    this.cancelScheduledTimer();
    this.captureBacklog(flushedAt);
    if (!this.hasWindowActivity()) {
      return;
    }

    const snapshot = this.createSnapshot(
      Math.max(0, flushedAt - this.windowStartedAt),
    );
    this.windowStartedAt = flushedAt;
    this.clearWindowMetrics(false);
    try {
      this.onFlush(snapshot);
    } catch {
      // Diagnostics are best-effort and must never affect ingestion behavior.
    }
  }

  /** Stops the timer and releases retained metrics without flushing. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelScheduledTimer();
    this.clearWindowMetrics(true);
  }

  private captureBacklog(observedAt: number): void {
    if (this.readBacklog === undefined) {
      return;
    }

    let backlog: IngestionAdmissionBacklogSnapshot;
    try {
      backlog = this.readBacklog();
    } catch {
      return;
    }

    if (
      !Number.isFinite(backlog.depth) ||
      !Number.isFinite(backlog.oldestAgeMs)
    ) {
      return;
    }

    const depth = Math.max(0, Math.floor(backlog.depth));
    const oldestAgeMs = depth > 0 ? Math.max(0, backlog.oldestAgeMs) : 0;
    this.backlogDepth = depth;
    this.backlogObservedAt = observedAt;
    this.backlogPeakDepth = Math.max(this.backlogPeakDepth, depth);
    this.backlogOldestAgeMs = Math.max(this.backlogOldestAgeMs, oldestAgeMs);
  }

  private cancelScheduledTimer(): void {
    const handle = this.timerHandle;
    this.timerHandle = undefined;
    if (handle === undefined) {
      return;
    }
    try {
      this.cancelTimer(handle);
    } catch {
      // Timer cleanup is also best-effort; disposed callbacks check state.
    }
  }

  private clearWindowMetrics(clearBacklogState: boolean): void {
    this.histogram.clear();
    this.admissionSampleCount = 0;
    this.admissionReceiptSampleCount = 0;
    this.backlogPeakDepth = 0;
    this.backlogOldestAgeMs = 0;
    if (clearBacklogState) {
      this.backlogDepth = 0;
      this.backlogObservedAt = undefined;
    }
  }

  private createSnapshot(windowMs: number): IngestionAdmissionMetricsSnapshot {
    const snapshot: IngestionAdmissionMetricsSnapshot = {
      admissionWindowMs: windowMs,
      admissionSampleCount: this.admissionSampleCount,
      admissionReceiptSampleCount: this.admissionReceiptSampleCount,
      backlogDepth: this.backlogDepth,
      backlogPeakDepth: this.backlogPeakDepth,
      backlogOldestAgeMs: this.backlogOldestAgeMs,
    };
    const p50 = this.readQuantile(0.5);
    const p95 = this.readQuantile(0.95);
    if (p50 !== undefined) {
      snapshot.admissionLatencyP50Ms = p50;
    }
    if (p95 !== undefined) {
      snapshot.admissionLatencyP95Ms = p95;
    }
    return snapshot;
  }

  private ensureTimer(): void {
    if (
      this.disposed ||
      this.dormant ||
      this.timerHandle !== undefined ||
      !this.hasWindowActivity()
    ) {
      return;
    }

    const remainingMs = Math.max(
      0,
      this.cadenceMs - (this.readNow() - this.windowStartedAt),
    );
    try {
      this.timerHandle = this.scheduleTimer(() => {
        this.timerHandle = undefined;
        if (this.disposed || this.dormant) {
          return;
        }
        this.flushDue();
        this.ensureTimer();
      }, remainingMs);
    } catch {
      // A failed diagnostic timer must not change admission behavior.
    }
  }

  private getBucketKey(latencyMs: number): number {
    const boundedLatencyMs = Math.min(latencyMs, MAX_HISTOGRAM_VALUE_MS);
    if (boundedLatencyMs <= EXACT_BUCKET_MAX_MS) {
      return Math.ceil(boundedLatencyMs);
    }
    const logarithmicOffset = Math.floor(
      Math.log(boundedLatencyMs / EXACT_BUCKET_MAX_MS) / UPPER_BUCKET_LOG_RATIO,
    );
    return EXACT_BUCKET_MAX_MS + 1 + Math.max(0, logarithmicOffset);
  }

  private hasWindowActivity(): boolean {
    return (
      this.admissionSampleCount > 0 ||
      this.backlogDepth > 0 ||
      this.backlogPeakDepth > 0 ||
      this.backlogOldestAgeMs > 0
    );
  }

  private readNow(): number {
    try {
      const now = this.nowProvider();
      if (Number.isFinite(now)) {
        this.lastKnownNow = now;
        return now;
      }
    } catch {
      // A clock failure omits precision but never affects ingestion.
    }
    return this.lastKnownNow;
  }

  private readQuantile(quantile: number): number | undefined {
    if (this.admissionSampleCount === 0) {
      return undefined;
    }

    const targetRank = Math.ceil(quantile * this.admissionSampleCount);
    const orderedBuckets = Array.from(this.histogram.entries()).sort(
      (left, right) => left[0] - right[0],
    );
    let seen = 0;
    for (const [bucket, count] of orderedBuckets) {
      seen += count;
      if (seen >= targetRank) {
        return this.getBucketUpperBound(bucket);
      }
    }
    return undefined;
  }

  private getBucketUpperBound(bucket: number): number {
    if (bucket <= EXACT_BUCKET_MAX_MS) {
      return bucket;
    }
    return Math.min(
      MAX_HISTOGRAM_VALUE_MS,
      EXACT_BUCKET_MAX_MS *
        UPPER_BUCKET_RATIO ** (bucket - EXACT_BUCKET_MAX_MS),
    );
  }
}
