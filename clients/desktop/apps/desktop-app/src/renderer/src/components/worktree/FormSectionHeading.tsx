import type { JSX, ReactNode } from 'react';

interface FormSectionHeadingProps {
  readonly title: ReactNode;
  /** Optional one-line explanation directly under the heading. */
  readonly subtitle?: ReactNode;
  /**
   * Id for the heading, so the control it names can point at it with
   * `aria-labelledby`.
   */
  readonly id?: string;
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
  id,
}: FormSectionHeadingProps): JSX.Element {
  return (
    <div className="mb-2">
      <h3 id={id} className="block text-s font-semibold fg-primary">
        {title}
      </h3>
      {subtitle !== undefined && (
        <p className="mt-0.5 text-xs fg-secondary">{subtitle}</p>
      )}
    </div>
  );
}
