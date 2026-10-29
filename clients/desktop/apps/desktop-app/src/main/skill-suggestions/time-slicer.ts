import { performance } from 'node:perf_hooks';

/** Per-slice main-thread budget for backfill and clustering. */
export const SKILL_SUGGESTION_SLICE_BUDGET_MS = 8;

export interface TimeSlicerOptions {
  budgetMs?: number;
  now?: () => number;
  yieldToEventLoop?: () => Promise<void>;
  /** Checked at every yield; `true` stops the run. */
  shouldStop?: () => boolean;
}

function setImmediateYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Cooperative time slicing for main-thread work. Call {@link tick} between
 * units of work; it yields with `setImmediate` once the slice budget is
 * spent and reports `false` when the run must stop.
 */
export class TimeSlicer {
  private sliceStartedAt: number;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private readonly yieldToEventLoop: () => Promise<void>;
  private readonly shouldStop: () => boolean;
  /** Longest slice observed, for tests and diagnostics. */
  longestSliceMs = 0;
  yields = 0;

  constructor(options: TimeSlicerOptions = {}) {
    this.budgetMs = options.budgetMs ?? SKILL_SUGGESTION_SLICE_BUDGET_MS;
    this.now = options.now ?? ((): number => performance.now());
    this.yieldToEventLoop = options.yieldToEventLoop ?? setImmediateYield;
    this.shouldStop = options.shouldStop ?? ((): boolean => false);
    this.sliceStartedAt = this.now();
  }

  get stopped(): boolean {
    return this.shouldStop();
  }

  async tick(): Promise<boolean> {
    if (this.shouldStop()) return false;
    const elapsed = this.now() - this.sliceStartedAt;
    if (elapsed < this.budgetMs) return true;
    this.longestSliceMs = Math.max(this.longestSliceMs, elapsed);
    this.yields += 1;
    await this.yieldToEventLoop();
    this.sliceStartedAt = this.now();
    return !this.shouldStop();
  }
}
