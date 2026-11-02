import { useContinuousMotion } from '../../lib/continuous-motion';
import {
  Children,
  Fragment,
  cloneElement,
  forwardRef,
  isValidElement,
  useMemo,
  type CSSProperties,
  type JSX,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import { ChevronRightIcon } from '../../icons';
import { StepBadgeLine, useStepBadgeRows } from '../chat-look';

/**
 * The clean chat look's one row for every agent step: tool calls, step
 * groups, thinking, helper agents, a finished turn's summary and its changed
 * files. Quiet and text-first, after the ChatGPT / Claude Code / OpenCode
 * transcripts:
 *
 * - the icon is the text's size and color, so it reads as part of the line;
 * - the label is secondary ink, details tertiary ink, both in the row's font;
 * - work in progress shimmers its words instead of showing a spinner, a
 *   primary-ink band over words drawn a step lighter, so it reads at a glance
 *   in light and dark;
 * - small icons draw a 1.5px stroke, like the text's own strokes;
 * - a chevron after the words appears on hover and turns down while open;
 * - nothing is clipped: one line, truncated with an ellipsis only when the
 *   row is wider than its column.
 *
 * No color at all: a failure is said in words, by the label itself
 * ("Couldn't run …") or by "error" after it.
 */
export interface StepRowProps {
  /** The step's kind, drawn at the text's size and in its color. */
  icon?: ReactNode;
  /** What happened, in plain words ("Ran 2 commands", "Read file.ts"). */
  label: ReactNode;
  /** Extra detail in a lighter ink (a command, a description). */
  detail?: ReactNode;
  /** Shimmer the words while the step is still running. */
  running?: boolean;
  /** Name a failure after the words, for labels that don't say it. */
  failed?: boolean;
  /** Whether the row opens; draws the chevron and makes it a button. */
  expandable?: boolean;
  isOpen?: boolean;
  onToggle?: MouseEventHandler<HTMLButtonElement>;
  ariaLabel?: string;
  dataTestId?: string;
  /** Extra classes for the row (host padding, alignment). */
  className?: string;
  /** Content after the words, such as change counts. */
  trailing?: ReactNode;
  /** Keep the chevron visible at rest instead of only on hover. */
  chevronAtRest?: boolean;
  /**
   * The row of one step (a tool call, a helper agent, a thought), not a turn
   * header or a run's line. At chat detail `detailed` it takes the tool call
   * card's row: `text-xs`, a 14px icon at the default stroke, and its words
   * and code badges on one line.
   */
  step?: boolean;
}

export const STEP_ROW_TEXT_CLASS = 'text-s fg-secondary';

/** One shimmer sweep, matching `canopy-text-shimmer-sweep` in the tokens CSS. */
const SHIMMER_CYCLE_MS = 2400;

export type ShimmerStyle = CSSProperties & {
  '--canopy-shimmer-delay'?: string;
};

/**
 * Starts a row's shimmer at the point the document clock has reached in the
 * cycle, so every live row sweeps in step and a row that remounts or starts
 * running mid-turn joins the sweep instead of restarting it.
 */
export function useShimmerPhase(running: boolean): ShimmerStyle | undefined {
  return useMemo(() => {
    if (!running || typeof performance === 'undefined') return undefined;
    const elapsed = Math.round(performance.now() % SHIMMER_CYCLE_MS);
    return { '--canopy-shimmer-delay': `-${String(elapsed)}ms` };
  }, [running]);
}

const BADGE_LINE_CLASS =
  'flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap';

/**
 * A badge row's words: each run of plain text in its own truncating span, so
 * it ends in an ellipsis inside the flex line the badges shrink in. A label
 * wrapped in one span becomes a line of its own that shrinks the same way.
 */
function truncatingWords(label: ReactNode): ReactNode {
  if (
    isValidElement<{ children?: ReactNode; className?: string }>(label) &&
    label.type === 'span'
  ) {
    const { className } = label.props;
    return cloneElement(
      label,
      {
        className:
          className === undefined
            ? BADGE_LINE_CLASS
            : `${className} ${BADGE_LINE_CLASS}`,
      },
      truncatingWords(label.props.children),
    );
  }
  const parts =
    isValidElement<{ children?: ReactNode }>(label) && label.type === Fragment
      ? label.props.children
      : label;
  return Children.map(parts, (part) => {
    if (isValidElement(part) && part.type === Fragment) {
      return truncatingWords(part);
    }
    if (typeof part !== 'string' && typeof part !== 'number') return part;
    // A lone space stays plain text: a flex line draws no box for it (the
    // gap spaces the parts), but copied and spoken text keeps the space.
    if (String(part).trim() === '') return part;
    return <span className="min-w-0 truncate">{part}</span>;
  });
}

export const StepRow = forwardRef<HTMLButtonElement, StepRowProps>(
  function StepRow(
    {
      icon,
      label,
      detail,
      running = false,
      failed = false,
      expandable = false,
      isOpen = false,
      onToggle,
      ariaLabel,
      dataTestId,
      className = '',
      trailing,
      chevronAtRest = false,
      step = false,
    },
    ref,
  ): JSX.Element {
    const shimmerStyle = useShimmerPhase(running);
    const motionRef = useContinuousMotion<HTMLSpanElement>(running);
    // Chat detail `detailed`: the row of a tool call card, its words and
    // code badges on one line where only a badge's text shrinks.
    const badgeRow = useStepBadgeRows();
    const badges = step && badgeRow;
    const words = (
      <span
        className={`${badges ? BADGE_LINE_CLASS : 'min-w-0 truncate'}${running ? ' canopy-text-shimmer-strong' : ''}`}
        ref={motionRef}
        style={shimmerStyle}
        data-step-row-words=""
      >
        {badges ? (
          <StepBadgeLine>{truncatingWords(label)}</StepBadgeLine>
        ) : (
          label
        )}
        {detail != null && (
          <span
            className={
              badges ? 'min-w-0 truncate fg-tertiary' : 'ml-1.5 fg-tertiary'
            }
          >
            {detail}
          </span>
        )}
      </span>
    );
    const content = (
      <>
        {icon != null && (
          <span
            className={
              badges
                ? 'flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center fg-secondary [&_svg]:size-3.5'
                : 'flex h-5 flex-shrink-0 items-center [&_svg]:size-3.5'
            }
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        {words}
        {failed && (
          <span
            className="flex-shrink-0 fg-tertiary"
            data-testid="tool-call-failed"
          >
            error
          </span>
        )}
        {trailing}
        {expandable && (
          // 4px from the words, half the icon gap: the chevron belongs to
          // them.
          <span
            className={`-ml-1 flex h-5 flex-shrink-0 items-center fg-tertiary transition-[opacity,transform] [&_svg]:size-3.5 ${
              isOpen
                ? 'rotate-90 opacity-100'
                : chevronAtRest
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
            }`}
            aria-hidden="true"
          >
            <ChevronRightIcon />
          </span>
        )}
      </>
    );
    const rowClass = `group ${badges ? 'text-xs fg-secondary' : `canopy-small-icon-stroke ${STEP_ROW_TEXT_CLASS}`} flex min-w-0 max-w-full items-center gap-2 py-1 text-left${
      className === '' ? '' : ` ${className}`
    }`;
    if (!expandable) {
      return (
        <div className={rowClass} data-testid={dataTestId} data-step-row="">
          {content}
        </div>
      );
    }
    return (
      <button
        ref={ref}
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        data-testid={dataTestId}
        data-step-row=""
        className={`focus-ring rounded-sm transition-colors hover:fg-primary ${rowClass}`}
      >
        {content}
      </button>
    );
  },
);

/**
 * Opened step content: indented under the words (the 14px icon plus the
 * row's 8px gap), no box around prose.
 */
export const STEP_ROW_BODY_CLASS = 'ml-5.5 mt-1 text-s';

/** An opened run of steps: its rows sit on the run row's own left edge. */
export const STEP_GROUP_BODY_CLASS = 'mt-0.5';
