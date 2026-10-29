import os from 'node:os';

// An admission rule, not a correction factor for measured latency. One runnable
// task per logical CPU is the saturation boundary. It includes benchmark work
// and cannot attribute contention to another process.
const INTERVAL_MS = 1_000;
const MAX_SAMPLE_GAP_MS = 5_000;

export function startHostMeasurement({
  platform = process.platform,
  logicalCpuCount = os.cpus().length,
  readLoad = () => os.loadavg(),
  now = () => performance.now(),
  schedule = setInterval,
  cancel = clearInterval,
} = {}) {
  const started = now();
  const record = {
    version: 1,
    platform,
    logicalCpuCount,
    intervalMs: INTERVAL_MS,
    samples: [],
    errors: [],
  };
  const sample = () => {
    try {
      record.samples.push({
        elapsedMs: now() - started,
        loadAverage: readLoad(),
      });
    } catch (error) {
      record.errors.push(String(error));
    }
  };
  sample();
  const timer = schedule(sample, INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      cancel(timer);
      sample();
      return record;
    },
  };
}

export function assessHostMeasurement(record) {
  const reasons = [];
  if (
    record?.version !== 1 ||
    !['darwin', 'linux'].includes(record.platform) ||
    !Number.isInteger(record.logicalCpuCount) ||
    record.logicalCpuCount < 1 ||
    record.intervalMs !== INTERVAL_MS ||
    !Array.isArray(record.samples) ||
    record.samples.length < 2 ||
    !Array.isArray(record.errors) ||
    record.errors.length > 0
  ) {
    return {
      status: 'unknown',
      reasons: ['Host load evidence is missing, unsupported, or incomplete.'],
    };
  }
  let previous = 0;
  let maxLoadPerCpu = 0;
  for (const [index, sample] of record.samples.entries()) {
    const elapsed = sample?.elapsedMs;
    const loads = sample?.loadAverage;
    if (
      !Number.isFinite(elapsed) ||
      elapsed < previous ||
      elapsed - previous > MAX_SAMPLE_GAP_MS ||
      (index === 0 && elapsed > INTERVAL_MS) ||
      !Array.isArray(loads) ||
      loads.length !== 3 ||
      loads.some((value) => !Number.isFinite(value) || value < 0)
    ) {
      return {
        status: 'unknown',
        reasons: [
          'Host load samples are invalid or have a gap over 5 seconds.',
        ],
      };
    }
    maxLoadPerCpu = Math.max(maxLoadPerCpu, loads[0] / record.logicalCpuCount);
    previous = elapsed;
  }
  if (maxLoadPerCpu >= 1)
    reasons.push(
      `Host 1-minute load reached ${maxLoadPerCpu.toFixed(2)} per logical CPU (limit < 1.00); timing is inconclusive.`,
    );
  return {
    status: reasons.length ? 'contended' : 'valid',
    maxLoadPerCpu,
    reasons,
  };
}
