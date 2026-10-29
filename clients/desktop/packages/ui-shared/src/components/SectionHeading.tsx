import type { JSX, ReactNode } from 'react';
import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';

/** What the Customize section offers, under its heading on every host. */
export const CUSTOMIZE_SECTION_SUBTITLE =
  'Add and manage plugins, MCP servers, skills, workflows, collections, and agents.';

export interface SectionHeadingProps {
  readonly title: ReactNode;
  readonly subtitle: ReactNode;
  readonly className?: string;
  /** Preserve the host's existing title-to-subtitle spacing. */
  readonly compact?: boolean;
}

/**
 * A section's page title and its one-line subtitle. Hosts keep ownership of
 * the surrounding row, actions and spacing; this keeps the heading level,
 * typography shared while preserving each host's existing subtitle spacing.
 */
export function SectionHeading({
  title,
  subtitle,
  className,
  compact = false,
}: SectionHeadingProps): JSX.Element {
  return (
    <div
      className={`min-w-0 ${compact ? 'space-y-1' : 'space-y-2'}${className ? ` ${className}` : ''}`}
      data-testid="section-heading"
    >
      <h1 className="text-xl font-semibold fg-primary">{title}</h1>
      <p className="text-s fg-secondary">{subtitle}</p>
    </div>
  );
}

/** The Customize section's heading, shared by the desktop and web pages. */
export function CustomizeSectionHeading({
  className,
  compact,
}: {
  readonly className?: string;
  readonly compact?: boolean;
}): JSX.Element {
  return (
    <SectionHeading
      title={CUSTOMIZE_LABEL}
      subtitle={CUSTOMIZE_SECTION_SUBTITLE}
      className={className}
      compact={compact}
    />
  );
}
