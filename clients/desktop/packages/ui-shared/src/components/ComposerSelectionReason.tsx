import type { JSX } from 'react';

export interface ComposerSelectionReasonProps {
  /** Why the composer chose its target, for example "Most recent". */
  readonly reason: string;
  /** Visible action label, for example "Switch". */
  readonly actionLabel: string;
  /** Accessible name for the action when the label alone is ambiguous. */
  readonly actionAccessibleName: string;
  readonly onAction: () => void;
  readonly testId?: string;
}

/**
 * Tertiary inline hint beside a composer's target picker that explains an
 * automatic choice ("Most recent · Switch"). The action hands control back
 * to the host's picker; it never changes the selection itself. Render it as
 * a sibling of the picker so the picker keeps its own truncation.
 */
export function ComposerSelectionReason({
  reason,
  actionLabel,
  actionAccessibleName,
  onAction,
  testId,
}: ComposerSelectionReasonProps): JSX.Element {
  return (
    <span
      data-testid={testId}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs fg-tertiary"
    >
      <span>{reason}</span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        aria-label={actionAccessibleName}
        data-testid={testId ? `${testId}-action` : undefined}
        onClick={onAction}
        className="focus-ring rounded-sm fg-secondary underline-offset-2 transition-colors hover:fg-primary hover:underline"
      >
        {actionLabel}
      </button>
    </span>
  );
}
