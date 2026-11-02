import { createContext, useContext, type JSX, type ReactNode } from 'react';

const DialogFormFieldContext = createContext(false);

/**
 * True inside a `DialogFormField`. Settings dropdowns read it: in a dialog's
 * form field they fill the dialog's content width instead of the 144px or
 * 208px column of a Settings page row.
 */
export function useInDialogFormField(): boolean {
  return useContext(DialogFormFieldContext);
}

export interface DialogFormFieldProps {
  readonly label: ReactNode;
  /** Id of the control the label names. */
  readonly htmlFor?: string;
  readonly description?: ReactNode;
  readonly dataTestId?: string;
  readonly children: ReactNode;
}

/**
 * One field of a dialog's form: the label over a control that fills the
 * dialog's content width.
 */
export function DialogFormField({
  label,
  htmlFor,
  description,
  dataTestId,
  children,
}: DialogFormFieldProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" data-testid={dataTestId}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-xs font-medium fg-secondary">
          {label}
        </label>
      ) : (
        <span className="text-xs font-medium fg-secondary">{label}</span>
      )}
      <DialogFormFieldContext.Provider value>
        <div className="flex min-w-0">{children}</div>
      </DialogFormFieldContext.Provider>
      {description ? (
        <p className="text-xs text-pretty fg-tertiary">{description}</p>
      ) : null}
    </div>
  );
}
