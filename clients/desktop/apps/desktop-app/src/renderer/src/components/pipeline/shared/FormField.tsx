import type { JSX, ReactNode } from 'react';
import { FormField as SharedFormField } from '@canopy/ui-shared/components';

interface FormFieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

/**
 * The pipeline editor's labelled field: the shared `FormField` (label,
 * control, error, help text) for callers that render their own control and
 * name it with `htmlFor`.
 */
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  children,
}: FormFieldProps): JSX.Element {
  return (
    <SharedFormField
      id={htmlFor}
      label={label}
      description={hint}
      error={error}
    >
      {/* A plain block, so the shared field's flex column does not stretch a
          switch or button into a full-width target. */}
      {() => <div>{children}</div>}
    </SharedFormField>
  );
}
