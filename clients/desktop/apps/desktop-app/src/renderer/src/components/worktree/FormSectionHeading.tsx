import type { JSX, ReactNode } from 'react';

interface FormSectionHeadingProps {
  readonly title: ReactNode;
  /** Optional one-line explanation directly under the heading. */
  readonly subtitle?: ReactNode;
  /** Renders the title as the `<label>` of this control instead of a heading. */
  readonly htmlFor?: string;
}

/**
 * Section heading for the Add project create forms (CAN-3453): a real heading
 * (`text-s font-semibold fg-primary`) with an optional `text-xs fg-secondary`
 * subtitle, so "Start from", "Project name" and "Folder" read as headings
 * rather than body text. Shared by the Personal and organization Cowork forms
 * so both stay identical.
 */
export function FormSectionHeading({
  title,
  subtitle,
  htmlFor,
}: FormSectionHeadingProps): JSX.Element {
  const titleClassName = 'block text-s font-semibold fg-primary';
  return (
    <div className="mb-2">
      {htmlFor === undefined ? (
        <h3 className={titleClassName}>{title}</h3>
      ) : (
        <label htmlFor={htmlFor} className={titleClassName}>
          {title}
        </label>
      )}
      {subtitle !== undefined && (
        <p className="mt-0.5 text-xs fg-secondary">{subtitle}</p>
      )}
    </div>
  );
}
