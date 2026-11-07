'use client';

import {
  forwardRef,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
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

export interface RailSectionHeaderFrameProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children'
> {
  readonly label: string;
  readonly resting?: boolean;
  readonly sticky?: boolean;
  readonly belowChats?: boolean;
  readonly kind: 'projects' | 'chats';
  readonly actions?: ReactNode;
  readonly expanded?: boolean;
  readonly returnToRows?: boolean;
  readonly touchTargets?: boolean;
  /** A host's sticky Chats band includes padding above the 32px label. */
  readonly labelSetsHeight?: boolean;
  readonly chevronTestId?: string;
  readonly toggleProps?: ButtonHTMLAttributes<HTMLButtonElement> &
    Record<`data-${string}`, string | undefined>;
}

/** The production Projects and Chats header, including disclosure geometry. */
export const RailSectionHeaderFrame = forwardRef<
  HTMLDivElement,
  RailSectionHeaderFrameProps
>(function RailSectionHeaderFrame(
  {
    label,
    kind,
    resting = false,
    sticky = true,
    belowChats = false,
    actions,
    expanded,
    returnToRows = false,
    touchTargets = false,
    labelSetsHeight = false,
    chevronTestId,
    toggleProps,
    className = '',
    ...attributes
  },
  ref,
): JSX.Element {
  const projects = kind === 'projects';
  const height = touchTargets ? 'min-h-11' : 'h-8';
  const labelContent = (
    <span
      className={
        projects
          ? 'shrink-0 translate-y-0.5 whitespace-nowrap'
          : 'min-w-0 truncate'
      }
    >
      {label}
    </span>
  );
  return (
    <div
      {...attributes}
      ref={ref}
      className={`group/rail-section group/section flex min-w-0 items-center gap-1 bg-sidebar px-1 ${projects ? 'sidebar-sticky-header group/workspaces z-10 shrink-0' : 'group/chats'} ${resting ? '' : 'group/sidebar-item'} ${sticky ? 'sticky' : ''} ${projects ? (belowChats ? (touchTargets ? 'top-11' : 'top-8') : 'top-0') : labelSetsHeight ? 'z-40 pt-3' : 'top-0 z-20'} ${labelSetsHeight ? '' : height} ${className}`}
    >
      {toggleProps ? (
        <button
          type="button"
          {...toggleProps}
          aria-expanded={returnToRows ? undefined : expanded}
          className={`focus-ring flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-left text-s font-normal fg-quaternary transition-colors hover:fg-secondary group-focus-within/rail-section:fg-secondary ${height}`}
        >
          {labelContent}
          <ChevronDownMediumIcon
            data-testid={chevronTestId}
            size="md"
            className={`shrink-0 ${projects ? 'translate-y-0.5 ' : ''}transition-[transform,opacity] group-hover/rail-section:opacity-100 group-focus-within/rail-section:opacity-100 ${
              returnToRows
                ? 'rotate-180 opacity-100'
                : expanded === false
                  ? '-rotate-90 opacity-100'
                  : 'opacity-0'
            }`}
          />
        </button>
      ) : (
        <span
          className={`flex min-w-0 flex-1 items-center px-1 text-s font-normal fg-quaternary ${height}`}
        >
          {labelContent}
        </span>
      )}
      {actions}
    </div>
  );
});

export interface NativeDisclosureProps extends Pick<
  DisclosureProps,
  | 'label'
  | 'children'
  | 'variant'
  | 'hint'
  | 'meta'
  | 'leadingIcon'
  | 'defaultOpen'
  | 'dataTestId'
  | 'toggleTestId'
  | 'className'
> {
  /** A quiet explanation below the label that stays visible while closed. */
  readonly description?: ReactNode;
  readonly [attribute: `data-${string}`]: string | undefined;
}

/**
 * The native disclosure for public server-rendered content. Its summary and
 * body are present in the initial HTML and toggle without JavaScript. The
 * browser owns the open state; the existing Disclosure recipes own its look.
 */
export function NativeDisclosure({
  label,
  children,
  variant = 'inline',
  hint,
  meta,
  leadingIcon,
  defaultOpen = false,
  dataTestId = 'native-disclosure',
  toggleTestId,
  className = '',
  description,
  ...dataAttributes
}: NativeDisclosureProps): JSX.Element {
  const rotation =
    variant === 'inline'
      ? '[&[open]>summary>[data-disclosure-chevron]]:rotate-90'
      : '[&[open]>summary>[data-disclosure-chevron]]:rotate-180';
  const chevron = (
    <span
      aria-hidden="true"
      data-disclosure-chevron=""
      className={`${CHEVRON_SLOT_CLASS} ${CHEVRON_CLASS}`}
    >
      {variant === 'inline' ? (
        <ChevronRightMediumIcon size="md" aria-hidden="true" />
      ) : (
        <ChevronDownMediumIcon
          size="md"
          aria-hidden="true"
          className="fg-secondary"
        />
      )}
    </span>
  );
  return (
    <details
      {...dataAttributes}
      open={defaultOpen}
      data-testid={dataTestId}
      className={`${ROOT_CLASS[variant]} ${rotation} [&[open]>summary_[data-disclosure-hint]]:hidden ${className}`}
    >
      <summary
        data-testid={toggleTestId ?? `${dataTestId}-toggle`}
        className={`${TOGGLE_CLASS[variant]} list-none [&::-webkit-details-marker]:hidden`}
      >
        {variant === 'inline' ? chevron : null}
        {leadingIcon ? (
          <span aria-hidden="true" className="flex shrink-0 items-center">
            {leadingIcon}
          </span>
        ) : null}
        <span className={variant === 'box' ? 'min-w-0 flex-1' : 'min-w-0'}>
          {label}
          {hint ? (
            <span data-disclosure-hint="" className="font-normal fg-tertiary">
              {' · '}
              {hint}
            </span>
          ) : null}
          {description ? (
            <span className="mt-0.5 block text-xs font-normal text-pretty fg-secondary">
              {description}
            </span>
          ) : null}
        </span>
        {meta ? (
          <span className="shrink-0 text-xs font-normal fg-tertiary">
            {meta}
          </span>
        ) : null}
        {variant === 'box' ? chevron : null}
      </summary>
      <div className={BODY_CLASS[variant]} data-testid={`${dataTestId}-body`}>
        {children}
      </div>
    </details>
  );
}
