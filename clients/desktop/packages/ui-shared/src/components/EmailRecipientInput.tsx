import { type JSX, useId, useState } from 'react';

/**
 * Upper bound accepted by the account identity and invite APIs. Longer input
 * is rejected before it reaches a host, which normalizes and validates again.
 */
export const EMAIL_RECIPIENT_MAX_LENGTH = 256;

/**
 * A deliberately permissive shape check: one `@`, a non-empty local part, and
 * a dotted domain with no whitespace. The server is the authority; this only
 * keeps obvious typos from becoming a request.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when `value` (trimmed) looks like a single email address. */
export function isEmailRecipientValid(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= EMAIL_RECIPIENT_MAX_LENGTH &&
    EMAIL_SHAPE.test(trimmed)
  );
}

export interface EmailRecipientInputProps {
  /** Visible label and the input's accessible name. */
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Called on Enter when the value is a valid address. */
  onSubmit?: () => void;
  placeholder?: string;
  /** Sentence between the label and the field describing what it is for. */
  description?: string;
  /** Helper sentence under the field. Replaced by the validation error. */
  helperText?: string;
  /**
   * Shown when the field holds something that is not an email address. Held
   * back while the person is still typing: it appears once focus leaves the
   * field (or Enter is pressed) with an invalid address, and clears on the
   * next edit.
   */
  invalidMessage?: string;
  disabled?: boolean;
  /** Test id for the input; the error gets `${dataTestId}-error`. */
  dataTestId?: string;
}

/**
 * A single email address field with inline validation, for share surfaces
 * that reach people by address rather than from a member list.
 * Display-only: the host owns the value and what happens on submit.
 */
export function EmailRecipientInput({
  label,
  value,
  onChange,
  onSubmit,
  placeholder = 'name@example.com',
  description,
  helperText,
  invalidMessage = 'Enter a valid email address.',
  disabled = false,
  dataTestId,
}: EmailRecipientInputProps): JSX.Element {
  const inputId = useId();
  const messageId = useId();
  const descriptionId = useId();
  // Set on blur or a refused Enter, cleared by the next edit. A half-typed
  // address is not a mistake yet, so the error never interrupts typing.
  const [validationRevealed, setValidationRevealed] = useState(false);
  const showInvalid =
    validationRevealed && value.trim() !== '' && !isEmailRecipientValid(value);
  const message = showInvalid ? invalidMessage : helperText;
  const hasDescription = description !== undefined && description !== '';
  const describedBy =
    [hasDescription ? descriptionId : null, message ? messageId : null]
      .filter((id): id is string => id !== null)
      .join(' ') || undefined;
  return (
    <div className="space-y-1.5 text-s">
      <label htmlFor={inputId} className="block font-medium fg-primary">
        {label}
      </label>
      {hasDescription && (
        <p
          id={descriptionId}
          className="text-xs fg-secondary"
          data-testid={dataTestId ? `${dataTestId}-description` : undefined}
        >
          {description}
        </p>
      )}
      <input
        id={inputId}
        type="email"
        inputMode="email"
        autoComplete="off"
        spellCheck={false}
        value={value}
        maxLength={EMAIL_RECIPIENT_MAX_LENGTH}
        onChange={(event) => {
          setValidationRevealed(false);
          onChange(event.target.value);
        }}
        onBlur={() => setValidationRevealed(true)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          if (!isEmailRecipientValid(value)) {
            setValidationRevealed(true);
            if (onSubmit) event.preventDefault();
            return;
          }
          if (!onSubmit) return;
          event.preventDefault();
          onSubmit();
        }}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={showInvalid}
        aria-describedby={describedBy}
        data-testid={dataTestId}
        className="focus-ring w-full rounded-lg bg-base px-3 py-2 text-s fg-primary inset-ring-[length:var(--border-hairline)] inset-ring-line-base disabled:opacity-50"
      />
      {message && (
        <p
          id={messageId}
          className={`text-xs ${showInvalid ? 'fg-destructive' : 'fg-secondary'}`}
          role={showInvalid ? 'alert' : undefined}
          data-testid={
            showInvalid && dataTestId ? `${dataTestId}-error` : undefined
          }
        >
          {message}
        </p>
      )}
    </div>
  );
}
