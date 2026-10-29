import type { JSX } from 'react';
import {
  type WorktreeUiStatus,
  WORKTREE_STATUS_META,
} from '@/lib/worktree-status';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { ThinkingSpinner } from '../shared/loading/spinners/ThinkingSpinner';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import { CheckIcon as AppCatalogCheckIcon } from '@canopy/ui-shared/icons/AppIcons';

interface WorktreeStatusIndicatorProps {
  uiStatus: WorktreeUiStatus;
  isRunningSetup: boolean;
  isTearingDown: boolean;
  isPendingGitSetup: boolean;
  isStreaming: boolean;
  fadeStatusOnHover?: boolean;
  layout?: 'inline' | 'stacked';
  showPrimaryIndicator?: boolean;
  doneLabel?: string;
}

function getStatusTitle(props: WorktreeStatusIndicatorProps): string | null {
  if (props.isTearingDown) {
    return 'Deleting worktree…';
  }
  if (props.isRunningSetup) {
    return 'Running setup…';
  }
  if (props.isPendingGitSetup) {
    return 'Setting up worktree (git operations in progress)';
  }
  return null;
}

function renderPrimaryIndicator(
  props: WorktreeStatusIndicatorProps,
): JSX.Element {
  const statusTitle = getStatusTitle(props);
  if (statusTitle) {
    return (
      <span
        className="inline-flex h-3 w-3 items-center justify-center"
        title={statusTitle}
        aria-label={statusTitle}
      >
        <LoadingSpinner tone="active" className="-translate-y-px" />
      </span>
    );
  }

  if (props.uiStatus === 'done') {
    const doneLabel = props.doneLabel ?? 'Done';
    const hoverClass = props.fadeStatusOnHover ? 'group-hover:opacity-0' : '';
    return (
      <span
        className={`inline-flex h-3 w-3 items-center justify-center transition-opacity ${OPERATIONAL_STATUS_COLORS.merged.foreground} ${hoverClass}`}
        title={doneLabel}
        aria-label={doneLabel}
      >
        <AppCatalogCheckIcon width="12" height="12" />
      </span>
    );
  }

  if (props.uiStatus === 'idle') {
    return (
      <span
        className="inline-flex h-3 w-3"
        aria-hidden="true"
        data-testid="worktree-idle-status-placeholder"
      />
    );
  }

  const statusMeta = WORKTREE_STATUS_META[props.uiStatus];
  const hoverClass = props.fadeStatusOnHover ? 'group-hover:opacity-0' : '';
  return (
    <span
      className={`inline-flex h-3 w-3 rounded-full border transition-opacity ${hoverClass} ${statusMeta.dotClass}`}
      title={statusMeta.label}
      aria-label={statusMeta.label}
    />
  );
}

export function WorktreeStatusIndicator({
  layout = 'inline',
  showPrimaryIndicator = true,
  ...props
}: WorktreeStatusIndicatorProps): JSX.Element {
  const primaryIndicator = showPrimaryIndicator
    ? renderPrimaryIndicator(props)
    : null;
  const spinner = props.isStreaming ? <ThinkingSpinner tone="active" /> : null;

  if (layout === 'stacked') {
    return (
      <div className="mt-1 flex shrink-0 flex-col items-center gap-1">
        {primaryIndicator}
        {spinner}
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {primaryIndicator}
      {spinner}
    </div>
  );
}
