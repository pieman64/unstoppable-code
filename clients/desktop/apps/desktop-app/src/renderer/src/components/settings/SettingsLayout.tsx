import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { replayBlockClassFor } from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  InlineTextSkeleton,
  SettingsControlSelect,
  SettingsFormSkeleton,
  TextInput,
  NoticeShapeProvider,
  SegmentedControl,
  type SettingsControlSelectProps,
  type SegmentedControlProps,
} from '@canopy/ui-shared/components';
import { BackIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  forwardRef,
  useContext,
  useRef,
  type InputHTMLAttributes,
  type JSX,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from 'react';
import {
  LOADING_PLACEHOLDER_DELAY_MS,
  useDelayedFlag,
} from '@canopy/ui-shared/lib';
import {
  SETTINGS_CHECK_INPUT_CLASS_NAME,
  SETTINGS_DROPDOWN_WIDTH_CLASS_NAME,
} from './settings-classes';
import { SettingsReplayPrivacyContext } from './settings-replay-privacy';

/**
 * The settings page kit. Every page in Settings composes these instead of
 * writing its own wrapper, heading, divider, row, or field classes.
 *
 * DESIGN.md: "A settings or creation flow groups related fields with
 * persistent labels, useful explanations, and clear separators between
 * notices, controls, and the work surface."
 *
 * The layout follows Linear's settings: a section is a heading over one
 * `SettingsGroup`, a rounded box whose rows are split by inset hairlines.
 * Each row is a label and a one-line hint on the leading side and one
 * control on the trailing side. Whitespace separates sections. The page
 * title and the section headings share the boxes' outer left edge.
 */

interface SettingsPageProps {
  readonly title: string;
  /** One line that says what the page controls. */
  readonly description?: ReactNode;
  /** A page-level control aligned with the title, such as a primary action. */
  readonly headerTrailing?: ReactNode;
  /**
   * Drill-in: a page showing one item of a list returns to the list with a
   * small back control above the title, named for the list.
   */
  readonly back?: {
    readonly label: string;
    readonly onClick: () => void;
  };
  readonly dataTestId?: string;
  readonly children?: ReactNode;
}

export function SettingsPage({
  title,
  description,
  headerTrailing,
  back,
  dataTestId,
  children,
}: SettingsPageProps): JSX.Element {
  // Session replay: the displayed section's classification, applied on the
  // page's content because it mounts with the section's content. The page
  // header stays recorded. Without a provider the content is blocked.
  const replayBlockClass = replayBlockClassFor(
    useContext(SettingsReplayPrivacyContext),
  );

  return (
    <div
      // One reading measure for every page: a 640px content column (704px
      // minus the side padding) that labels, hints, controls, and the few
      // tables all fit.
      className="mx-auto w-full max-w-176 px-8 pb-16 pt-8"
      data-testid={dataTestId}
    >
      <header
        // The title and the section headings share the group boxes' outer
        // left edge; only the rows' text is inset inside a box.
        className="mb-10 flex items-start justify-between gap-6"
      >
        <div className="min-w-0 flex-1 space-y-1">
          {back ? (
            <button
              type="button"
              onClick={back.onClick}
              data-testid="settings-page-back"
              className="focus-ring -ml-1 mb-2 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium fg-secondary transition-colors hover:fg-primary"
            >
              <BackIcon width={14} height={14} aria-hidden={true} />
              {back.label}
            </button>
          ) : null}
          <h1 className="text-xl font-medium fg-primary">{title}</h1>
          {description ? (
            <div className="text-s text-pretty fg-secondary">{description}</div>
          ) : null}
        </div>
        {headerTrailing ? (
          <div className="flex shrink-0 items-center gap-2">
            {headerTrailing}
          </div>
        ) : null}
      </header>
      <div
        className={
          replayBlockClass
            ? `${replayBlockClass} flex flex-col gap-10`
            : 'flex flex-col gap-10'
        }
      >
        {/* Early access: a banner between sections is a card among cards,
            with the same corners, and its glyph and buttons on the rows'
            16px inset. The provider stays mounted either way, so toggling
            early access does not remount the page and drop a pending save. */}
        <NoticeShapeProvider shape={'settings'}>{children}</NoticeShapeProvider>
      </div>
    </div>
  );
}

interface SettingsLoadingProps {
  /**
   * `form` stands in for setting rows. `spinner` is for a page whose shape
   * depends on what the load returns, such as a sign-in notice or a list.
   */
  readonly variant?: 'form' | 'spinner';
  /** Placeholder rows for `form`; match the rows the content usually has. */
  readonly rows?: number;
  readonly dataTestId?: string;
}

/**
 * The body of a settings page, section, or group whose data has not arrived
 * yet. Its space is held from the first render and it shows only after the
 * shared delay, so a fast load never flashes it. It has no visible text; the
 * placeholder announces "Loading" to assistive technology. Use it for the
 * first load only: a refetch keeps the content already on screen.
 */
export function SettingsLoading({
  variant = 'form',
  rows,
  dataTestId,
}: SettingsLoadingProps): JSX.Element {
  if (variant === 'spinner') {
    return (
      // The page body has no height of its own, so the spinner gets a region
      // to center in instead of sitting on the first line under the title.
      <div className="flex min-h-40 flex-col" data-testid={dataTestId}>
        <DelayedLoadingPlaceholder>
          <CenteredLoadingSpinner />
        </DelayedLoadingPlaceholder>
      </div>
    );
  }
  return (
    <div data-testid={dataTestId}>
      <DelayedLoadingPlaceholder>
        <SettingsFormSkeleton rows={rows} />
      </DelayedLoadingPlaceholder>
    </div>
  );
}

/**
 * A row's description or status line that has not arrived: one bar on the
 * text's own line, so the row keeps its height when the text lands. It shows
 * after the shared delay and announces "Loading" to assistive technology
 * only. It is inline, so it fits inside a description's text.
 */
export function SettingsDescriptionLoading({
  dataTestId,
}: {
  readonly dataTestId?: string;
}): JSX.Element {
  const visible = useDelayedFlag(true, LOADING_PLACEHOLDER_DELAY_MS);
  return (
    <span
      role="status"
      data-testid={dataTestId}
      className={visible ? undefined : 'invisible'}
    >
      <span className="sr-only">Loading</span>
      <InlineTextSkeleton active className="w-40" />
    </span>
  );
}

/**
 * An unavailable or error body that keeps the page's title in place. A page
 * that is still loading renders `SettingsLoading` instead.
 */
export function SettingsPageMessage({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return <p className="text-s fg-secondary">{children}</p>;
}

interface SettingsSectionProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly headingId?: string;
  readonly ariaLabel?: string;
  readonly dataTestId?: string;
  readonly children?: ReactNode;
}

/**
 * One group of related settings: the heading sits over the section's box,
 * on the box's outer left edge, and whitespace alone separates sections.
 * The heading holds only text. Every action lives in a row inside the box,
 * so no control floats outside it.
 */
export function SettingsSection({
  title,
  description,
  headingId,
  ariaLabel,
  dataTestId,
  children,
}: SettingsSectionProps): JSX.Element {
  const hasHeader = Boolean(title || description);
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby={title && headingId ? headingId : undefined}
      aria-label={ariaLabel}
      data-testid={dataTestId}
    >
      {hasHeader ? (
        <div className="space-y-1">
          {title ? (
            <h2 id={headingId} className="text-m font-medium fg-primary">
              {title}
            </h2>
          ) : null}
          {description ? (
            <div className="text-xs text-pretty fg-secondary">
              {description}
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

interface SettingsGroupProps {
  readonly children?: ReactNode;
  readonly dataTestId?: string;
  readonly ariaLabel?: string;
  /** Dims and blocks the rows while a parent setting turns them off. */
  readonly disabled?: boolean;
  /**
   * Block the box's rows from session replay, for rows that render user
   * content such as instruction text. The section heading above the box
   * stays recorded. Set it from mount; the recorder ignores a block class
   * added to an element it has already recorded.
   */
  readonly blockFromReplay?: boolean;
}

/**
 * The box a section's rows live in: the secondary surface with a hairline
 * edge. Every direct child is one row: it gets the row's vertical padding,
 * and an inset hairline splits it from the row above.
 */
export function SettingsGroup({
  children,
  dataTestId,
  ariaLabel,
  disabled,
  blockFromReplay = false,
}: SettingsGroupProps): JSX.Element {
  return (
    <div
      role={ariaLabel ? 'group' : undefined}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      data-testid={dataTestId}
      className={`${blockFromReplay ? `${POSTHOG_REPLAY_BLOCK_CLASS} ` : ''}flex flex-col divide-y rounded-lg bg-secondary px-4 ring-[length:var(--border-hairline)] ring-line-base *:py-3 ${
        disabled ? 'pointer-events-none opacity-50' : ''
      }`}
    >
      {/* A notice inside a row is part of that row's content, not a card.
          Always mounted, so toggling early access keeps the rows' state. */}
      <NoticeShapeProvider shape="default">{children}</NoticeShapeProvider>
    </div>
  );
}

// Targets in a row's text that keep their own click: links, buttons, fields,
// and a label already naming its control.
/**
 * Targets that keep their own click: controls, links, labels that already
 * name a control, and the code values settings text leaves selectable.
 */
const ROW_TEXT_OWN_CLICK_SELECTOR =
  'a, button, input, select, textarea, label[for], [role="button"], [role="link"], code, pre, .font-mono';

const ROW_TOGGLE_SELECTOR = '[role="switch"], input[type="checkbox"]';

/**
 * Settings text is not selectable, so a click on a row's label or
 * explanation flips the row's switch, as if it had landed on the switch. Only
 * a row with exactly one switch or checkbox does this; with more, a click on
 * the text could mean either.
 */
function useRowToggleClick(): {
  readonly controlRef: RefObject<HTMLDivElement | null>;
  readonly onRowClick: (event: MouseEvent<HTMLDivElement>) => void;
} {
  const controlRef = useRef<HTMLDivElement>(null);
  const onRowClick = (event: MouseEvent<HTMLDivElement>): void => {
    const control = controlRef.current;
    const target = event.target;
    if (!control || !(target instanceof Element) || control.contains(target)) {
      return;
    }
    // A double or triple click repeats the first press, and a click that ends
    // a drag-select is selecting text, not asking for the switch.
    const selection = target.ownerDocument.defaultView?.getSelection();
    if (event.detail > 1 || (selection && !selection.isCollapsed)) {
      return;
    }
    const ownClickTarget = target.closest(ROW_TEXT_OWN_CLICK_SELECTOR);
    if (ownClickTarget && event.currentTarget.contains(ownClickTarget)) {
      return;
    }
    const toggles = control.querySelectorAll<HTMLElement>(ROW_TOGGLE_SELECTOR);
    const toggle = toggles.length === 1 ? toggles[0] : undefined;
    if (
      !toggle ||
      toggle.matches(':disabled') ||
      toggle.getAttribute('aria-disabled') === 'true'
    ) {
      return;
    }
    toggle.click();
  };
  return { controlRef, onRowClick };
}

interface SettingsRowProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** The row's control, aligned to the trailing edge. */
  readonly control?: ReactNode;
  /** Id of the control the label names, so clicking the label activates it. */
  readonly htmlFor?: string;
  readonly labelId?: string;
  readonly dataTestId?: string;
  /**
   * Content under the label that belongs to this row: an editor, a status
   * line, or `SettingsSubRow`s for settings that depend on this one.
   */
  readonly children?: ReactNode;
}

/**
 * One setting: its label and explanation on the leading side, its control on
 * the trailing side. The label keeps the primary ink at the heavier weight;
 * the explanation takes the secondary ink.
 */
export function SettingsRow({
  label,
  description,
  control,
  htmlFor,
  labelId,
  dataTestId,
  children,
}: SettingsRowProps): JSX.Element {
  const labelClassName = 'block text-s font-medium fg-primary';
  const { controlRef, onRowClick } = useRowToggleClick();
  return (
    <div className="flex flex-col gap-3" data-testid={dataTestId}>
      <div
        className="flex min-h-10 items-center justify-between gap-6"
        onClick={onRowClick}
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          {htmlFor ? (
            <label
              id={labelId}
              htmlFor={htmlFor}
              className={labelClassName}
              data-settings-row-label=""
            >
              {label}
            </label>
          ) : (
            <div
              id={labelId}
              className={labelClassName}
              data-settings-row-label=""
            >
              {label}
            </div>
          )}
          {description ? (
            <div className="text-xs text-pretty fg-secondary">
              {description}
            </div>
          ) : null}
        </div>
        {control ? (
          <div ref={controlRef} className="flex shrink-0 items-center gap-2">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

interface SettingsSubRowProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly control?: ReactNode;
  readonly htmlFor?: string;
  readonly dataTestId?: string;
  readonly children?: ReactNode;
}

/**
 * A setting that depends on the row it sits in, such as the maximum behind a
 * "Limit…" switch. It goes in the parent `SettingsRow`'s children, so no
 * hairline splits it from its parent; its label takes the regular weight so
 * the parent stays the row's heading.
 */
export function SettingsSubRow({
  label,
  description,
  control,
  htmlFor,
  dataTestId,
  children,
}: SettingsSubRowProps): JSX.Element {
  const labelClassName = 'block text-s fg-primary';
  const { controlRef, onRowClick } = useRowToggleClick();
  return (
    <div className="flex flex-col gap-2" data-testid={dataTestId}>
      <div
        className="flex min-h-10 items-center justify-between gap-6"
        onClick={onRowClick}
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          {htmlFor ? (
            <label htmlFor={htmlFor} className={labelClassName}>
              {label}
            </label>
          ) : (
            <div className={labelClassName}>{label}</div>
          )}
          {description ? (
            <div className="text-xs text-pretty fg-secondary">
              {description}
            </div>
          ) : null}
        </div>
        {control ? (
          <div ref={controlRef} className="flex shrink-0 items-center gap-2">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// Fields share the control height and label size of the settings buttons.
// `border-<color>` is inert under the unlayered base border rule (CAN-2734),
// so the edge is a ring; an invalid field (`aria-invalid`) takes the
// destructive edge.
const FIELD_SURFACE_CLASS_NAME =
  'focus-ring rounded-md bg-base fg-primary ring-[length:var(--border-hairline)] ring-inset placeholder:fg-tertiary disabled:cursor-not-allowed disabled:opacity-60';

function fieldEdgeClassName(
  invalid: InputHTMLAttributes<HTMLInputElement>['aria-invalid'],
): string {
  return invalid === true || invalid === 'true'
    ? 'ring-line-destructive'
    : 'ring-line-secondary';
}

type SettingsFieldWidth = 'xs' | 'sm' | 'md' | 'full';

const FIELD_WIDTH_CLASS_NAMES: Record<SettingsFieldWidth, string> = {
  xs: 'w-20',
  sm: 'w-52',
  md: 'w-52',
  full: 'w-full',
};

export interface SettingsTextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'className' | 'size'
> {
  /** Sized to the value it holds: a number, a name, a path. */
  readonly width?: SettingsFieldWidth;
  /** Monospace, for code the user types: a glob, a command, a pattern. */
  readonly mono?: boolean;
}

/** A one-line text, number, or secret field at the settings control height. */
export const SettingsTextField = forwardRef<
  HTMLInputElement,
  SettingsTextFieldProps
>(function SettingsTextField(
  { width = 'sm', mono = false, ...props },
  ref,
): JSX.Element {
  return (
    <span className={`inline-flex shrink-0 ${FIELD_WIDTH_CLASS_NAMES[width]}`}>
      <TextInput ref={ref} {...props} density="settings" mono={mono} />
    </span>
  );
});

export interface SettingsTextAreaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'className'
> {
  /** Monospace, for code the user types. */
  readonly mono?: boolean;
}

/** Multi-line writing, such as instructions, at reading size. */
export const SettingsTextArea = forwardRef<
  HTMLTextAreaElement,
  SettingsTextAreaProps
>(function SettingsTextArea({ mono = false, ...props }, ref): JSX.Element {
  return (
    <textarea
      ref={ref}
      {...props}
      className={`block w-full resize-none px-2.5 py-2 text-s ${mono ? 'font-mono' : ''} ${FIELD_SURFACE_CLASS_NAME} ${fieldEdgeClassName(props['aria-invalid'])}`}
    />
  );
});

type SettingsSelectWidth = 'control' | 'fit' | 'fill';

export interface SettingsSelectProps extends Omit<
  SettingsControlSelectProps,
  'fill'
> {
  /**
   * `control` (default): the compact 144px dropdown column, matching Appearance.
   * `fit`: the chosen label's width, for a dropdown inside a sentence.
   * `fill`: the parent's width, for a column the caller sizes.
   */
  readonly width?: SettingsSelectWidth;
}

/**
 * The settings dropdown: the shared control select (a native `<select>` on
 * the same 28px capsule as the settings buttons) at the settings
 * control column width.
 */
export const SettingsSelect = forwardRef<
  HTMLSelectElement,
  SettingsSelectProps
>(function SettingsSelect({ width = 'control', ...props }, ref): JSX.Element {
  if (width === 'fit') return <SettingsControlSelect ref={ref} {...props} />;
  if (width === 'fill')
    return <SettingsControlSelect ref={ref} fill {...props} />;
  return (
    <span
      className={`inline-flex shrink-0 ${SETTINGS_DROPDOWN_WIDTH_CLASS_NAME}`}
    >
      <SettingsControlSelect ref={ref} fill {...props} />
    </span>
  );
});

export interface SettingsRadioOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly disabled?: boolean;
  readonly dataTestId?: string;
}

interface SettingsRadioGroupProps<T extends string> {
  readonly name: string;
  readonly value: T | null;
  readonly options: readonly SettingsRadioOption<T>[];
  readonly onChange: (next: T) => void;
  /** Accessible name for the group. */
  readonly label: string;
  readonly disabled?: boolean;
  readonly dataTestId?: string;
}

/**
 * A choice between options that each need a sentence of explanation. Native
 * radios in the theme accent; the label takes the primary ink and the
 * explanation the secondary ink under it.
 */
export function SettingsRadioGroup<T extends string>({
  name,
  value,
  options,
  onChange,
  label,
  disabled,
  dataTestId,
}: SettingsRadioGroupProps<T>): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={dataTestId}
      className="flex flex-col gap-3"
    >
      {options.map((option) => (
        <label
          key={option.value}
          className={`flex items-start gap-2.5 ${
            disabled || option.disabled ? 'opacity-60' : 'cursor-pointer'
          }`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled || option.disabled}
            onChange={() => onChange(option.value)}
            data-testid={option.dataTestId}
            className={`mt-0.5 ${SETTINGS_CHECK_INPUT_CLASS_NAME}`}
          />
          <span className="min-w-0 space-y-0.5">
            <span className="block text-s font-medium fg-primary">
              {option.label}
            </span>
            {option.description ? (
              <span className="block text-xs text-pretty fg-secondary">
                {option.description}
              </span>
            ) : null}
          </span>
        </label>
      ))}
    </div>
  );
}

interface SettingsOptionCardProps {
  readonly selected: boolean;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** Stretch across every column of the option grid. */
  readonly fullWidth?: boolean;
  /** A picture of the option, drawn above its label. */
  readonly preview?: ReactNode;
  readonly dataTestId?: string;
}

// `border-<color>` utilities are inert under the unlayered base border rule
// (CAN-2734), so the resting and selected outlines are rings.
const OPTION_CARD_SELECTED_CLASS_NAME =
  'bg-accent-subtle ring-1 ring-line-accent';
const OPTION_CARD_RESTING_CLASS_NAME =
  'bg-secondary ring-[length:var(--border-hairline)] ring-line-base hover:ring-line-secondary';

/**
 * One choice in a small set of mutually exclusive options that each need a
 * sentence of explanation or a preview. Selection is the accent outline on
 * the accent-subtle surface, the same for every option grid in Settings.
 */
export function SettingsOptionCard({
  selected,
  label,
  description,
  onSelect,
  disabled,
  fullWidth,
  preview,
  dataTestId,
}: SettingsOptionCardProps): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      data-testid={dataTestId}
      className={`focus-ring flex flex-col rounded-lg p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        preview ? 'items-center gap-2 text-center' : ''
      } ${fullWidth ? 'col-span-full' : ''} ${
        selected
          ? OPTION_CARD_SELECTED_CLASS_NAME
          : OPTION_CARD_RESTING_CLASS_NAME
      }`}
    >
      {preview}
      <span className="block text-s font-medium fg-primary">{label}</span>
      {description ? (
        <span className="mt-1 block text-xs text-pretty fg-secondary">
          {description}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Two or three short, mutually exclusive choices that switch a mode in place
 * (Append / Replace, CLI / token): the shared segmented picker at the width
 * of the settings control column. Each segment is a toggle button
 * (`aria-pressed`) inside a labelled group.
 */
export function SettingsSegmentedControl<T extends string>(
  props: Omit<SegmentedControlProps<T>, 'semantics' | 'width' | 'shape'>,
): JSX.Element {
  // Early access: the capsule of the compact Settings buttons.
  const shape = 'capsule';
  return <SegmentedControl {...props} width="control" shape={shape} />;
}
