import type { JSX } from 'react';

interface FormFieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}

export function FormField({
  label,
  htmlFor,
  hint,
  error,
  children,
}: FormFieldProps): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium fg-secondary ">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs fg-secondary">{hint}</p>}
      {error && <p className="text-xs fg-destructive">{error}</p>}
    </div>
  );
}
