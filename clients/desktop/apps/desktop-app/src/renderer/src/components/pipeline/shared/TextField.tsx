import { forwardRef, type JSX } from 'react';
import { TextInput, type TextInputProps } from '@canopy/ui-shared/components';

type TextFieldProps = Omit<TextInputProps, 'density'>;

/** The pipeline editor's single-line field: the shared 36px `TextInput`. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(props, ref): JSX.Element {
    return <TextInput ref={ref} {...props} />;
  },
);
