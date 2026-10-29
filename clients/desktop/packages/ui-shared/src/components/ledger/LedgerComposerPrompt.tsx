'use client';

import { useId, type JSX } from 'react';
import { LedgerActorAvatar } from './LedgerActorAvatar';
import type { LedgerDensity } from './ledger-entry-slots';

export interface LedgerComposerPromptProps {
  readonly density: LedgerDensity;
  /** The person, for their avatar. */
  readonly personName: string;
  /** The prompt; defaults to `Add a task, decision or finding`. The feature layer passes `Continue draft` while one is set aside. */
  readonly label?: string;
  readonly onOpen: () => void;
  /** Why nothing can be added now; disables the prompt and explains it. */
  readonly disabledReason?: string | null;
  /**
   * The pill's `data-testid`, for a host whose automation already names
   * this action, such as `ledger-add-entry`.
   */
  readonly testId?: string;
}

/** A quiet, collapsed prompt for the column's entry composer. */
export function LedgerComposerPrompt({
  density,
  personName,
  label = 'Add a task, decision or finding',
  onOpen,
  disabledReason,
  testId = 'ledger-composer-prompt',
}: LedgerComposerPromptProps): JSX.Element {
  const reasonId = useId();
  const reason = disabledReason ?? undefined;
  const disabled = reason !== undefined;
  const page = density === 'page';

  return (
    <section
      aria-label="Add an entry"
      className={`flex items-center gap-3 border-b border-line-base ${page ? 'pb-4' : 'pb-3'}`}
    >
      <LedgerActorAvatar
        kind="user"
        name={personName}
        size={page ? 'large' : 'small'}
        // The person writing is the one on this device.
        localUser
      />
      <button
        type="button"
        data-testid={testId}
        disabled={disabled}
        title={reason}
        aria-describedby={disabled ? reasonId : undefined}
        onClick={onOpen}
        className={`focus-ring min-w-0 flex-1 truncate rounded-full bg-subtle px-4 py-2 text-left fg-tertiary enabled:hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40 ${page ? 'text-s' : 'text-xs'}`}
      >
        {label}
      </button>
      {disabled && (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
    </section>
  );
}
