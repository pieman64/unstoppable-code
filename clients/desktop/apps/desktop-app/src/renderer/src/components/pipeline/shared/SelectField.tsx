import type { JSX } from 'react';

interface SelectFieldProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: { value: string; label: string }[];
  placeholder?: string;
}

export function SelectField({
  options,
  placeholder,
  ...props
}: SelectFieldProps): JSX.Element {
  return (
    <select
      {...props}
      className={`w-full px-3 py-2 text-s bg-base border rounded-md
 fg-primary
 focus:outline-none focus:ring-2 focus:ring-line-accent/50 focus:border-line-accent
 transition-colors ${props.className || ''}`}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
