import { forwardRef, type JSX, type SelectHTMLAttributes } from 'react';
import { ChevronDownIcon } from '../icons/AppIcons';
import { SECONDARY_SURFACE_SHELL_CLASS } from '../lib/row-chips';
import {
  DROPDOWN_INVALID_CLASS,
  DROPDOWN_TRIGGER_INTERACTION_CLASS,
} from './Button';

export interface ControlSelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'className' | 'size' | 'multiple'
> {
  /**
   * Fill the width of the parent instead of fitting the chosen label, so a
   * column of dropdowns in consecutive rows shares one width. The parent sets
   * the width.
   */
  readonly fill?: boolean;
  /** Host-owned replay marker; it never changes the control's visual styling. */
  readonly replayPrivacy?: { readonly blockClassName: string };
}

/**
 * A dropdown on the house secondary control surface: the 28px rounded
 * rectangle every dropdown takes (fields and dropdowns are rectangles, only
 * buttons are capsules; 2026-10-30), with a 13px label and an app chevron. It stays a native `<select>`, so the
 * menu is the platform's own and keyboard and screen-reader behavior come
 * for free.
 */
export const ControlSelect = forwardRef<HTMLSelectElement, ControlSelectProps>(
  function ControlSelect(
    { fill = false, replayPrivacy, ...props },
    ref,
  ): JSX.Element {
    return (
      <span
        // A filling dropdown may shrink so a row's other controls keep
        // their room; a fitted one keeps its label's width.
        className={`relative inline-flex ${fill ? 'w-full min-w-0' : 'shrink-0'}`}
      >
        <select
          ref={ref}
          {...props}
          className={`focus-ring h-7 ${fill ? 'w-full' : 'max-w-64'} cursor-pointer appearance-none truncate rounded-row pl-2.5 pr-7 text-xs font-medium fg-primary disabled:cursor-not-allowed disabled:opacity-60 ${SECONDARY_SURFACE_SHELL_CLASS} ${DROPDOWN_TRIGGER_INTERACTION_CLASS} ${DROPDOWN_INVALID_CLASS} transition-[opacity,transform,scale] ${replayPrivacy?.blockClassName ?? ''}`}
        />
        <ChevronDownIcon
          size={12}
          aria-hidden="true"
          className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 fg-tertiary`}
        />
      </span>
    );
  },
);

ControlSelect.displayName = 'ControlSelect';
