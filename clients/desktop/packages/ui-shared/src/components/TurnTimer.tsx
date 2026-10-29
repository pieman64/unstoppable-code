import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type ComponentPropsWithoutRef,
} from 'react';
import { LightbulbIcon } from '../icons/AppIcons';
import { useCleanChatLook } from './chat-look';
import { ChatCopyAction } from './chat/ChatCopyAction';
import { StepRow } from './chat/StepRow';
import { Tooltip } from './Tooltip';
import { formatCompletionTimestamp } from '../lib/format-completion-timestamp';

export interface TurnTimerProps {
  /** Epoch ms when the turn started. When omitted, no elapsed time is
   * shown and the indicator reads as a plain working/completed state. */
  startedAt?: number;
  /** Epoch ms when the turn finished. Falsy means the turn is still
   * running. */
  finishedAt?: number | null;
  /** Epoch ms when the turn paused while waiting on user input. */
  pausedAt?: number | null;
  /** Epoch ms when the paused turn resumed after user input. */
  resumedAt?: number | null;
  /** Total completed pause time from previous pause/resume cycles. */
  accumulatedPausedDurationMs?: number;
  /** Force a live ticking timer. Defaults to true when `finishedAt` is
   * not set. The web portal may pass `isStreaming=false` even without a
   * finish timestamp to render the simple "Working..." pill. */
  isStreaming?: boolean;
  /**
   * Optional inline trailing action (e.g., a Fork-chat button). Rendered
   * after the elapsed-time label in both live and completed states; callers
   * should pass content that is appropriate while the timer is still running.
   */
  trailing?: ReactNode;
  /**
   * Optional override for the spinner rendered while the timer is live.
   * When omitted, no spinner is rendered. The desktop and web call sites
   * pass their own animated spinner (e.g., `<ThinkingSpinner />`).
   */
  spinner?: ReactNode;
  /**
   * Optional control rendered right after the completion stamp and, like the
   * stamp, always visible (CAN-1521's turn-level thumbs up/down, CAN-4278).
   */
  stampAccessory?: ReactNode;
  /**
   * The finished reply's text. Shows a Copy button once the turn completes
   * (CAN-4704). Classic look: right after the completion stamp, ahead of the
   * thumbs, visible at rest like them. Clean look: ahead of the row's other
   * actions.
   */
  copyText?: string;
  /**
   * Clean chat look: the "…" menu (a {@link TurnMoreMenu}) with the turn's
   * less-used actions, after the inline icons.
   */
  moreMenu?: ReactNode;
  /**
   * Clean chat look: the model routing picked, named in the time's tooltip
   * instead of a chip in the row.
   */
  modelLabel?: string;
  /**
   * Keeps the whole row visible at rest. A successfully completed row
   * otherwise shows only its timestamp and {@link stampAccessory} until its
   * turn is hovered or focused (CAN-4278).
   * Hosts set this where the row has no per-turn `group/turn` scope, since
   * nothing there could ever reveal it.
   */
  alwaysVisible?: boolean;
  /**
   * Opt into the desktop transcript's row insets: the user bubble's `px-3`
   * text inset, so the timer shares one left edge with the flat assistant
   * prose above it, plus the wider bottom gap that separates a finished turn
   * from the next one.
   *
   * Opt-in rather than baked in, because it is a desktop layout decision: the
   * web portal and the shared Code tab render this row in padding-free
   * wrappers, and insetting it there pushes the timer off the left edge its
   * own prose sits on.
   */
  inset?: boolean;
  /**
   * Set when the host column already separates turns with an 8px gap that
   * does not collapse with this row's bottom margin (a flex `gap-2` column).
   * The row then trims its own margin so the gap to the next turn matches
   * desktop, where the 20px margin collapses with the turn spacing (CAN-4278).
   */
  hostTurnGap?: boolean;
  /**
   * Replaces the live `Working...` label while the host knows what the turn
   * is doing (e.g. `Compacting context…`). Ignored once the timer is paused
   * or completed.
   */
  workingLabel?: string;
  /** Outcome shown once the turn has stopped. */
  completionStatus?: 'complete' | 'failed' | 'cancelled';
  /**
   * Clean chat look only: a step on screen already shimmers what the turn is
   * doing, so the row drops its own live status.
   */
  liveStatusShown?: boolean;
}

