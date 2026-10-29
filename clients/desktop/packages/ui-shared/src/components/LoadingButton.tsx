import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';
import { SHARE_LANDER_BUTTON_CLASS_NAME } from '../lib/share-lander';
import { buttonClassName, type ButtonSize, type ButtonVariant } from './Button';
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
 * A button that reports its own async work.
 *
 * Codifies CAN-2349 decision 5, which `ConfirmDialog` already follows by hand:
 * every async step reports progress with a spinner rather than a bare label
 * swap, and the spinner renders INSIDE the button that started the work,
 * leading the label — so the affordance the user pressed is the thing that
 * reports progress.
 *
 * The spinner is `decorative`, because a descendant `aria-label` folds into the
 * accessible name the button computes from its contents; without it a busy
 * button announces as "Loading Adding…". `aria-busy` carries that signal
 * instead, and the button disables so the work cannot be started twice.
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
  let resolvedClassName: string;
  if (presentation === 'share-lander') {
    resolvedClassName = className
      ? `${SHARE_LANDER_BUTTON_CLASS_NAME} ${className}`
      : SHARE_LANDER_BUTTON_CLASS_NAME;
  } else {
    resolvedClassName = buttonClassName({ variant, size, className });
  }
  return (
    <button
      {...buttonProps}
      type={type}
      className={resolvedClassName}
      disabled={disabled || loading}
      aria-busy={loading}
    >
      {loading && (
        <LoadingSpinner
          className="shrink-0"
          dataTestId={spinnerTestId}
          decorative
        />
      )}
      {loading && loadingLabel !== undefined ? loadingLabel : children}
    </button>
  );
}
