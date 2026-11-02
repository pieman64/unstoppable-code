import type { JSX, ReactNode } from 'react';

/**
 * The live state of a provider connection, as a 10px dot beside its name in
 * a Settings row: `connected` green, `failed` red, `limited` amber (at a usage
 * limit), `pending` blue (signing in), `idle` grey (stopped or turned off),
 * and `signed-out` a hollow grey ring (nothing is wrong, it is just not
 * connected yet).
 */
export type ProviderStatusDotTone =
  | 'connected'
  | 'failed'
  | 'limited'
  | 'pending'
  | 'idle'
  | 'signed-out';

const DOT_TONE_CLASS: Readonly<Record<ProviderStatusDotTone, string>> = {
  connected: 'bg-success',
  failed: 'bg-destructive',
  limited: 'bg-warning',
  pending: 'bg-info',
  idle: 'bg-fg-tertiary',
  'signed-out': 'ring-1 ring-inset ring-fg-quaternary',
};

export interface ProviderStatusDotProps {
  readonly tone: ProviderStatusDotTone;
  /**
   * Names the state for assistive technology (`Ready`). Omit when the row's
   * text already says it; the dot is then decorative.
   */
  readonly label?: string;
  readonly 'data-testid'?: string;
  /** A host's own state name, kept on the dot for automation. */
  readonly 'data-status'?: string;
}

export function ProviderStatusDot({
  tone,
  label,
  'data-testid': dataTestId,
  'data-status': dataStatus,
}: ProviderStatusDotProps): JSX.Element {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      data-testid={dataTestId}
      data-status={dataStatus}
      data-tone={tone}
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT_TONE_CLASS[tone]}`}
    />
  );
}

export interface ProviderRowLabelProps {
  /** The provider's mark at 16px. */
  readonly icon?: ReactNode;
  readonly name: ReactNode;
  /** A `ProviderStatusDot`, or nothing while there is no connection to report. */
  readonly status?: ReactNode;
}

/** A provider's mark, name and status dot, as a Settings row label. */
export function ProviderRowLabel({
  icon,
  name,
  status,
}: ProviderRowLabelProps): JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {icon}
      {name}
      {status}
    </span>
  );
}
