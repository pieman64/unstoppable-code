'use client';

import { useId, useState, type JSX, type ReactNode } from 'react';
import {
  ChevronDownMediumIcon,
  ChevronRightMediumIcon,
} from '../icons/AppIcons';

/**
 * - `inline`: a quiet text toggle with the body under it (Advanced, Setup
 *   logs, Show details). Its chevron leads the label and turns down when
 *   open.
 * - `box`: a section in a hairline box whose title row opens it. Its chevron
 *   sits at the row's right edge and turns up when open (design call 2B,
 *   2026-11-01).
 */
export type DisclosureVariant = 'inline' | 'box';

export interface DisclosureProps {
  /** What the body holds, in sentence case (`Advanced`, `Setup logs`). */
  readonly label: ReactNode;
  readonly children?: ReactNode;
  readonly variant?: DisclosureVariant;
  /**
   * A non-default choice inside, named beside the closed label so closing
   * the disclosure never hides it (for example `Private memory on`).
   */
  readonly hint?: ReactNode;
  /** Quiet text at the end of a `box` title row (`3 sources`). */
  readonly meta?: ReactNode;
  /** A 12–16px mark after the chevron. Decorative: the label names it. */
  readonly leadingIcon?: ReactNode;
  /** Uncontrolled start state. */
  readonly defaultOpen?: boolean;
  /** Controlled state; pass `onOpenChange` with it. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * Keep the body in the DOM while closed, hidden, so its state survives and
   * find-in-page reaches it. Off by default: a closed body is not rendered.
   */
  readonly keepMounted?: boolean;
  /** Root test id; the toggle and body append `-toggle` / `-body`. */
  readonly dataTestId?: string;
  /** Overrides the toggle's test id, for hosts whose specs key on their own. */
  readonly toggleTestId?: string;
  /** Placement only. The disclosure owns its own look. */
  readonly className?: string;
}

/**
 * The chevron's 16px slot. The medium chevron draws its glyph inside that
 * box, so the slot centers it in the same 16px column as a row's or card's
 * icon above or beside the toggle.
 */
const CHEVRON_SLOT_CLASS =
  'inline-flex size-4 shrink-0 items-center justify-center';

const CHEVRON_CLASS =
  'shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none';

const TOGGLE_CLASS: Readonly<Record<DisclosureVariant, string>> = {
  inline:
    'focus-ring inline-flex max-w-full items-center gap-1 rounded-md py-0.5 pr-1 text-left text-xs font-medium fg-secondary hover:fg-primary',
  box: 'focus-ring flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left text-s font-medium fg-primary hover:bg-subtle',
};

const ROOT_CLASS: Readonly<Record<DisclosureVariant, string>> = {
  inline: 'flex min-w-0 flex-col gap-2',
  box: 'min-w-0 rounded-lg ring-[length:var(--border-hairline)] ring-line-base',
};

const BODY_CLASS: Readonly<Record<DisclosureVariant, string>> = {
  inline: 'flex min-w-0 flex-col gap-2',
  box: 'flex min-w-0 flex-col gap-2 px-4 pb-3',
};

/**
 * The one "show more" control on desktop and web: a toggle with a chevron
 * and the body it reveals. Only optional
 * or secondary content belongs inside; anything that blocks the surrounding
 * action stays outside, always visible.
 */
export function Disclosure({
  label,
  children,
  variant = 'inline',
  hint,
  meta,
  leadingIcon,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  keepMounted = false,
  dataTestId = 'disclosure',
  toggleTestId,
  className,
}: DisclosureProps): JSX.Element {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = openProp ?? uncontrolledOpen;
  const bodyId = useId();
  const showBody = open || keepMounted;
  const toggle = (): void => {
    if (openProp === undefined) setUncontrolledOpen(!open);
    onOpenChange?.(!open);
  };
  return (
    <div
      className={
        className ? `${ROOT_CLASS[variant]} ${className}` : ROOT_CLASS[variant]
      }
      data-testid={dataTestId}
      data-state={open ? 'open' : 'closed'}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={showBody ? bodyId : undefined}
        data-testid={toggleTestId ?? `${dataTestId}-toggle`}
        className={TOGGLE_CLASS[variant]}
        onClick={toggle}
      >
        {variant === 'inline' ? (
          <span className={CHEVRON_SLOT_CLASS}>
            <ChevronRightMediumIcon
              size="md"
              aria-hidden="true"
              className={`${CHEVRON_CLASS}${open ? ' rotate-90' : ''}`}
            />
          </span>
        ) : null}
        {leadingIcon ? (
          <span aria-hidden="true" className="flex shrink-0 items-center">
            {leadingIcon}
          </span>
        ) : null}
        <span
          className={variant === 'box' ? 'min-w-0 flex-1 truncate' : 'min-w-0'}
        >
          {label}
          {!open && hint ? (
            <span className="font-normal fg-tertiary">
              {' · '}
              {hint}
            </span>
          ) : null}
        </span>
        {meta ? (
          <span className="shrink-0 text-xs font-normal fg-tertiary">
            {meta}
          </span>
        ) : null}
        {variant === 'box' ? (
          <span className={CHEVRON_SLOT_CLASS}>
            <ChevronDownMediumIcon
              size="md"
              aria-hidden="true"
              className={`${CHEVRON_CLASS} fg-secondary${open ? ' rotate-180' : ''}`}
            />
          </span>
        ) : null}
      </button>
      {showBody ? (
        <div
          id={bodyId}
          hidden={!open}
          // A display class would override `hidden`, so a closed body has none.
          className={open ? BODY_CLASS[variant] : undefined}
          data-testid={`${dataTestId}-body`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
