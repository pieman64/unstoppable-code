import type { JSX } from 'react';

interface ToggleFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}

export function ToggleField({
  checked,
  onChange,
  disabled,
  label,
}: ToggleFieldProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full
        transition-colors duration-200 ease-in-out focus-ring
        ${checked ? 'bg-accent' : 'bg-secondary'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white
          shadow-sm transform transition-transform duration-200 ease-in-out mt-0.5
          ${checked ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`}
      />
    </button>
  );
}
