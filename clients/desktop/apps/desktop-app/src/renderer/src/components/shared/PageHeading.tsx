import type { JSX, ReactNode } from 'react';
import { SectionHeading } from '@canopy/ui-shared/components';

interface PageHeadingFrameProps {
  actions?: ReactNode;
  className?: string;
}

/**
 * Either a title and subtitle, or a ready-made shared heading such as
 * `CustomizeSectionHeading` that the web mounts too.
 */
export type PageHeadingProps = PageHeadingFrameProps &
  (
    | { title: ReactNode; subtitle: ReactNode; heading?: never }
    | { heading: ReactNode; title?: never; subtitle?: never }
  );

/**
 * Shared visual contract for top-level page titles. Page shells keep ownership
 * of width and scrolling; this keeps typography, rhythm, and actions aligned.
 */
export function PageHeading(props: PageHeadingProps): JSX.Element {
  const { actions, className } = props;
  return (
    <div
      className={`flex items-start justify-between gap-4 pt-12 ${className ?? ''}`}
      data-testid="page-heading"
    >
      {props.heading ?? (
        <SectionHeading title={props.title} subtitle={props.subtitle} />
      )}
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}
