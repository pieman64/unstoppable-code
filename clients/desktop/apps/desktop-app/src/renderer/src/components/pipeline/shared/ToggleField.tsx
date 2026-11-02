import type { JSX } from 'react';
import { ToggleSwitch } from '@canopy/ui-shared/components';

interface ToggleFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name: the setting the switch turns on and off. */
  label: string;
}

/** A workflow form's on/off field: the shared settings switch. */
export function ToggleField({
  checked,
  onChange,
  disabled,
  label,
}: ToggleFieldProps): JSX.Element {
  return (
    <ToggleSwitch
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      label={label}
    />
  );
}