/**
 * Reveal rules for the hover-only parts of a successfully completed footer
 * (CAN-4278): the "Completed in" label, the trailing model pill and actions.
 * Copy in either look, and the classic time-of-day stamp and thumbs, are
 * never faded. Faded parts
 * stay in the layout, tab order, and accessibility tree; only their opacity
 * changes, so revealing them never moves the transcript. No transition: the
 * reveal is intentionally instant.
 *
 * - `group-hover/turn`: the transcript's per-turn wrapper is hovered.
 * - `group-data-[hover]/turn`: the same reveal driven from a hoisted sticky
 *   prompt, which sits outside its own turn wrapper and so cannot trigger
 *   `group-hover` through the DOM.
 * - `group-focus-within/turn`: keyboard focus anywhere inside the turn,
 *   including the row's own actions.
 * - `group-data-[focus-within]/footer`: focus inside the footer row as React
 *   reports it, which also covers portaled menus opened from the row.
 * - `pointer-coarse` / `hover:none`: touch and other no-hover devices keep
 *   the row visible, since nothing there could reveal it.
 */
const ROW_REVEAL_CLASSNAME =
  'opacity-0 group-hover/turn:opacity-100 group-data-[hover]/turn:opacity-100 group-focus-within/turn:opacity-100 group-data-[focus-within]/footer:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100';

/** Shared policy for timer rows and separately mounted turn action slots. */
function turnFooterRevealClassName(
  completed: boolean,
  completionStatus: TurnTimerProps['completionStatus'] = 'complete',
  alwaysVisible = false,
): string {
  return completed && completionStatus === 'complete' && !alwaysVisible
    ? ROW_REVEAL_CLASSNAME
    : '';
}

/**
 * One hover-only part of a turn footer, for hosts that mount their own
 * actions in a {@link TurnFooterRow}. It applies the same reveal policy as the
 * timer row's label and trailing actions.
 */
