import type { JSX } from 'react';

/** Full option text shared by composer questions and transcript questions. */
export function QuestionOptionText({
  label,
  description,
  descriptionStyle = 'standard',
}: {
  readonly label: string;
  readonly description?: string;
  readonly descriptionStyle?: 'standard' | 'caption';
}): JSX.Element {
  return (
    <>
      <span className="block whitespace-normal wrap-anywhere">{label}</span>
      {description && (
        <span
          className={`block whitespace-normal wrap-anywhere ${descriptionStyle === 'caption' ? 'text-xs fg-secondary' : 'fg-tertiary'}`}
        >
          {description}
        </span>
      )}
    </>
  );
}
