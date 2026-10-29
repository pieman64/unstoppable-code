import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';

export interface ActivityActionCardButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  /** The section's own icon, in the leading slot. */
  readonly icon: ReactNode;
  /** The action, as a visible label and the button's accessible name. */
  readonly label: string;
  /**
   * Why the card is empty, on the same line after the label in quieter ink.
   * It truncates before the label does and is exposed as the button's
   * accessible description.
   */
  readonly description?: ReactNode;
  /**
   * Content continues in the same card below the button, so the button keeps
   * only its top corners and drops its own elevation.
   */
  readonly attached?: boolean;
}

/**
 * The empty activity section rendered as one full-card action (the desktop
 * "Add MCP server" and "Generate summary" cards): the whole card is the
 * button, with the section icon and the action label on one line. Hosts
 * supply the handler; geometry, surface and motion live here.
 */
export const ActivityActionCardButton = forwardRef<
  HTMLButtonElement,
  ActivityActionCardButtonProps
>(function ActivityActionCardButton(
  { icon, label, description, attached = false, ...props },
  ref,
): JSX.Element {
  const descriptionId = useId();
  const hasDescription =
    description !== undefined && description !== null && description !== '';
  return (
    <button
      ref={ref}
      {...props}
      type="button"
      aria-label={label}
      {...(hasDescription ? { 'aria-describedby': descriptionId } : {})}
      className={`electron-no-drag focus-ring flex min-h-11 select-none w-full touch-manipulation items-center gap-3 bg-tertiary p-3 text-left fg-primary ${attached ? 'rounded-t-lg rounded-b-none' : 'rounded-lg shadow-sm'} transition-[background-color,transform] duration-150 enabled:hover:bg-[var(--bg-activity-card-hover)] active:scale-99`}
      data-activity-action-card-button="true"
    >
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center fg-secondary [&_svg]:h-4 [&_svg]:w-4">
        {icon}
      </span>
      <span className="min-w-0 truncate text-s font-semibold">{label}</span>
      {hasDescription && (
        <span
          id={descriptionId}
          className="min-w-0 shrink-100 truncate text-s fg-tertiary"
        >
          {description}
        </span>
      )}
    </button>
  );
});

ActivityActionCardButton.displayName = 'ActivityActionCardButton';
