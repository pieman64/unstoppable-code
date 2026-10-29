import type { JSX, ReactNode } from 'react';

export interface RunConfirmationCardProps {
  /** Prompt copy — typically "Run <label>?". Caller supplies the sentence so
   * the displayed label can vary per section. */
  prompt: ReactNode;
  /** Section-specific details — script command preview, hook action list,
   * etc. Pre-formatted by the caller. */
  details: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional override for the confirm button label. */
  confirmLabel?: string;
  /** Optional override for the cancel button label. */
  cancelLabel?: string;
}

/**
 * Amber-tinted inline confirmation card rendered in place of a row when a
 * manual run is awaiting confirmation. Pure display.
 */
export function RunConfirmationCard({
  prompt,
  details,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
}: RunConfirmationCardProps): JSX.Element {
  return (
    <div className="rounded-lg border border-line-attention bg-warning/[0.06] px-2.5 py-2 text-xs">
      <p className="mb-1.5 fg-primary/80">{prompt}</p>
      <div className="mb-2">{details}</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="focus-ring rounded-md bg-accent px-2.5 py-1 text-2xs font-medium fg-emphasis"
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring rounded-md px-2.5 py-1 text-2xs fg-secondary hover:fg-primary/80"
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
