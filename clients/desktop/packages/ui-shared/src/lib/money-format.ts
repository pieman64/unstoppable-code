// Pure money-formatting helpers shared between the desktop renderer and the web
// app. Standard Intl/Math APIs only — no Node, Electron, or Next dependencies.

/** Compact a number to a K/M/B suffix while keeping small values exact. */
export function compactNumber(value: number, fractionDigits: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) {
    return Number.isInteger(value)
      ? value.toLocaleString('en-US')
      : value.toFixed(fractionDigits);
  }
  // Largest-first so we pick the biggest fitting unit.
  const units: ReadonlyArray<{ threshold: number; suffix: string }> = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' },
  ];
  for (let i = 0; i < units.length; i++) {
    const { threshold, suffix } = units[i];
    if (abs < threshold) {
      continue;
    }
    const scaled = (value / threshold).toFixed(fractionDigits);
    // Rounding to `fractionDigits` can carry a value just under the next unit
    // into it (e.g. 999_999_999 -> "1000.00M"). When a larger unit exists,
    // promote so we render "1.00B" instead of "1000.00M".
    if (Math.abs(parseFloat(scaled)) >= 1000 && i > 0) {
      const bigger = units[i - 1];
      return `${(value / bigger.threshold).toFixed(fractionDigits)}${bigger.suffix}`;
    }
    return `${scaled}${suffix}`;
  }
  return value.toFixed(fractionDigits);
}

/** Format a USD amount with a sensible precision for the magnitude. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return '$0.00';
  }
  const abs = Math.abs(value);
  if (abs !== 0 && abs < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  if (abs < 1000) {
    return `$${value.toFixed(2)}`;
  }
  return `$${compactNumber(value, 2)}`;
}

// Locale is pinned for the same reason `compactNumber` pins it: these values
// are rendered during SSR and again on hydration, so resolving the grouping
// from the ambient locale would let a server and a browser disagree about the
// same number.
const USD_EXACT_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const COUNT_EXACT_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});
const IMPACT_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
});

/**
 * Format a USD amount in full, with thousands separators.
 *
 * Sibling of `formatUsd` rather than a replacement for it: `formatUsd` compacts
 * at >= $1,000 (`$6.66K`), which is the right call for the dense Statistics
 * tables and charts but loses the cents a headline figure is showing. Use this
 * where the exact amount is the point. The small-value rule is shared so a
 * near-zero period does not render as `$0.00`.
 */
export function formatUsdExact(value: number): string {
  if (!Number.isFinite(value)) {
    return '$0.00';
  }
  const abs = Math.abs(value);
  if (abs !== 0 && abs < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${USD_EXACT_FORMATTER.format(value)}`;
}

/** Format an integer count with pinned-locale thousands separators. */
export function formatCountExact(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return COUNT_EXACT_FORMATTER.format(value);
}

/**
 * Format an impact score to a single decimal place.
 *
 * Impact scores are fractional, so formatting them as counts let the same
 * value render differently on two surfaces that are meant to agree (the digest
 * Team list showed `17.457` where the Statistics People table showed `17.5`).
 * Both now call this, so the shared-leaderboard guarantee holds visually and
 * not just numerically.
 */
export function formatImpactScore(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return IMPACT_FORMATTER.format(value);
}
