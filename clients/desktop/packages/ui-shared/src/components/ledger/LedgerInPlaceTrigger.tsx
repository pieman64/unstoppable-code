'use client';

import { forwardRef, type ButtonHTMLAttributes, type JSX } from 'react';
import { ChevronDownIcon } from '../../icons/AppIcons';

export type LedgerInPlaceTriggerProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type'
>;

/** An entry's owner, changed in place on the first line of its row. */
export const LedgerInPlaceTrigger = forwardRef<
  HTMLButtonElement,
  LedgerInPlaceTriggerProps
>(function LedgerInPlaceTrigger(
  { children, className = '', ...props },
  ref,
): JSX.Element {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      className={`focus-ring -mx-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${className}`}
    >
      {children}
      <ChevronDownIcon
        size={12}
        aria-hidden="true"
        className="shrink-0 fg-tertiary"
      />
    </button>
  );
});

LedgerInPlaceTrigger.displayName = 'LedgerInPlaceTrigger';
