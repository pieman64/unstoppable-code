import type { JSX, ReactNode } from 'react';
import { LoadingButton } from '@canopy/ui-shared/components';

/** A second footer action between Cancel and the primary. */
export interface ShareFooterSecondaryAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly testId: string;
}

interface ShareFooterProps {
  onCancel: () => void;
  showCancel?: boolean;
  cancelLabel?: string;
  cancelDisabled?: boolean;
  cancelTestId?: string;
  cancelIntent?: 'default' | 'destructive';
  showPrimary: boolean;
  onSubmit: () => void;
  submitLabel: string;
  submitDisabled?: boolean;
  /** The primary's work is running: spinner inside the button, label swap. */
  loading?: boolean;
  /** Primary label while `loading`, e.g. `Sharing…`. */
  loadingLabel?: string;
  /** A generic second action, rendered before the primary. */
  secondaryAction?: ShareFooterSecondaryAction;
  /**
   * The footer's left side: the package stage while sharing, otherwise the
   * Copy link button when the resource has a link.
   */
  leading?: ReactNode;
  testIdPrefix: string;
  submitTestId?: string;
}

const QUIET_BUTTON_CLASS =
  'rounded-lg px-4 py-1.5 text-s fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary disabled:cursor-not-allowed disabled:opacity-40';
const DESTRUCTIVE_QUIET_BUTTON_CLASS =
  'rounded-lg px-4 py-1.5 text-s fg-destructive transition hover:bg-fg-primary/[0.06] disabled:cursor-not-allowed disabled:opacity-40';
const SECONDARY_BUTTON_CLASS =
  'rounded-lg ring-1 ring-inset ring-line-base px-4 py-1.5 text-s fg-primary transition hover:bg-fg-primary/[0.06] disabled:cursor-not-allowed disabled:opacity-40';

export function ShareFooter({
  onCancel,
  showCancel = true,
  cancelLabel = 'Cancel',
  cancelDisabled = false,
  cancelTestId,
  cancelIntent = 'default',
  showPrimary,
  onSubmit,
  submitLabel,
  submitDisabled = false,
  loading = false,
  loadingLabel,
  secondaryAction: secondary,
  leading,
  testIdPrefix,
  submitTestId,
}: ShareFooterProps): JSX.Element {
  return (
    <div
      className="flex items-center gap-2 border-t px-5 py-3"
      data-testid={`${testIdPrefix}-footer`}
    >
      <div className="flex min-w-0 flex-1 items-center">{leading}</div>
      {showCancel && (
        <button
          type="button"
          data-testid={cancelTestId}
          onClick={onCancel}
          disabled={cancelDisabled || loading}
          className={
            cancelIntent === 'destructive'
              ? DESTRUCTIVE_QUIET_BUTTON_CLASS
              : QUIET_BUTTON_CLASS
          }
        >
          {cancelLabel}
        </button>
      )}
      {secondary && (
        <button
          type="button"
          data-testid={secondary.testId}
          onClick={secondary.onClick}
          disabled={secondary.disabled === true || loading}
          className={SECONDARY_BUTTON_CLASS}
        >
          {secondary.label}
        </button>
      )}
      {showPrimary && (
        <LoadingButton
          variant="primary"
          size="md"
          data-testid={submitTestId ?? `${testIdPrefix}-submit`}
          onClick={onSubmit}
          disabled={submitDisabled}
          loading={loading}
          {...(loadingLabel !== undefined ? { loadingLabel } : {})}
          spinnerTestId={`${testIdPrefix}-submit-spinner`}
        >
          {submitLabel}
        </LoadingButton>
      )}
    </div>
  );
}
