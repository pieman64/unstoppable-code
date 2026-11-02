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
   * The row shares its slot with a control the caller positions over its
   * trailing edge, such as a dismiss button, 16px in like a section header's
   * ••• (`right-4`). The label stops short of that
   * control, and hover chrome follows an ancestor `group` so hovering the
   * control keeps the row highlighted. Rows without one reserve no room.
   * `'wide'` reserves room for a short text action beside an icon button.
   */
  trailingControl?: boolean | 'wide';
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
      ...props
    },
    ref,
  ): JSX.Element {
    return (
      <button
        ref={ref}
        type={type}
        className={`focus-ring flex w-full items-center gap-2 rounded-full px-2 py-2 text-left text-sm fg-secondary transition-colors disabled:pointer-events-none disabled:fg-disabled ${
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
