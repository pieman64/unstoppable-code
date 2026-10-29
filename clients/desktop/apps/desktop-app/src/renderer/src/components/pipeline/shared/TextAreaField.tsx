import type { JSX } from 'react';

type TextAreaFieldProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextAreaField(props: TextAreaFieldProps): JSX.Element {
  return (
    <textarea
      {...props}
      className={`w-full px-3 py-2 text-s bg-base border rounded-md
 fg-primary placeholder:fg-secondary font-mono
 focus:outline-none focus:ring-2 focus:ring-line-accent/50 focus:border-line-accent
 transition-colors resize-y min-h-20 ${props.className || ''}`}
    />
  );
}
