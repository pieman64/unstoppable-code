'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  formatAcceleratorForDisplay,
  type ShortcutPlatform,
} from '@canopy/protocol/shortcuts';
import {
  Button,
  LoadingSpinner,
  Kbd,
  TextInput,
} from '@canopy/ui-shared/components';
import { interpretShortcutRecorderKey } from './shortcut-recorder';

export interface ShortcutRecorderFieldProps {
  /** The saved accelerator, or null when there is none. */
  readonly value: string | null;
  /** Platform whose keys the recorder reads and displays. */
  readonly platform: ShortcutPlatform;
  /** Names the action, for example `Shortcut for build`. */
  readonly label: string;
  /** Why a recorded chord cannot be saved, or null when it can. */
  readonly validate: (accelerator: string) => string | null;
  /** Persists the chord (null clears it). Rejections are shown inline. */
  readonly onSave: (accelerator: string | null) => Promise<void>;
  readonly disabled?: boolean;
  readonly testId?: string;
}

/** Recorder draft: `undefined` before a press, `null` for "no shortcut". */
interface Draft {
  readonly accelerator: string | null | undefined;
  readonly problem: string | null;
}

const RECORDER_HINT =
  'Hold the modifier keys and press a key. Backspace clears, Esc cancels.';

/**
 * Browser-safe shortcut recorder: records on keydown by physical key, Escape
 * cancels, Backspace clears, and Tab still moves focus to Save and Cancel.
 * The host validates each press and persists the result.
 */
export function ShortcutRecorderField({
  value,
  platform,
  label,
  validate,
  onSave,
  disabled = false,
  testId = 'shortcut-recorder',
}: ShortcutRecorderFieldProps): JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);
  const mounted = useRef(true);
  const hintId = useId();

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const recording = draft !== null;
  useEffect(() => {
    if (recording) inputRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      editRef.current?.focus();
    }
  }, [recording]);

  const stop = (): void => {
    returnFocus.current = true;
    setDraft(null);
    setError(null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const key = interpretShortcutRecorderKey(event, platform);
    if (key.kind === 'pass') return;
    event.preventDefault();
    event.stopPropagation();
    if (key.kind === 'cancel') {
      stop();
      return;
    }
    if (key.kind === 'ignore') return;
    setError(null);
    if (key.kind === 'clear') {
      setDraft({ accelerator: null, problem: null });
      return;
    }
    setDraft({
      accelerator: key.accelerator,
      problem: validate(key.accelerator),
    });
  };

  const save = (): void => {
    if (draft === null || draft.accelerator === undefined) return;
    const next = draft.accelerator;
    setSaving(true);
    setError(null);
    onSave(next)
      .then(() => {
        if (!mounted.current) return;
        setSaving(false);
        stop();
      })
      .catch((cause: unknown) => {
        if (!mounted.current) return;
        setSaving(false);
        setError(
          cause instanceof Error && cause.message.trim() !== ''
            ? cause.message
            : "Couldn't save the shortcut. Try again.",
        );
      });
  };

  const display =
    value === null ? null : formatAcceleratorForDisplay(value, platform);

  if (draft === null)
    return (
      <div className="flex flex-col gap-1" data-testid={testId}>
        <div className="flex flex-wrap items-center gap-2">
          {display === null ? (
            <span className="text-xs fg-tertiary">No shortcut</span>
          ) : (
            <span data-testid={`${testId}-value`}>
              <Kbd data-testid="shortcut-keys" shortcut={display} />
            </span>
          )}
          <Button
            ref={editRef}
            size="compact"
            variant="secondary"
            disabled={disabled}
            aria-label={`${display === null ? 'Add' : 'Edit'} ${label.toLowerCase()}`}
            data-testid={`${testId}-edit`}
            onClick={(): void => {
              setError(null);
              setDraft({ accelerator: undefined, problem: null });
            }}
          >
            {display === null ? 'Add shortcut' : 'Edit shortcut'}
          </Button>
        </div>
      </div>
    );

  const preview =
    draft.accelerator === undefined
      ? null
      : draft.accelerator === null
        ? 'none'
        : formatAcceleratorForDisplay(draft.accelerator, platform);
  const unchanged =
    draft.accelerator === undefined ||
    (draft.accelerator === null && value === null);
  const canSave = !unchanged && draft.problem === null && !saving;

  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          ref={inputRef}
          density="settings"
          readOnly
          value=""
          className="w-44"
          placeholder="Press the new shortcut"
          aria-label={`Press the new ${label.toLowerCase()}`}
          aria-describedby={hintId}
          data-testid={`${testId}-input`}
          onKeyDown={onKeyDown}
        />
        <span
          className="flex min-h-6 items-center"
          aria-live="polite"
          data-testid={`${testId}-preview`}
        >
          {preview === 'none' ? (
            <span className="text-xs fg-tertiary">No shortcut</span>
          ) : preview !== null ? (
            <Kbd data-testid="shortcut-keys" shortcut={preview} />
          ) : null}
        </span>
        <Button
          size="compact"
          variant="ghost"
          disabled={saving}
          data-testid={`${testId}-cancel`}
          onClick={stop}
        >
          Cancel
        </Button>
        <Button
          size="compact"
          variant="primary"
          disabled={!canSave}
          data-testid={`${testId}-save`}
          onClick={save}
        >
          {saving ? <LoadingSpinner decorative /> : null}
          Save
        </Button>
      </div>
      {draft.problem !== null ? (
        <p
          className="text-xs fg-destructive"
          data-testid={`${testId}-validation`}
          id={hintId}
        >
          {draft.problem}
        </p>
      ) : (
        <p className="text-xs fg-tertiary" id={hintId}>
          {RECORDER_HINT}
        </p>
      )}
      {error !== null ? (
        <p
          className="text-xs fg-destructive"
          role="alert"
          data-testid={`${testId}-error`}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
