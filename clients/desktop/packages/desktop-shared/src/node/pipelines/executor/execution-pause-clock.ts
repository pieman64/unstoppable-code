import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';

/**
 * Whole-run pause accounting for the pipeline run clock.
 *
 * A pipeline's reported duration is meant to be time it spent working, not
 * wall-clock time since it started. Runs can sit paused for minutes, hours, or
 * across an app restart while they wait on input or an approval, so the clock
 * stops when the *execution* status becomes `paused` and picks up where it
 * left off on resume. A paused job or step inside a still-running execution is
 * deliberately not a pause here — the run as a whole is still working.
 *
 * `paused_at` holds the open pause and `paused_ms` banks every closed one.
 * Both are kept on the persisted state so a pause survives a restart, and the
 * two together let display code freeze the timer without knowing the status.
 *
 * Deliberately a tiny leaf module with a type-only import: the executor,
 * shutdown recovery, and the main-process handlers all reach for it, and it
 * must not pull any of them into a cycle.
 */

/**
 * Opens a pause window. Idempotent — re-persisting an already-paused execution
 * must not restart the window and silently bank the time as run time.
 */
export function beginExecutionPause(
  state: ExecutionState,
  atIso: string = new Date().toISOString(),
): void {
  state.paused_at ??= atIso;
}

/**
 * Closes the open pause window, banking its duration into `paused_ms`. Safe to
 * call on an execution that is not paused, so every transition out of `paused`
 * (resume, cancel, terminal completion) can call it unconditionally.
 */
export function endExecutionPause(
  state: ExecutionState,
  atIso: string = new Date().toISOString(),
): void {
  const pausedAtMs = Date.parse(state.paused_at ?? '');
  state.paused_at = undefined;
  if (Number.isNaN(pausedAtMs)) {
    return;
  }

  const endedAtMs = Date.parse(atIso);
  if (Number.isNaN(endedAtMs)) {
    return;
  }

  state.paused_ms =
    (state.paused_ms ?? 0) + Math.max(0, endedAtMs - pausedAtMs);
}

/**
 * Drops all pause accounting. Used by retry/rerun paths that also reset
 * `started_at`, so the new attempt's clock starts from zero.
 */
export function resetExecutionPauseClock(state: ExecutionState): void {
  state.paused_at = undefined;
  state.paused_ms = undefined;
}

/**
 * Run time in milliseconds with whole-run pauses removed: the pipeline's
 * working time rather than wall-clock time since it started. The clock stops
 * at `completed_at` for a finished run, at `paused_at` while it is paused, and
 * at `nowMs` for a run still in flight (undefined when none of those apply).
 *
 * This is the producer-side counterpart to `getElapsedMs` in
 * `@canopy/ui-shared/lib/pipeline-timing-display`, which does the same
 * arithmetic for the renderer. They are separate because `ui-shared` may not
 * import this package and the SEA CLI may not pull a React package into its
 * bundle; keep the two in step.
 */
export function getExecutionRunDurationMs(
  state: Pick<
    ExecutionState,
    'started_at' | 'completed_at' | 'paused_at' | 'paused_ms'
  >,
  nowMs?: number,
): number | undefined {
  const startedAtMs = Date.parse(state.started_at);
  if (Number.isNaN(startedAtMs)) {
    return undefined;
  }

  const completedAtMs = Date.parse(state.completed_at ?? '');
  const pausedAtMs = Date.parse(state.paused_at ?? '');
  const stops = [completedAtMs, pausedAtMs].filter(
    (value) => !Number.isNaN(value),
  );
  const endMs = stops.length > 0 ? Math.min(...stops) : nowMs;
  if (endMs === undefined) {
    return undefined;
  }

  return Math.max(0, endMs - startedAtMs - Math.max(0, state.paused_ms ?? 0));
}
