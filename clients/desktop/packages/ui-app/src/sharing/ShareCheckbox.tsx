import type { JSX, ReactNode } from 'react';
import { ChoiceField } from '@canopy/ui-shared/components';

interface ShareCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  /** Test id for the row. */
  testId?: string;
  /** Test id for the `<input>` itself. */
  inputTestId?: string;
}

/**
 * The one checkbox row for share and install dialogs. Functional options
 * stack in the same dialog, so they share a single type size and control
 * geometry rather than restating classes per surface.
 * The whole row is the shared `ChoiceField` label, so a click on the text
 * toggles it, and a wrapped label keeps the mark beside its first line.
 */
export function ShareCheckbox({
  checked,
  onChange,
  children,
  disabled,
  testId,
  inputTestId,
}: ShareCheckboxProps): JSX.Element {
  return (
    <div data-testid={testId}>
      <ChoiceField
        label={children}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        data-testid={inputTestId}
      />
    </div>
  );
}
