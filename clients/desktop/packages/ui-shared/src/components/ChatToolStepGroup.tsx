'use client';

import { memo, useState, type JSX, type ReactNode } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '../icons';
import { ThinkingSpinner } from './ThinkingSpinner';
import { useCleanChatLook } from './chat-look';
import { STEP_GROUP_BODY_CLASS, StepRow } from './chat/StepRow';

/**
 * One transcript row standing in for a run of agent steps (tool calls, and
 * thinking when the host counts it). Closed, it reads like "Searched 3 times,
 * read 4 files"; while a call still runs, its label and a spinner follow the
 * summary. Opening it shows every step (`children`), as the host renders
 * them, and they keep updating while the turn runs.
 *
 * `liveSteps` (CAN-4274) are the newest steps of a run the turn is still
 * adding to; they show under the closed row instead of the running label,
 * since their own row already spins. Hosts own segmentation and the summary
 * text; this component is display only.
 */
export const ChatToolStepGroup = memo(function ChatToolStepGroup({
  summary,
  runningLabel,
  forceExpanded = false,
  liveSteps,
  children,
  icon,
}: {
  /** Plain-words summary of every step in the run. */
  summary: string;
  /** Label of the call still running, when the turn is running. */
  runningLabel?: ReactNode;
  /** Opens the group without changing its saved state (search reveal). */
  forceExpanded?: boolean;
  /** The newest steps, shown under the closed row while the run is live. */
  liveSteps?: ReactNode;
  /** Every step in the run, rendered when the group is open. */
  children: ReactNode;
  /**
   * The run's kind of step. Under the clean chat look the group leads with
   * it, like a step row.
   */
  icon?: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState<boolean | null>(null);
  const clean = useCleanChatLook();
  // Clean chat look: a run that is still going stays open, so its newest
  // step shimmers in place, and folds into its words once it is done.
  // Opening or closing it by hand sticks.
  const stillRunning = runningLabel !== undefined && runningLabel !== null;
  const isOpen = forceExpanded || (open ?? (clean && stillRunning));
  const showLiveSteps = liveSteps !== undefined && !isOpen;
  const running = showLiveSteps || (clean && isOpen) ? undefined : runningLabel;
  const hasRunning = running !== undefined && running !== null;
  if (clean) {
    return (
      <div data-testid="chat-tool-step-group">
        <div className="flex min-w-0 max-w-full px-3">
          <StepRow
            icon={icon}
            label={<span data-testid="chat-tool-step-summary">{summary}</span>}
            detail={
              hasRunning ? (
                <span data-testid="chat-tool-step-running">· {running}</span>
              ) : undefined
            }
            running={hasRunning}
            expandable
            isOpen={isOpen}
            onToggle={(): void => setOpen(!isOpen)}
          />
        </div>
        {isOpen ? (
          <div className={STEP_GROUP_BODY_CLASS}>{children}</div>
        ) : null}
        {showLiveSteps ? (
          <div className="pl-5.5" data-testid="chat-tool-step-live">
            {liveSteps}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div data-testid="chat-tool-step-group">
      <div className="flex min-w-0 max-w-full px-3">
        <button
          type="button"
          onClick={(): void => setOpen((previous) => !(previous ?? false))}
          aria-expanded={isOpen}
          className="flex min-w-0 max-w-full items-center gap-2 py-1 text-left text-xs fg-secondary transition hover:fg-primary"
        >
          <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
            {isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          <span
            className={hasRunning ? 'flex-shrink-0' : 'min-w-0 truncate'}
            data-testid="chat-tool-step-summary"
          >
            {summary}
          </span>
          {hasRunning ? (
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="fg-tertiary">
                ·
              </span>
              <span
                className="min-w-0 truncate fg-primary"
                data-testid="chat-tool-step-running"
              >
                {running}
              </span>
              <span className="inline-flex flex-shrink-0 -translate-y-px fg-accent">
                <ThinkingSpinner />
              </span>
            </span>
          ) : null}
        </button>
      </div>
      {isOpen ? <div className="pl-5.5">{children}</div> : null}
      {showLiveSteps ? (
        <div className="pl-5.5" data-testid="chat-tool-step-live">
          {liveSteps}
        </div>
      ) : null}
    </div>
  );
});
