import type { JSX, ReactNode } from 'react';

export interface PageHeaderProps {
  /** The page's name: the same words as its left-nav label. */
  title: ReactNode;
  /** One sentence saying what the page is for. */
  description: ReactNode;
  /**
   * `h1` unless the host already renders the page's `h1` (for example an
   * organization name above this header). Both levels look the same.
   */
  headingLevel?: 'h1' | 'h2';
  /** Page-level controls, right-aligned beside the title. */
  actions?: ReactNode;
  /**
   * Keep the actions slot at a button's height even when a page has no
   * actions (or before they resolve), so the header is the same box on every
   * sibling page. Settings pages set it; other surfaces leave it off and gain
   * no blank space.
   */
  reserveActions?: boolean;
  /** Placement only. The host owns width and vertical rhythm. */
  className?: string;
}

/**
 * The title and one-sentence description at the top of a settings page. The
 * left nav already says where the page sits, so this carries no breadcrumb and
 * no top padding.
 */
export function PageHeader({
  title,
  description,
  headingLevel = 'h1',
  actions,
  reserveActions = false,
  className,
}: PageHeaderProps): JSX.Element {
  const Heading = headingLevel;
  const showActions = actions !== undefined || reserveActions;
  return (
    <div
      className={`flex items-start justify-between gap-4${
        className ? ` ${className}` : ''
      }`}
      data-testid="page-header"
    >
      {/* The title column takes the remaining width and the description
          keeps a fixed measure, so it wraps the same with or without actions. */}
      <div className="min-w-0 flex-1 space-y-2">
        <Heading
          className="text-xl font-semibold fg-primary"
          data-testid="page-header-title"
        >
          {title}
        </Heading>
        <p
          className="max-w-prose text-s fg-secondary"
          data-testid="page-header-description"
        >
          {description}
        </p>
      </div>
      {showActions && (
        <div
          className={reserveActions ? 'min-h-8 shrink-0' : 'shrink-0'}
          data-testid="page-header-actions"
        >
          {actions}
        </div>
      )}
    </div>
  );
}
