export const TURN_DISPATCH_SLOW_THRESHOLD_MS = 2_000;

export const TURN_DISPATCH_PHASES = [
  'prompt_commit',
  'auth_preflight',
  'org_memory',
  'local_memory',
  'active_plan',
  'dispatch_metadata',
  'session_config',
  'session_reuse',
  'session_create',
  'scope_lease',
  'observability',
  'live_setters',
  'turn_capture',
  'enqueue',
] as const;

export type TurnDispatchPhase = (typeof TURN_DISPATCH_PHASES)[number];

export interface TurnDispatchPhaseDuration {
  phase: TurnDispatchPhase;
  elapsedMs: number;
}

export interface TurnDispatchSlowDiagnostic {
  kind: 'turn_dispatch_slow';
  totalMs: number;
  endpoint: 'enqueued' | 'first_event';
  phases: TurnDispatchPhaseDuration[];
}

/** Content-free monotonic timing for one prompt-to-provider handoff. */
export class TurnDispatchTiming {
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly phaseElapsedMs = new Map<TurnDispatchPhase, number>();
  private enqueued = false;
  private slowEnqueue = false;
  private firstProviderEventSeen = false;
  private firstEventRecorded = false;

  constructor(now: () => number = (): number => performance.now()) {
    this.now = now;
    this.startedAt = now();
  }

  async measure<T>(
    phase: TurnDispatchPhase,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const startedAt = this.now();
    try {
      return await operation();
    } finally {
      this.addPhaseDuration(phase, this.now() - startedAt);
    }
  }

  measureSync<T>(phase: TurnDispatchPhase, operation: () => T): T {
    const startedAt = this.now();
    try {
      return operation();
    } finally {
      this.addPhaseDuration(phase, this.now() - startedAt);
    }
  }

  phaseSnapshot(): TurnDispatchPhaseDuration[] {
    return TURN_DISPATCH_PHASES.flatMap((phase) => {
      const elapsedMs = this.phaseElapsedMs.get(phase);
      return elapsedMs === undefined
        ? []
        : [{ phase, elapsedMs: Math.round(elapsedMs) }];
    });
  }

  markEnqueued(): TurnDispatchSlowDiagnostic | undefined {
    if (this.enqueued) return undefined;
    this.enqueued = true;
    const totalMs = this.elapsedMs();
    if (totalMs <= TURN_DISPATCH_SLOW_THRESHOLD_MS) return undefined;
    this.slowEnqueue = true;
    return this.diagnostic('enqueued', totalMs);
  }

  markFirstProviderEvent(): TurnDispatchSlowDiagnostic | undefined {
    // An event before the enqueue (a reused session's tail) says nothing
    // about this handoff and must not use up the milestone.
    if (!this.enqueued || this.firstProviderEventSeen) return undefined;
    this.firstProviderEventSeen = true;
    if (!this.slowEnqueue || this.firstEventRecorded) return undefined;
    this.firstEventRecorded = true;
    return this.diagnostic('first_event', this.elapsedMs());
  }

  private elapsedMs(): number {
    return Math.max(0, Math.round(this.now() - this.startedAt));
  }

  private addPhaseDuration(phase: TurnDispatchPhase, elapsedMs: number): void {
    this.phaseElapsedMs.set(
      phase,
      (this.phaseElapsedMs.get(phase) ?? 0) + Math.max(0, elapsedMs),
    );
  }

  private diagnostic(
    endpoint: TurnDispatchSlowDiagnostic['endpoint'],
    totalMs: number,
  ): TurnDispatchSlowDiagnostic {
    return {
      kind: 'turn_dispatch_slow',
      totalMs,
      endpoint,
      phases: this.phaseSnapshot(),
    };
  }
}
