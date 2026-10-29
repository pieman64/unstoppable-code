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
import { Button } from './Button';
import { DialogModal } from './DialogModal';

export interface RenameDialogProps {
  /** Preserve the existing inset form presentation where it is already used. */
  readonly variant?: 'default' | 'inset';
  readonly title: string;
  readonly label: string;
  /** Read once on mount; remount (or change `key`) to reopen with a fresh value. */
  readonly initialValue: string;
  readonly placeholder?: string;
  readonly helperText?: string;
  readonly maxLength?: number;
  readonly submitLabel?: string;
  /** Disables Save and dismissal while the host persists the value. */
  readonly busy?: boolean;
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

/** Single-field rename dialog shared by desktop and web hosts. */
export function RenameDialog({
  variant = 'default',
  title,
  label,
  initialValue,
  placeholder,
  helperText,
  maxLength,
  submitLabel = 'Save',
  busy = false,
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
  const inset = variant === 'inset';
  const [draft, setDraft] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const fieldId = inputId ?? `${generatedId}-input`;
  const helperId = `${fieldId}-helper`;

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const close = busy ? (): void => undefined : onClose;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    onSubmit(draft);
  };

  // Enter during IME composition commits the candidate, not the form.
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && event.nativeEvent.isComposing) {
      event.preventDefault();
    }
  };

  const field = (
    <input
      ref={inputRef}
      id={fieldId}
      type="text"
      value={draft}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={handleKeyDown}
      aria-describedby={helperText ? helperId : undefined}
      data-testid={inputTestId}
      className={
        inset
          ? 'mt-2 w-full rounded-md inset-ring inset-ring-line-base bg-base px-3 py-2 text-s fg-primary focus-ring'
          : 'focus-ring h-9 w-full rounded-lg border bg-secondary px-3 text-s fg-primary outline-none'
      }
      autoComplete={inset ? undefined : 'off'}
      spellCheck={inset ? undefined : false}
    />
  );

  return (
    <DialogModal
      onClose={close}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      title={title}
      titleId={titleId}
      maxWidth="sm"
      headerBorder={inset}
      dataTestId={dataTestId}
      ownerDocument={ownerDocument}
      trapFocus
      initialFocusRef={inputRef}
      restoreFocusRef={restoreFocusRef}
    >
      <form
        className={inset ? undefined : 'space-y-4 px-5 pb-5'}
        onSubmit={handleSubmit}
      >
        <label
          className={
            inset
              ? 'block text-s fg-secondary'
              : 'block space-y-1.5 text-s fg-secondary'
          }
          htmlFor={fieldId}
        >
          <span>{label}</span>
          {!inset && field}
        </label>
        {inset && field}
        {helperText ? (
          <p id={helperId} className="text-xs fg-tertiary">
            {helperText}
          </p>
        ) : null}
        <div
          className={
            inset ? 'mt-4 flex justify-end gap-2' : 'flex justify-end gap-2'
          }
        >
          <Button
            size={inset ? undefined : 'sm'}
            variant={inset ? 'outline' : 'secondary'}
            onClick={close}
            disabled={busy}
            data-testid={cancelTestId}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size={inset ? undefined : 'sm'}
            variant={inset ? 'secondary' : 'primary'}
            disabled={busy}
            aria-busy={busy}
            data-testid={submitTestId}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </DialogModal>
  );
}
