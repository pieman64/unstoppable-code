export function percentile(values, percentileValue) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  if (finite.length === 1) return finite[0];

  const bounded = Math.min(1, Math.max(0, percentileValue));
  const position = (finite.length - 1) * bounded;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;
  return (
    finite[lowerIndex] + (finite[upperIndex] - finite[lowerIndex]) * weight
  );
}

export function summarize(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    return {
      count: 0,
      min: null,
      mean: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
    };
  }

  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    count: finite.length,
    min: Math.min(...finite),
    mean: total / finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
    max: Math.max(...finite),
  };
}

export function roundMetric(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function roundSummary(summary, digits = 3) {
  return Object.fromEntries(
    Object.entries(summary).map(([key, value]) => [
      key,
      typeof value === 'number' ? roundMetric(value, digits) : value,
    ]),
  );
}
