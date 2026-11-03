import type { JSX, ReactNode } from 'react';
import { ChevronRightMediumIcon } from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

export interface StartChatSummaryProps {
  /** Where the chat starts: a project, a worktree, a chat or the Orchestrator. */
  readonly destination: string;
  /** What the automation does on each run, in order (create, send, wait). */
  readonly steps: readonly string[];
  /** Why the chat can't be edited here, when it can't. */
  readonly note?: string;
  /** Trailing actions, such as opening its workflow. */
  readonly actions?: ReactNode;
}

/**
 * A chat automation that runs as a workflow (CAN-4551): where its chat
 * starts and the steps it stands for. Display only; hosts supply the copy
 * from their own models and the actions.
 */
export function StartChatSummary({
  destination,
  steps,
  note,
  actions,
}: StartChatSummaryProps): JSX.Element {
  return (
    <section
      className="rounded-xl border bg-card p-4 text-sm"
      data-testid="start-chat-summary"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className="font-medium"
            data-testid="start-chat-summary-destination"
          >
            Start chat in{' '}
            <span className={REPLAY_MASK_CLASS}>{destination}</span>
          </p>
          <ol
            className="mt-1 flex flex-wrap items-center gap-x-1 text-xs fg-secondary"
            aria-label="Steps"
            data-testid="start-chat-summary-steps"
          >
            {steps.map((step, index) => (
              // Steps repeat, so position is the only stable identity.
              <li
                key={`${step}-${String(index)}`}
                className="flex items-center gap-1"
              >
                {index > 0 ? (
                  <ChevronRightMediumIcon
                    size="sm"
                    aria-hidden="true"
                    className="fg-quaternary"
                  />
                ) : null}
                {step}
              </li>
            ))}
          </ol>
          {note !== undefined ? (
            <p
              className="mt-2 text-xs fg-secondary"
              data-testid="start-chat-summary-note"
            >
              {note}
            </p>
          ) : null}
        </div>
        {actions !== undefined ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </section>
  );
}
