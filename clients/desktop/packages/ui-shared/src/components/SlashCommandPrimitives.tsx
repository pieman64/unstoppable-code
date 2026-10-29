import type { JSX } from 'react';

/**
 * Default busy spinner for slash-command surfaces. Shared so host menus that
 * render slash rows outside the rich editor's `SlashCommandMenu` (e.g. the
 * portal Commands popup) share the same pending treatment.
 */
export function SlashCommandLoadingIcon(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export interface SlashCommandAvailableDividerProps {
  testId?: string;
}

/**
 * The "Available to enable" section divider rendered once before the first
 * `section: 'available'` row. Shared so host menus that render slash rows
 * outside the rich editor's `SlashCommandMenu` cannot let the divider markup
 * drift.
 */
export function SlashCommandAvailableDivider({
  testId = 'slash-command-available-divider',
}: SlashCommandAvailableDividerProps): JSX.Element {
  return (
    <div
      data-testid={testId}
      role="presentation"
      className="mt-1 border-t px-3 pb-1 pt-2 text-xs font-medium fg-secondary"
    >
      Available to enable
    </div>
  );
}
