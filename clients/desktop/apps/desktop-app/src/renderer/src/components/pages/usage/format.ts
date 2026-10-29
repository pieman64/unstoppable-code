export function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function formatCurrencyUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const fractionDigits = abs > 0 && abs < 0.01 ? 4 : 2;
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function formatCompactCurrencyUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs > 0 && abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatDurationMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

export interface TrendDelta {
  text: string;
  tone: 'up' | 'down' | 'flat';
}

export function computeTrendDelta(
  current: number | undefined,
  prior: number | undefined,
): TrendDelta {
  if (current === undefined || prior === undefined) {
    return { text: '—', tone: 'flat' };
  }
  if (prior === 0) {
    return current === 0
      ? { text: '—', tone: 'flat' }
      : { text: 'new', tone: 'up' };
  }
  const ratio = ((current - prior) / prior) * 100;
  const sign = ratio >= 0 ? '↑' : '↓';
  return {
    text: `${sign} ${Math.abs(ratio).toFixed(0)}%`,
    tone: ratio === 0 ? 'flat' : ratio > 0 ? 'up' : 'down',
  };
}

export function formatStartingDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
