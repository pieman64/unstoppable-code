import { useWorktreeLaunchStop } from '@/hooks/useWorktreeLaunchStop';
import { Tooltip } from '@canopy/ui-shared';
import { StopIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { JSX, MouseEvent } from 'react';
import { RunSpinner } from '../shared/loading/spinners/RunSpinner';

function stopLaunchLabel(isLaunchStopping: boolean): string {
  return isLaunchStopping ? 'Stopping launch script' : 'Stop launch script';
}

/**
 * The running launch's two hover-swapped faces: the run spinner at rest, a
 * stop glyph under the pointer. Both share one 12px box so the swap never
 * shifts the line.
 */
export function StopLaunchFaces({
  isLaunchStopping,
}: {
  readonly isLaunchStopping: boolean;
}): JSX.Element {
  return (
    <>
      <span
        className={
          isLaunchStopping
            ? 'inline-flex h-3 w-3 shrink-0 items-center justify-center'
            : 'inline-flex h-3 w-3 shrink-0 items-center justify-center group-hover/stop:hidden'
        }
      >
        <RunSpinner />
      </span>
      {!isLaunchStopping && (
        <span className="hidden h-3 w-3 shrink-0 items-center justify-center group-hover/stop:inline-flex">
          <StopIcon size={12} aria-hidden="true" />
        </span>
      )}
    </>
  );
}

interface WorktreeIdStopLaunchButtonProps {
  readonly worktreeId: string;
  readonly isLaunchStopping: boolean;
  readonly onStop: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly testId: string;
}

/**
 * A running launch folds the run spinner and the worktree id into one stop
 * control: status-active while it runs, destructive with a stop glyph on
 * hover.
 *
 * The running launch reads as a shimmer on the id itself, in
 * the line's own neutral ink, with no spinner and no status color. Hover
 * still turns the control destructive, and its tooltip names the action.
 */
export function WorktreeIdStopLaunchButton({
  worktreeId,
  isLaunchStopping,
  onStop,
  testId,
}: WorktreeIdStopLaunchButtonProps): JSX.Element {
  const label = stopLaunchLabel(isLaunchStopping);

  {
    return (
      <Tooltip label={label} className="align-bottom">
        <button
          type="button"
          onClick={onStop}
          disabled={isLaunchStopping}
          aria-label={label}
          data-testid={testId}
          data-launch-status="shimmer"
          // Keep the ID's intrinsic width inside Tooltip's inline-flex wrapper.
          // The subtitle owns truncation; a percentage max-width here collapses it.
          className={`focus-ring -mx-1 inline-flex h-4 items-center rounded px-1 align-bottom leading-4 transition-colors ${
            isLaunchStopping
              ? 'cursor-not-allowed fg-destructive'
              : 'hover:bg-destructive-subtle hover:fg-destructive'
          }`}
        >
          <span className="truncate">
            <span
              className={isLaunchStopping ? undefined : 'canopy-text-shimmer'}
            >
              {worktreeId}
            </span>
          </span>
        </button>
      </Tooltip>
    );
  }
}

interface WorktreeLaunchIdSlotProps {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly testId: string;
}

/**
 * The shared rail's worktree id line on desktop: the plain id, or the stop
 * control while the worktree's launch script runs.
 */
export function WorktreeLaunchIdSlot({
  projectId,
  worktreeId,
  testId,
}: WorktreeLaunchIdSlotProps): JSX.Element {
  const { launchScriptKey, isLaunchStopping, stopLaunch } =
    useWorktreeLaunchStop(projectId, worktreeId);
  return launchScriptKey === null ? (
    <span>{worktreeId}</span>
  ) : (
    <WorktreeIdStopLaunchButton
      worktreeId={worktreeId}
      isLaunchStopping={isLaunchStopping}
      onStop={stopLaunch}
      testId={testId}
    />
  );
}
