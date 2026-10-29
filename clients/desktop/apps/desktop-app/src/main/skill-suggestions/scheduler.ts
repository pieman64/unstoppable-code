import { logMainProcessWarn } from '../lib/main-process-logging';
import { TimeSlicer } from './time-slicer';

/**
 * Idle-gated scheduling for repeat-task skill suggestions (CAN-385), after
 * the local memory consolidation scheduler. A busy chat cancels in-flight
 * work at its next yield; once every chat has been idle for the debounce,
 * one pass runs the backfill (first time only) and then the due partition
 * scans. Nothing runs at startup or while a turn streams.
 */
export const SKILL_SUGGESTION_IDLE_DEBOUNCE_MS = 5 * 60_000;

export interface SchedulerRunContext {
  slicer: TimeSlicer;
  /** Whether this run was cancelled by activity or the gate. */
  isCancelled: () => boolean;
}

export interface SkillSuggestionSchedulerDeps {
  isScanEnabled: () => boolean;
  hasBusySession: () => boolean;
  subscribeActivity: (listener: () => void) => () => void;
  runPass: (context: SchedulerRunContext) => Promise<void>;
  debounceMs?: number;
  setTimer?: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class SkillSuggestionScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private inFlight: { cancelled: boolean } | null = null;
  private started = false;

  constructor(private readonly deps: SkillSuggestionSchedulerDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.deps.subscribeActivity(() => this.handleActivity());
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearDebounce();
    this.cancelInFlight();
  }

  /** The gate closed: timers clear and in-flight work stops at its next yield. */
  cancelInFlight(): void {
    if (this.inFlight) this.inFlight.cancelled = true;
  }

  get isRunning(): boolean {
    return this.inFlight !== null;
  }

  private clearDebounce(): void {
    if (this.timer !== null) {
      (this.deps.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  handleActivity(): void {
    if (!this.started) return;
    if (this.deps.hasBusySession()) {
      this.clearDebounce();
      this.cancelInFlight();
      return;
    }
    this.arm();
  }

  /** Arms the busy-to-idle debounce unless a run is already pending. */
  arm(): void {
    if (!this.started || this.timer !== null || this.inFlight) return;
    if (!this.deps.isScanEnabled()) return;
    this.timer = (this.deps.setTimer ?? setTimeout)(() => {
      this.timer = null;
      void this.runNow();
    }, this.deps.debounceMs ?? SKILL_SUGGESTION_IDLE_DEBOUNCE_MS);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  async runNow(): Promise<void> {
    if (!this.started || this.inFlight) return;
    if (!this.deps.isScanEnabled() || this.deps.hasBusySession()) return;
    const token = { cancelled: false };
    this.inFlight = token;
    const isCancelled = (): boolean =>
      token.cancelled || !this.deps.isScanEnabled();
    try {
      await this.deps.runPass({
        slicer: new TimeSlicer({ shouldStop: isCancelled }),
        isCancelled,
      });
    } catch (error) {
      logMainProcessWarn('[skill-suggestions] scan pass failed', error);
    } finally {
      if (this.inFlight === token) {
        this.inFlight = null;
        // An idle transition during a cancelled run could not arm; do it now.
        if (token.cancelled && !this.deps.hasBusySession()) this.arm();
      }
    }
  }
}
