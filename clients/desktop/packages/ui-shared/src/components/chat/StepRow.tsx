import {
  forwardRef,
  type JSX,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import { ChevronRightIcon } from '../../icons';

/**
 * The clean chat look's one row for every agent step: tool calls, step
 * groups, thinking, helper agents, a finished turn's summary and its changed
 * files. Quiet and text-first, after the ChatGPT / Claude Code / OpenCode
 * transcripts:
 *
 * - the icon is the text's size and color, so it reads as part of the line;
 * - the label is secondary ink, details tertiary ink, both in the row's font;
 * - work in progress shimmers its words instead of showing a spinner;
 * - a chevron after the words appears on hover and turns down while open;
 * - nothing is clipped: one line, truncated with an ellipsis only when the
 *   row is wider than its column.
 *
 * No color at all: a failure is said in words, by the label itself
 * ("Couldn't run …") or by "failed" after it.
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
}

export const STEP_ROW_TEXT_CLASS = 'text-s fg-secondary';

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
    },
    ref,
  ): JSX.Element {
    const words = (
      <span
        className={`min-w-0 truncate${running ? ' canopy-text-shimmer' : ''}`}
        data-step-row-words=""
      >
        {label}
        {detail != null && <span className="ml-1.5 fg-tertiary">{detail}</span>}
      </span>
    );
    const content = (
      <>
        {icon != null && (
          <span
            className="flex h-5 flex-shrink-0 items-center [&_svg]:size-3.5"
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
            failed
          </span>
        )}
        {trailing}
        {expandable && (
          <span
            className={`flex h-5 flex-shrink-0 items-center fg-tertiary transition-[opacity,transform] [&_svg]:size-3.5 ${
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
    const rowClass = `group flex min-w-0 max-w-full items-center gap-2 py-1 text-left ${STEP_ROW_TEXT_CLASS}${
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
