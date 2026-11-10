import type {
  HTMLAttributes,
  JSX,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  Ref,
} from 'react';
import type { SidebarDensity } from './SidebarChrome';

export type SidebarRowFrameVariant = 'chrome' | 'bare';

export interface SidebarRowFrameProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children'
> {
  readonly children: ReactNode;
  readonly selected?: boolean;
  readonly density?: SidebarDensity;
  /**
   * `chrome` supplies the standard row spacing and interaction visuals.
   * `bare` keeps the semantic row as a real layout box while leaving all
   * padding, hover, and selection visuals to the child row component.
   */
  readonly variant?: SidebarRowFrameVariant;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly dragHandle?: ReactNode;
  readonly elementRef?: Ref<HTMLDivElement>;
}

/**
 * Sidebar row geometry only. Selection, menus, badges and DnD behavior are
 * supplied by the host through props and slots.
 */
export function SidebarRowFrame({
  children,
  selected = false,
  density = 'default',
  variant = 'chrome',
  leading,
  trailing,
  dragHandle,
  elementRef,
  className,
  onClick,
  onKeyDown,
  role = 'listitem',
  tabIndex,
  ...attributes
}: SidebarRowFrameProps): JSX.Element {
  const interactive = onClick !== undefined;
  const paddingClass =
    density === 'touch'
      ? 'min-h-11 px-3 py-2'
      : density === 'compact'
        ? 'min-h-7 px-2 py-1'
        : 'min-h-8 px-2 py-1.5';

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event);
    if (
      !event.defaultPrevented &&
      interactive &&
      event.target === event.currentTarget &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault();
      event.currentTarget.click();
    }
  };

  // Slots commonly contain buttons, menus, and drag controls. Keep their
  // interactions from bubbling into row selection/keyboard activation.
  const containSlotClick = (event: MouseEvent<HTMLElement>): void => {
    event.stopPropagation();
  };
  const containSlotKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  };

  const chromeClassName =
    variant === 'chrome'
      ? `group items-center gap-2 rounded-row ${paddingClass} ${selected ? 'bg-muted fg-primary' : 'hover:bg-subtle'}${interactive ? ' focus-ring cursor-pointer' : ''}`
      : '';

  return (
    <div
      ref={elementRef}
      {...attributes}
      role={role}
      tabIndex={tabIndex ?? (interactive ? 0 : undefined)}
      aria-current={selected ? 'true' : undefined}
      data-selected={selected || undefined}
      data-sidebar-density={density}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      // Lets a row inside find its own frame (the worktree row's focus card).
      data-sidebar-row-frame=""
      data-sidebar-variant={variant}
      className={`flex w-full min-w-0${chromeClassName ? ` ${chromeClassName}` : ''}${className ? ` ${className}` : ''}`}
    >
      {dragHandle && (
        <span
          className="shrink-0"
          onClick={containSlotClick}
          onKeyDown={containSlotKeyDown}
        >
          {dragHandle}
        </span>
      )}
      {leading && (
        <span
          className="shrink-0"
          onClick={containSlotClick}
          onKeyDown={containSlotKeyDown}
        >
          {leading}
        </span>
      )}
      <div className="min-w-0 flex-1">{children}</div>
      {trailing && (
        <div
          className="ml-auto shrink-0"
          onClick={containSlotClick}
          onKeyDown={containSlotKeyDown}
        >
          {trailing}
        </div>
      )}
    </div>
  );
}
