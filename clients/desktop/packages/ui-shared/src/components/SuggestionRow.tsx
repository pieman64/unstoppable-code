import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';

export interface SuggestionRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  /**
   * The row shares its slot with a control the caller positions over its
   * trailing edge, such as a dismiss button. The label stops short of that
   * control, and hover chrome follows an ancestor `group` so hovering the
   * control keeps the row highlighted. Rows without one reserve no room.
   */
  trailingControl?: boolean;
}

/**
 * Shared icon-and-text action row for suggested prompts and project setup.
 * Forwards its ref to the button so a host can return focus to the row.
 */
export const SuggestionRow = forwardRef<HTMLButtonElement, SuggestionRowProps>(
  function SuggestionRow(
    {
      icon,
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
          trailingControl
            ? 'pr-10 group-hover:bg-subtle group-hover:fg-primary'
            : 'hover:bg-subtle hover:fg-primary'
        } ${className}`}
        {...props}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center fg-tertiary">
          {icon}
        </span>
        <span className="min-w-0 truncate">{children}</span>
      </button>
    );
  },
);
