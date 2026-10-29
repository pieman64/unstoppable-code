'use client';

import { memo, type JSX, type MouseEvent, type ReactNode } from 'react';
import type { WorktreeLabel } from '@canopy/app-state';
import { Tooltip } from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/**
 * One home-dashboard card: a workspace·worktree label, a title, an optional
 * subtitle/badge, and a click that navigates to the worktree. Pure display —
 * the host supplies {@link OverviewCardProps.onClick} (navigation lives in the
 * adapter, not this browser-safe package).
 */
export interface OverviewCardProps {
  readonly label: WorktreeLabel | null;
  readonly title: string;
  /** The title is a chat's title, so session replay masks it. */
  readonly titleReplayMasked?: boolean;
  readonly subtitle?: ReactNode;
  readonly badge?: ReactNode;
  /** Optional icon rendered alongside the workspace/worktree label. */
  readonly leadingIcon?: ReactNode;
  readonly children?: ReactNode;
  readonly onClick?: () => void;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  readonly dataTestId?: string;
}

function OverviewCardImpl({
  label,
  title,
  titleReplayMasked = false,
  subtitle,
  badge,
  leadingIcon,
  children,
  onClick,
  onDismiss,
  dismissLabel = 'Dismiss from overview',
  dataTestId = 'overview-card',
}: OverviewCardProps): JSX.Element {
  const handleDismiss = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onDismiss?.();
  };

  const openLabel = label
    ? `Open ${title} for ${label.workspaceName ? `${label.workspaceName}, ` : ''}${label.worktreeName}`
    : `Open ${title}`;

  return (
    <div
      role="group"
      className={`group relative flex w-full flex-col gap-0.5 rounded-md border bg-card px-3 py-2 text-left transition focus-within:border-line-accent/60 ${
        onClick
          ? 'cursor-pointer hover:border-line-accent/40 hover:bg-accent-subtle/40'
          : 'cursor-default'
      }`}
      data-testid={dataTestId}
    >
      {onClick && (
        <button
          type="button"
          onClick={onClick}
          aria-label={openLabel}
          className="absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-accent/60"
          data-testid={`${dataTestId}-open`}
        />
      )}
      <div className="pointer-events-none relative z-10 flex flex-col gap-0.5">
        {(leadingIcon ||
          (label && (label.workspaceName || label.worktreeName))) && (
          <span className="flex min-w-0 items-center gap-1 text-3xs fg-secondary">
            {leadingIcon && (
              <span className="inline-flex shrink-0" aria-hidden="true">
                {leadingIcon}
              </span>
            )}
            {label && (label.workspaceName || label.worktreeName) && (
              <span className={`${REPLAY_MASK_CLASS} truncate`}>
                {label.workspaceName ? `${label.workspaceName} · ` : ''}
                {label.worktreeName}
              </span>
            )}
          </span>
        )}
        <span className="flex items-center gap-2">
          <span
            className={`${titleReplayMasked ? `${REPLAY_MASK_CLASS} ` : ''}min-w-0 flex-1 truncate text-s fg-primary`}
          >
            {title}
          </span>
          {badge}
          {onDismiss && (
            <Tooltip label={dismissLabel} className="pointer-events-auto">
              <button
                type="button"
                onClick={handleDismiss}
                aria-label={dismissLabel}
                className="pointer-events-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded fg-secondary transition-colors hover:bg-secondary hover:fg-primary"
                data-testid={`${dataTestId}-dismiss`}
              >
                <span aria-hidden="true">×</span>
              </button>
            </Tooltip>
          )}
        </span>
        {subtitle && (
          <span className="line-clamp-2 whitespace-pre-line text-xs fg-secondary">
            {subtitle}
          </span>
        )}
        {children && (
          <div className="[&_button]:pointer-events-auto">{children}</div>
        )}
      </div>
    </div>
  );
}

// Memoized for consistency with the other card components. Note: the `label`
// prop is currently a fresh object from `selectWorktreeLabel` each render, so
// the bailout only bites once that returns a stable reference — harmless today
// because Overview re-renders only on a snapshot change (which changes labels).
export const OverviewCard = memo(OverviewCardImpl);
