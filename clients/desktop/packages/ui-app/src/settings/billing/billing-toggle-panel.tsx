'use client';

import type { JSX, ReactNode } from 'react';

/**
 * Shared Billing-tab subcard with a titled master on/off switch: the muted
 * container, the title line, the description (with an optional "Learn more"
 * link), the `role="switch"` button, an inline error line, and a `children`
 * slot for content rendered below the switch (for example the auto top-up
 * meter and settings summary).
 *
 * Used by {@link AutoTopUpControls} and {@link DailyFreeCreditsControls} so the
 * Billing tab has one switch implementation.
 */
export interface BillingTogglePanelProps {
  /** Test id on the panel container. */
  testId: string;
  /** Test id on the switch button. */
  toggleTestId: string;
  title: string;
  description: string;
  /** Optional "Learn more" destination rendered under the description. */
  learnMoreHref?: string;
  /** Current switch state. */
  checked: boolean;
  /** Accessible name for the switch. */
  ariaLabel: string;
  /** Disables the switch (no permission, or a save is in flight). */
  disabled: boolean;
  onToggle: () => void;
  /** Inline error shown under the switch row, or `null` for none. */
  error: string | null;
  children?: ReactNode;
}

export function BillingTogglePanel({
  testId,
  toggleTestId,
  title,
  description,
  learnMoreHref,
  checked,
  ariaLabel,
  disabled,
  onToggle,
  error,
  children,
}: BillingTogglePanelProps): JSX.Element {
  return (
    <div className="mt-4 rounded-lg bg-muted p-4" data-testid={testId}>
      {/* Master toggle */}
      <p className="text-s font-medium fg-primary">{title}</p>
      {/* Toggle aligns with the description line, not the subheader above it. */}
      <div className="mt-1 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs fg-secondary">{description}</p>
          {learnMoreHref ? (
            <a
              href={learnMoreHref}
              target="_blank"
              rel="noreferrer"
              className="text-xs fg-accent hover:underline"
            >
              Learn more
            </a>
          ) : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={onToggle}
          data-testid={toggleTestId}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            checked ? 'bg-accent' : 'bg-fg-secondary/40'
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
              checked ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {error ? (
        <p className="mt-2 text-xs fg-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {children}
    </div>
  );
}
