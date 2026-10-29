function violation(metric, value, budgetMs, description, toleranceMs = 0) {
  if (!Number.isFinite(value) || value <= budgetMs + toleranceMs) return null;
  return { metric, value, budgetMs, unit: 'ms', description };
}

function countViolation(metric, value, description) {
  if (!Number.isInteger(value) || value <= 0) return null;
  return { metric, value, budgetMs: 0, unit: 'count', description };
}

function taskViolations(tasks) {
  return tasks
    .filter(
      (task) =>
        Number.isFinite(task.responsivenessBudgetMs) &&
        task.durationMs > task.responsivenessBudgetMs,
    )
    .map((task) => ({
      metric: `task.${task.kind}.duration_ms`,
      value: task.durationMs,
      budgetMs: task.responsivenessBudgetMs,
      unit: 'ms',
      description: `${task.kind} exceeded its responsiveness liveness budget`,
    }));
}

export function assessResponsiveness(summary, thresholds, tasks = []) {
  const candidates = [
    violation(
      'renderer.frame_delay.max_ms',
      summary.rendererFrameDelayMs?.max,
      thresholds.rendererFrameDelayMaxMs,
      'Worst animation-frame delay indicates a visible freeze',
      // Renderer performance timestamps are exposed at 0.1 ms resolution.
      // Subtracting the fractional 60 Hz frame interval can therefore turn a
      // displayed 100.0 ms delay into 100.033 ms. Half a timestamp quantum
      // prevents that arithmetic artifact from flipping the verdict while a
      // measurable 100.1 ms delay still fails.
      0.05,
    ),
    violation(
      'renderer.key_to_paint_confirmation.p95_ms',
      summary.rendererKeyToPaintConfirmationMs?.p95,
      thresholds.rendererKeyToPaintConfirmationP95Ms,
      'Key-to-paint-confirmation p95 indicates delayed typing feedback',
    ),
    violation(
      'renderer.key_to_paint_confirmation.max_ms',
      summary.rendererKeyToPaintConfirmationMs?.max,
      thresholds.rendererKeyToPaintConfirmationMaxMs,
      'Worst key-to-paint-confirmation delay indicates an input freeze',
    ),
    violation(
      'renderer.long_tasks.max_ms',
      summary.longTasks?.max,
      thresholds.rendererLongTaskMaxMs,
      'Worst renderer long task exceeds the responsiveness ceiling',
    ),
    violation(
      'ipc.outer.max_ms',
      summary.ipcOuterMs?.max,
      thresholds.ipcOuterMaxMs,
      'Worst renderer-to-main heartbeat indicates main/renderer contention',
    ),
    countViolation(
      'ipc.error_count',
      summary.ipcErrorCount,
      'A renderer-to-main heartbeat failed',
    ),
    ...taskViolations(tasks),
  ].filter(Boolean);

  return {
    passed: candidates.length === 0,
    thresholds,
    violations: candidates,
  };
}
