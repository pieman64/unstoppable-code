import type { JSX } from 'react';

type TextFieldProps = React.InputHTMLAttributes<HTMLInputElement>;

export function TextField(props: TextFieldProps): JSX.Element {
  return (
    <input
      {...props}
      className={`w-full px-3 py-2 text-s bg-base border rounded-md
 fg-primary placeholder:fg-secondary
 focus:outline-none focus:ring-2 focus:ring-line-accent/50 focus:border-line-accent
 transition-colors ${props.className || ''}`}
    />
  );
}
