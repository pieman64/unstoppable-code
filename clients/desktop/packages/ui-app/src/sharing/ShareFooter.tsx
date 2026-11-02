import type { JSX, ReactNode } from 'react';
import { Button, LoadingButton } from '@canopy/ui-shared/components';

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

export function ShareFooter({
  onCancel,
  showCancel = true,
  cancelLabel = 'Cancel',
  cancelDisabled = false,
  cancelTestId,
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
        <Button
          type="button"
          variant="secondary"
          size="compact"
          data-testid={cancelTestId}
          onClick={onCancel}
          disabled={cancelDisabled || loading}
        >
          {cancelLabel}
        </Button>
      )}
      {secondary && (
        <Button
          type="button"
          variant="secondary"
          size="compact"
          data-testid={secondary.testId}
          onClick={secondary.onClick}
          disabled={secondary.disabled === true || loading}
        >
          {secondary.label}
        </Button>
      )}
      {showPrimary && (
        <LoadingButton
          variant="primary"
          size="compact"
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
