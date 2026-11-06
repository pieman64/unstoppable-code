import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';

export interface SuggestionRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  /** Allow sentences to wrap on narrow Home layouts. */
  multiline?: boolean;
  /**
   * The row shares its slot with a control placed over its trailing edge
   * by {@link SuggestionRowTrailing}, such as a dismiss button. The label
   * stops short of that control, and hover chrome follows an ancestor
   * `group` so hovering the control keeps the row highlighted. Rows without
   * one reserve no room.
   * `'wide'` reserves room for a short text action beside an icon button.
   */
  trailingControl?: boolean | 'wide';
  /**
   * `muted` sets the label one text step down, for a row that points at work
   * already under way rather than offering a new action. Hover and focus
   * chrome stay the same.
   */
  tone?: 'default' | 'muted';
}

/**
 * Shared icon-and-text action row for suggested prompts and project setup.
 * Forwards its ref to the button so a host can return focus to the row.
 */
export const SuggestionRow = forwardRef<HTMLButtonElement, SuggestionRowProps>(
  function SuggestionRow(
    {
      icon,
      multiline = false,
      children,
      className = '',
      type = 'button',
      trailingControl = false,
      tone = 'default',
      ...props
    },
    ref,
  ): JSX.Element {
    return (
      <button
        ref={ref}
        type={type}
        className={`focus-ring flex w-full items-center gap-2 rounded-full px-2 py-2 text-left text-s ${
          tone === 'muted' ? 'fg-tertiary' : 'fg-secondary'
        } transition-colors disabled:pointer-events-none disabled:fg-disabled ${
          trailingControl === false
            ? 'hover:bg-subtle hover:fg-primary'
            : `${trailingControl === 'wide' ? 'pr-28' : 'pr-12'} group-hover:bg-subtle group-hover:fg-primary`
        } ${className}`}
        {...props}
      >
        {/* A 16px icon starts 16px in, on the section title's edge; the
            32px slot keeps the label 48px in. */}
        <span className="flex h-8 w-8 shrink-0 items-center justify-start pl-2 fg-tertiary">
          {icon}
        </span>
        <span className={multiline ? 'min-w-0' : 'min-w-0 truncate'}>
          {children}
        </span>
      </button>
    );
  },
);

/**
 * The control over a row's trailing edge, in the row's `relative group`
 * parent. A 28px control in the 48px pill clears its top and bottom by 10px,
 * so it ends 10px from the pill's end too; a section header's ••• bleeds
 * into the same column.
 */
export function SuggestionRowTrailing({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="absolute right-2.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1">
      {children}
    </div>
  );
}
