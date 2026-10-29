import type { JSX, ReactNode } from 'react';

interface ShareCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  /** Test id for the row's `<label>`. */
  testId?: string;
  /** Test id for the `<input>` itself. */
  inputTestId?: string;
}

/**
 * The one checkbox row for share and install dialogs. Functional options
 * stack in the same dialog, so they share a single type size and control
 * geometry rather than restating classes per surface.
 * The input is top-aligned (and never shrinks) so a wrapped label keeps a
 * full-size box beside its first line.
 */
export function ShareCheckbox({
  checked,
  onChange,
  children,
  disabled = false,
  testId,
  inputTestId,
}: ShareCheckboxProps): JSX.Element {
  return (
    <label
      className="flex items-start gap-2 text-s fg-primary"
      data-testid={testId}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        data-testid={inputTestId}
        className="mt-0.5 h-4 w-4 shrink-0 rounded"
      />
      <span>{children}</span>
    </label>
  );
}
