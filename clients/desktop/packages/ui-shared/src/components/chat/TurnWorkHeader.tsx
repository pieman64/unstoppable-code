import { forwardRef, type JSX, type MouseEventHandler } from 'react';
import { StepRow } from './StepRow';
import { useTurnElapsedSecond } from '../TurnTimer';

export interface TurnWorkHeaderProps {
  /** Epoch ms when the turn started. */
  startedAt?: number;
  /** Epoch ms when the turn finished; empty while it runs. */
  finishedAt?: number | null;
  pausedAt?: number | null;
  resumedAt?: number | null;
  accumulatedPausedDurationMs?: number;
  /** The turn's total time, for hosts that only know that (web summaries). */
  elapsedMs?: number;
  /** Whether the turn is still running. Defaults to no `finishedAt`. */
  live?: boolean;
  /** How the turn ended. */
  completionStatus?: 'complete' | 'failed' | 'cancelled';
  /** Whether the header folds the turn's steps; draws the chevron. */
  expandable?: boolean;
  isOpen?: boolean;
  onToggle?: MouseEventHandler<HTMLButtonElement>;
  ariaLabel?: string;
  /** What the turn did, in words, shown on hover. */
  title?: string;
  dataTestId?: string;
}

/** "28s", "3m 24s", "1h 5m": the header's duration, in words. */
export function formatWorkDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0)
    return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
  return `${remaining}s`;
}

function headerLabel(
  state: 'live' | 'paused' | 'done',
  completionStatus: TurnWorkHeaderProps['completionStatus'],
  seconds: number | null,
): string {
  const time = seconds === null ? '' : formatWorkDuration(seconds);
  if (state === 'paused') return 'Waiting for you';
  if (state === 'live') return time ? `Working for ${time}` : 'Working';
  if (completionStatus === 'failed')
    return time ? `Failed after ${time}` : 'Failed';
  if (completionStatus === 'cancelled')
    return time ? `Stopped after ${time}` : 'Stopped';
  return time ? `Worked for ${time}` : 'Worked';
}

/**
 * The clean chat look's turn header, after the Codex app: "Working for 28s"
 * over a hairline while the turn runs, then "Worked for 3m 24s" with a
 * chevron that opens the steps the finished turn folded away.
 */
export const TurnWorkHeader = forwardRef<
  HTMLButtonElement,
  TurnWorkHeaderProps
>(function TurnWorkHeader(
  {
    startedAt,
    finishedAt,
    pausedAt,
    resumedAt,
    accumulatedPausedDurationMs,
    elapsedMs,
    live,
    completionStatus = 'complete',
    expandable = false,
    isOpen = false,
    onToggle,
    ariaLabel,
    title,
    dataTestId,
  },
  ref,
): JSX.Element {
  const running = live ?? (finishedAt == null && elapsedMs === undefined);
  const paused = running && pausedAt != null && resumedAt == null;
  const tickingSecond = useTurnElapsedSecond({
    startedAt,
    finishedAt,
    pausedAt,
    resumedAt,
    accumulatedPausedDurationMs,
    live: running && !paused,
  });
  const seconds =
    elapsedMs !== undefined
      ? Math.max(0, Math.floor(elapsedMs / 1000))
      : tickingSecond;
  const state = paused ? 'paused' : running ? 'live' : 'done';
  const label = headerLabel(state, completionStatus, seconds);
  // One step row like every other, in the same text, starting at the step
  // icons' left edge, with a hairline under it that closes the header.
  return (
    <div className="px-3" data-testid={dataTestId} data-turn-header={state}>
      <div className="border-b pb-1">
        <StepRow
          ref={ref}
          label={
            <span className="tabular-nums" title={title}>
              {label}
            </span>
          }
          expandable={expandable}
          isOpen={isOpen}
          onToggle={onToggle}
          ariaLabel={ariaLabel}
          chevronAtRest
        />
      </div>
    </div>
  );
});