export function TurnFooterReveal({
  completed,
  completionStatus,
  alwaysVisible = false,
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<'span'>, 'className'> & {
  completed: boolean;
  completionStatus?: TurnTimerProps['completionStatus'];
  alwaysVisible?: boolean;
}): JSX.Element {
  const reveal = turnFooterRevealClassName(
    completed,
    completionStatus,
    alwaysVisible,
  );
  return (
    <span
      {...props}
      className={`flex items-center gap-0.5${reveal ? ` ${reveal}` : ''}`}
    >
      {children}
    </span>
  );
}

/**
 * Document events after which a row that holds focus re-checks it. React
 * delivers no blur when the focused element unmounts (facebook/react#12363),
 * for example a menu item that closes its own menu on click or Escape.
 */
const FOCUS_RECHECK_EVENTS = [
  'click',
  'focusin',
  'pointerdown',
  'keydown',
  'keyup',
];

/**
 * The one icon-button treatment for every control in a footer row, taken from
 * the thumbs beside the stamp (CAN-4278): borderless and unfilled, the
 * stamp's muted `fg-quaternary` tone, and a `fg-secondary` hover with a
 * subtle tint and a stronger pressed tint. Disabled controls do not react.
 * The row applies it to every descendant button, so Fork, Branch, Share and
 * any later action cannot drift from the thumbs. Catalog icons render at 14px
 * for any requested size up to 16px, so footer icons match the thumbs' size.
 * Pressed controls (a selected thumb, a shared session) and controls asking
 * for attention (`data-attention`: unread run comments, an armed watcher)
 * keep their state styling and their own size. Button sizes apply to fine
 * pointers only, so touch keeps each control's own larger target. The border
 * is removed by width: border colors are inert here (CAN-2734).
 */
/**
 * The clean chat look's footer controls: every action button in the row the
 * same 24px quiet square with a 14px icon in the row's text ink (thumbs,
 * copy, fork, branch, share, watch, auto-archive, comments), darker on hover.
 * Pressed and attention states keep their own styling, as above.
 */
const CLEAN_TURN_FOOTER_CONTROLS_CLASSNAME =
  '[&_button]:size-6 [&_button]:rounded-md [&_button]:ring-0 [&_button:not([aria-pressed=true]):not([data-attention])]:border-0 [&_button:not([aria-pressed=true]):not([data-attention])]:bg-transparent [&_button:not([aria-pressed=true]):not([data-attention])]:fg-secondary [&_button:not(:disabled):hover]:fg-primary [&_button:not(:disabled):hover:not(:active)]:bg-fg-primary/[0.06] [&_button:not(:disabled):active]:bg-fg-primary/[0.08] [&_svg]:size-3.5 pointer-coarse:[&_button]:size-11';

const TURN_FOOTER_CONTROLS_CLASSNAME =
  'pointer-fine:[&_button:not([data-attention])]:size-5 [&_button]:rounded [&_button]:ring-0 [&_button:not([aria-pressed=true]):not([data-attention])]:border-0 [&_button:not([aria-pressed=true]):not([data-attention])]:bg-transparent [&_button:not([aria-pressed=true]):not([data-attention])]:fg-quaternary [&_button:not([aria-pressed=true]):not([data-attention]):not(:disabled):hover]:fg-secondary [&_button:not([aria-pressed=true]):not([data-attention]):not(:disabled):hover:not(:active)]:bg-fg-primary/[0.04] [&_button:not([aria-pressed=true]):not([data-attention]):not(:disabled):active]:fg-secondary [&_button:not([aria-pressed=true]):not([data-attention]):not(:disabled):active]:bg-fg-primary/[0.08] pointer-fine:[&_svg]:size-3';

/**
 * A turn footer row. The row itself never fades, so its height never changes;
 * hover-only parts fade through {@link TurnFooterReveal} or TurnTimer.
 * React focus events include portaled descendants, unlike CSS focus-within,
 * so the row tracks focus itself and exposes it as `data-focus-within`.
 */
export function TurnFooterRow({
  variant = 'timer',
  inset = false,
  hostTurnGap = false,
  children,
  ...props
}: Omit<
  ComponentPropsWithoutRef<'div'>,
  'className' | 'onFocusCapture' | 'onBlurCapture'
> & {
  variant?: 'timer' | 'actions';
  inset?: boolean;
  hostTurnGap?: boolean;
}): JSX.Element {
  const [focusWithin, setFocusWithin] = useState(false);
  const focusedRef = useRef<Element | null>(null);
  useEffect(() => {
    if (!focusWithin) return undefined;
    // A popped-out panel renders the row in another window's document.
    const ownerDocument = focusedRef.current?.ownerDocument ?? document;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recheck = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      // Run after the event's handlers, so React has recorded any new focus.
      timer = setTimeout(() => {
        const focused = focusedRef.current;
        if (
          focused?.isConnected === true &&
          focused.ownerDocument.activeElement === focused
        )
          return;
        focusedRef.current = null;
        setFocusWithin(false);
      }, 0);
    };
    for (const type of FOCUS_RECHECK_EVENTS)
      ownerDocument.addEventListener(type, recheck, true);
    return (): void => {
      for (const type of FOCUS_RECHECK_EVENTS)
        ownerDocument.removeEventListener(type, recheck, true);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [focusWithin]);
  // Clean chat look: the row is one more line in the turn's rhythm, in the
  // step rows' text, rather than a small stamp tucked under the last row.
  const clean = useCleanChatLook();
  const className =
    variant === 'actions'
      ? `group/footer flex justify-end gap-0.5 ${clean ? CLEAN_TURN_FOOTER_CONTROLS_CLASSNAME : `-mt-1.5 ${TURN_FOOTER_CONTROLS_CLASSNAME}`}`
      : clean
        ? `group/footer flex min-h-7 items-center gap-1.5 text-s fg-secondary ${inset ? 'px-3' : ''} ${hostTurnGap ? 'mb-3' : 'mb-5'} ${CLEAN_TURN_FOOTER_CONTROLS_CLASSNAME}`
        : `group/footer flex min-h-5 items-center gap-1.5 text-2xs leading-none fg-tertiary ${inset ? 'px-3 -mt-1.5' : '-mt-1'} ${hostTurnGap ? 'mb-3' : 'mb-5'} ${TURN_FOOTER_CONTROLS_CLASSNAME}`;
  return (
    <div
      {...props}
      data-focus-within={focusWithin ? '' : undefined}
      className={className}
      onFocusCapture={(event): void => {
        focusedRef.current = event.target;
        setFocusWithin(true);
      }}
      // Moving focus between two controls in the row fires the next focus
      // event right after this blur, which marks the row again.
      onBlurCapture={(): void => setFocusWithin(false)}
    >
      {children}
    </div>
  );
}

/**
 * A turn's elapsed whole seconds minus its pauses. Older saved timers carry
 * `pausedAt`/`resumedAt` without a pause total, so that interval stands in.
 */
export function getElapsedSecond(
  startedAt: number | undefined,
  finishedAt: number | null | undefined,
  pausedAt?: number | null,
  resumedAt?: number | null,
  accumulatedPausedDurationMs?: number,
): number | null {
  if (startedAt == null) return null;
  const endAt = finishedAt ?? Date.now();
  const completedPauseMs =
    typeof accumulatedPausedDurationMs === 'number'
      ? Math.max(0, accumulatedPausedDurationMs)
      : pausedAt != null && resumedAt != null
        ? Math.max(0, resumedAt - Math.max(startedAt, pausedAt))
        : 0;
  const activePauseMs =
    pausedAt == null || resumedAt != null
      ? 0
      : Math.max(0, endAt - Math.max(startedAt, pausedAt));
  return Math.max(
    0,
    Math.floor((endAt - startedAt - completedPauseMs - activePauseMs) / 1000),
  );
}

/**
 * Self-ticking completion-stamp label ("just now" / "5m ago" / "10:11 AM" /
 * "Apr 10, 9:15 AM") for a completed turn. Completed turn groups are frozen
 * by referential identity upstream (incremental-turn-groups), so the label
 * must re-render itself; the refresh cadence tracks the label's own
 * transitions ("just now" flips at exactly one minute, the minutes tier moves
 * every minute, and the clock-time tiers only change at day rollover) and
 * state only changes when the text changes.
 */
function useCompletionStampLabel(timestamp: number | null): string | null {
  const [label, setLabel] = useState<string | null>(() =>
    timestamp != null ? formatCompletionTimestamp(timestamp) : null,
  );

  useEffect((): (() => void) | undefined => {
    if (timestamp == null) {
      setLabel(null);
      return undefined;
    }
    setLabel(formatCompletionTimestamp(timestamp));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      const ageMs = Date.now() - timestamp;
      const delay =
        ageMs < 60_000
          ? Math.max(60_000 - ageMs, 1_000)
          : ageMs < 3_600_000
            ? 30_000
            : 60_000;
      timer = setTimeout((): void => {
        setLabel(formatCompletionTimestamp(timestamp));
        arm();
      }, delay);
    };
    arm();
    return (): void => {
      if (timer != null) clearTimeout(timer);
    };
  }, [timestamp]);

  return timestamp != null ? label : null;
}

/**
 * A turn's elapsed whole seconds, minus pauses, ticking once a second while
 * `live`. Null without a start time.
 */
export function useTurnElapsedSecond({
  startedAt,
  finishedAt,
  pausedAt,
  resumedAt,
  accumulatedPausedDurationMs,
  live,
}: {
  startedAt?: number;
  finishedAt?: number | null;
  pausedAt?: number | null;
  resumedAt?: number | null;
  accumulatedPausedDurationMs?: number;
  live: boolean;
}): number | null {
  const [displayedSecond, setDisplayedSecond] = useState(() =>
    getElapsedSecond(
      startedAt,
      finishedAt,
      pausedAt,
      resumedAt,
      accumulatedPausedDurationMs,
    ),
  );
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const displayedSecondRef = useRef(displayedSecond);

  useEffect(() => {
    displayedSecondRef.current = displayedSecond;
  }, [displayedSecond]);

  useEffect((): (() => void) => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    const initial = getElapsedSecond(
      startedAt,
      live ? null : (finishedAt ?? pausedAt),
      pausedAt,
      resumedAt,
      accumulatedPausedDurationMs,
    );
    if (displayedSecondRef.current !== initial) {
      displayedSecondRef.current = initial;
      setDisplayedSecond(initial);
    }

    if (!live || startedAt == null) {
      return (): void => undefined;
    }
    intervalRef.current = setInterval((): void => {
      const next = getElapsedSecond(
        startedAt,
        null,
        pausedAt,
        resumedAt,
        accumulatedPausedDurationMs,
      );
      if (displayedSecondRef.current !== next) {
        displayedSecondRef.current = next;
        setDisplayedSecond(next);
      }
    }, 1000);
    return (): void => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [
    accumulatedPausedDurationMs,
    finishedAt,
    live,
    pausedAt,
    resumedAt,
    startedAt,
  ]);

  return displayedSecond;
}

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

/** "Oct 21, 2026, 4:05 PM": the full date the clean look's time shows on hover. */
function formatFullTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Pure display timer indicator for an in-flight chat turn. Mirrors the
 * canopy desktop TurnTimer footprint (live ticking elapsed time, then
 * "Completed in M:SS" / "Completed in H:MM:SS" on finish), while also supporting the simpler web
 * portal variant where the host already knows whether the turn is
 * streaming and does not have a `startedAt` timestamp.
 */
export function TurnTimer({
  startedAt,
  finishedAt,
  pausedAt,
  resumedAt,
  accumulatedPausedDurationMs,
  isStreaming,
  trailing,
  spinner,
  stampAccessory,
  copyText,
  moreMenu,
  modelLabel,
  alwaysVisible = false,
  inset = false,
  hostTurnGap = false,
  workingLabel,
  completionStatus = 'complete',
  liveStatusShown = false,
}: TurnTimerProps): JSX.Element {
  // Clean chat look: the turn's header owns the elapsed time ("Working for
  // 28s"), so this row only shimmers what the turn is doing while no step
  // on screen does, and keeps its stamp and actions.
  const clean = useCleanChatLook();
  const resolvedWorkingLabel =
    workingLabel ?? (clean ? 'Thinking' : 'Working…');
  const paused = finishedAt == null && pausedAt != null && resumedAt == null;
  const live =
    !paused &&
    (isStreaming === undefined ? finishedAt == null : isStreaming === true);
  const displayedSecond = useTurnElapsedSecond({
    startedAt,
    finishedAt,
    pausedAt,
    resumedAt,
    accumulatedPausedDurationMs,
    live,
  });

  const completionLabel =
    completionStatus === 'failed'
      ? 'Failed'
      : completionStatus === 'cancelled'
        ? 'Cancelled'
        : 'Completed';
  let label: string;
  if (displayedSecond != null) {
    const formatted = formatElapsed(displayedSecond);
    label = live
      ? `${resolvedWorkingLabel} ${formatted}`
      : paused
        ? `Paused at ${formatted}`
        : `${completionLabel} ${completionStatus === 'complete' ? 'in' : 'after'} ${formatted}`;
  } else {
    label = live ? resolvedWorkingLabel : paused ? 'Paused' : completionLabel;
  }

  const state: 'live' | 'paused' | 'completed' = live
    ? 'live'
    : paused
      ? 'paused'
      : 'completed';

  const completedAtMs =
    state === 'completed' && finishedAt != null ? finishedAt : null;
  const completedTitle =
    completedAtMs != null
      ? `${completionLabel} at ${new Date(completedAtMs).toLocaleString()}`
      : undefined;
  const relativeLabel = useCompletionStampLabel(completedAtMs);
  // The timestamp and the thumbs beside it lead the row and stay visible as
  // the delimiter between turns; everything else fades in on turn hover or
  // focus. Opacity only, so the row never changes height.
  // A running turn keeps its controls (watch, fork, auto-archive) in view,
  // so an armed watcher or auto-archive is always visible.
  const reveal = turnFooterRevealClassName(
    state === 'completed',
    completionStatus,
    alwaysVisible,
  );
  const replyToCopy =
    state === 'completed' && copyText !== undefined && copyText.trim() !== ''
      ? copyText
      : undefined;
  // Clean chat look: a finished turn's row drops "Completed in …", but a
  // failed or cancelled turn keeps its outcome so it never reads as done.
  const cleanOutcomeShown =
    clean && state === 'completed' && completionStatus !== 'complete';
  const showLabel = !clean || (live && !liveStatusShown) || cleanOutcomeShown;

  return (
    <TurnFooterRow
      inset={inset}
      hostTurnGap={hostTurnGap}
      data-testid="turn-timer"
      data-state={state}
    >
      {!clean && relativeLabel != null && (
        <span
          data-testid="turn-timer-relative"
          className="shrink-0 whitespace-nowrap tabular-nums fg-quaternary"
          title={completedTitle}
        >
          {relativeLabel}
        </span>
      )}
      {/* Classic look: Copy sits with the stamp and thumbs, outside the
          hover reveal, so every finished reply can be kept at a glance. */}
      {!clean && replyToCopy !== undefined && (
        <ChatCopyAction text={replyToCopy} dataTestId="turn-copy-message" />
      )}
      {!clean && stampAccessory != null && (
        <span
          data-testid="turn-timer-stamp-accessory"
          className="flex shrink-0 items-center"
        >
          {stampAccessory}
        </span>
      )}
      {live && !clean && spinner}
      {cleanOutcomeShown && (
        <span
          data-testid="turn-timer-label"
          className="min-w-0 truncate whitespace-nowrap tabular-nums"
          title={completedTitle}
        >
          {label}
        </span>
      )}
      {showLabel && clean && !cleanOutcomeShown && (
        <StepRow
          icon={<LightbulbIcon />}
          label={
            <span data-testid="turn-timer-label">{resolvedWorkingLabel}</span>
          }
          running
        />
      )}
      {showLabel && !clean && (
        <span
          data-testid="turn-timer-label"
          className={`min-w-0 truncate whitespace-nowrap tabular-nums ${reveal}`}
          title={completedTitle}
        >
          {label}
        </span>
      )}
      {!clean && trailing != null && (
        <span className={`flex items-center gap-1.5 ${reveal}`}>
          {trailing}
        </span>
      )}
      {/* Clean chat look: Copy stays visible. Fork, "•••", thumbs and time
          reveal on hover/focus for historical turns; the row keeps its
          existing order and spacing. */}
      {clean &&
        (replyToCopy !== undefined ||
          stampAccessory != null ||
          trailing != null ||
          moreMenu != null) && (
          <span
            data-testid="turn-actions"
            // Leading the row, the first icon (not its 24px button) lines up
            // with the reply's text.
            className={`flex items-center gap-0.5 ${showLabel ? '' : '-ml-1.25'}`}
          >
            {replyToCopy !== undefined && (
              <ChatCopyAction
                text={replyToCopy}
                dataTestId="turn-copy-message"
              />
            )}
            <span
              data-testid="turn-actions-reveal"
              className={`flex items-center gap-0.5 ${reveal}`}
            >
              {trailing}
              {moreMenu}
              {stampAccessory != null && (
                <span
                  data-testid="turn-timer-stamp-accessory"
                  className="flex shrink-0 items-center"
                >
                  {stampAccessory}
                </span>
              )}
            </span>
          </span>
        )}
      {clean && relativeLabel != null && completedAtMs != null && (
        <Tooltip
          label={
            modelLabel === undefined
              ? formatFullTimestamp(completedAtMs)
              : `${formatFullTimestamp(completedAtMs)} · ${modelLabel}`
          }
        >
          <span
            data-testid="turn-timer-relative"
            className={`ml-1 shrink-0 whitespace-nowrap tabular-nums ${reveal}`}
          >
            {relativeLabel}
          </span>
        </Tooltip>
      )}
    </TurnFooterRow>
  );
}
