import type { JSX, ReactNode } from 'react';

export interface PluginDetailSectionHeadingProps {
  as?: 'h3' | 'span';
  /** Lets a section name itself by this heading (`aria-labelledby`). */
  id?: string;
  children: ReactNode;
}

export function PluginDetailSectionHeading({
  as: Element = 'h3',
  id,
  children,
}: PluginDetailSectionHeadingProps): JSX.Element {
  return (
    <Element
      id={id}
      className="text-s font-semibold fg-primary"
      data-testid="plugin-detail-section-heading"
    >
      {children}
    </Element>
  );
}
