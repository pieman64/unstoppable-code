'use client';

import { useId, type JSX, type ReactNode } from 'react';
import { FieldError } from './Field';

/**
 * The label over a form field: 13px, weight 450, primary ink (design
 * decision, 2026-10-30). Once the shared `Text variant="label"` lands, this
 * should point at it.
 */
export const FORM_FIELD_LABEL_CLASS = 'text-xs font-medium fg-primary';

/** The help text under a form field: 13px, tertiary ink. */
export const FORM_FIELD_DESCRIPTION_CLASS = 'text-xs text-pretty fg-tertiary';

/**
 * What `FormField` hands its control: spread it onto `TextInput`,
 * `TextArea`, or `Select` so the label, help text, and error reach assistive
 * technology without wiring ids by hand.
 */
export interface FormFieldControlProps {
  readonly id: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
}

export interface FormFieldProps {
  readonly label: ReactNode;
  /** Id for the control; one is generated when omitted. */
  readonly id?: string;
  /** Help text under the field. */
  readonly description?: ReactNode;
  /**
   * The validation message, shown in `FieldError` directly under the control.
   * Pass it only after the person submits, and clear it when they edit the
   * field (docs/design/forms.md).
   */
  readonly error?: ReactNode;
  readonly dataTestId?: string;
  /** Renders the control with the ids and state the field supplies. */
  readonly children: (control: FormFieldControlProps) => ReactNode;
}

function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

/**
 * One labelled form field: the label, the control, its error, and its help
 * text, stacked 6px apart in that order. The field wires the label to the
 * control and points the control at the error and help text, so a form never
 * hand-writes a `<label>` or `aria-describedby`.
 *
 * ```tsx
 * <FormField label="Name" error={submitted ? nameError : null}>
 *   {(control) => <TextInput {...control} value={name} onChange={…} />}
 * </FormField>
 * ```
 *
 * In a dialog use `DialogFormField`, which shares this label and help text;
 * in Settings use `SettingsRowsRow`.
 */
export function FormField({
  label,
  id,
  description,
  error,
  dataTestId,
  children,
}: FormFieldProps): JSX.Element {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const errorId = `${controlId}-error`;
  const descriptionId = `${controlId}-description`;
  const showError = hasContent(error);
  const showDescription = hasContent(description);
  const describedBy =
    [showError ? errorId : null, showDescription ? descriptionId : null]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1.5" data-testid={dataTestId}>
      <label htmlFor={controlId} className={FORM_FIELD_LABEL_CLASS}>
        {label}
      </label>
      <div className="flex min-w-0 flex-col">
        {children({
          id: controlId,
          'aria-describedby': describedBy,
          'aria-invalid': showError ? true : undefined,
        })}
      </div>
      {showError ? (
        <FieldError
          id={errorId}
          data-testid={dataTestId ? `${dataTestId}-error` : undefined}
        >
          {error}
        </FieldError>
      ) : null}
      {showDescription ? (
        <p id={descriptionId} className={FORM_FIELD_DESCRIPTION_CLASS}>
          {description}
        </p>
      ) : null}
    </div>
  );
}
