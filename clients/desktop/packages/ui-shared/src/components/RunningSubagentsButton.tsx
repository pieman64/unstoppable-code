import type { JSX } from 'react';
import { ExecutionActionButton } from './ExecutionActionButton';

export interface RunningSubagentsButtonProps {
  /** Subagents queued or running across the worktree. */
  readonly count: number;
  /** Shows the Subagents panel. */
  readonly onClick: () => void;
  readonly className?: string;
}

/**
 * A worktree top bar's note that subagents are at work: "6 running" in
 * shimmering text, which shows the Subagents panel. It is the shared top-bar
 * action button in its ghost style, so it has the frame of Launch and
 * `Open in` beside it. Renders nothing while none runs, so it takes no room
 * (or gap) in the bar then.
 */
export function RunningSubagentsButton({
  count,
  onClick,
  className = '',
}: RunningSubagentsButtonProps): JSX.Element | null {
  if (count <= 0) return null;
  return (
    <ExecutionActionButton
      variant="ghost"
      label={`${count} running`}
      shimmer
      ariaLabel={`${count} ${count === 1 ? 'subagent' : 'subagents'} running. Show subagents`}
      title="Show subagents"
      dataTestId="running-subagents-button"
      onClick={onClick}
      className={className}
    />
  );
}
