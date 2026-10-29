/**
 * Shared status-display helpers for hook and script source-info layers.
 * Lives next to {@link SourceInfoLayers} but in a non-component file so the
 * `react-refresh/only-export-components` rule keeps the JSX-bearing module
 * exporting only React components.
 */

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  overridden: 'Overridden',
  disabled: 'Disabled',
  absent: 'Not defined',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'fg-success-strong',
  overridden: 'fg-warning',
  disabled: 'fg-destructive-strong',
  absent: 'fg-secondary/60',
};

/**
 * Map a four-state status (`active` | `overridden` | `disabled` | `absent`)
 * to its display label. Returns the input string unchanged when an unknown
 * status is passed.
 */
export function getSourceLayerStatusLabel<S extends string>(status: S): string {
  return STATUS_LABELS[status] ?? status;
}

/** Tailwind text-color class for the same status set. */
export function getSourceLayerStatusColor<S extends string>(status: S): string {
  return STATUS_COLORS[status] ?? 'fg-primary/80';
}
