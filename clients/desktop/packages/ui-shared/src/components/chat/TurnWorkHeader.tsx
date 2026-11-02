import {
  forwardRef,
  type JSX,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import { LoadingSpinner } from '../LoadingSpinner';
import { STEP_ROW_TEXT_CLASS, StepRow } from './StepRow';
import {
  TURN_WAITING_LABEL,
  formatTurnElapsed,
  isTurnTimerPaused,
  useTurnElapsedSecond,
} from '../TurnTimer';
import type { TurnCompletionStatus } from './turn-completion-status';

export interface TurnWorkHeaderProps {
  /** Epoch ms when the turn started. */
  startedAt?: number;
  /** Epoch ms when the turn finished; empty while it runs. */
  finishedAt?: number | null;
  pausedAt?: number | null;
  resumedAt?: number | null;
  accumulatedPausedDurationMs?: number;
  /** The host shows a request waiting on the user; see `TurnTimerProps`. */
  waitingForUser?: boolean;
  /** The turn's total time, for hosts that only know that (web summaries). */
  elapsedMs?: number;
  /** Whether the turn is still running. Defaults to no `finishedAt`. */
  live?: boolean;
  /** How the turn ended; resolve it with `resolveTurnCompletionStatus`. */
  completionStatus?: TurnCompletionStatus;
  /** Whether the header folds the turn's steps; draws the chevron. */
  expandable?: boolean;
  isOpen?: boolean;
  onToggle?: MouseEventHandler<HTMLButtonElement>;
  ariaLabel?: string;
  /** What the turn did, in words, shown on hover. */
  title?: string;
  /** Words after the label, inside the toggle, in a lighter ink. */
  detail?: ReactNode;
  /**
   * A control of its own after the toggle and its chevron, such as a
   * finished turn's blocked, errored and interrupted steps (`TurnOutcomeControl`). It is
   * a sibling of the toggle, so its clicks never fold the turn.
   */
  outcome?: ReactNode;
  /** Count hook shared with classic summaries, without changing the wording. */
  stepCount?: number;
  /**
   * Controls at the row's end: the running turn's watch, fork and
   * auto-archive actions, in view (and pinned with the header) while it runs.
   */
  trailing?: ReactNode;
  dataTestId?: string;
  /**
   * The turn was submitted but has no visible output yet: reads
   * "Starting…" as a polite status with no ticking time, so assistive tech
   * hears it once. The other timing props are ignored.
   */
  starting?: boolean;
}

/** The pending turn's status label. */
export const TURN_STARTING_LABEL = 'Starting…';

/** Visible reply/activity ends the first send's pending status on every host. */
export function isStartingTurnOutput(kind: string, data: unknown): boolean {
  if (kind === 'tool_use' && typeof data === 'object' && data !== null) {
    const toolName =
      'toolName' in data && typeof data.toolName === 'string'
        ? data.toolName
        : 'name' in data
          ? data.name
          : undefined;
    if (toolName === 'EnterPlanMode') return false;
  }
  if (
    kind === 'image' ||
    kind === 'tool_use' ||
    kind === 'agent' ||
    kind === 'delegated_agent_call' ||
    kind === 'codex_agent' ||
    kind === 'workflow'
  )
    return true;
  if (kind !== 'text' && kind !== 'thinking') return false;
  const text =
    typeof data === 'string'
      ? data
      : typeof data === 'object' && data !== null && 'text' in data
        ? data.text
        : undefined;
  return typeof text === 'string' && text.trim().length > 0;
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
  state: 'starting' | 'live' | 'paused' | 'done',
  completionStatus: TurnWorkHeaderProps['completionStatus'],
  seconds: number | null,
): string {
  if (state === 'starting') return TURN_STARTING_LABEL;
  const time = seconds === null ? '' : formatWorkDuration(seconds);
  if (state === 'paused')
    return seconds === null
      ? TURN_WAITING_LABEL
      : `${TURN_WAITING_LABEL} · ${formatTurnElapsed(seconds)}`;
  if (state === 'live') return time ? `Working for ${time}` : 'Working';
  if (completionStatus === 'failed')
    return time ? `Failed after ${time}` : 'Failed';
  if (completionStatus === 'cancelled')
    return time ? `Stopped after ${time}` : 'Stopped';
  if (completionStatus === 'interrupted')
    return time ? `Interrupted after ${time}` : 'Interrupted';
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
    waitingForUser,
    elapsedMs,
    live,
    completionStatus = 'complete',
    expandable = false,
    isOpen = false,
    onToggle,
    ariaLabel,
    title,
    detail,
    outcome,
    stepCount,
    trailing,
    dataTestId,
    starting = false,
  },
  ref,
): JSX.Element {
  const running =
    !starting && finishedAt == null && (live ?? elapsedMs === undefined);
  const paused =
    running &&
    isTurnTimerPaused({ finishedAt, pausedAt, resumedAt, waitingForUser });
  const tickingSecond = useTurnElapsedSecond({
    startedAt,
    finishedAt,
    pausedAt,
    resumedAt,
    accumulatedPausedDurationMs,
    waitingForUser: running && waitingForUser === true,
    live: running && !paused,
  });
  const seconds =
    elapsedMs !== undefined
      ? Math.max(0, Math.floor(elapsedMs / 1000))
      : tickingSecond;
  const state = starting
    ? 'starting'
    : paused
      ? 'paused'
      : running
        ? 'live'
        : 'done';
  const label = headerLabel(state, completionStatus, seconds);
  // One step row like every other, in the same text, starting at the step
  // icons' left edge, with a hairline under it that closes the header. It
  // sits apart from the prompt (24px of ink gap) and close to its hairline
  // (12px), with 20px from the hairline to the reply, whether the prompt is
  // in the turn or pinned above it (padding, not margin, so a pinned
  // header's backdrop covers it). A starting turn has no steps for the
  // hairline to close yet, so it shows the working spinner and no hairline.
  return (
    <div
      className="px-3 pt-2 pb-1"
      data-testid={dataTestId}
      data-turn-header={state}
      {...(starting ? { role: 'status', 'aria-live': 'polite' as const } : {})}
    >
      <div
        className={`flex min-w-0 items-center gap-2 pb-1${starting ? '' : ' border-b'}`}
      >
        <StepRow
          ref={ref}
          icon={
            starting ? (
              <LoadingSpinner
                sizePx={14}
                decorative
                dataTestId="turn-starting-spinner"
              />
            ) : undefined
          }
          label={
            // Proportional figures: nothing follows the ticking time, so its
            // width changing moves nothing.
            <span title={title} data-turn-step-count={stepCount}>
              {label}
            </span>
          }
          detail={detail}
          expandable={!starting && expandable}
          isOpen={isOpen}
          onToggle={onToggle}
          ariaLabel={ariaLabel}
          chevronAtRest
        />
        {outcome != null ? (
          <span
            className={`flex min-w-0 items-center ${STEP_ROW_TEXT_CLASS}`}
            data-turn-work-header-outcome=""
          >
            {outcome}
          </span>
        ) : null}
        {trailing != null ? (
          <span
            className="ml-auto flex flex-shrink-0 items-center gap-0.5"
            data-testid="turn-work-header-actions"
          >
            {trailing}
          </span>
        ) : null}
      </div>
    </div>
  );
});
