import type { JSX } from 'react';
import { Badge } from './Badge';
import { LoadingSpinner } from './LoadingSpinner';

/** Selecting this row explicitly enables it before insertion. */
export function SlashCommandAvailabilityTag(): JSX.Element {
  return (
    <Badge
      muted
      className="shrink-0"
      data-testid="slash-command-availability-tag"
    >
      Available · enable
    </Badge>
  );
}

/**
 * The pending spinner on a slash-command row while its command enables.
 * Shared so every slash-row surface (the rich editor's menu, the Commands
 * popup) draws the same pending treatment.
 */
export function SlashCommandPendingSpinner(): JSX.Element {
  return <LoadingSpinner decorative sizePx={14} />;
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
    <SlashCommandGroupHeading
      label="Available to enable"
      divider
      testId={testId}
    />
  );
}

/** Shared heading for collected groups and contiguous ranked runs. */
export function SlashCommandGroupHeading({
  label,
  compact = false,
  divider = false,
  testId,
}: {
  label: string;
  compact?: boolean;
  divider?: boolean;
  testId?: string;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      role="presentation"
      className={
        compact
          ? 'px-2 pb-0.5 pt-2 text-xs fg-tertiary'
          : `${divider ? 'mt-1 border-t ' : ''}px-3 pb-1 pt-2 text-xs font-medium fg-secondary`
      }
    >
      {label}
    </div>
  );
}
