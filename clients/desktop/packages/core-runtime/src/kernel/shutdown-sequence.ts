export interface ShutdownPhase {
  id: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  name: string;
  deadlineMs: number;
  run(signal: AbortSignal): void | Promise<void>;
}

export interface ShutdownReport {
  reason: string;
  phases: Array<{
    id: number;
    status: 'completed' | 'timed_out' | 'failed';
    elapsedMs: number;
    error?: string;
  }>;
}

type PhaseReport = ShutdownReport['phases'][number];

// Larger setTimeout delays overflow and fire after 1ms.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// Formatting a hostile throw value must not abort the remaining phases.
const describeError = (error: unknown): string => {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return 'Unknown error';
  }
};

export function createShutdownSequence(options: {
  phases: readonly ShutdownPhase[];
  now?: () => number;
}): { run(reason: string): Promise<ShutdownReport> } {
  const { now = Date.now } = options;
  // Frozen snapshots are also the hook receiver, so later caller mutations
  // cannot bypass validation or alter a run, even through `this`.
  const phases: readonly ShutdownPhase[] = options.phases.map((phase) => {
    let run: ShutdownPhase['run'] = () => undefined;
    const snapshot: ShutdownPhase = Object.freeze({
      id: phase.id,
      name: phase.name,
      deadlineMs: phase.deadlineMs,
      run: (signal: AbortSignal): void | Promise<void> => run(signal),
    });
    run = phase.run.bind(snapshot);
    return snapshot;
  });
  let previousId = 0;
  for (const phase of phases) {
    if (!Number.isFinite(phase.deadlineMs) || phase.deadlineMs < 0)
      throw new RangeError(
        `Shutdown phase ${phase.id} has an invalid deadline.`,
      );
    if (phase.id <= previousId)
      throw new RangeError(
        `Shutdown phase ${phase.id} is duplicated or out of order.`,
      );
    previousId = phase.id;
  }

  const runPhase = async (phase: ShutdownPhase): Promise<PhaseReport> => {
    const controller = new AbortController();
    const startedAt = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Pick<PhaseReport, 'status'>>((resolve) => {
      const schedule = (remainingMs: number): void => {
        const delayMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
        timer = setTimeout(() => {
          if (remainingMs > delayMs) {
            schedule(remainingMs - delayMs);
            return;
          }
          controller.abort();
          resolve({ status: 'timed_out' });
        }, delayMs);
      };
      schedule(phase.deadlineMs);
    });
    // Handlers on both branches keep a late failure from going unhandled.
    const outcome = Promise.resolve()
      .then(() => phase.run(controller.signal))
      .then(
        (): Pick<PhaseReport, 'status' | 'error'> => ({ status: 'completed' }),
        (error: unknown) => ({
          status: 'failed' as const,
          error: describeError(error),
        }),
      );
    const result = await Promise.race([outcome, timeout]);
    clearTimeout(timer);
    return { id: phase.id, elapsedMs: now() - startedAt, ...result };
  };

  let pending: Promise<ShutdownReport> | undefined;
  return {
    run(reason: string): Promise<ShutdownReport> {
      pending ??= (async (): Promise<ShutdownReport> => {
        const report: ShutdownReport = { reason, phases: [] };
        for (const phase of phases) report.phases.push(await runPhase(phase));
        return report;
      })();
      return pending;
    },
  };
}
