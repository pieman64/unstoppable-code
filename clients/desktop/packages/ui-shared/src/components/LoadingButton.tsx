import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';
import { SHARE_LANDER_BUTTON_CLASS_NAME } from '../lib/share-lander';
import {
  Button,
  isAriaDisabled,
  swallowUnavailableClick,
  type ButtonSize,
  type ButtonVariant,
} from './Button';
import { LoadingSpinner } from './LoadingSpinner';

/**
 * `app` is the house pill, shaped by `variant` and `size`. `share-lander`
 * REPLACES that recipe with the public landers' squared control rather than
 * appending to it, because appending cannot win: Tailwind emits `rounded-md`
 * and `rounded-full` at equal specificity, so which one paints depends on
 * stylesheet order, not on class order.
 */
export type LoadingButtonPresentation = 'app' | 'share-lander';

export interface LoadingButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  /** Whether the work this button started is still running. */
  readonly loading?: boolean;
  /** Label while loading. Defaults to the resting label. */
  readonly loadingLabel?: ReactNode;
  /** Test hook for the spinner, scoped inside this button. */
  readonly spinnerTestId?: string;
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly presentation?: LoadingButtonPresentation;
  /** Placement only; the presentation owns everything else. */
  readonly className?: string;
}

/**
 * Both labels share one grid cell, so the button is as wide as the wider of
 * them from the first render and never changes width when it turns busy.
 * Each layer keeps its presentation's own gap between spinner and label.
 */
const LAYER_CLASS_NAMES: Record<LoadingButtonPresentation, string> = {
  app: 'col-start-1 row-start-1 inline-flex min-w-0 items-center justify-center gap-1.5',
  'share-lander':
    'col-start-1 row-start-1 inline-flex min-w-0 items-center justify-center gap-2',
};

/**
 * The spinner's footprint while the button rests: the dot grid's 10px box,
 * so the busy layer reserves the spinner's room without running it.
 */
const SPINNER_SPACER_CLASS_NAME = 'inline-block size-2.5 shrink-0';

/** A label made only of text and numbers, as one string; otherwise `null`. */
function plainText(label: ReactNode): string | null {
  if (typeof label === 'string' || typeof label === 'number') {
    return String(label);
  }
  if (!Array.isArray(label)) return null;
  let text = '';
  for (const part of label) {
    if (typeof part !== 'string' && typeof part !== 'number') return null;
    text += String(part);
  }
  return text;
}

/**
 * The label of the layer that is not showing, there only to hold its width.
 * A text label is drawn by CSS from an attribute, so it adds no text to the
 * DOM: queries and the button's text content see the showing label alone.
 */
export function ReservedLabel({
  label,
}: {
  readonly label: ReactNode;
}): JSX.Element {
  const text = plainText(label);
  if (text !== null) {
    return (
      <span
        aria-hidden="true"
        data-reserved-label={text}
        className="canopy-reserved-label whitespace-pre"
      />
    );
  }
  return <span aria-hidden="true">{label}</span>;
}

/**
 * A button that reports its own async work.
 *
 * Codifies CAN-2349 decision 5, which `ConfirmDialog` already follows by hand:
 * every async step reports progress with a spinner rather than a bare label
 * swap, and the spinner renders INSIDE the button that started the work,
 * leading the label — so the affordance the user pressed is the thing that
 * reports progress.
 *
 * The resting label and the busy one (spinner plus `loadingLabel`, the verb
 * in progress) are laid out on top of each other, so the button keeps one
 * width whether it rests or works and nothing beside it moves. Only the
 * visible layer is exposed to assistive technology.
 *
 * The spinner is `decorative`, because a descendant `aria-label` folds into the
 * accessible name the button computes from its contents; without it a busy
 * button announces as "Loading Adding…". `aria-busy` carries that signal
 * instead. A busy button is `aria-disabled`, not `disabled`, so keyboard focus
 * stays on it while the work runs, and its click (or its form's submit) does
 * nothing, so the work cannot be started twice.
 */
export function LoadingButton({
  loading = false,
  loadingLabel,
  spinnerTestId,
  disabled,
  children,
  variant,
  size,
  presentation = 'app',
  className,
  type = 'button',
  ...buttonProps
}: LoadingButtonProps): JSX.Element {
  const onClick =
    loading || isAriaDisabled(buttonProps['aria-disabled'])
      ? swallowUnavailableClick
      : buttonProps.onClick;
  const content = (
    <BusyLayers
      busy={loading}
      busyLabel={loadingLabel}
      spinnerTestId={spinnerTestId}
      presentation={presentation}
    >
      {children}
    </BusyLayers>
  );
  if (presentation === 'share-lander') {
    // The public landers' squared control is not a house capsule, so it keeps
    // its own element and recipe.
    return (
      <button
        {...buttonProps}
        type={type}
        className={
          className
            ? `${SHARE_LANDER_BUTTON_CLASS_NAME} ${className}`
            : SHARE_LANDER_BUTTON_CLASS_NAME
        }
        disabled={disabled}
        aria-disabled={loading || buttonProps['aria-disabled']}
        aria-busy={loading}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }
  return (
    <Button
      {...buttonProps}
      type={type}
      variant={variant}
      size={size}
      className={className}
      disabled={disabled}
      aria-disabled={loading || buttonProps['aria-disabled']}
      aria-busy={loading}
      onClick={onClick}
    >
      {content}
    </Button>
  );
}

/**
 * The inside of a button that can turn busy: the resting label and the busy
 * one (spinner plus `busyLabel`) on top of each other in one grid cell, so
 * the button is as wide as the wider of them from the first render. Only
 * the showing layer is exposed to assistive technology. `LoadingButton` and
 * a busy-capable `NoticeButton` draw their labels through it; the button
 * itself still sets `aria-busy` and `disabled`.
 */
export function BusyLayers({
  busy,
  busyLabel,
  leading,
  spinnerTestId,
  presentation = 'app',
  children,
}: {
  readonly busy: boolean;
  /** Label while busy. Defaults to the resting label. */
  readonly busyLabel?: ReactNode;
  /** A glyph before the resting label; the spinner takes its place. */
  readonly leading?: ReactNode;
  readonly spinnerTestId?: string;
  readonly presentation?: LoadingButtonPresentation;
  readonly children: ReactNode;
}): JSX.Element {
  const layerClassName = LAYER_CLASS_NAMES[presentation];
  return (
    <span className="grid min-w-0">
      <span
        aria-hidden={busy ? true : undefined}
        className={`${layerClassName} ${busy ? 'invisible' : ''}`}
        data-busy-layer="rest"
      >
        {leading}
        {busy ? <ReservedLabel label={children} /> : children}
      </span>
      <span
        aria-hidden={busy ? undefined : true}
        className={`${layerClassName} ${busy ? '' : 'invisible'}`}
        data-busy-layer="busy"
      >
        {busy ? (
          <LoadingSpinner
            className="shrink-0"
            dataTestId={spinnerTestId}
            decorative
          />
        ) : (
          <span className={SPINNER_SPACER_CLASS_NAME} />
        )}
        {busy ? (
          (busyLabel ?? children)
        ) : (
          <ReservedLabel label={busyLabel ?? children} />
        )}
      </span>
    </span>
  );
}
