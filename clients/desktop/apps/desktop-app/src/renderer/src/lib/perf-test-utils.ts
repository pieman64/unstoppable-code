function getNow(): number {
  if (typeof performance !== 'undefined') {
    return performance.now();
  }

  return Date.now();
}

export function measureDurationMs(fn: () => void): number {
  const startedAt = getNow();
  fn();
  return getNow() - startedAt;
}
