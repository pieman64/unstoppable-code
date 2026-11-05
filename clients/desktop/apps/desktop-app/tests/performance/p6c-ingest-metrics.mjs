const MIB = 1024 * 1024;
const MEMORY_KEYS = Object.freeze(['mainJsHeapBytes', 'rendererJsHeapBytes']);

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Assess the latest natural-memory window without forcing GC. Each sample is
 * `{atMs, mainJsHeapBytes, rendererJsHeapBytes, quietForMs, pendingIngress}`.
 * A window settles only after five quiet seconds and five consecutive
 * one-second samples whose per-heap spread is at most max(1 MiB, 5% median).
 */
export function assessMemorySettling(samples, options = {}) {
  const {
    stableCount = 5,
    intervalMs = 1_000,
    intervalToleranceMs = 250,
    quietDurationMs = 5_000,
  } = options;
  const sampleCount = Array.isArray(samples) ? samples.length : 0;
  const emptyMetrics = Object.fromEntries(
    MEMORY_KEYS.map((key) => [key, null]),
  );
  const result = (reason, window = [], metrics = emptyMetrics) => ({
    settled: reason === null,
    reason,
    sampleCount,
    stableCount,
    quietDurationMs,
    quietForMs:
      window.length > 0
        ? Math.min(...window.map((sample) => sample.quietForMs))
        : null,
    windowStartAtMs: window[0]?.atMs ?? null,
    windowEndAtMs: window.at(-1)?.atMs ?? null,
    sampleCadenceMs: window
      .slice(1)
      .map((sample, index) => sample.atMs - window[index].atMs),
    metrics,
  });

  if (!Number.isInteger(stableCount) || stableCount < 2)
    return result('invalid_stable_count');
  if (sampleCount < stableCount) return result('insufficient_samples');

  const window = samples.slice(-stableCount);
  if (
    window.some(
      (sample) =>
        !Number.isFinite(sample?.atMs) ||
        !Number.isFinite(sample?.quietForMs) ||
        sample.pendingIngress !== false ||
        sample.quietForMs < quietDurationMs,
    )
  ) {
    const pendingIngress = window.some(
      (sample) => sample?.pendingIngress !== false,
    );
    return result(pendingIngress ? 'pending_ingress' : 'not_quiet', window);
  }

  const cadence = window
    .slice(1)
    .map((sample, index) => sample.atMs - window[index].atMs);
  if (
    cadence.some(
      (delta) =>
        delta < intervalMs - intervalToleranceMs ||
        delta > intervalMs + intervalToleranceMs,
    )
  )
    return result('irregular_sample_cadence', window);

  const metrics = {};
  for (const key of MEMORY_KEYS) {
    const values = window.map((sample) => sample[key]);
    if (values.some((value) => !Number.isFinite(value) || value < 0))
      return result(`invalid_${key}`, window, metrics);
    const center = median(values);
    const spreadBytes = Math.max(...values) - Math.min(...values);
    const toleranceBytes = Math.max(MIB, center * 0.05);
    metrics[key] = {
      medianBytes: center,
      spreadBytes,
      toleranceBytes,
      stable: spreadBytes <= toleranceBytes,
    };
  }
  return result(
    Object.values(metrics).every((metric) => metric.stable)
      ? null
      : 'unstable_memory',
    window,
    metrics,
  );
}

/** Resolve an observer-backed metric without converting missing data to 0. */
export function decideObserverMetric(
  { available, sampleCount, droppedCount = 0, error, value },
  metricName,
) {
  let reason = null;
  if (error) reason = `${metricName}:observer_error:${String(error)}`;
  else if (!available) reason = `${metricName}:observer_unavailable`;
  else if (!Number.isFinite(sampleCount) || sampleCount <= 0)
    reason = `${metricName}:no_samples`;
  else if (!Number.isFinite(droppedCount) || droppedCount > 0)
    reason = `${metricName}:samples_dropped`;
  else if (!Number.isFinite(value)) reason = `${metricName}:invalid_value`;
  return { value: reason ? null : value, unavailable: reason };
}

/** rAF intervals belong to the bracket whose end-frame lies within T0/T1. */
export function bracketRendererSamples(renderer, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
    return { frames: [], frameGapsMs: [], longTasks: [], validBracket: false };
  const allFrames = renderer?.frames ?? [];
  const frames = [],
    frameGapsMs = [];
  for (const [index, frame] of allFrames.entries()) {
    if (frame.timestampMs < startMs || frame.timestampMs > endMs) continue;
    frames.push(frame);
    const previous = allFrames[index - 1];
    if (previous && Number.isFinite(previous.timestampMs)) {
      const gap = frame.timestampMs - previous.timestampMs;
      if (Number.isFinite(gap) && gap > 0) frameGapsMs.push(gap);
    }
  }
  return {
    frames,
    frameGapsMs,
    validBracket: true,
    longTasks: (renderer?.longTasks ?? []).filter(
      (task) =>
        Number.isFinite(task.startTime) &&
        Number.isFinite(task.duration) &&
        task.startTime <= endMs &&
        task.startTime + task.duration >= startMs,
    ),
  };
}

/**
 * Top-level tasks on the main process's CrBrowserMain thread from a Chromium
 * JSON trace. Nested toplevel slices are folded into the task that contains
 * them, so one long task counts once.
 */
export function mainThreadTasks(trace, mainPid, longTaskMs = 50) {
  const events = Array.isArray(trace) ? trace : (trace?.traceEvents ?? []);
  const thread = events.find(
    (event) =>
      event?.ph === 'M' &&
      event.name === 'thread_name' &&
      event.pid === mainPid &&
      event.args?.name === 'CrBrowserMain',
  );
  if (!thread) return { threadFound: false, tasks: [], long: [] };
  const slices = events
    .filter(
      (event) =>
        event?.ph === 'X' &&
        event.pid === mainPid &&
        event.tid === thread.tid &&
        typeof event.cat === 'string' &&
        event.cat.split(',').includes('toplevel') &&
        Number.isFinite(event.ts) &&
        Number.isFinite(event.dur),
    )
    .sort((left, right) => left.ts - right.ts || right.dur - left.dur);
  const tasks = [];
  let end = -Infinity;
  for (const slice of slices) {
    if (slice.ts < end) continue;
    tasks.push({
      ts: slice.ts,
      durationMs: slice.dur / 1_000,
      name: slice.name,
    });
    end = slice.ts + slice.dur;
  }
  return {
    threadFound: true,
    tasks,
    long: tasks.filter((task) => task.durationMs >= longTaskMs),
  };
}
