import type { JSX } from 'react';

import { BranchIcon, CloseMediumIcon, WarningIcon } from '../icons/AppIcons';
import { LoadingSpinner } from './LoadingSpinner';
import { Tooltip } from './Tooltip';

/**
 * Where a pasted link would send the draft. Hosts decide the state; this
 * component only displays it.
 */
export type LinkTargetChipStatus =
  | 'resolving'
  | 'ready'
  | 'blocked'
  | 'submitting';

export interface LinkTargetChipAction {
  /** Stable id, used for the action's test id. */
  id: string;
  label: string;
  onSelect: () => void;
}

export interface LinkTargetChipProps {
  status: LinkTargetChipStatus;
  /** One short sentence naming the destination or the blocker. */
  label: string;
  /** Optional secondary line, such as a disclosed side effect. */
  detail?: string;
  actions?: readonly LinkTargetChipAction[];
  /** Omit to hide the dismiss control (for example while submitting). */
  onDismiss?: () => void;
  dismissLabel?: string;
  'data-testid'?: string;
}

const ACTION_CLASS =
  'focus-ring inline-flex h-6 shrink-0 items-center rounded-full px-2 text-xs font-medium fg-primary ring-1 ring-inset ring-line-base transition-colors hover:bg-subtle';

/**
 * Displays the worktree destination proposed for a link in a draft. Pure
 * display: resolution, project policy, and context changes stay in the host.
 */
export function LinkTargetChip({
  status,
  label,
  detail,
  actions = [],
  onDismiss,
  dismissLabel = 'Don’t use this link for a worktree',
  'data-testid': testId = 'link-target-chip',
}: LinkTargetChipProps): JSX.Element {
  const busy = status === 'resolving' || status === 'submitting';
  return (
    <div
      data-testid={testId}
      data-status={status}
      role="group"
      aria-label="Link destination"
      className={`flex min-w-0 max-w-full flex-wrap items-center gap-1.5 rounded-2xl px-2.5 py-1 text-xs ring-1 ring-inset ${
        status === 'blocked'
          ? 'fg-primary ring-line-base bg-subtle'
          : 'fg-secondary ring-line-base'
      }`}
    >
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
        {busy ? (
          <LoadingSpinner sizePx={14} decorative />
        ) : status === 'blocked' ? (
          <WarningIcon width={14} height={14} aria-hidden />
        ) : (
          <BranchIcon width={14} height={14} aria-hidden />
        )}
      </span>
      <span
        role="status"
        aria-live="polite"
        aria-busy={busy}
        className="flex min-w-0 flex-1 flex-col"
      >
        <span data-testid={`${testId}-label`} className="min-w-0 break-words">
          {label}
        </span>
        {detail && (
          <span
            data-testid={`${testId}-detail`}
            className="min-w-0 break-words fg-secondary"
          >
            {detail}
          </span>
        )}
      </span>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          data-testid={`${testId}-action-${action.id}`}
          onClick={action.onSelect}
          className={ACTION_CLASS}
        >
          {action.label}
        </button>
      ))}
      {onDismiss && (
        <Tooltip label={dismissLabel}>
          <button
            type="button"
            data-testid={`${testId}-dismiss`}
            aria-label={dismissLabel}
            onClick={onDismiss}
            className="focus-ring inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full fg-secondary hover:bg-subtle hover:fg-primary"
          >
            <CloseMediumIcon width={12} height={12} aria-hidden />
          </button>
        </Tooltip>
      )}
    </div>
  );
}
