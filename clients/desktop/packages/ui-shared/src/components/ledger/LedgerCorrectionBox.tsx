'use client';

import { useEffect, useId, useRef, type JSX, type KeyboardEvent } from 'react';
import { countLedgerCodePoints } from '../../lib/ledger-display';
import { Button } from '../Button';
import { TextArea } from '../Field';
import { LedgerActorAvatar } from './LedgerActorAvatar';
import { LEDGER_FORM_LIMITS } from './LedgerEntryForm';
import type { LedgerDensity } from './ledger-entry-slots';

export interface LedgerCorrectionBoxProps {
  readonly density: LedgerDensity;
  /** The person writing, the one on this device; their avatar is the person glyph. */
  readonly personName: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Saves the correction; called only while it can be saved. */
  readonly onSubmit: () => void;
  readonly onDiscard: () => void;
  /** Opens the full form in place of the box (the feature layer swaps it in). Omitted: no More options. */
  readonly onMoreOptions?: () => void;
  readonly saving: boolean;
  /** Why the last save did not apply. */
  readonly problem: string | null;
  /** Why no correction can be written now, such as another open draft. */
  readonly disabledReason?: string | null;
}

/** A small correction composer, attached to the entry it corrects. */
export function LedgerCorrectionBox({
  personName,
  value,
  onChange,
  onSubmit,
  onDiscard,
  onMoreOptions,
  saving,
  problem,
  disabledReason,
}: LedgerCorrectionBoxProps): JSX.Element {
  const reasonId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Only a correction just started is empty. A box that mounts again with
  // text, such as a long list's row scrolled back into view, leaves focus
  // where the person is typing.
  const startedEmpty = useRef(value.trim().length === 0);
  useEffect(() => {
    if (startedEmpty.current) inputRef.current?.focus();
  }, []);

  const reason = disabledReason ?? undefined;
  const blocked = reason !== undefined;
  const hasText = value.trim().length > 0;
  const contentCount = countLedgerCodePoints(value);
  const overLimit = contentCount > LEDGER_FORM_LIMITS.content;
  const canSubmit = hasText && !overLimit && !saving && !blocked;
  const submit = (): void => {
    if (canSubmit) onSubmit();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div data-testid="ledger-correction-box" className="flex gap-2">
      {/* The person writing is the one on this device. */}
      <LedgerActorAvatar kind="user" name={personName} size="small" localUser />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <TextArea
          rows={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Add a correction"
          aria-label="Add a correction"
          aria-describedby={blocked ? reasonId : undefined}
          ref={inputRef}
          disabled={saving || blocked}
          title={reason}
          data-testid="ledger-correction-input"
          className="w-full"
        />
        {blocked && (
          <p id={reasonId} className="text-2xs fg-tertiary">
            {reason}
          </p>
        )}
        {overLimit && (
          <p
            aria-live="polite"
            className="text-2xs tabular-nums fg-destructive"
          >
            {`${contentCount}/${LEDGER_FORM_LIMITS.content}`}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          {onMoreOptions !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="compact"
              disabled={saving}
              data-testid="ledger-correction-more"
              onClick={onMoreOptions}
            >
              More options
            </Button>
          )}
          <div
            className={`flex items-center gap-1 ${onMoreOptions === undefined ? 'ml-auto' : ''}`}
          >
            <Button
              type="button"
              variant="ghost"
              size="compact"
              disabled={saving}
              data-testid="ledger-correction-discard"
              onClick={onDiscard}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="compact"
              disabled={!canSubmit}
              data-testid="ledger-correction-save"
              onClick={submit}
            >
              {saving ? 'Saving…' : 'Add correction'}
            </Button>
          </div>
        </div>
        <p className="text-2xs fg-tertiary">
          A correction is a new entry linked to this one, which stays as it is.
        </p>
        {problem !== null && (
          <p
            role="alert"
            className="text-2xs fg-destructive"
            data-testid="ledger-correction-problem"
          >
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}
