import type { JSX } from 'react';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';

export type PullRequestStateBadgeState = 'open' | 'merged' | 'closed' | 'draft';

export interface PullRequestStateBadgeProps {
  state: PullRequestStateBadgeState;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

const STATE_COLORS: Record<PullRequestStateBadgeState, string> = {
  open: 'border-fg-success-strong/30 bg-success-subtle fg-success-strong',
  merged: `${OPERATIONAL_STATUS_COLORS.merged.borderSubtle} ${OPERATIONAL_STATUS_COLORS.merged.backgroundSubtle} ${OPERATIONAL_STATUS_COLORS.merged.foreground}`,
  closed:
    'border-fg-destructive-strong/30 bg-destructive-subtle fg-destructive-strong',
  draft: 'border-fg-secondary/30 bg-fg-secondary/16 fg-secondary',
};

/**
 * Pull request state pill (`open` / `merged` / `closed` / `draft`). Pure
 * display; colors are sourced from the desktop palette so both apps render
 * identically.
 */
export function PullRequestStateBadge({
  state,
  dataTestId,
}: PullRequestStateBadgeProps): JSX.Element {
  return (
    <span
      data-testid={dataTestId}
      className={`inline-flex rounded-full border px-2 py-0.5 text-3xs font-medium ${STATE_COLORS[state]}`}
    >
      {state}
    </span>
  );
}
