import type { JSX } from 'react';
import { Select } from '@canopy/ui-shared/components';

/** What `SelectField` reports when the person picks an option. */
export interface SelectFieldChange {
  readonly target: { readonly value: string };
}

interface SelectFieldProps {
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (event: SelectFieldChange) => void;
  /** A first option with the empty value, so the field can be unset. */
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'data-testid'?: string;
  /** Placement only (width, margins, flex). */
  className?: string;
}

/**
 * The pipeline editor's dropdown: the shared 36px `Select`, beside the
 * editor's 36px text fields.
 */
export function SelectField({
  options,
  value,
  onChange,
  placeholder,
  disabled,
  id,
  'aria-label': ariaLabel,
  'data-testid': dataTestId,
  className,
}: SelectFieldProps): JSX.Element {
  const items =
    placeholder === undefined
      ? options
      : [{ value: '', label: placeholder }, ...options];
  const select = (
    <Select
      id={id}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      options={items}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onValueChange={(next) => onChange({ target: { value: next } })}
    />
  );
  return className ? <div className={className}>{select}</div> : select;
}
