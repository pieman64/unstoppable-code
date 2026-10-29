import type { JSX, ReactNode } from 'react';

export interface ModelGroupHeaderProps {
  /** Display label for the model source group (e.g. "Claude", "Agents"). */
  label: string;
  /** Provider/brand icon rendered in the fixed 16px leading slot. */
  icon?: ReactNode;
  /** Optional status or help control following the heading label. */
  trailing?: ReactNode;
  /** Test id applied to the heading container (omitted when absent). */
  containerTestId?: string;
  /** Test id applied to the icon slot (omitted when absent). */
  iconTestId?: string;
  /** Test id applied to the label span (omitted when absent). */
  labelTestId?: string;
  /**
   * Placement classes for the container. The group-heading treatment shared
   * by the desktop dropdown and the Harnesses settings page is the heading's
   * own.
   */
  className?: string;
  /** `picker` is the compact picker chrome's quieter, roomier heading. */
  variant?: 'default' | 'picker';
}

/**
 * Shared model-picker source-group heading (label + provider/brand icon).
 *
 * Pure display-only: no stores, `window.api`, Electron, Next, or app-local
 * imports — callers supply the already-branded icon and label. Extracted from
 * the desktop `ModelPicker`'s file-local `ModelGroup`/`AgentModelGroup`
 * headings so the model dropdown and the Harnesses settings page render the
 * same presentation. The heading is announced through the parent group's
 * `role="group"`/`aria-label`; the icon slot stays decorative.
 */
export function ModelGroupHeader({
  label,
  icon,
  trailing,
  containerTestId,
  iconTestId,
  labelTestId,
  className = '',
  variant = 'default',
}: ModelGroupHeaderProps): JSX.Element {
  return (
    <div
      data-testid={containerTestId}
      className={`${variant === 'picker' ? 'flex items-center gap-2 px-2 pb-1.5 pt-1.5 text-xs font-normal fg-tertiary' : 'flex items-center gap-2 px-2 pb-0.5 pt-1.5 text-xs font-normal fg-secondary'}${className ? ` ${className}` : ''}`}
    >
      {icon !== undefined && (
        <span
          data-testid={iconTestId}
          aria-hidden="true"
          className="flex h-4 w-4 shrink-0 items-center justify-center"
        >
          {icon}
        </span>
      )}
      <span data-testid={labelTestId} className="min-w-0 flex-1 truncate">
        {label}
      </span>
      {trailing}
    </div>
  );
}
