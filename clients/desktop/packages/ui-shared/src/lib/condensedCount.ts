// Pure count-condensing helper shared between the desktop renderer and the web
// app. Standard Math APIs only — no Node, Electron, or Next dependencies.

const CONDENSED_UNITS: ReadonlyArray<{ threshold: number; suffix: string }> = [
  { threshold: 1_000_000_000, suffix: 'B' },
  { threshold: 1_000_000, suffix: 'M' },
  { threshold: 1_000, suffix: 'k' },
];

/**
 * Condense a count into the shortest label that still names its bracket:
 * `1234` -> `1k`, `1234567` -> `1M`, `1234567890` -> `1B`.
 *
 * Digits below the chosen bracket are **truncated, never rounded**, so a value
 * just short of the next bracket reads as `999k` rather than being promoted to
 * `1M`. Values below 1,000 render every digit. Unlike
 * {@link compactNumber}, this never emits a fractional part — it is for tight
 * display surfaces (sidebar rows) where the exact value is offered on hover.
 */
export function formatCondensedCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.floor(Math.abs(value));
  for (const { threshold, suffix } of CONDENSED_UNITS) {
    if (magnitude >= threshold) {
      return `${sign}${Math.floor(magnitude / threshold)}${suffix}`;
    }
  }
  return `${sign}${magnitude}`;
}
