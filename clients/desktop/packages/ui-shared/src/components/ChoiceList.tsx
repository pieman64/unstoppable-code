import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';
import { HAIRLINE_INSET_RING_CLASS } from '../lib/row-chips';
import { ChoiceMark } from './Choice';

/**
 * A short list of choices the person ticks in place (projects to index,
 * owners an agent may act for, roles in a profile), shared by desktop and
 * web.
 *
 * - Box: a hairline inset edge on the 8px radius, with hairline dividers
 *   between rows. It scrolls when the caller caps its height.
 * - Row: a whole-row button that toggles one choice, its `ChoiceMark` leading.
 *   Selection is the mark alone (a neutral fill and a check); the row takes
 *   no accent and no selected fill. Hover and keyboard focus still highlight.
 */
export interface ChoiceListProps {
  /** Accessible name of the group: `Projects`, `Owners`. */
  readonly 'aria-label': string;
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
  /** Placement and height only (`max-h-72`, margins). */
  readonly className?: string;
}

export function ChoiceList({
  'aria-label': ariaLabel,
  children,
  'data-testid': dataTestId,
  className = '',
}: ChoiceListProps): JSX.Element {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={dataTestId}
      className={`flex flex-col divide-y overflow-y-auto rounded-lg ${HAIRLINE_INSET_RING_CLASS} ring-line-base ${className}`}
    >
      {children}
    </div>
  );
}

export interface ChoiceListRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'aria-pressed' | 'className' | 'children'
> {
  readonly selected: boolean;
  /** `checkbox` (default) for many choices, `radio` for one. */
  readonly kind?: 'checkbox' | 'radio';
  /** The row's text: one line, or a name over a quieter detail. */
  readonly children: ReactNode;
  /** A quiet note or badge at the row's trailing edge. */
  readonly trailing?: ReactNode;
  /** A glyph or avatar between the mark and the text. */
  readonly leading?: ReactNode;
}

/** One choice: the mark, the text, and an optional trailing note. */
export function ChoiceListRow({
  selected,
  kind = 'checkbox',
  children,
  trailing,
  leading,
  disabled,
  ...props
}: ChoiceListRowProps): JSX.Element {
  return (
    <button
      {...props}
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      className="focus-ring flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-s fg-primary transition-colors hover:bg-subtle focus-visible:bg-subtle disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
    >
      <ChoiceMark kind={kind} checked={selected} />
      {leading}
      <span className="min-w-0 flex-1">{children}</span>
      {trailing ? (
        <span className="shrink-0 text-xs fg-secondary">{trailing}</span>
      ) : null}
    </button>
  );
}
