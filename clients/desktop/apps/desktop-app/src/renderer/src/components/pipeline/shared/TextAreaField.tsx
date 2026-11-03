import type { JSX } from 'react';
import { TextArea, type TextAreaProps } from '@canopy/ui-shared/components';

type TextAreaFieldProps = Omit<TextAreaProps, 'mono'>;

/** The pipeline editor's multi-line field: the shared monospace `TextArea`. */
export function TextAreaField({
  rows = 3,
  ...props
}: TextAreaFieldProps): JSX.Element {
  return <TextArea mono rows={rows} {...props} />;
}
