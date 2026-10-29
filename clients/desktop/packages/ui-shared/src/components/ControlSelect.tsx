import { forwardRef, type JSX, type SelectHTMLAttributes } from 'react';
import { ChevronDownIcon } from '../icons/AppIcons';
import { SECONDARY_SURFACE_CLASS } from '../lib/row-chips';

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
  /** Settings controls use the same capsule geometry as compact buttons. */
  readonly shape?: 'rounded' | 'capsule';
  /** Host-owned replay marker; it never changes the control's visual styling. */
  readonly replayPrivacy?: { readonly blockClassName: string };
}

/**
 * A dropdown on the house secondary control surface: the same 28px rounded
 * rectangle and 13px label as `Button size="control"` and the header
 * `Open in`, with an app chevron. It stays a native `<select>`, so the
 * menu is the platform's own and keyboard and screen-reader behavior come
 * for free.
 */
export const ControlSelect = forwardRef<HTMLSelectElement, ControlSelectProps>(
  function ControlSelect(
    { fill = false, shape = 'rounded', replayPrivacy, ...props },
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
          className={`focus-ring h-7 ${fill ? 'w-full' : 'max-w-64'} cursor-pointer appearance-none truncate ${shape === 'capsule' ? 'rounded-full pl-3 pr-9' : 'rounded-md pl-2.5 pr-7'} text-xs font-medium fg-primary disabled:cursor-not-allowed disabled:opacity-60 ${SECONDARY_SURFACE_CLASS} ${replayPrivacy?.blockClassName ?? ''}`}
        />
        <ChevronDownIcon
          size={12}
          aria-hidden="true"
          className={`pointer-events-none absolute ${shape === 'capsule' ? 'right-3' : 'right-2'} top-1/2 -translate-y-1/2 fg-tertiary`}
        />
      </span>
    );
  },
);

ControlSelect.displayName = 'ControlSelect';
