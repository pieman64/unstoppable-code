'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  DIALOG_CONFIRM_CHORD,
  DISMISS_CHORD,
  formatChord,
} from '../lib/shortcut-platform';
import { Button } from './Button';
import { DialogModal } from './DialogModal';
import { FieldError, TextInput } from './Field';

export interface RenameDialogProps {
  readonly title: string;
  readonly label: string;
  /** Read once on mount; remount (or change `key`) to reopen with a fresh value. */
  readonly initialValue: string;
  readonly placeholder?: string;
  readonly helperText?: string;
  readonly maxLength?: number;
  /** Repeats the title's verb. Defaults to `Rename`. */
  readonly submitLabel?: string;
  /** Disables the action and dismissal while the host persists the value. */
  readonly busy?: boolean;
  /**
   * Why the submitted value can't be saved (`A workflow named “Bug fix”
   * already exists.`). It shows under the field only after a submit: the
   * dialog stays open with the person's text, and editing the field clears
   * the message until the next submit. The host sets it from `onSubmit`.
   */
  readonly error?: string | null;
  /**
   * Receives the raw draft. Normalization, empty-value semantics and whether
   * an unchanged value is a no-op belong to the host.
   */
  readonly onSubmit: (value: string) => void;
  readonly onClose: () => void;
  readonly ownerDocument?: Document;
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
  readonly titleId?: string;
  readonly inputId?: string;
  readonly dataTestId?: string;
  readonly inputTestId?: string;
  readonly submitTestId?: string;
  readonly cancelTestId?: string;
}

/**
 * Single-field rename dialog shared by desktop and web hosts. It takes the
 * compact confirmation shape: the field focuses to the neutral halo with its
 * value selected, Enter submits, and Cancel or Escape closes it. Both keys
 * sit inside their buttons, as in {@link ConfirmDialog}.
 */
export function RenameDialog({
  title,
  label,
  initialValue,
  placeholder,
  helperText,
  maxLength,
  submitLabel = 'Rename',
  busy = false,
  error = null,
  onSubmit,
  onClose,
  ownerDocument,
  restoreFocusRef,
  titleId,
  inputId,
  dataTestId,
  inputTestId,
  submitTestId,
  cancelTestId,
}: RenameDialogProps): JSX.Element {
  const [draft, setDraft] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const fieldId = inputId ?? `${generatedId}-input`;
  const helperId = `${fieldId}-helper`;
  const errorId = `${fieldId}-error`;
  // An error is about the last submit, so it shows only until the person
  // edits the field again.
  const [submittedSinceEdit, setSubmittedSinceEdit] = useState(false);
  const visibleError =
    error !== null && error !== '' && submittedSinceEdit ? error : null;
  const describedBy =
    [helperText ? helperId : null, visibleError !== null ? errorId : null]
      .filter((id): id is string => id !== null)
      .join(' ') || undefined;

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const close = busy ? (): void => undefined : onClose;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    setSubmittedSinceEdit(true);
    onSubmit(draft);
  };

  // Enter during IME composition commits the candidate, not the form.
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && event.nativeEvent.isComposing) {
      event.preventDefault();
    }
  };

  return (
    <DialogModal
      variant="confirm"
      onClose={close}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      title={title}
      titleId={titleId}
      dataTestId={dataTestId}
      ownerDocument={ownerDocument}
      trapFocus
      initialFocusRef={inputRef}
      restoreFocusRef={restoreFocusRef}
    >
      <form className="flex flex-col px-5 pb-4" onSubmit={handleSubmit}>
        <label
          className="mt-3 mb-1.5 block text-xs fg-secondary"
          htmlFor={fieldId}
        >
          {label}
        </label>
        <TextInput
          ref={inputRef}
          id={fieldId}
          density="settings"
          value={draft}
          placeholder={placeholder}
          maxLength={maxLength}
          onChange={(event) => {
            setDraft(event.target.value);
            // Editing makes the last submit's error stale.
            setSubmittedSinceEdit(false);
          }}
          onKeyDown={handleKeyDown}
          aria-describedby={describedBy}
          aria-invalid={visibleError !== null ? true : undefined}
          data-testid={inputTestId}
          autoComplete="off"
          spellCheck={false}
        />
        {visibleError !== null ? (
          <div className="mt-1.5">
            <FieldError
              id={errorId}
              data-testid={inputTestId ? `${inputTestId}-error` : undefined}
            >
              {visibleError}
            </FieldError>
          </div>
        ) : null}
        {helperText ? (
          <p id={helperId} className="mt-1.5 text-xs text-pretty fg-tertiary">
            {helperText}
          </p>
        ) : null}
        <div className="mt-4.5 flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="compact"
            onClick={close}
            disabled={busy}
            shortcut={formatChord(DISMISS_CHORD)}
            data-testid={cancelTestId}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="compact"
            disabled={busy}
            aria-busy={busy}
            shortcut={busy ? undefined : formatChord(DIALOG_CONFIRM_CHORD)}
            data-testid={submitTestId}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </DialogModal>
  );
}
